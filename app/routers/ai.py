from pydantic import BaseModel, Field
from fastapi import APIRouter, Depends, HTTPException

from app.deps import get_current_user
from app.models import User
from app.services.local_ai_service import (
    LocalAIServiceError,
    generate_local_ai_response,
    get_local_ai_config,
)


router = APIRouter(prefix="/ai", tags=["ai"])


class LocalChatRequest(BaseModel):
    prompt: str = Field(..., min_length=1)
    system_prompt: str | None = None
    provider: str | None = None
    model: str | None = None


@router.get("/local/config")
def local_ai_config(current_user: User = Depends(get_current_user)):
    return get_local_ai_config()


@router.post("/local/chat")
def local_ai_chat(
    payload: LocalChatRequest,
    current_user: User = Depends(get_current_user),
):
    try:
        return generate_local_ai_response(
            prompt=payload.prompt,
            system_prompt=payload.system_prompt,
            provider=payload.provider,
            model=payload.model,
        )
    except LocalAIServiceError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
