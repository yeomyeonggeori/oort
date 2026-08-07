# RN 채택 실전 조사 — oort 모바일 (iOS+Android)

- 작성: 2026-07-26, Fable (리서치 세션)
- **전제: 성재가 2026-07-26 React Native로 결정.** 스택 비교 근거는 `2026-07-26-mobile-stack-research.md`(본 문서의 선행 문서)에 남아 있다. 본 문서는 **"어떻게 만들 것인가"** 만 다룬다.
- 출처 등급: `[SOURCE]` 소스 직독 · `[OFFICIAL]` 벤더 공식 · `[SECONDARY]` 2차 · `[미확인]`
- 방법론 한계: 세션 WebSearch 예산 소진 상태에서 수행 — 근거는 **레포 직독 · GitHub API · npm 레지스트리 · 알려진 URL WebFetch**로 확보했다.
- **절 번호는 팀리드 요청 항목 번호를 그대로 따른다**(1=Mattermost 해부, 2=Expo vs bare, 3=자산 경계, 4=네이티브 능력, 5=LiveKit, 6=마이그레이션 전략, 7=착수 제안). **읽는 순서는 §0 → §3 → §1 → §2 → §4~7** — §3(자산 경계)이 작업 계획의 뼈대라 앞에 두었다.

---

## 요약 (결론 먼저)

1. **재사용 경계가 실측으로 확정됐다**: 로직 **11,444 LOC + 테스트 7,728 LOC가 넘어가고**, UI는 다시 쓴다. 다만 **v0 UI는 13,346이 아니라 ≈4,600 LOC 상당**(ADR-0123 v0 스코프 기준). 넘어가는 쪽이 어려운 쪽(계약·순서·승인·쿼터)이고 다시 쓰는 쪽이 기계적인 쪽이다(§3).
2. **게이트 2개가 열렸다**: ①**centrifuge-js는 React Native를 공식 지원**한다(npm description 명시) → 실시간 층 유지 확정 ②**Expo config plugin으로 iOS NSE 주입 가능**(OneSignal 플러그인이 실증) — 단 범용 플러그인은 ★3 수준(§4.1, §2.1).
3. **기존 Swift 자산 중 391 LOC가 살아남는다** — NSE(62) + `MomoiOSPushKit`(329, `Foundation`·`Security`만 import). **RN 전환의 가장 어려운 지점을 이미 작성해둔 코드로 시작**한다. fastlane/match/CI도 그대로(§3.9).
4. **Expo 권고 = "완전 Expo" 아님**: Mattermost처럼 **bare RN + Expo 모듈 낱개, EAS 미도입**. oort는 이미 fastlane+match+`release-ios.yml`을 갖고 있어 EAS로 갈아탈 이유가 없다(§2.2).
5. **brownfield 아니라 재작성**: Android가 0이라 brownfield는 iOS에만 걸려 **비대칭 하이브리드**(=Airbnb의 "세 번째 플랫폼")를 만든다. 그리고 brownfield 성공 사례가 **전부 전담 인력을 둔 대기업**이다(§6).
6. **"FlashList 쓰면 된다"는 틀렸다** — Mattermost의 채팅 타임라인은 `FlatList`이고, `inverted`+`maintainVisibleContentPosition`를 위해 **RN 자체의 Fabric ObjC++를 패치**했다. 타임라인 리스크를 별도 계상할 것(§1.6).
7. **LiveKit RN은 v0 게이트가 아니다**(ADR-0123이 음성을 v0 제외). v1에서는 CallKit이 3개월 된 포크에 의존하므로, **기존 `IOSHuddleLiveKitSession.swift`를 얇은 네이티브 모듈로 노출하는 편이 안전**(§5).
8. **남은 최대 리스크는 여전히 한글 IME** — 선행문서에서 확인한 iOS Fabric 결함. 실기기 스파이크 1번 항목(§7.1).

---

## 0. 선행 문서의 열린 질문 하나가 닫혔다 — 실행 위치 `[SOURCE]`

선행 문서 §6.4-5에서 "oort 에이전트 작업이 모든 기기를 꺼도 계속되는가"를 **엔진 트랙 질의 사항**으로 남겼다. ADR 정본을 읽어 확인한 결과 **이미 답이 있다**:

| 호스트 타입(ADR-0125 D1) | 실행 위치 | 폰·맥 다 꺼도 계속되나 |
|---|---|---|
| `type=app` (내 맥) | ADR-0114 v0 — **세션 수명 = 맥 앱 수명** | ❌ (Codex Remote·Claude Remote Control과 같은 등급) |
| `type=workd` (팀 VPS 데몬) | launchd/systemd 상주, outbound-only 다이얼 | ✅ |
| `type=cloud` (oort Cloud) | E2B 샌드박스 (ADR-0125 D3, 파일럿 완료) | ✅ |

그리고 ADR-0125 D6은 **승인 카드에 호스트 선택기**(내 맥 온라인 / 팀 VPS / oort Cloud)를 이미 설계해 뒀다.

> **모바일 UX 요구사항이 여기서 도출된다: 작업 세션 행은 "어느 호스트에서 도는지"를 반드시 표시해야 한다.** 그게 "폰 닫아도 계속됩니다"를 말할 수 있는지를 결정하기 때문이다. 선행 문서 §5.2 패턴 1(레퍼런스 제품들이 정확히 이 지점에서 갈림)이 oort 안에서 그대로 재현된다 — 다만 oort는 **한 앱 안에 두 등급이 공존**하므로, 구분 표시가 레퍼런스보다 더 중요하다.

---

## 3. 우리 자산 재사용 경계 (실측 — 작업 계획의 뼈대)

> 팀리드 요청 3번. `clients/web/src` 전 파일(120개·33,293 LOC)을 **import 그래프와 DOM 결합도로 기계 분류**했다. 분류 기준: `document`/`window`/`localStorage`/`navigator`는 비이식, `fetch`/`AbortSignal`은 RN에도 있으므로 이식 가능.

### 3.1 총량

| 구분 | LOC | 파일 | 처분 |
|---|---:|---:|---|
| **A. 그대로 이식** | **7,516** | 23 | 순수 TS 모델·파서·API 클라이언트. 수정 0에 가깝다 |
| **B. 얇은 어댑터 필요** | **2,108** | 8 | 저장소·실시간·앵커링만 플랫폼 교체 |
| **C. 훅 (react-query와 함께 이식)** | **1,820** | 7 | TanStack Query v5는 RN 1급 지원 — 로직 그대로, 배선만 추가(§3.4a) |
| **D. 폐기/대체** | 735 | 4 | Tauri 브리지·updater·Tailwind `cn` |
| **E. 테스트 (A·B·C를 따라감)** | **7,728** | 24 | **이식의 안전망. 같이 옮긴다** |
| **F. UI 전량 재작성** | 13,346 | 51 | `.tsx` 전부 (React DOM + Tailwind + Radix) |

> **요약: 로직 11,444 LOC(A+B+C)가 넘어가고, 테스트 7,728 LOC가 그 이식을 검증하며, UI 13,346 LOC를 다시 쓴다.**
> 코드 기준으로 **약 3분의 1이 재사용**되지만, 재사용되는 쪽이 **어렵고 이미 검증된 쪽**(계약·순서·승인·쿼터 규칙)이고 다시 쓰는 쪽은 **기계적인 쪽**이다.

### 3.2 A군 — 그대로 이식 (7,516 LOC / 23 파일) `[SOURCE]`

DOM 참조 0, React 참조 0. 대부분 옆에 `.test.ts`가 있다.

