# RN 푸시 승계 감사 — ADR-0137 D7 실증 (#837 게이트 4)

- 작성: 2026-08-02 · goal RN-S2 · base `track/engine`(`a591bc62`)
- 대상 주장: **ADR-0137 D7 "승계 자산 — Swift 푸시 391줄과 배포 레인은 살린다"**
- 방법: 이 레포의 파일을 직접 읽어 확인한 것만 **실측**으로 적는다. 레포 밖 사실(라이브러리 문서·업스트림 이슈)은 출처를 붙이고 **인용**으로 표시한다. 실행해 보지 않은 절차는 **미검증 설계**로 표시한다.
- 이번 감사에서 **실행하지 않은 것**: RN 프로젝트 생성, 빌드, 기기 배포, 실제 푸시 왕복. RN 앱은 병렬 goal(RN-S1)이 `clients/mobile-spike/`에 만드는 중이라 이 감사 시점에 부착 대상이 존재하지 않는다.

---

## 1. 결론

**게이트 4 = 기기대기(conditional).** D7이 문자 그대로 주장하는 것 — `PushNotification.swift` 329줄의 import가 `Foundation`·`Security`뿐이고 UIKit/SwiftUI 히트가 0이라는 것 — 은 **실측으로 참이다**(§2.1). 그리고 그 이식성은 우연이 아니라 SPM 타깃 구조로 강제돼 있다: `MomoiOSPushKit`은 **의존성이 하나도 선언되지 않은 리프 타깃**이다(`clients/iOS/MomoiOSKit/Package.swift:27-30`). 호스트 UI 프레임워크가 SwiftUI에서 React Native로 바뀌는 것이 이 391줄에 영향을 줄 경로가 코드상 없다.

그러나 게이트 4가 증명하라고 요구한 것은 파일의 이식성이 아니라 **한 바퀴**다 — `id-only 페이로드 → NSE가 fetch → 표시 → 알림 액션에서 승인`. 실측 결과 **391줄은 이 네 걸음 중 앞 세 걸음만 덮는다.** 네 번째 걸음(알림 액션에서 승인)은 391줄 밖, 앱 타깃 쪽 **678줄**에 흩어져 있다. 그중 **557줄**(코디네이터 267 + 등록 215 + 액션 실행 75)은 `MomoiOSKit`/`MomoCore`/`UIKit`에 묶여 **그대로는 생존하지 않고**, 나머지 121줄(카테고리·액션 정의)만 조건부로 이식 가능하다(§2.2). D7은 거짓이 아니라 **범위가 좁게 진술된 참**이다. "ADR-0120 D2-A 구현이 그대로 생존한다"는 문장은 D2-A의 fetch·표시 부분에 대해서만 성립한다.

PASS를 줄 수 없는 이유는 셋이고, 셋 다 기기/실행이 있어야 풀린다:
1. **부착 대상 부재** — RN 프로젝트가 아직 없다. §3의 절차는 실측 구성에서 도출했을 뿐 실행 검증되지 않았다.
2. **서명 레인이 지금 상태로는 NSE를 통과시키지 못한다** — fastlane match가 프로비저닝하는 app identifier는 `com.dawnkim.momo` **하나뿐**이고, 이는 Xcode 프로젝트의 앱 번들 ID(`app.momo.ios`)와도, NSE 번들 ID(`app.momo.ios.NotificationService`)와도 일치하지 않는다(§4.2). 이것이 정확히 Tauri가 죽은 실패 계열이다. **"배포 레인은 살린다"는 D7 후단 주장은 현재 파일 기준으로 성립하지 않는다** — 살아 있는 것은 레인의 골격이고, NSE를 실을 수 있는 상태는 아니다.
3. **서버 절반이 Rust에 미이식** — id-only 페이로드를 실제로 만들어 APNs로 쏘는 코드는 전부 Swift(`relay/PushRelay` + `workers/NotifierWorker`)이고, Rust 서버에는 APNs 코드가 **한 줄도 없다**(§6). 클라이언트 NSE가 완벽히 생존해도 그것을 깨울 주체가 Rust 경로에는 없다.

FAIL로 내리지 않는 이유: 위 셋 중 (2)와 (3)은 **설정·이식 작업량**이지 설계 결함이 아니고, (1)은 순서 문제다. 승계의 핵심 가정(NSE 코드가 호스트 UI 스택과 무관하다)은 반증되지 않았고 오히려 타깃 구조로 뒷받침된다.

**라이브러리 권고는 `expo-notifications` 1개**로 낸다(§5). 세 축(델리게이트 소유권·알림 액션 수신·자격증명 소재)이 모두 같은 방향을 가리키고, `@react-native-firebase/messaging`은 그중 둘에서 **설정으로 우회 불가한 실격**이다 — 커스텀 액션 식별자를 JS로 전달하지 않고(소스 확인), iOS 발송에 APNs 키를 Firebase에 업로드할 것을 요구한다. 다만 이 권고는 **미문서화된 공개 API 한 곳(`addDelegate(_:)`)에 실려 있어** 부착 스파이크에서 가장 먼저 검증해야 한다(§5.3).

**게이트 4를 PASS로 뒤집는 데 필요한 최소 실측**은 §7에 목록으로 적었다.

---

## 2. 승계 자산 실측표

측정 방법: `wc -l`, 파일 선두 `import` 직접 확인, `Package.swift` 타깃 의존성 확인. 모든 경로는 레포 루트 기준.

### 2.1 그대로 생존하는 것 (= D7이 말한 391줄)

| 파일 | 줄수 | import (실측) | 비-시스템 의존 | 이식 시 필요한 것 |
|---|---:|---|---|---|
| `clients/iOS/MomoiOSKit/Sources/MomoiOSPushKit/PushNotification.swift` | **329** | `Foundation`, `Security` (1-2행) | **없음** | Info.plist 키 `MomoKeychainAccessGroup`, Keychain access group entitlement |
| `clients/iOS/NotificationService/NotificationService.swift` | **62** | `MomoiOSPushKit`, `UserNotifications` (1-2행) | `MomoiOSPushKit`만 | NSE 타깃, 위 entitlement |
| 합계 | **391** | | | |

