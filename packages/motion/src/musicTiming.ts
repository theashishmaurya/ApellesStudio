/**
 * @apelles/motion — timing moves to the soundtrack (D-413).
 *
 * **What it is.** The pure half of "use your own music; tell Claude which beats
 * the big move should hit": given a document with a `soundtrack`, its beat
 * analysis (`apelles-beat`, via `chroma_detect_beats`), and named moves, this
 * moves keyframe times onto beats.
 *
 * - [`compositionBeats`] / [`sceneBeats`] — the soundtrack's beats placed on
 *   the composition (absolute seconds) or in one scene (local seconds, counted
 *   from 1 within the scene). Music time at composition second `t` is
 *   `soundtrack.offset + t` (one track for the whole document).
 * - [`timeToMusic`] — named moves → `@apelles/beats`' cue grammar → new key
 *   times, as ONE new manifest (the caller commits it as one undo step).
 * - [`snapKeysToBeats`] — every key of the chosen layers onto its nearest
 *   beat within a tolerance.
 *
 * **What a move is.** A set of keyframes on one scene: a layer's (or a
 * group's, a template instance's, a custom component's) `transform` keys,
 * its `anim` property tracks (`anim:<prop>`, e.g. `anim:props.count`), its
 * entrance (`enter`, the layer's `at`), or the scene camera (`camera`). The
 * move's ANCHOR key (its first key by default, `anchor: "end"` for its last —
 * "LAND the scale on the next strong beat") goes on the beat and the move's
 * other keys shift with it, so a move keeps its own internal timing. An
 * `every … between` cue spreads ITEMS over beats: each of `layers` is an item,
 * or, for one layer, each of its selected keys.
 *
 * **What it does NOT do.** No I/O, no analysis, no commit. Children inside a
 * group are not addressable (no op addresses them; a group moves as one layer,
 * D-405). A move that would push a key outside its scene or past another key
 * on the same track is refused with its name, never clamped.
 */
import { isBeatOfKind, nearestIndex, planMoves, type BeatAnalysis, type BeatKind } from '@apelles/beats';
import { sceneDurationFrames, sceneStartFrame, totalFrames } from '@apelles/motion-engine/src/engine/build';
import type { Manifest } from '@apelles/motion-engine/src/engine/schema';

/** A beat on the Motion timeline. `at` is composition seconds
 *  ([`compositionBeats`]) or scene seconds ([`sceneBeats`]). */
export interface MotionBeat {
  at: number;
  downbeat: boolean;
  strong: boolean;
  strength: number;
  /** Bar and position in the bar, from the music. */
  bar: number;
  beat: number;
}

/** A beat in one scene, numbered within the scene from 1. */
export interface SceneBeat extends MotionBeat {
  n: number;
}

const round4 = (x: number) => Math.round(x * 10000) / 10000;

/** The soundtrack's beats on the composition, `0 <= at < duration`. */
export function compositionBeats(manifest: Manifest, analysis: BeatAnalysis): MotionBeat[] {
  const offset = manifest.soundtrack?.offset ?? 0;
  const end = totalFrames(manifest) / manifest.fps;
  return analysis.beats
    .map((b) => ({ at: round4(b.time - offset), downbeat: b.downbeat, strong: b.strong, strength: b.strength, bar: b.bar, beat: b.beat }))
    .filter((b) => b.at >= 0 && b.at < end);
}

/** The soundtrack's beats inside scene `sceneIndex`, in scene seconds. */
export function sceneBeats(manifest: Manifest, sceneIndex: number, analysis: BeatAnalysis): SceneBeat[] {
  const start = sceneStartFrame(manifest, sceneIndex) / manifest.fps;
  const dur = sceneDurationFrames(manifest, sceneIndex) / manifest.fps;
  return compositionBeats(manifest, analysis)
    .map((b) => ({ ...b, at: round4(b.at - start) }))
    .filter((b) => b.at >= 0 && b.at < dur)
    .map((b, i) => ({ ...b, n: i + 1 }));
}

// ---------------------------------------------------------------------------
// Keys

/** Which keys of a layer a move covers. */
export type TrackSel = 'all' | 'transform' | 'anim' | 'enter' | 'camera' | `anim:${string}`;

/** One key, by where it lives. `index` is its position in its array (0 for `enter`). */
interface KeyRef {
  track: 'transform' | 'enter' | 'camera' | `anim:${string}`;
  index: number;
  at: number;
}

type RawLayer = Record<string, unknown> & {
  id?: string;
  at?: number;
  transform?: { keys?: Array<{ at: number }> };
  anim?: Record<string, Array<{ at: number }>>;
};

