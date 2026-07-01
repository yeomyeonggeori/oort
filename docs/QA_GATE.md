# momo — QA 게이트 (스토어 제출 전 빌드파일 사용성 검수, 2026)

> **이 문서 = M7 검수 게이트의 단일 진입점(top-level).** "빌드 파일이 실제로 **사용 가능**"함을 빡세게 판명한 뒤에만 스토어/공증 배포(M8)로 간다.
> **불변식(절대 규칙):** 🔒 아래 게이트(G-0 ~ G-H)가 **전부 PASS + 증거 첨부**되기 전에는 `release-ios.yml`/`release-macos.yml`(App Store `deliver` / Developer ID 공개 다운로드)를 **트리거하지 않는다.** external TestFlight·공개 다운로드 개시도 PASS 이후.
>
> 작성: 2026-06-24 · 실행 주체: **Codex (goal 자율 실행)** · 산출 위치: 이 리포.
> 정본 참조: `STATUS.md`(현재 상태) · `ROADMAP.md`(M0~M8 백본·§4 게이트 표) · `schema_v0.sql`(스키마) · `research/07-deepdive/04·05`(L4 스펙·경험).
> 검증 표기: `(검증됨)` = 2026 기준 Apple/도구 1차 출처 교차확인 · `(추정)` = 설계 디폴트(출처 없음, 팀 조정 가능). **법무 텍스트는 법률 자문 아님 — 외부 변호사 1회 검토 필요.**

---

## 0. 이 게이트가 무엇이고, 다른 문서와 어떻게 연결되나

momo의 QA 게이트 문서는 **"무엇을 통과(checklist)" → "어떻게 증명(measurable)" → "구체 절차(per-domain)"** 의 3층 구조다. 이 문서(`docs/QA_GATE.md`)는 **최상위 요약 + GO 판정**이고, 세부는 `docs/cicd/*`에 위임한다. Codex는 게이트 작업 시 이 파일을 먼저 읽고, 도메인별 세부는 아래 링크를 따라간다.

| 층 | 파일 | 역할 |
|---|---|---|
| **최상위(이 문서)** | `docs/QA_GATE.md` | 게이트 전모 + 베타 전략 + 사용성 체크리스트 + GO 판정 단일 진입점 |
| 체크리스트(무엇) | `docs/cicd/03-store-readiness-gate.md` | G-0~G-5 체크박스 + PASS 블록 기록 위치(정본 기록처) |
| 측정 정본(어떻게 증명) | `docs/cicd/05-qa-release-gate.md` | 크래시-free/e2e/접근성/성능/Enterprise Trust 객관 수치·정의·1차출처 검증로그 |
| 베타 | `docs/cicd/06-beta-testflight-plan.md` | TestFlight 내부/외부 + macOS 공증 .dmg 비공개 베타 + 피드백 트리아지 |
| 크래시/분석 | `docs/cicd/07-crash-analytics-spec.md` | Sentry Cocoa(self-host) + MetricKit 계측 스펙 |
| e2e/접근성/성능 | `docs/cicd/08-e2e-accessibility-performance.md` | XCUITest + performAccessibilityAudit + XCTMetric 테스트 plan |
| Codex 티켓 | `docs/cicd/09-qa-codex-tickets.md` | Q0~Q7 의존순 실행 티켓 |

> **PASS 블록의 정본 기록처는 `03-store-readiness-gate.md` 상단**(05 §10 양식). 이 문서는 그 사본/요약을 §8에 둔다. STATUS.md §5b의 게이트 상태도 OPEN→PASS로 함께 갱신한다.

### 0.1 현재 상태 (왜 아직 OPEN인가 — STATUS.md 정합)
- Phase 0 = **5개 Swift 패키지 `swift build` green**이고, M1 runtime MOMO-001~004(seq/outbox/RLS/AgentWorker 비용 회계)는 Docker Desktop으로 검증됨. WebSocket live subscribe/presence/recovery와 APNs는 후속.
- `clients/macOS` = SwiftPM dev app 가능 단계이나 릴리스용 Xcode `.app`은 아직 없음. `clients/iOS` = **미존재**. → 사용성 검수 대상 산출물(.app/.ipa)이 아직 없음.
- 계측(Sentry/MetricKit), XCUITest/접근성/성능, qa-gate.yml, 베타 배포·실측·PASS 기록 **전부 미진행**. → 게이트 **OPEN**.
- **게이트 선결:** M1 runtime e2e 잔여(WebSocket/APNs/staging) + M3 C1(MomoMac.xcodeproj) + M5 C2(MomoiOS.xcodeproj) + M6(CI/fastlane). 이게 없으면 게이트 측정 자체가 불가.

