# 워커 브리프 — BZ-6a(#1869) 온보딩 스텝 셸 + S0 오르트 랜딩 (uxui)

> 워커: grok build CLI grok-4.6 (레인 전환 — 성재 2026-08-29 지시) · base=origin/track/uxui
> 정지 조건: 머지·이슈 close 금지. 워크트리 밖 파일 수정 금지. MCP/외부 도구 호출 금지.
> 설계 정본: docs/planning/research/2026-08-29-bz6-onboarding-design.md (v2.1) + 2026-08-29-buzz-onboarding-research.md
> 참조 코드: `~/projects/reference/buzz`(Apache-2.0 — 참조·이식 가능, 파일 단위 이식 시 출처 주석 1줄): `desktop/src/features/onboarding/ui/{OnboardingSlideTransition,LandingBees,MachineOnboardingFlow}.tsx`, `desktop/src/shared/ui/buzz-logo/FlappingBee.tsx`, `desktop/src/shared/styles/globals/components.css`의 `buzz-onboarding-*`.

## 범위 (BZ-6a만 — 프로필 스텝·웰컴 킥오프는 후속)
ConnectPage 단일 폼을 3스텝 온보딩으로 개편한다. **로그인·join·서버 검증 로직과 API 호출은 기존 것을 그대로 재사용**(기능 회귀 0 — 이 티켓은 표면 개편).

### S0 랜딩 — "오르트 구름을 지나 들어온다"
1. **단일 룩 커밋**(두 스킴 없음): 딥 스페이스 다크 잉크 면 + 성긴 별 격자(radial-gradient 1px 점, 성김 간격). 색은 **raw color 금지 — tokens.css에 온보딩 전용 토큰 신설**(예: `--onboarding-space`, `--onboarding-star` 등, 단일-룩 예외라 스킴 분기 없이 정의) 후 유틸리티 경유.
2. 중앙 **OortMark**(clients/web/src/design/brand/OortMark.tsx 재사용) 대형 스케일: 등장 시 궤도 stroke 드로잉(dashoffset) → 이후 미세 부유/회전. 마크 path 변형 금지.
3. **오르트 구름 산포 필드**: 라인아트 소도형 3종(혜성=머리원+꼬리 스트로크·소행성=불규칙 다각 라인·별=4촉 스파클) SVG 컴포넌트 신설(currentColor, 단일 스트로크 굵기, 채움 없음, 3D/그라데이션 금지). ~30개를 **가장자리 껍질 배치**(중앙 40%는 비움 — 오르트 구름 서사), 크기 22–36px·회전 변주·2색(액센트/연한 잉크 톤 토큰). 모션은 buzz LandingBees 문법 이식: rAF 배회(개체별 비정합 사인파, WANDER 26/20) + 마우스 반발(반경 180, 강도 110, easing 0.12) + 반짝임은 CSS 키프레임(HTML 레이어 — 컴포지터). `prefers-reduced-motion`이면 rAF 미기동·정지.
4. 하단 2택: 「우리 팀 서버로 접속」 / 「초대 링크로 참여」. 진행바 없음, 중앙 정렬.

### S1 서버/초대 · S2 계정
- S0 선택에 따라: 서버 주소 입력(+최근 접속 서버 칩 — localStorage 이력, 시크릿 아님) 또는 초대 코드 → S2는 로그인(이메일·비번) 또는 join(이름·핸들·비번). 기존 검증·오류 문장 유지.
- 상단 진행 표시(2/3, 3/3 — S0 제외)와 뒤로가기. 각 스텝 카드는 기존 라이트/다크 토큰 화면(단일 룩은 S0만).

### 전환 시스템 (buzz 동형 이식)
- `OnboardingSlideTransition` 동형 컴포넌트: effect `fade|line-slide|mask-reveal-down|mask-reveal-up|none` × direction `forward|backward`. line-slide 650ms `cubic-bezier(0.22,1,0.36,1)`, mask-reveal 760ms, **fill-mode backwards**(buzz 주석의 fixed-포지셔닝 함정 회피 이유 승계). S0→S1은 mask-reveal(다크→라이트 진입 서사), S1↔S2는 line-slide. reduced-motion 즉시 전환.

### 회귀 불변
- `/join?code=` 딥링크·claim 경로·서버 검증 오류 문장·`momo.web.server.v1` 저장 의미론 전부 현행 유지. 재방문(저장 서버 존재) 시 S0 자동 스킵.

## red proof (선행 커밋)
- S0 렌더(마크·산포 필드·2택)·reduced-motion에서 rAF 미기동.
- 2택→S1 분기, S1→S2 전환, 뒤로가기, 진행 표시.
- 기존 로그인·join 플로우 테스트 전부 그린(스텝 구조로 감싼 뒤에도).
- 딥링크 /join?code= 진입 시 스텝 셸이 코드 경로를 깨지 않음.

## 완료 절차
웹 vitest + tsc + scripts/design_preflight_web.sh 자가 실행 → 커밋(#1869 참조, BZ-6a 명시) → git push -u origin feat/1869-bz6a-onboarding-shell → gh pr create --base track/uxui (본문에 red proof) → 정지. 마지막 출력에 PR URL과 변경 요약. design-review는 오케스트레이터 몫.
