/**
 * `@apelles/editor` — the Clipper library panel: shorts from a long source,
 * analysed here, judged by the person's AI agent, reviewed and built here
 * (D-411 Phases 1-2).
 *
 * **What it is.** The `clipper` `EditLibraryMode`, top to bottom:
 *
 * - **Run** — the runs of this project (each a source and its settings,
 *   persisted in `clips/`), and a new run's setup: the source (a media file or
 *   a timeline), target lengths as chips (Opus Clip's length bands mapped onto
 *   reel lengths), how many, the frame, captions (the project's brand kit by
 *   default), an optional focus, and Analyse.
 * - **Status** — the transcript's windows as they land, the audio and picture
 *   passes, and what the analysis found.
 * - **Proposals** (top of a vertical resizable split) — the agent's shorts,
 *   each with the gate's verdict and reasons, its title, why, its length and
 *   sentences; accept / reject, move either edge by a sentence (re-gated),
 *   jump to the moment in the source, open the built short; Build. When there
 *   are none: how to ask the agent (owner decision, D-411: the MCP client is
 *   the only judge — this panel never picks a moment).
 * - **Candidates** (bottom) — every clean, in-length window the analysis
 *   found, by topic, with its evidence tags: what the agent reads, shown to
 *   the person as the same evidence. Not a ranking.
 *
 * The layout follows the research (`scratch/clipper-reference/NOTES.md`):
 * Descript's "clips are compositions in the same project" (the open-short
 * button), Opus Clip's reasons-with-the-pick (made explainable: every tag
 * reads back to words) and its "add a section" (the edge nudges). The full
 * review board with posters and keyboard review is Phase 4.
 *
 * **What it does NOT do.** Any logic of its own: every button is a function
 * the MCP ops call (`clipperOps.ts`). It never subscribes to the playhead.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowSquareOutIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CheckIcon,
  CopyIcon,
  CrosshairSimpleIcon,
  FilmSlateIcon,
  HammerIcon,
  RobotIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import {
  Button,
  Input,
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
import { useMediaPoolStore } from '@apelles/bridge';

import { CAPTION_PRESETS } from '../captionPresets';
import { useMediaUnderstandingStore } from '../mediaUnderstandingStore';
import { useEditorTimelineStore } from '../timelineStore';
import {
  analyseRun,
  autoClipStatus,
  buildClips,
  DEFAULT_COUNT,
  DEFAULT_DURATIONS,
  jumpToSource,
  openShort,
  setClipProposal,
  startAutoClip,
} from './clipperOps';
import { useClipperStore } from './clipperStore';
import { ALLOWED_DURATIONS, ASPECTS, type Aspect, type CandidateDto, type ClipProposal, type ClipRun, type PassState } from './clipperTypes';

/** The proposals pane's starting height, px; candidates take the rest. */
const PROPOSALS_PANE_DEFAULT_PX = 320;
const PANE_MIN_PX = 120;
/** How often the panel re-reads a run while its source is still being read. */
const POLL_MS = 2500;
/** "New run" in the run picker. */
const NEW_RUN = 'new';

type Notice = { ok: boolean; message: string } | null;

const fmtSecs = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

/** What the agent should be asked, ready to paste. */
function askPrompt(run: ClipRun): string {
  return `Use the apelles-auto-clip skill: propose ${run.settings.count} shorts (${run.settings.durations.join('/')} s) from clip run ${run.id} in Apelles and build them.`;
}

