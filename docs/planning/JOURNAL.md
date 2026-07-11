# 기획 세션 저널 (newest-first, 기존 항목 불변)

> 목적: **기획/오케스트레이션 세션 간 이어달리기.** Fable이든 GPT 5.6이든, 세션을 시작할 때 최근 항목을 읽고, 끝낼 때 항목을 추가한다(`docs/planning/README.md` §1).
> 규칙: 항목당 5줄 이내. 새 항목은 맨 위에 추가하고 기존 항목은 수정하지 않는다. 결정·증거·계획의 정본이 아니다(그건 ADR/STATUS/ROADMAP) — 여기는 "무엇을 하다 어디서 멈췄나"만. 최신이 위.

---

## 2026-07-11 (Codex worker) · MOMO-346 Hermes bridge/gateway verifier 격리
- 반영: external-provider/bridge와 gateway verifier를 각각 unique marker/OID-owned migrated DB로 분리하고 marker-bound runtime role 및 Hermes/#agent-lab fixture를 자체 seed한다.
- 경계: source dogfood DB는 digest 전후 비교만 하며 exact OID+marker cleanup, marker-bound role cleanup, 두 verifier의 pre-marker COMMENT 실패(exit 96) rollback 회귀를 `runtime-agent`에 배선했다.
- 검증: DB/Docker/verifier 실행 없이 수정·신규 shell `bash -n`만 PASS; acceptance/gate 체크박스는 미체크 유지했다.
- 다음: 오케스트레이터가 merge 전 fresh invite/roundtrip/bearer assertions·성공/실패 digest·clean runtime-agent를 수행하고, momo-main이 merge/root gate를 맡는다.

## 2026-07-11 (Fable) · momo-main · MOMO-339 랜딩 — ADR-0101 Phase 1 종결 (codex-fleet 배치 1 완료)
- 랜딩: goal-309 worker PR #323을 검수 — 스냅샷 참조 6종 정본 머신 재기록(worker 샌드박스 렌더링 불일치), main 위 rebase, fresh-context design-review **PASS Blocker 0**, worktree macos-ui gate full PASS 후 merge (`881518b`). ADR-0101 Phase 1 배치(337/338/339) 종결, 패킷 Status `done`.
- 발급 2건: MOMO-347 `#324`(design review High 2·Medium 4 후속), MOMO-348 `#325`(root macos-ui gate가 `verify_macos_real_backend_ui.sh` dogfood 결합으로 중단 — hermes 멤버십 drift로 mention→agent_job 0건, 346 후속).
- 파이프라인 교훈: named 팀메이트(tmux) spawn은 mailbox 미전달 좀비化 — 리뷰 서브에이전트는 이름 없는 일반 spawn (codex-fleet 스킬 반영).
- 다음: MOMO-346‖347 병렬 착수 가능(성재 트리거), 348은 346 후. root full gate green = 346+348. ADR-0102 성재 결정 대기.

## 2026-07-11 (Codex) · worker #309 · MOMO-339 macOS credential pairing UI
- 반영: 초대 후 per-agent bearer 발급, transient one-time reveal, env 복사/권한 안내, 프로필·페어링 목록의 상태/회전/grace/확인 후 폐기/401 복구를 연결했다.
- 보안: raw bearer는 매니페스트·UserDefaults·로그·오류·실제 snapshot fixture에 저장하지 않고 REST create 응답→sheet state에서만 유지한다.
- 검증: macOS build PASS, credential+snapshot 포함 82 tests PASS(기존 MessageBubble snapshot 2개 signal 5 제외), light/dark/고대비/큰 글자 스냅샷 6종 PASS, design-review Blocker 0.
- 남은 것: 오케스트레이터가 merge 전 `macos-ui` 런타임 게이트와 실제 pairing/profile integration·폐기 dialog smoke를 수행한다.

## 2026-07-11 (Fable) · momo-main · MOMO-345 랜딩 + MOMO-346 발급 (codex-fleet 배치 1)
- 랜딩: codex-fleet worker(goal-320)가 만든 PR #321을 리뷰(MOMO-344 패턴 정합 확인)·worktree clean gate full PASS 후 merge (`5854c2f`), #320 close.
- 실증: root post-merge에서 live verifier가 drift 있는 dogfood DB 위에서 PASS + digest 보존. full gate는 hermes bridge/gateway verifier의 dogfood 결합(Hermes `…103` 멤버십 drift + roundtrip이 dogfood 채널에 메시지 작성)에서 중단 → MOMO-346 `#322` 발급 (캐스케이드 종결 티켓, `status:ready`).
- 병행: goal-309(MOMO-339 pairing credential UI) worker 실행 중. 파이프라인 개선: worktree 커밋은 `--add-dir <메인repo>/.git` 필요.
- 다음: MOMO-346 착수(성재 트리거), goal-309 완주 시 검수 사이클, ADR-0102 성재 결정 대기.

