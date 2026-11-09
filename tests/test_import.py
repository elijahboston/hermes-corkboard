"""Import tests against a self-written fixture copy of the markdown corkboard table."""

from hermes_plugins.corkboard import actions

FIXTURE = """# Owner Corkboard

| Pinned | Task | Where | Check | Unblocks |
|---|---|---|---|---|
| ✅ | File the LLC | https://example.com/llc |  | EIN and bank account |
| ✅ | Point nameservers at Cloudflare |  | `dig +short NS example.com` | Site goes live |
| ☐ | Renew the domain | registrar.example |  | Everything |
"""


def test_import_parses_rows_and_dns_check(tmp_path, store):
    path = tmp_path / "corkboard.md"
    path.write_text(FIXTURE)
    rows = actions.import_markdown(store, path)
    assert len(rows) == 3
    by_title = {r["title"]: r for r in store.list_pins()}
    llc = by_title["File the LLC"]
    assert llc["link"] == "https://example.com/llc"
    assert llc["unblocks"] == "EIN and bank account"
    assert llc["check_kind"] is None

    dns = by_title["Point nameservers at Cloudflare"]
    assert dns["check_kind"] == "dns_ns"
    assert dns["check_arg"] == "example.com=ns.cloudflare.com"


def test_import_is_idempotent(tmp_path, store):
    path = tmp_path / "corkboard.md"
    path.write_text(FIXTURE)
    actions.import_markdown(store, path)
    actions.import_markdown(store, path)
    assert len(store.list_pins()) == 3


def test_import_no_table_raises(tmp_path, store):
    path = tmp_path / "other.md"
    path.write_text("# nope\n")
    try:
        actions.import_markdown(store, path)
    except ValueError as exc:
        assert "corkboard table" in str(exc)
    else:
        raise AssertionError("expected ValueError")


def test_import_placeholder_expands_bold_domains(tmp_path, store):
    path = tmp_path / "multi.md"
    path.write_text(
        "| Pinned | Task | Where | Check | Unblocks |\n"
        "|---|---|---|---|---|\n"
        "| ☐ | Add **one.example** and **two.example** to Cloudflare |  | `dig +short NS <domain>` |  |\n"
    )
    rows = actions.import_markdown(store, path)
    assert len(rows) == 2
    by_title = {r["title"]: r for r in store.list_pins()}
    one = by_title["Add one.example and two.example to Cloudflare — one.example"]
    two = by_title["Add one.example and two.example to Cloudflare — two.example"]
    assert one["check_kind"] == "dns_ns"
    assert one["check_arg"] == "one.example=ns.cloudflare.com"
    assert two["check_kind"] == "dns_ns"
    assert two["check_arg"] == "two.example=ns.cloudflare.com"


def test_import_placeholder_without_domains_is_checkless(tmp_path, store):
    path = tmp_path / "checkless.md"
    path.write_text(
        "| Pinned | Task | Where | Check | Unblocks |\n"
        "|---|---|---|---|---|\n"
        "| ☐ | Point nameservers |  | `dig +short NS <domain>` |  |\n"
    )
    rows = actions.import_markdown(store, path)
    assert len(rows) == 1
    pin = store.list_pins()[0]
    assert pin["title"] == "Point nameservers"
    assert pin["check_kind"] is None
    assert pin["check_arg"] is None
