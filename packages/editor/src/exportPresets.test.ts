// @apelles/editor — the export preset table, the saved-preset store and the
// codec tails per format (D-441): one table for the Export panel and for
// `editor_export(preset=…)` / `editor_list_export_presets` /
// `editor_save_export_preset`.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock('@tauri-apps/api/path', () => ({ videoDir: () => Promise.resolve('/Users/me/Movies') }));

const {
  BUILT_IN_EXPORT_PRESETS,
  defaultExportPath,
  findExportPreset,
  initialPresetFor,
  listExportPresetsOp,
  presetExportArgs,
  presetSummary,
  projectNameOf,
  saveExportPresetOp,
  shapeOf,
  useExportPresetStore,
  userPresetFrom,
  withPreset,
} = await import('./exportPresets');
const { audioCodecArgs, estimateExportBytes, fmtApproxSize, pipeVideoCodecArgs } = await import('./exportFormat');
const { buildPipeExportPlan } = await import('./timelinePipeExport');
import type { Timeline } from './timeline';
import type { TimelineExportOptions } from './exportTimeline';

beforeEach(() => {
  invokeMock.mockReset();
  useExportPresetStore.setState({ userPresets: [], lastPreset: {} });
  useExportPresetStore.getState().setPersist(null);
});

describe('the built-in presets', () => {
  it('cover the deliveries the panel shows, with the ProRes master at the timeline size and loudness as mixed', () => {
    expect(BUILT_IN_EXPORT_PRESETS.map((p) => p.id)).toEqual(['youtube-1080p', 'youtube-4k', 'vertical', 'square', 'master', 'podcast']);
    const master = findExportPreset('master');
    expect(master).toMatchObject({ format: 'prores_hq', width: null, height: null, loudness: 'off' });
    expect(presetExportArgs(master!)).toEqual({ format: 'prores_hq', loudnessPreset: 'off' });
    expect(presetExportArgs(findExportPreset('Shorts · Reels · TikTok')!)).toEqual({
      format: 'h264',
      width: 1080,
      height: 1920,
      loudnessPreset: 'youtube',
    });
  });

  it('a timeline opens on its shape’s default, or the last preset used for that shape', () => {
    expect(shapeOf(1920, 1080)).toBe('landscape');
    expect(shapeOf(1080, 1920)).toBe('portrait');
    expect(shapeOf(1080, 1080)).toBe('square');
    expect(initialPresetFor('landscape').id).toBe('youtube-1080p');
    expect(initialPresetFor('portrait').id).toBe('vertical');
    useExportPresetStore.getState().setLastPreset('landscape', 'master');
    expect(initialPresetFor('landscape').id).toBe('master');
    // A last-used preset that was deleted falls back to the default.
    useExportPresetStore.getState().setLastPreset('square', 'user:gone');
    expect(initialPresetFor('square').id).toBe('square');
  });

  it('summarises in plain words', () => {
    expect(presetSummary(findExportPreset('youtube-1080p')!)).toBe('1920 × 1080 · H.264 MP4 · YouTube, −14 LUFS');
    expect(presetSummary(findExportPreset('master')!)).toBe('Timeline size · ProRes 422 HQ · Loudness as mixed');
  });
});

describe('editor_export(preset=…) — withPreset', () => {
  it('fills size, loudness and format from the preset', () => {
    expect(withPreset({ outPath: '/x.mp4', preset: 'vertical' })).toEqual({
      outPath: '/x.mp4',
      width: 1080,
      height: 1920,
      loudnessPreset: 'youtube',
      format: 'h264',
    });
  });

  it('an explicit argument wins, by group', () => {
    const out = withPreset({ preset: 'youtube-4k', width: 1280, height: 720, loudnessLufs: -16 });
    expect(out).toEqual({ width: 1280, height: 720, loudnessLufs: -16, format: 'h264' });
  });

  it('passes a call without a preset through untouched, and names an unknown one', () => {
    const a = { outPath: '/x.mp4', width: 10, height: 10 };
    expect(withPreset(a)).toBe(a);
    expect(withPreset({ preset: 'nope' })).toEqual({ error: expect.stringContaining('editor_list_export_presets') });
  });
});

