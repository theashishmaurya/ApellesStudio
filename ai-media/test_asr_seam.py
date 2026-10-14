#!/usr/bin/env python3
"""D-374 / D-381 — the ASR backend seam, proved without a model.

The seam (`asr/`) puts every speech-to-text model behind one contract and keeps
everything that is not the model in `transcribe.py`. Since D-381 one backend
sits behind it — Parakeet — and the seam stays so another can be added; so this
file proves the seam over TWO backends: a scripted stub (which proves the
seam is a seam and not a Parakeet wrapper) and the real Parakeet backend
against a stubbed `parakeet_mlx` (which proves the one real backend's glue).

What a model costs to run is minutes of GPU per source, so what is pinned here
is everything around the model that CAN be proved without one:

  1. **the contract shape**, over a scripted backend standing in for a model —
     `{text, language, model, source, segments[{start,end,text,words[]}],
     words[]}`, in that key order, with `words` flattened across segments and
     ABSENT (not empty) when there are none;
  2. **`start_secs` / `duration_secs` shift every timestamp and only the
     timestamps** (D-349, B-216's recovery primitive), including leaving a
     `None` word timing alone rather than computing `None + offset`;
  3. **Parakeet is the default and the only registered backend** (D-381), and
     asking for no backend, the default backend, or no model at all resolves to
     exactly `parakeet-tdt-0.6b-v3`; a decommissioned Whisper model or backend
     name is refused, naming what IS supported;
  4. **a default job's child argv carries no `--backend`**, and a non-default
     backend (the stub, registered for the check) adds it;
  5. **`server.py` reads the default backend's descriptor** — its request
     default, its validation list and `/health`'s repo all come from it;
  6. **the validator refuses a malformed backend**, so a bad backend fails at
     its own boundary naming itself, not several layers downstream;
  7. **a language Parakeet cannot transcribe is refused with the reason
     named** — Hindi, the one measured mismatch D-374 records, now unsupported
     outright (D-381), with no pointer to a backend that no longer exists;
  8. **the Parakeet backend's glue against a STUBBED `parakeet_mlx`** — the
     model loads through B-174's offline path resolver, `transcribe` gets the
     measured chunking, the sentence/token tree becomes the merged, segmented
     contract, `word_timestamps=False` empties the word lists, **no RNG is
     seeded** (greedy TDT — D-381 retired Whisper's B-224 seed), and a missing
     `parakeet_mlx` (an environment that predates D-381) is a sentence naming
     the fix, not a `ModuleNotFoundError`.

Deliberately free of MLX and `parakeet_mlx`: nothing here loads a weight, so it
runs on a plain `python3`. The one check that needs `ffmpeg` (windowing goes
through `extract_audio`) synthesizes its own fixture and skips when ffmpeg is
absent — the same discipline `test_transcribe_errors.py` uses.

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
from asr import parakeet_mlx as parakeet_backend  # noqa: E402
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
            model_repos={"scripted-1": "scripted/never-loaded"},
            languages=None,
            language_summary="whatever the test says",
            # D-375: the dark-region cross-check's too-long-word bound. `None`
            # is "the bound does not apply to this backend", which is the
            # honest answer for a scripted one that emits whatever the test
            # hands it.
            max_word_secs=None,
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
                    # A word with no timing at all — the contract allows it
                    # (mlx-whisper emitted them), and it is the reason `_shift`
                    # exists in the shape it does.
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


def check_default_is_parakeet(audio: Path) -> None:
    assert DEFAULT_BACKEND == "parakeet", DEFAULT_BACKEND
    assert list(BACKENDS) == ["parakeet"], list(BACKENDS)
    for asked in (None, "parakeet"):
        descriptor = get_backend(asked).descriptor
        assert descriptor.name == "parakeet", (asked, descriptor.name)
        assert descriptor.require_model(None) == "parakeet-tdt-0.6b-v3", asked
        assert descriptor.models == ("parakeet-tdt-0.6b-v3",), descriptor.models

    # The decommissioned backend is an unknown backend now — a caller bug, not a
    # sentence for a user — and the message names what is supported.
    for gone in ("whisper", "wav2vec"):
        try:
            get_backend(gone)
        except UserFacingError as e:
            raise AssertionError(f"an unknown backend must not be user-facing: {e}")
        except ValueError as e:
            assert gone in str(e) and "parakeet" in str(e), str(e)
        else:
            raise AssertionError(f"backend {gone!r} did not raise")

    # So is a Whisper model name, and the message names the backend it is not in.
    for gone in ("large-v3", "distil-large-v3"):
        try:
            get_backend(None).descriptor.require_model(gone)
        except ValueError as e:
            assert "parakeet" in str(e) and gone in str(e), str(e)
        else:
            raise AssertionError(f"the decommissioned model {gone!r} did not raise")
    print("ok: parakeet is the default and only backend; whisper's names are refused")


def check_argv(audio: Path) -> None:
    """A default job's argv names only what the caller chose."""
    cmd = transcribe_mod._subprocess_cmd(
        str(audio), "parakeet-tdt-0.6b-v3", "en", True, "/tmp/out.json"
    )
    assert cmd[2:] == [
        "--audio", str(audio),
        "--model", "parakeet-tdt-0.6b-v3",
        "--output", "/tmp/out.json",
        "--language", "en",
    ], cmd[2:]
    assert "--backend" not in cmd, cmd

    explicit = transcribe_mod._subprocess_cmd(
        str(audio), "parakeet-tdt-0.6b-v3", "en", True, "/tmp/out.json", None, None, "parakeet"
    )
    assert explicit == cmd, "naming the default backend must not change the argv"

    # The seam's other half: a backend that is not the default is named.
    other = _with_backend(
        "scripted",
        _ScriptedBackend(_body()),
        lambda: transcribe_mod._subprocess_cmd(
            str(audio), "scripted-1", None, True, "/tmp/out.json", None, None, "scripted"
        ),
    )
    assert other[-2:] == ["--backend", "scripted"], other
    print("ok: --backend appears only when it is not the default")


