# momo — macOS/iOS 정식 배포 스펙 (2026 기준)

> 작성: 2026-06-24 · 1차 출처 검증(Apple Developer Docs / Sparkle / notarytool man page)
> 대상 산출물: `MomoMac`(SwiftPM 라이브러리) → 공증된(notarized) 다운로드 가능한 `.app` + iOS 앱스토어 업로드
> 표기: `(검증됨)` = Apple 공식문서/1차 출처 교차확인 · `(추정)` = 설계 판단 · `(법무주의)` = 법률 자문 아님, 별도 검토 필요
>
> **현재 상태(REPO 실측):** `clients/macOS`는 `swift-tools-version: 6.0` **SwiftPM 라이브러리 + smoke 실행 타깃**일 뿐 `.app` 번들이 아니다. `Info.plist` 없음, Xcode 프로젝트 없음. 로컬에 **full Xcode 미설치**(`xcode-select -p` → `/Library/Developer/CommandLineTools`). git remote 미설정(branch=main, detached HEAD 상태로 관측됨). → **배포 전 선결 작업 다수.**

---

## 0. 의사결정 요약 (먼저 읽기)

| 결정 | 권고 | 트레이드오프 |
|---|---|---|
| **1차 배포 채널** | **Developer ID + 공증(notarized) 직접 다운로드(DMG)** 우선, MAS는 후행 | 직접배포=빠른 반복·샌드박스 선택적·자체 업데이트(Sparkle). MAS=발견성·자동업데이트 무료지만 **샌드박스 강제 + 심사 대기 + 30% 수수료**(해당 시) |
| **macOS 자동업데이트** | **Sparkle 2 (EdDSA)** | Developer ID 직접배포에서 사실상 표준. MAS는 Sparkle 사용 불가(앱스토어가 업데이트 담당) |
| **배포 포맷** | **DMG**(드래그-투-Applications) | DMG=관용적 UX. PKG=설치 스크립트/시스템 컴포넌트 필요할 때만. v0는 시스템 컴포넌트 없음 → DMG |
| **SwiftPM→앱 전환 방식** | **Xcode 앱 타깃 생성 + 기존 SwiftPM 패키지를 로컬 의존성으로 임베드** | Xcode 프로젝트 도입(빌드설정/서명/Info.plist 관리). 대안 Swift Bundler는 SwiftPM 유지하나 iOS 앱스토어 경로/심사 도구체인 정합성 약함 → **Xcode 권장** |
| **계정 형태** | dawnkim 조직 명의면 **Organization(D-U-N-S 필요)**, 개인이면 **Individual** | Organization=팀 명의·여러 멤버, 단 D-U-N-S 발급 지연(수일~수주) 가능. Individual=즉시지만 개발자명=개인 실명 노출 |
| **스토어 게이트** | 빌드 사용성 검수(완전 "사용 가능") 통과 후에만 스토어 제출 | 본 스펙은 그 게이트 **이후** 단계. 직접배포 공증은 게이트 전이라도 내부 배포용으로 선행 가능 |

---

## 1. 선행 조건 (계정·인증서·도구)

### 1.1 Apple Developer Program 등록 `(검증됨)`
- **비용: USD $99 / 년** (지역별 현지통화, 등록 시 표시). 부가세 별도 가능.
- **Organization 등록 요건:**
  - **D-U-N-S 번호** 필수(Dun & Bradstreet 발급, 9자리). 정부기관 제외. **발급/검증 지연이 일정 리스크의 핵심** — 미보유 시 신청부터 시작(무료, 며칠~수주 소요 가능). `(검증됨)`
  - 법적 실체(legal entity)여야 함. DBA/상호/지점 불가. `(검증됨)`
  - Account Holder는 조직을 법적으로 구속할 권한 보유(대표/임원/위임받은 직원). `(검증됨)`
  - 비영리/교육/정부는 fee waiver 가능. `(검증됨)`
