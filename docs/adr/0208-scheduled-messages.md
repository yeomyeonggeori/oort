# ADR-0208: 예약 메시지 - 보내는 사람의 기기가 꺼져 있어도 서버가 정시에 보낸다

- Status: **Accepted** (2026-10-22. 근거는 「owner 결정」에 인용: 성재 원문 2026-10-22, 성재 위임 2026-10-19·2026-10-22). planner 확인 완료(2026-10-22, ①~⑦ 수용)
- Date: 2026-10-22
- Deciders: 성재
- 기안: Sonnet 5.5 엔진 워커 (#4213). 이슈 본문의 planner 제안을 우리 코드의 실제 제약에 맞게 확정하거나 고쳤다. 고친 곳은 「이슈 본문과 다른 곳」에 모았다.
- 관계: ADR-0175(리마인더) · ADR-0109(read-state, 개인 채널 전파) · ADR-0199(인박스 투영, 개인 채널 이벤트 규약) · ADR-0204(폰 알림 v2: 푸시 닫힌 어휘, D8-a 생산자 규칙) · ADR-0120(푸시 경계) · ADR-0151(첨부) · ADR-0128(멤버십 수명주기) · ADR-0148(인용) · ADR-0182(일시 확인 정책) · ADR-0145(서버 스택) · ADR-0100(거버넌스)
- 번호 확인 [V, 2026-10-22]: `origin/main`·`origin/track/engine`·`origin/track/uxui`의 `docs/adr/`는 0205가 마지막이고, 열린 PR 중 `docs/adr/02`를 만드는 것이 없다. 이슈 #4213은 0206 알림 v2, 0207 알림 규칙, 0209 멀티 계정, 0210 Host Ops, 0211 개인 앱 토큰 금고를 따로 예약했다. 이 ADR은 **0208**만 쓴다.
- 표기: [V] 이 세션에서 저장소 코드·문서·외부 원문으로 직접 확인 · [추정] 해석 · [확인 필요] 구현 전 확인 · `runtime-unverified` 실행하지 않음. 이 문서는 설계이고 코드·마이그레이션·인프라를 바꾸지 않았다. 이 ADR이 정하는 동작은 `runtime-unverified`이며 닫는 자리는 「구현 순서와 수용 기준」이다. 예외는 DB 동작(D3 정책·D6 함수·D7 잠금·D9 경쟁·D11 점유)으로, 격리 PG 18.6에서 같은 모양의 SQL을 따로 돌려 확인했다(「설계 실측」).
- 함께 들어가는 문서: `docs/api/openapi.yaml`의 계약 초안(연산 5개, 「부록 A」), UI 명세 [`docs/design-system/scheduled-messages-ui.md`](../design-system/scheduled-messages-ui.md)(「부록 B」)

## 맥락

### 성재 요청 (원문, 2026-10-22)
「예약 메세지 기능을 추가하면 좋을 거 같은데 UI및 실제 설계 작업도 추가로 작업해줘.」

### 지금 있는 것 [V]
- **예약 전송은 없다.** 저장소 전체에서 `schedule_send`·`scheduled_message`·`sendAt`·「예약 전송」을 찾으면 0건이다. 이름이 비슷한 것은 다른 일이다: 재시도 예약, 에이전트의 주기 트리거(`BUILD_TICKETS.md:104` P6).
- **가장 가까운 것은 리마인더(ADR-0175)다.** 한 행이 한 사람의 것이고(`082_message_reminder.sql:44-58`, `reminder.rs:1-6`: 소유자 범위 FORCE RLS, 모든 문장이 `app.member_id`를 함께 묶는다) 만기 통지는 클라이언트 폴링이다. 리마인더는 「내가 나중에 볼 것」이라 서버가 정시에 하는 일이 없다. 예약 메시지는 서버가 정시에 **남에게 보이는 쓰기**를 한다. 그래서 서버 스케줄러가 필요하고 공개 API·DB·쓰기 경로 계약이 바뀐다(ADR-0100).
- **정본 send는 route 층의 조합이다.** 한 tenant tx 안에서 `messages.rs:694-845`가 순서대로 한다.
  1. 멤버 확인 `is_channel_member`(`:696`, `identity.rs:130-145`: `left_at IS NULL`만 본다).
  2. 스레드 루트·인용 검증(`:702-721`).
  3. `send_message_with_mentions_in_tx`(`:757-774`, momo-messaging `message.rs:824-938`): channel_seq 증가 + message INSERT + 멘션 기록 + 첨부 묶기 + 스레드 롤업 + outbox + hosted inbox fan-out.
  4. **멘션 → 에이전트 실행**(`:784-817`, `route_agent_mentions_in_tx`).
- **4번이 이 설계의 변곡점이다.** 이 함수는 `momo-server` 안의 `pub(crate)`이고(`agent_mentions.rs:224`), 입력이 AppState에서 오는 게이트·플래그다(`MentionSend`, `agent_mentions.rs:156-202`: gateway, hosted 전달, 구독 에이전트 스위치, connector_trial, context_max_messages, inplace_grant). 도메인 crate가 아니라 route 층이 조합하는 이유는 헤더가 적는다(`agent_mentions.rs:1-27`: 한 실행이 네 소유자의 문장을 요구한다). 1:1 DM의 암묵 호출과 스레드 답 깨움도 여기서 판정한다(`:44-82`). 다른 바이너리가 이 판정을 베끼면 「조용한 두 번째 복사본」이 된다.
- **멱등 장치는 이미 있다.** `ON CONFLICT (channel_id, author_member_id, client_msg_id) DO NOTHING`(`message.rs:517`).
- **받는 쪽 알림은 INSERT 트리거가 낸다.** 푸시 후보(`011_push_notifier.sql:47-69`)와 인박스 투영(`126_inbox_item.sql`)이 message INSERT에 붙어 있다. 정본 INSERT를 하는 순간 일반 메시지와 똑같이 난다.
- **api 프로세스에는 상주 백그라운드 작업이 없다.** `bins/momo-server/src`의 `tokio::spawn`은 0건이다(요청 처리 중 `JoinSet`·`spawn_blocking`뿐). `main.rs:325-334`는 serve와 graceful shutdown뿐이다. api는 `momo_app`(NOBYPASSRLS)만 쥔다: Railway의 api 시작 명령이 다른 비밀을 `env -u`로 버린다(`infra/railway/railway.json` notes.preDeploy), `SECURITY.md:80-89`.
- **상주 BYPASSRLS 소비자는 relay·agent-worker·notifier(와 relay 자격을 쓰는 webhook-sender)다.** notifier의 정리 작업은 「BYPASSRLS 풀로 후보 읽기 + RLS 묶인 `momo_app` 풀로 쓰기」 두 풀 모양이다(`momo-notifier/src/inbox_retention_sweep.rs:1-60`, 쓰기 풀 검사 `momo-messaging/src/avatar_reclaim.rs:263-277`, `momo-notifier/src/lib.rs:751-823`). 그런데 **notifier는 self-host 기본 스택에 없다.** 기본 compose의 서비스는 postgres · centrifugo · runtime-roles · migrate · api · relay · agent-worker · webhook-sender이고 notifier는 푸시 오버레이로만 선다(`docker-compose.rust.yml:6-20`, 푸시 오버레이 `:19`, 팀 `huddle-notifier` 프로필 `:646-648`; doctor도 「푸시 드레인은 오버레이에만 있다」 `oort_doctor.sh:903`). Railway 팀 인스턴스에는 있다(`infra/railway/README.md` 서비스 표 notifier 행).
- **푸시 어휘는 닫혀 있다.** reason 6종·category 5종은 relay가 모르는 값을 400으로 거절하고(`momo-push-relay/src/dispatch.rs:43-67`), 와이어는 id만 싣되 `channel_id`·`message_id`가 필수 키다(`momo-push/src/dispatch.rs:178-195`, 키 집합이 정확히 같아야 통과). 새 푸시는 relay 먼저 배포하는 순서가 있다(ADR-0204 D7). **보내지 못한 예약에는 메시지 행이 없다.**
- **개인 채널과 이벤트 규약이 있다.** `user:read-state#<MEMBER>`(`read_state.rs:177`)에 `inbox_item.created`/`inbox_item.read`/`inbox.read_all`을 id·시각만, snake_case로 낸다(ADR-0199 `:84`·`:132`, `inbox.rs:549-565`, outbox 파티션 키 = member_id). 이벤트 유실은 다음 `GET`이 복구한다(정본은 PG).
- **첨부 묶기 규칙.** `link_attachments_in_tx`(`attachment.rs:444-512`)는 `FOR UPDATE` 아래에서 `complete`·업로더 = 작성자·같은 채널·`message_id IS NULL`을 요구한다(`:476-487`), 한 메시지에 최대 20개(`:55`). 완료됐지만 묶이지 않은 첨부를 거두는 청소기는 없다: `attachment_pending_cleanup_idx`는 `pending`만 본다(`017_attachment.sql:36-39`). → [ADR-0151 증보 2](0151-attachments-v0-drive-contract-port.md#증보-2-2026-10-25-4443-첨부의-수명)(#4443)가 그 청소기를 만든다(기본 꺼짐, 점유는 마이그레이션 150이 attachment 행에 비춘다).
- **보관 채널은 막히지 않는다.** 정본 send는 `archived_at`을 읽지 않는다(`messages.rs:694-845`). 채널을 보관으로 만드는 곳은 하나다: 비공개 채널의 마지막 멤버가 나가면 보관한다(`membership_lifecycle.rs:634-658`). 그 시점에 작성자는 이미 채널 멤버가 아니라서 예약은 `not_member`로 멈추고 보관 여부와 무관하다. DM 다시 열기(`dm.rs:213`)는 NULL로 되돌린다 [V: `archived_at =` grep].
- **멤버 활성 판정의 선례.** `m.status = 'active' AND m.deleted_at IS NULL`(`dm.rs:160-170`). 사람 전용·살아 있는 멤버 전제는 리마인더 라우트와 같다(`reminders.rs:37`, `:68-89`).
- **속도 제한은 per-IP뿐이었다.** per-member 축은 이식되지 않았다(`rate_limit.rs:15-22`). 본문 상한도 axum 기본 요청 크기(2 MiB)뿐이다. (2026-10-25: 쓰기 표면에는 증보 1이 per-member 예산을 정한다.)
- **「세션만큼 사는 것」은 한 곳에서 끝낸다.** `session_end.rs:1-20`: 계열 하나를 끝내는 경로(로그아웃·기기 연결 해제·refresh 재사용)와 멤버 전체를 끝내는 경로(비밀번호 변경·재설정, 정지, 추방, 탈퇴)가 각각 함수 하나를 부르고, 새로 생기는 「세션에 매달린 것」은 호출부 일곱 곳이 아니라 거기에 더한다. 정지가 풀려도 되살아나면 안 된다(`member_lifecycle.rs:245-249`, #2677).
- **정지·추방·탈퇴는 소유자 범위 정책 밖에서 돈다.** 추방과 정지는 워크스페이스 GUC만 거는 `agent_tenant_tx`(`shared.rs:262-273`)에서 돌고(`member_lifecycle.rs:236-251`, `:296-320`), 탈퇴는 `workspaces.rs:313-352`다. 멤버 전체의 세션 종료(`end_member_sessions_in_tx`)는 비밀번호 변경(`password.rs:196`)·재설정(`claim.rs:111`)·정지·추방·탈퇴가 모두 부른다.
- **마이그레이션이 역할보다 먼저 돌 수 있다.** dev·CI는 마이그레이션 뒤에 `bootstrap_roles.sql`을 적용한다(`momo-migrate/src/main.rs:530-540`). 정의자 함수의 권한은 거기서 다시 부여하고 스스로 점검한다(`bootstrap_roles.sql:253-330`의 `momo_join_private` 블록과 DO 점검).
- **첨부 내용은 업로드 순간부터 채널 멤버가 읽는다.** 완료된 첨부는 업로더가 아니어도 채널 활성 멤버 누구나 읽고 묶이지 않은 첨부도 같다(`attachments.rs:332-360`). 첨부 id·이름은 `attachment.upload_started` 감사 행 detail에 있다(`attachment.rs:251-266`). → 이름은 [ADR-0151 증보 2](0151-attachments-v0-drive-contract-port.md#증보-2-2026-10-25-4443-첨부의-수명)(#4443)부터 싣지 않고, 이미 쓰인 행의 이름은 마이그레이션 151이 지운다.
- **워크스페이스는 소프트 삭제다**(`deleted_at`, `identity.rs:104-116`). FK 연쇄가 일어나지 않는다.
- **서버가 보낸 글은 작성자의 읽음 커서를 올리지 않는다.** 안 읽음은 `last_seq - last_read_seq`다(`read_state.rs:259-262`).
- **멤버 시간대는 서버에 없다.** 마이그레이션에 멤버·프로필 시간대 컬럼이 없다(클라이언트가 `Intl`로 안다).

### 외부 조사 (짧게)
이 세션의 검색 도구 한도(200회)가 소진돼 공식 문서 URL을 직접 열었다. 열리지 않은 것은 표에 그대로 적고 결정에 쓰지 않았다.

| 제품 | 확인한 사실 | 표기 |
|---|---|---|
| Slack (API) | `chat.scheduleMessage`: 최대 120일, 같은 채널에 5분 안에 30개 초과 불가. 오류 `time_in_past` · `time_too_far` · `restricted_too_many` · `channel_not_found` · `is_archived` · `not_in_channel` · `msg_too_long`. 목록 `chat.scheduledMessages.list`, 삭제 `chat.deleteScheduledMessage` | [V] docs.slack.dev/reference/methods/chat.scheduleMessage · docs.slack.dev/messaging/sending-and-scheduling-messages. 전달 실패 때 작성자 알림은 이 문서에 없다 [확인 필요] |
| Slack (제품 화면) | 전송 단추 옆 화살표, 프리셋(내일 오전 9시·다음 주 월요일)·직접, 채널 배너, 「Drafts & sent › Scheduled」에서 편집·시간 변경·지금 보내기·삭제 | [추정] 이슈 본문의 planner 기술이다. slack.com 도움말 URL 세 곳이 404여서 원문을 열지 못했다 |
| Mattermost | 보내기 오른쪽 면(폰은 길게 누르기). 고정 시각 또는 직접, 내 현지 시각과 받는 사람 현지 시각을 함께 보임. Drafts › Scheduled 탭에서 삭제·인라인 편집·복사·다시 예약·지금 보내기. 실패 사유: 채널 멤버 아님·채널 보관·읽기 전용. **24시간 지난 예약은 처리하지 않음.** 실패 알림은 Drafts 옆 붉은 배지 + Scheduled 탭 경고 배너. 실패한 글은 다시 예약할 수 없고 새로 써야 함 | [V] docs.mattermost.com/end-user-guide/collaborate/schedule-messages.html |
| Gmail | Send 옆 아래 화살표 › Schedule send. **최대 100개.** 「Scheduled」 목록. 취소하면 초안이 됨. 예약한 시간대 기준으로 나가고 몇 분 늦을 수 있음 | [V] support.google.com/mail/answer/9214606 (Computer·iPhone 두 안내) |
| Telegram | 채팅마다 서버 쪽 예약 큐(`schedule_date`). 10초 미만이면 즉시 전송. 편집으로 시각 변경. `sendScheduledMessages` = 지금 보내기, `deleteScheduledMessages` = 삭제. 시각이 되면 `from_scheduled` 표시가 붙은 메시지가 나옴 | [V] core.telegram.org/api/scheduled-messages |
| Teams · 카카오톡 | 확인하지 못했다 | [확인 필요] 결정에 쓰지 않았다 |

가져온 것: 서버 큐와 정시 전송(Telegram·Slack·Mattermost), 120일 상한(Slack), 목록·지금 보내기·시간 변경·삭제(Telegram·Mattermost), 실패 사유 세 갈래와 「배지 + 배너」 표면(Mattermost), 개수 상한(Gmail 100), 「예약한 시간대 기준 + 몇 분 늦을 수 있음」(Gmail). 바꾼 것: Mattermost의 24시간 창은 우리 유예 창으로(D7), 「실패한 글은 다시 못 예약」은 우리는 본문을 보관하므로 다시 예약을 허용한다(D9). 받는 사람 현지 시각 표시는 서버가 멤버 시간대를 몰라 v1 밖이다.

## 결정 표

| # | 결정 | 이슈 본문 제안 대비 |
|---|---|---|
| D1 | v1 범위: 사람이 자기가 쓸 수 있는 채널·DM·스레드에 텍스트(+첨부) 예약. 에이전트·인용·모델 지정·서명·반복은 밖 | 확정(인용·모델 지정·서명 제외를 명시) |
| D2 | 시각은 `sendAtMs`(UTC epoch ms) 저장, 지금+60초 ~ 120일, 프리셋·표시는 클라이언트 시간대 | 이름 `sendAt` → `sendAtMs`, 422 → 400 + 코드 |
| D3 | 새 표 `scheduled_message`·`scheduled_message_attachment`, 작성자 범위 RLS FORCE, 상태 4종, relay·worker·notifier·platform_admin은 표 권한 봉인(마이그레이션과 부트스트랩 둘) | `sending` 삭제, `canceled` → `cancelled`, 점유 표·`next_attempt_at`·`armed_session_id` 추가 |
| D4 | 보내기는 **정본 send 조합을 한 함수로 뽑아 REST와 스케줄러가 같이 부른다**, 한 트랜잭션, `client_msg_id` = 예약 id | 확정, 공유 함수 추출을 전제로 명시 |
| D5 | 스케줄러는 **api 프로세스의 백그라운드 틱** | 위치를 열어 둔 것을 확정(notifier·agent-worker·relay 기각) |
| D6 | 만기·정리 목록은 **최소 권한 소유자(NOLOGIN NOBYPASSRLS)의** SECURITY DEFINER **id 세 개** 함수 둘(`momo_join_private`·`mem_definer` 선례) | 「함수 또는 전용 역할」 중 함수로 확정, 소유자를 슈퍼유저가 아닌 역할로 |
| D7 | 틱 5초(워크스페이스 공정 처리), `FOR UPDATE SKIP LOCKED`, DB 시계, SAVEPOINT로 같은 tx 마감, 백오프 재시도, 유예 60분 뒤 `missed`/`send_error` | 정시 ±30초 목표 확정, 「늦게 보냈어요」 표시는 두지 않음 |
| D8 | 실패 사유 8종(닫힌 집합, `sessions_ended` 신설). v1 알림은 **앱 안**(목록·배너·사이드바 알약·웹 이벤트·폰 재조회), 푸시는 후속 | **푸시 제외**(닫힌 푸시 어휘) |
| D9 | 편집은 마감 30초 전까지, 취소·지금 보내기는 보내기 전까지. 지금 보내기는 요청 tx 안에서 같은 함수 | 취소·지금 보내기의 30초 잠금 삭제 |
| D10 | 상한: 멤버·워크스페이스당 대기 50개, 첨부 20개, 본문은 일반 메시지와 같음. 속도 제한은 증보 1(#4234) | 확정 |
| D11 | 첨부는 예약 때 선검증 + 점유, 보낼 때 정본 규칙으로 재검증 | 확정(점유 표 추가) |
| D12 | 개인 채널 이벤트 `scheduled_message.updated` | 이름 `scheduled.updated` → 규약대로 |
| D13 | 감사 행 5종, 본문 불포함 | 확정 |
| D14 | 수명·자격 회수: 보낸·취소한 행은 본문을 지운다, 틱이 정리, 세션 종료·기기 해제·재사용은 대기 예약과 실패 행을 멈추고 추방·탈퇴는 취소 | 신설 |
| D15 | 운영: 선택 환경 변수 4개, 꺼짐이면 생성 503, doctor 점검 | 신설 |
| D16 | 클라이언트 계약: 코어 모듈 하나, 보내기 전 판정 공유, 201 뒤 스냅샷이 같을 때만 비움, 내용이 바뀌면 새 `clientRequestId` | 신설(UI 명세 연결) |

## 결정

### D1. 범위 (v1)
- 사람 멤버가 **자기가 현재 멤버인** 채널·DM에, 필요하면 스레드 루트(`rootId`)에 **텍스트 메시지(+미리 올린 첨부)**를 예약한다. 라우트 앞단은 리마인더와 같다: 사람 bearer 필수·살아 있는 멤버 필수(`reminders.rs:37`, `:68-89`), 에이전트 bearer는 403.
- v1 밖: 에이전트 작성, `type`이 text가 아닌 메시지, `props`, 인용 답장(`reply_to_id`), 모델 지정(`routing`), 서명(provenance), 반복 예약, 받는 사람 현지 시각 표시. 근거: 인용 대상은 보낼 때 사라질 수 있고(ADR-0148 규칙 2), `routing`은 보낸 시각의 워크스페이스 허용 목록으로 판정해야 하며, 서명은 정시에 기기가 없다. 이 값들은 요청 스키마에 없고(`additionalProperties: false`) 보내면 400이다. 작성 중 인용·`routing`이 켜져 있으면 UI가 그 사실을 말한다(부록 B).
- 정시 에이전트 호출은 된다: 예약이 `@에이전트`·1:1 DM·스레드 답 깨움을 일으키는 것은 **보낸 시각에 일반 메시지처럼**이다(D4).

### D2. 시각
- 저장은 `send_at timestamptz`(UTC 절대 시각), 와이어는 `sendAtMs`(에포크 밀리초). 시간대는 저장하지 않는다. 근거: `openapi.yaml:35` 「타임스탬프는 에포크 밀리초이고 `AtMs` 접미사」, 리마인더 `dueAtMs`.
- 범위: **지금 + 60초 이상, 120일 이하**(Slack API 120일 [V]). 서버가 DB 시계로 판정하고 벗어나면 **400** + `error.code`(`send_at_too_soon`: 과거 포함 · `send_at_too_far`). 근거: 리마인더가 과거 `dueAtMs`에 400을 답한다(`openapi.yaml` 리마인더 생성 400).
- 프리셋·표시는 **클라이언트 시간대**다. 프리셋 계산은 코어의 `localHourOnOffsetDay`·`nextMondayLocalHour`(`packages/momo-core/src/features/reminders/presets.ts:48-62`)를 재사용하고, 문구는 새로 쓴다(리마인더 문구는 합쇼체). 모든 시각 선택 화면은 시간대 이름과 UTC 오프셋을 함께 보인다.
- 프리셋은 두 개와 「직접 고르기」다: 내일 오전 9:00, 다음 주 월요일 오전 9:00(일요일에는 내일과 같은 시각이라 숨긴다).

### D3. 저장
- **`scheduled_message`** (새 테넌트 표, 마이그레이션은 구현 시점의 다음 번호다. 작성 시점 `origin/track/engine`의 최대는 144이고 열린 PR 중 마이그레이션을 더하는 것은 없다 [V])
  - `id` uuidv7 · `workspace_id` · `channel_id` · `author_member_id` · `root_id` NULL · `body` NULL · `send_at` · `status` · `failure_reason` NULL · `attempts` · `next_attempt_at` NULL · `sent_message_id` NULL · `sent_at` NULL · `client_request_id` · `armed_session_id` NULL(내용을 마지막으로 쓴 세션 계열, `token.session_id`. 생성·본문 변경·다시 걸기 때마다 요청의 `principal.token_id`로 조회해 갱신한다. 시각만 바꾸는 수정은 옮기지 않는다) · `rev` · `created_at` · `updated_at`
  - `status`는 `pending | sent | failed | cancelled`. `cancelled` 철자는 레포 관례를 따른다(`agent_run`·`cloud_box_control` 모두 `cancelled`).
  - CHECK: `status IN ('pending','failed')`이면 `body IS NOT NULL`이다(첨부만 있는 예약은 빈 문자열이다. 「글 또는 첨부 하나 이상」은 CHECK가 자식 표를 볼 수 없어서 앱이 생성·수정 때 판정한다). 끝난 행(`sent`·`cancelled`)은 **본문을 지운다**(D14).
  - UNIQUE `(workspace_id, author_member_id, client_request_id)`: 생성 재시도 멱등.
  - 인덱스: 만기 스캔용 부분 인덱스 `(send_at, id) WHERE status = 'pending'`(전 테넌트 스캔이라 워크스페이스가 앞에 서지 않는다. D6의 함수는 기한 지난 행만 읽어 워크스페이스·시각으로 정렬하고, 워크스페이스를 앞세운 인덱스를 더해도 플래너가 쓰지 않았다), 정리 스캔용 `(updated_at) WHERE status <> 'pending'`, 목록·상한 계산용 `(workspace_id, author_member_id, status, send_at)`.
- **`scheduled_message_attachment`**: 첨부 1건당 1행(`scheduled_message_id`, `attachment_id` **UNIQUE**, `position`). 예약이 첨부를 점유하는 것을 DB가 강제한다(D11).
- RLS: 두 표 모두 ENABLE + FORCE, 정책은 082 모양의 **워크스페이스 + 작성자**다(자식은 `member_id` 사본과 복합 FK로 부모와 같음을 보장). 모든 문장이 `app.member_id`를 묶는다(`bind_reminder_owner_guc`, `reminder.rs:119`와 같은 모양, 구현은 공용 이름으로 뽑는다).
  - **082와 다른 한 곳: 워크스페이스 항에도 `NULLIF`를 건다.** `workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid AND author_member_id = nullif(current_setting('app.member_id', true), '')::uuid`(`USING`과 `WITH CHECK` 모두, 자식 표 정책도 같다). 082의 워크스페이스 항은 `NULLIF` 없이 `::uuid`로 바꾼다(`082_message_reminder.sql:47-54`). 테넌트 tx를 한 번 돌린 풀 연결은 GUC 자리표시가 빈 문자열로 남아 `''::uuid`가 22P02를 내고, PG는 허용 정책을 모두 평가하므로 이 정책은 D6의 정의자 함수 읽기에서도 평가된다. 저장소가 이미 겪고 고쳤다(`142_github_ingress.sql:175-184`와 `100_mem_digest.sql:805-816`은 `NULLIF`로, `102_mem_worker.sql:303-305`는 빈 값을 되돌리지 않는 방식으로). 격리 PG에서 재현하고 `NULLIF`로 닫히는 것을 확인했다(「설계 실측」).
- **봉인.** 이 표의 본문은 보내기 전에는 작성자만 읽어야 하는데 BYPASSRLS 역할은 정책을 건너뛰고, 기본 권한이 `CREATE TABLE`의 순간 relay·worker에게 DML을 준다(`bootstrap_runtime_roles.sql:56-59`). 그래서 relay·worker·notifier·platform_admin이 두 표를 읽고 쓰지 못하게 **마이그레이션과 두 부트스트랩 파일(`bootstrap_roles.sql`·`bootstrap_runtime_roles.sql`) 모두에** 봉인 블록을 둔다(마이그레이션에는 역할이 있을 때만 도는 REVOKE).
  - 모양은 `cloud-box-lockdown`(`bootstrap_runtime_roles.sql:215-245`)을 따르되 **`momo_app`의 DELETE는 회수하지 않는다**(점유 해제·정리가 DELETE를 쓴다). 그 블록이 `momo_app`에서 DELETE를 회수하는 것은 cloud-box가 행을 지우지 않기 때문이다(`:233-234`).
  - 기존 시험 `momo-notifier/tests/prod_role_conformance_pg.rs:930-965`는 `mem_*`·`plugin_registry`·`cloud_box*`를 뺀 모든 표에 app·relay·worker의 전체 권한을 요구한다. 두 표를 그 제외 목록에 더하고, cloud-box의 드리프트 스캔(`:951-965`)을 본떠 `momo_app` = SELECT·INSERT·UPDATE·DELETE 넷 다, relay·worker·notifier = 0이라는 스캔을 새로 둔다. 같은 블록 세 벌(마이그레이션·두 부트스트랩 파일)의 일치는 mem-lockdown의 마커 시험을 본떠 잰다(`momo-server/tests/mem_schema_conformance_pg.rs:2442-2458`). cloud-box에는 문자열 마커 시험이 없다.

### D4. 보내기 경로 = 정본 send 그대로, 한 트랜잭션
- `messages.rs:694-845`의 조합(멤버 확인 → 루트 검증 → `send_message_with_mentions_in_tx` → `route_agent_mentions_in_tx`)을 **하나의 함수**(예: `deliver_message_in_tx`)로 뽑아 REST `send`와 스케줄러와 지금 보내기가 같은 함수를 부른다. 이 함수가 REST의 동작을 바꾸지 않는 **동작 보존 리팩터**여야 하고, 그것이 #4214의 첫 커밋이다(기존 PG 적합성 시험이 무수정으로 통과해야 한다). 공유하지 않고 베끼는 것이 이 ADR이 기각하는 설계다.
- 추출한 함수는 HTTP 오류가 아니라 **타입이 있는 거절**을 돌려준다. 지금은 거절이 tx 안에서 곧바로 `SendFailure::Rejected(ApiError)`로 만들어진다(`messages.rs:702-706`, `:496-519`). REST는 그 거절을 기존 `ApiError`로, 스케줄러는 D8의 사유로 옮긴다.
- 스케줄러의 호출 값: `author_is_human`·`author_is_agent`는 상수가 아니라 `member.kind`에서 도출한다(「사람의 명시적 호출」에만 서는 분기, 예: 인플레이스 채널 허용 카드 `agent_mentions.rs:167-170`이 예약에서도 같은 값으로 판정된다), `via_token_id = None`, `routing = None`, `signature = None`, `client_msg_id = scheduled_message.id`, `attachment_ids = 점유된 첨부`. 게이트·플래그는 api의 AppState에서 같은 값으로 온다.
- **`app.member_id`는 정본 함수를 부르는 동안 비운다.** REST는 그것을 묶지 않으므로, 예약 표를 만지는 문장에서만 묶고 정본 호출 앞에서 비워 두 경로가 같은 GUC 상태에서 돈다.
- 전송 tx 안에서(스케줄러는 D7의 판정 tx 다음, 지금 보내기는 요청 tx): 행 잠금(`FOR UPDATE`) → 판정(D8) → 정본 전송 → `scheduled_message`를 `sent`로 → 점유 행 삭제 → 개인 채널 outbox(D12) → 감사(D13). 롤백하면 메시지·outbox·상태가 함께 사라진다.
- 결과로 **그 시각에** 일반 메시지처럼 난다: 받는 쪽 푸시 후보·인박스 항목(INSERT 트리거), 멘션 배지, @에이전트 호출·1:1 DM 암묵 호출·스레드 답 깨움, hosted inbox 팬아웃, 스레드 롤업, 브로드캐스트. 메시지 시각은 실제로 보낸 시각이다. 작성자의 읽음 커서는 올라가지 않으므로 작성자에게는 안 읽음 1로 센다(남는 위험 9).
- **「예약됨」 표식은 수신자에게 보이지 않는다.** 메시지 행도 `props`도 일반 전송과 같다. 근거: 받는 사람에게 필요한 사실은 「지금 왔다」뿐이고, 표식은 작성자가 예약을 쓴다는 사실을 팀에 공개한다. 예약과 메시지의 연결은 작성자의 감사 행(`sentMessageId`)에만 남는다. (Telegram은 `from_scheduled` 플래그를 두지만 수신자 화면에 쓰는지는 확인하지 못했다 [확인 필요].)
- 서명이 필요한 호출(개인 에이전트 등)은 서명 없는 REST send와 같은 판정을 받는다. 예약이 권한을 더하지 않는다.

### D5. 스케줄러 위치 = api 프로세스의 백그라운드 틱
| 후보 | 판정 | 근거 |
|---|---|---|
| **api 프로세스 틱** | **채택** | D4의 공유 함수가 `momo-server` 안에 있고 `route_agent_mentions_in_tx`가 `pub(crate)`다. 같은 프로세스·같은 AppState여야 「일반 메시지처럼」이 문자 그대로 참이다. api는 모든 배포(self-host 기본 스택·Railway)에서 상주한다. 새 자격 증명도 새 서비스도 없다 |
| notifier 두 풀 정리 작업 | 기각 | 후보 읽기(BYPASSRLS)와 RLS 묶인 쓰기라는 모양은 맞지만 ① notifier는 self-host 기본 스택에 없다(`docker-compose.rust.yml:6-20`). 정시에 나가야 하는 기능을 선택 오버레이에 걸 수 없다 ② 멘션 호출을 하려면 `pub(crate)` 함수와 AppState 플래그를 notifier로 옮기거나 복제해야 한다. 복제본은 에이전트 설정이 어긋날 때 조용히 멈추는 전례가 있다(`momo-agent-worker/src/config.rs:82-86`: 같은 키를 두 곳이 읽다 어긋나면 위임이 조용히 선다) |
| agent-worker | 기각 | `momo_worker`는 BYPASSRLS라 사람이 쓴 글의 쓰기 경로가 되고 (AGENTS.md: 쓰기 경로 BYPASSRLS 금지), 멘션 호출은 위와 같은 이유로 못 부른다 |
| relay | 기각 | 전달 전용 프로세스다. 전송 지연이 전달 지연으로 번진다 |
| 새 `momo-scheduler` 바이너리 | 기각(v1) | compose·Railway 카탈로그·doctor가 서비스 하나씩 늘고, 같은 AppState 설정을 한 벌 더 복제해야 한다 |

- **이 선택의 비용을 이름으로 적는다.** (1) api 바이너리의 **첫 상주 백그라운드 작업**이다. (2) 틱은 요청 풀과 **분리된 2연결 풀**을 쓴다(요청 지연과 경쟁하지 않는다). (3) SIGTERM에서는 처리 중인 예약 하나만 마치고 멈춘다(롤백돼도 `pending`으로 남는다). (4) 조용히 멈추면 아무도 모르므로 doctor 점검이 필요하다(D15). (5) 레플리카마다 틱이 돈다: 중복은 행 잠금이 막는다(D7).

### D6. 만기 목록 읽기 수단 = 최소 권한 소유자의 SECURITY DEFINER id 함수 둘
api 역할은 NOBYPASSRLS라 「지금 기한 된 예약이 어느 워크스페이스에 있는가」를 RLS 너머로 읽을 수단이 필요하다. 결정은 `momo_join_private.*` 선례(`009_workspace_tenant_rls.sql:21-60`, `086_device_link_token.sql:89-120`)의 모양에 더 새 선례(`mem_definer`: NOLOGIN NOSUPERUSER NOBYPASSRLS, `100_mem_digest.sql:31-33`)의 **소유자**를 합친다.
- 함수 둘: `momo_schedule_private.due_scheduled_messages(p_limit integer)`와 `momo_schedule_private.expired_scheduled_messages(p_limit integer)`. 둘 다 `(workspace_id, scheduled_message_id, author_member_id)` **세 id만** 돌려준다. `LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog`, 참조는 `public.`으로 한정, `LIMIT least(greatest(p_limit,1),200)`.
  - due: `status = 'pending' AND send_at <= now() AND (next_attempt_at IS NULL OR next_attempt_at <= now())`인 행 중 **워크스페이스마다 `send_at, id` 순으로 25번째까지**만 `row_number() OVER (PARTITION BY workspace_id ORDER BY send_at, id)`로 고르고 `ORDER BY rn, send_at, id`로 워크스페이스를 번갈아 돌려준다. 전역 `ORDER BY send_at, id LIMIT`이면 한 테넌트의 백로그가 배치를 다 채워 다른 테넌트가 굶는다(격리 PG에서 확인). 이 모양은 기한이 지난 pending 전체를 정렬하므로 대량 백로그에서 비용이 커진다. v1 규모(멤버당 대기 50개 상한)에서 수용하고 doctor가 5분 초과를 잡는다(D15).
  - expired: 보낸·취소한 행은 `updated_at`이 7일 전, 실패 행은 30일 전, `ORDER BY updated_at, id`.
  - 워크스페이스 표를 조인하지 않는다. 삭제된 워크스페이스는 틱의 tx가 판정한다(D7).
- **소유자는 전용 역할 `momo_sched_definer`(NOLOGIN NOSUPERUSER NOBYPASSRLS)다**(마이그레이션이 만든다). 슈퍼유저 소유가 아니다. 이 역할에는 **열 단위 SELECT**(`id, workspace_id, author_member_id, status, send_at, next_attempt_at, updated_at`: `body`·채널·루트가 없다)와 **SELECT 전용 정책**(`TO momo_sched_definer USING (기한이 된 pending, 또는 정리 대상인 끝난 행)`)만 준다. 함수가 나중에 잘못 고쳐져도 본문에 닿지 못하고, 아직 기한이 안 된 예약과 최근 행은 정책에서 보이지 않는다.
- 권한: `REVOKE ALL ... FROM PUBLIC`과 relay·worker·notifier·platform_admin, `GRANT USAGE ON SCHEMA`와 `EXECUTE`는 `momo_app`만. **마이그레이션이 역할보다 먼저 돌 수 있으므로**(「지금 있는 것」) 같은 부여와 자기 점검(`has_function_privilege`: momo_app 예, 나머지 아니오, 소유자 posture)을 두 부트스트랩 파일에도 둔다. 부트스트랩은 마이그레이션 전에도 한 번 도므로(`bootstrap_runtime_roles.sql:8-10`) 함수가 아직 없는 패스에서는 `to_regprocedure`가 NULL이면 건너뛴다(`bootstrap_roles.sql:263-268`, `bootstrap_runtime_roles.sql:253` 선례). 점검이 없으면 틱이 오류 없이 아무것도 읽지 못한다.
- **노출면 평가(솔직하게).** 선례는 비밀 하나를 받아 id 하나를 돌려준다. 이 함수는 비밀을 받지 않고(한도 정수뿐) 기한이 된 (워크스페이스, 멤버) 쌍을 돌려준다. RLS는 앱이 GUC를 정직하게 건다는 신뢰 모델이라, 그 쌍은 그 테넌트와 그 멤버의 소유자 범위 표(리마인더·사이드바 설정 등)를 여는 **열쇠**다. `momo_app` 자격이 SQL 수준으로 새면 예약을 쓰는 모든 테넌트의 열쇠가 비밀 없이 마감 시각마다 드러난다. 줄인 것: 소유자를 최소 권한 역할로 바꿔 함수 자체로는 본문에 못 닿고, 한 번에 200행·기한이 된 것만 돌려준다. **이 위험은 planner가 수용했다**(2026-10-22, 「owner 결정」 ⑤). 더 줄이는 길(틱이 함수에 쓰는 별도 DB 자격, 함수가 요구하는 부팅 비밀)은 새 자격 증명이라 이 ADR이 하지 않는다.
- 기각한 수단: (a) 슈퍼유저 소유 함수(`momo_join_private` 모양 그대로): 소유자가 모든 정책을 우회한다. (b) 전용 읽기 역할 + `momo_app`의 `SET LOCAL ROLE`: 역할 멤버십이 api 자격에 붙는다. (c) api에 `momo_notifier` 풀: api가 BYPASSRLS 자격을 갖는다(`SECURITY.md:80-89`가 막는 상태). (d) `momo_app`용 GUC 게이트 교차 테넌트 정책: 본문 행 전체가 열거 대상이다.

### D7. 정시성 · 다중 레플리카 · 밀린 예약
- **틱**: 5초(`MOMO_SCHEDULER_TICK_MS`, 바닥 1초). 한 틱은 **20초 예산 안에서** 만기 목록(`due`, 배치 100: 워크스페이스마다 25건까지, 번갈아 돌려준다. D6)을 **직렬**로 처리한다. 한 번 시도한 id는 같은 틱에 다시 시도하지 않는다. 한 테넌트의 몰림(모두가 「내일 오전 9:00」을 고르는 경우)이 다른 테넌트의 예약을 유예 밖으로 밀지 않게 하려는 장치다. 상한이 워크스페이스당 틱 25건이라 한 워크스페이스의 5000건 몰림은 약 200틱(17분)에 걸쳐 나간다. 채널당 상한은 따로 없다(남는 위험 1).
- **순서는 보장하지 않는다.** 레플리카가 둘이면 뒤 항목이 먼저 커밋될 수 있고, 일시 오류로 미뤄진 항목 뒤의 항목은 같은 틱에 나간다. 같은 작성자가 같은 채널에 마감이 같은 두 메시지를 걸었고 순서가 중요하면 한 메시지로 쓴다.
- **한 건은 두 개의 tx로 처리한다.** 둘 다 `with_tenant_tx_prelude`로 `app.workspace_id` + `app.member_id`(작성자)를 묶고, tx마다 `lock_timeout` 3초·`statement_timeout` 15초를 건다(넘으면 일시 오류로 센다).
  - **판정 tx**(짧다): 가장 먼저 워크스페이스를 본다. 소프트 삭제된 워크스페이스(`get_workspace`가 `None`, `identity.rs:104-116`)면 그 행을 같은 tx에서 `cancelled`(본문 폐기)로 마감한다. 아니면 `SELECT ... FROM scheduled_message WHERE id = $1 AND status = 'pending' AND send_at <= now() AND (next_attempt_at IS NULL OR next_attempt_at <= now()) FOR UPDATE SKIP LOCKED`, 0행이면 건너뛴다(다른 레플리카가 잡았거나, 그사이 취소됐다). 유예가 지났으면 **여기서 마감한다**(「밀린 예약」). 아니면 `attempts`를 1 올리고 `next_attempt_at`을 백오프로 미룬 뒤 커밋한다. **`attempts`를 올리는 곳은 여기뿐이다.** 시도마다 한 번 올라 몇 번째 시도인지가 DB에 남고, 패닉이나 무한 대기를 일으키는 행도 백오프로 밀려 틱 전체를 멈추지 못한다. 행마다 패닉을 격리하고 틱 예산 안에서 건너뛴다. **판정 tx 자체가 실패하는 행**(패닉 포함)은 `attempts`가 오르지 못하므로 틱이 프로세스 메모리에서 5분 건너뛴다. 그래도 닫히지 않으면 doctor가 5분 초과로 잡는다(D15).
  - **전송 tx**: 같은 행을 다시 잠그고(`WHERE id = $1 AND status = 'pending' AND attempts = $k FOR UPDATE SKIP LOCKED`. 판정 tx가 미룬 `next_attempt_at`은 보지 않는다) 판정(D8) → 정본 전송(D4) → 성공이면 같은 tx에서 `sent`. 0행이면(그사이 취소·지금 보내기) 건너뛴다. 거절과 일시 오류는 아래 SAVEPOINT 항목이다.
- **한 번만 보낸다**: ① 행 잠금 + `status` 재확인이 INSERT와 같은 tx ② 상태 전이가 같은 tx라 「메시지는 있는데 행은 pending」은 만들어지지 않는다 ③ 그래도 같은 `(channel_id, author_member_id, client_msg_id)`의 메시지가 이미 있으면(작성자가 예약 id를 REST의 `clientMsgId`로 쓴 경우에만 가능하다) 보내지 않고 `failed` + `send_error`로 마감하고 감사에 남긴다. 다른 메시지로 조용히 `sent`를 적지 않는다.
- **시계는 DB다.** 모든 비교가 `now()`다(레플리카 시계 차이를 쓰지 않는다).
- **정시 목표**: 마감 후 30초 안(틱 5초 + 처리). 보장이 아니라 목표이고 doctor가 5분 초과를 잡는다(D15).
- **거절은 SAVEPOINT 안에서 같은 tx로 마감하고, 일시 오류는 되돌린다.** 정본 전송은 SAVEPOINT 구간 안에서 돈다. 정본이 돌려주는 **거절**(D8; `SendRejected`는 「호출자가 롤백」 계약이다, `message.rs:816-823`)이면 `ROLLBACK TO SAVEPOINT`한 뒤 **행 잠금을 쥔 채** 같은 tx에서 `UPDATE ... SET status = 'failed', failure_reason = ... WHERE id = $1 AND status = 'pending'`으로 마감한다. 잠금이 풀리는 틈이 없어 `sent`·`cancelled` 행을 덮어쓰지 않고, 취소·지금 보내기·다른 레플리카가 끼어들 수 없다. **일시 오류**(DB 오류·타임아웃)는 전송 tx를 되돌리는 것으로 끝이다. 행에는 판정 tx가 적어 둔 백오프(5초 · 15초 · 45초 · 2분 · 5분, 이후 5분마다)가 그대로 있어 그 시각이 지나면 다시 잡힌다. 연결이 끊겨 tx가 죽어도 같다.
- **밀린 예약**: 예약 시각에서 **유예(기본 60분, `MOMO_SCHEDULER_GRACE_SECONDS`, 5분~24시간)** 안이면 늦어도 계속 시도한다(롤링 배포·재시작·짧은 장애). 유예가 지나면 보내지 않고 판정 tx에서 `failed`로 마감한다: `attempts = 0`이면(한 번도 시도하지 못했다) `missed`, 1 이상이면(시도했는데 일시 오류가 이어졌다) `send_error`. 작성자가 정한다(지금 보내기 · 다시 예약 · 삭제). 근거: 「내일 9시 스탠드업」을 반나절 늦게 조용히 보내는 것도, 말없이 버리는 것도 나쁘다. Mattermost는 24시간 창을 두고 넘으면 처리하지 않는다 [V]. 우리는 창을 줄이고 사용자에게 결정을 넘긴다. **「늦게 보냈어요」 표시는 두지 않는다**: 유예 안에서 나간 메시지는 최대 1시간 늦고 메시지 시각이 실제 시각이라 거짓이 없다.
- **`sending` 상태는 두지 않는다.** 전송과 상태 전이가 한 tx이고, 앞의 판정 tx는 `pending` 그대로 `attempts`·`next_attempt_at`만 바꾸므로 `sending`은 커밋된 적이 없고, 크래시는 `pending`으로 롤백한다. 임대(lease)와 멈춘 행 회수(푸시 드레인의 `reclaim_stuck` 같은)가 필요 없다. 이슈의 「409 보내는 중」은 행 잠금 대기(`lock_timeout` 3초)가 끝났을 때의 `scheduled_busy`로 표현한다.

### D8. 실패
- 사유는 닫힌 집합 8종이다(`failure_reason`, 엔진 소유 enum). 발사 때의 판정 순서는 삭제된 워크스페이스 → 유예 → `author_inactive` → `not_member` → `root_unavailable` → 정본 전송(`attachment_unavailable` 등)이다. 앞의 둘은 판정 tx(D7)에서, 나머지는 전송 tx에서 한다(전송 tx는 워크스페이스와 유예를 다시 보지 않는다. 판정 tx가 방금 통과시켰다). `sessions_ended`는 발사 전에 자격 회수가 미리 적는다.

| 사유 | 판정 | 비고 |
|---|---|---|
| `sessions_ended` | 자격 회수로 멈춤(D14): 비밀번호 변경·재설정, 정지, 기기 연결 해제, refresh 재사용 | 작성자가 내용을 보고 다시 걸어야 나간다 |
| `author_inactive` | 작성자 `member.status <> 'active'` 또는 삭제됨(`dm.rs:160-170` 모양) | 방어 판정이다. 정상 경로는 위 보류가 먼저 막는다. 지금 보내기로는 닿을 수 없다(정지된 사람은 인증을 못 한다) |
| `missed` | 유예가 지나도록 한 번도 시도하지 못했다(`attempts = 0`) | 서버가 쉬었다 |
| `send_error` | 한 번 이상 시도했고 유예가 지나도록 일시 오류가 이어졌다(`attempts >= 1`), 또는 예약 id가 다른 메시지의 `clientMsgId`와 겹쳤다(D7) | 서버 문제 |
| `not_member` | `is_channel_member`가 거짓(`identity.rs:130-145`) | 채널·대화에서 나갔다 |
| `root_unavailable` | `validate_thread_root_in_tx`가 거절(없음·삭제·최상위 아님) | 답하려던 글이 지워졌다 |
| `attachment_unavailable` | `link_attachments_in_tx`가 거절(`attachment.rs:476-487`) | 파일이 없거나 이미 쓰였다 |
| `not_allowed` | 정본 경로가 앞으로 더하는 다른 정책 거절 | 지금은 비어 있다 |

- **보관 채널은 사유가 아니다.** 정본이 막지 않는다(「지금 있는 것」). 보관 채널 전송을 막는 규칙이 정본 경로에 들어가면 스케줄러는 자동으로 따른다(`not_allowed`).
- **알림은 v1에서 앱 안이다**: (a) 개인 채널 이벤트로 작성자의 웹·데스크탑 기기(D12) (b) 「예약됨」 목록의 「보내지 못함」 구역과 사유 (c) 그 채널의 입력창 위 배너가 실패 어조로 바뀐다 (d) 사이드바 「예약됨」 줄의 알약(보내지 못한 수). **폰에는 개인 채널 구독이 없어**(`useMailbox.ts:57`) 폰은 포커스·당겨서 새로고침·마감 뒤 재조회로 읽는다. 푸시는 없다.
- **푸시는 이 ADR이 하지 않는다. 비용을 이름으로 적는다**: 와이어가 닫힌 어휘이고 메시지 id가 필수인데 보내지 못한 예약에는 메시지가 없다. 새 푸시는 ① reason 1종 추가(relay `ALLOWED_REASONS`, 서버 `PushReason`, 앱 상수) ② `message_id` 자리에 올 값(예약 id) 또는 새 선택 키: **키 집합 변경은 ADR-0120 변경이다**(`momo-push/src/dispatch.rs` 머리) ③ NSE가 무엇을 가져와 그릴지 ④ `push_candidate`의 새 생산자(ADR-0204 D8-a가 「Accepted ADR 없이 더하지 않는다」고 못 박았다) ⑤ relay 먼저 → 서버 → 앱 배포 순서(ADR-0204 D7)를 요구한다. 그래서 새 reason과 위 다섯 비용은 ADR-0206(#4223)에서 함께 정한다. **그 전까지 실패는 앱을 열어야 보인다**(수용, 위험 2).

### D9. 편집 · 지금 보내기 · 취소
- **편집**(`PATCH {body?, sendAtMs?}`, 하나 이상; 본문 변경과 다시 걸기는 `armed_session_id`를 요청 세션으로 갱신하고 시각만 바꾸는 수정은 갱신하지 않는다, D14): `pending`이고 마감까지 **30초 넘게 남았을 때만**. 30초 안이면 409 `scheduled_too_late`. 근거: 마감 직전의 편집은 쓴 글이 아니라 곧 나갈 글을 바꾸는 일이라 서버가 「곧 보내요」를 `scheduled_too_late`로 말한다(그 뒤 열어 둔 편집기가 마감을 넘기면 `scheduled_already_sent`). 행 잠금 덕에 경쟁 자체는 안전하다.
- **`failed` 행**: `sendAtMs`를 주면 `pending`으로 되살아난다(`attempts`·사유·`next_attempt_at` 초기화, 대기 50개 상한에 다시 센다). `body`만 주면 글만 고친다(이때 클라이언트는 `sendAtMs`를 보내지 않는다. 지난 시각은 400이다). 자격 회수로 멈춘 행(`sessions_ended`)은 이렇게 작성자가 다시 걸어야 나간다.
- **지금 보내기**(`POST …/send-now`): `pending`·`failed`에서 허용. **요청 tx 안에서 D4의 같은 함수를 부른다**(마감을 지금으로 당겨 한 틱 기다리는 방식 대신). 행 잠금이 스케줄러를 배제하고, 요청자는 즉시 결과를 받는다. 이때 `via_token_id`는 요청의 것이다(스케줄러는 `None`). 거절이면 409 + `error.code` = 실패 사유, 행은 `failed`가 된다.
- **취소**(`DELETE`): `pending`·`failed`에서 허용, **마감 30초 안에서도 된다.** 취소는 가장 중요한 안전 동작이고 행 잠금이 경쟁을 닫는다(스케줄러가 먼저 잠그면 취소가 기다렸다가 409 `scheduled_already_sent`, 취소가 먼저면 스케줄러의 재확인이 0행). **마감이 지난 `pending` 행도 지우기·지금 보내기가 된다**: 스케줄러가 꺼져 있거나 유예 중일 때 사람이 멈출 수 있어야 한다(꺼짐에서도 삭제는 된다, D15). 이슈 본문은 셋 다 30초 잠금이었으나 근거가 없었다.
- 락 대기 상한 3초를 넘기면 409 `scheduled_busy`(다시 시도).
- 생성은 **`clientRequestId` 조회가 맨 먼저**다. 있으면 시각·상한·첨부 검증 없이 저장된 행을 201로 돌려준다(응답을 잃은 재시도가 자기 점유 때문에 409·400을 받지 않게 한다). 그 결과 같은 id에 다른 내용을 보내면 **옛 행이 돌아온다**: 클라이언트는 본문·시각·첨부·`rootId`가 바뀌면 새 id를 쓰고(D16), 같은 요청의 재시도에만 같은 id를 쓴다.

### D10. 상한
- 멤버·워크스페이스당 `pending` **50개**(Gmail 100·Slack 채널당 5분 30개와 같은 부류의 남용 방지). 생성과 `failed` → `pending` 되살리기가 센다(지워도 `failed` 행은 자리를 비우지 않는다: 센 것은 `pending`뿐이다). 동시성은 `pg_advisory_xact_lock(hash(workspace, member))` 아래에서 센다(`dm.rs:183` 선례). 초과는 409 `pending_limit_reached`.
- 첨부는 메시지당 20개(`attachment.rs:55`). 본문 상한은 일반 메시지와 같다(서버에 별도 글자 수 상한이 없고 요청 본문 상한 2 MiB뿐이다). 그래서 멤버 한 명이 쥘 수 있는 본문은 최대 50 × 2 MiB다(남는 위험 10).
- **속도 제한**: 이 ADR의 첫 판은 이 서버에 per-member 축이 없다고 적었다(`rate_limit.rs:15-22`, 별도 이슈 #4234). **증보 1이 정한다**(멤버 × 표면 예산). 남용 방어는 대기 50개와 최소 1분, 틱의 워크스페이스별 공정 처리(D7), 증보 1의 쓰기 예산이 진다.

### D11. 첨부
- **예약 때** `link_attachments_in_tx`와 같은 술어를 미리 검증한다: `complete`, 업로더 = 작성자, 같은 채널, 묶이지 않음, 중복·20개 초과 없음. 오류 상태는 REST send와 같다(`messages.rs:388-402`: 400 중복·초과, 404 없음, 409 미완료·이미 묶임, 403 다른 업로더·다른 채널). 여기에 **다른 예약이 점유 중**이면 409 `attachment_reserved`.
- 점유는 `scheduled_message_attachment.attachment_id` UNIQUE가 강제하고, 같은 첨부를 두 예약이 쥐는 것을 막는다. 즉시 보내기가 먼저 그 첨부를 쓰면 예약은 보낼 때 정본 규칙(`message_id IS NULL`)에 걸려 `attachment_unavailable`이 된다. REST send에 「점유 중」 거절을 더하는 것은 정본 경로를 바꾸는 일이라 하지 않는다.
- **보낼 때** 정본 묶기가 같은 술어를 `FOR UPDATE` 아래에서 다시 판정한다. 어긋나면 `attachment_unavailable`.
- 취소·삭제하면 점유를 풀고 파일은 남는다(초안과 같은 상태). 완료됐지만 묶이지 않은 첨부를 거두는 청소기는 지금도 없고(`017_attachment.sql:36-39`) 이 ADR이 만들지 않는다: 후속 후보. → [ADR-0151 증보 2](0151-attachments-v0-drive-contract-port.md#증보-2-2026-10-25-4443-첨부의-수명)(#4443)가 만들었다(30일, 취소로 풀린 파일은 풀린 때부터 센다).

### D12. 기기 간 동기화 · 개인 채널 이벤트
- 모든 상태 전이(생성·수정·보냄·실패·취소)는 같은 tx에서 outbox 행을 쓴다(`emit_outbox`, 파티션 키 = member_id). 채널은 `user:read-state#<MEMBER_UPPER>`(ADR-0109 D3, `read_state.rs:177`).
- 이벤트 이름은 `scheduled_message.updated`(`inbox_item.*` 규약, ADR-0199 `:132`). 페이로드는 id·상태·시각만이다(`inbox_event_payload`, `inbox.rs:549-565` 모양):
```
data: { type: "scheduled_message.updated", v: 1, ts, payload: {
  workspace_id, member_id, scheduled_message_id, channel_id,   // 대문자 UUID
  status: "pending" | "sent" | "failed" | "cancelled",
  send_at_ms, rev,
  failure_reason?,            // failed일 때
  sent_message_id? } }        // sent일 때
idempotency_key: "<channel>:scheduled:<ID_UPPER>:<rev>"
```
- 본문·첨부 이름은 싣지 않는다. 클라이언트는 이벤트로 목록·배너를 무효화하고 `GET`으로 보강한다(유실은 다음 `GET`이 복구, 정본은 PG). 모르는 type을 무시하는 구버전 클라이언트는 영향이 없다(가산 변경).
- **구독은 클라이언트가 더해야 한다.** 웹의 개인 채널 구독은 `asInboxEvent`로 걸러 다른 type을 버리고(`serverInbox.ts:236`), 폰에는 개인 채널 구독 자체가 없다(`useMailbox.ts:57`). 그래서 코어 PR이 웹의 같은 구독에서 `scheduled_message.updated`를 나눠 받게 하고, 폰은 v1에서 포커스 복귀·당겨서 새로 고침·마감 35초 뒤 재조회로 읽는다. 폰의 새 구독(`RealtimeHandle`, `realtimeEvents.ts:1066`·`realtime.ts:572`)은 코어 PR이 소유한다(UI 두 이슈의 충돌 지점이다).
- `rev`는 행이 바뀔 때마다 1 올라 멱등 키의 꼬리가 된다.

### D13. 감사
- `audit_log` 행 5종: `scheduled_message.created` · `.updated`(본문 또는 시각 변경) · `.cancelled` · `.sent` · `.failed`. 지금 보내기는 `.sent`의 detail `via: "send_now"`다. 스키마 `momo.scheduled_message.<verb>.v1`, 대상 `("scheduled_message", id)`(`reminders.rs` 감사 모양).
- detail은 id·열거값·밀리초뿐이다(`sendAtMs`, `channelId`, `sentMessageId`, `failureReason`, `lateMs`, `armedSessionId`). **본문·첨부 이름을 싣지 않는다.** 내용을 쓴 세션 계열을 남기는 이유는, 발사 경로의 첨부·멘션 감사가 작성자 이름·`via_token` 없음으로 남아 탈취된 세션의 범위를 조사할 때 빠지기 때문이다.
- 사람이 한 일의 actor는 그 멤버다. 스케줄러가 한 `.sent`·`.failed`는 actor가 없고(시계는 멤버가 아니다, `momo-messaging/src/avatar_reclaim.rs:318-351` 선례) `about`이 작성자다.

### D14. 수명 · 보존 · 자격 회수 · 개인정보
- `sent`·`cancelled`가 되면 **같은 tx에서 본문을 지우고 점유 행을 삭제한다**(보낸 글의 정본은 message 행, 취소한 글은 DB에 남기지 않는다). 행 자체는 보낸·취소한 것 7일, 실패한 것 30일 뒤 정리한다.
- **정리는 틱이 한다**: `expired_scheduled_messages`(D6)가 돌려주는 행을 틱이 자기 tx에서 삭제한다(`momo_app` tx, 교차 테넌트 쓰기 없음). 작성자가 다시 쓰지 않아도 보존 기간이 지켜진다.
- **자격 회수: 예약은 「세션에 매달린 것」이다**(`session_end.rs:1-20`: 그런 것은 그 한 곳에 더한다). 작성자의 로그인이 사라진 뒤에 그 로그인이 걸어 둔 예약이 나가면 안 되고, 정지가 풀려도 되살아나면 안 된다(#2677).
  1. **멤버 전체의 세션 종료**(`end_member_sessions_in_tx`: 비밀번호 변경·재설정, 정지, 추방, 탈퇴)는 같은 tx에서 그 멤버의 **대기 예약과 모든 실패 행을 `failed` + `sessions_ended`로 멈춘다**(탈취된 세션이 심은 예약이 이미 `missed`나 `not_member`로 닫혀 있어도 내용 확인 없이 한 번 눌러 나가지 못하게 한다. 서버는 모든 실패 행에 지금 보내기와 다시 걸기를 허용하므로 사유를 가리지 않는다. 원래 사유는 확인 뒤 지금 보내기가 다시 판정한다). 취소가 아니라 멈춤이다: 정당한 예약을 말없이 잃지 않게 하고, 작성자가 내용을 보고 다시 걸어야 나간다(D9). 탈취된 세션이 심은 예약은 계정을 되찾은 뒤에도 말없이 나가지 않는다. **클라이언트는 이 사유의 행에서 본문 전체·첨부 이름·채널을 보여 주는 확인을 거친 뒤에만 지금 보내기와 다시 예약을 허용한다**(UI 명세 1.8: 두 줄 미리보기만 보고 한 번 눌러 나가면 멈춘 의미가 약하다). 쓴 기기·세션은 응답에 싣지 않는다(v1).
  2. **계열 하나의 종료 중 기기 연결 해제와 refresh 재사용**(`LineageEnd::DeviceUnlinked`·`RefreshReuse`)은 `armed_session_id`가 그 계열인 대기 예약과 실패 행을 같은 사유로 멈춘다(내용을 마지막으로 쓴 계열이라서, 작성자가 훔친 연결의 글을 고쳐 쓰면 그 예약은 더 이상 훔친 계열에 매이지 않는다. 시각만 바꾼 경우는 글을 고친 것이 아니라서 매인 채로 남는다). 이 경로의 tx는 워크스페이스 GUC만 건 `with_tenant_tx`이고(`device_link.rs:382`) 함수는 `member_id`를 인자로 받으므로 그 값으로 `app.member_id`를 묶는다. **로그아웃은 건드리지 않는다**: 부재 중에 나가게 하려고 예약하는 것이 이 기능의 쓰임이다. **기기 연결 해제는 로그아웃으로 토큰이 이미 취소된 연결에서도 보류해야 한다.** 지금 해제 라우트는 토큰이 하나도 살아 있지 않으면 결과가 `NotFound`이고(`momo-auth/src/device_link.rs:727-736`) 결과가 `Revoked`일 때만 `end_session_lineage_in_tx`를 부른다(`routes/device_link.rs:393-411`). 훔친 연결이 예약을 고친 뒤 로그아웃하면 이 경로가 보류를 건너뛴다. 그래서 해제 라우트는 결과와 무관하게 연결 행이 있으면 `linked_device_session_id_in_tx`가 돌려주는 계열(해제 뒤에도 읽힌다, `momo-auth/src/device_link.rs:740-742`)을 보류한다.
  3. **추방·탈퇴**는 같은 tx에서 그 멤버의 대기·실패 예약을 모두 `cancelled`(본문 폐기)로 정리한다. 호출 자리는 route 층의 두 곳이다: 추방 `member_lifecycle.rs:296-320`(안에서 `terminate_workspace_membership_in_tx`가 먼저 돌고 `membership_lifecycle.rs:502`, 그다음 `end_member_sessions_in_tx`), 탈퇴 `workspaces.rs:313-352`(`end_member_sessions_in_tx`가 먼저, 그다음 `terminate_…`). `momo-settings`는 `momo-messaging`에 의존하지 않으므로(`momo-settings/Cargo.toml`) `terminate_…` 안이 아니라 route 층에서 `end_member_sessions_in_tx` 옆에 부른다. 1과 3은 순서와 무관하게 결과가 취소다(보류와 취소 모두 대기와 실패 행을 만진다. 취소는 `sessions_ended`로 멈춘 행도 지운다).
  4. 1·2·3은 **워크스페이스 GUC만 건 tx가 소유자 범위 행을 만지는 유일한 자리**다(관리자의 추방·정지는 `shared.rs:262-273`, 계열 종료는 위 2). 이름 있는 함수 셋(`hold_member_schedules_in_tx`·`hold_lineage_schedules_in_tx`·`cancel_member_schedules_in_tx`)만이 **남의** `app.member_id`를 묶었다가 원래 값으로 되돌린다(되돌릴 값은 호출 전 `current_setting('app.member_id', true)`이고, 없었거나 빈 문자열이면 빈 문자열로 둔다. 정책이 `NULLIF`로 읽으므로 안전하다, D3). 틱과 정리가 자기 행의 작성자 id를 묶는 것은 이 규칙 밖이다. 시험이 남의 id를 묶는 곳이 이 함수들뿐이라는 것을 고정한다. 세 함수가 바꾼 행마다 D12의 이벤트와 D13의 감사(`.failed`·`.cancelled`)를 같은 tx에서 낸다. 멈춘 즉시 앱 안에서 보이려면 이벤트가 필요하다(「owner 결정」 ⑥의 조건).
- **워크스페이스는 소프트 삭제라 FK 연쇄가 없다.** 삭제된 워크스페이스의 행은 틱이 `cancelled`로 마감한다(D7).
- **가시성**: 보내기 전 **본문**은 작성자만 읽는다. 워크스페이스 owner·admin도 못 읽는다(소유자 범위 RLS, 감사 행은 id만). 검색·팀 기억(ADR-0196)은 message 행에서 읽으므로 보내기 전 본문에 닿지 않는다. **첨부 파일은 다르다**: 업로드 때부터 채널 멤버가 내용 경로로 읽을 수 있고(「지금 있는 것」) id·이름은 감사 detail에 있다. 이것은 초안 첨부와 같은 기존 노출이고, 예약은 그 기간을 마감 시각까지(최대 120일) 늘린다. 후속(보안): 내용 경로를 「메시지에 묶인 첨부 또는 업로더 본인」으로 좁힌다(남는 위험 8, 보안 후속 #4233).
- 취소한 글은 DB에서 지운다. PITR 백업은 자기 보존 기간 동안 갖는다. 클라이언트의 오프라인 목록 캐시는 로그아웃 때 지운다.

### D15. 운영
- 선택 환경 변수(모두 기본값이 있고 필수 변수는 없다. compose·Railway 카탈로그의 이름 대조에 영향이 없다): `MOMO_SCHEDULER_ENABLED`(기본 1), `MOMO_SCHEDULER_TICK_MS`(5000), `MOMO_SCHEDULER_BATCH`(100, 1..=200), `MOMO_SCHEDULER_GRACE_SECONDS`(3600, 300..=86400). 운영 문서(SELF_HOST)에 한 표로 적는다.
- **`MOMO_SCHEDULER_ENABLED=0`이면 틱이 돌지 않고 생성·수정·지금 보내기가 503 `scheduler_disabled`다**(목록·삭제는 된다). 조용히 쌓이는 예약이 없도록 꺼짐이 곧 거절이다(드라이브·GitHub 표면의 「설정 없으면 503」 선례).
- **doctor 점검 `stack.scheduler`**: 삭제되지 않은 워크스페이스에서 마감이 5분 넘게 지난 `pending`이 있으면 major, 최근 24시간 `failed` + `missed`·`send_error`가 있으면 info. 소유자 연결로 교차 테넌트 개수만 센다(`stack.outbox`와 같은 방식, `oort_doctor.sh:942`). **이 연결이 RLS를 건너뛴다는 전제**가 있다: `stack.outbox`도 FORCE RLS 표를 읽고(`001_init.sql:554-559`) 그래서 슈퍼유저 URL(`MIGRATE_DATABASE_URL`)을 요구한다(`oort_doctor.sh:1252`). 이 점검도 같은 연결을 쓰므로 전제가 이미 성립하지만, 연결 역할이 슈퍼유저도 BYPASSRLS도 아니면 개수가 조용히 0으로 나온다. 그래서 점검은 먼저 `rolsuper OR rolbypassrls`를 확인하고 아니면 「알 수 없음」으로 보고한다. 보고는 둘로 나눈다: 마감이 5분 넘게 지난 `pending`(정상 백오프 중인 행도 걸린다)과 **유예를 넘긴 `pending`**(틱이 닫지 못하는 행이다. 판정 tx가 계속 실패하는 행의 신호다).
- 로그는 개수·id뿐이다(본문 불포함). 틱 지연(마감 대비 실제 전송까지)은 로그에 분포로 남긴다.

### D16. 클라이언트 계약 (요약, 상세는 부록 B)
- 공유 코드는 `packages/momo-core/src/features/scheduled/`(타입, API 클라이언트, 프리셋, 이벤트 해석과 `rev` 병합, **문구 표**)가 한 벌 갖는다. 문장·토큰·코어 로직만 공유하고 뷰는 각자 구현한다(디자인 시스템 README §1).
- **예약은 보내기와 같은 보내기 전 판정을 거친다.** 웹의 `canSend`와 `submit` 앞 가드(`Composer.tsx:757` 첨부 올리는 중·`:850` 비밀 키 검사·`:656` 개인 에이전트 호출 계획 등), 스레드와 폰의 같은 가드를 **같은 함수로** 부르고 사유를 비활성 표(UI 명세 0.4)에 더한다. 예약 경로가 그 가드를 건너뛰면 안 된다. 폰의 개인 에이전트 판정은 `tryCall`(`usePersonalAgentCall.ts:127`)이 판정하면서 바로 보내 버리므로 판정만 하는 순수 함수를 코어에 따로 뽑는다.
- **서버가 201을 준 뒤에만** 비운다. 글과 초안은 제출 시점의 스냅샷과 같을 때만 비우고(요청 중에 고친 글은 남긴다), **스냅샷에 든 첨부는 항상 트레이에서 뺀다**(예약이 점유하므로 남겨 두고 그대로 보내면 `attachment_unavailable`이 된다). 요청 중에는 예약 단추와 Enter 전송을 잠가 두 번째 예약이 생기지 않게 한다. 실패하면 글·첨부가 그대로 남는다(낙관적 비움 없음). 프리셋이 실패하면 고른 시각이 채워진 직접 고르기에서 오류를 말한다(UI 명세 0.5).
- **`clientRequestId`는 요청 내용이 같을 때만 다시 쓴다.** 본문·시각·첨부·`rootId` 중 하나라도 바뀌면 새 id를 쓴다(서버는 같은 id에 옛 행을 돌려준다, D9). 확인 줄은 요청에 쓴 시각이 아니라 **응답의 `sendAtMs`**로 그린다.
- 이벤트(D12)와 `GET`으로 목록·배너를 만든다. 오프라인이면 목록은 캐시를 보이고 변경은 막으며 이유를 말한다. 연결이 끊긴 도중의 제출은 결과를 모르므로 「예약하지 못했어요」라고 단정하지 않는다(UI 명세 3.3).

## 이슈 본문과 다른 곳
| 이슈 본문 | 이 ADR | 근거 |
|---|---|---|
| 스케줄러 위치 미정(api vs agent-worker vs relay) | api 프로세스 틱 | `route_agent_mentions_in_tx`가 `pub(crate)`이고 notifier는 self-host 기본 스택에 없다 (D5) |
| 「만기 읽기 수단: 함수 또는 역할」 | 최소 권한 소유자의 SECURITY DEFINER 함수 둘(돌려주는 것은 id 세 개뿐) | `momo_join_private`·`mem_definer` 선례, 작성자 id가 필요한 이유 (D6) |
| 상태 5종(`sending` 포함) | 4종 | 한 tx면 `sending`이 커밋되지 않는다 (D7) |
| `canceled` | `cancelled` | 레포 관례 (D3) |
| `sendAt` | `sendAtMs` | `openapi.yaml:35` |
| 422 범위 밖 시간 | 400 + `error.code` | 리마인더가 400이다, `ErrorResponse.code` 메커니즘 |
| `scheduled.updated` | `scheduled_message.updated` | `inbox_item.*` 규약 (D12) |
| 취소·지금 보내기·편집 모두 마감 30초 전까지 | 편집만. 취소·지금 보내기는 보내기 전까지 | 행 잠금이 경쟁을 닫는다 (D9) |
| 푸시 「예약 메시지를 보내지 못했어요」 | v1은 앱 안, 푸시는 후속 | 닫힌 푸시 어휘와 `message_id` 필수 키 (D8) |
| 실패 사유 「채널 보관」 | 사유 아님 | 정본 경로가 막지 않는다 (D8) |
| 「늦게 보냈어요」 표시 여부 | 두지 않음, 유예 60분 넘으면 `missed`(시도했다면 `send_error`) | D7 |
| (없음) 정지·세션 종료 때의 예약 | 대기 예약과 실패 행을 `failed` + `sessions_ended`로 멈춤, 추방·탈퇴는 취소 | `session_end.rs`의 「세션에 매달린 것」 규칙 (D14) |
| 「예약됨」 목록은 사이드바 또는 인박스 탭 | 웹: 사이드바 줄(있을 때만). 폰: 프로필 시트 줄 | 인박스는 받는 쪽 투영이다. 초안 줄 선례 (부록 B) |

## 기각한 대안
| 대안 | 기각 사유 |
|---|---|
| 클라이언트 폴링·로컬 예약(리마인더 방식) | 보내는 사람의 기기가 꺼져 있으면 안 나간다. 이 기능의 존재 이유가 서버 정시 전송이다 |
| 예약 행을 `message` 행으로 미리 넣고 `state`로 숨기기 | seq가 예약 시점에 배정돼 시간순이 어긋나고, 알림·인박스·검색·기억 트리거가 숨긴 행에도 걸린다. 정본 INSERT 시점이 곧 전송 시점이어야 한다 |
| outbox 지연 행(`available_at`)으로 예약 | outbox 소비자는 BYPASSRLS 프로세스이고 전송은 작성자 범위 RLS 안의 tx여야 한다. 멘션 호출 판정도 못 부른다 |
| notifier·agent-worker에서 전송 | D5 표 |
| 수신자에게 「예약됨」 표식 | 작성자의 예약 사용을 팀에 공개한다 (D4) |
| 실패하면 말없이 재시도를 계속 | 몇 시간 뒤의 「9시 알림」은 사실과 어긋난다. 유예 뒤에는 사람이 정한다 (D7) |

## 결과

- (+) 보내는 사람의 기기가 꺼져 있어도 정시에 나가고, 받는 쪽은 일반 메시지와 같은 알림·멘션·에이전트 호출을 보낸 시각에 받는다. 정본 send를 한 함수로 합쳐 두 경로가 갈라지지 않는다.
- (+) 새 자격 증명·새 서비스·새 BYPASSRLS 쓰기가 없다. 새 노출은 「기한 된 (워크스페이스, 멤버, 예약) id」를 돌려주는 함수 둘이고 위에 적었다(D6).
- (+) 로그인이 사라지면 그 로그인이 건 예약은 나가지 않는다(D14). 구현 이슈 셋이 같은 계약(openapi 초안·UI 명세·이 ADR)에서 병렬로 출발한다.
- (−) api 바이너리에 첫 상주 작업이 생긴다. 틱이 멈추는 경우를 doctor가 잡아야 한다.
- (−) REST send의 조합을 함수로 뽑는 리팩터가 선행한다. 회귀는 기존 PG 적합성 시험이 지킨다.
- (−) 푸시가 없는 동안 실패는 앱을 열어야 보인다. 폰에는 개인 채널 구독이 없어 폰의 목록은 이벤트가 아니라 재조회로 갱신된다.
- 운영: 마이그레이션 1개(표 2개 + 역할 1개 + 함수 2개 + 인덱스), 부트스트랩 SQL 두 파일의 재부여·봉인 블록, 선택 환경 변수 4개, doctor 점검 1개, 이벤트 type 1개, 세션 종료·추방·탈퇴 경로의 연동 4곳(`end_member_sessions_in_tx`·`end_session_lineage_in_tx`·추방 호출부·탈퇴 호출부).

## 설계 실측 (격리 PG 18.6, 2026-10-22)
설계가 기대는 DB 동작을 구현 전에 확인하려고 저장소 밖에서 같은 모양의 SQL(표 2개·정책·함수·역할 권한)을 격리 컨테이너(전용 포트, 끝나고 삭제)에서 돌렸다. 처음은 슈퍼유저 소유 함수, 두 번째는 이 ADR의 최소 권한 소유자였고, 두 실행은 매번 새 연결을 썼다. 세 번째는 독립 검수의 지적을 받아 **테넌트 tx를 한 번 돌린 같은 연결**과 워크스페이스 공정 선택을 확인했다(「풀 연결의 빈 GUC」「워크스페이스 공정성」 행). 네 번째는 공정 선택 쿼리의 계획과 비용을 쟀다(「공정 선택의 비용」 행. 이 행은 RLS와 정의자 역할이 없는 단순 표에서 잰 값이다). 스크립트는 저장소에 넣지 않았다(구현 이슈의 PG 적합성 시험이 정본이다). 실제 코드·실제 마이그레이션이 아니므로 이 절은 「동작 모양」의 실측이다.

| 확인한 것 | 결과 |
|---|---|
| 소유자 범위 FORCE RLS(082 모양) | `momo_app`이 GUC 없이 직접 SELECT하면 0행. `app.workspace_id`+`app.member_id`를 묶으면 자기 행만, 다른 멤버·다른 워크스페이스 GUC는 0행 |
| 함수 소유자(D6) | 함수 둘의 소유자는 `NOLOGIN NOSUPERUSER NOBYPASSRLS`인 전용 역할이다. `momo_app`이 호출하면 기한 된 pending 3행(두 워크스페이스에 걸친)과 정리 대상 2행의 id 세 개만 받는다 |
| 소유자의 시야 | 그 역할로 `body`·`channel_id`를 읽으면 `permission denied`(열 권한). 보이는 행은 5개(기한 된 pending + 정리 대상)뿐이고, 아직 기한이 안 된 예약과 최근 `failed` 행은 정책에서 보이지 않는다 |
| 백오프 | `next_attempt_at`이 미래인 행은 due 목록에서 빠진다 |
| 권한 | relay(BYPASSRLS 역할)는 함수를 부를 수도, 표를 직접 읽을 수도 없다(`permission denied`: 표 권한은 RLS보다 먼저 판정되므로 BYPASSRLS여도 REVOKE된 표는 못 읽는다). `PUBLIC`의 EXECUTE는 0, `momo_app`만 1 |
| 인덱스 | 부분 인덱스 `(send_at, id) WHERE status = 'pending'`를 플래너가 쓴다 |
| 두 스케줄러(D7) | 한쪽이 `FOR UPDATE SKIP LOCKED`로 잡은 동안 다른 쪽의 같은 조회는 0행이다 |
| 편집과 잠금(D9) | 잡혀 있는 행의 편집은 `lock_timeout`에 걸려 55P03(= `scheduled_busy`) |
| 취소와 전송의 경쟁(D9) | 전송이 먼저 잡으면 취소는 전송이 커밋될 때까지 기다렸다가(1.4초) **0행**을 갱신한다(= `scheduled_already_sent`). 취소가 먼저 커밋되면 스케줄러의 재확인이 0행이고, 이미 보낸 행의 취소도 0행이다 |
| 점유(D11) | `attachment_id` UNIQUE가 두 번째 점유를 막고, 복합 FK가 다른 멤버를 소유자로 적은 자식 행을 거절한다 |
| 풀 연결의 빈 GUC(D3) | **첫 두 실행은 새 연결이라 이 결함을 못 잡았다.** 테넌트 tx를 한 번 돌린 같은 연결에서 정의자 함수 둘이 `invalid input syntax for type uuid: ""`(22P02)로 실패했다(082 모양 정책의 워크스페이스 항에 `NULLIF`가 없어서). 워크스페이스 항에 `NULLIF`를 걸면 같은 연결에서 함수가 3행·2행을 돌려주고, GUC 없는 직접 SELECT는 오류 없이 0행이다. 다른 멤버는 0행, 자기 행은 보인다 |
| 공정 선택의 비용(D6) | 50만 행(10만 행이 기한 지남, 200 워크스페이스, 나머지 40만은 먼 미래)에서 함수의 쿼리는 31 ms(`(send_at, id)` 부분 인덱스의 비트맵 스캔으로 기한 지난 행만 읽고 정렬). 기한 지난 행 수에 비례하는 비용이고 미래 행에는 닿지 않는다 |
| 워크스페이스 공정성(D6) | 전역 `ORDER BY send_at, id LIMIT 10`은 한 워크스페이스의 40행 백로그가 10건을 다 채웠다. `row_number()` 워크스페이스 분할 + `ORDER BY rn`은 같은 한도에서 세 워크스페이스가 모두 나왔고(8·1·1), 한도 200에서도 한 워크스페이스는 25건에서 잘렸다(최소 권한 소유자 역할로 실행) |

실측하지 않은 것: SAVEPOINT 마감(D7), 백오프와 `attempts` 회계 순서, 세션 종료 연동(D14), 봉인 블록의 부트스트랩 순서는 구현 이슈의 시험이 닫는다.

## 구현 순서와 수용 기준

선행 순서: #4214(엔진) → 같은 때 #4215(웹·데스크탑, **코어 모듈 `features/scheduled/`를 첫 PR로 먼저 랜딩**) → #4216(폰, 코어를 소비). UI는 서버 PR 전에 계약대로 mock으로 진행한다. ADR이 Accepted이므로 구현 이슈가 열릴 수 있다(ADR-0100).

### #4214 엔진 서버
1. **선행 커밋(동작 보존 리팩터)**: D4의 공유 함수와 타입 있는 거절 추출. 기존 `messages`·`agent_mentions` PG 적합성 시험이 무수정으로 통과.
2. 마이그레이션(표 2·RLS FORCE·정책·인덱스·함수 둘·`momo_sched_definer`와 그 열 권한·정책·권한 부여). 번호는 착수 시점의 다음 번호다.
3. 두 부트스트랩 파일: 함수 EXECUTE·스키마 USAGE 재부여와 자기 점검, `scheduled-message-lockdown`(마이그레이션에도 같은 REVOKE). `prod_role_conformance_pg.rs`의 제외 목록·드리프트 스캔 갱신.
4. 라우트 5개(부록 A), 스케줄러 틱(공정 처리·SAVEPOINT·백오프·시도 전 커밋), 이벤트, 감사, 자격 회수 연동(`end_member_sessions_in_tx`·`end_session_lineage_in_tx`·추방·탈퇴), 틱의 정리, `MOMO_SCHEDULER_*`, doctor 점검, SELF_HOST 운영 표, `ErrorResponse.code`의 현재 코드 목록 갱신.
5. 계약 마무리: `openapi.yaml`의 「계약 초안」 문구를 걷고, 새 연산 5개를 샘플과 함께 `scripts/openapi_sampled_on_rust.txt`에 올린다(「새 연산은 샘플과 함께 랜딩」, `openapi_known_unsampled.txt` 머리).
6. PG 적합성 시험(격리 PG, 전용 포트)과 사보타주. 되돌리면 이름 있는 시험이 실패해야 한다:

| 시험(이름 안) | 지키는 것 | 되돌리는 방법 |
|---|---|---|
| `a_due_message_is_sent_once_under_two_schedulers_and_send_now` | 중복 전송 0 | `FOR UPDATE SKIP LOCKED` 또는 `client_msg_id = 예약 id` 제거 |
| `a_rejection_never_overwrites_a_sent_or_cancelled_row` | 거절 마감이 같은 tx·잠금 아래 | SAVEPOINT를 별도 tx와 조건 없는 UPDATE로 바꿈 |
| `scheduled_rows_are_visible_only_to_their_author` | 타 멤버·타 워크스페이스 접근 0 | 정책에서 `author_member_id` 술어 제거 |
| `the_scheduler_write_runs_as_a_role_that_does_not_bypass_rls` | BYPASSRLS 쓰기 0 | 쓰기 풀을 relay 역할로 연결(`ensure_write_pool_rls_bound` 선례) |
| `the_due_functions_owner_cannot_read_bodies_and_sees_only_due_or_expired_rows` | 노출면(D6) | 소유자를 슈퍼유저로 바꿈·열 권한에 `body` 추가·정책을 `true`로 |
| `only_momo_app_may_call_the_due_functions` | 호출 권한과 부트스트랩 재부여 | `PUBLIC` 부여·부트스트랩 점검 제거 |
| `bodies_are_unreachable_for_the_bypassrls_roles_and_momo_app_keeps_all_four_privileges` | 봉인(세 파일 일치 포함) | 봉인 블록 제거·`momo_app`의 DELETE 회수 |
| `a_scheduled_mention_starts_the_same_agent_run_as_a_rest_send` | 정본 경로 동일 | 스케줄러에서 멘션 호출 단계 생략 |
| `each_failure_reason_is_named_and_the_grace_boundary_holds` | 사유 8종, 유예 경계 ±1초, 백오프, `attempts` 회계(`attempts = 0`이면 `missed`, 1 이상이면 `send_error`) | 판정 순서·백오프·`attempts` 증가 위치 바꾸기 |
| `a_poison_row_does_not_stop_the_tick` | 틱 보호(패닉 행, 판정 tx가 계속 실패하는 행의 5분 건너뛰기) | 판정 tx의 `attempts` 선커밋·패닉 격리·건너뛰기 제거 |
| `a_large_backlog_in_one_workspace_does_not_starve_the_others` | 공정성(배치보다 큰 백로그) | 함수의 `row_number()` 분할을 전역 정렬로 되돌림 |
| `the_due_functions_work_on_a_connection_that_already_ran_a_tenant_tx` | 빈 GUC에서 22P02가 나지 않음 | 정책 워크스페이스 항의 `NULLIF` 제거 |
| `post_answers_a_known_client_request_id_before_any_validation` / `the_cap_holds_under_concurrency` | 멱등 순서·상한 | 조회 순서 바꾸기·UNIQUE 또는 advisory lock 제거 |
| `an_edit_in_the_last_30_seconds_is_refused_but_a_cancel_races_safely` | D9 | 30초 판정·행 잠금 제거 |
| `a_member_wide_session_end_holds_pending_and_failed_schedules_and_logout_does_not` | D14 자격 회수(대기와 실패 행 모두, 멈춘 행의 이벤트까지) | 연동 제거·실패 행 제외·로그아웃에도 연동·이벤트 생략 |
| `a_device_unlink_or_refresh_reuse_holds_only_that_lineages_schedules` | 계열별 보류(본문을 고친 세션이 바뀌면 보류 대상도 바뀌는 것, 시각만 바꾸면 안 바뀌는 것, 로그아웃으로 토큰이 이미 취소된 연결의 해제까지, 계열 종료 tx가 대상의 `app.member_id`를 묶는 것까지) | `armed_session_id` 조건 제거·본문 변경 때 갱신 제거·해제 라우트의 `Revoked` 조건 복원·GUC 바인딩 제거 |
| `removal_and_leave_cancel_schedules_and_a_foreign_member_guc_is_bound_only_in_the_three_named_functions` | 추방·탈퇴 정리와 남의 `app.member_id` 바인딩 예외 | 연동 제거·함수 밖에서 남의 id 바인딩 |
| `the_tick_purges_expired_rows_without_the_author_writing` / `a_deleted_workspace_row_is_cancelled_not_retried` | 보존·소프트 삭제 | 정리·삭제 판정 제거 |
| `the_event_rides_the_personal_channel_with_ids_only` | 본문 비유출 | 이벤트에 `body` 추가 |

### #4215 웹·데스크탑 UI, #4216 폰 UI
- **`sessions_ended`로 멈춘 예약이 앱 안에서 멈춘 즉시 보이는 것**(D8의 앱 안 알림: 목록의 「보내지 못함」 구역·채널 배너·사이드바 알약·프로필 줄. 웹은 이벤트 도착 즉시, 폰은 화면 복귀·당겨서 새로 고침·재조회 때)을 수용 기준으로 지킨다(「owner 결정」 ⑥의 조건).
- 부록 B의 상태 8개(기본·메뉴 열림·직접 고르기·예약 직후·배너·목록·실패·오프라인)를 모두 구현하고 문구표의 문장 그대로 쓴다. 웹은 1440 라이트·다크, 폰은 시뮬레이터 라이트·다크 캡처. design-review Blocker 0·High 0, 웹은 `scripts/design_preflight_web.sh`.
- 시험: 프리셋 계산(경계: 일요일·자정·월말·DST), 201 뒤 글은 스냅샷이 같을 때만 비우고 스냅샷의 첨부는 항상 뺌, 요청 중 잠금(Enter 포함), 실패 시 보존, 프리셋 실패 시 직접 고르기에서 오류 말하기, 내용이 바뀌면 새 `clientRequestId`, 글만 고칠 때 `sendAtMs`를 싣지 않음, 이벤트·재조회로 목록 갱신, 비활성 사유(오프라인·인용·명령·개인 에이전트 호출·빈 입력·비밀 키·첨부 올리는 중·한도), `sessions_ended` 행은 본문 전체를 보인 뒤에만 지금 보내기·다시 예약, 첫 목록 요청 404이면 입구를 세우지 않음, 접근성(낭독 이름·초점 복귀·동작 줄이기·한도 항목이 키보드로 닿음). 폰은 보내기 원의 `disabled`를 풀고도 탭 동작이 그대로임을 시험한다. 사보타주를 PR 본문에 적는다.

## 보안 · 경계 요약
- 새 자격 증명 없음. 새 공개 API는 연산 5개이고 사람 bearer 전용이다(에이전트 403).
- 새 테넌트 표 2개는 RLS FORCE + 작성자 범위다. **쓰기 경로의 BYPASSRLS는 0이다**: 스케줄러의 모든 쓰기는 `momo_app` tx다. 교차 테넌트 읽기는 id 세 개를 돌려주는 함수 둘뿐이고(소유자는 최소 권한 역할) EXECUTE는 `momo_app`만 갖는다.
- relay·worker·notifier·platform_admin은 두 표에 권한이 없다(마이그레이션과 부트스트랩 둘).
- **권한은 보내는 시각에 다시 판정된다.** 예약이 권한을 고정하지 않는다: 그사이 채널을 나갔거나 정지됐으면 못 보낸다. 로그인이 모두 끝나거나(비밀번호 변경·재설정·정지·추방·탈퇴), 기기가 해제되거나 refresh 재사용이 잡히면 그 로그인이 쓴 대기 예약과 실패 행은 멈춘다(D14). 에이전트 호출 권한도 정본 게이트가 보낸 시각의 상태로 판정한다.
- 보내기 전 **본문**은 작성자 외 누구도 못 본다(워크스페이스 owner 포함). **첨부 파일은 업로드 때부터 채널 멤버가 읽을 수 있다**(기존 노출, 남는 위험 8, 보안 후속 #4233). 감사·이벤트·로그에 본문이 없다.
- 남용: 50개·최소 1분·최대 120일, 본문은 일반 전송과 같은 상한뿐이다. 받는 쪽에서는 일반 메시지와 같은 음소거·방해 금지가 그대로 적용된다. 쓰기 표면(보내기·예약·업로드)의 per-member 속도 제한은 증보 1(#4234)이 정한다.

## 남는 위험과 후속
1. 정시는 목표이고 보장이 아니다: 장애가 유예(60분)를 넘으면 `missed`로 마감되고 사람이 정한다. 한 테넌트의 몰림은 공정 처리와 틱 예산으로 줄였을 뿐이고 규모가 커지면 틱을 나눠야 한다. 채널당 상한은 없다: 한 채널에 멤버 × 50개가 몰려도 워크스페이스당 틱 25건이 속도를 제한한다. 장애 뒤에는 유예가 지난 행(닫기만 하면 된다)도 같은 25건 몫을 차지해 유예 안의 행이 뒤로 밀릴 수 있다. 후속: 지난 행을 별도 몫으로 일괄 마감한다.
2. 푸시가 없는 동안 실패는 앱을 열어야 보인다. 후속: ADR-0206(#4223)이 새 reason과 D8의 다섯 비용을 함께 정한다.
3. **id 열거 노출(D6)은 planner가 수용했다**(2026-10-22, 「owner 결정」 ⑤). 기한이 된 (워크스페이스, 멤버) 쌍은 GUC 신뢰 모델에서 그 테넌트·멤버의 소유자 범위 표를 여는 열쇠이고, `momo_app` 자격이 SQL 수준으로 새면 비밀 없이 드러난다. 소유자를 최소 권한 역할로 하고 한 번에 200행·기한 된 것만 돌려주는 것으로 줄였다.
4. 정본 send가 바뀌면 예약에도 같은 변경이 즉시 적용된다(공유 함수의 값이자 위험). 이를 위해 적합성 시험이 REST와 스케줄러를 한 표로 덮는다.
5. 완료·미묶임 첨부의 청소기는 없다(취소된 예약의 파일이 남는다). 후속 후보. → [ADR-0151 증보 2](0151-attachments-v0-drive-contract-port.md#증보-2-2026-10-25-4443-첨부의-수명)(#4443)가 거둔다(기본 꺼짐).
6. 받는 사람 현지 시각, 인용 답장 예약, 모델 지정 예약, 팔레트 명령 「예약해서 보내기」는 v1 밖이다.
7. 기본 self-host 스택에 notifier가 없으므로 승인 만료 정리 같은 notifier 상주 작업도 그 스택에서는 돌지 않는다. 이 ADR의 범위 밖 관찰이라 별도 이슈 #4235에서 다룬다.
8. **예약한 첨부는 마감 시각까지 채널 멤버에게 열려 있다.** 완료된 첨부는 업로더가 아니어도 채널 활성 멤버가 읽고(`attachments.rs:332-360`), id·이름은 `attachment.upload_started` 감사 detail에 있다(`attachment.rs:251-266`). → 이름은 [ADR-0151 증보 2](0151-attachments-v0-drive-contract-port.md#증보-2-2026-10-25-4443-첨부의-수명)(#4443)부터 싣지 않고, 이미 쓰인 행의 이름은 마이그레이션 151이 지운다. 이것은 초안 첨부와 같은 기존 노출이고 예약이 그 기간을 최대 120일로 늘린다. 후속(보안, #4233): 내용 경로를 「메시지에 묶인 첨부 또는 업로더 본인」으로 좁힌다(초안 첨부도 닫힌다).
9. 서버가 보낸 예약은 작성자의 읽음 커서를 올리지 않아(`read_state.rs:259-262`) 작성자에게는 안 읽음 1로 센다(채널을 열면 정리된다). 서버가 작성자 커서를 올릴지는 후속 판단이다.
10. 멤버 한 명이 쥘 수 있는 대기 본문은 최대 50 × 요청 본문 상한(2 MiB)이다. 본문 글자 상한은 정본 send에도 없어서 이 ADR이 따로 두지 않는다(공통 상한은 별도 결정).
11. 계열 하나의 종료 중 로그아웃은 예약을 건드리지 않는다(부재 중에 나가게 하려는 쓰임). 로그아웃한 세션이 심은 예약은 그 계정의 다음 보안 사건(비밀번호 변경·기기 해제·재사용 탐지)에서야 멈춘다.
12. `sessions_ended` 행의 확인은 클라이언트가 한다. 서버가 막을 필요는 없다(보류된 뒤에는 공격자에게 그 계열의 자격이 없고, 다른 계열이 살아 있다면 어차피 직접 보낼 수 있다). 후속: 지금 보내기와 다시 걸기에 화면에 보인 `rev`를 요구하면 확인한 내용과 실제로 나간 내용을 서버가 묶을 수 있다.

## owner 결정 (인용)
- 2026-10-22 성재: 「예약 메세지 기능을 추가하면 좋을 거 같은데 UI및 실제 설계 작업도 추가로 작업해줘.」
- 2026-10-19 성재(planner 상시 위임의 원문): 「확인이 필요한건 다 승인하고, 기다리는것은 너가 권장 순서로 진행해봐.」
- 2026-10-22 성재: 「결정 부탁드릴 것은 너가 권장으로 진행해봐.」
- planner 확인 완료(2026-10-22): 위 두 위임 범위에서 아래 ①~⑦을 모두 수용했다. 이 ADR은 새 자격 증명이 없고, 새 BYPASSRLS 쓰기가 없으며, 푸시 와이어를 바꾸지 않는다.

| # | 확인한 결정 | 판정 | 근거 |
|---|---|---|---|
| ① | 실패 푸시를 v1에서 뺀 것(D8) | 수용 | 새 reason과 D8의 다섯 비용은 ADR-0206(#4223)에서 함께 정한다(남는 위험 2) |
| ② | 취소·지금 보내기에 30초 잠금을 두지 않은 것(D9) | 수용 | 행 잠금이 경쟁을 닫고, 마지막 순간까지 취소할 수 있는 편이 사용자에게 낫다 |
| ③ | 스케줄러를 api 프로세스에 둔 것(D5) | 수용 | 정본 send 함수와 `momo_app`(NOBYPASSRLS) 자격을 그대로 쓴다. 다중 레플리카는 `SKIP LOCKED`로 안전하다 |
| ④ | 유예 60분(D7) | 수용 | 롤링 배포·재시작·짧은 장애는 흡수하고 그 너머는 사람이 정한다. 반나절 늦게 조용히 나가는 것도 말없이 버리는 것도 나쁘다(D7) |
| ⑤ | D6의 열쇠 노출: `momo_app` 자격이 새면 예약을 쓰는 테넌트의 (워크스페이스, 멤버) 쌍이 비밀 없이 드러나는 것 | 수용 | `momo_app` 자격이 SQL 수준으로 새는 것은 이미 GUC 신뢰 모델 전체가 무너지는 사고다. 함수는 기한 된 행만, 최소 권한 소유자로, 200행까지만 돌려줘 증분을 줄였다 |
| ⑥ | D14의 자격 회수 의미: 세션 종료 때 대기 예약과 실패 행을 취소가 아니라 `sessions_ended`로 멈추고, 로그아웃은 건드리지 않고, 추방·탈퇴는 취소하는 것 | 수용 | 탈취 뒤 회복 시나리오에서 말없이 나가지 않는 것이 우선이고, 일상적인 비밀번호 변경의 재확인 비용은 감수한다. 멈춘 즉시 앱 안에서 보이게 하는 것(D8 앱 안 알림)을 #4215·#4216 수용 기준으로 지킨다 |
| ⑦ | 첨부 내용 경로 축소를 보안 후속으로 여는 것(남는 위험 8) | 수용 | 보안 후속 #4233으로 열었다 |

## 부록 A. API 계약 요약
`docs/api/openapi.yaml`에 「계약 초안」으로 들어갔다(서버 구현 #4214 전까지 이 경로는 404). 엔진이 enum 값을 소유한다(TRACKS §1).

| 연산 | 경로 | 요청 | 성공 |
|---|---|---|---|
| `createScheduledMessage` | `POST /v1/workspaces/{ws}/channels/{ch}/scheduled-messages` | `{body?, sendAtMs, rootId?, attachmentIds?, clientRequestId}` | 201 `{scheduledMessage}` (재시도도 201, 같은 행) |
| `listScheduledMessages` | `GET /v1/workspaces/{ws}/scheduled-messages?channelId=&status=open|pending|failed&cursor=&limit=` | | 200 `{scheduledMessages, nextCursor?}` (내 것만, `(send_at, id)` 키셋) |
| `updateScheduledMessage` | `PATCH /v1/workspaces/{ws}/scheduled-messages/{id}` | `{body?, sendAtMs?}` | 200 `{scheduledMessage}` |
| `sendScheduledMessageNow` | `POST …/{id}/send-now` | 없음 | 200 `{scheduledMessage}` (`sent`, `sentMessageId`) |
| `deleteScheduledMessage` | `DELETE …/{id}` | | 204 (`cancelled`는 멱등 204) |

오류 코드표(`ErrorResponse.error.code`):

| 상태 | 코드 | 뜻 |
|---|---|---|
| 400 | `send_at_too_soon` · `send_at_too_far` | 지금+60초 미만(과거 포함) · 120일 초과 |
| 400 | `empty_message` | 글도 첨부도 없다 |
| 400 / 404 | (코드 없음, REST send와 같은 문장) | 루트·첨부 거절: 중복·초과 400, 없음 404 |
| 403 | | 에이전트 bearer · 비활성 멤버 · 채널 멤버가 아니거나 없는 채널(`sendMessage`와 같은 판정) · 다른 업로더·다른 채널 첨부 |
| 404 | | 스레드 루트·첨부를 못 찾음, 또는 예약을 못 찾음(남의 예약·취소된 예약 포함) |
| 400 | (코드 없음) | 경로 id 형식 오류(삭제·지금 보내기·수정) |
| 409 | `pending_limit_reached` | 대기 50개 |
| 409 | `attachment_reserved` | 다른 예약이 점유한 첨부 |
| 409 | `scheduled_too_late` | 편집은 마감 30초 전까지 |
| 409 | `scheduled_already_sent` | 이미 보냄 |
| 409 | `scheduled_busy` | 지금 보내는 중(잠금 대기 3초 초과) |
| 409 | 실패 사유 코드 | 지금 보내기가 거절됨(`not_member` 등) |
| 429 | | 멤버별 쓰기 예산(증보 1) 또는 기존 속도 제한. `Retry-After`(1 이상의 정수 초)를 싣는다 |
| 503 | `scheduler_disabled` | 운영자가 스케줄러를 껐다 |

## 부록 B. UI 명세
[`docs/design-system/scheduled-messages-ui.md`](../design-system/scheduled-messages-ui.md): 웹·데스크탑과 폰의 상태 8개 와이어프레임, 해요체 문구표, 접근성·동작 줄이기·오프라인. #4215·#4216의 정본이다.

## 증보 1 (2026-10-25, #4234) — D10 속도 제한: 멤버별 쓰기 예산

- Status: **Accepted (2026-10-25, planner 위임 결정 — owner 10-22 「결정 부탁드릴 것은 너가 권장으로 진행해봐」)** (기안: Sonnet 5.5 엔진 워커, #4234). 독립 보안 검수 r2 PASS(Blocker 0·High 0) 뒤에 올렸다. r1은 High 1건(D10-e의 감사 쓰기가 끊긴 요청과 함께 취소돼 행이 0개나 2개가 됨)으로 FAIL이었고 이 증보의 D10-e를 그에 맞게 고쳤다. 검수의 Medium 잔존은 compose env 통로(한계와 후속)뿐이고 planner 결정으로 범위 밖이다.
- 표기: [V] 이 세션에서 직접 확인 · [추정] 해석 · `runtime-unverified` 실행하지 않음.
- 바꾸는 곳: D10의 마지막 항목과 부록 A의 429 행. 대기 50개·첨부 20개·최소 1분 상한은 그대로다.

### 맥락 [V]
- **인증된 멤버의 쓰기를 세는 곳이 없었다.** 이 서버의 속도 제한은 공개 라우트의 per-IP(`/v1/join`·`/v1/claim`·기기 연결·GitHub 콜백·업로드 PUT)와 기능별 한도(비밀번호 변경, 휘발 신호, 웹훅 설치별, Agent Port 토큰·에이전트·IP)다(`SlidingWindowRateLimiter`를 쓰는 곳들: `rate_limit.rs`, `routes/password.rs`, 웹훅 수신, Agent Port). 옛 Swift 서버는 `RATE_LIMIT_PER_MEMBER`(기본 600, 인증된 모든 라우트)와 감사 행 `rate_limit.exceeded`를 가졌고 Rust 이식에서 빠졌다(`search.rs`의 「Measured deviation」, SEC-07 지도 G2, #4377). `infra/.env.example`에는 이 서버가 읽지 않는 `RATE_LIMIT_PER_MEMBER` 줄이 남아 있었다.
- **세 쓰기는 요청 한 줄에 비해 일이 크다.** 메시지 보내기는 channel_seq 증가 + message + outbox(+멘션 라우팅)의 한 tx다. 업로드 시작은 Google Drive API 호출 1회와 `pending` 행 1개이고 호출이 행보다 앞이다(`attachments.rs` `create_upload`). 예약 만들기·고치기는 세션 행·예약 행 잠금과 outbox 이벤트다(D12·D14). D10의 대기 50개는 만들고 취소하기의 반복과 고치기의 반복을 막지 못한다.
- **에이전트가 닿는 문은 허용목록이 정한다**(`required_agent_scope`): `POST …/messages`(보내기), `PATCH …/messages/{id}`(스트림 조각, ADR-0158 증보 1 D7), 읽기 둘, 게이트웨이 콜백. 업로드 시작과 예약은 허용목록 밖이고 예약은 `require_human`이다. 그래서 사람·에이전트 구분은 보내기에서만 뜻이 있다.
- **어댑터는 429를 일시 오류로 다루고 `Retry-After`를 읽지 않는다.** Prime은 3회·0.4초씩 늘려 재시도한다(`oort_client.py:193-232`). Hermes는 429를 재시도 가능으로 분류한다(`momo_adapter.py:1125`). 웹·폰은 보내기 실패를 「실패 + 다시 시도」로 두고 같은 `clientMsgId`로 재시도한다(`timeline/model.ts` `retryPending`). 웹·폰에서는 429가 메시지를 잃게 하지 않는다(보내기 실패로 남고 사람이 다시 누른다). Prime 어댑터는 재시도가 끝나면 `OortError`를 올리고 `pump()` 호출부에 그것을 받는 곳이 없어 그 실행이 끝난다(`prime_adapter.py`, `adapter.py` [V, 검수 r1 M-3]). 그래서 에이전트의 정상 범위는 429가 한 번도 나지 않는 쪽에 둔다.

### 결정
- **D10-a. 범위는 멤버 × 표면이다.** 키는 인증된 principal의 멤버 id와 표면 이름뿐이다(요청이 싣는 값은 쓰지 않는다). 호출자는 자기 예산만 쓰고 남의 것을 쓰지 못하며, 인증되지 않은 호출은 이 게이트에 닿지 않는다. 표면은 셋이다: **메시지 보내기**(`POST …/messages`와 예약의 `send-now`가 한 예산이다. 같은 정본 send라서 번갈아 불러 두 배로 만들 수 없다), **예약 만들기·고치기**, **업로드 시작**. **워크스페이스·인스턴스 합산 축은 두지 않는다**: ① 합산 상한은 한 멤버나 에이전트가 나머지를 굶기는 도구가 된다 ② 팀 인스턴스는 한 팀의 단일 테넌트라 이웃 간섭이 지금의 위험이 아니다 ③ 합산 숫자를 정할 실측이 없다.
- **D10-b. 사람과 에이전트는 보내기에서만 갈린다.** 에이전트·work host 자격은 에이전트 한도를 받는다. 다른 두 표면은 한도 하나이고, 에이전트가 닿는 날에도 예산 없이 열리지 않도록 같은 한도를 받는다.
- **D10-c. 숫자(창당, 기본 창 60초).** 한 창은 `RATE_LIMIT_WINDOW_SECONDS`를 다른 한도와 함께 쓴다. 0은 그 축을 끈다.

| 표면 | 대상 | 기본 | env | 근거 |
|---|---|---|---|---|
| 메시지 보내기 | 사람 | **120** | `RATE_LIMIT_MESSAGE_SEND_PER_MEMBER` | Slack `chat.postMessage`는 채널당 대략 초당 1건에 워크스페이스 전체 한도를 두고 짧은 폭주를 허용한다 [V 2026-10-25, docs.slack.dev/apis/web-api/rate-limits]. 120은 모든 채널을 합쳐 초당 2건이다. 재연결 뒤 밀린 100건이 통과한다(아래 측정). Mattermost는 한도가 기본 꺼짐이고 켜면 IP당 초당 10건·버스트 100이다 [V 2026-10-25, mattermost/mattermost `server/public/model/config.go`의 `RateLimitSettings.SetDefaults`: Enable false·PerSec 10·MaxBurst 100·VaryByRemoteAddr true] |
| 메시지 보내기 | 에이전트·work host | **600** | `RATE_LIMIT_MESSAGE_SEND_PER_AGENT` | Prime 어댑터는 도구 한 번에 `tool_call`과 `tool_result`를 한 건씩 보낸다(`prime_adapter.py:22-24`, `:316-349`). 한 실행의 단계 수는 `agent.max_run_steps`(스키마 기본 50)가, 에이전트의 동시 실행은 `agent.max_concurrent_runs`(기본 1)가 묶는다(`001_init.sql:84-85`). 단계 하나를 도구 한 번으로 읽으면 한 실행은 `tool_call`+`tool_result` 최대 100건이고 동시 실행을 4개로 올려도 400건이라 600에 여유가 있다 [추정: 단계 = 도구 실행이고 어댑터가 `max_steps`를 지킨다는 가정. 서버가 강제하는 부분이 아니다]. 600은 한 에이전트 정체성의 분당 도구 200회이고, Agent Port의 per-agent 480(`MOMO_AGENT_PORT_RATE_LIMIT_PER_AGENT`)보다 작지 않아 같은 일을 하는 REST 어댑터가 MCP 길보다 세게 막히지 않는다(시험이 못박는다). 옛 Swift의 멤버당 600(모든 라우트)은 알파 내내 에이전트에도 걸려 있었고, 저장소의 STATUS·JOURNAL 아카이브에서 그 429가 사람이나 에이전트를 막았다는 기록을 찾지 못했다 [V 2026-10-25, `git grep`; 기록이 없다는 것이지 없었다는 증명은 아니다] |
| 예약 만들기·고치기 | 멤버 | **60** | `RATE_LIMIT_SCHEDULED_WRITE_PER_MEMBER` | 대기 상한 50을 한 창에 다 채울 수 있다(상한보다 작으면 사용자는 상한을 보기 전에 속도에 걸린다. 시험이 못박는다). Slack `chat.scheduleMessage`는 Tier 3(분당 50+)이고 같은 채널에 5분 30건까지다 [V 2026-10-25, docs.slack.dev/reference/methods/chat.scheduleMessage] |
| 업로드 시작 | 멤버 | **60** | `RATE_LIMIT_UPLOAD_START_PER_MEMBER` | 메시지당 첨부 20개의 두 배에 여유 20. 시작 하나는 Drive API 호출 하나다. Slack `files.getUploadURLExternal`은 Tier 4(분당 100+)다 [V 2026-10-25, docs.slack.dev/reference/methods/files.getUploadURLExternal] |

- **D10-d. 거절의 모양.** 429 + `Retry-After`(올림한 정수 초, 1 이상) + 표준 오류 봉투(`rate limit exceeded`, 다른 한도와 같은 본문). 게이트는 `route_layer` 미들웨어라 핸들러의 extractor보다 앞서 거절한다: JSON 파싱·핸들러의 트랜잭션·outbox 행·Drive 호출이 모두 그 뒤이고, 거절된 요청은 아무것도 저장하지 않는다. **인증보다 앞은 아니다**: 게이트는 인증 계층(`require_principal`) 안쪽이라 거절된 요청도 인증이 하는 일은 한다. 사람 토큰은 `token_state` 읽기 한 번이고, 에이전트 베어러는 요청마다 `last_used_at` 갱신과 감사 행 `auth.agent_bearer.used`까지 쓴다(에이전트의 거절된 요청 30건이 그 행을 30개 늘렸다 [V, 검수 r1이 실행으로 확인]). 이 비용은 이 증보 이전부터 있었고 후속 ⑥이 다룬다. 같은 `clientMsgId`로 다시 보내도 안전하다(거절된 요청은 저장되지 않았고, 이미 저장된 요청의 재시도는 기존 메시지를 돌려주며 요청 한 건으로 센다). 한도가 0인 축은 시작 때 경고를 남긴다.
- **D10-e. 감사.** 거절에는 행 하나가 남는다: `audit_log.action = 'rate_limit.exceeded'`(Swift의 이름), `target_type = 'route'`, 행위자와 자격(`via_token_id`)은 요청한 멤버의 것, `detail`은 `{schema:"oort.rate_limit.exceeded.v1", scope:"member", surface, kind, limit, window_seconds}`뿐이다(경로·본문·요청의 id 없음). **멤버·표면당 창마다 최대 한 행**이다. 한계기의 「버스트 첫 거절」 표식이 병렬 거절을 한 쓰기로 줄이고, 한도 바로 위에 머무는 호출자가 창이 밀릴 때마다 새 버스트를 여는 것은 **감사 슬롯**(멤버·표면당 창마다 하나)이 막는다. 슬롯은 행을 쓰기 **전에** 예산과 같은 원자적 입장으로 잡는다. 커밋 뒤에 닫으면 DB가 느린 사이 버스트가 다시 열릴 때 둘째 행이 나가기 때문이다(단위 시험이 이 겹침을 못박는다). 행을 쓰지 못하면 응답은 그대로 429이고(감사 실패가 429를 500으로 바꾸지 않는다) 슬롯과 표식을 돌려줘 다음 거절이 다시 시도한다. **쓰기는 요청과 별개의 작업(task)에서 돈다.** 서버는 클라이언트가 끊은 요청의 future를 그 자리에서 버리고(검수 r1이 지연 프록시로 결정적으로 재현했다), 감사 쓰기가 그 안에 있으면 끊기는 시점에 따라 두 가지로 어긋난다: INSERT의 응답을 기다리는 중이면 행이 롤백돼 **0행**(매번 끊는 호출자는 감사되지 않는다), COMMIT의 응답을 기다리는 중이면 행은 커밋됐는데 가드가 「못 썼다」고 보고 슬롯을 열어 같은 창의 다음 거절이 **둘째 행**을 쓴다. 그래서 슬롯 선점·쓰기·커밋·가드가 모두 별도 작업 안에 있고 요청은 그 결과를 기다리기만 한다(`audit_denial_detached`): 429는 행 뒤에 나가고, 요청이 사라지면 결과를 볼 사람만 없다. 게이트에 닿기 전에 끊긴 요청은 셈에도 감사에도 들지 않는다. 경고 로그 줄(`rate limit exceeded (per-member write)`)은 버스트의 첫 거절마다 남는다. 표는 창마다 한 행, 로그는 버스트마다 한 줄이다. 남는 두 길은 클라이언트가 만들 수 없는 것이다: DB 연결이 COMMIT 응답 직전에 끊기면 행은 커밋됐는데 쓰기 실패로 세어 다음 거절이 한 번 더 쓰고, 쓰기가 한 창(60초)보다 오래 걸리면 슬롯이 먼저 만료된다 [검수 r2 N-3·N-4]. 감사 트랜잭션에는 `lock_timeout`/`statement_timeout`이 없어 DB가 정체하면 쓰기가 풀 연결을 붙잡는다(이 증보 전부터 같은 상태이고 풀을 비우려면 서로 다른 멤버 10명과 DB 정체가 함께 있어야 한다) [검수 r2 N-6].
- **D10-f. 세지 않는 것(명시).** 예약 취소(`DELETE`): 안전 동작(D9)이라 예산이 다 쓰인 멤버도 멈출 수 있어야 한다. `PATCH …/messages/{id}`: 스트림 조각의 길이고 막으면 에이전트 스트리밍이 429를 맞는다. 같은 문의 **일반 수정 팔**(스트림이 아닌 수정)도 같은 마운트라 예산 밖이고, 수정마다 감사 행 `message.edited`와 outbox 이벤트를 쓴다(사람·에이전트 각 200건이 1.1~1.6초에 전부 통과했다 [V, 검수 r1이 실행으로 확인]). 새 메시지를 만들지 않아 전송 폭주를 이 문으로 우회할 수는 없지만 쓰기 폭주의 문은 남는다(후속 ③). 읽기. 리액션·핀. 아바타 업로드: 멤버 아바타는 시간당 20개 DB 상한이 이미 있고 워크스페이스 아바타는 owner/admin 전용이다. **다른 문으로 들어오는 보내기**는 이 예산에 세지 않고 자기 한도를 가진다: Agent Port의 `oort_message_post`는 Agent Port 한도(토큰당 240·에이전트당 480, 분당, 모든 도구 호출의 합)가 입장 때 센다. 게이트웨이 `…/gateway/complete`는 `client_msg_id = run_id`라 실행 하나에 응답 한 건이다. 예약의 틱 전송은 D7의 공정 처리가 속도를 정한다. 이 목록은 닫힌 목록이 아니다: 같은 급의 쓰기가 더 있다(허들 시작, 리마인더, 작업 세션의 카드 메시지, 서명 지시 등). 대부분 다른 흐름의 부수 효과이거나 서명·세션이 필요해서 스팸 수단으로는 약하다 [코드 확인, 미실행, 검수 r1 L-8].

### 측정 [V, 격리 PG 18, 실서버 라우트, 기본값]
`member_write_rate_limit_pg.rs`의 `the_shipped_defaults_pass_ordinary_use_and_stop_at_the_documented_numbers`(수용 기준 2). 한 연결에서 순차로 보낸다. **사람 100건이 0.6~1.3초에 전부 201**(재연결 뒤 밀린 큐 비우기), **한 에이전트가 도구 150회 = `tool_call` + `tool_result` 300건을 1.7~7.2초에 전부 201**, 사람의 121번째와 에이전트의 601번째가 처음의 429다. 한 연결의 순차 전송은 이 환경(개발 머신, 부하가 다른 세 번을 재서 사람 76~169건/초·에이전트 42~181건/초)에서 초당 40~180건이라 **줄 속도 루프는 3~15초 만에 에이전트 예산에 닿는다**. 에이전트 한도 600은 한 실행의 상한(단계 50 × 2 = 100건)의 6배이고, 이 시험의 300건(실행 세 개 몫)을 막지 않는다. **실제 에이전트의 분당 전송 수를 잰 현장 기록은 없다**(운영 DB에는 접속하지 않았다). 그래서 숫자는 어댑터 구조와 스키마 상한에서 계산한 상한이고, 한도에 닿으면 경고 로그와 감사 행(`kind`·`surface`)이 남으므로 운영에서 그 기록을 보고 env로 올린다.

### 한계와 후속
- 프로세스 안의 상태다: 재시작에 초기화되고 복제본이 N개면 N배다(다른 한도와 같은 계약). 한 사람의 여러 기기는 한 예산을 나눠 쓴다.
- 숫자를 바꾸는 길은 env 네 개(`RATE_LIMIT_*`)다. self-host compose(`infra/rust/docker-compose.rust.yml`)의 `api` 서비스는 `RATE_LIMIT_*`를 컨테이너에 넘기지 않는다(기존 per-IP 노브도 같다). 그래서 compose 운영자는 기본값으로 쓰고, 바꾸려면 `api.environment`에 줄을 더해야 한다. compose 통로는 이 증보의 범위 밖이다(`infra/.env.example`에는 이름과 뜻만 적었다).
- 키에 자격 종류(`kind`)가 없다: 같은 멤버 id가 사람과 work host로 오면 한 버킷을 쓰되 한도만 다르게 적용된다. 이 다섯 문은 서명 호스트의 허용 경로에 없어 지금은 닿지 않는다(`work_host_auth::is_allowed_signed_path`) [검수 r1 L-6].
- 웹·폰은 429를 일반 전송 실패로 보인다. `Retry-After`를 쓰는 문구와 자동 재시도는 UXUI 후속이다.
- 후속: ① 워크스페이스·인스턴스 합산 축(다중 테넌트 호스팅 때) ② Swift의 전 라우트 per-member 축과 검색 30/60초의 이식(#4377 판단) ③ 스트림 `PATCH`의 조각 상한과 같은 문의 일반 수정 팔(본문을 파싱한 뒤에야 스트림 여부가 갈려서 `route_layer`로는 못 나눈다. 핸들러 안에서 `stream`이 없는 분기에만 같은 한계기를 거는 안) ④ `admit_password_change`와 멤버 아바타 429의 `Retry-After` ⑤ (이 PR이 했다) 이 통제의 공개 주장 `RATE-1`을 `docs/security/claims.yaml`에 올렸고 새 PG 시험 타깃 `member_write_rate_limit_pg`를 `infra/security-pack/selection.txt`(Security pack, 영역 auth)에 넣었다. `claims.yaml`은 정책 파일이라 PR 본문 첫머리에 알린다. ⑥ 인증 앞단의 값싼 사전 거절(서명 검증만으로 아는 `sub`로 이미 소진된 키를 인증 DB 일 전에 거절): 지금은 거절된 요청도 인증 계층의 DB 일을 한다(D10-d). ⑦ `scripts/local_gate.sh`의 노트 「per-member 429 + rate_limit.exceeded 감사는 Rust에 없음」은 이제 쓰기 다섯 곳에는 맞지 않는다(정책 파일이라 이 PR이 고치지 않았다).
