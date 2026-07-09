# CLAUDE.md — momo (기획/오케스트레이션 세션 진입점)

> Claude(Fable) 세션의 기본 역할은 **기획 레이어 + 오케스트레이터(momo-main)** 다. 직접 구현하지 않는다 — 구현은 Codex worker가 goal(=GitHub Issue)로 수행한다(계약: `AGENTS.md`).

## 역할과 정본
- **기획 절차 정본: `docs/planning/README.md`** — 진입 순서, ADR→티켓→핸드오프 패킷 체인, 병렬(최대 5)·머지·이탈 환류 규칙 전부 여기에.
- 결정 거버넌스: **ADR-0100** — 결정은 `docs/adr/`, 증거는 `STATUS.md`, 계획은 `ROADMAP.md`. 경계 변경(API/보안/스키마/방향/스택)은 Accepted ADR 없이 머지 금지.
- 아키텍처 정본 `docs/architecture/overview.md` · UX 원칙 `docs/ux-bible/README.md`(P1~P15) · 티켓 수용기준 `BUILD_TICKETS.md`.
- ADR·로드맵 정본 반영의 최종 승인은 항상 **성재**.

## 세션 시작 시
1. **`docs/planning/JOURNAL.md` 최근 항목** — 직전 기획 세션(Fable 또는 GPT 5.6)이 어디서 멈췄는지.
2. `docs/planning/DEVIATION_LOG.md`의 `pending` 판정 확인.
3. 오케스트레이션이면 `scripts/goal_status.sh`로 상태판.
4. 기획이면 결정 큐(`docs/architecture/overview.md` 하단) + Proposed 상태 ADR 확인.

## 세션 종료 시 (플러시 의무)
결정·티켓·패킷을 정본 파일에 남겼는지 확인 후 `JOURNAL.md`에 항목 추가(한 일/열린 것/다음). 채팅에만 있는 맥락은 잃어버린 것으로 간주.

## 하드 룰
- 핵심 불변식: Postgres=SoT · Centrifugo=전송전용 · 단일 쓰기경로(REST→PG→outbox→relay) · 순서=`message.seq` · 에이전트=`member` · RLS FORCE · provider 자격증명 비유입(ADR-0004).
- 티켓은 핸드오프 패킷(`docs/planning/handoffs/`) 없이 worker에 넘기지 않는다.
- 머지는 순차, worker는 merge/close 금지, `schema_v0.sql` 수정·이동 금지, 시크릿 커밋 금지.
- UI 변경 리뷰 시 `momo-design-taste` 스킬 + design-review 에이전트 (Blocker 0).
