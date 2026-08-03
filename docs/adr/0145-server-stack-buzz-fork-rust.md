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
- (−) T3/workstream 방금 투자를 이관 대상으로 — 단 로직·설계(ADR)는 언어 무관하게 살아남고, 재작성은 Swift→Rust 번역이다.

## 이행 — 설계부터

**실행 정본 = `docs/planning/2026-07-30-server-rewrite-plan.md`.** Phase 0(설계) 6개 산출물(D1 타깃 아키텍처 · D2 불변식 보존 스펙 · D3 provenance 설계=ADR-0146 · D4 buzz 인용 카탈로그 · D5 커토버·parity 전략 · D6 이행 배치 분할)을 먼저 확정한 뒤 구현 배치(메신저 코어 → T3 → workstream → 클라 재배선 → workd Rust)에 착수한다. **설계 승인 없이 재작성 코드 착수 금지.**

## 미해결 (Phase 0 설계가 답할 것)
- 커토버 전략: 빅뱅 재작성 vs strangler(엔드포인트별 프록시 라우팅). 사용자 0·동일 DB라 빅뱅이 유력하나 D5에서 확정.
- crate 레이아웃(buzz의 서브시스템 격리 교훈 채택 범위), sqlx vs sea-orm.
- provenance 서명 대상 행동 범위·저장 위치·검증 경로(ADR-0146).
- workd 동시 이관 여부(서버와 도메인 crate 공유 이득 vs 범위 팽창).

---

# 부록 B — 와이어의 UUID 대소문자: 두 판단을 한자리에

> goal HYG-1(2026-08-03) 실측·기록. **코드 변경 없음 — 판단의 고정이다.**
> Swift→Rust 번역이 만든 같은 계열의 대소문자 문제 두 건을 한곳에 모은다.
> `JOURNAL.md:1528` 이 "Swift/Rust 메시지 id 대소문자"를 후속으로 남겼고, 이 부록이 그 자리다.

## B-0. 사실 관계 (실측)

Foundation 의 `UUID.uuidString` 은 **대문자**, Rust `uuid` crate 의 `Display`/`to_string()` 은
**소문자**다. 그래서 같은 DTO가 서버 구현에 따라 다른 문자열을 낸다.

| 값 | Swift 서버 | Rust 서버 |
|---|---|---|
| 메시지 `id`(REST 전송/이력) | **대문자** — `server/Sources/MomoServer/Routes/MessageRoutes.swift:336`·`:491` (`id: id.uuidString`) | **소문자** — `server-rust/bins/momo-server/src/routes/messages.rs:118` (`id: message.id.to_string()`) |
| 메시지 `id`(실시간 `message.new`) | **대문자** — `MessageRoutes.swift:2935` | **소문자** — `server-rust/crates/momo-messaging/src/message.rs:291` |
| 반응 DTO·스냅샷의 `messageId` | **대문자** — `MessageRoutes.swift:877`·`:930-931` | **대문자(의도적 재현)** — `server-rust/crates/momo-messaging/src/interaction.rs:361` (`.to_string().to_uppercase()`) |

DTO 필드 타입이 양쪽 다 `String`(`server/Sources/MomoServer/Routes/DTOs.swift:210`,
`server-rust/bins/momo-server/src/dto.rs:167`)이라 대소문자가 값 자체에 굳는다.

## B-1. 판단 ① 메시지 id 대소문자 — **고치지 않는다**

**살아 있는 결함이 아니다.** 소비자 셋이 각각 다른 이유로 면역이다.

- **웹**: `uuidEq` 로만 비교한다 — `packages/momo-core/src/lib/api.ts:214-218`, 주석이
  *"UUIDs cross the wire in mixed case by design; always compare this way."* 라고 못박아 뒀다.
  legacy 사본도 같다(`clients/web-legacy/src/api/client.ts:72-76`).
- **mac/iOS**: id 를 문자열로 들고 있지 않다. `Identifier<Tag>` 가 `UUID` 를 감싸고
  Codable 이 `UUID` 로 디코드한다(`clients/Core/Sources/MomoCore/Identifiers.swift:11`·`:31-34`,
  `Message.swift:13`). `UUID(uuidString:)` 은 대소문자 무관이다.
- **배포**: 지금 서빙하는 API 는 **하나뿐**이다. prod compose 의 `api` 는 단일 이미지
  슬롯이고(`infra/prod/docker-compose.prod.yml:143`) 커토버는 빅뱅으로 승인됐다
  (`docs/planning/2026-07-30-cutover-and-parity.md:1-8` — 이중운영은 계약 drift만 남는다고
  명시적으로 기각). 그래서 **한 배포 안에서는 항상 자기정합**이다.

**아무도 못 잡는 이유**: 드리프트 게이트의 UUID 정규식이
`scripts/openapi_shape_check.py:33-36` 에서 `[0-9a-fA-F]` 라 양쪽 다 통과한다(사용처 `:126`,
`format: uuid` 일 때만 동작). 스펙도 잡지 못한다 — `docs/api/openapi.yaml:7821-7827` 의
`Message.id` 는 `format: uuid` 일 뿐 `pattern:` 이 없고, `format: uuid`(RFC 4122)는 두 대소문자를
모두 허용한다. 스펙 전체에 id 대소문자를 강제하는 규칙은 없다.

