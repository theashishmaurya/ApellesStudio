import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { evolvePath, getLength } from "@remotion/paths";
import rough from "roughjs";
import type { ComponentProps } from "@apelles/component";

type Props = {
  text: string;
  shape: "box" | "circle" | "underline" | "arrow";
  seed: number;
  roughness: number;
  color?: string;
  textColor?: string;
};

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** Average glyph width as a share of the font size: close enough to size a
 *  marker shape around a label without measuring the DOM (which would differ
 *  between renders). */
const GLYPH_WIDTH = 0.56;

/**
 * A hand-drawn callout: a label with a marker-style box, circle, underline or
 * arrow drawn on around it. The wobble comes from roughjs with a fixed `seed`
 * (so every render draws the same lines); the strokes draw on one after
 * another over the first second. Colours and fonts come from the theme unless
 * a colour is set.
 */
export default function SketchCallout({ props, theme, width, height }: ComponentProps<Props>) {
  const frame = useCurrentFrame();
  // Shrink the lettering so a long label fits the room the shape leaves it.
  const room = width * (props.shape === "arrow" ? 0.62 : 0.8);
  const fontSize = Math.round(Math.min(height * 0.2, room / (Math.max(1, props.text.length) * GLYPH_WIDTH)));
  const strokeWidth = Math.max(theme.strokeWidth, height * 0.012);
  const ink = props.color ?? theme.accentSignal;
  const textInk = props.textColor ?? theme.text;
  const gen = rough.generator();

  const textW = props.text.length * fontSize * GLYPH_WIDTH;
  const cy = height / 2;
  // The arrow shape pushes the label to the right to leave room for the shaft.
  const cx = props.shape === "arrow" ? width * 0.6 : width / 2;
  const pad = fontSize * 0.45;
  const style = { roughness: props.roughness, bowing: theme.bowing, strokeWidth };

  const drawables = (() => {
    switch (props.shape) {
      case "circle":
        return [
          gen.ellipse(cx, cy, textW + pad * 2.6, fontSize * 2.1, { seed: props.seed, ...style }),
          gen.ellipse(cx, cy, textW + pad * 2.8, fontSize * 2.2, { seed: props.seed + 1, ...style }),
        ];
      case "underline": {
        const y = cy + fontSize * 0.72;
        return [
          gen.line(cx - textW / 2 - pad, y, cx + textW / 2 + pad, y, { seed: props.seed, ...style }),
          gen.line(cx - textW / 2, y + strokeWidth * 2.2, cx + textW / 2 + pad * 0.6, y + strokeWidth * 1.6, { seed: props.seed + 1, ...style }),
        ];
      }
      case "arrow": {
        const tail = { x: width * 0.06, y: cy + fontSize * 0.5 };
        const tip = { x: cx - textW / 2 - pad * 1.2, y: cy };
        const head = fontSize * 0.45;
        const angle = Math.atan2(tip.y - tail.y, tip.x - tail.x);
        return [
          gen.line(tail.x, tail.y, tip.x, tip.y, { seed: props.seed, ...style }),
          gen.linearPath(
            [
              [tip.x - head * Math.cos(angle - 0.5), tip.y - head * Math.sin(angle - 0.5)],
              [tip.x, tip.y],
              [tip.x - head * Math.cos(angle + 0.5), tip.y - head * Math.sin(angle + 0.5)],
            ],
            { seed: props.seed + 1, ...style },
          ),
        ];
      }
      default:
        return [
          gen.rectangle(cx - textW / 2 - pad, cy - fontSize * 0.85, textW + pad * 2, fontSize * 1.7, { seed: props.seed, ...style }),
          gen.rectangle(cx - textW / 2 - pad * 0.9, cy - fontSize * 0.8, textW + pad * 1.8, fontSize * 1.6, { seed: props.seed + 1, ...style }),
        ];
    }
  })();

  // A dash pattern restarts at every subpath, and rough.js packs several
  // strokes into one path, so draw each subpath on its own, one after another
  // like a pen, each taking the share of the draw-on its length deserves.
  const segments = drawables
    .flatMap((d) => gen.toPaths(d))
    .filter((p) => p.stroke !== "none")
    .flatMap((p) => p.d.split(/(?=M)/).filter((d) => d.length > 1))
    .map((d) => ({ d, length: getLength(d) }));
  const totalLength = segments.reduce((sum, seg) => sum + seg.length, 0);

  const textIn = interpolate(frame, [0, 10], [0, 1], clamp);
  const draw = interpolate(frame, [8, 38], [0, 1], clamp);

  return (
    <AbsoluteFill>
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        {segments.map((seg, i) => {
          const before = segments.slice(0, i).reduce((sum, other) => sum + other.length, 0);
          const t = seg.length > 0 ? Math.min(1, Math.max(0, (draw * totalLength - before) / seg.length)) : 1;
          const evolved = evolvePath(t, seg.d);
          return (
            <path
              key={i}
              d={seg.d}
              fill="none"
              stroke={ink}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={evolved.strokeDasharray}
              strokeDashoffset={evolved.strokeDashoffset}
              opacity={t > 0 ? 1 : 0}
            />
          );
        })}
      </svg>
      <div
        style={{
          position: "absolute",
          left: cx - textW / 2 - pad,
          width: textW + pad * 2,
          top: cy - fontSize * 0.65,
          height: fontSize * 1.3,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: theme.fontDisplay,
          fontSize,
          lineHeight: 1,
          color: textInk,
          opacity: textIn,
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        {props.text}
      </div>
    </AbsoluteFill>
  );
}
