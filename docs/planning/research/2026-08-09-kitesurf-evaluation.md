# kitesurf 유용성 체크 — 후보 특정 + 비판 평가

- 작성: 리서치 워커 (2026-08-09), momo(oort) 문맥
- 발제: 성재 2026-08-09 — *"kitesurf라는 오픈소스 있던데, 우리 메신저에 탑재해보는 것도 고려. 유용성을 체크만 한번 해줘"*
- 범위: **체크만.** ADR 기안·티켓화 하지 않음.
- 방법: 후보 나열 → 특정 → GitHub API + 원문 파일(LICENSE 201줄·README 558줄·SECURITY.md·이슈 본문) 직접 판독. 벤더 블로그 주장은 1차 출처로만 인용하고 3자 실측기와 교차검증.
- 선례 형식: `docs/planning/research/2026-08-08-oss-sandbox-memory-evaluation.md` 축을 그대로 따름.
- 스냅샷: 2026-08-09

---

## 0. 판정 요약

| 후보 | 정체 | 라이선스(실측) | self-host | 유지보수 실태 | **판정** |
|---|---|---|---|---|---|
| **① Cloudflare Kitesurf** ★성재가 본 것 | 에이전트 전용 브라우저 (Workers/V8 isolate) | **없음 — 오픈소스 아님** | **불가** (Cloudflare 전용) | 3일 됨(2026-08-06 발표), 무료 베타 | **현시점 평가 불가 → 배제.** 오픈소스화 시 재평가 |
| **② Obscura** (Kitesurf의 조상) | Rust 헤드리스 브라우저 엔진 | **Apache-2.0 (원문 201줄 확인, 부가 제약 0건)** | **가능** (단일 바이너리) | 활발하나 버스팩터 81%·**미해결 메모리안전 이슈 다발** | **배제** (현시점) — 빈자리는 있으나 **더 싼 채움이 이미 결정돼 있고**, 앞에 T-a 병목이 있음 |
| **③ kiteswang/kitesurf** | 에이전트간 P2P 통신 프로토콜(KITP) | MIT | 가능 | **★2 · 커밋 4 · 5개월 방치** | **배제** (동명이인 토이) |

**한 줄**: 성재가 본 "오픈소스 kitesurf"는 **아직 오픈소스가 아니다** — Cloudflare가 2026-08-06에 발표하며 *"준비되면 오픈소스화하겠다"*고 말한 단계이고, 메신저에 "탑재"하는 부품이 아니라 **Cloudflare Workers에서만 도는 원격 서비스**다. 실제로 오픈소스인 것은 조상 격인 **Obscura**(Apache-2.0, Rust)인데 — 라이선스·스택은 통과하지만, **에이전트 웹 접근이라는 빈자리의 채움은 ADR-0150이 이미 "provider 내장 검색"으로 정해뒀고**(codex 경로는 코드 0줄), 자체 호스팅 경로는 조사 문서 §8에서 *"명백히 비싸다 · 권고하지 않는다"*로 이미 기각됐다. 게다가 **오늘은 무엇을 들여와도 에이전트에게 쥐어줄 수 없다** — 툴 카탈로그가 2개로 잠겨 있고 `agent.tool_schema` 쓰기 표면(T-a)이 없다. **순서가 틀린 평가**다.

---

## 1. 후보 특정 — "어느 kitesurf인가"

이름만으로 특정하지 않기 위해 GitHub 저장소 검색·npm·crates.io를 전수 조회했다.

### 1.1 GitHub `kitesurf` in:name 전수 (스타 내림차순)

```
kite247/iKitesurf-ConnectIQ-Garmin-App   ★3   MIT      Garmin 워치 풍속 앱
kiteswang/kitesurf                        ★2   Python   에이전트 통신(KITP)
mschettewi/Kitesurfer-Detection           ★2   Jupyter
… 이하 전부 ★1 (카이트서핑 강습 관리·게임·날씨 앱 등 실제 카이트서핑 취미 프로젝트)
```

**GitHub에는 "탑재를 고려할 만한" kitesurf가 존재하지 않는다.** npm에 `kitesurf@0.0.1`(2020-12-13, description = "Coming soon.") 빈 껍데기 1건, crates.io에는 0건.

### 1.2 특정 결론 — **Cloudflare Kitesurf** (신뢰도 높음)

근거:

1. **타이밍이 정확히 맞는다.** Cloudflare가 2026-08-06 발표 → TechCrunch(08-07)·MarkTechPost(08-06)·다수 매체가 08-06~08-08에 대서특필 → 성재 발제 08-09. 발제 시점 기준 사흘 전 뉴스다.
2. **"오픈소스"라는 표현의 출처가 기사에 있다.** 예: *"Cloudflare says it plans to open source Kitesurf once it is ready"* — 헤드라인만 스치면 "오픈소스 kitesurf"로 기억된다. 이 오인이 이번 발제의 핵심이다.
3. **"우리 메신저에 탑재" 문맥과 맞는다.** 에이전트 네이티브 메신저 + 에이전트 전용 브라우저 = 자연스러운 연상.
4. **경쟁 후보가 전부 무의미하다.** ②는 이름이 다르고(Obscura), ③은 ★2다.

