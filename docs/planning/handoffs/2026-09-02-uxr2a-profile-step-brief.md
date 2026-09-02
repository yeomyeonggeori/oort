# 워커 브리프 — UX-R2a 온보딩 S3 프로필 스텝 (BZ-6b) (uxui · UX-R1a 후)

> 워커: grok 4.6 · base=origin/track/uxui · ms 리터럴 금지 · MCP 금지 · 서버 무접촉(자기 표시 이름 `PATCH /v1/workspaces/{ws}/members/me` #1873 랜딩됨; 아바타 업로드 서버 표면은 **실사 후 없으면 표시 이름만**·아바타는 NOTES 갭).
> 정본: `research/2026-08-29-bz6-onboarding-design.md` v2.1 S3(표시 이름·아바타, "지금은 건너뛰기" 상시, 저장 실패에도 전진 — buzz `ProfileStepSaveRecovery` 동형)·BZ-6a 셸(`src/features/auth/onboardingFlow.ts` 3스텝 landing/gateway/account + `OnboardingSlideTransition`)·ADR-0179(전환은 온보딩 예외 사다리 유지).

## 구현 계약
1. `onboardingFlow.ts`에 `profile` 스텝 추가(account 뒤), 카운터 4단계, `transitionFor()` line-slide. 필드: 표시 이름(기본값=가입 이름, 80자 상한·실시간 검증 문장), 아바타(서버 표면 있을 때만).
2. 「건너뛰기」 상시(같은 위계 보조 버튼), 저장 실패 시 InlineBanner + **전진 허용**(복구 설계: 다음 진입에서 설정 › 프로필로 안내 문장).
3. 완료 후 워크스페이스 착지(S4 킥오프는 UX-R2b가 잇는다 — 이 티켓은 착지 지점만 훅으로 남김).
4. `e2e/advanceOnboarding.mjs` 갱신(4스텝) — 모든 캡처/게이트 레인이 통과.

## red proof (선행 커밋)
- 저장 실패 → 배너+전진 · 건너뛰기 → PATCH 미호출 · 이름 81자 → 문장형 거부 · 4단계 카운터 문자열 · reduced-motion 전환 none.

## 완료 절차
vitest·tsc·lint 0·preflight·`CAPTURE_PORT=8641`(S3 두 스킴)·`SHELL_GATE_PORT=8643 SHELL_GATE_FOCUS_ONLY=1`·e2e connect 스모크·`verify_merge_tree.sh` → PR → track/uxui → 정지.
