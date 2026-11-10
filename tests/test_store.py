"""Store tests: pin/list/get/mark/answer, dedupe upsert, re-open, choices round-trip."""

from hermes_plugins.corkboard import store as store_mod


def test_pin_and_get(store):
    row = store.pin("File the LLC", source="manual", link="https://example.com/llc")
    assert row["id"]
    assert row["status"] == "open"
    assert store.get(row["id"])["title"] == "File the LLC"


def test_list_defaults_to_all(store):
    a = store.pin("one")
    store.pin("two")
    store.mark(a["id"], "done")
    assert len(store.list_pins()) == 2
    assert len(store.list_pins(status="open")) == 1
    assert len(store.list_pins(status="done")) == 1


def test_dedupe_upsert_one_row(store):
    a = store.pin("v1", dedupe_key="k", source="manual")
    b = store.pin("v2", dedupe_key="k", source="manual")
    assert a["id"] == b["id"]
    assert b["title"] == "v2"
    assert len(store.list_pins()) == 1


def test_dedupe_reopens_done_pin(store):
    a = store.pin("v1", dedupe_key="k")
    store.mark(a["id"], "done")
    b = store.pin("v2", dedupe_key="k")
    assert b["status"] == "open"
    assert b["answer"] is None
    assert b["done_at"] is None


def test_mark(store):
    a = store.pin("t")
    assert store.mark(a["id"], "done")
    r = store.get(a["id"])
    assert r["status"] == "done"
    assert r["done_at"] is not None


def test_mark_unknown_status_rejected(store):
    a = store.pin("t")
    try:
        store.mark(a["id"], "bogus")
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError")


def test_answer(store):
    a = store.pin("q", kind="yes_no", question="ship?")
    assert store.answer(a["id"], "yes", note="ship it")
    r = store.get(a["id"])
    assert r["status"] == "done"
    assert r["answer"] == "yes"
    assert r["answer_note"] == "ship it"
    assert r["answered_at"] is not None


def test_resolve_prefix(store):
    a = store.pin("t-one")
    store.pin("t-two")
    assert store.resolve(a["id"][:8])["id"] == a["id"]


def test_choices_roundtrip(store):
    a = store.pin("pick", kind="choice", choices=["a", "b"])
    assert store.get(a["id"])["choices"] == ["a", "b"]


def test_record_check_pass_marks_done(store):
    a = store.pin("dns", check_kind="dns_ns", check_arg="x=y")
    store.record_check(a["id"], True, "all NS end with y")
    r = store.get(a["id"])
    assert r["status"] == "done"
    assert r["last_check_result"] == "all NS end with y"


def test_record_check_fail_stays_open(store):
    a = store.pin("dns", check_kind="dns_ns", check_arg="x=y")
    store.record_check(a["id"], False, "no NS records")
    r = store.get(a["id"])
    assert r["status"] == "open"
    assert r["last_checked_at"] is not None


def test_get_store_reuses_one_store_per_connection(tmp_path):
    import sqlite3

    from hermes_plugins.corkboard import store as store_mod

    conn = sqlite3.connect(tmp_path / "s.db", check_same_thread=False)
    try:
        store_mod.set_connection(conn)
        first = store_mod.get_store()
        assert store_mod.get_store() is first
        store_mod.set_connection(sqlite3.connect(tmp_path / "t.db", check_same_thread=False))
        assert store_mod.get_store() is not first
    finally:
        store_mod.reset_connection()
        conn.close()