| 파일 | LOC | 내용 |
|---|---:|---|
| `lib/api.ts` | 935 | REST 클라이언트 전체. `fetch` 기반 → RN 동일 |
| `lib/http.ts` | 139 | 타임아웃/abort 래퍼. `AbortSignal` → RN 동일 |
| `lib/koreanParticle.ts` | 62 | **한국어 조사 처리(은/는·이/가)** — 순수 함수 |
| `features/settings/usageModel.ts` | 682 | 사용량/쿼터 |
| `features/work/workSessionModel.ts` | 721 | **ACP 작업세션 프로젝션 규칙** (타입드 행·승인·plan) |
| `features/timeline/artifacts.ts` | 593 | diff/커밋/PR 아티팩트 파서 |
| `features/timeline/agentCardModel.ts` | 503 | 에이전트 카드 상태 기계 |
| `features/settings/model.ts` | 459 | 설정 도메인 |
| `features/timeline/model.ts` | 410 | 타임라인 병합·`seq` 순서 |
| `features/agents/agentRail.ts` | 384 | 에이전트 레일 |
| `features/settings/api.ts` | 338 | 설정 REST |
| `features/inbox/model.ts` | 323 | **FeedItem(승인·멘션·실행)·만료 라벨** |
| `features/directory/model.ts` | 314 | 멤버 디렉터리 |
| `features/notifications/model.ts` | 300 | **알림 판정** — `windowFocused: boolean`을 *입력*으로 받아 결정을 반환. 플랫폼 무관 |
| `features/agents/turnCopy.ts` | 222 | 턴 문구(한국어) |
| `features/timeline/rowModel.ts` | 207 | 행 그룹핑 |
| `features/timeline/approvalDecision.ts` | 181 | **승인/거부 결정 전송** |
| `features/channels/model.ts` | 173 | 채널 |
| `features/auth/connectModel.ts` | 166 | 접속 |
| `features/auth/deepLink.ts` | 138 | **`momo://` 딥링크 파싱** — RN `Linking`에 그대로 연결 |
| `features/timeline/stress.ts` · `turnFixture.ts` · `workSessionFormat.ts` | 266 | 픽스처·포맷 |

**이게 가능한 이유(설계 규율의 배당금)**: 이 코드베이스는 **결정 함수가 플랫폼 사실을 파라미터로 받는** 형태로 쓰여 있다. `notifications/model.ts`가 대표적 — `window.focus`를 직접 읽지 않고 `windowFocused`를 인자로 받는다. 그래서 RN에서는 `AppState`가 그 값을 공급하면 끝이다.

### 3.3 B군 — 얇은 어댑터 (2,108 LOC / 8 파일) `[SOURCE]`

| 파일 | LOC | 결합 지점 | RN 대체 |
|---|---:|---|---|
| `lib/realtime.ts` | 653 | `centrifuge` JS SDK + `window.location.hostname` 폴백 1곳 | **centrifuge-js의 RN 동작 검증 필요**(§4) |
| `features/work/observerStream.ts` | 610 | `navigator.onLine` (나머지는 주석) | `@react-native-community/netinfo` |
| `lib/session.ts` | 360 | `localStorage` ↔ 키체인 분기 | **이미 키체인 분기가 있다** — RN keychain으로 교체 |
| `lib/serverBase.ts` | 162 | `localStorage`(서버 선택 기억) | MMKV/AsyncStorage |
| `features/auth/discovery.ts` | 121 | mDNS(Tauri 경유) | RN 네이티브 모듈 또는 v1 제외 |
| `features/auth/useJoinPrefill.ts` | 86 | `window.location`·`history.replaceState` | RN `Linking.getInitialURL()` |
| `features/inbox/anchor.ts` | 85 | `document.querySelector`로 seq 행 스크롤 | 리스트 ref + `scrollToIndex` |
| `lib/env.ts` | 31 | 빌드 환경 | RN 환경 설정 |

**`lib/session.ts`는 특히 유리하다** — Tauri 셸에서 이미 "리프레시 토큰은 OS 키체인, 웹은 localStorage"로 **분기 구조가 존재**한다. RN은 그 키체인 가지를 `react-native-keychain`으로 갈아끼우는 일이다.

### 3.4a C군 — react-query 훅 (1,820 LOC / 7 파일) `[SOURCE]`

`@tanstack/react-query ^5.59.0`. 전 코드베이스 **호출 지점 24개**뿐이고 훅 7개에 모여 있다 — 얕은 결합이라 이식이 쉽다.

RN에서 추가로 배선할 것은 표준 2가지뿐이다:
- `focusManager` ← `AppState`(포그라운드 복귀 시 refetch)
- `onlineManager` ← `@react-native-community/netinfo`(오프라인 감지)

이 둘은 **`features/notifications/model.ts`가 이미 요구하는 `windowFocused`와 `observerStream.ts`의 `navigator.onLine`을 동시에 해결**한다 — 같은 두 신호원(AppState·NetInfo)이 세 곳을 먹인다.

### 3.4 D군 — 폐기/대체 (735 LOC)

- `lib/tauri.ts` (370) — Tauri IPC 브리지. **RN 네이티브 모듈로 전면 대체.**
- `features/updates/store.ts`(176)·`model.ts`(155) — Tauri updater. **모바일은 스토어가 담당하므로 삭제**(Tauri updater는 iOS/Android 미지원이기도 하다).
- `design/lib/cn.ts` (34) — `clsx`+`tailwind-merge`. RN엔 Tailwind가 없다.

### 3.5 디자인 시스템 — 값은 넘어가고 전달 방식은 안 넘어간다 `[SOURCE]`

`design/tokens.css` (470 LOC)가 팔레트 SoT다:
```css
--surface: light-dark(#f7f6f3, #17161a);
--ink:     light-dark(#24211c, #ececf1);
--accent:  light-dark(#a54c08, #f0a850);   /* 호박 */
--agent:   light-dark(#4a6785, #7fa0c4);   /* 새벽 슬레이트 — 네온 AI 퍼플 금지 */
```

| 요소 | 이식 |
|---|---|
| 토큰 **값**(light/dark 쌍) | ✅ TS 토큰 객체로 그대로 |
| `light-dark()` | RN `useColorScheme()` + 2벌 객체 |
| **`tokens.contrast.test.ts` (261 LOC)** | ✅ **그대로 이식 — RN 토큰 객체의 WCAG AA 검증기로 재사용.** 실질 자산이다 |
| `momo-design-taste-web` 스킬 규칙 | 스펙으로 이식(→ `momo-design-taste-rn` 파생 필요) |
| Tailwind 유틸리티(`text-body text-ink bg-surface-hover`) | ❌ RN `StyleSheet`로 재작성 |
| shadcn/ui·Radix(`design/ui/*`) | ❌ 전량 재작성 (RN에 DOM이 없다) |
| `cmdk`(Cmd+K) | ❌ 모바일엔 커맨드 팔레트 개념이 약함 — 재설계 |
| `react-virtuoso` | ❌ RN 리스트로 교체(§4) |

### 3.6 모노레포 패키지화 — 권고: **한다. 단 최소로.**

A+B군(9,624 LOC)과 그 테스트를 `packages/momo-core`(가칭)로 올리고 `clients/web`·`clients/mobile`이 함께 소비하는 구조.

- **범위**: 순수 로직만. **UI·플랫폼 API는 절대 넣지 않는다.** B군은 인터페이스만 코어에 두고 구현은 각 앱이 주입(예: `Storage` 인터페이스 → 웹=localStorage, RN=MMKV).
- **도구**: 이미 npm workspaces를 쓸 수 있는 구조다. **Nx/Turborepo 도입은 현 규모에 과하다** — 파이프라인 캐시가 필요할 만큼 패키지가 많지 않다. 필요해지면 그때.
- **선례 주의** `[SOURCE]`: **Mattermost·Rocket.Chat 둘 다 웹과 UI/로직을 공유하지 않는다.** Rocket.Chat만 `@rocket.chat/message-parser`·`ui-kit` 같은 **파싱/렌더 스펙 패키지**를 공유한다 — 우리가 하려는 것과 정확히 같은 범위(파서·모델)이고, 그 이상은 아니다. **"웹과 모바일이 코드를 공유한다"를 UI까지 확장하려는 시도는 두 선례 모두 하지 않았다.**

### 3.7 이식 지뢰 — A군 안에 숨어 있는 RN 비호환 API `[SOURCE]`

"순수 TS = 무조건 이식 가능"이 아니다. 전수 grep으로 찾은 실제 비호환 지점:

| API | 사용처 | RN 현실 | 대응 |
|---|---|---|---|
| **`new URL()` / `URLSearchParams`** | **9개 파일**(비테스트) — `deepLink.ts`(7곳)·`observerStream.ts`(3)·`realtime.ts`(2)·`api.ts`(2)·`artifacts.ts`(2)·`serverBase.ts`·`settings/api.ts`·`discovery.ts`·`turnFixture.ts` | **RN 내장 `URL`은 불완전 구현** — RN 이식의 대표적 함정 | `react-native-url-polyfill` 전역 설치 (앱 엔트리 1줄). **선결 과제** |
| **`crypto.randomUUID()`** | `features/timeline/useTimeline.ts:147` (낙관적 전송의 `clientMsgId`) | Hermes에 없음 | `react-native-get-random-values` + `uuid`, 또는 자체 생성기 |
| **`Intl.DateTimeFormat().resolvedOptions().timeZone`** | `lib/api.ts:311` | Hermes의 `Intl`은 플랫폼별 편차가 있고 **timezone 해상은 특히 불안정** | 실기기 검증 필요. 실패 시 서버가 tz를 받거나 네이티브에서 주입 |
| `toLocaleDateString(locale,…)` | `features/updates/model.ts:131` | 동일 우려 | **D군(삭제 대상)이라 무해** |

> **`deepLink.ts`는 A군이지만 URL 폴리필 없이는 동작하지 않는다.** `momo://join?token=…` 파싱이 여기 전부 들어 있으므로 **폴리필은 v0 1일차 항목**이다.
> 반대로 안심해도 되는 것: `fetch`·`AbortSignal`·`queueMicrotask`는 RN/Hermes에 있다 — `lib/http.ts`와 `realtime.ts`의 리플레이 게이트가 그 위에 서 있다.

**주의 — centrifuge-js 내부 의존** `[SOURCE]`: `lib/realtime.ts`의 `createReplayGate`는 *"centrifuge-js가 `subscribed` 직후 복구 publication을 동기적으로 flush한다(`Subscription._handleSubscribeResult`)"* 는 **라이브러리 내부 동작에 의존**한다. 즉 재연결 `seq` resume의 정확성이 centrifuge-js 구현에 묶여 있다. **네이티브 centrifuge-swift/kotlin으로 갈아끼우면 이 게이트를 다시 설계해야 한다** — RN에서 centrifuge-js가 도는지가 그래서 중요하다(§4).

### 3.8 UI 재작성의 실제 v0 규모 — 13,346이 아니라 **약 4,600 LOC** `[SOURCE]`

feature별 `.tsx` 실측:

| feature | tsx | LOC | v0 필요? (ADR-0123 D2 스코프) |
|---|---:|---:|---|
| settings | 8 | 3,387 | ❌ v0 제외("설정 편집" 명시 제외) |
| **work** | 3 | 2,696 | △ **1,190은 `ObserverTerminal`이라 미이식** → 실질 ~1,500, 그나마 v0 후순위 |
| **timeline** | 7 | 2,132 | ✅ 코어 |
| **chat** | 2 | 835 | ✅ 코어(ChatShell·Composer) |
| **sidebar** | 3 | 641 | ✅ 채널/DM 목록 |
| **inbox** | 4 | 514 | ✅ 승인·멘션 피드 |
| channels | 1 | 473 | ❌ v0 제외(채널 생성) |
| **auth** | 2 | 453 | ✅ 로그인/딥링크 합류 |
| directory | 2 | 421 | ❌ v0 제외 |
| updates | 3 | 245 | ❌ 삭제(스토어가 담당) |
| agents·notifications·common·activity | 6 | 558 | △ 일부 |

> **v0 UI = auth 453 + sidebar 641 + timeline 2,132 + chat 835 + inbox 514 ≈ 4,575 LOC 상당.**
> 게다가 이건 "포팅"이 아니라 **"같은 모델 위에 RN 뷰를 새로 얹는 것"** 이다 — 렌더 규칙(`rowModel`·`agentCardModel`·`inbox/model`)은 A군으로 이미 넘어가 있으므로, 뷰는 그 결과를 그리기만 한다.

### 3.9 보너스 — **기존 Swift 자산 중 RN으로 그대로 넘어가는 것** `[SOURCE]`

SwiftUI iOS 킷(14,119 LOC)이 통째로 버려지는 게 아니다. **앱 익스텐션과 UI 프레임워크 비의존 모듈은 호스트 앱이 SwiftUI든 RN이든 무관하다.**

| 자산 | LOC | import | RN 앱에서 |
|---|---:|---|---|
| `clients/iOS/NotificationService/NotificationService.swift` | 62 | `UserNotifications` | ✅ **그대로 재사용.** NSE는 별도 타깃이라 호스트 앱 프레임워크와 무관 |
| `MomoiOSPushKit/PushNotification.swift` | **329** | **`Foundation`·`Security`만** | ✅ **그대로 재사용.** SwiftUI/UIKit 의존 0 — id-only 해석 + REST fetch + 키체인 |
| `MomoiOSKit/*Views.swift` 등 UI | ~10,000+ | SwiftUI | ❌ 대체 |
| `clients/Core`(MomoCore) | 5,374 | Foundation | ❌ RN에선 TS A군이 같은 역할 — **단 계약 검증용 참조로는 유효** |

> **즉 ADR-0120 D2-A(id-only → NSE fetch)의 iOS 구현 391 LOC는 살아남는다.** RN 전환의 가장 어려운 부분(선행문서 §2.1에서 Tauri가 못 넘은 바로 그 지점)을 **이미 작성해둔 Swift로 시작**할 수 있다. Mattermost도 같은 구조다 — RN 앱 + Swift NSE + 네이티브 모듈(§1.4).

**배포 파이프라인도 그대로 넘어간다** `[SOURCE]`: oort는 이미 `fastlane/{Appfile,Fastfile,Matchfile}` + `.github/workflows/release-ios.yml` + `docs/cicd/*`(런북·시크릿 인벤토리·스토어 게이트·TestFlight 계획·크래시 스펙 10종)을 갖고 있다. **fastlane은 Xcode 프로젝트를 빌드할 뿐 앱이 SwiftUI인지 RN인지 모른다** — `match`(private signing repo `momo-signing`)·TestFlight 레인·공증 레인 전부 유효하다. **이건 Mattermost가 쓰는 것과 동일한 조합**(fastlane + Matchfile + GH Actions, EAS 아님). 추가 작업은 ①Xcode 프로젝트 경로 변경 ②**Android 레인 신설** 두 가지다.

### 3.10 이식하면 안 되는 것

- **`ObserverTerminal.tsx` (1,190 LOC)** — xterm.js 기반 80컬럼 PTY 관전. 폰에서 raw 터미널은 못 읽는다. RN에 xterm 등가물도 마땅치 않다(§4). **`WorkPanel`의 타입드 행으로 대체하고, 터미널은 "데스크톱에서 열기"로 강등.**
- `QuickSwitcher.tsx`(355) — Cmd+K. 모바일은 검색 탭으로.
- `features/updates/*` — 스토어가 담당.

---

## 1. Mattermost RN 해부 (소스 직독) — 우리의 직접 템플릿

> `mattermost/mattermost-mobile` v2.43.0 클론 후 직독. 전부 `[SOURCE]`.

### 1.1 한눈에

| 항목 | Mattermost | oort 시사점 |
|---|---|---|
| RN / React | **0.83.9 / 19.2.6**, New Arch **ON** | 우리도 동급으로 시작 |
| 빌드 | **bare RN + expo-router + Expo 모듈 낱개**. `eas.json` 없음, `.expo/` 없음 | **EAS 없이도 Expo 모듈만 골라 쓴다**(§2) |
| 릴리스 | fastlane(Matchfile) + GitHub Actions. Detox·Maestro E2E | oort도 fastlane 자산 있음(`docs/cicd/`) |
| 상태관리 | **Redux 없음**(`createStore` 0건). WatermelonDB + `withObservables` + RxJS | oort는 react-query 유지가 더 단순(§1.5) |
| 로컬 DB | WatermelonDB 0.28.1, **서버당 SQLite 1개**, 서버 스키마 v20·마이그레이션 19단계·모델 36개 | oort v0는 오프라인 캐시 없음 → **이 층 전체를 안 만든다** |
| WS 전송 | **네이티브**(`@mattermost/react-native-network-client` = Alamofire/OkHttp3). `new WebSocket(` **0건** | oort는 centrifuge-js(JS) — 차이 주의(§1.3) |
| 네이티브 코드 | **Swift 12,059 + Kotlin 11,548 + ObjC 1,100 + Java 1,322 ≈ 26,000 LOC** | 규모의 상한선이지 우리 목표치가 아님(§1.6) |
| 웹과 코드 공유 | **없음**(별도 레포, 서브모듈 없음, 타입도 각자 작성) | §3.6 결론과 일치 |

### 1.2 디렉터리 — 수평 레이어 + `products/` 수직 모듈

