# 기획 저널 보관 — 2026-09

## 2026-09-04 (저녁) · Fable · ★결정 4건 집행(바닥 동시 상한 3·#2057 확정·7월 pending 정리) + R1e/R1b 발사 준비 — go 대기

- 결정: #2050 N-2 동시 상한 3(ADR-0179 D3 정오표) · #2057 이징 기반 단일 상한 확정 · DEVIATION 7월 3건 판정(MOMO-412 유효 → #2066 `accepted`, MOMO-471/474 macOS 은퇴 → `noted`, #495 close) · 출시 계획 머리글 정정.
- 준비: 워크트리 wuxr1e·wuxr1b @ uxui 51f32202 + node_modules, 미션 2본(claudedocs/resume-2026-09-04/). 재개 체크포인트 RESUME.md 같은 디렉터리.
- 다음: go → R1e·R1b 병렬 발사 → 폐곡선 → 승격 n(R1b 프리플라이트 변경 감사).

## 2026-09-04 (오후) · Fable(+Opus 5 검수) · ★UX-R1c 5회전 랜딩 + 승격 m — W1 uxui 1차 파도 완결(R1a·R1c·R1d·DS-2 main 정본화)

- 랜딩: UX-R1c #2045 R3 FAIL(정착 팝 48~76px) → R4 워커(API 소진 사망 → `--continue` 재개) → R4 FAIL(늘어남 반쪽 +224px, 가드 맹점) → R5 워커 → **R5 PASS**(32트레이스 양방향, cap 64 이탈 정직 판정). 승격 m #2058(토폴로지 검사 → sync #2059 선행) + sync #2060 → main=f8cc7754.
- 발행: #2057(R5 잔여 — 이징 기반 단일 상한·부하 선언 7개·intro 플레이크).
- 정정: PIPELINE §3 재개 `--continue` · 승격 뒤 sync는 소스 트랙에도. 교훈: 수리 사슬은 구간/방향 누락 모양 · 숫자 상한은 프레임레이트 종속 · 워커 절단·소진 상시.
- 다음: R1e/R1b/R2a/R2b 발사(go) · #2050 N-2 결정 · ITO 준비.

## 2026-09-04 · Fable(+Opus 5 검수) · ★W1 3차 랜딩 — UX-R1a·R1d 폐곡선, DS-2 포함 승격 l, UX-R1c R4 진행, 레인 재정의

- 레인: 성재 「Fable + opus5으로 가자」 — planner Fable · design-review Opus 5 · 워커 Cursor grok 4.6. 재개는 Opus5의 스크래치 RESUME.md로 복원 후 repo 보존(`claudedocs/resume-2026-09-03/`).
- 랜딩: UX-R1a #2043(2회전 — 제품 다이얼로그 exit 0 → 12~20 frames 실측) · UX-R1d #2042(4회전 — 가상화 버스트 1/3 → 3/3·5/5·10/10). UX-R1c #2045 R2 FAIL(CI 상시 빨강 throw·런타임 3회 초록·Inbox 비로딩) → R3 FAIL(정착 팝 48~76px, 한 프레임) → R4 워커 발사.
- 승격 l: #2051(uxui→main) + sync #2052/#2053 → main=d584e95c·uxui=c9ec58c7·engine=ab6a2ba7, alignment PASS.
- 발행: #2048(`MOTION_VOCABULARY` 2/10 누락) · #2049(R1a 잔여) · #2050(R1d 잔여 + 성재 결정: 바닥 동시 도착 상한). 개방: #1997·#2001·#2002 ready.
- 교훈: 스크래치 `.git` 함정 · `pgrep -f` 미션 텍스트 매치 · 루트 폰 node_modules 신선도 · skipIf 형제 형태를 미션에 명시 · 구간 단정(프레임당 최대 변화량) · 워커 stdout 절단 · bash 3.2 연관 배열.
- 다음: R1c R4 검수·랜딩·승격 m → R1e/R1b/R2a/R2b 발사(go) → ITO 준비.

