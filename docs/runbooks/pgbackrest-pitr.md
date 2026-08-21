# PostgreSQL 18 pgBackRest WAL/PITR 운영 런북

> 상태: #1330 구현 정본. 로컬 POSIX repository closed loop는 Docker로 검증한다.
> 실제 NCP host, S3-compatible object storage, 첫 GHCR database image publish/pull은
> 해당 운영 창에서 증거를 다시 만들기 전까지 `runtime-unverified(public host)`다.
> 이 문서는 법률 자문이나 RPO/RTO 보장이 아니다.

## 1. 무엇을 보호하는가

프로덕션 백업은 named volume 복사나 `pg_dump` 성공이 아니라 다음 한 사이클이다.

1. 실행 중인 PostgreSQL 18 source에서 `archive_mode=on`, exact pgBackRest
   `archive_command`, 60초 `archive_timeout`을 확인한다.
2. marker A를 commit하고 encrypted repository에 online full backup을 만든다.
3. backup 종료 뒤 source DB clock에서 recovery target UTC를 잡는다.
4. marker B를 commit하고 강제로 WAL을 전환한 뒤 그 segment가 repository에
   도착했음을 확인한다.
5. source와 다른 새 volume에 target-time restore하고 promote한다.
6. restored DB에서 A=1, B=0, 동일 system identifier, recovery 종료,
   `archive_mode=off`를 확인한다.
7. run-owned container/network/temporary volume과 source probe가 0개 남았음을
   확인한 뒤에만 signed JSON/Markdown/bindings env를 원자적으로 기록한다.

PostgreSQL은 archive command가 실패해도 즉시 write를 막지 않고 `pg_wal`에
재시도 대상을 쌓는다. 그러므로 이 런북의 의미는 “항상 write가 막힌다”가 아니라
“WAL 도착과 실제 복구를 증명하지 못하면 migration이 막힌다”이다.

## 2. 신뢰 경계

- 신뢰: reviewed repo scripts, digest-pinned PostgreSQL+pgBackRest image, exact
  candidate migrate image, Docker daemon/host root, owner-only host secret files.
- 비신뢰: ambient environment, caller path/volume/stanza 값, 예전·복사·편집된
  evidence JSON, mutable image tag, app/relay/worker container, 단순 `PASS` 문자열.
- host root가 DB, Docker daemon, key와 verifier를 동시에 바꾸는 공격은 이
  단일-host 모델이 암호학적으로 막을 수 없다. HMAC은 임의 app process나
  복사된 증거의 위조를 막는 분리 경계이지 root attestation이 아니다.

세 값은 서로 다른 secret이어야 한다.

- pgBackRest repository cipher passphrase
- S3-compatible access key/secret(사용할 때만)
- PITR evidence HMAC key

값을 repo, argv, Compose environment, Docker inspect, JSON/Markdown evidence,
issue/PR/log에 쓰지 않는다. POSIX production host에서는 같은 repository cipher
bytes를 두 owner-scoped mode-0400 파일로 설치한다. archive용 파일은 postgres UID,
migrate 재검증용 파일은 image의 `momo` UID 10001 소유다. Linux에서 서로 다른
UID가 한 owner-only inode를 함께 읽게 하려고 mode를 느슨하게 하지 않는다. HMAC
파일도 UID 10001 소유다. preflight가 symlink, 비정규 파일, CR/LF/NUL, 다중행,
느슨한 mode와 잘못된 owner를 거절하며, evidence HMAC key로 domain-separated
fingerprint를 계산해 두 cipher 복제본이 다르거나 회전 뒤 하나만 갱신되면 migration이
실패한다. 이 fingerprint는 raw secret SHA가 아니므로 HMAC key 없이는 offline secret
oracle로 쓸 수 없다.

## 3. 이미지와 Compose

`infra/rust/postgres-pgbackrest/Dockerfile`은 기존 PG18+pgvector base digest 위에
pgBackRest와 직접 추가 runtime dependency bytes/version/license를 pin한다. 발행된
불변 식별자는 다음 형식만 허용한다.

```text
ghcr.io/yeomyeonggeori/oort-postgres@sha256:<64 lowercase hex>
```

`sha-<gitsha>` tag는 locator일 뿐 불변 식별자가 아니다. 첫 live proof 전
PostgreSQL image/archive 전환과 proof 뒤 migration은 서로 다른 env shape를 쓴다.
`backup-preproof.env`는 placeholder mount path를 포함한 DB-only 전환 파일이며
migrate runner가 거절한다.

