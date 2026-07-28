# goal #886 — MOMO-665: 마이그레이션 049 fail-closed 탈출구 (ADR-0140 이행 1, 선행)

너는 momo 레포의 Codex worker다. 이 문서가 네 유일한 지시서다. 계약은 `AGENTS.md`.
**base = `track/engine`**(main 동기화 완료분 포함). 모델: gpt-5.6-sol medium.

## 0. 착수 전 필수

1. `git status` clean. 2. 자격증명·`.env` 탐색 금지. 3. **PR 후 STOP**(merge/close 금지). 4. docker 게이트는 오케스트레이터. 5. 심볼은 쓰기 전 grep으로 실재 확인. 6. UUID 텍스트 비교는 `lower()` 정규화.

## 1. 문제 (검증 완료 — 다시 확인하고 써라)

`049_t3_lifecycle_settlement.sql:47-69`의 DO 블록이 중복 미정산 usage를 발견하면 예외를 던지는데, 이게 **`CREATE FUNCTION settle_t3_work_session` (79행)보다 먼저** 실행된다. `migrate.sh`는 파일 단위 single transaction이므로 **함수 생성까지 함께 rollback**된다.

오류 메시지는 운영자에게 "host를 reconcile하라"고 하지만 **레포에 그 정산을 수행할 도구도 런북도 없다.** production API/relay/worker는 migrate 성공에 의존하므로, 실제 중복이 있는 설치는 **새 서비스가 전부 기동하지 않는다.**

**fail-closed 판단 자체는 옳다** — 과금 증거를 임의로 폐기하지 않는다. 문제는 **막기만 하고 나가는 문을 안 만든 것**이다.

## 2. 할 일 — 3단 분리

`scripts/migrate.sh`는 `schema_migrations`에 **전체 파일명**으로 적용 이력을 추적한다(러너 주석 §멱등성). 따라서 **이미 049를 성공 적용한 DB는 049를 다시 실행하지 않는다** — 아래 재구성이 기존 dev DB를 깨지 않는 근거다. 신규 설치는 049→050→051을 순서대로 받아 **같은 최종 상태**에 도달한다.

1. **049 축소** — DO 블록(47-69)과 `work_host_usage_one_unsettled_per_host_idx`(71-73)를 **제거**하고 primitive(`settle_t3_work_session`)만 남긴다. ALTER/컬럼/`create_idempotency` 인덱스는 그대로.
2. **050 신설 — 운영자 repair** — 중복 미정산 usage를 가진 각 세션을 **원자적으로 정산**하는 진입점. **정산 로직을 복제하지 마라** — 049의 `settle_t3_work_session`을 호출한다(ADR-0140 D3 "정산 단일 문"의 선취). 어느 host·몇 건인지 진단 출력 유지.
3. **051 신설 — 제약 강제** — 049에서 뺀 fail-closed 검사 + unique index. 검사는 위반 host를 전부 이름으로 제시한다(기존 메시지 품질 유지). **이미 인덱스가 있는 DB에서도 성공해야 한다**(`IF NOT EXISTS` 등 멱등).
4. **런북** — `docs/runbooks/` 아래(없으면 신설). 실패 메시지 → repair 실행 → 재적용 → 기동 확인까지 **복붙 가능한 명령**으로. 오류 메시지가 런북 경로를 가리키게 하라.

## 3. 함께 고쳐야 하는 정적 단정 (안 고치면 빨개진다)

인덱스가 049 → 051로 이동하므로 **049 내용을 grep하는 두 곳**을 함께 갱신한다:

- `server/Tests/MomoServerTests/CloudProvisionerTests.swift:109,113`
- `scripts/verify_t3_provisioner.sh:32,43`

**주의**: 이 둘은 "파일에 문자열이 있는지"만 보는 정적 grep이라 **행동을 증명하지 않는다.** 경로만 맞춰 두고, **이런 형태의 단정을 새로 추가하지 마라.** 네 red proof는 §5의 행동 증명이다.

## 4. 하지 말 것

- ADR-0140의 나머지(advisory 직렬화·사다리 정렬·`t3_terminate`·전이표)는 **#890/#891/#892**다. 이 티켓은 **탈출구만** 만든다.
- `schema_v0.sql` 수정·이동 금지. 049의 primitive 본문 로직 변경 금지(옮기는 것 외).
- pause 미계상의 GENERATED 보장(045:66-72)에 손대지 마라 — 세 라운드 내내 안 깨진 자리다.

## 5. 검증 (수용 기준)

- **복구 시나리오 실주행**: 중복 미정산 usage 픽스처를 심은 DB에서 ① migrate가 **051에서 이름 있는 실패**(위반 host 명시) ② repair 실행 ③ 재적용 성공 ④ **서비스가 실제로 기동**. 이 4단계가 한 스크립트로 재현돼야 한다.
- **red proof**: repair를 건너뛰고 재적용하면 **같은 이름 있는 실패**로 막힌다. 행·타임아웃 형태의 실패는 수용하지 않는다.
- **멱등**: 러너의 2-pass 검사(`IDEMPOTENCY_OK second-pass applied=0`)가 성공해야 한다. 049를 이미 적용한 DB에서도 051이 성공하는 것을 별도로 보여라.
- `swift build` · 서버 테스트 무회귀(현재 349) · `scripts/check_migration_numbers.sh` 통과.
- 기존 T3 검증기 정적 통과.

## 6. PR

`feat/886-migration-repair` → `track/engine`. 본문에: 3단 분리의 파일별 책임, 기존 dev DB 안전성 근거(schema_migrations 파일명 추적), 정적 단정 갱신 목록, 오케스트레이터가 돌릴 것, 계획 이탈. **PR 후 STOP.**
