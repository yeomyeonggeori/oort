# momo-cube-host 설치 런북 (CubeSandbox + display 템플릿 + 형상 A 프록시)

> 2026-08-16 INFRA-A(#1434) 실집행분. 패킷 `docs/planning/handoffs/2026-08-16-infra-install-wave-packet.md` goal A.
> 대상: **momo-cube-host** — 공인 101.79.18.230 / 사설 10.0.1.7 / Rocky 9.8 / 8vCPU·32GB / 단일 300GB XFS / nested KVM.
> 근거 정본: `research/2026-08-09-cubesandbox-d42-spike.md` §1·§8.3 · `research/2026-08-15-reachability-spike-1411.md`(F1~F8·형상 A) · ADR-0156(+증보 4 초안) · ADR-0157(+증보 1, 증보 2 초안) · ADR-0165(+증보 1, **증보 2 초안**) · `infra/cubesandbox/display-template/template.spec.json`(**specVersion 3 — track/engine 랜딩**, #1438 실기동 E2E 반영).
> **후속 실집행(#1438, 2026-08-16)**: 실화면 E2E 성립분은 §8-B/§9에 반영했다 — momo-turn relay 실증 + microVM 링크로컬 root-cause(ICE base 주입).
> **이 문서에 시크릿은 없다.** 자격은 `~/.ncp/`(0600)에만 있고 값은 어디에도 인용하지 않는다.

설치 실소요: 호스트 준비 ~4분 · one-click 설치 **2분 이내**(rc=0, 유닛 14/14 active) · 템플릿 빌드 **20~34초** · microVM create **200ms**.

---

## 0. 한 줄 판정

**전 항목 성립.** CubeSandbox v0.6.0 표준 KVM 설치 → 폐곡선 → **display 템플릿 실빌드** → **microVM 안에서 GStreamer `webrtcbin` producer 실기동** → **형상 A 프록시(8443/TLS)로 외부(개발 맥)에서 wss 시그널링 왕복 성공**까지 완주했다. LIVE-1 view-only 계약(D4 = 입력 datachannel 미개설)은 **실물 producer**에서 통과했고, `runtime-unverified(cubesandbox webrtc producer)` 3항목 중 **2항목(producerSelection·templateBuild)이 해소**된다.

동시에 **정본을 고쳐야 하는 실측 3건**이 나왔다 — §8에 분리했다. 가장 무거운 것은 **`envVars`를 실은 create가 500으로 실패한다**(어댑터가 지금 그 필드를 보낸다)는 것이다.

---

## 1. F1~F8 이행표 (스파이크 부수발견의 집행 결과)

| # | 요구 | 이행 | 실측 증거 |
|---|---|---|---|
| **F1** | 호스트 방화벽 활성(ACG 단일 실패점 제거), 설치 부품은 내부망/루프백 한정 | **이행** | `firewalld` enabled+active. 기본 존을 **trusted**로 두고 **eth0만 public**에 배치 → 인터넷 대면 인터페이스만 필터. public = `8443/tcp` + `22/tcp from 운영자IP/32` **2줄뿐**(ACG와 동일 규칙 중복 선언). nft 실물: `iifname "eth0" goto filter_IN_public`, `filter_IN_public_allow`에 정확히 2 accept. 외부 스캔: 22 OPEN · 8443 REFUSED(리스너 전) · 3000/12088/8089/9999/80/443/5000 전부 FILTERED |
| **F2** | preflight 9999/9998/9966 점유 확인 · **설치기 rc=0 불신, 유닛 상태로 판정** | **이행** | 설치 전 `ss -lntup` → 대상 포트 ALL FREE. 설치 후 rc=0이었으나 **판정은 유닛으로**: 14/14 active, `--failed` 0건, 전 유닛 `NRestarts=0`(F2가 경고한 bind 실패 재시작 루프 부재 확인) |
| **F3** | 로컬/사설 레지스트리(빌더가 로컬 docker 이미지를 못 읽음) | **이행** | `registry:2`를 **127.0.0.1:5000 / 10.0.1.7:5000 / 192.168.0.1:5000 3개 주소에만** 바인드(0.0.0.0 아님) + docker `insecure-registries`. **템플릿 빌더는 호스트에서 pull하므로 `127.0.0.1:5000` 참조로 충분**(실측: PULLING→READY 20초). 사설망 주소는 불요였으나 유지(§7 참고) |
| **F4** | `EXPOSED_ENDPOINT` 무실체 — 시그널링 프록시는 직접 구성 | **이행** | v0.6.0 `cubemastercli info --sandboxid <id>` 출력에 **`EXPOSED_ENDPOINT` 필드 자체가 없다**. 대신 **`SANDBOX_IP`가 정확히 나온다**(예: 192.168.0.12) — 프록시 upstream 결정의 정본 조회 경로(§4) |
| **F5** | docker FORWARD drop 대비 `DOCKER-USER` 예외 | **불요 판정(근거 있음)** | docker 설치 직후 `-P FORWARD DROP` 재현. 그러나 **형상 A는 FORWARD를 타지 않는다** — nginx가 TCP를 종단하고 호스트가 새 연결을 개시하므로 INPUT/OUTPUT 경로다. **`DOCKER-USER`를 빈 채로 두고 외부→microVM wss 왕복이 성립**함을 실증(§4). F5는 형상 C(DNAT) 전용 항목 |
| **F6** | `192.168.0.1:8443`/`:80` 점유 회피 | **이행** | 이 호스트에서도 **`192.168.0.1:8443` 점유 확인**(CubeNet 게이트웨이 nginx), `0.0.0.0:80`은 cube-proxy. → 프록시를 **`10.0.1.7:8443`에 명시 바인드**해 8443을 **포기하지 않고** 회피(스파이크는 8444로 우회했다). stock nginx의 기본 `:80` server 블록은 제거 |
| **F7** | 단일 대용량 XFS로 d42 bind-mount·xattr 사고 회피 | **전제 충족·유지** | `/dev/vda2` 299GB 단일 XFS(`ftype=1`), `/data` 분리 없음, bind-mount 0건, `rsync -aX` 구간 없음. 설치 후 점유 17GB/299GB |
| **F8** | 검증이 refused/timeout 양태를 **모두** 수용 | **이행** | 본 런북의 모든 점검이 양태를 구분해 기록한다. 실측 이분법: **REFUSED = 경로는 열렸고 리스너가 없음**(8443 프록시 기동 전), **TIMEOUT/FILTERED = 차단**(ACG/firewalld). in-VM 경계 측정은 D1/D2가 전부 **`errno=111 REFUSED`**(d42의 timeout과 다름 — 스파이크 F8 재확인) |

**SELinux**: 이 호스트는 NCP Rocky 9.8 이미지 기본값으로 **`SELINUX=disabled`**(커널 cmdline 무관, `/etc/selinux/config`). CubeSandbox 설치기는 SELinux를 **전혀 다루지 않는다**(`online-install.sh`에 selinux/setenforce 문자열 0건). Enforcing 전환은 config 수정 + 전체 relabel + **재부팅 2회**가 필요하고, 본 워커에는 **웹 콘솔 접근이 없어 부팅 실패 시 복구 수단이 없다**. → **동결·미이행**으로 보고하고 이미지 기본값을 유지했다. 집행하려면 콘솔을 여는 유지보수 창에서 §9 절차로.

---

## 2. 설치 절차 (실행 검증된 순서)

```sh
# [0] preflight — 게이트 9종 + F2 포트 점유
ls -la /dev/kvm                       # nested KVM 필수 (Intel VT-x 확인)
grep MemTotal /proc/meminfo           # >= 7,500,000 kB
stat -fc %T / ; xfs_info / | grep ftype=1
stat -fc %T /sys/fs/cgroup            # cgroup2fs
cat /sys/fs/cgroup/cgroup.controllers # cpu 포함 확인
grep -w bpf /proc/filesystems ; mount | grep /sys/fs/bpf
ldd --version | head -1               # >= 2.31 (실측 2.34)
ip -br a                              # 사설 CIDR가 192.168.0.0/18·10.244.x와 비충돌
ss -lntup | grep -E ':(9999|9998|9966|3000|8089|12088)\b'   # ★ F2: 반드시 비어 있어야
```

```sh
# [1] cgroup +cpu — 실측상 subtree_control 기본값은 "memory pids"뿐
echo +cpu > /sys/fs/cgroup/cgroup.subtree_control
# 재부팅 지속화(systemd가 root subtree에 cpu를 켜도록):
mkdir -p /etc/systemd/system.conf.d
printf '[Manager]\nDefaultCPUAccounting=yes\n' > /etc/systemd/system.conf.d/10-momo-cpu-accounting.conf
```

```sh
# [2] docker-ce (CubeSandbox 필수 의존)
dnf install -y dnf-plugins-core
dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
dnf install -y docker-ce docker-ce-cli containerd.io && systemctl enable --now docker
# 실측: docker 29.7.2 / containerd 2.3.3. 설치 직후 iptables -P FORWARD DROP 이 됨(F5)
```

```sh
# [3] 설치 (표준 KVM 모드 — CUBE_PVM_ENABLE 미설정)
curl -sL https://github.com/tencentcloud/CubeSandbox/raw/master/deploy/one-click/online-install.sh \
     -o /root/install/online-install.sh
bash /root/install/online-install.sh --node-ip=10.0.1.7
```

```sh
# [4] ★ F2 판정 — rc=0을 성공 근거로 쓰지 않는다
systemctl list-units 'cube*' --all --no-legend | awk '{print $1,$3,$4}'   # 14개 active 기대
systemctl --failed --no-legend                                            # 0줄이어야
for u in $(systemctl list-units 'cube*' --no-legend | awk '{print $1}'); do
  echo "$u NRestarts=$(systemctl show -p NRestarts --value $u)"; done      # 전부 0이어야
curl -s http://127.0.0.1:3000/health                                       # {"status":"ok",...}
```

> `cube-sandbox-compute.target`은 `inactive(dead)`가 **정상**이다(단일 노드는 role=control, cubelet은 control.target이 끌어올린다). 개별 `cube-sandbox-*.service`가 `is-enabled=disabled`인 것도 정상 — **`cube-sandbox-control.target`만 enabled**이고 나머지는 그 target이 Wants로 끌어온다.

---

## 3. F1 방화벽 (락아웃 없이 적용하는 순서)

> **먼저 데드맨을 걸어라.** 22를 필터링하는 순간이 락아웃 위험 지점이고, 이 호스트에는 콘솔 복구 수단이 없다.

```sh
# [0] 7분 뒤 자동 원복 — 정상 확인 후 해제
systemd-run --on-active=420 --unit=momo-fw-rollback systemctl stop firewalld

# [1] 호스트가 실제로 보는 소스 IP를 확인(공인 NAT가 1:1인지)
ss -tnp state established '( sport = :22 )'

# [2] 존 설계: 기본=trusted, eth0만 public
#     CubeNet tap(z192.168.x.x 수백 개)·docker 브리지를 일일이 넣지 않아도 되고,
#     인터넷 대면 인터페이스 하나만 필터하면 되기 때문이다.
firewall-offline-cmd --set-default-zone=trusted
firewall-offline-cmd --zone=public --add-rich-rule='rule family=ipv4 source address=<운영자IP>/32 port port=22 protocol=tcp accept'
firewall-offline-cmd --zone=public --add-port=8443/tcp
# 기본 서비스(ssh/cockpit/dhcpv6-client) 제거는 firewall-offline-cmd가 거부한다
# ("Can't use lokkit options with other options") → 존 XML에서 직접 지운다:
sed -i '/<service name="ssh"\/>/d;/<service name="dhcpv6-client"\/>/d;/<service name="cockpit"\/>/d' \
    /etc/firewalld/zones/public.xml

systemctl enable --now firewalld
systemctl restart docker            # firewalld가 체인을 flush하므로 docker가 자기 체인을 다시 깐다

# [3] ★ 함정: eth0은 NetworkManager 소유라 존 XML의 <interface>가 무시된다.
#     이 단계를 빼면 eth0이 default(trusted)에 남아 방화벽이 사실상 무력해진다.
firewall-cmd --get-zone-of-interface=eth0        # 이 시점에 trusted 로 나오면 아래를 실행
nmcli connection modify "System eth0" connection.zone public
firewall-cmd --zone=public --change-interface=eth0     # 링크 바운스 없이 즉시 적용
firewall-cmd --runtime-to-permanent
```

검증(전부 통과해야 데드맨 해제):

```sh
firewall-cmd --get-zone-of-interface=eth0        # public
firewall-cmd --zone=public --list-all            # ports 8443/tcp + rich rule 22 만
firewall-cmd --permanent --zone=public --list-rich-rules   # ★ 영구에도 있어야(없으면 재부팅 락아웃)
firewall-cmd --reload && firewall-cmd --zone=public --list-all   # reload 후에도 유지되는지
ssh <새 세션>                                     # 기존 연결이 아니라 새 TCP로 확인
systemctl stop momo-fw-rollback.timer            # 전부 통과한 뒤에만
```

실측 결과: `--reload`(재부팅 근사) 후에도 eth0=public·8443·rich rule 전부 유지, cube 유닛 15 active·0 failed, 레지스트리/게스트/프록시 전부 200 유지.

---

## 4. display 템플릿 + 형상 A 프록시

### 4.1 사설 레지스트리 (F3)

```sh
printf '{\n  "insecure-registries": ["127.0.0.1:5000", "10.0.1.7:5000", "192.168.0.1:5000"]\n}\n' \
  > /etc/docker/daemon.json
systemctl restart docker
docker run -d --restart=always --name momo-registry \
  -p 127.0.0.1:5000:5000 -p 10.0.1.7:5000:5000 -p 192.168.0.1:5000:5000 \
  -v /var/lib/momo-registry:/var/lib/registry registry:2
ss -lnt | grep :5000        # ★ 0.0.0.0 이 없어야 한다(F1 "설치 부품은 내부망 한정")
```

### 4.2 템플릿 빌드

producer 자산(`Dockerfile` · `entrypoint.sh` · `momo-display-producer` + PID1 수신기 `../bootstrap-init/momo-bootstrap-init`)은 **이제 레포에 있다** — `infra/cubesandbox/display-template/`(#1455 랜딩, track/engine). 호스트 빌드 컨텍스트(`/root/build/display/`)는 이 레포 자산을 복사해 구성한다(수신기는 `bootstrap-init/`에서 빌드 컨텍스트로 복사 — Dockerfile이 `COPY momo-bootstrap-init …`을 기대). §8-C의 "레포 미반영"은 해소됐다.

```sh
docker build -t 127.0.0.1:5000/momo-display:v1 /root/build/display
docker push 127.0.0.1:5000/momo-display:v1

cubemastercli tpl create-from-image \
  --image 127.0.0.1:5000/momo-display:v1 \
  --alias momo-display \
  --writable-layer-size 4Gi \
  --expose-port 8452 --probe 8452 --probe-path /health \
  --memory 2000 --cpu 2000 \
  --with-cube-ca=false            # ★ CubeEgress MITM 루트 CA 주입 방지(ADR-0157 증보 1)
```

실측 34초 → `READY`. 템플릿이 담는 것: Xvfb(:0, 1280x720x24) + GStreamer 1.22 `webrtcbin` producer + stdlib WebSocket 시그널링(8452, `/health` 겸용).

### 4.3 microVM 기동 — **`envVars`를 실으면 안 된다**

```sh
# ★ 실측 Blocker: envVars 를 실은 create 는 500 으로 실패한다(§8-A)
curl -s -X POST http://127.0.0.1:3000/sandboxes -H 'Content-Type: application/json' \
  -d '{"templateID":"momo-display","timeout":1800,"lifecycle":{"onTimeout":"kill"},
       "metadata":{"momo_goal":"INFRA-A"}}'
# 설정은 템플릿 빌드 시 --env 로 굽는다.
```

### 4.4 형상 A 프록시 (`/etc/nginx/conf.d/momo-display.conf`)

```sh
dnf install -y nginx
# ★ F6: stock nginx의 기본 :80 server 블록을 제거해야 한다(cube-proxy가 :80 점유)
#   Rocky 기본 nginx.conf의 server{...} 블록을 삭제 — 주석 처리된 :443 예시는 그대로 둬도 무방
mkdir -p /etc/nginx/tls
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout /etc/nginx/tls/display.key -out /etc/nginx/tls/display.crt \
  -subj "/CN=momo-cube-host" -addext "subjectAltName=IP:101.79.18.230,IP:10.0.1.7"
chmod 600 /etc/nginx/tls/display.key
```

```nginx
map $http_upgrade $momo_connection_upgrade { default upgrade; "" close; }

upstream momo_display_producer {
    server 192.168.0.12:8452;        # ← cubemastercli info --sandboxid <id> 의 SANDBOX_IP
}

server {
    listen 10.0.1.7:8443 ssl;        # ★ F6: 0.0.0.0:8443 은 192.168.0.1:8443(CubeNet gw)와 충돌
    server_name _;
    ssl_certificate     /etc/nginx/tls/display.crt;
    ssl_certificate_key /etc/nginx/tls/display.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    location /display/signal/ {
        proxy_pass http://momo_display_producer;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $momo_connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;             # 형상 A가 C를 이긴 이유
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s; proxy_send_timeout 3600s;
        proxy_buffering off;
    }
    location = /healthz { return 200 "ok\n"; }
}
```

> `Sec-WebSocket-Protocol`은 nginx가 요청/응답 양방향으로 그대로 통과시키므로 별도 지시어가 필요 없다 — capability는 클라이언트가 두 번째 토큰으로 제시하고, producer는 **bare 서브프로토콜만** 되돌린다.
> **upstream은 지금 손으로 박은 단일 샌드박스**다. 샌드박스마다 라우팅하려면 컨트롤플레인이 `sandboxID → SANDBOX_IP` 맵을 nginx 스니펫으로 써 주고 `nginx -s reload` 해야 한다(§8-C).

### 4.5 왕복 검증

```sh
# 호스트 내부
curl -sk https://10.0.1.7:8443/healthz
curl -s http://<SANDBOX_IP>:8452/health

# 외부(개발 맥) — 계약 정본의 뷰어 절반을 그대로 사용
python3 viewer_check.py 101.79.18.230 8443 --tls --path=/display/signal/<displayId>
```

---

## 5. 실측 증거 (완주 기록)

### 5.1 폐곡선 (momo-smoke 템플릿)

| 연산 | 실측 | d42 대비 |
|---|---|---|
| create | **200 ms** | 295 ms보다 빠름 |
| GET | 6 ms | — |
| pause(2000MB) | **1,183~1,874 ms** = **0.59~0.94 s/GiB** | d42 0.67~0.87 s/GiB 재현 → **`pauseSecondsPerGiB: 1.0`(보수) 권고 유지** |
| connect(resume) | **95 ms**, state=running, 게스트 워크로드 200 유지 | pause/resume 메모리 스냅샷 보존 재확인 |
| DELETE | 401~455 ms → GET 404 → 재DELETE 404(멱등) | 일치 |
| **이미 paused인데 pause** | **500** `CubeMaster returned error code 130490: sandbox is already paused` | **d42 Blocker-1 그대로 재현**(다른 호스트·같은 버전) |

- **신규**: `POST /sandboxes/{id}/connect`는 **`Content-Type: application/json`이 없으면 415**다. d42가 기록하지 않은 항목 — 어댑터는 빈 바디라도 헤더를 실어야 한다.
- 게스트 실체: `containerd-shim-cube-rs` 프로세스 + tap `z192.168.0.x` UP + 게스트 HTTP 200. 호스트→게스트 직결 **1.5~2.9 ms**(스파이크 양성대조 1.6 ms와 일치).

### 5.2 display producer — LIVE-1 계약 (실물 통과)

microVM 안의 실제 `webrtcbin` producer에 대해, 계약 정본 `scripts/display_signaling_probe.py`의 **뷰어 절반과 단정을 import해서** 돌린 결과:

```
[viewer] ready: display_id=display-microvm-1 mode=observer input_enabled=False codec=H264
[viewer] offer OK: m=video present, a=sendonly, NO m=application
[viewer]   rtpmap: ['a=rtpmap:96 H264/90000']
[viewer] ice: 3 candidate(s), 0 relay
[viewer] open_input refused by name: {'type': 'error', 'reason': 'view_only'}
[viewer] PASS subprotocol/ready/offer/view_only/no_input against a REAL producer
```

- **D4 성립(실물)**: offer에 `m=application`/`webrtc-datachannel` 부재, `a=sendonly` 존재. `open_input`은 이름으로 거절되고 스트림은 유지된다.
- **D5 성립**: producer에 쓰기 가능 경로 없음, 녹화 플래그 없음.
- **fail-closed 실증**: `MOMO_SERVER_ORIGIN`이 없고 stub도 없는 템플릿에서는 **모든 capability가 401**로 거절됐다(서버가 보증하지 않은 토큰은 소켓이 되지 않는다).
- 음성 대조: capability 없는 핸드셰이크 **400**, 형식 불일치 capability **401**.
- 실캡처 증거: 라이브 X 디스플레이 30프레임 H264 인코딩 27,553 바이트.

### 5.3 형상 A 외부 왕복 (개발 맥 → 인터넷 → 8443 → microVM)

```
[viewer] TLS TLSv1.3 cipher=TLS_AES_256_GCM_SHA384
[viewer] PASS subprotocol/ready/offer/view_only/no_input against a REAL producer
```

TCP connect **6.5 ms**(스파이크 7.3 ms와 일치) · TLS 핸드셰이크 330 ms(자체서명 최초) · 전체 계약 왕복 120~190 ms.

**ICE 후보는 전부 라우팅 불가 주소였다** — `169.254.68.6`(tap 링크로컬)과 `fe80::…`뿐, **srflx 0개·relay 0개**. 브라우저가 이 후보로 미디어를 붙일 방법은 없다. **ADR-0165 증보 1의 "relay가 유일 경로"가 producer 실물에서 재확인**된다.

### 5.4 in-VM 경계 (ADR-0157 D1/D2/D3)

envd가 없어 exec 경로가 없으므로, 진단을 PID1로 굽는 템플릿(`momo-netcheck2`)으로 측정했다.

| 대상 | 결과 |
|---|---|
| D1 호스트 CubeAPI `10.0.1.7:3000` | **REFUSED** `errno=111` |
| D1 호스트 cubelet `10.0.1.7:9999` | **REFUSED** |
| D1 CubeNet gw `192.168.0.1:8443` | **REFUSED** |
| D1 사설 레지스트리 `10.0.1.7:5000` | **REFUSED** |
| D2 피어 샌드박스 `192.168.0.12:8452` | **REFUSED** (피어 격리 성립) |
| D3 공인 인터넷 `1.1.1.1:443` | **CONNECTED** |
| D3 공인 STUN UDP | **REPLY** `srflx=101.79.18.230:30005` (아웃바운드 UDP 정상) |
| **D3 헤어핀 `https://101.79.18.230:8443/healthz`** | **HTTP 200 `body='ok'`** ← §8-B |

---

## 6. 재설치 절차

호스트를 갈아엎고 다시 세울 때: §2 [0]~[4] → §3 → §4.1 → §4.2 → §4.4. 총 실소요 15분 내외.

부분 복구:

```sh
# 스택만 재기동
systemctl restart cube-sandbox-control.target && systemctl --failed

# 프록시만
nginx -t && systemctl reload nginx

# 레지스트리만 (restart=always 라 보통 불필요)
docker start momo-registry

# 템플릿 재빌드(이미지가 레지스트리에 남아 있으면 pull 없이 20~34초)
cubemastercli tpl list
cubemastercli tpl delete --template-id <id>
```

**샌드박스가 바뀌면 프록시 upstream을 갱신해야 한다** — 이것이 현재 구성의 유일한 수동 결선이다:

```sh
NEW_IP=$(cubemastercli info --sandboxid <sandboxID> | awk '/^SANDBOX_IP/{print $2}')
sed -i "s/server .*:8452;/server ${NEW_IP}:8452;/" /etc/nginx/conf.d/momo-display.conf
nginx -t && systemctl reload nginx
```

---

## 7. 현재 호스트 상태 (인수 시점)

| 항목 | 상태 |
|---|---|
| CubeSandbox | **v0.6.0**, 표준 KVM, 유닛 14 active / 0 failed |
| 템플릿 | `momo-display`(LIVE-1 producer, fail-closed) · `momo-smoke`(폐곡선용) · `momo-netcheck2`(경계 진단용) |
| 실행 중 샌드박스 | **0** (측정용 전량 회수, UP tap 0) |
| firewalld | enabled+active, eth0=public, 8443/tcp + 22(운영자IP) **2줄** |
| nginx | enabled+active, `10.0.1.7:8443` TLS(자체서명) |
| 레지스트리 | `momo-registry` restart=always, 내부 3주소 바인드 |
| 디스크 / 메모리 | 17 GB / 299 GB · 기저 3.3 GB (d42 3.1 GB와 일치) |
| SELinux | **disabled**(이미지 기본값 유지 — §1 각주·§9) |

---

## 8. 정본을 고쳐야 하는 실측 (인계 항목)

### A. **[Blocker] `envVars`를 실은 create는 500으로 실패한다**

```
HTTP 500 — CubeMaster returned error code 130497:
create_time_env_vars init failed after bounded retry;
template does not carry envd support annotation:
envd init request failed: Post "http://192.168.0.7:49983/init": connection refused
```

- **범용 현상이다** — display 템플릿과 smoke 템플릿에서 동일 재현. `envVars`를 빼면 즉시 201.
- 원인: `cubemastercli tpl create-from-image`가 만드는 템플릿에는 **envd가 없다**(게스트 오픈 포트가 노출 포트 1개뿐, 49983 닫힘). d42 §3.5가 "envVars 주입 동작함"으로 기록한 것은 **envd를 품은 e2b 계열 `sandbox-code` 이미지를 썼기 때문**이며, 우리 자체 이미지에는 해당되지 않는다.
- **영향**: `server-rust/crates/momo-t3/src/provider/cubesandbox.rs`의 `create_body`가 `envVars`(=`workd_env_vars`)를 보낸다. **현 어댑터로 우리 템플릿을 프로비저닝하면 create가 통째로 500이 된다.**
- 선택지: ①템플릿 빌드 시 `--env`로 굽는다(본 goal이 쓴 방법) ②템플릿에 envd를 넣는다(그러면 exec/SDK 경로도 함께 살아난다) ③어댑터가 `envVars`를 빼고 다른 경로로 주입한다. **결정은 ADR 사안**이며, d42 미해소 **N2가 이것으로 해소**된다.
- 부수: envd 부재 = **샌드박스 내부 로그·exec 접근 수단 없음**. 본 goal이 진단을 PID1로 구워야 했던 이유다.

### B. **스파이크의 "헤어핀 불가"가 TCP에서는 반증됐다**

스파이크 §3은 `VM → 호스트 자기 공인 IP UDP/TCP (헤어핀) → 둘 다 실패`로 기록했고, **ADR-0165 증보 1의 "TURN은 CubeSandbox 호스트에 동거 불가"가 이 실측 위에 서 있다.**

이 호스트에서는 microVM이 **호스트 공인 IP로 TLS+HTTP 왕복을 완주**했다 — `HTTP 200 body='ok'`, 그리고 **nginx 접근 로그에 소스 `101.79.18.230`으로 기록**됐다(= 진짜로 우리 서비스에 도달). 차이의 유력한 원인은 스파이크가 **ACG에 열려 있지 않은 포트로** 헤어핀을 시험했다는 점이다.

- **주의 — 결론을 뒤집는 것은 아니다.** TURN이 필요로 하는 것은 **UDP** 헤어핀이고, 그것은 **미측정**이다(ACG에 UDP 규칙이 없고 본 워커는 ACG를 만지지 않는다). 대역폭 격리라는 별도 근거도 남아 있다.
- **요구**: 증보 1의 근거 문장을 "헤어핀 불가(실측)"에서 **"TCP 헤어핀은 성립, UDP 헤어핀 미측정"**으로 정정하거나, ACG에 임시 UDP 규칙을 열고 재측정할 것. 근거가 틀린 채로 서 있는 Accepted 결정이다.
- 부수 함정(F8 계열): 이 건은 `connect()` 성공만으로 판정했다면 **오판**이었다. 처음 TCP 핸드셰이크만으로는 nginx 로그에 아무것도 남지 않았고, **실제 HTTP 요청을 보내고 응답을 읽어서야** 도달이 확정됐다. 검증 스크립트는 핸드셰이크가 아니라 **응답**을 근거로 삼아야 한다.

**★ 해소(#1438, 2026-08-16 실기동 E2E) — relay 실증 + 링크로컬 root-cause.** 별도 공인 호스트 **momo-turn**(223.130.142.109)으로 실화면 E2E가 성립했다: coturn이 `ALLOCATE`+`CHANNEL_BIND` 성공을 **양측**에서 로깅 — producer(호스트 egress 101.79.18.230) + browser(39.115.69.188), transport **`udp`·`tcp` 양쪽**, 미디어 후보쌍 relay↔relay. 외부 브라우저가 1280x720 H264를 56프레임 디코드.
- **증보 1 D3-2("TURN=별도 전용 호스트")는 실측 확정**되고, 위 "UDP 헤어핀 미측정"은 **momo-turn이 CubeSandbox 호스트와 별도라 배치상 무의미**해진다(헤어핀은 동거 가설의 잔여 질문 — 비임계, 롤백 트리거 아님). ACG UDP 재측정은 §9 item 6에서 **비임계로 강등**.
- **더 깊은 발견(= ADR-0165 증보 2 초안 사안)**: TURN을 결선하고 microVM이 TURN에 도달 가능해도 producer가 **후보 0**을 방출했다. 원인 = guest `eth0`가 **링크로컬 전용**(169.254.68.6/30, fe80::) → libnice가 TURN을 등록하지만 링크로컬 base에서 후보 디스커버리를 스케줄하지 않는다(`Candidate gathering FINISHED, no scheduled items`). **처방(실측 성공)**: `entrypoint.sh`가 producer 기동 전 라우팅 가능 RFC1918(`10.99.0.2/24` = `MOMO_ICE_BASE`)를 `eth0`에 추가 → libnice가 base로 삼아 relay 할당, CubeNet gw가 호스트 공인 IP로 MASQUERADE. 그래서 rootfs에 `iproute2`가 필요하고 `template.spec.json` `network.iceBase.required=true`가 계약이 됐다. 컨테이너의 동일 producer엔 불필요(이미 172.17.x RFC1918) — microVM 링크로컬 posture 고유. **결재 대기**: ADR-0165 증보 2 초안.

### C. 템플릿 계약(`template.spec.json`) — v2 대비 실물 차이는 specVersion 3에서 해소

| 계약 필드 (v2) | 실물 | specVersion 3 반영 (#1438) |
|---|---|---|
| `network.mediaUdpPortRange: [50000, 50100]` | **강제 불가**. GStreamer 1.22 `webrtcbin`에 포트 레인지 속성이 없다. 게다가 `webrtcbin.get_property("ice-agent")`는 **PyGObject에서 ICE 객체를 파괴한다**(읽는 행위가 부작용 — 이후 모든 협상이 `GST_IS_WEBRTC_ICE` assertion으로 사망). **읽지 말 것.** | **해소** — `mediaUdpPortRange.enforced=false`로 명문화(+ relay 토폴로지에선 인터넷 대면 포트는 momo-turn의 49152–65535라 무의미). "`ice-agent` 읽지 말 것"은 producer 주석·스펙에 각인 |
| `momo-display-producer.service`(systemd 유닛) | `create-from-image` 템플릿에는 **systemd도 envd도 없고 이미지 CMD가 PID1**이다. 유닛 파일은 이 기재에서 실행되지 않는다 — 순서(X→producer)를 entrypoint로 옮겨야 한다. | **해소** — `.service` **삭제**, 순서를 `entrypoint.sh`로 이관, `Dockerfile` CMD = `momo-bootstrap-init -- entrypoint.sh`(PID1 수신기). 레포 랜딩 완료 |
| `signalling.validateRoute` | 서버 부재로 **미검증**(stub 경로로만 왕복) | **LIVE-5c에서 해소(§8-D)** — producer가 `momo.work_host.request.v2` Ed25519 서명을 붙여 실서버 `validate`를 호출하고 200 + `input_enabled`를 받는다. #1438의 `MOMO_DISPLAY_STUB_VALIDATE=1`은 서버 없는 설치 goal 전용 탈출구로만 남는다 |
| `ice.stun: []`, `ice.turn: null` | 실물 기본값과 일치. 결과적으로 후보가 **링크로컬뿐** → 브라우저 도달 불가 확정(§5.3) | **해소** — `ice.policy=relay` + `ice.turn.required=true`(oort momo-turn) + `network.iceBase`(라우팅 가능 base 주입)로 링크로컬 문제 우회. ADR-0165 **증보 2 초안**(성재 결재 대기) |

**producer 자산은 이제 레포에 있다**(#1455 랜딩, track/engine): `infra/cubesandbox/display-template/`의 `Dockerfile`·`entrypoint.sh`·`momo-display-producer`·`template.spec.json`(specVersion 3) + PID1 수신기 `../bootstrap-init/momo-bootstrap-init`. **템플릿이 굽는 것은 레포에서 리뷰 가능해야 한다**는 원칙(`infra/workd/*.service`의 이유)이 충족됐다. `chore/1414-display-state-captures` 참조는 폐기.

### D. LIVE-5c(#1565) — 입력 절반이 붙었다. 실측 3건은 **문서가 아니라 코드를 고쳤다**

specVersion **4**. producer가 이제 ①서버가 승인한 동안에만 datachannel을 열고 ②프레임을 파싱해 XTEST로 주입하며 ③`validate`를 work-host 키로 **서명**한다. 아래 3건은 전부 "돌려 보기 전에는 알 수 없었던" 것들이다.

| # | 실측 | 원인과 처방 |
|---|---|---|
| **D-1** | **`bundle-policy=none`이면 키보드가 영영 안 온다** | webrtcbin 기본값은 m-line마다 별도 ICE/DTLS 전송을 요구한다. m-line이 **하나뿐이던 #1438에선 보이지 않았다**. `m=application`이 붙는 순간 ICE는 `completed`까지 가고 연결은 DTLS에서 `failed` — **화면은 붙고 키보드만 안 오는데 어떤 로그도 이유를 말하지 않는다**. 처방: producer가 협상 전에 `bundle-policy=max-bundle`을 세운다(브라우저가 협상하는 값이기도 하다) |
| **D-2** | **시그널링 침묵 30초면 세션이 죽었다** | 협상이 끝나면 시그널링 소켓은 **조용해진다**(입력은 datachannel, 미디어는 ICE). 그런데 세션 루프가 `recv` 타임아웃을 **종료**로 취급해, 마지막 ICE 후보 ~30초 뒤 모든 세션이 죽었다 → **재검증이 단 한 번도 실행되지 않았고**, control window 리스는 갱신되지 않았으며, 사람의 키보드는 30초쯤에 멈췄다. LIVE-5c 이전엔 세션을 그만큼 길게 붙잡아 본 것이 없어서 드러나지 않았다. 처방: 루프를 **시계**로 돌린다 — `select` 대기(틱 5초), 타임아웃은 재검증 틱이지 종료가 아니다. `select`인 이유는 프레임 중간 타임아웃이 채널을 desync하기 때문 |
| **D-3** | **자격 TTL은 실행 중 스트림을 끊지 않는다** (§9-7 참조) | coturn은 REST username의 만료를 **ALLOCATE에서** 검증하고, 이미 존재하는 allocation의 **REFRESH에선 다시 보지 않는다**. TTL 60초로 200초 소크 — 타이핑 비트 10/10 전달(마지막 t+180s), relay-only. `unverified.credentialCeiling`이 예측한 "TTL 넘으면 화면이 까매진다"는 **성립하지 않는다** |

**서명 자격 배달**: work-host Ed25519 seed는 등록 토큰과 **같은 길**로 간다 — `envVars`의 `MOMO_WORK_HOST_SIGNING_KEY` → `momo-bootstrap-init`이 0600 파일로 랜딩 → 워크로드엔 `MOMO_WORK_HOST_KEY_PATH`(값이 아니라 **경로**)만 준다. `/proc/<pid>/environ`은 샌드박스 안 아무나 읽지만 0600 파일은 아니다. 프록시 인증서는 `MOMO_DISPLAY_SERVER_CA_PEM_B64`(공개 인증서, base64 — envVars 검증기가 제어문자를 거부하므로)로 실어 entrypoint가 파일로 쓴다. **검증을 끄지 않는다**: 자체서명 leaf는 자기 자신으로 검증되므로 그 한 장을 지목하는 것이지 아무거나 받는 것이 아니다.

**호스트 실측(2026-08-18)**: 템플릿 **`momo-display4`**(tpl-a265734126184a2e8aedede0) READY. 이 템플릿으로 microVM을 **실제로 띄웠고**(sandbox `70050f4f…`, `envVars` 실은 create가 **201** — #1437 수신기가 새 코드에서도 산다), `/health` 200, 형상 A 프록시 업스트림 재결선 후 **view-only 계약이 그대로였다**:

```
ready: {'display_id': 'display-live5c-host', 'mode': 'observer', 'input_enabled': False, 'codec': 'H264'}
PASS view-only intact on the real microVM: no m=application, a=sendonly
```

즉 **입력 절반을 넣은 producer가 관전자에겐 여전히 아무 입력 경로도 열지 않는다**는 것이 실기재에서 확인됐다(D4 무회귀).

**아직 못 한 것은 microVM 안에서의 controller 왕복 하나**다. producer의 `validate`가 **microVM에서 닿는 momo-server**를 요구하는데, 로컬 서버를 호스트로 터널링하는 것도 호스트에 서버를 세우는 것도 이 goal의 권한 밖이었다(§9-8). 입력 왕복 자체는 **같은 producer 이미지**를 상대로 측정했다(`scripts/display_input_e2e.py`).

---

## 9. 남은 것 (동결·후속)

| # | 항목 | 상태 |
|---|---|---|
| 1 | **SELinux Enforcing** | **동결** — 이미지가 `disabled`, 전환에 relabel+재부팅 2회 필요, 콘솔 복구 수단 없음. 유지보수 창에서: `SELINUX=permissive` → `touch /.autorelabel` → 재부팅 → 로그 확인 → `enforcing` → 재부팅 |
| 2 | **실인증서(TLS)** | 자체서명 임시. 실인증서는 패킷에서 "후속 명시"로 유보됨 |
| 3 | **프록시의 capability 토큰 검증** | 미구현 — 현재 nginx는 무검증 통과이고 검증은 producer가 한다. 스파이크 §6-2가 지목한 "형상 A의 이점(클라이언트 IP 보존 지점에서 검증)"은 아직 미실현 |
| 4 | **per-sandbox 라우팅** | 수동 결선(§6). 컨트롤플레인이 맵을 써야 함 |
| 5 | **producer 미디어 실도달** | **✅ 해소(#1438)** — momo-turn relay로 외부 브라우저 실화면 도달(1280x720 H264 56프레임, relay↔relay, udp+tcp). 도달 요건은 **relay 강제 + 라우팅 가능 ICE base 주입**(링크로컬 root-cause, §8-B). ADR-0165 증보 2 초안. **잔여**: 실서버 `validate` 결선(#1438은 `STUB_VALIDATE`) · input delivery(LIVE-5) |
| 6 | **UDP 헤어핀 재측정** | **비임계로 강등(#1438)** — momo-turn이 CubeSandbox 호스트와 **별도 공인 호스트**라 헤어핀은 배치 토폴로지에 불필요(동거 가설의 잔여 질문일 뿐). ACG UDP 규칙 신설은 동거를 시도할 때만 필요 |
| 7 | **재부팅 생존** | **미시험**(콘솔 복구 수단 부재로 의도적 회피). 대신 `firewall-cmd --reload`로 근사 검증했고, 모든 유닛의 `enabled` 상태·NM zone·레지스트리 `restart=always`를 정적으로 확인했다 |
| 8 | **microVM 안에서의 input delivery** | **미측정(LIVE-5c 잔여)** — 템플릿 `momo-display4`는 READY로 올라가 있고 입력 절반은 **같은 producer 이미지**에서 실측됐다(§8-D). 남은 것은 microVM + relay 경로에서의 동일 왕복이며, 막힌 지점은 하나다: producer의 `validate`가 **microVM에서 닿는 momo-server**를 요구한다. 로컬 서버를 호스트로 터널링하는 것도, 호스트에 서버를 세우는 것도 이 goal의 권한 밖이었다. **선행 조건**: momo-cube-host가 도달할 수 있는 momo-server 인스턴스(공인 배포 또는 §4.4 nginx에 `/v1/` 업스트림 추가) |
| 9 | **자격 TTL 천장(remint)** | **측정 완료 → 구현 불요(§8-D-3)**. coturn은 ALLOCATE에서만 REST username 만료를 보고 기존 allocation의 REFRESH에선 보지 않는다 → 실행 중 스트림은 TTL을 넘겨도 끊기지 않는다(60s TTL / 200s 소크 / 비트 10-10 전달). **택일: (b) TTL을 세션 상한으로 두되 "천장"이라는 서술 자체를 정정** — ICE 재협상(a)은 만들지 않는다. 잔여 좁은 케이스: 세션 중 **재-ALLOCATE**(ICE restart)는 새 자격이 필요하며, 그 시점에 mint 하면 된다(주기적 교체가 아니라) |
