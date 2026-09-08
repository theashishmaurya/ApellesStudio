/**
 * website/src/data/product.ts — what the site is allowed to claim (D-255).
 *
 * What it is: the shipped-feature ground truth, transcribed from
 * `docs/02-scope.md` (reconciled 2026-09-08 by D-231) and `docs/00-vision.md`.
 * What it does NOT do: carry anything marked 🔨 (planned) in that scope doc.
 * If a line here has no ✅ behind it in `docs/02-scope.md`, it does not belong
 * on the website.
 */

export interface Tab {
  readonly id: 'edit' | 'motion' | 'colorist';
  readonly name: string;
  readonly signal: string;
  /** The one sentence that says what this tab is. */
  readonly line: string;
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
    signal: 'blue',
    line: 'A real multi-track NLE, with the edit operations a working editor expects to find under their hands.',
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
    shot: {
      src: '/shots/edit-transform.png',
      alt: 'Chroma’s Edit tab: a preview with an on-canvas transform box and its corner handles, a timeline showing the clip’s own filmstrip below it, and the clip Inspector open on the right with Transform, Crop and Fade sections.',
      width: 2560,
      height: 1440,
    },
  },
  {
    id: 'motion',
    name: 'Motion',
    signal: 'purple',
    line: 'A real authoring tab for motion graphics, running on a Remotion engine, in the same app as the cut.',
    shipped: [
      'Eight layer primitives: text, emphasis, matrix, graph, layers, particleflow, labelbox, layerstack',
      'A multi-scene JSON manifest and compiler, with each scene optionally 3D',
      'A live Remotion player preview with its own transport',
      'On-canvas select, drag, resize, marquee and group-move in world coordinates',
      'A per-row keyframe timeline with a real bezier ease-curve editor',
      'A browsable primitive catalog that actually creates layers, and a typed property Inspector',
      'Render exports every scene as its own video file, auto-imported back into Sources',
    ],
    shot: null,
    shotNote:
      'No screenshot of the Motion tab has been captured yet. Rather than show a mockup, this section lists only what the tab really does today.',
  },
  {
    id: 'colorist',
    name: 'Colorist',
    signal: 'yellow',
    line: 'Grading treated as a craft with real colour science, not a filter — and the part of Chroma that has no local open-source equivalent.',
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
      'No screenshot of the Colorist tab has been captured yet. The capabilities listed here are all shipped and documented; the imagery simply does not exist to show yet.',
  },
];

/**
 * The differentiators, as the competitive read landed them. Each is a
 * structural claim about how the thing is built, which is why each can be
 * stated without a comparison chart or a competitor's name.
 */
export interface Pillar {
  readonly title: string;
  readonly body: string;
  /** The concrete, checkable fact behind the claim. */
  readonly proof: string;
}

export const PILLARS: readonly Pillar[] = [
  {
    title: 'Local, structurally',
    body: 'The grade path makes zero network calls. Not "your data is safe on our servers" — there is no server. Masking, depth, matting, transcription and scene analysis all run as on-device models.',
    proof: 'Enforced as a project invariant, not a setting: any cloud call must be an explicit opt-in fallback and is documented as one.',
  },
  {
    title: 'Free, with nothing behind a wall',
    body: 'No credits, no metering, no tier that unlocks the good masks. The whole app is open source under AGPL-3.0, including the parts a commercial tool would charge for.',
    proof: 'Every capability listed on this page is in the same build. There is no second build.',
  },
  {
    title: 'Deeper agent control than a scripting API',
    body: 'An MCP call and a GUI click run the identical store action, so an agent’s edit moves the real sliders, lands on the same undo stack, and is visible in the app as it happens.',
    proof: `${106} shipped MCP tools spanning the editor and the colorist — including the mask, tracker and grading work that GUI-only scripting APIs cannot reach.`,
  },
  {
    title: 'Determinism you can diff',
    body: 'The grade is a document. Same document plus same frame yields identical pixels — no wall-clock, no unseeded randomness — so a grade can be versioned, reviewed and replayed like code.',
    proof: 'Non-determinism in the render path is treated as a blocker bug, and there is a test that renders a fixture and hashes the output.',
  },
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
