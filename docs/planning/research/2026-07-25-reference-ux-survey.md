# 레퍼런스 제품 UX 실측 서베이 (2026-07-25)

> 목적: oort(에이전트=1급 멤버인 팀 메신저, Tauri+React) 다음 기능 설계를 위한 레퍼런스 조사.
> 원칙: 마케팅 문구가 아니라 **실제 UI 동작**만. 확인 불가는 `미확인`으로 정직 표기.
>
> **1차 소스 등급 고지**
> - `[코드]` = buzz 오픈소스 레포(`block/buzz`, Apache-2.0, commit `ab3af82`, 2026-07-24)를 클론해 UI 소스를 직접 읽은 것. 최상위 신뢰도.
> - `[공식]` = 벤더 공식 문서/체인지로그.
> - `[2차]` = 리뷰·포럼·블로그. 교차검증 여부 표기.

---

## 1. 첫 실행 온보딩 와우

### 1-A. buzz `[코드]` — 가장 직접적인 레퍼런스

buzz는 oort와 문제 정의가 거의 동일(에이전트=채널 멤버인 메신저, Tauri 데스크탑)해서 소스를 직접 읽었다.

**온보딩은 2개 레이어로 분리돼 있다.**

1. **머신 온보딩**(기기 1회, `machineOnboarding.ts`): 신원(nsec) 생성/임포트 → 키 백업 → 하네스(런타임) 선택 → 기본 모델 설정. 완료 플래그는 `buzz-machine-onboarding-complete.v2:<pubkey>`로 **pubkey별** 저장 — 신원이 바뀌면 다시 뜬다.
   - 스테이지: `blocking` / `keyring-locked` / `onboarding` / `ready` / `relaunch-required` / `reset-failed`. 키링 잠김·리셋 실패까지 **별도 전용 화면**으로 처리.
   - 키 백업 스텝은 `backupNextDisabled()`로 게이팅: 키체인 읽는 중이거나 실패면 Next 비활성, 실패 시엔 **"Skip for now" 고스트 버튼만** 살아난다. 즉 "키를 못 본 채로 통과"를 구조적으로 차단.
   - 하네스 스텝은 CLI 가용성 상태를 4단계로 구분해 각각 다른 CTA를 띄운다: `available` / `cli_missing`("Not installed yet." + `INSTALL`) / `adapter_missing`("CLI detected; ACP adapter missing.") / `adapter_outdated`. 재검사 버튼 문구는 `CHECKING…` ↔ `CHECK AGAIN`. 로그인 필요 런타임은 인라인 sign-in.
2. **커뮤니티 온보딩**(워크스페이스 참가마다, `CommunityOnboardingFlow.tsx`): **단 2스텝**. 테스트(`onboardingFlowSteps.test.mjs`)가 `totalSteps_is_2`로 못박아둠.
   - 스텝1 "Build your profile" — 부제 원문: *"Add a name and avatar. They'll show up on your messages, reactions, and agent handoffs."* ("agent handoffs"를 프로필 이유로 명시하는 게 포인트)
   - 스텝2 "Meet your starter team" — 부제: *"Buzz lets you bring multiple agents into the same workspace. Your team will help you get started using Buzz."* Fizz/Honey/Bumble 3개 캐릭터가 **애니메이션 APNG**(`/onboarding/starter-team/*.png`)로 뜨고 이름은 mono·uppercase·letter-spacing.
   - 최종 CTA 문구가 "Start"가 아니라 **"Take me to Buzz"**. 진행 중엔 `LoadingDots label="Preparing Welcome"`, 스타터 채널 생성이 2회 이상 실패하면 버튼이 **"Skip for now"로 바뀌어** 사용자를 가두지 않는다.

**진짜 와우는 온보딩이 아니라 그 직후 "Welcome Kickoff"다** (`welcomeKickoff.ts`, 852줄):
- Welcome 채널 진입 시 리드 에이전트 Fizz가 오프너를 자동 게시. 원문 템플릿:
  `Hi @{owner}, I'm Fizz. Welcome to Buzz. This is your private home base, and we're here to help you get oriented or work through something you're building.\n\n{@Honey and @Bumble}, introduce yourselves in a sentence or two — share what you're good at and when to bring you in. Don't start any work yet.`
- 즉 **"에이전트가 다른 에이전트를 @멘션으로 호출하고, 그들이 실시간으로 답장하는 장면"**을 첫 화면에서 보여준다. 유저는 아무것도 안 했는데 멀티 에이전트 협업이 눈앞에서 재생됨.
- 이어 CTA 클로저: *"What can we help you build? Bring us something you're working on, or give us a quick challenge to see how we work together."*
- **degraded 경로가 전부 정직하게 설계돼 있음**:
  - 프로바이더 미연결: *"To get started with agents, connect to an AI provider in Settings. Once you're connected, come back here and we'll introduce the team."*
  - 팀메이트 1명 크래시: `"{name} is having trouble starting — you can check on them in Agents."`
  - 2명 크래시: `"{a} and {b} couldn't start. You can check on them in Agents; I'm still here to help."`
  - 응답 지연: `"{name} is taking longer to reply — I'm still here to help."`
- 타이밍 상수에 **뼈아픈 교훈이 주석으로 남아있다**: `TEAMMATE_INTRO_BACKSTOP_MS = 120_000`. 원래 15초였는데 "2026-07-18 관측: 인트로가 실제로 60초쯤 도착했는데 15초에 '늦어지고 있다'는 클로저가 이미 최종 확정으로 찍혀버렸다"며 120초로 올렸다. 주석 원문: *"`unresolved` means 'no intro seen yet', which is ignorance, not a fact; announcing it early states a falsehood, and the closer marker is terminal so nothing ever corrects it."* / `CLOSER_BEAT_MS = 3_000`, 준비 폴링 250ms, 대기 상한 60초.
- 멱등성: 오프너/클로저/프로바이더 안내마다 마커(`buzz-welcome-kickoff.opener.v1` 등)를 찍어 재방문 시 중복 게시를 막는다.

> **oort 번역**: 커뮤니티 온보딩은 "프로필 → 팀 소개" 2스텝으로 자르고, 첫 채널에서 김인턴이 다른 에이전트를 @멘션해 자기소개시키는 스크립트를 자동 재생하되 — 지연 판정 백스톱은 buzz의 실측값(120초)을 그대로 채택하고 실패 문구는 "안 됨"이 아니라 "어디서 확인하면 되는지"로 쓴다.

### 1-B. Raycast `[2차/구조확인]`

pageflows.com의 실제 화면 녹화 기반 시퀀스(화면명·타임스탬프만 확보, 정확한 카피는 미확보):
`Install(0:11)` → `Welcome slides(0:21)` → `Newsletter opt-in(0:36)` → `Welcome slides(0:49)` → `Command menu(0:57)` → `Welcome guide(1:03)` → `Guide(1:08)` → `Action menu(1:38)` → `Command menu(1:41)` → `App store(1:47)` → `Welcome guide(2:11)` → `Search(3:10)` → `Connect calendar(3:13)` → `Grant permissions(3:26)` → `Settings(4:01)` → **`Log in(4:08)` / `Sign up(4:10)`**

