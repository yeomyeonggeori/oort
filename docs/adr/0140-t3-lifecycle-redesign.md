# ADR-0140: T3 수명주기 재설계 — 상태기계 정본·잠금 사다리·정산 단일 문

- Status: **Proposed** (2026-07-28, 기안 Fable, 이슈 #888 — 성재 승인 전 구현 티켓 발급 금지)
- 운영 상태: **T3는 기본 비활성**(`MOMO_T3_ENABLED=1` 명시 옵트인 없이 provisioning/register/pause/resume/destroy/topup이 503 — #887). 본 ADR이 Accepted 되고 이행이 끝나기 전에는 켜지 않는다. **T1/T2는 본 ADR의 영향을 받지 않는다.**
- 관련: ADR-0136(프로비저너·크레딧 원장), ADR-0139(idle·재부착·D4 pause 미계상), ADR-0125(D10 서버 바이트 비경유·D11 git 계보 재개), ADR-0004(provider 자격증명 비유입)
- **대체하지 않는다**: ADR-0136·0139의 **결정 자체는 유효**하다. 본 ADR이 바꾸는 것은 그 결정을 구현한 **구조**다.
- 발단: 성재 결정(2026-07-28) — "B → C". T3를 잠근 뒤 재설계.

## Context

### 왜 패치가 아니라 재설계인가

adversarial-review가 세 라운드 돌면서 결함의 **성격이 같았다**.

| 라운드 | 나온 결함 | 처방 |
|---|---|---|
| 1차 | 종료·orphan 경로 미정산 · pause 순환 의존 · provider 호출과 DB 전이 경합 | durable intent 도입 |
| 2차 | resume intent 영구 교착 · reconciler가 CAS 전에 종속 상태 변경 | intent 재검증 + CAS |
| 3차 | 세 경로의 **잠금 순서 역전 → 실제 PG deadlock** · 049 fail-closed 탈출구 없음 | 전역 잠금 순서 |

세 번 다 **"외부 provider 호출과 DB 상태 전이를 어떻게 원자적으로 묶느냐"** 한 문제의 다른 얼굴이다. 패치가 새 경로를 만들고, 새 경로가 기존 경로와 순서·의미에서 어긋나고, 다음 라운드가 그 어긋남을 잡는다. 6 → 3 → 3건으로 수렴하지 않았다.

### 지금 코드가 실제로 이렇다 (실측)

**① 잠금 순서가 경로마다 다르다.**

| 경로 | 순서 |
|---|---|
| `CloudLifecycleReconciler.swift:139-172` | `work_cloud_host` → `work_host_usage`+`work_session` |
| REST 종료 `WorkSessionRoutes.swift:436-457` | `work_session` → (settle 안에서) `work_host_usage` → `work_cloud_host` |
| `TierFallbackSweep.swift:233,312` | `work_session` → (settle 안에서) `work_host_usage` → `work_cloud_host` |

`settle_t3_work_session`(049:91-96 → 136)이 usage를 잠근 뒤 cloud host를 쓰므로, reconciler가 cloud host를 쥔 채 usage/session을 기다리고 REST/sweep은 session·usage를 쥔 채 cloud host를 기다린다. **교착이 성립한다.**

**② 정산 시점의 정본이 없다.** `settle_t3_work_session` 호출자는 4곳인데 각자 **다른 세션 상태**에 묶여 있다 — REST는 `ended`, sweep은 `ended(idle_timeout)`와 **`orphaned`**, reconciler는 provider가 샌드박스 부재를 답할 때. 계보 재개(`WorkSessionRoutes.swift:1435-1443`)는 원본 세션을 `ended(resumed)`로 닫으면서 **정산하지 않는데**, 이게 성립하는 이유는 오직 그 전이가 `status = 'orphaned'`만 대상으로 하고 sweep이 orphan 시점에 이미 정산했기 때문이다 — **어디에도 적히지 않은 불변식에 의존한다.** 정산이 "과금 종료"가 아니라 "이 상태 전이의 부수효과"로 흩어져 있다.

**③ 초록이 안전을 뜻하지 않는다.** 현행 race 게이트는 provider 호출을 막은 뒤 REST를 **완전히 끝내고** 풀어준다 — 두 트랜잭션이 동시에 DB 잠금을 쥐는 순간이 없다. 3차 리뷰의 deadlock은 게이트 9종이 전부 green인 상태에서 나왔다.

### 세 라운드 내내 깨지지 않은 것 (재설계에서 보존)

- **pause 0 계상이 GENERATED 컬럼으로 구조적 보장**(045:66-72) — 정산 코드의 뺄셈에 의존하지 않는다. 코드 결함이 과금을 틀리게 만들 수 없는 유일한 자리였다.
- `work_host_usage_interval_one_open_idx`(045:79-81), `work_host_usage_one_unsettled_per_host_idx`(049:71-73) — 부분 unique 인덱스로 강제한 것들.
- 서명 v2(#875) · ADR-0004 자격증명 비유입 · 자동 T3 전환 금지 · D10 서버 PTY 바이트 비경유.

**패턴: DB 제약으로 강제한 규칙은 살아남았고, 코드 규약으로 둔 규칙은 매 라운드 깨졌다.** 아래 결정은 이 관찰을 설계 원리로 삼는다.

## Decision (Proposed 권고안)

### D1. 상태기계 정본 — 전이표를 한 곳에 두고 DB가 강제한다

- **A (권고)**: `work_cloud_host.state`의 **허용 전이 집합을 테이블 데이터로** 정의(`work_cloud_host_transition(from_state, to_state, kind)`)하고, `work_cloud_host` BEFORE UPDATE 트리거가 `OLD.state → NEW.state`를 그 테이블에 대조해 없는 전이를 거부한다. REST·sweep·reconciler는 전이를 **선언**만 하고 합법성 판정은 하지 않는다.
  - 현행 9개 상태(`provisioning · ready · running · pausing · paused · resuming · destroy_pending · destroyed · failed`, 049:18-23)는 유지한다. 문제는 상태값이 아니라 **누가 전이를 아느냐**였다.
  - 세션·interval 상태는 cloud host에 종속시키지 않는다. `work_session.status`는 ADR-0139 D1의 4값 그대로이고, T3는 거기에 **과금 축**을 더할 뿐이다.
- B — Swift 쪽 단일 `CloudHostStateMachine` 타입: 서버·NotifierWorker **두 프로세스**가 각자 컴파일한 사본을 갖고, 배포 시차 동안 서로 다른 전이표로 같은 행을 쓴다. **기각.**
- C — 현행 유지(각 경로가 `WHERE state = ...` 조건으로 자기 전이만 안다): 새 경로가 생길 때마다 전이표가 늘어나고 아무도 전체를 못 본다. 3라운드가 그 결과다. **기각.**

### D2. 경합 직렬화 — **성재 판단 대기(선택지 3개)**

교착은 이미 성립한다(Context ①). 남은 질문은 "무엇으로 없애느냐"이고, 그 선택이 **어느 코드를 건드리느냐**를 결정한다.

**실측 전제**(초안의 비용 추정을 코드로 재확인해 정정한다):

- 현행 REST 종료는 `WorkSessionRoutes.swift:390` `FOR UPDATE OF ws`로 **세션을 가장 먼저** 잠근다.
- 현행 reconciler는 **이미 cloud host를 가장 먼저** 잠근다(`CloudLifecycleReconciler.swift:139`).
- sweep은 `TierFallbackSweep.swift:34,119`에서 **한 트랜잭션이 여러 세션을 배치로** 처리한다 — 그래서 #885의 "배치 전체 rollback"이 나온다.

→ 따라서 **cloud-host 우선 순서는 reconciler가 아니라 REST·sweep을 고치는 선택**이다. 초안이 반대로 적었다.

| | 무엇을 고치나 | T1/T2 공유 코드 영향 | 남는 위험 |
|---|---|---|---|
| **A. `cloud_host → usage → session → host`** | REST 종료 · sweep (**2경로**) | **있음** — 두 경로 모두 T1/T2 세션이 지나간다 | 세션 출발 경로마다 "무잠금 조회 → cloud host 잠금 → 세션 잠금 → 재확인" 춤 |
| **B. `session → usage → cloud_host → host`** | reconciler (**1경로**) | **없음** — 변경이 T3 전용 워커에 갇힌다 | provider 출발 경로마다 같은 춤이 생김(다만 그런 경로는 드물다) |
| **C. cloud host 단위 advisory 직렬화 (권고)** | `t3_terminate` 내부 + sweep 트랜잭션 분할 | **sweep만** (배치 → 세션 단위) | advisory를 빠뜨린 경로 — **트리거로 보유 여부를 단정해 막는다** |

- **C (권고)**: 모든 T3 수명주기 트랜잭션이 **`pg_advisory_xact_lock('momo.t3', cloud_host_id)`를 첫 문장으로** 잡는다. 한 호스트에 T3 트랜잭션이 하나뿐이므로 **행 잠금 순서 논쟁 자체가 사라지고**, 각 경로는 지금 순서를 그대로 둔다.
  - 049의 `work_host_usage_one_unsettled_per_host_idx`가 이미 **호스트당 미정산 세션 1건**을 강제한다 — 즉 우리는 **논리적으로 이미 직렬인 것**을 직렬화할 뿐이라 동시성 손실이 없다.
  - 강제 수단은 D3와 같다: `t3_terminate`가 잠금을 잡고, 트리거가 `pg_locks`로 **보유 사실을 단정**한다. 규약이 아니라 실패다.
  - heartbeat(`work_host`)는 사다리에 참여하지 않으므로 advisory를 잡지 않는다 — 고빈도 경로에 비용 없음.
  - 전제: **sweep을 세션 단위 트랜잭션으로 분할**한다. 배치가 여러 호스트의 advisory를 잡으면 배치끼리 다시 순서 문제가 생긴다. 이 분할은 #885의 "한 세션 실패가 배치 전체를 되감는" 성질도 함께 없애는 독립 이득이다.
  - 잔여 규칙(문서화): 한 트랜잭션이 둘 이상의 cloud host를 만져야 하면 **host id 오름차순**으로 잡는다.
- **A**: "intent를 재검증한 뒤 종속 상태를 만진다"는 D4 규칙과 잠금 방향이 같아 provider 출발 경로가 가장 깔끔하다. 그러나 **T1/T2가 함께 지나는 REST 종료·sweep을 고쳐야 한다** — T3를 잠가둔 채 재설계하는 이번 국면에서 무료 티어에 회귀 위험을 옮기는 선택이다.
- **B**: 고칠 코드가 가장 적고 변경이 T3 전용 워커에 갇힌다. 잠금 획득은 쓰기가 아니므로 reconciler는 `session→usage`를 먼저 잠근 뒤 cloud host에서 intent를 재검증해도 **쓰기 전에 abort**할 수 있다(초안이 주장한 "정산 후 abort 폭풍"은 성립하지 않는다 — 정정). 대신 provider 출발 경로가 "무잠금 조회 → 세션 잠금 → 재확인"을 지게 된다.
- **규약을 코드가 강제하게 한다**(세 선택지 공통): 잠금은 각 경로가 직접 잡지 않고 **D3의 단일 진입 함수**가 잡는다. 주석에 순서를 적어두는 것으로는 다음 경로가 또 어긴다 — 3라운드가 증명했다.

### D3. 정산 단일 문 — "과금 종료"를 상태 전이에서 분리하고 트리거로 봉인한다

- **A (권고)**: 모든 T3 과금 종료는 `t3_terminate(workspace_id, session_id, reason)` **하나**를 지난다. 이 함수가 D2 사다리로 잠그고 → 열린 interval 마감 → usage 정산 → 차감 append(멱등) → cloud slot 해제 → host revoke → durable destroy intent → outbox 이벤트를 **한 트랜잭션에** 수행한다.
- **핵심: 규약이 아니라 강제.** `work_host_usage`에 BEFORE UPDATE 트리거를 걸어, `settled_at`을 NULL에서 값으로 바꾸는 UPDATE는 `t3_terminate`가 세운 트랜잭션 로컬 플래그(`SET LOCAL momo.t3_settlement = on`)가 있을 때만 통과시킨다. **우회 경로는 발견되는 것이 아니라 즉시 실패한다.**
- **과금 종료 시점의 정본**: `reason ∈ {ended, idle_timeout, orphaned, provider_missing, destroyed}`. 세션이 `orphaned`로 갈 때 정산하는 현행 의미(호스트가 죽었으므로 더 이상 적립되지 않는다)를 **명시 결정으로 승격**한다 — 지금은 sweep 코드에만 있다. 계보 재개가 원본을 닫을 때 정산하지 않는 것은 그때 이미 `reason='orphaned'`로 정산됐기 때문이며, **`t3_terminate`의 멱등성이 그 의존을 불변식이 아니라 사실로 만든다**(두 번 불러도 안전하므로 계보 경로도 그냥 부른다).
- B — 호출자 규약 유지 + 리뷰로 감시: 세 라운드 동안 실패한 방법이다. **기각.**

### D4. provider 호출 경계 — intent 커밋 → 외부 호출 → 확정, 그리고 수렴 규칙

- **A (권고)**: 순서는 **① durable intent 커밋**(operation id·kind·version·started_at·deadline) → **② 트랜잭션 밖 provider 호출**(idempotency key = `lifecycle_operation_id`) → **③ 새 트랜잭션에서 D2 사다리로 잠그고 (operation_id, version) 일치 재검증 후 확정**. 불일치면 **응답을 버린다**(낡은 결과가 종속 상태를 바꾸지 못한다 — 2차 리뷰 결함의 근본).
- **미확정의 수렴 규칙을 명문화한다.** 지금은 "reconciler가 수렴한다"까지만 있고 무엇으로 수렴하는지는 경로마다 다르다.

  | 국면 | 수렴 |
  |---|---|
  | `pausing` 실패/타임아웃 | `running`으로 복귀. 과금은 계속 — **의심스러우면 사용자에게 유리하지 않은 쪽이 아니라, 사실에 맞는 쪽**(샌드박스가 안 멈췄으면 자원을 쓰고 있다) |
  | `resuming` 실패/타임아웃 | `paused`로 복귀. interval은 열지 않는다 |
  | `resuming` + provider 404/410 | 샌드박스 소멸 확정 → `t3_terminate(reason='provider_missing')` |
  | `destroy_pending` 실패 | **무한 재시도**(지수 백오프). 유일하게 포기하지 않는 intent — 유료 자원이 남는다 |
  | intent deadline 초과 | reconciler가 provider에 **상태를 조회**해 사실로 판정. 조회 불가면 위 규칙 적용 |

- **`*ing` 상태에 deadline을 필수화한다**(`lifecycle_operation_started_at` + 상한). deadline 없는 중간 상태가 2차 리뷰의 영구 교착이었다.
- B — 2PC/분산 트랜잭션: E2B가 참여자가 될 수 없다. **기각(불가능).**

### D5. 테스트 계약 — 두 트랜잭션이 실제로 동시에 잠금을 쥐어야 한다

- **A (권고)**: T3 동시성 검증기는 **두 개의 PG 연결**을 열고, 각 경로를 잠금 획득 직후 정지시킨 뒤 **양쪽이 동시에 잠금을 보유·대기하는 상태를 `pg_locks`/`pg_stat_activity`로 단정**한 다음 진행시킨다. 이 단정이 **테스트 자체의 유효성 검사**다 — 없으면 직렬 시나리오가 조용히 green을 낸다(3차 리뷰가 실제로 당했다).
- **red proof**: 한 경로의 잠금 순서를 되돌리면 `deadlock detected`(SQLSTATE 40P01)라는 **이름 있는 실패**로 빨개진다. 행·타임아웃 형태의 실패는 수용하지 않는다.
- **정산 멱등 계약**: `t3_terminate`를 같은 세션에 동시 2회·순차 2회 호출해도 `credit_entry` 1행. 트리거 봉인(D3)은 **직접 UPDATE가 거부되는 것**을 단정한다.
- **모의 provider의 정직성**: 현행 mock E2B는 pause 중에도 계속 응답한다(1차 리뷰가 이걸로 결함을 놓쳤다). mock은 **pause 후 호출에 사실대로 실패**해야 한다.

## 티켓 흡수 판정

- **#885(잠금 순서 역전) → D2에 흡수.** 개별 수리는 순서 하나를 고를 뿐 규약을 강제하지 못한다.
- **#879 분할**: interval별 floor로 인한 시간 유실은 **D3에 흡수** — GENERATED 컬럼을 **마이크로초 단위로 바꾸고**(`active_micros`) floor는 정산에서 **한 번만** 한다. pause 구간이 구조적으로 0이라는 성질은 그대로 유지된다. **replay 구독자 큐 무제한은 호스트 데몬 문제라 T3와 무관 — 독립 유지.**
- **#886(049 fail-closed 탈출구) → 독립 유지, 그리고 본 ADR보다 먼저 랜딩한다.** 업그레이드를 막는 운영 결함이라 재설계를 기다릴 수 없다. 단 repair 커맨드는 **D3의 단일 문을 쓰도록** 설계한다(선행 마이그레이션으로 primitive 설치 → repair → 별도 마이그레이션에서 unique 강제).
- **#884(스코프 갱신)는 T3 무관 — 이미 독립 랜딩됨**(#889).

## Consequences

- (+) 잠금 순서·전이 합법성·정산 단일성이 **전부 DB가 강제**한다. 다음 경로가 규약을 어기면 리뷰가 아니라 트리거가 잡는다.
- (+) 동시성 테스트가 "동시였음"을 스스로 증명하므로, green이 다시 안전을 뜻한다.
- (+) ADR-0136/0139의 사용자 대면 약속(pause 중 미과금, idle 재부착)은 **문구 하나 바뀌지 않는다.**
- (−) 마이그레이션이 3단(primitive → repair → 제약)으로 길어지고, `active_seconds` 컬럼 의미 변경이 기존 원장 행 재계산을 요구한다.
- (−) 트리거 기반 봉인은 DB 함수 안에서만 정산이 가능하다는 뜻 — Swift에서 정산 로직을 디버깅하기 어려워진다. 대신 정산 경로가 하나뿐이라 로그 지점도 하나다.
- (−) D2를 어느 선택지로 가든 한 계층은 재작성된다: **A는 REST 종료·sweep**(T1/T2 공유), **B는 reconciler**(T3 전용), **C는 sweep의 트랜잭션 경계**. 비용의 크기보다 **위험이 어디로 가느냐**가 다르다.
- (−) T3 비활성 기간이 이행 완료까지 연장된다. **T1/T2 사용자 경험에는 영향 없다.**

## 이행 (Accepted 시)

1. **#886 선행 랜딩**(3단 마이그레이션 + 런북) — 업그레이드 차단 해제.
2. **D1 전이표 + D2 사다리 + D3 단일 문**을 하나의 티켓으로(쪼개면 중간 상태에서 두 규약이 공존해 더 위험하다). 기존 4개 호출자를 전부 `t3_terminate`로 대체.
3. **D4 수렴 규칙** — reconciler 재작성 + deadline 강제.
4. **D5 검증기** — 동시성 하니스는 2와 **같은 티켓**에서 나온다(나중에 붙이면 그 사이 green이 무의미하다).
5. `MOMO_T3_ENABLED` 기본 활성화는 **위 전부 통과 + 실 E2B smoke** 이후 별건 판단.
