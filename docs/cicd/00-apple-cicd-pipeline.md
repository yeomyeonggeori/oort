# oort — Apple 앱 CI/CD 정식 파이프라인 스펙 (2026)

> 작성: 2026-06-24 · 대상 실행 주체: **Codex (goal 자율 실행)** · 산출 위치: 이 리포(`/Users/kwakseongjae/projects/momo`)
> 범위: **macOS 데스크탑 앱 공증(notarize) 직접배포** + **iOS 앱 TestFlight/App Store 업로드**.
> 검증 표기: `(검증됨)` = 2026 기준 1차 출처(Apple/GitHub/fastlane 공식문서) 교차확인 · `(추정)` = 설계 판단 · `(법률 자문 아님)`.
>
> **이 문서는 법률 자문이 아니다.** 라이선스/계약/수출규제/개인정보 관련 판단은 별도 법무 검토 필요(L4 §10).

---

## 0. 전제 · 게이트 (먼저 읽기)

### 0.1 현재 상태(STATUS.md 기준)

- Phase 0: 5개 Swift 패키지 `swift build` green. M1 runtime MOMO-001~004는 Docker Desktop으로 검증됨. 남은 런타임 후속은 WebSocket live subscribe/presence/recovery, APNs, staging이다.
- `clients/macOS` = SwiftPM **라이브러리 + smoke 실행 타깃**. 아직 **`.app` 번들 아님**(Xcode 프로젝트 없음).
- `clients/iOS` = **존재하지 않음**(디렉터리 미생성).
- 따라서 **이 CI/CD 파이프라인은 "배포 가능한 산출물(.app/.ipa)"이 생기기 전까지는 빌드/검증 단계까지만 실동작**한다. notarize/TestFlight 잡은 산출물 생성 이후 활성화.

### 0.2 스토어 게이트(마일스톤 — 선행 필수)

> **스토어 제출 전, "빌드 파일이 실제로 사용 가능"함을 빡세게 검수 통과해야 한다.** 이 검수 게이트가 모든 스토어 제출(notarize 배포 + App Store 제출)의 **선행 조건**이다.

검수 게이트 DoD (`docs/cicd/03-store-readiness-gate.md` 상세):
1. Phase 0 런타임 검증 완료(서버↔PG18↔Centrifugo↔hermes e2e 1회 이상 — STATUS.md §5).
2. macOS `.app`이 실기기에서 기동·로그인·메시지 송수신·에이전트 응답 1회 왕복 성공.
3. iOS 앱이 시뮬레이터+실기기에서 동일 시나리오 통과.
4. 크래시 0, 주요 플로우 수동 스모크 통과, 접근성/권한 prompt 정상.

→ **게이트 PASS 전에는 `release` 워크플로우(notarize/TestFlight)를 트리거하지 않는다.** CI는 PR/푸시마다 `build+test`만 돌린다.

### 0.3 권고 결론 (요약)

| 질문 | 권고 | 근거 |
|---|---|---|
| 어떤 CI? | **GitHub Actions `macos-15`(Apple Silicon) self-hosted 아님, GitHub-hosted** 우선 | org=dawnkim repo=momo가 이미 GitHub. fastlane 생태계 성숙. Xcode Cloud는 보조/백업. |
| 인증 | **App Store Connect API Key(.p8 + key_id + issuer_id) 단일화** | 비대화형·2FA 불필요·notarytool/pilot/deliver/provisioning 전부 커버(Team Key). (검증됨) |
| 코드사이닝 | **fastlane match(읽기전용 on CI)** + 별도 private git repo 저장 | 인증서/프로파일 재현성. CI에선 `readonly: true`. (검증됨) |
| macOS 공증 | **`xcrun notarytool submit --wait` + `xcrun stapler staple`** (API Key) | altool은 2023-11-01부터 폐기. notarytool이 유일 경로. (검증됨) |
| iOS 업로드 | **fastlane `pilot`(=upload_to_testflight)** → 검수 후 `deliver`(=upload_to_app_store) | 표준. API Key로 비대화형. (검증됨) |
| 비용 | 월 빌드 적으면 **Xcode Cloud 무료 25h로 충분**, 빈번하면 GH Actions(macOS 분당 과금 주의) | 아래 §6 비용표. |

