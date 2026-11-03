# 게스트 접근 — oort 경계 감사 (코드 조사, #5187-B)

- 작성: 2026-11-02, 리서치 워커(읽기 전용). 대상은 `track/engine` 기준 `853f82de7`이다. 줄 번호는 모두 이 커밋의 워크트리 기준이며, 아래 「migration 173」만 예외다(§4).
- 목적: owner가 원하는 「초대받은 채널에서만 일하는 외부 사람(게스트)」을 넣으려면 코드의 어느 길이 이미 막혀 있고 어느 길이 비어 있는지 한 장에 모은다. 인터뷰 판정 원칙은 「경계는 엄격하게, 안에서는 Slack만큼」이다. ADR-0219 초안이 이 문서의 파일:줄을 그대로 인용할 수 있게 썼다.
- 방법: 코드와 migration을 읽기만 했다. 시험·서버·DB를 돌리지 않았다. 모든 행이 `runtime-unverified`다. 시험이 있다는 말은 레포에 그 동작을 단정하는 시험 파일이 있다는 뜻이며 이번에 실행하지 않았다.
- 공개 저장소 규칙에 따라 재현 절차는 적지 않는다. 「새면 안 되는 길인데 지금 분기가 없다」 수준까지만 적는다. 요청자는 owner로 적는다.
- 위험 등급: **높음** = 입구가 열려 있거나, 못 보는 채널의 본문·행동·권한이 닿을 수 있다. **중간** = 이름·사람 정보·존재·개수 같은 메타데이터가 닿거나, 게스트가 하면 안 되는 비용·승인 행동을 막는 규칙이 없다. **낮음** = 이미 막혀 있거나 워크스페이스 공통 자산이라 정책 결정만 남았다. 만료에 관한 행은 만료가 아직 없으므로 「(만료 도입 시)」를 붙인다.
- 확인 정도: **코드 확인** = 해당 줄을 직접 읽고 판정했다. **추정** = 이름·주석·호출 경로로 판정했고 핵심 줄 일부를 읽지 못했다.

## 경로 약어

| 약어 | 경로 |
|---|---|
| `SRV` | `server-rust/bins/momo-server/src` (라우트는 `SRV/routes/`) |
| `MSG` | `server-rust/crates/momo-messaging/src` |
| `SET` | `server-rust/crates/momo-settings/src` |
| `AGT` | `server-rust/crates/momo-agent/src` |
| `WSA` | `server-rust/crates/momo-workspace-actions/src` |
| `AUTH` | `server-rust/crates/momo-auth/src` |
| `PUSH` | `server-rust/crates/momo-push/src` |
| `T3` | `server-rust/crates/momo-t3/src` |
| `EXP` | `server-rust/crates/momo-expressions/src` |
| `WRK` | `server-rust/bins/momo-agent-worker` |
| `MIG` | `server/Migrations` |

## 1. 요약

**구현 현황.** `guest`는 이미 역할 라벨(`workspace_membership.role`, 채널 `membership.role`)과 일부 가드로 있다. 가드는 roster·사용량의 사람 좁히기(P-1, P-6), 팀 AI의 사람 목록·읽기 청중(A-2, A-3), 팀 기억 편집·수락 금지(A-12), 호스티드 에이전트 work 요청 금지(A-8의 한 곳), 앱 연결·클라우드 박스·개발자 토큰·표현 추가 금지(A-15, S-1, X-4)에 있다. 메시지·스레드·고정·검색·받은함·첨부·푸시·실시간은 이미 **채널 멤버십 행 하나**(`membership.left_at IS NULL`)로 열리므로 읽기 쪽은 게스트와 멤버가 같은 문장을 쓴다(ADR-0128 D1의 「쿼리 필터」 설계가 읽기에서는 맞다). 비어 있는 곳은 ① 입구(초대·역할 변경에 채널 범위가 없다) ② 멤버십 바깥에서 워크스페이스 전체를 읽는 길 ③ 만료다. 사람 요청에는 코어 표(member·channel·membership·message)의 RLS가 워크스페이스 경계 하나뿐이라 멤버십 조건이 쿼리마다 손으로 들어 있고, 한 곳만 빠져도 샌다(§2.4).

**가장 위험한 길 3개**
1. **입구가 「초대받은 채널만」이 아니다(높음: I-1·I-2).** 초대 수락은 역할이 guest여도 **모든 공개 채널에 가입**시킨다(`SET/join.rs:768-771`, `:1242-1285`). `invite_code`에는 채널 열이 없다(`MIG/003_onboarding.sql:43-78`). 역할 변경도 채널 멤버십을 건드리지 않고(I-3), 채널에 넣을 때 guest에게 채널 admin까지 줄 수 있다(I-4). 만료 열은 DB에 없다(`MIG/026:8-19`).
2. **게스트가 부른 AI의 문맥이 요청자에 묶이지 않는 곳이 있다(높음 A-8·A-10, 중간 A-1·A-7).** 팀 AI의 읽기 도구는 요청자 멤버십과 방 청중으로 잘 묶여 있지만(A-2), 시스템 프롬프트가 요청자와 무관하게 모든 공개 채널 **이름**을 싣는다(A-1, `WSA/team_ai.rs:599-640`). 호스티드 에이전트는 멘션 길에 게스트 판정이 없고(A-8) 도구 읽기가 「owner 승인 채널 ∩ 에이전트 멤버십」이라 이 run의 요청자와 연결이 없다(A-10, `SRV/routes/agent_port_tools.rs:824-870`).
3. **멤버십 밖에서 사람을 보여 주는 길(높음 D-1, 중간 P-3·P-4·P-5).** DM 열기는 상대가 활성 멤버이기만 하면 되고 게스트 분기가 없다(D-1, `SRV/routes/dms.rs:92-135`). 작업 호스트 목록(P-4)·팀 표현 목록(P-5)·아바타(P-3)는 roster 좁히기를 거치지 않고 사람 id·이름을 싣는다. 모두 중간 이상이다.

## 2. 현재 모델

### 2.1 역할과 멤버십

| 항목 | 저장·판정 | 근거 |
|---|---|---|
| 워크스페이스 역할 | `workspace_membership(workspace_id, member_id, role, …)`, 유일키 `(workspace_id, member_id)`. **만료·초대자·외부 표시 열이 없다.** | `MIG/026_workspace_membership_lifecycle.sql:8-22` |
| 역할 값 | `membership_role` = owner·admin·member·guest. 채널 `membership.role`·`invite_code.role`·`workspace_membership.role`이 **같은 ENUM**을 쓴다 | `schema_v0.sql:14`, `:122-133`, `MIG/003_onboarding.sql:48` |
| 단일 판정 함수 | `active_workspace_role`: `workspace_membership` JOIN `member`(active·미삭제). 정지·삭제는 행이 남아도 `None`. `FOR UPDATE` 변형이 있다 | `AUTH/workspace_authorization.rs:125-148`, `:153-177` |
| 관리자 사다리 | `can_manage_target`·`can_grant_role` 등. 관리자는 admin·owner를 못 만진다 | `AUTH/workspace_authorization.rs:50-117` |
| 채널 멤버 판정 | `is_channel_member`: `membership` 행 하나(`left_at IS NULL`). **`member.status`·`workspace_membership`을 보지 않는다.** 정지된 사람은 토큰 폐기로 막힌다 | `MSG/identity.rs:130-145` |
| 더 엄격한 변형 | 첨부·허들은 미보관 채널 + active 멤버까지 본다 | `MSG/attachment.rs:199-230`, `MSG/huddle.rs:335-358` |
| 멤버 상태 | `member_status` = active·invited·suspended·deleted | `schema_v0.sql:12` |
| 에이전트 | `member.kind='agent'`. 같은 멤버십 표를 쓴다. 역할 변경 대상이 아니다 | `SET/membership_lifecycle.rs:306-330` |

