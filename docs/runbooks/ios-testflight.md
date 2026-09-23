# iOS TestFlight 내부 배포 런북 (React Native)

> **대상:** `clients/mobile`(React Native, 앱 `app.momo.ios` + 알림 확장 `app.momo.ios.NotificationService`, 팀 `YWQQFQM38J`). 이슈 #2568.
>
> **범위는 TestFlight internal 뿐이다.** 게이트는 [배포 게이트 M7](../cicd/03-store-readiness-gate.md)의 내부 등급(M7-I)이다. 결정 근거는 ADR-0187과 2026-09-23 배포 레인 감사 §C다.
> - M7-I PASS 전에 올리는 빌드는 **증거 빌드**다. 빌드마다 owner(성재) 승인을 받고, owner 본인 기기에만 설치한다.
> - PASS 뒤에도 팀 대상 업로드는 건마다 승인을 받는다.
> - external TestFlight와 App Store 제출은 스토어 등급(M7-S) PASS 전에는 하지 않는다.
>
> **자동 배포 경로는 끈다.** ASC 내부 그룹의 자동 배포와 Xcode Cloud 워크플로의 TestFlight 액션이 켜져 있으면 업로드만으로 팀 배포가 된다. 업로드 전에 둘 다 꺼져 있는지 owner가 확인한다.
>
> 서명 자산·키 값은 문서·로그·PR에 적지 않는다. 이름과 존재만 적는다.

## 0. 흐름

1. §1 준비물을 확인한다.
2. main 커밋에서 `bash clients/mobile/scripts/archive-release.sh`로 아카이브·검사·로컬 IPA를 만든다(§3–§4).
3. owner 승인을 받고 §5의 두 경로 가운데 하나로 업로드한다.
4. ASC에서 처리가 끝나면 owner 1인 그룹에 빌드를 넣고 설치한다(§6).
5. APNs production 경로를 확인한다(§7).

## 1. 준비물

| 항목 | 기대 상태 | 확인 방법 |
|---|---|---|
| 개발자 팀 | `YWQQFQM38J` (Individual, 유료) | Apple Developer › Membership |
| ASC 앱 레코드 | 이름 `momo`, Apple ID `6792002019`, 번들 `app.momo.ios` | ASC › 앱 |
| 인증서 | 유효한 `Apple Distribution` 1개(2027-06-29 만료, 내보내기 서명)와 `Apple Development` 1개(2027-06-30 만료, 아카이브 서명) | `security find-identity -v -p codesigning` — 이름만 본다 |
| App Store 프로파일 | `iOS Team Store Provisioning Profile: app.momo.ios` (aps `production`, App Group `group.app.momo.ios`), `iOS Team Store Provisioning Profile: app.momo.ios.NotificationService` — 둘 다 Xcode 관리형, 2027-07-09 만료 | `~/Library/Developer/Xcode/UserData/Provisioning Profiles`. 스크립트가 이름으로 찾고, 없으면 멈춘다 |
| 개발 프로파일 | `iOS Team Provisioning Profile: app.momo.ios`, `iOS Team Provisioning Profile: app.momo.ios.NotificationService` — Xcode 관리형, 2027-07-17 만료. 아카이브 단계 서명에 쓰인다 | 같은 폴더. 스크립트가 같이 확인한다 |
| 도구 | Xcode 26.5, 시스템 CocoaPods `1.17.0`(= `Podfile.lock`의 `COCOAPODS`), node ≥ `clients/mobile/.node-version` | `xcodebuild -version`, `pod --version`, `node --version` |
| 업로드 인증 (§5 A) | Xcode › Settings › Accounts에 팀 계정이 로그인돼 있다 | 계정 화면. 세션이 살아 있는지는 로컬에서 확인할 수 없다 |
| 업로드 인증 (§5 B) | ASC API 키(`.p8`)와 Key ID, Issuer ID | ASC › Users and Access › Integrations. **2026-09-23 기준 Issuer ID 기록이 없다.** 이 Mac에 있는 두 번째 `.p8`이 ASC 키인지 APNs 키인지도 확인되지 않았다 |