---

## 1. 인증 — App Store Connect API Key (.p8) 비대화형 (검증됨)

### 1.1 왜 API Key인가

- App Store Connect는 전 계정 **2FA 강제** → Apple ID + 앱전용 비밀번호 방식은 CI에서 불안정/대화형 위험.
- **API Key(JWT)** 는 완전 비대화형. fastlane의 `app_store_connect_api_key` 액션이 key_id/issuer_id/.p8로 JWT를 만들어 **match / pilot / deliver / notarize**에 주입. (검증됨, fastlane docs)
- **반드시 Team Key를 생성**: Individual Key는 **Provisioning 엔드포인트(match), Sales/Finance, notaryTool 사용 불가**. (검증됨, fastlane docs)

### 1.2 발급 절차 (Apple 측, 1회)

1. App Store Connect → **Users and Access → Integrations(구 Keys) → App Store Connect API → Team Keys** → `+`.
2. 역할: **App Manager** 이상 권장(빌드 정보·테스터 갱신 권한 필요. Developer 역할은 업로드는 되나 빌드정보 갱신 불가 — 검증됨, pilot docs).
3. 다운로드한 `AuthKey_XXXXXXXXXX.p8`는 **단 1회만 다운로드 가능** → 안전 보관(이후 재다운 불가).
4. 메모: **Key ID**(예: `7UD13000`), **Issuer ID**(UUID, 예: `6bc36aee-...`).

### 1.3 비밀값 — GitHub Actions Secrets 등록

> 산출 파일 `docs/cicd/02-secrets-inventory.md`에 전체 목록. .p8는 base64로 인코딩해 단일 secret으로.

```bash
# .p8를 base64 한 줄로 (개행 없이)
base64 -i AuthKey_7UD13000.p8 | tr -d '\n' | pbcopy   # macOS

# gh CLI로 등록 (org=dawnkim, repo=momo)
gh secret set ASC_KEY_ID            --repo Dawn-kim-official/momo --body "7UD13000"
gh secret set ASC_ISSUER_ID         --repo Dawn-kim-official/momo --body "6bc36aee-...."
gh secret set ASC_KEY_P8_BASE64     --repo Dawn-kim-official/momo < <(base64 -i AuthKey_7UD13000.p8 | tr -d '\n')
gh secret set MATCH_GIT_URL         --repo Dawn-kim-official/momo --body "https://github.com/Dawn-kim-official/momo-signing.git"
gh secret set MATCH_PASSWORD        --repo Dawn-kim-official/momo --body "<match 암호화 패스프레이즈>"
gh secret set MATCH_GIT_TOKEN       --repo Dawn-kim-official/momo --body "<signing repo 접근 PAT 또는 deploy key>"
```

### 1.4 fastlane에서 키 로드 (base64 in-memory, 파일 미기록)

```ruby
# fastlane/Fastfile 내부에서
api_key = app_store_connect_api_key(
  key_id:      ENV["ASC_KEY_ID"],
  issuer_id:   ENV["ASC_ISSUER_ID"],
  key_content: ENV["ASC_KEY_P8_BASE64"],
  is_key_content_base64: true,          # base64 인코딩된 .p8 (검증됨)
  in_house: false                       # 일반 App Store/Developer ID 계정
)
# 이후 match(api_key: api_key) / pilot(api_key: api_key) / deliver(api_key: api_key)
```

> notarytool은 fastlane을 거치지 않고 직접 쓰는 경로도 있다(§4). 그 경우 .p8를 임시 파일로 디코드해 `--key`로 넘긴다.

---

## 2. 코드사이닝 자동화 — fastlane match (검증됨)

### 2.1 모델

