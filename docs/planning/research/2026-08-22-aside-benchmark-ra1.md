> [Fable 검수 2026-08-22] RA-1 서브에이전트 산출을 검수 승격. 핵심 채택: 구독 연동=정식 OAuth 선례·3계층 병존·llms.txt 문서 서빙 선례·온보딩 비게이트화. §7 미확인 항목은 후속 검증 전 설계 근거로 쓰지 않는다. 모계획: 2026-08-22-aside-onboarding-three-axis-plan.md

# aside.com 제품 벤치마크 — 온보딩 / 구독연동 / Migrate UX

- 작성: 2026-08-22, RA-1 (웹 리서치 서브에이전트)
- 목적: oort 온보딩 설계용 벤치마크. aside(Aside Computer Inc., YC F25)의 **온보딩 스텝·모델 구독 연동·브라우저 Migrate UX·UI/UX 평가·회사 배경**을 공개 표면만으로 조사.
- 방법: 공식 사이트(aside.com), **공식 헬프센터 원문(docs.aside.com/*.md)**, 공식 changelog, YC 프로필, 서드파티 리뷰(eesel.ai 3건, bitsandbucks.de, tabbit, agentlocker).
- 경계 준수: private API 리버스 엔지니어링·스크래핑 없음. 앱을 직접 설치·실행하지 않았으므로 **실제 화면 스크린샷 단위 검증은 미수행** — 아래 "화면 흐름"은 공식 문서 텍스트 기반 재구성이다.

> **가장 중요한 발견**: aside는 `docs.aside.com/llms.txt` 라는 **LLM용 문서 인덱스**를 공개하고, 모든 헬프 문서를 `.md` 원문으로 서빙한다. 에이전트가 자기 제품 문서를 읽게 하는 설계. oort도 동일 패턴을 검토할 가치가 있다.
> 출처: https://docs.aside.com/llms.txt

---

## 0. 한 줄 요약

aside는 **"BYO-subscription(가진 구독 그대로 꽂기)"을 무료 플랜의 1급 기능으로 내세운 macOS 전용 Chromium 기반 AI 브라우저**다. 온보딩은 5스텝(설치 → 계정 → 브라우저 임포트 → 패스워드 매니저 → 첫 태스크)이며, 최근 changelog에서 **계정 없이 로컬 프로필로 먼저 쓰게 하고 로그인은 나중에** 허용하도록 완화됐다.

---

## 1. 온보딩 프로세스 스텝 분해

### 1-1. 공식 문서가 명시한 정본 5스텝
출처: https://docs.aside.com/help/get-started.md (원문 인용)

> "Aside runs tasks in the browser. It can use websites, accounts, browsing history, files, and saved credentials according to your settings."

설치 요구사항:
> "Download Aside from aside.com/download. Aside supports **macOS 15.0 or later**."
- aside가 곧 브라우저 자체이므로 "최소 브라우저 버전" 요구사항이 없다고 문서가 명시.

셋업 순서(정본):
1. **Open Aside** (앱 실행)
2. **Sign in or create an account**
3. **Import browser data**
4. **Set up Password Manager**
5. **Start a task**

### 1-2. 다운로드 → 설치 화면
출처: https://aside.com/download
다운로드 페이지는 3스텝만 안내한다(자동 다운로드 + 수동 폴백 링크 병기):
1. "Open Aside.dmg from your Downloads folder"
2. "Drag the Aside icon into your Applications folder"
3. "Open the Aside app from your Applications folder"
- 폴백 카피: "Did not work? Download Aside manually"
- **미확인**: 페이지에 시스템 요구사항/버전/용량 표기 없음. (요구사항은 docs에만, 용량은 서드파티가 "~2GB"라고 언급 — 아래 4장)

### 1-3. 첫 태스크(스텝 5) 흐름
출처: https://docs.aside.com/help/get-started.md
- 진입점이 **두 개**다: **task page**(멀티사이트 작업용) vs **side panel**(현재 페이지 컨텍스트 단일 작업용). 문서가 이 둘의 용도를 명시적으로 구분한다.
- 태스크 작성 = "원하는 결과를 서술" + (필요 시) 사이트/계정/파일/작업 폴더 지정 + 권한 모드 선택 → 제출.

### 1-4. ★ 온보딩 강제성 완화 (oort에 가장 참고할 만한 변화)
출처: https://docs.aside.com/changelog/native.md — **v1.0.813.1 / .811.1 / .728.1 …** (버전번호가 날짜형: `1.0.<MMDD>.<n>`, 2026-05~08 구간)

- **v1.0.728.1**: "Introduced **local profiles without onboarding requirement**. *'You can sign in later from the New Tab Page.'*"
  → 즉 초기에는 계정 가입이 온보딩 게이트였는데, **가입 없이 로컬 프로필로 즉시 브라우저를 쓰게 하고 로그인 CTA를 New Tab Page로 미루는** 방향으로 바꿨다. 온보딩 이탈률 대응으로 읽힌다.
- **v1.0.619.1**: "Added **bookmarks-only** and **Safari import** support" → 임포트 선택 粒度를 낮춰 마이그레이션 부담을 줄임.
- **v1.0.531.1**: "Enabled **Windows import from Chrome, Edge, Arc, and Comet**" → 임포트 소스 브라우저 목록의 유일한 명시적 근거. (단 문구상 'Windows'가 플랫폼을 뜻하는지 창(window) UI를 뜻하는지 **모호 — 미확인**. 제품은 리뷰상 macOS 전용이므로 해석 유보.)
- **v1.0.626.1**: "Improved **bookmark import folder structure preservation**" → 임포트 품질(폴더 계층 보존)을 별도로 손봄.
- **v1.0.706.1**: "Patched *'Google OAuth2 sign-in getting logged out too often.'*" → 구글 로그인 세션 유지가 실제 초기 결함이었음.

---

## 2. "구독 연동" 방식 상세 ★ (핵심 항목)

출처(정본): https://docs.aside.com/help/ai.md — "Configure AI providers"

### 2-1. 3계층 프로바이더 모델
`Settings > Models` 에서 **세 종류**의 프로바이더를 병존시킨다. UI가 각 모델에 배지를 붙인다(플랜명 / `Subscription` / `API`).

| 계층 | 공식 카피 | 과금 주체 |
|---|---|---|
| **Aside** | "Use models included with your Aside plan." | aside 크레딧 |
| **Subscription** | "Reuse a supported AI subscription you already pay for." | 해당 구독사(추가비 0) |
| **API** | "Bring your own provider API key." | 해당 API 계정(토큰 과금) |

### 2-2. 기술적으로 무엇인가 → **OAuth** (핵심 답)
경로: `Settings > Models > Providers` → Subscription 항목의 `Connect`

지원 구독:
- `ChatGPT Subscription` (**Plus 또는 Pro**)
- `Claude Subscription` (**Pro 또는 Max**)
- `GitHub Copilot`

공식 문구 인용:
> "**Aside opens an OAuth sign-in flow for these providers.**"

- 즉 **로그인 세션 재사용(쿠키 하이재킹)도 아니고 API 키도 아닌, 정식 OAuth 인가 플로우**다.
- 추가로: "**Usage metrics display for supported subscriptions**" — 연결된 구독의 잔여/사용량을 aside UI 안에서 보여준다. (oort가 '구독 연동'을 한다면 사용량 가시화가 세트라는 신호)

### 2-3. BYOK(API 키) 경로
경로 동일(`Connect` → API 프로바이더 선택). 지원 목록:
> **Anthropic, OpenAI, OpenRouter, Google, xAI, Vercel AI Gateway, Cloudflare AI Gateway**
- 키는 프로바이더 액션 메뉴에서 편집/연결해제 가능.
- **OpenRouter와 게이트웨이 2종(Vercel/Cloudflare)을 1급으로 지원**한다는 점 주목 — oort의 "구독 연동 vs OpenRouter" 논의에 직접적인 선례. aside는 **둘 중 택일이 아니라 전부 병존**시킨다.

### 2-4. 모델 선택 지점
- 기본 모델: `Settings > Models > Task models`
- 후속 대화 동작: `Settings > Agents > Chat`

### 2-5. 3개 과금 경로가 어떻게 병존하나
출처: https://docs.aside.com/help/subscription.md + https://www.eesel.ai/blog/aside-ai-browser-pricing

- **크레딧은 "Aside 플랜 모델"을 쓸 때만 소모**된다. 사용량은 날짜/태스크/모델 단위로 기록되고 **다운로드 가능한 히스토리**로 제공된다.
- 공식 문구: > "**If you bring your own API key, your provider may bill usage to that provider account.**" → BYOK는 aside 크레딧과 무관, 프로바이더가 직접 청구.
- 연결한 ChatGPT/Claude 구독으로 돌리면 **모델 측 한계비용은 사실상 0** (eesel 표현: "your marginal cost for adding the browser is, on the model side, effectively zero").
- **Local vs Cloud 실행 토글**이 별도로 존재: 로컬 실행은 내 기기 자원(크레딧 무소모), 클라우드 실행은 aside 서버 → **크레딧 차감**. Pro 이상에 "cloud handoff" 기능이 붙는다.
- 크레딧 갱신: 유료는 구독 기념일, 무료는 UTC 월 경계 리셋. 결제는 Stripe(월/연).
- 추론 등급이 비용 레버: **Low → Medium → High → Ultrabrowse** 순으로 토큰 소모 증가.

> 정리하면 aside의 과금 설계는 **"모델 비용은 사용자가 이미 내는 곳에 떠넘기고(무료 플랜의 셀링 포인트), aside는 자체 클라우드 실행·Ultrabrowse·루틴 같은 오케스트레이션 레이어에만 과금한다"**. oort가 참고할 핵심 구조.

---

## 3. "구글/Chrome에서 Migrate" UX

출처(정본, 원문 인용): https://docs.aside.com/help/get-started.md

> "Browser import brings over the context you already use while browsing."

### 3-1. 무엇을 가져오나
- **browsing history (방문 기록)**
- **cookies (쿠키)** ← ★ 가장 중요. 쿠키를 가져와야 "이미 로그인된 상태"가 승계되고, 에이전트가 로그인된 사이트에서 바로 일할 수 있다. aside 제품 전체가 이 위에 서 있다.
- **bookmarks (북마크)**
- **비밀번호는 이 목록에 없다** — 별도 스텝(패스워드 매니저 설정)으로 분리돼 있음. (Chrome 비밀번호 직접 임포트 지원 여부는 **미확인**; troubleshooting에는 1Password·Apple Passwords 연동 이슈만 언급)

### 3-2. 화면 흐름 (원문 5스텝)
> 1. Open import during onboarding.
> 2. Choose a profile. — "If Aside finds multiple profiles, choose the profile you want to import."
> 3. Allow system access.
> 4. Wait for import to finish.
> 5. Continue to password setup.

해설:
- **(2) 프로필 선택**: 크롬 다중 프로필(직장/개인)을 자동 감지해 고르게 한다. 다중 프로필 사용자에게 필수적인 배려.
- **(3) 시스템 접근 허용**: macOS 권한 프롬프트(다른 앱 데이터 읽기). **온보딩 중 OS 권한 다이얼로그를 통과시켜야 하는 마찰 지점** — 여기가 이탈 구간이다.
- **(4) 진행 대기 화면**이 명시적으로 하나의 스텝으로 존재 → 임포트가 비동기·장시간일 수 있음을 UX가 인정.
- **(5) 임포트 완료가 패스워드 셋업으로 자연 연결** → 스텝 간 끊김 없이 이어붙임.

### 3-3. Safari 예외 경로
> "Safari uses file import. In Safari, choose `File > Export`, then upload the ZIP file Safari creates."
- Safari는 샌드박스 때문에 직접 읽기 불가 → **사용자가 수동 Export한 ZIP 업로드**. aside는 **ZIP 포맷만** 받는다.
- 즉 **"자동 임포트 경로 + 수동 파일 임포트 폴백"** 2트랙 설계.

### 3-4. 임포트 소스 브라우저
- 명시적 근거는 changelog 한 줄뿐: "**Chrome, Edge, Arc, Comet**" (v1.0.531.1) + "**Safari**" (v1.0.619.1).
- Chromium 계열 전반 + Safari로 보이나 **공식 헬프에 소스 브라우저 전체 목록은 없음 — 미확인**.
- troubleshooting이 인정한 실패 모드: "import unavailable", "import failed", "ZIP file issues" / 대처는 "소스 브라우저 프로필이 실제로 존재하는지 확인", "**소스 브라우저를 닫아라**", "필요하면 파일 임포트를 써라".
  출처: https://docs.aside.com/help/troubleshooting.md

### 3-5. 임포트 粒度
- **"bookmarks-only" 모드**가 별도 존재(v1.0.619.1) → 전부 가져오기가 부담스러운 사용자용 저마찰 옵션.
- 북마크 **폴더 구조 보존**을 별도 개선 항목으로 다룸(v1.0.626.1).

---

## 4. UI/UX 완성도 — 평가와 비판

### 4-1. 칭찬받는 구체 패턴
1. **투명한 메모리 (가장 일관되게 칭찬받는 지점)**
   - 브라우징 히스토리를 **평문 마크다운 파일**로 로컬 저장. 사람/사이트/날짜별 에피소딕 노트로 조직. **사용자가 직접 열어 읽고 고칠 수 있다.**
   - 태스크 후 "**Dreaming**"이라는 과정이 관련 컨텍스트를 추출.
   - eesel 평: 경쟁 제품은 "memory is an opaque blob, so when it remembers something wrong, you find out only when it acts on it" — aside는 그 반대.
   - 출처: https://www.eesel.ai/blog/aside-ai-browser , https://www.eesel.ai/blog/aside-ai-browser-review
2. **태스크 단위 난이도/자율성 다이얼**: `Low / Medium / High / Ultrabrowse` — 작업마다 에이전트 자율성과 비용을 사용자가 조절.
3. **에이전트용 패스워드 매니저** (제품의 시그니처)
   - 자격증명을 **페이지에 autofill 하되 모델에는 노출하지 않음**. 하드웨어 백드(Secure Enclave) E2E 암호화, per-task 스코프, 감사 로그.
   - 공식 정책 UI: `Settings > Passwords > Access policy for AI agents` = `Always allow` / `While unlocked` / `Never` (기본값은 잠금 해제 중에만 허용).
   - 출처: https://docs.aside.com/help/password-manager.md , https://aside.com/
4. **명시적 권한 3계층 + 세션 오버라이드** (oort 승인 UX에 직접 참고)
   - 규칙 값: `Allow` / `Ask` / `Deny` (Deny 우선)
   - 세션 모드: **Read only** / **Guard**(승인된 폴더 안에서만 작업, 그 밖은 물어봄 — **기본값**) / **Full access**
   - 카테고리: Sandbox(OS 격리) / File permissions / Tool permissions
   - 출처: https://docs.aside.com/help/security.md
5. **Steer / Queue 이원화**: 실행 중인 에이전트에 **즉시 개입(Steer)** vs **현재 런 끝나고 반영(Queue)**. 진행 중 태스크 교정 UX의 좋은 프리미티브.
   출처: https://docs.aside.com/help/troubleshooting.md
6. **브라우저 기본기에 진짜 투자**: vertical sidebar, Split View, Pinned Tabs(클라우드 동기화), Tab Switcher(Ctrl+Tab), 프로필 전환(Ctrl+1~9, 트랙패드 스와이프), Liquid Glass/투명도. changelog 상당 비중이 AI가 아니라 **평범한 브라우저 UX 완성도**에 쓰인다. → "AI 브라우저"라도 브라우저로서 못 쓰면 안 된다는 판단.
7. 체감 품질: "The agent feels fast and looks clean" (tabbit)

### 4-2. 비판점
- **초기 안정성**: 크래시, **잦은 로그아웃(sign-outs)**, **기기 간 동기화 없음(no device sync)**. changelog도 시작/프로필전환/종료 크래시 수정에 릴리스 하나를 통째로 씀(v1.0.720.1). (tabbit, eesel)
- **설치 용량 ~2GB** + **macOS 15+ / Windows 미지원** → 진입 장벽. (tabbit, bitsandbucks)
- **기능을 끌 수 없다는 불만** ("cannot shut it off"). (tabbit)
- **가격 비공개였던 기간의 신뢰 문제**: eesel — "로그인을 맡기라는 제품이 가격을 안 밝히는 건 진짜 공백" (이후 해소, 5장 참조).
- **벤치마크 자기신고**: Online-Mind2Web 297/300 = 99.0% 등 #1 주장은 **aside 자체 GitHub 레포에서 aside 자체 채점 설정으로** 나온 수치. eesel: "read the number, then read who graded it". 제3자 재현 전까지 유보 권고.
- **자율성 경계의 모호함**: "민감 행동은 승인 대기"는 마케팅 카피인데 프라이버시 정책 본문에는 명문화돼 있지 않다(eesel 지적). 단 헬프 문서의 `Ask` 규칙/세션 모드로는 실체가 확인됨.
- **적합 대상 한계**: 고객대면/규제 워크플로엔 부적합(승인 없이 끝까지 달리는 모델이라 책임 소재가 안 잡힘). 개인 생산성 용도로 한정 권고.
- **3인(공식 5인) 팀 → 엔터프라이즈 지원 인프라 부재**. (bitsandbucks)

---

## 5. 회사·제품 배경

출처: https://www.ycombinator.com/companies/aside , https://aside.com/pricing , eesel

- **법인**: Aside Computer Inc. / **YC 배치: Fall 2025 (F25)** / **설립 2024** / **샌프란시스코, CA** / **팀 규모 5명** (YC 프로필 기준. eesel·bitsandbucks는 "3인"으로 기술 — 창업자 3인 + 이후 증원으로 보임)
- **창업자 3인 (전원 한국계)**:
  - **Jun Kim (김효준)** — Co-founder & CEO. 17세부터 **Airbridge.io 창립 멤버**($30M ARR). ("crafted products from OS, DB to K-POP since my age 9")
  - **Chanhee Lee** — Co-founder. Airbridge.io Founding Engineer, $30M ARR까지 스케일. 15세에 MS 후원 비영리 설립.
  - **Sanghun Lee** — Co-founder. 14세에 코딩 시작, 100만+ 다운로드 앱 제작.
- **포지셔닝**: "The browser built to do real work for you" / "an AI browser that completes real work across the websites you already use."
  - **통합(integration) 없이 로그인된 웹을 사람처럼 직접 조작**하는 것이 차별점. Perplexity Comet, Arc Dia, OpenAI Atlas와 대비해 "페이지에 대해 말만 하는 게 아니라 일을 끝내는 브라우저"로 포지셔닝.
  - 기술 스택: **Chromium 기반 네이티브 macOS 앱** (changelog에 Chromium 151.0.7922.109 등 업스트림 추적 기록).
  - 자매 제품 **Aside for Sales**(B2B 세일즈 콜 실시간 어시스트)도 운영.

### 5-1. 가격 정책 (aside.com/pricing 확인 — 현재는 공개됨)
| 플랜 | 가격 | 내용 |
|---|---|---|
| **Free** | $0 / forever | **"Bring your own subscription"**, 500 credits/월, 루틴 최대 3개, 내장 패스워드 매니저, 개인화 메모리 |
| **Pro** | **$20/월** (연간 20% 할인) | Free 전부 + **3× 사용량**, **Ultrabrowse**(리서치), 무제한 루틴, **Channels (Remote control)**, **cloud handoff** |
| **Max** | **$200/월** (연간 20% 할인) | Pro 전부 + **40× 사용량**, early access 프로그램 |
| **Enterprise** | 영업 문의 | 시트 관리, 공유 프로필, vault 접근 제어, **agent authentication**, 전담 지원 |

- ★ **무료 플랜의 첫 번째 불릿이 "Bring your own subscription"** — 즉 "네가 이미 내는 ChatGPT/Claude 구독을 꽂으면 브라우저는 공짜"가 획득 전략의 핵심.
- 문서의 Max 표기는 "30×"(docs/subscription.md), 가격 페이지는 "40×" — **불일치 있음**. 가격 페이지를 우선.
- agentlocker는 "$17~$200"로 표기 — 연간 결제 환산치($20의 20% 할인 ≈ $16)로 추정.

### 5-2. 개발자 표면 (oort에 유의미)
출처: https://docs.aside.com/help/developers.md
- **CLI**: `curl -fsSL https://releases.aside.com/install.sh | bash`
  - `aside "Open localhost:3000 and run a smoke test"` / `aside --session <id> "Continue"`
  - 멀티 계정: `aside account list|status|use`, `aside --account u1 "task"`
- **MCP 서버**: `aside mcp` — `mcp.json`에 `{"mcpServers":{"aside":{"command":"aside","args":["mcp"]}}}` 로 등록. "Aside can install browser automation setup for supported coding tools."
- **REPL**: `aside repl "const p = await openTab('https://example.com')"` — 결정적(deterministic) 브라우저 조작·스크린샷·다운로드용.
→ **제품을 다른 에이전트가 호출 가능한 도구로 노출**한다. oort가 "에이전트를 1급 멤버로" 지향한다면 동형 표면(외부 에이전트가 oort를 호출/oort가 외부를 호출)을 검토.

---

## 6. oort 온보딩에 가져올 시사점 (RA-1 의견)

1. **"구독 연동"의 정답은 OAuth다.** aside는 ChatGPT/Claude/Copilot을 정식 OAuth로 붙이고, 세션 재사용 같은 회색지대를 안 쓴다. oort도 회색지대를 피하는 편이 약관·신뢰 양쪽에서 유리.
2. **택일하지 말고 3계층 병존**: `우리 플랜 모델 / 연결한 구독 / BYOK(OpenRouter·게이트웨이 포함)`. UI에서 배지로 출처를 항상 보이게 한다.
3. **크레딧은 우리가 실제로 제공하는 것에만 매긴다.** aside는 모델비를 사용자 기존 구독에 떠넘기고 **클라우드 실행·자율 모드·루틴**에만 과금한다. oort도 "무엇에 과금하는가"를 이 선으로 그으면 무료 플랜이 강력해진다.
4. **연결된 구독의 사용량을 제품 안에서 보여줘라** — aside가 그렇게 한다. 연동만 하고 잔량을 안 보여주면 사용자가 불안해한다.
5. **마이그레이션은 "자동 경로 + 수동 파일 폴백" 2트랙**, **다중 프로필 선택**, **명시적 진행 대기 화면**, **끝나면 다음 스텝으로 자동 연결**. 그리고 **"북마크만" 같은 저부담 옵션**을 반드시 둔다.
6. **온보딩을 게이트로 두지 마라.** aside는 v1.0.728.1에서 계정 없이 먼저 쓰게 하고 로그인 CTA를 New Tab Page로 미뤘다. oort도 "가입 전 체험" 경로를 남길 것.
7. **권한 UX 프리미티브를 훔칠 것**: `Allow/Ask/Deny` × 세션모드 `Read only/Guard/Full access` (기본 Guard), 그리고 실행 중 개입의 **Steer vs Queue** 이원화.
8. **문서를 `.md` 원문 + `llms.txt` 인덱스로 공개**하는 것은 agent-native 제품의 저비용·고효과 시그널이다.

---

## 7. 미확인 / 후속 검증 필요

- 실제 온보딩 **화면 스크린샷 단위 순서**(앱 미설치 — 문서 텍스트 기반 재구성만 수행).
- **임포트 소스 브라우저 공식 전체 목록** (changelog 한 줄 외 근거 없음). "Windows import from Chrome, Edge, Arc, and Comet"의 'Windows' 해석도 모호.
- **Chrome 저장 비밀번호의 직접 임포트 지원 여부**.
- OAuth 연결 시 **어떤 스코프를 요구하는지**, ChatGPT/Claude 약관상 서드파티 클라이언트 사용이 허용 범위인지 (aside 문서는 언급 없음). → oort가 같은 길을 갈 경우 **별도 약관 리서치 필수**.
- docs "Max = 30× credits" vs pricing "40×" 불일치.
- 팀 규모 3인(리뷰) vs 5인(YC) 불일치.
- HN Launch 스레드 원문 — 검색으로 도달하지 못함(**미확인**).

---

## 8. 출처 목록

**공식**
- https://aside.com/
- https://aside.com/download
- https://aside.com/pricing
- https://docs.aside.com/llms.txt (문서 인덱스)
- https://docs.aside.com/index.md
- https://docs.aside.com/help/get-started.md
- https://docs.aside.com/help/ai.md  ← 구독 연동 정본
- https://docs.aside.com/help/subscription.md
- https://docs.aside.com/help/security.md
- https://docs.aside.com/help/password-manager.md
- https://docs.aside.com/help/troubleshooting.md
- https://docs.aside.com/help/developers.md
- https://docs.aside.com/changelog/native.md
- https://www.ycombinator.com/companies/aside

**서드파티 리뷰**
- https://www.eesel.ai/blog/aside-ai-browser (explained)
- https://www.eesel.ai/blog/aside-ai-browser-review (review)
- https://www.eesel.ai/blog/aside-ai-browser-pricing (pricing)
- https://bitsandbucks.de/blog/en/aside-ai-browser.html
- https://go.tabbit.ai/aside-browser-review (경쟁사 매체 — 편향 감안)
- https://go.tabbit.ai/aside-ai-browser
- https://agentlocker.ai/agent/aside
- https://www.linkedin.com/posts/therne_today-were-launching-aside-yc-f25-activity-7475267050425282560-W9Qz (런칭 포스트)
- https://jun.kim/ , https://x.com/hyojun_at (창업자)