NCP의 첫 전환 전에는 root가 다음 host 경계를 한 번 만든다. 아래 UID는 published
images의 고정 postgres/momo UID이며, 기존 파일은 덮어쓰지 않는다. 이미 존재하면
생성 대신 마지막 `stat` 검증만 통과해야 한다.

```bash
(
set -Eeuo pipefail
cd /opt/momo/infra/rust
PITR_ROOT=/run/momo-pitr
MOMO_PGBACKREST_CIPHER_FILE=$PITR_ROOT/pgbackrest-repo1-cipher-pass
MOMO_PITR_HMAC_KEY_FILE=$PITR_ROOT/momo-pitr-hmac-key
MOMO_PITR_EVIDENCE_DIR=/opt/momo/evidence
PGBACKREST_REPO_VOLUME_NAME=momo-rust-pgbackrest-repo
install -d -o root -g root -m 0700 "$PITR_ROOT" "$MOMO_PITR_EVIDENCE_DIR"

create_owner_secret() {
  destination=$1 owner=$2
  [ ! -e "$destination" ] || return 0
  temporary=$(mktemp "$PITR_ROOT/.secret.XXXXXX") || exit 1
  trap 'find "$temporary" -delete 2>/dev/null || true' EXIT
  openssl rand -hex 32 >"$temporary"
  install -o "$owner" -g "$owner" -m 0400 "$temporary" "$destination"
  find "$temporary" -delete
  trap - EXIT
}
create_owner_secret "$MOMO_PGBACKREST_CIPHER_FILE" 999
create_owner_secret "$MOMO_PITR_HMAC_KEY_FILE" 10001
[ "$(stat -c '%u:%a' "$MOMO_PGBACKREST_CIPHER_FILE")" = 999:400 ]
[ "$(stat -c '%u:%a' "$MOMO_PITR_HMAC_KEY_FILE")" = 10001:400 ]
python3 - "$MOMO_PGBACKREST_CIPHER_FILE" "$MOMO_PITR_HMAC_KEY_FILE" <<'PY'
import hmac, os, stat, sys

def read_secret(path: str) -> bytes:
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            raise SystemExit("secret is not a regular file")
        data = os.read(fd, 4098)
        after = os.fstat(fd)
    finally:
        os.close(fd)
    if len(data) > 4097 or before.st_size != len(data):
        raise SystemExit("secret size changed or is too large")
    if (before.st_dev, before.st_ino, before.st_size) != \
       (after.st_dev, after.st_ino, after.st_size):
        raise SystemExit("secret changed while being read")
    payload = data[:-1] if data.endswith(b"\n") else data
    if not (32 <= len(payload) <= 4096) or any(
        byte in payload for byte in (b"\n", b"\r", b"\0")
    ):
        raise SystemExit("secret is not one valid line")
    return payload

if hmac.compare_digest(read_secret(sys.argv[1]), read_secret(sys.argv[2])):
    raise SystemExit("repository cipher and evidence HMAC key must be distinct")
PY

cat >"$PITR_ROOT/backup.env" <<EOF
MOMO_PGBACKREST_CIPHER_FILE=$MOMO_PGBACKREST_CIPHER_FILE
PGBACKREST_REPO_VOLUME_NAME=$PGBACKREST_REPO_VOLUME_NAME
EOF
chmod 0600 "$PITR_ROOT/backup.env"
cp /opt/momo/infra/rust/backup-preproof.env.example "$PITR_ROOT/backup-preproof.env"
chmod 0600 "$PITR_ROOT/backup-preproof.env"

# Compose가 첫 empty-bootstrap에서도 하나의 mount graph를 유지하기 위한
# 빈 placeholder다. Binary는 bootstrap mode에서 이 파일들을 읽지 않는다.
install -o 10001 -g 10001 -m 0600 /dev/null "$PITR_ROOT/preproof-evidence-placeholder.json"
install -o 10001 -g 10001 -m 0400 /dev/null "$PITR_ROOT/preproof-migrate-cipher-placeholder"
install -o 10001 -g 10001 -m 0400 /dev/null "$PITR_ROOT/preproof-hmac-placeholder"

# 1차 출처의 attested digest로 placeholder를 exact 1회 교체한다.
POSTGRES_IMAGE_REF='ghcr.io/yeomyeonggeori/oort-postgres@sha256:<postgres-digest>'
APP_IMAGE_REF='ghcr.io/yeomyeonggeori/oort@sha256:<application-digest>'
python3 - \
  "$PITR_ROOT/backup-preproof.env" smoke.secrets.env \
  "$POSTGRES_IMAGE_REF" "$APP_IMAGE_REF" <<'PY'
import pathlib, re, sys

preproof_path = pathlib.Path(sys.argv[1])
operator_path = pathlib.Path(sys.argv[2])
postgres, app = sys.argv[3:]
if not re.fullmatch(
    r"ghcr\.io/yeomyeonggeori/oort-postgres@sha256:[0-9a-f]{64}",
    postgres,
):
    raise SystemExit("PostgreSQL ref is not a canonical digest")
if not re.fullmatch(
    r"ghcr\.io/yeomyeonggeori/oort@sha256:[0-9a-f]{64}",
    app,
):
    raise SystemExit("application ref is not a canonical digest")

def replace_exact(path: pathlib.Path, key: str, value: str) -> None:
    lines = path.read_text().splitlines()
    hits = [index for index, line in enumerate(lines)
            if line.startswith(key + "=")]
    if len(hits) != 1:
        raise SystemExit(f"expected one {key} binding in {path}")
    lines[hits[0]] = f"{key}={value}"
    path.write_text("\n".join(lines) + "\n")
    path.chmod(0o600)

replace_exact(
    preproof_path,
    "MOMO_POSTGRES_PGBACKREST_IMAGE",
    postgres,
)
replace_exact(operator_path, "MOMO_RUST_IMAGE", app)

# local-smoke defaults are signed-evidence bindings in production.  The
# operator file owns only MOMO_ENV; leaving these keys here would make the
# three-file runner reject an overlap before Docker.
operator_lines = operator_path.read_text().splitlines()
if operator_lines.count("MOMO_ENV=production") != 1:
    raise SystemExit("operator env must contain exact MOMO_ENV=production")
reserved = {
    "MOMO_MIGRATE_ENV",
    "MOMO_PITR_EVIDENCE_REQUIRED",
    "MOMO_PITR_BOOTSTRAP_EMPTY",
}
operator_lines = [
    line for line in operator_lines
    if line.split("=", 1)[0] not in reserved
]
if any(line.split("=", 1)[0] in reserved for line in operator_lines):
    raise SystemExit("operator env still overlaps signed PITR bindings")
operator_path.write_text("\n".join(operator_lines) + "\n")
operator_path.chmod(0o600)
PY

# Attach verifier가 같은 candidate digest를 실제 inspect하므로 둘 다 먼저 받는다.
env -i PATH="$PATH" HOME="$HOME" docker image pull "$APP_IMAGE_REF" || exit 1
env -i PATH="$PATH" HOME="$HOME" docker compose \
  --env-file smoke.secrets.env \
  --env-file "$PITR_ROOT/backup-preproof.env" \
  -f docker-compose.rust.yml -f docker-compose.backup.yml pull postgres || exit 1

# 최초 DB-only 전환. 이 명령에서 migrate나 app을 기동하지 않는다.
env -i PATH="$PATH" HOME="$HOME" docker compose \
  --env-file smoke.secrets.env \
  --env-file "$PITR_ROOT/backup-preproof.env" \
  -f docker-compose.rust.yml -f docker-compose.backup.yml \
  up -d --no-deps --wait postgres || exit 1
)
```

