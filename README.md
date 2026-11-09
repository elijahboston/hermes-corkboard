# corkboard

One place where agents pin **"only the owner can do this"** items — and where items clear
themselves when a check passes.

A native Hermes general plugin: one agent tool (`corkboard`), one CLI command
(`hermes corkboard`), one slash command (`/corkboard`), kanban auto-pin hooks, and a desktop
half (a sidebar page, an "open beside chat" workspace tab, and a status-bar badge) that
shares the same backend as the web dashboard.

## Install

Clone or symlink this repo into `~/.hermes/plugins/corkboard/`, then enable it:

```bash
ln -s ~/src/hermes-corkboard ~/.hermes/plugins/corkboard
hermes plugins enable corkboard
```

Or add it to `config.yaml` directly:

```yaml
plugins:
  enabled:
    - corkboard
```

The desktop half ships in the same folder (`desktop/plugin.js` + `dashboard/plugin_api.py`).
Like every desktop plugin it is opt-in: enable it in **Capabilities → Plugins**. The backend
(`plugin_api.py`) loads only while `corkboard` is in `plugins.enabled` — that is the security
boundary, not a renderer toggle.

Enable the plugin in **each profile that should pin** — the default profile, the kanban worker,
the reviewer — not just the default. Only enabled profiles run their hooks and tools.

## Shared board (all profiles)

The board is one SQLite database shared by every Hermes profile. It lives at
`<hermes root>/plugin-data/corkboard/data.db` — that is `~/.hermes/plugin-data/corkboard/data.db`,
next to the `profiles/` directory, never inside one. The default (pre-profile) root is resolved on
every open, so a pin the worker creates shows up on the owner's desktop page and the CLI in the
default profile.

## Desktop

One home: the **Corkboard** page, reached from the sidebar nav (`pin` icon) or by clicking the
status-bar badge (an open-pin count, hidden while there are no open pins). The page header has an
**Open beside chat** button that docks the same board as a closable tab in the main workspace
zone; it appears only when the desktop build supports `host.openWorkspace`. Re-opening re-fronts
the existing tab rather than duplicating it.

## CLI

```bash
hermes corkboard                         # list open pins, newest first (default)
hermes corkboard list --status all --sort oldest
hermes corkboard add "File the LLC" --link https://… --unblocks "EIN"
hermes corkboard add "Nameservers"  --check-dns example.com=ns.cloudflare.com
hermes corkboard add "Nightly job"  --check-command "systemctl is-active cron"
hermes corkboard done <id>
hermes corkboard dismiss <id>
hermes corkboard answer <id> yes|no|"free text"
hermes corkboard check              # run every open check now
hermes corkboard purge [--dry-run]  # delete closed pins past the retention window
hermes corkboard import ~/notes/Owner\ Corkboard.md
```

`<id>` may be the full uuid or a unique prefix. The slash command takes the same status
filter: `/corkboard [open|done|dismissed|all]`.

## Retention

Done and dismissed pins leave the Open view immediately but stay on the board for
`retention_days` (default 30) so you can still see what was acknowledged and when. `0` keeps
closed pins forever. Purging runs opportunistically on list and on the dispatch tick, at most
once per hour, and always skips open pins.

```bash
hermes config set plugins.entries.corkboard.settings.retention_days 14
```


## Periodic checks (add yourself)

The plugin creates no cron of its own. To auto-clear checks, the owner adds one himself:

```bash
hermes cron add "corkboard-check" --schedule "0 * * * *" -- hermes corkboard check
```

The morning digest target is **Telegram DM**; the plugin ships no cron for it. (Documented
here only; wire it up with `hermes cron` if you want it.)

## Agent rule

**Pin owner-only work instead of writing it in chat.** When a task is blocked on something
only the owner can do — a credential, a decision, a phone call, a payment — call the
`corkboard` tool with `action: "pin"` rather than leaving a message in the chat. The owner sees
every pin in one place and can answer it from the desktop page or the CLI.

## Secrets rule (hard)

No credentials in any pin. The tool refuses:

- values that look like tokens (long base64/hex, `sk-`, `ghp_`, `github_pat_`, AWS keys, …), and
- `text` pins whose question asks for keys / tokens / passwords / cards / CVC / API keys.

Credential needs are **`task` pins** that name the command the owner runs himself (the vault or
`alchemy login`), never a text box waiting for a secret.

## Kanban auto-pin

When a kanban card is blocked, `kanban_task_blocked` pins it as a `text` pin whose question is
the block reason and whose `reply_to` is the card. Answering the pin posts
`Owner decision: <answer>` as a comment on the card (a comment on a blocked card already
auto-resumes the worker). The pin clears on `kanban_task_completed` or, when the card is
unblocked but still running, on the next dispatch tick.

## Development

```bash
python3 -m pytest -q
node --check desktop/plugin.js
```

Tests run against a temp SQLite connection (stub `ctx`); they never touch `~/.hermes` or a real
board.
