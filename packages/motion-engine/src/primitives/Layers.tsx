/**
 * Layers — a 2.5D stack of labelled cards.
 * Model architecture, the caching stack, a request lifecycle, pipeline stages.
 *
 * Lighter than Scene3D.LayerStack (which is real 3D planes) — this is CSS
 * perspective, so it composites cleanly with 2D primitives and text.
 *
 *   <Layers items={[{label:"tools"},{label:"system"},{label:"context"},{label:"your question"}]}
 *           active={2} callout="re-sent on every call" start={10} />
 *
 * `data-motion-box` (D-155, §3b of `docs/notes/motion-visual-builder-
 * research.md`) marks each card `<div>` — the outer stack container has no
 * size of its own (`left:cx/top:cy` with only absolutely-positioned
 * children), so the union of the cards is the only real bounding box.
 *
 * The callout's placement is `layoutCallout` below — a pure, unit-tested
 * function rather than an inline expression, because it is a geometry
 * decision that could (and did, B-240) put authored content outside the
 * frame with no error to notice.
 *
 * Type: every size this draws — card label, sublabel, callout — is a named
 * base times `layersTypeScale` below (B-239), so the stack's own type stays
 * proportional to the cards when the card box changes: a canvas reflow, or
 * simply a stack authored smaller.
 */
import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { useTheme } from "../ThemeContext";
import { inAt, pop } from "../lib/draw";
import { roughLine } from "../lib/rough";

/** D-182 (Phase 3 of 3, owner live: "layers are also build from
 *  composition right can we expose those compositions… see like this one
 *  overlapping i would like to drag and correct it") — `dx`/`dy` are an
 *  optional pixel offset ADDED to a card's own computed `topOffset`/`left`,
 *  defaulting to `0,0` so every existing manifest (none of which set these —
 *  the field didn't exist before this pass) renders byte-for-byte
 *  identically. Lets one card be nudged to fix a visual overlap without
 *  touching the shared `cardW`/`cardH`/`gap`/`tilt` every OTHER card still
 *  computes from. */
export type LayerItem = { label: string; sublabel?: string; dx?: number; dy?: number };

/** The card box this primitive's type sizes were authored against — its own
 *  default `cardW`/`cardH`. `layersTypeScale` is exactly 1 here, so a stack
 *  drawn at the default card renders byte-for-byte as it did before B-239.
 *  `gap`, `tilt` and the item COUNT are deliberately not part of it: they
 *  move the stack's total height, not the box a label has to sit in. */
export const LAYERS_BASE_CARD_WIDTH = 620;
export const LAYERS_BASE_CARD_HEIGHT = 110;

/** The two type roles a card itself draws, at the base card. Named for the
 *  same reason the `plot` ones are: they are a deliberate hierarchy (the
 *  label reads first, the sublabel is support), not two incidental literals.
 */
export const LAYERS_LABEL_FONT_SIZE = 40;
export const LAYERS_SUBLABEL_FONT_SIZE = 24;

/** The callout's own type size. Exported because the placement below derives
 *  its width estimate from it, and the two must never drift apart. */
export const CALLOUT_FONT_SIZE = 34;

/** The stack's own CSS perspective, px. `activeLift` derives its bound from it. */
export const LAYERS_PERSPECTIVE = 1400;
/** The most the lit card is allowed to rise toward the camera, px. */
export const LAYERS_MAX_LIFT = 90;
/** Frames the lit card takes to rise. */
export const LAYERS_LIFT_FRAMES = 8;

/**
 * B-260 — how far (px of `translateZ`) the lit card rises, `framesSinceLit`
 * frames after it became the active one.
 *
 * Under perspective `P`, a card raised by `z` renders `P / (P - z)` times its
 * size, so its top and bottom each grow by `cardH * (k - 1) / 2`. The lift is
 * capped so that growth stays inside the gap to its neighbours (90% of it),
 * which is what keeps a lit card from sliding over the card above — the old
 * fixed 90 px lift grew a 104 px card past a 22 px gap. It eases out-cubic over
 * `LAYERS_LIFT_FRAMES` instead of snapping.
 */
export function activeLift(framesSinceLit: number, cardH: number, gap: number): number {
  const kMax = 1 + (2 * gap * 0.9) / cardH;
  const zFit = LAYERS_PERSPECTIVE * (1 - 1 / kMax);
  const zMax = Math.max(0, Math.min(LAYERS_MAX_LIFT, zFit));
  const t = Math.min(1, Math.max(0, framesSinceLit / LAYERS_LIFT_FRAMES));
  return zMax * (1 - Math.pow(1 - t, 3));
}

