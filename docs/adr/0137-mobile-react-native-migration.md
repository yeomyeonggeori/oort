# ADR-0137: 모바일 클라이언트 — React Native 채택 (iOS 재작성 + Android 신설)

- Status: **Accepted** (2026-07-27, 성재 승인 — "ADR-0137 Accept 진행해줘". 스택 방향은 2026-07-26 결정 "RN쪽으로 가자", 세부 결정 5건은 아래 §성재 결정에 기록)
- 관련: **ADR-0123(iOS 클라이언트 v0 — 본 ADR이 대체)**, ADR-0133(UI 스택 Tauri/React — iOS 경로를 P4a 스파이크로 미뤄둔 공백을 본 ADR이 해소), ADR-0120(푸시 id-only→NSE fetch — **승계**), ADR-0125(work host 등급), 리서치 정본 `docs/planning/2026-07-26-rn-adoption-plan.md`·`2026-07-26-mobile-stack-research.md`

## Context

1. **iOS는 정지 상태이고 깨져 있다.** `clients/iOS`는 SwiftUI 35파일·14,119줄·View 35종으로 실물이 상당하나(Discord·Mattermost·Claude 앱 레퍼런스 기반 v1 개편이 2026-07-20~22 완주) **마지막 커밋이 2026-07-22**이고, 그 뒤 track/uxui는 web 647·macOS 315·desktop 96커밋 대비 **iOS 0커밋**이다. 게다가 메시지 전송이 `client_msg_id`(snake) vs `clientMsgId`(camel) 불일치로 **main에서 400**이며 PR #478 이래 9주간 미검출이었다 — 원인은 **실서버에 요청하는 iOS 게이트가 0**이라는 점(MOMO-631).
2. **Android는 코드가 0줄이다.** 문서 언급은 전부 보류(ADR-0120/0121/0133 P5).
3. **ADR-0123과 0133이 iOS에 대해 상충하는 Accepted 상태**였다. 0133은 iOS를 최소 릴리스 요건(macOS·iOS·Web)에 넣고 경로는 "P4a Tauri-mobile 스파이크로 판정"이라 미뤘는데, **그 스파이크 티켓이 발급되지 않았다.** iOS 킷의 동결/지속 여부도 문서에 없어 공백이었다.
4. **웹 자산을 폰에 그대로 올릴 수 없다**(오케스트레이터 실측): `.app-shell`이 `grid-template-columns: 240px 1fr` 무조건이고 사이드바를 접는 반응형 분기가 **전 소스에 0건**. 390px에서 본문이 150px가 된다. 레이아웃 게이트는 통과하나(그리드가 클리핑하고 각 패널이 자기 안에서 스크롤) 읽을 수 없다. 즉 **어떤 경로를 택하든 모바일 셸은 신작**이다.
5. **Tauri 2 모바일은 불합격**(리서치): 1st-party 푸시 부재(#11651 20개월 open, notification 플러그인이 `UNPushNotificationTrigger`를 명시 배제), **ADR-0120이 요구하는 NSE가 Tauri iOS CI 서명에서 entitlement 유실**(#15663 open), awesome-tauri 모바일 앱 사실상 0, **buzz가 같은 Tauri 2.11을 쓰면서 모바일만 Flutter 37,815줄**. Capacitor는 공식 문서가 iOS Silent Push 미지원을 명시해 기각. KMP/CMP는 유명 사례가 전부 "로직만 공유·UI는 네이티브 2벌".
6. 성재 지시: "모바일 경험이 중요하다. gpt·claude 앱이 원격 지원을 잘해서 사용자 만족도가 높다."

## Decisions

### D1. 스택 = **bare React Native + Expo 모듈 낱개, EAS 미도입**
- RN 0.83+/React 19, **New Architecture ON**. 레퍼런스 정합: Mattermost 0.83.9(New Arch, bare + expo-router + Expo 모듈 낱개, `eas.json` 없음, fastlane+GHA), Rocket.Chat 0.81.5.
- **EAS를 쓰지 않는 이유**: momo는 이미 fastlane+match+`release-ios.yml`과 `momo-signing` private repo를 갖고 있다. EAS로 가면 서명 인프라를 재구성해야 하고, 셀프호스팅 오픈소스 제품의 빌드를 특정 SaaS에 묶는다. Expo 모듈의 이점은 bare에서도 그대로 얻는다.
- **플랫폼별로 이유가 다르다(정밀화)**: **iOS는 bare 유지** — NSE 62줄 + `PushNotification.swift` 329줄 + App Group + fastlane/match가 **이미 손으로 짜여 동작한다**. config plugin의 가치는 "손으로 유지하던 네이티브 프로젝트를 선언적으로 대체"인데, 대체할 필요 없는 것을 이미 가졌으므로 plugin 작성은 순 이득이 아니라 **번역 비용**이다. **Android는 `expo prebuild --platform android`로 골격만 부트스트랩** — 지킬 기존 자산이 0이라 잃을 게 없고, 이후 유지보수는 bare와 동일하게 간다(CNG 관리형으로 계속 끌고 가지 않는다).
- 2026년에는 `expo` 의존 유무가 bare/managed 이분법의 기준이 아니다(실사용 페어링: Bluesky Expo 54/RN 0.81.5 · Mattermost Expo ^55/RN 0.83.9 · Rocket.Chat Expo ^54/RN 0.81.5 · MetaMask Expo ^55/RN 0.83.6).
- 대안 기각: Tauri 모바일(§Context 5), Capacitor(silent push 미지원), Flutter(우리 TS/React 자산과 공유 0 — buzz가 그 길을 갔고 코드 공유가 0이다), KMP(UI 2벌은 우리 인력으로 불가).

### D2. 이행 방식 = **전량 재작성** (brownfield 기각)
- brownfield 자체는 방치된 길이 아니다(RN 공식 문서가 New Arch 기본, Callstack `react-native-brownfield` v5.0.0이 2026-07-23 릴리스). **그러나 성공 사례가 전부 대기업이고, 소규모 팀 사례를 찾지 못했다.**
- momo 사실관계가 재작성을 가리킨다: ①**Android가 0** → brownfield는 iOS에만 걸려 "iOS 하이브리드 / Android 순수 RN"이라는 비대칭을 만든다(= Airbnb가 철수 사유로 든 "플랫폼이 셋이 된다") ②iOS 14,119줄로 **유계** — brownfield의 값어치는 Office/Shopify Mobile 급에서 나온다 ③**오너 1인 + 에이전트** — 에이전트는 코드 양은 감당해도 "이 크래시가 Fabric interop이냐 앱 로직이냐"를 판단하지 못한다.
- Airbnb 경고의 기술 부분(초기화 지연·비동기 렌더)은 Fabric이 상당수 해소했으나, **"플랫폼이 셋이 된다"는 조직 논거는 아키텍처로 해결되지 않고 팀이 작을수록 비율상 더 나쁘다.**

### D3. **`packages/momo-core` 모노레포 — 순수 로직만, npm workspaces**
- 실측 재사용 경계(`clients/web/src` 120파일 33,293줄 전수 분류):
  - **A. 그대로 이식 7,516줄/23파일** — `lib/api.ts`(935) · `work/workSessionModel.ts`(721) · `settings/usageModel.ts`(682) · `timeline/artifacts.ts`(593) · `agentCardModel.ts`(503) · `timeline/model.ts`(410, seq 순서 병합) · `inbox/model.ts`(323) · `notifications/model.ts`(300) · `auth/deepLink.ts`(138) 외
  - **B. 얇은 어댑터 2,108줄/8파일** — `realtime.ts`·`observerStream.ts`·`session.ts`(키체인 분기 기존재)·`serverBase.ts`·`inbox/anchor.ts` 등, 저장소·실시간·앵커링만 교체
  - **C. 훅 1,820줄/7파일** — react-query v5, 호출 지점 24개뿐. RN 배선은 표준 2가지(`focusManager`←AppState, `onlineManager`←NetInfo)
  - **E. 테스트 7,728줄/24파일** — A·B·C를 따라가며 **이식의 안전망**
  - F. UI 13,346줄 재작성(단 v0 범위는 ≈4,600 — D5)
- **이게 가능한 이유**: 이 코드베이스는 결정 함수가 플랫폼 사실을 **파라미터로 받는다**(`notifications/model.ts`가 `window.focus`를 읽지 않고 `windowFocused: boolean`을 인자로 받음). RN에선 `AppState`가 그 값을 공급하면 끝.
- **규율**: 코어에 UI·플랫폼 API 금지. B군은 인터페이스만 코어에 두고 구현 주입(`Storage` 인터페이스 → 웹=localStorage, RN=MMKV). **Nx/Turborepo는 현 규모에 과하다.**
- 선례: Mattermost·Rocket.Chat 둘 다 웹과 UI/로직 공유 0. Rocket.Chat만 `message-parser`·`ui-kit`(파싱/렌더 스펙) 공유 — **정확히 우리 범위이고 그 이상은 아니다.**
- **검증 규율**: 코어 추출 후 **웹이 먼저 소비해 회귀 0을 증명**한 뒤 RN이 소비한다.

### D4. 실시간층 = **centrifuge-js 유지** (Mattermost와 의도적으로 갈라짐)
- centrifuge npm이 React Native를 공식 지원 대상으로 명시(오케스트레이터 확인, 5.7.0). 우리는 `^5.3.5` → 마이너 상향.
- Mattermost는 WS를 네이티브 모듈로 내렸고 **갭 감지 시 REST 전량 재동기화**를 한다. **momo는 여기서 더 정교하다** — Centrifugo가 `recovered`/`hasRecoveredPublications`로 증분 복구를 주고 우리 `createReplayGate`가 그 배치를 구분한다(실측: 25초 단절 후 8프레임 리플레이). **버릴 이유가 없는 자산이다.**
- 백그라운드 정책은 Mattermost를 베낀다: 백그라운드 진입 시 즉시 끊지 않고 **15초 유예**, 포그라운드 복귀 시 재개, 네트워크 타입 전환은 강제 재연결.
- **Android cleartext는 티켓 분리**: 우리는 `ws://<machine>.local:28001`(mDNS LAN) 경로가 있고 셀프호스팅이 제품 특성이라 network security config를 열어야 하는데, 보안·심사와 얽힌다.

### D5. v0 범위 = **관전·승인·대화** (데스크톱 축소판이 아니다)
- 성재 통찰("gpt·claude 앱의 원격 지원이 만족도가 높다")을 설계 축으로 채택. momo는 마침 관전 패널·승인 원장·작업중 표시를 갖췄다.
- v0 UI 실측 ≈**4,575줄 상당**(auth 453 + sidebar 641 + timeline 2,132 + chat 835 + inbox 514). 그나마 "포팅"이 아니라 **같은 모델(A군) 위에 RN 뷰를 새로 얹는 것**이다.
- v0 제외: 설정 3,387(운영자 표면은 데스크톱) · 채널/디렉터리 관리 · 업데이트(스토어 담당) · **터미널 raw PTY**.
- **터미널 관전은 강등한다**: RN에 xterm.js 등가물이 없고, WebView 우회를 해도 **폰에서 80컬럼을 읽는 문제가 남는다**. `WorkPanel`의 타입드 행 아코디언으로 대체하고 raw PTY는 "데스크톱에서 열기"로 넘긴다.
- **작업 세션 행에 호스트 등급 표시 필수**: ADR-0125상 `type=app`(맥)은 기기를 끄면 죽고 `workd`/`cloud`는 계속 돈다. 한 앱에 두 등급이 공존하므로 "지금 이거 꺼도 되나"에 답할 수 있어야 한다.

### D6. **스파이크 게이트 — 문서로 못 푸는 것만** (5~7일, 실기기)
Accepted 후 첫 티켓은 구현이 아니라 스파이크다. 하나라도 실패하면 **성재에게 재보고**하고 계획을 고친다.
1. **한글 IME (최우선)** — RN `#48497`(open, 재현코드) · `#55257`(open, "[Japanese Market Blocker] Missing IME Composition Underline") · 수정 PR `#56082`가 `mergeable_state: blocked`. **정직한 심각도**: 확증 증상은 **조합 밑줄 소실**이며 "입력 불가"는 집계 이슈 서술로 RN팀이 재현 못 했다. 반증 신호로 **Mattermost(New Arch, 한·일 사용자 다수)에 열린 CJK 이슈 0건**. 2벌식·천지인·iOS 기본 한글에서 조합 밑줄·조합 중 백스페이스·controlled value를 실기기로 판정한다. (Flutter에도 2019~2025 한글 이슈 계보가 있어 **어느 스택이든 실기기 검증은 필요**하다.)
2. **URL 폴리필 + `momo://join` 실왕복** — `react-native-url-polyfill` 선결(`new URL`/`URLSearchParams`가 15개 파일에서 쓰인다). `deepLink.ts`가 무수정 통과하는지.
3. **centrifuge-js 실왕복 + 리플레이 게이트 동작 + Android cleartext 정책**.
4. **기존 Swift NSE를 RN 프로젝트에 붙여** id-only→fetch→표시→알림 액션 승인.
5. **타임라인 리스트 3자 실측** — 난점은 가상화 성능이 아니라 **inverted + 스크롤 위치 보존**이다(Mattermost는 여기서 **RN 코어 Fabric ObjC++**를 패치했다 — `RCTScrollViewComponentView.mm`, 메인 타임라인은 `Animated.FlatList`이고 FlashList는 부차 리스트에만). 다만 **FlashList v2는 New Arch 전용이고 `maintainVisibleContentPosition`을 기본 활성화**해 인버티드 채팅에 유리해졌으므로 Mattermost의 판단(v2 이전)을 그대로 승계하지 않는다. **`Animated.FlatList` / FlashList v2 / `@legendapp/list`(채팅을 1급 시나리오로 설계) 3자를 1k/60fps로 실측해 정한다.**
6. Android 동일 루프.

### D7. 승계 자산 — **Swift 푸시 391줄과 배포 레인은 살린다**
- `MomoiOSPushKit/PushNotification.swift`(329줄)는 **import가 Foundation·Security뿐, UIKit/SwiftUI 히트 0**(오케스트레이터 확인). `NotificationService.swift`(62줄)는 NSE 별도 타깃이라 호스트 프레임워크와 무관. **ADR-0120 D2-A 구현이 그대로 생존한다.**
- fastlane은 Xcode 프로젝트를 빌드할 뿐 앱이 SwiftUI인지 RN인지 모른다 — `match`·TestFlight·공증 레인 유효. 추가 작업은 **Xcode 경로 변경 + Android 레인 신설** 둘.
- v0는 오프라인 DB가 없어 **NSE가 fetch→표시만** 하면 된다(Mattermost가 네이티브 26,000줄인 이유는 NSE가 로컬 SQLite에 직접 써야 해서다). **오프라인 캐시를 도입하는 순간 그 비용이 따라온다**는 것을 알고 결정한다.
- **푸시 JS 라이브러리 후보는 2개**: `expo-notifications` 또는 `@react-native-firebase/messaging`. **Notifee 계열은 제외** — `invertase/notifee`가 GitHub **archived 상태**(오케스트레이터 확인)이고 README가 `expo-notifications` 이관을 권고한다. 우리는 iOS NSE를 Swift로 이미 가져 JS 역할이 "토큰 등록 + 알림 액션 수신"으로 좁으므로 스파이크 4에서 실측 결정한다.
- **저장소 분리 규율**: 세션 토큰·자격증명은 `react-native-keychain`(iOS 키체인/Android Keystore). **MMKV는 시크릿 저장소가 아니다** — 옵션 암호화의 `encryptionKey`를 다시 어딘가 안전히 둬야 하는 순환 문제가 생긴다. MMKV는 `serverBase.ts` 같은 **비시크릿 로컬 캐시 한정**.
- 상태관리는 Mattermost를 따라가지 않는다 — WatermelonDB+RxJS는 오프라인 우선·멀티서버 SQLite 전제에서 성립한다. **react-query 유지가 싸다.**

### D8. 기존 iOS SwiftUI 킷 = **동결 후 교체**, ADR-0123 대체
- **ADR-0123을 본 ADR이 대체**한다(iOS 수신부 결정을 RN으로 이관). 0133이 남긴 "iOS 경로 미결" 공백도 여기서 닫는다.
- 킷은 **버그픽스 전용 동결**. 단 **MOMO-631(전송 키 400 + 라이브 와이어 게이트)은 예외로 즉시 수리**한다 — 지금 iOS는 메시지를 못 보내고, 그 게이트가 없어 9주간 몰랐다. RN v0가 TestFlight에 오르기 전까지 유일한 모바일 클라다.
- RN v0가 parity 게이트를 통과하면 킷 은퇴(ADR-0133의 macOS SwiftUI 은퇴와 같은 문법).

### D9. LiveKit 허들 = **v1, 네이티브 노출 방식**
- ADR-0123 D2가 음성을 v0에서 제외했으므로 착수를 막지 않는다.
- `client-sdk-react-native` 2.12.0은 유지되고 있으나 **클래식 브리지 + interop 레이어** 위에서 돌고, 상류 `react-native-webrtc`의 New Arch PR이 2026-07-21 **미머지로 닫혔다**. CallKit 1급 모듈이 없어 `react-native-callkeep`(2024-11 정지, 열린이슈 357)에 의존하며 LiveKit이 2026-04 포크했으나 사실상 미검증.
- **허들만큼은 "RN이 네이티브를 없애준다"가 성립하지 않는다** — 어차피 Swift/Kotlin을 쓴다. → v1에서 **기존 `IOSHuddleLiveKitSession.swift`를 얇은 네이티브 모듈로 RN에 노출**하는 편이 순수 RN 재구현보다 안전.

## Consequences

- (+) iOS·Android를 한 코드베이스로. 검증된 로직 11,444줄 + 테스트 7,728줄 승계, 재작성은 기계적인 UI 쪽. 푸시 Swift 391줄·배포 레인 유지.
- (+) ADR-0123↔0133 상충 해소, iOS 정지 상태 종료.
- (−) SwiftUI 35화면 폐기(단 대부분 `runtime-unverified`였고 전송은 깨져 있었다). RN 업그레이드 규율이 새 상시 부채 — **Zulip 교훈: 2022년 버전에 고착돼 자체 포크까지 뜬 끝에 코드베이스를 버렸다. "RN은 안 된다"가 아니라 "업그레이드를 게을리하면 탈출 비용이 재작성 비용이 된다".**
- (−) 한글 IME가 유일한 미해소 스택 리스크 — D6 스파이크 1번이 게이트.
- 파생(Accepted 시): 스파이크 1장(D6 6항목) · `packages/momo-core` 추출 1장(웹 회귀 0 증명 포함) · RN 스캐폴드+폴리필+RQ 배선 1장 · v0 UI 배치(auth/sidebar/timeline/chat/inbox) · NSE 이식+TestFlight 1장 · Android 레인+cleartext 정책 1장. **MOMO-631은 이 ADR과 무관하게 즉시.**

## 성재 결정 (5) — 2026-07-27 승인, 전부 권고안대로

| # | 안건 | 결정 | 근거 조항 |
|---|---|---|---|
| 1 | 이행 방식 | **전량 재작성**(brownfield 기각) | D2 |
| 2 | Expo 수준 | **bare RN + Expo 모듈 낱개, EAS 미도입** | D1 |
| 3 | `momo-core` 모노레포화 | **한다 — 순수 로직만, npm workspaces** | D3 |
| 4 | 기존 iOS 킷 | **동결 후 교체.** MOMO-631 즉시 수리 조건은 **이미 이행됨** | D8 |
| 5 | Android cleartext | **티켓 분리** — 보안·심사와 함께 판단 | D6-3 |

**4번 상태 갱신**: 승인 조건이던 MOMO-631(iOS 전송 키 400 + 라이브 와이어 게이트 부재)은
**2026-07-27 main 랜딩 완료**(#826/PR #832). 9주간 iOS가 메시지를 보내지 못하던 결함이 닫혔고,
재발을 막는 `scripts/verify_ios_wire.sh`가 함께 들어갔다. 따라서 킷은 이제 **버그픽스 전용 동결**
상태로 들어간다 — RN v0가 parity 게이트를 통과하면 은퇴한다.

**Accepted가 곧 착수 승인은 아니다**: D6대로 **첫 티켓은 구현이 아니라 스파이크**다. 6항목 중
하나라도 실패하면 성재에게 재보고하고 계획을 고친다. 특히 **한글 IME는 1번 게이트**이며, 실패 시
스택 선택 자체를 재검토한다(Flutter도 한글 이슈 계보가 있어 어느 스택이든 실기기 검증은 필요하다).

## 이행 순서 (Accepted 시점 기준)

1. **스파이크 1장** — D6의 6항목, 5~7일, 실기기. 한글 IME 최우선.
2. `packages/momo-core` 추출 — **웹이 먼저 소비해 회귀 0을 증명한 뒤** 모바일이 붙는다(D3).
3. RN 스캐폴드 + URL 폴리필 + react-query 배선.
4. v0 UI 배치(auth/sidebar/timeline/chat/inbox ≈4,600 LOC).
5. NSE 이식 + TestFlight.
6. Android 레인 + cleartext 정책 티켓.
