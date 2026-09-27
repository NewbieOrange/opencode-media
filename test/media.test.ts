/**
 * Unit tests for the pure helpers in media.ts.
 * Run: npx -y tsx test.ts
 */
import assert from "node:assert/strict"
import {
  findMarkers,
  formatFromMime,
  hasMarker,
  isNativeImage,
  kindOf,
  makeMarker,
  parseMarker,
  sniffMime,
  splitSegments,
  toProviderParts,
} from "../src/media"

// --- sniffing -------------------------------------------------------------
const wav = new Uint8Array(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE")]))
assert.equal(sniffMime(wav), "audio/wav")
assert.equal(sniffMime(new Uint8Array(Buffer.from("ID3\u0003rest"))), "audio/mpeg")
assert.equal(sniffMime(new Uint8Array(Buffer.from("fLaC...."))), "audio/flac")
assert.equal(sniffMime(new Uint8Array(Buffer.from("OggS...."))), "audio/ogg")
const mp4 = new Uint8Array(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom")]))
assert.equal(sniffMime(mp4), "video/mp4")
const m4a = new Uint8Array(Buffer.concat([Buffer.alloc(4), Buffer.from("ftypM4A ")]))
assert.equal(sniffMime(m4a), "audio/mp4")
const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0])
assert.equal(sniffMime(webm), "video/webm")
assert.equal(sniffMime(new Uint8Array(Buffer.from("%PDF-1.7"))), "application/pdf")
assert.equal(sniffMime(new Uint8Array(Buffer.from("hello world, plain text"))), undefined)
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])
assert.equal(sniffMime(png), undefined) // images stay native

// --- classification -------------------------------------------------------
assert.equal(kindOf("audio/wav"), "audio")
assert.equal(kindOf("video/mp4"), "video")
assert.equal(kindOf("application/pdf"), "binary")
assert.equal(isNativeImage("image/webp"), true)
assert.equal(isNativeImage("audio/wav"), false)
assert.equal(formatFromMime("audio/mpeg"), "mp3")
assert.equal(formatFromMime("audio/flac"), "flac")

// --- markers --------------------------------------------------------------
const ref = { uri: "file:///tmp/a \"weird\" name>.wav", mime: "audio/wav", name: 'say "hi">.wav', bytes: 12844 }
const tag = makeMarker(ref)
const back = parseMarker(tag)
assert.ok(back)
assert.deepEqual(back.ref, ref) // escaping round-trips

const text = `before ${tag} after <opencode-media uri="file:///b.mp4" mime="video/mp4"/> tail`
const found = findMarkers(text)
assert.equal(found.length, 2)
assert.equal(found[1].ref.uri, "file:///b.mp4")
assert.ok(hasMarker(text))
assert.equal(hasMarker("clean text"), false)

const segs = splitSegments(text)
assert.equal(segs.length, 5)
assert.deepEqual(
  segs.map((s) => s.kind),
  ["text", "marker", "text", "marker", "text"],
)
assert.equal(segs[0].kind === "text" && segs[0].text, "before ")
assert.equal(segs[4].kind === "text" && segs[4].text, " tail")

// malformed markers are left alone
assert.equal(findMarkers('<opencode-media uri="x"/>').length, 0) // missing mime
assert.equal(splitSegments('<opencode-media uri="x"/> text').length, 1)

// backslash-escaped quotes (mangled shells) still parse
const mangled = String.raw`<opencode-media uri=\"file:///tmp/a.wav\" mime=\"audio/wav\" name=\"a.wav\"/>`
const mangledParsed = parseMarker(mangled)
assert.ok(mangledParsed)
assert.equal(mangledParsed.ref.uri, "file:///tmp/a.wav")
assert.equal(mangledParsed.ref.mime, "audio/wav")
assert.equal(findMarkers(`text ${mangled} more`).length, 1)

// --- provider parts -------------------------------------------------------
const b64 = Buffer.from("fake-audio").toString("base64")

const audioDefault = toProviderParts({ uri: "file:///a.wav", mime: "audio/wav", name: "a.wav" }, b64)
assert.deepEqual(audioDefault, [{ type: "input_audio", input_audio: { data: b64, format: "wav" } }])

