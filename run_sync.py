from app.services.calendar_service import CalendarService
from app.database import get_db
from app.models import User


def main():
    service = CalendarService()

    db = next(get_db())
    user = db.query(User).first()  # ✅ FIRST create user

    # ✅ THEN print values
    print("REFRESH TOKEN:", user.google_refresh_token)
    print("ACCESS TOKEN:", user.google_access_token)
    print("EXPIRES:", user.google_token_expires)

    result = service.sync_all(db, user)

    print(result)


if __name__ == "__main__":
    main()