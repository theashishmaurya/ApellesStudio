import { mkdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { isScreenLockedError } from './activation.ts';
import { OpError, type OpClient } from './client.ts';
import { isMissingProjectError, readStartState, restore, type ScratchProject } from './fixture.ts';

/** A scripted app: each op answers from `handlers`, and every call is recorded. */
function fakeClient(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const client: OpClient = {
    async op<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
      calls.push({ op, args });
      const h = handlers[op];
      if (!h) throw new OpError(op, 'unknown op');
      return h(args) as T;
    },
  };
  return { client, calls };
}

const dirs: string[] = [];
function scratch(originalProject: string | null): ScratchProject {
  const root = mkdtempSync(join(tmpdir(), 'fixture-test-'));
  dirs.push(root);
  const path = join(root, 'ui-harness-2026.chroma');
  mkdirSync(path);
  return { path, mediaIds: { video: 'v', av: 'a', tone: 't' }, mediaFps: { video: 30, av: 30, tone: 24 }, originalProject };
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('restore (B-356)', () => {
  it('closes the project BEFORE deleting the folder when nothing was open at the start', async () => {
    const project = scratch(null);
    const { client, calls } = fakeClient({
      close_project: () => {
        // The folder must still be there while the app is leaving it.
        expect(existsSync(project.path)).toBe(true);
        return { closed: project.path };
      },
    });
    const notes = await restore(client, project, { keep: false });
    expect(calls.map((c) => c.op)).toEqual(['close_project']);
    expect(existsSync(project.path)).toBe(false);
    expect(notes.join('\n')).toContain('deleted the scratch project');
  });

  it('reopens the original project (and does not close) when one was open', async () => {
    const project = scratch('/p/original.chroma');
    const { client, calls } = fakeClient({ open_project: () => ({}) });
    await restore(client, project, { keep: false });
    expect(calls).toEqual([{ op: 'open_project', args: { path: '/p/original.chroma' } }]);
    expect(existsSync(project.path)).toBe(false);
  });

  it('keeps the folder, and says so, when the reopen fails', async () => {
    const project = scratch('/p/original.chroma');
    const { client } = fakeClient({
      open_project: () => {
        throw new OpError('open_project', 'gone');
      },
    });
    const notes = await restore(client, project, { keep: false });
    expect(existsSync(project.path)).toBe(true);
    expect(notes.join('\n')).toContain('could not reopen');
    expect(notes.join('\n')).toContain('did NOT delete');
  });

  it('keeps the folder, and says so, when close_project fails', async () => {
    const project = scratch(null);
    const { client } = fakeClient({
      close_project: () => {
        throw new OpError('close_project', 'unknown op: close_project');
      },
    });
    const notes = await restore(client, project, { keep: false });
    expect(existsSync(project.path)).toBe(true);
    expect(notes.join('\n')).toContain('did NOT delete');
  });

  it('with --keep-project closes but never deletes', async () => {
    const project = scratch(null);
    const { client, calls } = fakeClient({ close_project: () => ({ closed: project.path }) });
    await restore(client, project, { keep: true });
    expect(calls.map((c) => c.op)).toEqual(['close_project']);
    expect(existsSync(project.path)).toBe(true);
  });
});

const MISSING = 'editor_get_state: read /Users/x/Movies/Chroma/ui-harness-2026.chroma/project.json: No such file or directory (os error 2)';

describe('readStartState (B-356)', () => {
  it('recognises the missing-project-folder error and nothing else', () => {
    expect(isMissingProjectError(MISSING)).toBe(true);
    expect(isMissingProjectError('could not reach the control server')).toBe(false);
  });

  it('returns the state untouched when the app is healthy', async () => {
    const { client, calls } = fakeClient({ editor_get_state: () => ({ openProject: null, status: 'ready', activeTimeline: null }) });
    const r = await readStartState(client);
    expect(r.notes).toEqual([]);
    expect(calls.map((c) => c.op)).toEqual(['editor_get_state']);
  });

  it('closes a project whose folder is gone, retries, and notes it', async () => {
    let closed = false;
    const { client, calls } = fakeClient({
      editor_get_state: () => {
        if (!closed) throw new OpError('editor_get_state', MISSING.replace('editor_get_state: ', ''));
        return { openProject: null, status: 'ready', activeTimeline: null };
      },
      close_project: () => {
        closed = true;
        return { closed: '/x/ui-harness-2026.chroma' };
      },
    });
    const r = await readStartState(client);
    expect(calls.map((c) => c.op)).toEqual(['editor_get_state', 'close_project', 'editor_get_state']);
    expect(r.state.openProject).toBeNull();
    expect(r.notes[0]).toContain('folder is gone');
  });

  it('rethrows any other failure (the app is not running)', async () => {
    const { client } = fakeClient({
      editor_get_state: () => {
        throw new OpError('editor_get_state', 'could not reach the control server');
      },
    });
    await expect(readStartState(client)).rejects.toThrow('could not reach');
  });
});

describe('isScreenLockedError (B-352)', () => {
  it('matches the locked-screen activation failure only', () => {
    expect(isScreenLockedError('debug_activate_app: activation did not take: the frontmost app is loginwindow (loginwindow means the Mac is locked or asleep)')).toBe(true);
    expect(isScreenLockedError('activation did not take: the frontmost app is Safari (loginwindow means the Mac is locked or asleep)')).toBe(false);
  });
});
