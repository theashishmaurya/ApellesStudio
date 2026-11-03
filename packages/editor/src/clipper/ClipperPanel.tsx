/**
 * `@apelles/editor` — the Clipper's list in the browser's Shorts tab: shorts
 * from a long source, analysed here, picked by the person's AI agent, reviewed
 * and made here (D-411 Phases 1-2; redesigned by D-443, B-363).
 *
 * **What it is.** The `clipper` `EditLibraryMode`, built from the owner-approved
 * mockup (`scratch/panel-redesign-mockup.html`, "Clipper"). The review itself
 * left the 280 px column: selecting a short fills the viewer area with the
 * review surface (`ClipperSurface.tsx`, owner decision 2026-11-03). This column
 * holds, top to bottom:
 *
 * - **The set picker** "Shorts from Voiceover v2 · 30 Oct" with **＋** (new
 *   shorts, whose form opens in the viewer area) and the run's state in one line
 *   ("Ready · 30 s and 60 s · Vertical 9:16", "Reading the video… 2:40 of 7:44",
 *   "Waiting for your agent").
 * - **One card per short**: a 9:16 poster with its length, the title, the
 *   opening line, the clean-cut chip and the status; a made short gets Open.
 * - **The count and the build**: "2 approved · 1 skipped · 2 to review",
 *   "Approve the rest", and **"Make 2 shorts"** (disabled with "Approve at least
 *   one short (A) to make it.").
 * - With no run: earlier runs and **New shorts**.
 *
 * A / X / ↑ / ↓ review from here too while focus is in the list
 * (`clipperReview.ts`).
 *
 * **What it does NOT do.** Any logic of its own: every button is a function the
 * MCP ops call (`clipperOps.ts`). It never subscribes to the playhead, and the
 * app never picks a moment (D-411): the agent does.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  FilmSlateIcon,
  PlusIcon,
  RobotIcon,
  XIcon,
} from '@phosphor-icons/react';
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tooltip, TooltipContent, TooltipTrigger } from '@apelles/ui';

import { useMediaUnderstandingStore } from '../mediaUnderstandingStore';
import { useEditorTimelineStore } from '../timelineStore';
import { analyseRun, autoClipStatus, buildClips, openShort, setClipProposal } from './clipperOps';
import { useClipperStore, type RunAnalysis } from './clipperStore';
import { onClipperReviewKey } from './clipperReview';
import type { ClipProposal, ClipRun } from './clipperTypes';
import { checkChip, fmtClock, reviewCounts, runDate, runIsReading, runSettingsLine, runTitle, shortSeconds } from './clipperView';
import { useShortPoster } from './clipperPoster';

/** How often the panel re-reads a run while its source is still being read. */
const POLL_MS = 2500;

const notify = (n: { ok: boolean; message: string }) => useClipperStore.getState().setNotice(n);