- 읽히는 패턴 2가지:
  1. **로그인이 4분대, 맨 뒤에 등장.** 검색·확장설치·캘린더연동 등 핵심 가치를 계정 없이 먼저 체험시킨 뒤 Settings 경로로 계정을 유도. 로그인 월이 앞을 막지 않는다.
  2. "Welcome guide"/"Guide"가 "Command menu"/"Action menu"와 **반복 교차 출현** → 사용자가 실제 커맨드바에 직접 입력하며 따라 하는 인터랙티브 워크스루가 존재함을 구조적으로 시사.
- 공식 Quickstart의 5단계 프레이밍: 단축키 설정(`⌥Space`, "Replace Spotlight"로 `⌘Space` 대체 가능) → Root Search → Snippet 생성 → Extension 설치 → AI 채팅.
- 온보딩은 **"Show Onboarding" 커맨드로 언제든 재진입 가능**(스킵해도 영구 손실 아님).
- `미확인`: 온보딩 화면들의 정확한 버튼 카피. **컨페티/축하 모먼트는 코어 온보딩에 없음** — 커뮤니티 제작 Store 확장("1-Click Confetti")으로만 존재.

> **oort 번역**: 계정/워크스페이스 가입을 앞에 세우지 말고 "먼저 한 번 써보게 한 뒤 뒤에서 붙이기" + 온보딩 재진입 커맨드를 상시 제공한다.

### 1-C. Cursor `[공식은 부분만]`

- **공식 문서로 검증된 건 수동 임포트 경로뿐**: `Cmd/Ctrl+Shift+J` → General → Account → **VS Code Import** → Import 버튼. 확장 전체·테마/아이콘팩·키바인딩·settings.json·스니펫을 가져옴.
- `[2차]` 첫 실행 시 welcome screen에서 가입/로그인(이메일·Google·GitHub), 계정 생성과 동시에 **14일 Pro 트라이얼 자동 부여(카드 불필요)**. VS Code 임포트 프롬프트는 계정 생성 **이후**, "One-Click Import"로 대다수 즉시 완료, 스킵 시 나중에 Settings에서 재실행 가능.
- `미확인`: 최초 실행 화면의 정확한 순서는 공식 1차 문서에 없음(2차 소스 합성). **"Tab 튜토리얼 파일이 첫 실행에 자동으로 열린다"는 서술은 어떤 소스에서도 확인 못함** — cursor.com/tab의 인터랙티브 데모는 마케팅 페이지이지 앱 내 온보딩인지 불명.

> **oort 번역**: "기존 환경 1클릭 임포트"는 이주 비용을 없애는 강력한 첫 스텝 — oort라면 Slack 워크스페이스/채널 구조 임포트가 이 자리.

### 1-D. t3.chat / T3 Code `[공식 부분]`

- t3.chat: **Google OAuth 사실상 단일 로그인**. 제작자 Theo 본인 X 발언: *"T3 Chat is practically a Google service now - Auth is Google-only."* 공식 피드백 보드에 "Sign in with email"(76 upvotes), "Temporary account login without google sign in"이 **In Progress로 아직 대기 중**.
- BYOK 존재(Google/OpenAI/Anthropic + o3), Priority(키 우선)/Fallback(계정 크레딧 우선) 2모드.
- `미확인`: 로그인 전 게스트 채팅 가능 여부(사이트가 WebFetch 403/429 반복 차단), BYOK 프롬프트가 온보딩 중 뜨는지 설정에서만 발견되는지.
- ⚠️ delv.tools 가이드가 "이메일/비밀번호 로그인"을 서술하나 Theo 발언·피드백보드 상태와 **모순** → 저품질 2차 소스로 판단, 폐기.
- T3 Code(별개 제품): 자체 인증 없음. **사용자가 미리 인증해둔 CLI를 붙이는 구조** — `codex login` / `claude auth login` / `cursor-agent login` / `opencode auth login`. Theo: *"You bring your inference, your subs, your harnesses."*

### 1-E. ChatGPT Codex 앱 `[공식]`

- 로그인 화면: **"Continue to sign in"** 버튼 → 브라우저 OAuth → 자격증명 반환. 대안은 **"Sign in another way"**로 API 키(IDE 확장은 **"Use API Key"**). 공식 권장은 ChatGPT 로그인.
- **실행 시점 자동 추천이 인상적**: *"On launch, Codex detects whether the folder is version-controlled and recommends: 버전관리 폴더 → Auto / 비버전관리 폴더 → read-only."* 승인 모드를 유저에게 묻기 전에 **컨텍스트로 기본값을 먼저 제안**한다.
- 승인 모드 프리셋(현행 공식 config): `Auto` / `Safe read-only browsing` / `Read-only non-interactive (CI)` / `Dangerous full access`("not recommended" 명시).
- `미확인`: 구버전(Suggest/Auto Edit/Full Auto) vs 현행 프리셋 vs 커뮤니티 서술(Read-Only/Auto/Full Access)이 혼재 — 2026-07 화면에 실제 뜨는 리터럴 라벨은 스크린샷 미확보.

> **oort 번역**: 권한 모드를 빈 화면에서 고르게 하지 말고, 워크스페이스 성격을 감지해 안전한 기본값을 제안한 뒤 바꾸게 한다.

### 1-F. Orca — **제품 식별 모호, 재확인 필요**

- "Orca"는 AI/dev 영역에서 다수 제품과 충돌(Orca Security 등). 문맥상 가장 근접한 건 **stablyai/orca** — 병렬 코딩 에이전트용 오픈소스 "Agent Development Environment", 30개 이상 CLI 에이전트를 격리된 git worktree에서 병렬 실행, MIT.
- 첫 실행에 대해 검증된 유일한 구체 서술(andrew.ooo 리뷰): *"First launch walks you through agent detection — it scans `$PATH` for installed CLIs and pre-populates the agent list."* 이후 계정 스위처로 각 CLI 계정 추가 → 첫 worktree 생성.
- `미확인`: 화면 단위 온보딩 시퀀스, 로그인 필요 여부, 단계 수. **애초에 성재가 의도한 "Orca"가 이 제품이 맞는지 확인 필요.**

> **oort 번역**: `$PATH` 스캔으로 설치된 하네스를 자동 발견해 목록을 미리 채워주는 패턴은 buzz의 하네스 감지와 동일 계열 — oort도 "설정하라"가 아니라 "찾아놨다"로 시작한다.

---

## 2. 모델/프로바이더/effort 선택 + auto 라우팅

### 핵심 발견: **"Auto가 뭘 골랐는지 보여주는가"에서 제품이 정확히 갈린다**

