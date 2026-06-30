# momo — 백엔드 멀티팀 운영 배포 (DEPLOY.md, 2026)

> **목적:** momo 백엔드(MomoServer + OutboxRelay + AgentWorker + PostgreSQL 18 + Centrifugo v6 + hermes)를 **단일 강력 VPS**에 운영 배포(staging→prod)하고, **멀티팀(10명=1팀, 3개+팀)** 을 워크스페이스로 온보딩·운영하는 절차서.
> **로컬 기동은 `docs/RUN.md`**. 이 문서는 **운영 환경(실 VPS + 공인 도메인 + TLS + 시크릿 + 백업 + 모니터링)** 을 다룬다.
> **실행 주체:** 계획은 ROADMAP(M1 EP-DEPLOY / M2 EP-TENANCY·EP-ADMIN), 실제 작업은 **Codex가 goal로 자율 실행.** 산출물은 이 리포에 실제 파일로 생성한다.
> 정본 참조: `research/07-deepdive/04-self-build-l4-spec.md`(토폴로지 §1.1·확장 §1.4·횡단 §8) · `schema_v0.sql`(정본 스키마, RLS FORCE) · `infra/*`(dev compose/centrifugo) · `STATUS.md`/`ROADMAP.md`.
> 검증 표기: `(검증됨)` = 1차 출처 교차확인 · `(추정)` = 설계 디폴트. **법무는 법률 자문 아님 — 외부 변호사 1회 검토.**

---

## 0. 현재 상태와 이 문서의 위치 (STATUS.md 정합)

- Phase 0 = **5개 Swift 패키지 `swift build` green**.
- M1 런타임 일부 검증 완료: Docker Desktop 기준 PG18+Centrifugo compose health, migrate 멱등, MomoServer health/seq gapless, OutboxRelay→Centrifugo publish/history.
- M1 런타임 핵심 검증은 Docker Desktop 기준 MOMO-001~004에서 완료: compose/migrate/server health/seq gapless, OutboxRelay publish/history, RLS 격리, AgentWorker↔OpenAI-compatible SSE mock + 비용 회계.
- 남은 M1 배포 검증: 실제 staging URL/TLS/운영 시크릿 복호화·백업 복원·모니터링, 외부 hermes 재확인, WebSocket live subscribe/presence/recovery.
- 운영 배포는 아직 **미진행**(이 문서가 절차 정본). M1 = "staging URL 헬스 green + TLS 정상 + 시크릿 암호화 + 백업 1회 검증".
- **선결:** M0 런타임 e2e(서버↔PG18↔Centrifugo↔hermes 1왕복). M2 멀티팀 온보딩은 M1 위에서 성립.
- **이 문서가 만들/갱신할 산출물(Codex):**
  - ✅ `infra/prod/docker-compose.prod.yml` — Caddy(자동 TLS) + Redis + relay/worker 실서비스 승격 skeleton (MOMO-005)
  - ✅ `infra/prod/Caddyfile` — api/rt 도메인 라우팅 + 보안 헤더 (MOMO-005)
  - ✅ `infra/prod/centrifugo.prod.json` — Redis 엔진 전환본 (MOMO-005)
  - ✅ `infra/prod/.env.example` — production env 예시, 실제 시크릿 미포함 (MOMO-005)
  - ✅ `.sops.yaml.example` + `infra/prod/secrets.env.example` — SOPS/age 운영 계약, 실제 시크릿 미포함 (MOMO-006)
  - ✅ `infra/prod/pgbackrest*.example` + `docs/SECRETS_BACKUP_RUNBOOK.md` — 백업/복원 skeleton과 리허설 절차 (MOMO-006)
  - ✅ `scripts/verify_staging_smoke.sh` + `scripts/local_gate.sh --profile staging-smoke` — VPS 시크릿 없는 prod compose/Caddy/Centrifugo/secrets/pgBackRest local gate (MOMO-007)
  - ✅ `infra/prod/docker-compose.internal-smoke.yml` + `infra/prod/internal-smoke.env.example` + `scripts/verify_internal_hosting_smoke.sh` — 내부 테스트용 single-node hosting smoke gate (MOMO-216)
  - ✅ `infra/prod/docker/` + `scripts/verify_internal_host_runtime.sh` + `scripts/local_gate.sh --profile host-runtime` — local image 기반 prod+internal-smoke boot/health/migrate/message/relay/mock-agent runtime gate (MOMO-220)
  - ✅ `scripts/verify_backup_restore_rehearsal.sh` + `scripts/local_gate.sh --profile backup` — 임시 PostgreSQL source→dump→별도 restore→marker checksum evidence gate (MOMO-222)
  - ✅ `server/Migrations/003_onboarding.sql` — invite_code + redemption audit (MOMO-010)
  - ✅ `docs/RUN.md`에 staging smoke gate와 host-runtime 기동/롤백/시크릿/백업 절차 추가 (MOMO-007)

