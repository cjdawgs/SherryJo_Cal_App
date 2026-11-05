from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_privacy_and_terms_are_public_and_linked():
    privacy = client.get("/privacy")
    terms = client.get("/terms")
    assert privacy.status_code == 200 and "Privacy Policy" in privacy.text
    assert "Google API Services User Data Policy" in privacy.text
    assert terms.status_code == 200 and "Terms of Service" in terms.text
    assert 'href="/terms"' in privacy.text and 'href="/privacy"' in terms.text
