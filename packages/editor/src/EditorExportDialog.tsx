/**
 * @apelles/editor — the Export button, the Export sheet and the export queue's
 * top-bar progress (D-198 queue, D-441 redesign; B-367).
 *
 * **What it is.** Everything the chrome bar's `headerAction` shows for export:
 *
 * - **The top-bar progress pill** (when there are jobs): "Exporting 42%" with a
 *   thin bar, or "1 queued" / "Exported" / "Export failed". Its popover lists
 *   every job with its real progress and time left (the compositor's own
 *   counters, D-362), the loudness result in words, and per job Cancel (queued
 *   or running — a real backend cancel, D-441), Show in Finder, Try again, and a
 *   dimmed "Post…" for later (roadmap 00d). Exports run in the background: the
 *   sheet closes the moment Export is pressed and editing carries on.
 * - **The Export sheet** (approved mockup `scratch/panel-redesign-mockup.html`,
 *   "Export", revision 2 — `docs/notes/panel-redesign.md` §5): destinations on
 *   the left (File; YouTube / Instagram / TikTok drawn dimmed under "Publish ·
 *   soon", no behaviour), the timeline picker, the preset chips (built-ins and
 *   the person's saved presets, one table with `editor_export(preset=…)` —
 *   `exportPresets.ts`), the pre-filled name and folder
 *   (`~/Movies/<project>/<timeline>.<ext>`, never over an existing file), one
 *   summary line with the size estimate and a warning icon when the export will
 *   differ from the preview, and "More settings": size, frame rate, loudness,
 *   loudest peak, format (H.264 MP4 or the ProRes 422 HQ master), encoder
 *   (hardware VideoToolbox by default, or software — D-446), Save as preset,
 *   and "Clip exceptions" (per clip "Stretch to fill" / "Hold last frame", the
 *   export-time `fitOverrides` / `freezeOverrides`). Footer: Cancel · Export.
 *
 * Every action is the function an agent's tool calls: Export enqueues through
 * `useExportQueueStore.enqueue` after `prepareEditorExport` (what
 * `editor_export` runs), the chips read the same preset table, Save as preset
 * is `useExportPresetStore.savePreset` (`editor_save_export_preset`), Cancel is
 * the queue's `cancel` (`editor_cancel_export`).
 *
 * **What it does NOT do.** Compile or run anything itself (`editorExport.ts`,
 * `exportQueueStore.ts`), or publish (roadmap 00d: the destinations are drawn so
 * the sheet has room for them, nothing more).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import {
  ArrowClockwiseIcon,
  BookmarkSimpleIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  DeviceMobileIcon,
  DownloadSimpleIcon,
  FileVideoIcon,
  FilmReelIcon,
  FolderOpenIcon,
  InstagramLogoIcon,
  MicrophoneIcon,
  ShareNetworkIcon,
  SquareIcon,
  StopIcon,
  TiktokLogoIcon,
  WarningIcon,
  XCircleIcon,
  XIcon,
  YoutubeLogoIcon,
} from '@phosphor-icons/react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@apelles/ui';

import { usePanelOpen } from './panelRegistry';
import { useEditorTimelineStore } from './timelineStore';
import { timelineDuration, timelineFps, type Clip, type Timeline } from './timeline';
import { useExportQueueStore, type ExportJob } from './exportQueueStore';
import { prepareEditorExport } from './editorExport';
import { warmCompositionSize } from './compositionSize';
import {
  DEFAULT_TRUE_PEAK_DBTP,
  LOUDNESS_PRESETS,
  type LoudnessPresetName,
  type LoudnessReport,
} from './loudness';
import {
  DEFAULT_EXPORT_ENCODER,
  EXPORT_ENCODER_LABEL,
  EXPORT_ENCODERS,
  EXPORT_FORMAT_INFO,
  EXPORT_FORMATS,
  estimateExportBytes,
  fmtApproxSize,
  type ExportEncoder,
  type ExportFormat,
} from './exportFormat';
import {
  BUILT_IN_EXPORT_PRESETS,
  defaultExportPath,
  fmtSigned,
  initialPresetFor,
  loudnessLabel,
  presetExportArgs,
  shapeOf,
  useExportPresetStore,
  type ExportLoudness,
  type ExportPreset,
  type ExportPresetIcon,
} from './exportPresets';

/** The sheet's widest size, px (the approved mockup's 880). */
export const EXPORT_SHEET_MAX_WIDTH_PX = 880;
/** The tallest it grows to, px; shorter content makes it shorter. */
export const EXPORT_SHEET_MAX_HEIGHT_PX = 760;
/** The margin it always keeps from every window edge, px, so the app never
 *  shows through a sliver beside it and it never runs under the window's edge
 *  (owner, 2026-11-03: "over lapping"). */
export const EXPORT_SHEET_INSET_PX = 32;

/** The sheet's size against the window: at most the mockup's width and a
 *  maximum height, always {@link EXPORT_SHEET_INSET_PX} inside every edge; its
 *  height otherwise follows its content (the body scrolls inside it). The
 *  dialog primitive centres it. */
