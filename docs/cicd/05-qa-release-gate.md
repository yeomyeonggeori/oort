# momo — QA / 릴리스 게이트 (스토어 제출 선행, 데스크탑+모바일, 2026)

> 작성: 2026-06-24 · 실행 주체: **Codex (goal 자율)** · 산출 위치: 이 리포.
> 이 문서는 `docs/cicd/03-store-readiness-gate.md`의 **객관 통과기준(measurable DoD)** 을 정의한다.
> 03 = 게이트 체크리스트(무엇을 통과해야 하나), **05(이 문서) = "사용 가능 완전 판명"의 객관 수치/방법(어떻게 통과를 증명하나)**.
> 검증 표기: `(검증됨)` = 2026 기준 1차 출처 교차확인 · `(추정)` = 설계 판단 · 법무 텍스트는 **법률 자문이 아님**.

---

## 0a. 1차 출처 검증 로그 (2026-06-24 교차확인 — Apple/fastlane/Sentry 공식문서)

> 아래 사실 주장은 Apple Developer / fastlane / Sentry 공식문서로 직접 교차확인됨(2026-06-24). 임계값(99.5% 등)은 설계 디폴트(추정)이며 출처 검증 대상이 아님.

| # | 주장(이 문서 위치) | 1차 출처 검증 결과 |
|---|---|---|
| 1 | `performAccessibilityAudit()` — Xcode 15+, XCUIApplication, 이슈 발견 시 테스트 자동 실패; 감사 타입 한정/필터 가능 (§4.1) | **검증됨**. Apple XCTest 문서 + WWDC23 10035. |
| 2 | TestFlight 내부 ≤100(ASC 유저, 심사 없이), 외부 ≤10,000, **첫 빌드 Beta App Review** 필요 (§6) | **검증됨**. ASC Help: invite-external-testers / add-internal-testers. |
| 3 | App Review **Guideline 2.1 App Completeness** = 크래시/버그/플레이스홀더 거절, **베타는 TestFlight로**, 미해결 거절의 **40%+** (§9.2) | **검증됨**. App Store Review Guidelines + Distribute/app-review. |
| 4 | ASC API `betaFeedbackCrashSubmissions` / `betaFeedbackScreenshotSubmissions` 로 피드백 자동수집 (§7) | **검증됨**. ASC API 문서(두 리소스 실재) + 신규 Feedback API/webhook. |
| 5 | MetricKit `MXCrashDiagnostic`/`MXHangDiagnostic`, **iOS15/macOS12부터 진단 즉시 전달**(메트릭은 24h 1회) (§2.3, §5.1) | **검증됨**. MetricKit 문서 + WWDC20. |
| 6 | Xcode Organizer **8대 메트릭**(Battery/Launch/Hang/Memory/Disk/Scrolling/Terminations/MXSignposts), 유사앱 권장선 (§5.1) | **검증됨**. xcode/performance-and-metrics + WWDC20 10076. |
| 7 | 반응성 임계: **이산 100ms**(초과 시 인지/행 유발), **연속 5ms** 권장; **행 검출 임계 250ms**(설정 가능, 별개 개념) (§5.1) | **검증됨**. xcode/improving-app-responsiveness(100ms/5ms) + WWDC22 10082(250ms 행 임계). **주의: 100ms/5ms는 인지 임계, 250ms는 행 검출 임계 — 서로 다른 수치.** |
| 8 | Sentry Release Health = **Crash Free Sessions**(크래시로 안 끝난 세션 %) / **Crash Free Users**(기간 내 무크래시 유저 %), 릴리스별 (§2.1) | **검증됨**. docs.sentry.io/product/releases/health. |
| 9 | macOS 공증: `notarytool submit --wait` → `stapler staple`(zip엔 직접 스테이플 불가, 항목별) → `spctl --assess` Gatekeeper, hardened runtime 필수 (§9.3) | **검증됨**. notarizing-macos-software + customizing-the-notarization-workflow. |
| 10 | 업로드 SDK 요건: **2026-04-28부터 iOS 26 SDK / Xcode 26 이상** (§9.2) | **검증됨**(발효일 확정). Apple News upcoming-requirements(02032026a) + App Store Connect upload requirement(04-29 관련 공지). 업로드 직전 재확인 권고 유지. |
| 11 | `ITSAppUsesNonExemptEncryption`: HTTPS/URLSession 등 OS 내장 암호는 **수출문서 면제**, Info.plist 명시로 매 제출 질문 생략 (§9.1) | **검증됨**. Info.plist 키 문서 + complying-with-encryption-export-regulations. **법률 자문 아님.** |
| 12 | `CFBundleShortVersionString`(릴리스/버전, ≤3 dot 컴포넌트 숫자) + `CFBundleVersion`(빌드 반복 식별)이 함께 제출 식별 (§9.1) | **검증됨**. Info.plist 키 문서 + TN2420. |
| 13 | fastlane `precheck`(제출 전 ASC 메타 사전스캔), `deliver`(`--submit_for_review`/`submit_for_review true`로 심사 제출), `pilot`/`upload_to_testflight`(TestFlight 업로드) (§6~§9) | **검증됨**. docs.fastlane.tools: precheck / deliver / pilot. |

