from pathlib import Path
import re


def _read(path: str) -> str:
    return Path(path).read_text(encoding="utf-8")


def test_tv_core_routes_contract(client):
    # Route presence and auth expectations that must remain stable for TV pairing.
    assert client.get("/tv/dashboard").status_code == 200
    assert client.get("/tv/kiosk").status_code == 422
    assert client.post("/tv/pair", json={}).status_code in {400, 422}
    assert client.post("/tv/auto-pair").status_code in {401, 404}
    assert client.get("/tv/state").status_code == 401
    assert client.get("/tv/events").status_code == 401


def test_tv_templates_reference_canonical_dashboard_bundle_only():
    tv_html = _read("app/templates/tv.html")
    tv_kiosk_html = _read("app/templates/tv_kiosk.html")

    expected_tag = 'src="/static/tv_dashboard.js?v={{ app_version }}"'
    assert expected_tag in tv_html
    assert expected_tag in tv_kiosk_html

    for template in (tv_html, tv_kiosk_html):
        refs = re.findall(r'/static/(tv_dashboard[^"\']*\.js)', template)
        assert refs
        assert set(refs) == {"tv_dashboard.js"}


def test_tv_static_bundle_has_single_canonical_filenames():
    static_dir = Path("app/static")
    dashboard_candidates = sorted(path.name for path in static_dir.glob("tv_dashboard*.js"))
    mode_candidates = sorted(path.name for path in static_dir.glob("tv_mode*.js"))

    assert dashboard_candidates == ["tv_dashboard.js"]
    assert mode_candidates == ["tv_mode.js"]