- **Individual 등록:** D-U-N-S 불필요, 즉시 가능하나 개발자 표시명=개인 실명.
- **권고:** dawnkim이 법인/단체면 D-U-N-S부터 **지금 신청**(임계경로). 단기 검증/내부배포는 Individual로 시작 후 Organization 이관도 가능(추정 — 이관은 Apple 지원 필요할 수 있음).

### 1.2 인증서 (Certificates)
| 인증서 | 용도 | 비고 |
|---|---|---|
| **Developer ID Application** | 직접배포 `.app`/`.dmg` 서명 → Gatekeeper가 "신뢰된 개발자" 검증 | 직접배포의 핵심. `(검증됨)` |
| **Developer ID Installer** | 직접배포 `.pkg` 서명 | PKG 쓸 때만 |
| **Apple Distribution** | App Store(iOS/macOS MAS) 업로드 서명 | 업로드 후 Apple이 재서명 `(검증됨)` |
| **Apple Development** | 개발/디바이스 테스트 | TestFlight 전 단계 |

- 인증서는 Apple Developer 계정 → Certificates, IDs & Profiles에서 발급. Xcode "Automatically manage signing"이 Apple Development/Distribution은 자동 처리. **Developer ID는 수동 발급 권장**(Xcode → Settings → Accounts → Manage Certificates, 또는 포털).

### 1.3 도구 체인 `(검증됨)`
- **Full Xcode 필수** (현재 미설치 — CommandLineTools만). App Store 제출은 **Xcode 26 + iOS/iPadOS 26 SDK 이상** 요구(2026-04-28부 시행). `(검증됨)`
- 공증 CLI: **`xcrun notarytool`** (Xcode 14+ 포함). `altool`은 2023-11-01 완전 제거됨 — 사용 금지. `(검증됨)`
- `codesign`, `xcrun stapler`, `spctl`, `productbuild`/`pkgbuild`(PKG 시), `hdiutil` 또는 `create-dmg`(DMG 시).
- 인증: **App Store Connect API Key(.p8)** 권장 vs **app-specific password**. API Key가 CI/자동화·만료관리에 유리. `(검증됨)`

---

## 2. SwiftPM 라이브러리 → `.app` 번들 전환 (현 코드 기준)

> 현 `MomoMac`은 `WindowGroup`/`@main` 앱 엔트리·`Info.plist`·앱 아이콘·번들ID가 **전부 없음**. 전환 필요사항:

### 2.1 권장 구조 (Xcode 앱 타깃 + 로컬 패키지 임베드)
```
clients/
├─ Core/                 # 기존 MomoCore SwiftPM (그대로 로컬 의존성)
├─ macOS/                # 기존 MomoMac SwiftPM 라이브러리 (뷰/VM, 그대로 로컬 의존성)
└─ apps/
   └─ MomoMac.xcodeproj  # ★ 신규: macOS App 타깃
      └─ MomoMacApp/
         ├─ MomoMacApp.swift   # @main App { WindowGroup { MomoMacRootView() } }
         ├─ Info.plist
         ├─ MomoMac.entitlements
         └─ Assets.xcassets/AppIcon.appiconset (1024px 등 전 사이즈)
```
- Xcode 앱 타깃의 **Frameworks, Libraries, and Embedded Content**에 로컬 패키지 `MomoMac`(→ `MomoCore`) 추가. SwiftPM 패키지는 그대로 두고 앱이 소비. `(검증됨 — Xcode 11+ SwiftPM 통합)`
- iOS는 동일 Xcode 프로젝트에 **iOS App 타깃** 추가, 공유 코어(`MomoCore`)·가능하면 SwiftUI 뷰 재사용. `clients/iOS/`는 아직 placeholder.

