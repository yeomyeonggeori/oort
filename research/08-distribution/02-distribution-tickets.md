# oort — 배포 빌드 티켓 (Codex 자율 실행용)

> **목표:** `MomoMac`(SwiftPM 라이브러리) → 공증된(notarized) DMG 다운로드 + iOS 앱스토어 업로드 경로 확보.
> **선행:** 빌드 사용성 검수 게이트(빌드 파일이 "완전 사용 가능") 통과 후 스토어 제출(D-series). 직접배포 공증(B-series)은 게이트 전이라도 내부배포용으로 선행 가능.
> **상위 스펙:** `research/08-distribution/01-macos-distribution-spec.md`(절차/명령/근거 정본). 본 파일은 그 위의 **실행 티켓**.
>
> **툴체인 현실(REPO 실측):** 로컬 `swift 6.2.3` 있음 / **full Xcode 미설치**(CommandLineTools만) / Apple Developer 계정·인증서 **미보유 추정** / git remote 미설정.
> → **A-series(계정·도구)는 사람(소유자) 액션이 끼므로 Codex 단독 완결 불가** — Codex는 자동화 가능한 산출물(Xcode 타깃·Info.plist·entitlements·서명/공증 스크립트·CI)만 만들고, 사람 액션은 `// HUMAN:` 마커로 RUN 문서에 남긴다.

---

## 컨벤션 (BUILD_TICKETS.md 계승)

- **수용기준 등급:**
  - `[swift]` — `swift build` green(에러 0, 경고 허용). 미완성부 `// TODO`.
  - `[xcode]` — `xcodebuild -scheme <S> build` green **(full Xcode 설치 환경에서만)**. 미설치 환경은 `xcode-unverified (no full Xcode)` 표기.
  - `[script]` — 스크립트 `bash -n` 통과 + `--help`/dry-run 동작. 실서명/공증은 `signing-unverified (no Apple cert)` 표기.
  - `[infra]` — 파일 존재 + 스펙 정합.
  - `[human]` — 사람(계정 소유자) 액션 필요. Codex는 안내문/체크리스트만 산출.
- **표기 규칙:** 실서명·공증·앱스토어 업로드는 환경/계정 부재 시 반드시 미검증 표기(STATUS.md 패턴 계승). 추정은 `(추정)`.
- **정합 원칙:** 기존 SwiftPM 패키지(`clients/Core`, `clients/macOS`)를 **깨지 말 것**. `schema_v0.sql`/L4 스펙과 정합. 비밀키·.p8·인증서는 **절대 커밋 금지**(.gitignore 추가).
- **DoD(공통):** ① 산출물 파일 존재 ② 해당 등급 검증 통과(또는 미검증 사유 명시) ③ `docs/RELEASE.md`에 해당 단계 갱신 ④ 다음 티켓 선택 가능하도록 의존 충족.

---

## STEPS — 실행 순서 (의존순)

| order | id | 디렉터리 | 등급 | 한줄 | 의존 |
|---|---|---|---|---|---|
| 1 | `B0-prereq-doc` | `docs/` | infra/human | 계정·인증서·D-U-N-S 선결 체크리스트 + RELEASE.md 골격 | — |
| 2 | `B1-app-target` | `clients/apps/` | xcode | SwiftPM 라이브러리 임베드한 macOS App 타깃(@main/WindowGroup) + Info.plist + AppIcon | B0 |
| 3 | `B2-entitlements` | `clients/apps/` | xcode | Hardened Runtime용 entitlements(network.client) + 번들ID/버전 자동주입 | B1 |
| 4 | `B3-sign-notarize-script` | `scripts/` | script | codesign(bottom-up)+create-dmg+notarytool submit+stapler+spctl 스크립트 | B2 |
| 5 | `B4-sparkle` | `clients/apps/` | xcode | Sparkle 2 SwiftPM 통합 + SUPublicEDKey/SUFeedURL + generate_appcast 스크립트 | B2 |
| 6 | `B5-ci-release` | `.github/` | infra | 태그 푸시 시 빌드→서명→공증→appcast 발행 CI(시크릿 플레이스홀더) | B3, B4 |
| 7 | `D1-ios-target` | `clients/apps/` | xcode | iOS App 타깃(공유 MomoCore) + App ID/capability(APNs) + privacy manifest | B1 |
| 8 | `D2-appstore-doc` | `docs/` | human | Archive→Validate→Distribute→TestFlight→제출 런북 + UGC 모더레이션 체크 | D1, (게이트 통과) |

