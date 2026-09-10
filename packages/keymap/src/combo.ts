/**
 * @apelles/keymap — key-combo normalisation and display (D-273).
 *
 * **What it is.** The one place that turns a real `KeyboardEvent` into a
 * canonical combo (`['ctrl', 'shift', 'KeyC']`) and a combo back into
 * something a human reads (`⌘ + Shift + C`). Every comparison in the app goes
 * through [`normalizeCombo`] + [`comboKey`]; nothing compares `e.key` to a
 * literal any more.
 *
 * **Where it came from.** This is RapidRAW's `app/src/utils/keyboardUtils.ts`,
 * moved here verbatim in behaviour (D-273) so the Edit/Motion tabs and the
 * shell can use it too — `packages/*` must never import from `app/src`
 * (dependency direction is `app → tabs → services → domain`). The fork's copy
 * is deleted, not duplicated: there is exactly one of these. See
 * `docs/09-engine-notes.md`.
 *
 * **What it does NOT do.** It holds no state, knows no actions, and reads no
 * settings. The registry is `shortcuts.ts`; the user's remaps are `store.ts`.
 *
 * A combo is modifiers-then-key, modifiers always in the order
 * `ctrl, shift, alt`, so `join('+')` is a stable map key regardless of the
 * order the user happened to press them in. `ctrl` means "the platform's
 * primary modifier" — Cmd on macOS, Ctrl elsewhere — which is why the event's
 * `metaKey` and `ctrlKey` both normalise to it.
 */

/** A canonical combo: zero or more of `ctrl`/`shift`/`alt`, then one key code. */
export type Combo = string[];

const symMap: Record<string, string> = {
  Space: 'Space',
  Backspace: '⌫',
  Enter: 'Enter',
  Delete: 'Delete',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '+',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Backslash: '\\',
  Tab: 'Tab',
  Escape: 'Esc',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Home: 'Home',
  End: 'End',
  Insert: 'Insert',
  NumpadAdd: 'Numpad +',
  NumpadMultiply: 'Numpad *',
  NumpadDivide: 'Numpad /',
  NumpadSubtract: 'Numpad -',
  NumpadDecimal: 'Numpad .',
  NumpadComma: 'Numpad ,',
  NumpadEnter: 'Numpad Enter',
  NumpadEqual: 'Numpad =',
  CapsLock: 'Caps Lock',
  PrintScreen: 'PrtSc',
};

export function normalizeCombo(event: KeyboardEvent, osPlatform?: string): Combo {
  const isMacDelete = osPlatform === 'macos' && event.code === 'Backspace' && (event.ctrlKey || event.metaKey);
  const parts: Combo = [];
  if ((event.ctrlKey || event.metaKey) && !isMacDelete) parts.push('ctrl');
  if (event.shiftKey) parts.push('shift');
  if (event.altKey) parts.push('alt');
  let code = isMacDelete ? 'Delete' : event.code;
  if (event.key && /^[a-zA-Z]$/.test(event.key)) {
    code = `Key${event.key.toUpperCase()}`;
  } else if (/^Numpad[0-9]$/.test(code)) {
    code = `Digit${code.slice(-1)}`;
  } else if (code === 'NumpadAdd') {
    code = 'Equal';
  } else if (code === 'NumpadSubtract') {
    code = 'Minus';
  }
  if (isValidShortcutKey(code)) {
    parts.push(code);
  }
  return parts;
}

/** The stable string form of a combo — what the dispatcher's lookup map is keyed by. */
export function comboKey(combo: Combo): string {
  return combo.join('+');
}

/** True once a recorded combo has a real key in it, not just held modifiers. */
export function isCompleteCombo(combo: Combo): boolean {
  const last = combo[combo.length - 1];
  return last !== undefined && !MODIFIERS.includes(last);
}

const MODIFIERS = ['ctrl', 'shift', 'alt'];

function codeToDisplayLabel(code: string): string | null {
  if (/^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code)) {
    return code[code.length - 1].toUpperCase();
  }
  if (/^Numpad[0-9]$/.test(code)) {
    return `Numpad ${code.slice(-1)}`;
  }
  return symMap[code] ?? null;
}

function isValidShortcutKey(code: string): boolean {
  if (code.startsWith('Key') || code.startsWith('Digit')) return true;
  if (code.startsWith('F') && /^\d+$/.test(code.slice(1))) return true;
  if (/^Numpad[0-9]$/.test(code)) return true;
  return code in symMap;
}

export function formatKeyCode(key: string, osPlatform: string): string {
  if (key === 'ctrl') return osPlatform === 'macos' ? '⌘' : 'Ctrl';
  if (key === 'shift') return 'Shift';
  if (key === 'alt') return osPlatform === 'macos' ? '⌥' : 'Alt';
  if (key === 'Delete' && osPlatform === 'macos') return 'Delete / ⌘+⌫';
  const label = codeToDisplayLabel(key);
  return label || key;
}

/** The whole combo, ready to render in a `<kbd>`. */
export function formatCombo(combo: Combo, osPlatform: string): string {
  return combo.map((k) => formatKeyCode(k, osPlatform)).join(' + ');
}
