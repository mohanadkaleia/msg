"""PERMANENT GATE — server side of rebuild ≡ incremental (§12 invariant 6); never delete.

The Postgres analogue of ``cli/tests/test_equivalence_gate.py`` (ENG-61). The M0
CLI gate proves the invariant for the SQLite projection; this file proves it for
the server's ``messages_proj`` against a real Postgres (testcontainer). It is the
M1 exit gate (TDD §5) and gets its own named CI step; keep both.

Three parts, mirroring ENG-61:

1. **Property test — rebuild ≡ incremental + D9 skip.** A hypothesis plan of
   interleaved ``message.created`` v1 (~40%), unknown-type (~10%),
   ``reaction.added``/``reaction.removed`` v1 (~30%), and ``message.edited`` /
   ``message.deleted`` v1 (~20%, ENG-98) events is driven **through**
   ``insert_event`` directly (the exact accept-path hook, without the per-example
   auth/stream-bootstrap overhead of the HTTP path — the ENG-61 in-process
   discipline). Incremental dumps == rebuilt dumps, byte for byte, for BOTH
   first-class projections (``messages_proj`` AND ``reactions_proj``, ENG-97); the
   message row count equals the number of ``message.created`` actions (unknown
   types + reactions leave zero ``messages_proj`` rows; edits/deletes MUTATE
   existing rows but add none); a second rebuild is idempotent. Reactions +
   edits/deletes target real prior messages with a small emoji/msg pool, so
   duplicate adds + absent removes, repeated edits (LWW), and edit-after-delete
   (terminality) are exercised. The ``messages_proj`` dump now carries
   ``edited_seq`` + ``deleted`` (ENG-98), so the gate proves the LWW winner + the
   tombstone/redaction rebuild byte-for-byte.
2. **Mutation / teeth test.** A positive control (unpatched rebuild matches),
   then a one-sided corruption of the rebuild pass only, asserting the dumps now
   differ — proving the gate's ``==`` has teeth. One for ``messages_proj`` (corrupt
   a row), one for ``reactions_proj`` (skip a ``reaction.removed``), and one for the
   edit/delete side (skip a ``message.deleted`` so a tombstone's content wrongly
   survives the rebuild) — all via the same
   ``monkeypatch.setitem(apply_mod._HANDLERS, …)`` mechanism.
3. **Real-upload smoke.** A true ``POST /v1/events/batch`` batch through the
   ``client`` fixture, proving the ``insert.py`` hook fires on the real accept
   path end to end.

**Per-example state reset (the single easiest thing to get wrong).** The
container is session-scoped and the harness rolls back per *test*, not per
hypothesis *example*. So the property test takes the session-scoped
``migrated_db`` URL and, inside each ``@given`` example, opens a short-lived
engine and TRUNCATEs the working tables at the **start of every example** — the
server analogue of ENG-61's "fresh dir per example, NOT the tmp_path fixture".
It also truncates at the **end** of each example so the committed rows the
rebuild leaves behind never leak into sibling tests. Because only session-scoped
and no function-scoped fixtures are consumed inside ``@given``, the
``function_scoped_fixture`` HealthCheck never fires.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from typing import Any

from authutil import do_setup
from eventsutil import bootstrap_channel, custom_body, message_body, post_batch, wire_item
from httpx import AsyncClient
from hypothesis import given, settings
from hypothesis import strategies as st
from msgd.core import ids
from msgd.core.envelope import Body
from msgd.core.payloads import build_message_created_body
from msgd.core.time import now_rfc3339
from msgd.db.models import MessageProj, Stream, Workspace
from msgd.events.insert import insert_event
from msgd.projections import apply as apply_mod
from msgd.projections.dump import dump_messages_proj, dump_reactions_proj
from msgd.projections.rebuild import rebuild_projections
from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

# --- determinism (module docstring / ENG-61) --------------------------------
#
# Applied as a LOCAL @settings on the property test rather than a global
# load_profile, so the M0 CLI gate's own "ci"/"dev" profiles stay byte-for-byte
# untouched when both gate files are collected in one session. CI (GitHub sets
# CI=true) → derandomized, hermetic, no deadline. max_examples is smaller than
# the CLI's 60 because each example does real PG round-trips + two truncates.
_CI = os.environ.get("CI", "").strip().lower() in {"1", "true", "yes", "on"}
_GATE_SETTINGS = (
    settings(max_examples=45, deadline=None, derandomize=True, database=None)
    if _CI
    else settings(max_examples=60, deadline=None)
)

_RESET = (
    "TRUNCATE messages_proj, reactions_proj, events, stream_members, streams, workspaces CASCADE"
)

#: Reaction emoji domain for the gate — exercises the OPAQUE-BYTES contract (a base
#: emoji, that emoji WITH a skin-tone modifier — a distinct byte sequence that must
#: NOT merge under the C-collation uniqueness key — an ASCII string, and a C1
#: control char). Small on purpose so duplicate adds on the same (message, emoji)
#: are likely.
_GATE_EMOJIS = ("\U0001f44d", "\U0001f44d\U0001f3fd", "x", "\u0001")


# --- send-plan strategy (ENG-61 shape) --------------------------------------


@dataclass(frozen=True)
class _Action:
    """One randomized event: a message, unknown type, reaction, edit, or delete.

    ``react_add`` / ``react_remove`` / ``edited`` / ``deleted`` target a message
    previously created in the same stream (resolved modulo ``msg`` at apply time; a
    no-op if the stream has no message yet). Reactions build/tear down the
    ``reactions_proj`` set (ENG-97); ``edited`` (LWW ``text``/``edited_seq``) and
    ``deleted`` (tombstone + ``text`` redaction) MUTATE ``messages_proj`` rows —
    the interleaved edit/delete coverage the permanent gate must keep proving
    rebuild-equivalent (ENG-98), with a small ``msg`` pool so repeated edits on the
    same message exercise LWW and edit-after-delete exercises terminality.
    """

    kind: str  # "created" | "unknown" | "react_add" | "react_remove" | "edited" | "deleted"
    stream: str
    text: str = ""
    format: str = "markdown"
    thread_root_id: str | None = None
    emoji: str = ""
    msg: int = 0


@st.composite
def _send_plan(draw: st.DrawFn) -> list[_Action]:
    """1–4 streams, 0–30 interleaved actions: ~50% created, ~10% unknown, ~40% reactions.

    ``st.characters(codec="utf-8")`` excludes lone surrogates (which JCS/asyncpg
    reject upstream). ``exclude_characters="\\x00"`` drops U+0000: Postgres text /
    JSONB cannot store a NUL, so the real accept path rejects such an event as a
    class-22 data exception at the ``events`` insert — *before* the projection is
    ever reached (ENG-69 Pin 5 note). Generating only text the server can store
    keeps the gate exercising the projection, not asyncpg's NUL guard. Empty text
    is valid; ``thread_root_id`` is sometimes set; ``min_size=0`` covers the
    empty-projection edge (dump == "").
    """
    n_streams = draw(st.integers(min_value=1, max_value=4))
    streams = [f"s{i}" for i in range(n_streams)]

    created = st.builds(
        _Action,
        kind=st.just("created"),
        stream=st.sampled_from(streams),
        text=st.text(
            st.characters(codec="utf-8", exclude_characters="\x00"), min_size=0, max_size=200
        ),
        format=st.sampled_from(["markdown", "plain"]),
        thread_root_id=st.none() | st.builds(ids.new_message_id),
    )
    unknown = st.builds(_Action, kind=st.just("unknown"), stream=st.sampled_from(streams))
    emoji = st.sampled_from(_GATE_EMOJIS)
    msg = st.integers(min_value=0, max_value=3)
    react_add = st.builds(
        _Action, kind=st.just("react_add"), stream=st.sampled_from(streams), emoji=emoji, msg=msg
    )
    react_remove = st.builds(
        _Action, kind=st.just("react_remove"), stream=st.sampled_from(streams), emoji=emoji, msg=msg
    )
    edited = st.builds(
        _Action,
        kind=st.just("edited"),
        stream=st.sampled_from(streams),
        text=st.text(
            st.characters(codec="utf-8", exclude_characters="\x00"), min_size=0, max_size=200
        ),
        msg=msg,
    )
    deleted = st.builds(_Action, kind=st.just("deleted"), stream=st.sampled_from(streams), msg=msg)

    def _pick(n: int) -> st.SearchStrategy[_Action]:
        # ~10% unknown, ~20% react_add, ~10% react_remove, ~10% edited, ~10% deleted,
        # ~40% created — created stays the plurality (rows to mutate) while reactions
        # build/tear down the set and edits/deletes mutate messages_proj rows, with a
        # small emoji/msg pool forcing duplicate adds, absent removes, repeated edits
        # (LWW), and edit-after-delete (terminality) the rebuild must reproduce.
        if n == 0:
            return unknown
        if n in (1, 2):
            return react_add
        if n == 3:
            return react_remove
        if n == 4:
            return edited
        if n == 5:
            return deleted
        return created

    action = st.integers(min_value=0, max_value=9).flatmap(_pick)
    return draw(st.lists(action, min_size=0, max_size=30))


# --- body builders (server-trusted, exactly like ENG-61 drives append_event) --


def _created_body(
    *, workspace_id: str, stream_id: str, author: str, device: str, action: _Action
) -> dict[str, Any]:
    return build_message_created_body(
        workspace_id=workspace_id,
        stream_id=stream_id,
        author_user_id=author,
        author_device_id=device,
        client_created_at=now_rfc3339(),
        text=action.text,
        format=action.format,
        thread_root_id=action.thread_root_id,
    ).model_dump(mode="json")


def _unknown_body(*, workspace_id: str, stream_id: str, author: str, device: str) -> dict[str, Any]:
    return Body(
        event_id=ids.new_event_id(),
        workspace_id=workspace_id,
        stream_id=stream_id,
        type="widget.exploded",
        type_version=7,
        author_user_id=author,
        author_device_id=device,
        client_created_at=now_rfc3339(),
        payload={"blast_radius": 3},
    ).model_dump(mode="json")


def _reaction_body(
    *,
    workspace_id: str,
    stream_id: str,
    author: str,
    device: str,
    message_id: str,
    emoji: str,
    removed: bool,
) -> dict[str, Any]:
    """A ``reaction.added``/``reaction.removed`` v1 body (server-trusted, ENG-97)."""
    return Body(
        event_id=ids.new_event_id(),
        workspace_id=workspace_id,
        stream_id=stream_id,
        type="reaction.removed" if removed else "reaction.added",
        type_version=1,
        author_user_id=author,
        author_device_id=device,
        client_created_at=now_rfc3339(),
        payload={"message_id": message_id, "emoji": emoji},
    ).model_dump(mode="json")


def _edited_body(
    *,
    workspace_id: str,
    stream_id: str,
    author: str,
    device: str,
    message_id: str,
    text: str,
) -> dict[str, Any]:
    """A ``message.edited`` v1 body (server-trusted, ENG-98)."""
    return Body(
        event_id=ids.new_event_id(),
        workspace_id=workspace_id,
        stream_id=stream_id,
        type="message.edited",
        type_version=1,
        author_user_id=author,
        author_device_id=device,
        client_created_at=now_rfc3339(),
        payload={"message_id": message_id, "text": text, "format": "markdown"},
    ).model_dump(mode="json")


def _deleted_body(
    *,
    workspace_id: str,
    stream_id: str,
    author: str,
    device: str,
    message_id: str,
) -> dict[str, Any]:
    """A ``message.deleted`` v1 body (server-trusted, ENG-98)."""
    return Body(
        event_id=ids.new_event_id(),
        workspace_id=workspace_id,
        stream_id=stream_id,
        type="message.deleted",
        type_version=1,
        author_user_id=author,
        author_device_id=device,
        client_created_at=now_rfc3339(),
        payload={"message_id": message_id},
    ).model_dump(mode="json")


async def _one_example(database_url: str, plan: list[_Action]) -> None:
    """Run one hypothesis example hermetically over its own short-lived engine."""
    engine = create_async_engine(database_url)
    try:
        maker = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with maker() as session:
                await session.execute(text(_RESET))  # hermetic per example (start)

                ws = ids.new_workspace_id()
                author, device = ids.new_user_id(), ids.new_device_id()
                stream_ids = {label: ids.new_stream_id() for label in {a.stream for a in plan}}

                await session.execute(
                    pg_insert(Workspace)
                    .values(workspace_id=ws, name="gate")
                    .on_conflict_do_nothing(index_elements=[Workspace.workspace_id])
                )
                for sid in stream_ids.values():
                    await session.execute(
                        pg_insert(Stream)
                        .values(
                            stream_id=sid,
                            workspace_id=ws,
                            kind="channel",
                            name="c",
                            visibility="public",
                        )
                        .on_conflict_do_nothing(index_elements=[Stream.stream_id])
                    )
                await session.flush()

                n_created = 0
                # message ids created per stream label, so reactions target a real
                # message in the same stream (resolved modulo, or a no-op if none).
                created_by_stream: dict[str, list[str]] = {}
                for action in plan:
                    sid = stream_ids[action.stream]
                    if action.kind == "created":
                        body = _created_body(
                            workspace_id=ws,
                            stream_id=sid,
                            author=author,
                            device=device,
                            action=action,
                        )
                        created_by_stream.setdefault(action.stream, []).append(
                            body["payload"]["message_id"]
                        )
                        n_created += 1
                    elif action.kind == "unknown":
                        body = _unknown_body(
                            workspace_id=ws, stream_id=sid, author=author, device=device
                        )
                    elif action.kind in ("edited", "deleted"):
                        known = created_by_stream.get(action.stream, [])
                        if not known:
                            continue  # no message to edit/delete yet → a no-op
                        target = known[action.msg % len(known)]
                        if action.kind == "edited":
                            body = _edited_body(
                                workspace_id=ws,
                                stream_id=sid,
                                author=author,
                                device=device,
                                message_id=target,
                                text=action.text,
                            )
                        else:
                            body = _deleted_body(
                                workspace_id=ws,
                                stream_id=sid,
                                author=author,
                                device=device,
                                message_id=target,
                            )
                    else:  # react_add / react_remove
                        known = created_by_stream.get(action.stream, [])
                        if not known:
                            continue  # no message to react to yet → the action is a no-op
                        body = _reaction_body(
                            workspace_id=ws,
                            stream_id=sid,
                            author=author,
                            device=device,
                            message_id=known[action.msg % len(known)],
                            emoji=action.emoji,
                            removed=action.kind == "react_remove",
                        )
                    await insert_event(session, stream_id=sid, body=body)

                dump_incremental = await dump_messages_proj(session)
                dump_incremental_reactions = await dump_reactions_proj(session)

                # D9: one row per created action, none for unknown-type events.
                row_count = await session.scalar(select(func.count()).select_from(MessageProj))
                assert row_count == n_created

                # The permanent invariant: rebuild ≡ incremental, byte for byte —
                # for BOTH first-class projections (ENG-97 adds reactions_proj).
                await rebuild_projections(session)
                dump_rebuilt = await dump_messages_proj(session)
                dump_rebuilt_reactions = await dump_reactions_proj(session)
                assert dump_rebuilt == dump_incremental
                assert dump_rebuilt_reactions == dump_incremental_reactions

                # Rebuild is idempotent (both projections).
                await rebuild_projections(session)
                assert await dump_messages_proj(session) == dump_rebuilt
                assert await dump_reactions_proj(session) == dump_rebuilt_reactions
        finally:
            # Defensive end-of-example cleanup so committed rows never leak to
            # sibling tests (rebuild_projections commits).
            async with engine.begin() as conn:
                await conn.execute(text(_RESET))
    finally:
        await engine.dispose()


# --- the gate: property test -------------------------------------------------


@_GATE_SETTINGS
@given(plan=_send_plan())
def test_rebuild_equals_incremental_server(migrated_db: str, plan: list[_Action]) -> None:
    """rebuild ≡ incremental over Postgres, for every generated log (the gate).

    Sync ``@given`` body driving each example through ``asyncio.run`` (ENG-61
    discipline); ``migrated_db`` is session-scoped, so no function-scoped fixture
    is consumed inside ``@given``.
    """
    asyncio.run(_one_example(migrated_db, plan))


# --- the teeth: one-sided mutation ------------------------------------------


async def _seed_stream(db: AsyncSession, *, workspace_id: str, stream_id: str) -> None:
    db.add(Workspace(workspace_id=workspace_id, name="Acme"))
    await db.flush()
    db.add(
        Stream(
            stream_id=stream_id,
            workspace_id=workspace_id,
            kind="channel",
            name="c",
            visibility="public",
        )
    )
    await db.flush()


async def test_gate_detects_single_row_divergence(
    db_session: AsyncSession, monkeypatch: Any
) -> None:
    """Standing proof the gate's ``==`` has teeth: one corrupt row is detected.

    Positive control first (an unpatched rebuild matches the incremental dump).
    Then the ``("message.created", 1)`` handler is patched for the REBUILD pass
    ONLY to corrupt exactly one row — patching one side is essential (a global
    patch would corrupt both sides identically and prove nothing).
    """
    ws, stream = ids.new_workspace_id(), ids.new_stream_id()
    await _seed_stream(db_session, workspace_id=ws, stream_id=stream)
    for t in ["a1", "a2", "a3"]:
        await insert_event(
            db_session,
            stream_id=stream,
            body=build_message_created_body(
                workspace_id=ws,
                stream_id=stream,
                author_user_id=ids.new_user_id(),
                author_device_id=ids.new_device_id(),
                client_created_at=now_rfc3339(),
                text=t,
            ).model_dump(mode="json"),
        )
    dump_incremental = await dump_messages_proj(db_session)

    # Positive control: unpatched rebuild matches.
    await rebuild_projections(db_session)
    assert await dump_messages_proj(db_session) == dump_incremental

    # Corrupting rebuild: real handler, then mutate exactly ONE row once.
    real = apply_mod._HANDLERS[("message.created", 1)]
    corrupted = {"done": False}

    async def _corrupt(db: AsyncSession, *, body: dict[str, Any], server_sequence: int) -> None:
        await real(db, body=body, server_sequence=server_sequence)
        if not corrupted["done"]:
            corrupted["done"] = True
            await db.execute(
                text("UPDATE messages_proj SET text = text || 'X' WHERE message_id = :mid"),
                {"mid": body["payload"]["message_id"]},
            )

    monkeypatch.setitem(apply_mod._HANDLERS, ("message.created", 1), _corrupt)
    await rebuild_projections(db_session)
    monkeypatch.undo()

    assert await dump_messages_proj(db_session) != dump_incremental


async def test_gate_detects_reaction_divergence(db_session: AsyncSession, monkeypatch: Any) -> None:
    """Teeth for the reaction side: a rebuild that SKIPS ``reaction.removed`` must
    turn the ``reactions_proj`` rebuild-equivalence assertion RED (green by default).

    Same one-sided mechanism as the messages teeth above — ``monkeypatch.setitem``
    on ``apply_mod._HANDLERS`` for the REBUILD pass ONLY (patching one side is
    essential; a global patch would mutate both sides identically and prove
    nothing). The injected bug makes ``reaction.removed`` a no-op, so a reaction
    that was added-then-removed (net absent incrementally) wrongly SURVIVES the
    rebuild — the reaction dump diverges.
    """
    ws, stream = ids.new_workspace_id(), ids.new_stream_id()
    await _seed_stream(db_session, workspace_id=ws, stream_id=stream)
    author, device = ids.new_user_id(), ids.new_device_id()
    message_id = ids.new_message_id()
    await insert_event(
        db_session,
        stream_id=stream,
        body=build_message_created_body(
            workspace_id=ws,
            stream_id=stream,
            author_user_id=author,
            author_device_id=device,
            client_created_at=now_rfc3339(),
            text="hi",
            message_id=message_id,
        ).model_dump(mode="json"),
    )

    def _react(emoji: str, *, removed: bool) -> dict[str, Any]:
        return _reaction_body(
            workspace_id=ws,
            stream_id=stream,
            author=author,
            device=device,
            message_id=message_id,
            emoji=emoji,
            removed=removed,
        )

    # 👍 stays; 🎉 is added then removed → net-absent in the incremental set.
    await insert_event(db_session, stream_id=stream, body=_react("\U0001f44d", removed=False))
    await insert_event(db_session, stream_id=stream, body=_react("\U0001f389", removed=False))
    await insert_event(db_session, stream_id=stream, body=_react("\U0001f389", removed=True))
    dump_incremental = await dump_reactions_proj(db_session)

    # Positive control: unpatched rebuild reproduces the set exactly.
    await rebuild_projections(db_session)
    assert await dump_reactions_proj(db_session) == dump_incremental

    # Buggy rebuild: reaction.removed does nothing → the removed 🎉 wrongly survives.
    async def _skip_remove(db: AsyncSession, *, body: dict[str, Any], server_sequence: int) -> None:
        return None

    monkeypatch.setitem(apply_mod._HANDLERS, ("reaction.removed", 1), _skip_remove)
    await rebuild_projections(db_session)
    monkeypatch.undo()

    assert await dump_reactions_proj(db_session) != dump_incremental


async def test_gate_detects_edit_delete_divergence(
    db_session: AsyncSession, monkeypatch: Any
) -> None:
    """Teeth for the edit/delete side: a rebuild that SKIPS ``message.deleted`` (so a
    tombstone's redacted content wrongly survives) OR SKIPS ``message.edited`` (so
    the LWW winner reverts to the original body) must turn the ``messages_proj``
    rebuild-equivalence assertion RED (green by default).

    Same one-sided ``monkeypatch.setitem`` mechanism as the reaction teeth — patch
    the REBUILD pass ONLY (a global patch would mutate both sides identically and
    prove nothing). Because the ``messages_proj`` dump now carries ``text`` +
    ``edited_seq`` + ``deleted`` (ENG-98), either skipped mutation diverges the dump.
    """
    ws, stream = ids.new_workspace_id(), ids.new_stream_id()
    await _seed_stream(db_session, workspace_id=ws, stream_id=stream)
    author, device = ids.new_user_id(), ids.new_device_id()

    def _created(text: str) -> tuple[str, dict[str, Any]]:
        mid = ids.new_message_id()
        return mid, build_message_created_body(
            workspace_id=ws,
            stream_id=stream,
            author_user_id=author,
            author_device_id=device,
            client_created_at=now_rfc3339(),
            text=text,
            message_id=mid,
        ).model_dump(mode="json")

    m_edit, edit_created = _created("orig")
    m_del, del_created = _created("secret")
    await insert_event(db_session, stream_id=stream, body=edit_created)
    await insert_event(db_session, stream_id=stream, body=del_created)
    await insert_event(
        db_session,
        stream_id=stream,
        body=_edited_body(
            workspace_id=ws,
            stream_id=stream,
            author=author,
            device=device,
            message_id=m_edit,
            text="final",
        ),
    )
    await insert_event(
        db_session,
        stream_id=stream,
        body=_deleted_body(
            workspace_id=ws, stream_id=stream, author=author, device=device, message_id=m_del
        ),
    )
    dump_incremental = await dump_messages_proj(db_session)

    # Positive control: unpatched rebuild reproduces the LWW winner + tombstone.
    await rebuild_projections(db_session)
    assert await dump_messages_proj(db_session) == dump_incremental

    async def _skip(db: AsyncSession, *, body: dict[str, Any], server_sequence: int) -> None:
        return None

    # Buggy rebuild #1: message.deleted does nothing → the redacted 'secret' survives.
    monkeypatch.setitem(apply_mod._HANDLERS, ("message.deleted", 1), _skip)
    await rebuild_projections(db_session)
    monkeypatch.undo()
    assert await dump_messages_proj(db_session) != dump_incremental

    # Buggy rebuild #2: message.edited does nothing → 'final' reverts to 'orig'.
    monkeypatch.setitem(apply_mod._HANDLERS, ("message.edited", 1), _skip)
    await rebuild_projections(db_session)
    monkeypatch.undo()
    assert await dump_messages_proj(db_session) != dump_incremental


# --- honest end-to-end wiring: real upload smoke -----------------------------


async def test_upload_hook_fires_end_to_end(client: AsyncClient, db_session: AsyncSession) -> None:
    """A real POST /v1/events/batch projects messages via the ``insert.py`` hook.

    Proves the incremental apply fires on the true accept path (not just direct
    ``insert_event`` calls), that an unknown-type upload leaves no row (D9), and
    that a rebuild of the same log reproduces the projection byte for byte.
    """
    owner = await do_setup(client)
    channel = await bootstrap_channel(client, db_session, owner)

    bodies = [message_body(auth=owner, stream_id=channel, text=t) for t in ["hello", "世界 🌍", ""]]
    items = [wire_item(b) for b in bodies]
    unknown = custom_body(auth=owner, stream_id=channel, type="widget.exploded", type_version=7)
    items.append(wire_item(unknown))

    resp = await post_batch(client, owner["token"], items)
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["rejected"] == []
    assert len(payload["accepted"]) == 4  # unknown type is stored (D9), just not projected

    msg_ids = [b["payload"]["message_id"] for b in bodies]
    landed = await db_session.scalar(
        select(func.count()).select_from(MessageProj).where(MessageProj.message_id.in_(msg_ids))
    )
    assert landed == 3
    # No stray rows: the unknown-type event projected nothing.
    assert await db_session.scalar(select(func.count()).select_from(MessageProj)) == 3

    dump_incremental = await dump_messages_proj(db_session)
    await rebuild_projections(db_session)
    assert await dump_messages_proj(db_session) == dump_incremental