> 결론: 이 문서의 **절차·도구·플랫폼 요건 사실은 1차 출처와 일치(반증 없음).** 유일한 주의점은 §5.1의 반응성 수치 — 100ms/5ms(인지 임계)와 250ms(행 검출 임계)는 **다른 개념**이므로 혼용 금지(본 문서는 이미 구분 표기). 통과 임계값(99.5%/99.0%/p90<2s 등)은 출처가 없는 **설계 디폴트(추정)** 이며 표본 충분성(§2.4)과 함께 팀이 조정 가능.

---

## 0. 게이트 → 스토어 마일스톤 구조 (한눈에)

```
M0 런타임 검증 ── M1 v0 데모(D/B/C) ── M2 멀티팀/테넌시
                                          │
                                          ▼
                    ┌─────────────────────────────────────────┐
                    │  M3 검수 게이트 (gate:qa) — 이 문서       │
                    │  "사용 가능 완전 판명" 객관 통과기준       │
                    │  G-0 런타임 e2e   G-A 크래시-free율        │
                    │  G-B 핵심플로우 e2e   G-C 접근성           │
                    │  G-D 성능   G-E 베타(TestFlight+공증빌드)  │
                    │  G-F 베타 피드백   G-G 릴리스준비          │
                    │  G-H Enterprise Trust evidence             │
                    └─────────────────────────────────────────┘
                       │ PASS(상단에 날짜+커밋해시 기록) 후에만 ↓
              ┌────────┴────────┐
              ▼                 ▼
   M4 데스크탑 공증 배포   M5 iOS 앱스토어 제출
   (release-macos.yml)    (release-ios.yml)
```

**불변식(절대 규칙):** G-A~G-H 전부 PASS(증거 첨부) 전에는 `release-macos.yml`/`release-ios.yml`(notarize 직접배포 / `deliver` App Store 제출)를 **트리거하지 않는다.** CI는 게이트 전까지 `build+test`와 베타(TestFlight/공증빌드) 업로드까지만 돈다.

> ⚠️ TestFlight 업로드(베타) 자체는 게이트의 **수단**이지 스토어 제출이 아니다. 즉 `pilot`(TestFlight) 업로드는 게이트 진행 중 허용, `deliver`(App Store 제출 `submit_for_review:true`)는 게이트 PASS 후. macOS는 공증된 .dmg를 **비공개 채널로** 베타 배포(게이트 중) → PASS 후 공개 다운로드.

---

## 1. "사용 가능 완전 판명" — 객관 통과기준 요약표