### 2.2 게스트가 만들어지는 길

| 길 | 동작 | 근거 |
|---|---|---|
| 초대 `role=guest` | 코드 수락 시 `workspace_membership`에 guest로 넣고, **모든 공개·미보관 채널**에 채널 role=guest 멤버십을 넣는다. 공개 채널이 없으면 409 | `SET/join.rs:768-771`, `:1217-1236`, `:1242-1285`, `:427` |
| 역할 변경 API | `PATCH /v1/workspaces/{ws}/members/{member}/role`. `workspace_membership.role`만 UPDATE. 채널 멤버십은 그대로 | `SRV/routes/member_lifecycle.rs:71-131`, `SET/membership_lifecycle.rs:306-365` |
| 026 백필 | 채널 role이 전부 guest인 사람만 워크스페이스 guest로 옮겼다(member가 하나라도 있으면 member) | `MIG/026_workspace_membership_lifecycle.sql:49-72` |
| 채널 멤버 추가 | 관리자가 채널 role을 요청값으로 넣는다(기본 member). 워크스페이스 guest를 role=member로 넣을 수 있다 | `SRV/routes/channels.rs:353-399`, `MSG/channel.rs:338` |

### 2.3 「guest」가 두 층이다

`workspace_membership.role='guest'`와 채널 `membership.role='guest'`가 따로 있고, 코드가 읽는 층이 제각각이다. ADR-0219가 하나를 골라야 한다(§6 Q1).

| 읽는 층 | 자리 |
|---|---|
| 워크스페이스 역할만 | roster 좁히기(`SRV/routes/roster.rs:216`), 사용량(`SRV/routes/usage.rs:170`), 팀 AI 사람 목록(`WSA/team_ai.rs:607-613`), 앱 연결·클라우드 박스·개인 에이전트·개인 키(A-15) |
| 둘 중 하나(OR) | 호스티드 work 요청 금지(`AGT/run.rs:1058-1078`), 팀 AI 방 청중(`WSA/team_ai_tools.rs:315`), 팀 기억 쓰기 금지(`MIG/105_mem_proposal.sql:364-372`, `MIG/106_mem_item_edit.sql:205-214`, `MIG/108_mem_consolidate.sql:663-679`) |

### 2.4 RLS는 워크스페이스 경계 하나다

- 코어 표(member·channel·membership·message·…)는 `ws_isolation` 한 정책이다. 채널 멤버십은 RLS가 아니라 **쿼리 술어**다. `MIG/001_init.sql:388-398`.
- 멤버십으로 RLS를 거는 예외 둘이 이미 있다. (a) 팀 기억 표: `app.member_id`와 `mem_can_read_channel`로 읽기를 가른다(`MIG/100_mem_digest.sql:124-137`, `:810-850`, `MIG/104_mem_item.sql:708-757`). (b) `message`의 **RESTRICTIVE SELECT** 정책 `dm_agent_read_boundary`: 요청자 GUC `app.agent_member_id`가 있을 때만 걸린다(`MIG/156_dm_agent_admission.sql:48-53`). 그 GUC는 `momo_db`가 모든 테넌트 tx 첫머리에 묶고(`server-rust/crates/momo-db/src/tenant.rs:33-45`) 값은 에이전트 요청에서만 들어온다(`SRV/auth.rs:734-736`, `:838-840`). 사람 요청에는 이런 요청자 GUC가 없다. 사람용 `app.member_id`는 팀 기억·예약·리마인더 라우트만 묶는다(`SRV/routes/memory.rs:76-95`, `MSG/lib.rs:79`).
- 읽기 길 모두가 지키는 한 줄은 `MIG/100_mem_digest.sql:4-25`의 주석에 정리돼 있다(`membership.left_at IS NULL`; REST 이력·에이전트 도구·검색). 이 감사는 그 주장을 현재 줄로 다시 확인했다(M-1~M-7, A-10).

## 3. 길 표

각 행 한 판정. 「필요한 것」은 필터(쿼리 술어)·RLS·거절(존재하지 않는 id와 같은 응답)·표시(외부 배지)·정책 결정 중 무엇인지 적는다.

### 3.1 입구·역할·멤버십

| ID | 길 | 코드 자리 | 지금 판정 | 게스트에게 필요한 것 | 위험 | 확인 |
|---|---|---|---|---|---|---|
| I-1 | 초대 만들기 | `SRV/routes/invites.rs:116-175`, 관리자 판정 `:416-424`, `SET/invite.rs:65-86`(역할 어휘 admin·member·guest), `:210-250`(INSERT에 채널·접근 기간 열 없음), `MIG/003_onboarding.sql:43-78` | 관리자만 만든다. guest 초대는 되지만 **채널 범위가 없다.** 초대 `expires_at`은 코드 사용 기한(기본 7일)이지 멤버 접근 기간이 아니다. `metadata jsonb`는 비어 있다. **AI가 대신 제안하는 길은 지금 guest에게 닫혀 있다**: 도우미 문의 정책 어휘 `TEAM_AI_INVITE_ROLES`는 member·guest이지만 제안 스키마 `INVITE_PROPOSABLE_ROLES`가 member·admin뿐이라 guest 초대 카드는 만들어지지 않는다(`AGT/actions.rs:455-471`, 시험 `:3490-3495`, `:4527-4532`, `WRK/tests/team_ai_invite_conformance_pg.rs:649-651`) | 초대가 채널 집합과 접근 기간을 가져야 한다(새 표, §4). guest 역할이면 채널 1개 이상 필수. 「누가 초대했나」를 남긴다. guest를 AI 제안 길에 열려면 `invite.create` 제안 스키마에도 채널 집합이 들어가야 하고 승인 카드(ADR-0186 D2)를 지난다 | 높음 | 코드 확인 |
| I-2 | 초대 수락(공개 가입) | `SET/join.rs:651-835`(단계 8 `:768-771`), `:1242-1285` | role이 guest여도 **모든 공개 채널**에 가입한다. 공개 채널이 없으면 `NoPublicChannels` 409(`:427`, `:771`). 가입은 같은 tx에서 세션까지 만든다 | guest 초대는 초대에 묶인 채널만. 공개 채널 자동 가입 제거. 「채널 0개면 거절」은 guest에서 의미가 바뀐다. 기존 계정이 게스트 코드를 쓰는 길도 같은 입구이므로 새 설계에서는 거절한다(Q15) | 높음 | 코드 확인 |
| I-2b | 로그인한 멤버의 초대 코드 사용 | `SET/invite.rs:512-585`, `SRV/routes/invites.rs:333-385` | 사용 횟수·기록만 올리고 멤버십·역할은 안 건드린다 | 기존 멤버가 게스트 코드를 쓰는 길은 혼동만 부르니 거절 | 낮음 | 코드 확인 |
| I-3 | 역할 변경 | `SRV/routes/member_lifecycle.rs:71-131`, `SET/membership_lifecycle.rs:306-365`(UPDATE `:343-352`) | `workspace_membership.role`만 바뀐다. member→guest 강등은 「지금 속한 채널 전부」가 남고, guest→member 승격은 채널 role=guest가 남는다 | 강등·승격 때 채널 멤버십 정리와 채널 role 동기화 규칙 | 중간 | 코드 확인 |
| I-4 | 채널 멤버 추가·제거 | `SRV/routes/channels.rs:353-399`, `:408-449`, `MSG/channel.rs:338-348`(채널 role 어휘 admin·member·guest), `:359-500` | 관리자만 넣고 뺀다. 채널 role은 요청값이라 워크스페이스 guest에게 채널 role=member는 물론 **admin도** 줄 수 있다 | 워크스페이스 guest의 채널 role은 guest로 고정(2층 일원화) | 중간 | 코드 확인 |
| I-4b | 채널 역할 변경 | `SRV/routes/member_lifecycle.rs:133-193`, `SET/membership_lifecycle.rs:367-475`(채널 admin 판정 `:415-428`) | 워크스페이스 관리자 **또는 그 채널의 admin**이 한다. 워크스페이스 guest가 채널 role=admin이면 채널 역할을 바꾸는 쪽이 된다(채널 admin은 채널 기억 설정에도 쓰인다, ADR-0196) | guest는 채널 admin이 될 수 없게 한다 | 중간 | 코드 확인 |
| I-5 | 채널 목록 | `SRV/routes/channels.rs:122-170`, `MSG/channel.rs:751-860`(JOIN `:829`) | 호출자의 live 멤버십만 JOIN으로 연다. 게스트와 멤버가 같은 문장 | 변경 없음. 시험으로 고정 | 낮음 | 코드 확인(시험 있음: `tests/sec07_roster_channels_join_pg.rs`) |
| I-6 | 공개 채널 둘러보기·스스로 참여 | `SRV/lib.rs:1035-1060`, `SRV/routes/channels.rs:353-399` | **없다.** 목록은 내 멤버십뿐, 추가는 관리자뿐이다 | 지금 게스트가 새 채널을 발견할 길이 없다. 둘러보기가 생기면 게스트 제외를 같은 PR에서 | 낮음 | 코드 확인 |
| I-7 | 채널 만들기·보관 | `SRV/routes/channels.rs:197-250` | 관리자만 | 변경 없음 | 낮음 | 코드 확인 |
| I-8 | 채널 나가기 | `SRV/lib.rs:1056`, `SRV/routes/member_lifecycle.rs:525-576` | 본인이 나간다. 마지막 채널을 나가면 채널 0개 상태가 된다 | 채널 0개 게스트의 화면(표시) | 낮음 | 코드 확인 |
| I-9 | 가입 환영(ADR-0181) | `SRV/routes/join.rs:62-72`, `:233-245`, `AGT/welcome.rs:160-245`(`resolve_welcome_target_in_tx`가 공개 `#general`을 고른다) | 새 사람(`createdMember:true`)이 생기면 가입 tx에서 환영 job을 넣고, 환영은 공개 채널 `#general`에서 한다 | 공개 채널 자동 가입이 사라지면 게스트는 `#general`에 없을 수 있다. 게스트는 환영을 생략하거나 초대받은 채널에서 한다 | 중간 | 코드 확인 |

