# ADR-0124: 알림 음소거 계약 — 채널 단위 mute의 서버 판정

- Status: **Accepted** (2026-07-18, 성재 — D1~D3 권고안 승인 "ㄱㄱ". MOMO-477 발급, track/engine)
- 관련: ADR-0120(푸시 — 판정은 notifier 한 곳), ux-bible P8(알림 예산)·P9(판정 로직 서버 단일화), ENGINE_HANDOFF B-4, ADR-0109(unread — 배지는 별개 데이터)
- 발단: 설정 UI·서버 계약 양측 부재(2026-07-18 갭 감사 B-4). dogfood에서 채널이 늘며 알림 통제 수요.

## Context

1. 푸시 판정(DM/멘션/승인요청)은 NotifierWorker 한 곳에 있다(P-2, MOMO-404). 음소거가 클라 로컬이면 다기기(맥·아이폰) 불일치가 나므로 **서버 저장·notifier 판정**이 유일하게 P9 정합이다.
2. unread/배지(ADR-0109)는 별개 원장 — 음소거는 "푸시를 보낼 것인가"만 바꾸고 unread 집계는 건드리지 않는 것이 단순하다.

## Options & Decision

### D1. 범위
- **A (권고) — 채널 단위 무기한 mute + 해제 (v0)**: (member, channel) 페어당 muted bool. 워크스페이스 전역 DND·시간 스케줄(mute until)·키워드는 후속(스키마는 until 확장 여지로 `muted_until timestamptz NULL` — NULL=무기한).
- B — DND/스케줄 동시 도입: 표면 넓고 UI 비용 큼. 기각(v0).

### D2. 판정 위치·의미
- **A (권고) — notifier 판정 시 join으로 제외, unread 무영향**: 음소거는 push dispatch만 억제. 배지/unread는 그대로(사용자가 나중에 확인). 클라 로컬 음소거 저장 금지.

### D3. 멘션 처리 (제품 결정)
- **A (권고) — 음소거는 멘션 푸시도 억제(전면 억제)**: 의미가 단순하고 "조용히 해달라"는 의도에 충실. Slack 기본과 동일. 멘션 예외 옵션(Discord식)은 후속 스위치로 예약 — notifier 조건 1줄이라 나중에 싸게 뒤집을 수 있다.
- B — 멘션은 통과: "음소거인데 울린다" 혼란. 기각(v0, 후속 옵션으로만).

## 파생 (Accepted 후)

MOMO-477 단일 goal: `018_notification_pref` migration((workspace, member, channel) PK, muted_until NULL 확장 여지, RLS FORCE) + REST `PUT /v1/workspaces/:ws/channels/:ch/notification-pref {muted: Bool}`(false=행 삭제) + 채널 목록 응답에 `muted` 가산 + notifier 판정 join(억제 시 push_dispatch_log에 suppressed 기록 없이 후보 제외 — 로그 오염 방지) + verifier(음소거 dispatch 0/해제 재개/멘션 억제/다기기 일관/RLS) + openapi. PR base=track/engine.

## Consequences

- (+) 다기기 일관 음소거, P9 유지(판정 한 곳), unread 원장 무영향.
- (−) 채널 목록 응답 1필드 가산(클라 소화는 UXUI 후속 — 설정 UI는 A큐 등재).
- 보류: DND·스케줄·키워드 알림·멘션 예외 스위치.

---

## 증보 1 (2026-08-10, **Proposed** — 머지 시 성재 최종 승인) — 사용자 편집 알림 규칙 v0 (DND + 멘션 예외)

- 관련: 검수 배치 2 W-B2-3(`feat/notif-rules`), 편성 정본 `docs/planning/2026-08-10-desktop-qa-feedback-batch2.md`, ux-bible P9(판정 서버 단일).
- 발단: 성재 결정 "알림 규칙 실기능 채우기". 조사 실측 — 설정의 알림 규칙 패널(`SettingsRoute.tsx` NotificationRulesSection)은 "규칙을 이 화면에서 바꾸는 기능은 아직 없습니다"라는 빈 안내 패널이고, 서버에 사용자 편집용 operator REST가 없다. 인박스 "알림 규칙 설정" 링크는 `/settings`(첫 섹션=계정)로 착지해 규칙 패널에 닿지 못한다.

### 왜 증보인가 (경계 변경)

