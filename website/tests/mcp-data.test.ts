/**
 * mcp-data.test.ts — the site may not publish an MCP fact the server does not
 * back up (D-255).
 *
 * This is the anti-fabrication guard. It counts the real `@mcp.tool()`
 * definitions in mcp/server.py and asserts that every number and every tool
 * name the website prints is actually there. If someone adds a tool, this test
 * fails until the site's own count is updated — which is the point.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOOL_GROUPS, TOOL_TOTALS, MOTION_GAP, CONNECTION } from '../src/data/mcp.ts';

const server = readFileSync(
  fileURLToPath(new URL('../../mcp/server.py', import.meta.url)),
  'utf8',
);

/** Every decorated tool name, in file order. */
const TOOLS: string[] = [
  ...server.matchAll(/^@mcp\.tool\(\)\n(?:@[^\n]*\n)*def ([a-z_0-9]+)\(/gm),
].map((m) => m[1]);

/** Edit-tab tools that predate the `editor_` prefix convention. */
const UNPREFIXED_EDIT = ['get_timeline', 'set_clip_fade', 'set_clip_speed', 'set_track_duck'];

const debug = TOOLS.filter((t) => t.startsWith('debug_'));
const editorAll = TOOLS.filter((t) => t.startsWith('editor_') || UNPREFIXED_EDIT.includes(t));
const mediaUnderstanding = TOOLS.filter(
  (t) => t.startsWith('editor_get_transcript') || t.startsWith('editor_analyze_video'),
);
const colorist = TOOLS.filter((t) => !debug.includes(t) && !editorAll.includes(t));

describe('mcp/server.py parses', () => {
  it('finds a plausible number of tools', () => {
    expect(TOOLS.length).toBeGreaterThan(50);
  });

  it('every tool name is unique', () => {
    expect(new Set(TOOLS).size).toBe(TOOLS.length);
  });
});

describe('the totals the site publishes are real', () => {
  it('total tool count matches the server', () => {
    expect(TOOL_TOTALS.all).toBe(TOOLS.length);
  });

  it('the debug-only count matches the real debug_* tools', () => {
    expect(TOOL_TOTALS.debugOnly).toBe(debug.length);
  });

  it('shipped = all minus debug-only, and the arithmetic holds', () => {
    expect(TOOL_TOTALS.shipped).toBe(TOOLS.length - debug.length);
    expect(TOOL_TOTALS.shipped + TOOL_TOTALS.debugOnly).toBe(TOOL_TOTALS.all);
  });

  it('never claims the debug tools ship — they are compiled out of a release build', () => {
    expect(TOOL_TOTALS.shipped).toBeLessThan(TOOL_TOTALS.all);
  });
});

describe('per-group counts match the server', () => {
  const byName = Object.fromEntries(TOOL_GROUPS.map((g) => [g.name, g]));

  it('Edit excludes the media-understanding tools, which are counted separately', () => {
    expect(byName['Edit'].count).toBe(editorAll.length - mediaUnderstanding.length);
  });

  it('Colorist matches the non-editor, non-debug remainder', () => {
    expect(byName['Colorist'].count).toBe(colorist.length);
  });

  it('Media understanding matches the real transcript/analysis tools', () => {
    expect(byName['Media understanding'].count).toBe(mediaUnderstanding.length);
  });

  it('the group counts sum to the shipped total', () => {
    const sum = TOOL_GROUPS.reduce((n, g) => n + g.count, 0) + MOTION_GAP.count;
    expect(sum).toBe(TOOL_TOTALS.shipped);
  });
});

describe('every tool name the site prints exists in the server', () => {
  const named = TOOL_GROUPS.flatMap((g) => g.sample.map((s) => [g.name, s] as const));

  it.each(named)('%s: %s is a real tool', (_group, name) => {
    expect(TOOLS, `${name} is not defined in mcp/server.py`).toContain(name);
  });
});

describe('the Motion gap is stated, not hidden', () => {
  it('reports zero Motion tools', () => {
    expect(MOTION_GAP.count).toBe(0);
  });

  it('and that is still true of the server', () => {
    expect(TOOLS.filter((t) => t.startsWith('motion_'))).toHaveLength(0);
  });
});

describe('connection details match the server', () => {
  it('publishes the port the server actually defaults to', () => {
    expect(server).toContain(`"${CONNECTION.portEnvVar}", "${CONNECTION.defaultPort}"`);
  });

  it('publishes the loopback base URL the server actually builds', () => {
    expect(server).toContain('http://127.0.0.1:');
  });
});
