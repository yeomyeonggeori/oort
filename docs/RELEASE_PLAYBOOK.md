# oort — RELEASE PLAYBOOK (데스크탑 공증 + iOS App Store + CI/CD)

> 작성: 2026-06-24 · 대상 실행 주체: **Codex (goal 자율 실행)** · REPO: `/Users/kwakseongjae/projects/momo` · GitHub: `Dawn-kim-official/momo` (branch `main`).
> 범위: **(A) macOS 데스크탑 Developer ID 공증 직접배포(notarytool/stapler/DMG/Sparkle)** + **(B) iOS App Store 전 과정(가입→인증서→TestFlight→Review→배포)** + **(C) CI/CD(fastlane match/gym/pilot/deliver + ASC API Key + GitHub Actions)**.
> 표기: `(검증됨)` = 2026 기준 Apple/GitHub/fastlane 1차 출처 교차확인 · `(추정)` = 설계 판단(보장 아님) · `[manual]` = 사람 1회 실행 · `[runtime]` = docker/psql 필요.
>
> **⚠️ 이 문서는 법률 자문이 아니다.** EULA/개인정보처리방침/약관/수출규제/멀티테넌트 데이터 처리는 외부 변호사 1회 검토 필수.
>
> **이 문서의 위치:** 이것은 **실행 마스터 체크리스트**다. 정본 분담은 아래와 같다.
> - 마일스톤 backbone/의존: `ROADMAP.md` (M0~M8 정본).
> - 현재 빌드 상태: `STATUS.md`.
> - CI/CD 상세 스펙: `docs/cicd/00-apple-cicd-pipeline.md` (인증/match/notary/비용 근거).
> - **번들 ID·App Group·keychain group·팀 ID 정본표: `docs/cicd/10-ios-signing-identity-runbook.md` §0.** 이 PLAYBOOK 본문의 식별자는 전부 그 표를 따른다(충돌 시 10번이 우선). 기계 검사는 `scripts/verify_ios_signing.sh`.
> - 실기기 푸시 확인 절차: `docs/cicd/11-ios-push-device-check.md` · PushRelay 배포/검증: `docs/cicd/12-push-relay-deploy-runbook.md`.
> - 검수 게이트 객관기준: `docs/cicd/05-qa-release-gate.md` (정본) + `03-store-readiness-gate.md` (체크리스트).
> - 법무/행정: `docs/legal/00-prelaunch-admin-legal-checklist.md`, `legal/*`.
> - 이 PLAYBOOK은 위를 **순서대로 묶은 단일 실행 경로 + 비용/기간 표 + gotcha 집약**이다. 충돌 시 위 정본 문서가 우선.

---

## 0. 🔒 단일 차단 불변식 (먼저 읽기)

```
스토어/공증 배포(STAGE D·E, external TestFlight 포함)는
검수 게이트(M7, docs/cicd/05-qa-release-gate.md) PASS 후에만 진행한다.
PASS 기록(03 상단 PASS 블록: 날짜+커밋해시+빌드#+증거) 없는 release 트리거 = 규칙 위반.
```

현재 상태(`STATUS.md`): M1 runtime MOMO-001~004는 Docker Desktop으로 검증됨(seq/outbox/RLS/AgentWorker 비용 회계). **STAGE B(Xcode 프로젝트)는 그 뒤로 진행됐다** — `clients/macOS`는 SwiftPM 패키지 + `MomoMac.xcodeproj`(XcodeHost), `clients/iOS`는 `MomoiOS.xcodeproj`(앱 + 알림 확장), RN 클라이언트는 `clients/mobile/ios/MomoMobile.xcodeproj`로 **셋 다 존재**하고 서명 식별자는 `scripts/verify_ios_signing.sh`가 검사한다. → 남은 선결은 staging/WebSocket/APNs 실경로와 QA gate 실측, 그리고 CI에서의 아카이브 활성화(`ci-build.yml`의 `xcode-apps` 잡은 아직 주석)다.

**전체 경로(요약):**
```
STAGE A 런타임 e2e + staging ─┐
STAGE B Xcode .app/.ipa 산출 ─┤
STAGE C CI/CD 배선(게이트 전 dry-run) ─┤
                                     ├─► M7 검수 게이트 PASS 🔒 ─┬─► STAGE D macOS 공증 DMG + Sparkle 공개
법무 L0~L8 (병렬, 사람 위임) ─────────┘                          └─► STAGE E iOS TestFlight external → App Review → 배포
```

---

## 1. 비용 / 기간 표 (정확 수치 · Apple/GitHub 1차 출처, 2026 기준)

### 1.1 일회성 / 연간 비용

