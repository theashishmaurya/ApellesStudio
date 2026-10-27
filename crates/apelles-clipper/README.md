# apelles-clipper

**L2 — the Automatic Clipper's mechanics (D-411).** Everything deterministic about
cutting shorts from one long source, over data it is handed. Design:
`docs/notes/automatic-clipper.md`; decisions and build notes: D-411.

| module | does |
|---|---|
| `sentence` | the word view cut into sentences (a final mark, a 0.6 s pause, a piece edge; run-ons over 15 s split at their longest pause or a comma) |
| `topic` | TextTiling topic breaks (Hearst 1997), deepened by long pauses, cuts between pieces and picture cuts |
| `features` | evidence tags: question, number, "you", contrast/stakes words, imperative opener, short, a context-dependent opener, lands / ends tight / runs on, pace and loudness against the speaker's medians, picture cuts, focus words, retakes |
| `candidate` | every clean, in-length window per (start sentence, target length) inside one topic, each already passing the gate — listed in source order, never ranked |
| `gate` | the clean-cut gate: refusals (`ClipRefusal`) and warnings (`ClipWarning`) with offending word indices; padding of outer edges; per-piece resolution of a segment into source ranges |
| `tighten` | the dead air (pauses ≥ 0.6 s → 0.25 s, never where the VAD hears missed speech) and reviewed retakes a build cuts inside each range |
| `view` | the numbered moment view, its paging, its identity text (what the view id hashes) and the served `JUDGING_RULES` (versioned, not yet measured) |
| `run` | the persisted clip run schema (`clips/<run-id>.json`, written by `apelles-project`) |
| `analysis` | one pure pass: view in, all of the above out (milliseconds for an hour) |

## Boundary

- **Picks nothing.** Owner decision (D-411, 2026-10-27): the MCP client is the only
  judge. No score, no ranking, no heuristic pick — tags are facts that read back to
  words.
- **Reads no file, runs no model.** Words come from `apelles-speech`'s word view (the
  indexing the retake and music-edit tools share); VAD speech spans, loudness and
  picture cuts are measured by the app (`chroma::clipper`, `apelles_media::scenes`)
  and handed in.
- **Builds nothing.** A gated proposal resolves to source ranges and cut lists; the
  Edit tab builds the timeline (`packages/editor/src/clipper/clipBuild.ts`).

Deps: `apelles-speech` (word view, stopwords), `serde`, `thiserror`. No external crates.

## Verifying it

```sh
cargo test -p apelles-clipper                                   # units + gate refusals + paging + run schema
cargo test -p apelles-clipper --test clipper_eval -- --nocapture # eval/clipper: 0 violations, speed
cargo run -p apelles-clipper --example render_moment_view -- <transcript.json> 30 60
```
