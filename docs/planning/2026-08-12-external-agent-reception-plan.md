# Bring your hosted agent — pairing launch 실행 계획 (2026-08-12)

> 제품 방향과 실행 순서 및 ADR-0162의 공개 API·인증·스키마 경계는 2026-08-12 성재 승인으로 Accepted됐다(ADR-0100). HAP/UX Issue #1358~#1369, M1, Project #44, native `blockedBy`, `BUILD_TICKETS.md`와 ready 패킷 binding을 완료했다.
>
> 현재 목표: 사용자가 이미 호스팅 중인 에이전트를 oort의 1급 `agent` 멤버로 연결한다. **“Bring your hosted agent”**가 벤더 중립 약속이고, **Grok Bot도 몇 단계로 연결할 수 있음**을 첫 preset과 실증으로 보여준다.
>
> 실행 패킷: `docs/planning/handoffs/2026-08-12-hosted-agent-pairing-launch-packet.md`
>
> Grok 실측: `docs/planning/2026-08-12-grok-bot-trial-spike-report.md` — team account는 강제 `NO_STORAGE` 정책에 막혔지만 personal account는 별도 trial 시작·결제 없이 Bot/채팅을 실행했다. 비공개 plugin의 custom MCP loader는 공개 Agent Port까지 도달해 route 부재 404를 받았고, Active-off routine의 수동 Test run과 routine/connector 개별 삭제 동작까지 측정했다. auth/pairing/tool call/full E2E는 후속 HAP-E2/E3 이후 `runtime-unverified`다.

## 1. 확정한 제품 원칙

1. **가져오는 것은 봇 정의나 xAI/Cursor 계정이 아니라 연결이다.** 외부 hosted agent의 runtime·모델·provider credential은 외부 서비스에 남고, oort는 member identity·권한·inbox·승인·메시지 원장을 소유한다.
2. **자동 roster scraping을 하지 않는다.** 2026-08-12 공식 문서에서 Grok Bot 열거/호출용 공개 API를 확인하지 못했다. v0 감지는 일회성 pairing challenge를 가진 봇이 oort MCP에 먼저 접속할 때 성립한다.
3. **한 Bot = 한 connection = 한 dedicated agent member = 한 routine.** v0에서 기존 agent member에 hosted runtime을 덧붙이거나 여러 봇을 한 connector/token에 숨기지 않는다. 연결마다 pause·권한·감사·해제가 독립돼야 한다.
4. **기존 실행 척추를 재사용한다.** 새 task ledger를 만들지 않고 durable agent gateway의 pending/lease/events/complete 계약을 thin MCP binding으로 노출한다. 사용자 가시 쓰기는 REST→Postgres transaction→outbox→relay를 통과한다.
5. **해제는 로컬 차단과 외부 정리를 분리한다.** oort credential은 즉시 revoke하고 새 작업·쓰기를 막는다. Grok routine/connector 삭제 확인 전에는 `cleanup_pending`이며, 역사 메시지·작업·agent member는 보존한다.
6. **Grok는 preset이지 코어 의존성이 아니다.** trial이 노출되지 않거나 베타가 바뀌어도 generic pairing/auth/inbox 구현은 계속할 수 있다. 다만 “Grok 연동 검증됨” 문구는 실제 E2E 전 사용하지 않는다.

## 2. 시작 전에 사용자에게 필요한 것

- **받지 않는 것:** Cursor/xAI 비밀번호, MFA 코드, session cookie, API token, 결제정보. 사용자가 로그인·동의 화면을 직접 완료한다.
- **확인 완료:** 성재 승인 뒤 공식 Grok Bot 앱을 설치했고 사용자가 직접 인증했다. 조직 관리 team account는 `trialEligible=true`여도 강제 `NO_STORAGE` 정책에 막혔으며, personal account는 구매 없이 Bot 1개를 생성하고 기본 채팅까지 실행했다.
- **실측 완료:** personal account에서 test Bot과 기본 채팅, custom remote MCP URL을 가진 비공개 local plugin, loader의 실제 HTTP 요청, Active-off routine 저장·수동 실행·삭제, connector Uninstall을 확인했다. Uninstall 뒤 local plugin source가 남았고 Bot 삭제는 취소했다.
- **다음 구현·실증:** HAP-E2/E3에서 Agent Port route와 인증·pairing을 세운 뒤 같은 Bot으로 auth challenge, tool call, pair→work→disconnect를 별도 E2E로 닫는다. cleanup은 routine·connector·local files를 각각 확인하고 Bot은 `deleted` 또는 `preserved_intentionally` disposition을 명시한다. #1344는 이 구현 전 측정 범위까지 완료했다.
- **금지:** 기능 실측이 막혀도 임의 결제·구독을 시작하지 않는다. `#1344`에는 account 종류와 UI 결과만 redacted evidence로 남기고 credential·cookie·결제정보는 남기지 않는다.

