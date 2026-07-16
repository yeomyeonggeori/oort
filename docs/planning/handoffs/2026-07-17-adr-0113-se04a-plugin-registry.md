# HANDOFF: ADR-0113 SE-04A — plugin manifest registry + install/grant 런타임

> Status: `ready`
> Planning ID: `ADR-0113` · Planner owner: `Fable` · Integrator: Fable(엔진/인프라 트랙 momo-main 겸임) · 구현: Codex worker(gpt-5.6-sol medium)
> 발급: 2026-07-17 · 기준 커밋: `9ade613` · Supersedes: 없음
> 근거 ADR: `ADR-0113 (Accepted 2026-07-17)` D2/D5/D6 · 대상 goal: MOMO-410 · 병렬 가능: 단독
> GitHub binding: MOMO-410=`#434` (발급 2026-07-17)

## 1. 결정 요약

ADR-0113은 플러그인 = "manifest + MCP 서버 참조 + momo 확장 필드"로 정의하고, momo 서버의 역할을 **카탈로그·설치 정책·grant 기록·감사**로 한정했다(토큰은 에이전트 호스트 소유 — 커스터디 A). 이 goal은 그 물리적 기반: registry 스키마 + manifest validator + install/grant/revoke REST + Capability Cache projection + 오피셜 시드 3종(GitHub/Notion/Linear — 16-03 실검증분). Drive 경로 C 포장·Slack-호환 webhook·카탈로그 UI는 후속 SE.

## 2. Goal 체인

| 순서 | goal | 이슈 | 의존 |
|---|---|---|---|
| 1 | MOMO-410 registry+validator+REST+시드 3종 | #434 | — |

후속 예약(이 goal 범위 밖): SE-04B(webhook+Slack-호환), GitHub grant 왕복, Drive 경로 C, 온보딩 추천 세트.

## 3. 파일 맵 (기획 시점 @ 9ade613)

| 대상 | 위치 | 지금 상태 | 변경 |
|---|---|---|---|
| 스키마 | `server/Migrations/` 최신 012 | plugin 계열 테이블 없음 | 신규 013: registry/install/grant/capability projection + RLS DO-block 등록 |
| 기존 참조 스펙 | `research/12-agentic-work-os/`의 plugin manifest 스펙·fixture (있으면 대조) + `research/16-plugin-platform/00·03` | spec/fixture 단계 | manifest 계약의 정본은 BUILD_TICKETS 수용기준 + ADR-0113 D6 |
| REST | `server/Sources/MomoServer/Routes/` | 없음 | 신규 `PluginRoutes.swift` — protected 그룹, App.swift 배선 최소 블록 |
| 시드 카탈로그 | — | 없음 | 오피셜 3종 manifest 픽스처(GitHub·Notion·Linear — 엔드포인트/라이선스는 16-03 표 그대로) |
| verifier | `scripts/` | 없음 | 신규 `verify_plugin_registry.sh` + `local_gate.sh`/`LOCAL_PR_GATE.md` 등록 |

## 4. 지켜야 할 계약

- **커스터디 A 하드 계약**: raw credential/OAuth 토큰을 어떤 테이블·로그·응답·audit detail에도 저장·노출 금지. grant 레코드는 (workspace, member, plugin, scope) 4-튜플 + 상태 + audit ref만.
- validator fail-closed: unknown protocol/tool schema/risk/approval policy/SPDX 비허용(GPL/AGPL 계열 거부)·digest 불일치·revoked install 전부 거부. 화이트리스트 방식.
- RLS FORCE(테넌트 테이블), audit_log 같은 트랜잭션, schema_v0 불변(신규 migration만), 단일 쓰기 경로.
- `docs/api/openapi.yaml` 무변경(웹 v0 표면 아님 — drift 게이트는 문서화된 라우트만 검사). `clients/**`·`infra/prod/**` 무변경. `App.swift` 배선 한 블록(UX 트랙 공유 핫파일).
- serverPolicy(설치 허용/기본 비활성/role 스코프)는 owner/admin만 변경. 카탈로그 읽기는 active member.
- egressDomains 필드는 manifest 필수(D5) — 시드 3종에 실제 도메인 기입.

## 5. 알려진 함정

- `research/12-agentic-work-os/`에 구 manifest 스펙/fixture가 있을 수 있다 — **정본은 ADR-0113 D6**(3층+확장 필드). 충돌 시 구 스펙을 따라가지 말고 이탈 보고.
- Capability Cache는 SE-01/02B(Context Broker) 합류 예정 — 이 goal은 **projection 테이블+무효화 계약까지만**(소비자는 후속). 과설계 금지.
- MOMO-403/404가 만든 migration 011/012와 번호 연속(013). RLS DO-block 등록 패턴은 001의 배열 방식 대조.
- UX 트랙이 메인 worktree에서 병렬 작업 중(MOMO-409) — worker는 자기 worktree에서만, `clients/macOS` 절대 금지.

## 6. 검증

- worker: swift build/test + verifier 스크립트 작성 + bash -n. docker 게이트(runtime-db)는 오케스트레이터.
- verifier 필수 케이스: validator fail-closed 매트릭스 / install→grant→revoke 왕복(audit) / cross-workspace 403 / grant 없는 플러그인의 projection 부재 / 시드 3종 등재 확인.
- 수용기준 정본: `BUILD_TICKETS.md` `### MOMO-410 수용기준`.

## 7~8. 이탈 보고·착수

기존 패킷들과 동일. worker는 PR 생성 후 정지, merge/close 금지, **장시간 대기 전 커밋·push 선행**.

## 9. 컨텍스트 델타

- 새로 고정: plugin 계열 스키마의 첫 물리화, grant 4-튜플, 오피셜 시드 3종의 manifest 형태.
- 결정하지 않은 것: 카탈로그 UI(UX 트랙 몫 — Codex UI handoff 대조 후), 커뮤니티 배포 채널, Capability Cache 소비자 배선.
- 재기획 질문: manifest 서명(publisher key) 체계의 v1 범위, 시드 카탈로그의 갱신 주기(레포 내 픽스처 vs 원격 인덱스).
