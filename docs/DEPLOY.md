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
  - ✅ `scripts/verify_staging_smoke.sh` + `scripts/local_gate.sh --profile staging-smoke` — VPS 시크릿 없는 prod compose/Caddy/Centrifugo/secrets/pgBackRest/public preflight evidence local gate (MOMO-007/MOMO-229)
  - ✅ `infra/prod/install.sh` + `infra/prod/upgrade.sh` + `scripts/verify_prod_install_upgrade.sh` — pinned digest 설치, forward-only upgrade/app rollback, 정적 인자 매트릭스 (MOMO-406)
  - ✅ `infra/prod/docker-compose.internal-smoke.yml` + `infra/prod/internal-smoke.env.example` + `scripts/verify_internal_hosting_smoke.sh` — 내부 테스트용 single-node hosting smoke gate (MOMO-216)
  - ✅ `infra/prod/docker/` + `scripts/verify_internal_host_runtime.sh` + `scripts/local_gate.sh --profile host-runtime` — local image 기반 prod+internal-smoke boot/health/migrate/message/relay/mock-agent runtime gate (MOMO-220)
  - ✅ `scripts/verify_backup_restore_rehearsal.sh` + `scripts/local_gate.sh --profile backup` — 임시 PostgreSQL source→dump→별도 restore→marker checksum evidence gate (MOMO-222)
  - ✅ `scripts/verify_external_agent_provider.sh` + `scripts/local_gate.sh --profile external-agent-provider` — credentials가 있는 환경에서만 real Hermes/Kim Intern SSE + local momo `@김인턴` 1왕복을 검증하는 opt-in gate (MOMO-230)
  - ✅ `docs/adr/0004-codex-oauth-hermes-provider-boundary.md` — Codex OAuth token은 Hermes/Kim Intern provider-owned이고 momo app/API/DB/local gate가 직접 저장하지 않는 credential boundary (MOMO-234)
  - ✅ `docs/AWS_INTERNAL_ALPHA.md` + `infra/prod/aws-internal-alpha.env.example` + `scripts/aws_internal_alpha_preflight.sh` — AWS 1주일 internal alpha topology/cost/security-group/backup/deploy/rollback preflight (MOMO-233)
  - ✅ `server/Migrations/003_onboarding.sql` — invite_code + redemption audit (MOMO-010)
  - ✅ `docs/RUN.md`에 staging smoke gate와 host-runtime 기동/롤백/시크릿/백업 절차 추가 (MOMO-007)

---

## 0.1 5분 설치 (MOMO-406, ADR-0121 D1-A)

대상은 **Ubuntu LTS 단일 노드**에서 터미널을 사용할 수 있는 운영자 1명이다. 설치
스크립트는 비대화형이며 같은 env로 다시 실행해도 안전하다. 아래 5분은 이미지가 이미
registry에 있고 DNS가 전파됐다는 전제의 **운영자 작업 시간**이다. 이미지 다운로드,
DNS 전파, ACME 인증서 발급 시간은 포함하지 않는다.

### 전제

- 공인 DNS의 `API_DOMAIN`, `REALTIME_DOMAIN`이 이 호스트를 가리킨다. 웹을 함께
  제공할 때만 별도 `APP_DOMAIN`을 설정한다. unset/빈 값이면 기존
  `momo-app-domain-unset.localhost` sentinel과 2-site 동작이 유지된다.
- Docker Engine + Compose v2, `curl`, `getent`(또는 `dig`), 80/443 인바운드,
  여유 디스크 10 GiB 이상이 준비돼 있다.
- `infra/prod/secrets.env.example`을 바탕으로 SOPS/age 또는 권한 제한 host-local env를
  만들었다. 다섯 momo 이미지(`api`, `relay`, `worker`, `migrate`, `web`)는 각각
  `ghcr.io/...@sha256:<64 hex>` 전체 digest ref여야 한다. `latest`나 tag-only 입력은
  install/upgrade가 거부한다.
- pgBackRest stanza/check/full backup/WAL/PITR 의무와 외부 Hermes HTTPS 자격증명을
  env에 선언했다. 값은 로그나 PR evidence에 붙이지 않는다.

SOPS를 쓰는 권장 한 줄 설치:

```sh
sops exec-env /secure/momo/prod.sops.env \
  'infra/prod/install.sh --from-env --mode prod --state-dir /var/lib/momo --evidence-dir /var/lib/momo/evidence'
```

tmpfs/권한 0600 host-local env를 쓰는 동등 경로:

```sh
infra/prod/install.sh --env-file /run/momo/prod.env --mode prod \
  --state-dir /var/lib/momo --evidence-dir /var/lib/momo/evidence
```