평상시 `backup.env`는 archive cipher path와 repo volume 두 키뿐이고, 나머지는
verifier가 낸 owner-only 19-key bindings가 권위다. Signed proof 이후에는 raw
Compose가 아니라 같은 private snapshot 안에서 검증·migrate·scoped deploy하는
runner만 사용한다.

runner는 Docker daemon 전체에서 고정 이름
`momo-pitr-production-deploy-lock` container를 원자적으로 획득한다. 모든 signed
migrate가 같은 lock을 쓰며, 첫 live lineage 검사부터 마지막 `up --wait`까지
유지하므로 더 새 migration과 더 오래된 app rollout이 교차하지 않는다. 충돌은 SQL
전에 RED다. SIGKILL 뒤 stale lock이 남으면 진행 중인 배포가 없음을 먼저 확인하고,
label `com.momo.pitr.deploy-lock=true`와 immutable container ID를 inspect한 attended
operator만 그 ID를 제거한다. 15분 freshness가 지났다면 기존 proof를 재사용하지 않고
새 attach rehearsal부터 다시 시작한다.

```bash
/opt/momo/scripts/run_pitr_gated_migrate.sh \
  --operator-env /opt/momo/infra/rust/smoke.secrets.env \
  --backup-env /run/momo-pitr/backup.env \
  --bindings-env /opt/momo/evidence/pgbackrest-pitr-<run-id>.env \
  --deploy-production-stack \
  --push-env /opt/momo/infra/rust/push-relay.secrets.env \
  --overlays-env /opt/momo/infra/rust/overlays.secrets.env
```

