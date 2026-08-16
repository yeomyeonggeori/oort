# 채팅 내 라이브 VM·사람 인수(takeover) — 관전 축의 다음 해상도

> 2026-08-15 Fable 리서치. 성재 발제: "Grok Bot이 채팅 안에서 VM 화면을 보여주고, 내가 직접 조작해 로그인도 하고 화면도 보는 게 마음에 든다."
> 판정 요지: **그린필드가 아니다.** oort는 이미 관전(spectate) 축 + 재개/인수(sessionHandoff) + T3 워크호스트를 갖고 있고, 이 기능은 관전을 "전사(transcript)를 본다"에서 "**라이브 화면을 보고 직접 끼어든다**"로 올리는 **해상도 증분**이다. 전송 기술과 자격 핸드오프 보안 패턴은 업계가 이미 수렴했으며 우리 ADR-0004/0150/0156과 정확히 맞물린다.
> 출처: 전부 조회일 2026-08-15. [확실]=1차 벤더 문서/실측, [추정]=2차·미명기.

## §1. Grok Bot이 실제로 하는 것 (재실측)

- 계정당 **1대의 퍼시스턴트 클라우드 컴퓨터**(브라우저·터미널·파일시스템)를 모든 봇이 공유("Isolation is per user, not per Bot"). 대화에서 "Agent Computer"를 열면 화면 프리뷰가 뜨고 **"clicks, typing, navigation, current status"**를 실시간으로 본다. [확실] (docs.x.ai/grok-bot/computer-and-apps, overview)
- **사람 인수**: "Open the computer, take control, complete only the blocked step, and tell the Bot to continue." 봇이 민감 입력(비밀번호·2FA·CAPTCHA)에 도달하면 **정지하고 사용자에게 제어를 넘긴다**. 사용자는 막힌 스텝만 처리하고 반환한다. [확실] (같은 문서)
- **자격 핸드오프**: "For a supported connection that presents a secure secret request, enter the value there instead. The value is masked and is **not added to the conversation**." + "Avoid pasting passwords or one-time codes into chat." → **에이전트는 비밀번호를 직접 받지 않는다.** [확실]
- **세션 영속**: "Browser sessions persist so you usually do not need to sign in for each task." 다만 일부 사이트는 만료·재검증. 최대 세션 길이·정량 한도 미공개. [확실/추정]
- 전송 프로토콜: 문서에 **미명기**("preview"·"screens"만). noVNC/WebRTC 어느 쪽인지 미확인. [추정]

## §2. 제품 대조표 (제품 × 스트리밍 전송 × takeover × 자격 핸드오프)

| 제품 | 스트리밍 대상 | 전송 | 라이브 takeover | 자격 핸드오프 보안 |
|---|---|---|---|---|
| **Grok Bot** (xAI) | 풀 클라우드 컴퓨터(브라우저+터미널) | 미명기 [추정] | ✅ "take control, complete blocked step" | secure secret request(마스킹·대화 비유입) [확실] |
| **OpenAI Operator / ChatGPT agent** | 가상 브라우저 | 미명기(가상 브라우저 뷰) | ✅ "Take over browser" | **"while you control the browser, screenshots are not captured"** — 에이전트가 비번을 못 봄, 인증 후 **세션 쿠키**로 재개 [확실] (help.openai.com/articles/11752874, openai.com/index/introducing-operator, learn.chatgpt.com/docs/auth) |
| **E2B Desktop** | 풀 Linux 데스크톱(Ubuntu22+XFCE) | **x11vnc + noVNC**(WebSocket VNC), `stream.getUrl({view_only})` | ✅ view_only=false면 상호작용, true면 관전 | 문서 미기재(인프라 프리미티브) [확실] (docs.e2b.dev/use-cases/computer-use, github.com/e2b-dev/desktop) |
| **agent-browser** | 브라우저 뷰포트 | **CDP screencast → base64 JPEG over WebSocket**(9~54KB/frame), 입력(마우스·키보드·**터치**) 독립 포워딩 | ✅ 입력 이벤트 포워딩 | — [확실] (agent-browser.dev/streaming) |
| **Cloudflare Browser Run** | 브라우저 | Live View | ✅ "Human in the Loop" + 세션 녹화 | — [확실] (blog.cloudflare.com/browser-run-for-ai-agents) |
| **Browserbase / Steel** | 브라우저 | Live View(CDP류) | ✅ pair-browsing/takeover | Steel=오픈코어 셀프호스트 가능 [확실] (2차) |
| **Claude in Chrome / Computer Use** | 사용자 **자기 로컬** Chrome(확장) | 로컬(스트리밍 아님) | 사람 상주·사이트별 권한 | 로컬 브라우저라 자격이 애초에 사용자 소유(T1형) [확실] (본 세션 실행 환경) |