export function ClipperPanel() {
  const runs = useClipperStore((s) => s.runs);
  const activeRunId = useClipperStore((s) => s.activeRunId);
  const loadErrors = useClipperStore((s) => s.loadErrors);
  const openProjectKey = useEditorTimelineStore((s) => s.openProjectKey);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    if (openProjectKey) void useClipperStore.getState().loadRuns();
  }, [openProjectKey]);

  const run = activeRunId ? runs[activeRunId] : undefined;
  const ordered = useMemo(() => Object.values(runs).sort((a, b) => b.created_at.localeCompare(a.created_at)), [runs]);

  if (!openProjectKey) {
    return <p className="p-3 text-[11px] leading-snug text-text-secondary">Open a project to cut shorts from it.</p>;
  }

  return (
    <div data-chroma-clipper className="flex min-h-0 flex-1 flex-col text-[11px]">
      <div className="flex shrink-0 items-center gap-2 border-b border-border-color p-2">
        <Label className="w-10 shrink-0 text-[11px] text-text-secondary">Run</Label>
        <Select value={run ? run.id : NEW_RUN} onValueChange={(v) => useClipperStore.getState().setActiveRun(!v || v === NEW_RUN ? null : v)}>
          <SelectTrigger data-chroma-clipper-run className="h-7 flex-1 text-[11px]">
            <SelectValue>{run ? `${run.source.name} · ${new Date(run.created_at).toLocaleString()}` : 'New run'}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NEW_RUN}>New run</SelectItem>
            {ordered.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.source.name} · {r.proposals.filter((p) => p.status === 'built').length}/{r.proposals.length} built
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {loadErrors.length > 0 && (
        <p className="shrink-0 px-2.5 pt-1.5 text-destructive">
          {loadErrors.length} clip run file(s) could not be read: {loadErrors[0].file} — {loadErrors[0].error}
        </p>
      )}
      {notice && (
        <button
          type="button"
          data-chroma-clipper-notice={notice.ok ? 'ok' : 'error'}
          onClick={() => setNotice(null)}
          title="Dismiss"
          className={`flex shrink-0 items-start gap-1 border-b border-border-color px-2.5 py-1.5 text-left leading-snug ${notice.ok ? 'text-text-secondary' : 'text-destructive'}`}
        >
          <span className="flex-1">{notice.message}</span>
          <XIcon className="mt-0.5 size-3 shrink-0" />
        </button>
      )}
      {run ? <RunView run={run} onNotice={setNotice} /> : <Setup onNotice={setNotice} />}
    </div>
  );
}

