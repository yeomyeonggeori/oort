# ADR 0102: 에이전트 실행 경로 정본화 — AgentWorker SSE vs Hermes Gateway

> Status: **Accepted** (2026-07-12, 성재 — Option C "역할 분리 이중 경로 + 보장 매트릭스")
> Date: 2026-07-10 (Proposed) → 2026-07-12 (Accepted)
> Related: ADR-0100 (SD-2/SD-5 소급), ADR-0101(에이전트 신원 — 두 경로 모두 `agent_bearer`로 수렴), ADR-0004

## Context

oort에는 에이전트 실행 경로가 **2개** 있고, 어느 쪽이 정본인지 결정된 적이 없다 (2026-07-09 감사 SD-2).

| | **AgentWorker SSE** (worker 모드) | **Hermes Gateway** (gateway 모드) |
|---|---|---|
| 구동 방식 | oort가 소유한 워커가 `agent_job` claim → provider의 OpenAI 호환 SSE 호출 | 사용자 소유 Hermes 프로세스가 realtime `agent.job` 수신 → REST 콜백 |
| provider 자격증명 | oort env의 `HERMES_API_KEY` (opaque bearer) | Hermes/provider 내부 (oort 완전 비관여, ADR-0004) |
| Context Packet | ✅ 서버가 job payload에 투영 | ✅ 동일 payload를 gateway job에도 투영 (이미 구현됨) |
| 승인(HITL) pause/resume | ✅ 설계·구현됨 (`resume_approval` outbox) | ❌ 없음 — 콜백은 running/complete뿐 |
| 스트리밍(부분 응답) | ✅ SSE 델타 수신 (채널 노출은 별개 과제) | ❌ 최종 메시지 1건 |
| 비용/감사 | ✅ reserve/reconcile + audit | ✅ complete 트랜잭션에서 usage/audit 기록 |
| 유실 복구 | outbox claim 재시도 | ✅ durable job + pending 폴링 (MOMO-0-4b-6p) |
| 실사용 (dogfood) | 사용 안 함 | **모든 실트래픽이 이 경로** (`@hermes` 실왕복 PASS) |

문제: 계약 문서(`research/11-agent-runtime/11-hermes-adapter-contract-v0.md`)는 "어댑터는 승인·비용·감사 보장을 증명하기 전까지 기본 경로가 아니다"라고 명시하는데, 실제 기본 경로가 gateway가 됐다. L4 스펙·README 다이어그램은 여전히 worker 경로만 그린다. 이 모순을 해소하지 않으면 승인 UX(§agent-native의 핵심)가 실트래픽에서 계속 우회된다.

## 업계는 어떻게 하나

Slack의 대응물은 "앱을 어디서 실행하느냐"다: 초기에는 외부 호스팅(webhook/Socket Mode = oort의 gateway와 동형)뿐이었고, 이후 Slack-호스팅 실행(Workflow Steps/자동화 플랫폼)을 추가해 **이중 경로를 공식화**했다. 교훈: 실행 위치가 달라도 **플랫폼 보장(권한·감사·과금)은 플랫폼 쪽 기계장치로 통일**해야 한다 — Slack은 보장을 앱 쪽에 맡기지 않고 API 계층(스코프, 감사 로그, rate limit)에서 강제한다. oort도 승인·비용·감사를 경로별 구현이 아니라 **서버 기계장치**로 통일하는 것이 같은 원리다.

## Options

### Option A — Gateway 정본 승격, Worker 폐기
사용 실적이 있는 쪽으로 단일화. **기각 권고**: AgentWorker는 "oort가 관리하는(managed) 에이전트" — 사용자가 별도 프로세스를 못 띄우는 환경(향후 호스팅판, 서버측 자동화 에이전트)의 유일한 경로다. 폐기하면 제품 옵션이 좁아진다.

