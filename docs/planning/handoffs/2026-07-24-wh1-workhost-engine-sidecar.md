# 핸드오프 패킷 — WH-1: work host 사이드카 동봉(opencode+goose) + 연결 어댑터 3종 (MOMO-579 / #705)

> ADR-0114 증보1 (Accepted 2026-07-24) · WH-0 스파이크 실증 (`docs/planning/2026-07-24-wh0-workhost-engine-spike.md`) · ADR-0125 work host fabric · ADR-0004 자격증명 경계.
> base=**track/engine** · worktree=`../momo-worktrees/705-opencode-goose-3-adr-0114-1-wh-1` · 다음 마이그레이션=**040**(필요 시) · verifier 포트=**28270대**.

## 목표 (한 줄)
성재가 배포판을 받으면 코드 실행 엔진이 이미 담겨 있어(opencode 우선 + goose 병행), oort가 그것을 프로그램으로 몰 수 있고, 독점 Codex는 로컬 연결한다. 자격증명은 여전히 oort 서버/DB/원장 비유입.

## 이미 있는 것 (재사용 — 새로 만들지 말 것)
- `workers/WorkHostDaemon`(executable `momo-workd`) + 라이브러리 `MomoACPHost`.
  - `MomoACPHost/ACPClient.swift`(actor, 396줄): ACP JSON-lines 클라이언트 — `prompt()`, `permissionResult()`(승인), terminal 관리. **이것이 곧 goose-acp 경로**(goose는 ACP를 말함). 새 어댑터의 모델.
  - `ACPTypes.swift`·`ACPValue.swift`·`ACPEventProjection.swift`·`ACPServerSummary.swift`.
- 서버: `Routes/WorkHostRoutes.swift`, `Auth/WorkHostAuthenticator.swift`, `Migrations/021_work_host.sql`.
- 검증기: `scripts/verify_work_host.sh`(MOMO-487, ADR-0125), `scripts/verify_acp_host.sh`, `scripts/mock_acp_agent.py`(mock ACP 에이전트). **새 mock은 이 파이썬 mock 형식을 따를 것.**
- 인프라: `infra/prod/docker/momo.Dockerfile`(565 단일 이미지), `swift-service.Dockerfile`, `docker-compose.prod.yml`(profile 패턴: `profiles: ["observability"|"eve"|"s3"]`).

## 수용기준 (전부 충족)

### A. 엔진 무관 어댑터 추상화 (핵심)
- `MomoACPHost`(또는 새 타깃 `MomoWorkEngine`)에 **`WorkEngineAdapter` 프로토콜** 도입: 엔진 무관 세션 생성 → 프롬프트/턴 → 이벤트 스트림 → **승인 요청/응답** → 종료. 승인은 단일 계약(`WorkApprovalRequest`/`WorkApprovalDecision`)으로.
- 구현 3종:
  1. **`ACPEngineAdapter`** — 기존 `ACPClient`를 프로토콜에 맞게 감싼다(goose용). 기존 동작 회귀 없음.
  2. **`OpenCodeHTTPAdapter`** — `opencode serve`(기본 127.0.0.1:4096, 키 없이 부팅) HTTP+SSE 구동. WH-0 실측 표면:
     - `POST /session {title?}` → `{id}` · `POST /session/{id}/message`(모델·agent·parts) 또는 `/session/{id}/prompt_async`
     - `GET /event` (SSE — assistant/tool delta) · `POST /session/{id}/permissions/{permissionID}`(승인) · `GET /doc`(OpenAPI 3.1)
     - 인증 opt-in: `OPENCODE_SERVER_PASSWORD`(HTTP basic, user=opencode).
  3. **`CodexJSONRPCAdapter`** — 로컬 `codex app-server`(newline-delimited JSON-RPC 2.0 over stdio, `"jsonrpc"` 필드 없음) 구동. WH-0 실측 라이프사이클: `initialize`+`initialized` 핸드셰이크 → `thread/start` → `turn/start` → 스트림(`item/agentMessage/delta`, `item/commandExecution/outputDelta`) → 승인 훅(`*ApprovalParams`/`*ApprovalResponse`). 스키마는 `codex app-server generate-json-schema --out <dir>`로 생성 가능(v1/v2). Codex는 **미동봉** — 사용자 호스트의 것 연결.