function keyRefs(layer: RawLayer | null, camera: Array<{ at: number }> | undefined, track: TrackSel): KeyRef[] | { error: string } {
  if (track === 'camera') {
    if (!camera || camera.length === 0) return { error: 'the scene has no 2D camera keys' };
    return camera.map((k, index) => ({ track: 'camera', index, at: k.at }));
  }
  if (!layer) return { error: 'a layer is required for this track' };
  const out: KeyRef[] = [];
  if (track === 'enter') return [{ track: 'enter', index: 0, at: typeof layer.at === 'number' ? layer.at : 0 }];
  if (track === 'all' || track === 'transform') {
    (layer.transform?.keys ?? []).forEach((k, index) => out.push({ track: 'transform', index, at: k.at }));
  }
  if (track === 'all' || track === 'anim' || track.startsWith('anim:')) {
    const only = track.startsWith('anim:') ? track.slice('anim:'.length) : null;
    const anim = layer.anim ?? {};
    if (only !== null && !anim[only]) {
      return { error: `the layer has no anim track "${only}" (it has: ${Object.keys(anim).join(', ') || 'none'})` };
    }
    for (const [path, keys] of Object.entries(anim)) {
      if (only !== null && path !== only) continue;
      keys.forEach((k, index) => out.push({ track: `anim:${path}`, index, at: k.at }));
    }
  }
  if (out.length === 0) return { error: `the layer has no ${track === 'all' ? 'transform or anim' : track} keys` };
  return out.sort((a, b) => a.at - b.at || a.track.localeCompare(b.track) || a.index - b.index);
}

function pickKeys(refs: KeyRef[], keys: unknown): KeyRef[] | { error: string } {
  if (keys === undefined || keys === null || keys === 'all') return refs;
  if (keys === 'first') return [refs[0]];
  if (keys === 'last') return [refs[refs.length - 1]];
  if (Array.isArray(keys) && keys.every((k) => Number.isInteger(k))) {
    const bad = (keys as number[]).find((k) => k < 0 || k >= refs.length);
    if (bad !== undefined) return { error: `key ${bad} does not exist (this move has keys 0..${refs.length - 1}, in time order)` };
    return (keys as number[]).map((k) => refs[k]);
  }
  return { error: 'keys must be "all", "first", "last" or a list of key indices (in time order)' };
}

/** A layer in `scene` by id or index. */
function findLayer(scene: Manifest['scenes'][number], ref: unknown): { index: number; layer: RawLayer } | { error: string } {
  const layers = (scene.layers ?? []) as RawLayer[];
  if (typeof ref === 'number' && Number.isInteger(ref)) {
    const layer = layers[ref];
    return layer ? { index: ref, layer } : { error: `no layer ${ref} in this scene (0..${layers.length - 1})` };
  }
  if (typeof ref === 'string') {
    const index = layers.findIndex((l) => l.id === ref);
    if (index >= 0) return { index, layer: layers[index] };
    return { error: `no layer "${ref}" in this scene (ids: ${layers.map((l) => l.id).filter(Boolean).join(', ') || 'none'})` };
  }
  return { error: 'a layer is named by its id (or its index in the scene)' };
}

/** A key located in the document. `layer` is `null` for the camera. */
interface Located extends KeyRef {
  layer: number | null;
}

const keyId = (k: Pick<Located, 'layer' | 'track' | 'index'>) => `${k.layer ?? 'camera'}|${k.track}|${k.index}`;

/** Writes new key times into a copy of the scene, checking scene bounds and
 *  key order. */
function writeTimes(
  manifest: Manifest,
  sceneIndex: number,
  times: Map<string, { key: Located; at: number; move: string }>,
): { manifest: Manifest } | { error: string; move?: string } {
  const next = structuredClone(manifest) as Manifest;
  const scene = next.scenes[sceneIndex];
  const dur = scene.dur;
  const arrays = new Map<string, Array<{ at: number }>>();
  for (const { key, at, move } of times.values()) {
    if (at < -1e-9 || at > dur + 1e-9) {
      return { move, error: `move "${move}" would put a key at ${at.toFixed(3)} s, outside the scene (0..${dur} s)` };
    }
    const t = round4(Math.min(dur, Math.max(0, at)));
    if (key.track === 'enter') {
      (scene.layers as RawLayer[])[key.layer ?? 0].at = t;
      continue;
    }
    let arr: Array<{ at: number }> | undefined;
    if (key.track === 'camera') arr = scene.camera;
    else {
      const layer = (scene.layers as RawLayer[])[key.layer ?? 0];
      arr = key.track === 'transform' ? layer.transform?.keys : layer.anim?.[key.track.slice('anim:'.length)];
    }
    if (!arr?.[key.index]) return { move, error: `move "${move}": a key it names no longer exists` };
    arr[key.index].at = t;
    arrays.set(`${key.layer ?? 'camera'}|${key.track}`, arr);
  }
  for (const [where, arr] of arrays) {
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].at < arr[i - 1].at) {
        const [layer, track] = where.split('|');
        const owner = [...times.values()].find((v) => `${v.key.layer ?? 'camera'}|${v.key.track}` === where);
        return {
          move: owner?.move,
          error: `move "${owner?.move ?? '?'}" would make ${track} keys on ${layer === 'camera' ? 'the camera' : `layer ${layer}`} pass each other — move the keys in between too (keys: "all"), or pick another beat`,
        };
      }
    }
  }
  return { manifest: next };
}

