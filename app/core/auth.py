from __future__ import annotations

import os
from fastapi import Request, HTTPException


def require_auth(request: Request) -> None:
    """Very small auth gate: Bearer token in Authorization header.

    Set DBSVC_ADMIN_TOKEN in env. If not set, auth is disabled (dev-friendly).
    """
    token_expected = os.getenv("DBSVC_ADMIN_TOKEN", "").strip()
    if not token_expected:
        return

    auth = request.headers.get("authorization") or request.headers.get("Authorization")
    if not auth:
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    parts = auth.split()
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Use: Authorization: Bearer <token>")

    if parts[1] != token_expected:
        raise HTTPException(status_code=403, detail="Invalid token")
