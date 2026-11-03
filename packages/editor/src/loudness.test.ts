// @apelles/editor — export loudness target (D-401): the preset table / validator,
// and the contract that `off` leaves an export exactly as it was.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

const { resolveLoudnessTarget, LOUDNESS_PRESETS } = await import('./loudness');
const { runCompiledExport } = await import('./editorExport');

const plan = { width: 2, height: 2, frames: 1, fps: 30, format: 'h264' as const };

describe('resolveLoudnessTarget', () => {
  it('maps each preset to its spec', () => {
    expect(resolveLoudnessTarget({ loudnessPreset: 'youtube' })).toEqual({ ok: true, target: { integratedLufs: -14, truePeakDbtp: -1 } });
    expect(resolveLoudnessTarget({ loudnessPreset: 'broadcast' })).toEqual({ ok: true, target: { integratedLufs: -23, truePeakDbtp: -1 } });
    expect(resolveLoudnessTarget({ loudnessPreset: 'podcast' })).toEqual({ ok: true, target: { integratedLufs: -16, truePeakDbtp: -1 } });
    expect(Object.keys(LOUDNESS_PRESETS)).toHaveLength(3);
  });

  it('off and no fields at all both mean no post-processing', () => {
    expect(resolveLoudnessTarget({ loudnessPreset: 'off' })).toEqual({ ok: true, target: null });
    expect(resolveLoudnessTarget({})).toEqual({ ok: true, target: null });
  });

  it('accepts a custom target, defaulting the ceiling to -1 dBTP', () => {
    expect(resolveLoudnessTarget({ loudnessLufs: -18 })).toEqual({ ok: true, target: { integratedLufs: -18, truePeakDbtp: -1 } });
    expect(resolveLoudnessTarget({ loudnessLufs: -18, truePeakDbtp: -2 })).toEqual({ ok: true, target: { integratedLufs: -18, truePeakDbtp: -2 } });
  });

  it('refuses ambiguous, out-of-range and half-given input', () => {
    expect(resolveLoudnessTarget({ loudnessPreset: 'youtube', loudnessLufs: -14 }).ok).toBe(false);
    expect(resolveLoudnessTarget({ loudnessPreset: 'off', loudnessLufs: -14 }).ok).toBe(false);
    expect(resolveLoudnessTarget({ loudnessPreset: 'cinema' }).ok).toBe(false);
    expect(resolveLoudnessTarget({ loudnessLufs: 3 }).ok).toBe(false);
    expect(resolveLoudnessTarget({ loudnessLufs: -14, truePeakDbtp: 2 }).ok).toBe(false);
    expect(resolveLoudnessTarget({ truePeakDbtp: -1 }).ok).toBe(false);
  });
});

describe('runCompiledExport and the loudness target', () => {
  beforeEach(() => invokeMock.mockReset());

  it('off: the render path carries no loudness target to the renderer', async () => {
    invokeMock.mockResolvedValueOnce({ ok: true, frames: 1, segments: 1, ms: 1, stderr_tail: '' });
    await runCompiledExport(['-y'], plan, '/tmp/out.mp4');
    expect(invokeMock.mock.calls[0][1].req.loudness).toBeNull();
  });

  it('a cancelled run reports cancelled, not failed (D-441)', async () => {
    invokeMock.mockResolvedValueOnce({ ok: false, cancelled: true, frames: 0, segments: 1, ms: 1, stderr_tail: 'the export was cancelled' });
    const r = await runCompiledExport(['-y'], plan, '/tmp/out.mp4', undefined, undefined, 'job-2');
    expect(r.ok).toBe(false);
    expect(r.cancelled).toBe(true);
  });

  it('on, render path: the target rides in the render request', async () => {
    invokeMock.mockResolvedValueOnce({ ok: true, frames: 1, segments: 1, ms: 1, stderr_tail: '', loudness: { gainDb: 1 } });
    const r = await runCompiledExport(['-y'], plan, '/tmp/out.mp4', LOUDNESS_PRESETS.broadcast);
    expect(invokeMock.mock.calls[0][1].req.loudness).toEqual(LOUDNESS_PRESETS.broadcast);
    expect(r.loudness).toEqual({ gainDb: 1 });
  });
});