// ---------------------------------------------------------------------------
// Time to music

/** One named move, as `motion_time_to_music` and the panel send it. */
export interface MoveSpec {
  name: string;
  cue: string;
  layer?: string | number;
  layers?: Array<string | number>;
  /** `all` (transform + anim, the default), `transform`, `anim`, `anim:<prop>`, `enter`, `camera`. */
  track?: TrackSel;
  keys?: 'all' | 'first' | 'last' | number[];
  anchor?: 'start' | 'end';
}

/** What one move did. */
export interface MovePlacement {
  name: string;
  cue: string;
  /** Beat time each item landed on, scene seconds. */
  beats: number[];
  /** Every key it moved, from → to. */
  keys: Array<{ layer: number | null; track: string; index: number; from: number; to: number }>;
}

export type TimeToMusicResult =
  | { ok: true; manifest: Manifest; moves: MovePlacement[] }
  | { ok: false; error: string; move?: string };

/** Places every move of `specs` on the beats of scene `sceneIndex`. */
export function timeToMusic(
  manifest: Manifest,
  sceneIndex: number,
  beats: readonly SceneBeat[],
  specs: readonly MoveSpec[],
): TimeToMusicResult {
  const scene = manifest.scenes[sceneIndex];
  if (!scene) return { ok: false, error: `no scene ${sceneIndex}` };
  if (specs.length === 0) return { ok: false, error: 'moves must name at least one move' };

  // Resolve each move's items (units of keys).
  const units: Located[][][] = [];
  for (const spec of specs) {
    const name = String(spec.name ?? '');
    const track = (spec.track ?? (spec.layer === undefined && spec.layers === undefined ? 'camera' : 'all')) as TrackSel;
    if (!isTrackSel(track)) return { ok: false, move: name, error: `move "${name}": track must be all, transform, anim, anim:<prop>, enter or camera` };
    const refsOf = (layerRef: unknown): Located[] | { error: string } => {
      let layerIndex: number | null = null;
      let layer: RawLayer | null = null;
      if (track !== 'camera') {
        const found = findLayer(scene, layerRef);
        if ('error' in found) return found;
        layerIndex = found.index;
        layer = found.layer;
      }
      const refs = keyRefs(layer, scene.camera, track);
      if ('error' in refs) return refs;
      const picked = pickKeys(refs, spec.keys);
      if ('error' in picked) return picked;
      return picked.map((r) => ({ ...r, layer: layerIndex }));
    };
    const cueIsEvery = /^\s*every\b/i.test(spec.cue ?? '');
    let items: Located[][];
    if (Array.isArray(spec.layers)) {
      if (spec.layers.length === 0) return { ok: false, move: name, error: `move "${name}": layers is empty` };
      items = [];
      for (const l of spec.layers) {
        const r = refsOf(l);
        if ('error' in r) return { ok: false, move: name, error: `move "${name}": ${r.error}` };
        items.push(r);
      }
    } else {
      const r = refsOf(spec.layer);
      if ('error' in r) return { ok: false, move: name, error: `move "${name}": ${r.error}` };
      items = cueIsEvery ? r.map((k) => [k]) : [r];
    }
    units.push(items);
  }

  const plan = planMoves(
    beats,
    specs.map((s, i) => ({ name: String(s.name ?? ''), cue: String(s.cue ?? ''), items: units[i].length })),
  );
  if (!plan.ok) return plan;

  const times = new Map<string, { key: Located; at: number; move: string }>();
  const moves: MovePlacement[] = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const placement: MovePlacement = { name: spec.name, cue: spec.cue, beats: plan.plans[i].times, keys: [] };
    for (let u = 0; u < units[i].length; u++) {
      const unit = units[i][u];
      const target = plan.plans[i].times[u];
      const anchorAt = spec.anchor === 'end' ? Math.max(...unit.map((k) => k.at)) : Math.min(...unit.map((k) => k.at));
      const delta = target - anchorAt;
      for (const key of unit) {
        const id = keyId(key);
        const to = key.at + delta;
        const prev = times.get(id);
        if (prev && prev.move !== spec.name) {
          return {
            ok: false,
            move: spec.name,
            error: `moves "${prev.move}" and "${spec.name}" both move the same key (${key.track} key ${key.index}); give each move its own keys`,
          };
        }
        times.set(id, { key, at: to, move: spec.name });
        placement.keys.push({ layer: key.layer, track: key.track, index: key.index, from: key.at, to: round4(to) });
      }
    }
    moves.push(placement);
  }
  const written = writeTimes(manifest, sceneIndex, times);
  if ('error' in written) return { ok: false, error: written.error, move: written.move };
  return { ok: true, manifest: written.manifest, moves };
}

