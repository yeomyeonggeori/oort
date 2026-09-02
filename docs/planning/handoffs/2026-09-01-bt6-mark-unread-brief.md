# 워커 브리프 — BT-6(#1934) mark-unread (engine→uxui, 2PR)

> 워커: Opus 5 · 시작 절차: 각 워크트리에서 `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. MCP 금지. `schema_v0.sql` 무접촉(확장은 신규 마이그레이션 파일).
> 정본: **ADR-0178 Accepted** (docs/adr/0178-mark-unread-signal.md) — D1~D5 전부 구속. 특히 **D3 합성 단일점**: momo-core 밖에서 합성하는 코드가 하나라도 생기면 실패다.

## 서버 절반 (base=origin/track/engine, PR → track/engine)
1. 마이그레이션: `channel_read_state`에 nullable `marked_unread_before_seq` 추가.
2. `PUT read-state` 본문 확장 `markUnreadBeforeSeq`: 해당 채널 실존 seq 검증(미래·비존재 400). `last_read_seq` GREATEST 계약 불변.
3. **D4 해제**: 명시 열람 광고 경로(현행 read-state 전진이 일어나는 그 요청)에서 같은 tx로 마크 삭제. 구식 광고 재전송(마크 지점보다 낮은 seq의 GREATEST 광고)은 마크 불변 — 이 구분이 이 티켓의 심장이다: 실사로 현행 광고 요청의 의미(명시 열람 vs 백그라운드 동기화)를 확정하고, 구분이 불가능하면 **정지·보고**(요청 형상 변경은 오케스트레이터 판단).
4. read-state 응답/프로젝션에 마크 필드 노출(클라 소비 지점 실사).
5. red proof: ①마크 후 구식 광고 → 마크 생존 ②명시 열람 → 마크 소멸 ③미래 seq 400 ④GREATEST 회귀 0.

## 클라 절반 (base=origin/track/uxui, PR → track/uxui — 계약 핀 고정 + 모킹 시험)
1. **momo-core 합성 단일점**: 유효 unread 시작점 = 마크 있으면 `min(marked_unread_before_seq, last_read_seq+1)`(D3) — 함수 1개, 테스트 동반. 배지·UnreadDivider·UnreadPill·⌥↑↓ 항법이 전부 이 함수를 지나도록 소비 지점 배선(각 소비자의 기존 시험 그린 유지 + 마크 상태 시험 추가).
2. **진입점**: 메시지 ⋯ 메뉴에 「여기부터 안 읽음」(`messageActionModel.ts` — 기존 "Accrued" 주석 지점) + BT-1 행 컨텍스트 메뉴의 「읽음 처리」와 대칭 확인.
3. 마크 설정 즉시 로컬 반영(낙관) + 실패 롤백. 채널 열람 시 해제는 서버 응답 수렴.
4. 합성 이중화 grep 게이트: momo-core 함수 외 `marked_unread` 산술 금지.

## red proof (선행 커밋, 클라)
- 마크 → 사이드바 배지·디바이더·필이 일제히 그 지점 기준으로(한 함수 경유 단정)
- 채널 열람 → 마크 해제 후 표면 복귀
- 마크 없는 경로 회귀 0(기존 시험 전량 그린)

## 완료 절차
- engine: cargo test·기존 서버 게이트 → 커밋(#1934) → `git push -u origin feat/bt6-mark-unread-server` → `gh pr create --base track/engine` → 클라 절반으로.
- uxui: web vitest·core vitest·tsc·design_preflight_web.sh·CAPTURE_PORT=8587 capture:design(마크 상태 타임라인 프레임 두 스킴)·SHELL_GATE_PORT=8589 SHELL_GATE_FOCUS_ONLY=1 gate:shell → 커밋(#1934) → `git push -u origin feat/bt6-mark-unread-client` → `gh pr create --base track/uxui` → 정지. 마지막 출력에 PR URL 2건·변경 요약.
