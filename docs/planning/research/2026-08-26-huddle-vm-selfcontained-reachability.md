# 허들 — 그록봇 VM 자체완결 도달성 리서치 (RA-8)

> 2026-08-26 Fable(deep-research) 작성. 발제: 성재 — *"그록봇 VM 내에서 셀프호스팅하면 허들도 알아서 거기서 세팅이 되어서 사용되고, 허들을 안 쓰는 팀은 꺼서 리소스를 아낄 수도 있게 하는 형태면 어떨까 싶어."* + 추가 지시 2건(**"tailscale도 같이 알아봐줘"**, **"TURN이 무엇이고 자체 오픈소스를 쓰는데 공인 IP는 왜 필요한가"**).
>
> **확신도 표기**: **[공식문서]** 벤더 공식 문서·약관 · **[소스코드]** 저장소 코드 · **[레포실측]** 이 레포 파일 직접 확인 · **[커뮤니티]** GitHub 이슈·포럼·블로그 · **[추정]** 출처 조합 추론 · **[미확인]** 확인 실패 · **🧪[실측필요]** 문서로 확정 불가, 돌려 봐야 함.
> 웹 출처 조회일은 모두 **2026-08-26**. 코드 근거는 `momo@d66ca97a` / `momo-tracks/engine@b1966a23`.
>
> 선행 정본(재조사하지 않고 전제로 씀): `research/2026-08-25-tunnel-scalability-pricing.md`(RA-6) · `research/2026-08-26-ra7-tunnel-identity-feasibility.md`(RA-7) · `research/2026-08-23-tunnel-strategy-ra5.md`(RA-5) · `research/2026-08-26-selfhost-external-dependency-audit.md` · `research/2026-08-26-ncp-teardown-judgment.md`.

---

## ① 한 줄 판정

**성재 조건 셋(제로 설정 · VM 자체 완결 · 무료)을 문서만으로 동시 충족한다고 말할 수 있는 경로는 없다 — 그리고 없는 이유는 우리 구현이 아니라 네트워크 위상이다.** 공인 inbound가 없는 호스트에 외부 브라우저의 미디어를 넣으려면 **인터넷에서 도달 가능한 지점이 최소 하나** 필요하고, 그 지점은 정의상 VM 안에 있을 수 없다.

**그러나 조건을 하나도 깨지 않고 살아남을 후보가 둘 있고, 둘 다 아직 안 재 봤다.**

- **P0 — SFU 홀펀칭**: VM이 스스로 NAT에 구멍을 뚫어 잠깐 도달 가능해진다. 조건 셋을 **전부** 만족한다. 그런데 **VM의 NAT가 symmetric이면 물리적으로 불가능**하고, 자사 동종 substrate(CubeSandbox microVM)가 symmetric이었다는 **실측 전례**가 있다. **실측 1분.**
- **P1 — Tailscale Funnel을 TURNS 통로로**: LiveKit **내장** TURN을 켜고 `turns:`(TLS)를 Funnel의 SNI 라우팅 TCP 모드에 물린다. TURN은 **VM 안에** 남고, 사용자는 **아무것도 설치하지 않으며**, 비용은 **0원**이고, 터널은 **D4로 이미 채택된 의존**이라 제3자가 늘지도 않는다. 대가는 **미디어가 TCP를 타는 품질 한 칸**뿐이다. 급소는 "Funnel이 TURNS를 실제로 라우팅하는가" 하나이고 **공식 문서에 언급이 없다.**

**성재가 특별히 물은 세 가지에 대한 직답**: ⓐ **"SFU가 밖으로 나가서 붙는 패턴"** — 존재하지만 **LiveKit은 하지 않고**(공식 주석이 `turn_servers`를 *"for clients"* 라고 못 박는다), 존재해도 **붙을 대상이 공개 지점이라 조건을 만족하지 못한다**. ⓑ **"우리가 TURN을 무료로"** — **네 겹으로 막힌다**(문제 자체를 못 풂 · Cloudflare 약관 §2.2.1(a) 대행가입 금지 · 우리 비용·신뢰경계 · NCP 정리 방향과 역행). ⓒ **`tsnet` 무설치 Tailscale** — **불성립**. Chrome이 SOCKS5 UDP를 구현하지 않아 브라우저 WebRTC가 그 경로를 탈 수 없다.

**그리고 성재 발제의 후반부 — "안 쓰는 팀은 꺼서 리소스 절약" — 은 오늘 코드로 이미 참이다**(`profiles: ["huddle"]` + 세 env fail-closed).

---

## ② 개념 해설 — TURN이 뭐고, 오픈소스인데 왜 공인 IP가 필요한가 (RQ-7)

> 성재 질문에 대한 직답 절이다. 비유를 쓰되 사실을 왜곡하지 않게 적었다.

### 2.1 NAT — 밖으로는 되는데 안으로는 안 되는 비대칭

집·회사·클라우드 VM의 기기는 대부분 **공인 주소를 직접 갖고 있지 않다.** 사설 주소(`192.168.x.x`, `10.x.x.x`, VM은 흔히 `100.64.x.x` 대역)를 쓰고, 인터넷으로 나갈 때 라우터가 자기 공인 주소로 **바꿔치기**해서 내보낸다. 이 장치를 NAT(Network Address Translation)라 한다.

핵심은 **NAT가 방향에 대해 비대칭**이라는 것이다.

- **안 → 밖**: 내가 먼저 나가면, NAT는 "이 사설 주소:포트 ↔ 이 공인 주소:포트"라는 **임시 구멍(매핑)** 을 뚫고 기억해 둔다. 응답은 그 구멍으로 돌아온다. 그래서 웹서핑·API 호출은 아무 설정 없이 된다.
- **밖 → 안**: 밖에서 먼저 두드리면, NAT에는 "이 패킷을 안쪽 누구에게 줘야 하는지"에 대한 기록이 없다. **그냥 버린다.** 그래서 공인 inbound(외부에서 먼저 거는 연결)는 포트포워딩·방화벽 규칙 같은 **명시적 설정 없이는 성립하지 않는다.**

그록봇 VM은 관리형 개발 VM이라 그 설정 권한 자체가 없다. **아웃바운드는 보장되지만(공식 문서가 static egress IP를 말한다) 인바운드 개방은 제품 기능으로 존재하지 않는다** — RA-4에서 이미 확인한 사실이다.

### 2.2 STUN / TURN / ICE — 역할 분담

WebRTC는 이 비대칭을 뚫으려고 세 가지를 쓴다.

| 이름 | 하는 일 | 비용 |
|---|---|---|
| **STUN** | "내가 밖에서는 어떤 주소로 보이지?"를 알려 주는 **거울**. 패킷을 하나 보내면 "너는 지금 `1.2.3.4:54321`로 보인다"고 답한다. 이 주소를 상대에게 알려 주면, 운이 좋으면 서로 동시에 밖으로 쏴서 양쪽 NAT에 구멍을 뚫는다(**홀펀칭**). | 사실상 **공짜** (트래픽이 거의 0) |
| **TURN** | 홀펀칭이 실패했을 때 쓰는 **중계소**. 양쪽이 각자 밖으로 나가서 TURN에 붙고, TURN이 패킷을 서로에게 **베껴서 전달**한다. | **비싸다** — 통화 트래픽 전량이 TURN을 통과하므로 대역폭이 그대로 돈이다 |
| **ICE** | 위 후보들(직결·STUN 반사·TURN 중계)을 전부 모아 **동시에 시험해 보고 되는 걸 고르는 절차**. 그래서 TURN은 "최후 수단"이다 — ICE가 더 싼 길이 있으면 그걸 먼저 쓴다. | — |

### 2.3 ★ "오픈소스라 무료"와 "인터넷에서 닿는다"는 완전히 다른 축이다

성재 질문의 급소가 여기다.

LiveKit은 Apache-2.0이고 소프트웨어 사용료가 0원이다. 그건 **"우리가 이 프로그램을 마음대로 돌려도 된다"** 는 뜻이다. 그런데 통화가 성립하려면 **참가자의 브라우저가 그 프로그램에 실제로 패킷을 보낼 수 있어야** 한다. 이건 라이선스가 아니라 **주소와 경로**의 문제다.

> 라이선스는 "이 가게를 열어도 된다"는 허가고, 공인 IP는 "손님이 찾아올 수 있는 주소"다. 허가가 공짜여도 주소가 없으면 손님은 못 온다. — 그리고 오늘 그록봇 VM은 **주소가 없는 가게**다.

### 2.4 ★★ "그럼 TURN을 우리 VM 안에 켜면 되잖아"가 왜 안 되는가

LiveKit에는 **내장 TURN 서버**가 있다(`infra/livekit.yaml:15-19`에 주석으로 막혀 있는 그 블록이다). 그래서 "그걸 켜면 되지 않나"가 자연스러운 생각이다. **안 된다. 그리고 이유는 아주 단순하다.**

**TURN 서버는 "중계소"인데, 중계소 자체가 양쪽 모두에게 도달 가능해야 한다.** 브라우저가 TURN에 붙는 것도 결국 **밖에서 안으로 거는 연결**이다. TURN을 도달 불가능한 VM 안에 켜면, 브라우저는 그 중계소에 붙을 수가 없다. 문제를 한 칸 옮겼을 뿐 아무것도 해결하지 못한다.

- 실제로 `infra/livekit.yaml`의 주석이 그 사실을 정확히 적어 두었다 — *"TURN is deferred until a public domain and TLS certificate exist"* [레포실측]. **공개 도메인과 TLS가 필요하다 = 공개 도달성이 필요하다.**
- 뒤집어 말하면: **TURN은 "클라이언트가 막혀 있을 때" 쓰는 도구지, "서버가 안 보일 때" 쓰는 도구가 아니다.** 클라이언트 쪽에 아무리 좋은 TURN을 물려 줘도, SFU가 사설 주소만 광고하면 TURN은 그 사설 주소로 패킷을 보낼 방법이 없다. (예외적으로 **SFU가 스스로 외부 TURN에 나가서 붙는** 방식이 있는데, LiveKit은 그걸 안 한다 — §RQ-2 D.)

### 2.5 HTTP 터널이 왜 미디어를 못 나르는가

지금 그록봇 VM이 외부에 보이는 유일한 방법은 터널이다(cloudflared quick tunnel). 터널이 하는 일은 **"HTTP 요청을 대신 받아서 VM 안으로 전달하고, 그 응답을 돌려주는 것"** 이다. 즉 **요청–응답이라는 모양이 정해진 트래픽의 대리인**이다.

미디어는 그 모양이 아니다.

- WebRTC 음성/영상은 **UDP 패킷 수천 개가 한 방향으로 계속 흐르는 것**이다. 요청도 응답도 아니고, 순서가 좀 뒤바뀌거나 몇 개 없어져도 그냥 진행하는 것이 **오히려 정상**이다(늦게 도착한 음성 패킷은 쓸모가 없으므로 버리는 게 낫다).
- HTTP 터널은 UDP라는 개념 자체가 없다. HTTP(그리고 그 위에 얹힌 WebSocket)만 안다.
- **TCP로 우겨넣으면?** 되긴 하는데 **TCP는 빠진 패킷을 반드시 재전송해서 순서대로 넘겨준다.** 실시간 음성에서는 이게 독이다 — 패킷 하나가 늦으면 그 뒤에 이미 도착한 패킷까지 전부 대기시킨다(**head-of-line blocking**). 결과는 끊김·지연 누적이다.

⇒ 그래서 "HTTP는 통과하는데 통화는 왜 안 되냐"의 답은 **"터널이 나르는 것은 HTTP라는 모양이지, 임의의 패킷이 아니기 때문"** 이다.

---

## ③ RQ-1 — cloudflared 터널이 실제로 나르는 것 (전제 검증)

### 3.1 내부 인터뷰의 전제는 **절반만 맞다**

인터뷰가 깔았던 전제는 *"cloudflared는 TCP만 통과시키니 미디어를 TCP로 태우면 품질이 떨어진다"* 였다. **품질 부분은 맞지만 "TCP를 통과시킨다"가 틀렸다.** 정확히는 **브라우저만 가진 사용자에게는 TCP를 아예 통과시키지 못한다.** 그래서 "품질이 떨어진다"가 아니라 **"연결 자체가 안 된다"** 가 옳은 서술이다.

### 3.2 quick tunnel이 나르는 것 = **HTTP / HTTPS / WebSocket 뿐**

[공식문서] TryCloudflare 문서가 제시하는 유일한 예시가 `cloudflared tunnel --url http://localhost:8080`이고, 다음 제약이 명문화돼 있다.
https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/

> *"Quick Tunnels are intended for testing and development only. For production use, create a remotely-managed tunnel."*
> *"Quick Tunnels are subject to a hard limit on the number of concurrent requests that can be proxied at any point in time. Currently, this limit is **200 in-flight requests**."* (초과 시 `429`)
> *"Quick Tunnels do not support Server-Sent Events (SSE)."*
> FAQ: *"We don't guarantee any SLA or uptime of TryCloudflare"*