### Option B — Worker 복권, Gateway는 interop 한정
계약 문서 원안. **기각 권고**: 실사용자(성재)의 실제 운용 형태가 "내 Hermes를 데려온다(bring-your-own-agent)"이고, 이것이 agent-native 초대 경험의 핵심이다. 현실을 뒤집는 결정은 P13(도그푸딩 검증) 위반.

### Option C — 역할 분리 이중 경로 + 단일 보장 매트릭스 (권고)
두 경로를 **에이전트 유형별 공식 경로**로 정본화한다:
- **gateway = BYOA(bring-your-own-agent)** 경로: 사용자 소유 런타임 (현 Hermes dogfood).
- **worker = managed** 경로: oort가 실행을 소유하는 에이전트 (향후 서버측 에이전트/호스팅판).

그리고 **보장 매트릭스를 서버 기계장치로 통일**한다 — 경로와 무관하게 `agent_run` 상태머신·승인·비용·감사는 서버가 소유하고, 두 경로는 전달 방식만 다르다:
1. (즉시) gateway 경로에 **승인 이벤트** 추가: 어댑터 콜백으로 `approval_request` 생성 → run `awaiting_approval` → 사람 결정 시 기존 `resume_approval` outbox가 gateway에도 `agent.job`(resume)을 publish. 스키마 변경 불필요.
2. (즉시) gateway 경로에 **status/partial 이벤트** 수용: `/gateway/events`가 `thinking/streaming` 델타를 받아 `agent.status`/`agent.partial`로 채널에 브로드캐스트 (클라 스트리밍 UI는 이미 있음).
3. (문서) L4 스펙 §6·README 다이어그램·adapter-contract-v0를 이중 경로 + 보장 매트릭스로 재정렬. SD-5의 핫픽스 API 표면들(agent realtime-token, pending recovery, `AGENT_GATEWAY_MODE`)을 이 ADR로 소급 승인.
4. (ADR-0101 연동) 두 경로 모두 agent_bearer 인증으로 수렴 — gateway 시크릿 폐기 일정 공유.

**장점**: 현실 인정 + 제품 옵션 보존 + 보장을 한 곳(서버)에 모아 경로별 드리프트 차단. **단점**: 두 경로 유지비 — 보장 매트릭스 게이트(두 경로 동일 시나리오 verifier)로 상쇄.

## Decision

**Option C 채택** (2026-07-12, 성재). 두 경로를 에이전트 유형별 공식 경로로 정본화하고(gateway=BYOA, worker=managed), 승인·비용·감사 보장은 서버 기계장치로 통일한다.

### SD-5 API 표면 소급 승인

ADR-0100이 SD-5로 분류한 다음 표면을 Option C의 공식 계약으로 **소급 승인**한다. 이 표면들은 새 제3의 실행 경로가 아니라 gateway(BYOA)가 서버 소유 보장에 접속하는 경계다.

| 표면 | 승인된 역할 | 서버 강제 조건 |
|---|---|---|
| `POST /v1/auth/realtime-token` | agent가 observable `agent:` progress와 private `agentwork:` job stream에 접속할 단기 Centrifugo connection JWT 발급 | `agent_bearer` + `realtime:subscribe`; connection JWT의 `meta.token_id`를 exact credential에 결속 |
| `GET /v1/workspaces/:ws/agents/:agent/gateway/jobs/pending` | realtime 유실·재연결 때 durable `agent_job`을 bounded recovery | `agent_bearer` + `agent:jobs:read`; token actor와 path agent 일치; DB의 pending/available job만 반환 |
| `AGENT_GATEWAY_MODE=worker\|gateway` | 배포가 managed worker 또는 BYOA gateway 전달 방식을 선택 | 실행 위치만 선택하며 `agent_run`·approval·usage/audit·message/outbox의 서버 소유권은 바꾸지 않음 |