---

## 1. 운영 토폴로지 (L4 §1.1 → prod)

```
                         인터넷
                            │  (443 only)
                  ┌─────────▼──────────┐
                  │  Caddy (reverse proxy)│   자동 HTTPS(ACME) + 보안 헤더
                  │  api.<domain>  → api:8080      (REST + JWT + subscribe proxy 콜백)
                  │  rt.<domain>   → centrifugo:8000 (WS/SSE 실시간)
                  └───────┬───────────────┬───────┘
        compose 내부 네트워크(외부 비노출)  │
        ┌───────────────┐  ┌──────────────▼─────┐  ┌──────────────┐
        │ api (MomoServer)│ │ centrifugo v6        │  │ redis        │
        │ Hummingbird 2   │ │ Redis engine(presence│  │ (centrifugo  │
        │ stateless       │ │  /history/recovery)  │  │  엔진 백엔드) │
        └──────┬──────────┘ └──────────────────────┘  └──────────────┘
               │ tx: msg+seq+outbox
        ┌──────▼───────┐  ┌──────────────┐  ┌──────────────┐
        │ postgres 18  │  │ relay        │  │ worker       │
        │ SoT(RLS FORCE)│ │ OutboxRelay  │  │ AgentWorker  │
        │ pgBackRest   │  │ BYPASSRLS    │  │ → hermes SSE │
        └──────────────┘  └──────────────┘  └──────────────┘
```

**불변식(L4 §1.2, day-1 강제):** ① Postgres=SoT, Centrifugo=전송계층(DB 아님) · ② 쓰기경로 단일화(클라는 Centrifugo로 직접 publish 금지, 모두 REST→PG commit→outbox→relay) · ③ 순서 SoT=`message.seq` · ④ 에이전트=사람과 동일 `member` · ⑤ commit↔publish 무손실(transactional outbox).

**dev → prod 델타(코드 변경 0, config/인프라만 — L4 §1.4):**

| 항목 | dev(`infra/`) | prod(`infra/prod/`) |
|---|---|---|
| TLS/도메인 | 없음(localhost) | **Caddy 자동 HTTPS** + api/rt 서브도메인 |
| Centrifugo 엔진 | Memory | **Redis 엔진**(`engine.type: redis`, presence/recovery 안정) |
| relay/worker | `swift run` 수동(터미널) | **compose 서비스로 승격**(restart 정책) |
| 시크릿 | `.env` 평문(dev-insecure) | **SOPS+age 암호화**(메모리 복호화, 평문 디스크 미접촉) |
| 백업 | 없음 | **pgBackRest 풀+WAL PITR** |
| 포트 노출 | 5432/8000/8080 호스트 노출 | **443만 노출**, 나머지 compose 내부 |

> Centrifugo Memory→Redis 전환은 **발행/구독 코드 불변**(검증됨, L4 §4.3). subscribe proxy 콜백 URL(`http://api:8080/v1/centrifugo/subscribe`)은 compose 내부 네트워크로 유지(외부 비노출).

---

## 2. 사전 요구 (운영 호스트)

| 요구 | 비고 |
|---|---|
| VPS 1대 | 전용 vCPU 4코어/16GB급. ~$30~50/월 `(추정, 주문 시점 단가 재확인)`. 10인×수팀 v0 충분(L4 §0.2). |
| 공인 도메인 | `api.<domain>` / `rt.<domain>` A/AAAA 레코드를 VPS IP로. Caddy ACME가 인증서 자동 발급(80/443 인바운드 허용 필요). |
| Docker + Compose v2 | `docker compose version`. |
| age 키 | `age-keygen`으로 생성. 공개키는 `.sops.yaml`에, 개인키는 **호스트에만**(또는 KMS). |
| pgBackRest | 백업 repo(로컬 디스크 또는 S3 호환 오브젝트스토리지). |
| Swift 6.2 (빌드 머신) | relay/worker/api 이미지 빌드용. CI에서 빌드 후 레지스트리 푸시 권장. |

**방화벽:** 인바운드 **80(ACME)·443만 허용**. 5432/8000/8080은 호스트에 노출 금지(compose 내부 네트워크). SSH는 키 인증 + 비표준 포트/IP 화이트리스트 `(추정 권장)`.

