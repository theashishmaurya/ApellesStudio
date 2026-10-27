/**
 * `icon` — any Phosphor icon by name and weight (D-405).
 *
 *   {"use":"icon","name":"rocket-launch","weight":"duotone","size":120,"x":900,"y":480,
 *    "color":"#f5c542","at":0.4,"enter":"pop"}
 *
 * The glyph is the installed `@phosphor-icons/react` component itself, looked
 * up by its phosphoricons.com name (`../lib/phosphorIcons.ts`) — never a
 * hand-drawn path (CLAUDE.md). The library loads lazily; until it has, the
 * frame is held with `delayRender`, so a render never draws a frame without
 * its icon. `x`/`y` are the icon box's top-left in world px, `size` its edge.
 *
 * What it does NOT do: draw an unknown name. `motion_validate` refuses one
 * (with the nearest real name as a hint); a document that carries one anyway
 * renders nothing for that layer and logs a warning, rather than failing the
 * render.
 */
import React, { useEffect, useState } from "react";
import { cancelRender, continueRender, delayRender, useCurrentFrame, useVideoConfig } from "remotion";
import { enterStyle, type EnterPreset } from "../lib/enter";
import { loadPhosphorIcons, phosphorIconsIfLoaded, type PhosphorMap, type PhosphorWeight } from "../lib/phosphorIcons";
import { useTheme } from "../ThemeContext";

/** Hold the frame until the icon library has loaded; the map once it has. */
function usePhosphorIcons(): PhosphorMap | null {
  const [icons, setIcons] = useState<PhosphorMap | null>(() => phosphorIconsIfLoaded());
  // Taken during the first render (Remotion's own pattern), not in the effect,
  // so the frame is held from the very start.
  const [handle] = useState(() => (icons ? null : delayRender("loading the Phosphor icon library")));
  useEffect(() => {
    if (handle === null) return;
    let live = true;
    loadPhosphorIcons().then(
      (map) => {
        if (live) setIcons(map);
        continueRender(handle);
      },
      (e: unknown) => cancelRender(e instanceof Error ? e : new Error(String(e))),
    );
    return () => {
      live = false;
    };
  }, [handle]);
  return icons;
}

export const Icon: React.FC<{
  name: string;
  weight?: PhosphorWeight;
  size?: number;
  color?: string;
  x?: number;
  y?: number;
  enter?: EnterPreset;
  enterDur?: number;
  start?: number;
}> = ({ name, weight = "regular", size = 96, color, x = 0, y = 0, enter = "pop", enterDur = 12, start = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const theme = useTheme();
  const icons = usePhosphorIcons();
  if (!icons) return null;
  const Glyph = icons.get(name);
  if (!Glyph) {
    console.warn(`[motion] icon "${name}" is not a Phosphor icon; drawing nothing`);
    return null;
  }
  return (
    <div
      data-motion-box
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: size,
        height: size,
        transformOrigin: "50% 50%",
        ...enterStyle(enter, frame, start, enterDur, fps),
      }}
    >
      <Glyph size={size} weight={weight} color={color ?? theme.text} style={{ display: "block" }} />
    </div>
  );
};