- **승인 경계 통일(ADR-0114 D5)**: opencode `/permissions` · Codex `*ApprovalParams` · ACP `session/request_permission`을 하나의 `WorkApprovalRequest`로 정규화해 work console이 엔진 무관하게 처리.
- 단위 테스트: 각 어댑터의 프로토콜 준수·승인 정규화·세션 라이프사이클을 mock transport로 검증(`WorkHostDaemonTests`).

### B. 엔진 선택 배선
- 엔진 선택(`opencode`|`goose`|`codex-local`, 기본 **opencode**)을 서버 설정으로. 새 테이블이 필요하면 마이그레이션 **040**(예: `work_host_engine` 또는 기존 `work_host`/설정 확장) — RLS 정책 포함, `schema_v0.sql` 불변. env보다 DB 설정 우선(provider_link 패턴 참고), 미설정 시 기본 opencode.
- 선택이 사이드카 구동 엔진으로 전파(daemon이 env/설정을 읽어 해당 어댑터 기동).

### C. 사이드카 이미지 + compose 프로파일
- `infra/prod/docker/workhost.Dockerfile`(신규): base + **opencode 바이너리(단일, MIT)** + **goose 바이너리(Apache-2.0)** + `momo-workd`. **레이어 분리**(엔진별). `codex`는 미동봉.
- `docker-compose.prod.yml`에 `workhost` 서비스 추가, `profiles: ["workhost"]`(opt-in). 565 단일 이미지 계보 유지.
- **라이선스 동봉**: opencode(MIT)·goose(Apache-2.0) LICENSE/NOTICE를 이미지에 포함 + `legal/THIRD_PARTY_NOTICES.md` 갱신.

### D. Docker verifier (`scripts/verify_workhost_engines.sh`, 포트 28270대)
- 사이드카(또는 opencode/goose 바이너리) 부팅 → **opencode**: `/doc` 200 + `POST /session` 실세션 생성 + (mock provider로) 최소 턴 왕복 + `/permissions` 승인 왕복.
- **goose(ACP)**: `mock_acp_agent.py`로 ACP 핸드셰이크 + prompt + 승인 왕복(기존 `verify_acp_host.sh` 재사용/확장 가능).
- **codex-jsonrpc**: mock codex app-server(신규, `mock_acp_agent.py` 형식의 mock JSON-RPC 응답기)로 initialize→thread/start→turn/start→승인 훅 왕복. 실 Codex는 OAuth 필요라 verifier는 mock.
- **ADR-0004 단정**: 어떤 provider 키/OAuth 토큰도 oort 서버 로그/DB/원장에 없음. 사이드카는 소비자.
- PASS/FAIL 라인 명확히(provider_link verifier 형식 참고).

## 하드 룰 (oort)
- **PR base=track/engine. PR 생성 후 STOP. merge/close/gate 절대 금지**(오케스트레이터가 수행).
- `schema_v0.sql` 수정·이동 금지. 시크릿 커밋 금지. 마이그레이션은 040부터, 번호 충돌 금지.
- ADR-0004 불변: provider 자격증명·Codex OAuth는 서버/DB/원장/패킷 비유입 — 사이드카는 사용자 호스트 자격 소비자, oort 서버와 신뢰경계 분리.
- Linux 컨테이너 함정 준수: 암묵 전이 import 금지(명시 의존), swift-crypto Sendable=`@preconcurrency import Crypto`, compose `--wait`는 exit-0 one-shot에 실패(install-shaped 시퀀스).
- 커밋 컨벤션 준수, 논리 단위로 커밋. 빌드+단위테스트는 커밋 전 통과(docker gate는 오케스트레이터).

## 스코프 현실 (정직)
- verifier의 codex-jsonrpc·goose는 **mock 대상**(실 Codex OAuth·실 goose 모델 호출은 CI 부적합). opencode는 실 바이너리로 부팅·세션 생성까지 실증, 모델 턴은 mock provider.
- 미확인 잔여(WH-0에서 명시): opencode `/session/{id}/message`의 실 모델 실행 왕복 → 이 티켓의 mock provider 통합 테스트에서 확인.
- 너무 커서 한 번에 안 되면: A(어댑터)+D(verifier) 먼저 완결하고 C(사이드카 이미지) 부분 진행 상태를 명확히 보고. B는 A에 종속.
