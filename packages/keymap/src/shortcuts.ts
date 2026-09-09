/**
 * @apelles/keymap — THE shortcut registry (D-272).
 *
 * **What it is.** One flat list of every keyboard shortcut in Apelles: its
 * stable `id`, a human `label`, the `category` it groups under, the `scope`
 * (which tab it belongs to), and its `defaultCombo`. Every call-site in the
 * app — `Shell.tsx`, `TimelinePane.tsx`, `PreviewPane.tsx`, Colorist's
 * `useKeyboardShortcuts.ts` — resolves its keys from here through
 * `useShortcut`, and the Keyboard Shortcuts settings window renders this list
 * directly. There is no second list and no literal `e.key === 'm'` left in the
 * app.
 *
 * **What it does NOT do.** It contains no handlers. What an action *does* is
 * owned by whichever component registers it; this file only says what it is
 * called, where it applies, and what it is bound to out of the box. That split
 * is the point: a shortcut can be listed, shown and remapped in the settings
 * window whether or not the component that performs it is currently mounted.
 *
 * **`id` is a persistence key — never rename one.** User remaps are stored
 * against these ids in `appSettings.keybinds` (see `store.ts`), so the 45
 * Colorist ids below are byte-for-byte the ones RapidRAW's
 * `app/src/utils/keyboardUtils.ts` used before D-272 folded that file in here.
 * Anyone's existing remaps keep working.
 *
 * **`labelKey`** is the fork's i18n key, kept so Colorist's 13 translated
 * locales still render translated rows. `@apelles/keymap` does not depend on
 * i18next — the app injects `t` into the settings window (same
 * dependency-injection pattern `Shell` uses for `launcher`/`sourcesPanel`).
 * Rows added by Apelles itself carry `label` only, matching every other
 * `packages/*` surface, which is English-only today.
 *
 * **`aliases`** are extra built-in combos that also fire the action, for the
 * two cases where one action has genuinely always had two bindings (redo is
 * ⌘Y *and* ⌘⇧Z; the Edit tab's delete is Delete *and* Backspace). They are
 * defaults, not bindings: the moment a user remaps that action, their combo is
 * the whole binding and the aliases are gone. Modelled this way rather than as
 * two registry rows because the settings window must show one row per action —
 * two rows for "Redo" is what a user reads as a bug.
 */

import type { Combo } from './combo';

/** Which surface an action belongs to. `global` applies in all three tabs. */
export type ShortcutScope = 'global' | 'edit' | 'motion' | 'colorist';

export interface ShortcutCategory {
  id: string;
  label: string;
  /** i18n key for the fork's already-translated section names, if it has one. */
  labelKey?: string;
  scope: ShortcutScope;
}

export interface ShortcutDefinition {
  /** Stable persistence key. Never rename — see this file's header. */
  id: string;
  label: string;
  labelKey?: string;
  category: string;
  scope: ShortcutScope;
  defaultCombo: Combo;
  /** Extra built-in combos, dropped as soon as the user remaps this action. */
  aliases?: Combo[];
}

/** Rendered in this order by the settings window. Apelles' own first, then the
 *  Colorist sections in the order RapidRAW listed them. */
export const SHORTCUT_CATEGORIES: ShortcutCategory[] = [
  { id: 'app', label: 'Application', scope: 'global' },
  { id: 'playback', label: 'Playback', scope: 'edit' },
  { id: 'timeline', label: 'Timeline editing', scope: 'edit' },
  { id: 'trim-tools', label: 'Trim tools', scope: 'edit' },
  { id: 'library', label: 'Library', labelKey: 'settings.keybinds.sections.library', scope: 'colorist' },
  { id: 'editing', label: 'Editing', labelKey: 'settings.keybinds.sections.editing', scope: 'colorist' },
  { id: 'view', label: 'View', labelKey: 'settings.keybinds.sections.view', scope: 'colorist' },
  { id: 'rating', label: 'Rating', labelKey: 'settings.keybinds.sections.rating', scope: 'colorist' },
  { id: 'panels', label: 'Panels', labelKey: 'settings.keybinds.sections.panels', scope: 'colorist' },
];

