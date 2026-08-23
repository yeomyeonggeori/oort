# ADR-0167: 셀프호스트 실시간 주소 광고 — same-origin 파생 옵트인

- Status: **Accepted** (2026-08-23 성재 승인 — "다 승인할게" 위임 집행, 기록=Fable/momo-main. 기안 같은 날 — D8 실측 P1 후속)
- 관련: ADR-0110(realtime 주소=서버 광고·클라 verbatim — **본 ADR은 증보이며 전복 아님**), ADR-0121(셀프호스트 배포), ADR-0166(claim 부트스트랩 — 같은 셀프서브 퍼널), ADR-0100(거버넌스)
- 실측 근거: D8 데스크탑 실접속 런(2026-08-23, `claudedocs/e2e-d8-desktop-20260823/` 14샷 + 모계획 §11 갱신 2)

## Context

D8(원격 데스크탑 실접속)에서 실시간 레일이 죽었다. 사슬은 전부 실측 좌표가 있다:

- `scripts/self_host_env.sh:796`이 `MOMO_CENTRIFUGO_WS_URL=ws://localhost:$WEB_PORT/connection/websocket`을 굽는다 — 생성 시점에 배포 토폴로지(터널/도메인/LAN)를 모른다.
- 서버는 이 값을 부팅 시 고정해(`config.rs:1693 realtime_ws_url_from_env` — 절대 ws/wss면 verbatim 채택) 로그인·join·claim 응답 `realtimeWebSocketUrl`로 광고한다(`auth_routes.rs:259`, `join.rs:220`, `claim.rs:133`).
- 클라이언트는 ADR-0110대로 verbatim 사용한다(`clients/web/src/lib/realtime.ts` — REST base가 loopback일 때의 스파이크 재작성 1개 예외뿐이며, 그 주석 스스로 "proper fix remains server-side"라고 적어 두었다).
- 결과: Funnel 너머의 데스크탑이 **자기 맥의 localhost:8088**로 WS를 시도하고, 그 포트는 비어 있어 실패한다. REST는 정상이라 "메시지는 보내지는데 실시간만 죽은" 반쪽 제품이 된다.
- **R-2 스파이크가 이를 못 잡은 이유**: 검증 머신=스택 호스트라 `ws://localhost:8088`이 우연히 옳았다. 원격 클라이언트가 처음 실측된 D8에서만 드러날 수 있던 결함이다.
- 수리 유효성은 실측됨: Funnel 경유 `/connection/websocket` 업그레이드 **101 통과**(Caddy 단일 진입이 WS까지 프록시).

부수 결함(같은 뿌리): Centrifugo는 업그레이드 전 Origin을 대조한다(`CENTRIFUGO_ALLOWED_ORIGINS`, compose `:87`). 생성기는 localhost 2종+tauri 2종만 적는다 — 터널 공개 오리진(`https://<tunnel-host>`)이 없어, WS URL을 고쳐도 **브라우저** 세션의 실시간은 403으로 남는다(데스크탑 tauri origin은 목록에 있어 통과).

## Options

1. **현행 유지 + 운영자가 터널마다 env 2줄 수기 수정** — 기각. 이번에 실측한 함정을 문서로만 막는 것. 셀프서브 퍼널(에이전트가 설치)에서 "사람이 아는 자만 피하는 함정"은 원천 결함으로 남는다.
2. **클라이언트가 REST base에서 WS 주소를 유도** — 기각. ADR-0110 옵션2의 기각 사유(운영은 API/realtime 도메인 분리) 그대로이며, 이미 출하된 v0.1.1 데스크탑에 소급 불가.
3. **서버가 요청 오리진에서 파생하는 same-origin 모드(옵트인 센티널)** — **채택.** `MOMO_CENTRIFUGO_WS_URL=same-origin`이면 응답 시점에 요청의 `X-Forwarded-Proto`/`Host`(신뢰 프록시 뒤) 또는 요청 스킴·호스트로 `ws(s)://<host>/connection/websocket`을 만든다. 절대 URL이 설정되면 지금처럼 verbatim(ADR-0110 불변 — 분리 도메인 운영 무영향). 이미 출하된 클라이언트가 그대로 혜택을 본다(서버 응답만 옳아지므로).

## Decision

