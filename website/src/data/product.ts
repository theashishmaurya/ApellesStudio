/**
 * website/src/data/product.ts — what the site is allowed to claim (D-264,
 * succeeding D-255).
 *
 * What it is: the shipped-feature ground truth, transcribed from
 * `docs/02-scope.md` (reconciled 2026-09-08 by D-231) and `docs/00-vision.md`,
 * plus the positioning this site argues from.
 * What it does NOT do: carry anything marked 🔨 (planned) in that scope doc, or
 * any comparison claim that is not a description of how a tool is built. If a
 * capability line here has no ✅ behind it in `docs/02-scope.md`, it does not
 * belong on the website.
 *
 * The capability lists below are unchanged from D-255 — they were verified then
 * and nothing about the rebrand makes a shipped feature more or less shipped.
 * What D-264 rewrote is the framing around them: who each surface is for,
 * stated from the user's side of the screen rather than the architecture's.
 */

export interface Tab {
  readonly id: 'edit' | 'motion' | 'colorist';
  readonly name: string;
  /** What a person comes to this room to do, in their words not ours. */
  readonly line: string;
  /** The one thing this room is for, said plainly and without hedging. */
  readonly plain: string;
  /** Real shipped capabilities. Every one traces to a ✅ in docs/02-scope.md. */
  readonly shipped: readonly string[];
  /**
   * A real screenshot of this tab, or null when no capture exists yet. Null is
   * a real state the page renders honestly — it never substitutes a mockup.
   */
  readonly shot: {
    readonly src: string;
    readonly alt: string;
    /** The image's real intrinsic size, so the layout reserves the right box. */
    readonly width: number;
    readonly height: number;
  } | null;
  /** Said plainly when `shot` is null, so the absence is explained not hidden. */
  readonly shotNote?: string;
}

export const TABS: readonly Tab[] = [
  {
    id: 'edit',
    name: 'Edit',
    line: 'Where the video gets its shape.',
    plain:
      'A real multi-track editor. Everything a working editor expects to find under their hands is here — and everything here can be asked for in a sentence instead.',
    shipped: [
      'Video, audio and subtitle tracks composited alpha-over, not opaque top-wins',
      'Ripple, roll, slip, slide, swap-media and the seven edit types on drop',
      'Multi-select, marquee, cross-track ripple and real A/V linking',
      'Per-clip transform with independent width/height, crop, and per-property keyframes',
      'Real cubic-bezier keyframe easing, dynamic zoom, and speed ramps that can run in reverse',
      'Transitions that bridge a cut and read handle media — clips never overlap',
      'Text and title clips, subtitles, and animated caption presets burned into preview and export alike',
      'Per-clip volume, constant-power pan, four-band parametric EQ, track gain and ducking',
      'Frame-anchored timeline markers on Resolve’s own sixteen-colour palette',
      'Export the whole timeline to video with real mixed audio, or to DTD-verified FCPXML 1.7',
    ],
    // D-288: hidden for now, same as Motion/Colorist below — the captures
    // predate the rename and are being retaken (TODO-RECAPTURE-SHOTS.md);
    // the owner's own call rather than show stand-in imagery in the meantime.
    shot: null,
    shotNote:
      'A capture of the Edit room existed here, but predates the rename and is being retaken rather than shown stale. The capabilities below are all shipped and documented today.',
  },
  {
    id: 'motion',
    name: 'Motion',
    line: 'Where things move on their own.',
    plain:
      'Titles, callouts and graphics that animate — built in the same window as the cut, not exported out of a second app and imported back.',
    shipped: [
      // Ten as of D-258, not the eight D-255 transcribed: the eight abstract
      // explainer primitives plus the first two representational ones.
      'Ten layer primitives — text, emphasis, matrix, graph, layers, particleflow, labelbox, layerstack, plus claudechat and deviceframe',
      'A multi-scene JSON manifest and compiler, with each scene optionally 3D',
      'A live Remotion player preview with its own transport',
      'On-canvas select, drag, resize, marquee and group-move in world coordinates',
      'A per-row keyframe timeline with a real bezier ease-curve editor',
      'A browsable primitive catalog that actually creates layers, and a typed property Inspector',
      'Render exports every scene as its own video file, auto-imported back into Sources',
    ],
    shot: null,
    shotNote:
      'No screenshot of the Motion room has been captured yet. Rather than show a mockup, this section lists only what the room really does today.',
  },
  {
    id: 'colorist',
    name: 'Colorist',
    line: 'Where it stops looking like a phone recording.',
    plain:
      'Real colour work, with real colour science underneath — the single biggest difference between footage that looks amateur and footage that does not, and the part nobody teaches you.',
    shipped: [
      'A wgpu/WGSL GPU render pipeline with a layered, non-destructive adjustment stack',
      'Primary, master and per-channel tone curves, lift/gamma/gain wheels, LUT nodes, HSL qualifier',
      'Shape masks (radial, linear, brush) with feather, per-mask adjustments and per-mask blur',
      'SAM 2 subject masks with video propagation, refined through a trimap into ViTMatte',
      'Depth masks via Depth Anything V2, plus a temporally-consistent depth track for moving cameras',
      'Mask keyframes: geometry authored at source frames, interpolated at render time',
      'A live scopes panel — luma, RGB, parade, vectorscope, histogram',
      'Interactive relight: draggable depth-driven light pucks, deterministic and real-time',
      'Closed-loop match_to_reference, depth-haze, ProRes/H.264 export and a .cube bake',
    ],
    shot: null,
    shotNote:
      'No screenshot of the Colorist room has been captured yet. The capabilities listed here are all shipped and documented; the imagery simply does not exist to show yet.',
  },
];

