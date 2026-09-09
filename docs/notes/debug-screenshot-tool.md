# Debug screenshot tool — the app photographs its own webview (D-210)

**What it is.** A screenshot of the running Apelles window, taken from *inside*
the app's own process, saved as a PNG, reachable from an agent (MCP tool
`debug_screenshot`), from a human (Cmd/Ctrl+Shift+D), and from the frontend
(Tauri command `chroma_debug_screenshot`). Plus a small companion,
`debug_sample_pixel` / `chroma_debug_sample_pixel`, that reads the exact RGBA of
one pixel out of a saved shot.

**Why it exists.** Multiple agents in one session (2026-09-07/08) independently
hit the same wall trying to live-verify a UI fix: this environment's process has
no macOS **Screen Recording** (TCC) permission, so `screencapture(1)` fails
outright, and WebKit's accessibility tree isn't exposed through System Events
either. Every live-verification pass since then has fallen back to indirect
signals — polling `get_state`/`editor_get_state`, blind `cliclick` coordinates,
`ffprobe`/pixel-sampling a real *exported* file instead of the live preview.
Those are real signals, but strictly worse than looking, and it is why a bug
like "the on-canvas transform box doesn't line up with the picture" needed
several rounds of owner-supplied screenshots before an agent could verify it at
all.

---

## Why this gets past the Screen Recording wall

macOS's Screen Recording permission gates **system-level screen capture** — the
APIs that let a process read pixels it does not own:

| API | Gated by Screen Recording? |
| --- | --- |
| `screencapture(1)` | yes — fails/blank without it |
| `CGWindowListCreateImage` | yes (since macOS 10.15) |
| ScreenCaptureKit | yes |
| **`-[WKWebView takeSnapshotWithConfiguration:completionHandler:]`** | **no** |

`takeSnapshot` is not screen capture. It asks a webview to render *its own
content* into an image, in the process that already owns that webview — the same
mechanism behind Safari's own "save as image". No entitlement, no TCC prompt, no
user permission, nothing for an agent to grant itself. It has been available
since macOS 10.13.

This was **verified, not assumed**: the API is reachable from Rust in this
codebase's own Tauri version, and a real capture of a real running window has
been read back and inspected (see "Verification" at the bottom).

## How it is wired

```
MCP  debug_screenshot ─┐
                       ├─► control server  ─► chroma::debug_capture ─► WKWebView
GUI  Cmd/Ctrl+Shift+D ─┤     (native op)         takeSnapshot          (main thread)
     → chroma_debug_screenshot (Tauri command)          │
                                                        ▼
                                          NSImage → NSBitmapImageRep → PNG → disk
```

- **`app/src-tauri/src/chroma/debug_capture.rs`** — the whole capture. Tauri's
  `WebviewWindow::with_webview` hands the closure the platform handle on the
  **main thread**; on macOS `PlatformWebview::inner()` *is* the `WKWebView`.
  `takeSnapshot` is asynchronous, so the completion block sends the encoded PNG
  back over an `mpsc` channel that the (background) calling thread waits on with
  a 10s budget. `NSImage → TIFFRepresentation → NSBitmapImageRep →
  representationUsingType:NSBitmapImageFileTypePNG` does the encode — AppKit's
  own encoder, at the backing representation's real pixel size.
- **`app/src-tauri/src/chroma/control.rs`** — `native_op()`. `debug_screenshot`
  and `debug_sample_pixel` are the only ops the control server answers *itself*
  rather than forwarding to the frontend. Deliberate: a screenshot is a picture
  of the webview, not a fact about the store, and the moment it is most worth
  having is when the frontend is too wedged to reply to anything.
- **`mcp/server.py`** — the two MCP tools.
- **`app/src/hooks/useDebugScreenshot.ts`** — the human affordance.

### Bindings

The typed `objc2` stack (`objc2-web-kit`, `objc2-app-kit`, `objc2-foundation`,
`block2`), not the older `objc` 0.2 + hand-written `msg_send!` that
`window_customizer.rs` uses. All five crates were *already* in the workspace
lock as transitive dependencies of tauri/wry/muda/cpal, so this adds direct
edges, not new crates to build. See D-210 for the trade-off.

## How to call it

### As an agent (the primary path)

```
1. debug_screenshot()            -> {"path": "/var/folders/.../main-20260908-011533-204.png",
                                     "label": "main", "width": 2560, "height": 1440,
                                     "scaleFactor": 2.0, "bytes": 812345}
2. Read that exact path          -> the image is rendered into context; look at it.
```

Two steps on purpose — the path is cheap, the image is not. `inline=True` folds
them into one call when a single look is all you need.

Before/after comparison: shoot, change, shoot, `Read` both. Filenames are
timestamped to millisecond resolution, so a directory listing is in order.

Colour/alignment claims: `debug_sample_pixel(path, x, y)` →
`{r, g, b, a, hex, imageWidth, imageHeight}`. **Coordinates are image pixels,
not CSS pixels** — multiply a DOM coordinate by the shot's `scaleFactor` (2 on a
Retina display). An out-of-range coordinate is an error naming the real image
size, so a coordinate-space mistake surfaces immediately instead of as a wrong
colour.

