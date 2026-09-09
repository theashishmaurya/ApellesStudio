// Apelles — per-project output spec (D-038).
//
// A small modal to set the loaded project's output resolution, frame rate, and
// colour space — one spec for the whole (possibly multi-shot) project instead of
// everything being derived from whichever clip is loaded. Every field is
// optional: "Match first clip" / "Clip default" clears it back to clip-derived,
// which is the pre-D-038 behaviour everywhere.
//
// colorSpace is stored + surfaced only for now — a real colour-managed pipeline
// is D-004. Reached from the gear on the shot strip.
//
// Styling: plain elements + app colour tokens, same as ShotStrip / ProjectLauncher.
import { useMemo, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import { toast } from 'react-toastify';

import { useSessionStore, ProjectSettings } from '../../store/useSessionStore';

const RES_PRESETS: { label: string; w: number; h: number }[] = [
  { label: '3840 × 2160 (UHD)', w: 3840, h: 2160 },
  { label: '1920 × 1080 (HD)', w: 1920, h: 1080 },
  { label: '1280 × 720', w: 1280, h: 720 },
  { label: '1080 × 1920 (vertical)', w: 1080, h: 1920 },
];

const FPS_PRESETS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

const COLOR_SPACES: { value: string; label: string }[] = [
  { value: 'rec709', label: 'Rec.709' },
  { value: 'rec2020', label: 'Rec.2020' },
  { value: 'dci-p3', label: 'DCI-P3' },
  { value: 'srgb', label: 'sRGB' },
];

function matchesPreset(w?: number | null, h?: number | null) {
  return RES_PRESETS.findIndex((p) => p.w === w && p.h === h);
}

export default function ProjectSettingsModal({ onClose }: { onClose: () => void }) {
  const settings = useSessionStore((s) => s.projectSettings);
  const setProjectSettings = useSessionStore((s) => s.setProjectSettings);

  const initialResMode = useMemo(() => {
    if (settings?.width == null || settings?.height == null) return 'match';
    return matchesPreset(settings.width, settings.height) >= 0 ? 'preset' : 'custom';
  }, [settings]);

  const [resMode, setResMode] = useState<'match' | 'preset' | 'custom'>(initialResMode);
  const [presetIdx, setPresetIdx] = useState(() => Math.max(0, matchesPreset(settings?.width, settings?.height)));
  const [customW, setCustomW] = useState(String(settings?.width ?? ''));
  const [customH, setCustomH] = useState(String(settings?.height ?? ''));

  const [fpsMode, setFpsMode] = useState<'match' | 'preset' | 'custom'>(() => {
    if (settings?.fps == null) return 'match';
    return FPS_PRESETS.includes(settings.fps) ? 'preset' : 'custom';
  });
  const [fpsPreset, setFpsPreset] = useState(() =>
    settings?.fps != null && FPS_PRESETS.includes(settings.fps) ? settings.fps : 24,
  );
  const [customFps, setCustomFps] = useState(String(settings?.fps ?? ''));

  const [colorSpace, setColorSpace] = useState<string>(settings?.colorSpace ?? 'rec709');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const patch: ProjectSettings = {};

    if (resMode === 'match') {
      patch.width = null;
      patch.height = null;
    } else if (resMode === 'preset') {
      patch.width = RES_PRESETS[presetIdx].w;
      patch.height = RES_PRESETS[presetIdx].h;
    } else {
      const w = parseInt(customW, 10);
      const h = parseInt(customH, 10);
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
        toast.error('Enter a valid custom width and height.');
        return;
      }
      patch.width = w;
      patch.height = h;
    }

    if (fpsMode === 'match') {
      patch.fps = null;
    } else if (fpsMode === 'preset') {
      patch.fps = fpsPreset;
    } else {
      const f = parseFloat(customFps);
      if (!Number.isFinite(f) || f <= 0) {
        toast.error('Enter a valid custom frame rate.');
        return;
      }
      patch.fps = f;
    }

    patch.colorSpace = colorSpace || null;

    setSaving(true);
    const res = await setProjectSettings(patch);
    setSaving(false);
    if (!res.ok) {
      toast.error(`Could not save project settings: ${res.error}`);
      return;
    }
    toast.success('Project settings saved');
    onClose();
  };

  const fieldCls =
    'px-2.5 py-1.5 rounded-md bg-bg-primary border border-border-color text-sm text-text-primary outline-none focus:border-accent';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="w-[460px] max-w-[calc(100vw-32px)] rounded-lg border border-border-color bg-surface p-5 shadow-2xl flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary">Project settings</h2>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">
            <X size={16} />
          </button>
        </div>

        {/* resolution */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-text-secondary">Output resolution</span>
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            {(['match', 'preset', 'custom'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setResMode(m)}
                className={[
                  'px-2 py-1 rounded-md border',
                  resMode === m
                    ? 'border-accent text-text-primary bg-accent/10'
                    : 'border-border-color text-text-secondary hover:text-text-primary',
                ].join(' ')}
              >
                {m === 'match' ? 'Match first clip' : m === 'preset' ? 'Preset' : 'Custom'}
              </button>
            ))}
          </div>
          {resMode === 'preset' && (
            <select className={fieldCls} value={presetIdx} onChange={(e) => setPresetIdx(Number(e.target.value))}>
              {RES_PRESETS.map((p, i) => (
                <option key={p.label} value={i}>
                  {p.label}
                </option>
              ))}
            </select>
          )}
          {resMode === 'custom' && (
            <div className="flex items-center gap-2">
              <input className={`${fieldCls} w-24`} placeholder="W" value={customW} onChange={(e) => setCustomW(e.target.value)} />
              <span className="text-text-secondary">×</span>
              <input className={`${fieldCls} w-24`} placeholder="H" value={customH} onChange={(e) => setCustomH(e.target.value)} />
            </div>
          )}
        </div>

        {/* fps */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-text-secondary">Frame rate</span>
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            {(['match', 'preset', 'custom'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setFpsMode(m)}
                className={[
                  'px-2 py-1 rounded-md border',
                  fpsMode === m
                    ? 'border-accent text-text-primary bg-accent/10'
                    : 'border-border-color text-text-secondary hover:text-text-primary',
                ].join(' ')}
              >
                {m === 'match' ? 'Match first clip' : m === 'preset' ? 'Preset' : 'Custom'}
              </button>
            ))}
          </div>
          {fpsMode === 'preset' && (
            <select className={fieldCls} value={fpsPreset} onChange={(e) => setFpsPreset(Number(e.target.value))}>
              {FPS_PRESETS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          )}
          {fpsMode === 'custom' && (
            <input className={`${fieldCls} w-32`} placeholder="fps" value={customFps} onChange={(e) => setCustomFps(e.target.value)} />
          )}
        </div>

        {/* colour space */}
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-text-secondary">Colour space</span>
          <select className={fieldCls} value={colorSpace} onChange={(e) => setColorSpace(e.target.value)}>
            {COLOR_SPACES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-text-secondary/70">
            Display / metadata only for now — the grade still renders display-referred Rec.709 (D-004).
          </span>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-xs text-text-secondary hover:text-text-primary">
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="px-3 py-1.5 rounded-md text-xs font-semibold bg-accent text-button-text hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5"
          >
            {saving && <Loader2 size={13} className="animate-spin" />} Save
          </button>
        </div>
      </div>
    </div>
  );
}
