import type { Manifest } from "./schema";

/** default manifest shown in the studio for the `Animation` composition.
 *  A real project passes its own via --props=manifest.json */
export const sample: Manifest = {
  title: "sample — every call re-sends the prompt",
  width: 1920,
  height: 1080,
  fps: 30,
  grain: true,
  vignette: 0.35,
  scenes: [
    {
      id: "hook",
      dur: 4,
      camera: [
        { at: 0, zoom: 1 },
        { at: 0.4, zoom: 1 },
        { at: 1.6, x: 1150, y: 520, zoom: 1.5 },
      ],
      layers: [
        {
          use: "text",
          text: "EVERY call re-sends the whole prompt",
          preset: "stroke-on",
          at: 0.2,
          x: 180,
          y: 300,
          size: 78,
        },
        {
          use: "emphasis",
          preset: "scribble",
          at: 1.8,
          dur: 2,
          box: [980, 250, 520, 130],
        },
      ],
    },
    {
      id: "stack",
      dur: 6,
      layers: [
        {
          use: "text",
          text: "the prompt stack",
          preset: "fade-up",
          at: 0.1,
          x: 960,
          y: 110,
          align: "center",
          size: 44,
        },
        {
          use: "layers",
          at: 0.4,
          y: 560,
          items: ["tools", "system prompt", "retrieved context", "your question"],
          active: [
            { at: 2.5, i: 2 },
            { at: 4, i: 0 },
          ],
          callout: "re-sent on every call",
        },
      ],
    },
    {
      id: "space",
      dur: 5,
      scene3d: {
        camera: [
          { at: 0, pos: [0, 0, 12], look: [0, 0, 0] },
          { at: 5, pos: [3, 2, 9], look: [0, 0, 0] },
        ],
        children: [
          { use: "particleflow", preset: "stream", from: [-6, 0, 0], to: [6, 0, 0] },
          {
            use: "particleflow",
            preset: "converge",
            shape: "sphere",
            shapeSize: 2.2,
            at: 1.5,
            dur: 2.5,
            color: "#e5484d",
            seed: 4,
          },
        ],
      },
    },
  ],
};
