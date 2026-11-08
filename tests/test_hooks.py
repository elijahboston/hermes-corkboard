"""Kanban hook tests: blocked -> text pin with reply_to; secret reasons downgrade to task;
completed / tick clear pins."""

import hermes_plugins.corkboard as corkboard


def test_blocked_hook_pins(registered_ctx, store):
    hook = registered_ctx.hooks["kanban_task_blocked"]
    hook(task_id="t_1", board="core", reason="need nameservers", extra=1)
    pins = store.list_pins()
    assert len(pins) == 1
    p = pins[0]
    assert p["kind"] == "text"
    assert p["question"] == "need nameservers"
    assert p["reply_to"] == "kanban:core/t_1"
    assert p["dedupe_key"] == "kanban:core/t_1"
    assert p["source"] == "kanban:core/t_1"


def test_blocked_hook_secret_reason_downgrades_to_task(registered_ctx, store):
    hook = registered_ctx.hooks["kanban_task_blocked"]
    hook(task_id="t_2", board="core", reason="provide your API key")
    p = store.list_pins()[0]
    assert p["kind"] == "task"
    assert p["title"] == "provide your API key"


def test_blocked_hook_missing_task_id_is_noop(registered_ctx, store):
    registered_ctx.hooks["kanban_task_blocked"](board="core", reason="r")
    assert store.list_pins() == []


def test_completed_hook_marks_done(registered_ctx, store):
    registered_ctx.hooks["kanban_task_blocked"](task_id="t_3", board="core", reason="r")
    registered_ctx.hooks["kanban_task_completed"](task_id="t_3", board="core")
    assert store.list_pins()[0]["status"] == "done"


def test_tick_clears_unblocked(registered_ctx, store, monkeypatch):
    registered_ctx.hooks["kanban_task_blocked"](task_id="t_4", board="core", reason="r")
    registered_ctx.hooks["kanban_task_blocked"](task_id="t_5", board="core", reason="r")
    monkeypatch.setattr(corkboard, "_blocked_task_ids", lambda board: {"t_5"})
    registered_ctx.hooks["on_kanban_dispatch_tick"](board="core", dry_run=False)
    by_key = {p["dedupe_key"]: p for p in store.list_pins()}
    assert by_key["kanban:core/t_4"]["status"] == "done"
    assert by_key["kanban:core/t_5"]["status"] == "open"


def test_tick_dry_run_skips(registered_ctx, store, monkeypatch):
    registered_ctx.hooks["kanban_task_blocked"](task_id="t_6", board="core", reason="r")
    monkeypatch.setattr(corkboard, "_blocked_task_ids", lambda board: set())
    registered_ctx.hooks["on_kanban_dispatch_tick"](board="core", dry_run=True)
    assert store.list_pins()[0]["status"] == "open"
