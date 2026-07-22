#!/usr/bin/env sh
# Reject duplicate numeric prefixes such as 037_one.sql + 037_two.sql before
# psql sees either file. Numeric normalization also catches 37 vs 037.
set -eu

MIGRATIONS_DIR=${1:-server/Migrations}
if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "[migration-numbers] migrations directory unavailable: $MIGRATIONS_DIR" >&2
  exit 1
fi

TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/momo-migration-numbers.XXXXXX")
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT INT TERM

found=0
for file in "$MIGRATIONS_DIR"/*.sql; do
  [ -e "$file" ] || continue
  found=1
  name=$(basename "$file")
  prefix=${name%%_*}
  case "$name" in
    [0-9]*_*.sql) ;;
    *)
      echo "[migration-numbers] invalid migration filename (expected NNN_name.sql): $name" >&2
      exit 1
      ;;
  esac
  case "$prefix" in
    ''|*[!0-9]*)
      echo "[migration-numbers] invalid numeric prefix: $name" >&2
      exit 1
      ;;
  esac
  normalized=$(awk -v value="$prefix" 'BEGIN { printf "%.0f", value + 0 }')
  printf '%s\t%s\n' "$normalized" "$name" >>"$TMP_ROOT/numbers"
done

if [ "$found" -eq 0 ]; then
  echo "[migration-numbers] no .sql migrations found in $MIGRATIONS_DIR" >&2
  exit 1
fi

cut -f1 "$TMP_ROOT/numbers" | LANG=C sort | uniq -d >"$TMP_ROOT/duplicates"
if [ -s "$TMP_ROOT/duplicates" ]; then
  echo "[migration-numbers] FAIL: duplicate migration number prefix:" >&2
  while IFS= read -r duplicate; do
    awk -F '\t' -v number="$duplicate" '$1 == number { print "  - " $2 }' "$TMP_ROOT/numbers" >&2
  done <"$TMP_ROOT/duplicates"
  exit 1
fi

count=$(wc -l <"$TMP_ROOT/numbers" | tr -d '[:space:]')
echo "[migration-numbers] PASS: $count migration files have unique numeric prefixes"
