/**
 * The scene manifest — what a model emits (one small JSON doc per video), and
 * what `build.ts` compiles into a Remotion composition. Keep it terse: the model's
 * job is the manifest (~150 tokens/scene), not React. All times are in SECONDS.
 *
 * {
 *   "title": "Prompt caching, explained",
 *   "grain": true,
 *   "scenes": [
 *     { "id": "hook", "dur": 4,
 *       "camera": [{"at":0,"zoom":1},{"at":0.3,"x":1200,"y":540,"zoom":1.6}],
 *       "layers": [
 *         {"use":"text","text":"EVERY call re-sends the prompt","preset":"stroke-on","at":0.2,"x":200,"y":300},
 *         {"use":"emphasis","preset":"scribble","at":1.5,"dur":2,"box":[900,380,420,220]}
 *       ]},
 *     { "id": "stack", "dur": 6, "layers": [
 *         {"use":"layers","at":0.3,"items":["tools","system","context","your question"],
 *          "active":[{"at":2,"i":2}],"callout":"re-sent every call"} ]},
 *     { "id": "space", "dur": 5, "scene3d": {
 *         "camera":[{"at":0,"pos":[0,0,12]},{"at":5,"pos":[3,2,9]}],
 *         "children":[{"use":"particleflow","preset":"stream","from":[-6,0,0],"to":[6,0,0]}] }}
 *   ]
 * }
 */
import { z } from "zod";

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const timed = z.object({ at: z.number(), i: z.number() });
/** `active`: a fixed index, or a step schedule [{at, i}] */
const activeSchema = z.union([z.number(), z.array(timed)]);

const cam2dKey = z.object({
  at: z.number(),
  x: z.number().optional(),
  y: z.number().optional(),
  zoom: z.number().optional(),
});

const cam3dKey = z.object({
  at: z.number(),
  pos: vec3,
  look: vec3.optional(),
});

/** one primitive placement. `use` picks the primitive; the rest are its props.
 *  passthrough so per-primitive props don't all need re-declaring here. */
const layer = z
  .object({
    use: z.enum([
      "text",
      "emphasis",
      "matrix",
      "graph",
      "layers",
      // scene3d children:
      "particleflow",
      "labelbox",
      "layerstack",
    ]),
    at: z.number().optional(),
    dur: z.number().optional(),
    active: activeSchema.optional(),
  })
  .passthrough();

const scene = z.object({
  id: z.string(),
  dur: z.number().positive(),
  bg: z.string().optional(),
  grain: z.boolean().optional(),
  vignette: z.union([z.boolean(), z.number()]).optional(),
  camera: z.array(cam2dKey).optional(),
  layers: z.array(layer).optional(),
  scene3d: z
    .object({
      camera: z.array(cam3dKey).min(1),
      children: z.array(layer),
    })
    .optional(),
  /** cross-fade into this scene, in seconds (default hard cut) */
  transition: z.number().optional(),
});

export const manifestSchema = z.object({
  title: z.string(),
  width: z.number().default(1920),
  height: z.number().default(1080),
  fps: z.number().default(30),
  grain: z.boolean().optional(),
  vignette: z.union([z.boolean(), z.number()]).optional(),
  /** render with no background paint — for a ProRes4444 overlay to composite in Palmier */
  transparent: z.boolean().optional(),
  scenes: z.array(scene).min(1),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type Scene = z.infer<typeof scene>;
export type Layer = z.infer<typeof layer>;
export type Cam2dKey = z.infer<typeof cam2dKey>;
export type Cam3dKey = z.infer<typeof cam3dKey>;
export type Active = z.infer<typeof activeSchema>;