| 제품 | Auto 결과 노출 | 근거 |
|---|---|---|
| **Cursor** | **의도적으로 안 보여줌** | Cursor 팀원 포럼 답변: *"one of the trade-offs of the fixed price for Auto is that the exact Model isn't available"* |
| **GitHub Copilot** | **항상 노출**(표면별로 다르게) | 공식 문서 |
| **OpenRouter** | **매 응답 `model` 필드로 반환** | 공식 문서 *"you're never guessing"* |
| **Claude** | **폴백 시에만** 라벨링 | support.claude.com |
| **ChatGPT** | `미확인` | Help Center에 명시 없음 |

### Cursor `[공식+2차]`
- 모델 피커는 **컴포저 입력창 하단 바**. Thinking 모델은 **뇌 아이콘 배지**, 모델별 **크레딧 배수** 표시(GPT-5.4=1x, Claude Opus 계열 최대 10x).
- **Max Mode 변화**: 원래 per-request 토글이었으나 **2026-07-20부터 usage-based 플랜에서 토글 제거** → 모델 피커에서 컨텍스트 윈도우 크기를 직접 선택하는 방식으로 전환.
- Settings → Models → API Keys: OpenAI/Anthropic/Google/Azure/Bedrock 키 입력, 저장하면 커스텀 모델이 피커에 등장. 개별 모델 비활성화 가능. **BYOK는 일반 chat completion만 언락 — Agent/Edit은 여전히 구독 필요**.
- ⚠️ 버그 사례: Auto 선택인데 `UsageLimitPolicyBanner`가 백그라운드로 "Composer 2.5 Fast"로 전환하며 **피커 라벨 자체를 덮어씀**. 사용자의 명시적 선택과 표시가 불일치.
- 커뮤니티에 "Auto → Sonnet 4.5처럼 보여달라" 기능 요청 다수(2026-07 기준 미해결).

### Claude 앱 `[공식]`
- 모델 선택 메뉴는 **전송 버튼 옆**. Opus 5 / Sonnet 5 / Fable 5 / Opus 4.8 / 4.7 / 4.6 / Sonnet 4.6 + "More models".
- **Effort와 Thinking이 별개 축**: 모델명 옆 메뉴 → "Effort" → `Low / Medium / High(Default) / Xhigh / Max`. Effort 지원 모델은 "Effort" 위에 호버하면 thinking 토글이 나타나고, 미지원 구형 모델은 별도 "Extended" 토글. 공식 설명: *"Effort는 매 응답이 얼마나 철저한지, Thinking 토글은 추론 과정을 거치는지를 각각 통제."*
- **override 성격**: "대화 중 언제든 바꿀 수 있고 변경은 다음 응답부터 적용" → **대화 내 sticky override**. 계정 기본값 vs 대화별 override를 시각적으로 구분하는 인디케이터는 `미확인`.
- 모델 자동 폴백 시 notice + "응답에 실제로 답한 모델 라벨링" 명시. 단 pill/badge/헤더 중 어느 형태인지 `미확인`.

### GitHub Copilot `[공식]` — 가장 투명
- 피커는 채팅 입력창 하단. 모델 선택은 **세션 단위 sticky**(패널 닫으면 기본값 리셋).
- Auto 결과를 표면별로 전부 노출: Chat은 응답 hover, CLI는 터미널에 모델명, Cloud Agent는 응답 끝, 앱은 "Auto" 옆에 실제 모델명.

### t3.chat `[2차]`
- 모델 피커 그리드 뷰 → 사용자 피드백("grid view is not very useful") 후 검색/필터/즐겨찾기 개선 요청이 76 upvote로 **Completed** 처리(구체적 변경 내역은 `미확인`).
- **모델을 바꾸면 Thinking Effort 설정이 리셋된다**는 이슈 보고 — effort가 모델별로 sticky하지 않음.
- 한 프롬프트를 여러 모델에 동시 전송해 side-by-side 비교, 최고 답변 pin.
- `미확인`: capability 필터·BYOK 아이콘의 정확한 시각 디자인.

### OpenRouter `[공식]`
- `openrouter/auto`(NotDiamond 기반) 선택 시 추가 수수료 없이 선택된 모델 표준 요금. `cost_quality_tradeoff` 0~10 슬라이더(기본 7), `allowed_models`로 `anthropic/*` 등 제한.

### buzz `[코드]` — oort에 가장 직접 적용 가능한 모델
- effort는 **per-provider × per-model 테이블**로 유효값이 다르다(`effortTable.fixture.json`): `claude-opus-4-5` → `[low, medium, high]`, default `null` / `claude-opus-4-7`·`sonnet-5`·`fable-5` → `[low, medium, high, xhigh, max]`, default `high` / `claude-opus-4-6` → xhigh 제외. OpenAI 라우트는 `normalize_effort_for_openai_route`로 max를 xhigh로 클램프.
- UI 라벨은 **"Thinking / Effort"**, 도움말: *"Controls how much reasoning effort the LLM applies per turn. Leave blank to inherit from the global or persona default."*
- **핵심: 3단 상속 체인 + 명시적 Inherit 옵션.** 전역 기본 → 페르소나 기본 → 에이전트별 오버라이드. 피커의 폴백 옵션 문구가 **"Inherit (agent default)"**이고, 상속된 실제 값(`inheritedEffort`)을 함께 보여준다. 모델을 바꿔 현재 effort가 유효값에서 벗어나면 `useEffortAutoClear`가 **자동으로 비운다**(t3.chat의 "리셋되어 당황" 문제를 구조적으로 해결).
- buzz엔 **요청 단위 모델 오버라이드가 없다** — 모델/effort는 에이전트 설정에 귀속.

> **oort 번역**: "요청 단위 오버라이드 vs 기본값"은 **상속 체인 + 'Inherit (…)' 명시 옵션**으로 표현하고(빈 값=상속, 상속된 실제 값을 같이 노출), 모델 변경 시 무효해진 effort는 조용히 리셋하지 말고 자동 클리어 + 안내한다. Auto 라우팅을 쓴다면 **Cursor가 아니라 Copilot 쪽**을 따라 "이번 턴에 실제로 답한 모델"을 메시지에 반드시 라벨링한다 — 에이전트가 멤버인 제품에서 "누가 답했는지 모름"은 치명적.

---

## 3. 에이전트 작업 관전 패널

### 3-A. buzz `[코드]` — "Activity" 패널

- 패널 정체: 채널 우측 보조 패널(`AgentSessionThreadPanel.tsx`). 헤더 타이틀은 **"Activity"**, raw 모드로 토글하면 **"Raw ACP Activity"**. 부제는 "last updated" 타임스탬프, 비어있으면 **"No updates yet"**.
- **스코프 라벨을 헤더에 상시 노출**: `#채널명` / `1 channel` / **`All channels`**. 소스 주석에 이유가 적혀 있다 — *"an all-channels pane can look 'wrong' without it"* (전체 채널 뷰가 채널 뷰처럼 보여서 생기는 혼란 방지).
- 설정 드롭다운(톱니, 작업 중이면 **우하단에 primary 색 점 배지**):
  - Raw JSON-RPC 페이로드 표시/숨김 — *"Show raw JSON-RPC payloads for this channel."*
  - 새 활동 행 애니메이션 on/off — *"Animate new activity rows as they arrive."* / raw 모드에선 *"Raw activity rows don't animate in."*
  - 행별 타임스탬프 표시 — *"Show a timestamp under each activity row."*
  - **"Stop current turn"** — *"Interrupt the current ACP turn without stopping the agent process."* 불가할 땐 이유를 분리해서 보여줌: *"Only available for locally managed agents."* vs *"Available while the agent is working."* 실행 시 토스트: `"Stop signal sent to {name}. It may take a moment to respond."`
