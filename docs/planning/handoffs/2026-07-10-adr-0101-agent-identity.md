# HANDOFF: ADR-0101 에이전트 신원 — agent_bearer 인증 배치

> Status: `done` — MOMO-337(#310, `8d97c82`)/MOMO-338(`561bd03`)/MOMO-339(#323, `881518b`) 전부 merge. Phase 1 배치 종결 (2026-07-11). 후속: MOMO-347 `#324`(popover 하드닝), MOMO-341(claim/lease), Phase 2(delegation)는 별도 ADR.
> Planning ID: `ADR-0101` · Planner owner: Fable · Integrator: `momo-main`
> 발급: 2026-07-10 · 최신 통합 커밋: `8d97c82ef1710e0a66e95ec50f72b9ff8d8cc41a` · Supersedes: 없음
> 근거 ADR: **ADR-0101 (Accepted 2026-07-10, Option A)** · 대상 goal: MOMO-337, MOMO-338, MOMO-339 · 병렬: 337 머지 후 338‖339 병렬 가능
> GitHub binding: MOMO-337=#307, MOMO-338=#308, MOMO-339=#309

## 1. 결정 요약

oort의 에이전트 인증은 현재 전 에이전트·전 워크스페이스 **공용 시크릿 1개**(`X-Momo-Agent-Gateway-Secret`)이고, 어댑터는 REST 쓰기를 위해 **사람 오퍼레이터 계정으로 로그인**한다. ADR-0101은 스키마에 이미 존재하는 `token(kind='agent_bearer')`를 실제 인증 경로로 승격해 **per-agent 자격증명(스코프·회전·폐기)** 으로 교체하기로 결정했다(Option A Phase 1). 이 배치는 Phase 1 전체다 — Phase 2(delegation)는 이 배치에 포함되지 않는다. 정본: `docs/adr/0101-agent-identity-credentials.md`.

## 2. Goal 체인과 의존

| 순서 | goal | 이슈 | 의존 | 병렬 |
|---|---|---|---|---|
| 1 | MOMO-337 서버 agent_bearer 발급/검증/이관 | #307 | 완료(PR #310, `8d97c82`) | 단독 선행 완료 |
| 2 | MOMO-338 어댑터 bearer 단일화 | #308 | MOMO-337 완료 | `done` — realtime-first + self-only `agentwork:` stream |
| 2 | MOMO-339 페어링 위저드 발급/회전 UI | #309 | MOMO-337, 262 완료 | 338과 병렬 가능, `ready` |

**머지 순서: 337 완료 → (338, 339 완료순).** 두 후속은 서로 다른 worktree에서 병렬 가능하다.

## 3. 파일 맵 (2026-07-09 감사 기준 — 착수 시 실제 코드와 대조)

| 대상 | 위치 | 지금 상태 | 해야 할 변경 |
|---|---|---|---|
| 게이트웨이 시크릿 검증 | `server/Sources/MomoServer/Routes/AgentGatewayRoutes.swift` (~:418-432) | `AGENT_GATEWAY_SECRET` 상수시간 비교 1개로 4개 라우트 보호 | agent_bearer 검증으로 교체 + `MOMO_ALLOW_LEGACY_GATEWAY_SECRET=1` 병행기 |
| 이관 대상 라우트 | 같은 파일: realtime-token(:29), jobs/pending(:72), gateway/events(:121), gateway/complete(:198) | 시크릿 헤더 인증 | Bearer 인증 + **토큰 actor = 대상 agent member 일치 검증** |
| 토큰 스키마 | `server/Migrations/001_init.sql:334-355` | `token_kind='agent_bearer'`, `scopes text[]`, `token_hash`(sha256, UNIQUE), `revoked_at` 전부 존재 | **스키마 변경 불필요** — 신규 마이그레이션 만들지 말 것 |
| 세션 토큰 저장 패턴 | `server/Sources/MomoServer/TokenStore.swift` | sha256(pgcrypto digest) 저장·조회·revoke 패턴 확립 | agent_bearer용 mint/verify/revoke를 같은 패턴으로 |
| 인증 미들웨어 | `server/Sources/MomoServer/AuthMiddleware.swift` | 모든 요청 DB 세션 재확인(fail-closed) | Bearer가 agent_bearer면 agent principal 해석 + scope 검사 |
| 발급 API (신규) | `POST /v1/workspaces/:ws/agents/:agent/credentials` | 없음 | human admin 인증으로 mint, 원문 1회 반환 |
| 어댑터 인증 | `adapters/hermes/momo_adapter.py` — 로그인 :486-509, gateway 헤더 :401-405, realtime token :511-535, send :732-779 | 오퍼레이터 email/password 로그인 + 시크릿 헤더 이중 체계. **:498 refreshToken은 저장만 하고 미사용(버그)** | `MOMO_AGENT_TOKEN` bearer 단일화, 로그인 경로·refreshToken 코드 제거 |
| 페어링 위저드 | `clients/macOS/Sources/MomoMac/ChannelListView.swift:769+`(popover), `MomoAgentPairing.swift`(:110 manifest, :20 endpointPolicy), `ChatViewModel.swift:477`(inviteDogfoodAgent) | 매니페스트/초대코드 생성, 시크릿은 env 파일 참조만 | 초대 완료 시 발급 API 호출 → 토큰 1회 표시 + env 기록 안내, 상태 칩/회전/폐기 |
| 시크릿 파일 | `~/.momo/hermes-gateway.env` (chmod 600, `scripts/momo hermes-gateway-init`이 생성) | `MOMO_AGENT_GATEWAY_SECRET` | `MOMO_AGENT_TOKEN` 추가 (구 키는 병행기 동안 유지) |
| e2e 검증 | `scripts/verify_hermes_gateway_adapter.sh` | 시크릿 헤더로 콜백 검증 (401 가드 포함) | bearer 경로로 갱신, legacy는 flag 케이스로 분리 |

> MOMO-337 구현 후 델타: 실제 서버에는 감사 당시 예상한 `/gateway/jobs/pending`이 없어서 PR #310에서 actor-bound recovery endpoint를 신설했다. `available_at <= now()`를 지키며, MOMO-338은 realtime-first를 유지하고 이 endpoint를 고빈도 idle polling에 사용하지 않는다.

## 4. 지켜야 할 계약

- **ADR-0004**: provider 자격증명(Codex/OpenAI OAuth)은 여전히 oort에 절대 들어오지 않는다. 이 배치는 oort↔agent 인증만 다룬다.
- **MOMO-262 계약**: 페어링 매니페스트/export에 시크릿(새 bearer 포함) 비포함 — 테스트로 고정돼 있음, 깨지 말 것.
- **쓰기 경로 불변식**: REST→PG→outbox→relay. 인증 교체가 메시지 경로 자체를 바꾸지 않는다.
- **MOMO-333 계약**: 에이전트 realtime token의 subject는 agent member — bearer 이관 후에도 subscribe proxy의 agent-stream 허용 로직이 계속 동작해야 한다.
- `token_hash`는 sha256만 저장(원문 저장 금지) — 기존 TokenStore 패턴 유지.
- `agent:`는 공유 채널 멤버가 보는 status/partial, `agentwork:`는 exact agent
  bearer가 받는 Context Packet/job이다. 두 payload class를 다시 한 namespace에
  합치지 않는다.

## 5. 알려진 함정

- `jwt-kit`은 `exact: 5.2.0` 핀 (Package.swift 주석 참조) — 버전 올리지 말 것.
- 어댑터의 `_handled_triggers` set은 무한 증가·비영속(알려진 이슈) — 이 배치 범위 아님, 건드리지 말고 이탈 보고에만 언급.
- 로컬 게이트 verifier들이 host 프로세스를 누수시킨 전례 있음(MOMO-319) — 게이트 연속 실행 전 `scripts/momo stop-stack` 권장.
- gateway 모드 env 전달은 `scripts/local_alpha_runner.sh`의 allowlist를 탄다(MOMO-329) — 새 env 키(`MOMO_ALLOW_LEGACY_GATEWAY_SECRET` 등)를 추가하면 runner allowlist에도 등록해야 런타임에 보인다.

## 6. 검증

- MOMO-337: `swift test --package-path server` + `scripts/local_gate.sh --profile runtime-agent` (bearer 경로 PASS)
- MOMO-338: `python3 adapters/hermes/tests/test_momo_adapter_contract.py` (로그인 없는 플로우로 계약 갱신)
- MOMO-339: `swift test --package-path clients/macOS` + `macos-ui` 게이트 + design-review Blocker 0
- 수용기준 정본: `BUILD_TICKETS.md` → `## ADR-0101 에이전트 신원 티켓` 섹션

## 7. 이탈 보고 의무

수용기준·ADR과 다르게 구현하게 되면 PR `## 계획 이탈` 섹션에 기록. 설계 판단이 필요하면 `scripts/goal_release.sh <issue> --blocked "<사유>"`로 멈추고 momo-main에 넘긴다. 임의 재설계 금지.

## 8. 착수 절차

```bash
scripts/goal_status.sh
scripts/goal_claim.sh <issue-number>
# 구현 → 게이트 → PR(이탈 섹션 포함) →
scripts/goal_release.sh <issue-number> --review --pr <PR URL>
```

## 9. 컨텍스트 델타

- 새로 고정: 기존 전역 gateway secret을 per-agent `agent_bearer`로 단계적으로 대체한다.
- 결정하지 않음: Phase 2 delegation 모델과 ADR-0102의 worker/gateway 실행 경로 선택.
- 재기획 질문: MOMO-337 구현에서 기존 gateway secret 호환 기간 또는 회전 UX가 계약과 달라지면 deviation으로 환류한다.
- MOMO-337 리뷰 결과: one-time token 응답 no-store, `token.created_by`, pending `available_at` guard를 보강했다. 후속의 남은 관찰은 bearer 사용 audit write 증폭이며, adapter의 bounded recovery로 우선 제어한다.