- 키체인에 **폐기된** `Apple Distribution` 인증서가 같은 이름으로 하나 더 있다. 이름으로 서명하는 도구가 헷갈리지 않게 owner가 지운다.
- **momo 프로파일은 전부 Xcode 관리형이다**(`IsXcodeManaged=true`, 개발용·App Store용 모두). 그래서 수동 서명에는 쓸 수 없고 자동 서명만 된다(§4). 수동 프로파일을 새로 만드는 것은 이 런북의 범위가 아니다.
- `.p8` 파일은 `~/.momo-secrets/`에 권한 `0400`으로 둔다. 명령줄에는 경로만 쓰고 내용은 쓰지 않는다.
- 이 런북은 인증서·프로파일을 만들거나 폐기하지 않는다. 프로파일이 없거나 만료됐으면 멈추고 owner에게 넘긴다.

## 2. 빌드 번호 규칙

```text
BUILD = 3000 + (한국 시간 기준 날짜 − 2026-09-01) 일수
```

- 2026-09-23에 처음 올리는 빌드는 `3022`이다. 같은 날 다시 올리면 `--seq 1`로 `3022.1`, 그다음은 `--seq 2`로 `3022.2`를 쓴다. 다음 날은 `3023`이다.
- 규칙은 [`archive-release.sh`](../../clients/mobile/scripts/archive-release.sh)에 있고 `clients/mobile/__tests__/projectShape.test.ts`가 고정한다. 번호만 보려면 `bash clients/mobile/scripts/archive-release.sh --print-build-number`를 쓴다.
- **Xcode Cloud와의 관계.** Xcode Cloud는 자기 번호를 `CFBundleVersion`에 넣고 2000번대를 쓴다(빌드 2035·2039). 로컬 번호는 3000에서 시작하므로 겹치지 않는다.
- **ASC 조건.** 같은 `MARKETING_VERSION` 안에서는 이전 업로드보다 큰 번호만 받는다. Xcode Cloud로 다시 올리게 되면, owner가 Xcode Cloud의 다음 빌드 번호를 로컬 최신 번호보다 크게 올린다. 그러지 않으면 그 업로드가 반려된다.
- 규칙과 다른 번호가 꼭 필요하면 `MOMO_IOS_BUILD_NUMBER`로 직접 준다. 3000 이상이어야 하고 점은 하나까지 쓴다.
- 번호는 명령줄 `CURRENT_PROJECT_VERSION`으로 앱과 NSE에 같은 값이 들어간다. 프로젝트 파일의 `CURRENT_PROJECT_VERSION = 1`은 바꾸지 않는다.
- 업로드 ExportOptions에 `manageAppVersionAndBuildNumber=false`가 있어야 한다. 기본값(YES)이면 Xcode가 업로드 때 번호를 바꿀 수 있다.

## 3. Pods

**시스템 `pod`을 쓴다. `bundle exec pod install`은 쓰지 않는다.**
- `Gemfile`의 `xcodeproj < 1.26.0` 핀 때문에 bundler 쪽 CocoaPods는 `1.15.2`가 된다. 그러면 `pod install`이 커밋된 `Podfile.lock`(1.17.0이 씀)의 체크섬과 `COCOAPODS:` 줄을 다시 쓴다(2026-08-06 실측).
- 스크립트는 `pod --version`이 `Podfile.lock`의 `COCOAPODS`와 다르면 멈춘다. `ios/Pods`가 없거나 `Podfile.lock`과 어긋날 때만 `pod install`을 돌린다.
- `pod install` 뒤에 추적 파일이 바뀌면 스크립트가 멈춘다. `Podfile.lock`이 바뀌었으면 `git checkout -- clients/mobile/ios/Podfile.lock`으로 되돌리고 원인을 고친다. lock 변경은 커밋하지 않는다.
- `clients/mobile/ios/Pods/`는 gitignore 대상이다. 커밋하지 않는다.
- RN의 `pod install`은 `PrivacyInfo.xcprivacy`도 다시 쓴다. 커밋된 파일은 현 HEAD의 `pod install`이 만드는 순서와 같다. 의존성을 바꿔 이 파일이 달라지면 내용을 확인하고 의존성 변경과 같은 PR에 커밋한다.
- Xcode Cloud의 `ci_post_clone.sh`는 `bundle exec pod install`을 쓴다. 클라우드 체크아웃의 lock만 바뀌고 커밋되지 않으며 빌드는 된다. 알려진 차이다.

