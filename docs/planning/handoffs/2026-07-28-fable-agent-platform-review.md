# HANDOFF: Tauri/RN 이후 agent-platform 갭 감사 — Fable 검수

> Status: `superseded` — **planner review packet이며 worker 구현 계약이 아니다**
> Planning ID: `PLN-20260728-01` · Planner owner: GPT 5.6 (`momo-main`) · Reviewer: Fable · Integrator: `momo-main`
> 발급: 2026-07-28 · 기준 커밋: `747c9b120762dd60c46d357acb9312f19f81959b` · Supersedes: 없음
> Superseded by: `docs/planning/handoffs/2026-07-28-fable-agent-platform-redteam-review.md`
> 근거 ADR: ADR-0113, ADR-0131, ADR-0133, ADR-0137, ADR-0139 · 대상: 기획 검수만 · GitHub binding: 미발급

이 패킷의 실행 권고는 독립 레드팀 검수 패킷이 대체했다. 사실·경쟁사 증거의 과거 맥락으로만 읽고, 새 검수는 superseding packet에서 시작한다.

이 패킷은 Fable이 리서치의 사실성·중복·결정 경계·실행 순서를 검수해 성재의 승인 큐로 돌려보내기 위한 것이었다. 여기 적힌 별칭은 canonical MOMO goal이 아니다. Fable 검수와 성재 승인 전에는 ROADMAP/BUILD_TICKETS/STATUS를 고치거나 GitHub Issue를 만들지 않는다.

## 1. 읽을 것

순서대로 읽는다.

1. `AGENTS.md`
2. `docs/TRACKS.md`
3. `docs/planning/README.md`
4. `docs/planning/CURRENT_STATE.md`
5. `docs/planning/research/2026-07-28-tauri-rn-agent-platform-gap-audit.md`
6. `docs/planning/handoffs/2026-07-28-resume-batch2.md`
7. `docs/adr/0113-*.md`, `0131-*.md`, `0133-*.md`, `0137-*.md`, `0139-*.md`
8. GitHub #837, #857~#861, #865와 PR #868의 **현재** 상태

## 2. 이번 검수에서 고정하지 말 것

- `track/engine` 또는 `track/uxui`를 main에 merge하지 않는다.
- canonical ROADMAP/BUILD_TICKETS/STATUS를 먼저 편집하지 않는다.
- 제안 별칭에 MOMO 번호를 배정하거나 Issue를 발급하지 않는다.
- plugin v2, skill recorder, Automation, MCP Apps, terminal backend를 구현하지 않는다.
- Herdr/Ghostty를 채택된 내부 기술처럼 서술하지 않는다.

## 3. 반드시 재검증할 사실

1. PR #868은 `track/engine`에 merge됐고 #857 open+`needs-review`는 owner-approved main 동기화 전까지 운영 계약상 정상인지.
2. #859 worktree는 #868 merge base만 가리키며 실제 구현 commit은 없는지.
3. #839/#842는 코드가 main에 있으나 Issue metadata가 stale인지.
4. `CodexJSONRPCAdapter.swift`, `OpenCodeHTTPAdapter.swift`, ACP adapter가 실제 semantic path인지.
5. 터미널이 xterm.js renderer + Swift POSIX PTY이고 Herdr/Ghostty는 의존 0인지.
6. `momo.plugin.v1`이 단일 optional skill reference만 허용하며 공식 fixture가 모두 null인지.
7. `MemoryRoutes`와 agent run/history의 서버·웹 소비 범위가 #860/#861 설명과 일치하는지.
8. MCP Apps stable extension과 2026-07-28 MCP release candidate를 문서가 구분했는지.
9. repo의 `momo-design-taste-web` 계약과 motion 제안이 충돌하지 않는지.
10. `infra/prod/.env.example`의 WorkHost 변수 누락으로 기본 docs gate가 실패하는지, 기존 goal과 중복 없이 `OPS-WORKHOST-ENV-DRIFT`로 수리할지.

## 4. Fable 산출물

감사 문서의 주장과 builder 별칭을 그대로 승인하지 말고 다음 형식으로 검수한다.

