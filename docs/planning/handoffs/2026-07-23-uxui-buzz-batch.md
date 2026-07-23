# 핸드오프 패킷 — UXUI buzz 잔여 배치 (2026-07-23, momo-main → momo UXUI 세션)

> 계보: buzz 경쟁 분석 UXUI Top5(`2026-07-22-buzz-competitive-analysis.md` §112~119) → ENGINE_HANDOFF A-21/22/23 + 기존 #602. 내부 테스트 집중 전환(`2026-07-23-internal-test-focus-plan.md` §4-2)의 UXUI 전면 배치.
> 스킬 의무: 모든 UI 변경은 `momo-design-taste` 스킬 규율(§0 Design Read 라인 출력 포함) + 완료 전 design-review 에이전트(신선 컨텍스트).

## 공통 종료조건 (모든 티켓, 전부 충족해야 done — 빡빡 기준)

1. `momo-design-taste` §5 기계 pre-flight **원문 출력 첨부**(0 hit) + 수동 체크리스트 전 항목.
2. design-review 에이전트 판정 **Blocker 0 · High 0**(High는 momo-main 이관 금지 — PR 안에서 해소).
3. macOS 전체 `swift test` 0 실패(신규 스냅샷은 기준 이미지 **기록 금지** — 오케스트레이터 환경이 기준. 테스트는 gate env var로 skip 처리 후 인계 명시).
4. 4상태(empty/loading/error/offline) 커버 + 모든 신규 액션에 키보드 경로.
5. 한국어+영어 혼합 3줄 문자열 잘림/오버플로 없음(테스트 픽스처로 증빙).
6. PR base = `track/uxui`. main 머지 금지. `clients/Core` 계약 변경 필요 시 구현하지 말고 ENGINE_HANDOFF 요청 항목으로 역등재.

## MOMO-568 (A-21) — 에이전트 작업신호 3종 세트

**스코프**: ①사이드바 채널행 working 배지+경과시간 ②컴포저 하단 "{에이전트}: {작업 헤드라인}" 회전 바 ③typing과 시각적으로 구분되는 턴 liveness 마크. **세 표면 모두 단일 `agentWorkingSignal` 모듈만 소비**(buzz 검증 패턴).
**데이터 계약(중요)**: 신규 서버 이벤트 만들지 말 것 — 이미 흐르는 `agent.status`/`agent.partial` realtime 이벤트를 1차 소스로, typing을 폴백으로 소비한다. 장기 프레즌스 계약 공백은 **ADR-0104 Proposed 기안**(제안만, 구현 금지)으로 남긴다.
**종료조건(추가)**:
- 신호 소멸 규율: run 종료/취소/실패 시 **3초 내** 모든 표면에서 신호 제거(스테일 "작업 중" 잔존 = buzz 실증 반례 — 자동화 테스트로 단정).
- 다중 에이전트 동시 실행 시 채널행/컴포저가 각각·회전 표시(2 에이전트 픽스처 테스트).
- 경과시간은 `.monospacedDigit()`+1s 갱신, `reduceMotion` 시 회전 바 정적 전환.
- 컴포저 헤드라인 회전 주기 2.2s, 헤드라인 없으면 표면 자체 미표시(빈 회전 금지).

## MOMO-569 (A-22) — managed-by 표기 (수신 게이트는 역등재)

**스코프**: 에이전트 카드/멤버 인스펙터에 "managed by {owner 표시명}" + owner 프로필 팝오버. agent_profile/명부의 기존 owner 데이터만 소비.
**명시적 비스코프**: "Who can talk"(owner-only/anyone/allowlist) **UI를 만들지 말 것** — 서버 집행 필드가 아직 없어 가짜 통제가 된다. 대신 서버 계약 제안(profile 필드+enqueue 집행 지점)을 ENGINE_HANDOFF 요청 항목으로 역등재.
**종료조건(추가)**: owner가 워크스페이스를 떠난/비활성 케이스 표기(회색 처리+사유), 카드 출신(origin=card) 에이전트는 "external runtime" 병기, 팝오버 키보드 열기 경로.

## MOMO-570 (A-23) — 빈 채널 인트로 'Create agent' = 'Add people' 동급

**스코프**: 빈 채널 온보딩 표면에서 에이전트 생성 진입을 사람 초대와 동급 배치. 기존 537 생성 폼(ADR-0131) 재사용 — 신규 폼 금지.
**종료조건(추가)**: 빈 채널 → 생성 완료 → 해당 채널 자동 초대 → 첫 멘션 가능까지 **클릭 4회 이내**(여정 테스트로 단정). 생성 실패/권한 없음(비관리자) 상태 처리 — 비관리자에게는 표면 자체를 숨기지 말고 요청 경로 안내. 스타터 에이전트 자동 생성 연출은 금지(buzz 반례 3종 — 조용한 실패·고아 에이전트·기본 크리덴셜).

## MOMO-518 (#602 기존 이슈) — diff 카드 1급 메시지 타입

**스코프**: ADR-0126 D2 `artifact_kind` 소비 — 파일경로 헤더, 400px 내부 스크롤(페이지 가로 스크롤 금지), truncation 정직 배너("N줄 중 M줄 표시"), 확대 뷰. macOS 1급 우선, 웹은 렌더 가능 최소.
**종료조건(추가)**: 1,000줄+ diff 픽스처에서 truncation 배너 수치 정확성 단정, add/remove 색은 토큰만, raw payload는 disclosure 뒤, 라이트/다크 스냅샷.

## 배치 종료조건 (전체)

- 4티켓 전부 위 기준으로 track/uxui 랜딩 + ENGINE_HANDOFF 상태 갱신(A-21/22/23 done, 요청 역등재 완료).
- 성재 실창 확인용 빌드는 **트랙 워크트리에서** `scripts/macos_dev_run.sh`(TRACKS.md §2 — 빌드 원본 고지).
- 세션 종료 시 JOURNAL 플러시(≤5줄). main 머지는 momo-main이 순차 수행.