| 게이트 | 측정 대상 | 통과 기준(목표) | 측정 방법 | 자동/수동 | 출처/근거 |
|---|---|---|---|---|---|
| **G-A** 크래시-free율 | 안정성 | **세션 기준 ≥ 99.5%**, **유저 기준 ≥ 99.0%**, 베타 기간(≥7일/≥최소표본) | Sentry Release Health / MetricKit / TestFlight crashes | 자동 집계 + 수동 판정 | (추정 임계 / 도구는 검증됨) |
| **G-B** 핵심플로우 e2e | 기능 무결함 | 핵심 시나리오 **8/8 PASS**, 치명 결함 0 | XCUITest(iOS) + 수동 스모크(macOS) | 자동(UI) + 수동 | (설계) |
| **G-C** 접근성 | 포용성 | `performAccessibilityAudit` **치명 위반 0**(VoiceOver/Dynamic Type/대비) | XCTest 접근성 감사 + Accessibility Inspector | 자동 + 수동 | (검증됨, Xcode 15+) |
| **G-D** 성능 | 반응성 | 콜드 런치 p90 **< 2s**, hang rate **≈ 0(<0.1s/h)**, 주 화면 메모리 안정, 스크롤 60/120fps 드랍 미미 | XCTest 성능 메트릭(XCTApplicationLaunchMetric 등) + Xcode Organizer | 자동 + 관찰 | (검증됨 메트릭 / 임계는 추정) |
| **G-E** 베타 사용성 | 실사용 검증 | iOS: 내부+외부 TestFlight 빌드 설치·1왕복 / macOS: 공증 .dmg 타 맥 Gatekeeper 통과·1왕복 | TestFlight / spctl + 실기기 | 수동(실사용) | (검증됨) |
| **G-F** 베타 피드백 | 결함 회수 | 베타 피드백 전수 트리아지, **P0/P1 잔여 0** | App Store Connect 피드백 + ASC API 수집 | 수동 + 스크립트 | (검증됨) |
| **G-G** 릴리스 준비 | 제출 요건 | 스토어 메타/프라이버시/암호화 신고/버전·빌드번호 체크리스트 100% | `precheck`/`deliver --verify` + 수동 | 자동 + 수동 | (검증됨) |
| **G-0** 런타임 e2e | 백엔드 왕복 | 03 §G-0 (서버↔PG18↔Centrifugo↔hermes 1왕복) | docker e2e | 수동/runtime | (선결, STATUS.md §5) |
| **G-H** Enterprise Trust | 보안/공급망/감사 신뢰 | threat model + SBOM/license scan + secret scanning + VDP/pentest plan + security whitepaper draft | local gate evidence + 수동 리뷰 | 자동 + 수동 | (설계, MOMO-140) |

> 임계값(99.5%/2s 등)은 **출시 게이트 디폴트(추정)** 다. 표본이 작은 자체구축 내부 도구이므로 **표본 충분성**(아래 §2.4)이 수치만큼 중요하다. 팀이 더 빡세게/느슨하게 조정 시 이 표의 값을 바꾸고 사유를 게이트 PASS 기록에 남긴다.

---

## 2. G-A 크래시-free율 (안정성)

### 2.1 정의 (도구별 차이 주의 — 검증됨)
- **세션(session) 기준**: 크래시로 끝나지 않은 세션 비율. 노출 큰 지표(실서비스 표준은 보통 99.x%).
- **유저(user) 기준**: 기간 내 단 1회도 크래시를 안 본 유저 비율. 한 유저 1크래시면 그 유저는 "non-crash-free"로 빠짐 → 일반적으로 세션 기준보다 **더 보수적(낮게 나옴)**.
- **Sentry**: Release Health가 "Crash Free Sessions" / "Crash Free Users"를 릴리스(빌드)별로 제공. (검증됨)
- **Firebase Crashlytics**: "crash-free users" 중심 + 이슈 상세. (검증됨)
- **MetricKit / TestFlight**: 디바이스 크래시 카운트(세션 분모는 직접 구해야 함). TestFlight는 빌드별 crash 수/세션 메트릭을 ASC에 표시. (검증됨)

### 2.2 통과 기준 (디폴트, 추정)
- **세션 ≥ 99.5%** AND **유저 ≥ 99.0%**, 베타 기간 전체에서.
- **신규(미해결) crash 그룹 중 P0/P1 = 0** (P0=핵심 플로우 차단/데이터 손상, P1=빈발·플로우 일부 차단).
- 측정 윈도우: **마지막 게이트 후보 빌드로 ≥ 7일 또는 ≥ N세션**(N은 §2.4 표본 충분성).

### 2.3 수집 경로 (momo 권고)
- **iOS/macOS 클라이언트(SwiftUI)**: **Sentry Cocoa SDK** 1순위(릴리스 헬스 + crash-free 세션 내장, MetricKit 인입 옵션, permissive). 보조로 **MetricKit 직수집**(서드파티 0 의존, 오프라인 자체 집계). 상세 = `docs/cicd/07-crash-analytics-spec.md`.
- **Crashlytics(Firebase)**는 Google SDK/계정 종속 → momo의 "자체구축·permissive" 기조와 충돌. **선택지로만 문서화**, 디폴트는 Sentry+MetricKit. (추정)
- **TestFlight crashes**: 베타 기간 보조 신호(특히 공개링크 익명 테스터의 crash 카운트). (검증됨)

