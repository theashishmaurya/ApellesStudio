/**
 * @apelles/keymap — the registry's own invariants (B-396).
 *
 * What it is: the regression guard for B-396 plus the structural rule that bug
 * broke. `open_settings` was registered in the `colorist`-scoped `library`
 * section, so ⌘, did nothing at all in Edit or Motion — and with no gear in
 * the chrome bar either, the app had no reachable Settings from two of its
 * three tabs. The fix made it a `global` action in the `app` category and kept
 * its unprefixed id (user remaps in `appSettings.keybinds` and the 13
 * translated labels are stored against it). Nothing pinned any of that.
 *
 * It is asserted through `resolveShortcut` rather than by reading the field,
 * because what the bug was about is which tab the key fires in.
 *
 * What it does NOT do: assert that anything HANDLES the action — the registry
 * holds no handlers by design (see `shortcuts.ts`). `Root.tsx` owns
 * `open_settings`' handler and the gear beside it; the Shell slot it fills is
 * covered in `packages/shell`.
 */

import { describe, expect, it } from 'vitest';

import { SHORTCUT_CATEGORIES, SHORTCUT_DEFINITIONS, shortcutById, type ShortcutScope } from './shortcuts';
import { resolveShortcut } from './store';

const SCOPES: ShortcutScope[] = ['global', 'edit', 'motion', 'colorist'];

describe('the registry is internally consistent', () => {
  it('gives every action a category that exists', () => {
    const known = new Set(SHORTCUT_CATEGORIES.map((c) => c.id));
    for (const def of SHORTCUT_DEFINITIONS) {
      expect(known, `${def.id} names category ${def.category}`).toContain(def.category);
    }
  });

  it('never puts an action in a category of a different scope', () => {
    // The section an action is RENDERED under and the tab it FIRES in cannot
    // disagree — a reader of the settings window has no other way to know
    // where a key works. Honest about its reach: this would NOT have caught
    // B-396, whose row was consistently wrong (a `colorist` action in a
    // `colorist` section); the two tests below are the ones that pin that.
    const scopeOf = new Map(SHORTCUT_CATEGORIES.map((c) => [c.id, c.scope]));
    for (const def of SHORTCUT_DEFINITIONS) {
      expect(def.scope, `${def.id} is in the ${def.category} section`).toBe(scopeOf.get(def.category));
    }
  });

  it('keeps every id unique, since ids are the persistence key for remaps', () => {
    const seen = new Set<string>();
    for (const def of SHORTCUT_DEFINITIONS) {
      expect(seen, `duplicate id ${def.id}`).not.toContain(def.id);
      seen.add(def.id);
    }
  });
});

describe('open_settings (B-396)', () => {
  it('is still registered under its unprefixed id, so existing remaps and the translated labels resolve', () => {
    const def = shortcutById('open_settings');
    expect(def).toBeDefined();
    expect(def?.labelKey).toBe('settings.keybinds.actions.open_settings');
  });

  it('is global, not colorist — Preferences belong to the whole app', () => {
    expect(shortcutById('open_settings')?.scope).toBe('global');
  });

  it('fires in EVERY tab, which is the defect: it used to work only in Colorist', () => {
    const combo = shortcutById('open_settings')?.defaultCombo;
    expect(combo).toEqual(['ctrl', 'Comma']);
    for (const scope of SCOPES) {
      expect(
        resolveShortcut(combo ?? [], {}, scope)?.id,
        `⌘, must open Settings with the ${scope} tab frontmost`,
      ).toBe('open_settings');
    }
  });

  it('is not shadowed by a tab-scoped action on the same combo in any tab', () => {
    // `resolveShortcut` prefers a global action, so this is really a check that
    // nothing else has claimed ⌘, — a second claimant would be a conflict the
    // settings window flags, and a sign the binding moved under someone.
    const others = SHORTCUT_DEFINITIONS.filter(
      (d) => d.id !== 'open_settings' && d.defaultCombo.join('+') === 'ctrl+Comma',
    );
    expect(others.map((d) => d.id)).toEqual([]);
  });
});
