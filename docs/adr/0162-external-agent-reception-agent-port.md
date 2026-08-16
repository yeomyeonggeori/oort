# ADR-0162: 외부 호스팅 에이전트 수용 — Agent Port와 pairing lifecycle

- Status: **Accepted** (2026-08-12 · 성재가 제품 방향과 D1~D8의 벤더 중립 기술 경계를 승인)
- 증보: **증보 1 — OAuth lifecycle (2026-08-15, HAP-E7 #1368) · Accepted (성재 승인 2026-08-15).** Accept는 D4/D6의 OAuth 경계를 승인한 것이지 flag 개방이 아니다 — 구현은 여전히 feature flag로 완전히 닫혀 있고(metadata 미광고·모든 route 404) static bearer 경로는 byte 동일하며, flag를 여는 것은 #1369 랜딩과 runtime proof 폐곡선 뒤의 별도 운영 결정이다.
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
