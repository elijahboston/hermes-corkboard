"""Auto-clear checks. Each returns ``(ok: bool, detail: str)`` and never raises for a
failing check — the failure is the detail. Resolvers are injectable so tests stay off the
network and off a real board.
"""

from __future__ import annotations

import json
import subprocess
from typing import Any, Callable, Optional


def _strip_dot(name: str) -> str:
    return (name or "").strip().rstrip(".").lower()


def _dig_ns(domain: str) -> list[str]:
    proc = subprocess.run(
        ["dig", "+short", "NS", domain],
        capture_output=True, text=True, timeout=15, check=False,
    )
    if proc.returncode != 0:
        return []
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def dns_ns(arg: str, resolver: Optional[Callable[[str], list[str]]] = None) -> tuple[bool, str]:
    """Passes when every NS record for ``domain`` ends with ``suffix`` (``arg == "domain=suffix"``)."""
    domain, sep, suffix = (arg or "").strip().partition("=")
    domain = domain.strip().rstrip(".")
    suffix = suffix.strip().rstrip(".")
    if not domain or not sep or not suffix:
        return False, "dns_ns arg must be 'domain=suffix'"
    if resolver is None:
        resolver = _dig_ns
    try:
        records = resolver(domain)
    except Exception as exc:  # resolver died: fail with the reason
        return False, f"dns lookup failed: {exc}"
    if not records:
        return False, "no NS records"
    normalized = [_strip_dot(r) for r in records]
    suffix_l = suffix.lower()
    bad = [r for r in normalized if r != suffix_l and not r.endswith("." + suffix_l)]
    if bad:
        return False, f"NS not ending with {suffix}: {', '.join(bad)}"
    return True, f"all NS end with {suffix}"


def command(
    cmd: str, timeout: float = 5, runner: Optional[Callable[..., Any]] = None
) -> tuple[bool, str]:
    """Passes when the shell command exits 0 (5s timeout). Owner-added only."""
    cmd = (cmd or "").strip()
    if not cmd:
        return False, "empty command"
    if runner is None:
        runner = subprocess.run
    try:
        proc = runner(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, f"timed out after {timeout:g}s"
    except Exception as exc:
        return False, f"command failed: {exc}"
    if getattr(proc, "returncode", 1) != 0:
        detail = (getattr(proc, "stderr", "") or getattr(proc, "stdout", "") or "").strip()
        return False, f"exit {proc.returncode}: {detail[:200]}"
    return True, "exit 0"


def _default_kanban_lookup(arg: str) -> Optional[str]:
    board = None
    task = arg
    if "/" in arg:
        board, task = arg.split("/", 1)
    argv = ["hermes", "kanban"]
    if board:
        argv += ["--board", board]
    argv += ["show", task, "--json"]
    proc = subprocess.run(argv, capture_output=True, text=True, timeout=15, check=False)
    if proc.returncode != 0:
        return None
    try:
        data = json.loads(proc.stdout or "{}")
    except ValueError:
        return None
    return (data.get("task") or {}).get("status")


def kanban_unblocked(
    arg: str, lookup: Optional[Callable[[str], Optional[str]]] = None
) -> tuple[bool, str]:
    """Passes when the named ``board/task`` is no longer ``blocked``."""
    arg = (arg or "").strip()
    if not arg:
        return False, "kanban_unblocked arg must name a board/task"
    if lookup is None:
        lookup = _default_kanban_lookup
    try:
        status = lookup(arg)
    except Exception as exc:
        return False, f"kanban lookup failed: {exc}"
    if status is None:
        return False, "unknown task"
    return status != "blocked", f"status={status}"


_CHECKS = {
    "dns_ns": dns_ns,
    "command": command,
    "kanban_unblocked": kanban_unblocked,
}


def run_checks(store: Any) -> list[tuple[str, str, bool, str]]:
    """Run every open pin's check, record the result, and auto-done the passing ones."""
    results: list[tuple[str, str, bool, str]] = []
    for pin in store.list_pins(status="open"):
        kind = pin.get("check_kind")
        fn = _CHECKS.get(kind) if kind else None
        if fn is None:
            continue
        try:
            ok, detail = fn(pin.get("check_arg") or "")
        except Exception as exc:
            ok, detail = False, f"error: {exc}"
        store.record_check(pin["id"], ok, detail)
        results.append((pin["id"], kind, ok, detail))
    return results
