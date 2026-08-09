# buzz급 진단 감사 — 축 D: 프로덕션 운영 준비

> 감사 워커 D · 2026-08-10 · 읽기 전용(코드·설정 변경 0줄, 서버 미접속)
> 기준 브랜치 = `origin/track/engine` (8d9bb512). main-only 사실은 별도 표기.
> 패킷: `docs/planning/handoffs/2026-08-10-buzz-diagnosis-audit-packet.md` §D

---

## 0. 판정 요약

| # | 항목 | 판정 | 층 |
|---|---|---|---|
| D-1 | PG 백업 절차 문서 | **GAP** — 문서·스켈레톤은 있으나 전부 은퇴한 Swift 스택 대상, 라이브 Rust 스택에는 백업 배선 0 | 1층 |
| D-2 | 복구 리허설 흔적 | **GAP** — 리허설 스크립트 존재+자기고백형 `not_covered` 5항목. 프로덕션 PITR 리허설 0회 | 1층 |
| D-3 | outbox/첨부(Drive) 복구 경계 | **GAP** — 경계 정의 문서 0. outbox는 PG 안이라 DB 백업에 종속, Drive 첨부는 백업 범위 밖(미문서화) | 2층 |
| D-4 | 메트릭 | **GAP(심각)** — 라이브 Rust 바이너리에 `/metrics` **미구현**. `MOMO_METRICS_*`를 "읽지 않고 무시"한다고 코드가 명시 | 1층 |
| D-5 | 로그 | **GAP** — 비구조화 텍스트 로그(문서는 JSON이라 주장) + 로그 로테이션 설정 0 + 수집기 0. 디스크 82% 사용 호스트 | 1층 |
| D-6 | 알림 | **GAP(전무)** — alertmanager·pagerduty·uptime 모니터링·헬스 폴링 전부 0건. 장애 인지 경로 = 사람이 눈치채기 | 1층 |
| D-7 | 업그레이드 절차 | **PASS(라이브 경로)** / **GAP(레포 도구)** — `ncp-rust-deploy.md`가 실측 기반으로 정확. 단 `upgrade.sh`는 Swift 전용이라 라이브에 미적용 | 1층 |
| D-8 | 마이그레이션 롤백 | **GAP(설계상 불가)** — 63개 forward-only, down 마이그레이션 0. 롤백 = PITR뿐인데 PITR이 미배선(D-1) | 1층 |
| D-9 | 버전 정책 | **GAP(전무)** — GitHub Release 0건·CHANGELOG 0·semver 정책 0. 라이브 이미지 태그 = 커밋 해시 | 2층 |
| D-10 | 장애 대응 런북 | **GAP** — 배포 런북은 충실, "무엇이 죽으면 어떻게" 문서 0건. troubleshooting/incident/postmortem 문서 0 | 1층 |
| D-11 | SPOF | **GAP(구조적)** — 단일 VM 1대, 관리형 DB 0, replica 0, staging 환경 0, 백업 0 | 1층 |
| D-12 | 성능 실측 | **GAP(치명)** — 실측 전량이 **클라이언트 렌더링** 수치. 서버 부하시험 0회, 도구 0개 | 1층 |
| D-13 | CI | **GAP(치명)** — 워크플로 5개 전부 `workflow_dispatch`, 마지막 실행 2026-06-25, **Rust 워크스페이스를 빌드한 적 없음** | 1층 |

**1층 종합**: 운영 준비도는 "런칭 가능"이 아니라 **"관측 불가 + 복구 불가 + 회귀 검출 불가"의 삼중 공백**이다. 세 공백 중 어느 하나만으로도 buzz급 오픈소스 런칭의 전제(외부 셀프호스터가 자기 데이터를 맡기고, 외부 기여자가 PR을 보낼 수 있음)가 성립하지 않는다.

---

## 1. 백업 / 복구

### 1.1 있는 것

| 자산 | 경로 | 실체 |
|---|---|---|
| pgBackRest 설정 스켈레톤 3종 | `infra/prod/pgbackrest.conf.example`, `postgresql.pgbackrest.conf.example`, `pgbackrest-cron.example` | `.example` 확장자 — 값 없는 골격 |
| 백업/시크릿 런북 | `docs/SECRETS_BACKUP_RUNBOOK.md` | stanza-create→check→full backup→PITR 리허설 절차 완비 |
| 백업 절차 문서 | `docs/DEPLOY.md` §7 (677~711행) | archive_command·retention(full 4주)·repo cipher AES-256 |
| 복구 리허설 게이트 | `scripts/verify_backup_restore_rehearsal.sh` (210행) | 실행 가능. 임시 PG18 두 컨테이너로 dump→restore→마커 체크섬 대조 |
| Day-2 진입점 | `infra/prod/momo-ops.sh` `backup-hint` (346~358행) | 백업 체크리스트 5단계 출력 |
| 업그레이드 전 백업 강제 | `infra/prod/upgrade.sh` (72~76행) | `--backup-evidence FILE`에 `Result: PASS`가 없으면 업그레이드 거부 |

계약 설계 자체는 좋다. `upgrade.sh`가 백업 증거 없이는 업그레이드를 거부하는 fail-closed 구조는 buzz에도 없는 장치다.

### 1.2 결함 1 — 백업 자산 전부가 은퇴한 스택 대상

`upgrade.sh`·`momo-ops.sh`·pgBackRest 절차는 전부 `infra/prod/docker-compose.prod.yml`(Swift 이미지)을 겨눈다:

```
infra/prod/deploy-lib.sh:10:  COMPOSE_FILE="$PROD_DIR/docker-compose.prod.yml"
```

