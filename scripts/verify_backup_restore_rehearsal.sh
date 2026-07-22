#!/usr/bin/env bash
# Repo-local backup/restore rehearsal gate for MOMO-222.
#
# This intentionally does not touch a primary data directory or production
# pgBackRest repository. It proves the local backup contract by taking a dump
# from one ephemeral PostgreSQL 18 container, restoring it into a separate
# ephemeral container, and writing machine-readable restore evidence.
set -euo pipefail

OUT_DIR="${BACKUP_REHEARSAL_OUT_DIR:-${LOCAL_GATE_OUT_DIR:-${TMPDIR:-/tmp}/momo-backup-rehearsal}}"
POSTGRES_IMAGE="${POSTGRES_IMAGE:-pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7352b9e9f4798df5fd9a498f043f4cda1cdacc707de3d198650f4321e}"
POSTGRES_DB="${POSTGRES_DB:-momo}"
POSTGRES_USER="${POSTGRES_USER:-momo}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-momo-restore-rehearsal}"

mkdir -p "$OUT_DIR"

RUN_RANDOM="$(uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -d '-' | cut -c1-10)"
if [ -z "$RUN_RANDOM" ]; then
  RUN_RANDOM="$(date -u +%s)-$$"
fi
RUN_ID="$(date -u +"%Y%m%dT%H%M%SZ")-$RUN_RANDOM"
SRC_CONTAINER="momo_restore_src_$RUN_RANDOM"
DST_CONTAINER="momo_restore_dst_$RUN_RANDOM"
DUMP_FILE="$OUT_DIR/momo-backup-restore-$RUN_ID.dump"
JSON_FILE="$OUT_DIR/momo-backup-restore-$RUN_ID.json"
MD_FILE="$OUT_DIR/momo-backup-restore-$RUN_ID.md"
STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

cleanup() {
  docker rm -f "$SRC_CONTAINER" "$DST_CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

wait_for_pg() {
  local container="$1"
  local attempt=0
  until docker exec "$container" pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 60 ]; then
      echo "postgres did not become ready in $container" >&2
      docker logs "$container" >&2 || true
      exit 1
    fi
    sleep 1
  done
}

psql_exec() {
  local container="$1"
  shift
  docker exec -i "$container" psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 "$@"
}

marker_query() {
  local container="$1"
  psql_exec "$container" -At <<'SQL'
SELECT count(*)::text || '|' ||
       md5(string_agg(id::text || ':' || marker, ',' ORDER BY id)) || '|' ||
       min(created_at AT TIME ZONE 'UTC')::text || '|' ||
       max(created_at AT TIME ZONE 'UTC')::text
FROM restore_rehearsal_marker;
SQL
}

need docker
need python3

echo "backup/restore rehearsal run_id=$RUN_ID"
echo "evidence_dir=$OUT_DIR"

docker run -d \
  --name "$SRC_CONTAINER" \
  -e POSTGRES_DB="$POSTGRES_DB" \
  -e POSTGRES_USER="$POSTGRES_USER" \
  -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  "$POSTGRES_IMAGE" >/dev/null
wait_for_pg "$SRC_CONTAINER"

