from unittest.mock import MagicMock, patch

import pytest
import requests

from app.config import settings
from app.services import local_ai_service
from app.services.local_ai_service import (
    LocalAIServiceError,
    _build_messages,
    _normalize_provider,
    generate_local_ai_response,
    get_local_ai_config,
)


# ==================================================
# PROVIDER NORMALIZATION
# ==================================================

def test_normalize_provider_uses_settings_default(monkeypatch):
    monkeypatch.setattr(settings, "AI_PROVIDER", "LMStudio")

    assert _normalize_provider(None) == "lmstudio"


def test_normalize_provider_trims_and_lowercases():
    assert _normalize_provider("  Ollama ") == "ollama"


def test_normalize_provider_rejects_unknown_provider():
    with pytest.raises(LocalAIServiceError):
        _normalize_provider("openai")


# ==================================================
# CONFIG
# ==================================================

def test_get_local_ai_config_returns_settings(monkeypatch):
    monkeypatch.setattr(settings, "AI_PROVIDER", "ollama")
    monkeypatch.setattr(settings, "AI_MODEL", "test-model")
    monkeypatch.setattr(settings, "AI_OLLAMA_BASE_URL", "http://ollama:11434")
    monkeypatch.setattr(settings, "AI_LMSTUDIO_BASE_URL", "http://lmstudio:1234/v1")
    monkeypatch.setattr(settings, "AI_REQUEST_TIMEOUT_SECONDS", 12)

    assert get_local_ai_config() == {
        "provider": "ollama",
        "model": "test-model",
        "ollama_base_url": "http://ollama:11434",
        "lmstudio_base_url": "http://lmstudio:1234/v1",
        "timeout_seconds": 12,
    }


# ==================================================
# MESSAGE BUILDING
# ==================================================

def test_build_messages_without_system_prompt():
    assert _build_messages("hello") == [{"role": "user", "content": "hello"}]


def test_build_messages_with_system_prompt():
    assert _build_messages("hello", "be brief") == [
        {"role": "system", "content": "be brief"},
        {"role": "user", "content": "hello"},
    ]


# ==================================================
# OLLAMA
# ==================================================

@patch("app.services.local_ai_service.requests.post")
def test_generate_response_via_ollama(mock_post, monkeypatch):
    monkeypatch.setattr(settings, "AI_OLLAMA_BASE_URL", "http://ollama:11434/")
    monkeypatch.setattr(settings, "AI_REQUEST_TIMEOUT_SECONDS", 30)

    mock_post.return_value = MagicMock(
        **{"json.return_value": {"message": {"content": "hi there"}}}
    )

    result = generate_local_ai_response(
        "hello", system_prompt="be brief", provider="ollama", model="llama3"
    )

    assert result == {
        "provider": "ollama",
        "model": "llama3",
        "response": "hi there",
    }

    url, kwargs = mock_post.call_args[0][0], mock_post.call_args[1]
    assert url == "http://ollama:11434/api/chat"
    assert kwargs["timeout"] == 30
    assert kwargs["json"]["model"] == "llama3"
    assert kwargs["json"]["stream"] is False
    assert kwargs["json"]["messages"][0]["role"] == "system"


@patch("app.services.local_ai_service.requests.post")
def test_ollama_empty_response_raises(mock_post):
    mock_post.return_value = MagicMock(**{"json.return_value": {"message": {}}})

    with pytest.raises(LocalAIServiceError, match="Ollama returned an empty response"):
        generate_local_ai_response("hello", provider="ollama", model="llama3")


@patch("app.services.local_ai_service.requests.post")
def test_ollama_http_error_is_wrapped(mock_post):
    response = MagicMock()
    response.raise_for_status.side_effect = requests.RequestException("boom")
    mock_post.return_value = response

    with pytest.raises(LocalAIServiceError, match="Request to local AI provider failed"):
        generate_local_ai_response("hello", provider="ollama", model="llama3")


# ==================================================
# LM STUDIO
# ==================================================

@patch("app.services.local_ai_service.requests.post")
def test_generate_response_via_lmstudio(mock_post, monkeypatch):
    monkeypatch.setattr(settings, "AI_LMSTUDIO_BASE_URL", "http://lmstudio:1234/v1/")
    monkeypatch.setattr(settings, "AI_LMSTUDIO_API_KEY", "secret-key")

    mock_post.return_value = MagicMock(
        **{"json.return_value": {"choices": [{"message": {"content": "answer"}}]}}
    )

    result = generate_local_ai_response("hello", provider="lmstudio", model="qwen")

    assert result["provider"] == "lmstudio"
    assert result["response"] == "answer"

    url, kwargs = mock_post.call_args[0][0], mock_post.call_args[1]
    assert url == "http://lmstudio:1234/v1/chat/completions"
    assert kwargs["headers"]["Authorization"] == "Bearer secret-key"
    assert kwargs["json"]["temperature"] == 0.2


@patch("app.services.local_ai_service.requests.post")
def test_lmstudio_missing_choices_raises(mock_post):
    mock_post.return_value = MagicMock(**{"json.return_value": {"choices": []}})

    with pytest.raises(LocalAIServiceError, match="LM Studio returned an empty response"):
        generate_local_ai_response("hello", provider="lmstudio", model="qwen")


@patch("app.services.local_ai_service.requests.post")
def test_lmstudio_malformed_choice_raises(mock_post):
    mock_post.return_value = MagicMock(**{"json.return_value": {"choices": ["nope"]}})

    with pytest.raises(LocalAIServiceError, match="LM Studio returned an empty response"):
        generate_local_ai_response("hello", provider="lmstudio", model="qwen")


# ==================================================
# MODEL RESOLUTION
# ==================================================

def test_generate_response_requires_model(monkeypatch):
    monkeypatch.setattr(settings, "AI_MODEL", "  ")

    with pytest.raises(LocalAIServiceError, match="No AI model configured"):
        generate_local_ai_response("hello", provider="ollama")


def test_generate_response_falls_back_to_configured_model(monkeypatch):
    monkeypatch.setattr(settings, "AI_MODEL", "configured-model")
    monkeypatch.setattr(
        local_ai_service, "_ollama_chat", lambda model, prompt, system_prompt: model
    )

    result = generate_local_ai_response("hello", provider="ollama")

    assert result["model"] == "configured-model"
    assert result["response"] == "configured-model"
