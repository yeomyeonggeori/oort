# Grok Bot 연동 가능성 리서치 (2026-08-12)

> 발제: 성재 — "Grok bot이 X로 바이럴 런칭됨. 셀프호스팅 목표에서 사용자가 Grok bot으로 만든 ~50개 호스팅 봇을 감지/연동해 oort 협업에 쓰는 구조가 가능한지 리서치."
> 수행: Fable 오케스트레이션 · 웹 리서치 에이전트 3기(제품 실체 / API 연동면 / 정책·선례) 병렬 실측. 조사일 2026-08-12(출시 익일).
> 판정 요약: **원안(봇 인바운드 반입)은 현재 불가능 — 공식 표면 전무 + 비공식 경로는 AUP 3중 저촉. 성립하는 경로는 역방향 2개(MCP 커넥터 수용 · 봇의 브라우저 로그인 공식 허용)와 모델 단위 1개(xAI API provider).**

## 0. 전제 교정 — 브리핑과 실측의 차이 (중요)

| 브리핑 | 실측 |
|---|---|
| "X를 통해 런칭된 봇 플랫폼" | X는 **발표·바이럴 채널일 뿐**. 실체는 SpaceXAI(구 xAI, 2026-02 SpaceX 피인수·07 리브랜딩)+Cursor(2026-06 $60B 주식 인수 합의, 클로징 전)가 **2026-08-11 베타 출시한 독립 데스크톱(macOS/Windows)+iOS 앱**. X 계정/DM으로 봇이 노출되지 않음 |
| "사용자당 ~50개 호스팅 봇" | 문서상 한도는 **"봇 1개당 루틴(routine) 50개"** ("A Bot can own up to 50 routines" — docs.x.ai/grok-bot/skills-routines-and-automations). **봇 개수 상한은 미공개**. "50"은 루틴 한도의 와전으로 판단 |
| 소비자 대상 무료 바이럴 | **무료 티어 없음.** SuperGrok Heavy $300/월 · Cursor Ultra $200/월 · Cursor Teams Premium $120/석/월 번들. 현재 제한 베타(Musk: Grok 4.6과 함께 금주 후반 확대 예고) |

## 1. 제품 실체 (확정 사실)

- **Grok Bot** = 공식 제품명. "상시 가동 AI 팀메이트": 이름 있는 영속 에이전트에게 동료에게 말하듯 메시지로 업무 배정. Grok(어시스턴트)·Grok Build(CLI 코딩)와 별개의 3번째 제품.
- 구성: 직무 서술 + 턴 간 유지되는 메모리·파일·브라우저 세션 + 스킬(재사용 지시문) + 루틴(스케줄/이벤트 트리거 — 이벤트는 Cursor 통합 Slack·GitHub 폐쇄 목록) + MCP 커넥터.
- 실행 기질: **사용자 계정당 1대의 퍼시스턴트 클라우드 VM을 모든 봇이 공유**(브라우저·터미널·`/workspace`). "Isolation is per user, not per Bot". 봇이 API 없이 사용자의 실제 앱/웹사이트에 **UI 로그인해 직접 조작**하는 computer-use가 핵심 능력.
- 인증·과금 인프라는 **Cursor 계정** 기반. 봇 간 그룹챗/작업 인계는 **제품 내부 기능**.
- 바이럴 규모: 언론 보도 폭은 큼(Bloomberg·VentureBeat·9to5Mac 등, HN 212pt). 사용자·봇 수 정량치는 전무(출시 1일차).

## 2. 연동 표면 실측 — 인바운드 전면 부재 (확정, 부재 근거 명기)

docs.x.ai Grok Bot 전 문서(5편)와 api.x.ai REST 레퍼런스 전 카테고리를 직접 fetch해 확인:

- **봇 열거 API 없음** · **봇 외부 호출 API 없음** — api.x.ai 카테고리는 Chat/Images/Videos/Voice/Models/Files/Batches뿐(모델 추론 표면). Agent Tools API는 "새 에이전트를 빌드"하는 용도로 기존 Grok Bot 접근과 무관.
- **위임 OAuth 없음** — Grok Bot 인증은 Cursor 로그인 단일. 제3자 앱에 봇 접근을 위임하는 흐름 부재. (accounts.x.ai의 구독 OAuth PKCE는 존재하나 **모델 추론** 용도이며 xAI가 계정별 allowlist를 강제.)
- **봇별 endpoint/webhook 없음** · **A2A 미지원** · **export 없음**(봇 정의 이식 개념 자체가 부재 — "Deleting a Bot does not remove shared-computer files").
- **유일한 공식 접점 = MCP, 방향은 봇→외부**: 봇이 MCP를 "소비"만 한다. 사용자가 **커스텀 원격 MCP 서버 URL을 커넥터로 추가 가능**(공개 URL 필요).
- 비공식 리버스 API: Grok Bot 대상은 아직 없음(출시 1일). 소비자 Grok 대상 리버스 생태계(grok-bypass·Grok3API 등)는 풍부 — 곧 나올 개연성 높으나 채택 불가(§3).

## 3. 정책 제약 (약관 원문 실측 — Wayback 스냅샷)

- **xAI AUP**(2026-06-26 발효): 자동화 접근 금지("Accessing the Services through automated or non-human means"), 리버스 엔지니어링 금지, 출력 재판매/증류 금지, 경쟁 AI 서비스 개발 금지. 위반 시 계정 정지.
- **소비자 ToS**: 계정 자격증명 공유 금지 + **베타 기능은 개인·비상업 한정** → 사용자 계정 자동화로 봇을 oort에 재노출하는 구조는 **3중 저촉**이며, 정지 리스크가 **사용자 계정에 전가**된다.
- **엔터프라이즈 ToS**: xAI **API 경유** 통합·재노출("Bundled Services")은 **명시 허용** — 단 이는 모델 통합이지 "사용자의 봇 개체" 접근이 아님.
- 단속 전력: X의 2023 서드파티 클라이언트 즉시 차단 전례. xAI는 개방(모델 가중치 공개·Grok Build 오픈소스·OpenClaw OAuth 허용)과 폐쇄(전면 자동화 금지·사이트 봇 차단)의 양면.
- 업계 패턴: **호스팅 봇 플랫폼은 봇 개체를 외부에 열지 않는다**(OpenAI GPTs "not a way to embed... use the API" · Character.ai · Meta AI Studio 동일). 여는 형태는 (a) 별도 API로 재구축 (b) 구독 OAuth를 서드파티 하네스에 허용(xAI→OpenClaw 2026-05 전례) 둘뿐.

## 4. 판정

**"사용자의 Grok Bot들을 oort로 가져와(인바운드) 협업 멤버로 쓴다"는 원안은 현재 불가능하다.**
① 기술적으로 표면이 없고(열거·호출·위임·export 전무) ② 우회(계정 자동화·리버스)는 AUP 정면 저촉 + 사용자 계정 정지 리스크 전가 + X 계열 단속 전력상 최고위험이라 채택 불가. ③ "감지" 역시 봇이 공개 신원 표면(X 계정 등)을 갖지 않아 자동 감지 대상이 존재하지 않는다.

단, **역방향으로는 지금 성립하는 경로가 둘 있다** — 그리고 이 역방향이 oort의 테제("에이전트=1급 멤버")와 오히려 정합적이다.

## 5. 실행 가능 경로 (권고 순)

