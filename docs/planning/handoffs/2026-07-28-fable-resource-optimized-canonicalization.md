# HANDOFF: Fable 산출물 통합 검수 · 리소스 최적화 · 정본화

> Status: `review-ready` — planner/integrator 검수 패킷이며 worker 구현 계약이 아니다
> Planning ID: `PLN-20260728-02` · Author: GPT 5.6 (`momo-main`) · Reviewer: Fable · Approver: 성재
> 발급: 2026-07-28 · 기준 main: `177002dc30c3c320d0357d746d98d01b368072a3`
> Supersedes: `docs/planning/handoffs/2026-07-28-fable-agent-platform-redteam-review.md`
> Preserves: `2026-07-28-875-signing-packet.md`, `2026-07-28-t3-repair-packet.md`와 각 구현 증거
> GitHub binding: 없음 · ROADMAP/BUILD_TICKETS/STATUS/Issue/track→main 변경 권한: 없음

이 패킷의 목적은 Fable이 남긴 최신 구현 사실과 독립 레드팀 결과를 한 번 더 합쳐, 이미 끝난 일을 재계획하지 않고 남은 작업만 성재 승인 가능한 정본 후보로 만드는 것이다. 구현 패킷을 조용히 고치지 않으며, 승인 전 공용 정본을 변경하지 않는다.

## 1. 현재 사실

| 항목 | 확인된 상태 | 정본화 처리 |
|---|---|---|
| #860 Agent Hub | `track/uxui` 랜딩, design-review 2R PASS | 완료 후보. 재발급·재구현 금지 |
| #875 WorkHost signature v2 | `origin/track/engine`의 `ac258c8e`, body digest + one-use request ID, red proof와 서명 경로 8종 PASS | 독립 레드팀의 WorkHost finding은 **해결됨**으로 닫되 릴리스 동시 절단 조건 보존 |
| #876+#877+#878 | `feat/876-t3-lifecycle-settlement`가 `origin/track/engine@ac258c8e` 위에서 clean/pushed, `13da3fce`+`52245a95`; 23파일, +1300/-171 | 유일한 active implementation. 새 worker 금지 |
| #879 | interval floor + replay queue bound | active 배치가 흡수했는지 먼저 diff dedupe. 잔여만 실행 |
| #870 | restart reconciliation | active 배치가 `CloudLifecycleReconciler`를 신설했으므로 중복 가능성이 높음. 별도 착수 금지 |
| #869 | WSS attach adapter | correctness 수리와 비중복인 기능 완결 후보. 수리·dedupe 뒤 |
| terminal privacy | `observation=open`과 raw local output retention에 대한 독립 레드팀 finding | #857 기능 노출/main sync 전 성재 결정 필요 |
| plugin delegated subject | caller-chosen delegated subject finding | plugin read dogfood를 열 때까지 blocker로 보존. 현재 T3 배치에는 비차단 |
| #837 RN physical-device gate | 사람/실기기 의존 | 엔진 heavy gate와 병렬 실행하지 않는 별도 manual lane |

확인 한계:

- 로컬 `track/engine`은 `af931652`로 stale이고 `origin/track/engine`은 `ac258c8e`다. active branch는 후자를 올바른 base로 사용한다. 로컬 트랙 포인터를 검수 중 임의 이동하지 않는다.
- GitHub API는 이번 세션에서 네트워크 제한으로 조회하지 못했다. Issue/PR label, milestone, closure 상태는 Fable이 원격에서 재확인한다.
- 2026-07-28 16:19 KST load average는 `5.15 / 10.21 / 11.02`였다. Docker socket은 이 세션에서 접근 불가라 active stack 수는 확인하지 못했다.

## 2. 독립 판정

### 2.1 그대로 유지

- Fable의 #875 서명 v2 수리와 즉시 v1 절단 판단.
- #876~#878을 같은 worktree에서 구현해 파일 충돌과 중복 게이트를 줄인 기술적 판단.
- T3 리허설은 topup REST와 수명주기 수리가 끝난 뒤 수행.
- 새 plugin v2, skill recorder/store, generic cron, MCP Apps, Ghostty/Herdr 교체를 지금 열지 않는 판단.

### 2.2 머지 전 반드시 정상화

현재 패킷은 세 Issue를 한 PR로 묶지만 `AGENTS.md`는 **1 Issue = 1 goal = 1 PR**을 요구한다. 성재가 “수리 순서/묶음”을 승인한 기록만으로 PR 거버넌스 예외까지 승인됐다고 간주하지 않는다.

리소스 최적 권고:

1. 1,300줄을 기계적으로 세 브랜치로 다시 쪼개지 않는다. 같은 상태기계·마이그레이션·reconciler를 세 번 충돌시킬 가능성이 더 크다.
2. 머지 전 성재에게 아래 둘 중 하나를 명시 승인받는다.
   - **권고 A:** #876을 umbrella integration goal로 정규화하고 #877/#878은 absorbed decision/acceptance reference로 남긴다. PR은 #876 하나만 닫는다.
   - **대안 B:** 이번 한 번만 3-Issue/1-PR 예외를 승인하고 PR `## 계획 이탈`과 `DEVIATION_LOG.md`에 근거를 남긴다.
3. 승인 없이 세 Issue를 한 PR로 close/merge하지 않는다.

### 2.3 중복 제거가 구현보다 먼저

- #870은 새 `CloudLifecycleReconciler`가 restart/provider/provisioning 수렴까지 어디까지 담당하는지 acceptance matrix로 대조한다. 전부 흡수됐으면 close 후보, 일부만 남으면 범위를 work-session reconnect recovery로 좁힌다.
- #879는 “interval floor”와 “unbounded replay queue”를 각각 대조한다. 둘은 다른 장애·파일군이므로 둘 다 남으면 한 Issue에 억지로 유지하지 말고 별도 goal 후보로 재기안한다.
- #869는 중복 제거 뒤에도 남는 실 WSS 왕복 조각만 구현한다.

## 3. 리소스 운영 정본 후보

### WIP

- active code worker: **1** — 현재 #876 배치만.
- planner/integrator: **1 light session** — 문서, diff, 코드리뷰만.
- Docker/runtime-heavy: 호스트 전체 **동시 1개**.
- RN 실기기, T3 실 E2B, full release build는 같은 시간대에 겹치지 않는다.
- 새 dependency·보안 도구 설치는 하지 않는다. 이미 도입한 `adversarial-review`를 통합 경계에서 한 번 사용한다.

### 실행 순서

