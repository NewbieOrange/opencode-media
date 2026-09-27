/**
 * opencode-media — deliver audio/video (and other non-image binaries) to
 * media-capable models from OpenCode V2.
 *
 * OpenCode's attachment pipeline only forwards text and PNG/JPEG/GIF/WebP to
 * the model, and the OpenAI-chat protocol layer rejects non-image MediaParts.
 * This plugin therefore captures media early (prompt attachments, `read` tool),
 * SNAPSHOTS ITS BYTES (OpenCode's image-attachment semantics: the message
 * stores what it admitted, so changed files never rewrite history), records
 * the reference in the message's own metadata WITHOUT touching the
 * message text (so no UI shows any marker), and injects real provider content
 * parts at the last possible moment — the `http.request` hook — by matching
 * the message text against the recorded hashes (occurrence-aligned per
 * message, so shared texts never cross-attach media).
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
  pickGroup,
  pushGroup,
  refsFromMetaValue,
  shouldInject,
  sniffMime,
  splitSegments,
  toProviderParts,
  type CapabilityGate,
  type MediaRef,
  type PartOptions,
  type RefGroups,
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

    /**
     * Load a media item as base64, enforcing the size limit. Snapshotted refs
     * (normal case) return their stored bytes without touching the disk; refs
     * recorded by older versions fall back to reading the file.
     */
    function loadBase64(ref: MediaRef): { b64: string } | { error: string } {
      if (ref.data) return { b64: ref.data }
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

    /**
     * Snapshot a ref's bytes at capture time — OpenCode's image semantics: the
     * message stores the bytes it admitted, so changed or deleted source files
     * never alter what the model sees. Oversized or unreadable refs stay
     * data-less and fall back to the request-time explanatory note.
     */
    function snapshot(ref: MediaRef): MediaRef {
      const loaded = loadBase64(ref)
      return "error" in loaded ? ref : { ...ref, data: loaded.b64 }
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
    //
    // Each media-bearing message contributes its own occurrence group per
    // key, keeping injection message-scoped (like OpenCode's image
    // attachments, which live inside their message) even when two messages
    // share the same text. Hydration never observes the message currently
    // being recorded (admission/tool state persist after the hook returns),
    // so a message cannot contribute two groups.
    // ------------------------------------------------------------------

    const META_KEY = "opencode-media"
    type RefMap = Map<string, RefGroups>
    const seams = new Map<string, { map: RefMap; ready: Promise<void> }>()

    /** Append one message's refs as a new occurrence group under `key`. */
    function addGroup(map: RefMap, key: string, refs: readonly MediaRef[]): void {
      if (refs.length === 0) return
      const groups = map.get(key) ?? []
      map.set(key, groups)
      pushGroup(groups, refs)
    }

    /** Rebuild one session's map from its messages' own metadata. */
    async function hydrate(sessionID: string, map: RefMap): Promise<void> {
      try {
        for (const message of await ctx.session.context({ sessionID })) {
          if (message.type === "user") {
            addGroup(map, `m/${sha(message.text)}`, refsFromMetaValue(message.metadata?.[META_KEY]))
            continue
          }
          if (message.type !== "assistant") continue
          for (const part of message.content) {
            if (part.type !== "tool" || part.state.status !== "completed") continue
            const refs = refsFromMetaValue(part.state.metadata?.[META_KEY])
            if (refs.length === 0) continue
            // One group per (tool call, key): identical text items in one
            // result must not split the call's media across groups.
            const keys = new Set<string>()
            for (const item of part.state.content ?? []) {
              if (item.type === "text") keys.add(`r/${sha(item.text)}`)
            }
            for (const key of keys) addGroup(map, key, refs)
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

    async function record(sessionID: string, key: string, refs: readonly MediaRef[]): Promise<void> {
      addGroup(await sessionMap(sessionID), key, refs)
    }

    /** The seam key a text run resolves to (`m/` preferred over `r/`), if any. */
    function keyFor(map: RefMap, text: string): string | undefined {
      const hash = sha(text)
      if (map.has(`m/${hash}`)) return `m/${hash}`
      if (map.has(`r/${hash}`)) return `r/${hash}`
      return undefined
    }

    /**
     * Expand a legacy explicit-marker text run into content parts (hash-
     * registered media is resolved per message elsewhere); the marker tags
     * themselves are dropped.
     */
    function markerParts(text: string, budget: { left: number }, caps: readonly string[] | undefined): unknown[] {
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
        // Snapshot the bytes now: the message stores what it admitted
        // (OpenCode's image-attachment semantics), not a disk dependency.
        captured.push(snapshot(ref))
        dbg("captured attachment", ref.mime, ref.name ?? ref.uri)
      }
      if (captured.length === 0) return
      // Leave the message text untouched (no visible markers, mention offsets
      // stay valid); the media refs ride on the message's own admission
      // metadata (persisted as the user message's metadata).
      event.prompt.files = keep
      const key = `m/${sha(event.prompt.text)}`
      await record(event.sessionID, key, captured)
      const metadata = (event.metadata ?? {}) as Record<string, unknown>
      const riding = refsFromMetaValue(metadata[META_KEY])
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
            const snap = snapshot(ref)
            await record(toolCtx.sessionID, `r/${sha(note)}`, [snap])
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
              // output), so the snapshotted ref rides here for request-time
              // injection.
              metadata: { [META_KEY]: [snap] },
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
      const map = await sessionMap(event.sessionID)

      // Phase 1: collect every text slot that needs expansion (legacy markers
      // or seam-registered media) WITHOUT touching the body, so slots sharing
      // a seam key can be occurrence-counted before any of them resolves.
      interface Slot {
        text: string
        /** Seam key, absent for legacy marker texts (which carry their refs). */
        key?: string
        /** Keep the slot's text alongside the media (joined fallback: media only). */
        keepText: boolean
        apply: (parts: unknown[]) => void
      }
      const slots: Slot[] = []
      const expandable = (text: string) => hasMarker(text) || keyFor(map, text) !== undefined

      for (const msg of body.messages) {
        if (msg?.role !== "user" && msg?.role !== "tool") continue
        const content = msg.content
        if (typeof content === "string") {
          if (!expandable(content)) continue
          slots.push({
            text: content,
            key: hasMarker(content) ? undefined : keyFor(map, content),
            keepText: true,
            apply: (parts) => {
              msg.content = parts
            },
          })
          continue
        }
        if (!Array.isArray(content)) continue
        const partSlots: Array<Slot & { index: number }> = []
        for (let i = 0; i < content.length; i++) {
          const part = content[i] as { type?: string; text?: string } | string
          const text = typeof part === "string" ? part : part?.type === "text" ? part.text : undefined
          if (!text || !expandable(text)) continue
          const index = i
          partSlots.push({
            text,
            index,
            key: hasMarker(text) ? undefined : keyFor(map, text),
            keepText: true,
            apply: (parts) => {
              content.splice(index, 1, ...parts)
            },
          })
        }
        if (partSlots.length > 0) {
          slots.push(...partSlots)
          continue
        }
        // Text may be split across parts; fall back to joined matching and
        // append the media parts at the end without touching any text.
        const texts = content
          .map((p) => (typeof p === "object" && p?.type === "text" ? (p.text as string) : undefined))
          .filter((t): t is string => typeof t === "string")
        if (texts.length < 2) continue
        for (const joiner of ["\n\n", "\n"]) {
          const joined = texts.join(joiner)
          const key = keyFor(map, joined)
          if (!key) continue
          slots.push({
            text: joined,
            key,
            keepText: false,
            apply: (parts) => {
              content.push(...parts)
            },
          })
          break
        }
      }
      if (slots.length === 0) return

      // Phase 2: resolve each slot against ITS MESSAGE's occurrence group
      // (suffix-aligned — context truncation drops the oldest messages first),
      // consuming the media budget in conversation order. This keeps a shared
      // text hash from attaching one message's media to another message.
      const occurrences = new Map<string, number>()
      for (const slot of slots) if (slot.key) occurrences.set(slot.key, (occurrences.get(slot.key) ?? 0) + 1)
      const seen = new Map<string, number>()
      const resolved: Array<{ slot: Slot; parts: unknown[] }> = []
      for (const slot of slots) {
        let parts: unknown[]
        if (!slot.key) {
          parts = markerParts(slot.text, budget, caps)
        } else {
          const total = occurrences.get(slot.key) ?? 1
          const index = seen.get(slot.key) ?? 0
          seen.set(slot.key, index + 1)
          const refs = pickGroup(map.get(slot.key) ?? [], index, total) ?? []
          parts = refs.flatMap((ref) => mediaParts(ref, budget, caps))
          if (slot.keepText) parts = [{ type: "text", text: slot.text }, ...parts]
          else if (parts.length === 0) continue
        }
        resolved.push({ slot, parts })
      }
      if (resolved.length === 0) return

      dbg("rewriting body for", event.kind)
      try {
        // Apply back-to-front so per-part splice indices stay valid.
        for (const { slot, parts } of resolved.reverse()) slot.apply(parts)
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