- **경로 A — 봇의 브라우저 로그인 공식 허용 (연동 0줄로 성립)**: Grok Bot의 핵심 능력이 "API 없는 서비스에 UI 로그인해 작업"이다. oort가 **"자동화 에이전트 로그인을 공식 허용하는 메신저"를 선언**하고(약관+에이전트 계정 등록 UX), 사용자가 자기 봇에게 "oort 웹에 이 계정으로 로그인해 채널 X에서 일해라"라고 지시하면 끝. 감지는 자동이 아니라 **선언 기반**(사용자가 봇을 agent member로 등록)으로 치환. xAI 측 연동 불요, 정책 리스크는 우리 약관 문제일 뿐(우리가 허용). 언론 프레임도 "대상 서비스가 자동화 접근을 허용하는지 확인하라"는 쪽.
- **경로 B — oort MCP 서버 노출**: 사용자가 자기 Grok Bot 커넥터에 oort MCP 서버 URL을 추가 → 봇이 채널 읽기/쓰기 도구를 획득. A보다 구조적(도구 호출)이지만 **트리거를 oort가 당길 수 없음**(이벤트 트리거는 Cursor 통합 폐쇄 목록) — 봇 참여는 스케줄 루틴/사용자 지시 기반이라 실시간성 한계. MCP 서버 표면 신설은 **경계 변경 → ADR 필수**(인증·권한·RLS 정합 설계 선행).
- **경로 C — xAI API provider 추가 (봇 반입 아님)**: 명시 허용된 유일 경로. Grok 모델을 ADR-0147 `provider_link` 금고+agent-worker 구조에 provider로 추가해 "oort산 Grok 에이전트"를 제공. 기존 아키텍처(ADR-0004 경계) 그대로 수용 가능. 단 이것은 "네 봇을 가져와"가 아니라 "여기서 Grok 에이전트를 만들어"다.
- **경로 D — 관찰(1~2주 + 분기 재실측)**: ①금주 Grok 4.6 동반 확대 롤아웃에서 API/파트너 프로그램 발표 여부 ②"Multi-Agent Beta API coming soon" 풍문(단일 소스, 추정) ③엔터프라이즈 버전 관리 API 포함 여부 ④OpenClaw형 구독 OAuth의 Grok Bot 확장 여부. 표면이 열리면 그때 인바운드 재검토.

## 6. 전략 노트

- **포지셔닝 정면 충돌**: "에이전트를 동료처럼 메시지로 부린다 + 봇 간 그룹챗 협업"은 oort 테제와 동일 좌표. 다만 저들은 $120+/월 폐쇄 SaaS·계정당 VM — HN 출시 스레드에서 **"이걸 직접 겨루는 오픈소스 대안 있나"는 질문이 이미 나왔다**. oort의 기회는 "연동"보다 **"모든 벤더의 에이전트가 협업하는 열린 셀프호스팅 자리"** 그 자체.
- Grok Bot 흡수가 아니라 **수용 태세**가 정답: 경로 A(에이전트 로그인 허용 선언)+B(MCP 표면)는 Grok Bot 전용이 아니라 OpenClaw·Claude·任意 에이전트 하네스에 동일하게 열리는 일반 표면이다.
- 리스크 관찰: X.com 챗+Grok Bot의 Slack 방향 진화 추측(HN) — 분기 재실측 항목.

## 7. 미해결 질문

1. 봇 개수 실상한 — 실구독 계정 앱 실사용으로만 확인 가능.
2. Grok Bot 베타 전용 추가 약관(로그인 장벽 뒤) · Cursor 약관의 적용 범위.
3. 스킬 온디스크 포맷(이식 가능성 재료) — 데스크톱 앱 분석 없이는 불명.
4. 경로 A의 성립 조건 — oort 약관 "에이전트 로그인 허용" 명문화는 **별도 ADR 사안**.

## 출처 (전 항목 2026-08-12 확인)

x.ai/news/introducing-grok-bot · x.ai/bot · docs.x.ai/grok-bot/{overview,get-started,skills-routines-and-automations,computer-and-apps,approvals-security-and-privacy} · docs.x.ai/developers/rest-api-reference · docs.x.ai/grok/connectors · x.ai/legal AUP·ToS·엔터프라이즈 ToS(Wayback 2026-07/08 스냅샷) · docs.x.com/developer-terms/agreement · docs.openclaw.ai/providers/xai · news.ycombinator.com/item?id=49261514 · Bloomberg/VentureBeat/9to5Mac/GIGAZINE/kingy.ai/usecarly/trendingtopics (2026-08-11~12) · Musk X post(x.com/elonmusk/status/2087233507370147920) · durovscode.com(Telegram 딜 무산) · help.openai.com(GPTs) · TechCrunch(2023 X 단속)