---

## 3. 시크릿 관리 (SOPS + age) — MOMO-006

> 목표: 암호화한 시크릿을 **git에 버전관리**하면서, 배포 시 **메모리에서만 복호화**(평문이 디스크에 닿지 않음). dev의 `change-me-*`/`dev-insecure-*`를 운영에서 전부 교체.
> 절차 정본과 skeleton 파일 목록은 [`docs/SECRETS_BACKUP_RUNBOOK.md`](SECRETS_BACKUP_RUNBOOK.md)다.

### 3.1 키 생성 & 규칙
```sh
age-keygen -o ~/.config/sops/age/keys.txt          # 개인키(호스트 보관, 절대 커밋 금지)
# 출력된 public key(age1...)를 .sops.yaml 의 recipient 로 등록
```

`.sops.yaml`(리포 루트, `.sops.yaml.example`에서 실제 public recipient로 교체):
```yaml
creation_rules:
  - path_regex: ^infra/prod/.*\.sops\.(env|yaml|json)$
    age: "age1...<public key>"
```

### 3.2 암호화/복호화
```sh
sops --encrypt --input-type dotenv --output-type dotenv \
  infra/prod/secrets.env > infra/prod/secrets.sops.env       # 커밋 가능(값 암호화됨)
rm -f infra/prod/secrets.env                                 # 평문 삭제(커밋 금지)

# 배포 시 프로세스 환경으로만 복호화 → compose 에 주입(평문 파일 생성 금지):
SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt \
  sops exec-env infra/prod/secrets.sops.env \
  'docker compose -f infra/prod/docker-compose.prod.yml up -d'
```
> `sops exec-env`는 복호화 값을 **프로세스 환경**으로만 노출(디스크 미접촉). CI 배포 시 age 개인키는 GitHub Actions secret(또는 OIDC→KMS)로 주입. 환경변수는 동일 사용자/root의 프로세스 관찰 표면에 노출될 수 있으므로 운영 호스트 권한도 함께 제한한다.

### 3.3 운영 시크릿 인벤토리 (dev `.env.example` + 운영 추가분)
| 키 | 생성 | 비고 |
|---|---|---|
| `POSTGRES_PASSWORD` | `openssl rand -hex 32` | dev `change-me-postgres` 교체. |
| `CENT_TOKEN_HMAC` | `openssl rand -hex 32` | client connection/subscription JWT 서명. |
| `CENT_API_KEY` | `openssl rand -hex 32` | server publish 인증(`X-API-Key`, relay/worker만). |
| `JWT_HMAC` | `openssl rand -hex 32` | App access/refresh 토큰 HS256. |
| `HERMES_API_KEY` | (hermes 발급) | 김인턴 게이트웨이 Bearer. |
| `RELAY_DATABASE_URL` | — | relay/worker 전용 **BYPASSRLS `momo_relay`** 접속(§5.2). |
| `REDIS_URL` | (내부) | `redis://redis:6379`(compose 내부, 비밀번호 설정 권장). |
| `pgbackrest` repo cipher | `openssl rand -base64 48` | 백업 암호화 키(별도 보관). |

> **규칙:** 평문 `.env`는 prod 호스트/리포에 절대 남기지 않는다. dev-insecure 기본값으로 부팅은 되지만 **운영에선 전부 교체 필수**(L4 §10.1 RLS/시크릿 리스크).

---

## 4. docker-compose.prod + Caddy(자동 TLS) — MOMO-005

> dev `infra/docker-compose.yml`(postgres + centrifugo 2서비스)를 prod에서 **caddy + redis + api + relay + worker 추가**로 확장. `name: momo`, 볼륨 `momo-pgdata` 유지.

### 4.1 서비스 구성(요지)
- **caddy**: 443 노출, `Caddyfile` 마운트, ACME 자동 인증서, `caddy-data` 볼륨(인증서 영속).
- **postgres**: `postgres:18`, healthcheck `pg_isready`, pgdata 볼륨, **포트 비노출**(내부만).
- **redis**: `redis:7`(또는 valkey), Centrifugo 엔진 백엔드, `redis-data` 볼륨.
- **centrifugo**: `centrifugo/centrifugo:v6`, `centrifugo.prod.json`(Redis 엔진) 마운트, **포트 비노출**(caddy가 rt 도메인으로 프록시).
- **api**: MomoServer 이미지, `depends_on: postgres(healthy)`, `PORT=8080`(내부). subscribe proxy 대상.
- **relay**: OutboxRelay 이미지, `RELAY_DATABASE_URL`(BYPASSRLS), `CENT_API_URL=http://centrifugo:8000/api`.
- **worker**: AgentWorker 이미지, `HERMES_BASE_URL`/`HERMES_API_KEY`, `depends_on: postgres(healthy)`.