### 3.2 메시지·검색·파일

| ID | 길 | 코드 자리 | 지금 판정 | 게스트에게 필요한 것 | 위험 | 확인 |
|---|---|---|---|---|---|---|
| M-1 | 이력 | `SRV/routes/messages.rs:1104-1170`(문 `:1125-1130`), `MSG/identity.rs:130-145` | 멤버십 행 하나. `member.status`·워크스페이스 역할은 안 본다 | 변경 없음. 만료는 토큰·세션 종료로(§5) | 낮음 | 코드 확인 |
| M-2 | 스레드 답글 | `SRV/routes/messages.rs:1028-1100`(`:1056-1063`) | 이력과 같은 문 | 변경 없음 | 낮음 | 코드 확인 |
| M-3 | 고정 목록·반응 스냅샷 | `SRV/routes/messages.rs:1851-1880`(`:1862`), `:1721-1750`(`:1733`) | 같은 문 | 변경 없음 | 낮음 | 코드 확인 |
| M-4 | 반응·고정·편집·삭제 | `SRV/routes/messages.rs:1651`, `:1792`, `:1295`, `:1568`, `MSG/interaction.rs:471` | 채널 멤버면 한다. 게스트 분기 없음 | 게스트의 쓰기 범위는 Slack UX 조사와 대조해 정책 결정 | 낮음 | 코드 확인 |
| M-5 | 보내기·예약 보내기 | `SRV/routes/messages.rs:639`, `SRV/routes/deliver.rs:249` | 작성자 live 멤버십만 | 변경 없음 | 낮음 | 코드 확인 |
| M-6 | 멘션 | `MSG/read_state.rs:620-700` | 후보는 **그 채널 멤버**로 한정. 채널 밖 사람 이름은 아무도 안 부른다 | 변경 없음 | 낮음 | 코드 확인 |
| M-7 | 메시지 검색 | `SRV/routes/search.rs:84-135`, `MSG/search.rs:291-326` | 호출자 membership JOIN + active. 채널 지정 검색은 비멤버 404 | 변경 없음 | 낮음 | 코드 확인(시험 있음) |
| M-8 | 첨부 올리기·완료·내용 읽기 | `SRV/routes/attachments.rs:141`, `:162`, `:225`, `:279`, `:377`, `MSG/attachment.rs:199-230` | 미보관 채널 + active 멤버 + live 멤버십 | 변경 없음 | 낮음 | 코드 확인 |

### 3.3 사람·프로필·워크스페이스 공통 조회

