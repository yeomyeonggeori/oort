> [Fable 검수 2026-08-22] RA-4 서브에이전트 산출을 검수 승격 — R-1(그록봇 VM 영속성) 관문의 문서면 종결. 핵심 확정: ①Grok Bot=xAI+Anysphere(Cursor) 합병 첫 공동 제품, 계약 주체=Anysphere·적용 약관=Cursor ToS(App Store 리스팅 근거) ②durable-but-resettable **공식 확증**(컴퓨트=ephemeral·durable storage=별개 유지·/workspace만 durable·수동 설치물=replaceable) ③중대 약관 리스크 다수(§5.2 B1~B9) — 특히 Beta §1.6 무보증·xAI '개인 비상업 용도만'·자동화 접근 금지(우리 CDP)·경쟁 서비스 금지·계정 개방 금지. 설계 함의는 모계획 §8에 반영. 실측면(마커 잔존)은 다음 세션 재확인으로 별도 종결. 모계획: 2026-08-22-grokbot-one-click-selfhost-plan.md

# RA4 — Grok Bot 에이전트 컴퓨터: 영속성 의미론 & 약관 리서치 노트

- 조사일: 2026-08-22
- 조사자: RA4 (웹 리서치 서브에이전트)
- 조사 방법: 공식 문서(docs.x.ai, cursor.com/help), 공식 약관 원문(브라우저 직독 — x.ai/cursor.com은 Cloudflare 때문에 WebFetch/curl 403, 사용자 Chrome으로 직접 읽음), 공식 발표문, Cursor 커뮤니티 포럼(스태프 답변 포함), 2·3차 보도
- 표기 규칙: **[공식]** = 벤더 문서/약관 원문 · **[스태프]** = Cursor 포럼 직원 답변 · **[2차]** = 언론/블로그 · **[미확인]** = 근거 못 찾음

---

## 0. 한 줄 결론

**"durable-but-resettable"는 공식 문서로 뒷받침되는 판정이다.** 공식 문서가 "durable state"라는 용어를 직접 쓰고, 무엇이 durable이고 무엇이 replaceable인지 명시한다. 다만 **(a) 우리가 상주 서비스를 돌리려는 대상(수동 설치 패키지·프로세스)은 명시적으로 "replaceable" 쪽에 분류**되어 있고, **(b) Grok Bot은 Anysphere ToS §1.6 "Beta Services" — "not for production use… without any warranty, support, maintenance, or storage of any kind"**에 해당한다. 즉 파일은 살아남게 설계돼 있지만 **"우리가 깔아둔 데몬이 계속 돌고 있을 것"에 대한 어떤 보증도 존재하지 않는다.**

---

## 1. 제품 소속·계보 확정

### 1.1 결론
**xAI(SpaceXAI)와 Anysphere(Cursor)의 합병 후 첫 공동 제품이며, 실행 인프라·계약 주체는 Anysphere/Cursor 쪽이다.** 우리가 실측한 번들 id `com.anysphere.sand`와 `cursorenvironments/*` 이미지는 이 계보와 정확히 일치한다.

### 1.2 근거

**[공식] xAI 발표문** — https://x.ai/news/introducing-grok-bot (Aug 11, 2026)
> "Grok Bot is your team of always-on agents. They have their own computer, work inside tools and apps like you do, and keep working 24/7."
> "Grok Bot is in beta and available today for SuperGrok Plus and Heavy, **Cursor Pro+ and Ultra, and Cursor Teams Standard and Premium** subscribers on desktop and iOS."
> "We built Grok Bot as an internal prototype, and it took off across the company."

→ 발표는 x.ai 도메인/SpaceXAI 명의지만, **과금 등급이 Cursor 구독 등급과 직결**된다.

**[공식] App Store 리스팅** — https://apps.apple.com/us/app/grok-bot/id6794501026
- Seller/Developer: **"Anysphere Incorporated"**
- Copyright: **"© 2026 Anysphere Inc."**
- Privacy Policy: `https://cursor.com/privacy`
- Terms of Service: **`https://cursor.com/terms-of-service`**
- 버전 이력: 1.0 (Aug 11) → 1.3.1 (조사 시점 기준 최근)

→ **앱의 계약 주체는 Anysphere이고 적용 약관은 Cursor ToS다.** 이게 4장(약관) 판단의 출발점.

**[공식] docs.x.ai/grok-bot/teams-and-enterprises**
> "They sign in with their **Cursor account**, so your existing Cursor SSO and team membership apply."
> "You manage admin settings for Grok Bot from the **Cursor dashboard**."
> "**Review Cloud Agents.** This team-wide toggle controls whether Grok Bot Bots can launch **Cursor cloud agents**."

**[공식] docs.x.ai/grok-bot/approvals-security-and-privacy**
> "Backend retention and account deletion follow the applicable **Cursor terms**."

**[2차] 코드네임 "Sand"** — https://roo.beehiiv.com/p/grok-bot-cursor-infrastructure , https://www.digitalapplied.com/blog/grok-bot-cursor-tier-gating-spacex-anysphere-deal-2026
- Cursor 사내에서 코드네임 **"Sand"**로 개발되던 범용 에이전트 제품이 "Grok Bot"으로 리브랜딩됐다는 보도.
- 설치 파일은 `downloads.cursor.com`, 세일즈 폼은 `cursor.com/contact-sales`.
- SpaceX의 Anysphere 인수는 2026-06-16 합의 → **2026-08-14~15 클로징**, Grok Bot 발표는 2026-08-11.

