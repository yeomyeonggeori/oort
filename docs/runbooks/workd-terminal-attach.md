# momo-workd 터미널 attach 운영 (MOMO-655 / #869)

세션 터미널을 웹·mac에서 **직접** 붙어 보는 경로의 운영 문서다. 서버는 이 스트림을
중계하지 않는다(ADR-0125 D10): 바이트는 브라우저 ↔ 호스트 사이에서만 흐르고,
momo 서버는 capability 발급과 검증만 한다.

## 무엇이 켜지는가

`MOMO_WORKD_ATTACH_PUBLIC_URL`을 설정한 호스트만 attach를 제공한다. 미설정이면
리스너를 아예 열지 않고, `attach_endpoint`도 게시하지 않으며, 그 호스트가 만든
세션은 이전과 동일하게 `remote_attach_available: false`로 남는다.

| 환경변수 | 기본값 | 의미 |
| --- | --- | --- |
| `MOMO_WORKD_ATTACH_PUBLIC_URL` | (없음 = attach 비활성) | 클라이언트가 실제로 다이얼할 주소. `https://` 또는 `wss://`, 자격증명·query·fragment 금지 |
| `MOMO_WORKD_ATTACH_BIND` | `127.0.0.1` | 리스너 바인드 주소(IPv4) |
| `MOMO_WORKD_ATTACH_PORT` | `28650` | 리스너 포트 |
| `MOMO_WORKD_ATTACH_MAX_CONNECTIONS` | `32` | 동시 attach 소켓 상한. 초과분은 즉시 거절 |
| `MOMO_WORKD_ATTACH_REVALIDATE_INTERVAL_MS` | `30000` | **열려 있는** 스트림이 서버에 권한을 다시 묻는 주기. 범위 1000~3600000 |

## TLS는 데몬이 하지 않는다 — 리버스 프록시가 한다

`momo-workd`는 **평문 TCP만** 리슨한다. `attach_endpoint`가 `wss://`인 것은
앞단 프록시가 그렇게 만들어 주기 때문이다. 기본 바인드가 루프백인 이유가 이것이다:
프록시를 안 붙인 상태는 "LAN에 평문으로 열림"이 아니라 "닿지 않음"으로 실패해야 한다.

self-host 현실을 반영한 권장 배치는 momo 서버 TLS를 이미 끊고 있는 프록시에
경로 하나를 더 얹는 것이다.

```nginx
# 예: caddy/nginx 등 이미 인증서를 들고 있는 프록시에 추가
location /v1/terminal-attach {
    proxy_pass http://127.0.0.1:28650;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    # attach 스트림은 오래 열려 있다. 기본 60s 타임아웃이면 1분마다 끊긴다.
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    # 프록시가 응답을 모으면 터미널 출력이 뭉쳐서 도착한다.
    proxy_buffering off;
}
```

그리고 데몬에는 그 **공개 주소**를 알려준다.

```sh
export MOMO_WORKD_ATTACH_PUBLIC_URL="wss://host.example.com/v1/terminal-attach"
```

경로는 프록시가 정한다. 데몬은 업그레이드 요청의 경로를 검사하지 않으므로
`proxy_pass`가 경로를 갈아끼워도 동작한다.

프록시를 두지 않고 LAN에 직접 노출하는 구성은 지원하지 않는다. 그 경우
`MOMO_WORKD_ATTACH_BIND=0.0.0.0`으로 열 수는 있지만, 그때 오가는 것은 평문
터미널 바이트와 평문 capability 토큰이다.

## 호스트 capability 등록

서버는 `work_host.capabilities.terminal_attach = true`인 호스트의 바인딩만
받는다(`requireRemotePTYCapableHost`). 데몬은 attach가 설정돼 있을 때만 이 플래그를
등록에 실어 보낸다. **capability를 나중에 바꾸는 REST는 없다.** 이미 등록된 호스트에
attach를 켜려면 로컬 host-id 파일을 지우고 재등록해야 한다.

```sh
# 재등록: 새 work_host 행이 생긴다(기존 행은 revoke 대상)
rm -f ~/.momo/workd.host-id
MOMO_WORKD_ATTACH_PUBLIC_URL=wss://host.example.com/v1/terminal-attach \
MOMO_WORKD_REGISTRATION_TOKEN=... \
  momo-workd --bootstrap-only
```

## 연결이 성립하는 순서

1. 사람이 momo 서버에 `POST .../terminal-attach` → `attach_endpoint`,
   `capability_token`(TTL 60초), `pty_id`를 받는다.
2. 클라이언트가 그 엔드포인트로 WebSocket 업그레이드. 토큰은 mac이면
   `Authorization: Bearer`, 브라우저면 서브프로토콜 목록
   `momo.terminal.v1, <token>`으로 온다. 데몬은 둘 다 받는다.
3. 데몬이 **서버에** `POST .../work-hosts/{host}/terminal-attach/validate`를
   호스트 서명으로 보낸다. 만료·세션 종료·호스트 revoke·채널 멤버십·
   controller/observer 등급이 전부 이 한 번의 답에서 정해진다. 데몬은 토큰을
   스스로 판정하지 않는다(문법 검사만 한다).
4. 101 응답 후 클라이언트가 `{"type":"connect","pty_id":...}` 한 프레임을 보낸다.
   grant의 `pty_id`와 다르면 1008로 끊는다.
