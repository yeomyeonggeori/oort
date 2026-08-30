# 워커 브리프 — BF-B2 클라 절반(#1889) 커스텀 상태 UI (uxui, A-42 소비)

> 워커: grok build CLI grok-4.6 · base=origin/track/uxui (B1 클라 랜딩 포함 최신)
> 정지 조건: 머지·이슈 close 금지. MCP 금지. server-rust 무접촉.
> 시작 절차: `git merge origin/main --no-edit`로 정렬부터.
> 정본: ADR-0176 (docs/adr/0176-custom-member-status.md) + ENGINE_HANDOFF A-42. **서버 절반(#1907)은 track/engine에만 있다** — 실서버 검증 불가, REST 소비층은 아래 고정 계약대로, 시험은 모킹. 정합은 main 승격 시.

## 고정 와이어 계약 (A-42 — 임의 변경 금지)
- 기존 `PUT/GET /v1/workspaces/{ws}/presence` 바디 확장: `status` 필수 유지 + optional `statusEmoji`/`statusText`/`statusExpiresAtMs`. **omit=유지, null=지우기.**
- roster projection에 3필드 노출. `type: presence` 브로드캐스트 동승(기존 레일).
- 만료 도달은 서버가 읽기에서 무시 — **클라는 지난 만기를 그리지 않는다**(로컬에서도 expiresAtMs < now면 비표시).

## 구현 계약
1. **사전 조사**: 현 선언 프레즌스(setPresenceStatus PUT) 소비층·이모지 피커·ProfileCard·명부 행·프로필 다이얼로그를 실코드로 확인.
2. **설정 다이얼로그**: 사이드바 ProfileCard(또는 기존 자기 프로필 진입점)에서 「상태 설정」 — 기존 이모지 피커 재사용 + 자유 텍스트(≤80자 — 서버 상한과 동일) + 만료 선택(지우지 않음/30분/1시간/오늘까지/커스텀) + 지우기. **프리셋 칩 5종(A-42 고정 카피): 회의 중 / 이동 중 / 병가 / 휴가 / 재택** — 칩 선택 시 이모지+텍스트 채움(이모지는 카피에 맞게 워커가 선정, 과장 금지).
3. **표시**: 사이드바 ProfileCard·명부(멤버 목록) 행·프로필 다이얼로그. 선언 3종(auto/away/dnd)과 **별도 축 동시 표시**(대체 금지). 이모지 단독이면 이모지만, 텍스트는 truncate+title.
4. **쓰기 주의**: PUT 바디에서 건드리지 않는 필드는 omit(기존 status 필수 동봉). 지우기는 3필드 null.
5. 4상태·다크/라이트 토큰·모션 신설 금지·§7 카피. 접근성: 상태는 장식 아님 — 명부 행 접근성 이름에 텍스트 포함(이모지는 aria-hidden), 다이얼로그 포커스 트랩 기존 문법.
6. localStorage 신설 불요(서버 SoT). gitleaks 오탐 시 .gitleaksignore fingerprint+사유.

## red proof (선행 커밋)
- PUT 바디 형상(omit vs null) 자구 대조 모킹 왕복(설정→roster 반영→지우기).
- 80자 초과 클라 측 차단(입력 상한).
- 만료 지난 상태 비표시(고정 now 주입).
- 프리셋 칩 5종 카피.
- 선언 프레즌스 3종 회귀(동시 표시 축 분리).

## 완료 절차
web vitest·tsc·design_preflight_web.sh·CAPTURE_PORT=8517 capture:design·SHELL_GATE_PORT=8519 SHELL_GATE_FOCUS_ONLY=1 gate:shell 그린 실측 → 커밋(#1889) → git push -u origin feat/1889-bfb2-status-client → gh pr create --base track/uxui → 정지. 마지막 출력에 PR URL과 변경 요약.