`docker-compose.backup.yml`은 source `pgdata`, encrypted POSIX
`pgbackrest_repo`, non-secret config와 cipher file을 결속한다. S3-compatible
repository는 `pgbackrest.s3.override.yml`을 추가한다. 그 overlay는 TLS verify와
path-style URI를 고정하고 credential을 exact secret file에서만 읽는다. S3 live
round-trip은 실제 object store가 마련되기 전까지 정적 seam일 뿐이며 POSIX local
E2E를 S3 검증으로 표현하지 않는다.

`pgbackrest.conf`의 `repo1-retention-full`/`repo1-retention-diff`는 이미 생성된
backup의 **보존 정책**일 뿐 full/differential backup을 예약하거나 생성하지 않는다.
이번 goal이 증명하는 것은 continuous WAL + attended full/PITR closed loop다. ADR-0002의
production scheduled full/differential runner와 host timer, 실패 알림은 별도 goal에서
구현·실호스트 검증하기 전까지 `runtime-unverified(schedule)`이며, retention 숫자만으로
scheduled backup을 PASS라고 쓰지 않는다.

## 4. 로컬 closed-loop 증거

로컬 gate는 synthetic owner-only cipher/HMAC key와 run-scoped Docker resources만
사용한다. 실제 운영 secret을 재사용하지 않는다. 로컬 build는 registry digest가
없을 수 있으므로 isolated mode에서만 explicit local tag 두 개를 한 번 image ID로
resolve한 뒤 그 ID만 실행한다. Evidence에는
`runtime-unverified.local-build-id/...@sha256:<image-id>`로 기록되어 public digest와
혼동되지 않는다. Attach mode는 계속 exact OCI `repository@sha256`만 허용한다.

```bash
umask 077
run_id="pitr-$(date -u +%Y%m%dT%H%M%SZ)-local"
evidence_dir="$(mktemp -d "${TMPDIR:-/tmp}/oort-pitr-evidence.XXXXXX")"
cipher_file="$(mktemp "${TMPDIR:-/tmp}/oort-pitr-cipher.XXXXXX")"
hmac_file="$(mktemp "${TMPDIR:-/tmp}/oort-pitr-hmac.XXXXXX")"
openssl rand -hex 32 >"$cipher_file"
openssl rand -hex 32 >"$hmac_file"
chmod 600 "$cipher_file" "$hmac_file"
chmod 700 "$evidence_dir"

scripts/verify_pgbackrest_pitr.sh \
  --mode isolated \
  --run-id "$run_id" \
  --compose-project "momo_pitr_local" \
  --postgres-image-local-tag 'oort-postgres:pitr-local' \
  --candidate-migrate-image-local-tag 'oort:pitr-migrate-local' \
  --git-commit "$(git rev-parse HEAD)" \
  --cipher-secret "$cipher_file" \
  --hmac-key "$hmac_file" \
  --evidence-dir "$evidence_dir"
```

최종 산출물은 `momo-pitr-evidence/v1` JSON, 사람이 읽는 Markdown, migrate가 읽을
owner-only bindings env, 그리고 migrate UID 10001이 읽는 owner-only cipher 복제본
4개다. JSON에는 secret이나 raw secret hash가 없고 run, commit, image
ref/digest/local ID, migration bundle hash, source/restore/repo volume, system
identifier, backup label/LSN/WAL, target/duration, A/B와 cleanup 결과만 있다. cipher
복제본은 archive용 원본과 같은 바이트지만 별도 inode이며, 서명된
`cipher_fingerprint_hmac_sha256`가 둘의 일치와 회전을 결속한다.

## 5. 운영 attach와 migration

운영 verifier는 live source를 stop/recreate하지 않는다. `--mode attach`에서 exact
running source container, Compose project, source/repo volume, image ID를 먼저
Docker inspect와 live DB로 결속하고 restore volume만 run-scoped로 만든다.

