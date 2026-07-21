# MOMO-523 핸드오프: 멤버십 수명주기 코어 — 역할 분리·변경·정지·추방·차단 (ADR-0128 D1~D3)

> 발급: 2026-07-21 Fable (성재 승인). 정본: ADR-0128(Accepted) D1·D2·D3 — 진단 docs/planning/2026-07-21-permissions-workspace-diagnosis.md, 업계 근거 research/18-permissions-workspaces/00.
> 트랙: 엔진 · base = main · PR base = track/engine · 도메인 = server. **migration 번호 026 사용.** verifier 포트 밴드 **28050~28053**.

## 목표
"초대 → 권한 부여 → 회수 → 내보내기 → 재발 방지(차단)" 수명주기 완성. 워크스페이스 역할을 채널 유도에서 1급 원장으로 승격.

## 구현 범위
1. **D1 — `workspace_membership`** (migration 026): `(workspace_id, member_id, role owner|admin|member|guest, UNIQUE(workspace_id,member_id))` + RLS FORCE(ws_isolation 기존 문법). **멱등 백필**: 채널 owner/admin 보유자→admin, 워크스페이스당 가장 이른 owner 채널 membership 보유자→owner(없으면 가장 이른 admin). `requireWorkspaceAdmin`(InviteRoutes 소유)을 이 테이블 조회로 이관 — **권한 판정 헬퍼 하나로 중앙화**(Slack Unified Grid 교훈, research/18 §5). 호출부 전수 이관(AgentRoutes·ChannelRoutes·WorkControlRoutes 등 grep 전수) + 각각 기존 verifier 회귀로 확인.
   - **owner ≥1 불변식**: 마지막 owner의 강등·정지·추방·탈퇴 시도 409.
   - guest: 채널 목록/roster/검색 투영을 membership 교집합으로 제한(쿼리 필터 — RLS는 그대로).
2. **D2 — 역할 변경 REST**: `PATCH /v1/workspaces/:ws/members/:member/role {role}` (워크스페이스) + `PATCH .../channels/:ch/members/:member/role {role}` (채널). 계층 규칙: **자기와 같거나 높은 역할 조작 불가**(owner의 owner 임명만 예외), 자기 자신 변경 금지, admin은 admin·owner 조작 불가.
3. **D3 — 수명주기 REST**:
   - `POST .../members/:member/suspend` / `POST .../members/:member/reinstate`: status 전이 + **suspend 시 그 멤버의 token 전부 revoke** + 로그인 거부(AuthRoutes 검사 — suspended면 403 명시 에러). admin 이상, 계층 규칙.
   - `DELETE .../members/:member` (추방): 전 채널 membership 제거 + workspace_membership 제거 + status=deleted + token revoke. body `{ban: true}` 시 ban 동반. 메시지 이력 보존(저자 표시 유지).
   - `POST .../bans {email?|handle?}` / `GET .../bans` / `DELETE .../bans/:ban`: ban 원장(migration 026 — workspace_id·email_norm(lower)·handle_norm·created_by·reason optional). **invite redeem + join 경로에서 banned 검사 → 403**(P2 구멍 봉합).
4. **audit**: 위 전부 기존 audit 원장 문법으로 기록(`role.changed`(old/new)·`member.suspended`·`member.reinstated`·`member.removed`·`ban.created`·`ban.deleted` — actor/target/detail).

## 하드 경계
- 에이전트 대칭(D6)·self-leave(D4)는 MOMO-524 범위 — 이 goal에서 건드리지 않는다(단 suspend가 agent member에 적용돼도 깨지지 않게 kind 무관 동작으로).
- 단일 쓰기경로·RLS FORCE·schema_v0.sql 불변. 기존 초대/채널 REST 계약은 가산만(후방호환).

## 수용 기준
- verifier `verify_membership_lifecycle.sh`(신규, 28050~28053): 백필 정확성(채널 유도=신규 테이블 동치) / 역할 변경 성공·계층 위반 403·마지막 owner 409 / suspend→로그인 403·기존 토큰 무효 / reinstate 복구 / 추방→목록 소실·이력 보존 / ban→redeem·join 403 / unban→재합류 성공 / guest 투영 제한 / audit 행 단정 / RLS. runtime-db 편입.
- requireWorkspaceAdmin 이관 회귀: verify_agent_create + verify_work_host 로컬 단정 부분 재확인(오케스트레이터가 docker 실런).
- server 테스트 가산·OpenAPI 갱신.

## 규율
- 커밋 자주. PR 후 멈춤(base=track/engine). merge/close·docker 금지. **verifier 작성 시 주의(선례)**: Swift UUID.uuidString은 대문자 — SQL text 비교는 lower() 필수 / 인라인 psql은 -q / 포트 사전검사 / 비동기 단정은 폴링.