`infra/prod/upgrade.sh` 전문에 `rust` 문자열 0건. 라이브는 `infra/rust/docker-compose.rust.yml`이고(`docs/runbooks/ncp-rust-deploy.md`), 그 런북의 배포 절차 어디에도 백업 단계가 없다. 즉 **백업 강제 게이트가 라이브 배포 경로에 걸려 있지 않다.**

### 1.3 결함 2 — 라이브 PG에 백업 배선 0

`infra/rust/docker-compose.rust.yml:37-56`의 postgres 서비스:

- 이미지 = `pgvector/pgvector:0.8.5-pg18-trixie` 단독 (pgBackRest 사이드카 없음)
- 볼륨 = `pgdata:/var/lib/postgresql` 네임드 볼륨 하나
- `archive_mode`/`archive_command`/`wal_level` 설정 주입 **없음** → WAL 아카이빙 비활성
- 백업 크론 없음, 오브젝트 스토어 repo 없음

**결과: 라이브 데이터의 복구 지점 목표(RPO)는 "없음"이다.** VM 디스크가 죽으면 전량 손실이고, 실수로 지운 테넌트 데이터를 되돌릴 수단이 0이다.

### 1.4 결함 3 — 리허설 스크립트가 스스로 커버하지 않는다고 선언

`scripts/verify_backup_restore_rehearsal.sh:167-173`이 증거 JSON에 `not_covered`를 하드코딩한다:

```
"not_covered": [
  "production pgBackRest stanza-create/check/full backup",
  "WAL archive push and time-target PITR",
  "SOPS production secret decrypt",
  "public host object-store backup repository",
  "destructive restore on any primary data directory",
],
```

즉 이 게이트가 PASS해도 **프로덕션 복구력에 대해 아무것도 증명하지 않는다.** 문서도 같은 말을 한다 — `SECRETS_BACKUP_RUNBOOK.md:7-8` "backup restore remains `runtime-unverified`", `DEPLOY.md` §8.0 "pgBackRest stanza/check/full backup/WAL archive/time-target PITR restore rehearsal은 public host-runtime에서만 닫는다".

레포·저널·STATUS 전수 검색 결과 **프로덕션 PITR 리허설 완료 증거 0건**.

### 1.5 결함 4 — outbox/첨부 복구 경계 미정의

- **outbox**: PG 테이블이므로 DB 백업에 종속. 별도 경계 문서 없음. 릴레이는 `RELAY_MAX_ATTEMPTS`(기본 8) 소진 시 `status='failed'`로 종결(`server-rust/bins/momo-relay/src/lib.rs:174-183`) — 이 시점에 남는 것은 로그 한 줄이고, 재처리 도구·알림·DLQ 조회 표면이 없다.
- **Drive 첨부(ADR-0004/0151)**: 바이트는 Google Drive 공유드라이브에, 메타데이터만 PG에. **PG를 시점 복원하면 Drive와 정합이 깨진다**(복원 시점 이후 업로드된 파일이 고아가 되고, 삭제된 행이 참조를 잃음). 이 경계를 다룬 문서 0건.

---

## 2. 관측성

### 2.1 결함 1 — 라이브 Rust 스택에 `/metrics`가 없다 (인터뷰 선행 실측보다 심각)

인터뷰는 "prometheus 라이브 부재"라 했다. 실측 결과는 **더 나쁘다: 스크레이프할 대상 자체가 없다.**

`server-rust` 트리 전체에서 `metrics` 문자열 총 **2건**, 둘 다 doc-comment이고 내용이 "무시한다"이다:

```
server-rust/bins/momo-server/src/config.rs:15
//! 키가 compose가 설정하지만 이 서버가 아직 소비하지 않는 것들(… `MOMO_METRICS_*`)은
//! **ignored, never fatal**

server-rust/bins/momo-relay/src/config.rs:7
//! `MOMO_METRICS_*`) are ignored and never block a boot
```

- `server-rust/Cargo.toml` workspace 의존성에 prometheus/metrics-exporter/opentelemetry crate **0개**
- Axum 라우터(`momo-server/src/lib.rs:706`)에 등록된 것은 `/healthz`·`/health`뿐

반면 `infra/prod/prometheus.yml`은 `api:9090`/`relay:9091`/`worker:9092`를 스크레이프하도록 적혀 있다. **이 설정을 그대로 붙이면 3개 타깃 전부 down으로 뜬다.**

메트릭 구현은 Swift 쪽에만 있다 — `services/MomoMetrics/` (MOMO-562, JOURNAL:477 "562 main 랜딩 … /metrics 5종·bounded 라벨"). 그 5종은 `DEPLOY.md` §8.2에 표로 정의돼 있고(`momo_outbox_pending_oldest_age_seconds`, `momo_budget_trips_total`, `momo_apns_failures_total`, `momo_agent_turn_duration_seconds`, `momo_outbox_publish_latency_seconds`) 경보 임계치까지 적혀 있다. **정의는 살아 있고 구현이 은퇴했다.**

`infra/rust/docker-compose.rust.yml:12-15`가 이를 "의도적 부재(B1.7 scope, not an omission)"로 선언한다 — 즉 알고 남긴 부채다.

### 2.2 결함 2 — 로그가 문서와 다르고 로테이션이 없다

`DEPLOY.md` §8.1 주장: "구조화 로그(JSON): 모든 로그에 `run_id`/`workspace_id` 상관키."

실측 (`server-rust/bins/momo-server/src/main.rs:18-23`):
```rust
tracing_subscriber::fmt()
    .with_env_filter(...)
    .init();
```
`.json()` 미호출 → 기본 **사람이 읽는 텍스트 포맷**. 파싱 가능한 구조화 로그가 아니다.

