# opencode-media

OpenCode V2 plugin that delivers **audio and video** (and other non-image binaries) to media-capable
models — through `@`-file attachments *and* the `read` tool.

Verified end-to-end against a self-hosted MiMo V2.6 (vLLM/OpenAI-compatible): audio as
`input_audio`, video as `video_url` with data URLs.

## Why a plugin is needed

- OpenCode's attachment pipeline only forwards **text and PNG/JPEG/GIF/WebP** to the model;
  audio/video/PDF binaries are silently dropped before the request is built.
- The OpenAI-chat protocol layer rejects non-image media parts, so media cannot travel through the
  typed message layer either.

## How it works

Media is captured early and recorded **outside the message text** (so no UI ever shows a marker),
then injected as real provider content parts at the last possible moment:

```
@-attached media ──┐                                ┌── http.request hook:
                   ├─▶ message metadata[hash + bytes] ─┤   text match → input_audio /
read() on media ───┘    (message text clean)          └──  video_url content parts
```

1. **`session.hook("prompt")`** — media attachments that OpenCode would drop are removed from `files`,
   their bytes **snapshotted once**, and the refs recorded in the message's own admission metadata
   (`metadata["opencode-media"]`, persisted as the user message's metadata) under
   `m/<sha256(text)>`. The message text is never modified: no visible tags, mention offsets stay
   valid. This also avoids the 20 MiB attachment limit being applied to media that would never be
   sent anyway.
2. **`ctx.tool.transform("read")`** — the built-in `read` is wrapped: media files return a short
   note like `[media: clip.wav (audio/wav, 12.5 KB)]` and the snapshotted ref rides in the tool
   result's metadata (persisted in the tool state) under `r/<sha256(note)>`; text and images pass
   through untouched.
3. **`session.hook("http.request")`** — every outgoing model request is matched message-by-message
   against the recorded hashes (exact text, individual parts, and joined-part fallbacks). Each
   matching message gets its OWN message's media — matching is occurrence-aligned, so identical
   prompt texts never cross-attach. Media is spliced in as native content parts; the text itself
   is left as-is. A `context` hook extends the `read` tool's description with the modalities the
   active model can actually perceive.

Media bytes are snapshotted **once**, when they enter the conversation — mirroring how OpenCode
stores image attachments: the message holds the bytes it admitted (`data` base64 alongside
`uri`/`mime`/`name` provenance). Later edits to, or deletion of, the source file therefore never
change what the model sees. The messages themselves are the durable record — the plugin keeps no
storage of its own — so injection survives service restarts and follows forks, revert, and
compaction. Records written by 0.2.x that carry only a URI are still honored; their bytes are then
read from disk at request time (small mtime-keyed cache).

Explicit `<opencode-media uri="..." mime="..." name="..."/>` markers in message text are still
honored (useful for tests and manual prompts) but are **no longer generated** by the plugin.

## Install

Add the package to `opencode.json(c)` in your project (or global) config:

```jsonc
{
  "plugins": ["opencode-media"],
}
```

For local development, reference a checkout instead — plugins under `.opencode/plugins/`
are also loaded automatically:

```jsonc
{
  "plugins": ["/path/to/opencode-media"],
}
```

Path-based loading resolves `index.ts` at the checkout root (a one-line re-export of
`src/index.ts`, included in the package for exactly this purpose).

## Options

```jsonc
{
  "plugins": [
    {
      "package": "opencode-media",
      "options": {
        "audio": "input_audio",       // or "audio_url"
        "video": "video_url",
        "maxBytes": 26214400,         // per media item (raw bytes)
        "maxPerRequest": 16,
        "audioTemplate": null,        // custom JSON part: {data} {dataurl} {mime} {format} {name}
        "videoTemplate": null,
        "capabilityGate": "strict",   // "strict" | "auto" | "off" (see below)
        "debug": false,               // log hook activity to /tmp/opencode/media-plugin.log
      },
    },
  ],
}
```

### Capability gating

Injection is checked against the model config's `capabilities.input`:

| Mode | Behavior |
| --- | --- |
| `strict` (default) | Require the exact modality entry (`audio` for audio, `video` for video). Unknown/missing capabilities block injection. |
| `auto` | Inject unless the model confidently declares text-only input. Configs that under-declare (e.g. working audio missing from `input`) keep working. |
| `off` | Always inject; server errors surface naturally. |

When a modality is gated, the model sees `[media: file (mime, size)] — not delivered: model config declares no audio input` instead of the content part. If you use `strict`, declare what your endpoint really supports, e.g. `"capabilities": { "input": ["text", "image", "audio", "video"] }`.

## Notes & limits

- **No visible markers**: message text and tool output stay clean; the media ↔ message association
  lives in the messages' own metadata (`metadata["opencode-media"]`): snapshotted refs
  (`uri`/`mime`/`name`/`bytes`/`data`), keyed in memory by text hash (`m/<hash>`, `r/<hash>`) with
  one occurrence group per media-bearing message, and rebuilt from the session's messages after a
  restart. Identical prompt texts therefore never share media, and truncated context windows stay
  aligned (slots are suffix-matched onto groups).
- Audio format strings are derived from MIME (`wav`, `mp3`, `flac`, `ogg`, `aac`, `m4a`, ...);
  the serving stack must accept them (vLLM accepts wav/mp3 at minimum).
- PDFs and other documents are not injected yet (a note is shown instead).
- Native images (PNG/JPEG/GIF/WebP) are deliberately left to OpenCode's own pipeline.
- Explicit markers remain supported and parsing is tolerant of `\"`-escaped quotes; attribute
  values percent-escape `%`, `"`, `\`, `<`, `>`.
- For best results ask focused questions ("is this a tone or noise?"); purely subjective "describe
  what you hear" prompts can still trigger hedging in some models. The plugin deliberately adds no
  system-prompt coaching — how the model reports its perception is the model's own behaviour.

## Development

Pure logic (sniffing, markers, part mapping) lives in `media.ts` and is covered by `test.ts`:

```sh
npx -y tsx test.ts
```
