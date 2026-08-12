# Hosted-agent pairing 런칭 패킷 — “Bring your hosted agent” (2026-08-12)

> Status: `ready` — ADR-0162 승인, HAP/UX Issue·M1·Project #44·`BUILD_TICKETS.md` binding 완료. #1358/#1363은 #1344 ADR landing 전까지 blocked
> Planning ID: `PLN-20260812-02` · Planner owner: GPT 5.6 (`momo-main`) · Integrator: `momo-main`
> 발급: 2026-08-12 · 기준 커밋: `ee463206aeab4d0eaa53e3a2a46d5d9625b44e7c` · Supersedes: `docs/planning/handoffs/2026-08-12-sol-external-agent-reception-packet.md`
> 근거 ADR: `ADR-0162 (Accepted, 2026-08-12)` · 대상 goal: `#1343`, `#1344`, `#1358`~`#1369` · 병렬 가능: §5 DAG 준수
> GitHub binding: `#1358=E1`, `#1363=E2`, `#1364=E3`, `#1365=E4`, `#1366=E5`, `#1367=E6`, `#1368=E7 OAuth 후속`, `#1360=UX1`, `#1362=UX2`, `#1359=UX3`, `#1369=UX4 OAuth 동의 후속`, `#1361=Grok E2E`
>
> 추적: **#1343**(문서·ADR·로드맵 정합 완료) · **#1344**(Grok trial-first 측정 완료·리뷰 대기) · **#1345**(ACP 잔여 감사, deferred)
>
> 트랙: #1343 및 HAP-E*는 **엔진**(`track/engine`), UX-*는 **UXUI**(`track/uxui`). 1 Issue=1 goal, 각 PR은 자기 트랙 branch를 base로 한다. track→main은 성재의 별도 명시 승인 없이는 하지 않는다.
>
> 기술 경계: 제품 방향·권장 순서와 공개 API·credential·pairing schema의 벤더 중립 경계는 성재 승인으로 ADR-0162 Accepted. #1344는 Grok의 비공개 custom-MCP loader transport와 manual routine 실행·개별 cleanup을 실측했다. 다만 route 404가 auth challenge보다 먼저 발생해 preset auth mode·pairing·tool call/full E2E는 미지정이며, #1358~#1369의 계약으로 구현·검증한다.

## 0. 목표와 성공 문장

사용자는 자신이 이미 구동·구독 중인 hosted agent를 서버 배포 없이 oort 팀메이트로 연결한다. 제품의 벤더 중립 문장은 **“Bring your hosted agent”**다. Grok Bot은 첫 setup preset이자 실제 E2E 대상으로, 증거가 닫힌 뒤 **“Grok Bot도 연결해 사용할 수 있다”**고 말한다.

가져오는 것은 외부 bot의 정의·provider credential·VM이 아니라 oort 연결이다. oort는 member identity, channel permission, durable inbox, approval, message/audit history를 소유한다. 외부 서비스는 runtime, model, provider credential, routine scheduler를 계속 소유한다.

## 1. 시작 전 인간 게이트

| 시점 | 성재가 할 일 | Codex가 받지 않는 것 |
|---|---|---|
| #1344 앱 설치 | **완료:** 공식 Grok Bot 앱 설치를 명시 승인 | macOS 관리자 비밀번호 |
| 앱 첫 실행 | **완료:** 본인이 개인 계정 로그인·MFA·consent 처리 | password, MFA code, cookie, xAI/Cursor token |
| 무료/trial 진입 | **완료:** 별도 trial entitlement/start 문구나 구매 없이 Bot 1개·기본 채팅 실행 | 결제정보 |
| capability 실측 | **완료:** 비공개 custom-MCP loader 왕복, Active-off routine 수동 실행, routine/connector 개별 제거 동작 확인 | provider secret, 결제정보 |
| ADR gate | **완료:** ADR-0162의 벤더 중립 technical boundary 승인 | provider credential 없음 |

