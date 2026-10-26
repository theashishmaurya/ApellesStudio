/**
 * @apelles/editor — the Edit tab's own Export button + dialog + queue
 * (D-198, `docs/notes/export-dialog-queue.md`).
 *
 * The owner pointed at a real screenshot of the running Edit tab: no Export
 * affordance anywhere, despite `editor_export`/`runEditorExport`
 * (`editorExport.ts`) being a real, working backend capability reachable
 * only through MCP. This is the GUI surface for that SAME capability — see
 * this file's own `handleAddToQueue`, which calls `useExportQueueStore
 * .enqueue`, which calls `compileEditorExportArgs` (`editorExport.ts`), the
 * exact function `useEditorControl.ts`'s `editor_export` op now also calls.
 * Not a parallel implementation.
 *
 * Follows Colorist's own `ExportDialog.tsx` (D-049) conventions: a
 * `Dialog`/`DialogContent` from `@apelles/ui`, a native `save()` picker for
 * the output path, plain elements + colour tokens for the rest. What's
 * different here, because the underlying capability is different: per-clip
 * `fitOverrides`/`freezeOverrides` rows (Colorist's export has no multi-clip
 * timeline to speak of) and a real job QUEUE instead of a single blocking
 * progress bar — `editorExport.ts`'s own module doc and D-198 explain why
 * sequential-only this pass, not decorative, not parallel.
 *
 * **D-276 dropped this dialog's own per-clip SPEED override.** It used to sit
 * alongside `fitOverrides`/`freezeOverrides` here; D-236 later gave every
 * clip a real, persisted Speed (Retime) section in its own Inspector, which
 * export already prefers over this dialog's flat override (`editorExport.ts`'s
 * `resolveSpeedSegments`: persisted `speed_points`, else a flat override,
 * else 1×) — a second, less capable GUI for the same fact was confusing, not
 * useful, confirmed live. `editorExport.ts`'s `speedOverrides` param itself is
 * untouched (a scripted `editor_export` MCP call can still pass one); this
 * dialog just never populates it now.
 *
 * Width/height default from the project's own composition size
 * (`compositionSize.ts`'s `warmCompositionSize`, i.e.
 * `chroma_timeline_composition_size` — D-199's selection-independent resolver),
 * falling back to a plain 1920×1080 when there is nothing yet to derive it from
 * (a brand-new, empty project). fps defaults to the timeline's own rate
 * (`timelineFps`).
 *
 * **B-208/D-353 — that same warm is also what makes this dialog's ENQUEUE
 * correct**, not just its default form values: `compileEditorExportArgs` reads
 * the composition size synchronously to resolve what each clip's `scale` is a
 * multiple OF, and the queue compiles a job's argv at enqueue time (D-198).
 * This dialog used to resolve the size with its own walk over
 * `chroma_timeline_clip_geometry` for the form fields alone; it now goes
 * through the one shared resolver, so the number on screen and the number the
 * compiler uses cannot be two different answers.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { WarningIcon, CheckCircleIcon, DownloadSimpleIcon, CircleNotchIcon, XCircleIcon } from '@phosphor-icons/react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Progress,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@apelles/ui';

import { usePanelOpen } from './panelRegistry';
import { useEditorTimelineStore } from './timelineStore';
import { timelineFps, type Clip, type Timeline } from './timeline';
import { useExportQueueStore, type ExportJob, type ExportJobStatus } from './exportQueueStore';
// D-256 — bake each graded clip's Colorist grade into a .cube before the
// queue freezes this job's ffmpeg argv against those file paths.
import { warmGradeLuts } from './gradeLuts';
// B-208/D-353 — the composition size, for this dialog's default width/height
// AND for the compiler the queue runs at enqueue time.
import { warmCompositionSize } from './compositionSize';
// D-401 — the audio loudness target, offered the way Premiere's Export Settings
// (Audio > Loudness normalization) and Resolve's Deliver page (Audio >
// Normalize audio, with a loudness standard and a max true peak) do: a preset
// list that fills the two numbers, with the numbers editable.
import { LOUDNESS_PRESETS, DEFAULT_TRUE_PEAK_DBTP, type LoudnessPresetName, type LoudnessReport } from './loudness';

type LoudnessChoice = 'off' | LoudnessPresetName | 'custom';

const LOUDNESS_LABELS: Record<LoudnessChoice, string> = {
  off: 'Off (as mixed)',
  youtube: 'YouTube (-14 LUFS)',
  broadcast: 'Broadcast, EBU R128 (-23 LUFS)',
  podcast: 'Podcast (-16 LUFS)',
  custom: 'Custom…',
};

/** `-21.6 → -14.0 LUFS · peak -6.5 → -1.1 dBTP` — the measured result. */
function loudnessSummary(r: LoudnessReport): string {
  if (r.skipped || !r.before || !r.after) return r.skipped ?? '';
  return (
    `${r.before.integratedLufs.toFixed(1)} → ${r.after.integratedLufs.toFixed(1)} LUFS · ` +
    `peak ${r.before.truePeakDbtp.toFixed(1)} → ${r.after.truePeakDbtp.toFixed(1)} dBTP` +
    (r.targetMet ? '' : ' (target not fully reached)')
  );
}

