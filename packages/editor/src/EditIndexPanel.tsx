/**
 * @apelles/editor — the Index library panel: every marker on the timeline, and
 * the selected clip's transcript, as two lists you navigate the edit from
 * (D-328).
 *
 * **What it is.** The sixth `EditLibraryMode` (`editLibrary.ts`) and the only
 * one that READS the edit back rather than offering something to add to it or
 * cutting it. Two sub-views:
 *
 * - **Markers** — one row per `Timeline.markers` entry: its colour, a poster
 *   frame from whatever clip sits under it, its name, its time (and its span,
 *   for a D-328 ranged marker), an inline comment box, and a delete. Clicking a
 *   row seeks the playhead to the marker.
 * - **Transcript** — one row per segment of the selected clip's speech, each
 *   with its timecode, a duration badge and the text. Clicking a row seeks to
 *   that segment; the row under the playhead is highlighted as playback runs.
 *
 * **The reference is Premiere's Text panel and Markers panel**, per CLAUDE.md's
 * "research the real pattern first" rule — scrape kept in
 * `scratch/premiere-index-reference/`. What was taken is the FUNCTIONALITY:
 * two sub-views in one docked panel, rows that seek, an inline-editable comment
 * on a marker row, in/out shown for ranged markers, and "as you move the
 * playhead, the corresponding text highlights". None of its visual design was:
 * this is shadcn/Base-UI from `@apelles/ui` on this repo's own `--color-*`
 * tokens with Phosphor icons, like every other panel here.
 *
 * **What it does NOT do.**
 * - It does not own any of the data. Markers come from the timeline store and
 *   every edit goes back through the ordinary `set_marker`/`remove_marker`
 *   `EditOp`s, so a change made here is persisted and undoable exactly like one
 *   made in the ruler popover — the same write path, not a second one.
 * - It does not transcribe. It only READS
 *   `mediaUnderstandingStore.transcriptStatus(path)` and offers a button that
 *   calls the same `startTranscript` the Recut panel and the
 *   captions-from-transcript button already use.
 * - **It does not subscribe reactively to the playhead.** See
 *   `useActiveTranscriptRow` below — this is the D-325/B-146 constraint, and
 *   the reason the transcript highlight is built the way it is.
 *
 * **No new MCP tool** (checked, not assumed — CLAUDE.md's human+AI parity rule).
 * Everything this panel shows or does already has an agent-side equivalent:
 * `editor_list_markers` returns exactly the rows the Markers view draws
 * (including D-328's `durationFrames`/`endFrame`), `editor_set_marker` writes
 * the inline comment, `editor_remove_marker` deletes, `editor_set_playhead` is
 * the seek, and `editor_get_transcript`/`_status` return the very segments the
 * Transcript view lists — it reads them out of the same store those ops write
 * into. The one genuinely new thing here is WHICH sub-view is showing, which is
 * panel chrome rather than a capability, and is already visible to the
 * debug-only surface through `debug_ui_state`'s `libraryMode` plus this
 * component's `data-chroma-index-view` attribute. See D-328.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowsClockwiseIcon, FlagIcon, TextAlignLeftIcon, TrashIcon } from '@phosphor-icons/react';
import { Button, Input, Tabs, TabsContent, TabsList, TabsTrigger } from '@apelles/ui';
import { fmtTimecode } from '@apelles/player';

import { useEditorTimelineStore } from './timelineStore';
import { useMediaUnderstandingStore, type TranscriptSegment } from './mediaUnderstandingStore';
import { clipAt, markerEndFrame, markersOf, timelineFps, type Clip, type Marker } from './timeline';
import { clipSourceRangeSecs, spanToFrames } from './recut';
import { thumbAtSourceSecs } from './clipThumbs';

/** The two sub-views, in the order the tabs render them. Markers first: it is
 *  the one that always has something to show, since it needs no selection and
 *  no transcription. */
const INDEX_VIEWS = ['markers', 'transcript'] as const;
type IndexView = (typeof INDEX_VIEWS)[number];

