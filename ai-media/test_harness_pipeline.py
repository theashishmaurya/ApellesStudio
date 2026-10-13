#!/usr/bin/env python3
"""D-374 step 3 — the harness's checks and the pipeline that composes them.

Every check is a pure function over contract-shaped fixtures, so **nothing in
this file loads a model** and it runs on a plain `python3` with no sidecar venv.
That is not a convenience: it is the property under test. D-374 says a check
never sees a model and any backend can be harnessed, and the strongest way to
show it is to harness a transcript that no model produced
([`check_agnosticism_over_a_hand_written_contract`]) and to show that nothing in
the package can even reach one ([`check_no_check_can_reach_a_backend`]).

What has a correct answer, and is therefore checked here:

  1. **reconciliation's three classes** — unanimous, disagreed (majority kept,
     alternatives recorded), partial (kept and flagged) — and the
     `low_confidence` spans that follow from the last two;
  2. the result is still a **contract**: segments rebuilt, text rebuilt, every
     word placed, nothing dropped;
  3. the **analysed-range intersection** (D-349 windows), without which a
     multi-pass run reports its own seams as findings;
  4. reconciliation's **refusals** — one pass, a pass with no word timings,
     passes that do not overlap;
  5. the **VAD cross-check's** backend parameter comes from the profile, and a
     report produced under another backend's constants is REFUSED, not folded;
  6. `low_confidence` **merging** — same kind merges, different kinds never do;
  7. the **pipeline composes**, records provenance, validates the contract on
     both sides of every check, and tells a check nothing but a profile;
  8. **determinism**, the repo-wide invariant.

Since D-381 the registry holds one real profile, Parakeet's. The checks that
need a SECOND backend — the VAD guard refusing another backend's constants,
"the bound is the backend's" — use [`STRETCHING`], a synthetic profile that
describes the kind of decoder the guard exists for (one that stretches a word
across a hole, as `mlx-whisper` did) without pretending a real one is
registered. The guard is kept for the next backend; it is tested the same way.

    python3 ai-media/test_harness_pipeline.py
"""
import copy
import dataclasses
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from harness import (  # noqa: E402
    CheckContext,
    ContractError,
    BackendProfile,
    MultiPassReconcile,
    PARAKEET,
    VadCrossCheck,
    dark_params_for,
    fold_dark_report,
    profile_for,
    reconcile_passes,
    run_checks,
)
from harness.contract import LOW_CONFIDENCE_MERGE_GAP_SECS, add_low_confidence  # noqa: E402
from harness.profiles import NO_WORD_LENGTH_BOUND_SECS  # noqa: E402

SENTENCE = "the quick brown fox jumps over the lazy dog".split()
STEP = 0.5

#: A hypothetical second backend whose decoder CAN stretch a word across an
#: untranscribed hole, with the 2.0 s bound `mlx-whisper` had. Not registered in
#: `PROFILES` — it exists to give the per-backend guard something to refuse.
STRETCHING = BackendProfile(
    name="stretching",
    models=frozenset({"stretching-1"}),
    max_word_secs=2.0,
)


def contract(words, *, per_segment=4, drift=0.0, model="parakeet-tdt-0.6b-v3", window=None):
    """A transcript contract, written by hand, laid out one word per [`STEP`].

    Deliberately built the way `transcribe()` builds one — words carrying their
    leading space, segments holding their own word list, a flattened `words`
    alongside — because that is what every consumer downstream reads, and a
    fixture that is only nearly a contract would test nearly the right thing.
    """
    timed = []
    for i, text in enumerate(words):
        if text is None:
            continue
        at = round(i * STEP + drift, 6)
        timed.append({"word": f" {text}", "start": at, "end": round(at + 0.3, 6)})

    segments = []
    for i in range(0, len(timed), per_segment):
        chunk = timed[i : i + per_segment]
        segments.append(
            {
                "start": chunk[0]["start"],
                "end": chunk[-1]["end"],
                "text": "".join(w["word"] for w in chunk).strip(),
                "words": chunk,
            }
        )
    out = {
        "text": " ".join(seg["text"] for seg in segments),
        "language": "en",
        "model": model,
        "source": "/fixtures/hand-written.wav",
        "segments": segments,
        "words": timed,
    }
    if window is not None:
        out["window"] = {"start_secs": window[0], "duration_secs": window[1]}
    return out


def states(result):
    return [w["agreement"]["state"] for w in result["words"]]


