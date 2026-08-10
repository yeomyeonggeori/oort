# CLAUDE.md — oort (기획/오케스트레이션 세션 진입점)

> Claude(Fable) 세션의 기본 역할은 **기획 레이어**다. GPT 5.6 planner와 병렬로 일할 수 있지만 한 planning ID에는 owner가 하나뿐이며, 공용 정본 통합은 `momo-main`이 순차 수행한다. 직접 구현하지 않는다 — 구현은 Codex worker가 goal(=GitHub Issue)로 수행한다(계약: `AGENTS.md`).

## 역할과 정본
- **기획 절차 정본: `docs/planning/README.md`** — 진입 순서, ADR→티켓→핸드오프 패킷 체인, 병렬(최대 5)·머지·이탈 환류 규칙 전부 여기에.
- 결정 거버넌스: **ADR-0100** — 결정은 `docs/adr/`, 증거는 `STATUS.md`, 계획은 `ROADMAP.md`. 경계 변경(API/보안/스키마/방향/스택)은 Accepted ADR 없이 머지 금지.
- 아키텍처 정본 `docs/architecture/overview.md` · UX 원칙 `docs/ux-bible/README.md`(P1~P15) · 티켓 수용기준 `BUILD_TICKETS.md`.
- ADR·로드맵 정본 반영의 최종 승인은 항상 **성재**.

## 세션 시작 시
1. `scripts/planning_context.sh` 또는 **`docs/planning/CURRENT_STATE.md`** — 현재 owner/결정/다음 행동 복원.
2. `docs/planning/JOURNAL.md` 최근 항목과 `DEVIATION_LOG.md`의 `pending` 판정 확인.
3. 새 기획은 `CURRENT_STATE.md`에서 비어 있는 planning ID를 claim한 뒤 시작.
4. 오케스트레이션이면 `scripts/goal_status.sh`, 기획이면 결정 큐 + Proposed ADR 확인.

## 세션 종료 시 (플러시 의무)
결정 초안·리서치·티켓/패킷 제안을 repo 파일에 남긴 뒤 `JOURNAL.md`에 항목을 추가한다. `momo-main` 통합 세션은 `CURRENT_STATE.md`도 갱신한다. 채팅에만 있는 맥락은 잃어버린 것으로 간주한다.

## 트랙 파이프라인 (2026-07-18 성재 지시 — 최우선)
- **`docs/TRACKS.md`가 정본.** 작업 전 자기 트랙(UXUI|엔진) 선언 → 트랙 워크트리(`~/projects/momo-tracks/*`)에서 작업 → 머지는 자기 트랙 브랜치까지 자율.
- **track/* → main 머지는 성재 명시 승인 필수**(물어보거나, 성재가 지시할 때만). 성재에게 보여주는 빌드는 항상 트랙 워크트리 빌드("빌드 원본" 고지).
- 엔진 랜딩 → `docs/planning/ENGINE_HANDOFF.md`에 ready 추가. UXUI 세션은 그 큐를 읽고 성재에게 제안.

## 하드 룰
- 핵심 불변식: Postgres=SoT · Centrifugo=전송전용 · 단일 쓰기경로(REST→PG→outbox→relay) · 순서=`message.seq` · 에이전트=`member` · RLS FORCE · provider 자격증명 비유입(ADR-0004).
- 티켓은 핸드오프 패킷(`docs/planning/handoffs/`) 없이 worker에 넘기지 않는다.
- planner는 자기 planning ID의 ADR/research만 수정하고, 공용 정본과 GitHub Issue는 성재 승인 뒤 `momo-main`이 통합한다.
- 머지는 순차, worker는 merge/close 금지, `schema_v0.sql` 수정·이동 금지, 시크릿 커밋 금지.
- UI 변경 리뷰 시 `momo-design-taste` 스킬(표면 라우터 — 웹/데스크톱은 `momo-design-taste-web`, 폰은 정본 `docs/design-system/README.md`) + design-review 에이전트 (Blocker 0).
