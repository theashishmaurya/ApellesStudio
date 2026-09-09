/**
 * The small SVG marks the `claudechat` primitive draws (D-258).
 *
 * What it is: the sunburst asterisk, the chip/tool icons, and the input-bar
 * icon row, each traced from the owner's reference screenshot of the real
 * Claude iOS app rather than approximated from memory. Split out of
 * `ClaudeChat.tsx` so that file stays about layout and animation, the same
 * split `PrimitiveGlyph.tsx` already makes on the editor side.
 *
 * What it does NOT do: no animation, no state, no layout — every export here
 * is a pure, size-parameterised mark.
 */
import React from "react";

/** Claude's sunburst asterisk. Twelve tapered rays on a shared centre; ray
 *  count and proportions match the mark in the reference (12 rays, inner gap
 *  ~18% of the radius, ray width ~8% of it). */
export const Sunburst: React.FC<{ size: number; color: string; rays?: number }> = ({
  size,
  color,
  rays = 12,
}) => {
  const r = size / 2;
  const inner = r * 0.16;
  const w = Math.max(1, r * 0.155);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <g transform={`translate(${r} ${r})`}>
        {Array.from({ length: rays }, (_, i) => {
          const a = (i * 360) / rays;
          return (
            <line
              key={i}
              x1={0}
              y1={-inner}
              x2={0}
              y2={-r * 0.94}
              stroke={color}
              strokeWidth={w}
              strokeLinecap="round"
              transform={`rotate(${a})`}
            />
          );
        })}
      </g>
    </svg>
  );
};

/** The Google Drive trimark, in its real four colours — the icon on the
 *  "Searched Google Drive" chip in the reference. */
export const DriveMark: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
    <path d="M16.2 6h15.6l15.6 27h-15.6z" fill="#ffcf63" />
    <path d="M16.2 6 .6 33l7.8 9L24 15z" fill="#4688f4" />
    <path d="M8.4 42h31.2l7.8-9H16.2z" fill="#2ba24c" />
  </svg>
);

type IconProps = { size: number; color: string; strokeWidth?: number };

const svg = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none" as const,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

export const SearchIcon: React.FC<IconProps> = ({ size, color, strokeWidth = 1.7 }) => (
  <svg {...svg(size)} stroke={color} strokeWidth={strokeWidth}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M15.8 15.8 20.5 20.5" />
    <path d="M8.4 11.6c1.6 1.6 3.6-1.2 5.2.4" opacity={0.85} />
  </svg>
);

export const PlusIcon: React.FC<IconProps> = ({ size, color, strokeWidth = 1.7 }) => (
  <svg {...svg(size)} stroke={color} strokeWidth={strokeWidth}>
    <path d="M12 5.5v13M5.5 12h13" />
  </svg>
);

export const SlidersIcon: React.FC<IconProps> = ({ size, color, strokeWidth = 1.7 }) => (
  <svg {...svg(size)} stroke={color} strokeWidth={strokeWidth}>
    <path d="M3.5 8h11M18 8h2.5M3.5 16h5M12 16h8.5" />
    <circle cx="16" cy="8" r="2" />
    <circle cx="10" cy="16" r="2" />
  </svg>
);

export const MicIcon: React.FC<IconProps> = ({ size, color, strokeWidth = 1.7 }) => (
  <svg {...svg(size)} stroke={color} strokeWidth={strokeWidth}>
    <rect x="9" y="3" width="6" height="10.5" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" />
  </svg>
);

export const ChevronDownIcon: React.FC<IconProps> = ({ size, color, strokeWidth = 1.9 }) => (
  <svg {...svg(size)} stroke={color} strokeWidth={strokeWidth}>
    <path d="M6.5 9.5 12 15l5.5-5.5" />
  </svg>
);

