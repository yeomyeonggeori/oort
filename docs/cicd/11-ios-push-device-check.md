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
폰 **잠금 화면**에서 알림을 길게 눌러 [승인] 또는 [거절] → Face ID/암호 → 아래 «기대»를 본다.

| 앱 상태 | 만드는 법 |
|---|---|
| **종료** | 앱 전환기에서 oort 를 위로 밀어 종료 → 폰 잠금 |
| **정지** | 앱을 홈으로 보내고 폰을 잠근 채 5분 이상 둔다 |
| **앞** | 앱이 열려 있는 상태에서 알림 센터를 내려 **이전에 온** 알림의 버튼을 누른다(앱이 앞이면 새 배너는 뜨지 않는다 — §5) |

«{제목}»은 원래 알림의 제목, 곧 보낸 사람의 표시 이름이다(예: 그록봇). 원래 알림이 자리표시(「oort」)였으면 붙이지 않는다.

| 자격 | 만드는 법 | 기대(알림이 이 글로 **바뀐다**) |
|---|---|---|
| **정상** | 아무것도 안 한다 | [승인] → 「승인했어요 · {제목}」, [거절] → 「거절했어요 · {제목}」. 소리 없이 목록에만 서고, 같은 승인의 다른 알림은 사라지고, 웹/데스크탑의 카드가 그 결정으로 바뀐다. 줄을 누르면 그 카드로 간다 |
| **이미 결정됨** | 다른 기기에서 먼저 결정한 뒤 폰에서 반대 버튼 | 「이미 승인된 요청이에요」/「이미 거절된 요청이에요」(**원장의** 방향. 누른 버튼이 아니다) |
| **자격 만료** | 설정 › 일반 › 날짜 및 시간에서 자동 설정을 끄고 **7시간 앞으로** 옮긴 뒤 누른다(끝나면 되돌린다) | 제목 「승인하지 못했어요」(거절은 「거절하지 못했어요」), 본문 「눌러서 앱에서 마무리해 주세요」. 소리가 난다. 요청은 나가지 않는다 |
| **자격 없음** | 프로필 시트에서 **이 폰의 푸시를 끈다**(자격이 폰에서 지워지고 이미 와 있던 알림은 남는다) → 그 승인 알림의 버튼을 누른다. (로그아웃으로는 만들 수 없다: 로그아웃은 알림 센터를 비운다 — 아래 «모든 칸에서 같이 본다») | 위와 같은 글 |
| **연결 없음** | 알림을 받은 뒤 **비행기 모드**를 켜고 버튼을 누른다 | 제목 「결과를 확인하지 못했어요」, 본문 「눌러서 앱에서 확인해 주세요」(거절이어도 같은 글 — 어느 쪽 결정이든 기록됐는지 이 폰은 모른다). 소리가 난다. 비행기 모드를 끈 뒤 줄을 누르면 카드가 서버의 사실을 말한다. 앱에서 같은 버튼을 다시 눌러도 결정은 한 번만 기록된다 |
| **서버가 거절(403)** | 한 번만 보이는 값을 만드는 승인(초대 링크·에이전트 초대) 또는 호스트 선택 카드의 알림을 누른다(서버가 `opens_in_app` 으로 거절) | 위와 같은 글 — 눌러서 앱에서 결정한다 |
| **자리표시 알림** | NSE 가 본문을 못 받아 「oort / 새 알림」으로 남은 승인 알림의 버튼을 누른다(앱을 6시간 넘게 안 연 폰의 push-fetch 토큰 만료, 또는 서버를 잠시 끈 채 받은 푸시) | 위와 같은 글. **요청은 나가지 않는다** — 무엇인지 모르는 것을 잠금 화면에서 승인하지 않는다(`failed(unresolvedNotification)`). 2단계가 NSE 에서 버튼을 떼기 전에도, NSE 가 아예 돌지 않은 알림에도 이 방어가 선다 |

세 상태 × 두 버튼 × 위 «정상»·«자격 만료»·«자격 없음» = 18칸, 거기에 «이미 결정됨»·«서버가 거절»·«자리표시 알림»·«연결 없음» 각 한 번(22칸).
**«앞» 행의 실패 칸(자격 만료·자격 없음)은 줄이 보이지 않는 것이 현재 동작이다** — §5 의 «앱이 앞에 있을 때의 결과 줄».

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

- **포그라운드 표시**: 앱이 열려 있을 때 확장이 채운 알림을 `willPresent` 가 어떻게
  다루는지는 어느 문서도 답하지 않는다(감사 §5.3-b). 현재 코드는
  `setNotificationHandler` 를 설정하지 않아 **포그라운드에서는 배너를 띄우지 않는다**.
  v0 의도와 맞는지는 UX 판단이 필요하다.
- **App Group `UserDefaults(suiteName:)` 강제 언랩**(감사 §2.3 미검증): 이 클라이언트는
  App Group 을 **런타임에 쓰지 않으므로** 그 크래시 경로에 들어가지 않는다. entitlement
  는 킷과의 대칭을 위해 선언만 유지한다.
- **실APNs 발송 검증**: 이 배치는 하지 않았다(패킷 금지). 위 3-3~3-4 가 그 자리다.
- **교체 알림이 실제로 제자리를 바꾸는가**(#3931): 처리기는 결과 줄을 원래 알림과 **같은 식별자**로
  올린다. `UNUserNotificationCenter.h` 는 그것이 «기존 알림을 교체한다»고 적고 있으나, APNs collapse id
  로 온 알림을 로컬 요청이 교체하는 것을 이 Mac 에서는 볼 수 없다. §3-4 의 «정상» 칸이 그 증거다.
- **앱이 앞에 있을 때의 결과 줄**(#3931): 이 앱은 포그라운드 알림 핸들러(`setNotificationHandler`)를 두지 않아
  앞에서 올라온 알림은 표시되지 않는다. 결과 줄도 같다 — 성공은 카드가 실시간으로 바뀌어 보이지만, **실패
  글(「…하지 못했어요 / 눌러서 앱에서 마무리해 주세요」)은 앱이 앞이면 보이지 않는다.** 원래 알림은 그 보이지 않는 줄로 교체되어 알림
  센터에서 사라지고 카드는 대기 상태 그대로다(앱 안에서 결정하면 된다). §3-4 의 «앞» 행에서 실패 칸의 기대는
  «글이 안 보이고, 알림이 사라지고, 카드가 대기 중»이다. 이것을 바꾸려면 포그라운드 표시를 정하는 별도 결정이 필요하다(#2592, ADR-0204 D10).
- **알림 권한이 꺼진 뒤의 승인 버튼**: 이미 도착한 알림의 버튼을 누른 시점에 알림 권한이 꺼져 있으면 결과 줄이
  올라가지 못한다(`add` 실패, 로그에 `result line not posted`). 결정 자체는 이미 서버에 갔다.
