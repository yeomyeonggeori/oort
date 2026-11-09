---
title: 웹훅
description: 바깥 서비스가 채널에 글을 넣는 들어오는 웹훅과, 워크스페이스에서 일어난 일을 바깥 주소로 보내는 이벤트 구독을 정리했어요.
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

웹훅은 방향이 둘이에요. 들어오는 웹훅은 바깥 서비스가 채널에 글을 넣는 주소이고, 이벤트 구독은 워크스페이스에서 일어난 일을 바깥 주소로 보내요. 둘 다 AI › 외부 연결에서 워크스페이스 소유자나 관리자가 만들어요.

## 들어오는 웹훅

세 가지 방식으로 받아요. 들어온 글은 사람이 보낸 메시지와 같은 길로 채널에 저장돼요.

| 방식 | 주소 | 확인하는 것 |
|---|---|---|
| oort 서명 | `POST /v1/webhooks/<워크스페이스 id>/<설치 id>` | HMAC-SHA256 서명, 보낸 시각, 전달 id |
| Slack 호환 | `POST /hooks/<토큰>` | 주소 안의 비밀 토큰 |
| GitHub | `POST /v1/integrations/github/webhook` | `X-Hub-Signature-256` 서명 |

### oort 서명

요청에 헤더 다섯 개를 붙여요.

| 헤더 | 값 |
|---|---|
| `X-Momo-Signature-Version` | `v1` |
| `X-Momo-Key-Id` | 웹훅을 만들 때 받은 키 id |
| `X-Momo-Timestamp` | 보내는 시각(유닉스 초). 서버 시각과 5분 넘게 다르면 거절해요 |
| `X-Momo-Delivery-Id` | 전달마다 새 값. 같은 값으로 다시 보내면 처음 결과를 돌려줘요 |
| `X-Momo-Signature` | `v1=` 뒤에 서명(16진수) |

서명은 웹훅을 만들 때 받은 비밀 값으로, 아래 일곱 줄을 줄바꿈으로 이은 글자의 HMAC-SHA256을 구한 값이에요.

```text
v1
POST
/v1/webhooks/<워크스페이스 id>/<설치 id>
<설치 id>
<X-Momo-Timestamp 값>
<X-Momo-Delivery-Id 값>
<본문의 SHA-256, 16진수>
```

본문은 JSON이고 `text`가 꼭 있어야 해요. `event_type`과 `metadata`(문자열 값 32개까지)는 넣어도 되고, 그 밖의 필드는 거절해요. 본문은 256KiB까지, 글은 40,000자까지예요.

```json
{
  "text": "배포가 끝났어요",
  "event_type": "deploy.finished",
  "metadata": {"env": "prod"}
}
```

### Slack 호환

Slack의 들어오는 웹훅을 쓰던 도구를 주소만 바꿔 붙일 수 있어요. `text`와 예전 방식의 `attachments`(20개까지)를 받고, `blocks`는 아직 받지 않아요. 같은 본문이 같은 5분 구간 안에 다시 오면 한 번만 넣어요. 토큰은 서버에 해시로만 저장돼요.

### GitHub

서버 운영자가 GitHub 앱을 등록해 두면, 워크스페이스 소유자나 관리자가 저장소를 채널에 이어요. 기본으로 PR과 이슈 소식이 오고, 리뷰, 댓글, 검사, 커밋, 릴리스는 골라서 켜요. 글은 워크스페이스의 「GitHub」 멤버 이름으로 올라와서, 사람이 쓴 것처럼 보이지 않아요.

## 이벤트 구독

워크스페이스에서 일어난 일을 바깥 HTTPS 주소로 보내요. 구독은 워크스페이스 전체에 걸려요. 채널 하나만 골라 보낼 수는 없어요.

| 이벤트 | 보내는 때 |
|---|---|
| `mention` | 멘션이 생겼을 때 |
| `approval_request` | 승인 요청이 올라왔을 때 |
| `work.status_changed` | 작업 상태가 바뀌었을 때 |

보낼 때 붙는 헤더예요.

| 헤더 | 값 |
|---|---|
| `X-Momo-Event` | 이벤트 이름 |
| `X-Momo-Delivery` | 전달 id |
| `X-Momo-Timestamp` | 보낸 시각(유닉스 초) |
| `X-Momo-Signature` | `v1=` 뒤에 HMAC-SHA256 서명(16진수) |

받는 쪽은 구독을 만들 때 받은 비밀 값으로 `<X-Momo-Timestamp 값>.<본문>`의 HMAC-SHA256을 구해 서명과 맞춰 봐요. 시각이 서명 안에 들어 있어서, 시각만 바꿔 다시 보내면 서명이 맞지 않아요.

```python
import hashlib
import hmac


def verify(secret: str, timestamp: str, body: bytes, header: str) -> bool:
    signed = timestamp.encode() + b"." + body
    mac = hmac.new(secret.encode(), signed, hashlib.sha256)
    return hmac.compare_digest("v1=" + mac.hexdigest(), header)
```

- 받는 주소는 HTTPS여야 하고, 사설 주소나 루프백으로는 보내지 않아요. 이 검사는 저장할 때와 보낼 때 두 번 해요.
- 2xx로 답하면 끝나요. 5xx, 408, 429, 연결 실패는 간격을 늘려 가며 다시 보내요(기본 8번까지). 그 밖의 4xx와 리디렉션은 다시 보내지 않아요.
- 5xx가 이어지면 구독이 저절로 꺼질 수 있어요.
