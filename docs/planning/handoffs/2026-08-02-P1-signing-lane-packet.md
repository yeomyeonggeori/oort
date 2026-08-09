# goal P1 — iOS 서명 레인 수선 (App Store 배포 선행 조건)

너는 momo(제품명 oort) 레포의 구현 worker다. 이 문서가 유일한 지시서.
**base = `track/engine`**. 워크트리 `~/projects/momo-tracks/momo-worktrees/P1-signing-lane`(브랜치 `feat/P1-signing-lane`, 생성됨).

발단: #837 게이트 4 감사(`docs/planning/2026-08-02-rn-push-inheritance-audit.md`)가 ADR-0137 D7의 **"배포 레인은 살린다"가 현재 파일 기준 미성립**임을 실측했고, 오케스트레이터가 재확인했다. **RN과 무관하게 지금 깨져 있고, App Store 배포를 하려면 어차피 선행돼야 한다.**

## 0. 규율
`.env`·자격증명 금지(파일명 출력도) · **Apple Developer 자격증명이 없으니 `match`/`fastlane`을 실제로 실행하지 마라**(실행하면 실패하거나 원격 상태를 건드린다) · 워크트리 밖 파일 **읽기만** · 서버 코드·`schema_v0.sql` 수정 금지 · 커밋은 새 커밋만(amend·force-push 금지) · **PR 후 STOP**(머지·close 금지).

## 1. 실측된 결함 (오케스트레이터 확인)
- `fastlane/Matchfile:11` · `fastlane/Appfile:5` · `fastlane/Fastfile:51,77,111`이 프로비저닝하는 app identifier는 **`com.dawnkim.momo` 하나뿐**이고, Matchfile·Appfile에는 **`# ⚠️ 실제 Bundle ID로 교체` 주석이 그대로 남아 있다** — 처음부터 채워진 적 없는 자리표시자다.
- 실제 Xcode 값: 앱 `app.momo.ios`(`clients/iOS/MomoiOS.xcodeproj/project.pbxproj:314,345`), 테스트 `app.momo.ios.tests`, **NSE `app.momo.ios.NotificationService`**(`:410`).
- **확장(NSE) 프로파일이 fastlane 어디에도 없다.**
- `CODE_SIGN_STYLE = Automatic`이라 **로컬에서는 안 드러나고 CI에서만 터진다.** 이게 Tauri가 죽은 것과 같은 계열(#15663 — CI 서명에서 NSE entitlement 유실)이다.

## 2. 할 일

### 2-1. 식별자 정합
`fastlane/{Matchfile,Appfile,Fastfile}`의 app identifier를 **실제 Xcode 값과 일치**시키고, **NSE 확장 식별자를 프로비저닝 대상에 추가**해라. 앱과 확장은 **각각 프로파일이 필요하다** — 하나로 뭉뚱그리지 마라.
- 자리표시자 주석(`⚠️ 실제 Bundle ID로 교체`)은 값을 채운 뒤 **제거**해라. 남겨 두면 다음 사람이 또 자리표시자로 읽는다.
- Xcode 프로젝트를 **정본으로 삼아라**. fastlane을 프로젝트에 맞추는 것이지 그 반대가 아니다(프로젝트 식별자를 바꾸면 이미 등록된 App ID·푸시 인증서·Keychain access group `$(AppIdentifierPrefix)app.momo.ios.shared`가 전부 흔들린다).

### 2-2. 다시 썩지 않게 하는 게이트 (이게 이 배치의 핵심)
9주 동안 iOS 전송이 400인 걸 아무도 몰랐던 이유가 "실서버에 요청하는 iOS 게이트가 0"이었던 것처럼, 이 불일치도 **아무도 안 보고 있었다.**
→ **fastlane 식별자와 Xcode 프로젝트 식별자가 갈라지면 실패하는 검증 스크립트**를 만들어라(`scripts/verify_ios_signing.sh` 류, 기존 `scripts/verify_ios_wire.sh`의 문법·출력 관례를 따라라).
검사 항목 최소선:
1. Fastfile/Appfile/Matchfile의 app identifier 집합 == pbxproj의 `PRODUCT_BUNDLE_IDENTIFIER` 집합(테스트 타깃 제외 규칙은 네가 정하고 스크립트에 근거를 주석으로)
2. **NSE 식별자가 프로비저닝 대상에 포함**되는가
3. 자리표시자 문자열(`com.dawnkim.momo`·`⚠️`)이 남아 있으면 실패
스크립트는 **자격증명 없이 로컬에서 도는 순수 텍스트 검사**여야 한다(네트워크·match 호출 금지).

### 2-3. `CODE_SIGN_STYLE` 판단
`Automatic`이 CI에서 터지는 원인인지 **코드로 확인**하고, `Manual`로 바꿔야 한다면 무엇이 함께 필요한지(프로파일 지정·`PROVISIONING_PROFILE_SPECIFIER` 등) 적어라. **확신이 없으면 바꾸지 말고 근거와 함께 보고만 해라** — 서명 설정을 근거 없이 건드리면 로컬 빌드가 죽는다.

### 2-4. 성재가 실행할 절차 문서화
`match`는 Apple Developer 계정이 있어야 돈다. **네가 실행할 수 없다.** 그러니 성재가 그대로 따라 할 수 있는 순서를 적어라: 무슨 명령을 어떤 순서로, 무엇이 새로 생기고(App ID·프로파일), 실패하면 어떤 증상인지. 기존 `momo-signing` private repo 규약을 먼저 읽고 그 위에서 써라.
`docs/` 아래 적절한 곳(기존 배포 문서가 있으면 거기 절 추가, 없으면 신규 1파일).

## 3. 하지 말 것
`match`·`fastlane` 실제 실행 · Apple 계정 관련 원격 상태 변경 · Xcode 프로젝트의 번들 ID 변경 · Android 레인(보류) · RN 스캐폴드(`clients/mobile-spike/`) 진입 · 서버 코드 수정.

## 4. 검증·PR
- 새 검증 스크립트가 **현재 상태에서 통과**하는지, 그리고 **일부러 불일치를 만들면 실패**하는지 둘 다 보여라(후자가 진짜 증명이다).
- `bash -n` / shellcheck 수준의 문법 검사.
- PR `feat/P1-signing-lane` → `track/engine`. 본문에 전후 식별자 표·게이트가 무엇을 막는지·`CODE_SIGN_STYLE` 판단·성재 실행 절차 요약. **PR 후 STOP.**