로그 로테이션: `infra/` 전체에서 `logging:`/`max-size`/`max-file` 설정은 `infra/livekit.yaml` 한 건뿐이고, 라이브 compose 5개 서비스 전부 Docker 기본 `json-file` 무제한 드라이버를 쓴다. `docs/runbooks/ncp-rust-deploy.md` 기준 호스트 디스크는 **9.8G 중 ≈82% 사용**. 로그 무한 증가가 디스크 고갈로 이어지는 경로가 열려 있고, 이 위험을 다룬 문서가 없다(런북의 「디스크 위생」은 이미지 태그 회수만 다룬다).

### 2.3 결함 3 — 알림·헬스 감시 전무

레포 전수 검색:
- `alertmanager|pagerduty|opsgenie|oncall` → `scripts/verify_signed_webhook_ingress.sh` 1건(웹훅 호환성 테스트 픽스처, 알림 배선 아님)
- `uptimerobot|betterstack|pingdom|statuspage` → 0건
- 헬스 폴링 크론/워치독 → 0건 (`local_soak_monitor.sh`는 로컬 도그푸드용, `infra/docker-compose.yml`=Swift 개발 스택 대상)

**장애 인지 경로 = 성재가 앱을 열어보고 이상함을 느끼는 것.** MTTD 상한이 없다.

### 2.4 결함 4 — 헬스체크가 핵심 컴포넌트를 비운다

`infra/rust/docker-compose.rust.yml`의 `healthcheck:` 블록: postgres(50행)·centrifugo(90행)·api(238행) **3개뿐**. `relay`(247행)와 `agent-worker`(276행)에는 없다.

relay는 단일 쓰기경로의 배달 컴포넌트다. 크래시하면 `restart: unless-stopped`가 살리지만, **크래시 없이 멈추면(DB 커넥션 고갈·Centrifugo 401 루프 등) 아무것도 감지하지 못한다.** 메시지가 안 가는데 컨테이너는 초록색인 상태가 성립한다.

### 2.5 있는 것 (공정 기록)

- `/healthz`가 DB를 실제로 핑한다(`momo-server/tests/cors_allowlist.rs:5` — "it pings the DB", DB 없으면 503). 얕은 헬스체크가 아니다.
- relay 재시도가 429/5xx=transient, 그 외 4xx=permanent로 분류되고 지수 백오프 + `attempts` 상한 종결이 있다(`momo-relay/src/centrifugo.rs:16`, `lib.rs:15-16`). 배달 로직 자체는 견실하다.
- `audit_log` 테이블이 스키마에 있고 마이그레이션 063이 이벤트 구독 배달 감사를 추가했다.

---

## 3. 업그레이드 · 마이그레이션 · 버전 정책

### 3.1 마이그레이션 — forward-only, 롤백 수단 없음

- 위치: `server/Migrations/` — **engine 63개 / main 62개**(engine에 `063_event_subscription_delivery_audit.sql` 추가)
- down/rollback/revert 파일 **0개** (전수 검색)
- 러너: `momo-migrate` 바이너리 → `momo_db::migrate::run_migrations` (파일당 단일 트랜잭션, `schema_migrations` 추적, 멱등). 런북이 `[migrate] IDEMPOTENCY_OK` 확인을 절차에 넣는다.
- `upgrade.sh` usage(31~33행): *"Migrations are forward-only. Automatic/manual rollback restores api/relay/worker images only; it never reverses database migrations."*
- `DEPLOY.md` §9.3: *"DB: 마이그레이션은 forward-only 원칙 → 파괴적 변경 전 백업 필수. 데이터 사고 시 §7 PITR로 시점 복원."*

**닫힌 고리**: 스키마 롤백의 유일한 처방이 PITR인데, PITR이 라이브에 배선돼 있지 않다(§1.3). 파괴적 마이그레이션이 나가면 되돌릴 방법이 문서상으로도 실제로도 없다.

또한 마이그레이션 트리가 **은퇴한 Swift 서버 디렉터리(`server/Migrations/`) 안에 산다.** Rust 바이너리가 그 경로를 소비한다(`momo-migrate` REPO_ROOT 상대경로 + 이미지가 `/opt/momo`로 복사). 동작은 하지만, "server/를 지울 수 없는 이유"가 마이그레이션이라는 구조는 신규 기여자에게 설명 불가능하다.

### 3.2 업그레이드 — 라이브 경로는 좋고, 레포 도구는 안 맞는다

**라이브(`docs/runbooks/ncp-rust-deploy.md`)** — 실전에서 밟은 함정이 문서에 박혀 있어 품질이 높다:
- 이미지 태그 = track/engine 커밋 해시, 배포 = `smoke.secrets.env`의 태그 교체 1줄
- **compose 파일 5개 + env 2개를 전부 넘겨야 함**(빠뜨리면 notifier만 구 이미지로 남음 — 2026-08-04 실증)
- bind mount inode 함정 2건 성문화(Caddyfile 파일 단위 rename 금지, web 디렉터리 `mv` 스왑 금지 — 둘 다 실증)
- 롤백 = 직전 태그로 되돌리고 `up -d` 1회. 디스크 위생에 "직전 태그 하나는 롤백용으로 반드시 남긴다"
- **HSTS는 롤백 불가**임을 명시하고 max-age를 1일→1주→1년 단계 확장으로 설계

