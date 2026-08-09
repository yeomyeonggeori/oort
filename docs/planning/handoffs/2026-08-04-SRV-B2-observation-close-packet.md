# 핸드오프 패킷 SRV-B2 — 관전 축 서버 마감: cancel 이식 + roster paused (2-goal 체인)

- status: **ready** · 배치 2 「관전의 마감 — 보인다→멈출 수 있다」 · owner/integrator: Fable(momo-main)
- worker: Opus 5 (서버 전담) · 기준: **`origin/track/engine` 최신**(`a604eb2f` 이후) · 새 워크트리
- 순서: **goal 1(cancel) PR → 머지 대기 없이 goal 2(roster) 착수 가능하나 PR은 순차** — 두 goal이 `dto.rs`·`lib.rs`를 공유하므로 **한 브랜치에서 커밋을 나누지 말고, goal별 브랜치·PR 2개를 순차로**(1 Issue=1 goal=1 PR). goal 2 브랜치는 goal 1 브랜치 위에 세워라.

## Goal 1 — agent-run cancel 라우트 이식 (Issue는 spawn 메시지에)

**왜**: 관전 축이 "지금 무슨 일을 하는지 보인다"까지 왔는데 "멈춰라"가 없다. Rust에 cancel 라우트 0개(실측) — Swift에만 있다. 폰 문구가 "이미 실행 중인 작업은 그대로 끝까지 갑니다"라고 말하는 이유가 이 공백이다.

**계약의 정본 = Swift** (`server/README.md` 규율 — 추측 금지, 이식):
- `server/Sources/MomoServer/Routes/AgentRunRoutes.swift:437-` `cancel` 전체를 읽어라. 핵심 계약(내 실측):
  - `POST /v1/workspaces/{ws}/agent-runs/{run}/cancel` · **human principal** · 권한 = **그 run 채널의 활성 멤버면 누구나**(owner/admin 아님 — ADR-0132 휴먼 정지권의 구현) · run 행 `FOR UPDATE`
  - **멱등**: 이미 `cancelled`면 재호출 OK · cancellable 상태 집합은 `isCancellableRunStatus` 그대로 · 아니면 conflict(현재 status 동봉)
  - 부수 효과: `work_control` 연계 세션 정리(`:468-` audit_log 조인) · **취소 시스템 라인 브로드캐스트**(`cancelMessageBroadcastPayload:937` — 단일 쓰기경로대로 outbox 경유인지 Swift 코드에서 확인하고 그대로)
- Rust 쪽 이미 있는 절반: `agent_gateway.rs:260-291` — cancelled run의 **cancellation acknowledgement**는 게이트웨이가 보낼 수 있는 유일한 종결 이벤트. 네 라우트가 만드는 `Cancelled` 상태가 이 경로와 맞물리는지 확인. `approvals.rs:510-526`의 `cancelRunAndAppendToolResult` 참조 주석도 같은 의미장.
- DTO: Swift `AgentRunCancelResponse` → `dto.rs`에 Swift 패리티로. **camelCase**(`#[serde(rename_all)]` — 이번 배치에서 openapi snake 표기가 이미 의심받고 있다. 스펙 갱신 시 실제 와이어와 일치시켜라).

**검증**: cargo test 전체 + 실DB conformance(기존 agent 계열 스위트 무회귀 + cancel 신규 스위트 — 멱등·비멤버 403·터미널 상태 conflict·시스템 라인이 outbox에 남는 것) + openapi 갱신(스펙+구현 같은 PR — 게이트가 실행 서버 샘플링이므로 따로 가면 깨진다) + red proof(멱등 가드 제거 시 이름 있는 실패).

## Goal 2 — roster에 paused (에이전트 탭 N+1 제거)

**왜**: 에이전트 목록 한 줄에 pause 상태를 그리려면 지금은 에이전트당 profile GET 1건이고, 그 읽기는 owner/agent-owner 게이트라 **일반 멤버 403**. 목록이 상태를 못 그린다.

**경계 판단(기결 — ADR 불요)**: `paused`는 이미 채널 멤버 전원에게 노출되는 정보다 — 재워진 에이전트를 멘션하면 **시스템 라인이 채널에 공개로 뜬다**(`agent_mentions.rs:478-516` `paused_mention_body`). roster에 싣는 것은 새 노출이 아니라 같은 사실의 목록 표기다. profile의 나머지(instructions 등)는 계속 게이트 뒤에 남는다 — **paused 하나만** 실어라.

- 파일: `routes/roster.rs`(현재 paused 없음 — 실측) · `dto.rs` roster DTO · 에이전트 멤버에만 의미 있는 필드이므로 human 멤버 직렬화에 어떻게 남길지는 Swift roster가 정본(있다면 그대로, 없다면 `Option` skip).
- 검증: roster conformance(에이전트 paused 반영·human 무영향·일반 멤버 200) + openapi 갱신 동반.

## 공통 계약

- `schema_v0.sql` 수정·이동 금지(이 두 goal 모두 마이그레이션 불요일 것 — 필요해 보이면 멈추고 이탈 보고). 서버 외(클라·core) 수정 금지 — 소비는 RN-B2 워커 몫.
- PR 본문 `## 계획 이탈` 필수. PR 후 STOP·머지 금지.
