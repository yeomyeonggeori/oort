# ADR-0124: 알림 음소거 계약 — 채널 단위 mute의 서버 판정

- Status: **Proposed** (2026-07-18, Fable — 성재 D1~D3 승인 대기)
- 관련: ADR-0120(푸시 — 판정은 notifier 한 곳), ux-bible P8(알림 예산)·P9(판정 로직 서버 단일화), ENGINE_HANDOFF B-4, ADR-0109(unread — 배지는 별개 데이터)
- 발단: 설정 UI·서버 계약 양측 부재(2026-07-18 갭 감사 B-4). dogfood에서 채널이 늘며 알림 통제 수요.

## Context

1. 푸시 판정(DM/멘션/승인요청)은 NotifierWorker 한 곳에 있다(P-2, MOMO-404). 음소거가 클라 로컬이면 다기기(맥·아이폰) 불일치가 나므로 **서버 저장·notifier 판정**이 유일하게 P9 정합이다.
2. unread/배지(ADR-0109)는 별개 원장 — 음소거는 "푸시를 보낼 것인가"만 바꾸고 unread 집계는 건드리지 않는 것이 단순하다.

## Options & Decision (Proposed)

### D1. 범위
- **A (권고) — 채널 단위 무기한 mute + 해제 (v0)**: (member, channel) 페어당 muted bool. 워크스페이스 전역 DND·시간 스케줄(mute until)·키워드는 후속(스키마는 until 확장 여지로 `muted_until timestamptz NULL` — NULL=무기한).
- B — DND/스케줄 동시 도입: 표면 넓고 UI 비용 큼. 기각(v0).

### D2. 판정 위치·의미
- **A (권고) — notifier 판정 시 join으로 제외, unread 무영향**: 음소거는 push dispatch만 억제. 배지/unread는 그대로(사용자가 나중에 확인). 클라 로컬 음소거 저장 금지.

### D3. 멘션 처리 (제품 결정)
- **A (권고) — 음소거는 멘션 푸시도 억제(전면 억제)**: 의미가 단순하고 "조용히 해달라"는 의도에 충실. Slack 기본과 동일. 멘션 예외 옵션(Discord식)은 후속 스위치로 예약 — notifier 조건 1줄이라 나중에 싸게 뒤집을 수 있다.
- B — 멘션은 통과: "음소거인데 울린다" 혼란. 기각(v0, 후속 옵션으로만).

## 파생 (Accepted 후)

MOMO-477 단일 goal: `018_notification_pref` migration((workspace, member, channel) PK, muted_until NULL 확장 여지, RLS FORCE) + REST `PUT/DELETE /v1/workspaces/:ws/channels/:ch/notification-pref` + 채널 목록 응답에 `muted` 가산 + notifier 판정 join(억제 시 push_dispatch_log에 suppressed 기록 없이 후보 제외 — 로그 오염 방지) + verifier(음소거 dispatch 0/해제 재개/멘션 억제/다기기 일관/RLS) + openapi. PR base=track/engine.

## Consequences

- (+) 다기기 일관 음소거, P9 유지(판정 한 곳), unread 원장 무영향.
- (−) 채널 목록 응답 1필드 가산(클라 소화는 UXUI 후속 — 설정 UI는 A큐 등재).
- 보류: DND·스케줄·키워드 알림·멘션 예외 스위치.
