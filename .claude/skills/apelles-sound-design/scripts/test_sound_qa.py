"""Fixture check for sound_qa.py's timeline selection and frame rate (B-331).

What it is: a unittest module (run `python3 -m unittest test_sound_qa` from this folder).
What it does: builds a two-timeline project on disk (a backup "Voiceover" at 24 fps, the working
"Voiceover v2" at 30 fps, project default 24 fps) and checks that the report reads the active or
the named timeline, at that timeline's own rate.
What it does NOT do: measure audio (no ffmpeg needed).
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from sound_qa import load_audio_tracks, select_timeline, timeline_fps


def clip(start_frame: int, duration: int, name: str = "bed") -> dict:
    return {"name": name, "start_frame": start_frame, "duration": duration, "source_path": f"/m/{name}.mp3"}


def timeline(tid: str, name: str, num: int, clips: list[dict]) -> dict:
    return {
        "id": tid,
        "name": name,
        "rate": {"num": num, "den": 1},
        "tracks": [{"kind": "video", "clips": []}, {"kind": "audio", "clips": clips}],
    }


def project(active) -> dict:
    return {
        "settings": {"fps": 24.0},
        "activeTimeline": active,
        "timelines": [
            timeline("tl-a", "Voiceover", 24, [clip(240, 480)]),
            timeline("tl-b", "Voiceover v2", 30, [clip(300, 600)]),
        ],
    }


def write(doc: dict) -> Path:
    root = Path(tempfile.mkdtemp()) / "p.chroma"
    root.mkdir()
    (root / "project.json").write_text(json.dumps(doc))
    return root


class SoundQaTimeline(unittest.TestCase):
    def test_active_index_reads_that_timeline_at_its_own_rate(self):
        fps, name, tracks = load_audio_tracks(write(project(1)))
        self.assertEqual((fps, name), (30.0, "Voiceover v2"))
        # Frame 300 at 30 fps is 10.0 s, not 12.5 s (the 24 fps project default).
        self.assertAlmostEqual(tracks[0]["clips"][0]["start"], 10.0)

    def test_active_timeline_id_string_is_resolved_not_ignored(self):
        fps, name, _ = load_audio_tracks(write(project("tl-b")))
        self.assertEqual((fps, name), (30.0, "Voiceover v2"))

    def test_timeline_option_by_id_name_and_index(self):
        root = write(project(0))
        for selector in ("tl-b", "Voiceover v2", "1"):
            fps, name, _ = load_audio_tracks(root, selector)
            self.assertEqual((fps, name), (30.0, "Voiceover v2"), selector)
        fps, name, _ = load_audio_tracks(root, "Voiceover")
        self.assertEqual((fps, name), (24.0, "Voiceover"))

    def test_unknown_timeline_is_an_error_not_the_first_timeline(self):
        with self.assertRaises(SystemExit):
            select_timeline(project(0), "nope")
        with self.assertRaises(SystemExit):
            select_timeline(project(7))

    def test_rate_falls_back_to_a_plain_fps_then_the_project_default(self):
        self.assertEqual(timeline_fps({"rate": {"num": 30000, "den": 1001}}, 24.0), 30000 / 1001)
        self.assertEqual(timeline_fps({"fps": 25}, 24.0), 25.0)
        self.assertEqual(timeline_fps({"rate": None}, 24.0), 24.0)


if __name__ == "__main__":
    unittest.main()
