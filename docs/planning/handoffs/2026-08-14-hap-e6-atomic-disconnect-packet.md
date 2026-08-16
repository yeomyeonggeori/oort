# HAP-E6 핸드오프 패킷 — #1367 원자적 disconnect + cleanup-confirmed terminal state

> 2026-08-14 Fable 발급, 성재 발사 결재 완료. 워커: 단발 무명 Opus 5.
> 정본 goal: GitHub Issue **#1367**(status:ready) — 이 패킷은 본문을 대체하지 않고 보충한다.

## 0. 발주 전 랜딩분 대조 (완료)

- base = **`track/engine@7a52c4c2`** (#1366 squash 랜딩, 2026-08-14). E1~E5 전부 랜딩됨.
- E5가 남긴 이 goal 소유 항목: **hosted delivery 프로덕션 게이트 개방** — `MOMO_HOSTED_DELIVERY_ENABLED` 파싱이 `#[cfg(debug_assertions)]` 한정임(momo-server/src/config.rs:262-271). E6가 disconnect 수명주기를 갖춘 뒤 이 cfg를 제거하고 release에서 열 수 있게 하는 것이 이 goal의 마지막 조각이다(개방 기본값은 여전히 closed).
- E5 리뷰 이관분 중 이 goal 인접: cursor secret 회전 = disconnect ⇒ re-pair 계약(운영자 강제 re-pair 표면), E4 잠금 순서 계약(connection→token→member→membership — 신규 트랜잭션도 준수).

## 1. 미션 요약

disconnect 시작 = bearer revoke + `cleanup_pending` 전이 + agent pause + delivery 억제 + audit **한 tenant tx**. 이후 종류별 artifact manifest(`bot`/`routine`/`plugin`/`connector`/`local_plugin_files`/`secret`)가 전부 resolved여야만 `disconnected` terminal 1회 전이. Bot은 preserve/delete 명시 disposition(자동 cascade 금지). 상세 수용기준은 이슈 본문 — 특히 #1344 실측 교훈(connector 제거≠파일 제거, inactive routine≠removed)이 negative path의 뼈대다.

## 2. 필독 코드 좌표 (base 기준)

- `server-rust/crates/momo-auth/src/hosted_connection.rs` — E3 수명주기 + E5의 approved-channel 재검증. **주의: prove 경로 invalidate의 형제 토큰 회수 AB-BA는 #1374 별건** — E6의 revoke tx는 같은 함정을 밟지 말 것(E4 잠금 순서 준수). disconnect가 invalidate를 재사용한다면 #1374의 수리 방향(현재 커넥션 한정 회수)과 정합하게.
- `server-rust/bins/momo-server/src/routes/agent_port_tools.rs` — 8도구의 매 요청 재검증(resolve_hosted_tool_identity_in_tx)·lease handle의 채널 봉인. disconnect 후 이 경로들이 전부 닫히는 것이 수용기준 — 기존 conformance 테스트의 revocation 축을 확장하라.
- `server-rust/crates/momo-outbox/src/gateway.rs` — hosted claim의 라이브 재증명. disconnect commit 후 신규 claim/renew 거부 + outstanding lease의 canonical 회수.
- `server/Migrations/069~071` — connection/inbox/producer 스키마. 신규 마이그레이션 = **072**(`scripts/check_migration_numbers.sh` 통과 필수).
- verifier 정본 패턴: `scripts/verify_agent_port_tools.sh`(소유권 계약). 신규 `scripts/verify_hosted_disconnect.sh`는 동일 계약(호출 라벨+trap+부재 증명+`--verify-cleanup-contract` static 배선).

## 3. 작업 규율 (E5와 동일)

- 워크트리 `~/projects/momo-tracks/momo-worktrees/1367-hap-e6-<slug>` · 브랜치 `feat/1367-hap-e6-engine-...` · base `track/engine@7a52c4c2`.
- 단발 무명, 중간 보고 없음, 로컬 커밋 동결만(push/PR/머지/이슈 조작 금지). `schema_v0.sql` 불가침·시크릿 금지.
- 게이트: 소유 파일 fmt(워크스페이스 fmt는 #1377 선재 RED — 비소유 제외)·workspace clippy `-D warnings`·전체 테스트·마이그 번호·신규+기존 verifier(E5/E4 무회귀)·Docker 잔존 0 증명. **로컬 docs gate 실행 금지**(#1376 base-inherited) — 문서는 구성 정확성으로, 관문은 PR CI.
- 문서: STATUS 절·overview 상태기계 절·OpenAPI·CURRENT_STATE(engine 계보) supersede.
- 미결 경계 결정은 추측 금지 — 동결+보고. 테스트 캔어리는 결정적 단언만(확률적 텍스트 매칭 금지 — E5 교훈).

## 4. 리뷰 폐곡선

구현 동결 → Fable 기획검수(C/H/M) → 수리 → sol 독립 freeze(C/H/M=0) → push→PR(track/engine; local_gate.sh 접촉 시 policy audit 코멘트+라벨 흐름, 선례 #1378/#1379) → CI → 머지. **E6 랜딩 = E1~E6 라이브 배포 창 개방 조건**(성재 결재 2026-08-14 — 배포 시 pending job 백로그 점검 선행, STATUS 체크리스트).
