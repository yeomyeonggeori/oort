# PushRelay v0 운영 런북

PushRelay는 ADR-0120의 Dawn 운영 APNs 경계다. 셀프호스트 `NotifierWorker`가
`momo.push.dispatch.v1` raw body를 Ed25519로 서명하고, relay는 등록 공개키를
검증한 뒤 APNs에 id-only payload만 보낸다. 대화 본문·보낸 사람 표시명·채널명은
relay 또는 APNs payload에 포함되지 않는다.

## 환경 변수

| 이름 | 필수/기본 | 설명 |
|---|---|---|
| `MOMO_RELAY_SERVERS` | 필수 | `{"server-id":"<raw Ed25519 public key base64>"}` JSON 레지스트리 |
| `MOMO_PUSH_RELAY_HOST` | `127.0.0.1` | listen host. reverse proxy/컨테이너 배포에서는 명시적으로 `0.0.0.0` |
| `MOMO_PUSH_RELAY_PORT` | `28195` | listen port |
| `MOMO_PUSH_RELAY_RATE_LIMIT_PER_MINUTE` | `60` | 서명 검증을 통과한 요청의 서버별 60초 sliding-window 한도 |
| `MOMO_APNS_SENDER` | `live` | 운영은 `live`; repo verifier만 `stub` |
| `MOMO_APNS_KEY_PATH` | live 필수 | Apple APNs Auth Key `.p8`의 repo 밖 절대 경로 |
| `MOMO_APNS_KEY_ID` | live 필수 | Apple key ID |
| `MOMO_APNS_TEAM_ID` | live 필수 | Apple Developer team ID |
| `MOMO_APNS_ENV` | live 필수 | `sandbox` 또는 `production`; dispatch의 `apns_env`와 불일치하면 400 |
| `MOMO_APNS_STUB_STATUS` | `200` | verifier 전용 APNs status |
| `MOMO_APNS_STUB_REASON` | 없음 | verifier 전용 APNs reason |
| `MOMO_APNS_STUB_CAPTURE_PATH` | 없음 | verifier 전용 id-only payload JSONL 경로 |

NotifierWorker는 기존 `PUSH_RELAY_URL`과 `PUSH_RELAY_SERVER_ID`에 더해
`MOMO_PUSH_RELAY_PRIVATE_KEY_PATH`를 설정하면 `X-Momo-Server-Id` 및
`X-Momo-Push-Signature`를 첨부한다. 이 변수를 생략하면 P-2 mock relay 호환을
위해 종전처럼 무서명 요청을 보낸다. Dawn PushRelay는 무서명 요청을 거부한다.

## 서버 등록 키

```bash
scripts/push_relay_keygen.sh /secure/operator/path/momo-relay-key
```

스크립트는 OpenSSL Ed25519 PKCS#8 개인키/공개키를 mode 0600으로 만들고,
레지스트리에 넣을 raw 공개키 base64를 출력한다. 개인키는 해당 셀프호스트의
NotifierWorker에만 배치한다. Dawn에는 공개키만 전달한다. 회전 시 새 공개키를
relay 레지스트리에 배포한 뒤 NotifierWorker 개인키를 교체한다.

## `.p8` 커스터디와 sandbox/production 전환

- Apple `.p8`은 repo, 이미지, 빌드 산출물, 로그에 넣지 않는다. 운영 secret
  manager가 read-only 파일로 mount하고 `MOMO_APNS_KEY_PATH`만 전달한다.
- key ID/team ID도 운영 secret 설정에서 관리한다. 서비스는 키 바이트나 provider
  JWT를 로그로 남기지 않는다.
- sandbox와 production token은 호환되지 않는다. 한 인스턴스는 하나의
  `MOMO_APNS_ENV`만 담당하며, 두 환경이 필요하면 키가 같더라도 인스턴스를
  분리한다. dispatch 환경 불일치는 relay-level 400으로 fail closed한다.
- APNs 400/410은 Relay HTTP 200 receipt의 `apns_status`/`apns_reason`으로
  NotifierWorker에 전달된다. 따라서 relay 인증/입력 4xx와 실제 APNs token
  판정을 혼동하지 않는다.

## Dawn 배포 절차

1. 등록 요청의 서버 ID와 공개키를 운영자 채널에서 확인하고
   `MOMO_RELAY_SERVERS` JSON을 갱신한다.
2. secret manager의 `.p8` mount, key/team ID, 환경을 설정한다. 로그/프로세스
   인자에 값이나 키 내용을 넣지 않는다.
3. 먼저 `scripts/verify_push_relay.sh`로 Stub 게이트를 실행한다.
4. PushRelay를 최소 권한 사용자로 기동하고 TLS reverse proxy 뒤에 둔다.
   `/health`만 공개 health check에 사용하고 `/v1/push`에는 별도 ingress body
   size/rate 방어를 겹친다.
5. 오케스트레이터가 repo 밖 실 `.p8`로 가짜 device token을 보내 APNs sandbox의
   `400 BadDeviceToken` receipt passthrough를 확인한다. worker는 실키에 접근하지
   않는다.
6. production 전환은 별도 인스턴스/설정으로 반복하고, 관측 후 sandbox를
   독립적으로 유지 또는 종료한다.

## 셀프호스터 자체 relay

코드는 Apache/MIT 계열 의존성만 사용하는 repo 내 Swift 패키지다. 자체 빌드한
Apple 앱과 APNs 자격증명이 있는 셀프호스터는 동일 패키지를 직접 운영하고
`PUSH_RELAY_URL`을 자기 relay로 지정할 수 있다. Dawn 운영 relay 사용은 코드상
강제가 아니며, Dawn relay에도 대화 내용은 전달되지 않는다.

실행 예:

```bash
(cd relay/PushRelay && swift run PushRelay)
curl -fsS http://127.0.0.1:28195/health
```

실 APNs smoke는 운영 자격증명 작업이며 이 repo의 자동 게이트에서는 실행하지 않는다.
