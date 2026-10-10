#!/usr/bin/env python3
"""Check 2 — the VAD cross-check, generalised (D-374 step 3, D-375).

**The check already exists, and it is not here.** `VAD says speech, transcript
says nothing ⇒ a dark region` is `crates/apelles-speech/src/dark.rs`, in Rust,
scored over 111 labelled windows across two real camera originals for 90 %
precision with no region missed in 1676 s of footage. Reimplementing that in
Python would be a second implementation of the same logic, which `CLAUDE.md`
forbids outright — and the copy would be the untested one. **D-375 records that
placement decision and its reasoning in full.** The short version:

- it is **not a contract-only check**. Its second input is *audio* — Silero
  speech probabilities and an RMS envelope at two different hop rates — which
  the transcript contract does not carry and `ai-media/` has no ONNX session,
  no model and no decoder to produce. The harness's own rule, that a check sees
  only the contract, is in fact the reason this one cannot live inside the
  harness as a self-contained check;
- what was actually Whisper-specific about it was never the algorithm. It was
  **one number**, and `dark.rs` already takes that number as a parameter
  (`DarkParams::max_word_secs`, overridable right through
  `chroma_detect_dark_regions`'s wire contract). The seam existed; what did not
  exist was anything that knew what to put in it per backend.

**So this module is the half that genuinely is contract-layer**, and it is two
functions:

| | |
|---|---|
| [`dark_params_for`] | the `DarkParams` override the detector needs *for this backend*, from the profile — never a constant in a check |
| [`fold_dark_report`] | the detector's own `DarkReport`, folded into the harness's `low_confidence` vocabulary |

**Where a report comes from.** `apelles_speech::dark::detect_dark_regions`,
through whichever of its existing callers suits: the app's
`chroma_detect_dark_regions` Tauri command (what the Recut panel and the
`editor_detect_dark_regions` MCP op use), or the crate's own `dark_live`
integration test for a standalone run. Both already serialise the report —
`DarkReport` is `serde::Serialize` — so the harness consumes it as *data*, the
same way it consumes a transcript. The harness does not run the VAD, and says
so: [`VadCrossCheck`] is constructed with the report, so the check itself still
only ever sees contracts and plain data.

**The guard is the point of the generalisation.** [`fold_dark_report`] refuses
a report produced under parameters that are not this backend's. Running a
Parakeet transcript against Whisper's 2.0 s word bound does not fail — it
returns a plausible-looking list of dark regions that is wrong, which nobody
would catch by reading it. That is the exact mistake D-374 §3.2 names, and it
is now a refusal.
"""

from __future__ import annotations

from typing import Any, Mapping

from .contract import (
    ContractError,
    add_low_confidence,
    record_provenance,
)
from .pipeline import CheckContext
from .profiles import NO_WORD_LENGTH_BOUND_SECS, BackendProfile

__all__ = ["CHECK_NAME", "VadCrossCheck", "dark_params_for", "fold_dark_report"]

#: The name this check records in `harness.checks`, and the `kind` of the
#: `low_confidence` spans it folds in.
CHECK_NAME = "vad_cross_check"


def dark_params_for(profile: BackendProfile) -> dict[str, float]:
    """The `DarkParams` override `apelles_speech::dark` needs for `profile`.

    A JSON object, because that is what the detector's parameters are on every
    boundary that matters: `DarkParams` is `#[serde(default)]`, so the fields
    named here are overridden and every measured default — `min_dark_secs`,
    the RMS calibration, the Silero hysteresis — is left exactly as the
    111-window scoring set it. **A backend's profile may only move what is
    the backend's**; nothing in a profile can reach the thresholds that are
    properties of speech rather than of a model.

    Today that is one field, and it is the right one field (see this module's
    doc). `None` for `max_word_secs` means this backend cannot stretch a word
    across an untranscribed hole, so the bound does not apply and becomes
    [`harness.profiles.NO_WORD_LENGTH_BOUND_SECS`].
    """
    bound = profile.max_word_secs
    return {"max_word_secs": NO_WORD_LENGTH_BOUND_SECS if bound is None else float(bound)}


