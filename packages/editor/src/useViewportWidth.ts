/**
 * @apelles/editor — the timeline viewport's width.
 *
 * **What it is.** `useViewportWidth(el)` tracks `el.clientWidth` with a
 * `ResizeObserver` (a panel drag resizes it without any React state changing,
 * D-128) and returns it in px: 0 while the element is hidden or unmounted.
 *
 * **Hidden-tab start (B-267).** Inactive tabs stay MOUNTED under `display: none`
 * (`Shell.tsx`), so after an app restart the Edit tab's timeline is laid out
 * hidden and measures 0. The observer fires when it is shown and the width
 * becomes real; the lanes treat width 0 as "no culling" (`lanes/laneWindow.ts`),
 * so they draw everything until then. (Until D-437 S5 this hook also returned a
 * re-measure epoch, used to remount the timeline library's virtualised grid,
 * whose `AutoSizer` was never told the size had changed; the lanes have no such
 * grid, so the epoch is gone.)
 */

import { useEffect, useState } from 'react';

export function useViewportWidth(el: HTMLElement | null): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);

  return width;
}