### 2.2 전환 체크리스트 (필수 산출물)
- [ ] **`@main` App 엔트리** — 현 `MomoMacRootView`를 `WindowGroup`에 호스팅 (코드 주석에 follow-up으로 명시되어 있음).
- [ ] **Info.plist** — `CFBundleIdentifier`(예: `net.dawnkim.momo` / iOS: `net.dawnkim.momo.ios`), `CFBundleVersion`(빌드번호, **단조 증가** — Sparkle 요구 `(검증됨)`), `CFBundleShortVersionString`(마케팅 버전, 예 1.0.0), `LSMinimumSystemVersion`(예 14.0), `NSAppTransportSecurity`(서버 TLS), 카메라/마이크 등 권한 사용설명(해당 시).
- [ ] **번들 ID 등록** — App Store Connect/포털에 App ID(Explicit) 등록. iOS 앱스토어 제출의 3종(App ID·인증서·프로비저닝 프로파일) 선결. `(검증됨)`
- [ ] **앱 아이콘** — `Assets.xcassets/AppIcon`(1024×1024 포함 전 사이즈). MAS 필수.
- [ ] **Entitlements** — §3.2 참조(Hardened Runtime 동반).
- [ ] **APNs** — L4 스펙 §8.3이 푸시를 요구 → App ID에 Push Notifications capability + APNs 키(.p8, ES256) 등록. 앱 타깃에 aps-environment entitlement.
- [ ] **Centrifugo/AsyncHTTPClient 전송 구현** — 현재 LiveChatBackend는 인메모리 스텁. 실배포 앱은 SwiftCentrifuge(MIT) + URLSession/AsyncHTTPClient 실연결 필요(STATUS.md §5.4 follow-up).
- [ ] **빌드 버전 자동화** — `CFBundleVersion`을 git commit count/CI 빌드번호로 주입(Run Script). Sparkle·App Store 모두 단조 증가 요구.

### 2.3 대안: Swift Bundler (SwiftPM 유지) `(추정)`
- SwiftPM만으로 `.app` 생성 가능(Xcodeproj 불필요). 직접배포·Sparkle엔 충분.
- **단점:** iOS 앱스토어 제출·심사 검증(Validate App·Organizer·privacy manifest)은 Xcode 워크플로우에 강결합 → Bundler로는 마찰. **iOS 앱스토어 목표가 있으므로 Xcode 권장.**

---

## 3. 코드 서명 + Hardened Runtime + 공증 (직접배포 핵심 경로)

> 순서: **서명(bottom-up) → DMG 생성 → 공증 제출 → 스테이플 → Gatekeeper 검증.**

### 3.1 codesign — Hardened Runtime + 타임스탬프 + entitlements `(검증됨)`
- **bottom-up 서명:** 중첩 바이너리/프레임워크/헬퍼/XPC(Sparkle 포함)를 **먼저** 서명하고 **앱 번들을 마지막**에 서명. `--deep`은 신뢰 불가(중첩 서명 누락 가능) → **각 항목 개별 서명 권장.** `(검증됨)`
- 공증 전제: **Hardened Runtime 필수** = `--options runtime`. **Secure Timestamp 필수** = `--timestamp`. `(검증됨)`

```bash
# 1) 중첩 항목부터 (예: Sparkle XPC, 프레임워크) — 각각
codesign --force --options runtime --timestamp \
  --sign "Developer ID Application: dawnkim (TEAMID)" \
  "MomoMac.app/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate"
# ... (Sparkle의 Updater.app / XPCServices 등 모든 Mach-O 항목)

# 2) 앱 번들 (entitlements 동반)
codesign --force --options runtime --timestamp \
  --entitlements "MomoMac.entitlements" \
  --sign "Developer ID Application: dawnkim (TEAMID)" \
  "MomoMac.app"

# 3) 서명 검증
codesign --verify --deep --strict --verbose=2 "MomoMac.app"
```
> Xcode Organizer의 "Distribute App → Developer ID → Upload/Export"가 위 서명+공증을 **자동 수행**하므로, 수동 CLI는 CI/스크립트화할 때만 필요(추정 — 둘 다 유효한 경로).

