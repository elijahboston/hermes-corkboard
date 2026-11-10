"""corkboard — one place for owner-only work, with auto-clearing checks.

A native Hermes general plugin: one agent tool, one CLI command, one slash command, and
kanban hooks that auto-pin blocked cards and clear them when the card is no longer blocked.
"""

from __future__ import annotations

import json
import shlex
import subprocess
import sys
from typing import Any, Optional

from . import actions, checks, guard, store as store_mod

logger = __import__("logging").getLogger(__name__)

_RETENTION_DEFAULT = 30


def _read_settings(ctx: Any) -> dict[str, int]:
    """Read plugin settings from the Hermes ctx (defaults match ``config_schema``)."""
    try:
        retention_days = int(ctx.get_config("retention_days", default=_RETENTION_DEFAULT))
    except (TypeError, ValueError):
        retention_days = _RETENTION_DEFAULT
    return {"retention_days": retention_days}


def _list_pins(store: Any, retention_days: int, status: str = "open", sort: str = "newest") -> list[dict[str, Any]]:
    store_mod.maybe_purge(store, retention_days)
    return actions.list_pins(store, status=status, sort=sort)

CORKBOARD_SCHEMA = {
    "name": "corkboard",
    "description": (
        "Pin owner-only work so the owner sees it in one place, instead of the agent writing it "
        "into chat. Actions: 'pin' (create or update a pin), 'list' (open pins), 'get' (one pin "
        "by id, including its answer), 'done' (mark complete), 'dismiss' (mark not needed). "
        "Kinds: 'task' (default, Done button), 'yes_no' (owner picks Yes/No), 'choice' (up to 4 "
        "choices, first is Recommended), 'text' (owner types an answer). Use 'pin' whenever a "
        "task is blocked on something only the owner can do (a credential, a decision, a phone "
        "call). Set dedupe_key to keep re-pins as one row. Agents may set check_kind dns_ns or "
        "kanban_unblocked but never 'command'."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["pin", "list", "get", "done", "dismiss"],
                "description": "What to do.",
            },
            "title": {"type": "string", "description": "One line: what is needed (for 'pin')."},
            "link": {"type": "string", "description": "Card / issue / URL (for 'pin')."},
            "unblocks": {"type": "string", "description": "What this frees up (for 'pin')."},
            "kind": {
                "type": "string",
                "enum": ["task", "yes_no", "choice", "text"],
                "description": "How the owner answers (for 'pin').",
            },
            "question": {
                "type": "string",
                "description": "Question shown to the owner (yes_no / choice / text kinds).",
            },
            "choices": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Up to 4 choices for a 'choice' pin; first is Recommended.",
            },
            "placeholder": {"type": "string", "description": "Optional hint for a 'text' pin's box."},
            "check_kind": {
                "type": "string",
                "enum": ["dns_ns", "kanban_unblocked"],
                "description": "Auto-clear check (for 'pin'). 'command' is owner-only.",
            },
            "check_arg": {
                "type": "string",
                "description": "Check argument: 'domain=suffix' for dns_ns, 'board/task' for kanban_unblocked.",
            },
            "reply_to": {
                "type": "string",
                "description": "Route the answer: 'kanban:<board>/<task>' or 'session:<profile>/<id>'.",
            },
            "id": {"type": "string", "description": "Pin id for 'get' / 'done' / 'dismiss'."},
        },
        "required": ["action"],
    },
}