def fold_dark_report(
    contract: Mapping[str, Any],
    report: Mapping[str, Any],
    *,
    profile: BackendProfile,
    params_used: Mapping[str, Any],
) -> dict:
    """`contract` with `report`'s dark regions folded in as `low_confidence`
    spans of kind `vad_cross_check`.

    `report` is `apelles_speech::dark::DarkReport` as serialised — `regions`
    plus the numbers that say how it was reached (`rms_floor`,
    `calibration_spans`, `gated_out`, `speech_secs`, `covered_secs`). All of
    them land in `harness.vad_cross_check` provenance, because "no regions"
    means something very different when the VAD found 400 s of speech than when
    it found none.

    `params_used` is what was actually handed to the detector. It must equal
    [`dark_params_for`]`(profile)` on every field that function sets; anything
    else is a report about a different backend's failure mode, and is refused
    rather than folded. Extra fields the caller overrode for its own reasons
    are left alone — this guard is about the backend's constants, not about
    forbidding a caller from tuning the thresholds that are theirs to tune.
    """
    required = dark_params_for(profile)
    for field, expected in required.items():
        actual = params_used.get(field)
        if actual is None or abs(float(actual) - expected) > 1e-9:
            raise ContractError(
                f"{CHECK_NAME}: this report was produced with {field}={actual!r}, but "
                f"{profile.name} needs {field}={expected!r}. A dark-region report from "
                "another backend's constants is a wrong answer, not an approximate one — "
                "re-run the detector with dark_params_for(profile)."
            )

    regions = report.get("regions")
    if not isinstance(regions, list):
        raise ContractError(
            f"{CHECK_NAME}: a DarkReport has a `regions` list (got {type(regions).__name__})"
        )

    spans = []
    for region in regions:
        if not isinstance(region, Mapping):
            raise ContractError(f"{CHECK_NAME}: a region must be an object, got {region!r}")
        try:
            start = float(region["start_secs"])
            end = float(region["end_secs"])
        except (KeyError, TypeError, ValueError) as e:
            raise ContractError(
                f"{CHECK_NAME}: a region needs numeric start_secs/end_secs ({e})"
            ) from e
        spans.append(
            {
                "start": start,
                "end": end,
                "kind": CHECK_NAME,
                "detail": [
                    {
                        # The stretch is wider than the region and is what
                        # actually cleared the threshold; a caller
                        # re-transcribing with context needs to know how much
                        # room it has (`dark.rs`'s `DarkRegion` doc).
                        "stretch": [
                            region.get("stretch_start_secs"),
                            region.get("stretch_end_secs"),
                        ],
                        "stretch_speech_secs": region.get("stretch_speech_secs"),
                        "rms_peak": region.get("rms_peak"),
                    }
                ],
            }
        )

    out = dict(contract)
    add_low_confidence(out, spans)
    record_provenance(
        out,
        check=CHECK_NAME,
        profile=profile.name,
        regions=len(spans),
        max_word_secs=required["max_word_secs"],
        rms_floor=report.get("rms_floor"),
        calibration_spans=report.get("calibration_spans"),
        gated_out=report.get("gated_out"),
        speech_secs=report.get("speech_secs"),
        covered_secs=report.get("covered_secs"),
    )
    return out


class VadCrossCheck:
    """[`fold_dark_report`] as a pipeline check.

    Constructed with the report and the parameters it was produced under — both
    plain data — so the check's own call still receives nothing but a contract
    and a [`CheckContext`]. The detector runs where it already lives; this is
    the stage that puts its answer into the contract.
    """

    name = CHECK_NAME

    def __init__(self, report: Mapping[str, Any], params_used: Mapping[str, Any]) -> None:
        self.report = report
        self.params_used = params_used

    def __call__(self, contract: Mapping[str, Any], context: CheckContext) -> dict:
        return fold_dark_report(
            contract,
            self.report,
            profile=context.profile,
            params_used=self.params_used,
        )