→ **번들 id `com.anysphere.sand` = Anysphere의 "Sand" 프로젝트.** 우리 실측과 정확히 일치. 컨테이너 이미지 `cursorenvironments/universal:sand-box-*` 역시 Cursor의 클라우드 에이전트 환경 이미지 네임스페이스(cursorenvironments) + Sand 프로젝트 조합으로 자연스럽게 설명된다.
- **[미확인]**: `cursorenvironments/universal:sand-box-*` 이미지 태그를 명시적으로 언급하는 **공식/공개 문서는 찾지 못했다.** 이미지명 자체는 우리 실측이 유일 근거. (검색: `"cursorenvironments/universal"` → 관련 결과 0)

### 1.3 실무적 함의
- 문서면은 `docs.x.ai/grok-bot/*`(SpaceXAI 브랜딩) + `cursor.com/help/grok-bot/*`(Cursor 헬프센터) **두 곳에 분산**되어 있다. 둘 다 봐야 한다.
- **약관은 Cursor(Anysphere) 것이 1차, xAI ToS/AUP가 2차**로 걸린다고 읽는 게 안전하다(앱스토어 링크가 Cursor를 가리키고, docs가 retention을 "Cursor terms"로 넘김).

---

## 2. VM/컴퓨터 영속성 — 공식 문서 (핵심)

### 2.1 durable 계약 원문 — `docs.x.ai/grok-bot/computer-and-apps` (Last updated: Aug 11, 2026)

**아키텍처:**
> "Grok Bot works from a **persistent cloud computer**. It can use a browser, command line, files, and connected tools without depending on your laptop remaining open."
> "Every Bot on your account uses the same computer: Browser cookies and signed-in sessions are shared / Files are visible to every Bot / Command-line credentials are shared / One Bot can continue from work another Bot saved"
> "The computer is assigned to your **user account**, not an individual Bot."
> "Each Bot gets its own **screen** on the shared computer… The screens are separate work surfaces, **not separate security boundaries**."
> "Closing the Grok Bot app or your laptop does not stop cloud work."

**무엇이 durable인가 (제일 중요):**
> "The computer has a shared workspace at **`/workspace`**. Ask Bots to keep durable project files there and use clear project folders."
> "**Files, browser state, and supported sign-ins are designed to survive normal computer updates and recovery.** Treat **temporary directories, manually installed packages, and uncommitted application state as replaceable.** Copy important results into the shared workspace or attach them to the conversation."

> ⚠️ **셀프호스트 관점 핵심**: "manually installed packages" = replaceable. 우리가 `apt install`/`docker pull`/`npm i -g`로 깔아둔 것은 **공식적으로 보존 대상이 아니다.** `/workspace`의 *파일*만 durable이다.

**세 가지 유지보수 동작 (원문 그대로):**
> - "**Update Agent Computer** rebuilds with the latest image **while preserving durable state**."
> - "**Recover Agent Computer** replaces an unreachable computer **while preserving durable state** when that action is offered."
> - "**Reset Agent Computer** returns to the most recent **durable snapshot** and **can discard recent unsaved work**."

> "Wait for active work to finish before recovery when possible."

**로그인 지속:**
> "Browser sessions persist so you usually do not need to sign in for each task. Because the browser is shared, signing in for one Bot makes the session available to your other Bots."
> "Some websites expire sessions, enforce short timeouts, or request verification again."

**로컬 컴퓨터와의 분리:**
> "The Grok Bot cloud computer is **separate** from the Mac or Windows computer in front of you."

### 2.2 트러블슈팅 사다리 — `docs.x.ai/grok-bot/troubleshooting`
> "**Recover Agent Computer** and **Update Agent Computer** preserve durable files and logins."
> "**Reset Agent Computer** restores the last saved snapshot and can lose recent or unsynced work."
> "Use Reset Agent Computer only if recovery and update fail and **you accept losing recent unsynced work**."
> "Your Bot profiles and saved conversations are not necessarily lost when the computer is temporarily unreachable."

공식 순서: 재시도/대화 재열기 → 앱 재시작 → **Recover** → **Update** → **Reset**(최후).

### 2.3 팀/엔터프라이즈 문서가 밝히는 진짜 스토리지 모델 — `docs.x.ai/grok-bot/teams-and-enterprises` (Last updated: Aug 20, 2026)

**이 문서가 가장 명확하다. "durable storage"가 VM과 분리된 별도 자원임을 명시:**
> "Each member gets **one dedicated cloud computer. The computer is a managed Linux virtual machine.**"
> "The Bot runs as a **non-root user**."
> "Organization admins can inspect and remove member computers… **Kill deletes the running virtual machine. Durable storage is kept, and the member's next session creates a fresh computer.**"
> "Members can reset their own computer from the desktop app. **Reset recreates the computer and keeps its data.** The mobile apps cannot reset a computer."

> ✅ **이게 "durable-but-resettable"의 공식 근거다.** VM은 언제든 죽일 수 있는 일회용이고, durable storage는 그와 별개로 유지되어 새 VM에 재부착된다. **컴퓨트는 ephemeral, 스토리지는 durable.**

