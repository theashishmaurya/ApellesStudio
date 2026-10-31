/**
 * keys.ts — DOM key codes ↔ the characters they type, US layout (D-434).
 *
 * What it is: enough of a keyboard model for `debug_key` to turn a combo
 *   (`meta+KeyZ`) or a string of text into the `code`/`key` pairs a real
 *   keypress produces. The app's own shortcuts match on `code`
 *   (`@apelles/keymap`'s `normalizeCombo`), so `code` is the field that must
 *   be exact; `key` is filled in the way a US keyboard would produce it.
 *
 * What it does NOT do: model other layouts or IME composition. The native
 *   dispatcher's own virtual-key table lives in Rust (`debug_input.rs`) and is
 *   keyed by the same `code` names, so the two cannot disagree on WHICH key.
 */

/** code → [unshifted key, shifted key]. */
const PRINTABLE: Record<string, [string, string]> = {
  Space: [' ', ' '],
  Minus: ['-', '_'],
  Equal: ['=', '+'],
  BracketLeft: ['[', '{'],
  BracketRight: [']', '}'],
  Backslash: ['\\', '|'],
  Semicolon: [';', ':'],
  Quote: ["'", '"'],
  Comma: [',', '<'],
  Period: ['.', '>'],
  Slash: ['/', '?'],
  Backquote: ['`', '~'],
};
const DIGIT_SHIFTED = ')!@#$%^&*(';
for (let d = 0; d <= 9; d += 1) PRINTABLE[`Digit${d}`] = [String(d), DIGIT_SHIFTED[d]];
for (let c = 0; c < 26; c += 1) {
  const lower = String.fromCharCode(97 + c);
  PRINTABLE[`Key${lower.toUpperCase()}`] = [lower, lower.toUpperCase()];
}

/** Non-printing keys whose `key` is their name. */
const NAMED = new Set([
  'Enter',
  'Escape',
  'Backspace',
  'Delete',
  'Tab',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);

/** The four modifier keys, by the name a combo uses for them. */
export const MODIFIER_KEYS = {
  shift: { code: 'ShiftLeft', key: 'Shift' },
  ctrl: { code: 'ControlLeft', key: 'Control' },
  alt: { code: 'AltLeft', key: 'Alt' },
  meta: { code: 'MetaLeft', key: 'Meta' },
} as const;

export type ModifierName = keyof typeof MODIFIER_KEYS;

/** Every `code` this model knows — the accepted list an error names. */
export const KNOWN_CODES: readonly string[] = [...Object.keys(PRINTABLE), ...NAMED];

/** The `key` a press of `code` produces, or `null` for a code this model does not know. */
export function keyForCode(code: string, shift: boolean): string | null {
  const printable = PRINTABLE[code];
  if (printable) return shift ? printable[1] : printable[0];
  return NAMED.has(code) ? code : null;
}

/** The key (and whether Shift is needed) that types `ch`, or `null` when no
 *  single US-layout key does. */
export function codeForChar(ch: string): { code: string; shift: boolean } | null {
  if (ch === '\n') return { code: 'Enter', shift: false };
  if (ch === '\t') return { code: 'Tab', shift: false };
  for (const [code, [plain, shifted]] of Object.entries(PRINTABLE)) {
    if (ch === plain) return { code, shift: false };
    if (ch === shifted) return { code, shift: true };
  }
  return null;
}
