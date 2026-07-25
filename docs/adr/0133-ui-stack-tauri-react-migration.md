# ADR-0133: 클라이언트 UI 스택 전환 — SwiftUI → TS/React + Tauri (+Rust 코어)

- Status: **Accepted** (2026-07-25, 성재 — "ADR 승인할게. 스파이크랑 리서치 바로 진행해줘." 파생 P0 스파이크·R-1·R-2 즉시 착수. 2026-07-24 기안, Fable — 성재 발제)
- **전환 실행: 2026-07-25** — parity 게이트 실측(차단 0·성능 3종 통과, `docs/planning/2026-07-25-parity-gate-report.md`) 후 성재 승인으로 기본 다운로드를 momo-next 0.1.0-next.7(Tauri)로 교체(`scripts/switch_default_download.sh`). SwiftUI 0.0.6 = legacy 최종 빌드(신규 발행 중단, 은퇴).
- 발단(성재): ①Swift 백그라운드 부재로 SwiftUI의 장점을 오너가 살리지 못함(UI를 오너가 직접 다듬을 수 없음) ②Windows 지원 필요 ③buzz(Tauri)를 레퍼런스로 직접 활용 가능 ④최종 타깃 = **Windows·macOS·iOS·Android·Web**, 최소 릴리스 = **iOS·macOS·Web**.

## Context (실측)

- 현행 UI 자산: macOS SwiftUI 112파일(+테스트·스냅샷 인프라·momo-design-taste 체계), iOS 킷 35파일(부분). 웹 클라이언트는 ADR-0119 v0(`clients/web`, 레포 브라우저·알파 서빙용 경량 Vite 앱)가 존재하나 메신저 UI는 아니다(정정 2026-07-25 — 기안 시 '0'으로 오기). v0의 seq/reconcile·approval 모델 어휘는 momo-web의 씨앗으로 재사용한다.
- 서버 계약은 UI 무관: REST + Centrifugo(WS) + momo:// 딥링크 + mDNS. **엔진(서버/relay/worker/momo-workd/ACP)은 이 결정의 영향권 밖.**
- Tauri 2: 2024-10 stable, 현행 2.9.x. 데스크톱(mac WKWebView·win WebView2) 성숙, **모바일(iOS/Android)은 1급 타깃이나 상대적으로 신생**(iOS=Swift 셸+WKWebView+Rust FFI). 내장 updater·deep-link 플러그인·서명/공증 번들러 보유.
- buzz 실측: 데스크톱=Tauri, **모바일=Flutter(부분)** — buzz도 모바일엔 Tauri를 쓰지 않았다. Tauri의 Linux(WebKitGTK) day-1 크래시 전과는 우리 초기 타깃(mac/win)엔 비해당.

## Options

- **A. 전면 전환(빅뱅)**: SwiftUI 폐기, Tauri+React로 재작성 후 교체. — 내부 알파 공백 발생, 리스크 최대.
- **B. 웹-우선 스트랭글러(권고)**: React 웹 클라(momo-web)를 정본 UI로 신설 → Tauri가 데스크톱(mac→win) 래핑 → parity 게이트 통과 시 기본 배포 전환. SwiftUI mac은 그때까지 데일리 드라이버 유지(신규 표면 동결). iOS는 스파이크로 Tauri-mobile vs 대안 판정.
- **C. 현상 유지 + 웹만 신설**: SwiftUI mac 계속 + React 웹 별도. — 두 UI 스택 영구 이중 유지보수, Windows 불가. 오너 참여 문제 미해결.

## Decision (Proposed): **B**

1. **정본 UI = `clients/web`(TS + React + Vite)**. 데스크톱은 Tauri 2가 동일 코드를 래핑(mac→win). Next.js는 배제(SSR 불필요, Tauri 정합은 SPA/Vite가 표준).
2. **Rust 활용 경계**: Tauri 셸의 네이티브 통합(딥링크·mDNS 발견·keychain·알림·updater)은 Rust 플러그인. 성능 임계(타임라인 캐시·seq resume·WS 재연결)는 v1엔 TS로 시작, 병목 실측 시 `momo-core-rs`로 강등(웹은 브라우저 WS 유지). 조기 Rust 골드플레이팅 금지.
3. **UI 킷**: Tailwind + shadcn/ui(Radix) + react-virtuoso(타임라인 가상화) + cmdk(Cmd+K). buzz·codex·t3code 패턴 소화는 전용 UX 스펙으로(파생 R-1).
4. **iOS 결정은 스파이크 게이트**: Tauri-mobile 스파이크(P4a)로 판정 — 합격 시 동일 코드베이스, 불합격 시 대안(현행 SwiftUI iOS 킷 확장 등)을 별도 ADR 증보로. buzz의 Flutter 선택이 경고 신호임을 명시.
5. **전환 규율**: ADR Accepted 시점부터 macOS SwiftUI는 **버그픽스 전용 동결**(신규 UXUI 표면은 web에만). parity 게이트(부록 체크리스트) 통과 전까지 기본 다운로드는 SwiftUI 빌드 유지, Tauri 빌드는 `momo-next` 병행 채널로 배포.
6. 하드 불변식(PG=SoT·seq·단일 쓰기경로·RLS·ADR-0004)과 서버 계약 무변경. momo-design-taste는 웹판 스킬로 이식(파생 R-2).

## Consequences

- (+) 1 코드베이스로 web/mac/win(+모바일 후보) — 최소 릴리스의 Web을 만들면서 데스크톱을 공짜에 가깝게 확보. 오너가 UI를 직접 다듬을 수 있는 스택. buzz를 화면 단위로 직접 참조 가능. Tauri updater로 Sparkle(#736) 불필요.
- (−) SwiftUI 자산(112파일·테스트·스냅샷 체계) 상당분 대체 — 단 도메인 로직/계약/검증기는 잔존 가치. 이중 스택 기간의 드리프트 리스크(동결 규율로 상쇄). Tauri iOS 신생 리스크(스파이크 게이트로 상쇄).
- 예약: Android(P5), Linux 데스크톱(WebKitGTK 리스크로 후순위), momo-core-rs 공유 범위.

## 부록 — 데스크톱 parity 게이트 (기본 배포 전환 조건)

로그인/초대 딥링크/서버 발견 · 채널/DM 타임라인(seq 순서·재연결 resume) · 컴포저+@멘션 · 에이전트 카드(승인/비용/상태) · 멤버 디렉터리 · 설정(AI 연결·코드 실행 호스트·워크스페이스 생성·초대 메일) · 업데이트 알림 · 알림(mac) · 성능(1k 메시지 60fps 스크롤·콜드 스타트<2s·유휴 메모리<400MB) · design-review Blocker0·High0.
