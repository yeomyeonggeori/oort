# momo 기획 운영 계약 (Planning Layer Contract)

> 생성: 2026-07-10 · 정본 등급: **기획 레이어 운영 정본** (구현 계약은 `AGENTS.md`, 결정 거버넌스는 ADR-0100)
> **이 문서 하나만 읽으면 어떤 기획 세션(Fable, GPT 5.6, 사람)이든 momo에서 기획을 시작할 수 있다.**

## 0. 역할 3분할

| 레이어 | 주체 | 하는 일 | 하지 않는 일 |
|---|---|---|---|
| **기획 (planning)** | 성재 + Fable **또는** GPT 5.6 | 리서치 → ADR 기안 → 티켓 발급 → 핸드오프 패킷 작성 → 이탈 판정·로드맵 반영 결정 | 직접 구현 (핫픽스도 오케스트레이터에 위임) |
| **오케스트레이터 (momo-main)** | Fable 세션 (또는 성재) | 상태판 확인 → 코드리뷰 → **순차 머지** → 이탈 추출·리서치 → 기획 보고 | ADR 승인, 로드맵 정본 변경 (기획 레이어 몫) |
| **구현 (worker)** | Codex GPT 5.6 sol, 최대 **5 동시** | goal(=GitHub Issue) claim → worktree 구현 → 게이트 → PR + 이탈 보고 → handoff 후 정지 | merge, 이슈 close, 로드맵/백로그 조정 |

승인 권한: **ADR Accepted와 로드맵 정본 반영은 항상 성재가 최종 승인**한다. Fable/GPT 5.6은 기안·권고까지.

## 1. 기획 세션 진입/종료 절차 (누가 와도 동일 — Fable ↔ GPT 5.6 싱크 장치)

**진입:**
1. **`docs/planning/JOURNAL.md` 최근 항목부터** — 직전 기획 세션이 뭘 하다 어디서 멈췄는지. 이것이 세션 간 이어달리기의 1차 소스다.
2. `CLAUDE.md`(또는 이 문서) → `docs/adr/` 스캔(특히 0100, 0101 + **Proposed 상태 ADR = 결정 대기 중인 것**) → `docs/architecture/overview.md` → `docs/ux-bible/README.md` → `ROADMAP.md` → `STATUS.md` 최신 섹션.
3. `docs/planning/DEVIATION_LOG.md`의 **pending 이탈**부터 처리 — 이탈 판정이 차기 티켓보다 우선.
4. 오케스트레이션 겸임이면 `scripts/goal_status.sh` 상태판.
5. 그 다음 결정 큐(`docs/architecture/overview.md` 하단)에서 다음 ADR을 고르거나, 성재의 새 요구를 ADR/티켓으로 변환.

**종료(플러시 의무):** 세션에서 만든 모든 결정·티켓·패킷을 정본 파일에 기록했는지 확인하고, `JOURNAL.md` 상단에 항목(한 일 / 열린 것 / 다음, 5줄 이내)을 추가한다. **채팅에만 존재하는 맥락은 잃어버린 것으로 간주한다** — 이 규칙이 Fable과 GPT 5.6이 같은 상태를 보게 만드는 유일한 방법이다.

## 2. 기획 산출물 체인 (이 순서 밖의 산출물은 정본이 아니다)

```
리서치/감사  →  ADR (Proposed → 성재 승인 → Accepted)  →  티켓 발급  →  핸드오프 패킷  →  worker 착수
                └ docs/adr/01NN-*.md                      └ ①+②           └ ③
```

### ① 티켓 발급 — BUILD_TICKETS.md (수용기준 정본)
- 다음 가용 번호 확인: `grep -o 'MOMO-[0-9]*' BUILD_TICKETS.md STATUS.md | sort -t- -k2 -n | tail -1` → +1부터 사용.
- STEPS 표에 행 추가(`| id | 한줄 | 등급 | 의존 |`) + 파일 하단에 `### MOMO-NNN 수용기준` 섹션(체크박스, 검증 등급 `[swift]/[python]/[runtime]/...` 명시). ADR 파생 티켓은 제목에 ADR 번호를 단다.