**잔여 불확실**: ③ `kiteswang/kitesurf`는 이름이 정확히 일치하고 "에이전트간 통신"이라 주제상 우리와 더 가깝다. 가능성은 낮게 보지만 §4에서 별도 평가했다. **③이었다면 판정은 더 단호한 배제**이므로, 어느 쪽이어도 결론은 바뀌지 않는다.

---

## 2. ① Cloudflare Kitesurf — **오픈소스가 아니다** (1급 사실)

### 2.1 오픈소스 여부 — 실측

| 확인 | 결과 |
|---|---|
| `repos/cloudflare/kitesurf` | **404 Not Found** |
| `search/repositories?q=kite+user:cloudflare` | **0건** |
| 공식 문서(`developers.cloudflare.com/browser-run/kitesurf/`) | 오픈소스·self-host **언급 없음** |
| 공식 changelog(2026-08-06) | 오픈소스·self-host **언급 없음** |

Cloudflare 블로그 원문의 유일한 언급:
> *"we're going to open source Kitesurf once we're ready — hopefully soon."*

즉 **현재는 소스 비공개 SaaS 베타**다. 라이선스가 없으므로 permissive 심사 자체가 성립하지 않는다.

**공정을 위해**: Cloudflare는 `workerd`(Apache-2.0, ★8.5k, 2026-08-09 push)를 실제로 오픈소스로 운영해온 이력이 있다. "오픈소스화하겠다"는 말의 신빙성은 낮지 않다. 다만 **시점·라이선스·범위가 전부 미정**이고, 우리가 오늘 결정에 넣을 수 있는 재료는 없다.

### 2.2 실체와 형태 — "탑재"할 수 있는 물건이 아니다 ★가장 중요

Kitesurf는 라이브러리도 바이너리도 아니다. **Cloudflare 계정으로 호출하는 원격 브라우저 서비스**다. 문서상 접근 경로 3가지 전부가 Cloudflare API다:

```
POST https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/browser-run/screenshot?browser=kitesurf
wss://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/browser-run/devtools/browser?browser=kitesurf
MCP 클라이언트(chrome-devtools-mcp) 설정 경유
```

아키텍처가 Cloudflare 플랫폼 원시요소에 직결돼 있다 — Workers V8 isolate, **Dynamic Workers**(PageScript), SandboxOutbound. 이는 선례 문서의 **vibesdk 판정(§3.1: Durable Objects·Workers for Platforms 전면 종속 → self-host 불가)과 동형**이다. 오픈소스화되더라도 블로그가 밝힌 목표는 *"고객이 **자기 Cloudflare 계정에** 자체 인스턴스를 배포"* — 즉 **오픈소스화 후에도 Cloudflare 종속은 남는다.**

우리 배포 형태는 NCP 단일 VM 셀프호스트 + 셀프호스트 배포판이다. 정합하지 않는다.

### 2.3 성숙도 — 3일 된 베타, 공백이 명시돼 있다

Cloudflare 스스로 문서에 적은 미지원:
> *"If you need to play video, render WebGL, negotiate a bot-challenge handshake with real TLS fingerprints, or **start a ten-minute authenticated session that requires persistent state** — Kitesurf isn't yet the right option."*

- **stateless 전용 — 인증 세션 유지 불가.** 에이전트가 로그인 상태로 뭔가를 하는 시나리오는 처음부터 배제된다.
- CDP는 **부분 구현**("a subset of the CDP protocol"). 지원 메서드 표는 문서에 없다.
- 성능은 CPU/메모리 3~7배 절감이지만 **벽시계 시간은 Chromium보다 1.7~1.8배 느리다**(스크린샷 1,148ms vs 637ms). 절감되는 것은 *Cloudflare의* 서버 비용이지 사용자 체감 지연이 아니다.
- 12주 된 엔진. 가격은 "베타 무료" — **정식 과금 모델 미정**이라 비용 예측 불가.

### 2.4 판정 — **배제 (현시점 평가 불가)**

라이선스 부재 → 심사 불가. self-host 불가 → 우리 배포 형태와 불일치. 발표 3일차 → 실측 불가. **재평가 조건: 실제 오픈소스화 + permissive 라이선스 + Cloudflare 밖 실행 경로 확보.** 셋 다 참이 되기 전에는 볼 것이 없다.

---

## 3. ② Obscura — 실제로 오픈소스인 조상

Cloudflare 블로그가 밝힌 출발점:
> Kitesurf는 *"Obscura, a headless engine written in Rust for AI automation that has 'no Chrome, no Node.js, no dependencies'"* 를 Workers로 포팅하려는 시도에서 시작했다.

성재가 "오픈소스"를 원한 것이라면 **실제 대상은 이쪽**이므로 정면 평가한다. 레포: `https://github.com/h4ckf0r0day/obscura`

### 3.1 라이선스 — **Apache-2.0, 깨끗함** (원문 실측)

