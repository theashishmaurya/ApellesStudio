/**
 * `counter` — a number that counts from `from` to `to` (D-405): the stat beat
 * of a founder video ("10,000+ teams", "$2.4M ARR", "99.9% uptime").
 *
 *   {"use":"counter","from":0,"to":12500,"at":0.3,"dur":1.6,"prefix":"$","suffix":"+",
 *    "thousands":true,"decimals":0,"size":160,"x":960,"y":420,"align":"center"}
 *
 * A timer zero-pads with `pad` (minimum integer digits): prefix `"0:"`, `pad: 2`,
 * `decimals: 2` counts `0:00.00` ... `0:09.00` (B-324).
 *
 * Counts over `dur` seconds from `at`, eased by `ease` (the bezier tuple every
 * Motion key uses; default the house settle-out), then holds `to`. Formatting
 * is done here, arithmetically, with a fixed `,` thousands separator and `.`
 * decimal point — NOT `toLocaleString`, whose output depends on the machine's
 * locale and would make the same manifest render different digits on
 * different machines (CLAUDE.md's render determinism rule). Digits are
 * tabular, so the number does not jitter sideways while it counts.
 *
 * What it does NOT do: compact notation (`12.5K`) or currency rules; write the
 * prefix/suffix you want.
 */
import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { motion } from "../design";
import { useTheme } from "../ThemeContext";

/** The most integer digits `pad` may ask for. */
const MAX_PAD = 12;

/** Format `value` with `decimals` places, an optional `,` thousands
 *  separator and (B-324) at least `pad` integer digits, zero-filled — a timer
 *  reads `09.00`, not `9.00`. Locale-independent by construction. Exported for
 *  tests. */
export function formatCount(value: number, decimals: number, thousands: boolean, pad = 0): string {
  const places = Math.max(0, Math.min(6, Math.round(decimals)));
  const fixed = Math.abs(value).toFixed(places);
  const [digits, frac] = fixed.split(".");
  const whole = digits.padStart(Math.max(0, Math.min(MAX_PAD, Math.round(pad))), "0");
  const grouped = thousands ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : whole;
  const sign = value < 0 && Number(fixed) !== 0 ? "-" : "";
  return `${sign}${grouped}${frac !== undefined ? `.${frac}` : ""}`;
}

export const Counter: React.FC<{
  from?: number;
  to: number;
  decimals?: number;
  thousands?: boolean;
  /** minimum integer digits, zero-filled (`2` -> `09`) */
  pad?: number;
  prefix?: string;
  suffix?: string;
  ease?: readonly [number, number, number, number];
  size?: number;
  color?: string;
  weight?: number;
  font?: string;
  align?: "left" | "center" | "right";
  x?: number;
  y?: number;
  /** frames */
  start?: number;
  /** frames the count takes */
  dur?: number;
}> = ({
  from = 0,
  to,
  decimals = 0,
  thousands = true,
  pad = 0,
  prefix = "",
  suffix = "",
  ease = motion.ease.out,
  size = 120,
  color,
  weight = 700,
  font,
  align = "left",
  x = 0,
  y = 0,
  start = 0,
  dur = 45,
}) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const value = interpolate(frame, [start, start + Math.max(1, dur)], [from, to], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(ease[0], ease[1], ease[2], ease[3]),
  });
  return (
    <div
      data-motion-box
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: "max-content",
        transform: align === "center" ? "translateX(-50%)" : align === "right" ? "translateX(-100%)" : undefined,
        fontFamily: font ?? theme.fontDisplay,
        fontSize: size,
        fontWeight: weight,
        color: color ?? theme.text,
        fontVariantNumeric: "tabular-nums",
        lineHeight: 1,
        whiteSpace: "pre",
        opacity: frame < start ? 0 : 1,
      }}
    >
      {prefix}
      {formatCount(value, decimals, thousands, pad)}
      {suffix}
    </div>
  );
};