본 증보는 **notifier 판정 트리(P9·서버 단일)에 사용자 편집 경로를 여는 경계 변경**이다. 지금까지 판정 입력은 채널 단위 mute(018) 하나뿐이었고 그것도 클라가 채널 헤더 메뉴에서만 켰다. 이 증보는 **member 전역** 규칙 원장 하나를 새로 들이고, 그 규칙을 판정 SQL이 소비하게 한다. 판정이 한 곳(momo-push `judge_targets`)이라는 불변식은 그대로다 — 규칙은 입력이 늘어난 것이지 판정 지점이 늘어난 것이 아니다.

### D4. v0 범위 (의도적으로 좁게)

세 파킹 항목(DND·키워드·멘션 예외) 중 **본문을 읽지 않고 판정 SQL 한 조각으로 표현되는 둘만** 넣는다.

- **D4-A (채택) — DND (방해 금지)**: `(workspace, member)` 전역 무기한 on/off. 켜면 그 멤버의 **모든** push를 억제한다(DM·멘션·승인요청 포함). 018 채널 mute와 같은 "전면 억제" 의미를, 채널이 아니라 워크스페이스 전역에 건 것. unread/배지는 D2와 동일하게 무영향(돌아오면 확인).
- **D4-B (채택) — 멘션 예외 (채널 mute 관통)**: `(workspace, member)` 전역 스위치. 켜면 018로 음소거한 채널이어도 **reason='mention'** 인 후보는 통과시킨다. 이것은 D3가 "후속 옵션으로만 예약 — notifier 조건 1줄이라 나중에 싸게 뒤집을 수 있다"고 적어 둔 바로 그 스위치다. DND는 이 예외보다 위다(DND는 멘션도 억제).
- **제외 — 키워드 알림**: 판정은 `message.body`를 어디서도 읽지 않는다(D2/P9의 핵심 불변식; 멘션조차 삽입 시 서버가 재계산해 저장한 `props.mention_member_ids` 투영으로만 판정한다). 키워드는 본문 판독이나 새 투영 파이프라인을 요구하므로 v0 밖 — 후속 ADR로 남긴다.
- **제외 — DND 스케줄/조용한 시간, 채널별 DND**: 표면·저장이 넓어져 v0 밖(D1이 이미 스케줄을 후속으로 파킹).

### D5. 저장·판정·API

- **저장**: `066_notification_rule` — `notification_rule (workspace_id, member_id)` PK, `dnd bool NOT NULL DEFAULT false`, `mention_overrides_mute bool NOT NULL DEFAULT false`, `created_at`/`updated_at`, RLS FORCE(018과 동일 정책). **행 부재 = 둘 다 false** = 현행 동작 그대로(마이그레이션은 기존 사용자 무영향). 018 `notification_pref`(채널별)와 별개 테이블 — 이쪽은 member 전역이라 channel_id가 없다.
- **판정(momo-push `judge_targets`) 우선순위**: `DND(member) > 채널 mute(018, 멘션 예외 반영) > 사유`. 즉 최종 후보 조건은 (1) `dnd`면 전면 탈락, (2) 아니면 채널이 현재 음소거인데 `NOT (reason='mention' AND mention_overrides_mute)`이면 탈락, (3) 그 밖엔 기존 사유 로직대로. 억제는 018과 같이 push_dispatch_log에 suppressed 기록을 남기지 않는다(로그 오염 방지).
- **API**: `GET/PUT /v1/workspaces/{ws}/notification-rules` — 인증 주체 **본인**의 규칙(operator gate 없음, `work-tier-policy/me`와 같은 자기-설정 계약). PUT은 두 bool 전체를 치환(`deny_unknown_fields`), 응답은 유효 상태 재조회. 같은 트랜잭션 audit(`notification_rule.updated`).

### D6. 기존 채널 mute와의 통합

018 채널 mute는 그대로다(채널 헤더 메뉴에서 켠다). 증보의 두 규칙은 그 위에 얹힌다: **멘션 예외**는 018 mute의 동작을 수정하고, **DND**는 018과 독립적으로 전역을 덮는다. 설정의 "알림 규칙" 패널은 이 member 전역 규칙 둘을 다루고, "채널 하나만 조용히"는 채널 헤더에서 한다는 관계를 카피로 명시한다(두 표면 혼동 방지).

### Consequences (증보)

- (+) 판정 한 곳 유지, 본문 미판독 불변식 유지, unread 무영향, 다기기 일관.
- (+) D3가 예약한 멘션 예외 스위치를 계약대로(조건 한 조각) 실현.
- (−) 판정 SQL에 LEFT JOIN 1개·WHERE 조건 2개 가산. 새 REST 2개·마이그레이션 1개.
- 후속(여전히 보류): 키워드 알림, DND 스케줄/조용한 시간, 채널별 DND, 멘션 예외의 채널 단위 세분화.