/** Below this a label stops being readable at all — the same legibility
 *  floor, and the same reasoning, as `Plot.tsx`'s `PLOT_TYPE_MIN_FONT_SIZE`
 *  and `Graph.tsx`'s `GRAPH_LABEL_MIN_FONT_SIZE`. */
export const LAYERS_TYPE_MIN_FONT_SIZE = 14;
/** Expressed against the SMALLEST role, so the floor bites on the first
 *  thing that would become illegible rather than on an average. */
const LAYERS_TYPE_MIN_SCALE = LAYERS_TYPE_MIN_FONT_SIZE / LAYERS_SUBLABEL_FONT_SIZE;

/**
 * B-239 — the multiplier every type size in this primitive is drawn at,
 * derived from the stack's OWN card box.
 *
 * **The bug.** The card label (40) and sublabel (24) were bare literals in
 * the JSX and the callout (34) a bare constant. D-347's canvas reflow scales
 * a `layers` layer's `cardW` by `sx` and `cardH` by `sy` (`propCatalog.ts`'s
 * `sizeFields('layers')`), its `gap` by `su`, and an authored `text` layer's
 * `size` too (`manifestReflow.ts`'s `EXTRA_FIELDS`) — but it has no way to
 * reach type baked inside a primitive's render. So on c038's 1920×1080 →
 * 1252×1016 reshape the cards lost 35% of their width while their own labels
 * stayed at 40 px and the authored captions around them reflowed down to
 * 22–23 px: the type hierarchy inverted, supporting captions rendering
 * SMALLER than a card's label, with nothing overflowing or erroring to flag
 * it.
 *
 * **Why the card box and not the canvas or the whole stack.** The question
 * this type has to answer is "does it fit in, and read against, THIS card" —
 * a stack hand-authored small on a full-size canvas has exactly the same
 * problem as a reflowed one, and solving it from the box solves both with
 * nothing to keep in sync (the same call `Plot.tsx`'s `plotTypeScale` and
 * `Graph.tsx`'s `graphLabelFontSize` already made; a rendering-time
 * derivation, not a new persisted manifest field, so no `propCatalog.ts`
 * entry and no MCP parameter is owed — there is no new authored value). The
 * CARD, not the stack's total height, because that total is `n · cardH +
 * (n−1) · gap`: deriving type from it would shrink every label the moment an
 * author added a fifth card, which is not a type problem.
 *
 * **Why `min` of the two ratios.** Type cannot be stretched per axis, and it
 * has to fit a card that moved on both — the label is bound by the card's
 * width, the label+sublabel pair by its height. `min` is the factor that
 * clears both, the same reasoning `manifestReflow.ts` gives for its own `su`
 * and `plotTypeScale` for its own `min`.
 *
 * **What it does NOT scale.** The callout's ARM geometry (`CALLOUT_ARM_GAP`/
 * `_LENGTH`/`_TEXT_GAP` and so `CALLOUT_TEXT_OFFSET`), `CALLOUT_CANVAS_MARGIN`,
 * `CALLOUT_TEXT_RISE`, `CALLOUT_BELOW_GAP` and the cards' own `borderRadius`/
 * `marginTop` are all still fixed. Those are layout geometry, not type —
 * `plotTypeScale` draws the same line at `MARGIN`/`MARKER_R`, and leaving
 * them is the conservative direction (a shrunk label inside an unshrunk
 * offset has more air around it, never less).
 *
 * **It is not a no-op for an already-non-default card.** A stack authored at,
 * say, 760×150 now draws its type ~1.23× — that chart's type was never
 * proportional to it, so this is the fix doing its job, not a regression.
 */
export function layersTypeScale(cardW: number, cardH: number): number {
  if (!Number.isFinite(cardW) || !Number.isFinite(cardH)) return 1;
  if (cardW <= 0 || cardH <= 0) return 1;
  return Math.max(
    LAYERS_TYPE_MIN_SCALE,
    Math.min(cardW / LAYERS_BASE_CARD_WIDTH, cardH / LAYERS_BASE_CARD_HEIGHT),
  );
}

