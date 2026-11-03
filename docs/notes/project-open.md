# Project open: phases, timings and the branded loader (B-369, D-439)

What happens between clicking a project card (or an agent's `open_project`) and a usable
workspace, how each step is measured, and what the person and an agent are shown while it runs.

## The phases

| phase | where | what runs | label |
|---|---|---|---|
| `reading` | Rust `chroma_project_open` | `project.json` read, timeline ensured, one-time grade migration | Reading project… (Creating project… for a new one) |
| `media` | Rust `open_manifest` | each **unique** video source checked online + probed, in parallel (`apelles_media::probe::probe_cached_many`, up to 8 threads), count streamed | Checking media (n/N)… |
| `preview` | Rust `open_manifest` | the active shot's Colorist frame decoded. **Only when the open was made with Colorist on screen** (D-439); otherwise skipped | Decoding the first frame… |
| `grades` | `useSessionStore.openProject` | shot list + every shot's grade (`chroma_load_grades`) | Loading grades… |
| `timeline` | `followOpenToReady` | the Edit tab's store fetches and hydrates this project's timeline (and React renders it) | Building timeline… |
| `previews` | `followOpenToReady` | the first Edit preview frame reaches the screen | Preparing previews… |

Filmstrips and waveforms are not waited for: they stream in after the loader lifts.

The Rust half arrives as `chroma://project-open-progress` events (`app/src-tauri/src/chroma/open_progress.rs`):
`{ openId, phase, done, total }`, the per-clip step throttled to ~30 Hz with the first and last always
sent. `openId` is the frontend's token for one open, so a late event from an older open is dropped by
id (Tauri events and command replies travel on different channels). The reducer
(`app/src/store/openProgress.ts`) only moves phases forward and counts up.

Each wait in the follow is capped (timeline 15 s, first frame 4 s; an empty timeline skips the frame
wait), so a stuck pane can never leave the loader over a usable workspace.

## Who sees it

- **The clicked launcher card** shows `BrandedLoader variant="compact"` while the launcher is up.
- **The whole window** (`ProjectOpenOverlay`, `z-[9000]`, under toasts) once the workspace is
  mounted: the second half of a launcher open, and any open/new from inside a project.
- **An agent**: `editor_get_state.openProgress` = `{phase, label, done, total, step, steps}` while an
  open runs, null after; `switchingTimeline` while a timeline switch loads. `open_project`'s own reply
  arrives once the session is hydrated (after `grades`).
- The same component also covers the timeline switch (`TimelineSwitchOverlay`, after 150 ms so a fast
  switch never flashes), the Edit tab's first "Loading timeline…", the preview's "Loading preview…",
  the Motion tab's manifest load and the Colorist canvas's frame load.

`BrandedLoader` (`packages/ui/src/branded-loader.tsx`) uses the real mark: `packages/ui/src/assets/
apelles-mark-256.png`, exported from `brand/apelles-mark-transparent.png` by
`sips -Z 256 brand/apelles-mark-transparent.png --out packages/ui/src/assets/apelles-mark-256.png`
(see `brand/README.md`). Its two loops (`--animate-loader-breathe`, `--animate-loader-sweep` in
`packages/ui/src/styles.css`) run only under `motion-safe:`; with reduced motion the mark is still and
the indeterminate bar is a static track.

## Deferred Colorist frame (D-439)

An open with Edit or Motion on screen passes `deferColoristFrame: true`. Rust still registers every
shot and selects the active one, but does not decode its pixels. `useSessionStore.coloristFramePending`
records that, and `ensureColoristFrame()` decodes it once (concurrent callers share one decode) when:

- the Colorist tab is shown (`Root.tsx`, before the D-071 resync), or
- any Colorist MCP op runs other than the frame-free ones (`bridgeOpClasses.ts`:
  `needsColoristFrameBefore`; a project switch with `include_grade` decodes the new project after it
  switched, `needsColoristFrameAfter`).

An open made from Colorist installs the frame in Rust and returns its facts as `ProjectOpenDto.loaded`;
the frontend applies them instead of calling `chroma_session_set_active` (which decoded the same frame
a second time before B-369).

## Measuring

Debug builds (`APELLES_PERF_MARKS`, D-437 S0a) write:

- `apelles:open:<phase>` marks and measures, `apelles:open:start` / `ready` / `total`
  (`useOpenProgressStore.ts`);
- `apelles:load:*` measures from the timeline fetch (`packages/editor/src/loadPerf.ts`): `hydrated`,
  `painted`, `first-frame`, `first-filmstrip`, `first-peaks`, `previews-settled`.

Read them with `debug_perf_entries`. Rust also logs one line per open:
`[chroma::project] open <name>: <ms> (reading …, media …, preview …, save …)`.

Method used for the numbers below: a `tauri build --debug` bundle (identifier `studio.apelles.perf2`,
port 19799), a clone of "Nemotron Transcribe" (290-clip active timeline "Voiceover v2", 69 unique
video sources), `open_project` over the bridge, window kept active (`debug_activate_app`,
`debug_set_occlusion_throttling false`; a covered window gets no rAF and no preview frame). Warm =
relaunch with the disk caches filled; cold = the app's `chroma` cache directory removed. The first
launch of a freshly copied bundle is slower (macOS checks the new binaries) and was discarded.

## Numbers (2026-11-03)

Warm (owner's normal case; medians of the later runs):

| phase | before | after |
|---|---|---|
| reading | 6–15 ms | 5–12 ms |
| media | 26–64 ms | 18–31 ms |
| preview (Colorist decode) | 253–503 ms | deferred (≈480 ms on first Colorist use) |
| grades | 454–952 ms (incl. a second decode of the same frame) | 27–41 ms |
| timeline (fetch + hydrate + first render) | runs inside `grades` | 280–346 ms |
| previews (first preview frame) | 165–1241 ms | 196–325 ms |
| `open_project` reply | 904–1653 ms | 135–186 ms |
| **loader up → workspace ready** | **1101–2463 ms** | **598–732 ms** |

Cold (empty probe cache):

| phase | before | after |
|---|---|---|
| media | 8.8 s (serial ffprobe) | 1.8 s (parallel) |
| **total** | **11.8 s** | **2.7 s** |

What is left: ~300 ms of React rendering the 290-clip timeline on hydrate (the timeline lanes, tracked
under D-437), and the preview's first frame, which is mostly ffmpeg + VideoToolbox decoder start-up
(~350–800 ms per new decode pipe, measured by hand); the first open after an app launch can still take
1–2 s for that frame.
