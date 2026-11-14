# ADR-0128: 멤버십·권한 수명주기 v1 — 역할 분리, 승격/강등, 정지/추방/차단

- Status: **Accepted** (2026-07-21, 성재 승인 — 파생 MOMO-523/524/525 발급)
- 관련: docs/planning/2026-07-21-permissions-workspace-diagnosis.md(진단 정본), research/18-permissions-workspaces/(업계 조사), ADR-0121(셀프호스트 — 관리자 기능이 신뢰 전제), ADR-0117(멀티 워크스페이스 — 후속 예약, 이 ADR이 선행)
- 발단: 성재(2026-07-21) — "owner/admin이 초대·권한 부여·회수·내보내기까지 되는지. 메신저 설계 핵심은 권한과 워크스페이스."

## Context

1. 진단(정본 §1): 초대(role 지정·revoke·단축링크)와 채널 추가/제거·RLS 격리·파일 접근=채널 멤버십 파생은 강하다. 그러나 **역할 변경·정지·추방·차단·self-leave REST가 전무** — `member_status`(suspended/deleted) ENUM은 스키마에만 존재한다. 관리 기능 없는 메신저는 셀프호스트 운영이 불가능하므로 오픈소스 공개 전 필수.
2. 워크스페이스 admin이 **채널 membership에서 유도**된다(owner/admin 채널이 하나라도 있으면 워크스페이스 admin격) — Slack(워크스페이스 역할 ⊥ 채널 역할)·Discord(서버 역할 계층)·Mattermost(system/team/channel admin 3층) 전부 분리하는 지점.
3. 에이전트=member 대칭이 oort 고유 강점 — 수명주기도 대칭이어야 한다(정지된 에이전트가 계속 실행되면 안 됨).

## Decisions

### D1. 워크스페이스 역할 분리
- **A (권고)**: `workspace_membership(workspace_id, member_id, role: owner|admin|member|guest, UNIQUE(workspace_id, member_id))` 신설(migration 026). 기존 채널 유도 판정(`requireWorkspaceAdmin`)을 이 테이블 조회로 이관. 백필: 현 데이터에서 채널 owner/admin 보유자를 workspace admin으로, workspace 생성자(최초 owner 채널 보유자)를 owner로 승격 — 백필 스크립트는 migration에 포함·멱등.
- **불변식**: 워크스페이스당 owner ≥ 1 — 마지막 owner의 강등·정지·추방·탈퇴는 409(이양 후에만).
- guest(워크스페이스 수준): 초대된 채널만 보이는 등급(Slack multi-channel guest 문법) — 채널 목록/검색/roster 투영이 membership 교집합으로 제한(RLS는 이미 워크스페이스 경계, guest 제한은 쿼리 필터로).
- B — 채널 유도 유지: 채널 admin과 워크스페이스 admin을 영원히 구분 못함. **기각.**

### D2. 역할 변경 REST
- `PATCH /v1/workspaces/:ws/members/:member/role` (워크스페이스 역할): owner→(owner|admin|member|guest 임명 전부), admin→(member|guest 관리, admin 임명·owner 조작 불가). **자기보다 높거나 같은 역할 조작 불가**(Discord 계층 규칙 — owner 임명만 예외로 owner가 수행).
- `PATCH .../channels/:ch/members/:member/role` (채널 역할): 워크스페이스 owner/admin 또는 그 채널 owner/admin. 같은 계층 규칙.
- 자기 자신의 역할 변경 금지(강등 포함 — 이양·leave로만).

