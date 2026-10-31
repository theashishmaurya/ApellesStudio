/**
 * scenario.ts — what a UI-harness scenario IS (D-434).
 *
 * A scenario is DATA: a fixture to build, then a list of steps. Steps either
 * act (real input through `debug_pointer` / `debug_key`, or a plain control op
 * for setup and for MCP-parity checks), wait, capture a snapshot under a name,
 * or assert. Written in TypeScript so the compiler checks every scenario's
 * shape; no step is a free-form function except `args` builders that need a
 * captured value, which are still pure.
 *
 * Every scenario cites the NLE behaviour it expects (`reference`) — the suite
 * is written against how Resolve / Premiere / Final Cut behave, not against
 * whatever Apelles happens to do today, so a FAIL is a finding.
 */

import type { Assertion, Value } from './assertions.ts';
import type { PerfBudget } from './budgets.ts';

export type MediaKind = 'video' | 'av' | 'tone';

export interface FixtureClip {
  /** The name assertions use: `timeline.clips.<name>`. */
  name: string;
  /** Which generated test file. Default `video` (picture only — no linked audio is created). */
  media?: MediaKind;
  /** Source frames (the source's own rate), as `editor_add_clip` takes it. */
  sourceStart?: number;
  /** Timeline frames: `buildFixture` converts it to the source's own frames. */
  duration: number;
  startFrame: number;
}

export interface FixtureSpec {
  /** Tracks top to bottom; each is created if the new timeline lacks it. */
  tracks: { kind: 'video' | 'audio'; clips: FixtureClip[] }[];
  markers?: { name: string; frame: number }[];
  /** Transitions on exact cut frames (a cross dissolve; the fixture media has handles). */
  transitions?: { track: number; atFrame: number }[];
  playhead?: number;
}

/** A frame-addressed point on the timeline, resolved by the runner from the
 *  live view readout: "frame 90 on track 1". */
export interface FrameTarget {
  frame: Value;
  /** A track row, or `'ruler'` for the time ruler above the rows. */
  track: number | 'ruler';
  /** 0 top … 1 bottom of the row. Default 0.5. */
  fy?: number;
}

/** A relative destination in timeline units: "15 frames right, 1 track down"
 *  from the previous point of the gesture. */
export interface FrameOffset {
  byFrames: Value;
  byTracks?: number;
}

/** What `debug_pointer` accepts as a target (wire shape), plus the two
 *  timeline-unit forms above. */
export type TargetRef =
  | { x: number; y: number }
  | { byX: number; byY?: number }
  | {
      selector?: string;
      testid?: string;
      nodeId?: string;
      nth?: number;
      at?: { fx?: number; fy?: number; dx?: number; dy?: number };
    }
  | FrameTarget
  | FrameOffset;

export interface PointerStep {
  pointer: {
    action: 'move' | 'down' | 'up' | 'click' | 'doubleClick' | 'drag' | 'wheel' | 'pinch';
    target: TargetRef;
    to?: TargetRef;
    path?: TargetRef[];
    button?: 'left' | 'right' | 'middle';
    modifiers?: string[];
    steps?: number;
    durationMs?: number;
    holdMs?: number;
    deltaX?: number;
    deltaY?: number;
    scale?: number;
    /** CSS selectors sampled every frame (the live-feedback evidence). */
    watch?: { selectors?: string[]; cursor?: boolean; maxFrames?: number };
    settleMs?: number;
  };
  label?: string;
  /** Measure, and hold the numbers to the default budget (or this one). */
  measure?: boolean | Partial<PerfBudget>;
  /** Require that the press landed on the element it aimed at (`targets[0].hitInside`). Default true. */
  expectHit?: boolean;
}

export interface KeyStep {
  key: {
    keys?: string[];
    text?: string;
    phase?: 'press' | 'down' | 'up';
    holdMs?: number;
    gapMs?: number;
    watch?: { selectors?: string[]; cursor?: boolean; maxFrames?: number };
    settleMs?: number;
  };
  label?: string;
  measure?: boolean | Partial<PerfBudget>;
}

/** A plain control op — fixture tweaks, `undo`, and the MCP side of a
 *  GUI-vs-MCP parity check. `args` may be built from the scope (captured
 *  snapshots), e.g. the index a clip has NOW. */
export interface OpStep {
  op: string;
  args?: Record<string, unknown> | ((scope: Record<string, unknown>) => Record<string, unknown>);
  /** Keep the result in the scope under this name. */
  as?: string;
  label?: string;
}

export interface CaptureStep {
  /** `dom` reads one element (`selector`) through `debug_dom_tree`: its
   *  `rect`, `attrs` and computed `cursor`. */
  capture: 'timeline' | 'state' | 'view' | 'dom';
  as: string;
  selector?: string;
}

export interface ExpectStep {
  expect: Assertion | Assertion[];
  label?: string;
}

/** Poll until the assertion holds (the store settles asynchronously). */
export interface WaitForStep {
  waitFor: Assertion;
  timeoutMs?: number;
  label?: string;
}

export interface WaitStep {
  wait: number;
}

export interface ScreenshotStep {
  screenshot: string;
}

/** Precondition: when it does not hold, the scenario is SKIPPED with `reason`
 *  (e.g. "the fixture's A/V clip came without a linked audio half"). */
export interface RequireStep {
  require: Assertion;
  reason: string;
}

/** A GUI-reachability check: the element must exist on screen. Missing is a
 *  FAIL with `reason` — "the tool cannot even be reached from the GUI". */
export interface ReachableStep {
  reachable: { selector: string; reason: string };
}

/** Play for `seconds` and hold the preview's measured frame rate to budget. */
export interface PlaybackStep {
  playback: { seconds: number; fromFrame?: number; paintMinFps?: number; rafMinFps?: number };
  as?: string;
}

export type Step =
  | PointerStep
  | KeyStep
  | OpStep
  | CaptureStep
  | ExpectStep
  | WaitForStep
  | WaitStep
  | ScreenshotStep
  | RequireStep
  | ReachableStep
  | PlaybackStep;

export interface Scenario {
  /** Stable, kebab-case; what `--filter` matches. */
  id: string;
  title: string;
  /** The interaction family, for the report's grouping. */
  area: string;
  /** The NLE behaviour this expects, with its source. */
  reference: string;
  fixture?: FixtureSpec;
  /** Left out of a run that names no `--filter` (a slow or measurement-only family, e.g. `perf-300`). */
  optIn?: boolean;
  steps: Step[];
}