def check_unanimous_passes():
    passes = [contract(SENTENCE), contract(SENTENCE), contract(SENTENCE)]
    result = reconcile_passes(passes)

    assert states(result) == ["unanimous"] * len(SENTENCE), states(result)
    assert result["low_confidence"] == [], result["low_confidence"]
    assert result["harness"]["multi_pass_reconcile"]["unanimous"] == len(SENTENCE)
    assert result["harness"]["profile"] == PARAKEET.name
    # The contract survives intact, which is the thing every consumer needs.
    assert [w["word"] for w in result["words"]] == [f" {w}" for w in SENTENCE]
    assert result["text"] == contract(SENTENCE)["text"], result["text"]
    assert sum(len(s["words"]) for s in result["segments"]) == len(SENTENCE)
    print("ok: passes that agree about everything produce no low-confidence spans")


def check_disagreement_keeps_the_majority_and_records_the_rest():
    a = contract(SENTENCE)
    b = contract([w if i != 3 else "box" for i, w in enumerate(SENTENCE)])
    c = contract([w if i != 3 else "box" for i, w in enumerate(SENTENCE)])
    result = reconcile_passes([a, b, c])

    assert states(result).count("disagreed") == 1, states(result)
    word = result["words"][3]
    # Two passes read `box`, one read `fox` — the majority wins even though the
    # reference is the one outvoted, because that is what a majority means.
    assert word["word"] == " box", word
    assert word["agreement"]["passes"] == 3 and word["agreement"]["of"] == 3
    assert word["agreement"]["alternatives"] == [{"word": " fox", "passes": [0]}], word

    spans = [s for s in result["low_confidence"] if s["kind"] == "multi_pass_reconcile"]
    assert len(spans) == 1, spans
    assert abs(spans[0]["start"] - 1.5) < 1e-9, spans
    assert spans[0]["detail"][0]["state"] == "disagreed", spans

    # And a tie goes to the reference, which is the documented asymmetry.
    tied = reconcile_passes([a, b])
    assert tied["words"][3]["word"] == " fox", tied["words"][3]
    assert tied["words"][3]["agreement"]["alternatives"] == [{"word": " box", "passes": [1]}]
    print("ok: a disagreement keeps the majority reading and records the alternatives")


def check_partial_words_are_kept_and_flagged():
    dropped = [w if i not in (4, 5) else None for i, w in enumerate(SENTENCE)]
    result = reconcile_passes([contract(SENTENCE), contract(dropped), contract(SENTENCE)])

    assert len(result["words"]) == len(SENTENCE), result["words"]
    assert states(result) == (
        ["unanimous"] * 4 + ["partial"] * 2 + ["unanimous"] * 3
    ), states(result)
    for i in (4, 5):
        assert result["words"][i]["agreement"] == {"state": "partial", "passes": 2, "of": 3}

    # Two adjacent flagged words are one finding, not two.
    spans = [s for s in result["low_confidence"] if s["kind"] == "multi_pass_reconcile"]
    assert len(spans) == 1, spans
    assert abs(spans[0]["start"] - 2.0) < 1e-9 and abs(spans[0]["end"] - 2.8) < 1e-9, spans
    assert len(spans[0]["detail"]) == 2, spans
    print("ok: a word only some passes heard is kept, flagged, and merged with its neighbour")


def check_the_analysed_range_is_intersected():
    """D-349 windows: passes that cover different ranges must not report their
    own seams as disagreements.

    Varying the chunk offset is exactly how the harness gets its passes, and
    `transcribe(start_secs=…)` is how that is expressed for every backend, so
    passes with different windows are the NORMAL case rather than an edge one.
    """
    whole = contract(SENTENCE, window=(0.0, 4.5))
    later = contract(SENTENCE[2:], window=(1.0, 3.5))
    # `later` starts at 1.0 s, so the first two words of `whole` are outside the
    # range both passes covered and there was nothing to compare them against.
    # `deepcopy` keeps the sharing `contract()` built in — a segment's `words`
    # are the very dicts in the flat list — so shifting the flat list shifts
    # both, which is also the invariant the real contract has.
    shifted = copy.deepcopy(later)
    for w in shifted["words"]:
        w["start"] += 1.0
        w["end"] += 1.0
    for seg in shifted["segments"]:
        seg["start"] += 1.0
        seg["end"] += 1.0
    assert shifted["segments"][0]["words"][0] is shifted["words"][0]

    result = reconcile_passes([whole, shifted])
    assert states(result)[:2] == ["outside", "outside"], states(result)
    assert "partial" not in states(result)[:2]
    assert result["harness"]["multi_pass_reconcile"]["outside"] == 2
    assert [s for s in result["low_confidence"]] == [], result["low_confidence"]

    # And the other direction: a word only the WIDER pass covered, outside the
    # range, is NOT adopted into the reference — reconciliation has nothing to
    # say about it, and adding it would put un-cross-checked content into the
    # reference's own segments.
    narrow = contract(SENTENCE[:4], window=(0.0, 2.0))
    wide = contract(SENTENCE, window=(0.0, 4.5))
    reversed_result = reconcile_passes([narrow, wide])
    assert len(reversed_result["words"]) == 4, reversed_result["words"]
    assert reversed_result["harness"]["multi_pass_reconcile"]["discarded"] == len(SENTENCE) - 4
    print("ok: only the range every pass covered is reconciled; the rest is marked outside")