def _tool_handler(args: dict[str, Any], retention_days: int = _RETENTION_DEFAULT, **kwargs: Any) -> str:
    store = store_mod.get_store()
    action = (args.get("action") or "").strip()
    try:
        if action == "pin":
            # Origin comes from the handler context Hermes injects, never the tool
            # args: an agent must not be able to point a pin at a chat it did not
            # come from. Bot Mode detection is left to the desktop (session -> bot
            # upgrade via host.profiles.list bot_title).
            origin_profile = store_mod.current_profile_name()
            row = actions.pin(
                store,
                title=args.get("title") or "",
                link=args.get("link"),
                unblocks=args.get("unblocks"),
                check_kind=args.get("check_kind"),
                check_arg=args.get("check_arg"),
                source=f"agent:{origin_profile}",
                dedupe_key=args.get("dedupe_key"),
                kind=args.get("kind") or "task",
                question=args.get("question"),
                choices=args.get("choices"),
                placeholder=args.get("placeholder"),
                reply_to=args.get("reply_to"),
                origin_kind="session",
                origin_profile=origin_profile,
                origin_session_id=kwargs.get("session_id"),
                origin_platform=kwargs.get("platform"),
            )
            return json.dumps({"ok": True, "pin": row})
        if action == "list":
            pins = _list_pins(store, retention_days)
            return json.dumps(
                {"ok": True, "count": len(pins), "pins": pins, "text": actions.format_pins(pins)}
            )
        if action == "get":
            row = actions.get_pin(store, args.get("id"))
            if row is None:
                return json.dumps({"error": f"no pin {args.get('id')!r}"})
            return json.dumps({"ok": True, "pin": row})
        if action == "done":
            return json.dumps({"ok": True, "pin": actions.done(store, args.get("id"))})
        if action == "dismiss":
            return json.dumps({"ok": True, "pin": actions.dismiss(store, args.get("id"))})
        return json.dumps({"error": f"unknown action {action!r}"})
    except guard.SecretRejected as exc:
        return json.dumps({"error": str(exc)})
    except ValueError as exc:
        return json.dumps({"error": str(exc)})


# -- slash ---------------------------------------------------------------------
def _slash_handler(raw_args: str, retention_days: int = _RETENTION_DEFAULT, **kwargs: Any) -> str:
    store = store_mod.get_store()
    parts = shlex.split(raw_args or "")
    statuses = ("open", "done", "dismissed", "all")
    try:
        if not parts:
            return actions.format_pins(_list_pins(store, retention_days))
        cmd = parts[0]
        if cmd in statuses and len(parts) == 1:
            return actions.format_pins(_list_pins(store, retention_days, status=cmd))
        if cmd == "list":
            status = parts[1] if len(parts) >= 2 and parts[1] in statuses else "open"
            return actions.format_pins(_list_pins(store, retention_days, status=status))
        if cmd == "done" and len(parts) >= 2:
            row = actions.done(store, parts[1])
            return f"done {row['id'][:8]} {row['title']}"
        if cmd == "dismiss" and len(parts) >= 2:
            row = actions.dismiss(store, parts[1])
            return f"dismissed {row['id'][:8]} {row['title']}"
        if cmd == "answer" and len(parts) >= 3:
            row = actions.answer(store, parts[1], parts[2])
            return f"answered {row['id'][:8]} → {row['answer']}"
        if cmd == "add" and len(parts) >= 2:
            row = actions.pin(store, title=" ".join(parts[1:]), source="manual", origin_kind="cli")
            return f"pinned {row['id'][:8]} {row['title']}"
        return "usage: /corkboard [open|done|dismissed|all|list|add <title>|done <id>|dismiss <id>|answer <id> <answer>]"
    except (ValueError, guard.SecretRejected, actions.DeliveryFailed) as exc:
        return f"corkboard: {exc}"


# -- CLI -----------------------------------------------------------------------
def _setup_argparse(subparser: Any) -> None:
    subs = subparser.add_subparsers(dest="corkboard_command")

    p_list = subs.add_parser("list", help="List pins (default: open, newest)")
    p_list.add_argument("--status", choices=["open", "done", "dismissed", "all"], default="open")
    p_list.add_argument("--sort", choices=["newest", "oldest"], default="newest")

    p_add = subs.add_parser("add", help="Add a pin")
    p_add.add_argument("title", help="One line: what is needed")
    p_add.add_argument("--link", help="Card / issue / URL")
    p_add.add_argument("--unblocks", help="What this frees up")
    p_add.add_argument("--kind", choices=list(actions.KINDS), default="task")
    p_add.add_argument("--question")
    p_add.add_argument("--choice", action="append", dest="choices", help="One choice (repeatable, max 4)")
    p_add.add_argument("--check-dns", dest="check_dns", metavar="DOMAIN=SUFFIX")
    p_add.add_argument("--check-command", dest="check_command", metavar="CMD")
    p_add.add_argument("--check-kanban", dest="check_kanban", metavar="BOARD/TASK")
    p_add.add_argument("--dedupe-key", dest="dedupe_key")

    p_done = subs.add_parser("done", help="Mark a pin done")
    p_done.add_argument("id")

    p_dismiss = subs.add_parser("dismiss", help="Dismiss a pin")
    p_dismiss.add_argument("id")

    p_answer = subs.add_parser("answer", help="Answer a pin (moves it to done)")
    p_answer.add_argument("id")
    p_answer.add_argument("answer")
    p_answer.add_argument("--note")

    subs.add_parser("check", help="Run all open checks now")

    p_purge = subs.add_parser("purge", help="Purge closed pins older than the retention setting")
    p_purge.add_argument("--dry-run", action="store_true")

    p_import = subs.add_parser("import", help="Import a markdown corkboard table")
    p_import.add_argument("path")

    subparser.set_defaults(func=_cli_handler)


