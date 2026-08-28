# ADR-0173 — 외부 도구의 메시지 읽기 REST 표면 (EXT-1-READ)

- Status: **Accepted** (성재 방향 승인 2026-08-28 "읽기 연다" + shape 검토·확정을 Fable에 위임 · Fable 적대 검토 반영 D3·D4 정정 · Blocker 0). 정본 반영 최종 승인은 성재/`momo-main` 통합 시.
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

### D3 — hosted connection 경로는 불변 (ADR-0162 보존) — 격리는 **이미 성립**, 신규 가드 0
- 이 REST 읽기는 **generic agent member 전용**이다. hosted connection 전용 member는 이 라우트에 **닿지 못한다** — 계속 Agent Port MCP 도구(`oort_conversation_read`)로만 읽는다. `409 hosted_connection_managed`·pairing 관리 모델 전부 불변.
- **(Fable 검토 정정)** 초안은 "라우트가 principal의 hosted 여부를 확인하는 새 가드"를 요구했으나 **불필요하다 — 격리가 이미 스코프 표 앞단에 있다**: `auth.rs:836-848`의 `AgentBearerClass` 프리플라이트가 `HostedAgentPort` 클래스를 `POST /v1/mcp/agent-port` 외 전 라우트에서 403, `InvalidHostedBinding`도 전 라우트 403으로 차단하고, **`GenericOrUnknown`만 `required_agent_scope` 표로 진행**한다(`auth.rs:850`). 분류는 `classify_agent_bearer_in_tx`(`agent_bearer.rs:88-131`, `credential_class='hosted_active' ∧ hosted_connection_id ∧ audience='/v1/mcp/agent-port'`). ∴ `messages:read`를 표에 추가해도 **hosted 자격은 GET messages에 구조적으로 도달 불가**. 구현자는 라우트에 hosted 판별 가드를 **넣지 말 것**(잉여·오작동 위험) — 근거는 이 클래스 선격리다.
- `messages:read`는 코드경로가 갈린다(hosted=MCP `oort_conversation_read` / generic=REST `history`) — 스코프명만 공유하는 별개 경로이고, 충돌은 위 클래스 격리가 막는다.

### D4 — 핸들러 추가 감사 없음 — 단 **auth 층이 이미 모든 에이전트 읽기를 감사한다**
- **(Fable 검토 정정)** 초안은 "사람 읽기와 동형으로 per-read 무감사"라 했으나 **에이전트 경로는 사실이 반대다 — 이미 감사된다**: generic agent bearer의 모든 REST 요청은 auth 층 `resolve_agent_bearer_for_scope`가 `write_agent_bearer_audit(…, AUDIT_ACTION_USED, method, path, granted)`로 기록한다(`auth.rs:972`, 사람 경로엔 없는 층). ∴ `GET …/messages`도 method+path로 매 요청 감사된다.
- 결정: **핸들러 레벨 추가 감사 행 없음**(읽기는 무변이·고빈도) — 그러나 auth 층 에이전트-bearer 감사가 접근 추적을 이미 제공한다. 이 사실이 규제/추적 요구(성재 확정질문 3)를 공짜로 해소한다.

### D5 — `messages:read`는 비-default 유지 (최소권한)
`messages:read`는 `GRANTABLE`에 있고 `DEFAULT`에 없다(`agent_credential.rs:31,39`). 이 결정은 그 상태를 **그대로 둔다** — 외부 도구는 읽기가 필요하면 발급 시 명시 요청. 기본 자격은 여전히 쓰기·잡·realtime만.

## 결과

- (+) 외부 도구가 **완전 이중**(읽기+쓰기)으로 붙어 "에이전트=1급 멤버" 표방 완결.
- (+) hosted connection·Agent Port 모델 무손상 — 경계 확장은 generic 축에만.
- (+) 최소권한 유지(비-default·채널 멤버십·검색 제외).
- (−) 에이전트 읽기 접근이 새로 가능해지므로 RLS·멤버십 검사가 유일한 경계 — red proof로 교차 채널/테넌트 거부를 못박아야 함.
- (−) `messages:read`의 이중 의미(MCP vs REST)는 principal 클래스가 가른다(D3) — 문서·테스트에 명시하지 않으면 오독. red proof가 이 격리를 못박는다.

## Fable 검토 확정 (2026-08-28, 적대 검토 반영)

성재 위임으로 Fable이 shape 3점을 실측 확정 — 3점 모두 ADR에 유리하게 해소:
1. **D2 범위** — 확정: 자기 active 멤버 채널의 history·replies까지, 검색·전 채널 제외. `is_channel_member`가 사람 history/replies와 공유 술어(`messages.rs`)라 신규 경계 발명 0.
2. **D3 격리** — 정정 확정: hosted에 REST 읽기를 여는 위험은 **`AgentBearerClass` 선격리로 이미 차단**(신규 라우트 가드 불요·금지). ADR-0162 취지 보존은 자동.
3. **D4 감사** — 정정 확정: 에이전트 읽기는 **auth 층이 이미 method+path로 감사**. 핸들러 추가 감사 없이도 추적 요구 충족.

## engine 구현 티켓 계약 (발주 시)

- `required_agent_scope`에 `GET /v1/workspaces/{ws}/channels/{ch}/messages`(+replies)를 `messages:read`로 매핑. **hosted 판별 가드 신설 금지**(D3 — 클래스 선격리가 정본).
- red proof(신설/확장 conformance): ① generic+messages:read → GET messages 200(자기 멤버 채널) ② messages:read 없는 generic → 403 ③ **hosted 자격은 어떤 상태(hosted_active·grace·cleanup_pending)에서도 GET messages 403**(Note-2: hosted→GenericOrUnknown 낙하 엣지 못박기) ④ 비멤버 채널 403·**교차 테넌트 RLS 자가검증** ⑤ `is_channel_member`가 active까지 판정하는지 실측(비활성 멤버 거부) ⑥ 페이지네이션(`list_channel_page` cursor/limit) 그대로 동작.
- OpenAPI: 이 GET들의 agent-bearer 허용을 명세 + `schema.d.ts` 정합. `messages:read` 비-default 유지(D5, `agent_credential.rs` 무접촉).
- 근거: audit §축5 · #1797 · 이 ADR.
