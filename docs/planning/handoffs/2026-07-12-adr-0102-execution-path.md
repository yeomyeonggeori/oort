# HANDOFF: ADR-0102 실행 경로 정본화 — 이중 경로 + 보장 매트릭스 배치

> Status: `done` — 5 goal 전부 merge (2026-07-12): 351(#335 `ebb3a52`) · 353(#334→PR #336 `8337ae2`) · 349(#337 `b5b39df`) · 350(#338 `f079279`) · 341(#339 `6fcb870`) · 352(#340 `bb76152`). root runtime-agent full gate green(동등성 verifier 포함) — **legacy secret 호환 창 종료 조건 충족**. 후속: legacy 물리 제거 보안 정리 티켓(성재 승인 대기, M7 전 시한).
> Planning ID: `ADR-0102` · Planner owner: Fable · Integrator: `momo-main`
> 발급: 2026-07-12 · 기준 커밋: `c6af6fc` · Supersedes: 없음
> 근거 ADR: **ADR-0102 (Accepted 2026-07-12, Option C)** · 대상 goal: MOMO-349/350/341/352 + MOMO-351(docs)
> GitHub binding: MOMO-349=#329, MOMO-350=#330, MOMO-351=#331, MOMO-352=#332, MOMO-341=#333
> 병행 독립 티켓: MOMO-353=#334 (drift-guard — 이 배치와 무관, 언제든 병렬)

## 1. 결정 요약

oort의 에이전트 실행 경로 2개를 **역할 분리 이중 경로**로 정본화한다: **gateway = BYOA**(사용자 소유 런타임, 현 Hermes dogfood), **worker = managed**(oort 소유 실행, 향후 호스팅판). 승인·비용·감사 보장은 경로별 구현이 아니라 **서버 기계장치로 통일**한다 — `agent_run` 상태머신·`approval`·`usage_ledger`/`audit_log`는 서버가 소유하고 두 경로는 전달 방식만 다르다. 정본: `docs/adr/0102-agent-execution-path.md`.

## 2. Goal 체인과 의존 (머지 순서)

| 순서 | goal | 이슈 | 의존 | 병렬 |
|---|---|---|---|---|
| 1 | MOMO-349 gateway 승인 왕복 | #329 | 337/338 (완료) | 351과 병렬 가능 |
| 병렬 | MOMO-351 스펙/다이어그램 재정렬 (docs) | #331 | 없음 (최종 문구는 349/350 후 확정 권장) | 아무 때나 |
| 2 | MOMO-350 gateway status/partial | #330 | **349 merge 후** (같은 라우트/어댑터 표면) | — |
| 3 | MOMO-341 claim/lease + takeover | #333 | **350 merge 후** (같은 gateway 표면 순차화) | — |
| 4 | MOMO-352 이중 경로 동등성 verifier | #332 | **349+350+341 merge 후** (배치 마지막) | — |

**349→350→341→352 순차 + 351 병렬.** 동시 worker 최대 2 (한 개는 순차 체인, 한 개는 351/353).

## 3. 파일 맵 (2026-07-12 감사 기준 — 착수 시 실제 코드와 대조)

| 대상 | 위치 | 지금 상태 | 해야 할 변경 (goal) |
|---|---|---|---|
| gateway 콜백 라우트 | `server/Sources/MomoServer/Routes/AgentGatewayRoutes.swift` | events는 running/complete, pending recovery는 actor-bound | `approval_request` 이벤트 수용(349), `thinking`/`streaming` 델타 수용(350) |
| 승인 상태머신 | `server/Sources/MomoServer/Routes/ApprovalDecisionRoutes.swift` + `approval`/`approval_decision` 테이블 | worker 경로용으로 완비, `resume_approval` outbox 발행 | 재사용 — gateway run에도 같은 outbox가 resume `agent.job`을 publish하는지 확인/연결(349). **스키마 변경 불필요** |
| agent progress publish | `server/Sources/MomoServer/Routes/CentrifugoRoutes.swift` + relay | `agent:`(observable)/`agentwork:`(private) 분리 완비 (MOMO-338) | status/partial 브로드캐스트가 `agent:` namespace 관례를 따르게(350) |
| 어댑터 | `adapters/hermes/momo_adapter.py` | bearer 단일화(338), realtime-first + bounded recovery | 승인 필요 tool-call 시 `approval_request` 콜백 + resume 수신 처리(349), provider 델타 이벤트 전달(350) |
| pending job 저장 | `outbox` (kind=`agent_job`) + pending recovery endpoint | actor-bound read, lease 없음 | 신규 migration으로 lease 칼럼/테이블 + `FOR UPDATE SKIP LOCKED` claim(341) |
| gateway verifier | `scripts/verify_hermes_gateway_adapter.sh` | 격리 DB + bearer/legacy 시나리오 (346) | 승인 왕복(349)·status/partial(350)·lease 중복 방지(341) 시나리오 추가 |
| 동등성 verifier (신규) | `scripts/verify_agent_path_equivalence.sh` | 없음 | 352에서 신설 + `runtime-agent` profile 배선 |
| 계약 문서 | `research/11-agent-runtime/11-hermes-adapter-contract-v0.md`, L4 §6, `docs/architecture/overview.md`, README | worker 단일 경로 전제 (모순) | 이중 경로 + 보장 매트릭스로 재작성(351) |

## 4. 지켜야 할 계약

- **ADR-0004**: provider 자격증명은 oort에 절대 비유입. 이 배치는 oort↔agent 전달 계층만 다룬다.
- **단일 쓰기경로**: REST→PG→outbox→relay. gateway 이벤트도 서버가 PG 트랜잭션으로 기록 후 outbox로 publish.
- **actor/run binding**: 콜백 bearer의 agent = run의 agent, run↔channel 위조 불가 (MOMO-337/338 계약).
- **`agent:` vs `agentwork:`**: observable progress와 private job payload를 한 namespace에 합치지 않는다 (MOMO-338).
- `schema_v0.sql` 수정·이동 금지 — 341의 lease는 신규 migration.
- 새 env 키는 `scripts/local_alpha_runner.sh` allowlist에 등록해야 런타임에 보인다 (MOMO-329 함정).

## 5. 알려진 함정 (검수에서 피 흘리며 확인된 것)

- **verifier 격리 패턴 필수** (MOMO-344~348): marker/OID-owned migrated DB, **per-run 채널 UUID**(relay `version=seq` stale skip 방지), **CENT_CHANNEL 대문자 정규화**(Swift UUID 대문자 렌더링), source digest EXIT trap, exit 96 rollback 회귀, 신규 스크립트 `chmod +x`.
- `jwt-kit`은 `exact: 5.2.0` 핀 — 올리지 말 것.
- 게이트 잔류 프로세스 누수(MOMO-319/353): 실패 런 후 포트 점유 확인. worker는 docker/DB 접속 금지 — 게이트는 오케스트레이터가 수행.
- 351 문서 수정 시 `docs` profile 게이트가 깨지지 않게 링크/앵커 확인.

## 6. 검증

- 349/350/341: 어댑터 tests + `verify_hermes_gateway_adapter.sh` 확장 + `scripts/local_gate.sh --profile runtime-agent` (worktree clean + root post-merge).
- 352: 신규 동등성 verifier 자체가 수용기준 — 두 경로 동일 시나리오 PASS.
- 351: `--profile docs` PASS.
- 전 goal 공통: 보안/correctness 리뷰(fresh context), BUILD_TICKETS/STATUS/JOURNAL 갱신, momo-main 순차 merge.
