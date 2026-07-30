# 서버 재작성 이행 계획 — Swift/Hummingbird → Rust/Axum (B안: buzz 레퍼런스)

> **ADR-0145의 실행 정본.** 설계(Phase 0)부터. 설계 승인 없이 재작성 코드 착수 금지.
> 워커 모델 = Opus 5. 병렬 = Workflow / 이름 없는 백그라운드 서브에이전트(`name:` 팀메이트 금지).

## 0. 이 계획을 저위험으로 만드는 한 문장

**불변식은 DB에 산다(59 마이그레이션, 44/59가 트리거·제약·RLS로 강제) → 마이그레이션은 언어 독립이라 그대로 재사용 → 재작성은 "불변식 재구현"이 아니라 "애플리케이션 계층(52 route files·workd·NotifierWorker ≈ 51k Swift)을 동일 스키마 위에 Rust로 다시 얹기".** 동일 DB·동일 게이트 픽스처가 conformance oracle. ADR-0140 교훈("DB 제약만 살았다")이 여기서 보증이 된다.

buzz 관계: **패턴 인용만**(Axum 파이프라인·sqlx·백프레셔·git-over-http·검색 인덱싱). Nostr 이벤트 모델(클라-서명-publish·created_at·kind dispatch·RLS 부재)은 **불채택**. 단 **provenance 서명은 선택 차용**(ADR-0146).

---

## Phase 0 — 설계 (지금. 기획 레이어=Fable가 직접. 워커 아님)

여섯 산출물을 확정하고 성재 승인 → 그 다음 구현 배치. 각 산출물은 문서 하나로 떨어진다.

### D1. 타깃 아키텍처 설계 — `docs/architecture/server-rust.md` (신설)
- crate 레이아웃. buzz의 "relay가 오케스트레이터, 서브시스템은 서로 격리" 교훈 채택 범위 결정. momo 도메인 경계(auth·messaging·outbox/relay·t3-runtime·workstream·billing·git)로 매핑.
- Axum handler 파이프라인이 **단일 쓰기경로**(`REST→PG→outbox→relay`)를 어떻게 강제하나 — 쓰기 진입점 단일화, outbox 삽입이 같은 트랜잭션.
- sqlx vs sea-orm 결정(sqlx 유력 — 컴파일타임 쿼리 검증이 정합성 축에 부합, buzz도 sqlx).
- 마이그레이션 재사용 방식: `schema_v0.sql`+59 마이그레이션을 그대로. Rust 측은 sqlx-migrate로 동일 파일 실행(수정·이동 금지 — 하드룰).
- 런타임 짝: Centrifugo(전송전용) 유지, workd 계약(UTF-8 바이트 서명) 유지.
- **열린 결정**: crate 격리 강도, ORM.

### D2. 불변식 보존 스펙 — `docs/architecture/invariants-in-rust.md` (신설, 재작성의 수용 계약)
- 하드 불변식 6개 각각 → Rust에서의 강제 지점 표. 결론은 대부분 "DB가 강제(마이그레이션 재사용) + Rust는 위반 불가능하게 배선":
  - PG=SoT / 단일 쓰기경로 → 쓰기 API 단일 모듈, 직접 INSERT 금지 lint.
  - gapless `message.seq` → 기존 seq 부여 트리거/함수 재사용(PG sequence 금지 유지).
  - agent=member → 동일 스키마.
  - RLS FORCE → 세션 `SET app.current_*` 배선을 Axum 미들웨어에서. 마이그레이션의 FORCE 정책 그대로.
  - provider 비유입(ADR-0004) → 어댑터 경계 재확인.
- **각 불변식마다 "이 불변식을 깨는 red 테스트"를 명시**(재작성이 그걸 통과시키면 실패). 게이트 픽스처에서 유도.

### D3. provenance 서명 설계 → **ADR-0146 확정** (이미 Proposed 발제됨)
- 5개 열린 항목(대상 범위·페이로드·저장·키/검증·UX) 확정. 최소 착수 = 에이전트 메시지 서명, 무서명 레코드와 nullable 공존.
- **단일 쓰기경로·RLS 무손상**이 설계 하드 제약. 성재 승인 시 Accepted → 구현은 메신저 코어 배치에 포함.

### D4. buzz 인용 카탈로그 — `docs/planning/2026-07-30-buzz-reference-catalog.md` (신설)
- buzz의 어느 파일·패턴을 인용하고 무엇을 거부하는지 표. 취함: Axum handler 파이프라인, sqlx 쿼리 스타일, connection semaphore 백프레셔, git-over-http, 검색 인덱싱. 거부: Nostr 이벤트 모델·kind dispatch·클라 publish·RLS 부재.
- 라이선스 준수(Apache 2.0 인용 표기 규약) 명시.

### D5. 커토버 & parity 전략 — `docs/planning/2026-07-30-cutover-and-parity.md` (신설)
- **빅뱅 재작성 vs strangler**. 권고: **빅뱅**(사용자 0·출시 전·동일 DB → strangler 이중운영 오버헤드 불필요). D5에서 확정.
- parity oracle: 기존 게이트/통합 테스트를 Rust 서버에 그대로 조준(동일 마이그레이션 DB) → "동일 요청 → 동일 DB 상태·응답" conformance suite.
- 롤백 경로(Swift 서버는 태그 보존, 동일 DB라 되돌리기 가능).

### D6. 이행 배치 분할 — `docs/planning/handoffs/` 패킷 초안
- 아래 §구현 배치를 핸드오프 패킷으로. 각 배치 = 수용기준 + red-proof + 오케스트레이터가 돌릴 게이트 명시.

---

## 구현 배치 (Phase 0 승인 후. 워커 병렬)

> 순서는 의존 기준. 각 배치는 이전 배치의 conformance 통과가 전제.

- **B1. 메신저 코어** — auth·member(agent 포함)·channel·thread·message 쓰기경로·seq·outbox/relay·RLS 미들웨어 + **provenance 서명(ADR-0146)**. D2 불변식 red 테스트 전부 green. 가장 크고 가장 중요.
- **B2. T3 work runtime 이식** — T1/T2/T3 실행·샌드박스·과금 원장·수명주기 saga(ADR-0140)·재부착/replay(ADR-0139)·provider 어댑터/BYOC(ADR-0142)·Kata substrate(ADR-0144). 로직·설계는 ADR에 있고 Swift→Rust 번역.
- **B3. workstream 이식** — actor-독립 연속성(ADR-0143)·목표층.
- **B4. 클라이언트 재배선** — Tauri/React 클라이언트를 Rust 서버 API에 맞춤(계약 diff만; 대개 동일).
- **B5. workd Rust** — 서버와 도메인 crate 공유 이득. D5에서 동시/후행 결정.

각 배치 완료 정의: 해당 영역 게이트/conformance green + design-review(웹 표면 시) + red-proof.

---

## 병행·독립 트랙
- **NCP T3 smoke**는 서버 스택과 독립(workd 계약 언어 무관) — 재작성과 무관하게 진행. 현행 Swift 서버 이미지로 smoke, 재작성 완료 후 Rust 이미지로 재-smoke.

## 성재 결정 대기 지점
- Phase 0 산출물 D1~D6 승인(특히 D5 커토버=빅뱅 확인, ADR-0146 Accepted 승격).
- 그 전까지 재작성 코드 착수 없음.