`app/` 2,610개 TS/TSX. 파일 질량은 UI에 있다:
```
685 screens/      604 components/   409 products/(calls,playbooks,boards,agents)
169 database/     160 utils/        145 actions/     132 routes/(expo-router)
 91 hooks/         49 client/        39 queries/      30 managers/   22 store/
```
상단은 수평 레이어(`actions`/`client`/`components`/`database`/`queries`/`screens`), 그 안은 기능 폴더, 그리고 **`products/`는 자체 `database/models`·`actions`·`screens`를 갖는 수직 플러그인 모듈**이다. — oort의 `features/*` 구조와 궁합이 좋다.

### 1.3 실시간 — oort와 가장 크게 갈리는 지점 ⚠️

**Mattermost는 JS WebSocket을 쓰지 않는다.** 전송이 네이티브 모듈이다.

재연결 파라미터(`app/client/websocket/index.ts`):
```ts
MAX_WEBSOCKET_FAILS = 7;  MIN_RETRY = 3_000;  MAX_RETRY = 300_000;  PING_INTERVAL = 30_000;
retryTime = Math.min(MIN_RETRY * connectFailCount, MAX_RETRY);   // fails > 7 이후 선형 백오프
```

**seq 갭 처리 — oort와 철학이 다르다**:
```ts
if (msg.seq !== this.serverSequence) {   // 갭 감지
    this.connectionId = ''; this.close(false);   // 끊고 재연결
    return;
}
this.serverSequence = msg.seq + 1;
```
갭이 나면 **증분 리플레이가 아니라 REST 전량 재동기화**(`doReconnect()` → entry 플로우 재실행 → `operator.batchRecords(models,'doReconnect')` → 현재 화면 채널만 `fetchPostDataIfNeeded()`).

> **oort는 이 지점에서 오히려 유리하다.** Centrifugo가 `recovered`/`hasRecoveredPublications`로 **증분 복구를 서버에서 제공**하고, oort는 이미 `createReplayGate`로 그 배치를 구분한다(실측: 25초 단절 후 8프레임 리플레이, `momowebqa` 2026-07-25). **Mattermost보다 정교한 것을 이미 갖고 있으니 버리지 말 것** — 이게 centrifuge-js를 RN에서 살려야 하는 이유다(§3.7).

**백그라운드 정책**(`app/managers/websocket_manager.ts`) — 그대로 베낄 만하다:
- 백그라운드 진입 시 **즉시 끊지 않고 15초 유예**(`WAIT_TO_CLOSE`), 네이티브 통화 중이면 아예 안 끊음
- 포그라운드 복귀 시 타이머 취소 후 `openAll()`
- 네트워크 타입 전환(VPN↔WiFi)은 강제 `closeAll()`
- 서버가 여러 개면 재연결을 **5초씩 스태거**

### 1.4 푸시 / NSE — oort ADR-0120과 거의 동형

iOS `NotificationService.swift` 흐름:
1. `postNotificationReceipt()` — 푸시 프록시에 ack
2. **ES256 JWT 서명 검증**(`PushNotification+Signature.swift`): `ack_id`+`device_id` 클레임을 서버 공개키로 검증. 공개키는 **공유 SQLite에서 읽어 네트워크 없이** 검증. VoIP는 서명 필수(스푸핑 방지 주석 명시)
3. 앱이 포그라운드가 아니면 `fetchAndStoreDataForPushNotification()` — Gekidou의 자체 REST 클라이언트로 fetch(**18초 타임아웃, iOS의 30초 NSE 킬 전 12초 버퍼**) 후 **공유 SQLite에 직접 raw SQL로 write**
4. `INSendMessageIntent`(Communication Notifications, iOS 15+)로 발신자 아바타까지 붙인 리치 알림

**App Group 공유**: `Mattermost.entitlements`·`NotificationService.entitlements`·`MattermostShare.entitlements` 셋 다 `group.com.mattermost.rnbeta` + 공유 keychain-access-group. 이걸로 NSE·share extension·본체가 같은 SQLite/키체인을 본다.

Android는 대칭 — `CustomPushNotification.kt`(Wix `react-native-notifications` 서브클래스) → `CustomPushNotificationHelper.verifySignature`(Java 639줄) → `PushNotificationDataHelper.kt` → `DatabaseHelper.kt`(Kotlin raw SQLite).

JS측 푸시 등록 라이브러리 = **`react-native-notifications` (Wix) 5.2.2** (notifee 아님), 그것도 패치해서 씀(`patches/react-native-notifications+5.2.2.patch`).

> **oort가 절약하는 부분**: Mattermost의 네이티브 코드가 큰 이유는 **NSE가 로컬 DB에 직접 써야 하기 때문**(REST 클라이언트 + DB writer를 플랫폼마다 네이티브로 중복 구현). **oort v0는 오프라인 DB가 없어 NSE가 fetch→표시만 하면 된다** — 그래서 oort의 기존 391 LOC(§3.9)로 충분하다. **오프라인 캐시를 도입하는 순간 이 비용이 따라온다는 것을 알고 결정할 것.**

### 1.5 상태관리 — oort는 따라가지 말 것

Mattermost는 `withObservables`(253개 파일)로 WatermelonDB 옵저버블을 컴포넌트에 주입한다. 도메인 데이터는 전부 DB, `app/store/*`(22개)는 RxJS `BehaviorSubject` 싱글턴으로 **비영속 UI 상태만** 보관.

> **oort 권고: react-query 유지.** 이 아키텍처는 **오프라인 우선 + 멀티서버 SQLite**를 전제로 성립한다. oort v0는 둘 다 없다. `useInbox`·`useTimeline`·`useWorkSessions`(C군 1,820 LOC)를 그대로 가져가는 편이 싸고, 나중에 오프라인이 필요해지면 그때 WatermelonDB를 검토한다.

### 1.6 타임라인 렌더링 — **"FlashList 쓰면 된다"는 틀렸다** ⚠️

`app/components/post_list/post_list.tsx:558`:
```tsx
<Animated.FlatList inverted={true} maintainVisibleContentPosition={SCROLL_POSITION_CONFIG} ... />
// config.ts: {minIndexForVisible: 0, autoscrollToTopThreshold: 60}
// INITIAL_BATCH_TO_RENDER = 10
```
**메인 채팅 타임라인은 FlatList다.** `@shopify/flash-list` 2.3.1이 설치돼 있지만 **부차 리스트에만**(채널 사이드바·이모지 피커·참가자 목록 등).

그리고 결정적으로 — `patches/react-native+0.83.9.patch`가 **RN 자체의 Fabric 컴포넌트**를 패치한다:
> `React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm` — inverted 스크롤뷰의 `contentInset` 처리를 `maintainVisibleContentPosition` 오토스크롤 중에 고치는 패치

> **oort 시사점: 채팅 타임라인의 어려움은 "가상화 성능"이 아니라 `inverted` + 스크롤 위치 보존이다.** 프로덕션 RN 메신저가 RN의 Fabric C++/ObjC++ 레이어까지 패치해야 했다. §3.8의 timeline 2,132 LOC 재작성 견적에 **이 리스크를 별도로 계상**해야 한다. Bluesky가 FlashList/LegendList를 둘 다 안 쓰는 것과 같은 결의 신호다.

### 1.7 네이티브 모듈 목록 (무엇 때문에 네이티브가 필요했나)

| 모듈 | 목적 | oort 필요? |
|---|---|---|
| **Gekidou**(iOS Swift 패키지, ~43파일 5,607 LOC) | 푸시 fetch/검증/저장, NSE·share ext용 REST, 공유 DB 읽기쓰기, 이미지 캐시 | △ **일부만** — oort는 fetch/검증만(391 LOC 기존) |
| `@mattermost/react-native-network-client` | 네이티브 HTTP/WS(Alamofire/OkHttp3) | ❌ v0는 JS fetch + centrifuge-js |
| `@mattermost/calls-native` | **PushKit + CallKit**(VoIP) | ✅ 허들에 필요(§5) |
| `@mattermost/rnutils` | 화면방향 잠금, 폴더블 분할, 파일 실경로, 저장 | △ 첨부 시 |
| `@mattermost/rnshare` | Android share extension | ❌ v0 제외 |
| `@mattermost/hardware-keyboard` | 하드웨어 키보드 | ❌ |
| `@mattermost/paste-input` | 붙여넣기로 파일 첨부(Fabric 전용) | △ |
| `@mattermost/secure-pdf-viewer` | 암호 PDF | ❌ |

