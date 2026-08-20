# 파도 8 핸드오프 패킷 — LIVE-5c(실기동 E2E 앵커) + #1563·#1535·#1536

> 2026-08-18 Fable 발급 · Status: `ready` · 워커: 단발 무명 Opus 5 ×4.
> planning ID: **PLN-20260815-01** · integrator: momo-main. 5c goal=**#1565**(binding 2026-08-18). 나머지=이슈 본문 1차 정본.
> 병렬 파일군: 5c=infra/cubesandbox·docs/runbooks·(검증 산출물) — **클라·서버 코드 기본 비접촉**(결함 발견=정지+이탈) · #1563=clients/web(work/controlStream — 5c와 분리, controlStream 소유는 #1563) · #1535=docs(SELF_HOST) · #1536=clients/web(채널 빈 상태 — work 밖).
> 기준: origin/track/engine 최신(fetch 후 claim `--base track/engine` 명시).

## 공통 계약
표준 절차·merge/close 금지·ADR-0132·red proof·UI goal 프리플라이트·템플릿 §5.1·docker/시뮬레이터 회수. **push 전 정렬 프리플라이트(TRACKS §3.1.1)** — 워커도 PR 열기 전 1회.

## LIVE-5c (앵커) — 실기동 E2E: 사람 입력이 실 microVM에 닿고, 에이전트는 못 본다

전제(전부 랜딩): 5a(engine `c9a390d9`~)+5b(`bc819ecc`) — controller capability·ephemeral TURN 발급 경로·datachannel 입력 포워딩·auto-return·control 내구 투영.

**미션 4조각 (momo-cube-host 101.79.18.230 실기동)**:
1. **실 입력 왕복**: 웹 controller → datachannel → producer → microVM 화면 반영(키 타이핑이 xterm/앱에 실제로 찍히는 실측 — #1438의 display E2E에 입력 축 완성). `runtime-unverified(input delivery)`·`unverified.inputChannelProtocol`(DECLARED ONLY — 5b가 남긴 pointerFrame 계약) 해소: producer가 spec대로 구현·프레임 파싱 실측.
2. **비관측 mutation 증명**: control 창 동안 에이전트 경로 실차단(work-controls 409·pending 폴 유보)을 실기동에서 mutation으로 — 차단 코드를 무력화하면 red.
3. **remint 실측**(5a 이월 AC): 스트림을 TTL 너머 유지해 실패 양상 실측 → (a) 새 자격 ICE 재협상 vs (b) TTL=세션 상한 수용+표면 서술 — 실측 근거로 택일·이탈 보고로 상신(구현은 후속).
4. **validate 실호출 개통**: 5a가 발견한 필드명 수리(`capability_token`)의 실호출 검증 — producer 서명 키 배선 확인(`unverified.serverValidateWiring` 해소).

**선행 조건 확인(착수 첫 스텝)**: `ssh root@101.79.18.230` 도달성. **불가(timeout)면 즉시 정지+이탈 보고** — momo-turn처럼 22가 운영자 IP 한정일 수 있음(그 경우 5c는 #1545와 함께 성재 손 대기 항목으로 전환, 로컬에서 가능한 준비(검증 스크립트·red proof 하네스)만 산출).
**ephemeral 릴레이 병행 실증은 범위 밖**(#1545 성재 손 — 5c는 현행 정적 TURN 경로로 실측, ephemeral 발급 경로는 서버 conformance가 기커버).

수용기준: ①입력 왕복 실측(캡처/로그 — 키→화면) ②비관측 mutation red proof ③remint 실측 보고+택일 상신 ④validate 실호출 로그 ⑤라벨 3종(input delivery·inputChannelProtocol·serverValidateWiring) 정직 갱신(해소 또는 사유 명시) ⑥런북 §8 갱신.

## #1563 — Shift+Esc keyup 좌초 (press-단위 판정)
이슈 본문 정본. controlStream.ts `dispositionForKey` — 내보낸 keydown 미결 동안 keyup은 press 판정 승계. red proof(Shift 선해제 순서)+게이트 시나리오.

## #1535 — SELF_HOST.md §4 현행화
이슈 본문 정본(#1526 F3/F4). 화면 실물 기준 재작성+A4 드리프트 게이트 무회귀.

## #1536 — 빈 채널 첫 행동
이슈 본문 정본(#1526 F5). '첫 메시지 쓰기' 어포던스 — States 규율·빈 상태 문법·캡처·프리플라이트. design-review는 오케스트레이터.

## 컨텍스트 델타
- 새로 고정: 실기동 goal의 SSH 선확인·불가 시 정지 규칙 · 5c의 ephemeral 병행은 #1545 종속 명시.
- 의도적 미결정: remint 택일(5c 실측 근거로 상신).
