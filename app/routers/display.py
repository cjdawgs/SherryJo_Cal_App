from fastapi import APIRouter

router = APIRouter(prefix="/display", tags=["display"])


@router.get("/office")
def office():
    return {"view": "today tasks + team schedule"}


@router.get("/team/{user_id}")
def team(user_id: int):
    return {"view": f"user {user_id} tasks"}


@router.get("/manager")
def manager():
    return {"view": "full overview dashboard"}
