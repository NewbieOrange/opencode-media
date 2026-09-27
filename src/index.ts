/**
 * opencode-media — deliver audio/video (and other non-image binaries) to
 * media-capable models from OpenCode V2.
 *
 * OpenCode's attachment pipeline only forwards text and PNG/JPEG/GIF/WebP to
 * the model, and the OpenAI-chat protocol layer rejects non-image MediaParts.
 * This plugin therefore captures media early (prompt attachments, `read` tool),
 * records the reference in the message's own metadata WITHOUT touching the
 * message text (so no UI shows any marker), and injects real provider content
 * parts at the last possible moment — the `http.request` hook — by matching
 * the message text against the recorded hashes.
 *
 *   @-attached media ──┐                            ┌── http.request hook:
 *                       ├─▶ message metadata[text hash] ──┤   text match → input_audio /
 *   read() on media  ───┘    (message text clean)   └──   video_url content parts
 *
 * The messages themselves are the durable record: user messages carry the refs
 * in their admission metadata, tool results in their tool-state metadata. The
 * plugin owns no storage; a per-session map is rebuilt from the session's own
 * messages on first touch, so injection survives service restarts.
 *
 * Explicit <opencode-media .../> markers in message text are still honored
 * (handy for tests and manual use) but are no longer generated here.
 */
import { Plugin } from "@opencode/plugin"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  formatBytes,
  hasMarker,
  isNativeImage,
  markerNote,
  shouldInject,
  sniffMime,
  splitSegments,
  toProviderParts,
  type CapabilityGate,
  type MediaRef,
  type PartOptions,
} from "./media"

interface Options {
  /** Max raw bytes per media item (default 25 MB). */
  maxBytes?: number
  /** Max media items injected per model request (default 16). */
  maxPerRequest?: number
  /** Audio part shape: "input_audio" (OpenAI standard, default) or "audio_url". */
  audio?: "input_audio" | "audio_url"
  /** Video part shape: "video_url" (data URL). */
  video?: "video_url"
  /** Custom JSON part templates; placeholders {data} {dataurl} {mime} {format} {name}. */
  audioTemplate?: string
  videoTemplate?: string
  /**
   * Capability gating against the model config's capabilities.input:
   * "strict" (default) requires the exact modality entry, "auto" blocks only
   * confidently text-only models, "off" always injects.
   */
  capabilityGate?: CapabilityGate
  /** Log hook activity to /tmp/opencode/media-plugin.log. */
  debug?: boolean
}

const PLUGIN = "[opencode-media]"
const sha = (text: string) => createHash("sha256").update(text).digest("hex")

