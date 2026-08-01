# goal B6 — 모바일 반응형 셸 (도그푸딩 실사용 차단 해소)

너는 momo 레포의 구현 worker다(Claude Opus 5). 이 문서가 유일한 지시서.
**base = `track/engine`**(B5.4c 랜딩 이후). 워크트리 `~/projects/momo-tracks/momo-worktrees/B6-mobile`(브랜치 `feat/B6-mobile`, 생성됨).
실측 배경: 성재 iPhone 실캡처 — 데스크탑 3-pane이 폰 폭에 그대로 눌림(사이드바 절반 점유·타임라인 협착·컴포저 잘림) + 허들 미구현 표면이 빨간 에러 배너 노출.

## 0. 규율
`.env` 금지 · **PR 후 STOP**(amend/force-push 금지) · 대상 `clients/web/**`만 · `~/.claude/skills/momo-design-taste/SKILL.md` 원칙 · 기능 로직 무변경(레이아웃·네비게이션 상태·capability 게이트만) · 기존 데스크탑 레이아웃 회귀 0(1280 캡처 불변이 증거).

## 1. 할 일
- **브레이크포인트 셸**: 좁은 폭(모바일)에서 ①사이드바=오버레이 드로어(햄버거 토글·바깥 탭 닫힘·Esc) ②단일 pane 네비(목록↔타임라인 push, 뒤로가기) ③컴포저 하단 고정+iOS 세이프에어리어(env(safe-area-inset)) ④터치 타깃 최소 44px ⑤가로 오버플로 0.
- **허들 배너 게이트**: 허들 상태 조회가 404/501(미구현)일 때 에러 배너 대신 **표면 자체 숨김**(기존 capability 패턴 — §4.1 거짓말 금지: unknown은 조용히 접기, 실패 문구는 실제 지원 서버의 장애일 때만).
- **viewport 메타·터치 스크롤** 점검(index.html).
- **캡처 확장**: capture:design에 모바일 뷰포트(390×844) 프로파일 추가 — 핵심 화면(로그인·채널·사이드바 드로어·허브·인박스) × 라이트/다크.

## 2. 검증·PR
npm build+tsc+test+lint+preflight + **데스크탑 1280 캡처 회귀 0**. PR `feat/B6-mobile` → `track/engine`. 본문: 브레이크포인트 설계·드로어 접근성(초점 트랩)·모바일 캡처 목록·이탈. **PR 후 STOP.**
