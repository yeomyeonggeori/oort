# 워커 브리프 — UX-R2b 웰컴 킥오프 클라 스테이지 (BZ-6c) (uxui · ADR-0181 D7 · A-45 소비 · UX-R1d 후)

> 워커: grok 4.6 · base=origin/track/uxui · ms 리터럴 금지 · MCP 금지 · 서버 무접촉(A-45: 서버가 가입 직후 `#general`에 오프너 run 또는 provider-required 정적 안내를 **에이전트 명의**로 보낸다).
> 정본: ADR-0181 D7(스테이지 → 첫 발화 도착 시 exit → 오프너 행 arrival 1회 · 스레드 자동 열기 금지 · **120s 백스톱**)·ADR-0179(사다리·arrival)·`research/2026-08-29-buzz-onboarding-research.md` §1-D. 참조(Apache-2.0, 구조만): buzz `useWelcomeKickoffEntrance.ts`·`WelcomeKickoffStage.tsx`(`--stagger-index` 120ms 캐릭터 stagger, `motion-kickoff-stage-exit`).

## 구현 계약
1. **스테이지**: 가입(`createdMember:true`) 직후 첫 채널 진입 시 타임라인 위에 킥오프 스테이지 — 오르트 라인아트 소도형 3~5개가 아래에서 stagger(`--motion-instant` 간격, `--motion-arrival` 곡선)로 떠오르고 "팀이 준비하고 있어요" 한 문장. 마스코트 본체 변형 금지(소도형은 `OortCloudMarks` 재사용).
2. **exit**: 첫 에이전트 발화 프레임(오프너 run의 `agent.partial` 또는 provider-required 메시지) 도착 → 스테이지 exit(`--motion-standard`) → 그 행은 UX-R1d의 `enter-conversation` 1회. 이후 재진입에 스테이지 없음(로컬 마커 + 서버 idempotency).
3. **백스톱**: 120s 내 미도착 → 스테이지를 "어디서 확인하면 되는지" 안내 카드로 교체(실패 문구 금지; "에이전트가 아직 준비 중이에요. 설정 › 에이전트에서 상태를 볼 수 있어요").
4. 설정 › 워크스페이스에 `welcome_agent_member_id`(활성 에이전트 셀렉트)·`welcome_prompt`(≤2000자) 편집(operator 전용, #1800 표면 확장, 비낙관·in-place 확인).
5. reduced-motion: stagger 없이 정지 실루엣 → 즉시 exit.

## red proof (선행 커밋)
- 오프너 도착 → 스테이지 exit·행 1회 모션 · 120s 백스톱 카드 · 재진입 무스테이지 · provider-required 메시지도 exit 트리거 · settings 편집 왕복·2001자 거부 문장 · reduced-motion 즉시.

## 완료 절차
vitest·tsc·lint 0·preflight·`CAPTURE_PORT=8645`(스테이지·도착 후·백스톱 3장면 두 스킴)·`SHELL_GATE_PORT=8647 SHELL_GATE_FOCUS_ONLY=1`·`verify_merge_tree.sh` → PR → track/uxui → 정지.