function isTrackSel(t: string): t is TrackSel {
  return ['all', 'transform', 'anim', 'enter', 'camera'].includes(t) || (t.startsWith('anim:') && t.length > 5);
}

// ---------------------------------------------------------------------------
// Snap

export interface SnapReport {
  layer: number | null;
  track: string;
  index: number;
  from: number;
  to: number | null;
  reason?: string;
}

/** Every key of the named layers (all keyed layers when `layers` is absent,
 *  plus the camera when `includeCamera`) moved onto its nearest beat of `kind`
 *  within `tolerance` seconds. Keys that would collide or cross are left with
 *  a reason. */
export function snapKeysToBeats(
  manifest: Manifest,
  sceneIndex: number,
  beats: readonly SceneBeat[],
  opts: { layers?: Array<string | number>; track?: TrackSel; kind?: BeatKind; tolerance: number; includeCamera?: boolean },
): { ok: true; manifest: Manifest; keys: SnapReport[] } | { ok: false; error: string } {
  const scene = manifest.scenes[sceneIndex];
  if (!scene) return { ok: false, error: `no scene ${sceneIndex}` };
  const targets = beats.filter((b) => isBeatOfKind(b, opts.kind ?? 'beat')).map((b) => b.at);
  if (targets.length === 0) return { ok: false, error: 'this scene has no beats of that kind to snap to' };
  const track = opts.track ?? 'all';
  const groups: Located[][] = [];
  const layerRefs: unknown[] = opts.layers ?? (scene.layers ?? []).map((_, i) => i);
  for (const ref of layerRefs) {
    const found = findLayer(scene, ref);
    if ('error' in found) {
      if (opts.layers) return { ok: false, error: found.error };
      continue;
    }
    const refs = keyRefs(found.layer, undefined, track);
    if ('error' in refs) {
      if (opts.layers) return { ok: false, error: `layer ${String(ref)}: ${refs.error}` };
      continue;
    }
    groups.push(refs.map((r) => ({ ...r, layer: found.index })));
  }
  if (opts.includeCamera && scene.camera?.length) {
    groups.push(scene.camera.map((k, index) => ({ track: 'camera' as const, index, at: k.at, layer: null })));
  }
  const report: SnapReport[] = [];
  const times = new Map<string, { key: Located; at: number; move: string }>();
  for (const group of groups) {
    // Per track: snap in time order, keep order strictly increasing.
    const byTrack = new Map<string, Located[]>();
    for (const k of group) {
      const list = byTrack.get(k.track) ?? [];
      list.push(k);
      byTrack.set(k.track, list);
    }
    for (const list of byTrack.values()) {
      let last = -Infinity;
      const ordered = [...list].sort((a, b) => a.index - b.index);
      for (let j = 0; j < ordered.length; j++) {
        const k = ordered[j];
        const nextAt = ordered[j + 1]?.at ?? Infinity;
        const i = nearestIndex(targets, k.at);
        const to = i >= 0 && Math.abs(targets[i] - k.at) <= opts.tolerance ? targets[i] : null;
        const base = { layer: k.layer, track: k.track, index: k.index, from: k.at };
        if (to === null) {
          report.push({ ...base, to: null, reason: `no beat within ${opts.tolerance} s` });
          last = Math.max(last, k.at);
        } else if (to >= nextAt) {
          report.push({ ...base, to: null, reason: 'its nearest beat is past the key after it' });
          last = Math.max(last, k.at);
        } else if (to <= last) {
          report.push({ ...base, to: null, reason: 'its nearest beat is taken by the key before it' });
          last = Math.max(last, k.at);
        } else if (Math.abs(to - k.at) < 1e-9) {
          report.push({ ...base, to: null, reason: 'already on a beat' });
          last = to;
        } else {
          times.set(keyId(k), { key: k, at: to, move: 'snap' });
          report.push({ ...base, to });
          last = to;
        }
      }
    }
  }
  const written = writeTimes(manifest, sceneIndex, times);
  if ('error' in written) return { ok: false, error: written.error };
  return { ok: true, manifest: written.manifest, keys: report };
}
