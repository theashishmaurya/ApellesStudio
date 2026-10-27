# eval/beats — beat-analysis accuracy (D-413)

How `apelles-beat` was measured. Not a CI gate (it needs the AI env's librosa and audio files
outside the repo); the ground-truth half is pinned in CI by
`crates/apelles-beat/tests/click_tracks.rs`.

```sh
# 1. synthetic metronomes with known beats (clickN.wav + clickN.json)
ai-env/.venv/bin/python -I eval/beats/make_clicks.py /tmp/clicks

# 2. our analysis, one JSON line per file
cargo run -p apelles-beat --example beat_eval -- /tmp/clicks/*.wav > /tmp/ours.jsonl

# 3. librosa on the same files; truth_* fields where a .json sits beside the audio
ai-env/.venv/bin/python -I eval/beats/compare_librosa.py /tmp/ours.jsonl
```

Run step 2 on real music to compare with librosa without ground truth. The 2026-10-27 numbers
(metronomes and the six Black October beds) are in `docs/notes/music-driven-motion.md`.