```bash
cd /opt/momo/infra/rust
COMPOSE_PROJECT_NAME=momo-rust
DB_VOLUME_NAME=momo-rust-pgdata
PGBACKREST_REPO_VOLUME_NAME=momo-rust-pgbackrest-repo
MOMO_PGBACKREST_CIPHER_FILE=/run/momo-pitr/pgbackrest-repo1-cipher-pass
MOMO_PITR_HMAC_KEY_FILE=/run/momo-pitr/momo-pitr-hmac-key
MOMO_PITR_EVIDENCE_DIR=/opt/momo/evidence
grep -Fxq 'COMPOSE_PROJECT_NAME=momo-rust' smoke.secrets.env
grep -Fxq 'MOMO_ENV=production' smoke.secrets.env
POSTGRES_CONTAINER=$(env -i PATH="$PATH" HOME="$HOME" docker compose \
  --env-file smoke.secrets.env --env-file /run/momo-pitr/backup-preproof.env \
  -f docker-compose.rust.yml -f docker-compose.backup.yml ps -q postgres)
[ -n "$POSTGRES_CONTAINER" ]
[ "$(printf '%s\n' "$POSTGRES_CONTAINER" | wc -l)" -eq 1 ]
docker volume inspect "$DB_VOLUME_NAME" "$PGBACKREST_REPO_VOLUME_NAME" >/dev/null

MOMO_PITR_EXPECT_RUN_ID="pitr-$(date -u +%Y%m%dT%H%M%SZ)-$(openssl rand -hex 8)"
export MOMO_PITR_EXPECT_RUN_ID
POSTGRES_IMAGE_REF='ghcr.io/yeomyeonggeori/oort-postgres@sha256:<postgres-digest>'
CANDIDATE_MIGRATE_IMAGE_REF='ghcr.io/yeomyeonggeori/oort@sha256:<application-digest>'
DEPLOY_GIT_COMMIT=<main의-40hex>
printf '%s\n' "$DEPLOY_GIT_COMMIT" | grep -Eq '^[0-9a-f]{40}$'
printf '%s\n%s\n' "$POSTGRES_IMAGE_REF" "$CANDIDATE_MIGRATE_IMAGE_REF" \
  | grep -E '^ghcr\.io/yeomyeonggeori/oort(-postgres)?@sha256:[0-9a-f]{64}$'

/opt/momo/scripts/verify_pgbackrest_pitr.sh \
  --mode attach \
  --run-id "$MOMO_PITR_EXPECT_RUN_ID" \
  --compose-project "$COMPOSE_PROJECT_NAME" \
  --source-container "$POSTGRES_CONTAINER" \
  --source-volume "$DB_VOLUME_NAME" \
  --repo-volume "$PGBACKREST_REPO_VOLUME_NAME" \
  --postgres-image-ref "$POSTGRES_IMAGE_REF" \
  --candidate-migrate-image-ref "$CANDIDATE_MIGRATE_IMAGE_REF" \
  --git-commit "$DEPLOY_GIT_COMMIT" \
  --cipher-secret "$MOMO_PGBACKREST_CIPHER_FILE" \
  --hmac-key "$MOMO_PITR_HMAC_KEY_FILE" \
  --evidence-dir "$MOMO_PITR_EVIDENCE_DIR" \
  --evidence-owner-uid 10001
```

Attach evidence owner는 image의 migrate UID와 같은 exact `10001`이어야 하며 다른
값이나 생략은 fail-closed한다. 성공한 run이 생성한 `.env`를 같은 attended migration
invocation에 추가한다. 그
파일은 verifier가 검증한 CLI/live 값에서 생성되며 임의 evidence JSON을 다시 읽어
expected 값을 만들지 않는다. `momo-migrate`는 SQL 전에 다음을 모두 재검증한다.
Operator env의 `MOMO_RUST_IMAGE`도 위 `CANDIDATE_MIGRATE_IMAGE_REF`와 같은 immutable
digest여야 runner가 Docker를 호출한다. Repository locator가 달라도 동일 digest는
같은 OCI content identity지만, proof 뒤 tag/다른 digest로 바꿔 최종 기동하는 절차는
허용되지 않는다.

- strict schema + HMAC-SHA256, exact `result=PASS`, unknown/duplicate field 거절
- 완료 후 15분 이내, 미래/시간 순서/duration 오류 없음
- caller가 미리 만든 exact run ID nonce와 40-hex deploy commit
- Compose project, 서로 다른 source/restore/repo volume
- PostgreSQL/migrate digest, candidate migration bytes hash
- live `schema_migrations`의 모든 적용 이력이 candidate migration set에 포함됨
  (더 최신 schema에 예전 image를 올리는 rollback은 SQL 전에 RED)
