# oort — CI/CD Codex 실행 티켓 (의존순 · DoD · 명령)

> 실행 주체: **Codex(goal 자율)**. 컨벤션은 BUILD_TICKETS.md 수용기준 등급 차용.
> 등급: `[infra]`=파일 존재+정합 · `[swift]`=`swift build` green · `[xcode]`=`xcodebuild` 산출 · `[ci]`=워크플로우 syntax/lint · `[manual]`=사람 1회(Apple 계정·secrets).
> ⚠️ release(notarize/TestFlight) 활성화는 **검수 게이트(03) PASS 후**.

## 다음 티켓 선택법
1. 의존(`dep`)이 전부 done인 가장 낮은 order를 고른다.
2. `[manual]` 티켓은 Codex가 파일/문서만 준비하고, 실제 실행은 런북(01)으로 사람에게 위임 표시.
3. 각 티켓 끝에 DoD 체크 + 검증 명령 실행 결과를 STATUS.md(또는 본 파일)에 기록.

| order | id | 등급 | 한줄 | dep |
|---|---|---|---|---|
| 1 | `CI0-fastlane-skeleton` | infra | Gemfile + fastlane/{Fastfile,Appfile,Matchfile} 존재·구문 | — |
| 2 | `CI1-ci-build` | ci | `.github/workflows/ci-build.yml` (swift build/test) | CI0 |
| 3 | `C1-macos-xcodeproj` | xcode | clients/macOS에 얇은 Xcode App 프로젝트(MomoMac scheme) | — |
| 4 | `C2-ios-xcodeproj` | xcode | clients/iOS 생성 + Xcode App 프로젝트(MomoiOS scheme) | — |
| 5 | `CI2-xcode-build-job` | ci | ci-build.yml의 xcode-apps 잡 주석 해제·동작 | C1,C2 |
| 6 | `M1-asc-key` | manual | API Key 발급 + secrets 등록(런북 01 §1,§3) | — |
| 7 | `M2-match-init` | manual | signing repo + match appstore/developer_id 최초 동기화 | M1 |
| 8 | `CI3-release-ios` | ci | release-ios.yml 활성·dry-run | CI0,C2,M2,게이트 |
| 9 | `CI4-release-macos` | ci | release-macos.yml 활성·notarize 경로 검증 | CI0,C1,M2,게이트 |
| 10 | `CI5-snapshot` | infra | (선택) snapshot 스크린샷 자동화 → deliver 연동 | C2,M2 |

## 티켓 상세

### ☑ CI0-fastlane-skeleton `[infra]` (이미 생성됨)
- [x] `Gemfile`, `fastlane/Fastfile`, `fastlane/Appfile`, `fastlane/Matchfile` 존재.
- DoD: `bundle install` 성공 + `bundle exec fastlane lanes` 가 레인 목록 출력.
- 검증: `bundle exec fastlane lanes`

### ☑ CI1-ci-build `[ci]` (이미 생성됨)
- [x] `.github/workflows/ci-build.yml` — swift build/test 잡.
- DoD: `actionlint`(설치 시) 통과 + 첫 푸시에서 green.
- 검증: `actionlint .github/workflows/ci-build.yml` (또는 push 후 Actions 탭).

### ☐ C1-macos-xcodeproj `[xcode]`
- [ ] `clients/macOS/MomoMac.xcodeproj` 생성. MomoCore/MomoMac을 **로컬 SwiftPM 패키지 의존**으로 임포트(앱 타깃만 Xcode).
- [ ] scheme `MomoMac`, Bundle ID `com.dawnkim.momo`, hardened runtime ON(공증 요건), entitlements(네트워크/keychain).
- [ ] Developer ID 배포 설정(export-method developer-id 가능).
- DoD: `xcodebuild build -project clients/macOS/MomoMac.xcodeproj -scheme MomoMac -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO` 성공.

### ☐ C2-ios-xcodeproj `[xcode]`
- [ ] `clients/iOS/` 생성 + `MomoiOS.xcodeproj`. MomoCore 공유(라이브러리 의존).
- [ ] scheme `MomoiOS`, app-store export 가능, Info.plist(ITSAppUsesNonExemptEncryption 명시 — 법무 확인).
- DoD: `xcodebuild build-for-testing -project clients/iOS/MomoiOS.xcodeproj -scheme MomoiOS -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest' CODE_SIGNING_ALLOWED=NO` 성공.

### ☐ CI2-xcode-build-job `[ci]`
- [ ] ci-build.yml의 `xcode-apps` 잡 주석 해제, 경로/scheme 정합.
- DoD: PR에서 iOS+macOS 무서명 빌드 green.

### ☐ M1-asc-key / ☐ M2-match-init `[manual]`
- Codex: 런북(01) 절차 확인·갱신만. 실제 발급/등록은 사람.
- DoD: `gh secret list --repo yeomyeonggeori/oort`에 6개 필수 secret 존재.

### ☐ CI3-release-ios / ☐ CI4-release-macos `[ci]`
- [ ] secrets 존재 + 게이트(03) PASS 확인 후 활성.
- DoD(ios): `bundle exec fastlane ios beta`로 TestFlight 빌드 1개 업로드(내부 테스터 노출).
- DoD(macos): notarytool submit "Accepted" + `stapler validate` 통과 + dmg가 Release에 첨부 + 다른 맥에서 Gatekeeper 통과(`spctl --assess`).

## 공통 빌드·검증 명령
```bash
# Swift (현재 가능)
make build && make test

# fastlane 구문/레인
bundle install && bundle exec fastlane lanes

# 워크플로우 lint(설치 시)
brew install actionlint && actionlint

# Xcode app (C1/C2 후)
xcodebuild -list -project clients/macOS/MomoMac.xcodeproj
xcodebuild -list -project clients/iOS/MomoiOS.xcodeproj
```

## 컨벤션
- 비밀값은 절대 파일/로그에 평문 금지(02 인벤토리만 참조).
- fastlane/Gemfile 버전은 최신 안정으로 고정 후 `Gemfile.lock` 커밋.
- 워크플로우 변경 시 `actionlint` 통과를 DoD에 포함.
- release 워크플로우는 **게이트 PASS 전 트리거 금지**(태그 푸시 자제, 또는 environment protection 설정).
</content>