모든 서비스 `restart: unless-stopped`. relay/worker는 dev compose 주석(L4 §1.1 / `infra/docker-compose.yml` line 69~93)에 이미 골격 예시가 있음 → 그대로 승격.

### 4.2 Caddyfile (요지)
```caddyfile
api.{$DOMAIN} {
    encode gzip zstd
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "no-referrer"
    }
    reverse_proxy api:8080
}

rt.{$DOMAIN} {
    # Centrifugo WebSocket/SSE — 업그레이드 헤더 전달은 Caddy reverse_proxy 기본 처리
    reverse_proxy centrifugo:8000
}
```
> ⚠️ **subscribe proxy 콜백(`http://api:8080/v1/centrifugo/subscribe`)은 외부로 라우팅하지 않는다** — compose 내부 네트워크에서만 동작(centrifugo → api). 외부에 노출되는 건 api/rt 두 서브도메인뿐. `PORT` 변경 시 `centrifugo.prod.json`의 proxy URL과 Caddyfile을 함께 맞춘다.

### 4.3 centrifugo.prod.json (Redis 엔진 전환)
dev `infra/centrifugo.json`의 namespace(ch/dm/agent/user) 스펙은 **그대로 유지**(L4 §4.2)하고 엔진만 추가:
```json
{
  "engine": { "type": "redis", "redis": { "address": "redis://redis:6379" } },
  "channel": { "namespaces": [ /* dev와 동일: ch/dm/agent/user */ ],
               "proxy": { "subscribe": { "endpoint": "http://api:8080/v1/centrifugo/subscribe" } } },
  "client": { "subscription_token": { "enabled": true } }
}
```
> 운영 compose는 `CENT_TOKEN_HMAC`/`CENT_API_KEY`를 각각
> `CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY`/`CENTRIFUGO_HTTP_API_KEY`로 주입해야 한다.
> Centrifugo v6는 일반 JSON 문자열의 `"${...}"` 플레이스홀더를 설정값으로 자동 치환하지 않는다.
> 제약 유지: `history_meta_ttl` > `history_ttl`, namespace 상속 없음(각 명시). Redis 전환으로 presence/recovery가 재시작·다중 인스턴스에서 안정. 진짜 복구는 여전히 REST `?after=<seq>` backfill(Postgres SoT, L4 §4.3).

---

## 5. 데이터베이스 — 마이그레이션 · RLS 역할 · 멀티테넌시

### 5.1 마이그레이션 (멱등, L4 §8.7)
`scripts/migrate.sh`가 `server/Migrations/*.sql`을 번호순 적용 + `schema_migrations`로 이력 추적(재실행 SKIP, `--single-transaction` 원자 적용).
```sh
export DATABASE_URL=postgres://momo:<pw>@localhost:5432/momo   # 운영은 SOPS로 주입
make migrate                                                   # 001_init → 002_seed → 003_onboarding
```
- 현재: `001_init.sql`(정본 스키마 + outbox/cost/APNs 보강), `002_seed.sql`(데모 시드).
- 신규: `003_onboarding.sql`(§6 invite_code + redemption audit). **`schema_v0.sql` 정본은 수정/이동 금지** — 확장은 신규 마이그레이션 + RLS DO-block ARRAY에 신규 테이블 등록(아래). `platform_admin`은 MOMO-013 후속 범위다.

### 5.2 DB 역할 분리 (RLS 격리의 운영 기반)
| 역할 | 권한 | 용도 |
|---|---|---|
| `momo` (app) | 일반(RLS 적용) | api(MomoServer) — 트랜잭션마다 `SET LOCAL app.workspace_id` 필수. |
| `momo_relay` | **LOGIN BYPASSRLS** | relay/worker — 전 테넌트 outbox 폴링(background consumer). **읽기/relay 경로 한정**. |
| `momo_admin` | **BYPASSRLS(읽기)** | 플랫폼 관리자 전역 조회(§6.3). **쓰기 경로엔 BYPASSRLS 금지.** |

```sql
-- 운영 부트스트랩(1회). 비밀번호는 SOPS 시크릿.
CREATE ROLE momo_relay LOGIN BYPASSRLS PASSWORD '...';
CREATE ROLE momo_admin LOGIN BYPASSRLS PASSWORD '...';   -- 읽기 전용 권한만 GRANT
```
> `app.workspace_id` 누락 시 RLS가 행을 **미노출**(fail-safe). 풀러는 transaction mode + 트랜잭션마다 `SET LOCAL` 강제. BYPASSRLS는 relay/admin-read에만(L4 §10.1).

