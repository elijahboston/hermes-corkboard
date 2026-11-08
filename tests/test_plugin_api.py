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
