# Corkboard Plugin — Plan

> **For Hermes:** implement as a standalone plugin repo, task by task, with tests through real plugin discovery.

**Goal:** One place where agents pin "only the owner can do this" items, and where items clear themselves when a check passes.

**Architecture:** A general Hermes plugin (`plugin.yaml` + `register(ctx)`). Storage in `plugin_db("corkboard")` (SQLite under `<hermes home>/plugin-data/corkboard/`). One agent tool, one CLI command, one slash command, one hook. No core changes.

**Tech stack:** Python, Hermes `PluginContext` (`register_tool`, `register_cli_command`, `register_command`, `register_hook`), `plugins/plugin_storage.plugin_db`, `cronjob` for periodic checks.

**Interim:** until this ships, a markdown note (e.g. `owner-corkboard.md`) is the board. Import it on first run (Task 9).

---

## Why (the problem)

Owner-only work is scattered: kanban `needs_input` blocks, Linear comments, and chat replies. Today's list (LLC filing, EIN, nameservers, Neon key, Homebrew tap) only existed inside one chat message. Nothing reminds the owner, and nothing notices when an item is done.

## Footprint check (per repo AGENTS.md)

- Plugins never touch core: everything goes through `ctx`. ✓
- Not a third-party product, but still ships as **its own repo** (`hermes-corkboard`), installed into `~/.hermes/plugins/`. Catalog submission optional later.
- One new tool (`corkboard`), not core. Gate it with `check_fn` only on "plugin enabled", never per-session.

## Data model (one table)

```sql
CREATE TABLE pins (
  id TEXT PRIMARY KEY,            -- uuid4
  title TEXT NOT NULL,            -- one line: what is needed
  link TEXT,                      -- card / issue / URL
  unblocks TEXT,                  -- what this frees up
  check_kind TEXT,                -- null | 'dns_ns' | 'command' | 'kanban_unblocked' | 'linear_done'
  check_arg TEXT,                 -- e.g. 'example.com=ns.cloudflare.com' or a shell command
  source TEXT NOT NULL,           -- 'agent:<profile>' | 'kanban:<board>/<task>' | 'manual'
  dedupe_key TEXT UNIQUE,         -- e.g. 'kanban:default/t_0123abcd'
  status TEXT NOT NULL DEFAULT 'open',   -- open | done | dismissed
  created_at INTEGER NOT NULL,
  done_at INTEGER,
  last_checked_at INTEGER,
  last_check_result TEXT
);
```

No secrets in any field. The tool rejects values that look like tokens (simple regex: long base64/hex, `sk-`, `ghp_`).

The table lives in **one shared database for every profile** at
`<hermes root>/plugin-data/corkboard/data.db` (`~/.hermes/plugin-data/corkboard/data.db`, beside
`profiles/`, never inside one). `get_connection()` resolves `get_default_hermes_root()` on every
open and opens it through `hermes_cli.sqlite_util.open_db` (WAL + network-FS fallbacks) with a
5s busy timeout. This is what makes a pin the kanban worker creates appear on the owner's default
profile desktop pane: worker and default profile were previously writing to two different
`<profile>/plugin-data/corkboard/` dirs, so the owner never saw auto-pinned items.

## Surfaces

| Surface | What |
|---|---|
| Tool `corkboard` | actions `pin`, `list`, `done`, `dismiss`. Agents call `pin` when they hit owner-only work. `pin` with an existing `dedupe_key` updates instead of duplicating. |
| CLI `hermes corkboard` | `list` (default), `done <id>`, `dismiss <id>`, `add "<title>" [--link] [--check-dns d=ns]`, `check` (run all checks now), `import <md>` |
| Slash `/corkboard` | same `list` view inside chat/desktop/Telegram |
| Hook `on_kanban_dispatch_tick` | scan the board for tasks in `blocked` with kind `needs_input`/`capability`; pin each (dedupe by task id); mark the pin done when the task leaves `blocked` |
| Cron (optional) | `hermes corkboard check` every hour + a morning digest to Telegram. The owner sets this up themselves (user preference); the plugin README gives the command. |

### Pin kinds and owner responses

Mirrors the `clarify` tool's shape so agents already know it.

| `kind` | UI control | Answer stored |
|---|---|---|
| `task` (default) | Done button; or auto-clears via its check | none |
| `yes_no` | Yes / No buttons + optional note | `"yes"` / `"no"` + note |
| `choice` | up to 4 `choices` (first = recommended, labelled "Recommended") + "Other" free text | chosen label or the Other text |
| `text` | text box (optional `placeholder`) | the text |

Schema additions to `pins`: `kind TEXT NOT NULL DEFAULT 'task'`, `question TEXT`, `choices TEXT` (JSON array), `answer TEXT`, `answer_note TEXT`, `answered_at INTEGER`, `reply_to TEXT` (`kanban:<board>/<task>` | `session:<profile>/<id>` | null).

**Answer routing**
- `reply_to = kanban:…` → post `Owner decision: <answer>[ — <note>]` as a comment on the card. A comment on a blocked card already auto-resumes the worker (existing kanban behavior), so no new plumbing. Auto-pinned blocked cards default to `kind=text` with the block reason as the question.
- `reply_to = session:…` → store the answer and `broadcast_plugin_event("corkboard", "pin.answered", …)`; the tool's `list`/`get` action lets the asking agent read answered pins on its next run.
- Every answer moves the pin to Done with answer + timestamp kept (decision history). The CLI and `/corkboard` can answer too: `hermes corkboard answer <id> yes|no|"<text>"`.

**Secrets rule (hard):** a `text` pin may never collect credentials. The tool refuses to create one whose question matches key/token/password/secret/card/CVC/API-key patterns, and the answer path runs the same token-shape guard as Task 3 (reject and point the owner at a secrets manager). Credential needs are always `task` pins that name the command the owner runs themselves.