describe('saved presets', () => {
  it('validates what it is given, in words', () => {
    expect(userPresetFrom({ name: '' })).toEqual({ error: expect.stringContaining('name') });
    expect(userPresetFrom({ name: 'Master' })).toEqual({ error: expect.stringContaining('built-in') });
    expect(userPresetFrom({ name: 'x', width: 100 })).toEqual({ error: expect.stringContaining('both') });
    expect(userPresetFrom({ name: 'x', loudness: 'custom', loudnessLufs: 3 })).toEqual({ error: expect.stringContaining('loudnessLufs') });
    expect(userPresetFrom({ name: 'x', format: 'webm' })).toEqual({ error: expect.stringContaining('format') });
    expect(userPresetFrom({ name: 'Client review', width: 1280, height: 720, loudness: 'custom', loudnessLufs: -16 })).toMatchObject({
      id: 'user:client-review',
      loudness: { lufs: -16, peakDbtp: -1 },
      builtIn: false,
    });
  });

  it('saving persists through the injected sink, replaces by name, and a deleted one is gone', () => {
    const sink = vi.fn();
    useExportPresetStore.getState().setPersist(sink);
    const saved = useExportPresetStore.getState().savePreset({ name: 'Client review', width: 1280, height: 720 });
    expect('id' in saved).toBe(true);
    useExportPresetStore.getState().savePreset({ name: 'client review', format: 'prores_hq' });
    expect(useExportPresetStore.getState().userPresets).toHaveLength(1);
    expect(useExportPresetStore.getState().userPresets[0].format).toBe('prores_hq');
    expect(sink).toHaveBeenLastCalledWith({
      presets: [expect.objectContaining({ id: 'user:client-review', format: 'prores_hq', loudness: 'off' })],
      lastPreset: {},
    });
    expect(findExportPreset('Client Review')?.id).toBe('user:client-review');
    expect(useExportPresetStore.getState().deletePreset('master')).toEqual({ error: expect.stringContaining('built-in') });
    expect(useExportPresetStore.getState().deletePreset('client review')).toEqual({ ok: true });
    expect(useExportPresetStore.getState().userPresets).toHaveLength(0);
  });

  it('hydrates from the settings file, skipping entries another version wrote badly, without writing back', () => {
    const sink = vi.fn();
    useExportPresetStore.getState().setPersist(sink);
    useExportPresetStore.getState().hydrate({
      presets: [{ id: 'user:a', name: 'A', width: 640, height: 360, loudness: 'podcast', format: 'h264' }, { name: '' }, 42],
      lastPreset: { landscape: 'user:a', portrait: 7 },
    });
    expect(useExportPresetStore.getState().userPresets.map((p) => p.name)).toEqual(['A']);
    expect(useExportPresetStore.getState().lastPreset).toEqual({ landscape: 'user:a' });
    expect(sink).not.toHaveBeenCalled();
  });

  it('the MCP ops list every preset and save / delete through the same store', () => {
    expect(saveExportPresetOp({ name: 'Review', width: 1280, height: 720, loudness: 'youtube' })).toMatchObject({
      ok: true,
      preset: { id: 'user:review', summary: '1280 × 720 · H.264 MP4 · YouTube, −14 LUFS' },
    });
    const listed = listExportPresetsOp().presets as Array<{ id: string; builtIn: boolean }>;
    expect(listed.map((p) => p.id)).toContain('user:review');
    expect(listed.filter((p) => p.builtIn)).toHaveLength(BUILT_IN_EXPORT_PRESETS.length);
    expect(saveExportPresetOp({ name: 'Review', delete: true })).toEqual({ ok: true, deleted: 'Review' });
    expect(saveExportPresetOp({ name: 'Review', delete: true })).toEqual({ error: expect.stringContaining('no saved preset') });
  });
});

