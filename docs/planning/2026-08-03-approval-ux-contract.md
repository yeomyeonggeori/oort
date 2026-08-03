# 승인 축 — 클라이언트 UX 계약 (goal SRV-T1, 서버 랜딩분)

> 이 문서는 **서버가 무엇을 주는지**의 계약이다. goal SRV-T1은 `clients/**`를 한 줄도 고치지 않았다(모바일 실기기 검수 중). 모바일·웹 배치가 이 문서를 받아 뷰만 얹으면 된다.
>
> 발단: `docs/planning/2026-08-03-roadmap-diagnosis.md` — ADR-0137 D5의 v0 축 **관전·승인·대화** 중 승인이 통째로 비어 있었다. 서버에 `approvals` 라우트 0개, `INSERT INTO approval` 0건. 이 배치가 **생산자(툴콜)와 소비자(승인 라우트)를 함께** 채웠다.

## 0. 한 줄 요약

에이전트가 도구를 쓰려 하면 → 채널에 **`tool_call` 메시지**가 뜨고 → 승인이 필요하면 **`approval_request` 메시지(카드)** 가 뜨며 run이 멈춘다 → 사람이 승인/거부하면 → **`tool_result` 메시지**로 끝난다. 셋 다 **평범한 메시지**다(같은 `seq`, 같은 relay).

## 1. 새 메시지 타입 3종 — 전부 기존 타임라인 위에 온다

셋 다 `message` 행이고 `message.seq`를 정상 소비한다. **기존 페이지네이션·정렬·읽음 처리에 아무 변경이 없다.** 모르는 타입으로 떨어져도 `body`가 항상 채워져 있으므로 빈 말풍선이 되지 않는다.

| `type` | `body` (fallback 렌더용) | `props` |
|---|---|---|
| `tool_call` | `"Tool call: work.session.end"` | `{name, arguments, call_id}` — `schema_v0.sql:168` 규약 그대로 |
| `approval_request` | `"Approval required: work.session.end"` | 아래 §2 |
| `tool_result` | 도구 출력 문장 | `{call_id, output, is_error}` + 아래 §4 |

`author_member_id`는 **항상 에이전트**다. 도구 호출은 에이전트의 발화이고, 그 결과도 같은 화자에게 귀속된다(거부·만료도 마찬가지). "누가 결정했나"는 authorship이 아니라 `props`에 있다.

## 2. 승인 카드 (`approval_request`) — `props`

```jsonc
{
  "approval_id": "uuid",        // 결정 API에 그대로 보낸다
  "run_id": "uuid",
  "channel_id": "uuid",
  "action_type": "tool_call",
  "call_id": "call_abc",
  "tool_name": "work.session.end",
  "title": "Approve work.session.end",
  "summary": "Review the proposed tool call before momo executes it.",
  "arguments": "{\"session_id\":\"…\"}",   // provider가 보낸 원문 문자열
  "status": "pending",
  "expires_at_ms": 1754200000000          // ← 카운트다운. §6이 중요하다
}
```

**결정된 뒤에는 서버가 이 메시지의 `props`를 patch한다**(`approval_status`·`status`·`decided_by`·`decided_at_ms`·`decision_reason` 추가). 단, **patch 자체는 브로드캐스트하지 않는다** — 아래 §5의 `approval.decided` 이벤트가 그 역할을 한다. 카드를 다시 그릴 트리거는 `approval.decided`다.

> `props`에 **정책 메타(`tool_grant`)는 넣지 않았다.** `props`는 채널 전원에게 방송되는 공개 표면이고 grant는 판정 근거이지 내용이 아니다.

## 3. 인박스 — `GET /v1/workspaces/{ws}/approvals`

```
GET /v1/workspaces/{ws}/approvals?status=pending&limit=100
```
- `status`: `pending`(기본) | `approved` | `rejected` | `expired` | `cancelled`. 그 외는 400.
- `limit`: 기본 100, `1..=500`로 clamp.
- 정렬: `expires_at NULLS LAST, created_at DESC` — **마감 임박 순**이다. 리스트를 그대로 그리면 된다.
- 권한: 활성 human 멤버여야 하고(아니면 403), 결과는 **자기가 속한 채널의 승인만** 나온다(쿼리 안의 `JOIN membership`).

응답:
```jsonc
{ "approvals": [ {
    "id", "workspaceId", "runId", "channelId", "requestMessageId",
    "requestedBy", "actionType", "payload", "status",
    "decidedBy", "decidedAtMs", "decisionReason", "expiresAtMs", "createdAtMs"
} ] }
```
> Swift 정본에 있던 `estimatedMicroUsd`·`isReversible`은 **이번 생산자가 쓰지 않으므로 필드를 생략**했다. 클라는 **없으면 "모름"으로 다뤄야 한다 — "되돌릴 수 있음"으로 읽으면 안 된다.**

## 4. 결정 — `POST .../approvals/{approval}/decision`

```jsonc
// body
{ "approval_id": "uuid", "approve": true, "reason": "ok",
  "client_decision_id": "uuid" }   // ← 필수
```