### 3.2 Entitlements (Hardened Runtime 동반) `(검증됨/추정)`
- **직접배포(Developer ID): 샌드박스 선택적.** v0는 비샌드박스로 시작 가능(마찰 최소). Hardened Runtime은 그래도 필수.
- 네트워킹 메신저이므로 최소:
  - `com.apple.security.network.client` = true (서버/Centrifugo/hermes 호출)
  - (MAS/샌드박스 전환 시) `com.apple.security.app-sandbox` = true + 필요한 사용자선택 파일/네트워크 etc.
  - Sparkle 사용 시 비샌드박스면 추가 entitlement 불필요. 샌드박스면 Sparkle **sandboxing 가이드** 준수(XPC 서비스). `(검증됨 — Sparkle 2.2 XPC 명칭 변경 주의)`
- Hardened Runtime 예외(JIT/DYLD 등)는 v0에 불필요할 가능성 높음(추정).

### 3.3 DMG 생성 `(검증됨)`
```bash
# create-dmg (brew install create-dmg) — 드래그-투-Applications UX
create-dmg \
  --volname "momo" \
  --app-drop-link 600 185 \
  "momo-1.0.0.dmg" "MomoMac.app"
# 또는 hdiutil로 수동 생성
```
- DMG 자체도 Developer ID Application으로 서명 가능(권장). create-dmg는 `--notarize` 옵션으로 공증+스테이플까지 일괄 가능. `(검증됨)`

### 3.4 공증(notarization) 제출 `(검증됨)`
```bash
# (1회) 자격증명 키체인 저장 — API Key 방식(권장)
xcrun notarytool store-credentials "momo-notary" \
  --key ~/.private_keys/AuthKey_XXXXXXXXXX.p8 \
  --key-id XXXXXXXXXX \
  --issuer <issuer-uuid>
# 대안: app-specific password 방식
#   xcrun notarytool store-credentials "momo-notary" \
#     --apple-id you@dawnkim --team-id TEAMID --password <app-specific-pw>

# (2) 제출 + 대기 (DMG 통째로 — 내부 .app 자동 공증)
xcrun notarytool submit "momo-1.0.0.dmg" --keychain-profile "momo-notary" --wait

# (3) 실패 시 로그
xcrun notarytool log <submission-id> --keychain-profile "momo-notary" dev_log.json
xcrun notarytool history --keychain-profile "momo-notary"
```
- 처리시간 **약 2~15분**(과거 altool 20~60분 대비 단축). `(검증됨)`
- DMG/PKG/번들을 제출하면 **내부 항목 자동 unpack·공증** — 최상위 1개만 올리면 됨. `(검증됨)`
- **ZIP은 스테이플 불가** — ZIP으로 제출은 되나 티켓은 내부 항목에 스테이플 후 재압축해야 함. → **DMG 권장**(DMG는 스테이플 가능). `(검증됨)`

### 3.5 스테이플(staple) + Gatekeeper 검증 `(검증됨)`
```bash
# 공증 성공 후 티켓을 DMG에 부착(오프라인에서도 Gatekeeper 통과)
xcrun stapler staple "momo-1.0.0.dmg"
xcrun stapler validate "momo-1.0.0.dmg"

# Gatekeeper 시뮬레이션 검증
spctl -a -t open --context context:primary-signature -vvv "momo-1.0.0.dmg"
# .app 자체:  spctl -a -vvv "MomoMac.app"
```
- 스테이플 안 하면 Gatekeeper가 **온라인으로** 티켓 조회(네트워크 없으면 실패). → **반드시 스테이플.** `(검증됨)`

---

## 4. macOS 자동업데이트 — Sparkle 2 (EdDSA) `(검증됨)`

> 직접배포(Developer ID)에서만. MAS는 앱스토어가 업데이트 담당 → Sparkle 불가.