---

## 1. 게이트 → 스토어 마일스톤 구조 (한눈에)

```
M0 런타임 e2e ─ M1 staging ─ M2 멀티팀 ─ M3 데스크탑 UX ─ M4 패키징 ─ M5 iOS ─ M6 CI/CD
   │                                                                              │
   └──────────────────────────────┬───────────────────────────────────────────┘
                                   ▼
                ┌──────────────────────────────────────────────┐
                │   M7  QA · 사용성 검수 게이트 🔒 (이 문서)     │
                │   "사용 가능 완전 판명" — 객관 통과기준        │
                │   G-0 런타임 e2e    G-A 크래시-free율          │
                │   G-B 핵심플로우 e2e   G-C 접근성              │
                │   G-D 성능   G-E 베타(TestFlight+공증 DMG)     │
                │   G-F 베타 피드백   G-G 릴리스 준비            │
                │   G-H Enterprise Trust evidence                 │
                └───────────────────────┬──────────────────────┘
                        전부 PASS + 증거 + 03 상단 PASS 블록 기록 후에만 ↓
              ┌─────────────────────────┴─────────────────────────┐
              ▼                                                     ▼
   M8(🖥) release-macos.yml                            M8(📱) release-ios.yml
   공증 .dmg 공개 다운로드 + Sparkle 라이브             App Store deliver → App Review → 배포
```

> ⚠️ **TestFlight 업로드(베타)는 게이트의 "수단"이지 스토어 제출이 아니다.** `pilot`(TestFlight 업로드)은 게이트 진행 중 허용. `deliver(submit_for_review:true)`(App Store 심사 제출)와 macOS 공개 다운로드는 게이트 PASS 후. external TestFlight 그룹 개시도 PASS 후가 안전(첫 빌드 Beta App Review = App Store Review Guidelines 검사).

---

## 2. "사용 가능 완전 판명" — 객관 통과기준 요약표

> 임계값(99.5% / p90<2s 등)은 **출시 게이트 디폴트(추정)** 다. 자체구축 내부 도구는 표본이 작으므로 **표본 충분성(§2.1)** 이 수치만큼 중요하다. 팀이 조정 시 이 표 값을 바꾸고 사유를 PASS 기록에 남긴다. 정의·측정법·1차출처 검증로그는 `05-qa-release-gate.md`.

| 게이트 | 측정 대상 | 통과 기준 | 측정 방법/도구 | 자동/수동 | 근거 |
|---|---|---|---|---|---|
| **G-0** 런타임 e2e | 백엔드 왕복 | docker 기동 → migrate 멱등 → `/health` → seq 갭리스 → outbox→relay→publish 왕복 → RLS 격리 → 김인턴 멘션 SSE 1왕복 + reserve/reconcile | M1 staging docker e2e | runtime | (선결, STATUS.md §5) |
| **G-A** 크래시-free율 | 안정성 | **세션 ≥ 99.5% AND 유저 ≥ 99.0%**, 신규(미해결) P0/P1 crash 0, 윈도우 ≥7일/≥표본 | Sentry Release Health / MetricKit / TestFlight crashes | 자동 집계 + 수동 판정 | 임계 (추정) / 도구 (검증됨) |
| **G-B** 핵심플로우 e2e | 기능 무결함 | **핵심 8플로우 8/8 PASS**, 치명 결함(크래시·데이터손상·플로우차단) 0 | XCUITest(iOS) + 수동 스모크(macOS) | 자동 + 수동 | (설계) |
| **G-C** 접근성 | 포용성 | `performAccessibilityAudit` **치명 위반 0** + VoiceOver 핵심플로우 조작 가능 | XCTest 접근성 감사 + Accessibility Inspector | 자동 + 수동 | (검증됨, Xcode 15+) |
| **G-D** 성능 | 반응성 | 콜드 런치 **p90 < 2.0s**, hang ≈ 0(<0.1s/h), 메모리/스크롤 안정 | XCTApplicationLaunchMetric / Xcode Organizer / MetricKit | 자동 + 관찰 | 메트릭 (검증됨) / 임계 (추정) |
| **G-E** 베타 사용성 | 실사용 검증 | iOS TestFlight 내부+외부 1왕복 / macOS 공증 .dmg 타 맥 Gatekeeper 통과·1왕복 | TestFlight / `spctl` + 실기기 | 수동(실사용) | (검증됨) |
| **G-F** 베타 피드백 | 결함 회수 | 베타 피드백 **전수 트리아지, P0/P1 잔여 0** | ASC 피드백 + ASC API 수집 스크립트 | 수동 + 스크립트 | (검증됨) |
| **G-G** 릴리스 준비 | 제출 요건 | 메타/프라이버시/암호화 신고/버전·빌드번호 체크리스트 **100%** | `precheck`/`deliver --verify` + 수동(§6) | 자동 + 수동 | (검증됨) |
| **G-H** Enterprise Trust | 보안/공급망/감사 신뢰 | threat model + SBOM/license scan + secret scanning + VDP/pentest plan + security whitepaper draft | local gate evidence + 수동 리뷰 | 자동 + 수동 | (설계, MOMO-140) |

