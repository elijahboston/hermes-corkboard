"""Age, sorting, and status-filtering tests for the Python half."""

import pytest

from hermes_plugins.corkboard import actions


def test_time_ago_buckets():
    now = 1_000_000_000
    assert actions.time_ago(now - 5, now) == "just now"
    assert actions.time_ago(now - 30, now) == "30 seconds ago"
    assert actions.time_ago(now - 60, now) == "1 minute ago"
    assert actions.time_ago(now - 300, now) == "5 minutes ago"
    assert actions.time_ago(now - 3600, now) == "1 hour ago"
    assert actions.time_ago(now - 3 * 3600, now) == "3 hours ago"
    assert actions.time_ago(now - 86400, now) == "1 day ago"
    assert actions.time_ago(now - 6 * 86400, now) == "6 days ago"
    assert actions.time_ago(now - 7 * 86400, now) == "1 week ago"
    assert actions.time_ago(now - 28 * 86400, now) == "4 weeks ago"
    assert actions.time_ago(now - 30 * 86400, now) == "1 month ago"
    assert actions.time_ago(now - 330 * 86400, now) == "11 months ago"
    assert actions.time_ago(now - 365 * 86400, now) == "1 year ago"
    assert actions.time_ago(now - 730 * 86400, now) == "2 years ago"
    assert actions.time_ago(None, now) == ""
    assert actions.time_ago("not a number", now) == ""


def _set_created(store, pin, ts):
    store.conn.execute("UPDATE pins SET created_at = ? WHERE id = ?", (ts, pin["id"]))
    store.conn.commit()


def test_list_sort_newest_and_oldest(store):
    older = store.pin("older", source="manual")
    newer = store.pin("newer", source="manual")
    _set_created(store, older, 100)
    _set_created(store, newer, 200)

    assert [p["id"] for p in actions.list_pins(store, status="all", sort="newest")] == [
        newer["id"], older["id"],
    ]
    assert [p["id"] for p in actions.list_pins(store, status="all", sort="oldest")] == [
        older["id"], newer["id"],
    ]


def test_list_default_is_open(store):
    open_pin = store.pin("open", source="manual")
    done_pin = store.pin("done", source="manual")
    store.mark(done_pin["id"], "done")
    assert [p["id"] for p in actions.list_pins(store)] == [open_pin["id"]]


def test_list_status_filter(store):
    a = store.pin("a", source="manual")
    d = store.pin("d", source="manual")
    store.mark(d["id"], "dismissed")
    assert [p["id"] for p in actions.list_pins(store, status="dismissed")] == [d["id"]]
    assert {p["id"] for p in actions.list_pins(store, status="all")} == {a["id"], d["id"]}


def test_list_invalid_status_raises(store):
    with pytest.raises(ValueError):
        actions.list_pins(store, status="bogus")


def test_list_invalid_sort_raises(store):
    with pytest.raises(ValueError):
        actions.list_pins(store, sort="bogus")