**레포 도구(`infra/prod/upgrade.sh`, 291행)** — 백업 증거 강제·이미지 digest 검증·preflight·`--dry-run`·`--rollback-only`·상태파일(`deploy-state.env.previous`) 전부 갖췄으나, `docker-compose.prod.yml`(Swift)을 겨눈다. **라이브에서 쓸 수 없다.**

### 3.3 버전 정책 — 전무

- `gh release list` → **0건** (레포 `momo`에 GitHub Release가 하나도 없다)
- CHANGELOG 파일 **0개** (전수 검색)
- semver/버전 정책 문서 0건 (`DEPLOY.md`·`RUN.md`·`README.md`·`CONTRIBUTING.md` 전수)
- 데스크톱 알파는 **별도 레포**로 나간다: `docs/NEXT_CHANNEL.md:75` → `github.com/Dawn-kim-official/momo-alpha/releases/download/next-v0.1.0-next.2/...`
- `release-desktop.yml`은 `actions/upload-artifact@v4`로 끝난다(167행) — 릴리스를 **게시하지 않는다**. 실행 이력도 0건.
- 서버 이미지 버전 = 커밋 해시(`momo-rust:dae3a387`). "0.1.0-next.10"류 표기는 데스크톱 앱에만 존재하고 서버와 연동되지 않는다.

**셀프호스터가 "내가 어느 버전을 돌리고 있고, 다음 버전에서 뭐가 바뀌는가"를 알 수 있는 표면이 0이다.**

---

## 4. 장애 대응 · SPOF

### 4.1 런북 커버리지 — 배포는 있고 장애는 없다

`docs/runbooks/` (5개) + 흩어진 런북 8개 전수:

| 있는 것 | 다루는 것 |
|---|---|
| `runbooks/ncp-rust-deploy.md` | 라이브 배포·이미지 롤백·Caddy 설정·웹 SPA 배포·디스크 위생 |
| `runbooks/aws-internal-alpha-deploy.md` | 은퇴한 AWS 내부 알파 배포 |
| `runbooks/internal-alpha-onboarding.md` | 테스터 온보딩 |
| `runbooks/t3-unsettled-usage-repair.md` | **유일한 데이터 수리 런북** (T3 미정산 usage 한정) |
| `runbooks/workd-terminal-attach.md` | workd 터미널 접속 |
| `SECRETS_BACKUP_RUNBOOK.md` | SOPS/pgBackRest 설정 절차(스켈레톤) |
| `PUSH_RELAY_RUNBOOK.md`, `cicd/12-push-relay-deploy-runbook.md` | APNs 릴레이 배포 |
| `IOS_TESTFLIGHT_RUNBOOK.md`, `cicd/10-ios-signing-identity-runbook.md`, `GWS_INTERNAL_CONSENT_RUNBOOK.md`, `legal/01-entity-apple-runbook.md` | 서명·심사·법무 |

**없는 것**: `troubleshoot|failure|incident|postmortem|SLA|SLO` 문서 **0건**(docs/ 전수, `architecture/bible/03-slack.md`의 무관한 매치 1건 제외).

구체적으로 답이 없는 질문들:
- postgres 컨테이너가 안 뜨면? (볼륨 손상 시 절차)
- relay가 살아있는데 메시지가 안 나가면? (실패 outbox 행 조회·재처리)
- Centrifugo가 origin 거부로 전건 403이면? (2026-08-01 실제로 겪었고 런북에 함정으로만 남음)
- 디스크가 100% 차면? (82%에서 출발하는 호스트)
- JWT_HMAC/CENT 키가 유출되면? (`DEPLOY.md` §9.3에 3줄 요약만, 실행 절차 없음)
- 데이터 손실이 발생하면? → **답 없음**(§1.3)

### 4.2 SPOF

`DEPLOY.md` §11이 정직하게 인정한다: *"v0 단일 인스턴스 SPOF는 10인×수팀 수용 가능(L4 §10.1). 전파 확대 전 HA 승격."*

라이브 실태(`docs/runbooks/ncp-rust-deploy.md`):
- NCP KVM **1대**(101.79.11.189), 인스턴스 143929369, 디스크 9.8G(82% 사용)
- 이 한 대에 postgres·centrifugo·api·relay·agent-worker·notifier·caddy·web 전부
- 관리형 DB 0 · read replica 0 · Redis 0(Centrifugo 메모리 엔진 단일노드) · 다중 AZ 0
- **staging 환경 0** — `gh api .../environments` 0건. 이전 QA 환경(momowebqa/AWS)은 은퇴, 현재 배포는 프로덕션 직행
- 백업 0(§1.3) → **VM 손실 = 전량 손실**

`DEPLOY.md` §11이 "코드 변경 0, config/인프라만"으로 수평확장 경로를 표로 제시하나, 그 표는 Swift 스택 전제(Redis 엔진 전환·Centrifugo native PG outbox consumer)이고 Rust 스택에서 재검증되지 않았다.

### 4.3 운영 인력

1인(성재) + AI 세션. 열린 이슈 **125건**, 열린 PR **13건**(실측: `gh issue list --state open` 125, `gh pr list --state open` 13). 온콜 로테이션·에스컬레이션 경로·대응 시간 약속 전부 부재. 이는 오픈소스 프로젝트로선 정상이지만, **셀프호스터에게 "장애 시 우리가 뭘 해줄 수 있다"고 말할 근거가 0**이라는 뜻이다.

---

## 5. 성능 — 실측 근거 전수

### 5.1 존재하는 실측 (3건, **전부 클라이언트 렌더링**)

