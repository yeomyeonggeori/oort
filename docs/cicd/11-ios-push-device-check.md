# 11 — iOS 푸시 기기 확인 절차 (goal RN-N1 / ADR-0137 이행 순서 5)

> **이 문서가 있는 이유**: 푸시 승계에서 **시뮬레이터로 증명할 수 없는 것**이 남는다.
> 그리고 그 남은 것들이 실패하는 방식은 전부 **조용하다** — 알림은 오는데 내용이
> "oort / 새 알림"(릴레이 placeholder)으로만 온다. 동작과 고장이 육안으로 구별되지
> 않으므로, 무엇을 눌러 무엇을 확인하는지 미리 적어 둔다(감사 2026-08-02 §4.3-4).

- 대상: 성재 / 오케스트레이터
- 선행: `feat/RN-N1-push` 가 `track/engine` 에 들어가 있을 것. Apple 계정 필요.
- 소요: 처음 1회 15~25분(프로비저닝 포함), 이후 5분.

---

## 0. 시뮬레이터에서 이미 증명된 것 (다시 하지 마라)

`npm --prefix clients/mobile run build:sim` 이 자동으로 검사하고 실패시킨다.

| 항목 | 어떻게 증명되나 |
|---|---|
| 앱·확장 **두 타깃 빌드 성공** | 빌드 자체 |
| `.appex` 가 앱에 **임베드**됨 | `MomoMobile.app/PlugIns/…appex` 존재 검사 |
| 확장이 **자기 번들 ID로 서명**됨 | `codesign -dv` → `Identifier=app.momo.ios.NotificationService` |
| `MomoKeychainAccessGroup` 이 **실제 값으로 확장**됨(양쪽 프로세스) | 빌드 산출 Info.plist 에서 `YWQQFQM38J.app.momo.ios.shared` 확인 |
| `MomoAPNSEnvironment` 가 **구성별로 확장**됨 | Debug 산출물이 `development` |
| entitlement **선언 대칭**(앱↔확장 공유 그룹 동일, `aps-environment` 는 앱만, 기기 키 그룹은 앱만) | `clients/mobile/__tests__/pushContract.test.ts`, `clients/mobile/__tests__/deviceKeyContract.test.ts` |
| 승계 Swift 391줄이 **동결 킷과 바이트 일치** | `scripts/verify_push_kit_inheritance.sh` |
| 액션 분기·워크스페이스 가드·재시도 정책 | `clients/mobile/__tests__/push*.test.ts` |
| 잠금 화면 승인·거절 네이티브 처리기(#3931)의 **판정 전부** — 멱등 키(독립 계산한 벡터와 일치), 페이로드·자격 읽기, 요청 모양, 응답 → 결과 문장, 키체인 읽기·생성 논리(키체인 호출은 가짜) | `bash clients/mobile/modules/momo-push-action-native/sim-check/run.sh`(이 Mac) · `…/run.sh <시뮬레이터 UDID>`(iOS SDK). `__tests__/pushActionContract.test.ts` 가 macOS 에서 이것을 컴파일해 돌린다 |
| JS ↔ Swift 계약(키체인 항목 주소, JSON 키, 알림 어휘, 모듈 이름), 처리기가 붙었을 때만 JS 가 물러남, 결과 줄 탭이 카드로 감, 자격이 앱 전용 그룹 밖으로 나가지 않음 | `__tests__/pushActionContract.test.ts` · `pushActionNative.test.ts` · `pushActionSession.test.ts` · `pushActionCredential.test.tsx` · `pushTap.test.tsx` |
| **앱이 앞에 있을 때의 푸시 표시**(#4310, #4295 후속): 다른 대화의 알림은 배너 + 알림 센터 목록, 지금 보는 대화(스레드 답글이면 열린 스레드)의 알림은 배너·소리·목록 모두 없음, 승인 요청은 같은 방에서도 배너, 못 읽는 봉투는 배너, 앱이 배경이면 처리기가 불리지 않고 iOS 가 직접 표시, 배너를 누르면 기존 tap 경로로 그 대화에 착지. 처리기는 `index.js` 의 모듈 평가 시점에 한 번 걸린다 | `__tests__/foregroundPresentation.test.tsx`(결정 표·expo 에 건넨 답의 모양·진짜 `AppShell` 이 올린 화면 상태·`index.js` 를 실제로 평가한 호출 순서) + 시뮬레이터(16 Pro, iOS 26.5, 격리 스택·가상 인물)에서 `xcrun simctl push` 로 릴레이 봉투를 쏜 캡처 `clients/mobile/measure/captures/4310/`. 재현은 §5 의 «포그라운드 표시» |
| **커뮤니케이션 알림의 판정**(#4316, ADR-0204 증보 5) — 무엇을 어떻게 보여 줄지(보낸 사람·방 이름·스레드 표시·미리보기 끔·보낸 사람 표시 끔·승인은 숨기지 않음), 사진 순서(App Group 캐시 → 한 번의 제한된 읽기 → 앱 규칙의 이니셜), 캐시 한도·만료·버전 키, 정리와 재시도, 실제 `INSendMessageIntent` 필드와 기부 뒤 재확인 | `bash clients/mobile/modules/momo-push-native/sim-check/run.sh`(이 Mac: Intents 밖 전부) · `…/run.sh <시뮬레이터 UDID>`(시뮬레이터 안: Intents 포함). `__tests__/pushContract.test.ts` 가 macOS 에서 앞의 것을 컴파일해 돌리고, 앱↔확장 권한·Info.plist 비대칭과 JS↔Swift 함수 이름을 맞댄다. `pushPresentation.test.tsx`·`settingsPage.test.tsx`·`signOutPushRevoke.test.tsx`·`memberAvatarImage.test.tsx` 가 JS 쪽을 잰다 |
| **커뮤니케이션 알림의 모양**(#4316): 보낸 사람의 둥근 사진 + 우하단의 작은 앱 아이콘 + 이름(방이면 `#방이름` 줄) + 미리보기, 라이트·다크, 배너·잠금 화면 | 시뮬레이터 캡처(16 Pro, iOS 26.5, 가상 인물): **확장 프로세스가 아니라** 확장의 `NotificationService` 클래스를 앱 안에서 그대로 호출해 로컬 알림으로 올린 장면이다 — `simctl push` 는 이 시뮬레이터에서 확장을 **시작하지 않는다**(시스템 로그에 확장 프로세스가 없고 서버에 `push-fetch` 요청이 없다, 2026-10-28 실측, #4310 의 기록과 같다). 확장 프로세스·실제 APNs 경로는 아래 K~M 이다 |

**여기까지는 다시 확인할 필요가 없다.**

---

## 1. 시뮬레이터로는 증명이 **불가능한** 것 — 이 문서의 본체

애드혹 시뮬레이터 서명은 **entitlement 를 빈 딕셔너리로 서명한다**(실측:
`codesign -d --entitlements` 결과가 `<dict></dict>`). 즉 **선언은 검사했지만 부여는
검사하지 못했다.** 공유 키체인 access group 은 프로파일이 있는 기기 빌드에서만
실제로 부여되고, 없으면 `SecItemAdd` 가 `-34018`(errSecMissingEntitlement)로
**기기에서만** 실패한다.

| # | 기기에서만 확인되는 것 | 실패했을 때의 증상 |
|---|---|---|
| A | 확장의 **서명된 entitlement** 에 공유 그룹이 남아 있는가 | 알림 내용이 placeholder 고정 |
| B | 앱이 공유 그룹에 **쓸 수 있는가**(-34018 아닌가) | 위와 동일 |
| C | 실제 **APNs 토큰 수신** | 알림이 아예 안 옴 |
| D | id-only → 확장 fetch → **내용 표시** 한 바퀴 | placeholder 고정 |
| E | **잠금 화면 승인·거절** — 앱 종료·정지·앞 × 승인·거절 × 자격 정상·만료·없음(ADR-0204 D6, #3931). 앱 종료·정지에서 iOS 가 요청이 끝날 때까지 프로세스를 살려 두는가(`beginBackgroundTask`), 결과 줄로 바뀌는가 | 버튼은 보이는데 아무 일도 안 일어남 / 「승인하지 못했어요」나 「결과를 확인하지 못했어요」만 계속 뜸 / 결정은 됐는데 알림이 버튼과 함께 남음 |
| F | 잠금화면 승인 시 **인증 요구**(`.authenticationRequired`) | 잠긴 폰에서 그냥 승인됨(보안 강등) |
| G | **푸시 스위치 끄기**(#3924, ADR-0204 D1): 끄면 푸시가 안 옴 → 앱을 다시 켜도 안 옴 → 켜면 다시 옴. 서버 쪽 효과(이 기기 토큰 무효화·재등록 시 되살림)는 가짜 서버 시험으로만 확인했다 | 껐는데 계속 옴 / 켰는데 안 옴 |
| H | 실제 **iOS 허용 창·설정 왕복**(#3924): 거부한 폰에서 스위치를 누르면 iOS 설정이 열리고, 설정에서 켜고 돌아오면 스위치가 켜진다. 허용 창이 열린 동안 스위치가 잠긴다 | 스위치와 OS 상태가 어긋남 |
| I | **VoiceOver 낭독**(#3924): 푸시 알림 줄(스위치)과 끄기 실패 문장. iOS 는 `accessibilityLiveRegion` 을 못 들어 실패 문장이 읽히지 않을 수 있다(알려진 M-3·M-4) | 화면을 보지 않는 사람이 상태를 모름 |
| K | **확장이 커뮤니케이션 알림을 만드는가**(#4316, ADR-0204 증보 5): 실제 APNs 로 온 DM·방 멘션·에이전트 답·사진만이 확장을 거쳐 **보낸 사람의 둥근 사진 + 우하단 앱 아이콘 + 이름(방이면 `#방이름`) + 미리보기**로 뜨는가. 배너·잠금 화면·알림 센터 세 곳. 앱이 그린 적 있는 사람은 사진, 없는 사람은 이니셜이어야 한다. 해석 못 한 푸시는 「oort / 새 알림」 | 앱 아이콘 + 「oort / 새 알림」 고정(확장이 안 돎) / 사진 없이 이름만 / 방 이름 없음 |
| L | **서명된 권한**(#4316): TestFlight 빌드가 `com.apple.developer.usernotifications.communication` 을 **서명에** 갖는가. 선행: 개발자 포털 App ID `app.momo.ios` › Capabilities 에서 「Communication Notifications」 켜기(**API 로는 안 된다**: ASC `capabilityType` 에 없다) + Xcode 관리형 프로파일 재생성(런북 §4, owner 만). `ci_post_xcodebuild.sh` §4c 가 서명된 아카이브에서 확인한다 | 아카이브가 서명에서 실패(프로파일에 권한 없음) / 알림이 모두 사진 없이 온다 |
| M | **설정 두 줄과 정리**(#4316): 「메시지 미리보기」 끔 → 잠금 화면 본문 「새 메시지」(이름·사진은 남음). 「보낸 사람 표시」 끔 → 「oort / 새 메시지」, 설정 › Siri 및 검색 › oort 의 제안에 새 이름이 쌓이지 않음. 로그아웃 → 다음 알림에 앞 사람의 사진·방 이름이 없고 제안 기록이 비워짐. 승인 알림은 두 설정을 꺼도 글이 그대로이고, 글을 숨긴 알림에는 승인·거부 단추가 없다. **꾸며진 승인 알림(에이전트 사진 + 글)을 길게 눌러 승인·거부 단추가 살아 있는지**도 본다: 확장은 `content.updating(from:)` 앞에서 카테고리를 되돌려 두는데, 시스템이 커뮤니케이션 내용에서 그 카테고리를 유지하는지는 시뮬레이터(확장이 안 돎)로 확인하지 못했고 D7이 가장 민감한 자리다 | 끈 설정이 무시됨 / 로그아웃한 폰에 앞 사람 이름이 남음 / 숨긴 알림에 승인 단추 / 꾸며진 승인 알림에 단추가 없음 |

---

## 2. 준비

```bash
# 1) 프로비저닝 — 앱과 확장 두 개다. 이 배치는 실행하지 않았다(계정 필요).
bundle exec fastlane match development --readonly false

# 2) 기기 빌드는 Xcode 에서: clients/mobile/ios/MomoMobile.xcworkspace
#    scheme=MomoMobile, 실기기 선택, Run
```

프로비저닝은 **두 식별자**(`app.momo.ios`, `app.momo.ios.NotificationService`)
모두에 필요하다. 서명된 산출물이 각자 자기 식별자로 서명됐는지는 Xcode Cloud의
`clients/mobile/ios/ci_scripts/ci_post_xcodebuild.sh` §2가 강제한다. (정정
2026-09-28: 예전 `fastlane/Matchfile`·`scripts/verify_ios_signing.sh`는 503d5ee3
W-S1에서 은퇴했다. 위 1)의 fastlane 명령도 그때의 기록이다.)

### 로그 보는 법 (모든 단계에서 씀)

앱은 푸시 경로의 모든 판단을 `[push]` 접두로 남긴다.

- Xcode 실행 중: 콘솔 창에서 `[push]` 필터
- 케이블 없이: macOS **Console.app** → 기기 선택 → 검색 `[push]`
- 시뮬레이터: `xcrun simctl spawn <udid> log stream --level debug --predicate 'process == "MomoMobile"'` — JS 의 `console.log` 도 여기로 나온다(`com.facebook.react.log:javascript`; 실측으로 Metro 터미널에는 나오지 않았다)

앱이 앞에 있을 때 도착한 푸시는 결과를 한 줄로 남긴다(#4310). 아이디·본문은 적지 않는다:

```
[push] foreground notification -> shown (other-conversation)   ← 보인다. 이유: not-viewing · other-workspace · other-conversation · other-thread · approval · unreadable
[push] foreground notification -> hidden (viewing)             ← 지금 보는 대화라서 숨겼다(배너·소리·목록 없음)
```

앱이 **배경**이면 이 줄이 없다 — iOS 가 직접 표시하고 처리기가 불리지 않는다. 앞에 있는데 이 줄이 하나도 없으면 처리기에 닿지 못한 것이다(JS 가 돌기 전에 도착했거나, 앱이 실제로는 앞이 아니었다).

---

## 3. 절차

### 3-1. A·B — 공유 키체인 access group (가장 먼저)

1. 기기에서 앱 실행 → 서버 연결 → **로그인**.
2. Console 에서 `[push]` 검색.

**통과**: `extension session NOT published` 가 **없다**.
**실패**: 아래가 보이면 그 자리에서 멈춰라 — 이 뒤 단계는 전부 무의미하다.

```
[push] extension session NOT published (failed) … -34018
[push] extension session NOT published (no-access-group) …
```

- `-34018` = entitlement 미부여. → 프로파일이 `keychain-access-groups` 를 담고
  있는지 확인(`security cms -D -i <profile>.mobileprovision`).
- `no-access-group` = Info.plist 의 `$(AppIdentifierPrefix)` 미확장.

서명된 entitlement 를 직접 보려면:

```bash
# .app 을 Xcode 산출물에서 꺼내
codesign -d --entitlements - "<...>/MomoMobile.app"
codesign -d --entitlements - "<...>/MomoMobile.app/PlugIns/MomoMobileNotificationService.appex"
# 둘 다 keychain-access-groups 에 YWQQFQM38J.app.momo.ios.shared 가 있어야 한다
```

### 3-2. C — APNs 토큰 등록

로그에서:

```
[push] permission=granted
[push] apns token …<끝 8자리> env=sandbox      ← 개발 빌드는 sandbox 가 맞다
[push] device registration registered after 1 attempt(s)
```

- `env=production` 이 개발 빌드에서 보이면 **멈춰라**. `APS_ENVIRONMENT` 가
  잘못 붙은 것이고, 그대로 두면 릴리즈에서 반대 방향으로 틀린다.
- `MomoAPNSEnvironment missing or unexpanded — refusing to register` 는
  등록을 일부러 거부한 것이다(추측 등록이 더 나쁘다). Info.plist 를 고쳐라.

서버에서 확인:

```bash
curl -s -H "Authorization: Bearer <access>" \
  "$BASE/v1/workspaces/$WS/devices" | jq
# apnsTokenSuffix 가 로그의 끝 8자리와 일치해야 한다(서버는 원문 토큰을 돌려주지 않는다)
```

### 3-3. D — id-only → fetch → 표시 한 바퀴

1. **다른 기기/웹**에서 이 사람에게 DM 또는 멘션을 보낸다.
2. 폰은 **잠근 채로** 둔다(확장이 잠금 상태에서 도는 것이 핵심이다).

**통과**: 알림에 **보낸 사람 이름과 메시지 본문**이 뜬다.
**실패(조용한 실패)**: "oort / 새 알림" 이 그대로 뜬다.

> 이 둘의 차이가 이 배치 전체의 판정이다. placeholder 가 보이면 확장이
> fail-open 한 것이고, 원인은 거의 항상 3-1 이다.

실패 시 확장 프로세스 로그: Console.app 에서 프로세스 필터를
`MomoMobileNotificationService` 로 두면 확장이 따로 보인다.

### 3-4. E·F — 잠금 화면에서 승인·거절 (ADR-0204 D6, #3931)

> **`runtime-unverified`.** 이 절차는 owner 폰이 있어야 돈다. 코드·시뮬레이터 쪽 증거는 §0 의
> 표까지다. 아래 칸이 채워지기 전에는 「잠금 화면 승인이 동작한다」고 말하지 않는다.

**선행.** 이 앱 빌드 + 서버가 `POST /v1/auth/push-action-token` 을 가진 버전(PR #3977 이후). 폰에서
로그인한 뒤 Console.app 에서 `[push]` 로 거른다.

```
[push] action handler attached                                   ← 앱 시작 직후, 네이티브 처리기가 붙었다
[push] approval buttons: native handler attached                 ← JS 도 그것을 안다(JS 가 버튼에서 물러난다)
[push] lock-screen approval credential stored (valid 359 min)    ← 자격이 폰에 놓였다(앞 칸 선행)
```

첫 두 줄 중 하나라도 없고 `native handler NOT attached — JS answers them` 가 보이면 멈춘다: 처리기가 붙지
않은 빌드라서 종료·정지 상태의 버튼은 예전처럼 아무 일도 하지 않는다.

이 줄이 **없고** `lock-screen approval credential NOT stored` 가 보이면 멈춘다. `(failed) … -34018` 은
앱 전용 키체인 그룹(`…app.momo.ios.devicekey`)이 이 빌드에 부여되지 않은 것이다. 놓이지 않은 채로는
아래 모든 칸이 「승인하지 못했어요」가 된다.

**한 칸을 재는 법.** 에이전트가 승인 요청을 만들게 한다(승인이 필요한 작업) → 아래 «앱 상태»를 만든 뒤
폰 **잠금 화면**에서 알림을 길게 눌러 [승인] 또는 [거부] → Face ID/암호 → 아래 «기대»를 본다.

| 앱 상태 | 만드는 법 |
|---|---|
| **종료** | 앱 전환기에서 oort 를 위로 밀어 종료 → 폰 잠금 |
| **정지** | 앱을 홈으로 보내고 폰을 잠근 채 5분 이상 둔다 |
| **앞** | 앱이 열려 있는 상태에서 알림 센터를 내려 알림의 버튼을 누른다. 앱이 앞이어도 승인 요청은 배너로 뜨고(같은 방을 보고 있어도) 알림 센터에 남는다(#4310 — §5) |

«{제목}»은 원래 알림의 제목, 곧 보낸 사람의 표시 이름이다(예: 그록봇). 원래 알림이 자리표시(「oort」)였으면 붙이지 않는다.

| 자격 | 만드는 법 | 기대(알림이 이 글로 **바뀐다**) |
|---|---|---|
| **정상** | 아무것도 안 한다 | [승인] → 「승인했어요 · {제목}」, [거부] → 「거부했어요 · {제목}」. 소리 없이 목록에만 서고, 같은 승인의 다른 알림은 사라지고, 웹/데스크탑의 카드가 그 결정으로 바뀐다. 줄을 누르면 그 카드로 간다 |
| **이미 결정됨** | 다른 기기에서 먼저 결정한 뒤 폰에서 반대 버튼 | 「이미 승인된 요청이에요」/「이미 거부된 요청이에요」(**원장의** 방향. 누른 버튼이 아니다) |
| **자격 만료** | 설정 › 일반 › 날짜 및 시간에서 자동 설정을 끄고 **7시간 앞으로** 옮긴 뒤 누른다(끝나면 되돌린다) | 제목 「승인하지 못했어요」(거부는 「거부하지 못했어요」), 본문 「눌러서 앱에서 마무리해 주세요」. 소리가 난다. 요청은 나가지 않는다 |
| **자격 없음** | 프로필 시트에서 **이 폰의 푸시를 끈다**(자격이 폰에서 지워지고 이미 와 있던 알림은 남는다) → 그 승인 알림의 버튼을 누른다. (로그아웃으로는 만들 수 없다: 로그아웃은 알림 센터를 비운다 — 아래 «모든 칸에서 같이 본다») | 위와 같은 글 |
| **연결 없음** | 알림을 받은 뒤 **비행기 모드**를 켜고 버튼을 누른다 | 제목 「결과를 확인하지 못했어요」, 본문 「눌러서 앱에서 확인해 주세요」(거부여도 같은 글 — 어느 쪽 결정이든 기록됐는지 이 폰은 모른다). 소리가 난다. 비행기 모드를 끈 뒤 줄을 누르면 카드가 서버의 사실을 말한다. 앱에서 같은 버튼을 다시 눌러도 결정은 한 번만 기록된다 |
| **서버가 거절(403)** | 한 번만 보이는 값을 만드는 승인(초대 링크·에이전트 초대) 또는 호스트 선택 카드의 알림을 누른다(서버가 `opens_in_app` 으로 거절) | 위와 같은 글 — 눌러서 앱에서 결정한다 |
| **자리표시 알림** | NSE 가 본문을 못 받아 「oort / 새 알림」으로 남은 승인 알림의 버튼을 누른다(앱을 6시간 넘게 안 연 폰의 push-fetch 토큰 만료, 또는 서버를 잠시 끈 채 받은 푸시) | 위와 같은 글. **요청은 나가지 않는다** — 무엇인지 모르는 것을 잠금 화면에서 승인하지 않는다(`failed(unresolvedNotification)`). 2단계가 NSE 에서 버튼을 떼기 전에도, NSE 가 아예 돌지 않은 알림에도 이 방어가 선다 |

세 상태 × 두 버튼 × 위 «정상»·«자격 만료»·«자격 없음» = 18칸, 거기에 «이미 결정됨»·«서버가 거절»·«자리표시 알림»·«연결 없음» 각 한 번(22칸).
**«앞» 행의 결과 줄(성공·실패 모두)도 포그라운드 처리기를 지난다**(#4310). 줄의 원문(`content.data.origin`)은 승인 봉투라서 승인 예외에 걸려 앱이 앞이어도 보이도록 짜여 있다 — 시험으로는 확인했으나 이 칸은 아직 기기에서 보지 않았다(`runtime-unverified`, §5 의 «앱이 앞에 있을 때의 결과 줄»). 위 «정상» 칸의 「소리 없이 목록에만」은 앞이 아닐 때의 기대이고, 앞에서는 배너가 함께 뜰 수 있다.

**성공·이미 결정됨 줄이 곧 사라질 수 있다.** 앱이 살아서 원장을 다시 읽으면(#3926 의 «다른 곳에서 결정된 승인의 알림 걷기») 결정된 승인의 알림을 걷고,
처리기가 올린 줄도 같은 승인의 것이라 함께 걷힌다. 앱이 **종료·정지**여서 JS 가 돌지 않는 칸에서는 줄이 목록에 서 있고, 앱을 처음 여는 읽기는 기준선만 세워서 걷지 않는다.
앞 칸이나 앱이 막 켜진 칸에서 줄이 금방 없어지는 것은 결함이 아니다. (대기 목록 한 페이지(50건) 밖으로 밀린 승인의 줄도 같은 이유로 걷힐 수 있다 — 승인은 인박스에 그대로 있다.)

**글이 둘인 까닭.** 요청이 **나가지 않은 것이 확실하거나**(자격 없음·만료·자리표시 …) 서버가 거절한 것(401·403·404·429 …)은 「승인하지 못했어요」다 —
아무것도 기록되지 않았다는 사실의 문장이다. 요청이 서버에 닿았는지 이 폰이 **알 수 없는** 것은 「결과를 확인하지 못했어요」다: 네트워크 오류 전부(연결 없음·끊김·시간
초과 — 요청이 아예 못 나간 «연결 없음»도 끊김과 구별하지 않는다. 모를 때는 모른다고 말하는 쪽이 쓸데없는 탭 한 번보다 싸다), 서버 5xx, 그리고 서버가 2xx 로 답했는데
영수증(`status`)을 읽을 수 없는 것(`unclearAnswer`). 이때 「못했어요」는 거짓일 수 있어서 카드로 보낸다.

**위 표가 덮지 않는 칸 — 확인하고 싶으면 따로 한 번씩 본다**(이 PR 은 미확인):
- 「이미 만료된 요청이에요」·「이미 취소된 요청이에요」: 승인 요청이 만료·취소된 뒤 버튼을 누른다. ADR 에 문구가 없어서 정한 두 줄이다.
- 역할이 모자라는 403(`role_required`)과 404(승인이 정리됨): 같은 실패 글이 뜨고 줄을 누르면 카드가 그 사정을 말해야 한다.
- 서버 5xx·시간 초과(`timeLimit`)·영수증이 아닌 200(`unclearAnswer`): «연결 없음» 과 같은 「결과를 확인하지 못했어요」다. 시간 초과는 일부러 만들기
  어렵다(백그라운드 시간이 다하기 전에 요청이 15초에 먼저 끝난다) — 서버를 멈춘 채 누르면 `network` 로 보인다.
- 실패 글(제목 + 본문)을 **가장 큰 글자 크기**와 **가장 좁은 폰**에서 본다 — 본문이 잘리지 않아야 한다. 「결과를 확인하지 못했어요」는 이 모듈이 올리는 가장 긴 제목(11음절)이라 끝의 「못했어요」가 보이는지도 본다(잘리면 본문이 할 일을 말한다). 긴 보낸 사람 이름의 성공 줄도 같다(동사가 앞이라 이름이 잘린다).
- 이 줄들을 **VoiceOver** 로 읽는다. 성공·이미 결정됨은 소리 없이 목록에만 서므로(`passive`) 낭독이 되는지 본다.

**알아 둘 것 — 기기 비밀.** 처리기는 처음 쓸 때 이 폰의 무작위 32바이트를 앱 전용 키체인 그룹에 만들고(`app.momo.ios.pushaction.secret`),
결정의 멱등 키(`client_decision_id`)를 이것으로 만든다. 토큰을 다시 받아도, 로그아웃해도, 푸시를 껐다 켜도 **그대로 남는다** — JS 가 쓰는
서비스와 서비스 이름이 달라서 JS 의 쓰기·지우기가 닿지 않는다. 누구의 것도 가리키지 않는 값이라 남아도 사람 정보가 아니다. 이 값이 바뀌는 날
(키체인이 비워진 폰) 이미 떠 있던 알림의 버튼은 다른 키로 나가지만, 같은 승인을 두 번 결정할 수는 없다(서버의 «이미 결정됨» 판정).

**모든 칸에서 같이 본다.**
- 줄을 **누르면** 앱이 열리고 그 승인 카드로 착지한다(성공 줄도 실패 줄도).
- 같은 알림의 버튼을 두 번 누를 수 있는 경우(앞) 결정은 **한 번**만 기록된다. 서버 감사에 `via=push_action` 한 건.
- **앱에서 마무리하면 결과 줄도 걷힌다.** 실패 줄(「…하지 못했어요」「결과를 확인하지 못했어요」)을 눌러 앱에서 그 승인을 결정한 뒤 잠금 화면을 본다 — 그 승인의
  알림이 남아 있지 않아야 한다(#3926 의 «결정된 승인의 알림 걷기»가 처리기의 로컬 알림 `content.data.origin` 도 알아본다).
- **로그아웃하면 알림 센터가 비워진다.** 승인 알림이 여러 개 와 있는 채로 앱에서 로그아웃하고 잠금 화면을 본다 — 앞 사람의 알림이 하나도 남아
  있지 않아야 한다. (자격은 같은 순간 지워지므로 남아 있어도 결정은 못 하지만, 요청·미리보기가 로그아웃한 폰에 남지 않는다.)
- 앱이 **앞** 또는 **정지**일 때 JS 의 `[push] action momo.action.approve -> ignored` 가 같이 찍힌다. 이 줄이
  없고 결정이 두 건이면 JS 가 물러나지 않은 것이다(처리기가 안 붙었다).
- 처리기 쪽 줄(앱 종료에서도 찍힌다. Console.app 에서 `[push] action` 으로 거른다):

```
[push] action approve -> decided(approve)
[push] action reject -> alreadySettled(approved)
[push] action approve -> failed(tokenExpired)      ← noToken · otherWorkspace · unresolvedNotification · unauthorized · refused · …
[push] action approve -> failed(network)           ← 이쪽은 「결과를 확인하지 못했어요」: network · timeLimit · server · unclearAnswer
[push] action no background time granted           ← iOS 가 시간을 주지 않았다. 요청은 나가지만 프로세스가 쉬면 끊긴다
```

**F 통과**: Face ID / 패스코드를 **요구한다**. 요구하지 않으면 `.authenticationRequired` 가 빠진 것이고,
이는 보안 강등이다 — 보고할 것.

**E 통과**: 위 18+4 칸이 «기대»대로이고 «모든 칸에서 같이 본다» 가 참이다.

**실패 유형**:
- 버튼을 눌러도 알림이 그대로고 로그에 `[push] action` 이 없다: 처리기가 붙지 않았다
  (`MomoPushActionInstaller.install()` 이 AppDelegate 에서 불리는지, `ExpoModulesProvider` 가 모듈을
  싣는지). JS 가 같은 버튼에서 물러났다면 버튼이 **조용히 죽은** 것이다.
- 종료/정지에서만 「승인하지 못했어요 … `timeLimit`」: iOS 가 백그라운드 시간을 충분히 주지 않았다.
  `beginBackgroundTask` 가 `didReceive` 안에서 **동기로** 불렸는지부터 본다.
- 성공인데 알림이 버튼과 함께 남는다: 결과 줄이 같은 알림 식별자로 올라가지 못했다
  (`UNUserNotificationCenter.add`). 알림 권한이 중간에 꺼졌는지 본다.
- 로그에 `-> ignored (workspace mismatch)` 는 JS 쪽 옛 방어선이다. 이제 승인·거절은 `ignored (approval
  buttons are answered natively)` 가 정상이다.

**2단계(#3928 동기화 뒤)에서 추가될 칸**: «open» 카테고리(`momo.approval.open`, 「열어서 결정」)와 NSE 가
본문을 못 받아 자리표시로 떨어질 때 버튼이 떼어지는지. 표의 «inline·open» 축 중 open 쪽이다.

### 3-5. 빠른 답장 (부수)

메시지 알림을 길게 눌러 **답장** → 텍스트 입력 → 보내기.
로그 `[push] action momo.action.quick-reply -> replied`, 채널에 메시지가 뜬다.

---

## 4. 판정 기록

| # | 항목 | 결과 |
|---|---|---|
| A | 확장 서명 entitlement 에 공유 그룹 | ☐ |
| B | 앱이 공유 그룹에 쓰기 성공(-34018 없음) | ☐ |
| C | APNs 토큰 수신 + devices 등록 | ☐ |
| D | 잠금 상태에서 **내용 있는** 알림 | ☐ |
| E | 잠금 화면 승인·거절 → 서버 반영, 결과 줄(§3-4 의 22칸) | ☐ (`runtime-unverified`) |
| F | 잠금 화면 승인 시 인증 요구 | ☐ |
| G | 푸시 스위치 끄기 → 안 옴 → 재실행해도 안 옴 → 켜기 → 옴 (#3924) | ☐ (`runtime-unverified`) |
| H | iOS 허용 창·설정 왕복, 허용 창이 열린 동안의 잠김 (#3924) | ☐ (`runtime-unverified`) |
| I | VoiceOver 낭독: 푸시 알림 줄, 끄기 실패 문장 (#3924) | ☐ (`runtime-unverified`) |

E 의 18칸(+ 아래 4칸):

| 앱 상태 \ 자격·버튼 | 정상 승인 | 정상 거절 | 자격 만료 승인 | 자격 만료 거절 | 자격 없음 승인 | 자격 없음 거절 |
|---|---|---|---|---|---|---|
| 종료 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| 정지 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |
| 앞 | ☐ | ☐ | ☐ | ☐ | ☐ | ☐ |

여기에 «이미 결정됨»(승인 뒤 거절, 거절 뒤 승인), «서버가 거절»(`opens_in_app`), «자리표시 알림», «연결 없음» 각 한 칸, 그리고 «로그아웃하면 알림 센터가 비워진다» 한 번.

**D 와 E 가 통과하면 ADR-0137 D6 게이트 4 가 닫힌다**(감사 §7.1 항목 1·2).
결과는 `docs/planning/JOURNAL.md` 와 게이트 4 판정에 반영한다.

---

## 5. 알려진 미확인 (이 배치가 남긴 것)

- **포그라운드 표시**(#4310, #4295 후속, 결정 #2592): 앱이 열려 있는 동안 온 푸시는 JS 처리기
  (`src/push/foregroundPresentation.ts`, `index.js` 의 모듈 평가 시점에 한 번 건다)가 정한다. 처리기가 없던 때는
  expo-notifications 57.0.8 의 iOS 가 `willPresent` 를 `completionHandler([])` 로 끝내서 열려 있는 동안 온 푸시가
  배너·목록·소리 없이 사라졌다(다른 대화를 보고 있어도 마찬가지였다).
  - **규칙.** 지금 보고 있는 대화(같은 워크스페이스·채널, 스레드 답글이면 **열린 스레드**)의 알림만 배너·소리·목록 없이
    숨긴다. 스레드 판이 채널 화면을 덮고 있어도 같은 채널의 **본류** 알림은 숨긴다(서버의 「보고 있음」 신호가 채널 단위라
    같은 단위다 — 기획 결정 3). 승인 요청(`momo.approval`·`momo.approval.open`)은 행동이 필요한 알림이라 같은 방에서도
    보인다. 봉투를 못 읽으면 보인다. 소리는 `aps.sound` 를 따르고 배지는 건드리지 않는다. 음소거·방해 금지·일시 중지는 서버가 이미
    판정해서 보낸 것이라 폰이 다시 판정하지 않는다. 「같은 서버」는 비교하지 않는다(봉투의 `server_id` 는 알림을 쏘는
    서버의 설정값이라 폰이 읽을 방법이 없다) — 서버가 만든 UUID(워크스페이스·채널·스레드)가 서버 간에도 겹치지 않아
    그 비교가 서버 비교를 겸한다.
  - **시뮬레이터에서 확인했다**(2026-10-26, 16 Pro·iOS 26.5, 로컬 격리 스택, `xcrun simctl push` 로 릴레이 `ApnsPayload`
    와 같은 키의 봉투, 가상 인물·가상 회사): 다른 대화 DM → 배너 + 알림 센터 목록(라이트·다크). 같은 채널을 보는 중 →
    배너 없음, **화면이 푸시 전후로 같다**(전 프레임 `…02a` 와 후 프레임 `…02` 를 비교해 라이트는 픽셀 단위로 완전히 같고,
    다크는 컴포저 도크 그림자의 최대 2/255 차이뿐이다), 알림 센터에도 남지 않는다(양성 대조: 보인 푸시는 목록에 있다. 모든 장면 뒤의
    목록 `dark-08` 의 묶음 배지는 로그에 `shown` 으로 찍힌 푸시의 개수와 맞고, `hidden` 으로 찍힌 푸시 다섯 건은 어느 묶음에도 없다). 열린 스레드의 답글은 숨고 다른 스레드의 답글은
    배너. 승인 두 카테고리·못 읽는 봉투는 같은 방에서도 배너. 앱이 배경이면 처리기 로그가 없고 iOS 가 직접 배너. 배너를
    누르면 `[push] tap -> open` 으로 그 DM 에 착지. 로그 줄은 위 «로그 보는 법».
  - **콜드 스타트 틈(남은 위험).** 처리기는 JS 가 돌기 시작한 뒤에야 걸리므로 그 전에 온 푸시는 여전히 iOS 기본으로
    사라진다. 실측(디버그 빌드, Metro): 앱을 띄운 뒤 +0.3초에 쏜 푸시는 처리기에 닿지 않았고 +1.0초부터 처리됐다.
    이 틈은 네이티브 쪽 기본 처리기가 있어야 닫히며 별도 이슈다.
  - **아직 보지 못한 것(`runtime-unverified`).** 실기기·실제 APNs 로 같은 처리를 받는지, NSE 가 본문을 채운 알림이 앞에서도
    그 제목·본문으로 뜨는지(시뮬레이터에서는 확장이 돈 흔적이 없었고 — 로그에 확장 프로세스 기동이 없다 — 페이로드의 alert 문구가 그대로 보였다), 승인 배너를 길게 눌러
    [승인]·[거부] 가 나오는지, 아래 «결과 줄».
  - **다시 돌리는 법.** 자기 워크트리의 Metro 를 빈 포트로 띄우고 `xcrun simctl launch <udid> app.momo.ios -RCT_jsLocation
    127.0.0.1:<port>` 로 **하네스 인자(`-momoMeasure`·`-momoSessionGate`) 없이** 띄운다(로그인한 실제 앱 트리에서 재야 한다). 로그인한 뒤 알림 권한을 «허용»하고, `xcrun simctl push <udid> app.momo.ios <payload>.json` 으로
    쏜다. 알림 센터는 화면 맨 위 왼쪽에서 아래로 쓸어 열고, 양성 대조(보인 푸시가 목록에 남는지)를 같은 캡처에서 함께 본다.
- **App Group `UserDefaults(suiteName:)` 강제 언랩**(감사 §2.3 미검증): 이 클라이언트는
  App Group 을 **런타임에 쓰지 않으므로** 그 크래시 경로에 들어가지 않는다. entitlement
  는 킷과의 대칭을 위해 선언만 유지한다.
- **실APNs 발송 검증**: 이 배치는 하지 않았다(패킷 금지). 위 3-3~3-4 가 그 자리다.
- **교체 알림이 실제로 제자리를 바꾸는가**(#3931): 처리기는 결과 줄을 원래 알림과 **같은 식별자**로
  올린다. `UNUserNotificationCenter.h` 는 그것이 «기존 알림을 교체한다»고 적고 있으나, APNs collapse id
  로 온 알림을 로컬 요청이 교체하는 것을 이 Mac 에서는 볼 수 없다. §3-4 의 «정상» 칸이 그 증거다.
- **앱이 앞에 있을 때의 결과 줄**(#3931 → #4310): 이전에는 포그라운드 처리기가 없어서 앞에서 올라온 알림이 모두 표시되지
  않았고 결과 줄도 같았다 — 실패 글(「…하지 못했어요 / 눌러서 앱에서 마무리해 주세요」)은 앱이 앞이면 보이지 않았고, 원래 알림은
  그 보이지 않는 줄로 교체되어 알림 센터에서 사라졌다. #4310 이후 결과 줄도 처리기를 지난다: 원문(`content.data.origin`)을
  봉투로 읽고(원격 푸시의 `trigger.payload` 가 있으면 그것만 읽는다) 그 봉투는 승인 봉투라서 승인 예외에 걸린다. 그래서 **앱이
  앞이면 같은 방을 보고 있어도 배너 + 목록으로 보이도록** 짜여 있다(시험: `foregroundPresentation.test.tsx`).
  - 확인하지 못한 것(`runtime-unverified`): 네이티브가 성공 줄은 `interruptionLevel = .passive`(목록에만, 화면을 켜지 않음),
    실패 줄은 `.active` 로 올리므로, 앞에서 배너가 실제로 뜨는지는 iOS 의 중단 수준과의 상호작용이라 기기에서 봐야 한다. §3-4
    의 «앞» 행 기대는 그 확인 뒤에 «배너가 뜨고 알림이 교체되고 카드가 바뀐다/대기 중이다» 로 고정한다.
- **알림 권한이 꺼진 뒤의 승인 버튼**: 이미 도착한 알림의 버튼을 누른 시점에 알림 권한이 꺼져 있으면 결과 줄이
  올라가지 못한다(`add` 실패, 로그에 `result line not posted`). 결정 자체는 이미 서버에 갔다.