**네트워크(터널 판단에 직결):**
> "Computers reach the internet through **static egress IP addresses**. If your company restricts services by source IP, ask your account team for the current ranges."
> "Why do some websites block the Bot? Some services flag **datacenter IP addresses**. Allowlist the Grok Bot egress ranges on your own services, or have the member try the **beta setting that routes computer traffic through their own computer**."

> ⚠️ **인바운드에 대한 언급은 어디에도 없다.** 아웃바운드 인터넷 접근은 공식적으로 보장(정적 egress IP), **인바운드 포트 개방/공개 URL 부여는 문서화된 기능이 아니다.** → cloudflared 같은 아웃바운드 터널이 유일한 현실적 노출 경로라는 우리 가설은 문서면과 모순되지 않는다.

**세션 드롭 조건(중요):**
> "Sign-in sessions inside the computer can drop when the computer is **recreated** or **its network address changes**."

> ⚠️ **VM의 네트워크 주소가 바뀔 수 있다**고 공식 인정. 고정 IP/포트에 의존하는 어떤 설계도 불가. 터널 hostname 기반이어야 함.

**가용성/과금 게이팅:**
> "Individuals — Available with SuperGrok Plus, SuperGrok Heavy, Cursor Pro+, Cursor Ultra, **or a one-time trial**."
> "Self-serve teams — Standard and Premium seats include a **weekly Grok Bot usage allowance**."
> "There is **no Grok Bot-specific spend cap yet**."

### 2.4 자동 재활용/유휴 종료 주기 — **[미확인]**
- **공식 문서에 idle timeout / 자동 재활용 / hibernate / 자동 재시작 주기에 대한 서술이 없다.** 검색으로도 못 찾음.
- 문서는 "persistent" / "keep working 24/7"만 반복한다. 반대로 **"영원히 안 죽는다"는 보증도 없다.**
- 비교점 [2차]: Manus 등 경쟁 제품은 태스크 사이에 샌드박스를 sleep시키고 일정 유휴 후 재활용한다고 알려져 있으나, Grok Bot에 대해 동일한 정책이 있다는 근거는 없음.
- **후속 확인 필요(실측 항목)**: 유휴 N시간 후 `nohup` 프로세스 생존 여부, VM uptime 추이, `/workspace` 밖 파일의 Update 후 생존 여부.

### 2.5 커뮤니티 실증 — durable 계약의 실제 구멍

**(a) [스태프] 브라우저 확장은 Update에서 소실** — https://forum.cursor.com/t/grok-bot-chrome-extensions-disappear-after-a-computer-update/168385
- 사용자 보고: 업데이트 후 1Password 확장이 사라져 은행 로그인 불가.
- Cursor 스태프 Colin 답변:
> "Today, only the **primary browser profile (plus cookies/logins across screens) survives a computer update**; **extensions installed on an agent's screen do not.**"
> "It's on our radar."

→ **"designed to survive"는 의도 표명이지 SLA가 아니다.** 실제 durable 범위는 문서보다 좁다.

**(b) 구독/트라이얼 소진 시 워크스페이스 접근 불가** — https://forum.cursor.com/t/grok-bot-cloud-workspace-inaccessible-after-trial-exhaustion-ticket-t-e97475-pending/169010 (2026-08-20)
> "when the remaining trial usage reached zero, I lost the ability to interact with the Bot and **could not find any way to export or retrieve the existing workspace files**."
- 티켓 T-E97475, 조사 시점 기준 **미해결·스태프 공개 답변 없음**.

→ ⚠️ **치명적 리스크**: 데이터는 "durable"해도 **크레딧이 마르면 그 데이터에 접근할 통로가 사라진다.** 체험 호스트로 쓸 때 "체험자가 트라이얼을 다 쓰면 우리 데모가 통째로 잠긴다."

**(c) 리셋 후 로컬 브리지 404 / 멈춤** — https://forum.cursor.com/t/grok-bot-0-20-0-windows-local-bridge-404-and-stuck-working-after-reset/168762
- Reset 이후 로컬 브리지가 404, 작업이 "Working"에서 멈추는 버그 보고. 앱 버전 0.20.0.
- → 우리 실측 GrokBot/0.24.0과 같은 계열의 데스크탑 앱·로컬 브리지 구조 존재를 교차 확인.

**(d) [2차, 저신뢰] VM 사양** — https://kie.ai/blog/grok-bot-release (본문 직접 확인 실패, 403 — 검색 스니펫 경유)
- "@anysphere/exec-daemon-runtime Docker 이미지" 사용, 커뮤니티 테스트에서 **Debian 13 / 8 vCPU / 16GB RAM / 128GB 스토리지** 관측.
- → 우리 실측(Debian 13)과 일치. 단 **원문 미검증**, 2차 인용으로만 취급할 것.

**(e) [저신뢰] 서드파티 SDK** — https://github.com/adam91holt/grokbot-sdk
- "Grok Bot host"의 로컬 HTTP 게이트웨이(`http://your-host:1340`), 온디스크 `sand-data` 디렉터리(`/home/box/sand-data`, alias `/home/box/agent-data`).
- **공식 프로젝트가 아니며 Grok Bot과의 관계가 불명확**하다. "sand" 명명이 일치하는 점만 참고.

---

## 3. Cursor(Anysphere) 인프라 계열 — 준용 가능한 공식 설명

