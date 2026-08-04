# 핸드오프 패킷 SRV-B7 — openapi 게이트 이중 샘플: 스펙-Rust 경로 실측 (#1042)

- status: **ready** · worker: Opus 5 (서버/게이트) · 기준: `origin/track/engine` 최신 · 새 워크트리 · PR base `track/engine`
- 발단: #1041(SRV-B6)의 이탈 3 — openapi 계약 게이트의 e2e 스택이 `swift:6.2`인데 스펙은 이제 Rust 배포본을 서술(#1040). 결정 ⓐ(스코프판)가 이슈 #1042에 고정돼 있다 — **이슈 본문이 결정 정본**.

## Goal — 게이트에 2차 샘플 패스(rust 부분집합 스택)

1. `scripts/verify_openapi_contract.sh`에 **스펙-Rust 샘플 패스** 추가: server-rust api + pg + centrifugo 부분집합 스택을 띄워(승인 계열 커버 가능한 최소 구성) 매니페스트에 오른 경로를 실제 왕복 샘플.
2. **sampled-on-rust 매니페스트(성장형)** 신설: 지금 확실히 Rust가 정본인 경로(승인 계열 우선)부터 등재. 이식 진행에 따라 Swift 패스를 잠식·최종 대체하는 구조로 — 매니페스트 파일에 그 취지 주석.
3. known-unsampled 계약 불변. #1040이 예고한 "승인 샘플 예상 빨강"이 이 패스로 해소되는지 확인이 완료 조건의 하나.

## 함정

- **repo 안에 rust 로컬 컴포즈가 없다**(`infra/` 실측 — e2e 컴포즈는 Swift 3서비스). 배포 컴포즈는 NCP 서버(`/opt/momo/infra/rust/`)에만 있다. 로컬 rust 스택은 ①server-rust 실DB 스위트가 이미 쓰는 부팅 패턴 재사용 또는 ②e2e 컴포즈에 rust 서비스 추가 중 **네가 실측해 싼 쪽을 고르되, 선택과 근거를 PR에 기록**. Dockerfile이 이미 있으면 재사용(배포 이미지 빌드 경로 실측).
- Docker 자원 회수: 스택은 런 종료 시 반드시 내리고(`down -v`), 고유 프로젝트명 사용(janitor 매칭 가능한 접두사).

## 계약

- 수정: `scripts/verify_*` · infra 컴포즈 · 매니페스트 신설. **server-rust 제품 로직 무변경** · 클라/core 금지 · 프로덕션 접촉 금지.
- 검증: ①게이트 전 경로 green **2연속** ②red proof — 매니페스트 경로 하나를 고의로 어긋내(로컬 임시 변경) 빨강 확인 후 원복 ③`cargo test --workspace` 무회귀 1회.
- PR "Closes #1042" · `## 계획 이탈` 절 · STOP. 턴 규율: 턴 ≤20분 · 마일스톤 SendMessage 보고 · 첫 보고 ≤30분.