export function EditIndexPanel() {
  const [view, setView] = useState<IndexView>('markers');

  return (
    <div
      data-chroma-panel="edit-index"
      data-chroma-index-view={view}
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* `Tabs` NESTED inside a library mode, which is the shape `CaptionLibrary`
          already uses. The top-level mode switch deliberately is not a `Tabs`
          (B-124 — a deselected Base UI `Tabs.Panel` painting in a non-frontmost
          window), but the kit's own component carries the `[&[inert]]:hidden`
          fix for that, so a nested one is fine and gets real tab a11y. */}
      <Tabs
        value={view}
        onValueChange={(v) => setView(v as IndexView)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="mx-2 mt-2 shrink-0">
          <TabsTrigger value="markers" className="gap-1.5 text-[11px]">
            <FlagIcon className="size-3.5" />
            Markers
          </TabsTrigger>
          <TabsTrigger value="transcript" className="gap-1.5 text-[11px]">
            <TextAlignLeftIcon className="size-3.5" />
            Transcript
          </TabsTrigger>
        </TabsList>

        <TabsContent value="markers" className="min-h-0 flex-1 overflow-y-auto p-2">
          <MarkersView />
        </TabsContent>
        <TabsContent value="transcript" className="min-h-0 flex-1 overflow-y-auto p-2">
          <TranscriptView />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** The shared empty/advisory line — one shape for "there is nothing here yet",
 *  so the two views cannot drift into two different ways of saying it. */
function EmptyNote({ children }: { children: React.ReactNode }) {
  return <p className="px-1 py-6 text-center text-[11px] leading-relaxed text-text-secondary">{children}</p>;
}

// ---- Markers ---------------------------------------------------------------

function MarkersView() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  const setPlayhead = useEditorTimelineStore((s) => s.setPlayhead);

  const fps = timelineFps(timeline);
  const markers = useMemo(() => markersOf(timeline), [timeline]);

  if (!timeline) return <EmptyNote>Open a project to see its markers.</EmptyNote>;
  if (markers.length === 0) {
    return (
      <EmptyNote>
        No markers yet. Press <kbd className="rounded bg-bg-primary px-1">M</kbd> — or use the timeline’s
        flag button — to mark the playhead.
      </EmptyNote>
    );
  }

  return (
    <ul className="flex flex-col gap-1" data-chroma-marker-index>
      {markers.map((m) => (
        <MarkerRow
          key={m.id}
          marker={m}
          fps={fps}
          onSeek={() => setPlayhead(m.frame)}
          onComment={(note) => applyOp({ kind: 'set_marker', id: m.id, patch: { note } })}
          onRemove={() => applyOp({ kind: 'remove_marker', id: m.id })}
        />
      ))}
    </ul>
  );
}

interface MarkerRowProps {
  marker: Marker;
  fps: number;
  onSeek: () => void;
  onComment: (note: string | null) => void;
  onRemove: () => void;
}

function MarkerRow({ marker, fps, onSeek, onComment, onRemove }: MarkerRowProps) {
  const thumb = useMarkerThumb(marker, fps);

  // The comment is a DRAFT while it is being typed and commits on blur —
  // `applyOp` snapshots the whole timeline per call, so committing per
  // keystroke would be one undo entry per character. Same split the ruler
  // popover's own fields make.
  const [draft, setDraft] = useState(marker.note ?? '');
  useEffect(() => {
    setDraft(marker.note ?? '');
  }, [marker.id, marker.note]);

  const ranged = !!marker.duration_frames;

  return (
    // Two ROWS, not one line of five columns. The first draft put the comment
    // box beside the name and delete, and in the real 288px column (verified in
    // Chromium on D-142's harness, which is the only tier that has a layout
    // engine at all) that squeezed every marker name down to a single letter
    // and wrapped the time range onto three overlapping lines. The thumbnail
    // spans both rows on the left; everything textual stacks to its right and
    // gets the column's full remaining width.
    <li
      data-chroma-marker-index-item={marker.id}
      className="group flex items-start gap-2 rounded-md p-1.5 hover:bg-bg-primary"
    >
      {/* The row's seek target is a real button wrapping the thumbnail and the
          text, not a click handler on the <li>: the row also contains an input
          and a delete button, and nesting those inside one big button would be
          invalid HTML and would swallow their clicks. */}
      <button
        type="button"
        data-chroma-marker-index-seek
        onClick={onSeek}
        title={`Jump to ${fmtTimecode(marker.frame, fps)}`}
        className="shrink-0 overflow-hidden rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <span className="block h-9 w-16 overflow-hidden rounded-sm bg-bg-primary">
          {thumb ? (
            <img src={thumb} alt="" className="h-full w-full object-cover" draggable={false} />
          ) : null}
        </span>
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-start gap-1.5">
          <span
            aria-hidden
            className="mt-1 size-2.5 shrink-0 rounded-full"
            style={{ background: marker.color }}
          />
          <button
            type="button"
            data-chroma-marker-index-seek-text
            onClick={onSeek}
            title={`Jump to ${fmtTimecode(marker.frame, fps)}`}
            className="flex min-w-0 flex-1 flex-col gap-0.5 rounded text-left outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            <span className="truncate text-[11px] leading-tight text-text-primary">
              {marker.name || <span className="text-text-secondary">Unnamed marker</span>}
            </span>
            {/* `whitespace-nowrap`: a ranged marker's `in → out` is one
                indivisible fact, and letting it wrap mid-arrow was the second
                thing the real-Chromium pass caught. */}
            <span className="whitespace-nowrap tabular-nums text-[10px] leading-tight text-text-secondary">
              {/* Premiere's Markers panel shows in/out for a ranged marker and a
                  single time for a point one; that distinction is the useful part
                  of its row, so it is the part kept. */}
              {ranged
                ? `${fmtTimecode(marker.frame, fps)} → ${fmtTimecode(markerEndFrame(marker), fps)}`
                : fmtTimecode(marker.frame, fps)}
            </span>
          </button>
          <Button
            variant="ghost"
            size="xs"
            data-chroma-marker-index-remove
            aria-label={`Delete ${marker.name || 'marker'}`}
            title="Delete marker"
            className="h-5 shrink-0 px-1 text-red-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            onClick={onRemove}
          >
            <TrashIcon className="size-3" />
          </Button>
        </div>

        <Input
          data-chroma-marker-index-note
          aria-label={`Comment for ${marker.name || 'marker'}`}
          placeholder="Comment"
          className="h-6 w-full text-[10px]"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          // A whitespace-only comment CLEARS rather than storing `""` — the
          // same one-representation rule the model enforces everywhere else.
          onBlur={() => onComment(draft.trim() ? draft : null)}
        />
      </div>
    </li>
  );
}

/**
 * A poster frame for the clip sitting under a marker, or `null` when there
 * isn't one (the marker is past the last clip, over a gap, or the decode
 * produced nothing).
 *
 * A marker names a TIMELINE position and thumbnails are addressed in SOURCE
 * seconds, so this has to resolve the clip under the frame first — `clipAt`
 * does that (and the timeline-to-source conversion, speed ramps included)
 * rather than this re-deriving it.
 */
function useMarkerThumb(marker: Marker, fps: number): string | null {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const [url, setUrl] = useState<string | null>(null);

  // The clip lookup happens INSIDE the effect, on primitive dependencies,
  // rather than in a `useMemo` the effect then depends on. That shape — a
  // memoized object as an effect dependency — is one the React Compiler cannot
  // preserve ("Existing memoization could not be preserved"), which would switch
  // auto-memoization off for this whole file; `reactCompiler.test.ts` (D-201)
  // enforces that it stays on, and `Filmstrip.tsx` documents the same trap.
  // `timeline` only changes on a real edit, so this costs nothing per frame.
  useEffect(() => {
    let target: { path: string; secs: number } | null = null;
    if (timeline) {
      for (const tr of timeline.tracks) {
        if (tr.kind !== 'video') continue;
        const hit = clipAt(tr, marker.frame, fps);
        if (hit?.clip.source_path) {
          const rate = hit.clip.source_fps && hit.clip.source_fps > 0 ? hit.clip.source_fps : fps;
          target = { path: hit.clip.source_path, secs: hit.sourceFrame / rate };
          break;
        }
      }
    }
    if (!target) {
      setUrl(null);
      return;
    }
    let live = true;
    void thumbAtSourceSecs(target.path, target.secs).then((u) => {
      // Guard the async set: the row can unmount, or the marker can move, while
      // the decode is in flight.
      if (live) setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [timeline, marker.frame, fps]);

  return url;
}

// ---- Transcript ------------------------------------------------------------

function TranscriptView() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const selection = useEditorTimelineStore((s) => s.selection);
  const setPlayhead = useEditorTimelineStore((s) => s.setPlayhead);
  const transcripts = useMediaUnderstandingStore((s) => s.transcripts);
  const transcriptErrors = useMediaUnderstandingStore((s) => s.transcriptErrors);

  const fps = timelineFps(timeline);

  // The same Phase-1 single-selection fallback every clip-scoped panel uses
  // (`docs/notes/multi-select.md`), and the same selection → clip → source_path
  // resolution `RecutPanel` and `CaptionsFromTranscriptButton` do — a transcript
  // is keyed by SOURCE PATH, there is no per-clip form.
  const primary = selection.length === 1 ? selection[0] : null;
  const clip = primary && timeline ? timeline.tracks[primary.track]?.clips.find((c) => c.id === primary.id) : undefined;
  const path = clip?.source_path ?? null;

  const transcript = path ? transcripts[path] : undefined;
  const failure = path ? transcriptErrors[path] : undefined;

  // Only the segments this clip actually SHOWS: a clip is a trim of its source,
  // and listing speech the edit does not contain would seek the playhead to
  // material that is not on the timeline. Same filter `RecutPanel` applies.
  const segments = useMemo(() => {
    if (!transcript || !clip) return [];
    const { startSecs, durationSecs } = clipSourceRangeSecs(clip, fps);
    const end = startSecs + durationSecs;
    return (transcript.segments ?? []).filter((s) => s.end > startSecs && s.start < end);
  }, [transcript, clip, fps]);

  const seekTo = useCallback(
    (segment: TranscriptSegment) => {
      if (!clip) return;
      setPlayhead(timelineFrameForSourceSecs(clip, segment.start, fps));
    },
    [clip, fps, setPlayhead],
  );

  const activeIndex = useActiveTranscriptRow(segments, clip ?? null, fps);

  if (!primary) {
    return <EmptyNote>Select one clip on the timeline to see what is said in it.</EmptyNote>;
  }
  if (!path) return <EmptyNote>That clip has no media file to transcribe.</EmptyNote>;
  if (failure) {
    return <EmptyNote>Transcription failed: {failure}</EmptyNote>;
  }
  if (!transcript) {
    return (
      <div className="flex flex-col items-center gap-2 px-1 py-6">
        <p className="text-center text-[11px] leading-relaxed text-text-secondary">
          This clip has not been transcribed yet.
        </p>
        <Button
          size="xs"
          data-chroma-index-transcribe
          className="h-6 px-2 text-[11px]"
          onClick={() =>
            useMediaUnderstandingStore.getState().startTranscript(path, { wordTimestamps: true })
          }
        >
          <ArrowsClockwiseIcon className="size-3" />
          Transcribe this clip
        </Button>
      </div>
    );
  }
  if (segments.length === 0) {
    return <EmptyNote>No speech found in the part of this clip that is on the timeline.</EmptyNote>;
  }

  return (
    <ul className="flex flex-col gap-0.5" data-chroma-transcript-index>
      {segments.map((s, i) => (
        <li key={`${s.start}-${i}`}>
          <button
            type="button"
            data-chroma-transcript-row={i}
            data-chroma-transcript-active={i === activeIndex ? '' : undefined}
            onClick={() => seekTo(s)}
            className={`flex w-full flex-col gap-0.5 rounded-md p-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-accent ${
              i === activeIndex ? 'bg-accent/15 ring-1 ring-accent/40' : 'hover:bg-bg-primary'
            }`}
          >
            <span className="flex items-center gap-1.5">
              <span className="tabular-nums text-[10px] text-text-secondary">
                {fmtTimecode(timelineFrameForSourceSecs(clip!, s.start, fps), fps)}
              </span>
              <span className="rounded bg-bg-primary px-1 text-[9px] tabular-nums text-text-secondary">
                {formatSegmentDuration(s)}
              </span>
            </span>
            {/* Word-wrapped, not truncated: the text is the content here, and a
                one-line ellipsis would make the list unreadable. */}
            <span className="whitespace-pre-wrap break-words text-[11px] leading-snug text-text-primary">
              {s.text.trim()}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A segment's length as `N.Ns` — short enough to sit in a badge, and precise
 *  enough to tell a one-word segment from a sentence. */
function formatSegmentDuration(s: TranscriptSegment): string {
  return `${Math.max(0, s.end - s.start).toFixed(1)}s`;
}

/** Where a moment of SOURCE audio sits on the timeline, in timeline frames.
 *
 *  A transcript's times are absolute source seconds; the clip they belong to is
 *  a trimmed, possibly speed-ramped window onto that source placed at some
 *  `start_frame`. `spanToFrames` already owns that whole conversion — speed
 *  ramps and the clamp into the clip's own bounds included, so a rounded edge
 *  cannot seek outside the clip — which is why this is a two-line adapter over
 *  it rather than a second derivation of the same arithmetic. A zero-length
 *  span is all that is needed to locate a start. */
function timelineFrameForSourceSecs(clip: Clip, secs: number, fps: number): number {
  return spanToFrames(clip, secs, secs, fps).startFrame;
}

/**
 * The index of the transcript row the playhead is currently inside, or `-1`.
 *
 * **This is the D-325/B-146 constraint, and it is why this is a hook rather
 * than a `useEditorTimelineStore((s) => s.playhead)` one-liner.** A reactive
 * playhead selector re-renders its component on every displayed frame during
 * playback; D-325 measured that cost on `TimelinePane` and removed exactly this
 * pattern, and a list of transcript rows is precisely the kind of per-row
 * render body that must not run 24 times a second.
 *
 * So: read the playhead once with `getState()`, subscribe to the raw store
 * directly (it has no `subscribeWithSelector` middleware, so the listener gets
 * the whole state and filters for itself), compute which row that frame falls
 * in, and **call `setState` only when the resulting INDEX changes** — not when
 * the playhead does. A playhead tick that stays inside the same sentence
 * therefore costs one comparison and no React work at all; a re-render happens
 * only when the highlight genuinely has to move, which is a few times a minute
 * rather than 24 times a second.
 */
function useActiveTranscriptRow(
  segments: readonly TranscriptSegment[],
  clip: Clip | null,
  fps: number,
): number {
  const [active, setActive] = useState(-1);

  useEffect(() => {
    // The row boundaries in TIMELINE frames, computed once per subscription
    // rather than per tick — and computed INSIDE the effect rather than in a
    // `useMemo` it depends on, which is the shape the React Compiler cannot
    // preserve (see `useMarkerThumb` above and `reactCompiler.test.ts`).
    const bounds = clip
      ? segments.map((s) => ({
          start: timelineFrameForSourceSecs(clip, s.start, fps),
          end: timelineFrameForSourceSecs(clip, s.end, fps),
        }))
      : [];

    const rowFor = (frame: number): number =>
      bounds.findIndex((b) => frame >= b.start && frame < b.end);

    // Seed from the current value rather than waiting for the next tick, so
    // opening the panel mid-playback highlights immediately.
    let last = rowFor(useEditorTimelineStore.getState().playhead);
    setActive(last);

    return useEditorTimelineStore.subscribe((state) => {
      const next = rowFor(state.playhead);
      // The whole point: a tick that does not change the row does no React
      // work. `setActive` is called only on a genuine boundary crossing.
      if (next === last) return;
      last = next;
      setActive(next);
    });
  }, [segments, clip, fps]);

  return active;
}
