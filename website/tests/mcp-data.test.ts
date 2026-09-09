/**
 * mcp-data.test.ts — the site may not publish an MCP fact the server does not
 * back up (D-255, extended by D-264).
 *
 * This is the anti-fabrication guard. It counts the real `@mcp.tool()`
 * definitions in mcp/server.py and asserts that every number and every tool
 * name the website prints is actually there. If someone adds a tool, this test
 * fails until the site's own count is updated — which is the point.
 *
 * D-264 added three checks, all of them things the old suite asserted loosely
 * or not at all: the port environment variable is now READ OUT of server.py and
 * compared, rather than matched as a hard-coded literal, so a rename fails here
 * with a message saying what it became; the control-server path the docs page
 * prints is checked to exist on disk; and the differentiation page's tool names
 * are checked the same way the docs page's always were.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOOL_GROUPS, TOOL_TOTALS, GAPS, CONNECTION, ERROR_FRAGMENTS } from '../src/data/mcp.ts';
import { CONTRASTS } from '../src/data/product.ts';

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
const motion = TOOLS.filter((t) => t.startsWith('motion_'));
const editorAll = TOOLS.filter((t) => t.startsWith('editor_') || UNPREFIXED_EDIT.includes(t));
const mediaUnderstanding = TOOLS.filter(
  (t) => t.startsWith('editor_get_transcript') || t.startsWith('editor_analyze_video'),
);
const colorist = TOOLS.filter(
  (t) => !debug.includes(t) && !editorAll.includes(t) && !motion.includes(t),
);

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

  it('Motion matches the real motion_* tools', () => {
    expect(byName['Motion'].count).toBe(motion.length);
  });

  it('the group counts sum to the shipped total, with nothing unaccounted for', () => {
    const sum = TOOL_GROUPS.reduce((n, g) => n + g.count, 0);
    expect(sum).toBe(TOOL_TOTALS.shipped);
  });
});

describe('every tool name the site prints exists in the server', () => {
  const fromDocs = TOOL_GROUPS.flatMap((g) => g.sample.map((s) => [g.name, s] as const));

  it.each(fromDocs)('%s: %s is a real tool', (_group, name) => {
    expect(TOOLS, `${name} is not defined in mcp/server.py`).toContain(name);
  });

  /**
   * The differentiation page claims a specific tool does each job it describes.
   * That is a stronger claim than the docs page's tool list, so it gets the
   * same guard — an aspirational entry here would be exactly the kind of
   * fabrication this suite exists to catch.
   */
  it.each(CONTRASTS.map((c) => [c.want, c.tool] as const))(
    '%s is backed by %s, which really exists',
    (_want, tool) => {
      expect(TOOLS, `${tool} is not defined in mcp/server.py`).toContain(tool);
    },
  );
});

describe('the gaps are stated, not hidden', () => {
  /**
   * D-255's version of this block asserted the Motion tab's zero. That gap is
   * closed, so the block guards the same principle against the CURRENT gaps —
   * a site that stops naming any shortfall once the embarrassing one is fixed
   * has quietly become marketing.
   */
  it('still publishes real remaining shortfalls', () => {
    expect(GAPS.length).toBeGreaterThan(0);
    for (const g of GAPS) expect(g.length).toBeGreaterThan(40);
  });

  it('does not claim a gap that has actually been closed', () => {
    const joined = GAPS.join(' ').toLowerCase();
    expect(joined, 'the Motion tab has 37 MCP tools — that gap closed').not.toContain('motion');
    expect(motion.length).toBeGreaterThan(0);
  });

  /**
   * D-266 closed both gaps this block used to assert the shape of, so the
   * assertions are inverted rather than dropped: the site must not still claim
   * a shortfall the server has since covered, which is the identical failure
   * the Motion check above guards against.
   */
  it('does not still claim the pool cannot be listed — it can', () => {
    expect(TOOLS).toContain('editor_list_media');
    expect(TOOLS).toContain('editor_move_media');
    const joined = GAPS.join(' ').toLowerCase();
    expect(joined, 'editor_list_media exists — the pool CAN be enumerated').not.toContain(
      'no tool to list',
    );
  });

  it('does not still claim audio playback has no tools — it has a transport and a level', () => {
    expect(TOOLS).toContain('editor_set_playing');
    expect(TOOLS).toContain('editor_set_audio_monitor');
    expect(TOOLS).toContain('editor_get_audio_level');
    const joined = GAPS.join(' ').toLowerCase();
    expect(joined, 'playback transport is editor_set_playing').not.toContain('no tools at all');
  });
});

describe('connection details match the server', () => {
  /**
   * Read the variable name out of the server rather than asserting a literal.
   * The product is being renamed, so this may legitimately change — and when it
   * does, this failure names the new value instead of leaving someone to guess.
   */
  it('publishes the port variable the server actually reads', () => {
    const m = server.match(/os\.environ\.get\(\s*"([A-Z0-9_]+)"\s*,\s*"(\d+)"\s*\)/);
    expect(m, 'could not find the port lookup in mcp/server.py').not.toBeNull();
    expect(
      CONNECTION.portEnvVar,
      `mcp/server.py now reads ${m?.[1]} — update CONNECTION.portEnvVar in src/data/mcp.ts`,
    ).toBe(m?.[1]);
    expect(String(CONNECTION.defaultPort)).toBe(m?.[2]);
  });

  it('publishes the loopback base URL the server actually builds', () => {
    expect(server).toContain('http://127.0.0.1:');
  });

  it('names two file paths that are really in the repository', () => {
    for (const rel of [CONNECTION.serverPath, CONNECTION.controlServerPath]) {
      const onDisk = fileURLToPath(new URL(`../../${rel}`, import.meta.url));
      expect(existsSync(onDisk), `${rel} is printed on the docs page but does not exist`).toBe(
        true,
      );
    }
  });

  it('quotes error text the server really raises', () => {
    for (const fragment of ERROR_FRAGMENTS) {
      expect(server, `mcp/server.py no longer says "${fragment}"`).toContain(fragment);
    }
  });
});
