/**
 * uiState.test.ts (D-219) — the debug ops' argument validation.
 *
 * The point of these is the refusals, not the happy paths: D-216's rule is
 * that an op which quietly accepts a value it cannot act on, does nothing and
 * answers `ok` is the silent no-op bug class this repo has already been bitten
 * by. So every test that passes something wrong asserts a real message that
 * names the accepted set.
 */
import { describe, expect, it } from 'vitest';

import { isParseError, parseBool, parseShellTab, SHELL_TABS } from './uiState';

describe('parseShellTab', () => {
  it('accepts each tab id, case- and whitespace-insensitively', () => {
    for (const tab of SHELL_TABS) {
      expect(parseShellTab(tab)).toEqual({ value: tab });
    }
    expect(parseShellTab('  Colorist ')).toEqual({ value: 'colorist' });
  });

  it('accepts the 1-based index the Cmd/Ctrl+1/2/3 shortcut uses', () => {
    expect(parseShellTab(1)).toEqual({ value: 'edit' });
    expect(parseShellTab('3')).toEqual({ value: 'colorist' });
  });

  it('refuses an out-of-range index by name instead of clamping', () => {
    const parsed = parseShellTab(9);
    expect(isParseError(parsed)).toBe(true);
    if (isParseError(parsed)) {
      expect(parsed.error).toContain('out of range');
      expect(parsed.error).toContain('colorist');
    }
  });

  it('refuses an unknown tab and lists the real ones', () => {
    const parsed = parseShellTab('edti');
    expect(isParseError(parsed)).toBe(true);
    if (isParseError(parsed)) {
      expect(parsed.error).toContain('"edti"');
      expect(parsed.error).toContain('edit, motion, colorist');
    }
  });

  it('refuses a missing tab', () => {
    expect(isParseError(parseShellTab(undefined))).toBe(true);
  });
});

describe('parseBool', () => {
  it('accepts real booleans and the JSON/HTTP spellings of them', () => {
    expect(parseBool(true, 'open')).toEqual({ value: true });
    expect(parseBool('false', 'open')).toEqual({ value: false });
    expect(parseBool(1, 'open')).toEqual({ value: true });
    expect(parseBool('0', 'open')).toEqual({ value: false });
  });

  it('refuses an omitted field rather than defaulting it', () => {
    const parsed = parseBool(undefined, 'open');
    expect(isParseError(parsed)).toBe(true);
    if (isParseError(parsed)) expect(parsed.error).toBe("'open' is required (true or false)");
  });

  it('refuses a value that is not a boolean, naming the field', () => {
    const parsed = parseBool('yes', 'open');
    expect(isParseError(parsed)).toBe(true);
    if (isParseError(parsed)) expect(parsed.error).toContain("'open' must be a boolean");
  });
});