Add tasks: 16 schema + kinds in store/tool; 17 answer routing (kanban comment + session event) with tests; 18 desktop controls per kind (buttons, choice list + Other, text box); 19 CLI `answer` + secret guard tests on question and answer.

### Desktop half (one package, both SDKs)

Per the Desktop Plugin SDK "One package, both SDKs" layout, the same folder ships the UI:

```
hermes-corkboard/
├── plugin.yaml              # agent half: tool, CLI, slash, hook
├── __init__.py
├── dashboard/
│   ├── manifest.json        # { "name": "corkboard", "api": "plugin_api.py" }
│   └── plugin_api.py        # GET /api/plugins/corkboard/pins, POST …/pins/<id>/done|dismiss
└── desktop/
    └── plugin.js            # sidebar page + "open beside chat" tab + status-bar badge
```

- **Page + sidebar nav** (`ROUTES_AREA` + `SIDEBAR_NAV_AREA`): the one home — a full "Corkboard" page, reachable from the sidebar.
- **"Open beside chat"** (`host.openWorkspace`): docks the same board as a closable tab in the main workspace zone; feature-detected, re-call re-fronts it.
- **Status-bar badge** (`STATUSBAR_AREAS.right`): open-pin count (hidden at zero); click navigates to the page.
- **Live updates**: when a pin is added or cleared, `plugin_api` calls `broadcast_plugin_event("corkboard", "pins.changed", {...})`; the desktop half subscribes with `host.onEvent` and refetches.
- **Native notification**: optional, only when a NEW pin arrives (never steals focus — Desktop AGENTS.md "offer, don't hijack").
- **Kanban card badge** (`KANBAN_CARD_AREAS.badges`): optional "📌 owner" label on cards that have a pin.
- The web dashboard gets the same list for free via `plugin_api.py`; a dashboard tab is optional.
- Note: `plugin_api.py` loads only when the plugin is in `plugins.enabled` in `config.yaml` (security boundary).

Add tasks 12–15: `plugin_api.py` routes + tests; `desktop/plugin.js` page + nav + workspace tab; status-bar badge + event subscription; manual check in the desktop app.

**Hook note:** `on_kanban_task_updated` does NOT fire for block/unblock (it covers writes "outside claim/complete/block"), so blocked-card detection uses `on_kanban_dispatch_tick` and re-reads blocked tasks. Verify this in Task 6 before relying on it.

## Checks (auto-clear)

| kind | arg | passes when |
|---|---|---|
| `dns_ns` | `domain=suffix` | every NS record for `domain` ends with `suffix` (`socket`-free: shell `dig +short NS`, or `dnspython` if available) |
| `command` | shell command | exit 0 (5 s timeout). Only the owner may add `command` checks via the CLI; the agent tool may not (avoids agents pinning arbitrary shell). |
| `kanban_unblocked` | `board/task` | task status is not `blocked` |
| `linear_done` | `ENG-123` | deferred: needs Linear access from the plugin; skip in v1 |

A passing check sets `status=done`, `done_at`, and records `last_check_result`. Failing checks never raise; they record the reason.

## Tasks

1. **Scaffold repo** `hermes-corkboard/`: `plugin.yaml` (name, version, description, `provides_tools: [corkboard]`, `provides_hooks: [on_kanban_dispatch_tick]`), `__init__.py` with `register(ctx)`, `README.md`, `tests/`.
2. **Storage module** `store.py`: open via `plugin_db("corkboard")`, create table, `pin()`, `list_open()`, `mark(id, status)`, dedupe upsert. Test with a temp `HERMES_HOME`: pin twice with one `dedupe_key` → one row.
3. **Secret guard** `guard.py` + test: token-looking strings are rejected with a clear error.
4. **Tool** `corkboard` (schema: action, title, link, unblocks, check_kind ∈ {dns_ns, kanban_unblocked}, check_arg, dedupe_key). Test through real plugin discovery: tool registered, `pin` then `list` returns it.
5. **CLI** `hermes corkboard` with `list/add/done/dismiss/check/import`. Test `list` output and `done`.
6. **Kanban auto-pin**: hook on `on_kanban_dispatch_tick`; first confirm with a temp board that a block→tick shows the task (and record what fires). Test: block a task → pin exists; unblock → pin done.
7. **Checks** `checks.py`: `dns_ns`, `command`, `kanban_unblocked`, each with a test (dns via a stubbed resolver function, not the network).
8. **Slash command** `/corkboard` returning the same list text.
9. **Import** `hermes corkboard import ./owner-corkboard.md`: parse the Open table rows into pins (dns checks inferred from the Check column when it is a `dig` line).
10. **Docs**: README with install, the hourly-check cron command, and the agent rule "pin owner-only work instead of writing it in chat".
11. **Skill line**: add one rule to the `knowledge-capture` (or kanban) skill: "owner-only work → `corkboard pin`".

## Validation

- `scripts/run_tests.sh`-style pytest run in the plugin repo against a temp `HERMES_HOME`; never touches `~/.hermes`.
- `hermes plugins validate ./hermes-corkboard` passes.
- Manual: install, `hermes corkboard import …`, confirm 9 open pins; after a nameserver change, `hermes corkboard check` clears the DNS pin.

## Open questions

1. ~~Desktop panel~~ RESOLVED: the Desktop Plugin SDK (`website/docs/developer-guide/desktop-plugin-sdk.md`) supports it — see "Desktop half" below.
2. Morning digest channel: Telegram DM or a dedicated topic?
3. Keep `Owner Corkboard.md` as a generated read-only mirror after the plugin ships (handy in Obsidian), or retire it?
