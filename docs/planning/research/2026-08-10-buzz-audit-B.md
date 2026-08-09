# buzz급 진단 감사 — 축 B: 배포 재현성 · 단일 이미지

> 워커 B · 2026-08-10 · 읽기 전용(코드·설정 변경 0줄, 서버 미접속).
> 기준 브랜치 = **origin/track/engine**(8d9bb512). main-only 사실은 명시.
> 라이브 좌표: `momo-rust:6bfc9b82` · 웹 `index-Dp1ym0h8` · `infra/rust/Caddyfile`(#1217 회수) · 절차 정본 `docs/runbooks/ncp-rust-deploy.md`.

---

## 0. 한 줄 판정

**라이브(app.oor7.com)는 이 레포에서 재현 불가능하다.** 배포에 필요한 compose 파일 5개 중 **3개가 레포 어느 브랜치·어느 커밋에도 존재한 적이 없고**(값이 아니라 *구조*가 서버에만 있다), 웹 SPA는 어떤 이미지에도 들어가지 않으며, 라이브 이미지를 만드는 자동화가 레포에 0개다. 동시에 README가 셀프호스터에게 안내하는 이미지(`ghcr.io/dawn-kim-official/momo`)는 **한 번도 빌드된 적이 없다**(workflow 실행 이력 total_count=0).

buzz 기준선 대조 11축 중 **PASS는 마이그레이션 모델 하나**(그것도 동급 이상)이고 나머지 9축이 GAP이다. 격차의 성격이 중요하다 — buzz의 미완성(부트스트랩 자동화 부재, 문서 stale)은 *편의*의 결함이지만 oort의 것은 *가능성*의 결함이다. **buzz를 클론한 사람은 손으로 8칸 채우고 뜨고, oort를 클론한 사람은 채울 칸이 어디인지조차 알 수 없다.**

---

## 1. 체크리스트 판정 (1층 = go/no-go 재료, 2층 = 격차 베이스라인)

| # | 항목 | 판정 | 층 |
|---|---|---|---|
| B-1 | 라이브 배포에 필요한 compose 파일 전부가 레포에 있는가 | **GAP** — 5개 중 2개만 | 1층 |
| B-2 | 라이브 env 키셋이 레포 템플릿으로 커버되는가 | **GAP** — 필수 1개 누락으로 렌더 자체가 실패 | 1층 |
| B-3 | 문서가 시키는 첫 명령(`momorust config`)이 fresh clone에서 성공하는가 | **GAP** — exit 1 (실측) | 1층 |
| B-4 | 라이브 이미지를 굽는 자동화가 레포에 있는가 | **GAP** — 0개, 전 과정 수작업 | 1층 |
| B-5 | `publish-images.yml`이 짓는 것 = 라이브가 쓰는 것 | **GAP** — 6축 전부 불일치 + 실행 이력 0 | 1층 |
| B-6 | 웹 정적 자산이 배포 아티팩트에 포함되는가 | **GAP** — 어느 이미지에도 없음(Swift 경로엔 있었음 → 회귀) | 1층 |
| B-7 | Caddy 설정이 레포 정본인가 | **PASS(부분)** — 파일은 회수됐으나 그것을 마운트하는 서비스 정의가 없음 | 2층 |
| B-8 | Centrifugo 설정이 레포 정본인가 | **GAP** — base config는 레포, **라이브 origin 허용목록은 서버 전용** | 1층 |
| B-9 | 마이그레이션 실행 모델이 재현 가능한가 | **PASS** — 이미지 내장 + one-shot + 멱등 검증 | — |
| B-10 | 배포된 것이 어느 커밋인지 in-band로 확인 가능한가 | **GAP** — 버전 스탬핑 0(웹·API 모두) | 2층 |
| B-11 | 라이브 조합을 검증하는 게이트가 있는가 | **GAP** — 죽은 경로만 계약 테스트가 지키고 있음 | 2층 |
| B-12 | buzz 기준선 대조 | **GAP** — 11개 대조축 중 PASS 1(마이그레이션)·부분 1·**GAP 9** | 1층 |
| B-13 | 공개 시점·셀프호스트 지원 범위 | **성재 결정 대기** | — |

---

## 2. 라이브 재현 인벤토리 — 무엇이 레포에 있고 무엇이 서버에만 있나

라이브 기동 명령(정본 `docs/runbooks/ncp-rust-deploy.md:28-31`):

```
docker compose --env-file smoke.secrets.env --env-file push-relay.secrets.env \
  -f docker-compose.rust.yml -f docker-compose.push.yml -f t3.override.yml \
  -f caddy.override.yml -f cent-origin.override.yml up -d
```

### 2-1. 레포에 있는 것

| 항목 | 경로(engine) | 비고 |
|---|---|---|
| Rust 본체 compose | `infra/rust/docker-compose.rust.yml` | postgres·centrifugo·runtime-roles·migrate·api·relay·**agent-worker** (7 서비스) |
| 푸시 오버레이 | `infra/rust/docker-compose.push.yml` | push-relay·notifier (2 서비스) |
| Caddy 설정 **내용** | `infra/rust/Caddyfile` | #1217 회수 · #1213이 보안헤더 5종 추가 |
| Centrifugo base config | `infra/centrifugo.json` | compose가 `../centrifugo.json`으로 마운트 (`docker-compose.rust.yml:87`) |
| 이미지 레시피 | `server-rust/Dockerfile` + `server-rust/docker-entrypoint.sh` | 1 이미지 / 5 커맨드(api·relay·agent-worker·notifier·migrate) |
| 푸시릴레이 이미지 레시피 | `relay/PushRelay/Dockerfile` | |
| env 템플릿 | `infra/rust/rust-smoke.env.example`, `infra/rust/push-relay.env.example` | **불완전 — §3** |
| 마이그레이션 페이로드 | `server/Migrations/*.sql`, `infra/prod/bootstrap_runtime_roles.sql`, `infra/e2e/bootstrap_roles.sql`, `infra/prod/set_initial_owner.sql` | 이미지에 COPY됨(`server-rust/Dockerfile:139-142`) |
| 웹 소스 | `clients/web` | 빌드 산출물은 레포 밖 |

### 2-2. 서버에만 있는 것 (= 레포화 필요 항목)

**값이 비밀이라 서버에 있는 것과, 구조가 서버에만 있는 것을 구분해야 한다. 후자가 진짜 결함이다.**

| 서버 위 이름 | 종류 | 왜 결함인가 | 레포화 난이도 |
|---|---|---|---|
| `t3.override.yml` | **구조** | notifier의 T3 리컨사일러를 켜는 오버레이. **레포 전 오브젝트 검색(`git rev-list --all --objects`) 결과 세 파일 모두 어느 ref에도 커밋된 적 없음** — 문서 산문에만 등장( `docs/runbooks/ncp-rust-deploy.md`, `docs/planning/2026-07-30-ncp-rust-smoke-prep.md`). 켜는 변수는 `MOMO_T3_ENABLED`·`MOMO_T3_LIFECYCLE_CLAIM_DELAY_S`(`server-rust/bins/momo-notifier`) | 낮음 — 시크릿 없음 |
| `caddy.override.yml` | **구조** | `caddy` 서비스 정의 전부(이미지 태그·포트 80/443·`./Caddyfile` 마운트·`/opt/momo/web` 마운트·ACME 볼륨). **레포에 caddy 서비스가 아예 없다** — `docker-compose.rust.yml:12-15`가 "caddy 의도적 제외"라고 선언한 그 자리를 서버 파일이 메우고 있다 | 낮음 — ACME 이메일/도메인만 env |
| `cent-origin.override.yml` | **구조** | 라이브 WSS origin 허용목록(`CENTRIFUGO_CLIENT_ALLOWED_ORIGINS`). 이 값이 틀리면 전 클라이언트 403(파일 주석의 2026-08-01 실측) | 낮음 — 도메인은 비밀 아님 |
| `smoke.secrets.env` | 값 | `MOMO_RUST_IMAGE=<태그>` + 전 시크릿. **배포 = 이 파일의 태그를 바꾸는 일**(런북) → 배포 상태가 서버 파일 안에만 산다 | 값은 유지, **키셋 템플릿**은 레포화 필요 |
| `push-relay.secrets.env` | 값 | APNs 키 호스트 경로 등 | 동상 |
| `/opt/momo/web/**` | **아티팩트** | SPA 바이트 전체. 로컬 `npm run build` → tar → bind mount(`ncp-rust-deploy.md:52-58`) | 중 — §4 |
| APNs `.p8` · relay Ed25519 개인키 · (설정 시) Drive SA 키 | 값 | ADR-0004/0120 대로 레포 비유입이 **정상** | 레포화 불필요 |
| `caddy-data`(ACME 인증서) | 상태 | 정상 | 불필요 |
| `momo-rust:6bfc9b82` 이미지 | **아티팩트** | 레지스트리 없음. 로컬 빌드 → `docker save`/`load` | 높음 — §5 |

**런북 스스로가 이 격차를 자백한다** — `docs/runbooks/ncp-rust-deploy.md`(engine) Caddy 배포 절 2단계:
> `# 서비스 이름은 caddy.override.yml 에서 확인 (아래는 `caddy` 인 경우).`

정본 런북이 자기 스택의 서비스 이름을 단정하지 못한다. 그 파일이 레포에 없기 때문이다.

---

## 3. env 템플릿 격차 — 문서가 시키는 첫 명령이 깨진다 (실측)

`infra/rust/README.md` §2가 시키는 그대로(`cp rust-smoke.env.example → *.secrets.env`) 하고 §3 (0)단계 정적 검증을 밟으면:

```
$ docker compose --env-file <복사본> -f infra/rust/docker-compose.rust.yml config
exit=1
error while interpolating services.agent-worker.environment.PROVIDER_LINK_MASTER_KEY:
  required variable PROVIDER_LINK_MASTER_KEY is missing a value: set PROVIDER_LINK_MASTER_KEY
```

원인: `docker-compose.rust.yml:286`이 `PROVIDER_LINK_MASTER_KEY`를 `:?`(필수)로 요구하는데 `rust-smoke.env.example`에 그 키가 **없다**. `agent-worker`는 B5.1에서 추가됐고 env 템플릿이 따라오지 않았다.

같은 뿌리의 부수 증거:
- `docker-compose.rust.yml:10` 헤더 주석의 서비스 목록이 여전히 `postgres · centrifugo · runtime-roles · migrate · api · relay` — agent-worker가 빠져 있다.
- `infra/rust/README.md:15`도 "3개 커맨드(`api`/`relay`/`migrate`)" — 실제 이미지는 5개(`docker-entrypoint.sh:16-47`).
- 템플릿 미커버 옵션 변수: `CENTRIFUGO_ALLOWED_ORIGINS`(=라이브 403의 원인이 되는 바로 그 값), `MOMO_CORS_ALLOWED_ORIGINS`(데스크톱 로그인 전제), `MOMO_DRIVE_ARCHIVE_BACKEND`/`_SA_KEY_PATH`/`_SHARED_DRIVE_ID`(첨부 전제 — 라이브 Caddyfile의 CSP가 `https://www.googleapis.com`을 여는 것으로 보아 라이브에서는 켜져 있다).

즉 **라이브 배포에 실제로 쓰이는 변수 상당수가 레포 템플릿에 이름조차 없다.** 시크릿 값이 아니라 *키셋*이 서버 전용이라는 뜻이다.

---

## 4. 단일 이미지 격차 — 무엇이 이미지 밖에 있나

`momo-rust` 이미지에 **있는 것**(`server-rust/Dockerfile`): 5 바이너리 · 마이그레이션 SQL 전체 · 롤/오너 SQL · LICENSE/NOTICE · postgresql-client. 마이그레이션 경로는 ENV로 고정(`:158-161`)돼 source-checkout-free다. → **B-9 PASS.**

**없는 것**:

| 빠진 것 | 라이브에서 어떻게 메우나 | 심각도 |
|---|---|---|
| **웹 SPA(`dist/`)** | 로컬 빌드 → tar → 호스트 `/opt/momo/web` bind mount | **최상** |
| caddy 서비스·설정 배선 | 서버 전용 `caddy.override.yml` | 상 |
| centrifugo origin 허용목록 | 서버 전용 `cent-origin.override.yml` | 상 |
| T3 스위치 | 서버 전용 `t3.override.yml` | 중 |
| redis · prometheus | 라이브에 부재(compose가 의도적 제외 선언) | — (축 D) |

### 4-1. 이것은 회귀다

Swift 경로에는 **제대로 된 단일 아티팩트 웹 스토리가 있었다**: `infra/prod/docker-compose.prod.yml`의 `web-init` 서비스가 이미지에 번들된 `dist`를 named volume `momo-web-static`로 복사하고 caddy가 그것을 읽는다(`:44-46`, `:339`). 이미지 하나를 pin하면 웹까지 따라오는 구조다.

Rust 경로는 그 서비스를 잃었다. 지금 웹 배포는 런북의 tar 파이프 한 줄이고, inode 함정 경고(`ncp-rust-deploy.md:61`)가 붙어 있다. 결과:
- 웹과 API의 버전이 **구조적으로 분리**된다 — 한쪽만 배포되는 상태가 기본값이다.
- 어느 커밋의 웹이 떠 있는지 알 방법이 없다. **버전 스탬핑 0** (실측: `clients/web`에 `BUILD_SHA`/`__APP_VERSION__`류 0건, `momo-server`에 `/healthz` 외 version/build 엔드포인트 0건). 라이브 번들 해시 `index-Dp1ym0h8`는 로컬 재빌드로 대조하기 전에는 커밋으로 환원되지 않는다. (B-10 GAP)

---

## 5. `publish-images.yml` vs 라이브 — 불일치 전말

| 축 | `publish-images.yml`이 짓는 것 | 라이브가 쓰는 것 |
|---|---|---|
| Dockerfile | `infra/prod/docker/momo.Dockerfile` (`:53`) — **Swift 6.2** + `clients/web-legacy` | `server-rust/Dockerfile` — **Rust** |
| 바이너리 | MomoServer·OutboxRelay·AgentWorker·LinkShort(+web-assets) — 6 커맨드 | momo-server·relay·agent-worker·notifier·migrate — 5 커맨드 |
| 아키텍처 | `platforms: linux/arm64` **단일**(`:54`) | **amd64** (NCP KVM 101.79.11.189) |
| 배포처 | `ghcr.io/dawn-kim-official/momo:sha-<sha>` (`:19-20`) | 로컬 태그 `momo-rust:6bfc9b82`, `docker save`→scp→`docker load` |
| 공급망 증적 | `provenance: mode=max`, `sbom: true` (`:59-60`) | 없음 |
| 트리거 | `workflow_dispatch` 전용 | 사람 손 |
| **실행 이력** | **0회** | — |

### 5-1. 실행 이력 0 (실측)

```
gh api /repos/Dawn-kim-official/momo/actions/workflows/311986354/runs
→ {"runs":[],"total":0}          # publish-images
gh api .../workflows/330031554/runs
→ {"runs":[],"total":0}          # release-desktop
gh api .../workflows/301286477/runs
→ total 50, 마지막 2026-06-25    # ci-build (이후 disabled_manually)
```

익명 GHCR 프로브도 일치: `ghcr.io/v2/dawn-kim-official/momo/tags/list` → **HTTP 403 DENIED**(토큰 발급 자체가 빈 문자열 = 공개 패키지 아님).

> ⚠️ **패킷 전제 정정.** 감사 패킷 A절이 "`publish-images.yml`이 GHCR 푸시 중(Apache-2.0 §4(d) 재배포 조건 이미 발효)"이라고 적었으나, **워크플로는 한 번도 실행된 적이 없다.** 라이선스 판정은 A의 몫이지만 그 전제가 되는 사실은 이것이다. (A 워커에 전달 필요)

### 5-2. 파생 결과: README가 없는 이미지를 가리킨다

`README.md:11-37` "Self-host in 5 minutes"는 `ghcr.io/dawn-kim-official/momo`를 pin하고 `infra/prod/install.sh`를 실행하라고 한다. 그 이미지는 존재하지 않고, 존재하더라도 arm64 단일이며, 내용은 라이브와 다른 Swift 스택이다. `docs/DEPLOY.md:55`도 같은 6커맨드 ghcr ref를 정본으로 서술한다(886줄 전체가 Swift 전제). — 상세는 축 E 소관, 여기서는 **배포 아티팩트 불일치**로만 기록.

### 5-3. 게이트가 죽은 경로를 지키고 있다 (B-11)

`scripts/tests/test_publish_images_contract.py`는 workflow가 반드시 Swift Dockerfile을 쓸 것·arm64일 것·prod compose의 `MOMO_*_IMAGE` 6종이 존재할 것을 **강제로 단정**한다. 즉 레포의 계약 테스트가 한 번도 안 돌아간 경로를 고정하고 있다. 반대로 **라이브 5파일 조합을 렌더해 보는 검증은 레포에 0개** — `infra/rust/docker-compose.rust.yml`을 읽는 스크립트는 `scripts/verify_openapi_contract_rust.sh`뿐이고 그것은 자기 env로 base 파일만 쓴다. (참고: 그 계약 테스트는 현재 어떤 게이트 스크립트에도 배선돼 있지 않다 — `BUILD_TICKETS.md:1772`의 과거 언급이 유일한 참조.)

---

## 6. buzz 기준선 대조 (block/buzz `main`, 2026-08-09 pushed · 실측)

### 6-1. 축별 대조표

| 축 | block/buzz | oort 라이브 경로 | 판정 |
|---|---|---|---|
| **웹 자산 배치** | **이미지에 굽는다** — `Dockerfile:145-146` `COPY --from=web-builder /build/web/dist /srv/buzz/web` + `ENV BUZZ_WEB_DIR=/srv/buzz/web`. relay 컨테이너가 WS·REST·웹 UI를 직접 서빙 | **이미지 밖.** 로컬 `npm run build` → tar → 호스트 bind mount | **GAP (정면 패배)** |
| **배포 번들 완결성** | `deploy/compose/` 에 프로덕션 일습이 커밋됨: `compose.yml`(relay·postgres·redis·minio·minio-init) · `compose.caddy.yml`(TLS 오버레이) · **`Caddyfile`** · `.env.example`(52줄) · `run.sh`(133줄) | compose 5개 중 **2개만** 레포. caddy 서비스 정의·origin 허용목록·T3 스위치는 서버 전용 | **GAP** |
| **퍼블리시된 이미지** | `ghcr.io/block/buzz` **공개·익명 pull 가능, 3,036 태그**. compose 기본값이 그 이미지를 **pull**(`build:` 키 0건) | 레지스트리 이미지 **0개**. `publish-images.yml` 실행 **0회**. `docker save`/`load` | **GAP** |
| **멀티아치** | `linux/amd64` + `linux/arm64` OCI index. 네이티브 러너 2대 → by-digest push → `buildx imagetools create` 병합. QEMU 미사용 | `publish-images.yml`은 **arm64 단독**(라이브 호스트는 amd64) — 돌았더라도 못 쓴다 | **GAP** |
| **공급망 증적** | SLSA provenance 첨부, `gh attestation verify oci://ghcr.io/block/buzz:<tag> --owner block` 로 검증 | 워크플로에 `provenance: mode=max`·`sbom: true` **선언은 있으나 실행 0회** → 실효 없음 | **GAP** |
| **버전 pin 가능성** | semver 태그(`0.2.1`/`0.2`/`0`/`latest`, 동일 digest) + `sha-<7>` 1,260개 + `debug-*` 계열 | 서버용 릴리스·태그·레지스트리 전무. 라이브 식별자는 서버 `docker ps` 안에만 | **GAP** |
| **마이그레이션 모델** | 바이너리 내장 `sqlx::migrate!`(28개 SQL), `BUZZ_AUTO_MIGRATE` 게이트, **PG advisory lock**으로 다중 replica 경합 안전, `buzz-admin migrate` 수동 경로 | 별도 one-shot `migrate` 컨테이너, 이미지 내장 SQL 59개, `runtime-roles` 선행 fail-closed, `MIGRATE_IDEMPOTENCY_CHECK` 2회차 검증 | **PASS (동급 이상)** |
| **fail-closed 설정 규율** | `${VAR:?set VAR}` 가드 + `run.sh:29`가 `CHANGE_ME` 잔존 시 하드 실패 | 동일한 `${VAR:?}` 규율 — **다만 템플릿이 불완전해 규율이 사용자를 막는다**(§3) | **부분 GAP** |
| **렌더 검증** | `./run.sh config` — 공유 전 자가검증 레시피가 README에 명문화 | 라이브 5파일 조합을 렌더하는 게이트 **0개**(§5-3) | **GAP** |
| **Day-2 운영 래퍼** | `run.sh`: `start`/`upgrade`/`status`/`config`/`add-member`/`list-members`/`backup-hint` | `momo-ops.sh`·`upgrade.sh` 존재하나 **Swift 경로 전용** — Rust 라이브에 대응물 없음 | **GAP** |
| **K8s 경로** | Helm 차트 2종(17 템플릿·`values.schema.json`·`helm unittest` 10 스위트), OCI 퍼블리시 | 없음 | GAP (2층·범위 결정 사항) |
| **성숙도 자기선언** | 리포 custom property `maturity: prototype`, 별 25,484 | — | 참고 |

### 6-2. buzz도 완벽하지 않다 (격차 크기의 눈금)

기준선을 과대평가하지 않기 위해 buzz 쪽 실측 결함도 기록한다:

- **부트스트랩 스크립트가 없다.** `deploy/compose/README.md`와 `run.sh:24`가 두 곳에서 "곧 나올 bootstrap script"를 참조하지만 `deploy/`·`scripts/` 어디에도 없다 → 사람이 `CHANGE_ME` **8개**를 손으로 채워야 한다. **"원커맨드 프로덕션 배포"는 buzz에도 없다.**
- **기본값이 움직이는 표적을 가리킨다.** compose 기본 `BUZZ_IMAGE=ghcr.io/block/buzz:main`(롤링), README는 "semver는 나오면 pin하라"고 적었지만 semver는 이미 나와 있다(문서 stale). Helm 차트 `appVersion: 0.1.0` vs relay 실제 `0.2.1` — 차트 기본값이 두 마이너 뒤를 pin한다.
- 백업은 스크립트가 아니라 `./run.sh backup-hint`(체크리스트 출력)뿐.
- compose 번들은 S3 엔드포인트를 `http://minio:9000`으로 고정 — 외부 S3는 `.env`로 불가(README 자백).

**따라서 격차의 정확한 크기는 이렇다:** buzz는 "완성된 배포 제품"이 아니라 **「레포만 있으면 서버를 세울 수 있는 상태」**다. oort는 그 선 아래에 있다 — buzz의 미완성 항목(부트스트랩 자동화·문서 stale)은 *편의*의 결함이고, oort의 결함(파일 3개 부재·이미지 부재·웹 이미지 밖)은 *가능성*의 결함이다. buzz를 클론한 사람은 손으로 8칸 채우고 뜨지만, oort를 클론한 사람은 손으로 채울 칸이 어디인지조차 알 수 없다.

### 6-3. 가장 뼈아픈 한 지점

buzz와 oort는 **같은 설계 질문에 정반대로 답했고, oort는 과거에 buzz와 같은 답을 갖고 있었다.**

- buzz: 웹 dist를 relay 이미지에 굽는다 → 이미지 하나를 pin하면 서버·웹이 함께 따라온다.
- oort **Swift** 경로: `web-init` 서비스가 이미지 번들 dist를 `momo-web-static` 볼륨으로 복사(`infra/prod/docker-compose.prod.yml:44-46, :339`) → 같은 답.
- oort **Rust**(라이브) 경로: 그 서비스를 잃고 tar 파이프 + bind mount + inode 함정 경고로 대체.

즉 이 격차는 "아직 못 만든 것"이 아니라 **가지고 있다가 잃은 것**이다.

---

## 7. 서버측 읽기 전용 덤프 명령 목록 (성재 `!` 대행용 — 실행하지 않았음)

> **설계 원칙: 어떤 명령도 시크릿 *값*을 출력하지 않는다.** env 파일은 `cut -d= -f1`로 **키 이름만**, compose는 `config --services`/`--images`로 **이름만**, 파일은 `ls`/`sha256sum`으로 **존재와 해시만**. `docker inspect`의 `.Config.Env`, `cat *.secrets.env`, `docker compose config`(전체 렌더) 는 **의도적으로 제외**했다 — 전부 값을 뱉는다.

서버: `root@101.79.11.189` (`/opt/momo/infra/rust`)

```bash
# ── B-1. 서버 위 배포 파일 실목록 (레포화 대상 확정) ─────────────────────
ls -la /opt/momo/infra/rust/
sha256sum /opt/momo/infra/rust/*.yml /opt/momo/infra/rust/Caddyfile

# ── B-2. 레포에 없는 3개 오버레이의 "구조"만 (값 없이) ───────────────────
#   YAML의 키 경로만 뽑는다. 값이 붙는 줄은 키만 남기고 잘라낸다.
for f in t3.override.yml caddy.override.yml cent-origin.override.yml; do
  echo "### $f"
  sed -E 's/:[[:space:]].*$/:/' /opt/momo/infra/rust/$f | grep -vE '^\s*#'
done
#   ↑ 이 출력이 곧 "레포화 diff"다. 값이 진짜 비밀인 줄만 성재가 마스킹하면 된다.

# ── B-3. 라이브 env 키셋 (이름만, 값 절대 미출력) ────────────────────────
cut -d= -f1 /opt/momo/infra/rust/smoke.secrets.env       | grep -vE '^\s*(#|$)' | sort
cut -d= -f1 /opt/momo/infra/rust/push-relay.secrets.env  | grep -vE '^\s*(#|$)' | sort
#   예외 1줄 — 이 값만 비밀이 아니고 판정에 필수(배포 태그):
grep '^MOMO_RUST_IMAGE=' /opt/momo/infra/rust/smoke.secrets.env
ls -la /opt/momo/infra/rust/smoke.secrets.env.bak-*      # 롤백 지점 존재 확인

# ── B-4. 실제로 떠 있는 것 (이름·이미지·상태만) ─────────────────────────
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
docker compose --env-file smoke.secrets.env --env-file push-relay.secrets.env \
  -f docker-compose.rust.yml -f docker-compose.push.yml -f t3.override.yml \
  -f caddy.override.yml -f cent-origin.override.yml config --services
docker compose --env-file smoke.secrets.env --env-file push-relay.secrets.env \
  -f docker-compose.rust.yml -f docker-compose.push.yml -f t3.override.yml \
  -f caddy.override.yml -f cent-origin.override.yml config --images
#   ↑ --services/--images 는 서비스명·이미지 ref만 출력한다(값 노출 없음).

# ── B-5. 마운트 실태 (경로만) ───────────────────────────────────────────
docker ps -q | xargs -r docker inspect \
  --format '{{.Name}}{{range .Mounts}}  [{{.Type}}] {{.Source}} -> {{.Destination}} ro={{.RO}}{{end}}'
#   ↑ .Config.Env 는 일부러 안 읽는다.

# ── B-6. 웹 아티팩트 정체 (§4 격차 실증) ────────────────────────────────
ls -la /opt/momo/web/ | head -20
ls /opt/momo/web/assets/ | grep -E '^index-' 
sha256sum /opt/momo/web/index.html
stat -c '%y %n' /opt/momo/web/index.html    # 웹/API 배포 시각 분리 여부
#   → 라이브 번들 해시(index-Dp1ym0h8)를 로컬 `npm run build` 결과와 대조하면
#     웹이 어느 커밋인지 처음으로 확정된다(현재 in-band 방법 없음, B-10).

# ── B-7. 이미지 재고·롤백 여지 ─────────────────────────────────────────
docker images --format 'table {{.Repository}}\t{{.Tag}}\t{{.CreatedAt}}\t{{.Size}}' \
  | grep -Ei 'momo|caddy|centrifugo|pgvector|postgres'
docker image inspect momo-rust:6bfc9b82 \
  --format '{{.Id}} {{.Architecture}}/{{.Os}} {{.Created}}'
#   ↑ Architecture 확인 = §5의 arm64/amd64 불일치 실증.

# ── B-8. Caddy 설정 드리프트 (레포 Caddyfile == 라이브인가) ─────────────
sha256sum /opt/momo/infra/rust/Caddyfile
#   로컬: git show origin/track/engine:infra/rust/Caddyfile | shasum -a 256
docker compose ... exec caddy caddy validate --config /etc/caddy/Caddyfile
curl -sI https://app.oor7.com | grep -iE 'content-security|strict-transport|x-content-type|referrer|frame'
#   ↑ 마지막 줄은 밖에서 — #1213 배포 여부 확인(레포엔 있으나 미배포일 수 있음).

# ── B-9. 마이그레이션 실행 모델 실증 ────────────────────────────────────
docker compose ... logs migrate --tail 40 | grep -E 'APPLY|applied=|IDEMPOTENCY'
docker compose ... ps -a --format 'table {{.Service}}\t{{.State}}\t{{.ExitCode}}'

# ── B-10. 디스크 (런북이 82%라 적어둔 자리) ─────────────────────────────
df -h /
docker system df
```

**출력 취급**: B-2의 키 경로 출력만 「레포화 diff」로 그대로 쓸 수 있다. 나머지는 판정 근거일 뿐 커밋 대상이 아니다. `smoke.secrets.env`의 값은 위 목록 어디서도 출력되지 않는다(`MOMO_RUST_IMAGE` 한 줄 예외 — 이미지 태그는 비밀이 아니며 배포 상태 판정에 필수).

---

## 8. 레포화 필요 항목 표 (우선순위)

| 순위 | 항목 | 산출물 | 선행 | 참고 선례 |
|---|---|---|---|---|
| 1 | `caddy.override.yml` · `cent-origin.override.yml` · `t3.override.yml` → `infra/rust/` | 파일 3개(도메인·이메일은 env 변수화) | §7 B-2 덤프 | buzz `deploy/compose/compose.caddy.yml` |
| 2 | `rust-smoke.env.example` 완결화 | `PROVIDER_LINK_MASTER_KEY` 추가 + 라이브 키셋 전체 반영 | §7 B-3 덤프 | buzz `deploy/compose/.env.example`(52줄, 프로덕션 전용본 분리) |
| 3 | 웹을 배포 아티팩트로 | 이미지에 `dist` COPY + `MOMO_WEB_DIR` **또는** web-init 서비스 부활 | 결정 필요 | buzz `Dockerfile:145-146`; oort Swift `web-init`(자기 선례) |
| 4 | 라이브 이미지 퍼블리시 레인 | **amd64 필수** · Rust Dockerfile · 레지스트리 · digest pin | 과금 이슈(축 D) | buzz `docker.yml` 네이티브 러너 2대 → imagetools 병합 |
| 5 | 라이브 5파일 조합 렌더 게이트 | `config --services` 스모크 + `CHANGE_ME` 잔존 하드 실패 | 1·2 완료 후 | buzz `run.sh:24-29` + README 자가검증 레시피 |
| 6 | 버전 스탬핑 | `/v1/version` or 빌드 SHA 주입(웹·API) | — | buzz semver+`sha-<7>` 이중 태그 |
| 7 | Rust 경로 Day-2 래퍼 | `momo-ops.sh`의 Rust 대응(start/upgrade/status/config) | 1·2 | buzz `run.sh` |

---

## 9. 성재 결정 대기

- 셀프호스트를 **지원 범위로 선언**할 것인가(선언하면 §5-2의 README 경로가 즉시 부채가 된다), 아니면 라이브 1대 운영만인가.
- 레지스트리 선택(GHCR 재개 / 다른 곳 / 계속 `docker save`).
- Swift 배포 경로(`infra/prod/**` 30파일 + `install.sh` + `momo-ops.sh` + `upgrade.sh` + `publish-images.yml` + 계약 테스트)를 **은퇴시킬지 유지할지** — 유지하면 두 경로를 계속 관리해야 하고, 은퇴하면 README·DEPLOY.md 재작성이 따라온다.