### 5.3 멀티테넌시 모델 (L4 §1.3)
`workspace → channel → membership(member)` 3계층. 모든 테넌트 행에 `workspace_id` + RLS `FORCE`(schema_v0.sql line 385~400 DO-block). v0 단일 워크스페이스 → M2에서 N워크스페이스(10명=1팀, 3+팀). 격리는 `SET LOCAL app.workspace_id` + RLS 정책. 채널 네이밍은 `<namespace>:ws<workspaceUUID>.<resourceUUID>`(L4 §4.1)로 day-1 멀티테넌트.

---

## 6. 멀티팀 온보딩 운영 (M2 — EP-TENANCY / EP-ADMIN)

> 워크스페이스 스핀업 + **스핀업별 고유 초대코드 → 자가가입** + **플랫폼 관리자 전체 추적.** schema_v0.sql 위에 `003_onboarding.sql`로 확장(정본 미수정).

### 6.1 `003_onboarding.sql` (MOMO-010 — 신규 마이그레이션)
- `invite_code{ id uuidv7, workspace_id FK, code_hash, code_preview, role, max_uses, used_count, expires_at, revoked_at, revoked_by, created_by }` — raw code는 저장하지 않고 hash 저장, 만료 + 사용횟수 한정 + revoke.
- `invite_code_redemption{ id, workspace_id, invite_code_id, member_id, email, ip_addr, user_agent, redeemed_at }` — 성공 redemption audit trail.
- **RLS 등록:** `invite_code`/`invite_code_redemption`을 schema_v0.sql의 RLS DO-block ARRAY 패턴(line 388~399)과 동일하게 `ENABLE`/`FORCE ROW LEVEL SECURITY` + `ws_isolation` 정책에 등록(신규 마이그레이션 내 별도 DO-block). `platform_admin`은 MOMO-013에서 BYPASSRLS 읽기 전용 경로로 분리한다.

### 6.2 온보딩 운영 플로우 (REST — MOMO-011/012)
```
[운영] 워크스페이스 스핀업
  POST /v1/workspaces        → workspace + 초기 owner(member/membership) + 고유 invite_code 1개 자동 발급
                               (트랜잭션마다 SET LOCAL app.workspace_id 후 INSERT)
[운영] 추가 초대코드 발급
  POST /v1/invites           → owner/admin이 role/max_uses/expires_at 지정해 코드 생성
[멤버] 자가가입
  POST /v1/join {code}       → 코드 검증(만료/사용횟수/revoke) → app.workspace_id=코드의 workspace_id 컨텍스트
                               → member/membership 생성 → used_count++ → audit_log(actor/subject/via_token)
```
- **운영 시나리오(M2 exit):** 3개+ 팀(각 10인)을 각자 고유 초대코드로 자가가입 → 팀 간 데이터 누출 0 재확인(RLS). 가입 사건은 전부 `audit_log` 기록.
- **초대코드 운영 수칙:** 고엔트로피 랜덤 + 만료(예: 7~30일) + max_uses(팀 규모) + 유출 시 즉시 `revoked_at` 설정. 코드는 시크릿 취급(로그 평문 금지).

### 6.3 플랫폼 관리자 전체 추적 (MOMO-013 — BYPASSRLS 읽기)
```
GET /v1/platform/workspaces   → 전 테넌트 워크스페이스 전수(팀/멤버 수/초대코드 사용현황)
GET /v1/platform/members      → 전 테넌트 멤버 전수
```
- `momo_admin`(BYPASSRLS **읽기**) 역할로 전역 조회 뷰/엔드포인트. **쓰기 경로엔 BYPASSRLS 금지.**
- 일반 테넌트 토큰으로는 `/v1/platform/*` 접근 불가(권한 분리 — platform_admin 검증).
- 운영 용도: 3개+ 팀(10인=1팀) 전수 추적, 초대코드 소진/만료 모니터링, 비정상 가입 탐지.

---

## 7. 백업 / 복원 (pgBackRest PITR) — MOMO-006

