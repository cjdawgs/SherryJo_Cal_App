from sqlalchemy.orm import Session

from app.models import MasterAdminCode
from app.security import hash_password, verify_password


MASTER_ADMIN_CODE_KEY = "master_admin_code"
MIN_MASTER_ADMIN_CODE_LENGTH = 16
MAX_MASTER_ADMIN_CODE_LENGTH = 256


def master_admin_code_status(db: Session) -> dict[str, bool | str | None]:
    record = db.get(MasterAdminCode, MASTER_ADMIN_CODE_KEY)
    return {
        "configured": record is not None,
        "updated_at": record.updated_at.isoformat() if record and record.updated_at else None,
    }


def verify_master_admin_code(db: Session, candidate: str) -> bool | None:
    record = db.get(MasterAdminCode, MASTER_ADMIN_CODE_KEY)
    if record is None:
        return None
    return verify_password(candidate, record.secret_hash)


def set_master_admin_code(db: Session, code: str) -> None:
    if not MIN_MASTER_ADMIN_CODE_LENGTH <= len(code) <= MAX_MASTER_ADMIN_CODE_LENGTH:
        raise ValueError(
            f"Master Admin Code must be between {MIN_MASTER_ADMIN_CODE_LENGTH} and "
            f"{MAX_MASTER_ADMIN_CODE_LENGTH} characters."
        )

    record = db.get(MasterAdminCode, MASTER_ADMIN_CODE_KEY)
    if record is None:
        record = MasterAdminCode(key_name=MASTER_ADMIN_CODE_KEY, secret_hash=hash_password(code))
        db.add(record)
    else:
        record.secret_hash = hash_password(code)
    db.commit()
