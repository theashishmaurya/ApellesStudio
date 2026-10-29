/**
 * @apelles/keymap — the one "is the user operating a form control?" guard
 * (B-332).
 *
 * **What it is.** [`shortcutBlockedByTarget`] answers: given the element that
 * has focus and the combo just pressed, must the dispatcher stay out of it?
 * It is called once, by `onKeyDown` in `useShortcut.ts` — the single listener
 * every shortcut in the app goes through — so a new shortcut cannot forget it.
 *
 * **Two kinds of control.**
 * - *Text entry* (text-like `<input>`, `<textarea>`, contenteditable, ARIA
 *   `textbox`/`searchbox`/`combobox`): nothing fires. The "m" in a clip name
 *   must not drop a marker.
 * - *Value controls* (`<input type="number">`, `type="range"`, `<select>`, ARIA
 *   `spinbutton`/`slider`/`listbox`; Base UI's slider and number-field render
 *   those inputs): they hold no prose, so app-level Cmd/Ctrl combos (undo,
 *   redo, tab switch — D-051) still pass, but every *bare* key stays with the
 *   control. Backspace clears a number field, arrows step a slider, Space
 *   opens a select; none may reach the timeline. This is the B-332 fix:
 *   number inputs used to be exempt wholesale, so clearing the Inspector's
 *   level field with Backspace deleted the selected clip and its A/V partner.
 *
 * **Cmd+Backspace on macOS** normalises to the `Delete` combo (see
 * `combo.ts`), so "has a Cmd/Ctrl modifier" alone would let it through: the
 * pass-through excludes `Delete`/`Backspace` explicitly.
 *
 * **Does NOT** decide what any shortcut does; it only says whether the focused
 * element owns the key.
 */

import type { Combo } from './combo';

/** `<input type=…>` values that take free text ('' = no type attribute). */
const TEXT_INPUT_TYPES = new Set([
  '',
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
]);
const VALUE_INPUT_TYPES = new Set(['number', 'range']);

const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox']);
const VALUE_ROLES = new Set(['spinbutton', 'slider', 'listbox', 'scrollbar']);

type ControlKind = 'text' | 'value' | null;

function classify(el: Element | null): ControlKind {
  if (!(el instanceof HTMLElement)) return null;
  if (el.isContentEditable) return 'text';
  if (el instanceof HTMLTextAreaElement) return 'text';
  if (el instanceof HTMLSelectElement) return 'value';
  if (el instanceof HTMLInputElement) {
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    if (VALUE_INPUT_TYPES.has(type)) return 'value';
    if (TEXT_INPUT_TYPES.has(type)) return 'text';
  }
  const role = el.getAttribute('role');
  if (role && TEXT_ROLES.has(role)) return 'text';
  if (role && VALUE_ROLES.has(role)) return 'value';
  return null;
}

/** True when `el` (normally `document.activeElement`) owns `combo`, so the
 *  global dispatcher must ignore the key press. */
export function shortcutBlockedByTarget(el: Element | null, combo: Combo): boolean {
  const kind = classify(el);
  if (kind === null) return false;
  if (kind === 'text') return true;
  const key = combo[combo.length - 1];
  const appLevel = combo.includes('ctrl') && key !== 'Delete' && key !== 'Backspace';
  return !appLevel;
}
