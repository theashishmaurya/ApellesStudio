#!/usr/bin/env python3
"""D-374 step 1 — the backend seam must change NOTHING.

Step 1 moved `mlx-whisper` out of `transcribe.py` into `asr/whisper_mlx.py`
behind a Protocol. Its acceptance test is that nothing changed, and the honest
difficulty is that the thing that must not change — the model's output — costs
~15 minutes of GPU per source to reproduce, so it cannot be asserted on every
run. `crates/apelles-speech/tests/fixtures/A001_09122319_C038.json` and
`A001_09122356_C040.json` are verbatim committed Whisper output and are the
reference, but they are segment triples, not full transcripts, and re-deriving
them is step 4's job, not this file's.

So what is pinned here is everything around the model that CAN be proved
without one, which is the whole of what step 1 actually moved:

  1. **the contract shape**, over a scripted backend standing in for a model —
     `{text, language, model, source, segments[{start,end,text,words[]}],
     words[]}`, in that key order, with `words` flattened across segments and
     ABSENT (not empty) when there are none;
  2. **`start_secs` / `duration_secs` shift every timestamp and only the
     timestamps** (D-349, B-216's recovery primitive), including leaving a
     `None` word timing alone rather than computing `None + offset`;
  3. **the whisper backend is still the default**, and asking for no backend,
     the default backend, or no model at all resolves to exactly `large-v3`;
  4. **a whisper job's child argv is byte-for-byte what it was before D-374** —
     `--backend` appears only when it is not the default;
  5. **`server.py`'s two entry points still read the names they always read**
     (`transcribe.DEFAULT_MODEL`, `transcribe.MLX_MODEL_REPOS`), which is what
     "nothing above `transcribe.py` changes" means concretely;
  6. **the validator refuses a malformed backend**, so a bad backend fails at
     its own boundary naming itself, not several layers downstream;
  7. **a language a backend cannot transcribe is refused with the reason named**
     — Parakeet and Hindi, the one measured mismatch D-374 records;
  8. **the moved whisper code is behaviourally identical**, against a STUBBED
     `mlx_whisper` — the same kwargs reach the model (`path_or_hf_repo` resolved
     through B-174's offline path, `word_timestamps`, D-189's
     `condition_on_previous_text=False`, `language` only when it is not
     auto-detect), MLX's global RNG is seeded from `MLX_RANDOM_SEED` BEFORE the
     call (B-224), and a known model result turns into a known contract. This is
     the closest thing to "the fixtures come back byte-identical" that can be
     asserted without 15 minutes of GPU: it pins every line of the transform
     that was moved, leaving only the model itself — which did not change —
     unproven.

Deliberately importable-free of MLX and `parakeet_mlx`: nothing here loads a
weight, so it runs on a plain `python3`. The one check that needs `ffmpeg`
(windowing goes through `extract_audio`) synthesizes its own fixture and skips
when ffmpeg is absent — the same discipline `test_transcribe_errors.py` uses.

    python3 ai-media/test_asr_seam.py
"""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import transcribe as transcribe_mod  # noqa: E402
from asr import BACKENDS, DEFAULT_BACKEND, get_backend, validate_body  # noqa: E402
from asr.base import BackendDescriptor, check_language  # noqa: E402
from errors import UserFacingError  # noqa: E402

# The key order the contract has always had. Asserted as a sequence and not a
# set: this JSON is read by Rust (`app/src-tauri/src/chroma/speech.rs`) and by
# the `@apelles/editor` store, and a stable order is what makes a committed
# transcript diffable at all.
CONTRACT_KEYS = ["text", "language", "model", "source", "segments"]


class _ScriptedBackend:
    """A backend that returns exactly what a test hands it.

    This is what lets the seam be tested without a model: `transcribe()`'s own
    job is everything AROUND the backend, so a scripted backend proves that
    half completely. It is registered into `BACKENDS` for the duration of a
    check and removed in a `finally`.
    """

    def __init__(self, body: dict, descriptor: BackendDescriptor | None = None) -> None:
        self._body = body
        self._descriptor = descriptor or BackendDescriptor(
            name="scripted",
            default_model="scripted-1",
            models=("scripted-1",),
            languages=None,
            language_summary="whatever the test says",
        )
        self.calls: list[dict] = []

    @property
    def descriptor(self) -> BackendDescriptor:
        return self._descriptor

    def transcribe(self, audio_path, *, model, language, word_timestamps):
        self.calls.append(
            {
                "audio_path": audio_path,
                "model": model,
                "language": language,
                "word_timestamps": word_timestamps,
            }
        )
        return json.loads(json.dumps(self._body))  # a fresh copy per call


