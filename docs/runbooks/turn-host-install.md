# momo-turn 설치 런북 (coturn — 관전 라이브 미디어 relay)

> 2026-08-16 신설. INFRA-B(#1435) 집행 기록 = 재설치 절차 정본.
> 근거: `docs/planning/handoffs/2026-08-16-infra-install-wave-packet.md` §goal B · ADR-0165 증보 1(D3 확정) ·
> `docs/planning/research/2026-08-15-reachability-spike-1411.md` §5 · `research/2026-08-16-turn-dedicated-host-procurement-package.md` §2.
> **왜 이 호스트가 존재하나**: 스파이크 실측으로 CubeSandbox microVM의 NAT이 symmetric이고 host/srflx 후보로는 P2P가
> 성립하지 않음이 확정됐다. **relay가 유일한 ICE 경로**이며, microVM↔호스트에 UDP 경로가 없고 헤어핀도 불가라
> TURN은 CubeSandbox 호스트에 동거시킬 수 없다. 그래서 **별도 공인 호스트 1대**다.

## 0. 대상과 자격

| 항목 | 값 |
|---|---|
| 호스트 | `momo-turn` — 공인 `223.130.142.109` / 사설 `10.0.1.8` (eth0에는 사설만, 공인은 NCP 1:1 NAT) |
| 사양 | NCP s2-g3 2vCPU/8GB · Rocky Linux 9.8 (커널 5.14.0-687.15.1.el9_8) · `/` XFS 49G |
| ACG | 22 · 3478/tcp · 3478/udp · 49152–65535/udp |
| 접속 | `ssh -i ~/.ncp/momo-oort-prod.pem root@223.130.142.109` (첫 설치 때 비번 SSH로 공개키 심음) |
| TURN 자격 | `~/.ncp/.momo-turn-secret` (0600, env 형식: `TURN_HOST/PORT/REALM/USER/PASS`) — **문서·로그·stdout 비유입** |

realm `oort.turn` · user `oort-live` 는 비밀이 아니다(비밀은 비밀번호뿐). 이 정적 자격은 **임시**이며
**LIVE-5에서 세션 capability 동반 단명 자격 발급으로 교체**한다(ADR-0004 증보 3 교차 확인 대상).

> **2026-08-18 (LIVE-5a #1524) 현재 상태**: 서버·producer 양쪽의 단명 자격 경로는 **랜딩됐고 conformance로 증명됐다**
> (`live5a_1_a_grant_carries_its_own_expiring_relay_credential`). 그러나 **momo-turn 자체는 아직 정적 자격 그대로**다 —
> §6이 그 교체 절차이며, 아직 수행되지 않았다. 순서는 뒤집을 수 없다: 이 호스트는 프로덕션 트래픽을 나르므로
> **신규 단명 자격이 정적 자격 옆에서 동작하는 것을 실측한 뒤에만** `user=` 줄을 지운다.

## 1. 설치 절차 (재현 순서)

### 1-1. 키 인증 확보 (비번 SSH는 이 스텝에서만)

```sh
ssh-keygen -y -f ~/.ncp/momo-oort-prod.pem > /tmp/momo.pub
PUB=$(cat /tmp/momo.pub)
sshpass -f ~/.ncp/.momo-turn-pw ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  root@223.130.142.109 "mkdir -p /root/.ssh && chmod 700 /root/.ssh && touch /root/.ssh/authorized_keys \
  && chmod 600 /root/.ssh/authorized_keys && grep -qF '$PUB' /root/.ssh/authorized_keys || echo '$PUB' >> /root/.ssh/authorized_keys"
```

이후 전부 `-i ~/.ncp/momo-oort-prod.pem`. 비밀번호는 `sshpass -f`로만 — 인자·stdout에 실어 나르지 않는다.

### 1-2. coturn 설치

Rocky 9 기본 repo(baseos/appstream/extras)에 coturn이 **없다** — EPEL이 선행이다.

```sh
dnf -y install epel-release
dnf -y install coturn          # coturn-4.16.0-1.el9
dnf -y install coturn-utils    # turnutils_uclient (검증용, 서비스 아님)
```

### 1-3. `/etc/coturn/turnserver.conf`

패키지 기본값은 `/etc/coturn/turnserver.conf.rpmorig`로 보존. 소유·모드는 `root:coturn 0640`
(유닛이 `User=coturn`으로 뜨므로 coturn 그룹 읽기가 필요하고, 자격이 들어 있으니 other는 차단).

```conf
listening-port=3478
listening-ip=10.0.1.8
relay-ip=10.0.1.8
external-ip=223.130.142.109/10.0.1.8     # 1:1 NAT — 이 매핑이 없으면 relay 후보를 사설 IP로 광고해 외부에서 못 쓴다

min-port=49152
max-port=65535                            # ACG·firewalld와 동일 선언

fingerprint
lt-cred-mech
realm=oort.turn
user=<USER>:<PASS>                        # ~/.ncp/.momo-turn-secret 에서만 주입
stale-nonce=600
user-quota=50
total-quota=200

no-tls
no-dtls                                   # TLS는 이번 파도 범위 밖(§4 동결)

no-multicast-peers
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.0.0.0-192.0.0.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=198.18.0.0-198.19.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff

no-cli                                    # 기본 텔넷 CLI(127.0.0.1:5766, 기본 비번) 비활성

log-file=/var/log/coturn/turnserver.log
simple-log
```

자격 라인을 넣을 때 **셸 히스토리·프로세스 인자에 비밀번호를 노출시키지 않는다** — 설정 전문을 로컬에서
조립해 stdin으로 넘긴다:

```sh
set -a; . ~/.ncp/.momo-turn-secret; set +a
cat <<CONF | ssh -i ~/.ncp/momo-oort-prod.pem root@223.130.142.109 \
  'cp -n /etc/coturn/turnserver.conf /etc/coturn/turnserver.conf.rpmorig; cat > /etc/coturn/turnserver.conf \
   && chown root:coturn /etc/coturn/turnserver.conf && chmod 640 /etc/coturn/turnserver.conf'
... (위 전문, user=${TURN_USER}:${TURN_PASS}) ...
CONF
```

```sh
systemctl enable --now coturn
ss -lnupt | grep 3478      # 10.0.1.8:3478 udp 2 + tcp 2 — rc=0이 아니라 이 출력으로 판정
```

### 1-4. firewalld (F1 — ACG 단일 실패점 제거)

ACG와 **동일 규칙을 호스트에서도 중복 선언**한다. 켜기 전에 잠금 대비 롤백 타이머를 건다.

```sh
systemd-run --on-active=600 --unit=fw-rollback /usr/bin/systemctl stop firewalld   # 검증 성공 후 stop
firewall-offline-cmd --zone=public --add-service=ssh
firewall-offline-cmd --zone=public --add-port=3478/tcp
firewall-offline-cmd --zone=public --add-port=3478/udp
firewall-offline-cmd --zone=public --add-port=49152-65535/udp
systemctl enable --now firewalld
firewall-cmd --permanent --zone=public --remove-service=cockpit && firewall-cmd --reload
systemctl stop fw-rollback.timer                                                   # SSH+프로브 그린 확인 후
```

결과: `services: dhcpv6-client ssh` / `ports: 3478/tcp 3478/udp 49152-65535/udp`.
`firewall-offline-cmd`는 `--remove-service`를 lokkit 옵션과 섞으면 거부하므로, 서비스 제거는 firewalld 기동 후
`firewall-cmd --permanent`로 한다. `--set-default-zone=public`은 이미 public이면 non-zero를 반환하니
`set -e` 스크립트에서 주의.

### 1-5. SELinux — Disabled → Enforcing (실측 후 결정)

NCP Rocky 9 이미지는 `/etc/selinux/config`에서 `SELINUX=disabled`로 온다. 실측:

| 측정 | 값 | 함의 |
|---|---|---|
| `/proc/cmdline` | `selinux=0` **없음** | 커널 인자 개입 없이 config만으로 재활성 가능 |
| `semodule -l \| grep -c turn` | **0** (전체 437 모듈) | targeted 정책에 coturn 전용 도메인이 없다 |
| `semodule -l \| grep -x unconfined` | 있음 | coturn은 Enforcing에서도 `unconfined_service_t`로 뜬다 |

즉 **Enforcing이 coturn 자체를 가두지는 못한다**(정책 모듈 부재). 그럼에도 sshd 등 나머지 시스템 confinement가
살아나고 비용이 재부팅 1회뿐이라 **Enforcing으로 올렸다**. 순서는 반드시 permissive 우선 — 라벨링이 실패해도
잠기지 않는다:

```sh
sed -i 's/^SELINUX=disabled/SELINUX=permissive/' /etc/selinux/config
touch /.autorelabel && systemctl reboot        # 복귀 ~40s, autorelabel 소진, unlabeled_t 0건
setenforce 1 && systemctl restart coturn       # 런타임 승격 후 외부 프로브 재실행
sed -i 's/^SELINUX=permissive/SELINUX=enforcing/' /etc/selinux/config
systemctl reboot                                # 부팅 지속성 확인(~20s 복귀)
```

**AVC denial 0건**(`journalctl -b | grep -c "avc:  denied"`), 프로브 전 항목 그린으로 확정.

### 1-6. fail2ban (선택 — 근거 있는 채택)

`sshd -T` 실측: `permitrootlogin yes` · `passwordauthentication yes`. 22의 ACG 소스 범위를 호스트 안에서는
확인할 수 없으므로 **노출을 가정하고** sshd jail을 건다(설치 시점 실패 인증 0건 — 예방 목적).

```sh
dnf -y install fail2ban fail2ban-firewalld
# /etc/fail2ban/jail.d/00-firewalld.local : banaction(+_allports) = firewallcmd-rich-rules
# /etc/fail2ban/jail.d/sshd.local         : enabled/backend=systemd/maxretry=5/findtime=10m/bantime=1h
systemctl enable --now fail2ban && fail2ban-client status sshd
```

## 2. 외부 실증 (2026-08-16, 이 맥 → 223.130.142.109)

로컬(맥)에 `turnutils_uclient`/`stunclient`가 없어 **RFC 5389/5766 프로브를 stdlib python으로 작성**해 왕복을 측정했다
(세션 한정 스크립트 — 레포에는 코드를 남기지 않는다. 재현은 §5의 `turnutils_uclient` 경로가 정본).
아래는 마지막 재부팅(Enforcing 지속성 확인) 이후 2026-08-16 19:52 KST 한 회차 값:

| # | 검증 | 결과 |
|---|---|---|
| 1 | STUN Binding **UDP** | OK · rtt 5.8 ms · XOR-MAPPED-ADDRESS = `39.115.69.188:53838`(맥 공인) |
| 2 | STUN Binding **TCP** | OK · connect+rtt 20.9 ms |
| 3 | Allocate (무인증) | **401** + realm `oort.turn` + nonce — 인증이 실제로 걸려 있음 |
| 4 | **TURN Allocate (long-term cred)** | **OK** · rtt 4.4 ms · **XOR-RELAYED-ADDRESS = `223.130.142.109:59266`** · lifetime 600s |
| 5 | CreatePermission 양방향 | OK (allocation 2개 상호 권한) · rtt 4.2/4.9 ms |
| 6 | **Send→Data relay 실왕복** | **OK** · rtt 4.3 ms · payload 일치 · from-peer = 상대 relay 주소 `223.130.142.109:59266` |
| 7 | Allocate over **TCP** 3478 | OK · rtt 5.5 ms · relayed `223.130.142.109:51306` (브라우저 `?transport=tcp` 폴백 경로) |

**핵심**: relayed 주소가 **공인 IP**로 광고되고(= `external-ip` 매핑 정상) 포트가 **49152–65535 안**에 떨어지며,
allocation 두 개 사이로 **실제 페이로드가 relay를 통과**했다. 스파이크가 "relay가 유일 경로"라고 확정한 그 경로의
반대편(=relay 자체의 성립)이 실측으로 닫혔다.

부정 실증:

| 검증 | 결과 |
|---|---|
| 잘못된 비밀번호 Allocate | **401 거부** |
| CreatePermission → `192.168.0.1` / `127.0.0.1` / `10.99.99.99` / `10.0.1.99` / `172.16.5.5` / `169.254.169.254` / `100.64.0.1` | **403 거부** |
| CreatePermission → `8.8.8.8`(공인) | 허용(정상) |
| CreatePermission → **`10.0.1.8`(자기 relay-ip)** | **허용** — §3 참조 |

서버 쪽 정본 도구 교차 확인(호스트 내부, `10.0.1.8` 대상):
`turnutils_uclient -y -u oort-live -w <secret> -e 10.0.1.8 -n 3 -m 1 10.0.1.8`
→ `tot_send_msgs=12, tot_recv_msgs=12`, **lost 0 (0.000000%)**.

재부팅 후 상태: `coturn/firewalld/fail2ban` 전부 `enabled`+`active`, `getenforce=Enforcing`, AVC 0건.

## 3. 판정된 사실 (설계에 물리는 것)

1. **`denied-peer-ip`의 유일한 예외는 자기 relay-ip(`10.0.1.8`)다.** 10/8·172.16/12·192.168/16·127/8·169.254/16·100.64/10은
   전부 403인데 `10.0.1.8`만 허용된다 — coturn이 자기 listener/relay 주소를 내부적으로 허용하기 때문이다.
   이건 버그가 아니라 **우리 토폴로지가 의존하는 성질**이다: 브라우저와 microVM이 **같은 TURN 서버의 relay 후보끼리**
   미디어를 주고받으므로(relay↔relay) 이 예외가 없으면 관전 경로가 끊긴다. §2의 [6] 왕복이 정확히 그 경로다.
   잔여 노출은 "유효 자격 보유자가 `10.0.1.8`의 UDP 포트로 패킷을 보낼 수 있음"인데, 그 호스트의 UDP 서비스는
   coturn 자신뿐이고 firewalld가 3478+relay 레인지 외 인바운드를 막는다. 수용.
2. **`external-ip=공인/사설` 매핑이 필수다.** eth0에는 사설 IP만 붙어 있어(NCP 1:1 NAT) 이 줄이 없으면
   relay 후보를 `10.0.1.8`로 광고해 외부 클라이언트가 절대 못 쓴다.
3. **coturn은 Enforcing에서도 confined되지 않는다**(targeted 정책에 도메인 없음 → `unconfined_service_t`).
   SELinux를 켠 값은 시스템 나머지의 confinement이지 coturn 격리가 아니다 — 과신 금지.
4. `listening-ip`를 사설로 묶어도 외부 STUN/TURN이 전부 성립한다(NAT가 앞단에서 변환). 공인 IP를 직접 bind할 필요 없음.

## 4. 동결 지점 (이 goal에서 열지 않은 것)

| # | 항목 | 상태 |
|---|---|---|
| 1 | **microVM → TURN allocation 왕복**(패킷 §goal B-4) | **스킵**. 2026-08-16 19:50 KST 시점 `momo-cube-host`(101.79.18.230)는 CubeSandbox 설치 진행 중 — 읽기 전용 확인에서 cube 유닛 14개는 존재하나 `cubelet=inactive`라 microVM 기동 불가. goal A 비접촉 규율에 따라 그 이상 손대지 않음. **E2E goal의 입력으로 이월**. (스파이크 §D3-2는 microVM의 공인 UDP 아웃바운드+응답을 이미 실측 — TURN 클라이언트 동작 자체는 근거 있음, 미검증은 "TURN allocation"이라는 구체 왕복뿐) |
| 2 | **TURN over TLS/DTLS(5349)** | `no-tls`/`no-dtls`. 실인증서·도메인 배정이 선행이며 후속 명시 대상. 현재 자격은 평문 STUN 인증(long-term cred의 MD5 키 방식)으로 오간다 |
| 3 | **단명 자격 발급** | **서버 측 랜딩됨(LIVE-5a #1524), 릴레이 측 미수행.** 절차는 §6 |
| 4 | **ACG :22 소스 범위** | 호스트 안에서 확인 불가. 콘솔에서 운영자 IP 한정인지 확인 권장(아니면 한정 + `passwordauthentication no` 전환 검토 — 지금은 성재의 비번 폴백 보존을 위해 유지) |
| 5 | **대역폭/동시 세션 비용(U2)** | 미측정. relay 전량 경유이므로 세션 수 × 시청시간 × 비트레이트에 비례 — 실사용 후 ADR-0164 과금 축과 교차 |

## 5. 재검증 (한 번에 그린 여부 확인)

**서버 측 상태**:

```sh
ssh -i ~/.ncp/momo-oort-prod.pem root@223.130.142.109 \
  'systemctl is-active coturn firewalld fail2ban; getenforce; firewall-cmd --list-ports; ss -lnupt | grep 3478
   journalctl -b --no-pager | grep -c "avc:  denied"'
```

**relay 성립(호스트 내부, 검증된 형태 그대로)** — coturn-utils가 깔린 momo-turn에서:

```sh
set -a; . ~/.ncp/.momo-turn-secret; set +a      # 맥에서 값을 읽어 stdin으로 넘길 것(인자 노출 최소화)
turnutils_uclient -y -u oort-live -w "$TURN_PASS" -e 10.0.1.8 -n 3 -m 1 10.0.1.8
#   -y=client-to-client, -e=peer address. tot_send_msgs == tot_recv_msgs & lost 0% 이면 relay 성립.
```

**외부 도달성(맥 등 임의 IP에서)** — 별도 도구 없이 확인하는 정본 경로는 브라우저 Trickle-ICE다:
`webrtc.github.io/samples/src/content/peerconnection/trickle-ice/` 에 아래 iceServers 값을 넣고
**`relay` 타입 후보가 뜨고 그 주소가 `223.130.142.109`인지** 확인한다. relay 후보가 안 뜨면 실패다.
(2026-08-16 실증은 이 경로 대신 stdlib RFC 5766 프로브로 §2 표를 측정했다 — 둘은 같은 것을 본다.)

브라우저 쪽 ICE 설정(LIVE-5에서 배선할 때):

```js
iceServers: [{ urls: ['turn:223.130.142.109:3478?transport=udp',
                      'turn:223.130.142.109:3478?transport=tcp'],
               username: '<TURN_USER>', credential: '<TURN_PASS>' }]
iceTransportPolicy: 'relay'   // host/srflx는 실패가 확정 — 수집을 끄는 편이 연결 시간에 유리(스파이크 잔여항목 5)
```

## 6. 정적 자격 → 세션 단명 자격 은퇴 절차 (LIVE-5a #1524)

> **아직 수행되지 않았다.** 이 절은 절차 정본이자 미집행 체크리스트다. 집행 주체는 SSH 접근을 가진 운영자(성재).
> 워커(#1524)는 서버·producer 코드와 conformance까지만 랜딩했고, 이 호스트에는 **손대지 않았다**
> (읽기 전용 네트워크 실측만 수행 — §6-1).

### 왜 순서가 고정인가

momo-turn은 **프로덕션 실사용 중**이다. `use-auth-secret`을 켜면서 동시에 `user=` 줄을 지우면,
그 사이 살아 있던 스트림은 다음 ALLOCATE refresh에서 401을 받고 **사용자에게 아무 설명 없이 화면이 검게 된다**.
그래서 세 걸음이고, 각 걸음은 되돌릴 수 있다:

1. **켠다**(`use-auth-secret` 추가) — 정적 `user=` 는 그대로 둔다.
2. **둘 다 되는지 실측**한다(§6-2 병행 실증). 여기서 실패하면 1을 되돌리고 끝.
3. **정적을 지운다**(`user=` 삭제) — 그리고 producer 템플릿의 `MOMO_DISPLAY_TURN_URI` 전달을 끊는다.

**2 없이 3으로 가지 않는다.** coturn이 `use-auth-secret`과 정적 `user=` 계정을 **동시에** 받아들이는지는
이 레포에서 실측된 바 없다 — 문서 추정으로 넘기지 말고 §6-2가 그것을 측정한다. 병행이 성립하지 않으면
은퇴는 짧은 계획 정지창(스트림 없는 시각)으로 계획해야 하며, 그 판단이 이 스텝의 산출물이다.

### 6-1. 지금 상태 (2026-08-18 실측 — 이 맥 → 223.130.142.109, 읽기 전용)

RFC 5766 ALLOCATE 왕복. 서버 설정은 건드리지 않았다.

| 자격 | 전송 | 결과 |
|---|---|---|
| 정적 long-term (`~/.ncp/.momo-turn-secret`) | UDP | **OK** · relayed `223.130.142.109:49883` · lifetime 600s · realm `oort.turn` · rtt 17.7 ms |
| 정적 long-term | TCP | **OK** · relayed `223.130.142.109:60612` · lifetime 600s · rtt 14.9 ms |
| **단명(`use-auth-secret` 파생)** | UDP | **401 거부** · rtt 17.0 ms — 릴레이에 `use-auth-secret`이 아직 없다 |
| 잘못된 비밀번호 (음성 대조군) | UDP | **401 거부** — 위 401이 "인증 기계가 거부한 것"임을 확인 |

즉 **프로덕션 경로는 정상이고, 신규 경로는 릴레이 쪽만 남았다.** 서버는 이미 단명 자격을 발급할 수 있고
(`MOMO_TURN_*` 환경변수가 주어지면), producer는 받으면 그것을 우선한다.

### 6-2. 켜기 + 병행 실증

`static-auth-secret`은 **새로 만든다** — 지금의 사용자 비밀번호를 재사용하면 두 메커니즘이 한 비밀을 공유해
하나를 회전할 때 다른 하나가 같이 죽는다.

```sh
NEW_SECRET="$(openssl rand -base64 48 | tr -d '\n')"     # 로컬에서만. 인자·히스토리에 남기지 않는다
printf 'TURN_STATIC_AUTH_SECRET=%s\n' "$NEW_SECRET" >> ~/.ncp/.momo-turn-secret   # 0600 유지
```

`/etc/coturn/turnserver.conf`에 **추가**한다(기존 `user=` 줄은 이 단계에서 남긴다):

```conf
use-auth-secret
static-auth-secret=<NEW_SECRET>
```

```sh
systemctl reload coturn || systemctl restart coturn
```

그리고 **두 자격을 한 번에** 측정한다. 정본 도구는 coturn 자신의 것이다:

```sh
# 단명 자격 한 쌍을 로컬에서 만든다 — 서버가 만드는 것과 같은 파생(coturn use-auth-secret)
python3 - <<'PY'
import base64, hashlib, hmac, os, time
secret = os.environ["TURN_STATIC_AUTH_SECRET"].encode()
user = f"{int(time.time()) + 3600}:01920000-0000-7000-8000-000000000001"
print(user)
print(base64.b64encode(hmac.new(secret, user.encode(), hashlib.sha1).digest()).decode())
PY

# 호스트 안에서, §5와 같은 형태로 — 단명 자격
turnutils_uclient -y -u "<단명 username>" -w "<단명 credential>" -e 10.0.1.8 -n 3 -m 1 10.0.1.8
# …그리고 같은 회차에 정적 자격
turnutils_uclient -y -u oort-live -w "$TURN_PASS" -e 10.0.1.8 -n 3 -m 1 10.0.1.8
```

**두 줄 모두 `tot_send_msgs == tot_recv_msgs`, lost 0%** 여야 다음 걸음으로 간다.
정적 쪽이 여기서 401로 죽으면 **병행이 성립하지 않는 것**이고, 그때는 §6-4의 정지창 계획으로 전환한다.

### 6-3. momo-server에 자격 주입

`static-auth-secret`은 momo-server 프로세스에만 들어간다 — 클라이언트·템플릿·문서 어디에도 복사하지 않는다.

```sh
MOMO_TURN_URLS='turn:223.130.142.109:3478?transport=udp,turn:223.130.142.109:3478?transport=tcp'
MOMO_TURN_STATIC_AUTH_SECRET='<NEW_SECRET>'
MOMO_TURN_CREDENTIAL_TTL_SECONDS=3600      # 선택. 기본 3600
```

셋 중 하나라도 없으면 서버는 `ice_servers: []`를 답하고 **정적 경로가 계속 스트림을 나른다** — 이것이
이 절차를 되돌릴 수 있게 만드는 성질이다(코드: `momo_t3::TurnCredentialPolicy::new` 는 반쪽 설정을 거부한다).

확인: 실제 세션에서 `POST …/display-attach` 응답의 `ice_servers[0].username`이 `<만료초>:<work session uuid>` 꼴이고
`urls`가 위에서 준 값과 같아야 한다. 비밀번호는 응답 밖 어디에도 저장되지 않는다(파생값이라 저장할 것이 없다).

### 6-4. 정적 은퇴

**§6-2와 §6-3이 모두 그린인 다음에만.** 그리고 켜져 있는 스트림이 없는 시각에.

```sh
# turnserver.conf 에서 `user=` 한 줄 삭제 → reload
systemctl reload coturn
```

그리고 §6-1의 표를 **다시 측정**한다. 은퇴가 성공한 모습은 정확히 그 표의 반대다:

| 자격 | 기대 |
|---|---|
| 정적 long-term | **401** — 지워졌으므로 |
| 단명 | **OK** — relayed 공인 IP, lifetime 600s |

같은 배포에서 producer 템플릿의 `MOMO_DISPLAY_TURN_URI` 전달도 끊는다(끊지 않아도 producer는 서버 쪽을
우선하므로 무해하지만, 죽은 자격을 계속 배달하는 것은 다음 사람에게 거짓말이다).

마지막으로 `~/.ncp/.momo-turn-secret`의 `TURN_USER`/`TURN_PASS` 줄을 지운다 — 더 이상 아무것도 열지 않는 값이
파일에 남아 있으면 다음 사람이 그것으로 무언가를 시도한다.
