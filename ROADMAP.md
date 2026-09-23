# oort — 릴리스 ROADMAP

> **현행 목표는 목표 A다**(2026-09-23 성재 확정, [ADR-0187](docs/adr/0187-goal-a-team-daily-desktop-ios.md)). 팀이 데스크탑 앱과 iOS 앱으로 oort를 매일 쓰는 것이 먼저이고, 외부 출시(외부 셀프호스터·그록봇·하네스 복붙)는 그 뒤다. 첫 이정표는 **데스크탑·iOS 둘 다 M7-I PASS로 팀 배포**다. 2026-08-03의 v0 정의(관전·승인·대화가 폰에서 한 번씩)는 목표 A의 iOS 범위에 흡수됐다.
>
> **실행 주체:** 계획=기획 레이어(`docs/planning/README.md`) · 구현=워커(핸드오프 패킷, `AGENTS.md`) · 결정 거버넌스=ADR-0100. 증거는 PR 본문(`STATUS.md`는 2026-09-23 동결), 세션 스냅샷은 `docs/planning/CURRENT_STATE.md`, 트랙 운영은 `docs/TRACKS.md`.
>
> **불변식(배포 게이트):** 🔒 팀 배포(공증 DMG·업데이터·TestFlight internal)는 **M7-I**, 스토어·external TestFlight·공개 공증 배포는 **M7-S** PASS 기록 뒤에만 진행한다([M7](docs/cicd/03-store-readiness-gate.md), ADR-0187 D5).
>
> **아카이브:** 2026-08-03 판(M0~M8)과 2026-09-02 출시 프로그램 판(UX-R·DS·SH·M·P 레인·G0~G3 게이트)의 전문은 git 히스토리와 `docs/planning/2026-09-02-launch-program-plan.md`에 있다. 스토어 제출·공증·법무는 목표 A의 W4(M7-S)에서 다시 태운다.

---

## 0. 현재 위치 (2026-09-23)

**출시 전 · 팀이 쓸 실물을 만드는 단계.** 서버와 웹은 목표 수준에 가깝다. 막힌 곳은 호스팅·데스크탑 배포·iOS다. 계획 정본은 [`docs/planning/2026-09-23-goal-a-plan.md`](docs/planning/2026-09-23-goal-a-plan.md)다.

