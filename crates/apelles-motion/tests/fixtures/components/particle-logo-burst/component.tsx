import { AbsoluteFill, Easing, interpolate, random, spring, useCurrentFrame, useVideoConfig } from "remotion";
import type { ComponentProps } from "@apelles/component";

type Props = {
  text: string;
  count: number;
  seed: number;
  spread: number;
  color?: string;
  textColor?: string;
};

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/**
 * A logo word punches in while a seeded burst of particles flies out from
 * behind it, arcs down a little and settles into a faint halo. Every particle's
 * angle, distance, size and delay comes from Remotion's seeded random(), so the
 * same props draw the same burst on every frame of every render.
 */
export default function ParticleLogoBurst({ props, theme, width, height, durationInFrames }: ComponentProps<Props>) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cx = width / 2;
  const cy = height / 2;
  const ink = props.color ?? theme.accent;
  const spark = theme.accentSignal;
  const textInk = props.textColor ?? theme.text;

  const burst = interpolate(frame, [0, durationInFrames * 0.6], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const settle = interpolate(frame, [durationInFrames * 0.45, durationInFrames], [1, 0.25], clamp);
  const logo = spring({ frame: frame - 4, fps, config: { damping: 13, stiffness: 140 } });
  const glow = interpolate(frame, [0, 10, durationInFrames * 0.5], [0, 1, 0.35], clamp);

  const count = Math.max(0, Math.round(props.count));
  const particles = Array.from({ length: count }, (_, i) => {
    const key = `${props.seed}-${i}`;
    const angle = random(`angle-${key}`) * Math.PI * 2;
    const reach = (0.2 + 0.8 * random(`reach-${key}`)) * props.spread;
    const size = 2.5 + random(`size-${key}`) * 7;
    const delay = random(`delay-${key}`) * 0.3;
    const p = Math.max(0, Math.min(1, (burst - delay) / (1 - delay)));
    const x = cx + Math.cos(angle) * reach * p;
    const y = cy + Math.sin(angle) * reach * p * 0.72 + 60 * p * p;
    const opacity = p === 0 ? 0 : settle * (0.45 + 0.55 * random(`alpha-${key}`));
    return { x, y, r: size * (1.2 - 0.5 * p), opacity, hot: random(`hot-${key}`) > 0.82 };
  });

  const fontSize = Math.min(height * 0.26, (width * 0.8) / Math.max(1, props.text.length * 0.8));
  return (
    <AbsoluteFill>
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        <circle cx={cx} cy={cy} r={Math.max(1, props.spread * 0.55 * burst)} fill="none" stroke={ink} strokeOpacity={0.35 * glow} strokeWidth={3} />
        {particles.map((pt, i) => (
          <circle key={i} cx={pt.x} cy={pt.y} r={pt.r} fill={pt.hot ? spark : ink} opacity={pt.opacity} />
        ))}
      </svg>
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <span
          style={{
            fontFamily: theme.fontDisplay,
            fontSize,
            fontWeight: 800,
            letterSpacing: fontSize * 0.04,
            color: textInk,
            transform: `scale(${0.6 + 0.4 * logo})`,
            opacity: Math.min(1, logo * 1.4),
            textShadow: `0 0 ${Math.round(fontSize * 0.35 * glow)}px ${ink}`,
            whiteSpace: "nowrap",
          }}
        >
          {props.text}
        </span>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