## 2026-09-03 · Fable→Opus5 · ★W1 2차 랜딩 — M0m·UX-R4a·M0w 폐곡선, DS-2 잔류, 워커 레인 정지

- 랜딩: M0m #2009(3회전, iOS warm 딥링크 선재 공백 복구) · UX-R4a #2015(4회전, 「보이지 않는 포커스 링」 교정) · M0w #2019(3회전, **스캔 불가 QR 인코더** 수리 + 독립 왕복 디코드 시험). 승격 배치 k #2033 + sync #2034/#2035 → main=10893152.
- 잔류: DS-2 #2020 R3 FAIL(B1·H3 — ContextMenu 표본이 라이브에서 빈 상자, 기하 단정이 클리핑 무시). 미션 R4 작성 완료.
- 정지: grok Build 잔액 소진(402)으로 워커 레인 중단. 결정 대기(충전/Opus 전환/마감).
- 발행: #2016·#2029·#2030·#2031·#2032, #2018 범위 확장.
- 교훈: 「실패할 수 없는 단정」이 이 회차 최빈 결함 — 검수 사보타주 요구가 전부 잡았다. 병합 트리 게이트 동시 실행 금지.
- 정본 정정: 디자인시스템 README 칩 테두리 잔량 문구에서 `AgentHubRoute.tsx:181`(UX-R4a가 닫음) 제거, 살아있는 자리(`AgentTurnBadge.tsx:34`·`AgentWorkPanel.tsx:233-234`)로 갱신.

## 2026-09-02 (심야2) · Fable · ★W1 1차 랜딩 — v0.1.4 발행·엔진 3건+UX-R0+SH-3a main 정본화·M0m R1 FAIL→R2·UX-R4a 가동