**① P0 스파이크 게이트** — 2026-07-24, 커밋 `667a40a3`, 근거 `docs/planning/JOURNAL.md:378` + `CURRENT_STATE.md:169`
| 항목 | 수치 |
|---|---|
| 1k 메시지 스크롤 프레임 간격 | **p95 10.3ms**, >33ms 프레임 0 |
| seq 단조성 | 121건 셔플 후 단조·gap 0 |
| 재연결 resume | 25/25 누락 0 |
| 콜드 스타트 | web 181ms · desktop 537ms |
| 메모리 | 196MB (<400MB 게이트) |

**② parity 게이트** — 2026-07-25, 정본 `docs/planning/2026-07-25-parity-gate-report.md` §3 (릴리스 번들 0.1.0-next.5, 실서버)
| 항목 | 수치 |
|---|---|
| 1k 스크롤 실효 fps | 96.0 / 105.5 (2런) |
| 프레임 간격 | p50 8.98~9.04ms · **p95 15.24~18.88ms** · 최대 31.58~35.16ms |
| 콜드 스타트(재실행) | 469 / 487 / 536 / 547ms · 최초 실행 946ms |
| 딥링크 콜드→프리필 | 546 / 535ms |
| 유휴 메모리(60s) | footprint 137.6MB / RSS 247.5MB |
| 1k 로드+스크롤 직후 | footprint ≈169MB / RSS 298.2MB |
| 로그인→앱 셸 | 538ms |
| **`OPTIONS` preflight** | **204, 7.5ms** ← 유일한 서버 응답시간 수치 |

**③ 실서버 스모크 수신 지연** — `CURRENT_STATE.md:163` "실서버 스모크 2회 PASS(**수신 24~74ms**)". 메시지 1건 왕복, n=2.

### 5.2 존재하지 않는 것

레포 전수 검색 결과 **부하시험 도구 0개**: `k6`·`vegeta`·`wrk`·`locust`·`autocannon`·`bombardier`·`hey`·`ab` 어느 것도 없음(STATUS/BUILD_TICKETS/ROADMAP 제외 전수).

| 미측정 항목 | 왜 필요한가 |
|---|---|
| 동시 접속 상한(WS 커넥션) | Centrifugo 메모리 엔진 단일노드의 실제 한계 미지 |
| 메시지 쓰기 처리량(msg/s) | `channel_seq` 행락 직렬화가 병목이 되는 지점 미지 |
| 채널당 동시 쓰기 경합 | 단일 쓰기경로의 핵심 불변식인데 경합 하 동작 미검증 |
| DB 커넥션 풀 포화 | 풀 크기·포화 시 거동 미지 |
| outbox 릴레이 배달 지연(부하 하) | 정의된 메트릭(`momo_outbox_pending_oldest_age_seconds` >5s 경보)의 실측 기준선 0 |
| 에이전트 턴 동시 실행 상한 | LLM 호출이 걸린 경로, 워커 1대 |
| 지속 부하(soak) | **72h soak 실행 0회** — `STATUS.md:1666` "실제 72h soak 완료 … out of scope", `:2303` "실제 72시간 실행 … MOMO-242~246에서 계속 검증한다". 검색 결과 완료 증거 없음 |
| 첨부 업로드 100MB 스트리밍 부하 | ADR-0151이 스트리밍이라 주장, 부하 하 메모리 거동 미측정 |

### 5.3 문서가 주장하는 상한

`DEPLOY.md` §「단일 노드 상한」(224~233행)이 스스로 경계를 친다:

> v1 문서상 보수 상한은 **동시 사용자 수백 명(최대 500명 계획값)** 이다. **이는 SLA나 부하시험 PASS 수치가 아니다** — ADR-0121 D1-A의 경계("동시 수백 명")를 이 문서가 500으로 구체화한 계획값이다. … **실제 팀 트래픽 부하시험 전에는 이 수치를 검증된 처리량으로 표현하지 않는다.**

문서의 정직성은 높이 평가할 만하다. 그러나 판정은 바뀌지 않는다: **"buzz급 실워크로드"를 감당한다는 주장을 뒷받침할 서버측 수치가 단 하나도 없다.**

---

## 6. CI

### 6.1 워크플로 5개 전부 수동 전용

`.github/workflows/` (main == engine, 트리 동일):

| 워크플로 | 트리거 | 실행 이력 |
|---|---|---|
| `ci-build.yml` | `workflow_dispatch:` 단독 | 마지막 **2026-06-25** (실패 3·성공 다수, event=push/pull_request) |
| `publish-images.yml` | `workflow_dispatch:` 단독 | **0건** |
| `release-desktop.yml` | `workflow_dispatch:` 단독 | **0건** |
| `release-ios.yml` | `workflow_dispatch:` 단독 | **0건** |
| `release-macos.yml` | `workflow_dispatch:` 단독 | **0건** |

원인은 `ci-build.yml:2-3`에 박혀 있다:
```
# 2026-06-26: GitHub Actions는 조직 과금/결제 이슈가 해소될 때까지 수동 전용이다.
# 기본 merge gate는 docs/LOCAL_PR_GATE.md의 local evidence이며, 이 workflow는 명시적 dispatch 때만 실행한다.
```

`gh run list` 전수(40건)에서 2026-06-25 이후 실행은 전부 Dependabot `event: dynamic`(의존성 업데이트 알림)뿐. **실제 빌드/테스트는 2026-06-25 이후 GitHub에서 한 번도 돌지 않았다.**

### 6.2 CI가 Rust 워크스페이스를 빌드한 적이 없다 — 확정

`ci-build.yml:32`의 유일한 빌드 루프:
```yaml
for pkg in clients/Core server relay/OutboxRelay workers/AgentWorker clients/macOS; do
  if [ -f "$pkg/Package.swift" ]; then ... swift build ... swift test ...
```

