# How the grading agent sees its work (and why it must grade by the numbers)

The hard problem: an AI agent doing subjective visual work will glance at a
downscaled preview, pattern-match "yes, that's a graded image," and say "looks
good, nicely balanced" — regardless of whether it is. This note is the design
response.

## Why it happens

Not the token economy — the model is **ungrounded**:

- **Perceptual ceiling.** It sees a 512–1024 px preview. Banding, chroma noise,
  matte halos, a 3-unit channel cast, sharpening crunch — all invisible at that size.
- **No target.** "Is this skin tone right?" has no answer without a reference.
- **Sycophancy.** RLHF pushes toward agreeable. If the prompt frames the grade as
  "warm and filmic," the model confirms that frame.
- **Single-glance absolute judgment.** Humans compare — before/after, A/B, against a
  reference, zoomed to 100%. The model does one holistic pass.

## The response: scopes are ground truth

This is how colorists work too — they don't trust their eyes, they trust the
scopes. The agent gets the same discipline. **Never ask it "does this look
balanced." Give it numbers it can't sycophant away, and make it act on the
measurement.**

| Signal | Grounds |
|---|---|
| Waveform / RGB parade | black point at 0? white ~100? channels level in the neutrals? clipping? |
| Vectorscope | skin on the skin-tone line? whole trace off-centre = global cast |
| Histogram + clip % | crushed / blown, as a percentage |
| Point + region sampler | "RGB at this neutral wall is 34/31/28 → +3 blue cast in the greys" |
| Per-zone means | avg R/G/B in shadows / mids / highs separately |
| Hue histogram | which hues are actually present (orange cluster = skin, cyan = sky) |

The loop: **`render → inspect_color → reason about the numbers → adjust → re-inspect`.**
Palmier's `inspect_color` is built for exactly this ("grade by the numbers instead
of eyeballing"); Chroma's is modelled on it.

## The rest of the toolkit

1. **Always grade toward a reference.** A target still, a neutral patch, or the
   match-shot workflow (the target is another shot). `inspect_color(frame, reference)`
   returns the **gap** + hints that map onto knobs — so the agent adjusts a delta,
   not a vibe.
2. **Comparison, not absolute judgment.** Feed ungraded + graded, or 3 candidates,
   and force a **ranking**. "Which has the most natural skin?" ≫ "is the skin natural?"
3. **Full-res crops, not the preview.** The agent inspects at 100%: a face crop
   (skin, noise, halo), a high-frequency edge (banding, matte halo, over-sharpen),
   the darkest + brightest regions (crushed / blown detail). `screenshot(crop, zoom)`.
4. **Adversarial framing.** Prompt it to *find problems*: "List every artifact,
   cast, or issue. Assume the grade is flawed." Directly counters the agreeable default.
5. **Diff-driven.** After each change, surface the delta — which scope values moved,
   a pixel-diff heatmap. "Exposure −0.3 → waveform top 105 (clipping) → 98 (safe)."
6. **Rubric, evidence required.** Not "is it good" — specific checks, each answered
   from a scope value or a crop: black point set? neutral greys? skin on the line?
   clip %? banding? matte halo? noise floor? Then a summary. Baked into tool
   descriptions: *"Never say 'looks good' without citing a scope value or a named
   region. If you can't verify a claim, say so."*
7. **`request_human(reason, roi)` is a first-class tool.** Creative calls and
   genuine uncertainty get a specific crop + question handed to the person — not a guess.
8. **Temporal consistency is a metric.** Grade flicker / matte crawl: render N
   frames, diff consecutive, flag jumps. The agent can't eyeball 500 frames; it can
   reason about a diff.

## What this means for Chroma's MCP

- **Scope-first by default.** The agent's standard loop is measure → adjust →
  re-measure. The rendered image is for *creative* judgment (often deferred to the
  human); the *technical* calls (balance, black/white point, casts, clipping,
  matte edges) are all scope-driven.
- Every mutating tool returns `{ image, scopes, gap? }` — not just the picture.
- Session/inspect tools mirror Palmier (`get_state`, `inspect`, `inspect_color`,
  `sample`, `capture`) — see `docs/07-mcp-surface.md`.
- Tool descriptions carry the discipline in-band, and a loaded skill / system
  prompt repeats it: *grade by the numbers; cite evidence; find the flaws; defer
  the creative call.*