- `LICENSE` 원문 201줄 = 순수 Apache-2.0 전문.
- `grep -niE "commercial|additional term|restrict|non-compete|network use|territor|prohibit"` → 매칭 2건, **둘 다 Apache-2.0 표준 문구**(§4 "without any additional terms or conditions", §8 "other commercial damages"). **자체 부가 제약 0건.**
- README: *"The open-source engine stays Apache-2.0, fully featured. No feature gating, ever."*

**→ permissive 통과. AGPL 백본 금지 원칙에 걸리지 않는다. 라이선스는 이 레포의 탈락 사유가 아니다.**

### 3.2 스택 정합 — 우리와 잘 맞는 편

- 언어 실측: **Rust 5,180,030 bytes** (Python 201k, HTML 79k, Shell 4.5k, Dockerfile 2.3k). 우리 `server-rust`와 정합.
- 크레이트 9개: `obscura-browser` `obscura-cdp` `obscura-cli` `obscura-dom` `obscura-js` `obscura-mcp` `obscura-net` `obscura-render` `obscura`. **`obscura-mcp` = MCP 서버 내장** — 에이전트 툴로 물리기 쉬운 형태.
- 단일 정적 바이너리 + Docker(distroless/cc, ~57MB) + 소스 빌드. **self-host 가능** — CubeSandbox가 요구했던 전용 호스트·커널 교체 같은 인프라 청구서가 **없다**. 이 축에서는 CubeSandbox보다 훨씬 가볍다.
- vendor: `cosmic-text`, `taffy` — 둘 다 permissive.

### 3.3 활동성 — 활발하지만 버스팩터가 나쁘다

| 지표 | 값 |
|---|---|
| 생성 / 최종 push | 2026-04-13 / **2026-08-08** |
| Stars / Forks / Watchers | 20,781 / 1,492 / **69** |
| 커밋(main) | **814** |
| **merged PR** | **249** (open 15, closed-unmerged 43) |
| Issue | closed **246** / open **24** |
| Release | v0.1.3(05-13) → … → **v0.2.0(2026-08-08)** — 2~3주 간격 규칙적 |
| 기여자 상위 | **SGavrl 626** / mnaza 41 / h4ckf0r0day 30 / 나머지 ≤20 |

**긍정**: 커뮤니티 PR이 실제로 머지된다(249건). 이슈도 246건이 닫혔다. 선례 문서의 TencentDB-Agent-Memory(머지 47 vs 적체 459)와는 질적으로 다르다. **"시제품 방치" 함정에는 해당하지 않는다.**

**부정 — 버스팩터 1**: `SGavrl` 626커밋 / 상위12 합계 768 = **약 81%**. 선례의 vibesdk(86%)와 같은 등급이다. 게다가 **레포 소유자 `h4ckf0r0day`의 커밋은 30건뿐** — 간판과 실제 개발자가 다르다.

**약한 신호(과장하지 않고 기록)**: watcher/star = 0.3%. 비교군은 CubeSandbox 0.5%, vibesdk 0.6%, Playwright 0.6%, Puppeteer 1.2%. 낮은 편이나 **결정적이지 않다**. 다만 홍보 채널(Trendshift 배지, X/Threads/Instagram 릴스, "A Rust dev just killed Headless Chrome" 류 바이럴 포스팅)이 스타 수를 끌어올린 정황은 뚜렷하다 — **★20.8k를 성숙도의 증거로 읽으면 안 된다.**

### 3.4 상업 퍼널 — 실측으로 확인됨 ★함정 적중

README 실측:

- **Obscura Cloud**(호스팅판) 준비 중 — *"managed infrastructure, **residential proxies**, and dedicated support"*, 대기자 명단(tally.so) + "Book a demo"(cal.com).
- **스폰서 5곳이 전부 주거용 프록시 업체**: SX.org, NodeMaven, ProxyEmpire, 9Proxy, Thordata. README에 UTM 추적 붙은 제휴 링크가 박혀 있다(`?ref=obscura&utm_source=obscuragithub` 등).

즉 이 프로젝트는 **스크래핑/안티디텍션 산업이 자금을 대는 도구**다. "무료 엔진 → 관리형 클라우드 + 프록시 판매"가 수익 모델이다. 선례 문서의 Tencent(TCVDB 유도)·Cloudflare(플랫폼 판매) 함정과 같은 계열이며, 다만 **README에 대놓고 적혀 있어 기만은 아니다.**

우리에게 직접적 해악은 아니다(Apache-2.0 엔진에 기능 게이팅이 없음). 그러나 **개발 우선순위가 "스크래핑 은닉"에 정렬돼 있다**는 뜻이고, 이는 다음 항의 위험과 직결된다.

### 3.5 위험 — **여기가 진짜 탈락 사유** ★

#### (R1) 미해결 메모리안전·주입 이슈가 무더기로 열려 있다

v0.2.0 릴리스(2026-08-08) **당일** 열린 이슈 목록 — **전부 코멘트 0건, 미응답**:

```
2026-08-08  fix(obscura): Element holds an unsound raw *const Page (UAF + aliasing)
2026-08-08  fix(obscura): Element::attribute() interpolates the name into JS without escaping
2026-08-08  fix(cdp): DOM.setFileInputFiles reads arbitrary files without --allow-file-access gate
2026-08-08  fix(cdp): Runtime.removeBinding does not validate binding name → JS injection
2026-08-08  fix(js): op_fetch_url buffers unbounded response body → OOM DoS
2026-08-08  fix(js): crypto.subtle PBKDF2 accepts unbounded iterations/length → runtime DoS
2026-08-08  0.2.0: iframe contentWindow exposes almost no globals (Object/Function/Error/Promise/XHR…)
2026-08-08  Crash when fetching wilson.com URL in v0.2.0
```

이슈 #584 본문 원문(`crates/obscura/src/page.rs`):
```rust
pub struct Element {
    node_id: u64,
    page: *const Page,          // no lifetime tie to the Page
}
// every Element method:
let page = unsafe { &mut *(self.page as *mut Page) };
```
> *"**Use-after-free / dangling pointer.** … Nothing stops the `Page` from being moved or dropped while an `Element` still points at it; the next method call then dereferences freed/moved memory."*

**Rust를 쓰면서 UAF를 만들어낸 코드**다. 미해결 24건 중 15건이 최근 6일 내 신규이고, 오래된 것도 2026-07-12/07-25 건이 아직 열려 있다.

#### (R2) 이 물건의 본질은 "적대적 코드 실행기"다

`SECURITY.md` 원문 첫 문장:
> *"Obscura runs **real, untrusted JavaScript from arbitrary web pages** through V8"*

프로젝트 스스로 인정하는 위협 유형에 *"SSRF, hang or crash / denial of service, memory safety, **cross-session data exposure**"* 가 포함된다.

우리 문맥으로 옮기면: **채팅에 붙은 임의 URL의 JS를, PG(=SoT)가 도는 것과 같은 신뢰경계 안에서 실행하는 것**이 된다. 선례 문서 §1.5에서 CubeSandbox를 프로덕션 박스에 올리는 것을 *"SoT를 태우는 도박"*으로 기각한 것과 **정확히 같은 논리**가 여기 적용되며, 여기서는 위협원이 우리 사용자가 아니라 **인터넷의 아무 웹페이지**라서 더 나쁘다.

#### (R3) "drop-in replacement" 주장 ↔ 3자 실측의 괴리

일본 NITI Technology가 자사 사이트 2곳으로 직접 실측(2026-04~05 빌드):

| 대상 | requests+BS4 | Obscura | Jina Reader |
|---|---|---|---|
| WordPress(Elementor+CF) | 1,795자 / 0.14s | **22자 (title만)** | ~10KB / 3.71s |
| SvelteKit SPA | 0자 (JS 필요) | **부트스트랩 완전 실패** | 본문 성공 |

SvelteKit 실패 원인: `new URL(".", location)` 호출에서 **`TypeError: base.match is not a function`** — Obscura의 URL 생성자 구현 결함. 추가로 **스텔스 모드가 자사 도메인의 Cloudflare 봇 차단에 걸렸다.** 결론 원문: *"still too early to use it for production workloads."*

공정한 정정: 이는 v0.1.x 시절 측정이고 v0.2.0(08-08)이 네이티브 렌더링을 새로 넣었다. 그러나 **바로 그 v0.2.0에 위 R1 이슈들이 붙었다.** 개선 속도는 빠르나 안정화되지 않았다.

#### (R4) 스텔스 = ToS 회피 기능

`--stealth`는 안티디텍션(BoringSSL TLS 지문 위장, 트래커 차단, 지문 스푸핑)이다. README가 대놓고 `Anti-detect: Built-in`을 Chrome 대비 우위로 내세운다. **제품에 봇 탐지 회피 기능을 탑재하는 것은 법무·평판 판단이 필요한 사안**이고, 기술 판단만으로 들일 수 없다.

### 3.6 판정 — **배제 (현시점)**

라이선스(Apache-2.0)와 스택(Rust)은 통과했고, self-host 비용도 CubeSandbox보다 훨씬 가볍다. **탈락 사유는 라이선스가 아니라 ①안정성(R1·R3) ②스텔스의 법무 리스크(R4) ③아래 §5의 순서 문제와 신뢰경계**다. §5에서 이어진다.

---

## 4. ③ kiteswang/kitesurf — 동명이인 토이

| 지표 | 값 |
|---|---|
| Stars / 커밋 | **★2 / 커밋 4** |
| 언어 / 라이선스 | Python 3.9+ / MIT |
| 최종 push | **2026-03-30** (5개월 방치) |
| Issue / PR | 0 / 0 |

내용: KITP v1 자체 프로토콜로 노드간 AI 에이전트 자동 발견·페어링·P2P 통신(Rendezvous 서버, STUN/UDP 홀펀칭, HMAC-SHA256 + AES-256-GCM). README 태그라인: *"If you can't make it useful, make it playful."* — 저자 스스로 습작임을 밝힌다.

**판정: 배제.** 주제는 우리와 가깝지만(에이전트간 통신) 커밋 4개짜리 개인 습작이다. 게다가 우리는 **Centrifugo=전송전용 + 단일 쓰기경로(REST→PG→outbox→relay)**가 이미 정본이고, P2P 자동 페어링은 그 정본과 정면충돌한다(제2의 인입 경로). 읽을 가치도 없다.

