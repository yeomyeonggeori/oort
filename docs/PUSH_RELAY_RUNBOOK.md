# PushRelay v0 운영 런북

PushRelay는 ADR-0120의 APNs 경계다. 셀프호스트 notifier가 `momo.push.dispatch.v2`
raw body를 Ed25519로 서명하고, relay는 등록 공개키를 검증한 뒤 APNs에 id-only
payload만 보낸다. 대화 본문·보낸 사람 표시명·채널명은 relay 또는 APNs payload에
포함되지 않는다.

본체는 `momo-push-relay`(같은 멀티커맨드 Rust 이미지, `command: ["push-relay"]`)다.
Swift `relay/PushRelay`는 ADR-0183으로 삭제됐고, 와이어 계약(헤더·봉투·영수증·
상태 코드)은 그대로다.

v2는 APNs `thread-id`(`root_id ?? channel_id`)와 `category`
(`momo.message|mention|approval|work`)를 `aps`에 추가한다. 승인 알림만 NSE/액션의
REST 대상인 `approval_id`를 `momo` 봉투에 싣고, `badge`는 ADR-0109의 활성 채널별
unread 수 합계를 서버가 계산한다. 이 메타데이터는 모두 id-only 경계 안에 있다.

## 운영 모드 3종

### 1. Dawn 공용 (App Store 앱 기본)

셀프호스트 서버는 Apple `.p8`을 갖지 않는다. 운영자는 서버에서 키를 만들고
Dawn에 **server_id + 공개키만** 등록한다. 서버 쪽 notifier env는 다음 3키다.

```bash
scripts/push_relay_keygen.sh /secure/operator/path/momo-relay-key
```

| 키 | 역할 |
|---|---|
| `PUSH_RELAY_URL` | Dawn relay의 `https://…/v1/push` |
| `PUSH_RELAY_SERVER_ID` | 레지스트리 키. Dawn이 알려 준 opaque id |
| `MOMO_PUSH_RELAY_PRIVATE_KEY_PATH` | 위 스크립트가 만든 Ed25519 PKCS#8. 개인키는 이 서버 밖으로 나가지 않는다 |

Dawn은 `MOMO_RELAY_SERVERS` JSON에 공개키를 넣고 relay를 재시작한다. 회전은
새 공개키를 레지스트리에 **먼저** 배포한 뒤 서버 개인키를 교체한다.

자기등록 REST는 v0 범위 밖이다. v0 레지스트리는 정적 env JSON이다.

### 2. 자체 relay (자기 Apple 계정 · 자기 빌드 앱)

같은 이미지, 같은 바이너리. 셀프호스터가 자기 `.p8`을 마운트하고 overlay를 켠다.

```bash
docker build -f server-rust/Dockerfile --build-arg MOMO_BUILD_SHA="$(git rev-parse HEAD)" -t momo-rust:dev .
docker compose --env-file infra/rust/rust-smoke.secrets.env \
  --env-file infra/rust/push-relay.secrets.env \
  -f infra/rust/docker-compose.rust.yml \
  -f infra/rust/docker-compose.push.yml up -d
```

`MOMO_APNS_SENDER=live`(기본). `.p8`은 repo·이미지·로그에 넣지 않는다. 호스트
절대경로를 `MOMO_APNS_KEY_HOST_PATH`로 넘기고 컨테이너는
`/run/secrets/apns-key.p8`에서 읽는다. uid 10001이 읽지 못하면 부팅 거부.

### 3. stub (로컬 · Apple 미접속)

`MOMO_APNS_SENDER=stub` 이고 **`MOMO_APNS_ALLOW_STUB=1`이 없으면 부팅을 거부**
한다(exit 78). stub은 모든 dispatch에 조작된 receipt를 돌려주므로, 운영 env
오타 하나가 "안 보내면서 성공 보고하는 배포"가 되지 않게 한다. 캡처 파일과
고정 `apns_status`/`apns_reason`은 verifier 전용이다.

