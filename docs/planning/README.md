# oort 기획 운영 계약 (Planning Layer Contract)

> 생성: 2026-07-10 · 정본 등급: **기획 레이어 운영 정본** (구현 계약은 `AGENTS.md`, 결정 거버넌스는 ADR-0100)
> **이 문서 하나만 읽으면 어떤 기획 세션(Fable, GPT 5.6, 사람)이든 oort에서 기획을 시작할 수 있다.**

## 0. 역할 4분할

| 레이어 | 주체 | 하는 일 | 하지 않는 일 |
|---|---|---|---|
| **제품 오너** | 성재 | ADR Accept/Reject, 로드맵 정본 반영 승인, 우선순위 최종 결정 | 구현 세부를 채팅 안에서만 확정 |
| **기획 (planning)** | Fable **및/또는** GPT 5.6 | 서로 다른 planning ID를 병렬 claim → 리서치 → ADR 기안 → 티켓/핸드오프 제안 → 이탈 판정 제안 | 직접 구현, 승인 전 공용 정본/Issue 발급 |
| **통합·오케스트레이터 (momo-main)** | GPT 5.6 또는 Fable 중 현재 main 담당 | 병렬 기획 결과 **순차 통합** → 상태판 → 코드리뷰 → 순차 머지 → 이탈 추출·리서치 → 기획 보고 | 제품 오너 대신 ADR 승인, 여러 planner 결과를 무검토 병합 |
| **구현 (worker)** | Codex worker, 최대 **5 동시** | goal(=GitHub Issue) claim → worktree 구현 → 게이트 → PR + 이탈 보고 → handoff 후 정지 | merge, 이슈 close, 로드맵/백로그 조정 |

승인 권한: **ADR Accepted와 로드맵 정본 반영은 항상 성재가 최종 승인**한다. Fable/GPT 5.6은 동등한 planner이며, `momo-main`이 유일한 sync/integration authority다.

한 세션이 planner와 `momo-main`을 겸임할 수는 있지만, 각 change set에서 어느 역할로 행동하는지 `JOURNAL.md`에 적는다. 병렬 planner 산출물을 통합할 때는 자기 초안도 다른 planner 초안과 동일하게 리뷰한다.

## 1. 기획 세션 진입/종료 절차 (누가 와도 동일 — Fable ↔ GPT 5.6 싱크 장치)

**진입:**
1. `scripts/planning_context.sh` 또는 **`docs/planning/CURRENT_STATE.md`** — 현재 결정, 활성 planning owner, 구현 handoff, dirty-tree 위험을 복원한다. GitHub Issue/PR/worktree 실시간 보드까지 필요하면 `scripts/planning_context.sh --github`를 쓴다.
2. `docs/planning/JOURNAL.md` 최근 항목 — 직전 세션의 변경 이력을 확인한다. 현재 상태와 충돌하면 `CURRENT_STATE.md`가 우선하고 `momo-main`에 drift를 보고한다.
3. `CLAUDE.md`(또는 이 문서) → `docs/adr/` 스캔(특히 0100, 0101 + **Proposed 상태 ADR = 결정 대기 중인 것**) → `docs/architecture/overview.md` → `docs/ux-bible/README.md` → `ROADMAP.md` → `STATUS.md` 최신 섹션.
4. `docs/planning/DEVIATION_LOG.md`의 **pending 이탈**부터 처리 — 이탈 판정이 차기 티켓보다 우선.
5. 오케스트레이션 겸임이면 `scripts/goal_status.sh` 상태판.
6. 다음 주제를 시작하기 전에 `CURRENT_STATE.md` 활성 기획 레인에서 planning ID와 owner를 claim한다.

**종료(플러시 의무):** 세션에서 만든 결정 초안·리서치·티켓 제안·패킷 제안을 repo 파일에 기록하고, `JOURNAL.md` 상단에 항목(한 일 / 열린 것 / 다음, 5줄 이내)을 추가한다. `momo-main`은 통합 시 `CURRENT_STATE.md`까지 갱신한다. **채팅에만 존재하는 맥락은 잃어버린 것으로 간주한다.**

### 1.1 병렬 기획 동기화

