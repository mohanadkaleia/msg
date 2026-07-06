"""Single-origin SPA serving (ENG-75, TDD §5.1 D4, §10/§11).

The built web client (``web/dist``) is served by the FastAPI app at ``/`` so the
browser sees one origin — no CORS, simple cookie/session handling (D4). This
module holds the :class:`SPAStaticFiles` mount used by ``create_app()``.

Two properties make it safe to mount at ``/`` without shadowing the API:

* **Registration order** — the mount is added *last* in ``create_app()``, after
  every ``include_router`` call. Starlette matches routes in registration order,
  so specific API paths (``/v1/*``, ``/healthz``, ``/metrics``) always win and
  only genuinely unmatched paths reach this mount.
* **Reserved-prefix guard (belt-and-suspenders)** — even if such a path reached
  the mount, :class:`SPAStaticFiles` re-raises the 404 (rather than returning
  ``index.html``) for any path under a reserved API prefix, so an unknown
  ``/v1/whatever`` still 404s as JSON, never a masked HTML page.

The SPA fallback (return ``index.html`` for an otherwise-404 path) is what makes
Vue Router history-mode deep links like ``/channel/abc`` work on a hard reload.
"""

from __future__ import annotations

from starlette.exceptions import HTTPException
from starlette.responses import Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

# Top-level API/tooling prefixes that must never be answered with the SPA
# index.html. Compared against the mount-relative path (the mount is at "/"), so
# "v1/ws" is covered by "v1". Single source of truth: a future top-level API
# route registers its prefix here.
#
# docs/redoc/openapi.json are reserved so that when docs are DISABLED (the
# secure prod default, PR #12) these paths stay 404 instead of falling through
# to the SPA shell — masking the disable would silently undo that hardening.
# When docs are ENABLED the routes register first and win, so the guard never
# fires for them; reserving the prefixes is therefore harmless in that case.
RESERVED_API_PREFIXES = ("v1", "healthz", "metrics", "docs", "redoc", "openapi.json")


class SPAStaticFiles(StaticFiles):
    """``StaticFiles`` with an SPA fallback that refuses reserved API prefixes."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        try:
            return await super().get_response(path, scope)
        except HTTPException as exc:
            # Only rewrite genuine not-found to the SPA shell; propagate anything
            # else (e.g. 405) unchanged.
            if exc.status_code != 404:
                raise
            first_segment = path.split("/", 1)[0]
            if first_segment in RESERVED_API_PREFIXES:
                # Unknown API path — keep the real 404 (JSON), do not mask it.
                raise
            # Client-side route (Vue Router history mode) — serve the app shell.
            return await super().get_response("index.html", scope)
