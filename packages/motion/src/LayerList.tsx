/**
 * @chroma/motion — the layer list (D-081, Phase 1 of
 * `docs/notes/global-inspector.md`).
 *
 * The real prerequisite the Inspector scoping doc identified before any
 * property panel makes sense: something to select. This is a plain,
 * expand-per-scene list — scene → its 2D camera (if any) → its `layers[]`
 * (2D) or its `scene3d` camera + `children[]` (3D) — click any row to select
 * it and jump the player to that scene's start frame
 * (`sceneStartFrame`, `@chroma/motion-engine`'s `build.ts` — the exact same
 * math `<Series>` (`Video.tsx`) uses to lay scenes back to back, not a second
 * guess at it). No property panel consumes `Selection` yet (Phase 2,
 * deferred) — this pass is the selection model + a way to see/pick
 * something, standalone-useful on its own as real scene/layer navigation.
 *
 * Not `@chroma/ui`: see `Button.tsx`'s doc comment for why this package
 * can't use that barrel (a real, documented `@react-three/fiber` JSX-typing
 * conflict) — plain elements on the app's own `--color-*` tokens, matching
 * every other file here.
 *
 * **D-158, Phase 3 of `docs/notes/motion-visual-builder-research.md`:** the
 * thing every consumer holds is now `Selection[]`, not a single `Selection |
 * null` — "the owner said 'multiple elements' first, so this is not
 * optional polish." A real design call, made and documented rather than
 * left implicit: **`Selection[]` is constrained to either (a) exactly one
 * entry of ANY kind (`scene`/`camera`/`scene3d-camera`/`layer`/
 * `scene3d-child` — today's existing single-select, unchanged), or (b) two
 * or more entries that are ALL `{kind:'layer'}` in the SAME scene.** Mixed
 * kinds (a scene plus a layer, a camera plus a layer) and cross-scene
 * layer sets are never produced by anything in this package. Why: a
 * "scene + camera" or "two cameras" multi-selection has no coherent
 * meaning — there is exactly one camera per scene and editing "two things
 * that aren't really two things" is a UI a real user would find baffling,
 * not powerful; `scene3d-child` is excluded from multi-select because 3D
 * on-canvas manipulation is out of scope for every phase this research doc
 * covers (§3b/§4), so there is no canvas gesture that could ever produce
 * one anyway; and restricting to one scene is a hard requirement, not a
 * preference — only the scene currently under the playhead has its layers
 * in the DOM at all (§1e), so a marquee or a canvas shift-click physically
 * cannot reach a layer in a different scene. `toggleSelection` below is
 * where this constraint actually lives (the enforcement point, not just the
 * intent) — see its own doc comment. `MotionCanvasOverlay.tsx`'s doc
 * comment covers the drag/marquee side; `manifestEdit.ts`'s
 * `resolveSelection`/`resolveSelections` cover keeping the array pointing
 * at the right layers as the manifest changes under it.
 */
import type { Manifest, Layer } from '@chroma/motion-engine/src/engine/schema';

/**
 * `id` on the two layer-shaped target kinds is D-158 (Phase 3 of
 * `docs/notes/motion-visual-builder-research.md`, "stable layer identity" —
 * §1g's own finding). It is a SNAPSHOT of `schema.ts`'s new optional
 * `layer.id` field, captured when the selection was made — `undefined` for
 * a layer that has none (every hand-written manifest, and any manifest
 * written before this pass), which is the documented, non-breaking fallback
 * to positional identity `manifestEdit.ts`'s `resolveSelection` already
 * held before `id` existed and still holds when it's absent. `index` is
 * NEVER dropped even when `id` is present — it stays the best-known
 * position (used directly whenever `id` is absent, and as the starting
 * point `resolveSelection` corrects FROM when it IS present but the layer
 * has moved).
 */
export type SelectionTarget =
  | { kind: 'scene' }
  | { kind: 'camera' }
  | { kind: 'scene3d-camera' }
  | { kind: 'layer'; index: number; id?: string }
  | { kind: 'scene3d-child'; index: number; id?: string };

export interface Selection {
  sceneIndex: number;
  target: SelectionTarget;
}

export function sameTarget(a: SelectionTarget, b: SelectionTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'layer' && b.kind === 'layer') return a.index === b.index;
  if (a.kind === 'scene3d-child' && b.kind === 'scene3d-child') return a.index === b.index;
  return true;
}

/** Whole-`Selection` equality (scene + target) — the array-level building
 *  block `MotionCanvasOverlay.tsx`'s multi-select gestures and
 *  `manifestEdit.ts`'s `resolveSelections` both need, once a single
 *  `Selection` stopped being the whole story (D-158, Phase 3). */
export function sameSelection(a: Selection, b: Selection): boolean {
  return a.sceneIndex === b.sceneIndex && sameTarget(a.target, b.target);
}

