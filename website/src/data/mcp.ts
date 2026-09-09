/**
 * website/src/data/mcp.ts — the real MCP surface, as data (D-255, rebranded by
 * D-264).
 *
 * What it is: the numbers and tool descriptions this site publishes about
 * Apelles's MCP server, transcribed from real repo sources.
 * What it does NOT do: estimate, round up, or describe a tool that is not in
 * `mcp/server.py`. Every count below was produced by counting `@mcp.tool()`
 * definitions in that file on 2026-09-09, and `verifiedOn` records that date so
 * a future reader knows how stale this page is.
 *
 * Re-verify with:
 *   grep -c '^@mcp.tool()' mcp/server.py
 * and re-split by prefix (`editor_*` + the four unprefixed Edit tools
 * get_timeline / set_clip_fade / set_clip_speed / set_track_duck, less the four
 * media-understanding ones; `motion_*`; `debug_*`; the remainder is Colorist).
 */

export const VERIFIED_ON = '2026-09-09';

export interface ToolGroup {
  /** Short label used as the group's heading. */
  readonly name: string;
  /** How many real `@mcp.tool()` functions are in this group. */
  readonly count: number;
  /** What the group covers, in plain language. */
  readonly blurb: string;
  /** A handful of real tool names from this group — never invented. */
  readonly sample: readonly string[];
}

/**
 * Totals, re-counted 2026-09-09. 153 `@mcp.tool()` definitions exist; 9 of them
 * are the `debug_*` tools, which are compiled out of a production build
 * (CLAUDE.md's standing rule — internal debug tooling is never shipped), so the
 * surface a real user's MCP client sees is 144.
 *
 * These numbers moved a long way since D-255 wrote 115/106, and the site did
 * not notice on its own — `tests/mcp-data.test.ts` did, on the first run of
 * D-264's rebuild. That is exactly what it is for. The Motion tab closed its
 * whole 37-tool gap in the interval (D-257/D-259/D-260), which is why the
 * MOTION_GAP constant that used to live in this file is gone rather than
 * updated.
 */
export const TOOL_TOTALS = {
  all: 153,
  shipped: 144,
  debugOnly: 9,
} as const;

export const TOOL_GROUPS: readonly ToolGroup[] = [
  {
    name: 'Edit',
    count: 61,
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
    name: 'Motion',
    count: 37,
    blurb:
      'The motion-graphics room, closed as a gap on 2026-09-09 (D-257/D-259/D-260) after a year of being this surface’s sharpest shortfall. Scenes and layers from a real primitive catalog, per-layer keyframes with bezier easing, 2D and 3D cameras, align and distribute, and a Remotion render that emits one video file per scene.',
    sample: [
      'motion_get_state',
      'motion_list_primitives',
      'motion_add_scene',
      'motion_add_layer',
      'motion_set_layer_field',
      'motion_set_layer_position',
      'motion_add_layer_keyframe',
      'motion_set_keyframe_ease',
      'motion_set_camera_3d',
      'motion_align_layers',
      'motion_distribute_layers',
      'motion_get_edit_links',
      'motion_render',
    ],
  },
  {
    name: 'Media understanding',
    count: 4,
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
 * The honest gaps, as `docs/notes/mcp-tool-coverage.md` records them today.
 *
 * D-255's version of this constant was MOTION_GAP — the Motion tab's zero,
 * printed next to the other counts rather than quietly omitted. That gap closed
 * (D-257/D-259/D-260), so the constant is replaced rather than deleted: a site
 * that prints only the closed gaps is back to marketing. These two are the real
 * remaining shortfalls, and neither is invented for modesty.
 */
export const GAPS: readonly string[] = [
  'The media pool is half-covered. An agent can import and remove items, but there is still no tool to list what is in the pool or organize it into folders, so it cannot inspect the pool before acting on it.',
  'Audio playback transport has no tools at all — play, stop, level, waveform. It is the lowest-priority gap on the tracking list rather than an oversight, since an agent driving edits does not obviously need to press play.',
] as const;

/** The real connection details, from mcp/server.py and mcp/README.md. */
export const CONNECTION = {
  defaultPort: 19788,
  portEnvVar: 'CHROMA_CONTROL_PORT',
  serverPath: 'mcp/server.py',
  controlServerPath: 'app/src-tauri/src/chroma/control.rs',
} as const;

/**
 * The two failure messages the server really raises, quoted on the docs page so
 * a reader can search for what they are looking at.
 *
 * Only the brand-free fragment of each is stored, deliberately: the full
 * strings name the product, and the product is being renamed. A fragment
 * survives that rename, still matches the real string, and still fails this
 * site's test if the underlying error is reworded — which is the actual thing
 * worth guarding. `tests/mcp-data.test.ts` asserts both are in server.py.
 */
export const ERROR_FRAGMENTS = [
  'Cannot reach the',
  'did not respond (its window may be closed or busy)',
] as const;
