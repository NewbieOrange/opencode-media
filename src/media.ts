/**
 * Pure helpers for the opencode-media plugin: media sniffing, marker
 * encoding/parsing, and provider content-part mapping.
 *
 * No OpenCode imports here so this module stays trivially unit-testable.
 */

export type MediaKind = "audio" | "video" | "binary"

export interface MediaRef {
  /** file: URL, absolute path, or data: URL. Provenance only — never re-read once `data` is set. */
  uri: string
  mime: string
  name?: string
  /** Raw byte size, when known. */
  bytes?: number
  /**
   * Base64 snapshot of the raw bytes, captured when the media entered the
   * conversation — mirroring how OpenCode stores image attachments (the
   * message holds the bytes it admitted). Later edits to, or deletion of,
   * the source file never change what the model sees.
   */
  data?: string
}

/** Normalize a metadata value into a MediaRef (returns undefined for garbage). */
export function normalizeRef(value: unknown): MediaRef | undefined {
  const ref = value as Partial<MediaRef> | null | undefined
  if (!ref || typeof ref !== "object") return undefined
  if (typeof ref.uri !== "string" || typeof ref.mime !== "string") return undefined
  const out: MediaRef = { uri: ref.uri, mime: ref.mime }
  if (typeof ref.name === "string") out.name = ref.name
  if (typeof ref.bytes === "number") out.bytes = ref.bytes
  if (typeof ref.data === "string" && ref.data.length > 0) out.data = ref.data
  return out
}

/** Normalize a metadata value into refs (tolerates a single ref, skips junk). */
export function refsFromMetaValue(value: unknown): MediaRef[] {
  const out: MediaRef[] = []
  const take = (v: unknown) => {
    const ref = normalizeRef(v)
    if (ref) out.push(ref)
  }
  if (Array.isArray(value)) for (const v of value) take(v)
  else take(value)
  return out
}

// ---------------------------------------------------------------------------
// Occurrence groups
// ---------------------------------------------------------------------------

/**
 * One media-bearing message per key becomes one group (its refs, in order).
 * Distinct messages that share a text hash each get their own group, so
 * injection can stay message-scoped the way OpenCode's image attachments are.
 */
export type RefGroups = MediaRef[][]

/** Append one message's refs as a new occurrence group. */
export function pushGroup(groups: RefGroups, refs: readonly MediaRef[]): void {
  if (refs.length === 0) return
  groups.push(refs.map((r) => ({ ...r })))
}

/**
 * Pick the group for the `index`-th of `occurrences` same-key slots in one
 * outgoing request. Slots are suffix-aligned onto groups: context truncation
 * drops the oldest messages first, so the request's slots correspond to the
 * LAST groups recorded.
 */
export function pickGroup<T>(groups: readonly T[], index: number, occurrences: number): T | undefined {
  return groups[groups.length - occurrences + index]
}

export function kindOf(mime: string): MediaKind {
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  return "binary"
}

/** Media types OpenCode already sends to the model natively (PNG/JPEG/GIF/WebP). */
export function isNativeImage(mime: string): boolean {
  return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)
}

const ascii = (b: Uint8Array, start: number, len: number): string =>
  Array.from(b.subarray(start, start + len))
    .map((c) => String.fromCharCode(c))
    .join("")

/**
 * Detect a media MIME type from leading file bytes.
 * Returns undefined for text, native images, and unrecognized data.
 */