/** Order-sensitive array equality for `Selection[]` — used ONLY to decide
 *  whether re-resolving the live selection against a freshly committed
 *  manifest actually changed anything (`MotionTab.tsx`'s own effect), so a
 *  no-op resolve doesn't hand back a new array reference and re-render
 *  every selection-consuming panel for nothing. Order matters here (unlike
 *  set equality) because the callers that build these arrays always build
 *  them in a stable, deterministic order (DOM query order for a marquee,
 *  append order for a toggle) — two arrays with the same members in a
 *  different order would mean something actually reordered, which is worth
 *  noticing, not silently treating as "unchanged." */
export function sameSelectionArray(a: Selection[], b: Selection[]): boolean {
  return a.length === b.length && a.every((s, i) => sameSelection(s, b[i]));
}

/**
 * Shift-click membership toggle (D-158, Phase 3 — "shift-click to extend").
 * Removes `sel` if it's already selected; otherwise adds it — but ONLY when
 * doing so keeps the selection in the one shape this build actually
 * supports multiple of: 2+ `{kind:'layer'}` targets in the SAME scene (see
 * this file's own module doc comment on `Selection[]`'s same-kind
 * constraint, and `MotionCanvasOverlay.tsx`'s own doc comment for why —
 * only one scene's layers are ever in the DOM at once, per the research
 * doc's §1e). Shift-clicking a NON-layer target (a scene/camera row), or a
 * layer in a DIFFERENT scene than the current selection, replaces the
 * selection with just that one target instead of trying to build a mixed
 * or cross-scene multi-selection nothing in this Inspector/canvas knows how
 * to render. */
export function toggleSelection(current: Selection[], sel: Selection): Selection[] {
  const idx = current.findIndex((s) => sameSelection(s, sel));
  if (idx !== -1) return current.filter((_, i) => i !== idx);
  if (sel.target.kind !== 'layer') return [sel];
  if (current.length === 0) return [sel];
  const allSameSceneLayers = current.every((s) => s.target.kind === 'layer' && s.sceneIndex === sel.sceneIndex);
  if (!allSameSceneLayers) return [sel];
  return [...current, sel];
}

/** A short, human label for a layer row — `use`, plus its `text` content
 *  when it's a text layer (the one primitive whose main identity is its
 *  copy, not its position) since "text" alone among several text layers in
 *  one scene isn't useful to pick between. `layer` is `.passthrough()`
 *  (`schema.ts`) so per-primitive fields like `text` aren't statically
 *  typed — same cast `registry.ts`'s own adapters already use to read them.
 *  Exported (D-157) so `InspectorPanel.tsx`'s "snap to layer" target picker
 *  can list sibling layers with the SAME label this list already uses,
 *  rather than growing its own second copy of "how do I describe a layer." */
export function layerLabel(layer: Layer): string {
  const raw = layer as unknown as Record<string, unknown>;
  if (layer.use === 'text' && typeof raw.text === 'string') {
    const text = raw.text as string;
    return `text: "${text.length > 24 ? text.slice(0, 24) + '…' : text}"`;
  }
  return layer.use;
}

const rowBase =
  'w-full text-left px-2 py-1 rounded truncate transition-colors hover:bg-hover-color';
const rowSelected = 'bg-accent text-button-text hover:bg-accent';

/** D-158, Phase 3 — `selections` is now an array (was a single `Selection |
 *  null`, see `MotionTab.tsx`'s own doc comment on why). A row click ALWAYS
 *  replaces the whole selection with just that one row — this list doesn't
 *  grow its own shift-click/marquee multi-select gesture; the canvas
 *  overlay is where those live (research doc §4 Phase 3 scopes the gesture
 *  to "the canvas," and a list of rows has no rubber-band-able geometry to
 *  speak of anyway). A row still highlights whenever it matches ANY entry
 *  in `selections`, so a multi-selection made on the canvas is visible here
 *  too — the same "panel and canvas agree on what's selected" rule D-156
 *  already followed for the single-selection case. */
export function LayerList({
  manifest,
  selections,
  onSelect,
}: {
  manifest: Manifest;
  selections: Selection[];
  onSelect: (s: Selection) => void;
}) {
  const row = (sceneIndex: number, target: SelectionTarget, label: string, indent = false) => {
    const isSel = selections.some((s) => s.sceneIndex === sceneIndex && sameTarget(s.target, target));
    return (
      <button
        type="button"
        key={`${target.kind}-${'index' in target ? target.index : ''}`}
        className={[rowBase, isSel ? rowSelected : 'text-text-secondary', indent ? 'pl-4' : ''].join(' ')}
        onClick={() => onSelect({ sceneIndex, target })}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="h-full w-full overflow-y-auto text-[11px] px-2 py-2 flex flex-col gap-2">
      {manifest.scenes.map((scene, si) => (
        <div key={scene.id} className="flex flex-col gap-0.5">
          {row(si, { kind: 'scene' }, scene.id)}
          {scene.camera && row(si, { kind: 'camera' }, 'Camera', true)}
          {scene.layers?.map((layer, li) =>
            row(si, { kind: 'layer', index: li, id: layer.id }, layerLabel(layer), true),
          )}
          {scene.scene3d && (
            <>
              {row(si, { kind: 'scene3d-camera' }, '3D Camera', true)}
              {scene.scene3d.children.map((child, ci) =>
                row(si, { kind: 'scene3d-child', index: ci, id: child.id }, layerLabel(child), true),
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
