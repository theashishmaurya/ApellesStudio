/**
 * The starter scenario suite (D-434): the edit tools first (the owner's own
 * report), then every other core timeline interaction. `--list` prints them.
 */

import type { Scenario } from '../scenario.ts';
import { EDIT_TOOL_SCENARIOS } from './editTools.ts';
import { PERF_300_SCENARIOS } from './perf300.ts';
import { REDESIGN_SCENARIOS } from './redesign.ts';
import { TIMELINE_SCENARIOS } from './timeline.ts';

/** `perf-300` is opt-in (`--filter perf-300`): it builds a 300-clip timeline per scenario and only measures. */
export const SCENARIOS: readonly Scenario[] = [
  ...EDIT_TOOL_SCENARIOS,
  ...TIMELINE_SCENARIOS,
  // v0.3.0 — the mockup gap closure: Inspector slider, target track, zoom slider.
  ...REDESIGN_SCENARIOS,
  ...PERF_300_SCENARIOS,
];
