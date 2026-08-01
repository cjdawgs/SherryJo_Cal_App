from app.main import build_allowed_origins


def test_configured_cloudflare_origin_is_allowed_without_path_or_duplicates():
    origins = build_allowed_origins("https://calendar.example.com/app/")

    assert "https://calendar.example.com" in origins
    assert "https://sherryjo-cal-app.onrender.com" in origins
    assert "https://calendar.example.com/app" not in origins
    assert len(origins) == len(set(origins))