### 2.1 표본 충분성 (작은 내부 베타의 함정 — 추정)
- 자체구축 멤버 베타는 표본이 작다(수십~수백 세션). **세션 < 200이면 % 신뢰 낮음** → "절대 crash 수 0~1 + 핵심플로우 e2e 그린 + P0/P1 잔여 0"을 병행 조건으로.
- PASS 기록에 **분모(세션/유저 수)와 윈도우(일수)** 를 반드시 명기. 예: `99.7% (412 sessions / 9 users / 8 days)`.

---

## 3. 베타 전략 (G-E/G-F) — TestFlight 내부/외부 + 데스크탑 공증 베타

> 세부 절차/한도/fastlane lane은 `docs/cicd/06-beta-testflight-plan.md`. 여기서는 게이트 관점의 골격만.

### 3.1 iOS — TestFlight (검증됨, 2026)
| | 내부(Internal) | 외부(External) |
|---|---|---|
| 최대 인원 | **100명** (App Store Connect **유저**여야 함) | **10,000명** |
| 심사 | **없음 — 즉시** | **버전당 첫 빌드 Beta App Review 필요** |
| 빌드 만료 | **90일** | **90일** |

**momo 베타 순서(권고):**
1. **내부(team-dawnkim):** 개발/운영 멤버를 ASC 유저로 등록 → 빌드 처리 후 즉시 노출. 핵심 8플로우 1차 스모크(심사 없음 → 빠른 반복).
2. **외부(momo-internal-beta):** 자체구축 멤버(10명=1팀, 3+팀)를 초대. **첫 빌드만 Beta App Review** → 통과 후 동일 버전 반복 빌드는 빠르게. **멀티팀 격리·고유 초대코드 자가가입을 실기기에서 검증**(체크리스트 §4 A·H 항목과 직결).
3. (선택) **공개링크:** 표본 확대 필요 시. 익명 테스터 crash/세션이 G-A 분모 보강에 유용 (추정).

> fastlane `pilot`의 `groups:` 자동 배정은 **External Testing 그룹에서만 신뢰성 있게 동작**(Internal "Manual for Xcode Builds"는 자동 배정 불가). (검증됨)

### 3.2 macOS — 공증 .dmg 비공개 베타 (직접배포 경로)
- momo macOS의 **정식 배포 경로 = Developer ID 공증 직접 다운로드**(M4). 따라서 게이트의 macOS 사용성 검수도 **실제 배포 산출물(공증 .dmg)** 로 한다 (설계).
- 절차: `gym(export_method: developer-id)` → inside-out 서명 + hardened runtime → `xcrun notarytool submit Momo.zip --wait` Accepted → `stapler staple`(.app/.dmg) → **비공개 링크/사내 채널**로 전달 → 테스터는 **빌드 안 한 다른 맥**에서 `spctl --assess --type execute --verbose Momo.app` accepted + 핵심 8플로우 1왕복. (검증됨)
- macOS는 TestFlight 미사용 시 인앱 피드백이 없으므로 **Sentry/MetricKit(07 문서)** 가 크래시-free율의 주 수집원, 수동 피드백은 내부 GitHub Issue(`type:bug`+`gate:qa`).

