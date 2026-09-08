/**
 * @chroma/editor — the Edit tab's own Export button + dialog + queue
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
 * `Dialog`/`DialogContent` from `@chroma/ui`, a native `save()` picker for
 * the output path, plain elements + colour tokens for the rest. What's
 * different here, because the underlying capability is different: per-clip
 * `speedOverrides`/`fitOverrides`/`freezeOverrides` rows (Colorist's export
 * has no multi-clip timeline to speak of) and a real job QUEUE instead of a
 * single blocking progress bar — `editorExport.ts`'s own module doc and
 * D-198 explain why sequential-only this pass, not decorative, not parallel.
 *
 * Width/height default from the project's own composition size
 * (`chroma_timeline_clip_geometry`'s `compWidth`/`compHeight` — the SAME
 * command `useClipGeometry.ts`/`ClipInspectorPanel.tsx` already use for
 * exactly this fact, D-193), falling back to a plain 1920×1080 when there is
 * no clip yet to derive it from (a brand-new, empty project). fps defaults
 * to the timeline's own rate (`timelineFps`).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { AlertTriangle, CheckCircle2, Download, Loader2, XCircle } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
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
} from '@chroma/ui';

import { usePanelOpen } from './panelRegistry';
import { useEditorTimelineStore } from './timelineStore';
import { timelineFps, type Clip, type Timeline } from './timeline';
import { useExportQueueStore, type ExportJobStatus } from './exportQueueStore';
// D-256 — bake each graded clip's Colorist grade into a .cube before the
// queue freezes this job's ffmpeg argv against those file paths.
import { warmGradeLuts } from './gradeLuts';

/** Mirrors `chroma::edit::ClipGeometry` — see `useClipGeometry.ts`'s own
 *  identical DTO. Not reused directly: that hook is keyed to a SELECTED
 *  clip for the on-canvas overlay's use case, whereas this dialog only ever
 *  wants "the project's own composition size", once, when it opens. */
interface ClipGeometry {
  compWidth: number;
  compHeight: number;
}

const FALLBACK_WIDTH = 1920;
const FALLBACK_HEIGHT = 1080;

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

async function fetchCompositionSize(tl: Timeline | null): Promise<{ width: number; height: number }> {
  if (!tl) return { width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT };
  for (const [trackIndex, track] of tl.tracks.entries()) {
    if (track.kind !== 'video') continue;
    for (let clipIndex = 0; clipIndex < track.clips.length; clipIndex++) {
      try {
        const geo = await invoke<ClipGeometry>('chroma_timeline_clip_geometry', { track: trackIndex, clip: clipIndex });
        if (geo.compWidth > 0 && geo.compHeight > 0) return { width: geo.compWidth, height: geo.compHeight };
      } catch {
        // fall through to the next clip / the final fallback below
      }
    }
  }
  return { width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT };
}

const statusLabel: Record<ExportJobStatus, string> = {
  queued: 'Queued',
  running: 'Exporting…',
  done: 'Done',
  failed: 'Failed',
};

function StatusIcon({ status }: { status: ExportJobStatus }) {
  if (status === 'running') return <Loader2 className="size-3.5 animate-spin text-accent" />;
  if (status === 'done') return <CheckCircle2 className="size-3.5 text-green-400" />;
  if (status === 'failed') return <XCircle className="size-3.5 text-red-400" />;
  return <span className="size-3.5 rounded-full border border-border-color inline-block" />;
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
  const [fps, setFps] = useState(String(timelineFps(timeline)));
  const [speedOverrides, setSpeedOverrides] = useState<Record<string, string>>({});
  const [fitOverrides, setFitOverrides] = useState<Record<string, 'fit' | 'stretch'>>({});
  const [freezeOverrides, setFreezeOverrides] = useState<Record<string, boolean>>({});
  const [validationError, setValidationError] = useState<string | null>(null);
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
    setSpeedOverrides({});
    setFitOverrides({});
    setFreezeOverrides({});
    setValidationError(null);
    setFps(String(timelineFps(tl)));
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

    const speed: Record<string, number> = {};
    for (const [clipId, raw] of Object.entries(speedOverrides)) {
      const n = parseFloat(raw);
      if (Number.isFinite(n) && n > 0 && n !== 1) speed[clipId] = n;
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
      speedOverrides: Object.keys(speed).length > 0 ? speed : undefined,
      fitOverrides: Object.keys(fitOverrides).length > 0 ? fitOverrides : undefined,
      freezeOverrides: Object.keys(freezeOverrides).length > 0 ? freezeOverrides : undefined,
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
              <Download />
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

            {/* per-clip overrides — speed / fit / freeze (export-time-only, B-074/D-188) */}
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
                        <Input
                          type="number"
                          min={0.1}
                          step="0.1"
                          placeholder="1×"
                          value={speedOverrides[clip.id] ?? ''}
                          onChange={(e) => setSpeedOverrides((s) => ({ ...s, [clip.id]: e.target.value }))}
                          className="h-7 w-16 text-xs"
                          title="Speed multiplier (export-time only)"
                        />
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
                <XCircle size={12} /> {validationError}
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
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {note}
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
                      <div key={job.id} className="flex items-center gap-2 rounded-md border border-border-color px-2.5 py-1.5">
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