- **329 + 62 = 391** — D7의 산술은 맞다.
- `PushNotification.swift`의 import가 `Foundation`·`Security`뿐이라는 D7 주장: **실측 참**. UIKit/SwiftUI/UserNotifications 모두 0회.
- `NotificationService.swift`는 `UserNotifications`를 import하지만 이는 NSE 기반 클래스(`UNNotificationServiceExtension`)를 상속하려면 불가피하고, UI 프레임워크가 아니다. D7의 "호스트 프레임워크와 무관" 주장과 모순되지 않는다.
- **왜 이게 이식성에 결정적인가(구조적 근거):** `Package.swift:27-30`에서 `MomoiOSPushKit` 타깃은 `dependencies`를 **선언하지 않는다**. 같은 패키지의 `MomoiOSKit` 타깃은 `MomoCore`·`SwiftCentrifuge`·`LiveKit`에 의존한다(`Package.swift:17-26`). 즉 푸시 파싱·Keychain·REST fetch 계층은 앱의 실시간/미디어/도메인 스택과 **컴파일 단위로 분리돼 있다**. NSE는 별도 프로세스·별도 바이너리이므로 호스트 앱이 RN이 되어도 이 타깃만 링크하면 된다. 이식성은 "import가 적어서"가 아니라 **의존 그래프의 리프이기 때문에** 성립한다 — 전자는 후자의 증상이다.

**실측한 의존 표면 상세(`PushNotification.swift`):**

| 표면 | 위치 | 이식 시 요구사항 |
|---|---|---|
| Keychain (`SecItemCopyMatching`/`Add`/`Update`/`Delete`) | 43·53·59·63행 | `keychain-access-groups` entitlement가 앱·NSE 양쪽에 동일 값으로 |
| Keychain access group 값을 Info.plist에서 읽음 | 30-32행 (`Bundle.main.object(forInfoDictionaryKey:)`) | NSE Info.plist에 `MomoKeychainAccessGroup` 키 필요 |
| `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` | 58행 | 기기 잠금 상태에서도 NSE가 읽을 수 있어야 하므로 이 접근성 등급이 load-bearing |
| `URLSession` REST fetch | 316행 | NSE에 네트워크 권한(별도 entitlement 불필요), 서버 도달성 |
| 페이로드 스키마 가드 | 180행 `payload.schema == "momo.push.notification.v2"` | 서버가 보내는 스키마 문자열과 정확히 일치해야 함(§6에서 일치 확인) |
| App Group | **런타임 사용 없음** — 5행에 상수 선언만 | §2.3 참조 |

### 2.2 그대로 생존하지 **않는** 것 — 네 번째 걸음(알림 액션 승인)

| 파일 | 줄수 | import (실측) | 생존 여부 |
|---|---:|---|---|
| `clients/iOS/XcodeHost/PushNotificationCoordinator.swift` | **267** | `MomoiOSKit`, `MomoiOSPushKit`, `OSLog`, `UIKit`, `UserNotifications` | **불가** — `MomoiOSKit` + `UIKit` 앱 델리게이트 |
| `clients/iOS/MomoiOSKit/Sources/MomoiOSKit/PushRegistration.swift` | **215** | `Foundation`, `MomoCore`, `MomoiOSPushKit`, `Observation` | **불가** — `MomoCore` |
| `clients/iOS/MomoiOSKit/Sources/MomoiOSKit/IOSPushActionExecutor.swift` | **75** | `Foundation`, `MomoCore`, `MomoiOSPushKit` | **불가** — `MomoCore` |
| `clients/iOS/MomoiOSKit/Sources/MomoiOSKit/IOSNotificationPreferences.swift` | **121** | `Foundation`, `MomoiOSPushKit`, `UserNotifications`(63행, `#if os(iOS)`) | **조건부 가능** — `MomoiOSPushKit`만 의존. App Group 사용부(43행)만 교체하면 이식 가능 |
| 합계 | **678** | | |

이 4개 파일이 게이트 4의 네 번째 걸음을 나눠 갖고 있다:

1. **카테고리/액션 등록** — `IOSNotificationCategoryRegistry`(`IOSNotificationPreferences.swift:66`). Approve/Reject 버튼을 `UNNotificationAction`으로 정의하고 둘 다 `options: [.authenticationRequired]`를 건다(즉 잠금 화면에서 누르면 인증을 요구). **이 파일은 `MomoCore`를 import하지 않는다** — 감사 전 예상과 달리 액션 정의 자체는 거의 이식 가능하다. 걸림돌은 43행의 `UserDefaults(suiteName: MomoPushContract.appGroupIdentifier)!` 하나뿐이다.
2. **액션 수신** — `MomoiOSAppDelegate.userNotificationCenter(_:didReceive:)`(`PushNotificationCoordinator.swift:62-107`). `response.actionIdentifier`로 분기해 approve/reject/quickReply를 처리한다. **이것이 RN 라이브러리 선택의 핵심 충돌 지점이다**(§5): 이 콜백은 `UNUserNotificationCenter.delegate`를 잡아야 동작하는데(`:18행`에서 `center.delegate = self`), 푸시 라이브러리가 델리게이트를 가져가면 이 분기가 죽는다.
3. **액션 실행** — `IOSPushActionExecutor.perform`(`IOSPushActionExecutor.swift:24-`, 워크스페이스 검사 `:29-31`). `MomoCore`의 `ChannelID`/`MessageID`/`DraftMessage`/`IOSConversationBackend`에 묶여 있다. RN에서는 **JS/TS로 REST를 직접 치는 재작성**이 자연스럽고, 그 편이 포팅보다 싸다(이 75줄은 도메인 타입 변환이 대부분이라 옮길 실질 로직이 적다).
4. **디바이스 토큰 등록** — `MomoPushRegistrationClient`(`PushRegistration.swift:34`) + 코디네이터의 재시도 정책(`:185-227`, 즉시 2회 + 포그라운드 복귀 1회). 등록 자체는 REST 한 방이라 JS로 옮기기 쉽지만, **재시도 정책은 실측 가치가 있는 자산**이므로 옮길 때 규칙을 잃지 않도록 §7에 위험으로 적었다.

