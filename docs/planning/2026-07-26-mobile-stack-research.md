# 모바일 스택 레퍼런스 리서치 — oort iOS/Android 결정용

- 작성: 2026-07-26, Fable (리서치 세션)
- **⚠️ 후속 결정: 성재가 2026-07-26 React Native로 결정했다.** 본 문서는 그 결정의 **근거 기록**으로 보존한다. 실행 계획은 → **`2026-07-26-rn-adoption-plan.md`**.
- 발단: 성재 — oort 모바일 전략 결정. ADR-0133 §4 "iOS 결정은 스파이크 게이트(P4a)"의 입력 자료.
- 목적: **ADR-0133 P4a(Tauri-mobile 이식 판정)를 실증 근거로 대체/보강**. 본 문서는 결정이 아니라 근거다. 결정은 ADR 증보로.
- 출처 등급: `[SOURCE]` 소스 직독 · `[OFFICIAL]` 벤더 공식 문서/블로그 · `[SECONDARY]` 2차 · `[미확인]`

---

## 0. 요약 (결론 먼저)

1. **Tauri 2 모바일은 oort의 모바일 1순위가 될 수 없다.** 렌더링 불가라서가 아니라, **메신저를 메신저로 만드는 기능(푸시 웨이크·NSE 콘텐츠 페치·백그라운드·스토어 파이프라인)이 정확히 Tauri 모바일의 최약점**이기 때문이다. 그리고 oort의 **Accepted ADR-0120이 iOS Notification Service Extension(앱 익스텐션)을 전제**하는데, 그게 Tauri iOS에서 현재 깨져 있다(§2.1).
2. **가장 결정적인 단일 근거: buzz.** oort가 Tauri 데스크톱을 베껴온 바로 그 프로젝트가, **oort와 같은 Tauri 2.11에서**, 모바일만은 Tauri를 쓰지 않고 **37,815 LOC 별도 Flutter 앱**을 썼다. 코드 공유는 **0**이다(§2.2).
3. **oort의 실제 공백은 iOS가 아니라 Android다.** iOS는 SwiftUI 킷 14,119 LOC가 이미 동작한다(푸시·NSE·딥링크·허들·작업세션 관전 포함). Android는 **파일 한 줄도 없다**(§1).
4. **"이미 반응형인 웹 클라"는 사실이 아니다.** `clients/web`의 Tailwind 반응형 프리픽스는 **전체 tsx 통틀어 3개**, 브레이크포인트는 `(width < 900px)` 2곳뿐이며 이건 폰 레이아웃이 아니라 **데스크톱 창 축소 대응**이다(§1.2).
5. 업계 패턴은 갈렸고, **"어느 쪽이 옳다"가 아니라 "무엇을 지불할 것이냐"의 문제**다. Discord=RN 고수(대신 핫패스는 네이티브로 내려꽂고 전문 컨설팅 투입), Slack=완전 네이티브(공유 C++ 코어 시도 후 폐기), Telegram=완전 네이티브 커스텀 드로잉(§3).
6. **모바일 = "관전+승인+대화"라는 결론은 oort가 이미 ADR-0123으로 승인해 둔 것**이고, 이번 레퍼런스 실측이 그것을 반증하지 않고 지지한다. 다만 두 군데를 보정해야 한다 — ①폰에서 **후속 지시**까지 열 것(레퍼런스 전원이 허용) ②푸시를 **완료/승인필요 2채널**로 분리할 것(§5.2).
7. **1순위 권고 = React Native**(iOS+Android 단일), 대안 = Flutter. 근거는 ①oort의 공백이 Android라 어차피 새로 짬 ②TS/React가 집 언어라 ADR-0133의 "오너가 UI를 직접 다듬는다" 원칙을 모바일까지 유지하는 유일한 선택지 ③oort의 푸시 구조(id-only+NSE)가 **Mattermost RN에서 프로덕션 검증됨** — 그것도 ADR-0120이 선례로 인용한 바로 그 제품에서(§6.2).
8. **다만 이 권고는 조건부다.** iOS Fabric에 **한글/CJK IME 조합 결함이 18개월째 미해결**로 열려 있고(원본 #48497 재현코드 첨부, 수정 PR #56082는 리뷰어 미배정 `blocked`), New Arch는 0.82+에서 강제라 회피로가 없다. **다만 "한글 입력 불가"는 과장이다** — 확증된 증상은 조합 밑줄 소실이고, 더 센 주장에는 RN팀이 `Needs: Repro`를 붙였으며, **Mattermost(RN 0.83.9·New Arch)엔 열린 CJK 이슈가 없다.** → **실기기 한글 IME 스파이크가 P4a 1번 게이트**(§4.2, §6.4). **한글 검증은 Flutter·CMP를 골라도 동일하게 필요하다.**
9. **Capacitor·KMP/CMP는 검토 후 기각.** Capacitor는 공식 문서가 **iOS silent push 미지원**을 명시해 메신저의 핵심을 못 한다. KMP/CMP는 유명 사례가 전부 "로직만 공유·UI는 네이티브 2벌"이라 oort가 React 자산을 하나도 못 쓴다(§4.1).

---

## 1. oort의 현재 자산 (실측, 2026-07-26 main)

| 자산 | 규모 | 상태 |
|---|---|---|
| `clients/iOS` (SwiftUI 킷) | **35 파일 / 14,119 LOC** | ADR-0123 accepted, IOS-1~5 랜딩 완료. 최종 커밋 2026-07-22 |
| `clients/Core` (MomoCore 공유) | 30 파일 / 5,374 LOC | iOS·macOS 공유 모델/프로토콜 SoT |
| `clients/macOS` | 2,546 파일 | ADR-0133로 **버그픽스 전용 동결** |
| `clients/web` (React/TS) | 120 파일 / 33,293 LOC | 정본 UI. Tauri 2.11.1 셸이 래핑 |
| **Android** | **0** | 존재하지 않음 |

`[SOURCE]` 전부 레포 실측(`find`/`wc -l`).

### 1.1 iOS 킷이 이미 갖고 있는 것 `[SOURCE]`

`MomoiOSKit/Package.swift` 기준 의존성: `MomoCore` + `centrifuge-swift 0.9.0` + `client-sdk-swift 2.15.2`(LiveKit). 별도 타깃 `MomoiOSPushKit`.

구현된 표면(파일명 기준): 푸시 등록(`PushRegistration`)·푸시 액션 실행(`IOSPushActionExecutor`)·알림 설정(`IOSNotificationPreferences`)·**NotificationService 익스텐션**(`clients/iOS/NotificationService/`)·딥링크(`PushNotificationCoordinator`)·작업 세션(`IOSWorkViews`/`IOSWorkDetailModels`)·허들(`IOSHuddleLiveKitSession`/`IOSHuddleViewModel`)·첨부(`IOSAttachmentTransfer`)·검색/활동(`IOSSearchActivityModels`)·멤버 관리(`IOSMemberManagementViews`)·아티팩트 카드(`IOSMessageArtifactCard`).

→ **모바일 iOS는 그린필드가 아니다.** ADR-0133이 macOS만 동결하고 iOS는 P4a 게이트로 유예해 둔 상태이며, 그 사이 iOS는 손이 멈춰 있다(마지막 커밋이 ADR 승인 3일 전).

### 1.2 웹 클라의 반응형 실태 `[SOURCE]`

```
Tailwind 반응형 프리픽스(sm:|md:|lg:|xl:|2xl:) 총 3개  (tsx 전체)
matchMedia 브레이크포인트 2곳 — 둘 다 "(width < 900px)"
min-w-[NNNpx] 하드코딩          0개
```

`ChatShell.tsx:178`과 `ObserverTerminal.tsx:577`의 900px는 **작업세션 패널을 컬럼에서 드로어로 바꾸는 데스크톱 축소 대응**이다(주석에 "1280px 창에 320px 패널 두 개" 맥락 명시). 폰 폭(390px) 레이아웃은 설계된 적이 없다.

또한 `ObserverTerminal`은 `HOST_COLUMNS` 고정 폭 PTY attach(관전)다 — **80컬럼 터미널은 폰에서 사실상 사용 불가**. 다만 `WorkPanel`은 서버 프로젝션 기반 **타입드 행**(`agent.status`/`agent.partial`/`approval.requested`/`approval.decided`)을 렌더하므로 이쪽은 모바일에 그대로 적합하다(§5).

---

## 2. Tauri 2 모바일 판정 (핵심)

### 판정: **oort 모바일 1순위로 부적합 — 불합격**

Tauri 2 모바일은 "동작한다". 그러나 oort가 필요로 하는 것은 렌더링이 아니라 **메신저 런타임**이고, 그 지점에서 무너진다.

### 2.1 근거

**(a) 1st-party 푸시가 없다 — 20개월째** `[SOURCE]`

공식 `plugins-workspace`를 클론해 `notification` 플러그인 전체를 읽었다. JS API 표면은 `sendNotification`/`requestPermission`/`registerActionTypes`/`pending`/`cancel`/`active`/`createChannel`/`onNotificationReceived`/`onAction` — **전부 로컬 알림이다.** 원격 등록 API(APNs 디바이스 토큰 취득, FCM 토큰)가 **없다**.

결정적으로, `plugins/notification/ios/Sources/NotificationManager.swift:29,41`은 이렇게 되어 있다:

```swift
if notification.request.trigger?.isKind(of: UNPushNotificationTrigger.self) != true {
```

즉 이 플러그인은 **원격 푸시를 자기 처리 대상에서 명시적으로 배제**한다. "아직 미구현"이 아니라 "설계상 범위 밖"이다.

업스트림 `tauri-apps/tauri#11651 [feat] Push Notifications`: **2024-11-12 개설, 2026-07 현재 open, 47👍, 코어팀 구현 없음.** 마지막 유의미한 활동은 2025-08(개인이 만든 플러그인 홍보). `[SOURCE]` GitHub API 직접 조회.

대안은 **커뮤니티 플러그인뿐**이고 건강도는 이렇다 `[SOURCE]` crates.io API:

| crate | 총 다운로드 | 최신 버전 | 최종 갱신 |
|---|---|---|---|
| `tauri-plugin-notifications` | 17,149 | **0.5.0-rc.11** (RC) | 2026-06-30 |
| `tauri-plugin-remote-push` | 5,354 | 1.0.10 | **2025-06-23 (1년 이상 정체)** |
| `tauri-plugin-mobile-push` | 1,612 | 0.1.4 | 2026-04-18 |
| `tauri-plugin-fcm` | 645 | 0.2.0 | 2026-05-06 |

메신저의 존재 이유인 푸시를, **개인이 유지하는 RC 품질 플러그인**에 얹는 것이다.

**(b) oort의 Accepted ADR-0120이 요구하는 NSE가 Tauri iOS에서 깨져 있다** `[SOURCE]`

ADR-0120 D2-A(승인됨)는 **id-only 페이로드 + 클라이언트가 깨어나 자기 서버에서 fetch해 알림을 완성(iOS Notification Service Extension)** 이다. 즉 NSE는 oort 푸시 아키텍처의 **필수 부품**이다.

그런데 `tauri-apps/tauri#15663`(2026-07-06 개설, **open, 코멘트 0**):

> iOS 앱을 `tauri ios build` + App Store Connect API-key 인증으로 빌드하면, 내장 앱 익스텐션(`PlugIns/*.appex`)이 **entitlement 없이 export**된다 … App Group entitlement가 조용히 누락되어 런타임에 `containerURL(forSecurityApplicationGroupIdentifier:)`가 nil을 반환.

원인도 특정되어 있다 — `crates/tauri-cli/src/mobile/ios/build.rs`가 자격증명이 있을 때 `CODE_SIGNING_ALLOWED=NO`로 아카이브한 뒤 **메인 앱 바이너리만** 재서명한다. 즉 **CI 서명 경로에서 앱 익스텐션이 1급 시민이 아니다.**

**(c) 모바일에서 빠지는 공식 플러그인들** `[SOURCE]` (각 README 플랫폼 표 직독)

| 플러그인 | iOS | Android | oort 영향 |
|---|---|---|---|
| `updater` | ✗ | ✗ | 예상된 것(스토어가 담당) |
| `sql` | **✗** | ✓ | iOS 오프라인 캐시 경로 별도 필요 |
| `single-instance`·`window-state`·`global-shortcut`·`process`·`cli`·`positioner`·`autostart` | ✗ | ✗ | 대부분 데스크톱 전용이라 무해 |
| `notification`·`deep-link`·`websocket`·`http`·`fs`·`store`·`shell` | ✓ | ✓ | 기본기는 있음 |

**(d) 벤더 자신의 고지** `[OFFICIAL]` — Tauri 2.0 stable 릴리스 포스트:

> "We are not completely happy about the developer experience at the moment but are actively improving to bring it up to par with the desktop experience."
> "On mobile not all of the official plugins are supported. Some are by design not a good fit for mobile and some are just not implemented to support mobile yet."

**(e) 생태계에 실제 출시된 모바일 앱이 사실상 없다** `[OFFICIAL/SOURCE]`

`awesome-tauri` 공식 목록에서 모바일을 명시한 항목은 **~7개이고 그중 대부분이 앱이 아니라 플러그인**(iap, ios-photos, device-info, in-app-review 등)이다. 200개 이상 등재 앱의 **~96%가 데스크톱 전용**.

**(f) 신선도 리스크** `[SOURCE]`

- `tauri#15719`(2026-07-14, open): 공식 문서가 안내하는 빈 `UISceneConfigurations`가 **iOS 27 SDK에서 런치 크래시**(EXC_BREAKPOINT).
- oort ROADMAP은 이미 "2026-04-28부터 iOS 26 SDK + Xcode 26 이상으로 빌드해야 App Store Connect 업로드 가능"을 게이트로 걸어놨다. **최신 SDK 강제 + Tauri의 최신 SDK 대응 지연**은 정면 충돌하는 조합이다.
- iOS/Android 관련 open 이슈 **159건**.

### 2.2 buzz 반례 — 가장 결정적 근거 `[SOURCE]`

`block/buzz`를 클론해 직접 확인했다. ADR-0133은 이걸 "모바일=Flutter(부분)"으로 적었는데, **"부분"은 이제 틀렸다.**

```
buzz/desktop/     Tauri 2 + React/TS   229,429 LOC   ← momo가 베낀 그 구조
buzz/mobile/      Flutter/Dart          37,815 LOC   220 파일
buzz/crates/buzz-push-gateway/          전용 APNs 게이트웨이 (Rust)
```

- `mobile/pubspec.yaml`: `hooks_riverpod`·`web_socket_channel`·`flutter_secure_storage`·`scrollable_positioned_list`·`camera`·`video_player`·`app_badge_plus`·`app_links`·`nostr`·`pointycastle`
- `mobile/lib/features/`: `activity` `channels` `custom_emoji` `forum` `home` `invites` `pairing` `profile` `pulse` `search` `settings`
- `VISION.md:226` `[OFFICIAL]`: "🚧 Mobile client — Flutter app (channels, forum, search, profile, pairing); in active development"
- CHANGELOG 실적: "Port channel windows to mobile", "mobile: thread scroll-to-bottom and desktop-parity mention autocomplete", "cross-device read state sync", "two-tier Slack-style app icon badge", "channel muting for desktop and mobile"

**코드 공유 = 0.** `flutter_rust_bridge`도 FFI도 없다. Dart 주석이 데스크톱 Rust를 *참조*할 뿐이다:
```dart
/// Mirrors `profile_valid_oa_owner_pubkey` in desktop/src-tauri: ...
/// Mirrors the desktop handler in `desktop/src-tauri/src/deep_link.rs`: ...
```
즉 **암호(NIP-44/NIP-OA/ECDH/HKDF)·릴레이 클라이언트·채널·스레드·멘션·읽음상태를 두 번 구현**했다.

그리고 푸시는 별도 서비스다 — `crates/buzz-push-gateway`, `docs/push-gateway-deployment.md`: APNs 전용 라스트홉(`push.buzz.xyz`), Apple App Attest 검증, 토큰 AEAD 암호화 후 PostgreSQL 보관, 위임 capability, 엔드포인트 쿼터. **oort의 ADR-0120이 그리는 구조와 거의 동일하다.**

> **함의:** Block이 자금을 대는 팀이, oort와 동일한 Tauri 2.11 데스크톱을 가진 채로, 이 질문을 이미 풀었고 — **38k LOC짜리 두 번째 구현을 지불하는 쪽**을 택했다. oort가 "Tauri니까 모바일도 공짜"를 기대한다면, 가장 가까운 선례가 정확히 그 반대를 증언한다.

---

## 3. 메신저별 실제 모바일 스택 (2026)

| 제품 | 2026 현재 스택 | 변천과 이유 | 등급 |
|---|---|---|---|
| **Discord** | **React Native (iOS+Android)** + New Architecture(Fabric) + 핫패스 네이티브 모듈 + 코어 스토어 Rust 이관 진행 | 2015 iOS RN → 2016 Android RN 시제품 **기각**(터치 성능·64bit 부재) → 2022 Android도 RN(사유는 성능이 아니라 **조직**: "코드베이스 여러 개 유지에 시간 덜 쓴다") → 2025~26 RN 유지하되 병목만 네이티브로. **네이티브 재작성은 없었다** | `[OFFICIAL]` |
| **Slack** | **완전 네이티브** — Swift(iOS) / Kotlin ~92%(Android). Android는 자체 Compose 프레임워크 `slackhq/circuit` | 2013 iOS ObjC → 2015 Android 재작성 → 2017 **공유 C++ 코어(Libslack)** → **2019 폐기** → 2020~22 "Duplo"(ObjC→Swift, Kotlin화). **전면 재작성은 검토 후 기각** | `[OFFICIAL]` |
| **Telegram** | **완전 네이티브 + 커스텀 드로잉.** Android=Java 78MB 우세(Kotlin 2.9MB뿐), iOS=Swift 91MB. 양쪽에 거대한 C/C++ 층 | 태생부터 네이티브. `ChatMessageCell extends ViewGroup` — 자체 `Paint`/`StaticLayout`/`Canvas`로 메시지 셀을 직접 그린다. 자체 MTProto 스택 `tgnet`(C++) | `[SOURCE]` |
| **Mattermost** | **React Native 0.83.9 + React 19.2.6, New Architecture ON.** WatermelonDB 0.28. iOS Swift 102파일(전용 네이티브 모듈 `Gekidou`=네트워킹·keychain·이미지캐시·Share Extension), Android Kotlin/Java 37파일 vs **JS/TS 3,093파일** | 계속 RN. RN을 **소스에서 빌드**(`buildReactNativeFromSource: true`)할 만큼 깊게 튜닝. 웹앱과 UI/로직 공유는 **없음**(`@mattermost/*`는 모바일 전용 네이티브 래퍼) | `[SOURCE]` |
| **Rocket.Chat** | **React Native 0.81.5 + React 19.1.0, `newArchEnabled=true`** | 계속 RN. 웹(Meteor/React)과는 `@rocket.chat/message-parser`·`ui-kit` 등 **파싱/렌더 패키지만 공유**, UI는 별도 | `[SOURCE]` |
| **Element (Matrix)** | **Element X = 전면 재작성.** iOS: Swift 6.2/SwiftUI(1,361 swift파일, storyboard 0). Android: Kotlin/Compose(4,150 kt파일, java 0). **공유 = `matrix-rust-sdk`** (iOS `matrix-rust-components-swift 26.7.22` / Android `sdk-android:26.07.23` — 같은 릴리스 트레인) | 구 Element(iOS는 ObjC 325파일 잔존)를 **"total rewrite"**. 공식 사유: 플랫폼 간 코드 공유 + Sliding Sync로 "로그인 후 100ms 내 룸 리스트". **웹은 이 코어를 안 쓴다**(`matrix-js-sdk` 별도) | `[SOURCE]`+`[OFFICIAL]` |
| **Zulip** | **Flutter** (2025-06 정식 전환). `drift` ORM + Firebase 푸시 | **RN → Flutter 이탈.** 공식 블로그는 "Flutter가 복잡한 제품의 모바일 UI에 훨씬 낫다" 수준으로 완곡하지만, **진짜 근거는 레포 안에 있다**(아래) | `[SOURCE]`+`[OFFICIAL]` |
| **Signal** | **완전 네이티브** — iOS Swift 2,590파일 / Android Kotlin 3,874 + Java 1,878. 공유 = **libsignal(Rust) v0.97.3 양쪽 동일 버전 락스텝**. 데스크톱만 Electron | 태생부터 네이티브. 공유 범위는 암호/프로토콜로 **좁게** 한정(Element보다 좁음) | `[SOURCE]` |
| **buzz** | **Flutter** (§2.2) | 데스크톱 Tauri, 모바일 Flutter, 공유 0 | `[SOURCE]` |

### 3.1 Zulip 이탈의 진짜 이유 — RN 자체보다 "RN 부채" `[SOURCE]`

이게 이번 리서치에서 가장 조심해서 읽어야 할 대목이다. Zulip의 공식 블로그는 "Flutter가 낫다"고만 하지만, `zulip-mobile/docs/howto/forked-rn.md`에 이렇게 적혀 있다:

> "Since 2024-09, we use a fork of `react-native` to make changes atop **0.68.7**. We prefer to avoid upgrading to later react-native releases because it's **laborious** and we're eager to retire this codebase and transition to zulip-flutter."

`package.json`도 `"react-native": "zulip/react-native#b7b2f6c22"`, `react: 17.0.2` — **npm 공식 패키지가 아니라 자체 포크**다.

**즉 Zulip이 버린 것은 "2026년의 React Native"가 아니라 "2022년 버전에 고착되어 자체 포크까지 떠야 했던 자기네 RN 코드베이스"다.** 같은 시점에 Mattermost는 RN **0.83.9**, Rocket.Chat은 **0.81.5**로 New Architecture를 켜고 건강하게 굴러간다. Zulip 사례를 "RN은 안 된다"의 근거로 쓰면 오독이다. 올바른 교훈은 **"RN을 채택하면 업그레이드를 게을리한 순간 탈출 비용이 재작성 비용이 된다"** 이다.

### 3.2 반복되는 두 갈래 (oort가 고를 축)

1. **공유 코어(Rust) + 100% 네이티브 UI** — Element X, Signal. UI 공유는 **0**, 공유하는 건 프로토콜/동기화/암호. 대가: 플랫폼마다 UI를 다시 만든다.
2. **공유 UI 프레임워크** — Discord/Mattermost/Rocket.Chat(RN), Zulip/buzz(Flutter). UI를 공유하고, OS 통합(익스텐션·푸시·keychain)만 네이티브로 내려간다.

**Slack의 Libslack 폐기는 1번 진영에 대한 경고다** `[OFFICIAL]` — 공유 C++ 코어를 접은 사유가 성능이 아니라 **인력**이었다:

> "most mobile engineers at Slack were not familiar enough with C++... to help fix issues in the library" / "hiring engineers with C++ experience, particularly on mobile, is difficult"

oort는 1인 오너 + 에이전트 체제이므로 이 리스크가 Slack보다 **크다**. Element X가 성공한 건 matrix-rust-sdk를 **전담하는 별도 팀**이 있어서다.

### 3.3 결정적 확증 — oort의 ADR-0120 푸시 구조는 RN에서 이미 돌아간다 `[SOURCE]`

ADR-0120 D2-A(승인됨)는 **id-only 페이로드 → 클라이언트가 NSE로 깨어나 자기 서버에서 fetch해 알림 완성**이다. 이게 Tauri에서 막히는 지점(§2.1b)인데, **Mattermost(RN 0.83.9)는 정확히 그 구조를 프로덕션에서 굴린다.**

`mattermost/mattermost-mobile/ios/` 디렉터리 실물:
```
NotificationService/     ← Notification Service Extension (13,301b Swift + entitlements + PrivacyInfo)
MattermostShare/         ← Share Extension
Gekidou/                 ← 네이티브 Swift 모듈 (네트워킹·keychain·이미지캐시)
PrivacyInfo.xcprivacy    ← momo ROADMAP M5가 요구하는 바로 그 프라이버시 매니페스트
```

`NotificationService.swift` 실제 로직:
```swift
// 서명 검증 → 앱이 안 떠 있으면 콘텐츠를 직접 가져와 DB에 적재
PushNotification.default.fetchAndStoreDataForPushNotification(notification, withContentHandler: { ... })
```

**즉 "id-only로 깨워서 자기 서버에서 fetch"는 RN에서 검증된 패턴이다.** 게다가 ADR-0120 Context 1이 이미 Mattermost(HPNS)를 relay 구조의 선례로 인용하고 있다 — **선례로 삼은 그 제품이 RN이다.**

---

## 4. 프레임워크별 2026 성숙도와 oort 적합성

### 4.1 판정 요약

| 프레임워크 | 2026 성숙도 | oort 적합성 | 결정적 리스크 |
|---|---|---|---|
| **Tauri 2 모바일** | 렌더링은 되나 **메신저 런타임이 미비** | **부적합 (불합격)** | 1st-party 푸시 부재 · NSE 서명 버그 · 출시 사례 전무 · buzz 반례 |
| **React Native** | **성숙.** stable 0.86(2026-06-11). New Arch는 0.82+에서 **강제**(옵트아웃 불가) | **최적합 — 단 한글 IME 스파이크 조건부** | 🔴 iOS Fabric IME 조합 결함 미해결(§4.2) · 업그레이드 게을리하면 탈출=재작성(Zulip) |
| **Flutter** | 성숙. Zulip·buzz가 프로덕션. stable 3.44(2026-05) | 적합하나 **언어 불일치(Dart)** | 오너가 UI 직접 못 만짐(ADR-0133 발단 ① 재발) · 한글 이슈 계보 6년 |
| **Capacitor** | 유지되나 **정체 후 회복 중**(v8.4.2, 2026-02 백로그 방치 자인 후 대량 트리아지) | 코드 재사용 최대, **메신저 적합성 최저** | **공식 문서가 iOS silent push 미지원 명시** — 메신저 핵심을 못 함 |
| **KMP + Compose MP** | KMP/CMP 모두 Stable(CMP iOS는 1.8.0/2025-05) | **부적합** | 전환비용 최대(전부 새로 배움) + 유명 사례 대부분 **로직만 공유·UI는 네이티브 2벌** |
| **네이티브(Swift+Kotlin)** | 최상 | iOS만 부분 적합 | Android 0에서 시작 + **오너 참여 불가** |
| **공유 Rust 코어 + 네이티브 UI** | Element X·Signal이 증명 | **oort 규모엔 과대** | Slack Libslack 폐기 사유(전담 인력 필요)가 oort에 그대로 적용 |

**Capacitor 기각 사유(핵심)** `[OFFICIAL]`: 공식 문서가 *"This plugin does not support iOS Silent Push (Remote Notifications)"* 라고 못 박는다. Android도 킬 상태에서 data-only 푸시가 JS 콜백을 깨우지 못해 네이티브 `FirebaseMessagingService`가 필요하다. Background Runner는 iOS 30초/호출·Android 최소 15분 간격이라 WebSocket 상주 불가. **oort의 ADR-0120(id-only 푸시로 깨워 fetch)이 Capacitor에서는 결국 네이티브로 내려가야 하는데, 그럴 거면 Capacitor를 쓸 이유가 사라진다.**

**KMP/CMP 기각 사유(핵심)** `[OFFICIAL]`: 흔히 인용되는 사례(Google Workspace·Netflix·McDonald's·Forbes)는 **전부 "로직만 KMP 공유 + UI는 네이티브"** 다 — CMP로 UI를 공유하는 게 아니다. 그 패턴을 따르면 oort는 **모바일 UI를 SwiftUI·Compose로 두 번** 짜야 하고 React 자산은 하나도 안 쓰인다. CMP로 UI까지 공유하는 쪽은 훨씬 작은 코호트이고, **iOS 네이티브 텍스트 입력이 2026-05(1.11.0)에야 실험적 옵트인으로 도착**했다.

### 4.2 React Native (실측)

`[SOURCE]` GitHub 릴리스 API: 최신 stable **0.86.0 (2026-06-11)**, 0.87.0-rc.2(2026-07-21) 진행 중. 레포가 `facebook/react-native` → **`react/react-native`** 로 이동(React Foundation 이관, 2026-02 출범 — Meta 단독 소유 아님).

**New Architecture 타임라인** `[OFFICIAL]`: 0.76(2024-10) 기본값 → 0.80(2025-06) 레거시 동결 → **0.82(2025-10) New Arch가 유일, 옵트아웃 플래그 무시** → 0.84(2026-02) Android 레거시 브리지 클래스 삭제. **즉 "구 아키텍처로 회피"는 더 이상 선택지가 아니다.**

실사용 진영:

| 제품 | RN | React | New Arch |
|---|---|---|---|
| Mattermost | **0.83.9** | 19.2.6 | `newArchEnabled=true` |
| Rocket.Chat | **0.81.5** | 19.1.0 | `newArchEnabled=true` |
| Zulip(폐기) | **0.68.7 자체 포크** | 17.0.2 | — |

**oort에 유리한 점**
- 언어가 TS/React — `clients/web`과 **같은 집 언어**. ADR-0133의 제1 발단("오너가 UI를 직접 다듬을 수 있어야 한다")을 모바일에서도 유지하는 **유일한 선택지**.
- iOS+Android를 한 코드베이스로. oort는 Android가 0이므로 **어차피 새로 짜야 하고**, 그렇다면 두 개보다 하나가 낫다.
- 푸시·NSE·Share Extension·백그라운드·스토어 파이프라인이 **전부 해결된 영역** — Mattermost가 실물로 증명(§3.3).
- 공유 가능한 것은 **컴포넌트가 아니라 로직**: API 클라이언트, `seq`/reconcile 모델, `inbox/model.ts`의 FeedItem 파생, `workSessionModel.ts`의 프로젝션 규칙, 승인 만료 라벨. 이것들은 이미 순수 TS 함수로 분리되어 있다(테스트 파일이 옆에 있는 게 증거: `model.test.ts`·`workSessionModel.test.ts`·`anchor.test.ts`). **UI는 공유하지 않는다** — Mattermost·Rocket.Chat도 웹과 UI를 공유하지 않는다.

**리스크(정직하게)**

**🔴 최대 리스크 — iOS Fabric의 CJK/한글 IME 조합 결함 (직접 검증함)**

oort는 한국어 메신저이고 컴포저가 코어 루프이므로, 이건 성능 이슈보다 상위 리스크다. **다만 과장과 축소를 모두 피해서 적어야 한다.**

확인된 사실 `[SOURCE]` GitHub API 직접 조회:

| 이슈 | 상태 | 성격 |
|---|---|---|
| `#48497` (2025-01-05) | **open**, 라벨 `Issue: Author Provided Repro`·`Component: TextInput`·`Platform: iOS` | **재현 코드가 첨부된 원본 리포트.** 18개월째 열려 있음 |
| `#55257` (2026-01-21, 최종 2026-07-20) | **open**, 👍20, 코멘트 16, 라벨 `Impact: Regression`·`Type: New Architecture`·`Stale`·`Needs: Repro` | "[Japanese Market Blocker] **Missing IME Composition Underline**" |
| `#56463` (2026-04-16) | **open**, 👍10, 라벨 **`Needs: Repro`**·`Needs: Attention` | 위 둘을 **묶은 집계 이슈**(본문에 "Aggregated from multiple reporters" 명시, 버전란이 `0.76.5 ~ 0.82+`라는 실재하지 않는 문자열) |
| PR `#56082` (2026-03-13, 최종 2026-06-08) | **open, `mergeable_state: blocked`**, review comment **1개**, +1808/-30 | 외부 기여자의 수정 제안. **리뷰어 미배정·미머지** |

실제 사용자 증언(코멘트 원문) `[SOURCE]`:
> "Because of this issue, we **can't move to the new architecture**."
> "We received multiple user complaints because of it and **had to roll back last year**, and we've held off on upgrading ever since **because of this issue alone**."

**정직한 심각도 판정 — 3가지를 구분해야 한다**
1. **확증된 증상**: iOS Fabric에서 **IME 조합 밑줄(composition underline)이 사라진다.** 재현 코드가 붙은 원본 이슈(#48497)와 일본 시장 리포트(#55257)가 일관되게 이걸 가리킨다. 조합 중인 글자를 사용자가 시각적으로 구분하지 못한다.
2. **주장되었으나 RN팀이 재현 못한 것**: "글자가 유실·손상된다", "controlled component에서 CJK 입력이 완전히 깨진다", "TextInput이 사용 불가". 이건 집계 이슈(#56463)의 서술이고, **RN팀이 `Needs: Repro`를 붙였다.** 그대로 인용하면 안 된다.
3. **반증 신호** `[SOURCE]`: **Mattermost(RN 0.83.9 + New Arch, 한국·일본 사용자 다수)의 이슈 트래커에 열린 CJK/IME 이슈가 없다.** 검색된 한/중 입력 이슈는 전부 2017~2018년(구 아키텍처 시절) 것이고 모두 closed다. "모든 New Arch 앱에서 한글 입력이 불가"라면 나타났어야 할 신호가 **없다**.

**→ 판정: 실재하고, 미해결이고, 18개월째이며, 실제 팀들의 New Arch 이행을 막고 있다. 그러나 "한글 입력 불가"는 아니고 "조합 표시 결함"에 가깝다. 그리고 New Arch는 0.82+에서 강제이므로 회피로가 닫히고 있다.**
**→ 이건 문서로 결론 낼 수 없다. `실기기 한글 IME 스파이크`를 P4a의 1번 게이트로 올린다(§6.4).** 검증: 2벌식·3벌식·천지인 + iOS 기본 한글 키보드로 조합 밑줄 / 조합 중 백스페이스 / `maxLength` 걸린 컴포저에서 ㅎ→하→한 / controlled `value` 패턴.

**그 외 리스크**
- **업그레이드 규율이 곧 생존이다.** Zulip은 RN 0.68.7에 고착 → 자체 포크 → 탈출 = 전면 재작성이었다. RN 버전 상향을 **게이트 항목으로 명문화**해야 한다.
- Discord조차 New Architecture 전환 성능 회귀를 **외부 컨설팅(Margelo)** 으로 해결했다 `[SECONDARY]`. RN은 "공짜"가 아니라 "관리하면 싼" 스택이다.
- 채팅 타임라인 성능: oort의 parity 게이트(1k/60fps)를 **모바일용으로 다시 세워야** 한다. 참고로 **Bluesky(RN 0.81.5)는 FlashList도 LegendList도 안 쓴다** `[SOURCE]` — "FlashList 쓰면 된다"는 정설이 아니다.
- `[미확인]` **Expo NSE**: `expo-notifications` 공식 문서에 NSE/mutable-content 언급이 **없다** `[OFFICIAL, 부재 확인]`. ADR-0120 경로는 (a) bare RN에 NSE 타깃 직접 추가(= **Mattermost 방식, 검증됨**) 또는 (b) Expo config plugin인데 **(b)는 미검증**. 최악의 경우 (a)로 가면 되므로 권고를 뒤집지는 않으나, **Expo 채택 여부는 이 검증에 달렸다.**

**교차 참고 — 다른 프레임워크도 한글이 깨끗하지 않다** `[SOURCE]`: Flutter는 2019~2025년에 걸친 한글 이슈 계보(#42273 삼성키보드·#71782 조합 중 `clear()`·#134507 iOS `onChanged`·#98590 커서 병합·#115739 천지인·#172270 2025-07 "모든 Flutter 버전")가 있고 현재 상태 미확인. Compose Multiplatform은 2026년에도 한글 조합 수정이 계속 릴리스되고 있다(1.10.0 한글 백스페이스·음절블록 조합 수정). **웹뷰 계열(Capacitor)만 OS가 조합을 소유해 구조적으로 안전하나 이 역시 실측 미확인.** → **한글 IME는 어느 스택을 고르든 실기기 스파이크가 필요한 항목이다. RN만의 문제로 오독하면 안 된다.**

### 4.3 Flutter

buzz(37.8k LOC)와 Zulip이 프로덕션으로 증명한 스택이고, 텍스트 밀도 높은 메신저에서 실패했다는 근거는 이번 리서치에서 나오지 않았다. Zulip은 오히려 "수천 개 메시지를 끊김 없이" 넘긴다고 주장한다 `[OFFICIAL]`.

**oort의 문제는 기술이 아니라 언어다.** ADR-0133이 SwiftUI를 버린 첫 번째 이유가 "Swift 백그라운드 부재로 오너가 UI를 직접 다듬을 수 없음"이었다. **Dart를 채택하면 정확히 같은 문제가 모바일에서 재발한다.** oort는 오너 1인 + 에이전트 체제라 "에이전트가 짜면 되지 않나"가 반론이 될 수 있으나, ADR-0133이 그 반론을 이미 기각하고 TS/React를 골랐다.

**2026 건강도 — "죽어간다"는 담론은 과장이나 무시할 신호도 아니다**
- 2024-04 Flutter/Dart/Python 약 200명 감원 `[SECONDARY, Google 미확인]`. 이게 **커뮤니티 포크 "Flock"(2024-10)** 을 낳았고, 포크 사유가 "헤드카운트 동결·리뷰 처리량 병목"으로 명시되어 있다 `[SOURCE, getflocked.dev]`.
- 그럼에도 릴리스는 유지: **stable 3.44.0(2026-05-18)**, 2026 로드맵이 연 4회 이상 stable 릴리스를 공약 `[OFFICIAL]`. 커밋 17.7만+·기여자 5,000+, 2026-07 말 기준 PR 활발 `[SOURCE]`.
- **Impeller**: iOS는 2023년(3.10)부터 **유일 렌더러**(Skia 폴백 없음), Android는 3.27부터 API 29+ 기본. Android Skia 완전 제거는 2026 로드맵 목표로 **미완** `[OFFICIAL]`.
- 채용: 미국 LinkedIn 기준 Flutter ~1,068 vs RN ~6,413 공고(약 6배 차) `[SECONDARY, 단일 출처·방법론 불명 — 방향성만]`.

**한글 IME**: Flutter는 네이티브 `UITextView`/`EditText`를 쓰지 않고 자체 `RenderEditable`/IME 브리지를 구현한다 `[SOURCE]`. 한글 이슈 계보가 2019~2025에 걸쳐 있다 — #42273(삼성키보드 한글 표시)·#71782(조합 중 `clear()`)·#134507(iOS `onChanged` 오발화)·#98590(조합 중 커서 병합)·#115739(천지인)·#172270(2025-07, "모든 Flutter 버전"·아시아 시장 진입 장벽으로 서술) `[SOURCE]`. 상당수가 "duplicate로 close" — **트리아지되었다는 뜻이지 고쳐졌다는 증거가 아니다.** 현재 mobile-stable의 청결 여부는 **미확인**.

**메신저 선례**: Zulip·buzz가 실물이다. 다만 Tencent Cloud Chat 사례는 **임베드용 채팅 SDK**이지 독립 메신저가 아니다 `[OFFICIAL, 자기보고]`.

> **결론: 대안 A로서 유효하되, 전환 시 한글 IME 실기기 검증을 RN과 똑같이 통과해야 한다.** "RN이 한글에서 위험하니 Flutter로" 는 근거 없는 도피다.

### 4.4 공유 Rust 코어 + 네이티브 UI (Element X / Signal 패턴)

기술적으로는 가장 우아하고, oort에 매력적인 이유도 분명하다 — oort는 이미 Rust(Tauri 셸)를 쓰고 서버 계약이 UI 무관이다.

**그러나 권고하지 않는다.**
- Element X는 matrix-rust-sdk **전담 팀**이 있고, iOS 1,361 swift파일 + Android 4,150 kt파일을 **따로** 유지한다. UI 공유는 0이다. oort 규모에서 이건 비용이 줄어드는 게 아니라 **세 배로 늘어나는** 선택이다(Rust 코어 + Swift UI + Kotlin UI).
- Slack이 같은 구조(Libslack)를 접은 사유가 성능이 아니라 **"모바일 엔지니어가 그 언어를 몰라서 고칠 수 없었다"** 였다 `[OFFICIAL]`. 1인 오너 체제에 그대로 적용되는 리스크다.
- Signal은 공유 범위를 **암호/프로토콜로만** 좁게 잡았다. oort가 이 패턴을 쓴다면 그 정도 범위여야 하는데, oort의 어려운 부분은 암호가 아니라 UI/실시간이다. 즉 **공유해서 이득 볼 부분이 작다.**

---

## 5. 모바일 에이전트 경험 — oort는 이미 답을 갖고 있다

성재 지시("gpt·claude 앱이 원격 지원 잘해서 만족도 높다")의 번역 문제. **결론: oort는 이 질문에 이미 Accepted ADR로 답해놨고, 이번 리서치는 그 답을 반증하지 못했다 — 오히려 지지한다.**

### 5.1 oort가 이미 결정한 것 `[SOURCE]` ADR-0123 (2026-07-17 Accepted, 성재 승인)

> **"모바일의 제1가치는 수신이다**: 이동 중 알림 수신→열람→짧은 답장→**승인 결정**. 특히 '이동 중 에이전트 승인'은 Slack 모바일에 없는 oort 고유 가치다."
>
> "iOS는 **수신·결정 우선의 컴패니언**이지 macOS 패리티가 아니다(**패리티 압박은 로드맵 왜곡의 주범** — Slack 모바일 교훈)."

**따라서 "데스크탑의 축소판인가, 다른 물건인가"는 이미 후자로 판정되어 있다.** 남은 건 스택 선택뿐이다.

### 5.2 레퍼런스 실측 — 5가지 확정 패턴

기존 정본 `research/2026-07-25-reference-ux-survey.md`(데스크톱 중심)를 **모바일 표면**으로 보강한 결과.

**(1) 실행 모드가 갈린다 — "닫아도 도는가"는 제품마다 다르다** `[OFFICIAL]`

| 완전 서버측 (모든 기기 꺼도 지속) | 데스크톱 호스트가 깨어 있어야 함 |
|---|---|
| ChatGPT Tasks·Deep Research·Agent mode, Claude Code on the web(클라우드 VM), **Claude Cowork**("scheduled tasks now run with no device online"), GitHub Copilot 클라우드 에이전트, Jules | **Codex Remote**("that computer sleeps … remote access stops"), **Claude Remote Control**(로컬 프로세스), **Claude Dispatch** |

> **oort 함의(중요):** oort의 작업 호스트(ADR-0125 fabric·momo-workd·T3)가 어느 쪽인지가 **모바일이 사용자에게 약속할 수 있는 문구를 결정한다.** "폰 닫아도 계속됩니다"를 말하려면 실행이 서버측이어야 한다. 이건 UI 결정이 아니라 **엔진 결정**이며, 모바일 스펙 착수 전에 못 박아야 한다.

**(2) 푸시는 두 채널로 분리된다** `[OFFICIAL]` — Claude Remote Control `/config`에 토글이 **정확히 두 개**:
- **"Push when Claude decides"** (완료/자발적 보고)
- **"Push when actions required"** (권한 요청/질문)

> oort 함의: ADR-0120 notifier(P9 "판정은 한 곳")에 **완료 푸시 / 승인요청 푸시**를 별도 등급으로 두는 근거. ux-bible P8(알림 예산)과도 맞다.

**(3) 승인 granularity는 표면이 chat에 가까울수록 굵어진다** `[OFFICIAL]` — 이번 리서치의 가장 강한 교차 발견:

```
터미널   Claude Code CLI/Remote Control : [Yes] [Yes, don't ask again] [No]  ← 명령 단위
클라우드 Claude Code on the web         : 세션 모드 픽커(Accept edits/Plan) ← 세션 단위
채팅     Claude/Cursor in Slack         : 스레드 액션 버튼(View Session/Create PR/Apply) ← 결과 단위
```

> **oort 함의: oort는 chat-native이므로 "결과 단위 + 스레드 액션 버튼"이 자연스러운 자리다.** oort의 승인 카드가 이미 그 형태다. 명령 단위 승인을 폰에 끌어오려는 시도는 이 gradient를 거스른다.

**(4) 폰은 read-only가 아니다 — "대화형 조종은 O, 구조적 저작은 X"** `[OFFICIAL]`

Cursor·Claude Remote Control·GitHub Mobile·Codex Remote 전부 **폰에서 후속 지시를 보낼 수 있다.** 다만 Cursor 문서가 경계를 명시한다: *"On mobile you see changed files in the diff view, **not a full workspace**."*

> oort 함의: ADR-0123의 "수신·결정 우선"은 맞지만 **"짧은 답장"을 넘어 "에이전트에게 후속 지시"까지는 열어야** 레퍼런스 수준이 된다. 반대로 워크스페이스/설정 저작은 데스크톱에 남긴다.

**(5) 세션 리스트는 상태 칩 어휘로 압축된다** `[OFFICIAL/SECONDARY]`
- **GitHub Mobile**: `In progress` / `Action required` / `Idle` / `Disconnected` + **에이전트 종류(Copilot·Claude·Codex)로 필터** → **멀티벤더 에이전트 인박스**. oort 구상에 구조적으로 가장 가까운 기존 제품.
- **Claude**: "computer icon with a **green status dot** when online"
- **Cursor Slack**: 이모지 리액션 ⏳ 실행중 / ✅ 완료 / ❌ 실패
- **Cursor iOS**: **Live Activities(잠금화면) + Dynamic Island로 최대 8개 에이전트 동시 관전** — 네이티브만 가능한 표면
- **buzz 모바일** `[SOURCE]`: `activity/feed_item.dart` + `pulse/agent_activity_card.dart` — 접히는 그룹 카드 + 상태 점. **터미널이 아니다**

**(6) 조종 권한이 클수록 신원 확인이 붙는다** `[OFFICIAL]` — Claude Trusted Devices(beta): 폰이 로컬 파일시스템 접근 세션을 보거나 조종하려면 **생체 인증 step-up(18시간마다 갱신)**. oort가 "이동 중 승인"을 파는 이상 승인 표면의 인증 등급을 별도로 결정해야 한다는 신호.

> **Live Activities는 Tauri 판정에 추가 근거다.** 잠금화면 위젯·Dynamic Island는 웹뷰가 접근할 수 없는 네이티브 표면이고, oort의 "이동 중 에이전트 관전"과 정확히 겹치는 자리다.

### 5.3 oort 번역 — 이미 있는 부품으로 조립된다 `[SOURCE]`

oort 웹에 **모바일에 그대로 맞는 부품이 이미 구현되어 있다**:

| oort 기존 자산 | 모바일에서의 역할 |
|---|---|
| `features/inbox/model.ts` `FeedItem{kind: approval\|mention\|run, actor, predicate, detail, outcome, pending, reason}` | **모바일 홈 = 이 피드.** 이미 알림 카드 모델 그 자체다 |
| `deadlineLabel()` — `3분 후 만료` / `기한 지남` | 승인 카드의 긴급도. 푸시 문구로 직결 |
| `relativeLabel()` — `방금`/`12분 전` | 피드 행 타임스탬프 |
| `features/work/workSessionModel.ts` — 타입드 행(`agent.status`/`agent.partial`/`approval.requested`/`approval.decided`) | **관전의 모바일 형태.** 서버 프로젝션이 이미 좁게 정제되어 있어 폰에 적합 |
| `features/agents/agentWorkingSignal.ts` | 사이드바 "작업중" pill → 모바일 리스트 행 상태 점 |
| iOS `NotificationService` + `IOSPushActionExecutor` | 푸시에서 바로 승인/거부(알림 액션) |

**반대로 모바일에 가져가면 안 되는 것**: `ObserverTerminal`(80컬럼 PTY 관전). 폰에서 raw 터미널은 읽을 수 없다. buzz도 모바일에선 카드로 갔다. **모바일 관전 = `WorkPanel`의 타입드 행 + 접히는 그룹**, 터미널은 "데스크톱에서 열기" 링크로 강등.

### 5.4 권고하는 모바일 정보구조

```
[홈]  받은 것    ← inbox FeedItem 피드 (승인·멘션·실행)
                   승인 행 = 인라인 [승인] [거부] + `3분 후 만료` 카운트
                   상태 칩 어휘: 실행중 / 확인 필요 / 대기 / 끊김   (GitHub Mobile 대응)
                   필터: 에이전트별 (GitHub Mobile의 멀티벤더 인박스 패턴)
[탭]  대화       ← 채널/DM 타임라인 + 컴포저
                   짧은 답장 + **에이전트에게 후속 지시**까지 (패턴 4)
[탭]  작업       ← 작업 세션 리스트: 상태 점 + 틱하는 경과 + 마지막 줄
                   상세 = 타입드 행 아코디언. 터미널은 "데스크톱에서 열기"로 강등
```

**푸시 2채널**(패턴 2): `완료` / `승인 필요` 를 별도 등급으로. 알림 액션에서 앱을 안 열고 승인 종결 — iOS 킷에 `IOSPushActionExecutor`로 이미 구현되어 있다.

**후속 후보**: Live Activities(잠금화면에 실행중 에이전트 경과) — Cursor iOS가 하는 것. oort의 "이동 중 관전"과 정확히 겹치며 **네이티브 표면이라 웹뷰로는 불가**.

**가져가면 안 되는 것**: `ObserverTerminal`(80컬럼 PTY). 폰에서 raw 터미널은 못 읽는다. buzz도 모바일은 카드로 갔다.

---

## 6. 권고

### 6.0 먼저 정리해야 할 모순

**ADR-0123(2026-07-17, Accepted)은 SwiftUI iOS를 지었고, ADR-0133(2026-07-25, Accepted)은 집 언어를 TS/React로 옮기며 iOS를 P4a 스파이크로 유예했다.** 두 Accepted ADR이 iOS에 대해 다른 방향을 가리키고 있고, 그 사이 iOS 트랙은 2026-07-22 이후 멈춰 있다. **이 결정의 본질은 "Tauri 모바일 되냐"가 아니라 "14,119 LOC짜리 SwiftUI iOS 자산을 살릴 것이냐 접을 것이냐"다.**

### 6.1 판정: Tauri 2 모바일 — **불합격**

ADR-0133 §4의 P4a 게이트에 대한 답. 스파이크를 3~5일 태우기 전에 **문서 근거만으로 이미 불합격 판정이 가능**하다:

1. 1st-party 푸시 없음, 업스트림 이슈 20개월 미해결, 대안은 개인 유지 RC 플러그인 `[SOURCE]`
2. **oort의 Accepted ADR-0120이 요구하는 NSE가 Tauri iOS CI 서명 경로에서 entitlement를 잃는다**(#15663, open) `[SOURCE]`
3. 출시된 Tauri 모바일 앱이 생태계에 사실상 없음(awesome-tauri ~96% 데스크톱 전용) `[OFFICIAL]`
4. 벤더 자신이 "모바일 DX에 만족하지 못한다", "모바일에선 공식 플러그인이 다 되지 않는다"고 고지 `[OFFICIAL]`
5. **buzz가 같은 Tauri 2.11에서 모바일만 Flutter로 갔다 — 코드 공유 0, 37,815 LOC 지불** `[SOURCE]`

→ **"Tauri니까 모바일은 공짜"라는 기대는 근거가 없다.** ADR-0133 Consequences의 "(+) 1 코드베이스로 web/mac/win(+모바일 후보)"에서 **괄호 안은 삭제되어야 한다.**

### 6.2 1순위 권고: **React Native (iOS+Android 단일) + 기존 웹 로직 패키지 공유** — **한글 IME 스파이크 조건부**

> **확신 수준: 조건부.** RN은 다른 모든 축(언어 정합·Android 동시 확보·푸시/NSE 검증·메신저 선례)에서 1위지만, **iOS Fabric 한글 IME 결함(§4.2)이 실기기에서 oort 컴포저를 망가뜨리는 수준으로 확인되면 이 권고는 대안 A(Flutter)로 넘어간다.** 문서로는 판정 불가 — 스파이크가 결정한다. 단, **한글 IME 실기기 검증은 Flutter·CMP를 골라도 똑같이 필요하다**(§4.2 말미) — RN만의 페널티가 아니다.

**근거**
- oort의 실제 공백은 **Android(0)** 이다. 어차피 새로 짜야 하므로, iOS만 살리는 선택보다 **둘을 하나로 짓는** 선택이 총량이 적다.
- ADR-0133의 제1 발단(오너가 UI를 직접 다듬을 수 있어야 함)을 **모바일까지 일관되게 유지하는 유일한 스택**. Flutter=Dart, 네이티브=Swift/Kotlin은 그 원칙을 모바일에서 깬다.
- oort의 푸시 아키텍처(ADR-0120 id-only + NSE)가 **RN에서 프로덕션 검증됨** — 그것도 ADR-0120이 선례로 인용한 바로 그 Mattermost가(§3.3).
- 자기호스팅 팀 메신저 중 oort와 구조가 가장 가까운 **두 제품(Mattermost·Rocket.Chat)이 모두 현행 RN + New Architecture**로 건강하게 운영 중 `[SOURCE]`.
- 공유는 **UI가 아니라 로직**. `inbox/model.ts`·`workSessionModel.ts`·`anchor.ts`·API 클라이언트는 이미 순수 TS로 분리·테스트되어 있어 패키지 추출이 현실적이다.

**결정적 리스크와 방어**
| 리스크 | 방어 |
|---|---|
| **RN 버전 고착 → 탈출=재작성**(Zulip 전례) | RN 마이너 상향을 **분기별 게이트 항목으로 ADR에 명문화**. "포크 뜨는 순간 실패"를 불변식으로 |
| 타임라인 스크롤 성능 | 데스크톱 parity 게이트(1k/60fps)의 **모바일판을 착수 전에 정의**. 실패 시 리스트만 네이티브(Mattermost `Gekidou` 패턴) |
| Expo NSE 지원 `[미확인]` | **P4a 스파이크의 1번 검증 항목.** 불확실하면 bare RN(=Mattermost 방식, 검증됨)으로 |
| 기존 iOS 14,119 LOC 폐기 | 아래 6.4 전환 규율 |

### 6.3 대안 (1순위가 막힐 때)

- **대안 A — Flutter (buzz 경로).** 메신저 실물 선례가 둘(buzz·Zulip) 있고 buzz는 화면 단위 레퍼런스로 쓸 수 있다. **포기하는 것: 오너의 UI 직접 참여**(Dart). RN의 한글 IME 게이트가 실패하면 이쪽 — **단 Flutter도 같은 한글 게이트를 통과해야 하며**(§4.3), 통과 못 하면 남는 건 네이티브뿐이다.
- **대안 B — iOS SwiftUI 유지 + Android만 별도.** 14k LOC를 살리는 유일한 길이지만 **UI 스택이 3개(React/SwiftUI/Android)** 가 되고 ADR-0133이 해결한 문제를 되살린다. **권고하지 않음.**
- **비권고 — Tauri 모바일**(§6.1). **비권고 — 공유 Rust 코어 + 네이티브 UI**(§4.4, oort 규모 초과).

### 6.4 전환 규율 제안

1. **ADR-0133 §4 P4a를 "Tauri-mobile 이식 판정"에서 "모바일 스택 결정"으로 재정의**하고, 본 문서를 그 입력으로 ADR 증보를 기안한다(성재 승인 대상).
2. **iOS SwiftUI 킷은 즉시 폐기하지 않는다.** RN 앱이 ADR-0123 D2 v0 스코프(로그인·목록·타임라인·전송·승인·푸시딥링크)를 통과할 때까지 **TestFlight internal 도그푸드 수신부로 유지**. macOS와 같은 "버그픽스 전용 동결" 규율 적용.
3. **서버 계약 무변경**: REST + Centrifugo + `momo://` + ADR-0120 relay는 그대로. 모바일 스택 결정은 UI 레이어 전용이며 하드 불변식 영향권 밖이다.
4. **P4a 스파이크 재정의(5~7일, 실기기 필수)** — 문서로 못 푸는 것만 남긴다. **순서가 중요하다 — ①이 실패하면 나머지를 태울 이유가 없다.**

| # | 게이트 | 판정 기준 | 실패 시 |
|---|---|---|---|
| **1** | **한글 IME (최우선)** | 실기기 iOS + 2벌식/3벌식/천지인·iOS 기본 한글 키보드: 조합 밑줄 표시 · 조합 중 백스페이스 · `maxLength` 컴포저에서 ㅎ→하→한 · controlled `value` 패턴 | **대안 A(Flutter)로 전환** — 단 Flutter도 같은 검증 통과해야 함 |
| 2 | 푸시 실왕복 | APNs id-only → **NSE가 본문 fetch** → 알림 표시. Expo config plugin 가능 여부 판정 | bare RN(Mattermost 방식)으로 |
| 3 | 타임라인 성능 | 1k 메시지 60fps 스크롤(데스크톱 parity 게이트의 모바일판) | 리스트만 네이티브(Mattermost `Gekidou` 패턴) |
| 4 | 실시간 | Centrifugo 재연결 `seq` resume | — |
| 5 | 승인 루프 | 푸시 알림 액션에서 승인/거부 종결 | — |
| 6 | Android | ①~⑤ 동일 루프 | — |
5. **엔진 선결 질문(모바일 UI와 독립, 먼저 답해야 함)**: **oort의 에이전트 작업은 모든 기기를 꺼도 계속되는가?** §5.2 패턴 1에서 보듯 레퍼런스 제품들이 여기서 정확히 갈리고, 이 답이 모바일이 사용자에게 할 수 있는 약속("폰 닫아도 계속됩니다")을 결정한다. ADR-0125 work host fabric / momo-workd / T3 기질의 실행 위치 문제이므로 **엔진 트랙에 질의**해야 한다.

### 6.5 성재 결정 대기 항목

| # | 결정 | 선택지 |
|---|---|---|
| 1 | 모바일 스택 | **RN(권고)** / Flutter / iOS SwiftUI 유지+Android 별도 |
| 2 | 기존 iOS SwiftUI 킷 처분 | **동결 유지 후 교체(권고)** / 즉시 폐기 / 정본 유지 |
| 3 | Android 착수 시점 | iOS와 **동시**(RN이면 자연스러움) / iOS 후순위 |
| 4 | ADR-0133 §4 P4a 재정의 | 본 문서를 근거로 ADR 증보 기안 승인 여부 |

### 6.6 남은 미확인 (정직 표기)

**결정을 바꿀 수 있는 것 (P4a에서 반드시 해소)**
- **Expo config plugin의 iOS NSE 지원 여부.** `expo-notifications` 공식 문서에 NSE/mutable-content 언급이 **없음**을 확인했다 `[OFFICIAL, 부재 확인]`. bare RN 경로는 Mattermost로 검증되었으므로 이 항목이 실패해도 1순위 권고는 유지되나, **Expo 채택 여부는 갈린다.**
- RN 채팅 타임라인의 모바일 실측 성능(1k 메시지 60fps) — 문헌이 아니라 **실측**으로만 판정 가능.
- oort 에이전트 작업의 실행 위치(서버측 지속 여부) — 엔진 트랙 질의(§6.4-5).

**결정을 바꾸지 않는 것 (참고용 공백)**
- Flutter의 현재 mobile-stable에서 한글 조합이 깨끗한지 — **대안 A로 넘어가면 즉시 필수 검증**이 된다.
- Capacitor WebView에서의 한글 IME 실측(구조적으로는 OS가 조합을 소유해 안전하나 미검증) — Capacitor는 푸시 사유로 이미 기각.
- Discord Android의 Fabric 전환 완료 여부, Discord Rust 코어 이관 범위.
- Claude/ChatGPT 모바일의 **정확한 푸시 문구 리터럴** — 어느 벤더도 공개 문서에 두지 않음(전 제품 공통 공백).
- Cowork 모바일 세션 리스트의 화면 레이아웃 — 공식/언론 모두 화면 수준 서술 없음.

**리서치 중 정정된 통념 2건** (ADR에 그대로 옮기면 안 되는 것)
- OutSystems의 Ionic 인수는 **2022-11**이지 2024년이 아니다 `[OFFICIAL]`.
- 웹뷰 래퍼 앱의 앱스토어 리스크는 **4.2(Minimum Functionality)** 이지 4.7이 아니다 — 4.7은 바이너리에 포함되지 않는 호스팅형 미니앱(WeChat식) 규정이다 `[OFFICIAL]`.
- (본 문서 자체의 정정) ADR-0133이 적은 "buzz 모바일=Flutter(**부분**)"는 더 이상 맞지 않다 — 220파일·37,815 LOC의 본격 구현이다(§2.2).
- (브리프 전제 정정) "Slack은 과거 하이브리드였다"는 **1차 출처로 확인되지 않았다.** Slack은 2013년부터 네이티브였고, 유일한 크로스플랫폼 시도는 UI가 아닌 **공유 C++ 로직 층(Libslack, 2017~2019)** 이며 그것도 폐기했다(§3).

**방법론 한계**: 본 리서치는 세션 WebSearch 예산(200회)을 소진했다. 이후 확인은 알려진 URL에 대한 WebFetch와 소스 직독으로만 수행했다. 소스 직독 근거(`[SOURCE]`)는 그 영향을 받지 않으며, **판정의 핵심 근거(Tauri 플러그인 표면·buzz·Mattermost NSE)는 전부 소스 직독이다.**