> L4 §8.7: 일일 `pg_dump` + WAL 아카이빙이 최소선. 운영은 **pgBackRest(주간 풀 + 연속 WAL 아카이빙 → PITR)** 로 승격.
> skeleton 파일은 `infra/prod/pgbackrest.conf.example`, `infra/prod/postgresql.pgbackrest.conf.example`, `infra/prod/pgbackrest-cron.example`이며, 상세 절차는 [`docs/SECRETS_BACKUP_RUNBOOK.md`](SECRETS_BACKUP_RUNBOOK.md)다.
> **운영 계약:** 복원 리허설 evidence가 없으면 백업은 검증된 것으로 보지 않는다. Repo-local `backup` gate는 dump/restore evidence를 만들고, 실제 pgBackRest PITR는 public host에서 별도 evidence가 필요하다.

### 7.1 구성(요지)
- `archive_command = pgbackrest --stanza=momo archive-push %p` (postgresql.conf), `archive_mode = on`, `wal_level = replica`.
- `pgbackrest.conf`: stanza `momo`, `pg1-path`는 `SHOW data_directory`로 확인, repo(로컬 디스크 또는 S3 호환), **repo cipher(AES-256)** + retention(full=4주, diff/incr).
- 스케줄: **주간 full + 일간 diff + 연속 WAL**(cron). 백업 repo는 호스트와 분리된 오브젝트스토리지 권장(월 $1 미만~수달러 `(추정)`).

### 7.2 검증(M1 exit — 복원 evidence 필수)

내부 테스트 호스팅 전 local gate:

```sh
scripts/local_gate.sh --profile backup
scripts/local_gate.sh --profile host-runtime
```

`backup` profile이 자동으로 닫는 범위: 임시 PostgreSQL 18 source DB marker write, `pg_dump -Fc`, 별도 restore DB `pg_restore`, marker fingerprint equality, dump sha256, markdown/json evidence. 이 범위는 운영 secret이나 primary data directory를 사용하지 않는다.

Host pgBackRest rehearsal:

```sh
pgbackrest --stanza=momo --type=full backup        # 풀 백업
pgbackrest --stanza=momo check                     # 아카이빙/repo 점검
# PITR 복원 리허설(별도 인스턴스/디렉터리에서):
pgbackrest --stanza=momo --type=time \
  --target="2026-06-24 12:00:00+00" restore
```
> **M1 종료 기준 = repo-local restore evidence + host pgBackRest 백업 1회 + PITR 복원 1회 검증.** 복원 리허설 없는 백업은 "검증 안 됨"으로 간주. 실제 stanza/check/full backup/WAL/PITR는 `runtime-unverified(public host)`로 남기고, public host에서 별도 evidence를 첨부해야 닫힌다.

---

## 8. 모니터링 / 관측성 (경량) — MOMO-007

> L4 §8.8: 구조화 로그(run_id/workspace_id 상관) + `audit_log` + 핵심 메트릭. v0는 경량(무거운 APM 불필요).

### 8.0 local/staging smoke gate

실제 VPS 시크릿이 없어도 PR에서 아래 gate를 먼저 통과시킨다.

```sh
scripts/verify_staging_smoke.sh
scripts/verify_internal_hosting_smoke.sh
scripts/verify_backup_restore_rehearsal.sh
scripts/local_gate.sh --profile staging-smoke
scripts/local_gate.sh --profile backup
scripts/local_gate.sh --profile host-runtime
```

이 gate가 자동으로 닫는 범위:

- `infra/prod/docker-compose.prod.yml`이 `.env.example`만으로 `docker compose config --quiet`를 통과한다.
- Caddyfile이 `API_DOMAIN`/`REALTIME_DOMAIN`을 받아 api와 Centrifugo에 내부 reverse proxy한다.
- `infra/prod/centrifugo.prod.json`이 Redis engine, namespace 4종, subscribe proxy, history ttl 계약을 만족한다.
- prod plaintext secret/env/age key 파일이 tracked되지 않고, example 파일은 placeholder만 담는다.
- SOPS/age와 pgBackRest PITR rehearsal checklist/evidence template이 존재한다.
- MOMO-216 internal smoke overlay가 prod compose 위에서 렌더링되고, local image fallback tags, explicit image-based `migrate` job, MomoServer `/health` route, relay/worker env/enablement, mock Hermes boundary를 static 검증한다.
- MOMO-220 host-runtime gate가 local api/relay/worker/migrate/mock-Hermes images를 빌드하고, prod+internal-smoke stack boot, migration idempotency, REST message, relay publish, mock agent roundtrip을 실제 검증한다.
- MOMO-222 backup gate가 임시 PostgreSQL source→dump→별도 restore→marker checksum evidence를 markdown/json으로 생성한다. `host-runtime` profile도 이 verifier를 포함한다.

