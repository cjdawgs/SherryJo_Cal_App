def test_tag_color_settings_round_trip(client, auth_headers):
    payload = {
        "settings": {
            "family": {
                "label": "Family",
                "color": "#ff3344",
                "enabled": True,
            }
        }
    }

    put_res = client.put("/calendar/tag-colors", json=payload, headers=auth_headers)
    assert put_res.status_code == 200
    assert put_res.json()["settings"]["family"] == payload["settings"]["family"]

    get_res = client.get("/calendar/tag-colors", headers=auth_headers)
    assert get_res.status_code == 200
    assert get_res.json()["settings"]["family"] == payload["settings"]["family"]


def test_calendar_event_color_enabled_persists(client, auth_headers):
    payload = {
        "title": "Color Override Event",
        "description": "Uses explicit event color",
        "start_time": "2026-07-19T12:00:00Z",
        "end_time": "2026-07-19T13:00:00Z",
        "color": "#ff3344",
        "color_enabled": True,
        "tags": ["Family"],
    }

    post_res = client.post("/calendar/event", json=payload, headers=auth_headers)
    assert post_res.status_code == 200

    event = post_res.json()["event"]
    assert event["color"] == "#ff3344"
    assert event["color_enabled"] is True
    assert event["extendedProps"]["eventColor"] == "#ff3344"
    assert event["extendedProps"]["eventColorEnabled"] is True