**금지:** Bot 생성이나 기능 실측이 유료 전환에 막혀도 Codex가 구독·결제를 시작하지 않는다. screenshot과 로그는 계정 이메일, token, connector secret을 redaction한다.

## 2. 먼저 읽을 정본

1. `docs/adr/0162-external-agent-reception-agent-port.md` — Accepted hosted-agent pairing/auth/MCP 경계; Grok preset auth mode는 현재 route 404가 auth challenge보다 먼저라 미지정
2. `docs/planning/2026-08-12-external-agent-reception-plan.md` — 승인된 권장 순서·효과·완료 정의
3. `docs/planning/research/2026-08-12-grok-bot-integration-feasibility.md` — Grok 공식 표면/제약과 #1344 transport·Routine·cleanup 실측
4. `docs/planning/research/2026-08-12-grok-bot-reverse-teammate-direction.md` — 역방향 pull 가설, 감지·pairing·cleanup UX와 권장 실행 순서
5. ADR-0101·0102 — agent bearer와 worker/gateway 이중 경로
6. `server-rust/bins/momo-server/src/routes/agent_gateway.rs`, `server-rust/crates/momo-outbox/src/gateway.rs` — 재사용할 durable gateway 계약
7. `server-rust/crates/momo-auth/src/agent_bearer.rs`, `agent_scope.rs` — 확장할 credential/scope 경계
8. `docs/TRACKS.md`, `STATUS.md`, `ROADMAP.md`, `BUILD_TICKETS.md`, 현재 Issue 본문

## 3. 검수로 교정한 현재 사실

### 3.1 재사용 가능한 Rust live spine

- agent identity 생성/profile/pause와 `member.kind='agent'`
- hash-at-rest agent bearer 검증, revoked/expired/actor binding, audit 기반
- durable agent gateway의 pending recovery, lease/renew/release, events, complete 및 dedupe
- message send의 channel-seq bump + message + outbox 단일 transaction
- work session/control과 서명된 ACP event ingestion의 일부 Rust 경로

### 3.2 실제 gap

- Rust에 generic hosted-agent credential **issue/list/rotate/revoke 관리 API**가 완결돼 있지 않다.
- stateless remote MCP discovery/transport와 hosted-agent resource binding이 없다.
- one-time bot-initiated pairing state와 외부 artifact cleanup state가 없다.
- `message.seq`는 channel-local이라 여러 channel inbox의 recovery cursor로 쓸 수 없다.
- Rust MCP binding이 기존 gateway lease/complete와 message spine을 노출하지 않는다.
- web/Tauri pairing·detected confirm·disconnect cleanup UX와 mobile read-only status가 없다.

### 3.3 종전 감사의 잘못된 판정

- `work_tool_profile`은 migration 029와 Rust `momo-t3`에 존재한다.
- Swift `MomoACPHost`도 구현·테스트가 존재한다. 단 Rust-native host 완결 증거는 아니다.
- A2A Agent Card migration·OpenAPI·legacy Swift 구현 기록이 존재하므로 “전면 미착수”로 단정하지 않는다. Rust live route 여부는 별도로 잰다.
- #1345는 위 실재물을 기준으로 **남은 Rust-native/live gap만** 재측정한다. hosted-agent 런칭 선행조건이 아니다.

## 4. 불변식