| 항목 | 비용 | 기간/조건 | 출처·표기 |
|---|---|---|---|
| Apple Developer Program (조직) | **$99 USD/년** | 법인격 + D-U-N-S 필요. 결제확인메일 24h 내(미수신 시 문의). | developer.apple.com/help/account/membership/program-enrollment/ (검증됨) |
| Apple Developer Program (개인) | **$99 USD/년** | D-U-N-S 불필요. 판매자명=실명 노출. | 동상 (검증됨) |
| D-U-N-S Number | **무료** | 신청 후 D&B 최대 5영업일 + Apple 반영 2영업일 ≈ **약 7영업일**. expedite 불가. | developer.apple.com/help/account/membership/D-U-N-S/ (검증됨) |
| macOS 공증(notarization) | **$0** | Developer ID 멤버십에 포함. notarytool 유일 경로(altool 폐기 2023-11-01). | developer.apple.com/documentation/security/customizing-the-notarization-workflow (검증됨) |
| Sparkle 2 (자동업데이트) | **$0** | MIT 라이선스. EdDSA 키는 직접 생성·보관. | sparkle-project.org (검증됨) |
| privacy manifest (PrivacyInfo.xcprivacy) | **$0 (필수)** | 2024-11-12부터 데이터수집/required-reason API/특정 SDK 포함 시 제출 필수. | developer.apple.com/news/?id=pvszzano (검증됨) |
| 도메인(공개 다운로드/appcast/privacy URL) | ~$10~20/년 `(추정)` | 공증 DMG 다운로드 페이지 + Sparkle appcast + 개인정보처리방침 URL 호스팅. | 추정 |
| VPS (staging/prod 백엔드 1대) | ~$30~50/월 `(추정)` | 전용 vCPU 4코어/16GB급. 심사 기간 내내 가동 SLA 필수(2.1 데모). | 추정 |
| 오브젝트 스토리지(백업/파일) | 월 $1 미만~수$ `(추정)` | pgBackRest WAL + 첨부 S3호환. | 추정 |

### 1.2 GitHub Actions / Xcode Cloud (CI 컴퓨트)

| 항목 | 수치 | 비고 | 출처·표기 |
|---|---|---|---|
| GH Actions macOS 표준 러너 | **$0.062/분** | `macos-15`/`macos-latest`(M1 3CPU/7GB), `macos-15-intel`(4CPU/14GB). 2026-01-01 ~40% 인하 후. | docs.github.com/billing (검증됨) |
| GH Actions macOS 12코어 / M2 Pro 5코어 | $0.077 / $0.102/분 | 큰 러너. | 동상 (검증됨) |
| GH Actions 클라우드 플랫폼 차지 | +$0.002/분 | 2026-01-01 발효(self-hosted는 2026-03-01). | github.com/resources/insights/2026-pricing-changes (검증됨) |
| GH Actions 무료 분(private) | Free 2,000 / Pro 3,000 / Team 50,000 Linux-분 | **macOS는 10x 승수** → Free 2,000분 ≈ **macOS 200분/월**. | docs.github.com (검증됨) |
| Xcode Cloud 무료 | **월 25 compute-hour(=1,500분)** | 전 멤버십 포함, 미사용 이월 불가. | developer.apple.com/news/?id=ik9z4ll6 (검증됨) |
| Xcode Cloud 유료 | $49.99/100h · $99.99/250h · $399.99/1,000h | 시간 단위. | developer.apple.com/xcode-cloud/ (검색 교차확인) |

### 1.3 운영 상수 / 게이트 기간

| 항목 | 수치 | 출처·표기 |
|---|---|---|
| **iOS 업로드 SDK 요건** | **2026-04-28부터 iOS/iPadOS 26 SDK + Xcode 26 이상으로 빌드해야 App Store Connect 업로드 가능** (집행 04-29) | developer.apple.com/news/?id=fxu2qp7b · /news/?id=6lxhtioi (검증됨) |
| TestFlight 내부 | 최대 100명, 심사 없음(빌드 처리 후 즉시) | developer.apple.com/help/app-store-connect (검증됨) |
| TestFlight 외부 | 최대 10,000명, **그룹 첫 빌드 Beta App Review 필요**, 빌드 90일 만료 | 동상 (검증됨) |
| App Review 심사기간 | 다수 24~48h 내 결과 `(추정 — Apple 미보장, UGC/첫제출은 더 김)` | 추정 |
| Phased release(자동업데이트 한정) | 7일: 1%→2%→5%→10%→20%→50%→100%, 최대 30일 일시중지 | developer.apple.com/help/app-store-connect/.../release-a-version-update-in-phases/ (검증됨) |
| **신규 앱 1.0 배포** | 보통 **즉시 전체 출시**(phased는 주로 업데이트) — 1.0에 phased 기대 금지 | 추정·관행 |
| APNs provider JWT | ES256 only, 1h 초과 시 403, 20분 1회 초과 갱신 시 429 → 토큰 1개 캐시 + 20~60분 갱신 | L4 §8.3 (검증됨) |
| APNs .p8 | 만료 없음(폐기만), **1회만 다운로드**·재발급 불가, 다수 앱·dev/prod 공용 | developer.apple.com/documentation/usernotifications (검증됨) |

---

## 2. STAGE A — 백엔드 런타임 + staging (M1 선결, `[runtime]`)

> 정본: `ROADMAP.md` M1 · `docs/RUN.md` · 게이트 `docs/cicd/05-qa-release-gate.md` G-0. **이 단계 미통과 시 어떤 빌드도 "사용 가능" 판명 불가.**

