/**
 * website/src/data/mcp.ts — the real MCP surface, as data (D-255).
 *
 * What it is: the numbers and tool descriptions this site publishes about
 * Chroma's MCP server, transcribed from real repo sources.
 * What it does NOT do: estimate, round up, or describe a tool that is not in
 * `mcp/server.py`. Every count below was produced by counting `@mcp.tool()`
 * definitions in that file on 2026-09-09, and `verifiedOn` records that date so
 * a future reader knows how stale this page is.
 *
 * Re-verify with:
 *   grep -c '^@mcp.tool()' mcp/server.py
 * and re-split by prefix (`editor_*` + the four unprefixed Edit tools
 * get_timeline / set_clip_fade / set_clip_speed / set_track_duck; `debug_*`;
 * the remainder is Colorist).
 */

export const VERIFIED_ON = '2026-09-09';

export interface ToolGroup {
  /** Short label used as the group's heading. */
  readonly name: string;
  /** How many real `@mcp.tool()` functions are in this group. */
  readonly count: number;
  /** One of the MARKER_COLORS token names, used as this group's signal colour. */
  readonly signal: string;
  /** What the group covers, in plain language. */
  readonly blurb: string;
  /** A handful of real tool names from this group — never invented. */
  readonly sample: readonly string[];
}

/**
 * Totals. 115 `@mcp.tool()` definitions exist; 9 of them are the `debug_*`
 * tools, which are compiled out of a production build (CLAUDE.md's standing
 * rule — internal debug tooling is never shipped), so the surface a real user's
 * MCP client sees is 106.
 */
export const TOOL_TOTALS = {
  all: 115,
  shipped: 106,
  debugOnly: 9,
} as const;

export const TOOL_GROUPS: readonly ToolGroup[] = [
  {
    name: 'Edit',
    count: 60,
    signal: 'blue',
    blurb:
      'The whole multi-track NLE. Import media, place and trim clips, perform any of the seven edit types at the playhead, roll/slip/slide, manage tracks, key transforms, set transitions, markers, captions and per-clip EQ, then render the timeline to a real file.',
    sample: [
      'editor_import_media',
      'editor_add_clip',
      'editor_edit_in',
      'editor_split_clip',
      'editor_trim_clip',
      'editor_roll_edit',
      'editor_slip_clip',
      'editor_slide_clip',
      'editor_set_clip_transform',
      'editor_set_clip_keyframes',
      'editor_set_keyframe_ease',
      'editor_set_dynamic_zoom',
      'set_clip_speed',
      'editor_add_transition',
      'editor_add_marker',
      'editor_set_clip_eq',
      'editor_export',
      'editor_export_fcpxml',
    ],
  },
  {
    name: 'Colorist',
    count: 42,
    signal: 'yellow',
    blurb:
      'Grading by the numbers. Primary, curves and wheels; composable shape, AI-subject and depth masks with keyframed geometry; SAM 2 tracking; a temporal depth track; relight pucks; and real scope measurement an agent reads back before and after every change.',
    sample: [
      'set_primary',
      'set_curve',
      'set_color_grade',
      'add_subject_mask',
      'add_component',
      'add_mask_keyframe',
      'track_subject',
      'depth_track',
      'apply_haze',
      'set_mask_adjust',
      'add_relight_light',
      'inspect_color',
      'sample_region',
      'match_to_reference',
      'request_human',
      'export',
    ],
  },
  {
    name: 'Media understanding',
    count: 4,
    signal: 'cyan',
    blurb:
      'What is actually in the footage. A word-level transcript (so a cut can land on an exact word) and an ffmpeg-scene-detect visual analysis. Both run as start-then-poll jobs, and both are local.',
    sample: [
      'editor_get_transcript',
      'editor_get_transcript_status',
      'editor_analyze_video',
      'editor_analyze_video_status',
    ],
  },
];

/**
 * The honest gap. `docs/notes/mcp-tool-coverage.md` tracks this as the Motion
 * tab's sharpest shortfall, and the site says so rather than quietly omitting a
 * tab from the count.
 */
export const MOTION_GAP = {
  count: 0,
  note:
    "The Motion tab has no MCP tools yet. Its 18 internal ops exist and were verified on the app's own control-server bridge, but the Python wrappers were never written, so no MCP client can reach them. It is tracked as the tab's sharpest gap, not glossed over.",
} as const;

/** The real connection details, from mcp/server.py and mcp/README.md. */
export const CONNECTION = {
  defaultPort: 19788,
  portEnvVar: 'CHROMA_CONTROL_PORT',
  serverPath: 'mcp/server.py',
  controlServerPath: 'app/src-tauri/src/chroma/control.rs',
} as const;
