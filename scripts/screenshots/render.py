# /// script
# requires-python = ">=3.10"
# dependencies = ["playwright>=1.45"]
# ///
"""Render the README screenshots from the real desktop/plugin.js.

    uv run scripts/screenshots/render.py            # all images
    uv run scripts/screenshots/render.py --only pane-inbox-dark

index.html loads ../../desktop/plugin.js with a stub SDK (sdk.js) and sample pins, so the
shots always match the code in this checkout. React comes from esm.sh, so it needs network.
First run: `uv run --with playwright playwright install chromium`.
"""
from __future__ import annotations

import argparse
import functools
import http.server
import socketserver
import threading
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
SHOTS = ROOT / "docs" / "screenshots"
WIDTH = 352  # 320px pane + 16px padding each side


def serve() -> tuple[socketserver.TCPServer, int]:
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, format: str, *args: object) -> None:  # noqa: A002
            pass

    handler = functools.partial(Quiet, directory=str(ROOT))
    httpd = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def open_pane(page: Page, base: str, theme: str, height: int) -> None:
    page.set_viewport_size({"width": WIDTH, "height": height + 32})
    page.goto(f"{base}/scripts/screenshots/index.html?theme={theme}")
    page.wait_for_function("window.__ready === true", timeout=30_000)
    page.evaluate(f"document.documentElement.style.setProperty('--h', '{height}px')")
    page.wait_for_timeout(1200)


def click_text(page: Page, pattern: str) -> None:
    ok = page.evaluate(
        """(rx) => { const el = Array.from(document.querySelectorAll('#root *'))
             .find(e => e.children.length === 0 && new RegExp(rx).test(e.textContent));
           if (!el) return false; el.click(); return true }""",
        pattern,
    )
    if not ok:
        raise SystemExit(f"no row matching {pattern!r}")
    page.wait_for_timeout(600)


def snap(page: Page, out: Path, height: int) -> None:
    page.screenshot(path=str(out), clip={"x": 0, "y": 0, "width": WIDTH, "height": height + 32})
    print(out.relative_to(ROOT))


def inbox_dark(page, base):
    open_pane(page, base, "dark", 590)
    click_text(page, "Pick a name")
    snap(page, SHOTS / "pane-inbox-dark.png", 590)


def inbox_light(page, base):
    open_pane(page, base, "light", 470)
    snap(page, SHOTS / "pane-inbox-light.png", 470)


def detail_dark(page, base):
    open_pane(page, base, "dark", 600)
    click_text(page, "Renew the example")
    snap(page, SHOTS / "pane-detail-dark.png", 600)


def done_undo_dark(page, base):
    open_pane(page, base, "dark", 470)
    page.evaluate("document.getElementById('tab').textContent = 'CORKBOARD (6)'")
    page.locator('#root button[aria-label*="done" i], #root button[title*="done" i]').first.click()
    page.wait_for_timeout(500)
    snap(page, SHOTS / "pane-done-undo-dark.png", 470)


JOBS = {
    "pane-inbox-dark": inbox_dark,
    "pane-inbox-light": inbox_light,
    "pane-detail-dark": detail_dark,
    "pane-done-undo-dark": done_undo_dark,
}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", choices=sorted(JOBS), action="append", help="render just these (repeatable)")
    args = ap.parse_args()
    names = args.only or list(JOBS)
    SHOTS.mkdir(parents=True, exist_ok=True)
    httpd, port = serve()
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            for name in names:
                page = browser.new_page(device_scale_factor=2)  # 2x for sharpness
                JOBS[name](page, f"http://127.0.0.1:{port}")
                page.close()
            browser.close()
    finally:
        httpd.shutdown()


if __name__ == "__main__":
    main()
