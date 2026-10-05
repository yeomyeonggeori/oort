# ADR-0162: 외부 호스팅 에이전트 수용 — Agent Port와 pairing lifecycle

- Status: **Accepted** (2026-08-12 · 성재가 제품 방향과 D1~D8의 벤더 중립 기술 경계를 승인)
- 증보: **증보 1 — OAuth lifecycle (2026-08-15, HAP-E7 #1368) · Accepted (성재 승인 2026-08-15).** Accept는 D4/D6의 OAuth 경계를 승인한 것이지 flag 개방이 아니다 — 구현은 여전히 feature flag로 완전히 닫혀 있고(metadata 미광고·모든 route 404) static bearer 경로는 byte 동일하며, flag를 여는 것은 #1369 랜딩과 runtime proof 폐곡선 뒤의 별도 운영 결정이다.
- 증보: **증보 2 — hosted 1:1 DM 승인 (2026-09-27, #2915) · Accepted (성재 결재 「권장대로」 2026-09-27).** 소유자↔자기 에이전트 1:1 DM은 자동 승인, 다른 멤버↔에이전트 1:1 DM은 에이전트 소유자가 DM 단위로 승인한다. 파일 끝 「증보 2」 절.
- 증보: **증보 3 — 호스티드 에이전트 작업 추적 (2026-10-05, #3514 AT-1) · Accepted (성재 결재 「이대로 진행」 2026-10-05).** 외부 VM에서 일하는 호스팅 에이전트의 작업 요청·진행 표식·결과 산출물·팀 보드·끝남 푸시를 기존 `agent_run`/`agent_job`·Agent Port 도구의 확장으로 정한다. 새 저장소·터미널 보기 없음. 파일 끝 「증보 3」 절.
- 관련: ADR-0100(결정 거버넌스), ADR-0101(에이전트 신원·bearer), ADR-0102(worker/gateway 실행 경로), ADR-0130(외부 에이전트 fabric·ACP), ADR-0145(Rust/Axum), ADR-0150(대화 반출 경계)
- 리서치: `docs/planning/research/2026-08-12-grok-bot-integration-feasibility.md`, `docs/planning/research/2026-08-12-grok-bot-reverse-teammate-direction.md`, `docs/planning/research/2026-08-12-external-agent-reception-audit.md`
- 제품 문장: **Bring your hosted agent.** Grok Bot은 첫 setup preset이자 실증 클라이언트이며, 코어 계약은 벤더 중립이다.

## Review Notes

- **제품·기술 결정 승인(2026-08-12, 성재):** “공식 Grok Bot 앱 설치와 ADR-0162 기술 방향을 모두 승인해.” 사용자가 이미 호스팅한 에이전트를 oort의 1급 팀메이트로 연결하는 제품 방향과, 아래 D1~D8의 Agent Port, dedicated member, pairing/active secret 분리, durable inbox, fail-closed lifecycle, disconnect/cleanup 경계를 승인했다.
- **#1344 실측:** 공식 Grok Bot `0.16.0` arm64 앱의 Developer ID 서명·Apple notarization과 서명 주체 `Anysphere Incorporated (DCNK4UB866)`를 확인했다. 팀 계정은 trial eligibility가 `true`였지만 실제 접근은 `PAYMENT_REQUIRED`, `TEAM_PRIVACY_MODE` 차단, team-enforced `NO_STORAGE`였다. 개인 계정은 별도 trial entitlement/start 문구나 결제·구독 UI 없이 Bot 생성·기본 채팅까지 동작했다. 공식 MIT `Create Plugin`으로 비공개·미게시 local plugin의 `mcp.json`에 공개 Agent Port URL을 등록하자 Grok/Cursor loader가 legacy-era `POST initialize` 뒤 `GET` fallback을 보냈고, 아직 없는 route에서 둘 다 HTTP/2 404로 끝났다. Active-off monthly routine의 수동 Test run은 약 1분 뒤 성공했고, routine은 확인 없이 삭제됐으며 connector Uninstall은 앱 목록만 제거하고 local plugin source를 남겼다. 공식 `Create Plugin` helper도 uninstall했고 Bot 영구 삭제는 취소해 Bot과 chat을 보존했다.
- **승인 범위:** 벤더 중립 Agent Port 구현은 착수할 수 있다. #1344는 Grok의 private custom-MCP transport와 manual routine 실행·개별 cleanup 표면까지 검증했지만, 404가 auth challenge보다 먼저 발생해 Grok preset의 `auth_mode`, pairing, MCP tool call, Bot disposition과 provider artifact 전체 cleanup, “Grok Bot도 연결해 사용할 수 있다” 카피는 후속 E2/E3·실계정 E2E 전까지 `runtime-unverified`다. 팀 privacy 정책을 자동 완화하거나 유료 구독을 구매하지 않는다.

## Context

oort가 지금 수용하는 에이전트는 두 실행 경로를 쓴다.

1. **관리형(managed):** oort의 worker/provider 체인이 실행을 주도한다.
2. **연동형(BYOA):** 사용자 소유 gateway 또는 self-host work host가 oort의 job을 가져간다.

Grok Bot 같은 호스팅 에이전트는 둘과 접속 방향이 다르다. 문서화된 공개 Bot roster/run/control API를 찾을 수 없고, oort가 Bot 프로세스를 spawn하거나 직접 호출할 수도 없다. 대신 Bot이 사용자가 등록한 원격 MCP 서버를 소비하고 routine으로 깨어날 가능성이 있다. 따라서 oort가 상대를 호출하는 것이 아니라 **상대 에이전트가 oort로 다이얼인해 inbox와 기존 gateway 계약을 소비**해야 한다.

현행 코드에는 재사용할 자산과 새로 만들어야 할 경계가 분명히 갈린다.

| 구분 | 현행 사실 | 이 ADR의 처리 |
|---|---|---|
| 에이전트 신원 | `member.kind='agent'`, agent bearer, scope 검사 존재 | 새 신원 종류를 만들지 않는다 |
| 메시지 쓰기 | REST → PG transaction → outbox → relay가 유일한 쓰기경로 | MCP는 이 경로의 얇은 facade다 |
| job/run | Rust gateway의 pending/lease/renew/release/events/complete가 SoT | 별도 task 상태기계를 만들지 않는다 |
| MCP 서버 | Rust router/crate에는 현행 MCP 서버가 없다 | MCP 2026-07-28 기반을 새로 만든다 |
| `/v1/mcp/drive` | OpenAPI·검증 스크립트와 은퇴 중인 Swift 구현에 남은 선례 | Rust 기반이 아니라 계약 참고 자료로만 쓴다 |
| 순서 | `message.seq`는 채널별 gapless 순번 | cross-channel inbox cursor로 쓰지 않는다 |

## Decisions

### D1. 제품 분류와 런칭 표면

실행 방식은 다음 세 부류로 설명한다.

| 분류 | 실행 주체 | oort 접속 방식 |
|---|---|---|
| **관리형(managed)** | oort worker/provider | 서버가 실행·배정 |
| **연동형(BYOA)** | 사용자 self-host agent/work host | gateway 또는 ACP v1 stdio host |
| **다이얼인형(dial-in)** | 외부 hosted agent | 원격 Agent Port를 pull |

다이얼인형은 새 `member.kind`가 아니라 **connection mode**다. 제품의 상위 문장은 “Bring your hosted agent”, 첫 preset은 Grok Bot으로 둔다. Grok 전용 route, schema, token type은 만들지 않는다.

ACP는 이 원격 수용 표면이 아니다. ACP v1은 trusted self-host host가 로컬 agent 프로세스와 stdio로 대화하는 경로이고, Agent Port는 외부 호스팅 에이전트가 HTTPS로 oort를 소비하는 경로다.

### D2. Agent Port는 MCP 2026-07-28 modern core와 좁은 legacy compatibility를 함께 제공한다

- 공개 표면은 `/v1/mcp/agent-port`의 MCP Streamable HTTP endpoint다. modern core는 `2026-07-28`을 exact pin하고 `server/discover`를 반드시 구현한다.
- 서버는 세션 메모리에 권한이나 cursor를 두지 않는다. 각 요청은 인증·workspace·agent·membership·scope를 다시 검증한다.
- 장기 연결에 의존하지 않는다. polling 요청의 서버 대기 상한은 구현 티켓에서 짧게 고정하며, timeout 뒤 클라이언트가 cursor로 재접속한다.
- modern 요청은 모든 POST의 `params._meta`에 protocol version·client capabilities를 싣고, client info는 optional로 받아 존재할 때 검증한다. HTTP의 `MCP-Protocol-Version`·`Mcp-Method` mirror와 body를 exact 비교한다. `initialize`, `notifications/initialized`, `ping`, protocol session, `Mcp-Session-Id`, 독립 GET stream은 modern contract에 존재하지 않는다.
- #1344에서 Grok Bot `0.16.0`이 legacy-era `initialize`와 GET fallback을 실제 보냈으므로, 같은 endpoint에 **exact `2025-11-25` compatibility adapter**를 둔다. adapter는 `initialize`, `notifications/initialized`, `ping`, 빈 `tools/list`와 빈 catalog의 unknown `tools/call` 오류만 허용하며 session id를 발급·저장하지 않고 각 요청을 다시 인증한다. standalone GET/DELETE는 `405`다. 다른 legacy version·method는 지원 목록과 함께 fail-closed한다. #1344는 initialize body/version을 수집하지 않았으므로 Grok이 실제 제안한 버전이 `2025-11-25`라고 주장하지 않는다.
- era는 요청 shape와 explicit version으로 판별한다. recognized modern error 뒤 legacy로 조용히 강등하지 않는다. Grok이 initialize에서 제안한 exact version은 body를 기록하지 않은 이번 404 실측으로는 알 수 없으므로, adapter 상호운용은 HAP-E2의 redacted runtime evidence로 닫는다.
- transport/version negotiation과 discovery는 공식 [2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog), [versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning), [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), [server/discover](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)를 기준으로 한다. legacy adapter는 공식 [2025-11-25 lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)과 [transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)만 구현한다. 은퇴한 Swift Drive MCP의 2025-06-18 wire shape를 복사하지 않는다.
- rate limit, audit, payload bound, replay bound를 foundation 수용기준에 포함한다.

### D3. 도구는 기존 메시지·gateway 계약의 얇은 바인딩이다

Agent Port v0의 capability는 세 묶음이다. 최종 tool 이름과 JSON schema는 구현 전 OpenAPI/MCP contract issue에서 봉인한다.

1. **Inbox:** 내구 cursor 이후의 mention·assignment·subscription event를 읽는다.
2. **Conversation:** 권한 있는 channel/thread를 읽고, 필수 idempotency key로 메시지를 게시한다.
3. **Gateway:** 현행 pending claim, lease renew/release, run events, complete를 그대로 호출한다.

모든 Agent Port 요청은 route reachability scope `agent:port:connect`를 먼저 요구하되, 이 scope 하나는 product tool 권한을 주지 않는다. v0 tool→scope mapping은 닫힌 목록으로 고정한다.

| tool | 추가로 필요한 scope | 정책 |
|---|---|---|
| `oort_inbox_read` | `agent:inbox:read` (신규) | non-default |
| `oort_conversation_read` | `messages:read` (신규) | non-default |
| `oort_message_post` | `messages:write` (기존) | 기존 write authority 재사용 |
| `oort_jobs_claim`, `oort_job_renew`, `oort_job_release` | `agent:jobs:read` (기존) | 기존 claim/lease authority 재사용 |
| `oort_run_event`, `oort_run_complete` | `agent:runs:callback` (기존) | 기존 callback authority 재사용 |

`agent:port:connect`, `agent:inbox:read`, `messages:read`는 모두 credential 기본 scope가 아니다. hosted activation이 사람이 승인한 exact scope만 발급하고, `tools/list`는 active connection·current membership·위 scope 교집합만 광고한다. 누락 scope의 tool은 list와 call에서 모두 fail-closed하며 provider metadata가 scope를 늘리지 못한다.

hosted connection의 발급 상한은 immutable `HOSTED_AGENT_PORT_GRANTABLE_SCOPES = {agent:port:connect, agent:inbox:read, messages:read, messages:write, agent:jobs:read, agent:runs:callback}`이다. `agent:port:connect`는 필수이고 나머지는 사람의 exact 승인에 따라 부분집합만 발급한다. static confirm과 향후 OAuth consent는 같은 shared validator를 사용하며 `work:control`, `realtime:subscribe`, `provider:quota:write` 및 앞으로 추가될 generic scope를 hosted bearer에 넣지 못한다.

MCP facade는 PG에 직접 쓰지 않는다. 메시지 게시가 기존 `momo-messaging` 트랜잭션과 outbox를 우회하거나, MCP용 job/task 테이블을 따로 만들거나, MCP Tasks extension을 oort job queue의 SoT로 삼는 구현을 금지한다. MCP Tasks는 장기 RPC 결과 handle이고, oort gateway lease와 같은 상태기계가 아니다.

현재 Rust mention delivery는 서버 전역 `AGENT_GATEWAY_MODE`로 managed publish와 gateway pending 중 하나를 고른다. hosted-agent v0는 이 전역 스위치를 connection 권위로 사용하지 않는다. 활성 hosted connection이 결속된 dedicated agent member만 기존 gateway pending 경로로 보내고, managed/BYOA member는 각자의 기존 delivery를 유지하는 **per-agent delivery selector**를 추가한다. selector는 새 task SoT가 아니라 동일 mention transaction에서 기존 publish/gateway 도착지를 고르는 정책이며, connection revoke/pause 상태를 같은 권위로 재검증한다. dedicated hosted member의 connection이 pending/detected/expired/cleanup/disconnected이면 managed fallback으로 보내지 않고 delivery를 fail-closed한다.

HAP-E3가 connection을 `active`로 만들더라도 HAP-E5의 per-agent selector와 HAP-E6의 disconnect/invalid-token reconciliation이 모두 랜딩하기 전에는 production hosted delivery를 계속 0으로 유지한다. HAP-E5의 runtime test만 synthetic test override로 selector를 열 수 있다. 사용자-facing gate는 UX1 pairing과 UX2 cleanup까지 랜딩해야 열며, E3/E4/E5 중간 랜딩이 기존 전역 mode를 통해 managed worker나 gateway로 fallback하는 것은 허용하지 않는다.

### D4. 인증은 connection-scoped credential이며 명시적 이중 모드다

- 기존 agent bearer 검증·hash-only 저장·revoke/expiry/audit 원칙을 재사용한다. raw credential은 발급 순간 한 번만 보이고 응답은 `Cache-Control: no-store`다.
- credential의 authority는 `workspace_id + agent_id + connection_id + audience + scopes`다. 채널 접근은 token에 적힌 목록만 믿지 않고 매 호출 현재 membership과 교집합을 재검증한다.
- hosted connection에 결속된 static/OAuth credential의 audience는 canonical `/v1/mcp/agent-port` resource로 고정한다. shared auth는 일반 REST route-scope dispatch보다 먼저 credential class·connection·audience를 검사하고, hosted credential을 generic REST/realtime principal로 materialize하지 않는다. 메시지·gateway domain 작업은 MCP adapter가 typed internal port로만 호출한다. generic non-hosted bearer의 기존 REST 권한은 유지한다.
- 각 connection은 활성화 전에 `auth_mode = oauth | static_bearer` 중 정확히 하나를 저장한다. oort의 trusted preset 또는 operator 확인만 mode를 선택하고, 선택과 변경은 감사한다. provider가 보내는 metadata는 표시 힌트일 뿐 mode 선택 권위가 아니다.
- provider가 MCP authorization 계약을 지원하면 OAuth를 우선한다. protected-resource metadata와 audience binding을 검증하고, OAuth 실패 뒤 static bearer로 조용히 강등하지 않는다.
- static bearer는 명시적으로 고른 compatibility mode다. HTTPS의 `Authorization` header 또는 provider가 전용 secret field로 정의한 위치만 허용하고 URL, query, routine prompt, 일반 평문 설정에는 넣지 않는다.
- 실제 Bot/Cursor 계정 credential, session cookie, provider token은 oort와 문서에 들어오지 않는다.
- pending pairing challenge와 active agent credential은 같은 secret을 재사용하지 않는다. 승인 뒤 active credential을 provider에 전달하는 방식은 MCP OAuth/token exchange가 지원되면 그 표준 흐름을 쓰고, static bearer만 가능하면 사용자가 두 번째 값을 명시적으로 갱신하는 정직한 setup 단계로 둔다.
- auth mode를 바꾸면 기존 active credential을 revoke하고 pairing과 activation proof를 다시 수행한다. connection이 active인 채로 mode를 바꾸거나 downgrade하지 않는다.
- hosted connection 전용 member의 credential은 generic agent credential API에서 issue/rotate/revoke하지 않는다. v0는 세 요청을 `409 hosted_connection_managed`로 원자적으로 거부하고, activation·disconnect 내부 경로와 새 pairing만 credential을 만든다. 만료·operator emergency revoke처럼 결속 credential이 비정상적으로 무효화되면 첫 server-side guard가 data capability를 열지 않은 채 전용 member를 pause하고 connection을 `cleanup_pending`으로 전이한다.

첫 구현 wave는 기존 oort agent bearer를 수동 secret field/header로 전달하는 **`static_bearer`만 활성화**한다. 이는 MCP OAuth authorization 구현이라고 광고하지 않으며, authorization server가 없는 동안 RFC 9728 protected-resource metadata나 가짜 OAuth discovery를 내지 않는다. `oauth` activation은 ADR-0162의 OAuth lifecycle 증보 뒤 #1368이 OAuth 2.1 authorization server, issuer/client registration, PKCE, audience, token/refresh/revoke와 metadata를 닫고 #1369가 resource-owner 동의와 pairing wizard 복귀를 검증한 뒤에만 연다. UI/API가 아직 구현되지 않은 `oauth`를 선택하거나 자동 fallback하지 않는다.

Grok preset의 mode는 loader가 공개 URL까지 도달한 사실만으로 정하지 않는다. #1344 요청은 현재 없는 route의 HTTP 404에서 auth challenge 전에 끝났으므로 `oauth | static_bearer` 중 어느 mode도 관측하지 못했다. 이는 preset parameter가 미검증인 것이지 Agent Port의 authority 경계가 미결인 것이 아니다. HAP-E2는 static bearer challenge와 dual-era wire만 제공하고, 실제 Grok이 전용 header/secret field를 소비하는지는 후속 live evidence로 봉인한다.

### D5. cross-channel inbox에는 별도 내구 sequence를 둔다

`message.seq`는 채널별 순번이므로 단일 `after_seq`로 여러 채널을 소비할 수 없다. 다이얼인 inbox는 agent connection에 전달할 event마다 단조 증가하는 **별도 내구 `inbox_seq`** 를 발급한다.

- event는 원본을 복제하지 않고 `(workspace_id, agent_id, channel_id, message_id, message_seq, event_kind)`를 참조한다.
- `inbox_seq`는 해당 inbox의 delivery cursor일 뿐 메시지 순서의 새 SoT가 아니다. 채널 안의 권위는 계속 `message.seq`다.
- 내부 정렬 키는 `inbox_seq`지만 외부 API는 workspace/agent/connection/schema version에 묶인 **opaque cursor**를 주고받는다. consumer는 이 cursor로 at-least-once 소비하며, 재접속·중복 consumer는 누락 없이 중복 허용으로 처리한다.
- event를 읽을 때 현재 agent membership, 원본 가시성, revoke 상태를 다시 검사한다. 과거에 보였다는 사실이 현재 권한을 대신하지 않는다.

정확한 table/sequence 발급 방식, opaque cursor encoding과 보존 기간은 migration issue에서 결정하되, vector cursor를 API에 노출하거나 channel-local seq를 전역처럼 취급하지 않는다.

### D6. Bot 감지는 roster 수집이 아니라 one-time pairing handshake다

문서화된 Bot roster API가 없으므로 oort가 외부 계정의 Bot들을 자동 열거·스크랩하지 않는다. v0 연결은 Bot이 먼저 다이얼인하는 handshake다.

1. 사용자가 oort에서 hosted connection 전용 agent member를 만든다. 서버는 dedicated member, `paused=true`인 agent profile, `pairing_pending` connection과 pairing challenge를 한 transaction으로 생성한다. v0에서는 기존 agent member에 hosted connection을 덧붙이지 않으며, 생성 실패 시 어느 일부도 남기지 않는다.
2. Grok preset은 deterministic routine 이름과 connector 설정 단계, 최소 권한을 보여준다. pairing challenge와 active credential은 별도 secret이다.
3. Bot이 pairing secret으로 제한된 handshake를 수행하면 상태가 `pairing_pending → detected`로 전이한다. 이 단계에서는 대화 읽기·쓰기·job claim을 허용하지 않는다.
4. 사람이 감지된 연결의 이름, dedicated agent member, channel/permission 범위를 확인하면 **별도의** active credential을 한 번 발급한다. v0 static-bearer preset에서는 사용자가 provider connector의 소비된 pairing 값을 이 active credential로 명시적으로 교체한다. provider가 그 credential로 제한된 proof를 성공시키고, 같은 activation transaction이 dedicated member의 pause를 해제한 뒤에만 `detected → active`로 전이한다. ADR-0162의 OAuth lifecycle 증보와 #1368/#1369가 모두 랜딩한 preset만 표준 token exchange 분기를 쓸 수 있다.

pairing secret은 짧은 만료, hash-only 저장, 1회 소비, replay 거부를 강제한다. 감지에 소비된 pairing secret은 active bearer로 승격하거나 다시 쓰지 않는다. 만료되면 `expired`가 되고 새 secret을 발급해야 한다. 클라이언트가 제출한 provider/Bot metadata는 표시용 힌트일 뿐 권한의 근거가 아니다.

v0의 운영 단위는 **one Bot = one connection = one dedicated agent member = one deterministic routine**이다. 한 dedicated member에는 `pairing_pending|detected|active|cleanup_pending` connection이 동시에 하나만 존재할 수 있다. 따라서 disconnect의 pause는 그 connection 전용 member만 멈추며 managed/BYOA/다른 hosted runtime을 함께 정지시키지 않는다. 재연결은 이전 connection이 `disconnected`가 된 뒤 같은 dedicated member에 새 pairing/credential을 발급하는 순차 흐름이다. 예시 routine label은 `Oort Inbox: <workspace> / <agent>`이며, 실제 이름·connector id·생성 시각을 cleanup manifest에 기록한다.
개정 2026-09-10: 빈 핸들이면 식별자 세그먼트는 member id 단축형.

### D7. 연결 해제는 local revoke와 provider cleanup을 분리한다

연결 해제 요청은 먼저 oort의 권한을 끊는다.

- active credential 즉시 revoke
- connection 전용 agent member pause 및 새 inbox read, message write, job claim/renew/event/complete 거부
- 이미 잡힌 lease는 새 갱신을 거부하고 기존 만료 규율로 회수
- agent member, 과거 메시지, 완료된 run과 audit history는 보존

그 다음 connection은 `cleanup_pending`이 된다. 공개 Grok Bot control/delete API가 문서화돼 있지 않으므로 oort가 routine이나 MCP connector를 자동 삭제했다고 주장하지 않는다. UI는 connection별 manifest에 따라 다음을 안내한다.

1. `Oort Inbox: <workspace> / <agent>` routine 제거. 단순 `Active off`는 실행만 멈추고 artifact를 남기므로 cleanup 완료로 처리하지 않는다.
2. 해당 oort MCP connector 제거
3. setup이 local plugin source를 만들었다면 connector Uninstall과 별도로 그 source를 제거. 개인 filesystem path는 서버 manifest·audit에 저장하지 않는다.
4. 남아 있는 oort secret이 있다면 provider UI에서 제거

provider cleanup API가 나중에 문서화되고 사용자가 권한을 부여한 경우에는 API 확인으로 종결할 수 있다. v0는 사용자의 명시적 완료 확인을 받아 `cleanup_pending → disconnected`로 전이한다. 확인 전에도 oort 쪽 credential은 이미 폐기돼 있어 외부 artifact가 권한을 되살릴 수 없다.

canonical lifecycle은 다음과 같다.

```text
pairing_pending ──handshake──> detected ──human confirm + separate active proof + member unpause──> active
      │                           │                         │ disconnect
      │ expiry                    │ expiry                  v
      v                           v                  cleanup_pending
   expired                     expired                     │ provider cleanup verified
                                                          │ or explicit user acknowledgement
                                                          v
                                                     disconnected
```

### D8. Grok preset은 검증된 setup recipe이며 코어 protocol이 아니다

Grok preset은 다음만 제공한다.

- endpoint와 one-time pairing 값을 복사하는 설정 단계
- deterministic connector/routine 이름
- “oort inbox를 확인하고, 할 일이 있으면 claim한 뒤 결과를 원래 thread에 게시한다”는 routine template
- `pairing_pending`, `detected`, `active`, `cleanup_pending` 상태와 복구 안내
- routine/MCP connector/local plugin source 제거 체크리스트

#1344에서 private custom-MCP transport와 manual routine 실행은 실측했지만 auth/pairing/tool call/full E2E는 아직 닫히지 않았다. 그 폐곡선 전에는 “즉시”, “seamless”, 최소 응답 시간 같은 표현을 쓰지 않는다. 검증 뒤 런칭 카피는 **“Bring your hosted agent”**, 보조 문장은 **“Grok Bot도 몇 단계로 연결할 수 있습니다”**로 제한한다.

## 증보 1 — OAuth lifecycle (Accepted · 성재 승인 2026-08-15 · HAP-E7 #1368)

> D4는 connection별 `oauth | static_bearer` authority를 허용했지만 D6의 lifecycle은 static pairing만 상세 봉인했다. 이 증보는 `oauth` arm의 상태 전이, authorization request의 connection 결속, 그리고 세 credential의 상호 비승격을 봉인한다. 이 증보의 Accept는 그 경계를 승인한 것이지 flag 개방이 아니다: **구현은 #1369 consent UX 랜딩과 runtime proof 폐곡선 전까지 flag로 닫힌 채 랜딩한다** — metadata를 광고하지 않고 `/v1/oauth/*`는 404이며 static bearer 경로는 flag on/off에서 byte 동일하다(테스트로 고정).

### A1. `oauth` connection의 canonical lifecycle

```text
pairing_pending ──human owner/admin consent (authorization code 발급)──> detected
      │                                          │
      │ (denial은 전이 없음)                      │ token exchange: code 1회 소비
      │                                          │ + PKCE proof + exact audience 검증
      │                                          │ + dedicated member unpause  (한 transaction)
      v                                          v
   expired                                     active ──disconnect──> cleanup_pending ──> disconnected
```

- `oauth` connection은 static pairing challenge를 **갖지 않는다**. `pairing_pending`은 "authorization을 기다리는 중"이라는 뜻이며 `pairing_challenge_hash`는 NULL이다(migration 074가 auth_mode별로 shape를 분리 강제).
- `detected`는 D6에서 Bot의 handshake가 만드는 상태였다. OAuth arm에서 그 자리를 차지하는 것은 **로그인한 human owner/admin의 exact consent**다. 같은 transaction이 `confirmed_by`/`confirmed_at`/`approved_scopes`/`approved_channel_ids`와 authorization code digest를 함께 쓴다. consent만으로는 capability가 0이고 dedicated member는 계속 `paused=true`다.
- `detected → active`의 "별도 active proof"는 **client가 PKCE verifier를 쥐고 있다는 사실**이다. token exchange transaction이 code를 1회 소비하고, exact canonical resource/audience를 재확인하고, access/refresh credential을 발급하고, `active_token_id`를 걸고, dedicated member의 pause를 함께 해제한다. 하나라도 실패하면 전부 롤백한다.
- disconnect·cleanup·terminal은 D7과 **완전히 동일**하다. OAuth arm에 별도 terminal 경로를 만들지 않는다.

### A2. authorization request는 server-minted id로 결속한다

- `GET /v1/oauth/authorize`는 unauthenticated browser redirect다. 따라서 **아무 row도 쓰지 않는다**. 등록된 client·redirect URI·resource·PKCE·scope를 검증한 뒤 server가 서명한 단기 opaque envelope(nonce 포함)만 consent 화면에 넘긴다. unauthenticated endpoint가 ledger를 키우지 못하게 하는 것이 이 선택의 이유다.
- workspace·connection·human은 envelope의 반대편, **인증된 tenant-scoped consent API**에서 결정된다. 결속 대상은 그 workspace의 `pairing_pending`·`auth_mode='oauth'` connection이며, 결속을 고르는 주체는 client가 아니라 승인하는 사람이다.
- terminal decision은 envelope nonce에 대해 **정확히 하나**다(`(workspace_id, request_nonce)` unique). duplicate approve, 늦은 deny, reload, 늦은 callback은 전부 inert하다.
- provider가 보내는 어떤 값도 workspace/connection/scope를 고르지 못한다. client_id·redirect_uri는 **운영자 allowlist**에서만 온다.

### A3. 세 credential은 서로 승격되지 않는다

| credential | 수명 | 저장 | 무엇을 살 수 있나 |
|---|---|---|---|
| pairing challenge (`momo_pair_v1`) | 짧음, 1회 | digest | static arm의 `detected` 전이 **only** |
| authorization code (`momo_oauth_code_v1`) | 60초, 1회 | digest | 한 번의 access+refresh 쌍 **only** |
| access (`momo_oauth_at_v1`) | 30분 | digest | canonical Agent Port 요청 **only** |
| refresh (`momo_oauth_rt_v1`) | 30일, 회전 | digest | 다음 access+refresh 쌍 **only** |

- 저장 digest는 **envelope 전체**를 덮는다. 그래서 같은 secret bytes를 다른 prefix로 다시 라벨링하면 어떤 row와도 일치하지 않는다 — static bearer를 OAuth access로, refresh를 access로, code를 access로 제시하는 네 방향이 전부 산술적으로 막힌다.
- credential class와 connection의 `auth_mode`는 **DB trigger로 일치를 강제**한다(migration 074). `oauth` connection에 static credential을, `static_bearer` connection에 OAuth credential을 만들 수 없다. 이것이 "OAuth 실패 뒤 static bearer로 자동 강등하지 않는다"를 관례가 아니라 스키마로 만드는 지점이다.
- code replay와 refresh reuse는 실수가 아니라 침해 신호로 취급한다: 거절과 **같은 transaction**에서 그 connection의 live OAuth credential 전부를 revoke하고 bounded audit 1행을 남긴다. 이후 첫 Agent Port 호출이 HAP-E6의 화해 경로로 `cleanup_pending`을 만든다.

### A4. authorization server의 정직성 상한

- issuer와 canonical resource는 **운영자 설정에서만** 온다. `Host`·`Forwarded`·`X-Forwarded-*`는 어느 경로에서도 읽지 않는다(RFC 9207/9728의 요점).
- 광고하는 것은 구현한 것뿐이다: `authorization_code`+`refresh_token`, `code`, `S256`, `none` client auth, revocation endpoint, RFC 9207 `iss`. **Dynamic Client Registration과 URL-form Client ID Metadata Document는 구현하지도 fetch하지도 광고하지도 않는다** — 두 기능이 여는 SSRF 표면은 별도 ADR과 threat model을 먼저 요구한다. `client_secret`은 발급도 수용도 하지 않는다.
- consent가 발급할 수 있는 scope 상한은 D3의 immutable `HOSTED_AGENT_PORT_GRANTABLE_SCOPES`이며 static confirm과 **같은 validator**를 쓴다. 상한 밖(`work:control`·`realtime:subscribe`·`provider:quota:write` 및 미래 generic scope)과 이 요청이 요구하지 않은 scope는 code 발급 **전에** 거절하고, secret·digest 없는 bounded denial audit를 남긴다.
- redirect query에 실리는 것은 `code`/`state`/`iss`(또는 `error`/`state`/`iss`) 뿐이다. access·refresh token, client secret, PKCE verifier는 URL·query·log·audit·evidence 어디에도 들어가지 않는다.

### A5. 이 증보가 열지 않는 것

- flag는 기본 닫힘이고, 여는 것은 이 증보의 Accepted + #1369 consent UX 랜딩 + runtime proof 뒤의 **운영자 결정**이다. 그 전에는 API/UI가 `oauth`를 선택지로 광고하지 않는다.
- Grok preset의 OAuth 지원 여부는 여전히 미검증이며, 이 증보는 어떤 preset의 `auth_mode`도 바꾸지 않는다.
- DCR·CIMD·client secret·introspection·device flow·다중 authorization server는 명시적 비목표다.

## 명시적 비목표

- Grok 계정의 Bot/group chat roster 자동 감지, scraping, reverse API, credential replay
- Grok Bot 정의·memory·shared computer 파일의 oort 반입
- oort가 routine 또는 connector를 공개되지 않은 API로 생성·삭제
- Agent Port 안에 새 task/job SoT 구축
- ACP remote transport 또는 A2A를 Agent Port v0에 혼합
- Slack 초인종 bridge, 지속 Centrifugo subscription, provider/model 선택
- 과거 agent member·메시지·run의 cascade 삭제

## Consequences

- (+) 사용자는 별도 agent 서버를 배포하지 않고 이미 호스팅된 agent를 oort 멤버로 데려올 수 있다.
- (+) Grok Bot을 첫 preset으로 활용하면서도 Cursor Cloud Agents, 다른 MCP-capable hosted agent를 같은 계약으로 수용할 수 있다.
- (+) 메시지·job SoT와 RLS/outbox 불변식을 재사용해 중복 상태기계를 피한다.
- (+) Bot roster 권한 없이도 handshake로 사용자가 의도한 Bot만 안전하게 연결한다.
- (−) 응답 지연과 wake-up은 외부 routine에 종속된다. 실시간 agent라고 약속할 수 없다.
- (−) self-host oort는 외부 agent가 접근 가능한 HTTPS endpoint와 올바른 인증 metadata가 필요하다.
- (−) 공개 provider cleanup API가 없는 동안 연결 해제는 사람의 마지막 확인 단계를 포함한다.
- (−) 별도 durable inbox와 connection lifecycle schema가 추가되므로 migration/RLS/audit 설계가 필요하다.

## 불변식 대조

| 불변식 | 판정 |
|---|---|
| Postgres = SoT | 유지 — connection/inbox cursor는 PG 내구, 외부 metadata는 권위가 아님 |
| Centrifugo = 전송전용 | 유지 — Agent Port가 직접 publish하지 않음 |
| 단일 쓰기경로 | 유지 — message post는 기존 REST/domain transaction의 facade |
| 순서 SoT = `message.seq` | 유지 — `inbox_seq`는 delivery cursor이며 채널 메시지 순서를 대체하지 않음 |
| 에이전트 = member | 유지 — dial-in은 connection mode일 뿐 새 kind가 아님 |
| RLS FORCE | 유지·주의 — 모든 호출에서 workspace/agent/membership을 재검증하고 신규 table을 RLS 목록에 포함 |
| gateway job/run | 유지 — 기존 pending/lease/events/complete만 사용 |

## 검증 계약 (Accepted 후 구현 수용기준)

1. 만료·재사용·다른 connection의 pairing secret은 handshake에 실패하고 active data 접근이 0건이다.
2. `detected` 상태는 사람 확인과 별도 active credential proof, dedicated member unpause가 같은 activation 경계에서 모두 끝나기 전 inbox/thread/message/gateway capability를 사용할 수 없다.
3. pairing_pending/detected/expired dedicated member mention은 managed fallback·gateway pending·worker job을 만들지 않고, profile은 `paused=true`를 유지한다. 오직 successful activation transaction만 connection active와 member unpause를 함께 커밋한다.
4. expired, revoked, wrong-audience credential은 즉시 거부되고, token raw 값은 로그·DB·audit payload에 남지 않는다. hosted dedicated member의 generic issue/rotate/revoke는 mutation 없이 `409`이며, 비정상 무효화가 관측되면 capability 0과 dedicated member pause + `cleanup_pending`을 같은 fail-closed 경계로 닫는다. active·pre-proof·disconnected 상태의 hosted static/OAuth credential로 message POST/PATCH, gateway pending/lease/event/complete, realtime-token REST를 직접 호출해도 principal이 성립하지 않고 mutation은 0이다.
5. connection에 저장된 auth mode와 다른 flow, OAuth 실패 뒤 자동 static fallback, URL/query/routine prompt의 static secret은 capability 부여 전에 거부된다. mode 변경은 기존 credential revoke와 재-pairing 없이는 실패한다.
6. workspace/channel 밖 접근과 membership 회수 뒤 접근이 fail-closed한다. `agent:port:connect`만 가진 token의 product tool 목록은 0이며, 각 tool은 D3의 닫힌 scope mapping과 current membership을 모두 만족해야 한다. hosted activation은 immutable 6-scope 상한 밖의 `work:control`, `realtime:subscribe`, `provider:quota:write` 또는 미래 generic scope를 발급하지 않는다.
7. 동일 idempotency key의 message 재시도는 메시지·outbox 각 1건을 유지한다.
8. 두 channel이 각각 `message.seq=1`을 가져도 inbox cursor가 둘을 누락 없이 전달한다.
9. reconnect와 duplicate consumer에서 누락은 없고 중복은 cursor/idempotency로 안전하다.
10. MCP gateway tools가 기존 lease 경쟁·expiry·renew/release·complete 규율과 동일한 결과를 낸다.
11. 같은 workspace의 managed agent와 active hosted dedicated agent를 함께 mention하면 managed agent는 기존 delivery로, hosted agent만 기존 gateway pending으로 가며 서로의 job을 claim하지 않는다. 서버 전역 gateway mode를 바꾸지 않아도 혼합 구성이 성립한다.
12. disconnect 직후 새 read/write/claim/renew/event/complete가 거부되고, history는 보존된다.
13. provider artifact 미정리 시 `cleanup_pending`이 유지되며, API 확인 또는 명시적 사람 확인 전 자동으로 `disconnected`가 되지 않는다.
14. generic MCP client 폐곡선을 먼저 통과하고, Grok Bot 실계정 E2E는 별도 `[manual]/[runtime]` evidence로 기록한다.

## Accepted 후 구현 티켓에서 봉인할 파라미터

아래 세부값이 D1~D8의 authority, scope, lifecycle, RLS 또는 storage semantics를 바꾸면 이 ADR을 증보하거나 새 ADR을 먼저 Accepted한다.

1. Grok Bot 실계정에서 확인한 preset별 `auth_mode`, setup recipe와 MCP discovery/redirect/header 동작
2. durable inbox의 retention·compaction·backfill 범위
3. pairing/connection schema와 agent credential lifecycle API의 정확한 route
4. disconnect 시 active lease 처리의 사용자 표시와 최대 회수 시간
5. 공개 런칭 전 자동화 에이전트 접속·외부 provider artifact에 관한 약관/법무 문구 검토(법률 자문 아님)

## 증보 2 — hosted 1:1 DM 승인 (Accepted · 성재 결재 「권장대로」 2026-09-27 · #2915)

> HAP-E3 confirm과 증보 1 A1은 사람이 **이름 붙인 채널 집합**(`approved_channel_ids`)만 승인하고, 두 validator가 `kind <> 'dm'`만 받는다. 그래서 hosted 에이전트와의 1:1 DM은 어떤 설정으로도 전달되지 않았다(PR #2889 / #2871이 발견, 사이드바 「Claude Code」 DM이 조용함). 이 증보는 DM을 여는 규칙과 그 권한 주체를 봉인한다.

### 결재 인용

이슈 #2915 「결정 — 성재 2026-09-27 「권장대로」」 절 그대로:

> PR #2889(#2871) 발견: hosted 에이전트 승인은 채널 단위만 있어 1:1 DM은 절대 전달되지 않는다(사이드바 「Claude Code」 DM이 조용함).
> - 에이전트 소유자와 그 에이전트의 1:1 DM은 **자동 승인**(ADR-0193 소유자 전용 원칙과 정합).
> - 다른 멤버 ↔ 그 에이전트 DM은 **에이전트 소유자가 DM 단위로 승인**해야 열린다(기본 닫힘). 승인 UI는 설정 › 에이전트 자격의 채널 승인 목록에 DM 줄로.
> - 구독 에이전트(owner_only)는 소유자 DM만 허용, 타인 DM 승인 불가(서버 거부).
> - 보안 경계 변경 → hosted 전달·채널 승인 ADR 증보 Accepted(결재 인용)가 머지 조건.

### B1. 1:1 DM의 정의와 소유자

- 1:1 DM은 `channel.kind = 'dm'`, `archived_at IS NULL`이고 **활성 멤버(`membership.left_at IS NULL`)가 정확히 둘**(그 에이전트와 사람 한 명)인 방이다. 셋 이상의 그룹 DM은 이 증보의 대상이 아니며 계속 전달되지 않는다.
- 소유자는 `agent.owner_human_id`(schema_v0)다. hosted 연결 생성은 만든 사람을 소유자로 적는다. 소유자가 없으면(NULL) 자동 승인도 DM 승인도 없다(fail-closed).

### B2. 소유자 DM은 자동 승인이며 저장하지 않는다

- 소유자와 그 에이전트의 1:1 DM은 연결이 active인 동안 승인된 방으로 친다. 저장된 값이 아니라 **매 판정마다 현재 방 모양과 소유자로 계산**한다. DM이 confirm 뒤에 생겨도, 재연결로 connection 행이 새로 생겨도 그대로 열린다. 멤버가 바뀌어 1:1이 아니게 되면 그 순간 닫힌다.
- 구독 에이전트(`invocation_scope = 'owner_only'`, ADR-0193 D4)도 소유자 DM은 이 규칙으로 열린다.

### B3. 다른 멤버와의 DM은 소유자가 DM 단위로 연다

- 기본은 닫힘이다. 에이전트 소유자만 그 DM을 승인하거나 철회한다. 워크스페이스 관리자라도 소유자가 아니면 바꾸지 못하고, 목록은 읽을 수 있다.
- 저장은 connection 단위(`hosted_agent_connection.approved_dm_channel_ids`, 신규 migration)다. `approved_channel_ids`와 같은 수명이다: 재-pairing reset에서 비워지고, 해제 뒤 새 connection은 빈 목록으로 시작한다. 승인은 채널 승인과 권한 주체가 달라서(관리자의 confirm이 아니라 소유자의 수시 결정) 같은 배열에 섞지 않는다.
- 저장된 승인도 판정 때마다 B1 모양을 다시 확인한다. 승인 뒤 방에 사람이 늘면 닫힌다.
- 서버가 거부하는 것: 구독 에이전트의 타인 DM 승인(B4), 1:1 DM이 아닌 방, 그 에이전트가 없는 방, 소유자 DM(이미 자동이라 저장 대상이 아님), 해제 중·해제된·만료된 connection.
- 승인·철회는 감사 행을 남긴다.

### B4. 구독 에이전트는 소유자 DM만

- `owner_only` 에이전트는 타인 DM 승인을 서버가 거부한다. 판정에서도 `approved_dm_channel_ids`를 보지 않는다. 비소유자의 호출은 ADR-0193 D4 안내를 그대로 받는다.

### B5. 한 술어, 모든 강제 지점

- 「이 connection이 이 방을 덮는가」는 SQL 함수 하나(`hosted_connection_channel_ids`, SECURITY INVOKER라 RLS가 그대로 적용)로 정의한다: `approved_channel_ids` ∪ B2 소유자 DM ∪ B3 승인 DM.
- mention selector, hosted inbox fan-out·read, gateway claim SQL(권위), Agent Port 도구 identity가 모두 이 함수를 쓴다. selector와 claim이 갈라지면 DM이 `pending` job으로 멈춰 다시 조용해지므로 하나로 묶는다. 웰컴 킥오프(ADR-0181 D3)는 채널 대상이라 바꾸지 않는다.

### B6. 보이는 안내

- 비소유자의 1:1 DM이 아직 승인되지 않았으면 #2871 서버 안내 줄의 사유는 `hosted_dm_owner_approval_required`이고, 문구는 소유자 이름을 들어 「소유자 승인이 필요」하다고 말한다. 이 줄은 DM 안의 비소유자에게만 보이므로 설정 문(`notice_action`)을 달지 않는다. 이름은 두 개 모두 `inert_display_name`을 거친다.
- 그룹 DM과 소유자 없는 에이전트는 기존 사유 `hosted_dm_not_approvable`을 쓰되, 문구에서 「1:1 대화는 전달되지 않는다」는 이제 거짓이므로 고친다.
- DM 컴포저 힌트(#2891)는 서버가 알려 주는 이 DM의 전달 상태를 따른다. 「멘션 없이 바로 말하면 …가 답합니다」는 전달이 열린 DM에서만 쓴다.

### B6-1. DM은 소유자가 확인한 connection에만 실린다 (보안 검수 H1, #2918, planner 결정 2026-09-27)

- B2·B3의 DM(소유자 DM·승인 DM)은 그 connection을 confirm(static)하거나 consent(OAuth)한 사람(`confirmed_by`)이 에이전트 소유자이고 소유자가 활성일 때만 덮인다. 비소유자 관리자가 재-pairing·confirm·consent한 connection에는 DM이 0개다(채널 승인은 그대로). 비소유자의 confirm·consent는 같은 tx에서 그 connection의 타인 DM 승인을 비우고, 그 connection에서 소유자는 DM을 다시 열 수 없다(409). 소유자가 다시 연결하면 열린다.

### B7. 이 증보가 열지 않는 것

- 그룹 DM, 채널 승인 권한 주체(여전히 관리자의 confirm), 웰컴 킥오프 대상, 운영 인스턴스 설정.
- 실제 Claude Code MCP 합류 왕복은 runtime-unverified로 남는다.

## 증보 3 — 호스티드 에이전트 작업 추적 (Accepted · 성재 결재 「이대로 진행」 2026-10-05 · #3514 AT-1)

> 호스팅 에이전트(Grok Bot 등)는 자기 벤더 VM 안에서 일한다. oort는 그 안의 터미널을 보지 않는다. 대신 에이전트가 oort로 보고하는 **작은 진행 표식과 결과 산출물**만 팀이 본다. 이 증보는 그 계약을 기존 `agent_run`/`agent_job`과 Agent Port 도구의 확장으로만 정한다. 비목표 「Agent Port 안 새 task/job SoT 구축」은 그대로 지킨다(D9).

### 결재 인용

이슈 #3514 본문이 옮긴 성재 2026-10-05 결재(AskUserQuestion, 답 「이대로 진행」): 「개인 클라우드 작업 공간(ADR-0197) 보류, 외부 VM 에이전트 작업 추적으로 간소화.」 이 결재가 이 증보의 수용 근거다. 공개 API·보안 경계 증보이므로 ADR-0100에 따라 이 Accepted 기록이 구현 PR의 머지 조건이다. 이 증보가 열지 않는 것은 D17에 모았다.

### 현황 (2026-10-05 코드 실측)

| 지점 | 사실 | 이 증보 |
|---|---|---|
| 호스팅 에이전트에 작업 요청 | `POST …/agent-runs`는 호스팅 연결 행이 있거나 `owner_only`(비 `uses_owner_key`)이면 `hosted_delivery_disabled`로 409 (`momo-agent/src/run.rs`) | D10 |
| `oort_run_event` | `status` 4종·`detail`(≤2048, 감사 전용)·`textDelta`(≤8192)·`eventId`. 단계 표식·링크 없음 (`momo-mcp/src/tools.rs`) | D11 |
| `oort_run_complete` | `status`·`body`(≤8000)·`error`·`usage`. 산출물 없음 | D12 |
| 팀 보드 | `work_session`(공유 L 세션·A 세션)만 읽음 (`momo-t3/src/work_board.rs`, ADR-0194 D5) | D13 |
| 끝남 푸시 | `work_session_idle`만 있음(ADR-0120 부록 A). run 완료 푸시 없음 | D14 |
| 그록봇 루틴 | `docs/SELF_HOST_AGENT.md` §3.3.17.4는 run 도구를 쓰지 않음 | D16 |

### D9. 기본 원칙: 기존 원장의 확장이며 새 저장소가 아니다

- 작업의 단일 원본은 `agent_run`(상태기계)과 `agent_job`(전달)이다. 진행·산출물은 **`agent_run`의 기존 컬럼**(`step_count`, `output` jsonb)에 쓴다. 새 테이블·새 큐·MCP Tasks 연동을 만들지 않는다.
- 새 도구를 만들지 않는다. 기존 `oort_jobs_claim`/`oort_job_renew`/`oort_job_release`/`oort_run_event`/`oort_run_complete`에 **선택 필드**를 더한다. 선택 필드를 모르는 에이전트(구버전 루틴)는 그대로 동작한다.
- 새 scope를 만들지 않는다. 진행·산출물 보고는 기존 `agent:runs:callback`, 작업 가져오기는 기존 `agent:jobs:read`다. D3의 6-scope 상한과 D4 인증 경계는 바뀌지 않는다.
- 이 보고는 **자기 보고(self-report)** 다. 서버는 PR이 실제로 있는지, 숫자가 맞는지 검증하지 않는다(D7 ADR-0194와 같은 1단계: 서버는 GitHub 토큰을 쥐지 않고 API를 부르지 않는다). 화면은 「에이전트가 보고한 값」으로 그린다.

### D10. 호스팅 에이전트에 작업 요청(`type=work`)을 허용하는 조건

`POST /v1/workspaces/{ws}/channels/{ch}/agent-runs`의 `type=work`가 호스팅 에이전트를 대상으로 할 수 있다. 모든 조건을 첫 쓰기 전에 판정하며, 하나라도 어긋나면 409(아래 코드)이고 run·job은 0건이다.

1. **연결이 active이고 증명됨.** 그 dedicated member의 connection이 `active`이고 active credential 증명(D6 4단계)을 마쳤다. `pairing_pending`·`detected`·`expired`·`cleanup_pending`·`disconnected`는 `hosted_connection_not_active`. dedicated member가 `paused`이면 기존 `agent_paused`.
2. **채널이 승인됨.** 요청 채널이 B5의 단일 술어 `hosted_connection_channel_ids`(승인 채널 ∪ 소유자 DM ∪ 승인 DM)에 든다. 아니면 `hosted_channel_not_approved`. 요청만 따로 여는 별도 승인 목록을 만들지 않는다. mention과 work 요청이 같은 술어를 쓰므로 둘이 갈라지지 않는다.
3. **요청자는 사람.** 기존 `requireHumanPrincipal` 그대로. 에이전트가 에이전트 작업을 일으키지 못한다. 요청자는 그 채널의 활성 멤버여야 한다.
4. **`owner_only`는 변하지 않는다.** `invocation_scope='owner_only'`이고 `uses_owner_key`가 아닌 에이전트(구독 에이전트)는 호스팅 여부와 상관없이 지금처럼 작업 요청이 막힌다. 증보 3은 이 경계를 열지 않는다.
5. **보수 모드가 먼저다(ADR-0193 D18).** 판정 순서는 D18 → `owner_only` → 위 1~3이다. `claude_subscription_agent_paused` 409는 이 증보가 와도 같은 자리에서 같은 코드로 나온다. D18의 「공용 host」·구독 토큰 정책은 이 증보가 건드리지 않는다.
6. **전달은 기존 agent_job이다.** run은 `queued`, 같은 tx에서 기존 `agent_job`이 pending으로 쌓인다. mention과 같은 per-agent delivery selector(D3)가 목적지를 고르며, 호스팅 에이전트가 불일치 상태이면 managed로 새지 않고 fail-closed다. 호스팅 에이전트는 doorbell(ADR-0171)·routine이 깨어나 `oort_jobs_claim`으로 가져간다. 깨우는 시각은 벤더 routine에 종속이라 「즉시」를 약속하지 않는다(Consequences의 지연 문장 그대로). 미claim run은 기존 `deadline_at`/만료 규율이 정리하며 새 타이머를 두지 않는다.
7. **취소.** 기존 `POST …/agent-runs/{run}/cancel`이 그대로 쓰이고, 호스팅 에이전트는 다음 `oort_job_renew`/`oort_run_event`가 거부되면서 알게 된다(D7의 lease 규율). 벤더 VM 안의 프로세스를 oort가 죽이지는 않는다.

`run.rs`의 `hosted_delivery_disabled` 하나가 두 사유(호스팅 연결 존재 / `owner_only`)를 한 불리언으로 합쳐 두었다. 구현은 두 사유를 **분리**해 호스팅 연결은 위 1~2 판정으로 대체하고, `owner_only`는 그대로 막아야 한다(둘을 한꺼번에 풀면 4번이 깨진다).

### D11. `oort_run_event`: 단계 표식과 step_count

- 선택 필드 `stage`(문자열, 1..80자)를 더한다. 형식·상한은 `work_session_share`의 단계 표식(migration 114 `work_session_share_stage_markers_ok`, ADR-0194)을 **그대로 재사용**한다: 한 표식 1~80자, 제어 문자·bidi 제어·`/`·`\` 불가, 저장 목록 ≤12개. 구현은 같은 검증 함수를 공유해 두 곳이 어긋나지 않게 한다(복사 금지).
- 저장: `agent_run.output.stages`(문자열 배열, 최대 12). 12개를 넘으면 **가장 오래된 것부터 버린다**(최근 12개 유지, 연속 동일 표식은 하나로). 에이전트가 12번째에 거절당해 막히는 것보다 최근 진행이 보이는 편이 낫다.
- `stage`가 있는 이벤트마다 `agent_run.step_count`를 1 올린다. 단 기존 `CHECK (step_count <= max_steps)`가 있으므로 `LEAST(step_count + 1, max_steps)`로 포화시킨다(상한 도달이 완료 보고를 막지 않는다). `stage` 없는 이벤트(heartbeat·status만)는 `step_count`를 올리지 않는다.
- 이벤트는 현재 lease 소유 에이전트의 것만 받는다(기존 규율). `eventId` 멱등성이 있으면 재시도가 `step_count`를 두 번 올리지 않는다.
- 기존 필드는 그대로다. `detail`은 **여전히 감사 전용**이고 보드·카드에 싣지 않는다. `textDelta`도 기존 동작을 따르며 보드는 읽지 않는다.
- 단계 표식은 realtime 이벤트를 만들지 않는다(ADR-0194 D8과 같다). 다음 조회·보드 재조회에서 보인다.
- 검증 실패(길이·문자·형식)는 run 상태를 바꾸지 않고 400, 어느 것도 쓰지 않는다.

### D12. `oort_run_complete`: 선택 산출물(artifacts)

- 선택 필드 `artifacts`(객체, `additionalProperties:false`)를 더한다. 키는 전부 선택이다:

| 키 | 형식 | 검증 |
|---|---|---|
| `prUrl` | 문자열 | `validated_pr_url`(`momo-t3/src/work_share.rs`)을 그대로 재사용. `https`, 허용 호스트(`github.com`+운영자 설정 GHE), 경로 정확히 `/<소유자>/<저장소>/pull/<번호>`, 쿼리·조각 버림. 저장은 정규화한 URL |
| `branch` | 문자열 | share와 같은 규칙: 절대 경로처럼 보이는 값(`/`·`~` 시작, 드라이브 문자, 역슬래시)·제어 문자 불가, 길이 상한은 share 컬럼과 같은 값 |
| `added`, `deleted` | 정수 | 0 이상, `MAX_COUNT` 이하 (share의 `diff_added`/`diff_deleted`와 같다) |
| `commits` | 정수 | 0 이상, `MAX_COUNT` 이하 (share의 `commits_ahead`에 대응하는 「이 작업이 만든 커밋 수」) |

  커밋 제목·파일 이름·경로·원격 URL 필드는 **정의하지 않는다**(없는 필드는 보낼 수도 저장될 수도 없다). `additionalProperties:false`가 그 방어다.
- 저장: `agent_run.output`의 고정 모양 jsonb에 둔다. 새 테이블은 만들지 않는다.

```text
agent_run.output = {
  "stages":    ["…", …],                       // D11, 0..12개, 각 1..80자
  "artifacts": { "prUrl"?: "https://…/pull/N", "branch"?: "…",
                 "added"?: n, "deleted"?: n, "commits"?: n }
  // 기존 키(body 등)는 그대로 유지. 위 두 키만 이 증보가 추가한다.
}
```

  테이블을 만들지 않는 이유: run당 한 번만 쓰는 닫힌 모양의 작은 값이고, 목록·해제·보존이 모두 `agent_run` 행의 수명을 따른다. `work_session_share`가 별 테이블이었던 이유(세션 원장과 분리된 공유 해제·보존 삭제)는 run에 없다. 따로 해제할 공유가 아니라 run의 결과이기 때문이다. 판독은 검증을 거쳐 쓴 값만 읽으므로 DB에는 모양 CHECK를 필수로 두지 않는다. 구현이 CHECK 함수를 추가하는 것은 허용하되 신규 migration이어야 하고 `schema_v0.sql`은 건드리지 않는다.
- `succeeded`와 `failed` 모두 `artifacts`를 실을 수 있다(실패해도 만든 브랜치·부분 PR을 남길 수 있다).
- **형식이 틀린 `artifacts`는 완료 전체를 거절한다**(400, 어떤 쓰기도 없음, 거절 사유 코드만 반환). 일부만 버리고 완료시키지 않는 이유는 보고가 조용히 틀린 채 남지 않게 하기 위해서다. 에이전트는 `artifacts` 없이 같은 lease로 다시 완료할 수 있다(lease는 거절로 풀리지 않는다).
- PR URL이 드러내는 `소유자/저장소`는 ADR-0194 D7의 Q2가 이미 받아들인 노출이다. 서버는 PR 제목·체크·리뷰를 가져오지 않는다.

### D13. 팀 보드의 두 번째 출처: 호스팅 에이전트 work run

- 보드(`GET /v1/workspaces/{ws}/work-sessions?scope=team`, ADR-0194 D5)는 **같은 응답 목록에 두 출처**를 섞어 낸다: ① `work_session`(기존) ② `agent_run` 중 `input.type='work'`이고 **호스팅 연결을 가진 에이전트**의 run.
- 항목은 출처 표시 `source: "session" | "run"`을 갖는다. `run` 항목은 `session_id` 대신 `run_id`를 쓰고, 카드 조회는 `GET /v1/workspaces/{ws}/agent-runs/{run}`(기존 상세 판정을 재사용)이 같은 화면을 준다. 필드(보드 요약):

| 필드 | 출처 |
|---|---|
| `run_id`, `agent_member_id`, `requested_by_member_id`, `home_channel_id` | `agent_run` |
| `title` | 기존 `trigger_summary`(work 입력 제목, 상한 있음) |
| `status` | `queued`→`waiting`, `running`·`awaiting_approval`·`paused`→`running`, `succeeded`→`done`, `failed`·`timed_out`→`failed`, `cancelled`→`stopped` (보드의 파생 상태 어휘로 매핑) |
| `steps[]`, `step_count` | `output.stages`, `agent_run.step_count` |
| `pr{url, number}`, `branch`, `diff{additions, deletions}`, `commits` | `output.artifacts`(`number`는 URL에서 추출) |
| `started_at`, `finished_at`, `last_activity_at` | `agent_run` |

- **가시성은 읽기 SQL 한 문장에서 결정한다.** 보는 사람이 `agent_run.channel_id`의 활성 멤버(채널 미보관·`left_at IS NULL`)여야 한다. 아니면 「멤버 아님」·「없는 run」·「다른 테넌트」가 모두 같은 빈 결과/404다. 워크스페이스 전체 보기는 없다(Q4 유지). DM 채널의 run은 그 DM의 두 사람에게만 보인다.
- **중복 제거.** run에 이미 연결된 `work_session`이 있으면(`linked_work_session_ids_in_tx`) 세션 쪽 항목이 대표이고 run 항목은 내지 않는다. 같은 일이 두 줄로 나오지 않는다.
- **mention run은 v1에 넣지 않는다.** 채팅 답을 만드는 mention run은 이미 스레드의 메시지로 보이고, 보드에 넣으면 잡음이 되며 「작업」 정의가 흐려진다. `type=work`만 보드 대상이다.
- **managed·BYOA의 work run은 v1에 넣지 않는다.** 이 증보의 대상은 호스팅 에이전트다(해당 run은 이미 A 세션 경로로 보인다). 넓히는 것은 별도 결정이다.
- 보존: 끝난 뒤 `SHARE_RETENTION_DAYS`가 지나면 읽기가 스스로 거른다(세션 쪽과 같은 규칙, notifier 정리를 기다리지 않는다). `agent_run` 행 자체의 보존은 이 증보가 바꾸지 않는다.
- 정렬·페이징: 두 출처를 `(last_activity µs, id)` 하나로 합쳐 같은 opaque cursor를 쓴다.
- **실시간.** run의 **상태 전환**(queued→running, 종결: succeeded/failed/timed_out/cancelled)과 같은 tx 안의 outbox INSERT → relay → Centrifugo로 집 채널 토픽에 `work.run.updated`(`run_id`와 전환 종류만, 이름·제목·숫자 없음)를 보낸다. 클라는 이벤트에 보드/카드를 다시 조회하고 가시성은 조회가 다시 강제한다(ADR-0194 D8과 같은 구조). 단계 표식 갱신과 `step_count` 증가는 이벤트를 만들지 않는다. 이미 같은 의미의 agent_run 채널 이벤트가 있으면 새 이름을 만들지 않고 그것을 재사용한다(구현 티켓이 확인하고 PR에 기록).

### D14. 작업 끝남 푸시

- run이 **종결**하면 run을 만든 사람(요청자)에게 푸시를 보낼 수 있다. 종결은 `succeeded`·`failed`·`timed_out`이다. 요청자 자신이 취소한 `cancelled`는 보내지 않는다. 요청자가 기록돼 있지 않거나 사람이 아니면 보내지 않는다(fail-closed).
- 판정은 ADR-0120 부록 A-8을 그대로 따른다: ① 수신자 = run 요청자 본인, ② 진행 시간(`finished_at − started_at`) ≥ 60초, ③ run당 1회(종결 전이 자체가 한 번만 일어나므로 이중 방어), ④ `notification_rule.work_complete_push`가 꺼져 있으면 보내지 않음(종류별 설정 재사용, 새 토글 없음), ⑤ DND·채널 mute·`read_state` 30초 전경 휴리스틱 억제는 그대로. 이 규칙들을 호스팅 run에 맞게 복제하지 않고 같은 판정 모듈이 두 출처를 받게 한다.
- **푸시 어휘.** relay는 닫힌 reason 어휘를 검증한다(0120 A-3). run 종결은 `work_session_idle`의 카드 문구(「작업 완료 — idle 대기」)와 뜻이 달라서, 구현은 6번째 reason `work_run_done`을 더한다(부록 A-6과 같은 방식: relay 먼저·클라 뒤따르는 순차 배포, 구버전 앱은 정적 자리표시자로 fail-open). 문구는 고정이고 run 제목·산출물·에이전트 출력을 싣지 않는다.
- 스레드 안의 알림은 기존 완료 응답 메시지(`oort_run_complete`의 `body`가 기존 경로로 게시하는 메시지)가 맡는다. 푸시는 그 위의 추가다. 단계 표식마다·전환마다 푸시는 없다.

### D15. 프라이버시와 감사

- **터미널 바이트 없음.** 벤더 VM의 터미널·화면·파일 시스템은 oort로 오지 않는다. ADR-0125 D10(서버는 터미널 바이트를 싣지 않는다)·ADR-0188/0190의 경계는 그대로다. 보드·카드에 입력 칸·attach·제어는 없다.
- **자유 텍스트는 기존 상한 안에서만.** 새로 보이게 되는 에이전트 문자열은 단계 표식(≤12×80)과 `branch`(검증됨)뿐이다. `detail`·`textDelta`·`body`·`error`는 보드가 읽지 않는다. 커밋 제목·파일 이름·경로·원격 URL은 필드가 없다.
- **화면 처리.** 표식·브랜치는 외부 에이전트가 쓴 신뢰할 수 없는 텍스트다. 일반 텍스트로 이스케이프해 그리고(마크다운·링크 자동 변환·멘션 해석 없음, `inert_display_name`과 같은 결), 링크로 그려지는 것은 검증된 `prUrl` 하나뿐이다.
- **요청 본문 상한.** 단계 표식·산출물 요청은 share 본문 상한(`MAX_SHARE_BODY_BYTES` 8 KiB)과 같은 층의 작은 상한을 받는다. 기존 `oort_run_complete.body` 상한(8000)은 그대로다.
- **감사.** 종결 보고에 `artifacts`가 실리면 감사 1행(`agent.run.artifacts_reported`: run id·존재한 키 이름만, 값·URL 없음), 형식 거절은 사유 코드만 담은 감사 1행(`agent.run.report_rejected`)을 남긴다. 단계 표식마다는 감사하지 않는다(`step_count`와 `output.stages`가 기록이다). 토큰·lease handle은 어디에도 남기지 않는다.
- **권한.** 다른 에이전트의 run, 다른 lease, 연결이 끊긴·paused 에이전트의 보고는 기존 gateway 규율대로 거부된다(D7). 이 증보가 입구를 넓히지 않는다.

### D16. Grok Bot·dots: 소유자 본인 계정·VM에서만

- 호스팅 에이전트는 **소유자가 자기 벤더 계정으로 자기 VM에서 돌리는 것**만 대상이다. oort는 벤더 VM·계정을 운영하지 않고(ADR-0197 보류), 벤더 API를 부르거나 계정을 읽거나 토큰을 풀링하지 않는다. 구독을 가진 사람이 아닌 사람이 그 계정을 쓰게 하는 연결·대행 기능을 만들지 않는다. Grok Bot·dots 등 어떤 벤더의 약관 변경도 oort가 보증하지 않으며, 공개 런칭 전 약관·법무 검토(이 ADR의 「봉인할 파라미터」 5번)는 그대로 열려 있다.
- 채널 승인(D10 2)이 이미 허용한 채널에서 다른 멤버가 호스팅 에이전트에 작업을 요청하면 소유자의 벤더 구독 한도를 쓴다. 이는 mention과 같은 노출이며, 소유자가 승인한 채널·DM에만 열린다(B3). 구독형 에이전트의 `owner_only`는 D10 4로 계속 막혀 있다.
- 벤더별 루틴 레시피의 변경은 코어 계약이 아니다(D8). 구현 티켓이 `docs/SELF_HOST_AGENT.md` §3.3.17.4의 생산 루틴 문구를 **run 도구를 쓰도록** 고친다: `oort_jobs_claim` → 단계마다 `oort_run_event(stage)` → `oort_run_complete(artifacts)`. 실계정 동작은 `runtime-unverified`로 남고, 별도 `[manual]/[runtime]` 증거 전에는 카피에 「실시간」·「자동 보고」를 쓰지 않는다.

### D17. 비목표와 열지 않는 것

- 벤더 VM 터미널·화면·셸 보기, 원격 입력, attach, 파일 반입(D15)
- 새 task/run 저장소·큐·테이블, MCP Tasks의 SoT화(D9, 비목표 유지)
- mention run·managed/BYOA work run의 보드 노출(D13)
- GitHub API·토큰·PR 제목/체크/리뷰 수집, PR 자동 생성, 서버 측 PR 존재 검증(D9, ADR-0194 D7 2단계는 별도)
- 단계 표식·진행률 마다의 실시간 이벤트·푸시, 자유 서술 진행 보고, 벤더 비용 측정
- `owner_only`·보수 모드·공용 host 정책 변경(D10 4·5)
- oort 운영 VM·개인 클라우드 컨테이너(ADR-0197은 보류, 코드는 main에 기본 꺼짐)
- 새 scope, 새 MCP 도구, 새 인증 경로

### 불변식 대조 (증보 3)

| 불변식 | 판정 |
|---|---|
| Postgres = SoT / 단일 쓰기경로 | 유지 — 진행·산출물은 gateway의 기존 tx에서 `agent_run`에 쓰고, 이벤트는 같은 tx의 outbox → relay |
| Centrifugo = 전송전용 | 유지 — 상태 전환 이벤트만, 클라 직접 publish 없음 |
| 에이전트 = member / RLS FORCE | 유지 — 모든 읽기·쓰기가 `workspace_id`+현재 멤버십 재검증, 신규 테이블 없음 |
| gateway job/run | 유지 — claim/lease/events/complete의 선택 필드 추가만 |
| 순서 SoT = `message.seq` | 무관 — 진행 표식은 메시지가 아니다 |

### 구현 단위 (Accepted 후, 후속 이슈로 편성)

1. **AT-2 서버(engine):** D10 게이트 분리, D11·D12 도구 스키마·검증(공유 검증 함수 재사용)·`step_count`, `agent_run.output` 모양, 감사. OpenAPI/MCP 계약 갱신.
2. **AT-3 보드(engine):** D13 두 번째 출처 읽기 SQL·응답·이벤트, 중복 제거.
3. **AT-4 푸시(engine+relay):** D14 판정 모듈 확장과 `work_run_done` reason. relay 먼저 배포.
4. **AT-5 표면·레시피(UXUI·docs):** 보드·카드에 run 항목, 루틴 문구 수정(D16). 캡처·실계정은 `runtime-unverified`로 표기.

각 단위의 수용기준은 되돌리면 실패하는 시험을 요구한다: ① 호스팅 연결이 active가 아니거나 채널이 승인 밖이면 409이고 job 0건, `owner_only`·D18은 호스팅 연결과 무관하게 계속 409, ② 13번째 표식이 가장 오래된 것을 밀어내고 `step_count`가 `max_steps`에서 포화해도 완료가 막히지 않음, ③ 잘못된 `prUrl`·`branch`·음수 숫자는 완료 전체를 거절하고 아무것도 쓰지 않음, 알 수 없는 `artifacts` 키는 거절, ④ 채널 비멤버·다른 DM·다른 테넌트의 run이 보드에 0건이고 세션에 연결된 run은 한 줄, ⑤ 푸시는 요청자 외·60초 미만·설정 off·자기 취소에서 0건.
