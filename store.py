"""Persistent pin store for the corkboard plugin.

One SQLite table (``pins``) at ``<hermes root>/plugin-data/corkboard/data.db`` — a single
board shared by every profile, resolved from the default Hermes root on each open (never a
profile dir). Tests inject a temp-path connection through :func:`set_connection` (or the
path/opener seams below); the real Hermes path is only touched lazily on first use.
"""

from __future__ import annotations
import json
import os
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

OPEN = "open"
DONE = "done"
DISMISSED = "dismissed"

_STATUSES = (OPEN, DONE, DISMISSED)

KINDS = ("task", "yes_no", "choice", "text")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS pins (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  link TEXT,
  unblocks TEXT,
  check_kind TEXT,
  check_arg TEXT,
  source TEXT NOT NULL,
  dedupe_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  done_at INTEGER,
  last_checked_at INTEGER,
  last_check_result TEXT,
  kind TEXT NOT NULL DEFAULT 'task',
  question TEXT,
  choices TEXT,
  placeholder TEXT,
  answer TEXT,
  answer_note TEXT,
  answered_at INTEGER,
  reply_to TEXT
)
"""

_FIELDS = (
    "id", "title", "link", "unblocks", "check_kind", "check_arg", "source", "dedupe_key",
    "status", "created_at", "done_at", "last_checked_at", "last_check_result",
    "kind", "question", "choices", "placeholder", "answer", "answer_note", "answered_at",
    "reply_to",
)
_SELECT = ", ".join(_FIELDS)


def _row(row: Any) -> Optional[dict[str, Any]]:
    if row is None:
        return None
    data = {key: row[key] for key in row.keys()}
    if data.get("choices"):
        try:
            data["choices"] = json.loads(data["choices"])
        except (TypeError, ValueError):
            data["choices"] = None
    return data


class Store:
    """A thin wrapper over the pins table. ``conn`` is any sqlite3 connection."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self.conn = conn
        self.conn.row_factory = sqlite3.Row
        self.conn.execute(_SCHEMA)
        self.conn.commit()

    # -- writes -----------------------------------------------------------------
    def pin(
        self,
        title: str,
        *,
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
    ) -> dict[str, Any]:
        """Insert a pin, or upsert the row that shares ``dedupe_key``.

        The dedupe upsert is one atomic statement so two writers (worker, reviewer, gateway,
        CLI) racing on the same key end with exactly one row. A re-pin of a non-open row
        resets it to ``open`` and clears its completion/answer state (a kanban card re-blocked
        with a new reason re-opens its pin).
        """
        now = int(time.time())
        choices_json = json.dumps(choices) if choices is not None else None
        pin_id = str(uuid.uuid4())

        if dedupe_key:
            self.conn.execute(
                "INSERT INTO pins (id, title, link, unblocks, check_kind, check_arg, source, "
                "dedupe_key, status, created_at, kind, question, choices, placeholder, reply_to) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(dedupe_key) DO UPDATE SET "
                "title=excluded.title, link=excluded.link, unblocks=excluded.unblocks, "
                "check_kind=excluded.check_kind, check_arg=excluded.check_arg, source=excluded.source, "
                "kind=excluded.kind, question=excluded.question, choices=excluded.choices, "
                "placeholder=excluded.placeholder, reply_to=excluded.reply_to, status='open', "
                "done_at=CASE WHEN pins.status='open' THEN pins.done_at ELSE NULL END, "
                "answer=CASE WHEN pins.status='open' THEN pins.answer ELSE NULL END, "
                "answer_note=CASE WHEN pins.status='open' THEN pins.answer_note ELSE NULL END, "
                "answered_at=CASE WHEN pins.status='open' THEN pins.answered_at ELSE NULL END, "
                "last_checked_at=CASE WHEN pins.status='open' THEN pins.last_checked_at ELSE NULL END, "
                "last_check_result=CASE WHEN pins.status='open' THEN pins.last_check_result ELSE NULL END",
                (pin_id, title, link, unblocks, check_kind, check_arg, source, dedupe_key,
                 now, kind, question, choices_json, placeholder, reply_to),
            )
            self.conn.commit()
            row = self.conn.execute(
                f"SELECT {_SELECT} FROM pins WHERE dedupe_key = ?", (dedupe_key,)
            ).fetchone()
            return _row(row)  # type: ignore[return-value]

        self.conn.execute(
            "INSERT INTO pins (id, title, link, unblocks, check_kind, check_arg, source, "
            "dedupe_key, status, created_at, kind, question, choices, placeholder, reply_to) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (pin_id, title, link, unblocks, check_kind, check_arg, source, dedupe_key, OPEN, now,
             kind, question, choices_json, placeholder, reply_to),
        )
        self.conn.commit()
        return self.get(pin_id)  # type: ignore[return-value]

    def mark(self, pin_id: str, status: str) -> bool:
        if status not in _STATUSES:
            raise ValueError(f"unknown status {status!r}")
        now = int(time.time())
        done_at = now if status == DONE else None
        cur = self.conn.execute(
            "UPDATE pins SET status=?, done_at=? WHERE id=?", (status, done_at, pin_id)
        )
        self.conn.commit()
        return cur.rowcount > 0

    def answer(self, pin_id: str, answer: str, note: Optional[str] = None) -> bool:
        now = int(time.time())
        cur = self.conn.execute(
            "UPDATE pins SET answer=?, answer_note=?, answered_at=?, status=?, done_at=? WHERE id=?",
            (answer, note, now, DONE, now, pin_id),
        )
        self.conn.commit()
        return cur.rowcount > 0

    def record_check(self, pin_id: str, ok: bool, result: str) -> bool:
        now = int(time.time())
        if ok:
            cur = self.conn.execute(
                "UPDATE pins SET last_checked_at=?, last_check_result=?, status=?, done_at=? "
                "WHERE id=?",
                (now, result, DONE, now, pin_id),
            )
        else:
            cur = self.conn.execute(
                "UPDATE pins SET last_checked_at=?, last_check_result=? WHERE id=?",
                (now, result, pin_id),
            )
        self.conn.commit()
        return cur.rowcount > 0

    # -- reads ------------------------------------------------------------------
    def get(self, pin_id: str) -> Optional[dict[str, Any]]:
        row = self.conn.execute(f"SELECT {_SELECT} FROM pins WHERE id = ?", (pin_id,)).fetchone()
        return _row(row)

    def resolve(self, ident: str) -> Optional[dict[str, Any]]:
        """Exact id match, else a unique prefix match (for short CLI ids)."""
        exact = self.get(ident)
        if exact is not None:
            return exact
        rows = self.conn.execute(
            f"SELECT {_SELECT} FROM pins WHERE id LIKE ?", (ident + "%",)
        ).fetchall()
        return _row(rows[0]) if len(rows) == 1 else None

    def find_by_dedupe(self, dedupe_key: str) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            f"SELECT {_SELECT} FROM pins WHERE dedupe_key = ?", (dedupe_key,)
        ).fetchall()
        return [d for d in (_row(r) for r in rows) if d is not None]

    def list_pins(self, status: Optional[str] = None) -> list[dict[str, Any]]:
        if status is not None:
            rows = self.conn.execute(
                f"SELECT {_SELECT} FROM pins WHERE status = ? ORDER BY created_at DESC", (status,)
            ).fetchall()
        else:
            rows = self.conn.execute(
                f"SELECT {_SELECT} FROM pins ORDER BY created_at DESC"
            ).fetchall()
        return [d for d in (_row(r) for r in rows) if d is not None]