5. 데몬이 `PTYReplayBuffer.connect()`를 그대로 wire에 태운다:
   **보관된 바이트(binary 프레임) → `replay_end`(text 프레임) → 라이브(binary)**.

`replay_end` / `replay_overflow`는 터미널 바이트가 아니라 **text 제어 프레임**이다.
클라이언트는 이걸 xterm에 쓰면 안 된다(웹은 `ObserverTerminal`, mac은
`MomoRemoteTerminalSession`에서 걸러낸다).

## 스트림이 열린 뒤의 권한 회수 (MOMO-674)

`capability_token`의 60초 TTL은 **발급~다이얼 창**이다. 스트림 수명이 아니다.
그래서 데몬은 열려 있는 소켓마다 같은 서명 호출을 주기적으로 한 번 더 한다:

```
POST .../work-hosts/{host}/terminal-attach/validate
{"capability_token": "...", "stream": true}
```

`stream: true`는 서버 쪽에서 **만료 절만** 건너뛴다. 세션 running/idle · 호스트
미revoke · grantee가 살아 있는 사람 · observer면 채널 멤버십과
`observation = 'open'` — 권한을 정하는 절은 매 호출에 그대로 걸린다. 따라서
소유자가 "소유자만 보기"로 닫거나 세션이 끝나거나 호스트가 revoke되면, **이미
열려 있던 스트림도 한 주기 안에** 1008 `capability revoked`로 끊긴다.

주기는 `MOMO_WORKD_ATTACH_REVALIDATE_INTERVAL_MS`(기본 30초)이며 TTL과 무관한
별개의 정책값이다. 이 주기가 곧 **회수 지연 상한**이다: 30초로 두면 권한이
사라진 관전자가 최대 30초 더 본다.

재검증은 스트림을 건드리지 않는다 — 별도 태스크의 REST 왕복이고, 성공하는 동안
바이트는 그대로 흐른다. 끊는 것은 거절뿐이다.

**기각한 대안: 서버→데몬 revoke 신호.** 서버가 취소 시점에 해당 호스트로
"이 capability를 끊어라"를 밀어 주는 쪽이 지연은 0에 가깝다. 그러나 그러려면
서버에 outbound 호스트 채널이 새로 필요하다 — 데몬은 지금 **outbound 폴링만**
하고(ADR-0125 D2) inbound 인증 표면은 attach 리스너 하나뿐인데, 여기에 서버발
신호를 받으려면 (a) 새 REST/스트림 라우트 + 스펙 + 샘플, (b) 그 채널의 인증·재시도·
중복 억제, (c) 신호를 놓친 데몬을 위한 **결국 같은 주기 재검증** 폴백이 함께 온다.
(c)가 필요한 이상 큰 쪽은 작은 쪽의 상위집합이고, 회수 지연을 30초에서 0으로
줄이는 대가로 얻는 표면이 그만큼 크지 않다. 30초가 부족한 배치는 env로 낮춘다.

## 알아 둘 한계

- **`resize` / `kill` 프레임은 무시한다.** `HostPTYProcess`에 winsize API가 없고,
  kill은 이미 `work_control` 원장을 지나는 감사 경로가 있다. 호스트 PTY 폭은
  80칼럼 고정이며 웹은 그 사실을 `HOST_COLUMNS`로 문서화하고 있다.
- **observer는 아무것도 못 보낸다.** `send_stdin`을 보내면 1008로 끊긴다.
- **IPv4 전용 바인드.** IPv6로 노출하려면 프록시가 담당한다.

## 점검

```sh
# 리스너가 떴는지
lsof -nP -iTCP:28650 -sTCP:LISTEN

# 세션에 바인딩이 실렸는지(사람 베어러)
curl -s -H "Authorization: Bearer $MOMO_TOKEN" \
  "$MOMO_SERVER/v1/workspaces/$WS/work-sessions?active=true" \
  | python3 -m json.tool | grep remoteAttachAvailable
```

`remoteAttachAvailable: false`면 순서대로 의심한다: attach 미설정 →
`terminal_attach` capability 미등록(재등록 필요) → 세션이 ACP 전송(PTY 없음).
데몬 로그의 `work host attach binding failed`가 셋을 구분해 준다.

## 상설 검증기

```sh
scripts/verify_workd_attach.sh
```

격리 스택(28430~28433) + 실제 `momo-workd` + 자가서명 TLS 프록시(API_PORT+71) 앞에서
브라우저와 같은 방식(서브프로토콜 베어러)으로 다이얼해 **직전 출력 → `replay_end`
1개 → `send_stdin` → 라이브 출력**을 단정하고, 이어서 열린 observer 스트림이
소유자의 "소유자만 보기"에 1008로 끊기는지를 단정한다. 실패는 전부 단계 이름으로
나온다(`replay_end`, `replay_end_exactly_once`, `live`, `revoked_close`).

red proof 두 겹:

- 매 실행: `terminal_attach_probe.py --selftest`이 마커를 깨뜨린 wire 3종(마커 없음,
  `replay_overflow`로 대체, 라이브 중 두 번째 마커)에서 각자 이름으로 실패하는지
  확인한다. Docker 불필요.
- 선택: `WORKD_ATTACH_PROVE_RED=replay-marker scripts/verify_workd_attach.sh`가
  레포 **사본**에서 `PTYReplayEndFrame.type`을 바꿔 `momo-workd`를 다시 빌드하고,
  그 데몬으로는 검증기가 반드시 실패해야 통과한다. 워크트리는 건드리지 않는다.
