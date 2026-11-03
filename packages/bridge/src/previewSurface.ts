/**
 * @apelles/bridge — the Edit preview's native GPU surface (D-451).
 *
 * What it is: the typed bindings over `chroma::preview_surface`'s commands
 * (`app/src-tauri/src/chroma/preview_surface/`): install a `CAMetalLayer` view
 * behind the transparent webview, keep it under the preview's rectangle, show
 * or play frames on it, read its measurements, take it down.
 *
 * What it does NOT do: carry pixels. A frame never crosses this seam — only a
 * rectangle, a position or a play/stop flag does — which is the point of the
 * design (`docs/notes/preview-gpu-surface.md`).
 *
 * **Debug-only for now.** The Rust commands exist only in a build with debug
 * assertions on (a prototype until the GPU engine plugs in); the one caller is
 * the debug op `debug_native_preview` via `@apelles/editor`'s
 * `nativePreview.ts`, behind `APELLES_DEBUG_TOOLS`, so a production bundle
 * tree-shakes these away.
 */
import { invoke } from '@tauri-apps/api/core';

/** What feeds the surface in the prototype. */
export type PreviewSurfaceSource = 'pattern' | 'pattern-packed' | 'timeline';

/** How the layer's bytes are tagged for colour matching. */
export type PreviewSurfaceColor = 'srgb' | 'rec709' | 'p3';

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

export interface PreviewSurfaceSpread {
  n: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
}

export interface PreviewSurfaceTiming {
  acquireMs: number;
  toPresentMs: number;
  toGpuDoneMs: number;
}

export interface PreviewSurfaceShowReport {
  position: number;
  renderMs: number;
  uploadMs: number;
  timing: PreviewSurfaceTiming;
}

export interface PreviewSurfaceStats {
  presenter: {
    frames: number;
    reconfigures: number;
    lastPosition: number;
    fps: number;
    intervalMs: PreviewSurfaceSpread;
    acquireMs: PreviewSurfaceSpread;
    toPresentMs: PreviewSurfaceSpread;
    toGpuDoneMs: PreviewSurfaceSpread;
    drawable: [number, number];
    format: string;
  };
  source: PreviewSurfaceSource;
  dropped: number;
  uploadedBytes: number;
  readbackBytes: number;
  lastRenderMs: number;
  lastUploadMs: number;
  /** Where AppKit has the native view, in the webview's CSS pixels. */
  view: {
    x: number;
    y: number;
    width: number;
    height: number;
    hidden: boolean;
    belowWebview: boolean;
    contentsScale: number;
  };
}

export function startPreviewSurface(source: PreviewSurfaceSource, color?: PreviewSurfaceColor): Promise<void> {
  return invoke('chroma_preview_surface_start', { source, color: color ?? null });
}

export function placePreviewSurface(args: PreviewSurfacePlacement): Promise<void> {
  return invoke('chroma_preview_surface_place', { args });
}

export function showPreviewSurfaceFrame(position: number): Promise<PreviewSurfaceShowReport> {
  return invoke('chroma_preview_surface_show', { position });
}

export function playPreviewSurface(playing: boolean, from?: number, fps?: number): Promise<void> {
  return invoke('chroma_preview_surface_play', { playing, from: from ?? null, fps: fps ?? null });
}

export function previewSurfaceStats(reset = false): Promise<PreviewSurfaceStats> {
  return invoke('chroma_preview_surface_stats', { reset });
}

export function stopPreviewSurface(): Promise<void> {
  return invoke('chroma_preview_surface_stop');
}
