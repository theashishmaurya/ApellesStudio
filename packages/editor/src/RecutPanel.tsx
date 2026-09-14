/**
 * @apelles/editor — the Edit tab's RECUT library (D-318).
 *
 * **What it is.** The human half of silence + retake detection: pick a clip,
 * run a detector, see what it found, tick the ones you agree with, cut them.
 * The GUI counterpart of `editor_detect_silences` / `editor_detect_retakes` /
 * `editor_ripple_delete_ranges`, and deliberately not a re-implementation of
 * any of them — both interfaces call the same two Tauri commands, convert
 * through the same `recut.ts` helpers, and cut with the same
 * `ripple_delete_ranges` store op. One detector, one rounding rule, one undo
 * entry, whichever asked (CLAUDE.md: every feature is built for a human AND an
 * AI).
 *
 * **Nothing is cut until you say so, and that is the whole design.** Detection
 * only ever *proposes*. Every candidate arrives unticked; the Cut button is
 * disabled until at least one is ticked and names exactly how many ranges it
 * will remove. A retake group's suggested keep (the last take) is pre-excluded
 * from the cut rather than pre-ticked for deletion, because the failure modes
 * are not symmetric — a missed cut is a second's work to fix, and a take
 * deleted by a checkbox nobody read is gone behind an undo the user has to
 * think to press.
 *
 * **What it does NOT do.** It does not transcribe (it asks
 * `mediaUnderstandingStore` for a cached transcript and reports honestly when
 * one is still running), it owns no timeline state, and it does not paint
 * anything on the timeline — the candidates live in this panel until they are
 * applied or discarded. Highlighting pending cuts on the timeline itself is a
 * real follow-up and deliberately not smuggled in here.
 *
 * **Tier note for its tests.** `RecutPanel.dom.test.tsx` mounts this with a
 * real store and stubbed `invoke`, and drives real clicks — it proves the
 * handlers, the candidate list and the op that comes out. It does not prove the
 * VAD is right; that is the Rust crate's own 33 tests and its live model check.
 */

import { useState } from 'react';
import { ScissorsIcon, SpinnerIcon, WaveformIcon, RepeatIcon } from '@phosphor-icons/react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@apelles/ui';

import {
  DEFAULT_MIN_SILENCE_MS,
  clipSourceRangeSecs,
  spanToFrames,
  type DetectedSpan,
  type RetakeGroupWire,
} from './recut';
import { timelineFps } from './timeline';
import { useEditorTimelineStore } from './timelineStore';
import { useMediaUnderstandingStore } from './mediaUnderstandingStore';

/** One row the user can tick. A silence is its own candidate; a retake group
 *  contributes one candidate per take, with the suggested keep marked so the
 *  list can say so and leave it alone. */
interface Candidate {
  id: string;
  kind: 'silence' | 'retake';
  span: DetectedSpan;
  /** Present for retakes: the words, so a human can see what they are cutting. */
  text?: string;
  /** Retakes only: this take is the group's suggested keeper. */
  suggestedKeep?: boolean;
  /** Retakes only: which group it belongs to, for the "Take 2 of 3" label. */
  groupIndex?: number;
  takeIndex?: number;
  takeCount?: number;
}

/** `mm:ss.s` — short enough for a narrow column, precise enough to find. */
function stamp(secs: number): string {
  const s = Math.max(0, secs);
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}

