# ADR-0173 — 외부 도구의 메시지 읽기 REST 표면 (EXT-1-READ)

- Status: **Proposed** (성재 방향 승인 2026-08-28 "읽기 연다" — 세부 shape 확정 대기 후 Accepted)
- 근거: #1820 · #1797 조사 정본 `docs/planning/research/2026-08-27-ext1-agent-credential-external-tools.md` · ADR-0101(에이전트 정체성·자격) · ADR-0162(외부 에이전트 수신·Agent Port)
- 관계: ADR-0162가 `messages:read`를 REST 표에서 의도적으로 뺀 결정을 **generic 자격에 한해** 넓힌다. hosted connection 경로는 불변.

## 맥락

#1797 실측: 외부 도구(Claude Code·CI)는 사람 세션 자격(15분·회전)이 아니라 **generic agent credential**(장수명·유예 회전, ADR-0101)로 붙는 것이 제품 정체성과 맞고, **발급·쓰기·회전·채널 참여까지 오늘 코드에서 폐곡선이 선다**. 그러나 **읽기는 계약상 닫혀 있다**:

- `messages:read` 스코프는 `required_agent_scope` 표에 없다(`agent_scope.rs:65,437` — MCP 도구 `oort_conversation_read` 전용, REST 라우트 0). 즉 agent bearer의 `GET …/messages`는 403.
- ADR-0162가 이를 의도했다: hosted credential이 REST 읽기를 얻으면 "generic principal 재현"이 되므로 `agent:inbox:read`·`messages:read`는 MCP 전용으로 격리.

결과: 외부 도구가 **반이중**(보내지만 못 읽음) — "외부 도구=1급 멤버" 표방이 미완.

## 결정

### D1 — generic agent credential에 REST 읽기 표면을 연다
`GET /v1/workspaces/{ws}/channels/{ch}/messages`(+스레드 replies 조회)를 **`messages:read` 스코프를 가진 generic agent credential**에 개방한다. `required_agent_scope`가 이 GET 경로에 `messages:read`를 매핑한다(현재 `None`).

### D2 — 범위 = 그 에이전트가 active 멤버인 채널의 히스토리
- 워크스페이스 경계는 RLS가 이미 강제(테넌트 트랜잭션). 채널 경계는 **active channel membership 검사**로 강제 — 사람 읽기 경로와 동일 술어.
- v1은 **자기가 멤버인 채널의 메시지·스레드 replies 조회까지**. **교차 채널·워크스페이스 검색은 범위 밖**(별도 스코프 `messages:search` 후보로 이월).

### D3 — hosted connection 경로는 불변 (ADR-0162 보존)
- 이 REST 읽기는 **generic agent member 전용**이다. **hosted connection 전용 member는 이 라우트에서 403** — 읽기는 계속 Agent Port MCP 도구(`oort_conversation_read`)로만. `409 hosted_connection_managed`·pairing 관리 모델 전부 불변.
- 구현 가드: 라우트가 `messages:read`뿐 아니라 **principal이 hosted-connection-bound가 아님**을 확인. hosted가 REST 읽기를 얻어 generic을 재현하는 ADR-0162 금지 사유를 그대로 유지.
- ∴ `messages:read`는 **이중 매핑**이 된다: hosted=MCP 도구 / generic=REST 라우트. 분기는 스코프가 아니라 **자격 종류(principal type)**로 판정.

### D4 — 읽기는 per-fetch 감사 없음
읽기는 상태 변이가 아니고 고빈도다. 사람 읽기가 fetch마다 audit하지 않는 것과 동형으로 **per-read audit 행 없음**. 접근 권한의 감사 지점은 자격 발급 시점(스코프 grant)에 이미 있다.

### D5 — `messages:read`는 비-default 유지 (최소권한)
`messages:read`는 `GRANTABLE`에 있고 `DEFAULT`에 없다(`agent_credential.rs:31,39`). 이 결정은 그 상태를 **그대로 둔다** — 외부 도구는 읽기가 필요하면 발급 시 명시 요청. 기본 자격은 여전히 쓰기·잡·realtime만.

## 결과

- (+) 외부 도구가 **완전 이중**(읽기+쓰기)으로 붙어 "에이전트=1급 멤버" 표방 완결.
- (+) hosted connection·Agent Port 모델 무손상 — 경계 확장은 generic 축에만.
- (+) 최소권한 유지(비-default·채널 멤버십·검색 제외).
- (−) 에이전트 읽기 접근이 새로 가능해지므로 RLS·멤버십 검사가 유일한 경계 — red proof로 교차 채널/테넌트 거부를 못박아야 함.
- (−) `messages:read`의 이중 의미(MCP vs REST)가 principal 종류에 의존 — 문서·테스트에 그 분기를 명시하지 않으면 다음 사람이 오독.

## 성재 확정 대기 (Proposed→Accepted 전)

1. **D2 범위** — v1을 "멤버 채널 히스토리"로 좁히는 것 승인? (검색·전 채널은 후속 스코프로 미룸)
2. **D3 이중 매핑** — hosted=MCP·generic=REST 분기가 ADR-0162 취지 보존으로 충분한지, 아니면 hosted에도 REST를 열지(권장: 격리 유지).
3. **D4 무감사** — 읽기 per-fetch 무감사 승인? (규제/추적 요구가 있으면 coarse 접근 마커 추가 재고)

확정되면 Accepted 전환 + engine 구현 티켓 발급(`required_agent_scope` 매핑 + hosted 가드 + 멤버십·RLS red proof + OpenAPI). 근거: audit §축5 후속.
