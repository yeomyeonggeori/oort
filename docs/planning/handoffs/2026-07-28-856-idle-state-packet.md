# goal #856 — MOMO-648: work_session `idle` 상태 모델 + 수명주기 (ADR-0139 D1)

너는 momo 레포의 Codex worker다. 이 문서가 네 유일한 지시서다. 계약은 `AGENTS.md`.
**base = `track/engine`.** 모델: gpt-5.6-sol medium.

## 0. 착수 전 필수
1. `git status` clean 선검사. 2. 자격증명·`.env` 금지. 3. **PR 후 STOP.** 4. docker 검증기는 오케스트레이터 몫 — 명령줄만 PR에. 5. **심볼은 쓰기 전 grep으로 실재 확인.**

## 1. 결정 정본 (ADR-0139 Accepted — 바꾸지 마라)
- **도구 프로세스 종료 ≠ 세션 종료.** `status`에 `idle` 추가, `running ↔ idle` 왕복 허용.
- idle 타임아웃(기본 24h, 워크스페이스 설정) 초과 → `ended`, `end_reason='idle_timeout'`.
- `exit_code`의 의미 재정의: **마지막 도구 실행의 결과**(세션 종료 코드 아님).
- idle 중 host heartbeat 단절 → 기존 orphaned 경로 동일 적용.
- 소유자만 재부착·입력(기존 observation 규칙 재사용 — 새 권한 문법 금지).

## 2. 검증된 출발점 (오케스트레이터 확인 — 재확인하고 써라)
- 상태 CHECK 최종본: `025_work_tier_fallback.sql` — `running|orphaned|ended` + `end_reason IN ('orphaned','resumed')` + lifecycle CHECK(**`running`이면 `exit_code IS NULL`** — idle→running 재진입과 충돌한다. 풀되 근거를 마이그레이션 주석에).
- orphaned 전이: `NotifierWorker/TierFallbackSweep.swift`(stale sweep + `work.session.orphaned` 이벤트), 푸시: `NotifierService.swift:321`(resume_offer).
- REST: `WorkSessionRoutes.swift`(create/end/**resume**/list). 실시간: `work.session.started/ended` 프레임(웹 realtime.ts가 파싱).
- **주의**: #855가 이 파일들을 방금 만졌다(원장 훅). 최신 track/engine에서 시작해라.

## 3. 할 일 (커밋 분리 권장)
1. **마이그레이션 047**: status CHECK에 `idle` · `end_reason`에 `idle_timeout` · lifecycle CHECK 재구성. `schema_v0.sql` 수정 금지.
2. **전이 경로**: 호스트의 도구 종료 보고 → `running→idle`(+`exit_code` 기록) · 재기동 보고 → `idle→running`. outbox `work.session.idle`(신설)·`work.session.resumed-to-running`(이름은 기존 관례 따라 판단) + 감사. openapi 명세 동반.
3. **완료 푸시**: NotifierWorker "작업 완료 — idle 대기". **id-only 봉투(ADR-0120) 유지** — 세션 내용·도구명·exit code를 푸시에 싣지 마라.
4. **idle 타임아웃 sweep**: TierFallbackSweep 확장. 워크스페이스 설정값(기본 24h)은 settings bag에서 **이 키 하나만** 읽어라(#831 교훈 — 통째 노출 금지). idle에도 host 단절 → orphaned 우선.
5. **T3 접합 자리만**: idle 전이 지점에 프로비저너 pause 훅이 들어올 자리를 주석으로 표시(**구현은 #859** — 여기서 pause를 부르지 마라).

## 4. 검증
- `swift build`·서버 테스트 무회귀(현재 339). 격리 검증기(`verify_*` 선례, 예약 포트) 신설:
  running→idle→running 왕복 · idle 타임아웃→ended(idle_timeout) · idle 중 host 단절→orphaned · 이벤트·감사·푸시 각 1건 이상. **전이는 실제 REST/sweep 경로로** — SQL 지름길로 상태를 심어 경계를 우회하지 마라(이 레포가 5회 밟은 패턴).
- **red proof**: 타임아웃 sweep을 되돌리면 검증기 FAIL. 절차를 PR에 정확히.
- 웹은 이 티켓 범위 밖(#858). 단 `work.session.idle` 프레임 스키마를 PR 본문에 적어 웹이 소비할 계약을 고정해라.

## 5. PR
`feat/856-momo-648-idle-state` → `track/engine`. 본문: lifecycle CHECK 재구성 근거, 이벤트 스키마, sweep 우선순위(단절>타임아웃), 오케스트레이터 실행 목록, 계획 이탈. **PR 후 STOP.**