- **툴 호출 렌더링 어휘**(`agentSessionToolClassifier.ts`) — 과거형 기본, 진행 중엔 현재진행형으로 전환:
  `Ran command` / `Read file` / `Viewed image` / `Edited file` / `Updated todos` / `Checked todos` / `Context compacted` / `Ran tool`. 상태 배지는 `Running` / `Pending` / `Done` / `Error`.
  파일 편집은 `Editing file`(진행) → `Edited file`(완료) → `Edit failed`(실패)로 3분기.
- 툴 종류를 14개 `CompactToolKind`로 분류해 렌더 방식을 다르게 함: `message` / `relay-op` / `file-edit`(diff +/- 요약) / `file-read` / `skill-read` / `image`(썸네일) / `shell` / `status` / `thought` / `plan` / `permission` / `error` / `generic` / `raw-rail` / `suppressed`.
- 히스토리: 라이브 이벤트 윈도우 상한 3000, 그 너머는 SQLite 아카이브 페이징. 라이브∪아카이브를 `(seq, timestamp)`로 dedup, 중복 시 라이브 우선.

### 3-B. Claude 앱들 `[공식]`
- claude.ai extended thinking: "Thinking…" 박스가 **기본 접힘**, 클릭하면 스트리밍되며 채워짐. API에 `display: summarized` vs `omitted` — 즉 **보이는 thinking은 원문이 아니라 후처리 요약일 수 있음**.
- Claude Code 터미널: todo 상태 `pending`(❌) → `in_progress`(🔧) → `completed`(✅), 진행률 "Progress: X/Y completed". 스피너가 **동사 + 경과시간 + 토큰 + thought 시간**을 한 줄로: `(1m 56s · ↑ 2.3k tokens · thought for 1s)`. **10초 넘으면 스피너가 호박색으로 변해 "아직 살아있음" 신호**.
- 데스크톱 앱 리뉴얼(2026-04): 사이드바에 활성/최근 세션 전체, 상태·프로젝트·환경 필터. **Verbose / Normal / Summary 3단계 뷰 모드**로 툴콜 노출량을 사용자가 조절. `Cmd+;`로 메인 스레드 오염 없이 사이드챗 분기.
- **Agent View**(2026-05-11 리서치 프리뷰): 전 세션 단일 대시보드. 각 행 = 세션 ID + 상태(`needs input`/`working`/`done`/`idle`, 예약은 "next scheduled run time in 12m") + 마지막 응답 미리보기 + 타임스탬프. **행 선택 시 대시보드를 벗어나지 않고 인라인 프리뷰**로 훔쳐보고, 짧은 승인은 그 자리에서 답하면 세션 재개. Enter로 전체 트랜스크립트 진입.

### 3-C. ChatGPT `[공식]`
- Agent 모드: **"Desktop view"(에이전트가 보는 실제 화면)와 "Activity view"(단계별 추론 텍스트)를 전환**해 관전. "Searching for available hotels on Expedia..." 같은 현재 행동 문구가 실시간 갱신. 사용자가 "stop" 타이핑하면 중단하고 방향 수정 가능.
- Deep Research(2026-02 리뉴얼): 실행 전 **research plan을 편집 가능**, 실행 중 웹소켓 스트림으로 갱신되며 **mid-run steering**(소스 추가·범위 조정) 가능. 완료 리포트는 풀스크린 문서 뷰어(좌측 목차, 우측 출처).
- Scheduled 허브: 사이드바 전용 페이지, 다음 실행 시각·일시정지/재개/편집/삭제. 완료 시 push/email.

### 3-D. Cursor `[공식+2차]`
- 진입 3경로: 에디터 입력창 옆 "Cloud" / `cursor.com/agents` / Slack·GitHub·Linear에서 `@Cursor` 멘션.
- Cursor 3 "Glass" Agents Window(`Cmd+Shift+P`): 로컬·클라우드 에이전트가 **통합 사이드바**에 함께, 각자 "Agent Tab"을 가져 side-by-side/그리드 배치.
- 행이 보여주는 것: 현재 단계, 경과 시간, 라이브 로그. 완료 시 **변경사항을 시연하는 아티팩트(비디오/스크린샷/로그)를 PR에 첨부** + 푸시 알림.
- `미확인`: 행의 정확한 컬럼 구성(repo/branch 표기 위치·서식).

### 3-E. Devin `[공식]`
- 좌측 채팅 + 우측 워크스페이스(**Shell / IDE / Desktop / Planner** 4탭). 2026년 **"Progress 탭"**이 이들을 통합해 "셸 명령·코드 편집·브라우저 활동 전체를 하나의 로그"로.
- Planner = 단계별 **아코디언 work log**, 펼치면 해당 단계 회고, 🟢/🟠/🔴이 A/B/C 등급 대응, 타임스탬프·소요시간 병기.
- **Follow-along**: Shell 탭 우측 파란 점에 호버하면 그 시점 명령 미리보기, 클릭하면 점프. 스크롤바로 세션 타임라인 scrub. 에디터에서 텍스트 하이라이트 → "Add to chat"으로 특정 코드 구간을 바로 전달.
- Interactive Planning: 실행 전 **confidence score 포함 blueprint**를 팀이 승인해야 코딩 시작.

### 3-F. 기타
- **Copilot coding agent**: 저장소 레벨 **Agents 탭**. 세션 뷰에 진행상황 + 토큰 사용량 + 세션 길이. 로그에 저장소 클론, **에이전트 방화벽 설정 시작/종료**까지 노출. draft PR에 커밋을 계속 푸시 — **PR 자체가 진행 지표**. 각 커밋에 세션 로그 링크 첨부.
- **Codex 앱**: ChatGPT 데스크톱에 Chat·Work와 나란한 "Codex" 탭. 인라인 diff 편집, 사이드 패널 PR 리뷰, **expand-and-collapse navigation**. CLI는 `codex cloud list` / `codex apply <TASK_ID>`.
- **Jules**: 실행 전 단계별 plan 제시(리뷰·수정·거부 가능), 번호 매겨진 박스로 plan 항목·완료 상태 표시, activity feed에 의존성 설치·파일 수정·테스트 실행 라이브 로그.

> **oort 번역**: 관전 패널은 **채널 우측 보조 패널 + 스코프 라벨 상시 노출**(buzz)로 가고, 툴 호출은 과거형/진행형 어휘로 접힌 한 줄 요약, 상태는 Running/Pending/Done/Error 4종. 관전에서 가장 중요한 두 기능은 **① 자리를 잃지 않고 훔쳐보기**(Claude Agent View의 인라인 프리뷰) **② 프로세스는 살린 채 현재 턴만 중단**(buzz의 "Stop current turn"). 10초 넘으면 색을 바꿔 생존 신호를 주는 Claude Code 패턴도 그대로 채택할 만하다.

