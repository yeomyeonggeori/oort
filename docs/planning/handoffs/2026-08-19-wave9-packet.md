# 파도 9 핸드오프 패킷 — 게이트 가드 일반화·base 위생·라벨 이중 의미·remint 반영

> 2026-08-19 Fable 발급 · Status: `ready` · 워커: 단발 무명 Opus 5 ×4.
> planning ID: **PLN-20260815-01** · integrator: momo-main. 전건 이슈 본문 1차 정본(#1571·#1572·#1573·#1574 — 파도 8 폐곡선 발견의 후속).
> 기준: origin/track/engine 최신(**승격 후** — main=e322ccf3의 sync 합류 88477fcc 이후. fetch 후 claim `--base track/engine` 명시).
> 병렬 파일군: #1571=clients/web/gates(구조·공용 모듈 소유) · #1572=docs/api/openapi.yaml+scripts/bench_onboarding.sh · #1573=packages/momo-core+clients/web/src(+gate-composer.mjs 내 **라벨 문자열/단정 줄만** — gates 구조 변경 금지, 구조는 #1571 소유) · #1574=server-rust momo-t3+docs/runbooks+STATUS.md remint 절.

## 공통 계약
표준 절차·merge/close 금지·ADR-0132·red proof·UI goal 프리플라이트·템플릿 §5.1·docker/시뮬레이터 회수. **push 전 정렬 프리플라이트(TRACKS §3.1.1)** — PR 열기 전 1회.

## #1571 — 게이트 포트-스쿼트 가드 일반화 (이슈 본문 정본)
선례=gate-display-control.mjs의 8줄 가드(PR #1569). 공용 모듈로 추출해 전 레인 적용. grok M1(300ms 고정 검출 창 — fail-open) 동반 해소: 고정 sleep이 아니라 결정적 신호(listen PID 확인 또는 stdio의 EADDRINUSE 파싱). grok L3(사인 무구분 진단 문구) 동반. red proof=실제 점유자 대상 요란한 FAIL 재현.

## #1572 — base 위생 마이크로 2건 (이슈 본문 정본)
① openapi.yaml:7187 enum flow scalar 인용(YAML 1.1 Psych 거부 — verify_openapi_contract.sh base red 해소) ② bench_onboarding.sh:557 주석을 현행 SELF_HOST §4 문면으로. A4 게이트(392 facts) 무회귀.

## #1573 — 「멤버 초대하기」 이중 의미 해소 (이슈 본문 정본)
한 동사=한 행위. 코어 상수(EMPTY_INVITE_ACTION_LABEL)에서 시작 — 채널 범위=「추가」 계열 또는 워크스페이스 초대 쪽 개명, 첫 실행 경로(빈 채널→다이얼로그 빈 상태)에서 같은 라벨 2회 노출 소멸을 캡처로 증명. design-review는 오케스트레이터 몫. **주의**: gate-composer.mjs는 라벨 관련 줄만 접촉(#1571이 gates 구조 소유 — 충돌 시 정지+이탈 보고).

## #1574 — remint 실측 반영 (이슈 본문 정본)
LIVE-5c 실측(PR #1570)이 TTL 세션 천장을 반증 — coturn은 ALLOCATE 시만 만료 검사. 택일 (b) 채택(성재 전권 위임 집행). 반증된 서술 전수 정정(turn.rs 주석·runbook·STATUS) + 잔여 케이스(mid-session re-ALLOCATE=ICE restart 시 remint 훅 필요) 기록. 구현 없음 — 서술 정정만. grep 증명 동봉.

## 컨텍스트 델타
- **engine→main 승격 완료(2026-08-19)**: main=e322ccf3(107커밋)·sync #1577/#1578·topology 복원(alignment PASS). 워커 base 사고 클래스의 뿌리 해소 — 그래도 claim은 `--base track/engine` 명시 유지.
- 파도 8 종결: LIVE-5 전 축 종결(engine=d987ff58 계열). 5c 잔여 1=`unverified.inputDeliveryInMicroVM`(성재 손 — momo-server 배치 대기, 이 파도 범위 밖).
- 의도적 미결정: #1573의 개명 방향(채널측 vs 워크스페이스측) — 워커가 화면 실물·용어 일관성 근거로 택일하고 이탈 보고로 상신.
