/**
 * @apelles/editor — the Edit tab's **Captions from Transcript** action (D-238,
 * roadmap item 27's "Auto-captioning from the D-189 transcript" line).
 *
 * **What it does.** Runs the D-189 transcript sidecar over the SELECTED
 * clip's source media, groups the resulting timed words into cues
 * (`groupTranscriptIntoCues`), and drops them onto a new subtitle track —
 * the same `import_subtitles` op `SubtitleImportButton` drives, so a
 * generated caption is a `Clip` on a `TrackKind::Subtitle` track exactly like
 * an imported `.srt` cue (D-229). One undo entry either way.
 *
 * **Why a selected clip, not a file picker.** `SubtitleImportButton` picks a
 * `.srt` FILE because a subtitle file is not media that could already be on
 * the timeline. A transcript source, by contrast, almost always already IS a
 * clip the user placed — "caption the talking-head take I just cut in" is
 * the actual use case D-189's own decision entry names ("find a moment by
 * its SPOKEN content"). Requiring a clip selection also means the button
 * never has to ask which of several already-imported files to transcribe.
 *
 * **The GUI half of `editor_generate_captions_from_transcript`** (CLAUDE.md:
 * every feature is built for a human AND an AI). Both go through the exact
 * same `groupTranscriptIntoCues`/`generatedCuesToCaptions` functions and the
 * same `import_subtitles` store op — one grouping algorithm, one rounding
 * rule, one undo entry, whichever interface asked.
 *
 * **While the AI environment is still building** (D-315) the button says so,
 * with the real package count, so the wait is visible before anyone clicks
 * into it. It stays enabled: an `ai-media/` sidecar someone started by hand
 * answers regardless of what the bootstrap reports, and a click that really
 * does fail comes back with the `ai_env_not_ready` explanation rather than a
 * bare connection error.
 *
 * **D-411 Phase 0 — two sources, one menu.** The button opens a menu:
 * **From the timeline** (the default and first item) transcribes every source
 * the timeline's dialogue clips use and groups the TIMELINE transcript, so the
 * cues follow every cut, trim and tightened pause (`captionsForTimeline`, the
 * function `editor_generate_captions_from_transcript(scope="timeline")` calls);
 * **From the selected clip's file** is the original D-238 behaviour above (one
 * file, dropped at the playhead). The first is what an edited piece — above
 * all a short assembled from several moments — needs; the second stays for
 * captioning one untouched take.
 */
import { useState } from 'react';
import { CaretDownIcon, SparkleIcon } from '@phosphor-icons/react';
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@apelles/ui';
import { aiEnvNotice, aiEnvWarning, useAiEnv } from '@apelles/bridge';

import { useEditorTimelineStore } from './timelineStore';
import { useMediaUnderstandingStore } from './mediaUnderstandingStore';
import {
  captionsForTimeline,
  generatedCuesToCaptions,
  groupTranscriptIntoCues,
  sanitiseIdStem,
} from './captionsFromTranscript';
import { transcriptSources } from './timelineTranscript';
import { timelineFps } from './timeline';
import type { Transcript } from './mediaUnderstandingStore';

