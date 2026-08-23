# 터널 전략 재검토 — quick tunnel 1015의 그록봇 VM 구조적 노출 (RA-5)

> 2026-08-23 Fable 작성. 발단: E2E 수용 런 §2에서 cloudflared quick tunnel이 `429 / error 1015`로 멈춤(모계획 §11). 성재 질문 — "일반 사용자도 충분히 겪을 이슈인가? 근본 해결책·커뮤니티 우회 조사."
> 입력: 웹 리서치(Cloudflare 1015 문서·awesome-tunneling 큐레이션) + 우리 실측(`research/2026-08-22-grok-cdp-control-and-operator-host.md`·RA-4).

## 0. 질문에 대한 답 (요지)

**그록봇 VM 셀프호스터(우리 1차 타겟)는 quick tunnel 1015에 구조적으로 노출된다. 성재 직감이 맞다.** 집/VPS 셀프호스터는 거의 안 겪는다. 원인은 그록봇 VM의 네트워크 구조:

| 요인 | 실측/근거 | 1015에의 작용 |
|---|---|---|
| **egress = Cloudflare static/datacenter IP** | 우리 실측 `104.30.175.37`(Cloudflare 대역) + Grok Bot 공식 문서 "static egress IP addresses"·"datacenter IP addresses"(RA-4:113-114) | 1015 = **per-IP** rate limit. quick tunnel도 Cloudflare 서비스라, **자기 대역/데이터센터 IP에서 오는 개설 요청을 더 엄격히 제한**할 개연. |
| **egress IP 풀 공유** | VM들이 Cloudflare egress 대역을 공유(개별 주거 IP 아님) | 여러 체험 유저의 quick tunnel 개설이 **같은/인접 IP 풀에서 집계** → 한 유저의 1015가 자기 탓이 아니라 **다른 유저들의 집합적 개설** 때문일 수 있음. |
| **durable-but-resettable** | RA-4 — Update/재시작마다 스택·터널 재구성 | 터널 **재개설 빈도가 일반 셀프호스트보다 높음** → per-IP 한도를 더 자주 친다. |

우리가 오늘 겪은 1015는 R-2 스파이크+E2E 반복 개설이 직접 트리거지만, **위 3요인은 우리 개발과 무관하게 일반 그록봇 체험 유저에게도 작동**한다. 즉 quick tunnel 단독 의존은 그록봇 1차 타겟에 취약하다.

## 1. quick tunnel의 알려진 한계 (Cloudflare 공식)

- **1015 = per-IP rate limit**(짧은 시간 다수 요청). 15분+ 대기로 자동 해제. 재시도는 오히려 연장.
- **429 = per-tunnel 200 in-flight 요청 한도**(별개 — 트래픽 과부하).
- Cloudflare 공식: quick tunnel = **개발/테스트용, production 금지, SLA·uptime 무보증**. URL은 프로세스 종료 시 소멸·재시작마다 변경. (이미 D4에서 알던 것 — 이번에 rate limit 실측이 추가.)

## 2. 대안 매트릭스 (도메인 불요·무료·에이전트 스크립트 가능 기준)

| 도구 | URL | 계정 | 도메인 | WS | 헤드리스 | 그록봇 적합도 |
|---|---|---|---|---|---|---|
| cloudflared quick tunnel | 랜덤·휘발 | 불요 | 불요 | ✓ | ✓(1커맨드) | 현행. **1015 구조 노출** |
| **Tailscale Funnel** | **고정** | 필요 | **불요** | ✓ | ✓ | **★유력** — 고정 URL·무료·도메인 불요·WS. 단 Tailscale 계정+`tailscale funnel` 활성 필요 |
| Pinggy | 랜덤 | 불요 | 불요 | ✓ | ✓(SSH 1줄) | 폴백 후보. 무료 tier 세션 시간 제한 |
| localhost.run | 랜덤 | 불요 | 불요 | ✓ | ✓(SSH 1줄) | 폴백 후보 |
| cloudflared **named** tunnel | 고정 | 필요 | **필요** | ✓ | ✓ | 고급 옵션 — 도메인 있는 유저만 |
| ngrok(무료) | 랜덤 | 필요 | 불요 | ✓ | ✓ | 무료 tier 제약(1 세션·경고 페이지) |
| bore/frp/sish/zrok | 다양 | 다양 | 다양 | 일부 | ✓ | self-host 릴레이 필요(별도 공인 호스트) — 그록봇 단독 부적합 |

**핵심 분기**: 도메인 불요 + 고정 URL을 동시 만족하는 건 **Tailscale Funnel**이 유일. 나머지 무계정 옵션(quick tunnel·pinggy·localhost.run)은 전부 랜덤·휘발 URL.

## 3. 근본 해결책 방향 (권고)

quick tunnel **단독 의존을 끊는 것**이 근본이다. 세 갈래:

- **A. 터널 provider 추상화 + 폴백(권장 설계)**: T-2 플레이북 §2를 "quick tunnel 시도 → 1015/실패 시 대안(pinggy/localhost.run) 폴백"으로. 에이전트가 순차 시도. **도메인·계정 없이 즉시 동작 유지**하면서 단일 실패점 제거. URL 휘발은 데스크탑 앱 "서버 주소 변경" UX(T-5/T-6 재페어링 경로)로 이미 흡수.
- **B. Tailscale Funnel 1급 경로**: 고정 URL이 필요하면(재접속 UX 개선) Tailscale Funnel을 권장 경로로. 대가 = 그록봇 유저가 Tailscale 계정 1회 생성. **D4 변경(성재 결재)**.
- **C. 현행 유지 + 백오프 안내**: quick tunnel 유지, §2에 "1015 시 15분 대기·재시도 금지" 문면만. **미봉책** — 그록봇 egress 공유 구조라 대기해도 타 유저 개설로 재발 가능. 단독으론 불충분.

**Fable 권고 = A(폴백 추상화)를 기본으로 하고, B(Tailscale Funnel)를 고정 URL 옵션으로 병기.** A는 도메인·계정 무진입장벽을 지키며 구조적 단일 실패점을 없애고, B는 재접속 UX를 원하는 유저의 상위 경로. C는 A에 흡수(백오프는 폴백 전 1회).

## 4. E2E와의 관계

E2E §1 코어는 전량 GREEN(모계획 §11) — 파이프라인·claim·플레이북·agent-port 전부 실증. §2 터널만 이 구조 이슈. **E2E 폐곡선은 터널 전략 결정(D4 재검토) 후 §2 재개로 완성**된다. 지금 그록봇 스택·claim env·덤프는 보존 상태.

## 5. 성재 결정 (2026-08-23 — A+B 확정)

**성재 선택(2026-08-23 갱신): Tailscale Funnel 기반으로 전면 전환.** ("아예 가능방향으로 하자. 설치·연동 쉬운 걸로 안다.") D4 재개정 — v1 터널 = quick tunnel 단독 → **Tailscale Funnel 기본**. quick tunnel/폴백은 후순위(계정 불가 유저용 대안으로만 유지하거나 폐기). E2E §2는 Tailscale Funnel로 재개.

### Tailscale Funnel 자동화 경로 (실측 리서치 — 에이전트 headless 적합성)
| 단계 | 커맨드 | 주체 |
|---|---|---|
| 설치 | `curl -fsSL https://tailscale.com/install.sh \| sh` | **에이전트**(1줄) |
| 인증 | `tailscale up` (auth key env 전달 — ADR-0004 정합) 또는 로그인 URL 클릭 | **유저 1회**(계정+key발급 또는 URL 클릭) |
| HTTPS/MagicDNS | funnel이 자동 생성·활성 | 자동 |
| Funnel node attr | tailnet policy — 기본 all members 포함 | 대부분 자동(확인만) |
| 서빙 | `tailscale serve https / http://localhost:8080` + `tailscale funnel 443 on` | **에이전트** |
| URL | `https://<machine>.<tailnet>.ts.net` **고정** | — |

**요건**: Tailscale v1.38.3+ · MagicDNS(기본) · Funnel은 443/8443/10000만 listen(oort 엣지를 그 중 하나로 서빙).
**그록봇 이점**: ①고정 URL=재접속 UX 해소(RA-4 A6) ②rate limit 구조 노출 소멸(자체 DERP 릴레이 — CF egress 공유 무관) ③정식 기능(quick tunnel 무보증 탈피) ④auth key env=크레덴셜 비유입(ADR-0004). **유일 진입장벽 = Tailscale 계정 1개**(무료).
**주의**: Funnel URL은 tailnet/machine name 노출(공개 주소) — claim/비번은 여전히 대화 비유입. 출처: tailscale.com/kb/1223(funnel)·/kb/1085(auth keys)·/kb/1311(funnel cmd).

### 티켓 재편
- **T-2 플레이북 §2 재작성 = Tailscale Funnel 기본**(문서=제품). quick tunnel 관련 §2 문면 대체.
- (기존 T-9 폴백 추상화·T-10 병기안은 이 전환으로 흡수/철회.)

### (원) 결정 큐 — 위 선택으로 해소

- **Q-TUNNEL-A**: T-2 플레이북 §2를 터널 폴백 추상화(quick→pinggy/localhost.run)로 개정할지 — 소형 티켓(문서=제품). **권장.**
- **Q-TUNNEL-B**: Tailscale Funnel을 고정 URL 1급 경로로 추가(D4 변경)할지 — 계정 진입장벽 대가. 리서치/설계 티켓.
- **Q-TUNNEL-C(즉시)**: 오늘 E2E §2 재개를 ⓐquick tunnel 한도 회복 대기 재시도 ⓑ지금 pinggy/localhost.run로 폴백 실측(A안 리허설 겸) 중 무엇으로.

## 6. 출처

- Cloudflare error 1015(per-IP rate limit·15분 대기): developers.cloudflare.com/support .../error-1015
- quick tunnel 한계(200 in-flight 429·production 금지·무보증): developers.cloudflare.com/cloudflare-one .../trycloudflare · deepwiki cloudflare/cloudflared quick-tunnels
- 대안 큐레이션: github.com/anderspitman/awesome-tunneling · pinggy/dev.to 2026 비교
- 그록봇 VM egress 실측: `research/2026-08-22-grok-cdp-control-and-operator-host.md:34` · Grok Bot 공식 문서 인용 `research/2026-08-22-grokbot-vm-persistence-ra4.md:113-114`
