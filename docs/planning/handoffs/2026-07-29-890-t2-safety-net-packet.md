# goal #890 — MOMO-666 [T-2 안전망]: sweep 트랜잭션 분할 + 호스트 advisory 직렬화 + 동시성 하니스

너는 momo 레포의 Codex worker다. 이 문서가 네 유일한 지시서다. 계약은 `AGENTS.md`.
**base = `track/engine`**(#886 랜딩분 포함 — `18edb33c`). 모델: gpt-5.6-sol medium.
근거 정본: `docs/adr/0140-t3-lifecycle-redesign.md` D2·D5, 이행 2.

## 0. 착수 전 필수

1. `git status` clean. 2. 자격증명·`.env` 탐색 금지. 3. **PR 후 STOP**(merge/close 금지). 4. docker 게이트는 오케스트레이터. 5. 심볼은 쓰기 전 grep으로 실재 확인. 6. UUID 텍스트 비교는 `lower()` 정규화.

## 1. 문제 (실측 완료 — 다시 확인하고 써라)

**세 경로가 서로 다른 순서로 잠근다.**

| 경로 | 순서 |
|---|---|
| `CloudLifecycleReconciler.swift:139-172` | `work_cloud_host` → `work_host_usage`+`work_session` |
| REST 종료 `WorkSessionRoutes.swift:390` → `:457` | `work_session`(`FOR UPDATE OF ws`) → settle 안에서 usage → cloud host |
| `TierFallbackSweep.swift:233,312` | `work_session` → settle 안에서 usage → cloud host |

`settle_t3_work_session`(049)이 usage를 잠근 뒤 cloud host를 쓰므로, reconciler가 cloud host를 쥔 채 usage/session을 기다리고 REST/sweep은 session·usage를 쥔 채 cloud host를 기다린다 → **실제 PostgreSQL deadlock**.

**현행 게이트는 이 구간을 검증하지 못한다.** race 게이트가 provider 호출을 막은 뒤 REST를 *완전히 끝내고* 풀어주므로 **두 트랜잭션이 동시에 잠금을 쥐는 순간이 없다.** 3차 리뷰의 deadlock은 게이트 9종이 전부 green인 상태에서 나왔다 — **초록이 안전을 뜻하지 않는 자리다.**

## 2. 할 일

### 2-1. sweep 트랜잭션을 세션 단위로 분할

`TierFallbackSweep.swift:34`(`sweepTierFallback`)와 `:119`(`sweepIdleTimeouts`)가 **한 트랜잭션 안에서 여러 세션을 반복 처리**한다(`:93` `for session in sessions`). 후보 조회와 **세션별 처리 트랜잭션을 분리**하라.

- 한 세션의 실패가 배치 전체를 되감지 않아야 한다. 실패는 그 세션만 건너뛰고 **이름과 함께 로그**로 남긴다.
- 후보 조회 시점과 처리 시점 사이의 상태 변화를 **처리 트랜잭션 안에서 재확인**하라(이미 종료된 세션을 다시 처리하지 않는다).

### 2-2. 호스트 단위 advisory 직렬화 (ADR-0140 D2 C)

모든 T3 수명주기 트랜잭션의 **첫 문장**이 해당 cloud host에 대한 `pg_advisory_xact_lock`이다.

- 키는 네임스페이스를 포함한 2-int 형태(예: `pg_advisory_xact_lock(hashtext('momo.t3'), hashtext(lower(cloud_host_id::text))))`). **정확한 형태는 네가 정하되 근거를 커밋에 적어라.**
- 한 트랜잭션이 둘 이상의 cloud host를 만져야 하면 **host id 오름차순**으로 잡는다.
- **T1/T2 경로는 advisory를 잡지 않는다** — `work_cloud_host` 행이 없는 세션은 이 사다리에 들어오지 않는다. heartbeat(`work_host`)도 잡지 않는다(고빈도 경로에 비용을 얹지 마라).

### 2-3. 동시성 하니스 (ADR-0140 D5)

**두 개의 PG 연결**로 두 경로를 각각 잠금 획득 직후 정지시키고, **양쪽이 동시에 잠금을 보유·대기하는 상태를 `pg_locks`/`pg_stat_activity`로 단정**한 뒤 진행시킨다.

- **이 단정이 테스트 자체의 유효성 검사다.** 없으면 직렬 시나리오가 조용히 green을 낸다.
- 최소 시나리오: reconciler 경로 × REST 종료 경로, reconciler 경로 × sweep 경로.

## 3. 하지 말 것

- **잠금 순서 변경(사다리 A 정렬)은 #891이다.** 이 티켓은 **순서를 그대로 두고 직렬화만 세운다.**
- `t3_terminate` 신설·`settled_at` 트리거 봉인·상태 전이표는 #891.
- provider 수렴 규칙·deadline·mock 정직성은 #892.
- `schema_v0.sql` 수정·이동 금지. pause 미계상의 GENERATED 보장(045:66-72)에 손대지 마라.

## 4. 수용 기준

- 하니스가 **현행 잠금 순서 그대로에서** 교착 없음을 보인다(= advisory가 실제로 서 있다는 증명).
- **red proof**: advisory 획득을 제거하면 하니스가 **`deadlock detected`(SQLSTATE 40P01)** 라는 **이름 있는 실패**로 빨개진다. 행·타임아웃 형태의 실패는 수용하지 않는다. 되돌림 절차를 커밋/PR에 명시.
- **T1/T2 무회귀**: sweep 트랜잭션 경계를 바꾸므로 **필수**다. 무료 티어 종료·orphan·재개 경로의 기존 검증기가 변경 전후 동일하게 green임을 보여라.
- `swift build` · 서버 테스트 무회귀(현재 **349**) · NotifierWorker 테스트 무회귀 · 기존 검증기 9종 정적 통과.

## 5. PR

`feat/890-t2-safety-net` → `track/engine`. 본문에: advisory 키 설계 근거, sweep 분할이 바꾼 실패 격리 범위, 하니스가 "동시였음"을 어떻게 증명하는지, red proof 절차, 오케스트레이터가 돌릴 목록, 계획 이탈. **PR 후 STOP.**
