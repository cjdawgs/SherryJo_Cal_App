"""encrypt_oauth_credentials

Revision ID: h961b22eee55
Revises: h960a11ddd44
Create Date: 2026-07-25 00:00:00.000000

Seals the credentials already stored in ``oauth_accounts`` (Google/Microsoft
access + refresh tokens, and the iCloud app password Apple accounts keep in
``refresh_token``).

No schema change: the columns keep their names and types. Rows are rewritten
in the ``v1:<ciphertext>`` format understood by ``app.utils.crypto``.

Requires ``TOKEN_ENCRYPTION_KEY``. Without it the migration is a no-op and
prints a warning rather than failing, so a key-less environment can still run
``alembic upgrade head``; the application reads unsealed legacy values
transparently and seals them on the next write.
"""
from alembic import op
import sqlalchemy as sa

from app.utils.crypto import VERSION_PREFIX, encryption_enabled, seal


# revision identifiers, used by Alembic.
revision = "h961b22eee55"
down_revision = "h960a11ddd44"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()

    if "oauth_accounts" not in sa.inspect(bind).get_table_names():
        return

    if not encryption_enabled():
        print(
            "⚠️  [MIGRATION] TOKEN_ENCRYPTION_KEY is not set — existing OAuth "
            "credentials were left in clear text. Set the key and re-run "
            "`alembic upgrade head` to seal them."
        )
        return

    rows = bind.execute(
        sa.text("SELECT id, access_token, refresh_token FROM oauth_accounts")
    ).fetchall()

    updated = 0
    for row_id, access_token, refresh_token in rows:
        sealed_access = seal(access_token)
        sealed_refresh = seal(refresh_token)

        if sealed_access == access_token and sealed_refresh == refresh_token:
            continue

        bind.execute(
            sa.text(
                "UPDATE oauth_accounts "
                "SET access_token = :access_token, refresh_token = :refresh_token "
                "WHERE id = :id"
            ),
            {"access_token": sealed_access, "refresh_token": sealed_refresh, "id": row_id},
        )
        updated += 1

    print(f"🔐 [MIGRATION] Sealed credentials for {updated} oauth_accounts row(s).")


def downgrade() -> None:
    # Deliberately not reversible: writing decrypted credentials back to the
    # database would undo the control this migration exists to provide.
    # Unseal manually with app.utils.crypto.unseal if a rollback is truly needed.
    print(
        "ℹ️  [MIGRATION] Credential encryption is not automatically reversible. "
        f"Sealed values keep the '{VERSION_PREFIX}' prefix."
    )