**요약:** 승계되는 것은 "푸시를 이해하고 내용을 채워 넣는 부분"이고, 승계되지 않는 것은 "앱과 서버에 행동을 일으키는 부분"이다. 후자는 RN에서 어차피 JS 쪽에 있어야 자연스럽다 — 따라서 이 678줄이 살아남지 못하는 것은 **손실이라기보다 경계 재배치**다. 다만 D7이 그 재배치 비용을 계상하지 않은 것은 사실이다.

### 2.3 App Group에 대한 정정 — ADR 서술과 실측이 어긋난다

ADR-0137:20은 승계 자산을 "NSE 62줄 + `PushNotification.swift` 329줄 + **App Group** + fastlane/match"로 열거한다. 실측 결과 **NSE의 실행 경로는 App Group을 쓰지 않는다**:

- `NotificationService.swift`가 세션을 읽는 곳은 21-25행의 `MomoKeychainValueStore()` — **Keychain**이다. `UserDefaults`를 건드리지 않는다.
- `group.app.momo.ios`를 실제로 소비하는 코드는 전부 앱 타깃 쪽이다: `SessionStore.swift:18`, `IOSNotificationPreferences.swift:43`. 둘 다 `UserDefaults(suiteName:)`.
- `MomoiOSPushKit` 안에서는 5행의 **상수 선언뿐**이고 참조하는 코드가 없다.
- NSE의 entitlement 파일에는 App Group이 **선언돼 있다**(`clients/iOS/NotificationService/MomoiOSNotificationService.entitlements:5-8`). 즉 선언은 있는데 그 프로세스의 코드가 쓰지 않는다.

**따라서 앱↔NSE 사이의 load-bearing 공유 채널은 App Group이 아니라 Keychain access group(`$(AppIdentifierPrefix)app.momo.ios.shared`)이다.** 이식 시 반드시 살려야 하는 것은 후자다. 이것은 실무적으로 중요한 차이다 — App Group만 맞추고 Keychain access group을 놓치면 NSE는 크래시 없이 **조용히 fail-open**해서 placeholder("momo / 새 알림")만 계속 띄운다(`NotificationService.swift:26-30`의 `else` 분기). 증상이 "푸시는 오는데 내용이 안 채워짐"으로 나타나므로 원인 추적이 어렵다.

**미검증(측정 필요):** `IOSNotificationPreferences.swift:43`과 `SessionStore.swift:18`은 `UserDefaults(suiteName:)`를 **강제 언랩(`!`)** 한다. App Group entitlement가 없는 빌드에서 이 이니셜라이저가 `nil`을 반환하는지 여부는 Apple 문서가 명시하지 않는다(문서화된 `nil` 반환 조건은 suiteName이 번들 ID이거나 `globalDomain`인 경우뿐). `nil`이라면 **앱이 즉시 크래시**한다. RN 이식에서 App Group을 뺄지 말지는 이 동작을 실측한 뒤 정해야 한다 — 추측으로 빼면 부팅 크래시를 만들 수 있다.

---

## 3. RN 프로젝트에 NSE를 부착하는 절차 (미검증 설계)

> 아래는 §2·§4에서 실측한 현재 구성으로부터 도출한 절차다. **RN 프로젝트에서 실행해 검증한 바 없다.** 각 단계의 근거가 되는 실측값은 괄호로 달았다.

### 3.1 bare RN이 유리하게 작용하는 지점

bare RN은 `ios/` 디렉터리와 `.xcodeproj`를 **레포에 체크인해 우리가 소유한다**. 이것이 Tauri와의 결정적 차이이고(§4.1), NSE 부착을 "Xcode에서 타깃 하나 추가"라는 평범한 작업으로 만든다. 구체적으로:

- **타깃 추가가 영구적이다.** 생성기가 프로젝트를 다시 만들지 않으므로 손으로 추가한 타깃·entitlement·빌드 페이즈가 지워지지 않는다.
- **CocoaPods와 교차하지 않는다.** `MomoiOSPushKit`은 외부 의존이 0이므로(`Package.swift:27-30`) NSE 타깃에 **로컬 SPM 패키지로** 붙이면 되고, RN의 Pods 그래프를 전혀 건드리지 않는다. NSE 타깃은 RN pods를 상속하지 않아야 한다.
- **현재 Xcode 구성이 그대로 청사진이 된다.** 아래 값들은 이미 이 레포에 존재하고 동작 이력이 있다.

### 3.2 단계

1. **NSE 타깃 생성** — Xcode `File > New > Target > Notification Service Extension`. 생성되는 스텁 `NotificationService.swift`는 버리고 우리 62줄로 교체한다.
2. **번들 ID 규칙** — 확장 번들 ID는 앱 번들 ID의 **접두 관계**여야 한다. 현재 실측값: 앱 `app.momo.ios`(`project.pbxproj:314,345`), NSE `app.momo.ios.NotificationService`(`:410,439`). RN 앱의 번들 ID가 달라지면 NSE도 같이 바꾼다.
3. **`MomoiOSPushKit` 링크** — `clients/iOS/MomoiOSKit`을 로컬 SPM 패키지로 추가하고 **`MomoiOSPushKit` 프로덕트만** NSE 타깃에 링크한다(`MomoiOSKit` 프로덕트를 링크하면 LiveKit·Centrifuge까지 딸려와 NSE 메모리 예산을 위협한다).
4. **Entitlements — 앱 타깃** (`clients/iOS/XcodeHost/MomoiOS.entitlements` 실측값 복제):
   - `aps-environment` = `$(APS_ENVIRONMENT)` (빌드 설정에서 Debug=`development`, Release=`production` — `project.pbxproj:299,329`)
   - `keychain-access-groups` = `$(AppIdentifierPrefix)app.momo.ios.shared`
   - `com.apple.security.application-groups` = `group.app.momo.ios` (§2.3의 미검증 항목 확인 전까지는 유지)