### D3. 수명주기 REST (워크스페이스 수준)
- `POST .../members/:member/suspend` · `/reinstate`: suspended 전이 — **로그인 거부 + 기존 토큰 즉시 revoke(token 테이블) + realtime 구독 차단**. 데이터·메시지 이력 보존. admin 이상, 계층 규칙 적용.
- `DELETE .../members/:member` (**추방 remove**): 전 채널 membership 제거 + status=deleted 전이(메시지 이력은 보존 — 저자 표시는 유지, Slack 문법). 토큰 revoke 동반.
- `POST .../bans` / `DELETE .../bans/:ban` (**차단**): email(human)·handle 기준 ban 원장(migration 026) — **invite redeem·join 시 banned 검사로 재합류 차단**(P2의 구멍 봉합). 추방 시 `ban: true` 옵션으로 원스텝.
  - 증보(Accepted, 2026-10-27 owner 승인, #4625): 이미 `deleted`인 이메일은 일반 초대 코드로 되살아나지 않는다([ADR-0215](0215-login-recovery-v2-password-change-and-reset.md) 증보 1 J7). 차단은 새 이메일·핸들까지 막는 도구로 남는다. 「돌아온 사람」 복원 경로는 후속 #4627.
  - 증보(Accepted, 2026-10-27 owner 승인, #4636): 정지·추방·탈퇴·비밀번호 변경·재설정이 로그인·claim·비밀번호 변경·join의 세션 발급과 겹쳐도 바뀐 상태를 따른다. 세션 기록은 판정과 같은 트랜잭션에서, 멤버십 잠금 아래서 한다([ADR-0215](0215-login-recovery-v2-password-change-and-reset.md) 증보 2).
  - 증보(2026-11-14, #5814, 결재는 아래 「결재 기록」): **소유자·관리자가 청하면 명부에 정지된 사람도 실린다.**
    - 무엇을: `GET /v1/workspaces/{ws}/roster`(별칭 `/members`)는 요청이 `include=suspended`를 달았고, 보는 사람이 사람이고 전체 접근 토큰(사람의 앱 세션)으로 왔으며 워크스페이스 역할이 owner·admin이면, 정지된(`status = suspended`) **사람** 멤버도 싣는다. 그 줄의 `status`는 `suspended`다. **인자를 단 요청에만** 싣는다. 인자가 없으면 누구에게나 이 증보 전과 같은 응답(활성만)이다. 역할은 요청마다 DB에서 읽는다(강등되면 같은 토큰의 다음 요청부터 활성만).
    - 누구에게는 그대로: 인자를 달아도 member·guest, 에이전트·작업 호스트(멤버십 행의 역할과 무관), 개발자 자격·잠금 화면·알림 확장(`push_fetch`)의 좁은 토큰(같은 사람이어도)에게는 지금처럼 활성만 싣는다. 오류가 아니라 조용히 활성만이라 클라이언트는 인자를 늘 달아 보낼 수 있다. 「전체 접근 토큰」은 허용 목록이다. 사람의 앱 세션만 해당하고, 나중에 생기는 좁은 문도 저절로 활성만 받는다. 모르는 `include` 값은 무시한다.
    - 누구에게도 싣지 않는 것: `deleted`·`invited`, 그리고 정지된 에이전트(꺼진 개인 에이전트·은퇴한 구독 에이전트)다. 정지된 에이전트는 각자 읽고 켜는 표면이 따로 있다(`GET …/personal-agents`, 에이전트 관리).
    - 왜: owner 2026-11-14 QA 승인(「나머진 다 추천으로」)으로 프로필 창에 정지·정지 풀기가 들어갔다(#5781). 그런데 명부가 활성만 돌려주니, 창을 닫으면 정지된 사람을 다시 열 화면이 없어 화면에서 되돌릴 수 없었다. 정지가 「되돌릴 수 있는 조치」로 남으려면 관리 권한을 가진 사람의 명부에 정지된 사람이 보여야 한다.
    - 보기와 풀기는 갈린다: 소유자·관리자는 정지된 사람을 모두 본다. 자기보다 높거나 같은 역할도 본다. 풀기는 D2·D3의 계층 규칙 그대로다(관리자는 정지된 관리자·소유자를 풀지 못하고 403). 누가 정지돼 있는지는 관리 판단의 바탕이고(풀 수 있는 사람에게 부탁하려면 먼저 보여야 한다), 보는 것이 권한을 넓히지는 않는다.
    - 넓히지 않는 것: 정지된 줄에는 `online`이 없다. `humanCount`·`agentCount`는 활성 줄만 센다. 명부 쿼리를 함께 쓰는 다른 길(팀 AI 멤버 목록, 사용량의 게스트 좁히기)은 활성만 보는 기본 함수를 그대로 쓴다. 사람을 찾거나 고르는 서버 길(멘션 기록, DM 열기, 채널 멤버 넣기, Agent Port 행동의 대상 해석, 푸시 대상, 온라인 명단)도 자기 술어로 활성만 본다. 게스트 좁히기(D1, [ADR-0219](0219-workspace-guests.md))와는 만나지 않는다.
    - 클라이언트: 인자를 단 요청에만 실으므로, 아직 업데이트하지 않은 앱(인자를 보내지 않음)은 서버가 먼저 배포되어도 지금과 같은 응답을 받는다. 인자를 보내는 클라이언트는 명부를 후보로 쓰는 자리(채널 멤버 넣기 후보, 채널 멤버 패널 등)에서 상태로 거른다.
    - 결재 기록: owner 승인(성재, 2026-11-14). planner가 「정지된 멤버를 소유자·관리자에게만 명부에 보여 줘요. 이게 있어야 정지를 화면에서 다시 풀 수 있어요」를 승인 건으로 올렸고, owner가 「둘다 추천대로.」(17:56) · 「승인건 말하는거야.」(18:06)로 승인했다. 같은 날 앞서 planner 재량으로 구현을 시작한 것을 이 승인이 덮는다(ADR-0100: 보이는 범위의 변경은 owner 승인).
- deleted의 완전 소거(GDPR성 익명화)는 v1.5 별도 — 이 ADR 범위 밖.

### D4. self-service
- `DELETE .../channels/:ch/members/me` (채널 leave — private/dm 규칙: dm은 불가, private은 가능하되 마지막 멤버면 채널 archive).
  - 증보(Accepted, 2026-11-05 owner 결정, #5332): 「dm은 불가」는 1:1에만 남는다. 그룹 DM은 참여자 누구나 나갈 수 있고 같은 트랜잭션에서 대기 중 입장 요청 취소·시스템 줄을 함께 한다. 그룹은 만들 때마다 새 방이라 나가기가 방 키를 바꾸지 않는다([ADR-0221](0221-group-dm.md) D2·D9).
- `DELETE .../members/me` (워크스페이스 leave — 마지막 owner 409).

### D5. audit 일관화
- D2~D4 전 행위를 audit 원장에 기록(`role.changed`/`member.suspended`/`member.removed`/`ban.created`... — actor/target/이전값/이후값). 기존 agent.created audit 문법 재사용. 관리자 조회 REST는 v1.5(UXUI 표면과 함께).

### D6. 에이전트 대칭
- suspend/remove가 agent member에 동일 적용 + **agent credential 즉시 revoke** + 진행 중 run 종료 신호(AgentWorker가 credential 실패로 자연 정지하는 기존 경로 재사용). 에이전트 ban은 handle 기준.

## Consequences
- (+) "초대 → 권한 부여 → 회수 → 내보내기 → 재발 방지(차단)" 전 수명주기 완성 — 성재 질문에 전부 yes가 됨.
- (+) ADR-0117(멀티 워크스페이스)의 선행 조건 충족 — 워크스페이스 역할이 1급이 되어 계정-워크스페이스 연결이 깨끗해짐.
- (−) requireWorkspaceAdmin 이관은 기존 admin 판정 호출부 전수 회귀 테스트 필요(verifier로 강제).
- 파생(Accepted 시): **MOMO-523**(엔진 — D1+D2+D3, migration 026, verify_membership_lifecycle.sh 포트 28030~28033) · **MOMO-524**(엔진 — D4+D5+D6 + requireWorkspaceAdmin 이관 회귀) · **MOMO-525**(UXUI — 멤버 관리 표면: roster 역할 드롭다운·정지/추방/차단 확인 다이얼로그·guest 표시).
