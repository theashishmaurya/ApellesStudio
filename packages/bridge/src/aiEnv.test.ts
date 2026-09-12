// @apelles/bridge — unit tests for the AI-env status vocabulary (D-315).
//
// What these actually protect. This module's job is to turn one `AiEnvStatus`
// into the words a control shows, and its single most important property is a
// *negative* one: it must never report a control as unusable. The GUI half of
// D-315 deliberately shows state and refuses nothing, because whether a sidecar
// answers is not knowable from the bootstrap's phase — someone may have started
// one by hand, or set `CHROMA_SIDECAR_PYTHON` — and a pre-flight gate would
// break exactly those setups. That is easy to regress by adding one innocent
// "and disable the button when…", so it is asserted here rather than left to a
// comment. The rest is phase-by-phase wording, which is cheap to pin and
// otherwise only ever checked by eye.
import { describe, expect, it } from 'vitest';

import {
  aiEnvHeadline,
  aiEnvIsBuilding,
  aiEnvIsWorking,
  aiEnvNotice,
  aiEnvProgressLabel,
  aiEnvWarning,
  type AiEnvPhase,
  type AiEnvStatus,
} from './aiEnv';

const ALL_PHASES: AiEnvPhase[] = [
  'unknown',
  'checking',
  'installingPython',
  'creatingVenv',
  'installingPackages',
  'repairing',
  'ready',
  'failed',
  'unavailable',
];

function status(over: Partial<AiEnvStatus> = {}): AiEnvStatus {
  return {
    phase: 'ready',
    packagesDone: 0,
    packagesTotal: 0,
    attempt: 1,
    elapsedSecs: 0,
    ...over,
  };
}

describe('which phases are "still building"', () => {
  it('mirrors Phase::is_working() exactly', () => {
    // The Rust predicate this shadows. A phase added on one side and missed on
    // the other is silent: the control just stops explaining itself.
    expect(ALL_PHASES.filter(aiEnvIsWorking)).toEqual([
      'checking',
      'installingPython',
      'creatingVenv',
      'installingPackages',
      'repairing',
    ]);
  });

  it('counts `failed` as building too, but not `unknown` or `unavailable`', () => {
    // `failed` is worth saying out loud — an attempt is scheduled. `unknown` is
    // the first few milliseconds of every launch and must stay silent, or every
    // AI control flashes "setting up" at startup. `unavailable` is where a
    // hand-built venv lives and gets its own, different wording.
    expect(aiEnvIsBuilding(status({ phase: 'failed' }))).toBe(true);
    expect(aiEnvIsBuilding(status({ phase: 'unknown' }))).toBe(false);
    expect(aiEnvIsBuilding(status({ phase: 'unavailable' }))).toBe(false);
    expect(aiEnvIsBuilding(status({ phase: 'ready' }))).toBe(false);
  });
});

describe('the notice shown at an AI control', () => {
  it('names the feature and the real package count while installing', () => {
    const note = aiEnvNotice(
      status({ phase: 'installingPackages', packagesDone: 47, packagesTotal: 91 }),
      'Track subject',
    );
    expect(note).toContain('Track subject');
    expect(note).toContain('47 of 91 packages');
  });

  it('carries the failure reason and points at Settings when the build failed', () => {
    const note = aiEnvNotice(
      status({ phase: 'failed', lastError: 'network unreachable' }),
      'Captions from Transcript',
    );
    expect(note).toContain('network unreachable');
    expect(note).toContain('Settings');
  });

  it('says nothing at all on ready, unknown or unavailable', () => {
    // `unavailable` is covered by `aiEnvWarning` instead — a different message
    // with a different meaning, never both at once.
    for (const phase of ['ready', 'unknown', 'unavailable'] as AiEnvPhase[]) {
      expect(aiEnvNotice(status({ phase }), 'Bake Normals')).toBeNull();
    }
  });

  it('never claims the feature is blocked, refused or disabled', () => {
    // The negative property this whole module rests on (D-315): it reports a
    // state, it does not refuse. Wording that says otherwise would be a lie the
    // moment someone runs a sidecar by hand.
    const forbidden = /\b(blocked|disabled|unavailable until|cannot|can't|refus)/i;
    for (const phase of ALL_PHASES) {
      const note = aiEnvNotice(status({ phase, packagesDone: 3, packagesTotal: 91 }), 'Track depth');
      if (note) expect(note).not.toMatch(forbidden);
    }
  });
});

describe('progress and headline', () => {
  it('has no package label before uv has reported a total', () => {
    // Both counts are zero until `Resolved N packages` is parsed; "0 of 0
    // packages" would read as a stalled install rather than an unknown one.
    expect(aiEnvProgressLabel(status({ phase: 'installingPackages' }))).toBeNull();
    expect(
      aiEnvProgressLabel(status({ phase: 'installingPackages', packagesDone: 3, packagesTotal: 91 })),
    ).toBe('3 of 91 packages');
  });

  it('gives every phase a heading, and only the install phase a count', () => {
    for (const phase of ALL_PHASES) {
      expect(aiEnvHeadline(status({ phase, packagesDone: 3, packagesTotal: 91 }))).toBeTruthy();
    }
    expect(aiEnvHeadline(status({ phase: 'installingPackages', packagesDone: 3, packagesTotal: 91 })))
      .toContain('3 of 91');
    // `checking` re-verifies an existing venv and installs nothing, so a count
    // left over from a previous attempt must not be shown against it.
    expect(aiEnvHeadline(status({ phase: 'checking', packagesDone: 3, packagesTotal: 91 })))
      .not.toContain('3 of 91');
  });
});

describe('the unavailable warning', () => {
  it('fires only for unavailable, and repeats the backend’s own reason', () => {
    expect(aiEnvWarning(status({ phase: 'installingPackages' }))).toBeNull();
    expect(aiEnvWarning(status({ phase: 'failed' }))).toBeNull();
    const warning = aiEnvWarning(
      status({ phase: 'unavailable', detail: 'Automatic setup is disabled (CHROMA_AI_ENV_NO_BOOTSTRAP).' }),
    );
    expect(warning).toContain('CHROMA_AI_ENV_NO_BOOTSTRAP');
    // And it must not promise a retry: nothing is scheduled in this phase, and
    // `retry_now` declines it (B-174).
    expect(warning).not.toMatch(/retry|try again/i);
  });
});