## 3. 권장 실행 순서와 기대효과

| 순서 | 실질 작업 | 완료 증거 | 기대효과 |
|---|---|---|---|
| **1. 사실·거버넌스 수리 — 완료** | #1343에서 stale 사실을 교정하고 ADR-0162를 pairing/lifecycle 경계로 좁혔다. ADR-0163 카탈로그와 #1345 ACP 감사는 별도/deferred로 분리했고 ROADMAP/Issue DAG를 맞췄다. | #1343 docs gate·독립 검수 완료, ADR-0162 Accepted | 잘못된 ACP 재건이나 유료 계정 전제를 따라가는 낭비를 막고 한 런칭 축에 집중 |
| **2. trial-first Grok capability spike — 완료** | #1344에서 공식 앱 provenance와 team `NO_STORAGE` gate를 기록하고, personal account에서 구매 없이 Bot·채팅을 실행했다. 공식 MIT `Create Plugin`으로 비공개 local plugin을 만들자 loader의 `POST initialize`/`GET`이 공개 Agent Port까지 도달한 뒤 route 부재 HTTP/2 404로 실패했다. Active-off monthly routine은 수동 Test run에 성공했고, routine 삭제와 connector Uninstall의 잔여 동작을 각각 확인했다. | redacted 앱·HTTP·UI evidence; 구매 0원; custom transport와 routine manual execution PASS, auth/pairing/tool call/full E2E는 HAP-E2/E3 이후로 명시적 이관 | Grok 쪽 지원 여부가 아니라 oort route 부재가 현재 첫 blocker임을 확인했고, connector 목록과 local source를 모두 확인해야 하는 cleanup UX 근거를 확보 |
| **3. generic pairing·auth** | #1358 credential issue/list/rotate/revoke와 audit, #1363 MCP 2026-07-28 modern core + exact 2025-11-25 legacy compatibility, #1364 one-time pairing lifecycle을 구현한다. 첫 wave는 `static_bearer`만 활성화한다. dedicated agent member+paused profile+pairing connection을 원자 생성하고 봇의 최초 유효 호출로 `pairing_pending → detected`, 사람 확인과 별도 active credential 교체·검증을 모두 마친 같은 activation transaction에서만 unpause+`active`로 전이한다. hosted dedicated member의 generic issue/rotate/revoke를 `409`로 거부하고 disconnect→새 pairing으로만 교체한다. hosted credential은 canonical Agent Port에서만 인증되며 generic REST/realtime principal로 재사용하지 않는다. #1366 selector와 #1367 disconnect guard가 모두 랜딩하기 전 production delivery는 0이고, 사용자-facing gate는 #1360+#1362까지 요구한다. | modern `server/discover`와 per-request metadata, legacy initialize adapter, member/connection 1:1 uniqueness, pending/detected/expired mention delivery·job 0, pre-E6 production delivery 0, hosted generic credential mutation 0, direct REST/realtime mutation 0, raw secret 1회 노출/no-store, hash-at-rest, expiry/replay/race/redaction/RLS red proofs | roster API 없는 hosted agent도 안전하게 “스스로 나타나고 사람이 확정”하는 공통 UX 확보; 미구현 OAuth를 광고하지 않음 |
| **4. durable inbox + gateway thin binding** | #1365에 agent-scoped opaque inbox cursor를 두고 채널별 `message.seq`를 전역 cursor로 오용하지 않는다. #1366은 MCP tools를 기존 pending/lease/events/complete와 message spine에 얇게 매핑하고, 전역 `AGENT_GATEWAY_MODE` 대신 활성 hosted connection 기준 per-agent delivery selector를 둔다. hosted 발급 scope는 `{agent:port:connect, agent:inbox:read, messages:read, messages:write, agent:jobs:read, agent:runs:callback}`의 부분집합으로만 허용한다. | 서로 다른 채널에서 같은 `seq=1`이어도 누락·중복 없는 recovery, connect-only tools 0, scope별 tools/list filtering, broader generic scope 발급 0, lease takeover, idempotent post/complete, managed+hosted 동시 mention이 각자의 기존 publish/gateway 목적지로 정확히 분기 | hosted agent가 재연결 후에도 일감을 잃지 않고 기존 승인·비용·감사 보장을 그대로 소비하며 managed agent와 공존 |
| **5. web/Tauri Grok preset wizard** | #1360에서 `/agents`의 “Bring your hosted agent” 진입→provider preset→설정 복사→대기→감지→이름/채널/권한 확인→별도 active credential 1회 전달→provider connector secret 교체→active credential 검증→test mention을 구현한다. 첫 wave는 static bearer만 제공하고 OAuth 선택지는 #1368 authorization server와 #1369 consent/wizard 복귀가 모두 검증될 때까지 숨긴다. Grok preset은 connector와 routine 이름을 deterministic manifest로 제시한다. | 키보드/스크린리더 상태 알림, 만료/늦은 응답/replay UX, pairing secret의 active 재사용 금지, active 검증 전 capability 0, 미지원 OAuth 선택 0, design review Blocker 0 | 사용자는 서버 배포나 token 구조를 몰라도 몇 단계로 자기 hosted agent를 팀메이트로 연결 |
| **6. 해제 폐곡선** | #1367에서 revoke/pause/new-job block을 원자적으로 강제한다. #1362는 `cleanup_pending` checklist로 Grok routine과 MCP connector/local files 삭제를 안내·확인하고, API 확인이 없으면 명시적 수동 확인 후 `disconnected`로 바꾼다. | revoke 직후 old credential/write/claim 거부, cleanup acknowledgement audit, 역사 보존 | “메신저에서만 사라지고 외부 routine은 계속 돈다”는 유령 자동화와 비용·정보 유출 차단 |
| **7. 실제 Grok E2E·런칭 증거** | personal account의 무구매 access에서 deterministic routine `Oort Inbox: <workspace> / <agent>` 하나로 pair→detect→activate→scheduled wake→job→reply→disconnect→cleanup을 실주행한다. 사람이 Test run을 누르지 않은 실제 schedule 발화를 포함한다. | timestamp·앱버전·실행 로그·redacted screenshot, wake latency/cadence/retry provenance, routine/connector/local files 잔여 0과 Bot `deleted | preserved_intentionally` disposition 확인 | “Grok Bot도 연결”을 manual demo가 아닌 실제 자동화 주기까지 포함한 재현 가능한 운영 런북으로 전환 |

