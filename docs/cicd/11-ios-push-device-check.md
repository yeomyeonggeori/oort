# 11 — iOS 푸시 기기 확인 절차 (goal RN-N1 / ADR-0137 이행 순서 5)

> **이 문서가 있는 이유**: 푸시 승계에서 **시뮬레이터로 증명할 수 없는 것**이 남는다.
> 그리고 그 남은 것들이 실패하는 방식은 전부 **조용하다** — 알림은 오는데 내용이
> "momo / 새 알림"(릴레이 placeholder)으로만 온다. 동작과 고장이 육안으로 구별되지
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
| entitlement **선언 대칭**(앱↔확장 공유 그룹 동일, `aps-environment` 는 앱만) | `scripts/verify_ios_signing.sh` |
| 승계 Swift 391줄이 **동결 킷과 바이트 일치** | `scripts/verify_push_kit_inheritance.sh` |
| 액션 분기·워크스페이스 가드·재시도 정책 | `clients/mobile/__tests__/push*.test.ts` |

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
| E | **알림 액션에서 승인** | 버튼은 보이는데 아무 일도 안 일어남 |
| F | 잠금화면 승인 시 **인증 요구**(`.authenticationRequired`) | 잠긴 폰에서 그냥 승인됨(보안 강등) |

---

## 2. 준비

```bash
# 1) 프로비저닝 — 앱과 확장 두 개다. 이 배치는 실행하지 않았다(계정 필요).
bundle exec fastlane match development --readonly false

# 2) 기기 빌드는 Xcode 에서: clients/mobile/ios/MomoMobile.xcworkspace
#    scheme=MomoMobile, 실기기 선택, Run
```

`fastlane/Matchfile` 의 `app_identifier` 에 **두 식별자**가 다 있어야 한다
(`scripts/verify_ios_signing.sh` 가 강제한다):
`app.momo.ios`, `app.momo.ios.NotificationService`.

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
**실패(조용한 실패)**: "momo / 새 알림" 이 그대로 뜬다.

> 이 둘의 차이가 이 배치 전체의 판정이다. placeholder 가 보이면 확장이
> fail-open 한 것이고, 원인은 거의 항상 3-1 이다.

실패 시 확장 프로세스 로그: Console.app 에서 프로세스 필터를
`MomoMobileNotificationService` 로 두면 확장이 따로 보인다.

### 3-4. E·F — 알림에서 승인

1. 에이전트가 **승인 요청**을 만들게 한다(승인이 필요한 작업 실행).
2. 폰 **잠금 화면**에서 알림을 **길게 눌러** 버튼을 연다.
3. **승인 / 거절** 두 버튼이 보이는지 확인한다. ← 안 보이면 카테고리 등록 실패
4. **승인**을 누른다.

**F 통과**: Face ID / 패스코드를 **요구한다**. 요구하지 않으면
`.authenticationRequired` 가 빠진 것이고, 이는 보안 강등이다 — 보고할 것.

**E 통과**: 인증 후 로그에

```
[push] action momo.action.approve -> decided
```

그리고 데스크톱/웹에서 해당 승인이 **승인됨**으로 바뀐다.

**실패 유형**:
- `-> ignored (workspace mismatch)`: 다른 워크스페이스의 알림이다(정상 방어).
- `-> ignored (unparseable envelope)`: 페이로드 스키마 불일치. 릴레이 확인.
- `-> failed`: 서버 결정 API 실패. 메시지가 사유를 담는다.

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
| E | 알림 액션 승인 → 서버 반영 | ☐ |
| F | 잠금 화면 승인 시 인증 요구 | ☐ |

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