export function RecutPanel() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const selection = useEditorTimelineStore((s) => s.selection);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);

  const [busy, setBusy] = useState<null | 'silence' | 'retake'>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [minSilenceMs, setMinSilenceMs] = useState(DEFAULT_MIN_SILENCE_MS);

  // Phase-1 multi-select fallback, the same one every single-clip consumer in
  // this package uses (docs/notes/multi-select.md).
  const primary = selection.length === 1 ? selection[0] : null;
  const track = primary?.track ?? -1;
  const clip = primary && timeline ? timeline.tracks[track]?.clips.find((c) => c.id === primary.id) : undefined;
  const analysable = Boolean(clip?.source_path);

  const reset = () => {
    setCandidates([]);
    setTicked({});
    setError(null);
    setNotice(null);
  };

  const findSilences = async () => {
    reset();
    if (!timeline || !clip?.source_path) return;
    const fps = timelineFps(timeline);
    const range = clipSourceRangeSecs(clip, fps);

    setBusy('silence');
    let found: { silences?: Array<{ start_secs: number; end_secs: number }> } | null = null;
    let failure: string | null = null;
    try {
      found = await invoke('chroma_detect_silences', {
        path: clip.source_path,
        startSecs: range.startSecs,
        durationSecs: range.durationSecs,
        minSilenceMs,
      });
    } catch (e) {
      failure = String(e);
    }
    setBusy(null);
    if (failure !== null) {
      setError(failure);
      return;
    }

    const rows: Candidate[] = (found?.silences ?? [])
      .map((s, i) => ({
        id: `sil-${i}`,
        kind: 'silence' as const,
        span: spanToFrames(clip, s.start_secs, s.end_secs, fps),
      }))
      .filter((r) => r.span.endFrame > r.span.startFrame);
    setCandidates(rows);
    if (rows.length === 0) setNotice(`No silence of ${minSilenceMs}ms or longer in this clip.`);
  };

  const findRetakes = async () => {
    reset();
    if (!timeline || !clip?.source_path) return;
    const source = clip.source_path;
    const fps = timelineFps(timeline);
    const range = clipSourceRangeSecs(clip, fps);

    const status = useMediaUnderstandingStore.getState().transcriptStatus(source);
    if (status.phase === 'error') {
      setError(status.error ?? 'transcription failed');
      return;
    }
    if (status.phase !== 'done') {
      useMediaUnderstandingStore.getState().startTranscript(source, { wordTimestamps: true });
      setNotice('Transcribing this clip first — retakes need the words. Try again when it finishes.');
      return;
    }

    const utterances = (status.result?.segments ?? [])
      .filter((s) => s.end > range.startSecs && s.start < range.startSecs + range.durationSecs)
      .map((s) => ({ start: s.start, end: s.end, text: s.text }));

    setBusy('retake');
    let found: { groups?: RetakeGroupWire[] } | null = null;
    let failure: string | null = null;
    try {
      found = await invoke('chroma_detect_retakes', { utterances });
    } catch (e) {
      failure = String(e);
    }
    setBusy(null);
    if (failure !== null) {
      setError(failure);
      return;
    }

    const rows: Candidate[] = [];
    (found?.groups ?? []).forEach((g, gi) => {
      g.members.forEach((m, mi) => {
        const span = spanToFrames(clip, m.start_secs, m.end_secs, fps);
        if (span.endFrame <= span.startFrame) return;
        rows.push({
          id: `ret-${gi}-${mi}`,
          kind: 'retake',
          span,
          text: m.text,
          suggestedKeep: mi === g.keep,
          groupIndex: gi,
          takeIndex: mi,
          takeCount: g.members.length,
        });
      });
    });
    setCandidates(rows);
    if (rows.length === 0) setNotice('No retakes found in this clip.');
  };

  /** Tick every take a group suggests dropping, leaving its keeper alone. */
  const tickSuggested = () => {
    const next: Record<string, boolean> = {};
    for (const c of candidates) {
      if (c.kind === 'silence' || !c.suggestedKeep) next[c.id] = true;
    }
    setTicked(next);
  };

  const chosen = candidates.filter((c) => ticked[c.id]);

  const cut = () => {
    if (!timeline || chosen.length === 0 || track < 0) return;
    const ranges = chosen.map((c) => ({ startFrame: c.span.startFrame, endFrame: c.span.endFrame }));
    const before = timeline;
    applyOp({
      kind: 'ripple_delete_ranges',
      track,
      ranges: ranges.map((r) => ({ start: r.startFrame, end: r.endFrame })),
    });
    const after = useEditorTimelineStore.getState().timeline;
    if (after === before) {
      setError('Nothing was cut — the track may be locked.');
      return;
    }
    // The candidates described the timeline as it was a moment ago; after a
    // ripple every later frame number is stale, so they go rather than linger
    // as numbers that now point at the wrong material.
    reset();
    setNotice(`Cut ${ranges.length} range${ranges.length === 1 ? '' : 's'} — one undo reverses all of it.`);
  };

  return (
    <div
      data-chroma-panel="edit-recut"
      className="flex h-full w-full min-h-0 flex-col bg-surface text-text-primary"
    >
      {/* No header of its own — `EditLibraryPanel` supplies the one every
          library mode shares, so switching to Recut reads as the same column
          changing what it holds. */}
      <div className="shrink-0 border-b border-border-color p-2">
        {!primary && (
          <p className="text-[11px] leading-snug text-text-secondary">
            Select one clip on the timeline to look for silences or retakes in it.
          </p>
        )}
        {primary && !analysable && (
          <p className="text-[11px] leading-snug text-text-secondary">
            That clip is generated (a title or adjustment) — there is no audio to analyse.
          </p>
        )}
        {primary && analysable && (
          <div className="flex flex-col gap-2">
            <label className="flex items-center justify-between gap-2 text-[11px] text-text-secondary">
              <span>Min silence (ms)</span>
              <input
                type="number"
                min={100}
                step={50}
                value={minSilenceMs}
                data-chroma-recut-min-silence
                onChange={(e) => setMinSilenceMs(Math.max(1, Math.round(Number(e.target.value) || 0)))}
                className="w-20 rounded border border-border-color bg-bg-primary px-1.5 py-1 text-right text-text-primary"
              />
            </label>
            <div className="flex gap-1.5">
              <Button
                variant="ghost"
                size="xs"
                disabled={busy !== null}
                data-chroma-recut-find-silences
                onClick={findSilences}
                title="Find the stretches of this clip where nobody is speaking"
              >
                {busy === 'silence' ? (
                  <SpinnerIcon className="size-3.5 animate-spin" />
                ) : (
                  <WaveformIcon className="size-3.5" />
                )}
                <span className="ml-1">{busy === 'silence' ? 'Listening…' : 'Silences'}</span>
              </Button>
              <Button
                variant="ghost"
                size="xs"
                disabled={busy !== null}
                data-chroma-recut-find-retakes
                onClick={findRetakes}
                title="Group the places where this line was delivered more than once"
              >
                {busy === 'retake' ? (
                  <SpinnerIcon className="size-3.5 animate-spin" />
                ) : (
                  <RepeatIcon className="size-3.5" />
                )}
                <span className="ml-1">{busy === 'retake' ? 'Reading…' : 'Retakes'}</span>
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2" data-chroma-recut-list>
        {candidates.length === 0 && !notice && !error && primary && analysable && (
          <p className="text-[11px] leading-snug text-text-secondary">
            Nothing detected yet — run one of the two above.
          </p>
        )}
        {candidates.map((c) => (
          <label
            key={c.id}
            data-chroma-recut-candidate={c.id}
            className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1.5 text-[11px] leading-snug hover:bg-bg-primary"
          >
            <input
              type="checkbox"
              checked={Boolean(ticked[c.id])}
              onChange={(e) => setTicked((t) => ({ ...t, [c.id]: e.target.checked }))}
              className="mt-0.5 accent-accent"
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="font-medium">
                  {c.kind === 'silence'
                    ? 'Silence'
                    : `Take ${(c.takeIndex ?? 0) + 1} of ${c.takeCount ?? 1}`}
                  {c.suggestedKeep && (
                    <span className="ml-1 font-normal text-accent">· suggested keep</span>
                  )}
                </span>
                <span className="shrink-0 tabular-nums text-text-secondary">
                  {stamp(c.span.startSecs)}–{stamp(c.span.endSecs)}
                </span>
              </span>
              {c.text && <span className="mt-0.5 block truncate text-text-secondary">{c.text}</span>}
            </span>
          </label>
        ))}
      </div>

      {candidates.length > 0 && (
        <div className="shrink-0 border-t border-border-color p-2">
          <div className="mb-1.5 flex items-center justify-between">
            <button
              type="button"
              data-chroma-recut-tick-suggested
              onClick={tickSuggested}
              className="text-[11px] text-text-secondary underline-offset-2 hover:underline"
            >
              Tick all suggested
            </button>
            <button
              type="button"
              data-chroma-recut-clear
              onClick={() => setTicked({})}
              className="text-[11px] text-text-secondary underline-offset-2 hover:underline"
            >
              Clear
            </button>
          </div>
          <Button
            variant="default"
            size="xs"
            className="w-full"
            disabled={chosen.length === 0}
            data-chroma-recut-cut
            onClick={cut}
            title="Ripple delete every ticked range, as one edit"
          >
            <ScissorsIcon className="size-3.5" />
            <span className="ml-1">
              {chosen.length === 0
                ? 'Nothing ticked'
                : `Cut ${chosen.length} range${chosen.length === 1 ? '' : 's'}`}
            </span>
          </Button>
        </div>
      )}

      {notice && !error && (
        <div
          data-chroma-recut-notice
          className="shrink-0 border-t border-border-color px-2.5 py-2 text-[11px] leading-snug text-text-secondary"
        >
          {notice}
        </div>
      )}
      {error && (
        <button
          type="button"
          data-chroma-recut-error
          onClick={() => setError(null)}
          title="Dismiss"
          className="shrink-0 border-t border-border-color bg-red-500/10 px-2.5 py-2 text-left text-[11px] leading-snug text-red-400"
        >
          {error}
        </button>
      )}
    </div>
  );
}