def check_server_names(audio: Path) -> None:
    """`server.py` reads the default backend's descriptor, nothing else."""
    descriptor = get_backend(None).descriptor
    assert descriptor.model_repos[descriptor.default_model] == (
        "mlx-community/parakeet-tdt-0.6b-v3"
    ), descriptor.model_repos
    for gone in ("DEFAULT_MODEL", "MLX_MODEL_REPOS"):
        assert not hasattr(transcribe_mod, gone), f"transcribe.{gone} is Whisper's and must be gone"

    try:
        import server
    except ImportError as e:
        print(f"skip: server needs fastapi, not installed here ({e})")
        return
    assert server.TranscribeReq(path=str(audio)).model == "parakeet-tdt-0.6b-v3"
    assert server.health()["models"]["transcribe"] == "mlx-community/parakeet-tdt-0.6b-v3"
    refused = server.start_transcribe(server.TranscribeReq(path=str(audio), model="large-v3"))
    assert "large-v3" in refused.get("error", "") and "parakeet-tdt-0.6b-v3" in refused["error"], refused
    print("ok: server.py's model default, validation and /health come from the descriptor")


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
    """The one measured mismatch D-374 records: Parakeet has no Hindi, and since
    D-381 nothing else does either."""
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
            assert "not supported" in message, message
            # No pointer to a backend that no longer exists.
            assert "whisper" not in message.lower(), message
            for leak in ("Traceback", "Error:", "None"):
                assert leak not in message, f"the sentence leaks {leak!r}: {message}"
        else:
            raise AssertionError(f"parakeet accepted {language!r}")

    # "Let the model decide" is a request, not a claim, and is never refused.
    for language in (None, "", "auto"):
        check_language(parakeet, language)
    # Nor is anything inside the set, in either case.
    for language in ("en", "EN", "pt-BR", "uk"):
        check_language(parakeet, language)

    # An unconstrained backend (the stub) refuses nothing — the seam still
    # carries that case for a future multilingual backend.
    unconstrained = _ScriptedBackend(_body()).descriptor
    assert unconstrained.languages is None
    for language in ("hi", "en", "auto", None, "xx"):
        check_language(unconstrained, language)

    # And the refusal happens BEFORE any model is reached, which is what makes
    # it safe to assert here with nothing installed.
    try:
        transcribe_mod.transcribe(str(audio), language="hi")
    except UserFacingError as e:
        assert "25 European languages" in str(e), str(e)
    else:
        raise AssertionError("transcribe() ran parakeet on Hindi")
    print("ok: Hindi is refused as unsupported, with the reason named, before the model loads")


class _FakeModule:
    def __init__(self, **attrs) -> None:
        self.__dict__.update(attrs)


def _stub_modules(stubs: dict, fn):
    """Run `fn` with `sys.modules` entries replaced, restoring them after."""
    saved = {name: sys.modules.get(name) for name in stubs}
    for name, module in stubs.items():
        if module is None:
            sys.modules[name] = None  # makes `import name` raise ImportError
        else:
            sys.modules[name] = module
    try:
        return fn()
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


