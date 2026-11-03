/**
 * @apelles/editor — the Edit export's presets: one table for the Export panel
 * and for `editor_export` / `editor_list_export_presets` /
 * `editor_save_export_preset` (D-441, B-367).
 *
 * **What it is.**
 * - The built-in presets (size, frame rate, loudness and file format together,
 *   the way FCP's Share destinations, Resolve's Quick Export and Premiere's
 *   Export mode name a delivery rather than its numbers): YouTube 1080p,
 *   YouTube 4K, Shorts · Reels · TikTok, Square post, Master (ProRes 422 HQ, as
 *   edited) and Podcast video.
 * - The person's own saved presets, in a small store whose persistence is
 *   injected by the composition root (`appSettings.export`, `app_settings.rs`)
 *   exactly as `editLayout.ts` is — this package does not depend on the app's
 *   settings store, and there is no `localStorage` in this app by design.
 * - The last preset used per timeline shape, so the panel opens on what the
 *   person picked last time for a 16:9, 9:16 or square timeline.
 * - {@link presetExportArgs}: a preset as `compileEditorExportArgs` arguments,
 *   and {@link withPreset}, which an `editor_export` call goes through so a
 *   named preset and explicit arguments combine the same way for the GUI and an
 *   agent (an explicit argument wins over the preset's value).
 * - {@link defaultExportPath}: the pre-filled "Save as",
 *   `~/Movies/<project>/<timeline>.<ext>`, never an existing file.
 *
 * **What it does NOT do.** Compile or run an export (`editorExport.ts`), or
 * know codec arguments (`exportFormat.ts`).
 */
import { invoke } from '@tauri-apps/api/core';
import { videoDir } from '@tauri-apps/api/path';
import { create } from 'zustand';

import {
  DEFAULT_TRUE_PEAK_DBTP,
  LOUDNESS_PRESETS,
  MAX_CEILING_DBTP,
  MAX_TARGET_LUFS,
  MIN_CEILING_DBTP,
  MIN_TARGET_LUFS,
  type LoudnessPresetName,
} from './loudness';
import { EXPORT_FORMAT_INFO, isExportFormat, type ExportFormat } from './exportFormat';

/** A loudness choice: off, a named platform spec, or custom numbers. */
export type ExportLoudness = 'off' | LoudnessPresetName | { lufs: number; peakDbtp: number };

export type ExportPresetIcon = 'youtube' | 'mobile' | 'square' | 'master' | 'podcast' | 'saved';

export interface ExportPreset {
  /** Stable id: `youtube-1080p`, … for built-ins; `user:<slug>` for saved ones. */
  id: string;
  name: string;
  /** The chip's short label ("YouTube", "Shorts"); `name` is the full one. */
  chip: string;
  /** The one-word tag on the chip ("1080p", "Vertical", "ProRes"). */
  tag: string;
  /** Which Phosphor icon the chip draws (the panel maps it). */
  icon: ExportPresetIcon;
  /** Output size; `null` = the timeline's own (exported as edited). */
  width: number | null;
  height: number | null;
  /** Frame rate; `null` = the timeline's own. */
  fps: number | null;
  loudness: ExportLoudness;
  format: ExportFormat;
  builtIn: boolean;
}

export const BUILT_IN_EXPORT_PRESETS: readonly ExportPreset[] = [
  { id: 'youtube-1080p', name: 'YouTube 1080p', chip: 'YouTube', icon: 'youtube', tag: '1080p', width: 1920, height: 1080, fps: null, loudness: 'youtube', format: 'h264', builtIn: true },
  { id: 'youtube-4k', name: 'YouTube 4K', chip: 'YouTube', icon: 'youtube', tag: '4K', width: 3840, height: 2160, fps: null, loudness: 'youtube', format: 'h264', builtIn: true },
  { id: 'vertical', name: 'Shorts · Reels · TikTok', chip: 'Shorts', icon: 'mobile', tag: 'Vertical', width: 1080, height: 1920, fps: null, loudness: 'youtube', format: 'h264', builtIn: true },
  { id: 'square', name: 'Square post', chip: 'Square', icon: 'square', tag: '1:1', width: 1080, height: 1080, fps: null, loudness: 'youtube', format: 'h264', builtIn: true },
  { id: 'master', name: 'Master', chip: 'Master', icon: 'master', tag: 'ProRes', width: null, height: null, fps: null, loudness: 'off', format: 'prores_hq', builtIn: true },
  { id: 'podcast', name: 'Podcast video', chip: 'Podcast', icon: 'podcast', tag: '−16 LUFS', width: 1920, height: 1080, fps: null, loudness: 'podcast', format: 'h264', builtIn: true },
];