### 3.1 Cloud Agents (구 Background Agents) — https://cursor.com/docs/cloud-agent
> "Cursor manages VM **provisioning, isolation, snapshots, startup, artifacts, and capacity** for every Cloud Agent."
> "Snapshots save your base environment configuration (installed packages, system dependencies, etc.)"
> "Builds prepare each environment in the background so agents start with repositories and dependencies ready."
- 네트워크: 아웃바운드 도메인 제한 가능, "connect to private networks with Tailscale or a similar client."

**[미확인]**: Cloud Agent VM의 **수명·런 간 상태 지속 여부·인바운드 포트 노출**은 문서에 명시가 없다.

### 3.2 준용 판단
- 두 제품 모두 "**스냅샷으로 base 환경을 굳히고, VM은 언제든 새로 만든다**"는 동일 패턴이다. Grok Bot의 `Update`(최신 이미지로 rebuild) = Cloud Agent의 스냅샷 재적용과 같은 계열.
- **차이점**: Cloud Agent는 태스크 단위 VM(작업 끝나면 의미 없음), Grok Bot은 **계정당 1 VM 장기 상주 + 별도 durable storage**. 즉 Grok Bot 쪽이 훨씬 상주 서비스에 가깝다.
- 다만 **Cursor 쪽에도 "VM에서 상주 서비스를 돌려도 된다"는 문서상 허가는 없다.**

### 3.3 관련: Cursor 포럼의 "약관상 허용되나?" 판례 — https://forum.cursor.com/t/is-this-use-of-cursor-cloud-agents-permitted-under-cursor-s-terms/168633
- 질문: 자사 AI 제품(사용자 100만)의 백엔드 구성요소로 Cursor Cloud Agents를 공식 API/SDK로 프로그래매틱 호출하는 것이 AUP의 "automated or non-human means" 금지에 걸리는가?
- **Cursor 직원 Colin 답변: "It sounds like your use case is just fine."**
- 인용된 기존 가이드: 재판매 금지 조항(§1.5(iii))은 "**generally aimed at resale of the Cursor Service itself**"이며, "**Using the Cursor API or SDK in your own application is not automatically the same thing as selling the Service**". 헤드리스 CLI·TypeScript SDK는 "built for… automation".

> ✅ **우리에게 유리한 선례**: (1) 공식 자동화 인터페이스를 쓰는 프로그래매틱 호출은 AUP "자동화 접근" 금지에 걸리지 않는다는 게 벤더 입장, (2) 재판매 조항은 "서비스 자체의 재판매"를 겨냥한다.
> ⚠️ **단서**: 그 사례는 **공식 API/SDK 경유**다. **Grok Bot 데스크탑 앱을 CDP로 조종하는 우리 방식은 "공식 인터페이스"가 아니다** → 같은 안전지대에 있다고 볼 수 없음(4.4 참조).

---

## 4. 약관 — 상주 서비스·터널 노출이 허용되는가

### 4.1 결론 요약

| 항목 | 판정 | 근거 |
|---|---|---|
| VM에서 상주 서비스(자체 서버) 구동 | **명시적 금지 조항 없음** (= 회색지대, 허가도 없음) | xAI AUP / Cursor AUP / Cursor ToS 전문 확인 |
| cloudflared 등 터널로 외부 노출 | **명시적 금지 조항 없음**. 오히려 xAI가 터널을 공식 문서에서 안내 | docs.x.ai custom-mcp-tunneling |
| 베타 서비스로서의 보증 | **보증 전무 — "no storage of any kind", "not for production use"** | Cursor ToS §1.6 |
| 계정을 타인에게 개방 | **명시적 금지** | xAI ToS Registration |
| 경쟁 AI 서비스 개발에 사용 | **금지(광의 해석 시 위험)** | Cursor AUP / xAI AUP |
| 자동화·비인간 수단 접근 | **금지(우리 CDP 방식이 걸릴 수 있음)** | 양사 AUP 공통 |

### 4.2 상주 서비스·터널 — 금지 조항 부재 확인

**xAI AUP (Effective: August 14, 2026)** — https://x.ai/legal/acceptable-use-policy
전문 확인 결과, 서버 구동·호스팅·터널링·포트 노출·암호화폐 채굴·자원 과다사용에 관한 **전용 조항이 존재하지 않는다.** 가장 근접한 것들:
> "Detrimentally impacting the Service, including by: … **Introducing viruses or malware, spamming or DDoSing Services, or bypassing our systems or protective measures**"
> "Disrupting, interfering with, or unauthorized access to the Service or its safety systems, including **circumventing any rate limits or restrictions or protective measures** and safety mitigations"
> "**Providing services that encourage others to violate these Terms**, including by operating websites offering violative outputs from our Services in exchange for payment"

**Cursor AUP (Last updated: August 11, 2026)** — https://cursor.com/acceptable-use-policy
xAI AUP와 구조가 거의 동일. 추가로 Cursor에만 있는 조항(한국어판 원문):
> "**직접적 또는 자동화된 수단을 통해 Anysphere의 구독, 청구 또는 사용량 측정 시스템을 조작, 우회 또는 방해하는 행위**"
> "적용되는 요금의 납부를 회피하거나 줄이고, 무단 크레딧 또는 환불을 받거나, 그 밖에 적용되는 요금을 지불하지 않고 서비스를 받기 위해 **계정 프로비저닝, 팀 관리 또는 사용자 할당 워크플로우를 악용하는 행위**"

