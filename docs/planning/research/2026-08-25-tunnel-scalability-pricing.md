# 터널 전략 확장성·가격 리서치 (RA-6)

> 2026-08-25 Fable(deep-research) 작성. 발제: 성재 — "Tailscale 가격 정책을 고려해 scalability 관점에서 Cloudflare Tunnel도 추가 옵션으로. rate limit·인원수 제한 걸리면 플랜 확장 또는 이동이 잘 지원되면 좋겠다. **그록봇 IP 고정이야 아니야?**"
> 선행 정본: `research/2026-08-23-tunnel-strategy-ra5.md`(quick tunnel 1015 구조 노출·대안 매트릭스·성재 A+B 결정) · `research/2026-08-22-grok-cdp-control-and-operator-host.md`(RA-4, 그록봇 VM 실측).
> 이 문서는 RA-5 **이후**를 다룬다. RA-5에서 이미 판정된 것(quick tunnel 부적합·Funnel 유력)은 재조사하지 않았다.
> 확신도 표기: **[실측]** = 이번 세션 직접 fetch/조회 · **[공식문서]** = 벤더 공식 문서 · **[커뮤니티]** = 포럼/HN/GitHub · **[추정]** = 출처 조합 추론 · **[미확인]** = 어느 출처로도 확인 실패.

---

## 0. 요약 (TL;DR)

1. **성재 질문 직답 — "static"이라고 벤더는 말하지만, 우리가 붙잡을 수 있는 고정은 아니다.**
   xAI 공식 문서는 *"Computers reach the internet through **static egress IP addresses**"* 라고 명시한다. **그러나 목록을 공개하지 않는다** — *"ask your account team for the current ranges"* 가 유일한 경로다. 게다가 **실측상 경로가 최근 바뀐 정황**이 있다(§3.4 타임라인: 8/13 AWS → 8/25 Cloudflare). ⇒ **IP allowlist는 포기가 맞다.**
2. **Cursor Cloud Agent는 IP를 공개한다 — 그런데 그록봇은 그 목록에 없다.** `cursor.com/docs/ips.json`(v1, modified 2026-05-29) = 416개 /32 + git 프록시 3개, **전부 AWS**. 우리 실측 `104.30.175.37`은 **0건 매칭**. 그록봇은 다른 경로를 탄다.
3. **`104.30.175.37`의 정체 규명 완료**: Cloudflare 소유(ARIN CLOUDFLARENET, AS13335)이나 **공개 anycast 목록에 없는 갭 대역 `104.28.0.0/14`** 소속. Cloudflare geofeed에 **`104.30.175.37/32, US-CA, San Jose`로 개별 등재**. 이 갭 대역의 geofeed 항목이 **56,653건(개별 /32)** vs anycast 대역 290건 → **WARP / Cloudflare One(Zero Trust) egress 대역**이 거의 확실.
4. **Tailscale 요금 락인은 사실상 없다 (블로커 해소).** Funnel은 무료 Personal 포함 **전 플랜** 가용 — *"Tailscale Funnel is available for all plans"* (Last validated 2026-01-20). 가격 페이지의 Premium 표기는 tier 하이라이트 마케팅이었다. **oort 최종 사용자는 Tailscale 시트를 소비하지 않는다** — 6인 한도는 tailnet 관리자에게만 걸린다.
5. **★ 대신 진짜 위험 셋이 드러났다.**
   - **WebSocket 드롭 (최우선)**: GH #18827 — `tailscale serve`에서 WS가 **10~40초마다 `1001 Going Away`로 끊김**. 2026-02-27 개설, **Open·스태프 무응답**. **Centrifugo 실시간 레일 직격.**
   - **LE 인증서 34시간 락아웃**: 재발급 rate limit 초과 시. 그록봇 durable-but-resettable 재프로비저닝 패턴과 정면 충돌.
   - **3년 9개월째 beta** + 대역폭 한도 비공개 + SLA 없음 + 무통보 정지 가능 AUP.
