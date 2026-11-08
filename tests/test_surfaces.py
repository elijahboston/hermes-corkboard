"""Surface tests through the stub ctx: tool/CLI/slash registered, pin->list round trip,
dedupe, secret guard, and answer routing to a (stubbed) kanban comment."""

import json

from hermes_plugins.corkboard import actions, store as store_mod


def test_tool_registered(registered_ctx):
    assert "corkboard" in registered_ctx.tools
    assert registered_ctx.tools["corkboard"]["toolset"] == "corkboard"


def test_cli_registered(registered_ctx):
    assert "corkboard" in registered_ctx.cli_commands


def test_slash_registered(registered_ctx):
    assert "corkboard" in registered_ctx.commands


def test_hooks_registered(registered_ctx):
    assert set(registered_ctx.hooks) == {
        "kanban_task_blocked", "kanban_task_completed", "on_kanban_dispatch_tick",
    }


def test_pin_list_round_trip(registered_ctx, store):
    handler = registered_ctx.tools["corkboard"]["handler"]
    out = json.loads(handler({"action": "pin", "title": "File LLC", "unblocks": "EIN"}))
    assert out["ok"] is True
    pin_id = out["pin"]["id"]
    out = json.loads(handler({"action": "list"}))
    assert out["count"] == 1
    assert out["pins"][0]["id"] == pin_id


def test_get_returns_answer(registered_ctx, store):
    handler = registered_ctx.tools["corkboard"]["handler"]
    out = json.loads(handler({"action": "pin", "title": "q", "kind": "yes_no", "question": "go?"}))
    pin_id = out["pin"]["id"]
    store.answer(pin_id, "yes")
    out = json.loads(handler({"action": "get", "id": pin_id}))
    assert out["pin"]["answer"] == "yes"


def test_dedupe(registered_ctx, store):
    handler = registered_ctx.tools["corkboard"]["handler"]
    json.loads(handler({"action": "pin", "title": "a", "dedupe_key": "k"}))
    json.loads(handler({"action": "pin", "title": "b", "dedupe_key": "k"}))
    lst = json.loads(handler({"action": "list"}))
    assert lst["count"] == 1
    assert lst["pins"][0]["title"] == "b"


def test_agent_cannot_create_command_check(registered_ctx, store):
    handler = registered_ctx.tools["corkboard"]["handler"]
    out = json.loads(handler(
        {"action": "pin", "title": "x", "check_kind": "command", "check_arg": "rm -rf /"}
    ))
    assert "error" in out


def test_secret_guard_rejects_question(registered_ctx, store):
    handler = registered_ctx.tools["corkboard"]["handler"]
    out = json.loads(handler(
        {"action": "pin", "title": "need key", "kind": "text", "question": "What is your API key?"}
    ))
    assert "error" in out


def test_secret_guard_rejects_token_answer(registered_ctx, store):
    handler = registered_ctx.tools["corkboard"]["handler"]
    out = json.loads(handler({"action": "pin", "title": "q", "kind": "text", "question": "which?"}))
    pin_id = out["pin"]["id"]
    try:
        actions.answer(store, pin_id, "sk-" + "A" * 20)
    except Exception as exc:
        assert "credential" in str(exc)
    else:
        raise AssertionError("expected SecretRejected")


def test_answer_routes_to_kanban_comment(registered_ctx, store, monkeypatch):
    posted = []
    monkeypatch.setattr(
        actions, "post_kanban_comment",
        lambda board, task, answer, note=None: posted.append((board, task, answer, note)),
    )
    handler = registered_ctx.tools["corkboard"]["handler"]
    out = json.loads(handler({
        "action": "pin", "title": "q", "kind": "text",
        "question": "Which domain?", "reply_to": "kanban:core/t_1",
    }))
    pin_id = out["pin"]["id"]
    actions.answer(store, pin_id, "example.com")
    assert posted == [("core", "t_1", "example.com", None)]
    assert store.get(pin_id)["status"] == "done"


def test_slash_list(registered_ctx, store):
    handler = registered_ctx.commands["corkboard"]["handler"]
    store.pin("File LLC")
    assert "File LLC" in handler("")


def test_cli_list(registered_ctx, store, capsys):
    handler = registered_ctx.cli_commands["corkboard"]["handler_fn"]
    store.pin("File LLC")
    handler(_ns("list"))
    assert "File LLC" in capsys.readouterr().out


class _ns:
    def __init__(self, cmd, **kw):
        self.corkboard_command = cmd
        self.__dict__.update(kw)
