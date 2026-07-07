"""Hypothesis op-generation + the interleaving/concurrency model (§3).

The op union is a small set of frozen dataclasses; a :class:`Plan` is a member
count ``n`` (2–4) plus a bounded list of ops.  ``actor`` indexes the writer list
(owner + invited members, adversary excluded); ``stream`` is ``0`` (public) or
``1`` (private).

**Interleaving model — RULED:** randomized-*sequential* application with occasional
gather-bursts.  The runner applies ops one at a time in the hypothesis-drawn order
(randomized interleaving of client actions, yet deterministic and CI-reproducible
— no wall-clock races).  The *one* op that needs true concurrency —
``ConcurrentSendBurst`` — issues K simultaneous sends to the **same** stream via
``asyncio.gather`` (the ``test_events_batch_concurrency`` pattern), the targeted
streams-row-lock / gaplessness probe.

**Profiles:** ``ci`` = ``derandomize=True`` + bounded ``max_examples`` +
``deadline=None`` (container IO), sized <2 min; ``dev`` = more examples,
non-derandomized.  ``ci`` is selected when ``CI`` is set (the harness threads
``CI: "true"``).  Registered at import so both suite modules pick up the profile.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

from hypothesis import HealthCheck
from hypothesis import settings as hp_settings
from hypothesis import strategies as st

# --- op union -----------------------------------------------------------------


@dataclass(frozen=True)
class Send:
    """``actor`` mints + flushes one message to ``stream``."""

    actor: int
    stream: int
    text: str


@dataclass(frozen=True)
class DuplicateSend:
    """``actor`` re-enqueues its last message (same ``event_id``) → dup upload."""

    actor: int
    stream: int


@dataclass(frozen=True)
class DisconnectMidFlush:
    """``actor`` disconnects and flushes: the POST is issued but the ack is lost."""

    actor: int


@dataclass(frozen=True)
class ReconnectCatchup:
    """``actor`` reconnects: flush the outbox, then sync + catch up every stream."""

    actor: int


@dataclass(frozen=True)
class ConcurrentSendBurst:
    """K writers send to the **same** ``stream`` via ``asyncio.gather`` (true race)."""

    stream: int
    count: int


@dataclass(frozen=True)
class React:
    """``actor`` reacts with ``emoji`` to an existing message in ``stream``.

    ``msg`` selects among the messages the actor knows in that stream (resolved,
    modulo, at apply time); a no-op if the stream has no message yet. Repeated
    ``React`` ops with the same resolved ``(message, actor, emoji)`` exercise the
    idempotent-add / duplicate-add path (§2.4).
    """

    actor: int
    stream: int
    msg: int
    emoji: int


@dataclass(frozen=True)
class Unreact:
    """``actor`` removes its ``emoji`` reaction from a message in ``stream``.

    Also covers the absent-remove no-op (§2.4): if the actor never added that
    ``(message, emoji)``, the ``reaction.removed`` is still a VALID event that
    sequences normally and leaves the set unchanged.
    """

    actor: int
    stream: int
    msg: int
    emoji: int


@dataclass(frozen=True)
class ConcurrentReactBurst:
    """K writers react to the **same** message with the **same** ``emoji`` via
    ``asyncio.gather`` (true race) — the concurrent duplicate-add probe (§2.4).
    """

    stream: int
    msg: int
    emoji: int
    count: int


@dataclass(frozen=True)
class Edit:
    """``actor`` edits its OWN message in ``stream`` with new ``text`` (ENG-98).

    ``msg`` selects among the messages the actor AUTHORED in that stream (resolved
    modulo at apply time; a no-op if it authored none yet). Repeated ``Edit`` ops
    on the same message exercise last-writer-wins by ``server_sequence`` (§2.4).
    Only own-message edits are generated — the author-or-admin rule makes editing
    another's message a refusal (covered by the permission-isolation probe).
    """

    actor: int
    stream: int
    msg: int
    text: str


@dataclass(frozen=True)
class Delete:
    """``actor`` deletes its OWN message in ``stream`` (ENG-98).

    ``msg`` selects among the actor's authored messages (resolved modulo; a no-op
    if none). A delete is terminal: a later edit does not un-delete (§2.4). Only
    own-message deletes are generated (see :class:`Edit`).
    """

    actor: int
    stream: int
    msg: int


@dataclass(frozen=True)
class ThreadReply:
    """``actor`` replies to an existing NON-reply message in ``stream`` (ENG-99, D7).

    ``msg`` selects among the ROOT (top-level, non-reply) messages the actor knows in
    that stream (resolved modulo at apply time; a no-op if it knows none yet). The
    reply is a ``message.created`` carrying ``thread_root_id`` = the resolved root, so
    it grows the root's ``reply_count`` / ``last_reply_seq`` / participant set. Because
    a reply is itself a message, a later :class:`Delete` on it (own reply) exercises the
    delete-side recompute (the count must decrement, the ghost participant must drop).
    Rooting only on NON-reply messages keeps threads flat, so every generated reply is
    Accepted and the thread state is genuinely exercised.
    """

    actor: int
    stream: int
    msg: int
    text: str


Op = (
    Send
    | DuplicateSend
    | DisconnectMidFlush
    | ReconnectCatchup
    | ConcurrentSendBurst
    | React
    | Unreact
    | ConcurrentReactBurst
    | Edit
    | Delete
    | ThreadReply
)

#: Reaction emoji domain sampled by the strategy. Deliberately exercises the
#: OPAQUE-BYTES contract (ENG-96 / ENG-97): a plain emoji, a base emoji and its
#: skin-tone-modified form (distinct byte sequences that must NOT collide under
#: the C-collation uniqueness key), a ZWJ family sequence, an ASCII string, and a
#: C1 control character (U+0001 — a legal <=64-byte non-NUL reaction the byte-exact
#: column must store and dedup faithfully). NUL is excluded: Postgres text/JSONB
#: rejects it before the projection, so it can never reach reactions_proj.
REACT_EMOJIS = (
    "\U0001f44d",  # thumbs up
    "\U0001f44d\U0001f3fd",  # thumbs up + skin tone (distinct bytes, must not merge)
    "\U0001f469\u200d\U0001f467",  # ZWJ family sequence
    "x",  # ASCII
    "\u0001",  # C1 control char - opaque bytes, not a grapheme
)


@dataclass(frozen=True)
class Plan:
    """One hypothesis example: member count + a bounded op sequence."""

    n_members: int
    ops: tuple[Op, ...]


# --- bounds (tuned for the <2 min CI budget, R3) ------------------------------

MIN_MEMBERS, MAX_MEMBERS = 2, 4
MAX_OPS = 12
MAX_BURST = 3
#: How many distinct messages a reaction op may reference (resolved modulo the
#: messages actually present in the stream at apply time — a small pool keeps
#: duplicate reactions on the SAME message likely, so the idempotent-add /
#: absent-remove set semantics are exercised, not just distinct singletons).
MAX_MSG_REF = 3
_TEXTS = ("a", "hi", "msg", "z9", "hello")


def _op(n: int) -> st.SearchStrategy[Op]:
    """The op union for a world with ``n`` writers."""
    actor = st.integers(min_value=0, max_value=n - 1)
    stream = st.integers(min_value=0, max_value=1)
    text = st.sampled_from(_TEXTS)
    msg = st.integers(min_value=0, max_value=MAX_MSG_REF - 1)
    emoji = st.integers(min_value=0, max_value=len(REACT_EMOJIS) - 1)
    return st.one_of(
        st.builds(Send, actor=actor, stream=stream, text=text),
        st.builds(DuplicateSend, actor=actor, stream=stream),
        st.builds(DisconnectMidFlush, actor=actor),
        st.builds(ReconnectCatchup, actor=actor),
        st.builds(
            ConcurrentSendBurst,
            stream=stream,
            count=st.integers(min_value=2, max_value=MAX_BURST),
        ),
        st.builds(React, actor=actor, stream=stream, msg=msg, emoji=emoji),
        st.builds(Unreact, actor=actor, stream=stream, msg=msg, emoji=emoji),
        st.builds(
            ConcurrentReactBurst,
            stream=stream,
            msg=msg,
            emoji=emoji,
            count=st.integers(min_value=2, max_value=MAX_BURST),
        ),
        st.builds(Edit, actor=actor, stream=stream, msg=msg, text=text),
        st.builds(Delete, actor=actor, stream=stream, msg=msg),
        st.builds(ThreadReply, actor=actor, stream=stream, msg=msg, text=text),
    )


@st.composite
def plans(draw: st.DrawFn) -> Plan:
    """Draw a :class:`Plan`: ``n`` writers then a bounded op sequence over them."""
    n = draw(st.integers(min_value=MIN_MEMBERS, max_value=MAX_MEMBERS))
    ops = draw(st.lists(_op(n), min_size=0, max_size=MAX_OPS))
    return Plan(n_members=n, ops=tuple(ops))


# --- hypothesis profiles ------------------------------------------------------

_SUPPRESSED = [HealthCheck.too_slow, HealthCheck.function_scoped_fixture]
_registered = False


def register_profiles() -> None:
    """Register + load the ci/dev profiles (idempotent)."""
    global _registered
    if _registered:
        return
    hp_settings.register_profile(
        "ci",
        hp_settings(
            max_examples=25, derandomize=True, deadline=None, suppress_health_check=_SUPPRESSED
        ),
    )
    hp_settings.register_profile(
        "dev",
        hp_settings(max_examples=50, deadline=None, suppress_health_check=_SUPPRESSED),
    )
    hp_settings.load_profile("ci" if os.environ.get("CI") else "dev")
    _registered = True


register_profiles()
