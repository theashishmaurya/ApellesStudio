# notes/audio-export-mixing.md — real audio mixing in `editor_export` (D-197)

See `docs/08-decisions.md` D-197 for the full context/options/verification writeup.
This note is the worked-out technical detail: exactly how gain/duck/fade map onto the
ffmpeg filter graph, for anyone extending `timelineExportAudio.ts` later.

## Files

| file | what it is |
|---|---|
| `packages/editor/src/ffmpegExpr.ts` | `piecewiseLinearExpr` — the shared nested-`if`/`between` ffmpeg expression builder, extracted out of `keyframeExprAt` |
| `packages/editor/src/timelineExportAudio.ts` | all the pure audio math: fade curve solve + sampling, duck one-pole envelope, `atempo` decomposition, `resolveDuckForTrack`, `buildAudioSourceChain` |
| `packages/editor/src/timelineExport.ts` | orchestration: walks tracks/clips, builds `-i` inputs, assembles `amix`/`asoftclip`, the final `-map` |
| `packages/editor/src/editorExport.ts` | the one real caller with store access — resolves `hasAudioOverrides` from the media pool |

## The per-source filter chain

For every audio-contributing source (a video clip's own embedded audio, or a genuine
audio-track clip), `buildAudioSourceChain` builds, in order, only the stages that
actually apply:

```
[N:a] --(atempo, if speed != 1)--> --(volume=eval=frame:volume='gain*fade*duck', if any apply)--> --(adelay, if startSec > 0)--> [label]
```

- **`atempo`** keeps a sped-up clip's audio in sync with its `setpts`-sped picture.
  Decomposed into ffmpeg's documented `[0.5, 2.0]` per-instance chain
  (`atempoFactors`) — the standard technique for anything outside that range.
- **`volume`** folds gain (a plain number), fade (a sampled expression) and duck (an
  exact expression) into ONE filter, multiplied together — mirrors
  `chroma_media::audio::SourceEnvelopes::apply`'s own "one pass, both envelopes, they
  multiply" contract exactly. If NONE of the three apply, this stage is omitted
  entirely (byte-identical to no mixing at all).
- **`adelay=<ms>:all=1`** places the source at its real position on the OUTPUT
  timeline. Omitted for a clip already at frame 0 (no-op).

If literally none of the three stages apply, `buildAudioSourceChain` returns the
caller's own `[N:a]` reference untouched (an `AudioRef` of kind `'raw'`) — no
filter_complex node at all for the common "a plain clip, unity gain, no fade, at
frame 0" case.

## Why `volume` runs AFTER `atempo`

`fade_in_frames`/`fade_out_frames`/`duration` are all in the clip's own **native**
frame rate. Once `atempo` has compressed the audio into the sped-up real-time axis,
`t` inside the `volume` expression is ALREADY in post-speed seconds — so `len`/
`fadeIn`/`fadeOut` are pre-divided by `speed` before building the fade expression,
and the duck expression's session-shift (`t + startSec`) needs no further
compensation, because `startSec` is already the clip's real (post-speed) placement.
Running `volume` BEFORE `atempo` instead would require re-deriving every one of those
three constants in a different unit for no benefit — this ordering is strictly
simpler AND correct, not merely convenient.

## Fade: sampled, not solved

ffmpeg's expression language (`libavutil/eval.c`) has `exp`, `sin`, `pow`, `if`,
`between`, `lt`, etc. — no bezier root-finder. `fadeGainAt` mirrors
`chroma_types::fade_gain`/`FadeCurve::eval`'s exact Newton-Raphson-then-bisection
solve in TypeScript (pinned against the Rust presets' own control points in
`timelineExportAudio.test.ts`). `fadeGainExpr` then samples the REAL, exact
`fadeGainAt` at `FADE_SAMPLE_STEPS` (20) evenly-spaced points across each configured
window, de-duplicates near-identical float samples (a 1ns guard against two windows'
grids landing on the same instant when they overlap), and feeds the points through
`piecewiseLinearExpr`. This is a sampling approximation of the CURVE's continuous
shape — not of the algorithm, which is exact — with error bounded by the sample
count and imperceptible for any fade window a human would actually author (checked in
`timelineExportAudio.test.ts` against the real `fadeGainAt` at unsampled points,
error < 0.01 everywhere tested).