- [ ] **A1. docker 런타임 e2e** (`MOMO-001~004`): `make up`(PG18+Centrifugo v6) → `make migrate`(001→002 멱등) → `GET /health` 200 → 메시지 송신 `channel_seq` 갭리스 → outbox→relay→Centrifugo publish 왕복 → RLS 테넌트 격리(워크스페이스 간 행 미노출) → 김인턴 멘션 hermes SSE 1왕복 + reserve/reconcile 비용 기록.
  - 검증 명령: `make up && make migrate && (cd server && swift run)` → 별 셸에서 relay/worker `swift run` → 송신 e2e. 결과를 `STATUS.md`에 기록.
- [ ] **A2. staging 배포** (`MOMO-005~007`): 단일 VPS + `infra/prod/docker-compose.prod.yml`(Caddy 자동TLS + Centrifugo Redis 엔진) + SOPS/age 시크릿(change-me/dev-insecure → `openssl rand` 교체) + pgBackRest PITR 복원 1회 검증 + 경량 모니터링(outbox lag/예산 트립율/APNs 실패).
  - 검증: staging URL `https://api.<domain>/health` green + TLS 정상 + `docs/RUN.md`에 기동/롤백/시크릿/백업 절차 기재.
- **DoD:** G-0 전 항목 PASS. staging이 심사·베타 기간 내내 가동되어야 함(2.1 데모 SLA — gotcha §9).

---

## 3. STAGE B — Xcode `.app`/`.ipa` 산출물 (M4-C1 / M5-C2 선결)

> 정본: `ROADMAP.md` M4/M5 · `docs/cicd/04-codex-tickets.md` C1/C2. **현재 SwiftPM뿐 → 배포 산출물(.app/.ipa)이 없다.** 옵션 A: SwiftPM 라이브러리는 그대로, **얇은 Xcode App 프로젝트**가 `MomoCore`/`MomoMac`을 로컬 SwiftPM 의존으로 임포트(앱 타깃만 Xcode가 빌드/서명/아카이브).

### 3.1 C1 — macOS `MomoMac.xcodeproj` (`MOMO-030`)
- [ ] `clients/macOS/MomoMac.xcodeproj` 생성, scheme `MomoMac`, **Bundle ID `com.dawnkim.momo`**.
- [ ] **Hardened Runtime ON** + entitlements: `com.apple.security.network.client`(아웃바운드), keychain access. (Developer ID 공증 필수 조건.)
- [ ] `@main App` 엔트리 + `Info.plist` + AppIcon 1024px.
- [ ] 검증: `xcodebuild build -scheme MomoMac -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO` 성공.

### 3.2 C2 — iOS `MomoiOS.xcodeproj` (`MOMO-040`)
- [ ] `clients/iOS/` 생성 + `MomoiOS.xcodeproj`(MomoCore 공유). **iOS 26 SDK + Xcode 26 빌드**(2026-04-28 업로드 요건 — gotcha §9).
- [ ] scheme `MomoiOS`, **explicit Bundle ID**(Push엔 와일드카드 불가) + **Push Notifications capability** (+ Background Modes: remote notification).
- [ ] 검증: `xcodebuild build-for-testing -scheme MomoiOS -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest' CODE_SIGNING_ALLOWED=NO` 성공.

### 3.3 iOS 정책 필수 구현 (App Review 강제 리젝 방지)
- [ ] **계정 삭제 5.1.1(v)** (`MOMO-042`): 설정에 '계정 삭제'(비활성화 아님) + 확인 → 서버 삭제 엔드포인트(member/human + 연관 데이터 삭제 + audit_log) → 재로그인 불가.
- [ ] **UGC 모더레이션 4종 1.2** (`MOMO-044`): ① 게시 전 objectionable material 필터, ② 신고(report), ③ 차단(block), ④ 쉽게 접근할 공개 연락처. + EULA 무관용 명시 + **에이전트 생성 콘텐츠 모더레이션 정책 별도 명시**(에이전트=1급 멤버).
- [ ] **APNs .p8(ES256) 연결** (`MOMO-041`): provider JWT(1h 수명, single-signer 20~60분 갱신) + push_token 등록(topic=bundle id) + 410/400 시 `invalidated_at` + push_dispatch_log.
- [ ] **PrivacyInfo.xcprivacy** (`MOMO-043`): 수집 데이터 유형 + `NSPrivacyAccessedAPITypes`(required reason) + 포함 SDK(APNSwift, Sentry 도입 시) 반영. App Privacy 라벨과 1:1 일관(`docs/legal/03-app-privacy-datamap.md`).
- [ ] **암호화 export 신고** `Info.plist ITSAppUsesNonExemptEncryption`: 표준 TLS/APNs ES256만이면 **면제(NO)**, 자체/독점 암호화 있으면 **YES + 수출 문서** → 의존성 전수 확인 후 결정(gotcha §9).
- **DoD:** 실기기에서 로그인→채널→메시지→에이전트 응답 + 멀티팀 초대코드 자가가입 통과(게이트 G-1/G-2).

---

## 4. STAGE C — CI/CD 배선 (M6, 게이트 전 비활성/dry-run)

