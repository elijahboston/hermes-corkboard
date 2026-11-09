"""Corkboard actions: the shared logic behind the tool, CLI, slash command, hooks, and API.

All functions take an already-opened :class:`store.Store`; nothing here touches Hermes except
the two seam functions :func:`post_kanban_comment` and :func:`broadcast_pin_event`, which tests
monkeypatch.
"""

from __future__ import annotations

import re
import subprocess
import time
from pathlib import Path
from typing import Any, Callable, Optional

from . import checks, guard

KINDS = ("task", "yes_no", "choice", "text")
# Agents may never create `command` checks — arbitrary shell is owner-only via the CLI.
AGENT_CHECK_KINDS = ("dns_ns", "kanban_unblocked")

_NS_SUFFIX = "ns.cloudflare.com"
_DIG_NS_RE = re.compile(r"dig\s+\+short\s+NS\s+(\S+)", re.IGNORECASE)
_BOLD_RE = re.compile(r"\*\*([^*]+)\*\*")


def time_ago(seconds: Any, now: Optional[float] = None) -> str:
    """Human "30 seconds ago" style age from an epoch-seconds timestamp."""
    try:
        secs = float(seconds)
    except (TypeError, ValueError):
        return ""
    if secs is None or secs <= 0:
        return ""
    now = time.time() if now is None else now
    diff = max(0, int(now - secs))
    if diff < 10:
        return "just now"
    if diff < 60:
        return f"{diff} seconds ago"
    minutes = diff // 60
    if minutes < 60:
        return "1 minute ago" if minutes == 1 else f"{minutes} minutes ago"
    hours = minutes // 60
    if hours < 24:
        return "1 hour ago" if hours == 1 else f"{hours} hours ago"
    days = hours // 24
    if days < 7:
        return "1 day ago" if days == 1 else f"{days} days ago"
    if days < 30:
        weeks = days // 7
        return "1 week ago" if weeks == 1 else f"{weeks} weeks ago"
    months = days // 30
    if months < 12:
        return "1 month ago" if months == 1 else f"{months} months ago"
    years = days // 365
    return "1 year ago" if years == 1 else f"{years} years ago"

def _strip_bold(text: str) -> str:
    return _BOLD_RE.sub(r"\1", text or "")


def _is_domain(token: str) -> bool:
    token = (token or "").strip().rstrip(".")
    if not token or any(c in token for c in " <>/@:\\") or "/" in token:
        return False
    if token.startswith(("http://", "https://")):
        return False
    return "." in token


def _bold_domains(title: str) -> list[str]:
    return [m.group(1).strip() for m in _BOLD_RE.finditer(title or "") if _is_domain(m.group(1))]



# -- seams (stubbed in tests) ---------------------------------------------------
def post_kanban_comment(board: Optional[str], task_id: str, answer: str, note: Optional[str] = None) -> None:
    """Post an owner answer onto a kanban card via the ``hermes kanban`` CLI (argv list, no shell)."""
    text = f"Owner decision: {answer}" + (f" — {note}" if note else "")
    argv = ["hermes", "kanban"]
    if board:
        argv += ["--board", board]
    argv += ["comment", task_id, text]
    subprocess.run(argv, check=False)


def broadcast_pin_event(event: str, payload: dict[str, Any]) -> None:
    try:
        from hermes_cli.plugin_events import broadcast_plugin_event
    except ImportError:  # tests / trimmed installs: no gateway stream
        return
    broadcast_plugin_event("corkboard", event, payload)


def parse_kanban_ref(ref: str) -> tuple[Optional[str], str]:
    """``kanban:<board>/<task>`` -> ``(board, task)``; board is None when absent."""
    rest = (ref or "")[len("kanban:"):] if (ref or "").startswith("kanban:") else (ref or "")
    if "/" in rest:
        board, task = rest.split("/", 1)
        return board or None, task
    return None, rest