Overlapping fade-in/fade-out windows (`fadeIn + fadeOut > len`, `fade_gain`'s own
documented "the whole clip is a dip" case) are handled for free: every sample point
evaluates the TRUE combined `fadeGainAt`, not one window's contribution alone.

## Duck: exact, because `exp()` exists

`chroma_media::audio::DuckEnvelope`'s one-pole smoother has a genuine closed form:

```
presence(t) = target + (entry - target) * exp(-(t - t0) / tau)      [piecewise, per segment]
gain(t)     = 1 + presence(t) * (dbToLinear(duck_db) - 1)
```

`buildDuckSegments` builds the identical segment list `DuckEnvelope::new` does
(same points construction from trigger spans, same entry-chaining continuity, same
attack-vs-release-by-target selection, same `duck_db === 0`/empty-spans short-
circuits to `null`). `duckGainExpr` emits the IDENTICAL formula as a real ffmpeg
expression, nested the same "last segment innermost" way `piecewiseLinearExpr`
nests a nested if/else, using ffmpeg's real `exp` function — not an approximation.

### Trigger spans: the corrected fps math, not B-079's

`resolveDuckForTrack` needs "which frames does the trigger track sound on," which is
`Track::clip_spans_from` in the Rust model. `docs/BUGS.md`'s B-079 documents that the
LIVE Rust playback path's own version of this still does raw `start_frame + duration`
with no `source_fps` conversion — a real, currently-shipping bug for a mixed-native-
fps timeline. `trackClipSpansFromZero` here uses `endFrame` (`timeline.ts`'s
B-075/B-077/D-194-corrected conversion) instead — deliberately, not accidentally: this
is new code, not a patch to the live mixer B-079 is scoped against, and the export
compiler already needs the corrected conversion anyway to place every clip at its
real timeline position. See D-197's own decision entry for the full "why not just
match B-079" reasoning.

## Mix topology

```
source1 ─┐
source2 ─┼─ amix=inputs=N:duration=longest:normalize=0 ─ asoftclip=type=tanh ─ [outa]
source3 ─┘
```

`normalize=0` is load-bearing: `amix`'s OWN default (`normalize=1`) divides by the
input count, which is not what a real mixer does (louder just because more tracks
exist would be backwards — SOFTER). `asoftclip`'s default `type` is already `tanh`,
so `asoftclip=type=tanh` is a precise, direct reuse of a real ffmpeg filter for the
exact "sum then soft-saturate" topology `chroma_media::audio::mix_sources` documents
for live playback (roadmap's Phase C write-up) — not an invented approximation.

Exactly ONE total audio-contributing clip bypasses `amix`/`asoftclip` entirely,
mapped straight off its own source — mirrors the live mixer's own documented
single-active-source bypass, and keeps the overwhelmingly common "one clip's own
embedded audio, no separate tracks" case byte-simple.

## `hasAudioOverrides` — why it exists and its defaults

`timelineExport.ts` is pure (no I/O). It cannot ask "does this file actually have an
audio stream" — and referencing `[N:a]` for a stream that doesn't exist is a HARD
`-filter_complex` failure ffmpeg cannot recover from (unlike a top-level `-map`,
which has an optional `?` form). `editorExport.ts`'s `compileEditorExportArgs`
resolves this once, real, from the media pool's own probed `MediaVideoInfo.hasAudio`
(D-129), and passes it down as a plain `Record<Clip.id, boolean>`:

| clip kind | `hasAudioOverrides[clip.id]` unset (unprobed / not in pool) |
|---|---|
| `video` (embedded audio) | `false` — fail toward silence, not a broken export |
| `audio` (a real audio-track clip) | `true` — it was placed there on purpose |

## Known, deliberate limits

- No pan/stereo positioning (mono gain scaling only — matches D-057's own scoping).
- No crossfade between two audio clips (`audio-fade-duck-crossfade-plan.md`'s own
  separate, not-yet-built feature).
- No real-signal (RMS) sidechain detection for ducking — the trigger is "does the
  named track have a clip here," matching D-149's own live-playback model exactly.
- `freezeOverrides` (D-188) is video-only. Holding a frozen VIDEO frame has no audio
  analog — a frozen clip's own audio simply ends on its natural schedule.
