import uuid

from app.models import SyncOperationLedger
from app.services.sync_operation_ledger import begin_sync_operation, complete_sync_operation, is_operation_dead_letter


class _FakeQuery:
    def __init__(self, rows):
        self._rows = rows
        self._filters = []

    def filter(self, expr):
        self._filters.append((expr.left.name, expr.right.value))
        return self

    def first(self):
        for row in self._rows:
            matched = True
            for field, value in self._filters:
                if getattr(row, field) != value:
                    matched = False
                    break
            if matched:
                return row
        return None


class FakeSession:
    def __init__(self):
        self.rows = []
        self.commits = 0
        self.rollbacks = 0

    def query(self, _model):
        return _FakeQuery(self.rows)

    def add(self, row):
        if row.id is None:
            row.id = str(uuid.uuid4())
        self.rows.append(row)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


def test_begin_sync_operation_creates_running_row():
    db = FakeSession()

    operation_id = begin_sync_operation(
        db,
        operation_key="scheduler-sync:user:7:slot:123",
        owner_user_id=7,
        request_payload={"cadence_minutes": 5},
    )

    assert operation_id
    assert db.commits == 1
    assert len(db.rows) == 1
    row = db.rows[0]
    assert row.operation_key == "scheduler-sync:user:7:slot:123"
    assert row.status == "running"
    assert row.attempt_count == 1
    assert row.request_payload == {"cadence_minutes": 5}


def test_begin_sync_operation_resumes_existing_row_and_increments_attempt_count():
    db = FakeSession()
    first_id = begin_sync_operation(
        db,
        operation_key="scheduler-sync:user:9:slot:456",
        owner_user_id=9,
        request_payload={"cadence_minutes": 15},
    )

    second_id = begin_sync_operation(
        db,
        operation_key="scheduler-sync:user:9:slot:456",
        owner_user_id=9,
        request_payload={"cadence_minutes": 15},
    )

    assert first_id == second_id
    assert len(db.rows) == 1
    assert db.rows[0].attempt_count == 2


def test_complete_sync_operation_marks_success_payload():
    db = FakeSession()
    operation_id = begin_sync_operation(
        db,
        operation_key="scheduler-sync:user:10:slot:789",
        owner_user_id=10,
    )

    complete_sync_operation(
        db,
        operation_id=operation_id,
        status="succeeded",
        result_payload={"had_changes": True},
    )

    row = db.rows[0]
    assert row.status == "succeeded"
    assert row.result_payload == {"had_changes": True}
    assert row.error_type is None
    assert row.error_message is None


def test_complete_sync_operation_marks_failure_payload():
    db = FakeSession()
    operation_id = begin_sync_operation(
        db,
        operation_key="scheduler-sync:user:11:slot:999",
        owner_user_id=11,
    )

    complete_sync_operation(
        db,
        operation_id=operation_id,
        status="failed",
        error=ValueError("sync exploded"),
    )

    row = db.rows[0]
    assert row.status == "retry_pending"
    assert row.error_type == "ValueError"
    assert row.error_message == "sync exploded"


def test_complete_sync_operation_marks_dead_letter_at_max_attempts():
    db = FakeSession()
    operation_key = "scheduler-sync:user:12:anchor:bootstrap"

    begin_sync_operation(db, operation_key=operation_key, owner_user_id=12)
    begin_sync_operation(db, operation_key=operation_key, owner_user_id=12)
    operation_id = begin_sync_operation(db, operation_key=operation_key, owner_user_id=12)

    complete_sync_operation(
        db,
        operation_id=operation_id,
        status="failed",
        error=RuntimeError("provider timeout"),
        max_attempts=3,
    )

    row = db.rows[0]
    assert row.attempt_count == 3
    assert row.status == "dead_letter"
    assert row.error_type == "RuntimeError"
    assert row.error_message == "provider timeout"


def test_begin_sync_operation_fails_open_on_session_error():
    class BrokenSession:
        def query(self, _model):
            raise RuntimeError("db unavailable")

        def commit(self):
            return None

        def rollback(self):
            return None

    operation_id = begin_sync_operation(
        BrokenSession(),
        operation_key="scheduler-sync:user:1:slot:1",
        owner_user_id=1,
    )

    assert operation_id is None


def test_retry_resumption_transitions_to_dead_letter_after_repeated_failures():
    db = FakeSession()
    operation_key = "scheduler-sync:user:20:anchor:bootstrap"

    op1 = begin_sync_operation(db, operation_key=operation_key, owner_user_id=20)
    complete_sync_operation(db, operation_id=op1, status="failed", error=RuntimeError("timeout"), max_attempts=3)
    assert db.rows[0].status == "retry_pending"
    assert db.rows[0].attempt_count == 1

    op2 = begin_sync_operation(db, operation_key=operation_key, owner_user_id=20)
    assert op2 == op1
    complete_sync_operation(db, operation_id=op2, status="failed", error=RuntimeError("timeout"), max_attempts=3)
    assert db.rows[0].status == "retry_pending"
    assert db.rows[0].attempt_count == 2

    op3 = begin_sync_operation(db, operation_key=operation_key, owner_user_id=20)
    assert op3 == op1
    complete_sync_operation(db, operation_id=op3, status="failed", error=RuntimeError("timeout"), max_attempts=3)
    assert db.rows[0].status == "dead_letter"
    assert db.rows[0].attempt_count == 3


def test_duplicate_delivery_reuses_same_ledger_row():
    db = FakeSession()
    operation_key = "scheduler-rollup:date:2026-08-05"

    first = begin_sync_operation(db, operation_key=operation_key, owner_user_id=None)
    second = begin_sync_operation(db, operation_key=operation_key, owner_user_id=None)

    assert first == second
    assert len(db.rows) == 1
    assert db.rows[0].attempt_count == 2


def test_is_operation_dead_letter_returns_true_only_for_dead_letter_rows():
    db = FakeSession()
    operation_key = "scheduler-sync:user:30:anchor:bootstrap"
    operation_id = begin_sync_operation(db, operation_key=operation_key, owner_user_id=30)

    assert is_operation_dead_letter(db, operation_key=operation_key) is False

    complete_sync_operation(
        db,
        operation_id=operation_id,
        status="failed",
        error=RuntimeError("boom"),
        max_attempts=1,
    )

    assert is_operation_dead_letter(db, operation_key=operation_key) is True
