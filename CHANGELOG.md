# Changelog

## Unreleased

## 0.2.0 — 2026-09-27

- **Message-derived refs — plugin storage dropped**: the media ↔ message
  association now lives in the messages themselves — user messages carry the
  refs in their admission metadata (`metadata["opencode-media"]`), tool results
  in their tool-state metadata (the tool state persists metadata but not the
  file `output`, so the ref rides there). A per-session map is rebuilt from the
  session's own messages on first touch, so injection still survives service
  restarts, while forks, revert, and compaction now follow the message log for
  free. Plugin storage is neither written nor read anymore (records left by
  0.1.x are ignored). Behavior deltas: `r/` (read-tool) refs are no longer
  shared across sessions (same-note-different-file collisions could inject the
  wrong file before).
- **System hint dropped**: the plugin no longer pushes a `MEDIA_SYSTEM_HINT`
  system message coaching the model to trust its perception. Nothing is added
  to the system prompt; hedging is the model's own behaviour now.
- **Adaptive `read` tool description**: when the active model's
  `capabilities.input` supports audio/video (per `capabilityGate`), a single
  sentence is appended to the `read` tool description naming exactly the
  supported modalities (e.g. "Also supports audio and video files."). Text-only
  models keep the stock description.

## 0.1.0 — 2026-09-27

Initial release.

- **Prompt hook**: captures `@`-attached audio/video that OpenCode's attachment
  pipeline would drop; records refs in durable plugin storage keyed by message
  text hash. Message text is never modified — no visible markers in any UI.
- **`read` tool wrapper**: media files return a clean `[media: file (mime, size)]`
  note (conforming to `read`'s declared output schema) instead of mojibake;
  text and images pass through untouched.
- **Request rewrite**: `http.request` hook splices native media content parts
  into outgoing requests — `input_audio` (raw base64) for audio, `video_url`
  (data URL) for video; custom shapes via `audioTemplate` / `videoTemplate`.
- **Capability gating** (`strict` default): media is only injected when the
  model's `capabilities.input` declares the modality; otherwise the model sees
  an explanatory note. Modes: `strict` / `auto` / `off`.
- **System hint**: tells the model attached media is genuinely perceivable,
  suppressing "I can't hear" hedging caused by chat-template placeholders.
- Explicit `<opencode-media .../>` markers in text remain supported for manual
  prompts and testing (quote-mangling tolerant).
