# oort — 릴리스 ROADMAP

> **v0의 단위는 마일스톤 번호가 아니라 축이다**(2026-08-03 성재 승인).
> ADR-0137 D5가 자른 셋 — **관전 · 승인 · 대화** — 이 **폰에서 한 번씩 도는 것**이 v0다. 스토어는 그 뒤.
>
> **실행 주체:** 계획=기획 레이어(`docs/planning/README.md`) · 구현=워커(핸드오프 패킷, `AGENTS.md`) · 결정 거버넌스=ADR-0100. 증거는 `STATUS.md`, 세션 스냅샷은 `docs/planning/CURRENT_STATE.md`, 트랙 운영은 `docs/TRACKS.md`.
>
> **불변식(스토어 게이트):** 🔒 스토어/공증 배포(external TestFlight 포함)는 사용성 검수 게이트 PASS 후에만 진행한다(체크리스트는 아카이브 §4~§5).
>
> **아카이브(2026-09-01 경량화 재편, 성재 지시):** 직전 판 전문(2026-08-03 §0 + M0~M8 §1~§7)은 `docs/archive/ROADMAP-2026H1-M0-M8.md`. M0~M8의 **스토어 제출·공증·법무·CI/CD 체크리스트는 폐기가 아니라 보류** — 축 셋이 폰에서 돈 뒤 그 부분만 다시 태운다.

---

## 0. 현재 위치 (2026-09-02)

**출시 전 · 내부 도그푸드 · 셀프호스트 중심.** NCP 클라우드는 철수했고(2026-08-26~27 집행), 배포 실물은 **셀프호스트 compose 스택**(최신 발행 v0.1.3, digest pin)이다. 성재 검수는 로컬 스택(oortv013) + track/uxui 검수 앱으로 진행 중.

### v0 = 축 셋이 폰에서 도는 것

