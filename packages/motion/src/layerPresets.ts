/**
 * @apelles/motion — saved layer presets, a.k.a. components (D-332).
 *
 * **What it is.** The pure model behind "I tuned this `matrix` into a real
 * attention diagram; let me use it again tomorrow, in another project."
 * A preset is a NAMED, FROZEN COPY OF ONE LAYER FRAGMENT — the same shape
 * `catalog.ts`'s `defaultLayerFor` returns, except authored by the user
 * instead of hard-coded by us. Insert one and you get a fresh layer with
 * those values; the preset is not referenced afterwards and nothing links
 * back to it.
 *
 * **What it does NOT do.** No I/O (that is `layerPresetIO.ts`), no React,
 * no Tauri, no insertion (that is `manifestEdit.ts`'s `addLayerFromPreset`),
 * and — deliberately — **no live link between a preset and the layers made
 * from it.** Editing a preset does not restyle layers already inserted, the
 * same one-way rule D-257 states for Motion→Edit. That is a real product
 * choice, not an omission: a live component graph would need every inserted
 * layer to carry a preset id, an override model for the fields the user then
 * changed, and a reconciliation pass on every load — a much larger feature
 * whose absence is invisible here, whereas its half-built presence would not
 * be. Figma's components work the other way and are worth revisiting if the
 * owner asks; this ships the copy semantics that "save this for reuse"
 * actually asked for.
 *
 * **Why a user library and not more `catalog.ts` entries.** `catalog.ts` is
 * OUR inventory — exhaustive against the engine's `use` enum by construction
 * (`Record<Layer['use'], CatalogEntry>`), so it cannot hold user data without
 * losing that guarantee. Presets are a separate, additive list with no
 * exhaustiveness property at all, which is why they live in their own module
 * and their own file on disk.
 *
 * **Why not the caption-preset shape (D-243).** Caption presets are hard-coded
 * TypeScript with no storage — "a preset is nothing but a `CaptionStyle`",
 * and the library ships in the binary. That works because *we* author those
 * looks. These are authored by the user at runtime, so they need real
 * persistence; the in-repo precedent for a user-level library is RapidRAW's
 * own grading presets (`file_management.rs`'s `load_presets`/`save_presets`
 * over a JSON file in the app data dir), which is what `layerPresetIO.ts`
 * follows.
 */
import type { PrimitiveUse } from './catalog';
import { catalogEntries, catalogEntry } from './catalog';

/** Longest name we will store. Long enough for a real descriptive label
 *  ("attention heatmap — 8×8, warm"), short enough that the Catalog row and
 *  the MCP listing stay readable. Enforced on save rather than in the input,
 *  so the agent path cannot bypass it. */
export const PRESET_NAME_MAX = 80;

/**
 * One saved component.
 *
 * `layer` is the manifest fragment MINUS its `id` — ids are per-manifest
 * identity (`genLayerId`), so carrying one in a library would hand the same
 * id to every insert and break `resolveSelection`'s id-first matching the
 * moment two copies existed in one scene. `addLayerFromPreset` mints a fresh
 * one, exactly as `duplicateLayer` does.
 *
 * `use` is stored alongside even though `layer.use` carries it too: the
 * listing UI and `motion_list_layer_presets` both need to group and filter by
 * primitive without parsing every fragment, and a preset whose two copies
 * disagree is exactly the corruption `sanitizeLoadedPresets` drops.
 */
export interface MotionLayerPreset {
  /** stable identity for delete/rename — not a layer id, a library id */
  id: string;
  /** the user's own label, what the Catalog row shows */
  name: string;
  /** which primitive this is an instance of */
  use: PrimitiveUse;
  /** the frozen layer fragment, `id` stripped */
  layer: Record<string, unknown>;
  /** ISO-8601, for stable newest-first ordering in the panel */
  createdAt: string;
}

const VALID_USES = new Set<string>(catalogEntries.map((e) => e.use));

/** A short, random library id. Same "enough entropy that a collision is not
 *  a practical concern, no cryptographic property needed" bar `genLayerId`
 *  sets, with a prefix so a preset id is never mistaken for a layer id while
 *  debugging a manifest beside a library file. */
