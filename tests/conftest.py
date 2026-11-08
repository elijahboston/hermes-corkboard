"""Shared fixtures: load the repo root as the plugin package (under Hermes's real module
name) and a stub Hermes ``ctx`` recording registrations."""

from __future__ import annotations

import importlib
import importlib.util
import sqlite3
import sys
import types
from pathlib import Path
from typing import Any, Callable

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
PACKAGE = "hermes_plugins.corkboard"
PARENT = "hermes_plugins"


def _ensure_parent() -> None:
    if PARENT not in sys.modules:
        ns = types.ModuleType(PARENT)
        ns.__path__ = []
        sys.modules[PARENT] = ns


def load_plugin():
    """Import the repo-root ``__init__.py`` as ``hermes_plugins.corkboard`` (as Hermes would)."""
    module = sys.modules.get(PACKAGE)
    if module is not None:
        return module
    _ensure_parent()
    spec = importlib.util.spec_from_file_location(
        PACKAGE, REPO_ROOT / "__init__.py", submodule_search_locations=[str(REPO_ROOT)]
    )
    module = importlib.util.module_from_spec(spec)
    module.__package__ = PACKAGE
    module.__path__ = [str(REPO_ROOT)]
    sys.modules[PACKAGE] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        del sys.modules[PACKAGE]
        raise
    return module


# pytest may collect the repo-root ``__init__.py`` as top-level ``__init__``; hand it the
# already-loaded package so its relative imports resolve.
sys.modules.setdefault("__init__", load_plugin())


class StubCtx:
    """The documented plugin ``ctx`` surface, recording registrations."""

    def __init__(self) -> None:
        self.hooks: dict[str, Callable[..., Any]] = {}
        self.tools: dict[str, dict[str, Any]] = {}
        self.commands: dict[str, dict[str, Any]] = {}
        self.cli_commands: dict[str, dict[str, Any]] = {}

    def register_hook(self, name: str, callback: Callable[..., Any]) -> None:
        self.hooks[name] = callback

    def register_tool(self, name, toolset, schema, handler, check_fn=None, requires_env=None,
                      is_async=False, description="", emoji="", override=False) -> None:
        self.tools[name] = dict(toolset=toolset, schema=schema, handler=handler,
                                check_fn=check_fn, description=description)

    def register_command(self, name, handler, description="", args_hint="", argument_mode=None) -> None:
        self.commands[name] = dict(handler=handler, description=description, args_hint=args_hint)

    def register_cli_command(self, name, help, setup_fn, handler_fn=None, description="") -> None:
        self.cli_commands[name] = dict(help=help, setup_fn=setup_fn, handler_fn=handler_fn,
                                       description=description)


@pytest.fixture
def plugin():
    return load_plugin()


@pytest.fixture
def registered_ctx(plugin):
    ctx = StubCtx()
    plugin.register(ctx)
    return ctx


@pytest.fixture
def store(tmp_path):
    import hermes_plugins.corkboard.store as store_mod

    conn = sqlite3.connect(tmp_path / "corkboard.db", check_same_thread=False)
    store_mod.set_connection(conn)
    s = store_mod.Store(conn)
    yield s
    conn.close()
    store_mod.reset_connection()