---

## 5. 우리에게 이미 있는 것과의 중복도 — **핵심 절**

성재의 질문은 "유용한가"이고, 유용성은 **빈자리가 있어야** 성립한다. 레포 실측 결과 이 절의 답이 처음 예상과 달라졌으므로, 그대로 기록한다.

### 5.0 빈자리는 **있다** — 그리고 성재가 이 질문 당일에 직접 열었다 ★

레포 실측: momo에는 **브라우저·헤드리스 엔진·URL fetch·스크래퍼·언펄링이 전부 없다.** 웹을 향한 에이전트 능력은 **코드 0줄**이다.

그런데 바로 그 자리가 **이번 주에 공식으로 열렸다**:

- `docs/adr/0150-conversation-egress-boundary.md` — **Status: Accepted, 성재 승인 2026-08-09**(= kitesurf 발제와 **같은 날**). 기안 동기 원문: *"성재 — '웹검색은 안 되는 거 같아. 툴이 필요하면 쥐어줘.'"*
  - D1 기본 off / D2 **승인 대상 아님**(*"검색은 읽기 전용·비가역성 없음·턴 내 완결"*) / D3 검색 감사 / D4 도메인 필터는 v1
- `docs/planning/2026-08-04-SRV-B3b-websearch-research.md` — 헤더 원문 *"상태: 조사 완료 · **구현 0**"*

**즉 이번 발제는 고립된 호기심이 아니라 ADR-0150의 연장선일 가능성이 높다.** "에이전트가 웹을 못 본다"는 문제의식이 먼저 있었고, 그 해법 후보로 kitesurf가 눈에 들어온 것으로 읽는 게 자연스럽다. 그러면 진짜 질문은 *"kitesurf가 좋은 물건인가"*가 아니라 **"에이전트 웹 접근의 빈자리를 무엇으로 채우는가, 그리고 브라우저 엔진이 그 답인가"**가 된다.

### 5.1 그 빈자리의 **이미 정해진 채움**은 브라우저가 아니다

| 경로 | 상류 웹검색 지원 | 근거 |
|---|---|---|
| **codex / Responses**(ADR-0147) | **있음 — 모델 8종 전부 `supports_search_tool: true`** | `2026-08-04-SRV-B3b-websearch-research.md` §2.1 |
| **prime**(ADR-0158) | **있음** — 번들 `websearch` 스킬 | `2026-08-06-prime-agent-spike.md:150` |
| **hermes**(제품 기본값) | **없음 — 구조적으로 불가** | `/v1/chat/completions`의 `tools`는 `{"type":"function"}`만 받는다 |

그리고 codex 경로는 **어댑터 수정조차 필요 없다**. 조사 문서 원문:
> *"`tools`는 `agent.tool_schema` 배열 **그대로** body에 실린다"* … *"`[{"type":"web_search"}]`는 **오늘 그대로 나간다**. 어댑터 수정 불요"*

**결정적으로, 자체 호스팅 검색 경로는 이미 한 번 검토되고 기각됐다.** 조사 문서 §8 원문:
> **대안(참고) … 서버사이드 검색 프록시 툴**(`web.search`를 oort가 직접 실행, Brave/Bing/Tavily 등): 새 외부 자격증명 도입(**ADR-0004 재검토 필요**) · 새 실행자와 인자 검증 · 종량 요금 · 결과 요약/토큰 예산 파이프라인 · 인용 처리 · rate limit·타임아웃·실패 시맨틱. **내장 툴이 되는 한 이 경로는 명백히 비싸다. 권고하지 않는다.**

헤드리스 브라우저 자체 호스팅은 **이 기각된 경로보다 더 비싼 버전**이다(검색 API 대신 브라우저 엔진 운영까지 떠안는다).

### 5.2 실제 병목은 브라우저가 아니라 **T-a**다 ★가장 실무적인 발견

오늘 momo의 에이전트가 실행할 수 있는 툴은 **정확히 2개**다:

```rust
// server-rust/crates/momo-agent/src/tools.rs:139
pub const CATALOG: &[&str] = &[WORK_SESSION_END, WORK_SESSION_SPAWN];
```

그리고 `agent.tool_schema`에는 **쓰기 표면이 아예 없다** — `crates/momo-agent/src/provisioning.rs:364-368`이 `'[]'::jsonb`로 하드코딩하고, 레포 전체에서 이걸 UPDATE하는 곳은 테스트의 raw SQL 한 군데뿐이다. ADR-0150이 스스로 적어둔 선행 조건도 *"`agent.tool_schema` 쓰기 표면 또는 tool 카탈로그 확장 경로(T-a)"*다.

**즉 오늘 Obscura를 도입해도 에이전트에게 쥐어줄 방법이 없다.** 브라우저 앞에 T-a가 서 있고, T-a가 열리는 순간 **가장 싼 채움은 provider 내장 검색**(codex 경로는 코드 0줄)이다. 브라우저는 빨라야 3순위다. **지금 이 물건을 평가하는 것은 순서가 틀렸다.**

