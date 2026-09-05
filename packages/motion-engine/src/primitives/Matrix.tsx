/**
 * Matrix — a grid of cells with frame-driven fills.
 * Weight matrices, attention maps, embeddings, KV cache, a heat grid.
 *
 * presets:
 *   heatmap   — static fills from `values` (0..1), whole grid fades in
 *   ripple    — a diagonal wave of activation sweeps across, repeating
 *   fill-in   — cells light up in order, by row or by column
 *   highlight — only the cells in `highlight[]` animate, on their own schedule
 *
 * Cell borders are hand-drawn (roughjs) and memoised — only fills change per frame.
 *
 * `data-motion-box` (D-155, §3b of `docs/notes/motion-visual-builder-
 * research.md`) marks the outer `<svg>` below — unlike `Graph`'s or
 * `Emphasis`'s `inset:0` canvas-spanning `<svg>`s, this one is already sized
 * to the grid's real footprint (`width={w} height={h}`, computed from
 * `rows`/`cols`/`cell`/`gap`) rather than the whole composition, so it needs
 * no per-cell union — it already IS the tight box.
 */
import React, { useMemo } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { design } from "../design";
import { inAt } from "../lib/draw";
import { roughRect } from "../lib/rough";

export type MatrixPreset = "heatmap" | "ripple" | "fill-in" | "highlight";

export const Matrix: React.FC<{
  rows: number;
  cols: number;
  cell?: number;
  gap?: number;
  preset?: MatrixPreset;
  start?: number;
  dur?: number;
  values?: number[][];
  highlight?: { r: number; c: number; at: number; dur?: number }[];
  fillDir?: "row" | "col";
  accent?: string;
  /** top-left in world px; omit to centre on the canvas */
  x?: number;
  y?: number;
}> = ({
  rows,
  cols,
  cell = 88,
  gap = 10,
  preset = "heatmap",
  start = 0,
  dur = 60,
  values,
  highlight = [],
  fillDir = "row",
  accent = design.accentBlue,
  x,
  y,
}) => {
  const frame = useCurrentFrame();
  const { width: cw, height: ch } = useVideoConfig();
  const step = cell + gap;
  const w = cols * step - gap;
  const h = rows * step - gap;
  const ox = x ?? (cw - w) / 2;
  const oy = y ?? (ch - h) / 2;

  // hand-drawn borders never change → build once
  const borders = useMemo(() => {
    const out: { key: string; d: string; cx: number; cy: number }[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        out.push({
          key: `${r}-${c}`,
          d: roughRect(0, 0, cell, cell, {
            seed: r * cols + c + 1,
            color: design.strokeSoft,
            strokeWidth: 2,
          }),
          cx: c * step,
          cy: r * step,
        });
      }
    }
    return out;
  }, [rows, cols, cell, step]);

  const cellFill = (r: number, c: number): number => {
    if (preset === "heatmap") {
      const v = values?.[r]?.[c] ?? 0;
      return v * inAt(frame, start, start + dur);
    }
    if (preset === "ripple") {
      const period = dur;
      const phase = ((frame - start) % period) / period; // 0..1
      const wavePos = phase * (rows + cols);
      const dist = Math.abs(r + c - wavePos);
      return Math.max(0, 1 - dist / 2.2);
    }
    if (preset === "fill-in") {
      const total = fillDir === "row" ? rows : cols;
      const p = inAt(frame, start, start + dur);
      const reached = p * total;
      const idx = fillDir === "row" ? r : c;
      return idx < Math.floor(reached) ? 0.85 : idx === Math.floor(reached) ? (reached % 1) * 0.85 : 0;
    }
    // highlight
    const hit = highlight.find((hh) => hh.r === r && hh.c === c);
    if (!hit) return 0;
    const d = hit.dur ?? 18;
    return Math.min(inAt(frame, hit.at, hit.at + d * 0.4), 1 - inAt(frame, hit.at + d * 0.6, hit.at + d)) * 0.9;
  };

  return (
    <svg
      data-motion-box
      style={{ position: "absolute", left: ox, top: oy, overflow: "visible" }}
      width={w}
      height={h}
    >
      {borders.map((b) => {
        const [r, c] = b.key.split("-").map(Number);
        const f = Math.max(0, Math.min(1, cellFill(r, c)));
        return (
          <g key={b.key} transform={`translate(${b.cx} ${b.cy})`}>
            <rect width={cell} height={cell} rx={4} fill={accent} opacity={f * 0.9} />
            <path d={b.d} fill="none" stroke={design.strokeSoft} strokeWidth={2} />
          </g>
        );
      })}
    </svg>
  );
};