# -- operations ----------------------------------------------------------------
def pin(
    store: Any,
    *,
    title: str,
    link: Optional[str] = None,
    unblocks: Optional[str] = None,
    check_kind: Optional[str] = None,
    check_arg: Optional[str] = None,
    source: str = "manual",
    dedupe_key: Optional[str] = None,
    kind: str = "task",
    question: Optional[str] = None,
    choices: Optional[list[str]] = None,
    placeholder: Optional[str] = None,
    reply_to: Optional[str] = None,
    origin_kind: Optional[str] = None,
    origin_profile: Optional[str] = None,
    origin_session_id: Optional[str] = None,
    origin_platform: Optional[str] = None,
    allow_command: bool = False,
) -> dict[str, Any]:
    """Validate and create/update a pin. Raises ``ValueError`` / ``guard.SecretRejected``."""
    title = (title or "").strip()
    if not title:
        raise ValueError("title is required")
    guard.assert_not_token(title, field="title")
    if link:
        guard.assert_not_token(link, field="link")
    if unblocks:
        guard.assert_not_token(unblocks, field="unblocks")
    if question:
        guard.assert_not_token(question, field="question")

    kind = (kind or "task").strip() or "task"
    if kind not in KINDS:
        raise ValueError(f"unknown kind {kind!r} (choose from {', '.join(KINDS)})")

    clean_choices: Optional[list[str]] = None
    if kind == "choice":
        if not choices or not isinstance(choices, (list, tuple)):
            raise ValueError("choice pins need 1-4 choices")
        clean_choices = [str(c).strip() for c in choices]
        if any(not c for c in clean_choices):
            raise ValueError("choices must be non-empty strings")
        if len(clean_choices) > 4:
            raise ValueError("choice pins support at most 4 choices")
    if kind == "text" and question:
        guard.assert_question_safe(question)

    if check_kind:
        allowed = tuple(AGENT_CHECK_KINDS) + (("command",) if allow_command else ())
        if check_kind not in allowed:
            raise ValueError(f"check_kind {check_kind!r} not allowed here")
        if check_kind == "command" and not allow_command:
            raise ValueError("command checks are owner-only (CLI)")

    return store.pin(
        title=title,
        link=link,
        unblocks=unblocks,
        check_kind=check_kind,
        check_arg=check_arg,
        source=source,
        dedupe_key=dedupe_key,
        kind=kind,
        question=question,
        choices=clean_choices,
        placeholder=placeholder,
        reply_to=reply_to,
        origin_kind=origin_kind,
        origin_profile=origin_profile,
        origin_session_id=origin_session_id,
        origin_platform=origin_platform,
    )


def list_pins(store: Any, status: str = "open", sort: str = "newest") -> list[dict[str, Any]]:
    return store.list_pins(status=status, sort=sort)


def get_pin(store: Any, pin_id: Optional[str]) -> Optional[dict[str, Any]]:
    if not pin_id:
        return None
    return store.resolve(pin_id)


def _require(store: Any, pin_id: Optional[str]) -> dict[str, Any]:
    row = get_pin(store, pin_id)
    if row is None:
        raise ValueError(f"no pin {pin_id!r}")
    return row


def done(store: Any, pin_id: Optional[str]) -> dict[str, Any]:
    row = _require(store, pin_id)
    store.mark(row["id"], "done")
    return store.get(row["id"])


def dismiss(store: Any, pin_id: Optional[str]) -> dict[str, Any]:
    row = _require(store, pin_id)
    store.mark(row["id"], "dismissed")
    return store.get(row["id"])


def answer(store: Any, pin_id: Optional[str], answer_text: str, note: Optional[str] = None) -> dict[str, Any]:
    row = _require(store, pin_id)
    answer_text = (answer_text or "").strip()
    if not answer_text:
        raise ValueError("answer is required")
    guard.assert_not_token(answer_text, field="answer")
    if note:
        guard.assert_not_token(note, field="note")
    store.answer(row["id"], answer_text, note)

    reply_to = row.get("reply_to") or ""
    if reply_to.startswith("kanban:"):
        board, task = parse_kanban_ref(reply_to)
        post_kanban_comment(board, task, answer_text, note)
    elif reply_to.startswith("session:"):
        broadcast_pin_event("pin.answered", {"id": row["id"], "answer": answer_text, "reply_to": reply_to})
    return store.get(row["id"])