`runtime-unverified(public host)`: 실제 `https://api.<domain>/health`, public DNS, TLS 인증서 발급/갱신,
real registry image pull/run, SOPS 복호화, pgBackRest stanza/check/full backup/WAL archive/time-target PITR restore rehearsal, 외부 hermes staging 연결은 public host-runtime에서만 닫는다.

### 8.0.1 internal single-node hosting smoke (MOMO-216/MOMO-220)

내부 테스트용 single-node smoke는 prod deploy 방향을 바꾸지 않는 override다.

```sh
docker compose --env-file infra/prod/internal-smoke.env.example \
  -f infra/prod/docker-compose.prod.yml \
  -f infra/prod/docker-compose.internal-smoke.yml config
scripts/verify_internal_hosting_smoke.sh
scripts/verify_internal_host_runtime.sh
```

- Production/staging host: api/relay/worker는 source checkout 없이 pinned registry image를 pull한다.
- Local internal smoke: 아직 publish pipeline 전이라도 verifier가 `momo-api:internal-smoke-*` 같은 run-specific local image tag를 빌드해 사용할 수 있다.
- Migration: app container boot side effect가 아니라 operator step 또는 image-based smoke `migrate` job으로 실행한다.
- Runtime smoke: `scripts/verify_internal_host_runtime.sh`는 source checkout bind mount 없이 `/health`, REST login/message send, OutboxRelay→Centrifugo publish, mock Hermes `@김인턴` roundtrip evidence/log path를 출력한다.
- Caddy/TLS: Caddy가 유일한 public edge다. Local smoke는 `localhost`/`rt.localhost`와 `18080/18443` config를 확인하지만 public ACME/DNS는 검증하지 않는다.
- Backup/restore: repo-local dump/restore 리허설은 `backup` profile evidence로 닫고, 실제 pgBackRest stanza/check/full backup/WAL/time-target PITR restore rehearsal은 `runtime-unverified(public host)`다.

### 8.1 헬스체크 / 로그
- `GET https://api.<domain>/health` 200 = api green. Caddy/Centrifugo/postgres healthcheck도 green.
- 구조화 로그(JSON): 모든 로그에 `run_id`/`workspace_id` 상관키. `docker compose logs -f` + 로그 드라이버(json-file rotate 또는 외부 수집).

### 8.2 핵심 메트릭 (게이트/운영 신호)
| 메트릭 | 의미 | 경보 임계 `(추정)` |
|---|---|---|
| **outbox lag** | pending outbox 행의 최고 연령 | > 5s 지속 시 relay 점검 |
| **예산 트립율** | budget_window 서킷브레이커 트립 빈도 | 급증 시 가격/한도 점검 |
| **APNs 실패율** | 410/400/429 비율 | 429 = 토큰 갱신 액터 점검(20~60분), 410/400 = invalidated_at |
| **에이전트 턴 지연** | 멘션→응답 p90 | hermes 지연/타임아웃 점검 |
| **publish 지연** | commit→Centrifugo publish | relay/centrifugo 점검 |

> APNs 운영 상수(L4 §8.3, 검증됨): provider JWT **ES256, 1h 초과 403, 20분 1회 초과 갱신 시 429** → 프로세스당 토큰 1개 캐시 + 20~60분 갱신 액터(single-signer). 410 Unregistered/400 BadDeviceToken → `push_token.invalidated_at`.

---

## 9. 배포 / 롤백 절차 (staging → prod)

### 9.1 staging 최초 기동 (M1)
```sh
# 0) 로컬/PR gate: 실제 VPS 시크릿 없이 config, runbook, restore evidence를 먼저 검증
scripts/local_gate.sh --profile staging-smoke
scripts/local_gate.sh --profile backup
scripts/local_gate.sh --profile host-runtime

# 1) DNS: api.staging.<domain> / rt.staging.<domain> → VPS IP (A/AAAA)
# 2) age 키 + SOPS 시크릿 준비(§3), 80/443 인바운드 허용
# 3) 이미지 빌드/푸시(CI) 또는 호스트에서 build
# 4) 시크릿 메모리 복호화 + 기동
SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt \
  sops exec-env infra/prod/secrets.sops.env \
  'docker compose -f infra/prod/docker-compose.prod.yml up -d'
# 5) 마이그레이션
sops exec-env infra/prod/secrets.sops.env 'make migrate'
# 6) 검증: https://api.staging.<domain>/health 200 + TLS 정상 + RLS 격리 + outbox 왕복
```