export function exportSheetBox(): { width: string; maxHeight: string } {
  const inset = 2 * EXPORT_SHEET_INSET_PX;
  return {
    width: `min(${EXPORT_SHEET_MAX_WIDTH_PX}px, calc(100vw - ${inset}px))`,
    maxHeight: `min(${EXPORT_SHEET_MAX_HEIGHT_PX}px, calc(100vh - ${inset}px))`,
  };
}

const FALLBACK_WIDTH = 1920;
const FALLBACK_HEIGHT = 1080;
/** Frame rates offered besides the timeline's own. */
const FPS_CHOICES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

type LoudnessChoice = 'off' | LoudnessPresetName | 'custom';

const LOUDNESS_CHOICE_LABELS: Record<LoudnessChoice, string> = {
  off: 'As mixed (off)',
  youtube: 'YouTube: −14 LUFS',
  broadcast: 'Broadcast: −23 LUFS',
  podcast: 'Podcast: −16 LUFS',
  custom: 'Custom',
};

const PRESET_ICON: Record<ExportPresetIcon, typeof YoutubeLogoIcon> = {
  youtube: YoutubeLogoIcon,
  mobile: DeviceMobileIcon,
  square: SquareIcon,
  master: FilmReelIcon,
  podcast: MicrophoneIcon,
  saved: BookmarkSimpleIcon,
};

/** Everything the sheet's settings hold. A preset writes all of it at once;
 *  changing any one value by hand leaves no preset selected ("Custom"). */
interface ExportValues {
  /** `null` = the timeline's own size / rate. */
  width: number | null;
  height: number | null;
  fps: number | null;
  loudness: LoudnessChoice;
  customLufs: number;
  peakDbtp: number;
  format: ExportFormat;
}

function valuesOf(p: ExportPreset): ExportValues {
  const l = p.loudness;
  return {
    width: p.width,
    height: p.height,
    fps: p.fps,
    loudness: typeof l === 'object' ? 'custom' : l,
    customLufs: typeof l === 'object' ? l.lufs : -14,
    peakDbtp: typeof l === 'object' ? l.peakDbtp : DEFAULT_TRUE_PEAK_DBTP,
    format: p.format,
  };
}

function loudnessOf(v: ExportValues): ExportLoudness {
  if (v.loudness === 'custom') return { lufs: v.customLufs, peakDbtp: v.peakDbtp };
  return v.loudness;
}

