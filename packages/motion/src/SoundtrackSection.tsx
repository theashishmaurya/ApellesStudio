/**
 * @apelles/motion — the soundtrack and "time to music" forms (D-413).
 *
 * **What it is.** The human half of `motion_set_soundtrack`,
 * `motion_time_to_music` and `motion_snap_to_beats`:
 *
 * - [`SoundtrackSection`] (Inspector, nothing selected = the document): choose
 *   the music (imported by content hash, the same `chroma_motion_import_asset`
 *   the tool runs), its offset into the song, monitor/render volume, whether
 *   it is rendered into the scene files, the meter, and its tempo readout.
 * - [`TimeToMusicSection`] (Inspector, a scene selected): the reel's prompt as
 *   a form — rows of named moves (layer, which keys, cue, anchor) placed on the
 *   scene's beats in one undo step, plus "Snap keys to beats".
 *
 * Both write through `applySoundtrack` / `timeToMusic` / `snapKeysToBeats`,
 * the functions the ops call, so the person and the agent make the same
 * document. Cues are `@apelles/beats`' grammar; the suggestions list its forms.
 *
 * **What it does NOT do.** No analysis (the bridge's cache, via
 * `useSoundtrackBeats`) and no audio playback (the player plays the
 * soundtrack, `Video.tsx`).
 */
import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { InspectorSection } from '@apelles/inspector';
import { ASSET_AUDIO_EXTENSIONS, AUDIO_ASSET_ID_PATTERN } from '@apelles/motion-engine/src/lib/assetId';
import type { Manifest, Soundtrack } from '@apelles/motion-engine/src/engine/schema';
import { Button } from './Button';
import { importAsset } from './manifestIO';
import { applySoundtrack, DEFAULT_SNAP_TOLERANCE_S } from './musicOps';
import { sceneBeats, snapKeysToBeats, timeToMusic, type MoveSpec, type TrackSel } from './musicTiming';
import { useSoundtrackBeats } from './useSoundtrackBeats';

const label = 'text-[10px] text-text-secondary';
const inputBase =
  'w-full h-7 rounded border border-border-color bg-transparent px-1.5 text-[11px] text-text-primary focus:outline-none focus:border-accent';

/** The cue forms offered as suggestions (any `@apelles/beats` cue is accepted). */
export const CUE_SUGGESTIONS = [
  'downbeat 1',
  'next strong beat',
  'next downbeat',
  'next beat',
  'every beat between',
  'every downbeat between',
  'bar 2 beat 3',
  'last downbeat',
] as const;

const TRACKS: Array<{ value: TrackSel; label: string }> = [
  { value: 'all', label: 'all keys' },
  { value: 'transform', label: 'transform keys' },
  { value: 'anim', label: 'property tracks' },
  { value: 'enter', label: 'entrance' },
];

