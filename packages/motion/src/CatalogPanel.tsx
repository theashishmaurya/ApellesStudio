/**
 * @chroma/motion — the Catalog panel (D-151).
 *
 * What it is: a browsable list of every primitive the motion engine can
 * render (`catalog.ts`, exhaustive against the engine's own `use` enum),
 * each with a name, a real one-line description, a small deterministic SVG
 * glyph, and an Add button that inserts a schema-valid instance of it into
 * the currently-selected scene.
 *
 * What it does NOT do: it does not construct the manifest fragment
 * (`catalog.ts`'s `defaultLayerFor`) and it does not perform the insert
 * (`manifestEdit.ts`'s `addLayer`). This file is presentation plus one
 * callback — the same separation `InspectorPanel.tsx` keeps from
 * `manifestEdit.ts`, and the reason the insert logic is unit-testable
 * without React.
 *
 * **Why glyphs and not live thumbnails.** The ideal catalog row is a real
 * rendered preview of the primitive. It was considered and rejected for this
 * pass on real grounds, not effort: three of the eight (`particleflow`,
 * `labelbox`, `layerstack`) only render inside `<Scene3D>`, i.e. a
 * `@remotion/three` `<ThreeCanvas>` — a live WebGL context each. Browsers cap
 * simultaneous WebGL contexts (commonly 8–16) and `MotionPreview`'s player
 * already holds one, so a sidebar of eight always-mounted previews would sit
 * on that ceiling permanently, for a panel that is idle most of the time.
 * `@remotion/player` also exposes no cheap render-one-still API to this
 * package — the still renderer is the Node/CLI path (`@remotion/renderer`),
 * not something the tab can call per row. So: hand-drawn inline SVG that
 * shows each primitive's actual *shape* (a grid for `matrix`, nodes and
 * edges for `graph`, tilted cards for `layers`, a point stream for
 * `particleflow`), deterministic, theme-token-coloured, zero runtime cost.
 * A real thumbnail pass — most plausibly pre-rendered stills committed as
 * assets, generated from each `*Demo` composition — is a genuine future
 * improvement and is named as such in `docs/notes/motion-tab-audit.md`
 * rather than pretended away.
 *
 * Not `@chroma/ui`: same documented `@react-three/fiber` JSX-typing conflict
 * every other file in this package works around — see `Button.tsx` and
 * `resizable.tsx`.
 */
import type { PrimitiveUse } from './catalog';
import { catalogEntries } from './catalog';

/**
 * A tiny shape-suggesting icon per primitive, on a 24×24 grid. Deliberately
 * schematic rather than pretty: the job is "which of these eight is the grid
 * one" at a glance. `currentColor` throughout so each glyph inherits the
 * row's own text colour and therefore tracks the theme without a second
 * palette.
 */
function PrimitiveGlyph({ use }: { use: PrimitiveUse }) {
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

/**
 * `sceneLabel` names the insert target in the panel header, so "Add" is
 * never a mystery about *where*. A `null` target cannot normally happen (the
 * schema guarantees `scenes.min(1)` and the caller falls back to the last
 * scene), but it is handled rather than asserted — the raw-JSON textarea can
 * put the manifest in any shape at any moment.
 */
export function CatalogPanel({
  targetSceneId,
  onAdd,
}: {
  targetSceneId: string | null;
  onAdd: (use: PrimitiveUse) => void;
}) {
  return (
    <div className="h-full w-full flex flex-col min-h-0">
      <div className="shrink-0 px-2 py-2 border-b border-border-color">
        <p className="text-[10px] text-text-secondary/70 leading-relaxed">
          {targetSceneId
            ? <>Adds to scene <span className="text-text-primary">{targetSceneId}</span>. Pick a scene in Layers to change the target.</>
            : 'No scene to add to — the manifest has no scenes.'}
        </p>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 flex flex-col gap-1.5">
        {catalogEntries.map((entry) => (
          <div
            key={entry.use}
            className="group rounded border border-border-color p-2 flex flex-col gap-1.5 hover:border-accent/60 transition-colors"
          >
            <div className="flex items-start gap-2">
              <span className="shrink-0 text-text-secondary group-hover:text-accent transition-colors">
                <PrimitiveGlyph use={entry.use} />
              </span>
              <div className="min-w-0 flex flex-col gap-0.5">
                <span className="text-[11px] font-medium text-text-primary leading-tight">{entry.name}</span>
                <span className="text-[10px] text-text-secondary/70 font-mono leading-tight">
                  {entry.use}
                  {entry.in3d ? ' · 3D' : ''}
                </span>
              </div>
            </div>

            <p className="text-[10px] text-text-secondary leading-snug">{entry.description}</p>

            <button
              type="button"
              disabled={targetSceneId === null}
              className="h-6 rounded border border-dashed border-border-color text-[10px] text-text-secondary hover:text-text-primary hover:border-accent disabled:opacity-40 disabled:hover:text-text-secondary disabled:hover:border-border-color transition-colors"
              onClick={() => onAdd(entry.use)}
            >
              + Add to scene
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
