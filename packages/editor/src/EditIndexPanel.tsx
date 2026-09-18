/**
 * @apelles/editor — the Index library panel: every marker on the timeline, and
 * the WHOLE timeline's transcript, as two lists you navigate the edit from
 * (D-328, transcript widened to the sequence by D-329).
 *
 * **What it is.** The sixth `EditLibraryMode` (`editLibrary.ts`) and the only
 * one that READS the edit back rather than offering something to add to it or
 * cutting it. Two sub-views:
 *
 * - **Markers** — one row per `Timeline.markers` entry: its colour, a poster
 *   frame from whatever clip sits under it, its name, its time (and its span,
 *   for a D-328 ranged marker), an inline comment box, and a delete. Clicking a
 *   row seeks the playhead to the marker.
 * - **Transcript** — the speech of the ENTIRE timeline, stitched across every
 *   dialogue-bearing clip in timeline order, one row per segment with its
 *   TIMELINE timecode, a duration badge and the text. Clicking a row seeks to
 *   that row's timeline frame and clicking an individual WORD seeks to that
 *   word's own frame; as playback runs the row under the playhead is
 *   highlighted and, within it, the single word being spoken
 *   (karaoke-style) — both driven by ONE store subscription, never two.
 *   A transcript without word timings degrades to row-level only, which is a
 *   property of that transcript rather than a failure.
 *   **No selection is required** (D-329 — the D-328 version
 *   showed one selected clip and refused otherwise, which could not answer
 *   "what does my sequence say?" for a cut sequence). Selecting a single clip
 *   is a locator that accents that clip's rows, never a gate. The data mapping
 *   — dedupe the fetch per source file, but walk CLIPS in timeline order, and
 *   convert each segment's source seconds into timeline frames at the clip's
 *   own rate — lives in `timelineTranscript.ts`, pure and unit-tested; this
 *   file is the rendering, the per-file progress state, and the seek.
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
 * - It does not transcribe. It only READS the media-understanding store's
 *   `transcripts`/`transcribing`/`transcriptErrors` maps and offers a button
 *   that calls the same `startTranscript` the Recut panel and the
 *   captions-from-transcript button already use — once per distinct source
 *   file, never once per clip.
 * - It does not own the stitching. `timelineTranscript.ts` is the pure,
 *   testable half; this file renders what that returns.
 * - **It does not subscribe reactively to the playhead.** See
 *   `useActiveTranscriptRow` below — this is the D-325/B-146 constraint, and
 *   the reason the transcript highlight is built the way it is. (The one timer
 *   in this file, `useTranscriptElapsed`, runs at 1 Hz and only while a
 *   transcription job is actually in flight; see its own note.)
 *
 * **MCP parity** (checked, not assumed — CLAUDE.md's human+AI parity rule).
 * The Markers view needed no new tool and still does not: `editor_list_markers`
 * returns exactly the rows it draws (including D-328's
 * `durationFrames`/`endFrame`), `editor_set_marker` writes the inline comment,
 * `editor_remove_marker` deletes, `editor_set_playhead` is the seek.
 * **D-329's transcript view DID need one.** `editor_get_transcript` is keyed
 * per source file and answers in source seconds, so an agent could only match
 * this panel by re-deriving the clip-window filter and the
 * source-seconds → timeline-frames conversion itself — the exact arithmetic
 * B-077 got wrong in shipped code. `editor_get_timeline_transcript` therefore
 * exists on both MCP surfaces and is served by the same
 * `stitchTimelineTranscript` this panel renders, so the human and the agent
 * cannot be told different things. The one genuinely new piece of state here is
 * WHICH sub-view is showing, which is panel chrome rather than a capability,
 * and is already visible to the debug-only surface through `debug_ui_state`'s
 * `libraryMode` plus this component's `data-chroma-index-view` attribute.
 * See D-328 and D-329.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowsClockwiseIcon, FlagIcon, TextAlignLeftIcon, TrashIcon } from '@phosphor-icons/react';
import { Button, Input, Tabs, TabsContent, TabsList, TabsTrigger } from '@apelles/ui';
import { fmtTimecode } from '@apelles/player';

import { useEditorTimelineStore } from './timelineStore';
import { useMediaUnderstandingStore } from './mediaUnderstandingStore';
import { clipAt, markerEndFrame, markersOf, timelineFps, type Marker } from './timeline';
import {
  locateTimelineFrame,
  stitchTimelineTranscript,
  transcriptSources,
  type TimelineTranscriptRow,
  type TranscriptPosition,
  type TranscriptSourceRef,
} from './timelineTranscript';
import type { RecoveredWindow } from './darkRegions';
import { thumbAtSourceSecs } from './clipThumbs';

/** The two sub-views, in the order the tabs render them. Markers first: it is
 *  the one that always has something to show, since it needs no selection and
 *  no transcription. */