### 9.2 prod 승격
- staging에서 **G-0 런타임 e2e PASS + 백업/복원 검증** 후 prod 도메인으로 동일 절차.
- staging/prod는 **별도 compose 파일/도메인/시크릿/DB**로 분리(데이터 격리).

### 9.3 롤백
- **앱:** 이전 이미지 태그로 `docker compose ... up -d`(immutable 이미지 태그 사용 권장).
- **DB:** 마이그레이션은 forward-only 원칙 → 파괴적 변경 전 백업 필수. 데이터 사고 시 §7 PITR로 시점 복원.
- **시크릿:** 유출 시 즉시 재발급(`openssl rand`) + SOPS 재암호화 + 재배포 + 영향 토큰(JWT/CENT) 회전.

### 9.4 RUN.md 갱신 (MOMO-007 DoD)
위 staging 기동/롤백/시크릿/백업 절차를 `docs/RUN.md`에 "운영 배포" 섹션으로 추가(로컬↔운영 단일 참조).

---

## 10. 운영 보안 / 리스크 체크리스트

- [ ] 인바운드 443(+80 ACME)만 허용, 5432/8000/8080 비노출(compose 내부).
- [ ] dev-insecure/`change-me-*` 시크릿 **전부 교체**(SOPS 관리), 평문 `.env` 호스트/리포 미존재.
- [ ] `scripts/local_gate.sh --profile staging-smoke` PASS 후 실제 host 기동.
- [ ] `momo_relay`/`momo_admin` BYPASSRLS는 **읽기/relay 경로 한정**, app 역할은 `SET LOCAL app.workspace_id` 강제.
- [ ] 워크스페이스 간 RLS 격리 런타임 검증(A 컨텍스트에서 B 행 조회 불가).
- [ ] 초대코드 = 시크릿 취급(만료/max_uses/revoke), 로그 평문 금지.
- [ ] pgBackRest 백업 + **PITR 복원 1회 검증**(리허설).
- [ ] HSTS/보안 헤더(Caddyfile), TLS 인증서 자동 갱신 동작 확인.
- [ ] (법무, **법률 자문 아님**) 한국 부가통신 신고 면제 여부(자본금 1억원 이하, 전기통신사업법 시행령 §30) 법인화 시 재확인 · 개인정보처리방침 라이브 · hermes LLM 제3자 전송 고지(`legal/agent-disclosure.md`).

---

## 11. v0 → 수평확장 경로 (코드 변경 0, config/인프라만 — L4 §1.4)

| 병목 | v0/prod | 확장 레버 |
|---|---|---|
| API | 1 인스턴스 | stateless → Caddy 뒤 N 다중화(LB) |
| Centrifugo | Redis 엔진 1 | Redis 클러스터 / Centrifugo 다중 노드(엔진 공유) |
| 순서 직렬화 | `channel_seq` 행락(in-tx) | 채널별 유지(전역 아님), 핫채널 시 HLC 정렬 모드 |
| 에이전트 턴락 | agent_run 부분유니크 | `pg_advisory_lock(64bit)` 승격 |
| DB | 단일 | read replica → workspace 파티션/샤딩(workspace_id 상시 보유) |
| Outbox relay | 자체 relay | Centrifugo native PG outbox consumer로 무전환(컬럼 superset 호환, 검증됨) |

> v0 단일 인스턴스 SPOF는 10인×수팀 수용 가능(L4 §10.1). 전파 확대 전 HA 승격.

---

## 12. 출처 (2026 기준 1차/교차확인)
- 시스템 토폴로지·불변식·확장 경로·횡단 관심사: `research/07-deepdive/04-self-build-l4-spec.md` §1.1/§1.2/§1.4/§8 (정본).
- Centrifugo Redis 엔진(코드 불변 전환)·native PG outbox consumer·history/recovery: centrifugal.dev/docs (검증됨).
- PostgreSQL 18 uuidv7 / RLS FORCE / `UPDATE...RETURNING` 행락 직렬화: postgresql.org docs (검증됨).
- pgBackRest PITR(full+WAL, repo cipher): pgbackrest.org (검증됨).
- SOPS + age(메모리 복호화 exec-env): github.com/getsops/sops · github.com/FiloSottile/age (검증됨).
- Caddy 자동 HTTPS(ACME): caddyserver.com/docs (검증됨).
- APNs 운영 상수(ES256/1h/429/410·400): Apple Developer docs (검증됨).
- 한국 부가통신 신고 면제(자본금 1억원 이하, 시행령 §30): **법률 자문 아님 — 외부 변호사 1회 검토**(`docs/legal/00-prelaunch-admin-legal-checklist.md §8`).
</content>