### 5.3 그래도 브라우저만 채울 수 있는 진짜 공백 — 공정하게 4건

반증만 찾으면 편향이므로, provider 내장 검색으로 **못 메우는 것**을 명시한다:

1. **hermes 기본 경로의 구조적 공백.** 제품 기본값이 웹을 영영 못 본다. 단 이건 브라우저가 아니라 서버측 `web.search` 툴로도 메워진다 — 그리고 그 경로는 §5.1에서 이미 "비싸다"고 기각됐다.
2. **상호작용 부재.** provider의 `web_search`는 `search`/`open_page`/`find_in_page`뿐 — 클릭·폼 입력·인증 세션·JS 앱 조작·스크린샷이 없다. **브라우저만이 여기를 메운다.** 그러나 클릭·폼 제출은 **읽기 전용이 아니고 비가역적**이라 **ADR-0150 D2("승인 대상 아님")의 반대편으로 넘어간다.** 즉 이것은 kitesurf 채택 결정이 아니라 **새 승인 정책 결정**이며, ADR-0150을 다시 여는 일이다.
3. **인용 유실.** `collect_output_text()`가 `url_citation` annotation을 버린다(`responses.rs:362-372`). 브라우저와 무관한 **어댑터 버그**다.
4. **감사 부재.** *"지금은 `web_search_call`이 무시되므로 아무 흔적도 남지 않는다"* — ADR-0150 D3의 생산자가 없다. 이것도 브라우저와 무관하다.

**4건 중 브라우저가 유일한 해답인 것은 2번 하나뿐이고, 그 하나는 새 ADR 결정을 요구한다.** 1·3·4는 브라우저 없이 더 싸게 해결된다.

### 5.4 불변식 충돌 — 직접 위반은 없다, 그러나

정직하게: Obscura는 우리 하드 룰을 **직접 위반하지는 않는다.**

- **PG=SoT**: 위반 없음(브라우저는 상태를 안 가짐 — stateless가 오히려 미덕)
- **단일 쓰기경로**: 위반 없음(도구 결과가 기존 REST 경로로 들어오면 됨)
- **RLS FORCE**: 무관
- **ADR-0004**: Obscura 자체는 LLM provider가 아니라 API 키가 없어도 돈다 → **직접 위반 없음.** 선례의 TencentDB-Agent-Memory(4중 위반)와 결정적으로 다르다. 단 상용 프록시를 붙이면 그때 자격증명이 생긴다.

**충돌은 하드 룰이 아니라 신뢰경계와 배치 위치에서 난다.** 그리고 이 부분은 우리 레포가 **이미 답을 적어놨다**:

- `docs/adr/0157-sandbox-network-boundary.md` **D3(Accepted 2026-08-09)** — 샌드박스 인터넷 egress는 v0 허용. 대신 정직한 명제를 박아뒀다: **"샌드박스에 주입된 컨텍스트는 유출 가능하다고 간주한다."** D1/D2로 샌드박스→내부망·샌드박스↔샌드박스는 eBPF `deny_out`으로 차단.
- 즉 **적대적 웹 콘텐츠를 실행할 자리는 이미 존재한다 — T3 CubeSandbox microVM 안이다.** 서버측 컴포넌트로 들이는 것이 아니라.

거꾸로 말하면: 서버 프로세스로 Obscura를 올리는 순간, *"인터넷 아무 페이지의 JS를 PG(=SoT) 박스와 같은 신뢰경계에서 실행"*이 된다. 이는 선례 문서 §1.5가 CubeSandbox를 프로덕션 박스에 올리는 것을 **"SoT를 태우는 도박"**으로 기각한 것과 같은 논리이고, 위협원이 우리 사용자가 아니라 **인터넷 전체**라서 더 나쁘다. SSRF·UAF(§3.5 R1)·cross-session 유출·에이전트 대상 프롬프트 인젝션이 한꺼번에 열린다.

---

## 6. 종합

### 6.1 포함 형태 3택 판정

| 후보 | 의존성 도입 | 패턴 차용 | 배제 |
|---|---|---|---|
| Cloudflare Kitesurf | ✗ (라이선스 부재·self-host 불가) | ✗ (소스 비공개라 볼 것이 없음) | **● 배제** |
| Obscura | ✗ (순서 오류·더 싼 채움 존재·신뢰경계) | △ (아래 1건, 낮은 우선순위) | **● 배제(현시점)** |
| kiteswang/kitesurf | ✗ | ✗ | **● 배제** |

**패턴 차용으로 남길 것 1건(무비용, 낮은 우선순위)**: Kitesurf도 Obscura도 **Chromium 없이 Rust 웹엔진 스택**으로 성립했다는 사실 자체. 부품이 전부 개별 permissive OSS다 — Blitz(Apache-2.0, ★3.9k), Parley(Apache-2.0), taffy(MIT), cosmic-text(Apache-2.0), Stylo(Servo, MPL-2.0로 알려짐·**미확인**). *만약* 나중에 서버측 렌더링(메시지 카드·미리보기 이미지 생성 등)을 하게 되면 "Chromium을 켠다"가 유일한 선택지가 아니라는 **선택지 존재만 기억**해두면 된다. **지금 할 일은 없다.**