| 표면 | 상태 | 목표 A 완료선 |
|---|---|---|
| **서버** | 테넌트 격리, 승인 폐곡선, AX 제안·실행(ADR-0186), Rust push relay(SH-10)가 main에 있다. v0.1.5 이미지 발행 | Railway 팀 인스턴스에 notifier·push relay까지 상시 가동 |
| **웹 + 데스크탑(Tauri, ADR-0133)** | 웹이 가장 성숙하다(buzz 패리티 파도 다수 랜딩). 데스크탑은 배포가 멈췄다(DMG는 v0.1.1 하나, `release-desktop.yml` 실행 기록 없음) | 공증 DMG·자동 업데이트, M7-I |
| **iOS(RN, ADR-0137)** | 대화 기반(스레드·리액션·첨부·멘션·검색·DM·승인 인박스·QR 연결)이 있지만 배포된 적이 없다. 작업 화면은 읽기 전용이고 기본으로 숨겨져 있다(#2166) | TestFlight → App Store, 실기기 푸시, 원격 작업(ADR-0188) |
| **호스팅** | 상시 인스턴스가 없다(NCP 철수, Railway 기동 실패 이력) | Railway 기본, Tailscale은 임시 원격 경로 |
| Android | 미착수 | iOS App Store 뒤(ADR-0137 결정 6) |

### 서버 — Rust/Axum 단독 배포 (ADR-0145)

- `server-rust/` = 배포 실물. `server/` = Swift 이식 원본(실행 대상 아님) + **`Migrations/` 정본(언어 독립 — 불변식은 DB 트리거·제약·RLS에 있다)**.
- 핵심 불변식: Postgres=SoT · Centrifugo=전송전용 · 단일 쓰기경로(REST→PG→outbox→relay) · 순서=`message.seq` · 에이전트=`member` · RLS FORCE(ADR-0004 포함).
- 대표 이식 잔여: 웹훅 인바운드 2경로(#1265) · Centrifugo subscribe proxy 403(#1300) · 라우트 계약은 `docs/api/openapi.yaml`.

### 운영 파이프라인

- **트랙**: track/uxui · track/engine에서 랜딩(트랙 내 머지 자율), **main 승격은 성재 승인 범위의 묶음 단위**(상시 위임, `docs/TRACKS.md` §3).
- **실행 레인**: 모델·하네스·병렬 판단은 `docs/planning/PIPELINE.md`의 현재 값을 따른다. UI는 독립 design-review(Blocker 0·High 0) 후 머지한다.
- **푸시**: id-only payload(ADR-0120). Rust push relay는 main에 있지만 상시 배포된 relay가 없고, 실기기 실수신은 W1에서 잰다(ADR-0187 D4). Apple 서명 자산은 확보돼 있다.

---

## 1. 목표 A 파도 (2026-09-23 — 편성 정본 `docs/planning/2026-09-23-goal-a-plan.md`)

| 파도 | 레인 | 완료 신호 |
|---|---|---|
| **W1** | Railway 설정 PR(#2205: 시작 명령·PG18·Centrifugo·XFP·드라이브·푸시 서비스·doctor 수리) → v0.1.6 → `oort-team` 배포 · 데스크탑 증거 빌드(#1607, next 게시는 채널 결정 뒤) · iOS 배포(권한 문구·TestFlight 1인 그룹·APNs production) · iOS 대화 1(#1084+#2513·#1964·#1892·푸시 탭 이동) | 수리된 doctor PASS·`wss://`·두 탭 실시간, owner 기기에서 공증 DMG 로그인·TestFlight 설치·실기기 푸시 |
| **W2** | iOS 대화 2(#1048·#1083·#1049·배지) · 원격 R0·R1(ADR-0188 Accepted 뒤) · AX-6 #2512(Railway 위) | 데스크탑 세션을 폰에서 보고 권한 승인 1회, 불변식 red proof |
| **W3** | M7-I PASS → 팀 배포 → **내부 테스트**(팀 전원이 정한 기간 주 메신저로 쓰고 불편 전부 티켓) · 원격 R2(사람 기기 키 서명) | PASS 표 2행, 폰에서 시킨 작업 1건 완주 |
| **W4** | 스토어(S-0 크래시 계측·#20–#22·#30·#34·#35) · 원격 R3 · M7-S → #31 제출 | App Store 심사 제출 |

### 게이트

| 게이트 | 조건 |
|---|---|
| **M7-I** | [M7](docs/cicd/03-store-readiness-gate.md) I-1~I-6, 데스크탑·iOS 각각 |
| **내부 테스트** | 팀 전원이 정한 기간 oort를 주 메신저로 쓴다. 기간은 성재 확정 대기 |
| **M7-S** | M7 S-1~S-7 |
| **외부 출시(목표 A 뒤)** | 외부 셀프호스터 3(하네스 복붙·그록봇·Railway) + 에이전트 멘션·런 실사용 + LAUNCH_READY(2026-08-10 정의 유지) |

## 2. 보류 (재점화 조건 명시)

- **외부 출시 항목**(ADR-0187 D6): 그록봇 VM 발행 이미지 재실측(E2E-A), Railway 밖 플랫폼 경로 확장, 외부 셀프호스터 모집, 하네스 복붙 설치의 외부 재현, AX-5 #2511·AX-8 #2514 → 목표 A 뒤.
- **Android**: iOS App Store 뒤(ADR-0137 결정 6).
- **VM/그록봇 릴레이 축**: SH-8 — 외부 출시 단계에서 재개.
- **buzz 제품축 6종 판정**(forum·projects·terminal·mesh-compute·workflows·agent-memory): 외부 출시 뒤 재취사.
- **웹·데스크탑 UX 잔여 파도**(UX-R·DS 잔여): 목표 A 동안은 내부 테스트 불편으로 올라온 것만 한다.
- **Enterprise Trust**(위협 모델·SBOM·시크릿 스캔·VDP·보안 백서, MOMO-140): 외부·엔터프라이즈 출시 단계(ADR-0187 §3).

## 3. 문서 지도

| 무엇 | 어디 |
|---|---|
| 결정(왜) | `docs/adr/` (ADR-0100 거버넌스) |
| 증거(됐나) | PR 본문 · `CHANGELOG.md` (`STATUS.md`는 2026-09-23 동결된 역사) |
| 현재 상태(어디까지) | `docs/planning/CURRENT_STATE.md` (스냅샷 최근 6) |
| 계획(다음) | 이 문서 + GitHub Issues |
| 티켓 수용기준 | `BUILD_TICKETS.md` (등급·활성 축·백로그만) |
| 트랙·머지 규율 | `docs/TRACKS.md` |
| 아카이브 색인 | `docs/planning/archive/README.md` |