---

## 4. 작업중 인디케이터

### 4-A. buzz `[코드]` — 3계층 + 통합 신호원

`agentWorkingSignal.ts`가 **모든 작업중 표시의 단일 진실원**. 주석에 규칙이 명시돼 있다:
1. **1차 신호** = observer 유래 active turn(nostr kind 24200) — 채널 스코프와 시작 앵커를 가짐.
2. **폴백** = 봇 타이핑 인디케이터(kind 20002) — observer 스트림이 없는 스코프(원격 하네스 등)용.
3. **스코프 규칙**: channelId 있으면 "그 채널에서 작업 중", 없으면 "아무 채널에서든 작업 중".

**표시 3계층:**

| 위치 | 표시 |
|---|---|
| **사이드바 채널 행** | **경과 시간 pill** (`ChannelWorkingBadge`) |
| **컴포저 바** | 아바타 스택 + 회전하는 활동 헤드라인 |
| **트랜스크립트** | `TurnLivenessIndicator` |

- **사이드바 pill이 이 조사에서 가장 신선한 패턴**: 스피너나 "…"가 아니라 **틱하는 경과시간**을 보여준다. `formatElapsed`: `<60s → "42s"` / `<60m → "3m 12s"` / `≥60m → "1h 4m 9s"`. 1초마다 갱신, `tabular-nums`, `motion-safe:animate-pulse`, 에이전트 2명 이상이면 `"3m 12s (2)"`. 툴팁은 `formatWorkingTooltip`: 1명이면 `"Fizz working"`, 여러 명이면 **`"Fizz and 2 agents working"`**(리드 이름 + 나머지 수).
- **컴포저 바**(`BotActivityBar.tsx`): 작업 중 에이전트 아바타 최대 2개 겹쳐서 + 초과분 `+N`. 인라인 변형은 **Shimmer 텍스트로 `"{에이전트}: {현재 활동}"`을 2200ms마다 회전**. 헤드라인은 트랜스크립트에서 최근 5개를 뽑되 **2단 스캔**: 먼저 spine 아이템(툴·메시지·thought·plan)만, 하나도 없으면 meaningful 아이템으로 폴백 — *"reads recede when real work is present"*(진짜 작업이 있으면 단순 읽기는 뒤로 물러남). 헤드라인 형식은 `"{label} · {preview}"`, 어시스턴트 메시지는 첫 줄 72자 초과 시 69자+`…`, 빈 텍스트면 `"Responding"`, plan이면 `"Planning"`.
- 호버 150ms/닫기 180ms 지연 팝오버 → 헤더 **"Agents working"**, 각 행에 아바타 + 이름 + **"View activity"** + 스피너. 클릭하면 그 에이전트의 Activity 패널로.
- **`TurnLivenessIndicator`**: FuzzyLogo(브랜드 로고) 3개를 0.25s 스태거로 1.8s 사이클 페이드+수직 이동. `useReducedMotion` 또는 애니메이션 off면 **단일 정적 로고 + `opacity-25`로 폴백**. `role="status"`, `aria-label="Agent turn in progress"`.
- 타이핑 폴백은 **first-seen 타임스탬프를 재보고 시에도 보존**해 경과 앵커가 흔들리지 않게 한다.

### 4-B. Slack `[공식]`
- `user_typing` 이벤트: 필드는 `type`/`channel`/`user` 뿐, **스코프 불필요**, **RTM API 전용**(Events API 아님).
- 송신 스로틀: `@slack/rtm-api` 문서 기준 "최근 3초 내 안 보냈으면" 키 입력마다 재전송(수신측 표시 타임아웃과는 별개).
- **AI 앱 전용 `assistant.threads.setStatus`가 oort에 가장 직접적**:
  - 필수 `status`(예: "is working on your request..."), `thread_ts`, `channel_id`.
  - 옵션 `loading_messages` — **최대 10개** 문자열 배열을 Slack이 **순환 표시**. Bolt 공식 예시가 재밌다: *"Teaching the hamsters to type faster…"*, *"Untangling the internet cables…"*, *"Consulting the office goldfish…"*
  - 렌더링: **컴포저 바로 아래**에 타이핑 인디케이터처럼, 형식은 `<앱 이름> <status>` (예: "YourAssistantJeeves is thinking...").
  - **타임아웃 규칙**: 응답 전송 시 자동 클리어 / **응답 없이 2분 지나면 강제 제거** / `setStatus('')`로 수동 클리어.
  - 부수효과: 호출 시 해당 스레드가 Agent messaging 경험으로 자동 전환. Rate limit 기본 600/분.
- 스레드별 타이핑 인디케이터 실재(Slack 엔지니어 공개 + iOS 릴리즈 노트의 관련 버그 수정).
- 로컬 끄기: Preferences → Messages & media → "Display information about who is currently typing a message" — **본인 화면에서만 숨김**, 상대방에게 보이는 건 못 바꿈.
- `미확인`: 사라짐 타임아웃 정확한 초(커뮤니티는 5초설), **사이드바/채널 리스트 노출 여부**, "X is typing" → "Several people are typing" 전환 임계값과 이름 트렁케이션 규칙, `loading_messages` 회전 간격.
  - ※ "Several People Are Typing"이 실제 Slack 카피라는 건 강한 정황증거로 확인됨(Slack 공식 블로그 이름이 그것이었고 이를 소재로 한 소설까지 존재).

### 4-C. Linear `[공식]`
- 상태 카테고리 6종: Triage(옵션) / Backlog / Unstarted / Started / Completed / Canceled(+시스템 예약 Duplicate). 기본 워크플로우 `Backlog > Todo > In Progress > Done > Canceled`.
- **Agent Sessions**(oort에 직접 대응): 에이전트가 멘션·위임되면 세션 자동 생성, 상태 **6종** — `pending` / `active` / `error` / `awaitingInput` / `complete` / `stale`(응답 없음/방치).
- 에이전트가 발행하는 **activity 5종**: `Thought`(추론 노출) / `Action`(툴 호출) / `Response`(최종 결과) / `Elicitation`(명확화 요청) / `Error`(선택적 링크 포함).
- **Ephemeral activity**: "다음 activity가 도착하면 교체되는" 일시적 진행 표시가 공식 개념으로 존재.
- 2026-06-11 체인지로그: 코딩 에이전트 작업 중 **브라우저 탭에 애니메이션 탭 인디케이터** 추가, Agent Session 카드 상태 행(라벨+미리보기) 정렬 개선.
- `미확인`: 상태 아이콘의 정확한 형태(부분 채움 파이 등)는 공식 문서 텍스트에 없음 — 3rd-party에서만 반복 서술. 사이드바/이슈 리스트에서의 정확한 아이콘·애니메이션. 뷰잉/에디팅 프레즌스 기능 자체의 존재 여부.

