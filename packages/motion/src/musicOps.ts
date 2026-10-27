/**
 * @apelles/motion — the soundtrack ops: `motion_set_soundtrack`,
 * `motion_get_beats`, `motion_time_to_music`, `motion_snap_to_beats` (D-413).
 *
 * **What it is.** The op half of "use your own music": set the document's
 * soundtrack (importing the file by content hash, D-404), read its beats per
 * scene, map named moves to beats, and snap keys to beats. Each mutating op is
 * ONE commit through the guarded `commit`, so it is one undo step on the shared
 * history and a document that would not parse is refused, like every other op.
 * The Soundtrack section and the Time to music form in the Motion tab call the
 * same functions ([`applySoundtrack`], `musicTiming.ts`), so a person and an
 * agent produce the same document.
 *
 * **What it does NOT do.** No Tauri: the beat analysis and the asset import
 * arrive through the context (`soundtrackBeats`, `importAsset`), injected for
 * the same reason `preview` is (this factory runs under `node` vitest).
 */
import { BEAT_KINDS, beatParamsProblem, type BeatKind, type FileBeats } from '@apelles/beats';
import { AUDIO_ASSET_ID_PATTERN } from '@apelles/motion-engine/src/lib/assetId';
import type { Manifest, Soundtrack } from '@apelles/motion-engine/src/engine/schema';
import {
  compositionBeats,
  sceneBeats,
  snapKeysToBeats,
  timeToMusic,
  type MoveSpec,
  type SceneBeat,
  type TrackSel,
} from './musicTiming';
import type { MotionAssetRecord } from './manifestIO';

type Args = Record<string, unknown>;
type Result = Record<string, unknown>;

/** An arg under its `snake_case` (what the MCP servers send) or `camelCase`
 *  spelling, like every other Motion op (`motionOps.ts`'s `arg`). */
function pick(a: Args | undefined, snake: string, camel: string): unknown {
  return a?.[snake] ?? a?.[camel];
}

/** What these ops need from the outside. */
export interface MusicOpsDeps {
  manifest: () => Manifest | null;
  noManifest: () => Result | null;
  commit: (next: Manifest, label: string) => void;
  importAsset?: (path: string) => Promise<MotionAssetRecord>;
  soundtrackBeats?: (soundtrack: Soundtrack) => Promise<FileBeats>;
}

/** Default snap reach, seconds: a little under a 16th note at 120 BPM. */
export const DEFAULT_SNAP_TOLERANCE_S = 0.1;

/** The document with `soundtrack` set, or removed for `null`. */
export function applySoundtrack(manifest: Manifest, soundtrack: Soundtrack | null): Manifest {
  const next = { ...manifest };
  if (soundtrack) next.soundtrack = soundtrack;
  else delete next.soundtrack;
  return next;
}

/** A per-scene beat summary — what an agent reads before choosing cues. */
function sceneSummary(manifest: Manifest, fb: FileBeats) {
  return manifest.scenes.map((s, i) => {
    const beats = sceneBeats(manifest, i, fb.analysis);
    const downs = beats.filter((b) => b.downbeat);
    return {
      sceneIndex: i,
      id: s.id,
      beats: beats.length,
      downbeats: downs.length,
      firstBeatAt: beats[0]?.at ?? null,
      firstDownbeatAt: downs[0]?.at ?? null,
    };
  });
}

function beatRow(b: SceneBeat) {
  return { n: b.n, at: b.at, bar: b.bar, beat: b.beat, downbeat: b.downbeat, strong: b.strong, strength: b.strength };
}

