"""Check tests: stubbed resolvers/runners/lookups — no network, no board, no shell."""

import subprocess

from hermes_plugins.corkboard import checks


class _Proc:
    def __init__(self, returncode, stdout="", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_dns_ns_passes_when_all_match():
    ok, detail = checks.dns_ns(
        "example.com=ns.cloudflare.com",
        resolver=lambda d: ["ada.ns.cloudflare.com.", "bob.ns.cloudflare.com."],
    )
    assert ok
    assert "ns.cloudflare.com" in detail


def test_dns_ns_fails_on_one_mismatch():
    ok, detail = checks.dns_ns(
        "example.com=ns.cloudflare.com",
        resolver=lambda d: ["ns1.other.net.", "ada.ns.cloudflare.com."],
    )
    assert not ok
    assert "ns1.other.net" in detail


def test_dns_ns_rejects_suffix_impostor():
    ok, _ = checks.dns_ns(
        "example.com=ns.cloudflare.com",
        resolver=lambda d: ["evilns.cloudflare.com."],
    )
    assert not ok


def test_dns_ns_fails_when_no_records():
    ok, _ = checks.dns_ns("example.com=ns.cloudflare.com", resolver=lambda d: [])
    assert not ok


def test_dns_ns_bad_arg():
    ok, detail = checks.dns_ns("noequals")
    assert not ok
    assert "domain=suffix" in detail


def test_dns_ns_resolver_error():
    def boom(_domain):
        raise RuntimeError("dig exploded")
    ok, detail = checks.dns_ns("a=b", resolver=boom)
    assert not ok
    assert "dig exploded" in detail


def test_command_exit_zero():
    ok, detail = checks.command("true", runner=lambda *a, **k: _Proc(0))
    assert ok


def test_command_nonzero():
    ok, detail = checks.command("false", runner=lambda *a, **k: _Proc(1, "", "boom"))
    assert not ok
    assert "exit 1" in detail


def test_command_timeout():
    def boom(*a, **k):
        raise subprocess.TimeoutExpired("x", 5)
    ok, detail = checks.command("sleep 30", runner=boom)
    assert not ok
    assert "timed out" in detail


def test_kanban_unblocked_running():
    ok, detail = checks.kanban_unblocked("board/t_1", lookup=lambda a: "running")
    assert ok
    assert "running" in detail


def test_kanban_unblocked_still_blocked():
    ok, detail = checks.kanban_unblocked("board/t_1", lookup=lambda a: "blocked")
    assert not ok


def test_kanban_unblocked_unknown():
    ok, detail = checks.kanban_unblocked("board/t_1", lookup=lambda a: None)
    assert not ok
    assert "unknown" in detail


def test_run_checks_records_results(store):
    store.pin("dns", check_kind="dns_ns", check_arg="a=b")
    store.pin("plain")  # no check -> skipped
    results = checks.run_checks(store)
    assert len(results) == 1
    pin_id, kind, ok, detail = results[0]
    assert kind == "dns_ns"
    assert ok is False  # resolver hits real dig -> empty/fail; never raises
