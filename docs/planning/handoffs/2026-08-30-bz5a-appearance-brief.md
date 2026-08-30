# 워커 브리프 — BZ-5a(#1868 1차) 외양 커스터마이제이션 — 토큰 바인딩 층+컬러 모드+액센트 큐레이션 (uxui)

> 워커: grok build CLI grok-4.6 · base=origin/track/uxui (B2 랜딩 포함 최신)
> 정지 조건: 머지·이슈 close 금지. MCP 금지. 서버 무접촉.
> 시작 절차: `git merge origin/main --no-edit`로 정렬부터.
> 정본: **ADR-0174 Accepted** (docs/adr/0174-appearance-customization.md) — D1~D5 전부 구속. 이 1차는 페이징 BZ-5a 범위만: **토큰 바인딩 층 + 컬러 모드 UI + 액센트 큐레이션 N종 + 대비 전수 테스트**. 폰트/밀도/라이브 프리뷰는 5b, 기능 축은 5c — 손대지 마라.
> ⚠️ **액센트 후보 세트는 성재 확정 대상** — 이 PR은 시안 산출까지. 머지는 오케스트레이터가 성재 확인 후 집행한다.

## 구현 계약
1. **D1 토큰 2층**: 컴포넌트는 의미 토큰만 소비(현행 유지·게이트 유효). 신설 `clients/web/src/design/themes/` 디렉토리에 바인딩 층 — 액센트 테마 파일들이 `--accent`/`--accent-soft`/`--accent-strong` 계열(실제 파생 토큰은 tokens.css 실사로 확정)의 라이트·다크 쌍 값을 정의. 적용은 루트 `data-accent` 속성(또는 동급 문법 — CSS 변수 재정의, 인라인 style 금지).
2. **컬러 모드**: System/Light/Dark 3상태 UI 신설 — 현행 시스템 연동 로직 실사 후 그 위에 명시 선택 저장. 설정 Appearance 섹션(기존 설정 문법 — ChoiceRadios).
3. **액센트 큐레이션**: 기본=Dawn 호박(항상 첫 값·기본값) + 후보 5종 내외. 각 후보는:
   - 라이트·다크 쌍으로 정의, 이름은 오르트 우주 서사 결(한국어 — 예: 새벽/성운/혜성 계열, 워커가 짓되 과장 금지 §7).
   - **사전 검증 기계 강제**: tokens.contrast 테스트를 테마 쌍 전수 실행으로 확장 — 각 후보의 accent-on-surface AA(4.5:1 텍스트/3:1 컨트롤)·`--agent` 파랑과의 거리(CIEDE2000 또는 hue 거리 — 로고·에이전트 정체성 충돌 방지, 파랑 계열 후보 배제) 단정. **테마 추가=대비 테스트 추가가 기계 강제되는 구조**(테마 파일 열거가 테스트 입력).
   - 선택 UI: Appearance 섹션 스와치(선택 상태 aria-pressed 또는 radio 문법, 44 터치, focus-visible).
4. **저장**: `momo.web.appearance.v1` localStorage(D3 — 이 기기). 즉시 적용(재로드 불요). gitleaks 오탐 시 .gitleaksignore.
5. **D4 브랜드 영향권**: 온보딩 S0(오르트 랜딩)·브랜드 락업 표면은 커스텀 액센트 비적용 — 해당 표면이 의미 토큰을 어떻게 소비하는지 실사 후 격리(단일 룩 고정). 시험으로 단정.
6. **D5 게이트 재정의**: design_preflight/raw_color 게이트가 themes/ 디렉토리를 허용 목록으로 — **게이트 스크립트 접촉 시 약화 금지·정확히 ADR 문면대로**(사전 검증된 테마 바인딩 외 금지로 재술). 정본 문서 §2·§7과 momo-design-taste-web 레퍼런스 개정 동반(같은 PR — ADR 귀결).
7. **시안 산출(성재 확정용)**: capture:design에 액센트 후보 전수 장면 — 후보별 라이트·다크로 실제 대화 화면(사이드바+타임라인+컴포저) 1프레임씩. 산출물 파일명 `accent-<이름>-{light,dark}.png`. 이것이 성재 확정 시안이다.

## red proof (선행 커밋)
- 후보 전수 대비 단정(AA·3:1·agent 거리) — 후보 하나를 일부러 낮은 대비로 넣어 RED 확인 후 제거.
- 컬러 모드 3상태 왕복·시스템 추종.
- 액센트 전환 즉시 반영·기본 복귀.
- 온보딩 S0 격리(액센트 바꿔도 불변).

## 완료 절차
web vitest·tsc·design_preflight_web.sh·CAPTURE_PORT=8527 capture:design·SHELL_GATE_PORT=8529 SHELL_GATE_FOCUS_ONLY=1 gate:shell 그린 실측 → 커밋(#1868 참조) → git push -u origin feat/1868-bz5a-appearance → gh pr create --base track/uxui (본문에 시안 파일 목록 명기) → 정지. 마지막 출력에 PR URL·후보 이름 목록·변경 요약.