def check_parakeet_glue(audio: Path) -> None:
    """The Parakeet backend against a stubbed `parakeet_mlx`.

    `test_asr_parakeet.py` proves the two pure functions (token merge, gap
    segmentation). This proves the glue around them that only a model run would
    otherwise exercise: what reaches `from_pretrained` and `transcribe`, how the
    library's sentence/token tree becomes tokens, and what comes out — the
    shape `parakeet_mlx` 0.5.3 really returns (`AlignedResult.sentences[i]
    .tokens[j]` with `text`/`start`/`end`), including D-376's late
    punctuation token.
    """
    loads: list[str] = []
    calls: list[tuple[str, dict]] = []
    seeds: list[int] = []

    def tok(text, start, end):
        return _FakeModule(text=text, start=start, end=end)

    result = _FakeModule(
        sentences=[
            _FakeModule(tokens=[
                tok(" In", 2.04, 2.36),
                tok(" De", 3.04, 3.12), tok("cem", 3.12, 3.36), tok("ber", 3.36, 3.6),
                # D-376: a full stop timestamped 6 s later — keeps its text,
                # loses its vote on the word's end.
                tok(".", 9.6, 9.68),
            ]),
            # A 0.32 s gap (SEGMENT_GAP_S) after `December` starts a new segment.
            _FakeModule(tokens=[tok(" Next", 10.0, 10.24), tok(" year", 10.24, 10.56)]),
        ]
    )

    class _Model:
        def transcribe(self, path, **kwargs):
            calls.append((path, kwargs))
            return result

    def from_pretrained(path_or_repo):
        loads.append(path_or_repo)
        return _Model()

    stubs = {
        "parakeet_mlx": _FakeModule(from_pretrained=from_pretrained),
        # Present so that a seed call, if anything made one, would be recorded
        # rather than crash — the assertion is that none is made.
        "mlx": _FakeModule(core=_FakeModule(random=_FakeModule(seed=seeds.append))),
    }
    stubs["mlx.core"] = stubs["mlx"].core

    got = _stub_modules(stubs, lambda: transcribe_mod.transcribe(str(audio), language="en"))
    bare = _stub_modules(
        stubs, lambda: transcribe_mod.transcribe(str(audio), word_timestamps=False)
    )

    # --- what reached the library ------------------------------------------
    assert len(loads) == 2, loads
    # B-174: the cached snapshot path, not the bare repo id, when this machine
    # has it cached; the bare id otherwise. Either way it went through the
    # resolver and named the right model.
    for loaded in loads:
        assert loaded == "mlx-community/parakeet-tdt-0.6b-v3" or Path(loaded).is_dir(), loaded
    assert calls[0] == (
        str(audio),
        {
            "chunk_duration": parakeet_backend.CHUNK_DURATION_S,
            "overlap_duration": parakeet_backend.OVERLAP_DURATION_S,
        },
    ), calls[0]
    # Greedy TDT, no sampling: nothing seeds an RNG (B-224's seed went with Whisper).
    assert seeds == [], seeds

    # --- the contract that comes out ---------------------------------------
    december = {"word": " December.", "start": 3.04, "end": 3.6}
    assert got == {
        "text": "In December. Next year",
        # Parakeet takes no language and reports none; the asked-for one is
        # passed through, never invented.
        "language": "en",
        "model": "parakeet-tdt-0.6b-v3",
        "source": str(audio),
        "segments": [
            {"start": 2.04, "end": 2.36, "text": "In",
             "words": [{"word": " In", "start": 2.04, "end": 2.36}]},
            {"start": 3.04, "end": 3.6, "text": "December.", "words": [december]},
            {"start": 10.0, "end": 10.56, "text": "Next year",
             "words": [{"word": " Next", "start": 10.0, "end": 10.24},
                       {"word": " year", "start": 10.24, "end": 10.56}]},
        ],
        "words": [
            {"word": " In", "start": 2.04, "end": 2.36},
            december,
            {"word": " Next", "start": 10.0, "end": 10.24},
            {"word": " year", "start": 10.24, "end": 10.56},
        ],
    }, json.dumps(got, indent=1)

    # Auto-detect reports "unknown"; no word timings → segments kept, `words` absent.
    assert bare["language"] == "unknown", bare["language"]
    assert "words" not in bare and all(s["words"] == [] for s in bare["segments"]), bare
    assert [s["text"] for s in bare["segments"]] == ["In", "December.", "Next year"], bare

    # --- an environment that predates D-381 --------------------------------
    try:
        _stub_modules({"parakeet_mlx": None}, lambda: transcribe_mod.transcribe(str(audio)))
    except UserFacingError as e:
        message = str(e)
        assert "parakeet-mlx" in message and "ai-env/setup.sh" in message, message
        for leak in ("ModuleNotFoundError", "Traceback", "ImportError"):
            assert leak not in message, f"the sentence leaks {leak!r}: {message}"
    else:
        raise AssertionError("a missing parakeet_mlx did not raise")
    print("ok: the parakeet backend's glue loads offline, chunks as measured, seeds nothing")


def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="chroma_d374_seam_"))
    try:
        audio = tmp / "clip.wav"
        audio.write_bytes(b"fixture")

        check_contract_shape(audio)
        check_default_is_parakeet(audio)
        check_argv(audio)
        check_server_names(audio)
        check_validator()
        check_language_refusal(audio)
        check_parakeet_glue(audio)
        if shutil.which("ffmpeg") is None:
            print("skip: ffmpeg not on PATH — the windowing check needs it")
        else:
            check_window_shift(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print("all ASR seam checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
