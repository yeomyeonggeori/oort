# momo — iOS 서명 아이덴티티 런북 (사람이 직접, 1회)

> ## ✅ 현재 상태 (2026-08-04 실측 — 성재 재확인: "swift 때 다 줬다")
> 아래 §2의 "사람이 할 일"은 **대부분 이미 끝나 있다.** 세션마다 성재에게 다시 묻지 말 것.
>
> | 자산 | 상태 | 근거 |
> |---|---|---|
> | 서명 인증서 | ✅ 키체인에 유효 — Apple Distribution ×2 · Development · Developer ID (팀 `YWQQFQM38J`) | `security find-identity -v -p codesigning` |
> | App ID 2개 + Store 프로파일 | ✅ 앱(`app.momo.ios`)·NSE(`app.momo.ios.NotificationService`) **둘 다 App Store용 프로파일 존재**(Xcode 관리형) | `~/Library/Developer/Xcode/UserData/Provisioning Profiles/` (**신경로** — 구경로 `~/Library/MobileDevice/`는 비어 있으니 속지 말 것) |
> | APNs `.p8` | ✅ NCP push-relay에 배포·실작동(BadDeviceToken 수신 = provider token 인증 성공) | ROADMAP §0 푸시 절 |
> | App Group 연결 | 프로파일 디코드로 확인 미완 — `./scripts/verify_ios_signing.sh`로 검증 | — |
> | **CI 레인(fastlane/match)** | ❌ 비어 있음 — `momo-signing` repo 미생성 · GH Secrets 0건 | `gh secret list` 0건 (2026-08-04) |
> | **CI 레인(Xcode Cloud)** | ⚠️ 레포 준비 완료(#1115) · **ASC 콘솔 재지정만 성재 수동** | **§8** |
>
> **결론: 첫 TestFlight는 로컬 Xcode Organizer 업로드로 지금 가능하다**(Xcode에 계정 로그인됨). match/CI 자동화가 필요해지는 시점에만 성재에게 **ASC API Team Key 발급** 딱 한 가지를 요청한다.

> `docs/cicd/01-setup-runbook.md`(계정·API Key·Secrets 등록)를 먼저 끝낸 뒤 이 문서를 본다.
> 이 문서는 **어떤 번들 ID에 어떤 프로파일이 필요한가**만 다룬다.
> 자동 검사: `./scripts/verify_ios_signing.sh` (자격증명·네트워크 없이 돈다).

## 0. 정본 — 번들 ID 표

정본은 **Xcode 프로젝트**다. fastlane을 프로젝트에 맞춘다. 반대로 하면 이미 등록된
App ID·푸시 인증서·App Group·keychain access group이 전부 흔들린다.

| 타깃 | 종류 | 번들 ID | 프로파일 필요? | 근거 |
|---|---|---|---|---|
| MomoiOS | iOS 앱 | `app.momo.ios` | **필요** | `clients/iOS/MomoiOS.xcodeproj/project.pbxproj` |
| MomoiOSNotificationService | iOS 알림 확장(NSE) | `app.momo.ios.NotificationService` | **필요(별도)** | 같은 파일 |
| MomoiOSKitTests | 유닛 테스트 번들 | `app.momo.ios.tests` | 불필요 | `CODE_SIGNING_ALLOWED = NO` + `TEST_HOST` — 배포물에 안 들어간다 |
| MomoMac | macOS 앱 | `com.dawnkim.momo` | 필요(Developer ID) | `clients/macOS/MomoMac.xcodeproj/project.pbxproj` |

> `com.dawnkim.momo`는 **자리표시자가 아니라 macOS 앱의 실제 번들 ID**다. iOS 값과 다른 것이
> 정상이다. 과거 fastlane이 iOS 레인에서까지 이 값을 쓰고 있었던 것이 결함이었다.

**앱과 확장은 각각 App ID·각각 프로파일이 필요하다.** 하나로 뭉뚱그리면 확장이 서명되지
않는다. 그리고 로컬 게이트(`scripts/verify_ios_build.sh`)는 `CODE_SIGNING_ALLOWED=NO`로
돌기 때문에 **이 결함은 로컬에서 절대 안 드러나고 CI 아카이브에서만 터진다.**

## 1. 필요한 capability (App ID에 켜야 하는 것)

entitlements 파일이 요구하는 것 = 프로파일에 반드시 구워져 있어야 하는 것:

| entitlement | 값 | 앱 | NSE |
|---|---|---|---|
| `aps-environment` | `$(APS_ENVIRONMENT)` → Debug `development` / Release `production` | O | — |
| `com.apple.security.application-groups` | `group.app.momo.ios` | O | O |
| `keychain-access-groups` | `$(AppIdentifierPrefix)app.momo.ios.shared` | O | O |

- **App Group `group.app.momo.ios`는 Developer Portal에 먼저 만들어야 한다.** 앱/확장 App ID
  양쪽에 같은 그룹을 연결하지 않으면 서명은 통과하고 **런타임에 공유 저장소만 조용히 갈라진다**
  (푸시 페이로드·세션 경로). 이 대칭성은 `verify_ios_signing.sh`가 검사한다.
- `keychain-access-groups`는 팀 prefix(`$(AppIdentifierPrefix)`) 안이면 포털에 별도 토글이
  없고 프로파일에 자동 포함된다. **확인 지점**: 4단계 후 프로파일을 실제로 덤프해 눈으로 볼 것(§4).
- Push Notifications는 **앱 App ID에만** 켠다(NSE는 푸시를 받지 않고 가공만 한다).

## 2. Developer Portal / App Store Connect (사람, 1회)

1. **App Group 생성**: Certificates, Identifiers & Profiles → Identifiers → App Groups →
   `group.app.momo.ios`.
2. **explicit App ID 2개 등록**(와일드카드 불가 — 푸시·App Group 때문):
   - `app.momo.ios` — capability: **Push Notifications**, **App Groups**(위 그룹 연결)
   - `app.momo.ios.NotificationService` — capability: **App Groups**(같은 그룹 연결)
3. **APNs 키 발급**(팀 단위 `.p8`, Key ID 기록) — 서버 푸시 발송용.
4. **ASC 앱 레코드 생성**: 번들 ID `app.momo.ios`. 확장은 앱에 임베드되므로 **레코드를 만들지 않는다.**

> App ID를 미리 만들지 않아도 `match`가 생성해 주지만, **capability는 켜 주지 않는다.**
> 그래서 1~2를 먼저 하는 편이 재작업이 없다.

## 3. match 최초 동기화 (개발자 머신, 쓰기 권한 · 1회)

```bash
# docs/cicd/01-setup-runbook.md §2에서 이미 export 한 값들 그대로 사용
export MATCH_GIT_URL="https://github.com/Dawn-kim-official/momo-signing.git"
export MATCH_PASSWORD="<강한 패스프레이즈>"
export ASC_KEY_ID="..."; export ASC_ISSUER_ID="..."
export ASC_KEY_P8_BASE64="$(base64 -i AuthKey_XXXX.p8 | tr -d '\n')"

# iOS — Matchfile 기본값이 앱 + NSE 둘 다이므로 한 번에 처리된다.
bundle exec fastlane match appstore

# macOS — 번들 ID도 타입도 다르다. 반드시 명시해서 호출한다(Matchfile 기본값은 iOS다).
bundle exec fastlane match developer_id --platform macos --app_identifier com.dawnkim.momo
```

**무엇이 새로 생기는가**

| 어디 | 무엇 |
|---|---|
| Apple(팀) | Apple Distribution 인증서 1개(팀 공유), 없던 App ID 자동 생성 |
| Apple(프로파일) | `match AppStore app.momo.ios`, `match AppStore app.momo.ios.NotificationService`, `match Direct com.dawnkim.momo` |
| `momo-signing` repo | 위 인증서·프로파일이 `MATCH_PASSWORD`로 암호화되어 커밋됨 |
| 로컬 키체인 | 인증서 + 프로파일 설치 |

이후 **CI는 `readonly: true`**라 새로 만들지 못하고 내려받기만 한다. 프로파일이 없으면 CI는
만들어 내지 않고 **실패한다** — 의도된 동작이다(계정 오염·재현성).

## 4. 확인 (Apple 계정 불필요한 것 / 필요한 것)

```bash
# (a) 계정 없이 — 식별자 정합. CI·아무 머신에서나 돈다.
./scripts/verify_ios_signing.sh

# (b) 3단계 직후 — 프로파일에 App Group이 실제로 들어갔는지 눈으로 확인.
security cms -D -i ~/Library/MobileDevice/Provisioning\ Profiles/<UUID>.mobileprovision \
  | plutil -p - | sed -n '/Entitlements/,/}/p'
#   → application-identifier / aps-environment / application-groups /
#     keychain-access-groups 가 §1 표와 일치해야 한다. NSE 프로파일도 같은 방법으로 확인.

# (c) 게이트 PASS 후 — TestFlight 1회 리허설
bundle exec fastlane ios beta
```

## 5. 실패 증상 → 원인 → 조치

| 증상(CI 로그) | 원인 | 조치 |
|---|---|---|
| `No profile for team 'YWQQFQM38J' matching 'match AppStore app.momo.ios.NotificationService' found` | NSE 프로파일 미생성 | §3을 **쓰기 권한 머신**에서 재실행 |
| `Provisioning profile ... doesn't include the com.apple.security.application-groups entitlement` | App ID에 App Groups 미활성(또는 그룹 미연결) | §2에서 켠 뒤 `bundle exec fastlane match appstore --force` |
| `Provisioning profile ... doesn't include the aps-environment entitlement` | 앱 App ID에 Push 미활성 | §2-2 후 `--force` 재생성 |
| `error: exportArchive: No signing certificate "iOS Distribution" found` | `readonly: true`인데 저장소에 인증서 없음 | §3 최초 동기화가 안 된 것 |
| `Code signing "MomoiOSNotificationService.appex" failed` / 확장만 실패 | 확장 프로파일 누락 — 이 배치가 고친 결함 계열 | `verify_ios_signing.sh` 먼저 돌려 볼 것 |
| 빌드·업로드는 성공했는데 **기기에서 푸시가 안 옴** | Release 프로파일이 `development` APS를 담고 있음 | §4(b)로 `aps-environment` 확인 |
| `Authentication credentials are missing` | API Key 미주입 | `docs/cicd/01-setup-runbook.md` §5 |

## 6. `CODE_SIGN_STYLE` — 현재 판단 (변경 보류, 근거 첨부)

**현재 값**: iOS 앱·NSE의 Debug/Release 4개 설정 모두 `CODE_SIGN_STYLE = Automatic`,
`DEVELOPMENT_TEAM`은 채워져 있음(`clients/iOS/MomoiOS.xcodeproj/project.pbxproj`).

**이 배치에서 바꾸지 않았다.** 근거와 함께 남긴다.

### 왜 CI에서 문제가 되는가 (파일 기준)

1. `Automatic`은 Xcode가 **Developer Portal에 물어보고** 프로파일을 만들거나 갱신하는 방식이다.
   CI 러너에는 Xcode에 로그인된 Apple 계정이 없다.
2. 그 인가를 대신하려면 `xcodebuild -allowProvisioningUpdates` + 인증 키가 필요한데,
   `fastlane/Fastfile`의 `gym(...)` 호출에는 **`api_key:`도, `-allowProvisioningUpdates`(xcargs)도,
   `export_options`도 없다.** 즉 자동 서명이 인가를 얻을 경로가 없다.
3. 반대로 `match(readonly: true)`는 프로파일을 내려받아 설치할 뿐 **프로젝트의 서명 방식을
   바꾸지 않는다.** 그래서 "match는 수동 프로파일을 깔아 놨는데 프로젝트는 자동 서명을 시도"하는
   어긋난 상태가 된다.
4. 그리고 이 어긋남은 **로컬에서 관측되지 않는다** — `scripts/verify_ios_build.sh`가
   `CODE_SIGNING_ALLOWED=NO`로 빌드하므로 서명 코드가 한 번도 실행되지 않는다.

→ **`Automatic`이 CI 실패 원인이라는 심증은 파일로 뒷받침된다.** 다만 "무엇으로 바꿔야 정확히
맞는지"는 실제 프로파일 이름이 나와야 확정된다(§3 실행 결과).

### Manual로 간다면 함께 필요한 것 (한 세트로 움직여야 함)

1. `CODE_SIGN_STYLE = Manual` — **Release 설정만.** Debug는 `Automatic`으로 두어 로컬 기기
   빌드를 깨뜨리지 않는다.
2. `PROVISIONING_PROFILE_SPECIFIER`를 **타깃마다** 지정:
   - MomoiOS → `match AppStore app.momo.ios`
   - MomoiOSNotificationService → `match AppStore app.momo.ios.NotificationService`
   > `xcargs`로 넘기면 **모든 타깃에 같은 값**이 적용되어 확장이 앱 프로파일로 서명된다.
   > 그래서 프로젝트(또는 xcconfig) 레벨의 타깃별 설정이어야 한다. 이게 정확히 NSE가 죽는 지점이다.
3. `CODE_SIGN_IDENTITY = "Apple Distribution"` (Release).
4. `gym`에 export 매핑 추가:
   ```ruby
   export_options: {
     signingStyle: "manual",
     provisioningProfiles: {
       "app.momo.ios" => "match AppStore app.momo.ios",
       "app.momo.ios.NotificationService" => "match AppStore app.momo.ios.NotificationService"
     }
   }
   ```
   (match가 export하는 `MATCH_PROVISIONING_PROFILE_MAPPING` / `sigh_*_profile-name`을 써도 된다.)

### 왜 지금 안 바꿨나

- 프로파일 이름이 **실제로 무엇이 되는지**는 §3을 한 번 돌려야 확정된다. 추측한 이름을
  `PROVISIONING_PROFILE_SPECIFIER`에 박으면 CI가 같은 자리에서 다시 죽는다.
- Apple 계정 없이는 **검증할 수 없고**, 서명 설정은 로컬 게이트가 잡아 주지 않는 영역이다
  (`CODE_SIGNING_ALLOWED=NO`). 근거 없이 건드리면 로컬 기기 빌드까지 같이 죽는다.
- 식별자 정합(이 배치)은 Manual 전환의 **선행 조건**이다. 순서가 반대면 의미가 없다.

**후속**: §3 실행 → 프로파일 이름 확정 → Release만 Manual 전환 + gym 매핑 →
`verify_ios_signing.sh`에 "specifier ↔ 식별자 대응" 검사 추가.

## 7. 별건 관측 — `DEVELOPMENT_TEAM` (goal HYG-1에서 해소)

`clients/macOS/MomoMac.xcodeproj/project.pbxproj`의 `DEVELOPMENT_TEAM`이 **빈 문자열**이었다.
자동 서명 상태로 mac 릴리스 레인을 돌리면 팀을 못 골라, `verify_ios_signing.sh`가 매 실행
**비치명 WARN**을 냈다.

**goal HYG-1에서 채웠다** — Debug/Release 두 XCBuildConfiguration 모두 `YWQQFQM38J`.
iOS(`clients/iOS`)·RN(`clients/mobile/ios`) 프로젝트와 **같은 팀**이고, mac 번들 ID
`com.dawnkim.momo`도 같은 팀 소속이라 §0 표와 어긋나지 않는다. 이후 `verify_ios_signing.sh`는
**WARN 0**으로 PASS 한다.

주의: 이건 **팀 선택만** 푼 것이다. macOS 배포를 실제로 켜려면 Developer ID 인증서와
`match developer_id`(§3)가 별도로 서야 하고, 그건 Apple 계정이 있는 머신에서 1회 실행한다.
`CODE_SIGN_STYLE`은 여전히 `Automatic`이다(§6의 판단 유지).

## 8. Xcode Cloud — 이 레포의 유일한 자동 PR 체크 (정본)

> 여기가 이 문서에 새로 들어온 이유: **이 워크플로는 지금까지 어느 파일에도 적혀 있지
> 않았다.** 정의가 ASC 서버 레코드에만 있어서, PR마다 체크를 푸시하는 주체가 무엇인지
> 레포만 읽어서는 알 방법이 없었다(실측: `ci_scripts` 0건·설정파일 0건). §0의 "CI 레인만
> 비어 있다"는 서술이 절반만 맞았던 자리다 — fastlane 레인은 비어 있었지만, **Apple이
> 관리하는 레인 하나가 이미 돌고 있었다.**

### 8-1. 무엇이 어디에 있나

| 자산 | 값 | 사는 곳 |
|---|---|---|
| ASC 앱 레코드 | `momo` / **6792002019** | App Store Connect(서버) |
| 워크플로 | **"Default"** | 같은 곳. 레포에 정의 파일 없음 |
| 체크 이름 | `MomoiOS \| Default` | GitHub PR 체크(Xcode Cloud GitHub App이 푸시) |
| 현재 대상 | `clients/iOS`(**Swift — 퇴역 대상**, ADR-0145 증보 2) | — |
| 이관 대상 | `clients/mobile/ios/MomoMobile.xcworkspace` · scheme `MomoMobile` | 이 레포 |

`gh workflow list`에도, `.github/workflows/`에도 없다. GH Actions 3종은 전부
`workflow_dispatch` 수동이므로, **PR에 자동으로 붙는 체크는 이것 하나뿐이다.**

### 8-2. 승계가 성립하는 근거 (재조사 금지)

MomoMobile은 MomoiOS와 **팀·앱 번들·NSE 번들이 100% 동일**하다 —
`YWQQFQM38J` / `app.momo.ios` / `app.momo.ios.NotificationService`(§0 표와 같은 값).
Xcode Cloud는 Apple 관리형 서명이라 성립 조건이 "번들 + 팀 + capability 일치"인데
그게 이미 맞다. 따라서 **ASC 앱 레코드·App ID 2개·Push/App Group capability·APNs `.p8`이
전부 그대로 승계된다.** 새로 만들 것은 없고, 워크플로의 대상만 바꾸면 된다.

이 레인은 **`match`도 GH Secrets도 쓰지 않는다.** §3~§6은 fastlane 레인의 이야기이고,
Xcode Cloud는 Apple이 프로파일을 발급·설치한다. 두 레인이 같은 App ID를 공유하지만
서명 경로가 다르다는 뜻이다.

### 8-3. 레포가 책임지는 부분 (#1115에서 랜딩 — 사람 개입 불요)

| # | 파일 | 하는 일 |
|---|---|---|
| ① | `clients/mobile/ios/ci_scripts/ci_post_clone.sh` | node 확보 → `npm ci` → `bundle install` → `pod install`. **순서가 강제**된다(Podfile:1-21이 node에 하드 의존) |
| ② | `clients/mobile/ios/MomoMobile.xcworkspace/contents.xcworkspacedata` | 커밋됨. 워크플로 생성 화면이 **클론에 있는 것만** 고르게 해 주기 때문 |
| ③ | `clients/mobile/.node-version` | `22.11.0` — `package.json` `engines`와 같은 바닥값. ci_post_clone이 **하한**으로 읽는다 |
| ④ | `MomoMobile.xcodeproj/project.pbxproj` | `CODE_SIGN_IDENTITY[sdk=iphoneos*] = "iPhone Developer"` 4개 구성에서 제거(§8-5) |
| ⑤ | `clients/mobile/ios/ci_scripts/ci_post_xcodebuild.sh` | 아카이브의 NSE 임베드·**서명된 entitlement** 검증(`docs/cicd/11` §1 A·C를 기기에서 CI로 이관) |

**`ci_scripts/`는 반드시 워크스페이스 옆이다.** Xcode Cloud는 자기가 가리키는
프로젝트/워크스페이스와 **같은 디렉터리의** `ci_scripts/`만 읽는다. 모노레포 루트에 두면
조용히 무시되고, 빌드는 `node_modules` 없이 `xcodebuild`로 직행해 Podfile 안에서 죽는다.

로컬 리허설(자격증명 불요):

```bash
git clone <repo> /tmp/clean && cd /tmp/clean
./clients/mobile/ios/ci_scripts/ci_post_clone.sh
xcodebuild -workspace clients/mobile/ios/MomoMobile.xcworkspace -scheme MomoMobile \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

### 8-4. 성재 콘솔 절차 (5~10분, 시점 자유)

1. ASC → 앱(momo, 6792002019) → Xcode Cloud → 워크플로 "Default" → **Disable**
   *(지금 해도 된다. PR 소음이 즉시 멈춘다. **삭제하지 말 것** — 레코드를 RN용으로 재사용한다.)*
2. 같은 워크플로 **Edit** → 워크스페이스 `clients/mobile/ios/MomoMobile.xcworkspace`,
   scheme `MomoMobile` → 트리거(브랜치/PR) 설정 → **Apple 관리형 서명 동의** →
   (선택) TestFlight 액션·내부 테스터 그룹
3. 환경변수·compute 티어·알림은 그때 함께

> 2번의 워크스페이스 선택지는 §8-3 ②가 커밋되어 있어야 화면에 뜬다. 순서를 뒤집으면
> 고를 것이 없어서 막힌다.

### 8-5. `CODE_SIGN_IDENTITY` 잔재를 지운 이유

RN 프로젝트 템플릿이 남긴 `"CODE_SIGN_IDENTITY[sdk=iphoneos*]" = "iPhone Developer"`가
**프로젝트 레벨** Debug·Release 양쪽에 있었다. 실측(`xcodebuild -showBuildSettings`):

| | 제거 전 | 제거 후 |
|---|---|---|
| Debug/Release × 앱/NSE 4조합 | `iPhone Developer` | `Apple Development`(Xcode 기본값) |

두 가지가 걸린다. 첫째 `"iPhone Developer"`는 **2020년 이전 이름**이라 지금 인증서와는
Xcode의 하위호환 별칭으로만 이어져 있다. 둘째 그리고 더 중요하게, 이건 **릴리즈 구성에
개발 identity를 프로젝트 파일로 못 박은 것**이다 — 자동 서명이 아카이브 시점에 배포
identity로 갈아끼우려 할 때 프로젝트가 쓴 값은 사용자 지정 override로 남는다.
§6이 Swift 프로젝트에 대해 지적한 것과 같은 종류의 결함이고, 같은 이유로 **로컬에서는
절대 안 드러난다**(로컬 게이트는 `CODE_SIGN_IDENTITY=-` 또는 `CODE_SIGNING_ALLOWED=NO`로
돈다 — `build-sim.sh:57`, `verify_ios_build.sh`).

제거만 하고 아무 값도 넣지 않았다. Apple 관리형 서명은 **기본값 상태**를 기대하고,
어떤 프로파일 이름이 실제로 발급되는지는 §8-4를 한 번 돌려야 나온다(§6이 Manual 전환을
보류한 것과 같은 논리).

### 8-6. 알려진 함정 — `bundle exec pod install`은 커밋된 `Podfile.lock`을 다시 쓴다

**실측(2026-08-06, 클린 클론)**: `bundle install` → CocoaPods **1.15.2**가 서고,
`pod install`이 SPEC CHECKSUM 85줄 + `COCOAPODS:` 줄을 고쳐 쓴다. 커밋된
`Podfile.lock`은 **CocoaPods 1.17.0**이 쓴 것이기 때문이다. `Gemfile`의
`xcodeproj < 1.26.0` 핀이 bundler 쪽 CocoaPods를 1.15.2로 묶는 반면, 커밋된 lock은
bundler 밖의 시스템 `pod`으로 만들어졌다. 즉 **`bundle exec pod install`과 맨
`pod install`이 이 레포에서 서로 다른 lock을 만든다.**

빌드는 깨지지 않는다(클린 클론 검증 통과). 문제는 두 가지다 — lock이 권위가 아니게
되고, 부트스트랩을 돌린 사람이 **의도치 않은 lock 변경을 커밋하기 쉬워진다**.
`clients/mobile/Gemfile.lock`이 커밋되어 있지 않은 것이 뿌리이며, **락 결정은 #1101
계열(React-Core-prebuilt 경로 의존 desync)과 한 몸이라 #1115에서 건드리지 않았다.**

당분간의 규칙: `ci_post_clone.sh`를 로컬에서 리허설한 뒤에는
`git checkout -- clients/mobile/ios/Podfile.lock` 으로 되돌리고,
`clients/mobile/Gemfile.lock`은 커밋하지 않는다.
