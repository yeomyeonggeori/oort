# oort 아키텍처 정본 (Overview)

> 생성: 2026-07-10 · 갱신: 2026-07-22 (MOMO-548 external memory provider consent, ADR-0131 agent profile) · 근거: 2026-07-09 6방향 코드베이스 감사 · 관리 규칙: 이 문서와 어긋나는 코드 변경은 같은 PR에서 이 문서를 갱신한다 (ADR-0100)
> 상세 진단(판정표·근거 전문)은 아티팩트 "momo 아키텍처 진단 & 빌드업 가이드 v0" 참조. 결정 이력은 `docs/adr/`.

## 제1불변식 (L4 스펙에서 승계, 여전히 유효)

1. **Postgres = 유일한 진실(SoT). Centrifugo = 전송 전용** (히스토리·권한의 원본 아님).
2. **단일 쓰기 경로**: REST → PG 커밋(메시지+seq+outbox 한 트랜잭션) → OutboxRelay → Centrifugo publish. 클라이언트·에이전트는 Centrifugo에 직접 publish하지 않는다.
3. **순서의 진실은 `message.seq`** — 채널별 gapless 카운터(`channel_seq` 행 잠금). Postgres sequence 금지(롤백 갭).
4. **에이전트는 평범한 `member`다** — 같은 REST, 같은 멱등성, 같은 RLS.
5. **테넌트 격리는 RLS FORCE** (`app.workspace_id` GUC) + 역할 분리(momo_app NOBYPASSRLS / relay·worker BYPASSRLS).
6. **provider 자격증명(Codex OAuth 등)은 oort에 절대 들어오지 않는다** (ADR-0004).

> ⚠️ **스택 갱신 (2026-08-03).** 아래 지도와 이후 절은 **Swift/Hummingbird 시절**을 그린다. 현재 배포되는 서버는 **Rust/Axum(`server-rust/`)**이고, 클라이언트는 **웹/Tauri(React) + RN 모바일**이다(ADR-0145 · ADR-0133 · ADR-0137).
> **`server/`(Swift, 137 라우트)는 이식 원본이며 실행 대상이 아니다** — `server/README.md` 참조. 라우트 parity 도달 시 일괄 삭제한다(성재 승인).
> **불변식 6개는 그대로 유효하다** — DB(59 마이그레이션 중 44개가 트리거·제약·RLS)가 최종 강제자라 언어 교체가 위협하지 않는다. 현재 위치는 `ROADMAP.md` §0이 정본.

## 시스템 지도

```mermaid
flowchart LR
    subgraph clients [클라이언트]
        MAC["macOS 앱 (SwiftUI)<br/>MomoCore 계약 + centrifuge-swift"]
        HG["BYOA 게이트웨이 (사용자 소유)<br/>Hermes · codex-workbench"]
    end
    subgraph server [MomoServer — Hummingbird 2]
        API["REST /v1/*<br/>agent_run · Context Packet<br/>approval · usage/audit 보장"]
    end
    PG[("PostgreSQL 18<br/>SoT · RLS FORCE · outbox<br/>usage_ledger · audit_log")]
    RELAY["OutboxRelay<br/>(별도 패키지)"]
    CENT["Centrifugo v6<br/>전송 전용<br/>subscribe proxy → 서버 재검증"]
    AW["AgentWorker + provider (SSE)<br/>managed 공식 경로"]
    WD["momo-workd<br/>사용자 소유 호스트 · PTY/ACP stdio"]

    MAC -->|REST 읽기/쓰기| API
    HG -->|"pending 재조회·events/complete<br/>(per-agent bearer)"| API
    API -->|1 트랜잭션| PG
    RELAY -->|poll| PG
    RELAY -->|publish| CENT
    CENT -->|"ws push: ch:/dm:/agent:/user:"| MAC
    CENT -->|"private agentwork: wake-up"| HG
    PG -->|"agent_job claim<br/>AGENT_GATEWAY_MODE=worker"| AW
    AW -->|"oort-owned state transitions<br/>progress·approval·usage/outbox"| PG
    WD -->|"서명 heartbeat · pending poll<br/>session/control REST"| API
```

