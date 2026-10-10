#!/usr/bin/env python3
"""The check pipeline — and the boundary that makes a check backend-agnostic
(D-374 step 3).

**What it is.** Thirty lines that run a list of checks over one contract. It is
short on purpose: all the pipeline owes the harness is the *shape* of a check,
and that shape is the whole backend-agnosticism claim.

```
contract ─► [ check ] ─► [ check ] ─► [ … ] ─► contract + annotations
```

**The boundary, stated exactly.** [`run_checks`] calls a check with two
arguments and no others:

1. a transcript contract — a plain `dict` of JSON-able data;
2. a [`CheckContext`] — a frozen dataclass holding one
   [`harness.profiles.BackendProfile`], itself three fields of plain data.

There is no model in that signature, no audio path, no callable, no backend
module and no way to obtain one: a check that wanted a model would have to
import one itself, and nothing in `harness/` imports a backend at all. That is
what D-374 means by *"a check never sees a model"* — a structural property of
the signature, not a rule someone has to remember. A check that genuinely needs
model internals is a backend feature, not a check.

**Why the contract is validated twice per check.** On the way in and on the way
out ([`harness.contract.check_contract`]). The harness's own likely failure is a
check that returns something *almost* a contract — a word list, segments
without words — and a pipeline is exactly the place where that gets three
checks away from its cause before anybody notices. Validating both sides makes
a broken check fail at its own boundary, named.

**What it does NOT do.** It does not run a backend, produce passes, cache,
retry, parallelise or order the checks for you — the list it is given is the
order. Checks are independent by construction (each takes and returns the
contract), so there is nothing here to schedule.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Protocol, Sequence, runtime_checkable

from .contract import check_contract
from .profiles import BackendProfile, profile_for

__all__ = ["Check", "CheckContext", "run_checks"]


@dataclass(frozen=True)
class CheckContext:
    """Everything a check is told besides the contract.

    One field, and it is plain data. Frozen so a check cannot reach into the
    context and change what the next check is told — the harness's determinism
    invariant depends on every check seeing the same world.
    """

    #: The descriptor for the backend that produced the transcript. The only
    #: place a check may get a backend-specific constant from.
    profile: BackendProfile


@runtime_checkable
class Check(Protocol):
    """What a check is: a name, and a call that takes a contract plus a
    [`CheckContext`] and returns a contract.

    A `Protocol` rather than a base class — a check is a shape, and both a
    function with a `name` attribute and a small class with state it was
    constructed with (`MultiPassReconcile` carries the other passes) satisfy it
    without inheriting anything.
    """

    name: str

    def __call__(self, contract: Mapping[str, Any], context: CheckContext) -> dict: ...


def run_checks(
    contract: Mapping[str, Any],
    checks: Sequence[Check],
    *,
    profile: BackendProfile | None = None,
) -> dict:
    """`contract` after every check in `checks`, in order.

    `profile` defaults to the one [`harness.profiles.profile_for`] resolves
    from the contract's own `model` field, so a transcript read back off disk
    — with no backend anywhere in the process — harnesses exactly like one that
    has just come out of a backend. That is the agnosticism claim in its
    strongest form, and it is what the pipeline's own test exercises.

    An empty `checks` list returns the contract validated and unchanged, which
    is the right answer to "run no checks" and is worth having rather than
    special-casing at every call site.
    """
    resolved = profile or profile_for(contract)
    context = CheckContext(profile=resolved)
    current = check_contract(dict(contract), where="run_checks: input")
    for check in checks:
        name = getattr(check, "name", type(check).__name__)
        current = check_contract(check(current, context), where=f"run_checks: {name} returned")
    return current
