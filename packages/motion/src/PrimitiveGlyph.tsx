/**
 * @chroma/motion — `PrimitiveGlyph` (extracted D-176 from `CatalogPanel.tsx`,
 * D-151's original home for it).
 *
 * A tiny, deterministic, theme-token-coloured SVG icon per primitive `use` —
 * "which of these eight is the grid one" at a glance, zero runtime cost.
 * Originally `CatalogPanel.tsx`'s own private helper; pulled out into its own
 * module once `LayerThumbnail.tsx` (D-176) needed the SAME glyph as its
 * fallback for the three 3D-only primitives (`particleflow`/`labelbox`/
 * `layerstack`) — see that file's own doc comment for why those three never
 * get a live thumbnail (the identical WebGL-context-ceiling reasoning
 * `CatalogPanel.tsx`'s own module doc comment already established for THIS
 * panel, now shared rather than re-derived). One glyph set, two consumers,
 * per CLAUDE.md's "if two places need it, extract it."
 */
import type { PrimitiveUse } from './catalog';

export function PrimitiveGlyph({ use }: { use: PrimitiveUse }) {
  const common = {
    width: 24,
    height: 24,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  switch (use) {
    case 'text':
      return (
        <svg {...common}>
          <path d="M4 7h16M12 7v11M8.5 18h7" />
        </svg>
      );
    case 'emphasis':
      return (
        <svg {...common}>
          <ellipse cx="12" cy="12" rx="8.5" ry="6" transform="rotate(-8 12 12)" />
          <path d="M4.5 15.5c3 2 12 2.5 15.5-.5" opacity="0.55" />
        </svg>
      );
    case 'matrix':
      return (
        <svg {...common}>
          <rect x="3.5" y="3.5" width="17" height="17" rx="1.5" />
          <path d="M9.2 3.5v17M14.8 3.5v17M3.5 9.2h17M3.5 14.8h17" opacity="0.65" />
          <rect x="9.2" y="9.2" width="5.6" height="5.6" fill="currentColor" opacity="0.35" stroke="none" />
        </svg>
      );
    case 'graph':
      return (
        <svg {...common}>
          <circle cx="5" cy="7" r="2.2" />
          <circle cx="19" cy="9" r="2.2" />
          <circle cx="11" cy="18" r="2.2" />
          <path d="M7 7.6l9.8 1.1M17.6 11l-5 5.3M9.4 16.2L6 9.2" opacity="0.7" />
        </svg>
      );
    case 'layers':
      return (
        <svg {...common}>
          <path d="M3.5 8.5l8.5-3.5 8.5 3.5-8.5 3.5z" />
          <path d="M3.5 13l8.5 3.5 8.5-3.5" opacity="0.7" />
          <path d="M3.5 17l8.5 3.5 8.5-3.5" opacity="0.4" />
        </svg>
      );
    case 'particleflow':
      return (
        <svg {...common} strokeWidth={0} fill="currentColor">
          <circle cx="4" cy="12" r="1.5" />
          <circle cx="9" cy="8.5" r="1.2" opacity="0.85" />
          <circle cx="9.5" cy="15.5" r="1.1" opacity="0.7" />
          <circle cx="14.5" cy="11" r="1.3" opacity="0.85" />
          <circle cx="15" cy="17" r="1" opacity="0.5" />
          <circle cx="20" cy="7.5" r="1.5" />
          <circle cx="20.5" cy="13.5" r="1.1" opacity="0.6" />
        </svg>
      );
    case 'labelbox':
      return (
        <svg {...common}>
          <path d="M4 9l8-4 8 4v6l-8 4-8-4z" />
          <path d="M4 9l8 4 8-4M12 13v6" opacity="0.65" />
        </svg>
      );
    case 'layerstack':
      return (
        <svg {...common}>
          <path d="M3.5 6.5l8.5-2.5 8.5 2.5-8.5 2.5z" opacity="0.5" />
          <path d="M3.5 12l8.5-2.5 8.5 2.5-8.5 2.5z" />
          <path d="M3.5 17.5l8.5-2.5 8.5 2.5-8.5 2.5z" opacity="0.5" />
        </svg>
      );
  }
}