`match`는 **인증서 + 프로비저닝 프로파일을 암호화해 별도 저장소(git/S3/GCS)에 보관**하고 CI/로컬에서 동기화한다. (검증됨, fastlane docs)

- 저장소: **별도 private git repo `Dawn-kim-official/momo-signing`** 권장(S3/GCS도 가능).
- CI에서는 **`readonly: true`**(=`is_ci`) — CI가 새 인증서를 만들지 못하게(재현성·계정 오염 방지). 새 인증서/프로파일 생성은 **개발자 머신에서 1회**. (검증됨)
- 인증서 종류:
  - iOS App Store 배포: `appstore`
  - macOS App Store 배포: `appstore` (platform: macos)
  - **macOS 직접배포(공증)**: **Developer ID** → match `developer_id` 타입. (Developer ID 인증서/프로파일)

### 2.2 최초 1회 (개발자 머신, 쓰기)

```bash
# signing repo 초기화 + 인증서/프로파일 생성·업로드 (대화형 OK, 1회)
bundle exec fastlane match init           # Matchfile 생성
bundle exec fastlane match appstore       # iOS App Store (Matchfile 기본값 = 앱 + 알림 확장)
# macOS는 번들 ID·타입이 다르므로 명시 필수(안 하면 iOS 기본값이 잘못 쓰인다)
bundle exec fastlane match developer_id --platform macos --app_identifier com.dawnkim.momo
```

### 2.3 CI에서 (읽기전용)

```ruby
match(
  type: "appstore",
  readonly: true,                 # CI 필수 (검증됨)
  api_key: api_key,               # API Key로 프로파일 갱신 인가
  # 앱과 확장은 각각 프로파일이 필요하다. 정본은 Xcode 프로젝트의
  # PRODUCT_BUNDLE_IDENTIFIER — docs/cicd/10-ios-signing-identity-runbook.md §0.
  app_identifier: ["app.momo.ios", "app.momo.ios.NotificationService"],
  git_url: ENV["MATCH_GIT_URL"],
  git_basic_authorization: Base64.strict_encode64("x-access-token:#{ENV['MATCH_GIT_TOKEN']}")
)
```

