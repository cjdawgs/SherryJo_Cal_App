from __future__ import annotations

from typing import Any

import requests

from app.config import settings


class LocalAIServiceError(Exception):
    """Raised when local AI provider calls fail."""


def _normalize_provider(provider: str | None) -> str:
    resolved = (provider or settings.AI_PROVIDER or "ollama").strip().lower()
    if resolved not in {"ollama", "lmstudio"}:
        raise LocalAIServiceError(
            "Unsupported AI provider. Use 'ollama' or 'lmstudio'."
        )
    return resolved


def get_local_ai_config() -> dict[str, Any]:
    provider = _normalize_provider(settings.AI_PROVIDER)
    return {
        "provider": provider,
        "model": settings.AI_MODEL,
        "ollama_base_url": settings.AI_OLLAMA_BASE_URL,
        "lmstudio_base_url": settings.AI_LMSTUDIO_BASE_URL,
        "timeout_seconds": settings.AI_REQUEST_TIMEOUT_SECONDS,
    }


def _build_messages(prompt: str, system_prompt: str | None = None) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})
    return messages


def _ollama_chat(
    model: str,
    prompt: str,
    system_prompt: str | None,
) -> str:
    base_url = settings.AI_OLLAMA_BASE_URL.rstrip("/")
    payload = {
        "model": model,
        "messages": _build_messages(prompt, system_prompt),
        "stream": False,
    }

    response = requests.post(
        f"{base_url}/api/chat",
        json=payload,
        timeout=settings.AI_REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()

    data = response.json()
    message = data.get("message") or {}
    content = message.get("content")

    if not content:
        raise LocalAIServiceError("Ollama returned an empty response.")

    return str(content)


def _lmstudio_chat(
    model: str,
    prompt: str,
    system_prompt: str | None,
) -> str:
    base_url = settings.AI_LMSTUDIO_BASE_URL.rstrip("/")
    payload = {
        "model": model,
        "messages": _build_messages(prompt, system_prompt),
        "temperature": 0.2,
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {settings.AI_LMSTUDIO_API_KEY}",
    }

    response = requests.post(
        f"{base_url}/chat/completions",
        json=payload,
        headers=headers,
        timeout=settings.AI_REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()

    data = response.json()
    choices = data.get("choices") or []
    first = choices[0] if choices else {}
    message = first.get("message") if isinstance(first, dict) else {}
    content = (message or {}).get("content")

    if not content:
        raise LocalAIServiceError("LM Studio returned an empty response.")

    return str(content)


def generate_local_ai_response(
    prompt: str,
    system_prompt: str | None = None,
    provider: str | None = None,
    model: str | None = None,
) -> dict[str, str]:
    resolved_provider = _normalize_provider(provider)
    resolved_model = (model or settings.AI_MODEL or "").strip()

    if not resolved_model:
        raise LocalAIServiceError("No AI model configured.")

    try:
        if resolved_provider == "ollama":
            content = _ollama_chat(resolved_model, prompt, system_prompt)
        else:
            content = _lmstudio_chat(resolved_model, prompt, system_prompt)
    except requests.RequestException as exc:
        raise LocalAIServiceError(f"Request to local AI provider failed: {exc}") from exc

    return {
        "provider": resolved_provider,
        "model": resolved_model,
        "response": content,
    }