### 4.1 셋업
1. **SwiftPM로 Sparkle 추가**: `https://github.com/sparkle-project/Sparkle` (Apple 권장: 기본옵션으로 자동 버전업).
2. **EdDSA 키 생성(1회)**: `./bin/generate_keys` → **개인키는 로그인 키체인에 저장**, **공개키(base64)** 출력. `(검증됨)`
3. **Info.plist 키**:
   - `SUPublicEDKey` = generate_keys가 출력한 공개키.
   - `SUFeedURL` = appcast 호스팅 URL (예: `https://dl.dawnkim.net/momo/appcast.xml`).
   - `CFBundleVersion` = **단조 증가** 빌드번호(필수). `(검증됨)`
4. **업데이트 빌드 후 appcast 생성**: 새 버전 `.app`을 dmg/zip/tar.xz로 압축 → 폴더에 넣고 `./bin/generate_appcast /path/to/updates_folder/` → **자동 EdDSA 서명 + appcast.xml 생성**. `(검증됨)`
   - `-s` 플래그(키를 CLI 인자로)는 **deprecated** → 키체인 사용. `(검증됨)`
   - `SURequireSignedFeed` 옵션 시 appcast/릴리스노트도 서명. `(검증됨)`
5. **호스팅**: appcast.xml + 압축 업데이트 + delta 파일을 SUFeedURL 위치에 업로드.

### 4.2 주의 `(검증됨)`
- **각 릴리스 .app도 Developer ID 서명 + 공증 + 스테이플** 되어 있어야 함(Sparkle이 받은 업데이트도 Gatekeeper 통과해야 실행).
- 샌드박스 앱이면 Sparkle **sandboxing 가이드** 준수(2.2에서 XPC 서비스 명칭 변경됨 — 스크립트 참조 시 업데이트).
- **EdDSA 개인키 분실 = 자동업데이트 영구 불능**(공개키가 앱에 박혀 있음). → 키 백업·시크릿 매니저 보관 필수(추정 운영규칙).

---

## 5. iOS 앱스토어 업로드/심사 `(검증됨)`

> **게이트:** 빌드 사용성 검수 통과 후 진행. 아래는 그 이후 절차.

### 5.1 선결 (계정에서, 유료계정만 생성 가능) `(검증됨)`
- **App ID**(번들ID) 등록 · **Apple Distribution 인증서** · **App Store Provisioning Profile**(App ID+인증서+capability 연결).
- **App Store Connect**에 앱 레코드 생성(이름·번들ID·SKU·카테고리·개인정보 처리방침 URL).

