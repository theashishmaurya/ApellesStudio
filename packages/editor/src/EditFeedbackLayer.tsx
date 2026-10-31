/**
 * @apelles/editor — the edit-gesture feedback layer (D-432 P2,
 * `docs/notes/ui-redesign.md` §4.4 and §5.1).
 *
 * What it is: the few overlay elements every edit gesture on the timeline
 * shares, ONE set per pane, positioned imperatively:
 *   - up to two trim BRACKETS (`[` on a clip's head, `]` on its tail) in
 *     `--color-selection`, red (`--color-destructive`) at a media limit —
 *     drawn with borders on one element each, never an icon (spec §4.4);
 *   - the delta READOUT pill, pinned 8 px above the moving edge (not following
 *     the pointer, so it does not jitter), clamped inside the viewport;
 *   - the SNAP GUIDE, a 1 px `--color-selection` line through the ruler and
 *     every lane;
 *   - the BLADE line, the cut the Blade tool would make under the pointer.
 *
 * What it does NOT do: decide anything. `useEditGesture.ts` computes every
 * position and string; this only writes them. No React state: a gesture's
 * per-pointermove updates are `transform` / `hidden` / `textContent` writes on
 * nodes that already exist, so a drag never re-renders the pane (spec §5.1
 * perf: "the pane's React tree renders exactly twice per gesture").
 */

import { forwardRef, useImperativeHandle, useRef } from 'react';

import { TIMELINE_TEST_IDS } from './timelineTestIds';

/** How far above the moving edge the readout sits, px (spec §5.1). */
export const READOUT_GAP_PX = 8;
/** The readout pill's height, px. */
export const READOUT_HEIGHT_PX = 20;
/** The readout pill's horizontal padding, both sides together (`px-1.5`), px. */
const READOUT_PADDING_PX = 12;
/** Glyphs in the probe used to measure one monospace advance. */
const PROBE_GLYPHS = 10;

export interface BracketPlacement {
  /** the edge's x in edit-area px */
  x: number;
  top: number;
  height: number;
  side: 'in' | 'out';
  limit: boolean;
}

export interface EditFeedbackHandle {
  /** Show these brackets (at most two; extra ones are ignored), hide the rest. */
  brackets(list: readonly BracketPlacement[]): void;
  /** The readout above edge `x`, with its row's top at `top`, kept inside a
   *  viewport `viewportWidth` px wide (0 = unmeasured, no clamp); `null` hides it. */
  readout(r: { x: number; top: number; text: string; limit: boolean; viewportWidth: number } | null): void;
  /** The snap guide at `x`; `null` hides it. */
  snapGuide(x: number | null): void;
  /** The blade cut line at `x` across one clip's row; `null` hides it. */
  blade(r: { x: number; top: number; height: number } | null): void;
  /** Measure the readout's glyph advance once (a layout read), so `readout` can
   *  size its pill from the text length with no read of its own. Call it
   *  BEFORE a gesture's first write; later calls are no-ops. */
  measure(): void;
  /** Hide everything. */
  clear(): void;
}

/** The bracket box is 9 px wide: a 3 px bar plus 6 px serifs into the clip. */
const BRACKET_WIDTH_PX = 9;

/** Borders only: a 3 px bar on the edge side, 2 px serifs top and bottom. */
const BRACKET_CLASS =
  'will-change-transform pointer-events-none absolute left-0 top-0 z-(--z-timeline-edit-feedback) border-0 border-y-2 border-selection ' +
  'data-[chroma-bracket-side=in]:border-l-[3px] data-[chroma-bracket-side=out]:border-r-[3px] ' +
  'data-[chroma-limit=true]:border-destructive';

function place(el: HTMLElement | null, x: number, y: number): void {
  if (el) el.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
}