### 3.3 피드백 트리아지 (G-F)
- 수집: TestFlight 인앱 피드백(스크린샷/코멘트/크래시 코멘트) → ASC "Feedback" 표시 + **ASC API** `betaFeedbackScreenshotSubmissions`/`betaFeedbackCrashSubmissions` 자동 수집(누락 방지 스크립트). Sentry crash/error 자동 그룹핑. macOS는 GitHub Issue. (검증됨)
- 규칙: 모든 피드백/crash 그룹에 **P0/P1/P2 라벨**. **통과 = P0/P1 잔여 0**(P2는 후속 이슈 추적 허용). 재현된 P0/P1은 **XCUITest 또는 수동 스모크 항목으로 고정**(회귀 방지).

---

## 4. 사용성 체크리스트 (G-B 핵심 8플로우 — 가입/초대/메시지/김인턴/승인/비용 e2e)

> momo 제품 플로우 = 검수의 척추. **iOS는 XCUITest 자동화 우선(최소 A·B·C·H), macOS는 자동화 어려운 실시간/스트리밍은 수동 스모크 + 스크린샷 증거.** 각 항목은 **실기기 + Release 구성**으로 1왕복. 자동화 plan은 `08-e2e-accessibility-performance.md`.

각 플로우는 `[ ] iOS 자동(XCUITest) / [ ] iOS 수동 / [ ] macOS 수동` 3축으로 증거를 남긴다.

### A. 가입/온보딩 (계정 생성 + 자가가입)
- [ ] 초대코드 입력 → 검증(만료/사용횟수/revoke) → **자가가입** → member/membership 생성 → 워크스페이스 진입.
- [ ] 잘못된/만료/소진 초대코드 → 명확한 에러(크래시 0, 빈 화면 0).
- [ ] 로그인(access 15m / refresh 30d JWT) → 앱 재시작 후 세션 유지(refresh 회전).
- [ ] **계정 삭제(5.1.1(v))**: 설정 → "계정 삭제"(비활성화 아님) → 확인 → 서버 삭제 + audit_log → **재로그인 불가** 확인. *(iOS 필수 — 누락 시 App Review 리젝)*

### B. 초대 (워크스페이스 스핀업 + 고유 초대코드)
- [ ] (관리자) 초대코드 생성(role/max_uses/expires_at) → 코드 표시/복사.
- [ ] 스핀업마다 **고유 초대코드 1개 자동 발급** 확인(워크스페이스 생성 시).
- [ ] 초대코드로 가입 시 `used_count` 증가 + 한도 초과 시 거부.

### C. 메시지 송수신
- [ ] 채널 목록 로드 → 채널 입장 → 히스토리 렌더(cursor=seq 페이지네이션).
- [ ] 텍스트 전송 → optimistic 표시 → `channel_seq` **갭리스** 도착(본인+타기기) → 실시간 수신(Centrifugo).
- [ ] 오프라인→재연결 시 `?after=<seq>` backfill로 누락 없이 동기화.
- [ ] 편집/삭제(tombstone)/리액션/스레드 1왕복.

### D. 김인턴(에이전트 멘션) — Live Tool-Call
- [ ] `@김인턴` 멘션 → `agent.partial` **스트리밍 델타 실시간 렌더** → 최종 메시지 확정.
- [ ] **Live Tool-Call 카드(D 경험)**: tool_call/tool_result/diff 1급 메시지가 카드로 표시·진행·완료 상태 전이.
- [ ] 에이전트 응답이 사람 메시지와 동일하게 seq 정렬에 편입(에이전트=1급 멤버).
- [ ] hermes 비스트리밍 폴백 시에도 응답 도착(SSE delta 누락 내성).

### E. 승인 (Approval Inbox, C 경험)
- [ ] 승인 요청(pending) 도착 → 승인 인박스 표시.
- [ ] 승인/거부 → 서버 PATCH → `agent_run` 게이트 해제 왕복 → 결과 반영.
- [ ] 결정이 **audit_log**에 기록(actor/subject/via_token).

