/**
 * `@apelles/editor` — the Music edits library panel: music dropouts by story
 * beat, made here or reviewed here (D-408).
 *
 * **What it is.** The `music` `EditLibraryMode`. Three parts, top to bottom:
 *
 * - **Settings** — which audio track is the bed when more than one has music
 *   under a range, the fade out / fade in lengths, and whether the music
 *   re-enters where it would have been (continuous) or where it stopped
 *   (pause). These are the defaults every GUI music edit uses.
 * - **Make one** — mark a range at the playhead (In / Out, the Resolve /
 *   Premiere range gesture), pick the beat kind, and cut it now or add it to
 *   the list; or one click for a one-second stop-time breath before the
 *   playhead. (Right-clicking a transcript line or a marker in the Index panel
 *   offers the same, anchored to that line — `MusicEditMenu`.)
 * - **Review** — the agent's `editor_propose_music_edits` batch (and rows the
 *   person added), one row per edit: kind, words, why, the range, and any
 *   reason it cannot land now. Accept / reject each, nudge its in and out,
 *   jump to it, play from just before it, then Apply — ONE undo step. Like the
 *   Recut panel's retake rows (D-380 step 2): a stale banner when the voice
 *   track changed since the AI read it, and a Dismiss that changes nothing on
 *   the timeline.
 *
 * Make-one and Review sit in a vertical resizable split (CLAUDE.md: panes that
 * hold real content are resizable). The reference pass behind this layout —
 * Premiere's Essential Sound / Remix, Resolve's Fairlight fades and range
 * edits, Descript's edit-by-text — is in `scratch/music-edit-reference/` and
 * cited in D-408.
 *
 * **What it does NOT do.** No edit logic: every action is `quickMusicEdit` /
 * `applyProposalSet` in `musicEditOps.ts`, the functions the MCP tools call,
 * dispatching the one `music_edits` op. It never subscribes to the playhead
 * (D-325/B-146): In, Out and the breath read it once, on click.
 */