### 4-D. Discord `[공식]`
- `POST /channels/{id}/typing` — **10초 후 만료** 명시. 공식 문서가 *"봇은 일반적으로 이 라우트를 쓰면 안 된다"*고 권고하되, **명령 처리에 수 초 걸릴 것으로 예상될 때는 허용된 유스케이스**로 명시.

> **oort 번역**: 사이드바/대화목록에는 스피너 대신 **틱하는 경과시간 pill + `(N)`**을 쓰고 툴팁은 "김인턴 외 2명 작업 중". 컴포저에는 현재 활동 헤드라인을 ~2.2초 회전. 신호원은 buzz처럼 **단일 모듈로 통합**(1차=서버 턴 이벤트, 폴백=타이핑)하고, Slack의 **2분 강제 클리어**와 Linear의 **`stale` 상태**를 반드시 넣는다 — 죽은 에이전트가 영원히 "작업 중"으로 남는 게 이 UI의 최대 실패 모드다. `prefers-reduced-motion` 정적 폴백은 buzz처럼 필수.

---

## 5. 사용량/쿼터 대시보드

### 핵심 교차 발견
1. **구독 할당량은 "롤링 시간창 + 잔여율(%)" 프레임**, **선불 크레딧은 "달러 잔액 대비 소진" 프레임**으로 완전히 갈린다.
2. **Claude와 Codex 둘 다 "짧은 창(5시간) + 긴 창(주간)"을 두 개 게이지로 병기**하고 리셋을 절대 시각 텍스트로 표기. 이게 사실상 업계 표준 페어가 됐다.
3. **"이 속도면 언제 소진" 예측형 표시는 조사한 6개 제품의 공식 대시보드 어디에도 없다.** 전부 서드파티 영역(SessionWatcher, BurnRate, Claude Code Usage Monitor 등).

### Claude `[공식]` — 가장 정교
- **claude.ai Settings > Usage**: `Current session`(5시간 세션 한도 사용분 + 남은 시간, 진행률 바) / `Weekly limits`(**Opus 전용 리셋 시각과 전체 모델 리셋 시각을 별도 표시**).
- **Claude Code `/usage`**: 플랜 한도 대비 사용률을 **skill/subagent/plugin/개별 MCP 서버별로 % 귀속**, long context나 cache miss가 10% 넘으면 별도 플래그. `d`/`w` 키로 24시간↔7일 뷰 전환.
  - API 이용자용 세션 블록은 비용·소요시간·모델별 토큰을 보여주되 *"computed locally... may differ from your actual bill"* 명시.
  - **사용량 엔드포인트가 rate-limit되면** "최근 60분 내 마지막 로드된 사용률 바 + `Showing last-known usage`" 표시, `r`로 재시도. — 지표 조회 자체가 실패했을 때의 정직한 폴백.
- **한도 도달 문구(공식 원문)**:
  ```
  You've hit your session limit · resets 3:45pm
  You've hit your weekly limit · resets Mon 12:00am
  You've hit your Opus limit · resets 3:45pm
  ```
  session/weekly는 모델 공통이라 `/model` 전환으로 우회 불가, **Opus 한도만 별도라 다른 모델로 계속 가능**.
- `/usage-credits`: Pro/Max는 브라우저 결제 열림, Team/Enterprise는 **조직 admin에게 요청 전송**.

### Cursor `[공식]`
- 구모델: "500 fast requests"(Sonnet류는 2개로 카운트) → **2025-06부터 "$20 of included usage"**로 전환, 공식 블로그가 "rate limits"라는 단어를 더는 쓰지 않는다고 명시.
- `cursor.com/dashboard` → **Spending 탭**: "real-time usage for both pools, remaining allowance, and any on-demand charges" — **Cursor 자체 모델 풀 / 서드파티 모델 풀 2개로 분리 표시**. 리셋일 표시. Spend limit 입력 + "No Limit" 옵션 + 팀용 "Dynamic Spend Limits" 토글, *"Limit changes take effect immediately."*
- 포럼 피드백: 구모델 폐지 후 "몇 건 남았는지" 카운터가 사라졌다는 불만 다수. 비용이 `-`로 표시되면 "included in the plan" 의미라고 서포트 답변.
- `미확인`: 게이지 모양·색상 등 픽셀 단위 레이아웃. 사용자마다 다르게 보고돼 UI가 유동적일 가능성.

### Codex `[2차]`
- CLI `/status`: 5시간/주간 잔여량 + 현재 모델·플랜 티어(세션 열려 있을 때만).
- 상태줄: 5시간·주간 잔여율 상시 %. **표시되는 %는 잔여량(소진량 아님)** — 두 2차 출처가 이 점은 일치.
- 웹 대시보드: 3개 독립 미터 — 5시간 롤링(소진율 + `"Resets 10:16 PM"`), Weekly(5시간 다 써도 주간은 남을 수 있음), Credits(종량 top-up + 적립 크레딧 유형·만료일). 5시간 잔여 0%면 우상단 빨간 배너 **`"Usage limit reached"`**. 안내 문구: *"Codex usage draws from your shared agentic usage limit."*
- `미확인`: 상태줄 정확한 포맷(두 출처가 `"Rate Limits Remaining: 5h 96%, Weekly 94%"` vs `"5h 88%, weekly 38%"`로 불일치), help.openai.com 403으로 원문 대조 불가.

### OpenRouter `[공식]`
- Credits: 잔액 + "Add credits" + **"Enable auto top up"** 토글 — 임계값(최소 $2, 기본 $25) 아래로 떨어지면 지정 금액(최소 $2, 최대 $50,000) 자동 충전.
- Activity: model/provider/API key 필터, 기간 **1 Hour / 1 Day / 1 Month / 1 Year**, group by **Model / API Key / Creator(조직 멤버)**. 상단 요약 카드 3개 — Spend(크레딧 + **추정 BYOK 지출**), Tokens, Requests. CSV·PDF export.
- **개별 API 키에 credit limit**을 걸어 공용 잔액 풀 위에 하드캡.

### Anthropic Console `[공식]`
- Usage: Workspace/model/month/API key 드롭다운, input/output 토큰 막대그래프, **막대 클릭 시 시·분 단위 드릴다운**, 별도 **"Rate-Limited Requests"/"Rate Limit Use"** 섹션(분당 최대 토큰 비율 vs 현재 임계값), CSV export.
- Cost: Daily Cost Chart(토큰 비용 + **웹서치·코드실행 등 tool use 비용 포함**), Total Cost Statistics, CSV export.
- 두 화면 모두 **개인별 breakdown 미제공** — 필요하면 별도 Analytics API. `group_by`는 model/workspace_id/api_key_id/service_tier/inference_geo/speed, bucket_width 1m/1h/1d.

### ChatGPT `[2차]`
- 롤링 윈도우 방식(고정 시각 리셋 아님). 예: Plus GPT-5.5는 3시간당 160 메시지 후 mini로 자동 전환, Thinking은 주간 상한.
- `미확인`: **help.openai.com 전 페이지가 WebFetch 403**으로 2026년 현재 정확한 한도 도달 문구 확보 실패. GPT-4 시절 커뮤니티 인용문만 확인. 소비자용 상시 사용량 대시보드 존재 여부도 미확인.

