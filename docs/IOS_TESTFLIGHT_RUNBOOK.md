# iOS TestFlight internal 배포 런북

> **티켓:** MOMO-466 · **결정:** ADR-0123 D4 · **대상:** 성재 1인
>
> 이 문서에서 사람이 Apple Developer, Xcode, App Store Connect를 조작하는 단계는 모두 `[manual]`이다. Codex는 서명, archive, 업로드, 테스터 초대를 실행하거나 완료한 것으로 기록하지 않는다.
>
> 이 절차는 **internal dogfood 전용**이다. external TestFlight와 App Store 제출은 M7 사용성 검수 게이트 PASS 기록 전 실행하지 않는다.

## 0. 완료 상태

이 런북을 끝내면 다음 evidence가 남아야 한다.

| Evidence | 비밀정보 포함 금지 |
| --- | --- |
| Developer portal의 App ID 2개와 App Group 연결 화면 | 인증서, provisioning profile 원문 |
| Xcode 두 target의 Team, bundle ID, capability 화면 | Apple 계정 세션 정보 |
| Organizer upload 성공 화면과 App Store Connect build 번호 | API key, access token |
| internal tester 설치 화면 | 개인 연락처가 불필요하게 보이는 캡처 |
| 실기기 로그인, 알림 수신, NSE 교체, deep link, device row 체크 결과 | 비밀번호, bearer token, APNs token 원문 |

스크린샷은 repo 밖의 작업 evidence 폴더에 보관한다. 파일명 예시는 `01-app-ids.png`, `02-signing.png`, `03-upload.png`, `04-internal-tester.png`, `05-device-e2e.png`다.

## 1. 시작 전 확인

- [ ] `[manual]` 유료 Apple Developer Program의 Team `YWQQFQM38J`에 접근할 수 있다.
- [ ] `[manual]` Xcode 26에서 Apple 계정 로그인이 되어 있고 Team `YWQQFQM38J`가 보인다.
- [ ] `[manual]` App Store Connect에서 앱 생성과 TestFlight 테스터 관리 권한이 있다.
- [ ] `[manual]` 실기기에서 접근 가능한 momo 서버 URL을 정했다. §7의 LAN 또는 AWS internal alpha 중 하나를 사용한다.
- [ ] `[manual]` 업로드할 commit, `MARKETING_VERSION`, 중복되지 않는 `CURRENT_PROJECT_VERSION`을 기록했다.
- [ ] `[manual]` M7 PASS 전에는 external TestFlight, App Store 제출, `release-ios.yml` 실행을 하지 않는다.

### 1.1 internal dogfood 전용 교체 항목

현재 Release 구성에도 아래 개발 편의 기능이 들어 있다. internal TestFlight에서는 의도적으로 동작하지만 App Store 제출 전 별도 이슈에서 교체해야 한다.

- 세션 form, access token, refresh token을 App Group `UserDefaults`에 평문 저장한다. 스토어 제출 전 Keychain 기반 저장과 기존 값 migration으로 교체한다.
- 기본 로그인 form에 localhost URL과 개발용 예시 계정이 들어 있다. 스토어 제출 전 production 기본값과 안전한 초기 설정 흐름으로 교체한다.
- `NSAllowsLocalNetworking`과 로컬 네트워크 사용 설명은 LAN dogfood를 허용한다. 스토어 제출 전 HTTPS production endpoint를 기본으로 하고 필요한 ATS 범위만 남긴다.
- 계정 삭제, privacy manifest, UGC 신고·차단·운영 정책은 ADR-0123에서 M8로 이월됐다. 이 항목이 없으면 App Store 제출 준비 완료로 판정하지 않는다.

## 2. App ID와 App Group 등록

