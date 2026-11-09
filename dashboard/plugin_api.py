"""Corkboard dashboard plugin backend, mounted at /api/plugins/corkboard/.

Runs inside the gateway process; the desktop half reaches it through ``ctx.rest``. Every
mutation broadcasts ``plugin.corkboard.pins.changed`` so open panes/pages refetch.
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from hermes_plugins.corkboard import actions
from hermes_plugins.corkboard import store as store_mod

router = APIRouter()


def _store() -> Any:
    return store_mod.get_store()


def _require(pin_id: str) -> dict[str, Any]:
    row = _store().resolve(pin_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no pin {pin_id!r}")
    return row

def _retention_days() -> int:
    """Read ``plugins.entries.corkboard.settings.retention_days`` (30 when unset)."""
    try:
        from hermes_cli.config import load_config_readonly

        cfg = load_config_readonly() or {}
        entry = (cfg.get("plugins") or {}).get("entries", {}).get("corkboard") or {}
        settings = entry.get("settings") or {}
        return int(settings.get("retention_days", 30))
    except Exception:
        return 30


@router.get("/pins")
async def list_pins(status: str = "open", sort: str = "newest") -> list[dict[str, Any]]:
    store = _store()
    store_mod.maybe_purge(store, _retention_days())
    try:
        return actions.list_pins(store, status=status, sort=sort)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/pins/{pin_id}/done")
async def done(pin_id: str) -> dict[str, Any]:
    row = _require(pin_id)
    store = _store()
    store.mark(row["id"], "done")
    updated = store.get(row["id"])
    actions.broadcast_pin_event("pins.changed", {"id": row["id"], "status": "done"})
    return updated


@router.post("/pins/{pin_id}/dismiss")
async def dismiss(pin_id: str) -> dict[str, Any]:
    row = _require(pin_id)
    store = _store()
    store.mark(row["id"], "dismissed")
    updated = store.get(row["id"])
    actions.broadcast_pin_event("pins.changed", {"id": row["id"], "status": "dismissed"})
    return updated


class AnswerBody(BaseModel):
    answer: str
    note: Optional[str] = None


@router.post("/pins/{pin_id}/answer")
async def answer(pin_id: str, body: AnswerBody) -> dict[str, Any]:
    row = _require(pin_id)
    try:
        updated = actions.answer(_store(), row["id"], body.answer, note=body.note)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    actions.broadcast_pin_event("pins.changed", {"id": updated["id"], "status": "done"})
    return updated