/** Average glyph advance as a fraction of the font size, for `theme.fontUi`
 *  (Kalam). B-240's second finding: the pre-fix picker assumed `0.5em`
 *  (a flat `17` px per char at 34), which over-estimates a real Kalam line by
 *  ~19% and so flipped callouts away from a side the text would have fitted
 *  on. `0.42` is the same measured ratio `Graph.tsx`'s own label fitter uses
 *  (`GRAPH_LABEL_CHAR_WIDTH_RATIO`) — one number, one font, two primitives. */
export const CALLOUT_CHAR_WIDTH_RATIO = 0.42;

/** Arm geometry, in px: the clear gap from the card's edge to where the arm
 *  starts, the arm itself, and the gap from the arm's tip to the text. */
const CALLOUT_ARM_GAP = 60;
const CALLOUT_ARM_LENGTH = 220;
const CALLOUT_ARM_TEXT_GAP = 34;
/** How far the text's near edge sits from the stack's centre line, beyond
 *  `cardW / 2`. This is the `314` the pre-fix picker hardcoded; it is now
 *  derived from the three lengths that actually make it up. */
export const CALLOUT_TEXT_OFFSET =
  CALLOUT_ARM_GAP + CALLOUT_ARM_LENGTH + CALLOUT_ARM_TEXT_GAP;
/** Safe margin kept clear at every canvas edge. The pre-fix picker already
 *  used `width - 60` on the right; it is now honoured on all four sides. */
const CALLOUT_CANVAS_MARGIN = 60;
/** The text box's top, relative to the arm it hangs off, for a side
 *  placement — the pre-fix `top: -18`, preserved exactly. */
const CALLOUT_TEXT_RISE = 18;
/** Clear air between the bottom of the stack and a `below` callout. */
const CALLOUT_BELOW_GAP = 48;
/** A deliberately generous estimate of one line box as a multiple of the
 *  font size. The text box's own `line-height` is left INHERITED, exactly as
 *  it was pre-B-240 — so a callout that already fitted still sets on the same
 *  baseline — which means this cannot be read back from CSS. It is used only
 *  to keep the `below` fallback from running off the bottom of a short
 *  canvas, and over-estimating is the safe direction there (it clamps a
 *  little early rather than a little late). Kalam's `normal` line box is
 *  ~1.45×; 1.5 clears it. */
const CALLOUT_LINE_BOX_ESTIMATE = 1.5;

export type CalloutPlacement = "right" | "left" | "below";

export interface CalloutLayout {
  placement: CalloutPlacement;
  /** Local x (origin = the stack's centre) of the text box's ANCHORED edge:
   *  its left edge for `right`/`below`, its right edge for `left`. */
  anchor: number;
  /** Local y of the text box's top. */
  top: number;
  /** Hard cap on the text box's width. The box is anchored inside the canvas
   *  and may not grow past this, so no text length can push it off-frame. */
  maxWidth: number;
}

/** The box geometry a [`CalloutLayout`] implies, as a pure function so it is
 *  testable without a DOM (B-244).
 *
 *  Extracted because B-240's layout maths was pure and unit-tested while the
 *  style that consumed it was not, and the bug that slipped through lived
 *  entirely in the consumer: `width` was set only for `below`, so the other
 *  two placements fell back to shrink-to-fit inside a ZERO-WIDTH origin
 *  container and `overflowWrap: "anywhere"` broke them to one glyph per line.
 *  A correct layout rendered wrong. The invariant worth pinning is simply
 *  that every placement gets a real width — see
 *  `every_placement_gets_a_real_width`. */
export function calloutBoxGeometry(layout: CalloutLayout): {
  left: number | undefined;
  right: number | undefined;
  width: number;
  maxWidth: number;
  textAlign: "left" | "right" | "center";
} {
  const isLeft = layout.placement === "left";
  return {
    // The origin div is zero-width, so a local x of `a` for the box's RIGHT
    // edge is `right: -a`.
    left: isLeft ? undefined : layout.anchor,
    right: isLeft ? -layout.anchor : undefined,
    width: layout.maxWidth,
    maxWidth: layout.maxWidth,
    textAlign: isLeft ? "right" : layout.placement === "below" ? "center" : "left",
  };
}