export const EditFeedbackLayer = forwardRef<EditFeedbackHandle>(function EditFeedbackLayer(_props, ref) {
  const bracketARef = useRef<HTMLDivElement>(null);
  const bracketBRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  const snapRef = useRef<HTMLDivElement>(null);
  const bladeRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  /** One monospace glyph's advance, px; 0 = unmeasured (never under jsdom). */
  const glyphWidthRef = useRef(0);

  useImperativeHandle(ref, () => {
    const brackets = (list: readonly BracketPlacement[]) => {
      [bracketARef, bracketBRef].forEach((r, i) => {
        const el = r.current;
        if (!el) return;
        const b = list[i];
        if (!b) {
          el.hidden = true;
          return;
        }
        el.hidden = false;
        el.dataset.chromaBracketSide = b.side;
        el.dataset.chromaLimit = String(b.limit);
        el.style.height = `${b.height}px`;
        // `[` opens to the right of its edge, `]` to the left of it.
        place(el, b.side === 'in' ? b.x : b.x - BRACKET_WIDTH_PX, b.top);
      });
    };
    const readout: EditFeedbackHandle['readout'] = (r) => {
      const el = readoutRef.current;
      if (!el) return;
      if (!r) {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      if (el.textContent !== r.text) el.textContent = r.text;
      el.dataset.chromaLimit = String(r.limit);
      // Centred on the edge, then kept inside the viewport. The pill is
      // monospace, so its width is the text length times the glyph advance
      // measured once at gesture start: no layout read after the gesture's
      // style writes (B-347 F1). Unmeasured (jsdom) means no clamp.
      const glyph = glyphWidthRef.current;
      const w = r.viewportWidth > 0 && glyph > 0 ? Math.ceil(r.text.length * glyph + READOUT_PADDING_PX) : 0;
      const x = r.viewportWidth > 0 ? Math.min(Math.max(0, r.x - w / 2), Math.max(0, r.viewportWidth - w)) : r.x;
      place(el, x, Math.max(0, r.top - READOUT_HEIGHT_PX - READOUT_GAP_PX));
    };
    const snapGuide = (x: number | null) => {
      const el = snapRef.current;
      if (!el) return;
      el.hidden = x === null;
      if (x !== null) place(el, x, 0);
    };
    const blade: EditFeedbackHandle['blade'] = (r) => {
      const el = bladeRef.current;
      if (!el) return;
      el.hidden = r === null;
      if (r) {
        el.style.height = `${r.height}px`;
        place(el, r.x, r.top);
      }
    };
    return {
      brackets,
      readout,
      snapGuide,
      blade,
      measure() {
        const probe = probeRef.current;
        if (!probe || glyphWidthRef.current > 0) return;
        glyphWidthRef.current = probe.offsetWidth / PROBE_GLYPHS;
      },
      clear() {
        brackets([]);
        readout(null);
        snapGuide(null);
        blade(null);
      },
    };
    // The refs are stable; the handle never needs rebuilding.
  }, []);

  return (
    <>
      <div ref={bracketARef} hidden data-testid={TIMELINE_TEST_IDS.editBracket} className={BRACKET_CLASS} style={{ width: BRACKET_WIDTH_PX }} />
      <div ref={bracketBRef} hidden data-testid={TIMELINE_TEST_IDS.editBracket} className={BRACKET_CLASS} style={{ width: BRACKET_WIDTH_PX }} />
      <div
        ref={snapRef}
        hidden
        data-testid={TIMELINE_TEST_IDS.snapGuide}
        className="will-change-transform pointer-events-none absolute left-0 top-0 bottom-0 z-(--z-timeline-edit-feedback) w-px bg-selection"
      />
      <div
        ref={bladeRef}
        hidden
        data-testid={TIMELINE_TEST_IDS.bladeLine}
        className="will-change-transform pointer-events-none absolute left-0 top-0 z-(--z-timeline-edit-feedback) w-px bg-text-primary"
      />
      <span
        ref={probeRef}
        aria-hidden
        className="pointer-events-none invisible absolute left-0 top-0 whitespace-nowrap font-mono text-2xs tabular-nums"
      >
        {'0'.repeat(PROBE_GLYPHS)}
      </span>
      <div
        ref={readoutRef}
        hidden
        role="status"
        data-testid={TIMELINE_TEST_IDS.editReadout}
        className={
          'will-change-transform pointer-events-none absolute left-0 top-0 z-(--z-timeline-edit-feedback) flex items-center whitespace-nowrap ' +
          'rounded-sm bg-surface-raised px-1.5 font-mono text-2xs tabular-nums text-text-primary shadow-popover ' +
          'data-[chroma-limit=true]:text-destructive'
        }
        style={{ height: READOUT_HEIGHT_PX }}
      />
    </>
  );
});