1. Postgres=SoT, Centrifugo=전송 전용. MCP가 PG에 직접 쓰거나 Centrifugo에 publish하지 않는다.
2. 메시지 쓰기는 기존 REST/domain transaction과 `client_msg_id` 멱등을 재사용한다.
3. agent는 workspace-scoped member이고 모든 새 row는 RLS FORCE + transaction의 `SET LOCAL app.workspace_id`를 따른다.
4. raw pairing/agent credential은 최초 한 번만 노출하고 hash만 저장한다. response는 `Cache-Control: no-store`; 로그·audit에 secret을 넣지 않는다.
5. `detected`는 권한 부여가 아니다. 사람이 identity/channel/scopes를 확인해야 `active`가 된다.
6. MCP task/inbox가 별도 run·lease·approval 원장을 만들지 않는다. 기존 gateway의 서버 보장을 thin-bind한다.
7. Grok-specific metadata는 preset/manifest에만 있고 core lifecycle과 API는 vendor-neutral이다.
8. disconnect는 history 삭제가 아니다. local authority를 즉시 끊고 외부 artifact 정리 상태를 정직하게 표시한다.
9. provider password/MFA/token은 oort, 이슈, PR, 로그로 유입하지 않는다.
10. v0의 운영 단위는 **한 Bot = 한 connection = 한 dedicated agent member = 한 deterministic routine**이다. 기존 managed/BYOA member에 hosted connection을 덧붙이지 않고, 외부 roster를 scraping하거나 여러 봇을 한 token으로 가장하지 않는다.
11. `agent:port:connect`는 route reachability뿐이다. product tools는 inbox read=`agent:inbox:read`, conversation read=`messages:read`, post=`messages:write`, jobs claim/renew/release=`agent:jobs:read`, run event/complete=`agent:runs:callback`의 닫힌 추가 mapping을 각각 만족해야 하며 신규 read scope와 connect scope는 default 0이다.
12. hosted credential 발급은 위 6개 scope의 immutable allowlist를 shared validator로 강제하고 `agent:port:connect`를 필수로 한다. `work:control`, `realtime:subscribe`, `provider:quota:write`와 미래 generic scope는 static confirm/OAuth consent 어느 경로에서도 hosted bearer에 들어가지 않는다.
13. hosted static/OAuth credential은 canonical `/v1/mcp/agent-port`에서만 principal로 성립한다. shared auth가 generic REST/realtime route-scope dispatch 전에 connection·audience를 거부하며, MCP adapter만 기존 message/gateway typed domain port를 호출한다. generic non-hosted bearer의 기존 REST 표면은 유지한다.

## 5. Issue DAG와 소유권

아래 논리 ID는 실제 GitHub Issue, M1, Project #44 `Todo`, native `blockedBy`, `BUILD_TICKETS.md`에 결속됐다. #1358/#1363은 #1344의 Accepted ADR landing gate 뒤 `status:ready`로 전환하고, 나머지는 표의 native dependency가 닫힐 때까지 `status:blocked`를 유지한다.

