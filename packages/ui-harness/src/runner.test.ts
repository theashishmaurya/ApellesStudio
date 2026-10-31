/**
 * D-434 — the runner against a fake app.
 *
 * `FakeApp` answers the control ops a scenario uses with a tiny in-memory
 * timeline, and performs a ROLL when the GUI gesture asks for one — correctly,
 * or (the `buggy` flag) the way a broken build would: the store changes but
 * the incoming clip does not, and nothing moves on screen mid-drag. The real
 * `roll-edit-tool` scenario must PASS against the first and FAIL, with the
 * specific findings, against the second.
 */
import { describe, expect, it } from 'vitest';

import { TIMELINE_VIEW_ATTRS } from '@apelles/editor/src/timelineTestIds.ts';

import { checkBudget, DEFAULT_PERF_BUDGET, type PerfReport } from './budgets.ts';
import type { OpClient } from './client.ts';
import { mediaArgs, type ScratchProject } from './fixture.ts';
import { renderReport } from './report.ts';
import { resolveTargetRef, ScenarioRunner, substituteIds } from './runner.ts';
import { EDIT_TOOL_SCENARIOS } from './scenarios/editTools.ts';
import { SCENARIOS } from './scenarios/index.ts';
import type { ViewSnap } from './snapshot.ts';

const PX_PER_SEC = 90;
const FPS = 30;

interface Clip {
  id: string;
  startFrame: number;
  duration: number;
  sourceStart: number;
}

class FakeApp implements OpClient {
  tracks: Clip[][] = [];
  history: Clip[][][] = [];
  tool = 'select';
  playhead = 0;
  calls: string[] = [];
  private nextId = 1;

  private readonly buggy: boolean;

  constructor(buggy = false) {
    this.buggy = buggy;
  }

  private snapshot() {
    return this.tracks.map((t) => t.map((c) => ({ ...c })));
  }

  private dto() {
    const durationFrames = Math.max(0, ...this.tracks.flat().map((c) => c.startFrame + c.duration));
    return {
      id: 'tl',
      durationFrames,
      tracks: this.tracks.map((t, index) => ({ index, clips: t.map((c, i) => ({ ...c, index: i, linkGroup: null })) })),
      markers: [],
    };
  }

  private roll(trackIndex: number, clipIndex: number, delta: number) {
    this.history.push(this.snapshot());
    const t = this.tracks[trackIndex];
    const a = t[clipIndex];
    const b = t[clipIndex + 1];
    a.duration += delta;
    if (!this.buggy) {
      b.startFrame += delta;
      b.sourceStart += delta;
      b.duration -= delta;
    }
  }

