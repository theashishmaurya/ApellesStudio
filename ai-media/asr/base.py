#!/usr/bin/env python3
"""The ASR backend seam — the transcript contract, and what a backend owes it (D-374).

**What it is:** one definition of the shape every speech-to-text backend must
produce, the [`AsrBackend`] Protocol that produces it, the
[`BackendDescriptor`] that answers questions ABOUT a backend without running
it, and [`validate_body`], the shared check that a backend actually honoured
the contract.

**What it does NOT do:** it does not transcribe, load a model, read audio, cut
a window, or shift a timestamp. Everything shared *around* a backend —
existence checks, ffmpeg windowing, the `start_secs` shift, flattening `words`,
assembling the result — lives in `transcribe.py`, which is the only caller of
this package. Keeping it there rather than here is what makes the backends
small enough to be obviously equivalent: a backend sees one prepared audio
file and returns window-local seconds, nothing else.

**The contract was not invented here.** It is `transcribe()`'s own return value,
unchanged since D-189, and D-374's whole point is that it already *was* the
interface:

```
{ text, language, model, source,
  segments: [ { start, end, text, words: [ {word, start, end, probability?} ] } ],
  words:    [ {word, start, end, probability?} ]   # flattened, absent if none
  window?:  { start_secs, duration_secs }          # D-349
}
```

Timestamps in the finished result are **absolute source seconds**. A backend
emits **window-local** seconds and `transcribe.py` shifts them, so the shift
exists exactly once and a windowed pass can be spliced straight into a
whole-file one — D-349, the recovery primitive `apelles-speech`'s dark-region
detector feeds (B-216).

**Why a validator and not just a docstring.** D-374 step 1's acceptance test is
"nothing changed", and the committed Whisper fixtures cannot be cheaply
re-derived from the model. What *can* be pinned is the shape, on every call, for
every backend — so a backend that returns a 98-second segment, a sub-word
fragment where a word belongs, or an un-shifted timestamp fails at its own
boundary instead of several layers downstream in a retake group.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from errors import UserFacingError


@dataclass(frozen=True)
class BackendDescriptor:
    """Everything a caller can learn about a backend WITHOUT running it.

    Deliberately small. D-374 §3.2 observes that `dark.rs`'s Whisper-specific
    anomaly constants belong here rather than in a check — that is true and is
    still open (the note's §5 records it), but the harness that would read them
    does not exist yet and `CLAUDE.md` does not allow carrying a field nothing
    consumes. What IS here is what the seam itself needs: which models the
    backend accepts, and which languages it can actually transcribe.
    """

    #: The `backend=` / `--backend` name. Also what an error message calls it.
    name: str
    #: Used when a caller passes no model at all.
    default_model: str
    #: Every model name this backend accepts, in the order a help string lists
    #: them.
    models: tuple[str, ...]
    #: ISO-639-1 codes the backend can transcribe, or `None` for "not
    #: constrained" (mlx-whisper's 99-language multilingual set, where the
    #: practical answer is "try it"). A finite set is a REFUSAL surface, not
    #: documentation: see [`check_language`].
    languages: frozenset[str] | None
    #: One clause naming the language coverage, for the refusal sentence.
    language_summary: str

    def require_model(self, model: str | None) -> str:
        """`model`, or the default when it is `None` — raising `ValueError` if
        this backend does not have it.

        A `ValueError` and not a `UserFacingError` on purpose: an unknown model
        name is a caller bug (the CLI and `server.py` both validate against a
        list they publish), not something a person reading the Edit tab can act
        on.
        """
        resolved = model or self.default_model
        if resolved not in self.models:
            raise ValueError(
                f"no model {resolved!r} for the {self.name!r} ASR backend. "
                f"Supported: {', '.join(self.models)}"
            )
        return resolved

    def supports_language(self, language: str | None) -> bool:
        """`None` / `"auto"` is always supported — it is a request to let the
        model decide, which every backend here can do within its own set."""
        if not language or language == "auto":
            return True
        if self.languages is None:
            return True
        return language.lower().split("-")[0] in self.languages


def check_language(descriptor: BackendDescriptor, language: str | None) -> None:
    """Refuse a language the backend cannot transcribe, with the reason named.

    This exists because of one measured, specific mismatch (D-374): `transcribe.
    py`'s own docstring promises code-switched Hinglish auto-detects fine on
    `large-v3`, and **Hindi is not among parakeet-tdt-0.6b-v3's 25 European
    languages**. Silently handing Hindi to Parakeet does not fail — it returns
    confident, fluent, wrong English, which is the worst possible outcome for a
    transcript an editor is about to cut to.

    A plain [`UserFacingError`] rather than a new exception subclass:
    `errors.py` states that its one-bit taxonomy ("was this message written for
    the person reading it?") is deliberate and that anything more would be a
    taxonomy nobody consumes. The reason is named in the sentence, which is
    what the caller and the Edit tab both actually show.

    A `None`/`"auto"` language is NOT refused — it is a request for the
    backend's own detection, inside its own set.
    """
    if descriptor.supports_language(language):
        return
    codes = ", ".join(sorted(descriptor.languages or ()))
    raise UserFacingError(
        f"the {descriptor.name} speech model cannot transcribe {language!r}: it covers "
        f"{descriptor.language_summary} ({codes}). Transcribe this source with the "
        "whisper backend instead, which is multilingual."
    )


@runtime_checkable
class AsrBackend(Protocol):
    """One speech-to-text implementation.

    The whole of a backend's job: given ONE already-prepared audio file, return
    the contract body in **window-local seconds**. It does not know whether it
    was handed a window or a whole file, and it must not care — that is exactly
    what makes D-349's windowing work identically on every backend.

    `transcribe(...)` returns `{text, language, segments}`; `words` is flattened
    out of `segments` by the caller, so a backend never builds the same list
    twice and the two can never disagree.
    """

    @property
    def descriptor(self) -> BackendDescriptor: ...

    def transcribe(
        self,
        audio_path: str,
        *,
        model: str,
        language: str | None,
        word_timestamps: bool,
    ) -> dict: ...


def validate_body(body: object, *, backend: str) -> dict:
    """Prove a backend returned the contract, or raise `ValueError` saying what
    it returned instead.

    Checked here and not in each backend because the contract is one thing: a
    second copy of these rules is how two backends come to disagree about what
    a transcript is. Raises `ValueError` — a backend that breaks its own
    contract is a programming error, never a sentence for a user.
    """
    if not isinstance(body, dict):
        raise ValueError(f"{backend} backend returned {type(body).__name__}, not a dict")

    for key in ("text", "language", "segments"):
        if key not in body:
            raise ValueError(f"{backend} backend returned no {key!r}")
    if not isinstance(body["text"], str):
        raise ValueError(f"{backend} backend returned a non-string 'text'")
    if not isinstance(body["language"], str):
        raise ValueError(f"{backend} backend returned a non-string 'language'")

    segments = body["segments"]
    if not isinstance(segments, list):
        raise ValueError(f"{backend} backend returned a non-list 'segments'")

    for index, seg in enumerate(segments):
        where = f"{backend} segment {index}"
        if not isinstance(seg, dict):
            raise ValueError(f"{where} is {type(seg).__name__}, not a dict")
        for key in ("start", "end", "text", "words"):
            if key not in seg:
                raise ValueError(f"{where} has no {key!r}")
        _require_time(seg["start"], f"{where} start")
        _require_time(seg["end"], f"{where} end")
        if seg["end"] < seg["start"]:
            raise ValueError(f"{where} ends before it starts: {seg['start']} → {seg['end']}")
        if not isinstance(seg["text"], str):
            raise ValueError(f"{where} has a non-string 'text'")
        if not isinstance(seg["words"], list):
            raise ValueError(f"{where} has a non-list 'words'")
        for w_index, word in enumerate(seg["words"]):
            _validate_word(word, f"{where} word {w_index}")

    return body


def _validate_word(word: object, where: str) -> None:
    if not isinstance(word, dict):
        raise ValueError(f"{where} is {type(word).__name__}, not a dict")
    for key in ("word", "start", "end"):
        if key not in word:
            raise ValueError(f"{where} has no {key!r}")
    if not isinstance(word["word"], str):
        raise ValueError(f"{where} has a non-string 'word'")
    # `start`/`end` may legitimately be `None`: mlx-whisper emits word entries
    # with no timing, and `transcribe.py`'s own `_shift` exists to leave those
    # alone rather than compute `None + offset`. The contract carries that
    # possibility; it does not invent a number for it.
    _require_time_or_none(word["start"], f"{where} start")
    _require_time_or_none(word["end"], f"{where} end")
    if "probability" in word and not isinstance(word["probability"], (int, float)):
        raise ValueError(f"{where} has a non-numeric 'probability'")


def _require_time(value: object, where: str) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{where} is {value!r}, not a number of seconds")


def _require_time_or_none(value: object, where: str) -> None:
    if value is None:
        return
    _require_time(value, where)


def local_snapshot_or_repo(repo: str) -> str:
    """Resolve `repo` to its cached local snapshot path, or return `repo`
    unchanged if it is not cached yet (B-174).

    **Shared by both backends because both have the same bug to avoid.**
    `mlx_whisper.load_models.load_model` and `parakeet_mlx.utils.from_pretrained`
    each reach the Hub with no `local_files_only` even when every file is
    already cached — `snapshot_download(repo_id=...)` and
    `hf_hub_download(repo, "config.json")` respectively — which contradicts this
    sidecar's own promise ("no network calls beyond a first-run model download")
    and was caught live on the whisper path: a dead TCP connection (CLOSE_WAIT —
    the peer had already closed, the client never noticed) left a transcribe job
    hung indefinitely with 0% CPU, no timeout, no error.

    Both loaders fall back to treating their argument as a local directory when
    it already exists on disk (`mlx_whisper`'s `load_model` only calls
    `snapshot_download` when `Path(path_or_hf_repo)` does NOT exist;
    `from_pretrained` wraps its two `hf_hub_download` calls in a `try` whose
    `except` reads `Path(hf_id_or_path) / "config.json"`). So resolving the
    cached snapshot path ourselves, with `local_files_only=True` (which raises
    immediately rather than touching the network when the repo isn't cached),
    and handing the loader that path instead of the bare repo id skips the
    network call entirely on every call after the first — with no global state
    (`HF_HUB_OFFLINE`) to mutate and no thread-safety concern with concurrent
    jobs for different models.
    """
    try:
        from huggingface_hub import snapshot_download

        return snapshot_download(repo_id=repo, local_files_only=True)
    except Exception:
        # Not cached yet (or the cache is unreadable) — fall back to the bare
        # repo id so the loader does its normal first-run download.
        return repo
