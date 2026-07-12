"""The SDK's stdlib ULID minting matches the server's typed-id contract."""

from __future__ import annotations

from msg_sdk import ids


def test_event_id_is_bare_ulid() -> None:
    eid = ids.new_event_id()
    assert len(eid) == 26
    assert ids.is_valid_ulid(eid)
    assert "_" not in eid  # bare, no prefix (TDD §2.1)


def test_typed_ids_carry_the_right_prefix() -> None:
    assert ids.new_message_id().startswith("m_")
    assert ids.new_file_id().startswith("f_")
    assert ids.new_workspace_id().startswith("w_")
    assert ids.new_user_id().startswith("u_")
    assert ids.new_stream_id().startswith("s_")
    assert ids.new_device_id().startswith("d_")
    # The remainder after the prefix is a valid 26-char ULID.
    assert ids.is_valid_ulid(ids.new_message_id()[2:])


def test_encoder_charset_and_first_char() -> None:
    for _ in range(1000):
        u = ids.new_ulid()
        assert len(u) == 26
        assert set(u) <= set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
        # 26*5 = 130 bits with 2 leading zero bits ⇒ first char is always <= '7'.
        assert u[0] in "01234567"


def test_encode_decode_round_trips() -> None:
    for _ in range(1000):
        u = ids.new_ulid()
        assert ids.ulid_to_bytes(u).__len__() == 16
        # Re-encoding the decoded bytes reproduces the string exactly.
        from msg_sdk.ids import _encode_ulid  # noqa: PLC0415 - white-box round-trip

        assert _encode_ulid(ids.ulid_to_bytes(u)) == u


def test_strictly_monotonic() -> None:
    previous = ids.new_ulid()
    for _ in range(5000):
        current = ids.new_ulid()
        assert current > previous  # strictly increasing, even within a millisecond
        previous = current


def test_is_valid_ulid_rejects_junk() -> None:
    assert not ids.is_valid_ulid("too-short")
    assert not ids.is_valid_ulid("I" * 26)  # 'I' is not in the Crockford alphabet
    assert not ids.is_valid_ulid("Z" * 26)  # overflows 128 bits (first char > '7')