### 2.4 표본 충분성 (작은 내부 베타의 함정 — 추정)
- 자체구축 멤버 베타는 표본이 작다(수십~수백 세션). **세션 < 200이면 % 신뢰 낮음** → "절대 크래시 수 0~1 + 핵심플로우 e2e 그린"을 병행 조건으로.
- 게이트 PASS 기록에 **분모(세션/유저 수)와 윈도우**를 반드시 명기. "99.7% (412 sessions / 9 users / 8 days)" 식.

---

## 3. G-B 핵심플로우 e2e (기능 무결함)

### 3.1 핵심 시나리오 8 (momo 제품 플로우)
1. **로그인/온보딩**: 초대코드 입력 → 자가가입 → 워크스페이스 진입.
2. **채널**: 채널 목록 로드 → 채널 입장 → 히스토리 렌더.
3. **메시지 송수신**: 텍스트 전송 → `channel_seq` 갭리스 도착(본인+타기기) → 실시간 수신(Centrifugo).
4. **에이전트 멘션(김인턴)**: 멘션 → `agent.partial` 스트리밍 렌더 → 최종 메시지 확정.
5. **Live Tool-Call 카드(D 경험)**: 툴콜 카드 표시/진행/완료 상태 전이.
6. **승인 인박스(C 경험)**: 승인 요청 도착 → 승인/거부 → 결과 반영.
7. **비용 호흡 링(B 경험)**: reserve→reconcile 비용이 링에 실시간 반영.
8. **멀티팀 격리**: 다른 워크스페이스 행/채널 **미노출**(RLS 격리 사용자 체감).

### 3.2 통과 기준
- **8/8 PASS**, 각 시나리오 치명 결함(크래시·데이터 손상·플로우 차단) 0.
- iOS는 **XCUITest로 자동화**(최소 1~4, 8). macOS는 자동화 어려운 부분(실시간/스트리밍 렌더)은 **수동 스모크 + 스크린샷 증거**.
- 자동화 상세/테스트 plan = `docs/cicd/08-e2e-accessibility-performance.md`.

---

## 4. G-C 접근성 (포용성)

### 4.1 자동 감사 (검증됨 — Xcode 15+)
- `XCUIApplication().performAccessibilityAudit()` (또는 `performAccessibilityAudit(for:)` 로 타입 한정). Accessibility Inspector와 동일 룰을 UI 테스트에서 실행. (검증됨)
- 감사 타입(`XCUIAccessibilityAuditType`): `.contrast`, `.dynamicType`, `.elementDetection`, `.hitRegion`, `.sufficientElementDescription`, `.textClipped`, `.trait` 등. `.all`에서 일부 제외도 가능. (검증됨)

### 4.2 통과 기준
- 핵심 화면(채널/메시지/멘션/승인/비용)에서 **치명 접근성 위반 0**: 레이블 누락, 대비 부족, Dynamic Type 미지원으로 텍스트 잘림, 히트영역 과소.
- VoiceOver 1회 수동 워크스루(핵심 8플로우 중 핵심 4)로 "조작 가능" 확인.
- macOS는 Accessibility Inspector 수동 감사(자동 audit는 XCUITest 의존).

---

## 5. G-D 성능 (반응성)

### 5.1 측정 메트릭 (검증됨)
- **콜드 런치**: `XCTApplicationLaunchMetric`(XCTest 성능 측정) / Xcode Organizer Launch Time(아이콘 탭→첫 화면 ms). (검증됨)
- **Hang rate**: 응답 불가 시간(초/시간). **이상치 0**, 100ms 초과 메인스레드 블록 회피(이산 상호작용 인지 임계 100ms / 연속 5ms). (검증됨)
- **메모리/디스크/스크롤/종료**: Xcode Organizer 8대 메트릭(Battery, Launch, Hang, Memory, Disk Writes, Scrolling, Terminations, MXSignposts) — Organizer가 유사앱 기준 권장선(점선) 표시. (검증됨)

### 5.2 통과 기준 (디폴트, 임계는 추정)
- **콜드 런치 p90 < 2.0s**(저사양 실기기 기준 권장).
- **Hang rate ≈ 0** (<0.1s/h), 메인스레드 100ms+ 블록 0.
- 메인 리스트(메시지) 스크롤 **드랍 프레임 미미**(60/120Hz), 메모리 누수 없음(장시간 세션 후 안정).
- 측정은 **Release 구성 + 실기기**(시뮬레이터 수치 무효). 자동 회귀는 XCTest 성능 baseline, 필드 수치는 Organizer/MetricKit.

