# HANDOFF: ADR-0121 셀프호스팅 배치 1 — install/upgrade + 초대 보안 계약

> Status: `ready`
> Planning ID: `ADR-0121` · Planner owner: `Fable` · Integrator: Fable(엔진/인프라 트랙 momo-main 겸임, 성재 승인 2026-07-15) · **구현: Codex worker(gpt-5.6-sol medium, 성재 지시 2026-07-16 — Fable 전담 체제 종료)**
> 발급: 2026-07-16 · 기준 커밋: `51ff19d` · Supersedes: 없음
> 근거 ADR: `ADR-0121 (Accepted 2026-07-15)` D1-A/D3 + ADR-0002(install/upgrade 레이어 예약) · 대상 goal: MOMO-406, MOMO-407 · 병렬 가능: **예** — 파일군 분리(infra/scripts/docs vs server), 머지는 406 → 407 순차
> GitHub binding: MOMO-406=`#425`, MOMO-407=`#426` (발급 2026-07-16)

## 1. 결정 요약

ADR-0121은 "서버 파기를 런북에서 제품으로" 만드는 결정이다. 이 배치는 그 첫 실행분: ① S-1(MOMO-406) — ADR-0002가 예약만 해둔 `install.sh`/`upgrade.sh`를 구현하고 "5분 설치" 문서와 단일 노드 상한 명시(D1-A) ② S-2(MOMO-407) — 초대 보안 계약(만료 기본값·역할 바인딩·regenerate, D3)을 서버에 구현. universal link(S-4)·relay 등록(S-5)은 범위 밖.

## 2. Goal 체인과 의존

| 순서 | goal | 이슈 | 의존 | 병렬 |
|---|---|---|---|---|
| 1 | MOMO-406 install/upgrade + 5분 설치 문서 | #425 | — | 407과 병렬 |
| 2 | MOMO-407 초대 보안 계약(만료 기본·role 바인딩·regenerate) | #426 | — | 406과 병렬 |

머지 순서: 406 → 407 (구현 병렬, 머지 순차 — oort 규칙).

## 3. 파일 맵 (기획 시점 @ 51ff19d)

| 대상 | 위치 | 지금 상태 | 해야 할 변경 |
|---|---|---|---|
| install/upgrade | `infra/prod/` | **없음** — ADR-0002 §install/upgrade 레이어 예약만 | `install.sh`/`upgrade.sh` 신설 (406) |
| preflight | `scripts/prod_env_preflight.sh` | strict 모드 완비(APP_DOMAIN·allowed_origins 파생 검사 포함) | **재사용** — install.sh가 호출. preflight 자체 수정 최소화 |
| prod compose | `infra/prod/docker-compose.prod.yml` | 8서비스+notifier 제외(주: notifier는 e2e 프로파일만 — prod 편입은 P-3 시점) | 무수정 원칙 — install이 소비만 |
| 배포 문서 | `docs/DEPLOY.md` | 수동 런북(§4.4 APP_DOMAIN, §11 확장 레버) | "5분 설치" 절 추가 (406) |
| 초대 서버 | `server/Sources/MomoServer/Routes/InviteRoutes.swift` + `JoinRoutes.swift` | 발급/redeem/revoke + 공개 join. 만료는 명시 지정만, regenerate 없음 | 기본 만료·role 검증 강화·regenerate (407) |
| 초대 스키마 | `server/Migrations/003_onboarding.sql` — `invite_code`(max_uses/expires_at/revoked_at/role/`invite_code_expires_ck`) | 완비 | 원칙 무변경 — 신규 migration은 필요 시만(407, 근거 기록) |
| join verifier | `scripts/verify_join.sh` | 기존 왕복 검증 | 확장 또는 신규 (407) |
| 게이트 | `scripts/local_gate.sh`, `docs/LOCAL_PR_GATE.md` | staging-smoke/runtime-db 프로파일 | 각 goal이 자기 검증 등록 |

## 4. 지켜야 할 계약