SOURCE_DATA_DIR="$(psql_exec "$SRC_CONTAINER" -Atc "SHOW data_directory;")"
MARKER_UTC="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
psql_exec "$SRC_CONTAINER" >/dev/null <<SQL
CREATE TABLE restore_rehearsal_marker (
  id integer PRIMARY KEY,
  marker text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO restore_rehearsal_marker (id, marker, created_at) VALUES
  (1, 'momo-restore-rehearsal:$RUN_ID:alpha', '$MARKER_UTC'),
  (2, 'momo-restore-rehearsal:$RUN_ID:bravo', '$MARKER_UTC'),
  (3, 'momo-restore-rehearsal:$RUN_ID:charlie', '$MARKER_UTC');
SQL

SOURCE_FINGERPRINT="$(marker_query "$SRC_CONTAINER")"
docker exec "$SRC_CONTAINER" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$DUMP_FILE"

docker run -d \
  --name "$DST_CONTAINER" \
  -e POSTGRES_DB="$POSTGRES_DB" \
  -e POSTGRES_USER="$POSTGRES_USER" \
  -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  "$POSTGRES_IMAGE" >/dev/null
wait_for_pg "$DST_CONTAINER"

RESTORE_DATA_DIR="$(psql_exec "$DST_CONTAINER" -Atc "SHOW data_directory;")"
docker exec -i "$DST_CONTAINER" pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner < "$DUMP_FILE"
RESTORE_FINGERPRINT="$(marker_query "$DST_CONTAINER")"

if [ "$SOURCE_FINGERPRINT" != "$RESTORE_FINGERPRINT" ]; then
  echo "restore fingerprint mismatch" >&2
  echo "source:  $SOURCE_FINGERPRINT" >&2
  echo "restore: $RESTORE_FINGERPRINT" >&2
  exit 1
fi

if [ "$SRC_CONTAINER:$SOURCE_DATA_DIR" = "$DST_CONTAINER:$RESTORE_DATA_DIR" ]; then
  echo "restore appears to use the same data directory; refusing to pass" >&2
  exit 1
fi

DUMP_BYTES="$(wc -c < "$DUMP_FILE" | tr -d '[:space:]')"
DUMP_SHA256="$(shasum -a 256 "$DUMP_FILE" | awk '{ print $1 }')"
FINISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

export RUN_ID STARTED_AT FINISHED_AT POSTGRES_IMAGE SRC_CONTAINER DST_CONTAINER
export SOURCE_DATA_DIR RESTORE_DATA_DIR MARKER_UTC SOURCE_FINGERPRINT RESTORE_FINGERPRINT
export DUMP_FILE DUMP_BYTES DUMP_SHA256

python3 - "$JSON_FILE" "$MD_FILE" <<'PY'
import json
import os
import pathlib
import sys

json_path = pathlib.Path(sys.argv[1])
md_path = pathlib.Path(sys.argv[2])
evidence = {
    "result": "PASS",
    "goal": "MOMO-222",
    "run_id": os.environ["RUN_ID"],
    "started_at_utc": os.environ["STARTED_AT"],
    "finished_at_utc": os.environ["FINISHED_AT"],
    "postgres_image": os.environ["POSTGRES_IMAGE"],
    "source_container": os.environ["SRC_CONTAINER"],
    "restore_container": os.environ["DST_CONTAINER"],
    "source_data_dir": os.environ["SOURCE_DATA_DIR"],
    "restore_data_dir": os.environ["RESTORE_DATA_DIR"],
    "marker_utc": os.environ["MARKER_UTC"],
    "source_fingerprint": os.environ["SOURCE_FINGERPRINT"],
    "restore_fingerprint": os.environ["RESTORE_FINGERPRINT"],
    "dump_file": os.environ["DUMP_FILE"],
    "dump_bytes": int(os.environ["DUMP_BYTES"]),
    "dump_sha256": os.environ["DUMP_SHA256"],
    "repo_local_coverage": [
        "ephemeral PostgreSQL 18 source database boot",
        "marker writes before backup",
        "pg_dump custom-format backup",
        "separate ephemeral restore database boot",
        "pg_restore into non-primary restore target",
        "marker count/checksum equality after restore",
        "markdown/json restore evidence generation",
    ],
    "not_covered": [
        "production pgBackRest stanza-create/check/full backup",
        "WAL archive push and time-target PITR",
        "SOPS production secret decrypt",
        "public host object-store backup repository",
        "destructive restore on any primary data directory",
    ],
}
json_path.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")
md_path.write_text(
    "\n".join([
        "## Backup / Restore Rehearsal Evidence",
        f"- Result: `{evidence['result']}`",
        f"- Goal: `{evidence['goal']}`",
        f"- Run ID: `{evidence['run_id']}`",
        f"- Started: `{evidence['started_at_utc']}`",
        f"- Finished: `{evidence['finished_at_utc']}`",
        f"- PostgreSQL image: `{evidence['postgres_image']}`",
        f"- Source container: `{evidence['source_container']}`",
        f"- Restore container: `{evidence['restore_container']}`",
        f"- Source data dir: `{evidence['source_data_dir']}`",
        f"- Restore data dir: `{evidence['restore_data_dir']}`",
        f"- Marker UTC: `{evidence['marker_utc']}`",
        f"- Source fingerprint: `{evidence['source_fingerprint']}`",
        f"- Restore fingerprint: `{evidence['restore_fingerprint']}`",
        f"- Dump file: `{evidence['dump_file']}`",
        f"- Dump bytes: `{evidence['dump_bytes']}`",
        f"- Dump sha256: `{evidence['dump_sha256']}`",
        "- Repo-local coverage:",
        *[f"  - {item}" for item in evidence["repo_local_coverage"]],
        "- Not covered:",
        *[f"  - {item}" for item in evidence["not_covered"]],
        "",
    ]),
    encoding="utf-8",
)
PY

echo "PASS: backup/restore rehearsal"
echo "Evidence JSON: $JSON_FILE"
echo "Evidence markdown: $MD_FILE"
