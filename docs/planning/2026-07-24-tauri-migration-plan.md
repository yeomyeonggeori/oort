# Tauri/React 마이그레이션 실행 계획 (ADR-0133 파생, 2026-07-24 Fable 기안)

> 전제: ADR-0133 Accepted. 목표 플랫폼 = win/mac/iOS/Android/web, **최소 릴리스 = iOS·mac·web**. 엔진(서버·relay·worker·momo-workd)·REST/WS 계약 무변경 — 이 계획은 UI 레이어 전용.

## 0. 페이즈 지도 (게이트 기반, 기간은 Opus 파이프라인 속도 기준 추정)

| 페이즈 | 내용 | 게이트(통과 조건) | 추정 |
|---|---|---|---|
| **P0 스파이크** | Tauri 셸+React로 momowebqa 로그인→채널→타임라인 실시간 수신 | seq 순서 보존·재연결 resume·1k 메시지 60fps·콜드<2s 실측 | 2~4일 |
| **P1 momo-web MVP** | `clients/web` 신설 — 코어 루프(아래 §2 A군) 웹 완결 | 내부 알파 팀원이 브라우저로 하루 업무 가능 + design-review | 1~2주 |
| **P2 Tauri mac** | 데스크톱 래핑+네이티브 통합(딥링크·mDNS·updater·keychain·알림) | **parity 게이트(ADR 부록)** → 기본 다운로드 전환 | 1~2주 |
| **P3 Windows** | WebView2 빌드·인스톨러·서명 | mac parity 기능이 win에서 QA 통과 | 3~5일 |
| **P4a iOS 스파이크** | Tauri-mobile로 코어 루프 이식 판정 | 합격=P4b(동일 코드), 불합격=ADR-0133 증보(대안 결정) | 3~5일 |
| **P4b iOS** | 판정된 경로로 iOS 최소 릴리스 | TestFlight 배포+코어 루프 QA | 1~2주 |
| **P5** | Android · Linux 데스크톱 | 후순위(별도 결정) | — |

병행 규칙: P1 착수와 동시에 **SwiftUI mac 신규 표면 동결**(버그픽스만). Tauri 빌드는 parity 전까지 `momo-next` 채널(별도 zip, 같은 Pages)로 병행 배포해 성재가 비교 QA.

## 1. 리포 구조/스택 확정

```
clients/web/          # 정본 UI — TS + React 18 + Vite (SPA, Next.js 배제)
  src/app/            # 라우팅(웹: react-router / 데스크톱: 동일)
  src/features/       # timeline, composer, directory, settings, onboarding …
  src/design/         # 토큰(여명 팔레트 이식) + momo-design-taste-web 규칙
clients/desktop/      # Tauri 2 셸 (Rust) — web을 로드, 플러그인만 소유
  src-tauri/          # deep-link, mdns(발견), keychain, notification, updater
clients/mobile/       # P4 판정 후 (tauri-mobile이면 desktop과 셸 공유)
```

- UI 킷: **Tailwind + shadcn/ui(Radix) + react-virtuoso + cmdk**. buzz류 밀도·모던 감각의 사실상 표준 조합이며 Tauri 템플릿 생태계 정합.
- 상태/데이터: TanStack Query(REST) + 얇은 WS 스토어(Centrifugo). seq 단조·재연결 resume은 스토어 계약 테스트로 고정(현행 Swift 클라 계약과 동일 스펙 — 기존 계약 테스트를 스펙 문서로 번역).
- Rust 경계(초기): Tauri 플러그인 5종(딥링크/mDNS/keychain/알림/updater)만. `momo-core-rs`(타임라인 캐시·crypto)는 P2 병목 실측 후 도입 판단 — 웹과의 이중 구현 비용 때문에 기본은 TS 공유.

## 2. 기능 이식 우선순위 (현행 SwiftUI 기능 전수 분류)

- **A군(P1 웹 MVP)**: 로그인/초대 join(웹은 링크 파라미터 변형) · 채널/DM 목록 · 타임라인(가상화·seq·resume) · 컴포저+@멘션 자동완성 · 에이전트 카드(상태 칩·승인 버튼·비용 mono) · 스레드 · 멤버 디렉터리/인스펙터 · 빈/오류 상태 전부.
- **B군(P2 데스크톱)**: momo:// 딥링크 · mDNS 발견 카드 · 업데이트(Tauri updater — #736 Sparkle 대체) · 알림 · 설정군(AI 연결·코드 실행 호스트·워크스페이스 생성·초대 메일=OS mail 핸드오프) · Cmd+K.
- **C군(후속)**: Work Console(터미널 attach — xterm.js) · Memory 브라우저 · 개발자 진단 표면.
- 이식하지 않는 것: SwiftUI 전용 하네스(스냅샷 인프라는 Playwright+스크린샷 diff로 대체, design-review 에이전트 파이프라인은 동일 유지).

## 3. UXUI 레퍼런스 소화 (R-1 리서치 티켓)

목표: **"buzz와 거의 동일한 UXUI 체감"** — 단 oort 우위(seq 결정론·RLS·승인 원장)를 표면에 세운다.

| 소스 | 가져올 것 | 근거 |
|---|---|---|
| **buzz** (기존 해부 §7 + 신규 화면 단위 해부) | 3-pane 밀도·zero-noise 알림+통합 Inbox·에이전트 상태 데이터플레인 표면("the agent did X to Y → Z" 문장 프레임)·무한 스레드 UI·워크플로 스텝 카드 | Tauri 동형이라 컴포넌트 단위 1:1 참조 가능 |
| **codex 앱** | 패널 미니멀리즘·사이드바 태스크 목록·승인 시트 절제 | 이미 대화 조각 히어로에 반영된 톤 |
| **t3code** | 태스크=스레드·Working NNs 라이브 상태·Settled 섹션·update pill(이식 완료 개념) | 기존 분석 문서 |

산출물: `docs/planning/research/` 에 **컴포넌트 레벨 UX 스펙**(사이드바/인박스/타임라인/에이전트 카드/설정 셸 5장, 각각 buzz 스크린샷 대조 + oort 불변식 주석) — P1 구현의 디자인 정본. momo-design-taste-web 스킬(웹판 하드룰: 토큰·em-dash 0·상태 4종·키보드·AA)로 성문화.

## 4. 리스크와 상쇄

| 리스크 | 상쇄 |
|---|---|
| Tauri iOS 신생(buzz도 모바일은 Flutter) | P4a 스파이크 게이트 — 실패 시 iOS만 대안(기존 Swift iOS 킷 확장 등), 웹/데스크톱 계획은 불변 |
| 이중 스택 기간 드리프트 | SwiftUI 신규 표면 동결 + parity 체크리스트가 단일 진실 |
| 웹뷰 대량 타임라인 성능 | react-virtuoso + P0에서 1k 메시지 실측을 선행 게이트로 |
| 내부 알파 흐름 단절 | 기본 다운로드는 parity 전까지 SwiftUI 유지, momo-next 병행 채널 |
| 서명/배포 재구축 | Tauri 번들러가 기존 인증서(YWQQFQM38J)·notary 프로파일 재사용, updater 내장 |

## 5. 즉시 착수 목록 (ADR Accepted 시)

1. **P0 스파이크**(엔진+web 혼성 1티켓): `clients/web` 스캐폴드 + Tauri 셸 + momowebqa 실왕복 성능 실측 보고.
2. **R-1 UX 스펙**(리서치): buzz 화면 해부 → 컴포넌트 스펙 5장.
3. **R-2 momo-design-taste-web** 스킬 초안.
4. #736(Sparkle)은 **폐기 → Tauri updater로 재정의**.