| ID | 트랙·주 소유 파일 | Goal | 핵심 수용기준 | deps |
|---|---|---|---|---|
| **#1343** | 엔진 docs/ADR/planning | 사실 교정, ADR/roadmap/handoff/issue 정합 | docs gate, independent review, stale 패킷 superseded | — |
| **#1344** | 엔진 spike docs/evidence only | official app의 무구매 진입과 Grok MCP/routine/cleanup capability 측정 | Bot·채팅, private plugin loader→공개 URL HTTP 왕복, Active-off routine manual run, routine/connector 개별 제거 evidence; 구매 0. auth/pairing/tool/full E2E는 후속 이관 | #1343 |
| **HAP-E1 · #1358** | 엔진 `momo-auth`, server routes/OpenAPI | hosted agent credential issue/list/rotate/revoke + audit | raw once/no-store, hash-at-rest, scope/actor/expiry/revoke/redaction/RLS tests | #1344 landing gate |
| **HAP-E2 · #1363** | 엔진 신규 Rust MCP 경계/router | 2026-07-28 modern stateless core + exact 2025-11-25 sessionless legacy compatibility, static-bearer auth/rate limit | modern/legacy 혼동·unauth/wrong route/scope/workspace fail closed, no direct DB write | #1344 landing gate |
| **HAP-E3 · #1364** | 엔진 migration + pairing domain/routes | dedicated member+paused profile+connection 원자 생성, `pairing_pending→detected→active`, expiry/replay, artifact manifest | live connection/member 1:1 uniqueness, pending/detected/expired delivery 0, one-time consume atomicity, concurrent detect race, separate active proof + same-tx member unpause, hosted generic credential mutation 409, Agent Port 외 principal 0 | #1358, #1363 |
| **HAP-E4 · #1365** | 엔진 migration + inbox projection | agent-scoped durable inbox cursor | cross-channel same seq recovery, pagination/replay/dedupe, RLS | #1364 |
| **HAP-E5 · #1366** | 엔진 MCP tools + mention delivery selector + gateway/message adapters | inbox/job/message tools를 기존 gateway·message spine에 thin binding하고 active hosted connection만 per-agent gateway delivery | managed+hosted mixed routing; pending/lease/takeover/events/complete equivalence; idempotent post; approval/audit unchanged | #1364, #1365 |
| **HAP-E6 · #1367** | 엔진 connection/credential/gateway guards | local revoke + `cleanup_pending` enforcement | revoke/pause/new claims/writes block atomic; unexpected token invalidation pauses+cleans up; direct REST/realtime audience bypass 0; history preserved | #1364, #1366 |
| **HAP-E7 · #1368** | 엔진 ADR+`momo-auth`, migration, server routes | ADR-0162 OAuth lifecycle 증보 + MCP OAuth 2.1 authorization-server mode | existing connection binding, issuer/resource/PKCE/code/token/revoke/RLS attack matrix; no static fallback | #1364; v0 static pairing 비차단 |
| **HAP-UX1 · #1360** | UXUI `packages/momo-core`, `clients/web`; Tauri는 같은 bundle | `/agents` hosted-agent pairing wizard + Grok preset | setup→waiting→detected→confirm→active credential 전달/교환→provider 갱신·검증→test; keyboard/a11y/expiry/replay states | #1364, #1366 |
| **HAP-UX2 · #1362** | UXUI core+web | disconnect dialog, routine+connector+optional local-source cleanup checklist | local revoke result distinct; `cleanup_pending`; explicit manual ack; preserved history copy | #1367 |
| **HAP-UX3 · #1359** | UXUI core+mobile | mobile connection/cleanup read-only status | no pair/disconnect mutation; status/error/refresh tests | #1364 shared contract |
| **HAP-UX4 · #1369** | UXUI core+web | OAuth resource-owner 로그인·동의 + pairing wizard 복귀 | human session owner/admin, consent/deny/expiry/a11y, same connection active 복귀, token·verifier 비노출 | #1368, #1360; v0 static pairing 비차단 |
| **HAP-GROK-E2E · #1361** | #1344 evidence + engine/UX runtime | 실제 Grok routine pair→scheduled wake→job→reply→disconnect→cleanup | manual Test 없이 scheduled trigger, wake latency/cadence/retry provenance; active credential/routine/connector/local test source 0, Bot/chat disposition 명시 | #1344, #1358, #1363~#1367, #1360, #1362 |

```text
#1358 || #1363 -> #1364 -> #1365 -> #1366 -> #1360
                                   #1366 -> #1367 -> #1362
                            #1364 -------------> #1359
#1364 -> #1368 OAuth AS ----> #1369 OAuth consent/wizard UX (후속)
                   #1360 ----/
#1344 + #1358 + #1363..#1367 + #1360/#1362 ---> #1361
```

## 6. 파일 경계와 구현 함정

### HAP-E1 — credential

- 기존 `token` schema가 actor/hash/scopes/expires/revoked/last_used/created_by를 보유하므로 먼저 **새 DDL 없이 가능한지** 증명한다.
- 관리 API는 human owner/admin만 호출한다. raw secret은 issue/rotate 응답 한 번뿐이다.
- 기존 agent bearer 문자열 형식과 actor binding을 재사용하고, hosted connection/client metadata를 인증 권위로 쓰지 않는다.

### HAP-E2/E3 — MCP와 pairing