5. **Entitlements — NSE 타깃** (`MomoiOSNotificationService.entitlements` 실측값 복제):
   - `keychain-access-groups` = 앱과 **동일 문자열** ← 이것이 승계의 급소(§2.3)
   - App Group은 앱과 동일 값(현재 선언돼 있음)
6. **NSE Info.plist** — 실측 필수 키 3종:
   - `NSExtension.NSExtensionPointIdentifier` = `com.apple.usernotifications.service`
   - `NSExtension.NSExtensionPrincipalClass` = `$(PRODUCT_MODULE_NAME).NotificationService`
   - **`MomoKeychainAccessGroup`** = `$(AppIdentifierPrefix)app.momo.ios.shared` ← `PushNotification.swift:30-32`가 이 키를 읽는다. **누락 시 access group이 `nil`이 되어 Keychain 조회가 조용히 실패한다.** RN 스캐폴드가 만드는 기본 Info.plist에는 당연히 없으므로 가장 놓치기 쉬운 항목이다.
7. **Embed 빌드 페이즈** — 앱 타깃에 `Embed App Extensions`(현재 `project.pbxproj:35-46`)로 `.appex` 포함. Xcode가 타깃 추가 시 자동 생성하지만 존재를 확인한다.
8. **App ID 등록 + 서명** — §4.2. 이 단계가 현재 가장 미비하다.
9. **앱 델리게이트 배선** — `UNUserNotificationCenter.current().delegate` 설정과 카테고리 등록(`PushNotificationCoordinator.swift:17-19`에 해당). RN에서 이 자리를 누가 갖는지가 §5의 판단 축이다.

---

## 4. Tauri가 죽은 지점과 우리가 지켜야 할 것

### 4.1 기전(mechanism)

ADR-0137:12은 Tauri 기각 사유 중 하나로 **"ADR-0120이 요구하는 NSE가 Tauri iOS CI 서명에서 entitlement 유실(#15663 open)"**을 든다. **업스트림 이슈 자체는 이 감사에서 독립 검증하지 않았다**(레포 밖 사실, ADR 인용 그대로).

다만 기전은 레포 안에서 대조할 수 있다. Tauri 2 모바일은 `gen/apple`의 Xcode 프로젝트를 **생성물로 취급**한다 — 즉 프로젝트 파일이 재생성 대상이다. 손으로 추가한 확장 타깃과 entitlement는 생성기의 산출 모델에 없으므로, 재생성·CI 클린 빌드 경로에서 유실되거나 서명 단계에서 프로파일이 매칭되지 않는다. 반면 **bare RN의 `ios/`는 체크인된 소스**다. 이 차이가 D7의 승계 주장이 성립하는 진짜 근거이고, `import`가 몇 개인지보다 상위의 이유다.

### 4.2 우리 레포에 이미 같은 함정이 있다 — 실측

기전을 알았으니 우리 쪽을 같은 기준으로 재면, **배포 레인은 현재 NSE를 통과시킬 수 없다**:

| 항목 | 실측값 | 위치 |
|---|---|---|
| match가 프로비저닝하는 app identifier | `["com.dawnkim.momo"]` — **1개** | `fastlane/Fastfile:51`(beta), `:77`(release), `fastlane/Matchfile:11`, `fastlane/Appfile:5` |
| Xcode 앱 타깃 번들 ID | `app.momo.ios` | `clients/iOS/MomoiOS.xcodeproj/project.pbxproj:314,345` |
| Xcode NSE 타깃 번들 ID | `app.momo.ios.NotificationService` | `project.pbxproj:410,439` |
| 코드 서명 방식 | `CODE_SIGN_STYLE = Automatic` (4개 컨피그 전부) | `project.pbxproj:303,333,398,426` |
| CI 워크플로에서 NSE 언급 | **0건** (`NotificationService`/`appex` grep 무결과) | `.github/workflows/` |

세 가지가 동시에 문제다:

1. **번들 ID 불일치.** match/Appfile의 `com.dawnkim.momo`와 Xcode의 `app.momo.ios`가 다르다. `Matchfile:12`와 `Appfile:5`에는 `⚠️ 실제 Bundle ID로 교체` 주석이 붙어 있어 **플레이스홀더가 교체되지 않은 상태**로 보인다. 어느 쪽이 정본인지는 이 감사로 판정할 수 없다(미확인).
2. **확장 번들 ID가 목록에 없다.** 앱 확장을 임베드한 앱은 앱과 확장 **각각**의 프로비저닝 프로파일이 필요하다. `app_identifier` 배열에 확장 ID가 없으면 `match(readonly: true)`가 확장 프로파일을 받아오지 못한다.
3. **`CODE_SIGN_STYLE = Automatic` + `match` + CI는 잘 어울리지 않는다.** match는 수동 프로파일을 전제로 하는 워크플로다. 로컬에서는 Xcode의 자동 서명이 개발자 계정으로 프로파일을 만들어 주므로 문제가 드러나지 않고, **CI에서만 터진다** — Tauri #15663이 보고된 형태와 같은 계열의 증상이다.

**이것은 추론이 아니라 파일에서 읽히는 상태다.** 다만 "CI에서 실제로 실패한다"는 것은 **실행으로 확인하지 않았다** — iOS 릴리즈 레인이 NSE를 포함해 성공한 이력이 있는지 이 감사에서는 확인하지 못했다(§7).

### 4.3 지켜야 할 것 (이 감사의 실질 산출)

