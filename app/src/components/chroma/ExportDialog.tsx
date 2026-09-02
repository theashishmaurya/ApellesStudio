// Chroma — the Colorist Export dialog (D-049, roadmap "Next" item 3).
//
// A top-right button in the Colorist tab's `EditorToolbar` (next to
// undo/redo/show-original/fullscreen) that opens a proper video-export
// dialog: codec, resolution (D-038 project spec if set, else clip-derived,
// or Custom), frame range (full clip or a custom in/out range), a `.cube`
// LUT bake toggle, an output path via the native save dialog, and a
// progress bar polled from `chroma_export_progress`.
//
// Pure UI + wiring onto the *existing* `chroma_export_video`/`chroma_bake_lut`
// (D-022) — no new export logic. The one backend change this dialog needed
// was exposing an explicit `outWidth`/`outHeight` override on
// `chroma_export_video` (it previously only ever took the D-038 project
// spec) — see `resolve_export_resolution` in `chroma/export.rs`.
//
// Replaces the old buried `Panel.Export` / `ExportPanel` toggle as *the*
// video-export entry point — see the D-049 decision entry for why
// `ExportPanel` itself is left routed rather than torn out (it's RapidRAW's
// still-image exporter, a different and already-broken-for-video feature,
// not a duplicate of this dialog).
//
// Styling: plain elements + app colour tokens (the `ProjectSettingsModal` /
// `ShotStrip` convention) for most fields; `Dialog` + `Select` are
// `@chroma/ui` (D-042) per the roadmap item's explicit ask. No progress
// primitive exists in `@chroma/ui` yet, so the bar is a plain div (same
// weight as adding one for a single caller).
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { CheckCircle2, Download, Loader2, XCircle } from 'lucide-react';
import { toast } from 'react-toastify';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@chroma/ui';

import { useChromaStore } from '../../store/useChromaStore';
import { useSessionStore } from '../../store/useSessionStore';
import { useEditorStore } from '../../store/useEditorStore';

type Codec = 'prores' | 'h264';
type ResMode = 'project' | 'clip' | 'custom';
type RangeMode = 'full' | 'custom';
type Phase = 'idle' | 'exporting' | 'baking' | 'success' | 'error';

interface ExportProgressDto {
  running: boolean;
  done: number;
  total: number;
  out_path: string | null;
  error: string | null;
}

const PRORES_PROFILES = [
  { value: 0, label: 'Proxy' },
  { value: 1, label: 'LT' },
  { value: 2, label: 'Standard' },
  { value: 3, label: 'HQ (default)' },
  { value: 4, label: '4444' },
  { value: 5, label: '4444 XQ' },
];

const fieldCls =
  'px-2.5 py-1.5 rounded-md bg-bg-primary border border-border-color text-sm text-text-primary outline-none focus:border-accent w-full disabled:opacity-50';

const chipCls = (active: boolean) =>
  [
    'px-2 py-1 rounded-md border transition-colors',
    active
      ? 'border-accent text-text-primary bg-accent/10'
      : 'border-border-color text-text-secondary hover:text-text-primary disabled:hover:text-text-secondary',
    'disabled:opacity-40 disabled:cursor-not-allowed',
  ].join(' ');

function suggestedExt(codec: Codec) {
  return codec === 'h264' ? 'mp4' : 'mov';
}

