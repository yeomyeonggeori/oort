# ADR-0145: 서버 스택 전환 — buzz fork 기반 Rust로, 지금 착수

- Status: **개정 대기** (2026-07-30 성재가 A안 fork 결정 → **선행 스파이크가 fork 불성립 판정, B안(참조 재작성) 전환을 성재 승인 대기**. 아래 §스파이크 판정 참조. 기안 Fable)

## 스파이크 판정 (2026-07-30, fork 전 필수 검증) — **A안 불성립**

buzz 코드 실측(github.com/block/buzz `18eef63`, ~180k LOC Rust, 24 마이그레이션)으로 판정: **buzz ↔ momo는 스택 표면(PG·Redis·S3·TS클라)만 1:1이고, 정합성·격리 코어는 정반대다.** momo 하드 불변식 6개 중 **3개가 buzz의 Nostr relay 코어와 정면 충돌**:

| momo 불변식 | buzz | 화해 |
|---|---|---|
| 단일 쓰기경로(서버-authored, 클라 직접 publish 금지) | **클라가 Schnorr 서명 이벤트를 직접 publish**(Nostr의 존재 이유) | ❌ 정반대 |
| gapless `message.seq`(PG sequence 금지) | 순서=`created_at`(클라 wall-clock)+event id, **gapless seq 부재** | ❌ 근본 충돌 |
| RLS FORCE + 역할분리 | **RLS 전무** — 격리=community-key 복합키+앱 ctx | ❌ DB 강제 부재 |

- 데이터 모델부터 다르다: momo `message`는 서버-authored·**무서명**이라 buzz `events`(content-hash id + 필수 Schnorr sig) 테이블에 **넣을 수조차 없다.**
- **정정**: buzz는 **secp256k1 Schnorr**(nostr crate), momo는 **Ed25519**. 이 ADR/재검토가 "buzz=Ed25519"라 적은 건 오류.
- buzz는 momo 고유(work_*·usage·credit·workstream)가 **전무** → 어느 방식이든 100% momo가 짠다. 그래서 fork 절감이 **실질 증발**한다 — 메신저 코어를 momo 불변식에 맞추려면 buzz 코어를 도려내야 하므로 "얹히는" 게 아니라 "도려내는" 관계.
- **결론**: A안(fork)으로는 momo 불변식 3개(쓰기경로·seq·RLS)를 상속 불가. 이를 지키려면 buzz를 **의존이 아니라 코드 레퍼런스**로만 써야 한다 = **B안(참조 재작성)**.

**→ 스파이크 권고: A안 → B안 후퇴. ADR을 "fork" 전제에서 "reference rewrite" 전제로 개정(성재 승인 필요).** B안에서도 서버=Rust/Axum·workd Rust 이식·지금 착수는 유지되고, momo 하드 불변식 3개를 그대로 보존한 채 buzz는 Axum+sqlx 골격·kind dispatch·git-over-http 등의 **패턴 레퍼런스**로만 쓴다.

---

### (아래는 fork 전제로 기안된 원안 — B안 승인 시 개정된다)

- 관련: ADR-0133(UI = Tauri/React — 이 결정의 클라이언트 짝), ADR-0004(자격증명 비유입·permissive 스택), ADR-0125/0136/0139/0140/0142/0144(T3 work runtime — **이식 대상**), ADR-0143(workstream — 이식 대상)
- 입력: `docs/planning/2026-07-30-server-stack-reassessment.md`(§0~§7, 리서치 근거)
- 발단: 성재 — "서버가 왜 굳이 Swift냐. buzz 기반 rust/tauri migration 때 데스크탑에만 집중해 생긴 잔재 같다."

## 결정

**momo 서버를 Swift/Hummingbird에서 buzz(block/buzz, Rust/Axum, Apache 2.0)를 fork한 기반 위의 Rust로 전환한다. 지금 최우선으로 착수한다.**

- **메신저 하부층은 buzz 재사용** — 채널·스레드·DM·서명 이벤트·relay·git 이벤트·에이전트=1급 member. momo가 참조한 원류가 buzz이고 이 층은 1:1 대응이다.
- **momo 고유는 Rust로 이식** — T3 work runtime(T1/T2/T3 통합 실행·샌드박스·과금 원장·수명주기 saga·재부착/replay·provider 어댑터/BYOC·Kata substrate) + workstream. buzz에 없는 momo의 진짜 차별점.
- **살아남는 것**: PostgreSQL(진실 저장 — 단 buzz 이벤트 모델과 스키마 대조 필요), Centrifugo/relay 계층, Tauri/React 클라이언트, workd 서명 계약(페이로드 UTF-8 바이트라 언어 독립).
- **이관 대상 규모**: 서버 42k + workd 6k + NotifierWorker 3k Swift ≈ 51k LOC. 59 마이그레이션은 스키마라 원칙적으로 재사용(buzz 모델과 화해 후).