- 로컬 알파: PG·Centrifugo만 Docker, 나머지는 호스트 프로세스 (`scripts/momo` → `scripts/local_alpha_runner.sh`).
- 푸시 후보(ADR-0120): `message` INSERT와 같은 트랜잭션에서 migration 011의 AFTER INSERT 트리거가 outbox `push_candidate` 행을 기록하고, NotifierWorker(BYPASSRLS `momo_notifier`)가 SKIP LOCKED로 소비해 기존 판정(DM/멘션/승인, 채널 음소거·자기 메시지 억제) 후 id-only v2 페이로드를 PushRelay로 dispatch한다. v2는 `thread_id=root_id ?? channel_id`, `momo.message|mention|approval|work` category, 승인에만 `approval_id`, ADR-0109 unread 합계 badge를 싣고 PushRelay가 APNs `thread-id`/`category`로 변환한다. **outbox 생산자 트리거는 이 1건이 유일하며, 신규 트리거 생산자는 Accepted ADR 없이 추가하지 않는다.** relay(`broadcast`)·AgentWorker(`agent_job`)·notifier(`push_candidate`)는 kind로 상호 배제된다.
- 에이전트 실행 경로는 역할이 분리된 **두 공식 경로**다(ADR-0102): `worker` = oort 소유 managed runtime, `gateway` = 사용자 소유 BYOA runtime. `AGENT_GATEWAY_MODE`는 전달 방식을 선택할 뿐 보장 소유권을 바꾸지 않는다.
- Memory Plane의 `workspace_memory_policy.enabled`와 외부 provider 전송 동의는 별도 축이다. `workspace.memory_external_provider_consent`는 기존 워크스페이스도 기본 false이며, 서버가 admin PUT과 member read projection에서 provider trust(`local-mock|self-hosted|external`) 및 최종 허용 여부를 판정한다. AgentWorker 추출·임베딩은 같은 공유 trust 분류와 서버 소유 원장 값을 소비하며, external 미동의면 원문 provider 호출 전에 건너뛰고 `memory.extraction.consent_required`를 워크스페이스당 한 번 기록한다. local-mock과 literal loopback/RFC1918/ULA self-host는 동의와 무관하게 기존 동작을 유지한다.
- 에이전트 정의는 `member(kind=agent)` + `agent_profile` + run별 불변 Context Packet이다(ADR-0131). profile은 자격증명 없이 instructions·model preference·enabled tool allowlist·mention 고정/예약 schedule만 보유한다. mention packet은 서버 정책 프리앰블을 profile보다 먼저 두고, profile tool은 실제 Capability grant와 교집합만 허용하며, model preference는 workspace allowlist 밖이면 run당 감사 후 기존 model로 되돌린다. profile 없는 agent는 기존 528 payload 계약을 유지한다.
- 플러그인 경계(ADR-0113): oort 서버는 검증된 3층 manifest, workspace install 정책, `(workspace, member, plugin, scope)` grant와 Capability Cache projection, audit만 보유한다. provider OAuth/raw credential은 사용자 소유 BYOA 호스트에만 있고 서버 테이블·로그·응답에 들어오지 않는다. install revoke와 grant revoke는 projection을 같은 transaction에서 제거하고, Hermes adapter는 Context Packet마다 위임 사용자와 agent가 함께 속한 채널을 서버에 재검증한 뒤 유효 projection의 MCP 접속 기술자만 tool policy로 조립한다. 조회·manifest가 하나라도 잘못되면 해당 범위를 기본 거부하며 장기 캐시하지 않는다.

  이 호스트 커스터디 모델은 에이전트 호스트가 사용자가 직접 소유·통제하는 머신이라는 전제다. OAuth/PAT 등 MCP 자격증명은 그 호스트의 MCP 클라이언트에만 보관해야 하며 oort 서버나 Context Packet으로 전달하지 않는다. 다중 사용자 workspace에서도 한 에이전트 호스트를 사용자 사이에 공유하지 않고, 각 사용자의 호스트 세션과 토큰 저장소를 분리한다.

  Drive 경로 C는 이 일반 remote 커스터디 모델의 좁은 서버 소유 **설계 선례**다(ADR-0113 D3/D5). `POST /v1/mcp/drive` 구현은 은퇴 중인 Swift 트리에만 있고 현행 Rust router에는 이식되지 않았다. 따라서 공유 드라이브 검색·메타데이터·bounded text export와 SA 운영 절차를 현행 Rust 기능으로 주장하지 않는다. 역사적 SA 생성·공유 드라이브 멤버십·수동 실호출 절차는 [`docs/GWS_INTERNAL_CONSENT_RUNBOOK.md`](../GWS_INTERNAL_CONSENT_RUNBOOK.md)에 남아 있다.

  ADR-0162의 현행 Rust **Agent Port foundation**은 `POST /v1/mcp/agent-port` 하나다. MCP `2026-07-28` modern 요청은 매 호출 version/capability metadata와 `server/discover`를 사용한다. Grok 실측에서 관측된 legacy-era loader에 대비해 exact `2025-11-25` adapter가 `initialize`·`notifications/initialized`·`ping`·빈 `tools/list`와 빈 catalog의 unknown `tools/call` 오류만 별도 분기하지만, 이 exact version의 Grok live compatibility는 아직 `runtime-unverified`다. 두 분기 모두 protocol session·GET stream·`Mcp-Session-Id`가 없으며 매 POST를 다시 인증한다. 첫 wave는 비기본 `agent:port:connect`를 가진 static agent bearer만 받고 OAuth/resource metadata를 광고하지 않는다. HAP-E5(#1366)부터 이 위에 8개 thin-binding tool(`oort_inbox_read`·`oort_conversation_read`·`oort_message_post`·`oort_jobs_claim`·`oort_job_renew`·`oort_job_release`·`oort_run_event`·`oort_run_complete`)이 올라간다. `tools/list`와 `tools/call`은 **하나의** 교집합(연결의 승인 scope × 현재 token scope × 서버 capability)을 공유하므로 광고 목록과 호출 가능 목록이 구조적으로 어긋날 수 없고, `agent:port:connect`는 어느 tool의 필요 scope도 아니어서 도달성만 열 뿐 능력은 열지 않는다. 각 tool은 기존 domain의 얇은 결속이다 — 메시지는 REST send와 같은 `momo-messaging` 송신 transaction(`channel_seq`·`client_msg_id` 멱등성·message INSERT + outbox INSERT)을 쓰고, job/lease와 run callback은 기존 gateway 의미를 그대로 호출한다. 두 번째 message/job SoT도, MCP 쪽 직접 Centrifugo publish도 없다. client가 쥐는 것은 AEAD로 봉인된 `leaseHandle`뿐이라 job id·lease owner·run id는 밖으로 나가지 않는다. 전달은 **agent별**로 선택된다: active hosted connection을 가진 agent는 전역 provider mode와 무관하게 hosted gateway로 가고, active가 아닌 hosted agent는 managed로 fallback하지 않고 fail-closed된다. 생산 gate `MOMO_HOSTED_DELIVERY_ENABLED`는 HAP-E6(#1367)가 disconnect 수명주기를 랜딩하면서 열렸다 — `#[cfg(debug_assertions)]` 제한이 사라져 release 빌드도 이 변수를 읽지만 기본값은 여전히 closed이고 정확히 소문자 `true` 한 철자만 연다. 프로덕션 활성화는 이제 **운영자의 명시적 결정**이며, 그 결정을 되돌릴 수 있게 하는 것이 아래 disconnect 상태기계다. HAP-E7(#1368)이 그 위에 **MCP OAuth 2.1 authorization server**를 올렸지만 `MOMO_AGENT_PORT_OAUTH_ENABLED`가 정확히 소문자 `true`일 때만 존재한다 — 기본값에서는 RFC 9728 protected-resource metadata도 RFC 8414 authorization-server metadata도 광고하지 않고 `/v1/oauth/{authorize,token,revoke}`가 404이며, static bearer 경로는 flag on/off에서 **byte 동일**하다(challenge 헤더까지 테스트로 고정). 열렸을 때의 계약: issuer와 canonical resource는 운영자 설정에서만 오고 `Host`/`Forwarded`/`X-Forwarded-*`는 어디서도 읽지 않으며, client는 운영자 allowlist에 미리 등록된 public client뿐이고(DCR·URL-form Client ID Metadata Document는 구현·fetch·광고 모두 안 함, `client_secret` 없음), PKCE는 `S256`만, redirect URI는 byte-exact match, `iss`는 RFC 9207로 항상 동봉된다. `GET /v1/oauth/authorize`는 unauthenticated여서 **아무 row도 쓰지 않고** server-서명 단기 envelope만 consent 화면에 넘기며, workspace·connection·human은 인증된 tenant-scoped consent API에서 결정된다(envelope nonce당 terminal decision 정확히 1건). lifecycle은 `pairing_pending ──human consent──> detected ──code 1회 소비 + PKCE proof + exact audience + member unpause(한 transaction)──> active`이고 disconnect/cleanup/terminal은 static arm과 동일하다. pairing challenge· authorization code·access·refresh는 서로 승격되지 않는다 — 저장 digest가 envelope 전체를 덮으므로 재라벨링이 산술적으로 막히고, credential class와 connection의 `auth_mode` 일치는 migration 074의 trigger가 강제한다(= OAuth 실패 뒤 static bearer로의 자동 강등이 스키마상 불가능). code replay와 refresh reuse는 거절과 같은 transaction에서 그 connection의 live OAuth credential 전부를 revoke하고 bounded audit 1행을 남긴다. consent가 발급할 수 있는 scope 상한은 static confirm과 **같은 validator**의 `HOSTED_AGENT_PORT_GRANTABLE_SCOPES`이며 상한 밖·미요청 scope는 code 발급 전에 거절된다. 발급된 OAuth credential은 canonical `/v1/mcp/agent-port`에서만 principal이며 message POST/PATCH·gateway 동사· realtime-token REST에 직접 제시하면 mutation 0으로 거절된다. 근거는 ADR-0162 증보 1(Accepted — 성재 승인 2026-08-15)이고, flag를 여는 것은 #1369 consent UX 랜딩과 runtime proof 폐곡선 뒤의 별도 운영 결정이다.

  **Disconnect 상태기계(HAP-E6 / 마이그레이션 072).** hosted connection은 `pairing_pending → detected → active`에서 두 갈래로 종결한다. disconnect **시작**은 `detected|active → cleanup_pending` 단일 tenant transaction이다 — 이 커넥션의 live bearer revoke + 전용 agent pause + 열린 gateway job 억제(lease 회수 포함) + 종류별 artifact manifest seed + audit 1행이 전부이거나 전부 롤백이다. 잠금 순서는 HAP-E4 계약 그대로 `connection → token → member → membership → profile`이고, revoke는 **`hosted_connection_id` 한정**이라 같은 agent의 형제 커넥션 토큰은 건드리지 않는다(#1374 수리 방향과 정합). 같은 전이의 강제판이 **reconciliation**이다: 커넥션이 스스로 가리키는 `active_token_id`가 만료·운영자 emergency revoke·member 정지·membership 상실로 죽어 있는 것을 첫 domain guard가 관측하면 capability 수행 전에 같은 tx로 `cleanup_pending`까지 fail-closed로 맞춘다(제시된 자격증명이 현재 active token일 때만 — 낡은 토큰으로 살아 있는 커넥션을 끌어내릴 수 없다). manifest는 jsonb가 아니라 **행**이다: `bot`·`routine`·`plugin`·`connector`·`local_plugin_files`·`secret` 각각 한 행(+명명된 항목마다 한 행)이며 expected action·current status·disposition·actor/source·acknowledged-at/evidence를 기록한다. #1344 실측이 스키마가 된 지점이 셋이다 — connector 해제는 `local_plugin_files`를 **자동 충족하지 않고**(다른 행이고, 한 행이 다른 행을 쓰는 경로가 없다), inactive routine은 `current_status`일 뿐 `disposition`이 아니어서 resolved가 되지 않으며, `bot`은 `preserved`가 합법 terminal인 유일한 종류다(bot 삭제는 chat history까지 지우므로 oort가 대신 지우지 않는다). `secret` seed 행 하나만 `server_verified`다 — 이 서버가 직접 revoke하고 되읽을 수 있는 유일한 artifact이기 때문이고, 나머지는 actor+evidence를 요구하는 `manual`이다. terminal `disconnected`는 required artifact가 전부 resolved이고 로컬 절반(이 커넥션의 live credential 0, agent paused)이 서버 판독으로 확인될 때 **정확히 한 번** 일어난다. 마이그레이션 072의 트리거가 같은 계약을 네 절(`OLD.status='cleanup_pending'` · manifest 비어 있지 않음 · required 미해결 0 · credential 0 + paused)로 다시 단언하므로 전이 함수를 우회한 쓰기도 거짓 terminal을 만들 수 없다 — 특히 **manifest 비어 있지 않음** 절이 없으면 "required 미해결 없음"이 행 0건일 때 공허하게 참이 되어 start를 건너뛴 경로가 그대로 통과한다. message/chat/audit/inbox 이력은 보존되고 cascade delete는 없다. 재접속은 old credential/connection을 되살리는 게 아니라 새 pairing·자격증명·connection namespace를 요구하며, 옛 token·cursor·lease는 계속 실패한다.

- **Hosted durable inbox:** channel-local `message.seq`를 여러 채널의 전달 cursor로 재사용하지 않는다. `hosted_agent_inbox_counter`가 active connection마다 별도 `inbox_seq`를 직렬 발급하고, `hosted_agent_inbox_event`는 기존 message/job/run SoT의 immutable reference만 보존한다. opaque AEAD cursor는 workspace·agent·connection·position에 결속된다. append/read는 active hosted credential의 exact actor/connection/audience와 inbox scope, member/workspace/profile/approved channel/current membership을 tenant transaction에서 다시 잠그며, visibility가 사라진 reference는 내용 없이 scan watermark만 전진한다. reconnect는 새 connection namespace를 쓰고 이전 ledger는 보존한다. HAP-E5(#1366)가 producer를 열면서 두 가지를 DB로 닫았다: outbox 참조가 `kind`까지 결속되고(생성 컬럼 + kind 포함 unique index), `agent_job` 참조는 이 agent의 `gateway` job이며 그 payload의 run이 참조된 run과 같아야 한다(trigger). 참조 append는 항상 원본 transaction 안에서 일어나므로(message send tx, job/run mutation tx) 커밋되지 않은 원본을 가리키는 참조도, tombstone을 먼저 만난 참조도 존재할 수 없다. cursor secret은 connection era에 결속된 값이며 봉투에 key-id를 두지 않는다 — 회전은 계약상 disconnect와 같고, 열리지 않는 cursor는 조용한 전량 재전송이 아니라 fail-closed 거절로 끝난다(운영자-facing 강제 재-pairing은 #1367 소유).

### 클라이언트 roster와 realtime discovery

ADR-0128부터 `workspace_membership`이 owner/admin/member/guest 워크스페이스 역할의
유일한 원장이고 채널 `membership.role`은 채널 안의 역할만 표현한다. 모든 workspace
관리 판정은 `WorkspaceAuthorization` 한 곳에서 active member와 이 원장을 함께 조회한다.
owner는 항상 한 명 이상이어야 하며 마지막 owner의 강등·정지·추방은 409다. suspend는
member 상태 전이와 모든 actor/subject token revoke를, remove는 전 채널 membership과
workspace membership 삭제·deleted 전이를 한 tenant transaction에서 audit과 함께
커밋한다. `workspace_ban`은 정규화 email/handle을 보관하고 authenticated invite redeem과
public join 양쪽에서 재합류를 막는다.

self-leave도 같은 경계를 쓴다. channel leave는 DM을 거부하고 private 최종 멤버가 나가면
membership `left_at`과 channel archive를 한 tenant transaction에서 커밋한다. workspace leave는
마지막 owner를 409로 막고 전 channel/workspace membership 삭제, deleted 전이, 본인 token
revoke를 audit과 함께 커밋하되 authored message는 보존한다. agent suspend/remove의 token revoke는
`agent_bearer`를 포함하므로 gateway의 다음 pending/callback/dispatch 인증이 즉시 실패한다.
reinstate는 폐기 credential을 복구하지 않으며 human admin의 명시적 재발급이 필요하다. agent
생성과 credential pairing은 모두 정규화 handle ban을 재검사한다. owner/admin 전용
`GET /v1/workspaces/:ws/audit`은 기존 FORCE RLS `audit_log`를 action prefix, subject member,
시간 범위와 `(created_at,id)` cursor로만 투영한다.

macOS real-server 세션은 `GET /v1/workspaces/:ws/roster`를 멤버 신원과 active
`channelIds`의 유일한 권위로 사용한다(ADR-0110). 일반 멤버는 active workspace member
전체를 보고, guest는 자신과 채널을 공유하는 멤버 및 공유 `channelIds`만 본다. 채널
목록과 검색도 계속 호출자의 active channel membership 교집합만 투영한다. offline demo
fixture는 `LiveChatBackend`에만 존재한다.

workspace shared identity는 ADR-0118을 따른다. active member는 tenant-scoped
`GET /v1/workspaces/:ws`로 이름과 갱신 버전을 읽고, owner/admin만
`PATCH /v1/workspaces/:ws`로 이름을 변경한다. PATCH는 `expectedUpdatedAtMs`로
lost update를 막고 성공 audit을 같은 transaction에 기록한다. tenant root인
`workspace` 자체도 `id = app.workspace_id` ENABLE/FORCE RLS를 적용한다. 공개 join의
chicken-and-egg만 locked `momo_join_private` schema의 fixed-search-path·static SQL·
schema/function PUBLIC revoke·app-role USAGE+EXECUTE-only인 exact
invite-hash→active workspace UUID 함수로 해소하고, invite 상태 조회부터는 그
UUID의 tenant context로 돌아간다. 일반 identity 경로에는 BYPASSRLS가 없고 기존
platform-admin 전역 조회는 별도 read-only BYPASS connection에만 남는다. 401/403/404는
server-origin + member + workspace 범위의 해당 클라이언트 캐시까지 삭제하며,
transient 5xx/transport 실패에만 마지막 이름을 표시한다. privileged private schema/function은
migration 009가 정확히 생성하므로 pre-existing object drift에서 transaction이 fail-closed 된다.
내부 smoke는 roles absent → migrate → test-only bootstrap 순서를 허용하지만, production의
`MOMO_BOOTSTRAP_RUNTIME_ROLES=0`은 secret manager/IaC가 app(NOBYPASSRLS)과
relay/worker(BYPASSRLS)를 먼저 안전하게 provision해야 하며 누락·속성 불일치 시 migration 전에
실패한다. ephemeral PG18 gate는 두 순서와 app-only exact ACL을 모두 검증한다.
bootstrap/refresh/conflict
reload/subscription 응답은 session+workspace generation이 바뀌면 상태와 오류 모두
폐기한다.

direct message는 ADR-0112의 "하나의 타임라인, 두 개의 밀도" 원칙에 따라 일반 채널과
같은 timeline/read-state 경로를 사용한다. `GET /v1/workspaces/:ws/dms`는 active DM과
참여자를, 같은 경로의 `POST {memberId}`는 정렬한 두 member ID의 SHA-256 `dm_key`로
기존 방을 재사용하거나 새 방을 만든다. 서버는 요청자·상대의 active workspace member
권한을 확인하고, channel·channel_seq·두 membership을 한 tenant transaction에서
보장한다. macOS 멤버 디렉터리는 roster를 사람/에이전트 구분과 검색의 권위로 쓰며,
사이드바 진입점과 채널 헤더의 멤버 수 control은 production root의 같은 directory sheet로
수렴한다. 생성된 DM은 기존 사이드바 unread/read-state 표면에 즉시 합류한다.

read-state는 Postgres `read_state`가 유일한 권위다(ADR-0109). 클라이언트는 bulk GET으로
자신의 channel cursor/head/unread/mention projection을 읽고, actor-bound PUT으로 cursor를
단조 증가시킨다. cursor 전진 알림은 같은 트랜잭션의 outbox를 거쳐 exact actor의
`user:read-state#<member-id>` user-limited channel로 전송되며 Centrifugo는 계속
전송계층일 뿐 read-state를 보관하거나 판정하지 않는다.

로그인과 invite join 응답은 `realtimeWebSocketUrl`을 함께 반환한다. 앱은 이 서버 소유
주소로 centrifuge-swift transport를 구성하고 앱 환경의 `MOMO_CENTRIFUGO_WS_URL`은
이전 서버/개발용 fallback으로만 사용한다. REST API와 realtime 공개 도메인은 계속
분리할 수 있으며(ADR-0002), 클라이언트는 API URL에서 realtime 주소를 추론하지 않는다.

### 첨부 저장 어댑터

ADR-0127에 따라 첨부 REST·클라이언트 계약은 하나이고 저장 구현만 부팅 env로 선택한다.
기본 `drive`는 기존 Google Drive archive를, `s3`는 AWS SigV4 호환
MinIO/AWS/R2/B2를 사용한다. S3 업로드와 다운로드 바이트는 각각 presigned PUT/GET으로
클라이언트와 오브젝트 스토리지 사이를 직접 흐르며, MomoServer는 세션 발급·채널
membership·HEAD 메타 검증·메시지 결속만 소유한다. Postgres는 계속 첨부 lifecycle과
권한의 SoT이고 capability query와 S3 자격증명은 DB·로그·감사 원장에 유입하지 않는다.

### Signed webhook ingress

ADR-0115의 외부 수신 경로는 두 모드가 같은 원장을 사용한다. native는
`POST /v1/webhooks/{workspace}/{installation}`에 per-install HMAC-SHA256과
key ID/timestamp/delivery ID를 보내며 5분 replay window를 강제한다. DB에는
server master와 domain-separated KDF에 넣을 opaque key reference만 남고, 파생
secret은 발급·회전 응답에서 한 번만 보인다. Slack-compatible은
`POST /hooks/{token}`의 URL 자체가 시크릿이며 전체 token 대신 SHA-256만 저장한다.
전역 요청 logger는 이 경로를 `/hooks/[REDACTED]`로 치환한다.

Slack 변환기의 v0 화이트리스트는 Mattermost 선례와 같은 top-level `text`,
legacy `attachments`의 `fallback/color/pretext/author_name/author_link/author_icon/
title/title_link/text/fields/image_url/thumb_url/footer/footer_icon` 및 field의
`title/value/short`다. `<url|text>`, `<@member>`, `<!channel>`을 번역하고,
`<!everyone>`/`<!here>`/legacy pipe mention은 평문으로, `*bold*`는 그대로
렌더한다. Mattermost 선례와 동일하게 **미지원 필드(mrkdwn/parse/link_names,
username/icon_* identity override, attachment `ts`/`mrkdwn_in`, unknown 키)는
거부가 아니라 무시**해 기존 Slack 도구가 URL 교체만으로 동작하게 한다(username/
icon override를 무시함으로써 author 사칭도 차단). **`blocks`만 명시적 400**이다.

두 모드 모두 검증 뒤 `webhook_receipt`와 deterministic `client_msg_id`,
`channel_seq` bump, `message`, broadcast `outbox`를 한 tenant transaction에서
기록한다. 설치별 전용 service member가 author가 되며 props의
`source=external_webhook`이 사람/실제 agent output과 구분한다. 이 멤버는
schema_v0 호환을 위해 `agent` 저장 타입을 쓰지만 agent row·token·provider·실행
권한은 갖지 않는다. relay만 outbox를 Centrifugo에 publish한다.

### Work v0 run 표면

ADR-0111의 Work는 새 실행 개체가 아니라 기존 `agent_run`이다. active human channel
member는 `POST /v1/workspaces/:ws/channels/:ch/agent-runs`에 target agent,
`clientRunId`, `{type:"work",title,brief,repo?,branch?}` input을 보내며, 서버는 shape를
트랜잭션 전에 검증한다. 한 tenant transaction이 run, gateway `agent_job`, private
`agentwork:` wake-up outbox, audit을 함께 기록한다. 실행은 항상 target agent의 BYOA
호스트에서 이루어지고 provider·repo 자격증명은 oort에 들어오지 않는다.

같은 channel route의 GET은 Work run 목록, `GET /v1/workspaces/:ws/agent-runs/:run`은
해당 채널에서 볼 수 있는 agent run의 상세 projection을 제공한다. 사람의 두 읽기 경로는
active channel membership를 요구하고, agent bearer에는 공개되지 않는다. gateway callback은
계속 bearer actor의 자기 run에만 결속된다. approval callback은
`read_only|workspace_write|network_write` tier를 approval payload와 timeline card metadata에
보존하며 danger 상당 값은 400으로 fail-closed한다.

`GET /v1/workspaces/:ws/agents/:agent/runs`는 같은 `agent_run`을 에이전트별로 모은
워크스페이스 전역 최신순 cursor 목록이다. 호출자는 active human workspace member여야
하고, 각 run은 호출자가 현재 속한 채널로 다시 필터된다. 채널 목록과 공통 요약 필드 선택을
공유하되 전역 응답은 id/status/time/channel/200자 trigger summary만 보내며
input/output/error·gateway payload·전문 transcript는 기존 권한부 detail 경계에 남긴다.

### Interactive Work Console session ledger

ADR-0114의 `work_session`은 user-owned execution host의 프로세스를 실행하거나 복제하는
개체가 아니라, 채널에 공유할 최소 lifecycle 원장이다. active channel member가
`POST /v1/workspaces/:ws/work-sessions`로 host ID·tool·label을 보내면 서버는 기존
`channel_seq`를 한 번 올려 system root card, session row, `message.new`,
`work.session.started`를 한 tenant transaction에 기록한다. root card의 기존 message
thread가 협업 표면이므로 별도 session comment 모델은 없다.

owner의 `PATCH .../work-sessions/:session {status:"ended"}`는 session lifecycle과 card
props를 갱신하고 `work.session.ended`를 같은 transaction에 기록한다. 이 projection은
card의 기존 `message.seq`를 재사용하므로 `message.new`가 소유한 Centrifugo version과
경합하지 않도록 publish `version`을 보내지 않으며, Core replay cursor도 전진시키지
않는다. Postgres가 lifecycle/history의 SoT이고, cwd·worktree/path·PID/process state·
terminal output·provider credential은 계속 host-local이다. `host_id`는 ADR-0125의
`work_host` registry FK이며, 활성·미철회 host와 tenant/scope 결속을 REST 경계에서 검증한다.

ADR-0125 D11의 host-loss fallback은 NotifierWorker의 기존 bounded polling에만 가산된다.
`MOMO_HOST_OFFLINE_GRACE_S`(기본 90초)를 넘긴 running session은 같은 transaction에서
`work.session.orphaned` outbox와 감사 원장을 남긴다. 유효 정책은 member override→workspace
default→`ask` 순이다. `ask`는 같은 root thread에 기존 `approval_request` 문법의
`resume_offer`를 쓰고 notifier가 `momo.work` id-only push를 만든다. `t1_only`는 카드 없이
ended(orphaned)로 닫고, `auto`는 허용된 active target에 새 session과 기존 spawn control을
직접 기록한다. human owner의 `POST .../work-sessions/:id/resume`도 같은 경로를 재사용하며,
새 row의 `resumed_from_session_id`와 동일 `root_message_id`만으로 git 재개 계보·스레드 지속을
표현한다. clone/prompt/process/PTY와 경로·자격증명 이전은 host 책임이며 서버 원장에 없다.

### Interactive Work Console control gate

ADR-0114 D4/D5의 `work_control`은 agent bearer가 자기 `queued|running` run과 channel에
결속해 요청하는 closed control 원장이다. `spawn` payload는 `tool+label`, `input`은
`text`, `read`는 optional `tail_lines`, `kill`은 빈 object만 허용하며 migration CHECK와
route 검증이 path/cwd/env/process state/provider credential을 함께 거부한다.
`target_host_id`는 등록·활성·미철회 `work_host` FK다. member scope는 owner의 세션만,
workspace scope는 같은 workspace 멤버의 세션을 수용하며 control 생성 시 이를 검증한다.

`spawn`은 owner의 tool별 `work_auto_approve` whitelist가 있으면 즉시 dispatch되고,
없으면 기존 `approval` + `approval_request` system card 경로를 거친다. whitelist 변경과
audit은 한 tenant transaction이다. linked approval이 pending/denied이면 host ack로
우회할 수 없고, 승인 decision transaction만 control을 dispatch할 수 있다. `input`과
`kill`은 같은 requester가 승인·ack한 running session 계보에서만 승인 없이 dispatch되며,
`read`는 같은 계보 확인만 하고 session 종료 뒤에도 허용한다.

`work.control.dispatched|acked`는 card/message ordering과 독립인 no-version projection이다.
각 outbox는 control/event별 고유 idempotency key를 가지며 Core replay cursor를 전진시키지
않는다. 성공한 spawn ack는 owner/channel/host가 일치하는 running `work_session` FK를
결속한다. 따라서 Postgres가 control/approval/session history의 SoT이고 Centrifugo는
전송계층으로만 남으며, Relay와 canonical REST message write path는 변경되지 않는다.

AgentWorker는 Hermes/OpenAI-compatible function surface에 `work_spawn`, `work_input`,
`work_read`, `work_kill`을 closed schema로 추가하고 MOMO-484의 기존 `POST work-controls`만
호출한다. 현재 channel과 v0 host ID는 모델이 선택하지 못하며 run context와 worker-local
설정에 고정된다. 호출 credential도 agent별 raw bearer를 process env로만 받아 DB/job payload에
복제하지 않는다. pending spawn은 승인 대기 thread 답글로 해당 run을 끝내며, 승인 decision은
control dispatch만 수행하고 일반 tool approval처럼 worker run을 재개하지 않는다. 이후 상태는
session card와 `work.control.*`/`work.session.*` event가 담당한다. 성공한 spawn/input/kill은
채팅 성공 문구를 만들지 않고 `work_read` 결과만 normal response body에 포함하며, 서버가 돌려준
계보 위반 HTTP 403은 축약하거나 성공으로 바꾸지 않는다.

### Work Host Fabric v0 daemon

ADR-0125 D1/D2의 `momo-workd`는 사용자 호스트에서 실행되는 outbound-only 프로세스다.
최초 실행은 로컬에 mode `0600` Ed25519 raw private key를 만들고, 일회성 human bearer로
`type=workd` host를 등록한 뒤 bearer 파일을 삭제한다. 이후 heartbeat는
`momo.work_host.heartbeat.v1` 바이트 계약을, pending poll·session 생성/종료·control ack는
`momo.work_host.request.v2`의
`method/path/workspace/host/timestamp/raw-body-SHA-256/request-ID` 계약을 서명한다. request
ID는 workspace별로 원자적으로 한 번만 소비하고 5분 허용 창보다 긴 10분 동안 보관하며,
인증 시 만료 행을 정리한다. v1 병행 수용은 본문 교체·재전송 결함을 그대로 열어 두므로
허용하지 않는다. self-host 배포는 서버와 데몬을 한 릴리스 단위로 갱신하며 버전 불일치는
401로 fail-closed한다. 서버는 이 서명 주체에 pending poll·work-tool profile 조회·session
생성/종료·control ack·terminal attach validation의 정확히 여섯 REST action만 허용하며
revoke와 owner 활성 상태를 요청마다 재검증한다.

데몬은 `GET .../work-hosts/:id/pending-controls`로 자기 앞 `dispatched` 행만 polling한다.
`spawn`은 기존 session REST를 먼저 기록한 뒤 profile의 host-local PTY 또는 ACP stdio
subprocess를 시작하고, `input`은 PTY stdin 또는 ACP `session/prompt`, `kill`은 terminate와 session end REST로 처리한다. effect 뒤 ack 응답이
유실돼도 같은 control을 중복 실행하지 않도록 로컬 control/session 결속을 유지한다. command
template, environment, key/path/PID와 stdout/stderr는 host-local이며 raw 출력은 mode `0600`
파일에만 남는다. ACP `session/update`는 카드 최소 공통분모로만 투영하고 extension은 `_meta`
host-local 저장이며, permission은 human decision 전 fail-closed한다. Centrifugo control
subscription은 후속 범위다.

### oort Cloud T3 provisioner + active-time ledger

ADR-0136의 T3는 opt-in 경로이고, ADR-0142가 그 실행 주체를 **이원화**했다. 호스트를
얻는 길은 두 가지이며 **수명주기·과금·관찰은 획득 경로와 무관하게 동일하다.**

- **BYOC(기본형)**: 워크스페이스 운영자가 자기 VM에 `momo-workd`를 설치하고 oort가 발급한
  1회 토큰으로 등록한다. oort는 그 호스트를 만들지도 부수지도 않는다 — 등록·배정·관찰·과금만
  한다. 등록 단위는 워크스페이스 공용이며, personal은 스키마가 아니라 REST에서 닫는다.
- **관리형 provider**: 어댑터가 같은 등록 흐름을 자동으로 수행한다. 어댑터의 유일한 추가
  권한은 "인스턴스를 만들고 부수는 것"이다.

어댑터 계약(`services/CloudProviderKit`)은 `create`/`pause`/`resume`/`destroy`/`probe`이고
MomoServer와 NotifierWorker가 **같은 정의**를 컴파일한다. provider별 사실(pause 지원 여부,
resume이 메모리를 보존하는지, 연속 실행 상한, 동시 실행 한도)은 전부 `capabilities` 선언에
있으며 **정책 코드가 provider 상수를 아는 것은 금지**된다. 지원하지 않는 연산은 흉내내지 않고
capability로 선언하고 거부한다. `probe`는 존재/부재/**불명** 3값이다 — "물어보지 못했다"를
"사라졌다"로 바꾸면 유료 세션이 조용히 정산되기 때문이다.

`work_cloud_host.provider`는 이 레지스트리의 키다(migration 054에서 단일 벤더 CHECK 제거,
default 제거 — provider를 말하지 않은 행은 아무도 조정할 수 없는 행이다). 사용자가 유료
cloud를 명시 확인하면 서버가 먼저 workspace credit과 `work_pool` slot을 잠금 검사하고,
`work_cloud_host(state=provisioning)` 예약을 만든 뒤 어댑터가 인스턴스를 생성한다.
provider 운영자 키는 인스턴스 운영자 process env에만 있고 tenant 설정·DB·응답·로그로
내려가지 않는다(ADR-0004). 인스턴스의 `momo-workd`는 15분짜리 1회 bootstrap token을
소비하면서 자체 Ed25519 키로 `work_host(type=cloud, scope=workspace)`를 등록한다. DB에는
token digest만 남고 private key는 인스턴스 밖으로 나오지 않는다.

연속성에 필요한 상태는 provider 안에 두지 않는다. 스냅샷·pause 이미지는 최적화이고 원본은
git(계보·WIP)과 oort 원장이다. 따라서 **교차 provider 재개는 별도 절차가 아니라 기존 재개
경로 그 자체**이며, 어댑터가 죽음을 정직하게 보고하는 것이 그 전제다(ADR-0142 D3).

T3 session 생성은 host당 미정산 1건 partial unique 아래 `work_host_usage` 한 행과 첫
`work_host_usage_interval(state=active)`을 같은 tenant transaction에서 연다. pause는 어댑터
pause 성공 뒤 active interval을 닫고 `state=paused` 구간을 열며, resume은 paused 구간을
닫고 새 active 구간을 연다. 새 구간의 `started_at`은 직전 구간의 `ended_at`과 같은 시각이라
경계에 틈도 겹침도 없다. interval의 generated `active_micros`는 active일 때만 wall time이고
paused이면 구조적으로 0이다(마이그레이션 058 전에는 초 단위 `active_seconds`였고, 구간마다
floor해서 pause 경계마다 최대 1초씩 유실됐다 — MOMO-661). session 종료 transaction은 열린
구간을 닫고 **마이크로초 합계를 한 번만 floor해** `work_host_usage.active_seconds`(=청구
초)를 고정한다. 즉 `active_seconds`는 이제 Σfloor(구간)이 아니라 floor(Σ구간)이며, 절사는
정산 1회로 제한된다(058 이전에 정산된 행은 소급 재계산하지 않는다 — `active_micros IS NULL`이
그 표식이다). 그 초 수와 시작 시 snapshot한 초당 단가로 append-only
`credit_entry(reason=t3_usage)`를 기록한다. terminal/orphan 경로는
`settle_t3_work_session` 한 primitive로 이 정산과 cloud slot 해제·destroy intent를
원자화한다. provider 호출은 DB 밖에서 intent UUID idempotency key로 실행되고
NotifierWorker reconciler가 `pausing|resuming|destroy_pending` 및 미확정 provisioning을
수렴시킨다. trigger가 `workspace_credit` balance를 갱신한다. 잔액 소진은 새 T3만 막고
이미 실행 중인 session은 종료시키지 않는다. paused host는 stale heartbeat sweep에서
제외되지만 `idle_at` timeout에서는 heartbeat 없이 terminal 정산된다.
`usage_ledger`는 계속 모델 요청/토큰 비용 전용이다.

### Remote PTY attach control plane

ADR-0125 D10에서 원격 host/workd/provisioner는 도구를 PTY로 `create`하고 안정적인
`pty_id`와 credential-free HTTPS/WSS `attach_endpoint`를 signed `work_session` 생성 요청에
결속한다. 같은 `pty_id`에 대한 `connect`, `send_stdin`, `resize`, `kill`이 하나의 세션을
조작한다는 것이 provider-중립 추상 계약이며, 실제 host PTY adapter는 후속 구현이다.

human bearer는 `POST /v1/workspaces/:ws/work-sessions/:id/terminal-attach`에
`mode=controller|observer`를 요청한다. 기본 controller는 기존처럼 세션 소유자 전용이고,
observer는 같은 workspace의 active human이면서 세션 채널 멤버이고 세션
`observation=open`일 때만 발급된다. 소유자는 PATCH로 observation을 `open|owner_only`로
바꿀 수 있으며 owner_only 전환은 기존 observer grant도 즉시 무효화한다. 서버는 60초
ephemeral capability를 발급해 `{attach_endpoint, capability_token, pty_id}`를 한 번 응답하고,
DB에는 SHA-256 digest와 발급·만료·수령 human·mode만 남긴다. audit에도 raw token은 없다.

host의 signed validation은 capability 만료, running session, PTY binding,
`work_host.revoked_at`, 수령 human의 active/channel membership, observation과 mode를 매 요청
다시 확인하고 mode를 응답한다. host는 observer 연결에서 stdout만 허용하며 send_stdin,
resize, kill을 거부한다. 따라서 이미 발급된 capability도 host revoke나 observer 권한 상실에
즉시 무효다. 세션 read projection은 raw endpoint/token 없이 `observation`, 현재 유효한
`observerGrantCount`, PTY 결속 여부인 `remoteAttachAvailable`만 제공한다. observer 발급 시
count-only `work.session.observer` 이벤트가 transactional outbox를 거치며 terminal raw는
여전히 이 이벤트에 포함되지 않는다.

```mermaid
sequenceDiagram
    participant C as macOS / SwiftTerm
    participant S as MomoServer
    participant P as PostgreSQL
    participant H as Remote PTY host
    C->>S: POST terminal-attach (human, controller|observer)
    S->>P: token digest + issued/expires/grantee/mode audit
    S-->>C: endpoint + raw capability + pty_id
    C->>H: direct WSS/HTTPS connect (capability, pty_id)
    H->>S: signed capability validation
    S->>P: expiry/session/revoke check
    S-->>H: validated pty_id + expires_at + mode
    H-->>C: PTY output bytes (direct only)
    opt controller only
        C->>H: stdin / resize / kill (direct only)
    end
```

MomoServer에는 terminal WebSocket, stdin/stdout, resize, publish, outbox route가 없고 Relay와
Centrifugo도 이 데이터 경로에 참여하지 않는다. 서버는 capability control plane만 담당하며
터미널 raw 바이트는 client↔host 직결로만 흐른다.

### 관전 라이브 화면 (display attach, ADR-0165)

같은 capability 기계가 **두 번째 kind**를 갖는다. PTY가 터미널 바이트를 client↔host 직결로
흘리듯, display는 **화면 프레임을 WebRTC로 browser↔sandbox 직결**로 흘린다(ADR-0165 D1/D2).
서버는 여기서도 아무것도 나르지 않는다 — 미디어는 물론 **시그널링도 경유하지 않는다**.
새 표를 만들지 않은 것이 설계의 요점이다: `terminal_attach_capability.kind`(마이그 075)가
`pty | display`이고, 발급·검증·sweep·관전자 계수·RLS·revoke 조인이 각각 하나뿐이라 "host를
회수했으니 관전이 끊긴다"가 절반만 참이 되는 상태가 존재할 수 없다.

세 가지가 PTY 축과 다르고, 셋 다 의도적이다.

1. **display에는 observer와 controller가 있고, control은 창(window)을 연다.**
   LIVE-1까지 display는 observer 전용이었다 — 입력 경계가 ADR-0004 증보 3의 미결 결정이었고,
   잠금장치는 라우트가 아니라 스키마(075의 `terminal_attach_display_observer_ck`)였다.
   2026-08-15 그 증보가 Accepted 되면서 마이그 076이 그 절을 지웠고, 세 층(스키마·
   `AttachKind::permits_mode`·라우트)이 075 주석의 약속대로 함께 움직였다.
   잠금이 사라진 자리에 들어온 것은 **부재가 아니라 원장**이다. controller 발급은
   ① **세션 owner 한정**(증보 3 D1 — control은 자기 세션에 대한 사람의 행위이며, PTY
   controller의 `c.owner_member_id = ws.member_id` 술어를 그대로 재사용한다),
   ② **`display_control_window` 행 개설**(076 — 경계 이벤트의 SoT), ③ **그 창이 서 있는 동안
   에이전트의 그 세션 접근 거부**(증보 3 D3의 비관측) 세 가지를 한 트랜잭션에서 한다.
   view-only 쪽 계약은 그대로다: producer는 **입력 datachannel을 아예 개설하지 않으며**(D4),
   개설 여부는 클라이언트 플래그가 아니라 서버의 `input_enabled` 응답이 정한다.
2. **바인딩을 host가 직접 게시한다.** workd는 `POST …/work-sessions/{s}/display-binding`
   (work-host 서명)으로 `display_id` + credential-free 시그널링 WS URL을 한 번 등록한다.
   human bearer는 이 경로에서도, 세션 create/PATCH의 같은 이름 필드에서도 거절된다. 경로가
   host가 아니라 session을 지시하므로 서명자 핀(= 세션의 host와 동일해야 한다)은 핸들러가
   원장을 읽어 건다 — `…/work-controls/{c}/ack`와 같은 형태다.
3. **광고 없는 host에는 발급하지 않는다(fail-closed).** `work_host.capabilities.display_attach`
   가 참일 때만 발급·검증이 성립한다. BYOC는 provider 이름을 검사해서가 아니라 **momo가
   이미지를 굽지 않으므로 아무것도 광고하지 않기 때문에** 자동 배제된다(불변식 #7 — 정책
   코드는 provider 신원을 알지 못한다).

세션 read projection은 raw `display_endpoint` 없이 **`remoteDisplayAvailable`** 하나만
제공하며(`remoteAttachAvailable`의 동형이자 독립 값 — 화면만 있고 터미널이 없는 세션이
정상이다), 관전자 수는 kind를 구분하지 않는 하나의 숫자다. 프레임은 서버·원장·audit 어디에도
들어가지 않고 녹화도 없다(D5). ICE는 직결/host-reflexive 1차이며 제3자 TURN은 금지다(D3).

`observation = owner_only`의 뜻도 이 파도에서 확정됐다: **「소유자만 본다」**(「아무도 못 본다」가
아니다). LIVE-1은 display에 controller 등급이 없어 owner까지 막았고 그것을 미결로 명시해
두었는데, 증보 3이 답을 주면서 display observer 발급·검증의 observation 절에 owner 예외가
들어갔다. 예외는 `kind = 'display'`로 좁혀져 있다 — PTY는 owner가 controller로 자기 세션에
붙으므로 애초에 같은 문제가 없었다. control이 에이전트를 정지시키는 지금은 이 예외가 더
중요하다: 보기만 하려는 owner가 자기 에이전트를 세우지 않아도 되게 하는 유일한 경로다.

### control 창과 비관측 (ADR-0004 증보 3)

control 창이 서 있는 동안 지켜지는 것은 **에이전트가 그 세션을 관측할 수 없다**는 사실이며,
이것은 선언이 아니라 **거부**다. 에이전트가 work session에 닿는 서버 경로는 하나뿐이므로
(`POST /v1/workspaces/{ws}/work-controls` — agent bearer 전용이고 `read`가 화면 읽기,
`input`이 키보드다. attach 두 라우트는 모두 `require_human`이라 에이전트는 관전 capability
자체를 받을 수 없다) 그 한 곳을 막으면 관측 경로 전체가 막힌다. 두 층으로 건다:

- **거부** — `work_controls::create`가 창 활성 세션에 대해 409. 모든 쓰기보다 위에서 거부하므로
  거부된 시도는 `work_control` 행도 audit도 남기지 않는다(= "에이전트가 보지 않았다"가 원장에
  대한 진술이 된다).
- **보류** — 창이 열리기 직전 dispatch된 제어는 `pending_controls_for_host_in_tx`가 **withhold**
  한다. 실패시키지 않고 보류하므로 창이 닫히면 다음 poll에서 그대로 전달된다(증보 3 D4의 재개).

창은 세 경로로 닫히고 셋 다 멱등이다 — **반환**(owner의 명시 REST `DELETE …/display-control`,
`end_reason=returned`) · **lease 만료**(producer가 재검증을 멈춤, `expired`) · **세션 종료**
(`session_ended`). lease가 capability의 `expires_at`이 아닌 것이 중요하다: 60초 TTL은 **dial**
창이고 `stream:true` 재검증은 만료 절만 완화하므로, 창을 그 타임스탬프에 매면 사람이 로그인하는
도중 60초에 에이전트가 재개된다. lease는 그 재검증이 갱신하므로 **producer가 스트림이 살아
있다고 말하는 동안** 창이 열려 있다.

VM은 움직이지 않는다(증보 3 D6): `work_session.status`도 ADR-0140 상태기계도 무변경이고
running-time 과금도 계속된다. 멈추는 것은 런 층의 도달 범위뿐이다. 사람이 입력한 자격증명은
전사·audit·Memory Plane 어디에도 들어가지 않으며(D2), 원장은 누가·언제·왜 닫혔는지만 갖는다 —
키 입력을 담을 칸이 없다.

```mermaid
sequenceDiagram
    participant B as Browser (LIVE-2)
    participant S as momo-server
    participant P as PostgreSQL
    participant V as Sandbox (workd + WebRTC producer)
    V->>S: POST display-binding (host-signed, once)
    S->>P: display_id + credential-free signalling URL
    B->>S: POST display-attach (human; observer, or controller if owner)
    S->>P: token digest + issued/expires/grantee/kind
    S->>P: controller only — open display_control_window (076)
    S-->>B: signalling endpoint + raw capability + display_id
    B->>V: direct WSS signalling (momo.display.v1, capability)
    V->>S: signed capability validation (every 30s)
    S->>P: expiry/session/revoke/observation/advertisement check
    S->>P: controller only — renew the window lease
    S-->>V: validated display_id + expires_at + input_enabled
    V-->>B: WebRTC video, sendonly (input datachannel only if input_enabled)
```

```mermaid
sequenceDiagram
    participant H as 사람 (세션 owner)
    participant S as momo-server
    participant P as PostgreSQL
    participant A as 에이전트 (run)
    participant V as Sandbox VM
    H->>S: POST display-attach {mode: controller}
    S->>P: controller grant + display_control_window OPEN
    S-->>H: control_started_at (경계 이벤트)
    S-->>A: work.session.control {state: opened} — 정지 시각만
    A->>S: POST work-controls {kind: read}
    S-->>A: 409 work session is under human control
    Note over A,V: 에이전트는 프레임도 키도 보지 못한다 (증보 3 D3)
    Note over H,V: 사람 ↔ VM 직결. 비밀번호는 서버를 지나지 않는다 (D2)
    Note over S,V: VM은 running 유지, 과금 계속 (D6)
    H->>S: DELETE display-control (반환)
    S->>P: window CLOSED (end_reason=returned)
    S-->>A: work.session.control {state: closed} — 재개 시각
    A->>S: POST work-controls {kind: read}
    S-->>A: 201 — 보류됐던 제어도 다음 poll에서 전달
```

웹 소비(관전 UI)는 LIVE-2 소관이고, **직접 조작 UI는 LIVE-4 소관**이다 — LIVE-3은 서버 계약과
원장과 게이트까지다. sandbox 템플릿 사양은 `infra/cubesandbox/display-template/`에 있고, 그
producer는 아직 **`runtime-unverified(cubesandbox webrtc producer)`** — microVM을 빌드·기동해본
바 없고, 브라우저가 sandbox에 도달할 수 있는지(ingress·ICE)는 미실측 미결이다. 입력 전달도
마찬가지로 **`runtime-unverified(input delivery)`**: `input_enabled: true`를 읽고 datachannel을
열어 키를 넣어 본 producer도, 반환 시 그 채널을 닫아 본 producer도 아직 없다. 서버 절반(발급·
창·게이트·`input_enabled`)은 실제 PostgreSQL 대상 conformance로 증명돼 있고, 화면 절반은 아니다.

## 에이전트 1회 응답의 수명주기 (이중 경로)

```mermaid
sequenceDiagram
    participant U as 사람 (macOS)
    participant S as MomoServer
    participant P as Postgres
    participant R as Relay/Centrifugo
    participant W as AgentWorker (managed)
    participant H as Hermes gateway

    U->>S: POST messages ("@hermes ...")
    S->>P: 한 트랜잭션: message + seq + agent_run(queued) + agent_job outbox
    alt AGENT_GATEWAY_MODE=worker (managed)
        P-->>W: durable agent_job claim
        W->>W: provider OpenAI-compatible SSE
        W->>P: oort-owned progress / approval / usage / outbox transitions
    else AGENT_GATEWAY_MODE=gateway (BYOA)
        P-->>R: relay: agent.job → private agentwork: wake-up
        R-->>H: push (신뢰 입력 아님)
        H->>S: Bearer(agent) GET /gateway/jobs/pending (atomic claim)
        loop provider turn + callback
            H->>S: POST /gateway/jobs/:job/lease/renew
            S-->>H: bounded lease expiry
        end
        H->>S: Bearer(agent) POST /gateway/events
        H->>S: Bearer(agent) POST /gateway/complete
    end
    opt write/spend/admin tool proposal
        S->>P: approval 생성 + run awaiting_approval
        P-->>R: approval.requested
        Note over S,H: human decision 뒤 resume outbox; 두 경로 동일 상태머신
    end
    S->>P: 한 트랜잭션: agent 명의 message + usage_ledger + audit_log + run 종결 (멱등)
    P-->>R: message.new broadcast
    R-->>U: 같은 채널에 응답 표시
```

`agent:`는 공유 채널 멤버가 보는 status/partial progress만 전달하고,
Context Packet을 담은 `agentwork:`는 exact agent bearer만 구독한다. Slack 봇 대비
실질 우위는 `agent_job`이 durable outbox 행이라 at-least-once 회수 가능하고,
최종 응답·비용·감사가 원자적으로 기록된다는 점이다.
`agentwork:` publication은 DB 작업이 있다는 wake-up일 뿐 신뢰 입력이 아니다.
어댑터는 bearer-authenticated pending endpoint에서 작업을 재조회하고, connection
JWT의 `meta.token_id`와 active token 행이 일치할 때만 private stream을 구독한다.

### 서버 소유 보장 매트릭스

| 보장 | 단일 권위 | managed worker | BYOA gateway |
|---|---|---|---|
| 신원·테넌시 | agent member, workspace/channel, token scope, actor/run binding | run-bound worker job | 동일 agent의 scoped `agent_bearer` |
| Context | 서버가 grants/redaction/tool policy/budget 검사 후 bounded packet 생성 | claim payload | actor-bound pending REST payload |
| 승인 | `agent_run` + `approval` + human decision + resume outbox | worker pause/resume | approval callback/resume job (MOMO-349) |
| 비용·감사 | budget/`usage_ledger`/`audit_log` 서버 커밋 | SSE usage evidence | completion usage evidence |
| progress | 서버 검증 후 `agent:`에 status/partial publish | SSE delta | bounded callback delta (MOMO-350) |
| 순서·복구 | Postgres SoT, `message.seq`, transactional outbox | SKIP LOCKED retry | realtime wake-up + actor-bound SKIP LOCKED claim; 30s renewable single-owner lease + expiry takeover |

MOMO-352는 같은 trigger→approval→resume→final 시나리오를 두 경로로 실행해 이 매트릭스의 동등성을 검증한다. 349/350/341/352가 열려 있는 동안 해당 gateway 셀은 Accepted ADR의 규범 계약이지 완료 evidence가 아니다.

### SD-5와 agent identity

ADR-0102는 `POST /v1/auth/realtime-token`, `GET /v1/workspaces/:ws/agents/:agent/gateway/jobs/pending`, `AGENT_GATEWAY_MODE=worker|gateway`를 Option C의 공식 API/운영 표면으로 소급 승인한다. MOMO-341은 pending GET을 원자 claim으로 강화하고 exact-owner `POST .../jobs/:job/lease/renew|release`를 추가했다. 두 경로는 ADR-0101의 `agent_bearer`로 수렴하며 gateway callback도 actor/run/job/lease binding을 강제한다.

legacy `X-Momo-Agent-Gateway-Secret`는 기본 거부(`MOMO_ALLOW_LEGACY_GATEWAY_SECRET=0`)인 이관 회귀 경로뿐이다. MOMO-349/350/341 반영 + MOMO-352 clean/root equivalence PASS 직후 별도 보안 정리에서 legacy header와 `AGENT_GATEWAY_SECRET`/flag를 제거하며, 늦어도 M7 진입 전에 끝낸다.

## 엔티티 지도 (요약)

```mermaid
erDiagram
    workspace ||--o{ member : has
    member ||--o| human : "1:1 subtype"
    member ||--o| agent : "1:1 subtype (model·tool_schema·run 상한)"
    workspace ||--o{ channel : has
    member ||--o{ membership : joins
    channel ||--o{ membership : contains
    channel ||--o{ message : contains
    member ||--o{ message : "authors (사람=에이전트 대칭)"
    channel ||--o{ work_session : "durable lifecycle"
    member ||--o{ work_session : owns
    message ||--o| work_session : "system root card"
    message ||--o{ agent_run : triggers
    agent_run ||--o{ approval : requests
    member ||--o{ token : "agent_bearer(Phase 1 사용)·delegation(Phase 2)"
    channel ||--|| channel_seq : "gapless 카운터"
    workspace ||--o{ outbox : "broadcast + agent_job + push_candidate"
    agent_run ||--o{ usage_ledger : bills
    workspace ||--o{ workspace_plugin_install : installs
    member ||--o{ plugin_grant : delegates
    plugin_grant ||--o{ plugin_capability_projection : projects
```

핵심 패턴: **shared-PK 서브타입**(member←human/agent), **자기참조 DAG**(message 스레드, agent_run A2A 체인 — depth≤4·round≤4 DB CHECK), **트랜잭셔널 아웃박스**.

## 현재 판정 요약 (2026-07-09 감사)

| 영역 | 판정 | 비고 |
|---|---|---|
| 골격(불변식·스키마·쓰기경로) | ✅ 견고 | 재설계해도 같은 결론에 도달할 수준 |
| 에이전트 데이터 모델 | ✅ 1급 | Slack 봇 모델보다 앞선 설계 |
| 에이전트 신원/인증 | ✅ Phase 1 | 서버·어댑터·UI가 per-agent bearer·스코프·회전/폐기로 수렴(MOMO-337~339); legacy 물리 제거는 ADR-0102 게이트 뒤 |
| 에이전트 실행 경로 | ⚠️ Option C 구현 중 | gateway=BYOA / worker=managed 결정 완료; gateway parity와 동등성은 MOMO-349/350/341/352 |
| 존재감(프레즌스·타이핑·스트리밍) | ⚠️ 부분 | observable `agent:` status 기반은 있고 gateway partial parity는 MOMO-350; 상시 presence/heartbeat 의미는 ADR-0104 |
| 메신저 기본기(스레드UI·언리드·페이지네이션) | ❌ 미착수 | 스키마는 준비됨 → ADR-0109 |
| 한국어 검색 | ❌ 부적합 | pg_trgm은 CJK 재현율 낮음 → ADR-0105 |
| 배포 경계(CI·이미지·시크릿·TLS·백업) | ⚠️ 스켈레톤 | 전부 example/preflight 단계 → ADR-0107 |

## 결정 큐

ADR-0100(거버넌스, Accepted) → 0101(에이전트 신원, Accepted) → 0102(실행 경로 정본화, Accepted) → 0103(로드맵 정렬) → 0104(존재감 이벤트) → 0105(검색) → 0106(에이전트 정체성 네이밍) → 0107(CI 신뢰 경계) → 0108(서버 스택 지속 판정) → 0109(메신저 기본기 시퀀스)
