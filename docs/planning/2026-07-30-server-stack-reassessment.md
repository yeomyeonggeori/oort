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