const colorist = (
  id: string,
  label: string,
  category: string,
  defaultCombo: Combo,
): ShortcutDefinition => ({
  id,
  label,
  labelKey: `settings.keybinds.actions.${id}`,
  category,
  scope: 'colorist',
  defaultCombo,
});

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  // ── Application (all tabs) ───────────────────────────────────────────────
  // Cmd/Ctrl+1/2/3, owned by `Shell.tsx` since D-039.
  { id: 'app.tab_edit', label: 'Go to Edit tab', category: 'app', scope: 'global', defaultCombo: ['ctrl', 'Digit1'] },
  { id: 'app.tab_motion', label: 'Go to Motion tab', category: 'app', scope: 'global', defaultCombo: ['ctrl', 'Digit2'] },
  {
    id: 'app.tab_colorist',
    label: 'Go to Colorist tab',
    category: 'app',
    scope: 'global',
    defaultCombo: ['ctrl', 'Digit3'],
  },
  // D-051's shared history stack. These replace the `undo`/`redo` rows the
  // fork's list carried purely for display — the handler has been `Shell`'s,
  // not Colorist's, since D-051, so the row now sits in the scope that
  // actually owns it. The old ids are migrated in `store.ts`.
  { id: 'app.undo', label: 'Undo', category: 'app', scope: 'global', defaultCombo: ['ctrl', 'KeyZ'] },
  {
    id: 'app.redo',
    label: 'Redo',
    category: 'app',
    scope: 'global',
    defaultCombo: ['ctrl', 'KeyY'],
    aliases: [['ctrl', 'shift', 'KeyZ']],
  },

  // ── Playback (Edit tab preview transport) ────────────────────────────────
  // D-272: all three were UNBOUND before this pass — the preview had click-only
  // transport buttons and no key at all, which is the owner's own report
  // ("play should play the preview").
  { id: 'edit.play_pause', label: 'Play / Pause', category: 'playback', scope: 'edit', defaultCombo: ['Space'] },
  {
    id: 'edit.frame_back',
    label: 'Step back one frame',
    category: 'playback',
    scope: 'edit',
    defaultCombo: ['ArrowLeft'],
  },
  {
    id: 'edit.frame_forward',
    label: 'Step forward one frame',
    category: 'playback',
    scope: 'edit',
    defaultCombo: ['ArrowRight'],
  },

  // ── Timeline editing (Edit tab) ──────────────────────────────────────────
  {
    id: 'edit.split',
    label: 'Split at playhead',
    category: 'timeline',
    scope: 'edit',
    // Premiere's own Add Edit. The toolbar button existed since D-093 with no
    // key bound to it at all.
    defaultCombo: ['ctrl', 'KeyK'],
  },
  {
    id: 'edit.delete_selection',
    label: 'Delete selected clip or gap',
    category: 'timeline',
    scope: 'edit',
    defaultCombo: ['Delete'],
    aliases: [['Backspace']],
  },
  { id: 'edit.add_marker', label: 'Add marker at playhead', category: 'timeline', scope: 'edit', defaultCombo: ['KeyM'] },

  // ── Trim tools (Edit tab) — Adobe's own V/B/N/Y/U, D-261 ─────────────────
  { id: 'edit.tool_select', label: 'Select tool', category: 'trim-tools', scope: 'edit', defaultCombo: ['KeyV'] },
  { id: 'edit.tool_ripple', label: 'Ripple tool', category: 'trim-tools', scope: 'edit', defaultCombo: ['KeyB'] },
  { id: 'edit.tool_roll', label: 'Roll tool', category: 'trim-tools', scope: 'edit', defaultCombo: ['KeyN'] },
  { id: 'edit.tool_slip', label: 'Slip tool', category: 'trim-tools', scope: 'edit', defaultCombo: ['KeyY'] },
  { id: 'edit.tool_slide', label: 'Slide tool', category: 'trim-tools', scope: 'edit', defaultCombo: ['KeyU'] },

  // ── Colorist — ids and defaults exactly as the fork had them ─────────────
  colorist('copy_files', 'Copy files', 'library', ['ctrl', 'shift', 'KeyC']),
  colorist('copy_image_path', 'Copy image path', 'library', ['ctrl', 'KeyL']),
  colorist('select_all', 'Select all', 'library', ['ctrl', 'KeyA']),
  colorist('delete_selected', 'Delete selected', 'library', ['Delete']),
  colorist('preview_prev', 'Previous image', 'library', ['ArrowLeft']),
  colorist('preview_next', 'Next image', 'library', ['ArrowRight']),
  colorist('open_settings', 'Open settings', 'library', ['ctrl', 'Comma']),
  colorist('zoom_in_step', 'Zoom in a step', 'view', ['ArrowUp']),
  colorist('zoom_out_step', 'Zoom out a step', 'view', ['ArrowDown']),
  colorist('cycle_zoom', 'Cycle zoom', 'view', ['Space']),
  colorist('zoom_in', 'Zoom in', 'view', ['ctrl', 'Equal']),
  colorist('zoom_out', 'Zoom out', 'view', ['ctrl', 'Minus']),
  colorist('zoom_fit', 'Fit to window', 'view', ['ctrl', 'Digit0']),
  colorist('zoom_100', 'Zoom to 100%', 'view', ['ctrl', 'Digit1']),
  colorist('toggle_fullscreen', 'Toggle full screen', 'view', ['KeyF']),
  colorist('show_original', 'Show original', 'view', ['KeyB']),
  colorist('rate_0', 'Rate 0 stars', 'rating', ['Digit0']),
  colorist('rate_1', 'Rate 1 star', 'rating', ['Digit1']),
  colorist('rate_2', 'Rate 2 stars', 'rating', ['Digit2']),
  colorist('rate_3', 'Rate 3 stars', 'rating', ['Digit3']),
  colorist('rate_4', 'Rate 4 stars', 'rating', ['Digit4']),
  colorist('rate_5', 'Rate 5 stars', 'rating', ['Digit5']),
  colorist('color_label_none', 'Clear colour label', 'rating', ['shift', 'Digit0']),
  colorist('color_label_red', 'Colour label red', 'rating', ['shift', 'Digit1']),
  colorist('color_label_yellow', 'Colour label yellow', 'rating', ['shift', 'Digit2']),
  colorist('color_label_green', 'Colour label green', 'rating', ['shift', 'Digit3']),
  colorist('color_label_blue', 'Colour label blue', 'rating', ['shift', 'Digit4']),
  colorist('color_label_purple', 'Colour label purple', 'rating', ['shift', 'Digit5']),
  colorist('toggle_adjustments', 'Adjustments panel', 'panels', ['KeyD']),
  colorist('toggle_crop_panel', 'Crop panel', 'panels', ['KeyR']),
  colorist('toggle_masks', 'Masks panel', 'panels', ['KeyM']),
  colorist('toggle_ai', 'AI panel', 'panels', ['KeyK']),
  colorist('toggle_presets', 'Presets panel', 'panels', ['KeyP']),
  colorist('toggle_metadata', 'Metadata panel', 'panels', ['KeyI']),
  colorist('toggle_analytics', 'Scopes', 'panels', ['KeyA']),
  colorist('toggle_export', 'Export panel', 'panels', ['KeyE']),
  colorist('toggle_left_panel', 'Toggle left panel', 'panels', ['ctrl', 'shift', 'KeyB']),
  colorist('toggle_right_panel', 'Toggle right panel', 'panels', ['ctrl', 'KeyB']),
  colorist('toggle_bottom_panel', 'Toggle filmstrip', 'panels', ['ctrl', 'KeyJ']),
  colorist('copy_adjustments', 'Copy adjustments', 'editing', ['ctrl', 'KeyC']),
  colorist('paste_adjustments', 'Paste adjustments', 'editing', ['ctrl', 'KeyV']),
  colorist('rotate_left', 'Rotate left', 'editing', ['BracketLeft']),
  colorist('rotate_right', 'Rotate right', 'editing', ['BracketRight']),
  colorist('toggle_crop', 'Straighten', 'editing', ['KeyS']),
  colorist('brush_size_up', 'Brush size up', 'editing', ['ctrl', 'ArrowUp']),
  colorist('brush_size_down', 'Brush size down', 'editing', ['ctrl', 'ArrowDown']),
];

const BY_ID = new Map(SHORTCUT_DEFINITIONS.map((d) => [d.id, d]));

export function shortcutById(id: string): ShortcutDefinition | undefined {
  return BY_ID.get(id);
}