def _with_backend(name: str, backend, fn):
    previous = BACKENDS.get(name)
    BACKENDS[name] = backend
    try:
        return fn()
    finally:
        if previous is None:
            BACKENDS.pop(name, None)
        else:
            BACKENDS[name] = previous


def _synth(out: Path, args: list[str]) -> bool:
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args, str(out)],
        capture_output=True,
    )
    if proc.returncode != 0:
        print("ffmpeg synthesis failed:", proc.stderr.decode("utf-8", "replace")[-400:])
        return False
    return out.exists()


def _body() -> dict:
    return {
        "text": "In December of last year.",
        "language": "en",
        "segments": [
            {
                "start": 2.04,
                "end": 3.6,
                "text": "In December",
                "words": [
                    {"word": " In", "start": 2.04, "end": 2.88, "probability": 0.912},
                    {"word": " December", "start": 3.04, "end": 3.6},
                ],
            },
            {
                "start": 3.6,
                "end": 5.1,
                "text": "of last year.",
                "words": [
                    {"word": " of", "start": 3.6, "end": 3.76},
                    # A word with no timing at all — a real mlx-whisper
                    # possibility, and the reason `_shift` exists in the shape
                    # it does.
                    {"word": " last", "start": None, "end": None},
                    {"word": " year.", "start": 4.24, "end": 5.1},
                ],
            },
        ],
    }


def check_contract_shape(audio: Path) -> None:
    backend = _ScriptedBackend(_body())
    got = _with_backend(
        "scripted",
        backend,
        lambda: transcribe_mod.transcribe(str(audio), backend="scripted"),
    )

    assert list(got) == CONTRACT_KEYS + ["words"], list(got)
    assert got["text"] == "In December of last year.", got["text"]
    assert got["language"] == "en", got["language"]
    assert got["model"] == "scripted-1", got["model"]
    assert got["source"] == str(audio), got["source"]
    assert "window" not in got, "a whole-file pass must not carry a window"

    for seg in got["segments"]:
        assert list(seg) == ["start", "end", "text", "words"], list(seg)
    assert list(got["segments"][0]["words"][0]) == [
        "word", "start", "end", "probability",
    ], got["segments"][0]["words"][0]

    # `words` is the flattened list across EVERY segment, in order, and holds
    # the same entries the segments do.
    flat = got["words"]
    assert [w["word"] for w in flat] == [" In", " December", " of", " last", " year."], flat
    assert flat[0] is got["segments"][0]["words"][0], "words must not be a second copy"

    # The backend got exactly what it is supposed to get: one prepared audio
    # path, the resolved model, and no knowledge of windowing.
    assert backend.calls == [
        {
            "audio_path": str(audio),
            "model": "scripted-1",
            "language": None,
            "word_timestamps": True,
        }
    ], backend.calls
    print("ok: the contract's shape, key order and flattened `words` are unchanged")

    # No words at all → `words` is ABSENT, not an empty list. Downstream reads
    # `"words" in result`, so an empty list would read as "the model gave us
    # word timings and they were none of them."
    bare = {"text": "x", "language": "en", "segments": [{"start": 0.0, "end": 1.0, "text": "x", "words": []}]}
    got = _with_backend(
        "scripted",
        _ScriptedBackend(bare),
        lambda: transcribe_mod.transcribe(str(audio), backend="scripted"),
    )
    assert "words" not in got, got
    assert list(got) == CONTRACT_KEYS, list(got)
    print("ok: no word timings → no `words` key at all, not an empty one")


