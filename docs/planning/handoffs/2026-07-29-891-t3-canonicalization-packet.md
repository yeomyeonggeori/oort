# goal #891 — MOMO-667 [T-3 정본화]: t3_terminate 단일 문 + 전이표 트리거 + 사다리 A 정렬

너는 momo 레포의 Codex worker다. 이 문서가 네 유일한 지시서다. 계약은 `AGENTS.md`.
**base = `track/engine`**(#890 랜딩분 포함 — `82284d14`). 모델: gpt-5.6-sol medium.
근거 정본: `docs/adr/0140-t3-lifecycle-redesign.md` D1·D2·D3, 이행 3.

## 0. 착수 전 필수

1. `git status` clean. 2. 자격증명·`.env` 탐색 금지. 3. **PR 후 STOP**(merge/close 금지). 4. docker 게이트는 오케스트레이터. 5. 심볼은 쓰기 전 grep으로 실재 확인. 6. UUID 텍스트 비교는 `lower()` 정규화. 7. **픽스처 SQL의 `INSERT ... SELECT` 리터럴은 명시 캐스트**(`::uuid`·enum) — SELECT 분기는 대상 컬럼 타입으로 강제되지 않는다(#890에서 오케스트레이터가 고친 실측 결함).

## 1. 전제 (T-2가 이미 세운 것 — 깨지 마라)

- 호스트 단위 advisory 직렬화: `acquire_t3_lifecycle_lock(uuid)`(052) — 모든 T3 수명주기 트랜잭션의 첫 문장. REST는 `withTenantT3LifecycleTransaction`(`Database.swift:124`) 경유.
- sweep은 세션 단위 트랜잭션으로 분할됨.
- 동시성 하니스 `scripts/verify_t3_lifecycle_concurrency.sh` — `pg_locks` 동시성 단정 + red proof(40P01).
- **advisory가 교착을 이미 막고 있다.** 이 티켓의 잠금 순서 정렬은 그 안전망 위의 정본화다.

## 2. 할 일

### 2-1. 정산 단일 문 (ADR-0140 D3)

새 마이그레이션(다음 번호)에서:

- `t3_terminate(p_workspace_id uuid, p_session_id uuid, p_reason text) RETURNS boolean` — 기존 `settle_t3_work_session`의 본문을 **흡수·대체**한다(전 경로 이행 후 기존 함수는 `t3_terminate` 호출 shim으로 두거나 제거 — 판단·근거를 커밋에).
  - `p_reason IN ('ended','idle_timeout','orphaned','provider_missing','destroyed')` CHECK.
  - 수행 내용은 049와 동일(interval 마감 → usage 정산 → 차감 append 멱등 → cloud slot 해제 → host revoke → destroy intent) + **`reason`을 usage 행에 기록**(`settled_reason` 컬럼 신설).
  - **멱등 유지**: 동시 2회·순차 2회 호출에도 `credit_entry` 1행. 이미 정산된 세션에 다른 reason으로 불러도 **기존 기록을 덮지 않고** true 반환.
- **트리거 봉인**: `work_host_usage` BEFORE UPDATE 트리거 — `settled_at`이 NULL→NOT NULL로 바뀌는 UPDATE는 `current_setting('momo.t3_settlement', true) = 'on'`일 때만 허용, 아니면 **이름 있는 예외**(`t3 settlement must go through t3_terminate`). `t3_terminate`가 `SET LOCAL momo.t3_settlement = on`을 세운다.
- 기존 호출자 4곳을 전부 대체: `CloudUsageLedger.swift:274`(settle) · `CloudLifecycleReconciler.swift`(provider_missing) · `TierFallbackSweep.swift` 2곳(idle_timeout / orphaned). 050의 repair 함수도 `t3_terminate(reason:='destroyed')` 위임으로 갱신.
- **계보 재개 경로**(`WorkSessionRoutes.swift` resume, 원본 세션을 `ended(resumed)`로 닫는 곳)에도 `t3_terminate` 호출을 추가하라 — 멱등이므로 sweep이 이미 정산한 경우에도 안전하다. 이것이 "적히지 않은 불변식"(sweep 선정산 의존)을 사실로 바꾼다.

### 2-2. 상태 전이표 (ADR-0140 D1)

같은 마이그레이션에서:

- `work_cloud_host_transition(from_state text, to_state text, kind text, PRIMARY KEY(from_state,to_state))` 테이블 + 시드. 현행 9상태(049:18-23)의 **실재 전이를 코드에서 역산해 시드하라** — 발명하지 말고 REST/reconciler/sweep이 실제로 수행하는 전이만.
- `work_cloud_host` BEFORE UPDATE 트리거: `OLD.state IS DISTINCT FROM NEW.state`일 때 전이표에 없으면 **이름 있는 예외**(`illegal cloud host transition <from> -> <to>`).
- 같은 상태로의 UPDATE(메타데이터만 갱신)는 통과.

### 2-3. 사다리 A 정렬 (ADR-0140 D2)

정본 순서: `advisory(이미 T-2) → work_pool/workspace_credit → work_cloud_host → work_host_usage(+interval) → work_session → work_host`

- **0~2단은 단일 진입 함수가 소유**: `withTenantT3LifecycleTransaction`을 확장해 advisory 획득 직후 **필요 시** `work_cloud_host` 행을 `FOR UPDATE`로 잡는 옵션을 제공하거나, SQL 프렐류드 함수로 묶어라 — 정렬 지점이 **한 곳**이어야 다음 경로가 베낄 모양이 하나다. 설계는 네가 정하되 근거를 커밋에.
- **REST 종료**(`WorkSessionRoutes.swift:390` 부근): 현재 세션을 먼저 `FOR UPDATE OF ws` — T3 세션이면 prelude(위) 뒤로 옮기고 세션 잠금 후 상태 재확인. **T1/T2 세션은 현행 그대로**(cloud host 행이 없다).
- **reconciler**: 이미 cloud host 먼저 — 사다리와 일치. usage/session 잠금이 사다리 순서인지 확인만.
- **워크스페이스 축**: `CloudUsageLedger.reserveProvisioningSlot`(`:31,45`)이 `work_pool`→`workspace_credit`을 먼저 잠그는 것은 **사다리 1단이므로 그대로 두되**, 정산 트리거(`apply_credit_entry`, 045:122-129)가 같은 `workspace_credit` 행을 마지막에 잠그는 **역방향**이 남는다. `t3_terminate` 안에서 credit append **전에** `workspace_credit` 행을 사다리 순서로 선잠금하는 방식으로 방향을 통일하라(또는 동등한 해법 — 근거를 커밋에).

### 2-4. 하니스 확장 (ADR-0140 D5)

`verify_t3_lifecycle_concurrency.sh`에 추가:

- **워크스페이스 축 시나리오**: 서로 다른 cloud host·같은 워크스페이스에서 프로비저닝(slot 예약)과 정산이 동시 — advisory가 덮지 못하는 유일한 축. `pg_locks` 동시성 단정 동일 적용.
- **봉인 단정**: `settled_at` 직접 UPDATE가 트리거 예외로 거부됨.
- **전이표 단정**: 시드에 없는 전이(`ready -> destroyed` 직행 등 실재 코드에 없는 것) 시도가 이름 있는 예외.
- **red proof 2종**: ① 한 경로의 잠금 순서 되돌림 → 40P01 ② 봉인 트리거 제거 → 직접 UPDATE가 통과해버려 단정 실패. 절차를 PR에 명시.

## 3. 하지 말 것

- provider 수렴 규칙·deadline·mock 정직성은 **#892**.
- `schema_v0.sql` 수정·이동 금지. **pause 미계상 GENERATED(045:66-72) 불변** — `active_seconds` 단위 변경(#879 흡수분)은 **이 티켓에서 하지 않는다**(수렴 뒤 별도, 스코프 억제).
- T1/T2 경로에 advisory·prelude 비용을 얹지 마라.

## 4. 수용 기준

- 하니스 전 시나리오 green(기존 2 + 신규 워크스페이스 축) + **red proof 2종이 이름 있는 실패**.
- `t3_terminate` 멱등 단정(동시 2회 → `credit_entry` 1행) + 봉인 단정 + 전이표 단정.
- 4개 기존 호출자 + 계보 재개 + repair가 전부 단일 문 경유 — `settle_t3_work_session` 직접 호출이 코드에 남지 않음(shim 제외)을 grep으로 보여라.
- **T1/T2 무회귀**: verify_work_session_idle · verify_work_session · verify_work_host 0 (오케스트레이터 실행).
- `swift build` · 서버 테스트 무회귀(349) · NotifierWorker 무회귀 · `check_migration_numbers.sh` · 기존 T3 검증기(provisioner·migration_repair) 무회귀.

## 5. PR

`feat/891-t3-canonicalization` → `track/engine`. 본문에: shim 판단, 전이표 시드의 역산 근거(경로별), prelude 설계, 워크스페이스 축 해법, red proof 절차, 오케스트레이터 실행 목록, 계획 이탈. **PR 후 STOP.**
