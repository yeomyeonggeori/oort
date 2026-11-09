---
title: Webhooks
description: Incoming webhooks that let other services post into a channel, and event subscriptions that send what happens in a workspace out to an address.
status: done
checked: 2026-11-09
sources:
- server-rust/crates/momo-webhook/src/lib.rs
- server-rust/bins/momo-server/src/routes/webhook_ingress.rs
- server-rust/crates/momo-webhook/src/crypto.rs
- server-rust/crates/momo-webhook/src/payload.rs
- server-rust/crates/momo-webhook/src/ingress.rs
- server-rust/bins/momo-server/src/routes/github_ingress.rs
- server-rust/crates/momo-webhook/src/github.rs
- server-rust/crates/momo-webhook/src/subscriptions.rs
- server-rust/crates/momo-webhook/src/outbound.rs
- server-rust/bins/momo-webhook-sender/src/delivery.rs
- server-rust/bins/momo-webhook-sender/src/lib.rs
- server-rust/bins/momo-webhook-sender/src/config.rs
- server-rust/crates/momo-outbox/src/relay.rs
- clients/web/src/features/settings/WebhookSection.tsx
- clients/web/src/features/settings/EventSubscriptionSection.tsx
---

Webhooks go both ways. An incoming webhook is an address other services use to post into a channel; an event subscription sends what happens in the workspace out to an address of yours. A workspace owner or admin creates both under AI › 외부 연결 (external connections).

## Incoming webhooks

Three kinds are accepted. Whatever comes in is stored in the channel the same way as a message from a person.

| Kind | Address | What is checked |
|---|---|---|
| oort-signed | `POST /v1/webhooks/<workspace id>/<installation id>` | HMAC-SHA256 signature, send time, delivery id |
| Slack-compatible | `POST /hooks/<token>` | The secret token in the address |
| GitHub | `POST /v1/integrations/github/webhook` | `X-Hub-Signature-256` signature |

### oort-signed

Send five headers with each request.

| Header | Value |
|---|---|
| `X-Momo-Signature-Version` | `v1` |
| `X-Momo-Key-Id` | The key id you got when the webhook was created |
| `X-Momo-Timestamp` | The send time in Unix seconds. More than 5 minutes off the server clock is rejected |
| `X-Momo-Delivery-Id` | A new value for each delivery. Resending the same value returns the first result |
| `X-Momo-Signature` | `v1=` followed by the signature in hex |

The signature is the HMAC-SHA256, keyed with the secret you got when the webhook was created, of these seven lines joined with newlines.

```text
v1
POST
/v1/webhooks/<workspace id>/<installation id>
<installation id>
<X-Momo-Timestamp value>
<X-Momo-Delivery-Id value>
<SHA-256 of the body, in hex>
```

The body is JSON and must include `text`. `event_type` and `metadata` (up to 32 string values) are optional, and any other field is rejected. Bodies can be up to 256 KiB, and text up to 40,000 characters.

```json
{
  "text": "The deploy is done",
  "event_type": "deploy.finished",
  "metadata": {"env": "prod"}
}
```

### Slack-compatible

Tools that already post to Slack incoming webhooks can switch over by changing the address. `text` and legacy `attachments` (up to 20) are accepted; `blocks` are not yet. The same body arriving again within the same 5-minute window is posted only once. The server stores the token only as a hash.

### GitHub

Once the server operator has registered a GitHub App, a workspace owner or admin links repositories to channels. Pull request and issue updates come by default; reviews, comments, checks, commits and releases are opt-in. Posts appear under the workspace's "GitHub" member, so they never look like a person wrote them.

## Event subscriptions

Send what happens in the workspace to an HTTPS address of yours. A subscription covers the whole workspace; you cannot pick a single channel.

| Event | Sent when |
|---|---|
| `mention` | Someone is mentioned |
| `approval_request` | An approval request is raised |
| `work.status_changed` | A run changes state |

These headers come with each delivery.

| Header | Value |
|---|---|
| `X-Momo-Event` | The event name |
| `X-Momo-Delivery` | The delivery id |
| `X-Momo-Timestamp` | The send time in Unix seconds |
| `X-Momo-Signature` | `v1=` followed by the HMAC-SHA256 signature in hex |

To verify, compute the HMAC-SHA256 of `<X-Momo-Timestamp value>.<body>` with the secret you got when the subscription was created, and compare it with the signature. The time is part of what is signed, so a replay with a changed time will not match.

```python
import hashlib
import hmac


def verify(secret: str, timestamp: str, body: bytes, header: str) -> bool:
    signed = timestamp.encode() + b"." + body
    mac = hmac.new(secret.encode(), signed, hashlib.sha256)
    return hmac.compare_digest("v1=" + mac.hexdigest(), header)
```

- The address must be HTTPS, and nothing is sent to private or loopback addresses. This is checked twice: when the address is saved and again when sending.
- A 2xx answer ends it. A 5xx, 408, 429 or connection failure is retried with growing gaps (8 attempts by default). Other 4xx answers and redirects are not retried.
- Repeated 5xx answers can switch the subscription off on its own.
