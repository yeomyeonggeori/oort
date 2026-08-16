# ADR-0162: 외부 에이전트 수용 3분류와 Agent Port — 다이얼인형 수용 표면

- Status: **Proposed** (기안 Fable 2026-08-12 — sol 검수 → 성재 승인 대기. 경계 변경: Accepted 전 구현 착수 금지, ADR-0100)
- 관련: ADR-0102(실행 경로 이중화 — **본 ADR은 제3 부류를 추가**), ADR-0130(외부 에이전트 멤버십·ACP — D4 Agent Card를 프로필 스키마로 승계), ADR-0113(커넥터 경계 — `/v1/mcp/drive` 서버 소유 MCP 선례), ADR-0101(agent bearer), ADR-0004(provider 자격증명 비유입 — 유지), ADR-0135(캐스캐이드 — 무관 확인), ADR-0150(유출 경계 — Slack 초인종 옵션 판단 시 참조)
- 발단: 성재 2026-08-12 — "Grok Bot으로 만든 봇을 oort에서 팀메이트로. oort 요청을 봇이 감지해 자기 방식으로 처리하는 hermes형 구조. 배포 허들 0의 호스팅 에이전트라 러프해도 실마리를 뚫으면 파급력이 크다."
- 리서치 정본: `docs/planning/research/2026-08-12-grok-bot-reverse-teammate-direction.md`(방향·실측·§8 설계 감사) · `2026-08-12-grok-bot-integration-feasibility.md`(제품 실체·인바운드 불가 판정)

## Context

1. **셋째 부류의 등장.** ADR-0102는 worker(managed)/gateway(BYOA) 이중 경로를 공식화했다. 두 경로 모두 "oort 또는 사용자가 에이전트 프로세스를 구동·호출할 수 있다"를 전제한다. Grok Bot(2026-08-11 베타, SpaceXAI+Cursor)류 호스팅 에이전트는 이 전제가 깨진다: 열거/호출 API·위임 OAuth·export·봇별 endpoint 전무(실측 확정), 봇은 **원격 MCP 서버를 커넥터로 소비**할 수 있고 웨이크업은 저쪽 루틴(스케줄/Slack/GitHub 이벤트)뿐이다. oort가 부를 수 없고, 에이전트가 다이얼인해야 한다.
2. **선례가 이미 레포에 있다.** `/v1/mcp/drive`(ADR-0113 D3/D5)가 서버 소유 MCP endpoint + agent bearer + 매 호출 grant 재검증 패턴을 성립시켰고, gateway 계약(pending/events/complete/lease)은 pull 기반으로 codex-workbench가 순수 계약 동작을 실증했다.
3. **표준 지형(2026-08 실측)**: MCP 2026-07-28 사양이 Tasks 확장(핸들 반환→재접속 폴링→결과 회수)을 공식 승격 — 다이얼인 일감 모델과 동형. ACP는 원격 전송 미완+접속 방향이 반대(클라이언트→에이전트), A2A는 호출자→피호출자 방향이라 둘 다 이 자리에 부적합. Telegram getUpdates의 offset 커서, Discord의 읽기(WS)/쓰기(REST) 분리, Slack Socket Mode의 토큰 분리가 차용할 전례.
4. **정책 정합**: 이 표면은 상대 플랫폼의 문서화된 기능(커스텀 MCP 커넥터·루틴)만 사용한다. 자격증명 방향도 "사용자가 oort 봇 토큰을 자기 에이전트에게 주는" 쪽이라 ADR-0004 비유입이 유지된다.

## Decisions

### D1. 수용 3분류 명명 정본화
| 분류 | 실체 | 호출 주도권 |
|---|---|---|
| **관리형(managed)** | worker 경로 + provider 체인 — 서버가 구동하는 상주 멤버 | oort |
| **연동형(BYOA)** | gateway 계약 + ACP 하네스 — 사용자 소유 프로세스가 참여 | oort(스폰/잡 배정) |
| **다이얼인형(dial-in)** | 부를 수 없는 호스팅 에이전트 — Agent Port로 당겨감 | 에이전트 |

제품 카피·문서·코드 주석에서 이 어휘로 통일한다. (종전 "hermes형" 통칭은 폐기 — hermes는 역사적으로 gateway 프로세스였으므로 오명이었다.) **네이밍 자체는 성재 확정 사항** — 대안 제시 환영.

### D2. Agent Port v0 — 원격 MCP 서버 표면
- 신설 endpoint(예: `/v1/mcp/agent-port`): MCP streamable HTTP 서버. 도구 6종 —
  `inbox_poll(after_seq, wait_hint)` · `thread_read(channel, thread, range)` · `message_post(channel, thread, body, idempotency_key)` · `task_claim(task_id, lease_sec)` · `task_complete(task_id, result)` · `task_release(task_id)`.
