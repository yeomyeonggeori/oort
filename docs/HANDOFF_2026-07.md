# 실행 인수인계 — 2026-07 재설계 (Opus 세션 → Codex/GPT)

> **목적:** 2026-07-06~07 Opus 세션이 재설계(MOMO-300~323)를 어디까지 진행했고, **Codex/GPT가 이제부터 무엇을 어떻게 이어받는지** 한 문서로 고정한다.
> **정본 우선순위:** `AGENTS.md`(운영 계약) > `ROADMAP.md` > `docs/BACKLOG.md`(티켓) > 이 문서(실행 상태 스냅샷). 상태 뷰는 `research/13-redesign/00-execution-tracker.md`.
> **2026-07-14 superseded notice:** 이 문서는 당시 실행 스냅샷으로만 보존한다. §2의 `MOMO-308/309 ready`, `MOMO-320=Drive` 안내는 폐기됐으며 picker 입력으로 사용하면 안 된다. 현재 착수 상태와 ID는 `docs/planning/CURRENT_STATE.md`, `research/13-redesign/00-execution-tracker.md`, `docs/planning/proposals/2026-07-14-superapp-engine-roadmap.md`가 우선한다.

---

## 0. 실행 주체 전환

- **이전(2026-07-06~07):** Fable/Opus 메인루프가 오케스트레이션, 구현은 Opus 4.8 workflow 서브에이전트, 리뷰는 다중-lens workflow, 머지·게이트 배비싯은 메인루프.
- **지금부터:** **Codex/GPT가 goal(=GitHub Issue 또는 BACKLOG 티켓) 기반 자율 실행.** AGENTS.md §1(작업 루프)·§6(다음 티켓 picker)·DoD를 그대로 따른다. 이 재설계 티켓들은 `docs/BACKLOG.md §4 재설계 섹션`이 계약이다.
- Opus-workflow 병렬 방식은 이 세션 한정이었고, Codex는 자기 표준 루프(claim → worktree → 구현 → 게이트 evidence → PR → momo-main 핸드오프)를 쓰면 된다.

## 1. 현재 상태 (main HEAD `88234d2`)

**머지 완료 (6티켓, 전부 3-lens 리뷰 + 게이트 검증):**

| 티켓 | 내용 | 검증 | STATUS |
|---|---|---|---|
| MOMO-316 | local gate `--auto`/compose `--wait`/멱등 1-run | docs/runtime-db/host-runtime/local-alpha/relay/agent PASS | §0ay |
| MOMO-323 | GWS 스펙 정정 3건 + Internal consent 런북 | docs PASS | §0az |
| MOMO-301 | agent_run depth/round 스키마 + 루프가드 G1~G4 실쿼리 | swift + runtime-db + runtime-agent(트립 4종) PASS | §0b0 |
| MOMO-302 | 컨텍스트 조립 v1 (단일→히스토리/토큰 윈도) | swift(worker29/server35) + runtime-agent 개별 verifier 전부 PASS | §0b1 |
| MOMO-300 | subscribe proxy 인증 + token revocation + rate limit | 전 프로파일 PASS | §0b2 |
| MOMO-318 | 디자인 pre-flight(ratchet) → swift 게이트 + 스냅샷 | swift 게이트 PASS(baseline 81/1/0/0 + 60 tests) | §0b3 |

**브랜치 대기 (Codex가 완료):**
- **MOMO-317** — `feat/MOMO-317-buildkit-cache` (@ e31d30e, 6e01142 기반). BuildKit cache-mount + 레이어 분리 Dockerfile + worktree 공유 scratch(opt-in). 재작성 Dockerfile은 **단일이미지 빌드+바이너리 실행 검증됨**. 잔여: `git merge main`(Makefile/swift-service.Dockerfile/verify_internal_host_runtime.sh에서 **316/300과 build-infra 충돌 해소** 필요) → `scripts/local_gate.sh --profile host-runtime`(5이미지, 메모리 여유 환경/CI에서) → 머지.

## 2. Codex 다음 착수 (진입점)

AGENTS.md §6 picker 기준. tracker(`research/13-redesign/00-execution-tracker.md`)가 상태 정본.