---

## 2. Expo vs bare RN — 권고: **Mattermost 방식(bare + Expo 모듈 낱개)**

### 2.1 게이트 질문 답 — Expo config plugin으로 iOS NSE 추가는 **가능하다** `[SOURCE]`

선행문서에서 `[미확인]`으로 남긴 항목. GitHub 직접 조회로 확인:

| 플러그인 | ★ | 최근 푸시 | 성격 |
|---|---:|---|---|
| `OneSignal/onesignal-expo-plugin` | **185** | **2026-07-21** (열린이슈 0) | 벤더 전용이지만 **NSE 타깃을 실제로 주입**하는 건강한 선례 |
| `evennit/notifee-expo-plugin` | 31 | 2026-02-17 | Notifee용 NSE — *"without needing to eject from Expo managed workflow"* |
| `pawicao/expo-nse-plugin` | 3 | 2026-04-26 | **범용 NSE 주입 플러그인** |
| `LunatiqueCoder/expo-notifee-plugin` | 18 | 2024-10-29 | 정체 |

> **판정: 기술적으로 막히지 않는다.** 다만 **범용 NSE 플러그인은 ★3짜리 개인 프로젝트**이고, 건강한 것(OneSignal)은 벤더 종속이다. oort는 **자체 Swift NSE 391 LOC**(§3.9)를 주입해야 하므로 커스텀 config plugin을 직접 쓰거나 유지해야 한다.

### 2.2 그래서 권고는 "완전 Expo"가 아니다

**oort와 가장 가까운 프로덕션 메신저가 이미 답을 실행 중이다** — Mattermost는 `[SOURCE]`:
- `eas.json` **없음**, `.expo/` **없음** → **EAS 미사용**
- 그러나 `expo-router`로 파일 기반 라우팅, `expo-image`·`expo-file-system`·`expo-application`·`expo-splash-screen`을 **낱개로** 사용
- 빌드는 **fastlane + GitHub Actions**

즉 **"bare RN 프로젝트 + Expo 모듈을 라이브러리로 골라 쓰기"** 가 실전 표준이고, EAS나 managed workflow는 필수가 아니다.

**oort에 이게 맞는 이유**
1. **NSE·딥링크·(v1)LiveKit** 모두 네이티브 프로젝트를 직접 만져야 한다. config plugin으로 우회할수록 디버깅 경로가 길어진다.
2. **oort는 이미 fastlane + match + `release-ios.yml`을 갖고 있다**(§3.9) — EAS로 갈아탈 이유가 없고, 갈아타면 서명 인프라(`momo-signing` private repo)를 재구성해야 한다.
3. 셀프호스팅 오픈소스 제품이라 **빌드가 특정 SaaS에 묶이지 않는 편이 낫다**(EAS는 유료 티어·큐 대기 존재).
4. Expo 모듈 자체의 이점(`expo-image` 등)은 bare에서도 그대로 얻는다.

> **결론: bare RN 프로젝트로 시작하되 Expo 모듈은 자유롭게 쓴다. `expo-router`는 선택 사항(Mattermost는 채택). EAS는 도입하지 않는다.**

### 2.3 정밀화 — "bare 전체"가 아니라 **플랫폼별 자산 비대칭**이 이유다 `[SOURCE]`

위 결론은 iOS·Android를 묶어 말했지만, §1의 자산 실측을 다시 겹쳐 보면 **두 플랫폼이 bare를 택하는 이유가 서로 다르다**:

- **iOS**: §3.9가 이미 확인했듯 그린필드가 아니다 — NSE(62 LOC)·`PushNotification.swift`(329 LOC)·App Group·fastlane/match가 **이미 손으로 짜여 동작한다.** Expo config plugin의 가치는 "손으로 유지하던 네이티브 프로젝트를 선언적 스크립트로 대체"하는 것인데, oort iOS는 대체할 필요가 없는 걸 이미 갖고 있다 — plugin을 새로 짜는 건 순 이득이 아니라 **번역 비용**이다.
- **Android**: 선행 문서 §1이 확인했듯 완전한 그린필드다("파일 한 줄도 없다") — 지킬 기존 네이티브 자산이 0이므로, `npx expo prebuild --platform android`로 네이티브 프로젝트 뼈대를 부트스트랩해도 **잃을 게 없다.** `--platform` 플래그로 플랫폼 단위 prebuild가 가능하다는 건 실사용 확인됨 `[SOURCE]` — 실제 프로젝트(`deeeed/audiolab`)의 엔지니어링 노트가 `yarn expo prebuild --platform android`(및 `--clean` 유무 구분)를 실전 커맨드로 문서화한다.

> **즉 "bare RN + Expo 모듈 낱개"라는 결론 자체는 그대로이되, Android 쪽만 `expo prebuild --platform android`로 초기 골격을 만들고 그 위에 손으로 얹어가는 것이 iOS를 100% 손으로 시작하는 것보다 부트스트랩 비용이 싸다.** 굳이 android/ 디렉터리를 처음부터 수작업으로 만들 이유가 없다 — 다만 이후 유지보수는 여전히 bare RN 프로젝트를 손으로 관리하는 것과 동일하다(재생성 가능한 CNG 관리형 워크플로로 계속 가져가진 않는다는 뜻).

### 2.4 버전·실사용 사례 보강 (2026-07-26 실측) `[SOURCE]`

| | 값 |
|---|---|
| `expo`(npm dist-tag latest) | **57.0.8** (2026-07-22 발행) |
| 실사용 페어링 | Expo 54.0.35 ↔ RN 0.81.5(Bluesky) · Expo ^55.0.0 ↔ RN 0.83.9(Mattermost) · Expo ^55.0.0 ↔ RN 0.83.6-patched(MetaMask) |

`gh api .../contents/package.json` 직접 조회로 대형 앱 2곳을 추가 확인(§2.2 Mattermost 표에 이어):

| 앱 | `expo` 의존 | RN | 비고 |
|---|---|---|---|
| **RocketChat/Rocket.Chat.ReactNative** | ^54.0.0 | 0.81.5 | package.json만 확인, Mattermost 수준 소스 정독은 안 함 |
| **MetaMask/metamask-mobile** | ^55.0.0 | 0.83.6(patched) | 역사적으로 "bare RN 대표"로 알려졌던 앱도 `expo` 의존을 갖게 됐다는 신호 — 2026년엔 `expo` 의존 자체가 이분법 기준이 아니게 됐다 |
| **status-im/status-mobile** | **없음** | 0.73.5 | 유일한 순수 비-Expo 사례지만 ClojureScript 하이브리드라 구조가 이질적 — 반례로 쓰기엔 약함 |

**곁가지 — LiveKit도 Expo 경로가 있다** `[SOURCE]`: `livekit/client-sdk-react-native-expo-plugin`(⭐47, 최종 푸시 2026-03-17, 활성, LiveKit 공식 조직 소유)이 존재한다 — SDK README: *"LiveKit is available on Expo through development builds."* §5.4가 권고하는 "얇은 네이티브 모듈로 기존 Swift 세션 노출" 경로를 v1에서 택하더라도 Expo 쪽 config-plugin 배선이 이미 있다는 뜻이라 막다른 골목은 아니다. §5의 New Arch/interop 리스크 판정(§5.2)을 바꾸지는 않는다 — 순수 참고.

---

## 4. 네이티브 능력 성숙도 (일부 — 직접 검증분)

### 4.1 ✅ Centrifugo 클라이언트는 RN을 **공식 지원**한다 — 게이트 해소 `[OFFICIAL/SOURCE]`

oort 실시간 층 전체(`lib/realtime.ts` 653 LOC + 리플레이 게이트)가 여기 걸려 있었다. **직접 확인 결과 통과다.**

npm `centrifuge` 패키지 description 원문:
> "JavaScript client SDK for bidirectional communication with Centrifugo and Centrifuge-based server from browser, NodeJS **and React Native**"

| 항목 | 값 |
|---|---|
| 최신 | **5.7.0** (2026-06-15, 활발) |
| oort 현재 | `^5.3.5` → 마이너 상향만 |
| 의존성 | `events`, `protobufjs` |
| **protobuf** | **옵트인** — `centrifuge/build/protobuf`를 따로 import해야 활성. **oort는 JSON이므로 protobufjs 미로드** |