## 2026-07-11 (Codex worker) · MOMO-345 live channel verifier 격리
- 반영: live verifier를 unique marker/OID-owned migrated DB와 marker-bound app(NOBYPASSRLS)·worker/relay(BYPASSRLS) role로 분리하고 authorized/negative fixture를 자체 seed한다.
- 경계: source dogfood DB는 agent queue/run/approval/message digest 전후 비교만 하며, exact OID+marker cleanup과 pre-marker COMMENT 실패 rollback helper를 추가했다.
- 검증: DB/Docker/verifier 실행 없이 `bash -n`만 PASS; fresh bootstrap·live assertions·clean/root `runtime-agent` evidence는 오케스트레이터 merge 전 대기.
- 다음: PR 리뷰/런타임 gate 후 momo-main이 merge·root post-merge gate·체크박스 갱신.

## 2026-07-11 (Fable) · momo-main · MOMO-344 검수 마무리 + MOMO-345 발급
- 마무리: GPT sol이 중단한 MOMO-344를 인계받아 재리뷰(P1 4건 반영 확인 + 실행권한 결함 1건 수정), 타깃 검증·clean gate PASS 후 PR #319 merge (`0b2c94a`), #318 close.
- 발견 1: root post-merge gate에서 `verify_agent_live_channel.sh`가 dogfood DB demo 시드 drift(agent 멤버십 left_at)로 실패 → 스코프 확장 대신 MOMO-345 `#320` 발급 (`status:ready`).
- 발견 2: momo_main Centrifugo가 MOMO-338 이전 running-config로 기동 상태(107/102 오류) → 재시작으로 해소. drift guard 티켓은 성재 승인 대기 제안.
- 다음: MOMO-339 `#309`(macOS pairing credential UI)와 MOMO-345 `#320` 병렬 착수 가능. ADR-0102 결정은 계속 성재 대기.

## 2026-07-11 (Codex) · momo-main · MOMO-344 context verifier 격리
- 발견: PR #317 post-merge root gate에서 `verify_agent_context.sh`가 persistent dogfood DB의 unrelated `resume_approval` job을 claim해 context trigger가 starvation 됐다.
- 결정: production Worker claim 정책은 바꾸지 않고 verifier에 unique migrated DB, marker-bound NOBYPASS app/BYPASS worker role, exact OID+marker cleanup을 적용한다.
- 검증 계획: source queue/run/approval/message digest 보존 + 기존 context assertions + full runtime-agent + 리뷰 + root post-merge gate.

## 2026-07-11 (Codex) · momo-main · MOMO-343 fresh bootstrap 회귀
- 발견: MOMO-342 merge 후 root main 새 포트에서 psql `-c` marker 변수가 치환되지 않아 fresh verifier DB bootstrap이 syntax error로 중단되고 unmarked DB가 남았다.
- 반영: COMMENT를 psql stdin SQL로 이동하고, cleanup 직전 exact generation marker를 재검증하며 동일 marker의 전용 role만 NOLOGIN/제거한다. role bootstrap은 트랜잭션화했고 unique DB의 실패 rollback, fresh 성공, persistent 재실행을 한 회귀 helper로 고정했다.
- 추가 발견: cold worktree dependency materialization이 MomoServer health timeout에 포함됐다. 세 runtime binary를 timeout 전에 동기 build하도록 분리했다.
- 검증: fresh DB bootstrap + persistent 재실행 + root main runtime-agent post-merge gate 예정.
- 다음: #316 merge/root gate 후 MOMO-339 pairing credential UI로 복귀.

## 2026-07-11 (Codex) · momo-main · MOMO-342 main gate 복구
- 발견: MOMO-338 merge 후 persistent main DB에서 user-owned Hermes membership이 제거돼 AgentWorker verifier가 migration seed를 잘못 전제했다.
- 반영: source DB와 물리적으로 분리된 marker-owned migration DB, generation별 fixture UUID, verifier-only workspace/human/channel/agent/budget, 고정 ID/alias 소유권 guard, exact client-message 기반 cleanup, empty run fail-fast 진단을 추가했다.
- 리뷰 반영: body/agent-wide 삭제를 제거하고 unrelated message/pending job/membership/Hermes 보존 sentinel, marker-bound 전용 app/relay/worker role, 전역 consumer의 isolated DB 연결, source/system/unmarked DB 거부, runtime-agent 2회 실행을 추가했다. 서버는 사전 build executable을 직접 띄워 SwiftPM planning lock도 피한다.
- 검증: 동일 persistent verifier DB에서 AgentWorker verifier 연속 2회 PASS, source DB untouched 확인; 전체 runtime-agent gate와 main 재검증 예정.
- 다음: #314 리뷰/merge/root main gate 후 MOMO-339 pairing credential UI 착수.

## 2026-07-11 (Codex) · momo-main · MOMO-338 보안 재리뷰
- 발견: realtime payload 직접 실행, run/channel 위조, credential-coarse realtime revocation, token-shaped error/argv 노출을 P1/P2로 확인.
- 반영: realtime wake-only + pending REST 재조회, exact `meta.token_id` liveness, agent run binding, 양단 redaction과 stdin verifier를 적용.
- 검증: adapter 40 tests, server 49 tests, terminal 401/4xx·full-page·reconnect/shutdown race, revoked JWT/cross-channel run/private agentwork 및 gateway verifier PASS.
- 다음: clean gates와 재리뷰 후 PR merge/root main fast-forward. 다중 instance lease는 MOMO-341.

