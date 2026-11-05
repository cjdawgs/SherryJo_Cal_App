from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_privacy_and_terms_are_public_and_linked():
    about = client.get("/about")
    assert about.status_code == 200
    assert "SherryJo Cal App" in about.text and "calendar" in about.text.lower()
    assert 'href="/privacy"' in about.text and 'href="/terms"' in about.text
    privacy = client.get("/privacy")
    terms = client.get("/terms")
    assert privacy.status_code == 200 and "Privacy Policy" in privacy.text
    assert "Google API Services User Data Policy" in privacy.text
    assert terms.status_code == 200 and "Terms of Service" in terms.text
    assert 'href="/terms"' in privacy.text and 'href="/privacy"' in terms.text
