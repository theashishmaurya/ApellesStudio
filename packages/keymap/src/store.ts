/**
 * @apelles/keymap — the user's remaps, and the rules that turn a combo into an
 * action (D-273).
 *
 * **What it is.** A small zustand store holding `overrides` (action id → the
 * combo the user chose), plus the pure resolution helpers the dispatcher and
 * the settings window both use. `SHORTCUT_DEFINITIONS` supplies the defaults;
 * this supplies the deltas.
 *
 * **Persistence is injected, not owned.** This package must not depend on
 * Tauri (`packages/*` never do), so it does not save anything itself: the app
 * calls [`setPersist`] once with a sink, and every mutation below hands that
 * sink the whole new overrides map. The app wires it to
 * `appSettings.keybinds` — the `HashMap<String, Vec<String>>` that
 * `app/src-tauri/src/app_settings.rs` has persisted since RapidRAW, which
 * needed no Rust change to carry Apelles' new action ids. That is the repo's
 * existing per-user-preference mechanism; nothing here invents a second one
 * (there is no `localStorage` anywhere in this app, deliberately).
 *
 * **Precedence: `global` beats the active tab.** One keydown dispatches at
 * most one action, chosen deterministically. The global set is tiny and
 * deliberate (tab switching, undo/redo) and has to work in every tab, so it
 * wins; a tab-scoped action bound to the same combo is shadowed and shows as
 * conflicting in the settings window, where the user can rebind it. This
 * matters for a real collision that predates D-273: ⌘1 is both "go to Edit
 * tab" and Colorist's `zoom_100`. Before this pass BOTH fired (two independent
 * `window` listeners), which is B-138; now exactly one does, and the loser is
 * visible and fixable rather than silent.
 *
 * **An override of `[]` means "unassigned"** — the settings window writes that
 * when you press Escape while recording. It is a real value, distinct from
 * "no override", which is why `overrides` is consulted with `in` rather than
 * truthiness.
 */

import { create } from 'zustand';
import { comboKey, type Combo } from './combo';
import { SHORTCUT_DEFINITIONS, type ShortcutDefinition, type ShortcutScope } from './shortcuts';

export type Overrides = Record<string, Combo>;

/** D-051 moved undo/redo's handler from Colorist to the shell; D-273 moved the
 *  registry row to match. Anyone who had remapped them under the fork's old
 *  ids keeps their remap. */
const LEGACY_ID_MIGRATIONS: Record<string, string> = {
  undo: 'app.undo',
  redo: 'app.redo',
};

/** The combo an action actually answers to, or `null` if it is unassigned. */
export function effectiveCombo(def: ShortcutDefinition, overrides: Overrides): Combo | null {
  if (def.id in overrides) {
    const combo = overrides[def.id];
    return combo.length > 0 ? combo : null;
  }
  return def.defaultCombo;
}

/** Every combo that fires an action: its effective one, plus its built-in
 *  aliases — but only while it is un-remapped (see `shortcuts.ts` on aliases). */
export function effectiveCombos(def: ShortcutDefinition, overrides: Overrides): Combo[] {
  const primary = effectiveCombo(def, overrides);
  if (primary === null) return [];
  if (def.id in overrides) return [primary];
  return def.aliases ? [primary, ...def.aliases] : [primary];
}

/** True when `def` applies while `activeScope` is the frontmost tab. */
function inScope(def: ShortcutDefinition, activeScope: ShortcutScope): boolean {
  return def.scope === 'global' || def.scope === activeScope;
}

/**
 * The single action a combo fires in a given tab, or `null`. `global` wins over
 * a tab-scoped action (see this file's header); ties beyond that resolve by
 * registry order, so the result never depends on iteration luck.
 */
export function resolveShortcut(
  combo: Combo,
  overrides: Overrides,
  activeScope: ShortcutScope,
): ShortcutDefinition | null {
  const key = comboKey(combo);
  let scoped: ShortcutDefinition | null = null;
  for (const def of SHORTCUT_DEFINITIONS) {
    if (!inScope(def, activeScope)) continue;
    if (!effectiveCombos(def, overrides).some((c) => comboKey(c) === key)) continue;
    if (def.scope === 'global') return def;
    if (scoped === null) scoped = def;
  }
  return scoped;
}