- 발행: v0.1.4(run 33616349789, 태그 e39e9427, attestation PASS) → SELF_HOST §2-B·CHANGELOG #1980.
- 랜딩: SH-1 #1983 · M0s #1986(A-44) · UX-R2s #1993(A-45 — 1차 체인 머지 누락 발견, 9/3 재랜딩) · UX-R0 #1985(R1 FAIL→R2 PASS→R3 CI Chromium skipIf) · SH-3a #2007(재검증 9/9·시크릿 0/14). 승격 #2005 + 배치 i #2012/#2014, sync h·i. main=1a88d9ca.
- 검수: M0m PR #2009 design-review FAIL B1·H2·M7·N5 → R2 미션(기획 결정 3: QR 헤드라인=outline 티어·`font.display`·-습니다 어투). 서버 후속 #2010, 폰 후속 #2011.
- 발행: UX-R1a~e·R2a·R2b #1996~#2002, #1984 범위 확장, #2000 원장. ADR-0179 D1 정오표(온보딩 300ms×3 예외 열거).
- 교훈: gh --delete-branch 워크트리 함정(메모리) · CI 유닛 레인 Playwright 부재.
- 다음: M0m R2 재검수·랜딩 → UX-R4a 랜딩(#2015 design-review → 트랙) → DS-2/M0w 발사 → 승격 j → ITO 준비.

## 2026-09-02 (심야) · Fable · ★G0 완주 — BT-6 5회전 랜딩·lint 위생·승격 배치 7PR(감사 6회)·main 정본화. 발행 창만 남음

- BT-6 클라 #1963: R1 B2·H2(재열람 경계 소실·폰 tsc·게이트 1/5·캡처 비결정) → R2 H-3(재마크 회귀) → R3 H-4/H-5(캡처 증거 무효·정렬 중 IO 래치) → R4 H-6(롤백 null 흡수) → R5 PASS. H-5는 4회 불성립 후 선재 판정·철회(#1966). 재검증 매 회전: ts-check·lint·vitest·병합 트리 8레인.
- BZ-5a가 track/uxui web lint를 53오류로 붉힌 것 발견(merge-tree 미실행 누락) → #1965 수리. 메모리: 트랙 머지 전 verify_merge_tree 필수.
- 승격: #1968 engine→main(감사) → #1969 sync(감사) → #1970 uxui→main(감사) → #1971 sync(감사) → #1953 docs(감사: AGENTS/CODEX/TRACKS) → #1972/#1973 sync(감사). alignment PASS. 세션 리셋 1회(체인 재개).
- 다음: v0.1.4 발행 창(성재) → ADR-0179~0182 Accept → W1 발사(#1954~#1957 즉시, #1958~#1960 ADR 후).

## 2026-09-02 (밤) · Fable · ★G0 집행 — BZ-5a·BT-6 서버 랜딩, W1 패킷·이슈 7건, P1/P2 보류 PR, 클라 워커 가동

- 성재 "발사"(BT-6) + "워커=grok 4.6": 서버 절반 grok 워커 11:37 발사 → PR #1961(RED→GREEN→타입 동기화) → 재검증(일회용 PG 5/5·2/2·3/3, RED 커밋 5/5 실패) → track/engine 6faccaea. A-43 ready(#1962). 클라 절반 워커 12:06 발사(병렬 2).
- BZ-5a #1922: 38커밋 뒤처짐 → track 합류(STATUS 양블록)·main 합류·sync 짝 #1951/#1952 → 정책 재감사(첫 코멘트의 "바이트 동일"이 zsh 미분리 빈 비교였음을 발견·정정: 머지 3건 evil-merge 헌크 0·후보 고유 커밋 0) → 정본 브랜치 검증 래퍼 PASS → 939ed80e. A6 rich 기본은 코드 기반영(결재만).
- 발급: W1 패킷 7본(#1950) · 이슈 #1954~#1957(ready)·#1958~#1960(ADR 결재 후) · P1 PIPELINE.md+P2 CODEX 병합 PR #1953(승격 창까지 보류).
- 다음: 클라 PR design-review → 머지 → 승격 배치 → v0.1.4 발행(성재) → W1 발사 go. 결재 대기: ADR-0179~0182.

## 2026-09-02 (저녁) · Fable · ★ADR 4본 기안(0179~0182 Proposed) + 워커 레인 grok 4.6 개정 — G0 발사 go 대기

- 성재 "ADR 기안부터 시작 · 워커는 grok 4.6": D-7 개정(Opus 5 Agent → grok 4.6), ROADMAP·편성 정본·BT-6 브리프(개정 1: 이어받기 좌표) 반영.
- 기안: **ADR-0179** 표현 축(duration 120/180/240/500·easing 2·도착 규격·비대칭·눌림 정본·엘리베이션 이름·밀도/가상 rem·하이브리드 motion/react·reduced-motion 이중·강제 기제 5) · **ADR-0180** 기기 연결 1회용 QR 링크 토큰(교환권·TTL 120s·`oort://link`·공개 오리진 모드만 SAS·감사/해제) · **ADR-0181** 웰컴 킥오프 오프너=agent-worker `RunTrigger::Welcome`(가입 tx 트리거·멱등 키·provider-required 정적 경로·원장 귀속·120s 백스톱) · **ADR-0182** 일시 확인 3형(in-place·상태줄·지속 카드)+결정 트리+preflight `ephemeral`.
- 다음(go 후): 성재 Accept → G0(BT-6 이어받기 grok 워커 → #1922 머지·A6 상향 → 승격 → v0.1.4) → 티켓·패킷(UX-R0~R1e·DS-1·2·SH-1~3a·M0s/w/m·P1~P4) → W1.

## 2026-09-02 (오후) · Fable · ★인터뷰 전량 승인 → 출시 프로그램 편성 정본 + ROADMAP 정렬 (착수 전)

- 성재: 브리프 §8 권고 전부 승인 + 모바일 발제(QR만 찍으면 연동, iOS 전용) + 이미지 에셋(gpt/grok/OpenRouter) + "작업 말고 계획 구체화·로드맵 정렬 먼저".
- 실사: 폰 11화면·47컴포넌트, `oort://join` 프리필·키체인 세션 有, QR/카메라 0. buzz 페어링=QR→SAS→릴레이 신원 전송 → 우리는 "1회용 기기 링크 토큰"으로 번역(ADR-0180 후보).
- 정본 `2026-09-02-launch-program-plan.md`: D-1~D-13 고정, 4레인(UX-R·DS·SH·M·P) 티켓 분해, 게이트 G0~G3, ADR 큐 4본, 에셋 파이프라인, 파도 순서 W1~W6. 판정: **M0 QR 연결은 G1 창 안, M1 패리티는 G1 이후**. ROADMAP §1·§2 교체.
- 다음(go 후): ADR 4본 기안 → G0(BT-6 이어받기·결재 3건·승격·v0.1.4) → 티켓·패킷 → W1 발사.

## 2026-09-02 · Fable · ★재개 복원 + 출시 재진단·두 기둥(Buzz급 UXUI·압도적 셀프호스팅) 브리프 — 인터뷰 대기

- 복원: 루트가 8/28 브랜치 잔재 상태 → stash@{0} 보존 후 origin/main(df6bc4d3) 정렬, 트랙 워크트리 ff. 중단점=BT-6(#1934) 서버 절반 미커밋(wbt6-server), 클라 미착수.
- 탐색 4기(웹 클라 UX·셀프호스팅/배포·buzz 레퍼런스·문서/파이프라인) + 9/1 감사 합본 → `research/2026-09-02-launch-rediagnosis-two-pillars-brief.md`. 근원 5(모션 축 0·active 11곳·온보딩 절정 부재·⌘K 내비 전용·에이전트 표면 4곳 분산·금지 위주 시스템).
- 편성안: UX-R0~R6 · SH-1~9 · P1~P8, 게이트 G1/G2 재정의. 성재 인터뷰 Q1~Q11(§8) 답 대기 — 답 후 ADR-0179(모션 축)·킥오프 오프너·토스트 정책 ADR 기안 + 티켓/패킷.
- 다음: BT-6 이어받기 완주(go 신호) → 결재 3건 → 승격 → v0.1.4.

## 2026-09-01 (오후) · Fable · ★BT 파도 개막 — 인터뷰·ADR 2본 결재·BT-1 랜딩(3회전)·BT-2 PR 정지점

- 성재 지시 "우로보로스로 계획 구체화 후 작업까지, 구현=Opus 5" → 인터뷰 수렴: BT 파도 6장 2단(정본 2026-09-01-bt-wave-plan.md), ADR-0177/0178 기안→성재 실시간 결재 Accepted(PR #1936).
- BT-1(#1929): PR #1937 리뷰 3회전(B1 포털 화살표·H1 다이얼로그 자살 → 전량 마감 B0·H0·M0) → track/uxui 머지·close.
- BT-2(#1930): 워커 완주 → **PR #1938 생성 시점 성재 지시로 정지**(리뷰 미발사). 재개 절차는 스냅샷 78.
- 운영: tmux swarm 고착 복구법 실증(kill-server). 워커 레인 Opus 5 Agent 전환 완료.

## 2026-09-01 · Fable · ★정본 경량화 재편 + 3중 감사(버즈 패리티·셀프호스트·차별화) 완주

- 성재 3지시 집행: ①문서 경량화 — PR #1924 main 랜딩, 아카이브 로테이션 체계 신설(docs/archive/README.md 정본) ②버즈 패리티 감사 ③셀프호스팅 완결성+차별화 진단 — 정본 research/2026-09-01-{buzz-parity,selfhost-core,differentiator}-audit.md.
- 핵심 발견: buzz도 에이전트=멤버 스키마 구현 — 실차별은 RLS·fail-closed 승인·비용원장·A2A 게이트 넷(buzz 0건). 셀프호스트 blocker 5(웹훅 ingress·work host·공개 엣지·TURN·CSP 중 3건 신규 티켓화). 버즈 사각 14(사이드바 조직화 최대).
- 집행: #1300·#1275 close(부기, 코드 재검증)·#1895/#1274 정정 코멘트·신규 티켓 #1925~#1927. 오케스트레이터 스팟 재판정 7건 전부 일치.
- 다음: 성재 결재 — 기존 3건(액센트/승격/A6) + 감사 후속 파도 취사. 워커 레인 유휴 유지.
