
# --------------------------------------------------
# IMPORTS
# --------------------------------------------------

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Task
from app.deps import get_current_user



# --------------------------------------------------
# ROUTER SETUP
# --------------------------------------------------

router = APIRouter(prefix="/tasks", tags=["tasks"])


# ==================================================
# GET TASKS (✅ FIXED 401 ISSUE)
# ==================================================

@router.get("/")
def get_tasks(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user)
):
    """
    ✅ FIX:
    - Only return tasks for logged-in user
    """

    return db.query(Task).filter(
        Task.owner_id == current_user.id
    ).all()


# ==================================================
# CREATE TASK (✅ FIXED SECURITY)
# ==================================================

@router.post("/")
def create_task(
    payload: dict,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user)
):
    """
    ✅ FIX:
    - owner comes from token (NOT frontend)
    """

    task = Task(
        title=payload["title"],
        description=payload.get("description"),
        completed=payload.get("completed", False),

        # ✅ CRITICAL FIX
        owner_id=current_user.id
    )

    db.add(task)
    db.commit()
    db.refresh(task)

    return task

