# 그록봇 제어 재검토 — CDP 필연성·오픈소스 오해·Push(직접 요청) 가능성

- 작성: 2026-08-24 Fable(momo-main) · 발제(성재): "①폰/데스크탑에 깔려있는데도 CDP를 써야 하나 ②오픈소스니 사용자가 본인 그록봇에 붙이는 CDP면 정책 무문제 아닌가 ③루틴 1440×/일 polling은 탐탁찮다 — Grok Build/Grok 쪽으로 직접 요청 쏘고 그록봇이 응답하는 형태를 알아봐달라"
- 선행 정본: `2026-08-22-grok-cdp-control-and-operator-host.md` · `2026-08-16-grok-ecosystem-2026.md` · `2026-08-22-grokbot-vm-persistence-ra4.md` · 메모리 [[grokbot-infra-and-terms]] · ADR-0162(Agent Port pull 설계)·ADR-0004(provider 경계).
- 재실측: 2026-08-24 (docs.x.ai·cursor.com·releasebot xAI 8/17~24). **구조 판정 3종 전부 유지** — 신규 인바운드/웹훅/호출 표면 없음(8/21 Bot 플랜 확대뿐).

## 0. 세 질문 한 줄 답

1. **CDP 필연성**: 데스크탑/폰 앱은 **클라우드 VM의 얇은 클라이언트**(브레인은 로컬 아님). 로컬에 노출된 봇 API/소켓 없음 → CDP(Electron 렌더러 :9333)가 유일했던 자동화 손잡이. 필연이 아니라 "유일했던 것"이고, **이미 은퇴**(자연어 릴레이 전환, 2026-08-22 결재).
2. **오픈소스 전제**: 두 오해. (a) **그록봇은 오픈소스 아님** — Cursor/Anysphere 폐쇄 SaaS. 오픈소스는 oort(우리 레포)다. (b) 사용자가 **본인** 계정에 CDP를 붙여도 적용 약관은 Cursor ToS이고 **자동화·비인간·프로그램 접근 금지(B3) 조항은 계정 소유자를 그대로 구속**. "본인 계정"은 *필요*조건(타인 계정 대행 리스크 제거)이지 *충분*조건이 아님. CDP 자동화 자체가 여전히 약관 사정권.
3. **Push(직접 요청→응답)**: **그록봇 제품에는 push 경로가 없다**(인바운드 API·웹훅·외부 트리거 전무, 웨이크업 주권 xAI 소유 — 재확인). polling을 피하는 native 경로는 **폐쇄 목록 이벤트 트리거(Slack/GitHub/Teams)** 하나뿐이며 그것도 제3자 채널을 배달부로 낀다. "Grok이 응답"을 넓게 보면 **xAI API(Remote MCP Tools)** 또는 **Cursor Cloud Agents API**가 진짜 push 표면 — 단 응답 주체가 *봇 페르소나가 아니라 모델/클라우드 에이전트*다.

## 1. Q1 — "폰/데스크탑에 깔렸는데 왜 CDP인가"

핵심 사실: **그록봇 앱 = 계정귀속 클라우드 VM(com.anysphere.sand)으로의 얇은 클라이언트.** 컴퓨트(브라우저·터미널·`/workspace`)는 xAI/Cursor 클라우드에 있고, 데스크탑/폰 앱은 그 창일 뿐이다(메모리 [[grokbot-infra-and-terms]] durable-but-resettable 확증).

⇒ "로컬에 깔렸으니 로컬 API가 있겠지"가 성립하지 않는다. 로컬에 노출된 것은 **Electron 렌더러의 DOM/컴포저**뿐. 데몬·소켓·IPC로 봇을 부르는 로컬 표면이 없다. 그래서 프로그램 제어의 유일한 손잡이가 CDP(`--remote-debugging-port=9333`)였다 — 렌더러 컴포저에 `Input.insertText` 주입까지 성립했으나 **SEND는 auto-mode 분류기가 차단**(선행 실증). 즉 CDP는 "필연"이 아니라 "그것밖에 없었던 것"이고, 성재 결재로 **자연어 릴레이(지시=Fable, Enter=사람)로 이미 은퇴**했다.

