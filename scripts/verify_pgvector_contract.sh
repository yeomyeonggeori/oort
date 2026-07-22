#!/usr/bin/env bash
set -euo pipefail

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  echo "[pgvector-contract] FAIL must run inside the repository" >&2
  exit 1
fi
cd "$REPO_ROOT"

IMAGE='pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7352b9e9f4798df5fd9a498f043f4cda1cdacc707de3d198650f4321e'
for compose in infra/docker-compose.yml infra/docker-compose.e2e.yml infra/prod/docker-compose.prod.yml; do
  count="$(grep -Fc "image: $IMAGE" "$compose")"
  if [ "$count" -ne 1 ]; then
    echo "[pgvector-contract] FAIL $compose postgres service image drifted (count=$count)" >&2
    exit 1
  fi
done

for runtime_gate in \
  scripts/verify_runtime_role_bootstrap.sh \
  scripts/verify_prod_seed_password.sh \
  scripts/verify_backup_restore_rehearsal.sh; do
  grep -Fq "$IMAGE" "$runtime_gate" || {
    echo "[pgvector-contract] FAIL $runtime_gate launches a PostgreSQL server without pgvector" >&2
    exit 1
  }
done

MIGRATION=server/Migrations/028_memory_search.sql
for contract in \
  'CREATE EXTENSION IF NOT EXISTS vector' \
  'embedding vector(384)' \
  'GENERATED ALWAYS AS' \
  'USING hnsw (embedding vector_cosine_ops)' \
  'USING gin (tsv)' \
  'CREATE OR REPLACE FUNCTION memory_search_hybrid'; do
  grep -Fq "$contract" "$MIGRATION" || {
    echo "[pgvector-contract] FAIL migration missing: $contract" >&2
    exit 1
  }
done

if grep -Eq 'SECURITY[[:space:]]+DEFINER|BYPASSRLS' "$MIGRATION"; then
  echo "[pgvector-contract] FAIL retrieval must remain SECURITY INVOKER under RLS" >&2
  exit 1
fi

echo "[pgvector-contract] PASS pinned PG18 image + vector/FTS/RRF migration"
