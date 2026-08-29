# 워커 브리프 — BF-A4(#1887) 알림 설정 세분화 (uxui)

> 워커: grok build CLI grok-4.6 · base=origin/track/uxui (A3 랜딩 포함 최신)
> 정지 조건: 머지·이슈 close 금지. MCP 금지. 서버 무접촉(로컬 프리퍼런스+Notification API만).
> 참조: `~/projects/reference/buzz`(Apache-2.0) `desktop/src/features/settings/ui/NotificationSettingsCard.tsx` — 그룹 구조·권한 분기 카피. 알림음은 이 티켓 범위 밖.

## 근거
- 현 설정: NotificationRulesSection = DND+멘션 예외 2토글. DesktopNotifications.tsx(165줄)는 무렌더 배선 — **권한 상태를 사람이 볼 화면이 없어** "왜 알림이 안 오지"를 진단 불가.

## 구현 계약
1. **사전 조사(구현 전 필수)**: 현 알림 발화 경로를 실코드로 목록화 — DesktopNotifications가 어떤 이벤트 종류(DM/멘션/일반 채널/스레드/승인 등)를 구분해 쏘는지. **실존 종류만** 토글 대상으로 삼고, 미구현 종류는 자리(準備中 문구 포함)를 만들지 않는다.
2. **데스크탑 알림 그룹**(설정 알림 섹션 확장): 권한 상태 3분기 표면화 — granted(켜짐 표시)/default(「알림 켜기」 요청 버튼, 요청 중 라벨 전환)/denied(브라우저 설정 안내 문장 배너). 미지원(웹뷰 등) 분기 포함. buzz 카피 구조 참조하되 문장은 한국어 하우스 문체.
3. **종류별 on/off**: 조사된 실존 이벤트 종류별 토글(로컬 프리퍼런스, `momo.web.notifications.v1` — 신규 저장 키는 기존 preference 스토어 관례 따름). 발화 경로가 토글을 실제로 소비(꺼진 종류는 미발화 — 테스트로 증명).
4. 기존 DND·멘션 예외 규칙(서버 저장)과의 관계를 카피로 명시(현행 문서화 품질 유지 — "규칙은 서버에 하나, 종류별 끔은 이 기기").
5. BZ-4 설정 전면 레이아웃의 알림 섹션 안에서 그룹 리듬 유지.

## red proof (선행 커밋)
- 권한 3분기 렌더(모킹) + 요청 버튼 상태 전환.
- 종류 토글 → 발화 경로 미발화 증명(각 종류).
- 기존 DND 규칙 저장 회귀 그린.

## 완료 절차
web vitest·tsc·design_preflight_web.sh·CAPTURE_PORT=8077 capture:design·SHELL_GATE_PORT=8079 SHELL_GATE_FOCUS_ONLY=1 gate:shell 그린 실측 → 커밋(#1887) → git push -u origin feat/1887-bfa4-notifications → gh pr create --base track/uxui (본문에 사전 조사 목록 포함) → 정지.