export function ClipperPanel() {
  const runs = useClipperStore((s) => s.runs);
  const activeRunId = useClipperStore((s) => s.activeRunId);
  const loadErrors = useClipperStore((s) => s.loadErrors);
  const notice = useClipperStore((s) => s.notice);
  const surface = useClipperStore((s) => s.surface);
  const openProjectKey = useEditorTimelineStore((s) => s.openProjectKey);

  useEffect(() => {
    if (openProjectKey) void useClipperStore.getState().loadRuns();
  }, [openProjectKey]);

  const run = activeRunId ? runs[activeRunId] : undefined;
  const ordered = useMemo(() => Object.values(runs).sort((a, b) => b.created_at.localeCompare(a.created_at)), [runs]);

  if (!openProjectKey) {
    return <p className="p-3 text-[11px] leading-snug text-text-secondary">Open a project to cut shorts from it.</p>;
  }

  return (
    <div data-chroma-clipper className="flex min-h-0 flex-1 flex-col text-xs" onKeyDown={(e) => onClipperReviewKey(e, notify)}>
      {run && surface !== 'setup' ? (
        <RunHeader run={run} runs={ordered} />
      ) : (
        ordered.length > 0 && (
          <div className="flex shrink-0 items-center gap-1.5 border-b border-border-color px-3 py-2">
            <span className="flex-1 text-sm font-semibold text-text-primary">Shorts</span>
          </div>
        )
      )}
      {loadErrors.length > 0 && (
        <p className="shrink-0 px-3 pt-1.5 text-destructive">
          {loadErrors.length} clip run file(s) could not be read: {loadErrors[0].file} — {loadErrors[0].error}
        </p>
      )}
      {notice && (
        <button
          type="button"
          data-chroma-clipper-notice={notice.ok ? 'ok' : 'error'}
          onClick={() => useClipperStore.getState().setNotice(null)}
          title="Dismiss"
          className={`mx-3 mt-2 flex shrink-0 items-start gap-1 rounded-sm bg-bg-secondary px-2.5 py-1.5 text-left leading-snug ${notice.ok ? 'text-text-secondary' : 'text-destructive'}`}
        >
          <span className="flex-1">{notice.message}</span>
          <XIcon className="mt-0.5 size-3 shrink-0" />
        </button>
      )}
      {run && surface !== 'setup' ? <RunList run={run} /> : <Runs runs={ordered} />}
    </div>
  );
}

