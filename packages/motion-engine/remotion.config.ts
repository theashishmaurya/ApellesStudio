/**
 * Note: When using the Node.JS APIs, the config file
 * doesn't apply. Instead, pass options directly to the APIs.
 *
 * All configuration options: https://remotion.dev/docs/config
 */

import { Config } from "@remotion/cli/config";

Config.setRspack(true);
Config.setChromiumOpenGlRenderer("angle");
Config.setVideoImageFormat("jpeg");

/**
 * D-342 — render every scene at 2x its authored composition size, i.e. native
 * 3840x2160 out of the 1920x1080 space every composition here is authored in.
 *
 * Why the scale factor and NOT the manifest's own `width`/`height`: a layer's
 * `x`/`y`/`size` are raw CSS pixels in world coordinates (`primitives/
 * TextLine.tsx`: "px, world coords"; `left: x`, `top: y`, `fontSize: size`),
 * and `engine/build.ts`'s `metadataFromManifest` hands the manifest's
 * width/height to the `Animation` composition verbatim with no design-space
 * normalisation anywhere in between. Doubling the manifest's dimensions would
 * therefore NOT make a 4K graphic — it would leave every layer at its 1080p
 * pixel coordinates in the top-left quadrant of a 4K frame, at half the
 * relative size. Remotion's scale factor is the framework's own answer to
 * exactly this (it raises the headless browser's `deviceScaleFactor`), so text,
 * SVG and CSS rasterise natively at the output resolution rather than being
 * upscaled from a 1080p raster, and the authored layout is untouched.
 *
 * Global rather than per-manifest because every composition in this engine is
 * authored at 1920x1080 and the app's Edit canvas is 3840x2160 — a Motion
 * graphic composited full-frame there was being upscaled 2x. A per-manifest
 * `renderScale` (plumbed schema -> `useMotionManifest.render()` -> `apelles-
 * motion`'s `RenderRequest`, the same route `frame_range` already takes) is the
 * shape to reach for if a project ever needs its own value; nothing needs it
 * today. See docs/08-decisions.md D-342.
 */
Config.setScale(2);