---

## 6. G-E 베타 사용성 (실사용 검증) → `docs/cicd/06-beta-testflight-plan.md`
- **iOS**: TestFlight **내부(≤100, App Store Connect 유저, 심사 없이 즉시)** → **외부(≤10,000, 첫 빌드 Beta App Review 필요)** 순. 실기기 설치 → 핵심 8플로우 1왕복. (검증됨)
- **macOS(직접배포)**: TestFlight macOS도 가능하나 **정식 경로가 Developer ID 공증 직접배포** → 게이트 단계에선 **공증된 .dmg를 비공개 채널 베타 배포** → 타 맥에서 `spctl --assess`/Gatekeeper 통과 + 핵심 플로우 1왕복. (검증됨)
- 상세 절차/한계/표본은 06 문서.

## 7. G-F 베타 피드백 트리아지 (결함 회수) → 06 문서
- TestFlight 2.3+ 테스터는 **스크린샷+코멘트+크래시 코멘트**를 인앱/스크린샷으로 제출 → App Store Connect 피드백에 표시(플랫폼/버전/빌드/OS/기기로 필터, .zip 다운로드). (검증됨)
- **App Store Connect API**로 자동 수집: `betaFeedbackScreenshotSubmissions`, `betaFeedbackCrashSubmissions`. (검증됨) → 트리아지 누락 방지 스크립트.
- 통과 기준: 베타 기간 피드백 **전수 트리아지** + 라벨링, **P0/P1 잔여 0**.

## 8. G-G 릴리스 준비 체크리스트 → §9
- 메타데이터/프라이버시/암호화 신고/버전·빌드번호/스크린샷·아이콘 = `precheck`/`deliver --verify`로 사전검증 + 수동.

## 8a. G-H Enterprise Trust evidence
- threat model, data flow, deployment hardening guide, agent execution ledger 설명을 security whitepaper 초안으로 묶는다.
- SBOM, dependency license scan, secret scanning, local gate evidence를 release evidence에 포함한다.
- external pentest, vulnerability disclosure policy, SOC2 Type I/II, ISO27001, CSA STAR, ISMS-P는 단계별 로드맵과 책임자를 기록한다.
- 상세 티켓: `MOMO-140`. 연구 정본: `research/10-local-ai-protocol-trust/03-enterprise-trust-local-ops.md`.

---

## 9. 릴리스 준비 체크리스트 (G-G, 제출 직전 — 공통/플랫폼별)

