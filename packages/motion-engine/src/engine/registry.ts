/**
 * Manifest `use` string → primitive component + a prop adapter that converts
 * the manifest's second-based, terse props into what each primitive expects
 * (frame-based, fully-shaped).
 */
import type React from "react";
import { Text } from "../primitives/Text";
import { Emphasis } from "../primitives/Emphasis";
import { Matrix } from "../primitives/Matrix";
import { Graph } from "../primitives/Graph";
import { Layers } from "../primitives/Layers";
import { ParticleFlow } from "../primitives/ParticleFlow";
import { LabelBox, LayerStack } from "../primitives/Scene3D";
import type { Active, Layer } from "./schema";

const f = (sec: number | undefined, fps: number, dflt = 0) =>
  sec === undefined ? dflt : Math.round(sec * fps);

/** evaluate an `active` schedule at a scene-relative frame → an index */
export const resolveActive = (a: Active | undefined, fps: number, frame: number): number => {
  if (a === undefined) return -1;
  if (typeof a === "number") return a;
  let idx = -1;
  for (const step of [...a].sort((x, y) => x.at - y.at)) {
    if (frame >= step.at * fps) idx = step.i;
  }
  return idx;
};

type Adapter = (raw: Record<string, unknown>, fps: number, frame: number) => Record<string, unknown>;

const generic: Adapter = (raw, fps) => {
  const { at, dur, use, ...rest } = raw;
  return {
    ...rest,
    ...(at !== undefined ? { start: f(at as number, fps) } : {}),
    ...(dur !== undefined ? { dur: f(dur as number, fps) } : {}),
  };
};

const REGISTRY: Record<
  string,
  { component: React.FC<Record<string, unknown>>; adapt: Adapter }
> = {
  text: {
    component: Text as React.FC<Record<string, unknown>>,
    adapt: (raw, fps) => {
      const g = generic(raw, fps, 0);
      // manifest uses `text:`; the primitive takes it as `children`
      if (raw.text !== undefined) {
        g.children = raw.text;
        delete g.text;
      }
      return g;
    },
  },

  emphasis: {
    component: Emphasis as React.FC<Record<string, unknown>>,
    adapt: (raw, fps) => {
      const g = generic(raw, fps, 0);
      const box = raw.box as number[] | undefined;
      if (box) g.box = { x: box[0], y: box[1], w: box[2], h: box[3] };
      return g;
    },
  },

  matrix: { component: Matrix as React.FC<Record<string, unknown>>, adapt: generic },

  graph: {
    component: Graph as React.FC<Record<string, unknown>>,
    adapt: (raw, fps) => {
      const { at, dur, use, ...rest } = raw;
      const enter = rest.enter as { at?: number; stagger?: number } | undefined;
      const pulses = (rest.pulses as { at: number }[] | undefined)?.map((p) => ({
        ...p,
        at: f(p.at, fps),
        ...(("dur" in p) ? { dur: f((p as { dur?: number }).dur, fps) } : {}),
      }));
      const highlight = (rest.highlight as { at: number; dur?: number }[] | undefined)?.map(
        (h) => ({ ...h, at: f(h.at, fps), ...(h.dur !== undefined ? { dur: f(h.dur, fps) } : {}) }),
      );
      return {
        ...rest,
        ...(enter ? { enter: { at: f(enter.at, fps), stagger: f(enter.stagger, fps, 4) } } : {}),
        ...(pulses ? { pulses } : {}),
        ...(highlight ? { highlight } : {}),
      };
    },
  },

  layers: {
    component: Layers as React.FC<Record<string, unknown>>,
    adapt: (raw, fps, frame) => {
      const g = generic(raw, fps, 0);
      const items = raw.items as (string | { label: string })[] | undefined;
      if (items) g.items = items.map((it) => (typeof it === "string" ? { label: it } : it));
      g.active = resolveActive(raw.active as Active, fps, frame);
      return g;
    },
  },

  particleflow: { component: ParticleFlow as React.FC<Record<string, unknown>>, adapt: generic },
  labelbox: { component: LabelBox as React.FC<Record<string, unknown>>, adapt: generic },
  layerstack: {
    component: LayerStack as React.FC<Record<string, unknown>>,
    adapt: (raw, fps, frame) => {
      const g = generic(raw, fps, 0);
      if (raw.active !== undefined) g.active = resolveActive(raw.active as Active, fps, frame);
      return g;
    },
  },
};

export const lookup = (use: Layer["use"]) => {
  const entry = REGISTRY[use];
  if (!entry) throw new Error(`unknown primitive "${use}" in manifest`);
  return entry;
};