/** No run open: earlier runs, and New shorts. */
function Runs({ runs }: { runs: ClipRun[] }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-3" data-chroma-clipper-runs>
      {runs.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-3 text-center">
          <FilmSlateIcon className="size-7 text-text-tertiary" />
          <p className="leading-snug text-text-secondary">Cut shorts from a long video, podcast or edited timeline.</p>
          <Button size="sm" data-chroma-clipper-new onClick={() => useClipperStore.getState().openSurface('setup')}>
            <PlusIcon /> New shorts
          </Button>
        </div>
      ) : (
        <>
          <div className="flex items-center px-1.5 pb-1">
            <span className="flex-1 text-[11px] font-semibold text-text-secondary">Earlier shorts</span>
            <Button variant="ghost" size="xs" data-chroma-clipper-new onClick={() => useClipperStore.getState().openSurface('setup')}>
              <PlusIcon /> New
            </Button>
          </div>
          {runs.map((r) => (
            <button
              type="button"
              key={r.id}
              data-chroma-clipper-run-card={r.id}
              onClick={() => useClipperStore.getState().openSurface('run', r.id)}
              className="flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-bg-secondary"
            >
              <span className="text-sm font-medium text-text-primary">{runTitle(r)}</span>
              <span className="text-text-secondary">
                {runDate(r)} · {r.proposals.length} suggested · {r.proposals.filter((p) => p.status === 'built').length} made
              </span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}

/** The set picker, ＋, and the run's state in one line. */
function RunHeader({ run, runs }: { run: ClipRun; runs: ClipRun[] }) {
  const analysis = useClipperStore((s) => s.analyses[run.id]);
  const transcribing = useMediaUnderstandingStore((s) => s.transcribing);
  const partials = useMediaUnderstandingStore((s) => s.partialTranscripts);
  const reading = runIsReading(analysis, transcribing);
  const partial = run.source.kind === 'media' ? partials[run.source.path] : undefined;
  const label = `${runTitle(run)} · ${runDate(run)}`;
  let state: React.ReactNode;
  if (reading) {
    state = (
      <>
        <CircleNotchIcon className="size-3.5 animate-spin text-accent-text" />
        <span>
          Reading the video…{partial ? ` ${fmtClock(partial.coveredSecs)} of ${fmtClock(partial.durationSecs)}` : ''}
        </span>
      </>
    );
  } else if (run.proposals.length === 0) {
    state = (
      <>
        <RobotIcon className="size-3.5 text-accent-text" />
        <span>Waiting for your agent · {runSettingsLine(run)}</span>
      </>
    );
  } else {
    state = (
      <>
        <CheckCircleIcon weight="fill" className="size-3.5 text-accent-text" />
        <span>Ready · {runSettingsLine(run)}</span>
      </>
    );
  }
  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-border-color px-3 py-2">
      <div className="flex items-center gap-1.5">
        <Select value={run.id} onValueChange={(v) => v && useClipperStore.getState().openSurface('run', v)}>
          <SelectTrigger data-chroma-clipper-run className="data-[size=default]:h-7 min-w-0 flex-1 text-xs" title={label}>
            <SelectValue>
              <span className="truncate">
                <span className="font-medium">{runTitle(run)}</span>
                <span className="text-text-tertiary"> · {runDate(run)}</span>
              </span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {runs.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {runTitle(r)} · {runDate(r)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon-sm" aria-label="New shorts" data-chroma-clipper-new onClick={() => useClipperStore.getState().openSurface('setup')}>
                <PlusIcon />
              </Button>
            }
          />
          <TooltipContent>New shorts from another video or timeline</TooltipContent>
        </Tooltip>
      </div>
      <div className="flex items-center gap-1.5 text-text-secondary" data-chroma-clipper-status>
        {state}
      </div>
    </div>
  );
}

/** The active run: its analysis kept fresh, the cards, the count and Make. */
function RunList({ run }: { run: ClipRun }) {
  const analysis = useClipperStore((s) => s.analyses[run.id]);
  const selected = useClipperStore((s) => s.selectedProposalId);
  const transcripts = useMediaUnderstandingStore((s) => s.transcripts);
  const partials = useMediaUnderstandingStore((s) => s.partialTranscripts);
  const transcribing = useMediaUnderstandingStore((s) => s.transcribing);
  const [busy, setBusy] = useState(false);

  // Re-analyse when a transcript (or a window of one) lands; poll while the
  // source or its evidence passes are still being read.
  useEffect(() => {
    void analyseRun(run, { includeAnalysis: true });
  }, [run, transcripts, partials]);
  const reading = runIsReading(analysis, transcribing);
  useEffect(() => {
    if (!reading) return;
    const t = setInterval(() => void autoClipStatus({ runId: run.id }), POLL_MS);
    return () => clearInterval(t);
  }, [reading, run.id]);

  const counts = reviewCounts(run);
  const toReview = run.proposals.filter((p) => p.status === 'pending' && p.verdict.verdict !== 'refused');
  const current = selected ?? run.proposals[0]?.id ?? null;

  if (run.proposals.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-5 text-center" data-chroma-clipper-proposals>
        <FilmSlateIcon className="size-7 text-text-tertiary" />
        <p className="leading-snug text-text-secondary">
          {reading ? 'Suggested shorts appear here as soon as your AI agent picks them.' : 'No suggestions yet. Ask your AI agent (right) to pick the moments.'}
        </p>
        <Button variant="outline" size="sm" onClick={() => useClipperStore.getState().openSurface('run')}>
          Show what to ask
        </Button>
      </div>
    );
  }

  return (
    <>
      <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2" data-chroma-clipper-proposals>
        {run.proposals.map((p) => (
          <ShortCard key={p.id} run={run} p={p} analysis={analysis} selected={p.id === current} />
        ))}
      </ul>
      <div className="flex shrink-0 flex-col gap-1.5 border-t border-border-color p-3">
        <div className="flex items-center gap-1.5 text-text-secondary">
          <span className="flex-1" data-chroma-clipper-counts>
            {counts.line}
          </span>
          {toReview.length > 0 && (
            <Button
              variant="ghost"
              size="xs"
              data-chroma-clipper-approve-rest
              onClick={async () => {
                for (const p of toReview) {
                  const out = await setClipProposal({ runId: run.id, id: p.id, status: 'accepted' });
                  if ('error' in out) return notify({ ok: false, message: out.error });
                }
              }}
            >
              Approve the rest
            </Button>
          )}
        </div>
        <Button
          data-chroma-clipper-build
          disabled={counts.approved.length === 0 || busy}
          onClick={async () => {
            setBusy(true);
            const out = await buildClips({ runId: run.id, ids: counts.approved });
            setBusy(false);
            if ('error' in out) return notify({ ok: false, message: out.error });
            const failed = out.results.filter((r) => !r.ok);
            notify({
              ok: failed.length === 0,
              message: `${out.results.length - failed.length} short${out.results.length - failed.length === 1 ? '' : 's'} made as timelines in this project.${failed.length ? ` ${failed.length} could not be: ${'error' in failed[0] ? failed[0].error : ''}` : ''}`,
            });
          }}
        >
          <FilmSlateIcon />
          {busy ? 'Making…' : counts.approved.length > 0 ? `Make ${counts.approved.length} short${counts.approved.length === 1 ? '' : 's'}` : 'Make shorts'}
        </Button>
        {counts.approved.length === 0 && <span className="text-text-tertiary">Approve at least one short (A) to make it.</span>}
      </div>
    </>
  );
}

const CHIP_TONE = {
  ok: 'text-accent-text',
  warn: 'text-text-primary',
  bad: 'text-destructive',
} as const;

function ShortCard({ run, p, analysis, selected }: { run: ClipRun; p: ClipProposal; analysis: RunAnalysis | undefined; selected: boolean }) {
  const poster = useShortPoster(analysis, p);
  const secs = shortSeconds(p);
  const chip = checkChip(p);
  const status = p.status === 'accepted' ? 'Approved' : p.status === 'rejected' ? 'Skipped' : p.status === 'built' ? 'Made' : null;
  const portrait = run.settings.aspect === '9:16' ? 'aspect-[9/16]' : run.settings.aspect === '4:5' ? 'aspect-[4/5]' : 'aspect-square';
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        data-chroma-clipper-proposal={p.id}
        data-chroma-clipper-status={p.status}
        onClick={() => useClipperStore.getState().selectProposal(p.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            useClipperStore.getState().selectProposal(p.id);
          }
        }}
        className={`grid cursor-pointer grid-cols-[40px_minmax(0,1fr)] gap-2.5 rounded-md p-1.5 ring-1 ring-inset ${
          selected ? 'bg-card-active ring-accent' : 'ring-transparent hover:bg-bg-secondary'
        } ${p.status === 'rejected' ? 'opacity-55' : ''}`}
      >
        <span className={`relative block w-10 ${portrait} overflow-hidden rounded-sm bg-bg-primary`}>
          {poster && <img src={poster} alt="" className="absolute inset-0 size-full object-cover" />}
          {secs !== null && (
            <span className="absolute right-0.5 bottom-0.5 rounded-[2px] bg-bg-primary/80 px-0.5 text-[9px] tabular-nums text-text-primary">{Math.round(secs)}s</span>
          )}
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-text-primary">{p.title}</span>
          {p.hook_line && <span className="line-clamp-2 leading-snug text-text-secondary">“{p.hook_line}”</span>}
          <span className="mt-0.5 flex flex-wrap items-center gap-1">
            <span className={`rounded-sm bg-bg-secondary px-1 text-[10px] ${CHIP_TONE[chip.tone]}`}>{chip.label}</span>
            {status && <span className="rounded-sm bg-bg-secondary px-1 text-[10px] text-text-secondary">{status}</span>}
            {p.timeline_id && (
              <Button
                variant="ghost"
                size="xs"
                className="ml-auto h-5"
                data-chroma-clipper-open={p.id}
                onClick={async (e) => {
                  e.stopPropagation();
                  const out = await openShort(p.timeline_id ?? '');
                  if ('error' in out) return notify({ ok: false, message: out.error });
                  useClipperStore.getState().closeSurface();
                }}
              >
                <ArrowSquareOutIcon /> Open
              </Button>
            )}
          </span>
        </span>
      </div>
    </li>
  );
}