## 2026-07-10 (Codex) · momo-main · MOMO-338 리뷰 보강
- 발견: `agent:` 하나에 observer progress와 private Context Packet job이 섞여 보안 self-only 수정이 기존 live UX를 깨뜨렸다.
- 반영: `agent:` progress / `agentwork:` private job 분리, cancellation/reconnect/recovery/backpressure 및 verifier secret lifecycle 하드닝.
- 검증: adapter 33 tests(실시간/recovery 단일 provider worker), server 48 tests, exact-channel agent live + private agentwork WebSocket/relay + Hermes gateway runtime verifier PASS.
- 다음: clean docs/runtime-agent gate와 PR merge 후 root main fast-forward. 다중 instance lease는 MOMO-341.

## 2026-07-10 (Codex) · momo-main · MOMO-338 통합 준비
- 한 일: Hermes adapter를 per-agent bearer 하나로 단일화하고 login/shared-secret을 제거. realtime-first reconnect + bounded recovery/cache + legacy env migration을 추가.
- 리뷰 반영: 다른 agent의 Context Packet을 볼 수 있던 subscribe proxy를 self-only로 강화하고 actor/env 교차검증, non-loopback TLS 기본값, smoke session revoke를 적용.
- 이탈: Python adapter 범위에서 server transport auth까지 확대(보안 blocker, DEVIATION_LOG accepted). 중복 gateway lease는 후속 티켓.
- 다음: runtime-agent clean gate·PR merge 후 root main fast-forward. 그다음 MOMO-339 및 gateway lease 티켓.

## 2026-07-10 (Codex) · momo-main · MOMO-337 통합
- 한 일: PR #310 보안/성능 리뷰에서 one-time token no-store, 발급자 provenance, pending `available_at`을 수정하고 main `8d97c82`로 merge. post-merge `runtime-agent` PASS.
- 이탈: 예상만 있던 `/gateway/jobs/pending`을 actor-bound recovery endpoint로 신설. #308에는 realtime-first + bounded recovery 계약을 추가.
- 현재: #307 done, #308(M1)/#309(M3) ready·병렬 가능. ADR-0102는 여전히 성재 결정 대기.
- 다음: runtime 임계경로인 MOMO-338을 먼저 claim하고, 별도 worker에서 MOMO-339를 병렬 진행 가능.

## 2026-07-10 (Codex) · GPT 5.6 · 기획 체계 보강
- 한 일: Fable 인수 내용을 검토하고 `CURRENT_STATE.md` 중심의 압축 복원, planner 병렬 claim, `momo-main` 순차 통합, versioned handoff 규칙을 정본에 추가.
- 열린 것: ADR-0102는 성재 결정 대기. GitHub 실측상 MOMO-337(#307)은 이미 별도 worktree에서 in-progress(PR 없음). root main의 기존 Hermes/local-dogfood 변경은 분리 유지.
- 다음: #307 PR handoff를 기다리며 ADR-0102 결정. 병렬 planner는 `CURRENT_STATE.md`에서 서로 다른 planning ID를 먼저 claim.

## 2026-07-10 (오후) · Fable · 기획+오케스트레이션
- 한 일: 협업 파이프라인 정본화(docs/planning/* 신설, CLAUDE.md, momo-planning 스킬, PR 이탈 섹션). 이슈 #307(ready)/#308/#309(blocked) 발급 + 핸드오프 패킷. ADR-0102 기안(Proposed).
- 열린 것: **ADR-0102 성재 결정 대기(권고 C)** · #307 착수는 성재가 Codex에 직접 요청 예정 · 기획/문서 배치는 main에 커밋됨(성재 승인, 이전 세션의 코드 핫픽스 변경은 여전히 미커밋 — 그 배치의 주인이 처리).
- 다음: 성재의 0102 결정 → 파생 티켓. #307 PR 오면 momo-main 리뷰 사이클 가동.

## 2026-07-10 (오전) · Fable · 기획
- 한 일: ADR-0100(거버넌스)·0101(에이전트 신원, Option A) 성재 승인 → Accepted. ux-bible/architecture 정본 신설. MOMO-337~339 수용기준 발급(BUILD_TICKETS).
- 열린 것: 없음 (전부 오후 세션으로 인계됨).

## 2026-07-09 · Fable · 진단
- 한 일: 6방향 코드베이스 감사 + Slack UX 딥리서치(36소스) → 진단 아티팩트(https://claude.ai/code/artifact/1e7d94cf-094c-4b66-b2b9-dbef028bee06). 판정: 골격 견고 / 신원·체감 레이어가 봇 수준 / 전면 리라이트 비추천. ADR 결정 큐 0100~0109 수립.
- 열린 것: 결정 큐 0102~0109 (0100·0101은 다음 날 처리됨).
