# The Edit preview on a native GPU surface (D-451, D-454)

**Question (owner, 2026-11-03, roadmap 00r item 5a).** Apelles gets one GPU render engine for export and the
Edit preview (D-448, `apelles-compositor`). How does a frame that engine draws reach the screen at 60 fps, with
smooth scrubbing, and with no GPU→CPU read-back, no copy through Tauri IPC and no re-upload into the webview?

**Answer.** A `CAMetalLayer` in its own `NSView`, inserted into the window directly **below** the transparent
`WKWebView`, kept exactly under the preview's DOM rectangle, presented to by wgpu on the engine's own device. The
webview's preview area is transparent ("the hole"), so the React overlays draw on top and keep the pointer. The
Colorist has shown its picture this way since B-006 (one full-window surface); this is the same idea with a
layer of the preview's own size. Prototyped in §4–§9 (D-451); **since D-454 it is the product preview, in
release builds too — §10 is what was built, how it is clocked, and what was deleted.**

## 1. Today's path, measured

The code path (D-449, merged while this was being measured, replaced step 2's CPU blend with the GPU engine and
a read-back of every frame, `PendingFrame::wait`; nothing after step 2 changed):

1. **Decode.** `PreviewPane`'s play loop (rAF clock, one request in flight, B-370) or its scrub subscription calls
   `chroma_timeline_frame(pos, maxLongEdge, playing)` over Tauri IPC. In Rust, each visible layer's frame comes
   from a persistent `ffmpeg` decode pipe (`decode_pipe`, VideoToolbox → rgb24 over a pipe), layers decoded on
   scoped threads.
2. **Composite** (`timeline_frame_image` → `render_timeline_frame`) at the preview's long edge, to an RGBA image.
3. **Encode** that image as a JPEG (`encode_preview_jpeg`, D-217).
4. **IPC.** The JPEG bytes return as a binary `tauri::ipc::Response` (not base64, D-217).
5. **Webview.** A `Blob` → object URL → `<img>.src`, written imperatively (D-290); WebContent decodes the JPEG,
   uploads it to a texture, and WebKit's compositor (UI process → window server) puts it on screen.

**Measured, this session, on the build before D-449 merged** (so step 2 was still the CPU blend; a re-run on the
GPU-engine build was blocked by the Mac locking, so the `<img>` row is owed a re-measure on it) (debug bundle `studio.apelles.perf9`, a 1920×1080 30 fps timeline with two stacked
1080p video layers, one a 40% picture-in-picture; preview 678×320 CSS pt, 1356×640 px; M-series MacBook,
window 1280×720; a shared machine whose load average swung 14–60 because other agents were building):

| | quiet (load ~15) | loaded (load 40–55) |
|---|---|---|
| `fetch` (IPC + decode + composite + JPEG), median / p95 | 14–19 / 17–25 ms | 33–81 / 119–167 ms |
| paint rate on the 30 fps timeline | 30.0 fps, 0–2 hitches | 11.6–21.9 fps |
| decode + composite alone (the same render, `timeline` source, `lastRenderMs`) | 10.5–16.8 ms | 49–68 ms |
| CPU while playing (`top`): app / WebContent | 52.5% / 33.2% | — |

