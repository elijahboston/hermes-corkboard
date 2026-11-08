"""Secret-shape guard: keep credentials out of pin fields, questions, and answers."""

from __future__ import annotations

import re


class SecretRejected(ValueError):
    """A value looks like a credential and was refused."""


# Token-shaped values: long base64/hex runs and well-known vendor prefixes.
_TOKEN_PATTERNS = (
    re.compile(r"sk-[A-Za-z0-9]{16,}"),
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"gho_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"[A-Za-z0-9+/]{40,}={0,2}"),
    re.compile(r"[A-Fa-f0-9]{40,}"),
)

# Questions that would collect credentials; a text pin may never ask for these.
_SECRET_QUESTION_RE = re.compile(
    r"(?i)\b(?:"
    r"api[ _-]?key|api[ _-]?secret|access[ _-]?token|auth[ _-]?token|refresh[ _-]?token|"
    r"bearer[ _-]?token|private[ _-]?key|ssh[ _-]?key|"
    r"password|passwd|secret|credential|token|"
    r"credit[ _-]?card|cvc|cvv|security[ _-]?code|card[ _-]?number"
    r")\b"
)


def looks_like_token(value: str) -> bool:
    return any(p.search(value) for p in _TOKEN_PATTERNS)


def asks_for_secret(question: str) -> bool:
    return bool(_SECRET_QUESTION_RE.search(question or ""))


def assert_not_token(value: str, *, field: str = "value") -> None:
    value = (value or "").strip()
    if looks_like_token(value):
        raise SecretRejected(
            f"{field} looks like a credential; use the vault or `alchemy login` instead"
        )


def assert_question_safe(question: str) -> None:
    if asks_for_secret(question):
        raise SecretRejected(
            "a text pin may not collect credentials; make it a task pin naming the command "
            "the owner runs himself"
        )
