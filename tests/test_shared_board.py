"""Shared-board tests: one db path for every profile, atomic concurrent dedupe upserts,
a busy timeout on the opened connection, and profile-labelled agent pins.

The test venv cannot import ``hermes_constants`` / ``hermes_cli``, so the real Hermes root
resolver and opener are exercised through the ``store`` module's seams
(``set_db_path_resolver`` / ``set_db_opener``) — the production defaults still call Hermes.
"""

import json
import os
import sqlite3
import threading
from pathlib import Path

from hermes_plugins.corkboard import store as store_mod


def _emulated_root(root: Path) -> Path:
    """Emulate ``get_default_hermes_root`` for the test root: the shared root for the
    default home and any ``<root>/profiles/<name>`` home (mirrors ``_hermes_root_of``)."""
    env_home = os.environ.get("HERMES_HOME", "").strip()
    env_path = Path(env_home).expanduser() if env_home else None
    if env_path is None:
        return root
    try:
        env_path.resolve().relative_to(root.resolve())
    except ValueError:
        return env_path.parent.parent if env_path.parent.name == "profiles" else env_path
    return root


def _use_plain_opener() -> None:
    def opener(path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        return sqlite3.connect(path, check_same_thread=False)

    store_mod.set_db_opener(opener)


def test_shared_db_path_across_profiles(tmp_path, monkeypatch):
    root = tmp_path / "hermes"
    (root / "profiles" / "worker").mkdir(parents=True)
    expected = root / "plugin-data" / "corkboard" / "data.db"

    resolved = []

    def resolver() -> Path:
        path = _emulated_root(root) / "plugin-data" / "corkboard" / "data.db"
        resolved.append(path)
        return path

    store_mod.set_db_path_resolver(resolver)
    _use_plain_opener()
    try:
        monkeypatch.setenv("HERMES_HOME", str(root / "profiles" / "worker"))
        store_mod.reset_connection()
        store_mod.get_store().pin("pinned by worker", source="manual")

        monkeypatch.setenv("HERMES_HOME", str(root))
        store_mod.reset_connection()
        titles = [p["title"] for p in store_mod.get_store().list_pins()]

        assert titles == ["pinned by worker"]
        assert len(resolved) == 2
        assert resolved[0] == resolved[1] == expected
        assert expected.exists()
    finally:
        store_mod.reset_connection()
        store_mod.reset_db_seams()


def test_concurrent_upsert_one_row(tmp_path):
    db = tmp_path / "board" / "data.db"
    db.parent.mkdir(parents=True)

    conn_a = sqlite3.connect(db, timeout=5, check_same_thread=False)
    conn_b = sqlite3.connect(db, timeout=5, check_same_thread=False)
    store_a = store_mod.Store(conn_a)
    store_b = store_mod.Store(conn_b)

    barrier = threading.Barrier(2)
    rows = {}

    def pin_a():
        barrier.wait()
        rows["a"] = store_a.pin("from a", dedupe_key="k")

    def pin_b():
        barrier.wait()
        rows["b"] = store_b.pin("from b", dedupe_key="k")

    ta = threading.Thread(target=pin_a)
    tb = threading.Thread(target=pin_b)
    ta.start()
    tb.start()
    ta.join()
    tb.join()

    assert len(store_a.list_pins()) == 1
    assert rows["a"]["id"] == rows["b"]["id"]


def test_busy_timeout_set_on_connection(tmp_path):
    db = tmp_path / "board" / "data.db"
    store_mod.set_db_path_resolver(lambda: db)
    _use_plain_opener()
    try:
        store_mod.reset_connection()
        conn = store_mod.get_connection()
        assert conn.execute("PRAGMA busy_timeout").fetchone()[0] == 5000
    finally:
        store_mod.reset_connection()
        store_mod.reset_db_seams()


def test_agent_pin_records_profile_source(registered_ctx, store, monkeypatch):
    monkeypatch.setattr(store_mod, "current_profile_name", lambda: "worker")
    handler = registered_ctx.tools["corkboard"]["handler"]
    out = json.loads(handler({"action": "pin", "title": "x"}))
    assert out["pin"]["source"] == "agent:worker"


def test_current_profile_name_falls_back_to_hermes_home_basename(monkeypatch):
    monkeypatch.setenv("HERMES_HOME", "/tmp/hermes/profiles/reviewer")
    assert store_mod.current_profile_name() == "reviewer"
