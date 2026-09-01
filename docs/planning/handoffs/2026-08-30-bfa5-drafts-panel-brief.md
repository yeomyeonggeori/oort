# 워커 브리프 — BF-A5(#1901) 크로스채널 초안 패널 (uxui)

> 워커: grok build CLI grok-4.6 · base=origin/track/uxui
> 정지 조건: 머지·이슈 close 금지. MCP 금지. 서버 무접촉.
> 참조: `~/projects/reference/buzz`(Apache-2.0) `desktop/src/features/messages/ui/DraftsPanel.tsx`·`DraftDetailPane.tsx`.

## 근거
- `clients/web/src/features/chat/draftStore.ts`가 채널·스레드별 초안을 **이미 저장** — 모아 보는 화면이 없어 흩어진 미전송 글이 사각지대.

## 구현 계약
1. **진입점**: 사이드바(인박스 근처, 기존 항법 문법)에 「초안」 항목 — 초안 0개면 항목 숨김(빈 메뉴 상시 노출 금지).
2. **목록**: draftStore 전체 조회 — 행마다 대상(채널명 또는 스레드 출처), 본문 미리보기(1줄 truncate), 상대시간. 정렬=최근 수정순.
3. **동작**: 행 클릭 → 해당 채널/스레드로 이동+컴포저에 초안 로드(기존 복원 로직 재사용). 행 액션: 삭제(확인 없이 — 초안은 로컬·복구 불가 명시 문구 대신 buzz처럼 가볍게? → **하우스 §6 판정: 파괴적이나 로컬 초안이라 무확인 삭제 허용, 단 실행 취소 불가이므로 삭제는 hover/⋯ 안에 숨기고 오클릭 방지**).
4. **빈 상태**: 진입 시 초안 0이면 사용법 카피("아직 초안이 없습니다. 쓰다 만 글은 자동으로 저장됩니다." 격).
5. draftStore 스키마 무변경(읽기 전용 소비). 채널 삭제/이탈된 대상의 고아 초안은 목록에 출처 불명으로 두지 말고 정리 규칙 판정(조사 후 PR 본문에 보고).

## red proof (선행 커밋)
- 목록 렌더(다중 채널·스레드 혼합)·정렬·미리보기 truncate.
- 클릭 → 이동+컴포저 복원 왕복.
- 삭제 → 스토어 반영·목록 갱신.
- 초안 0 숨김·빈 상태.

## 완료 절차
web vitest·tsc·design_preflight_web.sh·CAPTURE_PORT=8277 capture:design·SHELL_GATE_PORT=8279 SHELL_GATE_FOCUS_ONLY=1 gate:shell 그린 실측 → 커밋(이슈 번호 참조) → git push -u origin feat/bfa5-drafts-panel → gh pr create --base track/uxui → 정지.
