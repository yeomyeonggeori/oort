# 워커 브리프 — BZ-4(#1867) 설정 전면 페이지 + Profile 섹션 (uxui)

> 워커: grok build CLI grok-4.6 · base=origin/track/uxui
> 정지 조건: 머지·이슈 close 금지. MCP 금지.
> 참조: `~/projects/reference/buzz`(Apache-2.0) `desktop/src/features/settings/` — 좌측 전용 사이드바(섹션 그룹 Personal/Communities/App) + 「Back to app」 + 넓은 본문. 성재 스크린샷 동형.
> 서버: **A-40 ready** (ENGINE_HANDOFF.md) — `PATCH /v1/workspaces/{ws}/members/me` `{displayName}` (#1873, track/engine 랜딩). 정규화 위반 400 `displayName is required`(join과 같은 문장), 응답 `{ member }`. **주의: track/uxui에는 아직 미포함일 수 있음 — 클라 배선은 API 계약 기준으로 작성하고 통합 테스트는 모킹**.

## 근거 (성재 검수 2026-08-29, #1867)
- 현 설정은 앱 셸 안 한 패널 — buzz처럼 설정 진입 시 **사이드바까지 대체되는 전면 레이아웃**(전용 섹션 사이드바 + 돌아가기 + 더 큰 본문)을 원함. Profile에서 내 프로필 변경 가능해야 함.

## 구현 계약
1. **전면 레이아웃**: `/settings` 진입 시 앱 사이드바·타이틀바 컨텍스트 대신 설정 전용 레이아웃 렌더 — 좌측: 섹션 전용 사이드바(기존 섹션 전부 이관, 의미 그룹핑: 개인(프로필·계정·알림 계열)/워크스페이스(워크스페이스·멤버와 초대·역할 표시명 등 기존 구성 따름)/연결(AI 연결·이벤트 구독·웹훅·사용량 등) — **기존 섹션 명칭·순서 임의 변경 금지, 그룹 라벨만 신설**), 최상단 「← 앱으로 돌아가기」. 본문 폭 확대(기존보다 넓게, 기존 spacing 토큰 내).
2. **회귀 0**: 기존 섹션 컴포넌트 전부 재사용(내용 무접촉), `/settings` 라우트·딥링크·⌘, 단축키·뒤로가기(브라우저 히스토리) 유지. 로그아웃(계정 섹션·프로필 메뉴) 경로 불변.
3. **Profile 섹션 신설**(사이드바 개인 그룹 최상단): 내 아바타(현행 표시만 — 업로드는 서버 표면 부재로 미탑재, 빈 자리·"준비 중" 문구 금지), **표시 이름 편집** — momo-core에 `changeMyDisplayName(workspaceId, displayName)` API 함수 신설(PATCH members/me, 응답 member 파싱) → 저장 시 1회 호출, 400 문장 그대로 표면화(InlineBanner), 성공 시 roster·세션 표시 이름 invalidate(낙관 갱신 금지). 핸들은 읽기 전용 Fact.
4. 접힘·전환: 앱→설정, 설정→앱 전환에 과한 모션 금지(기존 라우트 전환 관례). 반응형: 좁은 폭에서 설정 사이드바 접힘(기존 브레이크포인트 관례).

## red proof (선행 커밋)
- 전면 레이아웃 렌더·전 섹션 도달·돌아가기·⌘, 왕복.
- Profile: 이름 편집 PATCH 1회(모킹)·400 문장 도달·성공 시 invalidate·낙관 갱신 없음.
- 기존 설정 테스트 전부 그린(이관 후에도).
- capture:design·gate:shell 등 설정 지나는 레인 그린(레인이 설정 신 레이아웃 프레임 최소 1장 확보).

## 완료 절차
web vitest·tsc·design_preflight_web.sh·CAPTURE_PORT=6677 capture:design·SHELL_GATE_PORT=6679 SHELL_GATE_FOCUS_ONLY=1 gate:shell 그린 실측 → 커밋(#1867) → git push -u origin feat/1867-bz4-settings-page → gh pr create --base track/uxui (본문에 red proof+스크린샷) → 정지. design-review는 오케스트레이터 몫.