const mp3 = toProviderParts({ uri: "file:///a.mp3", mime: "audio/mpeg" }, b64, { audio: "input_audio" })
assert.deepEqual(mp3, [{ type: "input_audio", input_audio: { data: b64, format: "mp3" } }])

const audioUrl = toProviderParts({ uri: "file:///a.wav", mime: "audio/wav" }, b64, { audio: "audio_url" })
assert.deepEqual(audioUrl, [{ type: "audio_url", audio_url: { url: `data:audio/wav;base64,${b64}` } }])

const video = toProviderParts({ uri: "file:///v.mp4", mime: "video/mp4", name: "v.mp4" }, b64)
assert.deepEqual(video, [{ type: "video_url", video_url: { url: `data:video/mp4;base64,${b64}` } }])

const custom = toProviderParts({ uri: "file:///a.wav", mime: "audio/wav" }, b64, {
  audioTemplate: '{"type":"audio","audio":{"data":"{data}","fmt":"{format}"}}',
})
assert.deepEqual(custom, [{ type: "audio", audio: { data: b64, fmt: "wav" } }])

// PDFs are not injectable yet
assert.deepEqual(toProviderParts({ uri: "file:///x.pdf", mime: "application/pdf" }, b64), [])

// --- capability gating ----------------------------------------------------
import { shouldInject } from "../src/media"

// off: everything injectable (except non-injectable kinds)
assert.equal(shouldInject(["text"], "audio/wav", "off"), true)
assert.equal(shouldInject(undefined, "video/mp4", "off"), true)
assert.equal(shouldInject(["text"], "application/pdf", "off"), false)

// strict: exact modality required
assert.equal(shouldInject(["text", "image", "video"], "audio/wav", "strict"), false) // audio under-declared
assert.equal(shouldInject(["text", "image", "audio"], "audio/wav", "strict"), true)
assert.equal(shouldInject(["text", "image", "video"], "video/mp4", "strict"), true)
assert.equal(shouldInject(undefined, "audio/wav", "strict"), false) // unknown blocks

// auto: block only confidently text-only models
assert.equal(shouldInject(["text", "image", "video"], "audio/wav", "auto"), true) // under-declared works
assert.equal(shouldInject(["text"], "audio/wav", "auto"), false) // text-only blocked
assert.equal(shouldInject(["text"], "video/mp4", "auto"), false)
assert.equal(shouldInject(undefined, "audio/wav", "auto"), true) // unknown allowed
assert.equal(shouldInject([], "audio/wav", "auto"), false) // empty list = text-only

// --- ref metadata (OpenCode image-style snapshots) -------------------------
import { normalizeRef, pickGroup, pushGroup, refsFromMetaValue, type MediaRef } from "../src/media"

const snap = normalizeRef({ uri: "file:///v.mp4", mime: "video/mp4", name: "v.mp4", bytes: 4, data: "AAAA" })
assert.deepEqual(snap, { uri: "file:///v.mp4", mime: "video/mp4", name: "v.mp4", bytes: 4, data: "AAAA" })
assert.equal(normalizeRef({ uri: "file:///v.mp4", mime: "video/mp4", data: "" })?.data, undefined) // empty snapshot dropped
assert.equal(normalizeRef({ uri: "file:///v.mp4" }), undefined) // mime required
assert.equal(normalizeRef("junk"), undefined)
assert.deepEqual(refsFromMetaValue([snap, null, { nope: 1 }]), [snap]) // junk skipped
assert.deepEqual(refsFromMetaValue(snap), [snap]) // single ref tolerated

// --- occurrence groups -----------------------------------------------------
const groups: MediaRef[][] = []
pushGroup(groups, [snap!])
pushGroup(groups, [snap!])
assert.equal(groups.length, 2) // two same-text messages = two groups
pushGroup(groups, [])
assert.equal(groups.length, 2) // empty refs never create a group

assert.deepEqual(pickGroup(groups, 0, 2), groups[0]) // occurrence-aligned
assert.deepEqual(pickGroup(groups, 1, 2), groups[1])
assert.deepEqual(pickGroup(groups, 0, 1), groups[1]) // truncated window: suffix-aligned
assert.equal(pickGroup(groups, 1, 1), undefined)

console.log("all media.ts tests passed")