| ID | 길 | 코드 자리 | 지금 판정 | 게스트에게 필요한 것 | 위험 | 확인 |
|---|---|---|---|---|---|---|
| P-1 | roster·멤버 목록·멘션 후보 | `SRV/routes/roster.rs:191-280`(좁히기 `:216`, 에이전트 부가 가림 `:258-275`), `MSG/identity.rs:641-770`(`NOT $4 OR m.id=$2 OR 공유 채널` `:756-764`) | 게스트는 **공유 채널이 있는 사람만** 본다. 채널 수·채널 id도 같이 좁힌다. 좁히기는 **워크스페이스 role만** 읽는다. 보이는 사람의 **이메일·시간대는 그대로** 실린다(`roster.rs:115-116`) | 이미 막힘. ① 판정 층 일원화(Q1) ② 게스트에게 이메일·시간대를 보일지(Q4) | 중간 | 코드 확인(시험 있음) |
| P-2 | 온라인 점 | `SRV/routes/roster.rs:152-189`, `SRV/routes/realtime.rs:416-418` | roster가 돌려준 행만 조회한다. 좁히기가 가용성도 좁힌다 | 변경 없음 | 낮음 | 코드 확인(시험 있음) |
| P-3 | 아바타 | `SRV/routes/member_avatar.rs:474-531` | 「any active workspace member」가 **아무 member id**의 아바타를 읽는다. 공유 채널·역할을 안 본다. 있음/없음이 응답으로 갈린다 | 게스트는 roster에 보이는 사람만, 그 외는 같은 404 | 중간 | 코드 확인 |
| P-4 | 작업 호스트 목록 | `SRV/routes/work_hosts.rs:612-640`, `:653-663`, `:690-740` | 활성 멤버(게스트 포함)가 워크스페이스의 모든 호스트를 본다. 남의 개인 호스트도 소유자 id·표시 이름(「○○의 맥」)·online이 남는다 | 게스트에게는 목록을 비우거나 roster에 보이는 사람의 호스트만 | 중간 | 코드 확인 |
| P-5 | 팀 표현 목록 | `EXP/store.rs:583-596`, `:309-322`, `SRV/routes/expressions.rs:136-147` | 활성 멤버 누구나 전체 카탈로그. 항목이 `createdBy`·`subjectMemberId`(얼굴 표현이 가리키는 사람)·`origin.sourceAttachmentId`(generated 항목만)를 싣는다 | 게스트 응답에서 사람 id·원본 첨부 id 제거, 또는 목록 정책(Q5) | 중간 | 코드 확인(필드 직렬화), 화면 노출은 미확인 |
| P-6 | 사용량·통계 | `SRV/routes/usage.rs:164-190` | 게스트는 roster 좁히기가 고른 에이전트만, 예산은 숨긴다 | 변경 없음. 비용을 게스트에게 보일지(Q5) | 낮음 | 코드 확인 |
| P-7 | 진행 중 작업의 합계 | `SRV/routes/agent_runs.rs:1013-1018`(주석), `:1025-` | `agents[].activeTotal`은 워크스페이스 전체 비종료 run 수 한 숫자(의도된 합계 노출). 다른 방 run의 이름은 없다 | 게스트 응답에서 합계 제거 | 낮음 | 코드 확인 |
| P-8 | 에이전트 생존 | `SRV/routes/hosted_agent_connections.rs:621-657` | 공유 채널이 있는 사람만, 아니면 404 | 변경 없음 | 낮음 | 코드 확인 |
| P-9 | 프로필·상태 | `SRV/routes/self_profile.rs:1-25`(`PATCH …/members/me`만), `SRV/routes/presence.rs:128-160`, `SRV/lib.rs:1066-1067`, `:1109-1160` | **멤버별 프로필 조회 라우트가 없다.** 프로필 = roster 행(P-1) + 아바타(P-3). 쓰기·상태는 본인 것만 | 변경 없음 | 낮음 | 코드 확인 |
| P-10 | 워크스페이스 이름·설정 | `SRV/routes/workspaces.rs:86-125`, `SRV/routes/workspace_settings.rs:118-160` | 이름은 활성 멤버, 설정은 운영자만 | 변경 없음 | 낮음 | 코드 확인 |

### 3.4 DM

| ID | 길 | 코드 자리 | 지금 판정 | 게스트에게 필요한 것 | 위험 | 확인 |
|---|---|---|---|---|---|---|
| D-1 | DM 열기 | `SRV/routes/dms.rs:92-135`(역할 검사 `:109-113`), `MSG/dm.rs:180-200` | **게스트 분기가 없다.** 상대가 워크스페이스 활성 멤버이기만 하면 열린다. 상대 존재 여부가 응답으로 갈린다(확인 필요) | 게스트는 roster에 보이는(공유 채널) 사람에게만. 그 외는 존재하지 않는 id와 같은 응답 | 높음 | 코드 확인 |
| D-2 | DM 목록 | `SRV/routes/dms.rs:62-90`, `MSG/dm.rs:389-` | 본인 DM만 | 변경 없음 | 낮음 | 코드 확인 |
| D-3 | 그룹 DM 만들기 | `SRV/lib.rs:1529-1531` | **전용 API가 없다.** 3인 이상은 ADR-0217 에이전트 합류로만 생긴다 | 변경 없음 | 낮음 | 코드 확인 |
| D-4 | 에이전트 DM 합류 제안 | `SRV/routes/dm_agents.rs:39-90`, 후보 `AGT/mention.rs:186-262`(워크스페이스 전체 에이전트가 후보), `SRV/routes/agent_mentions.rs:2091` | 사람 참여자면 게스트도 `@에이전트`로 합류 카드를 제안할 수 있다. 후보가 roster 좁히기 밖이다 | 게스트가 부를 수 있는 에이전트 = roster에 보이는 것만. 합류 카드 문구가 이름을 싣는지 확인 | 중간 | 추정(후보 SQL 확인, 카드 문구 미확인) |

### 3.5 AI 도우미·에이전트