function genPresetId(): string {
  return `mlp-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Trim and bound a user-supplied preset name, returning `null` when nothing
 * usable is left. Callers treat `null` as "refuse the save" rather than
 * silently storing an unnamed preset — an unnamed row in the Catalog is
 * indistinguishable from every other unnamed row, which makes the library
 * worse than not having one.
 */
export function normalizePresetName(raw: string): string | null {
  const trimmed = raw.trim().replace(/\s+/g, ' ');
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, PRESET_NAME_MAX);
}

/**
 * A default name for "save this layer", derived from the layer itself so the
 * field is never empty when the user first sees it. Uses the primitive's
 * catalog display name plus, where the primitive has an obvious human-readable
 * identity, that: a `text` layer's own text is what the layer list already
 * labels it with (`LayerList.tsx`), so reusing it here means the suggested
 * name matches what the user was just looking at.
 *
 * Deliberately NOT unique-ified against the existing library: two presets may
 * legitimately share a name (they have distinct ids), and silently appending
 * " 2" to a name the user is about to overwrite anyway is noise.
 */
export function suggestedPresetName(use: PrimitiveUse, layer: Record<string, unknown>): string {
  const base = catalogEntry(use).name;
  const text = layer.text;
  if (typeof text === 'string') {
    const t = text.trim().replace(/\s+/g, ' ');
    if (t.length > 0) return normalizePresetName(`${base} — ${t}`) ?? base;
  }
  return base;
}

/**
 * Build a preset from a layer fragment as it stands in the manifest.
 *
 * The whole fragment is captured, including `transform` and
 * `transform.keys` — the per-layer animation IS most of what makes a tuned
 * setup worth keeping, so dropping it would make the feature answer a
 * question nobody asked. `id` is stripped (see the interface doc).
 *
 * Returns `null` for an unusable name or an unrecognised `use`, so a caller
 * never has to hand-check before storing. `createdAt` is injected rather than
 * read from the clock here, keeping this function pure and its tests free of
 * a wall-clock dependency — the same discipline the render path's determinism
 * rule sets for the rest of the repo.
 */
export function presetFromLayer(
  name: string,
  use: string,
  layer: Record<string, unknown>,
  createdAt: string,
): MotionLayerPreset | null {
  const cleanName = normalizePresetName(name);
  if (cleanName === null) return null;
  if (!VALID_USES.has(use)) return null;

  const fragment: Record<string, unknown> = { ...layer };
  delete fragment.id;
  // Keep `use` inside the fragment consistent with the column beside it: the
  // fragment is what gets spread into the manifest, so a disagreement here
  // would insert a layer of the wrong primitive.
  fragment.use = use;

  return {
    id: genPresetId(),
    name: cleanName,
    use: use as PrimitiveUse,
    layer: fragment,
    createdAt,
  };
}

/** Replace the preset with this id, or append it. Used by rename and by the
 *  save path; keeps the list's own order stable so a rename does not make a
 *  row jump under the cursor. */
export function upsertPreset(
  list: readonly MotionLayerPreset[],
  preset: MotionLayerPreset,
): MotionLayerPreset[] {
  const at = list.findIndex((p) => p.id === preset.id);
  if (at < 0) return [...list, preset];
  const next = [...list];
  next[at] = preset;
  return next;
}

/** Drop one preset by id. A missing id is a no-op returning the SAME array
 *  reference, so callers can use the identity check they already use for
 *  every `manifestEdit.ts` function. */
export function removePreset(
  list: readonly MotionLayerPreset[],
  id: string,
): MotionLayerPreset[] {
  if (!list.some((p) => p.id === id)) return list as MotionLayerPreset[];
  return list.filter((p) => p.id !== id);
}

/**
 * The library as it comes off disk, made safe to render and insert.
 *
 * This file is plain JSON in the user's app-data directory: it can be
 * hand-edited, half-written by a crash, or carried over from a build whose
 * primitive set differed. So every row is checked rather than trusted, and a
 * bad one is DROPPED rather than throwing — one corrupt entry must not cost
 * the user the rest of a library they spent real time building. The same
 * "degrade to the valid subset" stance `load_presets` takes on the grading
 * side by returning an empty list for a missing file.
 *
 * Unknown `use` is the check that actually earns its keep: it is what happens
 * when a primitive is renamed or removed from the engine's enum, and an
 * un-dropped row would reach `addLayerFromPreset` and insert a layer the
 * registry cannot render.
 */
export function sanitizeLoadedPresets(raw: unknown): MotionLayerPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: MotionLayerPreset[] = [];
  const seen = new Set<string>();

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const p = item as Record<string, unknown>;

    const id = typeof p.id === 'string' ? p.id : null;
    const use = typeof p.use === 'string' ? p.use : null;
    const layer = typeof p.layer === 'object' && p.layer !== null && !Array.isArray(p.layer)
      ? (p.layer as Record<string, unknown>)
      : null;
    const name = typeof p.name === 'string' ? normalizePresetName(p.name) : null;
    if (id === null || use === null || layer === null || name === null) continue;
    if (!VALID_USES.has(use)) continue;
    // A duplicate id would make delete and rename ambiguous — keep the first.
    if (seen.has(id)) continue;
    seen.add(id);

    out.push({
      id,
      name,
      use: use as PrimitiveUse,
      layer: { ...layer, use, id: undefined } as Record<string, unknown>,
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : '',
    });
  }

  // `id: undefined` above is dropped by `JSON.stringify` on the way back out,
  // but would be a real own-property on the object in memory; strip it so an
  // inserted layer never carries an explicit `undefined` id.
  for (const p of out) delete p.layer.id;

  return out;
}

/** Newest first, falling back to the stored order when `createdAt` is absent
 *  or equal — a stable sort, so a library written before this field existed
 *  still lists in a predictable order rather than shuffling per render. */
export function presetsForDisplay(list: readonly MotionLayerPreset[]): MotionLayerPreset[] {
  return [...list].sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1));
}
