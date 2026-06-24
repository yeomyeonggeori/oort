# momo — e2e · 접근성 · 성능 테스트 게이트 스펙 (2026)

> 작성: 2026-06-24 · 실행 주체: **Codex (goal 자율)** · 게이트: 05 §G-B/§G-C/§G-D.
> 목적: "핵심 플로우 무결함 / 접근성 치명 위반 0 / 성능 임계 충족"을 **자동 회귀 + 수동 보강**으로 증명.
> 전제: C1/C2 티켓(00 §3.1, 04 티켓)으로 Xcode App 프로젝트(MomoMac/MomoiOS scheme)가 존재해야 UI/성능 테스트 가능. 그 전엔 `[swift]` 단위테스트까지만.
> 검증 표기: `(검증됨)` 1차 출처 · `(추정)` 설계.

---

## 1. G-B 핵심플로우 e2e (XCUITest + 수동 스모크)

### 1.1 자동화 대상 (iOS XCUITest 우선)
핵심 8플로우(05 §3.1) 중 결정성 높은 것부터 자동화:

| # | 플로우 | iOS 자동(XCUITest) | macOS | 비고 |
|---|---|---|---|---|
| 1 | 초대코드 자가가입→워크스페이스 | ◎ | 수동 | 멀티팀 격리 핵심 |
| 2 | 채널 목록→입장→히스토리 | ◎ | 수동 | |
| 3 | 메시지 송수신(seq 갭리스) | ◎(전송·도착) | 수동 | 실시간 수신은 목/스텁 가능 |
| 4 | 김인턴 멘션→partial 스트리밍 | △(최종확정 검증) | 수동 | 스트리밍 타이밍 → 수동 보강 |
| 5 | Live Tool-Call 카드(D) | △ | 수동 | 상태전이 시각 → 수동 |
| 6 | 승인 인박스(C) | ◎ | 수동 | 승인/거부 결과 반영 |
| 7 | 비용 호흡 링(B) | △ | 수동 | 실시간 수치 → 수동 |
| 8 | 멀티팀 격리(타 WS 미노출) | ◎ | 수동 | RLS 체감 |

- **테스트 타깃**: `MomoiOSUITests`(XCUITest), `MomoiOSTests`(단위/로직). macOS는 `MomoMacUITests`(가능 범위) + 수동 스모크.
- **결정성 확보**: 실시간/스트리밍 의존 플로우는 **로컬 목 백엔드 또는 스텁 transport**로 결정화(AGENTS.md의 `ChatBackend`/`AgentTransport` 프로토콜이 주입점). 풀 e2e(실서버)는 G-0 런타임 환경에서 별도.

### 1.2 통과 기준
- 자동화된 시나리오 **전부 PASS**, 수동 시나리오 **스크린샷/녹화 증거 첨부**, 치명 결함 0. → **8/8 PASS**.
- CI: C1/C2 후 `xcodebuild test`로 UITests 실행(시뮬레이터). 풀 e2e는 게이트 단계 수동/런타임.

### 1.3 명령 (C2 후)
```bash
# iOS UI + 단위 테스트 (시뮬레이터)
xcodebuild test \
  -project clients/iOS/MomoiOS.xcodeproj -scheme MomoiOS \
  -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest'
```

---

## 2. G-C 접근성 (performAccessibilityAudit)

### 2.1 자동 감사 (검증됨, Xcode 15+)
```swift
import XCTest
final class MomoAccessibilityTests: XCTestCase {
    func testCoreScreensAccessibility() throws {
        let app = XCUIApplication()
        app.launch()
        // 핵심 화면 이동 후 전 타입 감사
        try app.performAccessibilityAudit()                    // .all 기본
        // 또는 타입 한정:
        // try app.performAccessibilityAudit(for: [.contrast, .dynamicType, .textClipped])
    }
}
```
- 감사 타입(`XCUIAccessibilityAuditType`): `.contrast` · `.dynamicType` · `.elementDetection` · `.hitRegion` · `.sufficientElementDescription` · `.textClipped` · `.trait` (+ `.all`). 특정 이슈는 클로저로 무시 가능(`.all.subtracting(...)`). (검증됨)

