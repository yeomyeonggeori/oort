# goal B4 — 클라 재배선: 클라이언트 관점 계약 diff + 서버측 파리티 마감 (도그푸딩 1차 트리거)

너는 momo 레포의 구현 worker다(Claude Opus 5). 이 문서가 유일한 지시서. 계약 `AGENTS.md`.
**base = `track/engine`**(B1.2 랜딩 `b401f693` 이후). 워크트리 `~/projects/momo-tracks/momo-worktrees/B4-rewire`(브랜치 `feat/B4-rewire`, 생성됨).

## 0. 규율 + 트랙 경계 (중요)
1. `.env` 열람 금지. 2. **PR 후 STOP**, amend/force-push 금지. 3. docker 검증 금지(`#[ignore]` 작성만). 4. **UXUI 트랙 소유 파일(clients/macOS·iOS·웹 UI 컴포넌트) 수정 금지** — UI 수정 필요분은 `docs/planning/ENGINE_HANDOFF.md`에 항목으로 기록만. 엔진 소유(clients/Core·서버)는 수정 가능. 5. **원칙: 갭은 서버를 고쳐 닫는다**(Swift 계약이 정답 — 클라가 이미 쓰는 형태에 Rust를 맞춤). 6. route raw SQL 0 등 기존 구조 규율 유지. 새 마이그레이션 금지.

## 1. 목표
클라이언트(웹 SPA·Tauri/React·clients/Core)가 **실제로 호출하는 API 표면 전수 실측** → Rust 서버와 diff → **서버측에서 닫을 수 있는 갭 전부 마감** → 남는 것(미구현 표면·UI 수정 필요)을 분류 보고. 이것이 내부 도그푸딩 1차의 게이트 문서가 된다.

## 2. 할 일
- **클라 소비 표면 전수 실측**: 웹/Tauri 코드에서 API 호출(fetch/클라이언트 SDK) 전수 추출 — 경로·메서드·요청/응답 필드·인증 방식·Centrifugo 구독 계약(토큰 발급 경로 포함). clients/Core의 계약 타입도.
- **diff 매트릭스**: 각 호출 ↔ Rust 서버 현황(`동일` / `서버측 마감 가능` / `미구현 표면(배치 필요)` / `UI 수정 필요`). 산출물: `docs/planning/2026-08-01-b4-contract-diff.md`.
- **서버측 마감**: `서버측 마감 가능` 분류 전부 구현 — 예상 후보(실측으로 확정): Centrifugo 구독 토큰 발급(`/v1/centrifugo/…` — B1.7 compose가 proxy secret만 걸어둔 그 표면), 클라가 쓰는 필드 누락분, 응답 형태 미세 차이. 
- **conformance `#[ignore]`**: 클라가 부팅~채널 진입~메시지 왕복에 실제로 밟는 호출 시퀀스를 그대로 재생하는 smoke 1개(diff 매트릭스에서 유도).

## 3. 하지 말 것
UI 코드 수정(UXUI 몫 — ENGINE_HANDOFF 기록)·huddle/attachment·T3 표면 확장·새 마이그레이션.

## 4. 검증·PR
cargo check/test/fmt/clippy·구조 grep. PR `feat/B4-rewire` → `track/engine`. 본문: diff 매트릭스 요약(분류별 수)·서버측 마감 목록·ENGINE_HANDOFF 기록분·도그푸딩 차단 잔여(있으면)·오케스트레이터 목록·이탈. **PR 후 STOP.**
