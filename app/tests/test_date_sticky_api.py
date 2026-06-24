def test_date_sticky_upsert_list_and_delete(client, auth_headers):
    date_key = "2026-06-03"
    payload = {
        "sticky_notes": [
            {"content": "First date note", "color": "#F7E68A"},
            {"content": "Second date note", "color": "#F4DB6A"},
        ]
    }

    put_res = client.put(f"/calendar/date-sticky/{date_key}", json=payload, headers=auth_headers)
    assert put_res.status_code == 200
    put_data = put_res.json()
    assert put_data["item"]["date"] == date_key
    assert put_data["item"]["count"] == 2

    get_one = client.get(f"/calendar/date-sticky/{date_key}", headers=auth_headers)
    assert get_one.status_code == 200
    one_data = get_one.json()
    assert one_data["item"]["count"] == 2
    assert len(one_data["item"]["sticky_notes"]) == 2

    get_all = client.get("/calendar/date-sticky", headers=auth_headers)
    assert get_all.status_code == 200
    all_data = get_all.json()
    assert isinstance(all_data["items"], list)
    assert any(item["date"] == date_key and item["count"] == 2 for item in all_data["items"])

    delete_res = client.delete(f"/calendar/date-sticky/{date_key}", headers=auth_headers)
    assert delete_res.status_code == 200

    get_after = client.get(f"/calendar/date-sticky/{date_key}", headers=auth_headers)
    assert get_after.status_code == 200
    after_data = get_after.json()
    assert after_data["item"]["count"] == 0
    assert after_data["item"]["sticky_notes"] == []


def test_date_sticky_is_user_scoped(client):
    user_a = {
        "username": "date_scope_a",
        "email": "date_scope_a@test.com",
        "password": "pass123",
    }
    user_b = {
        "username": "date_scope_b",
        "email": "date_scope_b@test.com",
        "password": "pass123",
    }

    client.post("/auth/register", json=user_a)
    client.post("/auth/register", json=user_b)

    login_a = client.post("/auth/login", json={"email": user_a["email"], "password": user_a["password"]}).json()
    login_b = client.post("/auth/login", json={"email": user_b["email"], "password": user_b["password"]}).json()

    headers_a = {"Authorization": f"Bearer {login_a['access_token']}"}
    headers_b = {"Authorization": f"Bearer {login_b['access_token']}"}

    date_key = "2026-06-04"
    client.put(
        f"/calendar/date-sticky/{date_key}",
        json={"sticky_notes": [{"content": "A only", "color": "#F7E68A"}]},
        headers=headers_a,
    )

    a_view = client.get(f"/calendar/date-sticky/{date_key}", headers=headers_a).json()
    b_view = client.get(f"/calendar/date-sticky/{date_key}", headers=headers_b).json()

    assert a_view["item"]["count"] == 1
    assert b_view["item"]["count"] == 0