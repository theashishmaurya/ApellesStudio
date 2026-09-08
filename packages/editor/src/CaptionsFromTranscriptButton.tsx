/**
 * @chroma/editor — the Edit tab's **Captions from Transcript** action (D-237,
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
 */
import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@chroma/ui';

import { useEditorTimelineStore } from './timelineStore';
import { useMediaUnderstandingStore } from './mediaUnderstandingStore';
import { generatedCuesToCaptions, groupTranscriptIntoCues, sanitiseIdStem } from './captionsFromTranscript';
import { timelineFps } from './timeline';
import type { Transcript } from './mediaUnderstandingStore';

export function CaptionsFromTranscriptButton() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const selection = useEditorTimelineStore((s) => s.selection);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  const playhead = useEditorTimelineStore((s) => s.playhead);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    // React Compiler reason that file's own comment gives (D-201).
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
      <Button
        variant="ghost"
        size="xs"
        disabled={busy || !timeline}
        onClick={generate}
        title="Generate captions from the selected clip's transcript (D-189)"
      >
        <Sparkles className="size-3.5" />
        <span className="ml-1">{busy ? 'Transcribing…' : 'Captions from Transcript'}</span>
      </Button>
      {error && (
        <span className="truncate text-[11px] text-red-400" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