**전송 수렴**: ①브라우저 전용 = **CDP screencast**(base64 프레임/WebSocket). ②풀 데스크톱 = **noVNC(x11vnc+websockify)**. ③저지연 현대 = **WebRTC/Selkies-GStreamer**(Kasm 계열, 고프레임·무거운 인프라). E2B가 **풀 데스크톱에 noVNC**를 택한 것이 우리에게 가장 직접적인 선례다(우리 T3도 풀 microVM).

## §3. 자격 핸드오프 보안 패턴 — ADR-0004의 자연 확장

업계가 수렴한 불변식(OpenAI가 가장 명시적):

> **사용자가 조작하는 창은 에이전트가 캡처하지 않는다.** 에이전트는 자격증명이 아니라 **인증된 세션(쿠키)**으로 재개한다.

세 층으로 분해되고, 셋 다 우리 기존 ADR에 매핑된다:

1. **자격증명 비유입 (ADR-0004의 주어 교체).** ADR-0004는 "provider 자격증명이 oort 서버·에이전트·audit·로그에 안 들어온다"이다. 이 기능은 같은 규칙을 **사용자 자격증명**에 적용한다 — 사용자가 라이브 VM에 직접 타이핑하고, 그 비밀번호는 에이전트 컨텍스트·전사·audit·스크린샷 어디에도 안 들어온다. **주어만 바뀐 같은 불변식.** ADR-0004 증보로 흡수 가능.
2. **takeover-창 비관측 (신규 경계).** 새로 필요한 규칙: takeover 모드 동안 display 스트림과 입력은 **사람↔VM 직결**이고 에이전트의 관측·프레임 캡처·키로그·audit이 **차단**된다. 에이전트는 "정지했고 언제 반환됐다"만 알고 그 사이 픽셀·키를 못 본다. E2B의 `view_only`가 상호작용 유무는 나누지만 "에이전트 비관측"은 우리가 명시해야 하는 계약이다. **이것이 새 ADR 사안**(관전 축 + 자격 경계).
3. **egress 스코프 (ADR-0150 증보 1과 맞물림).** takeover VM의 egress는 사용자가 로그인하는 그 도메인으로 좁혀진다. ADR-0150 증보 1(2026-08-15 Accepted)의 capability-grant egress가 정확히 이 자리다 — "사용자가 이 서비스에 로그인" = 그 도메인 grant, 저대역 유출 채널은 원장 관측. takeover는 grant를 넓히는 인간 행위이므로 그 순간의 egress 확장을 audit에 남긴다.

**수명주기·과금 매핑**: 에이전트 정지=ADR-0140 pause 재사용. takeover 중 VM은 running이나 **에이전트 토큰 소진은 0** — ADR-0164의 running-time 과금만 계속되고 모델 토큰은 멈춘다(사람이 조작하는 동안 크레딧이 토큰으로 새지 않음). pause≠종료 계약과 정합.

## §4. oort 편입 설계 (관전 축 위)

**핵심 통찰: attach_endpoint를 PTY 스트림에서 display 스트림으로 확장하는 것.** 오늘 관전은 read-only observer terminal + reattach verdict다. 서버는 이미 `pty_id`·`attach_endpoint`를 원장에 투영하고(`REATTACH_COLUMNS: ws.pty_id IS NOT NULL AND ws.attach_endpoint IS NOT NULL`), sessionHandoff가 재개/인수를 판정한다. 이 기능은:

- **관전에 두 번째 종류를 더한다**: 터미널 스트림(현행) 옆에 **화면(VNC) 스트림**. `attach_endpoint`가 종류(pty|display)를 갖도록 확장. WorkPanel/ADE의 observer가 "로그를 본다"에서 "라이브 화면을 본다"로.
- **관전에 두 상태를 준다**: **보기(view_only)** ↔ **조작(takeover)**. sessionHandoff의 재개/인수 어휘에 세 번째 동사를 발명하지 않는다 — takeover는 인수의 특수형이 아니라 **관전의 상호작용 상태**다(원래 호스트가 살아 있고, 세션은 거기 그대로, 사람이 잠깐 손을 얹는다). 어휘 판정을 서버가 하는 기존 규율 유지.
- **로그인-핸드오프 UX**: 에이전트가 "여기서 로그인해 주세요"로 정지(pause) → 사용자 takeover(비관측 창) → 완료 후 반환 → 에이전트 resume(세션 쿠키로). 정지/반환 상태를 서버 verdict로, 카피는 UX4 consent의 "무엇을 넘기는가" 규율 + ADR-0004 비유입 문장 재사용.