1. **iOS `ios/` 디렉터리를 생성물로 만들지 마라.** 구체적으로 **`expo prebuild`를 iOS에 실행하지 마라.** ADR-0137:20이 "Android는 `expo prebuild --platform android`로 골격만 부트스트랩"이라고 정한 것은 타당하지만, **`--platform android` 플래그가 이 결정의 전부를 지탱한다.** 플래그 없는 `expo prebuild` 한 번이면 `ios/`가 재생성되어 NSE 타깃·entitlement·Info.plist 커스텀 키가 사라진다 — Tauri가 죽은 것과 문자 그대로 같은 사고다. CI와 문서에서 이를 강제할 것을 권고한다(예: `ios/` 재생성을 막는 가드, 또는 `expo prebuild` 직접 호출 금지 규칙).
2. **NSE를 CI 서명 경로에 명시적으로 태워라.** `app_identifier`에 확장 번들 ID를 추가하고, 번들 ID 플레이스홀더를 정본 값으로 교체한다. 이건 RN 전환과 무관하게 지금 필요한 수선이다.
3. **entitlement를 회귀 검사 대상으로 만들어라.** 빌드 산출 `.appex`의 서명된 entitlement에 `keychain-access-groups`가 남아 있는지 확인하는 검사를 릴리즈 레인에 넣는다(`codesign -d --entitlements` 계열). 유실이 조용하기 때문에(§2.3) 자동 검사가 아니면 못 잡는다.
4. **fail-open을 관측 가능하게 하라.** 현재 NSE는 세션이 없거나 파싱이 실패하면 placeholder를 그대로 내보낸다(`NotificationService.swift:26-30`). 이는 사용자 경험 측면에서 옳은 선택이지만, **이식 직후 검증 단계에서는 "동작함"과 "조용히 실패함"이 육안으로 구별되지 않는다.** 부착 검증 시 fetch 성공 여부를 판별할 수단을 미리 정해야 한다(§7).

---

## 5. 푸시 JS 라이브러리 비교 — 권고: `expo-notifications`

후보는 `expo-notifications`와 `@react-native-firebase/messaging` 둘. `Notifee` 계열은 사전 제외(§5.4에서 근거 갱신).

이 절의 근거는 **레포 밖 사실**이며 공식 문서와 라이브러리 소스에서 확인했다(조사 시점 2026-08-02). 각 주장에 출처를 붙였다. **레포 실측이 아니라 문서·소스 독해**임을 구분한다.

### 5.1 비교표

| 축 | `expo-notifications` | `@react-native-firebase/messaging` |
|---|---|---|
| **bare RN(EAS·prebuild 없음) 도입** | `expo` 패키지 필요(= `expo-modules-core`). `npx install-expo-modules`, AppDelegate에 Expo 구독자 배선, Podfile `use_expo_modules!`, babel/metro 프리셋. **EAS·prebuild 불필요** | `GoogleService-Info.plist`, AppDelegate `FirebaseApp.configure()`, `firebase.json`. **Podfile에 `use_frameworks! :linkage => :static` + `$RNFirebaseAsStaticFramework = true`** — RN pods 그래프 전반에 영향 |
| **D1(Expo 모듈 낱개 도입) 정합** | 정합. config plugin은 **prebuild 때만 실행**되므로 우리에겐 아예 돌지 않는다 — plugin을 쓰지 않고 Xcode로 직접 하는 것이 정상 경로가 된다 | 무관(Expo와 별개 생태계) |
| **우리 NSE 공존 — 별도 NSE 강제?** | **없음.** 패키지 iOS 트리에 NSE 없음 | **없음.** NSE는 사용자가 직접 만드는 것으로 문서화 |
| **우리 NSE 공존 — 델리게이트 (결정 축)** | **명시적으로 양보한다.** `NotificationCenterManager.init()`이 기존 delegate가 있으면 덮어쓰지 않고 로그만 남기고 반환. 대신 **공개 다중 델리게이트 API `addDelegate(_:)`** 제공(`willPresent`/`didReceive(response:)`/`didRegister` 등). **AppDelegate 스위즐링 없음** | **무조건 탈취한다.** `RNFBMessaging+UNUserNotificationCenter.m`이 `center.delegate`를 가져가고 기존 델리게이트를 **weak**로 잡아 체이닝. 추가로 `GULAppDelegateSwizzler` + 런타임 `class_addMethod`로 AppDelegate에 메서드 이식. **`FirebaseAppDelegateProxyEnabled=NO`로도 이 델리게이트 탈취는 못 막는다**(그건 GUL 스위즐러만 끈다) |
| **iOS silent push(`content-available`)** | 지원. `expo-task-manager` + `Notifications.registerTaskAsync()`. `UIBackgroundModes`에 `remote-notification` 필요 | 지원. `setBackgroundMessageHandler`. **iOS 제약 문서화**: Background App Refresh가 꺼져 있거나 저전력 모드면 미동작. 또 iOS는 앱을 백그라운드로 깨우며 **RN 루트 컴포넌트가 마운트**되어 부수효과가 발생 |
| **알림 액션(승인) (결정 축)** | **완전 지원.** `setNotificationCategoryAsync(id, actions)` + `addNotificationResponseReceivedListener`가 **`actionIdentifier`를 전달**. 액션 옵션 `isAuthenticationRequired`·`isDestructive`·`opensAppToForeground`가 우리 현행 `UNNotificationAction` 옵션과 **1:1 대응** | **불가.** 소스상 `UNNotificationDefaultActionIdentifier`일 때만 JS로 이벤트를 emit한다 — **커스텀 액션 식별자가 JS에 도달하지 않는다.** 2026-07-24 커밋 `2aec61ff`가 이 동작을 의도적으로 좁혔다. 카테고리 등록 API도 없음. 공식 문서는 이 용도로 **Notifee를 안내**(→ §5.4에서 사망) |
| **Android(FCM) — 게이트 6 대비** | `google-services.json` + `getDevicePushTokenAsync()`가 네이티브 FCM 토큰 반환 → 우리 서버가 FCM v1 API로 직접 발송(서비스 계정 키는 우리 보유). 채널 지원 | 본진. `getToken()`, 백그라운드 핸들러, `notification` 페이로드 자동 표시. 단 **액션 버튼은 Android에서도 Notifee로 안내** |
| **유지보수 상태** | 최신 `57.0.8`(2026-07-29). expo/expo 활발. New Architecture 완전 지원(SDK 55+는 New Arch 전용) | 최신 `26.0.0`(2026-07-29). 활발. **v26부터 New Architecture 필수**(레거시 브리지 제거, 미충족 시 `pod install` 실패). 최신 firebase-ios-sdk는 **Xcode 26.2 / Swift 6.2.3+ / macOS 15+** 요구 |
| **자격증명 소재 (결정 축)** | **우리 자격증명이 아무 데도 안 나간다.** 공식 문서: *"the `expo-notifications` API is push-service agnostic"*, 다른 서비스로 보내려면 `getDevicePushTokenAsync()`로 **네이티브 APNs 토큰**을 받으라고 명시. Expo 계정·EPNS·APNs 키 업로드 **전부 불필요**(`getExpoPushTokenAsync()`를 호출하지 않으면 됨) | **APNs 인증 키를 Firebase 콘솔에 업로드해야 한다** — FCM→iOS가 동작하려면 필수라고 문서가 명시. 우리 APNs 서명 키를 Google에 넘기는 것 |

