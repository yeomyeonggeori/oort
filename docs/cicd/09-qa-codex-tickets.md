# oort — QA/릴리스 게이트 Codex 실행 티켓 (의존순 · DoD · 명령)

> 실행 주체: **Codex(goal 자율)**. 컨벤션 = AGENTS.md §3 DoD + 04 등급 차용.
> 등급: `[infra]`=파일 존재+정합 · `[swift]`=`swift build` green · `[xcode]`=`xcodebuild`/`xcodebuild test` 산출 · `[ci]`=워크플로우 syntax/lint · `[manual]`=사람 1회(Apple 계정·실기기·베타).
> ⚠️ 이 티켓들은 **M3 검수 게이트(gate:qa)** 를 닫기 위한 것. release(M4/M5) 활성화는 게이트 PASS 후(05 §10).

## 다음 티켓 선택법 (04와 동일)
1. 의존(`dep`) 전부 done인 가장 낮은 order.
2. `[manual]`은 Codex가 파일/스크립트/문서만 준비, 실제 실행은 사람(런북/이 파일에 위임 표시).
3. 티켓 종료 시 DoD 체크 + 검증 결과를 STATUS.md(또는 본 파일)에 기록.

| order | id | 등급 | 한줄 | dep |
|---|---|---|---|---|
| 1 | `Q0-gate-docs` | infra | 게이트 문서(05~08) 존재·정합·03 링크 | — |
| 2 | `Q1-sentry-metrickit` | swift | 클라에 Sentry+MetricKit 계측(컴파일 green) | C1,C2(또는 라이브러리에 선반영) |
| 3 | `Q2-e2e-tests` | xcode | XCUITest 핵심플로우 + 단위테스트 골격 | C1,C2 |
| 4 | `Q3-a11y-audit` | xcode | performAccessibilityAudit 테스트 | C2 |
| 5 | `Q4-perf-tests` | xcode | XCTest 성능 baseline(런치/메모리) | C1,C2 |
| 6 | `Q5-qa-gate-ci` | ci | qa-gate.yml(UI+a11y+perf, 수동 dispatch) | Q2,Q3,Q4 |
| 7 | `Q6-feedback-fetch` | infra | ASC API 베타 피드백 수집 스크립트 | M1(ASC key) |
| 8 | `Q7-gate-run` | manual | 베타 배포→측정→게이트 PASS 기록 | Q1~Q6,게이트 선결(M0/M1/M2) |

---

## 티켓 상세

### ☐ Q0-gate-docs `[infra]`
- [x] `docs/cicd/05-qa-release-gate.md` · `06-beta-testflight-plan.md` · `07-crash-analytics-spec.md` · `08-e2e-accessibility-performance.md` 생성.
- [ ] `docs/cicd/03-store-readiness-gate.md`에 "객관 통과기준 → 05 문서" 링크 반영.
- DoD: 4문서 + 본 티켓 파일 존재, 03이 05를 참조, 출처 링크 유효.
- 검증: `ls docs/cicd/0[5-9]*.md` + 03 내 05 참조 grep.

### ☐ Q1-sentry-metrickit `[swift]`
- [ ] `clients/Core` 또는 클라 패키지에 **Sentry Cocoa(SwiftPM, 최신 안정, MIT 확인)** 의존 추가, `SentrySDK.start`(release/environment/enableMetricKit) 래퍼.
- [ ] `MXMetricManagerSubscriber` 구현(crash/hang/CPU 진단 수신 골격). 실기기 전제는 `runtime-unverified (no device)` 표기.
- DoD: **5개 패키지 `swift build` green 유지**(다른 패키지 안 깨짐). DSN/URL은 Config 주입(소스 평문 금지). 라이선스 permissive 확인.
- 검증: `make build` (전 패키지 green). 07 문서 §6 DoD.

