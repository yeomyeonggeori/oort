# ADR-0145: 서버 스택 전환 — Swift/Hummingbird → Rust/Axum 재작성 (buzz는 레퍼런스, fork 아님)

- Status: **Accepted** (2026-07-30 성재 B안 승인. 최초 A안(fork) 결정 → 선행 스파이크가 fork 불성립 판정 → B안(참조 재작성)으로 확정. 기안 Fable)
- 관련: ADR-0133(UI = Tauri/React — 클라이언트 짝), ADR-0004(자격증명 비유입·permissive 스택), ADR-0125/0136/0139/0140/0142/0144(T3 work runtime — 이식 대상), ADR-0143(workstream — 이식 대상), **ADR-0146(Proposed — 에이전트 행동 provenance 서명, 이 재작성에서 선택 차용)**
- 입력: `docs/planning/2026-07-30-server-stack-reassessment.md`(§0~§7 리서치 근거), `docs/planning/2026-07-30-server-rewrite-plan.md`(설계-우선 이행 계획 = 이 ADR의 실행 정본)
- 발단: 성재 — "서버가 왜 굳이 Swift냐. buzz 기반 rust/tauri migration 때 데스크탑에만 집중해 생긴 잔재 같다."

## 결정

**momo 서버를 Swift/Hummingbird에서 Rust/Axum으로 재작성한다. buzz(block/buzz, Apache 2.0)는 fork/의존이 아니라 코드 레퍼런스로만 쓴다. momo 하드 불변식 6개를 전부 보존한다. 지금 최우선으로, 설계부터 착수한다.**

핵심 재구성(이 결정을 저위험으로 만드는 축):

- **불변식은 재작성하지 않는다 — DB에 이미 살아 있다.** 단일 쓰기경로·gapless `message.seq`·RLS FORCE·provider 비유입은 59 마이그레이션(44/59가 트리거·제약·RLS로 강제)에 박혀 있다. **마이그레이션은 Postgres DDL이라 언어 독립 → 그대로 재사용.** 따라서 재작성 대상은 "불변식"이 아니라 **애플리케이션 계층**(서버 52 route files ≈ 42k + workd 6k + NotifierWorker 3k Swift ≈ 51k LOC)을 **동일 스키마 위에 Rust로 다시 얹는 일**이다. ADR-0140 교훈("코드 규약은 깨지고 DB 제약은 살았다")이 여기서 보증이 된다 — 정합성의 최종 강제자가 DB이므로 앱 언어 교체가 불변식을 위협하지 않는다.

- **buzz에서 취하는 것 = 패턴 인용만.** Axum handler 파이프라인, sqlx 사용법, connection 백프레셔(semaphore), 검색 인덱싱. **채택하지 않는 것 = Nostr 이벤트 모델 전체**(클라-서명-publish·`created_at` 순서·kind 정수 dispatch·RLS 부재) — momo 불변식과 정면 충돌(아래 스파이크 판정). (git-over-http는 momo에 네이티브 git 서버 도메인이 없어 제외 — GitHub은 플러그인.)

- **buzz에서 선택 차용 = 에이전트 행동 provenance(성재 지시).** buzz의 최대 강점(모든 행동이 서명된 이벤트 = 암호학적 감사추적) 중 momo 도메인에 유효한 조각만 취한다. momo는 이미 **workd가 Ed25519로 페이로드를 서명**하는 원시 기능을 보유 → 특정 에이전트 원본 행동에 서명을 **additive하게** 얹는다. **단일 쓰기경로·RLS는 불변**(서버가 여전히 유일 저자, 서명은 검증 가능한 provenance 메타데이터로만). 설계는 **ADR-0146**으로 분리.

## 스파이크 판정 (2026-07-30, fork 전 필수 검증) — A안 불성립 → B안 근거

buzz 코드 실측(github.com/block/buzz `18eef63`, ~180k LOC Rust, 24 마이그레이션)으로 판정: **buzz ↔ momo는 스택 표면(PG·Redis·S3·TS클라)만 1:1이고, 정합성·격리 코어는 정반대다.** momo 하드 불변식 6개 중 **3개가 buzz의 Nostr relay 코어와 정면 충돌**:

| momo 불변식 | buzz | 화해 |
|---|---|---|
| 단일 쓰기경로(서버-authored, 클라 직접 publish 금지) | **클라가 Schnorr 서명 이벤트를 직접 publish**(Nostr의 존재 이유) | ❌ 정반대 |
| gapless `message.seq`(PG sequence 금지) | 순서=`created_at`(클라 wall-clock)+event id, **gapless seq 부재** | ❌ 근본 충돌 |
| RLS FORCE + 역할분리 | **RLS 전무** — 격리=community-key 복합키+앱 ctx | ❌ DB 강제 부재 |

- 데이터 모델부터 다르다: momo `message`는 서버-authored·**무서명**이라 buzz `events`(content-hash id + 필수 Schnorr sig) 테이블에 **넣을 수조차 없다.**
- **둘 다 "relay = SoT"는 같다.** buzz도 "no P2P, no gossip, no replication — the relay is the single source of truth". 차이는 중앙/분산이 아니라 **저자·순서·격리강제**다.
- **정정**: buzz는 **secp256k1 Schnorr**(nostr crate), momo는 **Ed25519**. 재검토 문서가 "buzz=Ed25519"라 적은 건 오류.
- buzz는 momo 고유(work_*·usage·credit·workstream)가 **전무** → 어느 방식이든 100% momo가 짠다. fork로 아끼려던 "메신저 코어 재작성"은 그 코어를 momo 불변식에 맞추려면 buzz 코어를 도려내야 하므로 절감이 **실질 증발**.
- **결론**: fork로는 불변식 3개를 상속 불가 → buzz는 **의존이 아니라 레퍼런스**로만 = B안.

## 근거 (요약 — 상세는 재검토 문서 §0~§7)

1. **Swift 서버 = 잔재 확정.** Swift-on-server의 존재 이유는 Apple 클라이언트 코드 공유인데, 클라이언트가 Tauri(TS/Rust)로 옮기며 그 대상이 사라졌다. 시장 점유 0.06% 니치.
2. **참조 모델 buzz가 서버를 Rust/Axum으로 짰다.** 같은 도메인(에이전트 네이티브 메신저·relay·git 협업)을 푼 답이 Rust다. momo만 서버를 Swift로 어긋냈다.
3. **성재 축(정합성·스케일·내구성)에서 Rust 유력.** momo의 실제 난제가 동시성/정합성(T3 재설계 3라운드)이고 Rust의 타입·소유권·동시성 안전이 직접 기여. 최종 강제는 이미 DB → 이중 안전망.
4. **지금이 가장 싸다** — 출시 전·사용자 0. T3/workstream 다섯 배치가 방금 끝나 안정 지점.

## Consequences

- (+) 참조 모델 buzz와 정합, 클라이언트-workd-서버 Rust 통일 가능, 정합성 타입 안전, relay 성능.
- (+) **불변식이 DB에 있어 재작성 위험이 "앱 계층 번역"으로 축소** — 동일 스키마·동일 게이트 픽스처가 conformance oracle이 된다.
- (+) provenance 서명 차용으로 에이전트 행동 감사추적 강화(ADR-0146) — Nostr 전체를 받지 않고 이점만.
- (−) buzz는 코드 인용만 → 메신저 하부층도 우리가 재작성(fork 절감 없음). 대신 불변식·정체성 온전.
- (−) 51k LOC Swift→Rust 번역 — 수 주 기능 정지(성재 수용, 사용자 0인 지금이 가장 쌈).
  - **사실 정정 (2026-08-03, 성재 승인).** 기능 정지는 **일어나지 않았고, 일어나지 않는 편이 나았다.** 재작성이 메신저 코어(메시지·채널·반응·검색·realtime)를 먼저 넘겨서 클라이언트가 붙을 표면이 이미 있었고, 그 위에서 RN 모바일·Tauri 데스크톱·푸시 종단이 **병행으로** 섰다. 실제 방침은 **"재작성과 클라이언트 병행, 단 클라는 Rust가 이미 주는 라우트만 쓴다"**이다. 경계 변경이 아니라 예측의 정정이므로 새 ADR을 열지 않는다.
  - 삭제 시점도 같은 날 확정: **Swift 서버는 라우트 parity 도달 시 일괄 삭제**하고, 그때까지 `server/`는 이식 원본으로만 살아 있다(실행 대상 아님).
