/**
 * Text — house text reveals, in the active theme's own display face and ink
 * (D-339; `color`/`font` props still win over the theme when set).
 *
 * presets:
 *   fade-up   — opacity + rise (default, safest)
 *   mask-up   — clipped from the baseline, slides up into view
 *   type      — typewriter, substring by frame, optional blinking caret
 *   stroke-on — hand-lettered outline wipes on left→right (transparent fill)
 *
 * Positioning: absolute, anchored by `x`/`y` (px, world coords) with `align`
 * controlling which edge `x` refers to. Leave x/y off to sit at the flow position.
 */
import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { useTheme } from "../ThemeContext";
import { inAt } from "../lib/draw";

export type TextPreset = "fade-up" | "mask-up" | "type" | "stroke-on";

export const Text: React.FC<{
  children: string;
  preset?: TextPreset;
  start?: number;
  /** frames the reveal takes */
  dur?: number;
  size?: number;
  color?: string;
  weight?: number;
  font?: string;
  align?: "left" | "center" | "right";
  letterSpacing?: string;
  x?: number;
  y?: number;
  maxWidth?: number;
  caret?: boolean;
}> = ({
  children,
  preset = "fade-up",
  start = 0,
  dur = 18,
  size = 64,
  // D-339 — the theme-sourced defaults (`color`, `font`) resolve INSIDE the
  // body rather than in the parameter list: a default parameter cannot call
  // `useTheme()`. An explicitly-passed prop still wins, exactly as before.
  color,
  weight = 700,
  font,
  align = "left",
  letterSpacing = "0.01em",
  x,
  y,
  maxWidth,
  caret = false,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const theme = useTheme();
  const ink = color ?? theme.text;
  const face = font ?? theme.fontDisplay;
  const p = inAt(frame, start, start + dur);

  const positioned = x !== undefined || y !== undefined;
  const wrap: React.CSSProperties = positioned
    ? {
        position: "absolute",
        left: x ?? 0,
        top: y ?? 0,
        transform:
          align === "center"
            ? "translateX(-50%)"
            : align === "right"
              ? "translateX(-100%)"
              : undefined,
        // B-258 — an absolutely positioned box shrinks to fit the space right
        // of `left`, so centred text at x = 960 wrapped at 960 px (and
        // right-aligned text even sooner) whatever `maxWidth` said. Sizing to
        // the text itself, capped by `maxWidth`, makes the wrap width the
        // author's, independent of where the anchor sits.
        width: "max-content",
        maxWidth,
        textAlign: align,
      }
    : { maxWidth, textAlign: align };

  const base: React.CSSProperties = {
    fontFamily: face,
    fontSize: size,
    fontWeight: weight,
    color: ink,
    letterSpacing,
    lineHeight: 1.15,
    whiteSpace: "pre-wrap",
  };

  // `data-motion-box` (D-155, §3b of the visual-builder research doc): the
  // outermost `div` below IS the tight, real-text-metrics box `x`/`y` place —
  // Text is the one primitive whose generic wrapper already needs no help.
  if (preset === "type") {
    const chars = children.length;
    const shown = Math.round(inAt(frame, start, start + Math.max(dur, chars)) * chars);
    const done = shown >= chars;
    const blink = caret && (!done || Math.floor((frame / fps) * 2) % 2 === 0);
    return (
      <div style={wrap} data-motion-box>
        <span style={base}>
          {children.slice(0, shown)}
          {blink && (
            <span style={{ color: theme.accent, fontWeight: 400 }}>▏</span>
          )}
        </span>
      </div>
    );
  }

  if (preset === "mask-up") {
    return (
      <div style={{ ...wrap, overflow: "hidden" }} data-motion-box>
        <div
          style={{
            ...base,
            transform: `translateY(${(1 - p) * 100}%)`,
          }}
        >
          {children}
        </div>
      </div>
    );
  }

  if (preset === "stroke-on") {
    return (
      <div style={wrap} data-motion-box>
        <span
          style={{
            ...base,
            color: "transparent",
            WebkitTextStroke: `1.5px ${ink}`,
            clipPath: `inset(0 ${(1 - p) * 100}% 0 0)`,
          }}
        >
          {children}
        </span>
      </div>
    );
  }

  // fade-up
  return (
    <div style={wrap} data-motion-box>
      <div
        style={{
          ...base,
          opacity: p,
          transform: `translateY(${(1 - p) * 22}px)`,
        }}
      >
        {children}
      </div>
    </div>
  );
};
