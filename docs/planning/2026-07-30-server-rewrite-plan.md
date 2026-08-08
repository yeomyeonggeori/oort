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
- crate 레이아웃. buzz의 "relay가 오케스트레이터, 서브시스템은 서로 격리" 교훈 채택 범위 결정. oort 도메인 경계(auth·messaging·outbox/relay·t3-runtime·workstream·billing·git)로 매핑.
- Axum handler 파이프라인이 **단일 쓰기경로**(`REST→PG→outbox→relay`)를 어떻게 강제하나 — 쓰기 진입점 단일화, outbox 삽입이 같은 트랜잭션.
- sqlx vs sea-orm 결정(sqlx 유력 — 컴파일타임 쿼리 검증이 정합성 축에 부합, buzz도 sqlx).
- 마이그레이션 재사용 방식: `schema_v0.sql`+59 마이그레이션을 그대로. Rust 측은 sqlx-migrate로 동일 파일 실행(수정·이동 금지 — 하드룰).
- 런타임 짝: Centrifugo(전송전용) 유지, workd 계약(UTF-8 바이트 서명) 유지.
- **열린 결정**: crate 격리 강도, ORM.

### D2. 불변식 보존 스펙 — `docs/architecture/invariants-in-rust.md` ✅ 작성됨
- 하드 불변식 **7개** 각각 → `[Rust 강제 지점·DB 백스톱·되돌리면 실패하는 red 테스트]` 표. RLS는 `momo-db::with_tenant_tx` GUC 단일 지점(미들웨어 아님, 실측), seq=row-lock+UNIQUE. 논리: 불변식은 DB에 있고(재사용) 앱이 우회 못 하게 배선+red로 증명.

### D3. provenance 서명 → **ADR-0146 범위 확정** ✅ (2026-07-30 성재: "상태 전이까지 넓게")
- 범위 = 세 표면 전부(메시지·workd 작업 이벤트·상태 전이). 서명자 유형별(에이전트·workd 즉시, 사람은 device 키 fast-follow). 저장=사이드카 `action_signature`(060+). 검증=`record_provenance` chokepoint(= provenance판 `emit_outbox`). **단일 쓰기경로·seq·RLS 무손상**(D2 교차검증표).
- **교차 관심사**: 공유 프리미티브 B0/B1, 서명 emit은 각 배치 분산(D6). 세부(페이로드 바이트·device 키 시점·UX 표식)는 D3 상세→성재 최종 Accept.

### D4. buzz 인용 카탈로그 — `docs/planning/2026-07-30-buzz-reference-catalog.md` ✅ 작성됨
- 취함(패턴): Axum 파이프라인·sqlx·백프레셔·서브시스템 격리 원칙·검색 인덱싱. 거부(불변식 충돌): Nostr 모델·클라 publish·created_at·kind dispatch·RLS 부재·NIP 상호운용. 제외(무관): git-over-http. 선택 차용: provenance 서명(ADR-0146). Apache 2.0 출처 주석 규약.

### D5. 커토버 & parity — `docs/planning/2026-07-30-cutover-and-parity.md` ✅ **빅뱅 확정**
- 빅뱅(사용자 0·동일 DB → strangler 불필요). parity oracle=동일 마이그레이션 DB에 기존 게이트/픽스처 조준("동일 요청→동일 상태·응답"). 롤백=이미지 교체(스키마 불변). D2 red 7개 conformance 편입.

### D6. 배치 분할 — `docs/planning/2026-07-30-rewrite-batch-breakdown.md` ✅ 작성됨
- **B0(골격) 신설** + B1~B5. provenance 교차 관심사 분산 명시. Phase 0 승인 후 각 배치를 handoffs/ 패킷으로 전개(수용기준·red-proof·게이트).

---

## 구현 배치 (Phase 0 승인 후. 워커 병렬) — 상세 D6

> 순서: `B0 → B1 → {B2,B3} → B4 → B5`. 각 배치는 이전 conformance 통과가 전제.

- **B0. 워크스페이스 골격** — Cargo 워크스페이스 + 공유 5 crate 스켈레톤(db·outbox·wire·auth·provider) + 마이그레이션 러너(기존 59 그대로) + provenance 프리미티브(`record_provenance`·`action_signature` 060+).
- **B1. 메신저 코어**(`momo-messaging`) — identity·channels·message(seq·`emit_outbox`)·huddle·search + **에이전트 메시지 서명**. D2 red #1~#6 green.
- **B2. T3**(`momo-t3`) — 실행·과금·saga(0140)·재부착(0139)·provider/BYOC(0142)·Kata(0144) + **workd 이벤트·상태 전이 서명**. D2 #7 green.
- **B3. workstream** — actor-독립 연속성(0143) + 상태 전이 서명 잔여.
- **B4. 클라 재배선** + `momo-integrations` 마무리.
- **B5. workd Rust** — `momo-wire` 공유, 재부착 실왕복 재검증. 동시/후행은 D1 §4.

각 배치 완료 정의: 해당 영역 conformance green + design-review(웹 표면) + red-proof.

---

## 병행·독립 트랙
- **NCP T3 smoke**는 서버 스택과 독립(workd 계약 언어 무관) — 재작성과 무관하게 진행. 현행 Swift 서버 이미지로 smoke, 재작성 완료 후 Rust 이미지로 재-smoke.

## 성재 결정 대기 지점
- Phase 0 산출물 D1~D6 승인(특히 D5 커토버=빅뱅 확인, ADR-0146 Accepted 승격).
- 그 전까지 재작성 코드 착수 없음.