- (−) T3/workstream 방금 투자를 이관 대상으로 — 단 로직·설계(ADR)는 언어 무관하게 살아남고, 재작성은 Swift→Rust 번역이다.

## 이행 — 설계부터

**실행 정본 = `docs/planning/2026-07-30-server-rewrite-plan.md`.** Phase 0(설계) 6개 산출물(D1 타깃 아키텍처 · D2 불변식 보존 스펙 · D3 provenance 설계=ADR-0146 · D4 buzz 인용 카탈로그 · D5 커토버·parity 전략 · D6 이행 배치 분할)을 먼저 확정한 뒤 구현 배치(메신저 코어 → T3 → workstream → 클라 재배선 → workd Rust)에 착수한다. **설계 승인 없이 재작성 코드 착수 금지.**

## 미해결 (Phase 0 설계가 답할 것)
- 커토버 전략: 빅뱅 재작성 vs strangler(엔드포인트별 프록시 라우팅). 사용자 0·동일 DB라 빅뱅이 유력하나 D5에서 확정.
- crate 레이아웃(buzz의 서브시스템 격리 교훈 채택 범위), sqlx vs sea-orm.
- provenance 서명 대상 행동 범위·저장 위치·검증 경로(ADR-0146).
- workd 동시 이관 여부(서버와 도메인 crate 공유 이득 vs 범위 팽창).

## 증보 1 — "parity"의 정의 (2026-08-04, 성재 승인)

삭제 게이트인 **라우트 parity는 Swift 137 유니크 경로 전체가 아니라 "제품이 쓰기로 결정한 라우트 집합"으로 정의한다.** 전 경로 parity는 삭제를 무기한 미루고, 이식 원본이 오래 살수록 "계약의 정답이 두 곳"인 기간이 길어진다(근거: `docs/planning/2026-08-04-handover-verification-and-roadmap-adjustment.md` §2.3).

초기 분류(각 패밀리의 최종 판정은 해당 배치/ADR에서 갱신해 이 절에 반영):

| 판정 | 패밀리 |
|---|---|
| **이식 대상(v0)** | attachments 3경로(ADR-0151 선행 — 번호 정정: 0150은 egress ADR이 선점) · agent-run cancel · agentRunHistory 읽기 경로 |
| **판정 보류(v1 결정 대기)** | plugins · webhooks · mcp · memories(+policy·consent) · huddles · workstreams · work-controls · work-auto-approvals · event-subscriptions · work-tool-profiles · bans · members 잔여 · platform |
| **폐기 후보(이식 없이 삭제 인정)** | `__momo_stub` · context-packets v0 형태 |

**삭제 실행 조건**: "이식 대상 + 보류에서 이식으로 승격된 것"이 전부 Rust에 서고, 보류·폐기 판정이 전 패밀리에 대해 내려졌을 때. 그 시점의 판정표가 이 절이다.

## 증보 2 — Swift 상시 빌드·테스트 퇴역 (2026-08-06, 성재 승인)

**Swift는 삭제 전이라도 상시 빌드·테스트 대상에서 제외한다.** 소스는 이식 원본(참조 정본)으로 유지하되, 반복 파이프라인에서 Swift를 빌드하는 세 자리를 퇴역시킨다: ①폰 레인 서버 스택 → server-rust 컴포즈로 이관(#1022 — 부수로 #1051 폰 실시간 검증·#1069 콜드 빌드 flake 해소) ②openapi 계약 게이트 1차(Swift) 패스 → 기본 off(opt-in `OPENAPI_GATE_SWIFT_PASS=1`)로 강등 — 스펙이 Rust를 서술(#1040)하는 이상 죽을 서버를 스펙과 대조하는 일이며, 커버리지 권위는 sampled-on-rust 매니페스트(#1042 잠식 기제)가 승계 ③Xcode Cloud의 Swift 클라(MomoiOS) 아카이브 워크플로 비활성(전 PR 상시 실패 소음 — 제품 클라는 RN/Tauri/웹).

근거: 성재 2026-08-06 — "swift는 이제 사실상 버릴 거라서 따로 빌드나 테스트 안 해봐도 될 것 같다." 삭제 실행 조건(위 판정표)은 불변 — 이 증보는 삭제가 아니라 반복 비용 제거다.