**의존 그래프:** `B0 → B1 → {B2 → {B3, B4} → B5, D1 → D2}`.

---

## 티켓 상세

### ☐ B0-prereq-doc — 선결 문서 `[infra/human]` · 의존: —
- [ ] `docs/RELEASE.md` 생성 — 직접배포(DMG) + iOS 앱스토어 2트랙 골격, 빈 단계 체크박스.
- [ ] `// HUMAN:` 액션 목록: Apple Developer Program 등록($99/년), (조직이면) **D-U-N-S 신청** — 임계경로, Developer ID Application 인증서 발급, App Store Connect API Key(.p8) 발급, **full Xcode 설치**.
- [ ] `.gitignore`에 `*.p8`, `*.cer`, `*.p12`, `*.mobileprovision`, `secrets/`, EdDSA private key 추가.
- 수용: 파일 존재 + 사람 액션이 명확히 분리됨. 계정/도구는 `[human]` — Codex 미완결 정상.

### ☐ B1-app-target — macOS App 타깃 `[xcode]` · 의존: B0
- [ ] `clients/apps/MomoMac.xcodeproj` + `MomoMacApp` 타깃 생성. 로컬 패키지 `MomoMac`(→`MomoCore`)을 **Frameworks/Embed**로 추가.
- [ ] `MomoMacApp.swift`: `@main struct MomoMacApp: App { var body: some Scene { WindowGroup { MomoMacRootView() } } }` — 기존 `MomoMacRootView`(코드 주석의 follow-up) 호스팅.
- [ ] `Info.plist`: `CFBundleIdentifier=net.dawnkim.momo`(추정 — 소유자 확정 필요), `CFBundleShortVersionString=1.0.0`, `CFBundleVersion=1`(빌드번호, 단조증가), `LSMinimumSystemVersion=14.0`.
- [ ] `Assets.xcassets/AppIcon` (1024px 포함). 임시 아이콘 허용(TODO).
- 수용: full Xcode 환경에서 `xcodebuild -scheme MomoMacApp build` green. **미설치 환경은 `xcode-unverified (no full Xcode)`** + 프로젝트 파일 구조 정합만 확인.

### ☐ B2-entitlements — Entitlements + 버전 자동화 `[xcode]` · 의존: B1
- [ ] `MomoMac.entitlements`: `com.apple.security.network.client=true`. (샌드박스/MAS 전환 대비 주석으로 `app-sandbox` 추가법 명시.)
- [ ] 타깃 빌드설정: Hardened Runtime ON, Code Signing = Developer ID Application(직접배포 스킴), Apple Distribution(스토어 스킴) 분리.
- [ ] Run Script로 `CFBundleVersion` = git commit count 또는 CI 빌드번호 주입.
- 수용: entitlements 파일 정합 + 빌드설정 명시. 서명은 `signing-unverified (no Apple cert)`.

### ☐ B3-sign-notarize-script — 서명·공증·DMG 스크립트 `[script]` · 의존: B2
- [ ] `scripts/release-macos.sh`: ① 중첩 항목 bottom-up `codesign --options runtime --timestamp` ② 앱 `codesign ... --entitlements` ③ `create-dmg`로 DMG ④ `xcrun notarytool submit ... --keychain-profile momo-notary --wait` ⑤ `xcrun stapler staple` ⑥ `spctl -a -vvv` 검증.
- [ ] 자격증명은 env/keychain-profile 참조(하드코딩 금지). `--help`/`DRY_RUN=1` 지원.
- [ ] 실패경로: `notarytool log <id>`로 진단 출력.
- 수용: `bash -n` 통과 + `DRY_RUN=1` 동작. 실서명/공증은 `signing-unverified (no Apple cert)`. 스펙 §3 명령과 1:1 정합.

### ☐ B4-sparkle — Sparkle 2 자동업데이트 `[xcode]` · 의존: B2
- [ ] SwiftPM로 `https://github.com/sparkle-project/Sparkle` 추가. Updater 구성(SwiftUI: `StandardUpdaterController` 또는 SPUStandardUpdaterController 래핑).
- [ ] Info.plist: `SUFeedURL`(플레이스홀더 `https://dl.dawnkim.net/momo/appcast.xml`), `SUPublicEDKey`(`// HUMAN: generate_keys 출력 붙여넣기`).
- [ ] `scripts/sparkle-appcast.sh`: 업데이트 폴더 → `generate_appcast`(키체인 EdDSA 서명). `-s` 플래그 금지(deprecated).
- [ ] `// HUMAN:` EdDSA 키 백업 규칙(분실=자동업데이트 영구불능).
- 수용: 프로젝트 통합 정합 + 스크립트 `bash -n`. 빌드는 `xcode-unverified` 가능. 각 릴리스 .app도 공증 필요(B3와 연계) 명시.

