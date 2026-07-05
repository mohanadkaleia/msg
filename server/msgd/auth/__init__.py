"""Auth primitives (ENG-64): passwords, opaque tokens, sessions, rate limiting.

Pure logic with no FastAPI coupling (the one exception is :mod:`msgd.api.deps`,
which lives in the API layer). Routers and the ``require_auth`` dependency build
on these.
"""