`client_decision_id`는 **클라가 생성하는 멱등 키**다. 네트워크가 흔들려 재전송해도 같은 키면 서버는 **첫 번째 영수증을 그대로 되돌려준다**. 폰에서 두 번 눌리는 건 예외가 아니라 정상이므로 반드시 채워라(같은 키로 **다른** 판단을 보내면 409 `idempotency_conflict`).

호환 경로도 있다: `POST /v1/agent-runs/{run}/approval-decisions` (body에 `approval_id`, workspace는 자격증명에서).

**응답은 성공/실패 모두 같은 모양**(영수증)이다. 하나의 디코더로 전부 받는다:
```jsonc
{ "approvalId", "status", "decidedBy", "decidedAtMs", "decisionReason" }
```

| HTTP | `status` | 화면 |
|---|---|---|
| 200 | `approved` / `rejected` | 카드 확정 |
| 200 | (첫 영수증 재생) | 같은 화면. 성공으로 처리 |
| 409 | `idempotency_conflict` | "이미 다른 결정으로 처리됨" |
| 409 | `approved`/`rejected`/`expired`/… | "이미 처리된 요청입니다" |
| 409 | `expired` | **"승인 시간이 지났습니다"** — 늦게 누른 경우 |
| 403 | `forbidden` | 채널 멤버가 아니거나 사람이 아님 |
| 404 | `not_found` | (다른 테넌트 포함) |

### 승인 후 / 거부 후 채널에 오는 것
- **승인**: run이 재개되고, 도구가 실행된 뒤 **`tool_result`** 가 뜬다. 이어서 에이전트의 **텍스트 답변**이 온다(도구 결과를 보고 말한다).
- **거부**: run이 `cancelled`로 종결되고, `tool_result`(`is_error: true`, `status: "rejected"`, `decided_by`)가 뜬다. 도구는 **실행되지 않는다.**

## 5. 실시간 이벤트 — `approval.decided`

채널 `ch:ws<WS>.<CH>` 로 온다.
```jsonc
{ "type": "approval.decided", "v": 1, "ts": 1754200000000,
  "payload": { "action": "decided", "approval_id", "run_id", "channel_id",
               "requested_by", "action_type", "status", "payload",
               "decided_by", "decided_at_ms", "decision_reason" } }
```
- `status` ∈ `approved | rejected | expired`
- **이게 카드 갱신 트리거다.** `version`이 없으므로 채널 seq와 경합하지 않는다.
- **`expired`는 아무도 누르지 않아도 온다**(§6).

## 6. ⚠️ 만료는 클라가 반드시 다뤄야 한다

승인은 **`expires_at_ms`를 항상 갖는다**(기본 1시간, `APPROVAL_TTL_SECONDS`). 마감이 지나면 **아무도 누르지 않아도** 서버 sweep이 승인을 `expired`로 종결하고 run을 `timed_out`으로 풀며 `approval.decided(expired)`를 쏜다.

왜 짧은가: `agent.max_concurrent_runs`의 **기본값이 1**이고 `awaiting_approval` run이 그 슬롯을 점유한다. 즉 **답 안 한 승인 하나가 그 에이전트를 영구히 침묵시킨다.** 만료는 그 게이트를 되돌려주는 장치다. (만료된 승인은 잃어버린 의도가 아니다 — 사람이 다시 물어보면 에이전트가 다시 제안한다.)

클라 요구사항:
1. 카드에 **남은 시간**을 보여라(`expires_at_ms`).
2. 만료되면 버튼을 **비활성화**하라. 누르면 409 `expired`가 온다.
3. 인박스는 마감 임박 순으로 이미 정렬되어 온다.

## 7. 푸시 — 이미 붙어 있다

`momo-push`의 판정은 `approval_request` 메시지를 이미 알고 있다(`judgment.rs`가 `approval` 테이블을 join해 `approval_id`를 실어 보낸다). 지금까지 그 행이 생길 수 없어 죽은 코드였을 뿐이다. **이 배치로 approval 행이 생기기 시작하므로 "알림에서 바로 승인"이 비로소 의미가 생긴다** — 푸시 payload의 `approval_id`를 §4 결정 API에 그대로 넣으면 된다.

## 8. 이번 배치가 실행하는 도구는 **하나**다

`work.session.end` — 작업 세션 종료. 그 외 에이전트가 선언한 도구를 호출하면 `tool_result`(`is_error: true`)로 *"이 서버는 그 도구를 실행할 수 없다"* 고 이름을 밝혀 답한다. 클라는 `tool_name`을 특별 취급하지 말고 일반적으로 렌더하면 된다(도구가 늘어나도 화면이 안 바뀌게).

## 9. 클라가 하지 말아야 할 것

- **`props`의 `status`만 보고 카드를 확정하지 마라.** patch는 브로드캐스트되지 않는다. 확정 트리거는 `approval.decided`이고, 앱 재시작 시에는 §3 인박스 또는 메시지 재조회로 복원한다.
- **`client_decision_id`를 매 탭마다 새로 만들지 마라.** 하나의 "결정 의도"에 하나여야 재전송이 멱등이다.
- **`isReversible`이 없다고 "되돌릴 수 있음"으로 렌더하지 마라.**
