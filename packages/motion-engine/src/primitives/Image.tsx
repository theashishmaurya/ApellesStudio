/**
 * `image` — a project asset (a logo, a screenshot, a product shot) placed in a
 * box (D-405, Phase 1 of `docs/notes/motion-authoring-mcp.md`).
 *
 *   {"use":"image","src":"sha256:…png","x":760,"y":340,"w":400,"h":400,
 *    "fit":"contain","radius":24,"borderWidth":2,"borderColor":"#ffffff","at":0.2,"enter":"pop"}
 *
 * `src` is a content-hash asset id (D-404, `../lib/assets.tsx`), resolved by the
 * runtime's asset resolver; Remotion's `<Img>` holds the frame until the image
 * has decoded, so a render never shows it half-loaded. `fit` is CSS
 * `object-fit`. `x`/`y` are the box's top-left in world px.
 *
 * What it does NOT do: crop by coordinates (put it in a `group` with a mask),
 * or load anything that is not an imported asset.
 */
import React from "react";
import { Img, useCurrentFrame, useVideoConfig } from "remotion";
import { useAssetResolver } from "../lib/assets";
import { useTheme } from "../ThemeContext";
import { enterStyle, type EnterPreset } from "../lib/enter";

export const Image: React.FC<{
  src: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  fit?: "cover" | "contain" | "fill";
  radius?: number;
  borderWidth?: number;
  borderColor?: string;
  enter?: EnterPreset;
  /** frames the entrance takes */
  enterDur?: number;
  start?: number;
}> = ({ src, x = 0, y = 0, w = 400, h = 300, fit = "contain", radius = 0, borderWidth = 0, borderColor, enter = "fade", enterDur = 12, start = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const resolve = useAssetResolver();
  const theme = useTheme();
  const e = enterStyle(enter, frame, start, enterDur, fps);
  const url = resolve(src);
  return (
    <div
      data-motion-box
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        height: h,
        borderRadius: radius,
        overflow: "hidden",
        boxSizing: "border-box",
        border: borderWidth > 0 ? `${borderWidth}px solid ${borderColor ?? theme.stroke}` : undefined,
        transformOrigin: "50% 50%",
        ...e,
      }}
    >
      {/* An empty URL means the runtime cannot reach the asset folder yet (the
          live preview before the folder is known); draw nothing rather than a
          broken image. */}
      {url ? <Img src={url} style={{ width: "100%", height: "100%", objectFit: fit, display: "block" }} /> : null}
    </div>
  );
};