WebSocket은 전 플랜 지원이다 — *"WebSockets are supported on all Cloudflare plans."* (https://developers.cloudflare.com/network/websockets/)

> ⚠️ **부수 발견 — 메신저 본체에 걸리는 제약**: **200 in-flight 하드 캡**. 장기 WebSocket 하나가 in-flight 하나로 계수되는지가 공식 문서에 없어 **[미확인]** 이지만, 계수된다면 **quick tunnel 셀프호스트의 동시접속 상한이 200명**이다. RA-5의 1015 rate limit과 별개의 축이므로 **터널 전략 문서에 되먹임할 값**이다.

### 3.3 named tunnel의 임의 TCP는 **클라이언트에도 cloudflared를 요구한다 — 확정**

[공식문서] 프로토콜 표가 이 리서치 전체에서 가장 결정적인 한 장이다.
https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/

| 프로토콜 | 공식 설명 | 클라이언트 요구 |
|---|---|---|
| HTTP / HTTPS | *"Proxies incoming HTTPS requests…"* | **브라우저만** |
| **TCP** | ***"Streams TCP over a WebSocket connection. End users run `cloudflared access tcp`."*** | **cloudflared 설치** |
| SSH / RDP / SMB / BASTION | 동일 | cloudflared 설치 |

`cloudflared access tcp` 문서의 전제조건도 못을 박는다 — *"The `cloudflared` daemon installed on the **host and client machines**"* / *"download and install `cloudflared` on the **client desktop that will connect to the resource**"*.
https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/cloudflared-authentication/arbitrary-tcp/

cloudflared README도 같은 말을 한다 — *"You can also use `cloudflared` to access Tunnel origins … for **TCP traffic at Layer 4 (i.e., not HTTP/websocket)**"*.

⇒ Cloudflare의 "임의 TCP"는 **TCP를 WebSocket 위에 자기들 방식으로 캡슐화한 것**이고, 그 캡슐화를 이해하는 건 `cloudflared` 바이너리뿐이다. **브라우저의 WebRTC 스택은 그 캡슐화를 모른다.** ⇒ **지시대로 "브라우저만 가진 일반 사용자에게는 무용지물"로 판정한다.**

WARP-to-Tunnel(사설망) 경로도 마찬가지다 — 최종 사용자가 *"install the Cloudflare One Client"* + Zero Trust 조직 등록을 해야 한다.

### 3.4 UDP — 공개 호스트네임으로는 **불가능**

- 프로토콜 표에 **UDP가 아예 없다.** cloudflared 이슈 #964 "Support UDP for public services"(2023-05-02 개설)는 **Closed** — 클로즈 사유는 [미확인].
- 사설망 경로에서만 UDP가 언급되고, 그것도 WARP 연결이 선행 조건이다.
- [공식문서] *"Spectrum for all TCP and UDP ports is only available on the **Enterprise plan**."*

### 3.5 ★ ICE-TCP는 HTTP 프록시를 통과할 수 없다 — **원리적 확정**

이게 RQ-1의 핵심이고, 표준 문서 두 편으로 끝난다.

- **RFC 6544 §3**: *"TCP media streams utilizing ICE use the **basic framing provided in RFC 4571**, even if the application layer protocol is not RTP."* / §7.1: *"the agent **MUST utilize the shim defined in RFC 4571**"* — https://www.rfc-editor.org/rfc/rfc6544.html
- **RFC 4571 §2**: 프레임은 **16비트 길이 필드(big-endian)로 시작**하고 그 뒤에 패킷이 온다. *"This framing method does not use frame markers."* — https://www.rfc-editor.org/rfc/rfc4571.html

⇒ LiveKit 7881로 들어오는 **첫 바이트는 `0x00 0x14` 같은 길이 접두 + STUN Binding Request(매직 쿠키 `0x2112A442`)** 다. 거기엔 **HTTP 요청줄도, Host 헤더도, TLS ClientHello(`0x16 0x03 0x01`)도 없다.**

- **HTTP 리버스 프록시(Cloudflare Tunnel)**: 라우팅에 요청줄·Host가 필요 → **파싱 실패**.
- **SNI 라우팅 L4 프록시(Tailscale Funnel `--tcp`)**: ClientHello의 SNI가 필요 → **첫 바이트가 TLS가 아님 → 실패**.

**브라우저가 HTTP 프록시를 통해 ICE-TCP를 하는 표준 메커니즘은 존재한다** — HTTP `CONNECT`다. Firefox Bug 949703(RESOLVED FIXED, FF38, *"establish WebRTC connections using an **HTTP proxy's CONNECT method**"*), Chrome 47의 `disable_non_proxied_udp`(*"won't work at all unless the application supports TURN/TCP or ICE-TCP"*). **그러나 이건 클라이언트 쪽에 설정된 forward proxy를 쓰는 것이지, 서버 쪽 리버스 프록시를 뚫는 것이 아니다.** 브라우저는 목적지가 터널 뒤에 있다는 사실 자체를 모르므로 CONNECT를 발행하지 않는다. ⇒ **본 시나리오에 무용.**

### 3.6 RQ-1 최종 판정

| 질문 | 판정 | 조건 |
|---|---|---|
| quick tunnel이 임의 TCP를 나르는가 | **불가능** (브라우저 전제) | — |
| named tunnel의 TCP가 클라 설치를 요구하는가 | **요구한다 — 확정** | 공식 문서 *"End users run `cloudflared access tcp`"* |
| 브라우저가 cloudflared 터널로 ICE-TCP를 쓸 수 있는가 | **불가능 — 원리적** | RFC 4571 프레이밍이 HTTP가 아님 |
| cloudflared로 UDP 미디어를 나를 수 있는가 | **불가능** (공개 경로) | 사설망+WARP 설치 시에만 조건부 |
| Spectrum이 우회로가 되는가 | **불가능** | 유료 플랜 전용 + 커스텀 포트는 Enterprise + *"Integrating Spectrum with Cloudflare Tunnel is only supported for HTTP/HTTPS applications"* + Spectrum은 오리진 공인 도달성을 요구해 전제와 모순 |
| WHIP/WHEP가 해결하는가 | **불가능** | RFC 9725·draft-ietf-wish-whep-04 모두 **시그널링만** 정의. ICE/DTLS/SRTP는 표준 WebRTC에 위임 ⇒ 7881·UDP 문제 그대로 |
| TURN over WebSocket이 있는가 | **없다** | 유일 문서가 draft-chenxin-behave-turn-websocket-01(2013-09, **2014-03 만료**). W3C `RTCIceServer.urls`는 RFC 7064/7065(`stun:`/`turn:`/`turns:`)만 |
| WebTransport가 통과하는가 | **불가능**(지원 목록 부재 — 명시적 부정문은 [미확인]) | 통과해도 `RTCPeerConnection` 미디어 경로가 WebTransport를 안 씀 ⇒ 무의미 |

> **약관 참고(RA-5 보정)**: Cloudflare ToS의 구 §2.8 "Limitation on Serving Non-HTML Content"는 **더 이상 존재하지 않는다**(2023-05-16 블로그 "Goodbye, section 2.8"로 폐지, 현행 ToS Last Updated 2025-09-12). 현행 제한은 **CDN 한정** 조항(*"serve video or a disproportionate percentage of pictures, audio files, or other large files"*, Service-Specific Terms Last Updated 2026-06-02)이며 **Tunnel/Zero Trust는 언급되지 않는다**. 다만 미디어가 애초에 Cloudflare를 통과하지 못하므로 **이 논쟁은 본 건에서 무의미하다.**

---

## ④ RQ-2 — 공인 inbound 없는 호스트에 WebRTC 미디어를 도달시키는 방법 전수

### 4.0 먼저, 위상 정리 (이게 전부다)

브라우저가 VM에 먼저 연결을 걸 수 없다. 그러면 남는 방법은 논리적으로 **정확히 세 가지**뿐이다.

1. **VM이 먼저 밖으로 나가서** 공개 지점에 붙고, 브라우저는 그 공개 지점에 붙는다. (→ A·D·E·F·K·L)
2. **브라우저도 VM도 같은 사설 오버레이 안으로 들어와서** 서로가 "내부"가 된다. (→ G)
3. **미디어가 VM을 아예 안 지나간다** — 브라우저끼리 직접 연결한다. (→ H·I)

**세 갈래 모두에서, 1번과 2번은 "인터넷에서 도달 가능한 지점"을 반드시 하나 요구한다.** 그 지점을 누가 소유하고 누가 돈을 내는가만 다를 뿐이다. 3번만 그 요구가 없는데, 대신 **SFU를 포기**해야 한다. 이게 이 리서치 전체의 뼈대다.

> **성재 조건에 걸리는 지점은 정확히 여기다.** 1번의 "공개 지점"이 **이미 우리가 받아들인 것**(터널 ingress)이거나 **NAT 구멍처럼 순간적으로 생기는 것**이면 조건이 안 깨진다. 그 두 경우가 각각 **K**와 **L**이고, 나머지 후보는 전부 **새 계정·새 호스트·새 비용** 중 하나를 요구한다.

### 4.1 후보 전수

| # | 경로 | 원리 | 제로 설정? | 비용 | 제3자 의존 | 품질 | oort 스택 난이도 |
|---|---|---|---|---|---|---|---|
| **A** | **외부 TURN을 클라이언트에 물리기**(Cloudflare Realtime TURN 등) | 클라가 공개 TURN에 relay 후보를 얻는다 | ❌ 계정+토큰 | 무료 1TB/월 → 이후 $0.05/GB | 상 (SaaS) | 상 (UDP relay) | **낮음** — `livekit.yaml` `turn_servers:` 한 블록. 코드 0줄 |
| **A′** | **A만 하고 SFU는 그대로 사설** | — | — | — | — | — | **❌ 성립 안 함.** §4.2 참조 — **가장 흔한 오해** |
| **B** | **터널로 ICE-TCP(7881) 통과** | HTTP 터널에 원시 TCP를 태운다 | — | — | — | — | **§RQ-1에서 판정** |
| **C** | **터널로 UDP 미디어 통과** | — | — | — | — | — | **§RQ-1에서 판정** |
| **D** | **★SFU가 밖으로 나가서 붙는 아웃바운드 relay**(SFU를 TURN 클라이언트로) | SFU가 공개 TURN에 스스로 allocation을 얻어 **relay 후보를 자기 후보로 광고** | ❌ 계정+토큰 | A와 동일(트래픽 2배 — 업+다운 모두 relay) | 상 | 중~상 | **불가 — LiveKit이 지원하지 않는다.** §4.3 |
| **E** | **UDP 리버스 터널**(frp / rathole) | 공인 VPS에 에이전트가 붙어 UDP 포트 범위를 밖으로 투사 + LiveKit `node_ip`로 그 주소 광고 | ❌ VPS 필요 | VPS 월 $4~6 | 중 (VPS 임차) | 상 (UDP 유지) | **중** — 새 컴포넌트 1개 + LiveKit `node_ip` 설정 |
| **F** | **클라우드 SFU로 교체**(Cloudflare Realtime SFU / LiveKit Cloud) | 미디어가 VM을 아예 안 지난다. VM은 제어평면만 | ❌ 계정+토큰 | CF: 무료 1TB/월(TURN과 **합산**) → $0.05/GB | 상 | 상 | **가장 낮음** — `MOMO_LIVEKIT_URL` 교체 + CSP 한 줄. **코드 0줄** |
| **G** | **★메시 VPN(Tailscale 등)으로 참가자와 VM을 같은 오버레이에** | 브라우저가 VM의 `100.x` 주소에 **직접** 닿는다. 공인 IP도 TURN도 불필요 | ❌ 참가자 1회 설치 | **무료**(Personal 6인) | 중 (control plane + DERP) | 직결이면 상 / DERP 폴백이면 저대역 | **중** — §RQ-6 |
| **H** | **P2P 직결**(SFU 미사용, 1:1 한정) | 브라우저끼리 홀펀칭 | ✅ (STUN만) | 무료 | 하 (공개 STUN만) | 직결이면 최상 / 실패 시 **연결 불가** | **높음** — LiveKit에 mesh 모드가 없다. 별도 구현 |
| **I** | **미디어를 WebRTC가 아닌 WebSocket으로**(터널이 이미 나르는 것만 씀) | 브라우저에서 Opus 인코딩(WebCodecs) → WS로 서버 → 팬아웃 | ✅ | 무료 | **없음** | 낮음 — 혼잡제어·NACK·FEC·지터버퍼를 전부 자작 | **매우 높음** — SFU 재발명 |
| **J** | **공인 IP 호스트 임차**(현행 NCP `momo-turn` 모델) | 그냥 주소를 산다 | ❌ | 월 실비 | 없음(우리 소유) | 상 | 낮음 — 이미 런북 존재 |
| **K** | **★터널로 `turns:`(TURN over TLS) 통과 — TURN은 VM 안에** | ICE-TCP·UDP는 못 지나가도 **TURNS는 진짜 TLS라 SNI가 있다** ⇒ Funnel의 SNI 라우팅 TCP 모드를 통과할 수 있다 | **✅ 사용자 동작 0** | **0원** | **없음**(이미 채택된 터널) | 중 — TCP relay | **낮음** — `livekit.yaml` turn 블록 + funnel 1줄. 🧪 **§7.4·§12.2 = 본문 P1** |
| **L** | **★SFU 홀펀칭**(`use_external_ip`) | VM이 스스로 NAT에 구멍을 뚫어 srflx를 광고 | **✅** | **0원** | **없음**(공개 STUN만) | **최상**(UDP 직결) | **낮음** — `livekit.yaml` 1줄. 🧪 **§4.4 = 본문 P0** |

### 4.2 ★ A′가 왜 성립하지 않는가 — 가장 흔한 오해를 못 박는다

"클라이언트에 좋은 TURN을 물려 주면 되지 않나"는 **틀렸다.** TURN의 동작을 정확히 보면 이유가 나온다.

- TURN allocation은 **allocation을 요청한 쪽**에게 공개 relay 주소를 준다. 상대(peer)는 그 relay 주소로 패킷을 보내고, TURN이 요청자에게 전달한다.
- 그런데 TURN은 **permission** 을 요구한다 — 요청자가 "이 peer IP에서 오는 패킷만 받겠다"고 등록해야 한다. 등록 대상은 **상대가 광고한 후보의 IP**다.
- SFU가 `172.18.0.x`(도커 사설) 또는 `10.x`만 광고하면, 클라는 그 주소로 permission을 걸고 그 주소로 쏜다. TURN 서버가 사설 주소로 라우팅할 방법은 **없다.** 끝.
- 반대 방향도 막힌다. SFU가 클라의 relay 주소로 쏘면, TURN에 도착하는 패킷의 **소스 IP는 SFU의 NAT 매핑 공인 IP**인데 클라가 등록한 permission은 사설 IP다 → **드롭**.
- **유일한 탈출구는 SFU가 자기 공인 매핑 주소(srflx)를 광고하는 것**이다. 그러려면 ①`use_external_ip: true`로 STUN을 켜고 ②NAT가 symmetric이 아니어야 하고 ③Docker 브리지가 소스포트를 보존해야 한다. — 이게 §4.4의 "홀펀칭 경로"이고, 우리는 ①이 꺼져 있고 ②는 안 재 봤다(§RQ-4).

⇒ **"무료 TURN만 물리면 된다"는 지금 우리 구성에서 반드시 실패한다.** 성재가 기대했던 "우리가 TURN을 무료로 해 주는 것"도 **이 문제를 풀지 못한다** — 그건 클라이언트 문제를 푸는 도구지 서버 도달성 문제를 푸는 도구가 아니다.

### 4.3 ★ RQ-2의 지정 질문 — "SFU가 밖으로 나가서 붙는" 패턴은 존재하는가

**존재한다. 그러나 ⓐLiveKit은 그걸 안 하고, ⓑ존재하더라도 성재 조건을 만족시키지 못한다.**

**ⓐ 존재 여부 — 존재한다.** 서버가 ICE 후보를 모을 때 자기도 TURN 클라이언트가 되어 relay 후보를 만드는 것은 표준 ICE 안에 있는 동작이다. **Janus WebRTC Gateway가 실제로 그렇게 한다** — `[nat]` 섹션의 `turn_server`/`turn_port`/`turn_user`/`turn_pwd`를 설정하면 *"Janus 자신이 relay 후보를 gathering"* 한다 [커뮤니티 — meetecho-janus 그룹 다수]. 반대로 **mediasoup·Jitsi Videobridge는 ICE-Lite라 구조적으로 불가능**하다(ICE-Lite 엔드포인트는 host 후보만 내놓고 연결성 검사를 시작하지 않는다).

**ⓑ LiveKit은 안 한다 — 확정.**

- 공식 `config-sample.yaml`의 해당 키 주석이 그대로 말한다: **`# optional TURN servers for clients. This isn't necessary if using embedded TURN server (see below).`** — **"for clients"**. [공식문서/소스코드]
  https://github.com/livekit/livekit/blob/master/config-sample.yaml
- 사용자 보고도 일치한다 — *"Livekit does not use configured TURN server"*, 핸드셰이크에서 **내부 host IP만** 보낸다(이슈 #3971, `not planned`로 종결·메인테이너 설명 없음). https://github.com/livekit/livekit/issues/3971
- 예외적으로 turn_servers를 **STUN 바인딩 용도로는 쓴다** — 그래서 `use_external_ip: false`인데도 NAT 게이트웨이 공인 IP가 **srflx로 새는** 버그가 보고됐다(이슈 #4095, 2025-11-21). https://github.com/livekit/livekit/issues/4095 ⇒ **srflx는 만들지만 relay는 안 만든다**는 뜻이고, 이건 §4.4의 홀펀칭 경로에 대한 **긍정 신호**이기도 하다.
- 우리 정책상 Janus는 애초에 **GPL-3라 금지 대상**이다(ADR-0122 §3이 명시). 즉 "SFU를 TURN 클라이언트로 만드는" 경로를 쓰려면 백본을 갈아야 하는데 permissive 제약에서 갈 곳이 없다.

**ⓒ 그리고 결정적으로 — 존재해도 성재 조건을 못 만족한다.** SFU가 밖으로 나가서 붙는다는 것은 **붙을 대상(공개 TURN)이 있다는 뜻**이다. VM 자체 완결이 아니라 **"제3자 의존을 SFU 쪽으로 옮긴 것"** 이다. 성재가 이 패턴에 걸었던 기대 — "존재하면 우리 조건을 유일하게 만족한다" — 는 **성립하지 않는다.** 원리상 그럴 수가 없다(§4.0).

### 4.4 ★ 조건을 하나도 안 깨는 유일한 후보 — SFU 홀펀칭 (L)

전수 조사에서 위 목록에 안 들어간 것이 하나 있는데, **가장 값싸고 가장 안 재 봤다.**

- **원리**: SFU도 NAT 뒤의 한 endpoint일 뿐이다. `use_external_ip: true`를 켜면 LiveKit이 부팅 시 STUN으로 자기 공인 매핑을 알아내 **srflx 후보를 광고**한다. 브라우저가 그 주소로 쏘고 LiveKit도 동시에 브라우저로 쏘면 **양쪽 NAT에 구멍이 뚫린다.** 포트포워딩도 TURN도 공인 IP 소유도 필요 없다.
- **제로 설정**: ✅ (에이전트가 `livekit.yaml` 한 줄 켜면 끝, 사용자 동작 0)
- **비용**: **0원**. 제3자는 공개 STUN 하나뿐이고 트래픽이 사실상 0이다(`stun.cloudflare.com`은 공식적으로 무료·무제한이라고 문서에 적혀 있다 — §RQ-3).
- **성재 조건 충족도**: 세 조건을 **전부** 만족한다. 이 리서치에서 **유일하다.**
- **그런데 왜 권고 1번이 아닌가**: 세 개의 관문이 있고 셋 다 **안 재 봤다**.
  - L1. VM의 **UDP 아웃바운드**가 열려 있어야 한다.
  - L2. VM의 NAT가 **symmetric이 아니어야** 한다. — **여기가 급소.** 같은 클래스의 자사 substrate(CubeSandbox microVM)가 **symmetric이었다**는 실측 전례가 있다(`docs/runbooks/turn-host-install.md:6-9`). 그래서 우리는 이미 그것 때문에 **공인 coturn 1대를 세운 적이 있다.**
  - L3. Docker **bridge 네트워크가 소스포트를 보존**해야 한다. LiveKit 배포 관행이 `network_mode: host`를 권하는 이유가 정확히 이것이다.
- **판정**: **🧪[실측필요]**. 성공 확률은 낮다고 본다(L2 전례 때문에). 그러나 **실측 비용이 1분**이고, 성공하면 성재 조건을 그대로 만족하는 유일한 길이므로 **다른 무엇보다 먼저 재야 한다.** 실패하면 그 실패 자체가 "왜 공인 지점이 필요한가"의 결정적 근거가 되어 성재에게 설명이 끝난다.

---

## ⑤ RQ-3 — TURN-as-a-Service 무료 티어 실사

> **읽기 전 경고**: 이 절의 모든 무료 티어는 **§4.2 때문에 우리 문제를 단독으로 풀지 못한다.** TURN은 **클라이언트가 막혔을 때** 쓰는 도구지 **서버가 안 보일 때** 쓰는 도구가 아니다. 아래는 **P0(SFU 홀펀칭)이 성공했을 때의 보완재**, 또는 **P3(클라우드 SFU)의 부속물**로서의 가치로 읽어야 한다.

### 5.1 Cloudflare Realtime TURN — 성재가 들은 정보는 사실이고, 단가는 시장 최저다

| 항목 | 사실 | 출처 (Last updated) |
|---|---|---|
| 단가 | *"Cloudflare Realtime SFU and TURN services cost **$0.05 per GB** of data egress."* | /realtime/sfu/pricing/ (2026-04-21) |
| **무료 한도** | *"There is a free tier of **1,000 GB** before any charges start."* · *"Each account gets 1,000GB/**month**"* · 클라→CF 방향(inbound)은 항상 무료 | /realtime/sfu/pricing/ · /realtime/sfu/limits/ (2026-08-13) |
| **★합산** | *"This free tier includes usage from **both SFU and TURN services, not two independent free tiers**."* | 같은 문서 |
| "SFU와 함께 쓰면 무료"의 정확한 뜻 | **"무료"가 아니라 "이중과금 안 함"이다** — *"Traffic between … TURN and … SFU … **does not get double charged**, so if you are using both … you will get charged for only one."* TURN 단독 릴레이는 정상 과금 | /realtime/sfu/pricing/ · FAQ (2026-07-14) |
| **신용카드** | **공식 문서에 명문 없음 [미확인].** 그러나 FAQ가 self-serve를 *"(**pay with your credit card**)"* 로 부르고, 커뮤니티 기능요청(2025-10-12)이 *"setting it up **requires a credit card/billing setup**"* 라고 제목까지 달았다(요청자 유즈케이스가 **오픈소스 FOSS 앱 배포**로 우리와 동일). **카드 필요로 계획하되 미확인 표기 유지** | community.cloudflare.com/t/no-cc-turn-free-tier/846152 [커뮤니티] |
| 크레덴셜 발급 | **2단계.** ①`POST /accounts/{id}/calls/turn_keys` 로 TURN key(계정당 최대 1,000개) ②`POST https://rtc.live.cloudflare.com/v1/turn/keys/{id}/credentials/generate-ice-servers` 로 단기 크레덴셜 **무제한**. *"There is no limit to how many end-user credentials you can create"* · **revoke API 보유**(경쟁사에 없음) | /realtime/turn/generate-credentials/ · /replacing-existing/ |
| TTL | FAQ는 **최대 48시간** 이라고 두 번 명시. 그런데 다른 페이지 예제가 `ttl: 864000`(10일)을 쓴다 — **문서 내 모순 [미확인]. 48h를 상한으로 설계할 것** | FAQ vs /replacing-existing/ |
| 프로토콜 | UDP 3478·53 / TCP 3478·80 / **TLS(`turns:`) 5349·443** — 정식 `turns:` 스킴 발급. **실측 확인**: TLS 1.3, `CN=turn.cloudflare.com` | /realtime/turn/ + 병렬 스레드 실측 |
| 제약 | **RFC 6062(TCP relaying) 미지원** · **IPv6 relay 주소 미발급**(클라↔서버는 IPv6 가능) · allocation당 >5~10 kpps / >50~100 Mbps 초과 시 드롭(**계정 단위가 아니라 allocation 단위**) · 중국 제외 | /realtime/turn/rfc-matrix/ |
| **무료 STUN** | *"Cloudflare's STUN service at `stun.cloudflare.com` is **free and unlimited**."* **실측: 계정·크레덴셜 없이 Binding Success 확인**(3478·53 모두) ⇒ **P0(홀펀칭)에 필요한 것은 이게 전부이고, 마찰이 0이다** | FAQ + 실측 |

**★ 카드 없는 우회로 하나**: Hugging Face가 HF Access Token만으로 Cloudflare TURN **10GB/월을 카드 없이** 중계해 준다 — *"10GB of data for FREE every month **without a credit card**"* (https://huggingface.co/blog/fastrtc-cloudflare, 2025-04-09). 프로덕션엔 부족하지만 **데모·개발·"카드 없는 셀프호스터" 폴백**으로는 유효하다.

### 5.2 제공자 비교표

| | **Cloudflare Realtime** | **Twilio NTS** | **Xirsys** | **Metered** | **ExpressTURN** |
|---|---|---|---|---|---|
| 무료 TURN | **1,000 GB/월** (SFU와 **공유**) | **없음** (STUN만 무료) | **500 MB/월** (30일 트라이얼 후) | 20GB 또는 500MB — **문서 불일치 [미확인]** | **1,000 GB/월** |
| 신용카드 | 사실상 필요 [미확인] | 트라이얼은 **불요**(명문) | [미확인] | [미확인] | 유료만 |
| 유료 단가 | **$0.05/GB** | **$0.40~0.80/GB**(지역별) | $0.09~0.50/GB | $0.10~0.40/GB | $9/월 5TB (≈**$0.0018/GB**) |
| ephemeral REST | ✅ ttl≤48h + **revoke** | ✅ Ttl≤24h | ✅ expire≤6h | ✅ | **❌ 무료 불가**(Premium만) |
| `turns:` TLS 443 | ✅ 443·5349 | ⚠️ 포트는 TLS인데 **API가 `turn:` 스킴을 발급** [미확인 — 수동 구성 실측 필요] | ✅ 443·5349 | ✅ | 유료만 |
| **대행 발급 약관** | **명시적 금지**(§5.3) | 금지 문언 존재 | 금지 조항 없음 | 금지 조항 없음 **+ 기능으로 지원** | 조항 자체 없음 |

**개별 실사 요점**
- **Twilio**: 2026년에도 서비스 중이나 **무료 티어가 없고 단가가 Cloudflare의 8~16배**다. 경제적으로 무의미. 게다가 Token API가 `turn:global.turn.twilio.com:443?transport=tcp` 를 반환해 **`turns:` 스킴이 아니다** — 브라우저 TURN-over-TLS에 그대로 못 쓴다 [미확인 — 수동 구성 시 동작 여부].
- **Xirsys**: 30일 전체기능 트라이얼 뒤 *"Unlimited STUN and **500 MB of TURN relay bandwidth per month**"*, 그리고 *"the TURN allowance is a **hard cap**"* — 초과 시 *"TURN relay **stops functioning**"*. **메신저 프로덕션에 무의미한 크기다.**
- **Metered / Open Relay**: 무료 한도가 페이지마다 20GB↔500MB로 갈린다 [미확인]. **생존성 실측(2026-08-26)**: `openrelay.metered.ca`는 **살아 있으나 상용 relay(`standard.relay.metered.ca`)의 별칭으로 흡수**됐고(UDP 3478 Allocate → `401 realm='metered.ca'`), 과거 가이드에 널리 쓰이던 **`staticauth.openrelay.metered.ca`는 응답하지 않는다(죽음)**. 그 호스트를 하드코딩한 설정은 이미 깨져 있다.
- **ExpressTURN**: 무료 1TB는 사실이나 **포트 3478 TCP/UDP만(TLS 443 불가)** 이고 **무료에서는 shared-secret/ephemeral 인증 자체가 불가**하다 — 고정 크레덴셜만 ⇒ **셀프호스팅 메신저에 부적합.** Premium $9/월은 GB당 최저가지만 발급이 자체 HMAC 방식이다.
- **폐업 확인**: Subspace/GlobalTURN은 **2022-05 사업 종료**. STUNner는 SaaS가 아니라 K8s용 오픈소스다. `turn.elixir-webrtc.org`는 README가 *"**DO NOT use this deployment in production**"* 이라고 못 박는다.
- **Google STUN(`stun.l.google.com:19302`)**: 응답은 하지만 **공식 정책·약관·SLA 문서가 없다 [미확인]** ⇒ 프로덕션 의존 비권장. **Cloudflare STUN이 명문 보증이 있으므로 그쪽을 쓴다.**

### 5.3 ★★ "셀프호스터가 스스로 발급" vs "우리가 대신 발급" — **약관이 답을 정해 준다**

| 모델 | 판정 | 근거 |
|---|---|---|
| **ⓐ 셀프호스터가 자기 계정으로 발급해 자기 env에 넣는다** | **✅ 문제 없음. 이것을 기본값으로 한다** | 표준 사용. 제한 조항 어디에도 안 걸린다 |
| **ⓑ 우리가 계정 하나로 전 셀프호스터에게 대행 발급한다** | **❌ Cloudflare 약관 문언상 금지** | 아래 |

**Cloudflare Self-Serve Subscription Agreement §2.2.1 (Last Updated 2025-09-12)** [공식문서] https://www.cloudflare.com/terms/ :
> *"you will not and you have no right to: **(a) rent, lease, loan, export, or sell access to the Services to any third party, or sign up for the Services on behalf of a third party;** … (c) access or use the Services in a manner that violates or is intended to **circumvent Service-specific usage limits, quotas**, or other restrictions"*

**Service-Specific Terms – Developer Platform (Last updated 2026-06-02)**, "Cloudflare Realtime":
> *"you may use Cloudflare Realtime … to enable video call functionality **for your Internet Properties**."*

세 곳에 동시에 걸린다 — ①*"sign up … on behalf of a third party"* 가 대행 발급을 직접 지목 ②독립 셀프호스터는 우리의 End User가 아니라 **third party** ③1,000GB 무료 한도를 다수에게 분배하는 것은 *"circumvent … quotas"* 소지.

**⚠️ 반대 증거도 정직하게 적는다.** Cloudflare 자체 문서에 *"If you are an existing TURN provider but would like to switch to **providing Cloudflare Realtime TURN for your customers**"* 라는 페이지가 있고, **"How to bill end users for their TURN usage"** 절까지 있다(/realtime/turn/replacing-existing/). ⇒ **Cloudflare가 허용하는 것은 "당신이 서비스 제공자이고 그들이 당신 서비스의 end user인 관계"** 다. **오픈소스 셀프호스터는 그 관계가 아니다** — 자기 서버·자기 사용자·자기 도메인으로 독립 운영한다. 이 차이가 §2.2.1(a)의 "third party" 해당 여부를 가른다.
탈출구는 하나 있다 — §2.2.1 서두가 *"Unless otherwise **expressly permitted in writing** by Cloudflare"* 다. 정말 필요하면 **서면 확인**을 받는 경로가 존재한다.

**타 벤더**: **Twilio**도 금지 문언이 있다 — *"not transfer, resell, lease, license, or otherwise make available the Services to third parties … **or offer them on a standalone basis**"*(ToS §2.2, Last Updated 2026-07-16). TURN만 떼어 주는 것이 정확히 그 형태다. 반면 **Xirsys**(ToS 2025-09-16)와 **Metered**(ToS 2021-07-27)에는 재판매 금지 조항이 **없고**, 특히 Metered는 *"Per-project bandwidth quotas (e.g., 10GB for Customer A, 50GB for Customer B)"* 를 **공식 기능으로 광고**한다. 즉 **중앙 발급이 꼭 필요하다면 Metered가 유일하게 자연스러운 선택**이나, ToS가 5년 전 판이라 서면 확인이 필요하다.

⇒ **성재가 기대했던 "우리가 무료로 해 주는 것"은 ①1순위 벤더의 약관이 문언상 금지하고 ②우리 비용·우리 신뢰 경계가 되며 ③지금 `momo-turn`을 내리자는 NCP 판정과 정반대 방향이고 ④§4.2 때문에 그렇게 해도 허들이 안 된다.** 네 가지 중 어느 하나만으로도 기각 사유다.

### 5.4 자체 호스팅 TURN 라이선스 — **AGPL은 하나도 없다** (LICENSE 원문 확인)

| 소프트웨어 | SPDX | 판정 |
|---|---|---|
| **LiveKit**(내장 TURN 포함) | **Apache-2.0** | ✅ **이미 스택 안에 있다. 추가 의존 0.** P1이 이걸 쓴다 |
| **coturn** | **BSD-3-Clause** (Copyright Citrix Systems) | ✅ 현행 `momo-turn` 호스트가 쓰는 것 |
| **eturnal** | **Apache-2.0** | ✅ |
| **pion/turn** | **MIT** | ✅ |

**⇒ "AGPL 백본 금지" 정책과 충돌하는 TURN 후보는 없다.** (그 정책에 걸리는 건 TURN이 아니라 **SFU 쪽 Janus(GPL-3)** 이고, ADR-0122가 이미 배제했다.)

**★ 그리고 셀프호스트 TURN은 외부 API가 아예 필요 없다.** coturn은 **TURN REST API를 내장**한다 — `--use-auth-secret` 을 켜면 크레덴셜이 `username = "timestamp:user"`, `password = base64(hmac(username, shared-secret))` 로 **백엔드가 HMAC만 계산하면 끝**이다(coturn `README.turnserver`). 외부 호출 0회·벤더 장애 무관·쿼터 무관. **Matrix Synapse가 coturn·eturnal 둘 다 이 방식으로 공식 문서화**하고 있다(element-hq.github.io/synapse/latest/setup/turn/coturn.html). ⇒ **"TURN을 붙인다"가 곧 "SaaS에 의존한다"는 뜻은 아니다.** 도달 가능한 호스트만 있으면 자립한다 — 그리고 그 "도달 가능한 호스트"가 우리에게 없다는 것이 이 리서치 전체의 문제다.

---

## ⑥ RQ-4 — 그록봇 VM의 실제 네트워크 능력

### 6.1 공인 inbound

| 항목 | 상태 | 근거 |
|---|---|---|
| 공인 inbound 포트 개방 | **없다. 제품 기능으로 존재하지 않는다** | Grok Bot 공식 문서에 아웃바운드(static egress IP)만 있고 **인바운드 언급이 전무**하다 — RA-4 §113-116에서 확인. 우리 실측도 "공인 inbound 없음"(`docs/SELF_HOST_AGENT.md:271`) [레포실측]+[공식문서] |
| egress IP | Cloudflare 대역의 **static/datacenter IP**(실측 `104.30.175.37`) | RA-4 [실측] |
| 공식 우회로 | **문서화된 것 없음.** 문서가 권하는 건 오히려 반대 방향 — *"connect to private networks with Tailscale or a similar client"*(RA-4:170) | [공식문서] |

> ★ **주목**: 그록봇 공식 문서가 스스로 **Tailscale을 언급**한다. VM에서 사설망으로 **나가는** 용도로 적힌 문장이지만, 오버레이 네트워크 클라이언트를 VM 안에서 돌리는 것이 **제품이 상정한 사용법 안에 있다**는 신호다. RQ-6 경로의 환경 적합성 근거가 된다.

### 6.2 UDP 아웃바운드 — **미확인. 그리고 이게 가장 값싼 다음 실측이다**

문서로 확정할 수 없다. 다음 세 가지가 전부 별개의 질문이고, 셋 다 아직 안 재 봤다.

| 질문 | 왜 중요한가 | 실측 방법 (VM 안에서 1분) |
|---|---|---|
| **Q1. UDP 아웃바운드가 열려 있는가** | 막혀 있으면 외부 TURN over UDP·Tailscale 직결·홀펀칭이 **전부 한 번에 죽는다**. TURN over TLS/443(TCP)만 남는다 | `nc -u -w2 stun.cloudflare.com 3478 </dev/null` 로는 부족 — STUN 바인딩 요청을 실제로 보내야 한다. `python3 -c` 로 STUN Binding Request 20바이트 전송 후 응답 수신, 또는 `stunclient stun.cloudflare.com 3478`(`stuntman-client` 패키지) |
| **Q2. NAT 타입이 무엇인가 (cone / symmetric)** | symmetric이면 srflx 후보가 무용지물 → **홀펀칭 경로 전멸**, Tailscale도 직결 실패해 DERP로 폴백 | `stunclient --mode full stun.cloudflare.com` 또는 `pystun3`. **두 개의 서로 다른 STUN 서버에 물어 매핑 포트가 같은지** 보는 것이 판정의 핵심 |
| **Q3. UDP 443이 열려 있는가** | TURN over UDP/443은 방화벽을 가장 잘 통과하는 조합. QUIC/HTTP3와 같은 포트라 열려 있을 개연이 있다 | 위 STUN 프로브를 3478 대신 443으로 |

**사전 확률(추정, 근거 있음)**: 이 레포에 **같은 클래스의 실측 전례**가 있다 — CubeSandbox microVM에 대해 런북이 *"CubeSandbox microVM의 NAT이 symmetric이고 host/srflx 후보로는 P2P가 성립하지 않는다"*(`docs/runbooks/turn-host-install.md:6-9`)고 적어 두었고, 그 때문에 **공인 coturn 호스트 1대를 따로 세웠다**. 관리형 마이크로VM/컨테이너 substrate는 symmetric NAT인 경우가 흔하다. ⇒ **Q2는 symmetric일 개연이 높다**고 보고 계획을 세우되, 값싸니까 반드시 재라. [추정 — 근거: 자사 동종 substrate 실측]

### 6.3 우리 쪽 스택이 추가로 거는 제약 (실측)

VM 밖을 재기 전에, VM **안**에서 이미 막혀 있는 것들이 있다. 이건 전부 우리 파일이므로 확정이다.

| # | 제약 | 파일:줄 | 영향 |
|---|---|---|---|
| C1 | LiveKit signalling 7880 · RTC TCP 7881이 **`127.0.0.1` 바인드** | `infra/rust/docker-compose.rust.yml:133-134` | 같은 머신 밖에서는 어떤 경로로도 안 보인다. tailnet 경로를 쓰려면 여기부터 바꿔야 한다 |
| C2 | 미디어 UDP 50000-50100만 `0.0.0.0` 바인드 | `:135` | 바인드는 돼 있으나 **Docker 포트 매핑(bridge)** 이므로 아웃바운드 소스포트가 보존되는지 별개 문제 — LiveKit 공식 배포 권고는 `network_mode: host`다 [커뮤니티 다수] |
| C3 | **`use_external_ip` 기본값 = `false`**, 그리고 `infra/livekit.yaml`이 이 키를 **설정하지 않는다** | `pkg/config/config.go`의 `DefaultConfig`에 `UseExternalIP: false` [소스코드] + `infra/livekit.yaml` 전문 [레포실측] | 지금 LiveKit은 **srflx 후보를 아예 만들지 않는다.** 홀펀칭을 시험조차 하지 않는 상태 |
| C4 | 내장 TURN 블록 전체가 주석 | `infra/livekit.yaml:15-19` | TURN 부재 |
| C5 | 엣지 CSP `connect-src`가 **하드코딩 allowlist** | `infra/rust/Caddyfile.local:57` · `infra/rust/Caddyfile:109` | LiveKit endpoint가 로컬 레일 밖 주소가 되는 순간 **브라우저가 WebSocket을 차단**한다. 어느 경로를 고르든 이 한 줄은 반드시 바뀐다 |
| C6 | `MOMO_LIVEKIT_URL`은 임의 http/https/ws/wss 수용 + join 응답에 **verbatim 광고** | `server-rust/bins/momo-server/src/config.rs:137-154` · `routes/huddles.rs:133` | **유리한 제약.** 어느 경로를 고르든 **서버 Rust 코드는 0줄** 바꾸면 된다 |
| C7 | 웹 클라가 `new Room({adaptiveStream:false, dynacast:false})` 만 쓰고 `rtcConfig`/ICE 서버를 **주입하지 않는다** | `clients/web/src/features/huddles/huddleRuntime.ts:52` [레포실측] | ICE 서버는 LiveKit 서버가 JoinResponse로 내려주는 값이 전부다 ⇒ **외부 TURN을 클라에 물리는 일도 `livekit.yaml` 한 파일로 끝난다. 클라 코드 0줄** |
| C8 | 허들 v0은 **오디오 전용** | `connectHuddleAudio` / `setMicrophoneEnabled` 만 존재 [레포실측] | **대역폭 산정이 완전히 달라진다** — Opus 음성은 참가자당 대략 24~40 kbps다. 15명이라도 SFU 하행 합계가 1 Mbps 언저리다. 저대역 릴레이(§RQ-6 DERP)로도 감당된다는 뜻 |

⇒ **C6·C7·C8은 우리에게 유리한 사실이다.** 어떤 경로를 채택하든 **서버·클라 코드 변경은 0줄**이고, 바뀌는 것은 `livekit.yaml` · compose 바인드 · CSP 한 줄 · env 뿐이다. 그리고 **오디오 전용이라 필요 대역폭이 작다.**

---

## ⑦ RQ-6 — Tailscale 전면 조사 (성재 지정)

> 먼저 **두 기능을 절대 섞지 마라.** 이름이 비슷해 계속 혼동되는데, 허들에 관해서는 **정반대 답**을 낸다.
>
> | | **Funnel** | **tailnet 내부** |
> |---|---|---|
> | 대상 | **공개 인터넷 아무나** | **tailnet 멤버만** |
> | 프로토콜 | **TLS 위에서만**, 포트 443/8443/10000 | **전 프로토콜·전 포트**(UDP 포함) |
> | 클라이언트 설치 | **불필요** | **필요** |
> | 허들에서의 쓸모 | **TURNS 우회 통로**(→ 본문 P1) | **직결 경로**(→ 본문 P2) |

### 7.1 동작 원리 (확정 — 공식문서)

- 각 노드에 **`100.64.0.0/10`(CGNAT, RFC 6598) 주소**를 준다. 사유: *"They don't conflict with IP addresses from subnets commonly used for private networks"* https://tailscale.com/kb/1015/100.x-addresses (갱신 2026-01-12)
- 컨트롤 플레인은 키·노드 목록만 배포한다 — *"The so-called 'control plane' is hub and spoke, but that doesn't matter because it **carries virtually no traffic**."* 데이터는 노드 간 **WireGuard over UDP**. https://tailscale.com/blog/how-tailscale-works
- Tailscale 자신이 이 구조를 WebRTC에 빗대 설명한다 — *"Tailscale uses several very advanced techniques, based on the Internet **STUN and ICE** standards"*.
- **직결 성공률(공식 실측)**: *"Internal metrics have indicated success rates for direct NAT traversal **well north of 90%** in typical conditions."* 실패 조합도 명시 — *"Two devices, each behind '**hard NAT**,' will almost always need to use a relay"* / *"two mobile devices … from different cellular networks, there's a good chance they'll have to use DERP."* https://tailscale.com/blog/nat-traversal-improvements-pt-1 (2025-10-15)

### 7.2 ★ DERP는 "사실상 무료 TURN"인가 — **Tailscale이 스스로 그렇다고 쓴다**

[공식문서] https://tailscale.com/blog/how-tailscale-works :
> *"DERP (Designated Encrypted Relay for Packets) servers **fill the same role as TURN servers**, except they use HTTPS streams and WireGuard keys instead of the obsolete TURN recommendations"*
> *"there is never a way for a DERP server to decrypt your traffic."*

| 질문 | 답 | 근거 |
|---|---|---|
| **전송 프로토콜** | **TCP/TLS 443.** *"Because DERP traffic is carried over **HTTPS (TCP port 443)** by design, it will succeed even when direct UDP is filtered, **at the cost of higher latency**."* UDP 3478은 **STUN 전용**이고 릴레이 데이터는 UDP로 안 나른다 | nat-traversal-improvements-pt-1 · `cmd/derper` godoc [공식문서+소스코드] |
| **UDP 미디어를 나르는가** | **나른다 — WireGuard로 캡슐화된 채, TCP 위로.** ⇒ **head-of-line blocking이 실재한다.** Tailscale 자신의 표현: *"DERP is essentially a **TCP-based relay** (operating over TLS, often on port 443)"* / 손실 시 *"TCP will introduce **retransmission delays** that wouldn't affect a pure UDP tunnel as much"* | nat-traversal-improvements-pt3 (2025-10-24) [공식문서] |
| **대역폭 제한** | **명시적으로 제한한다.** *"**DERP servers also limit throughput to ensure fairness** between everyone using the DERP server."* / *"DERP servers enforce **rate limits and fair usage policies** that can throttle throughput"* / *"it **isn't optimized for high performance**"*. `cmd/derper`에 `-accept-connection-limit`·`-rate-config` 플래그 실존 | kb/1638 · kb/1257 · 소스코드 [공식문서+소스코드] |
| **수치** | **미공개 [미확인].** 자사 블로그 실측(델리↔미네소타) **2.2 Mbit/s**. Peer Relay는 27~35 Mbit/s = **12.5배** | peer-relays-international-networks |
| **약관** | AUP에 미디어 중계 금지 조항 **없음**. 유일한 접점은 *"creating an **undue burden** on the Tailscale Solution or the networks"* | https://tailscale.com/tailscale-aup (갱신 2025-06-30) |

**⇒ 판정: DERP는 기능적으로 무료 TURN이 맞다. 그러나 Tailscale이 스스로 throughput을 제한한다고 명문화했으므로, DERP를 상시 미디어 릴레이로 전제한 설계는 품질상 성립하지 않는다.** 간헐적 폴백으로는 괜찮고, 그것이 Tailscale이 의도한 용법이다.

**자체 DERP는 우리 문제를 못 푼다** — 공식 요건이 *"must not be behind NAT devices"* · *"a domain name pointing at your server"* · *"Addresses must be **publicly routable**"* 다. https://tailscale.com/kb/1118/custom-derp-servers [공식문서]

**Peer Relay도 못 푼다** — 무료 플랜 포함 전 플랜 제공이지만(가격표 실측), *"another device in the same tailnet"* 을 요구한다. 랩탑↔VM 2노드에는 중계할 제3자가 없고, **inbound 없는 우리 VM은 스스로 릴레이가 될 수 없다**(요건: *"This port must be accessible from other devices in the tailnet"*).

### 7.3 무료 티어와 약관

| 항목 | 문면 (2026-08-26 실측) | 출처 |
|---|---|---|
| Personal | **$0 Free forever** · **Up to 6 users** · **Unlimited user devices** · ACL 그룹 3 · tagged 50 · ephemeral 1,000분/월 | https://tailscale.com/pricing |
| 상위 | Standard **$8**/user/mo · Premium **$18** · Enterprise 커스텀 | 같은 페이지 |
| **상업 사용** | *"only suitable for **non-commercial use** of Tailscale"* · *"the Personal plan is **not intended for commercial use**"* | 같은 FAQ |
| **강제 메커니즘** | 조항이 아니라 **도메인 자동 분류**다 — *"If you create a tailnet with a **custom domain, it's considered business use**, and you'll be automatically enrolled in a free trial"* · *"the Tailscale account is owned by the company … **regardless of which plan you are on**"* | 같은 FAQ |
| ToS §2.3 | *"**commercially exploit** any part of the Services; … **frame, mirror, sell, resell, rent or lease** use of the Services"* (최종 갱신 **2026-08-25**) | https://tailscale.com/terms |

**★ RA-7 판정과의 구분 (성재 지시대로 분리)**

| 모델 | tailnet 소유자 | 판정 |
|---|---|---|
| **ⓐ oort가 tailnet을 운영하고 셀프호스터를 담는다** | oort | **적색 유지.** ToS §2.3(resell/frame/mirror) + §11.3(§2.3 위반은 **배상 상한 배제**). RA-7 §2.3의 판정을 이 리서치가 뒤집지 않는다 |
| **ⓑ 셀프호스터가 자기 계정으로 자기 tailnet을 만든다** | 셀프호스터 | **정상 사용 패턴이다.** ToS §1.13 Permitted User 정의에 정확히 부합하고, §5.2가 *"**Customer and its Permitted Users choose what Traffic to transmit**. Tailscale has no general obligation to monitor…"* 로 트래픽 재량을 명시한다. **oort는 계약 당사자가 아니므로 우리 리스크 0.** 다만 그 팀이 회사 도메인으로 가입하면 Tailscale이 자동으로 유료 트랙에 올린다 |

⇒ **P1·P2 모두 ⓑ를 전제한다.** 그리고 ⓑ는 **셀프호스터에게 제3자 SaaS 의존(Tailscale 컨트롤 플레인)을 요구**한다 — 라이선스 문제가 아니라 **"셀프호스팅 메신저"라는 포지셔닝과의 긴장**이고, **성재 판단 사안**이다.

### 7.4 Funnel 경로 = 본문 P1 (사용자 설치 없이 미디어를 넣는 유일한 길)

Funnel은 **UDP를 안 나르고**(FR #8868 open), **raw non-TLS TCP도 안 나른다**(FR #14240 open; *"Funnel only works over TLS-encrypted connections"*). ⇒ LiveKit **7881(ICE-TCP)도 UDP 50000-50100도 통과 불가**.

**그런데 `turns:`(TURN over TLS)는 통과할 수 있다.** TURNS는 진짜 TLS라 첫 바이트가 ClientHello고 SNI가 있다. Funnel `--tcp`는 *"look at the SNI name in the TLS ClientHello, and then proxy those encrypted TCP connections to your Tailscale node"* 이고, `--tls-terminated-tcp`는 tailscaled가 TLS를 종단해 평문을 로컬 포트로 넘긴다. **둘 다 접속자에게 Tailscale을 요구하지 않는다** — *"for **anyone to access—even if they don't use Tailscale**"*.

**★ 그리고 P1은 §7.5의 LNA 문제를 겪지 않는다** — 접속 주소가 공개 인터넷 IP이기 때문이다. 이게 P1이 P2보다 나은 두 번째 이유다.

급소는 **"Funnel이 TURNS를 실제로 라우팅하는가"** 하나 — Tailscale 문서에 TURNS 지원 언급이 없다. **[미확인 → RP-2]**

### 7.5 ★★ tailnet 직결 = 본문 P2 — 성립하되, **조사 중 새 차단 요인이 발견됐다**

**네트워크 계층은 성립한다.** 브라우저 WebRTC가 `100.x` 후보를 정상 사용한다는 것은 **소스코드와 벤더 문서 양쪽으로 확증된다**:

- libwebrtc `rtc_base/network.cc`에 **`tailscale` 인터페이스 이름이 리터럴로 하드코딩**되어 있다(`ADAPTER_TYPE_VPN`으로 분류) — https://webrtc.googlesource.com/src/+/refs/heads/main/rtc_base/network.cc [소스코드]
- Frigate 공식 문서: *"For access through Tailscale, the Frigate system's **Tailscale IP must be added as a WebRTC candidate**. Tailscale IPs all start with `100.`"* https://docs.frigate.video/configuration/live/ [공식문서 — 타 벤더 실증]

**그런데 브라우저 계층에 새 게이트가 생겼다 — Local Network Access(LNA).**

- Chromium `services/network/public/cpp/ip_address_space_util.cc`: `// Carrier Grade NAT (RFC 6598): 100.64.0.0/10` → `IPAddressSpace::kLocal` [소스코드]
- Firefox `netwerk/test/gtest/TestLocalNetworkAccess.cpp`: `100.64.0.0/10 … Private` [소스코드]
- **양대 엔진이 `100.64.0.0/10`을 "로컬 주소공간"으로 분류한다.**

| 기능 | 상태(2026-08-26, Chrome stable 152) | 우리 영향 |
|---|---|---|
| LNA 기본(fetch/서브리소스) | **출시 — Chrome 142** | 간접 |
| **LNA for WebSockets** | **출시 — Chrome 147** | ★ **`wss://…→100.x` 시그널링이 권한 프롬프트에 걸린다** |
| **LNA for WebRTC** | **Proposed, 마일스톤 미지정** | 아직 미적용이나 Chrome이 *"soon"* 예고 |

출처: https://chromestatus.com/feature/5152728072060928 (*"Chrome 142 restricted the ability to make requests to the user's local network, gated behind a permission prompt. A local network request is any request from a **public website to a local IP address**"*) · https://developer.chrome.com/blog/local-network-access (*"we plan to ship Local Network Access for WebSockets, WebTransport, and WebRTC connections **soon**"*) · Firefox는 정책 *"Available since 145"* 로 같은 방향, 단 WebRTC LNA는 P3 우선순위(Bugzilla 1969916 NEW).

**★ 완화책은 소스코드로 검증됐다.** Chromium은 `kLocal → kLocal` 을 LNA 요청으로 보지 않는다(`IsLessPublicAddressSpaceLNA`의 `CollapseLocalAndLoopback`). ⇒ **웹앱 오리진 자체를 `https://<host>.<tailnet>.ts.net` 으로 두면 게이팅을 통째로 피한다.**
⚠️ **CSP `treat-as-public-address`를 보내면 강제로 kPublic이 되어 완화책이 무효화된다 — 절대 설정 금지.**

**⇒ P2의 진짜 대가가 여기서 드러난다**: *"웹앱은 지금처럼 공개 엣지(Caddy/터널)에서, 미디어만 tailnet으로"* 라는 **혼합 구성이 성립하지 않는다.** 허들을 쓰려면 **웹앱 전체가 tailnet 안으로 들어가야 한다.** 이건 배선이 아니라 **아키텍처 결정이고 성재 결재 사안이다.**

**P2 성립 조건 정리**

| # | 조건 | 지금 상태 | 바꿀 것 |
|---|---|---|---|
| 1 | 참가자 전원이 tailnet 멤버 | — | 설치+로그인(§7.6) |
| 2 | LiveKit 7880/7881을 tailnet 인터페이스에 바인드 | `127.0.0.1` [compose:133-134] | 바인드 파라미터화 |
| 3 | **웹앱 오리진을 `*.ts.net` 으로** | 공개 엣지 | ★ 아키텍처 변경 |
| 4 | `tailscale cert` 로 진짜 LE 인증서 | — | 90일마다 갱신 필요(자동 아님) |
| 5 | LiveKit이 **100.x를 host candidate로 광고** | §7.8 참조 | `advertise_internal_ip` 또는 `node_ip` |
| 6 | 직결이 성립할 것 | 🧪 | `tailscale ping` 이 "via DERP"가 아니어야 |

**MTU는 걱정하지 않아도 된다** — Tailscale MTU는 **1280**이고 WebRTC의 RTP 페이로드 상한 **1200**은 애초에 *"1280 bytes minus the RTP headers … minus a few 'let's play it safe' bytes"* 로 설계된 값이다(Harald Alvestrand, discuss-webrtc 2017-12-05). IPv4+UDP=1228, IPv6+UDP=1248 ⇒ 둘 다 1280 이하. **미디어는 안전하다.** 단 **IPv6 fragment를 Tailscale 패킷필터가 무음 드롭한 사례**(2026-06)가 있으므로 **IPv4 경로를 우선한다.**

### 7.6 RQ-6c — "봇이 대표로 가입하고 사용자는 링크만" 은 되는가

**VM 쪽은 완전 자동화된다. 사용자 쪽은 안 된다.**

| 질문 | 답 | 근거 |
|---|---|---|
| 봇이 **VM을 무인 가입** | **된다.** auth key: one-off/reusable · ephemeral · pre-approved · tagged. 유효기간 **1~90일** | https://tailscale.com/kb/1085/auth-keys [공식문서] |
| **API로 키 발급** | **된다.** `POST https://api.tailscale.com/api/v2/tailnet/{tailnet}/keys`, `expirySeconds` 기본 7776000, OAuth 클라이언트에 **`auth_keys` 스코프** 필요. OAuth client secret은 무기한, access token 1시간 | https://tailscale.com/docs/features/oauth-clients [공식문서] |
| **초대 링크** | **실재한다.** 콘솔 → "Invite external users" → 링크 복사. **미사용 초대는 30일 만료.** 받는 사람: 링크 → IdP/passkey 로그인 → **"Download the Tailscale client"** | https://tailscale.com/docs/features/sharing/how-to/invite-any-user |
| 초대된 사용자가 **6인 한도를 소진**하나 | **소진한다** — *"Tailscale bills for **every active user** on every tailnet"* | 같은 문서 |
| **node sharing**(VM 하나만 공유) | *"Sharing is available for **all plans**"* · *"**Doesn't increase the user count** of your tailnet"* ⇒ **좌석은 안 먹는다.** 그러나 받는 쪽도 *"their Tailscale clients"* 가 필요 = **계정+설치 필요** | https://tailscale.com/kb/1084/sharing |
| **공유 노드에서 WebRTC가 되나** | **⚠️ 위험.** *"Shared machines are **quarantined by default**. They can respond to incoming connections … but **cannot start connections on their own**."* SFU는 미디어를 능동 송신하므로 깨질 수 있다 | 같은 문서 · **[미확인 — 실측 필요]** |
| 브라우저만으로 tailnet 합류 | **불가.** subnet router는 같은 LAN을 요구하고, 공식 브라우저 확장은 저자 스스로 *"**Don't use it yet. It's too rough.**"* 라고 적어 뒀다(그리고 내부가 tsnet+SOCKS5라 §7.7에서 어차피 막힌다) | https://github.com/tailscale/ts-browser-ext |
| 봇이 사용자 대신 계정 생성 | **폐기** — IdP 2FA/CAPTCHA + **ADR-0004 정면 충돌** | RA-7 §2.5 |

**★ 직답: 사용자는 Tailscale 계정을 만들어야 한다 — 예.** 사용자 동작은 **링크 클릭 → IdP 로그인 → 클라이언트 다운로드/설치(OS 권한 승인 포함) → 앱 로그인 = 최소 4동작**이다. **"제로 설정"과는 거리가 멀다.**

### 7.7 ★★ RQ-6d — `tsnet` 앱 내장 경로: **불성립. 그리고 사유가 예상과 다르다**

성재가 급소로 지목한 지점이 맞았다. 다만 **무너지는 자리가 예상과 다르다** — 우리가 세운 가설 네 고리 중 **앞의 셋은 틀렸고 마지막 하나만 맞다.**

| 우리 가설 | 실제 (소스코드 확인) |
|---|---|
| tsnet은 UDP를 못 한다 | **틀렸다.** `ListenPacket`·`NetstackDialUDP`로 **UDP 완전 지원** |
| tsnet 네트워크는 다른 프로세스가 못 쓴다 | **부분적으로 틀렸다.** `Loopback()`이 실제로 `127.0.0.1`에 **SOCKS5/HTTP 프록시를 연다** |
| Tailscale SOCKS5는 UDP를 못 한다 | **틀렸다.** `net/socks5/socks5.go`에 `udpAssociate`·`handleUDP()`·`transferUDP()` **완비** |
| **Chrome이 SOCKS5 UDP를 못 한다** | **★ 맞다 — 이 하나가 진짜 차단 지점이다** |

**결정적 근거** — Chromium 공식 네트워크 문서 `net/docs/proxy.md` 원문:
> *"**In Chrome SOCKSv5 is only used to proxy TCP-based URL requests. It cannot be used to relay UDP traffic.**"*
https://chromium.googlesource.com/chromium/src/+/refs/tags/78.0.3895.4/net/docs/proxy.md [공식문서]

구현 레벨에서도 확인된다: `services/network/p2p/socket_udp.cc` 에 proxy 참조가 **0건**이고, TCP 쪽만 `ProxyResolvingClientSocket`(= `net::StreamSocket` 상속 = 데이터그램 불가)을 쓴다. [소스코드]

**부가 차단 하나 더**: Chrome은 SOCKS5 **인증도 지원하지 않는데**(*"No authentication methods are supported for SOCKSv5 in Chrome"*), tsnet `Loopback()`은 **자격증명 인증을 강제**한다. ⇒ UDP를 논외로 해도 TCP로조차 붙지 못한다.

**RFC가 이 상황을 미리 서술해 두었다** — RFC 8828 §5.2: *"If the proxy does not support UDP (**as is the case for all HTTP and most SOCKS proxies**) … the use of UDP will be disabled, and TCP will be used… **Use of TCP will result in reduced media quality.**"*

**남는 변형 — 공식 클라이언트를 사이드카로 번들**: 기술적으로 가능하나 **"무설치"라는 목표 자체를 포기하는 것**이다.
- **권한**: macOS `tailscaled`는 root 필요(소스 L280이 *"tailscaled requires root; use sudo tailscaled (or use `--tun=userspace-networking`)"*). **root 없이 되는 모드가 정확히 SOCKS5 모드**라 위 벽에 다시 막힌다. Windows는 Wintun 드라이버 = **관리자 권한 필수**(유저모드 설치 요청 #2791은 2021년 개설 후 **오늘도 open**).
- **크기**: 바이너리 증분 **20~36 MiB**(1.102.3 실측).
- **라이선스는 통과한다** — `tailscale/tailscale` = **BSD-3-Clause**, 의존성 매니페스트 4종 전량 grep 결과 **AGPL/GPL/LGPL 매치 0건**(wireguard-go MIT, gvisor Apache-2.0). **우리 하드룰 저촉 없음.** 다만 **macOS/Windows GUI 래퍼는 클로즈드소스**라 공식 GUI 자체를 재배포할 수는 없다. 상표·번들 정책은 문서 부재 [미확인 — `legal@tailscale.com` 서면 질의가 확인 방법].

**⇒ RQ-6d 판정: 불성립.** 사유 한 줄 — **브라우저 WebRTC 스택이 SOCKS5 UDP 프록시를 구현하지 않으며, 그건 우리가 고칠 수 없는 브라우저 벤더 영역이다.** 성재 조건을 거의 그대로 충족시켜 줄 뻔했지만, 성립하지 않는다.

### 7.8 LiveKit 설정 — 기본값이 P2를 방해한다 (중요)

- LiveKit `config-sample.yaml`은 `use_external_ip: true` 를 **샘플 기본으로 제시**한다. 그런데 **코드의 `DefaultConfig`는 `UseExternalIP: false`** 이고(`pkg/config/config.go` [소스코드]), **우리 `infra/livekit.yaml`은 이 키를 아예 쓰지 않는다** ⇒ **현재 우리 값은 `false`** [레포실측].
- **이 기본값이 P0와 P2에 정반대로 작용한다**:
  - **P2(tailnet 직결)에는 유리** — host 후보(100.x)가 그대로 광고된다.
  - **P0(홀펀칭)에는 치명적** — srflx 후보가 아예 안 만들어진다. P0를 시험하려면 **반드시 켜야 한다.**
- **그리고 켜면 P2가 깨진다**: 이슈 #4487(2026-04-27, closed)에 따르면 `use_external_ip: true`는 host 후보를 srflx로 **교체(replace)** 한다. 도달 불가한 공인 IP로 바뀌면 tailnet 경로가 죽는다.
- **해법(v1.13.1+, 우리 이미지 v1.13.3에 존재)**: **`advertise_internal_ip: true`** — 공식 주석 *"advertises **both** mapped external and internal IPs … the node's local candidate is **kept alongside** the mapped one instead of being replaced by it."* ⇒ **P0와 P2를 동시에 시험할 수 있게 해 주는 키다.**
- 인터페이스 교차 페어링 방지도 필요하다 — 이슈 #3469(미해결)가 `tailscale0`와 `wg0` 공존 시 후보가 엇갈려 미디어가 죽는 사례다. `ips.includes: [100.64.0.0/10]` 또는 `interfaces.includes: [tailscale0]` 로 좁힌다.
- **`nat_1to1_ip`는 LiveKit에 없다** — pion 개념과 혼동된 것이고, LiveKit의 대응 키는 **`node_ip`** 다. `use_ice_lite`는 *"might cause connect issue if server running behind NAT"* 라 켜면 안 된다.

### 7.9 3인 이상 / 외부 손님

- **P2에서는 참가자 전원이 tailnet 멤버여야 한다.** SFU 토폴로지상 각자가 개별적으로 100.x에 도달해야 하기 때문이다. 한 명이 밖에 있으면 그 사람은 **부분 참여가 아니라 아예 통화가 안 된다.**
- Personal 무료는 **6명**(기기 무제한). 초대된 외부 사용자도 이 한도를 소진한다. node sharing만 예외(좌석 미차감)지만 quarantine 리스크가 있다.
- **"링크만 받은 외부 손님이 잠깐 낀다"는 시나리오는 Tailscale 경로로 성립하지 않는다.** Funnel은 UDP 불가, subnet router는 같은 LAN 필요, 공개 TURN은 공인 IP 필요 — 출구가 없다. **그런 요구가 있으면 답은 P1 또는 P3다.**

### 7.10 대안 메시 VPN — **permissive 하드룰로 두 개가 탈락한다**

| 제품 | 라이선스 (LICENSE 원문 확인) | 하드룰 | 릴레이가 공인 IP를 요구하나 |
|---|---|---|---|
| **Tailscale** | 코어 **BSD-3-Clause** / GUI 래퍼 비공개 | **✅ 통과** | DERP를 Tailscale이 무료 운영 ⇒ **불요** |
| **NetBird** | 리포 대부분 BSD-3, **`management/`·`signal/`·`relay/`·`combined/` = AGPL-3.0** (2025-08-05 재라이선싱) | **❌ 탈락** — AGPL 백본 금지 정면 위반 | **예** — 공인 IP+도메인+80/443/3478 |
| **ZeroTier** | 코어 MPL-2.0, **컨트롤러(`nonfree/`) = source-available 비상업 전용**("Use in a production, staging, or development environment for business purposes" 포함) | **❌ 탈락** | moon 자체 운영 시 필요(1.16.0부터 moon deprecated) |
| **Nebula** | **MIT** | ✅ 통과 | **예** — lighthouse는 *"routable IP address"*, relay는 *"should be deployed with a public internet IP"* |
| **headscale** | **BSD-3-Clause** | ✅ 통과 | **headscale 서버 자체가 공인 IP + HTTPS 443 필수** |

> **널리 퍼진 오정보 정정**: 다수 비교 글이 아직 *"NetBird is BSD-3"* 라고 쓰지만, 리포 루트 LICENSE 원문이 *"except for the directories `management/`, `signal/`, `relay/` and `combined/`. Those directories are licensed under the **GNU Affero General Public License version 3.0**."* 다. **우리 정책상 탈락이다.** [소스코드]

**headscale은 우리 문제를 못 푼다** — 컨트롤 플레인만 대체하고 **기본 설정은 Tailscale 공개 DERP를 그대로 쓴다**(`config-example.yaml`의 `derp.urls`가 `https://controlplane.tailscale.com/derpmap/default`, embedded DERP는 `enabled: false`). 게다가 **`tailscale cert` 미지원**(이슈 #2137·#2527 open) ⇒ **§7.5 조건 4가 성립하지 않아 P2 자체가 깨진다.** node sharing·Funnel도 미지원(not planned).

⇒ **어느 메시를 골라도 어딘가 하나는 공인 IP 호스트가 필요하다.** 공인 IP를 단 하나도 안 쓰려면 **SaaS 컨트롤 플레인(Tailscale 공식)이 유일**하고, 그 순간 문제는 라이선스가 아니라 **약관·데이터 주권**으로 성격이 바뀐다.

### 7.11 RQ-6 결론 한 문단

**"랩탑과 VM이 같은 tailnet에 있으면 공인 IP·TURN 없이 허들이 성립하는가" → 조건부 성립.** 네트워크 계층은 성립하고(브라우저가 100.x 후보를 쓴다는 것이 libwebrtc 소스와 Frigate 문서로 확증된다), 조건은 여덟 개다 — 참가자 전원 설치·로그인 / LiveKit 바인드 해제 / **웹앱 오리진을 `*.ts.net` 으로 옮기기(LNA)** / `tailscale cert` 90일 수동 갱신 / `advertise_internal_ip`로 100.x 후보 보존 / 인터페이스 좁히기 / 직결 성립(아니면 DERP throttle) / IPv4 우선. **그리고 성재가 가장 기대했던 `tsnet` 무설치 경로는 불성립이다** — Chrome이 SOCKS5 UDP를 구현하지 않기 때문이다.

**⇒ 따라서 Tailscale이 성재 조건에 기여하는 방식은 "사용자를 tailnet에 넣는 것"(P2)이 아니라 "Funnel을 TURNS 통로로 쓰는 것"(P1)이다.** P1은 사용자에게 아무것도 요구하지 않고, LNA에도 걸리지 않으며, TURN은 VM 안에 남는다.

**남은 최대 리스크 하나**: **"LiveKit SFU를 Tailscale 위에서 성공시킨 1차 실증 기록을 웹에서 찾지 못했다."** Frigate/go2rtc의 100.x 성공은 확증되지만 LiveKit 고유의 candidate 처리에는 미해결 이슈가 여럿이다(#2088·#3469·#4049·#4095). ⇒ **PoC + `chrome://webrtc-internals` 덤프 없이는 어떤 판정도 확정으로 올리지 말 것.**

---

## ⑧ RQ-5 — 권고

### 8.1 직답: 성재 조건 3개를 동시에 만족하는 경로가 **존재하는가**

**문서로 확정 가능한 범위에서는 "없다".** 그리고 없는 이유가 우리 구현이 아니라 위상이라는 것을 §4.0이 보인다 — 공인 inbound가 없는 호스트에 외부 브라우저의 미디어를 넣으려면 **인터넷에서 도달 가능한 지점이 최소 하나** 필요하고, 그 지점이 VM 안에 있을 수는 없다.

**그런데 조건을 깨지 않는 후보가 둘 있고, 둘 다 "그 도달 가능한 지점을 새로 만들지 않는다"는 공통점을 가진다.**

- **P0(홀펀칭)** — VM이 NAT에 스스로 구멍을 뚫어 **잠깐 스스로 도달 가능해진다.** 조건 셋을 **문자 그대로 전부** 만족한다. 그런데 **NAT가 symmetric이면 물리적으로 불가능**하고, 자사 동종 substrate가 symmetric이었다는 실측 전례가 있다.
- **P1(Funnel TURNS)** — 도달 가능한 지점이 **이미 우리가 받아들인 터널 ingress**다. 사용자 동작 0 · 비용 0 · TURN 소프트웨어는 VM 안. **새로 늘어나는 의존이 없다.** 다만 미디어가 TCP를 타므로, **"품질"을 암묵적 조건에 포함시키면 이건 조건 하나를 내주는 셈**이다. 이 구분을 흐리지 않기 위해 §9.1 표를 별도로 두었다.

⇒ **"조건부 존재. 두 조건이 각각 VM의 NAT 타입(P0)과 Funnel의 TURNS 라우팅(P1)이고, 둘 다 아직 안 재 봤다."**

**억지로 답을 만들지 않기 위해 분명히 적는다**: **RP-1이 SYMMETRIC을 내고 RP-2도 실패하면, 성재 조건을 동시에 만족하는 경로는 존재하지 않는다.** 그때는 §9.1의 완화 표에서 하나를 골라야 하고, 그건 기술 판단이 아니라 **제품 결정(성재)** 이다.

### 8.2 권고 — 3단 순차

**1단계 (오늘·1분): RP-1 실행.** 문서로 더 알아낼 것이 없다. 이 프로브 하나가 P0의 생사와 P2의 품질 전망을 동시에 확정한다. **다른 어떤 작업보다 먼저.**

**2단계 (RP-1 결과에 따라 분기)**
- **GREEN(cone NAT + UDP egress)** → **P0 채택.** `livekit.yaml` 1줄 + compose 바인드 1줄 + CSP 1줄. 성재 조건 3개 그대로. 그리고 **P4(외부 TURN을 클라이언트에)를 보완재로 얹는다** — 이때는 §4.2의 함정에 걸리지 않는다(SFU가 srflx를 광고하므로). 기업망 참가자 구제용.
- **RED(symmetric)** → **RP-2(P1) 실행.** 이게 남은 것 중 성재 조건에 가장 가깝다 — **사용자 동작 0회, 비용 0원, TURN은 VM 안에**. 내주는 것은 **품질 한 칸**(UDP → TLS/TCP relay)과 **참가자 상한**뿐이다. 그리고 터널(Tailscale)은 D4로 **이미 채택된 의존**이라 제3자가 새로 늘지 않는다.

**3단계 (P1도 RED거나 성재가 리스크를 안 지겠다면): P3(클라우드 SFU)를 "연동 항목"으로.** 오늘 확실히 되는 유일한 경로다. 코드 0줄, compose 배선(`docker-compose.rust.yml:271-273`) 이미 존재.
- **1순위는 LiveKit Cloud Build 플랜** — **$0/월 · "No credit card required" · downstream 50GB/월**. 같은 SDK·같은 프로토콜이라 `MOMO_LIVEKIT_URL`·키 두 개만 바꾸면 끝이고, **카드 마찰이 없다**는 점이 셀프호스터 온보딩에서 결정적이다.
- 2순위는 **Cloudflare Realtime SFU** — 무료 1,000GB/월로 훨씬 넉넉하지만 **카드 등록이 사실상 필요**하고[미확인], LiveKit이 아니라서 **클라이언트 SDK 교체가 필요**하다(코드 0줄이 깨진다).
- 대가는 ①셀프호스터가 계정 1개를 만든다 ②미디어가 제3자를 경유한다(**E2EE 아님 — 고지 필수**). 이건 성재의 **모델 3번("클라우드 연동은 추천만")과 정합**하고, 앞선 검수의 (d-1) 권고와도 같은 자리다.

### 8.3 성재가 기대했던 것에 대한 정직한 답 세 가지

1. **"허들도 알아서 거기서 세팅이 되어서"** — 세팅(컨테이너 기동·키 생성·env 배선)은 **이미 봇이 대행 가능**하다. 막힌 건 세팅이 아니라 **도달성**이다. 이 둘은 다른 문제이고, 아무리 세팅을 잘해도 도달성은 안 생긴다.
2. **"우리가 TURN을 무료로 해 주는 것"** — **네 겹으로 막힌다.** ①**이 문제를 애초에 못 푼다** — TURN은 클라이언트가 막혔을 때 쓰는 도구지 서버가 안 보일 때 쓰는 도구가 아니다(§4.2). ②**1순위 벤더의 약관이 문언상 금지한다** — Cloudflare Self-Serve Agreement §2.2.1(a) *"…or **sign up for the Services on behalf of a third party**"* (§5.3). ③**우리 비용·우리 신뢰 경계**가 된다 — 모든 통화 미디어가 우리 계정을 지난다. ④지금 NCP 판정이 `momo-turn`을 내리자고 하는 것과 **정반대 방향**이다. **어느 하나만으로도 기각 사유다.**
3. **"SFU가 밖으로 나가서 붙는 패턴"** — **존재하지만 LiveKit은 안 하고, 존재해도 조건을 만족하지 못한다**(§4.3). 나가서 붙을 **대상**이 공개 지점이어야 하기 때문이다.

### 8.4 곁가지지만 놓치면 안 되는 것

- **"안 쓰는 팀은 꺼서 리소스 절약"은 이미 구현돼 있다.** compose `profiles: ["huddle"]`(`:117`)이 정확히 그것이고, 세 env 중 하나라도 비면 허들 REST 4개가 503 `허들 미구성`으로 **fail-closed**한다(`infra/rust/README.md` §4-6). **성재 발제의 후반부는 오늘 코드로 이미 참이다.**
- **quick tunnel 200 in-flight 캡**(§3.2)은 허들과 무관하게 **메신저 본체의 동시접속 상한**일 수 있다. RA-5의 1015와 별개 축이므로 터널 전략 문서에 되먹여야 한다.
- **자체 호스팅 TURN은 SaaS 의존이 아니다.** coturn은 TURN REST API를 내장해 백엔드가 HMAC만 계산하면 단기 크레덴셜이 완성된다(§5.4, Matrix Synapse 선례). 즉 **문제는 "TURN 소프트웨어"가 아니라 "도달 가능한 호스트"** 라는 것이 다시 확인된다.
- **ADR-0122의 "기업망 60~85% relay 필요"는 출처가 ADR 안에 없다.** 웹에서 확인되는 수치는 편차가 크고 출처 신뢰도가 낮다(일반 기업 ~15%, 제한적 망 30~40%, 관리형 방화벽 60~70%대 주장이 혼재 — 전부 벤더 블로그/마케팅 자료라 **[커뮤니티] 이하**). **relay 필요성의 결론은 바뀌지 않지만 ADR의 숫자는 근거 보강 또는 완화가 필요하다.**

## ⑨ 경로 비교표 (종합)

**평가 기준**: 제로설정 = *사용자(참가자)* 가 해야 하는 동작 수 · 비용 = 월 실비 · 제3자 = **새로** 추가되는 의존 · 품질 = 오디오 허들 기준 · 난이도 = 우리가 바꿔야 하는 파일 수.

| 경로 | 사용자 동작 | 셀프호스터 동작 | 비용 | 새 제3자 | 품질 | 난이도 | 생사 |
|---|---|---|---|---|---|---|---|
| **P0. SFU 홀펀칭**(`use_external_ip: true`) | **0** | **0**(봇이 함) | **0원** | **없음**(공개 STUN만) | UDP 직결 = **최상** | `livekit.yaml` 1줄 + compose 바인드 | 🧪 **RP-1이 결정.** symmetric이면 사망 |
| **P1. Funnel + LiveKit 내장 TURN over TLS** | **0** | 0(봇이 함) | **0원**(Tailscale Personal) | **없음** — 터널은 이미 D4로 채택됨 | TCP relay = **중**(오디오는 감당) · **LNA 무관** | `livekit.yaml` turn 블록 + funnel 1줄 + CSP 1줄 | 🧪 **RP-2가 결정.** U2가 급소 |
| **P2. tailnet 직결**(참가자도 Tailscale) | **설치+로그인 등 4동작** | 0 | 0원(6인 상한) | 없음(P1과 동일 vendor) | 직결이면 최상 / DERP 폴백이면 ~2.2 Mbit/s | compose 바인드 + 인증서 + CSP + **웹앱 오리진 이전(LNA)** | ⚠️ 성립하나 **아키텍처 변경**을 부른다(§7.5) |
| **P3. 클라우드 SFU**(LiveKit Cloud / Cloudflare Realtime) | **0** | **계정 1개 + 키 3개** | LiveKit Cloud Build **$0·카드 불요·50GB/월** / CF Realtime **무료 1TB(카드 필요 추정)** | **있음**(미디어가 제3자 경유) | **최상** | `MOMO_LIVEKIT_URL` env + CSP 1줄. **코드 0줄** | ✅ **오늘 확실히 되는 유일한 경로** |
| **P4. 외부 TURN을 클라에만** | 0 | 계정+토큰 | 무료 1TB → 종량 | 있음 | — | `livekit.yaml` | ❌ **단독으로는 성립 안 함**(§4.2). P0의 **보완재**로만 유효 |
| **P5. 공인 IP 호스트 임차**(현행 NCP 모델) | 0 | 0 | **월 실비** | 없음(우리/사용자 소유) | 최상 | 런북 이미 존재 | ✅ 확실하나 성재의 "비용" 발제와 정반대 |
| **P6. UDP 리버스 터널**(frp/rathole, Apache-2.0) | 0 | VPS 1대 | 월 $4~6 | VPS | 최상(UDP 유지) | 새 컴포넌트 + LiveKit `node_ip` | ⚠️ P5의 변형 — 이점이 작다 |
| **P7. 미디어를 WebSocket 자작** | 0 | 0 | 0원 | 없음 | **낮음** | SFU 재발명 | ❌ 비용 대비 무가치 |
| **P8. 허들을 셀프호스트 v1에서 제외** | — | — | 0원 | — | — | 코드 0줄 | ✅ 정직한 선택지 (성재 결정 사항) |

### 9.1 조건 완화 트레이드오프 — 성재가 실제로 고를 것

| 완화하는 조건 | 무엇으로 바꾸나 | 그러면 열리는 것 | 잃는 것 |
|---|---|---|---|
| **아무것도 완화 안 함**(품질 포함) | — | **P0뿐 — RP-1이 symmetric을 내면 아무것도 안 남는다** | — |
| **품질**: UDP → TCP relay | 오디오만, 소규모 | **P1** — 사용자 제로 설정·무료·VM 안에 TURN | 지연 +α, 참가자 상한(대역폭 미공개), Funnel WS 안정성 리스크(#18827) |
| **제로 설정**: 0회 → **참가자 1회 설치** | Tailscale 클라이언트 | **P2** — 최고 품질·무료·외부 미디어 경유 0 | 참가자마다 앱 설치·계정, Personal 6인 상한, 외부 손님 곤란 |
| **VM 자체 완결**: → **무료 외부 SFU 발급** | 셀프호스터가 자기 계정 1개 (LiveKit Cloud는 **카드도 불요**) | **P3** — 오늘 당장 되는 유일한 경로, 품질 최상 | 미디어가 제3자 경유(E2EE 아님 — 고지 필수), 허들이 "연동 항목"이 됨 |
| **무료**: → **월 얼마** | 소형 VPS 1대 | **P5/P6** | 셀프호스터에게 돈을 요구 — 성재 발제와 정면 배치 |

> **읽는 법**: 성재가 "무엇 하나도 못 준다"면 답은 **P0의 실측 결과에 전적으로 달려 있고, 그 결과가 나쁠 확률이 높다.** 한 칸을 내주면 세 갈래가 열리는데, **가장 싸게 내주는 칸은 "품질"(→P1)** 이다. 사용자는 여전히 아무것도 안 하고 돈도 안 든다.

## ⑩ 실측 설계 (red proof) — 값싼 순서대로

이 리서치가 문서로 끝낼 수 없는 것은 정확히 세 개다. **전부 그록봇 VM 안에서 돌리며, 레포 코드 변경 0이다.**

### RP-1 — VM NAT 프로브 (예상 소요 1분, 비용 0) · **최우선**

**우리 사내에 검증된 방법이 이미 있다.** `research/2026-08-15-reachability-spike-1411.md` §2.4가 쓴 그대로 재사용한다 — *"한 소켓 → 서로 다른 STUN 서버 2곳"* 으로 매핑 포트가 달라지면 **SYMMETRIC**이다(그 스파이크는 `:30001`/`:30002`로 갈려 SYMMETRIC 확정, 재측정으로 재현까지 했다).

| 단계 | 측정 | red 판정 |
|---|---|---|
| 1 | VM → 공인 STUN(UDP 3478) 바인딩 요청 성공 여부 | 실패 = **UDP egress 차단** → K/P2/외부 TURN over UDP 전멸, TURNS/TCP만 남음 |
| 2 | **같은 소켓**으로 서로 다른 STUN 서버 2곳에 요청 → 매핑 포트 비교 | 포트가 다르면 **SYMMETRIC** → **P0(홀펀칭) 사망 확정** |
| 3 | UDP 443으로 1을 재실행 | 실패면 TURN/UDP/443 경로 배제 |
| 4 | 컨테이너 **안**에서 1·2를 재실행(도커 브리지 경유) | 호스트와 결과가 다르면 `network_mode: host` 필요 근거 |

**이 한 번의 실측이 §⑨ 표의 절반을 확정한다.** 특히 P0의 생사가 여기서 갈린다.

### RP-2 — Funnel TURNS 스파이크 (예상 소요 1~2시간) · **P1의 생사**

전제: 그록봇 VM에 Tailscale이 이미 붙어 있고 Funnel이 켜져 있다(D4 결정 이후의 기준선).

| # | 단계 | 확인할 것 |
|---|---|---|
| 1 | `tailscale funnel --bg --tls-terminated-tcp=8443 tcp://127.0.0.1:8443` | 명령이 수락되는가(포트 허용 목록) |
| 2 | 외부 망에서 `openssl s_client -connect <node>.<tailnet>.ts.net:8443 -servername <node>.<tailnet>.ts.net` | **TLS 핸드셰이크가 성립하는가** — 이게 P1 전체의 급소다. 실패하면 P1 사망 |
| 3 | LiveKit `turn: {enabled: true, external_tls: true, tls_port: 8443, domain: <node>.<tailnet>.ts.net}` 로 기동 | JoinResponse의 `ice_servers`에 `turns:<node>.<tailnet>.ts.net:8443` 이 실리는가 |
| 4 | 외부 망 브라우저 1대 + `chrome://webrtc-internals` | 선택된 candidate pair가 **relay/tls**인가 |
| 5 | 서로 다른 망의 브라우저 2대 오디오 왕복 | **소리가 오가는가**(이게 최종 red proof) |
| 6 | 60분 soak | RA-6 §1.5의 **Funnel WebSocket `1001` 드롭(GH #18827)** 이 TURNS TCP 세션에도 나타나는가 — 나타나면 통화가 주기적으로 끊긴다 |
| 7 | 3인·5인으로 늘리며 대역폭 관측 | Funnel의 **비공개 대역폭 한도**에 언제 부딪히는가 |

**중단 조건**: 2번이 실패하면 즉시 중단하고 P2/P3로 넘어간다.

### RP-3 — tailnet 직결 스파이크 (P2 채택 시)

| # | 단계 | 확인할 것 |
|---|---|---|
| 1 | compose 바인드를 `${LIVEKIT_BIND:-127.0.0.1}` 로 파라미터화하고 tailscale IP(또는 `0.0.0.0`)에 바인드 | — |
| 2 | `infra/livekit.yaml`에 `advertise_internal_ip: true` + `ips.includes: [100.64.0.0/10]`(또는 `interfaces.includes: [tailscale0]`) | 이슈 #3469형 **인터페이스 교차 페어링** 방지 |
| 3 | `tailscale cert <node>.<tailnet>.ts.net` → **웹앱 오리진 전체를 `https://<node>.<tailnet>.ts.net` 으로 이전** | ★ **LNA 회피의 필수 조건**(§7.5). 공개 엣지에 남겨 두면 Chrome 147+에서 `wss://…→100.x`가 프롬프트에 걸린다 |
| 4 | `tailscale ping <vm>` | **"via DERP"가 아니어야** 한다. DERP면 품질 기대치를 §7.2로 낮춘다 |
| 5 | 랩탑에서 접속 후 `chrome://webrtc-internals` | candidate pair가 **host(100.x)** 인가 |
| 6 | 오디오 왕복 · IPv4 경로 고정 | Tailscale IPv6 fragment 무음 드롭 회피(§7.5) |
| 7 | CSP `treat-as-public-address` 가 **설정돼 있지 않은지** 확인 | 설정돼 있으면 3번 완화책이 무효화된다 |

---

## ⑪ 미확인 항목과 확인 방법 (총괄)

| # | 미확인 | 왜 중요한가 | 확인 방법 |
|---|---|---|---|
| U1 | 그록봇 VM의 **UDP egress·NAT 타입** | P0의 생사, P2의 품질 | **RP-1** (1분) |
| U2 | Funnel `--tcp`/`--tls-terminated-tcp` 가 **TURNS를 실제로 라우팅**하는가 | **P1의 생사** — Tailscale 공식 문서에 TURNS 지원 언급이 없다 | **RP-2 단계 2** |
| U3 | Funnel **대역폭 수치** | 몇 명까지 되는가 | 공식 미공개(*"non-configurable bandwidth limits"*) → RP-2 단계 7로 실측 |
| U4 | Funnel **WS 1001 드롭(#18827)** 이 TCP 세션 전반의 문제인가 | 통화 안정성 | RP-2 단계 6 (60분 soak) |
| U5 | quick tunnel **200 in-flight** 캡이 장기 WebSocket을 어떻게 계수하는가 | **메신저 본체 동시접속 상한** — 허들과 별개로 중요 | 셀프호스트 스택에 WS 다중 접속 부하 |
| U6 | Docker 브리지가 UDP **소스포트를 보존**하는가 | P0의 3번째 관문 | RP-1 단계 4 |
| U7 | LiveKit이 `turn.tls_port`를 **광고 포트로 그대로 쓰는가**(external_tls 시) | P1 배선의 정확도 | 공식 주석은 *"still advertise tls_port as a TURN/TLS candidate"* → 문면상 확정이나 실기동 확인 |
| U8 | cloudflared 이슈 **#964 클로즈 사유** | 공개 UDP 지원 재개 가능성 | GitHub 이슈 본문 재조회 |
| U9 | **LNA for WebRTC**가 언제 출시되는가(현재 Proposed·마일스톤 미지정) | 출시되면 **P2의 미디어까지** 권한 프롬프트에 걸린다 | chromestatus 5152728072060928 주기 확인 |
| U10 | Tailscale **node sharing의 quarantine**(*"cannot start connections on their own"*)이 SFU→클라 미디어를 막는가 | 막으면 "게스트에게 VM만 공유" 경로가 죽는다 | 공유 상태에서 실제 통화 + `chrome://webrtc-internals` |
| U11 | **LiveKit SFU를 Tailscale 위에서 성공시킨 1차 실증**이 세상에 없다 | P2 채택 시 우리가 최초 사례가 된다 = 미지 리스크 | RP-3. Frigate/go2rtc 성공은 확증되나 LiveKit 고유 candidate 처리에 미해결 이슈 다수(#2088·#3469·#4049·#4095) |
| U12 | Cloudflare TURN key 생성에 **결제수단이 실제로 강제**되는가 | 셀프호스터 온보딩 마찰의 크기 | 카드 미등록 신규 계정으로 dash → Realtime → TURN 진입(5분) |

---

## ⑫ 구현 스케치 (권고 경로별 — 어느 파일 무엇을 바꾸는가)

> **공통 사실**: 어느 경로를 골라도 **Rust 서버 코드 0줄 · 웹/데스크톱 클라 코드 0줄**이다(§6.3 C6·C7). 그리고 **데스크톱(Tauri)은 CSP 장애물이 없다** — `clients/desktop/src-tauri/tauri.conf.json:24`의 `connect-src`가 `'self' http: https: ws: wss:`로 **이미 전부 열려 있다** [레포실측]. 막히는 건 **브라우저(웹) 경로뿐**이다. 이건 이전 검수에서 "미실측"으로 남아 있던 항목의 답이다.

### 12.1 P0 — SFU 홀펀칭 (실측이 GREEN이면 이것부터)

| 파일 | 변경 |
|---|---|
| `infra/livekit.yaml` | `rtc:` 아래 **`use_external_ip: true`** 추가 (코드 기본값이 `false`이고 우리 파일이 이 키를 안 쓴다 — `pkg/config/config.go` `DefaultConfig`). **함께 `advertise_internal_ip: true`(v1.13.1+, 우리 이미지 v1.13.3)** 를 켠다 — 이슈 #4487대로 `use_external_ip`만 켜면 host 후보가 srflx로 **교체**되어 P2 경로가 죽는데, 이 키가 **둘 다 보존**한다 |
| `infra/rust/docker-compose.rust.yml:133-134` | 바인드 접두를 `${LIVEKIT_BIND:-127.0.0.1}:` 로 파라미터화(기본값 불변 = 기존 배포 무영향) |
| 같은 파일 livekit 서비스 | 🧪 `network_mode: host` 필요 여부는 RP-1 단계 4가 판정 |
| `infra/rust/Caddyfile.local:57` | `connect-src`에 LiveKit signalling 오리진 추가(터널 URL) — 아래 12.4 공통 |
| env | `MOMO_LIVEKIT_URL` = 터널 뒤 `wss://…` (signalling만 터널을 탄다) |

**red proof**: 서로 다른 망의 브라우저 2대 오디오 왕복 + `chrome://webrtc-internals`에서 선택 pair가 `srflx`인지 확인.

### 12.2 P1 — Funnel + LiveKit 내장 TURN over TLS ★

핵심은 **"Funnel의 TLS 종단 TCP 모드"와 "LiveKit의 external_tls"가 정확히 맞물린다**는 것이다. LiveKit 공식 주석이 이 조합을 문면으로 지지한다 [공식문서]:

> `# set external_tls to true if using a L4 load balancer to terminate TLS. when enabled, LiveKit expects unencrypted traffic on tls_port, and still advertise tls_port as a TURN/TLS candidate.`
> https://github.com/livekit/livekit/blob/master/config-sample.yaml

⇒ Funnel이 그 "L4 load balancer" 자리에 선다. 공개 포트(8443)와 `tls_port`를 **같은 값**으로 두면 광고 포트도 자동으로 맞는다.

| 파일/명령 | 변경 |
|---|---|
| `infra/livekit.yaml` | 주석 해제 + 재작성: `turn: { enabled: true, external_tls: true, tls_port: 8443, domain: <node>.<tailnet>.ts.net, udp_port: 0 또는 미설정, ttl_seconds: 300 }` |
| compose | livekit 서비스에 `127.0.0.1:8443:8443` 추가(TURN 평문 수신구). UDP 50000-50100 매핑은 **불필요해진다**(미디어가 TURN을 탄다) |
| 부트스트랩(에이전트) | `tailscale funnel --bg --tls-terminated-tcp=8443 tcp://127.0.0.1:8443` · 웹 엣지는 `tailscale funnel --bg --https=443 http://127.0.0.1:8088` |
| `Caddyfile.local:57` / `Caddyfile:109` | `connect-src`에 `wss://<node>.<tailnet>.ts.net` 추가 (12.4) |
| env | `MOMO_LIVEKIT_URL=wss://<node>.<tailnet>.ts.net/…` — signalling은 엣지 경유. `MOMO_LIVEKIT_API_KEY/SECRET` 생성 |
| `docs/SELF_HOST_AGENT.md` | §2에 허들 절 신설(문서=제품) |

**주의**: CSP `connect-src`는 **WebSocket만** 통제한다. **ICE/TURN 연결은 CSP `connect-src`의 통제 대상이 아니다** — `turns:` 주소를 allowlist에 넣을 필요도 없고 넣어도 의미가 없다. 막히는 건 signalling WS 하나뿐이다.

**대역폭 산정(오디오 전용, Opus ≈ 32 kbps 기준 [추정])** — 모든 미디어가 Funnel을 통과하므로 이 표가 참가자 상한을 정한다.

| 참가자 | Funnel 통과 총량(상행+하행) | 판정 |
|---|---|---|
| 2인 | ~0.13 Mbps | 여유 |
| 5인 | ~0.8 Mbps | 여유 |
| 8인 | ~2.3 Mbps | RA-6이 역산한 DERP급 한도(~2~3 Mbps)와 같은 자릿수 — **여기부터 위험** |
| 15인(ADR-0122 v0 상한) | ~7.2 Mbps | **초과 개연** |

⇒ P1을 채택하면 **허들 정원을 실측에 맞춰 낮춰야 할 수 있다.** (Funnel ingress는 DERP와 별개 인프라라 한도가 다를 수 있다 — U3.)

### 12.3 P3 — 클라우드 SFU (오늘 확실히 되는 경로)

**권고 벤더 = LiveKit Cloud (Build 플랜)**. 이유는 하나 — **`$0/월 · "No credit card required" · downstream 50GB/월`** 이라 **셀프호스터 온보딩에서 카드 마찰이 없다.** 같은 LiveKit 프로토콜이므로 클라 코드도 0줄이다. (Cloudflare Realtime SFU는 무료 1,000GB로 훨씬 넉넉하지만 카드가 사실상 필요하고[미확인] **LiveKit이 아니라서 클라 SDK를 갈아야 한다** — "코드 0줄"이 깨진다.)

| 파일 | 변경 |
|---|---|
| **없음(코드)** | `MOMO_LIVEKIT_URL`/`API_KEY`/`API_SECRET` 세 env만 셀프호스터가 채운다. compose 배선은 `:271-273`에 **이미 있다** |
| `Caddyfile.local:57` / `Caddyfile:109` | `connect-src`에 외부 SFU `wss://` 오리진 추가 (12.4) |
| compose | livekit 서비스를 **안 띄운다**(profile huddle 미선택) ⇒ 성재의 "안 쓰는 팀은 꺼서 리소스 절약"이 **이미 그대로 성립** |
| `docs/SELF_HOST.md` | 연동 가이드 절 신설 |

### 12.4 공통 — CSP 한 줄을 어떻게 여는가

지금은 두 Caddyfile 모두 `connect-src`가 **하드코딩**이다. 어느 경로를 고르든 여기가 유일한 코드 변경 지점이다.

- 후보 A: Caddy env 보간 `{$MOMO_CSP_CONNECT_EXTRA}` 를 넣고 부트스트랩이 주입.
- 후보 B: 셀프호스트 생성기(`scripts/self_host_env.sh`)가 Caddyfile을 렌더링하도록 승격.
- **주의**: 현재 `Caddyfile.local`은 `ws://localhost:*` 를 허용하는데, 터널/Funnel 경로는 `wss://<호스트>` 라 **와일드카드로 덮이지 않는다.**
- 데스크톱 앱은 이 작업이 **불필요**하다(위 공통 사실).

### 12.5 P1이 상속하는 위험 (RA-6·RA-7에서 이미 확정된 것들)

P1은 Tailscale Funnel 위에 서므로 **Funnel의 위험을 그대로 물려받는다.** 새로 발견된 위험이 아니라 **이미 알려진 것의 재확인**이다.

| 위험 | 내용 | P1에의 작용 |
|---|---|---|
| **Funnel WS `1001` 드롭**(GH #18827, Open·스태프 무응답) | `tailscale serve`에서 WS가 10~40초마다 끊김 | 같은 reverse-proxy 코드 경로면 **signalling이 끊긴다** [추정]. TURNS는 raw TCP 경로라 다를 수 있음 — RP-2 단계 6이 판정 |
| **LE 34시간 락아웃** | 인증서 재발급 rate limit | state dir(`/var/lib/tailscale`)을 `/workspace`에 영속하면 **재발급 0회**로 제거된다(RA-7 §1.3) — **TURNS 인증서도 같은 캐시를 쓴다** |
| **비공개 대역폭 한도** | *"non-configurable bandwidth limits"* | 참가자 상한을 정한다(11.2 표) |
| **Personal 플랜 상업 이용** | *"only suitable for non-commercial use"* | **셀프호스터 자신의 tailnet이면 그의 판단 영역**이고, **oort가 tailnet을 운영하면 적색**(RA-7 §2.3). P1은 전자를 전제한다 |

### 12.6 P1의 변형 두 가지 (참고)

- **coturn(BSD-3, permissive)을 Funnel 뒤에 따로 세우기** — LiveKit 내장 TURN 대신. 이점 없음(내장 TURN은 signalling 인증과 이미 묶여 있다). **권고하지 않음.**
- **포트 하나로 합치기(443)** — Funnel은 포트당 서비스 하나다. 웹앱 HTTPS와 TURNS를 모두 443에 두려면 Funnel `--tcp=443`(SNI 패스스루)로 받아 **로컬에서 ALPN으로 분기**해야 한다(caddy-l4 계열 플러그인). 기업망이 비-443 TLS를 막는 경우의 대비책이지만 새 플러그인 의존이 생긴다. [추정 — 미검증]

## ⑬ 출처 (조회일 2026-08-26)

### 표준
- RFC 6544 — ICE TCP (RFC 4571 프레이밍 강제) — https://www.rfc-editor.org/rfc/rfc6544.html
- RFC 4571 — RTP/RTCP over TCP 프레이밍(16비트 길이 접두) — https://www.rfc-editor.org/rfc/rfc4571.html
- RFC 9725 — WHIP(시그널링 전용) — https://www.rfc-editor.org/rfc/rfc9725.html
- draft-ietf-wish-whep-04 — WHEP(2026-06-22 개정, RFC 미발행) — https://datatracker.ietf.org/doc/draft-ietf-wish-whep/
- draft-chenxin-behave-turn-websocket-01 — TURN over WebSocket(2013-09-12, **2014-03-16 만료**) — https://datatracker.ietf.org/doc/html/draft-chenxin-behave-turn-websocket-01
- W3C WebRTC 1.0 — `RTCIceServer.urls`는 RFC 7064/7065만 — https://www.w3.org/TR/webrtc/

### Cloudflare
- TryCloudflare quick tunnel(제약·200 in-flight·SLA 없음) — https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/
- **프로토콜별 클라이언트 요구 표**(TCP = *"End users run `cloudflared access tcp`"*) — https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/
- Arbitrary TCP(클라 머신에 cloudflared 설치 필수) — https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/cloudflared-authentication/arbitrary-tcp/
- Private networks(WARP 필요) — https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/private-net/
- WebSockets 전 플랜 지원 — https://developers.cloudflare.com/network/websockets/
- Network ports(*"Spectrum for all TCP and UDP ports is only available on the Enterprise plan"*) — https://developers.cloudflare.com/fundamentals/reference/network-ports/
- Spectrum limitations(*"Integrating Spectrum with Cloudflare Tunnel is only supported for HTTP/HTTPS applications"*) — https://developers.cloudflare.com/spectrum/reference/limitations/
- cloudflared 이슈 #964 (public UDP, Closed) — https://github.com/cloudflare/cloudflared/issues/964
- ToS (Last Updated 2025-09-12) — https://www.cloudflare.com/terms/
- Service-Specific Terms – Application Services (Last Updated 2026-06-02, CDN 한정 대용량 파일 조항) — https://www.cloudflare.com/service-specific-terms-application-services/
- "Goodbye, section 2.8" (2023-05-16) — https://blog.cloudflare.com/updated-tos
- Realtime SFU/TURN pricing($0.05/GB · 무료 1,000GB **SFU+TURN 합산**) — https://developers.cloudflare.com/realtime/sfu/pricing/
- Realtime TURN — https://developers.cloudflare.com/realtime/turn/ · FAQ https://developers.cloudflare.com/realtime/turn/faq/ · 크레덴셜 발급 https://developers.cloudflare.com/realtime/turn/generate-credentials/ · RFC 매트릭스 https://developers.cloudflare.com/realtime/turn/rfc-matrix/ · 기존 TURN 대체 https://developers.cloudflare.com/realtime/turn/replacing-existing/ · SFU limits https://developers.cloudflare.com/realtime/sfu/limits/
- **Self-Serve Subscription Agreement §2.2.1(a)**(대행 가입 금지, Last Updated 2025-09-12) — https://www.cloudflare.com/terms/
- Service-Specific Terms – Developer Platform("Cloudflare Realtime … **for your Internet Properties**", 2026-06-02) — https://www.cloudflare.com/service-specific-terms-developer-platform/
- 카드 필요 여부 커뮤니티 스레드(2025-10-12) — https://community.cloudflare.com/t/no-cc-turn-free-tier/846152
- 카드 없는 10GB 우회(HF, 2025-04-09) — https://huggingface.co/blog/fastrtc-cloudflare

### 기타 TURN 제공자·자체호스팅 TURN
- Twilio NTS 가격/리전/ToS(2026-07-16) — https://www.twilio.com/en-us/stun-turn/pricing · https://www.twilio.com/docs/stun-turn/regions · https://www.twilio.com/en-us/legal/tos
- Xirsys 가격·FAQ·ToS(2025-09-16) — https://xirsys.com/pricing · https://xirsys.com/terms · https://docs.xirsys.com/?pg=api-turn
- Metered / Open Relay(ToS 2021-07-27) — https://www.metered.ca/tools/openrelay/ · https://www.metered.ca/stun-turn · https://www.metered.ca/terms
- ExpressTURN — https://www.expressturn.com/ · https://www.expressturn.com/terms
- LiveKit Cloud 가격(Build $0, "No credit card required") — https://livekit.io/pricing
- coturn LICENSE(BSD-3) · `README.turnserver`(`--use-auth-secret` TURN REST API) — https://raw.githubusercontent.com/coturn/coturn/master/LICENSE · https://raw.githubusercontent.com/coturn/coturn/master/README.turnserver
- eturnal LICENSE(Apache-2.0) — https://raw.githubusercontent.com/processone/eturnal/master/LICENSE
- pion/turn LICENSE(MIT) — https://raw.githubusercontent.com/pion/turn/master/LICENSE
- Matrix Synapse TURN 설정(shared-secret 선례) — https://element-hq.github.io/synapse/latest/setup/turn/coturn.html · https://matrix-org.github.io/synapse/latest/setup/turn/eturnal.html

### Tailscale
- `tailscale funnel` CLI(`--tcp` / `--tls-terminated-tcp` / 443·8443·10000 한정, Last validated 2026-01-26) — https://tailscale.com/docs/reference/tailscale-cli/funnel · https://tailscale.com/kb/1311/tailscale-funnel
- Funnel 기능 문서(*"Funnel only works over TLS-encrypted connections"* · *"non-configurable bandwidth limits"*) — https://tailscale.com/docs/features/tailscale-funnel · https://tailscale.com/kb/1223/funnel
- Introducing Tailscale Funnel(SNI만 보고 **TLS 미종료** 프록시) — https://tailscale.com/blog/introducing-tailscale-funnel
- Funnel beta(전용 ingress 서버, 노드 근처로 선택) — https://tailscale.com/blog/tailscale-funnel-beta
- `tailscale cert` / HTTPS — https://tailscale.com/kb/1153/enabling-https
- AUP(미디어 금지 조항 없음 · *"undue burden"* 조항 존재) — https://tailscale.com/tailscale-aup
- 이슈 #14240 (non-TLS raw TCP FR, 2024-11-28, open) — https://github.com/tailscale/tailscale/issues/14240
- 이슈 #8868 (Funnel UDP FR, 2023-08, open) — https://github.com/tailscale/tailscale/issues/8868
- 이슈 #14625 (허용 포트 밖 hang, 2025-01-14) — https://github.com/tailscale/tailscale/issues/14625

### Tailscale (추가 — RQ-6)
- How Tailscale works(DERP = *"fill the same role as TURN servers"*) — https://tailscale.com/blog/how-tailscale-works
- NAT traversal improvements pt.1(직결률 *"well north of 90%"*, DERP = HTTPS TCP 443) — https://tailscale.com/blog/nat-traversal-improvements-pt-1
- 〃 pt.3(*"DERP … enforce rate limits and fair usage policies"*) — https://tailscale.com/blog/nat-traversal-improvements-pt3-looking-ahead
- DERP 서버 문서 — https://tailscale.com/kb/1232/derp-servers · 커스텀 DERP(공인 IP 필수) https://tailscale.com/kb/1118/custom-derp-servers
- 성능 트러블슈팅(*"DERP servers also limit throughput to ensure fairness"*) — https://tailscale.com/kb/1638/poor-performance-tailnet · 연결 유형 https://tailscale.com/kb/1257/connection-types
- Peer Relays — https://tailscale.com/docs/features/peer-relay · https://tailscale.com/blog/peer-relays-international-networks
- 100.x 주소 — https://tailscale.com/kb/1015/100.x-addresses
- 가격/Personal 비상업 문면 — https://tailscale.com/pricing · ToS(2026-08-25) https://tailscale.com/terms
- auth keys(1~90일) — https://tailscale.com/kb/1085/auth-keys · OAuth clients https://tailscale.com/docs/features/oauth-clients
- 초대 vs 공유 — https://tailscale.com/docs/features/sharing/how-to/invite-any-user · https://tailscale.com/docs/reference/inviting-vs-sharing · 공유(quarantine) https://tailscale.com/kb/1084/sharing
- 브라우저 확장(*"Don't use it yet. It's too rough."*) — https://github.com/tailscale/ts-browser-ext

### 브라우저 주소공간·프록시 (RQ-6 신규)
- Chromium `ip_address_space_util.cc`(100.64.0.0/10 → `kLocal`) — https://source.chromium.org/chromium/chromium/src/+/main:services/network/public/cpp/ip_address_space_util.cc
- Local Network Access 기능 상태(Chrome 142 / WebSockets 147 / WebRTC proposed) — https://chromestatus.com/feature/5152728072060928 · https://developer.chrome.com/blog/local-network-access
- Chromium `net/docs/proxy.md`(*"In Chrome SOCKSv5 … cannot be used to relay UDP traffic."*) — https://chromium.googlesource.com/chromium/src/+/refs/tags/78.0.3895.4/net/docs/proxy.md
- libwebrtc `rtc_base/network.cc`(`tailscale` 인터페이스 하드코딩) — https://webrtc.googlesource.com/src/+/refs/heads/main/rtc_base/network.cc
- tsnet godoc — https://pkg.go.dev/tailscale.com/tsnet
- Frigate 문서(Tailscale 100.x를 WebRTC candidate로) — https://docs.frigate.video/configuration/live/
- RFC 8828 §5.2(프록시가 UDP를 지원하지 않는 경우) — https://www.rfc-editor.org/rfc/rfc8828.html

### 메시 VPN 라이선스 (RQ-6)
- NetBird LICENSE(`management/`·`signal/`·`relay/`·`combined/` = **AGPL-3.0**) — https://github.com/netbirdio/netbird/blob/main/LICENSE
- ZeroTier `nonfree/LICENSE.md`(source-available, 비상업) — https://github.com/zerotier/ZeroTierOne
- Nebula(MIT) — https://github.com/slackhq/nebula
- headscale(BSD-3, `derp.urls` 기본이 Tailscale 공개 DERP, `tailscale cert` 미지원 #2137/#2527) — https://github.com/juanfont/headscale

### LiveKit
- `config-sample.yaml` — **`# optional TURN servers for clients`** (turn_servers의 용도 확정) · turn 블록의 `external_tls` 주석 — https://github.com/livekit/livekit/blob/master/config-sample.yaml
- `pkg/config/config.go` `DefaultConfig` — **`UseExternalIP: false`** — https://github.com/livekit/livekit/blob/master/pkg/config/config.go
- 이슈 #3971 "Livekit does not use configured TURN server"(not planned) — https://github.com/livekit/livekit/issues/3971
- 이슈 #4095 "use_external_ip: false is ignored when turn_servers are configured"(2025-11-21, turn_servers를 STUN 바인딩에 사용) — https://github.com/livekit/livekit/issues/4095
- 이슈 #4487(`use_external_ip: true`가 host 후보를 srflx로 **교체**) — https://github.com/livekit/livekit/issues/4487 · #3469(tailscale0/wg0 교차 페어링 실패) https://github.com/livekit/livekit/issues/3469 · #2088(VPN 사설 IP 누락) https://github.com/livekit/livekit/issues/2088
- LICENSE(Apache-2.0) — https://raw.githubusercontent.com/livekit/livekit/master/LICENSE
- Ports and firewall(TURN/TLS 5349, LB 없으면 443) — https://docs.livekit.io/home/self-hosting/ports-firewall/

### 브라우저 구현
- Mozilla Bug 949703 — WebRTC over HTTP proxy CONNECT (RESOLVED FIXED, FF38) — https://bugzilla.mozilla.org/show_bug.cgi?id=949703
- Chrome 47 WebRTC 릴리스 노트 — *"won't work at all unless the application supports TURN/TCP or ICE-TCP"* — https://developer.chrome.com/blog/chrome-47-webrtc
- Chrome Enterprise `WebRtcIPHandling` — https://chromeenterprise.google/policies/web-rtc-ip-handling/

### 리버스 터널(UDP)
- frp (Apache-2.0, TCP/UDP/HTTP/HTTPS) — https://github.com/fatedier/frp
- rathole (Apache-2.0) — https://github.com/rathole-org/rathole

### 레포 내부 근거 (재조사 불요 · 이 리서치가 전제로 삼음)
- `infra/livekit.yaml:15-19` · `infra/rust/docker-compose.rust.yml:110-149,133-135,271-273` · `server-rust/bins/momo-server/src/config.rs:137-154` · `server-rust/bins/momo-server/src/routes/huddles.rs:133` · `infra/rust/Caddyfile.local:57` · `infra/rust/Caddyfile:109` · `clients/desktop/src-tauri/tauri.conf.json:24` · `clients/web/src/features/huddles/huddleRuntime.ts:52` · `docs/SELF_HOST_AGENT.md:261-271` · `docs/runbooks/turn-host-install.md:6-9` · `docs/adr/0122-voice-huddles-meeting-intelligence.md`
- `research/2026-08-15-reachability-spike-1411.md` §2.4 (STUN 2곳 대조로 SYMMETRIC 판정한 사내 실측 방법) · `research/2026-08-22-tunnel-spike-r2.md` · `research/2026-08-23-tunnel-strategy-ra5.md` · `research/2026-08-25-tunnel-scalability-pricing.md` §1.7 · `research/2026-08-26-ra7-tunnel-identity-feasibility.md` §2.3 · `research/2026-08-26-selfhost-external-dependency-audit.md` · `research/2026-08-26-ncp-teardown-judgment.md` · `research/2026-08-26-selfhost-product-model-review.md` 급소 1

---

## ⑭ RP-1 실측 결과 — 2026-08-26 (그록봇 VM에서 성재 실행)

```
[기본] 로컬 소스포트 52335 (한 소켓 고정)
[기본]   stun.l.google.com:19302 → 매핑 3.151.208.192:60444
[기본]   stun.cloudflare.com:3478 → 매핑 13.59.64.92:40359
판정: SYMMETRIC (매핑 포트 [60444, 40359]) — P0 홀펀칭 사망 확정.
```

### 판정: **P0(SFU 홀펀칭) 사망 확정. 그리고 예상보다 나쁘다.**

리서치는 "매핑 **포트**가 다르면 symmetric"을 red 기준으로 삼았다. 실측은 그 기준을 넘겼을 뿐 아니라 **매핑 IP까지 다르다** — `3.151.208.192` vs `13.59.64.92`. 둘 다 **AWS**(`whois` NetName `AT-88-Z`, 2026-08-26 조회).

⇒ 그록봇 VM의 egress는 **목적지마다 다른 공인 IP로 나가는 로드밸런싱 NAT 풀**을 지난다. 고전적 symmetric NAT(IP는 고정, 포트만 변동)보다 한 단계 더 강한 형태다.

**함의 (P0을 넘어선다):**
1. **VM에는 안정적인 공인 신원이 아예 없다.** 포트만이 아니라 주소가 흔들린다.
2. **VM을 어떤 형태로든 "밖에서 찾아오는 서버"로 세우는 설계는 전부 무효다** — 자체 TURN을 공인 주소로 광고하는 경로(§4.2 A′)가 여기서 최종적으로 닫힌다.
3. **살아남는 것은 안에서 밖으로 먼저 열고 유지하는 터널뿐이다** — 연결을 VM이 개시하므로 egress IP가 흔들려도 세션이 유지된다. **P1(Funnel을 TURNS 통로로)이 이 조건을 만족하는 유일한 후보로 남는다.**

**단계 3(UDP/443)은 미판정**이다 — 프로브가 443을 듣지 않는 STUN 서버에 쐈으므로 timeout이 차단의 근거가 되지 못한다(설계 한계를 스크립트가 명시). 필요하면 443 응답자를 세우고 재측정한다.

### 전제 변경 — 성재 정정 (2026-08-26)

> "cloudflare나 tunnel은 우리가 대신 가입해주는 게 아니야. **그록봇이 '이거 회원가입 필요하다' 같은 걸로 사용자한테 회원가입 정도는 시키게 할** 거야. tailscale도 마찬가지고."

이 정정이 **§RQ-3의 차단 사유 중 결정적인 것을 무효화한다.** 리서치는 Cloudflare 약관 §2.2.1(a) *"sign up for the Services on behalf of a third party"* 금지를 네 겹 중 결정타로 들었으나, **사용자가 자기 손으로 가입하면 그 조항의 적용 대상이 아니다.**

또한 이 구조는 **ADR-0004와 정합한다** — 자격증명이 "사용자 → 자기 서버" 한 홉만 지나고 우리를 경유하지 않는다(제품 모델 검수 §급소 5의 경계 문장 그대로).

⇒ **조건이 「제로 설정」에서 「그록봇 안내 + 사용자 1회 가입」으로 완화됐다.** 이 전제에서 §⑨ 경로표를 다시 읽어야 하며, Tailscale·Cloudflare 계정을 요구하는 경로들이 **되살아난다.**

---

## ⑮ RP-2 급소 통과 — Funnel TLS 종단 TCP로 TLS 악수 성립 (2026-08-26 실측)

**P1의 생사를 가르는 단계 2가 통과했다.**

### 절차
그록봇이 §2.2를 완주해 Funnel을 세우고(`cursor.<tailnet>.ts.net`, HTTP Funnel 8088에 연결), `tailscale funnel --bg --tls-terminated-tcp=8443 tcp://127.0.0.1:8443` 을 수락시켰다. VM 안 `127.0.0.1:8443` 에 **더미 TCP 리스너**를 띄운 뒤, 오케스트레이터가 **VM 바깥(로컬 맥)** 에서 악수를 걸었다.

### 결과
```
CONNECTION ESTABLISHED
Protocol version: TLSv1.3
Ciphersuite: TLS_AES_128_GCM_SHA256
Peer certificate: CN=cursor.<tailnet>.ts.net
Verification: OK
Negotiated TLS1.3 group: X25519MLKEM768
```

### 앞선 EOF의 정체 — 판정이 맞았다
리스너 없이 걸었을 때는 `unexpected eof while reading` 로 끊겼다. 그때 **"TLS 불가가 아니라 뒤에 받을 것이 없어서"** 로 판정했고, 리스너 하나를 띄우자 즉시 악수가 성립했다. ⇒ **Funnel 의 TLS 종단 TCP 모드는 백엔드를 먼저 확보한 뒤 핸드셰이크를 완료한다.** 대조군도 함께 확인했다(HTTP Funnel 443 → 200, 8443 TCP → OPEN).

### 함의
1. **`turns:` 가 이 통로를 지날 수 있다** — TURN over TLS 는 진짜 TLS 이고 SNI 를 실으므로, Funnel 의 SNI 라우팅이 그대로 받는다. LiveKit 의 `external_tls: true` 가 "TLS 는 밖에서 끝나니 그래도 `turns:` 로 광고하라"는 뜻이라 이 조합과 정합한다.
2. **성재 조건이 전부 유지된다** — 추가 가입 0(Tailscale 은 서버 URL 발급 단계에서 이미 쓴다) · 추가 설치 0 · 비용 0 · **TURN 은 VM 안**이라 미디어가 제3자를 경유하지 않는다.
3. **인증서 검증까지 통과**했으므로 브라우저도 이 엔드포인트를 신뢰한다 — 자체서명 예외 처리가 필요 없다.

### 남은 단계 (RP-2 3~7)
더미 리스너 자리에 **LiveKit 내장 TURN** 을 앉힌다. `infra/livekit.yaml` 의 주석 처리된 TURN 블록을 `{enabled: true, external_tls: true, tls_port: 8443, domain: <node>.<tailnet>.ts.net}` 로 열고, compose 바인드와 CSP(`Caddyfile*` `connect-src`) 를 맞춘다. **서버 Rust 코드 0줄 · 웹 클라 코드 0줄**(§6.3 C6·C7).

이후 확인할 것: JoinResponse `ice_servers` 에 `turns:` 가 실리는가 → `chrome://webrtc-internals` 에서 candidate pair 가 relay/tls 인가 → **서로 다른 망의 브라우저 2대 오디오 왕복** → 60분 soak(Funnel WS 1001 드롭이 TURNS TCP 세션에도 나타나는가) → 3·5인 대역폭.

**⇒ P1 은 살아 있다. 미실측으로 남은 것은 "TURN 트래픽이 이 통로에서 실제로 미디어를 나르는가" 이며, TLS 계층의 의문은 해소됐다.**