### 5.2 권고와 그 근거

**`expo-notifications`를 권고한다.** 결정은 세 축에서 갈리고, 셋 다 같은 방향이다.

1. **델리게이트 소유권** — 우리 승계 자산의 네 번째 걸음(§2.2)은 `UNUserNotificationCenter.delegate`가 우리 코드에 닿아야 성립한다. `expo-notifications`는 기존 델리게이트를 덮지 않고 `addDelegate(_:)`로 끼어들 자리를 준다. RNFirebase는 델리게이트를 무조건 가져가고 원본을 **weak**로만 잡는다(소스 주석이 dealloc 레이스를 인정한다). 우리처럼 **네이티브 델리게이트에 실제 로직이 있는** 앱에서 이 차이는 편의가 아니라 동작 여부다.
2. **알림 액션 승인이 RNFirebase에서는 아예 안 된다** — 이건 설정으로 우회할 수 있는 제약이 아니라 **소스에 박힌 동작**이다. 커스텀 `actionIdentifier`가 JS로 전달되지 않으므로, 게이트 4가 증명하라는 마지막 걸음이 이 라이브러리로는 JS 쪽에서 닫히지 않는다. 공식 우회책이 Notifee인데 Notifee는 아카이브됐다(§5.4).
3. **자격증명** — 우리는 현재 `relay/PushRelay`가 **ES256 JWT를 직접 서명해 `api.push.apple.com`으로 쏜다**(§6.1 실측). APNs 키는 우리 인프라에 있다. RNFirebase를 iOS 발송에 쓰려면 그 키를 Firebase에 업로드해야 하므로, **현재 성립해 있는 경계를 후퇴시킨다.**
   - **정확한 규범 인용**: ADR-0004의 문언은 **LLM provider 자격증명**(Codex OAuth·OpenAI 키)을 다루며 APNs 서명 키를 직접 명시하지 않는다. 따라서 "ADR-0004 위반"이라고 단정하는 것은 **확대 해석**이다. 직접 구속하는 것은 **ADR-0120 D2-A**(대화 내용이 Dawn 인프라를 지나지 않는다)이고, 이는 id-only 설계로 이미 충족된다. 그럼에도 APNs 키를 제3자에 업로드하는 것은 ADR-0004가 세운 **"자격증명은 소유자에 남는다"는 원칙과 같은 계열의 후퇴**이며, 경계 변경에 해당하므로 채택하려면 ADR이 선행해야 한다는 것이 이 감사의 판단이다.

**반대 방향의 유일한 비용**은 `expo` 패키지(= `expo-modules-core`)를 들여야 한다는 것이다. 다만 ADR-0137 D1이 이미 "Expo 모듈 낱개 도입"을 방침으로 정했으므로 새로 감수하는 비용이 아니다. 그리고 **config plugin은 prebuild에서만 실행되므로 우리에겐 돌지 않는다** — §4.3에서 금지한 `expo prebuild`(iOS)를 안 하는 한, plugin은 비활성 코드다. 참고로 `expo-notifications`의 iOS plugin이 하는 일은 세 가지뿐이고(`aps-environment` 설정, 커스텀 사운드 리소스 복사, `UIBackgroundModes`에 `remote-notification` 추가) **NSE·델리게이트·타깃 구조를 건드리지 않는다** — 셋 다 Xcode에서 손으로 하면 되는 일이라, plugin을 포기하는 대가가 사실상 없다.

### 5.3 이 권고에 붙는 조건 — 더 재야 할 것 1건

**`NotificationCenterManager.addDelegate(_:)`가 안정 공개 API인지 확인되지 않았다.** Swift `public`이고 용도가 명백하지만, **docs.expo.dev에 이 네이티브 다중 델리게이트 공존을 설명하는 산문 문서가 없다**(소스에서만 확인). 우리 권고 전체가 이 한 지점에 실린다. 따라서:

- 부착 스파이크에서 **가장 먼저 검증할 것**은 "우리 델리게이트 로직이 `addDelegate`로 붙어 `actionIdentifier`를 받는가"다. 이게 안 되면 권고가 흔들린다.
- 채택 시 **Expo SDK 버전을 고정**하고 업그레이드마다 이 지점을 재확인한다.
- 대안 경로(라이브러리 없이 가는 길)는 §5.5.

추가 미확인 2건: (a) `expo` 패키지를 이 프로젝트의 Podfile/Metro/Babel 구성에 넣었을 때 충돌이 없는지는 문서로 답할 수 없고 **실제 레포에서 스파이크**해야 한다. (b) **우리 NSE가 내용을 채운 뒤 포그라운드에서 `expo-notifications`의 `willPresent`가 도는 상호작용**은 어느 문서도 다루지 않는다 — 기기 테스트 필요.

