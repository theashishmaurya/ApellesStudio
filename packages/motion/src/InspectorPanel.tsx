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
 * control — including, since Phase 5b part 4, a key's `ease` field
 * (`kind: 'ease'`, `EaseCurveEditor.tsx`'s `EaseFieldControl`): a real
 * bezier-curve-with-draggable-handles widget, not the raw JSON tuple every
 * other fixed-shape-tuple field still uses (see that module's own doc
 * comment for why `ease` specifically earned a bespoke widget where
 * `pos`/`look`/etc. didn't).
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
 *
 * **D-158, Phase 3 — the multi-layer view, and the design call behind it.**
 * `selections` is now `Selection[]` (was `Selection | null`). 0/1 entries
 * render EXACTLY as before this pass (byte-identical code path — see the
 * `selections.length <= 1` branch in `InspectorPanel` below). 2+ entries are
 * always all `{kind:'layer'}` in one scene (`LayerList.tsx`'s own
 * constraint) and render through `MultiLayerInspector`, a real, documented
 * design decision rather than a stopgap:
 *
 * - **Align/distribute (item 5 of the research doc's Phase 3 scope)
 *   ALWAYS shows** for 2+ selected layers — it needs nothing about the
 *   layers beyond their position/size, which every selected layer has
 *   regardless of `use`.
 * - **The Transform group (D-157's generic `{x,y,scale,rot,opacity,
 *   clipWidth,clipHeight}` wrapper) ALWAYS shows too, in LOCKSTEP** — one
 *   edit writes the same value to every selected layer
 *   (`setTransformFieldOnSelections`). This is genuinely use-agnostic (every
 *   2D layer carries the same optional `transform`), so it's the one field
 *   group that makes unqualified sense across a mixed-primitive selection —
 *   the option-(b) "shared cross-primitive fields" shape from the task
 *   brief.
 * - **When every selected layer shares the SAME `use`, the primitive's own
 *   field group ALSO shows, in lockstep** (`setFieldOnSelections`) — option
 *   (a), "same-use lockstep editing." Editing any field (e.g. bumping
 *   `size` on three `text` layers at once) writes it to every selected
 *   layer; each layer's OTHER fields are untouched. The displayed value is
 *   the FIRST selected layer's own value, not a computed "mixed" indicator
 *   — a real gap, disclosed rather than silently accepted: a proper
 *   multi-edit panel (Figma/Photoshop-style) shows "Mixed" when values
 *   differ across the selection and clears it on a shared write. Building
 *   that needs a per-field "do all N values agree" check threaded through
 *   `FieldControl`'s existing single-`value` prop — a real, scoped-out
 *   enhancement, not attempted this pass because the *far* more common case
 *   (batch-nudge a shared property that's usually already the same, or that
 *   you're intentionally overwriting) works correctly without it.
 * - **When the selected layers do NOT share a `use`,** the primitive-
 *   specific group is replaced with a short note pointing the user at
 *   selecting one layer to edit its own fields.
 *
 * **The alternative considered and rejected: a live per-layer sub-picker**
 * ("N layers selected — pick one to edit its own fields," option (c) from
 * the task brief) that would let the Inspector narrow to one layer's full
 * field set WITHOUT changing the actual canvas/`LayerList` selection. Not
 * built: it needs its own separate "which layer am I currently VIEWING
 * inside a multi-selection" state (distinct from "which layers are
 * SELECTED"), which is real, non-trivial state-plumbing for a capability
 * the lockstep-editing shape above already covers for the owner's actual
 * stated ask ("set position or size... in lockstep" reads far more like "N
 * layers, one dial" than "let me tunnel into one of the N"). If daily use
 * shows the mixed-`use` note is genuinely annoying, the sub-picker is the
 * documented next step — not dropped from consideration, just not worth
 * its own state model in the same pass as the structural `Selection[]`
 * change, marquee gesture, and align/distribute functions.
 */
import { useState } from 'react';
import type { Manifest, Cam2dKey, Cam3dKey, TransformKey } from '@chroma/motion-engine/src/engine/schema';
import { InspectorEmptyState, InspectorSection } from '@chroma/inspector';
// D-253 — the SUBPATH, never `@chroma/ui`'s barrel: that barrel exports
// `Text`, whose polymorphic `as`-prop typing breaks once
// `@react-three/fiber`'s global JSX augmentation (pulled in transitively via
// `@chroma/motion-engine`) sits in the same `tsc` program (see `Button.tsx`).
// `@chroma/ui/number-scrub` imports nothing but React, so the conflict cannot
// reach here — and this tab's number fields get the app's one real numeric-
// field behaviour instead of a second hand-written copy of it.
import { useNumberField } from '@chroma/ui/number-scrub';
import { EaseFieldControl } from './EaseCurveEditor';
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
  layerTransformKeys,
  setLayerTransformKeys,
  setFieldOnSelections,
  setTransformFieldOnSelections,
  alignSelections,
  distributeSelections,
  type AlignEdge,
  parseJsonField,
  selectedLayerItem,
  setLayerItemField,
  resetLayerItemPosition,
} from './manifestEdit';
import {
  fieldsForPrimitive,
  SCENE_FIELDS,
  CAM2D_KEY_FIELDS,
  CAM3D_KEY_FIELDS,
  LAYER_TRANSFORM_FIELDS,
  LAYER_TRANSFORM_KEY_FIELDS,
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
/** B-113 / D-253 — the same treatment `@chroma/ui`'s `Input` gives every
 *  `type="number"` in the app. Restated rather than imported because this tab
 *  cannot use that component (see the `useNumberField` import above), and a
 *  number field that still paints WebKit's spin buttons over its own digits is
 *  the exact defect B-113 was filed for. The scrub gesture below is what
 *  replaces them. */
const numberInputBase = [
  inputBase,
  'tabular-nums cursor-ew-resize [appearance:textfield]',
  '[&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
].join(' ');

/** D-253 — this tab's numeric field: `inputBase`, no spin buttons, and the
 *  shared drag-to-scrub/typing-draft behaviour from `@chroma/ui`.
 *
 *  `value` is `null` for a manifest property that is simply not set — the
 *  field shows its placeholder rather than a guessed default, and clearing it
 *  goes back to unset through `onClear`, which is the distinction this panel
 *  has always drawn (see `FieldControl`'s own doc). */
function MotionNumberField({
  value,
  step = 1,
  className,
  placeholder,
  onCommit,
  onClear,
}: {
  value: number | null;
  step?: number;
  className?: string;
  placeholder?: string;
  onCommit: (value: number) => void;
  onClear?: () => void;
}) {
  const { inputProps } = useNumberField({
    value,
    step,
    onValueChange: onCommit,
    onClear,
    // These fields declare no per-property step (`FieldSpec` has none), so the
    // default step's precision says nothing about theirs — and they are full
    // width, so unlike the Edit tab's 80px rows there is nothing to round for.
    roundDisplay: false,
  });
  return (
    <input
      {...inputProps}
      className={className ? [numberInputBase, className].join(' ') : numberInputBase}
      placeholder={placeholder}
    />
  );
}
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

  if (spec.kind === 'ease') {
    return <EaseFieldControl spec={spec} value={value} onCommit={onCommit} />;
  }

  if (spec.kind === 'number') {
    return (
      <div className={row}>
        <span className={label}>{spec.label}</span>
        <MotionNumberField
          value={typeof value === 'number' ? value : null}
          placeholder="(default)"
          onCommit={onCommit}
          onClear={() => onCommit(undefined)}
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
            <MotionNumberField
              className="text-center px-1"
              value={typeof arr[i] === 'number' ? (arr[i] as number) : null}
              placeholder="0"
              onCommit={(n) => commitAt(i, n)}
              onClear={() => commitAt(i, 0)}
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

/** A real add/remove/edit list (not JSON) for any small, flat, fixed-shape
 *  keyframe array — a keyframe row is nothing like Matrix/Graph's genuinely
 *  nested content props, so it earns its own editor rather than falling
 *  back to a raw JSON textarea. Originally built (D-099) as `CameraKeyList`,
 *  camera-only (`Cam2dKey | Cam3dKey`); generalized here (D-159, Phase 4 of
 *  the research doc — "Inspector support for a per-layer key list... adapt
 *  or generalize [`CameraKeyList`] rather than writing a third bespoke
 *  editor") to any `{at: number, ...}` shape so the SAME component now also
 *  drives the new per-layer `transform.keys` editor
 *  (`TransformKeysSection` below) — a real generalization of already-working
 *  code, not a parallel copy: the camera call sites in `InspectorPanel`
 *  below are unchanged in behavior, just typed through the wider generic. */
function KeyframeList<K extends { at: number }>({
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

/**
 * D-159, Phase 4's per-layer keyframe-list editor — "Inspector support for
 * a per-layer key list... adapt or generalize [the camera's keyframe list]
 * rather than writing a third bespoke editor." Reuses `KeyframeList`
 * (generalized from D-099's camera-only `CameraKeyList` above) with
 * `LAYER_TRANSFORM_KEY_FIELDS` (`propCatalog.ts`) — the exact same
 * add/remove/edit-row shape the camera keyframe editor already gives the
 * owner, now for a layer's own `transform.keys`.
 *
 * **Rendered ONLY for a single-selection 2D layer, never in
 * `MultiLayerInspector`'s lockstep view — a real design call, made and
 * documented rather than left to fall out of the code by accident.** The
 * static `TransformFieldGroup` above lockstep-edits cleanly across N
 * layers because "set this scalar field on every selected layer" has one
 * obvious meaning. A KEYFRAME LIST does not: two different layers'
 * `transform.keys` arrays can have a different number of rows, at different
 * times, with different field coverage — there is no single well-defined
 * "add a keyframe to N layers at once" operation the way there is for "set
 * opacity to 0.5 on N layers," and inventing one (align by index? by
 * nearest `at`? create if missing, else edit?) would be exactly the kind of
 * silently-surprising behavior this phase's OWN auto-keyframe write-up
 * argues against introducing casually. Per-layer keyframes are inherently
 * per-layer; selecting exactly one layer to edit its own timeline is the
 * honest floor, matching how `MultiLayerInspector` already drops to a
 * "select one layer" note for a mismatched-`use` primitive field group
 * (same file, `InspectorPanel`'s own module doc comment) rather than
 * guessing at a lockstep semantics that doesn't exist yet.
 */
function TransformKeysSection({
  keys,
  onChange,
}: {
  keys: TransformKey[];
  onChange: (next: TransformKey[]) => void;
}) {
  return (
    <InspectorSection label="Transform keyframes">
      <KeyframeList fields={LAYER_TRANSFORM_KEY_FIELDS} keys={keys} makeDefault={() => ({ at: 0 })} onChange={onChange} />
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

/** D-158, Phase 3 — the alignment/distribute toolbar. Real pure functions
 *  (`manifestEdit.ts`'s `alignSelections`/`distributeSelections`), a
 *  minimal, un-fancy button row per the task's own "keep it simple"
 *  instruction: six align buttons (always shown for 2+ selections) and two
 *  distribute buttons (shown, but disabled with a title, below 3
 *  selections — matching `distributeSelections`' own "for 3+" scoping
 *  rather than hiding the buttons and leaving the user to guess why). */
const ALIGN_EDGES: { edge: AlignEdge; label: string }[] = [
  { edge: 'left', label: '⊢ Left' },
  { edge: 'centerH', label: '⊣⊢ Center H' },
  { edge: 'right', label: '⊣ Right' },
  { edge: 'top', label: '⊤ Top' },
  { edge: 'centerV', label: '⊥⊤ Center V' },
  { edge: 'bottom', label: '⊥ Bottom' },
];

function AlignDistributeToolbar({
  manifest,
  selections,
  onChange,
}: {
  manifest: Manifest;
  selections: Selection[];
  onChange: (next: Manifest) => void;
}) {
  const canDistribute = selections.length >= 3;
  const buttonClass =
    'h-7 rounded border border-border-color text-[10px] text-text-primary hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-border-color disabled:hover:text-text-primary';
  return (
    <InspectorSection label="Align & distribute">
      <div className="flex flex-col gap-1.5">
        <div className="grid grid-cols-3 gap-1.5">
          {ALIGN_EDGES.map(({ edge, label }) => (
            <button
              key={edge}
              type="button"
              className={buttonClass}
              onClick={() => onChange(alignSelections(manifest, selections, edge))}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            className={buttonClass}
            disabled={!canDistribute}
            title={canDistribute ? undefined : 'Distribute needs 3+ selected layers'}
            onClick={() => onChange(distributeSelections(manifest, selections, 'horizontal'))}
          >
            Distribute ↔
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={!canDistribute}
            title={canDistribute ? undefined : 'Distribute needs 3+ selected layers'}
            onClick={() => onChange(distributeSelections(manifest, selections, 'vertical'))}
          >
            Distribute ↕
          </button>
        </div>
      </div>
    </InspectorSection>
  );
}

/** D-158, Phase 3's multi-layer view — see the module doc comment's own
 *  "the multi-layer view, and the design call behind it" section for the
 *  full reasoning. Only ever rendered for 2+ selections, all `{kind:
 *  'layer'}` in one scene (`LayerList.tsx`'s own constraint) — this
 *  component trusts that invariant rather than re-checking it. */
function MultiLayerInspector({
  manifest,
  selections,
  onChange,
}: {
  manifest: Manifest;
  selections: Selection[];
  onChange: (next: Manifest) => void;
}) {
  const layers = selections.map((s) => selectedLayer(manifest, s)).filter((l): l is { use: string; raw: Record<string, unknown> } => l !== null);
  const first = layers[0];
  const sameUse = layers.length > 0 && layers.every((l) => l.use === first.use);
  const fields = sameUse ? fieldsForPrimitive(first.use) : undefined;

  return (
    <div className="h-full w-full overflow-y-auto p-3 flex flex-col gap-4">
      <p className="text-[11px] text-text-secondary">{selections.length} layers selected</p>
      <AlignDistributeToolbar manifest={manifest} selections={selections} onChange={onChange} />
      <TransformFieldGroup
        raw={(first?.raw.transform as Record<string, unknown>) ?? {}}
        onCommit={(key, value) => onChange(setTransformFieldOnSelections(manifest, selections, key, value))}
      />
      {fields ? (
        <FieldGroup
          fields={fields}
          raw={first.raw}
          onCommit={(key, value) => onChange(setFieldOnSelections(manifest, selections, key, value))}
        />
      ) : (
        <InspectorEmptyState>
          Selected layers use different primitives — select just one to edit its own fields, or use Transform/
          Align above to edit them together.
        </InspectorEmptyState>
      )}
    </div>
  );
}

export function InspectorPanel({
  manifest,
  selections,
  onChange,
  onSnapToLayer,
}: {
  manifest: Manifest;
  /** D-158 — the whole live selection (was `Selection | null`). 0 entries:
   *  the empty state. 1 entry: exactly today's single-selection view,
   *  unchanged. 2+ entries: `MultiLayerInspector` — see this file's own
   *  module doc comment for the full design reasoning. */
  selections: Selection[];
  onChange: (next: Manifest) => void;
  /** D-157 — see `SnapToLayerControl`'s own doc comment. Optional: a caller
   *  with no live-DOM measurement access (a future non-interactive Inspector
   *  embed, say) just omits it and the emphasis "Snap to layer" section
   *  simply doesn't render. */
  onSnapToLayer?: (targetLayerIndex: number) => void;
}) {
  if (selections.length === 0) {
    return <InspectorEmptyState>Select a scene, camera, or layer to edit its properties.</InspectorEmptyState>;
  }

  if (selections.length > 1) {
    return <MultiLayerInspector manifest={manifest} selections={selections} onChange={onChange} />;
  }

  const selection = selections[0];
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
        <KeyframeList
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
        <KeyframeList
          fields={CAM3D_KEY_FIELDS}
          keys={keys}
          makeDefault={(): Cam3dKey => ({ at: 0, pos: [0, 0, 0] })}
          onChange={(next) => onChange(setCamera3d(manifest, selection.sceneIndex, next))}
        />
      </div>
    );
  }

  // D-182 (Phase 3 of 3) — one CARD within a `layers` primitive. Its own
  // minimal, purpose-built form (not `fieldsForPrimitive`/`FieldGroup`,
  // which describe a whole LAYER's own props, not one item inside its
  // `items[]`) — just the three fields a card actually has, plus the one
  // action ("Reset position") this pass's whole reason to exist needs:
  // undoing a drag back to the computed default without hand-editing JSON.
  if (target.kind === 'layer-item') {
    const item = selectedLayerItem(manifest, selection);
    if (!item) return <StaleNotice />;
    const hasOffset = item.dx !== undefined || item.dy !== undefined;
    return (
      <div className="h-full w-full overflow-y-auto p-3">
        <InspectorSection label="Content">
          <FieldControl
            spec={{ key: 'label', label: 'Label', kind: 'string', group: 'content' }}
            value={item.label}
            onCommit={(v) => onChange(setLayerItemField(manifest, selection, 'label', v))}
          />
        </InspectorSection>
        <InspectorSection label="Layout">
          <FieldControl
            spec={{ key: 'dx', label: 'X offset', kind: 'number', group: 'layout' }}
            value={item.dx}
            onCommit={(v) => onChange(setLayerItemField(manifest, selection, 'dx', v))}
          />
          <FieldControl
            spec={{ key: 'dy', label: 'Y offset', kind: 'number', group: 'layout' }}
            value={item.dy}
            onCommit={(v) => onChange(setLayerItemField(manifest, selection, 'dy', v))}
          />
          <button
            type="button"
            disabled={!hasOffset}
            className="h-7 rounded border border-dashed border-border-color text-[11px] text-text-secondary hover:text-text-primary hover:border-accent disabled:opacity-40 disabled:hover:text-text-secondary disabled:hover:border-border-color"
            onClick={() => onChange(resetLayerItemPosition(manifest, selection))}
          >
            Reset position
          </button>
        </InspectorSection>
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
      {isLayer2d && (
        <TransformKeysSection
          keys={layerTransformKeys(manifest, selection)}
          onChange={(next) => onChange(setLayerTransformKeys(manifest, selection, next))}
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
