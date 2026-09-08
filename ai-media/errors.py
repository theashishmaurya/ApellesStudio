#!/usr/bin/env python3
"""Errors whose message is already written for a human (B-119).

**What it is:** one exception base class, shared by this sidecar's two
capability modules and understood by `server.py`'s job runner.

`server.py` records every job failure as `f"{type(e).__name__}: {e}"`, which is
right for an unexpected fault — the class name is real diagnostic information
when a `KeyError` escapes. It is wrong for a fault we predicted and wrote a
sentence about: prefixing "NoAudioStream:" to "this file has no audio to
transcribe" adds nothing a user can act on, and the string ends up in the Edit
tab's own error line verbatim. A `UserFacingError` is reported as its message
alone.

**What it does NOT do:** it carries no code, no category and no HTTP status. The
distinction it draws is exactly one bit — "was this message written for the
person reading it, or is it the raw text of something that went wrong" — and
anything more would be a taxonomy nobody here consumes.
"""

from __future__ import annotations


class UserFacingError(RuntimeError):
    """An error whose `str()` is a complete, readable explanation.

    Raise this only when the message says what is wrong AND what to do about
    it, in a sentence, with no stack-trace vocabulary, no subprocess dumps and
    no temp paths in it. Everything else should stay an ordinary exception so
    its class name survives into the job record.
    """