## 2. Q2 — "오픈소스니 본인 CDP면 정책 무문제 아닌가"

**오해 (a) — 무엇이 오픈소스인가**: 오픈소스는 **oort**(yeomyeonggeori/oort, 2026-08-10 public). **그록봇은 폐쇄 SaaS**다(SpaceXAI+Anysphere 합병 첫 제품, App Store 리스팅=Anysphere Inc., 약관=Cursor ToS). 우리 레포가 오픈소스인 것과 그록봇 약관은 무관 — 그록봇에 붙는 어떤 제어도 Cursor ToS를 따른다.

**오해 (b) — "본인 계정"이 면죄부인가**: 아니다. 본인 계정/VM 전용은 성재가 이미 확정한 구조(2026-08-22 Q-STRUCT)로 **타인 계정 대행·공용 데모 호스트 리스크를 제거**한다 — 이건 옳다. 그러나 Cursor ToS의 **자동화·비인간·프로그램 접근 금지**는 계정 *소유자*를 구속하므로, 본인이 자기 봇에 CDP를 붙여 자동 SEND를 돌려도 조항 위반 구조는 동일하다. 여기에 Beta §1.6("not for production")·durable-but-resettable(Update 시 우리 설치물 증발)이 겹친다.

정리: **본인 계정 = 필요조건(대행 리스크 0), CDP 자동화 무해 ≠ 성립.** 이 판단이 정확히 자연어 릴레이 전환의 근거였다. "각 사용자가 알아서 CDP 배선" 구조로 제품에 실으면 우리가 약관 위반을 *조력*하는 리스크(Q-LEGAL 계류 항목)로 승격된다 — 오히려 더 나쁘다.

## 3. Q3 — Push: "Grok Build/Grok에 직접 쏘고 그록봇이 응답"

발제의 이상형 = **push**(oort가 요청 → 그록봇이 깨어나 응답), 현행 = **pull**(그록봇 루틴이 oort를 폴링, ADR-0162). 폴링이 싫다는 건 정당한 직관이다. 실측 결과:

### 3-A. 그록봇 제품 자체 = push 불가 (구조 판정, 재확인)
| 방향 | 상태 |
|---|---|
| 봇 인바운드 API(열거/호출/위임 OAuth/export) | **전무** — grok.com/앱/봇 어디에도 없음 |
| 임의 웹훅 등록(oort가 봇을 깨움) | **전무** — 트리거는 폐쇄 목록만 |
| 루틴 트리거 | 스케줄(일/요일/시각 — **분 단위 미실증**) + 폐쇄 이벤트(Slack·GitHub·Teams, Cursor 계정 통합 경유) |

8/21 Bot이 SuperGrok Plus·Cursor Pro+/Ultra/Teams까지 확대됐으나 **"no new API, webhook, or programmatic invocation surface"**(releasebot 8/17~24). 웨이크업 주권은 계속 xAI 소유.

⇒ **"그록봇"이 반드시 그 팀메이트 제품을 뜻한다면, polling을 피하는 유일한 native 경로는 폐쇄 이벤트 트리거(Slack/GitHub/Teams)뿐.** oort가 GitHub 알림이나 연결된 Slack 워크스페이스에 이벤트를 흘리면 봇 루틴이 폴링 없이 깨어난다. 대가: (i) 임의 oort 웹훅 불가 — 제3자 채널을 배달부로 낌 (ii) 루틴당 수동 설정 (iii) 제3자 종속. **1440×/일 폴링 → 이벤트 구동**으로 바뀌긴 하나 Slack/GitHub를 경유하는 우회.

> 참고: 루틴 최소 간격이 분 단위라는 근거가 문서에 없다(일/요일/시각 예시뿐). "1440번/일"은 실현조차 불확실 — 실질 하한은 더 성길 수 있다. 어느 쪽이든 폴링을 *완전히* 벗으려면 그록봇 제품을 떠나야 한다.

