from app.services.multi_account_oauth_service import MultiAccountOAuthService


class _FakeQueryChain:
    def __init__(self, items):
        self._items = items

    def filter(self, *args, **kwargs):
        return self

    def all(self):
        return self._items


class _FlakyReadDb:
    def __init__(self, items):
        self._items = items
        self.query_calls = 0
        self.rollback_calls = 0

    def query(self, _model):
        self.query_calls += 1
        if self.query_calls == 1:
            raise RuntimeError("current transaction is aborted")
        return _FakeQueryChain(self._items)

    def rollback(self):
        self.rollback_calls += 1


def test_get_all_sync_enabled_accounts_rolls_back_and_retries_once():
    db = _FlakyReadDb(items=[{"id": 1}, {"id": 2}])

    result = MultiAccountOAuthService.get_all_sync_enabled_accounts(db, user_id=1)

    assert isinstance(result, list)
    assert len(result) == 2
    assert db.rollback_calls == 1
    assert db.query_calls == 2


def test_get_user_accounts_rolls_back_and_retries_once():
    db = _FlakyReadDb(items=[{"id": 7}])

    result = MultiAccountOAuthService.get_user_accounts(db, user_id=1)

    assert isinstance(result, list)
    assert len(result) == 1
    assert db.rollback_calls == 1
    assert db.query_calls == 2