### 9.1 공통
- [ ] **버전/빌드번호** 규칙 확정(`CFBundleShortVersionString` = SemVer, `CFBundleVersion` = 단조증가 빌드번호; CI가 `GITHUB_RUN_NUMBER`로 주입).
- [ ] **변경로그/릴리스 노트** 작성(TestFlight `changelog` + 스토어 What's New).
- [ ] **개인정보 처리방침 URL** 라이브.
- [ ] **App Privacy(데이터 수집) 라벨** 작성: Sentry/MetricKit/분석이 수집하는 데이터(크래시·식별자·진단) 반영. (검증됨, ASC 필수)
- [ ] **암호화 수출규제**: `ITSAppUsesNonExemptEncryption` 설정(HTTPS/표준 암호만이면 보통 면제, 그래도 명시). **법률 자문 아님 — 법무 1회 확인(L4 §10).**
- [ ] **라이선스/약관**: 의존성 permissive 유지 확인, 외부배포 전 법무 검토 1회. **법률 자문 아님.**

### 9.2 iOS (App Store)
- [ ] App Store Connect App 레코드 + Bundle ID(`com.dawnkim.momo`) 등록.
- [ ] **iOS SDK 요건**: 업로드 시점 Apple 최소 SDK 요건 충족(예: iOS 26 SDK 이상 — 2026-04-28 발효, 업로드 직전 재확인). (검증됨, 단 발효일은 출처 재확인)
- [ ] 스크린샷(필수 기기 사이즈), 아이콘, 설명, 키워드, 카테고리, 연령등급.
- [ ] **Guideline 2.1(App Completeness)**: 크래시/버그/플레이스홀더("Lorem Ipsum"/임시 이미지) 0. 2.1은 2026 미해결 거절의 40%+ — 게이트 G-A/G-B와 직결. (검증됨)
- [ ] 데모/베타는 App Store가 아닌 TestFlight로(2.1). (검증됨)
- [ ] `precheck` 통과 + `deliver(submit_for_review:false)`로 메타 사전검증 1회.

### 9.3 macOS (공증 직접배포)
- [ ] Developer ID Application 서명 + **hardened runtime** + 필요한 entitlements만.
- [ ] `notarytool submit --wait` Accepted + `stapler staple` + `stapler validate`.
- [ ] **타 맥(빌드 안 한 머신)에서 Gatekeeper 통과**: `spctl --assess --type execute --verbose Momo.app` accepted.
- [ ] .dmg 서명/스테이플 + 다운로드 경로(웹/Release) 확정.

---

## 10. 게이트 PASS 판정 & 기록 (감사 가능)
PASS 조건: **G-0, G-A~G-H 전부 체크 + 증거 첨부.** PASS 시 `docs/cicd/03-store-readiness-gate.md` 상단에 아래 블록 기록:

```
GATE PASS: 2026-MM-DD · commit <sha> · 빌드 iOS <build#> / macOS <build#>
- G-A 크래시-free: 세션 99.x% / 유저 99.x% (분모 NNN세션 / N유저 / D일, 출처: Sentry release <ver>)
- G-B e2e: 8/8 PASS (XCUITest run <id> + 수동 스모크 스크린샷 링크)
- G-C 접근성: 치명 위반 0 (performAccessibilityAudit run <id>)
- G-D 성능: 런치 p90 1.xs / hang 0 (Organizer + XCTest baseline)
- G-E 베타: iOS TF 내부+외부 1왕복 / macOS 공증.dmg 타맥 Gatekeeper PASS
- G-F 피드백: 전수 트리아지 N건, P0/P1 잔여 0
- G-G 릴리스준비: 9.1~9.3 체크리스트 100%
- G-H Enterprise Trust: threat model/SBOM/license/secret scan/VDP-pentest plan/security whitepaper evidence
판정자: <name> · 다음 단계: M4/M5 release 워크플로우 활성 허용
```

> 기록 후에만 `v*.*.*` 태그 → release 워크플로우 가동. 기록 없는 release 트리거는 규칙 위반.

---

## 11. 출처 (2026 기준 1차/교차확인)
- TestFlight 외부 테스터 한도(10,000)·첫 빌드 Beta App Review·공개링크·익명 테스터 crash 추적: https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/ · https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/ (검증됨)
- 내부 테스터(≤100, ASC 유저, 심사 없이 즉시): https://developer.apple.com/testflight/ (검증됨)
- 테스터 피드백(스크린샷/크래시 코멘트, ASC 표시·.zip): https://developer.apple.com/help/app-store-connect/test-a-beta-version/view-tester-feedback/ · https://developer.apple.com/news/?id=testerfeedback (검증됨)
- App Store Connect API 베타 피드백: https://developer.apple.com/documentation/appstoreconnectapi/beta-feedback-crash-submissions · https://developer.apple.com/documentation/appstoreconnectapi/beta-feedback-screenshot-submissions (검증됨)
- MetricKit(crash/hang/CPU 진단, iOS15/macOS12 즉시 전달): https://developer.apple.com/documentation/MetricKit · https://developer.apple.com/documentation/metrickit/mxcrashdiagnostic (검증됨)
- 접근성 자동 감사 performAccessibilityAudit / 감사 타입: https://developer.apple.com/documentation/xctest/xcuiapplication/4191487-performaccessibilityaudit (검증됨, Xcode 15+)
- 성능/반응성(8 메트릭, hang, 100ms/5ms, Organizer 권장선): https://developer.apple.com/documentation/xcode/performance-and-metrics · https://developer.apple.com/documentation/xcode/improving-app-responsiveness (검증됨)
- App Review Guideline 2.1 App Completeness(크래시/버그/플레이스홀더, 베타는 TestFlight): https://developer.apple.com/app-store/review/guidelines/ (검증됨)
- Sentry Release Health(crash-free sessions/users) vs Crashlytics: https://docs.sentry.io/product/releases/health/ · https://sentry.io/from/crashlytics/ (검증됨, 임계값은 추정)
- macOS 공증: https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution (검증됨)