### ☐ B5-ci-release — 릴리스 CI `[infra]` · 의존: B3, B4
- [ ] `.github/workflows/release-macos.yml`: 태그(`v*`) 푸시 → macos-latest 러너 → import cert(시크릿) → 빌드 → `release-macos.sh` → appcast 발행 → GitHub Release 첨부.
- [ ] 시크릿 플레이스홀더: `DEVELOPER_ID_CERT_P12`, `CERT_PW`, `NOTARY_API_KEY_P8`, `NOTARY_KEY_ID`, `NOTARY_ISSUER`, `SPARKLE_ED_PRIVATE_KEY`. **값은 커밋 금지.**
- 수용: 워크플로우 YAML 파싱 정합 + 시크릿 참조만(값 없음). 실행은 `ci-unverified (no secrets/cert)`.

### ☐ D1-ios-target — iOS App 타깃 `[xcode]` · 의존: B1 · **게이트:** 사용성 검수 통과 후 우선순위
- [ ] 동일 xcodeproj에 iOS App 타깃 추가. 공유 `MomoCore` 의존. SwiftUI 뷰 가능한 만큼 재사용(`clients/iOS` placeholder 채움).
- [ ] App ID(Explicit) + Push Notifications capability(L4 §8.3 APNs) + aps-environment entitlement.
- [ ] **PrivacyInfo.xcprivacy**(privacy manifest) — 데이터수집·required reason API. App Store Validate 필수.
- [ ] Info.plist 권한 사용설명(해당 시), `CFBundleIdentifier=net.dawnkim.momo.ios`.
- 수용: `xcodebuild -scheme MomoiOSApp build`(full Xcode + iOS 26 SDK). 미설치 환경 `xcode-unverified`.

### ☐ D2-appstore-doc — 앱스토어 제출 런북 `[human]` · 의존: D1, 게이트 통과
- [ ] `docs/RELEASE.md`에 iOS 트랙: Archive → Validate App → Distribute → TestFlight → 제출. 인증서/프로파일 3종 선결 체크.
- [ ] App Store Connect 메타데이터 체크리스트 + **UGC 모더레이션/신고·차단/이용약관**(Guideline 1.2) 항목 — 멀티테넌트 메신저 심사 리스크(추정).
- [ ] `// LEGAL:` 개인정보처리방침/이용약관/데이터처리 외부 법무 검토(법률 자문 아님).
- 수용: 문서 완성 + 사람/법무 액션 분리.

---

## 전체 검증 게이트

- [ ] 기존 `swift build` green 유지 — `clients/Core`, `clients/macOS` (B-series가 기존 패키지 안 깸)
- [ ] (full Xcode 환경) `xcodebuild build` green — MomoMacApp / MomoiOSApp, 아니면 `xcode-unverified (no full Xcode)` 표기
- [ ] `bash -n` + `DRY_RUN` — `scripts/release-macos.sh`, `scripts/sparkle-appcast.sh`
- [ ] 비밀키/인증서 **미커밋** 확인(.gitignore) — `git status`에 .p8/.p12/private key 없음
- [ ] 실서명·공증·업로드 = 계정/도구 부재 시 `signing-unverified`/`ci-unverified`/`xcode-unverified` 표기 + RELEASE.md에 사람 액션 명시

---

## 다음 티켓 선택법 (Codex)

1. **의존 미충족이면 skip** — 의존 티켓의 산출물 파일이 없으면 그 티켓부터.
2. **`[human]` 티켓은 Codex가 산출물(문서/스크립트/플레이스홀더)만 완성**하고 사람 액션은 `// HUMAN:`/`// LEGAL:` 마커로 남긴 뒤 **다음 자동화 가능 티켓으로 진행**(블록되지 말 것).
3. **full Xcode 미설치 환경**에서는 `[xcode]` 티켓을 **파일 구조·정합까지** 완성하고 `xcode-unverified` 표기 후 진행. `xcodebuild` 통과는 도구 가용 시 재검증.
4. **B-series(직접배포)를 D-series(스토어)보다 먼저** — 스토어는 사용성 검수 게이트 후행.
5. 막히면 `research/08-distribution/01-macos-distribution-spec.md`의 해당 절(§2~§5)과 명령을 정본으로 참조.