def check_window_shift(tmp: Path) -> None:
    """D-349: every timestamp shifts by `start_secs`, nothing else does."""
    audio = tmp / "tone.wav"
    if not _synth(audio, ["-f", "lavfi", "-i", "sine=frequency=440:duration=3"]):
        print("skip: could not synthesize the audio fixture")
        return

    backend = _ScriptedBackend(_body())
    got = _with_backend(
        "scripted",
        backend,
        lambda: transcribe_mod.transcribe(
            str(audio), backend="scripted", start_secs=100.5, duration_secs=30.0
        ),
    )

    assert got["window"] == {"start_secs": 100.5, "duration_secs": 30.0}, got["window"]
    assert list(got) == CONTRACT_KEYS[:4] + ["window", "segments", "words"], list(got)

    assert [(s["start"], s["end"]) for s in got["segments"]] == [
        (102.54, 104.1),
        (104.1, 105.6),
    ], got["segments"]
    assert [(w["start"], w["end"]) for w in got["words"]] == [
        (102.54, 103.38),
        (103.54, 104.1),
        (104.1, 104.26),
        (None, None),  # an un-timed word stays un-timed; `None + offset` is a crash
        (104.74, 105.6),
    ], got["words"]
    assert got["words"][0]["probability"] == 0.912, "a shift must not touch a probability"
    assert got["segments"][0]["text"] == "In December", "a shift must not touch text"

    # The backend was handed a CUT WINDOW, not the source, and does not know it.
    assert len(backend.calls) == 1, backend.calls
    assert backend.calls[0]["audio_path"] != str(audio), backend.calls[0]
    assert backend.calls[0]["audio_path"].endswith(".wav"), backend.calls[0]
    assert not Path(backend.calls[0]["audio_path"]).exists(), "the window WAV outlived the call"
    print("ok: a window shifts every timestamp by start_secs and nothing else")


def check_default_is_whisper(audio: Path) -> None:
    assert DEFAULT_BACKEND == "whisper", DEFAULT_BACKEND
    for asked in (None, "whisper"):
        descriptor = get_backend(asked).descriptor
        assert descriptor.name == "whisper", (asked, descriptor.name)
        assert descriptor.require_model(None) == "large-v3", asked
    assert transcribe_mod.DEFAULT_MODEL == "large-v3", transcribe_mod.DEFAULT_MODEL

    # An unknown backend is a caller bug, not a sentence for a user.
    try:
        get_backend("wav2vec")
    except UserFacingError as e:
        raise AssertionError(f"an unknown backend must not be user-facing: {e}")
    except ValueError as e:
        assert "wav2vec" in str(e) and "whisper" in str(e), str(e)
    else:
        raise AssertionError("an unknown backend did not raise")

    # So is an unknown model, and the message names the backend it is not in.
    try:
        get_backend("parakeet").descriptor.require_model("large-v3")
    except ValueError as e:
        assert "parakeet" in str(e) and "large-v3" in str(e), str(e)
    else:
        raise AssertionError("a cross-backend model name did not raise")
    print("ok: whisper is still the default, and large-v3 still its default model")


def check_argv_unchanged(audio: Path) -> None:
    """A whisper job's child argv is byte-for-byte pre-D-374."""
    cmd = transcribe_mod._subprocess_cmd(str(audio), "large-v3", "en", True, "/tmp/out.json")
    assert cmd[2:] == [
        "--audio", str(audio),
        "--model", "large-v3",
        "--output", "/tmp/out.json",
        "--language", "en",
    ], cmd[2:]
    assert "--backend" not in cmd, cmd

    explicit = transcribe_mod._subprocess_cmd(
        str(audio), "large-v3", "en", True, "/tmp/out.json", None, None, "whisper"
    )
    assert explicit == cmd, "naming the default backend must not change the argv"

    other = transcribe_mod._subprocess_cmd(
        str(audio), "parakeet-tdt-0.6b-v3", None, True, "/tmp/out.json", None, None, "parakeet"
    )
    assert other[-2:] == ["--backend", "parakeet"], other
    print("ok: --backend appears only when it is not the default")


def check_server_names(audio: Path) -> None:
    """"Nothing above `transcribe.py` changes" — concretely."""
    assert transcribe_mod.MLX_MODEL_REPOS[transcribe_mod.DEFAULT_MODEL] == (
        "mlx-community/whisper-large-v3-mlx"
    ), transcribe_mod.MLX_MODEL_REPOS[transcribe_mod.DEFAULT_MODEL]
    assert list(transcribe_mod.MLX_MODEL_REPOS) == [
        "tiny", "base", "small", "medium", "large-v2", "large-v3", "large",
        "distil-large-v3",
    ], list(transcribe_mod.MLX_MODEL_REPOS)

    try:
        import server
    except ImportError as e:
        print(f"skip: server needs fastapi, not installed here ({e})")
        return
    assert server.TranscribeReq(path=str(audio)).model == "large-v3"
    print("ok: server.py's model default and repo map read exactly as before")


