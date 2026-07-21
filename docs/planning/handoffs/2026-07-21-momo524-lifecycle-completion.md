# MOMO-524 핸드오프: 수명주기 완결 — self-leave·에이전트 대칭 (ADR-0128 D4~D6)

> 발급: 2026-07-21 Fable (성재 승인 "쭉 진행"). 정본: ADR-0128(Accepted) D4·D6(+D5 잔여). 선행 MOMO-523은 main 랜딩(49edf5d — workspace_membership·ban·suspend/remove·audit 기성).
> 트랙: 엔진 · base = main · PR base = track/engine · 도메인 = server. **migration 불요 원칙**(기존 원장 재사용 — 새 테이블 필요 시 STATUS에 사유 명기 후 027). verifier 포트 밴드 **28060~28063**.

## 구현 범위
1. **D4 self-service**:
   - `DELETE .../channels/:ch/members/me` (채널 leave): dm은 403, private에서 마지막 멤버면 채널 archive(기존 archive 경로 재사용 — 없으면 left_at만 기록하고 STATUS에 명기), public은 자유.
   - `DELETE .../members/me` (워크스페이스 leave): 마지막 owner 409(기존 WorkspaceAuthorization 불변식 재사용), 전 채널 membership 정리 + workspace_membership 제거 + status 전이 + 본인 token revoke. 메시지 이력 보존.
2. **D6 에이전트 대칭**:
   - MOMO-523의 suspend/remove가 agent member 대상일 때: **agent credential 즉시 revoke**(AgentCredentialRoutes 원장 재사용) + 진행 중 run에 대한 신규 dispatch 차단(credential 실패로 자연 정지하는 기존 경로 문서화·단정). reinstate는 credential 자동 복구하지 않음(재발급 필요 — 명시).
   - agent ban: handle 기준(이미 523 ban 원장 지원) — agent 생성(X-7 POST .../agents)·pairing 경로에서 banned handle 검사 403 가산.
3. **D5 잔여 — audit 조회 REST**: `GET .../audit?actions=&cursor=&limit=`(owner/admin 전용) — 523이 쌓는 audit 원장의 관리자 조회 표면(UXUI 525가 소비). 필터: action prefix·대상 member·시간 범위. RLS·페이지네이션 기존 문법.

## 하드 경계
- 단일 쓰기경로·RLS FORCE·schema_v0.sql 불변. WorkspaceAuthorization 헬퍼 경유(직접 role 쿼리 금지).
- **선례 함정 준수(필수)**: nil String?/UUID? 바인딩은 반드시 `::text`/`::uuid` 캐스트 / 트랜잭션 클로저 안 HTTPError는 중앙 unwrap이 처리하나 새 wrapper 금지 / verifier는 bash 3.2 호환(빈 배열 `${arr[@]+...}`)·Swift UUID 대문자 lower() 정규화·인라인 psql `-q`·컨테이너 내 curl 금지(mock-hermes python 사용)·포트 사전검사·비동기 단정 폴링.

## 수용 기준
- verifier `verify_lifecycle_completion.sh`(신규, 28060~28063): 채널 leave(dm 403·private 마지막 멤버 archive/left_at·public) / 워크스페이스 leave(마지막 owner 409·정상 leave 후 로그인 토큰 무효) / agent suspend→credential revoke 단정→gateway 인증 실패 / agent remove 동등 / banned handle로 agent 생성 403 / audit 조회(권한·필터·cursor) / RLS. runtime-db 편입.
- 기존 verify_membership_lifecycle·verify_agent_create 회귀 0(오케스트레이터 실런). server 테스트 가산·OpenAPI 갱신.

## 규율
- 커밋 자주. PR 후 멈춤(base=track/engine). merge/close·docker 금지(게이트=오케스트레이터). 시크릿 커밋 금지.