### F. 비용 (Cost Breathing Ring, B 경험)
- [ ] `usage_ledger`/`budget_window` 실데이터가 **호흡 링**에 실시간 반영(reserve→reconcile).
- [ ] 예산 소진율에 따라 링 시각 변화 + soft/hard limit 표시.
- [ ] hard limit 초과 시 서킷브레이커 트립(에이전트 호출 차단) 체감.

### G. 푸시/알림 (iOS)
- [ ] APNs 디바이스 토큰 등록 → 멘션/DM 수신 시 푸시 도착.
- [ ] 온라인(presence) 시 푸시 suppress, 오프라인 시 발송(notify-decision).
- [ ] 알림 권한 prompt 정상.

### H. 멀티팀 격리 (10명=1팀, 3+팀)
- [ ] 다른 워크스페이스의 채널/메시지/멤버가 **미노출**(RLS 격리 사용자 체감).
- [ ] 3개+ 팀(각 10인)을 각자 초대코드로 자가가입시킨 뒤, 팀 간 데이터 누출 0 확인.
- [ ] (플랫폼 관리자) 전역 추적 뷰로 전 팀/멤버/초대코드 사용현황 조회 — 일반 테넌트 토큰으로는 접근 불가.

### 공통 통과 기준
- [ ] **8/8(A~H) PASS**, 각 플로우 치명 결함 0.
- [ ] 전 화면 크래시 0, 콘솔 치명 에러 0, 권한 prompt(네트워크/알림) 정상.
- [ ] 플레이스홀더/Lorem Ipsum/임시 이미지 0 (App Review 2.1 App Completeness 직결, 검증됨).

---

## 5. 크래시 / 분석 도구 (G-A 계측)

> 세부 SDK 설정/데이터맵은 `docs/cicd/07-crash-analytics-spec.md`. App Privacy 라벨(법무)과 반드시 일관.

| 도구 | 역할 | momo 채택 | 근거 |
|---|---|---|---|
| **Sentry Cocoa (self-host)** | **1순위.** Release Health = Crash Free Sessions/Users(릴리스별), 이슈 그룹핑, MetricKit 인입 옵션, permissive | ✅ 디폴트 | 자체구축·permissive 기조 정합 (검증됨) |
| **MetricKit (Apple, 0의존)** | **보조.** `MXCrashDiagnostic`/`MXHangDiagnostic`(iOS15/macOS12부터 즉시 전달), 8대 성능 메트릭(24h 1회) | ✅ 병행 | 서드파티 0 의존, 오프라인 자체 집계 (검증됨) |
| Firebase Crashlytics | crash-free users 중심 | ⛔ 선택지로만 문서화 | Google SDK/계정 종속 → momo 기조와 충돌 (추정) |
| TestFlight crashes | 베타 보조 신호(익명 테스터 crash/세션) | ✅ 보조 | ASC 빌드별 메트릭 (검증됨) |

- **macOS는 TestFlight 미사용 경로가 정식**이므로 크래시-free율을 **Sentry/MetricKit(실기기 페이로드)** 에 의존. macOS 공증 .dmg 직접배포는 "설치 수/세션" 자동 집계가 없음 → 계측이 유일 수집원.
- 정의 주의(검증됨): **세션 기준**(크래시로 안 끝난 세션 %) vs **유저 기준**(기간 내 무크래시 유저 %, 보통 세션보다 보수적). 두 지표를 별도 판정한다.

---

## 6. G-G 릴리스 준비 체크리스트 (제출 직전)

> 정본은 `05-qa-release-gate.md §9`. `precheck`/`deliver --verify`로 사전검증 + 수동.