def check_reconciliation_refusals():
    good = contract(SENTENCE)
    for passes, fragment in (
        ([good], "at least two passes"),
        ([good, {"segments": [{"start": 0.0, "end": 1.0, "text": "x", "words": []}]}], "no word timings"),
    ):
        try:
            reconcile_passes(passes)
        except ContractError as e:
            assert fragment in str(e), e
        else:
            raise AssertionError(f"expected a refusal mentioning {fragment!r}")

    early = contract(SENTENCE, window=(0.0, 2.0))
    late = contract(SENTENCE, window=(100.0, 2.0))
    try:
        reconcile_passes([early, late])
    except ContractError as e:
        assert "do not overlap" in str(e), e
    else:
        raise AssertionError("passes over disjoint ranges must be refused")
    print("ok: one pass, a word-less pass and non-overlapping passes are all refused by name")


def check_vad_parameters_come_from_the_profile():
    assert dark_params_for(PARAKEET) == {"max_word_secs": NO_WORD_LENGTH_BOUND_SECS}
    assert dark_params_for(STRETCHING) == {"max_word_secs": 2.0}
    # The generalisation in one line: the check is the same, the number is the
    # backend's, and two kinds of decoder genuinely need different ones.
    assert dark_params_for(STRETCHING) != dark_params_for(PARAKEET)
    print("ok: the dark-region bound comes from the profile, and differs per backend")


def check_vad_report_is_folded_and_mismatches_refused():
    base = contract(SENTENCE)
    report = {
        "regions": [
            {
                "start_secs": 2.0,
                "end_secs": 3.4,
                "stretch_start_secs": 1.8,
                "stretch_end_secs": 4.0,
                "stretch_speech_secs": 1.3,
                "rms_peak": 0.21,
            }
        ],
        "rms_floor": 0.18,
        "calibration_spans": 4,
        "gated_out": 1,
        "speech_secs": 12.5,
        "covered_secs": 9.1,
    }
    folded = fold_dark_report(
        base,
        report,
        profile=PARAKEET,
        params_used=dark_params_for(PARAKEET),
    )
    spans = [s for s in folded["low_confidence"] if s["kind"] == "vad_cross_check"]
    assert len(spans) == 1 and spans[0]["start"] == 2.0 and spans[0]["end"] == 3.4, spans
    assert spans[0]["detail"][0]["stretch"] == [1.8, 4.0], spans
    provenance = folded["harness"]["vad_cross_check"]
    assert provenance["regions"] == 1 and provenance["gated_out"] == 1, provenance
    assert provenance["max_word_secs"] == NO_WORD_LENGTH_BOUND_SECS, provenance
    # "no regions" means something different depending on these, which is why
    # they are carried rather than dropped.
    assert provenance["speech_secs"] == 12.5 and provenance["covered_secs"] == 9.1

    # The guard: a Parakeet transcript against a stretched-word bound (the
    # detector's Whisper-era default) returns a plausible-looking wrong answer,
    # so it is refused instead of folded.
    try:
        fold_dark_report(
            base,
            report,
            profile=PARAKEET,
            params_used=dark_params_for(STRETCHING),
        )
    except ContractError as e:
        assert "max_word_secs" in str(e) and "parakeet" in str(e), e
    else:
        raise AssertionError("a report from another backend's constants must be refused")
    print("ok: a dark report folds into low_confidence, and a mismatched one is refused")