import { useMemo, useState } from 'react';
import {
  ArrowLineDownIcon,
  CheckIcon,
  CrosshairSimpleIcon,
  ListPlusIcon,
  MusicNotesMinusIcon,
  PauseIcon,
  PlayIcon,
  RobotIcon,
  UserIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import {
  Button,
  Label,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  ScrubbableNumberInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@apelles/ui';
import { fmtTimecode } from '@apelles/player';

import { timelineFps, type MusicEditMode, type Timeline } from './timeline';
import { useEditorTimelineStore } from './timelineStore';
import { recoveriesIn, useMediaUnderstandingStore } from './mediaUnderstandingStore';
import { buildWordViewInput, viewBasisKey } from './retakeWordView';
import {
  breathBefore,
  MUSIC_EDIT_KIND_LABELS,
  MUSIC_EDIT_KINDS,
  rowProblem,
  rowsToApply,
  type MusicEditKind,
  type MusicEditProposalSet,
  type MusicEditRow,
} from './musicEdits';
import { applyProposalSet, quickMusicEdit } from './musicEditOps';
import { useMusicEditStore } from './musicEditStore';

/** The make-one pane's starting height, px; the review list takes the rest. */
const MAKE_PANE_DEFAULT_PX = 168;
const MAKE_PANE_MIN_PX = 96;
const REVIEW_PANE_MIN_PX = 120;

/** "Play from just before": how much lead-in an audition gets, in seconds. */
const AUDITION_PREROLL_SECONDS = 2;

/** The Select value for "no fixed bed — use the one under the range". */
const AUTO_TRACK = 'auto';

const MODE_LABELS: Record<MusicEditMode, string> = {
  continuous: 'Re-enter where it would be',
  pause: 'Resume where it stopped',
};

/** The audio tracks that could hold a bed, for the Bed picker. */
function audioTracks(tl: Timeline | null): Array<{ index: number; label: string }> {
  if (!tl) return [];
  return tl.tracks
    .map((t, index) => ({ t, index }))
    .filter(({ t }) => t.kind === 'audio')
    .map(({ t, index }) => ({
      index,
      label: `Track ${index}${t.clips[0] ? ` · ${t.clips[0].name}` : ''}`,
    }));
}

export function MusicEditsPanel() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const proposals = useMusicEditStore((s) => s.proposals);
  const defaults = useMusicEditStore((s) => s.defaults);
  const setDefaults = useMusicEditStore((s) => s.setDefaults);
  const fps = timelineFps(timeline);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);

  const tracks = useMemo(() => audioTracks(timeline), [timeline]);
  const sets = useMemo(
    () =>
      Object.values(proposals)
        .filter((s) => timeline && s.timelineId === timeline.id)
        .sort((a, b) => a.track - b.track),
    [proposals, timeline],
  );

  if (!timeline) {
    return <p className="p-3 text-[11px] leading-snug text-text-secondary">Open a project to edit its music.</p>;
  }

  return (
    <div data-chroma-music-edits className="flex min-h-0 flex-1 flex-col">
      {/* Settings — the defaults every GUI music edit uses. */}
      <div className="shrink-0 space-y-1.5 border-b border-border-color p-2 text-[11px]">
        <div className="flex items-center gap-2">
          <Label className="w-14 shrink-0 text-[11px] text-text-secondary">Bed</Label>
          <Select
            value={defaults.track === null ? AUTO_TRACK : String(defaults.track)}
            onValueChange={(v) => setDefaults({ track: v === AUTO_TRACK || v === null ? null : Number(v) })}
          >
            <SelectTrigger data-chroma-music-edits-bed className="h-7 flex-1 text-[11px]">
              <SelectValue>
                {defaults.track === null
                  ? 'Auto — the track with music there'
                  : (tracks.find((t) => t.index === defaults.track)?.label ?? `Track ${defaults.track}`)}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO_TRACK}>Auto — the track with music there</SelectItem>
              {tracks.map((t) => (
                <SelectItem key={t.index} value={String(t.index)}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Label
            className="w-14 shrink-0 text-[11px] text-text-secondary"
            title="Fade out into the dropout / fade back in after it, in frames"
          >
            Fades
          </Label>
          <ScrubbableNumberInput
            data-chroma-music-edits-fade-out
            aria-label="Fade out (frames)"
            title="Fade out into the dropout (frames)"
            className="h-7 w-14 text-[11px]"
            value={defaults.fadeOutFrames}
            min={0}
            step={1}
            onValueChange={(v) => setDefaults({ fadeOutFrames: Math.max(0, Math.round(v)) })}
          />
          <span className="text-text-secondary">out</span>
          <ScrubbableNumberInput
            data-chroma-music-edits-fade-in
            aria-label="Fade in (frames)"
            title="Fade back in after the dropout (frames)"
            className="h-7 w-14 text-[11px]"
            value={defaults.fadeInFrames}
            min={0}
            step={1}
            onValueChange={(v) => setDefaults({ fadeInFrames: Math.max(0, Math.round(v)) })}
          />
          <span className="text-text-secondary">in</span>
        </div>
        <div className="flex items-center gap-2">
          <Label className="w-14 shrink-0 text-[11px] text-text-secondary">Re-entry</Label>
          <Select value={defaults.mode} onValueChange={(v) => v && setDefaults({ mode: v as MusicEditMode })}>
            <SelectTrigger data-chroma-music-edits-mode className="h-7 flex-1 text-[11px]">
              <SelectValue>{MODE_LABELS[defaults.mode]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(MODE_LABELS) as MusicEditMode[]).map((m) => (
                <SelectItem key={m} value={m}>
                  {MODE_LABELS[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {notice && (
        <button
          type="button"
          data-chroma-music-edits-notice={notice.ok ? 'ok' : 'error'}
          onClick={() => setNotice(null)}
          title="Dismiss"
          className={`flex shrink-0 items-start gap-1 border-b border-border-color px-2.5 py-1.5 text-left text-[11px] leading-snug ${
            notice.ok ? 'text-text-secondary' : 'text-destructive'
          }`}
        >
          <span className="flex-1">{notice.message}</span>
          <XIcon className="mt-0.5 size-3 shrink-0" />
        </button>
      )}

      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel defaultSize={MAKE_PANE_DEFAULT_PX} minSize={MAKE_PANE_MIN_PX} className="flex min-h-0 flex-col">
          <MakeOne fps={fps} onNotice={setNotice} />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel minSize={REVIEW_PANE_MIN_PX} className="flex min-h-0 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto" data-chroma-music-edits-review>
            {sets.length === 0 ? (
              <p className="p-2.5 text-[11px] leading-snug text-text-secondary">
                No music edits to review. Ask the AI to propose dropouts on the story beats, or add your own above — or
                right-click a line in the Index panel’s transcript.
              </p>
            ) : (
              sets.map((s) => <ReviewSet key={s.track} set={s} timeline={timeline} fps={fps} onNotice={setNotice} />)
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

/** The make-one pane: a range from In / Out at the playhead, a kind, and Cut
 *  now or Add to the list; plus the one-click breath. */
function MakeOne({ fps, onNotice }: { fps: number; onNotice: (n: { ok: boolean; message: string }) => void }) {
  const [markIn, setMarkIn] = useState<number | null>(null);
  const [markOut, setMarkOut] = useState<number | null>(null);
  const [kind, setKind] = useState<MusicEditKind>('dropout');
  const playheadNow = () => useEditorTimelineStore.getState().playhead;
  const ranged = markIn !== null && markOut !== null && markOut > markIn;

  const make = (review: boolean) => {
    if (!ranged || markIn === null || markOut === null) return;
    onNotice(quickMusicEdit({ kind, start: markIn, end: markOut, review }));
  };

  return (
    <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2 text-[11px]">
      <div className="flex items-center gap-1.5">
        <Button
          variant="outline"
          size="xs"
          data-chroma-music-edits-mark-in
          onClick={() => setMarkIn(playheadNow())}
          title="Mark the dropout's start at the playhead"
        >
          In {markIn === null ? '—' : fmtTimecode(markIn, fps)}
        </Button>
        <Button
          variant="outline"
          size="xs"
          data-chroma-music-edits-mark-out
          onClick={() => setMarkOut(playheadNow())}
          title="Mark where the music comes back, at the playhead"
        >
          Out {markOut === null ? '—' : fmtTimecode(markOut, fps)}
        </Button>
      </div>
      <div className="flex items-center gap-1.5">
        <Select value={kind} onValueChange={(v) => v && setKind(v as MusicEditKind)}>
          <SelectTrigger data-chroma-music-edits-kind className="h-7 flex-1 text-[11px]">
            <SelectValue>{MUSIC_EDIT_KIND_LABELS[kind]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {MUSIC_EDIT_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {MUSIC_EDIT_KIND_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          variant="default"
          size="xs"
          disabled={!ranged}
          data-chroma-music-edits-cut
          onClick={() => make(false)}
          title={ranged ? 'Cut the music out between In and Out now (one undo)' : 'Mark an In and a later Out first'}
        >
          <MusicNotesMinusIcon className="size-3.5" /> Cut now
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={!ranged}
          data-chroma-music-edits-add
          onClick={() => make(true)}
          title="Add it to the review list below, accepted, to apply with the rest"
        >
          <ListPlusIcon className="size-3.5" /> Add to list
        </Button>
        <Button
          variant="ghost"
          size="xs"
          data-chroma-music-edits-breath
          onClick={() => {
            const b = breathBefore(playheadNow(), fps);
            onNotice(
              b
                ? quickMusicEdit({ kind: 'breath', start: b.start, end: b.end })
                : { ok: false, message: 'Move the playhead past the first second to place a breath before it.' },
            );
          }}
          title="A one-second stop-time breath ending at the playhead: the music stops, then comes back on the playhead"
        >
          <PauseIcon className="size-3.5" /> Breath before playhead
        </Button>
      </div>
    </div>
  );
}

/** One music track's review list. */
function ReviewSet({
  set,
  timeline,
  fps,
  onNotice,
}: {
  set: MusicEditProposalSet;
  timeline: Timeline;
  fps: number;
  onNotice: (n: { ok: boolean; message: string }) => void;
}) {
  const transcripts = useMediaUnderstandingStore((s) => s.transcripts);
  const transcriptErrors = useMediaUnderstandingStore((s) => s.transcriptErrors);
  const recoveries = useMediaUnderstandingStore((s) => s.recoveries);
  const appliedRereads = useMediaUnderstandingStore((s) => s.appliedRereads);

  /** Has the voice track moved away from the view the AI anchored words to?
   *  The same inputs the view id is built from, recomputed — the Recut panel's
   *  check, so the person is told BEFORE applying rows whose frames now sit
   *  under other words. */
  const stale = useMemo(() => {
    if (set.wordTrack === undefined || !set.basisKey) return false;
    const maps = { recoveries, appliedRereads };
    const input = buildWordViewInput(
      timeline,
      set.wordTrack,
      transcripts,
      (p) => recoveriesIn(maps, p),
      transcriptErrors,
    );
    return 'error' in input || viewBasisKey(input) !== set.basisKey;
  }, [set, timeline, transcripts, transcriptErrors, recoveries, appliedRereads]);

  const toApply = rowsToApply(set, false).filter((r) => rowProblem(timeline, r, set.track) === null);
  const pending = set.rows.filter((r) => r.status === 'pending').length;

  return (
    <section data-chroma-music-edits-set={set.track} className="border-b border-border-color">
      <div className="flex items-center justify-between gap-2 px-2.5 pt-2 text-[11px] text-text-secondary">
        <span>
          Track {set.track} · {set.rows.length} edit{set.rows.length === 1 ? '' : 's'}
        </span>
        <span className="flex items-center gap-2">
          {pending > 0 && (
            <button
              type="button"
              data-chroma-music-edits-accept-all
              onClick={() => useMusicEditStore.getState().setAllPending(set.track, 'accepted')}
              className="underline-offset-2 hover:underline"
              title="Accept every row still waiting for review"
            >
              Accept all
            </button>
          )}
          <button
            type="button"
            data-chroma-music-edits-dismiss
            onClick={() => useMusicEditStore.getState().setProposals(set.track, null)}
            className="underline-offset-2 hover:underline"
            title="Discard this list (nothing on the timeline changes)"
          >
            Dismiss
          </button>
        </span>
      </div>
      {stale && (
        <p data-chroma-music-edits-stale className="px-2.5 pt-1 text-[11px] leading-snug text-destructive">
          <WarningIcon className="mr-1 inline size-3.5 align-[-2px]" />
          The voice track changed since the AI chose these words — check each range before applying, or ask it to
          propose again.
        </p>
      )}
      <ul className="p-1.5">
        {set.rows.map((row) => (
          <ReviewRow key={row.id} row={row} track={set.track} timeline={timeline} fps={fps} />
        ))}
      </ul>
      <div className="px-2 pb-2">
        <Button
          variant="default"
          size="sm"
          className="w-full"
          disabled={toApply.length === 0}
          data-chroma-music-edits-apply={set.track}
          onClick={() => {
            const out = applyProposalSet(set.track, false);
            if ('error' in out) {
              onNotice({ ok: false, message: out.error });
              return;
            }
            const failed = out.results.length - out.applied;
            onNotice({
              ok: failed === 0,
              message:
                `${out.applied} music edit${out.applied === 1 ? '' : 's'} applied as one undo step.` +
                (failed > 0 ? ` ${failed} could not land and stay in the list with the reason.` : ''),
            });
          }}
        >
          <ArrowLineDownIcon className="size-3.5" /> Apply {toApply.length} accepted
        </Button>
      </div>
    </section>
  );
}

function ReviewRow({
  row,
  track,
  timeline,
  fps,
}: {
  row: MusicEditRow;
  track: number;
  timeline: Timeline;
  fps: number;
}) {
  const problem = rowProblem(timeline, row, track);
  const seek = (frame: number) => useEditorTimelineStore.getState().setPlayhead(Math.max(0, frame));
  const audition = () => {
    const s = useEditorTimelineStore.getState();
    s.setPlayhead(Math.max(0, row.start - Math.round(AUDITION_PREROLL_SECONDS * fps)));
    s.setPlaying(true);
  };
  const OriginIcon = row.origin === 'ai' ? RobotIcon : UserIcon;

  return (
    <li
      data-chroma-music-edit-row={row.id}
      data-chroma-music-edit-status={row.status}
      className={`rounded px-1.5 py-1.5 text-[11px] leading-snug hover:bg-bg-primary ${
        row.status === 'rejected' ? 'opacity-50' : ''
      }`}
    >
      <div className="flex items-center gap-1.5">
        <OriginIcon
          className="size-3.5 shrink-0 text-text-secondary"
          aria-label={row.origin === 'ai' ? 'Proposed by the AI' : 'Added by you'}
        />
        <span className="flex-1 font-medium">
          {MUSIC_EDIT_KIND_LABELS[row.kind]}
          {row.status === 'accepted' && <span className="ml-1 font-normal text-accent">· accepted</span>}
          {row.status === 'rejected' && <span className="ml-1 font-normal text-text-secondary">· rejected</span>}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          data-chroma-music-edit-accept={row.id}
          aria-pressed={row.status === 'accepted'}
          disabled={problem !== null}
          onClick={() =>
            useMusicEditStore.getState().setRowStatus(track, row.id, row.status === 'accepted' ? 'pending' : 'accepted')
          }
          title={problem ? 'This edit cannot land as it stands' : row.status === 'accepted' ? 'Un-accept' : 'Accept'}
          className={row.status === 'accepted' ? 'text-accent' : 'text-text-secondary'}
        >
          <CheckIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          data-chroma-music-edit-reject={row.id}
          aria-pressed={row.status === 'rejected'}
          onClick={() =>
            useMusicEditStore.getState().setRowStatus(track, row.id, row.status === 'rejected' ? 'pending' : 'rejected')
          }
          title={row.status === 'rejected' ? 'Un-reject' : 'Reject'}
          className={row.status === 'rejected' ? 'text-destructive' : 'text-text-secondary'}
        >
          <XIcon />
        </Button>
      </div>
      {row.text && <p className="mt-0.5 text-text-primary">“{row.text}”</p>}
      {row.reason && <p className="mt-0.5 text-text-secondary">{row.reason}</p>}
      <div className="mt-1 flex items-center gap-1">
        <ScrubbableNumberInput
          data-chroma-music-edit-start={row.id}
          aria-label="Music out at (frame)"
          title={`Music out at ${fmtTimecode(row.start, fps)} (frame)`}
          className="h-6 w-16 text-[11px]"
          value={row.start}
          min={0}
          step={1}
          onValueChange={(v) => useMusicEditStore.getState().patchRow(track, row.id, { start: v })}
        />
        <span className="text-text-secondary">→</span>
        <ScrubbableNumberInput
          data-chroma-music-edit-end={row.id}
          aria-label="Music back at (frame)"
          title={`Music back at ${fmtTimecode(row.end, fps)} (frame)`}
          className="h-6 w-16 text-[11px]"
          value={row.end}
          min={1}
          step={1}
          onValueChange={(v) => useMusicEditStore.getState().patchRow(track, row.id, { end: v })}
        />
        <span className="flex-1 tabular-nums text-text-secondary">{((row.end - row.start) / fps).toFixed(2)}s</span>
        <Button
          variant="ghost"
          size="icon-xs"
          data-chroma-music-edit-jump={row.id}
          onClick={() => seek(row.start)}
          title="Jump to where the music stops"
        >
          <CrosshairSimpleIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          data-chroma-music-edit-audition={row.id}
          onClick={audition}
          title={`Play from ${AUDITION_PREROLL_SECONDS} s before the beat`}
        >
          <PlayIcon />
        </Button>
      </div>
      {problem && (
        <p data-chroma-music-edit-problem={row.id} className="mt-0.5 text-destructive">
          {problem}
        </p>
      )}
    </li>
  );
}