**RN에서 주의할 점 2가지** `[OFFICIAL, README]`:
1. **Android cleartext** — README가 명시: *"If you have issues with the connection on Android when using React Native – … you may be using non-secure endpoint schemes and need to explicitly allow it."*
   → **oort에 직접 해당한다.** `lib/realtime.ts:220`에 이미 `ws://<machine>.local:28001/...`(mDNS LAN 서버) 경로가 있고, 셀프호스팅·LAN 발견이 제품 특성이다. Android는 `usesCleartextTraffic`/network security config를 열어야 하며, **이건 앱스토어/플레이 심사와 보안 정책이 얽히는 결정**이므로 티켓으로 분리할 것.
2. **WebSocket 주입** — 브라우저 밖에서는 WebSocket 구현을 넘겨줄 수 있다(커스텀 헤더가 필요할 때). RN에는 전역 `WebSocket`이 있으므로 기본은 그대로 동작할 것으로 보이나 **실측 필요**.

> **결론: oort의 실시간 층은 centrifuge-js를 유지한다.** §3.7에서 짚은 대로 `createReplayGate`가 centrifuge-js 내부 flush 동작에 의존하므로, 네이티브 SDK로 갈아끼우면 재설계가 필요했다. 그럴 이유가 없어졌다.
> **참고 대비**: Mattermost는 반대로 WS를 네이티브 모듈로 내렸다(§1.3). oort는 서버가 Centrifugo라 **증분 복구를 공짜로 얻으므로** JS 유지가 유리하다.

### 4.2 라이브러리 건강도 실측 (npm 레지스트리 직접 조회, 2026-07-26) `[SOURCE]`

| 패키지 | 최신 | 발행일 | 주간 다운로드 | 판정 |
|---|---|---|---:|---|
| `react-native-url-polyfill` | 4.0.0 | 2026-07-14 | **3,254k** | ✅ **선결 필수**(§3.7). 사실상 표준 |
| `@react-native-community/netinfo` | 12.0.1 | 2026-02-14 | 2,617k | ✅ `onlineManager`·`observerStream` 배선원 |
| `@shopify/flash-list` | 2.3.2 | 2026-06-10 | 1,745k | △ **부차 리스트용**. 채팅 타임라인은 아님(§1.6) |
| `react-native-mmkv` | 4.3.2 | 2026-06-22 | 1,459k | ✅ `serverBase` 저장소 대체 |
| `@react-native-firebase/messaging` | 25.1.0 | **2026-06-25** | **859k** | ✅ 가장 최신·최다. FCM+APNs 토큰 |
| `react-native-keychain` | 10.0.0 | 2025-03-23 | 529k | ✅ `session.ts` 키체인 가지 대체 |
| `@notifee/react-native` | 9.1.8 | **2024-12-20** | 415k | ❌ **폐기됨** — `invertase/notifee` 레포 **archived**(아래 갱신). 신규 채택 제외 |
| `react-native-notifications` (Wix) | 5.2.2 | 2025-11-16 | 34k | △ **Mattermost 채택분**(단 패치해서 씀). 다운로드는 적음 |

> **푸시 라이브러리 선택은 열어둔다.** Mattermost 선례(Wix)와 생태계 대세(RN Firebase)가 갈리고, notifee는 정체 신호가 있다. **oort는 iOS NSE를 이미 Swift로 갖고 있어(§3.9) JS 라이브러리의 역할이 "토큰 등록 + 알림 액션 수신"으로 좁다** — 그래서 선택 리스크가 낮고, v0 스파이크에서 실측으로 정하면 된다.

> **갱신(같은 세션 후속 조사) — notifee는 "정체"가 아니라 공식 폐기됐다** `[SOURCE]`. `invertase/notifee`는 GitHub에서 **archived** 상태(코드 변경 없음, `pushed_at` 2026-04-07 이후 정지)이고 README 상단 배너 원문: *"Notifee is no longer actively maintained... We recommend that users migrate to expo-notifications for a supported experience within the React Native ecosystem. Alternatively, see the community-maintained fork react-native-notify-kit."* 라이선스는 여전히 Apache-2.0(완전 오픈소스로 남겨졌다 — "유료화"는 아니다). 대체 후보 `react-native-notify-kit`(2026-03 생성, ⭐175, 활발히 릴리스 중, 최신 10.5.0)는 아직 검증되지 않은 신생 포크다. **oort의 JS 푸시 라이브러리 후보는 사실상 두 갈래로 좁혀진다: `expo-notifications`(§2 채택 시, 공식·최다운로드 4,171k/주) 또는 `@react-native-firebase/messaging`(벤더 무관·858k/주) — Notifee 계열(원본·포크 모두)은 신규 채택 후보에서 제외 권고.**

### 4.3 터미널 관전 — RN에 xterm.js 등가물은 **없다** (예상대로)

§3.10에서 `ObserverTerminal`(1,190 LOC)을 미이식으로 분류한 근거가 라이브러리 부재로도 뒷받침된다. **모바일 관전은 `WorkPanel`의 타입드 행 아코디언으로 대체**하고, raw PTY는 "데스크톱에서 열기"로 강등한다. 필요해지면 `react-native-webview` 안에 xterm.js를 띄우는 우회가 있으나 — 폰에서 80컬럼을 읽는 문제가 그대로 남으므로 **UX상 답이 아니다.**

### 4.4 딥링크 — 이미 A군, 추가 라이브러리 불필요 `[SOURCE]`

§3.2의 `features/auth/deepLink.ts`(138 LOC)가 이미 `momo://` 파싱을 순수 TS로 캡슐화한다(§3.7의 URL 폴리필 선결 필요). RN 코어 `Linking`(`getInitialURL`+`addEventListener('url')`)만으로 콜드스타트·웜스타트 둘 다 커버되며, 네이티브 쪽엔 iOS `Info.plist CFBundleURLTypes`+`AppDelegate` 3줄, Android `AndroidManifest` intent-filter(`singleTask`)만 있으면 된다. **`react-native-app-link`(최종 발행 2021, 주간 6.6k 다운로드)류의 별도 라이브러리는 불필요**하고 사실상 폐기 상태다. `expo-router`를 쓰면(§2에서 à la carte 후보) `app.json`의 `scheme` 필드만으로 라우트별 딥링크가 자동 배선된다(`docs.expo.dev/linking/overview`: *"deep links for all routes are automatically enabled"*).

### 4.5 시큐어 스토리지 — 키체인 계열과 MMKV는 다른 물건이다 `[SOURCE]`

| 패키지 | 최신 | 발행일 | 주간 DL | 백엔드 | 판정 |
|---|---|---|---:|---|---|
| `react-native-keychain` | 10.0.0 | 2025-03-23 | 529k | iOS Keychain / Android Keystore | ✅ §3.3 `session.ts` 키체인 가지 대체 1순위(bare 유지 시) |
| `expo-secure-store` | 57.0.1 | 2026-07-15 | 4,171k | 동일(iOS `kSecClassGenericPassword` / Android Keystore+SharedPreferences) | ✅ à la carte로 채택 시 동급 대안. **iOS 값당 ~2048바이트 제한 이력 있음** `[OFFICIAL, docs.expo.dev/versions/latest/sdk/securestore]` — oort의 refresh token/짧은 키엔 무해하나 큰 payload는 금지 |
| `react-native-mmkv` | 4.3.2 | 2026-06-22 | 1,459k | 자체 AES-128/256, **키는 개발자가 직접 공급·관리** | ⚠️ **"암호화 스토리지"가 아니라 "빠른 로컬 KV + 옵션 암호화"**. `encryptionKey` 자체를 어딘가에 안전히 저장해야 하는데 그게 다시 시크릿 관리 문제로 되돌아간다 — **세션 토큰 등 진짜 시크릿의 1차 저장소로 쓰지 말 것.** §3.3의 `serverBase.ts`(서버 주소 기억) 같은 **비시크릿 로컬 캐시**엔 적합(§4.2에도 이미 그 용도로 등재) |

> **oort 권고**: `session.ts`의 키체인 분기(§3.3, 이미 존재)는 `react-native-keychain`으로 치환. `react-native-mmkv`는 시크릿이 아닌 로컬 상태(서버 주소·UI 프리퍼런스)에 한정.

### 4.6 백그라운드 실행 — 상주 소켓은 없다, 있는 척하지 말 것 `[SOURCE]`