> ⚠️ 2025-05 Apple이 **문서화되지 않은 API 기능을 제거**해 match 일부 동작에 영향(fastlane issue #29498). → fastlane는 **최신 버전 고정**(Gemfile)으로 대응. (검증됨, 검색 출처)

---

## 3. 빌드 — gym / xcodebuild

### 3.1 전제: Xcode 프로젝트 산출물 필요

현재 `clients/macOS`/(미존재)`clients/iOS`는 **SwiftPM**이다. App 배포 산출물(.app/.ipa)을 만들려면:

- **옵션 A (권장):** SwiftPM 라이브러리는 그대로 두고, **얇은 Xcode App 프로젝트**(`clients/macOS/MomoMac.xcodeproj`, `clients/iOS/MomoiOS.xcodeproj`)를 추가해 MomoCore/MomoMac을 **로컬 SwiftPM 의존**으로 임포트. 앱 타깃만 Xcode가 빌드/서명/아카이브.
- **옵션 B:** `xcodebuild`로 SwiftPM executable을 직접 .app 번들링(코드사이닝/Info.plist 수작업) — 비권장(공증/엔타이틀먼트 관리 번거로움).

→ **이 파이프라인은 옵션 A를 가정**한다. (이 Xcode 프로젝트 추가는 별도 티켓 — `docs/cicd/04-codex-tickets.md` C1/C2 참고.)

### 3.2 gym (iOS .ipa)

```ruby
gym(
  scheme: "MomoiOS",
  export_method: "app-store",      # TestFlight/App Store
  configuration: "Release",
  output_directory: "build",
  clean: true
)
```

### 3.3 gym (macOS Developer ID .app/.pkg)

```ruby
gym(
  scheme: "MomoMac",
  export_method: "developer-id",   # 직접배포(공증 대상)
  configuration: "Release",
  output_directory: "build",
  clean: true
)
```

---

## 4. macOS 공증(notarize) 자동화 (검증됨)

### 4.1 핵심 사실 (2026)

- **altool 폐기**: Apple notary service는 **2023-11-01부터 altool 미지원**. **notarytool이 유일 경로**. (검증됨)
- notarytool은 **App Store Connect API Key(.p8) 비대화형 인증 지원**: `--key`, `--key-id`, `--issuer`. (검증됨, man page)
- 흐름: **서명(hardened runtime) → notarytool submit --wait → stapler staple → 검증**.

### 4.2 직접 notarytool (fastlane 없이)

```bash
# 0) .p8 복원 (CI에서 base64 secret → 임시 파일)
echo "$ASC_KEY_P8_BASE64" | base64 --decode > /tmp/AuthKey.p8

# 1) 제출 + 대기 (--wait: 완료까지 블록)  (검증됨)
xcrun notarytool submit build/MomoMac.zip \
  --key /tmp/AuthKey.p8 \
  --key-id "$ASC_KEY_ID" \
  --issuer "$ASC_ISSUER_ID" \
  --wait

# 2) 티켓 스테이플 (오프라인 검증용)
xcrun stapler staple build/MomoMac.app

# 3) 검증
xcrun stapler validate build/MomoMac.app
spctl --assess --type execute --verbose build/MomoMac.app
```

> notarytool은 `.zip`/`.pkg`/`.dmg` 제출. **.app은 .zip(ditto)으로 감싸 제출**, staple은 .app/.dmg에 직접. (검증됨)
> `--keychain-profile`(store-credentials로 저장)도 가능하나 **CI에선 키체인 부재** → `--key/--key-id/--issuer` 직접 플래그가 안전.

### 4.3 fastlane notarize 액션 (대안)

```ruby
api_key = app_store_connect_api_key(...)   # §1.4
notarize(
  package: "build/MomoMac.app",
  api_key: api_key,                # notarytool은 API Key 지원 (검증됨)
  print_log: true
)
# 주의: 일부 fastlane 버전에서 notarize+API Key 조합 버그 이력(issue #22055).
#       불안정하면 §4.2 직접 notarytool 경로로 폴백. (검증됨)
```

### 4.4 배포 패키징

- **.dmg**: `create-dmg` 또는 `hdiutil` → dmg에 staple → 다운로드 배포(웹/릴리스).
- 서명 순서: **앱 내부 dylib/framework부터 inside-out 서명 → 앱 서명 → 공증 → staple → dmg 서명** (deep sign). (추정·표준 관행)

---

## 5. TestFlight / App Store 자동 업로드 (검증됨)

### 5.1 TestFlight (pilot = upload_to_testflight)

```ruby
pilot(
  api_key: api_key,
  ipa: "build/MomoiOS.ipa",
  skip_waiting_for_build_processing: false,   # 빌드 처리 대기 (테스터 자동배포 시 필요)
  distribute_external: true,
  groups: ["momo-internal", "team-dawnkim"],  # External 그룹만 신뢰성 있게 동작 (검증됨)
  changelog: "자동 빌드 #{ENV['GITHUB_RUN_NUMBER']}"
)
```

- **Internal vs External**: `groups`는 **External Testing 그룹에서만 신뢰성 있게 동작**. "Manual for Xcode Builds"로 설정된 Internal 그룹은 fastlane 배정 불가. (검증됨, discussion #29642)
- 빌드정보/테스터 갱신은 **App Manager/Admin 역할** 필요(Developer 역할은 업로드만). (검증됨)
- 처리 대기 hang 이슈(#20645) 알려짐 → `skip_waiting_for_build_processing: true` + 별도 폴링으로 회피 가능. (검증됨)

### 5.2 App Store 제출 (deliver = upload_to_app_store) — **검수 게이트 PASS 후**

```ruby
deliver(
  api_key: api_key,
  ipa: "build/MomoiOS.ipa",
  submit_for_review: false,         # 처음엔 false (메타데이터/스크린샷 수동 확인)
  automatic_release: false,
  skip_screenshots: true,           # snapshot 연동 전까지
  precheck_include_in_app_purchases: false,
  force: true                       # HTML 미리보기 프롬프트 스킵(비대화형)
)
```

### 5.3 snapshot (스크린샷 자동화 — 선택)

`snapshot`은 UI 테스트로 다국어/다기기 스크린샷을 자동 생성 → `deliver`가 업로드. **검수 게이트 이후, 스토어 제출 직전에 도입** 권장(초기엔 수동 스크린샷으로 충분 — 추정).

---

## 6. GitHub Actions vs Xcode Cloud — 비용·한계 (검증됨, 2026)

### 6.1 GitHub Actions (GitHub-hosted macOS runner)

**무료 분(월, private repo):** Free 2,000 / Pro 3,000 / Team 50,000 Linux-분. **macOS는 10배 승수**로 무료 쿼터를 소모(Windows 2배). (검증됨)
→ **즉, Free 플랜 2,000분은 macOS 환산 200분/월에 불과.** macOS 빌드는 무료 쿼터를 빠르게 태운다.

**유료 단가(2026-01-01 ~40% 인하 후, 검증됨):**

| 러너 | 사양 | 분당(USD) | 비고 |
|---|---|---|---|
| macOS 3/4-core (M1/Intel) | 표준 | **$0.062** | `macos-15`/`macos-latest`(arm64 M1, 3 CPU/7GB), `macos-15-intel`(4 CPU/14GB) (검증됨) |
| macOS 12-core | 큰 러너 | **$0.077** | |
| macOS 5-core (M2 Pro) | 큰 러너 | **$0.102** | |

> 2026 변경: 전 러너 ~40% 인하 + **분당 $0.002 "Actions 클라우드 플랫폼 차지" 신설**(2026-01-01 발효), self-hosted 차지 2026-03-01. (검증됨)
> 러너 라벨(2026): `macos-latest`=`macos-15`(M1 arm64), `macos-14`, `macos-15`, `macos-26`(arm64), `macos-15-intel`/`macos-26-intel`(Intel). (검증됨)

**한계:**
- macOS 무료 쿼터 소모 빠름(10x). 빈번 빌드 시 비용 누적.
- 표준 러너 3 CPU/7GB — 대형 Xcode 빌드엔 다소 빠듯(큰 러너는 단가↑).
- 동시성/큐잉은 플랜별 제한.

### 6.2 Xcode Cloud

**무료:** 모든 Apple Developer Program 멤버십에 **월 25 compute-hour 포함**(2024-01 발효, 추가비용 0). (검증됨)

**유료(추가 시간, 검증됨, 검색 출처):**

| 가격(월, USD) | 시간 |
|---|---|
| $49.99 | 100h |
| $99.99 | 250h |
| $399.99 | 1,000h |
| $3,999.99 | 10,000h |

- **미사용 시간 이월 안 됨.** 구독 취소 시 25h로 복귀. (검증됨)
- 단위가 **시간(hour)** 이라 GH Actions 분 비교 시 환산 주의. 25h = 1,500분.

**한계:**
- **Apple 생태계 락인**(Xcode/App Store Connect 워크플로우 전용). Android/서버 빌드 불가.
- 커스터마이즈는 `ci_scripts/`(ci_post_clone/ci_pre_xcodebuild/ci_post_xcodebuild) 스크립트로 제한적.
- fastlane match 없이 **자동 서명**(Apple-managed) 사용 — 외부 CI와 서명 모델이 다름.
- notarize 직접배포(.dmg) 워크플로우엔 부적합(App Store/TestFlight 중심).

### 6.3 권고

- **oort 초기(빌드 빈도 낮음, macOS+iOS 둘 다, notarize 직접배포 필요):**
  → **주: GitHub Actions(`macos-15`) + fastlane**(notarize/match/pilot/deliver 일원화, 멀티플랫폼·서버까지 동일 CI).
  → **보조: Xcode Cloud 무료 25h**를 "App Store/TestFlight 전용 백업 경로"로(서명 단순). (추정)
- **빌드가 월 25h 이내로 수렴하고 iOS 위주면** Xcode Cloud 단독도 비용 0으로 합리적. notarize 직접배포는 여전히 GH Actions 필요.

---

## 7. 권고 파이프라인 (전체 그림)

```
PR/푸시 (main 외 브랜치, PR)
  └─ ci-build.yml  [모든 푸시·PR]
       - swift build / swift test (Core/server/relay/worker/macOS)   ← 항상
       - (Xcode 프로젝트 추가 후) xcodebuild build-for-testing (iOS/macOS)
       - lint(swiftformat/swiftlint, 도입 시)
       ※ 서명/배포 없음. 빠른 피드백.

검수 게이트(마일스톤) PASS  ──────────────────────────────────────────
  (docs/cicd/03-store-readiness-gate.md DoD 충족: 런타임 e2e + 실기기 사용성)

태그 푸시 v*.*.* 또는 수동 dispatch
  ├─ release-macos.yml  [공증 직접배포]
  │    api_key → match(developer_id, readonly) → gym(developer-id)
  │    → notarytool submit --wait → stapler staple → dmg → GitHub Release 업로드
  └─ release-ios.yml    [TestFlight]
       api_key → match(appstore, readonly) → gym(app-store)
       → pilot(distribute_external, groups) → (검수 후) deliver(submit_for_review)
```

산출 파일:
- `.github/workflows/ci-build.yml` — 빌드/테스트(항상)
- `.github/workflows/release-macos.yml` — 공증 직접배포(태그/수동)
- `.github/workflows/release-ios.yml` — TestFlight/App Store(태그/수동)
- `fastlane/Fastfile` · `fastlane/Appfile` · `fastlane/Matchfile` · `Gemfile`
- `docs/cicd/01-setup-runbook.md` — 1회 셋업 순서(키 발급→match init→secrets)
- `docs/cicd/02-secrets-inventory.md` — 비밀값 전체 목록
- `docs/cicd/03-store-readiness-gate.md` — 검수 게이트 DoD
- `docs/cicd/04-codex-tickets.md` — Codex 실행 티켓(의존순/DoD/명령)

---

## 8. 출처 (2026 기준 1차 교차확인)

- App Store Connect API Key / `app_store_connect_api_key` / Team Key 필수: https://docs.fastlane.tools/app-store-connect-api/ · https://docs.fastlane.tools/actions/app_store_connect_api_key/ (검증됨)
- match(저장소/readonly/타입): https://docs.fastlane.tools/actions/match/ · https://docs.fastlane.tools/actions/sync_code_signing/ (검증됨)
- pilot/upload_to_testflight(역할·그룹·대기): https://docs.fastlane.tools/actions/pilot/ · https://docs.fastlane.tools/actions/upload_to_testflight/ (검증됨)
- deliver/upload_to_app_store: https://docs.fastlane.tools/actions/upload_to_app_store/ (검증됨)
- notarytool 플래그/altool 폐기: https://keith.github.io/xcode-man-pages/notarytool.1.html · https://developer.apple.com/documentation/security/customizing-the-notarization-workflow (검증됨)
- GitHub Actions 러너 단가/라벨: https://docs.github.com/en/billing/reference/actions-runner-pricing · https://docs.github.com/en/actions/reference/runners/github-hosted-runners (검증됨)
- GitHub Actions 2026 가격변경(~40% 인하, $0.002 차지, 발효일): https://github.com/resources/insights/2026-pricing-changes-for-github-actions · https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/ (검증됨)
- macOS 10x 승수/무료 분: https://docs.github.com/en/actions/concepts/billing-and-usage (검증됨)
- Xcode Cloud 무료 25h: https://developer.apple.com/news/?id=ik9z4ll6 (검증됨) · 유료 티어 가격: https://developer.apple.com/xcode-cloud/ (검색 교차확인)
</content>
