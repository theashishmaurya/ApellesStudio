/**
 * @apelles/editor — the timeline playhead (D-437 S3b; spec `docs/notes/ui-redesign.md`
 * §4.6, plan `docs/notes/timeline-lanes.md` §2.6).
 *
 * What it is: our own playhead, replacing the one `@xzdarcy/react-timeline-editor`
 * drew. A 1 px `--color-playhead` line from the ruler's bottom edge to the bottom
 * of the edit area, a Phosphor `CaretDown` head in the ruler, and a grab band
 * under the ruler. It is pinned in edit-area coordinates (not inside the scroller)
 * and positioned ONLY by `transform: translate3d(x, 0, 0)` on one element with
 * `will-change: transform`, so it is its own compositing layer: playback,
 * scrubbing and stepping never repaint the lanes.
 *
 * Driven imperatively, never by React state: the pane calls `handle.setFrame(frame)`
 * from its raw store subscription (D-325 — the pane must not subscribe to
 * `playhead`) and `handle.setScroll(left)` from the scroller's scroll listener.
 * Zoom (`pxPerSec`, `fps`) arrives as props, which is a render per zoom step, not
 * per frame. Nothing here renders when the frame or the scroll moves.
 *
 * Pointer: the line is `pointer-events: none`; ONLY the head and the band take the
 * pointer (B-346, B-349 — a press on a clip the playhead sits over must reach the
 * clip). A press on either starts a scrub with pointer capture: `onScrubStart`,
 * `onScrub` per snapped frame change, `onScrubEnd` on release, `pointercancel`,
 * lost capture and unmount (the same begin/update/end the ruler's drag drives, so
 * scrub audio behaves identically). Near either edge of the scroller the scrub
 * autoscrolls it (`playheadAutoscroll.ts`).
 *
 * What it does NOT do: own the playhead value (the editor store does), seek on its
 * own, snap (the caller's `snapFrame` does), or scroll anything except the scroller
 * it is given, and only while a scrub is in progress.
 */
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from 'react';
import { CaretDownIcon } from '@phosphor-icons/react';
import { timecode } from '../editGesture';
import { TIMELINE_TEST_IDS } from '../timelineTestIds';
import { edgeScrollSpeed } from './playheadAutoscroll';

/** The grab band's width, px (B-346's size). */
const BAND_WIDTH_PX = 16;
/** The head glyph's size, px. */
const HEAD_SIZE_PX = 12;

/** What the pane drives. */
export interface PlayheadHandle {
  /** Move the line to this timeline frame. Writes `transform` only. */
  setFrame: (frame: number) => void;
  /** The scroller's `scrollLeft`. Writes `transform` only. */
  setScroll: (scrollLeft: number) => void;
}

export interface PlayheadProps {
  ref?: Ref<PlayheadHandle>;
  fps: number;
  pxPerSec: number;
  /** px before frame 0 in the scroller's content (`START_LEFT_PX`). */
  startLeftPx: number;
  /** The ruler's height: the line starts here, the head sits above it. */
  rulerHeightPx: number;
  /** The grab band's height under the ruler (the marker strip's). */
  bandHeightPx: number;
  /** Timeline length in frames, for the slider's `aria-valuemax`. */
  durationFrames: number;
  /** The scroller, for the live `scrollLeft` and its edges while scrubbing. */
  getScroller: () => HTMLElement | null;
  /** The frame under the pointer, after any snapping (beats). */
  snapFrame: (frame: number) => number;
  onScrubStart: (frame: number) => void;
  onScrub: (frame: number) => void;
  onScrubEnd: () => void;
}

/** x of a frame in the playhead's own (edit-area) space, rounded to the device pixel. */
export function playheadX(
  frame: number,
  scrollLeft: number,
  fps: number,
  pxPerSec: number,
  startLeftPx: number,
  devicePixelRatio: number,
): number {
  const x = startLeftPx + (frame / fps) * pxPerSec - scrollLeft;
  const dpr = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.round(x * dpr) / dpr;
}

interface Scrub {
  pointerId: number;
  /** The element holding pointer capture. */
  el: HTMLElement;
  clientX: number;
  frame: number;
  raf: number | null;
}

/** End the scrub in `scrubRef`, if any: stop its autoscroll loop, release the pointer, and
 *  tell the caller. Idempotent. */
function endScrubOf(scrubRef: { current: Scrub | null }, onScrubEnd: () => void): void {
  const s = scrubRef.current;
  if (!s) return;
  scrubRef.current = null;
  if (s.raf !== null) cancelAnimationFrame(s.raf);
  s.raf = null;
  if (s.el.hasPointerCapture?.(s.pointerId)) s.el.releasePointerCapture(s.pointerId);
  onScrubEnd();
}