## 근거 (요약 — 상세는 재검토 문서)

1. **Swift 서버 = 잔재 확정.** Swift-on-server의 존재 이유는 Apple 클라이언트와 코드 공유인데, 클라이언트가 Tauri(TS/Rust)로 옮기며 그 대상이 사라졌다. 시장 점유 0.06% 니치.
2. **참조 모델 buzz가 서버를 Rust/Axum으로 짰다.** buzz ↔ momo 스택이 1:1 대응(Rust/Axum·PG·Redis→Centrifugo·S3·TS+React 클라이언트)이고 momo만 서버를 Swift로 어긋냈다. 남이 같은 도메인(에이전트 네이티브 메신저·signed events·relay) 문제를 풀며 내린 답.
3. **성재 축(정합성·스케일·내구성)에서 Rust 유력.** momo의 실제 난제가 동시성/정합성(T3 재설계 3라운드)이고 Rust의 타입·소유권·동시성 안전이 여기 직접 기여. 정합성의 최종 강제는 이미 DB(44/59 마이그레이션이 트리거·advisory)라 이중 안전망.
4. **buzz가 Apache 2.0** → fork로 메신저 하부층 재작성을 회피, 절감 최대.
5. **지금이 가장 싸다** — momo 출시 전·사용자 0. T3/workstream 다섯 배치가 방금 끝나 마침 안정 지점.

## 이행 — **스파이크가 fork보다 먼저다**

**1. [필수 선행] buzz 대조 스파이크** — fork·재작성 착수 전 반드시. buzz 코드를 읽고 판정:
   - buzz의 **Nostr 이벤트 모델**과 momo 하드 불변식(PG=SoT·단일 쓰기경로 REST→PG→outbox→relay·RLS FORCE)을 어떻게 화해시키나. Nostr의 분산·자기주권과 momo의 중앙 control-plane(BYOC 결정)이 상충하는지, 아니면 buzz도 relay 중심이라 조정 가능한지.
   - buzz 스키마 ↔ momo 59 마이그레이션 대조 — 무엇이 겹치고 무엇이 momo 고유(work_*·usage·credit·workstream)인지.
   - buzz가 재사용할 층(채널·스레드·서명·relay)과 momo가 그 위에 얹을 층(T3·workstream)의 경계.
   - 산출: 이식 계획(무엇을 buzz에서 받고, 무엇을 버리고, momo 고유를 어디에 얹나) + fork 방식(upstream 추적 vs hard fork) 판정.
   - **스파이크 결과가 이 ADR의 세부를 확정한다. 스파이크 없이 fork 코드 착수 금지.**
2. 스파이크 승인 후: fork·이식 배치(메신저 코어 검증 → T3 이식 → workstream 이식 → 클라이언트 재배선).
3. workd(6k Swift)도 Rust로 — 서버와 도메인 crate 공유 가능(A안의 이득).
4. 병행: NCP T3 smoke는 서버 스택과 독립(workd 계약 언어 무관)이라 계속 진행 가능.

## Consequences

- (+) 참조 모델 buzz와 정합, 클라이언트-workd-서버 Rust 통일 가능, 정합성 타입 안전, relay 성능.
- (+) 메신저 하부층 재작성 회피(fork) — 절감 최대.
- (−) **Nostr 모델 수용**이 momo 불변식과 화해되는지가 최대 미확인 — 스파이크가 답한다. 안 되면 A안→B안(참조 재작성) 후퇴.
- (−) buzz 신제품(2026-07)의 성숙도·upstream diverge 리스크.
- (−) 기능 개발 수 주 정지(성재 수용 — 사용자 0인 지금이 가장 쌈).
- (−) T3/workstream 방금 투자를 이관 대상으로 — 단 로직·설계(ADR)는 언어 무관하게 살아남고, 재작성은 Swift→Rust 번역이다.

## 미해결 (스파이크가 답할 것)
- Nostr 모델 수용 가부. hard fork vs upstream 추적. 스키마 화해 범위. workd 동시 이관 여부. 이행 배치 분할.
