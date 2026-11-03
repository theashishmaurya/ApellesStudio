/**
 * `@apelles/editor` — the Music edits library panel: silence the music for a
 * moment, made here or reviewed here (D-408; redesigned by D-444, B-364).
 *
 * **What it is.** The `music` `EditLibraryMode`, built from the owner-approved
 * mockup (`scratch/panel-redesign-mockup.html`, "Music edits", revision 2 —
 * "the control is the explanation": descriptions in tooltips, values edited on
 * the thing they describe). Top to bottom, in the order of use:
 *
 * - **The music track**, one quiet line ("On A3 · Electronic Vibrations ▾"),
 *   with an "Automatic: the track with music under the range" entry.
 * - **Empty state**: one sentence of purpose, "Music stops at the playhead (I)"
 *   and the one-second breath.
 * - **Making one**: the kind as pills (Dropout, Breath, Dry open, Dry CTA,
 *   Section end; only the selected one's sentence shows); the range as one row
 *   of timecodes with the playhead target inside each field — the range IS the
 *   timeline's In / Out marks (B-348: I / O set it, the ruler draws it); the
 *   fades dragged on the diagram's own dots (seconds, in time order); "Song
 *   keeps time / Song resumes" as a segmented control; Preview ▶ (plays the
 *   edit before it is applied, `musicPreview.ts`), Apply, and ⋯ › Save for
 *   later.
 * - **Suggested by your agent**: one row per edit — kind and status, the line,
 *   why, the range as timecodes (click to go there), a problem in words when it
 *   cannot land — with Preview, Change (the row's own fades and re-entry, on
 *   the same diagram), Approve, Skip; "Approve all", "Dismiss" (nothing on the
 *   timeline changes), the stale-voice warning, and "Apply N approved · one
 *   undo".
 *
 * The fade lengths and the re-entry choice made here are the defaults the next
 * edit starts from (`useMusicEditStore.defaults`).
 *
 * **What it does NOT do.** No edit logic: every action is `quickMusicEdit` /
 * `applyProposalSet` (`musicEditOps.ts`, the functions the MCP tools call,
 * dispatching the one `music_edits` op) or the store's row actions. It never
 * subscribes to the playhead (D-325/B-146): the playhead targets read it once,
 * on click.
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLineDownIcon,
  ArrowRightIcon,
  CheckIcon,
  CrosshairSimpleIcon,
  DotsThreeIcon,
  FlagIcon,
  MegaphoneIcon,
  MusicNoteIcon,
  MusicNotesMinusIcon,
  PauseIcon,
  PencilSimpleIcon,
  PlayIcon,
  PlusIcon,
  RobotIcon,
  StopIcon,
  UserIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@apelles/ui';

import { timelineFps, type MusicEditMode, type MusicEditRange, type Timeline } from './timeline';
import { useEditorTimelineStore } from './timelineStore';
import { recoveriesIn, useMediaUnderstandingStore } from './mediaUnderstandingStore';
import { buildWordViewInput, viewBasisKey } from './retakeWordView';
import {
  breathBefore,
  fmtMusicTime,
  MUSIC_EDIT_KIND_HINTS,
  MUSIC_EDIT_KIND_LABELS,
  MUSIC_EDIT_KINDS,
  musicTrackFor,
  rowProblem,
  rowRange,
  rowsToApply,
  type MusicEditKind,
  type MusicEditProposalSet,
  type MusicEditRow,
} from './musicEdits';
import { applyProposalSet, quickMusicEdit } from './musicEditOps';
import { useMusicEditStore, type MusicEditRowPatch } from './musicEditStore';
import { previewKey, previewMusicEdit, stopMusicPreview, useMusicPreviewStore } from './musicPreview';
import { trackBadges, trackLabels } from './trackOps';

/** The Select value for "no fixed bed — use the one under the range". */
const AUTO_TRACK = 'auto';

/** The longest fade the diagram's dots reach, seconds. */
const FADE_MAX_SECONDS = 1.2;

const KIND_ICONS: Record<MusicEditKind, typeof MusicNotesMinusIcon> = {
  dropout: MusicNotesMinusIcon,
  breath: PauseIcon,
  dry_open: PlayIcon,
  dry_cta: MegaphoneIcon,
  section_out: FlagIcon,
};

