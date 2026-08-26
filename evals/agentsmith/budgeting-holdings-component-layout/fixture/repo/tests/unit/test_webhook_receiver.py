import pytest
from fastapi.testclient import TestClient

from finance import webhook_receiver
from finance.security.webhook_verify import WebhookVerificationError


@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json"])
def test_receiver_does_not_expose_api_documentation(path):
    client = TestClient(webhook_receiver.app)
    assert client.get(path).status_code == 404


def test_receiver_rejects_unverified_request(monkeypatch):
    monkeypatch.setattr(
        "finance.webhook_receiver.verify_webhook",
        lambda client, body, header, environment: (_ for _ in ()).throw(
            WebhookVerificationError("invalid")
        ),
    )
    client = TestClient(webhook_receiver.app)
    resp = client.post(
        "/webhook",
        content=b'{"webhook_type":"TRANSACTIONS","environment":"production"}',
        headers={"Plaid-Verification": "junk"},
    )
    assert resp.status_code == 401


def test_receiver_forwards_verified_request(monkeypatch):
    sent = {}

    def fake_verify(client, body, header, environment):
        return {"iat": 1}

    monkeypatch.setattr("finance.webhook_receiver.verify_webhook", fake_verify)

    async def fake_forward(body, header):
        sent["url"] = webhook_receiver.INTERNAL_WEBHOOK_URL
        sent["data"] = body
        sent["header"] = header

    monkeypatch.setattr("finance.webhook_receiver._forward", fake_forward)

    client = TestClient(webhook_receiver.app)
    body = (
        b'{"webhook_type":"TRANSACTIONS","item_id":"item-1","environment":"production"}'
    )
    resp = client.post(
        "/webhook", content=body, headers={"Plaid-Verification": "signed-jwt"}
    )
    assert resp.status_code == 200
    assert sent["url"] == webhook_receiver.INTERNAL_WEBHOOK_URL
    assert sent["data"] == body
    assert sent["header"] == "signed-jwt"
