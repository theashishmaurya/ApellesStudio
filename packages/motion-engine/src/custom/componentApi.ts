/**
 * componentApi.ts — the contract a custom component is written against (D-409).
 *
 * What it is: the module a component imports as `@apelles/component`. It is
 * types only: a component's default export receives `ComponentProps<P>`, where
 * `P` is the shape of its declared props. The static check (`sourceCheck.ts`)
 * type-checks a component's source against this file, and the renderer
 * (`runtime.tsx`) calls the component with exactly this object.
 *
 *     import { AbsoluteFill, random, useCurrentFrame } from "remotion";
 *     import type { ComponentProps } from "@apelles/component";
 *
 *     type Props = { count: number; color?: string };
 *     export default function Burst({ props, theme, width, height }: ComponentProps<Props>) {
 *       const frame = useCurrentFrame();            // counts from the layer's start
 *       const ink = props.color ?? theme.accent;    // colours fall back to the theme
 *       …
 *     }
 *
 * Time comes from `useCurrentFrame()` / `useVideoConfig().fps` only, randomness
 * from Remotion's seeded `random(seed)` only: the check refuses wall clocks,
 * timers, `Math.random`, the network and the page's globals, and certification
 * renders the component twice, out of order, to prove it is a pure function of
 * (props, frame).
 *
 * What it does NOT do: anything at runtime. There is nothing to import here
 * but types; the renderer maps the specifier to an empty module.
 */
import type { Theme } from "../design";

export type { Theme };

/** What a component's default export is called with. */
export interface ComponentProps<P extends object = Record<string, unknown>> {
  /** the declared props: each default, overridden by the layer's own values,
   *  with `anim` tracks applied at this frame */
  props: P;
  /** the document's theme: read colours and fonts from here by default */
  theme: Theme;
  /** the layer's box, px; draw inside it (0,0 is its top-left) */
  width: number;
  height: number;
  /** how long the layer plays, in frames: its `dur`, else the component's
   *  declared duration */
  durationInFrames: number;
}