| 축 | 서버 | 웹/데스크탑 | 모바일(RN) |
|---|---|---|---|
| **대화** | ✅ | ✅ | ✅ |
| **관전**(작업 세션) | ✅ (#1777·#1778 수리 랜딩) | ✅ TC-1 관전 도크 | 🚧 |
| **승인**(툴콜) | ✅ 폐곡선(#979) | 부분 | ❌ |

**웹 대비 폰 격차가 여전히 최대 격차다.** 폰이 관전·승인을 표면화하지 않으면 에이전트 네이티브 메신저가 아니라 봇이 있는 채팅이다(ADR-0101이 거부한 자리). 패리티 티켓: #1908(초안)·#1892(점프 항법)·#1876·#1748·#1752·#1604 등.

### 서버 — Rust/Axum 단독 배포 (ADR-0145)

- `server-rust/` = 배포 실물. `server/` = Swift 이식 원본(실행 대상 아님) + **`Migrations/` 정본(언어 독립 — 불변식은 DB 트리거·제약·RLS에 있다)**.
- 핵심 불변식: Postgres=SoT · Centrifugo=전송전용 · 단일 쓰기경로(REST→PG→outbox→relay) · 순서=`message.seq` · 에이전트=`member` · RLS FORCE(ADR-0004 포함).
- 대표 이식 잔여: 웹훅 인바운드 2경로(#1265) · Centrifugo subscribe proxy 403(#1300) · 라우트별 상세는 `STATUS.md`.

### 클라이언트

| 대상 | 상태 |
|---|---|
| **웹 + 데스크탑(Tauri, ADR-0133)** | 주력 검수 표면. 2026-08-29~30 buzz 패리티 파도(BZ 시리즈 + BF A/B군) 대량 랜딩 — track/uxui |
| **모바일(RN, ADR-0137)** | 서 있음 · 웹과 기능 격차 큼 — 다음 패리티 파도 대상 |
| 모바일(Android) | 미착수 — iOS v0 TestFlight 직후(FCM 체인 이중 구축 방지, ADR-0137 §6-b) |

### 운영 파이프라인

- **트랙**: track/uxui · track/engine에서 랜딩(트랙 내 머지 자율), **main 승격은 성재 명시 승인**(`docs/TRACKS.md`).
- **워커 레인**: Opus 5 Agent 레인(2026-09-01~, 병렬 상한 2), 리뷰는 design-review 에이전트 폐곡선(Blocker 0·High 0) 후 머지. 레인·모델 정본은 (예정) `docs/planning/PIPELINE.md`.
- **푸시**: APNs 종단 증명 완료 · PushRelay 배포 · id-only payload(ADR-0120). 셀프호스트는 Dawn PushRelay 경유(D1-A). Apple 서명 자산 확보 완료, CI 레인만 미구축.

---

## 1. 출시 프로그램 (2026-09-02 성재 승인 — 편성 정본 `docs/planning/2026-09-02-launch-program-plan.md`)

> 진단 정본 `docs/planning/research/2026-09-02-launch-rediagnosis-two-pillars-brief.md`. 두 기둥 = **①Buzz급+Raycast 감각 UXUI ②프롬프트 하나로 설치되는 셀프호스팅**. 4레인이 파일군 분리로 병렬, 게이트 4로 진행을 잰다.

| 레인 | 파도 | 내용 | 상태 |
|---|---|---|---|
| UXUI | **UX-R0~R6** | ADR-0179 표현 축(모션·눌림·엘리베이션·밀도) → 모션 토대 → 온보딩 절정(프로필·웰컴 킥오프·첫 에이전트 연결 퍼널) → ⌘K 액션 팔레트 → 에이전트 표면 통합(enabledTools UI·provider 글리프) → 상호작용(DnD·리액션·일시 확인 정책) → 외양(BZ-5a 머지·밀도·폰트) | 편성 완료·착수 대기 |
| UXUI | **DS-0~6** | 디자인시스템 재발 방지: 표현 축 정본화 · 프리미티브 12종 · `/design` 갤러리 라우트 · 측정 확장(3짝 캡처·waitForAnimations·px-text·1,000줄 ratchet) · 리뷰 루프 · 폰 토큰 파생 · 인테이크 분류 규율 | 편성 완료 |
| 엔진 | **SH-1~9** | 릴리스 매니페스트 → 공개 엣지 파라미터화(#1926) → `oort doctor`/CLI → 영문 하네스 불가지론 런북+README 프롬프트 블록 → Railway/Fly/AWS·GCP 경로 → 에이전트 합류 GUI → blocker 순서(#1265→#1925→#1792→#1927) → 그록봇 루틴 정본 → OSS 위생 | 편성 완료·착수 대기 |
| 엔진 | **BT 파도 마감** | BT-1~5 랜딩. **BT-6(#1934) 서버 절반 미커밋(wbt6-server) — 이어받기** | G0 |
| 모바일 | **M0 QR 기기 연결** | ADR-0180 1회용 링크 토큰: 서버 라우트 2 + 웹 QR 카드 + 폰 스캔 화면. **G1 창 안에서 선행**(셀프호스팅 blocker 무관, Railway E2E 마지막 칸) | 편성 완료 |
| 모바일 | **M1 폰 패리티 · M2 TestFlight internal** | 관전·승인 축 완주 + 웹 전용 축 이관(#1908 #1892 #1876 #1748 #1752 #1604 #1600 #1396) + 폰 온보딩. **G1 이후 ITO와 병렬**. TestFlight internal은 M0 직후(성재 손) | 편성 완료(순서 확정) |
| 파이프 | **P1~P8** | PIPELINE.md 단일 설정(레인 추상화) · CODEX.md→AGENTS.md 병합 · `.claude/commands` · worker-lane 스킬 · handoffs archive · planning_context 갱신 | 편성 완료 |
| 공통 | **런칭 보조축 — Bring your hosted agent** | ADR-0162 축 — 계약·순서는 `BUILD_TICKETS.md` §런칭 보조축(유지). UX-R2c(첫 에이전트 연결 퍼널)·SH-6이 이 축의 UI/서버 잔여를 흡수 | 부분 랜딩 |

### 게이트

| 게이트 | 조건 |
|---|---|
| **G0 파도 마감** | BT-6 랜딩 · 결재 3건 집행(BZ-5a 액센트 기본=새벽 → #1922 머지 · A6 rich 기본 상향 · track→main 승격) · v0.1.4 발행 |
| **G1 내부 테스트 진입** | UX-R1·R2 + DS-0·1 + SH-1~4 + M0 + P1·P2 랜딩 → ITO(성재+1인, 웹+데스크탑+폰 QR 스모크, `2026-08-20-oss-launch-readiness-and-internal-test-plan.md` 시나리오 표 재사용) |
| **G2 출시** | 외부 셀프호스터 3(하네스 복붙 1·그록봇 1·Railway 1) + 에이전트 멘션·런 실사용 + LAUNCH_READY 판정 |
| **G3 v0 스토어** | 축 셋(관전·승인·대화) 폰 완주(M1) + M7 사용성 게이트 → external TestFlight → App Store |

## 2. 보류 (재점화 조건 명시)

- **스토어 제출·공증·CI/CD·법무**: G3 조건 충족 뒤 재점화. 체크리스트 원문=`docs/archive/ROADMAP-2026H1-M0-M8.md` §4~§7(법무 항목은 법률 자문 아님 — 외부 변호사 1회 검토 필수).
- **Android**: iOS v0 TestFlight 직후(ADR-0137 결정 6).
- **VM/그록봇 릴레이 축**: SH-8 — 그록봇 복구 시 재개(S2·S3·허들 결함 B 서버 적용), 그록봇 "템플릿" 앱 표면 확인 전까지 루틴 지시문 정본화.
- **buzz 제품축 6종 판정**(forum·projects·terminal·mesh-compute·workflows·agent-memory): 차별화 감사가 "싸우지 않을 자리"로 둔 축 — G2 뒤 재취사.

## 3. 문서 지도

| 무엇 | 어디 |
|---|---|
| 결정(왜) | `docs/adr/` (ADR-0100 거버넌스) |
| 증거(됐나) | `STATUS.md` (당월+직전월 · 과거=`docs/archive/STATUS-YYYY-MM.md`) |
| 현재 상태(어디까지) | `docs/planning/CURRENT_STATE.md` (스냅샷 최근 6) |
| 계획(다음) | 이 문서 + GitHub Issues |
| 티켓 수용기준 | `BUILD_TICKETS.md` (등급·활성 축·백로그만) |
| 트랙·머지 규율 | `docs/TRACKS.md` |
| 아카이브 색인 | `docs/archive/README.md` |
