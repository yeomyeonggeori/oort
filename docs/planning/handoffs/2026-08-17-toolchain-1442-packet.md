# toolchain 핸드오프 패킷 — Rust 고정 지점 전수 조사·MSRV 정합 (#1442)

> 2026-08-17 Fable 발급 · Status: `ready` · 워커: 단발 무명 Opus 5.
> planning ID: **PLN-20260815-01** (owner: Fable · integrator: momo-main) · supersedes: 없음
> 정본 goal: GitHub Issue **#1442**(status:ready — metadata-only binding). 수용기준 정본 = 본 패킷 §4.
> 근거: ADR 불요(빌드 정합 위생 — 스택 변경 아님. 리서치 정본 `docs/planning/research/2026-08-16-cursor-ade-web-ux-benchmark.md` §5 부수 실측).
> 병렬: #1441·#1454와 파일군 분리(메타데이터/CI/문서 vs 소스). **머지 순서는 #1454 뒤** — 툴체인/MSRV 변경이 clippy 결과를 바꿀 수 있어 비행 중 PR의 게이트 기준을 흔들지 않기 위함.
> 기준 커밋: **`track/engine@54f5d2dc`**.

## 1. 미션 요약 + 발급 시점 실측 (중요 — 이슈 본문과 코드 실상이 다르다)

커서 클라우드 에이전트가 우리 레포 빌드에 "고정 1.83이 edition2024 미지원이라 stable 1.97.1 범프가 필요했다"고 실측 보고했다(리서치 §5). **그러나 기준 커밋 실측: 레포에는 rust-toolchain.toml이 없다**(`.github/workflows/pr-ci.yml:285-287` 주석이 명시 — "레포에 rust-toolchain.toml이 없어… MSRV는 server-rust/Cargo.toml의 rust-version=1.80"). 워크스페이스 `edition = "2021"`·`rust-version = "1.80"`(`server-rust/Cargo.toml:9,12`), 서버 Dockerfile은 `ARG RUST_IMAGE=rust:1-slim-bookworm`(부동 최신)이다.

즉 커서의 "고정 1.83"은 레포 핀이 아니라 **커서 환경의 기본 툴체인**이었고, 진짜 부정합은 **선언 MSRV 1.80 ↔ 의존성 그래프의 실제 요구**(edition2024 크레이트는 rustc ≥1.85)일 가능성이 높다. 이 goal은:
1. **고정/선언 지점 전수 조사 표**: rust-toolchain(부재 확인)·Cargo.toml rust-version·CI(pr-ci.yml rust 잡·release-desktop.yml)·Dockerfile 전부(`server-rust/Dockerfile`·`infra/prod/docker/*.Dockerfile`·`adapters/prime/container/Dockerfile`·`infra/cubesandbox/display-template/Dockerfile`)·런북/AGENTS.md 문서 언급 — 각각 "무엇을 어떤 값으로 고정/가정하는가".
2. **실제 최소 요구 실측**: 의존성 그래프에서 요구 rustc 최솟값을 실측(`cargo metadata` 스캔 또는 MSRV 툴체인 설치 후 `cargo +<MSRV> check` — 안 되면 그 자체가 증거).
3. **정합 갱신**: 실측 최소치에 맞춰 `rust-version` 정직 갱신(+필요하다고 판단되면 rust-toolchain.toml 신설 — 신설 시 CI 주석 :285의 "없다" 전제와 AGENTS.md도 같이 갱신, 아니면 신설하지 않은 이유를 PR에 1문단). 부동 이미지(`rust:1-slim-bookworm`)는 재현성 관점 평가만 하고 **고정 전환은 이 goal에서 하지 않는다**(운영 변경 — 발견 사항으로 보고만).

## 2. 필독 코드 좌표

- `.github/workflows/pr-ci.yml:270-300`(rust 잡·MSRV 주석) · `release-desktop.yml:95` 근방(cargo PATH).
- `server-rust/Cargo.toml:9-12`(edition·rust-version — 전 크레이트가 workspace 상속).
- `server-rust/Dockerfile:51`(RUST_IMAGE) + §1의 Dockerfile 목록 전부(rust를 안 쓰는 것은 표에 "해당 없음"으로 — 침묵 대신 정직 기재).
- `AGENTS.md:86`(로컬 툴체인 서술) · `docs/runbooks/` 내 rust/cargo 언급 grep.
- 리서치 정본 §5(커서 실측 원문).

## 3. 지켜야 할 계약

- **edition 마이그레이션 금지**(이슈 Out of scope — edition은 2021 유지, 빌드 정합만).
- 소스 코드(`server-rust/**/*.rs`) 비접촉 — MSRV 범프로 새 clippy lint가 떠서 소스 수정이 필요해지면 **정지+이탈 보고**(#1454가 같은 소스에 비행 중).
- 프로덕션 이미지 태그/배포 산출물 변경 금지(momo-rust:68fc52ff 라이브 — 이 goal은 빌드 메타데이터·문서·CI만).
- 시크릿 비유입·schema 비접촉.

## 4. 수용기준 (정본)

1. 고정/선언 지점 전수 조사 표가 PR 본문에 있고(파일:줄 + 현재 값 + 갱신 값/해당 없음), 실측 최소 요구 근거 포함.
2. `rust-version` 및 관련 문서·CI 주석이 실측과 정합(거짓 MSRV 해소). rust-toolchain.toml 신설/비신설 결정 1문단.
3. 전 게이트 그린(`scripts/local_gate.sh --profile swift` + `cargo clippy` + CI 통과 확인).

## 5. 알려진 함정 / 컨텍스트

- MSRV를 올리면 clippy가 새 lint를 켤 수 있다 — §3 계약대로 소스 수정 유발 시 정지(멋대로 `#[allow]` 살포 금지).
- pr-ci.yml rust 잡은 paths filter(:74) 뒤에 있다 — 메타데이터만 바꿔도 rust 잡이 도는지 확인(안 돌면 게이트 증거로 로컬 실행 결과 첨부).
- `rust:1-slim-bookworm`은 이미지 pull 시점 최신 1.x — "고정"이 아니라 부동임을 표에 정직 기재.
- 공통 함정 템플릿 §5.1 전항 적용.

## 6. 검증

- `scripts/local_gate.sh --profile swift` + `cargo clippy --workspace` + (가능하면) MSRV 툴체인 check 실측 로그.

## 7. 이탈 보고 의무

계약과 다르게 가야 하면 PR `## 계획 이탈` 기록, 판단 필요 시 `scripts/goal_release.sh 1442 --blocked "<사유>"` 정지. 임의 재설계 금지.

## 8. 착수 절차

```bash
scripts/goal_status.sh
scripts/goal_claim.sh 1442
# 조사 표 → 갱신 → 게이트 → PR(## 계획 이탈 포함) →
scripts/goal_release.sh 1442 --review --pr <PR URL>
# 정지. merge/close는 momo-main 몫.
```

## 9. 컨텍스트 델타

- 새로 고정: "고정 1.83"의 실체=커서 환경 기본값(레포 핀 부재 실측). 진짜 결함 후보=선언 MSRV 1.80의 과소 선언.
- 의도적 미결정: rust-toolchain.toml 신설 여부(워커 판단+1문단) · 부동 베이스 이미지 고정(보고만 — 운영 결정은 성재 큐).
- 재기획 트리거: MSRV 범프가 소스 수정을 요구하면 #1454 랜딩 후 후속 티켓.
