# ADR 0101: 에이전트 신원 모델 — 공유 시크릿에서 per-agent 자격증명 + 위임으로

> Status: Accepted — Option A (성재 승인, 2026-07-10)
> Date: 2026-07-10
> Related: ADR-0100, ADR-0004(provider 자격증명 경계 — 본 ADR과 직교, 그대로 유지), 2026-07-09 진단 §5

## Context

**momo가 agent-native를 표방하면서 아직 봇 수준인 지점의 뿌리가 여기다.**

현재 상태:

- 에이전트 인증은 **전 에이전트·전 워크스페이스 공용 시크릿 1개** (`X-Momo-Agent-Gateway-Secret`, `AGENT_GATEWAY_SECRET` env, `server/Sources/MomoServer/Routes/AgentGatewayRoutes.swift`의 상수시간 비교). 스코프 없음, 회전 절차 없음, 에이전트 구분 없음 — 시크릿 보유자는 이름을 아는 어떤 run에든 콜백을 쏠 수 있다.
- 스키마는 이미 한 세대 앞서 있다: `token` 테이블(`001_init.sql`)에 `token_kind='agent_bearer'`(에이전트 자체 자격증명)와 `'delegation'`(actor가 subject를 대신해 행동 — 에이전트가 "누구로서" 작업하는지), `scopes text[]`, `token_hash`, 만료/폐기 컬럼, 그리고 `audit_log.via_token_id`(어떤 토큰으로 승인된 행동인지 추적)까지 설계돼 있다. **코드가 이를 전혀 사용하지 않는다.**
- 부작용: Hermes 어댑터가 REST 쓰기를 위해 **사람 오퍼레이터 계정으로 로그인**한다(email/password). 이 우회 때문에 (a) 에이전트의 행동이 사람 계정 자격으로 섞이고, (b) 15분 만료 access token을 리프레시하는 코드가 없어 장시간 구동 시 401로 죽는 실버그가 존재한다.

## Slack은 어떻게 했나

Slack의 봇은 **앱 단위 bot token(`xoxb-`)** — 워크스페이스별 발급, OAuth 스코프로 권한 제한, 관리자 회전/폐기 가능. 사람 권한이 필요하면 별도의 user token(`xoxp-`)을 명시 동의로 발급한다. 즉 "봇 신원과 사람 신원의 분리 + 스코프 + 폐기 가능성"이 업계 기본선이다. momo의 `delegation`(actor/subject) 모델은 여기서 한 발 더 나간 것 — Slack에는 "봇이 특정 사람을 대신해 행동했고 그 사실이 감사로그에 남는" 1급 개념이 없다. 스키마 설계는 이미 Slack을 넘어서 있고, 구현이 Slack 이전 수준에 있는 상태다.

## Options

### Option A — `agent_bearer`를 실제 인증 경로로 (권고)

에이전트 초대(페어링) 시 서버가 per-agent bearer 토큰을 발급하고, 어댑터의 **모든** 호출(메시지 전송, realtime-token, pending 폴링, gateway 콜백)이 `Authorization: Bearer <agent-token>`으로 인증한다.

- 발급: 페어링 위저드의 초대 완료 시 서버가 mint → sha256 해시만 `token` 테이블 저장(기존 세션 토큰과 동일 패턴) → 원문은 1회 노출로 `~/.momo/hermes-gateway.env`에 기록 (기존 매니페스트의 "시크릿은 env 파일 참조" 설계와 자연 결합).
- 스코프 v0: `agent:jobs:read`, `agent:runs:callback`, `messages:write`, `realtime:subscribe` — 로그인 시 하드코딩되는 사람 스코프보다 먼저 에이전트 쪽에 진짜 스코프 검사를 도입.
- AuthMiddleware가 agent principal을 해석 → 메시지 작성자가 곧바로 agent member (오퍼레이터 로그인 우회 제거 → 토큰 리프레시 버그 클래스 소멸).
- 회전/폐기: `revoked_at` + 페어링 UI에서 재발급. 회전 중 이중 유효 기간 허용.
- realtime 경계: user-visible `agent:` progress와 private `agentwork:` job을
  분리한다. `agent:`는 같은 활성 채널을 공유한 멤버가 관찰할 수 있지만,
  Context Packet을 포함하는 `agentwork:`는 token actor와 target agent가 정확히
  같은 경우만 허용한다. 한 namespace에 관찰 이벤트와 실행 입력을 섞지 않는다.
- **Phase 2 (같은 ADR 범위, 후속 티켓)**: `delegation` 토큰 — 승인(approval) 통과 시 해당 run 한정으로 "사람 X를 대신해" 토큰을 단기 발급, `audit_log.via_token_id`로 추적. "Who-as-Whom" 시그니처 경험의 기반.
- 마이그레이션: `AGENT_GATEWAY_SECRET`는 deprecation 기간 동안 병행 수용(env flag) 후 제거.

**장점**: 스키마 그대로 사용(마이그레이션 불필요), Slack 동급+α 도달, 실버그 2종 해소, agent-native 신뢰 기반 완성. **단점**: 서버 인증 미들웨어·어댑터·페어링 위저드 3면 수술 — 티켓 2~3장 규모.

### Option B — 공유 시크릿 유지 + 워크스페이스별 분리·회전만 추가 (기각 권고)

최소 변경이지만 "에이전트가 누구인가"를 여전히 답하지 못한다. 위임·스코프·감사 추적 전부 불가. 지금 고치지 않으면 어댑터의 오퍼레이터 로그인 우회가 계속 굳는다.

### Option C — mTLS / 요청 서명 (HMAC per-agent key) (기각 권고)

보안 상한은 높지만 로컬 dogfood~소규모 팀 단계에 과설계. 인증서 배포·회전 운영 부담이 페어링 UX를 해친다. bearer 모델로 충분하며, 필요해지면 A 위에 추가 가능.

## Decision

**Option A 채택** (성재, 2026-07-10). Phase 1: `agent_bearer`를 에이전트의 유일한 인증 경로로 승격(페어링 발급, 스코프 검사, 회전/폐기, 오퍼레이터 로그인 우회 제거, `AGENT_GATEWAY_SECRET` deprecation 병행기). Phase 2: 승인 연동 `delegation` 토큰 + `audit_log.via_token_id` 추적. 구현 티켓: MOMO-337(서버) / MOMO-338(어댑터) / MOMO-339(클라 페어링) — `BUILD_TICKETS.md` 참조.

## Consequences (Option A 기준)

- 페어링 위저드가 "설정 패널"에서 "자격증명을 발급하는 진짜 페어링"으로 승격 — 초대 경험의 차별화 지점.
- 에이전트별 폐기가 가능해져 다중 에이전트 로드맵(ADR-0106)의 전제 충족.
- 티켓 스케치: ① 서버 — agent_bearer 발급/검증 + 스코프 검사 + 게이트웨이 라우트 이관 ② 어댑터 — 오퍼레이터 로그인 제거, bearer 단일화 ③ 클라 — 페어링 위저드 발급 플로우 + 회전 UI. (각각 Accepted 후 Codex 티켓으로 변환)

## References

- `server/Migrations/001_init.sql` (token, audit_log 테이블)
- `server/Sources/MomoServer/Routes/AgentGatewayRoutes.swift` (현행 공유 시크릿 검증)
- `adapters/hermes/momo_adapter.py` (오퍼레이터 로그인 + 미사용 refreshToken)
- Slack: OAuth & bot token 모델 (api.slack.com/authentication) — 스코프·회전·폐기의 업계 기본선