### As a human

**Cmd/Ctrl+Shift+D** anywhere in the app. A toast reports the size and the
absolute path. Useful for attaching a real picture to a bug report without
leaving the app. The combo is fixed (not in RapidRAW's rebindable
`KEYBIND_DEFINITIONS` table — see the hook's header comment for why); nothing
else in the app uses it, and macOS's own Cmd+Shift+3/4/5 are deliberately
avoided.

### From the frontend

`invoke('chroma_debug_screenshot', { windowLabel?, outPath? })` and
`invoke('chroma_debug_sample_pixel', { path, x, y })`. (The Tauri command's
parameter is `windowLabel`, not `window`, to stay clear of Tauri's own
inject-a-`tauri::Window` parameter; the MCP tool and the control-server op both
call it `window`.)

## Where the files go

`$TMPDIR/chroma-debug-screenshots/<window label>-<YYYYMMDD-HHMMSS-mmm>.png`,
overridable with the **`CHROMA_DEBUG_SHOTS_DIR`** environment variable (point it
at the repo's gitignored `scratch/` to keep a session's shots together), or per
call with an explicit `out_path`.

Never inside the repo by default: the app also runs as a built `.app` with no
repo anywhere near it, and a debug tool must not drop files into a tracked tree.
Missing parent directories are created; an existing file is overwritten.

## Errors, not blank images

- No window open, or an unknown window label → error naming the labels that do
  exist.
- Minimised or hidden window → error saying so. A hidden window has no rendered
  web content, and a black rectangle that *looks* like a screenshot is worse
  than a refusal.
- WebKit's completion handler doesn't fire within 10s → error saying the web
  content process may be wedged.
- A 0×0 result → error.
- Non-macOS build → a real "implemented for macOS only" error.

## Known limits

1. **Webview only.** The native title bar, native menus, a native open/save
   dialog, another app's window, a second display: none of them are in the
   image. Capturing those *is* system screen capture, which is exactly the thing
   that is blocked. If a native dialog is up, the shot shows the page behind it.
2. **Device pixels.** `width`/`height` are CSS pixels × `scaleFactor`. Divide by
   `scaleFactor` to map back to a DOM coordinate.
3. **Not a video.** One frame per call; there is no capture-a-sequence mode. For
   "does this animate", shoot at two moments.
4. **macOS only** (v1 scope, `docs/02-scope.md`).
5. **Not a diff tool.** It saves PNGs; comparing them is the caller's job
   (`Read` both, or `debug_sample_pixel` for a numeric claim).
6. **No Tauri capability entry needed.** `capabilities/default.json` gates
   *plugin* commands; app-defined `#[tauri::command]`s like every other
   `chroma_*` command are not listed there and do not need to be. Checked, not
   assumed.

## Verification (2026-09-08, real run)

Not "it compiles". A real `tauri dev` instance of this branch was launched in an
isolated worktree (`CHROMA_CONTROL_PORT=19790`) and driven over the control
server:

```
POST /op {"op":"debug_screenshot","args":{}}
→ {"ok":true,"result":{"label":"main","width":2692,"height":1800,
                       "scaleFactor":2.0,"bytes":331054,
                       "path":".../chroma-debug-screenshots/main-20260908-012416-018.png"}}
```

That PNG was then **read back and looked at**: a real, non-blank, correctly
sized picture of the actual Apelles UI — the project launcher, with "Welcome to
Apelles", the dashed New Project card, and three real project cards showing
their real thumbnails. 2692×1800 is 1346×900 CSS at `scaleFactor` 2, i.e. the
true window content size.

`debug_sample_pixel` against that same file:

| coordinate (image px) | result | what it is |
| --- | --- | --- |
| 36, 39 | `#fb2c36` | the window's red close dot |
| 200, 1400 | `#181818` | the app's dark page background |

Error paths, all real messages rather than a blank image:

```
x=9999          → "(9999, 0) is outside the 2692x1800 image"
missing y       → "debug_sample_pixel needs a non-negative integer 'y'"
window="nope"   → "no window labelled 'nope' (open: main)"
```

Both control-server call shapes work (`POST /op {op,args}` and
`POST /debug_screenshot {..args}`), and an explicit `out_path` is honoured
(`/tmp/chroma-shot-explicit.png`, identical 331054 bytes).

Also: `cargo clippy` clean on the new code, 4 unit tests
(`chroma::debug_capture::tests`) green, `tsc` adds no new errors.

**Not** verified by a live keypress: the Cmd/Ctrl+Shift+D shortcut. Synthesising
a keystroke into another app needs macOS **Accessibility** permission, which
this process lacks for the same reason it lacks Screen Recording — so the GUI
path is verified only by construction (the hook calls
`chroma_debug_screenshot`, whose `screenshot_to_file` is the exact function the
verified control-server route calls). Said plainly rather than implied.
