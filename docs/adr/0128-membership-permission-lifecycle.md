# ADR-0128: 멤버십·권한 수명주기 v1 — 역할 분리, 승격/강등, 정지/추방/차단

- Status: **Accepted** (2026-07-21, 성재 승인 — 파생 MOMO-523/524/525 발급)
- 관련: docs/planning/2026-07-21-permissions-workspace-diagnosis.md(진단 정본), research/18-permissions-workspaces/(업계 조사), ADR-0121(셀프호스트 — 관리자 기능이 신뢰 전제), ADR-0117(멀티 워크스페이스 — 후속 예약, 이 ADR이 선행)
- 발단: 성재(2026-07-21) — "owner/admin이 초대·권한 부여·회수·내보내기까지 되는지. 메신저 설계 핵심은 권한과 워크스페이스."

## Context

1. 진단(정본 §1): 초대(role 지정·revoke·단축링크)와 채널 추가/제거·RLS 격리·파일 접근=채널 멤버십 파생은 강하다. 그러나 **역할 변경·정지·추방·차단·self-leave REST가 전무** — `member_status`(suspended/deleted) ENUM은 스키마에만 존재한다. 관리 기능 없는 메신저는 셀프호스트 운영이 불가능하므로 오픈소스 공개 전 필수.
2. 워크스페이스 admin이 **채널 membership에서 유도**된다(owner/admin 채널이 하나라도 있으면 워크스페이스 admin격) — Slack(워크스페이스 역할 ⊥ 채널 역할)·Discord(서버 역할 계층)·Mattermost(system/team/channel admin 3층) 전부 분리하는 지점.
3. 에이전트=member 대칭이 momo 고유 강점 — 수명주기도 대칭이어야 한다(정지된 에이전트가 계속 실행되면 안 됨).

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
- deleted의 완전 소거(GDPR성 익명화)는 v1.5 별도 — 이 ADR 범위 밖.

### D4. self-service
- `DELETE .../channels/:ch/members/me` (채널 leave — private/dm 규칙: dm은 불가, private은 가능하되 마지막 멤버면 채널 archive).
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
