/**
 * @chroma/motion — the Global Inspector, Motion half (D-099, Phase 2 of
 * `docs/notes/global-inspector.md`).
 *
 * A real form bound to whatever `LayerList.tsx`'s `Selection` currently
 * points at — reads/writes directly into the manifest text
 * `useMotionManifest` already owns (via `manifestEdit.ts`'s pure
 * read/write functions + `onChange`, which the caller wires to `setText`),
 * not a second source of truth. Grouped roughly the way the rejected
 * Remotion Editor Starter's own section shape suggests as a *reference*
 * (Source/Layout/Fill/Timing), per the scoping doc — not copied from it.
 *
 * Array/nested-shaped props (`Matrix.values`, `Graph.nodes`, `Layers.items`,
 * `Emphasis.box`, vec3 tuples, …) render as a real, live-validated JSON
 * textarea rather than a bespoke per-shape editor — the scoping doc's own
 * "lighter-touch editor for these" call, made explicit here (see
 * `propCatalog.ts`'s `kind: 'json'`). Everything else gets a real typed
 * control.
 *
 * A selection whose `use` isn't in `propCatalog.ts` (a manifest field this
 * Inspector build doesn't recognize — future primitive, hand-edited
 * manifest, etc.) renders a plain "no editable fields recognized for this
 * layer type" notice instead of throwing — the backward-compat floor every
 * function in `manifestEdit.ts` is already written to respect.
 *
 * D-103 (Phase 4): the empty-state message and section-heading styling now
 * come from `@chroma/inspector` (a tiny shared package, no `@chroma/ui`
 * dependency — see that package's README for why), the same components
 * `@chroma/editor`'s `ClipInspectorPanel.tsx` uses. Everything else here —
 * the field types, the manifest read/write logic, the layout — stays
 * local; Motion's and the NLE's selections are different enough (a
 * `Manifest`+scene/layer/camera target vs. a `Clip`+track/id) that forcing
 * them through one polymorphic component would mean rewriting two already-
 * working panels for no real benefit. See `@chroma/inspector`'s README for
 * the full reasoning.
 */
import { useState } from 'react';
import type { Manifest, Cam2dKey, Cam3dKey } from '@chroma/motion-engine/src/engine/schema';
import { InspectorEmptyState, InspectorSection } from '@chroma/inspector';
import { layerLabel, type Selection } from './LayerList';
import {
  selectedScene,
  selectedLayer,
  selectedCamera2d,
  selectedCamera3d,
  setLayerField,
  setSceneField,
  setCamera2d,
  setCamera3d,
  setLayerTransformField,
  parseJsonField,
} from './manifestEdit';
import {
  fieldsForPrimitive,
  SCENE_FIELDS,
  CAM2D_KEY_FIELDS,
  CAM3D_KEY_FIELDS,
  LAYER_TRANSFORM_FIELDS,
  type FieldSpec,
} from './propCatalog';

const GROUP_LABEL: Record<FieldSpec['group'], string> = {
  source: 'Source',
  layout: 'Layout',
  fill: 'Fill',
  timing: 'Timing',
  content: 'Content',
};
const GROUP_ORDER: FieldSpec['group'][] = ['content', 'source', 'layout', 'fill', 'timing'];

const label = 'block text-[10px] font-medium text-text-secondary mb-1';
const inputBase =
  'w-full h-7 px-2 rounded bg-surface border border-border-color text-[11px] text-text-primary focus:outline-none focus:border-accent';
const row = 'flex flex-col gap-1';

/** one scalar field's control, dispatching on `FieldSpec['kind']`. `value`
 *  is the raw current value from the manifest (may be `undefined`, in
 *  which case the primitive's own runtime default applies — the input
 *  shows empty/unchecked, not a guessed default, so it's clear the value
 *  is "unset" vs. "set to the same thing the default happens to be"). */