export type TimelineShape = 'landscape' | 'portrait' | 'square';

/** A timeline's shape, for the default preset and the shape-mismatch warning. */
export function shapeOf(width: number, height: number): TimelineShape {
  if (width === height) return 'square';
  return width > height ? 'landscape' : 'portrait';
}

/** The preset a timeline of each shape opens on before anything was used. */
export const DEFAULT_PRESET_BY_SHAPE: Record<TimelineShape, string> = {
  landscape: 'youtube-1080p',
  portrait: 'vertical',
  square: 'square',
};

/** The words a loudness choice shows ("YouTube, −14 LUFS"; "as mixed"). */
export function loudnessLabel(l: ExportLoudness): string {
  if (l === 'off') return 'Loudness as mixed';
  if (typeof l === 'object') return `${fmtSigned(l.lufs)} LUFS`;
  const name = l === 'youtube' ? 'YouTube' : l === 'broadcast' ? 'Broadcast' : 'Podcast';
  return `${name}, ${fmtSigned(LOUDNESS_PRESETS[l].integratedLufs)} LUFS`;
}

/** `−14` with a real minus sign, the way the panel prints numbers. */
export function fmtSigned(n: number): string {
  const r = Math.round(n * 10) / 10;
  return r < 0 ? `−${Math.abs(r)}` : String(r);
}

/** The settings a preset carries, without its identity — what the Export
 *  panel holds while the person edits values by hand. */
export type ExportSettings = Pick<ExportPreset, 'width' | 'height' | 'fps' | 'loudness' | 'format'>;

/** Export settings (a preset, or the panel's hand-edited values) as
 *  `compileEditorExportArgs` arguments. `null` sizes and rate are left out,
 *  which compiles at the timeline's own. */
export function presetExportArgs(p: ExportSettings): Record<string, unknown> {
  const out: Record<string, unknown> = { format: p.format };
  if (p.width !== null && p.height !== null) {
    out.width = p.width;
    out.height = p.height;
  }
  if (p.fps !== null) out.fps = p.fps;
  if (typeof p.loudness === 'object') {
    out.loudnessLufs = p.loudness.lufs;
    out.truePeakDbtp = p.loudness.peakDbtp;
  } else {
    out.loudnessPreset = p.loudness;
  }
  return out;
}

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'preset';

const MAX_PRESET_NAME = 48;
const MAX_DIMENSION = 8192;
const MAX_FPS = 240;

const posInt = (v: unknown, max: number): number | null | undefined => {
  if (v === undefined || v === null) return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 && n <= max ? n : undefined;
};

/**
 * Build a saved preset from untrusted values — the Export panel's current
 * settings, an `editor_save_export_preset` call, or a settings file written by
 * another version. Refuses with a sentence on anything out of range; a settings
 * file that fails is skipped by {@link ExportPresetStore.hydrate}, never thrown
 * on.
 */
