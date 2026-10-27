/**
 * @apelles/motion — authoring a graphic as DATA (D-403).
 *
 * What it is: the two "land a validated fragment" plans that both interfaces
 * share — insert whole layers into a scene, replace (or append) a whole scene.
 * Each plan validates the fragment strictly (unknown keys refused, the same
 * `validate.ts` issues `motion_validate` reports), applies the pure
 * `manifestEdit.ts` edit, checks the resulting document still loads, and
 * returns either the next manifest or the refusal. `motion_insert_layers` /
 * `motion_set_scene` (`motionOps.ts`) and the Catalog panel's "Insert JSON"
 * box (`CatalogPanel.tsx`, via `MotionTab.tsx`) call exactly these, then commit
 * the result through the one undoable `commit` — so a human pasting a fragment
 * and an agent sending one get the same checks and the same edit.
 *
 * What it does NOT do: commit, parse wire arguments, or touch React. Pure.
 */
import type { Manifest } from '@apelles/motion-engine/src/engine/schema';
import { formatIssues, validateLayers, validateScene, type ValidationIssue } from '@apelles/motion-engine/src/engine/validate';
import { manifestSchema } from '@apelles/motion-engine/src/engine/schema';
import { containsIcon, iconIssues, issuesFromZod } from '@apelles/motion-engine/src/engine/validate';
import { loadPhosphorIcons } from '@apelles/motion-engine/src/lib/phosphorIcons';
import { insertLayers, replaceScene } from './manifestEdit';
import { checkSceneRename } from './editLinks';
import type { Selection } from './LayerList';
import type { MotionEditLinks } from './motionOps';

/** What a refused plan (or op) answers: the reason as text plus the issues. */
export interface MotionRefusal {
  error: string;
  issues: ValidationIssue[];
}

/** `null` when `next` parses under `manifestSchema`, else the refusal naming
 *  every issue. The LOAD level only (see `validate.ts`): an edit to a document
 *  that carries some legacy unknown key must still work, so unknown keys are
 *  checked on the fragments being added, not on the whole document. */
export function refusalFor(next: Manifest): MotionRefusal | null {
  const parsed = manifestSchema.safeParse(next);
  if (parsed.success) return null;
  const issues = issuesFromZod(parsed.error, manifestSchema, next);
  return { error: `refused: the result would not be a valid manifest\n${formatIssues(issues)}`, issues };
}

/** The refusal for a fragment that failed strict validation. */
export function fragmentRefusal(what: string, issues: ValidationIssue[]): MotionRefusal {
  return { error: `refused: ${what} did not validate\n${formatIssues(issues)}`, issues };
}

/** the placeholder id a not-yet-appended scene is checked under — contains a
 *  "/", which `checkSceneRename` rejects as an id, so it can never collide with
 *  a real one (B-242/D-371's same trick in `motion_add_scene`). */
export const NEW_SCENE_ID_PLACEHOLDER = '/new-scene';

/** D-405 — the installed Phosphor names, loaded only when `fragment` has an
 *  `icon` layer somewhere (so a fragment without one never pays for the
 *  library); `undefined` otherwise. What the plans' `iconNames` takes. */
export async function iconNamesFor(fragment: unknown): Promise<ReadonlySet<string> | undefined> {
  if (!containsIcon(fragment)) return undefined;
  return new Set((await loadPhosphorIcons()).keys());
}

export type PlanResult<T> = ({ ok: true; manifest: Manifest } & T) | ({ ok: false } & MotionRefusal);

/** Validate `layers` strictly and insert them into scene `sceneIndex` (2D at
 *  `at`, 3D children appended), checking the result loads. */
export function planInsertLayers(
  manifest: Manifest,
  sceneIndex: number,
  layers: unknown,
  at?: number,
  iconNames?: ReadonlySet<string>,
): PlanResult<{ selections: Selection[]; count: number }> {
  if (!manifest.scenes[sceneIndex]) {
    return { ok: false, error: `no scene at index ${sceneIndex} (0..${manifest.scenes.length - 1})`, issues: [] };
  }
  if (!Array.isArray(layers) || layers.length === 0) {
    return { ok: false, error: 'layers (non-empty array of layer objects, each with a "use") required', issues: [] };
  }
  const checked = validateLayers(layers);
  const issues = [...checked.issues, ...(iconNames ? iconIssues(layers, iconNames, ['layers']) : [])];
  if (issues.length > 0) return { ok: false, ...fragmentRefusal('layers', issues) };
  const { manifest: next, selections } = insertLayers(manifest, sceneIndex, layers as Record<string, unknown>[], at);
  const refused = refusalFor(next);
  if (refused) return { ok: false, ...refused };
  return { ok: true, manifest: next, selections, count: layers.length };
}

/** Validate `scene` strictly and put it at `sceneIndex` (replacing that scene,
 *  or appending when `sceneIndex` is the scene count), running the D-371
 *  rename pre-flight when it brings a different `id`. */
export function planSetScene(
  manifest: Manifest,
  sceneIndex: number,
  scene: unknown,
  links: MotionEditLinks | undefined,
  iconNames?: ReadonlySet<string>,
): PlanResult<{ appended: boolean }> {
  const appending = sceneIndex === manifest.scenes.length;
  if (!appending && !manifest.scenes[sceneIndex]) {
    return {
      ok: false,
      error: `scene_index must be an existing scene (0..${manifest.scenes.length - 1}) or ${manifest.scenes.length} to append`,
      issues: [],
    };
  }
  if (!scene || typeof scene !== 'object' || Array.isArray(scene)) {
    return { ok: false, error: 'scene (a scene object: {id?, dur, layers?, camera?, scene3d?, ...}) required', issues: [] };
  }
  const raw = scene as Record<string, unknown>;
  // `id` is optional here (kept or generated), so validate a copy that has one.
  const fallbackId = appending ? 'new-scene' : manifest.scenes[sceneIndex].id;
  const checked = validateScene({ id: fallbackId, ...raw }, sceneIndex);
  const issues = [...checked.issues, ...(iconNames ? iconIssues(raw, iconNames, ['scenes', sceneIndex]) : [])];
  if (issues.length > 0) return { ok: false, ...fragmentRefusal('scene', issues) };

  if (typeof raw.id === 'string' && (appending || raw.id !== manifest.scenes[sceneIndex].id)) {
    const scenes = appending ? [...manifest.scenes, { id: NEW_SCENE_ID_PLACEHOLDER }] : manifest.scenes;
    const index = appending ? scenes.length - 1 : sceneIndex;
    const check = checkSceneRename(scenes, index, raw.id, appending ? undefined : links);
    if (!check.ok) return { ok: false, error: check.reason, issues: [] };
  }

  const { manifest: next } = replaceScene(manifest, sceneIndex, raw);
  const refused = refusalFor(next);
  if (refused) return { ok: false, ...refused };
  return { ok: true, manifest: next, appended: appending };
}