> 정본: `docs/cicd/00-apple-cicd-pipeline.md`(설계 근거) · `01-setup-runbook.md`(1회 셋업) · `02-secrets-inventory.md`(비밀값). 산출 파일은 **이미 존재**(`fastlane/Fastfile|Appfile|Matchfile`, `Gemfile`, `.github/workflows/{ci-build,release-ios,release-macos}.yml`) — 본 STAGE는 **활성화/검증** 단계.

### 4.1 인증 단일화 — ASC API Key (Team Key) `[manual]`
- [ ] ASC → Users and Access → Integrations → **Team Keys** → `+` → 역할 **App Manager 이상**(Developer 역할은 업로드만, 빌드정보·테스터 갱신 불가).
- [ ] `AuthKey_XXXX.p8` **1회 다운로드**(재다운 불가) + Key ID + Issuer ID(UUID) 보관.
- **Individual Key 금지**: provisioning(match)/notaryTool/Sales 불가 → 반드시 Team Key (검증됨).

### 4.2 비밀값 6종 등록 (`gh secret`) `[manual]`
```bash
base64 -i AuthKey_XXXX.p8 | tr -d '\n' | pbcopy   # macOS: 개행 없는 base64
gh secret set ASC_KEY_ID        --repo Dawn-kim-official/momo --body "<KEY_ID>"
gh secret set ASC_ISSUER_ID     --repo Dawn-kim-official/momo --body "<ISSUER_UUID>"
gh secret set ASC_KEY_P8_BASE64 --repo Dawn-kim-official/momo < <(base64 -i AuthKey_XXXX.p8 | tr -d '\n')
gh secret set MATCH_GIT_URL     --repo Dawn-kim-official/momo --body "https://github.com/Dawn-kim-official/momo-signing.git"
gh secret set MATCH_PASSWORD    --repo Dawn-kim-official/momo --body "<강한 패스프레이즈>"
gh secret set MATCH_GIT_TOKEN   --repo Dawn-kim-official/momo --body "<signing repo PAT(repo scope)>"
gh secret list --repo Dawn-kim-official/momo   # 6개 확인
```