1. **사실 교정표**: claim, evidence, verdict(`confirmed/correct/defer`), 수정 문구.
2. **별칭 판정표**: 각 후보를 `accept/reject/defer/dedupe`로 분류하고 이유·기존 goal을 연결.
3. **ADR 묶음**: ADR-0113 증보, ADR-0140, skill lifecycle, MCP Apps host를 합칠지 나눌지 결정 제안.
4. **의존 DAG와 트랙/머지 순서**: #865, #857~#861, #837을 밀어내지 않는 순서.
5. **builder 계약 초안**: 승인 후보만 Goal/Context/Acceptance/Out of scope/검증 등급으로 쓴다.
6. **정본 편입 제안**: ROADMAP milestone과 BUILD_TICKETS 삽입 위치를 제시하되 아직 편집하지 않는다.
7. **성재 결정 큐**: 선택지·권고·비용·되돌림 가능성·결정 시한.

특히 다음을 답한다.

- #857 replay가 랜딩한 뒤 Herdr 비교 spike가 여전히 2주 안팎의 비용을 정당화하는가.
- plugin bundle v2와 사용자 OAuth를 같은 ADR에 묶어도 보안 경계가 흐려지지 않는가.
- skill recorder를 plugin v2보다 앞세우면 권한·버전 계약을 우회하게 되는가.
- Automation v0가 schedule-only여도 future trigger kind를 schema에 예약할 것인가.
- MCP Apps spike를 첫 OAuth connector dogfood 전/후 어느 쪽에 둘 것인가.
- Motion dependency 없이 CSS/RN 기본 API와 검수 skill부터 여는 안이 충분한가.

## 5. Fable에게 보내는 복사 가능한 프롬프트

```text
레포 /Users/kwakseongjae/projects/momo에서 AGENTS.md를 최우선으로 따라라.
너는 구현 worker가 아니라 Fable planner/reviewer다. engine 기획 트랙으로 선언하고 scripts/planning_context.sh를 실행한 뒤 docs/planning/handoffs/2026-07-28-fable-agent-platform-review.md와 그 문서가 지정한 정본·감사 문서를 모두 읽어라.

PLN-20260728-01의 Tauri/RN 이후 agent-platform 갭 감사를 코드, origin track, GitHub Issue/PR, 공식 1차 자료로 독립 검수하라. 특히 #837, #857~#861, #865와 PR #868을 중복 없이 대조하고, #857의 open+needs-review가 main 미동기화 동안 정상인지, #839/#842의 metadata drift, #859의 실제 구현 유무, Codex JSON-RPC의 현행 채택 여부를 재확인하라. Herdr(terminal multiplexer), RN Hermes, momo hermes gateway를 혼동하지 말고, 사용자 제공 Codex plugin/skill UI와 momo 현재 표면의 parity를 검증하라. MCP Apps stable extension과 2026-07-28 RC도 구분하고, motion 제안은 momo-design-taste-web 계약과 대조하라. 깨끗한 shell에서 prod example을 사용한 docs gate의 WorkHost required-variable drift도 재현하고 기존 goal과 dedupe하라.

산출물은 ①사실 교정표 ②제안 별칭 accept/reject/defer/dedupe 표 ③ADR 묶음 ④의존 DAG·트랙·머지 순서 ⑤승인 후보의 BUILD_TICKETS/GitHub Issue 수용기준 초안 ⑥ROADMAP 삽입 제안 ⑦성재 결정 큐다. #857 이후 Herdr spike의 비용 대비 이득, plugin v2/OAuth/skill lifecycle 경계, 기존 agent_run을 재사용하는 Automation, MCP Apps 도입 시점, CSS-first motion을 명시적으로 판정하라.

성재 승인 전에는 ROADMAP.md, BUILD_TICKETS.md, STATUS.md를 편집하거나 Issue를 만들거나 track/*를 main에 merge하지 마라. 검수 결과는 docs/planning/research/의 sibling review 문서로 남기고 docs/planning/CURRENT_STATE.md의 PLN 행은 사실상 필요한 metadata만 갱신하며 docs/planning/JOURNAL.md에 5줄 이내로 이어달리기 기록을 추가하라.
```

## 6. 완료 조건

- 감사 문서의 모든 `confirmed` 주장에 repo/GitHub/공식 출처 중 하나 이상의 재현 가능한 근거가 있다.
- 기존 goal과 신규 후보가 중복되지 않는다.
- 새 실행·credential·plugin manifest·sandbox 경계는 Accepted ADR 전 구현 금지로 분리된다.
- 첫 실행 wave는 현재 continuity queue와 RN #837을 밀어내지 않는다.
- 성재가 한 번에 승인/반려할 수 있는 결정 큐가 나온다.
