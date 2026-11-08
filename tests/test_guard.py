"""Guard tests: token-shape rejection and credential-question rejection."""

import pytest

from hermes_plugins.corkboard import guard


@pytest.mark.parametrize("value", [
    "sk-" + "A" * 20,
    "ghp_" + "A" * 20,
    "github_pat_" + "A" * 24,
    "AKIA" + "0" * 16 + "ABCD",
    "A" * 40,
    "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c",
])
def test_looks_like_token(value):
    assert guard.looks_like_token(value)


def test_plain_text_is_not_token():
    assert not guard.looks_like_token("File the LLC before Friday")
    assert not guard.looks_like_token("example.com")


def test_assert_not_token_rejects():
    with pytest.raises(guard.SecretRejected):
        guard.assert_not_token("sk-" + "B" * 20, field="answer")


@pytest.mark.parametrize("question", [
    "What is your API key?",
    "Please paste the password",
    "Send me the access token",
    "What is the CVC on your card?",
    "give me the secret",
    "what is your private ssh key",
])
def test_asks_for_secret(question):
    assert guard.asks_for_secret(question)


def test_safe_questions():
    assert not guard.asks_for_secret("Should we renew the LLC this quarter?")
    assert not guard.asks_for_secret("Which domain do we point at Cloudflare?")


def test_assert_question_safe_rejects():
    with pytest.raises(guard.SecretRejected):
        guard.assert_question_safe("What is your API key?")
