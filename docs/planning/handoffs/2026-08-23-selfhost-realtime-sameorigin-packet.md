# T-9 셀프호스트 실시간 same-origin 파생 패킷 — D8 P1 원천 수리

> Status: `ready`(**착수 게이트=ADR-0167 Accept**) · Planning ID: `PLN-20260822-01` 후속 · Planner owner: Fable · Integrator: momo-main
> 발급: 2026-08-23 · 기준 커밋: `fba50751`(main) · Supersedes: 없음
> 근거 ADR: **ADR-0167 (Proposed — 성재 Accept 대기)** · ADR-0110(불변 — 증보 관계)
> GitHub binding: T-9=#1678 · 워커: grok 4.6 병렬 1 · 검수: Fable · **발사는 성재 명시 신호 대기**

## 0. 전제 (성재 지시 2026-08-23)

D8 실측 P1("원격 데스크탑 실시간 레일 사망")에 대해 성재가 "원천적으로 문제 해결할 방법 마련"을 지시. 즉석 완화(그록봇 VM env 2줄 수기)는 오케스트레이터가 릴레이로 별도 집행 — 이 티켓은 **다음 셀프호스터가 같은 함정을 밟을 수 없게 만드는 구조 수리**다.

## 1. 결함 사슬 (전부 실측 좌표)

1. `scripts/self_host_env.sh:796` → `MOMO_CENTRIFUGO_WS_URL=ws://localhost:$WEB_PORT/connection/websocket` (생성 시점에 터널/도메인 무인지).
2. `server-rust/bins/momo-server/src/config.rs:1693 realtime_ws_url_from_env` — 절대 ws/wss면 verbatim 채택, 부팅 시 고정(`main.rs:157`→`lib.rs:147 AppState.realtime_ws_url`).
3. 광고 3지점: `routes/auth_routes.rs:259` · `routes/join.rs:220` · `routes/claim.rs:133`.
4. 클라 verbatim(ADR-0110): `clients/web/src/lib/realtime.ts` — loopback 스파이크 재작성의 주석이 "proper fix remains server-side"라고 이미 적시.
5. 부수: 생성기 `CENTRIFUGO_ALLOWED_ORIGINS`(compose `infra/rust/docker-compose.rust.yml:87` 소비)에 공개 오리진 부재 → 브라우저 세션 403 잔존 경로.
6. 실측: Funnel 경유 `/connection/websocket` 업그레이드 **101**(Caddy) — same-origin 파생이 유효함의 증명. D8 증거 14샷 `claudedocs/e2e-d8-desktop-20260823/`.

## 2. 작업 계약

### ① 서버 — same-origin 센티널 (ADR-0167 Decision 1)
- `realtime_ws_url_from_env`: `MOMO_CENTRIFUGO_WS_URL=same-origin`(트림·소문자 비교) → `SameOrigin` 변형. 절대 ws/wss → `Fixed(verbatim)`. 그 외 → 현행 loopback 폴백 유지.
- `AppState.realtime_ws_url: Arc<String>` → 이계 타입(예: `RealtimeAdvert::Fixed(String) | SameOrigin`). 광고 3지점이 요청 헤더로 파생: `X-Forwarded-Proto`(https→wss, http→ws) + `Host`(포트 보존). 헤더 부재 시 연결 스킴 폴백. 파생 함수는 한 곳(단위 테스트 표면).
- 부팅 로그(`lib.rs:391` Debug 포함)가 모드를 정직하게 찍을 것.

### ② 생성기 — 기본값 교체 + `--public-origin` (Decision 2)
- `self_host_env.sh:796` 기본값 → `same-origin` (주석에 ADR-0167 근거 1줄).
- 신설 `--public-origin <https://host>`: `CENTRIFUGO_ALLOWED_ORIGINS`에 공백구분 항목으로 **멱등 추가**(2회 실행=1항목·기존 항목 보존). 기존 env 파일 재실행(재생성) 경로와 정합 확인.

### ③ 플레이북 (Decision 3)
- `docs/SELF_HOST_AGENT.md`: 터널 계층에 "공개 오리진 등록 한 줄 + `up -d` + 검증 문장(로그인 응답 `realtimeWebSocketUrl`==`wss://<공개호스트>`)" 추가. 현재 websocket/realtime 문면 0건(grep 실측)인 공백을 메운다.
- `docs/SELF_HOST.md` 터널/외부 노출 절 동기.
- `check_docs_commands` 그린 유지.

## 3. AC (ADR-0167 검증 계약 전문)

- 단위: 센티널 파싱 3분기 · 파생 규칙(XFP·Host 포트·폴백).
- 통합 red proof: ①구형 기본값+원격 Host → localhost 광고(결함 재현 빨강) ②same-origin+`Host: cursor.tailb1aad3.ts.net`+`X-Forwarded-Proto: https` → `wss://cursor.tailb1aad3.ts.net/connection/websocket` ③절대 URL 설정 시 Host 무시(ADR-0110 회귀 가드).
- 생성기 멱등 단정 · openapi 무변경 확인(값 산출 방식만 변화).
- 프로덕션(분리 도메인 절대 URL) 무영향 단정 1개.

## 4. 함정

- **Host 헤더 신뢰 경계**: 파생 광고는 요청자 자신의 응답에만 실린다 — 그래도 파생 함수에 스킴 화이트리스트(ws/wss만 산출)·CRLF 거부를 넣을 것.
- Centrifugo Origin 허용목록 **완화 금지**(토큰 인증이라 심층방어지만 기본값은 유지 — ADR-0167 Decision 4).
- 스키마·`schema_v0.sql` 비접촉. 시크릿 커밋 금지. 트랙=engine.