const INDEX_VIEWS = ['markers', 'transcript'] as const;
type IndexView = (typeof INDEX_VIEWS)[number];

/** The store's flat `recoveryKey -> RecoveredWindow` map, regrouped by source
 *  file for `stitchTimelineTranscript` (D-349).
 *
 *  A module-level pure function rather than an inline block, deliberately: the
 *  React Compiler bails out of a component whose memo body builds and mutates a
 *  keyed object in place (`reactCompiler.test.ts` catches exactly that, and did
 *  catch it here), and this has no business being inside the component anyway —
 *  it is a reshape of one map into another. */
function groupRecoveriesByPath(
  recoveries: Readonly<Record<string, RecoveredWindow>>,
): Record<string, RecoveredWindow[]> {
  const byPath = new Map<string, RecoveredWindow[]>();
  for (const [key, value] of Object.entries(recoveries)) {
    // The key is `<path>|<start>|<duration>`, and a real absolute path cannot
    // contain `|` — the same exact-prefix rule the store's own cache eviction
    // relies on.
    const path = key.slice(0, key.indexOf('|'));
    const list = byPath.get(path);
    if (list) list.push(value);
    else byPath.set(path, [value]);
  }
  return Object.fromEntries(
    Array.from(byPath, ([path, list]) => [
      path,
      [...list].sort((a, b) => a.window.startSecs - b.window.startSecs),
    ]),
  );
}

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

/**
 * The whole timeline's speech, in timeline order (D-329).
 *
 * **No selection required, by design.** Until D-329 this view showed one
 * selected clip's transcript and said "select one clip" otherwise, which made
 * the common question — "what does my sequence say?" — unanswerable, since a
 * cut sequence is dozens of clips. It now reads the entire timeline: every
 * dialogue-bearing clip, stitched in timeline order by
 * `stitchTimelineTranscript`. Selecting a clip is a *locator* (its rows get an
 * accent edge), never a gate.
 *
 * A timeline commonly draws many clips from ONE file — that is exactly what a
 * silence cut produces — and can also mix files. `transcriptSources` dedupes
 * the fetch list per path while the stitch still walks clips in TIMELINE
 * order, so twelve clips from one `.MOV` cost one transcription and still read
 * out in the order they play.
 */
