# alembic/env.py

from logging.config import fileConfig
from sqlalchemy import engine_from_config
from sqlalchemy import pool

from alembic import context

# ✅ Import your app config
from app.config import DATABASE_URL

# ✅ Import Base + MODELS (IMPORTANT!)
from app.database import Base
from app.models import User, Event, Task , Note  # ✅ ensures tables are registered

# --------------------------------------------------
# Alembic Config
# --------------------------------------------------

config = context.config

# ✅ Dynamically set DB URL (overrides alembic.ini)
config.set_main_option("sqlalchemy.url", DATABASE_URL)

# Logging config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)


# ✅ This is what Alembic uses to detect changes
target_metadata = Base.metadata


# --------------------------------------------------
# OFFLINE MODE
# (used rarely)
# --------------------------------------------------

def run_migrations_offline() -> None:
    """Run migrations without DB connection."""
    url = config.get_main_option("sqlalchemy.url")

    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        compare_type=True,   # ✅ detect column type changes
    )

    with context.begin_transaction():
        context.run_migrations()


# --------------------------------------------------
# ONLINE MODE (NORMAL MODE)
# --------------------------------------------------

def run_migrations_online() -> None:
    """Run migrations with DB connection."""

    connectable = engine_from_config(
        config.get_section(config.config_ini_section),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            compare_type=True,        # ✅ detect column changes
            compare_server_default=True,
        )

        with context.begin_transaction():
            context.run_migrations()


# --------------------------------------------------
# Entrypoint
# --------------------------------------------------

if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()