```bash
scripts/verify_push_relay.sh
```

실 APNs·실기기 수신은 이 런북의 자동 게이트가 아니다. TestFlight 수신은 planner
가 Dawn live relay로 1회 확인한다.

## 환경 변수

| 이름 | 필수/기본 | 설명 |
|---|---|---|
| `MOMO_RELAY_SERVERS` | 필수 | `{"server-id":"<raw Ed25519 public key base64>"}` JSON 레지스트리 |
| `MOMO_PUSH_RELAY_HOST` | `127.0.0.1` | listen host. reverse proxy/컨테이너 배포에서는 명시적으로 `0.0.0.0` |
| `MOMO_PUSH_RELAY_PORT` | `28195` | listen port |
| `MOMO_PUSH_RELAY_RATE_LIMIT_PER_MINUTE` | `60` | 닫힌 봉투를 통과한 요청의 서버별 60초 sliding-window 한도 |
| `MOMO_APNS_SENDER` | `live` | 운영은 `live`; repo verifier만 `stub` |
| `MOMO_APNS_ALLOW_STUB` | `stub`일 때 필수 | `1`이어야 stub이 기동한다 |
| `MOMO_APNS_KEY_PATH` | live 필수 | Apple APNs Auth Key `.p8`의 컨테이너 안 경로. 경로가 있어도 **읽을 수 없으면 부팅 거부** |
| `MOMO_APNS_KEY_ID` | live 필수 | Apple key ID |
| `MOMO_APNS_TEAM_ID` | live 필수 | Apple Developer team ID |
| `MOMO_APNS_ENV` | live 필수 | `sandbox` 또는 `production`; dispatch의 `apns_env`와 불일치하면 400 |
| `MOMO_APNS_STUB_STATUS` | `200` | verifier 전용 APNs status |
| `MOMO_APNS_STUB_REASON` | 없음 | verifier 전용 APNs reason |
| `MOMO_APNS_STUB_CAPTURE_PATH` | 없음 | verifier 전용 id-only payload JSONL 경로 |

Notifier는 기존 `PUSH_RELAY_URL`과 `PUSH_RELAY_SERVER_ID`에 더해
`MOMO_PUSH_RELAY_PRIVATE_KEY_PATH`를 설정하면 `X-Momo-Server-Id` 및
`X-Momo-Push-Signature`(raw body Ed25519, standard base64)를 첨부한다.
이 변수를 생략하고 drain을 켜면 부팅 거부. 무서명 요청은
`MOMO_PUSH_RELAY_ALLOW_UNSIGNED=1`이 있을 때만 나간다. Dawn/자체 relay는
무서명 요청을 **401**로 거부한다.

## `.p8` 커스터디와 sandbox/production 전환

- Apple `.p8`은 repo, 이미지, 빌드 산출물, 로그에 넣지 않는다.
- key ID/team ID도 운영 secret 설정에서 관리한다. 서비스는 키 바이트나 provider
  JWT를 로그로 남기지 않는다.
- sandbox와 production token은 호환되지 않는다. 한 인스턴스는 하나의
  `MOMO_APNS_ENV`만 담당하며, 두 환경이 필요하면 키가 같더라도 인스턴스를
  분리한다. dispatch 환경 불일치는 relay-level 400으로 fail closed한다.
- APNs 400/410은 Relay HTTP 200 receipt의 `apns_status`/`apns_reason`으로
  notifier에 전달된다. 따라서 relay 인증/입력 4xx와 실제 APNs token 판정을
  혼동하지 않는다.

준비물·기동·판정을 포함한 배포 절차는
[docs/cicd/12-push-relay-deploy-runbook.md](cicd/12-push-relay-deploy-runbook.md).
셀프호스트 3키와 doctor 확인은 [docs/SELF_HOST.md](SELF_HOST.md) 「폰 푸시」.