### buzz `[코드]` — **사용량/쿼터 UI가 아예 없음**
`features/settings/` 전체를 grep한 결과 usage/quota/credit/rate-limit 관련 화면이 존재하지 않는다. 유일한 인접 화면은 Hosted communities(계정 연결/커뮤니티 생성)뿐. → **이 영역은 buzz가 아직 안 푼 문제이고, oort가 앞설 수 있는 지점.**

> **oort 번역**: OAuth 구독 잔여량은 **"짧은 창 + 주간" 2게이지 + 절대 시각 리셋 텍스트**(Claude/Codex 공통 표준)로, 크레딧은 **잔액 + auto top-up(임계값/금액 2필드)**로 — 두 프레임을 섞지 말고 시각적으로 분리한다. 문구는 Claude 원문 구조(`You've hit your weekly limit · resets Mon 12:00am`)를 차용. **지표 조회 실패 시 `Showing last-known usage` 폴백은 반드시 넣는다**(에이전트가 계속 도는 제품에서 사용량 화면이 빈 채로 뜨면 최악). 예측형 소진 표시는 아무도 안 하고 있으니 차별화 여지.

---

## 6. 크레딧 충전 + 오토스케일링 가시화

### 교차 발견
- **금전(크레딧/잔액)은 소진형, 동시성/처리량은 레이트 미터형**으로 이원화되는 게 5개 제품 공통 패턴.
- **하드 캡 도달 = 즉시 실패(429)가 주류**, 큐잉은 Modal이 예외.
- 실시간 "한도 임박" 토스트의 **정확한 카피는 어느 제품도 공개하지 않음**(전부 `미확인`) — API 에러 코드만 확인 가능.

### Modal `[공식]`
- Starter 무료: **$30/month free credits**, **100 containers**, 10 GPU concurrency, 3 seats, 카드 불필요.
- Usage & Billing: "Manage payment details", "View invoices", **"Workspace budget"**(월 청구주기 내 spend cap, Owner/Manager만 설정·수정·삭제).
- **오토스케일링 시각화가 이 조사에서 가장 참고할 만함**: 컨테이너 수를 단독 시계열로 그리지 않고, **레플리카 수 변화 + 지연·큐 지표를 4분할로 겹쳐** 보여준다. 블로그 캡션 원문: *"Two additional replicas are automatically spun up"* + 녹색 레플리카 차트, 좌상단 TTFT / 우상단 ITL(디코드 큐잉으로 상승) / 우하단 큐 깊이(*"The queue shrinks"*) / 좌하단 종단 지연.
- Endpoint Activity 뷰: **Running vs Queued 요청 수**를 그래프로 — 동시성 캡 도달을 **큐 깊이로 시각화**하는 유일한 사례.
- 오토스케일 정책은 대시보드가 아니라 SDK 파라미터(`min_containers`/`buffer_containers`/`max_containers`/`scaledown_window`).
- `미확인`: "Workspace budget"의 정확한 입력 필드명, 상한 도달 시 자동 정지 여부.

### E2B `[공식]`
- Hobby: **$100 1회성 크레딧**, 동시 샌드박스 20개, 세션 최대 1시간. Pro: $150/월 + 사용량 과금, 동시 100개(추가 구매로 최대 1,100), 세션 최대 24시간.
- `e2b.dev/dashboard?tab=usage` / `?tab=budget`(지출 한도).
- **한도 도달 시 `RateLimitError`/HTTP 429로 즉시 실패 — 큐잉 없음.**
- 무료 티어는 자동 유료 전환 없음: 크레딧 소진 시 다음 달까지 신규 샌드박스 생성 차단.
- 오픈소스 대시보드 README: 샌드박스 페이지네이션 라이브 목록, 샌드박스별 CPU/메모리/디스크 모니터링, 로그, 파일시스템 인스펙터, **인브라우저 터미널**.
- `미확인`: Budget 페이지 입력 필드명, 동시성 한도가 대시보드 어느 화면에 노출되는지.

### Daytona `[공식+비공식]`
- **auto top-up이 요청하신 "threshold + amount" 2필드 패턴의 가장 명확한 실례**: **Threshold**(이 값 이하로 떨어지면 트리거) + **Target**(충전 후 도달할 목표 잔액), **둘 다 0이면 비활성화**.
- Wallet: 현재 잔액 + 이번 달 소진 크레딧을 USD로, 쿠폰 입력 + "Redeem", 사전정의/커스텀 금액 1회성 "Top up".
- 지출 분석: 총 비용, 샌드박스 수, CPU/RAM/디스크 요약, 리소스별 분해, 샌드박스별 사용량+가격, 월별 인터랙티브 차트.
- Limits: Compute/Memory/Storage를 **조직 단위 공유 풀**로 표시. 티어는 이메일 인증 → 카드+$25 → $500 → $2,000/30일 순으로 상승.
- 샌드박스 목록: State가 **색상 코드 배지** — STARTED(초록 solid), STARTING/STOPPING(스피닝), ERROR(복구 가능하면 렌치 아이콘으로 복구 액션). 상세 패널은 Overview/Logs/Traces/Metrics/Spending/Terminal/Filesystem/VNC 탭, 폭 450px→1600px 확장.
- 한도 초과: `429` + `{"statusCode":429,"message":"Rate limit exceeded"}`. 리소스 쿼터는 **2단계 커밋(reserve→confirm)** 후 실패 시 롤백 — 큐 아님.
- ⚠️ 티어별 수치와 상세 패널 구성은 **DeepWiki(AI 생성 비공식 위키)** 출처 — 공식 페이지 교차검증 권장.

### 참고: Vercel / Railway / Fly.io `[공식]`
- **Vercel Spend Management**가 알림 설계의 좋은 레퍼런스: USD 금액 지정 → **50%/75%/100% 도달 시 웹+이메일 알림**(100%는 SMS도), 옵션으로 "Pause production deployment" 스위치(**팀명 재입력으로 확인**). 체크 주기가 "every few minutes"라 실시간 하드컷은 아님을 문서가 명시. 초과 시 방문자에게 `503 DEPLOYMENT_PAUSED`. 웹훅 페이로드에 `budgetAmount`/`currentSpend`/`thresholdPercent`.
- **Railway**: **소프트 한도(이메일 알림만)와 하드 한도(전 워크로드 오프라인)를 별도 필드로 분리**. 75%/90%/100% 순차 알림. 하드 한도 최소 $10.
- **Fly.io**: 공식 문서가 *"We don't support billing alerts (yet), so budget accordingly."*라고 명시 — alert/spend-cap/auto-recharge 부재.

