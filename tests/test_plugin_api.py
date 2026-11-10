"""Dashboard API tests via FastAPI TestClient (skipped with reason when fastapi is absent)."""

import importlib.util
import sys
from pathlib import Path

import pytest

pytest.importorskip("fastapi", reason="fastapi not importable; skipping plugin_api tests")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from hermes_plugins.corkboard import store as store_mod  # noqa: E402

API_PATH = Path(__file__).resolve().parent.parent / "dashboard" / "plugin_api.py"


def _load_api():
    spec = importlib.util.spec_from_file_location("corkboard_plugin_api", API_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["corkboard_plugin_api"] = module
    spec.loader.exec_module(module)
    return module


def _client():
    app = FastAPI()
    app.include_router(_load_api().router)
    return TestClient(app)


def test_get_pins(store):
    store.pin("File LLC")
    r = _client().get("/pins")
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    assert len(data) == 1
    assert data[0]["title"] == "File LLC"


def test_done(store):
    row = store.pin("File LLC")
    r = _client().post(f"/pins/{row['id']}/done")
    assert r.status_code == 200
    assert r.json()["status"] == "done"
    assert store.get(row["id"])["status"] == "done"


def test_dismiss(store):
    row = store.pin("File LLC")
    r = _client().post(f"/pins/{row['id']}/dismiss")
    assert r.status_code == 200
    assert r.json()["status"] == "dismissed"


def test_answer(store):
    row = store.pin("q", kind="yes_no", question="ship?")
    r = _client().post(f"/pins/{row['id']}/answer", json={"answer": "yes", "note": "go"})
    assert r.status_code == 200
    body = r.json()
    assert body["answer"] == "yes"
    assert body["status"] == "done"


def test_answer_unknown_404(store):
    r = _client().post("/pins/nope/answer", json={"answer": "yes"})
    assert r.status_code == 404


def test_answer_secret_rejected_400(store):
    row = store.pin("q", kind="text", question="which?")
    r = _client().post(f"/pins/{row['id']}/answer", json={"answer": "sk-" + "A" * 20})
    assert r.status_code == 400


def test_answer_delivery_failure_502_keeps_pin_open(store, monkeypatch):
    from hermes_plugins.corkboard import actions

    def fail(board, task, answer, note=None):
        raise actions.DeliveryFailed("card did not accept the answer")

    monkeypatch.setattr(actions, "post_kanban_comment", fail)
    row = store.pin("q", kind="text", question="which?", reply_to="kanban:core/t_1")
    r = _client().post(f"/pins/{row['id']}/answer", json={"answer": "example.com"})
    assert r.status_code == 502
    assert "did not accept" in r.json()["detail"]
    assert store.get(row["id"])["status"] == "open"


def _set_created(store, pin, ts):
    store.conn.execute("UPDATE pins SET created_at = ? WHERE id = ?", (ts, pin["id"]))
    store.conn.commit()


def test_list_pins_filters_and_sorts(store):
    open_pin = store.pin("open")
    done_pin = store.pin("done")
    dismissed_pin = store.pin("dismissed")
    store.mark(done_pin["id"], "done")
    store.mark(dismissed_pin["id"], "dismissed")
    _set_created(store, open_pin, 300)
    _set_created(store, done_pin, 200)
    _set_created(store, dismissed_pin, 100)

    client = _client()

    r = client.get("/pins", params={"status": "dismissed"})
    assert r.status_code == 200
    assert [p["id"] for p in r.json()] == [dismissed_pin["id"]]

    r = client.get("/pins", params={"status": "all"})
    assert r.status_code == 200
    assert [p["id"] for p in r.json()] == [open_pin["id"], done_pin["id"], dismissed_pin["id"]]

    r = client.get("/pins")
    assert r.status_code == 200
    assert [p["id"] for p in r.json()] == [open_pin["id"]]

    r = client.get("/pins", params={"status": "all", "sort": "oldest"})
    assert r.status_code == 200
    assert [p["id"] for p in r.json()] == [dismissed_pin["id"], done_pin["id"], open_pin["id"]]

    assert client.get("/pins", params={"status": "bogus"}).status_code == 400
    assert client.get("/pins", params={"sort": "bogus"}).status_code == 400
