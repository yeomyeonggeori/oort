# RA-7 — 터널 정체성 영속화 실현 가능성 (RQ-1 + RQ-2)

> 2026-08-26 Fable(deep-research) 작성. 발제: 성재 승인 — "B트랙(그록봇 터널 자동 프로비저닝) 실현 가능성 실측 리서치".
> 선행 정본(재조사하지 않음): `research/2026-08-25-selfhost-url-stability-interview.md`(3-Tier·불변식·RQ 목록) · `research/2026-08-25-tunnel-scalability-pricing.md`(RA-6: Funnel 전 플랜 무료·WS #18827·LE 34h·커스텀도메인 불가) · `research/2026-08-23-tunnel-strategy-ra5.md`(quick tunnel 1015) · `research/2026-08-22-grokbot-vm-persistence-ra4.md`(durable-but-resettable).
> **확신도 표기**: **[공식문서]** 벤더 공식 문서/약관 · **[소스코드]** tailscale 저장소 코드/코드위키 · **[커뮤니티]** GitHub 이슈·포럼·블로그 · **[추정]** 출처 조합 추론 · **[미확인]** 어느 출처로도 확인 실패 · **🧪[실측필요]** 문서로 확정 불가, 그록봇 VM에서 돌려야 함.
> 조회일은 모두 **2026-08-26**.

---

## 0. 요약 (TL;DR)

1. **RQ-1 답 = YES.** `tailscaled` state dir을 영속하면 재프로비저닝에도 **같은 노드 · 같은 MagicDNS 이름 · 같은 Funnel URL**이 복원된다. 공식 문면이 직접 보증한다 — *"The `TS_STATE_DIR` volume ensures **the container keeps its identity across restarts**"* / 없으면 *"your container will appear as a new node each time"*. **funnel 설정(ServeConfig)과 TLS 인증서도 같은 state dir에 들어 있어 한 묶음으로 복원된다.**
2. **"34시간 락아웃"의 정체 규명.** Tailscale KB의 34시간은 Let's Encrypt의 **중복 인증서 한도 리필 간격**(5장/7일 = 168h/5 ≈ 34h)을 옮긴 것이다. **연속 5회까지는 버틴다.** 그리고 state를 영속하면 인증서는 캐시에서 재사용되어 **재발급 호출 자체가 0회**가 된다 — 이 위험은 설계로 완전히 제거된다.
3. **★ URL 불변식의 진짜 파괴 경로는 "state 소실"이고, 그건 되돌리기 어렵다.** 이름 충돌 시 `-1`이 붙고 자동 회수되지 않으며(공식), 삭제된 머신 이름을 되찾지 못한다는 보고(#1200)와 재설치 시 새 이름을 받는 4년 묵은 Open 이슈(#4371)가 있다. 게다가 **같은 이름을 다른 노드가 이어받으면 기존 방문자 브라우저가 CT 오류로 깨진다**(#15702, closed as not planned). ⇒ **state 영속은 최적화가 아니라 불변식 그 자체다.**
4. **RQ-2 답 = "터미널 0회"는 되고 "계정 0개"는 안 된다.** Funnel은 tailnet 소속이 전제다. 우회 3경로가 각각 다른 벽에 부딪힌다 — **oort tailnet + 태그키**는 ToS §2.1·§2.3 위반 소지(§11.3으로 **배상 상한 배제**)에 Personal 플랜 *"only suitable for **non-commercial use**"* 명문 금지, **무태그키**는 90일마다 사람이 브라우저로 API 토큰을 재발급해야 해 자동화가 깨지고, **봇 대리 가입**은 IdP와 대리권 진술에서 막힌다.
5. **★ 무계정 대안 터널은 없다 — 그리고 그건 구조다.** localhost.run 무료는 *"Domain names change regularly"*(SSH키 등록은 "더 오래 갈 뿐"), pinggy 무료는 60분 타임아웃+로테이션, ngrok 무료는 static domain 1개를 주지만 **1GB/월**. **고정 URL은 예외 없이 계정/과금의 경계선에 놓인다** — 이름 소유권에는 신원이 필요하고, 무계정 고정 이름은 즉시 피싱 스쿼팅이 되기 때문이다(localhost.run이 문서에 그렇게 써 놨다). ⇒ **"무계정 + 고정 URL"의 유일한 구현은 릴레이를 우리가 운영하는 것 = A트랙**이다.
6. **판정**: B트랙은 **성립한다**(§3.2의 C1~C7 조건부). 강제되는 재정의는 "제로 계정 → 제로 터미널 명령" 하나뿐이다. **A트랙 승격은 URL 불변식 때문에 강제되지는 않지만**, ⓐ무계정을 제품 요구로 유지하거나 ⓑWS 게이트가 RED이거나 ⓒ그록봇 Reset이 state를 날린다면 강제된다. 그리고 **A트랙은 CNAME이 아니라 TLS 종단 프록시여야 하므로**(GH #16478 closed as not planned) 인터뷰 §①의 A 정의는 개정이 필요하다.
7. **진짜 blocker는 하나** — **Funnel WebSocket `1001` 드롭(GH #18827, 오늘도 Open·무응답)**. 이것만이 Funnel 채택의 생사를 가른다. **다음 액션 = §1.8-F(1시간+ WS soak) 최우선 실행.**

---

## 1. RQ-1 — Tailscale state 영속화로 "같은 URL"이 복원되는가

### 1.1 직답

**된다. 그리고 그것이 URL을 지키는 *유일한* 메커니즘이다.** Tailscale에서 노드 정체성은 계정도 hostname도 아니고 **state 파일 안의 노드 키**다. state를 영속 공간에 두면 컨테이너·VM을 갈아끼워도 control plane 입장에서는 "재부팅한 같은 노드"이므로 MagicDNS 이름이 유지되고 따라서 `https://<host>.<tailnet>.ts.net`도 그대로다.

공식 문면이 이 인과를 직접 말한다 [공식문서]:

> **TS_STATE_DIR** — "Specifies where `tailscaled` stores its state. The `TS_STATE_DIR` volume ensures **the container keeps its identity across restarts**." … "This directory must persist across container restarts or **your container will appear as a new node each time**."
> — https://tailscale.com/docs/features/containers/docker/docker-params

반대로 **state를 잃으면 새 노드가 되고, 새 노드는 같은 이름을 못 받는다**(§1.6). 즉 이 문제는 "URL을 어떻게 고정하나"가 아니라 **"state를 어떻게 안 잃나"** 문제로 온전히 환원된다. B트랙 설계의 중심 축이 여기다.

### 1.2 state에 정확히 무엇이 들어가나 — funnel 설정까지 포함된다

| 항목 | 근거 | 확신도 |
|---|---|---|
| 기본 경로 | `<statedir>/tailscaled.state` (`--state` 미지정 시) | [공식문서] tailscaled 레퍼런스 |
| `--statedir=` | *"a directory on disk where to store configuration files, keys, Taildrop files, and other state."* (다른 판본에는 **TLS certs** 명시 — §1.3) | [공식문서] |
| `--state=` 대안 | `/path/to/file` · `kube:<secret-name>` · `arn:aws:ssm:...` · **`mem:`(=저장 안 함, ephemeral 노드로 등록)** | [공식문서] |
| **ServeConfig(=serve/funnel 설정)** | *"LocalBackend stores the ServeConfig in the StateStore using a profile-specific key"* (`ipn/serve.go:28-32`). Windows 실사례에서는 `server-state.conf`의 `_serve/<profile>` 키 | [소스코드]+[커뮤니티] |
| funnel 자동 재개 | *"If you use the `tailscale funnel` command with the `-bg` flag, it runs persistently in the background until you turn it off. When you reboot the device or restart Tailscale … **Funnel will automatically resume sharing.**"* | [공식문서] funnel CLI 레퍼런스 |

⇒ **state dir 하나만 영속하면 노드 정체성 + funnel 라우팅 설정 + TLS 인증서가 한 묶음으로 복원된다.** 부트스트랩 스크립트가 매번 `tailscale funnel` 명령을 다시 때릴 필요조차 없다(때려도 무해하지만, `-bg` 설정이 이미 있으면 "Background configuration already exists" 계열 상태로 갈 수 있음 [커뮤니티]).

### 1.3 TLS 인증서 캐시는 어디에 — **state dir 안이다**

- tailscaled 플래그 설명(판본에 따라): *"path to directory for storage of config state, **TLS certs**, temporary incoming Taildrop files, etc."* [공식문서]
- 실제 경로: **`/var/lib/tailscale/certs/<fqdn>.crt` / `.key`** — Caddy 통합 이슈에서 *"the certs would be stored in `/var/lib/tailscale/certs`"*, 여러 셀프호스트 문서가 동일 경로를 인용 [커뮤니티 다수]
- 소스 근거: `ipn/ipnlocal/cert.go`의 `getCertStore()` — store 타입이 `FileStore`/`mem.Store`이거나 Kubernetes가 아니면 **파일 기반 `certFileStore{dir: b.certDir()}`** 를 쓴다. **Kubernetes 환경만** state store(Secret)에 인증서를 넣는다 (issue #8254, PR #8255로 종결) [소스코드]
- `tailscaled -state mem:`로 띄우면 `tailscale cert`가 *"failed to get cert dir"*로 실패 — 인증서에는 **파일 디렉터리가 필수** (issue #4797) [커뮤니티]

⇒ **디스크 state dir을 영속하면 인증서 캐시 영속은 자동으로 따라온다. 별도 조치 불필요.**
(단, `certs/`가 `statedir` **하위**인지 — 즉 `TS_STATE_DIR` 하나만 bind mount 해도 인증서가 같이 보존되는지 — 는 배포 형태에 따라 달라질 수 있어 🧪[실측필요] §1.8-B.)

### 1.4 ★ "34시간"의 정체 규명 — 공포보다 관대하고, 구조는 더 명확하다

RA-6 §1.6이 인용한 Tailscale KB의 *"you may find yourself waiting 34 hours"*는 **Let's Encrypt의 중복 인증서 한도 리필 간격을 그대로 옮긴 숫자**였다. LE 공식 [공식문서] https://letsencrypt.org/docs/rate-limits/ :

> "Up to **5 certificates** can be issued per **exact same set of identifiers** every **7 days**." … 용량은 연속적으로 리필되며 그 속도가 **"1 certificate every 34 hours"**.

168h ÷ 5 = 33.6h ≈ 34h. 즉:

- **동일 FQDN 신규 발급은 연속 5회까지 가능**하고, 소진하면 **34시간마다 1칸씩 회복**된다. "한 번 잘못하면 34시간 정지"가 아니라 "5번까지는 버티고 그 다음부터 34시간 간격"이다. 개발·리허설 중 실수 여유가 RA-6이 상정한 것보다 크다.
- **갱신(renewal)은 이 한도의 대상이 아니다** — LE: 동일 식별자 집합의 갱신은 New Orders/New Certificates per Registered Domain 한도에서 면제. 다만 **Duplicate Certificate 한도 자체는 갱신에도 적용**된다는 점이 커뮤니티 통설이라 [커뮤니티], "재발급을 0회로 만드는 것"이 여전히 정답이다.
- Tailscale은 serve/funnel 경로에서 **TLS를 자기가 종단**하므로 인증서를 스스로 갱신한다: *"If a certificate is handled without the user initiating any file-based certificate installation … then the certificate will automatically be renewed without the user doing anything."* [공식문서]
- ⚠️ **역풍**: LE는 인증서 수명을 90일 → 64일 → 45일로 단축 중이다(2026-02-24 공지 — *"This will ultimately double the number of certificate renewal requests each day"*). 갱신 빈도가 2배가 되면 **"갱신에 실패한 채 방치될 수 있는 시간"이 절반**이 된다. 무인 서버에서 갱신 실패를 감지하는 헬스체크가 필요하다(불변식 ③ 조용한 실패 금지와 직결).

### 1.5 컨테이너/VM 표준 레시피 [공식문서]

| 변수 | 값 | 이유 |
|---|---|---|
| `TS_STATE_DIR` | `/var/lib/tailscale` | 정체성 보존의 전부. **반드시 영속 볼륨에 매핑** |
| `TS_AUTHKEY` | pre-auth key | 무인 등록(§2). ADR-0004 정합 — env 주입, 대화 비유입 |
| `TS_AUTH_ONCE` | `true` | 기본 `false`는 *"forces login every time the container starts"*. state가 있으면 재로그인 생략 |
| `TS_HOSTNAME` | `oort-<claim>` 등 **명시 고정** | 미지정 시 *"Docker generates a random hostname"* = URL 랜덤화. §1.6 P3 방어 |
| `TS_USERSPACE` | `true`(기본값) | **userspace networking = `/dev/net/tun`·`NET_ADMIN` 불요.** 그록봇 VM처럼 권한이 불확실한 환경에 결정적 |
| `TS_SERVE_CONFIG` | serve/funnel JSON | *"Accepts a JSON file to programmatically configure Tailscale Serve and Tailscale Funnel"*. **디렉터리로 마운트할 것**(파일 단위 마운트는 갱신 감지 실패) |

```yaml
# docker-compose 골격 — 그록봇 VM용
services:
  tailscale:
    image: tailscale/tailscale:latest
    hostname: oort-server            # OS hostname 드리프트 방어(§1.6 P3)
    environment:
      - TS_AUTHKEY=${TS_AUTHKEY}
      - TS_STATE_DIR=/var/lib/tailscale
      - TS_HOSTNAME=oort-server
      - TS_AUTH_ONCE=true
      - TS_USERSPACE=true
      - TS_SERVE_CONFIG=/config/serve.json
    volumes:
      - /workspace/oort/ts-state:/var/lib/tailscale   # ★ Docker 볼륨이 아니라 /workspace bind
      - /workspace/oort/ts-config:/config
    restart: unless-stopped
```

> **그록봇 특수사항 (RA-4 연동)**: `/workspace`만 durable이고 *"manually installed packages"*는 공식적으로 replaceable이다. 따라서 state를 **명명된 Docker 볼륨(`/var/lib/docker` 층)에 두면 안 된다** — RA-4 실측은 재시작 유형에서 볼륨 생존을 확인했을 뿐 Update/Reset 유형은 미검증이다. **`/workspace/oort/ts-state` bind mount가 보수 기본**이다.

### 1.6 ★★ URL 불변식의 실제 파괴 경로 — 전수

| # | 경로 | 근거 | 확신도 |
|---|---|---|---|
| **P1** | **state 소실 + 기존 노드 잔존** → 새 노드가 `<hostname>-1`을 받음 → **URL 변경** | *"If a device already on the network has the same name, the new machine will get a name like `<hostname>-1`."* 게다가 *"If the conflicting machine's name is later changed, this machine will still maintain the `<hostname>-1` machine name."* = **자동 회수 없음** | [공식문서] machine-names |
| **P2** | **헌 노드를 지워도 이름이 안 풀릴 수 있다** | #1200 *"Name 'pixel-3' is already taken"* (삭제된 기기의 이름으로 rename 불가, **Closed·회수 정책 문서화 없음**) · #2076 *"`tailscale logout` doesn't release the machine name"* → k8s 운영자들이 **API로 old device를 DELETE한 뒤 재등록**하는 워크어라운드를 씀 | [커뮤니티] |
| **P3** | **OS hostname 드리프트** | *"If the OS updates the hostname, the machine name will also get updated the next time Tailscale is started up."* (Auto-generate 기본 ON) | [공식문서] |
| **P4** | **재설치가 새 이름을 만든다** | #4371 *"Re-installs of tailscale on the same device should have the same hostname rather than derive a new one"* — **2022-04-07 개설, 여전히 Open** (4년+) | [커뮤니티] |
| **P5** | tailnet 이름 변경 / 인증서 발급 후 재추첨 불가 | RA-6 §1.10 | [공식문서] |
| **P6** | **노드 키 만료(기본 180일)** → *"connections to/from the given endpoint will stop working"* | 무인 서버는 **Disable Key Expiry 필수**. **tagged 기기는 첫 태그 인증 시 만료가 자동 비활성**(§2 태그 전략과 직결) | [공식문서] key-expiry |
| **P7** | **같은 이름을 다른 노드가 이어받으면 브라우저가 깨진다** | #15702 — 같은 funnel 호스트명을 새 노드가 쓰면, 이전에 접속했던 브라우저에서 `net::ERR_CERTIFICATE_TRANSPARENCY_REQUIRED`. **Closed as not planned.** 시크릿창/캐시삭제로만 회피 | [커뮤니티] |
| **P8** | **funnel 설정이 control plane에 동기화되지 않는 버그** | #19508 (1.96.3, **Open**, 2026-04-24) — 로컬 `tailscale serve status`는 active인데 *"the control plane never receives the funnel state … external connections are silently dropped at the TLS layer."* 워크어라운드 = **tailscaled 재시작** | [커뮤니티] |
| **P9** | **state 복제로 인한 이중 노드** | #506 — 같은 `tailscaled.state`를 두 머신이 쓰면 같은 IP를 두고 싸워 *"the Pi Zero uses 20-40% of its CPU constantly sending netmaps and reconnecting to DERP"*. **Open(2020-06-25~)**. 백업 "복원"은 되지만 **원본이 살아 있으면 안 된다** | [커뮤니티] |

**이 표에서 나오는 설계 결론 4개**

1. **P1+P2+P4가 합쳐지면 "state를 잃으면 URL은 사실상 되돌릴 수 없다"**가 된다. 헌 노드를 지우면 이름이 풀린다는 낙관에는 근거가 약하고 반례(#1200)가 있다. ⇒ **state 영속은 최적화가 아니라 불변식 그 자체.**
2. **P7 때문에 "새 노드에 같은 이름 재부여"는 성공해도 사용자 브라우저에서 깨진다.** state 영속 외의 우회로는 진짜로 없다.
3. **P8 때문에 프로비저닝 성공 판정을 로컬 상태로 하면 안 된다.** 반드시 **외부 경로에서 실제 HTTP 200 + WS 101**을 확인해야 한다(불변식 ③).
4. **P6 때문에 무인 서버는 키 만료 비활성이 필수**다. 태그를 쓰면 자동으로 해결되지만, 태그는 요금(§2 tagged resource)과 funnel ACL(§2.7)을 동시에 건드린다.

### 1.7 그록봇 시나리오에 대한 판정

| 시나리오 | state 결과 | URL |
|---|---|---|
| 컨테이너 재시작 | `/workspace` bind → 보존 | **불변** |
| VM 재기동(compute 교체, durable storage 재부착) | 보존 | **불변** [추정 — 🧪실측] |
| Grok Bot **Update** | `/workspace` 보존 · 설치물 replaceable → 부트스트랩 재실행 필요, state는 살아있음 | **불변** [추정 — 🧪실측] |
| Grok Bot **Reset**(durable 스냅샷 롤백) | 스냅샷 시점의 state로 롤백 — 스냅샷에 state가 들어 있으면 **같은 노드**, 스냅샷이 tailscale 등록 이전이면 **state 소실** | **조건부** — RQ-7 미해결 지점 |
| 구독 소진 / 워크스페이스 접근 불가 (RA-4 §144) | state 접근 불가 | **상실** |

⇒ **B트랙의 잔여 리스크는 Tailscale이 아니라 그록봇의 `/workspace` 내구성에 있다.** RQ-7이 RQ-1보다 실질적으로 더 위험한 항목으로 승격된다.

### 1.8 🧪 검증 절차 — 그록봇 VM에서 실행할 명령 단위

> 목적: 문서로는 확정 불가한 5가지를 실측으로 닫는다. 각 단계에 **판정 기준**을 붙였다.

**A. 베이스라인 확보**
```bash
# A1. 상태 디렉터리를 durable 경로에 준비
mkdir -p /workspace/oort/ts-state /workspace/oort/ts-config

# A2. 컨테이너 기동 (위 compose)
docker compose up -d tailscale

# A3. 정체성·URL 기록
docker compose exec tailscale tailscale status --json | jq '.Self.DNSName, .Self.ID, .Self.PublicKey'
docker compose exec tailscale tailscale serve status
URL=$(docker compose exec -T tailscale tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')
echo "$URL" | tee /workspace/oort/ts-state/URL.baseline
```
**판정**: `DNSName`에 `-1` 같은 접미사가 **없어야** 한다. 있으면 이미 이름 충돌 상태.

**B. 인증서 캐시가 state dir 안에 있는지**
```bash
docker compose exec tailscale ls -la /var/lib/tailscale/ /var/lib/tailscale/certs/ 2>&1
ls -la /workspace/oort/ts-state/ /workspace/oort/ts-state/certs/ 2>&1
docker compose exec tailscale sh -c 'openssl x509 -in /var/lib/tailscale/certs/*.crt -noout -dates -issuer'
```
**판정**: 호스트 쪽 `/workspace/oort/ts-state/certs/*.crt` 가 보이면 §1.3 확정. 안 보이면 인증서가 **다른 경로**에 있는 것이므로 그 경로도 추가 bind 해야 한다 → 발견 즉시 레시피 수정.

**C. 외부 도달성 — control plane 동기화까지 확인 (P8 방어)**
```bash
# VM 바깥(로컬 맥)에서 실행할 것 — VM 안에서 자기 URL을 치면 tailnet 내부 경로를 탈 수 있다
curl -sS -o /dev/null -w '%{http_code} %{ssl_verify_result}\n' "https://$URL/healthz"
# WS 101 확인
curl -sS -i -N -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
     -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
     "https://$URL/connection/websocket" | head -20
```
**판정**: `200`/`101`이 아니면 P8 의심 → `docker compose restart tailscale` 후 재시도. 재시작으로 고쳐지면 **부트스트랩에 "프로비저닝 후 tailscaled 1회 재시작 + 외부 검증" 단계를 명문화**해야 한다.

**D. ★ 핵심 실험 — state 영속이 URL을 지키는가**
```bash
# D1. 컨테이너·이미지까지 완전 파기 (state 디렉터리는 남긴다 = 재프로비저닝 모사)
docker compose down
docker rmi tailscale/tailscale:latest
docker system prune -af

# D2. 아무것도 안 바꾸고 재기동
docker compose up -d tailscale
sleep 20
docker compose exec -T tailscale tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//'
```
**판정(불변식 검증)**: 출력이 `URL.baseline`과 **글자 단위로 동일**해야 한다. 다르면 B트랙의 전제가 무너진 것 → 즉시 성재 보고.
```bash
# D3. 인증서가 재발급됐는지 = LE 한도를 먹었는지
docker compose exec tailscale sh -c 'openssl x509 -in /var/lib/tailscale/certs/*.crt -noout -serial -dates'
```
**판정**: **serial이 D1 이전과 동일**해야 한다(=재사용). 바뀌었으면 재발급이 일어난 것이므로 5회 한도(§1.4)를 소모한다 → 캐시 경로 재점검.

**E. 파괴 실험 — state를 잃으면 실제로 어떻게 되나 (P1/P2 확증)**
> ⚠️ 이 실험은 **URL을 영구히 잃을 수 있다.** 반드시 **폐기용 tailnet/호스트명**으로, 프로덕션 후보 이름을 태우지 말 것.
```bash
# E1. state만 지우고 같은 hostname으로 재등록
docker compose down && rm -rf /workspace/oort/ts-state/* && docker compose up -d tailscale
sleep 20 && docker compose exec -T tailscale tailscale status --json | jq -r '.Self.DNSName'
```
**판정**: `oort-server-1.<tailnet>.ts.net`이 나오면 P1 확증.
```bash
# E2. 헌 노드를 API로 지운 뒤 다시 같은 이름을 받을 수 있는가 (P2 확증)
curl -u "$TS_APIKEY:" "https://api.tailscale.com/api/v2/tailnet/-/devices" | jq '.devices[] | {id,name,hostname}'
curl -u "$TS_APIKEY:" -X DELETE "https://api.tailscale.com/api/v2/device/<OLD_ID>"
docker compose down && rm -rf /workspace/oort/ts-state/* && docker compose up -d tailscale
sleep 20 && docker compose exec -T tailscale tailscale status --json | jq -r '.Self.DNSName'
```
**판정**: 원래 이름이 돌아오면 "삭제 후 재사용" 폴백이 성립(=P2 반증). `-1`/`-2`가 계속 붙으면 **URL 상실은 되돌릴 수 없다**가 확정되고, §1.6 결론 1이 하드 사실이 된다.

**F. 장시간 WS 유지 (RA-6 §1.5 GH #18827 게이트 — 여전히 Open)**
```bash
# 로컬 맥에서 60분 이상 유지, 끊김 로그 수집
websocat -v "wss://$URL/connection/websocket" 2>&1 | ts | tee /tmp/ws-soak.log
# 또는 Centrifugo 클라로 다중 접속 + 서버측 disconnect 코드 집계
```
**판정**: `1001 Going Away`가 10~40초 주기로 반복되면 **Funnel 채택 자체가 무산**된다. 이것이 B트랙의 최종 게이트다.

**G. 키 만료 방어 확인 (P6)**
```bash
docker compose exec tailscale tailscale status --json | jq '.Self.KeyExpiry'
```
**판정**: `null`(만료 없음)이어야 한다. 날짜가 찍히면 태그를 쓰거나 콘솔에서 Disable Key Expiry.

### 1.9 ★ 보너스 발견 — `tailscale funnel`은 tailnet이 미설정이면 **사람의 브라우저 클릭을 기다린다**

Funnel은 **double opt-in**이다 — *"It needs to be both enabled in the Tailscale admin console by a tailnet admin **and** enabled on the device running Tailscale."* [커뮤니티/공식 블로그]. CLI가 tailnet policy file을 자동 갱신해 준다는 문면도 있지만([공식문서] *"When you enable Funnel using the Tailscale CLI, Tailscale automatically creates valid HTTPS certificates and updates your tailnet policy file."*), **그 자동화의 실제 구현이 대화형이다.**

`cmd/tailscale/cli`의 `verifyFunnelEnabled()` → `enableFeatureInteractive(ctx, "funnel", nodecap.HTTPS, nodecap.Funnel)` [소스코드]:

```go
if hasCaps() { return nil }            // ← 이미 활성이면 완전 무인. 이 경로가 우리가 원하는 것
info, err := e.lc.QueryFeature(ctx, feature)
if info.Complete { return nil }
if info.Text != "" { fmt.Fprintln(Stdout, "\n"+info.Text) }
if info.URL != ""  { fmt.Fprintln(Stdout, "\n         "+info.URL+"\n") }   // ← 사람이 열어야 하는 URL
if !info.ShouldWait { ...; os.Exit(0) }                                    // ← 조용히 exit 0 (!!)
... WatchIPNBus로 capability가 붙을 때까지 무한 대기 ...
```

**함의 3가지 (그록봇 플레이북 직결)**

1. **tailnet이 이미 HTTPS+funnel로 설정돼 있으면 `tailscale funnel`은 100% 무인이다.** → oort가 자기 tailnet을 한 번만 설정해 두는 모델(§2)이면 사용자 쪽 클릭이 0회가 된다.
2. **사용자 자기 tailnet(신규)이면 첫 funnel 호출에서 사람이 브라우저로 URL을 열어야 한다.** 이는 인터뷰 성공기준의 "브라우저 클릭 2회(claim 비번+앱 로그인)" 예산을 **3회로 늘린다.** 성재 결정 필요 항목.
3. ⚠️ **비대화형 컨텍스트에서 `os.Exit(0)`으로 조용히 끝날 수 있다.** 에이전트가 종료코드 0을 성공으로 오독하면 **"성공했다고 보고했는데 URL은 죽어 있는"** 최악의 조용한 실패가 된다(불변식 ③ 정면 위반). ⇒ **플레이북은 종료코드가 아니라 §1.8-C의 외부 HTTP 200/WS 101로만 성공을 판정해야 한다.** 이건 문서화 필수 문면이다.

### 1.10 인증서 재발급이 실제로 언제 일어나는가 (§1.4 보강) [소스코드]

`feature/acme/cert.go`:
- **캐시 우선**: `getCertPEMCached(cs, certDomain, now)` — 유효한 인증서가 캐시에 있으면 **Let's Encrypt에 접속하지 않고 그대로 반환**.
- **갱신 시점**: *"check whether we're more than 2/3 of the way through the certificate's lifetime"* 또는 ACME **ARI**(Automatic Renewal Information) 엔드포인트가 제시한 창 안에서 랜덤 시각.

⇒ **state(=certs 캐시)를 영속하면 재프로비저닝 시 LE 호출 자체가 없다.** §1.4의 "5회/34시간"은 **state를 잃었을 때만** 세는 카운터다. 이것으로 RQ-1의 인증서 축은 닫힌다(🧪 §1.8-D3로 serial 동일성 확인).

---

## 1.5-보론 ★ "누구의 tailnet에 넣을 것인가"가 만드는 보안 문제 (RQ-2로 넘어가는 다리)

Tailnet의 **기본 정책은 allow-all**이다 [공식문서]:

> "When you first create your Tailscale network (known as a tailnet), Tailscale initializes it with a **default allow all access policy** … allows all devices within the tailnet to access other devices in the tailnet."

즉 **oort가 자기 tailnet에 고객 서버들을 넣는 모델**을 택하면, 기본값에서:

1. **고객 A의 서버가 고객 B의 Postgres에 tailnet IP로 직접 도달**한다(방화벽 뒤라 더 무방비다).
2. **oort(tailnet owner)가 모든 고객 서버에 네트워크 레벨로 접근 가능**해진다 — 노드 추가·ACL 변경·기기 삭제 권한 포함.
3. 2번은 **셀프호스팅의 존재이유를 정면으로 부정**한다. 인터뷰 불변식 ②(중앙 디스커버리 부재)·④(oort 중앙과 완전 독립)와 충돌한다. "우리는 안 본다"는 약속으로 덮을 수 없는 **구조적 접근권**이다.

tag 기반 ACL로 상호격리는 가능하지만(태그별 정책), **oort의 관리자 접근권 자체는 제거 불가능**하다(tailnet owner는 정의상 정책을 바꿀 수 있다). ⇒ 이 축은 §2의 약관 판정과 **독립적으로** oort-tailnet 모델을 감점시킨다.

---

## 2. RQ-2 — 제로터치 vs Tailscale 계정 요구

### 2.0 직답

**"터미널 명령 0회"는 성립한다. "Tailscale 계정 0개"는 성립하지 않는다.** 그리고 계정을 회피하려고 만든 세 우회로는 각각 **약관·과금·자동화** 중 하나에서 막힌다.

| 모델 | 누구의 tailnet | 자동화 | 과금 | 약관 | 판정 |
|---|---|---|---|---|---|
| **M1. 사용자 자기 tailnet** (그록봇이 브라우저로 가입 안내) | 사용자 | 초기 1회 브라우저 클릭 필요 | $0 (Personal, 비상업 개인 사용자면 정합) | ✅ 깨끗 | **권장** |
| **M2. oort tailnet + 태그 auth key** | oort | ✅ 완전 자동(OAuth) | 50대 무료 → **$1/mo/대** | ⚠️ §2.1·§2.3 위반 소지 · Personal 비상업 금지 | 조건부(계약 필요) |
| **M3. oort tailnet + 무태그 auth key** | oort | ❌ **90일마다 사람** | $0 (user device 무제한) | 위와 동일 | **자동화 실패** |
| **M4. Tailnet Creation API**(멀티테일넷, alpha) | 고객별 API-only tailnet | ✅ | **조직당 최대 10개** · 초과 시 sales | 공식 경로 ✅ | **상한 10이 치명** |
| **M5. 봇이 사용자 대신 Tailscale 가입** | 사용자 | ❌ IdP가 막음 | — | Tailscale ToS 직접 금지 조항은 없으나 대리권 진술 리스크 | **실행 불가에 가까움** |

### 2.1 pre-auth key로 무로그인 등록은 된다 [공식문서]

> "Pre-authentication keys (called auth keys) let you register new nodes **without needing to sign in using a web browser**." — kb/1085

- **노드는 언제나 "키 발급자의 tailnet"에 들어간다.** *"An auth key authenticates a device as the user who generated the key."* API 경로 자체가 `/api/v2/tailnet/{tailnet}/keys`로 tailnet에 스코프된다. **다른 tailnet에 꽂을 방법은 없다.**
- 키 만료 **최대 90일**(*"between 1 and 90 inclusive"*, API `expirySeconds` 기본 90일). → **키 로테이션이 90일 주기로 강제**된다.
- 키가 만료돼도 **기등록 노드는 계속 동작**: *"If an auth key expires, any device authorized by it remains authorized until its node key expires."*
- 노드 키는 기본 **180일** 만료 → *"connections to/from the given endpoint will stop working"*. 무인 서버에 치명. **태그를 붙이면 자동 해제**되고(§1.6 P6), 무태그면 `POST /api/v2/device/{id}/key {"keyExpiryDisabled":true}`를 등록 직후 반드시 쳐야 한다.

> ⚠️ **최대 함정 (URL 직결)**: *"If you use an OAuth client secret, **the node is ephemeral by default**. To register a non-ephemeral node, append `?ephemeral=false` to the secret."* [공식문서 docker-params]
> OAuth secret을 `TS_AUTHKEY`에 그대로 넣으면 노드가 ephemeral이 되고, **마지막 활동 후 30~60분 뒤 자동 삭제**된다(kb/1111). 그러면 URL이 증발한다. **`?ephemeral=false`를 빠뜨리는 순간 B트랙 불변식이 무성의하게 깨진다** — 플레이북에 붉은 글씨로 박아야 하는 한 줄.

### 2.2 ★ 자동화 ↔ 과금의 교착 (M2 vs M3)

Tailscale은 **"완전 자동 발급"과 "무태그(=무료)"를 동시에 허용하지 않는다.**

> "**All auth keys created from an OAuth client must use tags.**" — kb/1215 [공식문서]
> "When creating an auth key owned by the tailnet (using OAuth), **it must have tags**. … When creating an auth key owned by a user (using a user's access token), **tags are optional**." — OpenAPI `KeyCapabilities`

그리고 과금 정의는 오직 "태그가 붙었는가" 하나만 본다:

> "A **user device is simply anything that is not tagged as a resource!** **User devices are free and unlimited.**"
> "A **tagged resource is a device that is owned by a tag rather than a user identity.**"
> "Tagged resources — **50 tagged resources included; add more for $1/month each.**" — tailscale.com/pricing [공식문서]

⇒ **M2(태그·자동화)** = 고객 서버 1대 = tagged resource 1개. **50대 무료, 51번째부터 $1/월**. 규모가 곧 원가가 된다.
⇒ **M3(무태그·무료)** = 태그 없는 키는 **user-owned API access token**으로만 발급 가능한데, 그 토큰은 **최대 90일**이고 **API로 재발급할 수 없다**(`POST /keys`의 `keyType` enum = `auth|client|federated`, `api` 없음). ⇒ **90일마다 사람이 브라우저로 admin console에 들어가야 한다** = 무인 운영 실패. 게다가 전 고객 노드가 oort 직원 계정 1개에 매달려 **단일장애점**이 된다.

| | M2 태그(OAuth) | M3 무태그(user token) |
|---|---|---|
| 완전 자동 발급 | ✅ | ❌ 90일마다 사람 |
| 과금 | 50대 초과 $1/mo/대 | $0 |
| 노드 키 만료 | 자동 비활성 ✅ | 180일 — API로 개별 해제 필요 |
| Funnel nodeAttr | 태그 타깃 명시 필요 | 기본 `autogroup:member`로 커버 ✅ |
| ACL 세분화 | 태그별 가능 ✅ | 전부 한 유저 ❌ |

### 2.3 ★★ 약관 판정 — oort tailnet 모델(M2/M3)은 회색이 아니라 **적색에 가깝다**

Tailscale ToS(**최종 갱신 2026-08-25** — 바로 어제) [공식문서] https://tailscale.com/terms :

| 조항 | 원문 | 함의 |
|---|---|---|
| **§2.1 사용 범위** | *"solely for **your own personal use or internal business purposes** (as applicable depending on your Plan)"* | 고객 서버를 담아 고객에게 제공하는 것은 통상 해석 밖 |
| **§2.3 제한** | *"You may not … **commercially exploit any part of the Services**; … **frame, mirror, sell, resell, rent or lease use of the Services**"* | 정면 충돌 소지 |
| **§11.3 책임한도 예외** | *"the 'Excluded Liabilities' are any liabilities arising from: … (c) breach of Section 2.3 (Restrictions)"* | **§2.3 위반은 배상 상한이 적용되지 않는다** — 리스크의 크기가 무제한 |
| **§1.13 Permitted User** | *"an **individual human** who is authorized by Customer to access, use, administer or manage Customer tailnets"* | **그록봇은 Permitted User가 될 수 없다.** 봇의 행위는 oort의 행위로 귀속(§2.5) |
| **§2.4 책임** | *"ensuring you have all rights, permissions, consents (including from Permitted Users and End Users) to use the Tailscale Solution to process Customer Data"* | 고객 데이터 동의 확보 책임이 전부 oort에 |
| **§1.7 End Users** | *"any individuals whose communications … are routed through … the Services"* | 계정 없는 최종 사용자 개념 자체는 ToS 어휘 안에 있음 — 유일한 우호 근거 |

**무료 Personal 플랜은 상업 이용이 명시적으로 금지**된다 [공식문서 pricing FAQ]:
> "This is a free plan and is **only suitable for non-commercial use** of Tailscale."
> "Please note, however, that the **Personal plan is not intended for commercial use.**"
> "If you create a tailnet with a custom domain, it's considered **business use**, and you'll be automatically enrolled in a free trial."

⇒ **RA-6 §1.3의 "Funnel 무료 = 요금 락인 없음" 판정은 유효하지만, 그것은 *사용자 자신이 개인 용도로 쓸 때*의 이야기다.** oort가 상업 제품의 일부로 무료 tailnet을 운용하는 순간 이 문면에 걸린다. **M2/M3는 "돈이 더 든다"가 아니라 "약관 위반"이다.**

### 2.4 공식으로 열려 있는 문 두 개

**(a) Channel Partner Agreement (MSP)** — 2025-01-31 [공식문서]
> §1.7 *"'MSP' means a Partner that **sells and provides Managed Services to and on behalf of any Customer**."*
> §2.1 *"Tailscale hereby grants to Partner a non-exclusive, revocable … right and license to promote, market, resell, and/or **provide Managed Services** for the Tailscale Solution to Customers … **For the avoidance of doubt, Partner has no right under this CPA to access or use the Tailscale Solution for Partner's own benefit or internal business purposes.**"*
> §2.7.2(a)(i) MSP는 *"acting as the Customer's **exclusive administrator** for the Tailscale Solution"*
> §3.2.1 Deal registration 의무

⇒ **"oort가 고객 대신 Tailscale을 운영한다"는 모델은 금지된 게 아니라 *계약을 요구*한다.** 다만 이건 셀프서브가 아니고(Quote/Order Form 필요), 유료 리셀 전제이며, oort가 각 고객의 "exclusive administrator"가 된다 — **§1.5-보론의 신뢰 문제가 계약으로 공식화될 뿐 해소되지 않는다.**

**(b) Tailnet Creation API — 멀티테일넷 (Alpha)** [공식문서]
> *"Create an **API-only tailnet** in the organization. **API-only tailnets have no human users and do not appear in the admin console.** Use them for applications and infrastructure that manage tailnets entirely through the API."*
> *"**All plans can create a maximum of 10 tailnets, including their original tailnet.** If your use case requires more than 10 tailnets, contact sales."*
> *"Tailnets created with these APIs support **only tagged devices**."*
> 블로그: *"A **per-customer or per-project tailnet** provides strong isolation… useful for **automation, OEM, and integration scenarios**."*
> Pricing add-on: *"**Multiple tailnets** — Great option for **OEM**… **Contact sales**"*

⇒ **이것이 우리 시나리오에 대한 Tailscale의 공식 답이다** — 고객마다 격리된 tailnet, 사람 사용자 0명, 전부 API. §1.5-보론의 상호도달·oort 접근권 문제도 tailnet 격리로 크게 완화된다.
⇒ **그런데 상한이 10개**다. 고객 10곳이면 끝. 게다가 **alpha**(안정 인터페이스 아님)이고 **tagged devices only**라 §2.2의 과금 축을 그대로 물려받는다.

### 2.5 봇이 사용자 대신 Tailscale 계정을 만드는 것 (M5)

- **Tailscale ToS/AUP에 "자동화된 계정 생성 금지"·"robots"·"1인 1계정" 조항은 없다**(전문 grep 결과 히트 0).
- 대신 ToS 서문: *"If you are entering into the Agreement **on behalf of** a company… you are **representing to Tailscale that you have the authority to bind such entity**."* ⇒ 봇이 대리 가입하면 **그 사용자를 계약에 구속시키는 행위**이고, 권한 없이 하면 이 진술이 허위가 된다.
- AUP의 impersonation/false-information 조항은 리드 문장이 *"on or through Tailscale community channels"*로 스코프되어 있어 직접 적용은 어렵다. 다만 집행 재량은 전면적: *"Tailscale retains **full discretion** to take action … including account suspension, account termination"*.
- **실질 차단선은 Tailscale이 아니라 IdP다.** Tailscale은 자체 비밀번호 계정이 없고 Google/GitHub/Microsoft/Apple/OIDC로만 가입한다 → 봇이 사용자 자격증명으로 IdP에 자동 로그인하는 것은 IdP 약관·2FA·CAPTCHA에 걸린다. 그리고 **ADR-0004(provider 자격증명 비유입)와 정면 충돌**한다.

⇒ **M5는 폐기.** 단, **"사용자가 자기 브라우저(또는 그록봇의 브라우저 위에서 자기 손으로) 로그인하는 것"은 전혀 다른 이야기이며 이것이 M1이다.**

### 2.6 M1(사용자 자기 tailnet)의 실제 비용 — 클릭 몇 회인가

| 단계 | 주체 | 클릭 |
|---|---|---|
| Tailscale 가입(Google/GitHub 원클릭) | 사용자 | **1~2** (IdP 동의) |
| auth key 발급 | 사용자 or 그록봇(사용자 세션 브라우저) | 1 (또는 그록봇 대행) |
| `tailscale up --authkey` · funnel 설정 | **그록봇** | 0 |
| Funnel 최초 활성 승인 (§1.9) | 사용자 | **1** (tailnet policy에 nodeAttr가 없을 때) |
| oort claim 비번 + 앱 로그인 | 사용자 | 2 (기존 예산) |

⇒ 인터뷰 성공기준 *"브라우저 클릭 2회"*는 **M1에서 4~5회로 늘어난다.** 터미널 명령은 **여전히 0회**. 이것이 성재 결정 항목 ①이다.

### 2.7 자동화 가능한 API 표면 (그록봇 파이프라인 설계 입력) [공식문서 OpenAPI]

| 단계 | 호출 | 스코프 |
|---|---|---|
| auth key 발급 | `POST /api/v2/tailnet/{t}/keys` | `auth_keys` |
| 정책파일 읽기 / 교체(ETag `If-Match`) | `GET`·`POST /api/v2/tailnet/{t}/acl` | `policy_file:read` / `policy_file` |
| HTTPS 인증서 켜기 | `PATCH /api/v2/tailnet/{t}/settings` (`httpsEnabled`) | `networking_settings` |
| MagicDNS 켜기 | `POST /api/v2/tailnet/{t}/dns/preferences` | — |
| **머신 이름 강제 지정** | `POST /api/v2/device/{id}/name` | `devices:core` |
| 노드 키 만료 해제 | `POST /api/v2/device/{id}/key` | `devices:core` |
| 헌 노드 삭제 | `DELETE /api/v2/device/{id}` | `devices:core` |
| tailnet 생성(alpha) | `POST /api/v2/organizations/{org}/tailnets` | `tailnets` |

> ★ **`POST /device/{id}/name`의 존재는 §1.6 P1/P2에 부분 구제책을 준다** — state를 잃어 `foo-1`이 됐을 때 헌 노드를 지우고 이름을 `foo`로 되돌리는 자동 복구가 이론상 가능하다. 다만 #1200이 *"Name 'foo' is already taken"*을 보고했고 API 문서도 *"any existing Magic DNS URLs using the old name will no longer work"*만 말할 뿐 회수 정책을 말하지 않는다 → **§1.8-E2가 이 폴백의 성립 여부를 결정한다.**
> ⚠️ 단, 이 자동 복구는 **API 자격증명이 VM 안에 있어야** 가능하다. M1(사용자 tailnet)에서는 사용자의 API 토큰을 VM에 두는 것이 되어 **ADR-0004 비유입 원칙과 긴장**한다. 성재 결정 항목 ③.

### 2.8 Tailnet Lock — **OFF 유지 권고**

> *"Tailnet Lock lets you verify that no node joins your tailnet unless trusted nodes in your tailnet sign the new node."* · *"Tailnet Lock is not enabled by default."* [공식문서 kb/1226]

- auth key 등록을 막지는 않지만 서명 없는 노드는 **"Locked out"**이 되어 통신 불가.
- **API에 서명 엔드포인트가 없다**(OpenAPI 경로 0개) — 서명은 신뢰 노드의 CLI(`tailscale lock sign $AUTH_KEY`)로만.
⇒ 켜면 파이프라인에 사람 단계가 강제로 끼어든다. **v1에서는 켜지 않는다**를 명문화.

### 2.9 무계정 대안 터널 — 전수 조사

평가 축 4개를 **동시에** 만족해야 한다: ⓐ계정 불요 ⓑ고정 URL(재프로비저닝 생존) ⓒWS ⓓ무료·도메인 불요·헤드리스.

| 서비스 | ⓐ계정 | ⓑ무료 고정 URL | ⓒWS | 한도 | 판정 |
|---|---|---|---|---|---|
| cloudflared **quick** | 불요 ✅ | ❌ 랜덤·프로세스 종료 시 소멸 | ✅ | 200 in-flight · 1015 per-IP | RA-5 부적합 확정 |
| cloudflared **named** | 필요 + **자기 도메인 필요** | ✅ | ✅ | ZT 무료 50 user(2차출처) | 숙련자 tier 전용 |
| **Tailscale Funnel** | 필요 | ✅ (state 영속 시 — §1) | ✅ (#18827 리스크) | 대역폭 비공개 | **B트랙 현행** |
| **localhost.run 무료** | 단기는 불요 ✅ | ❌ — *"**Domain names change regularly.**"* 가입+SSH키는 *"want the domain name to **last longer**"*일 뿐 **영구 아님** | ✅ | *"There is a **speed limit**."* · *"to prevent phishing sites from establishing themselves"* | **❌ 고정 URL 불성립** |
| localhost.run **Custom Domain** | 필요 | ✅ *"a **stable domain** for your tunnel with a priority share of the bandwidth"* | ✅ | **$9/mo(연납)** + SSH키 등록 | 유료·계정 |
| **pinggy 무료** | 불요 ✅ | ❌ **60분 타임아웃 + 서브도메인 로테이션** | ✅ | | ❌ |
| pinggy **Pro** | 필요 | ✅ persistent subdomain·custom domain | ✅ | **$2.5~3/mo** | 유료·계정 |
| **ngrok 무료** | 필요 | ✅ **static domain 1개** | ✅ | **1GB/월** · 온라인 엔드포인트 3 · **interstitial 페이지** | ❌ 1GB/월로 메신저 불가 |
| ngrok Hobbyist | 필요 | ✅ | ✅ | $10/mo · 5GB | 유료·계정 |
| bore / frp / rathole / sish / chisel / boringproxy / zrok(self-host) | — | ✅ | ✅ | **공인 IP 릴레이 호스트 + 도메인을 누군가 운영해야 함** | 그 "누군가"가 oort면 **= A트랙** |
| zrok(호스티드) | 필요(초대 토큰) | reserved share로 가능 | ✅ | | 계정 필요 |

> 출처: localhost.run/docs/forever-free · /docs/custom-domains · ngrok.com/pricing · pinggy 2026 비교자료 [공식문서 + 커뮤니티], 전부 2026-08-26 조회.

### 2.10 ★★ 이 표에서 나오는 구조적 결론

**계정 없이 고정 URL을 주는 서비스는 하나도 없다. 그리고 그것은 벤더의 인색함이 아니라 구조다.**

고정 URL은 "이 이름의 소유자가 누구인가"를 릴레이가 알아야 성립한다. 즉 **고정성 = 신원**이다. 무계정으로 이름을 예약하게 하면 즉시 스쿼팅·피싱 인프라가 된다 — localhost.run이 도메인을 돌리는 이유를 문서에 그대로 써 놓았다(*"to prevent phishing sites from establishing themselves"*). 그래서 모든 벤더에서 **"고정 URL"이 정확히 계정/과금의 경계선에 놓인다.**

⇒ **"무계정 + 고정 URL"이 성립하는 유일한 방법은 릴레이를 우리가 운영하는 것이다** — 그때는 사용자의 신원을 **oort의 claim 토큰**이 대신하기 때문이다. 그리고 그것이 바로 **A트랙**이다.
⇒ 즉 **A트랙은 "B가 실패했을 때의 폴백"이 아니라, "무계정을 제품 요구로 유지할 때의 유일한 구현"이다.** 인터뷰 §① 표의 A/B 관계가 이 리서치로 재정의된다.

---

## 3. ★ 판정

### 3.1 B트랙은 성립하는가 — **성립한다. 단 "제로 계정"을 버리고 "제로 터미널 명령"으로 재정의할 때만.**

인터뷰 §①의 B트랙 정의는 *"그록봇이 서드파티 터널을 자동 프로비저닝 + 터널 정체성(state dir)을 영속 공간에 보존 → 재프로비저닝에도 같은 URL"*이었다. 이 문장 자체는 **전부 사실로 확인됐다**:

- state dir 영속 → 같은 노드 → 같은 MagicDNS 이름 → 같은 Funnel URL. **공식 문면이 직접 보증**(§1.1).
- 인증서 캐시도 state dir 안에 있어 **LE 재발급 0회**. "34시간" 공포는 state를 잃었을 때만 세는 카운터였다(§1.4·§1.10).
- 프로비저닝 전 과정이 **API로 자동화 가능**하다 — auth key 발급·정책파일 수정·HTTPS 활성·머신 이름 고정·키 만료 해제까지(§2.7).

**깨진 것은 "터널 정체성"이 아니라 "무계정"이라는 부수 가정이다.** Funnel은 tailnet 소속이 전제이고, tailnet은 계정이 전제다. 그리고 이 진입장벽을 우회하는 세 경로가 각각 다른 벽에 부딪힌다: **M3=자동화 실패(90일마다 사람)**, **M2=약관 위반 + 규모당 과금**, **M5=IdP·대리권 벽**. 그리고 §2.10이 보여주듯 **이건 Tailscale만의 문제가 아니라 모든 무료 터널 서비스의 구조**다.

### 3.2 성립 조건 (전부 필수 — 하나라도 빠지면 불변식이 깨진다)

| # | 조건 | 근거 |
|---|---|---|
| **C1** | tailscaled state dir을 **`/workspace` 하위 bind mount**로 둔다 (Docker 명명 볼륨 금지) | §1.5 · RA-4 |
| **C2** | `TS_HOSTNAME` 명시 고정 + 콘솔 **"Auto-generate from OS hostname" 해제** | §1.6 P3 |
| **C3** | OAuth secret을 키로 쓸 때 **`?ephemeral=false`** 필수 | §2.1 — 빠뜨리면 30~60분 뒤 URL 증발 |
| **C4** | 등록 직후 **노드 키 만료 해제**(태그를 안 쓰면 API로 명시) | §1.6 P6 |
| **C5** | 성공 판정을 **외부 HTTP 200 + WS 101**로만 한다 (종료코드·로컬 status 금지) | §1.9 · §1.6 P8 |
| **C6** | tailnet policy에 funnel nodeAttr을 **미리** 넣어 CLI 대화형 승인을 우회 | §1.9 — 🧪실측 #2 |
| **C7** | Tailnet Lock **OFF** | §2.8 |

### 3.3 blocker — 3개, 성격이 각각 다르다

| | blocker | 성격 | 상태 |
|---|---|---|---|
| **B1** | **Funnel WebSocket 드롭 (GH #18827)** — `1001 Going Away` 10~40초 주기 | **기술 게이트.** 재현되면 Funnel 채택 자체가 무산 | **Open, 스태프 무응답, 2026-02-27~ 미해결** (오늘 재확인). §1.8-F가 유일한 판정 수단 |
| **B2** | **그록봇 `/workspace` 내구성 (RQ-7)** | **플랫폼 의존.** Reset이 tailscale 등록 이전 스냅샷으로 롤백하면 state 소실 → §1.6 P1/P2로 **URL 영구 상실** | 미해결. RA-4가 이미 "구독 소진 시 워크스페이스 접근 불가" 사례 기록 |
| **B3** | **Tailscale 계정 요구** | **제품 결정.** 기술 blocker 아님 | 성재 결정 대기 (§4 D-1) |

> **B1이 진짜 blocker다.** B2·B3는 설계·결정으로 흡수 가능하지만, B1은 Funnel의 대체 여부를 결정한다. **RA-7의 다음 액션은 §1.8-F(1시간 WS soak)를 최우선으로 돌리는 것**이다 — 이것 하나가 B트랙 전체의 생사를 가른다.

### 3.4 blocker가 A트랙(oort 별칭) 승격을 강제하는가

**"URL 불변식" 하나만 놓고 보면 — 강제하지 않는다.** state 영속만으로 불변식이 성립하고, A트랙 없이도 B는 자립한다(불변식 ②④ 유지).

**그러나 다음 셋 중 하나라도 참이면 A트랙이 필수가 된다:**

1. **"터미널 0회"를 넘어 "계정 0개"까지 제품 요구로 유지한다면** → §2.10에 의해 **A트랙만이 유일한 구현**이다. 이 경우 A는 "폴백"이 아니라 **기본**이 된다.
2. **B1(WS 드롭)이 재현된다면** → Funnel이 탈락하고, 무계정·고정 URL·WS를 동시에 주는 서드파티가 없으므로(§2.9) 역시 **A로 간다**.
3. **B2가 "Reset이 state를 날린다"로 확정된다면** → URL 상실이 되돌릴 수 없으므로(§1.6 P1/P2/P7), 사용자 대면 URL을 우리가 소유한 별칭으로 덮는 것 외에 복구 수단이 없다.

**A트랙 설계 제약(RQ-4로 넘길 것, 여기서 확정된 것만):**
- **단순 CNAME은 불가능하다.** Funnel은 커스텀 도메인 인증서를 발급/제시하지 않아 TLS 핸드셰이크에서 실패한다(RA-6 §1.10, GH #16478 **closed as not planned**). ⇒ A트랙은 반드시 **TLS를 종단하는 프록시**여야 한다.
- 그러면 **oort가 모든 트래픽(WS 포함)의 데이터 경로에 들어간다** — 불변식 ②(중앙 디스커버리 부재)·④(완전 독립 동작)와 정면 긴장하고, 대역폭이 곧 oort 원가가 된다.
- ⇒ **A트랙은 "가벼운 별칭"이 아니라 "oort가 릴레이 사업을 하는 것"이다.** 인터뷰 §① 표의 A 설명("CNAME/리다이렉트를 사용자 터널 URL 앞에")은 **기술적으로 성립하지 않으므로 개정되어야 한다.**

### 3.5 Fable 권고

1. **v1 = M1(사용자 자기 tailnet) + C1~C7.** oort 중앙 의존 0, 약관 깨끗, 사용자가 자기 인프라를 온전히 소유 — 셀프호스팅의 명분과 정합한다. 대가는 **브라우저 클릭 4~5회**(§2.6).
2. **M2/M3(oort tailnet에 고객 노드 수용)은 채택 금지 권고.** ToS §2.1·§2.3 위반 소지 + §11.3으로 **배상 상한 배제** + Personal 플랜 비상업 명문 금지 + §1.5-보론의 신뢰 붕괴(기본 ACL allow-all·oort가 전 고객 서버에 네트워크 접근권). 굳이 간다면 **Channel Partner Agreement 체결이 전제**이며, 그건 v1의 규모에 맞지 않는다.
3. **A트랙을 "URL 상실 폴백"에서 "무계정 tier의 유일 구현"으로 재정의**하고, 별도 ADR로 승격 여부를 결정한다(oort가 데이터 경로에 들어가는 결정이므로 경계 변경 = ADR 필수).
4. **다음 실측 1순위는 §1.8-F(WS soak) → §1.8-D(state 영속 URL 불변) → §1.8-E(파괴 실험) 순.** D는 B트랙 전제 확인, F는 생사 판정, E는 복구 폴백 존재 여부.
5. **멀티테일넷 alpha(§2.4b)는 내부 파일럿용으로 신청 가치가 있다** — 상한 10개는 제품에는 못 쓰지만, "고객별 격리 tailnet"을 실측해 볼 수 있는 유일한 공식 경로다.

---

## 4. 성재 결정 필요 항목

| # | 결정 | 선택지 | Fable 권고 |
|---|---|---|---|
| **D-1** | **계정 진입장벽** | ⓐ M1 수용 — 사용자가 Tailscale 계정 1개 생성(브라우저 클릭 4~5회, 터미널 0회) / ⓑ "무계정" 고수 → **A트랙 릴레이 자체운영이 필수 전제**가 됨 | **ⓐ**. v1에서 릴레이 사업을 시작하는 건 과하다 |
| **D-2** | **인터뷰 성공기준 개정** | 현행 *"브라우저 클릭 2회"* → *"터미널 명령 0회 · 브라우저 클릭 5회 이내"*로 수정할지 | 수정 권고 (측정 가능한 기준을 사실에 맞춤) |
| **D-3** | **oort tailnet 모델 금지 확정** | M2/M3를 설계 선택지에서 명시적으로 제외할지 | **제외 권고** (약관+신뢰 이중 사유) |
| **D-4** | **API 자격증명의 VM 유입** | 이름 자동복구·정책파일 자동수정을 위해 Tailscale API 토큰을 VM에 둘지 vs ADR-0004(자격증명 비유입) 고수 | **범위 최소화**: funnel nodeAttr는 사전 설정으로 회피하고, API 토큰은 **두지 않는 것**을 기본으로. 이름 복구는 그록봇이 사용자에게 안내하는 흐름으로 |
| **D-5** | **A트랙 정의 개정** | 인터뷰 §① 표의 A("CNAME/리다이렉트")를 "TLS 종단 프록시"로 고쳐 쓰고 별도 ADR로 올릴지 | 개정 필요 — 현행 문면은 기술적으로 불가능 |
| **D-6** | **실측 예산·순서** | §1.8-F(WS soak 1시간+)를 지금 돌릴지, T-2 플레이북 재작성보다 앞세울지 | **F를 앞세울 것.** F가 RED면 T-2 재작성이 전부 폐기된다 |
| **D-7** | **멀티테일넷 alpha 신청** | Tailscale에 alpha 참여 문의할지(상한 10) | 신청 권고 — 비용 0, 정보 가치 큼 |

---

## 5. 🧪 실측으로만 확정 가능 — 통합 목록 (우선순위 순)

| # | 항목 | 절차 | 왜 중요한가 |
|---|---|---|---|
| **1** | **Funnel WS 1시간+ 유지** | §1.8-F | **B트랙 생사.** GH #18827 재현 여부 |
| **2** | **state 영속 → URL·인증서 serial 불변** | §1.8-D | B트랙 전제 확인 |
| **3** | **state 소실 시 `-1` 발생 / 삭제 후 이름 회수 가능성** | §1.8-E | 복구 폴백의 존재 여부(#1200 반증 시도) |
| **4** | **`tailscale funnel --bg --yes`가 nodeAttr 사전부여 상태에서 프롬프트 0으로 성공하는가** | 사전 설정 tailnet에서 비-TTY 실행 | C6 성립 여부. 실패하면 브라우저 클릭 +1 |
| **5** | **certs/가 `TS_STATE_DIR` 하위인가** | §1.8-B | bind mount 범위 확정 |
| **6** | **그록봇 Update / Reset 후 `/workspace` bind state 생존** | Update·Reset 각각 1회 실행 후 §1.8-D2 | **B2 blocker 판정.** RQ-7의 실체 |
| **7** | **user-owned API access token을 API로 발급 가능한가** | `POST /api/v2/tailnet/{t}/keys {"keyType":"api"}` → 400/422? | M3의 자동화 가능성(부재 증명을 확증으로) |
| **8** | **비-컨테이너 CLI(`tailscale up --authkey=tskey-client-…`)에서도 ephemeral-by-default인가** | 실행 후 admin console 확인 | C3의 적용 범위 |
| **9** | **태그 51번째가 하드 블록인가 과금인가** | 결제수단 미등록 tailnet에서 51번째 등록 | M2 채택 시 규모 상한 |
| **10** | **Funnel 대역폭 실측치·적용 단위(노드별/tailnet별)** | 대용량 첨부 업로드 반복 | 다수 고객 수용 시 상호간섭 |
| **11** | **멀티테일넷 alpha가 셀프서브로 열려 있는가** | `POST /api/v2/organizations/{org}/tailnets` 403 여부 | D-7 판단 |
| **12** | **API-only tailnet에서 Funnel/MagicDNS/HTTPS가 동작하는가** | 위 성공 시 후속 | 성공 시 §2.4b 경로가 살아난다 |

---

## 6. 출처 (전부 2026-08-26 조회)

**Tailscale 공식**
- state/컨테이너: https://tailscale.com/docs/features/containers/docker/docker-params · https://tailscale.com/docs/reference/tailscaled
- Funnel: https://tailscale.com/docs/features/tailscale-funnel · https://tailscale.com/docs/reference/tailscale-cli/funnel · https://tailscale.com/kb/1223/funnel
- 인증서: https://tailscale.com/kb/1153/enabling-https
- 머신 이름·키 만료: https://tailscale.com/docs/concepts/machine-names · https://tailscale.com/kb/1028/key-expiry
- auth key·OAuth·ephemeral·lock: https://tailscale.com/kb/1085/auth-keys · https://tailscale.com/kb/1215/oauth-clients · https://tailscale.com/kb/1111/ephemeral-nodes · https://tailscale.com/kb/1226/tailnet-lock
- 정책파일·태그: https://tailscale.com/docs/reference/syntax/policy-file · https://tailscale.com/docs/features/tags · https://tailscale.com/docs/kubernetes-operator/ingress/expose-workload-to-internet
- 멀티테일넷: https://tailscale.com/docs/features/tailnet-creation-api · https://tailscale.com/blog/multiple-tailnets-alpha
- API 스펙: https://api.tailscale.com/api/v2?outputOpenapiSchema=true
- 가격: https://tailscale.com/pricing

**Tailscale 법무**
- ToS (Last updated 2026-08-25): https://tailscale.com/terms
- AUP: https://tailscale.com/tailscale-aup
- Channel Partner Agreement: https://github.com/tailscale/terms-and-conditions/blob/main/channel-partner-agreement/index.md
- 파트너십: https://tailscale.com/partnerships

**Tailscale 소스/이슈** (전부 [커뮤니티]·[소스코드])
- `ipn/ipnlocal/cert.go` 인증서 저장소 분기: https://github.com/tailscale/tailscale/issues/8254 (closed, PR #8255)
- `feature/acme/cert.go` 캐시·갱신 로직 · `cmd/tailscale/cli` `enableFeatureInteractive`
- ServeConfig 저장 위치: https://deepwiki.com/tailscale/tailscale/7.4-serve-and-funnel (`ipn/serve.go:28-32`)
- **#18827** WS 1001 드롭 (Open): https://github.com/tailscale/tailscale/issues/18827
- **#19508** funnel 설정 control plane 미동기화 (Open, 2026-04-24): https://github.com/tailscale/tailscale/issues/19508
- **#15702** 같은 funnel 이름 재사용 시 CT 오류 (Closed as not planned): https://github.com/tailscale/tailscale/issues/15702
- **#4371** 재설치 시 hostname 변경 (Open, 2022~): https://github.com/tailscale/tailscale/issues/4371
- **#1200** 삭제된 머신 이름 재사용 불가: https://github.com/tailscale/tailscale/issues/1200
- **#2076** logout이 머신 이름을 놓아주지 않음: https://github.com/tailscale/tailscale/issues/2076
- **#506** state 복제 시 이중 노드 충돌 (Open, 2020~): https://github.com/tailscale/tailscale/issues/506
- **#4797** `-state mem:`에서 cert 실패: https://github.com/tailscale/tailscale/issues/4797

**Let's Encrypt**
- Rate limits (5/7일, 34시간 리필): https://letsencrypt.org/docs/rate-limits/
- 인증서 수명 45일 단축: https://letsencrypt.org/2026/02/24/rate-limits-45-day-certs

**대안 터널**
- localhost.run: https://localhost.run/docs/forever-free/ · https://localhost.run/docs/custom-domains/
- ngrok: https://ngrok.com/pricing
- pinggy: pinggy.io (2026 비교자료 경유 — 가격 페이지 직접 조회 실패, [커뮤니티])

**내부 정본**
- `research/2026-08-25-selfhost-url-stability-interview.md` · `research/2026-08-25-tunnel-scalability-pricing.md`(RA-6) · `research/2026-08-23-tunnel-strategy-ra5.md` · `research/2026-08-22-grokbot-vm-persistence-ra4.md`