export function userPresetFrom(raw: unknown): ExportPreset | { error: string } {
  if (raw === null || typeof raw !== 'object') return { error: 'a preset must be an object' };
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (!name || name.length > MAX_PRESET_NAME) return { error: `name must be 1-${MAX_PRESET_NAME} characters` };
  if (BUILT_IN_EXPORT_PRESETS.some((b) => b.name.toLowerCase() === name.toLowerCase())) {
    return { error: `"${name}" is a built-in preset's name — pick another` };
  }
  const width = posInt(r.width, MAX_DIMENSION);
  const height = posInt(r.height, MAX_DIMENSION);
  if (width === undefined || height === undefined) return { error: `width and height must be whole pixels, 1-${MAX_DIMENSION}` };
  if ((width === null) !== (height === null)) return { error: 'give both width and height, or neither (the timeline’s own size)' };
  let fps: number | null = null;
  if (r.fps !== undefined && r.fps !== null) {
    const f = Number(r.fps);
    if (!Number.isFinite(f) || f <= 0 || f > MAX_FPS) return { error: `fps must be between 0 and ${MAX_FPS}` };
    fps = f;
  }
  const format = r.format === undefined || r.format === null ? 'h264' : r.format;
  if (!isExportFormat(format)) return { error: 'format must be "h264" or "prores_hq"' };
  let loudness: ExportLoudness;
  const l = r.loudness ?? 'off';
  if (l === 'off' || l === 'youtube' || l === 'broadcast' || l === 'podcast') {
    loudness = l;
  } else if (l === 'custom') {
    const lufs = Number(r.loudnessLufs);
    const peak = r.truePeakDbtp === undefined || r.truePeakDbtp === null ? DEFAULT_TRUE_PEAK_DBTP : Number(r.truePeakDbtp);
    if (!Number.isFinite(lufs) || lufs < MIN_TARGET_LUFS || lufs > MAX_TARGET_LUFS) {
      return { error: `loudnessLufs must be between ${MIN_TARGET_LUFS} and ${MAX_TARGET_LUFS}` };
    }
    if (!Number.isFinite(peak) || peak < MIN_CEILING_DBTP || peak > MAX_CEILING_DBTP) {
      return { error: `truePeakDbtp must be between ${MIN_CEILING_DBTP} and ${MAX_CEILING_DBTP}` };
    }
    loudness = { lufs, peakDbtp: peak };
  } else {
    return { error: 'loudness must be "off", "youtube", "broadcast", "podcast" or "custom"' };
  }
  const tag = width !== null && height !== null ? `${width}×${height}` : EXPORT_FORMAT_INFO[format].label;
  return { id: `user:${slug(name)}`, name, chip: name, icon: 'saved', tag, width, height, fps, loudness, format, builtIn: false };
}

/** A saved preset in the settings file's shape (`ExportPresetSettings`). */
export function presetToSettings(p: ExportPreset): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    width: p.width,
    height: p.height,
    fps: p.fps,
    loudness: typeof p.loudness === 'object' ? 'custom' : p.loudness,
    loudnessLufs: typeof p.loudness === 'object' ? p.loudness.lufs : null,
    truePeakDbtp: typeof p.loudness === 'object' ? p.loudness.peakDbtp : null,
    format: p.format,
  };
}

/** What the store persists (`appSettings.export`). */
export interface ExportSettingsBlob {
  presets: Record<string, unknown>[];
  lastPreset: Partial<Record<TimelineShape, string>>;
}

export interface ExportPresetStore {
  userPresets: ExportPreset[];
  lastPreset: Partial<Record<TimelineShape, string>>;
  /** Add or replace (by name) a saved preset. Returns it, or why not. */
  savePreset: (raw: unknown) => ExportPreset | { error: string };
  /** Remove a saved preset by id or name. Built-ins cannot be removed. */
  deletePreset: (idOrName: string) => { ok: true } | { error: string };
  setLastPreset: (shape: TimelineShape, id: string) => void;
  hydrate: (saved: unknown) => void;
  setPersist: (sink: ((blob: ExportSettingsBlob) => void) | null) => void;
}

let persistSink: ((blob: ExportSettingsBlob) => void) | null = null;

const blobOf = (s: Pick<ExportPresetStore, 'userPresets' | 'lastPreset'>): ExportSettingsBlob => ({
  presets: s.userPresets.map(presetToSettings),
  lastPreset: s.lastPreset,
});