| ID | 길 | 코드 자리 | 지금 판정 | 게스트에게 필요한 것 | 위험 | 확인 |
|---|---|---|---|---|---|---|
| A-1 | 팀 AI 시스템 프롬프트의 채널 이름 | `WSA/team_ai.rs:599-640`(게스트 판정 `:607-613`, 채널 질의 `:629-640`), 프롬프트에 싣는 자리 `:838-841`, `:1015-1017` | 사람 목록은 게스트에게 비운다. **채널 이름은 모든 미보관 공개 채널 + 지금 채널을 요청자와 무관하게 시스템 프롬프트의 「채널」 목록에 싣는다.** 시험은 사설 이름·사람 목록만 단정한다(`WRK/tests/team_ai_conformance_pg.rs:1181-1245`) | 게스트 요청자에게는 지금 채널과 요청자가 속한 채널 이름만 | 중간 | 코드 확인 |
| A-2 | 팀 AI 읽기 도구의 청중 | `WSA/team_ai_tools.rs:283-330`(방에 게스트가 있으면 그 방 채널만 `:315`), `:537-566`(`resolve_channel`), `:236`(`momo_helper_read` NOBYPASSRLS) | 도구는 **요청한 사람**의 멤버십으로 읽고, 비멤버는 「없음」과 같은 답이다. 방에 게스트가 하나라도 있으면 청중이 그 방 하나다 | 이미 막힘 | 낮음 | 코드 확인(시험 있음: `WRK/tests/team_ai_tools_conformance_pg.rs` A8) |
| A-3 | 팀 AI 사람 목록 | `WSA/team_ai_tools.rs:881-935` | 게스트 방이면 그 채널 멤버만, 아니면 roster 좁히기 | 이미 막힘 | 낮음 | 코드 확인 |
| A-4 | 팀 AI 앱 목록 | `WSA/team_ai_tools.rs:1181-1230` | 역할 검사 없이 설치 상태·요청자 연결을 돌려준다 | 정책(Q5) | 낮음 | 코드 확인 |
| A-5 | 팀 AI 설정 읽기 | `WSA/team_ai_tools.rs:1238-1262` | 관리자만(`NotAllowed`) | 이미 막힘 | 낮음 | 코드 확인 |
| A-6 | 팀 AI 첨부 읽기 | `WSA/team_ai_attachments.rs:12-24`, `:160-240` | 요청자 본인 파일 + 지금 대화만 | 이미 막힘 | 낮음 | 코드 확인 |
| A-7 | 팀 AI 제안 카드의 이름 해석 | `WSA/action_resolve.rs:2143-2176`(공개 채널 이름·멤버 수, 「proposer's point of view」), `:2179-`(활성 멤버 전체), `WRK/src`에 역할 검사 없음 | 게스트 요청이어도 제안이 공개 채널·멤버 이름으로 풀린다. 풀리는 시점은 **제안한 에이전트의 것**이지 요청자의 것이 아니다. 팀 AI뿐 아니라 관리 에이전트의 `workspace_action_propose`(`AGT/tools.rs:239-246`)도 같은 해석 함수를 쓸 것으로 보인다. 승인은 관리자 몫이지만 풀린 이름이 카드에 실려 방에 올라갈 수 있다 | 게스트 요청은 요청자 시점(보이는 채널·사람)으로 풀거나 제안 자체를 거절 | 중간 | 추정(해석 함수 확인, 카드 문구 미확인) |
| A-8 | 에이전트 멘션 전달 | `SRV/routes/agent_mentions.rs:746-806`(`delivery_gate`), `AGT/run.rs:1058-1078`, `SRV/routes/agent_runs.rs:311-324` | **멘션 길에 게스트 판정이 없다.** `is_guest_in_channel_in_tx`는 `POST …/channels/{ch}/agent-runs`(`agent_runs::create`, `SRV/routes/agent_runs.rs:137-`) 한 곳에서만 쓴다. 게스트가 부른 호스티드 에이전트도 owner-only·승인 채널 규칙만 통과하면 전달된다 | 게스트가 부른 호스티드·벤더 한도 에이전트는 거절 또는 owner 사전 허락. 요청자 role을 run에 남겨 도구 범위에 쓴다 | 높음 | 코드 확인 |
| A-9 | 관리 에이전트의 실행 문맥 | `MSG/message.rs:2195-2290`, `AGT/tools.rs:239-246`(CATALOG) | 트리거 채널(스레드 우선) 최근 창만 읽는다. 관리 에이전트 도구에 채널 읽기가 없다 | 변경 없음. 이 성질을 시험으로 고정 | 낮음 | 코드 확인 |
| A-10 | 호스티드 에이전트 도구(Agent Port) | `SRV/routes/agent_port_tools.rs:824-870`(문 `:832-835`), `:994`, 머리말 `:1-60` | 읽기 범위는 「owner 승인 채널 ∩ **에이전트 자신의 멤버십**」이다. 이 run의 요청자와 연결이 없어, 게스트 방에서 불린 에이전트가 다른 승인 채널을 읽어 그 방에 답할 수 있는 구조다 | 게스트가 요청한 run은 도구 읽기를 트리거 채널로 제한(job에 요청자·방을 싣고 도구가 대조) | 높음 | 코드 확인 |
| A-11 | 팀 기억 읽기·서빙 | `MIG/100_mem_digest.sql:810-850`, `MIG/104_mem_item.sql:708-757`, ADR-0196 D6-4 | 읽기는 채널 읽기 RLS. 에이전트 답은 「근거 채널 = 답 채널」로 좁힌다. 게스트도 읽는다 | 이미 막힘. 게스트 읽기 허용 여부(Q3) | 낮음 | 코드 확인 |
| A-12 | 팀 기억 쓰기 | `SRV/routes/memory.rs:873-880`, `MIG/105_mem_proposal.sql:364-372`, `MIG/106_mem_item_edit.sql:205-214`, `MIG/108_mem_consolidate.sql:663-679` | 게스트는 수락·편집·잊기 불가(DB 42501). 게스트 글을 근거로 한 항목은 자동 병합·닫기 금지 | 이미 막힘 | 낮음 | 코드 확인(시험 있음) |
| A-13 | 에이전트 run 목록·원장 | `AGT/run.rs:717-760`(membership JOIN), `:786-`, `AGT/run_progress.rs:779-`, `SRV/routes/agent_runs.rs:1025-` | 보는 사람의 채널 멤버십 JOIN. 다른 방 run은 개수만(P-7) | 이미 막힘 | 낮음 | 코드 확인 |
| A-14 | 승인 카드 결정 | `AGT/decider.rs:130-143`, `PUSH/approvers.rs:145` | 툴 호출·spawn 승인은 **활성 사람 채널 멤버 누구나**(게스트 포함)가 결정한다. workspace action만 역할 조건이 붙고, 표현 추가만 게스트를 뺀다 | 게스트의 승인 권한(최소한 spawn·end는 비게스트만) | 중간 | 코드 확인 |
| A-15 | 에이전트·개인 키·클라우드 박스·앱 연결 | `SRV/routes/personal_agents.rs:89-100`, `SRV/routes/personal_links.rs:426-432`, `SRV/routes/cloud_boxes.rs:134-175`, `SRV/plugin_writes.rs:315-345` | 게스트 거절 | 이미 막힘 | 낮음 | 코드 확인 |
| A-16 | 작업 spawn | `SRV/routes/work_spawns.rs:488-495` | 채널 멤버 + 본인 기기 서명. 게스트 분기 없음 | 게스트가 자기 기기 작업을 방에 올리는 것을 허용할지(Q3) | 낮음 | 코드 확인 |

### 3.6 받은함·알림·예약

| ID | 길 | 코드 자리 | 지금 판정 | 게스트에게 필요한 것 | 위험 | 확인 |
|---|---|---|---|---|---|---|
| N-1 | 받은함 | `MSG/inbox.rs:20-30`, `:211-220` | 읽을 때마다 membership JOIN으로 다시 도출한다. 떠난 채널 항목은 사라진다 | 변경 없음 | 낮음 | 코드 확인 |
| N-2 | 푸시 대상 | `PUSH/judgment.rs:600-640` | 수신자는 채널 live 멤버 + active 사람 | 변경 없음 | 낮음 | 코드 확인 |
| N-2b | 푸시 페이로드 | `PUSH/dispatch.rs:1-30`(ID뿐인 닫힌 필드 집합), 같은 파일의 시험 `dispatch_payload_is_id_only`(`:464`)·`dispatch_payload_has_no_content_shaped_key`(`:474`) | 본문·보낸 사람 이름·채널 이름·승인 요약이 알림에 실리지 않는다. 알림을 받은 앱이 자기 서버에서 내용을 가져오고, 그 호출은 이력과 같은 멤버십 문을 지난다 | 변경 없음 | 낮음 | 코드 확인 |
| N-3 | 승인 푸시 대상 | `PUSH/approvers.rs:130-146` | A-14와 같은 판정을 따른다 | A-14에 따름 | 중간 | 코드 확인 |
| N-4 | 푸시 가져오기 토큰 | `SRV/routes/push_fetch.rs:1-25` | 세션 계보에 묶여 세션이 끝나면 죽는다 | 변경 없음 | 낮음 | 코드 확인 |
| N-5 | 예약 메시지 | `SRV/scheduler.rs:1-60`, `MSG/scheduled.rs:1262-1360`, `SRV/session_end.rs:100-117` | 보낼 때 정상 보내기 길(`deliver.rs:249`)을 다시 탄다. 세션이 끝나면 보류(hold), 제거·탈퇴면 취소 | 만료도 같은 보류(§5) | 낮음 | 코드 확인 |
| N-6 | 알림 규칙·진단·읽음 위치 | `SRV/routes/notification_diagnostics.rs:120`, `SRV/routes/read_state.rs:73-100`, `MSG/read_state.rs:296-335`(membership JOIN) | 본인 것 + 채널 멤버 확인. 읽음 투영도 내 멤버십 채널만 | 변경 없음 | 낮음 | 코드 확인 |

### 3.7 링크·표현·작업·앱

| ID | 길 | 코드 자리 | 지금 판정 | 게스트에게 필요한 것 | 위험 | 확인 |
|---|---|---|---|---|---|---|
| X-1 | 링크 미리보기(외부 URL) | `SRV/routes/unfurl.rs:1-20`, `:150-165`, `:230-245`, `:440-470` | 채널 멤버만 카드·이미지를 읽는다 | 변경 없음 | 낮음 | 코드 확인 |
| X-2 | 내부 메시지·채널 링크 펼치기 | `clients/web/src/features/timeline/MessageRow.tsx:484-491`, ADR-0194 D2 | **서버에 없다.** 복사되는 링크는 클라 해시 경로(`#/c/{ch}?msg=…`)이고 열면 이력 호출이 멤버십으로 거절한다 | 펼치기가 생기면 「링크는 id만, 카드는 보는 사람마다 조회」(ADR-0194)로 | 낮음 | 코드 확인(없음). 열었을 때 응답은 미실행 |
| X-3 | 작업 링크·팀 보드·세션 목록 | `SRV/routes/work_board.rs:1-40`, `T3/lifecycle.rs:905-945` | 보는 사람의 채널 멤버십 SQL. 못 보면 같은 404 | 변경 없음 | 낮음 | 코드 확인 |
| X-4 | 팀 표현 추가·승인 | `EXP/store.rs:34-44`(`adder_allows`: guest 제외) | 게스트 거절 | 이미 막힘 | 낮음 | 코드 확인 |
| X-5 | 팀 표현 실시간 | `SRV/routes/realtime.rs:419-423`, `EXP/store.rs:520-535` | 활성 멤버 누구나 구독. 내용은 버전 번호뿐 | 변경 없음 | 낮음 | 코드 확인 |
| X-6 | 플러그인 목록·상세 | `SRV/routes/plugins.rs:350-383` | 활성 멤버 누구나(설치 상태 + 본인 정책) | 정책(Q5) | 낮음 | 코드 확인 |
| X-7 | GitHub 앱 | `SRV/routes/github_ingress.rs:1048-1100` | 개요·구독 관리는 관리자. 이벤트는 구독 채널의 멤버 길로 간다 | 변경 없음 | 낮음 | 코드 확인 |
| X-8 | 허들 | `MSG/huddle.rs:335-358` | 채널 멤버(active, 미보관) | 변경 없음 | 낮음 | 코드 확인 |
| X-9 | 웹훅·이벤트 구독 관리 | `SRV/lib.rs:2134-2150` | 관리자 라우트로 보인다 | 변경 없음 | 낮음 | 추정(핸들러 미확인) |

### 3.8 실시간·프레즌스

| ID | 길 | 코드 자리 | 지금 판정 | 게스트에게 필요한 것 | 위험 | 확인 |
|---|---|---|---|---|---|---|
| R-1 | `ch:`·`typing:`·`presence:` 구독 | `SRV/routes/realtime.rs:260-330`(파서), `:389-400`(자격 행 + live 멤버십), `infra/centrifugo.json`(프록시) | 구독할 때마다 자격 행과 멤버십을 다시 본다 | 변경 없음 | 낮음 | 코드 확인 |
| R-2 | 이미 열린 구독 | `AUTH/ephemeral_grant.rs:26-34`, `SRV/routes/realtime.rs:150-165`, `AUTH/realtime.rs:47`, `:129-140` | **서버가 구독을 끊는 호출이 없다**(`ephemeral_grant.rs`가 스스로 적는다). 구독 판정은 구독하는 순간에만 한다. 연결 토큰은 `min(300초, 자격 남은 시간)`이라, 채널에서 빠지거나 정지돼도 이미 열린 구독은 그 연결 토큰이 끝날 때까지(최대 5분) 받을 수 있다 | 제거·정지 뒤 이 지연이 허용 범위인지 결정. 만료는 접근 토큰을 자르면 연결 토큰도 따라 잘린다(E-5·E-7) | 중간 | 코드 확인(지연 길이). 연결 토큰이 끝나면 Centrifugo가 연결을 닫는다는 동작은 코드 밖이라 확인 못 함 |
| R-3 | `agent:`·`agentwork:` 구독 | `SRV/routes/realtime.rs:399-411`, `MSG/identity.rs:162-` | 관찰자·에이전트 둘 다 그 채널 live 멤버 / 에이전트 본인만 | 변경 없음 | 낮음 | 코드 확인 |
| R-4 | `online:` 점호 | `SRV/routes/realtime.rs:416-418`, `MSG/identity.rs:249-271`, `infra/centrifugo.json`(`online`) | 게스트도 점호에 들어간다. 명단을 읽는 쪽은 서버뿐이라 게스트가 못 읽는다 | 변경 없음 | 낮음 | 코드 확인 |
| R-5 | `dm:` 네임스페이스 | `infra/centrifugo.json`(프록시·정규식 없음), `MSG/message.rs:459-470` | 서버는 DM도 `ch:`로 낸다. `dm:`은 안 쓴다. 클라이언트가 `dm:`으로 구독할 수 있는지는 Centrifugo의 기본 거부에 기댄다 | 쓰지 않으면 네임스페이스를 지운다 | 낮음 | 추정 |
| R-6 | 작성 중·가용성 발행 | `SRV/routes/ephemeral.rs:150-260` | 채널 멤버 증명(60초 grant) | 변경 없음 | 낮음 | 코드 확인 |
| R-7 | 선언 상태 방송 | `MSG/presence.rs:21-31`, `:530-570` | 내 현재 채널들에만 보낸다 | 변경 없음 | 낮음 | 코드 확인 |

### 3.9 설정·CLI·로그인·세션

| ID | 길 | 코드 자리 | 지금 판정 | 게스트에게 필요한 것 | 위험 | 확인 |
|---|---|---|---|---|---|---|
| S-1 | 개발자 토큰·CLI | `SRV/routes/dev_access.rs:114`(고정 정책 = 관리자만), `SRV/routes/dev_login_oauth.rs:571-573` | 게스트·멤버 거절(시험 `tests/dev_login_oauth_conformance_pg.rs:2949-2990`) | 변경 없음 | 낮음 | 코드 확인 |
| S-2 | 로그인 | `SRV/routes/auth_routes.rs:345-405` | 정지는 403. 만료는 안 본다 | 로그인에서 만료 거절, 세션 만료를 접근 기간 이하로 자르기 | 높음(만료 도입 시) | 코드 확인 |
| S-3 | 세션 갱신 | `SRV/routes/auth_routes.rs:472-`(`:589-592`), `:1039`, `:1237` | member가 active가 아니면 거절. 만료 판정을 넣기 좋은 자리 | 만료 이후 갱신 거절 | 높음(만료 도입 시) | 코드 확인 |
| S-4 | 요청마다 인증 | `SRV/auth.rs:684-860`(토큰 행만 본다) | member·워크스페이스 상태를 안 본다. 정지는 토큰 폐기로 막는다 | 접근 토큰 `exp`를 `min(15분, 접근 만료)`로 | 높음(만료 도입 시) | 코드 확인 |
| S-5 | 세션 발급·기록 | `SRV/routes/auth_routes.rs:255-297`, `AUTH/issue.rs:23-25`, `:99-130` | 접근 15분·갱신 30일 | 게스트는 만료 시각으로 잘라 발급 | 높음(만료 도입 시) | 코드 확인 |
| S-6 | 패스키 로그인(ADR-0195) | `docs/adr/0195-passkey-login.md` | **서버 코드가 없다**(`passkey`·`webauthn` 검색 0건) | 도입할 때 같은 상태·만료 검사 | 낮음 | 코드 확인(없음) |

### 3.10 없는 것을 없다고 적는다

| ID | 항목 | 결과 | 근거 |
|---|---|---|---|
| Z-1 | 저장·북마크 | 서버에 없다(`bookmark`·`saved_item` 기능 0건). 리마인더만 있고 본인 행에 id·시각·메모뿐 | `MSG/reminder.rs:130-230`(본문을 싣지 않는다) |
| Z-2 | 사용자 그룹 | 없다 | 코드 검색 0건 |
| Z-3 | `@channel`·`@here` 방송 멘션 | 없다. 별칭으로 만드는 것도 금지다 | `MSG/name_guard.rs:89-90` |
| Z-4 | 파일 검색·사람 검색 API | 없다. 검색은 메시지 하나뿐이다 | `SRV/lib.rs:1565` |
| Z-5 | Context Packet(요청자 기준 문맥 조립) | 명세만 있고 멘션 길에 옮기지 않았다. 문맥 경계는 코드 규칙(A-9, A-10)이 대신한다 | `SRV/routes/agent_mentions.rs:85-88`, `research/11-agent-runtime/04-context-packet-v0.md:1-30` |
| Z-6 | 내부 링크 펼치기 | 서버에 없다 | X-2 |
| Z-7 | 공개 채널 둘러보기 | 없다 | I-6 |
| Z-8 | 패스키 | 서버 코드 없다 | S-6 |
| Z-9 | 만료·외부 표시 열 | DB에 없다 | `MIG/026:8-19` |

## 4. 새 테넌트 테이블이 필요할 때 따를 본보기

게스트에 새 표가 들 가능성이 큰 곳은 ① 초대가 가진 채널 집합(`invite_code_channel`) ② 게스트 접근 기간·초대자(`workspace_membership` 열 추가로 충분할 수도 있다) ③ 만료 감시 기록이다.

**migration 173 출처 주의.** `attachment_media`를 만드는 173은 **`track/engine`(`853f82de7`)에 아직 없다.** 열린 작업 브랜치 `origin/feat/4673-engine-c5`(`25e7ec74a`)에만 있어서 아래 줄은 `git show origin/feat/4673-engine-c5:server/Migrations/173_attachment_media.sql` 기준이다. 착륙 전에는 줄이 바뀔 수 있다. 같은 방식이 이미 base에 있는 본보기는 160·026·003이다.

| 요소 | 173 (브랜치) | base의 같은 방식 |
|---|---|---|
| 복합 FK로 같은 워크스페이스만 가리키기 + `ON DELETE CASCADE` | `:43-66`, FK `:55-56` (RLS의 `WITH CHECK`는 `workspace_id` 열만 보므로 FK가 지켜 준다는 설명 `:19-21`) | `MIG/160_self_media_token.sql:41-52`, `MIG/158_workspace_expressions.sql:35-40` |
| RLS FORCE + `ws_isolation`(USING·WITH CHECK 둘 다 `app.workspace_id`) | `:76-81` | `MIG/160:79-81`, `MIG/026:123-140`(`IF NOT EXISTS`로 멱등), `MIG/003_onboarding.sql`(invite 표 RLS 루프) |
| 표 권한을 역할별 최소로 거두기(BYPASSRLS 역할은 RLS를 건너뛰므로 표 권한이 마지막 문) | `:27-38`, 잠금 블록 `:83-136` | `MIG/160_self_media_token.sql:85-125`의 같은 블록. 같은 글자가 `infra/rust/sql/bootstrap_roles.sql`·`bootstrap_runtime_roles.sql`에도 있어야 한다(`173:37-38`) |
| 복합 FK 대상(유일 제약)이 이미 있는 표 | — | `member(workspace_id,id)` `MIG/003:40-41`, `invite_code(workspace_id,id)` `MIG/003:80-81`, `channel(workspace_id,id)` `MIG/027_memory_plane.sql:13-14`, `attachment(workspace_id,id)` `MIG/046_huddle_transcription.sql:9-10` |
| 새 테넌트 표가 RLS FORCE를 빠뜨리면 잡는 게이트 | — | `server-rust/crates/momo-db/tests/conformance_pg.rs:145-160`와 `tenant_catalog_pg.rs`가 `tests/common/mod.rs:195-215`의 카탈로그 검사로 `workspace_id` 열이 있는 모든 표의 RLS+FORCE+정책을 단정한다. `scripts/verify_rls.sh:133-148`은 고정된 표 일곱 개만 본다 |
| 교차 테넌트 id만 돌려주는 정의자 함수(감시기용) | — | `MIG/145_scheduled_message.sql:162-217`, 호출 `MSG/scheduled.rs:1149-1168` |

초대의 채널 집합 표는 `(workspace_id, invite_code_id)` → `invite_code(workspace_id,id)`, `(workspace_id, channel_id)` → `channel(workspace_id,id)` 두 복합 FK로 같은 워크스페이스 안의 채널만 가리키게 하고, 채널이 지워지면 CASCADE로 같이 사라지게 하는 것이 위 본보기를 그대로 따른 모양이다.

## 5. 만료 처리에 필요한 것

지금 접근을 끊는 장치는 **「정지·제거」뿐**이고 시간 기반은 없다. 정지·제거는 관리자가 한 번 누르는 tx로 끝난다. 만료는 같은 결과를 시계가 내야 하므로 아래 부품이 필요하다.

| # | 항목 | 지금 | 필요한 것 | 근거 |
|---|---|---|---|---|
| E-1 | 만료 시각 저장 | 열이 없다 | `workspace_membership.expires_at timestamptz NULL`(+ 초대에 접근 기간). 새 migration, `schema_v0.sql`은 불변. RLS는 이미 FORCE라 열 추가에 정책 변경이 없다 | `MIG/026:8-22`, `:123-140` |
| E-2 | 비활성화 본체(정지와 같은 결과) | 관리자 actor가 필요한 함수 | 재사용할 부품: 상태 전이 + 토큰 폐기(`SET/membership_lifecycle.rs:476-523`, `SET/workspace.rs:442-470`), 모든 세션 종료(푸시 등록·기기 키 폐기·예약 보류 `SRV/session_end.rs:100-117`), 진행 중 run 취소(`SRV/routes/agent_runs.rs:1648-`), 감사. 상태 전이 함수가 관리자 actor를 요구하므로(`SET/membership_lifecycle.rs:476-500`) **시스템 행위자 변형**이 새로 필요하다. 감사 행위자 칸은 nullable이라(`MIG/001_init.sql:364`, `server-rust/crates/momo-db/src/audit.rs:16`, `:87-90`) 시스템 이벤트를 적을 수 있다 | `SRV/routes/member_lifecycle.rs:226-299` |
| E-3 | 만료 상태 선택 | 정지(`suspended`)와 삭제(`deleted`)만 있다 | 만료 = 정지(연장하면 복구)인지 삭제인지 결정. 새 상태값은 ENUM 변경이라 별도 migration | `schema_v0.sql:12`, Q2 |
| E-4 | 만료 감시기 | 예약 메시지가 쓰는 틱이 선례 | api 프로세스의 틱(`momo_app`, NOBYPASSRLS) + 교차 테넌트 **id만** 돌려주는 정의자 함수(`expired_guests`) → 행마다 테넌트 tx에서 `lock_membership_mutation`(`SET/workspace.rs:347-356`)을 잡고 다시 확인한 뒤 E-2를 실행. BYPASSRLS 금지(AGENTS.md)를 지킨다 | `SRV/scheduler.rs:1-60`, `MIG/145:162-217` |
| E-5 | 틱 사이의 구멍 | 정지는 토큰 폐기에만 기댄다 | ① 접근 토큰 `exp`를 발급 때 `min(15분, 접근 만료)`로 자른다(`AUTH/issue.rs:99-130`, 세션 기록 `SRV/routes/auth_routes.rs:255-297`). 갱신도 같다. 실시간 연결 토큰은 이미 접근 토큰 행의 남은 수명에 묶이므로(`SRV/routes/realtime.rs:150-165`) 따라온다. ② `active_workspace_role`(`AUTH/workspace_authorization.rs:125-177`)에 만료 술어 한 줄 — 호출하는 라우트(DM 열기·roster·채널 생성 등)는 즉시 닫힌다. 그러나 이력·보내기는 `is_channel_member`만 보므로(`MSG/identity.rs:130-145`) ②만으로는 닫히지 않는다. ③ 그래서 ①과 감시기가 함께 필요하다 | `SRV/auth.rs:684-860` |
| E-6 | 로그인·갱신·복구 문 | 정지만 거절 | 로그인 거절(`auth_routes.rs:345-405`), 갱신 거절(`:589-592`), 복구·재발급(`:1039`, `:1237`)에 같은 검사. 패스키가 도입되면 같은 검사(S-6) | `SRV/routes/auth_routes.rs` |
| E-7 | 실시간 | 서버가 끊는 호출이 없다. 구독은 구독하는 순간에만 재확인한다 | 정지·채널 제거 뒤에는 열린 구독이 연결 토큰 수명(≤5분)만큼 받는다. **만료는** E-5①로 접근 토큰 `exp`를 만료 시각으로 자르면 연결 토큰도 `min(…, 남은 시간)`이라 만료 시각을 넘기지 않으므로 이 꼬리가 생기지 않는다(연결 토큰이 끝나면 연결이 닫힌다는 Centrifugo 동작은 코드 밖이라 확인 못 함). 정지·제거의 5분도 못 받아들이면: 게스트 연결 토큰 TTL 단축 또는 Centrifugo 서버 API로 끊기를 새로 도입 | `AUTH/ephemeral_grant.rs:26-34`, `SRV/routes/realtime.rs:150-165`, `:389-400`, `AUTH/realtime.rs:129-140` |
| E-8 | 예약 메시지 | 세션 종료는 보류, 제거는 취소 | 만료는 **보류**로 두고(연장되면 되살릴 수 있다), 영구 제거로 바뀔 때 취소 | `MSG/scheduled.rs:1262-1360`, `SRV/session_end.rs:100-117` |
| E-9 | 에이전트 실행 | 정지·제거가 run을 취소한다 | 만료도 같은 취소. 대기 승인·카드는 같은 함수가 정리한다(ADR-0217 표). 게스트가 요청한 **호스티드 run**은 요청자가 run에 남는지 확인이 필요하다 | `SRV/routes/agent_runs.rs:1648-`, A-8, A-10 |
| E-10 | 게스트가 만든 장기 자격 | 개인 에이전트·개인 키·클라우드 박스·개발자 토큰은 게스트가 못 만든다 | 이 불변식을 시험으로 고정하면 만료 때 따로 지울 자격이 없다 | A-15, S-1 |
| E-11 | 기간 연장·알림 | 없다 | 연장 API(누가 연장하나, Q12), 만료 N일 전 알림(선택), 감사 `member.guest_expired` | `SET/membership_lifecycle.rs:306-365`(관리자 사다리) |

## 6. 열린 질문 (코드만으로 못 정하는 것)

| # | 질문 | 왜 코드로 못 정하나 | 관련 행 |
|---|---|---|---|
| Q1 | 「guest」를 어느 층으로 판정하나(워크스페이스 role / 채널 role / 둘 중 하나) | 코드가 층마다 다르게 읽는다(§2.3). 하나로 모으면 몇 군데가 바뀐다 | I-3, I-4, I-4b, P-1, A-1 |
| Q2 | 만료 상태: 정지(복구 가능) / 삭제 / 새 `expired` | ENUM 변경이 필요하고 제품 의미(복귀)가 갈린다 | E-3 |
| Q3 | 게스트가 초대받은 채널 안에서 할 수 있는 것: 반응·고정·편집·삭제·허들·승인 결정·AI 호출·에이전트 호출·work spawn | Slack 기준 조사(`2026-11-02-guest-access-slack-ux.md`)와 대조해야 한다 | M-4, A-14, A-16 |
| Q4 | 보이는 사람의 이메일·시간대를 게스트에게 보일지 | 정책이다. 지금은 그대로 실린다 | P-1 |
| Q5 | 팀 표현·플러그인 목록·AI 비용·에이전트 합계를 게스트에게 보일지 | 워크스페이스 공통 자산이다 | P-5, P-6, P-7, A-4, X-6 |
| Q6 | 게스트가 부른 호스티드·벤더 한도 에이전트: 거절 / owner 사전 허락 / 트리거 채널로 도구 제한 | 비용·제품 판단이다. 외부 런타임 자체 기억은 oort가 막지 못한다 | A-8, A-10 |
| Q7 | member→guest 강등 때 기존 채널 처리(전부 유지·선택·전부 탈퇴) | 사용자 약속이다 | I-3 |
| Q8 | 게스트끼리·게스트↔에이전트 DM을 허용하나 | Slack 기준 조사 필요 | D-1, D-4 |
| Q9 | 「초대받은 채널」에 사설 채널·DM이 들어가나 | 초대 UX 판단이다 | I-1, I-2 |
| Q10 | 외부 표시(배지)의 자리: roster·작성자·채널 머리·푸시 제목 | UXUI 판단이다. 서버는 이미 roster에 `role`을 싣는다(`SRV/routes/roster.rs:106`) | P-1 |
| Q11 | 한 사람이 여러 조직의 게스트일 때 계정 모델 | 로그인이 워크스페이스 단위다(`SRV/routes/auth_routes.rs:315-327`). 제품 결정이다 | S-2 |
| Q12 | 누가 접근 기간을 연장하나(초대한 사람 / 채널 관리자 / 워크스페이스 관리자) | 지금 역할·정지는 워크스페이스 관리자만이다(`SET/membership_lifecycle.rs:306-365`) | E-11 |
| Q13 | 이 감사가 정독하지 못한 라우트(약 290개 중 위 길만 읽었다)의 게스트 거동 | 구현 단계의 「게스트 전수 회귀 시험」이 필요하다 | 전체 |
| Q14 | 구독 끊기 지연(최대 5분)을 허용하나 | 서버가 끊는 장치를 새로 만들지 정책이다 | R-2, E-7 |
| Q15 | 이미 계정이 있는 사람이 새 게스트 초대 코드를 쓰면(기존 게스트에 채널 추가 / 거절) | 입구 UX 판단이다 | I-2 |

## 7. 이 문서를 ADR-0219 초안에 쓰는 법

- 결정 후보는 크게 네 묶음이다. ① 입구(I-1~I-4b·I-9, 초대의 채널 집합·접근 기간·가입 환영, §4 본보기) ② 요청자 경계(A-1·A-7·A-8·A-10, 가능하면 요청자 GUC로 `message`에 RESTRICTIVE 정책을 거는 선례 `MIG/156:48-53`을 사람 요청으로 넓힐지) ③ 워크스페이스 공통 조회의 게스트 좁히기(D-1, P-3~P-5) ④ 만료(§5, 정지와 같은 결과 + 감시기 + 토큰 자르기).
- 읽기 쪽(M-1~M-8, N-1~N-2, R-1)은 이미 멤버십 한 줄로 막혀 있어 새 설계가 필요 없다. 멤버십 하나를 넘는 **두 번째 벽**이 필요하면 선례가 둘이다: 요청자 GUC + `message` RESTRICTIVE 정책(`MIG/156:48-53`)과, 보안 주체마다 채널 집합을 문장 술어로 끼우는 `MSG/channel_restriction.rs`(ADR-0216, 목록·이력·답글·받은함에 이미 엮여 있다). 이 성질을 게스트 시험으로 고정하는 것이 ADR의 검증 항목이다.
- 이 감사가 확인하지 못한 것: 실행 시험·런타임 동작 전부(`runtime-unverified`), 표시한 「추정」 행, §6 Q13의 미정독 라우트.
