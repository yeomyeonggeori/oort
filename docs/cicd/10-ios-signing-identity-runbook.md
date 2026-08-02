# momo — iOS 서명 아이덴티티 런북 (사람이 직접, 1회)

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

## 7. 별건 관측 (이 배치에서 안 고침)

`clients/macOS/MomoMac.xcodeproj/project.pbxproj`의 `DEVELOPMENT_TEAM`이 **빈 문자열**이다.
iOS 프로젝트에는 채워져 있다. 자동 서명 상태로 mac 릴리스 레인을 돌리면 팀을 못 고른다.
`verify_ios_signing.sh`가 **비치명 WARN**으로 계속 알려 준다. macOS 배포를 실제로 켜는 시점에
Developer ID 인증서와 함께 한 세트로 처리할 것.
