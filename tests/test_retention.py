"""Retention tests: closed pins older than the window are purged, open pins are
never touched, 0 keeps everything, and the hourly throttle is honored."""

from hermes_plugins.corkboard import store as store_mod

NOW = 2_000_000_000


def _close(store, pin_id, status, ts):
    store.conn.execute(
        "UPDATE pins SET status = ?, closed_at = ? WHERE id = ?", (status, ts, pin_id)
    )
    store.conn.commit()


def test_purge_removes_old_closed_pins(store):
    old = store.pin("old", source="manual")
    store.mark(old["id"], "done")
    _close(store, old["id"], "done", NOW - 40 * 86400)
    young = store.pin("young", source="manual")
    store.mark(young["id"], "dismissed")
    _close(store, young["id"], "dismissed", NOW - 10 * 86400)

    assert store.purge_closed(30, now=NOW) == 1
    assert store.get(old["id"]) is None
    assert store.get(young["id"]) is not None


def test_purge_never_touches_open_pins(store):
    pin = store.pin("open", source="manual")
    _close(store, pin["id"], "open", NOW - 100 * 86400)
    assert store.purge_closed(30, now=NOW) == 0
    assert store.get(pin["id"]) is not None


def test_purge_zero_keeps_all(store):
    pin = store.pin("done", source="manual")
    store.mark(pin["id"], "done")
    _close(store, pin["id"], "done", NOW - 1000 * 86400)
    assert store.purge_closed(0, now=NOW) == 0
    assert store.get(pin["id"]) is not None


def test_dismiss_sets_closed_at(store):
    pin = store.pin("dismiss me", source="manual")
    store.mark(pin["id"], "dismissed")
    row = store.get(pin["id"])
    assert row["status"] == "dismissed"
    assert row["closed_at"] is not None


def test_maybe_purge_throttles_to_once_per_hour(store):
    old = store.pin("old", source="manual")
    store.mark(old["id"], "done")
    _close(store, old["id"], "done", NOW - 40 * 86400)
    assert store_mod.maybe_purge(store, 30, now=NOW) == 1

    old2 = store.pin("old2", source="manual")
    store.mark(old2["id"], "done")
    _close(store, old2["id"], "done", NOW - 40 * 86400)
    # Within the same hour: throttled.
    assert store_mod.maybe_purge(store, 30, now=NOW + 100) == 0
    assert store.get(old2["id"]) is not None
    # Force bypasses the throttle.
    assert store_mod.maybe_purge(store, 30, force=True, now=NOW + 100) == 1
    assert store.get(old2["id"]) is None