/**
 * B-240 — where a `layers` callout's text goes, as a pure function.
 *
 * **The bug.** The old placement was two lines inline in `Layers`: pick
 * `"left"` when `cx + cardW/2 + 314 + 17·len > width − 60`, then draw the
 * text `nowrap`. Nothing downstream checked that the chosen side had any
 * room — on the left the text was simply laid out at whatever x its own
 * width implied, which on a narrow canvas is NEGATIVE. The callout then
 * rendered entirely outside the frame, with no error and no clipping
 * artefact: it was just not in the picture. Hit live on c038 after D-347
 * reflowed that project 1920×1080 → 1252×1016.
 *
 * **Which of B-240's three candidate fixes this is, and why.** The entry
 * named three: wrap instead of `nowrap`, clamp x into the canvas after side
 * selection, or fall back to centring under the stack when neither side
 * fits. The pick is **the third — the `below` fallback** — because it is the
 * only one that makes a too-tight canvas produce a *usable* callout rather
 * than merely an on-canvas one. On the real repro there is genuinely no room
 * beside the stack at all (a 620-wide stack on a 1252-wide canvas leaves
 * 566 px to the margin and the text's near edge alone wants 624), so a clamp
 * would have pinned the text to the frame edge on top of the stack and a
 * wrap would have squeezed it into a zero-width column. Dropped under the
 * stack it gets the full 1132-px content box and sets on one comfortable
 * line.
 *
 * The other two are still here, but as the *bound* rather than the fix:
 * neither could deliver "impossible off-canvas regardless of text length" on
 * its own. A clamp cannot, because a `nowrap` line can be wider than the
 * whole canvas — clamping only chooses which end falls off. A wrap cannot,
 * because a wrapped block anchored at a negative x is still off-canvas. So
 * the anchor is clamped into the canvas *and* `maxWidth` is the measured
 * distance from that anchor to the far margin, which together make the box's
 * whole extent provably a subset of the safe area for any `text`.
 *
 * **What does and does not change.** A RIGHT placement is byte-identical:
 * same `cardW/2 + 314` offset, same `fromY − 18` top, and the width cap sits
 * above the text's own width so it never wraps. A LEFT placement is
 * deliberately NOT identical, because the pre-fix left geometry was itself
 * wrong — the text was a child of the arm's own shrink-to-fit container and
 * `right: len + 34` put its right edge 14 px INSIDE the arm's start, i.e. on
 * top of the arm rather than clear of its tip. Correcting that mirror costs
 * the left side the 240 px of apparent room it had been borrowing from the
 * arm, so a callout that used to flip left and sit on its own arm now goes
 * `below` instead. That is the fix, not a regression: neither of the two
 * things the left side used to do — off-frame, or over the arm — was right.
 *
 * **What it does NOT do.** It does not model `tilt`'s perspective gain
 * (B-240's "second, smaller trap": at `tilt: 24` the near card is ~7% wider
 * than `cardW`). That widens the stack's own footprint, not the callout's,
 * so it can make the arm overlap a card but cannot push the text off-canvas,
 * which is what this function is responsible for.
 */
export function layoutCallout(opts: {
  text: string;
  /** stack centre in world px */
  cx: number;
  cy: number;
  cardW: number;
  /** the stack's full height, for the `below` fallback */
  stackH: number;
  /** local y of the active card's centre — the arm's own line */
  fromY: number;
  canvasWidth: number;
  canvasHeight: number;
  /** The size the text will actually render at. `Layers` passes
   *  `CALLOUT_FONT_SIZE × layersTypeScale(cardW, cardH)` (B-239); the default
   *  is the base constant, which is what that product IS at the default card,
   *  so an omitted `fontSize` still describes a default stack exactly. The
   *  budget maths below is in px and so depends on this: a smaller size means
   *  a narrower line estimate and a shorter wrapped block, which can legally
   *  change the chosen placement for a non-default card — see B-239's entry. */
  fontSize?: number;
}): CalloutLayout {
  const {
    text,
    cx,
    cy,
    cardW,
    stackH,
    fromY,
    canvasWidth,
    canvasHeight,
    fontSize = CALLOUT_FONT_SIZE,
  } = opts;

  // The safe area, expressed in the stack's own local coordinates (its
  // container sits at `cx, cy` with a zero-size origin, so world − centre).
  const minX = CALLOUT_CANVAS_MARGIN - cx;
  const maxX = canvasWidth - CALLOUT_CANVAS_MARGIN - cx;

  // Where each side WANTS to put the text's near edge, clamped so that edge
  // is inside the safe area even when the stack itself overhangs the frame.
  const reach = cardW / 2 + CALLOUT_TEXT_OFFSET;
  const rightAnchor = Math.min(Math.max(reach, minX), maxX);
  const leftAnchor = Math.max(Math.min(-reach, maxX), minX);
  const roomRight = Math.max(0, maxX - rightAnchor);
  const roomLeft = Math.max(0, leftAnchor - minX);

  const estimate = text.length * fontSize * CALLOUT_CHAR_WIDTH_RATIO;
  const sideTop = fromY - CALLOUT_TEXT_RISE;

  // Right is the house default; left is the mirror; below is the fallback.
  if (estimate <= roomRight) {
    return { placement: "right", anchor: rightAnchor, top: sideTop, maxWidth: roomRight };
  }
  if (estimate <= roomLeft) {
    return { placement: "left", anchor: leftAnchor, top: sideTop, maxWidth: roomLeft };
  }

  const maxWidth = Math.max(0, maxX - minX);
  // Predict the wrapped block's height so the fallback cannot trade an
  // off-the-side callout for an off-the-bottom one.
  const lines = maxWidth > 0 ? Math.max(1, Math.ceil(estimate / maxWidth)) : 1;
  const blockH = lines * fontSize * CALLOUT_LINE_BOX_ESTIMATE;
  const minY = CALLOUT_CANVAS_MARGIN - cy;
  const maxY = canvasHeight - CALLOUT_CANVAS_MARGIN - cy - blockH;
  const wantY = stackH / 2 + CALLOUT_BELOW_GAP;
  return {
    placement: "below",
    anchor: minX,
    top: Math.max(minY, Math.min(wantY, maxY)),
    maxWidth,
  };
}

