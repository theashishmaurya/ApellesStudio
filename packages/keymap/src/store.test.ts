/**
 * @apelles/keymap — registry + remap tests (D-272).
 *
 * These cover the three things the settings window promises and the two rules
 * the dispatcher depends on: a remap sticks and persists, reset-to-default
 * restores, conflicts are detected only where they can actually bite, and
 * resolution is deterministic and tab-scoped.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  conflictingIds,
  effectiveCombo,
  effectiveCombos,
  resolveShortcut,
  useKeymapStore,
  type Overrides,
} from './store';
import { SHORTCUT_DEFINITIONS, shortcutById } from './shortcuts';

const def = (id: string) => {
  const d = shortcutById(id);
  if (!d) throw new Error(`no such shortcut: ${id}`);
  return d;
};

beforeEach(() => {
  useKeymapStore.getState().setPersist(null);
  useKeymapStore.setState({ overrides: {}, activeScope: 'edit', osPlatform: 'macos' });
});

describe('the registry itself', () => {
  it('has unique ids', () => {
    const ids = SHORTCUT_DEFINITIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps every action in a category that exists', async () => {
    const { SHORTCUT_CATEGORIES } = await import('./shortcuts');
    const known = new Set(SHORTCUT_CATEGORIES.map((c) => c.id));
    for (const d of SHORTCUT_DEFINITIONS) expect(known.has(d.category)).toBe(true);
  });

  it('puts every action in the scope its category declares', async () => {
    const { SHORTCUT_CATEGORIES } = await import('./shortcuts');
    const scopeOf = new Map(SHORTCUT_CATEGORIES.map((c) => [c.id, c.scope]));
    for (const d of SHORTCUT_DEFINITIONS) expect(d.scope).toBe(scopeOf.get(d.category));
  });

  it('still carries the fork keybind ids verbatim, so existing remaps survive', () => {
    // A sample of ids that `app/src/utils/keyboardUtils.ts` persisted before
    // D-272 folded it in here. Renaming any of these silently drops a user's
    // saved remap, which is why this is pinned.
    for (const id of ['copy_files', 'zoom_100', 'toggle_masks', 'rate_3', 'brush_size_up']) {
      expect(shortcutById(id)).toBeDefined();
      expect(shortcutById(id)!.scope).toBe('colorist');
    }
  });
});

describe('effective bindings', () => {
  it('falls back to the default when there is no override', () => {
    expect(effectiveCombo(def('edit.play_pause'), {})).toEqual(['Space']);
  });

  it('prefers the user override', () => {
    expect(effectiveCombo(def('edit.play_pause'), { 'edit.play_pause': ['KeyP'] })).toEqual(['KeyP']);
  });

  it('treats an empty override as deliberately unassigned', () => {
    expect(effectiveCombo(def('edit.play_pause'), { 'edit.play_pause': [] })).toBeNull();
  });

  it('keeps built-in aliases while un-remapped, and drops them once remapped', () => {
    expect(effectiveCombos(def('app.redo'), {})).toEqual([
      ['ctrl', 'KeyY'],
      ['ctrl', 'shift', 'KeyZ'],
    ]);
    expect(effectiveCombos(def('app.redo'), { 'app.redo': ['ctrl', 'KeyR'] })).toEqual([['ctrl', 'KeyR']]);
  });
});

describe('remap, persist, reset', () => {
  it('remaps and hands the whole new map to the persistence sink', () => {
    const persist = vi.fn();
    useKeymapStore.getState().setPersist(persist);

    useKeymapStore.getState().setBinding('edit.play_pause', ['KeyP']);

    expect(useKeymapStore.getState().overrides).toEqual({ 'edit.play_pause': ['KeyP'] });
    expect(persist).toHaveBeenCalledWith({ 'edit.play_pause': ['KeyP'] });
  });

  it('survives a round trip through the persisted value', () => {
    const persist = vi.fn();
    useKeymapStore.getState().setPersist(persist);
    useKeymapStore.getState().setBinding('edit.split', ['ctrl', 'KeyJ']);

    const stored = persist.mock.calls.at(-1)![0] as Overrides;
    // A fresh launch: nothing in memory, the saved settings arrive.
    useKeymapStore.setState({ overrides: {} });
    useKeymapStore.getState().hydrate(stored);

    expect(effectiveCombo(def('edit.split'), useKeymapStore.getState().overrides)).toEqual(['ctrl', 'KeyJ']);
  });

  it('resets one binding back to its default', () => {
    useKeymapStore.getState().setBinding('edit.add_marker', ['KeyQ']);
    useKeymapStore.getState().resetBinding('edit.add_marker');

    expect(useKeymapStore.getState().overrides).toEqual({});
    expect(effectiveCombo(def('edit.add_marker'), useKeymapStore.getState().overrides)).toEqual(['KeyM']);
  });

  it('resets every binding at once', () => {
    useKeymapStore.getState().setBinding('edit.add_marker', ['KeyQ']);
    useKeymapStore.getState().setBinding('toggle_masks', ['KeyW']);

    const persist = vi.fn();
    useKeymapStore.getState().setPersist(persist);
    useKeymapStore.getState().resetAll();

    expect(useKeymapStore.getState().overrides).toEqual({});
    expect(persist).toHaveBeenCalledWith({});
  });

  it('does not store an "override" that equals the default', () => {
    useKeymapStore.getState().setBinding('edit.play_pause', ['Space']);
    expect(useKeymapStore.getState().overrides).toEqual({});
  });

  it('migrates the fork\'s pre-D-051 undo/redo ids on hydrate', () => {
    useKeymapStore.getState().hydrate({ undo: ['ctrl', 'KeyQ'], redo: ['ctrl', 'KeyW'] });
    const { overrides } = useKeymapStore.getState();
    expect(overrides['app.undo']).toEqual(['ctrl', 'KeyQ']);
    expect(overrides['app.redo']).toEqual(['ctrl', 'KeyW']);
    expect(overrides.undo).toBeUndefined();
  });

  it('hydration does not echo back out through the sink', () => {
    const persist = vi.fn();
    useKeymapStore.getState().setPersist(persist);
    useKeymapStore.getState().hydrate({ 'edit.split': ['ctrl', 'KeyJ'] });
    expect(persist).not.toHaveBeenCalled();
  });

  it('keeps a remap for an action this build does not know, rather than dropping it', () => {
    useKeymapStore.getState().hydrate({ 'edit.from_a_newer_version': ['KeyZ'] });
    expect(useKeymapStore.getState().overrides['edit.from_a_newer_version']).toEqual(['KeyZ']);
  });
});

describe('resolution is tab-scoped and deterministic', () => {
  it('fires an Edit action only while the Edit tab is frontmost', () => {
    expect(resolveShortcut(['KeyM'], {}, 'edit')?.id).toBe('edit.add_marker');
    expect(resolveShortcut(['KeyM'], {}, 'colorist')?.id).toBe('toggle_masks');
    expect(resolveShortcut(['KeyM'], {}, 'motion')).toBeNull();
  });

  it('lets a global action win over a tab-scoped one on the same combo (B-138)', () => {
    // ⌘1 is both "go to the Edit tab" and Colorist's zoom-to-100%. Before
    // D-272 both fired; now exactly one does, and it is the global one.
    expect(resolveShortcut(['ctrl', 'Digit1'], {}, 'colorist')?.id).toBe('app.tab_edit');
  });

  it('resolves a remapped combo and stops resolving the old one', () => {
    const overrides = { 'edit.play_pause': ['KeyP'] };
    expect(resolveShortcut(['KeyP'], overrides, 'edit')?.id).toBe('edit.play_pause');
    expect(resolveShortcut(['Space'], overrides, 'edit')).toBeNull();
  });

  it('resolves an alias combo', () => {
    expect(resolveShortcut(['ctrl', 'shift', 'KeyZ'], {}, 'edit')?.id).toBe('app.redo');
    expect(resolveShortcut(['Backspace'], {}, 'edit')?.id).toBe('edit.delete_selection');
  });

  it('resolves nothing for an unassigned action', () => {
    expect(resolveShortcut(['Space'], { 'edit.play_pause': [] }, 'edit')).toBeNull();
  });
});

describe('conflict detection', () => {
  it('reports two actions in the same tab bound to the same combo', () => {
    const conflicts = conflictingIds({ 'edit.add_marker': ['KeyV'] });
    expect(conflicts.has('edit.add_marker')).toBe(true);
    expect(conflicts.has('edit.tool_select')).toBe(true);
  });

  it('does not report two actions in DIFFERENT tabs — they can never both be live', () => {
    // M is the Edit tab's marker and Colorist's Masks panel, out of the box.
    // That is by design, not a conflict.
    const conflicts = conflictingIds({});
    expect(conflicts.has('edit.add_marker')).toBe(false);
    expect(conflicts.has('toggle_masks')).toBe(false);
  });

  it('reports a tab action shadowed by a global one', () => {
    const conflicts = conflictingIds({});
    expect(conflicts.has('zoom_100')).toBe(true);
    expect(conflicts.has('app.tab_edit')).toBe(true);
  });

  it('clears once the shadowed action is rebound', () => {
    const conflicts = conflictingIds({ zoom_100: ['ctrl', 'Digit9'] });
    expect(conflicts.has('zoom_100')).toBe(false);
  });
});
