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
 */
import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { design } from "../design";
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

export const Layers: React.FC<{
  items: LayerItem[];
  start?: number;
  stagger?: number;
  active?: number;
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
  callout,
  x,
  y,
  cardW = 620,
  cardH = 110,
  gap = 20,
  tilt = 24,
}) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const cx = x ?? width / 2;
  const cy = y ?? height / 2;
  const n = items.length;
  const stackH = n * cardH + (n - 1) * gap;

  return (
    <div
      style={{
        position: "absolute",
        left: cx,
        top: cy,
        transform: "translate(-50%, -50%)",
        perspective: 1400,
      }}
    >
      <div style={{ transformStyle: "preserve-3d", transform: `rotateX(${tilt}deg)` }}>
        {items.map((it, i) => {
          const appear = inAt(frame, start + i * stagger, start + i * stagger + 12);
          const s = pop(frame, fps, start + i * stagger);
          const isActive = i === active;
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
                transform: `translateZ(${isActive ? 90 : 0}px) translateX(${isActive ? 40 : 0}px) scale(${s})`,
                opacity: appear,
                background: design.bgDeep,
                border: `3px solid ${isActive ? design.accentRed : design.strokeSoft}`,
                borderRadius: 14,
                boxShadow: isActive ? `0 0 40px ${design.accentRed}66` : "none",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: design.fontHand,
              }}
            >
              <div style={{ fontSize: 40, color: isActive ? design.text : design.textDim }}>
                {it.label}
              </div>
              {it.sublabel && (
                <div style={{ fontSize: 24, color: design.textDim, marginTop: 4 }}>
                  {it.sublabel}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {callout && active >= 0 && (
        <Callout
          text={callout}
          side={
            cx + cardW / 2 + 314 + callout.length * 17 > width - 60 ? "left" : "right"
          }
          cardW={cardW}
          fromY={active * (cardH + gap) - stackH / 2 + cardH / 2}
          start={start + active * stagger + 10}
        />
      )}
    </div>
  );
};

const Callout: React.FC<{
  text: string;
  side: "left" | "right";
  cardW: number;
  fromY: number;
  start: number;
}> = ({ text, side, cardW, fromY, start }) => {
  const frame = useCurrentFrame();
  const draw = inAt(frame, start, start + 14);
  const show = inAt(frame, start + 8, start + 22);
  const len = 220;
  const dir = side === "right" ? 1 : -1;
  const d = roughLine([0, 0], [len * dir, 0], {
    seed: 12,
    color: design.accentRed,
    strokeWidth: 3,
  });
  return (
    <div
      style={{
        position: "absolute",
        left: dir === 1 ? cardW / 2 + 60 : -cardW / 2 - 60,
        top: fromY,
      }}
    >
      <svg width={len + 20} height={20} style={{ overflow: "visible" }}>
        <path
          d={d}
          fill="none"
          stroke={design.accentRed}
          strokeWidth={3}
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - draw}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          left: dir === 1 ? len + 34 : undefined,
          right: dir === 1 ? undefined : len + 34,
          top: -18,
          whiteSpace: "nowrap",
          fontFamily: design.fontHand,
          fontSize: 34,
          color: design.text,
          opacity: show,
          transform: `translateX(${(1 - show) * -12 * dir}px)`,
        }}
      >
        {text}
      </div>
    </div>
  );
};