### 6.1 공통
- [ ] **버전/빌드번호**: `CFBundleShortVersionString`=SemVer, `CFBundleVersion`=단조증가 빌드번호(CI가 `GITHUB_RUN_NUMBER` 주입). (검증됨)
- [ ] 변경로그/릴리스 노트(TestFlight changelog + 스토어 What's New).
- [ ] **개인정보처리방침 URL** 라이브(`legal/privacy-policy.md` 기반).
- [ ] **App Privacy(데이터 수집) 라벨**: Sentry/MetricKit이 수집하는 데이터(크래시·식별자·진단) + hermes LLM 제3자 전송 정직 신고. PrivacyInfo.xcprivacy와 일관(`docs/legal/03-app-privacy-datamap.md`). (검증됨, ASC 필수)
- [ ] **암호화 수출규제**: `ITSAppUsesNonExemptEncryption` 설정(HTTPS/표준 TLS/APNs ES256만이면 보통 면제 NO, 자체 암호화 있으면 YES — 의존성 전수 확인). **법률 자문 아님 — 법무 1회 확인.** (검증됨)
- [ ] 라이선스/약관: 의존성 permissive 유지(`legal/THIRD_PARTY_NOTICES.md`/`NOTICE`), 외부배포 전 법무 검토 1회. **법률 자문 아님.**

### 6.2 iOS (App Store)
- [ ] ASC App 레코드 + Bundle ID(`com.dawnkim.momo`) 등록.
- [ ] **iOS SDK 요건**: 2026-04-28부터 iOS 26 SDK + Xcode 26 이상으로 빌드해야 업로드 가능 — 업로드 직전 재확인. (검증됨)
- [ ] 스크린샷(제출 시점 필수 기기 사이즈 — 현재 6.9"/6.5" iPhone, 13" iPad, **제출 직전 ASC 재확인**), 아이콘, 설명, 키워드, 카테고리, 연령등급(UGC 반영).
- [ ] **UGC 모더레이션 4종(1.2)**: 게시 전 필터 / 신고(report) / 차단(block) / 공개 연락처 + EULA 무관용 + **에이전트 생성 콘텐츠 모더레이션 정책**(에이전트=1급 멤버). (검증됨)
- [ ] **심사용 데모(2.1)**: 데모 워크스페이스 + 유효 초대코드 + **심사 기간 내내 백엔드(server/Centrifugo/hermes) 가동 SLA**. (검증됨)
- [ ] `precheck` 통과 + `deliver(submit_for_review:false)` 메타 사전검증 1회.

### 6.3 macOS (공증 직접배포)
- [ ] Developer ID Application 서명 + hardened runtime + 필요한 entitlements만.
- [ ] `notarytool submit --wait` Accepted + `stapler staple`(.app/.dmg) + `stapler validate`.
- [ ] **타 맥(빌드 안 한 머신)에서 Gatekeeper 통과**: `spctl --assess --type execute --verbose Momo.app` accepted + `codesign --verify --deep --strict` 통과.
- [ ] .dmg 서명/스테이플 + 다운로드 경로(GitHub Release/페이지) 확정 + Sparkle appcast 준비.

---

## 7. Codex 실행 컨벤션 (이 게이트 작업 방법)

> 의존순 실행 티켓 정본 = `docs/cicd/09-qa-codex-tickets.md`(Q0~Q7). 라벨 택소노미 = `scripts/github/labels.tsv`(`gate:qa` 필수).

- **다음 티켓 선택법:** `deps`가 전부 done인 가장 낮은 의존 깊이를 고른다. 게이트 측정 티켓은 **선결(M0 런타임 + C1/C2 Xcode 프로젝트 + M6 CI)** 이 done이어야 착수 가능 — 미충족이면 `status:blocked`.
- **수용기준 등급:** `[runtime]`=docker/psql 필요(미가용 시 `runtime-unverified` 정직 표기) · `[xcode]`=`xcodebuild`/XCUITest 산출 · `[ci]`=워크플로우 syntax/lint · `[manual]`=실기기 사람 1회 + 스크린샷 증거.
- **증거 원칙:** 각 게이트 PASS는 **수치 + 분모 + 윈도우 + 링크**(Sentry release / XCUITest run id / Organizer 스크린샷 / 베타 빌드#)로 증명. 수치만 적고 분모 누락 금지.
- **DoD 기록:** 게이트 측정 결과를 `STATUS.md §5b`에 갱신(OPEN→측정중→PASS). 미검증은 `runtime-unverified`로 정직 표기.
- **🔒 release 금지:** §8 PASS 블록을 `03-store-readiness-gate.md` 상단에 기록하기 전 `release-*.yml` 트리거 금지(태그 자제 또는 GitHub environment protection). **기록 없는 release = 규칙 위반.**

---

## 8. GO 판정 — "사용 가능 판명 → 스토어 GO" 기준

**GO 조건:** `G-0, G-A ~ G-G` **전부 PASS + 증거 첨부.** 이때 **그리고 이때만** M8(스토어/공증 배포)로 진행한다.

PASS 시 아래 블록을 **`docs/cicd/03-store-readiness-gate.md` 상단**(정본 기록처)에 기록하고, STATUS.md §5b를 PASS로 갱신한다(이 문서 §8은 동일 블록의 사본 보관):

```
GATE PASS: 2026-MM-DD · commit <sha> · 빌드 iOS <build#> / macOS <build#>
- G-0 런타임 e2e: docker migrate 멱등 + /health + seq 갭리스 + outbox→relay→publish + RLS 격리 + 김인턴 SSE 1왕복 (staging URL / 로그 링크)
- G-A 크래시-free: 세션 99.x% / 유저 99.x% (분모 NNN세션 / N유저 / D일, 출처: Sentry release <ver>)
- G-B e2e: 8/8 PASS (XCUITest run <id> + macOS 수동 스모크 스크린샷 링크)
- G-C 접근성: 치명 위반 0 (performAccessibilityAudit run <id> + VoiceOver 워크스루)
- G-D 성능: 런치 p90 1.xs / hang 0 (Organizer + XCTest baseline, 실기기·Release)
- G-E 베타: iOS TF 내부+외부 1왕복 / macOS 공증 .dmg 타맥 Gatekeeper PASS
- G-F 피드백: 전수 트리아지 N건, P0/P1 잔여 0
- G-G 릴리스준비: §6.1~6.3 체크리스트 100%
- G-H Enterprise Trust: threat model/SBOM/license/secret scan/VDP-pentest plan/security whitepaper evidence
판정자: <name> · 다음 단계: M8 release-ios.yml / release-macos.yml 활성 허용
```

> 기록 후에만 `v*.*.*` 태그 → release 워크플로우 가동 + external TestFlight/공개 다운로드 개시.
> **GO ≠ 영구.** 게이트 임계를 조정했거나(추정값 변경) 신규 P0/P1 회귀가 잡히면 다음 릴리스 전 재판정한다.

---

## 9. 출처 (2026 기준 1차/교차확인 — 05 §11과 동일 근거)
- TestFlight 내부(≤100)/외부(≤10,000)·첫 빌드 Beta App Review·90일 만료: developer.apple.com/help/app-store-connect/test-a-beta-version/* · developer.apple.com/testflight/ (검증됨)
- ASC API 베타 피드백(`betaFeedbackCrashSubmissions`/`betaFeedbackScreenshotSubmissions`): developer.apple.com/documentation/appstoreconnectapi (검증됨)
- `performAccessibilityAudit`(Xcode 15+, 이슈 시 테스트 실패): developer.apple.com/documentation/xctest (검증됨)
- 성능/반응성(8 메트릭, hang, 100ms/5ms 인지 임계 ≠ 250ms 행 검출 임계, Organizer 권장선): developer.apple.com/documentation/xcode/performance-and-metrics · improving-app-responsiveness (검증됨)
- Sentry Release Health(crash-free sessions/users): docs.sentry.io/product/releases/health (검증됨, 임계값은 추정)
- MetricKit(MXCrashDiagnostic/MXHangDiagnostic, iOS15/macOS12 즉시 전달): developer.apple.com/documentation/MetricKit (검증됨)
- macOS 공증(notarytool --wait → stapler → spctl, hardened runtime): developer.apple.com/documentation/security/notarizing-macos-software-before-distribution (검증됨)
- App Review Guideline 1.2(UGC) / 2.1(App Completeness) / 5.1.1(v)(계정 삭제): developer.apple.com/app-store/review/guidelines/ (검증됨)
- iOS 26 SDK / Xcode 26 업로드 요건(2026-04-28): developer.apple.com/news (검증됨, 업로드 직전 재확인)
- `ITSAppUsesNonExemptEncryption` 면제: developer.apple.com/documentation/security/complying-with-encryption-export-regulations (검증됨, 법률 자문 아님)
</content>
</invoke>
