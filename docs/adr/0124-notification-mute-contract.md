# ADR-0124: 알림 음소거 계약 — 채널 단위 mute의 서버 판정

- Status: **Accepted** (2026-07-18, 성재 — D1~D3 권고안 승인 "ㄱㄱ". MOMO-477 발급, track/engine)
- 증보 2: 2026-09-27 **Accepted** — 알림 일시 중지 만료와 방해 금지 묶음(#2850). 파일 끝 「증보 2」 절
- 증보 3: 2026-09-28 **Accepted**(증보 2 결재 범위의 쓰기 모양 보강, planner 편성 #3012) — 필드 단위 `PATCH …/notification-rules`. 파일 끝 「증보 3」 절
- 증보: 2026-10-16 **ADR-0204 D2·D3** — 화면은 기한을 반드시 고른다(「직접 끌 때까지」 없음, 서버 `null` 계약은 그대로), 방해 금지 문구 「알림도 함께 멈춰요」(증보 2 요구 이행), 멈춤 표시(폰 인박스·데스크탑 사이드바). 증보 1 머리 표기 정정.
- 증보: 2026-10-25 **ADR-0206**(알림 설정 v2) — 채널 음소거에 기한을 쓰고 읽는다(`mutedUntilMs`, D12), 채널 단계 `all`은 새 표 `notification_channel_level`에 둔다(D7, 이 ADR의 「`notification_pref` 행이 있으면 음소거」는 그대로), 증보 1 D4가 제외한 키워드 알림(D3)과 DND 스케줄(D13)을 정한다.
- 증보 4: 2026-11-11 **Accepted 2026-11-11 planner — owner 2026-11-11 「켜줘」(DM·스레드 답글도 데스크탑 표시), 독립 보안 검수 뒤 착륙** — 읽음 투영에 `followed_unread_reply_count`(따라가는 스레드의 안 읽은 답글 수)를 더하고, 그 값이 바뀔 때 개인 채널 신호 `followed_unread.updated`를 보낸다(#5667). 파일 끝 「증보 4」 절
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

## 증보 1 (2026-08-10, **Accepted — 표기 정정 2026-10-16**: 머지돼 시행 중이고, 증보 2(2026-09-27 성재 결재 「묶어」)가 이 증보의 `dnd`를 전제로 승인됐다. 증보 1 자체의 별도 결재 원문은 없다 — ADR-0204 D2) — 사용자 편집 알림 규칙 v0 (DND + 멘션 예외)

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

- migration `090_notification_rule_dnd_until`: `notification_rule.dnd_until`, `presence_prev_dnd`, `presence_prev_dnd_until`, `member.presence_dnd_until`. 모양 CHECK는 기억 컬럼에만 건다. 기한 컬럼에는 걸지 않는다 — 이전 digest로 롤백한 v0.1.10 서버가 새 컬럼을 모른 채 게이트(`dnd`, `presence_status`)만 끄는 해제 쓰기가 위반으로 막히지 않게 하기 위해서다. 게이트가 꺼진 행의 기한은 모든 reader가 무시하고, 새 코드는 쓸 때 NULL로 정규화한다. 롤백 중 잔여 강등: 구 판정은 `dnd_until`을 모르므로 기한 있는 일시 중지는 「끌 때까지」가 된다(끌 수는 있다). 새 테이블은 없다. 두 테이블 모두 기존 RLS FORCE 정책 아래 있다.
- `GET/PUT /v1/workspaces/{ws}/notification-rules`: 요청에 `dndUntilMs`(선택)를 더한다. 생략하면 진행 중인 기한을 유지하고, `null`이면 기한 없음, 값은 미래여야 한다(아니면 400). `dnd=false`면 기한을 지운다. 응답에 `dndUntilMs`(진행 중일 때만 값, 아니면 null)를 더하고 `dnd`는 유효 값이다. audit 페이로드에 `dnd_until_ms`를 더한다.
- `PUT /v1/workspaces/{ws}/presence`: 요청에 `dndUntilMs`(선택, `status=dnd`에서만 값 허용, 미래여야 함)를 더한다. 응답과 `type: presence` 브로드캐스트(`dnd_until_ms`)에 진행 중인 기한을 싣는다. 기한이 지난 방해 금지는 `auto`로 답한다.
- 로스터 행에 `dndUntilMs`(진행 중일 때만)를 싣는다. 만료 시각에는 이벤트가 없으므로 동료 클라이언트가 이 값으로 표시를 내린다. 동료에게 보이는 것은 선언 상태의 기한(`member.presence_dnd_until`)뿐이다. 이것은 본인이 남에게 보이라고 고른 표시의 일부이고, ADR-0176 `statusExpiresAtMs`가 로스터에 실리는 선례와 같다. 합집합으로 더 길어질 수 있는 사적 `notification_rule.dnd_until`은 본인 응답에만 있다. 이 필드를 모르는 구 클라이언트는 만료 뒤 로스터 재조회나 다음 브로드캐스트까지 방해 금지 표시를 유지한다(재조회 시 서버가 `auto`로 투영해 스스로 풀린다).
- audit: `PUT notification-rules`는 기존대로 `notification_rule.updated`를 남긴다. presence 쓰기 안의 묶음은 presence의 무감사 관례(ADR-0176, 과감사 금지)를 따라 audit 행을 남기지 않는다.
- 클라이언트 문구: 방해 금지 설명에 「알림도 함께 멈춰요」. 시간 선택 UI(30분, 1시간, 내일까지, 직접)는 uxui 후속 이슈다.

### Consequences (증보 2)

- (+) 기한 있는 일시 중지가 서버에서 풀린다. 앱이 백그라운드여도 정확하다.
- (+) 판정 한 곳, 본문 미판독, unread 무영향을 그대로 지킨다. 판정 SQL은 조건 한 조각이 늘었다.
- (−) 선언 상태 쓰기가 `notification_rule` 행을 만들거나 바꾼다. 방해 금지를 한 번이라도 고른 사람은 행이 생긴다(판정 의미는 행 부재와 같다).
- (−) 묶음 기억 컬럼 두 개. 규칙은 이 절과 `momo_messaging::notification_rule`에 있다.
- 후속: 반복 스케줄(조용한 시간), 채널별 기한 음소거 UI.

## 증보 3 (2026-09-28, **Accepted** — 증보 2 결재 범위의 쓰기 모양 보강, planner 편성 #3012) — 알림 규칙 필드 단위 PATCH

- 발단: #2893 후속(PR #3011). 폰은 쓰기 직전에 다시 읽어서 막았지만, 웹 설정 화면은 여전히 규칙 전체를 PUT한다. 그래서 폰에서 켠 일시 중지를 웹이 자기가 전에 읽은 값(꺼짐)으로 되돌릴 수 있다. 격리 PG 시험 `a_put_from_a_stale_snapshot_erases_the_other_clients_pause`가 이 경합을 재현한다.
- **결정.** `PATCH /v1/workspaces/{ws}/notification-rules`를 더한다.
  - `dnd`·`dndUntilMs`·`mentionOverridesMute`가 모두 선택이다. 생략한 필드는 **쓰기가 닿는 순간 저장된 값**을 유지한다. 행을 materialize하고 `FOR UPDATE`로 잠근 **뒤에** 병합 기준을 읽으므로, 동시 PATCH 둘은 직렬화되고 뒤의 것이 앞의 것이 커밋한 행 위에 병합된다.
  - 쓰기는 PUT과 같은 함수를 쓴다. 그래서 기한 규칙과 방해 금지 묶음 규칙이 같다. 일시 중지를 바꾸면 묶음이 끊기고, 멘션 예외만 바꾸면 묶음이 남는다.
  - 빈 body는 400이다. 모르는 필드도 400이다(PUT과 같다). audit는 기존 `notification_rule.updated`에 `patched`(요청이 이름한 필드 목록)를 더한다.
- **호환.** PUT은 그대로 남는다(구 클라이언트). 새 클라이언트 코드는 PATCH를 쓴다. 웹·폰 전환은 uxui 후속 이슈다.
- **테이블·RLS 변경 없음.** migration이 없다.

---

## 증보 4 (2026-11-11, **Accepted 2026-11-11 planner — owner 2026-11-11 「켜줘」(DM·스레드 답글도 데스크탑 표시), 독립 보안 검수 뒤 착륙**) — 읽음 투영의 따라가는 스레드 안 읽은 답글 수와 그 신호

- 발단: owner 2026-11-11 「켜줘」 — DM과 스레드 답글도 데스크탑 메뉴 막대·독 표시를 켠다(폰은 울리는데 맥 표시가 없는 일을 없앤다). 클라이언트 칸(#5660)은 DM을 켰고, 스레드 답글은 서버 값을 기다린다. 따라가는 스레드의 안 읽은 답글은 지금 스레드마다의 요약(ADR-0206 증보 1 F10의 `unread_reply_count`)으로만 와서, 워크스페이스 전체에서 「지금 답글이 와 있나」를 싸게 알 길이 없다.
- 범위: 서버 계약(#5667). 클라이언트가 이 값을 메뉴 막대 표시에 더하는 것(#5660 후속)과 폰 푸시 규칙은 이 절 밖이다.

### 왜 증보인가 (경계 변경)

공개 API(`GET …/read-state`)에 필드 하나를 더하고, 개인 채널(`user:read-state#<MEMBER>`)에 새 프레임 종류 하나를 연다. 누구에게 무엇이 보이는지가 바뀌는 등급이다: 새 값과 신호는 **읽는 사람 본인의 것**만 담는다. 이 ADR은 「배지·안 읽음은 알림 판정과 별개 원장」(D2)을 정한 곳이라 여기에 둔다. ADR-0206 증보 1의 F8(「따라가기에는 이벤트가 없다」)과 F10(「안 읽은 답글 수는 기록 페이지의 스레드 요약에만」)은 이 절이 고친다: 수는 스레드 요약에 더해 채널 합으로도 오고, 따라가기·읽음 신호는 본인의 개인 채널에 프레임 하나를 남긴다. 판정 지점(momo-push)·푸시 규칙·DB 표는 바뀌지 않는다(migration 없음).

### D10. 필드: `followed_unread_reply_count`

- **어디**: `GET …/read-state`의 채널 줄(`ReadStateRow`)마다. 언제나 있고 없으면 `0`이다. 이름은 이웃 필드와 같은 snake_case다.
- **정의**: 그 채널에서 읽는 사람이 **따라가는**(`auto`·`followed`) 스레드들의 `unread_reply_count`의 합. 곧 다른 사람이 쓴, 지우지 않은 `text` 답글 중 스레드 읽은 위치(`thread_follow.last_read_reply_seq`)보다 뒤의 것이다. 스레드 요약과 **같은 정의**이고 시험이 「같은 입력에서 스레드별 수의 합 = 이 값」을 잠근다.
- **세지 않는 것**: 내가 쓴 답글, 따라가지 않는 스레드(행 없음·`unfollowed`), 지운 답글, 진행 줄(`text`가 아닌 것), 내가 지금 멤버가 아닌 채널(투영에 그 줄이 없다), 보관된 채널, 다른 워크스페이스.
- **바뀌지 않는 것**: 기존 필드(`unread_count`·`mention_count`·`marked_unread_before_seq`·`latest_readable_seq`·`closed_at_seq` 등)의 값과 뜻은 그대로다. 기존 투영 문장은 손대지 않고, 두 번째 문장(`thread_follow` 쪽)이 이 값만 채운다. `PUT …/read-state` 응답과 `read_state` 프레임에는 싣지 않는다.
- **겹침**: 나를 멘션한 스레드 답글은 `mention_count`와 이 값 양쪽에 들어간다. 둘을 더해 표시하는 클라이언트가 겹침을 뺀다(DM 몫이 `unread_count − mention_count`를 쓰는 것과 같은 자리).

### D11. 신호: `followed_unread.updated`

- **길**: 지금의 읽음 신호와 같다. 같은 트랜잭션의 outbox(`emit_outbox`) → relay → Centrifugo, 읽는 사람의 개인 채널 `user:read-state#<MEMBER>`, `partition_key` = 그 멤버. 새 Centrifugo 네임스페이스·클라이언트 publish는 없다.
- **모양**: `{type: "followed_unread.updated", v: 1, ts, payload: {workspace_id, member_id, channel_id, root_id}}`. **id만 싣고 수는 싣지 않는다** — 뜻은 「이 목록을 다시 읽어라」다(인박스 신호와 같은 규율). 커밋 순서와 발행 순서가 어긋나도 낡은 수가 화면에 남지 않는다. idempotency 키는 변화마다 다르다: 새 답글 `m:<답글 id>`, 읽음 `r:<루트>:<새 위치>`, 따라가기 `f:<루트>:<상태>:<updated_at µs>`.
- **언제, 누구에게**:
  1. **새 답글**(스레드가 세는 `text` 답글, 자동 따라가기와 같은 조건): 그 스레드를 따라가는 사람 중 **작성자를 뺀**, 그 채널의 **지금 멤버**(나간 사람 제외)에게 한 건씩. 보관된 채널은 보내지 않는다. 자동 따라가기 바로 뒤에 보내서 이 답글이 막 끌어들인 사람(루트 작성자·멘션된 사람)도 받는다. 나간 사람을 빼는 것은 비공개 채널에서 나간(내보내진) 사람이 그 채널이 살아 있음을 알지 못하게 하려는 것이다.
  2. **내가 스레드를 읽음**(`PUT …/messages/{root}/read`): 따라가는 행의 위치가 실제로 앞으로 갔을 때만, 본인에게.
  3. **따라가기 켬·끔**(`PUT`/`DELETE …/follow`): 행이 실제로 바뀌었을 때만(새 행 또는 상태 변화), 본인에게.
  
  바뀐 것이 없는 요청(같은 위치, 같은 상태)은 보내지 않는다. 재시도로 겹친 보내기는 `deduped` 반환에서 빠져 신호도 없다.
- **인박스 신호로는 모자라다**: `inbox_item.created`의 `thread_reply` 수신자는 루트 작성자와 그 스레드에 쓴 사람이다(migration 126). 직접 따라가기만 누른 사람·앞에서 멘션만 된 사람은 다음 답글에 항목이 없고, 그만 따라간 사람은 항목을 받는다. 스레드를 읽어도 인박스 항목은 읽음이 되지 않는다. 그래서 새 프레임을 만들되, 받는 사람을 「값이 실제로 바뀌는 사람」으로 좁혔다. 시험이 「직접 따라간 사람은 인박스 항목 0건, 프레임 1건」을 잠근다.
- **비용**: 새 답글마다 outbox 행이 (따라가는 지금 멤버 − 작성자) 수만큼 늘고, 보내기 tx 안에서 받는 사람마다 `emit_outbox` 왕복이 한 번이다. 받는 사람을 고르는 문장은 `thread_follow` PK(`root_id`) 조회 하나다. 프레임이 id만 싣기 때문에 받은 기기마다 `GET …/read-state`를 한 번 다시 읽는다 — **클라이언트는 프레임을 모아(디바운스) 한 번만 읽는다**(인박스 신호의 250ms 묶음과 같은 방식). 투영은 문장 하나가 늘었고 색인(`thread_follow_member_idx`, `message_thread_idx (root_id, seq)`)을 탄다. 그 문장의 비용은 「따라가는 행 수 + 안 읽은 답글 수」에 비례하고 스레드 길이와는 무관하다. 채널 300·따라가는 스레드 300인 멤버의 실측(PR 본문): 기존 문장 0.55ms·버퍼 105, 더한 문장은 스레드마다 안 읽은 3개일 때 0.96ms·버퍼 1,507, 스레드마다 105개(합 31,500, 위치 0)일 때 14.4ms·버퍼 32,211. 새 색인·migration은 없다.

### D12. 알림 끄기·방해 금지와 무관 (D2·D4-A 그대로)

배지·안 읽음은 알림 끄기·방해 금지와 무관하다(D2·D4-A). 이 값도 채널 음소거·알림 일시 중지와 관계없이 센다. 무엇을 표시에 더할지(예: 폰이 울리지 않는 스레드를 맥 표시에서 뺄지)는 클라이언트의 표시 규칙이고 이 절이 정하지 않는다.

### 남는 것 (증보 4)

- 답글 삭제와 채널 나가기는 값을 바꾸지만 프레임을 보내지 않는다. 다음 읽기(신호·30초 폴링·재접속)에서 맞춰진다.
- 새 답글 프레임은 「스레드가 세는」 답글(`ThreadPolicy::Maintain`)에만 간다. 지금 `text` 답글을 쓰는 생산자는 모두 이 길을 지난다(`send_run_line_in_tx`가 `text`를 `Maintain`으로 보낸다). 다른 길로 스레드에 `text`를 쓰는 생산자가 생기면 이 조건을 다시 본다.
- 클라이언트(#5660 후속)가 이 프레임을 받아 투영을 다시 읽고 메뉴 막대 표시에 더한다. 그 전의 클라이언트는 이 프레임 종류를 모르는 채 버린다(`asInboxEvent`·`asScheduledMessageFrame`이 다른 종류를 무시한다).