스크립트는 `prod_env_preflight.sh` → pinned digest 검사 → `docker compose config
--quiet` → pull → PostgreSQL/Redis/Centrifugo → one-shot `migrate`와 `web-init` →
API/relay/worker/Caddy → `https://API_DOMAIN/health` 순으로 실행한다. 실패하면 `compose
ps`와 확인할 서비스만 안내하며 시크릿 값은 출력하지 않는다. 성공한 이미지 세트는
`/var/lib/momo/deploy-state.env`에 mode 0600으로 기록한다.

### 설치 완료의 일부: owner 자격증명 인수 (필수 — URL 공유 전)

> **경고 (review #429 H1, MOMO-408 반영):** prod 모드 마이그레이션은 시드 owner
> (`demo@momo.local`)의 공개된 결정론적 비밀번호(`dev-password`)를 무효화한다. 아래 인수
> UPDATE 전에는 해당 계정 로그인이 HTTP 401로 fail-closed된다. 그래도 install.sh의
> "install complete"는 운영자 소유 email/password로 인수하고 실제 로그인을 확인해야 완료다 —
> 인수 전에는 서버 URL을 누구와도 공유하지 마라.

마이그레이션은 첫 bootstrap workspace와 owner 행을 멱등 생성한다. 초기 owner 자격증명은
공개 설치 로그가 아니라 운영자의 SOPS/host-only provisioning 경계에서 설정해야 한다.
암호화된 env에 `MOMO_INITIAL_OWNER_EMAIL`과 `MOMO_INITIAL_OWNER_PASSWORD`를 추가한 뒤,
호스트에서 아래 one-shot 인수 절차를 실행한다. `psql \getenv`를 사용하므로 비밀번호 값은
명령 인자·stdout에 나타나지 않는다.

```sh
sops exec-env /secure/momo/prod.sops.env \
  'docker compose -f infra/prod/docker-compose.prod.yml exec -T \
   -e MOMO_INITIAL_OWNER_EMAIL -e MOMO_INITIAL_OWNER_PASSWORD postgres \
   psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
\getenv owner_email MOMO_INITIAL_OWNER_EMAIL
\getenv owner_password MOMO_INITIAL_OWNER_PASSWORD
BEGIN;
SET LOCAL app.workspace_id = '00000000-0000-7000-8000-000000000001';
UPDATE human
   SET email = :'owner_email', email_verified = true,
       password_hash = momo_password_hash(:'owner_password')
 WHERE member_id = '00000000-0000-7000-8000-000000000101';
COMMIT;
SQL
```

그 자격증명으로 macOS 앱의 **설치된 self-hosted 서버 연결**에서
`https://API_DOMAIN`에 로그인한 뒤, 워크스페이스 설정 → 멤버 → 초대 링크 만들기를
선택한다. 원본 초대 코드는 한 번만 표시되는 bearer secret이므로 공개 로그·shell
history·PR evidence에 복사하지 않는다. 이 시점이 "첫 워크스페이스/초대" 완료다.

> 현재 v1 installer는 사람 계정 비밀번호나 원본 초대 코드를 인자로 받거나 출력하지
> 않는다. 초기 owner credential provisioning은 호스트 DB 관리자 책임이며, 가입자가
> 사용할 링크 초대의 기본 만료/역할/regenerate 서버 계약은 MOMO-407이 담당한다.

relay 등록은 ADR-0120 P-3/S-5의 후속 자리만 `install.sh` 끝에 주석으로 예약돼 있다.
등록 실패는 향후에도 설치 성공을 뒤집지 않으며, relay 없는 오프그리드 설치는 1급이다.

### 업그레이드와 롤백

실제 업그레이드는 먼저 성공한 백업 evidence가 필요하다. 새 SOPS env도 다섯 이미지 모두
새 digest를 가리켜야 한다.

```sh
sops exec-env /secure/momo/prod-next.sops.env \
  'infra/prod/upgrade.sh --from-env --mode prod --state-dir /var/lib/momo \
   --backup-evidence /var/lib/momo/evidence/backup-restore-evidence.json'
```

upgrade는 현재 이미지 세트를 `.previous`로 보존하고 새 digest pull → migrate →
web-init → api/relay/worker/Caddy 재기동 → health 순으로 진행한다. v1은 짧은 중단을 허용한다.
실패하면 이전 **앱 이미지** 3개와 web 자산 이미지를 자동 복구한다. DB migration은 전방 전용이라 절대
자동 역마이그레이션하지 않는다. 이전 앱이 새 스키마와 호환되지 않거나 자동 복구 후에도
health가 실패하면 바로 멈추고 운영자가 판단해야 한다.

성공 후 수동 app rollback이 필요할 때:

```sh
sops exec-env /secure/momo/prod-next.sops.env \
  'infra/prod/upgrade.sh --from-env --mode prod --state-dir /var/lib/momo \
   --rollback-only --rollback-state /var/lib/momo/deploy-state.env.previous'
```

변경 없이 입력·compose render·rollback 경로만 확인하려면 `install.sh` 또는
`upgrade.sh`에 `--dry-run`을 붙인다. 실제 DNS/TLS, registry pull/run, SOPS 복호화,
pgBackRest backup/PITR, 외부 Hermes 연결은 실제 호스트 evidence가 생기기 전까지
`runtime-unverified(public host)`다.

### 단일 노드 상한

v1 문서상 보수 상한은 **동시 사용자 수백 명(최대 500명 계획값)** 이다. 이는 SLA나
부하시험 PASS 수치가 아니다 — ADR-0121 D1-A의 경계("동시 수백 명")를 이 문서가 500으로
구체화한 계획값이다. 500명에 접근하거나
CPU/메모리/DB latency가 지속 상승하면 먼저 API/relay/worker를 수평 분리하고, 이후
PostgreSQL/Redis를 관리형 또는 별도 노드로 옮긴다. 실제 팀 트래픽 부하시험 전에는 이
수치를 검증된 처리량으로 표현하지 않는다.

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

### 1.1 LiveKit 셀프호스트 델타 (ADR-0122 V-2)

로컬 단일 노드 허들은 `infra/docker-compose.yml`의 `huddle` profile로만 LiveKit을
옵트인한다. 기본 stack과 e2e compose는 LiveKit을 상시 기동하지 않는다. 운영 승격 시에는
다음 인바운드 포트를 호스트 방화벽과 클라우드 security group 양쪽에서 명시적으로 연다.

| 포트 | 프로토콜 | 용도 |
|---|---|---|
| 7880 | TCP | signaling WebSocket/HTTP (`MOMO_LIVEKIT_URL`) |
| 7881 | TCP | WebRTC TCP fallback |
| 50000~50100 | UDP | v0 제한 media range |
| 3478 | UDP | 내장 TURN listener — 도메인/TLS 확보 후 활성화 |
| 5349 또는 443 | TCP/TLS | TURN/TLS relay — 도메인/TLS 확보 후 활성화 |

`infra/livekit.yaml`은 TURN을 기본 비활성으로 두고 아래 형태의 주석 예시만 제공한다.
공개 `turn.<domain>`과 유효한 TLS 인증서가 준비된 뒤 실제 값으로 승격하며, API key/secret은
SOPS 등 운영 secret source에서 주입하고 파일에 쓰지 않는다.

```yaml
turn:
  enabled: true
  domain: turn.example.com
  tls_port: 5349
  udp_port: 3478
```

직접 UDP가 차단되는 기업망에서는 relay 후보가 없으면 통화 연결이 실패하므로, public
배포 전에 TURN/TLS 경로를 필수 운영 게이트로 검증한다. 현재 TURN 도메인/TLS와 prod
compose 승격은 `runtime-unverified(public host)`이며 MOMO-470의 로컬 수락 범위 밖이다.

---

## 2. 사전 요구 (운영 호스트)

| 요구 | 비고 |
|---|---|
| VPS 1대 | 전용 vCPU 4코어/16GB급. ~$30~50/월 `(추정, 주문 시점 단가 재확인)`. 10인×수팀 v0 충분(L4 §0.2). |
| 공인 도메인 | `api.<domain>` / `rt.<domain>` A/AAAA 레코드를 VPS IP로. Caddy ACME가 인증서 자동 발급(80/443 인바운드 허용 필요). 웹 클라이언트를 쓰면 `APP_DOMAIN`(예: `momo.<domain>`)도 추가 — optional, §4.4. |
| Docker + Compose v2 | `docker compose version`. |
| age 키 | `age-keygen`으로 생성. 공개키는 `.sops.yaml`에, 개인키는 **호스트에만**(또는 KMS). |
| pgBackRest | 백업 repo(로컬 디스크 또는 S3 호환 오브젝트스토리지). |
| Swift 6.2 (빌드 머신) | relay/worker/api 이미지 빌드용. CI에서 빌드 후 레지스트리 푸시 권장. |

**방화벽:** 인바운드 **80(ACME)·443만 허용**. 5432/8000/8080은 호스트에 노출 금지(compose 내부 네트워크). SSH는 키 인증 + 비표준 포트/IP 화이트리스트 `(추정 권장)`.

### 2.1 AWS internal alpha stack v0 (MOMO-233)

1주일 팀 테스트용 AWS host topology는 [`docs/AWS_INTERNAL_ALPHA.md`](AWS_INTERNAL_ALPHA.md)가 정본이다.
결정값은 **EC2 recommended single-node**: `t4g.large`, encrypted `gp3` data volume,
Caddy 80/443, API/OutboxRelay/AgentWorker/Centrifugo/Redis/Postgres를 image-based
prod compose로 실행, pgBackRest→S3 + daily EBS snapshot. Lightsail은 가장 빠른
throwaway 옵션으로만 문서화하고, 기본 추천은 보안그룹/IAM/EBS snapshot/restore fidelity가
좋은 EC2로 둔다.

정적 preflight:

```sh
scripts/aws_internal_alpha_preflight.sh \
  --env-file infra/prod/aws-internal-alpha.env.example \
  --mode recommended \
  --evidence-dir /tmp/momo-aws-alpha-preflight
```

이 preflight는 AWS 리소스를 만들지 않는다. topology/provider, DNS/TLS intent,
보안그룹 노출 intent, encrypted gp3 volume intent, pinned image/source-checkout-free
deploy, backup/restore/rollback acknowledgement만 검증한다. 실제 host 생성, DNS 전파,
Caddy ACME 인증서, registry pull, SOPS decrypt, pgBackRest backup, EBS snapshot,
PITR restore rehearsal은 `runtime-unverified(aws-host)`다.

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
| `MOMO_LIVEKIT_API_KEY` | `openssl rand -hex 16` | LiveKit token issuer/API key. LiveKit과 MomoServer에 동일 주입. |
| `MOMO_LIVEKIT_API_SECRET` | `openssl rand -hex 32` | LiveKit HS256 secret. App/Centrifugo JWT 키와 분리. |
| `MOMO_LIVEKIT_URL` | 배포 endpoint | 클라이언트가 접속할 public `wss://` LiveKit endpoint. |
| `AGENT_PROVIDER_MODE` | literal | staging/prod/internal-host는 반드시 `external-hermes`. |
| `AGENT_MODEL` | literal | 기본 `hermes-agent`; provider/model 라벨. |
| `HERMES_BASE_URL` | (hermes 발급) | OpenAI-compatible `/v1` base URL. staging/prod/internal-host는 `https://`만 허용. |
| `HERMES_API_KEY` | (hermes 발급) | 김인턴 게이트웨이 Bearer. |
| `RELAY_DATABASE_URL` | — | relay/worker 전용 **BYPASSRLS `momo_relay`** 접속(§5.2). |
| `REDIS_URL` | (내부) | `redis://redis:6379`(compose 내부, 비밀번호 설정 권장). |
| `pgbackrest` repo cipher | `openssl rand -base64 48` | 백업 암호화 키(별도 보관). |

> **규칙:** 평문 `.env`는 prod 호스트/리포에 절대 남기지 않는다. dev-insecure 기본값으로 부팅은 되지만 **운영에선 전부 교체 필수**(L4 §10.1 RLS/시크릿 리스크).

### 3.4 bootstrap preflight (MOMO-221)

운영 compose를 렌더링하거나 부팅하기 전에 반드시 preflight를 먼저 실행한다.

```sh
sops exec-env infra/prod/secrets.sops.env \
  'scripts/prod_env_preflight.sh --from-env --mode staging --evidence-dir /tmp/momo-public-preflight'

sops exec-env infra/prod/secrets.sops.env \
  'scripts/prod_env_preflight.sh --from-env --mode prod --evidence-dir /tmp/momo-public-preflight'
```

`staging`/`prod`/`internal-host` 모드는 다음 값을 fail-fast로 거부한다.

- `change-me-*`, `dev-insecure-*`, `__PLACEHOLDER__`, `example.com`, `localhost`, `mock-hermes`.
- Reserved/local public-routing domains such as `.test`, `.invalid`, `.local`,
  `.localhost`, `.example`, and `.internal`.
- `momo_app_dev_pw`/`momo_relay_dev_pw`/`momo_worker_dev_pw` 같은 local DB password.
- `momo-*:internal-smoke*`, `:latest`, source-checkout fallback image tag.
- 비밀번호 없는 `CENTRIFUGO_REDIS_ADDRESS`, non-HTTPS `HERMES_BASE_URL`.
- `AGENT_PROVIDER_MODE != external-hermes`.
- 누락된 SOPS/age 또는 host-local secret source, named DB/Redis volume, pgBackRest stanza/check/full backup/WAL/PITR required env.

Required env: `COMPOSE_PROJECT_NAME`, `MOMO_ENV`, `PUBLIC_BASE_URL`,
`API_DOMAIN`, `REALTIME_DOMAIN`, `CADDY_EMAIL`, `ACME_EMAIL`, `HTTP_PORT`, `HTTPS_PORT`, `MOMO_API_IMAGE`, `MOMO_RELAY_IMAGE`,
`MOMO_WORKER_IMAGE`, `MOMO_MIGRATE_IMAGE`, `MOMO_WEB_IMAGE`, `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`,
`DATABASE_URL`, `RELAY_DATABASE_URL`, `REDIS_PASSWORD`, `CENTRIFUGO_REDIS_ADDRESS`,
`CENT_TOKEN_HMAC`, `CENT_API_KEY`, `JWT_HMAC`, `AGENT_PROVIDER_MODE`, `AGENT_MODEL`,
`HERMES_BASE_URL`, `HERMES_API_KEY`, `SECRET_SOURCE`, `DB_VOLUME_NAME`,
`REDIS_VOLUME_NAME`, `PGBACKREST_STANZA`, `PGBACKREST_REPO1_PATH`,
`PGBACKREST_REPO1_CIPHER_PASS`, `PGBACKREST_WAL_ARCHIVE_REQUIRED`,
`PGBACKREST_STANZA_CHECK_REQUIRED`, `PGBACKREST_FULL_BACKUP_REQUIRED`,
`PGBACKREST_PITR_REHEARSAL_REQUIRED`.

`--evidence-dir` writes `prod-env-preflight-<mode>.md` and `.json` with secret
values redacted. This is the public host preflight evidence packet for PRs and
operator handoff. It proves env shape only; DNS changes, ACME issuance, real
registry pull, SOPS decrypt, and pgBackRest backup/PITR execution stay
`runtime-unverified(public host)` until performed on the actual host.

`internal-smoke`/`local`은 별도 경계다. `infra/prod/internal-smoke.env.example`
또는 `scripts/verify_internal_host_runtime.sh`가 생성한 env에서만 허용하며,
localhost 도메인, mock Hermes, local `momo-*:internal-smoke*` 이미지, `change-me-*`,
`momo_*_dev_pw` placeholder가 의도된 테스트 값이다. 이 파일은 real host env나
SOPS production secret의 입력으로 사용하지 않는다. 이 모드의 provider는
`AGENT_PROVIDER_MODE=internal-host-mock`으로 고정한다.

운영 host를 띄우기 전에도 real provider credential 자체는 repo-local opt-in gate로
먼저 확인할 수 있다. 이 gate는 provider secret을 출력하지 않고 redacted evidence만 남긴다.

```sh
EXTERNAL_AGENT_PROVIDER_ENV_FILE=/secure/momo/external-hermes.env \
scripts/local_gate.sh --profile external-agent-provider
```

`external-hermes`가 명시됐는데 `HERMES_BASE_URL`이 localhost/mock/non-HTTPS이거나
`HERMES_API_KEY`가 placeholder면 fail-fast한다. MOMO-238의 local loopback 예외는
`MOMO_ENV=local AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1` 개발 루프 전용이며, 운영 host
env로 승격하지 않는다(`docs/external-agent-provider/local-hermes-gpt.md`). credentials가 없으면
`runtime-unverified(external provider credentials)` evidence로 skip되며 staging/prod
ready 판정으로 쓰지 않는다.

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
- **worker**: AgentWorker 이미지, `AGENT_PROVIDER_MODE`/`HERMES_BASE_URL`/`HERMES_API_KEY`, `depends_on: postgres(healthy)`.

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
> **MOMO-300:** 내부 전용을 blanket reverse_proxy에 맡기지 않고, 정본 `infra/prod/Caddyfile`이 `handle /v1/centrifugo/*` 블록으로 엣지에서 **403 차단**한다(해당 라우트는 API rate limit 제외라 공개 시 `CENT_PROXY_SECRET` brute-force 표면이 됨).

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

### 4.4 웹 클라이언트 서빙 (`APP_DOMAIN`) — MOMO-390 / ADR-0119 D1-A

워크스페이스 대표 도메인이 곧 웹 주소다: Caddy가 `{$APP_DOMAIN}` site에서 SPA 정적 자산을 서빙하고 같은 오리진의 `/v1/*`를 `api:8080`으로 프록시한다(브라우저 기준 SPA와 API가 같은 오리진 → CORS/쿠키 문제 원천 회피, 서버 무변경). realtime은 기존 `rt.` 도메인 유지(토큰 인증이라 교차 오리진 무해). **api 컨테이너는 웹 자산을 서빙하지 않는다.**

**신규 env (전부 optional):**

| 키 | 기본값 | 의미 |
|---|---|---|
| `APP_DOMAIN` | (unset) | 웹 SPA 공개 도메인(예: `momo.example.com`). unset이면 웹 서빙 비활성. |
| `MOMO_WEB_IMAGE` | (required) | `clients/web`의 production `dist`를 담은 immutable digest image. install/upgrade가 `web-init`으로 실행한다. |
| `WEB_STATIC_VOLUME_NAME` | `momo-web-static` | `web-init`이 채우고 Caddy가 read-only로 마운트하는 named volume 이름. |

**DNS/TLS:** `APP_DOMAIN`을 쓰려면 해당 이름의 A/AAAA 레코드를 VPS IP로 추가한다(§2와 동일, Caddy ACME 자동 발급). `rt.<domain>`/`api.<domain>`과 **다른 이름**이어야 한다 — `prod_env_preflight.sh`가 strict 모드에서 APP_DOMAIN 설정 시 public DNS 형태·placeholder 금지·API/REALTIME과의 중복을 fail-fast로 검사한다(unset은 항상 허용).

**미설정(`APP_DOMAIN` unset) 시 동작 — 완전 하위 호환:** Caddyfile의 site 주소가 예약 sentinel `momo-app-domain-unset.localhost`로 폴백된다. `.localhost`는 Caddy 내부 CA로만 인증서가 발급되어 ACME 트래픽이 없고, sentinel host를 겨냥한 요청은 모든 경로(`/`·deep link·`/v1/*`)에서 404로 fail-closed된다(호스트 매처 가드가 프록시/파일 핸들보다 먼저 평가 — `scripts/web_serving_smoke.sh`가 런타임 검증). 기존 `api.`/`rt.` 2-site 동작은 무변화. **주의:** compose는 `${APP_DOMAIN:-<sentinel>}`로 빈 문자열도 sentinel로 흡수한다 — Caddy는 빈 site 주소를 파싱하지 못하므로 compose 밖에서 이 Caddyfile을 쓸 때도 `APP_DOMAIN`을 빈 값으로 export하지 말 것.

**자산 배치:** `infra/prod/Dockerfile.web`이 Node build stage에서 `npm ci && npm run build`를 수행하고 최종 `momo-web` 이미지에는 `dist`와 복사용 최소 도구만 남긴다. production host는 소스를 빌드하거나 bind mount하지 않는다. install/upgrade가 pinned `MOMO_WEB_IMAGE`를 one-shot `web-init`으로 실행해 `momo-web-static` volume을 교체하고, Caddy는 이를 read-only로 서빙한다(ADR-0002).

**보안 헤더:** `{$APP_DOMAIN}` site는 공통 `security_headers`(HSTS·`X-Frame-Options DENY` 등)에 더해 SPA 응답에 ADR-0119 CSP를 강제한다. `default-src 'self'`로 inline script를 금지하고, `style-src 'self' 'unsafe-inline'`, `connect-src 'self' wss://{$REALTIME_DOMAIN} https://{$REALTIME_DOMAIN}`, `img-src 'self' data:`, `frame-ancestors 'none'`만 허용한다. 실측한 Vite 산출물은 외부 JS/CSS asset tag만 사용해 script hash가 불필요하다. `/v1/centrifugo/*`는 이 site에서도 엣지 403(MOMO-300과 동일 규칙).

**웹 realtime Origin 허용 — MOMO-398:** Centrifugo v6는 `client.allowed_origins`가 정의되지 않으면 `Origin` 헤더가 요청 Host와 다른 브라우저 websocket 연결을 403으로 거부한다(PR #407 재현: `request Origin is not authorized due to empty allowed_origins`). 이를 위해 prod compose가 centrifugo 서비스에 `CENTRIFUGO_CLIENT_ALLOWED_ORIGINS=${APP_DOMAIN:+https://${APP_DOMAIN}}`를 주입한다 — **operator가 별도 env를 설정하지 않으며, 허용 오리진은 언제나 `https://<APP_DOMAIN>` 단 하나로 파생된다.** `APP_DOMAIN` unset(또는 빈 값) 시 이 env는 빈 문자열로 렌더되는데, Centrifugo v6는 빈 env를 unset으로 간주하므로("Empty environment variables are considered unset (!) and will fall back to the next configuration source" — centrifugal.dev/docs/server/configuration) `centrifugo.prod.json` 그대로 = 기존 동작 완전 무변화(브라우저 realtime fail-closed 유지). 네이티브 클라이언트는 어느 모드에서든 무영향 — Centrifugo는 `Origin` 헤더가 없는 연결을 검사 없이 통과시킨다("Connection requests without `Origin` header set are passing through without any checks", 같은 문서 `client.allowed_origins`). realtime은 `rt.` 도메인(교차 오리진)이므로 SPA의 CSP `connect-src wss://{$REALTIME_DOMAIN}` 허용과 이 allowed_origins 허용이 함께 있어야 브라우저 연결이 열린다. env 파일에 `CENTRIFUGO_CLIENT_ALLOWED_ORIGINS`를 직접 넣지 말 것 — compose 보간은 그 값을 읽지 않으며, `prod_env_preflight.sh` strict 모드가 파생값과 모순되는 설정(예: APP_DOMAIN unset인데 origins 설정, 또는 파생값과 다른 origins)을 fail-fast로 차단한다.

**검증:** `scripts/local_gate.sh --profile web-serving` — e2e compose `web` 프로파일의 `web-init`과 HTTP-only Caddy edge를 28070~28074 격리 포트에서 기동한다. 실제 `dist`의 `/`와 SPA 폴백, API login 프록시, Centrifugo callback 403, CSP/X-Frame-Options, `/health` 200을 호스트 curl로 검사한다. 공인 DNS·ACME·production TLS는 이 로컬 게이트 범위 밖이다. 기존 `scripts/web_serving_smoke.sh`는 APP_DOMAIN unset sentinel 회귀를 계속 담당한다.

---

### 4.5 셀프호스트 첨부 저장 (`s3` / MinIO) — ADR-0127

Google Workspace를 쓰지 않는 설치는 REST나 클라이언트를 바꾸지 않고 S3 호환 저장소를
선택할 수 있다. AWS S3, Cloudflare R2, Backblaze B2처럼 운영자가 이미 관리하는 저장소는
해당 provider의 공개 HTTPS endpoint·region·bucket·access key를 SOPS/host-local env로
주입한다. MinIO 단일 노드 옵션은 아래처럼 prod compose의 `s3` 프로파일을 켠다.

```env
MOMO_ARCHIVE_BACKEND=s3
MOMO_S3_ENDPOINT=https://files.example.com
MOMO_S3_REGION=us-east-1
MOMO_S3_BUCKET=momo-attachments
MOMO_S3_ACCESS_KEY=__SOPS_OR_HOST_SECRET__
MOMO_S3_SECRET_KEY=__SOPS_OR_HOST_SECRET__
MOMO_S3_FORCE_PATH_STYLE=1
MINIO_PUBLIC_DOMAIN=files.example.com
MINIO_VOLUME_NAME=momo-minio-data
```

MinIO를 선택했다면 `files.example.com`의 A/AAAA는 momo 호스트를 가리켜야 한다. Caddy는
`MINIO_PUBLIC_DOMAIN` site를 TLS로 열고 private compose network의 `minio:9000`으로만
프록시한다. 따라서 API가 반환하는 15분 presigned PUT/GET URL은 클라이언트가 접근할 수
있지만 MinIO 관리 포트나 자격증명은 공개되지 않는다. `MINIO_PUBLIC_DOMAIN`이 없으면 해당
Caddy site는 `.localhost` sentinel 404로 fail-closed한다. AWS/R2/B2를 쓸 때는
`MINIO_PUBLIC_DOMAIN`을 설정하지 않으므로 provider endpoint를 Caddy가 가로채지 않는다.

```sh
docker compose --env-file /run/momo/prod.env \
  -f infra/prod/docker-compose.prod.yml --profile s3 up -d
```

`minio-init`은 health 이후 bucket을 멱등 생성하고 종료한다. 운영자는 최초 기동 전에 예시
자격을 반드시 교체하고 env 파일을 0600/SOPS 경계에 둔다. key/secret, presigned URL의
`X-Amz-*` query, 업로드/다운로드 URL 전체를 로그·이슈·PR evidence에 복사하지 않는다.
백업은 `minio-data` 볼륨 하나로 끝나지 않는다. 별도 호스트/오브젝트 저장소로 복제하고
복원 리허설을 수행해야 한다. 실제 MinIO 왕복과 TLS/DNS/복원 evidence 전에는
`runtime-unverified(public host)`다.

로컬 오케스트레이터 검증은 전용 28040~28044 포트에서 두 모드를 각각 실행한다.

```sh
scripts/verify_attachment_upload.sh
ATTACHMENT_GATE_BACKEND=s3 scripts/verify_attachment_upload.sh
```

두 번째 모드는 presigned PUT → signed HEAD complete → 메시지 결속 → 인증된 content
경로의 presigned GET → 비멤버 403을 왕복하고, 서비스 로그와 Postgres 원장에 capability
URL/자격이 남지 않았음을 `grep`으로 단정한다.

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
scripts/local_gate.sh --profile external-agent-provider   # real provider credentials가 있을 때만 PASS evidence
```

이 gate가 자동으로 닫는 범위:

- `infra/prod/docker-compose.prod.yml`이 `.env.example`만으로 `docker compose config --quiet`를 통과한다.
- Caddyfile이 `API_DOMAIN`/`REALTIME_DOMAIN`을 받아 api와 Centrifugo에 내부 reverse proxy한다.
- `infra/prod/centrifugo.prod.json`이 Redis engine, namespace 4종, subscribe proxy, history ttl 계약을 만족한다.
- prod plaintext secret/env/age key 파일이 tracked되지 않고, example 파일은 placeholder만 담는다.
- SOPS/age와 pgBackRest PITR rehearsal checklist/evidence template이 존재한다.
- MOMO-216 internal smoke overlay가 prod compose 위에서 렌더링되고, local image fallback tags, explicit image-based `migrate` job, MomoServer `/health` route, relay/worker env/enablement, mock Hermes boundary를 static 검증한다.
- MOMO-220/MOMO-227 host-runtime gate가 local api/relay/worker/migrate/mock-Hermes images를 빌드하고, prod+internal-smoke stack boot, migration idempotency, `/v1/agent-runtime/status` mock/redaction projection, REST message, relay publish, mock agent roundtrip을 실제 검증한다.
- MOMO-222 backup gate가 임시 PostgreSQL source→dump→별도 restore→marker checksum evidence를 markdown/json으로 생성한다. `host-runtime` profile도 이 verifier를 포함한다.
- MOMO-230 external-agent-provider gate는 credentials가 있을 때만 real Hermes/Kim Intern OpenAI-compatible SSE preflight와 local MomoServer/AgentWorker/OutboxRelay `@김인턴` 1왕복을 검증한다.
- MOMO-234 boundary: Codex OAuth access/refresh token은 provider host 내부 secret이다. momo 운영 env와 smoke에는 `AGENT_PROVIDER_MODE=external-hermes`, `HERMES_BASE_URL`, `HERMES_API_KEY`, `AGENT_MODEL`만 넣고 Codex/OpenAI OAuth token env var를 전달하지 않는다.
- MOMO-238 local loopback: `http://127.0.0.1:<port>/v1`/`localhost`는 local-only opt-in smoke에만 허용한다. non-loopback HTTP와 운영 loopback은 계속 fail-fast한다.

`runtime-unverified(public host)`: 실제 `https://api.<domain>/health`, public DNS, TLS 인증서 발급/갱신,
real registry image pull/run, SOPS 복호화, pgBackRest stanza/check/full backup/WAL archive/time-target PITR restore rehearsal은 public host-runtime에서만 닫는다. Real provider credentials가 없으면 외부 hermes/Kim Intern side effect는 `runtime-unverified(external provider credentials)`로 남긴다.

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
- Runtime smoke: `scripts/verify_internal_host_runtime.sh`는 source checkout bind mount 없이 `/health`, `/v1/agent-runtime/status`, REST login/message send, OutboxRelay→Centrifugo publish, mock Hermes `@김인턴` roundtrip evidence/log path를 출력한다.
- External provider smoke: `scripts/verify_external_agent_provider.sh`는 source checkout host process로 local stack을 띄운 뒤 real Hermes/Kim Intern provider에 `@김인턴` 1왕복을 보낸다. 이 smoke는 운영 계정/키 발급 자체를 하지 않으며, credentials가 없으면 explicit skip evidence만 남긴다.
- Caddy/TLS: Caddy가 유일한 public edge다. Local smoke는 `localhost`/`rt.localhost`와 `18080/18443` config를 확인하지만 public ACME/DNS는 검증하지 않는다.
- Backup/restore: repo-local dump/restore 리허설은 `backup` profile evidence로 닫고, 실제 pgBackRest stanza/check/full backup/WAL/time-target PITR restore rehearsal은 `runtime-unverified(public host)`다.

### 8.1 헬스체크 / 로그
- `GET https://api.<domain>/health` 200 = api green. Caddy/Centrifugo/postgres healthcheck도 green.
- `GET https://api.<domain>/v1/agent-runtime/status` = Kim Intern provider mode/availability projection. `endpointLabel`은 redacted URL이고 `HERMES_API_KEY`/tokens는 출력하지 않는다.
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