## 4. 아카이브와 검사

```bash
git fetch origin
git worktree add --detach "<작업 디렉터리>" origin/main
bash "<작업 디렉터리>/clients/mobile/scripts/archive-release.sh"
```

- **main 커밋이나 태그에서 만든다**(M7-I I-1). 공용 루트 체크아웃을 바꾸지 않도록 별도 워크트리를 쓴다. 스크립트는 `clients/mobile`이나 `packages/momo-core`에 커밋되지 않은 변경이 있으면 멈춘다. 새 워크트리에 `node_modules`나 `ios/Pods`가 없으면 스크립트가 lock대로 설치한다.
- 같은 날 다시 만들면 `--seq N`을 붙인다. 출력 위치를 정하려면 `--out DIR`을 쓴다(레포 밖만 된다). 기본은 새 임시 디렉터리다.
- **서명 — 두 단계.** momo 프로파일이 전부 Xcode 관리형이라(§1) Xcode의 표준 흐름을 그대로 쓴다. 2026-09-23 실측 결과다.
  - 아카이브는 자동 서명 그대로다. `Apple Development` 인증서와 개발 프로파일(`iOS Team Provisioning Profile: …`)이 쓰이고, 서명된 `aps-environment`는 `development`다.
  - 내보내기(`-exportArchive`, `signingStyle=automatic`)가 App Store 프로파일과 `Apple Distribution` 인증서로 다시 서명한다. 서명된 `aps-environment`는 `production`이 된다.
  - 두 단계 모두 `-allowProvisioningUpdates` 없이, Apple Developer 사이트와 통신하지 않고 끝난다. 인증서·프로파일도 만들지 않는다.
  - 막힌 길 두 가지: 수동 서명은 Xcode가 거부한다(`… is Xcode managed, but signing settings require a manually managed profile`). 자동 서명에 `CODE_SIGN_IDENTITY="Apple Distribution"`을 얹는 것도 거부한다(`… is automatically signed for development, but a conflicting code signing identity Apple Distribution has been manually specified`).
  - 프로젝트 파일에는 서명 설정을 넣지 않는다. Xcode Cloud의 Apple 관리형 서명이 기본값 상태를 기대하고, `projectShape.test.ts`가 이를 지킨다.
- **검사 — 올라갈 배포 서명본에.** 스크립트가 내보낸 IPA를 풀어 아카이브 모양(`export-as-archive/Products/Applications/MomoMobile.app`)으로 놓고 [`ci_post_xcodebuild.sh`](../../clients/mobile/ios/ci_scripts/ci_post_xcodebuild.sh)를 돌린다. Xcode Cloud가 빌드마다 돌리는 것과 같은 스크립트다. 다음을 확인한다.
  - NSE가 앱에 임베드됐다.
  - 앱과 NSE가 각자 자기 번들 ID로 서명됐다.
  - 서명된 엔타이틀먼트에 공유 키체인 그룹 `YWQQFQM38J.app.momo.ios.shared`가 있다.
  - NSE에는 `aps-environment`가 없다.
  - 앱의 서명된 `aps-environment`와 Info.plist `MomoAPNSEnvironment`가 모두 `production`이다.
  - 이어서 스크립트가 따로 확인하는 것: 앱·NSE의 `CFBundleVersion`이 빌드 번호와 같다. `ITSAppUsesNonExemptEncryption=false`와 권한 문구 3개(카메라·마이크·사진)가 들어 있다. 서명이 `Apple Distribution`이고 프로파일이 두 App Store 프로파일이다.
  - 앱 Info.plist에 `TFInternalTestingOnly=true`가 있다. `testFlightInternalTestingOnly=true`로 내보내면 Xcode가 넣는 키다(아카이브에는 없다). 서명된 번들 안에 있으므로 이 IPA는 어떤 경로로 올려도 내부 테스트 전용이다.