def check_validator() -> None:
    """A backend that breaks the contract fails at its own boundary."""
    good = _body()
    assert validate_body(json.loads(json.dumps(good)), backend="x") is not None

    broken = [
        ("not a dict", []),
        ("no text", {"language": "en", "segments": []}),
        ("no language", {"text": "x", "segments": []}),
        ("no segments", {"text": "x", "language": "en"}),
        ("segments not a list", {"text": "x", "language": "en", "segments": {}}),
        (
            "segment missing words",
            {"text": "x", "language": "en", "segments": [{"start": 0, "end": 1, "text": "x"}]},
        ),
        (
            "segment ends before it starts",
            {
                "text": "x",
                "language": "en",
                "segments": [{"start": 5.0, "end": 1.0, "text": "x", "words": []}],
            },
        ),
        (
            "segment start is not a number",
            {
                "text": "x",
                "language": "en",
                "segments": [{"start": "0", "end": 1.0, "text": "x", "words": []}],
            },
        ),
        (
            "word missing end",
            {
                "text": "x",
                "language": "en",
                "segments": [
                    {
                        "start": 0.0,
                        "end": 1.0,
                        "text": "x",
                        "words": [{"word": " x", "start": 0.0}],
                    }
                ],
            },
        ),
    ]
    for label, body in broken:
        try:
            validate_body(body, backend="scripted")
        except ValueError as e:
            assert "scripted" in str(e), f"{label}: the message must name the backend — {e}"
        else:
            raise AssertionError(f"the validator accepted {label!r}")
    print(f"ok: the validator rejects {len(broken)} malformed bodies, each naming the backend")


def check_language_refusal(audio: Path) -> None:
    """The one measured mismatch D-374 records: Parakeet has no Hindi."""
    parakeet = get_backend("parakeet").descriptor
    assert "hi" not in parakeet.languages, "Parakeet must not claim Hindi"
    assert "en" in parakeet.languages and "de" in parakeet.languages
    assert len(parakeet.languages) == 25, len(parakeet.languages)

    for language in ("hi", "HI", "hi-IN", "ja", "zh"):
        try:
            check_language(parakeet, language)
        except UserFacingError as e:
            message = str(e)
            assert language in message, message
            assert "25 European languages" in message, message
            assert "whisper" in message, message
            for leak in ("Traceback", "Error:", "None"):
                assert leak not in message, f"the sentence leaks {leak!r}: {message}"
        else:
            raise AssertionError(f"parakeet accepted {language!r}")

    # Auto-detect is a request, not a claim, and is never refused.
    for language in (None, "", "auto"):
        check_language(parakeet, language)
    # Nor is anything inside the set, in either case.
    for language in ("en", "EN", "pt-BR", "uk"):
        check_language(parakeet, language)

    # Whisper is unconstrained — Hinglish is its own documented promise.
    whisper = get_backend("whisper").descriptor
    assert whisper.languages is None
    for language in ("hi", "en", "auto", None, "xx"):
        check_language(whisper, language)

    # And the refusal happens BEFORE any model is reached, which is what makes
    # it safe to assert here with nothing installed.
    try:
        transcribe_mod.transcribe(str(audio), language="hi", backend="parakeet")
    except UserFacingError as e:
        assert "25 European languages" in str(e), str(e)
    else:
        raise AssertionError("transcribe() ran parakeet on Hindi")
    print("ok: Hindi on parakeet is refused with the reason named, before the model loads")


class _FakeModule:
    def __init__(self, **attrs) -> None:
        self.__dict__.update(attrs)