describe('the default "Save as"', () => {
  it('is ~/Movies/<project>/<timeline>.<ext>, never an existing file (the backend picks the free name)', async () => {
    invokeMock.mockResolvedValueOnce('/Users/me/Movies/Five Levels/Voiceover v2 2.mov');
    const path = await defaultExportPath('/Users/me/Projects/Five Levels.apelles', 'Voiceover v2', 'prores_hq');
    expect(invokeMock).toHaveBeenCalledWith('chroma_unused_export_path', {
      dir: '/Users/me/Movies/Five Levels',
      stem: 'Voiceover v2',
      ext: 'mov',
    });
    expect(path).toBe('/Users/me/Movies/Five Levels/Voiceover v2 2.mov');
    expect(projectNameOf('untitled:Draft')).toBe('Draft');
    expect(projectNameOf(null)).toBe('Apelles');
  });
});

describe('the codec tail per format', () => {
  it('software H.264 is libx264 CRF 18; software ProRes 422 HQ is prores_ks profile 3 with PCM sound', () => {
    expect(audioCodecArgs('h264')).toEqual([]);
    expect(pipeVideoCodecArgs('h264', 'software')).toEqual(['-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p']);
    const prores = ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le'];
    expect(pipeVideoCodecArgs('prores_hq', 'software')).toEqual(prores);
    expect(audioCodecArgs('prores_hq')).toEqual(['-c:a', 'pcm_s24le']);
  });

  it('D-446 — the hardware encoder is VideoToolbox: H.264 at q 70, ProRes 422 HQ fed bgra', () => {
    const h264 = ['-c:v', 'h264_videotoolbox', '-q:v', '70', '-pix_fmt', 'yuv420p'];
    expect(pipeVideoCodecArgs('h264', 'hardware')).toEqual(h264);
    const prores = ['-c:v', 'prores_videotoolbox', '-profile:v', '3', '-pix_fmt', 'bgra'];
    expect(pipeVideoCodecArgs('prores_hq', 'hardware')).toEqual(prores);
  });

  it('D-446 — a compiler caller that names no encoder still gets the pre-D-446 software argv', () => {
    const tl = {
      id: 't',
      name: 't',
      rate: { num: 30, den: 1 },
      tracks: [{ kind: 'audio', clips: [{ id: 'a', name: 'a', source_path: '/m/a.wav', source_start: 0, duration: 30, source_len: 30, start_frame: 0 }] }],
    } as unknown as Timeline;
    const plan = buildPipeExportPlan(tl, '/out/m.mp4', { fps: 30, width: 64, height: 64 }, 1);
    expect(plan.args.join(' ')).toContain('-c:v libx264 -crf 18');
    const hw = buildPipeExportPlan(tl, '/out/m.mp4', { fps: 30, width: 64, height: 64, encoder: 'hardware' }, 1);
    expect(hw.args.join(' ')).toContain('-c:v h264_videotoolbox -q:v 70');
    expect(hw.segments.segmentArgs.join(' ')).toContain('-c:v h264_videotoolbox -q:v 70');
  });

  it('the compositor plan encodes every segment as ProRes and muxes PCM at the concat step', () => {
    const tl = {
      id: 't',
      name: 't',
      rate: { num: 30, den: 1 },
      tracks: [{ kind: 'audio', clips: [{ id: 'a', name: 'a', source_path: '/m/a.wav', source_start: 0, duration: 30, source_len: 30, start_frame: 0 }] }],
    } as unknown as Timeline;
    const opts = { fps: 30, width: 64, height: 64, format: 'prores_hq' } as TimelineExportOptions;
    const plan = buildPipeExportPlan(tl, '/out/m.mov', opts, 1);
    expect(plan.args.join(' ')).toContain('prores_ks');
    expect(plan.args.join(' ')).toContain('-c:a pcm_s24le');
    expect(plan.segments.segmentArgs.join(' ')).toContain('prores_ks');
    expect(plan.segments.concatArgs.join(' ')).toContain('-c:a pcm_s24le');
    expect(plan.segments.concatArgs.join(' ')).toContain('-c:v copy');
  });

  it('estimates the file size from the format, pixels, rate and length', () => {
    const h264 = estimateExportBytes('h264', 1920, 1080, 30, 464);
    expect(fmtApproxSize(h264)).toBe('≈ 852 MB');
    expect(estimateExportBytes('prores_hq', 1920, 1080, 30, 464)).toBeGreaterThan(h264 * 10);
    expect(fmtApproxSize(estimateExportBytes('h264', 3840, 2160, 30, 464))).toBe('≈ 3.4 GB');
  });
});
