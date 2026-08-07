# oort — 베타 배포 & 사용성 검수 플랜 (TestFlight + macOS 공증빌드, 2026)

> 작성: 2026-06-24 · 실행 주체: **Codex (goal 자율)** · 게이트: 05 §G-E/§G-F.
> 목적: 게이트(M3) 통과를 위해 **실사용 빌드를 테스터 손에** 올려 "사용 가능"을 빡세게 판명. 스토어 제출(M5) / 공개 다운로드(M4)는 게이트 PASS 후.
> 검증 표기: `(검증됨)` = Apple 1차 출처 · `(추정)` = 설계 판단 · 법무는 **법률 자문 아님**.

---

## 1. iOS — TestFlight 내부/외부 베타

### 1.1 핵심 사실 (검증됨, 2026)
| 항목 | 내부(Internal) | 외부(External) |
|---|---|---|
| 최대 인원 | **100명** (App Store Connect **유저**여야 함) | **10,000명** |
| 심사 | **없음 — 즉시 배포** | **버전당 첫 빌드 Beta App Review 필요**(이후 동일버전 빌드는 보통 면제) |
| 초대 | ASC에서 유저 추가 | 이메일/공개링크(공개링크 1~10,000 한도 설정 가능) |
| 빌드 만료 | **90일** | **90일** |
| 처리/제출 | 업로드 후 빌드 처리(수 분~) | TestFlight App Review 24h 내외 / 24h당 최대 6빌드 제출 |
| 공개링크 익명 | — | 이름/이메일 미표시(anonymous), 단 **설치일·세션·crash는 표시** |

> 출처: Apple App Store Connect Help — invite-external-testers / testflight-overview / Apple TestFlight 페이지. (검증됨)
> ⚠️ fastlane `pilot`의 `groups:` 자동 배정은 **External Testing 그룹에서 신뢰성 있게 동작**. "Manual for Xcode Builds" Internal 그룹은 자동 배정 불가(00 문서 §5.1). (검증됨)

### 1.2 oort 베타 단계 (권고)
1. **내부(team-dawnkim)**: 개발/운영 멤버를 ASC 유저로 등록 → 빌드 업로드 즉시 노출. 핵심 8플로우(05 §3.1) 1차 스모크. 심사 없음 → 빠른 반복.
2. **외부(momo-internal-beta)**: 자체구축 멤버(10명=1팀, 3+팀) 초대. **첫 빌드만 Beta App Review** → 통과 후 동일버전 반복 빌드는 빠르게. 멀티팀 격리·초대코드 자가가입을 실디바이스에서 검증.
3. (선택) **공개링크**: 표본 확대 필요 시. 익명 테스터의 crash/세션이 G-A 분모 보강에 유용. (추정)

### 1.3 fastlane lane (00 §5.1 기반, 게이트 단계용)
```ruby
# fastlane: ios beta — TestFlight 업로드 (게이트 중 허용, deliver 아님)
pilot(
  api_key: api_key,
  ipa: "build/MomoiOS.ipa",
  skip_waiting_for_build_processing: true,   # 처리 hang 회피(#20645) → 별도 폴링
  distribute_external: true,
  groups: ["momo-internal-beta"],            # External 그룹
  changelog: "beta #{ENV['GITHUB_RUN_NUMBER']} — #{ENV['GIT_SHA'][0,7]}"
)
```

---

## 2. macOS — 공증 빌드 베타 (직접배포 경로)

### 2.1 왜 TestFlight가 아니라 공증 .dmg인가
- oort macOS의 **정식 배포 경로 = Developer ID 공증 직접 다운로드**(M4). 따라서 게이트의 macOS 사용성 검수도 **실제 배포 산출물(공증 .dmg)** 로 해야 의미가 있다. (설계)
- TestFlight macOS 베타도 가능(테스터가 macOS에서 TestFlight 앱 사용) 하나, 직접배포 산출물과 서명/설치 경로가 달라 **공증 .dmg 베타가 1순위**. (추정 — TestFlight macOS 자체는 검증됨)

### 2.2 절차 (게이트 단계, 비공개 베타)
1. `gym(export_method: "developer-id")` → `Momo.app`.
2. inside-out 서명(dylib/framework→app) + hardened runtime.
3. `xcrun notarytool submit Momo.zip --key … --wait` → Accepted.
4. `xcrun stapler staple Momo.app` → `.dmg` 패키징 → dmg에도 staple.
5. **비공개 배포**(내부 링크/사내 채널)로 테스터에게 전달.
6. 테스터: **빌드 안 한 다른 맥**에서 `spctl --assess --type execute --verbose Momo.app` → accepted, Gatekeeper 경고 없이 실행 + 핵심 8플로우 1왕복.