export function Playhead({
  ref,
  fps,
  pxPerSec,
  startLeftPx,
  rulerHeightPx,
  bandHeightPx,
  durationFrames,
  getScroller,
  snapFrame,
  onScrubStart,
  onScrub,
  onScrubEnd,
}: PlayheadProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  /** The imperatively driven position; React never renders from it. */
  const posRef = useRef({ frame: 0, scrollLeft: 0 });
  /** Zoom and the callbacks, readable from handlers bound once. Written in an effect. */
  const latestRef = useRef({ fps, pxPerSec, startLeftPx, snapFrame, getScroller, onScrubStart, onScrub, onScrubEnd });
  const scrubRef = useRef<Scrub | null>(null);

  const place = () => {
    const line = lineRef.current;
    if (!line) return;
    const { frame, scrollLeft } = posRef.current;
    const l = latestRef.current;
    const x = playheadX(frame, scrollLeft, l.fps, l.pxPerSec, l.startLeftPx, window.devicePixelRatio);
    line.style.transform = `translate3d(${x}px, 0, 0)`;
    headRef.current?.setAttribute('aria-valuetext', timecode(frame, l.fps));
    headRef.current?.setAttribute('aria-valuenow', String(Math.round(frame)));
  };

  // Zoom (and the callbacks) land in a layout effect: the line is re-placed in the
  // same commit as the new `pxPerSec`, before paint.
  useLayoutEffect(() => {
    latestRef.current = { fps, pxPerSec, startLeftPx, snapFrame, getScroller, onScrubStart, onScrub, onScrubEnd };
    place();
  });

  // No dependency array: `place` only reads refs, so re-creating the handle on a
  // commit costs nothing and can never go stale.
  useImperativeHandle(ref, () => ({
    setFrame(frame) {
      posRef.current.frame = frame;
      place();
    },
    setScroll(scrollLeft) {
      posRef.current.scrollLeft = scrollLeft;
      place();
    },
  }));

  /** The snapped frame under a client x, from the live scroll position. */
  const frameAt = (clientX: number): number => {
    const l = latestRef.current;
    const root = rootRef.current;
    if (!root) return posRef.current.frame;
    const scroller = l.getScroller();
    const scrollLeft = scroller ? scroller.scrollLeft : posRef.current.scrollLeft;
    const contentX = clientX - root.getBoundingClientRect().left + scrollLeft - l.startLeftPx;
    return l.snapFrame(Math.max(0, Math.round((contentX / l.pxPerSec) * l.fps)));
  };

  const report = (s: Scrub) => {
    const f = frameAt(s.clientX);
    if (f === s.frame) return;
    s.frame = f;
    latestRef.current.onScrub(f);
  };

  /** One autoscroll step; reschedules itself while the pointer stays in an edge zone. */
  const autoscrollStep = (s: Scrub) => {
    s.raf = null;
    if (scrubRef.current !== s) return;
    const scroller = latestRef.current.getScroller();
    if (!scroller) return;
    const rect = scroller.getBoundingClientRect();
    const speed = edgeScrollSpeed(s.clientX, rect.left, rect.right);
    if (speed === 0) return;
    scroller.scrollLeft += speed;
    report(s);
    s.raf = requestAnimationFrame(() => autoscrollStep(s));
  };

  const finish = () => endScrubOf(scrubRef, latestRef.current.onScrubEnd);

  // A scrub must not outlive the component (an unmount mid-drag). The cleanup uses
  // module-level code and refs only, so it never goes stale and never re-runs.
  useEffect(() => {
    const scrub = scrubRef;
    const latest = latestRef;
    return () => endScrubOf(scrub, latest.current.onScrubEnd);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || scrubRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const frame = frameAt(e.clientX);
    scrubRef.current = { pointerId: e.pointerId, el: e.currentTarget, clientX: e.clientX, frame, raf: null };
    latestRef.current.onScrubStart(frame);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = scrubRef.current;
    if (!s || e.pointerId !== s.pointerId) return;
    s.clientX = e.clientX;
    report(s);
    if (s.raf === null) s.raf = requestAnimationFrame(() => autoscrollStep(s));
  };

  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (scrubRef.current && e.pointerId === scrubRef.current.pointerId) finish();
  };

  const grab = {
    onPointerDown,
    onPointerMove,
    onPointerUp: onPointerEnd,
    onPointerCancel: onPointerEnd,
    onLostPointerCapture: onPointerEnd,
  };

  return (
    <div
      ref={rootRef}
      data-chroma-playhead-root=""
      className="absolute inset-0 z-(--z-timeline-playhead) overflow-hidden"
      style={{ pointerEvents: 'none' }}
    >
      <div
        ref={lineRef}
        data-testid={TIMELINE_TEST_IDS.playhead}
        data-chroma-playhead=""
        className="absolute bottom-0 left-0 w-px bg-(--color-playhead)"
        style={{ top: rulerHeightPx, willChange: 'transform', pointerEvents: 'none' }}
      >
        <div
          ref={headRef}
          data-testid={TIMELINE_TEST_IDS.playheadHead}
          data-chroma-playhead=""
          data-chroma-no-marquee=""
          role="slider"
          aria-label="Playhead"
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={durationFrames}
          className="absolute flex cursor-ew-resize items-center justify-center text-(--color-playhead)"
          style={{ pointerEvents: 'auto', top: -rulerHeightPx, left: -BAND_WIDTH_PX / 2, width: BAND_WIDTH_PX, height: rulerHeightPx }}
          {...grab}
        >
          <CaretDownIcon weight="fill" size={HEAD_SIZE_PX} aria-hidden />
        </div>
        <div
          data-testid={TIMELINE_TEST_IDS.playheadBand}
          data-chroma-playhead=""
          data-chroma-no-marquee=""
          className="absolute top-0 cursor-ew-resize"
          style={{ pointerEvents: 'auto', left: -BAND_WIDTH_PX / 2, width: BAND_WIDTH_PX, height: bandHeightPx }}
          {...grab}
        />
      </div>
    </div>
  );
}
