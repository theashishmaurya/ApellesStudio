/**
 * `@chroma/player` — the letterbox math for an `object-contain` surface: the
 * on-screen rect a picture of `size` actually occupies inside its container,
 * once the browser has centred and scaled it to fit. Extracted (not
 * reimplemented) from `app/src/hooks/useImageRenderSize.ts` (D-046's own
 * on-canvas overlay math) so a tab built on `@chroma/player` — whose
 * `surface` may be anything, per this package's own contract — can place
 * DOM/SVG markers over its `<img>`/`<canvas>` without reaching into `app/`
 * (D-039's one-way dependency rule forbids `packages/editor` importing from
 * `app/`). First real consumer: `@chroma/editor`'s `TransformOverlay.tsx`
 * (D-136, Phase 1 of `docs/notes/on-canvas-transform.md`).
 *
 * `app/src/hooks/useImageRenderSize.ts` itself is left in place, still
 * owning every Colorist-tab call site (`ImageCanvas.tsx`,
 * `RelightPuckLayer.tsx`, `AgentRoiHighlight.tsx`, `Editor.tsx`,
 * `useEditorStore.ts`, `maskUtils.ts`) — migrating those onto this hook is a
 * real, separate refactor with its own risk and no behavioural need driving
 * it tonight, out of scope for landing the Edit tab's on-canvas transform
 * overlay. This is the shared math a NEW call site should use; it is not
 * (yet) the only copy, and that divergence is deliberate, not an oversight.
 *
 * **Takes the ELEMENT, not a `RefObject` (2026-09-07, B-085 follow-up).**
 * This used to take `React.RefObject<HTMLElement | null>` and read
 * `.current` inside its layout effect. A ref object never notifies anyone
 * when it is populated, and the effect only re-runs when `size` changes — so
 * if the container was not mounted at the moment the size became known, the
 * hook stored a 0×0 box and there was nothing left to make it measure again,
 * ever. That is not a hypothetical ordering: `PreviewPane` renders the
 * container only once the first `chroma_timeline_frame` has decoded
 * (hundreds of ms of real ffmpeg), while `chroma_timeline_composition_size`
 * answers in milliseconds, so in the shipped app the size ALWAYS arrived
 * first — and `useCanvasClipPick`'s content box was permanently 0×0, which
 * is why clicking the preview canvas did nothing in the real WKWebView
 * window while passing every stub-backed test (where both commands resolve
 * in one flush). Taking the element is React's own answer to "measure a node
 * that may mount later": the caller holds it in state via a callback ref, so
 * the node appearing is a real render, and this effect re-runs with it.
 */
import { useLayoutEffect, useState } from 'react';

export interface ContentSize {
  width: number;
  height: number;
}

/** The on-screen rect an `object-contain` picture of `size` occupies inside
 *  its container — offset + dimensions, in the container's own local pixel
 *  space (relative to the container's own top-left, not the viewport). */
export interface ContentBox {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

const EMPTY_BOX: ContentBox = { offsetX: 0, offsetY: 0, width: 0, height: 0 };

/** `container` must fill the space the `object-contain` picture is centred
 *  within (this is exactly the assumption `PreviewPane.tsx`'s wrapper div and
 *  `<img className="object-contain">` already satisfy). Pass it as an
 *  ELEMENT held in state (`const [el, setEl] = useState<HTMLDivElement |
 *  null>(null)`, used as `ref={setEl}`), not as a ref object — see this
 *  module's own note on why. `null` while it isn't mounted yet.
 *
 *  `size` is the picture's own natural aspect ratio source — pass `null`
 *  while it isn't known yet (nothing has loaded), which reports the empty
 *  box rather than a stale/guessed one. */
export function useContentBox(container: HTMLElement | null, size: ContentSize | null): ContentBox {
  const [box, setBox] = useState<ContentBox>(EMPTY_BOX);
  const w = size?.width;
  const h = size?.height;

  useLayoutEffect(() => {
    if (!container || !w || !h) {
      setBox(EMPTY_BOX);
      return;
    }

    const update = () => {
      const { clientWidth: cw, clientHeight: ch } = container;
      if (!cw || !ch) return;
      const contentAspect = w / h;
      const containerAspect = cw / ch;

      let width: number;
      let height: number;
      if (contentAspect > containerAspect) {
        width = cw;
        height = cw / contentAspect;
      } else {
        height = ch;
        width = ch * contentAspect;
      }

      setBox({ width, height, offsetX: (cw - width) / 2, offsetY: (ch - height) / 2 });
    };

    update();
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [container, w, h]);

  return box;
}
