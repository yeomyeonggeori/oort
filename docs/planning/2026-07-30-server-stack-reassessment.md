# 서버 스택 재검토 — Swift가 잔재인가 (2026-07-30, Fable)

- 발단: 성재 — "서버 언어가 왜 굳이 swift야? Swift를 벗어난 순간부터 서버가 Swift에 국한될 필요가 없어지잖아. buzz 기반 rust/tauri migration 때 **데스크탑 앱 쪽에 중점을 둬서 생긴 잔재** 같아. Tauri를 썼을 때 서버 옵션과 best choice를 리서치."
- 성격: **P0 방향 결정** — 지금 잘못 잡으면 나중에 대규모 재작업. ADR 기안 후보. 이 문서는 리서치 종합 + 권고이지 결정이 아니다.

## 0. 먼저 오해 하나를 푼다 — Tauri는 서버와 직교한다

"Tauri를 썼을 때 서버 옵션"이라는 물음에는 숨은 전제가 있는데, **Tauri는 서버 언어를 강제하지 않는다.** Tauri의 Rust는 **데스크탑 셸 내부**(창·파일시스템·네이티브 API 브리지)용이고, momo의 "서버"는 그와 별개인 **원격 API 서버**(PG·relay·워커)다. 클라이언트 앱은 HTTP/WS로 어떤 백엔드든 부른다.

→ 그러니 진짜 질문은 "Tauri니까 서버가 뭐여야 하나"가 아니라 **"클라이언트 스택이 TS+React+Rust(Tauri)로 이미 정해졌는데, 서버를 지금 다시 고른다면 무엇이 best인가"**이다. 성재의 직관은 이 재정의에서 더 선명해진다.

## 1. 성재 진단이 맞다 — Swift-on-server는 잔재다

리서치가 성재의 "잔재" 판단을 뒷받침한다:

- **Swift 서버는 니치다** — 서버 언어 시장 점유 **0.06%**([w3techs](https://w3techs.com/technologies/report/programming_language) 계열). 프로덕션 성숙도는 있지만(Hummingbird·TelemetryDeck 사례) 채용·라이브러리·레퍼런스가 좁다.
- **Swift 서버의 주 존재 이유가 momo에서 사라졌다** — 리서치 결론이 명확하다: *"Swift's strength lies in enabling developers from the Apple ecosystem to build backends while sharing code with iOS/macOS applications"*([swift.org](https://www.swift.org/blog/swift-on-the-server-ecosystem/), [state of swift 2026](https://devnewsletter.com/p/state-of-swift-2026/)). 즉 Swift 서버는 **iOS/macOS 클라이언트와 Swift 코드를 공유**하려는 팀의 선택이다. momo가 클라이언트를 Tauri(TS/Rust)로 옮긴 순간 그 공유 대상이 없어졌다 — **바로 buzz→rust/tauri migration이 데스크탑에만 집중해 서버를 안 건드린 결과.** 성재 진단 그대로다.
- 남은 것은 42,050 LOC 서버 + workd 6,100 + NotifierWorker 2,758 = **약 51k LOC의 Swift 자산**과, 그것이 붙는 아무 클라이언트도 없는 언어 선택.

**결론: Swift 서버는 이제 "선택된 것"이 아니라 "안 바꾼 것"이다.** 이 진단은 확정이다. 남은 것은 "그래서 무엇으로, 언제, 어느 비용에"이다.

## 2. 후보 3종 — momo 특성에 대조

**momo 서버의 실제 성격이 선택을 좁힌다.** 하드 불변식이 Postgres=SoT · Centrifugo=전송전용 · 단일 쓰기경로(REST→PG→outbox→relay) · RLS FORCE다. 즉 **서버는 무거운 계산 엔진이 아니라 얇은 오케스트레이션+검증 레이어**다 — 진짜 일은 Postgres가 한다. 이 사실이 "성능이 최우선"이라는 축을 약하게 만들고 **"타입 공유·생산성"** 축을 최우선으로 올린다.

| 후보 | 클라이언트와의 시너지 | momo 적합성 | 재작성 난이도 | 약점 |
|---|---|---|---|---|
| **TypeScript** (Hono + 얇은 레이어) | **최상** — 클라이언트가 이미 TS/React. tRPC/공유 zod로 **codegen 0의 end-to-end 타입 안전** | **최적** — 얇은 오케스트레이션에 TS 성능 충분(PG가 무거운 일). 팀이 이미 TS를 씀 | 중 | 런타임 타입 안전이 Rust보다 약함(zod로 경계 방어) |
| **Rust** (Axum + Tokio) | 상 — Tauri 셸이 Rust. **도메인 crate·workd를 한 언어로 통일** 가능. 성능·메모리 안전 최상 | 좋음 — 단 서버가 얇아 성능 우위가 momo에선 덜 결정적 | **최상(가장 어려움)** — 러닝커브·개발속도 | 재작성 비용 최대, 반복 속도 느림 |
| **Go** (Gin/Fiber) | 하 — 클라이언트와 언어 공유 없음 → **타입 공유 이점 0** | 무난 — 배포 단순(단일 바이너리)·채용 쉬움·동시성 | 낮음(가장 쉬움) | Swift를 벗어나는 주 이유(생태계) 외엔 momo가 얻는 게 적음 |

**핵심 판정**: momo가 실제로 겪은 문제가 이 선택을 가른다 — **#913/#919가 openapi 스펙 드리프트였다**(web-legacy 생성 타입이 스펙과 64 vs 101로 어긋나 게이트가 상시 red). tRPC 계열의 존재 이유가 정확히 그 드리프트다: *"No more runtime surprises when a backend developer renames a field that a frontend developer depends on … the frontend will show a red squiggly line immediately"*([leapcell](https://leapcell.io/blog/achieving-end-to-end-type-safety-in-full-stack-typescript-with-trpc)). momo는 그 문제를 게이트로 막고 있는데, **TS 서버면 그 문제가 컴파일 타임에 사라진다.**

## 3. 권고

**재작성한다면 TypeScript(Hono + 얇은 레이어 + PG 직결)가 momo의 best fit이다.**
- ①클라이언트가 이미 TS → 계약 공유로 드리프트가 **구조적으로 불가능**해진다(momo가 실측한 문제).
- ②서버가 얇은 오케스트레이션이라 TS 성능으로 충분 — 진짜 일은 PG가 하고, 서버는 검증·라우팅·outbox 기록이다.
- ③팀 생산성·채용·라이브러리 전부 Swift 대비 크게 넓음.
- ④permissive 스택 원칙(AGPL 백본 금지, ADR-0004 결)은 TS 생태계로 그대로 만족.

**Rust는 "클라이언트 셸도 workd도 서버도 전부 Rust로 통일"이 목표라면** 유일한 대안이다 — 그 경우 도메인 로직을 한 crate로 공유하는 그림이 나온다. 그러나 재작성 비용이 최대이고, momo 서버가 얇아서 Rust의 성능 우위를 다 못 쓴다. **Go는 momo엔 애매** — 타입 공유가 없어 Swift를 벗어나는 이득의 절반을 못 얻는다.

## 4. 냉정한 비용과 타이밍 — 이게 진짜 결정이다

권고만큼 중요한 것이 **"지금 하느냐"**다.

- **재작성 규모**: 서버 42k + workd 6k + NotifierWorker 3k ≈ **51k LOC**. 59 마이그레이션(스키마는 언어 무관하게 재사용 가능 — 이건 살아남는다), 359 서버 테스트, T3 수명주기 재설계 전부. 순수 재작성만 **수 주~수 개월**, 그동안 기능 개발 정지.
- **지금이 가장 싼 시점이다** — momo는 **아직 출시 전**(`legal/privacy-policy.md` 빈칸이 공개 런칭을 막고 있음, 사용자 0). 코드가 지금보다 작아질 일은 없다. "나중에"는 항상 더 비싸다.
- **그러나 방금 큰 투자를 했다** — T3 재설계(ADR-0140, 배치 1~2)·workstream(ADR-0143, 배치 3~5)이 전부 서버 로직에 있다. 이 방향 결정을 **T3 실 provider(ADR-0144)와 workstream이 안정되기 전에** 하면 그 투자를 두 번 옮긴다.
- **부분 이관도 가능** — 전면 재작성이 아니라 **신규 표면부터 TS로 짓고(strangler fig), 기존 Swift 서버는 얇아질 때까지 병행**하는 길도 있다. 단 두 스택 병행은 운영·계약 이중화 비용.

## 5. 성재가 결정해야 할 것

이 문서는 리서치·권고까지다. **결정은 성재 몫이고, 세 갈래다:**

1. **지금 방향만 확정하고(=TS로 간다), 이관은 T3/workstream 안정 후 착수** — 권고. 방향을 못박되 진행 중 투자를 안 흔든다. ADR로 "서버 스택 = TS, 이관은 strangler fig, 시점은 출시 전 마지막 창"을 기록.
2. **전면 재작성을 지금 최우선으로** — 사용자 0인 지금이 가장 싸다는 논리. 단 기능 개발 수 주 정지.
3. **Swift 유지** — 재작성 비용 > 이득 판단. 단 그러면 "Swift는 잔재"라는 진단과 공존할 근거(예: 곧 출시라 리스크 회피)가 필요.

추가로 답이 필요한 것: **workd(Swift 6k)도 함께 옮기나?** workd는 T1/T2/T3에서 도는 데몬이고 서버와 서명 계약만 공유한다(페이로드는 UTF-8 바이트라 언어 독립). 서버만 TS로 가고 workd는 Swift로 남겨도 되지만, Rust 통일 시나리오에서는 workd도 후보다.

## 리서치 근거 (2026-07-30)
- Tauri 아키텍처(Rust 셸은 데스크탑 내부용, 서버와 직교): https://v2.tauri.app/concept/architecture/
- Swift 서버 생태계 성숙도·니치(0.06%)·Apple 코드공유가 주 이유: https://www.swift.org/blog/swift-on-the-server-ecosystem/ · https://devnewsletter.com/p/state-of-swift-2026/ · https://w3techs.com/technologies/report/programming_language
- Go vs Rust vs Swift 서버 포지셔닝: https://cyberdefence.org.in/blog/go-rust-swift-comparison/ · https://levelupgo.dev/blog/go-vs-rust-2026-honest-backend-comparison
- tRPC/end-to-end 타입 안전이 드리프트를 컴파일 타임에 잡음: https://leapcell.io/blog/achieving-end-to-end-type-safety-in-full-stack-typescript-with-trpc · https://www.pkgpulse.com/guides/hono-rpc-vs-trpc-vs-ts-rest-type-safe-api-clients-2026
- 백엔드 프레임워크 2026 성능·실시간 비교(Axum/Hono/Phoenix): https://www.index.dev/blog/best-backend-frameworks-ranked

---

# 개정 (2026-07-30, 성재 반문 3건) — 첫 권고를 재고한다

성재 반문: ①서버가 얇은 이유가 뭐냐, 불필요해서냐 ②buzz는 어떻게 하고 있냐 ③언어 편의(TS)가 아니라 **내구성·안정성·정합성·스케일·효율**로 판단하라, Hono 고른 근거도 모르겠다. — **세 질문 다 내 첫 분석의 약한 곳을 정확히 짚었다. 정정한다.**

## 6-1. "얇다"는 부정확했다 — 정합성을 DB로 밀어넣은 것이다

실측: 라우트 34k LOC(MessageRoutes 2976·WorkSessionRoutes 2676·AgentGateway 2405…), lock/트랜잭션 27파일, 서명검증 6파일, outbox 18파일, **59개 중 44개 마이그레이션이 DB 레벨 강제(트리거·CHECK·GENERATED·advisory)를 포함**. 이건 얇지 않다.

내가 "얇다"고 한 뜻은 "PG=SoT라 서버가 비즈니스 상태를 메모리에 안 들고 DB가 소유한다"였는데, 그게 "하는 일이 적다/불필요하다"로 읽힐 수 있었다. **정확히는: 정합성의 최종 수호자를 DB로 밀어넣은 아키텍처다.** ADR-0140의 교훈이 그대로다 — "코드 규약은 매 라운드 깨지고, DB 제약(트리거·부분 unique·advisory)은 세 라운드 내내 살았다". 불필요해서가 아니라 **의도적 설계**이고, 이건 다음 항의 buzz 모델을 번역한 결과다.

**이 사실이 언어 선택을 바꾼다**: 정합성이 DB로 강제되므로, 서버 언어의 타입 시스템이 "데이터 정합성"에 기여하는 몫은 제한적이다(진실은 PG가 지킨다). 하지만 **오케스트레이션의 동시성 안전**(잠금 순서·race — T3 재설계 3라운드의 실제 난제)은 여전히 서버 코드의 몫이고, 여기서 언어의 동시성/타입 모델이 실제로 중요하다.

## 6-2. buzz 실측 — momo의 원류이고, 서버가 Rust다

buzz = **Jack Dorsey/Block이 2026-07-21 출시**한 Slack+GitHub 대체, AI 에이전트를 1급 시민으로([techcrunch](https://techcrunch.com/2026/07/21/jack-dorsey-is-taking-on-slack-with-buzz-a-group-chat-platform-for-teams-and-their-ai-agents/)). 스택 실측([github.com/block/buzz](https://github.com/block/buzz), [self-host 가이드](https://miget.com/blog/how-to-self-host-buzz)):

> **Nostr relay written in Rust, built on Axum, speaking WebSocket and REST, backed by PostgreSQL (events + full-text search), Redis for pub/sub, S3/MinIO for object storage. TypeScript + React clients. Apache 2.0.**

**momo와 거의 1:1 대응이다:**

| 축 | buzz | momo |
|---|---|---|
| 서버 | **Rust / Axum** | **Swift / Hummingbird** ← 유일하게 어긋난 자리 |
| 진실 저장 | PostgreSQL(signed events) | PostgreSQL(SoT) |
| pub/sub·relay | Redis | Centrifugo |
| 객체 저장 | S3/MinIO | Drive/S3(ADR-0127) |
| 신원 | 사람·봇 암호화 키(Ed25519) | member.kind=agent + Ed25519 서명 |
| 모델 | signed event 로그 | 단일 쓰기경로 REST→PG→outbox→relay |
| 클라이언트 | TS + React | TS + React + Tauri |

→ **성재 진단이 완전히 맞다.** momo는 buzz를 참조해 자체 구축했는데, **buzz 자신이 서버를 Rust/Axum으로 짰고 momo만 Swift로 했다.** 이게 "잔재"의 정확한 정체다 — buzz→momo 이식 때 데스크탑(Tauri)만 옮기고 서버 언어는 원본(Rust)도, 이식본(Swift)도 아닌 어중간한 곳에 남았다.

## 6-3. 판단축을 성재 기준으로 재정렬 → Rust/Axum이 유력하다

언어 편의(TS) 빼고 **내구성·안정성·정합성·스케일·효율**로만 재평가:

| 축 | Rust/Axum | TS/Encore | Go | 판정 근거 |
|---|---|---|---|---|
| **정합성** | 최상 — 오케스트레이션 race(T3 난제)를 타입·소유권으로 컴파일 타임에. DB 강제와 이중 안전망 | 중 — 런타임 zod 경계, 단일 스레드라 일부 race 회피 | 중 | momo의 실제 버그가 동시성/잠금(ADR-0140) |
| **스케일/효율** | 최상 — buzz가 relay를 Rust로 택한 이유 | 상 — 무상태라 수평 확장 쉬움(PG=SoT) | 상 | Centrifugo가 실시간 흡수, 서버는 REST 처리 |
| **내구성/안정성** | 최상 — 메모리 안전, Axum/Tokio/sqlx 성숙 | 상 — Node 성숙 | 상 | 셋 다 프로덕션 성숙(Swift만 니치) |
| **참조 모델 정합** | **최상 — buzz와 동일 스택** | 하 — 서버만 갈라짐 | 하 | buzz가 오픈소스라 상호참조·재사용 여지 |
| **타입 공유(드리프트)** | 상 — ts-rs codegen(#919 문제 완화) | 최상 — tRPC codegen 0 | 하 | momo 실측 문제(#913/#919) |
| **workd 통일** | 가능 — 서버+workd 한 crate 도메인 공유 | 불가(workd는 시스템 데몬) | 불가 | workd 6k Swift도 이관 대상 |
| **개발 속도·채용** | 하 — 러닝커브 | 최상 | 상 | 성재가 부차로 둠 |

**정합성·스케일·참조모델 축에서 Rust/Axum이 앞선다.** 내 첫 TS 권고는 "개발속도·타입공유"에 가중치를 뒀는데, 성재가 그 가중치를 명시적으로 낮췄다. 그리고 **buzz가 이미 이 도메인(에이전트 네이티브 메신저 + signed events + relay)에서 Rust/Axum을 택했다**는 것이 결정적 증거다 — 남이 같은 문제를 풀며 내린 답이다.

## 6-4. Hono 권고 철회 — 성재 직관이 맞다

첫 문서의 "TS + Hono"에서 Hono는 틀렸다. Hono는 **엣지 런타임·경량용**이고 DB 불가지론이라, momo의 강한 정합성·트랜잭션·분산 백엔드에 부적합하다([hono vs encore](https://encore.dev/articles/hono-vs-encore): *"Hono is less suited for traditional distributed backend systems requiring strong consistency guarantees"*). **TS로 간다면 momo 특성엔 Encore.ts**가 맞다 — PG 통합·마이그레이션·트랜잭션 롤백·분산 트레이싱·타입 안전 서비스 통신이 내장이고 "traditional backend with databases"를 겨냥한다. NestJS는 구조는 좋으나 인프라(ORM·트랜잭션)를 직접 배선. 하지만 §6-3 기준에선 TS 자체가 Rust에 밀린다.

## 6-5. buzz 오픈소스가 여는 제3의 선택지

buzz가 **Apache 2.0**이라, "Swift를 무엇으로 재작성하나"가 아니라 **"buzz(Rust) 코어를 재사용/참조하고 그 위에 momo 고유(T3 work runtime·workstream)를 얹나"**라는 선택지가 생긴다. 메신저 코어(채널·스레드·서명·relay·git)는 buzz와 거의 같으므로 재사용 여지가 크고, momo 차별점(원격 T3 실행·과금·workstream)만 우리 것으로 남는다. **이 경우 재작성이 아니라 "기반 교체 + 고유 로직 이식"이라 비용이 급감할 수 있다.** 단 buzz 신제품(2026-07)의 성숙도·라이선스 상호작용·momo 불변식과의 정확한 일치는 별도 검증이 필요하다.

## 6-6. 갱신된 권고

**§6-3 기준(정합성·스케일·내구성·참조모델)으로는 Rust/Axum이 momo best fit이다.** 근거: ①momo의 실제 난제가 동시성/정합성(T3)이고 Rust가 여기 직접 기여 ②참조 모델 buzz가 같은 도메인에서 Rust/Axum을 택함 ③workd까지 Rust 통일 시 도메인 공유 ④relay 성능. TS(Encore.ts)는 개발속도·타입공유를 최우선할 때의 대안이나, 성재가 그 축을 낮췄다.

**그리고 성재가 먼저 판단해야 할 새 질문**: buzz가 오픈소스이므로 — momo를 계속 자체구축하나, 아니면 **buzz 코어를 기반으로 삼고 momo 고유만 얹나**? 이 결정이 "재작성 언어"보다 상위 결정이다. 여기 따라 이관 규모가 10배 차이 난다.

## 리서치 근거 (개정, 2026-07-30)
- buzz 정체·아키텍처: https://techcrunch.com/2026/07/21/jack-dorsey-is-taking-on-slack-with-buzz-a-group-chat-platform-for-teams-and-their-ai-agents/ · https://github.com/block/buzz · https://miget.com/blog/how-to-self-host-buzz · https://quasa.io/media/buzz-by-block-how-the-nostr-based-ai-workspace-works-for-beginners
- Encore.ts가 강정합성 DB 백엔드에 적합, Hono는 엣지·경량: https://encore.dev/articles/hono-vs-encore · https://encore.dev/articles/nestjs-vs-encore

---

# 7. buzz 기반으로 간다면 — 진행 판단 (성재 요청)

## 7-1. 먼저 나눠야 할 것: momo에서 buzz가 대체할 수 있는 것 vs 없는 것

| 계층 | buzz가 이미 가진 것 | momo 고유(buzz엔 없음) |
|---|---|---|
| **메신저 코어** | 채널·스레드·DM·리액션·서명 이벤트·relay·git 이벤트·에이전트=1급 member | (없음 — 이 층은 buzz와 거의 동일) |
| **동의/권한** | 서명 신원·감사 로그 | 플러그인 동의 모달·scope grant·capability 투영(#839 계열) |
| **T3 work runtime** | **없음** | **momo의 진짜 차별점** — T1/T2/T3 통합 실행(ADR-0125), 원격 샌드박스·과금 원장·수명주기 saga(ADR-0136/0140), idle 재부착·replay(ADR-0139), provider 어댑터·BYOC(ADR-0142), Kata substrate(ADR-0144) |
| **workstream** | git events까지만 | 목표 계층·actor-independent 인계(ADR-0143) |

**핵심**: buzz는 "메신저 코어"를 대체하고, **momo가 방금 다섯 배치에 쏟은 T3 work runtime·workstream은 buzz에 없다.** 즉 buzz 기반으로 가도 momo 고유 로직은 여전히 우리가 짠다 — buzz가 없애주는 것은 메시지·채널·서명·relay 같은 하부 공통층이다.

## 7-2. 넘어야 할 두 벽

1. **프로토콜 차이**: buzz는 **Nostr**(분산·자기주권·signed events)다. momo는 **자체 REST + 단일 쓰기경로 + RLS FORCE**(중앙 control plane)다. buzz relay를 self-host하면 실질적으론 중앙 서버로 쓰지만, Nostr 이벤트 모델을 momo의 outbox·RLS 불변식과 어떻게 화해시킬지가 첫 검증 과제다. (momo의 BYOC control-plane 결정과 Nostr의 분산성은 표면상 상충 — 실제로는 buzz도 relay 중심이라 조정 가능해 보이나 확인 필요.)
2. **성숙도·나이**: buzz는 2026-07 출시 신제품이다. momo는 그보다 성숙한 자체 코드가 있다. buzz를 기반에 깔면 momo가 남의 초기 코드베이스 위에 서게 된다 — upstream 파손 리스크.

## 7-3. buzz 관계 3방식

| 방식 | 설명 | 재작성 절감 | 리스크 |
|---|---|---|---|
| **A. Fork + 고유 이식** | buzz를 fork, 메신저 코어는 그대로, T3·workstream을 Rust로 얹음 | **최대** | upstream diverge·유지보수, Nostr 모델 수용 |
| **B. 참조 재작성** | buzz 코드를 참고만, momo는 자체구축 유지하되 서버를 Rust/Axum으로 재작성 | 중 | 재작성 비용 여전(단 buzz 코드가 레퍼런스라 빠름) |
| **C. Upstream 확장** | buzz를 upstream 의존으로 두고 momo 고유를 모듈/플러그인으로 | 최대(코어 유지보수 위임) | 고유 로직이 buzz 아키텍처에 종속, buzz 로드맵에 인질 |

## 7-4. 나의 종합 판단

- **가장 값진 자산(T3 work runtime)은 어느 방식이든 우리가 짠다** — buzz 기반의 이득은 "메신저 하부층 재작성 회피"에 한정된다. 그 층은 momo에서 이미 상당히 안정적이라(메시지·채널·서명은 초기부터 랜딩), 절감 폭이 처음 인상보다 작을 수 있다.
- **B(참조 재작성)가 리스크·정체성 균형이 가장 낫다** — buzz를 레퍼런스로 삼아 Rust/Axum 재작성 속도를 올리되, momo가 남의 초기 코드에 종속되지 않는다. Nostr 프로토콜을 강제로 받지 않아도 된다.
- **A(fork)는 "buzz의 Nostr 모델을 momo 정체성으로 받아들일 수 있다"가 확인될 때만** — 그게 되면 절감이 극대. 이건 별도 스파이크(buzz 코드를 읽고 momo 불변식과 대조)가 선행돼야 하는 판단이다.
- **C(upstream 확장)는 권하지 않음** — momo의 차별점(T3)이 buzz 로드맵에 인질이 된다.

## 7-5. 이 결정이 여는/닫는 것

- T3 실 provider(ADR-0144 PoC), NCP smoke는 **서버 스택과 독립** — workd·provider 어댑터 계약은 언어 무관(서명 페이로드는 UTF-8 바이트). 그러니 서버 스택 결정을 기다리지 않고 smoke는 진행 가능하다.
- 단 **서버 재작성을 할 거면 그 전에 T3/workstream 로직이 안정돼야** 두 번 옮기지 않는다 — 지금 다섯 배치가 방금 끝나 마침 안정 지점에 가깝다.
