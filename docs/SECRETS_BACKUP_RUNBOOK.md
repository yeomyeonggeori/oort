# oort Secret And Backup Runbook

> Scope: MOMO-006 locks the safe operating contract and file skeleton for
> SOPS+age secrets and pgBackRest PITR. It does not include real production
> secrets, age private keys, object-store credentials, or a live PITR rehearsal.
> Until a real staging host, SOPS recipients, and backup repository exist,
> backup restore remains `runtime-unverified`. MOMO-007 adds a local smoke gate
> that validates this checklist without decrypting or requiring real secrets.

## 0. Files

| Path | Purpose | Commit? |
|---|---|---|
| `.sops.yaml.example` | SOPS creation-rule template with placeholder age recipients. | yes |
| `infra/prod/secrets.env.example` | Plaintext shape for staging/prod secrets. Contains placeholders only. | yes |
| `infra/prod/secrets.env` | Temporary plaintext filled by the operator before encryption. | no |
| `infra/prod/secrets.sops.env` | Real encrypted secret file created by SOPS. | yes, after real recipients exist |
| `infra/prod/pgbackrest.conf.example` | Non-secret pgBackRest stanza/repository skeleton. | yes |
| `infra/prod/postgresql.pgbackrest.conf.example` | PostgreSQL WAL archive settings for PITR. | yes |
| `infra/prod/pgbackrest-cron.example` | Backup/check schedule skeleton. | yes |

## 1. Hard Rules

- Never commit production secret values, age private identities, object-store
  keys, decrypted env files, pgBackRest cipher passphrases, or cloud credentials.
- Commit encrypted `*.sops.env|yaml|json` files only after `.sops.yaml` contains
  real public recipients and decryption is tested by the operator.
- `infra/.env.example` and code `dev-insecure-*` defaults are development-only.
  Staging/prod must use generated values from `infra/prod/secrets.sops.env`.
- `scripts/prod_env_preflight.sh --mode staging|prod|internal-host` must pass
  before compose config/render/up on a real host. It rejects placeholder,
  dev-insecure, localhost/mock, and internal-smoke image values.
- The same preflight also requires an explicit secret source (`SECRET_SOURCE`),
  named DB/Redis volume intent, and pgBackRest/WAL/PITR acknowledgement env:
  `PGBACKREST_STANZA`, `PGBACKREST_REPO1_PATH`,
  `PGBACKREST_REPO1_CIPHER_PASS`, `PGBACKREST_WAL_ARCHIVE_REQUIRED`,
  `PGBACKREST_STANZA_CHECK_REQUIRED`, `PGBACKREST_FULL_BACKUP_REQUIRED`, and
  `PGBACKREST_PITR_REHEARSAL_REQUIRED`.
- `internal-smoke`/`local` placeholder values are allowed only in
  `infra/prod/internal-smoke.env.example` and verifier-generated temp env files.
- Prefer process environment injection (`sops exec-env`) over decrypted files.
  If a service manager needs an env file, render it to tmpfs with `0600` mode and
  delete it during rollback/rotation.
- A backup is not considered verified until restore rehearsal evidence exists.
  Repo-local evidence may prove the local dump/restore path; production
  pgBackRest/PITR remains `runtime-unverified(public host)` until a separate
  host/volume restore rehearsal proves stanza, WAL archive, and target-time
  recovery.

## 2. SOPS + age Setup

Install tools on the operator or deployment host:

```sh
brew install sops age
# or on Ubuntu/Debian hosts:
# sudo apt-get install sops age
```

Generate an age identity outside the repo. This path is explicit so macOS and
Linux hosts can share one documented convention:

```sh
install -d -m 700 "$HOME/.config/sops/age"
age-keygen -o "$HOME/.config/sops/age/keys.txt"
chmod 600 "$HOME/.config/sops/age/keys.txt"
export SOPS_AGE_KEY_FILE="$HOME/.config/sops/age/keys.txt"
```

