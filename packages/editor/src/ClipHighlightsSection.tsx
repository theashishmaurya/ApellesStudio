/**
 * @apelles/editor — the Inspector's "Highlights" section (D-396/D-397).
 *
 * What it is: the human half of `editor_set_clip_highlights` /
 * `editor_suggest_clip_highlights`. A list of the selected clip's highlighter
 * sweeps, each editable (start frame, length in frames, colour, opacity,
 * remove), an "Add at playhead" button, "Suggest from transcript" (the same
 * `suggestClipHighlights` the MCP tool calls), and a toggle that shows the
 * boxes in the viewer so they can be dragged (`HighlightOverlay`).
 *
 * What it does NOT do: own any state worth persisting. Every edit is ONE
 * `set_clip_highlights` op carrying the whole list, so it is one undo step and
 * the same store action an agent's call lands on. The only local state is the
 * suggestion's status line.
 *
 * **Pattern.** Resolve and Premiere give a clip effect an Inspector section
 * with a row per item plus on-canvas handles for the geometry (Crop, Transform,
 * Dynamic Zoom; this tab's own `DynamicZoomOverlay`), and Apple Motion's
 * Inspector adds/removes a keyframe at the playhead from a button. This
 * follows that: rows for the numbers, an arm toggle for the viewer boxes, an
 * add-at-playhead button. Research notes in D-396.
 */
import { useState } from 'react';
import { PlusIcon, XIcon, SparkleIcon } from '@phosphor-icons/react';
import { Button, ScrubbableNumberInput } from '@apelles/ui';
import { InspectorSection } from '@apelles/inspector';
import {
  DEFAULT_HIGHLIGHT_COLOR,
  DEFAULT_HIGHLIGHT_OPACITY,
  DEFAULT_HIGHLIGHT_SWEEP_SECONDS,
  type ClipHighlight,
} from './clipHighlights';
import { useHighlightEditStore } from './highlightEditStore';
import { suggestClipHighlights } from './highlightSuggestOp';
import { liveSuggestDeps } from './highlightSuggestLive';
import { clipSourceFrame } from './clipKeyframes';
import { findClip, timelineFps } from './timeline';
import { useEditorTimelineStore } from './timelineStore';

/** The box a new highlight starts with: a band across the middle of the image,
 *  something to grab and drag onto the words. */
const NEW_HIGHLIGHT_BOX: ClipHighlight['box'] = [0.1, 0.45, 0.9, 0.55];

const row = 'flex items-center gap-1.5';
const numInput = 'h-7 w-14 text-xs';

