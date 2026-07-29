# goal #897 — MOMO-670: provider 어댑터 + E2B 제거 + BYOC 등록 공식화 (ADR-0142 이행 1~3)

너는 momo 레포의 구현 worker다(Claude Opus). 이 문서가 네 유일한 지시서다. 계약은 `AGENTS.md`.
**base = `track/engine`**(= `ff1e9066` 이후). 워크트리: `~/projects/momo-tracks/momo-worktrees/897-provider-adapter`.
근거 정본: `docs/adr/0142-t3-provider-interface-byoc.md`(Accepted) — 작업 전 정독.

## 0. 착수 전 필수

1. `git status` clean 확인. 2. 자격증명·`.env` 열람 금지(E2B_API_KEY 이름조차 출력하지 마라). 3. **PR 생성 후 STOP** — merge/close 금지. 4. **docker 검증은 오케스트레이터 몫** — 너는 `swift build`/`swift test`와 정적 검사까지만 실행. 5. 심볼은 쓰기 전 grep으로 실재 확인. 6. UUID 텍스트 비교는 `lower()` 정규화. 7. 픽스처 SQL의 `INSERT ... SELECT` 리터럴은 명시 캐스트(`::uuid`·enum) — SELECT 분기는 대상 컬럼 타입으로 강제되지 않는다(#890·#891 실측 결함 2연속).

## 1. 전제 (이미 랜딩된 것 — 깨지 마라)

- **ADR-0140 전부 랜딩됨**: `t3_terminate` 단일 문 + `settled_at` 트리거 봉인(053) · 전이표 `work_cloud_host_transition` + BEFORE UPDATE 트리거 · 호스트 advisory 직렬화(052) · 잠금 사다리(advisory→credit→cloud_host→usage→interval→session).
- cloud workd 부트스트랩: 1회 토큰 digest → workd 소비 → Ed25519 자체 등록(045) — **provider 무관, 재사용 대상**.
- pause 미계상 = GENERATED 컬럼(045:66-72) — 세 라운드 리뷰 내내 안 깨진 자리. 손대지 마라.

## 2. 할 일

### 2-1. 어댑터 인터페이스 (ADR-0142 D2)

- Swift 프로토콜 `CloudProviderAdapter`(서버·NotifierWorker 공유 — 위치는 네 판단, 근거를 커밋에):
  `create(spec, idempotencyKey)` · `pause(ref, key)` · `resume(ref, key)` · `destroy(ref, key)` · `probe(ref)`.
- **capability 선언 타입**: `supportsPause`, `resumeSemantics`(memory|coldBoot), `continuousRuntimeLimit` 등. **정책 코드(reconciler·sweep·REST)가 특정 provider 상수를 직접 아는 것을 금지** — 반드시 capability 경유.
- `destroy`는 멱등(같은 key 재호출 안전). `probe`는 사실 조회 — "존재/부재/불명"을 구분해 답한다.

### 2-2. E2B 제거 (ADR-0142 D4)

- 새 마이그레이션(다음 번호): `work_cloud_host_provider_ck CHECK (provider='e2b')`(045:103) 완화 — provider는 어댑터 레지스트리 식별자.
- `CloudLifecycleReconciler.swift`의 E2B HTTP 호출부를 어댑터 호출로 교체. `Config.swift`의 `e2bAPIBaseURL`/`e2bAPIKey`/`e2bTemplateID` 제거 — 대신 어댑터 설정 로딩(`MOMO_T3_PROVIDER=<name>` + provider별 env 네임스페이스).
- **mock provider 2종** 구현(`mock-a`/`mock-b` — 검증기용): 정상 수명주기 + **pause 후 호출에 사실대로 실패**(정직성 — 1차 리뷰가 이걸로 결함을 놓쳤다) + `probe`가 죽음을 정직 보고.
- 기존 검증기의 mock E2B 표현을 mock provider로 일반화. **E2B 문자열이 정책 코드·검증기에 잔존 0**이 수용 기준(마이그레이션 히스토리·ADR 문서는 제외).

### 2-3. BYOC 등록 공식화 (ADR-0142 D1)

- 기존 부트스트랩 토큰 흐름을 **BYOC 등록 REST로 공식화**: 워크스페이스 운영자가 토큰 발급 → 아무 VM의 workd가 등록. **워크스페이스 공용만**(personal은 REST에서 닫는다 — 스키마는 막지 않음).
- BYOC 호스트는 어댑터 계약에서 create/destroy 없는 degenerate — provider 값으로 구분(`byoc`).
- 셀프호스트 설치 문서: `docs/`에 "workd 설치 → 토큰 등록" 2단 가이드(복붙 가능한 명령).

### 2-4. 연속성 무상태 검증기 (ADR-0142 D3)

- 신규 격리 검증기: mock-a에서 세션 생성·사용 → mock-a **사망**(probe가 부재 보고) → reconciler가 `provider_missing` 수렴(`t3_terminate` 경유) → 같은 계보를 **mock-b의 새 Run으로 재개** → 계보(`resumed_from_session_id`) 연결 단정.
- **red proof**: mock의 probe가 죽음을 숨기면(존재로 거짓 보고) 검증기가 **이름 있는 실패**로 빨개진다. 행·타임아웃 금지. 절차를 PR 본문에 명시.

## 3. 하지 말 것

- **T-4 수렴 규칙(deadline·국면별 수렴표·reconciler 재작성)은 #892다** — 이 티켓은 인터페이스와 제거만. 기존 reconciler 로직은 어댑터 호출로 **기계적 치환**이 원칙(로직 변경 최소).
- k8s adapter 실구현은 ADR-0144 이행 2(별도 티켓).
- `schema_v0.sql` 수정·이동 금지. 052/053의 잠금·봉인·전이표 변경 금지.
- ADR-0143(workstream) 범위 침범 금지.

## 4. 검증 (worker 몫)

- `swift build` + 서버 테스트 무회귀(현재 349) + NotifierWorker 무회귀 + WorkHostDaemon 무회귀.
- `scripts/check_migration_numbers.sh` 통과.
- E2B 잔존 grep 결과를 PR 본문에 첨부.
- 오케스트레이터 실행 목록(docker 검증기·하니스·T1/T2 무회귀)을 PR 본문에 명시.

## 5. PR

`feat/897-provider-adapter` → `track/engine`. 본문: 어댑터 프로토콜 위치·설계 근거, capability 선언 형태, mock 2종의 정직성 구현, BYOC REST 표면, E2B 잔존 grep, red proof 절차, 계획 이탈. **PR 후 STOP.**
