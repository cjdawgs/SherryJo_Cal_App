import json

from deployment import shadow_parity


def _result(status, body=b"{}"):
    return shadow_parity.HttpResult(
        status=status,
        content_type="application/json",
        location=None,
        set_cookie=(),
        edge_marker=None,
        body=body,
    )


def test_http_cases_include_public_schema_health_without_body_comparison():
    cases = {case.name: case for case in shadow_parity._cases("https://edge.example.com")}

    assert cases["schema_health"].path == "/health/schema"
    assert cases["schema_health"].compare_body is False


def test_worker_edge_health_proves_route_ownership(monkeypatch):
    responses = iter(
        (
            _result(404),
            _result(
                200,
                json.dumps(
                    {
                        "status": "ok",
                        "platform": "cloudflare",
                        "mode": "render-origin-proxy",
                    }
                ).encode("utf-8"),
            ),
        )
    )
    monkeypatch.setattr(shadow_parity, "_request", lambda *_args, **_kwargs: next(responses))

    row, failures = shadow_parity.run_worker_edge_health(
        "https://render.example.com",
        "https://edge.example.com",
    )

    assert row["passed"] is True
    assert row["render_status"] == 404
    assert row["cloudflare_status"] == 200
    assert failures == []


def test_worker_edge_health_reports_wrong_worker_contract(monkeypatch):
    responses = iter((_result(404), _result(200, b'{"status":"ok"}')))
    monkeypatch.setattr(shadow_parity, "_request", lambda *_args, **_kwargs: next(responses))

    row, failures = shadow_parity.run_worker_edge_health(
        "https://render.example.com",
        "https://edge.example.com",
    )

    assert row["passed"] is False
    assert row["failed_checks"] == ["cloudflare_body"]
    assert failures == ["worker_edge_health: cloudflare_body"]


def test_native_worker_accepts_migrated_authentication_contracts():
    cases = {case.name: case for case in shadow_parity._cases("https://edge.example.com")}
    origins = ("https://render.example.com", "https://edge.example.com")
    expected_responses = {
        "invalid_login": shadow_parity.HttpResult(401, "application/json; charset=utf-8", None, (), "cloudflare", b'{"detail":"Invalid email, username, or password"}'),
        "google_callback_invalid_state": shadow_parity.HttpResult(302, None, "https://edge.example.com/accounts/ui?error=google_invalid_state", (), None, b""),
        "microsoft_callback_invalid_state": shadow_parity.HttpResult(302, None, "https://edge.example.com/accounts/ui?error=microsoft_invalid_state", (), None, b""),
        "protected_api": shadow_parity.HttpResult(401, "application/json; charset=utf-8", None, (), "cloudflare", b'{"error":"Authentication required"}'),
        "multipart_auth_rejection": shadow_parity.HttpResult(401, "application/json; charset=utf-8", None, (), "cloudflare", b'{"error":"Authentication required"}'),
    }

    for case_name, response in expected_responses.items():
        checks = shadow_parity._native_worker_checks(cases[case_name], response, origins)
        assert checks is not None
        assert all(checks.values())