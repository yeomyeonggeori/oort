# ADR-0124: 알림 음소거 계약 — 채널 단위 mute의 서버 판정

- Status: **Accepted** (2026-07-18, 성재 — D1~D3 권고안 승인 "ㄱㄱ". MOMO-477 발급, track/engine)
- 증보 2: 2026-09-27 **Accepted** — 알림 일시 중지 만료와 방해 금지 묶음(#2850). 파일 끝 「증보 2」 절
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

---

## 증보 2 (2026-09-27, **Accepted**) — 알림 일시 중지 만료와 방해 금지 묶음

- Status: **Accepted** (2026-09-27 성재 결재). 결재 인용: #2850 결정 요청 「방해 금지와 알림 일시 중지를 묶을지」에 성재가 「묶어」라고 답했다(2026-09-27 이슈 코멘트).
- 기안: Opus 5.5 worker(#2850, track/engine)
- 관련: #2848(폰 프로필 시트, 기한 없는 켜기·끄기만 싣는다), ADR-0160(선언 상태 ③), ADR-0176(사용자 지정 상태의 lazy 만료)
- 발단: owner 요청은 알림 일시 중지를 30분, 1시간, 내일까지, 직접 지정으로 거는 것이다. 증보 1의 `dnd`는 기한이 없고, D4는 스케줄을 v0 밖에 두었다. 클라이언트 타이머로 흉내 내면 앱이 백그라운드인 동안 서버 값이 풀리지 않아 「1시간」을 고른 사람이 그 뒤에도 푸시를 못 받는다.

### 왜 증보인가 (경계 변경)

공개 API 두 개(`notification-rules`, `presence`)와 DB 계약(090)이 바뀐다. 선언 상태(남에게 보이는 표시)가 알림 판정 입력에 처음 영향을 준다. 판정 지점은 여전히 하나다(momo-push `judge_targets`). 판정 SQL은 `member`를 읽지 않고 `notification_rule`만 읽는다.

### D7. 만료 — 서버 판정, lazy

- `notification_rule.dnd_until timestamptz NULL`을 둔다. NULL이면 기한이 없다. 018 `muted_until`과 같은 패턴이다.
- 판정은 `dnd AND (dnd_until IS NULL OR dnd_until > now())`일 때만 억제한다. **푸시 판정 시점에 만료를 비교한다.** 스윕 작업은 없다. 지난 행은 그대로 남지만 억제하지 않는다.
- 읽기(`GET notification-rules`)도 유효 값을 준다. 기한이 지나면 `dnd=false`, `dndUntilMs=null`이다.

### D8. 방해 금지 ↔ 알림 일시 중지 묶음 (「묶어」)

- **한 곳, 한 트랜잭션.** `PUT /presence`의 트랜잭션(`set_declared_presence_in_tx`) 안에서 member 갱신, 알림 일시 중지 갱신, presence 브로드캐스트 outbox를 함께 쓴다. 클라이언트가 두 번 쓰지 않는다.
- **켜기.** 방해 금지를 새로 고르거나 기한을 다시 고르면 알림 일시 중지를 켠다. 켜기 전 값(`dnd`, `dnd_until`)을 `presence_prev_dnd`/`presence_prev_dnd_until`에 **처음 한 번만** 기억한다. 다시 기억하면 묶어서 켠 값을 기억하게 되어, 방해 금지를 풀어도 알림이 계속 멈춘다.
- **기한.** 방해 금지 기한(`member.presence_dnd_until`)과 같은 기한을 알림 일시 중지에 건다. 원래 알림 일시 중지가 켜져 있었으면 둘 중 늦은 기한을 쓴다(원래 기한이 없었으면 기한 없음 유지). 원래 꺼져 있었으면 두 값이 같은 시각에 함께 풀린다.
- **풀기.** 선언 상태가 방해 금지가 아니게 되면 기억한 값으로 되돌리고 기억을 지운다. 원래 켜져 있었으면 켜진 채로(원래 기한 그대로) 남는다.
- **만료.** 방해 금지 기한이 지나면 선언 상태 읽기(본인 GET, 로스터)는 `auto`로 투영된다(ADR-0176과 같은 lazy). 알림 일시 중지도 같은 시각에 판정에서 풀린다. 다음 presence 쓰기가 기억을 정리한다.
- **직접 편집이 묶음을 끊는다.** `PUT notification-rules`가 알림 일시 중지(`dnd`/`dnd_until`)를 바꾸면 기억을 지운다. 방해 금지를 풀 때 사람이 직접 고른 값을 덮지 않는다. 멘션 예외만 바꾸는 PUT은 묶음을 유지한다. 방해 금지 중 사용자 지정 상태만 고치는 presence 쓰기는 묶음을 다시 켜지 않는다.

### D9. 저장·API

- migration `090_notification_rule_dnd_until`: `notification_rule.dnd_until`, `presence_prev_dnd`, `presence_prev_dnd_until`, `member.presence_dnd_until`과 모양 CHECK. 새 테이블은 없다. 두 테이블 모두 기존 RLS FORCE 정책 아래 있다.
- `GET/PUT /v1/workspaces/{ws}/notification-rules`: 요청에 `dndUntilMs`(선택)를 더한다. 생략하면 진행 중인 기한을 유지하고, `null`이면 기한 없음, 값은 미래여야 한다(아니면 400). `dnd=false`면 기한을 지운다. 응답에 `dndUntilMs`(진행 중일 때만 값, 아니면 null)를 더하고 `dnd`는 유효 값이다. audit 페이로드에 `dnd_until_ms`를 더한다.
- `PUT /v1/workspaces/{ws}/presence`: 요청에 `dndUntilMs`(선택, `status=dnd`에서만 값 허용, 미래여야 함)를 더한다. 응답과 `type: presence` 브로드캐스트(`dnd_until_ms`)에 진행 중인 기한을 싣는다. 기한이 지난 방해 금지는 `auto`로 답한다.
- 클라이언트 문구: 방해 금지 설명에 「알림도 함께 멈춰요」. 시간 선택 UI(30분, 1시간, 내일까지, 직접)는 uxui 후속 이슈다.

### Consequences (증보 2)

- (+) 기한 있는 일시 중지가 서버에서 풀린다. 앱이 백그라운드여도 정확하다.
- (+) 판정 한 곳, 본문 미판독, unread 무영향을 그대로 지킨다. 판정 SQL은 조건 한 조각이 늘었다.
- (−) 선언 상태 쓰기가 `notification_rule` 행을 만들거나 바꾼다. 방해 금지를 한 번이라도 고른 사람은 행이 생긴다(판정 의미는 행 부재와 같다).
- (−) 묶음 기억 컬럼 두 개. 규칙은 이 절과 `momo_messaging::notification_rule`에 있다.
- 후속: 반복 스케줄(조용한 시간), 채널별 기한 음소거 UI.