- **인박스**: 그 에이전트 멤버의 멘션·할당·구독 파생 뷰. 커서는 `message.seq`(at-least-once + 멱등 소비). `wait_hint` 상한 25초(무상태 지향 사양과 정합 — 장기 점유 금지).
- **전 도구는 기존 REST의 파사드** — PG 직쓰기 금지, 단일 쓰기경로(REST→PG→outbox→relay)·순서·RLS FORCE 전부 기존 기계장치 그대로. `message_post`는 멱등키 필수(재시도 안전).
- **에이전트=member 불변**: 다이얼인 에이전트도 기존 agent 멤버 계정이다. 새 신원 종류가 아니라 **접속 방식**의 추가다. 등록은 선언 기반(사용자가 에이전트 멤버 생성 후 토큰 발급) — ADR-0130 D4-B(수동 온보딩 v0)와 동일 위계.

### D3. 인증 — 스코프드 봇 토큰 v0, MCP OAuth 승격 경로 예약
- v0: 에이전트 멤버 단위 발급·회수 가능한 정적 bearer. 스코프=워크스페이스+채널 집합(그 멤버의 멤버십 부분집합만). `/v1/mcp/drive`의 매 호출 재검증 패턴 재사용. 스코프 밖 접근은 403 fail-closed.
- 승격 경로(2단계): MCP 2026-07-28 인증 계약 — RFC 9728 Protected Resource Metadata 게시, RFC 8707 오디언스 바인딩, CIMD. **v0 토큰 형식은 스파이크 실측(Grok 커넥터가 실제로 지원하는 인증 방식)이 결정** — 실측 전 과설계 금지.

### D4. 에이전트 접속 공식 허용 명문화
- oort 약관·셀프호스팅 문서에 "자동화 에이전트의 로그인·API 접속을 공식 허용" 명문화. computer-use형 에이전트(Grok Bot의 브라우저 로그인 포함)가 **약관 위반 없이** 들어올 수 있는 법적 기초 — "에이전트 접속을 환영하는 메신저" 포지션의 성문화.

### D5. 확장 겹 — 2단계 예약 (본 ADR 범위 밖, 방향만 고정)
- **Centrifugo 스코프드 read-only JWT 구독 + REST 쓰기**: 지속 연결 가능한 하네스(OpenClaw·자체 배포)용 저지연 겹. Centrifugo=전송전용 불변식 그대로(Discord 동형). 수요 실증 후 별도 티켓.
- **Slack 초인종 브리지**: 준실시간이 필요할 때 "새 일감 있음" 신호만 외부 채널에 발행(내용 0 — ADR-0150 유출 경계 보존). 외부 SaaS 의존이므로 **기본 경로가 아닌 opt-in 옵션** — 채택 여부 자체가 성재 결정.

### D6. 비목표 (명시적 거부)
- Grok Bot 전용 코드 경로 금지 — Agent Port는 벤더 중립, Grok Bot은 첫 클라이언트일 뿐.
- 상대 플랫폼 계정 자동화·리버스 API·봇 정의 반입 금지(AUP 저촉 — 리서치 판정).
- A2A 태스크 바인딩·Agent Card 게시는 ADR-0130 D4 승계 시점에 재론(스키마 차용만).

## Consequences

- (+) "부를 수 없는 에이전트"까지 3부류 전부에게 수용구가 생긴다 — 배포 허들 0 호스팅 에이전트(Grok Bot 등)가 커넥터 등록+루틴 1개로 팀메이트가 된다.
- (+) 표면 전체가 기존 불변식의 파사드라 신규 보안 표면이 최소(신설분은 봇 토큰 발급·회수뿐).
- (−) 다이얼인형의 실시간성은 저쪽 웨이크업 주권에 종속(배치형 한계) — 제품 카피에서 정직하게 고지 필요.
- (−) 공개 HTTPS 노출 필수(Grok 커넥터가 사설 IP 거부) — 셀프호스팅 문서에 터널/리버스 프록시 안내 추가.

## 검증 방향 (수용기준 초안 — 티켓화 시 구체화)

- red proof: 스코프 밖 채널 `inbox_poll`/`message_post` 403 · 멱등키 재전송 시 메시지 1건 유지 · 회수된 토큰 즉시 401 · `task_claim` 리스 만료 후 타 에이전트 재클레임 성립.
- 실증: MCP 클라이언트(임의 하네스)로 폴링→클레임→게시 폐곡선. Grok Bot 실기 실증은 Wave 0 스파이크(구독 계정 게이트)와 결합.
