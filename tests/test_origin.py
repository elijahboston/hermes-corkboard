"""Origin recording: agent context session_id (never tool args), per-surface kinds, backfill."""

import json
import sqlite3

from hermes_plugins.corkboard import actions, store as store_mod


def _tool(registered_ctx):
    return registered_ctx.tools["corkboard"]["handler"]


def test_agent_pin_records_context_session_id(registered_ctx, store, monkeypatch):
    monkeypatch.setattr(store_mod, "current_profile_name", lambda: "worker")
    handler = _tool(registered_ctx)
    out = json.loads(handler({"action": "pin", "title": "File LLC"}, session_id="sess-1", platform="cli"))
    pin = out["pin"]
    assert pin["origin_kind"] == "session"
    assert pin["origin_profile"] == "worker"
    assert pin["origin_session_id"] == "sess-1"
    assert pin["origin_platform"] == "cli"


def test_agent_pin_ignores_session_id_in_tool_args(registered_ctx, store, monkeypatch):
    monkeypatch.setattr(store_mod, "current_profile_name", lambda: "worker")
    handler = _tool(registered_ctx)
    out = json.loads(handler({"action": "pin", "title": "File LLC", "session_id": "forged", "platform": "forged"}))
    pin = out["pin"]
    assert pin["origin_session_id"] is None
    assert pin["origin_platform"] is None
    assert pin["origin_profile"] == "worker"


def test_kanban_origin_kind(registered_ctx, store):
    registered_ctx.hooks["kanban_task_blocked"](task_id="t_1", board="core", reason="r")
    pin = store.list_pins()[0]
    assert pin["origin_kind"] == "kanban"


class _Args:
    def __init__(self, cmd, **kw):
        self.corkboard_command = cmd
        self.__dict__.update(kw)


def test_cli_add_origin_kind(registered_ctx, store):
    handler = registered_ctx.cli_commands["corkboard"]["handler_fn"]
    handler(_Args("add", title="CLI pin"))
    pin = store.list_pins()[0]
    assert pin["origin_kind"] == "cli"


def test_slash_add_origin_kind(registered_ctx, store):
    handler = registered_ctx.commands["corkboard"]["handler"]
    handler("add Slash pin")
    pin = store.list_pins()[0]
    assert pin["origin_kind"] == "cli"


def test_import_origin_kind(tmp_path, store):
    path = tmp_path / "c.md"
    path.write_text("| Pinned | Task | Where | Check | Unblocks |\n|---|---|---|---|---|\n| ☐ | T |  |  |  |\n")
    actions.import_markdown(store, path)
    pin = store.list_pins()[0]
    assert pin["origin_kind"] == "import"


def test_backfill_from_source(tmp_path):
    db = tmp_path / "old.db"
    conn = sqlite3.connect(db)
    conn.execute(
        "CREATE TABLE pins ("
        " id TEXT PRIMARY KEY, title TEXT NOT NULL, link TEXT, unblocks TEXT,"
        " check_kind TEXT, check_arg TEXT, source TEXT NOT NULL, dedupe_key TEXT UNIQUE,"
        " status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, done_at INTEGER,"
        " closed_at INTEGER, last_checked_at INTEGER, last_check_result TEXT,"
        " kind TEXT NOT NULL DEFAULT 'task', question TEXT, choices TEXT, placeholder TEXT,"
        " answer TEXT, answer_note TEXT, answered_at INTEGER, reply_to TEXT)"
    )
    rows = [
        ("a", "kanban pin", "kanban:core/t_1"),
        ("b", "agent pin", "agent:worker"),
        ("c", "manual pin", "manual"),
    ]
    for pid, title, source in rows:
        conn.execute(
            "INSERT INTO pins (id, title, source, status, created_at, kind) VALUES (?, ?, ?, 'open', 1, 'task')",
            (pid, title, source),
        )
    conn.commit()

    s = store_mod.Store(conn)
    by_id = {p["id"]: p for p in s.list_pins()}
    assert by_id["a"]["origin_kind"] == "kanban"
    assert by_id["a"]["origin_profile"] is None
    assert by_id["b"]["origin_kind"] == "session"
    assert by_id["b"]["origin_profile"] == "worker"
    assert by_id["c"]["origin_kind"] == "cli"
    conn.close()