function FieldControl({
  spec,
  value,
  onCommit,
}: {
  spec: FieldSpec;
  value: unknown;
  onCommit: (v: unknown) => void;
}) {
  if (spec.kind === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-[11px] text-text-primary">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onCommit(e.target.checked)}
          className="accent-accent"
        />
        {spec.label}
      </label>
    );
  }

  if (spec.kind === 'select') {
    return (
      <div className={row}>
        <span className={label}>{spec.label}</span>
        <select
          className={inputBase}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onCommit(e.target.value || undefined)}
        >
          <option value="">(default)</option>
          {spec.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (spec.kind === 'color') {
    const str = typeof value === 'string' ? value : '';
    return (
      <div className={row}>
        <span className={label}>{spec.label}</span>
        <div className="flex gap-1.5">
          <input
            type="color"
            value={/^#[0-9a-fA-F]{6}$/.test(str) ? str : '#000000'}
            onChange={(e) => onCommit(e.target.value)}
            className="h-7 w-8 rounded border border-border-color bg-surface"
          />
          <input
            type="text"
            className={inputBase}
            value={str}
            placeholder="(default)"
            onChange={(e) => onCommit(e.target.value || undefined)}
          />
        </div>
      </div>
    );
  }

  if (spec.kind === 'json') {
    return <JsonFieldControl spec={spec} value={value} onCommit={onCommit} />;
  }

  if (spec.kind === 'vec') {
    return <VecFieldControl spec={spec} value={value} onCommit={onCommit} />;
  }

  if (spec.kind === 'number') {
    return (
      <div className={row}>
        <span className={label}>{spec.label}</span>
        <input
          type="number"
          className={inputBase}
          value={typeof value === 'number' ? value : ''}
          placeholder="(default)"
          onChange={(e) => onCommit(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      </div>
    );
  }

  // string
  return (
    <div className={row}>
      <span className={label}>{spec.label}</span>
      <input
        type="text"
        className={inputBase}
        value={typeof value === 'string' ? value : ''}
        placeholder="(default)"
        onChange={(e) => onCommit(e.target.value === '' ? undefined : e.target.value)}
      />
    </div>
  );
}

/** the JSON-fallback control — local draft text so an in-progress edit
 *  (typing a `[` before the matching `]` exists) doesn't get clobbered by
 *  the manifest's own last-good value on every keystroke; commits (and
 *  clears its own error) only on a successful parse, mirroring
 *  `useMotionManifest`'s "never blink the last-good value away" contract
 *  for the whole document. */
function JsonFieldControl({ spec, value, onCommit }: { spec: FieldSpec; value: unknown; onCommit: (v: unknown) => void }) {
  const serialized = value === undefined ? '' : JSON.stringify(value);
  const [draft, setDraft] = useState(serialized);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = dirty ? draft : serialized;

  return (
    <div className={row}>
      <span className={label}>{spec.label}</span>
      <textarea
        className={[inputBase, 'h-16 py-1 font-mono resize-y'].join(' ')}
        value={shown}
        placeholder="(default)"
        onChange={(e) => {
          setDirty(true);
          setDraft(e.target.value);
        }}
        onBlur={() => {
          if (!dirty) return;
          if (draft.trim() === '') {
            onCommit(undefined);
            setDirty(false);
            setError(null);
            return;
          }
          const parsed = parseJsonField(draft);
          if (parsed.ok) {
            onCommit(parsed.value);
            setDirty(false);
            setError(null);
          } else {
            setError(parsed.error);
          }
        }}
      />
      {error && <span className="text-[10px] text-red-400">{error}</span>}
    </div>
  );
}

/** D-154 — a fixed-length numeric tuple (`emphasis.box`'s `[x,y,w,h]`,
 *  a vec3 position/size, …) as `spec.components.length` separate labeled
 *  number inputs sharing one array value, instead of one raw JSON textarea.
 *  Each input commits independently: editing X never touches Y/W/H. A
 *  missing/non-array value reads as all-empty; committing one element fills
 *  the rest with `0` rather than leaving holes, since the manifest field is
 *  a fixed-shape tuple, not an arbitrary-length array. */
function VecFieldControl({ spec, value, onCommit }: { spec: FieldSpec; value: unknown; onCommit: (v: unknown) => void }) {
  const components = spec.components ?? [];
  const arr = Array.isArray(value) ? value : [];

  const commitAt = (i: number, n: number) => {
    const next = components.map((_, ci) => {
      if (ci === i) return n;
      const existing = arr[ci];
      return typeof existing === 'number' ? existing : 0;
    });
    onCommit(next);
  };

  return (
    <div className={row}>
      <span className={label}>{spec.label}</span>
      <div className="flex gap-1.5">
        {components.map((c, i) => (
          <div key={c} className="flex-1 flex flex-col gap-0.5">
            <span className="text-[9px] text-text-secondary/70 text-center">{c}</span>
            <input
              type="number"
              className={[inputBase, 'text-center px-1'].join(' ')}
              value={typeof arr[i] === 'number' ? arr[i] : ''}
              placeholder="0"
              onChange={(e) => commitAt(i, e.target.value === '' ? 0 : Number(e.target.value))}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function FieldGroup({
  fields,
  raw,
  onCommit,
}: {
  fields: FieldSpec[];
  raw: Record<string, unknown>;
  onCommit: (key: string, value: unknown) => void;
}) {
  const byGroup = GROUP_ORDER.map((g) => ({ g, items: fields.filter((f) => f.group === g) })).filter(
    (x) => x.items.length > 0,
  );
  return (
    <div className="flex flex-col gap-4">
      {byGroup.map(({ g, items }) => (
        <InspectorSection key={g} label={GROUP_LABEL[g]}>
          {items.map((spec) => (
            <FieldControl key={spec.key} spec={spec} value={raw[spec.key]} onCommit={(v) => onCommit(spec.key, v)} />
          ))}
        </InspectorSection>
      ))}
    </div>
  );
}

/** the 2D/3D camera keyframe-list editor — a real add/remove/edit list
 *  (not JSON) since a keyframe array is a small, flat, fixed shape, unlike
 *  Matrix/Graph's genuinely nested content props. */
function CameraKeyList<K extends Cam2dKey | Cam3dKey>({
  fields,
  keys,
  makeDefault,
  onChange,
}: {
  fields: FieldSpec[];
  keys: K[];
  makeDefault: () => K;
  onChange: (next: K[]) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {keys.map((k, i) => (
        <div key={i} className="flex flex-col gap-2 rounded border border-border-color p-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-medium text-text-secondary">Key {i + 1}</span>
            <button
              type="button"
              className="text-[10px] text-red-400 hover:underline"
              onClick={() => onChange(keys.filter((_, ki) => ki !== i))}
            >
              Remove
            </button>
          </div>
          {fields.map((spec) => (
            <FieldControl
              key={spec.key}
              spec={spec}
              value={(k as unknown as Record<string, unknown>)[spec.key]}
              onCommit={(v) => {
                const next = keys.map((kk, ki) => (ki === i ? { ...kk, [spec.key]: v } : kk));
                onChange(next as K[]);
              }}
            />
          ))}
        </div>
      ))}
      <button
        type="button"
        className="h-7 rounded border border-dashed border-border-color text-[11px] text-text-secondary hover:text-text-primary hover:border-accent"
        onClick={() => onChange([...keys, makeDefault()])}
      >
        + Add keyframe
      </button>
    </div>
  );
}

/** D-157, Phase 2's layer-transform wrapper — a generic field group every
 *  2D layer gets, rendered through its own small sub-editor (rather than
 *  folded into `FieldGroup`/`fieldsForPrimitive`) because it reads/writes a
 *  NESTED `layer.transform.<key>`, not a top-level layer field
 *  (`manifestEdit.ts`'s `setLayerTransformField`). Absent `transform`
 *  (the common case — every field in it is optional, so "absent" and "every
 *  field empty" already mean the exact same thing) shows every field blank,
 *  same "unset, not a guessed default" convention `FieldControl` already
 *  uses elsewhere in this file. */
function TransformFieldGroup({
  raw,
  onCommit,
}: {
  raw: Record<string, unknown>;
  onCommit: (key: string, value: unknown) => void;
}) {
  return (
    <InspectorSection label="Transform">
      {LAYER_TRANSFORM_FIELDS.map((spec) => (
        <FieldControl key={spec.key} spec={spec} value={raw[spec.key]} onCommit={(v) => onCommit(spec.key, v)} />
      ))}
    </InspectorSection>
  );
}

/** D-157's "snap to layer" — the direct fix for the owner's original
 *  complaint (a misplaced `emphasis` scribble box), scoped exactly as the
 *  research doc's §3d put it: "a button, not a subsystem." Rendered ONLY
 *  when the current selection is an `emphasis` layer (the one primitive
 *  with a `box` worth snapping). This component owns nothing but a small
 *  target-picker's local `useState` — the actual measurement + write
 *  happens in `MotionTab.tsx`'s `onSnapToLayer` (which has the DOM access
 *  this panel deliberately doesn't).
 *
 *  Keyed by the caller on `${sceneIndex}.${layerIndex}` (see
 *  `InspectorPanel`'s own render below) so switching between two different
 *  `emphasis` layers remounts this control instead of carrying a stale
 *  `targetIndex` from the PREVIOUS selection's sibling list into the new
 *  one. */
function SnapToLayerControl({
  manifest,
  selection,
  onSnap,
}: {
  manifest: Manifest;
  selection: Selection;
  onSnap: (targetLayerIndex: number) => void;
}) {
  const scene = selectedScene(manifest, selection.sceneIndex);
  const layers = scene?.layers ?? [];
  const selfIndex = selection.target.kind === 'layer' ? selection.target.index : -1;
  const options = layers.map((l, i) => ({ i, label: layerLabel(l) })).filter((o) => o.i !== selfIndex);
  const [targetIndex, setTargetIndex] = useState<number | null>(options[0]?.i ?? null);

  if (options.length === 0) {
    return (
      <InspectorSection label="Snap to layer">
        <p className="text-[10px] text-text-secondary">No other layers in this scene to snap to.</p>
      </InspectorSection>
    );
  }

  return (
    <InspectorSection label="Snap to layer">
      <div className="flex flex-col gap-1.5">
        <select
          className={inputBase}
          value={targetIndex ?? ''}
          onChange={(e) => setTargetIndex(e.target.value === '' ? null : Number(e.target.value))}
        >
          {options.map((o) => (
            <option key={o.i} value={o.i}>
              {o.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={targetIndex === null}
          className="h-7 rounded border border-border-color text-[11px] text-text-primary hover:border-accent hover:text-accent disabled:opacity-40"
          onClick={() => targetIndex !== null && onSnap(targetIndex)}
        >
          Snap box to selected layer
        </button>
      </div>
    </InspectorSection>
  );
}

export function InspectorPanel({
  manifest,
  selection,
  onChange,
  onSnapToLayer,
}: {
  manifest: Manifest;
  selection: Selection | null;
  onChange: (next: Manifest) => void;
  /** D-157 — see `SnapToLayerControl`'s own doc comment. Optional: a caller
   *  with no live-DOM measurement access (a future non-interactive Inspector
   *  embed, say) just omits it and the emphasis "Snap to layer" section
   *  simply doesn't render. */
  onSnapToLayer?: (targetLayerIndex: number) => void;
}) {
  if (!selection) {
    return <InspectorEmptyState>Select a scene, camera, or layer to edit its properties.</InspectorEmptyState>;
  }

  const { target } = selection;

  if (target.kind === 'scene') {
    const scene = selectedScene(manifest, selection.sceneIndex);
    if (!scene) return <StaleNotice />;
    return (
      <div className="h-full w-full overflow-y-auto p-3">
        <FieldGroup
          fields={SCENE_FIELDS}
          raw={scene as unknown as Record<string, unknown>}
          onCommit={(key, value) => onChange(setSceneField(manifest, selection.sceneIndex, key, value))}
        />
      </div>
    );
  }

  if (target.kind === 'camera') {
    const keys = selectedCamera2d(manifest, selection.sceneIndex);
    if (!keys) return <StaleNotice />;
    return (
      <div className="h-full w-full overflow-y-auto p-3">
        <CameraKeyList
          fields={CAM2D_KEY_FIELDS}
          keys={keys}
          makeDefault={() => ({ at: 0 })}
          onChange={(next) => onChange(setCamera2d(manifest, selection.sceneIndex, next))}
        />
      </div>
    );
  }

  if (target.kind === 'scene3d-camera') {
    const keys = selectedCamera3d(manifest, selection.sceneIndex);
    if (!keys) return <StaleNotice />;
    return (
      <div className="h-full w-full overflow-y-auto p-3">
        <CameraKeyList
          fields={CAM3D_KEY_FIELDS}
          keys={keys}
          makeDefault={() => ({ at: 0, pos: [0, 0, 0] })}
          onChange={(next) => onChange(setCamera3d(manifest, selection.sceneIndex, next))}
        />
      </div>
    );
  }

  // layer / scene3d-child
  const found = selectedLayer(manifest, selection);
  if (!found) return <StaleNotice />;
  const fields = fieldsForPrimitive(found.use);
  // D-157: the layer-transform wrapper (`schema.ts`'s `layerTransform`) is
  // ONLY applied by `motion-engine`'s `renderLayers` for 2D `scene.layers` —
  // `scene3d.children` render through a completely different path
  // (`Video.tsx`'s `ThreeD`) that never reads it, so it's offered here only
  // for a real `{kind:'layer'}` target, never a `scene3d-child` one.
  const isLayer2d = target.kind === 'layer';
  return (
    <div className="h-full w-full overflow-y-auto p-3 flex flex-col gap-4">
      {fields ? (
        <FieldGroup
          fields={fields}
          raw={found.raw}
          onCommit={(key, value) => onChange(setLayerField(manifest, selection, key, value))}
        />
      ) : (
        <InspectorEmptyState>
          No editable fields recognized for "{found.use}" — edit its manifest JSON directly in the editor pane.
        </InspectorEmptyState>
      )}
      {isLayer2d && (
        <TransformFieldGroup
          raw={(found.raw.transform as Record<string, unknown>) ?? {}}
          onCommit={(key, value) => onChange(setLayerTransformField(manifest, selection, key, value))}
        />
      )}
      {isLayer2d && found.use === 'emphasis' && onSnapToLayer && (
        <SnapToLayerControl
          key={`${selection.sceneIndex}.${target.kind === 'layer' ? target.index : ''}`}
          manifest={manifest}
          selection={selection}
          onSnap={onSnapToLayer}
        />
      )}
    </div>
  );
}

function StaleNotice() {
  return (
    <InspectorEmptyState>
      This selection no longer matches the manifest — it may have been edited directly. Pick it again from the layer
      list.
    </InspectorEmptyState>
  );
}
