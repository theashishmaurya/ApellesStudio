/**
 * `@apelles/editor` — the Clipper's surface in the viewer area: New shorts, the
 * reading / waiting states, and the review of one short (D-443, B-363).
 *
 * **What it is.** The approved mockup's right-hand half
 * (`scratch/panel-redesign-mockup.html`, "Clipper"): the owner decided the
 * review lives in the viewer area while the Shorts tab is active (2026-11-03).
 * `EditorTab` lays it over the viewer when `useClipperStore.surface` is open;
 * the viewer stays mounted underneath and comes back on close (×, or Esc).
 *
 * - **New shorts** — From, Length chips (15 / 30 / 60 / 90 s), How many, Frame
 *   as three shape buttons, Captions, About (optional) and More options
 *   (strongest line first, trim long pauses, leave out flubbed takes, only from
 *   … to …: `editor_auto_clip`'s `hook_first` / `tighten_dead_air` /
 *   `tighten_retakes` / `range_start_s` / `range_end_s`), Find moments.
 * - **Reading the video** / **Ready for your AI agent** — the steps in words,
 *   and the request to paste to the agent (the app never picks, D-411).
 * - **The review** — the short's opening frame in its shape with the opening
 *   line as a caption, "Show this moment in the source" (a timeline source) or
 *   Open (a made short); its title (rename), length against the target, where
 *   it comes from and the clean-cut check; "Opens with" and "Why your agent
 *   picked it"; the check's warnings in words with what to try; "What's in it",
 *   the transcript with left-out sentences crossed out, the opening line tinted
 *   and trimmed pauses as chips; Start / End ‹ Earlier · Later › (whole
 *   sentences, re-gated); "Other moments the analysis found" and "Details";
 *   Skip (X), Approve (A), ↑ / ↓.
 *
 * **What it does NOT do.** Play a short that is not made yet: until it is built
 * it is a list of source ranges, not a timeline (the poster shows its opening
 * frame; "Show this moment in the source" plays it on the long timeline, and a
 * made short opens and plays as its own timeline). Every action is a function
 * the MCP ops call (`clipperOps.ts`); nothing here judges a moment.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CaretUpIcon,
  CheckCircleIcon,
  CheckIcon,
  CircleIcon,
  CircleNotchIcon,
  ClockIcon,
  CopyIcon,
  CrosshairSimpleIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  RobotIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import {
  Button,
  Input,
  Progress,
  ScrubbableNumberInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@apelles/ui';
import { useMediaPoolStore } from '@apelles/bridge';

import { CAPTION_PRESETS } from '../captionPresets';
import { useMediaUnderstandingStore } from '../mediaUnderstandingStore';
import { useEditorTimelineStore } from '../timelineStore';
import { DEFAULT_COUNT, DEFAULT_DURATIONS, jumpToSource, openShort, setClipProposal, startAutoClip } from './clipperOps';
import { useClipperStore, type RunAnalysis } from './clipperStore';
import { moveReview, onClipperReviewKey, reviewShort } from './clipperReview';
import { useShortPoster } from './clipperPoster';
import { ALLOWED_DURATIONS, ASPECTS, MAX_CLIP_COUNT, type Aspect, type CandidateDto, type ClipRun } from './clipperTypes';
import {
  askPrompt,
  checkChip,
  checkSentences,
  fmtClock,
  runIsReading,
  runTitle,
  scriptLines,
  shortSeconds,
  sourceSpan,
  targetLine,
  trimmedCuts,
} from './clipperView';

const notify = (n: { ok: boolean; message: string }) => useClipperStore.getState().setNotice(n);

const ASPECT_LABEL: Record<Aspect, string> = { '9:16': 'Vertical 9:16', '1:1': 'Square 1:1', '4:5': 'Portrait 4:5' };
/** The frame-shape icon's box, px (width × height). */
const ASPECT_BOX: Record<Aspect, [number, number]> = { '9:16': [14, 24], '1:1': [20, 20], '4:5': [18, 22] };
const ASPECT_CLASS: Record<Aspect, string> = { '9:16': 'aspect-[9/16]', '1:1': 'aspect-square', '4:5': 'aspect-[4/5]' };