export default Plugin.define({
  id: "opencode-media",
  async setup(ctx) {
    const opts = (ctx.options ?? {}) as Options
    const maxBytes = opts.maxBytes ?? 25 * 1024 * 1024
    const maxPerRequest = opts.maxPerRequest ?? 16
    const partOpts: PartOptions = {
      audio: opts.audio ?? "input_audio",
      video: opts.video ?? "video_url",
      audioTemplate: opts.audioTemplate,
      videoTemplate: opts.videoTemplate,
    }
    const capabilityGate: CapabilityGate = opts.capabilityGate ?? "strict"

    /** Resolve capabilities.input for the request's model (cached briefly). */
    const capsCache = new Map<string, { at: number; caps: readonly string[] | undefined }>()
    async function inputCaps(providerID: string, modelID: string): Promise<readonly string[] | undefined> {
      const key = `${providerID}/${modelID}`
      const hit = capsCache.get(key)
      if (hit && Date.now() - hit.at < 60_000) return hit.caps
      let caps: readonly string[] | undefined
      try {
        const listed = await ctx.model.list()
        const model = listed.data.find((m) => m.providerID === providerID && m.id === modelID)
        const input = model?.capabilities?.input
        caps = Array.isArray(input) ? input.map(String) : undefined
      } catch {
        caps = undefined
      }
      capsCache.set(key, { at: Date.now(), caps })
      return caps
    }
    const dbg = (...args: unknown[]) => {
      if (!opts.debug) return
      try {
        fs.appendFileSync(
          "/tmp/opencode/media-plugin.log",
          `${new Date().toISOString()} ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`,
        )
      } catch {}
    }
    dbg("setup called", JSON.stringify(opts))

    // ------------------------------------------------------------------
    // Media resolution (with a small mtime-keyed cache)
    // ------------------------------------------------------------------

    const cache = new Map<string, string>()
    const cacheSet = (key: string, b64: string) => {
      if (cache.size >= 4) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      cache.set(key, b64)
    }

    /** Build a MediaRef from a file:/data:/absolute URI by sniffing its bytes. */
    function refFromUri(uri: string, name?: string): MediaRef | undefined {
      try {
        if (uri.startsWith("data:")) {
          const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(uri)
          if (!m || !m[2]) return undefined
          const head = Buffer.from(m[3].slice(0, 128), "base64")
          const sniffed = sniffMime(new Uint8Array(head))
          if (!sniffed || isNativeImage(sniffed)) return undefined
          return { uri, mime: sniffed, name, bytes: Math.floor((m[3].length * 3) / 4) }
        }
        let filePath: string | undefined
        if (uri.startsWith("file:")) filePath = fileURLToPath(uri)
        else if (path.isAbsolute(uri)) filePath = uri
        if (!filePath) return undefined
        const stat = fs.statSync(filePath)
        if (!stat.isFile()) return undefined
        const fd = fs.openSync(filePath, "r")
        const head = Buffer.alloc(64)
        const n = fs.readSync(fd, head, 0, 64, 0)
        fs.closeSync(fd)
        const sniffed = sniffMime(new Uint8Array(head.subarray(0, n)))
        if (!sniffed || isNativeImage(sniffed)) return undefined
        return {
          uri: uri.startsWith("file:") ? uri : pathToFileURL(filePath).href,
          mime: sniffed,
          name: name ?? path.basename(filePath),
          bytes: stat.size,
        }
      } catch {
        return undefined
      }
    }

    /** Load a media item as base64, enforcing the size limit. */
    function loadBase64(ref: MediaRef): { b64: string } | { error: string } {
      try {
        if (ref.uri.startsWith("data:")) {
          const m = /^data:[^,]*,(.*)$/s.exec(ref.uri)
          if (!m) return { error: "unparseable data URL" }
          return { b64: m[1] }
        }
        const filePath = ref.uri.startsWith("file:") ? fileURLToPath(ref.uri) : ref.uri
        const stat = fs.statSync(filePath)
        if (stat.size > maxBytes) return { error: `too large (${formatBytes(stat.size)} > ${formatBytes(maxBytes)})` }
        const key = `${filePath}|${stat.mtimeMs}`
        const hit = cache.get(key)
        if (hit) return { b64: hit }
        const b64 = fs.readFileSync(filePath).toString("base64")
        cacheSet(key, b64)
        return { b64 }
      } catch (err) {
        return { error: `unreadable (${err instanceof Error ? err.message : String(err)})` }
      }
    }

    /** Turn one MediaRef into provider content parts (or an explanatory text part). */
    function mediaParts(ref: MediaRef, budget: { left: number }, caps: readonly string[] | undefined): unknown[] {
      if (!shouldInject(caps, ref.mime, capabilityGate)) {
        dbg("skipped by capability gate", ref.mime, JSON.stringify(caps))
        return [{ type: "text", text: `${markerNote(ref)} — not delivered: model config declares no ${ref.mime.startsWith("audio") ? "audio" : "video"} input` }]
      }
      if (budget.left <= 0) {
        return [{ type: "text", text: `${PLUGIN} media budget exhausted for this request (${markerNote(ref)})` }]
      }
      const loaded = loadBase64(ref)
      if ("error" in loaded) {
        return [{ type: "text", text: `${PLUGIN} could not attach media (${markerNote(ref)}): ${loaded.error}` }]
      }
      const injected = toProviderParts(ref, loaded.b64, partOpts)
      if (injected.length === 0) {
        return [{ type: "text", text: markerNote(ref) }]
      }
      budget.left--
      dbg("injected", ref.mime, ref.name ?? ref.uri, formatBytes(ref.bytes ?? 0))
      return injected
    }

    // ------------------------------------------------------------------
    // The invisible seam: text hash → media refs
    //   m/<hash> — user messages (prompt attachments)
    //   r/<hash> — read tool results (same file → same note)
    //
    // No plugin-owned storage: the durable record rides on the messages
    // themselves (user message metadata / tool-state metadata), and this map
    // is rebuilt from a session's own messages on first touch — so injection
    // survives service restarts without keeping state anywhere else.
    // ------------------------------------------------------------------

    const META_KEY = "opencode-media"
    type RefMap = Map<string, MediaRef[]>
    const seams = new Map<string, { map: RefMap; ready: Promise<void> }>()

    /** Normalize a metadata value into refs (tolerates a single ref). */
    function refsFromMeta(value: unknown): MediaRef[] {
      const out: MediaRef[] = []
      const take = (v: unknown) => {
        const ref = v as Partial<MediaRef> | null
        if (ref && typeof ref === "object" && typeof ref.uri === "string" && typeof ref.mime === "string")
          out.push({ uri: ref.uri, mime: ref.mime, name: ref.name, bytes: ref.bytes })
      }
      if (Array.isArray(value)) for (const v of value) take(v)
      else take(value)
      return out
    }

    /** Merge refs into one map key, deduped by URI. */
    function addRefs(map: RefMap, key: string, refs: readonly MediaRef[]): void {
      if (refs.length === 0) return
      const list = map.get(key) ?? []
      for (const ref of refs) if (!list.some((r) => r.uri === ref.uri)) list.push(ref)
      map.set(key, list)
    }

    /** Rebuild one session's map from its messages' own metadata. */
    async function hydrate(sessionID: string, map: RefMap): Promise<void> {
      try {
        for (const message of await ctx.session.context({ sessionID })) {
          if (message.type === "user") {
            addRefs(map, `m/${sha(message.text)}`, refsFromMeta(message.metadata?.[META_KEY]))
            continue
          }
          if (message.type !== "assistant") continue
          for (const part of message.content) {
            if (part.type !== "tool" || part.state.status !== "completed") continue
            const refs = refsFromMeta(part.state.metadata?.[META_KEY])
            for (const item of part.state.content ?? []) {
              if (item.type === "text") addRefs(map, `r/${sha(item.text)}`, refs)
            }
          }
        }
        dbg("seam map hydrated for", sessionID, `${map.size} keys`)
      } catch (err) {
        dbg("session context read failed", sessionID, String(err))
      }
    }

    /** The session's seam map, hydrated from its own messages on first touch. */
    async function sessionMap(sessionID: string): Promise<RefMap> {
      let seam = seams.get(sessionID)
      if (!seam) {
        const map: RefMap = new Map()
        seam = { map, ready: Promise.resolve() }
        seams.set(sessionID, seam)
        seam.ready = hydrate(sessionID, map)
      }
      await seam.ready
      return seam.map
    }

    async function record(sessionID: string, key: string, ref: MediaRef): Promise<void> {
      addRefs(await sessionMap(sessionID), key, [ref])
    }

    async function lookup(sessionID: string, text: string): Promise<MediaRef[] | undefined> {
      const map = await sessionMap(sessionID)
      const hash = sha(text)
      return map.get(`m/${hash}`) ?? map.get(`r/${hash}`)
    }

    /**
     * Expand one text run into content parts. Handles legacy explicit markers
     * and hash-registered media; returns undefined when nothing applies.
     */
    async function expand(
      text: string,
      budget: { left: number },
      sessionID: string,
      caps: readonly string[] | undefined,
    ): Promise<unknown[] | undefined> {
      if (hasMarker(text)) {
        const out: unknown[] = []
        for (const seg of splitSegments(text)) {
          if (seg.kind === "text") {
            if (seg.text.trim()) out.push({ type: "text", text: seg.text })
            continue
          }
          out.push(...mediaParts(seg.marker.ref, budget, caps))
        }
        return out.length ? out : [{ type: "text", text }]
      }
      const refs = await lookup(sessionID, text)
      if (!refs) return undefined
      return [{ type: "text", text }, ...refs.flatMap((ref) => mediaParts(ref, budget, caps))]
    }

    // ------------------------------------------------------------------
    // 1. Capture @-attached media before attachment resolution drops it
    // ------------------------------------------------------------------

    await ctx.session.hook("prompt", async (event) => {
      const files = event.prompt.files
      if (!files || files.length === 0) return
      const keep: typeof files = []
      const captured: MediaRef[] = []
      for (const f of files) {
        const ref = refFromUri(f.uri, f.name)
        if (!ref || isNativeImage(ref.mime)) {
          keep.push(f)
          continue
        }
        captured.push(ref)
        dbg("captured attachment", ref.mime, ref.name ?? ref.uri)
      }
      if (captured.length === 0) return
      // Leave the message text untouched (no visible markers, mention offsets
      // stay valid); the media refs ride on the message's own admission
      // metadata (persisted as the user message's metadata).
      event.prompt.files = keep
      const key = `m/${sha(event.prompt.text)}`
      for (const ref of captured) await record(event.sessionID, key, ref)
      const metadata = (event.metadata ?? {}) as Record<string, unknown>
      const riding = refsFromMeta(metadata[META_KEY])
      for (const ref of captured) if (!riding.some((r) => r.uri === ref.uri)) riding.push(ref)
      metadata[META_KEY] = riding
      event.metadata = metadata
    })

    // ------------------------------------------------------------------
    // 1b. Advertise media support in the read tool's description
    // ------------------------------------------------------------------

    await ctx.session.hook("context", async (event) => {
      // Per request, so the wording matches what the active model can
      // really perceive.
      const caps = await inputCaps(event.model.providerID, event.model.id)
      const readTool = event.tools.read
      if (readTool) {
        const audioOk = shouldInject(caps, "audio/wav", capabilityGate)
        const videoOk = shouldInject(caps, "video/mp4", capabilityGate)
        const kinds = [audioOk ? "audio" : undefined, videoOk ? "video" : undefined].filter(Boolean).join(" and ")
        if (kinds) {
          readTool.description = `${readTool.description}\nAlso supports ${kinds} files.`
          dbg("read description extended for", event.model.id, kinds)
        }
      }
    })

    // ------------------------------------------------------------------
    // 2. Make the `read` tool media-aware by wrapping its execute
    // ------------------------------------------------------------------

    await ctx.tool.transform((editor) => {
      const read = editor.get("read")
      dbg("tool transform", "read found:", String(!!read))
      if (!read) {
        console.warn(PLUGIN, "built-in read tool not found; read() will not handle media")
        return
      }
      const original = read.execute.bind(read)
      editor.update("read", (tool) => {
        tool.execute = async (input, toolCtx) => {
          const candidate = input as { path?: unknown; filePath?: unknown } | undefined
          const p = typeof candidate?.path === "string" ? candidate.path : typeof candidate?.filePath === "string" ? candidate.filePath : undefined
          dbg("read called with", JSON.stringify(input).slice(0, 140))
          const ref = p ? refFromUri(p) : undefined
          if (ref && !isNativeImage(ref.mime)) {
            dbg("read intercepted", ref.mime, ref.name ?? ref.uri)
            // A clean, human-readable note — no marker tags in the UI. The ref
            // is recorded against the note text for request-time injection, and
            // the result mirrors a text-file output to satisfy read's schema.
            const note = markerNote(ref)
            await record(toolCtx.sessionID, `r/${sha(note)}`, ref)
            return {
              output: {
                type: "file",
                uri: ref.uri,
                name: ref.name ?? "media",
                content: note,
                encoding: "utf8",
                mime: "text/plain",
              },
              content: note,
              // The tool state persists this metadata (but not the file
              // output), so the ref rides here for request-time injection.
              metadata: { [META_KEY]: [ref] },
            }
          }
          const result = await original(input, toolCtx)
          return result
        }
      })
    })

    // ------------------------------------------------------------------
    // 3. Inject native media parts into the outgoing provider request
    // ------------------------------------------------------------------

    await ctx.session.hook("http.request", async (event) => {
      const req = event.request
      dbg("http.request hook", event.kind, req.method, req.headers.get("content-type") ?? "")
      if (req.method !== "POST") return
      const ct = req.headers.get("content-type") ?? ""
      if (!ct.includes("json")) return
      let body: {
        messages?: Array<{ role?: string; content?: unknown }>
      }
      try {
        body = await req.clone().json()
      } catch {
        return
      }
      if (!Array.isArray(body.messages)) return

      const budget = { left: maxPerRequest }
      const caps = await inputCaps(event.model.providerID, event.model.id)
      let changed = false

      for (const msg of body.messages) {
        if (msg?.role !== "user" && msg?.role !== "tool") continue
        const content = msg.content
        if (typeof content === "string") {
          const expanded = await expand(content, budget, event.sessionID, caps)
          if (expanded) {
            msg.content = expanded
            changed = true
          }
        } else if (Array.isArray(content)) {
          let matched = false
          for (let i = 0; i < content.length; i++) {
            const part = content[i] as { type?: string; text?: string } | string
            const text = typeof part === "string" ? part : part?.type === "text" ? part.text : undefined
            if (!text) continue
            const expanded = await expand(text, budget, event.sessionID, caps)
            if (!expanded) continue
            content.splice(i, 1, ...expanded)
            changed = true
            matched = true
            i += expanded.length - 1
          }
          // Text may be split across parts; fall back to joined matching and
          // append the media parts at the end without touching any text.
          if (!matched) {
            const texts = content
              .map((p) => (typeof p === "object" && p?.type === "text" ? (p.text as string) : undefined))
              .filter((t): t is string => typeof t === "string")
            for (const joiner of ["\n\n", "\n"]) {
              if (texts.length < 2) break
              const refs = await lookup(event.sessionID, texts.join(joiner))
              if (refs) {
                content.push(...refs.flatMap((ref) => mediaParts(ref, budget, caps)))
                changed = true
                break
              }
            }
          }
        }
      }
      if (!changed) return

      dbg("rewriting body for", event.kind)
      try {
        const headers = new Headers(req.headers)
        headers.delete("content-length")
        event.request = new Request(req, {
          method: req.method,
          headers,
          body: JSON.stringify(body),
        })
        dbg("request replaced OK")
      } catch (err) {
        dbg("request replacement FAILED", String(err))
      }
    })

    console.log(PLUGIN, "loaded (audio:", partOpts.audio, "video:", partOpts.video, ")")
  },
})
