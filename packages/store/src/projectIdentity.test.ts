// D-358 / B-217 — the cross-store project-identity guard.
//
// The scenario every test here is built from is the one the bug report measured
// live: `useSessionStore` holds a real project, while a store the composition
// root was supposed to have bridged that identity into is still on
// `untitled:Untitled`. That is not reproducible from a unit test by causing it
// (it needs a Vite dev server and hours of HMR churn) — so these induce it
// directly, which is the thing the guard actually has to notice.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ProjectIdentityError,
  __resetProjectIdentityForTests,
  assertProjectIdentity,
  readProjectIdentityDivergences,
  registerProjectIdentityAuthority,
  registerProjectIdentityParticipant,
  setProjectIdentityAlertSink,
} from './projectIdentity';

const PROJECT_A = '/Users/x/Movies/2026-09-12-c040-mgfx';
const UNTITLED = 'untitled:Untitled';

/** Stand-ins for the real three: the app's session store and the per-project
 *  stores the composition root bridges into. Plain mutable objects, because what
 *  is under test is the comparison, not zustand. */
let session = { projectKey: null as string | null, projectPath: null as string | null };
let editKey: string | null = null;
let motionPath: string | null = null;

function registerTheRealShape() {
  registerProjectIdentityAuthority(() => session);
  registerProjectIdentityParticipant('edit', {
    label: 'Edit timeline',
    read: () => editKey,
    expected: (s) => s.projectKey,
  });
  registerProjectIdentityParticipant('motion', {
    label: 'Motion manifest',
    read: () => motionPath,
    expected: (s) => s.projectPath,
  });
}

beforeEach(() => {
  __resetProjectIdentityForTests();
  session = { projectKey: null, projectPath: null };
  editKey = null;
  motionPath = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetProjectIdentityForTests();
});

describe('readProjectIdentityDivergences', () => {
  it('reports nothing with no authority registered — a harness or a unit test', () => {
    registerProjectIdentityParticipant('edit', {
      label: 'Edit timeline',
      read: () => PROJECT_A,
      expected: (s) => s.projectKey,
    });

    expect(readProjectIdentityDivergences()).toEqual([]);
  });

  it('reports nothing when every store agrees', () => {
    registerTheRealShape();
    session = { projectKey: PROJECT_A, projectPath: PROJECT_A };
    editKey = PROJECT_A;
    motionPath = PROJECT_A;

    expect(readProjectIdentityDivergences()).toEqual([]);
  });

  it('reports nothing for an Untitled session, where Motion correctly holds null', () => {
    registerTheRealShape();
    // The in-memory loose-clip session: a project *key* but no project *path*,
    // and Motion's manifest sidecar genuinely has nowhere to live.
    session = { projectKey: UNTITLED, projectPath: null };
    editKey = UNTITLED;
    motionPath = null;

    expect(readProjectIdentityDivergences()).toEqual([]);
  });

  it("names exactly the store that diverged — B-217's own measured wedge", () => {
    registerTheRealShape();
    session = { projectKey: PROJECT_A, projectPath: PROJECT_A };
    editKey = UNTITLED; // the duplicated-store symptom, verbatim
    motionPath = PROJECT_A;

    expect(readProjectIdentityDivergences()).toEqual([
      { id: 'edit', label: 'Edit timeline', held: UNTITLED, expected: PROJECT_A },
    ]);
  });

  it('reports every diverged store, not just the first', () => {
    registerTheRealShape();
    session = { projectKey: PROJECT_A, projectPath: PROJECT_A };
    editKey = UNTITLED;
    motionPath = null;

    expect(readProjectIdentityDivergences().map((d) => d.id)).toEqual(['edit', 'motion']);
  });
});

describe('assertProjectIdentity', () => {
  it('resolves, immediately, when the stores agree', async () => {
    registerTheRealShape();
    session = { projectKey: PROJECT_A, projectPath: PROJECT_A };
    editKey = PROJECT_A;
    motionPath = PROJECT_A;

    const began = Date.now();
    await expect(assertProjectIdentity('editor_add_clip')).resolves.toBeUndefined();
    expect(Date.now() - began).toBeLessThan(100);
  });

  it('refuses the op when a store has diverged, naming both identities', async () => {
    registerTheRealShape();
    session = { projectKey: PROJECT_A, projectPath: PROJECT_A };
    editKey = UNTITLED;
    motionPath = PROJECT_A;

    const thrown = await assertProjectIdentity('editor_add_clip').then(
      () => null,
      (e: unknown) => e,
    );

    expect(thrown).toBeInstanceOf(ProjectIdentityError);
    const err = thrown as ProjectIdentityError;
    expect(err.divergences).toEqual([
      { id: 'edit', label: 'Edit timeline', held: UNTITLED, expected: PROJECT_A },
    ]);
    expect(err.message).toContain('editor_add_clip');
    expect(err.message).toContain(UNTITLED);
    expect(err.message).toContain(PROJECT_A);
    expect(err.message).toContain('B-217');
  });

  it('is loud: console.error AND the installed GUI sink both get the failure', async () => {
    registerTheRealShape();
    session = { projectKey: PROJECT_A, projectPath: PROJECT_A };
    editKey = UNTITLED;
    const alerts: string[] = [];
    setProjectIdentityAlertSink((m) => alerts.push(m));

    await expect(assertProjectIdentity('editor_add_clip')).rejects.toBeInstanceOf(
      ProjectIdentityError,
    );

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('B-217');
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('tolerates the composition root\'s one-tick bridge lag instead of failing on it', async () => {
    registerTheRealShape();
    session = { projectKey: PROJECT_A, projectPath: PROJECT_A };
    editKey = null; // the React effect that bridges it has not run yet
    motionPath = null;

    // …and then it runs, the way `Root.tsx`'s effect does.
    setTimeout(() => {
      editKey = PROJECT_A;
      motionPath = PROJECT_A;
    }, 40);

    await expect(assertProjectIdentity('editor_get_state')).resolves.toBeUndefined();
  });

  it('does not block an op while nothing has registered an authority', async () => {
    await expect(assertProjectIdentity('editor_get_state')).resolves.toBeUndefined();
  });
});