export function SoundtrackSection({ manifest, onChange }: { manifest: Manifest; onChange: (next: Manifest) => void }) {
  const st = manifest.soundtrack;
  const beats = useSoundtrackBeats(manifest);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = (p: Partial<Soundtrack>) => {
    if (!st) return;
    onChange(applySoundtrack(manifest, { ...st, ...p }));
  };

  const choose = async () => {
    setError(null);
    setBusy(true);
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'Audio', extensions: [...ASSET_AUDIO_EXTENSIONS] }],
      });
      if (typeof picked !== 'string') return;
      const rec = await importAsset(picked);
      if (!AUDIO_ASSET_ID_PATTERN.test(rec.id)) {
        setError('that file is not audio');
        return;
      }
      onChange(applySoundtrack(manifest, { ...(st?.src === rec.id ? st : {}), src: rec.id }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const num = (raw: string, lo: number, hi: number): number | null => {
    const v = Number(raw);
    return Number.isFinite(v) && v >= lo && v <= hi ? v : null;
  };

  return (
    <InspectorSection label="Soundtrack">
      <div className="flex items-center gap-2">
        <Button variant="secondary" disabled={busy} onClick={() => void choose()}>
          {st ? 'Change music…' : 'Choose music…'}
        </Button>
        {st && (
          <Button variant="secondary" onClick={() => onChange(applySoundtrack(manifest, null))}>
            Remove
          </Button>
        )}
      </div>
      {error && <span className="text-[10px] text-red-400">{error}</span>}
      {st && (
        <>
          <span className={label} title={st.src}>
            {beats.status === 'ready'
              ? `${Math.round(beats.analysis.tempoBpm)} BPM · ${beats.analysis.meter}/4 · ${beats.analysis.beats.filter((b) => b.downbeat).length} bars`
              : beats.status === 'loading'
                ? 'analysing beats…'
                : beats.status === 'error'
                  ? `beats failed: ${beats.error}`
                  : ''}
          </span>
          <label className="flex flex-col gap-1">
            <span className={label}>Start of the video, seconds into the song</span>
            <input
              className={inputBase}
              type="number"
              min={0}
              step={0.01}
              defaultValue={st.offset ?? 0}
              key={`offset-${st.src}-${st.offset ?? 0}`}
              onBlur={(e) => {
                const v = num(e.currentTarget.value, 0, 86_400);
                if (v !== null && v !== (st.offset ?? 0)) patch({ offset: v });
              }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={label}>Volume (0–1)</span>
            <input
              className={inputBase}
              type="number"
              min={0}
              max={1}
              step={0.05}
              defaultValue={st.volume ?? 1}
              key={`volume-${st.src}-${st.volume ?? 1}`}
              onBlur={(e) => {
                const v = num(e.currentTarget.value, 0, 1);
                if (v !== null && v !== (st.volume ?? 1)) patch({ volume: v });
              }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className={label}>Beats per bar</span>
            <input
              className={inputBase}
              type="number"
              min={2}
              max={7}
              step={1}
              defaultValue={st.meter ?? 4}
              key={`meter-${st.src}-${st.meter ?? 4}`}
              onBlur={(e) => {
                const v = num(e.currentTarget.value, 2, 7);
                if (v !== null && Number.isInteger(v) && v !== (st.meter ?? 4)) patch({ meter: v });
              }}
            />
          </label>
          <label className="flex items-center gap-2 text-[11px] text-text-primary">
            <input type="checkbox" checked={st.render === true} onChange={(e) => patch({ render: e.currentTarget.checked })} />
            Include the music in rendered scenes
          </label>
        </>
      )}
    </InspectorSection>
  );
}

interface MoveRow {
  name: string;
  layer: string;
  track: TrackSel;
  cue: string;
  anchor: 'start' | 'end';
}

/** A layer's handle in the form: its id, or `#<index>` when it has none. */
function layerHandle(layer: { id?: unknown }, i: number): string {
  return typeof layer.id === 'string' && layer.id ? layer.id : `#${i}`;
}

function layerRef(handle: string): string | number {
  return handle.startsWith('#') ? Number(handle.slice(1)) : handle;
}

export function TimeToMusicSection({
  manifest,
  sceneIndex,
  onChange,
}: {
  manifest: Manifest;
  sceneIndex: number;
  onChange: (next: Manifest) => void;
}) {
  const beats = useSoundtrackBeats(manifest);
  const layers = (manifest.scenes[sceneIndex]?.layers ?? []) as Array<{ id?: unknown; use?: unknown }>;
  const first = layers[0] ? layerHandle(layers[0], 0) : '';
  const [rows, setRows] = useState<MoveRow[]>([
    { name: 'reveal', layer: first, track: 'enter', cue: 'downbeat 1', anchor: 'start' },
  ]);
  const [message, setMessage] = useState<string | null>(null);
  if (!manifest.soundtrack) return null;

  const set = (i: number, p: Partial<MoveRow>) => setRows((cur) => cur.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const ready = beats.status === 'ready';
  const local = ready ? sceneBeats(manifest, sceneIndex, beats.analysis) : [];

  const apply = () => {
    if (!ready) return;
    const specs: MoveSpec[] = rows.map((r) => ({
      name: r.name,
      cue: r.cue,
      layer: layerRef(r.layer),
      track: r.track,
      anchor: r.anchor,
    }));
    const res = timeToMusic(manifest, sceneIndex, local, specs);
    if (!res.ok) {
      setMessage(res.error);
      return;
    }
    setMessage(res.moves.map((m) => `${m.name} → ${m.beats.map((b) => `${b.toFixed(2)} s`).join(', ')}`).join(' · '));
    onChange(res.manifest);
  };

  const snap = () => {
    if (!ready) return;
    const res = snapKeysToBeats(manifest, sceneIndex, local, { tolerance: DEFAULT_SNAP_TOLERANCE_S });
    if (!res.ok) {
      setMessage(res.error);
      return;
    }
    const moved = res.keys.filter((k) => k.to !== null).length;
    setMessage(`snapped ${moved} key${moved === 1 ? '' : 's'}`);
    if (moved > 0) onChange(res.manifest);
  };

  return (
    <InspectorSection label="Time to music">
      <span className={label}>
        {ready
          ? `${local.length} beats, ${local.filter((b) => b.downbeat).length} downbeats in this scene`
          : beats.status === 'error'
            ? `beats failed: ${beats.error}`
            : 'analysing beats…'}
      </span>
      <datalist id="apelles-cue-suggestions">
        {CUE_SUGGESTIONS.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      {rows.map((r, i) => (
        <div key={i} className="flex flex-col gap-1 rounded border border-border-color/60 p-1.5">
          <div className="flex gap-1">
            <input className={inputBase} aria-label="Move name" value={r.name} onChange={(e) => set(i, { name: e.currentTarget.value })} />
            <select className={inputBase} aria-label="Layer" value={r.layer} onChange={(e) => set(i, { layer: e.currentTarget.value })}>
              {layers.map((l, j) => (
                <option key={j} value={layerHandle(l, j)}>
                  {layerHandle(l, j)} ({String(l.use)})
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-1">
            <select className={inputBase} aria-label="Which keys" value={r.track} onChange={(e) => set(i, { track: e.currentTarget.value as TrackSel })}>
              {TRACKS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <select className={inputBase} aria-label="Anchor" value={r.anchor} onChange={(e) => set(i, { anchor: e.currentTarget.value as 'start' | 'end' })}>
              <option value="start">starts on</option>
              <option value="end">lands on</option>
            </select>
          </div>
          <div className="flex gap-1">
            <input
              className={inputBase}
              aria-label="Cue"
              list="apelles-cue-suggestions"
              value={r.cue}
              onChange={(e) => set(i, { cue: e.currentTarget.value })}
            />
            <Button variant="secondary" aria-label="Remove move" onClick={() => setRows((cur) => cur.filter((_, j) => j !== i))}>
              ×
            </Button>
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() => setRows((cur) => [...cur, { name: `move ${cur.length + 1}`, layer: first, track: 'all', cue: 'next strong beat', anchor: 'end' }])}
        >
          Add move
        </Button>
        <Button disabled={!ready || rows.length === 0} onClick={apply}>
          Time to music
        </Button>
        <Button variant="secondary" disabled={!ready} onClick={snap}>
          Snap keys to beats
        </Button>
      </div>
      {message && <span className="text-[10px] text-text-secondary">{message}</span>}
    </InspectorSection>
  );
}