**언제 문제가 되는가 — 두 조건**

1. **Swift·Rust 혼합 배포가 생기는 날.** 두 서버가 같은 DB 앞에 동시에 서면, 한쪽이 쓴
   id 문자열을 다른 쪽이 낸 것과 `===` 로 비교하는 코드가 깨진다. 지금은 compose 상 불가능하다.
2. **롤백.** 롤백 경로가 "Swift 태그 이미지로 교체"로 정의돼 있어
   (`docs/planning/2026-07-30-cutover-and-parity.md:8`·`:23`·`:26-27`) 같은 DB·같은 클라이언트에
   대해 **id 대소문자가 한 번에 뒤집힌다.** 문자열로 키를 잡아 **영속화**한 것(로컬 캐시·
   URL·저장된 상태)이 있으면 그 순간 어긋난다. 비교만 하는 코드는 `uuidEq` 덕에 무사하다.

**그래서 지금 할 일은 "고치기"가 아니라 "규칙을 알기"다.** 정렬을 하려면 소비자 전수(웹 83개
`uuidEq` 호출부 + 영속화 지점)를 함께 봐야 하고, 그건 검수 직전에 열 작업이 아니다.

**주의 — 웹의 안전판은 구조가 아니라 규율이다.** 웹은 다른 타입은 ingest 시점에 접어
정규화하지만(`packages/momo-core/src/lib/api.ts:853`·`895-898`·`1352-1354`·`1874-1880`·`1921-1943`)
**`Message` 는 접지 않는다**(`:135-163` — `id: string` 그대로). 즉 부담이 호출부마다의
`uuidEq` 규율에 걸려 있다. 한 곳이라도 `===` 를 쓰면 그 자리에서 깨진다. 정렬을 하기로 한다면
**웹 ingest 정규화가 서버 정렬보다 싸고 안전한 후보**다(한 곳, 클라 단독, 롤백에도 견딤).

## B-2. 판단 ② 반응 DTO 대문자 id — **현행 재현 유지**(단 근거 정정)

Rust 는 반응 경로에서만 일부러 대문자로 되돌린다
(`interaction.rs:361` `message_id_wire`, 스냅샷은 `:711`·`:715`). 판단 자체는 유지한다 —
mac 클라가 `UUID` 로 파싱하고 웹은 `reactions.ts:63-65` 의 `fold()` 로 접으므로 바꿀 이득이 없고,
바꾸면 Swift 시절 계약과 또 한 번 어긋난다.

**다만 그 판단에 적힌 근거 두 가지를 정정한다.**

1. **"반응만 `uuidString` 이고 나머지 메시지 id 는 전부 소문자"는 사실이 아니다.**
   `interaction.rs:352-354` 와 `dto.rs:219-220` 이 그렇게 적었지만, 그건 **Rust 서버 기준**에서만
   참이다. **Swift 서버에서는 메시지 `id` 도 대문자였다**(`MessageRoutes.swift:336`·`:491`·`:2935`
   — 메시지 id 경로에 `::text` 캐스트는 없다). 즉 반응은 "예외적으로 대문자"였던 게 아니라
   **Swift 전체가 대문자였고 Rust 가 반응만 그대로 뒀다**. 재현 결정 자체는 여전히 옳지만
   근거 문장은 틀렸다 — B-0 표가 정정본이다.
2. **`openapi.yaml` 이 이 계약을 비준하지 않았다.** `ReactionSnapshot`
   (`docs/api/openapi.yaml:7749-7758`)에서 메시지 id 는 중첩 `additionalProperties` 의 **맵 키**이고,
   OpenAPI 3.0 은 맵 키에 `format`·`pattern` 을 걸 수 없다. `format: uuid` 가 붙은 유일한 잎은
   **멤버 id 배열 원소**(`:7757-7758`)다. 스펙은 대문자를 **요구하지도 금지하지도 않으며 침묵한다.**
   따라서 "스펙이 비준했으니 유지"가 아니라 **"클라이언트 실동작이 이미 그 모양에 맞춰져 있으니 유지"**
   가 옳은 근거다.

## B-3. 이 판단들이 깨지는 조건 (다음 사람이 볼 것)

- Swift·Rust **동시 서빙**이 생기거나, 롤백으로 대소문자가 뒤집히는데 **문자열 id 를 영속화**한
  소비자가 있을 때 → B-1 을 다시 연다.
- 웹에서 메시지 id 를 `uuidEq` 없이 `===`/`Map` 키로 비교하는 코드가 들어올 때 → 그 자리에서 깨진다.
  `packages/momo-core/src/lib/api.ts:214` 의 주석이 유일한 방어선이다.
- 반응 경로에서 `to_uppercase()` 를 지우면 mac 은 무사하지만 **문자열로 키를 잡는 소비자**가
  스냅샷과 델타 사이에서 어긋난다 — 지우려면 `reactions.ts` 의 `fold()` 와 함께 지워야 한다.

**드리프트 게이트는 이 계열을 영원히 못 잡는다**(B-1 의 정규식). 대소문자를 계약으로 만들려면
`openapi.yaml` 에 `pattern:` 을 넣고 `openapi_shape_check.py` 를 대소문자 구분으로 바꿔야 하는데,
그건 별건 결정이다 — 여기서는 **"게이트가 못 잡는다는 사실"만 기록**한다.
