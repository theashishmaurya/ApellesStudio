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

**One backend today, and the seam stays.** D-374 built this for two
(`mlx-whisper` and Parakeet); D-381 decommissioned Whisper, leaving Parakeet as
the only implementation. Nothing here was specific to either — that was the
point — so the seam is unchanged and a future backend still plugs in the way
`README.md` describes.

**Why a validator and not just a docstring.** A transcript cannot be cheaply
re-derived from a model on every run, so what is pinned instead is the shape,
on every call, for every backend — a backend that returns a 98-second segment,
a sub-word fragment where a word belongs, or an un-shifted timestamp fails at
its own boundary instead of several layers downstream in a retake group.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Protocol, runtime_checkable

from errors import UserFacingError


@dataclass(frozen=True)
class BackendDescriptor:
    """Everything a caller can learn about a backend WITHOUT running it.

    Deliberately small: which models the backend accepts and where each one's
    weights load from, which languages it can actually transcribe, and the one
    anomaly constant a *general* check cannot hard-code ([`Self.max_word_secs`]).

    That last field arrived with the harness (D-375). D-374 §3.2 said from the
    start that `dark.rs`'s Whisper-specific constants belong in the descriptor
    rather than in a check; this file originally left it out because `CLAUDE.md`
    does not allow carrying a field nothing consumes, and nothing did yet.
    `ai-media/harness/`'s VAD cross-check now does.
    """

    #: The `backend=` / `--backend` name. Also what an error message calls it.
    name: str
    #: Used when a caller passes no model at all.
    default_model: str
    #: Every model name this backend accepts → the Hugging Face repo id (or
    #: local directory) its weights load from, in the order a help string lists
    #: them. The one place a model name meets its weights: the backend loads
    #: from it, and `server.py`'s `/health` reports the default's entry.
    model_repos: Mapping[str, str]
    #: ISO-639-1 codes the backend can transcribe, or `None` for "not
    #: constrained" — a backend whose practical answer for any language is "try
    #: it". A finite set is a REFUSAL surface, not documentation: see
    #: [`check_language`].
    languages: frozenset[str] | None
    #: One clause naming the language coverage, for the refusal sentence.
    language_summary: str
    #: The too-long-word bound the dark-region cross-check must use for THIS
    #: backend, in seconds — or `None` when the backend cannot stretch a word
    #: across an untranscribed hole and the bound does not apply to it at all.
    #:
    #: `crates/apelles-speech/src/dark.rs` excludes a word longer than this from
    #: transcript coverage, because a decoder that aligns words after the fact
    #: can spread the few tokens it *did* emit across a region it dropped —
    #: mlx-whisper's DTW alignment did exactly that (c038's ` down.` at
    #: 217.26-222.74 s, 5.48 s for one word), so a gap that looks covered is
    #: not. The algorithm is general; this number is the backend's, which is why
    #: it lives here and is passed in. Parakeet's is `None` (its own module says
    #: why). See [`harness.vad.dark_params_for`], its only reader, and D-375.
    max_word_secs: float | None

    @property
    def models(self) -> tuple[str, ...]:
        """Every model name this backend accepts, in [`Self.model_repos`]'s
        order."""
        return tuple(self.model_repos)

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
        """`None` / `"auto"` is always supported — it is a request for the
        backend's own default behaviour inside its own set, never a claim about
        the source. (Parakeet takes no language argument at all, so for it
        "auto" is simply what always happens.)"""
        if not language or language == "auto":
            return True
        if self.languages is None:
            return True
        return language.lower().split("-")[0] in self.languages


def check_language(descriptor: BackendDescriptor, language: str | None) -> None:
    """Refuse a language the backend cannot transcribe, with the reason named.

    This exists because of one measured, specific mismatch (D-374): **Hindi is
    not among parakeet-tdt-0.6b-v3's 25 European languages**, and silently
    handing Hindi to Parakeet does not fail — it returns confident, fluent,
    wrong English, which is the worst possible outcome for a transcript an
    editor is about to cut to. Until D-381 the refusal pointed at the
    multilingual Whisper backend; since Whisper was decommissioned there is no
    backend to point at, and the sentence says so plainly: a source outside the
    set is unsupported (D-381 records Hindi/Hinglish as unsupported, by the
    owner's call).

    A plain [`UserFacingError`] rather than a new exception subclass:
    `errors.py` states that its one-bit taxonomy ("was this message written for
    the person reading it?") is deliberate and that anything more would be a
    taxonomy nobody consumes. The reason is named in the sentence, which is
    what the caller and the Edit tab both actually show.

    A `None`/`"auto"` language is NOT refused — it is a request for the
    backend's own default behaviour, not a statement about the source. Which
    also means this cannot catch a Hindi source transcribed with no language
    named; nothing local can, since Parakeet reports no detected language
    (`docs/notes/asr-backends-and-harness.md` §5).
    """
    if descriptor.supports_language(language):
        return
    codes = ", ".join(sorted(descriptor.languages or ()))
    raise UserFacingError(
        f"the speech model ({descriptor.default_model}) cannot transcribe {language!r}: it "
        f"covers {descriptor.language_summary} only ({codes}), and Apelles has no other "
        "speech model. A source in another language is not supported."
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
    # `start`/`end` may legitimately be `None`: the contract has always allowed
    # an untimed word (mlx-whisper emitted them), and `transcribe.py`'s own
    # `_shift` leaves those alone rather than compute `None + offset`. Parakeet
    # always times its words, but the contract is the backends' common shape,
    # not one backend's output, so it keeps carrying that possibility rather
    # than inventing a number for it.
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

    **On the seam rather than in the Parakeet backend because it is a property
    of Hub loaders, not of one model.** `parakeet_mlx.utils.from_pretrained`
    reaches the Hub with no `local_files_only` even when every file is already
    cached (`hf_hub_download(repo, "config.json")`), which contradicts this
    sidecar's own promise ("no network calls beyond a first-run model
    download"). B-174 was caught live on the decommissioned `mlx_whisper`
    loader, which had the same bug: a dead TCP connection (CLOSE_WAIT — the peer
    had already closed, the client never noticed) left a transcribe job hung
    indefinitely with 0% CPU, no timeout, no error. Any future Hub-loaded
    backend wants the same treatment, which is why it stays here.

    `from_pretrained` falls back to treating its argument as a local directory
    when it already exists on disk (it wraps its two `hf_hub_download` calls in
    a `try` whose `except` reads `Path(hf_id_or_path) / "config.json"`). So
    resolving the cached snapshot path ourselves, with `local_files_only=True`
    (which raises immediately rather than touching the network when the repo
    isn't cached), and handing the loader that path instead of the bare repo id
    skips the network call entirely on every call after the first — with no
    global state (`HF_HUB_OFFLINE`) to mutate and no thread-safety concern with
    concurrent jobs.
    """
    try:
        from huggingface_hub import snapshot_download

        return snapshot_download(repo_id=repo, local_files_only=True)
    except Exception:
        # Not cached yet (or the cache is unreadable) — fall back to the bare
        # repo id so the loader does its normal first-run download.
        return repo