### 5.4 Notifee 제외 근거 (갱신)

ADR-0137 D7은 `invertase/notifee`가 archived이고 README가 `expo-notifications` 이관을 권고한다고 적었다. **재확인 결과 사실이며, 상태가 더 확정적이다**: 저장소는 2026-04-07 아카이브(read-only), npm 최신은 `9.1.8`(2024-12-20 발행, 19개월 이상 정체). README는 *"Notifee is no longer actively maintained"*와 함께 `expo-notifications` 이관을 권고한다(또는 커뮤니티 포크 `react-native-notify-kit`).

이것이 §5.1의 알림 액션 축을 닫는다: **RNFirebase의 공식 답이 Notifee이고, Notifee의 공식 답이 `expo-notifications`다.**

### 5.5 관찰 — JS 라이브러리 없이 가는 길도 열려 있다

패킷이 지정한 후보는 2개지만, 실측에서 나온 사실 하나를 기록해 둔다. **우리는 토큰 수신·권한 요청·카테고리 등록·액션 수신을 이미 Swift로 전부 갖고 있다**(§2.2). RN에서 JS 라이브러리가 실제로 더해 주는 것은 "그 결과를 JS 상태로 넘기는 브리지"뿐이다. 즉 **작은 네이티브 모듈 하나로 대체 가능한 범위**다.

- 장점: 외부 의존 0, 델리게이트 소유권 분쟁 0, 승계 자산 100% 재사용.
- 단점: Android(게이트 6)를 위해 FCM 배선을 직접 짜야 하고, 권한·채널 같은 상용구를 우리가 유지한다.

**지금 이 선택지를 고르라는 뜻이 아니다.** 다만 `expo-notifications` 부착이 §5.3의 조건에서 막힐 경우 **폴백이 존재하며 그 비용이 감당 가능한 범위**임을 기록해 둔다 — 라이브러리 선택이 막다른 길이 아니라는 뜻이다.

---

## 6. 서버측 미이식·공백 (실측)

게이트 4의 한 바퀴는 서버가 id-only 페이로드를 실제로 쏴야 시작된다. 그 경로를 실측했다.

### 6.1 현재 발송 체인은 전부 Swift다

```
Swift NotifierWorker  ──HTTP POST /v1/push──▶  Swift PushRelay  ──HTTP/2──▶  APNs
 (momo.push.dispatch.v2)                        (momo.push.notification.v2)
```

- **APNs 발송 실체**: `relay/PushRelay/Sources/PushRelay/APNSSender.swift` — `api.push.apple.com`으로 HTTP/2 POST, ES256 JWT provider token. 엔드포인트 상수는 `relay/PushRelay/Sources/PushRelay/Config.swift`.
- **페이로드 구성 지점**: `relay/PushRelay/Sources/PushRelay/PushDispatch.swift:101-165`의 `APNSPayload`. **직접 확인한 실측 사실**:
  - `alert.title = "momo"`, `alert.body = "새 알림"`가 **하드코딩 상수**(`:103-105`) — 대화 내용이 페이로드에 들어가지 않는다. ADR-0120 D2-A(id-only)가 코드에서 지켜지고 있다.
  - `mutableContent = 1`, `contentAvailable = 1`이 하드코딩(`:112-113`). NSE 기동(mutable-content)과 백그라운드 깨우기(content-available)를 둘 다 켠다.
  - `schema = "momo.push.notification.v2"`(`:126`) — 클라이언트 가드(`PushNotification.swift:180`)와 **문자열 일치 확인**.
- **디바이스 등록 REST**: `POST/GET/DELETE /v1/workspaces/:ws/devices` — `server/Sources/MomoServer/Routes/DeviceRoutes.swift:42-44`. **Swift 서버에만 존재**.
- **DB 스키마는 준비돼 있다**: `schema_v0.sql`에 `device`(506-515행), `push_token`(517-529행), `push_dispatch_log`(532-544행) + RLS(556행).

### 6.2 Rust 서버에는 APNs가 없다 — 직접 확인

`server-rust/` 전체에 대해 `apns|api.push.apple.com|content-available|mutable-content|push_token`을 `*.rs` 대상으로 grep한 결과 **무결과**(직접 실행해 확인). 부수 확인:

- `server-rust/bins/momo-server/src/routes/mod.rs`가 나열하는 28개 라우트 모듈에 `devices`·`push` **없음**.
- `server-rust/bins/momo-notifier/src/lib.rs:13-14`가 명시한다: *"The third loop, the push-candidate drain (ADR-0120), is **not** here: the push relay contract is its own batch."* — 미이식이 **의도된 미완**이며 별도 배치로 계획돼 있다는 뜻이다.
- `server-rust/crates/momo-outbox/src/emit.rs:38,49`에 `OutboxKind::PushCandidate`(DB 라벨 `push_candidate`)가 존재하지만 **enqueue 쪽만**이다. `relay.rs:82`는 broadcast만 드레인하며 `push_candidate`는 "각자의 컨슈머 소유"라고 주석으로 배제한다. 즉 **Rust는 푸시 후보를 만들 수는 있으나 소비하는 주체가 Rust에 없다.**
- OpenAPI 미기재: `docs/api/openapi.yaml`에 devices 경로 없음. `docs/api/openapi.undocumented-allowlist.json`에 "구현됐으나 미문서화"로 등재돼 있다.

### 6.3 게이트 4 판정에 주는 영향