### 4.3 fastlane match 초기화 (개발자 머신 1회, 쓰기) `[manual]`
```bash
bundle install
bundle exec fastlane match init                 # 별도 private repo: Dawn-kim-official/momo-signing
bundle exec fastlane match appstore             # iOS App Store
bundle exec fastlane match developer_id         # macOS 직접배포(공증)
```
- CI는 항상 `readonly: true`(재현성·계정 오염 방지). **fastlane 최신 버전 고정** + `Gemfile.lock` 커밋(2025-05 Apple 미문서 API 제거 #29498 대응).

### 4.4 워크플로우 검증 (게이트 전)
- [ ] `ci-build.yml`: `swift build`/`swift test` green. **`xcode-apps` 잡 주석 해제**(C1/C2 완료 후) → iOS+macOS 무서명 빌드 green. `actionlint` 통과.
- [ ] `release-ios.yml`(gym→pilot) / `release-macos.yml`(gym→notarytool submit --wait→stapler→dmg) **syntax/lint 통과 + dry-run 성공**. **태그 미푸시 또는 environment protection으로 실배포 차단.** altool 미사용 확인.
- **DoD:** CI green + 6 secret 존재 + release 워크플로우 dry-run 성공(미트리거).

---

## 5. STAGE D — macOS 데스크탑 공증 직접배포 (M4 + M8, 게이트 PASS 후)

> 정본: `docs/cicd/00-apple-cicd-pipeline.md` §3~4. **공증 트랙 ≠ App Store 트랙**(공증=Developer ID 직접배포, App Store=별도 인증서/심사). 두 산출물 문서를 섞지 말 것.

### 5.1 서명 → 공증 → staple → 검증 (정식 순서)
```bash
# 1) bottom-up codesign (inside-out: dylib/framework → 앱)
#    Developer ID Application + hardened runtime + timestamp + entitlements
codesign --force --options runtime --timestamp \
  --entitlements MomoMac.entitlements \
  --sign "Developer ID Application: <ORG> (<TEAMID>)" \
  build/MomoMac.app

# 2) .app은 ditto로 .zip 감싸 제출 (notarytool은 .zip/.pkg/.dmg)
ditto -c -k --keepParent build/MomoMac.app build/MomoMac.zip

# 3) notarytool submit --wait (API Key 비대화형)
echo "$ASC_KEY_P8_BASE64" | base64 --decode > /tmp/AuthKey.p8
xcrun notarytool submit build/MomoMac.zip \
  --key /tmp/AuthKey.p8 --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" --wait
# → status: Accepted 확인

# 4) staple (오프라인 Gatekeeper 검증용 티켓 부착)
xcrun stapler staple build/MomoMac.app

# 5) DMG 패키징 → DMG에도 staple
create-dmg build/MomoMac.app build/
xcrun stapler staple build/MomoMac.dmg     # DMG 제출 시 내부 앱 자동 공증됨

# 6) 검증 (타 맥 기준)
codesign --verify --deep --strict --verbose=2 build/MomoMac.app
spctl --assess --type execute --verbose build/MomoMac.app   # accepted
xcrun stapler validate build/MomoMac.dmg
```
- [ ] **타 맥에서 `spctl --assess` 통과**(Gatekeeper) + `codesign --verify --deep --strict` 통과 (`MOMO-031`).

### 5.2 Sparkle 2 자동업데이트 (`MOMO-032`)
- [ ] `generate_keys`로 **EdDSA** 키쌍 생성(개인키 안전 보관) → `Info.plist`에 `SUPublicEDKey` + `SUFeedURL`(appcast URL) 설정.
- [ ] `generate_appcast`로 `appcast.xml` 생성. **각 릴리스 .app은 공증·staple 필수**(미공증 업데이트는 Gatekeeper 차단).
- [ ] 구버전 → 신버전 자동업데이트 1회 검증.

### 5.3 공개 다운로드 (M8, 게이트 PASS 후, `MOMO-072`)
- [ ] `release-macos.yml` 가동 → 공증 `.dmg`를 **GitHub Release/다운로드 페이지**에 공개 + appcast 라이브.
- [ ] 공개 다운로드 후 사용자 머신 `spctl` 통과 + Sparkle 신버전 노출.
- **배포 채널 순서:** Developer ID 공증 DMG + Sparkle **먼저**, Mac App Store는 추후(샌드박스 강제·심사·Sparkle 불가).

---

## 6. STAGE E — iOS App Store 전 과정 (M5 + M8, 게이트 PASS 후)

> 정본: `ROADMAP.md` M5/M8 + Apple 1차 출처. 흐름: **가입 → Identifiers/인증서/프로비저닝/APNs → ASC 레코드 → 빌드 업로드 → TestFlight → App Review → 배포.**

### 6.1 조직 Developer Program 가입 `[manual]` (법무 L0/L1, §8)
- [ ] 2FA 켜진 Apple Account + 법인격(DBA/가명 불가, 판매자명=법인명 노출) + **D-U-N-S**(약 7영업일) + 법적 구속 권한 보유자.
- [ ] $99/년 결제 → Team ID 확보 → ASC 접근 확인.

### 6.2 Identifiers / 인증서 / 프로비저닝 / APNs `[manual]`
- [ ] **explicit App ID**(Push엔 explicit 필수, 와일드카드 불가). **iOS/macOS 분리로 이미 확정됐다** — 정본표는 `docs/cicd/10-ios-signing-identity-runbook.md` §0이고, 정본은 **Xcode 프로젝트**다(fastlane을 프로젝트에 맞춘다. 반대로 하면 등록된 App ID·푸시 인증서·App Group·keychain group이 전부 흔들린다).
  - 앱 `app.momo.ios` — capability **Push Notifications** + **App Groups**
  - 알림 확장(NSE) `app.momo.ios.NotificationService` — capability **App Groups**. 확장도 **별도 App ID가 필요**하다(앱 ID로 덮이지 않는다).
  - App Group `group.app.momo.ios` — **Developer Portal에 먼저 만든 뒤** 앱/확장 App ID 양쪽에 연결.
  - keychain access group `$(AppIdentifierPrefix)app.momo.ios.shared` — 팀 prefix 안이라 포털 토글은 없고 entitlement로만 선언.
  - macOS 앱은 `com.dawnkim.momo`(같은 팀, Developer ID 트랙 — STAGE D). **iOS와 값이 다른 것이 의도다**(자리표시자 아님).
  - 팀 ID `YWQQFQM38J` — iOS·macOS·RN(iOS) 프로젝트의 `DEVELOPMENT_TEAM` 공통.
  - 정합은 `scripts/verify_ios_signing.sh`가 기계로 검사한다(모든 match 호출 지점 == Xcode 정본, 자리표시자 없음, 공유 entitlement 일치).
- [ ] 서명: **Xcode 자동서명(cloud signing) 권장**, CI는 **fastlane match(readonly)**.
- [ ] **APNs Auth Key .p8(ES256)** 생성(Keys) — 1회 다운로드·재발급 불가·만료 없음·다수 앱/dev·prod 공용.

### 6.3 ASC 앱 레코드 + 빌드 업로드
- [ ] ASC → Apps → `+` New App: 이름(중복불가·30자)·기본 언어·**Bundle ID 정확 일치**(`app.momo.ios`)·SKU·사용자 액세스. **알림 확장(`app.momo.ios.NotificationService`)은 앱에 임베드되므로 ASC 레코드를 만들지 않는다** — App ID만 있으면 된다(`docs/cicd/10-ios-signing-identity-runbook.md` §2).
- [ ] 빌드 업로드: Xcode Archive→Organizer→Distribute, 또는 CI `fastlane gym(export_method: app-store)` → `pilot`. **빌드번호 증가 + ITSAppUsesNonExemptEncryption 응답** 필수.

### 6.4 TestFlight
- [ ] **내부 ≤100**: 심사 없이 즉시(빌드 처리 후).
- [ ] **외부 ≤10,000**: 그룹 첫 빌드 **Beta App Review** + beta 앱 설명/리뷰 정보 필수. **external TestFlight는 게이트 PASS 후에만**(불변식 §0).
- [ ] `pilot groups`는 **External Testing 그룹에서만 신뢰성 있게 동작**(Manual-for-Xcode Internal 그룹 배정 불가). 처리 hang(#20645) 시 `skip_waiting_for_build_processing:true` + 폴링.

### 6.5 App Review Guidelines 핵심 (oort 리젝 리스크 순)
- [ ] **1.2 UGC**(최우선): 모더레이션 4종 + EULA 무관용 (STAGE B §3.3에서 구현). 가이드라인 원문은 'timely responses'(적시 대응) — '24h'는 운영 권장치(원문 명문 아님, gotcha §9).
- [ ] **5.1.1(v) 계정 삭제** + **5.1.2 개인정보**: 제3자(LLM hermes) 전송 명시적 사전 동의·고지.
- [ ] **3.1.1 IAP**: oort가 순수 B2B(조직 워크스페이스 직접판매)면 **3.1.3(c) enterprise 예외** 여지. consumer/단일사용자/가족 판매 섞이면 IAP 필수. 1차 출시는 '무료+조직직판'으로 단순화해 IAP 리스크 제거(추정). 자체 라이선스키/QR/암호화폐 잠금해제 금지.
- [ ] **2.1 App Completeness**: placeholder 제거 + 실기기 안정성 + **심사용 데모 워크스페이스 + 유효 초대코드 + 백엔드 가동 SLA**(꺼지면 빈화면 리젝).

### 6.6 App Privacy / 메타 / 스크린샷 / 연령등급 (`MOMO-070`)
- [ ] **App Privacy 라벨**(제3자/LLM 포함) — manifest와 일관(`docs/legal/03-app-privacy-datamap.md`).
- [ ] **연령등급 설문**(UGC 반영).
- [ ] 메타(이름/부제/설명/키워드/지원URL/카테고리) + **스크린샷 현 규격**(6.9"/6.5" iPhone, 13" iPad — **제출 직전 ASC 최신 요구 재확인**, gotcha §9). 에셋 placeholder는 `docs/appstore/assets/`(없으면 생성).

### 6.7 제출 → 심사 → 배포 (`MOMO-071`)
- [ ] external TestFlight 첫 빌드 Beta App Review 통과(게이트 PASS 후) → `fastlane deliver(submit_for_review)` → App Review 승인.
- [ ] 거절 시 Resolution Center 회신 → 수정 재제출.
- [ ] **배포: 1.0은 보통 즉시 전체 출시**(phased는 업데이트 한정 7일 — §1.3).

---

## 7. M7 검수 게이트 (스토어 제출 선행 — STAGE D/E 차단) 🔒

> 정본: `docs/cicd/05-qa-release-gate.md` (객관 통과기준) · 체크리스트 `03-store-readiness-gate.md`. **아래 전부 PASS + 증거 첨부 → 03 상단 PASS 블록 기록 → 그 이후에만 STAGE D/E.**

| 게이트 | 통과기준 | 도구 |
|---|---|---|
| G-0 런타임 e2e | STAGE A 전 항목(migrate 멱등→/health→seq 갭리스→outbox 왕복→RLS→hermes SSE 1왕복) | M1 staging |
| G-A 크래시-free | 세션 ≥ 99.5% AND 유저 ≥ 99.0% `(추정 임계)` + 신규 P0/P1 crash 0 (분모/윈도우 명기) | Sentry Cocoa + MetricKit (`MOMO-060`) |
| G-B 핵심플로우 e2e | 8/8 PASS, 치명 결함 0 | XCUITest + 수동 스모크 (`MOMO-061`) |
| G-C 접근성 | `performAccessibilityAudit` 치명 0 + VoiceOver 조작 가능 | Xcode 15+ audit |
| G-D 성능 | 콜드 런치 p90 < 2s `(추정 임계)`, hang ≈ 0 (실기기·Release) | XCTMetric/MetricKit |
| G-E 베타 | iOS TestFlight 내부 + macOS 공증 DMG 비공개 베타 통과 | TestFlight/spctl (`MOMO-062`) |
| G-F 베타 피드백 | 전수 트리아지, P0/P1 잔여 0 | TestFlight + ASC API |
| G-G 릴리스 준비 | 메타/프라이버시/암호화 신고/버전·빌드번호 100% | 05 §9 |

- [ ] **PASS 판정**: 전부 PASS → `STATUS.md` 게이트 OPEN→PASS 갱신 + `03-store-readiness-gate.md` 상단 PASS 블록(날짜+커밋해시+빌드#+증거 링크) 기록 (`MOMO-063`).
- [ ] 게이트 PASS 전 `release-*.yml` 미트리거 확인.

---

## 8. 법무 / 행정 선결 (법률 자문 아님 — 외부 변호사 1회 검토 필수)

> 정본: `docs/legal/00-prelaunch-admin-legal-checklist.md`, `01-entity-apple-runbook.md`, `legal/{privacy-policy,agent-disclosure,THIRD_PARTY_NOTICES}.md`, `NOTICE`. **Codex는 문서/플레이스홀더만 준비, 실제 발급/계약/검토는 사람 위임 표시.**

| ID | 항목 | 게이팅 | 비고 |
|---|---|---|---|
| L0 | 등록 주체(개인/법인) 결정 + D-U-N-S | STAGE E §6.1 | 법인은 D-U-N-S 무료·약 7영업일. (`MOMO-080`) |
| L1 | Apple Developer Program 등록($99/년) | M8 | 2FA + 법적 구속 권한. |
| L3 | 개인정보처리방침 URL | M2~M7 | 미수집도 필수. 한국 개인정보보호법/GDPR 고려. (`MOMO-081`) |
| L5 | App Privacy 라벨 | M7 | 제3자/hermes LLM 전송 정직 신고 + manifest 일관. |
| L6 | 한국 부가통신 신고 면제 | 출시 전 | 자본금 1억원 이하 면제(전기통신사업법 시행령 30조) — 법인화 시 재확인. |
| L7/EULA | NOTICE(Apache 2.0 귀속) 앱 화면 표기 + UGC 무관용 EULA | M5 | (`MOMO-082`) |
| L8 | 에이전트 LLM 제3자 전송 고지 | M2 | 온보딩 동의 + 승인 인박스 고지. |

---

## 9. GOTCHAS (배포 전 반드시 확인)

1. **🔒 게이트 선행 절대 준수**: external TestFlight·스토어 제출·공증 공개 다운로드는 M7 PASS + 03 PASS 블록 기록 후에만. 기록 없는 release = 규칙 위반.
2. **CI 아카이브 미활성**: Xcode 프로젝트는 셋 다 생겼지만(`clients/macOS`·`clients/iOS`·`clients/mobile/ios`) `ci-build.yml`의 **`xcode-apps` 잡은 여전히 주석**이라 CI가 `.ipa`/`.app`을 만들지 않는다. release 워크플로우(`release-ios.yml`/`release-macos.yml`)는 그 잡과 서명 자격이 서기 전까지 실동작 불가. 이 gotcha는 산출물이 CI에서 나오기 시작하면 갱신할 것.
3. **iOS 26 SDK + Xcode 26 게이트**: 2026-04-28부터 이 SDK/툴체인으로 빌드해야 ASC 업로드 가능(집행 04-29). C2 타깃 deployment/SDK 확인. (검증됨)
4. **UGC = 1순위 리젝(1.2)**: 모더레이션 4종 누락 시 강제 리젝. 에이전트(1급 멤버) 생성 콘텐츠 모더레이션 정책도 별도 명시. 익명/랜덤 채팅 요소 있으면 1.2 자동 적용.
5. **'24시간' 신고 처리는 가이드라인 원문 명문 아님**: 원문은 'timely responses'(적시 대응). 24h는 운영 권장치로만 취급.
6. **계정 삭제(5.1.1(v))**: '비활성화'가 아니라 '삭제'여야 함. 누락 시 리젝.
7. **암호화 export(ITSAppUsesNonExemptEncryption)**: 표준 TLS/APNs ES256만이면 면제(NO), 자체 암호화 있으면 YES + 수출 문서. 의존성 전수 확인 후 결정. 키 누락 시 매 빌드 수동 응답 요구.
8. **privacy manifest ↔ App Privacy 라벨 일관**: 본체 + 포함 SDK(APNSwift/Sentry)의 `NSPrivacyAccessedAPITypes`(required reason) 정확 선언. 불일치 시 제출 문제.
9. **Bundle ID explicit + 단일 진실원천**: Push엔 explicit 필수(와일드카드 불가). ASC 앱 레코드와 정확 일치, 재사용·삭제 제약. **현재 정본**은 iOS 앱 `app.momo.ios` · NSE `app.momo.ios.NotificationService`(확장도 **별도 App ID**, ASC 레코드는 앱만) · macOS `com.dawnkim.momo` · App Group `group.app.momo.ios` · keychain group `$(AppIdentifierPrefix)app.momo.ios.shared` · 팀 `YWQQFQM38J` — 표는 `docs/cicd/10-ios-signing-identity-runbook.md` §0. **Xcode의 `PRODUCT_BUNDLE_IDENTIFIER`가 정본이고 fastlane이 따라간다**(반대 아님). `scripts/verify_ios_signing.sh`가 매 실행 검사하므로 이 검사를 깨는 변경은 머지 금지.
10. **심사용 데모 SLA(2.1)**: 멀티팀/초대코드 흐름을 심사자가 끝까지 체험 가능해야 → 데모 워크스페이스 + 유효 초대코드 + 심사 기간 내내 server/Centrifugo/hermes 가동(꺼지면 빈화면 리젝).
11. **공증 ≠ App Store**: Developer ID 공증(notarytool, 직접배포)과 App Store 인증서/프로비저닝은 별개 트랙. 두 산출물·문서를 섞지 말 것.
12. **Sparkle 각 릴리스 공증·staple 필수**: 미공증 업데이트는 Gatekeeper 차단. appcast의 모든 .app/.dmg를 공증.
13. **스크린샷 규격은 시점별 변동**: 현 6.9"/6.5" iPhone, 13" iPad 등 — 제출 직전 ASC 최신 요구 재확인.
14. **신규 1.0은 즉시 전체 출시**: phased release(7일)는 주로 업데이트. 1.0에 phased 기대 금지.
15. **altool 폐기(2023-11-01)**: notarytool 유일 경로. `release-macos.yml`에 altool 미사용 확인.
16. **ASC API Key는 Team Key + App Manager 이상**: Individual Key는 provisioning/notary/Sales 불가. Developer 역할은 업로드만(빌드정보·테스터 갱신 불가).
17. **.p8 1회 다운로드**: ASC API Key·APNs Auth Key 모두 재다운 불가. base64 단일 secret(`ASC_KEY_P8_BASE64`)로 보관, 로그/커밋 노출 절대 금지.
18. **macOS 무료 쿼터 10x 승수**: GH Actions Free 2,000분 ≈ macOS 200분/월. 빈번 빌드 시 비용 급증 → Xcode Cloud 무료 25h를 백업 경로로.
19. **pilot groups는 External 그룹만**: Manual-for-Xcode Internal 그룹은 fastlane 배정 불가.
20. **fastlane 최신 고정**: 2025-05 Apple 미문서 API 제거(#29498) 대응. `Gemfile.lock` 커밋.
21. **법무 비자문**: EULA/개인정보처리방침/약관/수출규제/멀티테넌트 데이터 처리는 외부 변호사 1회 검토 필수.

---

## 10. Codex 작업 컨벤션 (이 PLAYBOOK 실행법)

- **다음 티켓 선택법**: `ROADMAP.md`/`BUILD_TICKETS.md`에서 `deps`가 전부 done인 가장 낮은 의존 깊이를 고른다. `[manual]`/`legal` 티켓은 Codex가 파일/런북만 준비, 실제 발급/계약/심사는 사람 위임 표시.
- **수용기준 등급**: `[swift]`=`swift build` green · `[infra]`=파일 존재+정합 · `[sql]`=정본 정합 · `[xcode]`=`xcodebuild` 산출 · `[ci]`=워크플로우 syntax/lint(`actionlint`) · `[runtime]`=docker/psql(미가용 시 `runtime-unverified` 표기) · `[manual]`=사람 1회.
- **정합 원칙**: 이전 티켓 산출물 깨지 말 것. `schema_v0.sql`은 정본(이동·수정 금지) — 확장은 `server/Migrations/00N_*.sql` 신규 + RLS DO-block ARRAY 등록.
- **DoD 기록**: 각 티켓 종료 시 검증 명령 결과를 `STATUS.md`에 기록. 미검증은 정직 표기.
- **🔒 release**: 게이트 PASS + 03 PASS 블록 기록 전 `release-*.yml` 트리거 금지(태그 자제 또는 environment protection).
- **검증 명령 빠른참조**:
  ```bash
  make build                                   # Swift 5패키지 컴파일
  make up && make migrate                      # [runtime] docker PG18+Centrifugo
  xcodebuild build -scheme MomoMac -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO
  xcodebuild build-for-testing -scheme MomoiOS -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest' CODE_SIGNING_ALLOWED=NO
  bundle exec fastlane ios ci_build            # [ci] 무서명
  actionlint .github/workflows/*.yml           # [ci] 워크플로우 lint
  gh secret list --repo Dawn-kim-official/momo           # 6 secret 확인
  spctl --assess --type execute --verbose build/MomoMac.app   # [manual] Gatekeeper
  ```

---

## 11. 출처 (2026 기준 1차 교차확인)

- iOS 26 SDK + Xcode 26 업로드 요건(2026-04-28~): https://developer.apple.com/news/?id=fxu2qp7b · https://developer.apple.com/news/?id=6lxhtioi (검증됨)
- 공증/Gatekeeper/notarytool/stapler(altool 폐기 2023-11-01): https://developer.apple.com/documentation/security/customizing-the-notarization-workflow · https://developer.apple.com/developer-id/ (검증됨)
- D-U-N-S(무료·약 7영업일): https://developer.apple.com/help/account/membership/D-U-N-S/ (검증됨)
- Program 가입($99/년): https://developer.apple.com/help/account/membership/program-enrollment/ (검증됨)
- privacy manifest(2024-11-12 필수): https://developer.apple.com/news/?id=pvszzano (검증됨)
- App Review Guidelines(1.2/3.1.1/5.1.1/2.1): https://developer.apple.com/app-store/review/guidelines/ (검증됨)
- App Privacy: https://developer.apple.com/app-store/app-privacy-details/ (검증됨)
- phased release(7일): https://developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases/ (검증됨)
- TestFlight: https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/ (검증됨)
- APNs(.p8 ES256/JWT 1h): https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns (검증됨)
- fastlane(API Key/match/pilot/deliver): https://docs.fastlane.tools/app-store-connect-api/ · /actions/match/ · /actions/pilot/ · /actions/upload_to_app_store/ (검증됨)
- GH Actions 러너 단가/무료 분/2026 변경: https://docs.github.com/en/billing/reference/actions-runner-pricing · https://github.com/resources/insights/2026-pricing-changes-for-github-actions (검증됨)
- Xcode Cloud 무료 25h: https://developer.apple.com/news/?id=ik9z4ll6 (검증됨)
- Sparkle: https://sparkle-project.org (검증됨)
- 리포 정본: `ROADMAP.md` · `STATUS.md` · `docs/cicd/00~09` · `docs/legal/00~03` · `legal/*` · `research/07-deepdive/04-self-build-l4-spec.md`(§8.3 APNs)
</content>
</invoke>