/** `7:44` / `1:02:03`. */
function fmtLength(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** `16:9`, `9:16`, `1:1`, else `W×H`. */
function aspectLabel(w: number, h: number): string {
  const g = (a: number, b: number): number => (b === 0 ? a : g(b, a % b));
  const d = g(w, h);
  const [a, b] = [w / d, h / d];
  return a <= 32 && b <= 32 ? `${a}:${b}` : `${w}×${h}`;
}

function fmtFps(fps: number): string {
  return String(Number(fps.toFixed(3)));
}

/** Every VIDEO clip on `tl`, in track order — the clips "Clip exceptions"
 *  can be set for (an audio clip has no framing to stretch or hold). */
function videoClips(tl: Timeline | null): Clip[] {
  if (!tl) return [];
  return tl.tracks.filter((t) => t.kind === 'video').flatMap((t) => t.clips.filter((c) => !c.text && !c.adjustment));
}

function splitPath(path: string): { dir: string; stem: string; ext: string } {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dir = slash >= 0 ? path.slice(0, slash) : '';
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? { dir, stem: base.slice(0, dot), ext: base.slice(dot + 1) } : { dir, stem: base, ext: '' };
}

/** `~/Movies/Five Levels` — the home folder shortened, the way Finder's path
 *  bar reads. */
function prettyDir(dir: string): string {
  const m = /^\/Users\/[^/]+(\/.*)?$/.exec(dir);
  return m ? `~${m[1] ?? ''}` : dir;
}

/** `Loudness raised from −21.6 to −14.0 LUFS, peaks under −1 dB.` */
function loudnessSentence(r: LoudnessReport): string {
  if (r.skipped || !r.before || !r.after) return r.skipped ? `Loudness left as mixed: ${r.skipped}.` : '';
  const verb = r.after.integratedLufs >= r.before.integratedLufs ? 'raised' : 'lowered';
  return (
    `Loudness ${verb} from ${fmtSigned(r.before.integratedLufs)} to ${fmtSigned(r.after.integratedLufs)} LUFS, ` +
    `peaks under ${fmtSigned(r.target.truePeakDbtp)} dB` +
    (r.targetMet ? '.' : ' (target not fully reached).')
  );
}

/** A rejected promise's reason, in words. */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `1m 20s` / `18s` / `1h 04m`. */
function shortDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const [h, m, s] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// ───────────────────────────────────────────────────────────── top bar

/** The queue's top-bar pill and its popover. Renders nothing without jobs. */
function ExportQueueButton() {
  const jobs = useExportQueueStore((s) => s.jobs);
  const [open, setOpen] = useState(false);
  if (jobs.length === 0) return null;
  const running = jobs.find((j) => j.status === 'running');
  const queued = jobs.filter((j) => j.status === 'queued').length;
  const failed = jobs.some((j) => j.status === 'failed');
  const percent = running?.progress?.state === 'running' ? running.progress.percent : null;
  let label: string;
  let icon: React.ReactNode;
  if (running) {
    label = percent === null ? 'Exporting…' : `Exporting ${Math.floor(percent)}%`;
    icon = <CircleNotchIcon className="size-3.5 animate-spin text-accent-text" />;
  } else if (queued > 0) {
    label = `${queued} queued`;
    icon = <CircleNotchIcon className="size-3.5 text-text-secondary" />;
  } else if (failed) {
    label = 'Export failed';
    icon = <XCircleIcon weight="fill" className="size-3.5 text-destructive" />;
  } else {
    label = 'Exported';
    icon = <CheckCircleIcon weight="fill" className="size-3.5 text-accent-text" />;
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-chroma-export-queue-pill
            aria-label={`Exports: ${label}`}
            className="flex h-6 items-center gap-1.5 rounded-sm bg-bg-secondary px-2 text-xs text-text-primary hover:bg-card-active"
          >
            {icon}
            <span className="tabular-nums">{label}</span>
            {running && (
              <span className="h-[3px] w-14 overflow-hidden rounded-full bg-card-active" aria-hidden>
                <span className="block h-full bg-accent" style={{ width: `${percent ?? 0}%` }} />
              </span>
            )}
          </button>
        }
      />
      <PopoverContent align="end" className="w-[380px] gap-2 p-2.5" data-chroma-export-queue>
        <div className="flex items-center">
          <span className="flex-1 text-sm font-semibold text-text-primary">Exports</span>
          <Button variant="ghost" size="xs" onClick={() => useExportQueueStore.getState().clearFinished()}>
            Clear finished
          </Button>
        </div>
        <div className="flex max-h-[60vh] flex-col gap-1.5 overflow-y-auto">
          {[...jobs].reverse().map((job) => (
            <QueueJob key={job.id} job={job} />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function QueueJob({ job }: { job: ExportJob }) {
  const p = job.progress;
  const live = job.status === 'running' && p?.state === 'running' ? p : null;
  const status =
    job.status === 'running'
      ? live
        ? live.phase === 'concatenating'
          ? 'Joining…'
          : live.phase === 'normalising'
            ? 'Levelling…'
            : `${Math.floor(live.percent)}%${live.etaMs !== undefined ? ` · ${shortDuration(live.etaMs)} left` : ''}`
        : 'Exporting…'
      : job.status === 'queued'
        ? 'Waiting'
        : job.status === 'done'
          ? 'Done'
          : job.status === 'cancelled'
            ? 'Cancelled'
            : 'Failed';
  const icon =
    job.status === 'running' ? (
      <CircleNotchIcon className="size-3.5 shrink-0 animate-spin text-accent-text" />
    ) : job.status === 'done' ? (
      <CheckCircleIcon weight="fill" className="size-3.5 shrink-0 text-accent-text" />
    ) : job.status === 'failed' ? (
      <XCircleIcon weight="fill" className="size-3.5 shrink-0 text-destructive" />
    ) : (
      <span className="size-3.5 shrink-0 rounded-full border border-text-tertiary" />
    );
  const hint =
    job.status === 'running' || job.status === 'queued'
      ? `${job.preset ?? 'Custom settings'}. Keep editing; it runs in the background.`
      : job.status === 'done' && job.loudnessReport
        ? loudnessSentence(job.loudnessReport)
        : job.status === 'cancelled'
          ? 'Stopped. The unfinished file was removed.'
          : null;
  return (
    <div
      data-chroma-export-job={job.id}
      data-chroma-export-job-status={job.status}
      className="flex flex-col gap-1.5 rounded-sm bg-bg-secondary p-2"
    >
      <div className="flex items-center gap-2 text-sm">
        {icon}
        <span className="min-w-0 flex-1 truncate text-text-primary" title={job.outPath}>
          {job.name}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-text-secondary">{status}</span>
      </div>
      {job.status === 'running' && live && <Progress value={live.percent} />}
      {hint && <span className="text-xs leading-snug text-text-secondary">{hint}</span>}
      {job.status === 'failed' && job.error && (
        <span className="line-clamp-3 text-xs leading-snug text-destructive" title={job.error}>
          {job.error}
        </span>
      )}
      <div className="flex flex-wrap gap-1.5">
        {(job.status === 'running' || job.status === 'queued') && (
          <Button
            variant="outline"
            size="xs"
            data-chroma-export-cancel={job.id}
            onClick={() => void useExportQueueStore.getState().cancel(job.id)}
          >
            <StopIcon /> Cancel
          </Button>
        )}
        {job.status === 'done' && (
          <>
            <Button variant="outline" size="xs" onClick={() => void invoke('show_in_finder', { path: job.outPath }).catch(() => {})}>
              <FolderOpenIcon /> Show in Finder
            </Button>
            <Tooltip>
              <TooltipTrigger render={<span />}>
                <Button variant="outline" size="xs" disabled>
                  <ShareNetworkIcon /> Post…
                </Button>
              </TooltipTrigger>
              <TooltipContent>Publishing to YouTube, Instagram and TikTok is coming later</TooltipContent>
            </Tooltip>
          </>
        )}
        {(job.status === 'failed' || job.status === 'cancelled') && (
          <Button
            variant="outline"
            size="xs"
            data-chroma-export-retry={job.id}
            onClick={() => useExportQueueStore.getState().retry(job.id)}
          >
            <ArrowClockwiseIcon /> Try again
          </Button>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────── the sheet

export function EditorExportDialog() {
  // D-252 — `debug_set_popover_open('export-dialog', …)` drives this flag.
  const [open, setOpen] = usePanelOpen('export-dialog');
  return (
    <div className="flex items-center gap-1.5">
      <ExportQueueButton />
      <Tooltip>
        <TooltipTrigger
          render={
            // D-432 P5 / spec §4.2 — a secondary button in the top bar.
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setOpen(true)}
              aria-label="Export"
              className="h-6 gap-1.5 rounded-sm bg-bg-secondary px-2.5 text-sm font-medium text-text-primary hover:bg-card-active"
            >
              <DownloadSimpleIcon />
              Export
            </Button>
          }
        />
        <TooltipContent>Export the timeline to a video file</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          showCloseButton={false}
          data-chroma-export-dialog
          style={exportSheetBox()}
          className="grid max-w-none grid-cols-[200px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] gap-0 overflow-hidden bg-surface-raised p-0 sm:max-w-none"
        >
          {open && <ExportSheet onClose={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ExportSheet({ onClose }: { onClose: () => void }) {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const timelines = useEditorTimelineStore((s) => s.timelines);
  const projectKey = useEditorTimelineStore((s) => s.openProjectKey);
  const userPresets = useExportPresetStore((s) => s.userPresets);

  /** `null` = the active timeline. */
  const [timelineId, setTimelineId] = useState<string | null>(null);
  const [otherTimeline, setOtherTimeline] = useState<Timeline | null>(null);
  const target = timelineId && timelineId !== timeline?.id ? otherTimeline : timeline;
  const [comp, setComp] = useState<{ width: number; height: number } | null>(null);
  const [presetId, setPresetId] = useState<string | null>(null);
  const [values, setValues] = useState<ExportValues>(() => valuesOf(BUILT_IN_EXPORT_PRESETS[0]));
  const [outPath, setOutPath] = useState<string>('');
  /** D-446 — not part of a preset: it changes how fast the file is made, not
   *  what the file is, so picking it leaves the chosen preset selected. */
  const [encoder, setEncoder] = useState<ExportEncoder>(DEFAULT_EXPORT_ENCODER);
  /** Set once the person picks a folder or edits the name: a format change then
   *  only swaps the extension instead of re-deriving the default. */
  const pathTouched = useRef(false);
  const [more, setMore] = useState(false);
  const [fitOverrides, setFitOverrides] = useState<Record<string, 'fit' | 'stretch'>>({});
  const [freezeOverrides, setFreezeOverrides] = useState<Record<string, boolean>>({});
  const [presetName, setPresetName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const allPresets = useMemo(() => [...BUILT_IN_EXPORT_PRESETS, ...userPresets], [userPresets]);
  const fps = timelineFps(target);
  const seconds = target ? timelineDuration(target) / fps : 0;
  const tlW = comp?.width ?? FALLBACK_WIDTH;
  const tlH = comp?.height ?? FALLBACK_HEIGHT;
  const outW = values.width ?? tlW;
  const outH = values.height ?? tlH;
  const outFps = values.fps ?? fps;
  const clips = useMemo(() => videoClips(target), [target]);

  // The timeline's size, then the preset that shape opens on, then the default
  // path — again whenever the timeline being exported changes.
  const targetName = target?.name || timelines.find((t) => t.id === (timelineId ?? timeline?.id))?.name || 'Timeline';
  const targetKey = timelineId ?? timeline?.id ?? '';
  useEffect(() => {
    let cancelled = false;
    void warmCompositionSize(timelineId ?? undefined).then((size) => {
      if (cancelled) return;
      const s = size ?? { width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT };
      setComp(s);
      const p = initialPresetFor(shapeOf(s.width, s.height));
      setPresetId(p.id);
      setValues(valuesOf(p));
    });
    return () => {
      cancelled = true;
    };
  }, [timelineId]);

  useEffect(() => {
    if (pathTouched.current) {
      // Keep the person's folder and name; follow the format's extension.
      setOutPath((cur) => {
        if (!cur) return cur;
        const { dir, stem } = splitPath(cur);
        return `${dir}/${stem}.${EXPORT_FORMAT_INFO[values.format].ext}`;
      });
      return;
    }
    let cancelled = false;
    void defaultExportPath(projectKey, targetName, values.format)
      .then((p) => {
        if (!cancelled) setOutPath(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectKey, targetName, targetKey, values.format]);

  const choosePreset = (p: ExportPreset) => {
    setPresetId(p.id);
    setValues(valuesOf(p));
    setError(null);
  };
  /** A hand change leaves no preset selected. */
  const edit = (patch: Partial<ExportValues>) => {
    setPresetId(null);
    setValues((v) => ({ ...v, ...patch }));
    setError(null);
  };

  const chooseTimeline = async (id: string) => {
    setFitOverrides({});
    setFreezeOverrides({});
    setError(null);
    if (id === timeline?.id) {
      setOtherTimeline(null);
      setTimelineId(null);
      return;
    }
    const read = await invoke<Timeline>('chroma_timeline_get_by_id', { id }).then(
      (doc) => ({ doc }),
      (e: unknown) => ({ error: errorText(e) }),
    );
    if ('error' in read) {
      setError(`Could not read that timeline: ${read.error}`);
      return;
    }
    setOtherTimeline(read.doc);
    setTimelineId(id);
  };

  const changeFolder = async () => {
    const { stem } = splitPath(outPath);
    const ext = EXPORT_FORMAT_INFO[values.format].ext;
    const picked = await save({
      title: 'Export to',
      defaultPath: outPath || `${stem || targetName}.${ext}`,
      filters: [{ name: EXPORT_FORMAT_INFO[values.format].label, extensions: [ext] }],
    }).then(
      (chosen) => ({ chosen }),
      (e: unknown) => ({ error: errorText(e) }),
    );
    if ('error' in picked) {
      setError(`The folder picker failed: ${picked.error}`);
      return;
    }
    if (picked.chosen) {
      pathTouched.current = true;
      setOutPath(picked.chosen);
    }
  };

  const savePreset = () => {
    const out = useExportPresetStore.getState().savePreset({
      name: presetName,
      width: values.width,
      height: values.height,
      fps: values.fps,
      loudness: values.loudness,
      loudnessLufs: values.customLufs,
      truePeakDbtp: values.peakDbtp,
      format: values.format,
    });
    if ('error' in out) {
      setError(`Could not save the preset: ${out.error}`);
      return;
    }
    setPresetName('');
    setPresetId(out.id);
  };

  const shapeDiffers = shapeOf(outW, outH) !== shapeOf(tlW, tlH);
  const warnings = [
    ...(shapeDiffers
      ? [
          `This timeline is ${aspectLabel(tlW, tlH)}; ${outW} × ${outH} is ${aspectLabel(outW, outH)}, so the picture is stretched to fit. Make a ${aspectLabel(outW, outH)} timeline instead (the Clipper, or the timeline's output size).`,
        ]
      : []),
    ...notes,
  ];
  const preset = presetId ? allPresets.find((p) => p.id === presetId) : undefined;

  const runExport = async () => {
    setError(null);
    if (!outPath) {
      setError('Choose where to save the file.');
      return;
    }
    if (values.loudness === 'custom' && !Number.isFinite(values.customLufs)) {
      setError('Give the loudness target in LUFS.');
      return;
    }
    const exportArgs = {
      outPath,
      ...(timelineId && timelineId !== timeline?.id ? { timelineId } : {}),
      ...presetExportArgs({
        width: values.width,
        height: values.height,
        fps: values.fps,
        loudness: loudnessOf(values),
        format: values.format,
      }),
      encoder,
      fitOverrides: Object.keys(fitOverrides).length > 0 ? fitOverrides : undefined,
      freezeOverrides: Object.values(freezeOverrides).some(Boolean) ? freezeOverrides : undefined,
    };
    setBusy(true);
    const prepared = await prepareEditorExport(exportArgs);
    setBusy(false);
    if ('error' in prepared) {
      setError(prepared.error);
      return;
    }
    setNotes(prepared.gradeWarnings);
    const name = outPath.split(/[\\/]/).pop() ?? outPath;
    const queued = useExportQueueStore.getState().enqueue(name, exportArgs, prepared.timeline, undefined, preset?.name);
    if ('error' in queued) {
      setError(queued.error);
      return;
    }
    if (presetId) useExportPresetStore.getState().setLastPreset(shapeOf(tlW, tlH), presetId);
    onClose();
  };

  const { dir, stem, ext } = splitPath(outPath);
  const loudnessWords = loudnessLabel(loudnessOf(values));

  return (
    <>
      {/* Destinations. Publishing is drawn, not built (roadmap 00d). */}
      <nav className="flex flex-col gap-0.5 border-r border-border-color bg-surface px-2 py-3.5" aria-label="Export to">
        <span className="px-2 pt-1.5 pb-1 text-[10px] font-semibold tracking-wide text-text-tertiary uppercase">Export to</span>
        <button
          type="button"
          aria-current="true"
          className="flex h-[30px] items-center gap-2 rounded-sm bg-card-active px-2 text-left text-sm text-text-primary"
        >
          <FileVideoIcon className="size-4" />
          File
        </button>
        <span className="mt-2.5 px-2 pt-1.5 pb-1 text-[10px] font-semibold tracking-wide text-text-tertiary uppercase">
          Publish · soon
        </span>
        {[
          { label: 'YouTube', Icon: YoutubeLogoIcon },
          { label: 'Instagram', Icon: InstagramLogoIcon },
          { label: 'TikTok', Icon: TiktokLogoIcon },
        ].map(({ label, Icon }) => (
          <Tooltip key={label}>
            <TooltipTrigger
              render={
                <span
                  aria-disabled="true"
                  data-chroma-export-publish={label}
                  className="flex h-[30px] cursor-default items-center gap-2 rounded-sm px-2 text-sm text-text-secondary opacity-50"
                >
                  <Icon className="size-4" />
                  {label}
                </span>
              }
            />
            <TooltipContent>Coming later: connect your account, then post straight from here</TooltipContent>
          </Tooltip>
        ))}
      </nav>

      <div className="flex min-h-0 flex-col" data-chroma-export-sheet>
        <div className="flex items-center gap-2.5 px-5 pt-4 pb-2.5">
          <DialogTitle className="text-lg font-semibold text-text-primary">Export</DialogTitle>
          <Select value={timelineId ?? timeline?.id ?? ''} onValueChange={(v) => typeof v === 'string' && v && void chooseTimeline(v)}>
            <SelectTrigger className="data-[size=default]:h-7 w-[260px] text-sm" data-chroma-field="export-timeline" aria-label="Timeline">
              <SelectValue>
                <span className="truncate">
                  {targetName}
                  <span className="text-text-tertiary">
                    {' '}
                    · {fmtLength(seconds)} · {aspectLabel(tlW, tlH)}
                  </span>
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {timelines.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {(t.active && timeline ? timeline.name : t.name) || 'Untitled timeline'}
                  {t.output ? ` · ${aspectLabel(t.output.width, t.output.height)}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="flex-1" />
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
            <XIcon />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-5 pb-3">
          <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Preset" data-chroma-export-presets>
            {allPresets.map((p) => {
              const Icon = PRESET_ICON[p.icon];
              const on = p.id === presetId;
              return (
                <Tooltip key={p.id}>
                  <TooltipTrigger
                    render={
                      <div
                        role="radio"
                        aria-checked={on}
                        tabIndex={0}
                        data-chroma-export-preset={p.id}
                        onClick={() => choosePreset(p)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            choosePreset(p);
                          }
                        }}
                        className={`group relative flex h-10 cursor-pointer items-center gap-2 rounded-md bg-bg-secondary px-3 text-left ring-1 ring-inset hover:bg-card-active ${
                          on ? 'ring-accent' : 'ring-transparent'
                        }`}
                      >
                        <Icon className={`size-4 shrink-0 ${on ? 'text-accent-text' : 'text-text-secondary'}`} />
                        <span className="truncate text-sm font-medium text-text-primary">{p.chip}</span>
                        <span className="ml-auto shrink-0 text-xs text-text-tertiary">{p.tag}</span>
                        {!p.builtIn && (
                          <button
                            type="button"
                            aria-label={`Delete the preset ${p.name}`}
                            data-chroma-export-preset-delete={p.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              useExportPresetStore.getState().deletePreset(p.id);
                              if (presetId === p.id) setPresetId(null);
                            }}
                            className="absolute -top-1.5 -right-1.5 hidden size-4 items-center justify-center rounded-full bg-card-active text-text-secondary group-hover:flex hover:text-text-primary"
                          >
                            <XIcon className="size-2.5" />
                          </button>
                        )}
                      </div>
                    }
                  />
                  <TooltipContent>{p.name}</TooltipContent>
                </Tooltip>
              );
            })}
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-1.5">
            <div className="flex h-7 min-w-0 items-center gap-1.5 rounded-sm bg-bg-secondary px-2 text-sm">
              <input
                aria-label="File name"
                data-chroma-export-name
                className="min-w-0 flex-1 bg-transparent text-text-primary outline-none"
                value={stem}
                onChange={(e) => {
                  pathTouched.current = true;
                  setOutPath(`${dir}/${e.target.value}.${ext || EXPORT_FORMAT_INFO[values.format].ext}`);
                }}
              />
              <span className="shrink-0 text-xs text-text-tertiary">.{ext || EXPORT_FORMAT_INFO[values.format].ext}</span>
              <span className="max-w-[45%] shrink-0 truncate text-xs text-text-tertiary" title={dir}>
                in {prettyDir(dir)}
              </span>
            </div>
            <Button variant="outline" size="sm" className="h-7" onClick={() => void changeFolder()}>
              Change…
            </Button>
          </div>

          <div
            data-chroma-export-summary
            className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 rounded-sm bg-bg-secondary px-2.5 py-2 text-xs text-text-secondary"
          >
            <span>
              <b className="font-medium text-text-primary">
                {outW} × {outH}
              </b>{' '}
              · {fmtFps(outFps)} fps · {EXPORT_FORMAT_INFO[values.format].label} ·{' '}
              {values.loudness === 'off' ? 'loudness as mixed' : loudnessWords} · {fmtLength(seconds)}
            </span>
            <span className="flex-1" />
            <span className="text-text-tertiary">{fmtApproxSize(estimateExportBytes(values.format, outW, outH, outFps, seconds))}</span>
            {warnings.length > 0 && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span data-chroma-export-warning aria-label="The export will differ from the preview">
                      <WarningIcon weight="fill" className="size-3.5 text-text-primary" />
                    </span>
                  }
                />
                <TooltipContent className="max-w-xs">
                  {warnings.map((w) => (
                    <p key={w}>{w}</p>
                  ))}
                </TooltipContent>
              </Tooltip>
            )}
          </div>

          {error && (
            <p data-chroma-export-error className="flex items-start gap-1.5 text-xs leading-snug text-destructive">
              <XCircleIcon className="mt-0.5 size-3.5 shrink-0" /> {error}
            </p>
          )}

          <div>
            <button
              type="button"
              aria-expanded={more}
              data-chroma-export-more
              onClick={() => setMore((m) => !m)}
              className="flex h-7 w-full items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary"
            >
              {more ? <CaretDownIcon className="size-2.5" /> : <CaretRightIcon className="size-2.5" />}
              More settings
            </button>
            {more && (
              <div className="grid grid-cols-2 gap-x-4 gap-y-2.5 pt-1 pl-4">
                <Field label="Size">
                  <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-1">
                    <NumberBox
                      aria-label="Width"
                      value={values.width}
                      placeholder={String(tlW)}
                      unit="px"
                      onChange={(n) => edit({ width: n, height: n === null ? null : (values.height ?? tlH) })}
                    />
                    <span className="text-text-tertiary">×</span>
                    <NumberBox
                      aria-label="Height"
                      value={values.height}
                      placeholder={String(tlH)}
                      unit="px"
                      onChange={(n) => edit({ height: n, width: n === null ? null : (values.width ?? tlW) })}
                    />
                  </div>
                </Field>
                <Field label="Frame rate">
                  <Select value={values.fps === null ? 'timeline' : String(values.fps)} onValueChange={(v) => edit({ fps: v === 'timeline' || v === null ? null : Number(v) })}>
                    <SelectTrigger className="data-[size=default]:h-7 w-full text-sm" aria-label="Frame rate">
                      <SelectValue>{values.fps === null ? `${fmtFps(fps)} fps (same as the timeline)` : `${fmtFps(values.fps)} fps`}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="timeline">{fmtFps(fps)} fps (same as the timeline)</SelectItem>
                      {FPS_CHOICES.filter((f) => Math.abs(f - fps) > 0.001).map((f) => (
                        <SelectItem key={f} value={String(f)}>
                          {fmtFps(f)} fps
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Loudness">
                  <div className="flex items-center gap-1.5">
                    <Select value={values.loudness} onValueChange={(v) => v && edit({ loudness: v as LoudnessChoice })}>
                      <SelectTrigger className="data-[size=default]:h-7 min-w-0 flex-1 text-sm" aria-label="Loudness">
                        <SelectValue>{LOUDNESS_CHOICE_LABELS[values.loudness]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(LOUDNESS_CHOICE_LABELS) as LoudnessChoice[]).map((k) => (
                          <SelectItem key={k} value={k}>
                            {LOUDNESS_CHOICE_LABELS[k]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {values.loudness === 'custom' && (
                      <NumberBox aria-label="Target loudness" value={values.customLufs} unit="LUFS" className="w-24" decimals onChange={(n) => n !== null && edit({ customLufs: n })} />
                    )}
                  </div>
                </Field>
                <Field label="Loudest peak">
                  <NumberBox
                    aria-label="Loudest peak"
                    value={values.loudness === 'custom' ? values.peakDbtp : values.loudness === 'off' ? null : LOUDNESS_PRESETS[values.loudness].truePeakDbtp}
                    placeholder="—"
                    unit="dBTP"
                    decimals
                    disabled={values.loudness !== 'custom'}
                    onChange={(n) => n !== null && edit({ peakDbtp: n })}
                  />
                </Field>
                <Field label="Format" full>
                  <Select value={values.format} onValueChange={(v) => v && edit({ format: v as ExportFormat })}>
                    <SelectTrigger className="data-[size=default]:h-7 w-full text-sm" aria-label="Format" data-chroma-export-format>
                      <SelectValue>{values.format === 'h264' ? 'H.264 MP4, high quality' : 'ProRes 422 HQ master (.mov)'}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {EXPORT_FORMATS.map((f) => (
                        <SelectItem key={f} value={f}>
                          {f === 'h264' ? 'H.264 MP4, high quality' : 'ProRes 422 HQ master (.mov)'}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Encoder" full>
                  <Select value={encoder} onValueChange={(v) => v && setEncoder(v as ExportEncoder)}>
                    <SelectTrigger className="data-[size=default]:h-7 w-full text-sm" aria-label="Encoder" data-chroma-export-encoder>
                      <SelectValue>{EXPORT_ENCODER_LABEL[encoder]}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {EXPORT_ENCODERS.map((e) => (
                        <SelectItem key={e} value={e}>
                          {EXPORT_ENCODER_LABEL[e]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="Save these settings as a preset" full>
                  <div className="flex items-center gap-1.5">
                    <Input
                      className="h-7 flex-1 text-sm"
                      placeholder="Preset name, e.g. Client review"
                      aria-label="Preset name"
                      data-chroma-export-preset-name
                      value={presetName}
                      onChange={(e) => setPresetName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && presetName.trim()) savePreset();
                      }}
                    />
                    <Button variant="outline" size="sm" className="h-7" disabled={!presetName.trim()} data-chroma-export-preset-save onClick={savePreset}>
                      <BookmarkSimpleIcon /> Save preset
                    </Button>
                  </div>
                </Field>
                {clips.length > 0 && (
                  <Field label="Clip exceptions (rarely needed)" full>
                    <div className="flex max-h-44 flex-col overflow-y-auto" data-chroma-export-exceptions>
                      {clips.map((clip) => (
                        <div key={clip.id} className="grid grid-cols-[minmax(0,1fr)_150px_150px] items-center gap-1.5 border-b border-border-color py-1 text-xs">
                          <span className="truncate text-text-primary" title={clip.name}>
                            {clip.name}
                          </span>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <span>
                                  <Select
                                    value={fitOverrides[clip.id] ?? 'fit'}
                                    onValueChange={(v) => setFitOverrides((s) => ({ ...s, [clip.id]: v as 'fit' | 'stretch' }))}
                                  >
                                    <SelectTrigger className="data-[size=default]:h-6 w-full text-xs" aria-label={`Framing of ${clip.name}`}>
                                      <SelectValue>{(fitOverrides[clip.id] ?? 'fit') === 'fit' ? 'Keep its framing' : 'Stretch to fill'}</SelectValue>
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="fit">Keep its framing</SelectItem>
                                      <SelectItem value="stretch">Stretch to fill</SelectItem>
                                    </SelectContent>
                                  </Select>
                                </span>
                              }
                            />
                            <TooltipContent>“Stretch to fill” ignores the clip’s own shape, for this export only</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <label className="flex items-center gap-1.5 text-text-secondary">
                                  <Switch
                                    checked={!!freezeOverrides[clip.id]}
                                    onCheckedChange={(v) => setFreezeOverrides((s) => ({ ...s, [clip.id]: v }))}
                                    aria-label={`Hold the last frame of ${clip.name}`}
                                  />
                                  Hold last frame
                                </label>
                              }
                            />
                            <TooltipContent>Freezes the clip’s last frame until the export ends, for this export only</TooltipContent>
                          </Tooltip>
                        </div>
                      ))}
                    </div>
                  </Field>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-border-color px-5 py-3">
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void runExport()} disabled={busy} data-chroma-export-run>
            <DownloadSimpleIcon /> {busy ? 'Preparing…' : 'Export'}
          </Button>
        </div>
      </div>
    </>
  );
}

function Field({ label, full, children }: { label: string; full?: boolean; children: React.ReactNode }) {
  return (
    <div className={full ? 'col-span-2' : undefined}>
      <div className="mb-1 text-xs text-text-secondary">{label}</div>
      {children}
    </div>
  );
}

/** A number field with its unit. Empty means `null` ("the timeline's own"),
 *  shown as the placeholder. */
function NumberBox({
  value,
  onChange,
  unit,
  placeholder,
  decimals,
  disabled,
  className,
  'aria-label': ariaLabel,
}: {
  value: number | null;
  onChange: (n: number | null) => void;
  unit: string;
  placeholder?: string;
  decimals?: boolean;
  disabled?: boolean;
  className?: string;
  'aria-label': string;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => {
    setText(value === null ? '' : String(value));
  }, [value]);
  const commit = () => {
    const t = text.trim().replace('−', '-');
    if (!t) return onChange(null);
    const n = decimals ? Number(t) : Math.round(Number(t));
    if (Number.isFinite(n)) onChange(n);
    else setText(value === null ? '' : String(value));
  };
  return (
    <div className={`flex h-7 items-center gap-1 rounded-sm bg-bg-secondary px-2 text-sm ${disabled ? 'opacity-60' : ''} ${className ?? ''}`}>
      <input
        aria-label={ariaLabel}
        inputMode="decimal"
        disabled={disabled}
        className="min-w-0 flex-1 bg-transparent tabular-nums text-text-primary outline-none placeholder:text-text-tertiary"
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
      <span className="shrink-0 text-xs text-text-tertiary">{unit}</span>
    </div>
  );
}
