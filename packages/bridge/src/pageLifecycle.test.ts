// B-274 — a reload without a goodbye is a killed web process, and is reported.
import { describe, expect, it } from 'vitest';
import { classifyPageStart, pageStart, watchPageUnload, type MarkerStorage } from './pageLifecycle';

function memoryStorage(): MarkerStorage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

function fakeWindow() {
  const handlers = new Set<() => void>();
  return {
    addEventListener: (_t: string, h: () => void) => void handlers.add(h),
    removeEventListener: (_t: string, h: () => void) => void handlers.delete(h),
    fire: () => handlers.forEach((h) => h()),
  };
}

describe('page lifecycle (B-274)', () => {
  it('a fresh session is "first"', () => {
    expect(classifyPageStart(memoryStorage())).toBe('first');
  });

  it('a page that said goodbye (pagehide) is followed by a clean reload', () => {
    const storage = memoryStorage();
    const win = fakeWindow();
    classifyPageStart(storage);
    watchPageUnload(win as never, storage);
    win.fire();
    expect(classifyPageStart(storage)).toBe('clean-reload');
  });

  it('a page that never got to say goodbye is followed by an unexpected reload', () => {
    const storage = memoryStorage();
    classifyPageStart(storage); // page 1 starts, is killed: no pagehide
    expect(classifyPageStart(storage)).toBe('unexpected-reload');
    // and the one after that, which did exit cleanly, is clean again
    const win = fakeWindow();
    watchPageUnload(win as never, storage);
    win.fire();
    expect(classifyPageStart(storage)).toBe('clean-reload');
  });

  it('claims nothing when storage is unusable', () => {
    const broken: MarkerStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(classifyPageStart(broken)).toBe('first');
  });

  it('stops listening when uninstalled', () => {
    const storage = memoryStorage();
    const win = fakeWindow();
    classifyPageStart(storage);
    const off = watchPageUnload(win as never, storage);
    off();
    win.fire();
    expect(classifyPageStart(storage)).toBe('unexpected-reload');
  });

  it('classifies once per page, so a double-mount does not read its own marker', () => {
    const storage = memoryStorage();
    const page = {};
    classifyPageStart(storage); // the previous page, killed
    expect(pageStart(page, storage)).toBe('unexpected-reload');
    expect(pageStart(page, storage)).toBe('unexpected-reload'); // cached, not "running" re-read
    const fresh = {};
    expect(pageStart(fresh, storage)).toBe('unexpected-reload'); // new page, previous still running
  });
});