> **oort 번역**: 크레딧은 **Daytona식 Threshold+Target 2필드 auto top-up**, 알림은 **Vercel식 50/75/100% 단계 + 소프트/하드 한도 분리(Railway)**. 동시 에이전트 캡은 잔액이 아니라 **레이트 미터(현재 N / 최대 M)**로 그리고, 캡 도달 시 즉시 실패보다 **Modal식 큐 깊이 노출**이 메신저 맥락에 맞다("김인턴이 대기열 2번째" 가 "실패했습니다"보다 낫다).

---

## 종합: oort가 바로 가져갈 5가지

1. **첫 화면 와우 = 에이전트가 에이전트를 호출하는 장면.** buzz의 Welcome Kickoff가 정답에 가깝다. 단 지연 판정 백스톱은 buzz가 15초→120초로 고쳐야 했던 실측 교훈을 그대로 승계.
2. **사이드바 작업중 표시 = 틱하는 경과시간 pill.** 스피너보다 정보량이 크고, 멈춘 에이전트를 즉시 드러낸다. `(N)` + "리드 외 N명" 툴팁까지 세트.
3. **모델/effort는 요청 오버라이드가 아니라 상속 체인 + 명시적 "Inherit (…)" 옵션.** 단, Auto 라우팅을 쓰면 실제 응답 모델은 **반드시** 라벨링(Copilot 쪽, Cursor 반대편).
4. **관전 패널의 두 필수 기능**: 자리 안 잃고 인라인 프리뷰(Claude Agent View), 프로세스는 살리고 턴만 중단(buzz "Stop current turn").
5. **죽은 에이전트 방어**: Slack의 2분 강제 상태 클리어 + Linear의 `stale` 상태. 이게 없으면 "영원히 작업 중" 좀비가 UI를 오염시킨다.

## 확인 불가(미확인) 종합

- **Orca**: 성재가 의도한 제품이 stablyai/orca가 맞는지 자체가 미확인. 온보딩 시퀀스·로그인 필요 여부·단계 수 대부분 미확인.
- **Cursor**: 첫 실행 화면 순서(공식 1차 문서 없음), "Tab 튜토리얼 자동 오픈" 여부(어떤 소스에서도 미확인), 대시보드 게이지의 시각 레이아웃, Auto 드롭다운 설명 문구(공식 페이지 404).
- **t3.chat**: 로그인 전 게스트 채팅 가능 여부, BYOK 프롬프트 타이밍, 모델 피커 capability 필터·BYOK 아이콘 시각 디자인.
- **Raycast**: 온보딩 화면들의 정확한 버튼 카피(화면명·타임스탬프만 확보).
- **Codex 앱**: 2026-07 현재 승인 모드 화면의 리터럴 라벨(3개 소스가 서로 다른 네이밍), CLI 상태줄 정확한 포맷(2차 출처 2개가 불일치).
- **ChatGPT**: help.openai.com 전 페이지 WebFetch 403 → 한도 도달 문구·소비자용 사용량 대시보드 존재 여부 미확인. Auto/Fast/Thinking 중 실제 응답자를 라벨링하는지도 미확인.
- **Claude**: 모델 폴백 라벨의 시각 형태(pill/badge/헤더), 계정 기본값 vs 대화 override 구분 인디케이터, 한도 임박 인앱 경고 배너의 현행 문구.
- **Slack**: 타이핑 인디케이터 사라짐 타임아웃 정확한 초, **사이드바/채널 리스트 노출 여부**, "Several people" 전환 임계값·이름 트렁케이션, `loading_messages` 회전 간격.
- **Linear**: 상태 아이콘의 정확한 형태/채움 규칙(공식 문서 텍스트에 없음), 에이전트 활동의 사이드바 시각 표현, 뷰잉 프레즌스 기능 존재 여부.
- **Modal/E2B**: budget 입력 필드명·레이아웃, 동시성 한도의 대시보드 노출 위치.
- **Daytona**: 티어별 리소스 수치·상세 패널 구성이 DeepWiki(비공식 AI 생성) 출처, 프론트엔드 에러 토스트 문구.
- **전 제품 공통**: 실시간 "한도 임박" 토스트/배너의 정확한 카피는 어디도 문서화 안 함.

## 주요 출처

buzz 소스: `github.com/block/buzz` @ `ab3af82` (2026-07-24) — `desktop/src/features/{onboarding,agents,channels,sidebar}`
공식 문서: support.claude.com · code.claude.com · platform.claude.com · docs.slack.dev · linear.app/developers · cursor.com/docs · cursor.com/help · learn.chatgpt.com · openrouter.ai/docs · modal.com/docs · e2b.dev/docs · daytona.io/docs · docs.devin.ai · docs.github.com/copilot · vercel.com/docs · docs.railway.com · fly.io/docs · docs.discord.com
2차: forum.cursor.com · feedback.t3.chat · pageflows.com · andrew.ooo · macrumors.com · jdhodges.com

---

## 부록 C. herdr (성재 질의 2026-07-26, 소스 직독 — ogulcancelik/herdr, Apache-2.0, commit 8843bbb)

**정체**: 코딩 에이전트용 터미널 멀티플렉서(Rust 단일 바이너리, tmux 계열 TUI). 워크스페이스/탭/페인 토폴로지에 실제 PTY를 담고, 페인 안에서 도는 에이전트(claude·codex·opencode 등)를 감지해 **blocked/working/done을 한눈에** 보여준다. detach 후에도 에이전트는 계속 돌고 ssh 포함 어디서든 reattach, 세션은 재시작을 견딘다.

**주목 포인트(소스 확인)**: ①순수 소켓 API + 동봉 Claude 스킬 — 에이전트가 herdr 페인을 spawn하고 출력을 읽고 서로를 wait할 수 있다(로컬판 에이전트 오케스트레이션) ②에이전트 세션 resume 매핑(`codex resume <id>` 등)을 도구별로 정본화 ③최근 커밋이 **사이드바 worktree 계층** — 우리 goal_claim 워크트리-티켓 모델과 같은 정신 모델 ④감지 매니페스트 기반 에이전트 인식(src/detect/).

**oort와의 관계**: 니치가 직교한다 — herdr는 **1인·로컬·터미널** 관제, oort 관전 표면은 **팀·원장·권한 계약**(observer capability, RLS) 위의 관제. herdr의 상태 문법(blocked/working/done at a glance)이 우리 작업중 표시·작업 패널과 수렴한 것은 방향 검증으로 읽으면 된다. oort가 못 하는 것(로컬 터미널 멀티플렉스)을 herdr가 하고, herdr가 안 하는 것(팀 공유·승인 원장·비용)을 oort가 한다.

**우리 내부 사용 여부**: 미사용. 내부 오케스트레이션은 Claude Code Workflow(API 기반 서브에이전트 — PTY가 아니라 herdr에 안 잡힘)+goal_claim 워크트리+codex-fleet. **채택 판단**: 파이프라인 도입 실익 없음. 성재가 로컬에서 CLI 에이전트를 직접 여럿 돌릴 때 개인 관제용으로는 유용할 수 있음(brew install herdr). 참고할 세부: 소켓 API의 "에이전트가 서로를 wait" 문법, resume 매핑 정본화.