### 5.2 빌드·업로드 `(검증됨)`
1. Xcode: **Product → Archive** (Release, Apple Distribution 서명).
2. **Organizer → Validate App** (entitlements/프로비저닝/**privacy manifest** 사전검사 — 반드시 통과).
3. **Distribute App → App Store Connect → Upload**. Xcode가 App Store 요건 검증 후 업로드.
4. **TestFlight**로 내부/외부 테스터 배포(외부는 베타 심사). 빌드는 90일 후 만료. `(검증됨)`
5. App Store Connect에서 메타데이터·스크린샷·심사정보 입력 → **제출**.

### 5.3 심사 `(검증됨)`
- 2026년 약 **90% 24시간 내** 심사, 복잡/플래그 시 2~5일.
- App Review Guidelines 매번 최신본 확인(데이터 프라이버시·IAP·minimum functionality). 멀티테넌트 메신저는 **UGC 모더레이션·신고/차단·이용약관**(Guideline 1.2 UGC) 충족 필요 가능성 높음 `(추정 — 심사 리스크)`.
- 최소 SDK: **iOS 26 SDK + Xcode 26**(2026-04-28부). `(검증됨)`

### 5.4 멀티테넌트/초대코드 제품요건 매핑 (스키마 기준)
- REPO `schema_v0.sql`에 이미 **`token_kind`에 `'invite'`**, **`member_status`에 `'invited'`**, **`workspace.slug` UNIQUE**, **전 테넌트행 `workspace_id` + RLS FORCE** 존재 → "스핀업마다 고유 초대코드 → 자가가입 → 워크스페이스 격리"는 **신규 프리미티브 없이** `token(kind='invite')` + RLS로 구현 가능(추정 — 발급/소비 API는 미구현, BUILD_TICKETS 후속).
- "플랫폼 관리자 전체 추적"은 `audit_log`(actor/subject/via_token) + cross-workspace 조회권한(BYPASSRLS 운영 role)로 매핑(추정 — 별도 admin 화면/권한 필요).
- 10명=1팀, 3개+팀 = workspace 3개 이상. v0 단일 인스턴스로 수용(L4 §1.4 확장경로).

---

## 6. 비용 · 기간 요약

| 항목 | 비용 | 기간/주의 |
|---|---|---|
| Apple Developer Program | **USD $99/년** `(검증됨)` | 갱신 필요. 미갱신 시 앱 다운로드 중단·인증서 만료 |
| D-U-N-S (Organization) | 무료 `(검증됨)` | **발급/검증 며칠~수주 — 임계경로**. 미보유 시 즉시 신청 |
| App Store 수수료 | 표준 15~30%(소규모 사업자 프로그램 15%) `(추정 — 정책 변동, 직접배포는 무관)` | 직접배포(Developer ID)는 수수료 0 |
| 공증 처리시간 | $0 (멤버십 포함) | 제출당 **2~15분** `(검증됨)` |
| iOS 심사 | $0 | **~24h(90%)**, 복잡 시 2~5일 `(검증됨)` |
| 인증서 유효기간 | $0 | Developer ID Application 인증서 만료 전 갱신·재서명 필요 |
| Sparkle EdDSA 키 | $0 | 분실 시 자동업데이트 영구 불능 — 백업 필수 |

---

## 7. 출처 (1차 교차검증)

- Notarizing macOS software before distribution — developer.apple.com/documentation/security/notarizing-macos-software-before-distribution `(검증됨)`
- Customizing the notarization workflow — developer.apple.com/documentation/security/customizing-the-notarization-workflow `(검증됨)`
- Signing Mac Software with Developer ID — developer.apple.com/developer-id/ `(검증됨)`
- Distributing software on macOS — developer.apple.com/macos/distribution/ `(검증됨)`
- notarytool man page (subcommands/flags) — keith.github.io/xcode-man-pages/notarytool.1.html `(검증됨)`
- Sparkle Documentation (generate_keys/SUPublicEDKey/SUFeedURL/generate_appcast/sandbox) — sparkle-project.org/documentation/ `(검증됨)`
- Sparkle upgrading (2.2 XPC 명칭 변경) — sparkle-project.org/documentation/upgrading/ `(검증됨)`
- Apple Developer Program membership/$99 — developer.apple.com/programs/whats-included/ `(검증됨)`
- Organization enrollment / D-U-N-S — developer.apple.com/help/account/membership/program-enrollment/ `(검증됨)`
- App Store submitting / Xcode 26 + iOS 26 SDK (2026-04-28) — developer.apple.com/news/?id=6lxhtioi, developer.apple.com/app-store/submitting/ `(검증됨)`
- Upload builds (Archive/Validate/Distribute) — developer.apple.com/help/app-store-connect/manage-builds/upload-builds/ `(검증됨)`
- MAS vs Developer ID 샌드박스 강제/선택 — blog.xojo.com/2026/03/24/code-signing-on-macos-what-developers-need-to-know-part-3/ `(검증됨)`
- create-dmg (--notarize) — github.com/create-dmg/create-dmg `(검증됨)`
- DMG/PKG 공증·스테이플 — deciphertools.com/blog/notarizing-dmg/ `(검증됨)`

> **법무주의:** 본 문서는 법률 자문이 아니다. 멀티테넌트 UGC 메신저의 개인정보처리방침·이용약관·데이터 처리(국내 개인정보보호법/해외 사용자 시 GDPR 등)·App Review Guideline 1.2(UGC) 준수는 외부 배포 전 별도 법무 검토 필요(L4 §10 정합).