def _cli_handler(args: Any, retention_days: int = _RETENTION_DEFAULT) -> int:
    store = store_mod.get_store()
    cmd = getattr(args, "corkboard_command", None) or "list"
    try:
        if cmd == "list":
            status = getattr(args, "status", "open")
            sort = getattr(args, "sort", "newest")
            print(actions.format_pins(_list_pins(store, retention_days, status=status, sort=sort)))
        elif cmd == "purge":
            dry_run = bool(getattr(args, "dry_run", False))
            purged = store.purge_closed(retention_days, dry_run=dry_run)
            if dry_run:
                print(f"would purge {purged} closed pins")
            else:
                print(f"purged {purged} closed pins")
        elif cmd == "add":
            check_kind = check_arg = None
            flags = [
                ("dns_ns", getattr(args, "check_dns", None)),
                ("command", getattr(args, "check_command", None)),
                ("kanban_unblocked", getattr(args, "check_kanban", None)),
            ]
            chosen = [f for f in flags if f[1]]
            if len(chosen) > 1:
                raise ValueError("choose at most one of --check-dns / --check-command / --check-kanban")
            if chosen:
                check_kind, check_arg = chosen[0]
            row = actions.pin(
                store,
                title=args.title,
                link=getattr(args, "link", None),
                unblocks=getattr(args, "unblocks", None),
                kind=getattr(args, "kind", "task"),
                question=getattr(args, "question", None),
                check_kind=check_kind,
                check_arg=check_arg,
                source="manual",
                origin_kind="cli",
                dedupe_key=getattr(args, "dedupe_key", None),
                allow_command=True,
            )
            print(f"pinned {row['id'][:8]} {row['title']}")
        elif cmd == "done":
            row = actions.done(store, getattr(args, "id", None))
            print(f"done {row['id'][:8]} {row['title']}")
        elif cmd == "dismiss":
            row = actions.dismiss(store, getattr(args, "id", None))
            print(f"dismissed {row['id'][:8]} {row['title']}")
        elif cmd == "answer":
            row = actions.answer(store, getattr(args, "id", None), args.answer, note=getattr(args, "note", None))
            print(f"answered {row['id'][:8]} → {row['answer']}")
        elif cmd == "check":
            results = actions.run_checks(store)
            if not results:
                print("no open pins with checks")
            for pid, kind, ok, detail in results:
                print(f"{pid[:8]} {kind}: {'PASS' if ok else 'fail'} {detail}")
        elif cmd == "import":
            rows = actions.import_markdown(store, args.path)
            print(f"imported {len(rows)} pins")
        else:
            print(f"unknown corkboard subcommand {cmd!r}", file=sys.stderr)
            return 1
        return 0
    except (ValueError, guard.SecretRejected, actions.DeliveryFailed, OSError) as exc:
        print(f"corkboard: {exc}", file=sys.stderr)
        return 1