export const BackIcon: React.FC<IconProps> = ({ size, color, strokeWidth = 2.1 }) => (
  <svg {...svg(size)} stroke={color} strokeWidth={strokeWidth}>
    <path d="M14.5 5 8 12l6.5 7" />
  </svg>
);

/** the "new chat" mark at the top-right of the reference header — a rounded
 *  speech bubble with a plus inside it. */
export const NewChatIcon: React.FC<IconProps> = ({ size, color, strokeWidth = 1.6 }) => (
  <svg {...svg(size)} stroke={color} strokeWidth={strokeWidth}>
    <path d="M20.5 12.4c0 4.1-3.8 7.4-8.5 7.4-1 0-2-.15-2.9-.42L4.2 20.6l1.3-3.4A7 7 0 0 1 3.5 12.4C3.5 8.3 7.3 5 12 5s8.5 3.3 8.5 7.4Z" />
    <path d="M12 9.3v6.2M8.9 12.4h6.2" />
  </svg>
);

export const WebIcon: React.FC<IconProps> = ({ size, color, strokeWidth = 1.6 }) => (
  <svg {...svg(size)} stroke={color} strokeWidth={strokeWidth}>
    <circle cx="12" cy="12" r="8.2" />
    <path d="M3.8 12h16.4M12 3.8c2.2 2.3 3.3 5.2 3.3 8.2S14.2 17.9 12 20.2c-2.2-2.3-3.3-5.2-3.3-8.2S9.8 6.1 12 3.8Z" />
  </svg>
);

export const CodeIcon: React.FC<IconProps> = ({ size, color, strokeWidth = 1.7 }) => (
  <svg {...svg(size)} stroke={color} strokeWidth={strokeWidth}>
    <path d="M9 7.5 4.5 12 9 16.5M15 7.5 19.5 12 15 16.5" />
  </svg>
);

export const DocIcon: React.FC<IconProps> = ({ size, color, strokeWidth = 1.6 }) => (
  <svg {...svg(size)} stroke={color} strokeWidth={strokeWidth}>
    <path d="M13.5 3.5H7.2A1.7 1.7 0 0 0 5.5 5.2v13.6a1.7 1.7 0 0 0 1.7 1.7h9.6a1.7 1.7 0 0 0 1.7-1.7V8.5Z" />
    <path d="M13.5 3.5v5h5" />
    <path d="M8.6 13h6.8M8.6 16.4h4.6" opacity={0.75} />
  </svg>
);

/** the miniature page preview drawn at the right edge of a document card in
 *  the reference — deterministic ruled lines, no randomness. */
export const PagePreview: React.FC<{ width: number; height: number; color: string }> = ({
  width,
  height,
  color,
}) => {
  const pad = width * 0.14;
  const rows = Math.max(4, Math.floor((height - pad * 2) / (height * 0.085)));
  const step = (height - pad * 2) / rows;
  return (
    <svg width={width} height={height} aria-hidden>
      {Array.from({ length: rows }, (_, i) => {
        // a deterministic ragged right edge, so it reads as prose, not a grid
        const w = (width - pad * 2) * (i % 4 === 3 ? 0.55 : i % 3 === 1 ? 0.92 : 1);
        return (
          <rect
            key={i}
            x={pad}
            y={pad + i * step}
            width={w}
            height={Math.max(1, step * 0.34)}
            fill={color}
            opacity={i === 0 ? 0.75 : 0.42}
          />
        );
      })}
    </svg>
  );
};

export const toolIcon = (
  icon: string | undefined,
  size: number,
  color: string,
): React.ReactNode => {
  switch (icon) {
    case "drive":
      return <DriveMark size={size} />;
    case "search":
      return <SearchIcon size={size} color={color} />;
    case "web":
      return <WebIcon size={size} color={color} />;
    case "code":
      return <CodeIcon size={size} color={color} />;
    case "doc":
      return <DocIcon size={size} color={color} />;
    case "none":
      return null;
    default:
      return <SearchIcon size={size} color={color} />;
  }
};
