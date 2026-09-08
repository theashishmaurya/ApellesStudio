/**
 * uiState.ts — argument parsing for the debug UI-state ops (D-219,
 * `docs/notes/debug-tooling.md` piece 2).
 *
 * What it is: the small, store-free half of `debugOps.ts` — turning one
 *   untyped `chroma://request` argument into either a real value or a real
 *   error message. Split out so it can be unit-tested without a live app,
 *   and so every op's refusal reads the same way.
 *
 * What it does NOT do: touch a store, touch the DOM, or know what any of
 *   these values mean. It validates and it explains; `debugOps.ts` acts.
 *
 * Why it validates at all rather than coercing: D-216's rule. An op that
 *   accepts `{tab: "edti"}`, quietly does nothing and answers `ok` is the
 *   silent no-op class of bug this repo has already been bitten by twice
 *   (B-053, and D-216's own note). Every value here is either recognised or
 *   refused by name, with the accepted set in the message.
 */

import type { ShellTabId } from '@chroma/shell';

/** The three top-level tabs, in the order `Shell.tsx` renders them —
 *  Cmd/Ctrl+1/2/3 map to these indices, so the order is meaningful. */
export const SHELL_TABS: readonly ShellTabId[] = ['edit', 'motion', 'colorist'];

/** A parsed argument, or the message explaining why it wasn't one. */
export type Parsed<T> = { value: T } | { error: string };

export function isParseError<T>(parsed: Parsed<T>): parsed is { error: string } {
  return 'error' in parsed;
}

/** `{tab: 'edit'|'motion'|'colorist'}`. Also accepts the 1-based index the
 *  Cmd/Ctrl+1/2/3 shortcut uses, because "switch to tab 2" is a thing a
 *  caller reasonably means and silently ignoring it would be worse than
 *  either accepting it or refusing it by name. */
export function parseShellTab(raw: unknown): Parsed<ShellTabId> {
  if (typeof raw === 'number' || (typeof raw === 'string' && /^[0-9]+$/.test(raw))) {
    const index = Number(raw) - 1;
    const byIndex = SHELL_TABS[index];
    if (byIndex) return { value: byIndex };
    return { error: `tab index ${raw} is out of range — 1..${SHELL_TABS.length} (${SHELL_TABS.join(', ')})` };
  }
  if (typeof raw === 'string') {
    const normalised = raw.trim().toLowerCase() as ShellTabId;
    if (SHELL_TABS.includes(normalised)) return { value: normalised };
  }
  return { error: `unknown tab ${JSON.stringify(raw)} — expected one of ${SHELL_TABS.join(', ')}` };
}

/** A required boolean argument. Deliberately strict about `undefined` (the
 *  field was omitted, which for a setter is almost always a mistake) while
 *  accepting the `"true"`/`"false"`/`0`/`1` an HTTP or JSON caller may
 *  reasonably send. */
export function parseBool(raw: unknown, field: string): Parsed<boolean> {
  if (typeof raw === 'boolean') return { value: raw };
  if (raw === 'true' || raw === 1 || raw === '1') return { value: true };
  if (raw === 'false' || raw === 0 || raw === '0') return { value: false };
  if (raw === undefined || raw === null) return { error: `'${field}' is required (true or false)` };
  return { error: `'${field}' must be a boolean, got ${JSON.stringify(raw)}` };
}