Option 3 + 생성기·플레이북 동반 수리:

1. **서버**: `realtime_ws_url_from_env`에 `same-origin` 센티널 추가. AppState의 고정 문자열을 `Fixed(String) | SameOrigin` 이계로 바꾸고, 광고 3지점(login/join/claim)이 요청 헤더에서 파생한다. 파생 규칙: `X-Forwarded-Proto`(https→wss)·`Host` 우선, 부재 시 연결 스킴·Host. 포트는 Host에 있으면 보존.
2. **생성기**: `self_host_env.sh` 기본값을 `same-origin`으로 교체(단일 진입 Caddy 스택은 정의상 same-origin — Funnel 101 실측이 보증). 신설 `--public-origin <https://host>` 멱등 옵션: `CENTRIFUGO_ALLOWED_ORIGINS`에 공개 오리진을 추가(중복 없이). 터널·도메인 노출 시 운영자/에이전트가 할 일이 **이 한 줄 + `up -d`**로 수렴한다.
3. **플레이북**: `SELF_HOST_AGENT.md`(현재 websocket 문면 0건)와 `SELF_HOST.md` 터널 절에 위 한 줄 절차+검증 문장(`로그인 응답의 realtimeWebSocketUrl이 wss://<공개호스트>인지`) 추가.
4. **범위 경계**: Centrifugo Origin 허용목록은 유지한다(토큰 인증이라 origin 대조는 심층방어지만, 기본값 완화는 하지 않는다). 프로덕션(momo-rust 분리 도메인) env는 절대 URL 유지 — 본 ADR로 변경 없음.

## Slack·업계 비교

Slack·Discord류 SaaS는 실시간 게이트웨이 주소를 로그인 응답으로 광고하되 고정 도메인이라 이 문제가 없다. 셀프호스트 제품군이 같은 함정을 밟은 전례가 많고(Mattermost `WebsocketURL` 공란=페이지 오리진 파생 기본값, Rocket.Chat `Site_URL` 단일 진실), **"공란/센티널=요청 오리진 파생, 명시=verbatim"**이 표준 해법이다. 우리는 명시 경로가 이미 ADR-0110로 성문화돼 있으므로 파생 모드만 옵트인으로 더한다.

## Consequences

- (+) 터널 주소가 바뀌어도(quick tunnel 재발급·Funnel·도메인 이전) 서버 env 재작성 없이 실시간이 따라온다 — 셀프서브 퍼널에서 에이전트가 틀릴 수 있는 자유도 하나가 구조적으로 소멸.
- (+) 이미 출하된 v0.1.1 데스크탑·웹 번들이 코드 변경 없이 수혜(응답 값만 옳아짐).
- (−) 광고 주소가 요청 Host에 의존 — 신뢰 경계 주의. Host는 Caddy가 정규화해 전달하며, 악의 Host로 오염된 광고는 **그 요청자 자신의 응답**에만 실린다(타 사용자 영향 없음). 단정 테스트로 파생 규칙을 봉인한다.
- (−) AppState 문자열→이계 리팩터 접촉면(광고 3지점+부팅 로그). 소형.

## 검증 계약 (수용기준 골자)

- 단위: 센티널 파싱(absent/절대/`same-origin`) · 파생 규칙(XFP https→wss·Host 포트 보존·헤더 부재 폴백).
- 통합(red proof 포함): ①구형 기본값+원격 Host 요청 → localhost 광고(현 결함 재현=빨강 증명) ②same-origin+`Host: cursor.tailb1aad3.ts.net`·`X-Forwarded-Proto: https` → `wss://cursor.tailb1aad3.ts.net/connection/websocket` ③절대 URL 설정 시 Host 무시(verbatim — ADR-0110 회귀 가드).
- 생성기: `--public-origin` 멱등(2회 실행=1항목)·기존 항목 보존 단정.
- 실환경: 그록봇 VM에 재발행 digest 적용 후 로그인 응답 실측 + 데스크탑 실시간 배너 소멸.

## Accepted 후 봉인할 파라미터

센티널 문자열(`same-origin` 제안), 신뢰 프록시 헤더 집합(XFP/Host — `Forwarded` RFC 7239 채택 여부), `--public-origin`의 MOMO_PUBLIC_BASE_URL 동기화 여부.
