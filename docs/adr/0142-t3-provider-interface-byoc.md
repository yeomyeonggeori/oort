# ADR-0142: T3 Provider 인터페이스 — BYOC 1급, oort Cloud는 그 위의 관리형 구현

- Status: **Accepted** (2026-07-29, 성재 — "ADR-0142, 0143 승인할게". 기안 Fable)
- 파생: 이행 1~3은 #892 재개와 함께 티켓화. oort Cloud 실 provider(substrate)는 ADR-0144(기안 중).
- 관련: ADR-0136(프로비저너·크레딧 — **provider 축만 개정**, 크레딧·슬롯 결정은 유지), ADR-0140(수명주기 — 전부 유지, D4가 이 ADR의 어댑터 계약이 됨), ADR-0125(work host fabric), ADR-0004(자격증명 비유입)
- 입력: `docs/planning/2026-07-29-gpt-work-runtime-review.md` §3 + 우로보로스 인터뷰(interview_20260729_053912)
- 발단: 성재(2026-07-29) — "E2B는 사실상 폐기. 셀프호스팅 유저는 의존성 0 + 세팅 쉬움. 워크스페이스 유저는 momo 통해 cloud 구매 또는 직접 호스팅 연동."

## Context

- 현행 T3는 oort Cloud(E2B) **단일 경로**다: `045:103 CHECK (provider = 'e2b')`, `CloudLifecycleReconciler`의 E2B HTTP 클라이언트, `Config.swift`의 e2b* 설정. "본인이 호스팅해서 연동"(BYOC)이 불가능하다 — 성재 원칙과 정반대 방향.
- 반면 **BYOC의 재료는 이미 있다**: cloud workd 부트스트랩(1회 토큰 digest → workd가 소비하고 Ed25519 자체 등록, 045)은 provider 무관이며, T2 데몬 등록과 같은 문법이다. ADR-0140의 수명주기(durable intent·수렴 규칙·idempotency key·`t3_terminate`·advisory 직렬화·전이표)도 전부 provider-일반형이다.
- 즉 이 ADR은 새 체계를 세우는 것이 아니라 **이미 일반형인 것에서 E2B 껍데기를 떼고, 등록 경로를 공식화**하는 것이다.

## Decision

### D1. 실행 주체의 이원화 — BYOC가 기본형, managed provider는 그 위의 자동화

T3 cloud host의 획득 경로를 두 가지로 정의한다. **수명주기·과금·관찰은 획득 경로와 무관하게 동일하다.**

- **BYOC (기본형)**: 워크스페이스 운영자가 자기 인프라(아무 VM/컨테이너)에 `momo-workd`를 설치하고, oort가 발급한 1회 부트스트랩 토큰으로 등록한다. 기존 cloud workd 부트스트랩 흐름 그대로. **oort는 이 호스트를 생성·파괴하지 않는다** — 수명은 소유자 책임이고, oort는 등록·세션 배정·수명주기 관찰·(선택) 과금만 한다.
- **Managed provider (자동화)**: oort(또는 셀프호스트 운영자)가 설정한 provider 어댑터가 위와 **같은 등록 흐름을 자동으로 수행**한다 — 어댑터의 유일한 추가 권한은 "인스턴스를 만들고 부수는 것"이다. E2B는 폐기하되, 어댑터 계약의 첫 구현은 **mock provider**(검증용)이고 실 구현(oort Cloud를 무엇으로 호스팅할지 — K8s/VM/Firecracker)은 **후속 별건 결정**이다.
- **등록 단위: 워크스페이스 공용만**(성재 확정). `work_host`의 기존 workspace scope를 재사용한다. 개인(personal) BYOC는 후속 — 스키마는 막지 않되 REST에서 닫는다.

### D2. Provider 어댑터 계약 — ADR-0140 D4가 곧 인터페이스다

어댑터가 구현할 표면은 ADR-0140 D4의 경계 그대로다:

| 연산 | 의무 |
|---|---|
| `create(spec, idempotency_key)` | 인스턴스 생성 + workd 부트스트랩 주입. 같은 key 재호출은 같은 인스턴스 |
| `pause(ref, key)` / `resume(ref, key)` | 지원 안 하면 **capability로 선언하고 거부** — 흉내 금지 |
| `destroy(ref, key)` | 멱등. 무한 재시도 대상(ADR-0140 D4) |
| `probe(ref)` | 사실 조회 — deadline 초과 수렴의 근거 |