def check_low_confidence_merging():
    base = contract(SENTENCE)
    near = LOW_CONFIDENCE_MERGE_GAP_SECS / 2
    merged = add_low_confidence(
        dict(base),
        [
            {"start": 1.0, "end": 2.0, "kind": "a", "detail": [{"i": 1}]},
            {"start": 2.0 + near, "end": 3.0, "kind": "a", "detail": [{"i": 2}]},
            {"start": 1.5, "end": 2.5, "kind": "b", "detail": [{"i": 3}]},
            {"start": 9.0, "end": 9.5, "kind": "a", "detail": [{"i": 4}]},
        ],
    )["low_confidence"]
    assert [(s["start"], s["end"], s["kind"]) for s in merged] == [
        (1.0, 3.0, "a"),
        (1.5, 2.5, "b"),
        (9.0, 9.5, "a"),
    ], merged
    assert merged[0]["detail"] == [{"i": 1}, {"i": 2}], merged[0]
    # Order-independent and idempotent, which is what lets checks run in any
    # order and be re-run.
    again = add_low_confidence({**base, "low_confidence": merged}, [])["low_confidence"]
    assert again == merged, again
    print("ok: same-kind spans merge, different kinds never do, and folding is idempotent")


def check_the_pipeline_composes_both_checks():
    reference = contract(SENTENCE)
    second = contract([w if i != 7 else "hazy" for i, w in enumerate(SENTENCE)])
    third = contract([w if i not in (4,) else None for i, w in enumerate(SENTENCE)])
    report = {
        "regions": [{"start_secs": 2.0, "end_secs": 2.9}],
        "rms_floor": 0.2,
        "calibration_spans": 5,
        "gated_out": 0,
        "speech_secs": 10.0,
        "covered_secs": 8.0,
    }

    result = run_checks(
        reference,
        [
            MultiPassReconcile([second, third]),
            VadCrossCheck(report, dark_params_for(PARAKEET)),
        ],
    )

    assert result["harness"]["checks"] == ["multi_pass_reconcile", "vad_cross_check"], result["harness"]
    kinds = {s["kind"] for s in result["low_confidence"]}
    assert kinds == {"multi_pass_reconcile", "vad_cross_check"}, kinds
    # Both checks' findings coexist over the same second of audio without one
    # swallowing the other.
    overlapping = [s for s in result["low_confidence"] if s["start"] < 2.9 and s["end"] > 2.0]
    assert {s["kind"] for s in overlapping} == kinds, overlapping
    # Still a contract, and still the whole transcript.
    assert len(result["words"]) == len(SENTENCE)
    assert json.loads(json.dumps(result)) == result, "the result must be plain JSON-able data"
    print("ok: the pipeline composes reconciliation and the VAD cross-check")


def check_a_check_is_told_nothing_but_a_profile():
    """The structural half of "a check never sees a model": the context has one
    field, and it is plain data."""
    fields = [f.name for f in dataclasses.fields(CheckContext)]
    assert fields == ["profile"], fields
    assert dataclasses.is_dataclass(CheckContext)
    seen = {}

    def spy(contract_in, context):
        seen["context"] = context
        return contract_in

    spy.name = "spy"
    run_checks(contract(SENTENCE), [spy])
    context = seen["context"]
    assert context.profile is PARAKEET, context
    try:
        context.profile = STRETCHING  # type: ignore[misc]
    except dataclasses.FrozenInstanceError:
        pass
    else:
        raise AssertionError("the context must be frozen — a check cannot change the next one's world")
    print("ok: a check is handed one profile and nothing else, and cannot mutate it")


def check_no_check_can_reach_a_backend():
    """Nothing in `harness/` imports a backend, a model runtime, or
    `transcribe` — so a check could not reach a model even if it wanted to.

    Checked by reading the package's own source rather than asserted in a
    docstring, because this is the claim the whole design rests on and it is
    exactly the kind of thing one convenient import quietly ends.
    """
    forbidden = re.compile(
        r"^\s*(?:from|import)\s+(mlx\w*|torch|transformers|whisper\w*|parakeet\w*|transcribe|asr)\b",
        re.MULTILINE,
    )
    package = HERE / "harness"
    modules = sorted(package.glob("*.py"))
    assert len(modules) >= 6, modules
    for module in modules:
        hits = forbidden.findall(module.read_text(encoding="utf-8"))
        assert not hits, f"{module.name} imports a backend: {hits}"
    print(f"ok: none of the {len(modules)} harness modules imports a backend or a model runtime")