export function ClipHighlightsSection() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const selection = useEditorTimelineStore((s) => s.selection);
  const playhead = useEditorTimelineStore((s) => s.playhead);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  const armedClipId = useHighlightEditStore((s) => s.armedClipId);
  const selected = useHighlightEditStore((s) => s.selected);
  const arm = useHighlightEditStore((s) => s.arm);
  const select = useHighlightEditStore((s) => s.select);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const primary = selection.length === 1 ? selection[0] : null;
  const found = primary ? findClip(timeline, primary.track, primary.id) : null;
  const clip = found?.clip ?? null;
  const trackLocked = primary ? !!timeline?.tracks[primary.track]?.locked : false;
  if (!primary || !clip || !found) return null;

  const highlights = clip.highlights ?? [];
  const fps = timelineFps(timeline);
  const armed = armedClipId === clip.id;

  const write = (next: ClipHighlight[]) =>
    applyOp({ kind: 'set_clip_highlights', track: primary.track, clip: found.index, highlights: next });
  const patch = (i: number, change: Partial<ClipHighlight>) =>
    write(highlights.map((h, k) => (k === i ? { ...h, ...change } : h)));

  const addAtPlayhead = () => {
    const rate = clip.source_fps && clip.source_fps > 0 ? clip.source_fps : fps;
    const at = Math.round(clipSourceFrame(clip, playhead, fps));
    write([
      ...highlights,
      { box: NEW_HIGHLIGHT_BOX, at, dur: Math.round(DEFAULT_HIGHLIGHT_SWEEP_SECONDS * rate) },
    ]);
    arm(clip.id);
    select(highlights.length);
  };

  const suggest = () => {
    setBusy(true);
    setStatus('Reading the picture and the narration…');
    void suggestClipHighlights(liveSuggestDeps(), primary.track, found.index)
      .then((out) => {
        if ('error' in out) setStatus(out.error);
        else if (out.status === 'transcribing') {
          setStatus('The narration is still being transcribed. Try again in a moment.');
        } else if (out.status === 'needs_transcript') {
          setStatus('Nothing playing over this clip has a transcript yet. Transcribe the narration first.');
        } else if (out.highlights.length === 0) setStatus('No text found in the picture.');
        else {
          write(out.highlights);
          arm(clip.id);
          setStatus(
            out.basis === 'transcript'
              ? `Matched ${out.phrases.length} spoken phrase${out.phrases.length === 1 ? '' : 's'} (undo to revert).`
              : 'Nothing spoken matched the picture; swept its largest line at the clip start (undo to revert).',
          );
        }
      })
      .finally(() => setBusy(false));
  };

  return (
    <InspectorSection label="Highlights">
      <div className="flex flex-wrap items-center gap-1.5 pb-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          disabled={trackLocked}
          onClick={addAtPlayhead}
          data-highlight-add
        >
          <PlusIcon className="size-3.5" /> Add at playhead
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          disabled={trackLocked || busy}
          onClick={suggest}
          title="Read the picture's text and the narration over it, and sweep each spoken phrase"
          data-highlight-suggest
        >
          <SparkleIcon className="size-3.5" /> Suggest from transcript
        </Button>
        <Button
          type="button"
          size="sm"
          variant={armed ? 'default' : 'outline'}
          className="h-7 px-2 text-xs"
          disabled={highlights.length === 0}
          aria-pressed={armed}
          onClick={() => arm(armed ? null : clip.id)}
          data-highlight-arm
        >
          {armed ? 'Boxes on' : 'Edit boxes'}
        </Button>
      </div>

      {highlights.map((h, i) => (
        <div
          key={i}
          className={`${row} rounded px-1 py-0.5 ${selected === i && armed ? 'bg-accent/15' : ''}`}
          onClick={() => select(i)}
          data-highlight-row={i}
        >
          <span className="text-text-secondary w-4 text-center text-[11px]">{i + 1}</span>
          <label className="flex items-center gap-1 text-[10px] text-text-secondary">
            Start
            <ScrubbableNumberInput
              step={1}
              min={0}
              disabled={trackLocked}
              className={numInput}
              value={h.at}
              onValueChange={(v) => v != null && patch(i, { at: Math.max(0, Math.round(v)) })}
            />
          </label>
          <label className="flex items-center gap-1 text-[10px] text-text-secondary">
            Len
            <ScrubbableNumberInput
              step={1}
              min={0}
              disabled={trackLocked}
              className={numInput}
              value={h.dur}
              onValueChange={(v) => v != null && patch(i, { dur: Math.max(0, Math.round(v)) })}
            />
          </label>
          <input
            type="color"
            aria-label={`Highlight ${i + 1} colour`}
            disabled={trackLocked}
            className="h-6 w-6 shrink-0 cursor-pointer rounded border border-border-color bg-transparent p-0"
            value={(h.color ?? DEFAULT_HIGHLIGHT_COLOR).toLowerCase()}
            onChange={(e) => patch(i, { color: e.target.value })}
          />
          <ScrubbableNumberInput
            step={0.05}
            min={0}
            max={1}
            disabled={trackLocked}
            className={numInput}
            value={h.opacity ?? DEFAULT_HIGHLIGHT_OPACITY}
            onValueChange={(v) => v != null && patch(i, { opacity: Math.min(1, Math.max(0, v)) })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove highlight ${i + 1}`}
            disabled={trackLocked}
            onClick={(e) => {
              e.stopPropagation();
              select(null);
              write(highlights.filter((_, k) => k !== i));
            }}
          >
            <XIcon className="size-3.5" />
          </Button>
        </div>
      ))}

      <p className="text-text-secondary/60 pt-1 text-[10px] leading-snug">
        {status ??
          (highlights.length === 0
            ? 'A highlighter pen that sweeps over words in this clip’s picture while they are spoken. Add one, drag its box in the viewer, or let the transcript place them.'
            : 'Start and Len are in this clip’s source frames. Turn on Edit boxes to drag them in the viewer.')}
      </p>
    </InspectorSection>
  );
}
