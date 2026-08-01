# goal B9 — 모바일 디테일 정밀화 (네이티브 앱 수준 체감)

너는 momo 레포의 구현 worker다(Claude Opus 5). 이 문서가 유일한 지시서.
**base = `track/engine`**. 워크트리 `~/projects/momo-tracks/momo-worktrees/B9-mobile-polish`(브랜치 `feat/B9-mobile-polish`, 생성됨).
**발단: 성재 iPhone 실캡처 2장**(2026-08-02 22:54, Safari). B6가 통과시킨 자동 게이트가 놓친 실기기 조건이 드러났다 — 이 배치는 **실기기 조건 재현**이 절반이다.

## 0. 실측된 결함 (캡처 근거)
1. **가로 스크롤 실발생** — 2번 캡처에서 좌측 아바타·여백이 화면 밖으로 밀려 콘텐츠가 잘림. 원인 후보: 메시지 본문의 **긴 무공백 토큰**(`@oort ...—답변이` 같은 CJK+기호 연쇄)이 `min-width:auto`인 flex/grid 자식을 밀어냄. **`overflow-wrap:anywhere` + `min-w-0` + `max-w-full`을 텍스트 조상 사슬 전체에** 적용해야 한다. 자동 게이트가 0으로 통과한 건 픽스처 문장이 짧아서다 — **긴 무공백 토큰 픽스처를 추가해 게이트가 이 결함을 재현하게 만들 것.**
2. **컴포저가 iOS Safari 하단 바에 가림** — 1·2번 캡처 모두 입력창이 URL 바 뒤. `100dvh`+`env(safe-area-inset-bottom)`만으로 부족(Safari 하단 툴바는 dvh에 포함되지 않는 구간이 있음). `visualViewport` API로 실제 가시 높이를 추적해 컴포저를 그 위에 고정하고, 키보드 열림 시에도 따라오게 할 것.
3. **1번 캡처: 헤더 아래 콘텐츠가 상단에 붙어 답답** — 안전영역·타임라인 상단 패딩 점검.
4. **마크다운 미렌더(`**` 노출)** — B8이 담당(중복 금지, B8 랜딩분과 충돌 시 B8 우선).

## 1. 할 일
- 위 1~3 수정 + 모바일 체감 디테일: 스크롤 관성(`-webkit-overflow-scrolling`)·오버스크롤 격리(`overscroll-behavior: contain`)·탭 하이라이트 제거·pull-to-refresh 오작동 방지·긴 단어 줄바꿈 전역 규칙.
- **게이트 강화(핵심)**: capture:design 모바일 프로파일에 ①긴 무공백 토큰 메시지 픽스처 ②`visualViewport` 축소 상황(하단 바 가정: 뷰포트 높이 -100px)에서 컴포저 가시성 단언 ③가로 오버플로 단언을 **문서·모든 스크롤 컨테이너**로 확대.
- 실기기 근사: 캡처를 `deviceScaleFactor:3`·iPhone UA로.

## 2. 하지 말 것
B8 범위(Enter·마크다운·오류문구·연결배너·날짜)·새 기능·서버 변경.

## 3. 검증·PR
npm build+tsc+test+lint+preflight+모바일 캡처(신규 픽스처 포함) + 데스크탑 회귀 0. PR `feat/B9-mobile-polish` → `track/engine`. 본문: 결함별 원인·수정·게이트가 이제 잡는다는 증거(픽스처 추가 전 red)·이탈. **PR 후 STOP.**
