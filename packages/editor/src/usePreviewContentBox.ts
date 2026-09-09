/**
 * @apelles/editor — the ONE content box every Edit-tab preview overlay
 * measures itself against, once the viewport zoom is applied (D-218).
 *
 * **What it is.** `@apelles/player`'s `useContentBox` (the `object-contain`
 * FIT rect of the picture inside its container) with `previewZoom.ts`'s
 * current `PreviewView` composed on top — the picture's REAL on-screen rect,
 * in the same container-local pixel space the fit box already lived in.
 *
 * **Why it exists rather than each overlay zooming its own box.** Before
 * D-218, `TransformOverlay`, `CanvasBoundary` and `useCanvasClipPick` each
 * called `useContentBox(container, size)` independently, deliberately: all
 * three derived the box from the same element and the same (width, height)
 * pair, so they agreed pixel-for-pixel **by construction** rather than by
 * being handed a value (see `CanvasBoundary`'s and `useCanvasClipPick`'s own
 * notes on that). Zoom must not weaken that property. Routing all three
 * through one hook that reads the same store field keeps exactly the same
 * guarantee — one derivation, three callers — instead of three places that
 * each have to remember to multiply.
 *
 * **What it does NOT do.** It does not touch the clip's own geometry. Every
 * consumer still maps composition fractions through this box exactly as it
 * did (`boxToScreenRect` / `screenToFraction`, `transformGeometry.ts`), and
 * every fraction it hands back or takes in means precisely what it always
 * meant. Zoom changes the pixels-per-fraction of the mapping and nothing else
 * — which is why a drag at 200% commits half the fraction delta of the same
 * screen-pixel drag at 100%, and is correct in both cases.
 */
import { useMemo } from 'react';
import { useContentBox, type ContentSize } from '@apelles/player';

import { zoomedContentBox } from './previewZoom';
import { useEditorTimelineStore } from './timelineStore';
import type { ContentBoxLike } from './transformGeometry';

/**
 * `container` and `size` are exactly `useContentBox`'s own arguments and
 * carry exactly its contract — pass the preview SURFACE element (held in
 * state via a callback ref, never a ref object: see that hook's own B-085
 * note) and the picture's natural (width, height), or `null` for either while
 * it isn't known yet.
 *
 * The `useMemo` is deliberate and safe for the React Compiler (D-201 — the
 * compiler preserves a memo whose dependencies it agrees with, and this
 * one's are all primitives read straight off the two inputs): it keeps the
 * returned object's IDENTITY stable across renders that changed neither the
 * fit box nor the view, which matters because `useCanvasClipPick` has this
 * value in a `useEffect` dependency array and re-registers a capture-phase
 * `pointerdown` listener whenever it changes — on the preview's hottest
 * surface, once per played frame.
 */
export function usePreviewContentBox(container: HTMLElement | null, size: ContentSize | null): ContentBoxLike {
  const fit = useContentBox(container, size);
  const view = useEditorTimelineStore((s) => s.previewView);
  const { offsetX, offsetY, width, height } = fit;
  const { zoom, panX, panY } = view;
  return useMemo(
    () => zoomedContentBox({ offsetX, offsetY, width, height }, { zoom, panX, panY }),
    [offsetX, offsetY, width, height, zoom, panX, panY],
  );
}
