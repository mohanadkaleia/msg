"""Server-side projections (ENG-69, TDD §4.2/§5).

The Postgres analogue of the M0 SQLite projection (ENG-58/59/61): an
**incremental apply** run inside the accept transaction (:mod:`apply`), a
first-class **rebuild** (:mod:`rebuild`), and a deterministic **dump**
(:mod:`dump`) that is the equivalence surface the server gate diffs. The
permanent invariant ``rebuild ≡ incremental`` holds *by construction* because
both paths funnel through the single :func:`msgd.projections.apply.apply_projection`.
"""

from __future__ import annotations