/** A new run's setup. */
function Setup({ onNotice }: { onNotice: (n: Notice) => void }) {
  const media = useMediaPoolStore((s) => s.items);
  const timelines = useEditorTimelineStore((s) => s.timelines);
  const sources = useMemo(
    () => [
      ...timelines.filter((t) => !t.origin).map((t) => ({ key: `t:${t.id}`, label: `Timeline · ${t.name}` })),
      ...media.filter((m) => m.video && !m.offline).map((m) => ({ key: `m:${m.id}`, label: `${m.video?.width ? 'Video' : 'Audio'} · ${m.name}` })),
    ],
    [media, timelines],
  );
  const [source, setSource] = useState<string>('');
  const [durations, setDurations] = useState<number[]>(DEFAULT_DURATIONS);
  const [count, setCount] = useState(DEFAULT_COUNT);
  const [aspect, setAspect] = useState<Aspect>('9:16');
  const [captions, setCaptions] = useState('brand');
  const [focus, setFocus] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen = source || sources[0]?.key || '';

  const analyse = async () => {
    if (!chosen) return;
    setBusy(true);
    const [kind, id] = [chosen.slice(0, 1), chosen.slice(2)];
    const out = await startAutoClip({
      ...(kind === 't' ? { timelineId: id } : { mediaId: id }),
      durations,
      count,
      aspect,
      captions,
      ...(focus.trim() ? { focus: focus.trim() } : {}),
    });
    setBusy(false);
    if ('error' in out) onNotice({ ok: false, message: out.error });
  };

  return (
    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5" data-chroma-clipper-setup>
      <p className="leading-snug text-text-secondary">
        Cut shorts from a long video, podcast or edited timeline. The app finds the sentences, topics and every clean cut; your AI agent picks the moments; you review and build them here.
      </p>
      <div className="flex items-center gap-2">
        <Label className="w-16 shrink-0 text-[11px] text-text-secondary">Source</Label>
        <Select value={chosen} onValueChange={(v) => v && setSource(v)}>
          <SelectTrigger data-chroma-clipper-source className="h-7 flex-1 text-[11px]">
            <SelectValue>{sources.find((s) => s.key === chosen)?.label ?? 'Import a video first'}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {sources.map((s) => (
              <SelectItem key={s.key} value={s.key}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <Label className="w-16 shrink-0 text-[11px] text-text-secondary">Lengths</Label>
        <div className="flex flex-1 gap-1" role="group" aria-label="Target lengths">
          {ALLOWED_DURATIONS.map((d) => {
            const on = durations.includes(d);
            return (
              <Button
                key={d}
                size="xs"
                variant={on ? 'default' : 'outline'}
                aria-pressed={on}
                data-chroma-clipper-duration={d}
                onClick={() => setDurations((cur) => (on ? (cur.length > 1 ? cur.filter((x) => x !== d) : cur) : [...cur, d].sort((a, b) => a - b)))}
              >
                {d}s
              </Button>
            );
          })}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Label className="w-16 shrink-0 text-[11px] text-text-secondary">Shorts</Label>
        <ScrubbableNumberInput
          aria-label="How many shorts"
          className="h-7 w-14 text-[11px]"
          value={count}
          min={1}
          max={20}
          step={1}
          onValueChange={(v) => setCount(Math.min(20, Math.max(1, Math.round(v))))}
        />
        <Select value={aspect} onValueChange={(v) => v && setAspect(v as Aspect)}>
          <SelectTrigger className="h-7 flex-1 text-[11px]" aria-label="Frame">
            <SelectValue>{aspect}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {ASPECTS.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <Label className="w-16 shrink-0 text-[11px] text-text-secondary">Captions</Label>
        <Select value={captions} onValueChange={(v) => v && setCaptions(v)}>
          <SelectTrigger className="h-7 flex-1 text-[11px]" aria-label="Captions">
            <SelectValue>{captions === 'brand' ? 'Brand kit (or Pill Karaoke)' : captions === 'none' ? 'None' : (CAPTION_PRESETS.find((p) => p.id === captions)?.label ?? captions)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="brand">Brand kit (or Pill Karaoke)</SelectItem>
            <SelectItem value="none">None</SelectItem>
            {CAPTION_PRESETS.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2">
        <Label className="w-16 shrink-0 text-[11px] text-text-secondary">Focus</Label>
        <Input className="h-7 flex-1 text-[11px]" placeholder="optional — e.g. the pricing discussion" value={focus} onChange={(e) => setFocus(e.target.value)} />
      </div>
      <Button size="sm" className="w-full" disabled={!chosen || busy} data-chroma-clipper-analyse onClick={() => void analyse()}>
        <FilmSlateIcon className="size-3.5" /> {busy ? 'Starting…' : 'Analyse'}
      </Button>
    </div>
  );
}

const passLabel = (p: PassState) => (p.state === 'error' ? `failed: ${p.error}` : p.state);

/** One run: status, proposals and candidates. */
function RunView({ run, onNotice }: { run: ClipRun; onNotice: (n: Notice) => void }) {
  const analysis = useClipperStore((s) => s.analyses[run.id]);
  const transcripts = useMediaUnderstandingStore((s) => s.transcripts);
  const partials = useMediaUnderstandingStore((s) => s.partialTranscripts);
  const transcribing = useMediaUnderstandingStore((s) => s.transcribing);
  const [busy, setBusy] = useState(false);

  // Re-analyse when a transcript (or a window of one) lands; poll while the
  // source or its evidence passes are still being read.
  useEffect(() => {
    void analyseRun(run, { includeAnalysis: true });
  }, [run, transcripts, partials]);
  const reading =
    !analysis ||
    analysis.provisional ||
    analysis.wire.evidence.some((e) => e.audio.state === 'running' || e.scenes.state === 'running') ||
    Object.keys(transcribing).length > 0;
  useEffect(() => {
    if (!reading) return;
    const t = setInterval(() => void autoClipStatus({ runId: run.id }), POLL_MS);
    return () => clearInterval(t);
  }, [reading, run.id]);

  const partial = run.source.kind === 'media' ? partials[run.source.path] : undefined;
  const sentences = analysis?.wire.analysis?.sentences ?? [];
  const buildable = run.proposals.filter((p) => p.status !== 'rejected' && p.status !== 'built' && p.verdict.verdict !== 'refused');

  return (
    <>
      <div className="shrink-0 space-y-0.5 border-b border-border-color p-2 leading-snug text-text-secondary" data-chroma-clipper-status>
        <div>
          {run.source.kind === 'media' ? 'File' : 'Timeline'} <span className="text-text-primary">{run.source.name}</span> · {run.settings.durations.join('/')} s · {run.settings.aspect} · {run.settings.count} shorts
          {run.settings.focus ? ` · focus “${run.settings.focus}”` : ''}
        </div>
        {partial ? (
          <div>
            Transcribing: {partial.windowsDone}/{partial.windowsTotal} windows ({fmtSecs(partial.coveredSecs)} of {fmtSecs(partial.durationSecs)}) — what is shown so far is provisional.
          </div>
        ) : !analysis ? (
          <div>Reading the source…</div>
        ) : (
          <div>
            {analysis.wire.totalSentences} sentences · {analysis.wire.topics} topics · {analysis.wire.candidates} clean windows
            {analysis.wire.evidence.map((e) => ` · audio ${passLabel(e.audio)}, picture ${passLabel(e.scenes)}`).join('')}
          </div>
        )}
      </div>
      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel defaultSize={PROPOSALS_PANE_DEFAULT_PX} minSize={PANE_MIN_PX} className="flex min-h-0 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto" data-chroma-clipper-proposals>
            {run.proposals.length === 0 ? (
              <AskAgent run={run} ready={!!analysis && !analysis.provisional} onNotice={onNotice} />
            ) : (
              <ul className="p-1.5">
                {run.proposals.map((p) => (
                  <ProposalRow key={p.id} run={run} p={p} sentences={sentences} onNotice={onNotice} />
                ))}
              </ul>
            )}
          </div>
          {run.proposals.length > 0 && (
            <div className="shrink-0 border-t border-border-color p-2">
              <Button
                size="sm"
                className="w-full"
                disabled={buildable.length === 0 || busy}
                data-chroma-clipper-build
                onClick={async () => {
                  setBusy(true);
                  const out = await buildClips({ runId: run.id });
                  setBusy(false);
                  if ('error' in out) return onNotice({ ok: false, message: out.error });
                  const failed = out.results.filter((r) => !r.ok);
                  onNotice({
                    ok: failed.length === 0,
                    message: `${out.results.length - failed.length} short(s) built as timelines in this project.${failed.length ? ` ${failed.length} could not be: ${'error' in failed[0] ? failed[0].error : ''}` : ''}`,
                  });
                }}
              >
                <HammerIcon className="size-3.5" /> {busy ? 'Building…' : `Build ${buildable.length}`}
              </Button>
            </div>
          )}
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel minSize={PANE_MIN_PX} className="flex min-h-0 flex-col">
          <Candidates run={run} candidates={analysis?.wire.analysis?.candidates ?? []} sentences={sentences} topics={analysis?.wire.analysis?.topics ?? []} onNotice={onNotice} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </>
  );
}

/** No proposals yet: the agent judges; say how to ask it. */
function AskAgent({ run, ready, onNotice }: { run: ClipRun; ready: boolean; onNotice: (n: Notice) => void }) {
  const prompt = askPrompt(run);
  return (
    <div className="space-y-2 p-2.5 leading-snug" data-chroma-clipper-ask>
      <p className="flex items-start gap-1.5 text-text-primary">
        <RobotIcon className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Your AI agent picks the moments. {ready ? 'The analysis is ready.' : 'It can start once the transcript is done.'} Ask it in Claude Code, or any MCP client connected to Apelles:
        </span>
      </p>
      <p className="rounded bg-bg-primary p-2 font-mono text-[10.5px] text-text-secondary">{prompt}</p>
      <Button
        size="xs"
        variant="outline"
        onClick={() => {
          void navigator.clipboard
            .writeText(prompt)
            .then(() => onNotice({ ok: true, message: 'Copied — paste it to your agent.' }))
            .catch(() => onNotice({ ok: false, message: 'Could not copy; select the text instead.' }));
        }}
      >
        <CopyIcon className="size-3.5" /> Copy the request
      </Button>
      <p className="text-text-secondary">Its proposals appear here, each with its reason and the clean-cut check, for you to accept, adjust and build.</p>
    </div>
  );
}

function ProposalRow({ run, p, sentences, onNotice }: { run: ClipRun; p: ClipProposal; sentences: Array<{ startSecs: number; piece: number }>; onNotice: (n: Notice) => void }) {
  const resolved = p.verdict.verdict === 'refused' ? null : p.verdict.resolved;
  const set = async (args: Record<string, unknown>) => {
    const out = await setClipProposal({ runId: run.id, id: p.id, ...args });
    if ('error' in out) onNotice({ ok: false, message: out.error });
    else if (out.note) onNotice({ ok: true, message: out.note });
  };
  const gateClass = p.verdict.verdict === 'refused' ? 'text-destructive' : p.verdict.verdict === 'warned' ? 'text-text-secondary' : 'text-accent';
  const first = resolved ? sentences[resolved.first_sentence] : undefined;
  return (
    <li data-chroma-clipper-proposal={p.id} data-chroma-clipper-status={p.status} className={`rounded px-1.5 py-1.5 leading-snug hover:bg-bg-primary ${p.status === 'rejected' ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-1.5">
        <span className="flex-1 font-medium text-text-primary">{p.title}</span>
        <span className={`shrink-0 ${gateClass}`} title="The clean-cut check">
          {p.status === 'built' ? 'built' : p.verdict.verdict}
        </span>
      </div>
      <p className="mt-0.5 text-text-secondary">{p.reason}</p>
      {p.hook_line && <p className="mt-0.5 text-text-primary">“{p.hook_line}”</p>}
      {p.gate_notes.length > 0 && (
        <p className={`mt-0.5 ${p.verdict.verdict === 'refused' ? 'text-destructive' : 'text-text-secondary'}`}>
          <WarningIcon className="mr-1 inline size-3 align-[-2px]" />
          {p.gate_notes.join(' · ')}
        </p>
      )}
      <div className="mt-1 flex items-center gap-0.5 text-text-secondary">
        <span className="flex-1 tabular-nums">{resolved ? `S${resolved.first_sentence}–S${resolved.last_sentence} · ${resolved.tight_secs.toFixed(1)} s` : ''}</span>
        <Button variant="ghost" size="icon-xs" title="Start one sentence earlier" onClick={() => void set({ extendStart: 1 })} disabled={!resolved}>
          <CaretLeftIcon />
        </Button>
        <Button variant="ghost" size="icon-xs" title="Start one sentence later" onClick={() => void set({ extendStart: -1 })} disabled={!resolved}>
          <CaretRightIcon />
        </Button>
        <span className="px-0.5">|</span>
        <Button variant="ghost" size="icon-xs" title="End one sentence earlier" onClick={() => void set({ extendEnd: -1 })} disabled={!resolved}>
          <CaretLeftIcon />
        </Button>
        <Button variant="ghost" size="icon-xs" title="End one sentence later" onClick={() => void set({ extendEnd: 1 })} disabled={!resolved}>
          <CaretRightIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          title={run.source.kind === 'timeline' ? 'Jump to this moment on the source timeline' : 'The source is a file: open the built short to play it'}
          disabled={run.source.kind !== 'timeline' || !first}
          onClick={async () => {
            if (!first) return;
            const out = await jumpToSource(run, first.piece, first.startSecs);
            if ('error' in out) onNotice({ ok: false, message: out.error });
          }}
        >
          <CrosshairSimpleIcon />
        </Button>
        {p.status !== 'built' && (
          <>
            <Button variant="ghost" size="icon-xs" aria-pressed={p.status === 'accepted'} title={p.status === 'accepted' ? 'Un-accept' : 'Accept'} disabled={p.verdict.verdict === 'refused'} className={p.status === 'accepted' ? 'text-accent' : ''} onClick={() => void set({ status: p.status === 'accepted' ? 'pending' : 'accepted' })}>
              <CheckIcon />
            </Button>
            <Button variant="ghost" size="icon-xs" aria-pressed={p.status === 'rejected'} title={p.status === 'rejected' ? 'Un-reject' : 'Reject'} className={p.status === 'rejected' ? 'text-destructive' : ''} onClick={() => void set({ status: p.status === 'rejected' ? 'pending' : 'rejected' })}>
              <XIcon />
            </Button>
          </>
        )}
        {p.timeline_id && (
          <Button
            variant="ghost"
            size="icon-xs"
            title="Open the built short"
            data-chroma-clipper-open={p.id}
            onClick={async () => {
              const out = await openShort(p.timeline_id ?? '');
              if ('error' in out) onNotice({ ok: false, message: out.error });
            }}
          >
            <ArrowSquareOutIcon />
          </Button>
        )}
      </div>
    </li>
  );
}

/** Every clean window, by topic: the agent's evidence, shown to the person. */
function Candidates({
  run,
  candidates,
  sentences,
  topics,
  onNotice,
}: {
  run: ClipRun;
  candidates: CandidateDto[];
  sentences: Array<{ startSecs: number; piece: number; text: string }>;
  topics: Array<{ firstSentence: number; lastSentence: number; keywords: string[] }>;
  onNotice: (n: Notice) => void;
}) {
  const [target, setTarget] = useState<number | null>(null);
  const shown = target === null ? candidates : candidates.filter((c) => c.targetSecs === target);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-chroma-clipper-candidates>
      <div className="flex shrink-0 items-center gap-1 px-2 pt-1.5 text-text-secondary">
        <span className="flex-1">Clean windows (evidence, not picks)</span>
        {[null, ...run.settings.durations].map((d) => (
          <Button key={d ?? 'all'} size="xs" variant={target === d ? 'default' : 'ghost'} onClick={() => setTarget(d)}>
            {d === null ? 'All' : `${d}s`}
          </Button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {shown.length === 0 && <p className="p-1 text-text-secondary">None yet.</p>}
        {topics.map((t, ti) => {
          const rows = shown.filter((c) => c.topic === ti);
          if (rows.length === 0) return null;
          return (
            <details key={ti} open={ti === 0} className="mb-1">
              <summary className="cursor-pointer text-text-secondary">
                Topic {ti + 1} · {t.keywords.join(', ')} · {rows.length}
              </summary>
              <ul>
                {rows.map((c) => {
                  const s = sentences[c.firstSentence];
                  return (
                    <li key={`${c.id}-${c.targetSecs}`} className="rounded px-1.5 py-1 hover:bg-bg-primary">
                      <div className="flex items-center gap-1">
                        <span className="flex-1 tabular-nums text-text-secondary">
                          S{c.firstSentence}–S{c.lastSentence} · {c.tightSecs.toFixed(1)} s ({c.targetSecs} s) · {s ? fmtSecs(s.startSecs) : ''}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          disabled={run.source.kind !== 'timeline' || !s}
                          title={run.source.kind === 'timeline' ? 'Jump to this moment on the source timeline' : 'The source is a file'}
                          onClick={async () => {
                            if (!s) return;
                            const out = await jumpToSource(run, s.piece, s.startSecs);
                            if ('error' in out) onNotice({ ok: false, message: out.error });
                          }}
                        >
                          <CrosshairSimpleIcon />
                        </Button>
                      </div>
                      <p className="text-text-primary">{s?.text}</p>
                      {c.tags.length > 0 && <p className="text-text-secondary">{c.tags.join(' · ')}</p>}
                    </li>
                  );
                })}
              </ul>
            </details>
          );
        })}
      </div>
    </div>
  );
}
