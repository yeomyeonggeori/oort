# 워커 브리프 — BF-A7(#1902) 컴포저 서식 최소셋 — 선택 시 부유 트레이 (uxui)

> 워커: grok build CLI grok-4.6 · base=origin/track/uxui (A5 랜딩 포함 최신)
> 정지 조건: 머지·이슈 close 금지. MCP 금지. 서버 무접촉. **TipTap/에디터 교체 금지 — textarea 유지.**
> 참조: `~/projects/reference/buzz`(Apache-2.0) `desktop/src/features/messages/ui/SelectionFormattingTray.tsx`(포털+상하 배치+뷰포트 클램프 문법만 — TipTap 명령부는 비이식).

## 근거
- 렌더는 마크다운(MessageBody + momo-core markdown)인데 컴포저는 맨 textarea — 굵게/코드/링크를 문법 아는 사람만 쓴다.

## 구현 계약
1. **선택 시 부유 트레이**: 컴포저 textarea에서 텍스트 선택(selectionStart≠End) 시 선택 영역 위(공간 없으면 아래)에 소형 트레이 — 버튼 4개: **굵게(B)·기울임(I)·인라인 코드·링크**. 렌더러가 실제 지원하는 문법만(사전 조사: momo-core markdown이 소비하는 문법 확인 — 미지원 문법 버튼 금지).
2. **적용 방식**: selectionStart/End 기반 마크다운 접사 삽입/제거(토글 — 이미 감싸져 있으면 해제). 링크는 `[선택](url)` 삽입 후 url 자리 선택. 실행 후 선택·캐럿 위치 보존(재선택). draftStore 저장 흐름 무간섭.
3. **키보드**: ⌘B/⌘I(관례 단축키, 트레이 없이도 동작), 트레이 자체는 선택 유지 중 Tab 도달 가능(포커스 뺏지 않는 mousedown preventDefault 문법). Esc로 닫기.
4. **표시 조건**: 마우스/키보드 선택 공통, 선택 해제·전송·채널 전환 시 소멸. reduced-motion 즉시. 뷰포트 클램프(buzz 문법).
5. 채널·스레드 컴포저 동형. 멘션 자동완성(MentionAutocomplete)과의 충돌 없음(@ 트리거 중 트레이 억제 판정 포함).
6. 트레이 버튼은 기존 아이콘 버튼 문법(lucide Bold/Italic/Code/Link, 16px, focus-visible 링, aria-pressed 아님 — 순간 동작).

## red proof (선행 커밋)
- 토글 왕복(적용→해제)·경계(빈 선택 무동작·다중 줄 선택·기존 접사 부분 겹침).
- ⌘B/⌘I 삽입, 선택 보존.
- 멘션 트리거 중 트레이 억제.
- 채널·스레드 동형, draft 저장 회귀.

## 완료 절차
web vitest·tsc·design_preflight_web.sh·CAPTURE_PORT=8477 capture:design·SHELL_GATE_PORT=8479 SHELL_GATE_FOCUS_ONLY=1 gate:shell 그린 실측 → 커밋(#1902) → git push -u origin feat/1902-bfa7-composer-format → gh pr create --base track/uxui → 정지.