> ⚠️ **주의**: 한 계정의 durable storage 위에 여러 사람이 쓰는 데모 서비스를 올려두면 "**사용량 측정 우회 / 계정 프로비저닝 악용**"으로 해석될 여지가 생긴다. 1인 = 1 컴퓨터가 이 제품의 과금 단위이기 때문.

**Cursor ToS §1.5 Use Restrictions** — https://cursor.com/terms-of-service (Last updated: August 13, 2026)
> "(i) reverse engineer, disassemble, decompile, decode, or otherwise attempt to derive or gain access to the source code, object code or underlying structure of the Service; (ii) reproduce, modify, translate, or create derivative works of the Service; **(iii) rent, lease, lend, or sell the Service**; (iv) remove any proprietary notices…; **(v) use the Service or any Suggestions to develop or train a model that is competitive with the Service**, or engage in model extraction or theft attacks; (vi) probe, scan or attempt to penetrate the Service; … (viii) harvest, scrape, or extract data from the Service; … **(xi) knowingly permit any third party to do any of the foregoing.**"

→ **서버 구동·터널 금지 조항 없음.** 오히려 ToS 서두의 "Service" 정의가 흥미롭다:
> "all related software made available by Anysphere to build, deploy, **host**, and manage software projects"

→ **"host"가 서비스 정의에 포함**되어 있어, 호스팅 행위 자체가 제품 용도 밖이라고 보긴 어렵다. (단 이건 우리에게 유리한 해석이지 벤더의 공식 입장은 아님.)

### 4.3 ★ 가장 강한 제약: Beta Services 조항

**Cursor ToS §1.6 Beta Services** (원문 그대로):
> "From time to time, Anysphere may make Beta Services available to you. Beta Services shall be clearly designated as beta, pilot, limited release, non-production, early access, evaluation or a similar description. … **Beta Services are intended for evaluation purposes and not for production use, are not fully supported**, and may be subject to additional terms… Beta Services are provided on an 'as-is' and 'as available' basis **without any warranty, support, maintenance, or storage of any kind. Anysphere may discontinue Beta Services at any time in its sole discretion and may never make them generally available. ANYSPHERE SHALL HAVE NO LIABILITY WHATSOEVER ARISING OUT OF OR IN CONNECTION WITH BETA SERVICES - USE AT YOUR OWN RISK.**"

**Grok Bot은 발표문에 "EARLY BETA" 배지가 붙어 있고 docs도 beta로 명시**(Settings → **Beta** 메뉴에서 Update/Reset 수행) → **§1.6이 그대로 적용된다.**

> 🔴 **이것이 "durable-but-resettable" 판정의 법적 상한이다.** 기술적으로 durable storage가 있어도, 계약상으로는 **"storage of any kind"에 대한 보증이 명시적으로 배제**되어 있다. 제품 체험 호스트로 쓰는 것은 정의상 "production use"에 가깝고, 이는 §1.6이 배제한 용도다.

**xAI ToS(Consumer, Effective June 26, 2026)에도 동형 조항** — https://x.ai/legal/terms-of-service
> "**Beta Modes and Trial Features.** In some cases, we may permit you to evaluate our Service for a limited time or with limited functionality, including beta, preview, or trial features. **Use of our Service for evaluation purposes is for your personal, non-commercial use only.**"

> 🔴 **"personal, non-commercial use only"** — 베타 기능을 상업적 제품 데모 호스트로 쓰는 것을 직접 겨냥한다. 우리 용도와 정면으로 부딪힐 수 있는 문장.

### 4.4 ★ 두 번째 제약: 자동화·비인간 접근 금지 (우리 CDP 방식)

양사 AUP 공통:
- xAI AUP: > "**Accessing the Services through unauthorized automated or non-human means, whether through a bot, script, or otherwise**"
- Cursor AUP: > "**봇, 스크립트 또는 기타 수단을 통해 자동화되거나 사람이 아닌 방식으로 서비스에 접근하는 행위**" (주: Cursor 판에는 "unauthorized"라는 한정어가 없다 — 더 넓다)

> 🔴 **Grok Bot 데스크탑 앱을 CDP(Chrome DevTools Protocol)로 조종해 메시지를 주입/수거하는 방식은 이 조항의 사정권**이다. 3.3의 우호적 선례는 **"공식 API/SDK 사용"** 전제였고, 우리는 공식 인터페이스가 아니다.
> 완화 요인: Grok Bot에는 현재 공개 API가 없어 보인다(**[미확인]** — Grok Bot용 공개 API/SDK 존재 여부 확인 못 함). 대안 부재는 정상참작 사유가 아니다.

### 4.5 세 번째 제약: 경쟁 제품 개발 금지

- Cursor ToS §1.5(v): "use the Service or any Suggestions to **develop or train a model that is competitive with the Service**" — **모델**에 한정(좁음)
- Cursor AUP: "서비스 또는 제안을 사용하여 Anysphere 또는 모델 제공업체와 **경쟁하는 머신러닝 모델이나 관련 AI 서비스**를 개발하는 행위" — **"관련 AI 서비스"까지 확장(넓음)**
- xAI AUP: "Using the Service or any Output to develop (or assist anyone in developing) machine learning models or **any products or services that compete with SpaceXAI**, whether directly or indirectly" — **가장 넓음**