function stemOf(path: string) {
  const base = path.split(/[\\/]/).pop() || 'clip';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export default function ExportDialog() {
  const videoInfo = useChromaStore((s) => s.videoInfo);
  const projectSettings = useSessionStore((s) => s.projectSettings);
  const adjustments = useEditorStore((s) => s.adjustments);

  const [open, setOpenRaw] = useState(false);
  const [codec, setCodec] = useState<Codec>('prores');
  const [quality, setQuality] = useState<number | null>(null); // null → backend default
  const [resMode, setResMode] = useState<ResMode>('clip');
  const [customW, setCustomW] = useState('');
  const [customH, setCustomH] = useState('');
  const [rangeMode, setRangeMode] = useState<RangeMode>('full');
  const [fromFrame, setFromFrame] = useState('0');
  const [toFrame, setToFrame] = useState('0');
  const [bakeLut, setBakeLut] = useState(false);
  const [outPath, setOutPath] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [errorMessage, setErrorMessage] = useState('');
  const pollRef = useRef<number | null>(null);

  const hasProjectRes = !!(projectSettings?.width && projectSettings?.height);
  const last = videoInfo ? Math.max(0, videoInfo.frameCount - 1) : 0;
  const isBusy = phase === 'exporting' || phase === 'baking';
  const canOpen = !!videoInfo?.isVideo;

  // D-038/D-049 default: the project's output spec if set, else clip-derived.
  // Re-derived every time the dialog opens (not just on mount) so a project
  // settings change between opens is picked up.
  useEffect(() => {
    if (!open) return;
    setResMode(hasProjectRes ? 'project' : 'clip');
    setCustomW('');
    setCustomH('');
    if (videoInfo) {
      setFromFrame('0');
      setToFrame(String(Math.max(0, videoInfo.frameCount - 1)));
    }
    setRangeMode('full');
    setOutPath(null);
    setBakeLut(false);
    setPhase('idle');
    setErrorMessage('');
    setProgress({ done: 0, total: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only on open, not on every field change
  }, [open]);

  useEffect(
    () => () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    },
    [],
  );

  const resolvedW = useMemo(() => {
    if (resMode === 'project') return projectSettings?.width ?? null;
    if (resMode === 'custom') return parseInt(customW, 10) || null;
    return null; // 'clip' → no override, export_video falls back to the clip's own dims
  }, [resMode, projectSettings, customW]);
  const resolvedH = useMemo(() => {
    if (resMode === 'project') return projectSettings?.height ?? null;
    if (resMode === 'custom') return parseInt(customH, 10) || null;
    return null;
  }, [resMode, projectSettings, customH]);

  const setOpen = (next: boolean) => {
    // don't let a dialog close drop the progress UI mid-export — the backend
    // job (spawn_blocking) keeps running regardless, but losing sight of it
    // is confusing; closing is blocked, not the export.
    if (isBusy) return;
    setOpenRaw(next);
  };

  const startPolling = (outStr: string) => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      let p: ExportProgressDto;
      try {
        p = await invoke<ExportProgressDto>('chroma_export_progress');
      } catch (e: any) {
        if (pollRef.current) window.clearInterval(pollRef.current);
        pollRef.current = null;
        setPhase('error');
        setErrorMessage(String(e?.message || e));
        return;
      }
      setProgress({ done: p.done, total: p.total });
      if (p.running) return;

      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;

      if (p.error) {
        setPhase('error');
        setErrorMessage(p.error);
        toast.error(`Export failed: ${p.error}`);
        return;
      }

      if (bakeLut) {
        setPhase('baking');
        try {
          await invoke('chroma_bake_lut', { outPath: null, size: 33, jsAdjustments: adjustments });
        } catch (e: any) {
          toast.error(`Video exported, but the .cube bake failed: ${String(e?.message || e)}`);
        }
      }
      setPhase('success');
      toast.success(`Exported to ${outStr}`);
    }, 350);
  };

  const handleChoosePath = async () => {
    if (!videoInfo) return;
    const ext = suggestedExt(codec);
    const suggested = `${stemOf(videoInfo.path)}.graded.${ext}`;
    try {
      const chosen = await save({
        title: 'Export video',
        defaultPath: suggested,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (chosen) setOutPath(chosen as string);
    } catch (e) {
      console.error('Export path picker failed:', e);
    }
  };

  const handleExport = async () => {
    if (!videoInfo) return;

    let from: number | null = null;
    let to: number | null = null;
    if (rangeMode === 'custom') {
      from = parseInt(fromFrame, 10);
      to = parseInt(toFrame, 10);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from || to > last) {
        toast.error(`Enter a valid frame range (0–${last}).`);
        return;
      }
    }
    if (resMode === 'custom') {
      const w = parseInt(customW, 10);
      const h = parseInt(customH, 10);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
        toast.error('Enter a valid custom width and height.');
        return;
      }
    }

    setPhase('exporting');
    setErrorMessage('');
    setProgress({ done: 0, total: rangeMode === 'custom' ? (to as number) - (from as number) + 1 : videoInfo.frameCount });

    try {
      const res: any = await invoke('chroma_export_video', {
        outPath: outPath ?? null,
        fromFrame: from,
        toFrame: to,
        codec,
        quality,
        fpsOverride: null,
        outWidth: resolvedW,
        outHeight: resolvedH,
        jsAdjustments: adjustments,
      });
      startPolling((res && res.out_path) || outPath || '');
    } catch (e: any) {
      setPhase('error');
      setErrorMessage(String(e?.message || e));
      toast.error(`Could not start export: ${String(e?.message || e)}`);
    }
  };

  return (
    <>
      <button
        className="bg-surface text-text-primary p-2 rounded-full hover:bg-card-active transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        onClick={() => canOpen && setOpen(true)}
        disabled={!canOpen}
        data-tooltip={canOpen ? 'Export video' : 'Load a clip to export'}
      >
        <Download size={20} />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md" showCloseButton={!isBusy}>
          <DialogHeader>
            <DialogTitle>Export video</DialogTitle>
          </DialogHeader>

          {videoInfo && (
            <div className="flex flex-col gap-4 text-sm">
              {/* codec + quality */}
              <div className="flex flex-col gap-1.5">
                <Label>Codec</Label>
                <Select
                  value={codec}
                  onValueChange={(v) => {
                    setCodec(v as Codec);
                    setQuality(null);
                  }}
                  disabled={isBusy}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="prores">ProRes 4444 (.mov)</SelectItem>
                    <SelectItem value="h264">H.264 (.mp4)</SelectItem>
                  </SelectContent>
                </Select>
                {codec === 'prores' ? (
                  <Select value={String(quality ?? 3)} onValueChange={(v) => setQuality(Number(v))} disabled={isBusy}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PRORES_PROFILES.map((p) => (
                        <SelectItem key={p.value} value={String(p.value)}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <div className="flex items-center gap-2">
                    <input
                      type="range"
                      min={0}
                      max={51}
                      step={1}
                      value={quality ?? 18}
                      onChange={(e) => setQuality(Number(e.target.value))}
                      disabled={isBusy}
                      className="flex-1"
                    />
                    <span className="text-text-secondary text-xs w-32 text-right shrink-0">
                      CRF {quality ?? 18} (lower = better)
                    </span>
                  </div>
                )}
              </div>

              {/* resolution */}
              <div className="flex flex-col gap-1.5">
                <Label>Resolution</Label>
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  <button
                    onClick={() => setResMode('project')}
                    disabled={isBusy || !hasProjectRes}
                    className={chipCls(resMode === 'project')}
                  >
                    Project {hasProjectRes ? `(${projectSettings!.width}×${projectSettings!.height})` : '(not set)'}
                  </button>
                  <button onClick={() => setResMode('clip')} disabled={isBusy} className={chipCls(resMode === 'clip')}>
                    Clip ({videoInfo.width}×{videoInfo.height})
                  </button>
                  <button onClick={() => setResMode('custom')} disabled={isBusy} className={chipCls(resMode === 'custom')}>
                    Custom
                  </button>
                </div>
                {resMode === 'custom' && (
                  <div className="flex items-center gap-2">
                    <input
                      className={fieldCls}
                      placeholder="W"
                      value={customW}
                      onChange={(e) => setCustomW(e.target.value)}
                      disabled={isBusy}
                    />
                    <span className="text-text-secondary">×</span>
                    <input
                      className={fieldCls}
                      placeholder="H"
                      value={customH}
                      onChange={(e) => setCustomH(e.target.value)}
                      disabled={isBusy}
                    />
                  </div>
                )}
              </div>

              {/* frame range */}
              <div className="flex flex-col gap-1.5">
                <Label>Frame range</Label>
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  <button onClick={() => setRangeMode('full')} disabled={isBusy} className={chipCls(rangeMode === 'full')}>
                    Full clip (0–{last})
                  </button>
                  <button
                    onClick={() => setRangeMode('custom')}
                    disabled={isBusy}
                    className={chipCls(rangeMode === 'custom')}
                  >
                    Custom range
                  </button>
                </div>
                {rangeMode === 'custom' && (
                  <div className="flex items-center gap-2">
                    <input
                      className={fieldCls}
                      type="number"
                      min={0}
                      max={last}
                      value={fromFrame}
                      onChange={(e) => setFromFrame(e.target.value)}
                      disabled={isBusy}
                    />
                    <span className="text-text-secondary shrink-0">to</span>
                    <input
                      className={fieldCls}
                      type="number"
                      min={0}
                      max={last}
                      value={toFrame}
                      onChange={(e) => setToFrame(e.target.value)}
                      disabled={isBusy}
                    />
                  </div>
                )}
              </div>

              {/* LUT bake toggle */}
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="export-bake-lut" className="cursor-pointer">
                  Also bake a .cube LUT of the primary grade
                </Label>
                <Switch id="export-bake-lut" checked={bakeLut} onCheckedChange={setBakeLut} disabled={isBusy} />
              </div>

              {/* output path */}
              <div className="flex flex-col gap-1.5">
                <Label>Output file</Label>
                <div className="flex items-center gap-2">
                  <div className={`${fieldCls} truncate text-text-secondary`} title={outPath ?? ''}>
                    {outPath ?? `${stemOf(videoInfo.path)}.graded.${suggestedExt(codec)} (next to the source clip)`}
                  </div>
                  <Button variant="outline" size="sm" onClick={handleChoosePath} disabled={isBusy} className="shrink-0">
                    Choose…
                  </Button>
                </div>
              </div>

              {/* progress / status */}
              {phase !== 'idle' && (
                <div className="flex flex-col gap-1.5">
                  {phase === 'exporting' && (
                    <>
                      <div className="h-1.5 w-full rounded-full bg-surface overflow-hidden">
                        <div
                          className="h-full bg-accent transition-all"
                          style={{
                            width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%`,
                          }}
                        />
                      </div>
                      <span className="text-xs text-text-secondary">
                        Exporting frame {progress.done} / {progress.total}…
                      </span>
                    </>
                  )}
                  {phase === 'baking' && (
                    <span className="text-xs text-text-secondary flex items-center gap-1.5">
                      <Loader2 size={12} className="animate-spin" /> Baking .cube LUT…
                    </span>
                  )}
                  {phase === 'success' && (
                    <span className="text-xs text-green-400 flex items-center gap-1.5">
                      <CheckCircle2 size={12} /> Export complete.
                    </span>
                  )}
                  {phase === 'error' && (
                    <span className="text-xs text-red-400 flex items-center gap-1.5">
                      <XCircle size={12} /> {errorMessage || 'Export failed.'}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={isBusy}>
              {phase === 'success' || phase === 'error' ? 'Close' : 'Cancel'}
            </Button>
            <Button onClick={handleExport} disabled={isBusy || !videoInfo}>
              {isBusy ? (
                <>
                  <Loader2 size={14} className="animate-spin mr-1.5" />
                  {phase === 'baking' ? 'Baking…' : 'Exporting…'}
                </>
              ) : (
                'Export'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