const MODE_LABELS: Record<MusicEditMode, string> = {
  continuous: 'Song keeps time',
  pause: 'Song resumes',
};

const MODE_HINTS: Record<MusicEditMode, string> = {
  continuous: 'The song keeps its timing; the part under the gap is skipped. Best on a steady beat.',
  pause: 'Nothing is skipped; the rest of the song plays later. Best when a lyric or a build matters.',
};

type Notice = { ok: boolean; message: string } | null;

/** "A3 · Electronic Vibrations" for each audio track: its badge, and its name
 *  (a renamed track) or the music on it. */
function audioTracks(tl: Timeline | null): Array<{ index: number; label: string }> {
  if (!tl) return [];
  const badges = trackBadges(tl);
  const names = trackLabels(tl);
  return tl.tracks
    .map((t, index) => ({ t, index }))
    .filter(({ t }) => t.kind === 'audio')
    .map(({ t, index }) => ({
      index,
      label: `${badges[index]} · ${t.name?.trim() || t.clips[0]?.name || names[index]}`,
    }));
}

export function MusicEditsPanel() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const proposals = useMusicEditStore((s) => s.proposals);
  const defaults = useMusicEditStore((s) => s.defaults);
  const setDefaults = useMusicEditStore((s) => s.setDefaults);
  const inPoint = useEditorTimelineStore((s) => s.inPoint);
  const [making, setMaking] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const fps = timelineFps(timeline);

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

  const trackLabel =
    defaults.track === null
      ? 'Automatic: the track with music under the range'
      : (tracks.find((t) => t.index === defaults.track)?.label ?? `Track ${defaults.track}`);
  const showMake = making || inPoint !== null;
  const empty = !showMake && sets.length === 0;

  return (
    <div data-chroma-music-edits className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2.5 text-xs">
      <div className="flex flex-col gap-3">
        <Select value={defaults.track === null ? AUTO_TRACK : String(defaults.track)} onValueChange={(v) => setDefaults({ track: v === AUTO_TRACK || v === null ? null : Number(v) })}>
          <SelectTrigger
            data-chroma-music-edits-bed
            aria-label="Music track"
            title="The music track these edits cut. Click to pick another."
            className="data-[size=default]:h-6 w-full justify-start gap-1.5 border-0 bg-transparent px-0 text-xs text-text-tertiary shadow-none hover:text-text-secondary"
          >
            <MusicNoteIcon className="size-3.5 shrink-0" />
            <span className="truncate">
              On <b className="font-medium text-text-secondary">{trackLabel}</b>
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTO_TRACK}>Automatic: the track with music under the range</SelectItem>
            {tracks.map((t) => (
              <SelectItem key={t.index} value={String(t.index)}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {notice && (
          <button
            type="button"
            data-chroma-music-edits-notice={notice.ok ? 'ok' : 'error'}
            onClick={() => setNotice(null)}
            title="Dismiss"
            className={`flex items-start gap-1 rounded-sm bg-bg-secondary px-2.5 py-1.5 text-left leading-snug ${notice.ok ? 'text-text-secondary' : 'text-destructive'}`}
          >
            <span className="flex-1">{notice.message}</span>
            <XIcon className="mt-0.5 size-3 shrink-0" />
          </button>
        )}

        {empty && <EmptyState fps={fps} onNotice={setNotice} />}

        {sets.map((s) => (
          <ReviewSet key={s.track} set={s} timeline={timeline} fps={fps} onNotice={setNotice} />
        ))}

        {showMake ? (
          <MakeOne fps={fps} onNotice={setNotice} onDone={() => setMaking(false)} />
        ) : (
          sets.length > 0 && (
            <button
              type="button"
              data-chroma-music-edits-make
              onClick={() => setMaking(true)}
              className="flex h-7 items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary"
            >
              <PlusIcon className="size-3" /> Make one yourself
            </button>
          )
        )}
      </div>
    </div>
  );
}

/** Nothing marked and nothing suggested: the first action, and the breath. */
function EmptyState({ fps, onNotice }: { fps: number; onNotice: (n: Notice) => void }) {
  return (
    <div data-chroma-music-edits-empty className="flex flex-col gap-2.5 rounded-md bg-bg-secondary p-3.5 leading-snug text-text-secondary">
      <span className="text-sm font-semibold text-text-primary">Silence the music for a moment</span>
      <span>
        Drop the music out under a punchline, give a key line a beat of silence, or keep your call to action dry. Mark
        where it stops; then where it comes back.
      </span>
      <Button
        data-chroma-music-edits-start
        onClick={() => {
          const s = useEditorTimelineStore.getState();
          s.setMarks({ inPoint: s.playhead, outPoint: null });
        }}
      >
        <CrosshairSimpleIcon /> Music stops at the playhead
        <kbd className="ml-auto rounded-sm bg-bg-primary/30 px-1 text-[10px]">I</kbd>
      </Button>
      <BreathButton fps={fps} onNotice={onNotice} />
      <span className="text-text-tertiary">Or ask your AI agent to suggest them from the story, or right-click a line in the transcript.</span>
    </div>
  );
}

function BreathButton({ fps, onNotice }: { fps: number; onNotice: (n: Notice) => void }) {
  return (
    <Button
      variant="outline"
      data-chroma-music-edits-breath
      onClick={() => {
        const b = breathBefore(useEditorTimelineStore.getState().playhead, fps);
        onNotice(
          b
            ? quickMusicEdit({ kind: 'breath', start: b.start, end: b.end })
            : { ok: false, message: 'Move the playhead past the first second to place a breath before it.' },
        );
      }}
    >
      <PauseIcon /> 1-second breath before the playhead
    </Button>
  );
}

/** One edit being made: kind, range (the timeline's In / Out marks), fades on
 *  the diagram, re-entry, then Preview / Apply / ⋯. */
function MakeOne({ fps, onNotice, onDone }: { fps: number; onNotice: (n: Notice) => void; onDone: () => void }) {
  const inPoint = useEditorTimelineStore((s) => s.inPoint);
  const outPoint = useEditorTimelineStore((s) => s.outPoint);
  const defaults = useMusicEditStore((s) => s.defaults);
  const setDefaults = useMusicEditStore((s) => s.setDefaults);
  const previewing = useMusicPreviewStore((s) => s.playing);
  const [kind, setKind] = useState<MusicEditKind>('dropout');
  const ranged = inPoint !== null && outPoint !== null && outPoint > inPoint;
  const start = inPoint ?? 0;
  const end = outPoint ?? start;

  const range = (): MusicEditRange | { error: string } => {
    const tl = useEditorTimelineStore.getState().timeline;
    if (!tl || !ranged) return { error: 'Mark where the music stops and where it comes back first.' };
    const track = musicTrackFor(tl, start, end, defaults.track);
    if ('error' in track) return track;
    return { track: track.track, start, end, fadeOutFrames: defaults.fadeOutFrames, fadeInFrames: defaults.fadeInFrames, mode: defaults.mode };
  };
  const done = (n: { ok: boolean; message: string }) => {
    onNotice(n);
    if (n.ok) {
      useEditorTimelineStore.getState().setMarks({ inPoint: null, outPoint: null });
      onDone();
    }
  };
  const playhead = () => useEditorTimelineStore.getState().playhead;
  const current = ranged ? range() : null;
  const key = current && !('error' in current) ? previewKey(current) : null;

  return (
    <div data-chroma-music-edits-maker className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="What kind">
          {MUSIC_EDIT_KINDS.map((k) => {
            const Icon = KIND_ICONS[k];
            const on = k === kind;
            return (
              <Tooltip key={k}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      role="radio"
                      aria-checked={on}
                      data-chroma-music-edits-kind={k}
                      onClick={() => setKind(k)}
                      className={`inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-xs ring-1 ring-inset ${
                        on ? 'bg-card-active text-text-primary ring-accent' : 'bg-bg-secondary text-text-secondary ring-transparent hover:text-text-primary'
                      }`}
                    >
                      <Icon className={`size-3.5 ${on ? 'text-accent-text' : 'text-text-tertiary'}`} />
                      {MUSIC_EDIT_KIND_LABELS[k]}
                    </button>
                  }
                />
                <TooltipContent>{MUSIC_EDIT_KIND_HINTS[k]}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
        <span data-chroma-music-edits-kind-hint className="-mt-0.5 text-text-tertiary">
          {MUSIC_EDIT_KIND_HINTS[kind]}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1.5">
          <TimeField
            label="Music stops here"
            value={inPoint}
            fps={fps}
            dataAttr="data-chroma-music-edits-mark-in"
            onTarget={() => useEditorTimelineStore.getState().setMarks({ inPoint: playhead() })}
            targetHint="Use the playhead (I)"
          />
          <ArrowRightIcon className="size-3 text-text-tertiary" />
          <TimeField
            label="Music is back here"
            value={outPoint}
            fps={fps}
            dataAttr="data-chroma-music-edits-mark-out"
            onTarget={() => useEditorTimelineStore.getState().setMarks({ outPoint: playhead() })}
            targetHint="Use the playhead (O)"
          />
        </div>
        <FadeDiagram
          fps={fps}
          silentFrames={ranged ? end - start : 0}
          fadeOutFrames={defaults.fadeOutFrames}
          fadeInFrames={defaults.fadeInFrames}
          onChange={(p) => setDefaults(p)}
        />
        <ModeSwitch mode={defaults.mode} onChange={(mode) => setDefaults({ mode })} />
      </div>

      <div className="flex items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon-sm"
                data-chroma-music-edits-preview
                aria-label={key !== null && previewing === key ? 'Stop the preview' : 'Preview'}
                disabled={!ranged}
                onClick={() => {
                  if (key !== null && previewing === key) {
                    useEditorTimelineStore.getState().setPlaying(false);
                    stopMusicPreview();
                    return;
                  }
                  const r = range();
                  if ('error' in r) return onNotice({ ok: false, message: r.error });
                  void previewMusicEdit(r).then((out) => {
                    if ('error' in out) onNotice({ ok: false, message: out.error });
                  });
                }}
              >
                {key !== null && previewing === key ? <StopIcon weight="fill" /> : <PlayIcon weight="fill" />}
              </Button>
            }
          />
          <TooltipContent>Preview: play from 2 s before, with the edit (nothing is changed until you apply)</TooltipContent>
        </Tooltip>
        <Button
          className="flex-1"
          data-chroma-music-edits-cut
          disabled={!ranged}
          onClick={() => {
            stopMusicPreview();
            done(quickMusicEdit({ kind, start, end }));
          }}
        >
          <CheckIcon /> Apply
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="ghost" size="icon-sm" aria-label="More" data-chroma-music-edits-more disabled={!ranged}>
                <DotsThreeIcon />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem data-chroma-music-edits-add onClick={() => done(quickMusicEdit({ kind, start, end, review: true }))}>
              Save for later
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <BreathButton fps={fps} onNotice={onNotice} />
    </div>
  );
}

/** A timecode with the playhead target inside it. */
function TimeField({
  label,
  value,
  fps,
  onTarget,
  targetHint,
  dataAttr,
}: {
  label: string;
  value: number | null;
  fps: number;
  onTarget: () => void;
  targetHint: string;
  dataAttr: string;
}) {
  return (
    <div className="flex h-7 min-w-0 items-center justify-between gap-1 rounded-sm bg-bg-secondary py-0 pr-0.5 pl-2" title={label}>
      <span className="truncate font-mono text-xs tabular-nums text-text-primary" aria-label={label}>
        {value === null ? '—' : fmtMusicTime(value, fps)}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant="ghost" size="icon-xs" aria-label={targetHint} {...{ [dataAttr]: '' }} onClick={onTarget}>
              <CrosshairSimpleIcon />
            </Button>
          }
        />
        <TooltipContent>{targetHint}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function ModeSwitch({ mode, onChange }: { mode: MusicEditMode; onChange: (m: MusicEditMode) => void }) {
  return (
    <div className="flex self-start rounded-sm bg-bg-secondary p-0.5" role="radiogroup" aria-label="When the music comes back" data-chroma-music-edits-mode>
      {(Object.keys(MODE_LABELS) as MusicEditMode[]).map((m) => (
        <Tooltip key={m}>
          <TooltipTrigger
            render={
              <button
                type="button"
                role="radio"
                aria-checked={mode === m}
                data-chroma-music-edits-mode-option={m}
                onClick={() => onChange(m)}
                className={`h-6 rounded-[3px] px-2.5 text-xs ${mode === m ? 'bg-card-active text-text-primary' : 'text-text-secondary hover:text-text-primary'}`}
              >
                {MODE_LABELS[m]}
              </button>
            }
          />
          <TooltipContent className="max-w-60">{MODE_HINTS[m]}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

/** The geometry of the fade diagram at a measured width: where the ramps
 *  and the dots sit. Pure, so the drag and the drawing agree. */
function fadeGeometry(width: number, height: number, fps: number, silentFrames: number, fadeOut: number, fadeIn: number) {
  const pad = 14;
  const top = 18;
  const bot = height - 16;
  const pre = FADE_MAX_SECONDS;
  const post = FADE_MAX_SECONDS + 0.2;
  const gap = Math.max(silentFrames / fps, 0.4);
  const span = pre + gap + post;
  const pxPerSec = (width - 2 * pad) / span;
  const x = (s: number) => pad + s * pxPerSec;
  return {
    pad,
    top,
    bot,
    pxPerFrame: pxPerSec / fps,
    x0: x(pre - fadeOut / fps),
    x1: x(pre),
    x2: x(pre + gap),
    x3: x(pre + gap + fadeIn / fps),
  };
}

/**
 * The fades, dragged on the diagram (rev. 2: no separate steppers). The level
 * line, the fade out before the silence and the fade back in after it; each dot
 * drags sideways (and takes ←/→, one frame per press). Lengths in seconds.
 */
function FadeDiagram({
  fps,
  silentFrames,
  fadeOutFrames,
  fadeInFrames,
  onChange,
}: {
  fps: number;
  silentFrames: number;
  fadeOutFrames: number;
  fadeInFrames: number;
  onChange: (p: { fadeOutFrames?: number; fadeInFrames?: number }) => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 248, height: 64 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize({ width: r.width, height: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const maxFrames = Math.round(FADE_MAX_SECONDS * fps);
  const g = fadeGeometry(size.width, size.height, fps, silentFrames, fadeOutFrames, fadeInFrames);
  const clampFrames = (n: number) => Math.max(0, Math.min(maxFrames, Math.round(n)));

  const handle = (which: 'fadeOutFrames' | 'fadeInFrames', x: number, sign: number, value: number, label: string) => (
    <span
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={maxFrames}
      aria-valuenow={value}
      aria-valuetext={`${(value / fps).toFixed(2)} s`}
      data-chroma-music-fade-handle={which === 'fadeOutFrames' ? 'out' : 'in'}
      className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full border-[1.5px] border-accent-text bg-surface hover:bg-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      style={{ left: x, top: g.top }}
      onPointerDown={(e) => {
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        const startValue = value;
        let frame = 0;
        let pending = startValue;
        const move = (ev: PointerEvent) => {
          pending = clampFrames(startValue + (sign * (ev.clientX - startX)) / g.pxPerFrame);
          if (frame) return;
          // One store write per animation frame while dragging.
          frame = requestAnimationFrame(() => {
            frame = 0;
            onChange({ [which]: pending });
          });
        };
        const up = () => {
          if (frame) cancelAnimationFrame(frame);
          onChange({ [which]: pending });
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      }}
      onKeyDown={(e) => {
        const step = e.key === 'ArrowRight' ? sign : e.key === 'ArrowLeft' ? -sign : 0;
        if (!step) return;
        e.preventDefault();
        onChange({ [which]: clampFrames(value + step) });
      }}
    />
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div ref={box} data-chroma-music-fade-diagram className="relative h-16 overflow-hidden rounded-sm bg-[var(--color-timeline-bg)]">
            <svg className="absolute inset-0 size-full" viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden>
              <rect x={g.x1} y={0} width={Math.max(0, g.x2 - g.x1)} height={size.height} fill="var(--color-selection)" opacity={0.1} />
              <line x1={g.x1} y1={0} x2={g.x1} y2={size.height} stroke="var(--color-selection)" />
              <line x1={g.x2} y1={0} x2={g.x2} y2={size.height} stroke="var(--color-selection)" />
              <line x1={g.pad} y1={g.bot} x2={size.width - g.pad} y2={g.bot} stroke="var(--color-text-tertiary)" strokeDasharray="2 3" />
              <polyline
                fill="none"
                stroke="var(--color-clip-audio-wave-ink)"
                strokeWidth={2}
                points={`${g.pad},${g.top} ${g.x0},${g.top} ${g.x1},${g.bot} ${g.x2},${g.bot} ${g.x3},${g.top} ${size.width - g.pad},${g.top}`}
              />
            </svg>
            <span className="absolute text-[10px] tabular-nums text-text-secondary" style={{ left: Math.max(2, g.x0 - 40), top: g.top + 4 }}>
              {(fadeOutFrames / fps).toFixed(2)} s
            </span>
            <span className="absolute text-[10px] tabular-nums text-text-secondary" style={{ left: (g.x1 + g.x2) / 2 - 12, top: g.bot - 15 }}>
              {silentFrames > 0 ? `${(silentFrames / fps).toFixed(1)} s` : ''}
            </span>
            <span className="absolute text-[10px] tabular-nums text-text-secondary" style={{ left: Math.min(size.width - 40, g.x3 + 6), top: g.top + 4 }}>
              {(fadeInFrames / fps).toFixed(2)} s
            </span>
            {handle('fadeOutFrames', g.x0, -1, fadeOutFrames, 'Fade out before')}
            {handle('fadeInFrames', g.x3, 1, fadeInFrames, 'Fade back in after')}
          </div>
        }
      />
      <TooltipContent>Drag the dots to change the fades</TooltipContent>
    </Tooltip>
  );
}

/** One music track's agent suggestions. */
function ReviewSet({
  set,
  timeline,
  fps,
  onNotice,
}: {
  set: MusicEditProposalSet;
  timeline: Timeline;
  fps: number;
  onNotice: (n: Notice) => void;
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
    const input = buildWordViewInput(timeline, set.wordTrack, transcripts, (p) => recoveriesIn(maps, p), transcriptErrors);
    return 'error' in input || viewBasisKey(input) !== set.basisKey;
  }, [set, timeline, transcripts, transcriptErrors, recoveries, appliedRereads]);

  const toApply = rowsToApply(set, false).filter((r) => rowProblem(timeline, r, set.track) === null);
  const pending = set.rows.filter((r) => r.status === 'pending').length;
  const fromAgent = set.rows.some((r) => r.origin === 'ai');

  return (
    <section data-chroma-music-edits-set={set.track} className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5">
        {fromAgent ? <RobotIcon className="size-3.5 text-accent-text" /> : <UserIcon className="size-3.5 text-text-secondary" />}
        <span className="flex-1 text-sm font-semibold text-text-primary">{fromAgent ? 'Suggested by your agent' : 'Saved for later'}</span>
        {pending > 0 && (
          <Button variant="ghost" size="xs" data-chroma-music-edits-accept-all onClick={() => useMusicEditStore.getState().setAllPending(set.track, 'accepted')}>
            Approve all
          </Button>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="xs" data-chroma-music-edits-dismiss onClick={() => useMusicEditStore.getState().setProposals(set.track, null)}>
                Dismiss
              </Button>
            }
          />
          <TooltipContent>Discard the list; nothing on the timeline changes</TooltipContent>
        </Tooltip>
      </div>
      {stale && (
        <p data-chroma-music-edits-stale className="flex gap-1.5 rounded-sm bg-bg-secondary px-2.5 py-2 leading-snug text-text-secondary">
          <WarningIcon weight="fill" className="mt-0.5 size-3.5 shrink-0 text-text-primary" />
          <span>The voice track changed after your agent chose these lines. Check each one before applying, or ask it to suggest again.</span>
        </p>
      )}
      <ul className="flex flex-col gap-0.5">
        {set.rows.map((row) => (
          <ReviewRow key={row.id} row={row} track={set.track} timeline={timeline} fps={fps} onNotice={onNotice} />
        ))}
      </ul>
      <Button
        data-chroma-music-edits-apply={set.track}
        disabled={toApply.length === 0}
        onClick={() => {
          stopMusicPreview();
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
        <ArrowLineDownIcon /> Apply {toApply.length} approved <span className="font-normal opacity-75">· one undo</span>
      </Button>
    </section>
  );
}

function ReviewRow({
  row,
  track,
  timeline,
  fps,
  onNotice,
}: {
  row: MusicEditRow;
  track: number;
  timeline: Timeline;
  fps: number;
  onNotice: (n: Notice) => void;
}) {
  const problem = rowProblem(timeline, row, track);
  const previewing = useMusicPreviewStore((s) => s.playing);
  const [changing, setChanging] = useState(false);
  const range = rowRange(row, track);
  const key = previewKey(range);
  const OriginIcon = row.origin === 'ai' ? RobotIcon : UserIcon;
  const patch = (p: MusicEditRowPatch) => useMusicEditStore.getState().patchRow(track, row.id, p);

  return (
    <li
      data-chroma-music-edit-row={row.id}
      data-chroma-music-edit-status={row.status}
      className={`grid grid-cols-[auto_minmax(0,1fr)_auto] gap-2 rounded-sm px-1.5 py-1.5 leading-snug hover:bg-bg-secondary ${row.status === 'rejected' ? 'opacity-50' : ''}`}
    >
      <OriginIcon className="mt-0.5 size-3.5 text-text-tertiary" aria-label={row.origin === 'ai' ? 'Suggested by your agent' : 'Made by you'} />
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 font-medium text-text-primary">
          {MUSIC_EDIT_KIND_LABELS[row.kind]}
          {row.status === 'accepted' && <span className="rounded-sm bg-card-active px-1 text-[10px] font-normal text-accent-text">Approved</span>}
          {row.status === 'rejected' && <span className="rounded-sm bg-card-active px-1 text-[10px] font-normal text-text-secondary">Skipped</span>}
        </div>
        {row.text && <div className="text-text-primary">“{row.text}”</div>}
        {row.reason && <div className="text-text-secondary">{row.reason}</div>}
        <button
          type="button"
          data-chroma-music-edit-jump={row.id}
          className="font-mono text-[11px] tabular-nums text-text-secondary hover:text-text-primary"
          title="Go to where the music stops"
          onClick={() => useEditorTimelineStore.getState().setPlayhead(Math.max(0, row.start))}
        >
          {fmtMusicTime(row.start, fps)} → {fmtMusicTime(row.end, fps)}{' '}
          <span className="text-text-tertiary">({((row.end - row.start) / fps).toFixed(1)} s)</span>
        </button>
        {problem && (
          <div data-chroma-music-edit-problem={row.id} className="mt-0.5 text-destructive">
            {problem}
          </div>
        )}
        {changing && (
          <div className="mt-2 flex flex-col gap-2" data-chroma-music-edit-change={row.id}>
            <FadeDiagram
              fps={fps}
              silentFrames={row.end - row.start}
              fadeOutFrames={row.fadeOutFrames}
              fadeInFrames={row.fadeInFrames}
              onChange={(p) => patch(p)}
            />
            <ModeSwitch mode={row.mode ?? 'continuous'} onChange={(mode) => patch({ mode })} />
          </div>
        )}
      </div>
      <div className="flex gap-0.5">
        <Button
          variant="ghost"
          size="icon-xs"
          data-chroma-music-edit-audition={row.id}
          aria-label={previewing === key ? 'Stop the preview' : 'Preview from 2 s before'}
          title={previewing === key ? 'Stop the preview' : 'Preview from 2 s before'}
          disabled={problem !== null}
          onClick={() => {
            if (previewing === key) {
              useEditorTimelineStore.getState().setPlaying(false);
              stopMusicPreview();
              return;
            }
            void previewMusicEdit(range).then((out) => {
              if ('error' in out) onNotice({ ok: false, message: out.error });
            });
          }}
        >
          {previewing === key ? <StopIcon weight="fill" /> : <PlayIcon />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-pressed={changing}
          data-chroma-music-edit-pencil={row.id}
          title="Change the fades and how the music comes back"
          onClick={() => setChanging((c) => !c)}
        >
          <PencilSimpleIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          data-chroma-music-edit-accept={row.id}
          aria-pressed={row.status === 'accepted'}
          disabled={problem !== null}
          onClick={() => useMusicEditStore.getState().setRowStatus(track, row.id, row.status === 'accepted' ? 'pending' : 'accepted')}
          title={problem ? 'This edit cannot land as it stands' : row.status === 'accepted' ? 'Undo approve' : 'Approve'}
          className={row.status === 'accepted' ? 'text-accent-text' : 'text-text-secondary'}
        >
          <CheckIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          data-chroma-music-edit-reject={row.id}
          aria-pressed={row.status === 'rejected'}
          onClick={() => useMusicEditStore.getState().setRowStatus(track, row.id, row.status === 'rejected' ? 'pending' : 'rejected')}
          title={row.status === 'rejected' ? 'Undo skip' : 'Skip'}
          className={row.status === 'rejected' ? 'text-destructive' : 'text-text-secondary'}
        >
          <XIcon />
        </Button>
      </div>
    </li>
  );
}
