# ADR-0208: 예약 메시지 - 보내는 사람의 기기가 꺼져 있어도 서버가 정시에 보낸다

- Status: **Accepted** (2026-10-22. 근거는 「owner 결정」에 인용: 성재 원문 2026-10-22 + planner 상시 위임 2026-10-19)
- Date: 2026-10-22
- Deciders: 성재
- 기안: Sonnet 5.5 엔진 워커 (#4213). 이슈 본문의 planner 제안을 우리 코드의 실제 제약에 맞게 확정하거나 고쳤다. 고친 곳은 「이슈 본문과 다른 곳」에 모았다.
- 관계: ADR-0175(리마인더) · ADR-0109(read-state, 개인 채널 전파) · ADR-0199(인박스 투영, 개인 채널 이벤트 규약) · ADR-0204(폰 알림 v2: 푸시 닫힌 어휘, D8-a 생산자 규칙) · ADR-0120(푸시 경계) · ADR-0151(첨부) · ADR-0128(멤버십 수명주기) · ADR-0148(인용) · ADR-0182(일시 확인 정책) · ADR-0145(서버 스택) · ADR-0100(거버넌스)
- 번호 확인 [V, 2026-10-22]: `origin/main`·`origin/track/engine`·`origin/track/uxui`의 `docs/adr/`는 0205가 마지막이고, 열린 PR 중 `docs/adr/02`를 만드는 것이 없다. 이슈 #4213은 0206 알림 v2, 0207 알림 규칙, 0209 멀티 계정, 0210 Host Ops, 0211 개인 앱 토큰 금고를 따로 예약했다. 이 ADR은 **0208**만 쓴다.
- 표기: [V] 이 세션에서 저장소 코드·문서·외부 원문으로 직접 확인 · [추정] 해석 · [확인 필요] 구현 전 확인 · `runtime-unverified` 실행하지 않음. 이 문서는 설계이고 코드·마이그레이션·인프라를 바꾸지 않았다. 이 ADR이 정하는 동작은 모두 `runtime-unverified`이며 닫는 자리는 「구현 순서와 수용 기준」이다.
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
- **상주 BYPASSRLS 소비자는 relay·agent-worker·notifier다.** notifier의 정리 작업은 「BYPASSRLS 풀로 후보 읽기 + RLS 묶인 `momo_app` 풀로 쓰기」 두 풀 모양이다(`inbox_retention_sweep.rs:1-60`, `avatar_reclaim.rs:263-277`, `notifier/src/lib.rs:751-823`). 그런데 **notifier는 self-host 기본 스택에 없다.** 기본 compose의 서비스는 postgres · centrifugo · runtime-roles · migrate · api · relay · agent-worker · webhook-sender이고 notifier는 푸시 오버레이로만 선다(`docker-compose.rust.yml:6-20`, 푸시 오버레이 `:19`, 팀 `huddle-notifier` 프로필 `:646-648`; doctor도 「푸시 드레인은 오버레이에만 있다」 `oort_doctor.sh:903`). Railway 팀 인스턴스에는 있다(`infra/railway/README.md` 서비스 표 notifier 행).
- **푸시 어휘는 닫혀 있다.** reason 6종·category 5종은 relay가 모르는 값을 400으로 거절하고(`momo-push-relay/src/dispatch.rs:43-67`), 와이어는 id만 싣되 `channel_id`·`message_id`가 필수 키다(`momo-push/src/dispatch.rs:178-195`, 키 집합이 정확히 같아야 통과). 새 푸시는 relay 먼저 배포하는 순서가 있다(ADR-0204 D7). **보내지 못한 예약에는 메시지 행이 없다.**
- **개인 채널과 이벤트 규약이 있다.** `user:read-state#<MEMBER>`(`read_state.rs:177`)에 `inbox_item.created`/`inbox_item.read`/`inbox.read_all`을 id·시각만, snake_case로 낸다(ADR-0199 `:84`·`:132`, `inbox.rs:549-565`, outbox 파티션 키 = member_id). 이벤트 유실은 다음 `GET`이 복구한다(정본은 PG).
- **첨부 묶기 규칙.** `link_attachments_in_tx`(`attachment.rs:444-512`)는 `FOR UPDATE` 아래에서 `complete`·업로더 = 작성자·같은 채널·`message_id IS NULL`을 요구한다(`:476-487`), 한 메시지에 최대 20개(`:55`). 완료됐지만 묶이지 않은 첨부를 거두는 청소기는 없다: `attachment_pending_cleanup_idx`는 `pending`만 본다(`017_attachment.sql:36-39`).
- **보관 채널은 막히지 않는다.** 정본 send는 `archived_at`을 읽지 않는다(`messages.rs:694-845`). 보관은 마지막 멤버가 나갈 때 일어나므로(ADR-0128 D4) 그때 작성자도 멤버가 아니다.
- **멤버 활성 판정의 선례.** `m.status = 'active' AND m.deleted_at IS NULL`(`dm.rs:160-170`). 사람 전용·살아 있는 멤버 전제는 리마인더 라우트와 같다(`reminders.rs:37`, `:68-89`).
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
| D3 | 새 표 `scheduled_message`·`scheduled_message_attachment`, 작성자 범위 RLS FORCE, 상태 4종, BYPASSRLS 역할은 표 권한 봉인 | `sending` 삭제, `canceled` → `cancelled`, 점유 표 추가 |
| D4 | 보내기는 **정본 send 조합을 한 함수로 뽑아 REST와 스케줄러가 같이 부른다**, 한 트랜잭션, `client_msg_id` = 예약 id | 확정, 공유 함수 추출을 전제로 명시 |
| D5 | 스케줄러는 **api 프로세스의 백그라운드 틱** | 위치를 열어 둔 것을 확정(notifier·agent-worker·relay 기각) |
| D6 | 만기 목록은 SECURITY DEFINER **id 세 개** 읽기 함수(`momo_join_private` 선례) | 「함수 또는 전용 역할」 중 함수로 확정 |
| D7 | 틱 5초, `FOR UPDATE SKIP LOCKED`, DB 시계, 유예 60분 넘으면 `missed` | 정시 ±30초 목표 확정, 「늦게 보냈어요」 표시는 두지 않음 |
| D8 | 실패 사유 7종(닫힌 집합). v1 알림은 **앱 안**(목록·배너·점·개인 채널 이벤트), 푸시는 후속 | **푸시 제외**(닫힌 푸시 어휘) |
| D9 | 편집은 마감 30초 전까지, 취소·지금 보내기는 보내기 전까지. 지금 보내기는 요청 tx 안에서 같은 함수 | 취소·지금 보내기의 30초 잠금 삭제 |
| D10 | 상한: 멤버·워크스페이스당 대기 50개, 첨부 20개, 본문은 일반 메시지와 같음 | 확정 |
| D11 | 첨부는 예약 때 선검증 + 점유, 보낼 때 정본 규칙으로 재검증 | 확정(점유 표 추가) |
| D12 | 개인 채널 이벤트 `scheduled_message.updated` | 이름 `scheduled.updated` → 규약대로 |
| D13 | 감사 행 5종, 본문 불포함 | 확정 |
| D14 | 수명: 보낸·취소한 행은 본문을 지운다, 7일 뒤 정리, 멤버 제거 시 정리 | 신설 |
| D15 | 운영: 선택 환경 변수 4개, 꺼짐이면 생성 503, doctor 점검 | 신설 |
| D16 | 클라이언트 계약: 코어 모듈 하나, 201 뒤에만 입력창을 비움 | 신설(UI 명세 연결) |

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
  - `id` uuidv7 · `workspace_id` · `channel_id` · `author_member_id` · `root_id` NULL · `body` NULL · `send_at` · `status` · `failure_reason` NULL · `attempts` · `sent_message_id` NULL · `sent_at` NULL · `client_request_id` · `rev` · `created_at` · `updated_at`
  - `status`는 `pending | sent | failed | cancelled`. `cancelled` 철자는 레포 관례를 따른다(`agent_run`·`cloud_box_control` 모두 `cancelled`).
  - CHECK: `status IN ('pending','failed')`이면 `body`가 NULL이 아니거나 첨부가 있다. 끝난 행(`sent`·`cancelled`)은 **본문을 지운다**(D14).
  - UNIQUE `(workspace_id, author_member_id, client_request_id)`: 생성 재시도 멱등.
  - 인덱스: 만기 스캔용 부분 인덱스 `(send_at, id) WHERE status = 'pending'`(전 테넌트 스캔이라 워크스페이스가 앞에 서지 않는다), 목록·상한 계산용 `(workspace_id, author_member_id, status, send_at)`.
- **`scheduled_message_attachment`**: 첨부 1건당 1행(`scheduled_message_id`, `attachment_id` **UNIQUE**, `position`). 예약이 첨부를 점유하는 것을 DB가 강제한다(D11).
- RLS: 두 표 모두 ENABLE + FORCE, 정책은 082 모양 그대로 **워크스페이스 + 작성자**다(`workspace_id = app.workspace_id AND author_member_id = app.member_id`, 자식은 `member_id` 사본과 복합 FK로 부모와 같음을 보장). 모든 문장이 `app.member_id`를 묶는다(`bind_reminder_owner_guc`, `reminder.rs:119`와 같은 모양, 구현은 공용 이름으로 뽑는다).
- **봉인.** relay·worker·notifier·platform_admin이 이 두 표를 읽고 쓰지 못하게 `bootstrap_roles.sql`·`bootstrap_runtime_roles.sql`에 `scheduled-message-lockdown` 블록을 더한다(`cloud-box-lockdown`과 같은 모양, `bootstrap_runtime_roles.sql:215-245`, 두 파일 동일 + 마커 시험). 이유: 이 표의 본문은 보내기 전에는 작성자만 읽어야 하는데 BYPASSRLS 역할은 정책을 건너뛰고, 기본 권한이 `ALL TABLES`로 relay·worker에게 넘어가기 때문이다(`bootstrap_runtime_roles.sql` 상단 GRANT).

### D4. 보내기 경로 = 정본 send 그대로, 한 트랜잭션
- `messages.rs:694-845`의 조합(멤버 확인 → 루트 검증 → `send_message_with_mentions_in_tx` → `route_agent_mentions_in_tx`)을 **하나의 함수**(예: `deliver_message_in_tx`)로 뽑아 REST `send`와 스케줄러와 지금 보내기가 같은 함수를 부른다. 이 함수가 REST의 동작을 바꾸지 않는 **동작 보존 리팩터**여야 하고, 그것이 #4214의 첫 커밋이다(기존 PG 적합성 시험이 무수정으로 통과해야 한다). 공유하지 않고 베끼는 것이 이 ADR이 기각하는 설계다.
- 스케줄러의 호출 값: 작성자 신원(`author_is_human = true`, `author_is_agent = false`), `via_token_id = None`, `routing = None`, `signature = None`, `client_msg_id = scheduled_message.id`, `attachment_ids = 점유된 첨부`. 게이트·플래그는 api의 AppState에서 같은 값으로 온다.
- 한 tx 안에서: 행 잠금(`FOR UPDATE SKIP LOCKED`) → 판정(D8) → 정본 전송 → `scheduled_message`를 `sent`로 → 점유 행 삭제 → 개인 채널 outbox(D12) → 감사(D13). 롤백하면 메시지·outbox·상태가 함께 사라진다.
- 결과로 **그 시각에** 일반 메시지처럼 난다: 받는 쪽 푸시 후보·인박스 항목(INSERT 트리거), 멘션 배지, @에이전트 호출·1:1 DM 암묵 호출·스레드 답 깨움, hosted inbox 팬아웃, 스레드 롤업, 브로드캐스트. 메시지 시각은 실제로 보낸 시각이다.
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

### D6. 만기 목록 읽기 수단 = SECURITY DEFINER id 함수
api 역할은 NOBYPASSRLS라 「지금 기한 된 예약이 어느 워크스페이스에 있는가」를 RLS 너머로 읽을 수단이 필요하다. 결정은 `momo_join_private.*` 선례(`009_workspace_tenant_rls.sql:21-60`, `086_device_link_token.sql:89-120`)를 따르는 함수 하나다.
- `momo_schedule_private.due_scheduled_messages(p_limit integer)` → `(workspace_id, scheduled_message_id, author_member_id)` **세 id만**. 사양: `LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog`, `status = 'pending' AND send_at <= now()`이고 삭제되지 않은 워크스페이스만, `ORDER BY send_at, id LIMIT least(greatest(p_limit,1),200)`. 본문·채널·첨부는 반환하지 않는다.
- `author_member_id`가 결과에 있는 이유: 소유자 범위 정책(D3) 때문에 틱이 `app.member_id`를 묶기 전에는 행이 보이지 않는다.
- 권한: `REVOKE ALL ... FROM PUBLIC`, relay·worker·notifier·platform_admin에서 REVOKE, `GRANT EXECUTE ... TO momo_app`만(`086`의 DO 블록 모양). 함수 소유자는 마이그레이션 소유자(슈퍼유저)이고 FORCE RLS를 우회한다. 이 가정은 009·078·081·086이 이미 지고 있다(`SECURITY.md:80-89`: 소유자 `momo`는 슈퍼유저).
- **노출면 평가.** 선례는 비밀 하나를 받아 워크스페이스 id 하나를 돌려준다. 이 함수는 입력이 없고 목록을 돌려주므로 선례보다 넓다. `momo_app`을 SQL 수준으로 장악한 공격자는 「지금 기한 된 예약의 세 id」를 열거할 수 있다. 본문·채널·이름은 안 보이고, 그 공격자는 이미 워크스페이스 id만 알면 GUC로 그 테넌트를 읽는다(RLS는 앱이 GUC를 정직하게 건다는 신뢰 모델이다). **새로 생기는 노출은 id 열거뿐이라 수용한다.** 이 함수는 한 번에 최대 200행이고 기한이 지난 것만 돌려준다.
- 기각한 수단: (a) 전용 읽기 역할 + `SET LOCAL ROLE`: 역할 만들기·두 부트스트랩 파일 동기화·마커 시험이 따르고 얻는 것은 열 권한 한 겹뿐이다. (b) api에 `momo_notifier` 풀을 쥐여 주기: api가 BYPASSRLS 자격을 갖게 된다(`SECURITY.md`가 막는 상태). (c) `momo_app`용 GUC 게이트 교차 테넌트 정책: 본문 행 전체가 열거 대상이 된다.

### D7. 정시성 · 다중 레플리카 · 밀린 예약
- **틱**: 5초(`MOMO_SCHEDULER_TICK_MS`, 바닥 1초). 한 틱은 만기 목록을 `send_at` 순으로 **직렬**로 비운다(같은 채널·작성자의 순서가 `send_at`·`created_at` 순서로 보존된다). 한 틱에서 한 번 시도한 id는 다시 시도하지 않는다.
- **전송 tx 하나당** `with_tenant_tx_prelude`로 `app.workspace_id` + `app.member_id`(작성자)를 묶고, `SELECT ... FROM scheduled_message WHERE id = $1 AND status = 'pending' AND send_at <= now() FOR UPDATE SKIP LOCKED`. 0행이면 건너뛴다(다른 레플리카가 잡았거나, 그사이 취소·편집됐다).
- **한 번만 보낸다**: ① 행 잠금 + `status` 재확인이 INSERT와 같은 tx ② `client_msg_id = scheduled_message.id`가 `(channel_id, author_member_id, client_msg_id)` 유니크에 걸린다(`message.rs:517`): 상태 갱신이 없었더라도 두 번째 INSERT는 `deduped`가 되고 그 메시지로 `sent`를 마감한다 ③ 상태 전이가 같은 tx다.
- **시계는 DB다.** 모든 비교가 `now()`다(레플리카 시계 차이를 쓰지 않는다).
- **정시 목표**: 마감 후 30초 안(틱 5초 + 처리). 보장이 아니라 목표이고 doctor가 5분 초과를 잡는다(D15).
- **밀린 예약**: 마감에서 **유예(기본 60분, `MOMO_SCHEDULER_GRACE_SECONDS`, 5분~24시간)** 안이면 늦어도 즉시 보낸다(롤링 배포·재시작·짧은 장애). 넘었으면 보내지 않고 `failed` + `missed`로 마감하고 작성자가 정한다(지금 보내기 · 다시 예약 · 삭제). 근거: 「내일 9시 스탠드업」을 반나절 늦게 조용히 보내는 것도, 말없이 버리는 것도 나쁘다. Mattermost는 24시간 창을 두고 넘으면 처리하지 않는다 [V]. 우리는 창을 줄이고 사용자에게 결정을 넘긴다. **「늦게 보냈어요」 표시는 두지 않는다**: 유예 안에서 나간 메시지는 최대 1시간 늦고 메시지 시각이 실제 시각이라 거짓이 없다.
- **일시 오류**(DB 오류·타임아웃)는 롤백하고 별도 짧은 tx에서 `attempts`를 올린 뒤 다음 틱에 다시 한다. `attempts`가 5에 닿으면 `failed` + `send_error`다. 정본이 돌려주는 **거절**(D8)은 즉시 마감한다: 전송 tx를 롤백하고 별도 tx에서 `failed`를 적는다(`SendRejected`는 「호출자가 롤백」 계약이다, `message.rs:816-823`).
- **`sending` 상태는 두지 않는다.** 전송·상태 전이가 한 tx이면 `sending`은 커밋된 적이 없고, 크래시는 `pending`으로 롤백한다. 임대(lease)와 멈춘 행 회수(푸시 드레인의 `reclaim_stuck` 같은)가 필요 없다. 이슈의 「409 보내는 중」은 행 잠금 대기(`lock_timeout` 3초)가 끝났을 때의 `scheduled_busy`로 표현한다.

### D8. 실패
- 판정 순서와 사유(닫힌 집합, `failure_reason`, 엔진 소유 enum):

| 사유 | 판정 | 비고 |
|---|---|---|
| `missed` | 마감 + 유예가 지났다 | 서버가 쉬었다 |
| `author_inactive` | 작성자 `member.status <> 'active'` 또는 삭제됨(`dm.rs:160-170` 모양) | 정지 중 마감이 지나 재개 뒤에 보인다 |
| `not_member` | `is_channel_member`가 거짓(`identity.rs:130-145`) | 채널을 나갔다 |
| `root_unavailable` | `validate_thread_root_in_tx`가 거절(없음·삭제·최상위 아님) | 답하려던 글이 지워졌다 |
| `attachment_unavailable` | `link_attachments_in_tx`가 거절(`attachment.rs:476-487`) | 파일이 없거나 이미 쓰였다 |
| `not_allowed` | 정본 경로가 앞으로 더하는 다른 정책 거절 | 지금은 비어 있다 |
| `send_error` | 일시 오류 5회 | 서버 문제 |

- **보관 채널은 사유가 아니다.** 정본이 막지 않는다(위 「지금 있는 것」). 보관 채널 전송을 막는 규칙이 정본 경로에 들어가면 스케줄러는 자동으로 따른다(`not_allowed`).
- **알림은 v1에서 앱 안이다**: (a) 개인 채널 이벤트로 작성자의 모든 기기(D12) (b) 「예약됨」 목록의 「보내지 못함」 구역과 사유 (c) 그 채널의 입력창 위 배너가 실패 어조로 바뀐다 (d) 사이드바 「예약됨」 행·폰 프로필의 점. 폰에는 푸시가 없다.
- **푸시는 이 ADR이 하지 않는다. 비용을 이름으로 적는다**: 와이어가 닫힌 어휘이고 메시지 id가 필수인데 보내지 못한 예약에는 메시지가 없다. 새 푸시는 ① reason 1종 추가(relay `ALLOWED_REASONS`, 서버 `PushReason`, 앱 상수) ② `message_id` 자리에 올 값(예약 id) 또는 새 선택 키: **키 집합 변경은 ADR-0120 변경이다**(`momo-push/src/dispatch.rs` 머리) ③ NSE가 무엇을 가져와 그릴지 ④ `push_candidate`의 새 생산자(ADR-0204 D8-a가 「Accepted ADR 없이 더하지 않는다」고 못 박았다) ⑤ relay 먼저 → 서버 → 앱 배포 순서(ADR-0204 D7)를 요구한다. 그래서 별도 증보로 정한다. **그 전까지 실패는 앱을 열어야 보인다**(수용, 위험 4).

### D9. 편집 · 지금 보내기 · 취소
- **편집**(`PATCH {body?, sendAtMs?}`, 하나 이상): `pending`이고 마감까지 **30초 넘게 남았을 때만**. 30초 안이면 409 `scheduled_too_late`. 근거: 열어 둔 편집기가 마감을 넘기는 것을 막지는 못해도(그때는 409 `scheduled_already_sent`) 「곧 보내요」 상태를 서버가 말해 준다. 행 잠금 덕에 경쟁은 안전하다.
- **`failed` 행**: `sendAtMs`를 주면 `pending`으로 되살아난다(`attempts`·사유 초기화, 대기 50개 상한에 다시 센다). `body`만 주면 글만 고친다.
- **지금 보내기**(`POST …/send-now`): `pending`·`failed`에서 허용. **요청 tx 안에서 D4의 같은 함수를 부른다**(마감을 지금으로 당겨 한 틱 기다리는 방식 대신). 행 잠금이 스케줄러를 배제하고, 요청자는 즉시 결과를 받는다. 거절이면 409 + `error.code` = 실패 사유, 행은 `failed`가 된다.
- **취소**(`DELETE`): `pending`·`failed`에서 허용, **마감 30초 안에서도 된다.** 취소는 가장 중요한 안전 동작이고 행 잠금이 경쟁을 닫는다(스케줄러가 먼저 잠그면 취소가 기다렸다가 409 `scheduled_already_sent`, 취소가 먼저면 스케줄러의 재확인이 0행). 이슈 본문은 셋 다 30초 잠금이었으나 근거가 없었다.
- 락 대기 상한 3초를 넘기면 409 `scheduled_busy`(다시 시도).

### D10. 상한
- 멤버·워크스페이스당 `pending` **50개**(Gmail 100·Slack 채널당 5분 30개와 같은 부류의 남용 방지). 생성과 `failed` → `pending` 되살리기가 센다. 동시성은 `pg_advisory_xact_lock(hash(workspace, member))` 아래에서 센다(`dm.rs:183` 선례). 초과는 409 `pending_limit_reached`.
- 첨부는 메시지당 20개(`attachment.rs:55`). 본문 상한은 일반 메시지와 같다(서버에 별도 글자 수 상한이 없고 요청 본문 상한만 있다).
- 속도 제한은 인증 라우트의 기존 한도를 그대로 받는다.

### D11. 첨부
- **예약 때** `link_attachments_in_tx`와 같은 술어를 미리 검증한다: `complete`, 업로더 = 작성자, 같은 채널, 묶이지 않음, 중복·20개 초과 없음. 오류 상태는 REST send와 같다(`messages.rs:388-402`: 400 중복·초과, 404 없음, 409 미완료·이미 묶임, 403 다른 업로더·다른 채널). 여기에 **다른 예약이 점유 중**이면 409 `attachment_reserved`.
- 점유는 `scheduled_message_attachment.attachment_id` UNIQUE가 강제한다. 이 점유 때문에 같은 첨부를 즉시 보내기와 예약에 동시에 쓰는 일은 정본 규칙(`message_id IS NULL`)이 마지막 문을 지킨다.
- **보낼 때** 정본 묶기가 같은 술어를 `FOR UPDATE` 아래에서 다시 판정한다. 어긋나면 `attachment_unavailable`.
- 취소·삭제하면 점유를 풀고 파일은 남는다(초안과 같은 상태). 완료됐지만 묶이지 않은 첨부를 거두는 청소기는 지금도 없고(`017_attachment.sql:36-39`) 이 ADR이 만들지 않는다: 후속 후보.

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
- `rev`는 행이 바뀔 때마다 1 올라 멱등 키의 꼬리가 된다.

### D13. 감사
- `audit_log` 행 5종: `scheduled_message.created` · `.updated`(본문 또는 시각 변경) · `.cancelled` · `.sent` · `.failed`. 지금 보내기는 `.sent`의 detail `via: "send_now"`다. 스키마 `momo.scheduled_message.<verb>.v1`, 대상 `("scheduled_message", id)`(`reminders.rs` 감사 모양).
- detail은 id·열거값·밀리초뿐이다(`sendAtMs`, `channelId`, `sentMessageId`, `failureReason`, `lateMs`). **본문·첨부 이름을 싣지 않는다.**
- 사람이 한 일의 actor는 그 멤버다. 스케줄러가 한 `.sent`·`.failed`는 actor가 없고(시계는 멤버가 아니다, `avatar_reclaim.rs:318-351` 선례) `about`이 작성자다.

### D14. 수명 · 보존 · 개인정보
- `sent`·`cancelled`가 되면 **같은 tx에서 본문을 지우고 점유 행을 삭제한다**(보낸 글의 정본은 message 행, 취소한 글은 어디에도 남기지 않는다). 행 자체는 7일 뒤 정리한다(생성 재시도 멱등과 감사 연결용). `failed` 행은 30일 뒤 정리한다.
- 정리는 **같은 작성자의 다음 쓰기**(생성·수정·취소)가 기회적으로 한다(자기 범위 `DELETE`, 교차 테넌트 필요 없음). 쓰지 않는 작성자의 본문 없는 껍데기는 남아도 해가 없다.
- **멤버 제거(ADR-0128 D3)는 같은 tx에서 그 멤버의 대기·실패 예약을 `cancelled`로 정리한다**(본문 폐기). 정지는 건드리지 않는다: 마감이 지나면 `author_inactive`가 되고 재개 뒤 작성자가 본다. 워크스페이스 삭제는 FK 연쇄다.
- **가시성**: 보내기 전 본문은 작성자만 읽는다. 워크스페이스 owner·admin도 못 읽는다(소유자 범위 RLS, 감사 행은 id만). 검색·팀 기억(ADR-0196)은 message 행에서 읽으므로 보내기 전 본문에 닿지 않는다. PITR 백업에는 일반 표처럼 들어간다.

### D15. 운영
- 선택 환경 변수(모두 기본값이 있고 필수 변수는 없다. compose·Railway 카탈로그의 이름 대조에 영향이 없다): `MOMO_SCHEDULER_ENABLED`(기본 1), `MOMO_SCHEDULER_TICK_MS`(5000), `MOMO_SCHEDULER_BATCH`(100, 1..=200), `MOMO_SCHEDULER_GRACE_SECONDS`(3600, 300..=86400). 운영 문서(SELF_HOST)에 한 표로 적는다.
- **`MOMO_SCHEDULER_ENABLED=0`이면 틱이 돌지 않고 생성·수정·지금 보내기가 503 `scheduler_disabled`다**(목록·삭제는 된다). 조용히 쌓이는 예약이 없도록 꺼짐이 곧 거절이다(드라이브·GitHub 표면의 「설정 없으면 503」 선례).
- **doctor 점검 `stack.scheduler`**: 마감이 5분 넘게 지난 `pending`이 있으면 major, 최근 24시간 `failed` + `missed`가 있으면 info. 소유자 연결로 교차 테넌트 개수만 센다(`stack.outbox`와 같은 방식).
- 로그는 개수·id뿐이다(본문 불포함). 틱 지연(마감 대비 실제 전송까지)은 로그에 분포로 남긴다.

### D16. 클라이언트 계약 (요약, 상세는 부록 B)
- 공유 코드는 `packages/momo-core/src/features/scheduled/`(타입, API 클라이언트, 프리셋, 이벤트 해석, **문구 표**)가 한 벌 갖는다. 문장·토큰·코어 로직만 공유하고 뷰는 각자 구현한다(디자인 시스템 README §1).
- **서버가 201을 준 뒤에만 입력창·첨부 트레이·초안을 비운다.** 실패하면 글·첨부가 그대로 남는다(낙관적 비움 없음). 재시도는 같은 `clientRequestId`를 써서 중복 예약을 만들지 않는다.
- 이벤트(D12)와 `GET`으로 목록·배너를 만든다. 오프라인이면 목록은 캐시를 보이고 변경은 막으며 이유를 말한다.

## 이슈 본문과 다른 곳
| 이슈 본문 | 이 ADR | 근거 |
|---|---|---|
| 스케줄러 위치 미정(api vs agent-worker vs relay) | api 프로세스 틱 | `route_agent_mentions_in_tx`가 `pub(crate)`이고 notifier는 self-host 기본 스택에 없다 (D5) |
| 「만기 읽기 수단: 함수 또는 역할」 | SECURITY DEFINER id 세 개 | `momo_join_private` 선례, 작성자 id가 필요한 이유 (D6) |
| 상태 5종(`sending` 포함) | 4종 | 한 tx면 `sending`이 커밋되지 않는다 (D7) |
| `canceled` | `cancelled` | 레포 관례 (D3) |
| `sendAt` | `sendAtMs` | `openapi.yaml:35` |
| 422 범위 밖 시간 | 400 + `error.code` | 리마인더가 400이다, `ErrorResponse.code` 메커니즘 |
| `scheduled.updated` | `scheduled_message.updated` | `inbox_item.*` 규약 (D12) |
| 취소·지금 보내기·편집 모두 마감 30초 전까지 | 편집만. 취소·지금 보내기는 보내기 전까지 | 행 잠금이 경쟁을 닫는다 (D9) |
| 푸시 「예약 메시지를 보내지 못했어요」 | v1은 앱 안, 푸시는 후속 | 닫힌 푸시 어휘와 `message_id` 필수 키 (D8) |
| 실패 사유 「채널 보관」 | 사유 아님 | 정본 경로가 막지 않는다 (D8) |
| 「늦게 보냈어요」 표시 여부 | 두지 않음, 유예 60분 넘으면 `missed` | D7 |
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
- (+) 새 자격 증명·새 서비스·새 BYPASSRLS 쓰기가 없다. 새 노출은 id 열거 하나이고 위에 적었다.
- (+) 구현 이슈 셋이 같은 계약(openapi 초안·UI 명세·이 ADR)에서 병렬로 출발한다.
- (−) api 바이너리에 첫 상주 작업이 생긴다. 틱이 멈추는 경우를 doctor가 잡아야 한다.
- (−) REST send의 조합을 함수로 뽑는 리팩터가 선행한다. 회귀는 기존 PG 적합성 시험이 지킨다.
- (−) 푸시가 없는 동안 실패는 앱을 열어야 보인다.
- 운영: 마이그레이션 1개(표 2개 + 함수 + 인덱스), 부트스트랩 SQL 두 파일의 봉인 블록, 선택 환경 변수 4개, doctor 점검 1개, 이벤트 type 1개.

## 구현 순서와 수용 기준

선행 순서: #4214(엔진) → 같은 때 #4215(웹·데스크탑, **코어 모듈 `features/scheduled/`를 첫 PR로 먼저 랜딩**) → #4216(폰, 코어를 소비). UI는 서버 PR 전에 계약대로 mock으로 진행한다. ADR이 Accepted이므로 구현 이슈가 열릴 수 있다(ADR-0100).

### #4214 엔진 서버
1. **선행 커밋(동작 보존 리팩터)**: D4의 공유 함수 추출. 기존 `messages`·`agent_mentions` PG 적합성 시험이 무수정으로 통과.
2. 마이그레이션(표 2·RLS FORCE·정책·인덱스·함수·권한), 부트스트랩 두 파일의 `scheduled-message-lockdown`(마커 동일 시험).
3. 라우트 5개(부록 A), 스케줄러 틱, 실패·재시도·유예, 이벤트, 감사, 멤버 제거 연동, 기회적 정리, `MOMO_SCHEDULER_*`, doctor 점검, SELF_HOST 운영 표.
4. 계약 마무리: `openapi.yaml`의 「계약 초안」 문구를 걷고, 새 연산 5개를 샘플과 함께 `scripts/openapi_sampled_on_rust.txt`에 올린다(「새 연산은 샘플과 함께 랜딩」, `openapi_known_unsampled.txt` 머리).
5. PG 적합성 시험(격리 PG, 전용 포트)과 사보타주. 되돌리면 이름 있는 시험이 실패해야 한다:

| 시험(이름 안) | 지키는 것 | 되돌리는 방법 |
|---|---|---|
| `a_due_message_is_sent_once_under_two_schedulers_and_send_now` | 중복 전송 0 | `FOR UPDATE SKIP LOCKED` 또는 `client_msg_id = 예약 id` 제거 |
| `scheduled_rows_are_visible_only_to_their_author` | 타 멤버·타 워크스페이스 접근 0 | 정책에서 `author_member_id` 술어 제거 |
| `the_scheduler_write_runs_as_a_role_that_does_not_bypass_rls` | BYPASSRLS 쓰기 0 | 쓰기 풀을 relay 역할로 연결(`ensure_write_pool_rls_bound` 선례) |
| `due_list_returns_three_ids_and_only_momo_app_may_call_it` | 노출면 | 반환 열 추가·`PUBLIC` 부여 |
| `bodies_are_unreachable_for_the_bypassrls_roles` | 봉인 | 봉인 블록 제거 |
| `a_scheduled_mention_starts_the_same_agent_run_as_a_rest_send` | 정본 경로 동일 | 스케줄러에서 멘션 호출 단계 생략 |
| `each_failure_reason_is_named_and_the_grace_boundary_holds` | 사유 7종, 유예 경계 ±1초 | 판정 순서 바꾸기 |
| `post_is_idempotent_on_client_request_id` / `the_cap_holds_under_concurrency` | 중복·상한 | UNIQUE 또는 advisory lock 제거 |
| `an_edit_in_the_last_30_seconds_is_refused_but_a_cancel_races_safely` | D9 | 30초 판정·행 잠금 제거 |
| `the_event_rides_the_personal_channel_with_ids_only` | 본문 비유출 | 이벤트에 `body` 추가 |
| `removing_a_member_cancels_their_schedules_and_drops_the_body` | D14 | 연동 제거 |

### #4215 웹·데스크탑 UI, #4216 폰 UI
- 부록 B의 상태 8개(기본·메뉴 열림·직접 고르기·예약 직후·배너·목록·실패·오프라인)를 모두 구현하고 문구표의 문장 그대로 쓴다. 웹은 1440 라이트·다크, 폰은 시뮬레이터 라이트·다크 캡처. design-review Blocker 0·High 0, 웹은 `scripts/design_preflight_web.sh`.
- 시험: 프리셋 계산(경계: 일요일·자정·월말·DST), 201 뒤에만 비움, 실패 시 보존, 이벤트로 목록 갱신, 오프라인·인용·빈 입력 비활성 사유, 접근성(낭독 이름·초점 복귀·동작 줄이기). 사보타주를 PR 본문에 적는다.

## 보안 · 경계 요약
- 새 자격 증명 없음. 새 공개 API는 연산 5개이고 사람 bearer 전용이다(에이전트 403).
- 새 테넌트 표 2개는 RLS FORCE + 작성자 범위다. **쓰기 경로의 BYPASSRLS는 0이다**: 스케줄러의 모든 쓰기는 `momo_app` tx다. 교차 테넌트 읽기는 id 세 개를 돌려주는 함수 하나뿐이고 EXECUTE는 `momo_app`만 갖는다.
- relay·worker·notifier·platform_admin은 두 표에 권한이 없다.
- **권한은 보내는 시각에 다시 판정된다.** 예약이 권한을 고정하지 않는다: 그사이 채널을 나갔거나 정지됐으면 못 보낸다. 에이전트 호출 권한도 정본 게이트가 보낸 시각의 상태로 판정한다.
- 보내기 전 본문은 작성자 외 누구도 못 본다(워크스페이스 owner 포함). 감사·이벤트·로그에 본문이 없다.
- 남용: 50개·최소 1분·최대 120일. 받는 쪽에서는 일반 메시지와 같은 속도 제한·음소거·방해 금지가 그대로 적용된다.

## 남는 위험과 후속
1. 정시는 목표이고 보장이 아니다: 장애가 유예(60분)를 넘으면 `missed`로 마감되고 사람이 정한다.
2. 푸시가 없는 동안 실패는 앱을 열어야 보인다. 후속: 푸시 증보(D8의 다섯 비용을 정한다).
3. id 열거 노출(D6)은 수용한다. 기한이 지난 것만, 한 번에 200행이다.
4. 정본 send가 바뀌면 예약에도 같은 변경이 즉시 적용된다(공유 함수의 값이자 위험). 이를 위해 적합성 시험이 REST와 스케줄러를 한 표로 덮는다.
5. 완료·미묶임 첨부의 청소기는 없다(취소된 예약의 파일이 남는다). 후속 후보.
6. 받는 사람 현지 시각, 인용 답장 예약, 모델 지정 예약, 팔레트 명령 「예약해서 보내기」는 v1 밖이다.
7. 기본 self-host 스택에 notifier가 없으므로 승인 만료 정리 같은 notifier 상주 작업도 그 스택에서는 돌지 않는다. 이 ADR의 범위 밖 관찰이라 별도 확인이 필요하다 [확인 필요].

## owner 결정 (인용)
- 2026-10-22 성재: 「예약 메세지 기능을 추가하면 좋을 거 같은데 UI및 실제 설계 작업도 추가로 작업해줘.」
- planner 상시 위임 2026-10-19: 이슈 #4213의 Acceptance가 이 ADR의 Accepted 근거로 지정한 기록이다. 위임 원문은 공용 문서에 없어 여기에 인용하지 않는다. [확인 필요: planner가 원문 인용을 보강한다]. 이 위임은 새 자격 증명 없이 기능 설계의 세부를 정하는 범위로 쓴다. 이 ADR은 새 자격 증명이 없고, 새 BYPASSRLS 쓰기가 없으며, 푸시 와이어를 바꾸지 않는다.
- planner 확인 요청(이의가 있으면 증보로 고친다): ① 실패 푸시를 v1에서 뺀 것(D8) ② 취소·지금 보내기에 30초 잠금을 두지 않은 것(D9) ③ 스케줄러를 api 프로세스에 둔 것(D5) ④ 유예 60분(D7).

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
| 403 | | 에이전트 bearer · 비활성 멤버 · 채널 멤버 아님 · 다른 업로더·다른 채널 첨부 |
| 404 | | 채널 또는 예약을 못 찾음(남의 예약 포함) |
| 409 | `pending_limit_reached` | 대기 50개 |
| 409 | `attachment_reserved` | 다른 예약이 점유한 첨부 |
| 409 | `scheduled_too_late` | 편집은 마감 30초 전까지 |
| 409 | `scheduled_already_sent` | 이미 보냄 |
| 409 | `scheduled_busy` | 지금 보내는 중(잠금 대기 3초 초과) |
| 409 | 실패 사유 코드 | 지금 보내기가 거절됨(`not_member` 등) |
| 429 | | 기존 속도 제한 |
| 503 | `scheduler_disabled` | 운영자가 스케줄러를 껐다 |

## 부록 B. UI 명세
[`docs/design-system/scheduled-messages-ui.md`](../design-system/scheduled-messages-ui.md): 웹·데스크탑과 폰의 상태 8개 와이어프레임, 해요체 문구표, 접근성·동작 줄이기·오프라인. #4215·#4216의 정본이다.
