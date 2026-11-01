# ADR-0206: 알림 설정 v2 — 전달·표면·표현을 갈라 두고, 진단·채널 단계·키워드·데스크탑 활성 시 폰 지연·알림음을 한 계약으로

- Status: **Accepted** (2026-10-25, planner 위임 결정 — owner 10-22 「결정 부탁드릴 것은 너가 권장으로 진행해봐」 + owner 10-21 「직접 넣어서」). 독립 설계 검토를 세 번 거쳤어요: r1 FAIL(Blocker 0·High 4·Medium 16·Low 3)과 r2 FAIL(High 2·Medium 17·Low 6)의 지적을 반영하고 r3에서 PASS(Blocker 0·High 0)를 받았어요. r3의 Medium 7·Low 15는 PASS 뒤에 별도 커밋으로 반영했어요. [권장]으로 정한 결정(D11~D20과 「리서치와 달라진 곳」)은 PR 본문 「권장으로 정한 것」 표에 모두 있어요 · **증보 1** (2026-10-31 기안, **Proposed** — 독립 설계 검토·planner 결재 전, ADR-0100): 참여한 스레드의 새 답글 알림, 곧 스레드 따라가기(#4889). 새 판정 갈래 `thread_reply`·따라가기 표(migration 164)·따라가기 API·자동 따라가기·묶음 규칙. 「증보 1」 절
- Date: 2026-10-25
- Deciders: 성재
- 기안: Sonnet 5.5 엔진 워커 (#4223, 검토 r1~r3 수리 포함). 리서치 r7(로컬 기록 `claudedocs/resume-2026-09-23/handoff-1021/research-1021/r7-notifications-report.md`, 레포 미추적)의 §6 권장안 D1~D10을 이슈 #4223이 확정한 대로 받고, 코드로 다시 확인해 달라진 곳은 「리서치와 달라진 곳」에 모았어요.
- 관계
  - ADR-0120(푸시 경계, 부록 A): **어휘 증보**예요. reason 4종·category 1종·선택 키 1종을 더하고 D2의 id-only는 그대로예요. 본문 결정은 바꾸지 않아요. (증보 1이 reason `thread_reply` 1종을 더 더해요: 증보 1 F5.)
  - ADR-0124(알림 음소거, 증보 1~3): **증보**예요. 증보 2가 열어 둔 `muted_until`을 API로 쓰고 읽게 하고(D12), 증보 1 D4가 「후속 ADR」로 미룬 키워드(D3)와 「DND 스케줄/조용한 시간」(D13)을 정해요. 멘션 예외·일시 중지의 뜻은 그대로예요.
  - ADR-0204(폰 알림 v2): **D8 부분 번복**(D4)이고 **D10 이행**(D11)이에요. 증보 3의 `channel_viewing` 위에 얹어요. D1~D3·D6·D7·D9와 D8-a는 그대로예요. 증보 4(같은 폰에서 다음 멤버가 로그인할 때의 기기 이전, #3978)도 건드리지 않아요: 푸시 대상은 계속 `push_token.member_id`로 가려지고, 진단(D11)의 「토큰 없음·무효」와 시스템 푸시(D15)의 대상 고르기는 그 위에서 읽기만 해요.
  - ADR-0208(예약 메시지) D8: 미뤄 둔 **실패 푸시의 다섯 비용**을 여기서 정해요(D15).
  - ADR-0188 §8.7: NSE `push_fetch` 허용 경로(읽기 둘)는 **바뀌지 않아요**.
  - ADR-0148(인용 답글과 스레드): 증보 1이 스레드 따라가기를 더해요. 답글의 집을 스레드로 통일하고 「대화에도 보내기」를 정하는 ADR-0148 증보(#4887)와 맞물려요. 대화에도 보낸 답글은 채널 규칙(N1)을 먼저 타고, 따라가는 사람에게 두 건이 가지 않아요(증보 1 F4).
  - 이 ADR이 정하지 않는 것은 D20에 모았어요(규칙 빌더 ADR-0207, Apple capability 작업, 다이제스트, 허들 시작 푸시 #2767).
  - ADR-0100(거버넌스), ADR-0177(설정은 이벤트 없이 다음 조회로 수렴하는 선례), ux-bible P8·P9·P10.
- 번호 확인 [V, 2026-10-25]: `origin/main`·`origin/track/engine`·`origin/track/uxui`와 원격 브랜치 912개의 `docs/adr/`에 0206·0207 파일이 없고(마지막은 0214) 열린 PR 중 `docs/adr/02`를 만드는 것도 없어요. 0206·0207은 #4213이, 0209~0213은 열린 이슈(#4238·#4239·#4240 등)가 예약했어요. 이 ADR은 **0206**만 써요.
- 표기: [V] 이 세션에서 저장소 코드·문서를 직접 읽어 확인(`파일:줄`, 기준 `track/engine` `5bdecd348`. ADR 문서의 줄도 이 커밋 기준이라, 이 PR이 0120·0124·0204 머리에 한 줄씩 넣으면 그 뒤에는 한 줄씩 밀려요) · [외부] 공식 문서·공개 저장소(리서치 r7이 읽은 것, 이 세션에서 다시 열지 않음) · [추정] 해석 · [권장] 성재 위임(2026-10-22)으로 이 ADR이 고른 것(PR 본문 「권장으로 정한 것」에 모두 적었어요) · [확인 필요] 구현 전에 확인 · `runtime-unverified` 실행하지 않음. 이 문서는 설계예요. 코드·마이그레이션은 바꾸지 않았고, 함께 들어가는 것은 아래 둘뿐이에요.
- 함께 들어가는 문서: `docs/api/openapi.yaml`의 계약 초안(부록 A, ADR-0208과 같은 방식) · ADR-0120·0124·0204 머리의 포인터 한 줄.

## 맥락

### owner 요청 (원문)
- 2026-10-21 성재: 「버즈쪽에서 알림에서 에로사항을 엄청 느끼는 거 같아. 그 부분에 있어서 커스텀까지도 가능하게(직접 넣어서 말이야) 해줬으면 좋겠어.」 「직접 넣어서」는 알림음 파일(1차)과 사용자 규칙(2차)으로 읽고 둘 다 설계해요.
- 2026-10-22 성재(위임): 「결정 부탁드릴 것은 너가 권장으로 진행해봐.」
- 2026-10-22 성재(소리 출처): 「기본 알림음은 너가 뭐 오픈소스같은걸로 만들거나 알림음을 찾아봐봐.」
- 2026-10-22 planner 결정(#4223 코멘트): ADR-0208 D8이 푸시를 뺀 예약 실패를 이 ADR이 새 reason(`scheduled_failed`)과 다섯 비용으로 함께 정해요.

### 리서치가 짚은 것 (요약, [외부])
- Buzz의 불편은 「설정이 적다」보다 「왜 안 오는지 모르고(B1), 시끄러운데 놓치고(B3), 소리 스위치가 배너까지 끄고(B6), 설정이 기기에 묶인다(B8)」예요(r7 §2.1).
- 사용자 파일 알림음을 하는 비교 제품은 Telegram뿐이에요(5초·307,200바이트·100개, 서버가 변환, 기기 간 동기화). 카카오톡 키워드는 알림을 끈 방도 뚫어요(r7 §2.2).
- Slack은 모바일 푸시를 데스크탑이 비활성일 때만 보내요. 기본은 화면 잠금 1분 뒤 또는 커서 10분 정지 뒤예요(r7 §2.2).

### 운영 사실
- [V] 푸시가 15일 동안 0건이었고 사용자는 알 수 없었어요(ADR-0204 맥락 `:12-30`).
- [V] 서버는 DM 두 건을 모두 보냈고 APNs가 200으로 받았는데 받는 사람은 못 봤다고 했어요. 서버 기록으로는 앱이 앞에 있었는지, iOS 설정·집중 모드였는지 가를 수 없었어요(#4295 진단 코멘트). 그래서 진단은 서버가 아는 코드와 기기만 아는 코드 두 갈래예요(D11).

### 지금 있는 것 [V]

| 영역 | 사실 | 근거 |
|---|---|---|
| 판정은 한 곳 | `judge_targets` 한 문장이 수신자와 reason을 고르고 본문을 읽지 않아요. reason 우선순위는 작업 세 가지(`resume_offer`·`work_session_idle`·`work_run_done`) > 승인 > 멘션 > DM > 에이전트의 답이에요 | `server-rust/crates/momo-push/src/judgment.rs:1-198`(머리말), `:312-402`(reason CASE) |
| 억제 | 일시 중지(`dnd`, 기한은 판정 때 비교), 작업 끝남 스위치, 채널 음소거(기한이 지난 행은 풀림, 멘션 예외)가 AND로 걸려요 | `judgment.rs:462-473` |
| 채널 음소거 | `notification_pref` 행이 있으면 음소거예요. 쓰는 쪽은 기한을 항상 NULL로 넣어요 | `server/Migrations/018_notification_pref.sql:9-17`, `server-rust/crates/momo-messaging/src/channel.rs:473-523` |
| 기한 읽기 | 읽는 곳 다섯이 이미 `muted_until IS NULL OR muted_until > now()`를 평가해요 | `judgment.rs:469-473`, `momo-messaging/src/dm.rs:244-249`·`:309-314`, `channel.rs:658-663`, `inbox.rs:221-232` |
| 음소거 API | 요청은 `{muted}` 하나(`deny_unknown_fields`), 응답도 `{muted}`예요 | `server-rust/bins/momo-server/src/dto.rs:2683-2694`, `routes/channels.rs:240-287` |
| 폰 음소거 | 사이드바 길게 누르기에 **무기한** 켜고 끄기가 있어요. 기한 선택은 없고 채널 헤더에는 없어요 | `clients/mobile/src/features/sidebar/useChannelRowActions.ts:240-257` |
| 푸시 어휘 | reason 6종, category 5종이고 키 집합은 정확히 일치해야 해요. UUID 형식은 `approval_id`만 검사해요 | relay `server-rust/bins/momo-push-relay/src/dispatch.rs:15-31`(키), `:43-50`, `:61-67`, `:188-250`(검사, UUID는 `:221`) |
| 소리 | 폰은 모든 category가 `aps.sound="default"`예요. 데스크탑 배너는 소리가 없어요 | relay `dispatch.rs:100-106`, `clients/desktop/src-tauri/src/notification.rs:88-92` |
| NSE | 어휘를 모르면 파싱이 실패해 relay의 정적 자리표시(「oort / 새 알림」)로 남아요(fail-open). 네트워크로 읽는 길은 둘뿐이에요(roster, 채널 messages) | `clients/mobile/ios/NotificationService/NotificationService.swift:36-48`, `clients/mobile/ios/MomoPushKit/PushNotification.swift:227-247`, `server-rust/crates/momo-auth/src/push_fetch_token.rs:199-215` |
| 푸시 소비 | notifier가 `kind='push_candidate'`만 claim하고(claim이 `attempts`를 올려요) 후보 하나의 모든 대상을 한 번에 판정·발송해요. 미뤄 둔 대상이라는 개념이 없어요 | `server-rust/crates/momo-outbox/src/push.rs:125-155`, `server-rust/bins/momo-notifier/src/push.rs:131-190`·`:426-455` |
| relay 한도 | relay는 등록 서버마다 60초 슬라이딩 창으로 수락한 dispatch 수를 세고 기본 한도는 분당 60건이에요. notifier는 429를 일시 오류로 보고 후보 전체를 백오프로 다시 시도하는데 시도마다 `attempts`가 쌓여 기본 8번이면 `failed`로 접혀요(약 3분) | relay `server-rust/bins/momo-push-relay/src/rate_limit.rs:1-31`·`config.rs:150-156`, `momo-notifier/src/push_relay.rs:133-139`, ADR-0120 부록 A-8 「relay의 서버 단위 rate limit(D5-A)은 그대로」 |
| 푸시 깨움 | notifier의 LISTEN 깨움은 payload가 `push_candidate`일 때만 푸시 드레인을 깨워요 | `momo-notifier/src/lib.rs:1074` |
| outbox 점검 | `oort doctor`는 `done`이 아닌 outbox 행을 kind별로 세요. `push_candidate`는 relay가 구성돼 있으면 나이와 무관하게 FAIL이고 `agent_job`만 나이 기준이 있고 그 밖의 kind는 pending이 하나라도 있으면 FAIL이에요 | `scripts/lib/oort_doctor.sh:957-1059`, `scripts/tests/test_oort_doctor_outbox.sh` |
| 탭 착지 | 폰은 탭을 봉투의 `channelId`·`messageId`로 풀고 채널이 목록에 없으면 「대화가 없어졌거나…」를 말해요. category별 버튼은 `PUSH_CATEGORY_ACTIONS`가 등록해요 | `clients/mobile/src/push/tapArrival.ts:88-112`·`:137`, `categories.ts:75-83` |
| 발송 기록 | `push_dispatch_log.message_id`는 NULL을 허용하고 `(member, token, collapse_id)`가 유일해요. 그런데 `claim_dispatch`는 message id를 필수로 묶어요 | `001_init.sql:532-543`, `011_push_notifier.sql:71-73`, `server-rust/crates/momo-push/src/dispatch_log.rs:54-103` |
| relay 키 | relay 서명 키는 notifier만 가져요(드레인은 `MOMO_PUSH_NOTIFIER_ENABLED=1`일 때만 서요). api 프로세스에는 relay 클라이언트가 없어요 | `server-rust/bins/momo-notifier/src/config.rs:83-104`·`:328-330`, `bins/momo-server/src`·`momo-messaging/src`에 `PUSH_RELAY`·`PushRelay` 0건 |
| 데스크탑 배너 | 판정은 클라이언트가 해요. 일시 중지는 서버 값을 읽지만(#4197) 멘션 예외·종류 스위치·일정은 읽지 않아요. 종류 스위치는 이 기기 localStorage예요. 감시 채널은 비음소거 30개까지예요 | `packages/momo-core/src/features/notifications/model.ts:220`·`:240-258`, `clients/web/src/features/notifications/preference.ts:45-59`, `DesktopNotifications.tsx:57`·`:91-92` |
| 보고 있음 | `channel_viewing` 하트비트(15초 주기·30초 창)는 「질문자 팔」에만 쓰여요. 사람 멘션·DM에는 창이 없어요 | `server/Migrations/141_channel_viewing.sql`, `judgment.rs:375-400`, ADR-0204 D8(`:133-134`)·증보 3 |
| 데스크탑 활성 | 서버는 데스크탑이 지금 쓰이는지 몰라요 | `judgment.rs`의 입력에 없음 |
| 진단·시험 | 없어요. ADR-0204가 후속으로 남겼어요 | ADR-0204 D10(`:143-147`) |
| Time Sensitive | `interruption-level`을 서버·relay·앱 어디서도 안 넣고 앱 entitlement에도 없어요 | grep `interruption` 0건, `clients/mobile/ios/MomoMobile/MomoMobile.entitlements` |
| 표준 시간대 | `human.tz`는 가입 때 클라이언트가 보낸 값이고 IANA 이름인지 검증하지 않아요(길이 64 이하만) | `001_init.sql:67`, `server-rust/crates/momo-settings/src/join.rs:235-243` |
| 서버 소유 props | 클라이언트가 못 쓰는 props 키 목록이 한 곳이에요 | `server-rust/bins/momo-server/src/routes/messages.rs:97-111` |
| message INSERT | INSERT는 한 함수예요. 멘션은 REST 경로(`MentionPolicy::Record`)에서만 기록하고 에이전트 worker·gateway의 줄은 기록하지 않아요 | `server-rust/crates/momo-messaging/src/message.rs:494`·`:571`·`:602`·`:739`·`:824` |

## 리서치와 달라진 곳

코드를 다시 읽어 리서치·이슈의 문장과 달라진 것이에요. 모두 [권장]이고 PR 본문 표에 있어요.

1. **채널 단계는 새 표에 둬요.** 리서치는 `notification_pref.level` 컬럼을 제안했어요. 「행이 있으면 음소거」를 읽는 곳이 다섯이라(위 표) `all` 행이 하나만 있어도 음소거로 읽히고, 롤백한 서버도 그렇게 읽어요(D7).
2. **키워드 투영은 `props`가 아니라 별도 표에 둬요.** 리서치는 `props.keyword_member_ids`를 제안했어요. props는 채널 멤버가 모두 읽어서 남의 키워드를 알아낼 수 있어요. 투영 지점도 REST 한 곳이 아니라 둘이에요: 모든 보내기 경로와 스트림이 끝나는 쓰기(D3).
3. **시험 알림 피드는 `push_system`으로 일반화해요.** 이슈 #4341은 `push_test`예요. 메시지 행이 없는 푸시가 시험 알림·예약 실패(ADR-0208 D8)·다이제스트로 셋이라 한 길에 모아요(D15).
4. **발송 기록은 `message_id NULL`로 남겨요.** 리서치는 nil-UUID 센티널만 적었어요. 기록 FK와 `claim_dispatch`의 필수 인자를 풀어야 해요(D15).
5. **폰 채널 음소거 쓰기 길이 이미 있어요.** 리서치 H2(「쓰기 경로 없음」)는 낡았어요. 무기한 토글이 길게 누르기에 있어요. #4344의 「폰 신설」은 「폰 기한 선택」으로 줄어요(구현 슬라이스 표).
6. **사용자 알림음의 크기와 표본률**: 이슈의 「≤300KB」를 307,200바이트(300KiB)로 못박고, 표본률 상한 24kHz는 5초·300KiB 산술에서 나와요(D2). 리서치 P2-1E에는 있고 D2 요약에는 없었어요.
7. **일정의 기본 시간대는 `human.tz`가 아니에요.** 검증하지 않는 문자열이라서 클라이언트의 현재 시간대를 기본값으로 보내요(D13).
8. **어휘 증보는 한 번에 relay 먼저 내요.** 이유마다 relay를 따로 배포하면 호스티드 relay 배포가 네 번이에요(D14).
9. **D10은 이슈를 따라요.** 리서치 §6은 「성재 제작·선정」이었고 이슈 #4223·#4222는 성재 10-22 원문대로 planner 합성이에요.
10. **relay의 정적 문구는 reason별 표가 돼요.** 지금은 상수 한 쌍이에요(`dispatch.rs:300-301`). 시험·예약 실패 문구를 따로 실어야 해요(D14).

## 세 축과 불변식

한 줄의 설정이 세 가지를 한꺼번에 바꾸면 Buzz의 B6(소리 스위치가 배너까지 끔)이 생겨요. 설정을 세 축으로 갈라요.

| 축 | 묻는 것 | 판정하는 곳 | 입력 | 저장 |
|---|---|---|---|---|
| **전달** | 누구에게·무엇을·언제 보내나 | 폰 푸시는 **서버** judgment 한 곳(P9). 데스크탑·웹 배너는 클라이언트가 **서버 값을 입력으로** 판정해요(D17) | 일시 중지, 근무 시간, 채널 단계·음소거, 종류×표면 스위치, 키워드, 발신자 규칙, 데스크탑 활성 | (워크스페이스, 멤버) 서버 |
| **표면** | 어디에 나타나나 | 폰 푸시 / 데스크탑·웹 배너 / 배지 / 앱 안 | 종류×표면 표(D5) | 서버 동기 |
| **표현** | 어떻게 들리고 보이나 | 기기가 재생해요. 서버는 우선순위(D6)만 와이어에 실어요 | 소리 매핑, 사용자 파일, Time Sensitive | 서버 동기 JSON + 기기 캐시 |

배지(`mention_count`·unread)는 별개 원장이고 이 ADR이 건드리지 않아요(ADR-0124 D2).

**불변식**

- **I1** 표현은 전달을 끄지 않아요. 소리를 끄면 배너는 남고, 배너가 억제되면 소리도 없어요.
- **I2** 판정은 본문을 읽지 않아요. 키워드는 삽입 때 서버가 투영해요(D3).
- **I3** 와이어는 id-only이고 어휘는 닫혀 있어요. 새 reason·category는 relay 먼저 배포해요(D14).
- **I4** 설정은 (워크스페이스, 멤버) 단위예요. 계정 단위 새 테이블은 만들지 않아요(D9).
- **I5** 모든 migration은 「행 부재 = 오늘의 동작」이에요. 롤백한 서버는 새 설정을 몰라서 오늘의 동작으로 돌아가고, 알림이 **음소거로 둔갑해 사라지지는 않아요**. 예외는 새 기능이 스스로 만드는 동작뿐이에요: 새 웹·데스크탑이 활성 신호를 보내는 순간 D4의 기본 60초가 시작되고(구 클라이언트는 오늘과 같아요), 예약 실패 푸시(D15)가 새로 생겨요.
- **I6** 사용자가 멈춘 것은 멈춰요. 일시 중지가 가장 위이고 근무 시간 밖·채널 음소거가 그 아래예요. Time Sensitive·VIP·키워드는 일시 중지를 뚫지 못해요. 예외는 사용자가 직접 누른 시험 알림뿐이에요(D11).

### 종류 표 (전달 × 표면)

종류는 서버가 판정할 때 대상마다 붙이는 이름이에요(D5). 와이어 reason과 반드시 일대일은 아니에요.

| 종류(API) | 와이어 reason · category | 폰 기본 | 데스크탑 기본 | 지연(D4) | 폰 소리 키 |
|---|---|---|---|---|---|
| `dm` | `dm` · `momo.message` | 켬 | **끔**(성재 2026-10-02, `preference.ts:53`·`:56`) | 예 | `dm` |
| `mentionHuman` | `mention` · `momo.mention` | 켬 | 켬 | 예 | `mention` |
| `mentionAgent` | `mention` · `momo.mention` | 켬 | 켬 | 예 | `mention` |
| `agentAnswer` | `mention` · `momo.mention` | 켬 | 해당 없음 | 예 | `mention` |
| `approval` | `approval_request` · `momo.approval`(`.open`) | 켬 | 켬 | 아니오 | `approval_request` |
| `workDone` | `work_session_idle`·`work_run_done` · `momo.work` | 켬 | 켬 | 아니오 | `work` |
| `keyword` | `keyword` · `momo.mention` | 켬 | 해당 없음(폰 전용, 아래) | 예 | `keyword` |
| `channelAll` | `channel_message` · `momo.message` | 켬(단계가 `all`일 때만 의미) | 켬(단계가 `all`일 때만 의미) | 예 | `channel_message` |
| `threadReply`(증보 1) | `thread_reply` · `momo.message` | 켬 | 해당 없음(폰 전용, 증보 1 F5) | 예 | `thread_reply` |
| `scheduledFailed` | `scheduled_failed` · `momo.system` | 켬 | 해당 없음 | 아니오 | `system` |
| (이어받기) | `resume_offer` · `momo.work` | 항상 | 해당 없음 | 아니오 | `work` |
| (시험) | `test_notification` · `momo.system` | 누른 사람에게만(판정 우회) | 해당 없음 | 아니오 | `system` |

「행 부재 = 오늘」이에요. 위 기본값은 오늘 폰이 보내는 것(작업 끝남은 `work_complete_push` 기본 true, `115_work_complete_push.sql`)과 오늘 데스크탑이 띄우는 것(`preference.ts:49-59`)과 같아요. 새 종류 중 `keyword`·`channelAll`은 사람이 키워드를 넣거나 채널을 `all`로 바꿔야 의미가 생기고, `scheduledFailed`는 예약 메시지 기능(ADR-0208)의 새 푸시라 기본 켬이에요. `keyword`는 **폰 푸시 전용**이에요 [권장]. 데스크탑은 서버가 일치를 알려 줄 길이 없고(hit는 메시지 읽기 API·실시간 페이로드에 없어요) 클라이언트가 다시 맞추면 D17의 「서버가 모르는 규칙을 새로 두지 않아요」·D3의 「클라이언트 일치는 표시용」과 부딪혀서, 데스크탑 키워드 배너는 매칭을 `packages/momo-core`의 한 함수로 두는 증보가 먼저예요(D20).

## 결정

D1~D10은 이슈 #4223이 리서치 §6 권장안으로 확정한 것(성재 위임 2026-10-22 「결정 부탁드릴 것은 너가 권장으로 진행해봐.」, D4는 같은 날 성재에게 구체 설명)이고, 이 ADR이 계약으로 풀어 써요. D11 이후는 이 ADR이 [권장]으로 고른 기술 결정이에요.

### D1. 순서: 신뢰 복구 → 전달 세밀도와 표현 → 직접 넣기
1. **신뢰 복구**: 진단·시험 알림(D11, #4341·#4342), 채널 음소거 기한(D12, #4343·#4344), 푸시 어휘 증보(D14), 데스크탑 배너 판정 일원화(D17, #4197은 끝남·#4212가 후속).
2. **전달 세밀도와 표현**: 채널 단계(D7)·종류×표면(D5, D13)·키워드(D3)·근무 시간(D13)·데스크탑 활성 시 폰 지연(D4)·번들 소리와 매핑(D10, D18).
3. **직접 넣기와 관통**: 사용자 알림음 파일(D2, #4345)·VIP(D19)·규칙 빌더(ADR-0207, #4345)·Time Sensitive(D6).
- 이유: 파일 업로드는 번들 소리 경로(매핑·재생·NSE)를 그대로 써서 이 순서가 재작업 0이에요. 규칙 빌더는 키워드·일정·발신자 규칙이 먼저 있어야 해요. 「직접 넣어서」가 알림음인지 규칙인지 원문이 갈려서 둘 다 설계해 두고 순서만 정했어요.

### D2. 사용자 알림음 파일은 개인 전용이에요
- **범위**: 개인 전용이에요. 팀 공유 라이브러리는 만들지 않아요(불쾌한 소리가 팀에 퍼져요).
- **정본 형식**: WAV, PCM 16비트, 모노, **표본률 8000~24000Hz**, 길이 **5.0초 이하**, 파일 **307,200바이트(300KiB) 이하**, 멤버당 **20개 이하**예요. 표본률 상한은 산술에서 나와요: 24kHz × 2바이트 × 5초 = 240,000바이트라 300KiB 안에 5초가 들어가고 32kHz는 320,000바이트라 안 들어가요(산술이 허용하는 최대는 30.7kHz이고 24kHz는 그 아래의 표준 값이에요). 번들 소리(D10)는 이 규격과 별개예요.
- **저장** [권장]: PG `bytea`예요. id는 내용의 sha256이라 같은 파일은 한 행이에요. 소유자 범위 RLS FORCE(리마인더·예약과 같은 모양, `momo-messaging/src/owner_scope.rs`)로 워크스페이스 owner도 남의 파일을 못 읽어요. 삭제하면 이 소리를 가리키던 매핑은 기본음으로 퇴화하고, 멤버를 지우면 CASCADE예요.
- **검증**: 서버는 RIFF 헤더만 읽어요. `fmt `·`data` 청크만 허용하고 PCM(1)·모노·16비트·표본률 범위·길이·크기를 봐요. 디코더·ffmpeg는 서버에 두지 않아요(permissive 라이선스 규칙, 이미지 의존, 공격면). 변환(mp3·m4a·ogg → WAV)은 클라이언트가 해요(웹·데스크탑 Web Audio decode, iOS AVFoundation).
- **API 초안** [권장]: `PUT /v1/workspaces/{ws}/notification-sounds/{sha256}`(본문이 WAV 바이트이고 경로의 해시가 본문 해시와 다르면 400), `GET …/notification-sounds`(id·길이·크기·이름 목록), `GET …/notification-sounds/{sha256}`(`Content-Type: audio/wav`, `X-Content-Type-Options: nosniff`), `DELETE`예요. 사람 bearer만 써요(에이전트 403). 3단계라 openapi 초안에는 넣지 않고 #4345가 착수할 때 넣어요.
- **폰**: 앱이 받아서 App Group에 두고 NSE는 읽기만 해요(D18). 받기 전에는 기본음으로 와요(수용).
- **보안**: 신뢰할 수 없는 바이너리를 재생하는 것은 **본인 기기의 오디오 스택뿐**이에요(공유가 없어요). 서버는 헤더만 검증해요. 남는 위험: 본인 세션을 가로챈 공격자가 본인 기기에 이상한 WAV를 심을 수 있어요. 같은 세션으로 할 수 있는 다른 일보다 작아서 수용해요.

### D3. 키워드 알림이에요
- **와이어와 의미**(결재): 새 reason `keyword`(category `momo.mention`)예요. reason을 거짓으로 만들지 않아요(ADR-0120 A-6). `mention_count` 배지에는 더하지 않아요(멘션 배지의 뜻을 지켜요). **채널 음소거는 관통하는 것이 기본**이고 스위치(`keywordOverridesMute`)로 꺼요. 일시 중지·근무 시간 밖은 관통하지 못해요(I6). 사용자가 단어를 직접 넣은 것이라 소음 책임이 사용자에게 있어요(카카오톡 공식 동작과 같아요, [외부]).
- **저장** [권장]: `notification_keyword (workspace_id, member_id, keyword_norm, keyword, created_at)`, PK `(workspace_id, member_id, keyword_norm)`, 멤버당 **20개 이하**예요. 정규화는 NFKC → 소문자 → 앞뒤 공백 제거 → **2~32글자**예요. 이미 직접 의존인 `unicode-normalization`(`server-rust/Cargo.toml:83`, 선례 `momo-messaging/src/name_guard.rs:138`)을 써서 새 의존이 없어요. 매치는 **부분 문자열**·대소문자 무시예요(한국어는 띄어쓰기로 단어를 못 잘라요).
- **투영(삽입 때 서버가 풀어요)** [권장]: 별도 표 `message_keyword_hit (workspace_id, message_id, member_id)`, PK `(message_id, member_id)`, 메시지가 지워지면 CASCADE예요. 판정은 본문 대신 이 표를 `EXISTS`로 읽어요(I2).
  - **`message.props`에 두지 않아요.** props는 채널 멤버가 메시지 읽기·실시간 페이로드로 모두 받아요(멘션 목록도 그렇게 공개돼요, `messages.rs:97-111`가 클라이언트 쓰기만 막아요). 거기에 「누구의 키워드가 걸렸나」를 넣으면 다른 멤버가 메시지를 보내 보며 남의 키워드를 알아낼 수 있어요. 별도 표는 메시지 읽기 API가 건드리지 않고, 걸러야 할 클라이언트 입력도 없어요.
  - **투영 지점은 둘이에요**(멘션은 REST 한 곳에서만 기록해서 에이전트 줄이 빠져요). ① `finish_send_in_tx`(`message.rs:571`)에서 멘션 기록(`:602`) 옆에, 멘션 정책(Record/Skip)과 무관하게 모든 보내기 경로(REST·에이전트 worker·gateway·예약 전송)가 한 번 지나가게 하되, 서버가 쓴 고정 문구는 호출 쪽이 건너뛰어요(아래). ② 스트림이 끝나는 쓰기(`stream_message_body_in_tx`, `interaction.rs:928`)에서 **끝난 본문**으로 투영해요. 스트림 줄은 열려 있는 동안(첫 조각만 있어요) 투영하지 않고, 닫힐 때 투영한 뒤 같은 tx가 넣는 두 번째 후보로 판정해요(ADR-0204 증보 1 D8-a). 편집은 재투영하지 않아요(멘션과 같아요).
  - **대상**: 채널의 활성 사람 멤버 중 작성자가 아닌 사람(`left_at IS NULL`·`status='active'`)이에요. `type='text'`이고 본문이 비지 않은 메시지만, 재시도로 겹친 보내기(`deduped`)와 DM 채널(`dm` reason이 이미 있어요)은 빼요.
  - **에이전트 발화도 포함해요.** 에이전트가 1급 멤버이고 키워드의 주 쓰임이 「에이전트가 '배포 실패'라고 쓰면 알려줘」예요. `tool_call` 같은 진행 줄은 `type`이 달라 빠져요.
  - **투영 대상은 `type='text'` 줄이고, 서버가 쓴 고정 문구는 호출 쪽이 건너뛰어요** [권장]: notifier가 쓰는 두 줄은 승인 만료(`MessageType::ToolResult`, `bins/momo-notifier/src/approval_sweep.rs:246`)와 멈춤 줄(`MessageType::System`, `run_stall_sweep.rs:347`)이라 `Text`가 아니어서 투영 대상이 아니에요(멘션 기록이 `Text`만 거르는 것과 같은 모양, `message.rs:602`). 호출 쪽 결정(입력 구조체의 플래그나 별도 진입점은 구현이 정해요)은 `Text`로 쓰는 서버 문구를 위한 안전장치예요: notifier가 그런 줄을 쓰는 날에도 BYPASSRLS 역할인 notifier에 키워드 표의 권한이 생기지 않게 해요. 멘션 정책 Record/Skip과는 별개예요(에이전트 worker와 notifier가 같은 `send_message_in_tx`를 불러서 그 값만으로는 가를 수 없어요). `send_thread_notice_in_tx`는 호출별로 정해요(서버 안내를 쓰기도 하고 멤버가 쓴 지시문을 쓰기도 해요, `routes/work_instructions.rs:474-485`). **타입·플래그 검사는 키워드 표를 읽기 전에** 해요(notifier 역할은 `notification_keyword`에 권한이 없어서 먼저 읽으면 `permission denied`예요). 에이전트 worker(`momo_worker`, BYPASSRLS)가 쓰는 에이전트의 말은 투영해요. 그 INSERT는 AGENTS.md가 유지하는 agent-worker의 기존 예외(메시지 INSERT)와 같은 tx·같은 연결에서 일어나고, 투영 SQL은 `workspace_id` 술어를 명시해요(BYPASSRLS 연결에서는 GUC가 보호가 아니에요).
  - **비용 상한** [권장]: 투영은 보내기 tx 안에서 돌고 그 tx는 채널 행 잠금(`channel_seq` UPDATE, `message.rs:505-519`)을 `finish_send_in_tx`가 끝날 때까지 쥐어요. 본문 상한은 요청 크기 2 MiB뿐이고 멤버 단위 속도 제한이 없어서(ADR-0208 D10·보안 절) 본문 전체를 훑으면 비용이 (고유 패턴 수) × 본문 길이로 커질 수 있어요. 그래서 ① 매치 대상은 원문의 **앞 4,000 유니코드 스칼라**예요(자른 **뒤에** 정규화해요. 그 뒤에 있는 키워드는 못 맞춰요. 키워드 화면이 이 한계를 알려요) ② 채널 안에서 같은 패턴은 **한 번만** 검사하고 일치하면 그 패턴을 가진 멤버마다 hit를 써요. 상수(4,000)는 한 곳에 두고 시험이 값을 단정해요. **패턴 수에는 일부러 상한을 두지 않아요.** 상한을 두고 넘으면 건너뛰는 설계는 키워드 알림이 사용자도 진단도 모르게 사라져서, 이 ADR이 풀겠다는 「왜 안 오는지 모르는」 문제(B1)를 새로 만들어요. 자연 상한은 멤버당 20개 × 채널 활성 멤버 수예요. 잠금 보유 시간은 수용 기준 18이 두 규모(활성 100명 × 20개, 1,000명 × 20개)와 최악 본문으로 재서 PR 본문에 적어요. 목표(5ms)를 넘는 규모가 나오면 조용히 건너뛰는 대신 **쓸 때 거절하는 공개 상한**(워크스페이스 단위, 409로 보이는 상한)을 증보로 먼저 정해요.
- **판정**: 새 arm `keyword`가 에이전트의 답 arm 아래, `channel_message` 위에 와요(작업·승인 > 멘션 > DM > 에이전트의 답 > `keyword` > `channel_message`). 작성자 제외는 멤버 조인이 이미 해요(`judgment.rs:413-416`).
- **하이라이트**(키워드 화면, 슬라이스 N6)는 클라이언트가 같은 정규화로 **표시용**으로만 맞춰 봐요(권위 없음). 화면은 「메시지 앞 4,000글자까지만 찾아요」도 알려요.
- **사생활** [권장]: 키워드는 서버에 평문으로 저장돼요(부분 문자열 매치에 필요해요). 감사 로그에는 개수만 남기고 문구는 props·감사·로그 어디에도 남기지 않아요. `notification_keyword`는 키워드 API와 투영 모듈만 읽어요(정적 시험). 화면은 「서버에 저장돼요」를 알려요.
- **받는 쪽 권한** [권장]: 투영은 보내는 사람의 tx에서 같은 채널 멤버들의 키워드를 읽어요. 그래서 `notification_keyword`는 워크스페이스 범위 RLS(`ws_isolation`)이고 소유자 범위가 아니에요. `momo_app` 자격이 SQL 수준으로 새면 키워드가 드러나는 위험은 워크스페이스 범위 RLS 표(메시지 본문 포함)와 같은 신뢰 수준이라 수용해요.

### D4. 데스크탑이 쓰이는 중이면 폰 푸시를 늦춰요: C(지연)
- **결재(이슈 #4223)**: A(적용 안 함, 현행) · B(억제, Buzz 초안: 재전송 없음) · C(지연, Slack: 안 읽으면 발송) 중 **C**예요. 승인 요청·작업 끝남은 지연 없음, 신호를 안 보내는 구 클라이언트는 현행이에요. B는 자리를 비운 사람이 놓치고(Buzz도 인정), C는 결국 도착해요.
- **ADR-0204 D8의 부분 번복이에요.** D8은 「사람 멘션·DM에는 이 창을 적용하지 않는다(현행 그대로)」(`0204`의 D8, 기준 커밋 `:134`)로 정했어요. 이 결정은 (a) 멤버의 데스크탑·웹이 활성 신호를 보내고 있고 (b) 받는 토큰이 폰(`device.platform='ios'`)이고 (c) 멤버 설정의 지연이 0보다 클 때에 한해 사람 멘션·DM에도 지연과 읽음 취소를 적용해요. 신호가 없으면(구 클라이언트·폰만 쓰는 사람) D8의 문장은 그대로 유효해요. D8-a·증보 3(`channel_viewing` 30초 창)·「에이전트의 답」 arm의 30초 창은 그대로예요. 창이 먼저 대상을 거르고(NULL), 창을 통과한 대상에 지연이 얹혀요.
- **신호**: `PUT /v1/workspaces/{ws}/presence/activity`(본문 없음, 204)예요. 소유자는 항상 bearer이고 다른 멤버가 읽는 API는 없어요. 사람 bearer만 써요(에이전트 403).
  - 웹·데스크탑이 「활성」인 동안 **20초 이하** 주기로 보내요. 활성 [권장]: 창이 앞에 있고 마지막 사용자 입력이 5분 이내예요. 잠금·절전·종료면 보내지 않아요. 폰은 보내지 않아요(앞에 있는 폰 앱은 OS가 배너를 안 내요, #2592·#4310).
  - 서버는 **30초** 안의 신호를 「활성」으로 읽어요. 마지막 값이 5초보다 어리면 행을 다시 쓰지 않아요(쓰기 상한, `channel_viewing`과 같아요: `momo-messaging/src/channel_viewing.rs:19-71`).
  - 저장 [권장]: 새 표 `member_activity (workspace_id, member_id, seen_at)`, PK `(workspace_id, member_id)`, RLS ENABLE+FORCE `ws_isolation`, 트리거·아웃박스·브로드캐스트 없음이에요. `momo_app`이 쓰고 `momo_notifier`는 SELECT만 해요(`bootstrap_runtime_roles.sql`의 `channel_viewing` 줄(`:507-508`)과 같은 GRANT를 더하고 역할 권한 시험의 `column_reads`·표 목록에도 올려요).
  - 서버가 아는 것은 「이 사람의 마지막 활동 시각」 하나예요. 다른 멤버에게 보이지 않아요. 행은 (워크스페이스, 멤버)당 하나라 정리 작업이 없어요.
  - 새 클라이언트가 옛 서버를 만나면(404·405) 그 서버로는 다시 보내지 않아요(`viewingBeat.ts`와 같아요, 호환 표).
- **지연 대상** [권장]: 와이어 reason이 `mention`·`dm`·`channel_message`·`keyword`(증보 1: `thread_reply`도)인 폰 대상이에요(이슈의 「사람 멘션·DM·channel_message·keyword」보다 넓어요: reason이 하나라서 `mention`에는 에이전트의 멘션과 「에이전트의 답」 arm도 들어가요). `approval_request`·`work_*`·`resume_offer`·`scheduled_failed`·`test_notification`은 지연하지 않아요.
- **멤버 설정** [권장]: `phoneDelaySecs` ∈ {0, 60, 300}이고 기본 60이에요(「기본 1분」은 이슈 결재, 선택지는 권장). 0이면 지연도 읽음 취소도 없어요(= 오늘).
- **판정**(후단, D16): SQL이 reason과 대상을 고른 뒤 Rust 후단이 멤버 id 목록으로 한 번 조회해 활동 신호와 읽음 커서를 읽고 대상을 셋으로 나눠요.
  1. **취소**: 활동 `seen_at >= T − 30초`이고 그 채널 `read_state.last_read_seq >= message.seq`이면 푸시도 기록도 없어요(읽었다는 뜻이에요. 첫 판정이든 재판정이든 같아요). 취소는 `T` 기준이고 아래 보류는 지금 기준인 것은 의도예요. 읽었으면 그 뒤에 자리를 비워도 푸시가 필요 없고, 보류는 지금 활동 중일 때만 걸려요.
  2. **보류**: 활동 `seen_at >= now() − 30초`이고 읽지 않았고 `now() < T + 지연`이면 이번엔 보내지 않아요. 기록도 남기지 않아요(억제와 같아요).
  3. **발송**: 그 밖에는 지금 보내요(오늘과 같아요). 만기 뒤 재판정은 활동을 다시 보지 않으므로 **한 번만** 지연돼요.
  - **`T`** 는 그 대상을 처음 판정한 후보 행(outbox)의 `created_at`이에요. 일반 줄과 DM·명시 멘션 arm은 삽입 시각이에요(DM·명시 멘션 arm은 스트림을 보류하지 않아 첫 후보가 판정하고, 닫힘이 만드는 둘째 후보는 `claim_dispatch`가 중복을 막아요). 스트림을 보류하는 arm(에이전트의 답·`keyword`·`channel_message`)은 닫힌 시각, 곧 둘째 후보가 만들어진 때예요. 그래서 오래 이어진 스트림도 닫힌 때부터 세요(ADR-0204 증보 1 D8-a가 창을 닫힌 시각 기준으로 읽는 것과 같아요).
- **재판정이 걸러야 하는 것** [권장]: 삭제된 메시지(`message.state='deleted'`)·보관된 채널·나간 멤버는 어느 판정(재판정 포함)에서도 대상이 아니에요. 보류가 길어서(최대 300초) 그 사이 보낸 사람이 메시지를 지우면 NSE가 본문을 못 찾아 「새 알림」 자리표시만 떠요. 지금의 `msg` CTE는 삭제 여부를 보지 않아요(`judgment.rs:250-280`). 새 조건으로 더해요.
- **후보 처리**: 후보 하나의 대상 중 보류가 있으면 후보를 `defer`해요. `status='pending'`, `available_at = 가장 이른 만기`, 그리고 **`attempts`를 claim 이전으로 되돌려요**(`GREATEST(attempts − 1, 0)`). claim이 `attempts`를 올려요(`momo-outbox/src/push.rs:139-141`). 예산 비교(`attempts >= max_attempts`)는 일시 오류가 났을 때의 `requeue_candidate` 안에만 있어서(`momo-notifier/src/push.rs:432`, 기본 8은 notifier `config.rs:344`) 지연 자체가 후보를 `failed`로 만들지는 않아요. 하지만 되돌리지 않으면 지연 횟수(많아야 2번)만큼 재시도 예산이 미리 쓰여서, 지연 뒤에 일시 오류(relay 429 등)가 나면 후보가 그만큼 일찍 `failed`로 접혀요.
  - 같은 후보에 **다시 시도하는 대상의 일시 오류가 하나라도 있으면**(예: 승인·멘션·DM 대상의 relay 429) 기존 `requeue_candidate`(백오프, `attempts` 그대로, `push.rs:171-189`)가 이기고 `defer`는 하지 않아요. 대량 층(`channel_message`·`keyword`)의 429는 여기서 말하는 일시 오류가 아니에요. 재시도 없이 끝난 대상이라 후보를 다시 잡게 만들지 않아요(D7). `available_at`은 백오프와 가장 이른 만기 중 이른 값이에요. 다시 잡힌 후보는 이미 보낸 대상을 `claim_dispatch`의 유일 인덱스로 건너뛰고, 보류 대상은 만기가 되면 위 판정을 다시 받아요.
  - 만기가 다른 대상이 남으면 한 번 더 `defer`해요(지연 있는 값이 60·300 둘뿐이라 후보당 많아야 2번이에요).
- **시계**: 만기는 `T + phoneDelaySecs`예요(판정 시각이 아니에요). notifier가 밀려도 만기는 밀리지 않고, 만기 뒤에 처리되면 읽음만 확인하고 바로 보내요.
- **운영 점검** [권장]: `available_at`이 미래인 `pending` 후보는 지연의 정상 상태예요. `oort doctor`의 outbox 점검이 이를 FAIL로 세지 않게 고쳐요(D15의 doctor 항목과 같은 곳이에요). 한계: 일시 오류 백오프 중인 행도 `available_at`이 미래라 같이 건강으로 보여서, relay 장애는 `failed`로 접힌 뒤에야 doctor에 보여요(지연 행만 가르는 표식은 구현이 정해요).
- **relay 예산**: 만기에 풀린 푸시도 relay의 서버 단위 한도를 같이 써요(D7). 한도에 닿으면 승인·멘션·DM은 기존대로 429에 백오프로 다시 시도하고, 대량 층(`channel_message`·`keyword`)은 D7대로 다시 시도하지 않아요.
- **받아들이는 근사**: 자리를 비운 사람은 최대 지연만큼 늦게 받아요(Slack도 같아요). 활동 신호는 시선이 아니라 입력 기반 근사예요. 만기 재판정에서 일시 중지·음소거가 그 사이 바뀌었으면 바뀐 값을 따라서 보류가 억제를 우회하지 못해요. **한계**: NSE는 채널의 최근 200건 안에서만 대상 메시지를 찾아요(`PushNotification.swift:407`·`:432-440`). 지연(최대 300초) 동안 채널에 200건 넘게 쌓이면 푸시는 오지만 본문 없는 「새 알림」 자리표시예요 `[추정]`(에이전트가 줄 단위로 쓰는 채널에서 닿을 수 있어요). NSE가 id로 단건을 읽게 하는 것은 `push_fetch` 읽기 경로 변경(ADR-0188 §8.7)이라 이 ADR 밖이고 측정 뒤 별도 증보로 판단해요(남는 위험 13).
- **측정**: `push_dispatch_log`에는 활동 상태가 없어요. notifier가 보류·취소·보류 뒤 발송을 로그 카운터로 남겨요. 「데스크탑 활성 중 폰 푸시 50% 이상 감소」는 가설이에요 [추정].

### D5. 「항상 오는 알림」을 종류별로 끌 수 있어요
- **결재(이슈 #4223)**: 종류별 끄기를 허용하고, 승인은 끌 때 명시 경고와 대기 승인 표시를 두고, 승인 끄기는 폰 표면에서만 허용해요.
- **종류(닫힌 집합, 9개. 증보 1이 `threadReply`를 더해 10개)** [권장]: `dm`·`mentionHuman`·`mentionAgent`·`agentAnswer`·`approval`·`workDone`·`keyword`·`channelAll`·`scheduledFailed` × 표면 `phone`·`desktop`이에요(`agentAnswer`·`keyword`·`scheduledFailed`는 `phone`만, 종류 표). 판정 SQL이 대상마다 종류를 붙여요. 명시 멘션은 작성자 종류로 `mentionHuman`/`mentionAgent`, 「에이전트의 답」 arm은 `agentAnswer`예요(`judgment.rs:273-274`가 이미 `author_kind`를 읽어요). 승인·멘션·DM을 포함해 모두 끌 수 있어요.
- **스위치는 arm 조건의 일부예요** [권장]: 꺼진 종류의 arm은 일치하지 않은 것으로 보지만 **내려가는 곳은 한정**해요(D16 판정 순서 2단계). 같은 메시지가 여러 이유로 설 수 있는 arm(`mentionHuman`·`mentionAgent`·`agentAnswer`·`keyword`)만, 꺼지면 아래 arm으로 내려가요(arm 순서는 D16 표예요. 예를 들어 `mentionHuman`을 끈 사람의 메시지가 키워드에도 걸리고 `keyword`가 켜져 있으면 `keyword`로 가요). **메시지 모양이 정하는 arm**(작업 셋, `approval`, DM 채널의 `dm`)은 꺼지면 내려가지 않고 **억제**예요(오늘의 `work_complete_push` 끄기와 같은 방식, `judgment.rs:467-468`). 그래서 DM 채널(에이전트와 1:1)의 승인 카드는 `approval.phone`을 끄면 `dm` 푸시로 되살아나지 않고(승인 category와 버튼이 붙은 채 오는 일도 없어요), `workDone`을 끄면 DM의 에이전트 답이 `dm`으로 되살아나지 않으며, `dm`을 끄면 그 채널의 에이전트 답도 같이 조용해요. 아무 arm도 켜져 있지 않으면 reason이 없고 푸시도 없어요.
- **승인 푸시를 끄는 쓰기에는 확인 토큰이 필요해요** [권장]: `approval.phone`을 `true`에서 `false`로 바꾸는 PATCH에 `confirm: ["approval_push_off"]`가 없으면 400 `confirmation_required`예요(이미 꺼진 값을 다시 쓰는 것은 확인이 필요 없어요). 응답에 `warnings: ["approval_push_off"]`를 싣고 감사 `notification_prefs.approval_push_off`를 남겨요. 이 토큰은 보안 장치가 아니라 **확인 단계를 빼먹은 클라이언트의 실수를 막는 프로토콜 수준의 가드**예요(사람 bearer를 가진 어느 클라이언트든 고정 문자열을 보낼 수 있어요). 승인은 1시간 만료이고 15일 0건 사고(ADR-0204)가 있었으니, 끄는 길이 경고 문구를 거치도록 서버가 확인을 요구해요.
- **끄는 조작은 폰의 알림 설정에만 있어요**(이슈의 「폰 표면에서만」을 이렇게 읽어요 [권장]). 웹·데스크탑은 그 칸을 읽기 전용으로 보이고 「폰에서 바꿀 수 있어요」로 안내해요. 서버는 PATCH의 출처를 보지 않아서 이것은 UI 규칙이에요. `desktop` 표면의 승인 배너 스위치는 지금처럼 이 기기에서 끌 수 있고(서버로 동기돼요) 확인 규칙은 폰 푸시에만 적용돼요.
- **상시 표시** [권장]: `approval.phone`이 꺼져 있는 동안은(일시 중지 여부와 무관하게) 폰 인박스와 알림 설정에 「승인 알림이 꺼져 있어요 · 승인 N건이 기다려요」 한 줄을 보여요(인박스 투영 ADR-0199, #4342). 15일 푸시 0건 사고와 같은 모양을 막는 보완책이에요. 일시 중지 중의 「승인 N건이 기다려요」는 #4342가 그대로 해요.
- **`workDone.phone`은 기존 `notification_rule.work_complete_push`와 같은 값이에요**(별칭이고 저장은 한 곳). `PATCH …/notification-rules/push-kinds`는 그대로 남아요(`lib.rs:987-989`).
- 기본값은 종류 표예요(「행 부재 = 오늘」). 저장은 D13이에요.

### D6. 승인 Time Sensitive는 첫 실행 안내에서 묻고 기본은 꺼요
- **결재(이슈 #4223)**: 첫 실행 안내에서 묻고 기본 끔이에요. capability 추가는 owner Apple 작업이고 증거 빌드 승인이 필요해서 별도예요.
- 켜면 relay가 `aps.interruption-level = "time-sensitive"`를 싣는 **선택 키 `priority`**(`normal`/`time_sensitive`)를 더해요 [권장, 와이어 어휘예요](relay 먼저, D14). 승인 요청 reason이고 사용자가 켰을 때(`approvalTimeSensitive = true`)만이에요. `priority`는 판정을 통과한 푸시의 **표현**만 바꿔요. 일시 중지·근무 시간 밖은 그대로 우선이에요(I6).
- Apple HIG는 「지금 또는 한 시간 안의 일」·정직한 긴급도만 허용하고 사용자가 앱 단위로 끌 수 있어요 [외부]. 승인은 1시간에 만료돼서 맞아요. Critical Alerts는 쓰지 않아요(신청·승인이 필요하고 DND·무음을 뚫어 메신저에 맞지 않아요).
- capability 「Time Sensitive Notifications」 추가와 프로비저닝 갱신은 owner 작업이에요(이 ADR 밖). 구 relay는 새 키에 400을 돌려주고(어휘 증보와 같은 relay 먼저), 구 앱은 영향이 없어요.

### D7. 채널 「모든 새 글」 단계를 도입해요(분당 6건 묶음, 에이전트 많은 채널 경고)
- **결재(이슈 #4223)**: 도입이에요. 기본은 오늘의 동작(= 멘션만)이에요.
- **단계**: `all`(모든 새 글) · `mentions`(멘션만, 기본) · `none`(끔, 기존 음소거)이에요. DM 채널은 이미 모든 메시지가 `dm` reason이라(`judgment.rs:374`) `none`·`mentions`만 받아요(`all`은 400 `level_not_applicable`).
- **저장** [권장]: 새 표 `notification_channel_level (workspace_id, member_id, channel_id, level, updated_at)`, PK `(workspace_id, member_id, channel_id)`, `level text NOT NULL CHECK (level = 'all')`예요(`mentions`는 행이 없는 것), RLS ENABLE+FORCE `ws_isolation`이에요. **`notification_pref`는 음소거 원장 그대로** 두어요(행이 있으면 음소거, 기한 포함).
  - 리서치의 `notification_pref.level` 컬럼 안은 기각해요. 「행이 있으면 음소거」를 가정하는 읽는 곳이 다섯이라(`momo-push/src/judgment.rs:469-473`, `momo-messaging/src/`의 `dm.rs:244`·`:309`, `channel.rs:658`, `inbox.rs:221`) `all` 행이 하나만 있어도 음소거로 읽혀요. 롤백한 서버도 같아서, 사용자의 `all` 선택이 **음소거로 둔갑**해 알림이 사라져요(ADR-0124 증보 2 D9가 롤백에서 해제 쓰기를 지키려 CHECK를 뺀 것과 같은 주의예요). 새 표는 구 서버가 모르는 행이라 `mentions`로 떨어질 뿐이에요.
- **효과 단계(읽기 모델)**: 음소거 행이 진행 중(`muted_until IS NULL OR > now()`)이면 `none`, 아니면 단계 행이 있으면 `all`, 아니면 `mentions`예요. 음소거는 단계 **위의 덮개**라서 기한이 지난 음소거(「1시간만 끄기」)는 이전 단계로 돌아가요.
- **쓰기**(`PUT …/channels/{ch}/notification-pref`, 본문은 D12):

  | 본문 | 음소거 행 | 단계 행 |
  |---|---|---|
  | `{level:"all"}` | 지움 | 만듦 |
  | `{level:"mentions"}` | 지움 | 지움 |
  | `{level:"none", mutedUntilMs?}` | 만듦(기한 없으면 NULL) | **그대로** |
  | `{muted:true, mutedUntilMs?}`(구 본문) | `{level:"none"}`과 같아요 | 그대로 |
  | `{muted:false}`(구 본문) | 지움 | **그대로** |

  구 클라이언트의 `muted` 쓰기는 음소거 층만 건드려요. 그래서 `all`을 고른 사람이 구 앱에서 음소거를 풀어도 `all`이 지워지지 않아요.
- **판정**: 새 arm `channel_message`예요. 단계 행이 있고, 채널이 `dm`이 아니고, 메시지가 `type='text'`·최상위(`root_id IS NULL`)이고, 스트리밍 중이 아니고(열린 동안 보류, 닫힐 때 두 번째 후보로 판정), 「보고 있음」이 아닐 때(`read_state.last_read_at` 30초 창 또는 `channel_viewing` 30초 창, 질문자 arm과 같은 OR, `judgment.rs:375-400`)예요. 본인 글은 멤버 조인이 이미 빼요(`judgment.rs:413-416`). 스레드 답·`tool_call` 같은 진행 줄은 대상이 아니에요.
  - 교차 참조(ADR-0148 증보 2026-10-31, #4887): 위 「최상위(`root_id IS NULL`)」는 「최상위, 또는 「대화에도 보내기」를 고른 답글(`message.also_in_channel`)」로 읽어요. 켠 답글은 이 arm의 대상이고 끈 답글은 지금처럼 대상이 아니에요.
- **억제 우선순위**: D16 판정 순서 표예요.
- **폭주 상한(대량 층)** [권장]: 대량 층은 메시지마다 한 건씩 나올 수 있는 원천인 `channel_message`와 `keyword`예요(증보 1이 `thread_reply`를 같은 층에 더해요. 그 창 키는 (멤버, 스레드 루트)예요). (멤버, 채널)당 60초 창에 대량 층 푸시는 개별 **6건**까지이고, 그 창의 7번째부터는 **합쳐서 1건**이에요. 대표 한 건의 collapse id(`o:<channel_id>:<창 번호>`)로 `claim_dispatch`의 유일 인덱스가 나머지를 건너뛰어요. 개별 푸시의 collapse id는 기존 `m:<message_id>` 그대로예요(`dispatch.rs:160`). 창은 **notifier 프로세스 메모리**에서 세요(DB 집계도 색인도 없어요). notifier가 한 인스턴스라고 가정하고, 여러 인스턴스면 상한이 인스턴스 수만큼 느슨해져요(relay 한도가 마지막 방어선이에요, 남는 위험 15). **순서**: ① 이미 정산된 `m:<message_id>`가 있는지 **읽기만** 해서 있으면 건너뛰고 ② 창·예산을 판정한 뒤 ③ 고른 collapse id(`m:` 또는 `o:`)로 `claim_dispatch`해요. 접힌 건과 예산 초과 건은 `claim_dispatch` 전에 갈려서 `m:` 행(정산 전 NULL 행)이 남지 않고, 그래서 재판정(requeue·스트림 둘째 후보)이 이미 나간 개별 푸시를 묶음으로 다시 세지 않아요. 단위: 개별 6건은 멤버에게 가는 메시지 단위예요(토큰이 여럿이면 토큰마다 디스패치가 있어요). 창 번호는 고정 1분(epoch 분)이라 경계에서 6 + 6이 나갈 수 있어요(수용). 대표 한 건이 relay 429로 드롭되면 그 창의 나머지는 `AlreadySettled`로 사라져요(best-effort 수용). 시험이 「20건 → 7건」을 고정해요.
- **묶음이 보여 주는 것** [권장]: 대표 한 건은 그 메시지의 이름·본문이 아니라 정적 문구 「새 글이 여러 개 있어요」예요. 새 NSE는 봉투의 `collapse_id`가 `o:` 접두이면 메시지를 가져오지 않고 이 문구를 써요(상수 문구라 id-only가 유지돼요, D18). `o:`를 모르는 앱(N0는 받았지만 N10 전)은 그 메시지 한 건을 평소처럼 보여요.
- **relay 서버 예산** [권장]: relay는 등록 서버마다 분당 한도(기본 60건)로 수락한 dispatch를 세요(맥락 표). 대량 층은 원천이 커서 같은 한도를 먹어 승인·멘션·DM을 굶길 수 있어요. 그래서 (a) 대량 층(`channel_message`·`keyword`)은 서버 전체에서 분당 `NOTIFIER_BULK_PUSH_PER_MINUTE`(기본 relay 기본 한도의 절반인 30)까지만 보내고 넘는 푸시는 보내지 않고 done으로 끝내요(앱 안에는 그대로 남아요. 선착순이라 한 채널이 예산을 다 쓸 수 있어요, 남는 위험 15), (b) 대량 층이 relay 429를 받으면 다시 시도하지 않아요(best-effort 층: 재시도 예산·백오프 대기열을 먹지 않아요). 드롭한 행은 `apns_status=429`·`apns_reason='relay_http: dropped'`로 정산해서 재배달이 다시 보내지 않게 하고(`settle_relay_refusal` 모양), 진단(D11)의 두 질의는 이 행을 건너뛰어요. 세는 방법은 위 폭주 상한과 같은 notifier 프로세스 창이에요. 합침·예산 초과·429 드롭은 reason과 사유(창·예산·429)별 **로그 카운터**로 세요(남는 위험 15의 「운영 지표」가 이 카운터예요). 승인·멘션·DM·작업 끝남·예약 실패(D15)는 기존대로 429에 백오프로 다시 시도해요.
- **경고**: 에이전트가 많이 말하는 채널을 `all`로 고르면 화면이 경고 문구를 보여요(P8, Buzz B4). 사이드바 점·배지의 뜻은 바뀌지 않아요.

### D8. ADR 구조는 새 ADR-0206 하나예요(규칙 빌더는 ADR-0207)
- 세 ADR(0120·0124·0204)에 흩으면 관계가 읽히지 않아요. 옛 ADR 머리에 포인터 한 줄을 달았어요. 규칙 빌더의 스키마·평가기는 ADR-0207이고(#4345 착수 때), 이 ADR은 그 경계(D16)만 정해요.

### D9. 설정 저장 범위는 (워크스페이스, 멤버)예요
- 계정 단위 새 테이블은 새 테넌트 경계라 RLS·ADR 비용이 커서 만들지 않아요. 사람은 워크스페이스마다 별도 `member`·`device`예요(`001_init.sql:61-70`).
- 여러 워크스페이스에 같은 설정을 쓰는 사람은 클라이언트의 「모든 워크스페이스에 적용」이 속한 워크스페이스마다 같은 PATCH를 보내요. 서버는 모르고, 부분 실패는 워크스페이스별로 알려요.

### D10. 번들 소리는 planner 자체 합성이에요
- **결재(성재 2026-10-22)**: 「기본 알림음은 너가 뭐 오픈소스같은걸로 만들거나 알림음을 찾아봐봐.」 → 리서치 §6의 「성재 제작·선정」을 planner 합성으로 바꿔요(#4222).
- **규격**: WAV PCM16 모노 44.1kHz, 1.5초 이하, 각 300KB 이하예요. 생성 스크립트를 커밋하고(같은 입력이면 같은 바이트), 산출 WAV를 소스 자산으로 커밋하고(빌드 산출물이 아니라 제품 자산이에요. AGENTS.md의 「빌드 산출물 커밋 금지」에 해당하지 않고, 시험이 스크립트로 다시 만들어 바이트를 대조해요), NOTICE에 출처 한 줄을 남겨요. 합성이 마음에 안 들면 CC0만 쓰고(재배포 제한이 있는 무료 라이선스 금지) 원문을 NOTICE에 남겨요. 생산은 #4222예요.
- **소리 슬롯 어휘(닫힌 집합)** [권장]: `oort.message`·`oort.mention`·`oort.dm`·`oort.approval`·`oort.work`와 기본 메시지 후보 `oort.message.b`·`oort.message.c`예요(후보 수는 #4222가 정해요). 목록을 바꾸면 이 ADR 증보예요. 사용자 파일은 `user:<sha256>`(D2)예요.
- **종류별 기본 소리는 서로 달라요**(DM·멘션·승인·작업 끝남). 「기본값이 전부 같다」(Buzz B7)를 피해요. `keyword`의 기본은 `oort.mention`, `channelAll`의 기본은 `oort.message`예요.
- 소리 선택 UI·폰 소리 교체·사용자 파일은 이 ADR 뒤예요(#4222 「범위 밖」).

### D11. 진단과 시험 알림이에요 (ADR-0204 D10 이행) [권장]
- **두 갈래**: 서버가 아는 코드는 `GET`이 돌려주고, 기기만 아는 코드(OS 권한 거부 #2684, 이 기기 스위치 꺼짐, 집중 모드는 앱이 알 수 없다는 안내)는 클라이언트가 판정해요(#4342). 서버 기록으로는 기기 쪽을 가를 수 없었어요(#4295).
- **`GET /v1/workspaces/{ws}/notification-diagnostics?channelId=&kind=`**: 응답은 `{checkedAtMs, ok, blockers[], devices{active, invalidated}, lastTest?}`예요. `blockers[].code`는 닫힌 8종이에요. `kind_off`는 N3(종류 스위치)가, `quiet_hours`는 N7(근무 시간)이 켜는 코드라서 그 슬라이스 전에는 그 조건이 없는 것으로 봐요(수용 기준 1·27·28). `channelId`로 준 채널이 없거나 호출자가 볼 수 없으면 404예요(존재 비노출, #4233의 원칙).

  | 코드 | 조건 | 덧붙는 값 |
  |---|---|---|
  | `paused` | `notification_rule.dnd`이고 기한이 없거나 미래 | `untilMs?` |
  | `quiet_hours` | 일정이 켜져 있고 지금 창 밖이고 `kind`가 관통 종류가 아님 | `untilMs`(다시 시작할 때) |
  | `channel_muted` | `channelId`가 있고 음소거 행이 진행 중 | `channelId`, `untilMs?` |
  | `kind_off` | `kind`가 있고 그 종류의 `phone` 스위치가 꺼짐 | `kind` |
  | `no_device` | 이 멤버의 `push_token` 행이 하나도 없음 | 없음 |
  | `token_invalidated` | 행은 있는데 전부 `invalidated_at`이 있음 | `sinceMs` |
  | `relay_unreachable` | 최근 15분 안 이 멤버의 `push_dispatch_log`에 `apns_status IS NULL`인 채 2분이 넘은 행이 있거나, 마지막 시험이 30초 넘게 처리되지 않음(notifier가 꺼진 경우 포함) | `sinceMs` |
  | `last_delivery_failed` | 가장 최근에 정산된 `push_dispatch_log` 행의 `apns_status`가 400 이상 | `atMs`, `apnsStatus`, `apnsReason?` |

  - `ok`는 「서버가 막은 것이 없다」예요. 기기가 보여 주는지는 몰라서(#4295) 화면은 「서버 쪽은 문제 없어요 · 시험 알림으로 확인해 보세요」로 말해야 해요.
  - **진단이 말하지 않는 것** [권장]: ① 데스크탑 활성 중 폰 푸시의 지연(D4)은 막힘이 아니라 늦음이라 코드가 아니에요. 화면이 `phoneDelaySecs`로 직접 안내해요(#4342). ② `kind=channelAll`인데 그 채널 단계가 `all`이 아닌 것은 코드가 아니라 설정이에요. 화면이 `Channel.notificationLevel`로 안내해요. ③ 대량 층의 서버 전체 예산 드롭(D7)은 서버 전체의 사실이라 멤버 진단이 아니에요(운영 지표). ④ 발신자 규칙(`sender_quiet`)은 N14가 코드로 더해요(D19). 그래서 `ok: true`가 「그 알림이 오는 설정」이라는 뜻은 아니에요.
  - **등록 거절로 생긴 `no_device`** [권장]: 푸시를 못 받는 이유가 등록 거절일 수 있어요(ADR-0204 증보 4: 이전 소유자가 휴면 기기를 되가져가 지금 주인의 등록이 403 `device belongs to another member`, 다른 워크스페이스로 옮긴 폰의 409). 서버는 등록 거절 이력을 몰라서 이 경우의 `no_device`·`token_invalidated`는 재등록으로 고쳐지지 않아요. 클라이언트(#4342)가 직전 등록 응답(403·409)을 기억해 안내를 바꿔요(남는 위험 14).
  - 읽는 표는 `momo_app`이 이미 읽어요(`infra/rust/sql/bootstrap_runtime_roles.sql:52-53`의 ALL TABLES 부여 + RLS, 멤버 조건은 쿼리가 걸어요). api에는 relay 클라이언트가 없어서 `relay_unreachable`은 기록에서 **추론**해요(위 조건). [확인 필요] 추론의 오탐은 #4341이 격리 PG로 재현해서 조정해요.
  - **`apnsReason`은 코드만 내보내요** [권장]. 기록의 `apns_reason`은 relay가 직접 거절한 400이면 본문 발췌(최대 160자, `momo-push/src/dispatch_log.rs:297-323`)가 섞여 있어요. APNs의 reason 코드(`BadDeviceToken`·`Unregistered` …)는 그대로 보이고, relay 문구는 코드로 바꿔요: 어휘 거절(`invalid momo.push.dispatch.v2 payload`) → `relay_vocabulary_refused`, 환경 불일치(`dispatch APNs environment does not match relay`) → `relay_environment_mismatch`, 그 밖 → `relay_http_<status>`. relay의 문구는 응답에 싣지 않아요(`momo-push-relay/src/app.rs:132-150`). 두 질의(`relay_unreachable`·`last_delivery_failed`)는 대량 층의 드롭 행(`apns_reason`이 `relay_http: dropped`, D7)을 건너뛰고 현재 활성 토큰의 행만 최근 7일 안에서 읽어요 [권장](옛 토큰의 실패나 오래된 410이 계속 남지 않게요). 멤버별 최근 행을 읽으려고 `push_dispatch_log (member_id, created_at DESC)` 색인을 더해요(DB 계약 M-h).
- **`POST /v1/workspaces/{ws}/notification-diagnostics/test`** → 202 `{testId, deviceCount}`예요.
  - **판정(`judge_targets`)을 우회해요.** 목적이 「전송 경로 자체가 되는가」라서 일시 중지 중에도 시험은 가요(관문은 `GET`이 말해요). 호출자 본인의 활성 토큰에만 가요.
  - 같은 tx에서 `push_system` 행 1건(D15)을 써요. notifier가 relay 서명 키로 보내요. 활성 토큰이 하나도 없으면(행이 없거나 전부 무효) 409 `no_device`예요(진단 GET은 이를 `no_device`와 `token_invalidated`로 가려 말해요). 에이전트 bearer는 403이에요.
  - **속도 제한** [권장]: 멤버당 분당 3회이고 넘으면 429 `rate_limited`예요. 서버에는 per-member 속도 제한 장치가 없어서(ADR-0208 D10·보안 절 · #4234) 이 라우트가 직접 세요. outbox를 세지 않아요: 끝난 행은 인덱스에 안 잡혀(`001_init.sql:430-431`는 `pending`만 덮어요) 표를 훑게 돼요. 대신 `notification_rule` 행(없으면 만들어요, PATCH와 같아요)의 창 시작·횟수 컬럼 둘(D13)을 `FOR UPDATE`로 잠근 채 갱신하고, 같은 잠금 안에서 마지막 시험 컬럼 둘(`last_test_id`·`last_test_at`)도 써요. 한 행 잠금이라 직렬화되고 인덱스가 필요 없어요.
  - **공유 relay 예산**: 시험 알림도 relay의 서버 단위 한도(맥락 표)를 같이 써요(멤버 × 분당 3 → **증보 2 「D11 정정」: 기기마다 relay를 불러서 실제 곱은 기기 수 × 분당 3이었고, 한 번이 닿는 기기를 최근 5대로 묶었어요(5 × 분당 3)**). 시험 알림은 best-effort 층이라 relay 429를 받아도 다시 시도하지 않고 `failed`로 보여요. 남는 위험으로 둬요.
  - 결과는 `GET`의 `lastTest {id, status, atMs, apnsStatus?}`로 읽어요. 마지막 시험의 id·시각은 위 컬럼에서 읽고, 결과는 그 id의 collapse id `t:<id>`로 `push_dispatch_log`를 (멤버, 토큰, collapse id) **정확 조회**해서 읽어요(→ **증보 2 「D11 정정」: 질의에 `push_token_id IS NOT NULL`을 더해야 부분 유니크 색인을 타요**). outbox를 읽지도 훑지도 않아요. 기기가 여럿이면 하나로 모아요:

  | `status` | 뜻 |
  |---|---|
  | `queued` | 기록이 없거나 정산 전(`apns_status` NULL) 행뿐이고 만든 지 30초 미만 |
  | `stalled` | 같은 모양인데 30초 이상(notifier가 꺼졌거나 처리 전에 기기가 사라진 경우 포함) |
  | `sent` | 기기 중 하나라도 APNs 200 |
  | `relay_outdated` | 모든 시도가 relay의 **어휘 거절**(위 코드 `relay_vocabulary_refused`)이었고 재시도하지 않아요. 환경 불일치 400은 여기가 아니라 `failed`예요 |
  | `failed` | 그 밖(정산된 기록이 있고 200이 없음: APNs 거절·환경 불일치·relay 429 포함) |

### D12. 채널 음소거에 기한을 줘요 (`mutedUntilMs`) [권장]
- `PUT …/channels/{ch}/notification-pref`의 본문은 `deny_unknown_fields`를 유지하고 `muted`(bool)와 `level`(`all|mentions|none`) 중 **하나**(둘 다·둘 다 없음은 400)에 선택 `mutedUntilMs`(int64, epoch ms)를 더해요.
- `mutedUntilMs`는 `muted:true`·`level:"none"`일 때만 받아요(아니면 400). **지금보다 미래이고 366일 이내**여야 해요(400 `muted_until_in_past`·`muted_until_too_far`). 생략·null은 기한 없음이고 구 본문 `{muted:true}`는 오늘처럼 기한 없는 음소거로 덮어써요.
- 응답은 `{muted, level?, mutedUntilMs?}`예요(`level`은 N1이 열어서 그 전에는 없어요). `muted`·`level`은 **효과값**(진행 중인 기한만 음소거)이고 `mutedUntilMs`는 진행 중일 때만 값이 있어요. 채널 읽기 모델 `Channel`에 `mutedUntilMs`(진행 중일 때만, #4343)와 `notificationLevel`(효과값, 채널 단계 슬라이스 N1)을 더해요. 같은 이유로 요청의 `level`도 N1이 열어요. 채널·DM 목록을 읽는 곳 셋(`momo-messaging/src/channel.rs:658-663`, `dm.rs:244-249`·`:309-314`)에 같은 조인을 더하고 `muted` 계산은 지금 그대로예요.
- 만료는 서버가 판정·읽기 때 다시 평가해요(스위퍼 없음, 읽는 곳 다섯이 이미 해요). 클라이언트는 기한이 지나면 서버를 **다시 읽을** 뿐 타이머로 풀지 않아요(ADR-0204 D3).
- 감사 `notification_pref.updated`에 `level`·`mutedUntilMs`를 더해요(additive, `momo.notification_pref.updated.v1`). 억제된 대상은 `push_dispatch_log`에 행을 남기지 않아요(ADR-0124 D2).

### D13. `notification-prefs`: 종류×표면·표현·근무 시간·지연·관통 스위치를 서버에 저장해요 [권장]
- `GET`·`PATCH /v1/workspaces/{ws}/notification-prefs`는 본인 것만, 사람 bearer만 써요(에이전트 403). PATCH는 필드 단위예요(생략 = 유지, 빈 본문 400, 모르는 필드는 JSON 추출기가 422, 동시 PATCH는 행 잠금 뒤 병합이에요. `notification-rules` PATCH와 같아요, ADR-0124 증보 3). 병합 단위: `kinds`는 셀(종류×표면), `presentation.sounds`는 종류(키) 단위로 합치고, 값 `null`은 기본값(셀은 종류 표의 기본, 소리는 기본음)으로 되돌려요. `schedule`은 통째로 바꿔요(부분 병합 없음). 종류에 해당 없는 표면 칸(`agentAnswer`·`keyword`·`scheduledFailed`의 `desktop`)을 쓰면 400이에요.
- **저장**: `notification_rule`(066)에 컬럼을 더해요. 새 표가 아니고 RLS는 상속이에요.

  | 컬럼 | 타입 | 뜻 | 행 부재·NULL |
  |---|---|---|---|
  | `kinds` | jsonb NULL | 종류×표면 스위치(셀 단위로 저장, 없는 셀은 기본값) | 종류 표의 기본값 |
  | `presentation` | jsonb NULL | 종류별 소리 슬롯(값은 소리 id 또는 `"none"`) | 종류별 기본 소리(D10) |
  | `schedule` | jsonb NULL | 근무 시간 | 없음(꺼짐) |
  | `phone_delay_secs` | smallint NULL | D4 | 60 |
  | `keyword_overrides_mute` | boolean NOT NULL DEFAULT true | D3 | true |
  | `approval_time_sensitive` | boolean NOT NULL DEFAULT false | D6 | false |
  | `test_push_window_start` | timestamptz NULL | 시험 알림 속도 제한의 창 시작(D11) | 없음 |
  | `test_push_count` | smallint NULL | 그 창의 횟수 | 0 |
  | `last_test_id` | uuid NULL | 마지막 시험 알림의 id(D11) | 없음 |
  | `last_test_at` | timestamptz NULL | 그 시험을 만든 시각 | 없음 |

  jsonb 컬럼에는 DB CHECK를 걸지 않아요(ADR-0124 증보 2 D9와 같은 이유: 롤백한 서버의 해제 쓰기가 막히면 안 돼요). 검증은 API가 하고(8KB 이하, 알려진 종류·표면·소리 id만) 읽는 쪽은 모르는 키를 무시해요. `workDone.phone`은 저장하지 않고 `work_complete_push`를 그대로 읽고 써요(D5).
- 응답에는 효과값 블록 `effective {paused, pausedUntilMs, quiet {active, resumesAtMs}}`가 함께 와요(날짜 칸은 없으면 null). 데스크탑 배너는 이 값을 읽을 뿐 일정·시간대 계산을 다시 하지 않아요(D17).
- 이벤트는 없어요. 다른 기기는 다음 조회(앱 전경 복귀·새로고침)에서 같은 값으로 수렴해요(ADR-0177·ADR-0204 D3와 같은 방식).
- **근무 시간(일정)의 의미**: 증보 1 D4가 제외한 「DND 스케줄/조용한 시간」(ADR-0124)을 이행해요.
  - `schedule = {enabled, tz, days, start, end, passThrough}`예요. `days`는 0(일)~6(토), `start`·`end`는 `HH:MM`이에요.
  - **창의 요일은 창이 시작하는 날**이에요. `end <= start`이면 자정을 넘는 창이고, 금 22:00~06:00이면 토 02:00도 창 안이고 요일은 금으로 봐요. `start == end`는 400 `invalid_schedule`이에요(24시간이 필요하면 `enabled:false`가 맞아요).
  - **`tz`는 `pg_timezone_names`에 있는 이름만** 받아요. 쓸 때 DB로 검증해 아니면 400 `invalid_time_zone`이에요. PG의 `AT TIME ZONE`은 약어(`PST`)와 POSIX 형식(`UTC+9`는 부호가 반대)도 받아서 「IANA 이름」만으로는 가를 수 없어요. 이름이 `pg_timezone_names`에 있는 고정 구역(예: `Etc/GMT+5`)은 통과해요(DST 없는 구역이라 의도에 맞아요). `human.tz`는 검증하지 않는 가입 때 문자열이라(`momo-settings/src/join.rs:235-243`) 기본값으로 쓰지 않고 클라이언트가 현재 시간대를 채워 보내요.
  - 창 밖은 **일시 중지처럼** 동작해요(그 종류의 푸시와 배너가 안 와요). `passThrough`에 든 종류만 와요. 기본은 `["approval"]`이에요(승인은 1시간에 만료되고 「항상 오는 알림」이 기본이라서요, D5·D6). **일시 중지는 항상 이겨요**(I6).
  - `effective.quiet.resumesAtMs`는 다음 창이 열리는 시각이에요. DST로 없는 현지 시각이면 그 직후 첫 유효 시각, 겹치는 시각이면 먼저 오는 쪽이에요.
  - 판정 후단(D16)이 보조 조회 한 번으로 `now() AT TIME ZONE tz`를 평가해요. 시각 계산은 Postgres에 맡기고 Rust에 시간대 DB 의존을 새로 들이지 않아요. 저장된 zone 이름이 읽을 때 틀렸으면(tzdata 변경) 일정이 없는 것으로 보고 로그 한 줄을 남겨요. 판정을 깨지 않아야 해서 오류를 NULL로 바꾸는 DB 함수 하나를 써요(모양은 구현이 정해요).
  - 진단 코드 `quiet_hours`와 `effective.quiet`가 같은 평가를 써요.

### D14. 푸시 어휘를 한 번에 증보하고 relay부터 배포해요 (ADR-0120 A-6) [권장]
- **더하는 것**(슬라이스 N0 한 번)

  | 면 | 더하는 것 |
  |---|---|
  | reason | `channel_message`·`keyword`·`test_notification`·`scheduled_failed` |
  | category | `momo.system`(액션 없음). `channel_message`는 `momo.message`, `keyword`는 `momo.mention`, 시스템 둘은 `momo.system`이에요 |
  | 정적 본문 | reason별 표로 바꿔요. 기본 「새 알림」, `test_notification` 「시험 알림이에요」, `scheduled_failed` 「예약한 메시지를 보내지 못했어요」. 제목은 「oort」예요. 사용자 내용·이름은 없어요(id-only 유지) |
  | category 소리 | `momo.system` → `default` 행 |
  | 선택 키 `priority` | D6(슬라이스 N16)에서 더해요. 그때도 relay 먼저예요 |

- **고칠 면**(`rg work_run_done`·`rg ALLOWED_REASONS`로 전수 확인했어요. 빠뜨리지 않게 나열해요)
  - relay: `ALLOWED_REASONS`(`dispatch.rs:43`)·`ALLOWED_CATEGORIES`(`:61`)·`CATEGORY_SOUNDS`(`:100`, category마다 소리 행이 있어야 고정 시험이 통과해요)·정적 본문(`:300-301`).
  - 서버: `PushReason`(`momo-push/src/dispatch.rs:40`)·`PushCategory`(`:81`)·`category_for`(`:127`).
  - 앱: Swift reason 목록(`MomoPushKit/PushNotification.swift:239`)·`MomoPushCategory`(`:108-117`)·`deepLinkURL`(`:173-184`, 센티널 id가 `/messages/<nil>` 경로를 만들지 않게), 같은 봉투의 세 번째 독자 `clients/mobile/modules/momo-push-action-native/ios/MomoPushActionCore.swift:52-57`과 그 시험 `sim-check/main.swift:182`, RN `PUSH_REASONS`(`clients/mobile/src/push/contract.ts:101`)·`PUSH_CATEGORY`(`:57-62`)·`PUSH_CATEGORY_ACTIONS`(`categories.ts:75-83`, `momo.system` 줄은 버튼 없음), 탭 경로 `tapArrival.ts`·`useNotificationTapRouting.ts`(D15의 탭 목적지).
  - 검증: `scripts/verify_push_relay.sh`(`:156-192`: 「다섯」 문구, 불량 사례, **창의 슬롯 산수** — 어휘가 늘면 「여섯 개가 여덟 슬롯 중 여섯」이 깨져 429 단계가 어긋나요), relay 단위 시험, `pushContract.test.ts`·`pushActionContract.test.ts`·`pushTap.test.tsx`, notifier `push_conformance_pg`, 어휘 일치 정적 시험.
- **N0의 트랙** [권장]: 엔진 PR 한 개가 `clients/mobile/**`의 상수·목록·탭 분기도 **최소 diff**로 바꿔요(`docs/TRACKS.md:22` 「소유가 아니라 통보」: 최소 diff + 상대 트랙(UXUI)에 이슈 코멘트로 로그 + 병합 트리 게이트). 어휘 일치 시험이 한 PR에서 초록이 돼요. 구 앱은 fail-open이라 앱 배포가 늦어도 relay 선배포는 막히지 않아요.
- **배포 순서는 relay → migrate → notifier → api → 앱**이에요. relay가 먼저인 이유는 ADR-0120 A-6과 같아요: 구 relay는 모르는 어휘에 400을 돌려주고 그 400은 영구 실패로 정산돼 푸시가 사라져요(`momo-notifier/src/push_relay.rs:133-140`). notifier가 api보다 먼저인 이유는 `push_system` 소비자가 먼저 있어야 생산자(시험·예약 실패)가 쌓이지 않아서예요. 구 앱은 새 reason에서 파싱이 실패해 relay의 정적 문구로 떨어져요(fail-open). 문구만 일반형으로 퇴화하고 알림은 와요. 구 앱에는 `momo.system`이 없어 시험·예약 실패 알림은 버튼 없이 떠요. 반면 `channel_message`(`momo.message`)와 `keyword`(`momo.mention`)는 구 앱이 이미 아는 category라 **답장 버튼이 달려 뜨고**, 구 앱은 새 reason의 봉투를 파싱하지 못해(`envelope.ts:88-91`, `PUSH_REASONS` `contract.ts:101`) 잠금 화면 답장을 오류 없이 버려요(`notifications.ts:241-243`). 새 reason마다 새 category를 만들어 구 앱에서 버튼을 없애는 길은 기각했고(기각 표) 새 기능(단계 `all`·키워드)을 켠 사용자의 폰이 구 빌드인 동안의 위험으로 수용해요(남는 위험 12). 탭하면 「이 알림이 가리키는 곳을 읽지 못해 앱만 열었습니다」를 보고 앱만 열려요(`tapArrival.ts:135`).
- **한 번에 묶는 이유**: reason마다 relay를 따로 배포하면 호스티드 relay 배포가 네 번이에요. N0 한 PR이 relay와 어휘 목록·시험을 내서 먼저 배포하고 다른 슬라이스는 N0에 의존해요.
- 배포 순서를 어긴 셀프호스트(구 relay에 새 reason)는 400 → 영구 실패 정산 → 푸시 유실이에요. 시험 알림은 이를 `relay_outdated`로 알리고(D11), 일반 푸시는 감사 한 줄(`push.relay.refused`, 토큰당 1시간에 1회, ADR-0204 D9)만 남아요. 수용해요.

### D15. 메시지 없는 푸시는 `push_system` 한 길로 보내요: 시험 알림과 예약 실패 (ADR-0208 D8의 다섯 비용) [권장]
- **문제**: 메시지 행이 없는 푸시가 셋이에요(시험 알림, 예약 실패, 다이제스트). `push_candidate`는 메시지를 가리키고 판정이 그 메시지를 읽어서 맞지 않아요. 이슈 #4341은 시험 알림만 `push_test`로 적었어요.
- **결정**: 새 outbox kind `push_system`과 닫힌 reason 집합으로 한 길을 만들어요.
  - **kind**: `ALTER TYPE outbox_kind ADD VALUE 'push_system'`은 그 값을 쓰지 않는 migration 파일에 둬요(011이 한 방식이에요, `011_push_notifier.sql:42-44`. 한 파일이 한 tx라 같은 파일에서 새 값을 쓰면 안 돼요).
  - **생산자는 둘**이에요. ① 시험 알림 라우트(D11, api의 `momo_app` tx). ② 예약 메시지가 **시스템 사유로** `failed`가 되는 지점이에요: 스케줄러의 마감 판정이 `mark_failed_in_tx(…, ScheduleActor::System)`를 부르는 곳(`momo-server/src/scheduler.rs:445`·`:517`, 함수는 `momo-messaging/src/scheduled.rs:1007-1030`)과 `sessions_ended` 보류 둘(`hold_member_schedules_in_tx`·`hold_lineage_schedules_in_tx`, `:1262-1330`). **사용자가 직접 낸 실패는 푸시하지 않아요**: 「지금 보내기」가 거절돼 같은 라우트가 `mark_failed_in_tx(…, actor=Member)`를 부르는 길(`routes/scheduled_messages.rs:929-941`)은 응답이 이미 작성자에게 사유를 말해요. 둘 다 상태 전이와 **같은 tx**에서 `momo_outbox::emit_outbox`(`emit.rs`, outbox INSERT의 유일한 곳)로 써요. 보류가 여럿이어도 호출당 1건이에요(멤버당 최대 50건이 한꺼번에 푸시되지 않게요).
  - **페이로드(id만)**: `{schema:"momo.push_system.v1", reason, member_id, channel_id?, ref_id, collapse_id}`예요. 본문·이름·예약 본문이 없어요. `reason`은 Rust enum의 닫힌 집합(`test_notification`·`scheduled_failed`)이고 모르는 값은 `failed`로 접어요. **collapse id는 생산자가 정해 payload에 싣고 소비자는 그대로 써요**: `rev`는 `scheduled_message`에만 있고 notifier는 그 표를 읽을 수 없어요(scheduled-message lockdown, `bootstrap_runtime_roles.sql:247-377`, ADR-0208 D3·D6). 분 번호를 소비자가 처리 시각으로 만들면 재시도가 분 경계를 넘을 때 id가 달라져 `claim_dispatch`가 중복을 못 막아요.
  - **소비자**: notifier의 둘째 드레인이에요(`kind='push_system'`만 claim·reclaim, 첫째 드레인과 같은 틱, 같은 `MOMO_PUSH_NOTIFIER_ENABLED` 스위치). SQL은 `momo-outbox`(claim·reclaim)와 `momo-push`(발송 기록)에 두고 notifier 바이너리는 SQL을 갖지 않아요(`momo-notifier/src/lib.rs` 머리말). `push_candidate`의 hot path와 실패 영역이 갈려요. 함께 고칠 면:
    - `OutboxKind` 변종과 `db_labels_match_enum` 시험(`emit.rs:108`), 피드 배타성 표(`momo-outbox/src/push.rs:10-18`).
    - **깨움**: LISTEN 필터는 payload가 `push_candidate`일 때만 푸시 드레인을 깨워요(`momo-notifier/src/lib.rs:1074`). `push_system`도 깨우게 고쳐요(안 고치면 폴링 주기로만 돌아 시험 알림이 늦어요).
    - **운영 점검**: `oort doctor`의 outbox 분류(`scripts/lib/oort_doctor.sh:957-1059`)는 `push_candidate` 밖의 kind를 pending 하나로 FAIL로 세요(`agent_job`만 나이 기준). `push_system`은 두 분류의 혼합이라 분기를 새로 써요: relay 미구성이면 info(`push_candidate`와 같아요), 구성이면 나이 기준(기본 300초) FAIL(`agent_job`과 같아요). `available_at`이 미래인 pending은 건강으로 세요(D4). `scripts/tests/test_oort_doctor_outbox.sh`가 새 분류를 고정해요. 안 고치면 notifier가 없는 기본 스택(남는 위험 8)에서 시험·예약 실패 행이 영영 pending이라 doctor가 영구 FAIL이에요.
  - **`push_candidate` 생산자는 늘지 않아요.** 「세 번째 생산자는 Accepted ADR」(`emit.rs:31-46`, `docs/architecture/overview.md:51`)는 그대로이고, 이 ADR이 새 kind `push_system`의 Accepted ADR이에요. 다이제스트(셋째 생산자)는 증보가 필요해요(D20).
- **발송(소비자)**
  - 대상은 `member_id`의 활성 토큰(`push_token`·`device`, `invalidated_at IS NULL`, 멤버가 `active`인 사람)이에요. 토큰이 없으면 done으로 끝나요(기록 없음).
  - 게이트 [권장]: `test_notification`은 없어요(D11). `scheduled_failed`는 **일시 중지, 근무 시간 밖(`passThrough` 기본은 승인만이라 막혀요), 종류 스위치 `scheduledFailed.phone`**을 따라요. 채널 음소거는 적용하지 않아요(사용자 자신의 행동이 어긋난 알림이지 채널 소식이 아니라서요). 막히면 조용히 done이에요(기록 없음). 게이트는 `momo-push`의 공용 함수라 D16의 후단과 같은 규칙을 써요.
  - 발송 기록은 `push_dispatch_log` 행을 **`message_id = NULL`**로 써요(컬럼이 NULL 허용이에요, `001_init.sql:535`). `claim_dispatch`(`dispatch_log.rs:54-103`)는 `Option<Uuid>`를 받는 짝을 두거나 인자를 풀어요(구현이 정해요. 시험은 FK 위반 없이 행이 남는 것을 고정해요). 유일 인덱스는 `(member, token, collapse_id)`라 영향이 없어요(`011_push_notifier.sql:71-73`).
  - **오류 규칙(reason별)** [권장]: `test_notification`은 best-effort예요. relay 429·5xx에도 재시도하지 않고 정산해서 `lastTest`가 `failed`로 보여요(사용자가 다시 눌러요). `scheduled_failed`는 **재시도 층**이에요. 429·5xx는 일시 오류로 보고 `push_candidate`와 같은 백오프·`max_attempts`로 `requeue`하고, 예산을 다 쓰면 outbox 행이 `failed`예요(예약 실패의 정본은 계속 `scheduled_message`와 앱 안 「예약됨」 목록이라 푸시가 없어도 사실은 남아요). 영구 오류(400)는 두 reason 모두 정산하고 끝내요(어휘 거절은 `relay_outdated`로 알려요, D11). 토큰 410·`BadDeviceToken`은 기존 규칙대로 토큰을 무효화해요(ADR-0204 D9).
  - **collapse id**: `t:<testId>`(시험), `s:<예약 id>:<rev>`(예약 실패 한 건), `sh:<member_id>:<분 번호>`(보류 일괄)예요. 모두 64바이트 이하이고 생산자가 payload에 실어요. 유일 인덱스에는 시간 항이 없고 `push_dispatch_log`를 지우는 정리도 없어서 `s:<예약 id>`만으로는 같은 예약이 다시 걸렸다가 또 실패할 때 두 번째 푸시가 `AlreadySettled`로 사라져요(`dispatch_log.rs:54-103`). `rev`는 전이마다 올라가요(`scheduled.rs:1007-1030`의 `rev = rev + 1`). 보류 일괄은 같은 분에 겹친 사건이 한 건으로 합쳐지는 것이 의도예요.
  - **봉투**의 닫힌 키 집합은 그대로예요. 대상이 없는 id는 nil-UUID 센티널을 써요. 시험은 `channel_id`·`message_id`·`thread_id`가 모두 nil이고, 예약 실패 한 건은 `channel_id`가 실제 값·`message_id`가 nil·`thread_id`가 `channel_id`예요. **보류 일괄은 여러 채널이라 셋 모두 nil**이에요. relay는 비어 있지 않은지만 보고 UUID 형식은 `approval_id`만 봐서 통과해요(relay `dispatch.rs:188-221`). Swift 파서는 UUID 형식을 요구하는데 nil UUID도 형식은 유효해요(`PushNotification.swift:231-235`).
  - **탭 목적지** [권장]: 클라이언트가 reason으로 정해요. `test_notification`은 알림 설정 화면으로 가요(채널을 풀기 전에 reason으로 갈라서 「대화가 없어졌어요」를 내지 않아요). `scheduled_failed`는 `channel_id`가 실제 값이면 그 채널로 가고(nil `message_id`는 메시지로 점프하지 않아요) 그 채널의 「예약됨」을 보여요. 셋이 nil이면(보류 일괄) 「예약됨」 목록으로 가요. 지금 코드는 탭을 봉투의 `channelId`·`messageId`로만 풀어서(`clients/mobile/src/push/tapArrival.ts:88-112`·`:232-283`) 채널 nil이면 「이 알림의 대화가 없어졌거나 볼 권한이 없습니다」(`:137`)가 떠요. 구 앱은 앱만 열어요(D14).
  - relay는 reason별 정적 본문(D14)과 category `momo.system`으로 보내요. 구 relay의 400은 `relay_outdated`로 분류하고 재시도하지 않아요(시험 알림, D11).
- **ADR-0208 D8의 다섯 비용에 대한 답**

  | # | ADR-0208 D8이 적은 비용 | 결정 |
  |---|---|---|
  | ① | reason 1종 추가(relay·서버·앱 상수) | `scheduled_failed`와 category `momo.system`을 D14의 한 번의 증보에 넣어요 |
  | ② | `message_id` 자리에 올 값, 또는 새 키(키 집합 변경은 ADR-0120 변경) | **키 집합을 바꾸지 않아요.** `message_id`는 nil-UUID 센티널이고 채널 이동에 필요한 `channel_id`는 실제 값이에요. 예약 id는 collapse id에만 써요 |
  | ③ | NSE가 무엇을 가져와 그릴지 | **아무것도 가져오지 않아요.** relay의 정적 본문을 쓰고 새 NSE는 reason으로 자기 로케일 문구를 써요. `push_fetch`의 읽기 둘은 불변이에요(`push_fetch_token.rs:199-215`). 탭 목적지는 위처럼 클라이언트가 reason으로 정해요 |
  | ④ | `push_candidate`의 새 생산자(ADR-0204 D8-a) | `push_candidate`에 생산자를 더하지 않아요. 새 kind `push_system`이고 이 ADR이 그 Accepted ADR이에요 |
  | ⑤ | relay 먼저 → 서버 → 앱 순서 | relay → migrate → notifier → api → 앱(D14) |

  푸시 문구에는 실패 사유(`missed`·`not_member` …)를 싣지 않아요(정적 한 줄). 사유는 앱 안 목록이 보여줘요. 예약 실패의 정본은 계속 `scheduled_message`예요.

### D16. 판정 구조는 SQL이 고르고 Rust 후단이 시간·상태를 다뤄요 [권장]
- `judge_targets`는 지금 한 문장이 약 220줄이에요(`judgment.rs:250-474`). 새 arm과 조건을 계속 얹으면 가독성·성능·`judgment_projection` 시험이 무너져요.
- **SQL**: 수신자·reason·종류를 고르고(종류 스위치는 D5대로 arm 조건이에요) 일시 중지·채널 음소거로 억제하는 일만 해요(본문 미독, I2). 새 arm(`keyword`·`channel_message`)과 새 조건은 **CTE 한 조각씩** 더하고 `tests/judgment_projection.rs`가 본문 미독을 계속 단정해요.
- **Rust 후단**(`momo-push`의 새 함수, 가칭 `refine_targets`): SQL이 낸 대상 목록(많아야 수십 명) 위에서 멤버 id 목록으로 보조 조회를 **한 번** 해서 ① 근무 시간 억제(D13) ② 활성 지연·읽음 취소(D4) ③ 폭주 상한(D7, 클레임 직전에 `m:` 정산 여부를 읽기만 한 뒤)을 적용해요. 시간대·활동 신호처럼 시간에 기대는 판정이고, 진단·미리보기가 같은 함수를 불러야 해서예요(P9 「플랫폼별 재구현 금지」).
- **판정 순서**(한 표예요. 모든 슬라이스가 이 순서에 얹어요):

  | 단계 | 하는 일 | 입력 | 뚫는 예외 | 결정 |
  |---|---|---|---|---|
  | 1 수신 자격 | 채널의 활성 사람 멤버, 작성자 제외 | `membership`·`member` | 작업 카드 소유자(`resume_offer`·`work_session_idle`)는 작성자여도 받아요 | `judgment.rs:403-416` |
  | 2 reason 선택 | arm 순서(작업 > 승인 > 멘션 > DM > 에이전트의 답 > `keyword` > `channel_message` > `thread_reply`(증보 1))에서 **종류 스위치가 켜진 첫 일치**(내려가는 arm은 D5가 한정해요. 메시지 모양 arm은 꺼지면 억제) | 메시지 모양·`mention_ids`·hit·단계·종류 스위치 | — | D3·D5·D7 |
  | 3 일시 중지 | 진행 중이면 모두 억제 | `notification_rule.dnd` | 시험 알림만 | I6, D11 |
  | 4 근무 시간 | 창 밖이면 억제 | `schedule` | `passThrough` 종류, VIP | D13, D19 |
  | 5 채널 음소거 | 진행 중이면 억제 | `notification_pref` | 멘션 예외(`mention`), 키워드 관통(`keyword`), VIP | ADR-0124, D3, D19 |
  | 6 지연·취소 | 폰 대상 중 데스크탑이 활성이면 보류, 읽었으면 취소 | `member_activity`·`read_state` | 승인·작업·시스템 | D4 |
  | 7 상한 | (멤버, 채널) 6건/분, 대량 층(`channel_message`·`keyword`)의 서버 전체 예산 | notifier 프로세스 창 | 없음 | D7 |
  | 8 발송 | claim → relay | — | — | ADR-0120 |

  1·2·3·5는 SQL 한 문장이고 4·6·7은 Rust 후단이에요. 4와 6은 행이 없으면 통과하는 선택 단계예요. 종류 스위치는 arm 조건의 일부예요(내려가기와 억제의 구분은 D5). 발신자 규칙 `quiet`(D19, P2)의 억제는 후단의 4행과 5행 사이 단계로 N14가 이 표를 증보해요. ux-bible P9의 「6-노드 수준의 합성 가능한 결정 트리」(`docs/ux-bible/README.md:19`)는 이 표가 8단계라 **일부러 넘어요**. 같은 뜻의 규칙을 클라이언트마다 다시 짜지 않는 것(플랫폼별 재구현 금지)을 지키려고 한 표·한 함수에 모아요.
- **규칙 빌더(ADR-0207)** 는 이 후단 위에 얹어요. SQL이 후보를 고른 뒤 Rust 해석기가 id·enum 사실만으로 평가해요(본문 미독). 평가기의 스키마·순서·상한은 ADR-0207이 정하고, 이 ADR은 「후단은 id·enum·시각 사실만 읽는다」는 경계만 정해요.

### D17. 데스크탑·웹 배너 판정은 서버 값을 입력으로 일원화해요 [권장]
- 지금: 일시 중지는 서버 값을 읽고(#4197, `model.ts:220`·`:258`, `serverPause.ts`) 멘션 예외·종류 스위치·일정은 읽지 않아요. 종류 스위치는 기기 localStorage(`preference.ts:45`)이고 폰은 서버(`work_complete_push`)예요.
- 결정: **배너 판정은 클라이언트에 남기되(실시간 `message.new`로 바로 띄워야 해서요) 입력은 전부 서버 값**이에요. 입력은 일시 중지·근무 시간(`effective`, D13), 채널 음소거·단계(`Channel.muted`·`notificationLevel`, D12), 멘션 예외(`mentionOverridesMute`), 종류×`desktop` 스위치(`notification-prefs`, D5)예요. 클라이언트에 서버가 모르는 규칙을 새로 두지 않아요. 이 기기 스위치는 서버 값의 **캐시**예요.
- **서버로 올리지 않는 기기 로컬 스위치** [권장]: `preference.ts:15-32`·`:49-59`의 `pane-waiting`(로컬 칸 알림)·`reminder`(클라이언트가 폴링하는 나중에 알림)·`dockBadge`·`dockDm`(독 아이콘 표시)은 서버가 판정하는 종류가 아니라 이 기기의 화면 설정이라 계속 `momo.web.notifications.v1`에 둬요. 올리는 것은 `mention`(→ `mentionHuman`·`mentionAgent`의 `desktop`)·`approval`·`dm`·`work-mine-done`(→ `workDone.desktop`) 넷이에요.
- 이전(N4): 위 넷에 로컬 값이 있고 서버 행이 없으면 PATCH 한 번으로 올리고 그 뒤 로컬은 캐시예요. 설정 표의 폰 열 「곧 열려요」는 0건이 돼요(`DesktopNotificationGroup.tsx:83-87`).
- 멘션 예외가 켜져 있으면 음소거 채널도 멘션 구독에 포함해요. 감시 채널 상한 30은 유지하고(`DesktopNotifications.tsx:57`) 멘션 예외로 들어온 음소거 채널과 단계가 `all`인 채널은 뒤에 와요. 상한 정책을 문서화하는 것이 수용 기준이에요.
- **데스크탑 `channelAll` 배너에도 폭주 상한이 있어요** [권장]: 폰 푸시의 (멤버, 채널) 60초 6건·합침 규칙(D7)을 같은 상수·규칙의 TS 구현(`packages/momo-core`)으로 배너에 적용해요(Rust notifier 창과 두 구현이라 일치 시험이 상수를 맞춰요, 수용 기준 37). 7번째부터는 「새 글이 여러 개 있어요」 한 건으로 합쳐요. 에이전트가 많이 말하는 채널을 `all`로 둬도 메시지마다 배너가 뜨지 않아요(P8).
- 일시 중지·근무 시간·채널 음소거 중에는 배너도 소리도 없어요(I1).

### D18. 표현은 앱이 재생하고 iOS는 NSE가 읽기만 해서 소리를 덮어써요 [권장]
- **재생**: 웹·데스크탑은 앱이 Web Audio(`AudioBufferSourceNode`)로 재생해요. `<audio>`는 쓰지 않아요(macOS 미디어 키를 가로채요, r7 B12 [외부]). **배너를 실제로 게시한 경우에만** 재생하고, 사용자 제스처 전 재생 실패는 조용히 배너만 보여요. macOS Tauri 배너의 기본 소리는 #4222가 붙여요(`notify-rust`의 기본 macOS 백엔드가 `NSUserNotification`이고 소리가 없으면 `soundName`을 안 정해요 [외부, `runtime-unverified`]).
- **불변식 시험(I1)**: 소리 끔 → 배너 유지 / 배너 억제(일시 중지·음소거·근무 시간·창이 앞이고 그 채널을 봄) → 소리 없음 / 기본 소리가 종류마다 다름 / 재생은 `presentation`을 따름.
- **iOS**: relay는 계속 `aps.sound="default"`를 보내서 NSE가 실패하면 기본음이에요(fail-open). NSE는 앱이 App Group에 써 둔 **매핑 JSON을 읽기만** 해서 `content.sound`를 덮어써요. 매핑 키는 와이어 reason(+category)이고, 소리 파일은 번들 소리는 앱 번들에, 사용자 파일은 App Group의 `Library/Sounds`에 있어요. 앱이 설정을 바꿀 때와 전경으로 돌아올 때 매핑 JSON과 사용자 파일을 쓰고, NSE는 네트워크로 소리를 받지 않아요(`push_fetch`의 읽기 둘 불변). 파일이 없거나 30초 이상이거나 형식이 틀리면 기본음이에요. App Group은 이미 앱·NSE 두 entitlement에 있어요(`MomoMobile.entitlements`, `MomoMobileNotificationService.entitlements`의 `group.app.momo.ios`).
- **묶음 문구** [권장]: 봉투의 `collapse_id`가 `o:` 접두이면(D7의 7번째부터 합친 푸시) 새 NSE는 메시지를 가져오지 않고 정적 문구 「새 글이 여러 개 있어요」를 써요. 상수 문구라 id-only가 유지돼요.
- **하위 종류**(사람/에이전트 멘션·에이전트의 답)는 reason이 같아 NSE가 가르지 못해요. 폰의 멘션 소리는 `mentionHuman`의 소리를 따르고, 하위 종류별 소리는 데스크탑·웹에서 먼저 돼요(NSE가 작성자 종류를 쓰는 확장은 D19와 함께 P2예요).
- **기각**: `aps.sound`에 파일명을 싣는 안은 relay가 멤버별 선택을 알게 되고 어휘를 바꿔야 하고, 파일이 기기에 없을 때 동작이 불확실해요(r7 P1-10).
- **스파이크**(슬라이스 N10의 첫 단계, `runtime-unverified`): ① NSE가 `content.sound`를 App Group 파일로 덮어써서 실제로 재생되는지 ② mp3·m4a가 `Library/Sounds`에서 재생되는지(Telegram은 쓰지만 Apple의 형식표에는 PCM·IMA4·µLaw·aLaw뿐이에요 [외부]) ③ 「소리 없이 배너만」이 NSE `sound=nil`로 되는지 relay `sound` 키가 필요한지. ③이 안 되면 폰은 「소리 끔」 선택지를 숨겨요(거짓 약속을 안 해요).
- **NSE 소스 정리**: 「INHERITED SOURCE — DO NOT EDIT」 머리는 죽은 계약이에요(`NotificationService.swift:1-16`, 원본 `clients/iOS`는 삭제돼 검증기가 SKIP이에요). N10이 정리해요.

### D19. 발신자 규칙(VIP·조용히)은 경계와 의미만 정해요 [권장]
- 사람·에이전트 발신자를 지정해요(P2-2). 에이전트가 1급 멤버라 「에이전트 조용히」가 자연스러워요.
- 저장: `notification_sender_rule (workspace_id, member_id, sender_member_id, mode)`, `mode ∈ {vip, quiet}`, 멤버당 50개 이하, RLS ENABLE+FORCE `ws_isolation`, 사람 bearer만 써요.
- 판정(후단): `quiet` 발신자의 `dm`·`mention`·`channel_message`·`keyword`는 푸시하지 않아요(인박스·배지는 그대로, 승인 요청은 대상이 아니에요). 진단 코드는 8종으로 닫혀 있어서 `sender_quiet`는 N14가 증보로 더해요(D11). `vip` 발신자의 같은 종류는 **채널 음소거와 근무 시간 밖을 관통**하고 별도 소리를 가질 수 있어요. **일시 중지는 관통하지 못해요**(I6).
- VIP 별도 소리는 NSE가 작성자 id를 알아야 해서(fetch 응답) NSE 확장이 필요해요. 새 와이어 어휘는 없어요. 구체 화면과 상한 동작은 N14·N15가 정하고 시험으로 고정해요.

### D20. 이 ADR이 정하지 않는 것
- 규칙 빌더의 스키마·평가기(ADR-0207, #4345 착수 때) · Apple capability·프로비저닝·증거 빌드(owner) · **다이제스트 푸시**(P2-5, 슬라이스 N18. `push_system`의 셋째 생산자와 reason `digest`·판정이 필요해 증보가 먼저예요) · **허들 시작 푸시**(#2767. 새 reason·종류 표 등록·이 ADR의 어휘 규칙을 따라야 해요) · **데스크탑 키워드 배너**(매칭을 `packages/momo-core`의 한 함수로 두는 증보가 먼저예요, 종류 표 아래 설명) · 스레드 팔로우(→ 증보 1이 정해요)·스레드 음소거 · Android/FCM · Critical Alerts(쓰지 않아요) · 푸시 도착 확인 관측 · 키워드 일치의 인박스 항목화(키워드는 푸시와 하이라이트만이에요).

## 공개 API 초안 (요약)

전부 `docs/api/openapi.yaml`에 「계약 초안」으로 들어갔어요(부록 A). 새 경로는 해당 슬라이스가 나올 때까지 404이고, 기존 경로의 새 필드는 그때까지 422(`deny_unknown_fields`)예요. 새 연산은 모두 사람 bearer만 쓰고 에이전트 bearer는 403이에요(`require_human`, `routes/notification_rules.rs:91` 모양).

| 연산 | 경로 | 요청 | 성공 | 오류 | 슬라이스 |
|---|---|---|---|---|---|
| `getNotificationDiagnostics` | `GET …/notification-diagnostics?channelId=&kind=` | 없음 | 200 진단(D11) | 400 잘못된 id·kind, 401, 403, 404 볼 수 없는 채널 | #4341 |
| `sendTestNotification` | `POST …/notification-diagnostics/test` | 본문 없음 | 202 `{testId, deviceCount}` | 403 에이전트, 409 `no_device`, 429 `rate_limited` | #4341 |
| `getNotificationPrefs` | `GET …/notification-prefs` | 없음 | 200 종류×표면·표현·일정·지연·스위치·`effective` | 401, 403 | N3 |
| `patchNotificationPrefs` | `PATCH …/notification-prefs` | 필드 단위, `confirm?` | 200 (+`warnings`) | 400 빈 본문·`confirmation_required`·`invalid_time_zone`·`invalid_schedule`·모르는 소리 id·해당 없는 표면 칸(모르는 필드는 422), 403 | N3 |
| `getNotificationKeywords` | `GET …/notification-keywords` | 없음 | 200 `{keywords, max}` | 401, 403 | N5 |
| `putNotificationKeywords` | `PUT …/notification-keywords` | `{keywords:[…]}` 전체 교체 | 200 | 400 `keyword_too_short`·`keyword_too_long`·`too_many_keywords`, 403 | N5 |
| `touchPresenceActivity` | `PUT …/presence/activity` | 본문 없음 | 204 | 401, 403 | N11 |
| `updateChannelNotificationPref`(변경) | `PUT …/channels/{ch}/notification-pref` | `{muted}` 또는 `{level}` + `mutedUntilMs?` | 200 `{muted, level, mutedUntilMs?}` | 400 `muted_until_in_past`·`muted_until_too_far`·`level_not_applicable`, 403 | #4343(기한), N1(`level`) |
| `Channel`(읽기 모델 변경) | 채널·DM 목록 | 없음 | `mutedUntilMs?`·`notificationLevel` 추가 | 없음 | #4343·N1 |

사용자 알림음 API(D2)는 3단계라 초안에 넣지 않았어요.

## DB 계약 (요약)

| 객체 | 종류 | RLS·권한 | 행 부재·기본 | 결정 |
|---|---|---|---|---|
| `notification_channel_level` | 새 표 | ENABLE+FORCE `ws_isolation` · `momo_app` DML(기본 권한) · `momo_notifier` SELECT 추가 | 행 없음 = `mentions` | D7 |
| `notification_rule` 컬럼 10개 | 컬럼 추가(시험 알림 4개는 M-b1, 나머지 6개는 M-b2) | 기존 정책 상속 · 기존 SELECT | NULL·기본값 = 오늘 | D13 |
| `notification_keyword` | 새 표 | `ws_isolation` · `momo_app`·`momo_worker` 기본 권한(보내는 쪽 tx가 읽어요) · `momo_notifier` 권한 없음(notifier 줄은 투영하지 않아요) | 행 없음 = 키워드 없음 | D3 |
| `message_keyword_hit` | 새 표 | `ws_isolation` · 쓰기는 보내는 쪽 tx의 INSERT(`momo_app`, 에이전트의 말은 `momo_worker`) · `momo_notifier`는 SELECT(판정)만, INSERT·DELETE 없음 | 행 없음 = 일치 없음 | D3 |
| `member_activity` | 새 표 | `ws_isolation` · `momo_notifier` SELECT | 행 없음·30초 지남 = 활성 아님 | D4 |
| `outbox_kind` 라벨 `push_system` | enum 값 | 기존 outbox 권한 | — | D15 |
| `push_dispatch_log` 색인 | 색인 추가 `(member_id, created_at DESC)` | 기존 권한 | — | D11 (M-h) |
| 시간대 평가 DB 함수 | 함수 하나(오류를 NULL로 바꿔요) | SECURITY INVOKER, `search_path` 고정, EXECUTE는 `momo_app`·`momo_notifier` | 잘못된 zone = 일정 없음 | D13 (M-b2) |
| `member_sound`(P2) | 새 표 | 소유자 범위 FORCE · `momo_app`만 | 행 없음 = 기본음 | D2 |
| `notification_sender_rule`(P2) | 새 표 | `ws_isolation` · `momo_notifier` SELECT | 행 없음 = 규칙 없음 | D19 |

- 모든 새 표는 `workspace_id`를 갖고 RLS ENABLE+FORCE예요. `momo_notifier`는 표 단위 GRANT만 받고 DELETE가 없어요(`bootstrap_runtime_roles.sql:437-`의 규칙, 「표 하나에 GRANT 한 줄」을 `scripts/tests/test_notifier_role_grants.sh`가 읽어요). notifier가 읽는 새 표(`notification_channel_level`·`member_activity`·`message_keyword_hit`, P2의 `notification_sender_rule`)에는 SELECT 한 줄씩을 더하고, **키워드 표 둘에는 INSERT를 주지 않아요**: notifier가 쓰는 줄은 투영을 건너뛰기 때문이에요(D3). `momo_app`·`momo_relay`·`momo_worker`는 기본 권한으로 새 표가 자동으로 열려요. 이 규칙을 시험이 고정해요(수용 기준 35). 같은 모양의 사고가 `inbox_item`에서 있었어요(`bootstrap_runtime_roles.sql:473-480`의 주석).
- 새 표의 FK는 `workspace`·`member`(·`channel`)에 ON DELETE CASCADE예요(018·141과 같아요). `schema_v0.sql`은 건드리지 않아요. 새 migration은 `server/Migrations/`에 새로 두고, 각 새 표의 migration은 141처럼 `momo_app`·`momo_notifier` GRANT 블록(`DO $$ … IF EXISTS pg_roles …`, `141_channel_viewing.sql` 끝)을 함께 담아요.
- **migration 번호는 예약하지 않아요** [권장]. 지금 최신은 148이고 진행 중인 149가 하나 있어요(#4313의 `149_official_catalog_display_fields.sql`, [V] 2026-10-25, 로컬·원격 ref 1,213개를 훑었고 150 이상은 없어요). 여러 워커가 동시에 일하므로 번호는 착수한 PR이 그때의 최신 + 1을 쓰고 `scripts/check_migration_numbers.sh`가 충돌을 잡아요. 순서만 예약해요. `momo-db/src/migrate.rs:677-699`의 `discovers_contiguous_migrations_001_to_148`이 148을 박아 두어서 migration PR마다 이 시험의 끝 번호를 같이 고쳐요.

  | 순서 | 이름(가칭) | 내용 | 슬라이스 |
  |---|---|---|---|
  | M-a | `outbox_kind_push_system` | `ALTER TYPE outbox_kind ADD VALUE`(값을 쓰지 않는 파일) | #4341 |
  | M-b1 | `notification_rule_test_push` | 컬럼 4개(`test_push_window_start`·`test_push_count`·`last_test_id`·`last_test_at`) | #4341 |
  | M-b2 | `notification_rule_v2` | 컬럼 6개와 시간대 평가 DB 함수 | N3 (일정 값은 N7이 채워요) |
  | M-c | `notification_channel_level` | 새 표 | N1 |
  | M-d | `notification_keyword` | 표 둘(`notification_keyword`·`message_keyword_hit`)과 GRANT | N5 |
  | M-e | `member_activity` | 새 표와 notifier SELECT | N11 |
  | M-f | `member_sound` | P2 | #4345 |
  | M-g | `notification_sender_rule` | P2 | N14 |
  | M-h | `push_dispatch_log_member_recent` | 색인 `(member_id, created_at DESC)` | #4341 |

## 호환·롤백

| 변경 | 구 서버가 새 DB를 읽을 때(롤백 포함) | 구 앱 + 새 서버 | 새 앱 + 구 서버 | 구 relay + 새 서버 | 고정할 시험 |
|---|---|---|---|---|---|
| 새 표(`notification_channel_level`·`notification_keyword`·`message_keyword_hit`·`member_activity`) | 모르는 표라 무시해요. 새 설정이 없던 것처럼 오늘의 동작이에요(`all`·키워드는 꺼진 것처럼, 지연은 없는 것처럼). 음소거로 둔갑하지 않아요 | 영향 없음 | — | 영향 없음 | 행 부재 = 오늘 회귀 시험 |
| `notification_rule` 새 컬럼 | 모르는 컬럼은 무시해요. 구 `PUT`·`PATCH`가 새 컬럼을 건드리지 않아요(쓰기가 컬럼을 명시해요) | 영향 없음 | — | 영향 없음 | 구 PUT 뒤 새 컬럼 보존 |
| `push_system` kind | 구 notifier는 claim하지 않아 행이 쌓여요(시험 알림은 `stalled`, `oort doctor`는 새 분류 전까지 FAIL이라 D15의 점검 수정이 같이 가요) | 영향 없음 | — | 영향 없음 | 배포 순서(D14) |
| 새 reason·category | — | NSE 파싱 실패 → relay 정적 문구(fail-open). `momo.system`(시험·예약 실패)은 버튼 없음이고 `channel_message`·`keyword`는 구 앱의 답장 버튼이 달리며 그 답장은 조용히 버려져요(수용, 남는 위험 12). 탭은 앱만 열려요 | — | 400 → 영구 실패 정산 → 푸시 유실. **배포 순서로 막아요** | 구 relay 시험(D11) |
| API의 새 필드·경로 | `level`·`mutedUntilMs`는 422, 새 경로는 404 | 구 앱은 `{muted}`만 보내서 그대로 돼요 | 404·405는 「기능 없음」으로 보고 그 서버(serverKey)로는 다시 보내지 않고 해당 칸을 숨겨요. `level`·`mutedUntilMs` **쓰기**의 422도 그 서버를 「기능 없음」으로 표시하고 사용자에게 알려요(조용한 폴백 금지: 음소거가 걸린 줄 알았는데 안 걸린 장면을 막아요). `Channel`에 `notificationLevel`이 없으면 `mentions`로 읽어요(`packages/momo-core/src/features/readState/viewingBeat.ts:14`와 같은 규칙) | — | 구 본문 호환·옛 서버 시험(수용 기준 38) |
| 활성 신호 | 구 notifier는 신호를 모름 | 구 클라이언트는 신호를 안 보내서 지연이 없어요(오늘) | 20초마다 404가 반복되지 않아요(위 규칙) | — | 신호 없음 = 즉시 |

## 보안·경계 요약

- 새 자격 증명도 새 BYPASSRLS 역할도 없어요. 새 공개 API는 모두 사람 bearer이고 에이전트는 403이며, API가 하는 새 쓰기는 모두 `momo_app`(NOBYPASSRLS) tx예요. 키워드 투영(`message_keyword_hit` INSERT)은 **메시지를 쓰는 역할의 tx 안**(`with_tenant_tx`, GUC 설정)에서 돌아요: REST·예약 전송은 `momo_app`이고, 에이전트의 말은 `momo_worker`(BYPASSRLS)예요. 새 역할도 새 RLS 우회 경로도 없고, agent-worker는 AGENTS.md가 유지하는 기존 예외(메시지 INSERT)에 표 둘(읽기 하나·쓰기 하나)이 더해질 뿐이고, 투영 SQL은 `workspace_id` 술어를 명시해요(BYPASSRLS 연결에서는 GUC가 보호가 아니에요). notifier(상주 BYPASSRLS 소비자, ADR-0208 `:29`)는 **새로 쓰는 것이 없어요**: 자기가 쓰는 시스템 줄은 `Text`가 아니어서(필요하면 호출 쪽이 건너뛰어서) 투영하지 않고 키워드 표 둘에 INSERT 권한이 없고(위 DB 계약, 수용 기준 35), `message_keyword_hit`은 판정이 읽기만 해요. `push_dispatch_log`와 `push_system` claim은 기존 권한이에요.
- **id-only 경계가 유지돼요**(ADR-0120 D2). 새 reason의 relay 문구는 정적 문자열이고 사용자 내용·이름이 없어요. 시험·예약 실패의 봉투는 nil-UUID 센티널이에요.
- **키워드는 서버에 평문으로 저장돼요.** 문구는 props·감사·로그, 그리고 다른 멤버가 받는 응답·페이로드에 남기지 않아요(D3. 본인의 키워드 API 응답은 본인 목록이에요). 일치 표는 메시지 읽기 API가 건드리지 않아요. `momo_app` 자격이 SQL 수준으로 새는 위험은 GUC 신뢰 모델 전체가 무너지는 사고와 같은 종류라 수용해요(ADR-0208 남는 위험 3과 같은 판단).
- **시험 알림은 본인 토큰에만 가고** 분당 3회로 막아요. 판정을 우회하지만 대상은 호출자 하나뿐이라 남에게 푸시를 보내는 길이 아니에요.
- **승인 푸시를 끄려면 확인 토큰이 필요해요**(D5). 보안 장치가 아니라 확인 단계를 빼먹은 클라이언트의 실수를 막는 프로토콜 수준의 가드예요. 끈 동안은 「승인 알림이 꺼져 있어요」 한 줄이 상시 보여요.
- **relay 서버 한도는 공유 예산이에요**: 대량 층(`channel_message`·`keyword`)은 (멤버, 채널) 창·서버 전체 예산·best-effort 층(429 재시도 없음)으로 격리하고, 시험 알림도 best-effort예요(D7·D11).
- **활동 신호는 읽는 API가 없고** 위조해도 자기 푸시를 늦출 뿐이에요(남에게 영향이 없어요). 지연은 한 번이고 상한이 있어서(최대 300초) 푸시를 영구히 막을 수 없어요.
- **NSE는 App Group을 읽기만 해요.** 새 네트워크 읽기 경로가 없어서 `push_fetch`의 읽기 둘은 그대로예요(ADR-0188 §8.7). 사용자 소리 파일은 본인 기기 밖으로 재생되지 않아요(D2).
- 구 relay에 새 어휘가 가면 푸시가 사라지는 위험은 배포 순서와 진단(`relay_outdated`)으로 막아요(D14·D11).

## 수용 기준 (red proof)

구현 슬라이스가 지켜야 하는 시험이에요. 각 행은 **한 조건만 거짓**으로 만들어 빨강이 되는지(사보타주)를 PR 본문에 적어요. 모두 격리 PG·stub relay로 돌고 실제 APNs에는 닿지 않아요. 시간이 걸리는 판정은 시계를 주입하거나 `NOTIFIER_MAX_ATTEMPTS` 같은 설정을 낮춰서 돌려요.

| # | 슬라이스 | 고정할 것 | 사보타주(이렇게 깨면 빨강) |
|---|---|---|---|
| 1 | #4341 | 진단 코드를 각각 격리 PG에서 재현해 돌려줘요(총 8건: #4341이 6건 — `paused`·`channel_muted`·`no_device`·`token_invalidated`·`relay_unreachable`·`last_delivery_failed` —, `kind_off`는 N3가 행 27에서, `quiet_hours`는 N7이 행 28에서 더해요). `ok`는 blockers가 없을 때만 true예요. 볼 수 없는 채널의 `channelId`는 404예요 | 코드별 조건을 반대로 하면 그 코드의 시험이 빨개요. `channelId` 권한 검사를 빼면 404 시험이 빨개요 |
| 2 | #4341 | `POST …/test`는 일시 중지 중에도 호출자 토큰에 `apns_status=200` 행을 5초 안에 남기고 그 행의 `message_id`는 NULL이에요 | 시험을 `judge_targets`로 돌리면 「일시 중지 중에도 도착」 시험이 빨개요 |
| 3 | #4341 | 두 멤버가 있을 때 호출자만 받아요. 에이전트 bearer 403, 활성 토큰 없음(행이 없거나 전부 무효) 409. 멤버당 분당 3회: 동시에 5건을 보내면 정확히 3건이 통과하고 나머지는 429예요 | 멤버 필터를 지우면 두 번째 멤버가 받아 빨개요. 행 잠금을 빼면 4건 이상 통과해 빨개요 |
| 4 | #4341 | `lastTest`: stub relay가 **어휘 거절** 400을 주면 `relay_outdated`이고 재시도가 없어요. **환경 불일치** 400은 `failed`예요. 기기 둘이 200·410이면 `sent`예요. 기록이 없고 30초 미만이면 `queued`, 30초 이상이면 `stalled`(notifier를 끈 채 시험)예요. 상태는 `last_test_id`의 `t:` collapse id 정확 조회로 읽어요. `apnsReason`은 APNs 코드나 `relay_*` 코드뿐이고 relay 문구는 없어요 | 환경 불일치도 `relay_outdated`로 부르면 빨개요. relay 본문을 그대로 내보내면 빨개요. 상태 계산이 outbox 행을 읽게 하면(또는 `stalled` 칸을 빼면) 해당 시험이 빨개요 |
| 5 | N0·N16 | 새 reason·category의 relay 출력은 정적 문구뿐이에요(`dispatch_payload_is_id_only`·`…has_no_content_shaped_key` 확장). 선택 키 `priority`(N16)는 `approval_request`이고 `approvalTimeSensitive`일 때만 `interruption-level`로 실려요 | 문구에 채널 이름을 끼우면 빨개요. 다른 reason에도 `priority`를 실으면 빨개요 |
| 6 | N0 | Rust·relay·Swift 둘(`PushNotification.swift`·`MomoPushActionCore.swift`)·RN의 reason·category 목록이 같고 category마다 `CATEGORY_SOUNDS` 행이 있어요. `verify_push_relay.sh`의 슬롯 산수가 새 어휘로도 429 단계를 정확히 한 번 만들어요 | 한 면에서 값 하나를 빼면 빨개요 |
| 7 | #4343 | (이슈 본문) 구 본문 호환 · 과거 400 · `until = now+2s`면 t0 후보 0건·t0+3s의 새 후보 1건 · 목록의 `mutedUntilMs`는 진행 중일 때만 · audit · openapi. 더해서 366일 초과 400, `muted:false`+기한 400 | 만료 비교 방향을 뒤집으면 빨개요 |
| 8 | N1 | `all` 수신자는 타인의 최상위 `text` 글 1건당 토큰별 1건이에요. 본인 글·스레드 답·`tool_call`·스트림 중 줄·DM 채널은 제외하고 스트림은 닫힐 때 1건이에요. `channelAll.phone`을 끄면 0건이에요 | `root_id IS NULL` 조건을 지우면 스레드 답 시험이 빨개요 |
| 9 | N1 | 단계 `all` + 기한 음소거는 기한이 지나면 `all`로 돌아와요. `{level:"mentions"}`는 두 행을 지우고, 구 `{muted:false}`는 단계 행을 남겨요 | 음소거가 단계 행을 지우면 빨개요 |
| 10 | N1 | 단계 행이 있는 채널이 **읽는 곳 다섯 모두**에서 `muted=false`예요(판정 포함). DM 채널에는 단계 행이 API로 안 생겨서(`all`은 400) `dm.rs` 두 읽는 곳은 직접 INSERT한 행으로 시험해요 | 단계를 `notification_pref`에 넣는 구현이면 빨개요 |
| 11 | N1·N5 | 한 멤버(토큰 하나)에게 같은 채널의 대량 층 푸시가 20건 연달아 오면(`channel_message`와 `keyword`를 섞어도) `push_dispatch_log`가 7건이에요. 7번째의 문구는 묶음(`o:` 접두)이에요. 접힌 메시지의 `m:<message_id>` 행은 남지 않아요(클레임 전에 갈라요). 재판정(requeue·스트림 둘째 후보)에서 이미 나간 개별 푸시를 묶음으로 다시 세지 않아요(`keyword` 혼합은 N5가 같은 시험에 더해요) | 상한을 7로 올리면 빨개요. 카운트를 `claim_dispatch` 뒤에 두어 접힌 건이 `m:` 행을 남기면 빨개요 |
| 12 | N1·N5 | **relay 예산**: stub relay 한도를 8로, 시험에서 `NOTIFIER_BULK_PUSH_PER_MINUTE`도 낮춰요. 대량 층(`channel_message`, `keyword`는 N5가 더해요) 홍수(100건)가 승인·멘션 푸시보다 **먼저** 처리되는 순서에서도 승인·멘션은 200을 받아요. 서버 전체 예산을 넘은 대량 층 푸시는 보내지 않고 done이며 `m:` 행이 남지 않아 2분 뒤에도 진단이 `relay_unreachable`을 내지 않아요. 대량 층이 relay 429를 받으면 재시도 0회이고 그 행은 `apns_status=429`·`relay_http: dropped`로 정산돼 진단(D11)이 `ok`예요. 합침·예산 초과·429 드롭은 로그 카운터로 세어져요 | 예산을 지우면 승인이 한도에 걸려 빨개요. 429를 재시도로 바꾸면 빨개요. 드롭 행을 진단이 세면, 예산 초과 건이 NULL 행을 남기면 빨개요 |
| 13 | N5 | 일치하는 멤버에게만 hit가 생기고 작성자·퇴장·비멤버·DM 채널은 빠져요. 에이전트 worker 줄(`send_message_in_tx`)도 투영되고, 스트림은 열린 동안 0건·닫힐 때 1건이에요. 편집은 재투영하지 않아요. notifier가 쓰는 만료(`ToolResult`)·멈춤(`System`) 줄은 투영 대상이 아니고, 서버가 `Text`로 쓰는 문구를 호출 쪽이 건너뛰게 하면 hit 0건이에요. 이 검사는 키워드 표를 읽기 전에 해요 | 투영을 REST 경로에만 두면 에이전트 시험이 빨개요. `Text`로 쓴 서버 문구를 투영하면 빨개요. 키워드 표를 먼저 읽고 거르면 notifier 줄이 권한 오류로 빨개요 |
| 14 | N5 | 정규화: 전각·대소문자·한국어 부분 문자열이 맞고, 1글자·33글자·21번째 키워드는 400이에요 | 정규화를 빼면 전각 시험이 빨개요 |
| 15 | N5 | **비용 상한**: 본문 4,001번째 글자에만 있는 키워드는 hit가 없고 4,000번째까지는 있어요(자른 뒤 정규화). 채널 안에서 같은 패턴을 가진 멤버가 여럿이어도 패턴은 한 번만 검사하고(단위 시험이 비교 횟수를 세요) hit는 멤버마다 생겨요. 패턴 수가 많아도 투영을 건너뛰는 경로가 없어요(고유 패턴 1,000개짜리 채널에서도 모든 멤버의 hit가 생겨요) | 4,000을 지우면 빨개요. 패턴 수 상한으로 건너뛰는 구현이면 1,000개 시험이 빨개요. 멤버마다 검사하면 비교 횟수 시험이 빨개요 |
| 16 | N5 | 메시지 읽기 API·실시간 페이로드·감사, 다른 멤버가 받는 응답에 hit와 키워드 문구가 없어요. `notification_keyword`를 읽는 SQL은 키워드 API와 투영 모듈뿐이에요(소스 시험) | hit를 `props`에 쓰면, 다른 모듈이 읽으면 빨개요 |
| 17 | N5 | `keyword` arm: 음소거 관통은 기본 켬이고 스위치를 끄면 억제돼요. 일시 중지·근무 시간 밖은 관통하지 못해요. `keyword.phone`을 끄면 0건이고, `mentionHuman`을 끈 사람의 메시지가 키워드에도 걸리면 `keyword`로 내려가요. `judgment_projection.rs`(본문 미독)가 통과해요 | 관통 조건에서 일시 중지 검사를 빼면, 내려가기를 빼면 빨개요 |
| 18 | N5 | **잠금 보유 시간**: 활성 100명 × 키워드 20개(고유 2,000개)와 1,000명 × 20개(고유 20,000개) 두 규모에서 아래 입력의 INSERT p95 증가를 재서 PR 본문에 적어요(목표 5ms 이하 `[추정]`): 보통 길이 본문, 4,000글자 이상 + 일치 없음(스캔 최악), 멤버 전원이 같은 2글자 키워드 하나를 공유하는 채널(쓰기 최악: 메시지 한 건에 hit 1,000행). 목표를 넘는 규모는 지원 범위 밖으로 선언하고 쓸 때 거절하는 공개 상한을 증보로 정해요(D3). 필요하면 매칭(읽기)을 `insert_message_in_tx` 앞에서 미리 계산해 잠금 구간에는 hit INSERT만 남기는 구현도 허용해요 | — (측정 기록) |
| 19 | N11 | 활성 신호가 있는 멤버의 DM은 즉시 0건이에요. 지연 안에 읽으면 끝까지 0건이고, 안 읽으면 `T + 60초`에 1건이에요. DM의 에이전트 스트림 줄은 DM·명시 멘션 arm이 스트림을 보류하지 않아서 `T`가 시작(삽입) 시각이에요 | 취소 조건을 빼면 읽은 DM이 가서 빨개요. DM 스트림의 `T`를 닫힌 시각으로 하면 빨개요 |
| 20 | N11·N12 | 신호 없음·`phoneDelaySecs=0`·승인·작업 끝남·`resume_offer`·`scheduled_failed`·`test_notification`·`macos` 토큰은 지연이 없어요(오늘과 같아요). 신호(N12)는 창이 앞이고 마지막 입력이 5분 이내인 동안만 20초 이하 주기로 가고, 잠금·절전·종료와 폰은 보내지 않아요 | 승인을 지연하면 빨개요. 시스템 푸시를 지연하면 빨개요. 입력이 5분을 넘었는데 신호를 보내면, 폰이 신호를 보내면 빨개요 |
| 21 | N11 | **attempts 복원**: `NOTIFIER_MAX_ATTEMPTS=2`로 낮추고 두 멤버(지연 60·300)로 후보를 두 번 지연시킨 뒤 세 번째 처리에서 stub relay가 재시도 층 대상(DM·멘션)에 429를 주면 후보는 `pending`(requeue)으로 살아 있어요 | 복원을 빼면 세 번째 처리의 `attempts=3 ≥ 2`라 `failed`가 되어 빨개요 |
| 22 | N11 | **한 번만 지연**: 만기 뒤 활동이 남아 있어도 다시 보류하지 않고 읽지 않았으면 보내요 | 재판정이 활동을 다시 보면 빨개요 |
| 23 | N11 | 대상이 섞인 후보(A 즉시·B 지연)에서 A가 중복되지 않아요 | 만기 재판정이 이미 보낸 A를 `claim_dispatch` 건너뛰기 없이 다시 보내면 A가 두 번 가서 빨개요 |
| 24 | N11 | 다시 시도하는 대상(DM·멘션)의 일시 오류(relay 429)와 보류가 한 후보에서 겹치면 `requeue`(백오프, `attempts` 유지)가 이기고 `available_at`은 둘 중 이른 값이에요. 대량 층 대상의 429는 `requeue`를 만들지 않아요 | `defer`가 이기면 빨개요. 대량 층의 429가 `requeue`를 만들면 빨개요 |
| 25 | N11 | 보류 중 메시지가 삭제되거나 채널이 보관되면 만기에 푸시가 없어요 | 삭제 검사를 빼면 빨개요 |
| 26 | N11 | 경계: 만기 직전·직후, 활동 29초·31초, 읽음 커서 경계. 다른 워크스페이스의 활동은 영향이 없어요. 스트림을 보류하는 arm의 `T`는 닫힌 시각이에요(지금 있는 에이전트의 답 arm으로 시험하고, `keyword`·`channel_message`는 N5·N1이 같은 시험에 더해요). `available_at`이 미래인 pending은 `oort doctor` outbox 점검이 FAIL로 세지 않아요(`test_oort_doctor_outbox.sh`) | 비교를 한 칸 옮기면(29초 → 31초, `>=` → `>`) 해당 경계 시험이 빨개요. `T`를 항상 삽입 시각으로 하면 스트림 시험이 빨개요. 미래 pending을 FAIL로 세면 doctor 시험이 빨개요 |
| 27 | N3 | 여섯 종류(`dm`·`mentionHuman`·`mentionAgent`·`agentAnswer`·`approval`·`workDone`)를 각각 꺼서 그 종류의 폰 푸시가 0건이에요. **DM 채널(에이전트와 1:1)에서도** `approval.phone`을 끄면 승인 카드가 `dm` 푸시로 되살아나지 않고, `workDone`을 끄면 에이전트 답이 `dm`으로 되살아나지 않고, `dm`을 끄면 그 채널의 에이전트 답도 0건이에요. `approval.phone`을 true→false로 바꾸는 PATCH는 `confirm` 없이 400이고 있으면 200과 `warnings`·감사예요. `workDone.phone`은 `work_complete_push`와 같은 값이에요. 행 부재 = 오늘 기본값(데스크탑 DM 끔 포함)이에요. `kind_off` 진단(종류 스위치가 꺼짐)을 재현해요. 해당 없는 표면 칸(`keyword.desktop`)을 쓰는 PATCH는 400이에요 | `confirm` 검사를 빼면 빨개요. 메시지 모양 arm이 꺼졌을 때 다음 arm으로 내려가게 하면 DM 채널 시험이 빨개요. 해당 없는 칸을 받아들이면 빨개요 |
| 28 | N7 | 창 밖 푸시는 0건이에요(`passThrough`의 승인만 통과). **일시 중지는 `passThrough`도 이겨요**. `quiet_hours` 진단(창 밖이고 관통 종류가 아닐 때)을 재현해요 | 일시 중지 우선순위를 뒤집으면 빨개요 |
| 29 | N7 | DST는 America/Los_Angeles의 봄·가을 경계로 시험하고 Asia/Seoul은 고정 오프셋 대조군이에요. 자정을 넘는 창은 요일이 시작일이에요. `start == end`는 400이에요 | 요일 기준을 현재 날짜로 바꾸면 빨개요. DST를 고정 오프셋으로 계산하면 LA 경계 시험이 빨개요 |
| 30 | N7 | `tz`는 `pg_timezone_names`의 이름만 받아요(`PST`·`UTC+9`는 400이고 `Etc/GMT+5`는 통과해요). **저장된 잘못된 zone이 판정을 깨지 않아요**(일정 없음으로 보고 로그) | 오류를 NULL로 바꾸는 함수를 빼면 판정이 실패해 빨개요 |
| 31 | N13 | 예약이 시스템 사유로 `failed`가 되는 tx를 롤백하면 푸시 행도 없어요. 전이마다 정확히 1건이고 보류 일괄은 호출당 1건이며 보류가 0건인 호출(`hold_*`는 보안 사건마다 불려요)은 푸시 0건이에요. **사용자가 직접 낸 거절(`actor=Member`)은 0건**이에요 | 푸시를 tx 밖에서 쓰면, actor를 안 보면 빨개요 |
| 32 | N13 | **같은 예약이 실패 → 다시 걸기 → 실패하면 푸시가 2건**이에요(`rev`가 collapse id에 들어가요). 재시도가 분 경계를 넘어도 보류 일괄은 한 건이에요(collapse id는 생산자가 payload에 실어요) | collapse id에서 `rev`를 빼면 빨개요. 소비자가 처리 시각으로 분 번호를 만들면 빨개요 |
| 33 | N13 | 일시 중지·근무 시간 밖·`scheduledFailed.phone` 꺼짐은 조용히 done(기록 없음)이에요. 채널 음소거는 무시돼요. 발송 기록은 `message_id NULL`이에요. relay 429에서 예약 실패 푸시는 `requeue`되고(재시도 층) 시험 알림은 되지 않아요(best-effort) | 음소거를 적용하면 빨개요. 예약 실패를 best-effort로 다루면(429에서 버리면) 빨개요 |
| 34 | N0·N13 | 폰 탭: `test_notification`은 설정 화면으로 가고 `scheduled_failed`는 nil `message_id`로 점프하지 않고 채널(또는 「예약됨」 목록)로 가요(`pushTap.test.tsx`) | 센티널 id를 메시지로 찾게 하면 빨개요 |
| 35 | #4341·N5 | notifier prod-role 시험(`scripts/verify_notifier_prod_roles.sh`)에서 notifier가 쓰는 만료·멈춤 줄은 hit를 만들지 않고, notifier 역할은 `message_keyword_hit`에 SELECT만 있고 INSERT·DELETE가 없어요(`notification_keyword`는 권한 자체가 없어요). `push_system` claim은 `push_candidate`를 가져가지 않고 LISTEN이 `push_system`도 깨워요. `oort doctor`는 `push_system`에 위 분류(relay 미구성 info, 구성 시 나이 기준)를 적용해요 | notifier 줄의 타입을 `Text`로 바꾸고 건너뜀을 빼면 hit가 생기거나 권한 오류로 빨개요. GRANT가 INSERT를 주면 prod-role 시험이 빨개요. 깨움을 빼면 빨개요 |
| 36 | #4345 | 5초 초과 400 · PCM16 외 400 · 300KiB 초과 400 · 21번째 400 · 교차 테넌트 404 · 에이전트 403 · 해시 불일치 400 · 삭제 뒤 매핑이 기본음 · 멤버 제거 CASCADE | 검증 하나를 빼면(예: 길이 검사) 그 조건의 시험이 빨개요 |
| 37 | N4 | 일시 중지·근무 시간 중 배너 0건이에요. 멘션 예외 on이면 음소거 채널의 멘션 배너가 뜨고 off면 안 떠요. 올리는 키는 넷뿐이고 `pane-waiting`·`reminder`·`dockBadge`·`dockDm`은 PATCH 본문에 없어요. 데스크탑 `channelAll` 배너도 6건/분을 넘으면 합치고 그 상수가 Rust 쪽 상수와 같아요(일치 시험) | 멘션 예외 입력을 지우면 빨개요. 한쪽 상수를 바꾸면 일치 시험이 빨개요 |
| 38 | N4·N12·#4342 | **새 앱 + 구 서버**: 활동 신호 404·405는 그 서버로 다시 보내지 않고, 설정 칸의 404는 칸을 숨기고, `level`·`mutedUntilMs` 쓰기의 422는 그 서버를 「기능 없음」으로 표시하고 사용자에게 알려요(조용한 폴백 금지), `Channel`에 `notificationLevel`이 없으면 `mentions`로 읽어요(`viewingBeat.ts`와 같은 규칙) | 404를 재시도하면 빨개요. 422를 조용히 무시하면 빨개요 |
| 39 | N9·N10 | 소리 끔 → 배너 유지 / 배너 억제 → 소리 없음 / 기본 소리가 종류마다 다름. NSE는 파일 없음·30초 이상·네트워크 없음에서 기본음이고 `o:` 접두 봉투는 묶음 문구예요. 대상 메시지가 채널 최근 200건 밖이면 자리표시 「새 알림」으로 퇴화하고 탭하면 그 채널로 가요(D4의 한계). 스파이크 3건의 결과를 기록해요 | 소리 끔이 배너까지 막게 하면(I1) 빨개요. NSE가 `o:` 접두를 무시하면 묶음 문구 시험이 빨개요 |
| 40 | 새 공개 경로 전부 | 에이전트 bearer가 403이에요(진단 GET·시험 POST·prefs GET/PATCH·키워드 GET/PUT·활동 PUT). `member_activity`를 읽는 공개 API가 없어요(라우트 목록 시험) | 한 경로에서 `require_human`을 빼면 빨개요 |

## 구현 슬라이스와 이슈 편성안 (보고서 §5의 28건을 이 ADR 기준으로 다시 묶음)

N-번호는 아직 발행하지 않은 새 이슈예요(발행은 planner, 초안은 PR 본문 「새 이슈 초안」). 이미 있는 이슈는 번호를 적었어요.

| 묶음 | 보고서 항목 | 이슈 | 트랙 | 의존 | 규모 | 결정 |
|---|---|---|---|---|---|---|
| **A 신뢰 복구** | P0-1 ADR | #4223(이 PR) | 엔진(docs) | — | M | 전부 |
| | P0-2 진단·시험 | #4341 | 엔진 | N0 (`kind_off`·`quiet_hours` 코드는 N3·N7이 켜요. 시험 알림 컬럼은 자기 migration M-b1) | M | D11·D15 |
| | P0-3 상태·시험 화면 | #4342 | UXUI | #4341, #3923, #2684 | M | D11 |
| | P0-4 음소거 기한 | #4343 | 엔진 | — | S | D12 |
| | P0-5 채널 음소거 기한 화면 | #4344 | UXUI | #4343 | M | D12 |
| | P0-6 배너 일원화 1단계 | #4197(끝남)·후속 #4212 | UXUI | — | S | D17 |
| | (새) 푸시 어휘 증보, relay 먼저 | N0 | 엔진(앱 상수는 최소 diff) | — | M | D14·D15 |
| **B 전달 세밀도** | P1-1 채널 단계 | N1 | 엔진 | N0, #4343, #4341 (수용 기준 12가 진단을 읽어요) | L | D7 |
| | P1-2 채널 알림 시트 | N2 | UXUI | N1, #4344 | M | D7·D12 |
| | P1-3 종류×표면 저장 | N3 | 엔진 | #4341 (`kind_off` 진단 시험이 진단 GET을 읽어요) | M | D5·D13 |
| | P1-4 설정 매트릭스 화면 | N4 | UXUI | N3, N1 (`channelAll` 배너가 단계를 읽어요) | L | D5·D17 |
| | P1-5 키워드 | N5 | 엔진 | N0, N1 (대량 층 상한·예산 함수), N3 | L | D3 |
| | P1-6 키워드 화면 | N6 | UXUI | N5 | M | D3 |
| | P1-7 근무 시간 | N7 | 엔진 | N3 | M | D13 |
| | P1-8 근무 시간 화면 | N8 | UXUI | N7, #3923 | M | D13 |
| **C 표현** | P1-9 번들 소리·재생 | #4222(자산·macOS 기본음) + N9(선택·미리 듣기·재생) | UXUI | N3, #4222 | L | D10·D18 |
| | P1-10 iOS 소리 | N10 | UXUI(iOS) | N9 | L | D18 |
| | P1-11 앱이 앞에 있을 때 | #4310 | UXUI | N9 | M | #2592 |
| **D 타이밍** | P1-12 데스크탑 활성 시 폰 지연 | N11(서버) + N12(클라이언트 신호·지연 설정) | 엔진·UXUI | N0, N3 | L·S | D4 |
| **E 직접 넣기** | P2-1E·1U 사용자 알림음 | #4345 | 엔진·UXUI | N9, N10 | L·L | D2 |
| | P2-3E·3U 규칙 빌더 | #4345 + ADR-0207 | 엔진·UXUI | N3, N5, N7, N14 | L·L | D16·D20 |
| **F 관통·우선순위** | P2-2E·2U 발신자 규칙 | N14·N15 | 엔진·UXUI | N3, N9 | M·M | D19 |
| | P2-4E·4U Time Sensitive | N16·N17 | 엔진·UXUI(iOS) | N0, N3 (`approval_time_sensitive` 컬럼), owner Apple 작업 | M·M | D6 |
| | P2-6 Focus Filter 스파이크 | N19 | UXUI(iOS) | N17 | S | 스파이크 |
| **G 시스템 푸시** | (새) 예약 실패 푸시 | N13 | 엔진 | N0, #4341, N3, N7 (게이트가 종류 스위치·근무 시간을 읽어요). 탭 목적지 「예약됨」은 ADR-0208의 폰 UI(#4216)가 있을 때 | M | D15 |
| | P2-5 다이제스트 | N18 | 엔진 | ADR 증보, N3, N7 | L | D20 |

- **새 슬라이스 셋**(보고서 28건에 없던 것): N0(어휘 증보를 relay 먼저 한 번에, `clients/mobile/**` 상수는 TRACKS의 「최소 diff + 상대 트랙에 로그」로 같은 PR에서 바꿔요), N12(웹·데스크탑이 활성 신호를 보내는 클라이언트와 지연 설정 화면 — 보고서 P1-12는 서버만 적었어요), N13(ADR-0208 D8의 예약 실패 푸시).
- **기존 이슈 정정 제안**: #4341은 `push_test` → `push_system`·어휘는 N0로 분리·경로를 `…/notification-diagnostics/test`로·의존에 N0 추가·시험 알림 컬럼 4개는 자기 migration(M-b1)·`lastTest`는 `last_test_id` 정확 조회. #4344는 폰에 무기한 토글이 이미 있으니(`useChannelRowActions.ts:240-257`) 「폰 신설」을 「폰 기한 선택·채널 헤더·3표면 프리셋」으로. #4343은 의존을 「ADR-0124 증보 4」 대신 이 ADR(D12)로. #4222는 소리 슬롯 이름을 D10에 맞춰요. #4353은 「## 항목」 체크리스트가 비어 있어 위 표로 채워요.
- 각 슬라이스의 완료는 위 「수용 기준」 행과 해당 표면 게이트(폰·웹·Rust)예요. UI 슬라이스는 design-review Blocker 0·High 0이에요. 어느 슬라이스든 구현 PR은 이 ADR이 Accepted인 뒤에만 머지해요(ADR-0100).
- 함께 고칠 문서: `docs/architecture/overview.md:51`(푸시 후보 서술에 `push_system` 한 줄), `docs/api/openapi.yaml`(초안을 실제 서버에 맞춰 확정), `docs/cicd/11-ios-push-device-check.md`(소리·시험 알림 실기기 칸).

## 기각한 대안

| 결정 | 대안 | 기각 이유 |
|---|---|---|
| D7 | `notification_pref.level` 컬럼(리서치) | 「행이 있으면 음소거」를 읽는 곳이 다섯이고 롤백한 서버가 `all`을 음소거로 읽어요 |
| D7 | 음소거가 단계 행을 지워요 | 「1시간만 끄기」가 끝나도 이전 단계(`all`)를 영영 잃어요 |
| D3 | `props.keyword_member_ids`(리서치) | props는 채널 멤버가 읽어서 남의 키워드를 알아낼 수 있어요 |
| D3 | notifier가 판정 때 본문을 읽어 매치 | I2 위반이고 BYPASSRLS 읽기 범위가 커져요 |
| D3 | REST 경로에서만 투영(멘션과 같게) | 에이전트 발화(키워드의 주 쓰임)가 빠져요 |
| D3 | 키워드를 해시로 저장 | 부분 문자열 매치가 안 돼요 |
| D4 | A 적용 안 함 · B 억제(Buzz 초안) | 이슈 결재. B는 자리를 비운 사람이 놓쳐요 |
| D4 | 지연을 SQL 한 문장에 넣어요 | 문장이 더 비대해지고 활동·읽음 보조 조회가 필요하며 진단이 재사용하지 못해요 |
| D4 | 보류를 `push_dispatch_log` 행으로 기록해요 | 억제는 기록을 남기지 않는다는 규칙(ADR-0124 D2)과 어긋나고 정리가 필요해요 |
| D4 | 지연마다 `attempts`를 써요 | 지연 뒤에 일시 오류가 나면 재시도 예산이 이미 깎여 있어 후보가 일찍 `failed`로 접혀요 |
| D15 | 시험 전용 `push_test` kind + 예약 실패 별도 kind | kind가 늘어 claim·reclaim·문서가 세 벌이에요 |
| D15 | `push_candidate`에 `source` 키로 얹기(스트림 닫힘 선례) | 판정이 메시지를 읽는 hot path에 메시지 없는 후보가 섞이고 D8-a 생산자 규칙이 발동해요 |
| D15 | api가 relay에 직접 보내기 | api에는 relay 키·클라이언트가 없고 서명 키 노출면이 넓어져요 |
| D15 | `message_id` 자리에 예약 id | NSE·앱이 메시지 id로 오해해요 |
| D15 | 새 선택 키 `subject_id` | ADR-0120 변경이고 relay 먼저예요. 채널 이동에는 `channel_id`로 충분해요 |
| D15 | collapse id를 `s:<예약 id>`만으로 | 유일 인덱스에 시간 항이 없어 다시 걸었다가 또 실패한 푸시가 사라져요. `rev`를 넣어요 |
| D15 | 사용자가 직접 낸 실패도 푸시 | 응답이 이미 사유를 말해요(중복·소음) |
| D11 | 시험 알림 속도 제한을 `push_system` 행 세기로 | 끝난 행이 인덱스에 안 잡혀 표를 훑어요. `notification_rule` 행 잠금 카운터로 해요 |
| D7 | 서버 전체 예산 없이 (멤버, 채널) 상한만 | relay 한도(분당 60)는 서버 전체라 멤버 여럿이 승인·멘션을 굶겨요 |
| D5 | 서버가 발급한 nonce를 요구하는 확인 | 사람 bearer 앞의 UI 규칙을 서버가 강제할 수 없어서 마찰만 늘어요. 프로토콜 수준 가드로 두고 상시 표시로 보완해요 |
| D3 | 투영을 본문 길이 상한 없이 | 채널 행 잠금을 쥔 채 도는 비용이 2 MiB 본문에서 초 단위로 커져요 |
| D3 | 채널의 고유 패턴이 N개를 넘으면 그 메시지의 투영을 건너뜀 | 키워드 알림이 사용자도 진단도 모르게 사라져요(Buzz B1을 새로 만들어요). 본문 4,000글자 상한 + 두 규모 측정으로 묶고, 넘으면 쓸 때 거절하는 공개 상한을 증보로 정해요 |
| D3 | notifier가 쓰는 시스템 줄도 투영 | BYPASSRLS 역할인 notifier에 키워드 표 쓰기 권한이 생겨요. 고정 문구라 가치가 낮아요 |
| D3 | 데스크탑 키워드 배너를 클라이언트 재매칭으로 | D17(서버가 모르는 규칙 금지)·D3(클라이언트 일치는 표시용)과 부딪혀요. 매칭 함수를 코어에 두는 증보가 먼저예요 |
| D5 | 꺼진 종류는 항상 다음 arm으로 내려가요 | DM 채널의 승인 카드가 `dm` 푸시로, 꺼진 작업 끝남이 `dm`으로 되살아나요 |
| D7 | `keyword`를 대량 층 밖(재시도 층)에 | 뜨거운 키워드가 relay 한도를 먹고 승인·멘션을 굶겨요 |
| D14 | 새 reason마다 새 category(구 앱에서 버튼 없음) | 어휘와 앱 등록이 늘고 N0가 커져요. 구 앱의 답장 유실은 새 기능을 켠 사용자가 구 빌드 폰을 쓰는 동안만이에요(남는 위험 12) |
| D13 | 일정 시각을 Rust(`chrono-tz`)로 계산 | 새 의존이고 시간대 DB가 둘이 돼요 |
| D13 | 새 표 `notification_prefs` | `notification_rule`이 이미 (워크스페이스, 멤버) 행이에요 |
| D2 | 서버 ffmpeg 변환 | permissive 라이선스 규칙·이미지 의존·공격면 |
| D2 | Drive 저장 · 팀 공유 라이브러리 | 외부 의존·권한 복잡 · 불쾌한 소리 문제 |
| D18 | `aps.sound`에 파일명 | relay가 멤버별 선택을 알게 되고 파일이 없을 때 동작이 불확실해요 |
| D5 | 승인은 끄지 못하게 유지(C) | 세밀도 요구에 어긋나요. 경고와 확인 토큰으로 보완해요 |
| D6 | A 기본 켬 · C 도입 안 함 | 이슈 결재. HIG상 남용하면 앱 단위로 꺼져요 |
| D9 | 계정 단위 새 표 | 새 테넌트 경계라 RLS·ADR 비용이 커요 |
| D14 | reason마다 relay 배포 | 호스티드 relay 배포가 네 번이에요 |
| D17 | 서버가 데스크탑 배너도 푸시로 판정 | 데스크탑은 푸시가 없고 실시간 이벤트로 바로 띄워야 해요 |

## 남는 위험

1. **키워드 평문 저장과 SQL 수준 유출**(D3). 화면 고지와 문구 비노출로 줄였고 `momo_app` 자격 유출은 GUC 신뢰 모델 전체의 사고라 수용해요.
2. **활성 신호는 입력 기반 근사**예요(D4). 자리를 비운 사람은 최대 지연만큼 늦게 받아요. 목표 감소율은 가설이에요.
3. **구 relay + 새 reason은 푸시 유실**이에요(D14). 배포 순서와 `relay_outdated` 진단으로 알리지만 순서를 어긴 셀프호스트는 막지 못해요.
4. **`relay_unreachable`은 추론**이라 오탐이 있을 수 있어요(D11). 슬라이스가 격리 PG로 조정해요.
5. **iOS 소리 덮어쓰기·macOS 배너 소리·집중 모드 중 앱 재생은 `runtime-unverified`**예요(D18). 스파이크가 먼저예요.
6. **음소거 아래 단계가 숨어 있어요**(D7). 「끔」 아래의 `all`은 기한이 끝나야 드러나요. 읽기 모델의 `level`은 효과값이고 화면이 「~까지」 칩으로 설명해요.
7. **`message_keyword_hit`은 정리 작업이 없어요.** 메시지 수명을 따르고 행은 일치 건수만큼이에요(약 100바이트). 하루 수만 건이 되면 inbox 보존 소탕(`inbox_retention_sweep.rs`)과 같은 두 풀 모양의 소탕을 후속으로 둬요.
8. **notifier는 self-host 기본 스택에 없어요**(ADR-0208 남는 위험 7). `push_system`·지연·시험 알림은 그 스택에서 동작하지 않아요. 시험 알림은 `stalled`로 알려요.
9. **「모든 새 글」로 에이전트 소음이 생길 수 있고 relay 서버 한도(분당 60, 호스티드·셀프호스트 값이 다를 수 있어요)를 먹을 수 있어요.** 분당 6건 상한·서버 전체 예산·경고로 줄였어요. 한도에 닿으면 429가 약 3분 이어질 때 푸시가 사라져요(기존 reason도 같아요). 대량 층(`channel_message`·`keyword`)과 시험 알림은 best-effort라 재시도 없이 버리고, 나머지는 기존대로 백오프로 다시 시도해요. 시험 알림(멤버 × 분당 3 — 증보 2 「D11 정정」: 한 번이 닿는 기기를 최근 5대로 묶어 5 × 분당 3)은 공유 예산을 쓰는 길이에요.
10. **설정은 이벤트 없이 다음 조회에서 수렴해요.** 다른 기기가 바로 반영하지 않아요(ADR-0177 방식).
11. **허들 시작 푸시(#2767)** 같은 새 푸시가 이 ADR의 종류 표·어휘 규칙을 무시하고 들어올 수 있어요. D20이 규칙을 남겨요.
12. **구 앱 + 새 reason의 답장 유실**(D14). `channel_message`·`keyword` 알림은 구 앱에서 답장 버튼이 달려 뜨고, 그 답장은 오류 없이 버려져요. 새 기능(단계 `all`·키워드)을 켠 사용자의 폰이 구 빌드인 동안만 생겨요. 새 category를 따로 만드는 길은 기각했어요.
13. **NSE는 채널 최근 200건 안에서만 메시지를 찾아요**(D4). 지연 중 200건 넘게 쌓이는 채널에서는 본문 없는 자리표시가 떠요 `[추정]`. NSE의 조회 방식 변경은 `push_fetch` 읽기 경로 변경이라 별도 증보예요.
14. **등록 거절로 생긴 `no_device`**(D11, ADR-0204 증보 4). 서버는 등록 거절 이력을 몰라서 진단이 고칠 길 없는 안내를 할 수 있어요. 클라이언트가 직전 등록 응답을 기억해 안내를 바꿔요. 증보 4가 수용한 한계(#4444 다른 워크스페이스 이전, #4445 오프라인 좀비 등록)와 같은 뿌리예요.
15. **대량 층은 선착순이고 단일 notifier를 가정해요**(D7). 서버 전체 예산을 한 채널이 다 쓸 수 있고, 예산이 차면 키워드 알림도 건너뛰어요(앱 안에는 남아요). 창이 프로세스 메모리라 여러 인스턴스면 상한이 느슨해져요. 채널별 공정 분배와 `keyword` 예약 몫(예: 30 중 10)은 측정 뒤 증보로 정해요. 건너뜀은 로그 카운터로 세어서 운영자가 볼 수 있어요(D7).
16. **키워드 투영 비용은 패턴 수에 상한이 없어요**(D3). 본문 4,000글자 상한과 수용 기준 18의 두 규모 측정으로 묶었고, 목표를 넘으면 조용히 건너뛰는 대신 쓸 때 거절하는 공개 상한을 증보로 정해요.
17. **`push_dispatch_log`는 정리 작업이 없어요**(기존). 진단 질의는 새 색인(M-h)으로 읽지만 표는 계속 커져요. 보존 정책은 이 ADR 밖이에요.
18. **수용 기준의 일부는 착수 PR이 보강해요.** P2 슬라이스(N14·N15·N17·N19)의 행은 없고, 조건이 여럿 든 행(예: 4·20·27·29·37)은 PR 본문에서 조건마다 사보타주를 적어요.

## 증보 1 (2026-10-31 기안, **Accepted** 2026-11-01 — planner 위임 결정, owner 10-31 「참여한 스레드의 새 답글 알림도 좋네. 그러니까 내가 관여한 스레드의 새 답글이 달리면 알림이 오는거지.」 요청 범위, ADR-0100) — 참여한 스레드의 새 답글 알림: 스레드 따라가기 (#4889)

- 발단: owner 10-31 「참여한 스레드의 새 답글 알림도 좋네. 그러니까 내가 관여한 스레드의 새 답글이 달리면 알림이 오는거지.」 Slack은 이슈 #4889가 공식 도움말에서 요약한 대로 내가 시작했거나 답글을 달았거나 멘션된 스레드를 자동으로 따라가고, 따라가는 스레드의 새 답글은 알림 설정(데스크탑·모바일 따로)으로 받고, 직접 따라가기·그만 따라가기도 돼요. 이 증보는 같은 규칙을 oort에 맞춰 정해요.
- 범위: **1단계(#4889, 이 증보와 같은 PR)** 는 설계와 계약이에요: 이 증보 + migration 164(표) + 따라가기 API + 보내기 경로의 자동 따라가기. **2단계(S5)** 가 그 위에 알림 판정(`thread_reply` arm)·notifier·묶음·봉투 시험을 얹어요. 그래서 1단계만 머지되면 표는 쌓이지만 읽는 곳이 없어서 **푸시는 아직 나가지 않아요**(구현 상태와 무관하게 이 증보가 두 단계의 계약이에요).
- 표기: 이 절의 [V]는 `track/engine` `a0ee63bd7`에서 직접 읽은 `파일:줄`이에요. [권장]은 이 증보가 고른 것이고 planner 결재 때 PR 본문에 표로 올려요. [확인 필요]는 구현 전 확인이에요. 번호는 이 절 안에서 F1~F9(결정)·T-1~T-11(시험)로 불러요(본문 D1~D20·수용 기준 1~40과 겹치지 않아요).

### 증보 1이 기대는 사실 [V]

| 영역 | 사실 | 근거 |
|---|---|---|
| 스레드의 모양 | 스레드는 한 단계예요. `message.root_id`가 루트이고 `thread` 행(`reply_count`·`participant_ids`)은 **첫 답글**에서 롤업이 만들어요. `participant_ids`는 답글 작성자의 집합이라 루트 작성자는 답글을 달기 전에는 없고 멘션·「그만」은 담을 수 없어요 | `001_init.sql:202-211`, `message.rs:1833-1880` |
| 지금의 알림 | 판정 arm은 작업·승인·멘션·DM·에이전트의 답이에요. 스레드 답글은 멘션이 없으면 푸시가 없어요. D7의 `channel_message`도 `root_id IS NULL`만 봐요 | `judgment.rs:376-487`, D7 |
| 봉투 | `thread_id`는 이미 `COALESCE(root_id, channel_id)`예요. 폰은 `threadId`가 `channelId`와 다르면 그것을 스레드 루트로 읽고 탭은 그 스레드를 열어요. 잠금 화면 답장은 스레드에 가요 | `judgment.rs:512`, `envelope.ts:165-167`, `tapArrival.ts:240-256`, `notifications.ts:283-296` |
| 멘션 기록 | 서버가 기록한 멘션(`props.mention_member_ids`)은 REST 보내기(`MentionPolicy::Record`)에서만 생겨요. 인용된 사람도 멘션으로 기록돼요(ADR-0148 규칙 5) | `message.rs:712-755`, `read_state.rs:620-743` |
| 보내기 경로 | 모든 생산자가 `finish_send_in_tx`를 지나요. 롤업은 `ThreadPolicy::Maintain`일 때만 올라가고 작업 세션 이벤트 카드는 `Skip`이에요. notifier의 쓰기 줄도 `Skip`이에요 | `message.rs:484-498`·`:681-820`, `scripts/tests/test_notifier_role_grants.sh:315-322`·`:490` |
| 아직 없는 것 | N0 어휘(`PushReason`에 `channel_message`·`keyword` 변종이 없어요)·N1 대량 층과 `notification_channel_level`·N3 종류 스위치(`kinds`)·N11 `member_activity`는 코드와 migration에 없어요 | `dispatch.rs:40-51`, `server/Migrations/`(마지막 161) |

### 결정

#### F1. 따라가기는 (스레드, 멤버)마다 한 행이고 상태가 셋이에요 [권장]
- **표**(migration 164 `164_thread_follow.sql`): `thread_follow (workspace_id, channel_id, root_id, member_id, state, created_at, updated_at)`, PK `(root_id, member_id)`, `state`는 `auto`·`followed`·`unfollowed`(CHECK)예요. FK는 `workspace`·`channel`·`message`(루트)·`member`에 ON DELETE CASCADE이고 RLS는 ENABLE+FORCE `ws_isolation`(141과 같은 모양)이에요. 트리거·아웃박스·브로드캐스트가 없어요. `channel_id`는 판정과 API가 멤버십을 따로 조인하지 않고도 채널을 알게 하려고 둬요.
- **뜻**: **따라간다 = `state`가 `auto` 또는 `followed`**예요. 행이 없으면 따라가지 않아요(I5: 행 부재 = 오늘의 동작). `auto`는 서버가 보내기 때 만든 행, `followed`는 사람이 「따라가기」를 누른 행, `unfollowed`는 사람이 「그만 따라가기」를 누른 행이에요.
- **병합 규칙** — 이 표 하나가 규칙이에요:

  | 쓰기 | 행 없음 | `auto` | `followed` | `unfollowed` |
  |---|---|---|---|---|
  | 자동(보내기 tx) | `auto` 만듦 | 그대로 | 그대로 | **그대로** |
  | 직접 따라가기(PUT) | `followed` | `followed` | 그대로(멱등) | `followed` |
  | 그만 따라가기(DELETE) | `unfollowed` | `unfollowed` | `unfollowed` | 그대로(멱등) |

  자동 쓰기는 `INSERT … ON CONFLICT (root_id, member_id) DO NOTHING` 한 문장이에요. 동시에 쓰면 유일 키가 한쪽을 기다리게 해서 표가 지켜지고, 직접 쓰기는 `DO UPDATE`예요.
- **자격**: **사람 멤버**(`member.kind='human'`·`status='active'`·삭제 안 됨)이고 **그 채널의 현재 멤버**(`left_at IS NULL`)이고 **DM 채널이 아닌** 곳이에요. 에이전트는 따라가지 않아요: 푸시 대상이 사람 멤버뿐이고(`judgment.rs:489-495`의 `mem.kind = 'human'`) 스레드 안에서 에이전트를 부르는 규칙은 이 증보와 상관없어요. DM 채널은 모든 메시지가 이미 `dm` reason이라(D7과 같은 이유) 따라가기가 뜻이 없어요. 자동은 행을 만들지 않고 API는 400 `thread_follow_not_applicable`이에요.
- **나간 사람·삭제**: 채널을 나가도 행은 남고 판정이 `left_at IS NULL`로 걸러서 푸시는 안 가요. 다시 들어오면 따라가던 스레드를 다시 따라가요. 멤버·채널·루트 메시지가 지워지면 CASCADE예요.
- **쓰는 역할**: `momo_app`(API·REST 보내기)과 `momo_worker`(에이전트 worker의 보내기, BYPASSRLS라 모든 SQL이 `workspace_id` 술어를 명시해요: D3와 같은 규칙)예요. **`momo_notifier`는 1단계에서 이 표의 권한이 없어요.** notifier의 쓰기 줄은 `Skip`이라 이 쓰기를 지나지 않고(F2) 읽는 문장도 아직 없어서, SELECT를 미리 주면 `scripts/tests/test_notifier_role_grants.sh`가 「over-grant table」로 빨개져요(`:1048-1058`). SELECT 한 줄은 2단계가 판정 읽기와 **함께** 더해요(`bootstrap_runtime_roles.sql`의 notifier 블록, 표 하나에 GRANT 한 줄·DELETE 없음).

#### F2. 자동으로 따라가는 세 경우: 보내기 tx 안에서, 호출 한 줄로 [권장]
- **언제**: 새로 쓰인(`deduped`가 아닌) `type='text'` 메시지가 `root_id`를 갖고 그 보내기가 `ThreadPolicy::Maintain`(롤업을 올리는, 곧 스레드가 센 답글)일 때예요. `Skip`인 줄은 지나지 않아요. 작업 세션 이벤트 카드처럼 「누가 답한 대화가 아닌」 줄이고(`message.rs:484-488`), **notifier의 줄도 `Skip`**이라 notifier 역할이 이 표에 쓸 일이 구조상 없어요. 재시도로 겹친 보내기는 `finish_send_in_tx`의 `deduped` 반환에서 이미 빠져요. 그래서 따라가기 쓰기도 한 번이고, 재시도가 「그만 따라감」을 되돌리지도 못해요.
- **누가**: 한 문장이 아래 후보를 모아 자격(F1)을 거르고 `auto`로 넣어요.
  1. **답글을 단 사람**(작성자가 사람일 때).
  2. **루트 작성자**(사람일 때). 답글이 달려야 스레드가 생겨서 이 행은 **첫 답글**에 만들어져요. 답글 없는 글마다 행을 만들지 않아요. 에이전트의 답글이 첫 답글이어도 루트 작성자는 따라가요(내가 연 스레드에 에이전트가 답해도 그다음 답글이 와요).
  3. **스레드에서 멘션된 사람**: 이 답글의 `props.mention_member_ids`(인용된 사람 포함)와 **루트 글에 기록된 멘션**이에요. 루트에서 불린 사람은 스레드에서도 불린 사람이에요. 멘션은 REST 보내기에서만 기록돼서(`read_state.rs:620-743`) 에이전트가 쓴 줄의 `@`는 따라가기를 만들지 않아요. 오늘 멘션의 뜻과 같아요.
- **같은 tx**: 메시지 INSERT·롤업·아웃박스와 한 tx라서 보내기가 롤백되면 행도 없어요. 반대로 이 쓰기가 실패하면 보내기도 실패해요(따라가기가 조용히 빠지지 않아요).
- **코드 모양**: 새 모듈 `momo-messaging/src/thread_follow.rs`에 두고 `finish_send_in_tx`에는 호출 한 줄만 더해요. 스레드 롤업 SQL과 알림 판정은 건드리지 않아요(#4887 칸이 만지는 곳이에요).
- **소급 없음**: 이 기능 이전의 스레드는 **백필하지 않아요**(I5). 멘션 참여는 싸게 다시 만들 수 없고 마이그레이션이 길어져요. 옛 스레드는 다음에 답글을 달거나 멘션되거나 직접 따라가면 그때부터 따라가요(남는 위험 19). 필요하면 「최근 N일 활성 스레드」만의 백필을 증보로 해요. 새 멤버가 채널에 들어와도 지난 스레드를 소급해서 따라가지 않아요.

#### F3. 그만 따라간 뒤에는 자동으로 돌아오지 않아요: 끈 것은 켤 때까지 꺼져 있어요 [권장]
- `unfollowed`는 **자동 경로 셋 모두**가 풀지 못해요. 다시 답글을 달아도, 다시 멘션돼도, 루트 작성자여도 그대로예요. 돌아오는 길은 **직접 따라가기(PUT) 하나**예요(F1 표).
- 이유: ① I6 「사용자가 멈춘 것은 멈춰요」. 명시 행동이 암시 행동보다 위예요. ② 답글은 대화에 말하는 행동이지 알림을 다시 받겠다는 뜻이 아닐 수 있어요(「확인했어요」 한 줄 남기고 나오는 경우). ③ 자동이 끈 선택을 되돌리면 「그만 따라가기」를 믿을 수 없게 돼요(사용자가 끈 줄 알았는데 계속 오는, B1과 같은 모양). 이 규칙은 SQL 절 하나(`DO NOTHING`)라 시험이 그 절을 깨서 빨강을 봐요(T-3).
- 마찰과 완화: 끈 스레드에 답글을 단 사람은 그 뒤 답글을 못 받아요. 화면(#4890)이 스레드 열기 응답의 `following=false`일 때 입력창 곁에 「이 스레드를 따라가지 않고 있어요 · 따라가기」를 보여 주기를 권장해요(화면 소유, 이 증보는 데이터만 줘요).
- **범위**: 그만 따라가기는 **`thread_reply`만** 꺼요. 그 스레드의 `mention`(나를 부른 글)·`keyword`·단계 `all`의 채널 글(대화에도 보낸 답글)은 각자의 규칙대로 와요.
- 이 규칙의 반대편(본인의 새 답글은 명시 행동이니 다시 따라가요)은 기각했어요(기각 표). owner가 뒤집으려면 답글 경로만 `ON CONFLICT … DO UPDATE SET state='auto' WHERE thread_follow.state='unfollowed'`로 바꾸면 돼요.

#### F4. 판정 갈래 `thread_reply` [권장]
- **자리**: 작업·승인 > 멘션 > DM > 에이전트의 답 > `keyword` > `channel_message` > **`thread_reply`**예요(D16 표 2단계의 arm 순서에 한 칸을 더해요). 맨 아래인 이유: 앞 arm은 모두 그 메시지가 나에게 직접 해당하는 경우(지목·직접·내 질문의 답·내 키워드·내가 고른 채널 단계)고, 따라가기는 내가 있던 대화의 새 소식이라서 같은 메시지에서 앞 arm이 서면 그쪽이 이겨요.
- **조건**: 메시지가 `type='text'`이고 `root_id`가 있고, 채널이 `dm`이 아니고, 받는 사람의 `thread_follow` 행(`root_id = msg.root_id`)이 `auto`·`followed`이고, 스트림이 열려 있지 않고(`channel_message`처럼 열린 동안 보류하고 닫힐 때 두 번째 후보로 판정), **「보고 있음」이 아닐 때**(30초 창, `read_state.last_read_at`과 `channel_viewing` 중 하나, `channel_message`와 같은 OR)예요. 본인 글은 멤버 조인이 이미 빼요(`judgment.rs:496-503`). 스레드 단위 존재 신호는 없어서 채널을 보고 있으면 스레드 패널이 닫혀 있어도 억제돼요(남는 위험 21).
- **억제**(D16의 같은 표를 지나요): 일시 중지·근무 시간 밖은 억제(I6)이고 **채널 음소거도 억제**예요(이슈 #4889 수용 기준). 멘션 예외·`keyword` 관통 같은 뚫는 길이 `thread_reply`에는 없어요. 지연(D4)과 폭주 상한(D7)은 F6이에요.
- **한 건만**: 같은 메시지는 한 사람에게 reason 하나(CASE의 첫 일치)이고 푸시는 `m:<message_id>`로 토큰마다 한 건이에요. 그래서 **멘션 알림이 이미 가는 사람에게는** `mention`이 앞서서 `thread_reply`가 따로 서지 않아요. 키워드와 `channel_message`도 같아요.
- **D5의 내려가기**: `threadReply`를 끈 사람은 이 arm이 맨 아래라 푸시가 없어요. `channelAll`을 끈 사람의 대화에도 보낸 답글은 `thread_reply`로 내려가요(D5의 「내려가는 arm」 목록에 `channelAll`을 더해요).
- **대화에도 보낸 답글**(ADR-0148 증보 #4887의 가정: 한 메시지 행이 `root_id`와 「대화에도 보내기」 표시를 함께 가져요 [확인 필요: #4887 증보가 다르게 정하면 이 표만 맞춰요])은 채널 글이기도 해서 **채널 규칙 N1을 먼저 타요.** 한 메시지 행이라 사람마다 reason 하나·푸시 한 건이에요:

  | 받는 사람 | 채널 단계 `all` | 채널 단계 `mentions`(기본) |
  |---|---|---|
  | 그 스레드를 따라가요 | `channel_message` 한 건 | `thread_reply` 한 건 |
  | 따라가지 않아요(행 없음·`unfollowed`) | `channel_message` 한 건 | 없음(멘션이면 `mention`) |

  `channel_message`가 「보고 있음」으로 물러나서 아래로 내려오면 `thread_reply`도 같은 창에 걸려서 한 건도 안 가요. 멘션된 사람은 어느 칸이든 `mention` 한 건이에요.
- **작업 세션 스레드** [확인 필요]: 이벤트 카드는 `Skip`이라 행을 만들지 않아요. 하지만 지시문(`send_thread_notice_in_tx`로 쓰는 멤버 글, `routes/work_instructions.rs:474-485`)은 `Maintain`이라 지시한 사람이 그 스레드를 따라가게 돼요. 이미 있는 작업 이유(`work_session_idle`·`work_run_done`)와 겹쳐서 시끄러워지지 않는지 2단계가 격리 PG로 재고, 필요하면 그 스레드를 제외해요.

#### F5. 종류·어휘·설정 기본값 [권장]
- **종류**: D5의 닫힌 집합이 9개에서 10개로 늘어요. 종류 표에 한 줄: `threadReply` · 와이어 reason `thread_reply` · category `momo.message` · 폰 기본 **켬** · 데스크탑 해당 없음(아래) · 지연(D4) 예 · 폰 소리 키 `thread_reply`(기본음은 `oort.message`).
- **「설정 기본값 켜짐」**: 행 부재 = 켬이에요. I5의 「새 기능이 스스로 만드는 동작」이라 구 서버는 오늘대로예요. 종류 스위치는 N3(#4494)가 나가야 생기고, 그 전에는 「그만 따라가기」가 유일한 끄기예요. 진단(D11)의 `kind_off`도 `threadReply`를 읽어요.
- **어휘(D14)**: reason `thread_reply` 하나를 더해요. category는 새로 만들지 않아요(`momo.message`는 구 앱이 이미 아는 category라 답장 버튼이 달려 뜨고, 구 앱은 새 reason의 봉투를 파싱하지 못해 답장을 조용히 버려요. 남는 위험 12와 같은 수용이에요). **N0(#4492)의 어휘 묶음에 같이 넣어 relay를 한 번만 배포하는 것을 권장해요**(reason마다 relay를 따로 배포하면 호스티드 배포가 늘어요, D14). N0가 먼저 나갔다면 relay 먼저 한 번 더예요. 어느 쪽인지는 planner가 정해요. 배포 순서는 relay → migrate → notifier → api → 앱 그대로예요. 1단계(표·API·자동 따라가기)는 새 reason을 보내지 않아서 어휘와 무관하게 먼저 나가도 돼요.
- **D4·D7과의 관계**: `thread_reply`는 D4의 지연 대상 reason(폰 대상)에 들고, D7의 대량 층 원천이 돼요(F6).
- **데스크탑·웹 배너는 이 증보가 정하지 않아요**: 배너 판정은 클라이언트가 하는데(D17) 따라가는 스레드를 클라이언트가 알 길이 없어요. 실시간 `message.new`는 채널 전체로 가서 수신자별 값을 실을 수 없고, 스레드 열기 응답의 `following`은 연 스레드 하나만 말해요. 「내가 따라가는 스레드」 목록을 읽는 API(「스레드」 모아보기와 같은 입력)가 먼저인 별도 증보예요. 그 증보가 `threadReply.desktop` 칸을 같은 기본(켬)으로 열고, 칸을 여는 것은 행 부재 = 켬이라 migration이 없어요. 그래서 지금의 `threadReply`는 `keyword`처럼 **폰 전용**이에요(D5의 「해당 없는 표면 칸은 400」).

#### F6. 묶음: 서버는 시간 지연으로 합치지 않고, OS 묶음과 대량 층 상한으로 가요 [권장]
- **결정**: 이슈가 물은 「서버에서 짧게 합칠지(예: 30초)」는 **합치지 않아요.** 대신 두 겹이에요.
  1. **스레드 단위 묶음은 OS가 해요.** 봉투의 `thread_id`가 스레드 루트 id여서(F7) iOS 알림 센터가 같은 스레드의 알림을 한 묶음으로 쌓아요. 서버가 새로 할 일이 없어요.
  2. **폭주는 D7의 대량 층으로 막아요.** `thread_reply`를 대량 층 원천(`channel_message`·`keyword`와 같은 층)에 더해요. 창은 (멤버, **스레드 루트**)당 60초이고 개별은 **6건**까지, 7번째부터 합쳐서 1건이에요. collapse id는 `o:<root_id>:<창 번호>`, 문구는 정적 「새 글이 여러 개 있어요」이고 개별 푸시의 collapse id는 그대로 `m:<message_id>`예요. 서버 전체 예산(`NOTIFIER_BULK_PUSH_PER_MINUTE`)·relay 429를 다시 시도하지 않는 best-effort·진단이 드롭 행을 건너뛰는 규칙·로그 카운터(reason 라벨 `thread_reply`)가 D7과 같이 `thread_reply`에도 적용돼요. 상수 6은 D7과 같은 한 곳이에요.
- **키를 (멤버, 채널)이 아니라 (멤버, 스레드)로 하는 이유**: 이슈의 요구가 「스레드 단위로 묶어요」예요. 채널 창을 같이 쓰면 한 스레드의 연타가 같은 채널의 다른 알림 6건을 갉아먹고, 합친 푸시를 눌렀을 때의 목적지(스레드인지 채널인지)가 섞여요. `o:<root_id>:…`의 대표 한 건은 그 스레드의 새 답글이라 탭이 그 스레드로 가요. 다른 원천(`channel_message`·`keyword`)의 창 키는 D7 그대로 (멤버, 채널)이에요.
- **시간 지연으로 합치지 않는 이유**: ① 합치려면 첫 답글을 늦추거나(D4의 `available_at` 미루기와 같은 후보 재처리) 첫 건 뒤를 버려서 내용이 사라져요. 끝에 요약 푸시를 보내려면 새 타이머와 정적 문구가 더 필요해요. 메신저는 첫 답글이 바로 와야 해요. ② 「같은 스레드는 한 알림이 덮어쓴다」는 APNs collapse 교체는 쓸 수 없어요. collapse id가 `claim_dispatch`의 유일 키(D7·D15)라 같은 id를 재사용하면 두 번째 푸시가 정산되기 전에 사라져요. ③ OS 묶음과 분당 6건 상한이 소음을 이미 한정해요.
- **재검토 조건**: 로그 카운터(합침·예산·429 드롭)와 실사용에서 「스레드 핑 연타」가 문제로 보이면 D4와 같은 `defer` 30초 합치기를 증보로 정해요. 개별 상한을 3으로 낮추는 것은 상수 한 줄이에요.
- **N1 의존** [확인 필요]: 창·예산 함수는 N1(#4493)의 일부예요. N1이 창 키를 인자로 받게 일반화하기를 권장하고, N1이 2단계보다 늦으면 2단계가 같은 모양으로 먼저 만들어요. 순서는 planner가 정해요.

#### F7. 알림 봉투: 새 키가 없어요 [V]
- 「알림 봉투에 스레드 루트 id를 실어요」는 **이미 되어 있어요.** 판정이 `thread_id`를 `COALESCE(root_id, channel_id)`로 내보내서(`judgment.rs:512`) 스레드 답글의 `thread_id`는 루트 id예요. 폰은 `threadId`가 `channelId`와 다르면 루트로 읽고(`envelope.ts:165-167`) 탭은 그 루트를 스레드로 열며(`tapArrival.ts:240-256`) 잠금 화면 답장은 스레드에 가요(`notifications.ts:283-296`의 `sendThreadReply`). ADR-0120의 닫힌 키 집합과 id-only(I3)는 그대로예요.
- `thread_reply` 푸시의 봉투: `channel_id` = 채널, `message_id` = 새 답글, `thread_id` = 루트, reason `thread_reply`, category `momo.message`예요. 2단계가 `pushTap.test.tsx`에 `thread_reply` 한 건(탭이 스레드로 가는 것)과 relay·서버·Swift·RN 어휘 일치 시험을 더해요.

#### F8. API [권장]
- `PUT /v1/workspaces/{ws}/channels/{ch}/messages/{root}/follow` → 200 `{following: true}`(직접 따라가기, `followed`)이고 같은 경로의 `DELETE` → 200 `{following: false}`(그만 따라가기, `unfollowed`)예요. 본문이 없고 멱등이에요. 응답은 따라가는지(효과값)만 말하고 `auto`와 `followed`를 가르지 않아요. 가를 화면이 생기면 더해요.
- **가드 순서**는 스레드 열기(`getThreadReplies`)와 같아요: 워크스페이스 범위(403) → 채널 멤버(아니면 403 `not a member of this channel`, 같은 바이트) → 루트 확인(없거나 다른 채널이면 404, 루트가 답글이면 400. 읽기와 같은 「느슨한」 검사라 지워진 루트도 따라가기·그만 따라가기가 돼요) → DM 채널이면 400 `thread_follow_not_applicable` → 쓰기예요. 다른 워크스페이스는 경로 범위(403)와 RLS가 둘 다 막아요.
- **사람 bearer만** 써요. 에이전트는 403이에요(어느 에이전트 scope도 이 경로를 열지 않아요). 개발자 토큰도 닫힌 표에 없어서 403이에요.
- **스레드 열기 응답**: `GET …/messages/{root}/replies`의 `ThreadRepliesPage`에 `following`(boolean, 읽는 사람 본인 것, 페이지와 같은 tx)을 더해요. 모든 페이지에 실려요(PK 조회 한 번). 구 서버가 안 주면 클라이언트는 `false`로 읽어요(코어 타입은 optional).
- **이벤트·감사·속도 제한은 없어요**: 개인 설정이라 남에게 영향이 없어요. 다른 기기는 다음 조회에서 수렴해요(ADR-0177 방식). 행이 (스레드, 멤버)당 하나라 핀·반응과 같은 수준이고, 일반 쓰기 예산은 ADR-0208 D10이 적은 알려진 빈틈이에요(#4234).

  | 연산 | 경로 | 성공 | 오류 |
  |---|---|---|---|
  | `followThread` | `PUT …/channels/{ch}/messages/{root}/follow` | 200 `{following:true}` | 400 `thread_follow_not_applicable`·루트가 답글, 403, 404 |
  | `unfollowThread` | `DELETE` 같은 경로 | 200 `{following:false}` | 같음 |
  | `getThreadReplies`(변경) | `GET …/messages/{root}/replies` | `following` 추가 | 변경 없음 |

#### F9. 단계·시험·배포
- 1단계 시험은 T-1~T-6, 2단계는 T-7~T-11이에요(아래).
- 배포: 1단계는 **migrate → api**만 지키면 돼요. 새 api가 표(migration 164)보다 먼저 뜨면 스레드 답글 보내기가 「`thread_follow` 표가 없다」로 실패해요(자동 따라가기가 같은 tx라서요. 보내기 tx 안의 쓰기가 실패하면 보내기도 실패하는 것이 F2의 뜻이에요). 반대로 새 DB에 구 api는 표를 모르는 채 오늘대로 돌아요. 2단계는 D14의 relay → migrate → notifier → api → 앱이에요.
- 화면(#4890)은 이 증보의 API에 기대요. 「스레드」 모아보기는 후속이고 목록 읽기 API가 필요해요.

#### F10. 안 읽은 답글 (owner 10-31 23:49, #4878·#4889 2단계) [Accepted, planner 2026-11-01]
owner 원문(#4878 코멘트): 「안본 메세지가 답글에 있는경우에 조금 다른 색상으로 표시하거나 칩으로 표시하는것도 좋은 경험일 거 같아.」 이 절은 그 화면이 기대는 서버 값과 신호를 정한다(공개 API 가산, ADR-0100).
- **읽은 위치**: `thread_follow.last_read_reply_seq`(migration 165, 기본 0, `CHECK (>= 0) NOT VALID`). 신호 `PUT …/messages/{root}/read {last_read_reply_seq}`만 `GREATEST(현재, LEAST(요청, 스레드의 마지막 답글 seq))`로 **앞으로만** 올린다. 사람 전용, 가드 순서는 스레드 읽기와 같다(워크스페이스 범위 → 살아 있는 채널 멤버). 행을 만들지 않는다 — 따라가지 않는 스레드·DM은 오류 없이 `{following: false}`. `GET …/replies`와 채널 읽음 커서는 위치를 올리지 않는다(인박스·작업 패널도 같은 읽기를 부른다).
- **새 행의 시작값**: 자동 따라가기는 답글 단 사람 = 그 답글 seq, 루트 작성자·멘션된 사람 = 그 답글 seq − 1, 직접 따라가기 = 그 시점의 스레드 머리. 이미 있는 행은 신호만 바꾼다.
- **수**: 다른 사람의 지우지 않은 `text` 답글 중 위치보다 큰 것. **기록 페이지(`GET …/messages`)의 스레드 요약에만** 선택값 `unread_reply_count`(따라가는 스레드, 0 포함)로 싣는다. `thread.updated`는 채널 방송 한 건이라 사람별 값을 싣지 않는다 — 실시간으로는 클라이언트가 프레임의 `last_reply_seq`·`participant_ids[0]`로 자기 수를 올리고 신호 응답으로 맞춘다.
- 시험: T-12(위치 앞으로만·머리 클램프·행 안 만듦), T-13(수: 본인·지운·진행 줄 제외, 따라가지 않으면 없음), T-14(`thread.updated` 키 집합 그대로), 두 테넌트.

#### F11. 화면: 머리 단추와 데스크탑·웹 배너 (#4890, 2026-11-01) [Accepted 2026-11-01 planner — 서버·API·DB 변경 없는 화면 규칙, owner 10-31 「참여한 스레드의 새 답글 알림」 범위]
F5가 「별도 증보」로 미룬 데스크탑·웹 배너와 F8의 화면을 정한다. 서버·API·DB는 바꾸지 않는다(가산 없음).
- **머리 단추**: 웹·데스크탑 스레드 패널과 폰 스레드 화면의 머리에 「따라가기 / 그만 따라가기」 한 개. 누르면 바로 바뀌고(낙관적) 서버가 말한 효과값으로 확정하며, 실패하면 누르기 전 값으로 되돌리고 짧게 알린다. 404·405와 400 `thread_follow_not_applicable`은 「여기서는 쓸 수 없다」로 읽어 칸을 숨긴다(옛 서버·DM, DM 채널은 처음부터 안 세운다). 상태는 색만이 아니라 아이콘(Lucide `Bell`/`BellOff`)과 접근성 라벨의 말로 낸다. 규칙은 코어 한 곳(`threadFollow`)이다.
- **배너 판정의 입력은 서버가 이 기기에 말한 값뿐이다.** 스레드 열기 응답의 `following`과 `PUT`/`DELETE …/follow`의 응답을 장부에 적고(60초 동안 믿는다), 장부에 없는(또는 늙은) 스레드는 **다른 이유로 걸러지지 않은 답글에 한해** 그 스레드 하나를 `GET …/replies?limit=1`로 읽어 `following`을 얻은 뒤 다시 판정한다. 읽기가 실패하면 10초 동안 「따라가지 않음」으로 둔다(모르는 채 알리지 않는다). 따라가는 스레드 목록 API가 생기면 이 읽기는 사라진다. 인박스의 `thread_reply`(ADR-0199 D2: 참여자 규칙)는 `thread_follow` 표를 읽지 않아서 입력으로 쓰지 않는다.
- **억제**: 내가 쓴 글 · 알림 일시 중지 · 채널 음소거 · 이 기기의 종류 스위치(`thread-reply`, 기본 켬, localStorage) · **그 스레드의 패널이 열려 있고 창이 앞일 때**. 채널이 화면에 있다는 것은 스레드 답글을 본 것이 아니다(답글은 본류 목록의 줄이 아니다). 「대화에도 보내기」 답글은 본류에도 서므로 채널이 앞이면 본 것이다. 서버에 묻는 읽기는 이 억제들을 모두 통과한 답글에만 나간다. 누르면 `?msg=&thread=`로 그 스레드를 열고 그 답글로 간다.
- **폰의 종류 스위치는 이 증보 밖이다**: 서버의 사람별 푸시 종류 저장소는 `notification_rule.work_complete_push` 하나(`workComplete`)뿐이다. `threadReply` 스위치는 N3(#4494)와 함께 온다. 그 전의 폰 끄기는 스레드마다의 「그만 따라가기」다. 폰 알림 묶음은 이미 되어 있다: 릴레이가 봉투의 `thread_id`(루트)를 `aps.thread-id`로 싣고(`momo-push-relay/src/dispatch.rs`, 시험 `thread_reply_is_an_allowed_message_dispatch`) 탭은 그 루트의 스레드를 연다.
- 남는 위험 26: 다른 기기에서 그만 따라간 것이 이 기기의 배너에 닿기까지 장부 기한(60초)이 걸린다. 27: 모르는 스레드의 첫 답글마다 읽기 한 건이 나간다(스레드당 분당 한 건 안팎). 28: 같은 스레드의 답글이 묶음 창(1.2초) 안에 여럿 오면 한 묶음 배너가 되고, 누르면 브라우저 탭은 멘션 인박스로, 데스크탑 셸은 그 채널로 간다(기존 묶음 규칙). 29: 데스크탑 배너에는 폰 푸시의 대량 층(F6: 스레드당 분당 6건 상한) 같은 폭주 상한이 없다. 오래 이어 쓰는 스레드를 따라가면 창을 떠나 있는 동안 답글마다 배너가 뜬다(1.2초 묶음 창 안의 것만 합쳐진다). 필요하면 증보로 상한을 더한다. 남는 위험 23은 이 절로 부분 해소됐다.
- **다듬기 (#5017, 2026-11-01)**: 남는 위험 28·29는 닫혔고 F3의 입력창 곁 힌트가 선다. 서버·API·DB 변경은 없다. ① 같은 스레드의 답글만 묶인 배너는 누르면 그 스레드의 **가장 늦은 답글**로 간다(브라우저 탭·데스크탑 셸 모두). 스레드가 섞이면 예전 규칙(탭은 멘션 인박스, 셸은 채널)이다. ② 한 스레드의 답글은 이 기기에서 **미끄러지는 60초에 6건**까지만 배너가 된다. 폰 푸시의 대량 층과 같은 값(F6, `momo-notifier` `bulk.rs`의 `INDIVIDUAL_PER_WINDOW`·`WINDOW_SECONDS`)이고, 서버가 고정된 1분 창이라 경계에서 6+6이 나가는 것과 달리 어느 60초에도 6건을 넘지 않는다. 폰은 7번째부터 한 건으로 합쳐 보내지만 배너에는 합칠 곳이 없어서 넘은 답글은 배너도 착지 무장도 없다(인박스와 읽지 않음 표시에는 그대로 남는다). 값은 코어의 한 상수(`THREAD_BANNER_CAP`)다. ③ 입력창 곁 한 줄 「답하면 이 스레드를 따라가요」는 서버가 `following: false`를 **말했고** 이 사람이 이 패널에서 따라가기를 누른 적이 없고 이 스레드에서 아직 말한 적이 없을 때만 선다. 옛 서버(키 없음: 답해도 따라가지 않는다)·눌러 끈 스레드(F3: 돌아오지 않는다)·내가 이미 답했거나 내 글에 답글이 달린 스레드·답글을 다 못 불러온 때는 서지 않는다. F3이 권한 「따라가지 않고 있어요 · 따라가기」 줄은 두지 않았다: 머리 단추가 같은 일을 한다. 남는 위험 30: 서버의 `following`은 「행 없음」과 「그만 따라감」을 가르지 않아서(F8) 다른 기기에서 끈 스레드에 처음 답하는 사람에게는 힌트가 틀릴 수 있다. 위의 걸러냄(이미 답한 스레드 등)이 대부분을 막는다.

### 호환·롤백 (증보 1)

| 변경 | 구 서버가 새 DB를 읽을 때(롤백 포함) | 구 앱 + 새 서버 | 새 앱 + 구 서버 | 구 relay + 새 서버 |
|---|---|---|---|---|
| 새 표 `thread_follow` | 모르는 표라 무시해요. 스레드 알림이 없던 오늘의 동작이에요. **반대 방향은 아니에요: 새 api가 migration 164보다 먼저 뜨면 스레드 답글 보내기가 실패해요** → 배포 순서 migrate → api | 영향 없음 | — | 영향 없음 |
| API `…/follow`·`following` | 새 경로는 404 | 구 앱은 이 경로를 부르지 않아요 | 404·405는 「기능 없음」으로 보고 그 서버로 다시 보내지 않고 칸을 숨겨요. `following`이 없으면 `false` | 영향 없음 |
| reason `thread_reply`(2단계) | — | NSE 파싱 실패 → relay의 정적 문구(fail-open) | — | 400 → 영구 실패 정산 → 푸시 유실. **배포 순서로 막아요**(F5) |

### 수용 기준 (증보 1, red proof)

각 행은 한 조건만 거짓으로 만들어 빨강이 되는지(사보타주)를 PR 본문에 적어요. 모두 격리 PG로 돌고 비우회 역할(`rolbypassrls=false`)·두 테넌트를 써요.

| # | 단계 | 고정할 것 | 사보타주(이렇게 깨면 빨강) |
|---|---|---|---|
| T-1 | 1 | 자동 따라가기 세 경로: 답글 단 사람, 루트 작성자(첫 답글이 에이전트의 것이어도), 멘션된 사람(이 답글의 `@`·인용, 루트의 `@`). 에이전트 작성자·DM 채널·`Skip` 보내기(notifier 모양)·나간 사람·비멤버는 행 0건 | 자동 호출 한 줄을 지우면 세 경로 시험이 빨개요. 자격 조인(`kind='human'`·`left_at`)을 빼면 에이전트·나간 사람 시험이 빨개요 |
| T-2 | 1 | 직접 따라가기·그만 따라가기·멱등, 병합 표(`auto`→`followed`, `followed`→`unfollowed`, `unfollowed`→`followed`) | 직접 쓰기를 `DO NOTHING`으로 바꾸면 빨개요 |
| T-3 | 1 | 그만 따라간 뒤 자동 경로 셋(다시 답글·다시 멘션·루트 작성자)이 행을 되돌리지 못해요 | 자동 쓰기를 `DO UPDATE SET state='auto'`로 바꾸면(「그만 따라감」 존중 제거) 빨개요 |
| T-4 | 1 | 멱등 재시도: 같은 `client_msg_id`를 두 번 보내도 행이 하나이고, 그만 따라간 뒤의 재시도도 되돌리지 못해요 | 호출을 `deduped` 반환 앞으로 옮기면 「그만 따라간 뒤 재시도」 시험이 빨개요 |
| T-5 | 1 | 채널 멤버가 아니면 403이고 쓰지 않아요. 에이전트 bearer 403. 다른 워크스페이스 경로 403. 없는 루트·다른 채널 루트 404. 답글을 루트로 400. DM 400 | 멤버 검사를 지우면 비멤버 시험이 빨개요 |
| T-6 | 1 | 두 테넌트 RLS: B의 문맥에서 A의 행이 0건이고 A의 행을 B의 문맥에서 INSERT하면 거절돼요(WITH CHECK). `tenant_catalog_pg`가 새 표를 ENABLE+FORCE+정책으로 읽어요. 스레드 열기 응답에 `following`이 실려요 | 정책을 빼면(또는 `USING (true)`로 바꾸면) 격리·카탈로그 시험이 빨개요 |
| T-7 | 2 | `thread_reply` 대상: 따라가는 사람에게만, 본인 제외, 멘션된 사람은 `mention` 한 건, `unfollowed`·행 없음은 0건, 에이전트의 진행 줄(`tool_call`)은 0건 | arm의 `thread_follow` 조건을 빼면 빨개요 |
| T-8 | 2 | 일시 중지·채널 음소거(기한 지난 음소거는 풀림)·`threadReply.phone` 끔·「보고 있음」 30초 창 경계·열린 스트림 보류와 닫힌 뒤 한 건 | 음소거 검사를 빼면 빨개요 |
| T-9 | 2 | 대화에도 보낸 답글: F4 표의 네 칸이 사람마다 한 건이고 reason이 칸대로예요 | arm 순서를 뒤집으면(스레드가 위) 단계 `all` 칸이 빨개요 |
| T-10 | 2 | 묶음: 한 스레드에서 한 멤버에게 20건 연달아 → 7건(7번째가 `o:<root_id>:…`). 다른 스레드는 각자 창. 서버 전체 예산·429 비재시도·드롭 행 정산 | 상한을 7로 올리면, 키를 채널로 바꾸면 빨개요 |
| T-11 | 2 | 봉투 `thread_id`가 루트 id이고 키 집합이 그대로예요. notifier 역할은 `thread_follow`에 SELECT만(INSERT·DELETE 없음)이고 `test_notifier_role_grants.sh`가 초록이에요. 판정이 두 테넌트에서 격리돼요 | GRANT에 INSERT를 주면 빨개요 |

### 기각한 대안 (증보 1)

| 결정 | 대안 | 기각 이유 |
|---|---|---|
| F3 | 본인의 새 답글은 명시 행동으로 보고 다시 따라가요 | 끈 것이 자동으로 켜져서 「그만 따라가기」를 믿을 수 없어요. 답글은 알림을 다시 받겠다는 뜻이 아닐 수 있어요. 화면 힌트와 PUT 한 번으로 충분해요 |
| F1 | `thread.participant_ids`로 따라가기를 도출해요(새 표 없이) | 멘션·직접 따라가기·「그만」을 담을 수 없고 루트 작성자는 답글 전에는 없어요 |
| F1 | 판정 때마다 스레드의 글을 훑어 참여자를 계산해요 | 본문 미독(I2)과 어긋나고 후보마다 비용이 커요 |
| F2 | 루트를 쓰는 순간(답글 전)에 루트 작성자·멘션된 사람의 행을 만들어요 | 답글이 안 달리는 글마다 행이 생겨요 |
| F1 | 에이전트도 따라가요 | 푸시 대상은 사람 멤버뿐이에요. 스레드 안에서 에이전트를 부르는 규칙은 별개예요 |
| F2 | 이 기능 이전의 스레드를 백필해요 | I5와 어긋나고 멘션 참여를 싸게 다시 만들 수 없어요. 마이그레이션이 길어져요 |
| F4 | `thread_reply`를 `channel_message` 위에 둬요 | 대화에도 보낸 답글은 채널 글이라 채널 규칙(N1)이 먼저예요. 둘이 갈리는 칸은 F4 표가 정해요 |
| F4 | 스레드 답글이 채널 음소거를 뚫어요 | 이슈의 수용 기준이 음소거를 지키라고 해요. 뚫는 스위치는 설정 표면을 늘려요. 필요하면 증보로 해요 |
| F5 | 새 reason 없이 `mention`으로 보내요 | reason을 거짓으로 만들지 않아요(ADR-0120 A-6) |
| F6 | 서버에서 30초 합치기(지연) | 첫 답글이 늦거나 내용이 사라져요. 새 타이머·문구가 필요하고 OS 묶음이 이미 있어요 |
| F6 | 같은 스레드를 한 collapse id로 덮어써요 | collapse id가 `claim_dispatch`의 유일 키라 두 번째 푸시가 사라져요 |
| F6 | 창 키를 (멤버, 채널)로 해요 | 한 스레드의 연타가 같은 채널의 다른 알림을 갉아먹고 합친 푸시의 목적지가 섞여요 |
| F1 | 1단계에 notifier SELECT를 미리 줘요 | 읽는 문장이 없어서 over-grant 시험이 빨개요. 2단계가 읽기와 함께 더해요 |

### 남는 위험 (증보 1)

19. **이 기능 이전부터 참여한 스레드는 다음 참여 때까지 알림이 없어요**(F2, 백필 없음). 출시 직후 옛 스레드로 시험하면 안 오는 것처럼 보여요. 필요하면 최근 활성 스레드만의 백필 증보를 정해요.
20. **그만 따라간 스레드에 답글을 단 사람은 답을 못 받아요**(F3). 화면의 힌트(#4890)가 이 마찰을 줄여요.
21. **스레드 단위 「보고 있음」 신호가 없어요**(F4). 채널을 보고 있으면 스레드 패널이 닫혀 있어도 푸시가 억제돼요 `[추정]`. 스레드 열람 신호는 후속이에요.
22. **멘션 기록이 REST 경로뿐이에요**(F2). 에이전트가 쓴 줄의 `@`는 따라가기를 만들지 않아요. 오늘 멘션의 뜻과 같아요.
23. **데스크탑·웹 배너가 없어요**(F5). 따라가는 스레드 목록 읽기 API가 먼저인 별도 증보예요.
24. **에이전트가 많이 말하는 스레드에서 사람 후속의 푸시가 늘 수 있어요.** `type='text'`의 닫힌 줄만 대상이고(진행 줄은 다른 type) 대량 층 상한이 있어요. 작업 세션 스레드(F4)는 2단계가 잰 뒤 정해요.
25. **상태 이름·열거 값은 엔진이 소유해요**(`docs/TRACKS.md:23`). 응답은 `following`(boolean)뿐이라 UXUI가 따라 넣을 열거 값이 없어요.

## 증보 2 (2026-11-02, **Accepted** 2026-11-02 — planner 위임 결정, ADR-0100; #4341 독립 보안 검수 2회차 Blocker 0·High 0. #4341 구현에서 확정한 것 — D11의 「[확인 필요] 추론의 오탐은 #4341이 격리 PG로 재현해서 조정해요」의 이행)

D11·D15는 그대로이고, 구현이 격리 PG로 재현하며 정한 모양과 이슈 본문과의 차이만 적어요. 범위는 이 슬라이스가 낸 것(진단 `GET`·시험 `POST`·`push_system`·시험 알림 어휘 몫)뿐이에요.

**이슈 #4341 본문과 달라진 곳** (이슈가 ADR보다 먼저 쓰였어요. ADR을 따랐어요)
1. 시험 알림 행은 `outbox(kind='push_test')`가 아니라 **`push_system`**(D15)이에요. 소비는 notifier의 둘째 드레인이고 `push_candidate`의 판정을 지나지 않아요.
2. 어휘 증보는 N0 전체가 아니라 이 슬라이스 몫만 먼저 냈어요: reason `test_notification`, category `momo.system`, reason별 정적 본문 표(기본 「새 알림」·`test_notification` 「시험 알림이에요」). `channel_message`·`keyword`·`scheduled_failed`는 N0·N1·N5·N13이 같은 방식으로 더해요(부록 ADR-0120 A-9). 폰 상수 최소 diff(`PUSH_REASONS`·`PUSH_CATEGORY`·Swift 둘·`categories.ts`)는 같은 PR이에요.
3. migration은 **170 한 파일**에 M-a(outbox 라벨 `push_system`, 새 값을 쓰는 문장 없음)·M-b1(`notification_rule` 컬럼 넷)·M-h(`push_dispatch_log (member_id, created_at DESC)` 색인)를 묶었어요. 새 표·새 GRANT는 없어요(`prod_role_conformance_pg`가 운영 역할로 확인해요).
4. `kind_off`·`quiet_hours`는 이 슬라이스가 내지 않아요(N3·N7). `kind`는 닫힌 열 가지 목록(종류 표 + `threadReply`)으로만 검증하고(400), 두 코드가 나오지 않는다는 것을 시험이 고정해요.

**D11 조정** (각각 시험이 고정해요)
- `relay_unreachable`의 「마지막 시험이 30초 넘게 처리되지 않음」 절도 **최근 15분**으로 한정해요. 그보다 오래 멈춘 시험은 지금의 relay에 대한 증거가 아닌데 화면에 영원히 남기 때문이에요. `sinceMs`는 두 증거(정산 전 2분 이상 된 기록, 멈춘 시험) 중 이른 쪽이에요. 두 읽기 모두 현재 활성 토큰의 기록만, 대량 층 드롭 행(`relay_http: dropped`, 상수 하나 `RELAY_DROPPED_REASON`)은 건너뛰어요.
- `token_invalidated.sinceMs`는 마지막으로 죽은 토큰의 `invalidated_at`(곧 활성 토큰이 하나도 없게 된 순간)이에요. `devices.invalidated`는 무효 토큰 **행 수**라서 토큰 회전으로 쌓인 옛 행도 세요.
- `lastTest`: 200이 하나라도 있으면 `sent`, 정산된 기록이 없으면 30초 미만 `queued`·이상 `stalled`, **모든 시도**가 어휘 거절 400이면 `relay_outdated`(환경 불일치 400은 `failed`), 그 밖의 정산 기록(정산 전 시도가 섞인 경우 포함)은 `failed`예요. `apnsStatus`는 `sent`면 200, 아니면 가장 새 정산 기록의 상태예요.
- `apnsReason`은 **코드만** 내요: relay 거절은 `relay_vocabulary_refused`·`relay_environment_mismatch`·`relay_http_<status>`로 바꾸고, APNs reason은 글자·숫자·`_` 64자 이하일 때만 그대로 통과해요(relay가 영수증에 문장을 끼워도 응답에 닿지 않아요). 어휘·환경 문구가 relay에서 바뀌면 진짜 relay 라우터를 도는 시험(`push_system_conformance_pg`)이 빨개져요.
- 속도 제한은 **고정 60초 창**(첫 시험이 창을 열어요)에서 멤버당 3회예요. 활성 토큰이 없으면 슬롯을 쓰지 않고(409 `no_device`) `notification_rule` 행도 만들지 않아요. 429는 `error.code=rate_limited`와 `Retry-After`를 줘요. 시험은 `dnd`·다른 규칙 컬럼을 건드리지 않고 자기 컬럼 넷만 써요(구 PUT/PATCH도 그 넷을 건드리지 않아요).

**D11 정정** (#4341 독립 보안 검수 1회차, 각각 시험이 고정해요 — 첫째·둘째는 D11 본문의 문장을 **대체하고**, 셋째는 더한 규칙이에요)
- **「공유 relay 예산」: 시험 한 번이 닿는 기기는 최근 5대까지예요.** D11 본문의 「(멤버 × 분당 3)」은 시험 한 번이 relay 호출 한 번이라는 전제였는데 틀렸어요: 소비자는 활성 토큰마다 relay를 한 번씩 불러서 실제 곱은 **(활성 기기 수 × 분당 3)** 이었고, 기기 수는 요청한 사람이 정해요(기기 등록에 한도가 없어요). relay의 서버 단위 한도(기본 분당 60)를 한 멤버가 혼자 넘기면 다른 사람의 푸시가 429로 밀리고, 일반 푸시는 429를 약 3분 재시도한 뒤 `failed`로 접어서 반복하면 잃어요. 그래서 한 `push_system` 행은 멤버의 활성 토큰 중 **최근 등록·갱신 순(`push_token.updated_at`) 5개**에만 가요. 한 상수 `SYSTEM_PUSH_MAX_TARGETS`를 소비자(`system_targets`의 `LIMIT`)와 예약(`reserve_test_push_in_tx`가 세는 `deviceCount`)이 같이 써요. 실제 곱은 **5 × 분당 3 = 멤버당 분당 최대 15회**이고 「남는 위험」 9의 마지막 문장도 이 값으로 읽어요. 이 상한은 `push_system`의 모든 reason이 공유해요(ADR-0208의 예약 실패 푸시가 더하면 그 ADR이 올릴 수 있어요).
  - `POST`의 `deviceCount`는 시험이 **가는** 기기 수(상한 적용)예요. 멤버의 실제 기기 수는 `GET`의 `devices.active`가 그대로 말해요(상한 없음). `devices`는 D11이 이미 정한 계약이라 바꾸지 않았어요.
  - **남는 것**(후속 이슈 #5091): 시험 알림은 아직 notifier의 서버 전체 예산(대량 층 `try_spend`)에 들어가지 않아요. 멤버 넷이 한도까지 누르면(4 × 15 = 60) 그 시험만으로 서버 한도 60을 다 쓰고, 그 위의 다른 푸시는 429를 받을 수 있어요. 분당 3회는 고정 60초 창이라 창 경계를 걸치면 한 멤버가 롤링 60초에 최대 25건까지 relay를 부를 수 있어요(셋이 경계를 맞추면 75). 시험을 서버 전체 예산에 넣고 초과분을 `failed`로 정산하는 것과, 멤버당 활성 토큰 상한(등록 거절)은 별도 이슈예요.
- **「lastTest 정확 조회」는 색인을 타는 조회예요.** D11 본문의 「(멤버, 토큰, collapse id) 정확 조회」는 질의가 토큰을 고르지 않고(기기마다 한 줄) `collapse_id = $3`만으로는 부분 유니크 색인 `push_dispatch_dedupe_uniq`(011, `WHERE push_token_id IS NOT NULL AND collapse_id IS NOT NULL`)의 조건을 증명하지 못해서, 플래너가 그 색인을 쓰지 못하고 멤버의 기록 범위를 훑었어요(로그는 정리 작업이 없고 `GET`은 한도가 없어서 오래 쓴 멤버일수록 `GET`마다 느려져요). 질의에 `AND push_token_id IS NOT NULL`을 더해요(notifier가 쓰는 기록은 항상 둘 다 채워요, 011). 그러면 `(member_id, collapse_id)`를 그 색인으로 찾아요: 합성 30만 행(멤버 1명)에서 순차 스캔 10.2ms·4,617 버퍼 → 인덱스 0.057ms·22 버퍼(`Index Searches: 5`). 시험 `the_last_test_read_is_served_by_the_partial_unique_index`가 질의 문구(`LAST_TEST_ROWS_SQL`) 그대로 `EXPLAIN`해서 색인 사용을 고정해요. 토큰 행이 지워져 `push_token_id`가 NULL이 된 기록(FK `ON DELETE SET NULL`)은 이 읽기에 잡히지 않아요 — `relay_unreachable`·`last_delivery_failed`가 이미 현재 활성 토큰과 조인해서 같은 기록을 안 보는 것과 같은 방향이에요.
- **`Retry-After`는 1~60초예요.** 행 잠금을 기다린 요청은 창을 연 요청보다 먼저 시작했을 수 있어서(`now() < test_push_window_start`) 남은 시간이 창 하나에 그 차이를 더해 61초 넘게 나올 수 있었어요. 함수 `retry_after_secs`가 1..=60으로 묶어요.

**D15 조정**
- 시험 알림의 전송 오류 규칙: relay가 429·5xx로 **답한** 것은 그 상태로 정산(`lastTest` = `failed`)하고, relay에 **닿지 못한** 전송(전송 오류)은 정산하지 않고 둬요 — 그래야 `queued` → `stalled`가 되고 진단이 `relay_unreachable`을 추론해요. 어느 쪽도 outbox 행은 `done`이에요(재시도 없음, `oort doctor`에 영구 FAIL로 남지 않아요). 우리 쪽 DB 오류만 후보와 같은 백오프·`max_attempts`로 되살려요.
- 봉투의 `badge`는 0이 아니라 **멤버의 실제 안 읽은 수**예요(0이면 시험을 누른 부작용으로 앱 아이콘 배지가 지워져요).
- 폰 탭: 시험 알림은 열 대화가 없어서 앱만 열려요(채널이 목록에 없다는 「대화가 없어졌어요」를 내지 않아요). 알림 설정 화면으로 보내는 것은 상태·시험 화면(#4342)의 몫이에요.
- `oort doctor`의 `push_system` 분류: relay 미구성이면 info, 구성이면 나이(기본 300초) 기준 FAIL이에요. `available_at`이 미래인 행의 처리는 N11 몫이에요.

## owner 결정 (인용)

- 2026-10-21 성재: 「버즈쪽에서 알림에서 에로사항을 엄청 느끼는 거 같아. 그 부분에 있어서 커스텀까지도 가능하게(직접 넣어서 말이야) 해줬으면 좋겠어.」
- 2026-10-22 성재(위임): 「결정 부탁드릴 것은 너가 권장으로 진행해봐.」 D1~D10은 리서치 §6 권장안으로 확정했고(이슈 #4223), D4는 같은 날 성재에게 구체 설명을 드렸어요. D11~D20과 「리서치와 달라진 곳」은 이 위임에 따라 이 ADR이 고른 [권장]이고, planner가 PR 본문 「권장으로 정한 것」 표로 성재에게 보고해요.
- 2026-10-22 성재(소리 출처): 「기본 알림음은 너가 뭐 오픈소스같은걸로 만들거나 알림음을 찾아봐봐.」 → D10.
- 2026-10-22 planner 결정(#4223 코멘트): 예약 실패 푸시의 새 reason과 다섯 비용을 이 ADR이 정해요 → D15.
- 2026-10-31 성재(#4889): 「참여한 스레드의 새 답글 알림도 좋네. 그러니까 내가 관여한 스레드의 새 답글이 달리면 알림이 오는거지.」 → 증보 1. F1~F9의 [권장]은 planner가 결재 때 PR 본문 표로 성재에게 보고해요.

## 부록 A. openapi 계약 초안

`docs/api/openapi.yaml`에 「계약 초안」으로 들어갔어요(ADR-0208과 같은 방식). 태그 `notifications`, 새 연산 7개(진단 2·설정 2·키워드 2·활동 1), 새 스키마, 그리고 기존 `updateChannelNotificationPref`와 `Channel`의 추가 필드예요. 해당 슬라이스가 나올 때까지 새 경로는 404이고 기존 경로의 새 필드는 422예요. enum 값은 엔진이 소유해요(`docs/TRACKS.md:23`): UXUI PR은 서버 등록표가 랜딩한 뒤에 따라 넣어요. openapi만 바뀐 PR도 PR CI의 cargo 레인을 켜요(같은 줄).

**증보 1(#4889)의 연산 둘**(`followThread`·`unfollowThread`)과 `ThreadRepliesPage.following`은 초안이 아니라 1단계에서 서버와 함께 들어가요(계약 확정, 엔진 소유). `docs/api/openapi.yaml`의 태그는 `messages`예요.