const SHAPES: readonly TimelineShape[] = ['landscape', 'portrait', 'square'];

export const useExportPresetStore = create<ExportPresetStore>((set, get) => {
  const commit = (patch: Partial<Pick<ExportPresetStore, 'userPresets' | 'lastPreset'>>) => {
    set(patch);
    persistSink?.(blobOf(get()));
  };
  return {
    userPresets: [],
    lastPreset: {},
    savePreset: (raw) => {
      const p = userPresetFrom(raw);
      if ('error' in p) return p;
      const rest = get().userPresets.filter((u) => u.id !== p.id);
      commit({ userPresets: [...rest, p] });
      return p;
    },
    deletePreset: (idOrName) => {
      const key = idOrName.trim().toLowerCase();
      if (BUILT_IN_EXPORT_PRESETS.some((b) => b.id === key || b.name.toLowerCase() === key)) {
        return { error: `"${idOrName}" is a built-in preset; only saved presets can be deleted` };
      }
      const found = get().userPresets.find((u) => u.id === key || u.name.toLowerCase() === key);
      if (!found) return { error: `no saved preset "${idOrName}"` };
      const lastPreset = Object.fromEntries(Object.entries(get().lastPreset).filter(([, id]) => id !== found.id));
      commit({ userPresets: get().userPresets.filter((u) => u.id !== found.id), lastPreset });
      return { ok: true };
    },
    setLastPreset: (shape, id) => {
      if (get().lastPreset[shape] === id) return;
      commit({ lastPreset: { ...get().lastPreset, [shape]: id } });
    },
    hydrate: (saved) => {
      if (saved === null || typeof saved !== 'object') return;
      const s = saved as Record<string, unknown>;
      const userPresets = Array.isArray(s.presets)
        ? s.presets.map(userPresetFrom).filter((p): p is ExportPreset => !('error' in p))
        : [];
      const lastPreset: Partial<Record<TimelineShape, string>> = {};
      if (s.lastPreset && typeof s.lastPreset === 'object') {
        for (const shape of SHAPES) {
          const id = (s.lastPreset as Record<string, unknown>)[shape];
          if (typeof id === 'string') lastPreset[shape] = id;
        }
      }
      set({ userPresets, lastPreset });
    },
    setPersist: (sink) => {
      persistSink = sink;
    },
  };
});

/** Every preset, built-ins first. */
export function allExportPresets(): ExportPreset[] {
  return [...BUILT_IN_EXPORT_PRESETS, ...useExportPresetStore.getState().userPresets];
}

/** A preset by id or (case-insensitive) name. */
export function findExportPreset(idOrName: string): ExportPreset | undefined {
  const key = idOrName.trim().toLowerCase();
  return allExportPresets().find((p) => p.id === key || p.name.toLowerCase() === key);
}

/** The preset a timeline of `shape` opens on: the last one used, else the
 *  shape's default (a last-used id whose preset was deleted falls back). */
export function initialPresetFor(shape: TimelineShape): ExportPreset {
  const last = useExportPresetStore.getState().lastPreset[shape];
  return (last && findExportPreset(last)) || findExportPreset(DEFAULT_PRESET_BY_SHAPE[shape]) || BUILT_IN_EXPORT_PRESETS[0];
}

/** The keys a preset fills. An explicit argument of the same group wins. */
const SIZE_KEYS = ['width', 'height'] as const;
const LOUDNESS_KEYS = ['loudnessPreset', 'loudnessLufs', 'truePeakDbtp'] as const;

/**
 * `editor_export`'s `preset`: fill the call's arguments from the named preset,
 * keeping every argument the caller gave explicitly (size and loudness as a
 * group, so a caller's own `loudnessLufs` is not combined with the preset's
 * `loudnessPreset`). Without a `preset` the arguments pass through untouched.
 */