oort v0가 오프라인 DB 없이 "포그라운드=centrifuge-js 소켓, 백그라운드=푸시"로 설계된 이유(§1.5)가 iOS 플랫폼 제약과 정확히 일치한다는 걸 재확인한다.

| 라이브러리 | 최신 | 실제로 주는 것 |
|---|---|---|
| `react-native-background-fetch`(transistorsoft) | 4.4.2(2026-04-22, ⭐1610) | iOS: **"~15분마다, OS가 알아서 조절."** README 원문: *"There is no way to increase the rate... you will never receive an event faster than 15 minutes."* one-shot `scheduleTask`조차 iOS에서 "전원 연결 중일 때만 발화하는 듯"이라고 자기 문서가 인정 |
| `react-native-background-actions` | 4.1.0(2026-04-07, ⭐942) | Android 포그라운드 서비스 래퍼 — iOS엔 대응하는 지속 실행 개념이 없음 |
| Headless JS(RN 코어) | — | **Android 전용.** 5초 타임아웃, foreground UI 접근 불가, 푸시 수신·짧은 동기화용 |

**결론(문서로 못 돌릴 사실)**: iOS는 일반 앱(VoIP/파일전송 등 특수 백그라운드 모드 미보유)에 **상주 WebSocket을 허용하지 않는다.** 위 세 라이브러리 전부 "짧고 기회주의적인 깨우기"만 제공하고, 그마저 OS가 배터리/사용 패턴에 따라 조절한다 — **oort가 "폰이 백그라운드일 때 메시지가 왔다"를 알리는 유일하게 신뢰 가능한 경로는 푸시(§4.2 NSE 체인)이지 소켓 상주가 아니다.** §0(호스트 실행 위치 표시가 UX 요구사항인 이유)을 다시 뒷받침한다 — **"닫아도 계속됩니다"는 서버/작업호스트의 지속성 문제이지, 클라이언트 소켓을 안 죽이는 기술의 문제가 아니다.**

### 4.7 리스트 가상화 — FlashList v2는 New Arch 전용, oort는 이미 New Arch다 `[SOURCE]`

§4.2 표의 `@shopify/flash-list` 행("△ 부차 리스트용")을 보강한다. **v2(현재 최신, 2.3.2)는 New Architecture 없이는 아예 동작하지 않는다** — 공식 마이그레이션 문서 원문: *"New architecture is required - v2 only works on top of React Native's new architecture."* oort는 처음부터 New Arch를 전제하므로(선행 문서 §4.2: "New Arch는 0.82+ 강제") 이 제약은 oort에 해당 사항 없음 — 오히려 v2는 `estimatedItemSize` 등 수동 튜닝 props를 없애고 `maintainVisibleContentPosition`을 **기본 활성화**해 채팅 인버티드 리스트에 유리한 방향으로 갔다.

그런데 §1.6이 이미 정직하게 지적했듯 **Mattermost의 메인 채팅 타임라인은 FlashList가 아니라 `Animated.FlatList`(inverted+`maintainVisibleContentPosition`)이고, 심지어 RN Fabric 자체를 패치해서 쓴다.** FlashList v2는 그 시점 이후 나온 옵션이라 Mattermost 판단에 반영되지 않았을 뿐, oort가 새로 짜는 입장에서는 재검토 대상이다.

세 번째 후보 `@legendapp/list`(v3.3.3, 2026-07-16, 주간 365k, ⭐3282)는 **채팅 UI를 1급 시나리오로 설계**했다 — README 원문: *"Bidirectional infinite lists: Supports infinite scrolling in both directions... Chat UIs without inverted: Chat UIs can align their content to the bottom... maintainScrollAtEnd... alignItemsAtEnd: Useful for chat UIs."* Expo 라이브스트림·React Native Radio 팟캐스트에 소개된 신생(2024-11 생성) 라이브러리로 FlashList(1,745k 주간)보다 훨씬 작지만 성장 중이다.

> **oort 권고**: §7.1 스파이크 5(타임라인)에서 **FlashList v2와 LegendList를 둘 다 실측**할 것. FlashList는 다운로드/생태계 규모에서 안전패, LegendList는 "우리가 필요한 게 정확히 이것"이라는 설계 적합성에서 앞선다 — Mattermost가 검증한 건 어느 쪽도 아닌 순정 `FlatList`+Fabric 패치라는 점을 잊지 말 것(그 경로도 세 번째 후보로 열어 둔다).

---

## 5. LiveKit RN — v0 게이트 아님, v1 리스크

> **먼저 범위 정리**: ADR-0123 D2가 **음성을 v0에서 명시 제외**한다("음성(ADR-0122 별도)"). 따라서 **LiveKit RN은 v0 착수를 막지 않는다.** 아래는 v1 계획용.

### 5.1 상태 `[SOURCE]`

| | RN SDK | Swift SDK (oort 현재) | Android SDK |
|---|---|---|---|
| 버전 | 2.12.0 (2026-07-23) | **2.15.2** (oort 핀) | 2.27.0 |
| 스타 / 열린이슈 | 281 / 20 | 432 / 19 | 351 / 78 |
| 최근 푸시 | 2026-07-26 | 2026-07-17 | 2026-07-25 |

**유지되고 있다** — 월간 릴리스, 메인테이너 응답 1~3일. 다만 3형제 중 막내이자 2군이다.

### 5.2 New Architecture — "돈다, 단 interop 레이어 위에서" ⚠️