- 다시 검사하려면 `CI_ARCHIVE_PATH=<출력 디렉터리>/export-as-archive bash clients/mobile/ios/ci_scripts/ci_post_xcodebuild.sh`를 쓴다. 개발 서명인 `.xcarchive`를 가리키면 마지막 검사(APNs 환경 일치)에서 실패한다. 그 아카이브는 `development`로 서명돼 있기 때문이고, 정상이다.
- **산출물**(출력 디렉터리):

  | 파일 | 내용 |
  |---|---|
  | `MomoMobile-<build>.xcarchive` | 업로드할 아카이브(개발 서명. 업로드 때 다시 서명된다) |
  | `export/*.ipa` | 배포 서명으로 로컬에 내보낸 IPA. 업로드는 하지 않았다 |
  | `export-as-archive/` | 검사용으로 IPA를 푼 것 |
  | `ExportOptions-upload.plist` | §5에서 쓴다. `ExportOptions-export.plist`와 `destination`만 다르다 |
  | `build-info.txt` | M7-I I-1 사실: 커밋, 버전, 빌드 번호, 서명 인증서 이름, 프로파일 이름, `aps-environment`(아카이브·내보내기), `package-lock.json`·`Podfile.lock`·IPA SHA-256, 도구 버전 |
  | `archive.log`, `export.log`, `ci_post_xcodebuild.log` | 원문 로그 |

- Xcode 앱의 Product › Archive도 같은 자동 서명이라 아카이브 단계는 같다. 다만 빌드 번호 규칙, 커밋 확인, 배포 서명본 검사, 빌드 사실 기록은 스크립트만 한다. 그래서 스크립트를 쓴다.
- 실패하면 멈춘다. 서명 설정을 바꾸거나 `-allowProvisioningUpdates`를 더해 우회하지 않는다.

## 5. 업로드 — owner 승인 뒤, 건마다

**이 절의 명령은 #2568에서 실행하지 않았다(미검증).** 업로드 전에 두 가지를 남긴다. 승인은 성재의 발화를 그대로 인용해 PR이나 이슈에 적는다. 같은 자리에 `build-info.txt` 전문을 붙인다.

업로드용 ExportOptions에는 다음이 들어 있다.
- `method=app-store-connect`, `signingStyle=automatic`, `teamID=YWQQFQM38J`.
  - 설치된 App Store 프로파일이 Xcode 관리형이라 `manual`로는 쓸 수 없다(§4 서명).
  - 자동 서명 내보내기라 `provisioningProfiles`·`signingCertificate`는 넣지 않는다. Xcode가 `signingCertificate`를 거부한다.
- `testFlightInternalTestingOnly=true`: 이 빌드는 external TestFlight나 App Store로 가지 못한다.
- `manageAppVersionAndBuildNumber=false`: 번호를 바꾸지 않는다.

**`-allowProvisioningUpdates`의 부작용.** 이 플래그는 xcodebuild가 Xcode 계정이나 ASC 키로 Apple과 통신하게 한다. Xcode 26.5 도움말에 따르면 자동 서명 타깃에 대해서는 프로파일·App ID·인증서를 "만들고 갱신한다". 로컬 프로파일이 유효하면 그대로 쓰는 것이 보통이지만, 새 프로파일이나 클라우드 관리 배포 인증서가 생길 수 있다. 업로드를 owner가 직접 하거나 owner가 승인한 사람만 하는 이유다. 워커는 이 플래그를 쓰지 않는다.

### 경로 A — Xcode 계정 세션

```bash
xcodebuild -exportArchive \
  -archivePath "<출력 디렉터리>/MomoMobile-<build>.xcarchive" \
  -exportPath "<출력 디렉터리>/upload" \
  -exportOptionsPlist "<출력 디렉터리>/ExportOptions-upload.plist" \
  -allowProvisioningUpdates
```

