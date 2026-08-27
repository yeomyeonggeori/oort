# 12 — PushRelay 배포·검증 런북 (goal PUSH-1 / ADR-0120 P-3)

> **이 문서가 있는 이유.** 푸시 종단 경로는 세 조각이다 — 서버(Rust notifier)가
> 서명한 id-only dispatch를 relay가 받고, relay가 APNs로 HTTP/2 발송하고, 기기의
> NSE가 그것으로 알림을 완성한다. 양 끝은 이미 있었다(#963, #972). 가운데만
> **배포할 방법이 없었다** — `relay/PushRelay`는 Swift 패키지인데 Dockerfile이
> 없었고, 유일한 컨테이너 실행 예시는 소스를 복사해 `swift run`하는 검증 트릭
> 뿐이었다(`infra/e2e/metrics.overlay.yml`). ADR-0120 D1-A상 APNs `.p8`은 이 relay
> 만 든다(셀프호스트 서버는 Apple과 계약할 수 없다 — 구조적 필연). 그래서 이
> 조각이 없으면 실 푸시는 한 발도 나가지 못한다. 이 문서는 그 조각을 세우고,
> **키만 꽂으면 되는 상태**에서 실제 발송까지 가는 절차다.

- 대상: 오케스트레이터(스택 기동·검증) + 성재(Apple 자격증명)
- 선행: [11 — iOS 푸시 기기 확인 절차](11-ios-push-device-check.md) §3-1·3-2 (기기가 APNs 토큰을 받아 서버 `devices`에 등록됨)
- 계약 정본: [docs/PUSH_RELAY_RUNBOOK.md](../PUSH_RELAY_RUNBOOK.md) (환경변수·`.p8` 커스터디·키 회전)
- 소요: 준비 20분 + 빌드 10~20분 + 검증 15분

11번 문서는 `## 5. 알려진 미확인`에서 **"실APNs 발송 검증: 이 배치는 하지 않았다"**
로 끝난다. 이 문서가 그 자리다.

---

## 0. 이미 증명된 것 (다시 하지 마라)

`scripts/verify_push_relay.sh`가 자격증명 없이, APNs 접촉 없이 증명한다. PUSH-1
에서 이 게이트를 **처음으로 통과시켰다** — 그 전에는 `jq` 인용 오류(`:132`)로
중간에 죽어서 아래 항목 중 어느 것도 실제로 실행된 적이 없었다.

| # | 증명 항목 | 확인 방식 |
|---|---|---|
| A | 서명된 v2 dispatch를 200으로 수리하고 id-only payload만 만든다 | stub capture JSONL 필드 집합 |
| B | **위조 서명은 403** (body 1바이트 변조) | HTTP status |
| C | **미등록 server_id는 403** | HTTP status |
| D | 서버별 sliding-window 초과는 429 | HTTP status |
| E | APNs 410/`Unregistered`가 receipt로 passthrough된다 | `apns_status`/`apns_reason` |
| F | 대화 본문·표시명·채널명·토큰이 payload에 없다 | 금칙어 grep |
| G | **부팅 거부 4종** — stub 무단사용 / 자격증명 부재 / 읽을 수 없는 `.p8` / 빈 레지스트리 | exit 78 + 변수명 |

```bash
bash scripts/verify_push_relay.sh   # 실 APNs 없이 A~G 전부
```

**통과**: 위 문자열이 그대로 찍힌다. **실패**: 아래 절차를 시작하지 마라.

---

## 1. 이 relay가 부팅에 요구하는 것 (Config.swift 실측)

`relay/PushRelay/Sources/PushRelay/Config.swift` `RelayConfig.load()`에서 그대로
읽은 표다. **"없으면 어떻게 되는가" 열이 이 표의 요점이다** — 푸시는 fail-open이
가장 탐지하기 어려운 실패라서, 이 relay에는 "켜졌는데 못 보내는" 상태가 없어야
한다.

| 변수 | 필수 | 기본 | 없으면 어떻게 되는가 |
|---|---|---|---|
| `MOMO_RELAY_SERVERS` | 항상 | 없음 | **부팅 거부** — `{"server-id":"<raw Ed25519 공개키 base64>"}` JSON. 빈 객체·잘못된 base64·32바이트 아님도 전부 거부 |
| `MOMO_APNS_SENDER` | 아니오 | `live` | `live`/`stub` 외 값은 부팅 거부 |
| `MOMO_APNS_ALLOW_STUB` | `stub`일 때만 | 없음 | **부팅 거부** (PUSH-1 신규 — §1-1) |
| `MOMO_APNS_ENV` | live | 없음 | **부팅 거부** — `sandbox`\|`production` |
| `MOMO_APNS_KEY_PATH` | live | 없음 | **부팅 거부**. 값이 있어도 **파일을 읽을 수 없으면 부팅 거부** (PUSH-1 신규) |
| `MOMO_APNS_KEY_ID` | live | 없음 | **부팅 거부** |
| `MOMO_APNS_TEAM_ID` | live | 없음 | **부팅 거부** |
| `MOMO_PUSH_RELAY_HOST` | 아니오 | `127.0.0.1` | 컨테이너에서는 **반드시 `0.0.0.0`** — §1-2 |
| `MOMO_PUSH_RELAY_PORT` | 아니오 | `28195` | 양의 정수 아니면 부팅 거부 |
| `MOMO_PUSH_RELAY_RATE_LIMIT_PER_MINUTE` | 아니오 | `60` | 서버별 60초 sliding window (ADR-0120 D5) |
| `MOMO_APNS_STUB_STATUS` / `_REASON` / `_CAPTURE_PATH` | 아니오 | `200`/없음/없음 | verifier 전용 |
| `MOMO_METRICS_HOST` / `_PORT` | 아니오 | `127.0.0.1`/`9093` | 메트릭 엔드포인트 |

**번들 ID(APNs topic)는 이 표에 없다.** relay 설정이 아니라 dispatch가 나른다
(`apns_topic`) — 즉 셀프호스트 서버가 정한다. §5의 이탈 항목 참조.

### 1-1. 키가 없을 때의 동작 — 무엇을 바꿨나

**바꾸기 전에도 대부분 이미 옳았다.** live 모드에서 `MOMO_APNS_*` 4종이 하나라도
없으면 `ConfigError`가 던져져 프로세스가 죽었고, `.p8`이 읽히지 않으면
`LiveAPNSSender.init`이 부팅 시점에 던졌다. 조용한 무동작이 아니었다.

**단 하나 fail-open이 있었다: `MOMO_APNS_SENDER=stub`.** stub sender는 Apple에
접속하지 않고 모든 dispatch에 `200` + 조작된 `stub-apns-id`를 돌려준다. 그러면
notifier는 후보를 **배달 완료로 정산**하고, 기기는 영원히 울리지 않으며, 로그도
메트릭도 헬스체크도 전부 정상으로 보인다. 운영 env에서 이 한 글자를 잘못 두면
"보내지 않는데 성공했다고 보고하는 배포"가 된다.

→ **`MOMO_APNS_ALLOW_STUB=1`을 명시해야만 stub에 도달한다.** 없으면 부팅 거부하고,
로그 한 줄이 변수 이름을 알려준다. Rust notifier가 무서명 발송을
`MOMO_PUSH_RELAY_ALLOW_UNSIGNED=1` 뒤에 두는 것과 같은 형태다
(`server-rust/bins/momo-notifier/src/config.rs`).

추가로 PUSH-1에서 넣은 것:
- `.p8` 경로가 **읽히지 않으면** 부팅 거부하며 `MOMO_APNS_KEY_PATH`를 이름으로
  지목한다(가장 흔한 실수: 마운트 경로 오타, uid 10001이 못 읽는 퍼미션).
- 설정 거부는 Swift `fatalError` 백트레이스가 아니라 **exit 78 (EX_CONFIG) +
  `PushRelay refused to start — …` 한 줄**이다. 컨테이너가 재시작 루프를 도는
  동안 `docker logs`에서 읽을 것은 이 한 줄이다.
- 이미지 빌드가 이 계약을 **빌드 타임에 검증**한다 — 설정 없이 부팅되는 바이너리는
  빌드가 실패한다(`relay/PushRelay/Dockerfile`).

### 1-2. 부팅 거부로 잡히지 **않는** 것

`MOMO_PUSH_RELAY_HOST`를 기본값 `127.0.0.1`로 두면 컨테이너 안 loopback에만
바인드된다. 컨테이너 **내부** healthcheck는 통과하고(같은 netns의 127.0.0.1),
notifier만 연결 거부를 맞는다 — 초록 컨테이너 + 배달 안 됨. compose 오버레이가
`0.0.0.0`을 명시하는 이유이고, 직접 배포한다면 반드시 확인해라.

---

## 2. 서버 공개키 등록 절차

**있다.** 코드와 도구가 이미 갖춰져 있고, PUSH-1은 여기에 아무것도 더하지 않았다.

인증 방식: notifier가 **raw request body 전체**를 Ed25519로 서명해
`X-Momo-Push-Signature`에 싣고, `X-Momo-Server-Id`로 자신을 밝힌다. relay는
`MOMO_RELAY_SERVERS` 레지스트리에서 그 server_id의 공개키를 찾아 검증한다
(`App.swift`). 실패는 403이고, notifier는 403을 **영구 실패**로 분류해 재시도하지
않는다(`push_relay.rs::classify_relay_status`).

절차:

1. **서버 쪽에서** 키쌍을 만든다. 개인키는 그 서버 밖으로 나가지 않는다.
   ```bash
   scripts/push_relay_keygen.sh /secure/operator/path/momo-relay-key
   ```
   mode 0600 PKCS#8 개인키/공개키를 만들고, 마지막 줄에 레지스트리에 넣을
   **raw 공개키 base64**를 출력한다.
2. 운영자 채널로 **server_id + 공개키 base64만** Dawn에 전달한다.
3. Dawn이 relay의 `MOMO_RELAY_SERVERS` JSON에 항목을 추가하고 relay를 재시작한다.
4. 서버는 개인키 경로를 `MOMO_PUSH_RELAY_PRIVATE_KEY_PATH`로,
   server_id를 `PUSH_RELAY_SERVER_ID`로 준다. **둘이 어긋나면 전부 403이다.**

회전: 새 공개키를 레지스트리에 **먼저** 배포하고(둘 다 등록된 상태), 그 다음
서버 개인키를 교체한다. 순서를 뒤집으면 그 사이 발송이 전부 영구 실패한다.

> 레지스트리는 env 변수 하나다. 등록/해지 API도, 관리 UI도, 감사 로그도 없다 —
> 등록 서버가 몇 개를 넘어가면 이 부분은 다시 설계해야 한다(§5).

---

## 3. 배포

### 3-0. 선행 조건 (여기서 막히면 아래로 못 간다)

1. **성재 — Apple 자격증명.** APNs Auth Key(`.p8`), Key ID, Team ID. worker/이
   문서/이 repo는 이것을 만들지도 요구하지도 않는다. `.p8`은 repo·이미지·빌드
   산출물·로그 어디에도 넣지 않고, 호스트 절대경로에 두고 read-only로 마운트한다.
2. **`momo_notifier` DB 롤 — 미해결 갭.** notifier는 BYPASSRLS 롤로 붙어야 하는데
   `infra/prod/bootstrap_runtime_roles.sql`은 `momo_app`/`momo_relay`/`momo_worker`
   **셋만** 만든다. `momo_notifier`는 `infra/e2e/bootstrap_roles.sql`에만 있고 그건
   커밋된 개발용 비밀번호라 이 스택이 일부러 적용하지 않는 파일이다. 그래서
   `NOTIFIER_DATABASE_URL`에는 **옳은 기본값이 없다**. 스모크만 할 거면 소유자
   URL로 대신하고, 실배포 전에는 롤 프로비저닝을 별도로 결정해야 한다(§5).

### 3-1. env 준비

```bash
cp infra/rust/push-relay.env.example infra/rust/push-relay.secrets.env
# 편집: MOMO_RELAY_SERVERS, MOMO_APNS_KEY_ID/TEAM_ID,
#       MOMO_APNS_KEY_HOST_PATH, MOMO_RELAY_SIGNING_KEY_HOST_PATH,
#       NOTIFIER_DATABASE_URL
```

`*.secrets.env`는 repo 전역 gitignore다. 사본 이름을 바꾸지 마라.

`.p8`이 컨테이너 사용자(uid 10001)에게 읽혀야 한다:

```bash
sudo chown 10001:10001 "$MOMO_APNS_KEY_HOST_PATH"
sudo chmod 400 "$MOMO_APNS_KEY_HOST_PATH"
```

### 3-2. 이미지 빌드

```bash
docker build -f relay/PushRelay/Dockerfile -t momo-push-relay:dev .
```

빌드 컨텍스트는 **repo 루트**다(패키지가 `services/MomoMetrics`를 경로 의존).
`swift:6.2-noble`로 `--static-swift-stdlib` release 빌드 → `ubuntu:24.04` 런타임.
빌드 마지막 단계가 §1-1의 fail-closed 계약을 검증하므로, **설정 없이 부팅되는
바이너리는 여기서 빌드가 깨진다.**

### 3-3. 기동 — 기본 비활성, 오버레이로만

push 경로는 **오버레이 파일 2개**로만 존재한다. 지금 도는 도그푸딩 스택이 읽는
`docker-compose.rust.yml`은 **한 줄도 바뀌지 않았다** — 평소의 `momorust up -d`는
relay를 띄울 수도, 없는 이미지를 당길 수도, 새 변수에서 깨질 수도 없다.
LiveKit 시크릿도 요구하지 않는다: 기본 기동은 huddle profile이 없고, livekit
entrypoint의 `$${VAR:?}`는 compose 보간이 아니라 컨테이너 셸 검사다(#1781).
(`infra/rust`의 푸시 경로는 파일 오버레이다. huddle만 `profiles: ["huddle"]`이다.)

```bash
alias momopush='docker compose \
  --env-file infra/rust/rust-smoke.secrets.env \
  --env-file infra/rust/push-relay.secrets.env \
  -f infra/rust/docker-compose.rust.yml \
  -f infra/rust/docker-compose.push.yml'

momopush config >/dev/null && echo "compose OK"   # 데몬 불필요
momopush up -d push-relay
momopush logs push-relay
```

**통과**: `starting PushRelay` + `senderMode: live` + `registeredServers: N`.
**실패**: `PushRelay refused to start — …` — 그 줄이 어느 변수인지 말해준다.

drain은 아직 켜지 마라. `MOMO_PUSH_NOTIFIER_ENABLED=0`이 기본이다.

### 3-4. 발송 없이 확인 (자격증명 사용 전)

```bash
momopush exec push-relay curl -fsS http://127.0.0.1:28195/health
```

relay가 살아 있다는 것만 증명한다 — **Apple에 닿는다는 증명이 아니다.** 그것은
실 dispatch만 증명하고, 그래서 §4의 성공 기준은 초록 컨테이너가 아니라 APNs
receipt다.

### 3-5. drain 켜기

```bash
# push-relay.secrets.env: MOMO_PUSH_NOTIFIER_ENABLED=1
momopush up -d notifier
momopush logs notifier
```

**실패 신호**: `push drain is enabled but no relay signing key is configured` —
서명키 마운트가 안 붙었다는 뜻이고, 이것도 부팅 거부다(고쳐지기 전엔 아무것도
청구되지 않는다).

---

## 4. 판정 — 실 APNs 발송

여기서부터 실제 Apple 트래픽이다. **worker는 이 단계를 실행하지 않았다**(패킷
금지). 오케스트레이터/성재의 몫이다.

### 4-1. 가짜 토큰으로 경로 증명 (기기 불필요)

의도적으로 잘못된 device token으로 dispatch를 한 번 보낸다. relay가 APNs에
실제로 도달했다면 Apple이 판정을 돌려주고, 그것이 receipt로 흘러나온다.

**통과**: relay 로그/receipt에 `apns_status: 400` + `reason: BadDeviceToken`
(또는 410 `Unregistered`). — 이것이 **`.p8`·Key ID·Team ID가 전부 맞다는 증명**이다.
Apple이 provider token을 받아들였기 때문에 토큰을 평가할 수 있었던 것이다.

**실패 감별**:

| 증상 | 의미 |
|---|---|
| `403 InvalidProviderToken` | Key ID/Team ID/`.p8` 불일치 |
| `403 ExpiredProviderToken` | 호스트 시계 오차 |
| `400 TopicDisallowed` | dispatch의 `apns_topic`이 이 팀의 번들 ID가 아님 |
| `400 DeviceTokenNotForTopic` | 토큰과 번들 ID 불일치 |
| relay 403 (APNs 아님) | 서명/등록 문제 — §2 |
| 전송 오류 반복 | `ca-certificates` 또는 아웃바운드 443 차단 |

### 4-2. 실기기 종단

11번 문서 §3-3·3-4의 자리다. 잠긴 실기기로:

1. 다른 계정에서 멘션/DM을 보낸다.
2. 기기가 깨어나 NSE가 자기 서버에서 fetch해 알림을 완성한다.

**통과**: 잠금화면에 실제 보낸 사람·내용이 뜬다.
**실패(중요)**: `oort / 새 알림` placeholder만 뜬다 → 푸시는 **도달했고** NSE가
fail-open한 것이다. relay 문제가 아니라 클라 문제다(2026-08-02 감사 §4.3).

### 4-3. 기록

| # | 항목 | 결과 |
|---|---|---|
| 1 | `verify_push_relay.sh` A~G | ☐ |
| 2 | 이미지 빌드 + fail-closed 빌드 검증 | ☐ |
| 3 | live 모드 부팅 (`senderMode: live`) | ☐ |
| 4 | 가짜 토큰 → APNs 판정 receipt | ☐ |
| 5 | 실기기 잠금화면 실내용 알림 | ☐ |

4번이 통과하면 **ADR-0120 P-3이 닫힌다.** 결과는 `docs/planning/JOURNAL.md`에.

---

## 5. relay를 어디에 둘 것인가 — 권고

**권고: 지금은 같은 NCP 인스턴스, 단 별도 compose 오버레이로. 등록 서버가 Dawn
자신 말고 하나라도 늘어나는 시점에 별도 인스턴스로 분리한다.**

근거:

- ADR-0120 D1-A상 relay는 **여러 셀프호스트 서버를 상대하는 경계**이고,
  `infra/prod/prometheus.yml:18`은 이미 이것을 "스택의 서비스가 아니라 Dawn 운영
  배포 경계"라고 기록해 두었다. 원래 자리는 스택 밖이다.
- 그러나 **지금 등록될 서버는 Dawn 자신 하나다.** 아직 존재하지 않는 멀티테넌시를
  위해 인스턴스를 하나 더 띄우는 것은, 이미 Docker VM 자원 누적으로 발열을 겪은
  호스트에서 치를 비용이 편익보다 크다.
- 격리는 별도 VM 없이도 지금 확보된다: 자체 프로세스·비루트 uid 10001·읽기전용
  키 마운트·`private` 네트워크·**공개 포트 없음**. `.p8`은 relay 컨테이너 안에만
  있고 api/relay/worker 어디에도 없다.
- 오버레이 구조가 이 이전을 싸게 만든다. 분리 시점에 `docker-compose.push.yml`의
  `push-relay`를 다른 호스트로 옮기고 `PUSH_RELAY_URL`을 그 주소로 바꾸면 된다 —
  base 스택은 손대지 않는다.

**분리 트리거(둘 중 하나라도 해당되면 옮긴다)**:
1. Dawn 외 등록 서버가 생긴다 → 남의 트래픽이 우리 DB 호스트 자원을 쓰게 된다.
2. relay를 공개 인터넷에 노출해야 한다 → TLS 리버스 프록시와 ingress rate 방어가
   필요하고(`docs/PUSH_RELAY_RUNBOOK.md`), 그 표면을 DB와 같은 호스트에 두는 것은
   나쁜 거래다.

또한 `MOMO_APNS_ENV`는 인스턴스당 하나다. sandbox와 production을 동시에 운영해야
하면 **키가 같아도 컨테이너를 둘로** 나눈다.

---

## 6. 알려진 미해결 (이 배치가 남긴 것)

1. **`momo_notifier` 롤 미프로비저닝** — §3-0. 실배포 전 결정 필요.
2. **`apns_topic` 허용목록 없음** — 번들 ID를 dispatch가 나르므로, 등록된 서버는
   Dawn의 `.p8`으로 Dawn 팀의 **아무 번들 ID에나** 발송을 시도할 수 있다. APNs가
   팀 밖 topic은 거절하므로 폭발 반경은 Dawn 자신의 앱들로 제한되고, 등록 서버가
   Dawn 하나인 지금은 실질 위험이 없다. 등록 서버가 늘어나기 전에 relay 쪽
   허용목록을 넣어야 한다 — 계약 변경이라 이 배치 범위 밖으로 두었다.
3. **레지스트리 운영 도구 없음** — §2. env 변수 + 재시작이 전부다.
4. **실 APNs 발송 미실행** — 이 배치는 하지 않았다(패킷 금지). §4가 그 자리다.