### 3.1 기술 DAG

```text
#1343 docs/spec repair
  ├─> #1344 Grok trial spike (manual app/login; no purchase)
  └─> ADR-0162 Accepted (2026-08-12)
        ├─> #1358 HAP-E1 credential lifecycle ─┐
        └─> #1363 HAP-E2 MCP foundation ──────┴─> #1364 HAP-E3 pairing lifecycle
                                                        └─> #1365 HAP-E4 durable inbox
                                                                 └─> #1366 HAP-E5 gateway thin binding
                                                                          ├─> #1360 UX-1 web/Tauri pairing wizard
                                                                          └─> #1367 HAP-E6 disconnect enforcement
                                                                                   └─> #1362 UX-2 disconnect cleanup
        #1364 shared core contract ─────────────────────────────────────> #1359 UX-3 mobile read-only status

#1344 + #1358 + #1363..#1367 + #1360/#1362 ─> #1361 real Grok E2E evidence

#1364 ─> #1368 OAuth authorization-server mode ─┐
                      #1360 static wizard ──────┴─> #1369 consent + OAuth wizard 복귀
         (후속; #1368/#1369 모두 v0 static pairing 비차단)

#1345 ACP audit -------------------- deferred, non-blocking
ADR-0163 managed catalog/self-host -- deferred, non-blocking
```

HAP-E1~E7와 UX-1~UX-4는 #1358~#1369로 발급됐고 모두 M1·Project #44 `Todo`에 결속됐다. #1358/#1363은 #1344의 Accepted ADR landing 직후 `status:ready`로 전환하고, 1 Issue=1 goal로 구현한다. #1368은 #1364 뒤 OAuth AS 후속, #1369는 #1368과 #1360 뒤 resource-owner 로그인·동의 및 pairing wizard 복귀 후속이며 둘 다 첫 wave static pairing의 blocker가 아니다. Grok 실측에서 OAuth가 필수로 확인되면 #1361에 두 goal을 모두 선행 의존으로 추가하고 static bearer로 downgrade하지 않는다.

## 4. lifecycle·감지·해제 계약

### 4.1 감지

```text
pairing_pending (UI: waiting for agent)
  -- one-time challenge + authenticated MCP handshake -----------------> detected
  -- human confirms + separate credential proof + member unpause ------> active
  -- expiry before active proof ----------------------------------------> expired
```