### 6.2 재평가 게이트 (넷 다 참일 때만 다시 본다)

- **(G0) 순서** — **T-a(`agent.tool_schema` 쓰기 표면 / 카탈로그 확장)가 먼저 열린다.** 이게 없으면 어떤 툴도 에이전트에게 도달하지 못한다. 브라우저 논의는 T-a 뒤의 이야기다.
- **(G1) 수요** — T-a가 열린 뒤 **provider 내장 검색으로 실제로 돌려보고**, 그것으로 부족한 지점이 실측으로 드러난다(§5.3 2번 = 클릭·폼·인증 세션·스크린샷). 문서상 추정이 아니라 사용 실적으로.
- **(G2) 물건** — Cloudflare Kitesurf가 **실제로 permissive 라이선스로 공개 + Cloudflare 밖 실행 경로** 확보 / 또는 Obscura가 **v1.0 + 미해결 메모리안전 이슈(UAF·JS 인젝션·임의 파일 읽기) 정리**에 도달.
- **(G3) 배치** — 서버가 아니라 **T3 CubeSandbox microVM 안**(ADR-0157 D3의 egress 허용 + *"주입된 컨텍스트는 유출 가능"* 명제 적용 범위)이라는 배치가 확정된다.

G1이 참이 되는 시점에는 **ADR-0150 D2(승인 대상 아님)를 다시 여는 결정**이 함께 필요하다 — 클릭·폼 제출은 읽기 전용이 아니기 때문이다. 즉 **이 주제의 자연스러운 귀착점은 "브라우저 OSS 채택"이 아니라 "에이전트 웹 상호작용의 승인 정책"**이고, 도구 선택은 그 결정에 종속된다.

### 6.3 "포함"이 아니므로 결정 목록 없음

과제 규정대로 판정이 "포함"일 때만 결정 목록을 낸다. **판정이 배제이므로 결정할 것이 없다.** ADR 기안·티켓 발급 없음. 기존 ADR(0004/0142/0150/0156/0157)은 **아무것도 바뀌지 않는다.**

(참고로 이번 조사가 **재확인**해준 것은 있다: ADR-0150의 "provider 내장 우선" 자세와 조사 문서 §8의 자체호스팅 기각이 **옳았다**는 것. 이번에 실물 OSS를 실측하고 나니 그 판단이 오히려 강해졌다 — 선례 문서에서 ADR-0129가 독립 검증됐던 것과 같은 패턴이다.)

### 6.4 성재 한 줄 요약

> **"kitesurf는 아직 오픈소스가 아닙니다. Cloudflare가 사흘 전(8/6) 발표하면서 '준비되면 공개하겠다'고 한 단계고, GitHub에 레포가 없습니다(404). 게다가 Cloudflare Workers 위에서만 도는 원격 서비스라, 공개돼도 우리 셀프호스트에 '탑재'할 물건이 아닙니다.**
>
> **진짜 오픈소스인 건 그 조상 Obscura(Apache-2.0, Rust)입니다. 라이선스도 스택도 우리와 맞습니다. 그런데 순서가 틀렸습니다 — 성재가 이번 주에 승인한 ADR-0150이 '에이전트 웹검색'의 답을 이미 provider 내장 검색으로 정해뒀고(codex 경로는 코드 0줄이면 됩니다), 자체 호스팅은 조사 때 '명백히 비싸다'고 이미 기각했습니다. 더 중요한 건, 오늘은 무엇을 들여와도 에이전트에게 쥐어줄 수가 없다는 겁니다. 실행 가능한 툴이 2개로 잠겨 있고 tool_schema에 쓰기 표면이 없습니다(T-a). 브라우저보다 T-a가 먼저입니다.**
>
> **그리고 이 물건은 인터넷 아무 페이지의 JS를 우리 쪽에서 실행하는 엔진입니다. Obscura에는 use-after-free·JS 인젝션·임의 파일 읽기 이슈가 어제(8/8) 무더기로 열린 채 아무 답변이 없고, 일본 회사가 실측했더니 워드프레스 페이지에서 글자 22개만 긁어왔습니다.**
>
> **결론: 지금은 안 씁니다. 다만 '에이전트가 웹을 못 본다'는 문제의식 자체는 유효하니, 답은 kitesurf가 아니라 T-a → provider 내장 검색 순입니다. 그걸 써보고도 클릭·폼 입력·로그인 세션이 필요해지면 — 그때는 도구를 고르는 게 아니라 '에이전트가 웹에서 행동해도 되는가'를 ADR-0150에 다시 물어야 하고, 브라우저는 서버가 아니라 T3 샌드박스 안에 들어갑니다."**

---

## 7. 미확인으로 남긴 것 (정직 기록)

