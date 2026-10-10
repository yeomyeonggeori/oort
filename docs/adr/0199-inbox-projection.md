# ADR-0199: 인박스 서버 투영 — 나와 관련된 것을 서버가 기억한다

- Status: **Proposed** (owner 결재 대기 — 공개 API·DB 계약 추가라 ADR-0100에 따라 Accepted 전에는 구현을 머지하지 않는다)
- Date: 2026-10-11
- Deciders: 성재
- 기안: Opus 5.5 (#3664, #3663 후속)
- 관계: ADR-0109(read-state 커서·개인 채널 전파), ADR-0178(mark-unread, D3 합성 단일점), ADR-0148(인용 답글 = 이름 부르기, 규칙 5), ADR-0124(알림 mute), ADR-0120(push 후보 트리거), ADR-0100(거버넌스)
- 표기: [V] 코드·문서 직접 확인 · **[추정]** 해석 · [확인 필요] 구현 전 사실 확인 · `runtime-unverified` 실행 안 함. 이 ADR은 설계 문서이고 서버 코드·마이그레이션을 바꾸지 않았다.

## 맥락

성재 원문: 「마치 메일함이나 알림함처럼 나와 관련된 내용들을 확인할 수 있는 일반적인 인박스의 기능도 필요해」, 「나와 관련된 혹은 내가 봐야했던, 봤던 인박스 내용들이 보여야하는데」.

#3663(PR #3668)이 클라이언트만으로 인박스를 만들었다. `packages/momo-core/src/features/inbox/mailbox.ts`가 이미 있는 읽기 계약 넷(DM 채널 + read-state, `mention_count` 뒤의 멘션, 내 글의 `thread` 롤업, 대기 승인)을 한 모양으로 모은다. 머리말이 한계를 스스로 적었다: 「읽은 멘션·내가 답만 한 스레드·내게 배정된 작업은 서버가 기억하는 사실이 아니다」.

0.1.22 실제 화면(2026-10-11, oort-team 실데이터)에서 인박스에 4일 전 항목 하나만 보였다. #agent-lab에서 @grokbot이 **내 메시지를 인용해 답한 것**(19:07·19:46)이 없다. 성재가 바란 핵심은 둘이다.

1. **내 메시지에 대한 답·인용** — 스레드 밖에서 인용해 답한 것 포함.
2. **읽은 멘션 보존** — 읽어도 목록에서 사라지지 않는다.

### 확인한 서버 사실 [V]

- **인용 답 데이터 모델은 있다.** `message.reply_to_id`(`001_init.sql:176`, 「direct reply target」)와 `root_id`(스레드 소속)는 별개 축이다(ADR-0148, `message.rs:169`). 인용은 id로만 저장되고 본문 스냅샷은 없다.
- **인용은 이미 멘션 경로를 탄다.** `record_mentions_in_tx`(`read_state.rs:566`)가 인용된 메시지의 작성자를 `@handle` 수신자와 같은 집합에 넣어 `message.props.mention_member_ids`(대문자 uuid 토큰)에 쓰고, 커서가 뒤에 있는 수신자의 `read_state.mention_count`를 올린다. 같은 tx다. **읽은 뒤에도 `props.mention_member_ids`는 지워지지 않는다** — 즉 「읽은 멘션」과 「내 글에 대한 인용 답」의 원천 사실은 이미 DB에 있고, 없는 것은 **그것을 멤버별로 나열하는 읽기 경로**다. `mention_count`는 안 읽은 개수일 뿐이고(`record_mentions_in_tx` 문서: 이미 읽은 멤버는 올리지 않음), 목록 API는 없다.
- **멘션 기록이 빠지는 생산자가 있다.** `send_message_in_tx`는 `MentionPolicy::Skip`(`message.rs:739~784`)이다. 에이전트 최종 응답(`momo-agent/src/run.rs`, `reply_to_id` 설정)·승인 카드·work-session 카드·게이트웨이 완료가 이 경로다. 반면 `oort_message_post`(`agent_port_tools.rs:555`)는 `send_message_with_mentions_in_tx`(Record)다. @grokbot의 인용 답이 어느 경로로 나갔는지는 [확인 필요]이지만, **Skip 경로의 인용 답은 어떤 멘션 장부에도 남지 않는다.** 이 ADR의 투영은 생산자별 파싱이 아니라 `message` 행(`reply_to_id`·`root_id`·`props`)에서 파생해서 이 구멍을 닫는다.
- **message INSERT 트리거 선례가 있다.** `push_candidate_enqueue_trg`(`011_push_notifier.sql`)가 「모든 생성 경로를 서버 쓰기 경로 수정 없이 같은 tx에서」 덮는다. 같은 형태가 인박스에도 맞다.
- **스레드 팔로우 모델은 없다.** `thread_follow`류 테이블·ADR 없음(grep). 「팔로우한 스레드」는 새로 정의해야 한다.
- **개인 채널 전파는 있다.** ADR-0109 D3: read-state 변경은 outbox → relay → 같은 멤버의 다른 디바이스 개인 채널.
- 마이그레이션 최신 번호는 `125_subscription_retire.sql`이다. 다음은 126.

## 결정 (제안)

### D1. 정본 = 쓰기 시 투영 테이블 `inbox_item`
message INSERT와 같은 tx에서 수신자별 행을 쓴다. **AFTER INSERT 트리거**(`push_candidate` 선례)로 하고, 앱 코드의 생산자별 호출에 의존하지 않는다 — 에이전트·게이트웨이·work-session·REST 어느 경로로 만든 메시지든 같은 규칙으로 걸린다(위 Skip 구멍을 닫는 이유).

- **단일 tx outbox 계약과의 관계**: 계약(`channel_seq 증가 + message INSERT + outbox INSERT` 단일 tx)은 그대로다. 투영 행은 그 tx 안의 **파생 쓰기**일 뿐 새 순서·새 전송 경로를 만들지 않는다. 알림용 실시간 신호(D7)만 같은 tx의 outbox 행으로 나간다. 클라이언트 직접 publish 없음. Postgres가 원본이고 투영은 `message`에서 **재생성 가능한 파생물**이다(D8 backfill이 그 증명).
- 정본은 여전히 `message`다. `inbox_item`이 틀려도 `message`에서 다시 만든다.

### D2. 항목 종류 (v1)
| kind | 수신자 | 생성 조건 |
|---|---|---|
| `mention` | `props.mention_member_ids`의 멤버 | 서버가 기록한 멘션(인용에 의한 것 제외) |
| `reply_to_me` | `reply_to_id`가 가리키는 메시지의 작성자 | 인용 답. **스레드 안팎 불문**, 자기 글 인용 제외 |
| `thread_reply` | 스레드 참여자(루트 작성자 + 그 스레드에 이미 글을 쓴 멤버) | `root_id` 있는 새 답. 이미 `mention`/`reply_to_me`로 만들어진 수신자는 건너뜀 |
| `dm` | DM 채널의 상대 | DM 채널의 새 메시지 |
| (`approval`) | 승인 대상 | **저장하지 않는다.** 상태가 바뀌는 사실이라 D6 응답에서 `approval` 라이브 조회로 합친다 |

한 메시지가 한 수신자에게 낳는 행은 **하나**다(우선순위 `reply_to_me` > `mention` > `thread_reply` > `dm`, 부가 사유는 `reasons[]`). 같은 대화에서 한 줄에 사유가 둘이어도 목록은 한 번만 보인다.
**작성자 자신, 비활성/탈퇴 멤버, 에이전트 수신자는 제외**한다(에이전트의 수신함은 별개 — ADR-0162/hosted inbox). **배정된 작업(task)은 v1에서 제외**한다. 서버에 「내게 배정」이라는 일급 사실이 아직 없다(work 제어는 ADR-0188 소관). 별 이슈.

### D3. 읽음 의미: 항목 읽음은 커서의 하위 사실, 항목→커서 방향은 없다
- `inbox_item.read_at`(nullable). 항목마다 갖는다. 읽은 항목은 **목록에서 사라지지 않는다**(성재 요구 2).
- **커서 → 항목(자동)**: `PUT read-state`로 `last_read_seq`가 전진하면, 같은 tx에서 그 채널의 `seq <= last_read_seq` 항목에 `read_at = now()`를 채운다(`read_at IS NULL`만). 채널을 열어 봤으면 그 안의 인박스 항목도 본 것이다.
- **항목 → 커서(없음)**: 항목 하나를 「읽음」으로 눌러도 `last_read_seq`를 움직이지 않는다. 한 항목 때문에 앞 메시지 전부가 읽음 처리되는 현행 클라의 부작용(`mailbox.ts` 머리말)을 없앤다. 항목 읽음은 **인박스 자신의 상태**다.
- mark-unread(ADR-0178)가 걸린 채널: `marked_unread_before_seq` 이후 항목의 `read_at`을 되돌리지 않는다(단조). 안 읽음 판정은 `read_at IS NULL`이고, D3 합성 규칙(`effectiveUnreadStartSeq`)은 채널 배지 전용으로 유지한다.
- 전체 읽음: `POST …/inbox/read-all`(필터 인자 가능).

### D4. 보존
- 안 읽은 항목은 보존 기한 없음. 읽은 항목은 `read_at` 기준 **90일** 뒤 삭제(주기 정리 작업). 삭제는 투영만 지우고 `message`는 건드리지 않는다.
- 원본 메시지 삭제(tombstone, ADR-0148)·채널 비공개 전환·멤버 퇴장: 항목은 조회 시 `message`/`membership`을 join해 **가시성을 다시 판정**한다(삭제 메시지는 「삭제된 메시지」 자리표시, 접근 상실 채널은 숨김). 투영에 본문 스냅샷을 두지 않는다(ADR-0148 규칙 3과 같은 이유).
- 알림 mute(ADR-0124)는 항목 **생성**에 영향 주지 않는다. `mute`된 채널의 항목은 목록에서 필터 `muted=hide|show`(기본 hide, 멘션은 `mention_overrides_mute`를 따른다)로 가른다.

### D5. 테넌시·RLS
- `inbox_item(id, workspace_id, member_id, kind, reasons text[], channel_id, message_id, seq, actor_member_id, created_at, read_at)`. 신규 테넌트 테이블이므로 `workspace_id` + **RLS ENABLE + FORCE**, `ws_isolation` 정책(`121_work_host_folder.sql` 형태), 모든 읽기·쓰기는 tx마다 `SET LOCAL app.workspace_id`. 쓰기 경로 BYPASSRLS 없음 — 트리거는 호출 tx의 테넌트 문맥에서 돈다.
- **수신자 격리**: API는 bearer 주체의 `member_id` 행만 조회한다(본문에 member 지정 없음 — ADR-0109 D3 actor binding과 같다). 테넌트 RLS는 워크스페이스 경계, 멤버 경계는 쿼리 predicate이므로 시험에서 **같은 워크스페이스의 다른 멤버 항목이 안 보임**을 별도로 증명한다.
- 유일성: `UNIQUE (member_id, message_id)`(D2의 한 메시지 한 행). 인덱스: `(workspace_id, member_id, created_at DESC, id DESC)`, 안 읽음 부분 인덱스 `WHERE read_at IS NULL`, 자동 읽음용 `(member_id, channel_id, seq)`.

### D6. API
`GET /v1/workspaces/{ws}/inbox?filter=&cursor=&limit=`
- `filter`: `all`(기본) · `unread` · `mention` · `reply` · `dm` · `thread`. (`task`는 후속.)
- 페이지네이션: **키셋** 커서 `(created_at, id)` 불투명 토큰, `limit` 기본 30·최대 100, 최신순. 오프셋 금지.
- 응답: `{ items:[{id, kind, reasons, channel:{id,name,kind}, message:{id, seq, authorMemberId, preview, deleted}, quotedMessage?:{id, authorMemberId, preview}, rootId?, actorMemberId, createdAt, readAt}], nextCursor, unreadCount, approvalsPending:[…] }`. `preview`는 읽을 때 `message`에서 만든 짧은 문자열이다(스냅샷 저장 아님).
- 읽음: `PUT …/inbox/{itemId}/read`(멱등, `read_at` 한 번만 채움), `POST …/inbox/read-all`. 안 읽음으로 되돌림은 v1에서 없다(요청 시 별 ADR 증보).
- 에이전트 bearer는 사용하지 않는다(`require_human`) — 에이전트의 일은 hosted inbox 소관.
- 이 표면이 **공개 API 추가**이므로 이 ADR의 Accepted가 구현 머지 조건이다.

### D7. 실시간 갱신
항목을 만든 같은 tx가 수신자 개인 채널용 outbox 행 `inbox_item.created`(`{itemId, kind, channelId, createdAt}` id 위주 페이로드, 본문 없음)와 읽음 전이용 `inbox_item.read`/`inbox.read_all`을 쓴다. relay → Centrifugo 개인 채널은 ADR-0109 D3의 read-state 전파와 **같은 경로**다. 클라는 이벤트로 배지를 즉시 올리고, 목록은 `GET`으로 보강한다(이벤트 유실은 다음 `GET`이 복구 — 정본은 PG). push 판정은 기존 `push_candidate`가 그대로 하고 인박스는 간섭하지 않는다.

### D8. 이행(backfill)과 호환
- 마이그레이션은 테이블+트리거+정책(126). backfill은 **별도 idempotent 작업**으로 최근 90일 `message`를 훑어 `ON CONFLICT DO NOTHING`으로 채운다. 이것이 「오늘 이미 있는 읽은 멘션·인용 답이 인박스에 처음부터 보인다」는 성재 요구의 충족이고, 투영이 파생물이라는 증명이다. backfill 행의 `read_at`은 그 시점 채널 커서로 정한다.
- 클라(`mailbox.ts`)는 서버 응답이 있으면 그것을 원천으로 쓰고, 없으면(구 서버) 현행 조합으로 후퇴한다(`runtime-unverified`, 후퇴 경로 시험은 E3).

## 대안과 기각

| 대안 | 기각 이유 |
|---|---|
| **읽기 시 계산**: `message`를 `props->'mention_member_ids'`(GIN)·`reply_to_id` join·`root_id`로 합집합 | 원천이 이미 DB에 있어 가장 작은 변경이다. 그러나 ① 항목 단위 읽음·보존 기한·삭제 가능성을 담을 자리가 어차피 별 테이블(상태)이 필요하다 ② 멤버의 전 채널에 걸친 합집합이 채널 수·메시지 수에 비례하고 키셋 정렬 보장이 어렵다 ③ 생산자별로 멘션이 빠지는 구멍(Skip)은 읽기 쿼리가 `reply_to_id`로 직접 보면 닫히지만, 스레드 참여자·DM 판정이 매 요청 join이 된다. **owner 결정 1의 대안 B**로 남긴다. |
| 앱 코드의 생산자별 투영 호출 | Skip 경로를 하나라도 놓치면 지금 버그가 재발한다. 트리거가 단일점. |
| `mention_count`/`read_state`에 컬럼 확장 | 개수만 담고 목록·항목 읽음을 못 담는다. ADR-0178이 막은 「read-state에 의미 얹기」의 연장. |
| 클라이언트가 채널을 훑어 재구성 | #3663이 이미 기각(P7). 오프라인·기기 간 불일치. |
| 항목 읽음이 채널 커서도 올림(양방향) | 한 항목이 앞 메시지 전체를 읽음 처리 — 현행 클라의 부작용. 거꾸로 mark-unread와 충돌. |
| 알림 테이블 일반화(reaction·이벤트 전부) | 범위가 커진다. v1은 사람이 「봐야 했던」 네 가지. 이모지 반응은 제외. |

## 업계 표준과 비교
- **Slack Activity**: Mentions·Threads·Reactions·Invitations를 항목 목록으로 두고 읽음/안 읽음 필터, 읽어도 남는다. 항목 단위 상태를 서버가 가진다 — 이 ADR의 `inbox_item`과 같은 모양이다. Slack은 반응·초대를 포함하지만 v1은 제외한다.
- **Buzz**: 「Mentions & reactions」 중심의 얇은 인박스. 인용 답이 멘션 축에 합쳐진다는 점이 ADR-0148 규칙 5와 같은 방향이다. 우리는 그것을 `reply_to_me`로 구분해 보여준다.
- 차이: oort는 에이전트가 동료이므로 에이전트의 인용 답이 가장 흔한 항목이다. 그래서 생산자 무관 트리거가 필수다.

## 영향·게이트 (구현 슬라이스 수용기준 뼈대)
1. 인용 답: Skip 경로(에이전트 최종 응답)로 만든 인용 답도 대상 작성자에게 `reply_to_me` 항목이 생김.
2. 읽은 멘션: 채널 커서를 지나간 뒤에도 항목이 남고 `read_at`이 채워져 있음.
3. 자동 읽음은 한 방향(커서→항목)이고, 항목 읽음이 `last_read_seq`를 바꾸지 않음.
4. RLS: 다른 워크스페이스 불가시, 같은 워크스페이스 다른 멤버 불가시. FORCE 확인.
5. 키셋 페이지네이션이 중복·누락 없이 끝까지 돈다. 삭제 메시지·접근 상실 채널 처리.
6. 한 메시지·한 수신자 한 행(`UNIQUE`), 자기 글·자기 인용 제외.
7. backfill 멱등. 마이그레이션은 `server/Migrations/126_*.sql`, `schema_v0.sql` 무접촉, 라이브 DB `query!` 금지(런타임 쿼리).
8. 실시간 이벤트가 단일 tx outbox 행으로만 나가고, 클라 직접 publish 없음.

## 구현 슬라이스 계획 (Accepted 이후 착수)
| 슬라이스 | 트랙 | 내용 | 선행 |
|---|---|---|---|
| E1 | 엔진 | `126_inbox_item.sql`(테이블·인덱스·RLS FORCE·message AFTER INSERT 트리거·커서→항목 자동 읽음), 사유 우선순위·제외 규칙 함수, 실DB 적합성 시험(수용기준 1·2·4·6), Skip 경로 인용 답 red proof | ADR Accepted |
| E2 | 엔진 | `GET /inbox`·`PUT /inbox/{id}/read`·`POST /inbox/read-all`, 키셋 페이지네이션, 접근 상실·삭제 가시성, outbox `inbox_item.*` 이벤트(수용기준 3·5·8), 90일 정리 작업 | E1 |
| E3 | UXUI | `mailbox.ts` 원천을 서버 응답으로 교체(현행 조합은 구 서버 후퇴 경로), 항목 읽음 UI(채널 커서 비연동 문구 정리), 개인 채널 이벤트 구독 | E2 |
| E4 | 엔진 | 90일 backfill 작업(멱등), 라이브 oort-team 스모크(`runtime-unverified` 해소) | E1 |
| 후속 | — | 배정 작업(task)·승인 영속화·안 읽음 되돌림·반응 항목 | 별 이슈 |
