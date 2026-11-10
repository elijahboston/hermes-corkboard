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


def test_tick_failed_lookup_keeps_pins_open(registered_ctx, store, monkeypatch):
    registered_ctx.hooks["kanban_task_blocked"](task_id="t_7", board="core", reason="r")
    monkeypatch.setattr(corkboard, "_blocked_task_ids", lambda board: None)
    registered_ctx.hooks["on_kanban_dispatch_tick"](board="core", dry_run=False)
    assert store.list_pins()[0]["status"] == "open"


def test_tick_empty_lookup_clears_pins(registered_ctx, store, monkeypatch):
    registered_ctx.hooks["kanban_task_blocked"](task_id="t_8", board="core", reason="r")
    monkeypatch.setattr(corkboard, "_blocked_task_ids", lambda board: set())
    registered_ctx.hooks["on_kanban_dispatch_tick"](board="core", dry_run=False)
    assert store.list_pins(status="done")[0]["dedupe_key"] == "kanban:core/t_8"


class _Proc:
    def __init__(self, returncode, stdout):
        self.returncode, self.stdout = returncode, stdout


def test_blocked_task_ids_distinguishes_failure(monkeypatch):
    import subprocess

    cases = [
        (_Proc(1, ""), None),
        (_Proc(0, "not json"), None),
        (_Proc(0, "{}"), None),
        (_Proc(0, "[]"), set()),
        (_Proc(0, '[{"id": "t_1"}, {"x": 1}]'), {"t_1"}),
    ]
    for proc, expected in cases:
        monkeypatch.setattr(subprocess, "run", lambda *a, _p=proc, **k: _p)
        assert corkboard._blocked_task_ids("core") == expected

    def boom(*a, **k):
        raise subprocess.TimeoutExpired("hermes", 20)

    monkeypatch.setattr(subprocess, "run", boom)
    assert corkboard._blocked_task_ids("core") is None


def test_tick_dry_run_skips(registered_ctx, store, monkeypatch):
    registered_ctx.hooks["kanban_task_blocked"](task_id="t_6", board="core", reason="r")
    monkeypatch.setattr(corkboard, "_blocked_task_ids", lambda board: set())
    registered_ctx.hooks["on_kanban_dispatch_tick"](board="core", dry_run=True)
    assert store.list_pins()[0]["status"] == "open"
