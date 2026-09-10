/**
 * @apelles/keymap — Apelles' single source of truth for keyboard shortcuts
 * (D-273). See `shortcuts.ts` for the registry, `store.ts` for the user's
 * remaps and the resolution rules, `useShortcut.ts` for the one dispatcher,
 * and `KeyboardShortcutsDialog.tsx` for the settings window. README has the
 * boundary and the call-site map.
 */

export { comboKey, formatCombo, formatKeyCode, isCompleteCombo, normalizeCombo } from './combo';
export type { Combo } from './combo';

export { SHORTCUT_CATEGORIES, SHORTCUT_DEFINITIONS, shortcutById } from './shortcuts';
export type { ShortcutCategory, ShortcutDefinition, ShortcutScope } from './shortcuts';

export { conflictingIds, effectiveCombo, effectiveCombos, resolveShortcut, useKeymapStore } from './store';
export type { Overrides } from './store';

export { useShortcut, useShortcuts, __resetKeymapDispatcherForTests } from './useShortcut';
export type { UseShortcutOptions } from './useShortcut';

export { KeyboardShortcutsDialog } from './KeyboardShortcutsDialog';
export type { KeyboardShortcutsDialogProps } from './KeyboardShortcutsDialog';
