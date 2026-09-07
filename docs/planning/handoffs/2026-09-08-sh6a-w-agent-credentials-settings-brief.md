# 워커 브리프 — SH-6a-w 설정 › 연결 › 「에이전트 자격」 + AI 연결 로컬 provider 안내 (uxui · #2204 · ADR 불요 — 기존 hosted 연결 계약 소비)

> 워커: grok 4.6 · base=origin/track/uxui · 워크트리 `momo-worktrees/wsh6a`(`feat/sh6a-w-agent-credentials`) · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. `scripts/**`·`.github/**`·`server-rust/**`·`docs/adr/**` 무접촉. `clients/web/src/design/tokens.css` 무수정. 새 API·새 서버 플래그 발명 금지(서버가 이미 주는 것만 소비). 시크릿(1회용 연결 값) 로그·캡처·스냅샷에 남기지 않는다(OneTimeSecretCard 규율).
> 근거: 1차 목표 §1 「설치한 하네스의 합류」·§4 G1'-1 · 서버 hosted connections 라우트(create/list/get/regenerate/confirm/disconnect/complete_disconnect/acknowledge_cleanup_artifact + doorbell register/unregister) · 웹 `features/hostedAgents/*`(HostedAgentWizard·OneTimeSecretCard·HostedConnectionSection·DoorbellSection·status.ts) · `features/settings/settingsNav.ts`·`SettingsRoute.tsx`·`AiLinkSection.tsx` · `docs/SELF_HOST_AGENT.md` §3.3.16(합류 절차) · momo-design-taste-web(4상태·포커스·프리플라이트).

## 구현 계약
1. **설정 내비**: `settingsNav.ts`에 `{ id: "agents", label: "에이전트 자격", group: "연결" }`(AI 연결 다음, 코드 실행 호스트 앞). `SettingsRoute.tsx`에 섹션 라우팅. ⌘K·사이드바 진입점은 기존 settings 메커니즘이 자동으로 얻는지 확인(안 얻으면 같은 방식으로 1행).
2. **`AgentCredentialsSection.tsx`**(features/settings): ①연결 목록 — `hostedAgents` 모델의 list를 소비: 이름·provider 프리셋·상태(`status.ts` 어휘 그대로)·감지/확인 시각·마지막 활동·도어벨 유무. 빈 상태 = 「아직 연결된 에이전트가 없습니다 → 새 자격 발급」. ②「새 자격 발급」 = `HostedAgentWizard`를 설정 컨텍스트에서 여는 축약판(같은 컴포넌트, 진입 prop만) → 1회용 연결 값은 `OneTimeSecretCard`로만 표시. ③행 액션: 재발급(`regenerate` → 새 1회용 값 카드) · 해제(`HostedConnectionSection`의 disconnect 폐곡선 재사용 — 서버가 `disconnected`를 정할 때까지 「끝났다」고 먼저 말하지 않는다) · 도어벨 등록/해제(DoorbellSection 재사용). ④오류는 자리에 InlineBanner(토스트 금지, ADR-0182).
3. **AI 연결 로컬 provider 안내**: `AiLinkSection`에서 주소가 `http://127.0.0.1`·`http://localhost`·`http://[::1]`이고 서버가 `provider/link/test`를 loopback 거부로 돌려주면(응답 문구/코드는 `chainModel.ts` 실측) 안내 1문장: 「셀프호스트 env에서 로컬 provider 허용(`--allow-local-provider`, SH-6a-e)을 켜야 합니다」 + 문서 링크(`SELF_HOST.md` AI 연결 절). 서버 응답이 이미 그 문장을 주면 그대로 노출만.
4. **문서**: `docs/SELF_HOST_AGENT.md` §3.3.16과 `SELF_HOST.md` 「에이전트 합류」에 「설정 › 연결 › 에이전트 자격」 경로 1줄(en+ko). `clients/web/README.md` 표면 목록 1줄.

## red proof
- 시험: 목록 렌더(4상태) · 발급 왕복(mock: create → 카드 → confirm) · 재발급 카드 교체 · 해제 폐곡선(서버 `disconnected` 전까지 진행 상태) · 로컬 provider 안내 조건부 · **사보타주**: 1회용 값이 DOM/스냅샷/로그에 두 번 나타나면 RED, 해제 완료를 클라가 먼저 선언하면 RED.
- momo-design-taste-web 프리플라이트 0 위반 · 병합 트리 8레인 PASS · `npm --prefix clients/web run typecheck && test && build`.
- design-review(fresh, Opus) B0·H0 폐곡선 — 캡처 3장(빈/목록/발급 카드, 라이트·다크).

## 완료 절차
커밋 순서: ①내비+섹션 골격+빈 상태 ②목록 ③발급·재발급 ④해제·도어벨 ⑤AI 연결 안내 ⑥문서·시험. push `feat/sh6a-w-agent-credentials` → PR(base `track/uxui`): 캡처·게이트 원문·시험 목록·NOTES. 마지막 출력 `DONE / COMMITS / GATES / PR / NOTES`.

## 규율
재사용이 원칙(위저드·카드·섹션을 복제하지 않는다). 「실패할 수 없는 단정」 금지(해제 상태는 서버 응답을 실제로 파싱). 막히면 보고 후 정지.