/** The surface, laid over the viewer by `EditorTab`. */
export function ClipperSurface() {
  const surface = useClipperStore((s) => s.surface);
  const run = useClipperStore((s) => (s.activeRunId ? s.runs[s.activeRunId] : undefined));
  const box = useRef<HTMLDivElement | null>(null);
  // Focus comes here when the surface opens, so A / X / ↑ / ↓ and Esc work at
  // once without a click.
  useEffect(() => {
    box.current?.focus({ preventScroll: true });
  }, [surface]);
  if (surface === 'closed') return null;
  return (
    <div
      ref={box}
      tabIndex={-1}
      data-chroma-clipper-surface={surface}
      className="absolute inset-0 z-20 flex min-h-0 flex-col bg-bg-primary outline-none"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
          e.preventDefault();
          useClipperStore.getState().closeSurface();
          return;
        }
        onClipperReviewKey(e, notify);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Close and show the viewer"
              data-chroma-clipper-close
              className="absolute top-2 right-2 z-10"
              onClick={() => useClipperStore.getState().closeSurface()}
            >
              <XIcon />
            </Button>
          }
        />
        <TooltipContent>Close and show the viewer (Esc)</TooltipContent>
      </Tooltip>
      {surface === 'setup' || !run ? <SetupForm /> : <RunSurface run={run} />}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── New shorts