- exact supported MCP spec/date와 auth discovery는 이슈 claim 시 official primary source로 재검증한다.
- pending challenge secret과 active agent bearer를 같은 값으로 재사용하지 않는다.
- dedicated agent member, `paused=true` profile, pairing row는 한 transaction으로 만들며 실패 시 부분 member/profile/connection을 남기지 않는다. pairing row는 workspace, member, challenge hash, expiry, consumed time, detected client fingerprint의 최소 정보만 가진다. 기존 managed/BYOA member 선택과 한 member의 동시 live hosted connection은 거절한다.
- hosted dedicated member는 generic agent credential issue/rotate/revoke 대상이 아니다. 세 mutation을 `409 hosted_connection_managed`로 거부하고, credential 발급·교체는 activation/disconnect 내부 경로와 새 pairing namespace로만 한다.
- hosted credential은 exact Agent Port audience에서만 인증한다. active 여부와 무관하게 message POST/PATCH, gateway pending/lease/event/complete, realtime-token REST에 직접 제시하면 shared auth가 generic principal 생성 전에 거부하고 mutation을 만들지 않는다.
- E3가 active를 만들더라도 E5(#1366) selector와 E6(#1367) disconnect/invalid-token guard가 모두 랜딩하기 전 production hosted delivery를 0으로 유지한다. E5 runtime test만 synthetic override를 쓸 수 있고, 사용자-facing gate는 UX1(#1360)+UX2(#1362)까지 요구한다. 중간 배포에서 server-global mode나 managed worker로 fallback하지 않는다.
- client-declared `provider=grok`는 preset telemetry이지 신뢰 근거가 아니다.

### HAP-E4 — inbox

- channel-local `message.seq`를 workspace/global offset으로 사용하면 두 channel의 `seq=1`이 충돌한다.
- 외부 계약은 agent-scoped **opaque cursor**로 두고, allocation/storage의 정확한 방식은 Accepted ADR·migration review에서 확정한다.
- cursor advance와 visibility는 membership/scopes 재검증 뒤 일어나며, 연결을 해제해도 이미 보인 역사 원장을 삭제하지 않는다.

### HAP-E5 — gateway binding

- `pending`, lease claim/renew/release, events, complete의 기존 transaction과 dedupe를 호출한다. MCP 전용 task 상태머신을 복제하지 않는다.
- 현행 서버 전역 `AGENT_GATEWAY_MODE`는 hosted connection 권위가 아니다. mention transaction이 active hosted connection을 가진 dedicated member만 기존 gateway pending으로 보내고 managed/BYOA member의 기존 publish/delivery는 유지하는 per-agent selector를 사용한다. pending/detected/expired/cleanup/disconnected hosted member는 managed fallback 없이 delivery 0으로 거절한다.
- 같은 workspace에서 managed와 hosted agent를 동시에 mention하는 fixture가 각 목적지 1건, 교차 claim 0, 전역 모드 변경 0을 증명한다.
- `tools/list`와 `tools/call`은 `agent:port:connect`에 더해 inbox=`agent:inbox:read`, conversation=`messages:read`, post=`messages:write`, jobs=`agent:jobs:read`, callbacks=`agent:runs:callback`의 exact mapping을 동일하게 적용한다. connect-only credential은 product tools 0이고, 신규 read scope는 non-default다.
- E3 static confirm과 E7 OAuth consent는 같은 `HOSTED_AGENT_PORT_GRANTABLE_SCOPES` validator를 호출하며 allowlist 밖 scope 요청은 credential/code 발급 전에 거부하고 bounded denial audit를 남긴다.
- MCP의 message post도 `momo-messaging` 쓰기경로를 호출한다. `message.seq`를 직접 발급하지 않는다.
- tool 응답은 provider credential, internal lease token, 다른 channel/workspace 데이터를 노출하지 않는다.

### HAP-E6/UX-2 — disconnect

```text
active -- local revoke --> cleanup_pending -- external cleanup confirm/manual ack --> disconnected
```

- local revoke 성공 뒤 외부 cleanup이 남아도 active로 되돌리지 않는다.
- credential revoke와 connection 전용 agent member pause, 새 delivery/write 차단은 같은 fail-closed 경계에서 일어나며 다른 member/runtime 상태는 변하지 않아야 한다.
- 만료나 operator emergency revoke로 결속 credential이 무효화되면 첫 MCP/inbox/message/job guard가 어떤 capability도 수행하기 전에 dedicated member pause와 `cleanup_pending` 전이를 같은 transaction으로 적용한다. rotate/revoke/disconnect 경쟁은 한 serial outcome만 허용한다.
- active·pre-proof·disconnected hosted static/OAuth credential의 direct REST/realtime 호출은 connection 상태와 무관하게 audience 단계에서 거부한다. generic non-hosted bearer는 기존 REST 계약을 그대로 유지한다.
- Grok routine/connector public deletion API가 확인되기 전에는 자동 삭제를 구현·표방하지 않는다.
- #1344에서 connector Uninstall은 앱 목록만 제거하고 local plugin source를 남겼다. UX는 provider connector 제거와 사용자 local source 정리를 별도 항목으로 표시하며 filesystem path는 서버에 저장하지 않는다.
- manifest의 routine 이름은 `Oort Inbox: <workspace> / <agent>`로 deterministic하게 제시한다.
- manual acknowledgement에는 누가, 언제, 어떤 routine/connector를 정리했다고 확인했는지 audit를 남긴다.
- 재연결은 새 challenge/token으로 한다.

### UX-1 — pairing wizard

권장 flow:

```text
Bring your hosted agent
  -> provider preset (Grok Bot / generic MCP)
  -> connector URL + one-time setup secret + routine template 복사
  -> waiting for agent (expiry/새 코드)
  -> detected (client facts, 아직 권한 없음)
  -> human confirms name/channel/scopes
  -> 별도 active credential을 한 번 전달
  -> provider connector의 소비된 setup secret을 active credential로 교체
  -> active credential 검증 handshake + dedicated member unpause가 같은 activation 경계에서 성공해야 active
  -> test mention
```

- pairing challenge는 감지 시 소비되며 active bearer로 승격하지 않는다. ADR-0162는 connection마다 `oauth | static_bearer` 하나를 activation 전에 명시하고 fallback/downgrade하지 않는 경계를 고정하되, 첫 wave는 `static_bearer`만 활성화한다. #1344에서는 loader가 공개 endpoint까지 도달했지만 route 404가 auth challenge 전에 끝났으므로 Grok preset의 mode는 여전히 미지정이다. 사용자는 두 번째 secret을 connector에 명시적으로 갱신하고 proof 전에는 연결 테스트·inbox/job/message capability를 열지 않는다. OAuth UI/metadata/token exchange는 #1368 authorization server와 #1369 consent/wizard 복귀가 모두 검증되기 전 광고하거나 선택할 수 없다.
- 제품 내 카피는 과도한 “seamless/손쉽게” 약속 대신 단계와 현재 상태를 정확히 보여준다.
- status transition은 live region으로 알리고 focus를 잃지 않는다. expired, network retry, late callback, duplicate/replay를 각각 렌더한다.
- Tauri UI는 `clients/web` bundle을 재사용하며 별도 포크하지 않는다.

## 7. 검증 매트릭스

| Goal | 필수 gate | runtime/red proof |
|---|---|---|
| #1343 | `scripts/local_gate.sh --profile docs` | 링크·상태·issue DAG 대조 |
| #1344 | docs/static + manual evidence review | 앱 provenance, team policy gate, personal Bot·채팅, private plugin loader의 `POST initialize`/`GET` 404, Active-off routine manual success/delete, connector uninstall/local-source 잔류; 구매 0 |
| E1/E2 | cargo fmt, clippy `-D warnings`, test workspace | secret replay, revoke, wrong scope/audience/workspace, redaction, rate limit |
| E3/E4 | `[rust]+[sql]+runtime-db` | concurrent consume, expiry, RLS, cross-channel same seq=1, restart/recovery |
| E5/E6 | `[rust]+runtime-agent` with mock hosted agent | lease takeover, duplicate complete/post, revoke during lease, history preservation |
| UX-1/2 | web typecheck/test/build, design preflight/review, merge-tree gate | keyboard/screen reader, expired/late/replay, pairing-secret 재사용 불가, static bearer 교체, active credential 검증 전 capability 0, 미지원 OAuth 선택 0, cleanup pending/manual ack |
| UX-3 | mobile typecheck/test + merge-tree gate | read-only enforcement, refresh/offline status |
| Grok E2E | runtime-agent + manual redacted evidence | pair→detect→confirm→manual Test 없는 scheduled wake→job→reply→revoke→routine/connector/local-source cleanup; wake latency/cadence/retry 기록 |

서버 또는 shared-core 계약이 UXUI 트랙에 전달될 때 `docs/planning/ENGINE_HANDOFF.md`에 ready 항목을 추가한다.

## 8. runtime-unverified 대장

개인 계정 Bot·채팅, private plugin의 custom URL 등록과 loader→공개 endpoint 실제 HTTP, Active-off routine의 manual success·개별 삭제, connector UI uninstall까지 검증됐다. 다음은 HAP-E2/E3와 실제 Grok E2E 전까지 검증됨으로 쓰지 않는다.

- Agent Port의 성공한 modern `server/discover`/per-request metadata, pinned legacy initialize compatibility와 실제 tool 목록·호출
- Grok/Cursor loader의 auth challenge/UI, `oauth | static_bearer` mode, redirect/header 동작 — 현재는 route 404가 auth 전에 종료
- routine이 custom MCP tool을 호출하는지, schedule 최소 cadence·유휴 pause·retry 정책
- Cursor backend proxy의 source IP/header와 connector retry 동작
- connector Uninstall 뒤 남은 local plugin source의 안전한 정리와 공개 provider cleanup API 존재 여부
- 공식 문서는 Bot 삭제가 그 Bot 소유 routine을 제거한다고 설명하지만 이번에는 Bot 보존을 위해 최종 삭제를 취소했다. connector/local plugin source까지의 연쇄 cleanup은 문서화·실측되지 않았다.
- 실제 Grok runtime에서 pairing code expiry/retry와 disconnect 후 호출 차단이 재현되는지

미실증 상태에서도 generic mock hosted-agent E2E는 닫을 수 있다. 이 경우 출시 표면은 “generic hosted-agent pairing + Grok setup preset(runtime-unverified)”로 정직하게 분리한다.

## 9. 별도/deferred 레인

### #1345 — ACP 현행 감사

목표는 `work_tool_profile`, legacy Swift `MomoACPHost`, Rust work session/control/event ingestion, web 소비층의 **현재** 차이를 재측정하는 것이다. 결과가 Rust-native work host 이식 이슈를 만들 수 있으나 hosted-agent pairing의 dependency가 아니다.

### ADR-0163 — managed self-host catalog

adapter artifact catalog, install/health/version/update/rollback은 공급망과 host-control 문제다. 본 패킷은 Proposed/deferred로 보존하며, 별도 승인 전 HAP 이슈와 결합하지 않는다. 서버 Docker socket 직접 제어는 권고하지 않는다.

## 10. Worker handoff 규율

1. claim 전 최신 `STATUS.md`→`ROADMAP.md`→`BUILD_TICKETS.md`→Issue→이 패킷을 읽고 `scripts/goal_status.sh`로 충돌을 확인한다.
2. 엔진/UXUI 자기 track base에서 goal worktree를 만든다. root/main checkout에서 구현하지 않는다.
3. 한 Issue 범위만 수정한다. schema/API/security boundary가 패킷과 달라지면 임의 재설계하지 않고 blocked/deviation으로 넘긴다.
4. 해당 hard gate와 runtime evidence를 PR에 남기고 commit/push/PR 뒤 `scripts/goal_release.sh ... --review`로 handoff한다.
5. worker는 merge/close/roadmap reorder를 하지 않는다. momo-main이 독립 review, final local gate, required PR/policy gate를 확인한다.
6. track→main은 성재의 별도 명시 승인만으로 수행한다.