# -- profile identity ----------------------------------------------------------
def current_profile_name() -> str:
    """Name of the profile pinning right now (``default``, ``worker``, …).

    Prefers Hermes' own resolver (handles HERMES_HOME overrides and launcher-pinned
    workers), then ``hermes_constants``, then the HERMES_HOME basename. Never raises; the
    basename fallback keeps pins labelled in bare test installs.
    """
    try:
        from hermes_cli.profiles import current_profile_name as _resolve

        name = _resolve()
        if name:
            return name
    except Exception:
        pass
    try:
        from hermes_constants import get_hermes_home, profile_name_for_home

        name = profile_name_for_home(get_hermes_home())
        if name:
            return name
    except Exception:
        pass
    env_home = os.environ.get("HERMES_HOME", "").strip()
    return Path(env_home).name or "default"


# -- shared board path & opener (seams for tests; production uses Hermes) --------
def _default_db_path() -> Path:
    """``<hermes root>/plugin-data/corkboard/data.db`` — one board for every profile."""
    from hermes_constants import get_default_hermes_root

    return get_default_hermes_root() / "plugin-data" / "corkboard" / "data.db"


def _default_open_db(path: Path) -> sqlite3.Connection:
    """Open with Hermes' ``sqlite_util.open_db`` so WAL/network-FS fallbacks and the busy
    timeout apply, exactly like ``plugin_db``."""
    from hermes_cli.sqlite_util import open_db

    return open_db(
        path,
        db_label="plugin-data/corkboard/data.db",
        foreign_keys=True,
        row_factory=None,
        check_same_thread=False,
    )


_db_path: Callable[[], Path] = _default_db_path
_open_db: Callable[[Path], sqlite3.Connection] = _default_open_db


def set_db_path_resolver(resolver: Callable[[], Path]) -> None:
    """Override the shared-board path resolver (tests)."""
    global _db_path
    _db_path = resolver


def set_db_opener(opener: Callable[[Path], sqlite3.Connection]) -> None:
    """Override the connection opener (tests)."""
    global _open_db
    _open_db = opener


def reset_db_seams() -> None:
    """Restore the production path resolver and opener (tests)."""
    global _db_path, _open_db
    _db_path = _default_db_path
    _open_db = _default_open_db


# -- connection management (lazy; tests inject a temp-path connection) ----------
_conn: Optional[sqlite3.Connection] = None


def set_connection(conn: sqlite3.Connection) -> None:
    global _conn
    _conn = conn


def reset_connection() -> None:
    global _conn
    _conn = None


def get_connection() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        conn = _open_db(_db_path())
        # Belt-and-suspenders busy timeout so concurrent writers (worker, reviewer,
        # gateway, CLI) serialize short transactions instead of failing locked.
        conn.execute("PRAGMA busy_timeout = 5000")
        _conn = conn
    return _conn


def get_store() -> Store:
    return Store(get_connection())
