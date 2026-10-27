// @apelles/bridge — the Motion render-runtime vocabulary (D-417): which states
// block a render and with what words, the progress number, and the
// "first time the tab opens" auto-install rule. The DOM wiring is
// `packages/motion/src/MotionRuntimeBanner.dom.test.tsx`.
import { describe, expect, it } from 'vitest';

import {
  formatMegabytes,
  motionRuntimeBlockedReason,
  motionRuntimeHeadline,
  motionRuntimeProgress,
  motionRuntimeReady,
  shouldAutoInstall,
  type MotionRuntimeState,
  type MotionRuntimeStatus,
} from './motionRuntime';

const MB = 1024 * 1024;

function status(over: Partial<MotionRuntimeStatus> = {}): MotionRuntimeStatus {
  return {
    state: 'missing',
    detail: 'not installed',
    bytesDone: 0,
    bytesTotal: 152 * MB,
    downloadBytes: 152 * MB,
    installedBytes: 0,
    versions: { node: '24.22.1', chrome: '149.0.7790.0', remotion: '4.0.519' },
    canInstall: true,
    canRemove: false,
    ...over,
  };
}

const ALL: MotionRuntimeState[] = ['unconfigured', 'ready', 'missing', 'outdated', 'broken', 'installing', 'failed', 'removing'];

describe('what blocks a render', () => {
  it('only ready renders', () => {
    for (const state of ALL) {
      const s = status({ state });
      expect(motionRuntimeReady(s)).toBe(state === 'ready');
      expect(motionRuntimeBlockedReason(s, 'Render') === null).toBe(state === 'ready');
    }
  });

  it('names the action and the reason', () => {
    expect(motionRuntimeBlockedReason(status({ state: 'installing', bytesDone: 38 * MB }), 'Still')).toBe(
      "Still needs Motion's renderer, which is downloading (25%).",
    );
    expect(
      motionRuntimeBlockedReason(status({ state: 'failed', error: 'cannot reach nodejs.org' }), 'Render'),
    ).toContain('download failed: cannot reach nodejs.org');
  });
});

describe('the banner line', () => {
  it('is null when ready, and says the size when missing', () => {
    expect(motionRuntimeHeadline(status({ state: 'ready' }))).toBeNull();
    expect(motionRuntimeHeadline(status())).toBe("Motion's renderer is not installed yet (a one-time 152 MB download)");
  });

  it('tells offline and disk-space failures apart', () => {
    expect(motionRuntimeHeadline(status({ state: 'failed', errorKind: 'offline' }))).toContain('no internet connection');
    expect(motionRuntimeHeadline(status({ state: 'failed', errorKind: 'diskSpace' }))).toContain('not enough disk space');
  });

  it('shows progress only while installing', () => {
    expect(motionRuntimeProgress(status({ state: 'installing', bytesDone: 76 * MB }))).toBe(50);
    expect(motionRuntimeProgress(status({ state: 'missing', bytesDone: 76 * MB }))).toBeNull();
    expect(motionRuntimeProgress(status({ state: 'installing', bytesTotal: 0 }))).toBeNull();
    expect(formatMegabytes(152 * MB + 1)).toBe('152 MB');
  });
});

describe('the auto-install rule', () => {
  it('installs once, only from a state an install fixes', () => {
    expect(shouldAutoInstall(status({ state: 'missing' }), false)).toBe(true);
    expect(shouldAutoInstall(status({ state: 'outdated' }), false)).toBe(true);
    expect(shouldAutoInstall(status({ state: 'broken' }), false)).toBe(true);
    expect(shouldAutoInstall(status({ state: 'missing' }), true)).toBe(false);
    expect(shouldAutoInstall(status({ state: 'failed' }), false)).toBe(false);
    expect(shouldAutoInstall(status({ state: 'installing', canInstall: false }), false)).toBe(false);
    expect(shouldAutoInstall(status({ state: 'ready', source: 'developer' }), false)).toBe(false);
    expect(shouldAutoInstall(status({ state: 'missing', canInstall: false }), false)).toBe(false);
  });
});
