from sqlalchemy import inspect
from app.database import engine


def test_tables_exist():
    inspector = inspect(engine)
    tables = inspector.get_table_names()

    assert "users" in tables
    assert "events" in tables
    assert "tasks" in tables