### 2.2 통과 기준
- 핵심 5화면(채널/메시지/멘션/승인/비용)에서 **치명 위반 0**: 레이블 누락, 대비 부족, Dynamic Type 텍스트 잘림, 히트영역 과소.
- VoiceOver 수동 워크스루(핵심 4플로우) "조작 가능".
- macOS: Accessibility Inspector 수동 감사(자동 audit는 XCUITest 의존이라 macOS는 보조).

---

## 3. G-D 성능 (XCTest 성능 메트릭 + Organizer)

### 3.1 자동 회귀 (XCTest 성능 측정 — 검증됨)
```swift
func testColdLaunchPerformance() throws {
    measure(metrics: [XCTApplicationLaunchMetric()]) {
        XCUIApplication().launch()
    }
}
// 추가: XCTMemoryMetric, XCTCPUMetric, XCTClockMetric, XCTOSSignpostMetric(커스텀 구간)
```
- baseline 설정 → 회귀 시 실패. **Release 구성 + 실기기**에서 측정해야 유효(시뮬레이터 수치 무효). (검증됨)

### 3.2 필드 메트릭 (Xcode Organizer / MetricKit — 검증됨)
- Organizer 8대: Battery, **Launch Time**, **Hang Rate**, Memory, **Disk Writes**, Scrolling, Terminations, MXSignposts. Organizer가 유사앱 기준 **권장선(점선)** 표시 → 그 선 초과 항목을 게이트 미달로 본다.
- MetricKit으로 동일 신호를 자체 수집(07 문서).

### 3.3 통과 기준 (디폴트, 임계는 추정)
- 콜드 런치 **p90 < 2.0s**(저사양 실기기).
- **Hang rate ≈ 0**(<0.1s/h), 메인스레드 100ms+ 블록 0 (이산 100ms / 연속 5ms 인지 임계). (임계 검증됨)
- 메시지 리스트 스크롤 드랍 프레임 미미(60/120Hz), 장시간 세션 후 메모리 안정.
- Organizer 권장선 초과 메트릭 0(또는 사유 기록).

---

## 4. CI 통합 (게이트 잡 — 권고)
- `ci-build.yml`에 (C1/C2 후) `xcodebuild test`(UI+접근성+단위) 잡 추가 — 무서명, 시뮬레이터.
- 성능/필드 메트릭은 **실기기·Release** 필요 → CI는 baseline 회귀만, 절대 수치는 게이트 단계 실기기 측정(증거 첨부).
- 별도 게이트 워크플로우(예: `qa-gate.yml`, 수동 dispatch)에서 UITests+접근성 감사+성능 baseline을 한 번에 돌려 게이트 증거 산출 — release와 분리. (추정)

## 5. 한계
- 시뮬레이터 성능 수치는 게이트에 쓰지 않는다(실기기만). (검증됨)
- 스트리밍/실시간 UI는 자동화 결정성이 낮음 → 목 주입 + 수동 보강 병행. (설계)
- macOS XCUITest 접근성 자동 감사는 iOS 대비 커버리지 제한 → Accessibility Inspector 수동 비중↑. (추정)

## 6. 출처
- performAccessibilityAudit / 감사 타입: https://developer.apple.com/documentation/xctest/xcuiapplication/4191487-performaccessibilityaudit (검증됨)
- 성능/메트릭(XCTMetric, 8대 메트릭): https://developer.apple.com/documentation/xcode/performance-and-metrics · https://developer.apple.com/documentation/xctest/xctmetric (검증됨)
- 반응성(hang, 100ms/5ms 임계): https://developer.apple.com/documentation/xcode/improving-app-responsiveness (검증됨)
- UI 자동화(WWDC25 record/replay): https://developer.apple.com/videos/play/wwdc2025/344/ (검증됨)