def run_checks(store: Any) -> list[tuple[str, str, bool, str]]:
    return checks.run_checks(store)


# -- import --------------------------------------------------------------------
def import_markdown(store: Any, path: str | Path) -> list[dict[str, Any]]:
    """Parse the ``| Pinned | Task | Where | Check | Unblocks |`` table into pins.

    A Check cell containing ``dig +short NS <domain>`` becomes a ``dns_ns`` check with
    suffix ``ns.cloudflare.com``.
    """
    text = Path(path).read_text(encoding="utf-8-sig")
    header: Optional[list[str]] = None
    rows: list[dict[str, Any]] = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        cells = [c.strip() for c in stripped.strip("|").split("|")]
        if header is None:
            if [c.lower() for c in cells] == ["pinned", "task", "where", "check", "unblocks"]:
                header = cells
            continue
        if header is not None and len(cells) >= len(header):
            cells = cells[: len(header)]
            # skip separator rows (|---|---|...)
            if all(set(c) <= {"-", ":"} for c in cells if c):
                continue
            rows.append(dict(zip(header, cells)))
    if header is None:
        raise ValueError("no corkboard table found (expected | Pinned | Task | Where | Check | Unblocks |)")

    imported: list[dict[str, Any]] = []
    for row in rows:
        title = (row.get("Task") or "").strip()
        if not title:
            continue
        link = (row.get("Where") or "").strip() or None
        unblocks = (row.get("Unblocks") or "").strip() or None
        check_cell = (row.get("Check") or "").strip()
        m = _DIG_NS_RE.search(check_cell)
        raw_domain = m.group(1).strip("`").strip() if m else None
        is_placeholder = bool(raw_domain) and raw_domain.startswith("<") and raw_domain.endswith(">")
        plain_title = _strip_bold(title)
        domains = _bold_domains(title)

        if m and is_placeholder and domains:
            for domain in domains:
                imported.append(
                    pin(
                        store,
                        title=f"{plain_title} — {domain}",
                        link=link,
                        unblocks=unblocks,
                        check_kind="dns_ns",
                        check_arg=f"{domain}={_NS_SUFFIX}",
                        source="manual",
                        origin_kind="import",
                        dedupe_key=f"import:{plain_title.lower()} — {domain.lower()}",
                    )
                )
            continue

        check_kind: Optional[str] = None
        check_arg: Optional[str] = None
        if m and not is_placeholder and raw_domain and _is_domain(raw_domain):
            check_kind, check_arg = "dns_ns", f"{raw_domain}={_NS_SUFFIX}"

        imported.append(
            pin(
                store,
                title=plain_title,
                link=link,
                unblocks=unblocks,
                check_kind=check_kind,
                check_arg=check_arg,
                source="manual",
                origin_kind="import",
                dedupe_key=f"import:{plain_title.lower()}",
            )
        )
    return imported


# -- rendering -----------------------------------------------------------------
def format_pins(pins: list[dict[str, Any]]) -> str:
    if not pins:
        return "Corkboard is empty."
    lines = [f"{len(pins)} pin(s)"]
    for p in pins:
        lines.append(f"{p['id'][:8]}  [{p['kind']}]  {p['title']}")
        lines.append(f"    {time_ago(p.get('created_at'))}")
        if p.get("link"):
            lines.append(f"    link: {p['link']}")
        if p.get("unblocks"):
            lines.append(f"    unblocks: {p['unblocks']}")
        if p.get("check_kind"):
            lines.append(f"    check: {p['check_kind']} {p.get('check_arg') or ''}".rstrip())
        if p.get("answer"):
            lines.append(f"    answer: {p['answer']}")
        if p.get("status") in ("done", "dismissed"):
            closed = p.get("closed_at") or p.get("done_at") or p.get("answered_at")
            if closed:
                lines.append(f"    {p['status']} {time_ago(closed)}")
    return "\n".join(lines)
