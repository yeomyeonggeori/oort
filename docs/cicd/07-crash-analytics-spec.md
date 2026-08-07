# oort — 크래시 / 분석 계측 스펙 (Sentry · MetricKit · Crashlytics, 2026)

> 작성: 2026-06-24 · 실행 주체: **Codex (goal 자율)** · 게이트: 05 §G-A.
> 목적: 게이트의 크래시-free율(05 §2)을 **객관 수치로 측정**할 수 있게 클라이언트(iOS/macOS) 계측을 정의.
> 디폴트 권고: **Sentry Cocoa(1순위) + MetricKit 직수집(보조/0의존)**. Crashlytics는 선택지로만.
> 검증 표기: `(검증됨)` 1차 출처 · `(추정)` 설계 · 프라이버시 라벨은 **법률 자문 아님**.

---

## 1. 도구 선택 (oort 기조와의 정합)

| 도구 | 크래시-free 지표 | 멀티플랫폼 | 의존/계정 | permissive 정합 | oort 판단 |
|---|---|---|---|---|---|
| **Sentry Cocoa SDK** | Release Health: **Crash Free Sessions / Users**(릴리스별) (검증됨) | iOS/macOS/서버/웹 | self-host 가능(Sentry는 BSL/오픈), SaaS도 | ◎(self-host로 데이터 자가소유) | **1순위** |
| **MetricKit** | crash/hang/CPU **진단** + 일일 메트릭(세션 분모는 자체 계산) (검증됨) | iOS15+/macOS12+ | **서드파티 0**(Apple 프레임워크) | ◎ | **보조(항상 켬)** |
| **Firebase Crashlytics** | crash-free users 중심 (검증됨) | iOS/Android | Google SDK/계정 종속 | △(Google 종속) | **선택지로만 문서화** |

> oort는 "자체구축·permissive·플랫폼 관리자 전체 추적" 제품. **데이터 자가소유(self-host Sentry) + Apple 네이티브(MetricKit)** 조합이 기조에 맞다. Crashlytics는 팀이 Firebase를 이미 쓸 때만. (추정)

---

## 2. Sentry Cocoa 계측 (1순위)

### 2.1 핵심 요건
- SwiftPM 의존 추가(`sentry-cocoa`, 최신 안정 태그; permissive 확인 — Sentry SDK는 MIT). (검증됨: SDK 라이선스)
- `SentrySDK.start`에서 **release = 빌드 버전**, **environment = beta/production**, **enableMetricKit = true**(MetricKit 진단 인입) 설정. (검증됨: Sentry가 MetricKit diagnostics 인입 지원)
- **Release Health 활성**(세션 자동 추적) → Crash Free Sessions/Users가 릴리스별로 집계.
- DSN/서버 URL은 **빌드 시 주입**(secrets/Config), 소스 평문 금지.

### 2.2 측정 산출물 (게이트 입력)
- Sentry 대시보드의 빌드별 **Crash Free Sessions %** / **Crash Free Users %** → 05 §10 PASS 기록에 분모(세션/유저 수)와 함께 인용.
- 신규(미해결) issue 중 P0/P1 = 0 확인.

### 2.3 프라이버시 / 데이터 수집 (G-G 연계)
- Sentry는 크래시 스택·디바이스/OS·릴리스·(설정 시)breadcrumb/스크린샷을 수집 → **App Privacy 라벨에 반영 필수**(진단 데이터, 식별자 여부). PII 최소화(스크럽) 설정 권장. **법률 자문 아님.** (검증됨: ASC App Privacy 요건)
- 자체구축 멤버 대상이라도 동의/고지 문구 1회 검토(법무). **법률 자문 아님.**

---

## 3. MetricKit 직수집 (보조, 항상 켬 — 0 의존)

### 3.1 사실 (검증됨)
- `MXMetricManager` 구독(`MXMetricManagerSubscriber`) → `didReceive([MXMetricPayload])`(일일 메트릭) / `didReceive([MXDiagnosticPayload])`(진단).
- 진단 클래스: `MXCrashDiagnostic`(크래시), `MXHangDiagnostic`(행), `MXCPUExceptionDiagnostic`, `MXDiskWriteExceptionDiagnostic` 등. `callStackTree`(MXCallStackTree)로 스택. (검증됨)
- 전달 시점: **iOS 15+/macOS 12+ 진단 즉시 전달**, 메트릭은 24h당 최대 1회. (검증됨)
- 한계: `MXCallStackTree`는 JSON-only 인코딩 → 심볼리케이션/파싱 손이 감. (검증됨, 알려진 불편)

### 3.2 oort 사용
- payload를 서버(`POST /v1/diagnostics` 또는 별도 수집 엔드포인트)로 업로드 → **플랫폼 관리자 추적**(제품 목표의 "전체 추적")과 연결. (추정 — 자체 수집은 Sentry self-host로 갈음 가능)
- macOS 직접배포(TestFlight 미사용) 빌드의 **유일한 OS-레벨 진단원** → 반드시 활성.
- Sentry `enableMetricKit`을 켜면 MetricKit 진단이 Sentry로도 들어가므로 **이중 수집(자체 + Sentry)** 가능. (검증됨)

---

## 4. Crashlytics (선택지 — 디폴트 아님)
- Firebase 프로젝트 + GoogleService-Info.plist + Firebase SDK 필요(Google 종속). crash-free users 지표 제공. (검증됨)
- oort permissive/자가소유 기조와 충돌 → **팀이 명시적으로 선택할 때만**. 선택 시 05 §2.1의 "crash-free users" 정의로 게이트 판정. (추정)

---

## 5. 세션/분모 정의 (작은 표본 보정 — 05 §2.4)
- "세션"은 Sentry Release Health 기준(앱 포그라운드 활성 단위). MetricKit만 쓰면 세션 분모를 직접 정의해야 함(권장: Sentry 세션 사용).
- 게이트 PASS 기록에 **% + 분모(세션/유저 수) + 윈도우(일수)** 3종 세트 필수.

## 6. Codex 구현 메모 (DoD)
- `[swift]`: SwiftPM에 sentry-cocoa 추가 후 **5개 패키지 `swift build` green 유지**(다른 패키지 안 깨짐, AGENTS.md §3).
- `[swift]`: `MetricSubscriber`(MXMetricManagerSubscriber) 구현 → 컴파일 보장. 실제 페이로드 수신은 **실기기에서만**(시뮬레이터 미발생) → `runtime-unverified (no device)` 표기.
- 비밀값(DSN/서버 URL)은 Config 주입, 소스/로그 평문 금지(02 인벤토리에 추가).
- 의존 라이선스 permissive 확인(AGENTS.md §9).

## 7. 출처
- Sentry Release Health(Crash Free Sessions/Users): https://docs.sentry.io/product/releases/health/ (검증됨)
- Sentry + MetricKit 인입: https://docs.sentry.io/platforms/apple/ (검증됨, enableMetricKit)
- MetricKit / MXMetricManager / 진단 클래스: https://developer.apple.com/documentation/MetricKit · https://developer.apple.com/documentation/metrickit/mxcrashdiagnostic · https://developer.apple.com/documentation/metrickit/mxhangdiagnostic (검증됨)
- Crashlytics(crash-free users): https://firebase.google.com/docs/crashlytics (검증됨)
- App Privacy 라벨 요건: https://developer.apple.com/app-store/app-privacy-details/ (검증됨)