> ⚠️ AUP는 "충돌 시 AUP 우선"(Cursor AUP 서문: "본 AUP와 귀하의 계약 간에 충돌이 있는 경우, 허용되는 사용과 관련해서는 본 AUP가 우선")이므로 **넓은 쪽이 지배한다.**
> oort는 "에이전트를 1급 멤버로 올리는 메신저"다. Grok Bot이 "AI teammates"를 파는 제품인 이상, **"관련 AI 서비스"/"indirectly compete" 해석 하에 oort 개발에 Grok Bot 인프라를 쓰는 것이 문제될 여지가 있다.** 실무적으로 집행 가능성은 낮아 보이나, 제품 홍보에서 "Grok Bot 위에서 돌아가는 oort"를 전면에 내세우면 노출도가 급상승한다.

### 4.6 계정 개방 금지

**xAI ToS — Registration:**
> "You may not share your account credentials or **make your account available to anyone else**, and are responsible for all activities that occur under your account."

**Cursor AUP 서문:**
> "귀하의 계정으로 다른 사람이 서비스를 사용하도록 허용하는 경우, 귀하는 그들이 본 AUP를 알고 준수하도록 할 책임이 있습니다." (= 타인 사용을 전면 금지하진 않으나 **책임은 계정주에게** 귀속)

> → **성재 계정의 VM 위에 올린 oort 데모에 외부인이 접속**하는 구조라면: xAI ToS 문구는 위반 소지, Cursor AUP는 "계정주 책임" 프레임. **체험자 본인의 Grok Bot 계정/VM에서 돌리는 구조라면 이 리스크는 사라진다.**

### 4.7 터널링에 대한 xAI의 공식 태도 (우리에게 유리)

**[공식] docs.x.ai/grok/connectors/custom-mcp-tunneling** — https://docs.x.ai/grok/connectors/custom-mcp-tunneling
- Grok에 커스텀 MCP 커넥터를 붙이려면 서버가 **공개 인터넷에서 도달 가능**해야 하고, localhost/사설망 URL은 거부된다.
- 공식 문서가 **cloudflared로 터널을 뚫는 절차를 직접 안내**:
> `cloudflared tunnel --url http://localhost:3001` → 생성된 `*.trycloudflare.com` URL을 서버 URL로 사용
- 주의: "Cloudflare quick tunnels do not support Server-Sent Events (SSE)" → SSE 트랜스포트면 ngrok 사용 권장. Streamable HTTP는 정상.
- "**Tunnels are temporary. Most free-tier tunnel URLs change each time you restart the tunnel.**"

> ✅ **벤더가 자기 문서에서 cloudflared 사용을 가르친다** = 터널링 자체는 약관상 위반 행위로 취급되지 않는다는 강한 정황.
> ⚠️ 단, 이 문서의 시나리오는 "**당신의 로컬 머신** → Grok 서버가 도달"이지, "**에이전트 컴퓨터에서 밖으로 서비스 노출**"이 아니다. 정확히 같은 상황은 아니다.
> ⚠️ quick tunnel URL은 재시작마다 바뀐다 → 데모 링크 고정하려면 named tunnel + 자체 도메인 필요.

### 4.8 데이터 보존·삭제

- **[공식] docs.x.ai/grok-bot/approvals-security-and-privacy**: "Backend retention and account deletion follow the applicable **Cursor terms**."
- **Cursor ToS §9 Termination**: "We also may terminate your account **if it has been inactive for over a year** and you do not have a paid account… Upon termination… **we may at our option delete any Content or other data associated with your account.**"
- **Cursor ToS §10 Modification of the Service**: "Anysphere may modify or discontinue all or any portion of the Service at any time… **You should retain copies of any Content as needed so that you have access in the event the Service is modified and you lose access to such Content.**"
- **Cursor ToS §1.3 Model Training**: "ANYSPHERE WILL NOT USE CONTENT TO TRAIN… ANY AI MODELS, UNLESS YOU'VE EXPLICITLY AGREED" (우리에게 유리)
- **[대조] xAI ToS**: Input에 대해 "irrevocable, perpetual, transferable, sublicensable, royalty-free, and worldwide right"를 xAI에 부여. 로그인 시 학습 사용 여부 선택 가능, 삭제 요청은 최대 30일.
  → **두 약관의 데이터 처리 조건이 크게 다르다.** Grok Bot에 어느 쪽이 적용되는지가 실질 문제. docs는 "Cursor terms"를 가리키지만 **[미확인]** — 명시적 통합 문서 없음.

---

## 5. 결론

### 5.1 "durable-but-resettable" 판정 — **공식 근거 있음 (조건부)**

| 층위 | 판정 | 근거 강도 |
|---|---|---|
| `/workspace` 파일 | durable — Update/Recover에서 보존 설계 | **강** ([공식] computer-and-apps, troubleshooting) |
| 브라우저 프로필·쿠키·로그인 | durable — 단 **확장 프로그램은 제외** | **강** ([공식] + [스태프] 명시적 예외 확인) |
| durable storage ↔ VM 분리 | 분리됨. VM Kill해도 스토리지 유지, 새 VM에 재부착 | **강** ([공식] teams-and-enterprises) |
| 수동 설치 패키지·프로세스 | **replaceable — 보존 대상 아님** | **강** ([공식] 명문) |
| Reset | 최근 durable 스냅샷으로 롤백, 미저장분 소실 | **강** ([공식]) |
| 자동 재활용·유휴 종료 주기 | **문서 없음** | **[미확인]** |
| 상주 프로세스 생존 보장 | **보장 없음. 계약상 명시적 배제(ToS §1.6)** | **강(부정 방향)** |