export function createMusicOps(deps: MusicOpsDeps): Record<string, (a: Args) => Result | Promise<Result>> {
  /** The soundtrack's analysis, or the reason there is none. */
  const analysisFor = async (manifest: Manifest): Promise<FileBeats | { error: string }> => {
    if (!manifest.soundtrack) {
      return { error: 'this document has no soundtrack — set one with motion_set_soundtrack (or the Soundtrack section)' };
    }
    if (!deps.soundtrackBeats) return { error: 'beat analysis is not available in this build' };
    try {
      return await deps.soundtrackBeats(manifest.soundtrack);
    } catch (e) {
      return { error: `analysing the soundtrack failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  };

  const sceneArg = (manifest: Manifest, raw: unknown): number | { error: string } => {
    const i = typeof raw === 'number' ? raw : Number.NaN;
    if (!Number.isInteger(i) || !manifest.scenes[i]) return { error: `scene_index must be 0..${manifest.scenes.length - 1}` };
    return i;
  };

  const kindArg = (raw: unknown): BeatKind | { error: string } =>
    raw === undefined || raw === null
      ? 'beat'
      : BEAT_KINDS.includes(raw as BeatKind)
        ? (raw as BeatKind)
        : { error: `to/kind must be one of ${BEAT_KINDS.join(' | ')}` };

  return {
    motion_set_soundtrack: async (a) => {
      const blocked = deps.noManifest();
      if (blocked) return blocked;
      const manifest = deps.manifest() as Manifest;
      if (a?.clear === true) {
        if (manifest.soundtrack) deps.commit(applySoundtrack(manifest, null), 'Remove soundtrack');
        return { ok: true, soundtrack: null };
      }
      let src = typeof a?.asset === 'string' ? a.asset : manifest.soundtrack?.src;
      if (typeof a?.path === 'string' && a.path.length > 0) {
        if (!deps.importAsset) return { error: 'asset import is not available in this build' };
        const rec = await deps.importAsset(a.path);
        if (rec.kind === 'image' || !AUDIO_ASSET_ID_PATTERN.test(rec.id)) {
          return { error: `${a.path} is not an audio file (mp3, wav, m4a, aac, flac, ogg)` };
        }
        src = rec.id;
      }
      if (!src) return { error: 'pass path (an audio file to import) or asset (an audio asset id); this document has no soundtrack yet' };
      if (!AUDIO_ASSET_ID_PATTERN.test(src)) return { error: `asset must be an audio asset id (sha256:<hex>.mp3 …), got ${src}` };
      const problem = beatParamsProblem(a?.meter, pick(a, 'tempo_hint', 'tempoHint'));
      if (problem) return { error: problem.replace('tempo_hint_bpm', 'tempo_hint') };
      const keep = manifest.soundtrack && manifest.soundtrack.src === src ? manifest.soundtrack : undefined;
      const next: Soundtrack = { ...(keep ?? {}), src };
      const num = (k: 'offset' | 'volume', lo: number, hi: number): string | null => {
        const v = a?.[k];
        if (v === undefined || v === null) return null;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) return `${k} must be ${lo}..${hi}`;
        next[k] = v;
        return null;
      };
      const bad = num('offset', 0, 86_400) ?? num('volume', 0, 1);
      if (bad) return { error: bad };
      if (typeof a?.render === 'boolean') next.render = a.render;
      if (typeof a?.meter === 'number') next.meter = a.meter;
      const hint = pick(a, 'tempo_hint', 'tempoHint');
      if (typeof hint === 'number') next.tempoHint = hint;
      const after = applySoundtrack(manifest, next);
      if (JSON.stringify(manifest.soundtrack ?? null) !== JSON.stringify(next)) deps.commit(after, 'Soundtrack');
      const fb = await analysisFor(after);
      if ('error' in fb) return { ok: true, soundtrack: next, beatsError: fb.error };
      const all = compositionBeats(after, fb.analysis);
      return {
        ok: true,
        soundtrack: next,
        tempoBpm: fb.analysis.tempoBpm,
        meter: fb.analysis.meter,
        musicSeconds: fb.analysis.duration,
        beatsInDocument: all.length,
        downbeatsInDocument: all.filter((b) => b.downbeat).length,
        scenes: sceneSummary(after, fb),
      };
    },

    motion_get_beats: async (a) => {
      const blocked = deps.noManifest();
      if (blocked) return blocked;
      const manifest = deps.manifest() as Manifest;
      const scene = sceneArg(manifest, pick(a, 'scene_index', 'sceneIndex'));
      if (typeof scene !== 'number') return scene;
      const kind = kindArg(a?.kind);
      if (typeof kind !== 'string') return kind;
      const fb = await analysisFor(manifest);
      if ('error' in fb) return fb;
      const beats = sceneBeats(manifest, scene, fb.analysis);
      const shown = beats.filter((b) => kind === 'beat' || (kind === 'downbeat' ? b.downbeat : b.strong));
      return {
        sceneIndex: scene,
        tempoBpm: fb.analysis.tempoBpm,
        meter: fb.analysis.meter,
        kind,
        count: shown.length,
        beats: shown.map(beatRow),
      };
    },

    motion_time_to_music: async (a) => {
      const blocked = deps.noManifest();
      if (blocked) return blocked;
      const manifest = deps.manifest() as Manifest;
      const scene = sceneArg(manifest, pick(a, 'scene_index', 'sceneIndex'));
      if (typeof scene !== 'number') return scene;
      if (!Array.isArray(a?.moves)) {
        return { error: 'moves must be a list of {name, cue, layer | layers, track?, keys?, anchor?}' };
      }
      const fb = await analysisFor(manifest);
      if ('error' in fb) return fb;
      const beats = sceneBeats(manifest, scene, fb.analysis);
      const r = timeToMusic(manifest, scene, beats, a.moves as MoveSpec[]);
      if (!r.ok) return { error: r.error, ...(r.move ? { move: r.move } : {}) };
      const dryRun = pick(a, 'dry_run', 'dryRun') === true;
      if (!dryRun) deps.commit(r.manifest, 'Time to music');
      return { ok: true, dryRun, sceneIndex: scene, moves: r.moves };
    },

    motion_snap_to_beats: async (a) => {
      const blocked = deps.noManifest();
      if (blocked) return blocked;
      const manifest = deps.manifest() as Manifest;
      const scene = sceneArg(manifest, pick(a, 'scene_index', 'sceneIndex'));
      if (typeof scene !== 'number') return scene;
      const kind = kindArg(a?.to);
      if (typeof kind !== 'string') return kind;
      const tol = pick(a, 'tolerance_s', 'toleranceS') ?? DEFAULT_SNAP_TOLERANCE_S;
      if (typeof tol !== 'number' || !Number.isFinite(tol) || tol <= 0) return { error: 'tolerance_s must be a positive number of seconds' };
      const layers = a?.layers;
      if (layers !== undefined && layers !== null && !Array.isArray(layers)) return { error: 'layers must be a list of layer ids (or indexes)' };
      const fb = await analysisFor(manifest);
      if ('error' in fb) return fb;
      const r = snapKeysToBeats(manifest, scene, sceneBeats(manifest, scene, fb.analysis), {
        layers: Array.isArray(layers) ? (layers as Array<string | number>) : undefined,
        track: (typeof a?.track === 'string' ? a.track : 'all') as TrackSel,
        kind,
        tolerance: tol,
        includeCamera: pick(a, 'include_camera', 'includeCamera') === true,
      });
      if (!r.ok) return { error: r.error };
      const moved = r.keys.filter((k) => k.to !== null).length;
      const dryRun = pick(a, 'dry_run', 'dryRun') === true;
      if (!dryRun && moved > 0) deps.commit(r.manifest, 'Snap keys to beats');
      return { ok: true, dryRun, sceneIndex: scene, moved, keys: r.keys };
    },
  };
}
