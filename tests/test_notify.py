"""Every pin write tells open desktop panes to refetch (``pins.changed``), from whichever
surface made it: the agent tool, CLI/slash actions, kanban hooks and checks. A broadcast
failure never breaks the write."""

import pytest

import hermes_plugins.corkboard as corkboard
from hermes_plugins.corkboard import actions, checks


@pytest.fixture
def events(monkeypatch):
    seen = []
    monkeypatch.setattr(actions, "broadcast_pin_event", lambda event, payload: seen.append((event, payload)))
    return seen


def _changed(events):
    return [p for e, p in events if e == "pins.changed"]


def test_agent_pin_broadcasts(registered_ctx, store, events):
    registered_ctx.tools["corkboard"]["handler"]({"action": "pin", "title": "x"})
    assert _changed(events) and _changed(events)[-1]["status"] == "open"


def test_done_dismiss_answer_broadcast(store, events):
    a = actions.pin(store, title="a")
    b = actions.pin(store, title="b")
    c = actions.pin(store, title="c", kind="yes_no", question="ok?")
    events.clear()
    actions.done(store, a["id"])
    actions.dismiss(store, b["id"])
    actions.answer(store, c["id"], "yes")
    assert [p["status"] for p in _changed(events)] == ["done", "dismissed", "done"]


def test_kanban_hooks_broadcast(registered_ctx, store, events, monkeypatch):
    registered_ctx.hooks["kanban_task_blocked"](task_id="t_1", board="core", reason="r")
    registered_ctx.hooks["kanban_task_blocked"](task_id="t_2", board="core", reason="r")
    events.clear()
    registered_ctx.hooks["kanban_task_completed"](task_id="t_1", board="core")
    assert len(_changed(events)) == 1
    monkeypatch.setattr(corkboard, "_blocked_task_ids", lambda board: set())
    registered_ctx.hooks["on_kanban_dispatch_tick"](board="core", dry_run=False)
    assert len(_changed(events)) == 2


def test_checks_broadcast(store, events, monkeypatch):
    actions.pin(store, title="ns", check_kind="dns_ns", check_arg="example.com=ns.example.net")
    monkeypatch.setitem(checks._CHECKS, "dns_ns", lambda arg: (True, "ok"))
    events.clear()
    actions.run_checks(store)
    assert _changed(events)


def test_broadcast_failure_never_breaks_a_write(store, monkeypatch):
    def boom(event, payload):
        raise RuntimeError("no gateway")

    monkeypatch.setattr(actions, "broadcast_pin_event", boom)
    row = actions.pin(store, title="still pinned")
    assert store.get(row["id"])["status"] == "open"