- stanza `momo`, cipher `aes-256-cbc`, HMAC-bound current cipher fingerprint,
  signed source system identifier와 live query
- full backup label/LSN/WAL, A=1/B=0, archive settings, cleanup leak 0

`production`/`staging` migrate는 signed-evidence mode 또는 진짜 빈 DB bootstrap
중 정확히 하나여야 한다. 첫 install에서만 DB-only 전환 뒤 다음 explicit lifecycle을
실행한다. Preproof env는 앞에서 만든 HMAC/placeholder 경로와 exact PostgreSQL digest를
담고, bootstrap copy만 두 policy flag를 바꾼다.

```bash
cd /opt/momo/infra/rust
cp /run/momo-pitr/backup-preproof.env /run/momo-pitr/bootstrap.env
python3 - /run/momo-pitr/bootstrap.env <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
values = dict(line.split("=", 1) for line in path.read_text().splitlines() if line)
values["MOMO_MIGRATE_ENV"] = "production"
values["MOMO_PITR_EVIDENCE_REQUIRED"] = "0"
values["MOMO_PITR_BOOTSTRAP_EMPTY"] = "1"
path.write_text("".join(f"{key}={values[key]}\n" for key in sorted(values)))
path.chmod(0o600)
PY
clean=(env -i "PATH=$PATH" "HOME=$HOME")
compose=(docker compose --env-file smoke.secrets.env \
  --env-file /run/momo-pitr/bootstrap.env \
  -f docker-compose.rust.yml -f docker-compose.backup.yml)
"${clean[@]}" "${compose[@]}" run --rm --no-deps runtime-roles
"${clean[@]}" "${compose[@]}" run --rm --no-deps migrate
find /run/momo-pitr/bootstrap.env -delete
```

binary는 `schema_migrations`와 public user table이 하나도 없을 때만 bootstrap을
허용한다. 기존 DB에서 이를 다시 실행하면 SQL 전에 실패한다. 그 직후 위 attach
closed loop로 signed evidence를 만들고 production runner를 실행해야만 app services를
올린다. Evidence runner는 bootstrap intent를 받지 않는다. 일반 `migrate`와 직접
`docker compose run --rm --no-deps migrate`는 fresh proof 없이는 똑같이 실패한다.
설정/image 변경 없는 process 재시작만 기존 container ID에 `docker restart`로 수행한다.
Compose 재렌더나 image 변경은 app-only라도 fresh proof와 gated deploy를 다시 거친다.

`scripts/run_pitr_gated_migrate.sh`는 operator env, exact two-key `backup.env`, 위
19-key bindings를 순서대로 읽되 셸로 source하지 않는다. Production deploy mode는
push/overlay env까지 같은 owner-only snapshot에 복사한다. 모든 파일의 duplicate,
reserved image/Compose key, 파일 사이 한 키라도 overlap, owner/mode/symlink 오류,
evidence/HMAC/cipher 불일치가 있으면 Docker 호출 0회로 끝난다. Compose는 `env -i`에서
그 snapshot만 읽고 postgres/runtime-roles/migrate를 final `up`으로 재생성하지 않는다.

## 6. 반드시 RED여야 하는 경우

- repository unavailable/readonly, cipher/HMAC file 누락·다중행·mode/owner 불일치
- `archive_mode=off`, exact archive command/timeout drift, forced WAL 미도착
- restore volume=source/repo, 이미 존재/비어 있지 않음, running 또는 stopped
  container에 mount됨
- `{result:PASS}`뿐인 파일, signature 1-byte tamper, expired/future evidence
- foreign run/commit/cluster/repo/cipher/image/migration bundle
- target을 B 뒤로 옮겨 restored B가 보이는 경우
- plain production migrate 또는 기존 DB에 empty-bootstrap 재사용
- interrupt/failure 뒤 run label container/network/temporary volume 또는 source probe 잔존

## 7. 남은 운영 경계

- 첫 `oort-postgres` GHCR publish, anonymous pull, SBOM/SLSA attestation round-trip
- NCP host에서 actual online full/WAL/time-target restore와 signed migrate
- S3-compatible repository TLS/credential/object round-trip과 scheduled full/differential runner·host timer·실패 알림
- #1332의 전체 redistributed image NOTICE/사람 법무 검토

이 네 항목은 별도 attended evidence 전까지 PASS로 쓰지 않는다.