- **오늘 한 바퀴를 돌리는 것 자체는 가능하다** — Swift 서버 스택(NotifierWorker + PushRelay)이 살아 있으면 RN 클라이언트로도 id-only 푸시를 받아 NSE fetch까지 갈 수 있다. 즉 서버 미이식이 게이트 4를 **당장 막지는 않는다**.
- **그러나 "승계된다"는 결론의 유효기간은 Swift 서버의 수명과 같다.** Rust 이행이 완료되는 시점에 푸시 발송·디바이스 등록을 함께 이식하지 않으면, 클라이언트 NSE는 살아 있는데 깨울 주체가 사라진다. D7이 계상하지 않은 비용이며, 별도 배치로 이미 인지돼 있다(`momo-notifier/src/lib.rs:13-14`).
- **NSE fetch가 치는 REST 엔드포인트도 확인 필요**: `PushNotification.swift:289-294`는 `/v1/workspaces/{ws}/channels/{ch}/messages?limit=200`와 `/v1/workspaces/{ws}/roster`를 친다. 이 둘이 Rust 서버에 이식돼 있는지는 라우트 모듈명(`messages`, `roster`)으로 보아 존재하는 것으로 보이나 **응답 필드 호환성(`authorMemberId`, `displayName`)은 확인하지 않았다**(§7).

---

## 7. 위험·미확인 — 무엇을 더 재야 하는가

게이트 4를 PASS로 뒤집으려면 아래를 실측해야 한다. 우선순위 순.

### 7.1 기기/빌드가 있어야 풀리는 것

| # | 재야 할 것 | 방법 | 막히면 생기는 일 |
|---|---|---|---|
| 1 | RN 앱에 NSE 타깃을 붙여 **실제 기기에서 한 바퀴** (id-only→fetch→표시) | RN-S1 산출물 위에 §3 절차 수행 후 실기기 배포 | 게이트 4의 본체가 미증명으로 남음 |
| 2 | **알림 액션 승인**이 RN에서 동작하는지 — 구체적으로 `expo-notifications`의 `NotificationCenterManager.addDelegate(_:)`로 우리 델리게이트 로직을 붙여 `actionIdentifier`를 받는지(§5.3) | 카테고리 등록 + 액션 수신 경로 배선 후 기기에서 approve 1회 | D7이 주장한 "D2-A 그대로 생존"의 나머지 절반이 미증명. **실패 시 §5 권고가 흔들리며 폴백은 §5.5** |
| 3 | **CI 서명 레인이 `.appex`를 통과시키는지** | `app_identifier`에 확장 ID 추가 후 릴리즈 레인 1회 실행, 산출물 entitlement 검사 | §4.2의 함정이 실제 사고로 실현 |
| 4 | App Group entitlement 없이 `UserDefaults(suiteName:)`가 `nil`인지 | 최소 재현 빌드 | §2.3 — 잘못 빼면 부팅 크래시 |
| 5 | NSE의 **fail-open과 성공을 구별할 수단** | 검증용 판별 방법을 먼저 정한 뒤 1·2 수행 | "동작한다"는 오판 위험(가장 조용한 실패) |

### 7.2 코드/설정 조사로 풀리는 것

| # | 재야 할 것 | 왜 |
|---|---|---|
| 6 | 번들 ID 정본이 `com.dawnkim.momo`인지 `app.momo.ios`인지 | §4.2 — 플레이스홀더 미교체로 보이나 판정 불가 |
| 7 | iOS 릴리즈 레인이 NSE 포함 성공한 이력이 있는지 | 있으면 §4.2 위험이 과대평가일 수 있음 |
| 8 | Rust 서버의 `messages`/`roster` 응답이 NSE가 기대하는 필드(`authorMemberId`, `displayName`)를 주는지 | §6.3 — 어긋나면 Rust 이행 후 NSE가 조용히 placeholder로 회귀 |
| 9 | RN Info.plist에 `MomoAPNSEnvironment` 이전 여부 | 현재 `clients/iOS/XcodeHost/Info.plist:50`에 `$(APS_ENVIRONMENT)`로 정의돼 있고 `PushNotificationCoordinator.swift:196`이 읽는다. RN이 만드는 새 Info.plist에는 없으므로 **이전 누락 시 sandbox/production 판정이 `#if DEBUG` 폴백으로 떨어진다**(`:233-239`) — 릴리즈 빌드가 잘못된 APNs 환경으로 등록될 수 있다 |

### 7.3 승계 과정에서 잃기 쉬운 자산

- **디바이스 등록 재시도 정책**(`PushNotificationCoordinator.swift:185-227`): 즉시 2회 + 포그라운드 복귀 1회, `usedForegroundRetry`로 중복 방지. JS로 재작성할 때 이 규칙이 통째로 증발하기 쉽다. 등록 실패는 사용자에게 보이지 않으므로(푸시가 그냥 안 옴) 회귀를 늦게 발견한다.
- **액션의 `.authenticationRequired` 옵션**(`IOSNotificationPreferences.swift:78-87`의 approve/reject 정의): 잠금 화면에서 승인이 바로 되지 않도록 막는 안전장치다. 라이브러리 API로 카테고리를 재정의할 때 이 옵션이 누락되면 **보안 등급이 조용히 내려간다.**
- **워크스페이스 일치 검사**: `PushNotificationResolver.resolve`(`PushNotification.swift:245-247`)와 `IOSPushActionExecutor.perform`(`:31-33`), 코디네이터(`:169`) **세 곳**에서 중복 확인한다. 다른 워크스페이스의 푸시로 잘못된 승인이 나가는 것을 막는 방어다. 재작성 시 계층이 줄면 이 중복이 사라질 수 있다.

### 7.4 이 문서 자체의 한계

- 빌드·실행·기기 테스트를 **하지 않았다**. 모든 판단은 정적 읽기에 근거한다.
- Tauri #15663의 내용을 **독립 검증하지 않았다** — ADR-0137 인용을 그대로 옮겼다. §4.1의 기전 설명은 그 인용과 bare RN의 구조 대조에서 도출한 것이며, 업스트림 이슈 원문과 대조하지 않았다.
- `clients/mobile-spike/`(RN-S1 소유)는 **열지 않았다**. RN 쪽 실제 구성과의 대조는 다음 배치의 몫이다.