- **406**: 시크릿 값 echo 금지(SOPS 경계 — `docs/DEPLOY.md` §시크릿). 실 VPS/실 도메인 불요 — 정적 검증(compose config 렌더·인자 매트릭스)으로 계약을 증명한다. APP_DOMAIN sentinel(MOMO-390)·allowed_origins 파생(MOMO-398)·pinned digest(ADR-0002) 무회귀. relay 등록은 자리(주석)만 — 오프그리드 설치가 1급(ADR-0121 D4).
- **407**: `docs/api/openapi.yaml` 응답 shape 불변(closed-world drift 게이트가 감시 — 새 필드를 응답에 추가하면 게이트 FAIL). 단일 쓰기 경로·RLS·audit 관례(같은 트랜잭션). owner role 초대 생성 fail-closed. 기존 초대 명시-만료 경로 무회귀. Zulip CVE-2022-21706 교훈(초대의 워크스페이스·역할 바인딩)이 이 티켓의 존재 이유 — `research/15-platform-expansion/02` §2-5 참조.
- 공통: worker는 **PR 생성 후 정지, merge/close 금지**. docker 필요한 게이트는 오케스트레이터가 실행(worker 샌드박스에 docker 없음 — evidence 없는 체크박스 금지, "게이트는 오케스트레이터 수행 예정"으로 기록). `clients/**` 무변경.

## 5. 알려진 함정 / 컨텍스트

- `invite_code_expires_ck` 제약: `expires_at > created_at` — 기본 만료 계산 시 위반 불가 조건 확인(MOMO-401 verifier가 백데이트 시 created_at 동반 이동한 전례).
- InviteRoutes의 기존 시그니처/DTO를 바꾸면 macOS 클라(OnboardingInviteFlow)와 웹 스펙이 흔들린다 — **요청 필드 추가는 optional만**, 응답 shape 불변.
- upgrade.sh의 migration은 전방 전용 — 롤백은 앱 이미지 태그만 되돌린다(ADR-0002 계약). 이 비대칭을 문서에 명시.
- prod compose에는 notifier 서비스가 없다(의도 — P-3 시점 편입). install.sh가 존재하지 않는 서비스를 참조하지 않게.
- e2e/스모크의 staggered boot 전례(Docker VM 메모리 압박)는 406 정적 검증에는 무관하나, 407 verifier는 runtime-db 프로파일이라 오케스트레이터가 실행 시 참고.

## 6. 검증

- 406: `bash -n`+shellcheck, 인자/롤백 경로 정적 매트릭스, compose config 렌더 무회귀, `staging-smoke` 프로파일(오케스트레이터 실행).
- 407: 확장 verifier — 기본 만료 적용(응답 expiresAt 확인)·owner 초대 거부·role 바인딩·regenerate 왕복(구 코드 즉시 무효+audit)·기존 verify_join 무회귀. `runtime-db`(오케스트레이터 실행).
- 수용기준 정본: `BUILD_TICKETS.md` `### MOMO-406/407 수용기준`.

## 7. 이탈 보고 의무 · 8. 착수 절차

worker: `scripts/goal_claim.sh <issue>`로 claim된 worktree에서 구현 → 로컬 가능 검증(bash -n/swift build·test) → 커밋 → **push 후 PR 생성(needs-review) → 정지**. 이탈은 PR `## 계획 이탈` 섹션.

## 9. 컨텍스트 델타

- 새로 고정: install/upgrade의 정적 검증 우선 원칙(실 VPS 없이 계약 증명), 초대 기본 만료 7일(D3), regenerate=원자 revoke+재발급.
- 의도적으로 결정하지 않은 것: 마켓플레이스 이미지(D1-B), relay 등록 구현(S-5), 초대 이메일 발송.
- 재기획 질문: install.sh의 대상 OS 매트릭스(v1은 Ubuntu LTS 단일 가정 허용), upgrade 무중단 수준(v1은 짧은 중단 허용).