- **capability 선언**: `supports_pause`, `resume_semantics`(메모리 보존 여부), `continuous_runtime_limit` 등을 어댑터가 선언한다. ADR-0136/0139/0141의 E2B 고유 수치(pause 4초/GiB·keepMemory·상한 24h)는 전부 이 선언으로 이동한다 — **정책 코드가 특정 provider의 상수를 아는 것을 금지**한다.
- BYOC는 이 계약에서 `create/destroy`가 없는 **degenerate 어댑터**다(pause/resume도 기본 미지원 — idle 시 과금은 어차피 활성시간 기준이라 사용자 손해 없음).

### D3. 연속성 무상태 의무 (인터뷰 확정 — 부정형 2개, testable)

1. **어댑터는 죽음을 정직하게 보고한다** — 인스턴스 사망·해지 시 `probe`/호출 실패가 ADR-0140 D4의 `provider_missing` 수렴으로 이어져 **이름 있는 상태**로 남아야 한다. 침묵 실패 금지.
2. **연속성 필수 상태를 provider 내부에만 두지 않는다** — 스냅샷·pause 이미지는 최적화이고, 원본은 git(계보·WIP)과 oort 원장이다(ADR-0139 D2와 동일 문장). 따라서 **cross-provider 재개는 별도 절차가 아니라 기존 재개 경로 그 자체**다.
- 수용 기준: mock provider 2종 간 — A에서 WIP까지 만든 세션을 A 사망 후 B의 새 Run으로 재개했을 때 계보·WIP 복원을 격리 검증기로 단정.
- 사용자 책임으로 남는 것 하나: BYOC 해지 시 provider 내부 잔여 스냅샷 삭제(oort가 지울 수 없음 — **고지 의무만**).

### D4. E2B 제거 범위

- `045:103 CHECK (provider = 'e2b')` → 마이그레이션으로 완화(`provider`는 어댑터 레지스트리 참조로).
- `CloudLifecycleReconciler`의 E2B HTTP 호출부 → D2 어댑터 인터페이스로 추출. `Config.swift` e2b* 설정 제거.
- mock E2B 검증기 → mock provider로 일반화(2종으로 확장 — D3 수용 기준).
- `E2B_API_KEY`는 폐기 후 `.env`에서 제거 권고(성재 몫).

## Consequences

- (+) "셀프호스팅 의존성 0 + 워크스페이스는 구매 또는 직접 연동"이 구조로 성립. BYOC는 T2 등록과 같은 문법이라 **배울 것이 늘지 않는다.**
- (+) ADR-0140 산출물(T-3 정본화 포함)은 전부 살아남는다 — #891은 이 ADR과 무관하게 유효.
- (+) oort Cloud 실체 결정(무엇으로 호스팅할지)을 인터페이스 뒤로 분리 — 지금 결정할 필요가 없어진다.
- (−) #892(T-4)는 이 ADR Accepted 후 새 인터페이스 대상으로 재개(이미 보류 처리).
- (−) BYOC 호스트의 신뢰 경계: 사용자 인프라의 workd는 oort가 무결성을 보증할 수 없다 — 기존 T2와 같은 신뢰 수준으로 문서화(새 위험이 아니라 기존 위험의 명문화).
- (−) pause 미지원 BYOC에서는 idle 시 sandbox pause 최적화(ADR-0139 D4)가 비활성 — 활성시간 과금 원칙 덕에 사용자 비용 영향은 없음.

## 이행 (Accepted 시)

1. 어댑터 인터페이스 + mock provider 2종 + D3 검증기 (서버·NotifierWorker).
2. E2B 제거 마이그레이션 + reconciler 추출 — **#892와 같은 배치**(T-4 수렴 규칙을 새 인터페이스 위에 구현).
3. BYOC 등록 REST 공식화(워크스페이스 공용만) + 셀프호스트 설치 문서("workd 설치 → 토큰 등록" 2단).
4. oort Cloud 실 provider 선정은 별건 ADR.