6. **URL lock-in은 "높음"이다.** Funnel 앞 커스텀 도메인 CNAME은 **공식 미지원**이고 이슈가 **closed as not planned**(GH #16478). 리다이렉트도 없다.
7. **Cursor 공식 문서가 우리 두 옵션을 모두 권장한다** — 에이전트가 사설 서비스에 닿는 방법으로 *"Tailscale userspace networking, Cloudflare Tunnel, or a similar private-network client"*. 우리 방향이 벤더 권장안과 일치한다.
8. **CF named tunnel 축(§2)은 이번 패스 미완**이다 — 핵심 분기(§2.3 CF-origin 트래픽 판정)를 확증하지 못했다.

---

## 1. 축1 — Tailscale 가격·한도·확장/이탈 경로

### 1.1 2026년에 실제로 가격 개편이 있었다 — "Pricing v4"

| 항목 | 내용 | 확신도 |
|---|---|---|
| 발표일 | **2026-04-08** (tailscale.com/blog/pricing-v4) | [공식문서] |
| 교차검증 | 무료 플랜 문서 "Last Updated: April 8, 2026" · 체인지로그 동일자 | [공식문서] |
| 핵심 변경 | 비즈니스 플랜 **usage-based(MAU) → seat-based(점유 좌석)** | [공식문서] |
| 플랜 개명 | **Starter → Standard** ("Starter becomes Standard") | [공식문서] |
| **Personal Plus 폐지** | 유료 티어 은퇴, 기능이 무료 Personal로 흡수 — Personal이 "up to six users—the same limit Personal Plus had" | [공식문서] |
| 디바이스 캡 폐지 | *"All plans can have an unlimited number of user devices in a tailnet."* (구 100대 캡 제거) | [공식문서] |
| 기존 고객 보호 | *"Your current plan will keep working, at the same price, for at least another 12 months."* → **최소 2027-04까지** 강제 이전 없음 | [공식문서] |

> 발제문의 "Starter" 표현은 2026-04-08 개편으로 **Standard**가 됐다. 2025년 중 별도 개편 발표는 발견되지 않음 [미확인→없음 추정].

### 1.2 현재 티어표 (tailscale.com/pricing, 2026-08-25 [실측])

| | **Personal (무료)** | **Standard** | **Premium** | **Enterprise** |
|---|---|---|---|---|
| 가격 | **$0 "Free forever"** | **$8** /user/mo | **$18** /user/mo | Custom (invoice) |
| 사용자 | **최대 6명** (좌석 추가 **불가**) | 무제한 | 무제한 | 무제한 |
| 사용자 디바이스 | 무제한 | 무제한 | 무제한 | Custom |
| Tagged resources | 50 포함 (+$1/월/개) | 50 (+$1/월/개) | 50 (+$1/월/개) | Custom |
| Ephemeral | 1,000분/월 | 1,000분/월 | 10,000분/월 | Custom |
| **ACL 그룹 수** | **3** | 10 | 300 | Custom |
| **Funnel** | ✅ | ✅ | ✅ | ✅ |

- Seat 정의: *"A user occupies a vacant seat when they first log in to the admin console or when they first authenticate a device."* 좌석 재사용 가능 [공식문서]
- Ephemeral: **4시간 초과 상주 시 일반 tagged resource로 카운트 전환** [공식문서]
- 할인: OSS(GitHub 인증) 무료 · 비영리/교육 **50% 할인** [공식문서]
- 커뮤니티 반응(HN 47691281): 8인 스타트업이 "$6~12 → $64/월" 5~10배 인상 사례 보고, tagged 포함량 100→50 감소 불만 [커뮤니티]

### 1.3 ★ Funnel 플랜 게이팅 — **없음** (선행 블로커 해소)

| 출처 | 문면 |
|---|---|
| `docs/features/tailscale-funnel` (**Last validated 2026-01-20**) | **"Tailscale Funnel is available for all plans."** |
| `tailscale.com/pricing` | Funnel을 Premium 열에 표기 (tier 하이라이트 마케팅 표기) |

**판정: 최신 검증일이 붙은 기능 문서가 정본. 무료 Personal에서 Funnel 사용 가능.** 우리 D8 무료 tailnet에서 Funnel이 실제 가동 중인 실측(`cursor.tailb1aad3.ts.net`, CURRENT_STATE:143)과도 일치한다. **요금 확장성 우려는 해소.**

**남는 리스크는 요금이 아니라 상태다** — Funnel은 2022-11-17 알파 발표 이후 **3년 9개월째 "currently in beta"**이고 GA 공지가 없다 [공식문서+추정].

### 1.4 Funnel 한도 (KB/docs, 2026-08-25 [공식문서])

| 항목 | 문면 |
|---|---|
| 허용 포트 | "Funnel can only listen on ports `443`, `8443`, and `10000`." |
| DNS 이름 | "Funnel can only use DNS names in your tailnet's domain (`tailnet-name.ts.net`)" |
| TLS | "Funnel only works over TLS-encrypted connections" |
| **대역폭** | **"Traffic sent over a Funnel is subject to non-configurable bandwidth limits"** — **수치 비공개** |
| Serve와 포트 공유 | 같은 포트를 Serve/Funnel 동시 사용 불가 (나중 명령이 이김) |
| 요건 | v1.38.3+ · MagicDNS · HTTPS 인증서 · policy file `funnel` nodeAttr |
| 동시연결 수 / 요청 rate limit / Funnel 노드 개수 | **전부 문서화 없음** [미확인] |

**tagged 노드 함정**: `funnel` nodeAttr 기본값은 `autogroup:member`인데 **`autogroup:member`는 tagged 노드에 적용되지 않는다.** 서버를 `tag:oort-server` 등으로 태깅했다면 policy에 `{"target": ["tag:oort-server"], "attr": ["funnel"]}` 명시 필요 [공식문서+커뮤니티].

### 1.5 ★★ 최우선 위험: WebSocket 드롭 (GH #18827)

> *"tailscale serve: WebSocket connections drop every 10-40s with code 1001 (Going Away)"*
> **Open** · 개설 **2026-02-27** · Tailscale 1.94.2 · 끊김이 **Tailscale proxy 레이어에서 발생**(업스트림 정상) · 동일 설정이 다른 머신에선 정상(환경 의존) · **워크어라운드 없음, 스태프 응답 없음**
> 출처: https://github.com/tailscale/tailscale/issues/18827 [커뮤니티]

- 이슈는 Serve 기준이나 **Funnel도 동일 reverse-proxy 코드 경로를 탄다** → 영향 가능성 [추정].
- **oort는 Centrifugo WebSocket이 실시간 레일의 전부다.** 이 이슈가 우리 환경에서 재현되면 Funnel 채택 자체가 무너진다.
- **⇒ Funnel 확정 전 게이트로 걸 것: 다중 클라이언트·1시간 이상 WS 연결 실측.** (D8에서 WS 101 통과는 봤지만 **장시간 유지**는 측정한 적 없다.)

### 1.6 ★ 두 번째 위험: Let's Encrypt 34시간 락아웃 (Funnel판 1015)

> KB 원문: **"It is possible to frequently request a new certificate and exceed Let's Encrypt's rate limits. As a result, you may find yourself waiting 34 hours until you can try again."** [공식문서]

- RA-5가 quick tunnel에서 지적한 구조와 **동형**. 그록봇 VM은 durable-but-resettable(RA-4) → Reset/Update마다 스택 재구성 → 인증서 재요청 빈발 → **34시간 락아웃**.
- quick tunnel 1015(15분)보다 **락아웃이 136배 길다.**
- **완화(설계 요구사항)**: Tailscale state(`/var/lib/tailscale`)와 인증서를 `/workspace` 영속 경로에 바인드하여 재기동 시 **재발급이 아니라 재사용**되게 한다. T-2 플레이북 필수 문면.

### 1.7 DERP·처리량

| 사실 | 내용 | 확신도 |
|---|---|---|
| Funnel frontend는 DERP와 **별개 인프라** | *"Funnel runs on distinct services, VMs, and networks from DERP"* — georeplicated | [공식문서] |
| 경로 | 공개 DNS → Funnel ingress(SNI만 보고 **TLS 미종료**) → tailnet WireGuard → 내 노드가 TLS 종료. **E2E 암호화 유지** | [공식문서] |
| DERP fallback 가능성 | Funnel ingress도 tailnet 노드 → 직결 실패 시 DERP 경유 → **Funnel 한도 + DERP 페어니스 스로틀 중첩** | [추정] |
| DERP 특성 | *"DERP servers limit throughput to ensure fairness"* · Peer Relay(27~35 Mbit/s)가 DERP 대비 **12.5배** → 역산 시 DERP 실효 **~2~3 Mbit/s급** | [공식문서]+[추정] |
| 실제 대역폭 | Tailscale 직원: *"there is a bandwidth limit, it's a funnel, not a hose. **We don't announce what the bandwidth limit is**"* | [커뮤니티] HN 35375794 |
| 서드파티 추정 | 35 Mbps ~ 1 Gbps로 **30배 편차** — 용량 계획 근거로 사용 불가 | [커뮤니티] |

### 1.8 인원수 한도의 실제 의미 (오해 정정)

- Personal "최대 6명" = **tailnet에 로그인하는 Tailscale 계정 수**.
- oort 사용자는 Funnel이 서빙하는 **공개 HTTPS 엔드포인트**의 외부 방문자 — tailnet 멤버가 아니다.
- ⇒ **oort 사용자 100명이어도 Tailscale 시트는 1개**(운영자)만 소비 [추정 — 구조상 자명].
- 성재 발제의 "인원수 제한" 우려는 oort 확장성에 **직접 걸리지 않는다.** 걸리는 건 §1.4 대역폭·§1.5 WS·§1.6 인증서다.

### 1.9 확장 경로 (free → paid)

| 질문 | 답 | 확신도 |
|---|---|---|
| 업그레이드 | **셀프서브** — 콘솔 Billing → "Switch plan" (Owner/Admin/Billing admin) | [공식문서] |
| 즉시 반영 | **예** — *"your new plan takes effect immediately"*, 좌석 변경도 *"instant"* | [공식문서] |
| 정산 | *"Charges are prorated based on time spent on each plan"* | [공식문서] |
| 연간 플랜 | 셀프서브 불가 — 영업 경유 | [공식문서] |
| 업그레이드가 tailnet 이름을 바꾸는가 | 변경된다는 언급 없음 → **안 바뀜** | [추정] |
| **무료 한도 초과 시** | **하드 블록.** 7번째 사용자 추가 시 "Reached use limit". **Personal은 좌석 구매 자체가 불가** → 업그레이드 또는 기존 사용자 삭제 | [공식문서] |
| 유예 기간 | **문서화 없음** | [미확인] |
| **Personal → 커스텀 도메인 조직(SSO) 전환** | **부분적으로만 가능.** 커스텀 OIDC 마이그레이션은 **소유 커스텀 도메인이 있을 때만**. `@gmail.com` 등 비커스텀 도메인은 **불가**. **GitHub·Apple IdP는 from/to 마이그레이션 불가** | [공식문서] |
| 전환 절차 | 도메인에 WebFinger 설정 후 **Tailscale 서포트 연락** | [공식문서] |

> **oort 함의**: Google/GitHub 로그인으로 만든 개인 tailnet은 나중에 커스텀 도메인 조직으로 **깔끔히 전환할 수 없을 가능성이 높다.** 커스텀 도메인 SSO 계획이 있다면 **처음부터** 그 IdP로 tailnet을 만들어야 한다.

### 1.10 ★ 이탈 경로 / lock-in — **"높음"으로 상향**

| 요소 | 실태 | 확신도 |
|---|---|---|
| Funnel URL | `https://<machine>.<tailnet>.ts.net` — `.ts.net`은 **Tailscale 소유 도메인, 이전 불가** | [공식문서] |
| **커스텀 도메인 CNAME** | **공식 미지원.** GH **#16478**("Funnel returns SSL_ERROR_SYSCALL for custom domain with CNAME", 2025-07-07) → **Closed as not planned**. TCP는 붙지만 **TLS 핸드셰이크에서 실패**(Funnel이 커스텀 도메인 인증서를 발급/제시 안 함). 기능요청 GH **#11563**(2024-03-29)은 **Open·needs-triage·무응답** | [커뮤니티] |
| 유일한 우회 | 공인 IP VPS에 Traefik/Nginx를 두고 자체 LE 인증서 발급 후 Funnel URL로 포워딩 — 저자 본인이 *"please for the love of god, do not use this setup for production use"* 명시. **게다가 공인 IP가 필요해지는 순간 Funnel의 존재 이유가 사라진다** | [커뮤니티] |
| tailnet 이름 변경 | 가능(콘솔 DNS → "Rename tailnet", 랜덤 단어쌍 중 선택). **단 "After you use a randomized name for HTTPS certificates, you cannot re-generate it."** | [공식문서] |
| 변경 시 파손 | *"existing links to devices in your tailnet might break"* — MagicDNS·HTTPS 인증서·sharing. **리다이렉트 제공 언급 전무** | [공식문서]+[추정] |
| 머신 이름 변경 | 가능. MagicDNS 이름이 **즉시 바뀜** = Funnel URL 앞부분 변경. 충돌 시 `-1` 접미사가 붙고 **자동 회수 안 됨** | [공식문서] |
| ⚠️ 운영 함정 | "Auto-generate from OS hostname"을 끄지 않으면 **OS hostname 변경 시 Tailscale 재시작에서 머신 이름이 조용히 바뀐다** → URL 무단 변경 사고. **서버는 반드시 끌 것** | [공식문서] |

**완화(권고)**
1. oort 클라이언트는 서버 URL을 **사용자 설정값**으로 계속 다룰 것 (현 "서버 주소 변경"/재페어링 UX 유지). `.ts.net`을 바이너리에 하드코딩 금지.
2. 머신의 **"Auto-generate from OS hostname" 비활성화**.
3. **HTTPS 인증서 발급 전에** 원하는 tailnet 이름 확정 (발급 후 재추첨 불가).
4. 자기 도메인 + 자기 인증서 경로(CF named tunnel 등)로의 이행 계획을 미리 확보.

---

## 2. 축2 — Cloudflare named tunnel 옵션화 타당성 ⚠️ **이번 패스 미완**

### 2.1 quick tunnel 공식 한계 (RA-5 재확인 [공식문서] 2026-08-25 [실측] fetch)

- **"Quick Tunnels are intended for testing and development only."**
- **"We don't guarantee any SLA or uptime of TryCloudflare"**
- **"Quick Tunnels are subject to a hard limit on the number of concurrent requests... Currently, this limit is 200 in-flight requests."**
- 계정·도메인 불요, `trycloudflare.com` 랜덤 서브도메인.
⇒ RA-5 판정 유지. v1 기본 경로로 부적합.

### 2.2 Zero Trust 무료 tier·요건

| 항목 | 값 | 확신도 |
|---|---|---|
| ZT 무료 사용자 수 | **50 users**, 2026년에도 변경 없음 | **[커뮤니티/2차출처]** — 공식 직접 확인 실패 |
| 초과 시 | pay-as-you-go **$7/user/mo** | [커뮤니티/2차출처] |
| named tunnel이 ZT 시트를 소비하는가 | public hostname 라우팅만·Access 정책 미부착 시 **시트 불요**로 판단 | **[추정 — 확증 필요]** |
| 도메인 필요 여부 | Cloudflare DNS에 올린 도메인 필요 | **[추정 — 공식 문면 확보 실패]** |
| 터널 수·hostname 수 한도 | **미확인** | — |

> 2차 출처는 costbench/zerometric/zerotrustcost 등 **SEO성 요약 사이트**다. 공식 확인 전 의사결정 근거로 쓰지 말 것.

### 2.3 ★ 핵심 분기 — CF-origin 트래픽이 CF-proxied named tunnel에 들어갈 때 (**미해결**)

성재 발제의 결정 분기이자 RA-5가 남긴 숙제. **확증 실패.**

**논리적 재구성 [추정 · 확신도 중]**:
- `trycloudflare.com`은 **Cloudflare 소유·운영 zone**이고 보호 규칙을 우리가 통제할 수 없다. RA-5가 관측한 1015는 이 zone의 규칙에 그록봇 egress(풀 공유)가 걸린 것.
- **자기 zone의 named tunnel**은 rate limiting 규칙을 **우리가 정의**한다. 무료 zone에 기본 활성 per-IP 제한은 없다고 보는 것이 자연스럽다.
- ⇒ **1015 구조 노출은 named tunnel 전환으로 대체로 해소될 개연이 높다.** 단 Bot Fight Mode·Managed Ruleset 등 무료 zone 기본 보안이 **Cloudflare 자기 대역 발 트래픽**(§3에서 확인된 WARP egress)을 어떻게 판정하는지는 별개이며 **미확인**.
- `error 1000 DNS points to prohibited IP`는 **origin**이 CF IP일 때 발생하는 것이지 **client**가 CF IP일 때가 아니다 — 우리는 client 쪽이라 해당 없음 [추정].

**이 절은 확증 전까지 결정 근거로 쓰면 안 된다. 후속 조사 1순위.**

### 2.4 WebSocket·타임아웃·용량 — **미확인**
named tunnel WS 공식 지원 여부, idle timeout(100s/600s 설), 최대 연결 지속시간, 무료 100MB 업로드 상한 — 전부 미확인. **Centrifugo가 걸리는 지점이라 옵션화 결정 전 필수.**

### 2.5 CF AUP 2.8 (비-HTML 콘텐츠 제한) — **미판정**
현행 문면·개정일 미확인. oort 첨부 업로드 노출 여부 미판정. Tailscale Funnel의 "non-configurable bandwidth limits"와 대칭 리스크.

### 2.6 named tunnel의 실제 값어치 (판단)

| 기대 이점 | 판정 |
|---|---|
| rate limit 회피 | **개연 높으나 미확증** (§2.3) |
| **커스텀 도메인 = URL lock-in 소멸** | **✅ 확실한 이점.** Tailscale이 구조적으로 못 주는 유일한 것(§1.10) |
| 고정 URL | Funnel도 제공 — 차별점 아님 |
| 프로덕션 적격 | quick tunnel과 달리 named는 정식 제품 [추정] |
| 진입 비용 | **도메인 필요** — 그록봇 원클릭의 무진입장벽을 깨뜨림 |
| **벤더 권장 여부** | **Cursor 공식 문서가 명시 권장**: 에이전트→사설 서비스 접근에 *"Cloudflare Tunnel is a good fit when the agent can reach the private service through an authenticated HTTPS hostname"* [공식문서] |

⇒ **named tunnel은 "무료 tier 확장 경로"가 아니라 "도메인 보유 운영자용 상위 경로"다.** RA-5 분류와 결론 동일, 근거 보강.

---

## 3. 축3 — 그록봇 egress IP 고정성 (성재 질문 직답)

### 3.1 ★ xAI 공식 문면 발견

| 원문 (verbatim) | 출처 | 확신도 |
|---|---|---|
| **"Computers reach the internet through static egress IP addresses. If your company restricts services by source IP, ask your account team for the current ranges."** | https://docs.x.ai/grok-bot/teams-and-enterprises | [공식문서] |
| "Some services flag **datacenter IP addresses**. **Allowlist the Grok Bot egress ranges on your own services**, or have the member try the **beta setting that routes computer traffic through their own computer**." | 동 (페이지 귀속은 [추정]) | [공식문서] |
| "All of your Bots use the same persistent cloud computer... The computer is **isolated to your account**, not to an individual Bot." / "do not use separate Bots as a security boundary" | docs.x.ai/grok-bot/overview · /computer-and-apps | [공식문서] |

> RA-4가 인용했던 "static egress IP addresses" / "datacenter IP addresses"의 **정확한 출처를 이번에 특정했다.**
> **주목할 신규 사실**: *"beta setting that routes computer traffic through their own computer"* — **Desktop Egress Routing 베타**. 활성화하면 egress가 사용자 본인 머신을 경유한다. oort 관점에서 잠재적 옵션(§3.6).

### 3.2 목록은 공개되는가 — Cursor는 ✅, 그록봇은 ❌

**Cursor Cloud Agents — 공개됨** (`https://cursor.com/docs/ips.json`, 2026-08-25 [실측] 직접 fetch·파싱)

| 항목 | 값 |
|---|---|
| version / modified | `1` / **`2026-05-29T19:43:24.653Z`** |
| 클러스터 | us1, us1p, us3, us3p, us4, us4p, us5, us5p, us6, us6p, us7, us7p (**us2 없음**) |
| 총 항목 | **416개 `/32`** + `gitEgressProxy` 3개 |
| 대역 성격 | **전부 AWS** (3.x, 13.x, 16.x, 18.x, 32.x, 34.x, 35.x, 44.x, 50.x, 52.x, 54.x, 98.x, 100.x, 184.x) |
| **`104.x` 포함** | **0건 — 측정된 `104.30.175.37`은 이 목록에 없다** |
| 접근 제한 | 없음 — 인증 불필요, 엔터프라이즈 전용 아님 |
| 공식 문면 | *"published in CIDR notation through a JSON API endpoint"* / *"We make changes to our IP addresses from time to time"* / **"We do not recommend allowlisting by IP address as your primary security mechanism."** |

**Grok Bot — 미공개** [공식문서 + 실측(부재 확인)]
- 공식 안내는 **"ask your account team for the current ranges"** 뿐.
- `docs.x.ai` 전역에 GitHub `api.github.com/meta`나 Cloudflare `/ips-v4` 같은 **발행 채널이 존재하지 않는다.**
- 엔터프라이즈 전용이라는 라벨도 없다. 셀프서비스 경로 없음.

### 3.3 `104.30.175.37` 포렌식 (전부 [실측], 2026-08-25)

| 검증 | 결과 |
|---|---|
| RDAP (ARIN) | `104.16.0.0 - 104.31.255.255` / `CIDR 104.16.0.0/12` / NetName **CLOUDFLARENET** / Cloudflare, Inc. (CLOUD14) |
| ipinfo | **AS13335 Cloudflare** · **San Jose, California, US** |
| rDNS | **PTR 없음** |
| `cloudflare.com/ips-v4` 대조 | 공개 anycast = `104.16.0.0/13` + `104.24.0.0/14` = **104.16–104.27**. → **`104.30.175.37` ∉ 공개 목록 (계산 확정)** |
| **갭 대역** | ARIN 할당 − 공개 목록 = **`104.28.0.0/14`** (104.28–104.31). Cloudflare 소유이나 **CDN anycast로 미발행** ← 측정 IP가 여기 속함 |
| Cloudflare geofeed (`api.cloudflare.com/local-ip-ranges.csv`) | **정확히 이 줄 존재: `104.30.175.37/32,US,US-CA,San Jose,`** |
| geofeed 항목 수 대비 | 104.28–104.31 = **56,653건**(대부분 개별 `/32`, 전 세계 도시별 매핑) vs 104.16–104.27(anycast) = **290건** → **엔드포인트 단위 egress IP의 전형적 시그니처** |

**Cloudflare 공식 문서와의 대조** [공식문서]
- *"Cloudflare One Client egress IPs are **not listed** at Cloudflare's IP Ranges."* → 측정 IP가 `/ips-v4`에 없는 사실과 **정확히 일치**.
- 기본 egress: *"traffic exits from the nearest Cloudflare data center"* + *"**shares a source IP address with all other Cloudflare One Client users**"* → 데이터센터별 개별 `/32` geofeed 등재 구조와 일치.
- Dedicated Egress IPs: *"Static IP addresses assigned **exclusively to your account**"*, **Zero Trust Enterprise add-on**, *"contact your account team"*.
- 커뮤니티 WARP 관측: `104.28.203.246`, `104.28.154.37` — **동일 `104.28.0.0/14` 블록** [커뮤니티]

**가설 판정**

| 가설 | 판정 |
|---|---|
| **Cloudflare WARP / Cloudflare One(Zero Trust) egress** | ✅ **가장 유력** — geofeed `/32` 개별 등재 + anycast 제외 + AS13335 + WARP 관측과 동일 블록 |
| Cloudflare **Dedicated Egress IPs** (ZT Enterprise) | ⚠️ **가능** — xAI의 "static egress IP addresses / ask your account team" 문구가 이 제품 문구와 **거의 그대로 겹침**. 정황 일치, 직접 증거 없음 |
| Cloudflare CDN anycast | ❌ 배제 (계산으로 확정) |
| Cloudflare Tunnel (WARP-to-Tunnel) | ❌ 배제 — Tunnel은 ingress 경로, 아웃바운드 source IP를 바꾸지 않음 |
| Workers / Containers | ❌ 배제 — VM 자기보고(Debian 13 trixie amd64)와 불일치 |
| Desktop Egress Routing 베타 활성 | ❌ 배제 — 활성이면 성재 **가정용 ISP IP**가 보여야 함 |

### 3.4 ★ 경로가 최근 바뀐 정황 (타임라인)

```
2026-05-29  cursor.com/docs/ips.json  modified (전부 AWS)
2026-08-13  커뮤니티 실측: 그록봇 egress = 32.188.55.103 (AWS us-west-2, Boardman OR, AS16509)
            → NZ B2B 사이트(Imperva)에서 datacenter IP로 하드블록
2026-08-18  Cursor 스태프 Colin: "Agent Computer currently egresses from US cloud infrastructure...
            a known limitation we're actively working to improve"
2026-08-25  성재/Fable 실측: egress = 104.30.175.37 (Cloudflare WARP/One 대역, San Jose)
```
→ **datacenter-IP 평판 차단을 우회하려 egress를 Cloudflare 경유로 전환한 것과 정합적.** 단 이를 확인하는 **공식 발표는 없다** [추정].
→ 참고: `32.188.55.103`은 ips.json에 문자 그대로는 없으나 같은 파일에 `32.185.7.84`, `32.185.8.72`, `32.185.18.216` 등 **동일 계열 AWS `32.0.0.0/8` 주소가 다수** 존재 → 8/13 시점 그록봇은 Cursor Cloud Agent 인프라에서 직접 egress했을 가능성 [추정].

### 3.5 ★ 성재 질문 직답 — "그록봇 IP 고정이야 아니야?"

> **벤더는 "static"이라고 말한다. 그러나 (1) 목록이 공개되지 않고 (2) 실측상 최근 경로가 바뀐 정황이 있으며 (3) 변경 통지 채널이 없다. ⇒ 우리가 실무적으로 붙잡을 수 있는 "고정"이 아니다. IP allowlist는 포기가 맞다.**

| 하위 질문 | 답 | 확신도 |
|---|---|---|
| 벤더가 static이라 말하는가 | **예** (docs.x.ai 명문) | [공식문서] |
| 목록이 공개(enumerable)인가 | **아니다** — account team 문의만. Cloudflare도 WARP 대역 미공개 | **높음 [공식문서+실측]** |
| 유저별 전용인가 풀 공유인가 | **불명.** Cloudflare 기본 egress는 공유·dedicated는 ZT Enterprise 전용이라는 일반론만 확인 | **확인 불가** |
| 변경 이력·공지 채널 | 그록봇 전용 **없음**. status.cursor.com에 "Grok Bot" 컴포넌트는 있으나 **네트워크/IP 전용 컴포넌트 없고 egress 인시던트 이력도 없음**. cloudAgents 풀에는 사전통지 약속조차 없다("from time to time") — 사전통지는 **Cursor Review/GHES IP 세트에만** 적용 | [실측] |
| 서버측 IP allowlist 가능한가 | **실무적으로 불가** | **높음** |

**중요 단서**: 그록봇(`com.anysphere.sand`)과 Cursor Cloud Agent는 **다른 egress 경로**를 탄다(실측 불일치). Cursor의 ips.json 계약을 그록봇에 그대로 적용하지 말 것. 참고로 **SpaceX가 Anysphere(Cursor)를 전액 주식 ~$60B에 인수, 2026-08-14~15 클로징**했고 Grok Bot은 SpaceXAI+Cursor 공동 제품으로 Cursor 인증을 쓴다 [커뮤니티·언론] — 인프라 재편이 진행 중일 가능성이 타임라인과 맞물린다.

### 3.6 그럼 접근 제어는 무엇으로 하나

| 수단 | 그록봇에 사용 가능? | 근거 |
|---|---|---|
| IP allowlist (공개 목록) | ❌ **불가** — ips.json이 실측값을 커버 못 함 | [실측] |
| IP allowlist (account team 제공) | ⚠️ 이론상. 셀프서비스·JSON 없음, team/enterprise 플랜 전제 | [공식문서] |
| Cloudflare 대역 통째 allowlist | ❌ **권장 불가** — `104.28.0.0/14`는 전 세계 WARP 사용자 공유 = 사실상 인터넷 개방 | [공식문서+추정] |
| **애플리케이션 토큰 / API key** | ✅ **벤더 권고안.** Cursor 스태프: *"app level auth, not network level … strong API keys"* | [커뮤니티·스태프] |
| **claim token 부트스트랩** | ✅ **이미 가동 중** — ADR-0166 / #1651, TTL 24h·1회 소비 | 내부 정본 |
| **agent-port bearer + scope** | ✅ **이미 가동 중** — `WWW-Authenticate: Bearer scope="agent:port:connect"` 401 실측 | 내부 정본 |
| mTLS | ⚠️ 스태프가 "optional mTLS" 언급하나 **그록봇 클라이언트 인증서 주입 경로 미확인** | [커뮤니티·스태프] / 일부 확인 불가 |
| **Cloudflare Tunnel + Access service token** | ✅ **Cursor 공식 권장** | [공식문서] |
| **Tailscale userspace networking** | ✅ **Cursor 공식 권장** | [공식문서] |
| Desktop Egress Routing 베타 | ⚠️ egress를 사용자 본인 머신 경유로 전환 — 그러면 **가정용 ISP IP가 되어 IP 고정성이 오히려 생길 수 있음**. 미검증 | [공식문서] |

⇒ **IP allowlist 옵션은 매트릭스에서 제거한다.** 우리가 이미 세워 둔 **토큰 기반 통제(ADR-0166 + agent-port bearer)** 가 이 위협모델의 정답이고, **벤더 권고와도 일치**한다.

---

## 4. 축4 — 종합 권고

### 4.1 터널 전략 매트릭스 갱신안

| | **Tailscale Funnel** (기본 — 조건부 유지) | **CF named tunnel** (상위 옵션) | quick tunnel (최후 폴백) |
|---|---|---|---|
| 대상 | 전 운영자 (그록봇 원클릭 포함) | **도메인 보유 운영자** | 없음 |
| 진입 비용 | Tailscale 계정 1개(무료) | 도메인 + CF zone + 계정 | 없음 |
| 요금 락인 | **없음** (전 플랜 Funnel 가용, oort 사용자는 시트 미소비) | ZT 무료 50인 [2차출처] | — |
| URL | `<m>.<tailnet>.ts.net` 고정 | **자기 도메인** | 랜덤·휘발 |
| **URL lock-in** | **높음** (CNAME closed as not planned·리다이렉트 없음) | **낮음** | — |
| 제품 상태 | **3년 9개월째 beta**, SLA 없음 | 정식 [추정] | **공식 "testing and development only"** |
| **WebSocket** | ⚠️ **GH #18827 미해결 (10~40초 드롭)** | 미확인 (§2.4) | R-2에서 GREEN 실측 |
| 알려진 락아웃 | **LE 인증서 34h** | 미확인 | 1015 15분 / 200 in-flight |
| 대역폭 | "non-configurable"·수치 비공개 | AUP 2.8 리스크 미판정 | — |
| 벤더 권장 | ✅ Cursor 공식 권장 | ✅ Cursor 공식 권장 | — |

**권고**: **Tailscale Funnel 기본 유지(RA-5 성재 결정 존중) — 단 §1.5 WS 실측을 통과 게이트로 건다.** 통과 시 §1.6 인증서 영속화 + §1.10 운영 함정 3종을 T-2 문면에 반영. **불통과 시 CF named tunnel로 축을 옮기는 것이 유일한 대안**이므로 §2.3·§2.4 확증 리서치를 미리 돌려 둘 가치가 있다.

### 4.2 한도 도달·사고 플레이북 (신호 → 행동)

| 신호 | 원인 추정 | 행동 |
|---|---|---|
| **실시간만 끊기고 REST는 정상 / WS가 10~40초마다 재연결** | **GH #18827** (§1.5) | **최우선.** Centrifugo 재연결 백오프로는 못 덮는다. 재현 확인 시 **CF named tunnel로 축 이동** |
| Funnel URL 34시간 접속 불가·인증서 오류 | LE rate limit (§1.6) | **예방이 유일** — state 영속화. 발생 시 대기 외 방법 없음, quick tunnel로 임시 우회 |
| 첨부만 느림/실패, 텍스트는 정상 | Funnel 대역폭 한도 (§1.4) | 첨부를 Drive 경로로 우회(설계됨) → 지속 시 CF named tunnel 검토 |
| URL이 예고 없이 바뀜 | "Auto-generate from OS hostname" 켜짐 (§1.10) | 즉시 비활성화. 사용자에게 새 주소 재회신 |
| tailnet 관리자 6인 초과 | Personal 한도 (**좌석 구매 불가**) | Standard $8/user로 업그레이드(즉시·비례정산). **oort 사용자 증가와 무관** |
| Funnel이 Premium 전용으로 공지 / beta 종료 시 과금 편입 | 정책 변경 | 기존 고객 12개월 보호(2027-04) 확인 후 CF named tunnel 이행 |
| 그록봇에서만 접속 실패, 타 클라 정상 | egress 대역 변경/차단 (§3.4) | **IP 기반 대응 불가.** 터널 provider 교체 또는 Desktop Egress Routing 베타 시험 |

### 4.3 T-2 플레이북에의 반영 (문서=제품)

현재 `docs/SELF_HOST_AGENT.md` §2는 **아직 quick tunnel 문면**이다(§2.1~2.2 [실측] 확인). RA-5의 Funnel 전환이 미랜딩 ⇒ **재작성 시 아래를 함께 넣으면 한 번에 끝난다**:
1. Tailscale state·인증서 **`/workspace` 영속화** (§1.6)
2. 머신 **"Auto-generate from OS hostname" 비활성화** (§1.10)
3. **HTTPS 인증서 발급 전 tailnet 이름 확정** (§1.10)
4. 서버를 태깅한다면 policy에 `funnel` nodeAttr 명시 (§1.4)
5. **WS 장시간 유지 검증 단계** 추가 (§1.5)

`scripts/`에 Funnel 자동화는 아직 없다 (`internal_alpha_stack.sh:158` 주석만 존재).

---

## 5. 이번 패스의 한계 (정직 고지)

- **완료**: 축1(Tailscale) · 축3(그록봇 egress) — 서브에이전트 2기 보고 + Fable 직접 실측 병합.
- **미완**: **축2(CF named tunnel)** — 담당 서브에이전트가 본 문서 갱신 시점에 미보고. §2.2~2.5는 Fable의 부분 실측·추정 수준이다.
- **미확인 목록**: CF ZT 무료 tier 공식 확인·도메인 요건 공식 문면·터널 수 한도(§2.2) · **CF-origin 트래픽 판정(§2.3 — 최우선)** · named tunnel WS/타임아웃/업로드 상한(§2.4) · CF AUP 2.8 현행(§2.5) · Funnel 동시연결/요청 rate limit·노드 수 한도 · Tailscale API rate limit(GH #14328, 2024-12 개설 후 무응답) · ACL 파일 크기 상한 · 무료 초과 시 유예기간 · 옛 tailnet/머신 이름 리다이렉트 여부 · 그록봇 egress가 전용인지 공유인지 · AWS→Cloudflare 전환의 공식 확인 · 그록봇 mTLS 클라이언트 인증서 주입 경로.
- 축2 보고가 도착하면 **§2를 교체**하면 된다(다른 절은 영향 없음).

---

## 6. 성재 결정 필요 항목

1. **[최우선] Funnel WebSocket 장시간 유지 실측을 게이트로 걸까** — GH #18827(§1.5)이 우리 환경에서 재현되는지. 다중 클라이언트·1시간+ 연결. → **Fable 권고: 무조건 선행.** 여기서 깨지면 나머지 논의가 무의미하다.
2. **T-2 플레이북 §2 재작성 발주 여부** — Funnel 기본 + §4.3의 5개 문면 포함. quick tunnel은 최후 폴백 1줄로 강등할지 완전 폐기할지. → **Fable 권고: 재작성 발주, 폴백 1줄 잔존.**
3. **CF named tunnel 확증 리서치(§2.3·§2.4) 선행 여부** — 1번이 RED일 때의 유일한 대안이므로 미리 돌려 둘 가치가 있다. 구현은 미착수. → **Fable 권고: 소형 리서치만 선행.**
4. **oort 공식 도메인 보유·운용 의사** — 있으면 CF named tunnel 경로가 열리고 URL lock-in(§1.10, "높음")이 사라진다. 브랜딩 관점도 포함 — **현재 사용자는 `cursor.tailb1aad3.ts.net`에 비밀번호를 입력해야 한다.**
5. **IP allowlist 옵션 공식 폐기 확인** — §3.5 근거로 매트릭스에서 제거, 토큰 기반(ADR-0166 + agent-port bearer) 단독 유지. → **Fable 권고: 폐기.** 벤더 권고와도 일치.
6. **(선택) account team 경로로 그록봇 egress 범위를 요청할지** — xAI가 문서로 안내하는 유일한 경로. 성재 계정 플랜에 따라 가능 여부가 갈린다. 실익은 낮다고 본다(§3.4 경로 변동 정황).

---

## 7. 출처

**Tailscale [공식문서]**
- https://tailscale.com/pricing · https://tailscale.com/blog/pricing-v4 (2026-04-08) · https://tailscale.com/changelog
- https://tailscale.com/docs/features/tailscale-funnel (Last validated 2026-01-20) · https://tailscale.com/docs/reference/tailscale-cli/funnel (2026-01-26)
- https://tailscale.com/funnel-aup (2025-06-30) · https://tailscale.com/terms
- https://tailscale.com/docs/concepts/tailnet-name · /concepts/machine-names · /reference/messages/console/reached-use-limit
- https://tailscale.com/docs/account/manage-plans/free-plans-discounts (2026-04-08) · /upgrade-plan · /modify-existing-plan
- https://tailscale.com/kb/1240/sso-custom-oidc · /docs/features/access-control/auth-keys · /docs/features/tailnet-policy-file
- https://tailscale.com/docs/reference/derp-servers · /connection-types · /best-practices/performance · https://tailscale.com/blog/peer-relays-international-networks · https://tailscale.com/blog/introducing-tailscale-funnel (2022-11-17)

**Tailscale [커뮤니티]**
- GH **#18827** WS 10~40초 드롭 (Open, 2026-02-27) · **#16478** 커스텀 도메인 CNAME (Closed as not planned, 2025-07-07) · **#11563** 커스텀 도메인 FR (Open, 2024-03-29) · **#14328** API 한도 질의 (Open, 2024-12-09)
- HN 47691281 (Pricing v4) · HN 35375794 (Funnel beta·대역폭 비공개 직원 발언) · HN 47063805 (Peer Relays GA)
- blog.gedas.dev/tailscale-funnel/ (2024-09-15) · onidel.com/blog/tailscale-cloudflare-nginx-vps-2025 (2025-09-27) · foundryvtt.wiki

**Cloudflare [공식문서]**
- https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/ · /connect-networks/
- https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1015
- https://developers.cloudflare.com/cloudflare-one/traffic-policies/egress-policies/ · /dedicated-egress-ips/
- https://www.cloudflare.com/ips-v4/ · https://api.cloudflare.com/local-ip-ranges.csv (geofeed)

**xAI / Cursor [공식문서]**
- https://docs.x.ai/grok-bot/teams-and-enterprises · /overview · /computer-and-apps · /faq · /approvals-security-and-privacy
- https://docs.x.ai/grok/connectors/custom-mcp-tunneling
- https://cursor.com/docs/cloud-agent/egress-ip-ranges · /security-network · https://cursor.com/docs/ips.json (**v1, modified 2026-05-29**) · /enterprise/network-configuration · /integrations/github · https://status.cursor.com/

**[커뮤니티]**
- forum.cursor.com/t/…/168271 (2026-08-13 Imperva 하드블록 실측 / 2026-08-18 스태프 답변) · …/160995 (2026-05-21 Dean Rie "app level auth, not network level") · …/162015 · …/103941
- community.cloudflare.com/t/…/431534 (WARP egress 관측) · flaviocopes.com/grok-bot/ (2026-08-22)

**[실측] (2026-08-25 이 세션 직접 수행)**
- `cursor.com/docs/ips.json` fetch·파싱 (416+3 엔트리, 104.x 0건) · `rdap.arin.net/registry/ip/104.30.175.37` · `cloudflare.com/ips-v4` 대조 계산 · Cloudflare geofeed 파싱 (104.28–104.31 = 56,653건 / 104.16–104.27 = 290건 / `104.30.175.37/32,US,US-CA,San Jose,` 정확 매치) · `dig` (PTR·cursorvm.com·api.cursor.com)

**내부 정본**
- `research/2026-08-23-tunnel-strategy-ra5.md` · `research/2026-08-22-grok-cdp-control-and-operator-host.md` · `docs/SELF_HOST_AGENT.md` §2 · `docs/planning/CURRENT_STATE.md`:143
