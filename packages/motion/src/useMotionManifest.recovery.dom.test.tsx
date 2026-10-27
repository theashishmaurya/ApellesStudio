// @vitest-environment jsdom
/**
 * @apelles/motion — unsaved Motion edits survive a page reload, end to end in a
 * DOM (D-415, roadmap 0g).
 *
 * The real `useMotionManifest` + the real `motionProjectStore`, against a fake
 * BACKEND whose state outlives each "page" (mount/unmount of the harness plus a
 * store reset is a reload: the webview's memory is gone, the project on disk is
 * not). The fake mirrors the real commands' rules: the recovery write stamps
 * the saved-manifest version, `stale` is "that version moved", and
 * `chroma_motion_save_manifest` clears the copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Manifest } from '@apelles/motion-engine/src/engine/schema';
import { useHistoryStore } from '@apelles/history';
import { sample } from '@apelles/motion-engine/src/engine/sample';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT = '/projects/a.chroma';

/** The project on disk, as the backend sees it. */
const disk = vi.hoisted(() => ({
  manifest: null as unknown,
  manifestVersion: 0,
  recovery: null as null | { text: string; base: number },
  calls: [] as string[],
  jobStartManifests: [] as unknown[],
  /** the shape of `MotionRenderStatus`, minus its state */
  status: {
    scenesTotal: null,
    scenesDone: 0,
    sceneId: null,
    failedSceneId: null,
    error: null,
    doneSceneIds: [] as string[],
    remainingSceneIds: [] as string[],
    unreconciled: [] as unknown[],
    outputs: [] as unknown[],
    manifestHash: null,
  },
}));

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (p: string) => p,
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    disk.calls.push(cmd);
    switch (cmd) {
      case 'chroma_motion_get_manifest':
        return disk.manifest;
      case 'chroma_motion_save_manifest':
        disk.manifest = args?.manifest;
        disk.manifestVersion += 1;
        disk.recovery = null; // what motion.rs does
        return '/projects/a.chroma/motion/manifest.json';
      case 'chroma_motion_recovery_read':
        return disk.recovery
          ? { text: disk.recovery.text, stale: disk.recovery.base !== disk.manifestVersion }
          : null;
      case 'chroma_motion_recovery_write':
        disk.recovery = { text: args?.text as string, base: disk.manifestVersion };
        return null;
      case 'chroma_motion_recovery_clear':
        disk.recovery = null;
        return null;
      case 'chroma_motion_job_status':
        return { ...disk.status, state: 'idle' };
      case 'chroma_motion_job_start':
        disk.jobStartManifests.push(args?.manifest);
        return { ...disk.status, state: 'done' };
      default:
        return null;
    }
  },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => undefined }));

const { useMotionManifest } = await import('./useMotionManifest');
const { useMotionProjectStore } = await import('./motionProjectStore');
const { RECOVERY_DEBOUNCE_MS } = await import('./recoveryWriter');

type Api = ReturnType<typeof useMotionManifest>;
let latest: Api | null = null;
function Harness() {
  latest = useMotionManifest();
  return null;
}
const api = (): Api => {
  if (!latest) throw new Error('harness not mounted');
  return latest;
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const settle = (ms = 0) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/** A fresh page: a new store state and a new hook instance over the same disk. */
async function openPage() {
  useMotionProjectStore.getState().setOpenProject(null);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<Harness />));
  await act(async () => useMotionProjectStore.getState().setOpenProject(PROJECT));
  await settle(20);
}

/** The page dies. Nothing runs on the way out except what the hook itself does
 *  on unmount (a killed process runs nothing; the 250 ms debounce is what
 *  `waitForWrite` lets elapse beforehand). */
async function closePage() {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  latest = null;
}

const waitForWrite = () => settle(RECOVERY_DEBOUNCE_MS + 100);

const savedManifest = { ...(sample as Manifest), title: 'Saved title' } as Manifest;
const edit = (title: string) => act(async () => api().commit({ ...(api().manifest as Manifest), title }, 'Edit title'));