- Xcode › Settings › Accounts에 로그인된 팀 계정을 쓴다. 위의 부작용 문단을 먼저 읽는다.
- GUI로 할 때는 `open "<출력 디렉터리>/MomoMobile-<build>.xcarchive"`로 Organizer를 연다. Distribute App에서 App Store Connect 업로드를 고르고, 내부 테스트 전용 선택지는 켜고, 버전·빌드 번호 관리는 끈다. 서명은 자동 그대로 둔다. 수동은 같은 이유로 쓸 수 없다.

### 경로 B — ASC API 키

```bash
xcodebuild -exportArchive \
  -archivePath "<출력 디렉터리>/MomoMobile-<build>.xcarchive" \
  -exportPath "<출력 디렉터리>/upload" \
  -exportOptionsPlist "<출력 디렉터리>/ExportOptions-upload.plist" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "<.p8 경로>" \
  -authenticationKeyID "<Key ID>" \
  -authenticationKeyIssuerID "<Issuer ID>"
```

- 키는 ASC › Users and Access › Integrations에 있는 App Store Connect API 키여야 한다. APNs 키로는 안 된다.
- §4에서 검사한 IPA를 그대로 올릴 수도 있다: `xcrun altool --upload-package "<출력 디렉터리>/export/oort.ipa" --api-key "<Key ID>" --api-issuer "<Issuer ID>" --p8-file-path "<.p8 경로>"`.
  - 다시 서명하지 않으므로 `-allowProvisioningUpdates`의 부작용이 없고, 검사한 바이트(`build-info.txt`의 `ipa_sha256`)가 그대로 올라간다.
  - 내부 테스트 전용 표지(`TFInternalTestingOnly=true`)는 IPA 안 앱 Info.plist에 들어 있다(§4 검사).
  - 이 명령도 실행하지 않았다(미검증).

### 업로드 뒤

- ASC › TestFlight에서 같은 빌드 번호가 처리 완료될 때까지 기다린다(보통 10–30분).
- 수출 규정 질문이 뜨면 멈춘다. `ITSAppUsesNonExemptEncryption=false`가 들어 있으면 뜨지 않아야 한다. 이 값의 근거는 §8에 있다.
- 처리 실패나 반려 메일(ITMS-…)이 오면 같은 번호로 다시 올리지 않는다. 원인을 이슈로 남긴다.

## 6. owner 1인 그룹

1. ASC › 앱 › TestFlight › 내부 테스팅에서 그룹을 하나 만든다(예: `owner-evidence`). 테스터는 owner 한 명만 넣는다.
2. 그룹의 **자동 배포를 끈다.** 새 빌드가 저절로 들어오면 안 된다. Xcode Cloud 워크플로에 TestFlight 액션이 있으면 그것도 끈다.
3. 처리가 끝난 빌드를 그룹에 **수동으로** 넣는다.
4. owner 기기의 TestFlight 앱에서 설치한다. 설치된 버전과 빌드가 `build-info.txt`와 같은지 본다.
5. 되돌리기(M7-I I-6): 문제가 있는 빌드는 그룹에서 뺀다. 이전 빌드를 TestFlight에서 다시 설치해 기동·로그인과 기존 데이터를 확인한다. 이미 설치된 빌드를 원격으로 지울 수 있다고 가정하지 않는다.

팀으로 넓히는 것은 M7-I PASS 뒤, 건마다 승인을 받고 한다.

## 7. APNs production 확인

TestFlight 빌드는 **production** APNs 토큰을 만든다. 네 곳이 모두 production이어야 알림이 온다.

| 자리 | 확인 |
|---|---|
| 서명된 앱 엔타이틀먼트 `aps-environment` | §4 검사가 `production`인지 확인한다(자동) |
| Info.plist `MomoAPNSEnvironment` | Release 구성이 `production`으로 채운다. 앱은 이 값으로 토큰을 production으로 등록한다(`src/push/native.ts`) |
| relay `MOMO_APNS_ENV` | `production`이어야 한다. 인스턴스당 값이 하나라 sandbox와 함께 쓰려면 컨테이너를 둘로 나눈다([12 §1·§5](../cicd/12-push-relay-deploy-runbook.md)) |
| APNs 인증 키 | 키의 환경 범위에 Production이 포함되는지 owner가 Apple Developer › Keys에서 확인한다 |