export const Layers: React.FC<{
  items: LayerItem[];
  start?: number;
  stagger?: number;
  active?: number;
  /** B-260 — the frame `active` last changed (scene-relative); the lit card's
   *  lift eases in from here. Supplied by the registry adapter. */
  activeSince?: number;
  callout?: string;
  /** centre of the stack in world px; omit to centre on canvas */
  x?: number;
  y?: number;
  cardW?: number;
  cardH?: number;
  gap?: number;
  tilt?: number;
}> = ({
  items,
  start = 0,
  stagger = 6,
  active = -1,
  activeSince = 0,
  callout,
  x,
  y,
  cardW = LAYERS_BASE_CARD_WIDTH,
  cardH = LAYERS_BASE_CARD_HEIGHT,
  gap = 20,
  tilt = 24,
}) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const theme = useTheme();
  const cx = x ?? width / 2;
  const cy = y ?? height / 2;
  const n = items.length;
  const stackH = n * cardH + (n - 1) * gap;

  // B-239 — every font size below is this multiplier times its named base.
  const typeScale = layersTypeScale(cardW, cardH);
  const calloutFontSize = CALLOUT_FONT_SIZE * typeScale;

  const calloutFromY = active * (cardH + gap) - stackH / 2 + cardH / 2;
  const calloutLayout =
    callout && active >= 0
      ? layoutCallout({
          text: callout,
          cx,
          cy,
          cardW,
          stackH,
          fromY: calloutFromY,
          canvasWidth: width,
          canvasHeight: height,
          // B-239 — the placement's own width/height budget is measured in
          // the size the text will ACTUALLY render at, not the base constant.
          // At the default card that is `CALLOUT_FONT_SIZE` exactly, so every
          // placement B-240/B-244 signed off is unchanged.
          fontSize: calloutFontSize,
        })
      : null;

  return (
    <div
      style={{
        position: "absolute",
        left: cx,
        top: cy,
        transform: "translate(-50%, -50%)",
        perspective: LAYERS_PERSPECTIVE,
      }}
    >
      <div style={{ transformStyle: "preserve-3d", transform: `rotateX(${tilt}deg)` }}>
        {items.map((it, i) => {
          const appear = inAt(frame, start + i * stagger, start + i * stagger + 12);
          const s = pop(frame, fps, start + i * stagger);
          const isActive = i === active;
          const lift = isActive ? activeLift(frame - activeSince, cardH, gap) : 0;
          const topOffset = i * (cardH + gap) - stackH / 2 + (it.dy ?? 0);
          return (
            <div
              key={i}
              data-motion-box
              // D-182 — `data-motion-item-index` (this card's own index into
              // `items[]`, distinct from `data-motion-layer`'s whole-layer
              // `sceneIndex.layerIndex` address, which `Video.tsx` already
              // writes on an ANCESTOR wrapper around this entire component)
              // is the finer-grained hit target `MotionCanvasOverlay.tsx`
              // checks BEFORE falling back to that whole-layer address —
              // combining the two gives the full
              // `{sceneIndex, layerIndex, itemIndex}` a card-level
              // selection needs, with no new prop threaded into this
              // component (which has never known its own scene/layer index).
              data-motion-item-index={i}
              style={{
                position: "absolute",
                width: cardW,
                height: cardH,
                left: -cardW / 2 + (it.dx ?? 0),
                top: topOffset,
                transform: `translateZ(${lift}px) scale(${s})`,
                opacity: appear,
                background: theme.bgDeep,
                border: `3px solid ${isActive ? theme.accent : theme.strokeSoft}`,
                borderRadius: 14,
                boxShadow: isActive ? `0 0 40px ${theme.accent}66` : "none",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: theme.fontUi,
              }}
            >
              <div
                style={{
                  fontSize: LAYERS_LABEL_FONT_SIZE * typeScale,
                  color: isActive ? theme.text : theme.textDim,
                }}
              >
                {it.label}
              </div>
              {it.sublabel && (
                <div
                  style={{
                    fontSize: LAYERS_SUBLABEL_FONT_SIZE * typeScale,
                    color: theme.textDim,
                    marginTop: 4,
                  }}
                >
                  {it.sublabel}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {callout && calloutLayout && (
        <Callout
          text={callout}
          layout={calloutLayout}
          cardW={cardW}
          fromY={calloutFromY}
          start={start + active * stagger + 10}
          fontSize={calloutFontSize}
        />
      )}
    </div>
  );
};

/**
 * The callout itself: an arm drawn off the active card, and the text.
 *
 * B-240 — the text is no longer a child of the arm's own container. It was,
 * and that is why the LEFT side was doubly wrong: the container shrink-wraps
 * to the arm `<svg>`'s 240 px, so `right: len + 34` put the text's right edge
 * 14 px LEFT of the arm's start — on top of the arm it was supposed to hang
 * off, not clear of its tip. As a sibling positioned from `layoutCallout`'s
 * own local coordinates, left and right are true mirrors and the geometry is
 * the one thing that decided the placement, not an accident of shrink-wrap.
 */
const Callout: React.FC<{
  text: string;
  layout: CalloutLayout;
  cardW: number;
  fromY: number;
  start: number;
  /** B-239 — the rendered size, i.e. `CALLOUT_FONT_SIZE × layersTypeScale`.
   *  It is passed in rather than recomputed here so the size the box was
   *  LAID OUT for (`layoutCallout`'s `fontSize`) and the size it is DRAWN at
   *  cannot drift apart — the same reason `CALLOUT_FONT_SIZE` was exported in
   *  the first place. */
  fontSize: number;
}> = ({ text, layout, cardW, fromY, start, fontSize }) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const draw = inAt(frame, start, start + 14);
  const show = inAt(frame, start + 8, start + 22);
  const dir = layout.placement === "left" ? -1 : 1;
  const d = roughLine([0, 0], [CALLOUT_ARM_LENGTH * dir, 0], {
    seed: 12,
    color: theme.accent,
    strokeWidth: 3,
    roughness: theme.roughness,
    bowing: theme.bowing,
  });
  return (
    <>
      {/* No arm on the `below` fallback: a line from the active card down to
          a centred caption would have to cross every card under it. The
          active card is already called out by its accent border, its glow and
          its forward translate, so the pointer is redundant there. */}
      {layout.placement !== "below" && (
        <div
          style={{
            position: "absolute",
            left: dir === 1 ? cardW / 2 + CALLOUT_ARM_GAP : -cardW / 2 - CALLOUT_ARM_GAP,
            top: fromY,
          }}
        >
          <svg width={CALLOUT_ARM_LENGTH + 20} height={20} style={{ overflow: "visible" }}>
            <path
              d={d}
              fill="none"
              stroke={theme.accent}
              strokeWidth={3}
              strokeLinecap="round"
              pathLength={1}
              strokeDasharray={1}
              strokeDashoffset={1 - draw}
            />
          </svg>
        </div>
      )}
      <div
        style={{
          position: "absolute",
          // B-244 — every placement gets a REAL width, not just `below` and
          // not `maxWidth` alone: `maxWidth` is a cap, and a cap cannot give
          // a shrink-to-fit box room it does not have inside a zero-width
          // origin container. See `calloutBoxGeometry`.
          ...calloutBoxGeometry(layout),
          top: layout.top,
          overflowWrap: "anywhere",
          fontFamily: theme.fontUi,
          fontSize,
          color: theme.text,
          opacity: show,
          transform: `translateX(${(1 - show) * -12 * dir}px)`,
        }}
      >
        {text}
      </div>
    </>
  );
};
