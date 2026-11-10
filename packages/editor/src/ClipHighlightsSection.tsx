/**
 * @apelles/editor — the Inspector's "Highlights" section (D-396/D-397;
 * v0.3.0 panel redesign, B-366, D-443).
 *
 * What it is: the human half of `editor_set_clip_highlights` /
 * `editor_suggest_clip_highlights`. Revision 2 of the approved mockup (the
 * owner on revision 1: "very cluttered"): the three actions are icons in the
 * section header — Add at the playhead (+), Suggest from the narration (✦),
 * Show the boxes in the viewer (eye, pressed while on) — and each highlight is
 * ONE row: a colour dot (click cycles `HIGHLIGHT_COLOR_CYCLE`) · start ·
 * length · strength, with remove on hover. Start and length are in seconds of
 * the clip's source, strength in %; the stored values stay source frames and
 * a 0–1 opacity (`displayUnits.ts`). The header's summary is the count.
 *
 * What it does NOT do: own any state worth persisting. Every edit is ONE
 * `set_clip_highlights` op carrying the whole list, so it is one undo step
 * (a scrub folds into one too, `InspectorNumber`) and the same store action
 * an agent's call lands on. The only local state is the suggestion's status,
 * shown only after Suggest says something (no standing footnote).
 *
 * **Pattern.** Resolve and Premiere give a clip effect an Inspector section
 * with a row per item plus on-canvas handles for the geometry; Final Cut puts
 * a section's actions in its header on hover. Research notes in D-396.
 */
import { useState } from 'react';
import { EyeIcon, PlusIcon, SparkleIcon, XIcon } from '@phosphor-icons/react';
import { Button } from '@apelles/ui';

import { EditorSection } from './EditorSection';
import { InspectorNumber } from './InspectorNumber';
import {
  DEFAULT_HIGHLIGHT_COLOR,
  DEFAULT_HIGHLIGHT_OPACITY,
  DEFAULT_HIGHLIGHT_SWEEP_SECONDS,
  nextHighlightColor,
  type ClipHighlight,
} from './clipHighlights';
import { framesFromSeconds, secondsFromFrames } from './displayUnits';
import { useHighlightEditStore } from './highlightEditStore';
import { suggestClipHighlights } from './highlightSuggestOp';
import { liveSuggestDeps } from './highlightSuggestLive';
import { clipSourceFrame } from './clipKeyframes';
import { timelineFps } from './timeline';
import { canvasTarget } from './inspectorTarget';
import { useEditorTimelineStore } from './timelineStore';

/** The box a new highlight starts with: a band across the middle of the image,
 *  something to grab and drag onto the words. */
const NEW_HIGHLIGHT_BOX: ClipHighlight['box'] = [0.1, 0.45, 0.9, 0.55];

/** Seconds fields step by a hundredth (scrub 1 px = 0.01 s). */
const SECONDS_STEP = 0.01;

const HEADER_ICON = 'size-5';

