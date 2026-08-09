# goal RN-N1 — NSE 이식 (ADR-0137 이행 순서 5, 푸시 승계)

너는 momo(제품명 oort) 레포의 구현 worker다. 이 문서가 유일한 지시서.
**base = `track/engine`**. 워크트리 `~/projects/momo-tracks/momo-worktrees/RN-N1-push`(브랜치 `feat/RN-N1-push`, 생성됨).

발단: ADR-0137 이행 순서 **5번** — "NSE 이식 + fastlane 수선 + TestFlight". 앞의 1~4가 끝났다(스파이크 전항 통과 · `momo-core` 추출 · RN 앱 · v0 UI 완결).

## 0. 먼저 읽어라 (이 배치는 **감사 결과가 이미 있다**)
- `docs/planning/2026-08-02-rn-push-inheritance-audit.md` — 게이트 4 감사 전문.
- `docs/adr/0137-mobile-react-native-migration.md` **D7 + 그 아래 「정오」 7항**. 정오가 중요하다:
  1. **"배포 레인은 살린다"는 원래 미성립이었고**, `scripts/verify_ios_signing.sh` 와 fastlane 식별자 교정이 이미 랜딩했다(PR #961). 지금은 앱·NSE 두 식별자가 프로비저닝 대상이다.
  2. **NSE 경로의 load-bearing 은 App Group 이 아니라 Keychain access group** (`kSecAttrAccessGroup`, `$(AppIdentifierPrefix)app.momo.ios.shared`). 혼동하면 **NSE 가 크래시 없이 조용히 fail-open** 해 placeholder 알림만 뜬다.
  3. **391줄은 한 바퀴 중 3/4만 덮는다.** 네 번째 걸음(알림 액션에서 승인)은 앱 타깃에 있고 상당 부분이 생존하지 않는다.
  4. 이식성의 근거는 import 개수가 아니라 **`MomoiOSPushKit` 이 의존성 0 인 SPM 리프 타깃**이라는 구조.
  5. **푸시 JS 라이브러리 = `expo-notifications` 로 이미 판정**(RNFirebase 는 커스텀 액션 식별자를 JS 로 안 넘기고 APNs 키의 Firebase 업로드를 요구해 실격). 남은 검증 1건: `NotificationCenterManager.addDelegate(_:)` 가 `public` 이지만 산문 문서가 없다 — **부착 시 최우선 확인 항목**이다.
  6. **서버 발송 경로는 Rust 로 이식됐다**(PR #963: devices REST + push_candidate drain + Ed25519 서명 relay hop, id-only 페이로드는 red test 로 고정). APNs 키는 **서버가 들지 않는다** — Dawn relay 경유가 ADR-0120 D1-A 의 구조적 필연이다.
- 오케스트레이터 실측(2026-08-02): Developer Portal 에 App ID 2개(`app.momo.ios`, `app.momo.ios.NotificationService`)와 capability(App Group `group.app.momo.ios` · `aps-environment` · keychain group `YWQQFQM38J.*`)가 **이미 존재**한다. 팀 `YWQQFQM38J`.

## 1. 규율
`.env`·자격증명 금지 · **서버 코드·`schema_v0.sql` 수정 금지** · **docker 금지** · **실서버·실APNs 발송 금지** · **`clients/web`·`clients/mobile-spike`·`packages/momo-core` 수정 금지** · **`clients/mobile/src/features/**` 및 `src/session/**` 수정 금지**(다른 배치가 소유한다 — 이 배치는 **네이티브 타깃·푸시 배선**이다) · **`clients/iOS` 는 읽기만**(동결된 킷에서 소스를 가져오되 원본을 고치지 마라) · `expo prebuild`·EAS·`android/` 금지 · **`match`/`fastlane` 실행 금지**(Apple 계정 필요, 성재 몫) · 커밋은 새 커밋만 · **PR 후 STOP**.

## 2. 할 일
1. **NSE 타깃을 `clients/mobile/ios` 에 추가.** 번들 ID `app.momo.ios.NotificationService`, 팀 `YWQQFQM38J`.
   - `clients/iOS` 의 `MomoiOSPushKit/PushNotification.swift`(329줄)와 `NotificationService.swift`(62줄)를 **승계**한다. 복사할지 SPM 로컬 패키지로 참조할지는 네 판단이되 **원본을 고치지 마라**.
   - entitlement: 앱 = `aps-environment` + App Groups + keychain group / **NSE = App Groups + keychain group만**(확장은 푸시를 받지 않고 가공만 한다).
   - **`MomoAPNSEnvironment`**(`$(APS_ENVIRONMENT)`) 를 RN 의 Info.plist 로 **이전**해라. 빠지면 릴리즈 빌드가 `#if DEBUG` 폴백으로 떨어져 **잘못된 APNs 환경으로 등록**된다(감사 §9).
2. **`expo-notifications` 배선** — 토큰 등록 + 알림 액션 수신. **`getExpoPushTokenAsync()` 를 호출하지 마라**(Expo 계정·EPNS 로 자격증명이 새는 경로다). `getDevicePushTokenAsync()` 로 **네이티브 APNs 토큰**을 받아 우리 서버의 devices REST 로 등록한다.
   - **`addDelegate(_:)` 를 최우선 검증**해라. 이게 안 되면 우리 NSE 와 공존이 깨진다 — 그때는 폴백을 감사 §5.3 에서 읽고 판단해 보고해라.
3. **`verify_ios_signing.sh` 가 계속 통과**해야 한다. 그 게이트는 **프로비저닝 호출 지점별**로 판정하며, 앱과 NSE 식별자 집합이 Xcode 정본과 동치여야 하고 **앱↔NSE 공유 entitlement 대칭**도 검사한다. 타깃을 추가하면 그 게이트가 판정 대상이 늘어난 것을 반영해야 한다.
4. **키체인 access group 을 실제로 적용**해라. 지금은 "이름만 두고 미적용" 상태다(entitlement 없이 적용하면 `SecItemAdd` 가 **기기에서만** `-34018`) — 이제 entitlement 를 붙이므로 적용할 수 있다. **단 시뮬레이터 애드혹 서명으로는 이 경로를 증명 못 한다**(`gate:session` 배치가 명시한 한계). 무엇이 시뮬에서 증명되고 무엇이 **기기에서만** 증명되는지 **PR 에 나눠 적어라**.

## 3. 증명할 것 / 넘길 것
- **시뮬레이터에서 가능**: 빌드 성공(앱+NSE 두 타깃) · entitlement 파일이 요구 항목을 담고 있음 · `verify_ios_signing.sh` 통과 · 토큰 등록 코드 경로(목) · 알림 액션 핸들러 배선(목).
- **기기에서만 가능(오케스트레이터/성재 몫)**: 실제 APNs 토큰 수신 · 공유 키체인 access group 동작 · id-only → NSE fetch → 표시 → **알림에서 승인** 한 바퀴.
→ 후자를 위해 **성재/오케스트레이터가 그대로 따라 할 절차**를 문서로 남겨라(무엇을 눌러 무엇을 확인하는지).

## 4. 검증
`npx tsc --noEmit` · `npx jest` · `gate:project-shape` · **`gate:session`** · `scripts/verify_ios_signing.sh` · **iOS 시뮬레이터 빌드 성공(두 타깃)**.
**회귀 0**: `packages/momo-core`·`clients/web` 수치 불변.

## 5. PR
`feat/RN-N1-push` → `track/engine`. 본문에: 타깃 구성·승계 방식(복사/참조)과 근거·entitlement 표·`addDelegate` 검증 결과·시뮬에서 증명된 것 vs 기기 대기·기기 확인 절차·이탈. **PR 후 STOP.**