# -- kanban hooks --------------------------------------------------------------
def _blocked_task_ids(board: str) -> Optional[set[str]]:
    """Live blocked task ids for ``board`` (shelled out; monkeypatched in tests).

    ``None`` means the lookup failed — distinct from an empty set ("nothing is blocked"),
    so a failed lookup never clears pins.
    """
    argv = ["hermes", "kanban", "--board", board, "list", "--status", "blocked", "--json"]
    try:
        proc = subprocess.run(argv, capture_output=True, text=True, timeout=20, check=False)
    except Exception as exc:
        logger.warning("corkboard: kanban lookup for board %r failed: %s", board, exc)
        return None
    if proc.returncode != 0:
        logger.warning("corkboard: kanban lookup for board %r exited %s", board, proc.returncode)
        return None
    try:
        data = json.loads(proc.stdout or "")
    except ValueError:
        logger.warning("corkboard: kanban lookup for board %r returned non-JSON output", board)
        return None
    if not isinstance(data, list):
        return None
    return {str(c["id"]) for c in data if isinstance(c, dict) and c.get("id")}


def _mark_done_by_dedupe(store: Any, dedupe_key: str) -> None:
    for row in store.find_by_dedupe(dedupe_key):
        if row["status"] != store_mod.DONE:
            store.mark(row["id"], store_mod.DONE)


def _on_blocked(**kwargs: Any) -> None:
    task_id = kwargs.get("task_id")
    if not task_id:
        return
    board = kwargs.get("board") or "default"
    reason = (kwargs.get("reason") or "").strip() or "(no reason given)"
    ref = f"kanban:{board}/{task_id}"
    store = store_mod.get_store()
    try:
        actions.pin(
            store,
            title=f"Blocked: {board}/{task_id}",
            question=reason,
            kind="text",
            source=ref,
            origin_kind="kanban",
            dedupe_key=ref,
            reply_to=ref,
        )
    except guard.SecretRejected:
        # A block reason asking for credentials must be a task pin, not a text question.
        actions.pin(
            store,
            title=reason,
            kind="task",
            source=ref,
            origin_kind="kanban",
            dedupe_key=ref,
            reply_to=ref,
        )


def _on_completed(**kwargs: Any) -> None:
    task_id = kwargs.get("task_id")
    if not task_id:
        return
    board = kwargs.get("board") or "default"
    _mark_done_by_dedupe(store_mod.get_store(), f"kanban:{board}/{task_id}")


def _on_tick(retention_days: int = _RETENTION_DEFAULT, **kwargs: Any) -> None:
    if kwargs.get("dry_run"):
        return
    board = kwargs.get("board") or "default"
    store = store_mod.get_store()
    store_mod.maybe_purge(store, retention_days)
    kanban_pins = [p for p in store.list_pins(status="open") if (p.get("source") or "").startswith("kanban:")]
    if not kanban_pins:
        return
    blocked = _blocked_task_ids(board)
    if blocked is None:
        # Unknown is not "unblocked": keep every pin open until a lookup succeeds.
        return
    for pin in kanban_pins:
        b, task = actions.parse_kanban_ref(pin.get("source") or "")
        if b != board:
            continue
        if task not in blocked:
            store.mark(pin["id"], store_mod.DONE)


# -- registration --------------------------------------------------------------
def register(ctx: Any) -> None:
    settings = _read_settings(ctx)
    retention_days = settings["retention_days"]

    ctx.register_tool(
        name="corkboard",
        toolset="corkboard",
        schema=CORKBOARD_SCHEMA,
        handler=lambda args, **kw: _tool_handler(args, retention_days=retention_days, **kw),
        description="Pin owner-only work with auto-clearing checks",
        emoji="📌",
    )
    ctx.register_cli_command(
        name="corkboard",
        help="Owner corkboard: pin owner-only work, run checks, import the markdown board",
        setup_fn=_setup_argparse,
        handler_fn=lambda args: _cli_handler(args, retention_days=retention_days),
    )
    ctx.register_command(
        "corkboard",
        handler=lambda raw, **kw: _slash_handler(raw, retention_days=retention_days, **kw),
        description="Show the owner corkboard",
        args_hint="[open|done|dismissed|all|list|add <title>|done <id>|dismiss <id>|answer <id> <answer>]",
    )
    ctx.register_hook("kanban_task_blocked", _on_blocked)
    ctx.register_hook("kanban_task_completed", _on_completed)
    ctx.register_hook(
        "on_kanban_dispatch_tick",
        lambda **kw: _on_tick(retention_days=retention_days, **kw),
    )
