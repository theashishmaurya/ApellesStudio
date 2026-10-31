/**
 * The starter scenario suite (D-434): the edit tools first (the owner's own
 * report), then every other core timeline interaction. `--list` prints them.
 */

import type { Scenario } from '../scenario.ts';
import { EDIT_TOOL_SCENARIOS } from './editTools.ts';
import { TIMELINE_SCENARIOS } from './timeline.ts';

export const SCENARIOS: readonly Scenario[] = [...EDIT_TOOL_SCENARIOS, ...TIMELINE_SCENARIOS];