- 대상 5개 전부 **Swift 패키지**. `server-rust`·`cargo` 문자열 0건.
- `server-rust`가 레포에 처음 들어온 커밋: `fcfdde68 feat(server-rust): B0 워크스페이스 골격` — 마지막 CI 실행(2026-06-25)보다 **뒤**다.
- 결론: **오늘 프로덕션에서 도는 코드 전체가 CI에서 컴파일된 적이 한 번도 없다.**

빌드 대상 5개 중 `server`·`relay/OutboxRelay`·`workers/AgentWorker`·`clients/macOS`는 은퇴한 스택이다. 즉 CI를 켜도 **죽은 코드를 빌드한다.**

### 6.3 외부 기여 수용 불가 구조

- PR CI **0** — `pull_request` 트리거를 가진 워크플로 0개
- 브랜치 보호 조회 불가: `gh api .../branches/main/protection` → 403 *"Upgrade to GitHub Pro or make this repository public"*. 즉 **private + 무료 플랜이라 브랜치 보호 자체가 없다**(공개 전환 시 사용 가능해짐 — 이건 공개가 푸는 문제다)
- 머지 게이트 = `docs/LOCAL_PR_GATE.md`의 **로컬 증거** — 기여자의 로컬 머신에서 스크립트를 돌리고 출력을 붙이는 방식. 외부인이 제출한 증거는 검증 불가(재현 환경이 다르고, 위조 가능하고, Docker 데몬·Xcode·PG18을 요구)
- 결과: **외부 기여자가 PR을 열어도 프로젝트가 그 PR의 안전성을 기계적으로 판정할 수단이 없다.** 이는 오픈소스 런칭의 전제 자체를 무너뜨린다.

### 6.4 성재 결정 대기 사항 (판정하지 않음)

GitHub Actions를 다시 켜는 것은 **조직 과금** 문제다(2026-06-26 기록). 공개 레포는 Actions가 무료이므로 **공개 전환이 이 문제를 자동으로 해소**할 가능성이 있으나, 공개 시점·범위 판단은 성재 몫이다.

---

## 7. buzz 기준선 대조 (github.com/block/buzz 실측, 2026-08-10)

레포 메타: Rust, Apache-2.0, ★25,485, 열린 이슈 2,338, 2026-03-06 생성, 마지막 푸시 2026-08-09.

| 축 | buzz | oort | 격차 |
|---|---|---|---|
| **CI 트리거** | `ci.yml`: `push: [main, release]` + **`pull_request:`(무조건)**. `dorny/paths-filter`로 rust/desktop/desktop-rust/web/mobile 5레인 분기 | 5개 전부 `workflow_dispatch`, PR CI 0 | **결정적** |
| **워크플로 수** | **17개** (ci·release·docker·helm-chart·push-gateway-helm-chart·auto-tag-on-release-pr-merge·desktop-release-candidate·desktop-release-cache-proof·mobile-release-candidate·linux-canary·macos-intel-canary·windows-canary·signed-macos-canary·mesh-lifecycle·benchmark-harbor·sprig·sprig-image) | 5개(전부 수동, 4개는 실행 이력 0) | **큼** |
| **릴리스** | semver 태그(`desktop-v[0-9]*`) 트리거, 버전 정규식 검증, 태그-소스 바인딩 검증, 4플랫폼 동시. **최근 30일 8회 릴리스**(v0.5.1~0.5.8) | GitHub Release **0건**, CHANGELOG 0, 데스크톱만 별도 레포로 수동 배포 | **결정적** |
| **카나리** | OS별 카나리 워크플로 4종(linux/macos-intel/windows/signed-macos) + `desktop-release-cache-proof` | 없음 | 큼 |
| **배포 아티팩트** | `deploy/compose`(compose.yml + compose.caddy.yml + Caddyfile + run.sh + README) **및** `deploy/charts`(Helm: deployment·hpa·pdb·servicemonitor·ingress·httproute·pvc·pairing-relay + values.schema.json + ci/ + tests/) + `deploy/local/quickstart-ha-values.yaml` | compose 파일들이 두 스택으로 분열, Helm 없음, HA 경로 없음 | 큼 |
| **관측성** | Helm `servicemonitor.yaml`이 이름있는 `metrics` 포트를 Prometheus Operator로 스크레이프 → **릴레이가 실제로 메트릭을 낸다** | 라이브 Rust에 `/metrics` **미구현**, prometheus.yml은 죽은 타깃을 가리킴 | **결정적** |
| **HA/자가치유** | `hpa.yaml`(오토스케일), `pdb.yaml`(무중단 예산), `_validate.tpl`, `values.schema.json`(설정 검증) | 단일 VM, `restart: unless-stopped`, relay/worker 헬스체크 없음 | 큼 |
| **마이그레이션** | 28개. `BUZZ_AUTO_MIGRATE` **opt-in**(기본 off) — 운영자가 `buzz-admin migrate`를 명시 실행. 프로덕션은 이미지 태그 핀 권고 | 63개. compose `migrate` 원샷 자동 실행. down 마이그레이션 0 | 중간(oort가 자동이라 편하지만 통제권이 없음) |
| **백업** | `./run.sh backup-hint`로 체크리스트 제공(자산 자체는 스켈레톤 수준, DB·Redis·S3 시크릿 안정성 강조) | `momo-ops.sh backup-hint`로 동일 형태 제공 + pgBackRest 절차 문서는 **oort가 더 상세** | **oort 우위(문서), 동률 이하(실행)** |
| **성능 실측** | `perf/RELAY_BUS_SCALING.md` + `relay_bus_scaling.py` + `test_relay_bus_scaling.py` — 실제 Redis 대상 측정 하네스. **64 커뮤니티·100 events/s·pod 1/2/4 조건에서 ingress 64.0× 감소, 4-pod 기준 구 25,600 msg/s → 신 400 msg/s** 재현 가능. 추가로 `benchmarks/harbor-buzz-orchestra`가 **CI에 붙어 있다**(benchmark-harbor.yml) | 서버측 부하 측정 **0**, 도구 0개 | **결정적** |
| **헬스체크** | `/_liveness` + `run.sh status` | `/healthz`(DB 핑 포함 — 이 점은 oort가 더 깊다) | oort 소폭 우위 |

