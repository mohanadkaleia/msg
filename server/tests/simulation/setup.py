"""World bootstrap — workspace + N members + adversary + public/private channels (§4).

Everything is driven through the **real** endpoints (``/v1/setup``, the invite
flow, ``POST /v1/events/batch``) so the sim exercises the real accept + reducer +
membership-bootstrap path end to end — the whole point of an *acceptance* harness.
A direct DB seed would bypass exactly the permission-bootstrap code the adversary
invariant is meant to prove.

**R1 (verified against ``msgd/events/reducers.py``):** the merged M1 reducer
**does** support ``channel.member_added`` (``_reduce_channel_member_added`` is
registered in ``REDUCERS``; ``can_write`` allows it for owner/admin; ``validate``
homes a private-channel lifecycle event self-homed in the channel's own stream).
So private membership is expressed the natural way — the owner uploads a real
``channel.member_added`` per member.  The genesis creator (owner) is auto-added by
``_reduce_channel_created``.  The adversary is **never** added, either way.

*Simplification (M1 skeleton):* every non-adversary actor joins the private
channel, so any actor may write either stream and the runner stays membership-
agnostic.  Partial private membership (a strict subset) is an M2 strategy seam —
the load-bearing property here is adversary **exclusion**, which holds regardless.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from authutil import accept_invite, create_invite, do_setup, join_token
from eventsutil import bootstrap_channel, lifecycle_body, post_batch, wire_item
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from simulation.client import SimClient

#: Stream index in an op: 0 = the shared public channel, 1 = the private channel.
PUBLIC, PRIVATE = 0, 1


@dataclass
class World:
    """A fully bootstrapped simulation world (one hypothesis example)."""

    http: AsyncClient
    engine: AsyncEngine
    owner: SimClient
    #: writers = owner + invited members; the adversary is deliberately excluded.
    actors: list[SimClient]
    adversary: SimClient
    public_stream: str
    private_stream: str
    #: filled in during settle for the permission-isolation invariant.
    adversary_visible: set[str] = field(default_factory=set)
    adversary_private_forbidden: bool = False
    #: ENG-97 reaction isolation: True once the adversary's attempt to react to a
    #: private-stream message it cannot read was refused (or vacuously, when the
    #: private stream had no message to probe).
    adversary_reaction_forbidden: bool = True
    #: ENG-98 edit/delete isolation: True once the adversary's attempt to edit AND
    #: delete a message it did NOT author (a public message it CAN read) was refused
    #: by the author-or-admin rule (or vacuously, when there was no such message).
    adversary_edit_forbidden: bool = True
    #: ENG-99 thread isolation: True once the adversary's attempt to REPLY into the
    #: private stream it cannot read was refused at the stream gate (or vacuously,
    #: when the private stream had no root to probe).
    adversary_thread_reply_forbidden: bool = True

    @property
    def shared_streams(self) -> list[str]:
        return [self.public_stream, self.private_stream]

    def stream_id(self, index: int) -> str:
        """Map a strategy stream index (0/1) to a real stream id."""
        return self.public_stream if index == PUBLIC else self.private_stream


async def _invite_member(
    http: AsyncClient, owner: SimClient, *, email: str, display_name: str
) -> dict[str, Any]:
    """Owner creates a member invite; a fresh principal accepts it → its ``Auth``."""
    invite = await create_invite(http, owner.token, role="member")
    assert invite.status_code == 201, invite.text
    raw = join_token(invite.json()["url"])
    accepted = await accept_invite(http, raw, email=email, display_name=display_name)
    assert accepted.status_code == 200, accepted.text
    auth: dict[str, Any] = accepted.json()
    return auth


async def _add_private_member(
    http: AsyncClient, owner_auth: dict[str, Any], private_stream: str, user_id: str
) -> None:
    """Owner uploads a real ``channel.member_added`` (self-homed in the private stream)."""
    body = lifecycle_body(
        auth=owner_auth,
        home_stream_id=private_stream,  # private lifecycle events are self-homed (§2.2)
        type="channel.member_added",
        payload={"channel_stream_id": private_stream, "user_id": user_id},
    )
    resp = await post_batch(http, owner_auth["token"], [wire_item(body)])
    assert resp.status_code == 200 and len(resp.json()["accepted"]) == 1, resp.text


async def build_world(http: AsyncClient, engine: AsyncEngine, *, n_members: int) -> World:
    """Bootstrap a workspace with ``n_members`` writers + 1 adversary + two channels."""
    owner_auth = await do_setup(http)
    owner = SimClient(http, owner_auth)
    actors: list[SimClient] = [owner]

    for i in range(n_members - 1):
        auth = await _invite_member(
            http, owner, email=f"member{i}@example.com", display_name=f"M{i}"
        )
        actors.append(SimClient(http, auth))

    adversary_auth = await _invite_member(
        http, owner, email="adversary@example.com", display_name="Adversary"
    )
    adversary = SimClient(http, adversary_auth, is_adversary=True)

    # Channels through the REAL upload endpoint. bootstrap_channel needs a session
    # to read the workspace-meta id; open one on the committing engine.
    maker = async_sessionmaker(engine, expire_on_commit=False)
    async with maker() as db:
        public_stream = await bootstrap_channel(
            http, db, owner_auth, visibility="public", name="public"
        )
        private_stream = await bootstrap_channel(
            http, db, owner_auth, visibility="private", name="private"
        )

    # Private membership: every non-adversary actor (owner auto-added at genesis).
    for actor in actors:
        if actor is owner:
            continue
        await _add_private_member(http, owner_auth, private_stream, actor.user_id)

    return World(
        http=http,
        engine=engine,
        owner=owner,
        actors=actors,
        adversary=adversary,
        public_stream=public_stream,
        private_stream=private_stream,
    )