gateway 콜백 `POST .../gateway/events`와 `POST .../gateway/complete`도 같은 `agent_bearer`의 `agent:runs:callback` scope와 actor/run binding을 통과해야 한다. 모든 사용자 가시 쓰기는 REST → Postgres transaction → outbox → relay를 유지한다.

### ADR-0101 연동과 legacy secret 폐기 일정

두 공식 경로의 oort 신원은 `token.kind='agent_bearer'`로 수렴한다. worker는 서버가 run의 agent identity를 결속하고, gateway는 같은 agent의 bearer로 realtime-token·pending recovery·callback·message write를 수행한다. provider OAuth/API key는 어느 경로에서도 이 토큰으로 대체하거나 oort에 유입하지 않는다(ADR-0004).

`X-Momo-Agent-Gateway-Secret` / `AGENT_GATEWAY_SECRET`는 공식 인증 경로가 아니다. 폐기 일정은 날짜가 아니라 검증 게이트에 결속한다.

1. **현재~동등성 게이트:** `MOMO_ALLOW_LEGACY_GATEWAY_SECRET=0`이 기본이며 dogfood·정상 운영은 `agent_bearer`만 사용한다. legacy secret은 이관 회귀검증에만 명시적으로 `1`로 열 수 있다.
2. **호환 창 종료:** MOMO-349/350/341이 반영되고 MOMO-352의 두 경로 동등성 verifier가 clean/root `runtime-agent`에서 PASS하면 호환 창을 닫는다.
3. **물리 제거:** 위 PASS 직후 별도 보안 정리 change에서 legacy header, `AGENT_GATEWAY_SECRET`, `MOMO_ALLOW_LEGACY_GATEWAY_SECRET` 및 전용 회귀 케이스를 제거한다. 최종 시한은 M7 진입 전이며, 제거 전까지 신규 배포·문서·어댑터가 legacy secret에 의존해서는 안 된다.

파생 티켓 (같은 배치, 핸드오프 패킷 `docs/planning/handoffs/2026-07-12-adr-0102-execution-path.md`):
- **MOMO-349** gateway 승인 왕복 (approval_request 콜백 → awaiting_approval → resume publish)
- **MOMO-350** gateway status/partial 브로드캐스트 (`/gateway/events` → `agent.status`/`agent.partial`)
- **MOMO-351** 스펙/다이어그램/계약 문서 재정렬 + SD-5 소급 승인
- **MOMO-352** 이중 경로 동등성 verifier (같은 시나리오, 두 경로 동일 보장 증명)
- **MOMO-341** gateway 다중 인스턴스 claim/lease + takeover (기존 수용기준, 이 배치에 합류 — 성재 지시 2026-07-12)

## Consequences (Option C 기준)

- 승인 UX가 실트래픽(gateway)에서 처음으로 동작 — agent-native 시그니처 경험 C(승인 인박스)가 실물이 됨.
- "에이전트가 일하는 과정이 보인다"(스트리밍/상태)가 gateway에서도 성립 — ADR-0104(존재감)의 전제.
- 계약 문서 모순 해소 + 스펙이 코드 현실과 재정렬.
- worker 경로는 managed 에이전트 로드맵(호스팅판)까지 유지 부담을 안고 감 — 동등성 verifier가 없으면 다시 드리프트하므로 ④가 필수 티켓.
- `AGENT_GATEWAY_MODE`의 기본값이 `worker`인 것은 안전한 배포 기본값일 뿐 product-path 우열을 뜻하지 않는다. 에이전트 유형에 따라 두 값 모두 공식이다.

## References

- `research/11-agent-runtime/11-hermes-adapter-contract-v0.md` (모순의 원점)
- `server/Sources/MomoServer/Routes/AgentGatewayRoutes.swift` (gateway 콜백), `ApprovalDecisionRoutes.swift` (`resume_approval` outbox)
- `docs/architecture/overview.md` (이중 경로 현황 다이어그램)
- 2026-07-09 진단 §2/§5/§6 (SD-2, SD-5)