**정리 문장:** "Grok Bot 에이전트 컴퓨터는 *데이터*에 대해 durable-but-resettable이다. *실행 상태*에 대해서는 durable이라는 근거가 없고, 계약상으로는 반대(무보증)가 명문화되어 있다."

### 5.2 셀프호스트 체험 호스트로 쓸 때의 리스크 목록

**A. 기술 리스크**
1. **A1 (높음)** — 수동 설치 패키지·데몬은 공식적으로 replaceable. `Update Agent Computer`(사용자가 언제든 누를 수 있고, 벤더가 유도하기도 함) 시 우리 스택이 통째로 증발 가능. 확장 프로그램 소실 사례가 실증.
2. **A2 (높음)** — VM의 **네트워크 주소가 변경될 수 있음**([공식] 명문). 고정 IP/포트 의존 설계 불가. 터널은 outbound-initiated + hostname 기반이어야.
3. **A3 (중)** — `Reset`은 스냅샷 롤백이라 **DB 상태가 과거로 되돌아갈 수 있음**. Postgres를 VM에 두면 SoT가 시간여행하는 사고 가능. 스냅샷 시점 정책 **[미확인]**.
4. **A4 (중)** — 유휴 재활용/종료 주기 미문서화 → 상주 프로세스 생존 시간을 예측 불가. 실측 필요.
5. **A5 (중)** — 계정당 컴퓨터 1대 공유, Bot 스크린은 "not separate security boundaries". 멀티테넌트 데모 불가.
6. **A6 (중)** — quick tunnel URL은 재시작마다 변경. 고정 데모 링크는 named tunnel + 도메인 필요. SSE는 Cloudflare quick tunnel 미지원(oort가 Centrifugo/SSE·WS 계열이면 직격).
7. **A7 (낮음~중)** — Bot이 non-root로 실행. Docker 데몬(:2375) 접근은 우리 실측으로 확인됐으나 **공식 문서에 Docker 언급 없음** → 언제든 사라질 수 있는 미문서 기능.
8. **A8 (중)** — datacenter IP라서 외부 서비스가 차단하는 사례 존재([공식] FAQ 인정).

**B. 계약·정책 리스크**
9. **B1 (높음)** — **Cursor ToS §1.6**: 베타는 "not for production use", "**without any warranty, support, maintenance, or storage of any kind**", 언제든 중단 가능, **책임 전무**. 제품 체험 호스트 = production use.
10. **B2 (높음)** — **xAI ToS Beta Modes**: "for your **personal, non-commercial use only**". 상업 제품 데모와 정면 충돌 소지.
11. **B3 (높음)** — **자동화·비인간 접근 금지**(양사 AUP). 우리의 CDP 조종 방식이 사정권. 우호적 선례는 "공식 API/SDK" 전제였음.
12. **B4 (중)** — **경쟁 서비스 개발 금지**. xAI AUP "any products or services that compete with SpaceXAI, whether directly or indirectly" + Cursor AUP "관련 AI 서비스". oort의 포지션상 해석 여지 존재. 홍보 문구가 리스크를 키움.
13. **B5 (중)** — **계정 개방 금지**(xAI ToS "make your account available to anyone else"). 성재 계정 VM에 외부 체험자를 태우는 구조는 위험. **체험자 본인 계정에서 돌리는 구조로 설계하면 해소.**
14. **B6 (중)** — **사용량 측정/계정 프로비저닝 악용 금지**(Cursor AUP). 1계정 1컴퓨터가 과금 단위인데 다수가 그 위 서비스를 쓰면 해석 리스크.
15. **B7 (높음, 실증)** — **크레딧 소진 시 워크스페이스 접근 차단**. 포럼 미해결 티켓 존재. 데모 중 체험자 트라이얼이 마르면 데모 전체가 잠김. **Grok Bot 스펜드 캡 기능 없음**([공식]).
16. **B8 (중)** — 계정 정지/해지 시 "we may at our option **delete any Content**". 백업 없는 데모 데이터는 소멸 가능.
17. **B9 (낮음)** — 데이터 처리 조건이 Cursor ToS(학습 불가 기본)와 xAI ToS(광범위 라이선스)로 크게 다른데 **어느 쪽이 지배하는지 통합 명시가 없음**. 기업 고객 대상 설명 시 답을 못 함.

### 5.3 설계 권고 (리서치에서 도출된 것만)
- **체험자 본인 계정 + 본인 VM에서 실행**되는 구조로 설계 → B5/B6 해소, B1/B2도 "개인 평가 용도"에 가까워짐.
- **모든 durable 상태는 `/workspace` 아래**에. 설치물은 재실행 가능한 **부트스트랩 스크립트**로 `/workspace`에 두고, Update 후 재실행 전제로 설계(= 설치물 자체를 durable로 가정하지 않기).
- **Postgres 데이터 디렉터리를 `/workspace`에** 두되, Reset 롤백 가능성을 문서화하고 **외부(사용자 로컬 or 우리 백업)로 덤프**하는 경로를 마련.
- **터널은 named tunnel + 우리 도메인**으로. quick tunnel URL 변동 리스크 회피. **SSE/WS 트랜스포트 호환성 사전 검증 필수**(R-2 스파이크 항목).
- 홍보에서 "Grok Bot 인프라 위에서 동작"을 전면화하지 않기 (B4 노출 최소화).