종단 확인 순서는 다음과 같다.
1. relay에 가짜 토큰으로 한 번 보낸다. `400 BadDeviceToken`이 오면 키·팀·환경이 맞는 것이다([12 §4-1](../cicd/12-push-relay-deploy-runbook.md)).
2. TestFlight 빌드를 설치한 실기기로 확인한다([11 §3](../cicd/11-ios-push-device-check.md)). M7-I I-4는 **앱이 종료된 상태**에서 푸시를 받고, 탭하면 해당 메시지로 가는 것까지 요구한다.
3. 실패는 두 가지로 구분한다.
   - 알림이 `oort / 새 알림` placeholder로만 오면 푸시는 도달했고 NSE가 fail-open한 것이다. 클라이언트 문제다.
   - 아무것도 오지 않으면 네 자리의 환경이 어긋났는지부터 본다.

## 8. 수출 규정 암호화 신고의 근거

`ITSAppUsesNonExemptEncryption=false`는 아래 사실에 기대고, `projectShape.test.ts`가 그 사실을 기계로 지킨다. 시험이 깨지면 값을 다시 판단한다.
- **통신.** OS의 TLS만 쓴다. `fetch`와 WebSocket(RN 네트워킹), NSE의 `URLSession`이고, ATS가 켜져 있다(`NSAllowsArbitraryLoads=false`).
- **저장 비밀.** 키체인(OS)에만 둔다(`react-native-keychain`, `MomoPushKit`).
- **자체 암호를 링크한 라이브러리.** MMKVCore(react-native-mmkv)가 유일하다. 앱은 `encryptionKey` 없이 한 인스턴스만 만든다(`src/storage/kv.ts`). 시험은 `encryptionKey`·`encrypt(`·`recrypt(`·WebCrypto `subtle` 사용을 막는다.
- **난수.** `crypto.getRandomValues`·`randomUUID`는 난수 생성일 뿐 암호화가 아니다.
- **그 밖.** crypto 계열 의존성과 네이티브 CryptoKit·CommonCrypto 호출이 없다.

## 9. Xcode Cloud (현행과 맞는 부분)

삭제된 `docs/cicd/10-ios-signing-identity-runbook.md` §8에서 지금도 맞는 부분만 옮겼다. 원문은 `git show ab0f0ca6^:docs/cicd/10-ios-signing-identity-runbook.md`로 읽는다.
- **무엇이 어디에 있나.** ASC 앱 레코드 `momo`(`6792002019`)에 워크플로 "Default"가 있다. 2026-08-09에 `clients/mobile/ios/MomoMobile.xcworkspace` · scheme `MomoMobile`로 재지정됐다. 정의는 ASC에만 있고 레포에는 없다.
- **레포가 책임지는 것**(#1115, #1122):
  - `clients/mobile/ios/ci_scripts/`의 두 스크립트. 반드시 워크스페이스 옆에 있어야 한다.
  - 커밋된 `contents.xcworkspacedata`와 `.node-version`.
  - 프로젝트 파일에 서명 identity가 없는 상태.
  - `projectShape.test.ts`가 이 넷을 지킨다.
- **지금 상태는 모른다.** 마지막 성공 체크는 2026-08-11이다(빌드 2035·2039 그린). 그 뒤 모바일 PR에는 Xcode Cloud 체크가 붙지 않았다. owner가 ASC에서 확인한다.
- **이 런북의 업로드 경로가 아니다.** M7-I에 따라 Xcode Cloud의 TestFlight 액션은 끈다. Xcode Cloud 재설정은 #2568 범위 밖이다.

## 10. 중단 기준

아래 가운데 하나라도 해당하면 업로드를 반복하거나 우회하지 않는다. 로그와 빌드 번호, 기기 iOS 버전만 남겨 이슈를 만든다.
- `ci_post_xcodebuild.sh`가 실패한다.
- 프로파일이나 인증서가 없거나 만료됐다.
- `Podfile.lock` 드리프트가 생긴다.
- 업로드가 반려되거나(ITMS-…) 처리에 실패한다.
- 수출 규정 질문이 뜬다.
- 실기기에서 푸시 환경이 맞지 않는다.