- **Cloudflare Kitesurf를 실행해보지 않았다.** 계정·`browser=kitesurf` 호출 미시도. 성능표(CPU 3.1×, 메모리 4.7× 절감, 벽시계 1.8× 느림)는 **전부 Cloudflare 자체 발표 수치**이며 3자 검증을 찾지 못했다. 확인 방법: Cloudflare 계정으로 Browser Run Quick Action 호출 후 자체 계측 — **단, 판정이 배제이므로 할 필요 없다.**
- **Obscura를 빌드·실행해보지 않았다.** 30MB 메모리·85ms 페이지로드 주장은 README 기반 미검증. v0.2.0 네이티브 렌더링의 실제 품질도 미검증. §3.5 R3의 3자 실측은 v0.1.x 시절이라 **현재 버전에 대해서는 공백**이다.
- **Obscura 이슈들의 실제 심각도를 코드로 재현하지 않았다.** 이슈 본문의 코드 인용은 정확하나(작성자가 파일 경로·코드 블록 제시), 실제 익스플로잇 가능성은 미검증. 다만 **미응답 상태 자체**는 실측된 사실이다.
- **Stylo 라이선스 미확인** — GitHub 자동분류가 `none`을 반환했다(MPL-2.0으로 알려져 있으나 원문 미확인). §6.1 패턴 차용을 실제로 할 때 확인 필요.
- **Obscura의 SGavrl / h4ckf0r0day 관계 미확인** — 소유자와 최다 기여자가 다른 이유(고용 관계? 인수?)를 확인하지 못했다. 버스팩터 판정에는 영향 없음.
- **세 후보 모두 CVE 이력·보안 감사 미조회.**
- **성재가 본 것이 ①이라는 특정은 정황 근거**(타이밍·보도 문구·문맥)이며 본인 확인을 받지 않았다. 다만 ②③ 어느 쪽이어도 판정은 배제로 동일하다.
- **§5.0의 "ADR-0150 연장선" 해석도 정황 추론**이다(같은 날 승인 + 동일 문제영역). 성재 본인 확인 시 §5의 프레이밍이 더 정확해진다 — **확인 요청 대상 1순위.**
- **provider 내장 web_search를 실제로 켜보지 않았다.** *"`[{"type":"web_search"}]`는 오늘 그대로 나간다"*는 조사 문서의 코드 판독 결론이며 실행 검증(§7의 "5분 실험")은 미수행. 이는 이번 과제 범위 밖이지만, **G1 판정의 전제**이므로 T-a 착수 시 반드시 실측해야 한다.
- **Obscura를 T3 샌드박스 안에서 돌려보지 않았다**(G3 배치의 실현성). CubeSandbox microVM 안에서 V8 빌드/실행이 자원 한도에 맞는지 미확인.

---

## 부록 — 출처

### 레포 내 근거 (절대경로)
- `/Users/kwakseongjae/projects/momo/docs/adr/0150-conversation-egress-boundary.md` — Accepted 2026-08-09, 웹검색 egress 원안(D1~D4)
- `/Users/kwakseongjae/projects/momo/docs/planning/2026-08-04-SRV-B3b-websearch-research.md` — §2.1 모델 8종 `supports_search_tool`, §3 어댑터 통과, **§8 자체호스팅 기각**
- `/Users/kwakseongjae/projects/momo/docs/adr/0157-sandbox-network-boundary.md` — D1~D3, 인터넷 egress v0 허용 + "주입 컨텍스트 유출 가능" 명제
- `/Users/kwakseongjae/projects/momo/docs/adr/0156-cubesandbox-t3-substrate.md` — T3 기질, HTTP API로만 소비
- `/Users/kwakseongjae/projects/momo/docs/adr/0142-t3-provider-interface-byoc.md` — 어댑터 수명주기 계약
- `/Users/kwakseongjae/projects/momo/docs/adr/0004-codex-oauth-hermes-provider-boundary.md` — 자격증명 비유입 원문
- `/Users/kwakseongjae/projects/momo/server-rust/crates/momo-agent/src/tools.rs` — `CATALOG` 2개(:139), `DECLARED_NOT_EXECUTABLE`(:153), `web.search` 부재 테스트(:683)
- `/Users/kwakseongjae/projects/momo/server-rust/crates/momo-agent/src/provisioning.rs:364-368` — `agent.tool_schema` 하드코딩 `'[]'::jsonb` (**T-a 병목**)
- `/Users/kwakseongjae/projects/momo/docs/planning/research/2026-08-08-oss-sandbox-memory-evaluation.md` — 선례 판정 형식

### 외부 출처

- Cloudflare 블로그: https://blog.cloudflare.com/kitesurf/
- Cloudflare 공식 문서: https://developers.cloudflare.com/browser-run/kitesurf/
- Cloudflare changelog: https://developers.cloudflare.com/changelog/post/2026-08-06-kitesurf/
- TechCrunch: https://techcrunch.com/2026/08/07/cloudflare-launches-kitesurf-a-browser-built-for-ai-agents/
- Obscura 레포: https://github.com/h4ckf0r0day/obscura (LICENSE·README·SECURITY.md·이슈 #584 원문 판독)
- Obscura 3자 실측(NITI Technology): https://note.com/niti_technology/n/n87b8bf42acff
- kiteswang/kitesurf: https://github.com/kiteswang/kitesurf
- Cloudflare OSS 이력 대조군: https://github.com/cloudflare/workerd (Apache-2.0)