def check_whisper_equivalence(audio: Path) -> None:
    """The moved whisper code, against a stubbed `mlx_whisper`.

    `mlx_whisper.transcribe`'s own output shape is public and stable, so a
    scripted return value is a faithful stand-in: what is being proved is the
    kwargs going IN and the contract coming OUT, which is the entirety of what
    D-374 step 1 moved out of `transcribe.py`.
    """
    seeds: list[int] = []
    calls: list[tuple[str, dict]] = []

    # What mlx-whisper really returns: a leading space on every word, segment
    # text with its own leading space, an un-rounded probability, and a `words`
    # list per segment.
    model_result = {
        "text": " In December of last year.",
        "language": "en",
        "segments": [
            {
                "id": 0,
                "seek": 0,
                "start": 2.04,
                "end": 5.1,
                "text": " In December of last year.",
                "tokens": [50364, 682],
                "temperature": 0.0,
                "avg_logprob": -0.21,
                "compression_ratio": 1.4,
                "no_speech_prob": 0.02,
                "words": [
                    {"word": " In", "start": 2.04, "end": 2.88, "probability": 0.9123456},
                    {"word": " December", "start": 3.04, "end": 3.6, "probability": 0.5},
                    {"word": " of", "start": 3.6, "end": 3.76, "probability": 0.98765},
                    {"word": " last", "start": 3.76, "end": 4.0, "probability": 0.5005},
                    {"word": " year.", "start": 4.24, "end": 5.1, "probability": 0.25},
                ],
            },
            # A segment with no words at all is legal and must survive with an
            # empty list rather than being dropped.
            {"start": 6.0, "end": 6.5, "text": " Mm.", "words": []},
        ],
    }

    fake_whisper = _FakeModule(
        transcribe=lambda path, **kwargs: (calls.append((path, kwargs)), model_result)[1]
    )
    fake_core = _FakeModule(random=_FakeModule(seed=seeds.append))
    fake_mlx = _FakeModule(core=fake_core)

    saved = {name: sys.modules.get(name) for name in ("mlx_whisper", "mlx", "mlx.core")}
    sys.modules["mlx_whisper"] = fake_whisper
    sys.modules["mlx"] = fake_mlx
    sys.modules["mlx.core"] = fake_core
    try:
        got = transcribe_mod.transcribe(str(audio), language="en")
        auto = transcribe_mod.transcribe(str(audio), model="tiny", word_timestamps=False)
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module

    # --- the kwargs that reach the model -----------------------------------
    assert len(calls) == 2, calls
    path, kwargs = calls[0]
    assert path == str(audio), path
    assert kwargs == {
        # B-174: the cached snapshot path, not the bare repo id. This machine may
        # or may not have it cached, so both answers are accepted — what matters
        # is that it went through the resolver.
        "path_or_hf_repo": kwargs["path_or_hf_repo"],
        "word_timestamps": True,
        "condition_on_previous_text": False,
        "language": "en",
    }, kwargs
    resolved = kwargs["path_or_hf_repo"]
    assert resolved == "mlx-community/whisper-large-v3-mlx" or Path(resolved).is_dir(), resolved

    # auto-detect is the ABSENCE of the kwarg, exactly as before D-374
    _, auto_kwargs = calls[1]
    assert "language" not in auto_kwargs, auto_kwargs
    assert auto_kwargs["word_timestamps"] is False, auto_kwargs
    assert auto_kwargs["condition_on_previous_text"] is False, auto_kwargs

    # --- B-224: seeded once per run, before the model is called ------------
    from asr.whisper_mlx import MLX_RANDOM_SEED

    assert seeds == [MLX_RANDOM_SEED, MLX_RANDOM_SEED], seeds
    assert MLX_RANDOM_SEED == 0, MLX_RANDOM_SEED

    # --- the contract that comes out ---------------------------------------
    assert got == {
        # stripped, as it has always been
        "text": "In December of last year.",
        "language": "en",
        "model": "large-v3",
        "source": str(audio),
        "segments": [
            {
                "start": 2.04,
                "end": 5.1,
                "text": "In December of last year.",
                "words": [
                    # probability rounded to 3, timestamps untouched at offset 0
                    {"word": " In", "start": 2.04, "end": 2.88, "probability": 0.912},
                    {"word": " December", "start": 3.04, "end": 3.6, "probability": 0.5},
                    {"word": " of", "start": 3.6, "end": 3.76, "probability": 0.988},
                    {"word": " last", "start": 3.76, "end": 4.0, "probability": 0.5},
                    {"word": " year.", "start": 4.24, "end": 5.1, "probability": 0.25},
                ],
            },
            {"start": 6.0, "end": 6.5, "text": "Mm.", "words": []},
        ],
        "words": [
            {"word": " In", "start": 2.04, "end": 2.88, "probability": 0.912},
            {"word": " December", "start": 3.04, "end": 3.6, "probability": 0.5},
            {"word": " of", "start": 3.6, "end": 3.76, "probability": 0.988},
            {"word": " last", "start": 3.76, "end": 4.0, "probability": 0.5},
            {"word": " year.", "start": 4.24, "end": 5.1, "probability": 0.25},
        ],
    }, json.dumps(got, indent=1)
    assert auto["model"] == "tiny", auto["model"]
    print("ok: the moved whisper code passes the same kwargs and builds the same contract")


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="chroma_d374_seam_"))
    try:
        audio = tmp / "clip.wav"
        audio.write_bytes(b"fixture")

        check_contract_shape(audio)
        check_default_is_whisper(audio)
        check_argv_unchanged(audio)
        check_server_names(audio)
        check_validator()
        check_language_refusal(audio)
        check_whisper_equivalence(audio)
        if shutil.which("ffmpeg") is None:
            print("skip: ffmpeg not on PATH — the windowing check needs it")
        else:
            check_window_shift(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("all D-374 step-1 seam checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
