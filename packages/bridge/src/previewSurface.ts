/**
 * @apelles/bridge — the Edit preview's native GPU surface (D-451; the product
 * preview since D-454).
 *
 * What it is: the typed bindings over `chroma::preview_surface`'s commands
 * (`app/src-tauri/src/chroma/preview_surface/`): install a `CAMetalLayer` view
 * behind the transparent webview, keep it under the preview's rectangle,
 * show a position on it, play it (the loop runs in Rust, clocked by the
 * display and slaved to the audio clock), the window's native fullscreen,
 * and the two events the webview follows: each frame playback newly shows,
 * and the window entering or leaving fullscreen.
 *
 * What it does NOT do: carry pixels. A frame never crosses this seam — only a
 * rectangle, a position or a flag does — which is the point of the design
 * (`docs/notes/preview-gpu-surface.md`). `previewSurfaceStats` exists only in
 * a debug build (its command is compiled out of a release one); its only
 * caller is `@apelles/debug`.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import { safeUnlisten } from './tauriListeners';

/** A rectangle in CSS pixels of the viewport (`getBoundingClientRect`). */
export interface PreviewSurfaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreviewSurfacePlacement {
  /** The preview surface element's rectangle. */
  view: PreviewSurfaceRect;
  /** The picture's box (follows the preview zoom and pan). */
  picture: PreviewSurfaceRect;
  /** The pane's background, 0-1 RGBA. */
  background: [number, number, number, number];
  visible: boolean;
}

export interface PreviewSurfacePlaceReport {
  /** The engine's render size changed: ask for the frame again once the
   *  layout has settled (until then the frame on screen is a resample). */
  needsRender: boolean;
  /** The move and the re-present were one Core Animation commit. */
  presentedWithMove: boolean;
}

export interface PreviewSurfaceShowReport {
  position: number;
  renderMs: number;
  acquireMs: number;
}

export interface PreviewSurfacePlay {
  playing: boolean;
  /** The frame on screen when Play was pressed. */
  from: number;
  fps: number;
  /** The transport's playback rate (D-280). */
  rate: number;
  /** The timeline's length in frames. */
  end: number;
  /** A monotonic stamp: a request older than one already handled is dropped
   *  (commands do not run in issue order). */
  seq: number;
}

/** One frame playback newly put on the glass. */
export interface PreviewPlayheadEvent {
  frame: number;
  /** Playback reached the end (or stopped on an error) and is over. */
  ended: boolean;
}

export interface PreviewSurfaceSpread {
  n: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
}

/** What the presenter and the playback loop measured (debug builds only). */
export interface PreviewSurfaceStats {
  playing: boolean;
  framesShown: number;
  lastFrame: number;
  presentFps: number;
  shownFps: number;
  presentIntervalMs: PreviewSurfaceSpread;
  shownIntervalMs: PreviewSurfaceSpread;
  acquireMs: PreviewSurfaceSpread;
  presentMs: PreviewSurfaceSpread;
  drawMs: PreviewSurfaceSpread;
  placeMs: PreviewSurfaceSpread;
  /** Picture minus sound, ms, per shown frame. */
  avOffsetMs: PreviewSurfaceSpread;
  avAbsOffsetMs: PreviewSurfaceSpread;
  /** How long ago each present / newly shown frame happened, ms, oldest first. */
  presentAgesMs: number[];
  shownAgesMs: number[];
  drawable: [number, number] | null;
  reconfigures: number | null;
  format: string | null;
  /** Where AppKit has the native view, in the webview's CSS pixels. */
  view: {
    x: number;
    y: number;
    width: number;
    height: number;
    hidden: boolean;
    belowWebview: boolean;
    contentsScale: number;
  } | null;
}

/** The event carrying each newly shown frame (`player.rs`'s `PLAYHEAD_EVENT`). */
export const PREVIEW_PLAYHEAD_EVENT = 'chroma://preview-playhead';
/** Debug builds only: one per present of the playback loop (its display tick). */
export const PREVIEW_PRESENT_EVENT = 'chroma://preview-present';
/** The window entered or left its native fullscreen (`lib.rs`). */
export const WINDOW_FULLSCREEN_EVENT = 'chroma://window-fullscreen';

export function startPreviewSurface(): Promise<void> {
  return invoke('chroma_preview_surface_start');
}

export function placePreviewSurface(args: PreviewSurfacePlacement): Promise<PreviewSurfacePlaceReport> {
  return invoke('chroma_preview_surface_place', { args });
}

export function showPreviewSurfaceFrame(position: number): Promise<PreviewSurfaceShowReport> {
  return invoke('chroma_preview_surface_show', { position });
}

/** One half of the two-up trim viewer's picture: a frame of a clip's source. */
export interface PreviewSurfaceTwoUpHalf {
  sourcePath: string;
  sourceFrame: number;
}

/** Roadmap 00r 5d (c) — draw the two-up trim viewer's two source frames into
 *  the surface, in place of the timeline's frame, while a roll, slip or slide
 *  is dragged. A half with no picture is left black. */
export function showPreviewSurfaceTwoUp(
  left: PreviewSurfaceTwoUpHalf | null,
  right: PreviewSurfaceTwoUpHalf | null,
): Promise<PreviewSurfaceShowReport> {
  return invoke('chroma_preview_surface_two_up', { left, right });
}

/** The two-up gesture ended: release the trim lane's decode pipes (each one a
 *  live `ffmpeg` process). */
export function endTrimView(): Promise<void> {
  return invoke('chroma_trim_view_end');
}

export function playPreviewSurface(args: PreviewSurfacePlay): Promise<void> {
  return invoke('chroma_preview_surface_play', { args });
}

export function stopPreviewSurface(): Promise<void> {
  return invoke('chroma_preview_surface_stop');
}

export function setPreviewFullscreen(on: boolean): Promise<void> {
  return invoke('chroma_preview_surface_fullscreen', { on });
}

export function previewSurfaceStats(reset = false): Promise<PreviewSurfaceStats> {
  return invoke('chroma_preview_surface_stats', { reset });
}

/** Follow each frame playback shows; returns the unsubscribe. */
export function onPreviewPlayhead(handler: (event: PreviewPlayheadEvent) => void): () => void {
  const registration = listen<PreviewPlayheadEvent>(PREVIEW_PLAYHEAD_EVENT, (e) => handler(e.payload));
  registration.catch(() => {});
  return () => safeUnlisten(registration);
}

/** Debug builds only: follow each present of the playback loop; returns the
 *  unsubscribe. */
export function onPreviewPresent(handler: () => void): () => void {
  const registration = listen(PREVIEW_PRESENT_EVENT, () => handler());
  registration.catch(() => {});
  return () => safeUnlisten(registration);
}

/** Follow the window's native fullscreen; returns the unsubscribe. */
export function onWindowFullscreen(handler: (fullscreen: boolean) => void): () => void {
  const registration = listen<boolean>(WINDOW_FULLSCREEN_EVENT, (e) => handler(e.payload));
  registration.catch(() => {});
  return () => safeUnlisten(registration);
}
