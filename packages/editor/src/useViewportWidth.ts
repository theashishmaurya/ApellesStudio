/**
 * @apelles/editor — the timeline viewport's width, and a re-measure epoch for a
 * pane that was mounted while hidden (B-267).
 *
 * **What it is.** `useViewportWidth(el)` tracks `el.clientWidth` with a
 * `ResizeObserver` (a panel drag resizes it without any React state changing,
 * D-128) and returns `{ width, epoch }`.
 *
 * **Why `epoch` (B-267).** Inactive tabs stay MOUNTED under `display: none`
 * (`Shell.tsx`), so after an app restart the Edit tab's timeline is laid out
 * hidden: every box is 0 px. The timeline library sizes its virtualised grid
 * with react-virtualized's `AutoSizer`, which measured 0 x 0 then and, being a
 * scroll-sentinel detector, is never told when the element later gets a real
 * size. The grid keeps rendering zero rows, so the clips are not drawn although
 * the data, the ruler and the markers (which are ours) are all fine. A session
 * that had the Edit tab visible from the start never hit it, which is why it
 * looked like a regression after restarting. The epoch increments exactly once,
 * the first time an element that was measured at 0 px gets a real width; the
 * pane uses it as the library's `key`, remounting it so `AutoSizer` measures a
 * visible element. An element that was visible when first measured never bumps
 * it.
 *
 * **What it does NOT do.** Re-measure on later hide/show: a grid that already
 * had a size keeps working across tab switches.
 */

import { useEffect, useRef, useState } from 'react';

export interface ViewportWidth {
  /** `clientWidth` of the observed element; 0 while hidden or unmounted. */
  width: number;
  /** Bumps once when an element first measured at 0 px becomes visible. */
  epoch: number;
}

export function useViewportWidth(el: HTMLElement | null): ViewportWidth {
  const [width, setWidth] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const hiddenWhenFirstMeasured = useRef(false);

  useEffect(() => {
    if (!el) return;
    const initial = el.clientWidth;
    hiddenWhenFirstMeasured.current = initial === 0;
    setWidth(initial);
    const ro = new ResizeObserver(() => {
      const next = el.clientWidth;
      setWidth(next);
      if (next > 0 && hiddenWhenFirstMeasured.current) {
        hiddenWhenFirstMeasured.current = false;
        setEpoch((e) => e + 1);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);

  return { width, epoch };
}