### 3-B. "Grok Build에 쏘면 그록봇이 응답" = 두 제품 혼동
- **Grok Build CLI(`grok`)** = 공식 헤드리스 코딩 에이전트(구독 OAuth). 우리 리뷰어 C/워커가 이것. **그록봇(팀메이트)이 아니다.** Grok Build에 요청해도 응답하는 건 CLI 세션이지 봇 페르소나가 아니다. 두 표면은 주간 사용량 풀만 공유.
- **xAI API(api.x.ai)** = OpenAI 호환 + 서버사이드 Agent Tools + **Remote MCP Tools**(모델이 우리 Agent Port를 서버사이드로 직접 소비). 구독과 **과금 완전 분리**(선불 종량).

즉 "요청 쏘고 Grok이 응답"을 **모델 응답**으로 보면 xAI API가 정확히 그 형태다(push·스펙·과금 명확). 단 응답 주체가 **VM·워크스페이스·기억을 가진 그록봇이 아니라 stateless 모델 호출**이다.

### 3-C. 진짜 "역방향 push 에이전트" = Cursor Cloud Agents API
Heavy→Ultra 무료 연동으로 이미 접근 확보. **REST 실재**: `POST /v1/agents`(생성)·`POST /v1/agents/{id}/runs`(팔로업, SSE)·archive/delete, 모델 지정(Grok 4.6). **spawn·팔로업·중지 결정권이 API로 우리에게** — 그록봇과 결정적 차이(worker 규율 성립). 허들 3: (i) GitHub 레포 URL 필수 → **코드 이그레스 결정 선행**(비공개 레포를 Cursor 클라우드 노출, ADR-0150 계열) (ii) 웹훅 legacy v0만 — 회수는 폴링/SSE (iii) 쿼터 불투명.

## 4. 판정·권고

| 발제 해석 | 실현 경로 | 상태 |
|---|---|---|
| "그록봇(팀메이트)이 응답" | polling(현행 Agent Port) 또는 폐쇄 이벤트 트리거(Slack/GitHub/Teams 우회) | push 불가 — 구조 한계 |
| "Grok 모델이 응답" | **xAI API + Remote MCP Tools**(모델이 Agent Port를 서버사이드 소비) | ✅ 깔끔한 push·드롭인(ADR-0004) |
| "Grok 에이전트가 응답" | **Cursor Cloud Agents API**(spawn/run/stop 우리 통제) | ✅ push — 단 코드 이그레스 결정 선행 |

**권고**: 폴링·CDP·약관 문제를 한꺼번에 벗는 방향은 **그록봇 제품 편입을 고집하지 않는 것**이다.
1. **역방향 소비(권장 1순위)**: managed provider 경로(ADR-0163)에서 xAI API의 **Remote MCP Tools**로 모델이 oort Agent Port를 직접 호출 — "Grok이 oort 도구를 서버사이드로 돌린다". 승인 게이트 부재이므로 `allowed_tools` 화이트리스트 필수(ADR 증보감).
2. **클라우드 워커(권장 2순위)**: Cursor Cloud Agents API 파일럿 — 코드 이그레스 판단 후 비민감 레포 1티켓 실측.
3. **그록봇 유지 시**: 폴링 대신 폐쇄 이벤트 트리거로 부분 개선 가능하나 제3자 경유·설정 부담 — 차별화 가치 낮음. 현행 자연어 릴레이/pull 다이얼인 유지가 무난.

**경계 유지**: 어느 축도 단일 의존 금지(Agent Port=벤더 중립, provider=opaque 드롭인, 워커=3사). CDP 자동 제어 은퇴·본인 계정/VM 전용은 확정 사항 — 되돌리지 않음.

## 5. 성재 결정 큐
- **Q-DIR**: push를 원하는 실체가 (a) 그록봇 팀메이트인가 (b) "Grok이 응답하면 됨"인가? (a)면 구조상 pull/이벤트 우회가 상한, (b)면 xAI API/Cloud Agents로 깔끔히 열림 — **권고는 (b) 방향**.
- **Q-MCP**: Remote MCP Tools 채택 시 `allowed_tools` 설계 + ADR 증보 착수할까?
- **Q-EGRESS**: Cursor Cloud Agents 파일럿의 선결 = 비공개 레포를 Cursor 클라우드에 노출할지(ADR-0150 계열). 판단 필요.
