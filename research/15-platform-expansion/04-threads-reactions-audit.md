# 15-04 · 스레드·리액션 스키마 점검 (성재 질문, 2026-07-15)

> Planning ID: `PLN-20260715-02` 후속 · 기준: main @ e35be71 · 질문: "이모지 달기와 스레드(메시지의 메시지)가 우리 DB 스키마에 포함되어 있는가"

## 결론: 둘 다 스키마에 day-1부터 포함되어 있다. 비어 있는 것은 REST 표면과 UI뿐이다.

| 레이어 | 스레드 | 리액션(이모지) |
|---|---|---|
| DB 스키마 | ✅ `message.root_id`(스레드 루트)/`reply_to_id`(직접 답장) + partial index(`001_init.sql:176-190`), `thread` rollup 테이블(reply_count/last_reply_seq/last_reply_at/participant_ids, `:202-211`) | ✅ `reaction` 테이블 — emoji(unicode/shortcode), `UNIQUE(message_id, member_id, emoji)`(`:216-226`) |
| 서버 REST | ❌ `SendMessageRequest`/`MessageDTO`에 스레딩 필드 없음(`DTOs.swift:106-128`) — 쓰기·읽기 모두 미노출. 서버 내부 컨텍스트 조립(MOMO-302)만 thread를 사용 | ❌ 라우트 0건 |
| 클라이언트 | UI 없음. 백로그 **MOMO-305**(스레드/unread 계열)에 UI 예약 | `ChatBackend.addReaction` 프로토콜 선언만(`clients/Core/Sources/MomoCore/ChatBackend.swift:66`) |
| UX 원칙 | ux-bible **P12** — "스레드는 메인 뷰 가독성이 제1제약" | P8(알림 예산 — 리액션은 알림을 만들지 않거나 묶음) |

푸시·파일과 동일한 "자리는 있고 경로만 없음" 패턴이다. 스키마 재설계 없이 라우트+outbox 이벤트+UI 연결만 하면 된다.

## 열리는 작업 (제안 — 발급은 트랙 조율 후)

1. **리액션 REST + 실시간** (엔진 트랙 후보, 서버만): `POST/DELETE /v1/.../messages/:id/reactions` + history 응답에 집계 포함 + outbox `reaction.added/removed` 브로드캐스트. 단일 쓰기 경로·RLS 그대로. UI는 UX 트랙(macOS)과 웹 W-4에서 각자 소비.
2. **스레드 REST** (서버): send에 `rootId`/`replyToId` 수용 + thread rollup 갱신(같은 트랜잭션) + `GET .../threads/:root` 페이지네이션. **UI는 UX 트랙 소유**(MOMO-305, P12 제약) — 서버 계약을 먼저 열어두면 macOS/웹이 병렬 소비 가능.
3. OpenAPI 정본(MOMO-389)에는 v0 표면만 담는다 — 리액션/스레드 REST가 구현되면 스펙에 추가하는 순서(스펙이 코드를 앞지르지 않음).

주의: 스레드 UI는 성재+momo-main의 UX 트랙 영역이므로, 엔진 트랙은 서버 계약까지만 제안하고 UI 발급은 UX 트랙 판단에 맡긴다.