  async op<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    this.calls.push(op);
    const out = ((): unknown => {
      switch (op) {
        case 'editor_create_timeline':
          this.tracks = [];
          return { timeline: { id: 'tl' } };
        case 'editor_list_tracks':
          return { tracks: this.tracks.map((_, index) => ({ index, kind: 'video' })) };
        case 'editor_add_track':
          this.tracks.splice(Number(args.index), 0, []);
          return {};
        case 'editor_add_clip': {
          const c = { id: `c${this.nextId++}`, startFrame: Number(args.startFrame), duration: Number(args.duration), sourceStart: Number(args.sourceStart) };
          this.tracks[Number(args.track)].push(c);
          return { ok: true };
        }
        case 'editor_get_timeline':
          return this.dto();
        case 'editor_get_state':
          return { playhead: this.playhead, playing: false, selection: [], activeTimeline: { id: 'tl', fps: FPS } };
        case 'editor_set_playhead':
          this.playhead = Number(args.frame);
          return {};
        case 'debug_dom_tree':
          if (String(args.selector).includes('timeline-edit-area')) {
            return {
              root: {
                rect: { x: 0, y: 0, width: 1200, height: 400 },
                attrs: {
                  [TIMELINE_VIEW_ATTRS.pxPerSec]: String(PX_PER_SEC),
                  [TIMELINE_VIEW_ATTRS.scrollLeft]: '0',
                  [TIMELINE_VIEW_ATTRS.scrollTop]: '0',
                  [TIMELINE_VIEW_ATTRS.fps]: String(FPS),
                  [TIMELINE_VIEW_ATTRS.startLeft]: '32',
                  [TIMELINE_VIEW_ATTRS.rowHeight]: '52',
                  [TIMELINE_VIEW_ATTRS.rowsTop]: '50',
                },
              },
            };
          }
          // A pressed tool button exists only for the active tool.
          return { root: String(args.selector).includes(`"${this.tool}"][aria-pressed="true"]`) ? { rect: {} } : null };
        case 'debug_pointer':
          return this.pointer(args);
        case 'debug_key':
          return { observed: { counts: { keydown: 1 } }, mode: 'native' };
        case 'undo': {
          const prev = this.history.pop();
          if (prev) this.tracks = prev;
          return {};
        }
        case 'editor_roll_edit':
          this.roll(Number(args.track), Number(args.clip), Number(args.delta));
          return {};
        case 'editor_delete_timeline':
        case 'editor_set_playing':
        case 'debug_screenshot':
          return {};
        default:
          throw new Error(`FakeApp: unexpected op ${op}`);
      }
    })();
    return out as T;
  }

  private pointer(args: Record<string, unknown>) {
    const target = args.target as { selector?: string };
    const sel = target.selector ?? '';
    const toolMatch = /data-chroma-trim-tool="(\w+)"/.exec(sel);
    if (args.action === 'click' && toolMatch) this.tool = toolMatch[1];
    const watched = (args.watch as { selectors?: string[] } | undefined)?.selectors ?? [];
    let frames: { t: number; rects: Record<string, { x: number; y: number; width: number; height: number }[]>; cursor: string }[] = [];
    if (args.action === 'drag' && this.tool === 'roll' && sel.includes('right-stretch')) {
      const to = args.to as { byX: number };
      const delta = Math.round((to.byX / PX_PER_SEC) * FPS);
      const clipId = /data-chroma-clip-id="([^"]+)"/.exec(sel)?.[1];
      const index = this.tracks[0].findIndex((c) => c.id === clipId);
      this.roll(0, index, delta);
      // Live feedback: a correct build moves both blocks every frame; a broken one moves nothing.
      frames = Array.from({ length: 8 }, (_, i) => ({
        t: i * 16,
        cursor: 'col-resize',
        rects: Object.fromEntries(watched.map((s, k) => [s, [{ x: 100 + k * 200 + (this.buggy ? 0 : i * 5), y: 0, width: 200 + (this.buggy ? 0 : i * 5), height: 52 }]])),
      }));
    }
    return {
      mode: 'native',
      targets: [{ x: 10, y: 10, element: 'el', hit: 'el', hitInside: true }],
      observed: { counts: { pointerdown: 1, pointermove: 15, pointerup: 1 } },
      ...(args.measure ? { perf: { frameBudgetMs: 16.7, frames: { samples: 30, p50Ms: 16.7, p95Ms: 17, maxMs: 18, dropped: 0 }, inputToFrame: { samples: 17, p95Ms: 9 }, store: { commits: 1, firstCommitAfterInputMs: 40, lastCommitAfterLastInputMs: 5 } } } : {}),
      ...(watched.length ? { watch: frames } : {}),
    };
  }
}

const project: ScratchProject = { path: '/tmp/ui-harness-x.chroma', mediaIds: { video: 'm1', av: 'm2', tone: 'm3' }, originalProject: null };
const roll = EDIT_TOOL_SCENARIOS.find((s) => s.id === 'roll-edit-tool');
if (!roll) throw new Error('roll-edit-tool scenario missing');

describe('ScenarioRunner (against a fake app)', () => {
  it('a correct roll passes every check: store, live feedback, cursor, MCP parity, perf', async () => {
    const app = new FakeApp(false);
    const result = await new ScenarioRunner(app, project, { mode: 'native', shotsDir: '/tmp' }).run(roll);
    expect(result.checks.filter((c) => !c.ok).map((c) => c.message)).toEqual([]);
    expect(result.status).toBe('PASS');
    expect(result.perf).toHaveLength(1);
    expect(result.perf[0].ok).toBe(true);
    expect(app.calls).toContain('editor_roll_edit');
    expect(app.calls[app.calls.length - 1]).toBe('editor_delete_timeline');
  });

  it('a broken roll FAILS with the specific findings, and gets a failure screenshot', async () => {
    const app = new FakeApp(true);
    const result = await new ScenarioRunner(app, project, { mode: 'native', shotsDir: '/tmp', waitForTimeoutMs: 50 }).run(roll);
    expect(result.status).toBe('FAIL');
    const failed = result.checks.filter((c) => !c.ok).map((c) => c.message).join('\n');
    expect(failed).toMatch(/b’s head visibly moves during the roll/);
    expect(failed).toMatch(/timeline\.clips\.b\.startFrame = 90 — expected eq 105/);
    expect(result.screenshots).toEqual(['/tmp/roll-edit-tool-failure.png']);
  });

  it('an unknown op from the harness itself is an ERROR, not a FAIL, and the fixture is still torn down', async () => {
    const app = new FakeApp(false);
    const result = await new ScenarioRunner(app, project, { mode: 'native', shotsDir: '/tmp' }).run({
      id: 'x',
      title: 'x',
      area: 'x',
      reference: 'x',
      steps: [{ op: 'nonesuch' }],
    });
    expect(result.status).toBe('ERROR');
    expect(result.reason).toMatch(/unexpected op nonesuch/);
    expect(app.calls[app.calls.length - 1]).toBe('editor_delete_timeline');
  });
});

