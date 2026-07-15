# 02 · momo의 뼈대 해설 — 불변식 6개를 "왜"로 풀어쓰기

> 최종 대조: 2026-07-15 @ 9c1fc7a · 정본 아님 — 구조의 정본은 `docs/architecture/overview.md`

이 장은 momo의 제1불변식 6개가 **어떤 사고를 막기 위해 존재하는지**를 설명하고, 실제 서버 한 대의 해부도를 그린다. 01장의 문제 번호(M1~M11)를 계속 인용한다.

---

## 1. "Postgres = 유일한 진실, Centrifugo = 전송 전용" — 두 개의 진실 금지

모든 실시간 시스템은 유혹을 받는다: "websocket 서버가 이미 메시지를 들고 있는데, 히스토리도 거기서 주면 빠르지 않을까?" 이 유혹에 넘어가는 순간 진실이 두 개가 된다. DB와 websocket 서버의 내용이 어긋났을 때(반드시 어긋난다 — 재시작, 유실, 순서 꼬임) 어느 쪽이 옳은지 판정할 기준이 사라진다.

momo의 답: **Centrifugo는 우체부다.** 편지 내용의 원본은 항상 Postgres에 있고, Centrifugo history는 "짧은 끊김 후 빠른 따라잡기"용 편의일 뿐이다(M3). 클라이언트가 오래 끊겼다 돌아오면 REST `?after=<seq>`로 PG에서 backfill한다 — 권위는 언제나 한 곳이다.

같은 원리가 읽음 상태(M4)에도 적용된다: Centrifugo가 read-state 이벤트를 나르지만 판정·보관은 전부 PG `read_state`다(ADR-0109).

## 2. 단일 쓰기 경로 — 모든 쓰기는 한 문으로 들어온다

**REST → PG 트랜잭션(메시지 + seq + outbox) → OutboxRelay → Centrifugo publish.**

이 문장이 momo 서버의 절반이다. 실제 코드로 따라가 보자:

1. 클라이언트가 `POST /v1/workspaces/:ws/channels/:ch/messages`를 호출한다(`server/Sources/MomoServer/MessageRoutes.swift:19`).
2. 서버는 **한 트랜잭션 안에서** ① `channel_seq` 행을 잠가 다음 번호를 뽑고(M1) ② `message` 행을 쓰고 ③ `outbox`에 브로드캐스트 행을 남긴다. 트랜잭션이니까 셋 중 하나만 성공하는 일이 없다 — "저장됐는데 전파 예약이 안 된" 상태가 원천 봉쇄된다(M2·M3).
3. OutboxRelay(별도 프로세스)가 `SELECT ... FOR UPDATE SKIP LOCKED`로 outbox 행을 집어 Centrifugo `/api/publish`로 밀어 넣는다(`relay/OutboxRelay/Sources/OutboxRelay/RelayService.swift:11-16,146-159`). SKIP LOCKED 덕분에 relay를 여러 개 띄워도 서로 같은 행을 집지 않는다 — 지금은 1개지만 다중화가 코드 변경 없이 가능한 이유.
4. Centrifugo가 채널 네임스페이스(`ch:`/`dm:`/`agent:`/`agentwork:`/`user:`, `infra/centrifugo.json:3-24`)로 websocket 구독자들에게 push한다. 구독 시도는 Centrifugo가 서버에 되물어 재검증한다(subscribe proxy → `POST /v1/centrifugo/subscribe`) — 전송 계층이 권한 판단을 하지 않는다는 원칙의 구현.

에이전트도 같은 문을 쓴다. Hermes가 답장을 보낼 때도 REST로 들어오지, Centrifugo에 직접 publish하지 않는다. **예외 없음**이 이 설계의 가치다 — 예외가 하나라도 생기면 감사(audit)·멱등·순서 보장이 그 구멍으로 전부 샌다.

## 3. 순서의 진실은 `message.seq` — 왜 PG sequence가 아닌가

01장 M1에서 설명한 대로, momo는 채널별 gapless 카운터를 쓴다. Postgres 내장 sequence를 쓰지 않는 이유를 다시 강조할 가치가 있다: sequence는 성능을 위해 트랜잭션 밖에서 번호를 나눠주므로, 롤백된 트랜잭션의 번호가 영구 결번이 된다. 결번이 있으면 클라이언트가 "3 다음 5가 왔네, 4를 기다릴까 말까"를 판정할 수 없다. gapless 카운터의 대가는 채널당 쓰기 직렬화(행 잠금)인데, 이는 오히려 **채널 내 순서 부여 지점이 정확히 하나**라는 보증이 된다 — 03장에서 보겠지만 Slack의 Channel Server, Discord의 guild process가 하는 역할을 momo에선 PG 행 잠금이 한다.

## 4. 에이전트는 평범한 `member`다 — Slack 봇과의 근본 차이

Slack의 봇은 "외부에서 API 토큰으로 메시지를 쏘는 존재"다. momo의 에이전트는 `member.kind='agent'`인 워크스페이스 멤버로, 사람과 같은 REST, 같은 멱등성, 같은 RLS를 통과한다(shared-PK 서브타입: member ← human/agent).

