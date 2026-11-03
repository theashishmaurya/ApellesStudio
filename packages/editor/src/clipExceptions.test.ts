// D-448 — the export's Clip exceptions become ordinary clip data on a copy of
// the timeline, which the compositor draws and the sound is compiled from.
import { describe, expect, it } from 'vitest';
import { applyHoldLastFrame, applySpeedAndStretch, hasClipExceptions } from './clipExceptions';
import { buildPipeExportPlan } from './timelinePipeExport';
import { exportTotalDurationSec } from './exportTimeline';
import type { Clip, Timeline } from './timeline';

const clip = (id: string, over: Partial<Clip> = {}): Clip => ({
  id,
  name: id,
  source_path: `/m/${id}.mp4`,
  source_start: 30,
  duration: 90,
  source_len: 900,
  source_fps: 30,
  start_frame: 0,
  ...over,
});

const timeline = (): Timeline => ({
  id: 't',
  name: 't',
  rate: { num: 30, den: 1 },
  tracks: [
    { kind: 'video', clips: [clip('fast')] },
    { kind: 'video', clips: [clip('long', { duration: 180 })] },
    { kind: 'audio', clips: [clip('music', { duration: 180 })] },
  ],
});

describe('D-448 — Clip exceptions as clip data', () => {
  it('nothing asked: the same timeline object comes back', () => {
    const tl = timeline();
    expect(hasClipExceptions({ speedOverrides: { fast: 1 } })).toBe(false);
    expect(applySpeedAndStretch(tl, {})).toBe(tl);
    expect(applyHoldLastFrame(tl, {}, 180)).toBe(tl);
  });

  it('a speed override is a one-run ramp from the clip’s in-point, and a clip with its own ramp keeps it', () => {
    const tl = timeline();
    tl.tracks[1].clips[0].speed_points = [{ source_frame: 60, speed: 0.5 }];
    const out = applySpeedAndStretch(tl, { speedOverrides: { fast: 2, long: 3, music: 1.5 } });
    expect(out.tracks[0].clips[0].speed_points).toEqual([{ source_frame: 30, speed: 2 }]);
    expect(out.tracks[1].clips[0].speed_points).toEqual([{ source_frame: 60, speed: 0.5 }]);
    expect(out.tracks[2].clips[0].speed_points).toEqual([{ source_frame: 30, speed: 1.5 }]);
    expect(tl.tracks[0].clips[0].speed_points, 'the stored document is untouched').toBeUndefined();
  });

  it('the retimed copy is as long as the speed change makes it', () => {
    const tl = timeline();
    const opts = { fps: 30, width: 1920, height: 1080 };
    expect(exportTotalDurationSec(tl, opts)).toBe(6);
    const viaRamp = exportTotalDurationSec(applySpeedAndStretch(tl, { speedOverrides: { long: 2, music: 2 } }), opts);
    expect(viaRamp).toBe(3);
  });

  it('stretch marks the clip; hold-last-frame holds to the export’s end', () => {
    const tl = timeline();
    const s = applySpeedAndStretch(tl, { fitOverrides: { fast: 'stretch', long: 'fit' } });
    expect(s.tracks[0].clips[0].stretch).toBe(true);
    expect(s.tracks[1].clips[0].stretch).toBeUndefined();
    const h = applyHoldLastFrame(s, { freezeOverrides: { fast: true, long: false } }, 180);
    expect(h.tracks[0].clips[0].hold_until_frame).toBe(180);
    expect(h.tracks[1].clips[0].hold_until_frame).toBeUndefined();
  });

  it('the sound of a sped-up clip is compiled from the ramp the picture plays', () => {
    const tl = applySpeedAndStretch(timeline(), { speedOverrides: { music: 2 } });
    const opts = { fps: 30, width: 1920, height: 1080, hasAudioOverrides: { music: true } };
    const plan = buildPipeExportPlan(tl, '/o.mp4', opts, exportTotalDurationSec(tl, opts));
    expect(plan.args.join(' ')).toContain('atempo=2');
  });
});
