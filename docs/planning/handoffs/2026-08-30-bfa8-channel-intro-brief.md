# 워커 브리프 — BF-A8(#1904) 채널 빈 상태 인트로 블록 (uxui, 서버 0)

> 워커: grok build CLI grok-4.6 · base=origin/track/uxui (A6 랜딩 포함 최신)
> 정지 조건: 머지·이슈 close 금지. MCP 금지. 서버 무접촉.
> 시작 절차: `git merge origin/main --no-edit`로 정렬부터.
> 참조: `~/projects/reference/buzz`(Apache-2.0) — ChannelIntroBlock 계열을 grep으로 찾아 leading-row 편입 문법만 참조(파일 수준 이식이면 "(Apache-2.0)" attribution 주석, 집안 선례: OortCloudField.tsx:10).

## 근거
- 새 채널 첫 진입이 맨 빈 화면 — 채널이 무엇이고 지금 무엇을 하면 되는지 화면이 말하지 않는다(버즈 격차 A8).

## 구현 계약
1. **사전 조사**: 타임라인 가상화(virtuoso)의 leading row/헤더 행 처리와 현 빈 채널 렌더 경로를 실코드로 확인. 인트로 블록은 **가상화 leading row와 동일 컴포넌트 계층**으로 — 메시지가 도착해도 레이아웃 시프트 0(인트로가 스크롤 이력의 맨 위 행으로 자연히 밀려 올라감)이 핵심 설계다. 오버레이/절대배치 금지.
2. **내용**: 채널 아이콘(집안 문법)+`#채널이름` 큰 제목+시작 카피(채널 목적 설명 — 채널 description 있으면 인용, 없으면 일반 카피)+생성 시점/생성자(로컬에 있는 데이터만). 카피는 한국어, 과장 금지(§7).
3. **액션 카드**: 최대 2~3개 — ①멤버 초대(기존 초대 표면으로 연결) ②첫 메시지 쓰기(컴포저 포커스). 이미 있는 라우팅/포커스 경로만 사용, 새 모달 금지. 권한 없는 액션(초대 불가 역할)은 숨김 — 기존 권한 판정 헬퍼 사용.
4. **표시 조건**: 메시지 0개 채널 최상단. 메시지가 생기면 인트로는 히스토리 맨 위에 남는다(buzz 문법). 스레드 패널 비대상. DM 채널은 상대 중심 카피로 분기(과설계 금지 — 아이콘·이름·카피만 교체).
5. 다크/라이트 집안 토큰만, 모션 신설 금지, 밀도는 타임라인과 동조(§2). 접근성: 제목은 헤딩 계층, 액션 카드는 버튼/링크 시맨틱+focus-visible 링, 탭 순서는 문서 순서.

## red proof (선행 커밋)
- 메시지 0 → 인트로 렌더, 메시지 도착 → 시프트 0(높이 불변·스크롤 위치 유지)을 시험으로.
- 권한 없는 역할에서 초대 카드 숨김.
- DM 분기 카피.
- 첫 메시지 쓰기 → 컴포저 포커스 실측.

## 완료 절차
web vitest·tsc·design_preflight_web.sh·CAPTURE_PORT=8497 capture:design·SHELL_GATE_PORT=8499 SHELL_GATE_FOCUS_ONLY=1 gate:shell 그린 실측 → 커밋(#1904) → git push -u origin feat/1904-bfa8-channel-intro → gh pr create --base track/uxui → 정지. 마지막 출력에 PR URL과 변경 요약.
