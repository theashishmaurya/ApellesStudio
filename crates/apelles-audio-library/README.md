# apelles-audio-library

**Layer 1.** Openverse audio search and import (D-400): the licence policy, the response parser, the credits ledger and the HTTP client.

- **Deps:** `serde`, `serde_json`, `thiserror`, `reqwest` (rustls only), `tokio` (time). No Tauri, no ffmpeg, no timeline types.
- **Depended on by:** `app/src-tauri` (`chroma/audio_library.rs`, the Tauri commands behind `editor_search_audio`, `editor_import_audio` and `editor_get_credits`).
- **Network:** only `Client::search`, `Client::detail` and `Client::download` touch it, and only a tool call reaches them. Nothing in the render or grade path depends on this crate (local-first).
- **Licences:** `cc0` and `by` by default; `by-sa` and `pdm` when asked for; any `nc` or `nd` licence is refused with a named reason, before any request.
- **Tests:** parsing and the licence filter run on a recorded response (`tests/fixtures/search_rain_all_licences.json`, `GET /v1/audio/?q=rain` across every licence family). No test uses the network.
