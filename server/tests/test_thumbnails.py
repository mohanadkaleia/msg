"""Unit tests for :func:`msgd.blobs.thumbnails.render_thumbnail` (ENG-118).

These exercise the pure, synchronous thumbnail renderer directly on crafted bytes —
no DB, no HTTP, no container — so they are fast and prove the hostile-input contract in
isolation:

* a real PNG / JPEG → non-``None`` WEBP whose decoded long edge is ``<= max_px`` and
  whose aspect ratio is preserved;
* a non-image byte string → ``None`` (never raises);
* a truncated image → ``None`` (``LOAD_TRUNCATED_IMAGES`` stays False, so a short
  stream raises internally rather than loading a garbage buffer);
* a decompression bomb (a source whose W×H exceeds ``max_source_pixels``) → ``None``
  (the ``Image.MAX_IMAGE_PIXELS`` guard raises internally and is caught);
* an EXIF-orientation image → transposed, so a sideways-stored photo thumbnails upright
  (its width/height come out swapped).

The API round-trip, authz, dedup-inheritance, and bomb-via-HTTP cases live in
``test_files.py`` (they need the Postgres-backed app fixtures).
"""

from __future__ import annotations

import io

import pytest
from msgd.blobs.thumbnails import render_thumbnail
from PIL import Image

_MAX_PX = 720
_MAX_SOURCE_PX = 24_000_000


def _encode(img: Image.Image, fmt: str, **kwargs: object) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format=fmt, **kwargs)
    return buf.getvalue()


def _decode_size(webp: bytes) -> tuple[int, int]:
    with Image.open(io.BytesIO(webp)) as img:
        assert img.format == "WEBP"
        return img.size


def test_png_renders_webp() -> None:
    """A small solid PNG produces decodable WEBP bytes (identified as WEBP)."""
    source = _encode(Image.new("RGB", (64, 48), (10, 120, 200)), "PNG")
    out = render_thumbnail(source, max_px=_MAX_PX, max_source_pixels=_MAX_SOURCE_PX)
    assert out is not None
    # Round-trips as a WEBP raster (proves we re-encoded to the format we control).
    assert _decode_size(out) == (64, 48)  # smaller than max_px → unchanged (no upscale)


def test_jpeg_renders_webp() -> None:
    """A JPEG source also renders (exercises a different decoder path)."""
    source = _encode(Image.new("RGB", (200, 100), (200, 30, 30)), "JPEG")
    out = render_thumbnail(source, max_px=_MAX_PX, max_source_pixels=_MAX_SOURCE_PX)
    assert out is not None
    assert _decode_size(out) == (200, 100)


def test_downscales_long_edge_and_preserves_aspect() -> None:
    """A large source is downscaled so its long edge is <= max_px, aspect preserved."""
    source = _encode(Image.new("RGB", (2000, 1000), (0, 0, 0)), "PNG")
    out = render_thumbnail(source, max_px=_MAX_PX, max_source_pixels=_MAX_SOURCE_PX)
    assert out is not None
    width, height = _decode_size(out)
    assert max(width, height) <= _MAX_PX  # long edge bounded
    assert (width, height) == (720, 360)  # 2:1 aspect preserved exactly


def test_transparent_png_flattened_to_rgb() -> None:
    """A transparent RGBA PNG flattens onto white and still renders (no crash on alpha)."""
    source = _encode(Image.new("RGBA", (50, 50), (255, 0, 0, 0)), "PNG")
    out = render_thumbnail(source, max_px=_MAX_PX, max_source_pixels=_MAX_SOURCE_PX)
    assert out is not None
    with Image.open(io.BytesIO(out)) as img:
        assert img.mode in ("RGB", "RGBX")  # flattened, no alpha channel carried through


def test_non_image_returns_none() -> None:
    """Arbitrary non-image bytes yield None (and never raise)."""
    assert (
        render_thumbnail(b"not an image at all", max_px=_MAX_PX, max_source_pixels=_MAX_SOURCE_PX)
        is None
    )
    assert render_thumbnail(b"", max_px=_MAX_PX, max_source_pixels=_MAX_SOURCE_PX) is None


