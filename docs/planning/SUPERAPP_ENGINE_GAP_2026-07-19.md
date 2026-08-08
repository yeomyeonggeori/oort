# 슈퍼앱 로드맵 대비 엔진 구현 진단 + 오픈소스 호스팅 경로 (2026-07-19, Fable)

> 성재 질의: "터미널/TUI(클로드코드·코덱스·OpenCode) 임베드 개발자 슈퍼앱" 비전 대비 엔진 현황 + 오픈소스 배포 시 수신자의 호스팅/우리측 서버 개설 경로.
> 근거 정본: ROADMAP.md(M0~M8) · ADR-0102/0111/0121 · BUILD_TICKETS ADR-gated 절 · ENGINE_HANDOFF(2026-07-19 X큐 소진 시점).

## 1. 층별 진단 — "바닥 3층 완성, 차별화 층(TUI)은 설계 게이트 대기"

| 층 | 내용 | 엔진 상태 | 근거 |
|---|---|---|---|
| L1 메신저 코어 | 채널/DM·스레드(롤업·과거답글)·반응/수정/삭제(교차클라 realtime·재시작 복원)·검색 FTS·첨부(Drive 직송+수신 투영)·음소거·허들(LiveKit)·푸시(APNs+NSE)·초대/가입 | **랜딩 완료** — X-1~X-5 소진(2026-07-19) | verify_* 13종 + runtime-db 게이트 |
| L2 에이전트 원장 | 에이전트=member·mention→agent_run·승인 pause/resume·비용/감사 원장·per-agent bearer·RLS FORCE·agent.partial/status 스트리밍·컨텍스트 조립 v1 | **랜딩** (Work v0, MOMO-362..365). 단 **실 Codex 왕복은 runtime-unverified(C-2)** — mock/loopback만 실증 | ADR-0101/0102/0111 |
| L3 연동/플러그인 | 플러그인 카탈로그·grant(GitHub/Notion/Linear)·웹훅 in/out(Slack 호환)·Drive MCP(읽기)·서명 ingress(ADR-0115) | **v0 랜딩** | SE-04A~D, MOMO-412 |
| L4 실행 경로 | ADR-0102 Option C(서버 보장 매트릭스 + BYOA 이중 경로) — provider 자격증명 비유입(0004/0234) 경계 확정 | **Accepted + v0 구현** | codex-workbench BYOA |
| **L5 개발자 콘솔(TUI)** | 앱 내 터미널·Claude Code/Codex/OpenCode 세션·command input·PTY/process·cwd/worktree 바인딩 | **미착수 — ADR-0114 미기안(번호만 예약)**. MOMO-375(Control+backtick transcript drawer)까지만 계획돼 있고 그것도 미발급 | BUILD_TICKETS ADR-gated 절 |
| L6 계정/멀티WS | 멀티워크스페이스 rail·account/session persistence | **미착수 — ADR-0117 미기안** | 〃 |

### L5의 실제 갭 (엔진 관점)
이미 있는 반쪽: agent_run 원장·승인 게이트·partial 스트리밍·outbox/realtime 전송·per-agent bearer — "세션의 원장·전송 절반"은 준비됨.
없는 절반(전부 ADR-0114 결정 대상):
1. **프로세스 호스트 계약** — 하드 경계(oort 서버는 user-owned execution host의 process/provider credential 보관·proxy 금지)상 PTY는 사용자 로컬(맥)에서 돌아야 함 → 앱 내장 PTY vs 로컬 호스트 데몬 선택.
2. **interactive stdin 경로** — 현 원장은 단방향 run+승인. 키 입력 스트림의 전송·보안(채널 원장에 남길지) 미결.
3. **TUI 렌더 표면** — 터미널 에뮬레이터(SwiftTerm류) 채택.
4. **cwd/worktree/repo 바인딩** — Work와 저장소의 연결 계약.

### 릴리스 트랙 잔여(엔진 외)
M4(릴리스용 Xcode .app 패키징)·M6(CI, 현재 disabled·local gate 대체)·M7(사용성 검수 게이트)·M8(스토어/공증) 미착수. ROADMAP §0 "현재 위치" 서술은 M1 시대 기준으로 낡음 — 차기 정비 후보.

## 2. 오픈소스 호스팅 — ADR-0121(Accepted)이 골격, S 배치가 미구현

**수신자 경로 3가지(결정 완료):**
1. **셀프호스트(D1-A)**: compose + `install.sh`/`upgrade.sh`(pinned digest·마이그레이션·롤백·preflight 통합). 대상="터미널 여는 운영자 1명", 5분 설치 문서, 단일 노드 상한 명시(보수적 "동시 수백"). **현황: prod compose 8서비스+SOPS+pgBackRest 뼈대는 있으나 install/upgrade 포장 미구현(ADR-0002 예약분) — S 배치 대기.** 푸시는 Dawn relay 등록(D4, 실패해도 설치 성공 — 오프그리드 1급). PushRelay(Ed25519)는 이미 이 계약대로 랜딩.
2. **초대 관통(D2-A)**: `momo.app/i/<code>`형 Dawn 단축 도메인 — 코드 비저장, 검증·가입은 대상 셀프호스트 서버에서. LinkShort 서비스 랜딩됨(도메인 미확정 — 성재 보류 중), 웹 랜딩(ADR-0119) 랜딩됨.
3. **"우리측 서버 개설 요청"(oort Cloud, D1-C)**: 0121에서 의도적으로 범위 제외했으나 **BM(D5-A Zulip 모델)의 수익원 1번**("기능이 아니라 운영을 판다"). 구현 최단 경로: 현 아키텍처가 워크스페이스=스택이므로 **테넌트당 단일 스택 프로비저닝**(신청 폼 → 프로비저너가 서브도메인+TLS+백업 딸린 스택 생성) — install.sh가 안정되면 그 자동화 위에 control plane만 얹는 구조. 진짜 공유 멀티테넌트는 ADR-0117 선행 필요라 v1엔 부적합.

**다음 결정 필요(성재):**
- S 배치 발급 시점(웹 W 배치는 랜딩됨 — 0121의 선행조건 충족 상태)
- 단축 도메인 확정(D2-A 발효 조건)
- oort Cloud를 별도 ADR로 열지(신청 플로우·프로비저너·과금 경계)

## 3. 권고 순서
1. **ADR-0114 기안**(L5 개방 — 슈퍼앱 차별화 층의 유일 게이트). PTY=로컬, oort=원장/전송 원칙이면 서버 확장은 소폭(세션 원장·stdin 이벤트 kind 정도).
2. **S 배치**(install/upgrade + 5분 설치) — 오픈소스 공개의 실질 선행물.
3. C-2(실 Codex 왕복) — L2의 마지막 unverified를 닫아 L5 설계의 실증 기반 확보.