So of a ~14–19 ms fetch, ~3–5 ms is JPEG encode + IPC, and the WebContent process then spends about a third of a
core decoding and uploading 30 JPEGs a second. With the GPU engine in step 2 the same path would add a GPU→CPU
read-back of every frame (`PendingFrame::wait`'s `MAP_READ` staging copy, ~3.5 MB per 1356×640 frame) in front of
all of it. That is the cost this note removes.

## 2. References

- **The pattern in the editors themselves.** Final Cut Pro, DaVinci Resolve and Premiere Pro draw their viewers
  with the same GPU engine that renders, into a native GPU view; the UI chrome around and over it is native too.
  There is no "copy the frame into the UI toolkit" step anywhere in them (D-448's reference set).
- **This repo, B-006 / `gpu_processing::WgpuDisplay`.** RapidRAW's Colorist creates a wgpu surface on the whole
  Tauri window (`instance.create_surface(window)`), the webview above it is transparent (`tauri.conf.json`
  `transparent: true`, `macOSPrivateApi: true`, wry sets the private `drawsBackground = NO`), the shell root goes
  `bg-transparent` (`wgpuSurfaceActive`), and `Editor.tsx`'s `syncWgpu` sends the image rect on every
  `ResizeObserver` / resize tick (`update_wgpu_transform`), which re-renders with a scissor. It has worked in
  the shipped app for two months: the z-order and transparency questions are already answered on this exact
  stack.
- **wry 0.55 (`src/wkwebview/mod.rs`).** The window's content view is a `WryWebViewParent` whose one subview is
  the `WKWebView`; a sibling `NSView` inserted `NSWindowBelow` the webview is composited under it by AppKit.
  wry's own `examples/transparent.rs` sets transparency at the window, webview and `<body>` levels, as this app
  does.
- **wgpu 29.** `SurfaceTargetUnsafe::CoreAnimationLayer(*mut c_void)` makes a surface from a `CAMetalLayer` the
  caller owns. `wgpu-hal`'s Metal `Surface::configure` sets the layer's device, pixel format, drawable size,
  `displaySyncEnabled` (Fifo) and `maximumDrawableCount` (= frame latency + 1) and leaves `colorspace`,
  `opaque` and `contentsScale` alone, so those are ours to set. A surface can only be configured with a device
  of the instance it came from, which is why `apelles_gpu::GpuContext` now keeps its `instance` and `adapter`.
- **raw-window-metal 1.1** (what `create_surface(window)` uses) documents the alternatives for putting a Metal
  layer into an AppKit view (replace the view's layer, add a sublayer that tracks the parent's bounds and scale
  by KVO, or add a subview) and why a sublayer of an arbitrary view needs observers for bounds and
  `contentsScale`. A layer-hosting view of our own needs neither: we set its frame and scale ourselves.
- **Apple, `CAMetalLayer`.** `presentsWithTransaction` presents in step with the Core Animation transaction
  (for content that must move with surrounding layout, at a latency cost and on the committing thread);
  `displaySyncEnabled` / `maximumDrawableCount` set pacing and queue depth; `colorspace` tags the drawable for
  ColorSync; `wantsExtendedDynamicRangeContent` is for EDR (wgpu turns it on only for `Rgba16Float`).
- **WebKit / IOSurface.** WKWebView has no public API to import an IOSurface or a Metal texture into the page.
  WebGPU (on by default in Safari 26 / macOS 26 WebKit) can draw in the page, but a frame drawn by a native
  process can only reach it as bytes (an `ImageBitmap`, a `VideoFrame` from a buffer), i.e. a copy. Firefox's
  `ExternalTextureMacIOSurface` is the in-browser version of what we would need, and WebKit exposes nothing like
  it to an embedder.
- **gpui-wry** (GPUI + wry) puts the webview over native GPU content and says so as its limitation: "any GPUI
  elements behind the WebView bounds will be covered". The webview-on-top z-order is the general shape of every
  native + webview hybrid; what makes it work for a viewer is a transparent page region.

## 3. Options

| | Zero-copy | Latency | Follows layout | Overlays on top | Colour | Maintenance |
|---|---|---|---|---|---|---|
| **A. Native layer behind the webview, preview-sized (chosen)** | yes: the engine's output is sampled by one pass into the drawable | engine done → GPU-done of a ~0.3 ms pass → next window-server composite | the DOM rect, sent once per animation frame when it changes; the view moves in a `CATransaction` with actions off | yes, the webview is above | the layer is tagged (`sRGB` / Rec.709 / P3) | ~600 lines, AppKit + wgpu only, no private API beyond the transparency the app already uses |
| B. The Colorist's full-window surface (reuse `WgpuDisplay`) | yes | the same | yes, but every layout change needs a re-render to move the picture (the drawable is the window) | yes | one tag for the whole window | it is a second device today (not the engine's), owned by RapidRAW code, and a full-window drawable is ~4x the pixels of the preview per present |
| C. Native layer ABOVE the webview | yes | the same | the same | **no**: the crop / transform / caption handles would be under the picture; would need a second (child) webview for overlays, i.e. Tauri's `unstable` multi-webview, and input routing between two pages | — | high |
| D. Read back, send bytes, draw in the page (today's shape, with the GPU engine) | no: GPU→CPU read-back + IPC + decode/upload in WebContent | +1 copy each way, + JPEG encode/decode or a raw upload | free (it is the DOM) | yes | WebKit's | low, but it is the cost the task removes |
| E. IOSurface shared into the page | would be, but there is no WebKit API to receive one | — | — | — | — | not possible today |
| F. WebGPU in the page | no: frames still cross as bytes, and it is a second engine in TypeScript (D-448 rules that out) | — | — | — | — | — |
| G. `AVSampleBufferDisplayLayer` instead of `CAMetalLayer` | yes, with IOSurface-backed `CVPixelBuffer`s | presentation-timestamp driven (good for audio sync) | the same placement as A | the same as A | `CVImageBuffer` colour attachments | the engine would have to render into `CVPixelBuffer`s it imports as wgpu textures (hal interop); worth it only if A/V sync needs the display link's timestamps. A later refinement of A's presenter, not a different placement |

## 4. The prototype

`app/src-tauri/src/chroma/preview_surface/` (compiled only with `debug_assertions`, macOS):

- **The view.** `native_view::install` creates a `CAMetalLayer` (opaque, colour-tagged), makes it the layer of a new
  layer-hosting `NSView`, and adds that view to the webview's superview (wry's `WryWebViewParent`) with
  `addSubview:positioned:NSWindowBelow relativeTo:webview`. `place` converts the DOM rectangle (CSS px, top-left)
  into the webview's coordinates (whichever way it is flipped), lets AppKit map it to the parent with
  `convertRect:toView:`, and sets the frame and `contentsScale` (the window's `backingScaleFactor`) inside a
  `CATransaction` with actions disabled, so a move lands in one frame. All on the main thread via Tauri's
  `with_webview`; the view never leaves a main-thread `thread_local`.
- **The surface.** `wgpu::Instance::create_surface_unsafe(SurfaceTargetUnsafe::CoreAnimationLayer(layer))` on the
  instance of `preview_surface::gpu()` (the one `apelles_gpu::GpuContext`), configured `Bgra8Unorm` (non-sRGB),
  `Opaque`, `Fifo`, frame latency 2, sized `Placement::drawable` (the view's size × scale) and reconfigured only
  when that changes.
- **The pass.** `Presenter::present` acquires the drawable, writes a 48-byte uniform (picture box, background,
  source size), binds the source and draws one fullscreen triangle: inside the picture box it samples the frame
  (`fs_texture`: a linear sampler; `fs_packed`: a manual bilinear over the engine's packed canvas), outside it
  writes the letterbox colour. Then `present()`, then it waits for that submission so the timing it reports is
  real.
- **The hole.** `nativePreview.ts` sets `<html data-native-preview>`; one unlayered rule in `app/src/styles.css`
  clears the background of the four elements marked `data-preview-hole` (the Edit layout's panel group,
  `PreviewPane`'s root, `Player`'s root and its surface container); the shell root goes transparent through the
  existing `wgpuSurfaceActive` (B-006). The `<img>` is hidden (`visibility`) but keeps its layout, because today its
  transformed box *is* the picture box the overlays use. Every overlay still renders and still takes the pointer.
- **Following the layout.** The hook reads the surface element's and the picture's `getBoundingClientRect` once
  per animation frame and calls `chroma_preview_surface_place` only when either changed (one call in flight), so a
  panel resize, an Inspector toggle, a zoom or pan, a tab switch (the rect goes to 0 → hidden) all follow.
- **Sources (prototype only).** `pattern` (a compute pass drawing bars, a bar that moves one step per frame and the
  frame number in binary into an `Rgba8Unorm` texture), `pattern-packed` (the same into a buffer shaped exactly
  like `apelles-compositor`'s canvas), and `timeline` (today's `timeline_frame_image` uploaded with
  `write_texture`, to show real frames under the real layout).
- **Driving it.** Debug ops over the control bridge: `debug_native_preview {source, color}`,
  `debug_native_preview_play {playing, from, fps}` (a Rust thread draws the position its clock is at and presents
  it), `debug_native_preview_stats {reset}`. A playhead move while it is on (scrub, seek, step) is shown on the
  surface through `chroma_preview_surface_show`, latest-wins. No pixels cross IPC in either direction.

## 5. Measurements on the live app

Same bundle, project and machine as §1 (a scratch project from generated `testsrc2` / `mandelbrot` media; nothing
of the owner's touched). The display ran at 60 Hz. Raw scripts: `scratch/` of the session (not committed).

**Throughput and pacing (GPU test pattern, no CPU in the frame path):**

| source | asked | presented | dropped | present interval p50 / p95 | hand-over → `present()` p50 / p95 | hand-over → GPU done p50 |
|---|---|---|---|---|---|---|
| `pattern` (texture) | 60 fps | 60.0 fps | 0 | 16.66 / 17.3 ms | 0.31–0.42 / 0.6–0.8 ms | 1.9–5.0 ms |
| `pattern-packed` (engine-shaped buffer) | 60 fps | 60.0 fps | 0–1 | 16.68 / 17.4 ms | 0.37–0.55 / 0.6–0.8 ms | 1.9–9.6 ms |
| `pattern` | 240 fps | 59.95 fps | (by design) | 16.65 / 17.2 ms | — | — |

- Asked for 240 fps, it presents at the display's 60: `get_current_texture` blocks ~14.4 ms (p50) for a drawable.
  The surface is paced by the display (`Fifo`, `displaySyncEnabled`), not by a timer.
- The texture and packed-buffer seams cost the same within the noise; the GPU-done spread (2–10 ms for a pass
  that is ~0.3 ms of work) follows the other agents' GPU load on the shared machine, and is the same for both.
- **Frame-to-screen latency.** Measured: hand-over → `present()` 0.2–0.5 ms; → the GPU having finished the pass
  ~2 ms on a quiet GPU. Not measurable here: the moment the window server composites it (no Screen Recording
  permission in an agent session, and wgpu 29 keeps the `MTLDrawable` private, so `addPresentedHandler` /
  `presentedTime` cannot be read). By Core Animation's model that is the next composite, ≤ 1 refresh (16.7 ms at
  60 Hz), so hand-over to glass is ~3–19 ms, against today's `<img>` path, which adds JPEG encode, IPC, a JPEG
  decode and upload in WebContent, and WebKit's own layer commit before that same composite.
- **One measured caveat:** in one run the producer's clock ran ahead of the display and every drawable was
  queued; hand-over → `present()` rose to 10.9 ms (acquire 10.6 ms). With frame latency 2 a free-running producer
  can wait up to two refreshes. The real player must be clocked by the display (a `CADisplayLink` / the drawable
  becoming free), not by its own timer; the prototype's `play` loop is a timer and is not the shape to copy.

**Real frames (the `timeline` source: today's decode + composite, uploaded):**

| | presented | render (decode + composite) | upload | hand-over → `present()` |
|---|---|---|---|---|
| quiet (load ~15), 30 fps timeline | 30.07 / 30.12 fps (4 dropped at start) | 10.5–16.8 ms | 0.4–0.5 ms (3.5 MB) | 0.19–0.20 ms |
| loaded (load 40–55) | 11.7–14.3 fps | 49–68 ms | 1.2–1.7 ms | 0.44–0.49 ms |

The `<img>` path measured 30.0 fps (quiet) and 11.6–21.9 fps (loaded) in the same sessions: with a CPU
compositor both are bound by decode + composite, and the surface removes the JPEG, the IPC payload and the
WebContent decode from every frame. The upload in this row is the prototype's stand-in for the engine; with the
engine on the presenter's device it is 0.

**Scrubbing:** 60 playhead moves at 60 Hz through `editor_set_playhead` (the same store write a drag makes):
with the `pattern` source **60 of 60** reached the surface, the last one exact. With the `timeline` source 6 of 60
did, because every jump of 7 frames made the decode pipe re-seek (265 ms a frame, B-088's known cost, the same on
the `<img>` path); the surface adds nothing to that.

**CPU while playing** (`top`, the app process / its WebContent process): `<img>` path at 30 fps 52.5% / 33.2%;
native surface with the GPU pattern at **60** fps 18.1% / **4.8%**. Most of the app's 18% is the prototype's own
play loop (a 0.5 ms polling clock and a blocking wait for the GPU per frame), not the presenter.

**Layout following** (AppKit's frame of the native view, read back with `convertRect:toView:`, against the
transparent region of a WKWebView snapshot, in CSS px):

| step | native view (x0, y0, x1, y1) | hole in the webview | drawable |
|---|---|---|---|
| initial | 281, 66, 959, 386 | 281, 66, 959, 385.5 | 1356×640 |
| Inspector closed | 281, 66, 1280, 386 | 281, 66, 1265*, 385.5 | 1998×640 |
| Inspector re-opened | 281, 66, 959, 386 | 281, 66, 959, 385.5 | 1356×640 |
| preview zoom 200% / fit | unchanged (the view is the surface; the picture box moves) | unchanged | 1356×640 |
| Edit → Colorist tab | hidden, 0×0 | — | — |
| back to Edit | 281, 66, 959, 386, shown | 281, 66, 959, 385.5 | 1356×640 |

(*the snapshot measurement ignores a 15 px margin at the window edge; ½ px at the bottom is the scrub bar's top
edge.) The view is ordered below the webview (`belowWebview: true`) and its scale is the window's (2.0). Inside
the hole, a WKWebView snapshot is transparent except for the overlays: with a clip selected, its transform box and
handles (10,180 opaque pixels of 866,484) draw over the native picture, and a native click in the hole at a point
of the V1 clip selected it (`useCanvasClipPick` through the hole).

**No per-frame read-back, by construction and by count:** the module has no `MAP_READ` buffer, no `map_async`,
no texture-to-buffer copy (`grep` over `preview_surface/`); `readbackBytes` is 0 and `uploadedBytes` is 0 for both
pattern sources; the only IPC per frame is none during `play` and a 1-number `position` during a scrub; a
placement call carries two rectangles and only when the layout changed.

## 6. Colour

The engine's frames are display-referred 8-bit R'G'B' (what `timeline_frame_image` makes and what the export
encodes as BT.709). The presenter writes them to a non-sRGB `Bgra8Unorm` drawable **unchanged** and the layer's
`colorspace` says what they mean:

- **`srgb` (the prototype's default):** what WebKit assumes for today's untagged preview JPEG, so switching the
  preview to the surface changes nothing a person can see.
- **`rec709` (`kCGColorSpaceITUR_709`):** the timeline's own tag. ColorSync decodes it with the inverse of the 709
  camera OETF, which renders shadows lighter than sRGB (the long-known QuickTime "gamma shift"). Which of the two
  the viewer should match (the exported file in QuickTime Player, or the current preview) is a product call for
  the owner, and it is one property on the layer either way.
- **`p3`:** for when the engine works in Display P3.

## 7. The integration seam (for `apelles-compositor`)

Three things, all in `app/src-tauri/src/chroma/preview_surface/`:

1. **One device.** Open the engine on the presenter's device instead of its own:
   `Engine::with_device(ctx.device.clone(), ctx.queue.clone())` with `ctx = preview_surface::gpu()?` (today
   `chroma::gpu_compositor::engine()` calls `Engine::new()`, which opens a second device from a second instance;
   a surface can only be configured with a device of its own instance, and a texture or buffer cannot be
   sampled across devices without a CPU copy). `apelles_gpu::GpuContext` now carries `instance` and `adapter`
   for exactly this. The export can keep using the same engine; nothing about it changes.
2. **Hand over the canvas, not the pixels.** The engine already records a frame into its canvas, a
   `STORAGE | COPY_SRC` buffer of `width * height` packed RGBA8 words (`Engine::record`), and then copies it to a
   `MAP_READ` staging buffer for `PendingFrame::wait`. The preview needs a third entry point beside
   `render` / `submit` that stops before the staging copy and lends the canvas out, e.g.

   ```rust
   // apelles-compositor
   pub fn draw<R>(self: &Arc<Self>, plan: &FramePlan,
                  show: impl FnOnce(&wgpu::Buffer, u32, u32) -> R) -> Result<R, ComposeError>
   ```

   which submits the frame and calls `show(canvas, w, h)` before the canvas goes back to the pool. `show` is
   the presenter:

   ```rust
   presenter.present(&PreviewFrame {
       source: FrameSource::PackedRgba8 { buffer: canvas, width: w, height: h },
       position: pos,
       handed_over: Instant::now(),
   })
   ```

   The presenter only reads the buffer, in a pass submitted on the same queue after the engine's work, so wgpu
   orders them; the canvas may go back to the pool as soon as `present` returns. If the engine prefers to end on
   a texture (an `Rgba8Unorm` with `TEXTURE_BINDING`), `FrameSource::Texture` takes that instead; both are
   measured below and cost the same.
3. **Size the plan to the drawable.** `Placement` (from the DOM, once per animation frame) gives the drawable size
   and the picture box in drawable pixels; the engine's `max_long_edge` for the preview should be the picture
   box's long edge capped at the drawable's (`Session::pattern_size` in `commands.rs` is that rule), so the pass
   samples close to 1:1 and a zoomed-in view gets more pixels rather than a magnified small frame.

**What replaces what, when the engine plugs in.** `chroma_timeline_frame` (decode → composite → JPEG → IPC) and
the `<img>` go; `chroma_preview_surface_show` / `_play` become the preview's scrub and play paths (with the play
clock driven by the audio clock, as the `<img>` loop is today), with the engine's `draw` in place of the
prototype `sources`. `PreviewPane` keeps its overlays; the hidden `<img>` that defines the picture box today is
replaced by the same box computed from the composition size and the zoom (`usePreviewContentBox`'s arithmetic,
already what the overlays use). The `debug_assertions` gate comes off the module, and `commands.rs` / `sources.rs`
are rewritten around the engine. The skimmer, the two-up trim viewer and the Colorist's framed clip preview are
other callers of `chroma_timeline_frame`-shaped paths; each needs its own decision (they can keep `<img>` until
they move).

## 8. Still risky

- **Fullscreen.** The viewer's fullscreen button calls the DOM `requestFullscreen` on the pane (D-126). WebKit's
  element fullscreen moves the web content into its own fullscreen window, which the native view is not in. Not
  tested here. The likely right shape is the window's native fullscreen plus a layout that gives the preview the
  window (what Final Cut does); it needs its own small decision when the `<img>` goes.
- **Layout lag of a frame.** A placement is measured on the animation frame after the DOM changed and applied after
  one IPC round trip plus a main-thread hop, so during a live drag-resize of a panel the picture can trail the
  hole's edge by about a frame (the letterbox colour shows in the gap). `presentsWithTransaction` (present inside
  the Core Animation transaction that moves the view) is the standard fix if the owner sees it; it costs some
  latency and must run on the committing thread, so it is for resizes only.
- **Clocking.** The prototype's play loop is a free-running timer; the product loop must be driven by the display
  and slaved to the audio clock (the `<img>` loop's job today), or it queues up to two drawables (measured above).
- **One device for everything.** Today the Colorist's `gpu_processing` opens its own instance and device, and the
  GPU branch's `gpu_compositor::engine()` opens another through `Engine::new()`. The preview needs the engine on
  `preview_surface::gpu()`'s device; long-term the Colorist should share it too (one device per process, as the
  reference editors have), which touches RapidRAW's `GpuContext`.
- **Screenshots.** `debug_screenshot` sees the hole, not the picture (the Colorist solved the same thing for its
  surface, B-151, by compositing an on-demand read-back into the snapshot). The preview needs the same debug-only
  composite when it goes live, or the agent tooling goes blind on the viewer.
- **Overlays that sit outside the hole.** The four hole elements are the ones between the window and the preview
  today. A new opaque wrapper inserted between them would cover the picture; the symptom is obvious (no picture),
  but the rule ("an element between the window and the preview carries `data-preview-hole`") has to be known.
- **Colour.** `srgb` matches today's preview; whether the viewer should instead match the exported BT.709 file is
  open (§6).
- **The machine.** All numbers come from a shared machine under heavy, varying load; the pacing and the zero-copy
  facts are robust to that, the millisecond figures are ranges for that reason.

## 9. Files (the D-451 prototype; §10.8 for the product)

- `app/src-tauri/src/chroma/preview_surface/mod.rs` — module doc, `gpu()` (the shared instance + device).
- `…/presenter.rs` — `Presenter`, `PreviewFrame`, `FrameSource`, `Placement`, the stats. Product-shaped.
- `…/blit.wgsl` — the one pass (texture and packed-buffer entry points).
- `…/native_view.rs` — the `NSView` + `CAMetalLayer`: install below the webview, place, remove. Product-shaped.
- `…/sources.rs`, `…/pattern.wgsl` — prototype sources (GPU test pattern; today's frame uploaded).
- `…/commands.rs` — the prototype's six Tauri commands.
- `crates/apelles-gpu/src/lib.rs` — `GpuContext` keeps `instance` and `adapter`.
- `packages/bridge/src/previewSurface.ts` — the typed bindings (D-447).
- `packages/editor/src/nativePreview.ts` (+ test) — the store and the placement hook; `PreviewPane`,
  `EditorTab` and `@apelles/player`'s `Player` mark their backgrounds `data-preview-hole`; `app/src/styles.css`
  holds the one rule that clears them.
- `packages/debug/src/debugOps.ts` — `debug_native_preview`, `debug_native_preview_play`,
  `debug_native_preview_stats`.

---

# 10. As built: the product preview (D-454, roadmap 00r 5c, 2026-11-04)

§1–§9 are the D-451 research and prototype, kept as written. This section is what replaced the `<img>` path,
in release builds too.

## 10.1 One device for everything

Before: three wgpu devices in one process. The Colorist's `gpu_processing::get_or_init_gpu_context` opened an
instance and device of its own for its window surface (B-006); `gpu_compositor::device()` opened a second one
(through `render_core::init_gpu_context`) for the engine and the grade pass (D-450); the D-451 prototype's
`preview_surface::gpu()` opened a third for its presenter.

Now: **one instance, adapter, device and queue**, opened by `gpu_compositor::device()`
(`apelles_gpu::init_gpu_context`), carried in `RenderDevice::gpu` (an `apelles_gpu::GpuContext`, which keeps
`instance` and `adapter`). On it:

- the engine (`apelles_compositor::Engine::with_device`) and the grade shader's `Grader` (D-450), through
  `RenderDevice::ctx` (`render_core::headless_context`);
- the Edit preview's presenter, whose `CAMetalLayer` surface is made from `RenderDevice::gpu.instance`;
- **the Colorist tab itself**: `get_or_init_gpu_context` no longer opens a device; it makes its full-window
  surface from the shared instance, configures it with the shared device, and caches an app `GpuContext` over
  them. Feasible, and done: on Apple silicon there is one Metal device, so the adapter the shared context picks
  without a `compatible_surface` is the one a surface-compatible request would pick. RapidRAW's Windows
  default (primary backends unless `WGPU_BACKEND`) moved into `apelles_gpu::init_gpu_context` with it.
- `preview_surface::gpu()` is deleted.

**After a GPU failure** (`gpu_compositor::forget_device`), the next frame opens a fresh device. A holder of a
surface notices by identity (`RenderDevice::is_current`, `Arc::ptr_eq` on the device): the preview session
rebuilds its presenter on the new device (`commands::current`), and the Colorist's cached context is rebuilt,
with its `GpuProcessor` dropped, on its next `get_or_init_gpu_context`.

## 10.2 The output API: one "frame finished on the GPU" step, three terminals

D-452 (step 1, on main) made the engine's one public output step
`Engine::submit_with(plan, terminal: FnOnce(&mut FrameOutput, &Canvas) -> Result<T>) -> (PendingGpu, T)`:
the frame is recorded into its canvas, the terminal records what happens to the finished canvas on the
**same command encoder**, and everything is submitted as one command buffer. `submit` (read-back) and
`submit_into` (an encoder's IOSurface pixel buffer, VideoToolbox) are terminals of it. **The preview is the
third**, with no change to the engine (agreed with D-452's agent through the coordinator):

```text
render_timeline_frame_deferred(…, to: &Destination)          chroma::edit (layers → FramePlan)
    └─ gpu_compositor::submit(plan, to)
         ├─ Destination::ReadBack          → engine.submit            → GpuFrame::ReadBack(PendingFrame)
         ├─ Destination::Encoder{..}       → engine.submit_into       → GpuFrame::Written(PendingGpu)   (D-452 step 2)
         └─ Destination::Present(target)   → engine.submit_with(plan, |out, canvas| target.write(out, canvas))
                                              └─ Presenter::write_frame(out.encoder(), canvas.buffer, (w, h))
                                                 = one render pass: canvas (packed RGBA8) → retained frame
                                                 → GpuFrame::Presented { _in_flight: PendingGpu }
```

`Destination` is app-side (`chroma::gpu_compositor`), threaded through `render_timeline_frame_deferred`,
`composite_video_frame` and `captions_over_black` as their last parameter (D-452 step 2's export uses the same
threading for its `Encoder { buffer, format }` arm → `engine.submit_into` → `GpuFrame::Written`). `PendingGpu` is held by the preview session until the next
frame (a refresh later, so its waiting drop does not wait) so the pooled canvas returns only after the GPU.

**The presenter retains the frame** (`presenter.rs`): the terminal unpacks the canvas into the presenter's own
`Rgba8Unorm` texture of the frame's size, 1:1 (`fs_unpack`, exact bytes), inside the engine's submission;
`Presenter::present` then draws that texture into a fresh drawable in its picture box (`fs_present`, linear) with
the letterbox around it. Two passes instead of the prototype's one, because a drawable is not preserved
between presents and three things re-present without a new frame: a playback refresh on a timeline slower
than the display, a moved or resized view, a zoom or pan. Each of those costs a ~0.1 ms blit and no engine
work. The retained frame is also what the debug screenshot reads back (§10.6).

**Sizing.** The render's long edge is the picture box's (in drawable pixels), capped at the drawable's long
edge (`Placement::render_long_edge`), rounded up to 128 px (`RENDER_EDGE_STEP`) so a panel drag changes it a
handful of times rather than on every pixel. A zoomed-in view gets more pixels, never more than the screen
shows. While paused, a size change is redrawn once the layout has held still for 150 ms
(`RERENDER_SETTLE_MS`); until then the retained frame is resampled.

## 10.3 Playback: clocked by the display, slaved to the sound

`preview_surface::player` (one thread per play; the webview no longer runs a play loop):

- **The clock tick is the drawable.** `Fifo` with frame latency 1 (Core Animation holds two drawables: one on
  screen, at most one queued). `get_current_texture` returns only when the display has taken the previous
  drawable, so the loop runs once per refresh with no timer, and **never more than one drawable is queued**.
  A frame drawn right after a present is presented on the next drawable and shown one refresh after that, so
  each turn asks the clock for the time at `last acquire + 2 refreshes` (the refresh is measured from
  acquire-to-acquire intervals).
- **The clock is the audio's.** `apelles_media::audio_clock` (new): the output device's callback reports, per
  buffer, how many of its samples were real timeline audio and when the device plays the buffer's first sample
  (`cpal`'s `OutputStreamTimestamp::playback − callback`); the play session says which timeline time its first
  played sample is (start frame + D-125's warm-up discard). `audio_clock::position(t)` extrapolates from the
  latest buffer at the session's playback rate. With no session sounding (a silent timeline, the 150–600 ms
  warm-up, a gap the mixer is not producing) the loop uses the wall clock from Play; it never steps backwards
  (a clock that dips behind the drawn frame holds the picture rather than seeking the decoders back).
- **A refresh with no new frame re-presents** the retained frame (a 30 fps timeline on a 60 Hz display draws
  every other refresh). A frame the engine is too slow for is dropped: the next turn asks for where the
  clock is then.
- **The webview follows.** Each newly shown frame is emitted as `chroma://preview-playhead {frame, ended}`; the
  hook moves the store's playhead (so the timecode, the timeline cursor and every reader follow the picture,
  not a clock of their own) and stops the transport on `ended`. A rate change or a seek while playing restarts
  the loop from the playhead (B-326), with the audio session, as before.
- **An occluded window** gives no drawable (`Timeout` / `Occluded`): nothing is presented and the loop waits
  one refresh's worth instead of spinning. The only time it is not clocked by the display; nothing is visible
  then.

## 10.4 Colour: Rec.709 (owner, 2026-11-04)

The layer is tagged `kCGColorSpaceITUR_709`; the presenter writes the engine's bytes to a non-sRGB
`Bgra8Unorm` drawable unchanged. What that means on a Display P3 panel (every Apple-silicon MacBook):

- The window server (ColorSync) converts the layer from BT.709 to the display's profile: BT.709 primaries and
  D65 white, decoded with a **pure 2.4 power** (BT.1886 with a zero black; measured on macOS 26.2 with
  `CGColorCreateCopyByMatchingToColorSpace`, D-457 — this section first said the inverse camera OETF, which
  is wrong), then mapped into the panel's P3 primaries.
- **Gamut:** P3 contains all of BT.709, so every colour lands inside the panel's gamut unclipped, and
  saturated colours are shown as BT.709 saturated, **not** stretched to P3's wider primaries (an untagged or
  "display" picture would be).
- **Tone:** the 2.4 decoding renders shadows and mid-darks somewhat **darker** than an sRGB tag on the same
  bytes (a 709-tagged 24 shows as sRGB 11, 128 as 121). The old `<img>` preview was untagged, which WebKit
  treats as sRGB, so the new viewer is darker in the shadows than the old one, and matches what a
  ColorSync-managed player (QuickTime Player) shows for the exported file, which D-452 tags Rec.709. That
  match is the point of the owner's call.
- **The letterbox** is the pane's CSS colour (sRGB) matched into the layer's Rec.709 by ColorSync
  (`viewer_space::ViewerSpace::ui_colour`, B-398), so it shows as the panel colour around it.
- **Not** a reference monitor path: no BT.1886 / 2.4 display gamma is applied (a broadcast reference display
  would decode BT.709 with 2.4), no EDR, no HDR. Those are one property on the layer or one more pass, if
  the owner ever wants a "broadcast" viewing mode.
- **The Colorist** (D-457): its full-window surface's layer (the one wgpu made, reached through
  `Surface::as_hal`) is tagged Rec.709 while it shows a video and sRGB while it shows a still image, with its
  letterbox matched the same way, so a graded clip looks the same in both tabs and in the export.

## 10.5 The §8 risks, resolved

| Risk (§8) | Outcome |
|---|---|
| **Fullscreen** | The viewer's button now toggles the **window's native fullscreen** (`chroma_preview_surface_fullscreen`, `setPreviewFullscreen`) and the layout gives the viewer the window: `<html data-viewer-fullscreen>` makes everything in `#root` stop painting (`visibility: hidden`) except the preview pane, which goes `position: fixed; inset: 0` (`app/src/styles.css`); portals (menus, popovers) stay visible. The window's state comes back as `chroma://window-fullscreen` from the resize handler, so Esc, the green button and Ctrl-Cmd-F all leave it. DOM `requestFullscreen` is gone. Verified live (§10.7). |
| **Live panel drags** | While paused, `place` re-presents the retained frame inside the same `CATransaction` that moves the view, with `presentsWithTransaction` on (wgpu-hal reads it at each acquire and then presents after `waitUntilScheduled`, inside the transaction): the move and the picture are one commit. While playing it is off and the next refresh's present follows the new placement (≤ 1 refresh, a frame the loop draws anyway). The main thread never waits for a frame being drawn (`try_lock`). 5.4 ms p50 per move on the main thread (§10.7). |
| **Clocking** | §10.3; 60 presents a second at a 16.2 ms drawable wait, A/V within half a frame where the engine keeps up (§10.7). |
| **One device** | §10.1, including the Colorist. |
| **Screenshots** | `debug_screenshot` composites the native picture (debug builds only, B-151's pattern): `screenshot_frame` reads the retained frame back on demand, draws it at its picture box over the letterbox colour inside the native view's AppKit frame, under the webview snapshot (whose hole is transparent), so the overlays stay on top as on screen. `debug_record_video` (raw webview frames, D-330) does not composite, and says so in its tool text. |
| **Overlays outside the hole** | Unchanged rule; the shell root is now marked `data-preview-hole` too, so no store flag (B-006's `wgpuSurfaceActive`) has to be shared between the Colorist and the Edit preview. |
| **Colour** | §10.4. |

## 10.6 What was deleted

- `chroma_timeline_frame` (decode → composite → read back → JPEG → IPC), `timeline_frame`,
  `nothing_visible_jpeg`, `blank_frame_jpeg`, `black_frame_jpeg` and its memo, and the D-217 phase-breakdown
  test that measured only the deleted wire format. `encode_preview_jpeg` stays for its two remaining callers
  (the launcher thumbnail, the two-up trim viewer's source frames); `timeline_frame_image` stays for the
  thumbnail and the tests (`preview_frame_png`, test-only, reads the same render back losslessly).
- `PreviewPane`'s `<img>`, its object-URL bookkeeping, the rAF play loop, the scrub/skim fetch queue, the
  imperative `src` writes (D-290), the CSS `transform` zoom of the picture (the presenter draws into the zoomed
  box instead) and DOM fullscreen. `PreviewPane.tsx` no longer imports `@tauri-apps/*` (its audio commands are
  `@apelles/bridge`'s `audioTransport`), so it left the D-447 allowlist.
- The D-451 prototype scaffolding: `sources.rs`, `pattern.wgsl`, the `pattern` / `pattern-packed` / `timeline`
  sources, the `srgb` / `p3` colour tags, `preview_surface::gpu()`, the timer play loop, the debug ops
  `debug_native_preview` and `debug_native_preview_play`, and `nativePreview.ts`'s debug store.
- `previewTiming`'s `fetch` / `tick` channels (they split a webview play loop that no longer exists).
- The `debug_assertions` gate on `chroma::preview_surface` (it is now `#[cfg(target_os = "macos")]`, the
  product preview). Debug-only stays debug-only: `stats.rs`, `chroma_preview_surface_stats`,
  `Presenter::read_frame` / `screenshot_frame`, and the per-present event that feeds `debug_frame_timing`'s
  `raf` channel.

## 10.7 Measured

Debug bundles `studio.apelles.perf11`, window 1470×923 on a 60 Hz built-in display, quiet machine (load
1.9–4.7), both on the same scratch project: generated `testsrc2` 3840×2160 and `mandelbrot` 1920×1080 H.264
`.mov`s with tones, three 3840×2160 30 fps timelines — `plain4k` (one 4K layer), `graded4k` (the same with the
Colorist's local-tone grade), `stacked` (a 4K base with 1080p and 4K picture-in-pictures, four layers). **Before**
= main at `4770faa9` (D-452 step 1: VideoToolbox decode, the engine, then read-back → JPEG → IPC → `<img>`);
**after** = this branch. Driver: `editor_*` ops over the control bridge, `debug_frame_timing`,
`debug_native_preview_stats`, `ps` for CPU; the UI harness for perf-300. Nothing of the owner's was opened.

**Playback** (8 s from frame 0; paint = new frames on screen, loop = the play loop's ticks; cost per frame =
before: the `chroma_timeline_frame` round trip, after: the engine's draw call on the playback thread):

| timeline | paint fps before → after | loop fps before → after | cost per frame p50 / p95 before → after | app CPU before → after |
|---|---|---|---|---|
| `plain4k` | 30.0 → 30.0 | 60.0 → 60.0 | 17 / 22 ms → 0.47 / 0.67 ms | 24.1% → 9.3–9.7% |
| `graded4k` | 23.7 → 25.2–25.4 | 60.0 → 25–29 | 40 / 49 ms → 33 / 39 ms | 23.6% → 13.4% |
| `stacked` | 29.9 → 30.0 | 60.0 → 59.8–60.0 | 23 / 35 ms → 1.1 / 1.9 ms | 29.7% → 17.5% |

- The presenter's pacing (after): presents 60.0 / s with the drawable wait at 16.2 ms p50 (the display's
  refresh) on `plain4k` and `stacked`: one drawable queued, no timer. A 30 fps timeline shows 29.8 new frames
  a second; each other refresh re-presents the retained frame.
- `graded4k` is bound by the grade pass at the source's 4K size (D-450's 25–40 ms), which runs on the playback
  thread: the loop drops to the frames it can draw (25 fps) instead of the display's 60, and the picture
  follows the sound by dropping frames, as designed. Grading at the render size, or on a thread ahead of the
  loop, is the next lever (logged).
- WebContent CPU (summed over every WebKit WebContent process on the machine, so it carries other apps'
  idle load, 0.2–7%): 27–29% before, 25–32% after. The JPEG decode left WebContent, but the playhead now moves
  once per shown frame through the store (the timecode, the timeline cursor and their readers re-render),
  which is the same per-frame React work the rAF loop did; the webview's share of playback is now that, and
  only that.

**Scrub** (paused, `editor_set_playhead` every 250 ms; the round trip from the request to the frame being
presented; `step` = +1 frame, `jump` = random positions in 20 s):

| | before p50 / p95 | after p50 / p95 |
|---|---|---|
| `plain4k` step | 25 / 43 ms | 18–19 / 20 ms |
| `plain4k` jump | 55 / 72 ms | 36–37 / 48–49 ms |
| `stacked` step | 34 / 69 ms | 19–21 / 21–36 ms |
| `stacked` jump | 92 / 111 ms | 75–88 / 94–115 ms |

Every request lands on its exact frame (`show(position)` draws that position; the queue is latest-wins, so a
fast drag skips the positions it has passed, never shows a wrong one). A jump is bound by the decoder's seek to
the sync sample before it (VideoToolbox, D-452).

**A/V sync** (after; before had none to measure — two open-loop clocks started together, D-050): for each
shown frame, the frame's midpoint time minus the audio clock's position at the instant the frame is predicted
to reach the glass. `plain4k` +6 to +10 ms (p95 |offset| 6.5–10 ms), `stacked` +4 to +11 ms (p95 4.4–11.6 ms),
`graded4k` −3 to −6 ms signed, |offset| p50 8–10 / p95 21–28 ms (the dropped frames). At 30 fps a frame spans
±16.7 ms around its midpoint, so on the two timelines that keep up every shown frame contains the moment
being heard; broadcast tolerance is about +45 / −125 ms.

**perf-300** (UI harness, 300 clips, same bundle pair): 12/12 pass both. Playback paint 29.48 → 29.84 fps,
loop 60.01 → 59.55 (since D-454 the loop is the display-clocked present, capped at the display's 60 Hz; the
floor's "≥ 60" is the display rate). Drag p95 19–21 → 19–23 ms (floor ≤ 30). `commitFrameMs` 23–34 → 17–35 ms
and release frames 29–48 → 26–49 ms, in a debug build both ways (the production floors are measured in a
production bundle; the before/after pair moved within the run-to-run spread). The four over-budget pinch /
wheel steps are the same pre-existing ones (B-375) before and after.

**Live panel moves** (paused, the Inspector toggled four times): 8 placements, each re-presented inside the
move's own Core Animation transaction, 5.4 ms p50 / 9.4 ms max on the main thread; no frame the engine had to
redraw (the picture box was height-bound). On glass it could not be filmed (no Screen Recording in an agent
session); by Core Animation's model the move and the picture are one commit.

**Fullscreen**: the viewer's button took the window to native fullscreen (1470×956, the whole display) with the
viewer filling it, header and transport kept (`debug_screenshot` with the native picture composited); Esc
left it and restored the layout.

**A defect found by this measurement and fixed before commit**: on the second play in a session the presents
ran unpaced (1,400–4,500 a second, drawable wait 0.1 ms, app CPU ~125%). Cause: `chroma_preview_surface_play`
toggled the layer's `presentsWithTransaction` per play, and a Pause and the next Play run as independent tasks,
so the Pause's "on" could land after the Play's "off"; a transactional present from the playback thread is not
paced by the display. Fixed by scoping `presentsWithTransaction` to `place`'s own present (on for its
`within`, off before the commit), by a monotonic `seq` on play requests (the D-130 pattern: an overtaken request
is dropped), and by a guard that never presents to a hidden layer (whose drawables also come back at once).
The repeated runs above are after the fix.

## 10.8 Files

- `app/src-tauri/src/chroma/gpu_compositor.rs` — the one device (`RenderDevice::gpu`, `is_current`),
  `Destination`, `GpuFrame`.
- `app/src-tauri/src/gpu_processing.rs` — the Colorist's context on the shared device and instance.
- `app/src-tauri/src/render_core.rs` — `headless_context`.
- `crates/apelles-gpu/src/lib.rs` — the Windows backend default (moved).
- `app/src-tauri/src/chroma/preview_surface/` — `presenter.rs` (`Presenter`, `PresentTarget`, `Placement`),
  `blit.wgsl` (`fs_unpack`, `fs_present`), `player.rs` (the loop), `native_view.rs` (Rec.709, transactional
  place with `presentsWithTransaction` for its own present only), `commands.rs` (the seven commands, `screenshot_frame`), `stats.rs` (debug).
- `app/src-tauri/src/chroma/edit.rs` — `draw_preview_frame`, `nothing_visible_canvas`, `to: &Destination`.
- `crates/apelles-media/src/audio_clock.rs` (new) and `audio.rs` (the callback's report, `ClockSession`).
- `app/src-tauri/src/chroma/debug_capture.rs` — `composite_edit_preview`.
- `packages/bridge/src/previewSurface.ts`, `audioTransport.ts`; `packages/editor/src/nativePreview.ts`
  (`useNativePreview`, `createShowQueue`, `pictureRect`), `PreviewPane.tsx`, `previewTiming.ts`,
  `testUtils/eventBus.ts`; `packages/shell/src/Shell.tsx`; `app/src/styles.css`.
