# Changelog

## Unreleased

- **Adaptive `read` tool description**: when the active model's
  `capabilities.input` supports audio/video (per `capabilityGate`), the `read`
  tool description is extended per request to advertise media reading — naming
  exactly the modalities that model supports and stating that media arrives as
  perceivable native parts. Text-only models keep the stock description.

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