### 2.3 macOS 크래시/피드백 수집
- TestFlight 미사용 시 인앱 피드백 없음 → **Sentry/MetricKit(07 문서)** 가 macOS 크래시-free율의 주 수집원.
- 수동 피드백: 내부 GitHub Issue(`type:bug` + `gate:qa`)로 회수.

---

## 3. 베타 피드백 트리아지 (G-F)

### 3.1 수집 채널
- **TestFlight 인앱 피드백**(테스터 v2.3+, iOS/macOS/visionOS): 스크린샷+마크업, 코멘트, 크래시 코멘트 → App Store Connect "Feedback"에 표시(플랫폼/버전/빌드그룹/빌드/OS/기기 필터, .zip 다운로드). (검증됨)
- **App Store Connect API**(자동·누락 방지):
  - `GET /v1/apps/{id}/betaFeedbackScreenshotSubmissions`
  - `GET /v1/apps/{id}/betaFeedbackCrashSubmissions`
  (App Store Connect API Key 인증; CI에서 주기적 수집 → 이슈 동기화) (검증됨)
- **Sentry**: crash/error 자동 그룹핑 + 릴리스 헬스(07 문서).
- **macOS 수동 피드백**: GitHub Issue.

### 3.2 트리아지 규칙
- 모든 피드백/crash 그룹에 **P0/P1/P2 라벨** 부여(P0=핵심플로우 차단/데이터손상, P1=빈발/부분차단, P2=경미).
- 통과 기준: **P0/P1 잔여 0**(P2는 후속 이슈로 추적 허용).
- 회귀 방지: 재현된 P0/P1은 **XCUITest 또는 수동 스모크 항목으로 고정**(05 §3, 08 문서).

### 3.3 ASC API 피드백 수집 스크립트(설계 스텁 — 권고)
```
scripts/qa/fetch_beta_feedback.sh   # ASC API Key(JWT) → 위 2 엔드포인트 폴링
  → 새 crash/screenshot 피드백을 build/qa/feedback/<build#>/ 에 저장
  → 미트리아지 항목을 표준출력에 요약(게이트 점검용)
```
> (추정) Codex가 ASC API JWT 생성(ES256, .p8)을 구현. 비밀값은 00 §1.3 secrets 재사용(별도 키 파일/로그 평문 금지).

---

## 4. 베타 표본 충분성 & 윈도우 (05 §2.4 연계)
- 자체구축 내부 베타는 표본이 작다. **세션 < 200이면 %만으로 판정 금지** → "절대 crash 0~1 + e2e 그린 + P0/P1 잔여 0" 병행.
- 윈도우: **게이트 후보 빌드로 ≥ 7일 또는 ≥ 합의 세션 수**. PASS 기록에 분모/윈도우 명기(05 §10).

## 5. 한계 / 주의
- 외부 첫 빌드 Beta App Review 지연(24h±) → 게이트 일정에 반영. (검증됨)
- TestFlight 빌드 90일 만료 → 게이트 장기화 시 재업로드 필요. (검증됨)
- 공개링크 익명 테스터는 이름/이메일 없음(피드백 추적성↓), crash/세션만 집계. (검증됨)
- macOS 공증은 직접배포라 "설치 수/세션" 자동 집계가 없음 → Sentry/MetricKit 의존. (설계)

## 6. 출처
- 내부/외부 한도·심사·공개링크·익명 crash: https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/ · https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/ · https://developer.apple.com/testflight/ (검증됨)
- 피드백(스크린샷/크래시 코멘트, .zip): https://developer.apple.com/help/app-store-connect/test-a-beta-version/view-tester-feedback/ · https://developer.apple.com/news/?id=testerfeedback (검증됨)
- ASC API 베타 피드백 엔드포인트: https://developer.apple.com/documentation/appstoreconnectapi/beta-feedback-crash-submissions · https://developer.apple.com/documentation/appstoreconnectapi/beta-feedback-screenshot-submissions (검증됨)
- 빌드 상태/메트릭(세션/crash): https://developer.apple.com/help/app-store-connect/test-a-beta-version/view-build-status-and-metrics/ (검증됨)
- macOS 공증: https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution (검증됨)
- fastlane pilot 그룹/대기: https://docs.fastlane.tools/actions/pilot/ (검증됨)