/**
 * Every action currently sharing its combo with another action that could fire
 * in the same tab — what the settings window flags with a warning. Two actions
 * in different tab scopes (Colorist's `toggle_masks` on M and the Edit tab's
 * `edit.add_marker` on M) are NOT a conflict: they can never both be live.
 */
export function conflictingIds(overrides: Overrides): Set<string> {
  const byCombo = new Map<string, ShortcutDefinition[]>();
  for (const def of SHORTCUT_DEFINITIONS) {
    for (const combo of effectiveCombos(def, overrides)) {
      const list = byCombo.get(comboKey(combo));
      if (list) list.push(def);
      else byCombo.set(comboKey(combo), [def]);
    }
  }
  const conflicts = new Set<string>();
  for (const defs of byCombo.values()) {
    if (defs.length < 2) continue;
    for (const a of defs) {
      for (const b of defs) {
        if (a.id === b.id) continue;
        if (a.scope === 'global' || b.scope === 'global' || a.scope === b.scope) {
          conflicts.add(a.id);
          conflicts.add(b.id);
        }
      }
    }
  }
  return conflicts;
}

/** Drops entries that match the default anyway, so the persisted map stays the
 *  set of real deltas rather than growing a copy of the whole registry. */
function prune(overrides: Overrides): Overrides {
  const out: Overrides = {};
  for (const [id, combo] of Object.entries(overrides)) {
    const def = SHORTCUT_DEFINITIONS.find((d) => d.id === id);
    // An id with no definition is kept: it belongs to a shortcut this build
    // does not have (an older/newer version), and silently dropping someone's
    // remap because they downgraded once would be data loss.
    if (def && comboKey(def.defaultCombo) === comboKey(combo)) continue;
    out[id] = combo;
  }
  return out;
}

interface KeymapState {
  overrides: Overrides;
  osPlatform: string;
  /** Which tab is frontmost — set by `Shell`. Gates which actions can fire. */
  activeScope: ShortcutScope;
  hydrate: (stored: Overrides | null | undefined) => void;
  setPersist: (persist: ((overrides: Overrides) => void) | null) => void;
  setOsPlatform: (osPlatform: string) => void;
  setActiveScope: (scope: ShortcutScope) => void;
  setBinding: (id: string, combo: Combo) => void;
  resetBinding: (id: string) => void;
  resetAll: () => void;
}

let persistSink: ((overrides: Overrides) => void) | null = null;

export const useKeymapStore = create<KeymapState>((set, get) => {
  const commit = (overrides: Overrides) => {
    const pruned = prune(overrides);
    set({ overrides: pruned });
    persistSink?.(pruned);
  };

  return {
    overrides: {},
    osPlatform: '',
    activeScope: 'edit',

    // Hydration is NOT a mutation: it is the persisted value arriving, so it
    // must never echo back out through the sink (that would re-save on every
    // settings load, and race a save that is already in flight).
    hydrate: (stored) => {
      const next: Overrides = {};
      for (const [id, combo] of Object.entries(stored ?? {})) {
        if (!Array.isArray(combo)) continue;
        next[LEGACY_ID_MIGRATIONS[id] ?? id] = combo;
      }
      set({ overrides: prune(next) });
    },

    setPersist: (persist) => {
      persistSink = persist;
    },

    setOsPlatform: (osPlatform) => set({ osPlatform }),

    setActiveScope: (scope) => {
      if (get().activeScope !== scope) set({ activeScope: scope });
    },

    setBinding: (id, combo) => commit({ ...get().overrides, [id]: combo }),

    resetBinding: (id) => {
      const { [id]: _removed, ...rest } = get().overrides;
      commit(rest);
    },

    resetAll: () => commit({}),
  };
});