| 단계 | 작업 | 부하 | 종료 조건 |
|---|---|---:|---|
| R0 | #876 branch의 계약·상태기계·migration·reconciler 정적 리뷰 | light | Blocker/High 목록과 계획 이탈 확정 |
| R1 | 3-Issue/1-PR 거버넌스 정상화 | light/manual | 성재의 A/B 명시 승인 |
| R2 | build/unit/targeted verifier를 비-Docker부터 순차 실행 | medium | 실패 0, red proof가 이름 있는 실패 |
| R3 | load·Docker stack 확인 후 기존 8종+T3 확장 gate를 **한 번의 heavy window**로 실행 | heavy 1 | stack down 포함 evidence |
| R4 | `adversarial-review --base origin/main`을 수정 통합 branch에 1회 실행 | light~medium | 교차 Blocker/High 0 또는 명시 반려 |
| R5 | #879/#870 acceptance dedupe, 남은 최소 goal만 제안 | light | absorbed/residual 표 |
| R6 | residual correctness(#879/#870) → WSS 완결(#869) 순서 | goal별 | 각 1 Issue=1 PR |
| R7 | terminal privacy 결정과 engine/uxui 동시 main sync | manual+gate | 성재 승인, 순차 merge, main gate |
| R8 | topup REST 기반 T3 리허설 | heavy/manual | E2B template+public server evidence |

R0~R4가 끝나기 전에 R5의 residual worker를 spawn하지 않는다. R3 중 다른 momo/타 프로젝트 heavy stack이 있거나 load(1m)>12면 실행하지 않는다. 8~12면 heavy 하나만 허용한다. 성공·실패·중단 모두 compose stack을 내린다.

## 4. 보안·UX·과설계 merge gate

### Security

- terminal 기본 관전 권한과 raw output retention을 성재가 명시적으로 결정하기 전 #857을 “공유 관전 안전”으로 표기하지 않는다.
- #875의 canonical body digest, request ID replay barrier, expiry cleanup, v1/v2 불일치 401을 회귀 게이트에 유지한다.
- T3 settlement는 interval close, credit debit, slot release가 한 트랜잭션에서 멱등이고 provider destroy는 재시도 가능한 외부 단계여야 한다.
- topup은 instance operator 전용, 양수, idempotency ref, audit, RLS 경계를 증명한다.

### UX

- resume은 paused sandbox 안의 workd 보고에 의존하지 않아야 한다. 사용자의 resume 요청은 durable intent가 되고, 실패/수렴 중 상태를 거짓 running으로 보여주지 않는다.
- terminal privacy를 고친다는 이유로 PTY 출력 fidelity를 불완전한 redaction으로 훼손하지 않는다. 권고 기본은 owner-only + bounded/ephemeral local ring + end/timeout/manual clear다.
- #869 실왕복 전에는 “기기 간 터미널 연속성 완성”이라고 표현하지 않는다.

### Over-engineering

- reconciler를 #876과 #870에 두 개 만들지 않는다.
- interval floor와 replay bound가 이미 코드/게이트에 있으면 새 추상화 없이 Issue를 absorbed 처리한다.
- plugin/skill/cron/MCP Apps/PTY 교체는 이 배치의 다음 goal이 아니다.
- 새 도구를 설치하기 전에 기존 unit/verifier/adversarial-review가 답하지 못하는 질문을 한 줄로 적는다. 질문이 없으면 설치하지 않는다.

## 5. 정본 반영 절차

성재 승인 전:

- 이 문서와 CURRENT_STATE/JOURNAL만 갱신한다.
- ROADMAP.md, BUILD_TICKETS.md, STATUS.md, ADR status, GitHub Issue/Project, track pointer를 바꾸지 않는다.

성재 승인 뒤 `momo-main`이 순서대로:

1. 원격 Issue/PR/Project 상태를 재확인한다.
2. R1의 umbrella/exception 결정을 Issue와 PR에 기록한다.
3. R0~R4 evidence를 검수하고 계획 이탈을 `DEVIATION_LOG.md`로 환류한다.
4. #879/#870 absorbed/residual 판정을 확정한다.
5. ROADMAP/BUILD_TICKETS는 **남은 일만** 반영한다. 완료된 #860/#875나 absorbed 범위를 다시 백로그화하지 않는다.
6. STATUS에는 검증 증거만, 결정은 ADR/승인 기록, 순서는 ROADMAP에 기록한다.
7. 성재가 승인한 시점에만 track/engine과 track/uxui를 main으로 순차 통합한다.

## 6. Fable 실행 프롬프트

```text
당신은 momo의 Fable planner/reviewer이며 이번 턴의 목적은 구현이 아니라
PLN-20260728-02의 독립 검수와 정본 후보 작성이다.

먼저 다음을 읽어라.
1. AGENTS.md
2. docs/TRACKS.md
3. docs/planning/README.md
4. docs/planning/CURRENT_STATE.md
5. docs/planning/JOURNAL.md 최근 Fable 4항목
6. docs/planning/handoffs/2026-07-28-875-signing-packet.md
7. docs/planning/handoffs/2026-07-28-t3-repair-packet.md
8. docs/planning/handoffs/2026-07-28-fable-resource-optimized-canonicalization.md
9. docs/MULTI_SESSION_OPS.md §9

역할은 engine planning/integration review다. 구현 worker를 추가 spawn하지 마라.
현재 유일 active implementation은 feat/876-t3-lifecycle-settlement다.
origin/track/engine@ac258c8e를 base로 사용하고 local track/engine 포인터가 stale인지
먼저 확인하되 임의로 이동하지 마라.

반드시 할 일:
- GitHub에서 #869, #870, #875~#879와 관련 PR/Project 상태를 재확인한다.
- feat/876-t3-lifecycle-settlement의 현재 diff와 commits를 검수한다.
- #875는 완료, #860은 완료 후보로 취급하고 재계획하지 않는다.
- #876+#877+#878 한 PR이 AGENTS.md의 1 Issue=1 goal=1 PR과 충돌함을 명시한다.
  코드를 다시 쪼개기 전에 성재에게
  A) #876 umbrella + #877/#878 absorbed 또는
  B) 이번 배치 명시적 예외
  중 하나를 승인받도록 결정표를 올린다. 승인 전 merge/close 금지.
- 새 CloudLifecycleReconciler와 #870 acceptance를 대조해 absorbed/residual을 판정한다.
- #879의 interval floor와 replay bound를 각각 코드·게이트와 대조한다.
- #869는 남는 실제 WSS 왕복 조각만 정의한다.
- terminal observation/retention finding은 #857 main 노출 전 결정 항목으로 유지한다.
- plugin delegated-subject finding은 plugin dogfood 전 blocker로 유지하되 T3를 막지 않는다.

리소스 규칙:
- code worker 1, planner 1, Docker-heavy host-wide 1.
- load(1m)>12면 heavy 금지, 8~12면 heavy 하나만.
- 비-Docker build/test를 먼저 하고, 기존 8종+T3 확장 verifier는 한 heavy window로 묶는다.
- 종료 시 compose stack down evidence를 남긴다.
- 설치된 adversarial-review는 수정 통합 branch에서 --base origin/main으로 1회만 실행한다.
- 새 plugin/skill/security dependency를 설치하지 않는다.

최종 산출물:
1) 사실 교정 표,
2) Blocker/High/accepted-risk 표,
3) #876~#879/#869/#870 absorbed/residual 표,
4) 성재 결정 4건(거버넌스 정상화, terminal privacy, residual 순서, main sync),
5) 승인 후 ROADMAP/BUILD_TICKETS/STATUS에 각각 무엇만 반영할지 patch plan,
6) 다음 최소 goal 하나.

ROADMAP/BUILD_TICKETS/STATUS/ADR status/GitHub Issue를 선편집하지 말고,
track/*→main merge도 하지 마라. 결과를 새 review 문서로 쓰고 CURRENT_STATE와
JOURNAL을 갱신한 뒤 docs gate를 실행하라.
```