이 대칭이 사주는 것: 에이전트의 모든 발화·실행·비용이 사람과 같은 원장에 남고(M11), 채널 초대·권한·감사 규칙을 에이전트용으로 따로 만들 필요가 없다. 실행 개체(`agent_run`), 승인(`approval`), 비용(`usage_ledger`)은 이 위에 얹힌 확장이다. 실행 자체는 momo 서버가 아니라 에이전트 호스트에서 일어난다(ADR-0111 D2) — momo 서버에 임의 코드 실행(RCE) 표면을 만들지 않고, provider 자격증명(ADR-0004)도 서버에 들어오지 않는다.

## 5. RLS FORCE — DB가 마지막 방어선 (M9)

모든 테넌트 테이블에 Row-Level Security가 강제된다: 앱은 `app.workspace_id` GUC를 세팅한 커넥션으로만 쿼리하고, DB 엔진이 다른 워크스페이스 행을 물리적으로 걸러낸다(`001_init.sql:388-391`). 앱 role(`momo_app`)은 NOBYPASSRLS — 앱 코드에 버그가 있어도 크로스 테넌트 유출이 DB에서 막힌다. relay/worker만 BYPASSRLS로 전 테넌트 outbox를 폴링한다(전파는 테넌트 횡단 작업이므로).

최근 확장(MOMO-383): 테넌트의 루트인 `workspace` 테이블 자체에도 RLS를 걸고, 초대 코드로 워크스페이스를 찾는 닭-달걀 문제는 잠긴 스키마의 EXECUTE 전용 함수(정확히 hash→UUID 하나만 반환)로 풀었다(`009_workspace_tenant_rls.sql`). "편의를 위한 예외를 만들지 않고, 예외가 필요한 지점을 최소 표면의 전용 통로로 만든다"는 momo 보안 문법의 표본이다.

## 6. 서버 한 대의 해부도 — prod compose

셀프호스팅 배포판의 실체는 `infra/prod/docker-compose.prod.yml` 하나다. 서비스 8개:

| 서비스 | 역할 | 노출 |
|---|---|---|
| caddy | TLS 자동발급(ACME) + 리버스프록시. `api.<도메인>`→api, `rt.<도메인>`→centrifugo | 80/443 (유일한 공개면) |
| postgres | SoT (PG18) | private망 전용 |
| redis | Centrifugo 엔진 백엔드 | private망 전용 |
| centrifugo | websocket 전송 (Redis 엔진 — 다중 노드 준비) | caddy 뒤 |
| api | MomoServer (stateless REST) | caddy 뒤 |
| relay | OutboxRelay | 내부 |
| worker | AgentWorker (managed 경로) | 내부 |
| migrate | one-shot 마이그레이션 | 실행 후 종료 |

주변 장치: 시크릿은 SOPS+age로 암호화해 git에 두고 배포 시 메모리에서만 복호화(`docs/DEPLOY.md:118-147`), 위험한 기본값은 preflight가 fail-fast(`scripts/prod_env_preflight.sh`), 백업은 pgBackRest + 복원 리허설 스크립트, 이미지는 GHCR에 수동 발행(`.github/workflows/publish-images.yml`) 후 digest로 pin. 대상은 EC2 t4g.large 1대(`docs/AWS_INTERNAL_ALPHA.md:11`)다.

**읽는 법**: 이 compose가 곧 "momo 서버를 판다"의 단위다. 05장의 셀프호스팅 계열과 비교하면 momo는 이미 Mattermost/Zulip급 배포 뼈대(TLS 자동화·시크릿·백업·preflight)를 갖췄고, 없는 것은 install/upgrade 스크립트(ADR-0002가 예약)와 "비개발자용 포장"이다.

## 7. 확장은 재작성이 아니라 레버다

`docs/DEPLOY.md:504-515`가 정본. 요지: API는 stateless라 Caddy 뒤 N대(M10), relay/worker는 SKIP LOCKED라 그냥 더 띄우면 되고, Centrifugo는 Redis 엔진 공유로 노드 추가, DB는 read replica → 파티셔닝 순. **v0의 단일 인스턴스 SPOF는 결함이 아니라 결정이다** — 10인×수팀 규모에서 HA의 비용(운영 복잡도)이 이득을 압도하기 때문이고, 이는 05장에서 보듯 업계 표준 판단이다(Mattermost도 2,000 동시 사용자까지 단일 서버를 안내한다).

## 8. 요약 — momo 뼈대의 한 문장들

1. 진실은 한 곳(PG), 전송은 우체부(Centrifugo) — 어긋나면 항상 PG가 옳다.
2. 모든 쓰기는 한 문(REST→한 트랜잭션→outbox) — 예외 없음이 감사·멱등·순서의 전제.
3. 순서는 번호표(channel_seq) — 결번 없는 정수 하나가 정렬·결손감지·읽음위치를 전부 해결.
4. 에이전트는 멤버 — 같은 문, 같은 원장, 같은 규칙. 실행만 서버 밖.
5. 격리는 DB가 강제(RLS FORCE) — 앱 버그가 유출로 이어지지 않는 마지막 방어선.
6. 한 대로 시작하되, 모든 구성요소가 "여러 개 떠도 안전"하게 설계 — 확장은 설정 변경.