def test_truncated_image_returns_none() -> None:
    """A PNG cut off mid-stream yields None (LOAD_TRUNCATED_IMAGES stays False)."""
    full = _encode(Image.new("RGB", (300, 300), (7, 7, 7)), "PNG")
    truncated = full[: len(full) // 2]  # header intact, pixel data cut
    assert render_thumbnail(truncated, max_px=_MAX_PX, max_source_pixels=_MAX_SOURCE_PX) is None


def test_decompression_bomb_returns_none() -> None:
    """A source whose W×H exceeds max_source_pixels is rejected by the bomb guard.

    Uses a REAL 2000×2000 image (4 MP) against a deliberately tiny 1 MP cap, so the
    ``Image.MAX_IMAGE_PIXELS`` guard raises internally and render_thumbnail returns
    None — no need to allocate an actually-enormous buffer to prove the bound.
    """
    source = _encode(Image.new("RGB", (2000, 2000), (1, 2, 3)), "PNG")
    assert render_thumbnail(source, max_px=_MAX_PX, max_source_pixels=1_000_000) is None
    # The same bytes are fine under a cap above their pixel count (guard is the bound).
    assert render_thumbnail(source, max_px=_MAX_PX, max_source_pixels=_MAX_SOURCE_PX) is not None


@pytest.mark.filterwarnings("ignore::PIL.Image.DecompressionBombWarning")
def test_bomb_in_1x_2x_band_returns_none() -> None:
    """A source in the 1×–2× band (over the cap, under 2×) is rejected deterministically.

    Regression for the review-round hardening: the old warnings-filter promotion made
    this band thread-order-dependent. The explicit pre-decode pixel check rejects it
    unconditionally. 2.25 MP source against a 2 MP cap sits between 1× and 2×.

    Pillow still emits an INFORMATIONAL DecompressionBombWarning at ``Image.open`` (the
    ``MAX_IMAGE_PIXELS`` backstop is set to the cap); it is filtered here because our
    explicit pixel check — not the warning — is what enforces the rejection.
    """
    source = _encode(Image.new("RGB", (1500, 1500), (9, 9, 9)), "PNG")  # 2.25 MP
    assert render_thumbnail(source, max_px=_MAX_PX, max_source_pixels=2_000_000) is None


def test_multiframe_gif_thumbnails_single_frame() -> None:
    """A multi-frame animated source thumbnails frame 0 as a SINGLE-frame WEBP.

    Proves no frame-count amplification: an N-frame GIF/APNG yields one still frame,
    not an N-frame animation.
    """
    frames = [Image.new("RGB", (80, 60), (i * 60, 0, 0)) for i in range(3)]
    buf = io.BytesIO()
    frames[0].save(buf, format="GIF", save_all=True, append_images=frames[1:], loop=0)
    out = render_thumbnail(buf.getvalue(), max_px=_MAX_PX, max_source_pixels=_MAX_SOURCE_PX)
    assert out is not None
    with Image.open(io.BytesIO(out)) as thumb:
        assert thumb.format == "WEBP"
        assert getattr(thumb, "n_frames", 1) == 1  # single frame, no animation carried


def test_exif_orientation_is_applied() -> None:
    """An EXIF orientation-6 (rotate 90°) source is transposed: its dims come out swapped.

    The stored raster is LANDSCAPE (120×40) but tagged to display rotated 90°, so the
    correctly-oriented thumbnail is PORTRAIT (taller than wide). Asserting the swap
    proves exif_transpose ran — a sideways phone photo thumbnails upright.
    """
    img = Image.new("RGB", (120, 40), (0, 128, 0))
    exif = img.getexif()
    exif[0x0112] = 6  # Orientation tag = "Rotate 90 CW"
    source = _encode(img, "JPEG", exif=exif)
    out = render_thumbnail(source, max_px=_MAX_PX, max_source_pixels=_MAX_SOURCE_PX)
    assert out is not None
    width, height = _decode_size(out)
    assert height > width  # landscape source displayed as portrait → transpose applied
