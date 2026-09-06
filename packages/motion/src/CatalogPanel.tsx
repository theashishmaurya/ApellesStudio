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
 * **Why glyphs and not live thumbnails, for the 3D three specifically.** The
 * ideal catalog row is a real rendered preview of the primitive. It was
 * considered and rejected for THIS panel on real grounds, not effort: three
 * of the eight (`particleflow`, `labelbox`, `layerstack`) only render inside
 * `<Scene3D>`, i.e. a `@remotion/three` `<ThreeCanvas>` — a live WebGL
 * context each. Browsers cap simultaneous WebGL contexts (commonly 8–16)
 * and `MotionPreview`'s player already holds one, so a sidebar of eight
 * always-mounted previews would sit on that ceiling permanently, for a panel
 * that is idle most of the time. So: hand-drawn inline SVG (`PrimitiveGlyph`,
 * now its own module — see D-176's note below) that shows each primitive's
 * actual *shape*, deterministic, theme-token-coloured, zero runtime cost.
 *
 * **Correction, D-176 (`LayerList.tsx`'s own new `LayerThumbnail.tsx`):**
 * this doc comment previously also claimed "`@remotion/player` exposes no
 * cheap render-one-still API to this package" — that turned out to be
 * *wrong*, found while building a real per-row thumbnail for `LayerList`:
 * `@remotion/player` ships exactly that, `Thumbnail` (confirmed by reading
 * its own source — a genuinely static single-frame render, no
 * `requestAnimationFrame` loop, real Remotion context via the same
 * `SharedPlayerContexts` the full `<Player>` uses). `LayerThumbnail.tsx`
 * uses it for the 2D five. It changes nothing about THIS panel's own WebGL-
 * context ceiling reasoning above, which is specifically about the 3D three
 * and remains the reason `LayerThumbnail.tsx` ALSO falls back to this same
 * `PrimitiveGlyph` for exactly those three, never a live `<ThreeCanvas>`
 * thumbnail — see that file's own doc comment for the fuller writeup. Left
 * un-revisited for the Catalog panel itself (a live-but-idle-most-of-the-time
 * sidebar of 2D previews is a separate, smaller design call this pass didn't
 * need to make to ship the reorder/thumbnail work it was scoped for).
 *
 * Not `@chroma/ui`: same documented `@react-three/fiber` JSX-typing conflict
 * every other file in this package works around — see `Button.tsx` and
 * `resizable.tsx`.
 */
import type { PrimitiveUse } from './catalog';
import { catalogEntries } from './catalog';
import { PrimitiveGlyph } from './PrimitiveGlyph';

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