beforeEach(() => {
  disk.manifest = savedManifest;
  disk.manifestVersion = 1;
  disk.recovery = null;
  disk.calls = [];
  disk.jobStartManifests = [];
});

afterEach(async () => {
  await closePage();
  useMotionProjectStore.getState().setOpenProject(null);
});

describe('unsaved Motion edits across a reload (D-415)', () => {
  it('restores the edit, flags it, keeps it unsaved, and a save clears the copy', async () => {
    await openPage();
    expect(api().loadState).toBe('ready');
    expect(api().dirty).toBe(false);
    expect(disk.recovery).toBeNull();

    await edit('Unsaved title');
    await waitForWrite();
    expect(disk.recovery).not.toBeNull();
    expect(JSON.parse(disk.recovery?.text ?? '{}').title).toBe('Unsaved title');
    expect((disk.manifest as Manifest).title).toBe('Saved title'); // nothing saved on the person's behalf

    await closePage();
    await openPage();

    expect(api().loadState).toBe('ready');
    expect(api().manifest?.title).toBe('Unsaved title');
    expect(api().dirty).toBe(true);
    expect(api().recovered).toEqual({ stale: false });
    expect((disk.manifest as Manifest).title).toBe('Saved title');

    await act(async () => {
      await api().save();
    });
    await settle(20);
    expect((disk.manifest as Manifest).title).toBe('Unsaved title');
    expect(disk.recovery).toBeNull();
    expect(api().dirty).toBe(false);
    expect(api().recovered).toBeNull();
  });

  it('a page that had nothing unsaved restores nothing', async () => {
    await openPage();
    await closePage();
    await openPage();
    expect(api().recovered).toBeNull();
    expect(api().dirty).toBe(false);
  });

  it('editing back to the saved document removes the copy', async () => {
    await openPage();
    await edit('Other');
    await waitForWrite();
    expect(disk.recovery).not.toBeNull();
    await act(async () => useHistoryStore.getState().undo()); // back to exactly the saved text
    await settle(20);
    expect(api().dirty).toBe(false);
    expect(disk.recovery).toBeNull();
  });

  it('a copy made against an older saved manifest is restored and marked stale', async () => {
    await openPage();
    await edit('Unsaved title');
    await waitForWrite();
    await closePage();

    // someone saved a different manifest in the meantime
    disk.manifest = { ...savedManifest, title: 'Saved elsewhere' };
    disk.manifestVersion += 1;

    await openPage();
    expect(api().manifest?.title).toBe('Unsaved title');
    expect(api().recovered).toEqual({ stale: true });
    expect((disk.manifest as Manifest).title).toBe('Saved elsewhere'); // still not overwritten
  });

  it('a copy equal to the saved document (saved after it was made) is dropped, not restored', async () => {
    disk.recovery = { text: JSON.stringify(savedManifest, null, 2), base: 0 };
    await openPage();
    expect(api().recovered).toBeNull();
    expect(api().dirty).toBe(false);
    await settle(20);
    expect(disk.recovery).toBeNull();
  });

  it('restores a project that never saved a manifest, from the engine sample', async () => {
    disk.manifest = null;
    disk.manifestVersion = 0;
    await openPage();
    expect(api().dirty).toBe(true); // starts on the sample, as before
    expect(disk.recovery).toBeNull(); // the untouched sample is not a recovery
    await edit('Fresh');
    await waitForWrite();
    await closePage();
    await openPage();
    expect(api().manifest?.title).toBe('Fresh');
    expect(api().recovered).toEqual({ stale: false });
  });

  it('a render takes the edited manifest it is handed and never reads the recovery copy', async () => {
    await openPage();
    await edit('Unsaved title');
    await waitForWrite();
    await closePage();
    await openPage();

    disk.calls = [];
    await act(async () => {
      await api().render();
    });
    expect(disk.calls).not.toContain('chroma_motion_recovery_read');
    expect(disk.calls).toContain('chroma_motion_job_start');
    // the manifest the job gets is the document the person is looking at
    expect((disk.jobStartManifests[0] as Manifest).title).toBe('Unsaved title');
  });
});