export function sniffMime(head: Uint8Array): string | undefined {
  if (head.length < 4) return undefined
  const b = head

  // RIFF containers
  if (ascii(b, 0, 4) === "RIFF") {
    const form = ascii(b, 8, 4)
    if (form === "WAVE") return "audio/wav"
    if (form === "AVI ") return "video/x-msvideo"
    return undefined
  }
  // FLAC
  if (ascii(b, 0, 4) === "fLaC") return "audio/flac"
  // Ogg (Vorbis/Opus/Speex audio; Theora video lives here too but audio is far more common)
  if (ascii(b, 0, 4) === "OggS") return "audio/ogg"
  // AIFF
  if (ascii(b, 0, 4) === "FORM" && (ascii(b, 8, 4) === "AIFF" || ascii(b, 8, 4) === "AIFC")) return "audio/aiff"
  // MIDI
  if (ascii(b, 0, 4) === "MThd") return "audio/midi"
  // WAVpack
  if (ascii(b, 0, 4) === "wvpk") return "audio/x-wavpack"
  // Matroska / WebM
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm"
  // FLV
  if (ascii(b, 0, 3) === "FLV") return "video/x-flv"
  // MPEG program stream / elementary stream
  if (b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && (b[3] === 0xba || b[3] === 0xb3)) return "video/mpeg"
  // MP4 family via ftyp brand
  if (ascii(b, 4, 4) === "ftyp") {
    const brand = ascii(b, 8, 4)
    if (["M4A ", "M4B ", "M4P "].includes(brand)) return "audio/mp4"
    if (brand === "qt  ") return "video/quicktime"
    if (brand.startsWith("3gp")) return "video/3gpp"
    return "video/mp4"
  }
  // ADTS AAC
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return "audio/aac"
  // MP3 (ID3 tag or bare frame sync)
  if (ascii(b, 0, 3) === "ID3") return "audio/mpeg"
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "audio/mpeg"
  // PDF: not sent natively by OpenCode; represent it as a marker too.
  if (ascii(b, 0, 4) === "%PDF") return "application/pdf"

  return undefined
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

/**
 * Markers are the stable seam between capture (prompt attachments, read tool)
 * and injection (the outgoing model request). They travel through OpenCode as
 * ordinary text and are replaced with real media parts at request time.
 */
export const MARKER_MAGIC = "<opencode-media"

const MARKER_RE = /<opencode-media\b[^>]*\/>/g

const ATTR_ENCODE: Array<[string, string]> = [
  ["%", "%25"],
  ['"', "%22"],
  ["\\", "%5C"],
  ["<", "%3C"],
  [">", "%3E"],
]
const ATTR_DECODE: Array<[string, string]> = [
  ["%22", '"'],
  ["%5C", "\\"],
  ["%3C", "<"],
  ["%3E", ">"],
  ["%25", "%"],
]

const escapeAttr = (v: string) => ATTR_ENCODE.reduce((s, [a, b]) => s.split(a).join(b), v)

const unescapeAttr = (v: string) => ATTR_DECODE.reduce((s, [a, b]) => s.split(a).join(b), v)

export function makeMarker(ref: MediaRef): string {
  const attrs = [`uri="${escapeAttr(ref.uri)}"`, `mime="${escapeAttr(ref.mime)}"`]
  if (ref.name) attrs.push(`name="${escapeAttr(ref.name)}"`)
  if (ref.bytes !== undefined) attrs.push(`bytes="${ref.bytes}"`)
  return `<opencode-media ${attrs.join(" ")}/>`
}

export interface ParsedMarker {
  /** The full marker tag. */
  tag: string
  ref: MediaRef
}

export function parseMarker(tag: string): ParsedMarker | undefined {
  // Tolerate shells/clients that escape inner quotes as \" when relaying text.
  const normalized = tag.replaceAll('\\"', '"')
  const attrs: Record<string, string> = {}
  for (const m of normalized.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[m[1]] = unescapeAttr(m[2])
  if (!attrs.uri || !attrs.mime) return undefined
  const ref: MediaRef = { uri: attrs.uri, mime: attrs.mime }
  if (attrs.name) ref.name = attrs.name
  if (attrs.bytes) ref.bytes = Number(attrs.bytes)
  return { tag, ref }
}

export function findMarkers(text: string): ParsedMarker[] {
  const out: ParsedMarker[] = []
  for (const m of text.matchAll(MARKER_RE)) {
    const parsed = parseMarker(m[0])
    if (parsed) out.push(parsed)
  }
  return out
}

export function hasMarker(text: string): boolean {
  return text.includes(MARKER_MAGIC)
}

export type Segment = { kind: "text"; text: string } | { kind: "marker"; marker: ParsedMarker }

/** Split text into plain-text and marker segments, preserving order. */
export function splitSegments(text: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(MARKER_RE)) {
    const parsed = parseMarker(m[0])
    if (!parsed) continue
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) })
    out.push({ kind: "marker", marker: parsed })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) })
  return out
}

