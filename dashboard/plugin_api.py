"""Corkboard dashboard plugin backend, mounted at /api/plugins/corkboard/.

Runs inside the gateway process; the desktop half reaches it through ``ctx.rest``. Every
mutation goes through ``actions``, which broadcasts ``plugin.corkboard.pins.changed`` so open
panes/pages refetch.

Handlers are plain ``def`` on purpose: they do blocking SQLite and subprocess work, so
FastAPI runs them in its threadpool instead of on the event loop.
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
def list_pins(status: str = "open", sort: str = "newest") -> list[dict[str, Any]]:
    store = _store()
    store_mod.maybe_purge(store, _retention_days())
    try:
        return actions.list_pins(store, status=status, sort=sort)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/pins/{pin_id}/done")
def done(pin_id: str) -> dict[str, Any]:
    row = _require(pin_id)
    return actions.done(_store(), row["id"])


@router.post("/pins/{pin_id}/dismiss")
def dismiss(pin_id: str) -> dict[str, Any]:
    row = _require(pin_id)
    return actions.dismiss(_store(), row["id"])


@router.post("/pins/{pin_id}/reopen")
def reopen(pin_id: str) -> dict[str, Any]:
    row = _require(pin_id)
    return actions.reopen(_store(), row["id"])


class AnswerBody(BaseModel):
    answer: str
    note: Optional[str] = None


@router.post("/pins/{pin_id}/answer")
def answer(pin_id: str, body: AnswerBody) -> dict[str, Any]:
    row = _require(pin_id)
    try:
        updated = actions.answer(_store(), row["id"], body.answer, note=body.note)
    except actions.DeliveryFailed as exc:
        # The pin stays open; tell the caller the answer did not reach its destination.
        raise HTTPException(status_code=502, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return updated