- `codegenConfig` 없음, TurboModule/Fabric 스펙 파일 없음. 클래식 `RCTBridgeModule`/`RCTEventEmitter`다.
- 메인테이너 확인(이슈 #134·#288): *"The SDK still uses the legacy bridge, but new architecture can be used safely, as there's a compatibility layer"* + 성능상 *"unlikely that there will be any significant difference."*
- LiveKit 자체 CI가 `newArchEnabled=true`로 테스트한다.
- **진짜 리스크는 상류에 있다**: `react-native-webrtc`의 New Arch 재작성 PR(#1590)이 2024-06부터 열려 있다가 **2026-07-21 미머지 상태로 닫혔다**. 그리고 RN 코어팀은 장기적으로 **interop 레이어 제거 의사**를 밝혀 왔다(공식 폐기 공지는 아직 없음 `[SECONDARY]`).

> 즉 "지금 된다"는 확실하지만 **"계속 되리라"는 보장이 없는 유일한 항목**이다. 추적 대상으로 명시할 것.

### 5.3 oort가 아플 지점

| 항목 | 상태 |
|---|---|
| **CallKit** | LiveKit RN에 1급 모듈 **없음**. 권장 경로가 `react-native-callkeep`인데 **2024-11 이후 정지·열린이슈 357개**. LiveKit이 2026-04 `@livekit/react-native-callkeep`으로 **포크**(커밋 5개, 스타 0 — 사실상 미검증) |
| **iOS 백그라운드 오디오** | 단순 케이스는 UIBackgroundModes로 가능. 견고한 케이스는 **CallKit 필수** → 위 문제로 회귀 |
| **Android 백그라운드** | 서드파티 foreground-service 라이브러리를 직접 배선 |
| **iOS 화면공유** | Broadcast Extension 수동 추가(네이티브 작업량 그대로). 열린 버그 #441(2026-07-24) |
| **에코 제거** | 이슈 #195 열림 — 일부 Android 단말에서 미동작 |

### 5.4 판정

**RN 스택 결정을 되돌릴 이유는 아니다.** 그러나 허들만큼은 "RN이 네이티브 작업을 없애준다"가 성립하지 않는다 — CallKit·백그라운드 오디오·화면공유는 **어차피 Swift/Kotlin을 써야 하고**, RN은 그걸 감쌀 뿐이다.

> **권고: 허들은 oort가 이미 가진 네이티브 자산을 살리는 쪽으로 설계한다.** `IOSHuddleLiveKitSession.swift`(+ macOS 대응물)가 이미 동작하므로, v1에서 **얇은 네이티브 모듈로 그 Swift 세션을 RN에 노출**하는 편이 순수 RN 재구현보다 안전하다. Shopify의 결론과 같은 결이다 — *"Think native **and** React Native."*

---

## 6. brownfield vs 전량 재작성 — **재작성 권고**

### 6.1 brownfield는 방치된 길이 아니다 `[OFFICIAL/SOURCE]`

- RN 공식 "integration with existing apps" 문서는 **New Architecture를 기본값으로** 쓴다(Android 샘플이 `newArchEnabled=true`, iOS는 최신 `RCTReactNativeFactory` API). 레거시 취급이 아니다.
- **Callstack의 `react-native-brownfield`**(RN 코어 기여 조직)가 **v5.0.0을 2026-07-23에 릴리스**했다 — 이번 주다. 투자가 살아 있다.
- Microsoft의 `microsoft/rnx-kit`(1,726 스타, 오늘도 푸시)이 존재하는 것 자체가 대형 브라운필드 운영의 산물이다.

### 6.2 그런데 성공 사례가 전부 대기업이다 ⚠️

| 사례 | 형태 | 결정적 인용 |
|---|---|---|
| **Airbnb (2018)** | brownfield → **철수** | *"we wound up supporting code on **three platforms instead of two**"* — 제품 코드 8만 줄 + **JS 인프라 4만 줄**을 브리징에 씀 |
| **Shopify (2025)** | 팀별 단계 이행 | *"Native devs are crucial… a good mix of native and web developers is the key."* RN 버전 업그레이드에 **"a small group of rotating developers"를 상시 배정** |
| **Microsoft** | brownfield | 전용 툴킷(`rnx-kit`)을 만들어야 할 만큼의 운영 복잡도 |
| **Coinbase** | brownfield, **온보딩 플로우 하나만** | 큰 네이티브 앱을 대체할 의도 없음 `[SECONDARY, 원문 403]` |
| **Discord** | **전량 재작성**(Android) | *"rebuilt from the ground up"* — 단 기술 회고가 아니라 사용자 공지 |

**Airbnb 경고의 성격이 중요하다.** 2018년 구 아키텍처 시절 이야기라 기술적 불만(초기화 지연·비동기 렌더)은 Fabric이 상당수 해소했다. 그러나 **"플랫폼이 셋이 된다"는 조직/인력 논거는 아키텍처로 해결되지 않는다.** 그리고 이 비용은 팀이 작다고 줄지 않는다 — 오히려 **나눠 맡을 사람이 없어 비율상 더 나쁘다.**

### 6.3 oort의 사실관계가 재작성을 가리킨다

1. **Android가 0이다.** brownfield로 감쌀 기존 Android 앱이 아예 없다 → **Android는 어느 쪽을 골라도 그린필드 RN.** brownfield는 iOS 한쪽에만 적용되는데, 그러면 "iOS는 하이브리드, Android는 순수 RN"이라는 **비대칭 구조**가 생긴다. 이게 정확히 Airbnb가 말한 "세 번째 플랫폼"이다.
2. **iOS 앱이 14,119 LOC로 유계다.** brownfield의 장점("건드리기 무서운 큰 네이티브 앱을 안 건드리고 점진 이행")은 Office/Shopify Mobile 급에서 값어치가 나온다. oort는 그 기준에 못 미친다 — 재작성이 **추정 가능한 유한 작업**이다.
3. **인력이 오너 1인 + 에이전트다.** Shopify·Microsoft가 brownfield를 지탱한 방식(전담 로테이션·전용 툴킷)을 재현할 수 없다. 에이전트는 코드 **양**은 감당해도 "이 크래시가 Fabric interop 문제냐 앱 로직이냐" 같은 판단을 대신하지 못한다.
4. **본 리서치에서 소규모 팀이 brownfield로 성공한 문서화 사례를 찾지 못했다.** 전부 전담 모바일 인프라 인력을 가진 회사다.

### 6.4 전환 규율 (선행문서 §6.4를 모바일 실행용으로 갱신)

1. **RN 앱은 iOS+Android 동시 신설.** brownfield 시도하지 않는다.
2. **SwiftUI iOS 킷은 즉시 폐기하지 않는다** — RN 앱이 ADR-0123 D2 v0 스코프를 통과할 때까지 **TestFlight internal 도그푸드 수신부로 유지**, macOS와 같은 "버그픽스 전용 동결".
3. **살릴 것은 명시적으로 살린다**: NSE(62) + `MomoiOSPushKit`(329) + fastlane/match/CI + (v1) `IOSHuddleLiveKitSession.swift`.
4. **전환기 관리 사례는 근거를 못 찾았다** `[미확인]` — 이중 유지 기간·기능 동결 메커니즘을 다룬 문서화 사례가 이번 리서치에 없다. **자체 규율로 정해야 하는 항목**이다.

---

## 7. 착수 제안 (성재 승인 대상)

### 7.1 스파이크 — 문서로 못 푸는 것만 (5~7일, 실기기)

| # | 게이트 | 판정 기준 | 실패 시 |
|---|---|---|---|
| **1** | **한글 IME** ⚠️ 최우선 | 실기기 iOS: 2벌식/3벌식/천지인 + 기본 한글 키보드로 조합 밑줄 · 조합 중 백스페이스 · `maxLength` 컴포저에서 ㅎ→하→한 · controlled `value`. 이슈 #48497/#55257 재현 여부 | **성재 재보고.** RN 결정의 유일한 미해소 리스크(선행문서 §4.2) |
| 2 | **URL 폴리필 + 딥링크** | `react-native-url-polyfill` 적용 후 `deepLink.ts`(A군, 무수정) 통과 → `momo://join?token=` 실왕복 | 폴리필 대안 검토 |
| 3 | **centrifuge-js 실왕복** | RN에서 구독·재연결·**`recovered` 리플레이 게이트 동작**. Android cleartext(`ws://*.local`) 정책 확인 | 네이티브 WS(Mattermost 방식)로 후퇴 |
| 4 | **푸시 id-only → NSE** | 기존 Swift NSE(391 LOC)를 RN 프로젝트에 붙여 본문 fetch → 표시 → 알림 액션 승인 | — |
| 5 | **타임라인** | `inverted` + `maintainVisibleContentPosition`로 1k 메시지 60fps. **Mattermost가 Fabric 패치까지 간 지점**(§1.6)이므로 별도 계상 | 리스트만 네이티브 |
| 6 | **Android 동일 루프** | 1~5 재현 | — |

### 7.2 v0 범위 = ADR-0123 D2 그대로

로그인/부트스트랩 · 채널·DM 목록+unread · 타임라인 실시간(`seq` 순서) · 전송/답장 · **승인 카드 결정** · 푸시 수신+딥링크.
제외: 검색·첨부·Work 콘솔 상세·설정 편집·스레드 작성·**음성**·스토어 요건(M8).

### 7.3 순서

1. **`packages/momo-core` 추출**(A+B군 9,624 LOC + 테스트 7,728) — **웹이 먼저 그걸 소비하도록 바꿔 회귀 없음을 증명**한 뒤 모바일이 붙는다. 이 순서면 모바일 없이도 이득이 확정된다.
2. bare RN 프로젝트 스캐폴드 + URL 폴리필 + RQ 배선(AppState·NetInfo)
3. 스파이크 1~6
4. v0 UI(≈4,600 LOC 상당) — auth → sidebar → timeline → chat → inbox
5. NSE 이식 + TestFlight internal (기존 fastlane 레인 재사용)
6. Android 레인 신설

### 7.4 성재 결정 대기

| # | 결정 | 권고 |
|---|---|---|
| 1 | brownfield vs 재작성 | **재작성**(§6.3) |
| 2 | Expo 채택 수준 | **bare + Expo 모듈 낱개, EAS 미도입**(§2.2) |
| 3 | `packages/momo-core` 모노레포화 | **한다. 순수 로직만, Nx/Turborepo 없이 npm workspaces**(§3.6) |
| 4 | 기존 iOS 킷 | **동결 유지 후 교체**(§6.4-2) |
| 5 | Android cleartext(`ws://*.local`) 정책 | 티켓 분리 — 보안·심사 얽힘(§4.1) |

### 7.5 남은 미확인

- **한글 IME 실기기 재현 여부** — 최대 리스크, 스파이크 1번.
- Expo config plugin으로 **커스텀** Swift NSE 주입의 실제 난이도(범용 플러그인이 ★3 수준).
- `react-native-webrtc` New Arch 이행 — interop 레이어 제거 시 LiveKit RN 영향(v1 추적 항목).
- 전환기(이중 유지·기능 동결) 문서화 사례 부재.
- 푸시 JS 라이브러리 최종 선택(스파이크 4에서 실측 결정).



