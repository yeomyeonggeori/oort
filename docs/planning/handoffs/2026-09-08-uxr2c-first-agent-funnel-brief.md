# 워커 브리프 — UX-R2c 온보딩 「첫 에이전트 연결」 퍼널: 하네스 카드 4종 → 1회용 자격 → 감지 → 첫 멘션, 건너뛰기 상시 (uxui · #2216 · ADR-0181/0182 소비)

> 워커: grok 4.6 · base=origin/track/uxui(SH-6a-w #2204 랜딩 뒤) · 워크트리 `momo-worktrees/wuxr2c`(`feat/uxr2c-first-agent-funnel`) · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. `scripts/**`·`.github/**`·`server-rust/**`·`docs/adr/**`·`clients/web/src/design/tokens.css` 무접촉. 새 API 없음. 1회용 값은 `OneTimeSecretCard` 한 곳(DOM·로그·스냅샷에 두 번 금지). 감지는 서버 상태(hosted list `status`)만 신뢰 — 클라가 「연결됨」을 먼저 선언하지 않는다. 토스트 금지(ADR-0182).
> 근거: 1차 목표 §1·§4 G1'-2 · 편성 개정 상자 · 실측: 온보딩 스텝 `features/auth/onboardingFlow.ts`(landing/gateway/account/profile, 4/4 카운터) · 로그인 뒤 first-run: `features/welcome/WelcomeKickoffStage.tsx`(ADR-0181)·`features/auth/PhoneLinkFirstRun.tsx`(M0w) · 프리셋 `packages/momo-core/src/features/hostedAgents/presets.ts`(`HOSTED_PRESETS`, Grok 「미확인」 문구 규율·과장 금지 시험) · `HostedAgentWizard(entry="settings")`(SH-6a-w) · `FirstMentionOnboarding`·`firstMentionStore`(멱등 마커) · `GrokBotInvite` · `ChoiceList`.

## 1. 구현 계약
1. **스테이지** `features/welcome/FirstAgentStage.tsx`: 로그인 뒤 first-run 순서 = 킥오프(ADR-0181) → **첫 에이전트 연결** → 폰 연결(M0w). 순서 근거: 킥오프가 「provider 미구성이면 에이전트가 그 안내를 말한다」(ADR-0181)이므로 그 직후가 연결 동기가 가장 높은 지점. 이미 연결이 1개 이상이면 스테이지 자동 통과(마커 기록).
2. **카드 4종**: `HOSTED_PRESETS`에서 Claude Code·Codex·Grok Bot 카드(프리셋 detail/unverifiedNote 그대로, 새 문구 최소) + 「OpenAI 호환(hermes 등)」 카드(설정 › AI 연결로 이동, SH-6a-w 로컬 안내 그대로). 카드는 `ChoiceList` 재사용. 「나중에」 건너뛰기 상시(마커 `first_agent_skipped`).
3. **발급→감지→첫 멘션**: 카드 선택 → `HostedAgentWizard(entry="settings")` 축약판(연결 이름 기본값 = 프리셋 이름) → 1회용 값 카드 → **감지 폴링**: hosted `get`을 지수 백오프(2s→30s, 상한 5분)로 읽어 `status`가 detected/confirmed로 바뀌면 다음, 상한 초과면 「아직 감지되지 않았습니다 — 설정 › 연결 › 에이전트 자격에서 이어갈 수 있습니다」(오류 아님, 진행 상태). 감지 뒤 `FirstMentionOnboarding`(기존)으로 첫 멘션 → 완료 마커.
4. **재진입**: 설정 › 연결 › 에이전트 자격(SH-6a-w)이 재진입점 — 스테이지에 링크 1줄. 4단계 카운터(ConnectPage)는 로그인 전 스텝이라 **무변화**(UX-R2d 범위 밖, PR에 명시).
5. **모션**: 스테이지 전이는 기존 first-run 스테이지와 같은 어휘(ADR-0179, `OnboardingSlideTransition`). 캡처 프로파일 `first-agent`(카드/1회용/감지 중/감지 실패/완료, 라이트·다크).

## 2. red proof
- 시험: 카드 4 렌더 · 자동 통과(연결 ≥1) · 건너뛰기·마커 멱등 · 발급→감지(mock 상태 전이)→멘션 왕복 · 상한 초과 문장 · **사보타주**: 1회용 값 2회 렌더 RED · 서버 상태 전이 전에 「연결됨」 선언 RED · 폴링 상한 제거 시 RED(무한 폴링 금지).
- 프리플라이트 0 · `npm --prefix clients/web run typecheck && test && build` · 병합 트리 8레인 · design-review(fresh) B0·H0 폐곡선 · 캡처 5장×2.

## 3. 완료 절차
커밋 순서: ①스테이지 골격+순서+자동 통과 ②카드 ③발급·감지 ④첫 멘션·마커 ⑤캡처·시험·문서(`SELF_HOST_FIRST_DAY.md`(+ko) 첫 하루 흐름 1줄). push `feat/uxr2c-first-agent-funnel` → PR(base `track/uxui`). `DONE / COMMITS / GATES / PR / NOTES`.

## 4. 규율
재사용(위저드·카드·첫 멘션·프리셋). 서버 상태만 신뢰. 폴링 상한 필수. 막히면 보고 후 정지.