- client가 보내는 display name/provider 문자열은 권위가 아니다. 서버가 challenge hash, workspace, intended agent, expiry, consumed-at을 검증한다.
- `detected`는 연결 후보를 찾았다는 뜻일 뿐 메시지 쓰기나 job claim 권한이 아니다.
- 사람 확인 전에는 active bearer를 발급하지 않는다. 사람 확인 뒤에도 pairing challenge와 별도인 active credential의 전달/교환·검증 및 dedicated member unpause가 같은 activation 경계에서 끝날 때까지 data capability는 0이다. 최초 raw secret은 한 번만 보여주고 서버에는 hash만 저장한다.

### 4.2 외부 artifact manifest

연결마다 최소 다음을 기록·표시한다.

- provider preset과 사용자 확인용 connection name
- MCP connector 표시명/URL fingerprint
- routine 표시명: `Oort Inbox: <workspace> / <agent>`
- setup이 만든 local plugin source의 존재 여부와 사용자용 표시명. 개인 filesystem path 자체는 서버에 저장하지 않는다.
- 생성 확인 시각, 마지막 확인 시각, 정리 방식(`api_confirmed` 또는 `manual_ack`)

Grok가 routine 삭제 API를 공개하지 않은 동안 oort가 자동 삭제했다고 주장하지 않는다.

### 4.3 해제

```text
active
  -- local revoke transaction --> cleanup_pending
  -- routine + connector + optional local source removal confirmed/acknowledged --> disconnected
```

local revoke transaction은 credential revoke, connection 전용 agent member pause, pending/new job delivery 차단, lease/쓰기 재검증을 함께 닫는다. generic credential API는 hosted dedicated member의 issue/rotate/revoke를 `409`로 거부한다. 만료·operator emergency revoke를 매 호출 guard가 처음 관측하면 capability를 열지 않고 pause+`cleanup_pending`을 원자 적용한다. dedicated member에는 live hosted connection을 동시에 하나만 허용하므로 다른 managed/BYOA/hosted runtime을 멈추지 않는다. 이미 커밋된 메시지·run·audit·member identity는 삭제하지 않는다. 재연결은 cleanup 완료 뒤 같은 dedicated member에 기존 credential을 부활시키는 대신 새 pairing을 발급한다.

## 5. 범위 밖 / 별도 축

- **ACP #1345:** `work_tool_profile`은 이미 DDL/Rust에 있고 Swift `MomoACPHost` 구현도 존재한다. Rust-native work host와 원격 event path의 잔여 범위를 감사하는 별도 작업이며 현재 hosted-agent 런칭을 막지 않는다.
- **ADR-0163 managed catalog:** 셀프호스트 adapter 동봉·버전·update는 공급망/host-control 경계다. Proposed/deferred이며 이번 DAG에서 구현 이슈를 발급하지 않는다.
- Grok Bot roster scraping, Cursor/xAI private API reverse engineering, browser/session cookie 수집
- Slack 초인종 브리지는 trial이 routine cadence 한계를 입증한 뒤 별도 opt-in 결정으로만 검토
- mobile에서 pairing/disconnect mutation. v0 mobile은 status와 cleanup 필요 여부만 읽는다.

## 6. 완료 정의

이 축의 런칭 완료는 다음 모두를 뜻한다.

1. ADR-0162 Accepted 경계와 실제 API/schema가 일치하고 Rust/web/shared-core hard gate가 green
2. generic mock hosted agent로 pair→recover→claim→reply→disconnect red/green proof 완료
3. web/Tauri에서 사람이 탐지 후보와 권한을 확인하고, 해제 후 외부 cleanup 필요 여부를 오해하지 않음
4. #1344가 Bot/custom-MCP transport/manual routine/개별 cleanup 측정을 완료했더라도 실제 Grok E2E까지 닫힌 것은 아니다. HAP-E2/E3 이후 auth challenge·pairing·tool call·disconnect, provider artifact별 cleanup과 Bot의 `deleted | preserved_intentionally` disposition까지 닫혀야 Grok-specific claim을 승격하며, 그 전에는 generic feature와 Grok-specific claim을 분리해 `runtime-unverified`로 유지
5. 사용자 password/MFA/token/결제정보가 이슈·로그·문서·screenshot에 들어가지 않음
6. public launch copy는 실제 증거 수준을 넘지 않음: 실증 전 “Grok preset 제공”, 실증 후에만 “Grok Bot 연결 검증됨”
