# HAP-E5 핸드오프 패킷 — #1366 MCP thin-binding 8도구 + per-agent hosted delivery

> 2026-08-14 Fable 발급. 워커: 단발 무명 Opus 5. **발사는 성재 신호 후.**
> 정본 goal: GitHub Issue **#1366** (status:ready) — 이 패킷은 본문을 대체하지 않고 보충한다.
> **이슈의 Fable 코멘트(2026-08-14)가 수용기준 추가분이다 — 반드시 함께 읽을 것.**

## 0. 발주 전 랜딩분 대조 (완료)

- base = **`track/engine@aa40e4c6`** (#1365 squash 랜딩, 2026-08-14). E1(#1358)·E2(#1363)·E3(#1364)·E4(#1365) 전부 랜딩됨.
- E4는 MCP tool을 **의도적으로 열지 않았다** — 현행 Agent Port tool catalog는 빈 상태(`tools/list` 빈 목록), inbox producer 0. E5 범위와 중복 랜딩분 없음(2026-08-14 대조).

## 1. 미션 요약

`POST /v1/mcp/agent-port`(E2 dual-era foundation) 위에 8개 thin-binding 도구(`oort_inbox_read`·`oort_conversation_read`·`oort_message_post`·`oort_jobs_claim`·`oort_job_renew`·`oort_job_release`·`oort_run_event`·`oort_run_complete`)를 추가하고, agent별 managed/hosted delivery selector를 구현한다. **두 번째 message/job SoT 금지, MCP는 protocol adapter일 뿐** — 기존 `momo-messaging` send tx·gateway job/lease/run lifecycle·E4 inbox domain을 typed port로 주입받아 호출한다. 상세 수용기준은 이슈 본문.

## 2. 필독 코드 좌표 (base 기준)

- `server-rust/crates/momo-messaging/src/hosted_inbox.rs` — E4 inbox append/read·opaque cursor. **잠금 순서: 단일 문 `FOR SHARE OF hc,t,m,wm,ap,cm`(connection→token→member→membership) — 새 코드도 이 순서를 지켜라**(#1374의 AB-BA가 반례).
- `server-rust/crates/momo-auth/src/hosted_connection.rs` — E3 pairing/activation/prove. `invalidate_hosted_lifecycle_in_tx`의 형제 토큰 회수는 #1374 별건 — 이 goal에서 고치지 말 것(접점만 인지).
- `server/Migrations/070_hosted_agent_inbox.sql` — ledger FK 구조. **job(outbox) 참조는 agent까지만 결속, outbox.kind·job↔run 짝은 스키마가 강제하지 않는다** — producer를 여는 이 goal이 그 폐곡선의 소유자다(이슈 코멘트 M1 항목).
- `momo-mcp` crate(E2) — pure protocol, SQL 의존 추가 금지. server adapter가 domain port 주입.
- `scripts/verify_hosted_agent_inbox.sh`·`scripts/verify_agent_port.sh` — verifier 소유권 계약의 정본 패턴. 신규 verifier는 동일 계약(호출 라벨+trap cleanup+부재 증명+`--verify-cleanup-contract` static 배선) 필수. 런북 `docs/runbooks/local-resource-reclaim.md` §층1.

## 3. 수용기준 추가분 (이슈 코멘트 정본, 요약)

1. **M1 폐곡선(필수)**: outbox.kind FK 결속 또는 producer 불변식+적대 테스트(선택 근거 명시) · job↔run 짝 결속 강제+red proof · `agent_job`/`agent_run` kind PG 테스트 신설(shape CHECK·FK·dedupe·kind 혼동 거부).
2. token **audience/actor/connection** 불일치 축 테스트(E4 SQL 술어는 있으나 미검증).
3. cursor secret 회전 계약 결정(key-id 부재 → 회전 시 전량 재전송 문제).
4. tombstone 메시지 참조 차단 = producer가 send tx 내 append하는 배치를 계약으로 명문화.

## 4. 작업 규율

- 워크트리: `~/projects/momo-tracks/momo-worktrees/1366-hap-e5-<slug>` · 브랜치 `feat/1366-hap-e5-engine-...` · base `track/engine@aa40e4c6`.
- 단발 무명 워커, 중간 보고 없음, 완주 후 최종 보고 1회. 스크래치 파일명 고유. **worker는 merge/close/push 금지** — 로컬 커밋 동결 후 보고(push·PR·머지는 오케스트레이터).
- `schema_v0.sql` 수정 금지 · 시크릿 커밋 금지 · Grok/구독/결제는 build/test 의존성 아님(이슈 Out of scope).
- 게이트: `[rust]` fmt(자기 파일)+workspace clippy `-D warnings`+workspace tests · `[runtime-agent]+[runtime-db]` 신규 verifier 포함 · migration 번호 검사. **주의**: workspace `cargo fmt --check`는 선재 drift로 RED일 수 있음(#1377 진행 전) — 자기 소유 파일만 fmt PASS 관리(sol 방식).
- **로컬 docs gate는 base-inherited 결함 2종(#1376: actionlint 스핀은 unlink로 완화됨·시스템 ruby 2.6 파싱)로 이 머신에서 완주 불가가 증명됨** — docs 정합은 파일 정확성으로 관리하고 최종 관문은 PR CI.
- 문서 갱신: STATUS.md 절 추가 · `docs/architecture/overview.md` Agent Port 절 갱신 · openapi(스코프/도구) 정합 · CURRENT_STATE 스냅샷(engine 계보) supersede.
- 완주 시 Docker 잔존 0 증명(verifier 부재 증명 로그) — 회수 실패는 실패로 보고.

## 5. 리뷰 폐곡선 (체제: 2026-08-14 성재 확정)

구현(Opus 워커, 로컬 동결) → **Fable 기획검수**(C/H/M 판정·이관/티켓) → 수리 → **sol 독립 freeze 리뷰**(exact commit C/H/M=0) → push→PR(track/engine)→PR CI(policy-integrity가 local_gate.sh 접촉 시 audit 코멘트+policy-change-approved 라벨 요구 — 선례 #1373/#1378) → 머지.
