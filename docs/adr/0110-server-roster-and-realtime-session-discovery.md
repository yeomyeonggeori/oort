# ADR 0110: real-server roster SoT와 realtime session discovery

> Status: **Accepted** (2026-07-13, 성재 승인, MOMO-354 / Issue #341)
> Date: 2026-07-13
> Related: ADR-0002, ADR-0100, ADR-0101

## Context

첫 dogfood에서 macOS real-server 세션이 서버 roster 대신 demo fixture를 표시했고,
이름 기반 로컬 필터가 초대된 에이전트까지 숨겼다. 동시에 앱은 Centrifugo 공개
WebSocket 주소를 프로세스 환경에서만 알 수 있어 GUI 로그인 세션이 realtime을 놓쳤다.
Postgres membership가 초대 여부의 권위라는 제품 원칙과 실제 클라이언트가 어긋났다.

## Options

1. 앱 fixture와 이름 기반 예외를 계속 유지한다. 서버 데이터와 드리프트하므로 기각한다.
2. API base URL에서 realtime 주소를 추론한다. prod는 API와 realtime 도메인이 분리되므로 기각한다.
3. 서버 roster를 유일한 real-server 멤버 권위로 쓰고, auth session이 공개 realtime 주소를 광고한다.

## Decision

Option 3을 채택한다.

- real-server 앱은 `GET /v1/workspaces/:ws/roster` 결과의 active member와
  `channelIds`만 멤버 사이드바, 멘션 후보, 메시지 작성자 해석에 사용한다.
- 에이전트 가시성과 agent realtime 구독은 선택 채널의 active membership가 있을 때만
  허용한다. 표시 이름이나 fixture ID에 기반한 숨김/허용 예외는 두지 않는다.
- `POST /v1/auth/login`과 `POST /v1/join`은 additive 필드
  `realtimeWebSocketUrl`을 반환한다. 서버 배포는 `MOMO_CENTRIFUGO_WS_URL`로 이 공개
  `ws`/`wss` 주소를 소유한다.
- 앱은 서버 응답을 우선하며, 이전 서버와 개발 편의를 위해 앱 환경값을 fallback으로만 쓴다.
- offline demo는 `LiveChatBackend` fixture에 남고 REST backend에는 fixture fallback을 두지 않는다.

## Consequences

- 초대/제거 직후 채널 가시성과 멘션 가능성이 같은 membership 계약으로 수렴한다.
- API/realtime 도메인이 분리된 배포에서도 GUI 로그인만으로 live subscription을 구성한다.
- 이전 서버 응답은 optional client decode로 호환되지만, realtime은 앱 env fallback이 없으면
  REST history 모드로 남는다.
- 서버가 잘못된 realtime URL을 광고하면 앱은 조용히 다른 주소로 우회하지 않고 세션 decode를
  실패시켜 운영 설정 오류를 드러낸다.