export function withPreset<T extends Record<string, unknown>>(a: T): T | { error: string } {
  if (a.preset === undefined || a.preset === null) return a;
  if (typeof a.preset !== 'string' || !a.preset.trim()) return { error: 'preset must be a preset id or name' };
  const p = findExportPreset(a.preset);
  if (!p) {
    return { error: `no export preset "${a.preset}" — editor_list_export_presets lists them (${allExportPresets().map((x) => x.id).join(', ')})` };
  }
  const fill = presetExportArgs(p);
  const given = (k: string) => a[k] !== undefined && a[k] !== null;
  const out: Record<string, unknown> = { ...a };
  delete out.preset;
  if (!SIZE_KEYS.some(given)) {
    if (fill.width !== undefined) {
      out.width = fill.width;
      out.height = fill.height;
    }
  }
  if (!given('fps') && fill.fps !== undefined) out.fps = fill.fps;
  if (!LOUDNESS_KEYS.some(given)) for (const k of LOUDNESS_KEYS) if (fill[k] !== undefined) out[k] = fill[k];
  if (!given('format')) out.format = fill.format;
  return out as T;
}

/** The project's name from the open project's key (its path, or
 *  `untitled:<name>`): the folder the default export lands in. */
export function projectNameOf(key: string | null): string {
  if (!key) return 'Apelles';
  if (key.startsWith('untitled:')) return key.slice('untitled:'.length) || 'Apelles';
  const base = key.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return (dot > 0 ? base.slice(0, dot) : base) || 'Apelles';
}

/** `~/Movies/<project>/<timeline>.<ext>`, or `<timeline> 2.<ext>` … when that
 *  file exists already — the pre-filled "Save as" and `editor_export`'s default
 *  `out_path`. */
export async function defaultExportPath(projectKey: string | null, timelineName: string, format: ExportFormat): Promise<string> {
  const movies = await videoDir();
  const dir = `${movies.replace(/[\\/]+$/, '')}/${projectNameOf(projectKey).replace(/[/:]/g, '-')}`;
  return await invoke<string>('chroma_unused_export_path', {
    dir,
    stem: timelineName || 'Timeline',
    ext: EXPORT_FORMAT_INFO[format].ext,
  });
}

/** `editor_list_export_presets`' answer: every preset in plain words. */
export function listExportPresetsOp(): Record<string, unknown> {
  return {
    presets: allExportPresets().map((p) => ({
      id: p.id,
      name: p.name,
      builtIn: p.builtIn,
      width: p.width,
      height: p.height,
      fps: p.fps,
      format: p.format,
      formatLabel: EXPORT_FORMAT_INFO[p.format].label,
      loudness: typeof p.loudness === 'object' ? { lufs: p.loudness.lufs, truePeakDbtp: p.loudness.peakDbtp } : p.loudness,
      summary: presetSummary(p),
    })),
    note: 'Pass a preset id or name as editor_export(preset=...). Explicit width/height, fps, loudness or format arguments override the preset. width/height/fps null = the timeline’s own.',
  };
}

/** One line: "1920 × 1080 · H.264 MP4 · YouTube, −14 LUFS". */
export function presetSummary(p: ExportPreset): string {
  const size = p.width !== null && p.height !== null ? `${p.width} × ${p.height}` : 'Timeline size';
  const fps = p.fps !== null ? ` · ${p.fps} fps` : '';
  return `${size}${fps} · ${EXPORT_FORMAT_INFO[p.format].label} · ${loudnessLabel(p.loudness)}`;
}

/** `editor_save_export_preset`: save (or with `delete: true`, remove) one. */
export function saveExportPresetOp(a: Record<string, unknown>): Record<string, unknown> | { error: string } {
  const store = useExportPresetStore.getState();
  if (a.delete === true) {
    const name = typeof a.name === 'string' ? a.name : '';
    const out = store.deletePreset(name);
    return 'error' in out ? out : { ok: true, deleted: name };
  }
  const saved = store.savePreset(a);
  if ('error' in saved) return saved;
  return { ok: true, preset: { id: saved.id, name: saved.name, summary: presetSummary(saved) } };
}