- 병렬 단위는 `ADR-01NN` 또는 `PLN-YYYYMMDD-NN`이며 **한 ID = 한 planner owner**다.
- planner는 자기 ID의 ADR/research/proposal만 수정한다. 공용 정본(`ROADMAP.md`, `BUILD_TICKETS.md`, `STATUS.md`, GitHub Issue)은 건드리지 않는다.
- `momo-main`은 제품 오너 승인 뒤 planner 산출물을 한 번에 하나씩 검토·통합한다. 통합 중 충돌하면 최신 채팅이 아니라 Accepted ADR과 코드 사실을 기준으로 판정한다.
- 같은 주제의 대안 기획이 필요하면 두 번째 planner가 원안을 덮지 않고 ADR의 Review Notes 또는 별도 research 문서로 반론을 제출한다.
- 경계 변경은 `Accepted ADR + BUILD_TICKETS 계약 + ready handoff packet + GitHub Issue`가 모두 맞을 때만 구현 가능하다. ADR이 필요 없는 통상 구현은 handoff에 `ADR not required` 근거를 기록한다.

## 2. 기획 산출물 체인 (이 순서 밖의 산출물은 정본이 아니다)

```
리서치/감사  →  ADR Proposed  →  성재 승인  →  ADR Accepted
                                              ↓
                   BUILD_TICKETS 계약  →  ready 핸드오프 패킷  →  GitHub Issue binding  →  worker 착수
                       └ ①                    └ ②                  └ ③
```

### ① 빌드 계약 등록 — BUILD_TICKETS.md (수용기준 정본)
- 다음 가용 번호 확인: `grep -o 'MOMO-[0-9]*' BUILD_TICKETS.md STATUS.md | sort -t- -k2 -n | tail -1` → +1부터 사용.
- STEPS 표에 행 추가(`| id | 한줄 | 등급 | 의존 |`) + 파일 하단에 `### MOMO-NNN 수용기준` 섹션(체크박스, 검증 등급 `[swift]/[python]/[runtime]/...` 명시). ADR 파생 티켓은 제목에 ADR 번호를 단다.

### ② 핸드오프 패킷 — `docs/planning/handoffs/YYYY-MM-DD-<slug>.md`
- 템플릿: `docs/planning/HANDOFF_TEMPLATE.md`. **기획 맥락이 채팅 밖(레포 안)에 전부 존재하게 만드는 장치** — worker에게 보내는 채팅 메시지는 3줄이면 충분해야 한다.
- 패킷은 `status`, `planning_id`, `base_commit`, `supersedes`를 가진다. Issue 발급 전 `ready`로 고정하고, 계약 변경 시 기존 패킷을 조용히 고치지 말고 새 패킷으로 supersede한다.
- `ready` 시점에는 MOMO ID만 있으면 된다. GitHub Issue 번호는 발급 후 metadata-only binding으로 추가할 수 있으며, 이는 계약 변경으로 보지 않는다.
- 패킷 없이 이슈만 던지는 것 금지(맥락 누락의 주 원인).

### ③ 티켓 발급 — GitHub Issue (goal 실행 계약)
- 1 티켓 = 1 이슈. 본문은 `## Goal / ## Context / ## Acceptance / ## Out of scope` (AGENTS.md §1 계약).
- **Context에 ready 핸드오프 패킷 경로와 기준 커밋을 반드시 링크**한다. Acceptance는 BUILD_TICKETS.md 수용기준을 복사하지 말고 링크(정본 이중화 금지).
- 패킷과 BUILD_TICKETS가 canonical branch에서 읽히는 상태인지 확인한 뒤 Issue를 만든다. 생성 후 패킷의 GitHub binding만 갱신한다.
- 라벨: 의존이 모두 끝났을 때만 `status:ready` + 레인 라벨. 선행 의존이 남으면 `status:blocked`로 발급한다.
- worker가 claim한 뒤 패킷 계약을 바꿔야 하면 해당 goal을 중지시키고 패킷 supersede + Issue 갱신 후 재개한다.

### 구현 세션 시작 프롬프트 (복사본은 짧게)

```text
Use repo /Users/kwakseongjae/projects/momo and follow AGENTS.md.
Read <ready handoff packet path>@<base commit>, then claim GitHub issue #<number>; the issue + packet are the full contract.
Work in its own worktree, run the required local gate, open one PR, move it to status:needs-review, hand it back to momo-main, and do not merge.
```

목표/수용기준을 채팅에 다시 복사하지 않는다. 구현 중 컨텍스트 압축이 일어나도 worker는 Issue와 versioned packet을 다시 읽어 같은 계약으로 복원한다.

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
| 지금 어디까지 왔나 | `docs/planning/CURRENT_STATE.md` |
| 세션 이력은 무엇인가 | `docs/planning/JOURNAL.md` |
