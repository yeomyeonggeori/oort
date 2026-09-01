# 워커 브리프 — BT-2(#1930) 컴포저 `@`/`#`/`:` 자동완성 통일 (uxui)

> 워커: Opus 5 · base=origin/track/uxui · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. 서버 무접촉. MCP 금지.
> 참조(Apache-2.0): buzz `desktop/src/features/messages/ui/{MentionAutocomplete,ChannelAutocomplete,EmojiAutocomplete}.tsx` — **buzz는 트리거 파서가 세 파일로 갈라져 있다. 그 실수를 밟지 마라**(감사 §3-S5·§4 순위 5).

## 배경
oort는 `@` 1종만 있다(`features/chat/MentionAutocomplete.tsx`, Composer.tsx:96-98 소비). 캐럿·선택 유틸은 A7이 만든 `composerFormatPosition.ts`. 이모지 검색·빈도·스킨톤은 `features/emoji/`(search.ts·frequencyStore.ts·skinToneStore.ts)에 이미 정본이 있다.

## 구현 계약
1. **단일 트리거 파서**: `@`/`#`/`:` 세 트리거를 하나의 파서·하나의 후보 리스트 기계·하나의 키보드 처리(↑↓·Enter/Tab·Esc)로 통일 — 트리거별 차이는 데이터(후보 소스·삽입 직렬화)로만. 기존 `MentionAutocomplete`를 이 기계로 **흡수**하되 멘션의 현행 동작(비공백 캐럿 앵커 규율 포함 — 기존 시험 정본)이 1픽셀도 회귀하지 않아야 한다.
2. **`#` 채널**: 후보=현재 워크스페이스의 내 채널 목록(이미 받아 둔 roster/channel 스토어 — 새 서버 표면 금지). 삽입 직렬화는 **현행 멘션 직렬화 문법을 실사**해 동형으로(멘션이 토큰이면 채널도 토큰, 평문+링크면 동형). 렌더는 타임라인에서 클릭 시 `/c/{id}` 인앱 이동 — `anchor.ts` 딥링크 문법 재사용. 렌더러 개조가 과대해지면 v1은 「삽입=채널명 평문 + 후보 선택 UX」까지로 줄이고 렌더 링크화를 결정 주석으로 남겨라(축소 사유 명기 — 무단 축소 금지).
3. **`:` 이모지**: 2자 이상에서 발동(`:th` → 후보), 후보·빈도·스킨톤은 `features/emoji/` 정본 소비 — 피커와 다른 순위가 나오면 안 된다(같은 search.ts). 선택=유니코드 삽입 + frequencyStore 가산.
4. **억제 규칙**: 코드 서식(인라인/블록) 내부에서 3종 전부 억제 — A7 서식 트레이의 멘션 억제 규율과 한 정본.
5. 채널·스레드 컴포저 동형.

## red proof (선행 커밋)
- 파서 단일성: 트리거 3종이 한 기계를 지나는 구조 단정(파서 이중화 grep 게이트)
- `@` 기존 시험 전부 그린(회귀 0) + `#`·`:` 각 열림·선택·삽입·Esc 시험
- 코드 서식 내부 억제 3종 시험

## 완료 절차
web vitest·tsc·design_preflight_web.sh·CAPTURE_PORT=8547 capture:design(자동완성 열림 프레임 — `#`·`:` 각 1, 두 스킴)·SHELL_GATE_PORT=8549 SHELL_GATE_FOCUS_ONLY=1 gate:shell 그린 실측 → 커밋(#1930 참조) → `git push -u origin feat/bt2-composer-autocomplete` → `gh pr create --base track/uxui` → 정지. 마지막 출력에 PR URL·변경 요약.
