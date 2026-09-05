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
 */
import type { Manifest, Layer } from '@chroma/motion-engine/src/engine/schema';

export type SelectionTarget =
  | { kind: 'scene' }
  | { kind: 'camera' }
  | { kind: 'scene3d-camera' }
  | { kind: 'layer'; index: number }
  | { kind: 'scene3d-child'; index: number };

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

export function LayerList({
  manifest,
  selection,
  onSelect,
}: {
  manifest: Manifest;
  selection: Selection | null;
  onSelect: (s: Selection) => void;
}) {
  const row = (sceneIndex: number, target: SelectionTarget, label: string, indent = false) => {
    const isSel = selection?.sceneIndex === sceneIndex && sameTarget(selection.target, target);
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
          {scene.layers?.map((layer, li) => row(si, { kind: 'layer', index: li }, layerLabel(layer), true))}
          {scene.scene3d && (
            <>
              {row(si, { kind: 'scene3d-camera' }, '3D Camera', true)}
              {scene.scene3d.children.map((child, ci) =>
                row(si, { kind: 'scene3d-child', index: ci }, layerLabel(child), true),
              )}
            </>
          )}
        </div>
      ))}
    </div>
  );
}