const FALLBACK_WIDTH = 1920;
const FALLBACK_HEIGHT = 1080;

/** `timelineFps` can carry a long floating-point tail (e.g. an NTSC-derived
 *  rate) — round to the same 3-decimal display precision the rest of the app
 *  already uses for fps (`ProjectSettingsForm`'s own custom-fps field steps
 *  by `0.001`, `AdjustmentClipInspectorPanel`'s numeric fields round the
 *  same way) rather than showing every raw digit. */
function formatFps(fps: number): string {
  return String(Number(fps.toFixed(3)));
}

function suggestedExt(): string {
  return 'mp4';
}

function stemOf(path: string): string {
  const base = path.split(/[\\/]/).pop() || 'timeline';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/** Every VIDEO clip on `tl`, across every track, in track/clip order — the
 *  set of clips the per-clip override rows below are offered for. Audio
 *  clips have no `speedOverrides`/`fitOverrides`/`freezeOverrides` meaning
 *  worth a row here (see `editorExport.ts`'s own doc on `speedOverrides`
 *  being a generic-by-`Clip.id` map — an audio clip COULD receive one, but
 *  there is no real per-export creative reason a human would want that from
 *  this dialog, unlike a video clip's speed/fit/freeze). */
function videoClips(tl: Timeline | null): Clip[] {
  if (!tl) return [];
  return tl.tracks.filter((t) => t.kind === 'video').flatMap((t) => t.clips);
}

/** The project's composition size for this dialog's width/height fields —
 *  and, as a side effect that the enqueue path below depends on, the warm
 *  `compositionSize.ts` snapshot `compileEditorExportArgs` reads (B-208/D-353).
 *  `FALLBACK_*` stands in only when there is genuinely nothing to derive a
 *  size from, which is the one case the resolver answers `null` for. */
async function fetchCompositionSize(tl: Timeline | null): Promise<{ width: number; height: number }> {
  if (!tl) return { width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT };
  const size = await warmCompositionSize();
  return size ?? { width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT };
}

const statusLabel: Record<ExportJobStatus, string> = {
  queued: 'Queued',
  running: 'Exporting…',
  done: 'Done',
  failed: 'Failed',
};

function StatusIcon({ status }: { status: ExportJobStatus }) {
  if (status === 'running') return <CircleNotchIcon className="size-3.5 animate-spin text-accent" />;
  if (status === 'done') return <CheckCircleIcon className="size-3.5 text-green-400" />;
  if (status === 'failed') return <XCircleIcon className="size-3.5 text-red-400" />;
  return <span className="size-3.5 rounded-full border border-border-color inline-block" />;
}

/** `1h 04m` / `4m 20s` / `18s` — a remaining time a human reads at a glance.
 *  Seconds are dropped past a minute because an ETA extrapolated from a
 *  partial render is not accurate to the second and should not pretend to be. */
function shortDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** D-362 — a running job's REAL progress, where the queue used to show only a
 *  spinner and the word "Exporting…".
 *
 *  The percentage is the renderer's own `framesWritten / framesTotal` summed
 *  across D-360's concurrent segments, not a guess from elapsed time. The
 *  segment count is shown alongside it whenever the render actually split,
 *  because the percentage alone cannot distinguish four workers evenly at 78%
 *  from three finished and one wedged — which is the situation B-231 was filed
 *  about and the one a human most needs to see. */
function JobProgress({ job }: { job: ExportJob }) {
  const p = job.progress;
  // A filter-graph job, or a compositor job whose render has not begun: there
  // is no honest number, so nothing is drawn rather than a fake zero.
  if (!p || p.state !== 'running') return null;
  const concatenating = p.phase === 'concatenating';
  return (
    <div className="mt-1.5 flex flex-col gap-1">
      <Progress value={p.percent} />
      <div className="flex items-center justify-between gap-2 text-[10px] text-text-secondary tabular-nums">
        <span>
          {concatenating
            ? 'Joining segments…'
            : `${p.percent.toFixed(1)}% · ${p.framesWritten.toLocaleString()} / ${p.framesTotal.toLocaleString()} frames`}
          {p.segmentsTotal > 1 && !concatenating ? ` · ${p.segmentsDone}/${p.segmentsTotal} segments` : ''}
        </span>
        {p.etaMs !== undefined && !concatenating ? <span>{shortDuration(p.etaMs)} left</span> : null}
      </div>
    </div>
  );
}

export function EditorExportDialog() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const jobs = useExportQueueStore((s) => s.jobs);
  const clearFinished = useExportQueueStore((s) => s.clearFinished);

  // D-252 — lifted out of local `useState` so `debug_set_popover_open
  // ('export-dialog', ...)` can drive this same flag; see
  // `panelRegistry.ts`'s module doc.
  const [open, setOpen] = usePanelOpen('export-dialog');
  const [outPath, setOutPath] = useState<string | null>(null);
  const [width, setWidth] = useState(String(FALLBACK_WIDTH));
  const [height, setHeight] = useState(String(FALLBACK_HEIGHT));
  const [fps, setFps] = useState(formatFps(timelineFps(timeline)));
  const [fitOverrides, setFitOverrides] = useState<Record<string, 'fit' | 'stretch'>>({});
  const [freezeOverrides, setFreezeOverrides] = useState<Record<string, boolean>>({});
  const [validationError, setValidationError] = useState<string | null>(null);
  const [loudnessChoice, setLoudnessChoice] = useState<LoudnessChoice>('off');
  const [customLufs, setCustomLufs] = useState('-14');
  const [customPeak, setCustomPeak] = useState(String(DEFAULT_TRUE_PEAK_DBTP));
  /** D-256 — what baking the clips' Colorist grades had to drop (a masked
   *  layer, a Colorist crop). Shown in the dialog rather than only logged:
   *  these are precisely the cases where the exported file will NOT match what
   *  the Colorist tab shows, and the user is the only one who can decide
   *  whether that matters. */
  const [gradeNotes, setGradeNotes] = useState<string[]>([]);
  /** The bake runs before the job is queued, so the button has a real busy
   *  state rather than appearing to do nothing on a cold cache. */
  const [queueing, setQueueing] = useState(false);

  const clips = useMemo(() => videoClips(timeline), [timeline]);

  // Re-derive sensible defaults every time the dialog opens (not on every
  // keystroke) — the same "reset only on open" convention Colorist's own
  // `ExportDialog.tsx` uses for the identical reason.
  //
  // D-201 — the "reset only on open" dependency array used to need a
  // line-scoped suppression of the `exhaustive-deps` react-hooks rule, because
  // the body reads `timeline` but must NOT re-run when it changes. A
  // suppression of any react-hooks rule also switches the React Compiler off
  // for the whole file (`docs/notes/react-compiler-coverage.md`), which
  // `reactCompiler.test.ts` now fails on, so this uses the standard latest-ref
  // shape instead: the ref is written in its own effect (never during render),
  // and effects run in declaration order within a commit, so the reset effect
  // below always reads the value from the same commit.
  const timelineRef = useRef(timeline);
  useEffect(() => {
    timelineRef.current = timeline;
  }, [timeline]);

  useEffect(() => {
    if (!open) return;
    const tl = timelineRef.current;
    setOutPath(null);
    setFitOverrides({});
    setFreezeOverrides({});
    setValidationError(null);
    setFps(formatFps(timelineFps(tl)));
    let cancelled = false;
    fetchCompositionSize(tl).then(({ width: w, height: h }) => {
      if (!cancelled) {
        setWidth(String(w));
        setHeight(String(h));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleChoosePath = async () => {
    const ext = suggestedExt();
    const suggested = `${stemOf(timeline?.name ?? 'timeline')}.${ext}`;
    try {
      const chosen = await save({
        title: 'Export timeline',
        defaultPath: suggested,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (chosen) setOutPath(chosen as string);
    } catch (e) {
      console.error('Export path picker failed:', e);
    }
  };

  const handleAddToQueue = async () => {
    setValidationError(null);
    if (!outPath) {
      setValidationError('Choose an output file first.');
      return;
    }
    const w = parseInt(width, 10);
    const h = parseInt(height, 10);
    const f = parseFloat(fps);
    if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0) {
      setValidationError('Width and height must be positive numbers.');
      return;
    }
    if (!Number.isFinite(f) || f <= 0) {
      setValidationError('Frame rate must be a positive number.');
      return;
    }

    // D-256 — bake each graded clip's Colorist grade BEFORE compiling. The
    // queue freezes a job's ffmpeg argv at enqueue time (D-198), and that argv
    // names the `.cube` files by path, so they have to exist and be current
    // now. `compileEditorExportArgs` refuses outright on a cold cache rather
    // than compiling an export that would silently drop a grade — this await is
    // what keeps the GUI path on the right side of that refusal.
    if (!timeline) {
      setValidationError('No timeline — open a project first.');
      return;
    }
    setQueueing(true);
    // B-208/D-353 — refresh the composition size the compiler reads
    // synchronously, for the same enqueue-time-snapshot reason the grade bake
    // below exists: the dialog may have been open across a `set_project_
    // settings` write, and a job frozen against the old size would size every
    // `scale`d clip against a composition the project no longer has.
    // B-276 — that size is read from the PERSISTED timeline, so a save still
    // on its debounce is settled first. A failed save is reported again, and
    // refused, when a queued compositor job runs (`runCompiledExport`); the
    // filter-graph path compiles from the in-memory timeline and needs none.
    await useEditorTimelineStore.getState().flushPendingSave();
    await warmCompositionSize();
    try {
      const baked = await warmGradeLuts(timeline);
      setGradeNotes(baked.warnings);
    } catch (e) {
      setQueueing(false);
      setValidationError(
        `Could not bake a clip's Colorist grade for export: ${String((e as Error)?.message ?? e)}`,
      );
      return;
    }
    setQueueing(false);

    const result = useExportQueueStore.getState().enqueue(stemOf(outPath), {
      outPath,
      width: w,
      height: h,
      fps: f,
      fitOverrides: Object.keys(fitOverrides).length > 0 ? fitOverrides : undefined,
      freezeOverrides: Object.keys(freezeOverrides).length > 0 ? freezeOverrides : undefined,
      ...(loudnessChoice === 'custom'
        ? { loudnessLufs: parseFloat(customLufs), truePeakDbtp: parseFloat(customPeak) }
        : { loudnessPreset: loudnessChoice }),
    });
    if ('error' in result) {
      setValidationError(result.error);
      return;
    }
    // Leave the dialog open on the queue view — a real multi-export session
    // (queue several outputs, watch them run) is the whole point of D-198,
    // unlike Colorist's single-export dialog which closes on success.
    setOutPath(null);
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label="Export">
              <DownloadSimpleIcon />
              Export
            </Button>
          }
        />
        <TooltipContent>Export the timeline to a video file, or queue several exports</TooltipContent>
      </Tooltip>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Export timeline</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4 text-sm">
            {/* output path */}
            <div className="flex flex-col gap-1.5">
              <Label>Output file</Label>
              <div className="flex items-center gap-2">
                <div
                  className="flex h-9 w-full min-w-0 items-center truncate rounded-md border border-border-color bg-bg-primary px-3 text-sm text-text-secondary"
                  title={outPath ?? ''}
                >
                  {outPath ?? 'Choose a destination…'}
                </div>
                <Button variant="outline" size="sm" onClick={handleChoosePath} className="shrink-0">
                  Choose…
                </Button>
              </div>
            </div>

            {/* width / height / fps */}
            <div className="flex items-center gap-2">
              <div className="flex flex-1 flex-col gap-1.5">
                <Label>Width</Label>
                <Input type="number" min={1} value={width} onChange={(e) => setWidth(e.target.value)} />
              </div>
              <span className="mt-5 text-text-secondary">×</span>
              <div className="flex flex-1 flex-col gap-1.5">
                <Label>Height</Label>
                <Input type="number" min={1} value={height} onChange={(e) => setHeight(e.target.value)} />
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                <Label>FPS</Label>
                <Input type="number" min={1} step="any" value={fps} onChange={(e) => setFps(e.target.value)} />
              </div>
            </div>

            {/* D-401 — loudness target. Off leaves the mix exactly as the tracks sum. */}
            <div className="flex flex-col gap-1.5">
              <Label>Audio loudness</Label>
              <div className="flex items-center gap-2">
                <Select value={loudnessChoice} onValueChange={(v) => setLoudnessChoice(v as LoudnessChoice)}>
                  <SelectTrigger className="h-9 flex-1">
                    <SelectValue>{LOUDNESS_LABELS[loudnessChoice]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(LOUDNESS_LABELS) as LoudnessChoice[]).map((k) => (
                      <SelectItem key={k} value={k}>
                        {LOUDNESS_LABELS[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {loudnessChoice === 'custom' && (
                  <>
                    <Input
                      type="number"
                      step="any"
                      className="w-20"
                      aria-label="Target loudness (LUFS)"
                      value={customLufs}
                      onChange={(e) => setCustomLufs(e.target.value)}
                    />
                    <span className="text-xs text-text-secondary">LUFS</span>
                    <Input
                      type="number"
                      step="any"
                      className="w-20"
                      aria-label="True-peak ceiling (dBTP)"
                      value={customPeak}
                      onChange={(e) => setCustomPeak(e.target.value)}
                    />
                    <span className="text-xs text-text-secondary">dBTP</span>
                  </>
                )}
              </div>
              {loudnessChoice !== 'off' && loudnessChoice !== 'custom' && (
                <p className="text-[11px] text-text-secondary/70">
                  Measures the finished mix, then applies one gain and a true-peak limiter to reach{' '}
                  {LOUDNESS_PRESETS[loudnessChoice].integratedLufs} LUFS with peaks under{' '}
                  {LOUDNESS_PRESETS[loudnessChoice].truePeakDbtp} dBTP. The picture is not re-encoded.
                </p>
              )}
            </div>

            {/* per-clip overrides — fit / freeze (export-time-only, B-074/D-188).
                D-276 dropped the per-clip SPEED override that used to sit here:
                D-236 later gave every clip a real, persisted Speed (Retime)
                section in its own Inspector — reachable, keyframeable, and
                already what export renders from FIRST (`timelineExport.ts`'s
                own `resolveSpeedSegments`: a clip's persisted `speed_points`,
                else this dialog's flat override, else 1×). Once that existed,
                this flat export-time-only field was a second, less capable
                place to set the exact same thing — confirmed live (owner,
                2026-09-10) as confusing rather than useful. Freeze has no
                persisted equivalent (no `Clip`/`EditOp` field holds "extend to
                the export's own total duration" — a genuinely export-specific
                fact, not a property of the clip itself), so it stays; `fit`
                stays for the same reason (`fitOverrides`'s own stretch escape
                hatch, B-074, has no timeline-model equivalent either). The
                underlying `speedOverrides` plumbing in `editorExport.ts`/
                `timelineExport.ts` is untouched — still real state
                `compileEditorExportArgs` reads, just never populated from
                this dialog now; a scripted MCP `editor_export` call can still
                pass one. */}
            {clips.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <Label>Per-clip export options</Label>
                <ScrollArea className="max-h-48 rounded-md border border-border-color">
                  <div className="flex flex-col divide-y divide-border-color">
                    {clips.map((clip) => (
                      <div key={clip.id} className="flex items-center gap-2 px-2.5 py-1.5">
                        <span className="min-w-0 flex-1 truncate text-xs text-text-primary" title={clip.name}>
                          {clip.name}
                        </span>
                        <Select
                          value={fitOverrides[clip.id] ?? 'fit'}
                          onValueChange={(v) => setFitOverrides((s) => ({ ...s, [clip.id]: v as 'fit' | 'stretch' }))}
                        >
                          <SelectTrigger className="h-7 w-24 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="fit">Fit</SelectItem>
                            <SelectItem value="stretch">Stretch</SelectItem>
                          </SelectContent>
                        </Select>
                        <div className="flex shrink-0 items-center gap-1" title="Freeze this clip's last frame to fill the export's total runtime">
                          <Switch
                            id={`freeze-${clip.id}`}
                            checked={!!freezeOverrides[clip.id]}
                            onCheckedChange={(v) => setFreezeOverrides((s) => ({ ...s, [clip.id]: v }))}
                          />
                          <Label htmlFor={`freeze-${clip.id}`} className="cursor-pointer text-[11px] text-text-secondary">
                            Freeze
                          </Label>
                        </div>
                      </div>
                    ))}
                  </div>
                </ScrollArea>
                <p className="text-[11px] text-text-secondary/70">
                  Audio (gain, ducking, fades) mixes in automatically from the timeline's own tracks — no separate control
                  needed here.
                </p>
              </div>
            )}

            {validationError && (
              <span className="flex items-center gap-1.5 text-xs text-red-400">
                <XCircleIcon size={12} /> {validationError}
              </span>
            )}

            {/* D-256 — the parts of a Colorist grade a 3D LUT cannot carry.
                Shown, not swallowed: this is the one case where the exported
                file legitimately differs from what the Colorist tab shows, and
                only the user can decide whether that is acceptable. */}
            {gradeNotes.length > 0 && (
              <div className="flex flex-col gap-1">
                {gradeNotes.map((note) => (
                  <span key={note} className="flex items-start gap-1.5 text-xs text-text-secondary">
                    <WarningIcon size={12} className="mt-0.5 shrink-0" /> {note}
                  </span>
                ))}
              </div>
            )}

            {/* the queue */}
            {jobs.length > 0 && (
              <>
                <Separator />
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <Label>Export queue</Label>
                    <Button variant="ghost" size="xs" onClick={clearFinished}>
                      Clear finished
                    </Button>
                  </div>
                  <div className="flex flex-col gap-1">
                    {jobs.map((job) => (
                      <div key={job.id} className="flex flex-col rounded-md border border-border-color px-2.5 py-1.5">
                        <div className="flex items-center gap-2">
                          <StatusIcon status={job.status} />
                          <span className="min-w-0 flex-1 truncate text-xs text-text-primary" title={job.outPath}>
                            {job.name}
                          </span>
                          <span
                            className={
                              'shrink-0 text-[11px] ' +
                              (job.status === 'failed' ? 'text-red-400' : job.status === 'done' ? 'text-green-400' : 'text-text-secondary')
                            }
                            title={job.error ?? undefined}
                          >
                            {statusLabel[job.status]}
                          </span>
                        </div>
                        {/* D-362 — the real percentage while it renders. */}
                        <JobProgress job={job} />
                        {job.loudnessReport && (
                          <span className="mt-1 text-[10px] text-text-secondary tabular-nums">
                            {loudnessSummary(job.loudnessReport)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button onClick={() => void handleAddToQueue()} disabled={queueing}>
              {queueing ? 'Baking grades…' : 'Add to queue'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