Copy `.sops.yaml.example` to `.sops.yaml`, replace the placeholder recipients
with the public `age1...` recipient(s), and commit `.sops.yaml` with the first
real encrypted secret file. `.sops.yaml` contains public keys only.

Create and encrypt the staging/prod secret file:

```sh
cp infra/prod/secrets.env.example infra/prod/secrets.env
$EDITOR infra/prod/secrets.env

sops --encrypt \
  --input-type dotenv \
  --output-type dotenv \
  infra/prod/secrets.env > infra/prod/secrets.sops.env

rm -f infra/prod/secrets.env
```

Validate without printing secret values:

```sh
sops --decrypt infra/prod/secrets.sops.env >/dev/null
sops exec-env infra/prod/secrets.sops.env \
  'test -n "$POSTGRES_PASSWORD" && test -n "$JWT_HMAC" && test -n "$PGBACKREST_REPO1_CIPHER_PASS"'
sops exec-env infra/prod/secrets.sops.env \
  'scripts/prod_env_preflight.sh --from-env --mode staging --evidence-dir /tmp/momo-public-preflight'
```

Deploy commands consume the decrypted values as process environment. MOMO-005
will add the actual prod compose file; the contract is:

```sh
sops exec-env infra/prod/secrets.sops.env \
  'docker compose -f infra/prod/docker-compose.prod.yml up -d'

sops exec-env infra/prod/secrets.sops.env 'make migrate'
```

Operator checklist before `up -d` on staging/prod/internal-host:

1. Generate each secret with `openssl rand -hex 32` or the upstream provider.
2. Replace every `__PLACEHOLDER__`, `change-me-*`, `example.com`, local DB
   password, mock Hermes URL, and `internal-smoke` image tag.
3. Encrypt to `infra/prod/secrets.sops.env`, delete plaintext, then confirm
   `git status` does not show `infra/prod/secrets.env` or decrypted files.
4. Run `sops exec-env infra/prod/secrets.sops.env 'scripts/prod_env_preflight.sh --from-env --mode staging --evidence-dir /tmp/momo-public-preflight'`.
5. Only after preflight passes, render compose config and start services.

Preflight evidence files are redacted Markdown/JSON. They prove the public host
env shape and required backup/PITR acknowledgements, not that DNS/TLS,
registry pull, SOPS decrypt, or pgBackRest restore actually ran.

Rotate a secret by editing through SOPS, redeploying, and invalidating the old
credential at the source:

```sh
sops infra/prod/secrets.sops.env
sops exec-env infra/prod/secrets.sops.env \
  'docker compose -f infra/prod/docker-compose.prod.yml up -d'
```

When adding/removing operators, update `.sops.yaml` recipients and run:

```sh
sops updatekeys infra/prod/secrets.sops.env
```

## 3. pgBackRest PITR Setup

Install pgBackRest on the database host or in the PostgreSQL image used by
MOMO-005. The exact package path is host-specific, but the resulting command
must be available to the `postgres` user.

Create directories with restrictive ownership:

```sh
sudo install -d -m 770 -o postgres -g postgres /var/log/pgbackrest
sudo install -d -m 750 -o postgres -g postgres /var/lib/pgbackrest
sudo install -d -m 750 /etc/pgbackrest
```

Render the config. Keep `repo1-cipher-pass` out of the committed file; provide
it from `PGBACKREST_REPO1_CIPHER_PASS` in SOPS or a root-owned tmpfs env file.

```sh
sudo install -m 640 -o postgres -g postgres \
  infra/prod/pgbackrest.conf.example /etc/pgbackrest/pgbackrest.conf
```

Before enabling archiving, verify the data directory and update `pg1-path`:

```sh
sops exec-env infra/prod/secrets.sops.env \
  'psql "$DATABASE_URL" -Atc "SHOW data_directory;"'
```

Apply `infra/prod/postgresql.pgbackrest.conf.example` to the active
`postgresql.conf`, then restart PostgreSQL. Create and check the stanza:

```sh
sops exec-env infra/prod/secrets.sops.env \
  'sudo --preserve-env=PGBACKREST_REPO1_CIPHER_PASS -u postgres pgbackrest --stanza=momo stanza-create'

sops exec-env infra/prod/secrets.sops.env \
  'sudo --preserve-env=PGBACKREST_REPO1_CIPHER_PASS -u postgres pgbackrest --stanza=momo check'
```

Run the first full backup, then confirm machine-readable info is healthy:

```sh
sops exec-env infra/prod/secrets.sops.env \
  'sudo --preserve-env=PGBACKREST_REPO1_CIPHER_PASS -u postgres pgbackrest --stanza=momo --type=full backup'

sops exec-env infra/prod/secrets.sops.env \
  'sudo --preserve-env=PGBACKREST_REPO1_CIPHER_PASS -u postgres pgbackrest --stanza=momo info --output=json'
```

Install `infra/prod/pgbackrest-cron.example` only after the first manual full
backup and `check` pass.

## 4. PITR Rehearsal

Do not test PITR on the primary data directory. Use a separate restore host,
throwaway volume, or isolated compose project.

### 4.1 Repo-local restore rehearsal gate

Before internal test hosting, run the local backup profile and attach the
generated markdown/json evidence to the PR or handoff. This is not a substitute
for production pgBackRest PITR; it proves the repo-local operating contract:
take a backup from one temporary PostgreSQL 18 database, restore into a separate
temporary database, compare marker fingerprints, and leave evidence.

```sh
scripts/verify_backup_restore_rehearsal.sh
scripts/local_gate.sh --profile backup
```

Evidence files are written under `$BACKUP_REHEARSAL_OUT_DIR`,
`$LOCAL_GATE_OUT_DIR`, or `$TMPDIR/momo-backup-rehearsal` and include:

- source/restore container names and data directories;
- marker timestamp and source/restore fingerprints;
- dump file path, byte size, and sha256;
- repo-local coverage and explicit `runtime-unverified(public host)` gaps.

The same verifier is included in `scripts/local_gate.sh --profile host-runtime`
so internal host-runtime smoke cannot pass while backup restore evidence is
missing.

### 4.2 Host pgBackRest PITR rehearsal

1. Record a UTC target time after a known marker write.
2. Stop PostgreSQL in the restore environment and empty only the restore data
   directory.
3. Run restore to the target time.
4. Start PostgreSQL and verify the marker state.

```sh
TARGET_UTC="2026-06-26 09:00:00+00"

sops exec-env infra/prod/secrets.sops.env \
  'sudo --preserve-env=PGBACKREST_REPO1_CIPHER_PASS -u postgres pgbackrest --stanza=momo --type=time --target="'"$TARGET_UTC"'" --target-action=promote restore'
```

Record the evidence in the PR or staging handoff:

```md
## PITR Evidence
- stanza-create:
- pgbackrest check:
- full backup label:
- target UTC:
- restore host/volume:
- verification query:
- result:
```

## 5. Current MOMO-006 Status

This repo now has the SOPS/age and pgBackRest contract plus skeleton files. The
MOMO-007 staging smoke gate verifies the file contract, and MOMO-222 adds a
repo-local restore rehearsal verifier with:

```sh
scripts/verify_staging_smoke.sh
scripts/local_gate.sh --profile staging-smoke
scripts/local_gate.sh --profile backup
```

The actual encrypted secret file, off-host backup repository, and PITR rehearsal
are intentionally not included because they require real staging/prod
infrastructure and secrets.

Repo-local verified by `backup`: temporary PostgreSQL dump/restore, marker
fingerprint equality, markdown/json evidence generation. `runtime-unverified`:
pgBackRest stanza creation, WAL archive push, full/diff schedule, object-store
repository, SOPS secret decrypt, and time-target PITR restore rehearsal on a
public host.

## 6. References

- SOPS docs: https://getsops.io/docs/
- SOPS age identity docs: https://getsops.io/docs/usage/identities/age/
- SOPS config file docs: https://getsops.io/docs/usage/identities/config-file/
- age: https://github.com/FiloSottile/age
- pgBackRest user guide: https://pgbackrest.org/user-guide.html