/**
 * The differentiation argument, as data.
 *
 * Every left-hand column below is a description of what a professional NLE
 * genuinely asks of its user — not a slight. Resolve and Premiere are superb
 * tools, and the reason they ask this much is that they were built by editors
 * for editors who already have the craft. That assumption is the thing Apelles
 * does not make, and naming it precisely is more honest, and more persuasive,
 * than claiming to be "easier".
 *
 * Each right-hand column maps to a real shipped capability with a real MCP tool
 * behind it. The `tool` field is checked against mcp/server.py by
 * tests/mcp-data.test.ts, so none of these can quietly become aspirational.
 */
export interface Contrast {
  /** The thing a person actually wants, in their own words. */
  readonly want: string;
  /** What doing it in a professional NLE genuinely involves. */
  readonly craft: string;
  /** What it is here. */
  readonly here: string;
  /** The real MCP tool that does it. Verified against mcp/server.py. */
  readonly tool: string;
}

export const CONTRASTS: readonly Contrast[] = [
  {
    want: '“Cut to the bit where she says ‘anyway’.”',
    craft:
      'Scrub the audio waveform until you find the word by eye, drop a marker, position the playhead on the exact frame, then cut.',
    here: 'Say the word. The transcript is word-level, so the cut lands on it.',
    tool: 'editor_get_transcript',
  },
  {
    want: '“Push in slowly on his face as he answers.”',
    craft:
      'Set a scale and position keyframe at the start, another at the end, open the curve editor, ease both so it does not start with a jolt, then check it has not drifted off his face.',
    here: 'Ask for the push-in. The keyframes and the ease are written for you, and you can still drag them afterwards.',
    tool: 'editor_set_dynamic_zoom',
  },
  {
    want: '“These two shots should look like the same afternoon.”',
    craft:
      'Read the scopes on both, work out which one is warmer and by how much, then rebuild the second shot’s primary until the waveforms sit together.',
    here: 'Point at the shot you like. The match is measured against real scopes, not eyeballed.',
    tool: 'match_to_reference',
  },
  {
    want: '“Blur the background, keep her sharp.”',
    craft:
      'Roto her out by hand, or key a mask and track it forward frame by frame, fixing it every time she moves.',
    here: 'Name her. A segmentation model finds her and follows her through the shot.',
    tool: 'track_subject',
  },
];

/**
 * The reasons this is built the way it is. Each is a structural claim about the
 * software — checkable in the repository — which is why each can be made
 * without naming a competitor or drawing a comparison chart.
 */
export interface Pillar {
  readonly title: string;
  readonly body: string;
  /** The concrete, checkable fact behind the claim. */
  readonly proof: string;
}

export const PILLARS: readonly Pillar[] = [
  {
    title: 'Your footage never leaves the room',
    body: 'There is no upload, because there is no server. The masking, the depth, the matting, the transcription and the scene analysis are all models running on your own machine.',
    proof:
      'Not a setting you can forget to switch on: zero network calls in the grade path is a project invariant, and any cloud call has to be an explicit opt-in and documented as one.',
  },
  {
    title: 'Free, with nothing held back',
    body: 'No credits to spend, no export limit, no tier where the good masks live. The whole application is open source under AGPL-3.0, including the parts a commercial tool would charge for.',
    proof: 'Every capability described on this site is in the same build. There is no second build.',
  },
  {
    title: 'The agent uses the real controls',
    body: 'When the agent makes an edit, you watch it happen — the sliders move, the clip lands on the timeline, and it goes on the same undo stack, so you can take one step back and do it your way instead.',
    proof:
      'An MCP call and a GUI click run the identical store action. It is a standing rule in the repository that a feature ships with both or it has not shipped.',
  },
  {
    title: 'The same grade, forever',
    body: 'Your look is a document, not a state the app happens to be in. Open it in a year and the same frame renders the same pixels, so a project can be versioned, reviewed and replayed like code.',
    proof:
      'Non-determinism in the render path is treated as a blocker bug, and a test renders a fixture and hashes the output.',
  },
];

/**
 * What the product is not, said out loud. A pre-release tool with no public
 * build has real limits, and a site that hides them is the kind of site this
 * one is trying not to be.
 *
 * The third line used to say the Motion room had no MCP tools. That was true
 * when D-255 wrote it and stopped being true on 2026-09-09 (D-257/D-259/D-260
 * closed all 37), which this site only found out because a test re-counts the
 * server on every run. The remaining agent-coverage gaps are real and listed on
 * the MCP page instead, where the reader who cares about them is.
 */
export const LIMITS: readonly string[] = [
  'There is no public build yet. Nothing is downloadable from this site today, and the signup below is the only thing on it that does anything.',
  'It runs on macOS with Apple Silicon. Windows has been surveyed and scoped, and not built.',
  'There are no screenshots of the Motion or Colorist rooms anywhere on this site, because none have been captured. What those rooms do is described, not shown.',
  'It will not tell you what your video should be about. Taste, timing and what is worth saying stay yours; this is a tool for executing the thing you already have in mind.',
];

/**
 * Honest state-of-the-project facts. A pre-launch site with no users yet says
 * so; it does not invent download counts, testimonials or logos.
 */
export const STATUS = {
  stage: 'Pre-release',
  platform: 'macOS (Apple Silicon)',
  licence: 'AGPL-3.0',
  windows: 'Surveyed and scoped, not yet built',
} as const;

