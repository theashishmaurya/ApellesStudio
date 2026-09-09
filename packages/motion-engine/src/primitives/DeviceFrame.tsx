/**
 * DeviceFrame — a phone body: rounded chassis, titanium rim, Dynamic Island
 * or notch, home indicator. Generic and content-agnostic (D-258).
 *
 * What it is: the mobile CHROME on its own. It knows nothing about chat, or
 * about any other primitive — you can put a screenshot, a `text` layer, a
 * `matrix`, or nothing at all behind it. Its screen area is a real hole
 * (a rounded box drawn as a `border`, so the middle is transparent), which is
 * what makes the decoupling work at manifest level: place the content layer
 * FIRST and this frame AFTER it in `scene.layers`, and the bezel draws over
 * the content while the glass area shows it through.
 *
 * Two ways to fill it, both supported on purpose:
 *   - composition (the manifest way) — a separate layer positioned at
 *     `deviceScreenRect(...)`, with this frame drawn on top. Nothing is
 *     nested, nothing is hardwired, either layer can be selected, moved and
 *     keyframed alone.
 *   - children (the React way) — `<DeviceFrame><Anything/></DeviceFrame>`
 *     clips its children to the glass. Used by `ClaudeChatDemo.tsx`.
 *
 * What it does NOT do: it does not scroll, mask, or animate its contents, and
 * it has no opinion about what a screen contains. It also does not compute
 * its own geometry — that lives in `../lib/device.ts` so `ClaudeChat` can ask
 * the same question and get the same answer.
 *
 *   <DeviceFrame model="iphone-15-pro" x={960} y={540} scale={1.05} />
 *
 * `data-motion-box` (D-155) marks the body element: it is the primitive's one
 * real bounding box, which is what the visual builder's click/drag hit-test
 * walks up to.
 */
import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { inAt, pop } from "../lib/draw";
import { deviceBodyRect, deviceScreenRect, deviceSpec, type NotchStyle } from "../lib/device";

export const DeviceFrame: React.FC<{
  model?: string;
  /** centre of the body in world px; omit to centre on the canvas */
  x?: number;
  y?: number;
  scale?: number;
  /** chassis colour — the reference phone is near-black titanium */
  bodyColor?: string;
  /** the hairline rim just outside the chassis */
  rimColor?: string;
  /** paint behind the glass. `"transparent"` (the default) is what lets a
   *  separately-placed content layer show through from underneath. */
  screenColor?: string;
  /** override the model's own notch treatment */
  notch?: NotchStyle;
  notchColor?: string;
  homeIndicator?: boolean;
  /** drop-shadow strength, 0 disables it */
  shadow?: number;
  /** draw the volume / side buttons on the chassis edges */
  buttons?: boolean;
  /** entrance, in frames */
  start?: number;
  children?: React.ReactNode;
}> = ({
  model = "iphone-15-pro",
  x,
  y,
  scale = 1,
  bodyColor = "#0b0b0c",
  rimColor = "#3a3a3e",
  screenColor = "transparent",
  notch,
  notchColor = "#000000",
  homeIndicator,
  shadow = 0.45,
  buttons = true,
  start = 0,
  children,
}) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const cx = x ?? width / 2;
  const cy = y ?? height / 2;

  const spec = deviceSpec(model);
  const place = { model, x: cx, y: cy, scale };
  const body = deviceBodyRect(place);
  const screen = deviceScreenRect(place);
  const bezel = spec.bezel * scale;

  const appear = inAt(frame, start, start + 14);
  const s = pop(frame, fps, start);
  const notchStyle: NotchStyle = notch ?? spec.notch;

  return (
    <div
      data-motion-box
      style={{
        position: "absolute",
        left: body.x,
        top: body.y,
        width: body.width,
        height: body.height,
        opacity: appear,
        transform: `scale(${0.96 + 0.04 * s})`,
        transformOrigin: "50% 50%",
      }}
    >
      {/* content, clipped to the glass — only when children are nested */}
      {children ? (
        <div
          style={{
            position: "absolute",
            left: bezel,
            top: bezel,
            width: screen.width,
            height: screen.height,
            borderRadius: screen.radius,
            overflow: "hidden",
          }}
        >
          {children}
        </div>
      ) : null}

      {/* the chassis, drawn as a ring so the glass area stays a real hole */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          boxSizing: "border-box",
          border: `${bezel}px solid ${bodyColor}`,
          borderRadius: body.radius,
          background: screenColor,
          backgroundClip: "padding-box",
          boxShadow: [
            `0 0 0 ${1.4 * scale}px ${rimColor}`,
            shadow > 0 ? `0 ${26 * scale}px ${60 * scale}px rgba(0,0,0,${shadow})` : "",
          ]
            .filter(Boolean)
            .join(", "),
        }}
      />

      {/* Dynamic Island / notch / punch-hole, positioned against the glass */}
      {notchStyle !== "none" && (
        <div
          style={{
            position: "absolute",
            top:
              notchStyle === "notch"
                ? bezel
                : bezel + spec.notchTop * scale,
            left:
              notchStyle === "punch-hole"
                ? bezel + screen.width / 2 - (spec.notchW * scale) / 2
                : body.width / 2 - (spec.notchW * scale) / 2,
            width: spec.notchW * scale,
            height: spec.notchH * scale,
            background: notchColor,
            borderRadius:
              notchStyle === "notch"
                ? `0 0 ${18 * scale}px ${18 * scale}px`
                : (spec.notchH * scale) / 2,
          }}
        />
      )}

      {(homeIndicator ?? spec.homeIndicator) && (
        <div
          style={{
            position: "absolute",
            bottom: bezel + 8 * scale,
            left: body.width / 2 - 67 * scale,
            width: 134 * scale,
            height: 5 * scale,
            borderRadius: 3 * scale,
            background: "rgba(0,0,0,0.32)",
          }}
        />
      )}

      {buttons && (
        <>
          {/* action + volume, left edge */}
          <Button side="left" top={148 * scale} len={32 * scale} scale={scale} color={rimColor} />
          <Button side="left" top={208 * scale} len={62 * scale} scale={scale} color={rimColor} />
          <Button side="left" top={286 * scale} len={62 * scale} scale={scale} color={rimColor} />
          {/* power, right edge */}
          <Button side="right" top={238 * scale} len={96 * scale} scale={scale} color={rimColor} />
        </>
      )}
    </div>
  );
};

const Button: React.FC<{
  side: "left" | "right";
  top: number;
  len: number;
  scale: number;
  color: string;
}> = ({ side, top, len, scale, color }) => (
  <div
    style={{
      position: "absolute",
      top,
      left: side === "left" ? -2.5 * scale : undefined,
      right: side === "right" ? -2.5 * scale : undefined,
      width: 3 * scale,
      height: len,
      background: color,
      borderRadius: 2 * scale,
    }}
  />
);
