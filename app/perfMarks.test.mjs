// The perf-mark gate (D-437 S0a): the Tauri env contract, in one place.
import { afterEach, describe, expect, it } from 'vitest';

import { buildDefines, debugToolsEnabled, perfMarksDefine, perfMarksEnabled } from './perfMarks.mjs';

const saved = { debug: process.env.TAURI_ENV_DEBUG, force: process.env.APELLES_PERF_MARKS };
afterEach(() => {
  for (const [key, value] of [
    ['TAURI_ENV_DEBUG', saved.debug],
    ['APELLES_PERF_MARKS', saved.force],
  ]) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('perfMarksEnabled', () => {
  it('is on under vite dev', () => {
    delete process.env.TAURI_ENV_DEBUG;
    expect(perfMarksEnabled('serve')).toBe(true);
  });

  it('is on in a tauri build --debug bundle (TAURI_ENV_DEBUG=true)', () => {
    process.env.TAURI_ENV_DEBUG = 'true';
    expect(perfMarksEnabled('build')).toBe(true);
  });

  it('is off in a release build: TAURI_ENV_DEBUG is the string "false", which is truthy', () => {
    process.env.TAURI_ENV_DEBUG = 'false';
    delete process.env.APELLES_PERF_MARKS;
    expect(perfMarksEnabled('build')).toBe(false);
  });

  it('is off in a plain build with no Tauri env, and on when forced', () => {
    delete process.env.TAURI_ENV_DEBUG;
    delete process.env.APELLES_PERF_MARKS;
    expect(perfMarksEnabled('build')).toBe(false);
    process.env.APELLES_PERF_MARKS = '1';
    expect(perfMarksEnabled('build')).toBe(true);
  });

  it('defines the constant as a JSON literal Vite can substitute', () => {
    process.env.TAURI_ENV_DEBUG = 'true';
    expect(perfMarksDefine('build')).toEqual({ 'import.meta.env.APELLES_PERF_MARKS': '"true"' });
  });
});

describe('debugToolsEnabled / buildDefines (B-358)', () => {
  it('mirrors debug_assertions: on for vite dev and tauri debug, off for a release build', () => {
    delete process.env.TAURI_ENV_DEBUG;
    expect(debugToolsEnabled('serve')).toBe(true);
    process.env.TAURI_ENV_DEBUG = 'true';
    expect(debugToolsEnabled('build')).toBe(true);
    process.env.TAURI_ENV_DEBUG = 'false';
    expect(debugToolsEnabled('build')).toBe(false);
    delete process.env.TAURI_ENV_DEBUG;
    expect(debugToolsEnabled('build')).toBe(false);
  });

  it('forcing the perf marks does not turn the debug tooling on', () => {
    delete process.env.TAURI_ENV_DEBUG;
    process.env.APELLES_PERF_MARKS = '1';
    expect(buildDefines('build')).toEqual({
      'import.meta.env.APELLES_PERF_MARKS': '"true"',
      'import.meta.env.APELLES_DEBUG_TOOLS': '"false"',
    });
  });
});
