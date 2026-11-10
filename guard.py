"""Secret-shape guard: keep credentials out of pin fields, questions, and answers."""

from __future__ import annotations

import re


class SecretRejected(ValueError):
    """A value looks like a credential and was refused."""


# Well-known vendor prefixes: always a credential, wherever they appear.
_VENDOR_PATTERNS = (
    re.compile(r"sk-[A-Za-z0-9]{16,}"),
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"gho_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"),
)

# A long base64-ish run standing on its own. `/` is left out of the run and a neighbouring
# `/` disqualifies it, so a long URL or path segment is never mistaken for a key.
_BARE_RUN = re.compile(r"(?<![A-Za-z0-9+/=])[A-Za-z0-9+]{40,}={0,2}(?![A-Za-z0-9+/=])")
_HEX = re.compile(r"[0-9A-Fa-f]+")


def _is_secret_run(run: str) -> bool:
    """A random-looking run: not pure hex (git commit ids, checksums are not secrets), and
    mixing character classes the way generated keys do."""
    body = run.rstrip("=")
    if _HEX.fullmatch(body):
        return False
    classes = sum((
        any(c.isupper() for c in body),
        any(c.islower() for c in body),
        any(c.isdigit() for c in body),
    ))
    return classes >= 2 and len(set(body)) >= 10


def looks_like_token(value: str) -> bool:
    value = value or ""
    if any(p.search(value) for p in _VENDOR_PATTERNS):
        return True
    return any(_is_secret_run(m.group(0)) for m in _BARE_RUN.finditer(value))


# Questions that would collect credentials; a text pin may never ask for these.
_SECRET_QUESTION_RE = re.compile(
    r"(?i)\b(?:"
    r"api[ _-]?key|api[ _-]?secret|access[ _-]?token|auth[ _-]?token|refresh[ _-]?token|"
    r"bearer[ _-]?token|private[ _-]?key|ssh[ _-]?key|"
    r"password|passwd|secret|credential|token|"
    r"credit[ _-]?card|cvc|cvv|security[ _-]?code|card[ _-]?number"
    r")\b"
)


def asks_for_secret(question: str) -> bool:
    return bool(_SECRET_QUESTION_RE.search(question or ""))


def assert_not_token(value: str, *, field: str = "value") -> None:
    value = (value or "").strip()
    if looks_like_token(value):
        raise SecretRejected(
            f"{field} looks like a credential; keep secrets in a secrets manager, not on the board"
        )


def assert_question_safe(question: str) -> None:
    if asks_for_secret(question):
        raise SecretRejected(
            "a text pin may not collect credentials; make it a task pin naming the command "
            "the owner runs themselves"
        )