/** Human-readable note used as the `read` tool output and near legacy markers. */
export const NOTE_PREFIX = "[media:"

export function markerNote(ref: MediaRef): string {
  const size = ref.bytes !== undefined ? `, ${formatBytes(ref.bytes)}` : ""
  return `${NOTE_PREFIX} ${ref.name ?? ref.uri} (${ref.mime}${size})]`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// ---------------------------------------------------------------------------
// Capability gating
// ---------------------------------------------------------------------------

export type CapabilityGate = "auto" | "strict" | "off"

/**
 * Decide whether media of the given MIME may be injected for a model.
 *
 * - "strict": require the modality in capabilities.input ("audio" / "video").
 * - "auto":   block only a confidently text-only model; configs that
 *             under-declare (e.g. working audio absent from input) still work.
 * - "off":    always inject (server errors surface naturally).
 */
export function shouldInject(
  inputCaps: readonly string[] | undefined,
  mime: string,
  gate: CapabilityGate,
): boolean {
  const kind = kindOf(mime)
  if (kind === "binary") return false // never injectable, regardless of gate
  if (gate === "off") return true
  const wanted = kind === "audio" ? "audio" : "video"
  if (inputCaps === undefined) return gate !== "strict" // unknown: auto allows, strict blocks
  if (inputCaps.includes(wanted)) return true
  if (gate === "strict") return false
  // auto: block only when the model confidently declares text-only input
  const media = ["image", "audio", "video"]
  return inputCaps.some((c) => media.includes(c))
}

// ---------------------------------------------------------------------------
// Provider content parts (OpenAI-compatible chat shape)
// ---------------------------------------------------------------------------

export interface PartOptions {
  /** Audio part shape. "input_audio" is the OpenAI chat standard (verified against vLLM). */
  audio?: "input_audio" | "audio_url"
  /** Video part shape. "video_url" with a data URL (verified against vLLM/torchcodec). */
  video?: "video_url"
  /** Custom JSON template; placeholders: {data} {dataurl} {mime} {format} {name}. */
  audioTemplate?: string
  videoTemplate?: string
}

const FORMAT_FROM_MIME: Record<string, string> = {
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
  "audio/aiff": "aiff",
  "audio/midi": "midi",
}

export function formatFromMime(mime: string): string {
  return FORMAT_FROM_MIME[mime] ?? mime.replace(/^.*\//, "")
}

function fillTemplate(template: string, ref: MediaRef, base64: string): unknown {
  const filled = template
    .replaceAll("{data}", base64)
    .replaceAll("{dataurl}", `data:${ref.mime};base64,${base64}`)
    .replaceAll("{mime}", ref.mime)
    .replaceAll("{format}", formatFromMime(ref.mime))
    .replaceAll("{name}", ref.name ?? "")
  return JSON.parse(filled)
}

/**
 * Map a media asset to OpenAI-compatible chat content parts.
 * Returns [] for kinds that cannot be injected (e.g. PDFs for now).
 */
export function toProviderParts(ref: MediaRef, base64: string, opts: PartOptions = {}): unknown[] {
  const kind = kindOf(ref.mime)
  const template = kind === "audio" ? opts.audioTemplate : opts.videoTemplate

  if (template) return [fillTemplate(template, ref, base64)]

  if (kind === "audio") {
    const mode = opts.audio ?? "input_audio"
    if (mode === "audio_url") {
      return [{ type: "audio_url", audio_url: { url: `data:${ref.mime};base64,${base64}` } }]
    }
    return [{ type: "input_audio", input_audio: { data: base64, format: formatFromMime(ref.mime) } }]
  }

  if (kind === "video") {
    return [{ type: "video_url", video_url: { url: `data:${ref.mime};base64,${base64}` } }]
  }

  return []
}