1. `[manual]` [Apple Developer](https://developer.apple.com/account/) → Certificates, Identifiers & Profiles → Identifiers에서 App IDs를 연다.
2. `[manual]` 명시적 App ID `app.momo.ios`를 등록한다. Capabilities에서 **Push Notifications**와 **App Groups**를 켠다.
   - 스크린샷: Identifier, Team, Push Notifications, App Groups가 한 화면에 보이게 캡처한다.
3. `[manual]` 명시적 App ID `app.momo.ios.NotificationService`를 등록하고 **App Groups**를 켠다.
   - 스크린샷: NSE Identifier와 App Groups 상태를 캡처한다.
4. `[manual]` Identifiers → App Groups에서 `group.app.momo.ios`를 등록한다.
5. `[manual]` App Group 설정에서 `app.momo.ios`와 `app.momo.ios.NotificationService` 두 App ID가 모두 연결됐는지 확인한다.
   - 스크린샷: App Group ID와 연결된 두 Identifier를 캡처한다.

이미 같은 Identifier가 있으면 새로 만들지 말고 Team과 capability를 대조한다. 다른 Team이 소유하거나 capability 계약이 다르면 임의로 suffix를 바꾸지 말고 작업을 중단한다.

## 3. Xcode 자동 서명 설정

1. `[manual]` `clients/iOS/MomoiOS.xcodeproj`를 Xcode 26으로 연다.
2. `[manual]` `MomoiOS` target → Signing & Capabilities에서 **Automatically manage signing**을 켜고 Team `YWQQFQM38J`를 선택한다.
3. `[manual]` bundle ID가 `app.momo.ios`, App Groups가 `group.app.momo.ios`, Push Notifications capability가 활성인지 확인한다.
4. `[manual]` `MomoiOSNotificationService` target에서도 자동 서명과 같은 Team을 선택한다. bundle ID는 `app.momo.ios.NotificationService`, App Group은 `group.app.momo.ios`여야 한다.
5. `[manual]` General에서 앱과 NSE의 Version을 맞추고, 이번 업로드의 Build를 이전 App Store Connect build보다 크게 올린다.
   - 스크린샷: 각 target의 Team, bundle ID, 자동 서명 체크, capabilities를 각각 캡처한다. provisioning profile UUID는 캡처하지 않는다.

Release는 `aps-environment=production`, Debug는 `development`로 빌드 설정이 분리돼 있다. archive 전에 Release 설정이 선택됐는지 확인한다.

## 4. 서명 없는 Release sanity

이 단계는 archive나 업로드가 아니다. repo root에서 시뮬레이터용 Release가 아이콘과 NSE를 포함해 컴파일되는지만 확인한다.

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
xcodebuild build \
  -project clients/iOS/MomoiOS.xcodeproj \
  -scheme MomoiOS \
  -configuration Release \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath ./build \
  CODE_SIGNING_ALLOWED=NO
```

- [ ] `** BUILD SUCCEEDED **`를 확인한다.
- [ ] 로그의 `CompileAssetCatalog` 또는 `actool` 단계에서 `AppIcon` 오류가 없다.
- [ ] build setting에 앱 `app.momo.ios`, NSE `app.momo.ios.NotificationService`가 보인다.

`./build`는 gitignore 대상이다. 이 sanity 결과는 서명 또는 실기기 설치 성공 evidence가 아니다.

## 5. App Store Connect 앱 레코드와 업로드

1. `[manual]` 첫 업로드라면 App Store Connect → My Apps → `+` → New App에서 iOS 앱을 만든다. Bundle ID는 `app.momo.ios`를 선택하고 내부 관리용 SKU를 정한다.
   - 스크린샷: 앱 이름, platform, bundle ID가 보이는 생성 확인 화면을 캡처한다.
2. `[manual]` Xcode의 run destination을 **Any iOS Device (arm64)** 또는 연결된 실기기로 바꾼다.
3. `[manual]` Product → Archive를 실행한다. Organizer가 열리면 archive의 Version, Build, Team, commit 기록과 일치하는지 확인한다.
   - 스크린샷: Organizer archive 행의 앱 이름, version, build, 생성 시각을 캡처한다.
4. `[manual]` Organizer → Distribute App → App Store Connect → Upload를 선택한다. Xcode validation 결과를 읽고 권한이나 entitlement 경고가 있으면 업로드를 중단한다.
5. `[manual]` Upload 완료 화면을 캡처한다. App Store Connect TestFlight에서 processing이 끝나 같은 build 번호가 나타날 때까지 확인한다.
   - 스크린샷: Organizer upload 성공 화면과 TestFlight build 행을 각각 캡처한다.

Export Compliance 질문이 나타나면 앱의 실제 암호화 사용과 조직 답변을 기준으로 사람이 응답한다. 추측으로 자동 선택하지 않는다.

## 6. TestFlight internal tester 등록

1. `[manual]` App Store Connect → 앱 → TestFlight → Internal Testing에서 internal group을 만든다. 예: `momo-dogfood`.
2. `[manual]` §5의 build를 group에 추가한다. processing 또는 compliance 응답이 남았으면 먼저 완료한다.
3. `[manual]` Users and Access에 등록된 internal tester를 group에 추가한다.
4. `[manual]` 실기기의 TestFlight 앱에서 초대를 수락하고 해당 build를 설치한다.
   - 스크린샷: group의 build 번호와 tester 수, 실기기 TestFlight의 설치된 version/build를 캡처한다.

internal tester는 App Store Connect 사용자다. 외부 이메일 초대가 필요해지면 external TestFlight 범위이므로 M7 PASS 전 진행하지 않는다.

## 7. 실기기에서 서버 연결

### 옵션 A: 같은 LAN의 Mac

1. `[manual]` Mac과 iPhone을 같은 신뢰 가능한 LAN에 연결한다. 공용 Wi-Fi는 사용하지 않는다.
2. `[manual]` momo 서버가 loopback만이 아니라 Mac의 LAN interface에서 수신하는지 확인하고 macOS 방화벽에서 해당 개발 서버 연결을 허용한다.
3. `[manual]` iPhone Safari에서 `http://<Mac-LAN-IP>:28180/health`처럼 실제 health URL을 열어 도달성을 먼저 확인한다.
4. `[manual]` 앱 로그인 화면에 `http://<Mac-LAN-IP>:28180`을 입력하고 로컬 네트워크 권한을 허용한다.

현재 앱은 `NSAllowsLocalNetworking`과 로컬 네트워크 사용 설명을 포함한다. 기기·OS 조합에서 ATS가 HTTP IP 연결을 막으면 `NSAllowsArbitraryLoads`로 넓히지 않는다. HTTPS reverse proxy 또는 옵션 B를 사용하고, 꼭 필요한 host만 허용하는 후속 이슈를 만든다.

### 옵션 B: AWS internal alpha

1. `[manual]` 유효한 TLS 인증서가 있는 AWS internal alpha HTTPS URL을 준비한다.
2. `[manual]` iPhone Safari에서 health URL과 인증서 신뢰를 확인한다.
3. `[manual]` 앱 로그인 화면에 `https://...` base URL을 입력한다.

AWS URL은 ATS 예외에 의존하지 않아 장기 dogfood에 권장된다. 어느 옵션이든 localhost와 `127.0.0.1`은 iPhone 자체를 가리키므로 Mac 서버 주소로 사용하지 않는다.

## 8. 실기기 E2E 체크리스트

테스트 중 앱을 foreground와 background에서 각각 한 번 확인한다. APNs token, access token, 비밀번호 원문은 스크린샷이나 로그에 남기지 않는다.

1. **로그인과 bootstrap**
   - [ ] `[manual]` §7의 서버 URL로 로그인하고 workspace, channel 목록, timeline이 로드되는지 확인한다.
   - [ ] `[manual]` 짧은 답장 1건을 보내 다른 클라이언트에서 같은 메시지와 순서를 확인한다.
   - 스크린샷: 서버 host 일부, workspace 이름, channel timeline을 캡처하되 계정 비밀번호는 가린다.
2. **알림 권한과 device 등록**
   - [ ] `[manual]` 알림 권한 prompt에서 허용하고 iOS Settings → Notifications → momo에서 알림이 켜졌는지 확인한다.
   - [ ] `[manual]` 운영 DB의 `device`와 `push_token`에서 로그인 member의 active 등록 행 1개를 확인한다. token 원문 대신 device ID, env, token suffix, `invalidated_at IS NULL`만 evidence에 남긴다.
   - 스크린샷: iOS 알림 설정과 redacted DB 조회 결과를 캡처한다.
3. **relay 실발송 수신**
   - [ ] `[manual]` 다른 member가 DM, mention, 또는 approval request를 1건 발생시킨다. 앱을 background로 둔 실기기에 실제 APNs 배너가 도착하는지 확인한다.
   - [ ] `[manual]` 중복 배너가 없고 표시 시각이 원 요청과 대응하는지 기록한다.
   - 스크린샷: 배너와 발신 이벤트를 함께 식별할 수 있게 캡처한다.
4. **NSE 내용 교체**
   - [ ] `[manual]` 배너 본문이 relay placeholder `새 알림`이 아니라 REST로 가져온 실제 메시지 요약인지 확인한다.
   - [ ] `[manual]` 서버를 잠시 사용할 수 없는 별도 실패 확인에서는 placeholder가 보존되는 fail-open 동작을 기록한다. 운영 중인 공유 서버를 중단하지 않는다.
   - 스크린샷: 성공 배너 본문을 캡처한다. 민감 메시지는 사용하지 않는다.
5. **탭 deep link**
   - [ ] `[manual]` 앱이 background인 상태와 종료된 상태에서 알림을 각각 탭한다.
   - [ ] `[manual]` 두 경우 모두 해당 workspace와 channel로 이동하고 대상 메시지가 timeline에서 보이는지 확인한다.
   - 스크린샷: 탭 전 배너와 탭 후 열린 channel을 캡처한다.
6. **로그아웃 정리**
   - [ ] `[manual]` 로그아웃 후 기존 device 등록이 revoke되어 `push_token.invalidated_at`이 채워지는지 확인한다.
   - [ ] `[manual]` 로그아웃한 기기에 새 알림이 더 이상 도착하지 않는지 확인한다.

## 9. 판정과 중단 기준

다음이 모두 충족되면 `INTERNAL_TESTFLIGHT_READY`로 기록한다.

- App ID 2개와 App Group이 Team `YWQQFQM38J`에서 정확히 연결됐다.
- Organizer upload와 TestFlight processing이 성공했고 version/build가 기록과 일치한다.
- 실기기에서 로그인, 알림 권한, active device row, 실 APNs 수신, NSE 내용 교체, cold/background deep link가 모두 PASS다.
- dev 전용 교체 항목과 M8 이월 항목을 완료로 오인하지 않았다.

Identifier, entitlement, signing, APNs production delivery, NSE 교체 중 하나라도 실패하면 `BLOCKED`로 기록하고 업로드 반복이나 capability 우회를 하지 않는다. 실패 화면, build 번호, 기기 iOS 버전, 서버 URL의 host만 남겨 별도 결함 이슈를 만든다.

## 10. 롤백

- `[manual]` 문제가 있는 build는 TestFlight group에서 제거하고 설치 중단을 알린다. 이미 설치된 build를 원격 삭제할 수 있다고 가정하지 않는다.
- `[manual]` 필요하면 App Store Connect에서 새 tester 접근을 중단한다.
- `[manual]` 앱에서 로그아웃해 device token을 revoke하고 DB의 `invalidated_at`을 확인한다.
- App ID, App Group, certificate를 즉시 삭제하지 않는다. 다른 build가 소비할 수 있으므로 별도 영향 확인 후 사람이 처리한다.