### ☐ Q2-e2e-tests `[xcode]`
- [ ] `MomoiOSUITests` 타깃 + 핵심 8플로우(05 §3.1) 중 자동화 가능분(1,2,3,6,8) XCUITest 작성. 실시간 의존은 목 transport 주입.
- [ ] `MomoiOSTests` 단위테스트 골격.
- DoD: `xcodebuild test -scheme MomoiOS -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest'` 통과(자동화분 green). 수동분은 08 §1.1 표에 수동 표기.
- dep: C2(iOS Xcode 프로젝트).

### ☐ Q3-a11y-audit `[xcode]`
- [ ] `performAccessibilityAudit` 테스트(핵심 5화면). 치명 위반 0 목표, 알려진 미해결은 클로저 무시 + TODO.
- DoD: 접근성 테스트가 `xcodebuild test`에서 실행되고 치명 위반 0(또는 사유 기록).
- dep: C2.

### ☐ Q4-perf-tests `[xcode]`
- [ ] `XCTApplicationLaunchMetric` 런치 + `XCTMemoryMetric` baseline 테스트. Release 구성·실기기 측정은 게이트 단계(수동) — CI는 회귀만.
- DoD: 성능 테스트 컴파일·실행 + baseline 파일. 절대 임계(런치 p90<2s 등)는 실기기 측정으로 게이트 기록.
- dep: C1,C2.

### ☐ Q5-qa-gate-ci `[ci]`
- [ ] `.github/workflows/qa-gate.yml` (수동 `workflow_dispatch`): C1/C2 후 `xcodebuild test`(UI+a11y+perf baseline, 무서명, 시뮬레이터). release와 분리.
- DoD: `actionlint` 통과 + dispatch 1회 green(C1/C2 후).
- dep: Q2,Q3,Q4.

### ☐ Q6-feedback-fetch `[infra]`
- [ ] `scripts/qa/fetch_beta_feedback.sh`: ASC API Key(ES256 JWT)로 `betaFeedbackCrashSubmissions`/`betaFeedbackScreenshotSubmissions` 폴링 → `build/qa/feedback/<build#>/` 저장 + 미트리아지 요약.
- DoD: `sh -n` 통과 + (키 있을 때) 1회 호출 200. 비밀값 평문 금지(02 인벤토리 재사용).
- dep: M1(ASC key 발급).

### ☐ Q7-gate-run `[manual]` — 사람+Codex 협업
- Codex: 측정 수집 스크립트/요약 준비. 사람: 베타 배포(06)·실기기 측정·판정.
- [ ] iOS TestFlight 내부+외부 1왕복 / macOS 공증 .dmg 타맥 Gatekeeper PASS.
- [ ] G-A 크래시-free(분모/윈도우 명기) · G-B 8/8 · G-C 치명0 · G-D 임계 · G-F P0/P1 잔여0 · G-G 체크리스트.
- DoD: 05 §10 PASS 블록을 `docs/cicd/03-store-readiness-gate.md` 상단에 기록(날짜+커밋+빌드#+증거 링크). → 이후 M4/M5 착수 허용.
- dep: Q1~Q6 + M0/M1/M2 게이트 선결.

---

## 공통 명령
```bash
make build && make test                 # Swift 5패키지 (Q1 회귀)
xcodebuild test -project clients/iOS/MomoiOS.xcodeproj -scheme MomoiOS \
  -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest'   # Q2/Q3/Q4 (C2 후)
actionlint .github/workflows/qa-gate.yml   # Q5
sh -n scripts/qa/fetch_beta_feedback.sh    # Q6
```

## 컨벤션 (AGENTS.md 준수)
- 비밀값(Sentry DSN, ASC Key)은 secrets/Config만(02 인벤토리). 소스/로그 평문 금지.
- 새 의존(sentry-cocoa)은 permissive(MIT) 확인 후 추가. 다른 패키지 빌드 깨지면 닫지 않음.
- release 워크플로우는 게이트 PASS(05 §10) 전 트리거 금지.
- runtime/실기기 미검증은 `runtime-unverified (no device)`로 정직 표기.