### buzz도 안 하는 것 (공정 기록)

- Prometheus 스택을 셀프호스트 번들에 포함하지 않는다(ServiceMonitor만 제공 — k8s 운영자가 자기 Prometheus에 붙이는 전제).
- compose README에 관측성 절이 없다.
- 백업 자산도 "체크리스트 출력" 수준이다.
- 열린 이슈 2,338건 — 트리아지 부채는 oort(125)보다 훨씬 크다.

**결론**: buzz가 oort보다 압도적인 축은 **CI/릴리스 자동화(D-13)**, **배포 아티팩트의 표준성(Helm/HA)**, **재현 가능한 성능 벤치마크(D-12)** 셋이다. oort가 우위인 축은 **백업 절차 문서의 상세도**와 **헬스체크 깊이**인데, 둘 다 **라이브에 배선돼 있지 않아 실효가 0**이다.

---

## 8. 상위 발견 3개

### 발견 1 — 운영 자산 전량이 은퇴한 스택을 겨눈다 (관측·백업·업그레이드 동시 무력화)

라이브는 Rust(`infra/rust/docker-compose.rust.yml`), 운영 자산은 전부 Swift(`infra/prod/`):

| 자산 | 겨누는 곳 | 라이브 적용 |
|---|---|---|
| `upgrade.sh`(백업 증거 강제·롤백 상태파일) | `docker-compose.prod.yml` | ✗ |
| `momo-ops.sh`(status/logs/backup-hint/invite) | `docker-compose.prod.yml` | ✗ |
| `prometheus.yml`(api:9090·relay:9091·worker:9092) | Swift `/metrics` | ✗ (Rust에 엔드포인트 없음) |
| `services/MomoMetrics`(메트릭 5종 구현) | Swift 프로세스 | ✗ |
| pgBackRest 3종 + `SECRETS_BACKUP_RUNBOOK.md` | Swift prod 호스트 | ✗ |
| `local_soak_monitor.sh` | `infra/docker-compose.yml`(Swift dev) | ✗ |
| `ci-build.yml`(5 Swift 패키지) | Swift | ✗ |

이것은 "미구현"이 아니라 **"구현했는데 다른 스택에 대고 구현했다"**이다. 문서를 읽으면 백업도 메트릭도 업그레이드 게이트도 있어 보이는데, 라이브에서는 전부 0이다. **감사 대상 중 가장 위험한 종류의 부채** — 준비돼 있다는 착시를 만든다.

### 발견 2 — 데이터 소실의 되돌림 경로가 문서상으로도 실제로도 닫혀 있다

세 사실이 하나의 닫힌 고리를 만든다:
1. 마이그레이션 63개 forward-only, down 0개 → 스키마 롤백 불가
2. `DEPLOY.md` §9.3이 유일한 처방으로 §7 PITR을 지목
3. 라이브 PG에 WAL 아카이빙·pgBackRest·백업 크론이 **전부 없다** → PITR 불가

동시에 첨부 바이트는 Drive에, 메타데이터는 PG에 있어(ADR-0004/0151) **PG를 시점 복원하면 Drive와 정합이 깨지는데 그 경계를 다룬 문서가 0건**이다. 즉 백업을 지금 붙여도 첨부 복구는 여전히 미정의 영역이다.

셀프호스터에게 "당신 팀 데이터를 여기 두시라"고 말하려면 이 고리를 먼저 열어야 한다. **런칭 go/no-go의 1순위.**

### 발견 3 — 오늘 프로덕션에서 도는 코드가 CI에서 컴파일된 적이 없다

- 마지막 GitHub Actions 실제 실행: **2026-06-25**
- `server-rust` 최초 커밋: 그보다 **나중**
- `ci-build.yml`이 빌드하는 5개는 전부 Swift 패키지 — cargo 0건
- PR 트리거 워크플로 0개, 브랜치 보호 0(private+무료 플랜)
- 대체 게이트 = 기여자 로컬 머신의 증거 텍스트

이는 회귀 검출 부재이자 **외부 기여 수용 구조의 부재**다. buzz는 모든 PR에 5레인 CI가 붙는다. "오픈소스 프로젝트로서의 성숙도"를 기준으로 삼는 이 감사에서, **PR CI 0은 단일 항목으로 런칭 no-go에 가장 가까운 사실**이다. 다만 근본 원인(조직 과금)은 공개 전환으로 자동 해소될 수 있어, **성재의 공개 결정과 한 묶음으로 판단해야 한다.**

---

## 9. 성재 결정 대기 (판정하지 않음)

