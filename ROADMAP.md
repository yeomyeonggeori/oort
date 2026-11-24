# oort — 릴리스 ROADMAP

> **현행 목표는 목표 A다**(2026-09-23 성재 확정, [ADR-0187](docs/adr/0187-goal-a-team-daily-desktop-ios.md)). 팀이 데스크탑 앱과 iOS 앱으로 oort를 매일 쓰는 것이 먼저이고, 외부 출시(외부 셀프호스터·그록봇·하네스 복붙)는 그 뒤다. 지금은 v0.1.47(2026-11-19)이 팀 서버와 맥 릴리스로 나가 있고(폰의 팀 TestFlight 그룹은 앞 빌드 그대로다 — §0), 다음 이정표는 v0.1.48(§0 「다음 이정표」)이다. **M7-I PASS 기록은 [M7 표](docs/cicd/03-store-readiness-gate.md)에 아직 없다**(내부 등급 점검 #4247). 2026-08-03의 v0 정의(관전·승인·대화가 폰에서 한 번씩)는 목표 A의 iOS 범위에 흡수됐다.
>
> **실행 주체:** 계획=기획 레이어(`docs/planning/README.md`) · 구현=워커(핸드오프 패킷, `AGENTS.md`) · 결정 거버넌스=ADR-0100. 증거는 PR 본문(`STATUS.md`는 2026-09-23 동결), 세션 스냅샷은 `docs/planning/CURRENT_STATE.md`, 트랙 운영은 `docs/TRACKS.md`.
>
> **불변식(배포 게이트):** 🔒 팀 배포(TestFlight·직접 전달 공증 DMG)는 **M7-I** PASS와 배포 건마다의 owner 승인 뒤에만 한다. 데스크탑 next 채널(팀 채널) 게시도 같은 규칙이다. 스토어·external TestFlight·공개 공증 배포는 **M7-S**다([M7](docs/cicd/03-store-readiness-gate.md), ADR-0187 D5).
>
> **아카이브:** 2026-08-03 판(M0~M8)과 2026-09-02 출시 프로그램 판(UX-R·DS·SH·M·P 레인·G0~G3 게이트)의 전문은 git 히스토리와 `docs/planning/2026-09-02-launch-program-plan.md`에 있다. 스토어 제출·공증·법무는 목표 A의 W4(M7-S)에서 다시 태운다.

---

## 0. 현재 위치 (2026-09-23, 갱신 2026-11-23)

**출시 전 · 팀이 쓰는 실물이 나가 있는 단계.** v0.1.47(2026-11-19)이 팀 서버와 맥 릴리스로 나갔다. 폰은 팀 TestFlight 그룹이 앞 빌드 그대로다(아래 표). 남은 일은 M7-I 점검 기록(#4247)과 다음 판 v0.1.48이다. 계획 정본은 [`docs/planning/2026-09-23-goal-a-plan.md`](docs/planning/2026-09-23-goal-a-plan.md)다.

| 표면 | 상태 | 목표 A 완료선 |
|---|---|---|
| **서버** | 테넌트 격리, 승인 폐곡선, AX 제안·실행(ADR-0186), Rust push relay(SH-10)가 main에 있다. **v0.1.47 이미지 발행**(2026-11-19, `releases/latest.json`, 마이그레이션 180~186 · 스키마 186) | notifier·push relay까지 상시 가동을 확인하는 것 |
| **웹 + 데스크탑(Tauri, ADR-0133)** | 웹이 가장 성숙하다(buzz 패리티 파도 다수 랜딩). 데스크탑은 공증 릴리스가 나간다(`mac-v0.1.47`, 2026-11-20, 배포 저장소 `momo-alpha`). 내려받기 사이트는 https://app.oor7.com/ 이고, 앱·피드·사이트 번호 줄은 0.1.N으로 통일됐다(v0.1.46부터). 자동 업데이트 피드 게시는 건마다 owner 승인이다 | M7-I PASS 기록, 팀원 설치(#5227) |
| **iOS(RN, ADR-0137)** | 대화 기반(스레드·리액션·첨부·멘션·검색·DM·승인 인박스·QR 연결)이 있고 TestFlight 내부 그룹으로 팀에 나가 있다. v0.1.47 폰 빌드는 iOS 27에서 켜자마자 멈춰 팀 그룹에서 뺐고(#6015에서 고침), 팀 그룹은 앞 빌드 그대로다. 고친 빌드는 owner 확인용 그룹에만 있고 팀 배포는 다음 승격 빌드에서 한다(#5227). 빌드 도구는 Xcode 27.2 · Expo 57이다. Mac이 켜져 있으면 Mac 세션 화면이 열린다(v0.1.46, #5593). App Store 제출은 아직이다(M7-S) | App Store, 실기기 푸시, 원격 작업(ADR-0188) |
| **호스팅** | Railway의 팀 인스턴스 `oort-team`(https://oort-team.up.railway.app)이 v0.1.47로 상시 가동 중이다 | Railway 기본, Tailscale은 임시 원격 경로 |
| Android | 미착수 | iOS App Store 뒤(ADR-0137 결정 6). 첫 고객의 조건이 아니다 |

> **2026-10-01 출하:** 팀 기억 v2 M0~M3([ADR-0196](docs/adr/0196-team-memory-v2.md))가 main에 있고(`58cfd534`, migration 098~110) 서버 v0.1.15로 `oort-team`에 배포됐다. 증거 빌드는 데스크탑 0.1.15·iOS 3030이며 owner 스모크와 팀 「기본 AI」 채널 요약 행 설정이 남았다. 그래프 뷰(M4)만 목표 A 밖이다.

### 다음 이정표 — v0.1.48 (두 번의 승격으로 나눈다)

1. 앞 판에서 남은 기획 칸.
2. 팀 QA로 디자인 디테일 잡기.
3. 디자인 시스템 구축·적용: 부품 장부, 「공용 부품 밖」 잔량 시험, 단추 규격부터.
4. 다국어 화면 옮기기: 문구를 사전 키로, 한국어·영어 먼저(1차 7개 언어, [ADR-0213](docs/adr/0213-internationalization-foundation.md)).
5. 에이전틱 워크플로우·뷰의 시작: 작업 원장([ADR-0222](docs/adr/0222-work-ledger-and-orchestrator-view.md)), 에이전트 반응, 에이전트가 글에 그림을 붙이는 길.
6. 내부 배포 점검: M7-I 재점검(#4247).

### 그 뒤 방향 (2026-11-13 확정)

첫 고객은 맥·아이폰을 쓰는 50명 이하 팀이다. 회사마다 인스턴스를 두고, 종단간 암호화는 하지 않으며 셀프호스트가 데이터 주권의 답이다. 확장은 선언형과 서버 쪽 에이전트로 하고, 가져오기는 Slack을 먼저 한다. Android·Windows는 출시 조건이 아니다. 스토어 제출·공개 배포는 M7-S 뒤다.

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

> 상태(2026-11-23): **W1**은 배포 면이 대부분 나갔다(팀 인스턴스·맥 공증 릴리스·TestFlight 내부 그룹 — 폰의 v0.1.47 빌드만 위 표대로 다음 승격에서). 푸시의 상시 relay와 실기기 실수신은 이 문서에 확인 기록이 아직 없다(위 「푸시」 줄 그대로). **W2**는 일부가 들어갔다(세부는 `CHANGELOG.md`). **W3**는 M7-I PASS 기록이 없어 아직이고, **W4**는 시작 전이다. 아래 표는 2026-09-23 편성 그대로 둔다.

| 파도 | 레인 | 완료 신호 |
|---|---|---|
| **W1** | Railway 설정 PR(#2205: 시작 명령·PG18·Centrifugo·XFP·드라이브·푸시 서비스·doctor 수리) → v0.1.6 → `oort-team` 배포 · 데스크탑 증거 빌드(#1607, `--public` 무업로드) · iOS 배포(#2568: 권한 문구·TestFlight 1인 그룹·APNs production) · iOS 대화 1(#1084+#2513·#1964·#1892·푸시 탭 이동 #2569) | 수리된 doctor PASS·`wss://`·두 탭 실시간, owner 기기에서 공증 DMG 로그인·TestFlight 설치·실기기 푸시 |
| **W2** | iOS 대화 2(#1048·#1083·#1049·배지) · 원격 R0·R1(W1에 착수한 R0 #2570·workd #2571 → W2 완료, workd는 R0 뒤 머지) · 크래시 계측 S-0 · AX-6 #2512(Railway 위) | 데스크탑 세션을 폰에서 보고 권한 승인 1회, 불변식 red proof, 계측에 세션 수가 잡힘 |
| **W3** | M7-I PASS(**원격 R1 포함**, 성재 결정 · R0·R1 보안 재검수 PASS · S-0 켜짐) → 팀 배포(#1281 첫 next 게시 포함, 건별 승인) → **내부 테스트**(팀 전원이 정한 기간 주 메신저로 쓰고 불편 전부 티켓) · 원격 R2(R1 재검수·ADR-0146 개정 뒤, 사람 기기 키 서명) | PASS 표 2행, 폰에서 시킨 작업 1건 완주 |
| **W4** | 스토어(#20–#22·#30·#34·#35) · 원격 R3 · M7-S → #31 제출 | App Store 심사 제출 |

### 게이트

| 게이트 | 조건 |
|---|---|
| **M7-I** | [M7](docs/cicd/03-store-readiness-gate.md) I-1~I-8(I-8 = ADR-0188 R1), 데스크탑·iOS 각각, 배포 건마다 owner 승인 |
| **내부 테스트** | 팀 전원이 정한 기간 oort를 주 메신저로 쓴다. 기본 2주(S-1 하한), 성재 확정 대기 |
| **M7-S** | M7 S-0~S-8, 제출 빌드 커밋 기준 |
| **외부 출시(목표 A 뒤)** | 외부 셀프호스터 3(하네스 복붙·그록봇·Railway) + 에이전트 멘션·런 실사용 + LAUNCH_READY(2026-08-10 정의 유지) |

## 2. 보류 (재점화 조건 명시)

- **외부 출시 항목**(ADR-0187 D6): 그록봇 VM 발행 이미지 재실측(E2E-A), Railway 밖 플랫폼 경로 확장, 외부 셀프호스터 모집, 하네스 복붙 설치의 외부 재현, AX-5 #2511·AX-8 #2514 → 목표 A 뒤.
- **Android**: iOS App Store 뒤(ADR-0137 결정 6).
- **VM/그록봇 릴레이 축**: SH-8 — 외부 출시 단계에서 재개.
- **buzz 제품축 6종 판정**(forum·projects·terminal·mesh-compute·workflows): 외부 출시 뒤 재취사. **agent-memory는 제외한다** — 성재 2026-09-29 「M1뿐만 아니라 M3까지 완성하고 출시하고 싶어. 나머진 권장대로」로 팀 기억 v2 M1~M3(#3158~#3174, [ADR-0196](docs/adr/0196-team-memory-v2.md))를 목표 A 안으로 당겼다. 그래프 뷰(M4)만 목표 A 밖.
- **웹·데스크탑 UX 잔여 파도**(UX-R·DS 잔여): 목표 A 동안은 내부 테스트 불편으로 올라온 것만 한다.
- **Enterprise Trust**(위협 모델·SBOM·시크릿 스캔·VDP·보안 백서, MOMO-140): ADR-0187 §3이 외부·엔터프라이즈 출시로 연기를 제안했다. 성재 확인 전까지는 M7-S S-8로 남는다.

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