export function ClipHighlightsSection() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const selection = useEditorTimelineStore((s) => s.selection);
  // D-437 S10 — no reactive `playhead`: only "Add at playhead" needs it, and it
  // reads the store at the click. A selector here re-rendered this section on
  // every displayed frame of playback.
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  const armedClipId = useHighlightEditStore((s) => s.armedClipId);
  const selected = useHighlightEditStore((s) => s.selected);
  const arm = useHighlightEditStore((s) => s.arm);
  const select = useHighlightEditStore((s) => s.select);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // B-379 — the Inspector is no longer remounted per clip selection, so this
  // section resets its own per-clip state when the shot changes: a
  // "suggesting…" status and its busy flag belong to the clip they were
  // started for and must not carry over to the next one. The hook itself is
  // unconditional; only the reset below is, which is what React's
  // adjust-state-on-prop-change pattern prescribes.
  const [statusShot, setStatusShot] = useState<string | null>(null);

  // B-334/D-430 — the picture half of a linked pair, whichever half is selected.
  const picture = canvasTarget(timeline, selection.length === 1 ? selection[0] : null);
  const primary = picture ? { track: picture.track, id: picture.clip.id } : null;
  const found = picture ? { clip: picture.clip, index: picture.index } : null;
  const clip = found?.clip ?? null;
  const trackLocked = primary ? !!timeline?.tracks[primary.track]?.locked : false;
  if (!primary || !clip || !found) return null;

  if (statusShot !== clip.id) {
    setStatusShot(clip.id);
    if (status !== null) setStatus(null);
    if (busy) setBusy(false);
  }

  const highlights = clip.highlights ?? [];
  const fps = timelineFps(timeline);
  // Highlight frames are the clip's SOURCE frames, so seconds are at its rate.
  const rate = clip.source_fps && clip.source_fps > 0 ? clip.source_fps : fps;
  const armed = armedClipId === clip.id;

  const write = (next: ClipHighlight[]) =>
    applyOp({ kind: 'set_clip_highlights', track: primary.track, clip: found.index, highlights: next });
  const patch = (i: number, change: Partial<ClipHighlight>) =>
    write(highlights.map((h, k) => (k === i ? { ...h, ...change } : h)));

  const addAtPlayhead = () => {
    const at = Math.round(clipSourceFrame(clip, useEditorTimelineStore.getState().playhead, fps));
    write([...highlights, { box: NEW_HIGHLIGHT_BOX, at, dur: Math.round(DEFAULT_HIGHLIGHT_SWEEP_SECONDS * rate) }]);
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
    <EditorSection
      id="highlights"
      label="Highlights"
      meta={highlights.length === 0 ? 'None' : String(highlights.length)}
      actions={
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            className={HEADER_ICON}
            disabled={trackLocked}
            onClick={addAtPlayhead}
            title="Add a highlight at the playhead"
            aria-label="Add a highlight at the playhead"
            data-highlight-add
          >
            <PlusIcon size={12} />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className={HEADER_ICON}
            disabled={trackLocked || busy}
            onClick={suggest}
            title="Suggest highlights from the narration: sweeps each spoken phrase that appears in the picture"
            aria-label="Suggest highlights from the narration"
            data-highlight-suggest
          >
            <SparkleIcon size={12} />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className={`${HEADER_ICON} ${armed ? 'text-accent-text' : ''}`}
            disabled={highlights.length === 0}
            aria-pressed={armed}
            onClick={() => arm(armed ? null : clip.id)}
            title={armed ? 'Hide the boxes in the viewer' : 'Show the boxes in the viewer (drag them to place)'}
            aria-label="Show the boxes in the viewer"
            data-highlight-arm
          >
            <EyeIcon size={12} weight={armed ? 'fill' : 'regular'} />
          </Button>
        </div>
      }
    >
      {highlights.map((h, i) => (
        <div
          key={i}
          className={`group flex min-h-[26px] items-center gap-1.5 rounded-sm px-0.5 ${selected === i && armed ? 'bg-card-active' : ''}`}
          onClick={() => select(i)}
          data-highlight-row={i}
        >
          <button
            type="button"
            className="size-3 shrink-0 rounded-full disabled:opacity-50"
            style={{ backgroundColor: h.color ?? DEFAULT_HIGHLIGHT_COLOR }}
            disabled={trackLocked}
            aria-label={`Highlight ${i + 1} colour (click for the next)`}
            title="Click for the next colour"
            onClick={(e) => {
              e.stopPropagation();
              patch(i, { color: nextHighlightColor(h.color) });
            }}
            data-highlight-color={i}
          />
          <InspectorNumber
            aria-label={`Highlight ${i + 1} start`}
            title="Start, in seconds of this clip's source"
            className="min-w-0 flex-1"
            value={secondsFromFrames(h.at, rate)}
            step={SECONDS_STEP}
            min={0}
            unit="s"
            precision={2}
            disabled={trackLocked}
            onChange={(s) => patch(i, { at: framesFromSeconds(s, rate) })}
          />
          <InspectorNumber
            aria-label={`Highlight ${i + 1} length`}
            title="How long the sweep takes, in seconds"
            className="w-[64px] shrink-0"
            value={secondsFromFrames(h.dur, rate)}
            step={SECONDS_STEP}
            min={0}
            unit="s"
            precision={2}
            disabled={trackLocked}
            onChange={(s) => patch(i, { dur: framesFromSeconds(s, rate) })}
          />
          <InspectorNumber
            aria-label={`Highlight ${i + 1} strength`}
            title="Strength (how opaque the highlighter is)"
            className="w-[56px] shrink-0"
            value={Math.round((h.opacity ?? DEFAULT_HIGHLIGHT_OPACITY) * 100)}
            step={1}
            min={0}
            max={100}
            unit="%"
            disabled={trackLocked}
            onChange={(pct) => patch(i, { opacity: Math.min(1, Math.max(0, pct / 100)) })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="size-5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
            aria-label={`Remove highlight ${i + 1}`}
            title="Remove this highlight"
            disabled={trackLocked}
            onClick={(e) => {
              e.stopPropagation();
              select(null);
              write(highlights.filter((_, k) => k !== i));
            }}
          >
            <XIcon size={11} />
          </Button>
        </div>
      ))}
      {status && (
        <p className="text-text-secondary pt-1 text-2xs leading-snug" data-highlight-status>
          {status}
        </p>
      )}
    </EditorSection>
  );
}
