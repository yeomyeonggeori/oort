# goal SRV-T1 — 툴콜 + 승인 축 (v0의 가장 큰 구멍)

너는 momo(제품명 oort) 레포의 구현 worker다. 이 문서가 유일한 지시서.
**base = `track/engine`**. 워크트리 `~/projects/momo-tracks/momo-worktrees/SRV-T1-toolcall`(브랜치 `feat/SRV-T1-toolcall`, 생성됨).

발단: 로드맵 진단(`docs/planning/2026-08-03-roadmap-diagnosis.md` — **먼저 읽어라**). ADR-0137 D5가 정의한 v0 축 **관전·승인·대화** 중 **승인이 통째로 비어 있다.**

## 0. 오케스트레이터 실측 (여기서 출발)
- Rust 라우터에 `approvals` **0경로**(Swift 정본 `ApprovalDecisionRoutes.swift` 1,277줄·엔드포인트 3개).
- **`INSERT INTO approval` 0건** — 승인 요청을 **만드는 코드가 없다.** 라우트만 이식하면 **빈 인박스**다.
- `RunStatus::AwaitingApproval` 타입은 있는데 **그 상태로 전이시키는 writer가 0개**다.
- 스키마는 준비돼 있다: `message_type`에 `tool_call`·`tool_result`·`approval_request`, `message.props` 규약이 `schema_v0.sql:168-169`에 주석으로 박혀 있고, `audit`의 `action_type`에 `'tool_call'`이 있다.
- `momo-agent/src/lib.rs:73`이 스스로 적어놨다 — *"Streaming/partial relay, the `tool_call` work-control branch, approvals, …"* 가 미구현이라고.

**즉 생산자(툴콜)가 선행이고, 그게 이 배치다.**

## 1. 규율
`.env`·자격증명 금지 · **`schema_v0.sql` 수정·이동 금지** · **docker 금지**(게이트는 오케스트레이터) · **실서버·실provider 호출 금지** · **`clients/**` 전부 수정 금지**(모바일이 검수 중이다) · route에 raw SQL 0(도메인 crate 경유) · 커밋은 새 커밋만 · **PR 후 STOP**.
**새 마이그레이션이 꼭 필요하면 만들되**(`server/Migrations/0NN_*.sql` 신규 파일) 왜 기존 스키마로 안 되는지 PR에 적어라. 되면 만들지 마라.

## 2. 먼저 읽어라 (계약의 정답)
- **Swift 정본**: `server/Sources/*/Routes/ApprovalDecisionRoutes.swift`(1,277줄) — 승인 목록·결정(승인/거부)·run 재개(`resume_approval` 잡)·권한 규칙.
- `momo-agent/src/run.rs` 상태기계, `momo-agent/src/mention.rs` 라우팅, `bins/momo-agent-worker/` 워커 루프.
- `schema_v0.sql`의 `message.props` 규약(위 :168-169)과 `approval`·`audit` 테이블.
- ADR-0113(플러그인/봇 경계)·ADR-0134(routing)·`docs/architecture/invariants-in-rust.md`.

## 3. 할 일

### 3-1. 툴콜 — 생산자
에이전트 응답이 **도구 사용을 요청**할 수 있어야 한다.
- provider 응답에서 tool call을 파싱해 **`type='tool_call'` 메시지**로 척추에 기록(`props` 규약 준수: `{name, arguments, call_id}`).
- 도구 실행 결과는 **`type='tool_result'`**(`{call_id, output, is_error}`).
- **어떤 도구를 허용할지가 이 배치의 경계 결정**이다. **새 도구를 발명하지 마라** — 이미 있는 능력(예: 작업 세션 제어) 중 **하나**로 최소 폐곡선을 만들고, 나머지는 목록만 남겨라. 무엇을 골랐고 왜인지 PR에 적어라.
- **provider 자격증명 비유입(ADR-0004)** 불변: 도구 실행이 provider 키를 서버로 끌어오면 안 된다.

### 3-2. 승인 — 생산자와 소비자
- **승인이 필요한 도구**는 실행 전에 **`approval` 행 + `type='approval_request'` 메시지**를 만들고 run을 **`awaiting_approval`로 전이**시킨다. 지금 0개인 writer가 여기서 생긴다.
- **승인 라우트 이식**(Swift 계약 그대로): 목록 · 결정 · run 재개. 결정은 **`resume_approval` 잡**으로 이어져야 한다 — `momo-outbox/src/agent_job.rs:25`가 *"swallows `method='resume_approval'` rows"*라고 적어둔 그 자리를 닫아라.
- **권한**: 누가 승인할 수 있나(Swift 실측이 정답). 자기 자신의 요청을 자기가 승인하는 경우의 규칙도 Swift를 따라라.

### 3-3. 불변식 (하나도 못 깬다)
1. **단일 쓰기경로** — 모든 기록은 REST→PG→outbox, 실시간은 `emit_outbox()` chokepoint 경유·같은 트랜잭션.
2. **gapless `message.seq`** — tool_call/tool_result/approval_request도 메시지다. seq 규약을 따르되 **채널 seq 카운터를 우회하지 마라**.
3. **RLS FORCE** — `with_tenant_tx()` 경유.
4. **에이전트 = member 무분기.**
5. **A2A 안전장치 유지** — G1(동시 run)·G2(연속 자동발화)·G3(step 소비)·`a2a_depth` 캡·체인 과금 상한. 툴콜이 이 게이트를 우회하면 안 된다. **승인 대기 중 run이 게이트를 점유한 채 영원히 남지 않게** 하는 것도 네 몫이다.
6. **멱등** — 같은 tool call이 두 번 실행되지 않는다.

### 3-4. red test (되돌리면 빨개지게)
- 승인 필요한 도구가 **승인 없이는 실행되지 않는다**.
- 승인 거부 시 run이 **거부로 종결**되고 도구는 실행되지 않는다.
- 승인 후 `resume_approval` 잡이 실제로 소비돼 run이 이어진다(**지금은 삼켜진다**).
- `awaiting_approval` run이 A2A 게이트를 **영원히 점유하지 않는다**.
- tool_call/tool_result 메시지가 **seq를 정상 소비**하고 outbox로 나간다.
- 다른 테넌트의 승인을 결정할 수 없다.
실DB 필요분은 **`#[ignore]`**(오케스트레이터가 docker 게이트에서 돌린다). 파일 상단에 실행 커맨드 주석.

## 4. 판단해서 PR에 적을 것
- **어떤 도구 하나로 폐곡선을 만들었나, 왜.**
- 승인이 필요한 행동의 기준(무엇이 승인 대상인가).
- 새 마이그레이션 여부와 근거.
- **UX 계약**: 클라가 무엇을 받아 어떻게 그려야 하는지(모바일·웹 배치가 이어받는다). 지금 클라를 고치지는 마라.

## 5. 검증
`cargo check` / `cargo test`(실DB는 `#[ignore]`) / `cargo fmt --check` / `cargo clippy -- -D warnings`.
새 crate를 만들었으면 **`server-rust/Dockerfile` 매니페스트 목록 갱신**(B1.7 함정).
**회귀 0**: `packages/momo-core`·`clients/web`·`clients/mobile` 수치 불변(안 건드렸으니 확인만).

## 6. PR
`feat/SRV-T1-toolcall` → `track/engine`. 본문에 Swift 계약 대조표·도구 선택 근거·승인 기준·불변식별 근거·red test 목록·클라가 이어받을 UX 계약·이탈. **PR 후 STOP.**