def check_the_profile_registry_matches_the_backend_descriptors():
    """`harness/profiles.py` mirrors `asr/base.py`'s `BackendDescriptor`s, and
    this is what stops that being a second source of truth (D-375).

    The harness cannot import `asr/` — a check that could reach a backend module
    could reach a model, which is the one thing D-374 forbids structurally — so
    the registry is a derived mirror. A *test* may import anything, so the
    agreement is pinned here, field for field, and drift becomes a failing test
    rather than a transcript silently scored against another backend's bound.
    `asr/` imports no model library at import time (its own module doc says so
    and `parakeet_mlx` keeps `import parakeet_mlx` inside `transcribe`), so this
    costs nothing and needs no venv.
    """
    from harness.profiles import BackendProfile, PROFILES

    from asr import BACKENDS

    descriptors = {name: backend.descriptor for name, backend in BACKENDS.items()}
    assert {p.name for p in PROFILES} == set(descriptors), (
        f"harness profiles {sorted(p.name for p in PROFILES)} vs "
        f"backends {sorted(descriptors)} — add the missing BackendProfile"
    )
    for profile in PROFILES:
        mirrored = BackendProfile.from_descriptor(descriptors[profile.name])
        assert profile == mirrored, f"{profile.name} has drifted from its descriptor: {profile} != {mirrored}"
    print(f"ok: all {len(PROFILES)} harness profiles match their asr BackendDescriptor exactly")


def check_agnosticism_over_a_hand_written_contract():
    """The agnosticism claim, in its strongest form: **no model produced any of
    this**, and the whole pipeline runs over it.

    Every fixture in this file is hand-written, but this case says so out loud
    — including that the profile is resolved from the contract's own `model`
    field, so a transcript read back off disk years later harnesses exactly
    like one fresh out of a backend, and that an unknown backend — including
    the decommissioned Whisper (`large-v3`, D-381) — is refused by name rather
    than silently given another's constants.
    """
    typed_by_hand = {
        "text": "hello there",
        "language": "en",
        "model": "parakeet-tdt-0.6b-v3",
        "source": "/fixtures/never-transcribed.wav",
        "segments": [
            {
                "start": 0.0,
                "end": 1.0,
                "text": "hello there",
                "words": [
                    {"word": " hello", "start": 0.0, "end": 0.4},
                    {"word": " there", "start": 0.5, "end": 1.0},
                ],
            }
        ],
    }
    assert "words" not in typed_by_hand, "flat_words must cope with a contract that has only segments"
    assert profile_for(typed_by_hand) is PARAKEET

    variant = copy.deepcopy(typed_by_hand)
    variant["segments"][0]["words"][1]["word"] = " their"
    result = run_checks(typed_by_hand, [MultiPassReconcile([variant])])
    assert states(result) == ["unanimous", "disagreed"], states(result)
    assert result["words"][1]["agreement"]["alternatives"] == [{"word": " their", "passes": [1]}]

    for model in ("some-future-asr", "large-v3"):
        unknown = {**typed_by_hand, "model": model}
        try:
            run_checks(unknown, [])
        except KeyError as e:
            assert model in str(e) and "harness/profiles.py" in str(e), e
        else:
            raise AssertionError(f"{model!r} must be refused, not given another's constants")
    print("ok: the pipeline runs over a contract no model produced, and refuses an unknown backend")


def check_a_broken_check_fails_at_its_own_boundary():
    def vandal(contract_in, context):
        return {"segments": "not a list"}

    vandal.name = "vandal"
    try:
        run_checks(contract(SENTENCE), [vandal])
    except ContractError as e:
        assert "vandal returned" in str(e), e
    else:
        raise AssertionError("a check that breaks the contract must fail named")
    print("ok: a check that returns something that is not a contract fails at its own boundary")


def check_determinism():
    passes = [
        contract(SENTENCE),
        contract([w if i != 2 else "braun" for i, w in enumerate(SENTENCE)], drift=0.07),
        contract([w if i != 6 else None for i, w in enumerate(SENTENCE)], drift=-0.09),
    ]
    report = {"regions": [{"start_secs": 1.0, "end_secs": 1.9}], "speech_secs": 5.0}
    checks = [
        MultiPassReconcile(passes[1:]),
        VadCrossCheck(report, dark_params_for(PARAKEET)),
    ]
    first = run_checks(passes[0], checks)
    for _ in range(3):
        assert run_checks(passes[0], checks) == first, "the harness must be deterministic"
    print("ok: the whole pipeline is deterministic across repeated runs")


def main() -> int:
    check_unanimous_passes()
    check_disagreement_keeps_the_majority_and_records_the_rest()
    check_partial_words_are_kept_and_flagged()
    check_the_analysed_range_is_intersected()
    check_reconciliation_refusals()
    check_vad_parameters_come_from_the_profile()
    check_vad_report_is_folded_and_mismatches_refused()
    check_low_confidence_merging()
    check_the_pipeline_composes_both_checks()
    check_a_check_is_told_nothing_but_a_profile()
    check_no_check_can_reach_a_backend()
    check_the_profile_registry_matches_the_backend_descriptors()
    check_agnosticism_over_a_hand_written_contract()
    check_a_broken_check_fails_at_its_own_boundary()
    check_determinism()
    print("all harness pipeline checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