function TranscriptView() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const selection = useEditorTimelineStore((s) => s.selection);
  const setPlayhead = useEditorTimelineStore((s) => s.setPlayhead);
  const transcripts = useMediaUnderstandingStore((s) => s.transcripts);
  const transcribing = useMediaUnderstandingStore((s) => s.transcribing);
  const transcriptErrors = useMediaUnderstandingStore((s) => s.transcriptErrors);
  // D-349 — the recut pass's recovered windows, so this panel shows the speech
  // whisper silently dropped rather than the hole it left. Subscribed to the
  // raw map (not the `recoveriesFor` selector) so the memo below re-runs only
  // when a recovery actually lands.
  const recoveries = useMediaUnderstandingStore((s) => s.recoveries);

  const fps = timelineFps(timeline);

  const sources = useMemo(() => transcriptSources(timeline), [timeline]);
  const byPath = useMemo(() => groupRecoveriesByPath(recoveries), [recoveries]);
  const rows = useMemo(
    () => stitchTimelineTranscript(timeline, transcripts, byPath),
    [timeline, transcripts, byPath],
  );

  // One status per FILE, so the progress list can say which of five files is
  // still running rather than showing one opaque spinner for all of them.
  const statuses = useMemo(
    () =>
      sources.map((s) => ({
        ...s,
        phase: transcripts[s.path]
          ? ('done' as const)
          : transcribing[s.path]
            ? ('running' as const)
            : transcriptErrors[s.path]
              ? ('error' as const)
              : ('idle' as const),
        error: transcriptErrors[s.path],
      })),
    [sources, transcripts, transcribing, transcriptErrors],
  );

  const pending = statuses.filter((s) => s.phase !== 'done');
  const doneCount = statuses.length - pending.length;

  const transcribeAll = useCallback(() => {
    const store = useMediaUnderstandingStore.getState();
    // Deduped by path already, and a cached file short-circuits inside the
    // store, so this is safe to fire for everything that is not done. A prior
    // failure is not sticky (see `startJob`), so this doubles as the retry.
    for (const s of statuses) {
      if (s.phase === 'done' || s.phase === 'running') continue;
      store.startTranscript(s.path, { wordTimestamps: true });
    }
  }, [statuses]);

  const active = useActivePosition(rows);

  // The single-selection LOCATOR (not a filter and not a gate): when exactly
  // one clip is selected, the rows that play from it get an accent edge, so a
  // reader can see where the clip they picked sits in the sequence. Anything
  // other than exactly one selected clip simply means no locator.
  const focusedClipId = selection.length === 1 ? selection[0].id : null;

  if (!timeline) return <EmptyNote>Open a project to read its transcript.</EmptyNote>;
  if (sources.length === 0) {
    return (
      <EmptyNote>
        Nothing to transcribe yet — add some footage to a video track and this will read back what is
        said across the whole timeline.
      </EmptyNote>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-chroma-transcript-index>
      {/* The progress header exists only while something is missing. Once every
          file is done it disappears and the panel is just the transcript. */}
      {pending.length > 0 ? (
        <TranscriptProgress
          statuses={statuses}
          doneCount={doneCount}
          onTranscribeAll={transcribeAll}
        />
      ) : null}

      {rows.length === 0 && pending.length === 0 ? (
        <EmptyNote>
          No speech found anywhere on this timeline. Transcription finds nothing in silent or
          music-only footage, which is not an error.
        </EmptyNote>
      ) : null}

      {rows.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {rows.map((row, i) => (
            <TranscriptRow
              key={`${row.clipId}-${row.sourceStart}-${i}`}
              row={row}
              index={i}
              fps={fps}
              active={i === active.row}
              activeWord={i === active.row ? active.word : -1}
              focused={row.clipId === focusedClipId}
              onSeek={() => setPlayhead(row.startFrame)}
              onSeekFrame={setPlayhead}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** What this view knows about one source file, for the progress list. */
interface SourceStatus extends TranscriptSourceRef {
  phase: 'idle' | 'running' | 'done' | 'error';
  error?: string;
}

/**
 * Per-FILE transcription progress, and the button that starts the missing ones.
 *
 * **Why this is per file rather than one spinner.** A whisper-large-v3 run on
 * long footage takes minutes, and a timeline can need several of them; a
 * single opaque spinner for "the timeline" would hide both which file is slow
 * and the fact that the others have already finished. So: a count, a row per
 * file that is not done, that file's own state, and — for a running one — how
 * long it has been going.
 *
 * The rows for files that ARE done render underneath this, immediately, rather
 * than waiting for the slowest one. Partial is the normal state here.
 */
function TranscriptProgress({
  statuses,
  doneCount,
  onTranscribeAll,
}: {
  statuses: readonly SourceStatus[];
  doneCount: number;
  onTranscribeAll: () => void;
}) {
  const running = statuses.filter((s) => s.phase === 'running');
  const startable = statuses.filter((s) => s.phase === 'idle' || s.phase === 'error');
  const elapsed = useTranscriptElapsed(running.map((s) => s.path));

  return (
    <div
      data-chroma-transcript-progress
      className="flex flex-col gap-1.5 rounded-md border border-border-color bg-bg-primary p-2"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-text-secondary">
          {doneCount} of {statuses.length} {statuses.length === 1 ? 'file' : 'files'} transcribed
        </span>
        {startable.length > 0 ? (
          <Button
            size="xs"
            data-chroma-index-transcribe
            className="h-6 shrink-0 px-2 text-[11px]"
            onClick={onTranscribeAll}
          >
            <ArrowsClockwiseIcon className="size-3" />
            {/* The count is on the button because each file is a separate
                minutes-long job — "Transcribe" alone would understate it. */}
            Transcribe {startable.length}
          </Button>
        ) : null}
      </div>

      <ul className="flex flex-col gap-1">
        {statuses
          .filter((s) => s.phase !== 'done')
          .map((s) => (
            <li
              key={s.path}
              data-chroma-transcript-source={s.path}
              data-chroma-transcript-phase={s.phase}
              className="flex items-baseline justify-between gap-2"
            >
              <span className="min-w-0 flex-1 truncate text-[10px] text-text-primary" title={s.path}>
                {basename(s.path)}
                {s.clipCount > 1 ? (
                  <span className="text-text-secondary"> · {s.clipCount} clips</span>
                ) : null}
              </span>
              <span className="shrink-0 tabular-nums text-[10px] text-text-secondary">
                {s.phase === 'running'
                  ? `transcribing ${formatElapsed(elapsed[s.path])}`
                  : s.phase === 'error'
                    ? 'failed'
                    : 'not transcribed'}
              </span>
            </li>
          ))}
      </ul>

      {/* The reason a file failed, shown once rather than per file, since the
          usual cause (a stopped sidecar, a missing venv) fails all of them the
          same way. Pressing Transcribe again retries — a failure is not
          sticky in the store. */}
      {statuses.find((s) => s.phase === 'error')?.error ? (
        <p className="text-[10px] leading-snug text-red-400">
          {statuses.find((s) => s.phase === 'error')!.error}
        </p>
      ) : null}
    </div>
  );
}

interface TranscriptRowProps {
  row: TimelineTranscriptRow;
  index: number;
  fps: number;
  active: boolean;
  /** Which word of THIS row the playhead is on, or `-1`. */
  activeWord: number;
  focused: boolean;
  onSeek: () => void;
  onSeekFrame: (frame: number) => void;
}

/**
 * One line of the transcript, and — when the transcript has word timings — one
 * clickable, individually highlightable button per word.
 *
 * **Why the row is an `<li>` with a click handler rather than one big
 * `<button>`** (which is what D-328's single-clip version used): every word is
 * now itself a button, and a button inside a button is invalid HTML whose
 * inner clicks browsers handle inconsistently. So the interactive elements are
 * the real ones — the timecode (seeks to the row) and each word (seeks to that
 * word) — and the `<li>`'s own handler is a mouse convenience that makes the
 * whitespace around the words clickable too. Nothing is reachable ONLY by that
 * handler, so keyboard and screen-reader users lose nothing.
 */
function TranscriptRow({
  row,
  index,
  fps,
  active,
  activeWord,
  focused,
  onSeek,
  onSeekFrame,
}: TranscriptRowProps) {
  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- see the component note: every action here also has a real focusable button; this handler only makes the row's padding clickable.
    <li
      data-chroma-transcript-row={index}
      data-chroma-transcript-clip={row.clipId}
      data-chroma-transcript-active={active ? '' : undefined}
      onClick={onSeek}
      className={`flex cursor-pointer flex-col gap-0.5 rounded-md p-1.5 text-left ${
        active ? 'bg-accent/15 ring-1 ring-accent/40' : 'hover:bg-bg-primary'
      } ${focused ? 'border-l-2 border-accent pl-1' : ''}`}
    >
      <span className="flex items-center gap-1.5">
        {/* The row's TIMELINE time, which is what the playhead will read after
            clicking it — not the source second it came from. This is also the
            row's keyboard-reachable seek target. */}
        <button
          type="button"
          data-chroma-transcript-row-seek={index}
          title={`Jump to ${fmtTimecode(row.startFrame, fps)}`}
          onClick={onSeek}
          className="rounded tabular-nums text-[10px] text-text-secondary outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {fmtTimecode(row.startFrame, fps)}
        </button>
        <span className="rounded bg-bg-primary px-1 text-[9px] tabular-nums text-text-secondary">
          {formatRowDuration(row, fps)}
        </span>
        {/* D-349 — these words are NOT in the transcript whisper returned: the
            whole-file pass silently dropped this stretch and the app went back
            and re-read it in isolation. Said out loud rather than folded in
            invisibly, so a reader is never blindsided by content appearing in a
            transcript that was not there before. */}
        {row.recovered ? (
          <span
            data-chroma-transcript-recovered={index}
            title="Recovered: the whole-file transcription silently skipped this speech, so it was re-transcribed on its own"
            className="rounded bg-accent/20 px-1 text-[9px] uppercase tracking-wide text-accent"
          >
            recovered
          </span>
        ) : null}
      </span>

      {/* Word-wrapped, not truncated: the text is the content here, and a
          one-line ellipsis would make the list unreadable. */}
      <span className="whitespace-pre-wrap break-words text-[11px] leading-snug text-text-primary">
        {row.words.length === 0
          ? // No word timings (`wordTimestamps: false`, or a model that
            // returned none). The row is still readable and still seekable —
            // it simply has no per-word granularity, which is a property of
            // the transcript rather than a failure.
            row.text
          : row.words.map((w, j) => {
              // The word's own leading space is rendered OUTSIDE the button.
              // The space has to survive (see `TimelineTranscriptWord.text` —
              // `whitespace-pre-wrap` on the parent keeps it, and that is what
              // makes the line read as real prose rather than evenly-spaced
              // chips), but it must not be part of the highlight: with the
              // space inside, the active word's background box extended left
              // and butted straight against the previous word, with no gap.
              // Caught in real Chromium on D-142's harness — jsdom has no
              // layout engine and every unit test passed while it looked
              // wrong. Splitting here keeps the prose identical and makes the
              // highlight hug the word.
              const lead = w.text.slice(0, w.text.length - w.text.trimStart().length);
              const core = w.text.slice(lead.length);
              return (
                <span key={`${w.startFrame}-${j}`}>
                  {lead}
                  <button
                    type="button"
                    data-chroma-transcript-word={j}
                    data-chroma-transcript-word-active={j === activeWord ? '' : undefined}
                    title={`Jump to ${fmtTimecode(w.startFrame, fps)}`}
                    onClick={(e) => {
                      // Without this the `<li>`'s handler would also fire and
                      // seek to the row's start, overwriting the word seek.
                      e.stopPropagation();
                      onSeekFrame(w.startFrame);
                    }}
                    // No horizontal padding, deliberately: 1px per side is
                    // added to EVERY inter-word gap, which visibly loosened
                    // the prose and pushed a line that had fit onto a second
                    // one. Also caught on the harness, in the same pass that
                    // introduced it.
                    className={`rounded-[2px] text-left outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                      j === activeWord ? 'bg-accent text-button-text' : 'hover:bg-bg-secondary'
                    }`}
                  >
                    {core}
                  </button>
                </span>
              );
            })}
      </span>
    </li>
  );
}

/** A row's length on the TIMELINE as `N.Ns`. Measured in timeline frames, not
 *  in the source seconds it came from, because those two differ for a
 *  speed-ramped clip and for a row clamped at a cut edge — and what the reader
 *  is being told is how long this line takes in the edit. */
function formatRowDuration(row: TimelineTranscriptRow, fps: number): string {
  return `${Math.max(0, (row.endFrame - row.startFrame) / fps).toFixed(1)}s`;
}

/** The last path segment, for the progress list. A full absolute path is
 *  unreadable in a 288px column; the whole path stays in the `title`. */
function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut < 0 ? path : path.slice(cut + 1);
}

/** `m:ss` once past a minute, `Ns` below it. These jobs run for minutes, so
 *  "143s" is worse than "2:23". */
function formatElapsed(ms: number | undefined): string {
  if (ms === undefined) return '';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

/** How long each running transcription has been going, in ms, keyed by path.
 *
 *  **A 1 Hz ticker, and only while something is actually running** — the
 *  interval is created when the running set becomes non-empty and cleared when
 *  it empties, so an idle panel has no timer at all. This is deliberately NOT
 *  a D-325 violation: that rule is about the 24 Hz playhead, and this ticks
 *  once a second only during a minutes-long job, which is precisely the
 *  feedback the job needs to not look wedged.
 *
 *  Start times are held in a ref keyed by path, so a file that started before
 *  the panel was opened is timed from when this hook first SAW it running
 *  rather than from zero — an under-count that is honest about what the UI
 *  knows, and better than resetting the clock on every re-render. Crucially
 *  that ref is **only ever touched inside the effect and its interval**, never
 *  during render: reading `ref.current` in a render body is a React Compiler
 *  bailout ("Cannot access refs during render"), which switches
 *  auto-memoization off for this whole file — caught by `reactCompiler.test.ts`
 *  (D-201) on this hook's first draft, which did exactly that. The sampled
 *  values go out through state instead. */
function useTranscriptElapsed(runningPaths: readonly string[]): Record<string, number> {
  const startedAt = useRef<Map<string, number>>(new Map());
  const [elapsed, setElapsed] = useState<Record<string, number>>({});

  // A primitive dependency, not the array: the effect must re-run when the SET
  // of running files changes, not on every render that rebuilds the array.
  // (A memoized object used as an effect dependency is the other shape the
  // React Compiler cannot preserve — see `useMarkerThumb` above.)
  const key = runningPaths.join('|');

  useEffect(() => {
    const paths = key ? key.split('|') : [];
    const startedNow = Date.now();
    for (const p of paths) {
      if (!startedAt.current.has(p)) startedAt.current.set(p, startedNow);
    }
    // Forget finished jobs, so a re-run of the same file times from its new
    // start rather than its first one.
    for (const p of Array.from(startedAt.current.keys())) {
      if (!paths.includes(p)) startedAt.current.delete(p);
    }
    if (paths.length === 0) {
      setElapsed({});
      return;
    }
    const sample = () => {
      const at = Date.now();
      const out: Record<string, number> = {};
      for (const [p, started] of startedAt.current) out[p] = at - started;
      setElapsed(out);
    };
    sample();
    const id = setInterval(sample, 1000);
    return () => clearInterval(id);
  }, [key]);

  return elapsed;
}

/**
 * Which transcript row — and which WORD inside it — the playhead is currently
 * on. `-1` for either means "not on one".
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
 * the whole state and filters for itself), compute the position that frame
 * falls in, and **call `setState` only when the resulting POSITION changes** —
 * not when the playhead does. A tick that stays on the same word costs one
 * scan and two integer comparisons and does no React work at all.
 *
 * **The word-level highlight (D-329) extends this ONE subscription rather than
 * adding a second.** That is deliberate: two subscriptions would each wake on
 * every tick and could disagree about which frame they were describing.
 * `locateTimelineFrame` returns both indices from one scan, and the guard
 * below compares both. The honest cost change is that a re-render now happens
 * once per spoken WORD rather than once per sentence — a few times a second
 * during speech instead of a few times a minute — which is the price of the
 * feature and still an order of magnitude below the 24 Hz a reactive selector
 * would cost. `EditIndexPanel.dom.test.tsx` pins both halves: zero commits for
 * ticks inside one word, exactly one for a word boundary.
 *
 * D-329 also made the scan cheaper: rows arrive already carrying their TIMELINE
 * frames (`stitchTimelineTranscript` did the conversion once), so the
 * subscription body does no arithmetic at all.
 */
function useActivePosition(rows: readonly TimelineTranscriptRow[]): TranscriptPosition {
  const [active, setActive] = useState<TranscriptPosition>({ row: -1, word: -1 });

  useEffect(() => {
    // Seed from the current value rather than waiting for the next tick, so
    // opening the panel mid-playback highlights immediately.
    let last = locateTimelineFrame(rows, useEditorTimelineStore.getState().playhead);
    setActive(last);

    return useEditorTimelineStore.subscribe((state) => {
      const next = locateTimelineFrame(rows, state.playhead);
      // The whole point: a tick that does not move the highlight does no React
      // work. `setActive` is called only on a genuine boundary crossing — of a
      // row OR of a word.
      if (next.row === last.row && next.word === last.word) return;
      last = next;
      setActive(next);
    });
  }, [rows]);

  return active;
}
