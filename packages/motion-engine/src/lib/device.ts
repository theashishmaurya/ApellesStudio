/**
 * Device geometry — the one source of truth for "where is a phone's screen".
 *
 * What it is: a small table of real device dimensions (in the device's OWN
 * logical points, not invented numbers) plus the pure functions that turn a
 * `{model, x, y, scale}` placement into the body rect and the screen rect it
 * contains.
 *
 * What it does NOT do: it draws nothing (that is `primitives/DeviceFrame.tsx`)
 * and it knows nothing about what goes on the screen (that is any other
 * primitive). It exists as its own module precisely because TWO primitives
 * need the identical answer — `DeviceFrame` to draw the bezel, and
 * `ClaudeChat` to size itself to the screen it is being dropped into — and
 * CLAUDE.md's "if two places need it, extract it" forbids copy-pasting the
 * arithmetic into both. That shared answer is what lets the two primitives
 * stay DECOUPLED (D-258): they compose by agreeing on a rect, not by one
 * containing the other.
 *
 * Determinism: pure arithmetic on the inputs, no clock, no randomness, no
 * DOM measurement — the same placement always yields the same rect, which is
 * what the render-path determinism invariant requires.
 *
 * D-258.
 */

/** Notch treatment across the phone generations we model. */
export type NotchStyle = "dynamic-island" | "notch" | "punch-hole" | "none";

export type DeviceModel = "iphone-15-pro" | "iphone-15-pro-max" | "iphone-se" | "pixel-8" | "generic";

export interface DeviceSpec {
  /** body width/height in the device's own logical points */
  bodyW: number;
  bodyH: number;
  /** outer body corner radius, same units */
  bodyRadius: number;
  /** uniform bezel between the body edge and the glass */
  bezel: number;
  /** screen corner radius (always tighter than the body's by the bezel) */
  screenRadius: number;
  notch: NotchStyle;
  /** notch/island size + its gap from the top of the SCREEN */
  notchW: number;
  notchH: number;
  notchTop: number;
  /** does this model draw a home indicator bar at the bottom of the screen */
  homeIndicator: boolean;
}

/**
 * Real logical-point dimensions, not eyeballed ones: iPhone 15 Pro is
 * 393x852 pt, 15 Pro Max 430x932 pt, SE (3rd gen) 375x667 pt, Pixel 8
 * 412x915 dp. The Dynamic Island is 125x36 pt sitting 11 pt below the top of
 * the glass. `bezel` is the one number measured off the owner's reference
 * screenshot rather than published (Apple does not publish it): the body in
 * that image is 264 px wide for a 393 pt-wide screen (0.672 px/pt) with an
 * ~8 px black edge, i.e. ~12 pt.
 */
export const DEVICE_SPECS: Record<DeviceModel, DeviceSpec> = {
  "iphone-15-pro": {
    bodyW: 393,
    bodyH: 852,
    bodyRadius: 62,
    bezel: 12,
    screenRadius: 50,
    notch: "dynamic-island",
    notchW: 125,
    notchH: 36,
    notchTop: 11,
    homeIndicator: true,
  },
  "iphone-15-pro-max": {
    bodyW: 430,
    bodyH: 932,
    bodyRadius: 66,
    bezel: 12,
    screenRadius: 54,
    notch: "dynamic-island",
    notchW: 125,
    notchH: 36,
    notchTop: 11,
    homeIndicator: true,
  },
  "iphone-se": {
    bodyW: 375,
    bodyH: 667,
    bodyRadius: 22,
    bezel: 14,
    screenRadius: 8,
    notch: "none",
    notchW: 0,
    notchH: 0,
    notchTop: 0,
    homeIndicator: false,
  },
  "pixel-8": {
    bodyW: 412,
    bodyH: 915,
    bodyRadius: 44,
    bezel: 11,
    screenRadius: 33,
    notch: "punch-hole",
    notchW: 26,
    notchH: 26,
    notchTop: 12,
    homeIndicator: true,
  },
  generic: {
    bodyW: 400,
    bodyH: 860,
    bodyRadius: 48,
    bezel: 12,
    screenRadius: 36,
    notch: "none",
    notchW: 0,
    notchH: 0,
    notchTop: 0,
    homeIndicator: false,
  },
};

export interface Rect {
  /** top-left in world px */
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
}

/** Resolve a model name, falling back to `generic` for an unknown string so a
 *  hand-authored manifest with a typo still renders something rather than
 *  throwing mid-render. */
export const deviceSpec = (model: string | undefined): DeviceSpec =>
  DEVICE_SPECS[(model ?? "iphone-15-pro") as DeviceModel] ?? DEVICE_SPECS.generic;

export interface DevicePlacement {
  model?: string;
  /** centre of the BODY in world px */
  x: number;
  y: number;
  scale?: number;
}

/** the phone body rect, in world px, centred on `x,y`. */
export function deviceBodyRect({ model, x, y, scale = 1 }: DevicePlacement): Rect {
  const s = deviceSpec(model);
  const width = s.bodyW * scale;
  const height = s.bodyH * scale;
  return {
    x: x - width / 2,
    y: y - height / 2,
    width,
    height,
    radius: s.bodyRadius * scale,
  };
}

/**
 * The screen (glass) rect inside that body, in world px. This is the contract
 * between the two primitives: `DeviceFrame` draws a bezel around exactly this
 * rect, and `ClaudeChat` (or anything else) placed at exactly this rect lands
 * inside the frame's cutout with no manual fiddling.
 */
export function deviceScreenRect(p: DevicePlacement): Rect {
  const s = deviceSpec(p.model);
  const scale = p.scale ?? 1;
  const body = deviceBodyRect(p);
  const inset = s.bezel * scale;
  return {
    x: body.x + inset,
    y: body.y + inset,
    width: body.width - inset * 2,
    height: body.height - inset * 2,
    radius: s.screenRadius * scale,
  };
}