function SetupForm() {
  const media = useMediaPoolStore((s) => s.items);
  const timelines = useEditorTimelineStore((s) => s.timelines);
  const sources = useMemo(
    () => [
      ...timelines.filter((t) => !t.origin).map((t) => ({ key: `t:${t.id}`, label: `Timeline · ${t.name}`, secs: t.fps ? t.duration / t.fps : null })),
      ...media.filter((m) => m.video && !m.offline).map((m) => ({ key: `m:${m.id}`, label: `${m.video?.width ? 'Video' : 'Audio'} · ${m.name}`, secs: m.video?.durationSecs ?? null })),
    ],
    [media, timelines],
  );
  const [source, setSource] = useState('');
  const [durations, setDurations] = useState<number[]>(DEFAULT_DURATIONS);
  const [count, setCount] = useState(DEFAULT_COUNT);
  const [aspect, setAspect] = useState<Aspect>('9:16');
  const [captions, setCaptions] = useState('brand');
  const [focus, setFocus] = useState('');
  const [more, setMore] = useState(false);
  const [hookFirst, setHookFirst] = useState(true);
  const [deadAir, setDeadAir] = useState(true);
  const [retakes, setRetakes] = useState(true);
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen = source || sources[0]?.key || '';
  const picked = sources.find((s) => s.key === chosen);
  const captionsLabel =
    captions === 'brand' ? "Your brand kit's captions" : captions === 'none' ? 'No captions' : (CAPTION_PRESETS.find((p) => p.id === captions)?.label ?? captions);

  const find = async () => {
    if (!chosen) return;
    const range = parseRange(rangeFrom, rangeTo);
    if ('error' in range) return notify({ ok: false, message: range.error });
    setBusy(true);
    const [kind, id] = [chosen.slice(0, 1), chosen.slice(2)];
    const out = await startAutoClip({
      ...(kind === 't' ? { timelineId: id } : { mediaId: id }),
      durations,
      count,
      aspect,
      captions,
      hookFirst,
      tightenDeadAir: deadAir,
      tightenRetakes: retakes,
      ...range.args,
      ...(focus.trim() ? { focus: focus.trim() } : {}),
    });
    setBusy(false);
    if ('error' in out) return notify({ ok: false, message: out.error });
    useClipperStore.getState().openSurface('run');
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-chroma-clipper-setup>
      <div className="mx-auto flex max-w-[520px] flex-col gap-3.5 px-6 py-8 text-sm">
        <div>
          <p className="text-lg font-semibold text-text-primary">New shorts</p>
          <p className="mt-1 leading-relaxed text-text-secondary">
            Apelles reads the video and finds every clean place to cut. Your AI agent picks the best moments. You review them here and make the ones you like.
          </p>
        </div>
        <Row label="From">
          <Select value={chosen} onValueChange={(v) => v && setSource(v)}>
            <SelectTrigger data-chroma-clipper-source className="data-[size=default]:h-7 w-full text-sm" aria-label="From" title={picked?.label}>
              <SelectValue>
                {picked ? (
                  <span className="truncate">
                    {picked.label}
                    {picked.secs ? <span className="text-text-tertiary"> ({fmtClock(picked.secs)})</span> : null}
                  </span>
                ) : (
                  'Import a video first'
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {sources.map((s) => (
                <SelectItem key={s.key} value={s.key}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <Row label="Length">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Length">
            {ALLOWED_DURATIONS.map((d) => {
              const on = durations.includes(d);
              return (
                <button
                  type="button"
                  key={d}
                  aria-pressed={on}
                  data-chroma-clipper-duration={d}
                  onClick={() => setDurations((cur) => (on ? (cur.length > 1 ? cur.filter((x) => x !== d) : cur) : [...cur, d].sort((a, b) => a - b)))}
                  className={`h-7 rounded-full px-3 text-xs ring-1 ring-inset ${on ? 'bg-card-active text-text-primary ring-accent' : 'bg-bg-secondary text-text-secondary ring-transparent hover:text-text-primary'}`}
                >
                  {d} s
                </button>
              );
            })}
          </div>
        </Row>
        <Row label="How many">
          <div className="flex items-center gap-2">
            <ScrubbableNumberInput
              aria-label="How many shorts"
              className="h-7 w-16 text-sm"
              value={count}
              min={1}
              max={MAX_CLIP_COUNT}
              step={1}
              onValueChange={(v) => setCount(Math.min(MAX_CLIP_COUNT, Math.max(1, Math.round(v))))}
            />
            <span className="text-xs text-text-tertiary">up to {MAX_CLIP_COUNT}</span>
          </div>
        </Row>
        <Row label="Frame">
          <div className="flex gap-1.5" role="radiogroup" aria-label="Frame">
            {ASPECTS.map((a) => {
              const [w, h] = ASPECT_BOX[a];
              const on = a === aspect;
              return (
                <button
                  type="button"
                  key={a}
                  role="radio"
                  aria-checked={on}
                  data-chroma-clipper-aspect={a}
                  onClick={() => setAspect(a)}
                  className={`flex h-9 items-center gap-2 rounded-md px-2.5 text-xs ring-1 ring-inset ${on ? 'bg-card-active text-text-primary ring-accent' : 'bg-bg-secondary text-text-secondary ring-transparent hover:text-text-primary'}`}
                >
                  <span className={`rounded-[2px] border-[1.5px] ${on ? 'border-accent-text' : 'border-text-tertiary'}`} style={{ width: w, height: h }} />
                  {ASPECT_LABEL[a]}
                </button>
              );
            })}
          </div>
        </Row>
        <Row label="Captions">
          <Select value={captions} onValueChange={(v) => v && setCaptions(v)}>
            <SelectTrigger className="data-[size=default]:h-7 w-full text-sm" aria-label="Captions" title={captionsLabel}>
              <SelectValue>{captionsLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="brand">Your brand kit&apos;s captions</SelectItem>
              <SelectItem value="none">No captions</SelectItem>
              {CAPTION_PRESETS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <Row label="About" hint="optional" top>
          <Textarea
            className="min-h-14 text-sm"
            aria-label="What should the shorts be about"
            placeholder="What should the shorts be about? e.g. “the pricing discussion”"
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
          />
        </Row>
        <div>
          <Disclosure open={more} onToggle={() => setMore((m) => !m)} label="More options" data="data-chroma-clipper-more" />
          {more && (
            <div className="flex flex-col gap-2 pt-1 pl-4">
              <Toggle checked={hookFirst} onChange={setHookFirst} label="Open with the strongest line, even if it comes later" />
              <Toggle checked={deadAir} onChange={setDeadAir} label="Trim long pauses" />
              <Toggle checked={retakes} onChange={setRetakes} label="Leave out flubbed takes" />
              <Row label="Only from">
                <div className="flex items-center gap-1.5">
                  <Input className="h-7 w-20 text-sm tabular-nums" aria-label="Only from" placeholder="0:00" value={rangeFrom} onChange={(e) => setRangeFrom(e.target.value)} />
                  <span className="text-text-tertiary">to</span>
                  <Input
                    className="h-7 w-20 text-sm tabular-nums"
                    aria-label="Only to"
                    placeholder={picked?.secs ? fmtClock(picked.secs) : 'end'}
                    value={rangeTo}
                    onChange={(e) => setRangeTo(e.target.value)}
                  />
                </div>
              </Row>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => useClipperStore.getState().closeSurface()}>
            Cancel
          </Button>
          <Button disabled={!chosen || busy} data-chroma-clipper-analyse onClick={() => void find()}>
            <MagnifyingGlassIcon /> {busy ? 'Starting…' : 'Find moments'}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** `m:ss` / `h:mm:ss` / plain seconds → seconds. */
function parseClock(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return Number.NaN;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** "Only from … to …" as `range_start_s` / `range_end_s`, or why not. */
function parseRange(from: string, to: string): { args: Record<string, number> } | { error: string } {
  const a = parseClock(from);
  const b = parseClock(to);
  if (a === null && b === null) return { args: {} };
  if (Number.isNaN(a) || Number.isNaN(b)) return { error: 'Write "only from … to …" as minutes:seconds, e.g. 2:30.' };
  if (b === null) return { error: 'Give where the range ends, too.' };
  if ((a ?? 0) >= b) return { error: 'The range must end after it starts.' };
  return { args: { rangeStartS: a ?? 0, rangeEndS: b } };
}

function Row({ label, hint, top, children }: { label: string; hint?: string; top?: boolean; children: React.ReactNode }) {
  return (
    <div className={`grid grid-cols-[96px_minmax(0,1fr)] gap-3 ${top ? 'items-start' : 'items-center'}`}>
      <span className={`text-sm text-text-secondary ${top ? 'pt-1.5' : ''}`}>
        {label}
        {hint && <span className="text-text-tertiary"> ({hint})</span>}
      </span>
      {children}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2 text-sm text-text-primary">
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
      {label}
    </label>
  );
}

function Disclosure({ open, onToggle, label, data, count }: { open: boolean; onToggle: () => void; label: string; data: string; count?: number }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      {...{ [data]: '' }}
      onClick={onToggle}
      className="flex h-7 w-full items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary"
    >
      {open ? <CaretDownIcon className="size-2.5" /> : <CaretRightIcon className="size-2.5" />}
      {label}
      {count !== undefined && <span className="font-normal text-text-tertiary">({count})</span>}
    </button>
  );
}

// ───────────────────────────────────────────────────────────── a run

function RunSurface({ run }: { run: ClipRun }) {
  const analysis = useClipperStore((s) => s.analyses[run.id]);
  const transcribing = useMediaUnderstandingStore((s) => s.transcribing);
  const reading = runIsReading(analysis, transcribing);
  if (run.proposals.length === 0) return <Waiting run={run} reading={reading} />;
  return <Review run={run} analysis={analysis} />;
}

/** Reading the video, or ready for the agent: the steps and the request. */
function Waiting({ run, reading }: { run: ClipRun; reading: boolean }) {
  const partials = useMediaUnderstandingStore((s) => s.partialTranscripts);
  const analysis = useClipperStore((s) => s.analyses[run.id]);
  const partial = run.source.kind === 'media' ? partials[run.source.path] : undefined;
  const pct = partial && partial.durationSecs > 0 ? (partial.coveredSecs / partial.durationSecs) * 100 : null;
  const evidence = analysis?.wire.evidence ?? [];
  const picture = evidence.length > 0 && evidence.every((e) => e.scenes.state === 'done' || e.scenes.state === 'error');
  const transcribed = !!analysis && !analysis.provisional;
  const prompt = askPrompt(run);
  const step = (done: boolean, active: boolean, text: string, extra?: string) => (
    <div className="flex items-center gap-2 text-sm text-text-primary">
      {done ? (
        <CheckCircleIcon weight="fill" className="size-4 text-accent-text" />
      ) : active ? (
        <CircleNotchIcon className="size-4 animate-spin text-accent-text" />
      ) : (
        <CircleIcon className="size-4 text-text-tertiary" />
      )}
      <span className={done || active ? '' : 'text-text-secondary'}>{text}</span>
      {extra && <span className="text-text-tertiary">{extra}</span>}
    </div>
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-chroma-clipper-ask>
      <div className="mx-auto flex max-w-[520px] flex-col gap-3.5 px-6 py-8">
        <p className="text-lg font-semibold text-text-primary">{reading ? `Reading ${run.source.name}` : 'Ready for your AI agent'}</p>
        {reading && <Progress value={pct ?? 10} />}
        <div className="flex flex-col gap-2">
          {step(transcribed || !!partial, !transcribed && !partial && reading, 'Transcribed the speech')}
          {step(transcribed, reading && !!partial, 'Finding sentences, topics and clean places to cut', partial ? `${fmtClock(partial.coveredSecs)} of ${fmtClock(partial.durationSecs)}` : undefined)}
          {step(picture, transcribed && !picture && reading, 'Checking the picture for scene changes')}
          {step(false, false, 'Your AI agent picks the moments')}
        </div>
        <div className="flex flex-col gap-2 rounded-md bg-bg-secondary p-3 text-sm leading-snug text-text-secondary">
          <span className="flex gap-2">
            <RobotIcon className="mt-0.5 size-4 shrink-0 text-accent-text" />
            <span>Your AI agent picks the moments; Apelles never picks on its own. Ask it in Claude Code, or any app connected to Apelles:</span>
          </span>
          <p className="rounded-sm bg-bg-primary p-2 font-mono text-xs text-text-primary">{prompt}</p>
          <span>
            <Button
              variant="outline"
              size="sm"
              data-chroma-clipper-copy
              onClick={() => {
                void navigator.clipboard
                  .writeText(prompt)
                  .then(() => notify({ ok: true, message: 'Copied. Paste it to your agent.' }))
                  .catch(() => notify({ ok: false, message: 'Could not copy; select the text instead.' }));
              }}
            >
              <CopyIcon /> Copy the request
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}

const CHIP_TONE = { ok: 'text-accent-text', warn: 'text-text-primary', bad: 'text-destructive' } as const;

/** The review of the selected short. */
function Review({ run, analysis }: { run: ClipRun; analysis: RunAnalysis | undefined }) {
  const selectedId = useClipperStore((s) => s.selectedProposalId);
  const p = run.proposals.find((x) => x.id === selectedId) ?? run.proposals[0];
  const poster = useShortPoster(analysis, p);
  const sentences = analysis?.wire.analysis?.sentences ?? [];
  const [renaming, setRenaming] = useState<string | null>(null);
  const [moments, setMoments] = useState(false);
  const [details, setDetails] = useState(false);
  if (!p) return null;
  const index = run.proposals.indexOf(p);
  const secs = shortSeconds(p);
  const span = sourceSpan(p, sentences);
  const chip = checkChip(p);
  const warnings = checkSentences(p);
  const lines = scriptLines(p, sentences);
  const cuts = trimmedCuts(p);
  const set = async (args: Record<string, unknown>) => {
    const out = await setClipProposal({ runId: run.id, id: p.id, ...args });
    if ('error' in out) notify({ ok: false, message: out.error });
    else if (out.note) notify({ ok: true, message: out.note });
  };
  const first = p.verdict.verdict === 'refused' ? undefined : sentences[p.verdict.resolved.first_sentence];
  const refused = p.verdict.verdict === 'refused';
  const built = p.status === 'built';

  return (
    <div className="flex min-h-0 flex-1 flex-wrap gap-0 overflow-y-auto" data-chroma-clipper-review={p.id}>
      {/* The short's frame. */}
      <div className="flex w-[300px] shrink-0 grow flex-col items-center gap-2 border-r border-border-color bg-surface px-5 py-6 lg:grow-0">
        <div className={`relative w-full max-w-[220px] ${ASPECT_CLASS[run.settings.aspect]} overflow-hidden rounded-md bg-bg-primary`}>
          {poster && <img src={poster} alt={`The opening frame of ${p.title}`} className="absolute inset-0 size-full object-cover" />}
          {p.hook_line && (
            <span className="absolute inset-x-3 bottom-[18%] text-center text-sm leading-tight font-bold text-text-primary [text-shadow:0_1px_3px_var(--color-bg-primary)]">
              {p.hook_line}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-text-secondary">
          <span className="font-mono text-sm tabular-nums text-text-primary">{secs !== null ? fmtClock(secs) : '—'}</span>
          {run.source.kind === 'timeline' && first && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Show this moment in the source timeline"
                    data-chroma-clipper-jump
                    onClick={async () => {
                      const out = await jumpToSource(run, first.piece, first.startSecs);
                      if ('error' in out) return notify({ ok: false, message: out.error });
                      useClipperStore.getState().closeSurface();
                    }}
                  >
                    <CrosshairSimpleIcon />
                  </Button>
                }
              />
              <TooltipContent>Show this moment in the source timeline</TooltipContent>
            </Tooltip>
          )}
          {p.timeline_id && (
            <Button
              variant="outline"
              size="sm"
              data-chroma-clipper-open={p.id}
              onClick={async () => {
                const out = await openShort(p.timeline_id ?? '');
                if ('error' in out) return notify({ ok: false, message: out.error });
                useClipperStore.getState().closeSurface();
              }}
            >
              <ArrowSquareOutIcon /> Open
            </Button>
          )}
        </div>
      </div>

      {/* The detail. */}
      <div className="flex min-w-[300px] flex-1 flex-col">
        <div className="flex flex-col gap-1.5 px-6 pt-5 pr-12 pb-3">
          {renaming !== null ? (
            <Input
              autoFocus
              aria-label="Title"
              data-chroma-clipper-title-input
              className="h-8 text-lg font-semibold"
              value={renaming}
              onChange={(e) => setRenaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const t = renaming.trim();
                  setRenaming(null);
                  if (t && t !== p.title) void set({ title: t });
                } else if (e.key === 'Escape') {
                  e.stopPropagation();
                  setRenaming(null);
                }
              }}
              onBlur={() => {
                const t = renaming.trim();
                setRenaming(null);
                if (t && t !== p.title) void set({ title: t });
              }}
            />
          ) : (
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 truncate text-lg font-semibold text-text-primary" data-chroma-clipper-title>
                {p.title}
              </span>
              <Button variant="ghost" size="icon-xs" aria-label="Rename" data-chroma-clipper-rename onClick={() => setRenaming(p.title)}>
                <PencilSimpleIcon />
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-secondary">
            <span className="flex items-center gap-1">
              <ClockIcon className="size-3.5" /> {secs !== null ? `${Math.round(secs)} s` : '—'}
              <span className="text-text-tertiary">({targetLine(run)})</span>
            </span>
            {span && (
              <>
                <span>·</span>
                <span>
                  from {fmtClock(span.start)} to {fmtClock(span.end)} in {run.source.name}
                </span>
              </>
            )}
            <span>·</span>
            <span className={`rounded-sm bg-bg-secondary px-1 ${CHIP_TONE[chip.tone]}`}>{chip.label}</span>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3.5 px-6 pb-4">
          <div className="grid grid-cols-2 gap-2">
            <Box title="Opens with" text={p.hook_line ? `“${p.hook_line}”` : (lines.find((l) => l.kind !== 'out')?.text ?? '—')} />
            <Box title="Why your agent picked it" text={p.reason} />
          </div>
          {warnings && (
            <div data-chroma-clipper-warning className={`flex gap-2 rounded-sm bg-bg-secondary px-3 py-2 text-sm leading-snug ${refused ? 'text-destructive' : 'text-text-secondary'}`}>
              <WarningIcon weight="fill" className="mt-0.5 size-4 shrink-0" />
              <span>{warnings.join(' ')}</span>
            </div>
          )}
          {lines.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center">
                <span className="flex-1 text-xs font-semibold text-text-secondary">What&apos;s in it</span>
                <span className="text-[11px] text-text-tertiary">Crossed out = left out · tinted = the opening line</span>
              </div>
              <div className="flex flex-col gap-1 rounded-sm bg-surface p-3 text-sm leading-relaxed" data-chroma-clipper-script>
                {lines.map((l) => (
                  <span
                    key={l.index}
                    data-chroma-clipper-line={l.kind}
                    className={l.kind === 'out' ? 'text-text-tertiary line-through' : l.kind === 'hook' ? 'rounded-sm bg-card-active px-1 text-text-primary' : 'text-text-primary'}
                  >
                    {l.text}
                  </span>
                ))}
                {cuts.length > 0 && (
                  <span className="mt-1 flex flex-wrap gap-1">
                    {cuts.map((c, i) => (
                      <span key={i} className="rounded-full bg-bg-secondary px-2 text-[11px] text-text-secondary">
                        {c.kind === 'dead_air' ? 'pause trimmed' : 'flubbed take left out'} · {c.secs.toFixed(1)} s
                      </span>
                    ))}
                  </span>
                )}
              </div>
            </div>
          )}
          {!built && (
            <div className="flex flex-wrap items-center gap-3">
              <EdgeGroup
                label="Start"
                onEarlier={() => void set({ extendStart: 1 })}
                onLater={() => void set({ extendStart: -1 })}
                earlierHint="Start one sentence earlier"
                laterHint="Start one sentence later"
                disabled={refused && !p.shape.segments.length}
              />
              <EdgeGroup
                label="End"
                onEarlier={() => void set({ extendEnd: -1 })}
                onLater={() => void set({ extendEnd: 1 })}
                earlierHint="End one sentence earlier"
                laterHint="End one sentence later"
                disabled={refused && !p.shape.segments.length}
              />
            </div>
          )}
          <div>
            <Disclosure
              open={moments}
              onToggle={() => setMoments((m) => !m)}
              label="Other moments the analysis found"
              data="data-chroma-clipper-moments"
              count={analysis?.wire.analysis?.candidates.length ?? 0}
            />
            {moments && <Moments run={run} candidates={analysis?.wire.analysis?.candidates ?? []} analysis={analysis} />}
            <Disclosure open={details} onToggle={() => setDetails((d) => !d)} label="Details" data="data-chroma-clipper-details" />
            {details && <RunDetails run={run} analysis={analysis} />}
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-border-color px-6 py-3">
          {!built && (
            <>
              <Button variant="outline" data-chroma-clipper-skip onClick={() => void reviewShort(run, p.id, 'skip', notify)}>
                <XIcon /> {p.status === 'rejected' ? 'Undo skip' : 'Skip'} <kbd className="text-[10px] text-text-tertiary">X</kbd>
              </Button>
              <Button data-chroma-clipper-approve disabled={refused && p.status !== 'accepted'} onClick={() => void reviewShort(run, p.id, 'approve', notify)}>
                <CheckIcon /> {p.status === 'accepted' ? 'Undo approve' : 'Approve'} <kbd className="text-[10px] opacity-75">A</kbd>
              </Button>
            </>
          )}
          <span className="flex-1" />
          <span className="text-xs text-text-tertiary" data-chroma-clipper-position>
            {index + 1} of {run.proposals.length}
          </span>
          <Button variant="ghost" size="icon-sm" aria-label="Previous short (↑)" title="Previous short (↑)" disabled={index === 0} onClick={() => moveReview(-1)}>
            <CaretUpIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next short (↓)"
            title="Next short (↓)"
            disabled={index === run.proposals.length - 1}
            onClick={() => moveReview(1)}
          >
            <CaretDownIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}

function Box({ title, text }: { title: string; text: string }) {
  return (
    <div className="rounded-sm bg-bg-secondary px-3 py-2">
      <div className="text-[11px] font-semibold text-text-tertiary">{title}</div>
      <div className="mt-0.5 text-sm leading-snug text-text-primary">{text}</div>
    </div>
  );
}

function EdgeGroup({
  label,
  onEarlier,
  onLater,
  earlierHint,
  laterHint,
  disabled,
}: {
  label: string;
  onEarlier: () => void;
  onLater: () => void;
  earlierHint: string;
  laterHint: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1 rounded-sm bg-bg-secondary p-0.5" data-chroma-clipper-edge={label.toLowerCase()}>
      <span className="px-1.5 text-xs text-text-secondary">{label}</span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant="ghost" size="xs" disabled={disabled} data-chroma-clipper-earlier={label.toLowerCase()} onClick={onEarlier}>
              <CaretLeftIcon /> Earlier
            </Button>
          }
        />
        <TooltipContent>{earlierHint}. Moves by whole sentences, so a cut never lands mid-word.</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant="ghost" size="xs" disabled={disabled} data-chroma-clipper-later={label.toLowerCase()} onClick={onLater}>
              Later <CaretRightIcon />
            </Button>
          }
        />
        <TooltipContent>{laterHint}. Moves by whole sentences, so a cut never lands mid-word.</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** Every clean, in-length window the analysis found: evidence, not picks. */
function Moments({ run, candidates, analysis }: { run: ClipRun; candidates: CandidateDto[]; analysis: RunAnalysis | undefined }) {
  const [target, setTarget] = useState<number | null>(null);
  const sentences = analysis?.wire.analysis?.sentences ?? [];
  const shown = target === null ? candidates : candidates.filter((c) => c.targetSecs === target);
  return (
    <div className="flex flex-col gap-1 pb-2 pl-4" data-chroma-clipper-candidates>
      <div className="flex gap-1">
        {[null, ...run.settings.durations].map((d) => (
          <Button key={d ?? 'all'} size="xs" variant={target === d ? 'secondary' : 'ghost'} onClick={() => setTarget(d)}>
            {d === null ? 'All' : `${d} s`}
          </Button>
        ))}
      </div>
      {shown.length === 0 && <p className="text-xs text-text-secondary">None yet.</p>}
      {shown.slice(0, 40).map((c) => {
        const s = sentences[c.firstSentence];
        return (
          <div key={`${c.id}-${c.targetSecs}`} className="flex items-start gap-2 rounded-sm px-2 py-1.5 hover:bg-bg-secondary">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-text-primary">“{s?.text}”</div>
              <div className="text-xs text-text-secondary">
                {s ? fmtClock(s.startSecs) : ''} · {Math.round(c.tightSecs)} s{c.tags.length > 0 ? ` · ${c.tags.join(' · ')}` : ''}
              </div>
            </div>
            {run.source.kind === 'timeline' && s && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label="Show this moment in the source timeline"
                onClick={async () => {
                  const out = await jumpToSource(run, s.piece, s.startSecs);
                  if ('error' in out) return notify({ ok: false, message: out.error });
                  useClipperStore.getState().closeSurface();
                }}
              >
                <CrosshairSimpleIcon />
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The run's settings and the analysis's own numbers, in words. */
function RunDetails({ run, analysis }: { run: ClipRun; analysis: RunAnalysis | undefined }) {
  const w = analysis?.wire;
  const parts = [
    `Source: ${run.source.kind === 'timeline' ? 'timeline' : 'file'} “${run.source.name}”`,
    w ? `${w.totalSentences} sentence${w.totalSentences === 1 ? '' : 's'} in ${w.topics} topic${w.topics === 1 ? '' : 's'}` : null,
    w ? `${w.candidates} clean place${w.candidates === 1 ? '' : 's'} to cut` : null,
    w && w.evidence.length > 0 ? (w.evidence.every((e) => e.scenes.state === 'done') ? 'picture checked' : 'picture not checked yet') : null,
    run.settings.focus ? `about: “${run.settings.focus}”` : null,
    `${run.settings.count} short${run.settings.count === 1 ? '' : 's'} asked for`,
  ].filter((x): x is string => x !== null);
  return (
    <p className="pb-2 pl-4 text-xs leading-relaxed text-text-secondary" data-chroma-clipper-run-details>
      {parts.join(' · ')}
    </p>
  );
}