### ② 티켓 발급 — GitHub Issue (goal 정본)
- 1 티켓 = 1 이슈. 본문은 `## Goal / ## Context / ## Acceptance / ## Out of scope` (AGENTS.md §1 계약).
- **Context에 핸드오프 패킷 경로를 반드시 링크**한다. Acceptance는 BUILD_TICKETS.md 수용기준을 복사하지 말고 링크(정본 이중화 금지).
- 라벨: `status:ready` + 레인 라벨. 착수 가능 상태가 아니면 `status:blocked`로 발급.

### ③ 핸드오프 패킷 — `docs/planning/handoffs/YYYY-MM-DD-<slug>.md`
- 템플릿: `docs/planning/HANDOFF_TEMPLATE.md`. **기획 맥락이 채팅 밖(레포 안)에 전부 존재하게 만드는 장치** — worker에게 보내는 채팅 메시지는 3줄이면 충분해야 한다.
- 패킷 없이 이슈만 던지는 것 금지(맥락 누락의 주 원인).

## 3. 병렬 실행 규칙

- 동시 구현 **최대 5 goal**. 초과분은 `status:ready`로 대기.
- 레인 분리·충돌 회피·worktree 절차는 `docs/MULTI_SESSION_OPS.md` §0/§4가 정본. 같은 파일군을 만지는 goal 2개를 동시에 풀지 않는다 — 의존 순서대로 발급.
- 병렬 배치를 풀 때 기획은 **머지 순서(의존 그래프)** 를 패킷에 명시한다.

## 4. 오케스트레이션 사이클 (momo-main 루프)

```
scripts/goal_status.sh
   → needs-review PR마다: 코드리뷰(보안·정합·스코프·테스트 정직성)
   → 수정 필요 시 worker에 반환 (같은 이슈 worktree)
   → PASS → 의존 순서대로 "한 번에 하나씩" 머지 + main 게이트 재실행
   → PR "계획 이탈" 섹션 수집 → DEVIATION_LOG.md에 기록
   → 이탈이 설계 질문이면: 추가 리서치 수행 → 로그에 분석 첨부
   → 기획 레이어 보고 (세션 종료 요약 또는 다음 기획 세션의 §1-2에서 픽업)
```

- 머지는 **순차**(병렬 머지 금지). 머지 후 다른 열린 PR이 stale해지면 worker에게 rebase 요청.
- 상세 리뷰·머지 체크리스트: `docs/MULTI_SESSION_OPS.md` §7.

## 5. 이탈 환류 (deviation feedback loop)

**이탈(deviation)** = 구현이 티켓 수용기준·ADR·아키텍처 정본과 다르게 된 모든 것 (스코프 축소, 우회 구현, 발견된 설계 결함, 예상 밖 의존성 포함).

1. **worker**: PR 본문 `## 계획 이탈` 섹션에 정직하게 기록 (없으면 "없음").
2. **오케스트레이터**: 머지 시점에 `docs/planning/DEVIATION_LOG.md`에 항목 추가(상태 `pending`), 필요시 리서치 첨부.
3. **기획 레이어**: 다음 세션에서 pending 항목 판정 —
   - `accepted`: 정본(ROADMAP/ADR/architecture)에 반영 + 필요시 후속 티켓 발급
   - `rejected`: 원상 복구 티켓 발급
   - `noted`: 기록만 (정본 영향 없음)
4. 로드맵 정본 변경은 성재 승인 후에만. 판정 결과는 로그의 상태 컬럼에 남긴다.

## 6. 문서 권위 지도 (ADR-0100 삼분법)

| 질문 | 정본 |
|---|---|
| 왜 이렇게 결정했나 | `docs/adr/` |
| 지금 아키텍처가 어떻게 생겼나 | `docs/architecture/overview.md` |
| UX는 어떤 원칙을 따르나 | `docs/ux-bible/README.md` (P1~P15) |
| 무엇을 언제 하나 | `ROADMAP.md` |
| 티켓 수용기준 | `BUILD_TICKETS.md` + GitHub Issue |
| 무엇이 검증됐나 | `STATUS.md` (증거 전용) |
| 구현은 어떻게 하나 | `AGENTS.md` (worker 계약) |
| 병렬 운영은 어떻게 하나 | `docs/MULTI_SESSION_OPS.md` |
| 기획은 어떻게 하나 | 이 문서 |