---

## 6. 미확인 항목 (정직하게)
1. `cursorenvironments/universal:sand-box-*` 이미지 태그를 언급한 **공식/공개 문서 없음** — 우리 실측이 유일 근거.
2. **Docker 데몬(:2375)에 대한 공식 문서 언급 전무** — 미문서 기능으로 취급해야.
3. **유휴 타임아웃·자동 재활용 주기** 공식 서술 없음. 실측 필요.
4. **durable 스냅샷 생성 주기·보존 기간** 공식 서술 없음 (Reset이 "most recent durable snapshot"으로 간다고만).
5. **인바운드 포트/공개 URL 부여 기능** — 존재한다는 근거도, 금지한다는 근거도 없음.
6. **Grok Bot 전용 공개 API/SDK 존재 여부** 확인 못 함(있다면 B3 리스크가 크게 낮아짐).
7. **Cursor ToS vs xAI ToS 중 Grok Bot 지배 약관** — 앱스토어·docs 정황은 Cursor 우세, 명시적 통합 조항은 못 찾음.
8. kie.ai의 VM 사양 기사(Debian 13 / 8 vCPU / 16GB / 128GB) **원문 접근 실패(403)** — 검색 스니펫 경유 2차 인용.
9. `Reset`의 의미가 문서 간 불일치: computer-and-apps는 "can discard recent unsaved work", teams-and-enterprises는 "Reset recreates the computer and **keeps its data**". 어느 쪽이 정확한지 미확정.

---

## 7. 출처
- [Introducing Grok Bot | SpaceXAI (2026-08-11)](https://x.ai/news/introducing-grok-bot)
- [Grok Bot | SpaceXAI Docs — Overview](https://docs.x.ai/grok-bot/overview)
- [Use the computer and apps | SpaceXAI Docs](https://docs.x.ai/grok-bot/computer-and-apps)
- [Troubleshooting | SpaceXAI Docs](https://docs.x.ai/grok-bot/troubleshooting)
- [Grok Bot for teams and enterprises | SpaceXAI Docs](https://docs.x.ai/grok-bot/teams-and-enterprises)
- [Approvals, security, and privacy | SpaceXAI Docs](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
- [Skills, routines, and automations | SpaceXAI Docs](https://docs.x.ai/grok-bot/skills-routines-and-automations)
- [Custom MCP Server Tunneling | SpaceXAI Docs](https://docs.x.ai/grok/connectors/custom-mcp-tunneling)
- [SpaceXAI Acceptable Use Policy (2026-08-14)](https://x.ai/legal/acceptable-use-policy)
- [xAI Terms of Service – Consumer (2026-06-26)](https://x.ai/legal/terms-of-service)
- [Cursor Terms of Service (2026-08-13)](https://cursor.com/terms-of-service)
- [Cursor Acceptable Use Policy (2026-08-11)](https://cursor.com/acceptable-use-policy)
- [Cloud Agents | Cursor Docs](https://cursor.com/docs/cloud-agent)
- [Getting started with Grok Bot | Cursor Docs](https://cursor.com/help/grok-bot/getting-started)
- [Grok Bot App — App Store (Anysphere Incorporated)](https://apps.apple.com/us/app/grok-bot/id6794501026)
- [Cursor Forum — Chrome extensions disappear after a computer update](https://forum.cursor.com/t/grok-bot-chrome-extensions-disappear-after-a-computer-update/168385)
- [Cursor Forum — Cloud workspace inaccessible after trial exhaustion (T-E97475)](https://forum.cursor.com/t/grok-bot-cloud-workspace-inaccessible-after-trial-exhaustion-ticket-t-e97475-pending/169010)
- [Cursor Forum — Is this use of Cursor Cloud Agents permitted under Cursor's terms?](https://forum.cursor.com/t/is-this-use-of-cursor-cloud-agents-permitted-under-cursor-s-terms/168633)
- [Cursor Forum — Grok Bot 0.20.0 Windows: local bridge 404 and stuck Working after Reset](https://forum.cursor.com/t/grok-bot-0-20-0-windows-local-bridge-404-and-stuck-working-after-reset/168762)
- [Cursor Forum — Introducing Grok Bot (Announcements)](https://forum.cursor.com/t/introducing-grok-bot/168053)
- [roo — Grok Bot Runs on Cursor's Infrastructure, Not SpaceXAI's](https://roo.beehiiv.com/p/grok-bot-cursor-infrastructure)
- [digitalapplied — Grok Bot Ships Through Cursor Tiers, Not xAI Plans](https://www.digitalapplied.com/blog/grok-bot-cursor-tier-gating-spacex-anysphere-deal-2026)
- [kie.ai — What Is Grok Bot? (2차, 원문 403)](https://kie.ai/blog/grok-bot-release)
- [github.com/adam91holt/grokbot-sdk (서드파티, 저신뢰)](https://github.com/adam91holt/grokbot-sdk)