export function CaptionsFromTranscriptButton() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const selection = useEditorTimelineStore((s) => s.selection);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  // D-330 — deliberately NOT `useEditorTimelineStore((s) => s.playhead)`. The
  // only thing this component does with the playhead is read it once, inside
  // the click handler below, to decide where to drop the generated cues. A
  // reactive selector re-rendered this button (and re-ran its `useAiEnv`
  // subtree) on every displayed frame of playback to produce identical markup.
  // D-325's read-at-the-point-of-use pattern, third application after
  // `TimelinePane` and `EditLibraryPanel`.
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // D-315 — transcription runs in the `ai-media/` sidecar, which imports from
  // the shared Python environment the app builds in the background on first
  // launch. Until that finishes the button says so, with the real package
  // count, so the state is visible before anyone clicks. Advisory, not a gate
  // — see `aiEnvIsBuilding`'s own doc for why refusing here would be wrong.
  const { status: aiEnv } = useAiEnv();
  const aiEnvBuilding = aiEnvNotice(aiEnv, 'Captions from Transcript');
  const aiEnvUnavailable = aiEnvWarning(aiEnv);

  /** D-411 Phase 0 — captions from the TIMELINE transcript: every source the
   *  dialogue clips use is transcribed (one job per file, cached), then the
   *  stitched words are grouped where they PLAY. */
  const generateFromTimeline = async () => {
    setError(null);
    if (!timeline) return;
    const sources = transcriptSources(timeline);
    if (sources.length === 0) {
      setError('no dialogue-bearing video clips on this timeline to caption');
      return;
    }
    setBusy(true);
    let failed: string | null = null;
    try {
      const store = useMediaUnderstandingStore.getState();
      await Promise.all(sources.map((s) => store.getTranscript(s.path, { wordTimestamps: true })));
    } catch (e) {
      failed = String(e);
    }
    setBusy(false);
    if (failed) {
      setError(failed);
      return;
    }
    // Read at the point of use (D-330): the timeline may have been edited
    // while the transcripts ran, and the captions must follow the edit as it
    // is NOW.
    const tl = useEditorTimelineStore.getState().timeline;
    if (!tl) return;
    const fresh = useMediaUnderstandingStore.getState();
    const recoveries = Object.fromEntries(sources.map((s) => [s.path, fresh.recoveriesFor(s.path)]));
    const captions = captionsForTimeline(tl, fresh.transcripts, recoveries);
    if (captions.length === 0) {
      setError('the timeline transcript has no word-level timestamps to caption from');
      return;
    }
    applyOp({ kind: 'import_subtitles', cues: captions });
  };

  const generate = async () => {
    setError(null);
    if (!timeline) return;
    if (selection.length !== 1) {
      setError('select exactly one clip to caption its audio');
      return;
    }
    const sel = selection[0];
    const clip = timeline.tracks[sel.track]?.clips.find((c) => c.id === sel.id);
    const sourcePath = clip?.source_path;
    if (!sourcePath) {
      setError('the selected clip has no source media to transcribe');
      return;
    }

    // Dropped at the playhead, not 0:00 — the same convention
    // `SubtitleImportButton` uses. Computed before the `try` for the same
    // React Compiler reason that file's own comment gives (D-201), and read
    // non-reactively (D-330) — the value is only needed at the moment the
    // click happens, which is exactly what `getState()` gives.
    const playhead = useEditorTimelineStore.getState().playhead;
    const offsetFrames = playhead > 0 ? playhead : 0;
    const fps = timelineFps(timeline);
    const stem = sourcePath.split(/[/\\]/).pop()?.replace(/\.[^./\\]+$/, '') ?? 'transcript';

    // A hoisted result, not `try { … } finally { … }` — the React Compiler
    // bails out of a whole function containing a `finally` clause, the exact
    // reason `SubtitleImportButton`'s own comment gives for its `try`/`catch`
    // shape (`reactCompiler.test.ts` keeps this package at zero bailouts,
    // D-201).
    setBusy(true);
    let transcript: Transcript | null = null;
    try {
      transcript = await useMediaUnderstandingStore
        .getState()
        .getTranscript(sourcePath, { wordTimestamps: true });
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
    if (!transcript) return;

    const cues = groupTranscriptIntoCues(transcript.segments);
    if (cues.length === 0) {
      setError('that transcript has no word-level timestamps to caption from');
      return;
    }
    const captions = generatedCuesToCaptions(cues, fps, offsetFrames, `cap-${sanitiseIdStem(stem)}-`);
    applyOp({ kind: 'import_subtitles', cues: captions });
  };

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              disabled={busy || !timeline}
              title={aiEnvBuilding ?? aiEnvUnavailable ?? 'Generate captions from the transcript (D-189)'}
            >
              <SparkleIcon className="size-3.5" />
              <span className="ml-1">{busy ? 'Transcribing…' : 'Captions from Transcript'}</span>
              <CaretDownIcon className="size-3" />
            </Button>
          }
        />
        <DropdownMenuContent align="start" data-chroma-captions-menu="">
          <DropdownMenuItem data-chroma-captions-action="timeline" onClick={() => void generateFromTimeline()}>
            From the timeline (follows every cut)
          </DropdownMenuItem>
          <DropdownMenuItem data-chroma-captions-action="file" onClick={() => void generate()}>
            From the selected clip&apos;s file (at the playhead)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {aiEnvBuilding && !error && (
        <span className="truncate text-[11px] text-text-secondary" title={aiEnvBuilding}>
          {aiEnvBuilding}
        </span>
      )}
      {error && (
        <span className="truncate text-[11px] text-red-400" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