1. **MOMO-303 · MomoDS v0** (P0, macos) — 토큰 4층(Primitive/Semantic/Component/Density) + ugly mode + 컴포넌트 7종 추출. **Phase 1의 마지막 P0이자 macOS UI 모든 후속(304~306, 312, 314)의 선행.** 게이트에 이미 design pre-flight(ratchet, MOMO-318)가 걸려 있어 신규 위반은 자동 차단됨 — 303은 baseline(81/1/0/0)을 **낮추는** 방향(하드코딩 회수)이 목표.
2. **역사적 제안(폐기):** 당시에는 MOMO-308/309 병렬 착수를 제안했으나 두 티켓 모두 보안 ADR 의존으로 다시 blocked됐다. MOMO-308은 non-claimable umbrella이며 MCP 구현은 새 분할 ID를 받아야 한다.
3. **MOMO-317**(build-infra 브랜치 완료) · **MOMO-319**(게이트/verifier 하드닝) — 인프라 트랙, 언제든.
4. 이후 Phase 2 후보는 tracker를 다시 확인한다. MOMO-320은 완료된 env drift guard 전용이며 Drive 작업 번호로 재사용하지 않는다.

## 3. Codex가 반드시 지킬 것 (이 세션에서 확립/실측)

- **UI 작업(303~306, 312, 314):** `.claude/skills/momo-design-taste/SKILL.md` 하드 룰(시맨틱 컬러/텍스트 롤/스페이싱 스케일/Mac AI-Tells) 준수. 사람 리뷰 전 `design-review` 에이전트 리포트(Blocker 0)를 PR evidence에 포함(AGENTS.md §5). design pre-flight ratchet baseline은 위반을 **늘리면** 게이트 FAIL.
- **게이트 배비싯(런타임 프로파일):** 이 세션에서 반복 확인된 함정 — 각 게이트/verifier에 **watchdog(900~1200s)** + **포트 가드**(자기 API 포트 + verifier 전용 포트 8082/8090/23560~23563의 누수 MomoServer/mock kill)를 붙여라. verifier가 `swift run` child를 누수시켜 다음 실행이 "already serving" 또는 누적 메모리 OOM으로 실패한다(→ MOMO-319가 근본 하드닝). 게이트 evidence는 **clean HEAD에서** 실행해 최종 커밋에 바인딩.
- **머지 위생:** `git add -A` 시 `.claude/worktrees/`·`worktrees/`가 gitlink로 딸려오지 않게(이미 `.gitignore` 등록됨). STATUS 섹션 번호(0aN→0bN) 충돌은 keep-both로 리넘버링. 재설계 티켓 종료 시 tracker 상태도 함께 갱신(AGENTS.md DoD 5).
- **정직 표기:** 못 닫은 런타임은 `runtime-unverified` + 사유. 이 세션의 미해결: 317 full host-runtime(메모리), MOMO-319 verifier 하드닝, GWS/음성/온디바이스 실증(tracker §"착수 전 실증 항목").

## 4. 알려진 후속/실증 (tracker와 동기화)

- **MOMO-319** = 게이트/verifier 하드닝(누수 process-group kill + runtime-db 부분 병렬화 + 웜 볼륨 opt-in). 이 세션에서 302/300 게이트가 겪은 근본 인프라 이슈를 여기서 닫는다.
- **317 host-runtime** = 메모리 여유 환경/CI에서 5이미지 빌드+스택 부팅 확인.
- **실증(runtime-unverified):** per-user selected-file/SA Drive read 경계(새 GWS ID 대기), Drive `fullText` 한국어(321 후보), SpeechTranscriber 한국어 WER(312), macOS 26 실기기 FoundationModels/Speech(311/312) — 전부 최신 tracker와 Accepted ADR을 먼저 확인한다.
- **사람 전용:** MomoDS 시각 최종 승인, GCP/Internal-consent/SA 생성(323 런북), 음성 WER 샘플, credentialed provider smoke.

---

> 요약: **재설계 인프라(게이트/보안/에이전트 코어)와 컨텍스트 조립까지 6티켓이 main에 들어갔고, Codex는 MOMO-303(MomoDS)부터 제품 UI/기능 트랙을 이어받는다.** design-taste 게이트가 이미 걸려 있어 UI 품질은 자동 방어되고, 게이트 배비싯 함정(watchdog/포트가드/누수)은 위 §3에 정리돼 있다.
