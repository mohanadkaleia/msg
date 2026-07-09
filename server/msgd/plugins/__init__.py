"""Plugin surfaces (TDD §10, M5): the public incoming-webhook receiver.

``msgd.plugins.hooks`` is the UNAUTHENTICATED capability endpoint
``POST /v1/hooks/{token}``; the owner/admin management surface lives in
``msgd.api.routers.plugins``. Outgoing subscriptions are deferred (ENG-160).
"""