describe('runner helpers', () => {
  it('substitutes fixture ids into selectors and values, leaving unknown names to fail loudly', () => {
    const out = substituteIds(
      { selector: '[data-chroma-clip-id="@clip:a"]', value: '@clip:b', m: '@marker:p', other: '@clip:zz', n: 3 },
      { clipIds: { a: 'id-a', b: 'id-b' }, markerIds: { p: 'id-p' } },
    );
    expect(out).toEqual({ selector: '[data-chroma-clip-id="id-a"]', value: 'id-b', m: 'id-p', other: '@clip:zz', n: 3 });
  });

  it('resolves frame-addressed targets from the view, and passes others through', () => {
    const view: ViewSnap = { pxPerSec: 90, scrollLeft: 0, scrollTop: 0, fps: 30, startLeft: 32, rowHeight: 52, rowsTop: 50, rect: { x: 100, y: 20, width: 900, height: 300 } };
    expect(resolveTargetRef({ frame: 30, track: 0 }, view, {})).toEqual({ x: 222, y: 96 });
    expect(resolveTargetRef({ frame: { ref: 'v.f', plus: 30 }, track: 1, fy: 0 }, view, { v: { f: 0 } })).toEqual({ x: 222, y: 122 });
    expect(resolveTargetRef({ byFrames: 15, byTracks: 1 }, view, {})).toEqual({ byX: 45, byY: 52 });
    expect(resolveTargetRef({ frame: 30, track: 'ruler' }, view, {})).toEqual({ selector: '.timeline-editor-time-area', at: { fx: 0, fy: 0.5, dx: 122 } });
    expect(resolveTargetRef({ testid: 'x' }, null, {})).toEqual({ testid: 'x' });
    expect(() => resolveTargetRef({ frame: 1, track: 0 }, null, {})).toThrow(/view readout/);
  });
});

describe('budgets, report, media, suite', () => {
  const perf = (over: Partial<PerfReport['frames']> = {}): PerfReport => ({
    frameBudgetMs: 16.7,
    frames: { samples: 60, p50Ms: 16.7, p95Ms: 18, maxMs: 25, dropped: 1, ...over },
    inputToFrame: { samples: 10, p95Ms: 12 },
    store: { commits: 1, firstCommitAfterInputMs: 30, lastCommitAfterLastInputMs: 10 },
  });

  it('holds perf to the budget and names every miss', () => {
    expect(checkBudget(perf())).toEqual({ ok: true, misses: [] });
    const bad = checkBudget(perf({ p95Ms: 40, maxMs: 120, dropped: 20 }));
    expect(bad.ok).toBe(false);
    expect(bad.misses).toHaveLength(3);
    expect(checkBudget(perf({ samples: 0 })).misses[0]).toMatch(/throttled/);
    expect(checkBudget({ ...perf(), store: { commits: 0, firstCommitAfterInputMs: null, lastCommitAfterLastInputMs: null } }, { ...DEFAULT_PERF_BUDGET, firstCommitMs: 100 }).misses).toEqual([
      'the input caused no store commit',
    ]);
  });

  it('renders a report with the summary, each check, perf numbers and screenshot links', () => {
    const md = renderReport(
      [
        {
          id: 'roll-edit-tool',
          title: 'Roll',
          area: 'edit tools',
          reference: 'Premiere N',
          status: 'FAIL',
          checks: [
            { ok: true, message: 'a ok', step: 1 },
            { ok: false, message: 'b moved | not', step: 2 },
          ],
          perf: [{ label: 'drag', ok: false, misses: ['frame p95 40 ms > 33.3 ms'], numbers: { frameP95Ms: 40, settleMs: null } }],
          screenshots: ['/run/shots/roll-edit-tool-failure.png'],
          durationMs: 1500,
        },
      ],
      { startedAt: 't', mode: 'native', port: 19788, project: '/p', notes: ['kept'] },
      '/run',
    );
    expect(md).toContain('**0/1 pass** · 1 fail');
    expect(md).toContain('| FAIL | [Roll](#roll-edit-tool) | edit tools | 1/2 | 0/1 |');
    expect(md).toContain('- ✗ step 2: b moved | not');
    expect(md).toContain('OVER: frame p95 40 ms > 33.3 ms');
    expect(md).toContain('frameP95Ms 40');
    expect(md).not.toContain('settleMs');
    expect(md).toContain('![roll-edit-tool](shots/roll-edit-tool-failure.png)');
  });

  it('generates picture-only, picture+tone and tone media', () => {
    expect(mediaArgs('video', '/o.mp4')).toContain('-an');
    expect(mediaArgs('av', '/o.mp4').filter((a) => a.startsWith('sine'))).toHaveLength(1);
    expect(mediaArgs('tone', '/o.wav')).not.toContain('libx264');
  });

  it('every scenario has a unique kebab-case id and cites a reference', () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SCENARIOS) {
      expect(s.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(s.reference.length).toBeGreaterThan(10);
      expect(s.steps.length).toBeGreaterThan(0);
    }
  });
});