| # | 사안 | 왜 성재만 답할 수 있나 |
|---|---|---|
| S-D1 | GitHub Actions 재활성화 / 공개 전환 | 조직 과금 문제(2026-06-26). 공개 레포는 Actions 무료 → 공개 시점·범위 결정과 한 묶음 |
| S-D2 | 셀프호스터에게 약속할 데이터 보증 수준 | RPO/RTO를 몇으로 둘지는 제품 약속이지 기술 판정이 아님 |
| S-D3 | 백업 저장소 조달(오브젝트 스토어 + 비용) | pgBackRest repo1에 실제 스토리지·자격증명 필요 |
| S-D4 | staging 환경 신설 여부 | 두 번째 VM 비용 vs 프로덕션 직행 리스크의 교환 |
| S-D5 | HA 승격 시점 | `DEPLOY.md` §11이 "전파 확대 전 HA 승격"이라 했으나 "전파 확대"의 정의가 런칭 정의에 종속 |
| S-D6 | 버전 정책(semver 채택 여부·서버/클라 버전 결합) | 제품 약속 |
| S-D7 | 온콜·장애 대응 약속 수준(1인 운영) | 인력 결정 |

---

## 10. 다른 축 이첩 (D 판정 아님 — 해당 축이 판단)

- **→ A(라이선스·공개 준비)**: buzz `deploy/compose/run.sh`의 `backup-hint` 서브커맨드(최초 커밋 `6caa359d`, **2026-06-13**, PR #985, "Print the production backup checklist")와 oort `infra/prod/momo-ops.sh`의 `backup-hint` 서브커맨드(최초 커밋 `8b5ae083`, **2026-07-23**, #653, 동일하게 백업 체크리스트 출력)는 **이름·의미가 동일하고 buzz가 40일 앞선다.** ADR-0145의 "패턴 인용만" 주장에 대한 반증 시도 대상 1건으로 넘긴다. D는 이것이 우연인지 차용인지 판정하지 않는다.
- **→ B(배포 재현성)**: 서버 실측이 필요한 D 항목 — ①`docker inspect`로 postgres 볼륨의 실제 마운트·크기 ②호스트 디스크 현재 사용률(런북 기준 82%) ③`docker ps` 각 서비스 로그 파일 크기(`/var/lib/docker/containers/*/*-json.log`) ④크론탭에 백업 잡 존재 여부(파일명만). 전부 값 노출 없이 조회 가능. B의 대행 목록에 편입 권고.
- **→ E(문서 드리프트)**: ①`infra/rust/docker-compose.rust.yml:12-15` 헤더가 `worker`를 "의도적 부재"로 선언하나 실제로는 `agent-worker` 서비스가 276행에 존재(헤더 드리프트) ②`DEPLOY.md` §8.1이 JSON 구조화 로그를 주장하나 실제는 텍스트 포맷 ③`DEPLOY.md` §0이 여전히 "Phase 0 = 5개 Swift 패키지 green"에서 시작 ④열린 이슈 125 / 열린 PR 13 (실측).

---

## 부록 A — 근거 파일 목록

**레포(engine 기준)**
- `.github/workflows/{ci-build,publish-images,release-desktop,release-ios,release-macos}.yml`
- `infra/rust/docker-compose.rust.yml` (라이브 스택 정의)
- `infra/prod/{upgrade.sh,deploy-lib.sh,momo-ops.sh,prometheus.yml,docker-compose.prod.yml}`
- `infra/prod/{pgbackrest.conf,postgresql.pgbackrest.conf,pgbackrest-cron}.example`
- `scripts/verify_backup_restore_rehearsal.sh`, `scripts/verify_metrics_observability.sh`, `scripts/local_soak_monitor.sh`
- `server-rust/Cargo.toml`, `server-rust/bins/momo-server/src/{main.rs,lib.rs,config.rs}`, `server-rust/bins/momo-relay/src/{config.rs,lib.rs,centrifugo.rs}`, `server-rust/bins/momo-migrate/src/main.rs`
- `server/Migrations/` (001~063)
- `docs/DEPLOY.md` §0/§7/§8/§9/§11/「단일 노드 상한」, `docs/SECRETS_BACKUP_RUNBOOK.md`, `docs/runbooks/ncp-rust-deploy.md`
- `docs/planning/2026-07-25-parity-gate-report.md` §3, `docs/planning/JOURNAL.md:378,477`, `docs/planning/CURRENT_STATE.md:163,169`, `STATUS.md:1659-1670,2301-2303`

**실행한 실측 명령(읽기 전용)**
- `gh run list --limit 40 --json name,status,conclusion,createdAt,event` → 2026-06-25 이후 실빌드 0
- `gh run list --workflow=<각 5종>` → publish-images/release-* 전부 `[]`
- `gh release list --limit 10` → 0건
- `gh issue list --state open --limit 200 --jq length` → 125 / `gh pr list --state open --jq length` → 13
- `gh api repos/{owner}/{repo}/environments` → 0건
- `gh api repos/{owner}/{repo}/branches/main/protection` → 403 (private+무료 플랜)
- `git log --diff-filter=A --reverse -- server-rust` → `fcfdde68` (CI 마지막 실행 이후)
- `git grep -ri 'metrics' -- server-rust | wc -l` → 2 (둘 다 doc-comment)
- `git ls-tree -r origin/track/engine | grep migrations` → down/rollback 0

**buzz(github.com/block/buzz) 실측**
- `gh api repos/block/buzz` / `.../contents/.github/workflows` / `.../contents/{deploy,perf,.release}` / `.../releases`
- `.github/workflows/{ci,benchmark-harbor,release,docker}.yml` 본문
- `deploy/charts/buzz/templates/` (hpa·pdb·servicemonitor 확인), `deploy/compose/README.md`, `perf/RELAY_BUS_SCALING.md`
- `gh api 'repos/block/buzz/commits?path=deploy/compose/run.sh'` → `6caa359d` 2026-06-13