**전송 권고 (T3)**: **noVNC 1차, WebRTC 지연 업그레이드.** 근거 — ①우리 CubeSandbox가 이미 풀 Linux microVM(ADR-0156)이라 x11vnc+websockify가 E2B의 검증된 정확한 선택 ②같은 오리진 WebSocket = 기존 인프라·CSP(ADR-0150) 위에 바로 ③`view_only` 플래그가 관전/takeover 분기를 공짜로 준다 ④noVNC는 터치 지원 → 모바일 관전 가능(agent-browser도 touch 포워딩). WebRTC/Selkies는 고프레임·저지연이 필요해질 때의 L급 업그레이드(전송 경계 ADR).

## §5. 채택 후보 (S/M/L) + ADR 필요 여부

| # | 후보 | 규모 | ADR |
|---|---|---|---|
| A | **T3 세션에 noVNC view-only 스트림** — 관전을 로그→라이브 화면으로. `attach_endpoint`에 display 종류 추가, WorkPanel observer 확장, x11vnc+websockify를 CubeSandbox 템플릿에 | **S~M** | 불요(관전 해상도 증분·ADR-0156 어댑터 위). 단 스트림 인증(authKey)·같은-오리진은 실측 |
| B | **input-takeover 모드**(view_only=false) + agent-pause 결선 + **takeover-창 비관측 불변식** | **M** | **필요** — 자격/관측 경계(ADR-0004 증보 또는 신규). 이 문서 §3-2가 초안 |
| C | **로그인-핸드오프 UX** — "여기서 로그인" 정지→takeover→세션-쿠키 resume. sessionHandoff 어휘 확장, 비유입 카피 | **M** | B에 종속(같은 경계). UX는 design-review |
| D | **WebRTC/Selkies 저지연 업그레이드** — 고프레임 데스크톱·모바일 최적 | **L** | 필요(전송 경계) |
| E | **브라우저 전용 경로**(CDP screencast) — HAP hosted-agent·경량 태스크용, 풀 desktop 불요 시 | **M** | 경우에 따라(HAP 다이얼인 봇은 provider VM이라 관측만 가능·우리 통제 밖) |

권장 순서: **A(관전 해상도) → B+C(takeover+로그인, ADR 선행) → D(지연) / E(브라우저 경로)**. A는 ADR 없이 오늘 착수 가능하고, 그것만으로 "채팅에서 라이브 화면을 본다"의 절반(보기)이 선다.

## §6. 성재 결정 큐

1. **관전 해상도 승격(후보 A) 착수 여부** — 로그→라이브 화면. ADR 불요, T3 워크호스트 관전에 noVNC view-only. 오늘 시작 가능.
2. **takeover 경계 ADR 기안 방향** — "사용자 자격 비유입 + takeover-창 비관측"을 ADR-0004 증보로 흡수할지 신규 ADR로 세울지. §3이 초안 재료.
3. **전송 순서 확정** — noVNC 1차 / WebRTC 지연 업그레이드(권고) vs 처음부터 WebRTC.
4. **범위** — T3 클라우드 전용인가, T1 데스크톱(사용자 자기 기기)의 라이브 화면(Claude-in-Chrome형 로컬 변형)까지인가.
5. **HAP hosted-agent 관전** — 다이얼인 봇(Grok 등)의 화면을 사용자가 보게 할 것인가. provider VM이라 우리는 **관측만**(스트림 프록시) 가능하고 takeover는 provider 소관 — 관측 프록시조차 provider API가 없으면 불가(08-12 인바운드 불가 판정과 같은 벽). 관리형(oort 실행) 에이전트에는 A~C가 온전히 성립.

## 출처
- docs.x.ai/grok-bot/{computer-and-apps, overview, troubleshooting} · techtimes.com/articles/324176 (Grok Bot 공유 클라우드 컴퓨터·takeover·secure secret)
- help.openai.com/en/articles/11752874-chatgpt-agent · openai.com/index/introducing-operator · learn.chatgpt.com/docs/auth · alphasignal.ai (Operator/agent takeover·"screenshots not captured"·세션 쿠키 재개)
- docs.e2b.dev/use-cases/computer-use · github.com/e2b-dev/desktop · deepwiki.com/e2b-dev/desktop (x11vnc+noVNC·view_only·풀 XFCE 데스크톱)
- agent-browser.dev/streaming (CDP screencast·base64 JPEG·입력/터치 포워딩·프레임 크기)
- blog.cloudflare.com/browser-run-for-ai-agents (Live View·Human in the Loop)
- 내부: docs/planning/research/2026-08-12-grok-bot-integration-feasibility.md · 2026-08-14-grok46-worker-integration.md · packages/momo-core/src/features/work/{sessionHandoff,workLocation}.ts · docs/adr/{0004,0140,0150,0156,0164}
