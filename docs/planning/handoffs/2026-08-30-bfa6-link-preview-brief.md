# 워커 브리프 — BF-A6(#1903) 링크 프리뷰 Rich/Compact 선택 (uxui, 서버 0)

> 워커: grok build CLI grok-4.6 · base=origin/track/uxui (A7 랜딩 포함 최신)
> 정지 조건: 머지·이슈 close 금지. MCP 금지. 서버 무접촉(같은 unfurl 데이터만 소비).
> 시작 절차: `git merge origin/main --no-edit`로 정렬부터.

## 근거
- 현 링크 프리뷰는 folded boolean(linkPreviewPreference) — 접기/펴기 2값뿐. 이미지가 큰 unfurl에서 히어로형 카드가 없어 링크 공유 경험이 밋밋하다(버즈 격차 A6).

## 구현 계약
1. **사전 조사**: linkPreviewPreference의 저장 위치·소비 지점(타임라인 unfurl 렌더러)·설정 표면을 실코드로 확인하고 조사 결과를 커밋 메시지/PR 본문에 적어라.
2. **3값 선호**: `rich | compact | off`. 기존 boolean 저장값 마이그레이션 — 기존 사용자의 선택 의미 보존(접힘=compact 계열, 꺼짐이 있으면 off — 실제 의미는 조사로 판정하고 매핑 근거를 명기). localStorage 키는 기존 `momo.web.*` 관례. gitleaks가 키 상수를 generic-api-key로 오탐하면 `.gitleaksignore`에 fingerprint+사유 추가(선례 2건 있음).
3. **Rich 카드 신설**: 같은 unfurl 데이터로 히어로 이미지형 카드 — 이미지 상단(max 높이 제한·cover·라운드는 집안 토큰), 아래 제목/도메인/설명(설명 2줄 클램프). 이미지 없는 unfurl은 rich여도 compact 모양으로 강등(빈 히어로 금지). 이미지 로드 실패 시에도 강등. 다크/라이트 두 스킴, 대비는 집안 토큰만.
4. **Compact**: 기존 접힘 카드 유지(회귀 0). **Off**: 프리뷰 미렌더(링크 텍스트만).
5. **설정 표면**: 설정의 링크 미리보기 섹션에서 3값 선택 — 집안 라디오/세그먼트 문법 승계(형제 설정 컨트롤 문법을 실코드로 확인 후 동형). 선택 즉시 타임라인 반영(재로드 불요). BZ-5a(외양) 랜딩 시 그 표면으로 이관 가능하므로 컴포넌트는 이관 가능한 단위로.
6. 접근성: rich 카드 전체가 하나의 링크(내부 이중 탭스톱 금지), 이미지는 장식(aria-hidden 또는 빈 alt), focus-visible 링. 모션 신설 금지.

## red proof (선행 커밋)
- boolean→3값 마이그레이션 왕복(기존 두 값 각각의 매핑).
- rich에서 이미지 없음/로드 실패 → compact 강등.
- off에서 unfurl 미렌더.
- 설정 변경 즉시 타임라인 반영.
- 카드 단일 탭스톱.

## 완료 절차
web vitest·tsc·design_preflight_web.sh·CAPTURE_PORT=8487 capture:design·SHELL_GATE_PORT=8489 SHELL_GATE_FOCUS_ONLY=1 gate:shell 그린 실측 → 커밋(#1903) → git push -u origin feat/1903-bfa6-link-preview → gh pr create --base track/uxui → 정지. 마지막 출력에 PR URL과 변경 요약.
