#!/usr/bin/env bash
# =============================================================================
# scripts/security_pack.sh — 공개 CI 「Security pack」 레인 (#4241, SEC-03)
#
#   lint      DB 없이: 선택 목록(infra/security-pack/selection.txt)이 실제 시험을 가리키는지
#             (파일 존재·#[ignore] 존재·여섯 영역 모두 ≥1·중복 없음). 빈 선택이 초록이 되는 것을 막는다.
#   list      선택된 `패키지 타깃` 쌍을 출력.
#   setup     DATABASE_URL(슈퍼유저)에 마이그레이션 + bootstrap_roles.sql 적용.
#   run       선택 시험을 `--ignored --test-threads=1` 로 실행. 타깃마다 `N passed`(N>0)·failed 0 을 요구한다.
#   negative  일회용 DB 에 FORCE 없는 테넌트 테이블 픽스처를 얹고 tenant_catalog_pg 가
#             **그 테이블을 이름으로 지목하며** 빨강인지 확인한다(다른 이유의 빨강은 실패).
#   nightly   선택 밖 PG 시험까지 전부(`--workspace --ignored`) — 야간 잡용. 시험 실행 파일마다 새 DB(템플릿 복제,
#             scripts/nightly_target_db.sh)에서 돌아 타깃 간 오염이 없다. 끝에 요약(report)을 낸다.
#   report    야간 로그를 읽어 요약(markdown)·실패 시험 상세·격리 현황을 낸다.
#             `report <전량 로그> <prod_role 로그> <격리 로그>` — DB·cargo 없이 돌아서 시험할 수 있다.
#
# 야간 격리 (#4707): **야간이 초록이어야 그 시험이 있는 것이다.** 아무도 지키지 않는 `#[ignore]`
#   시험을 늘리지 않는다. 지금 못 고치는 시험은 infra/security-pack/nightly-quarantine.txt 에
#   `패키지 타깃 시험 #소유이슈 기한 사유` 로 올린다. 전량 실행에서는 빠지지만(--skip) 따로 계속 돌려
#   결과를 요약에 보이고, 목록이 비어 있지 않으면 야간 요약·경고 주석에 늘 보이며, 기한이 지나면
#   야간이 빨강이 된다(기한은 오늘부터 60일을 넘길 수 없다). 형식 검사는 PR 게이트(lint)가 한다.
#
# 환경: SECURITY_PACK_SELECTION(기본 infra/security-pack/selection.txt),
#       SECURITY_PACK_QUARANTINE(기본 infra/security-pack/nightly-quarantine.txt),
#       SECURITY_PACK_ROOT(기본 레포 루트, 시험 편의), SECURITY_PACK_OUT(로그 디렉터리),
#       SECURITY_PACK_TODAY(YYYY-MM-DD, 기한 판정용 오늘 — 시험 편의),
#       SECURITY_PACK_TARGET_DB(0 이면 야간도 한 DB 에서 전부 — 진단·시험 편의, 기본 1),
#       SECURITY_PACK_MIN_PASSED(전량 실행 통과 하한, 기본 1200 — 빈 초록 방지. 2026-10-28 실측 1,855개),
#       DATABASE_URL, PSQL_BIN. 시크릿은 출력하지 않는다(DB URL은 로그에 안 찍는다).
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ROOT="${SECURITY_PACK_ROOT:-$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)}"
SELECTION="${SECURITY_PACK_SELECTION:-$ROOT/infra/security-pack/selection.txt}"
OUT="${SECURITY_PACK_OUT:-${TMPDIR:-/tmp}/security-pack}"
MANIFEST="$ROOT/server-rust/Cargo.toml"
REQUIRED_DOMAINS="tenant-isolation auth approval push attachment webhook"
NEG_TABLE="sec03_negative_unforced"

die() { echo "[security-pack] $*" >&2; exit 1; }

# 선택 목록의 유효 줄(`영역 패키지 타깃`)만.
entries() { grep -Ev '^[[:space:]]*(#|$)' "$SELECTION"; }

QUARANTINE="${SECURITY_PACK_QUARANTINE:-$ROOT/infra/security-pack/nightly-quarantine.txt}"
QUARANTINE_MAX_DAYS=60
MIN_PASSED="${SECURITY_PACK_MIN_PASSED:-1200}"

# 격리 목록의 유효 줄(`패키지 타깃 시험 #이슈 기한 사유…`)만. 파일이 없으면 격리가 없는 것이다.
quarantine_entries() {
  [ -f "$QUARANTINE" ] || return 0
  grep -Ev '^[[:space:]]*(#|$)' "$QUARANTINE" || true
}

# YYYY-MM-DD → UTC 자정의 에포크 초(GNU·BSD date 모두). 형식이 틀리면 실패.
date_epoch() {
  printf '%s' "$1" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' || return 1
  date -u -d "$1 00:00:00" +%s 2>/dev/null \
    || date -u -j -f '%Y-%m-%d %H:%M:%S' "$1 00:00:00" +%s 2>/dev/null
}
epoch_date() { date -u -d "@$1" +%Y-%m-%d 2>/dev/null || date -u -r "$1" +%Y-%m-%d 2>/dev/null; }
today_epoch() { date_epoch "${SECURITY_PACK_TODAY:-$(date -u +%Y-%m-%d)}"; }

# 패키지 이름 → 크레이트 디렉터리 (server-rust 아래 Cargo.toml 의 name 으로 찾는다).
package_dir() {
  local pkg="$1" f
  for f in "$ROOT"/server-rust/bins/*/Cargo.toml "$ROOT"/server-rust/crates/*/Cargo.toml; do
    [ -e "$f" ] || continue
    if grep -Eq "^name[[:space:]]*=[[:space:]]*\"$pkg\"" "$f"; then
      dirname "$f"; return 0
    fi
  done
  return 1
}

cmd_lint() {
  [ -f "$SELECTION" ] || die "선택 목록이 없어요: $SELECTION"
  local seen="" domains="" n=0 domain pkg test dir file key
  while read -r domain pkg test extra; do
    [ -z "${extra:-}" ] || die "열이 3개를 넘어요: $domain $pkg $test $extra"
    [ -n "$test" ] || die "열이 모자라요: '$domain $pkg'"
    case " $REQUIRED_DOMAINS " in *" $domain "*) ;; *) die "알 수 없는 영역: $domain" ;; esac
    key="$pkg/$test"
    case " $seen " in *" $key "*) die "중복 항목: $key" ;; esac
    seen="$seen $key"
    dir="$(package_dir "$pkg")" || die "패키지를 찾을 수 없어요: $pkg"
    file="$dir/tests/$test.rs"
    [ -f "$file" ] || die "시험 파일이 없어요: ${file#"$ROOT"/}"
    # `--ignored` 로 0개를 돌리고 초록이 되는 것을 막는다.
    grep -Eq '#\[ignore' "$file" || die "#[ignore] 시험이 없어요(--ignored 가 0개를 실행해요): ${file#"$ROOT"/}"
    case " $domains " in *" $domain "*) ;; *) domains="$domains $domain" ;; esac
    n=$((n + 1))
  done < <(entries)
  for domain in $REQUIRED_DOMAINS; do
    case " $domains " in *" $domain "*) ;; *) die "영역에 시험이 하나도 없어요: $domain" ;; esac
  done
  echo "[security-pack] lint OK: ${n}개 타깃, 영역 6/6"
  cmd_quarantine_lint
}

# 야간 격리 목록 검사(#4707). 형식·존재·기한 상한만 본다 — **만료는 여기서 보지 않는다**(만료는 야간만 빨강,
# 그렇지 않으면 기한이 지난 날 모든 Rust PR 이 막힌다).
cmd_quarantine_lint() {
  local n=0 seen="" pkg target tname owner deadline reason dir file key e today hits
  today="$(today_epoch)" || die "오늘 날짜를 해석할 수 없어요: ${SECURITY_PACK_TODAY:-}"
  while read -r pkg target tname owner deadline reason; do
    [ -n "${reason:-}" ] || die "격리 열이 모자라요(패키지 타깃 시험 #이슈 기한 사유): '$pkg $target ${tname:-}'"
    [ "${#reason}" -ge 10 ] || die "격리 사유가 너무 짧아요(왜 못 고치는지 적어요): $pkg/$target $tname"
    printf '%s' "$tname" | grep -Eq '^[A-Za-z0-9_]+$' || die "격리 시험 이름은 함수 이름 하나여야 해요: '$tname'"
    printf '%s' "$owner" | grep -Eq '^#[0-9]+$' || die "격리 소유 이슈는 #번호여야 해요: $pkg/$target $tname → '$owner'"
    e="$(date_epoch "$deadline")" && [ "$(epoch_date "$e")" = "$deadline" ] \
      || die "격리 기한이 올바른 날짜(YYYY-MM-DD)가 아니에요: $pkg/$target $tname → '$deadline'"
    [ $(((e - today) / 86400)) -le "$QUARANTINE_MAX_DAYS" ] \
      || die "격리 기한이 오늘부터 ${QUARANTINE_MAX_DAYS}일을 넘어요(끝없는 격리 금지): $pkg/$target $tname → $deadline"
    key="$pkg/$target/$tname"
    case " $seen " in *" $key "*) die "격리 중복 항목: $key" ;; esac
    seen="$seen $key"
    dir="$(package_dir "$pkg")" || die "격리: 패키지를 찾을 수 없어요: $pkg"
    file="$dir/tests/$target.rs"
    [ -f "$file" ] || die "격리: 시험 파일이 없어요: ${file#"$ROOT"/}"
    grep -Eq '#\[ignore' "$file" || die "격리: #[ignore] 시험이 없어요(야간 --ignored 가 돌리지 않는 파일): ${file#"$ROOT"/}"
    grep -Eq "fn[[:space:]]+${tname}[[:space:]]*\(" "$file" \
      || die "격리: ${file#"$ROOT"/} 에 시험 함수가 없어요(이름이 바뀌었나요?): $tname"
    # 보안 주장의 증거(proofs·sabotage.evidence)는 격리할 수 없다 — 격리하면 문서의 주장이 조용히 약해진다.
    if [ -f "$ROOT/docs/security/claims.yaml" ] && grep -Fq "tests/$target.rs#$tname" "$ROOT/docs/security/claims.yaml"; then
      die "격리: 보안 주장(docs/security/claims.yaml)의 증거 시험은 격리할 수 없어요: $pkg/$target $tname"
    fi
    # --skip 은 부분 문자열이라 이름이 다른 시험(또 다른 파일의 같은 이름 함수 포함)에도 맞으면 그 시험까지
    # 조용히 빠진다 → 정의 하나에만 맞아야 한다(그래서 중복 제거(sort -u)를 하지 않는다).
    hits="$(grep -rhoE --exclude-dir=target --include='*.rs' "fn[[:space:]]+[A-Za-z0-9_]*${tname}[A-Za-z0-9_]*[[:space:]]*\(" "$ROOT/server-rust" | wc -l | tr -d ' ')"
    [ "$hits" = 1 ] || die "격리: 시험 이름 '$tname' 이(가) 워크스페이스의 함수 ${hits}개와 맞아요(정확히 1개여야 해요)"
    n=$((n + 1))
  done < <(quarantine_entries)
  echo "[security-pack] quarantine lint OK: ${n}건"
}

cmd_list() { entries | while read -r _d pkg test; do echo "$pkg $test"; done; }

psql_bin() {
  if [ -n "${PSQL_BIN:-}" ]; then echo "$PSQL_BIN"; elif command -v psql >/dev/null 2>&1; then command -v psql; else die "psql 이 없어요"; fi
}

# $1 = 대상 DB URL. 마이그레이션 + 역할 부트스트랩.
setup_db() {
  local url="$1" psql
  psql="$(psql_bin)"
  DATABASE_URL="$url" PSQL_BIN="$psql" sh "$ROOT/scripts/migrate.sh"
  "$psql" "$url" -v ON_ERROR_STOP=1 -q -f "$ROOT/infra/rust/sql/bootstrap_roles.sql"
}

cmd_setup() {
  [ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL(슈퍼유저)이 필요해요"
  setup_db "$DATABASE_URL"
}

# 일부 시험은 사설 PG 클라이언트(psql)를 PGHOST·PGPORT·PGUSER·PGPASSWORD·PGDATABASE 로 띄운다
# (tool_grants_conformance_pg 등). 설정되지 않은 값만 DATABASE_URL 에서 채운다. 값은 출력하지 않는다.
export_pg_env() {
  local url="$1" rest cred hostport
  rest="${url#*://}"; cred="${rest%%@*}"; rest="${rest#*@}"
  hostport="${rest%%/*}"
  export PGUSER="${PGUSER:-${cred%%:*}}" PGPASSWORD="${PGPASSWORD:-${cred#*:}}"
  export PGHOST="${PGHOST:-${hostport%%:*}}" PGPORT="${PGPORT:-${hostport##*:}}"
  rest="${rest#*/}"; export PGDATABASE="${PGDATABASE:-${rest%%\?*}}"
}

# $1=패키지 $2=타깃 $3=로그. 통과 개수(N)를 stdout 으로.
run_target() {
  local pkg="$1" test="$2" log="$3" line passed failed
  export_pg_env "$DATABASE_URL"
  cargo test --locked --manifest-path "$MANIFEST" -p "$pkg" --test "$test" -- --ignored --test-threads=1 >"$log" 2>&1 \
    || { tail -n 40 "$log" >&2; die "빨강: $pkg/$test (전체 로그: $log)"; }
  line="$(grep -E '^test result: ' "$log" | tail -n 1)"
  passed="$(printf '%s' "$line" | sed -E 's/.* ([0-9]+) passed.*/\1/')"
  failed="$(printf '%s' "$line" | sed -E 's/.* ([0-9]+) failed.*/\1/')"
  case "$passed:$failed" in *[!0-9:]*|:*|*:) die "결과 줄을 해석할 수 없어요: $pkg/$test" ;; esac
  [ "$failed" = 0 ] || die "failed=$failed: $pkg/$test"
  [ "$passed" -gt 0 ] || die "0개를 실행했어요(빈 초록): $pkg/$test"
  echo "$passed"
}

# 측정용 출력(#4696). ok 줄의 `seconds` 는 cargo 한 번(컴파일·링크 + 시험 실행)의 합이라 「준비」와 「시험」이
# 안 갈렸다. cargo 가 로그에 남기는 두 시간을 덧붙여 CI 로그만으로 대상별 고정비를 읽게 한다:
# build = `Finished … in`(컴파일·링크, `1m 02s` 꼴도 초로), run = libtest `finished in`(시험 실행).
# 어느 쪽도 판정에 쓰지 않는다. 못 찾으면 `?`.
log_build_secs() {
  local v
  v="$(sed -nE 's/^[[:space:]]*Finished .* in (([0-9]+)m )?([0-9.]+)s$/\2 \3/p' "$1" 2>/dev/null \
    | tail -n 1 | awk 'NF == 2 { print $1 * 60 + $2; next } NF == 1 { print $1 }')" || true
  echo "${v:-?}"
}
log_run_secs() {
  local v
  v="$(sed -nE 's/^test result: .* finished in ([0-9.]+)s$/\1/p' "$1" 2>/dev/null | tail -n 1)" || true
  echo "${v:-?}"
}

cmd_run() {
  cmd_lint
  [ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL(슈퍼유저)이 필요해요"
  mkdir -p "$OUT"
  local total=0 targets=0 start now t0 pkg test n log
  start="$(date +%s)"
  while read -r _d pkg test; do
    t0="$(date +%s)"
    log="$OUT/$pkg.$test.log"
    n="$(run_target "$pkg" "$test" "$log")"
    total=$((total + n)); targets=$((targets + 1))
    echo "[security-pack] ok $pkg/$test passed=$n seconds=$(( $(date +%s) - t0 )) build=$(log_build_secs "$log") run=$(log_run_secs "$log")"
  done < <(entries)
  now="$(date +%s)"
  echo "[security-pack] PASS targets=$targets tests=$total seconds=$((now - start))"
}

# DATABASE_URL 의 DB 이름만 바꾼 URL.
url_with_db() { printf '%s' "${DATABASE_URL%/*}/$1"; }

cmd_negative() {
  [ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL(슈퍼유저)이 필요해요"
  local url log
  NEG_PSQL="$(psql_bin)"; NEG_DB="sec03_negative_$$"; url="$(url_with_db "$NEG_DB")"
  mkdir -p "$OUT"; log="$OUT/negative.log"
  "$NEG_PSQL" "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $NEG_DB"
  trap '"$NEG_PSQL" "$DATABASE_URL" -q -c "DROP DATABASE IF EXISTS $NEG_DB" >/dev/null 2>&1 || true' EXIT
  setup_db "$url"
  "$NEG_PSQL" "$url" -v ON_ERROR_STOP=1 -q -f "$ROOT/infra/security-pack/negative/unforced_tenant_table.sql"
  if DATABASE_URL="$url" cargo test --locked --manifest-path "$MANIFEST" -p momo-db --test tenant_catalog_pg -- --ignored --test-threads=1 >"$log" 2>&1; then
    tail -n 30 "$log" >&2
    die "음성 대조 실패: FORCE 없는 테넌트 테이블이 있는데 tenant_catalog_pg 가 초록이에요"
  fi
  grep -Fq "public.$NEG_TABLE: RLS is not FORCEd" "$log" \
    || { tail -n 30 "$log" >&2; die "빨강이지만 'public.$NEG_TABLE: RLS is not FORCEd' 를 지목하지 않았어요 — 다른 이유의 빨강일 수 있어요"; }
  echo "[security-pack] negative OK: tenant_catalog_pg 가 $NEG_TABLE 의 FORCE 누락을 지목하며 빨강"
}

# ── 야간 ──────────────────────────────────────────────────────────────────────
# libtest 로그의 통과·실패 합계. 출력: "통과 실패".
sum_results() {
  [ -f "$1" ] || { echo "0 0"; return 0; }
  awk '/^test result: /{for(i=2;i<=NF;i++){if($i=="passed;")p+=$(i-1); if($i=="failed;")f+=$(i-1)}} END{print p+0, f+0}' "$1"
}

# `error: N targets failed:` 아래의 `-p 패키지 --test 타깃` 줄들.
failed_targets() {
  [ -f "$1" ] || return 0
  awk '/^error: [0-9]+ targets? failed:/{f=1; next} f&&/^[[:space:]]+`-p /{print; next} f{f=0}' "$1"
}

# 실패한 시험과 첫 패닉 메시지를 타깃별로(--no-fail-fast 로그). 타깃 이름은 cargo 가 실패 뒤에 찍는
# `error: test failed, to rerun pass `-p 패키지 --test 타깃`` 줄에서 가져온다.
failure_digest() {
  [ -f "$1" ] || return 0
  awk '
    function flush(label,   i, k) {
      if (nf == 0) return
      printf "- `%s` — 실패 %d개\n", label, nf
      for (i = 1; i <= nf; i++) {
        printf "  - `%s`", fn[i]
        if (fn[i] in msg) printf " — `%s`", msg[fn[i]]
        printf "\n"
      }
      nf = 0
      for (k in msg) delete msg[k]
    }
    /^test .* \.\.\. FAILED$/ { fn[++nf] = $2; next }
    /^---- .* stdout ----$/ { cur = $2; next }
    /^thread .* panicked at / {
      if (cur != "" && !(cur in msg)) {
        loc = $0; sub(/^thread .* panicked at /, "", loc)
        if (loc ~ /:$/) { sub(/:$/, "", loc); nxt = ""; getline nxt; loc = loc ": " nxt }
        gsub(/`/, "\047", loc)
        if (length(loc) > 240) loc = substr(loc, 1, 240) "…"
        msg[cur] = loc
      }
      next
    }
    /^error: test failed, to rerun pass / {
      l = $0; sub(/^error: test failed, to rerun pass `/, "", l); sub(/`.*$/, "", l)
      flush(l); cur = ""; next
    }
    END { flush("(타깃 미상)") }
  ' "$1"
}

# 격리 시험 하나의 이번 결과: 통과 | 빨강 | 안 돎.
quarantine_status() { # <시험> <격리 로그>
  [ -s "$2" ] || { echo "안 돎"; return 0; }
  if grep -Eq "^test [A-Za-z0-9_:]*$1 \.\.\. ok$" "$2"; then echo "통과"
  elif grep -Eq "^test [A-Za-z0-9_:]*$1 \.\.\. FAILED$" "$2"; then echo "빨강"
  else echo "안 돎"; fi
}

# 야간 요약. 인자: <전량 로그> <prod_role 로그> <격리 로그>. markdown 을 stdout 과 $GITHUB_STEP_SUMMARY 에
# 쓰고, 격리·만료·실패는 GitHub 주석(::warning/::error)으로도 낸다.
# 종료 코드: 0 = 전량·별도 실행이 깨끗하고 격리 기한이 안 지남, 1 = 그 밖(빈 초록·로그 없음 포함).
cmd_report() {
  local main_log="${1:-}" role_log="${2:-}" quar_log="${3:-}"
  local rc=0 p=0 f=0 rp=0 rf=0 ft digest md="" nq=0 nexp=0 now e days status pkg target tname owner deadline reason rows="" verdict
  read -r p f <<<"$(sum_results "$main_log")"
  read -r rp rf <<<"$(sum_results "$role_log")"
  ft="$(failed_targets "$main_log")"
  digest="$(failure_digest "$main_log")"
  now="$(today_epoch)" || die "오늘 날짜를 해석할 수 없어요: ${SECURITY_PACK_TODAY:-}"

  if [ ! -s "$main_log" ]; then verdict="빨강 — 전량 로그가 없어요"; rc=1
  elif [ "$f" -gt 0 ] || [ -n "$ft" ]; then verdict="빨강 — 실패 ${f}개"; rc=1
  elif grep -Eq '^error(\[E[0-9]+\])?: (could not compile|test failed)' "$main_log"; then verdict="빨강 — 컴파일 또는 실행 오류"; rc=1
  elif [ "$p" -lt "$MIN_PASSED" ]; then verdict="빨강 — 통과가 ${p}개뿐이에요(하한 ${MIN_PASSED}, 빈 초록 방지)"; rc=1
  else verdict="초록"; fi

  md="## 야간 PG 시험 전량 (security-nightly)"$'\n\n'
  md="${md}- 기준 커밋: \`${GITHUB_SHA:-로컬}\`"$'\n'
  md="${md}- 전량 실행(\`--workspace --ignored\`): **${verdict}** — 통과 ${p} · 실패 ${f}"$'\n'
  if [ ! -s "$role_log" ]; then md="${md}- 따로 도는 \`prod_role_conformance_pg\`: **빨강 — 로그가 없어요**"$'\n'; rc=1
  elif [ "$rf" -gt 0 ] || [ "$rp" -eq 0 ]; then md="${md}- 따로 도는 \`prod_role_conformance_pg\`: **빨강** — 통과 ${rp} · 실패 ${rf}"$'\n'; rc=1
  else md="${md}- 따로 도는 \`prod_role_conformance_pg\`: **초록** — 통과 ${rp}"$'\n'; fi

  while read -r pkg target tname owner deadline reason; do
    [ -n "${tname:-}" ] || continue
    nq=$((nq + 1))
    e="$(date_epoch "$deadline")" || e="$now"
    days=$(((e - now) / 86400))
    status="$(quarantine_status "$tname" "$quar_log")"
    if [ "$e" -lt "$now" ]; then nexp=$((nexp + 1)); days="${days}일 — **기한 지남**"; else days="${days}일 남음"; fi
    [ "$status" = "통과" ] && status="통과 — 목록에서 뺄 수 있어요"
    rows="${rows}| \`${pkg}/${target}\` \`${tname}\` | ${owner} | ${deadline} (${days}) | ${status} | ${reason//|//} |"$'\n'
  done < <(quarantine_entries)
  if [ "$nq" -gt 0 ]; then
    md="${md}- 격리: **${nq}건**(기한 지남 ${nexp}건) — 아래 표. 지키지 않는 시험이 아니라 이름·소유 이슈·기한이 있는 격리예요."$'\n\n'
    md="${md}### 격리(전량 실행에서 뺀 시험)"$'\n\n'"| 시험 | 소유 이슈 | 기한 | 이번 결과(따로 실행) | 사유 |"$'\n'"|---|---|---|---|---|"$'\n'"${rows}"
  else
    md="${md}- 격리: 없음"$'\n'
  fi
  if [ -n "$ft" ] || [ -n "$digest" ]; then
    md="${md}"$'\n'"### 실패한 타깃과 시험"$'\n\n'"${digest:-$ft}"$'\n'
  fi

  printf '%s\n' "$md"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then printf '%s\n' "$md" >>"$GITHUB_STEP_SUMMARY"; fi
  if [ -d "$OUT" ]; then printf '%s\n' "$md" >"$OUT/nightly-summary.md"; fi
  if [ "$nq" -gt 0 ]; then
    echo "::warning title=야간 격리 시험 ${nq}건::이름·소유 이슈·기한이 있는 격리예요. 목록: infra/security-pack/nightly-quarantine.txt (기한 지남 ${nexp}건)"
  fi
  if [ "$nexp" -gt 0 ]; then
    echo "::error title=야간 격리 기한이 지났어요::${nexp}건 — 고치거나, 사유를 바꿔 기한을 다시 정하거나(리뷰 필요) 시험을 지워요"
    rc=1
  fi
  if [ "$rc" -ne 0 ]; then
    echo "::error title=야간 PG 시험 빨강::${verdict} — 요약과 '실패한 타깃과 시험' 참고"
  fi
  return "$rc"
}

# 격리 시험을 따로 돈다 — 결과는 요약에만 쓰고 종료 코드에는 영향이 없다. 전량 실행 뒤에 돌아서 격리 시험이
# 남기는 잔여물이 야간 결과에 닿지 않는다. 한 묶음은 20분을 넘기지 않는다.
with_cap() { local secs="$1"; shift; if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; else "$@"; fi; }
nightly_quarantine_pass() {
  local groups pkg target filters
  : >"$OUT/nightly-quarantine.log"
  groups="$(quarantine_entries | awk '{print $1" "$2}' | sort -u)"
  [ -n "$groups" ] || return 0
  while read -r pkg target; do
    filters="$(quarantine_entries | awk -v p="$pkg" -v t="$target" '$1==p && $2==t {printf "%s ", $3}')"
    echo "##### $pkg/$target $filters" >>"$OUT/nightly-quarantine.log"
    # shellcheck disable=SC2086
    with_cap 1200 cargo test --locked --manifest-path "$MANIFEST" -p "$pkg" --test "$target" -- --ignored --test-threads=1 $filters \
      >>"$OUT/nightly-quarantine.log" 2>&1 || true
  done <<<"$groups"
}

# ── 타깃마다 새 DB (#4707) ────────────────────────────────────────────────────
# 야간 전량은 273개 실행 파일을 한 DB 에서 차례로 돌려서, 앞 타깃이 남긴 것(대기 작업·DDL 찌꺼기·테이블 팽창)이
# 뒤 타깃을 깼다. setup 이 끝난 DB 를 템플릿으로 한 번 복제해 두고, scripts/nightly_target_db.sh 를 cargo 실행기
# (`CARGO_TARGET_<TRIPLE>_RUNNER`)로 걸어 `#[ignore]` 시험이 있는 실행 파일마다 그 복제본을 새로 준다.
# SECURITY_PACK_TARGET_DB=0 이면 예전처럼 한 DB 에서 전부 돈다(진단·시험 편의).
NIGHTLY_TEMPLATE="nt_template"
nightly_admin() { # <SQL> — 접속 DB 와 같은 서버의 postgres DB 로 실행
  local base="${DATABASE_URL%%\?*}" query
  query="${DATABASE_URL#"$base"}"
  "$(psql_bin)" "${base%/*}/postgres${query}" -qAt -v ON_ERROR_STOP=1 -c "$1" >/dev/null
}
nightly_target_db_setup() {
  local triple var curdb
  triple="$(rustc -vV | sed -n 's/^host: //p')"
  [ -n "$triple" ] || die "rustc 호스트 트리플을 알 수 없어요"
  var="CARGO_TARGET_$(printf '%s' "$triple" | tr 'a-z-' 'A-Z_')_RUNNER"
  curdb="${DATABASE_URL##*/}"; curdb="${curdb%%\?*}"
  nightly_admin "DROP DATABASE IF EXISTS \"$NIGHTLY_TEMPLATE\" WITH (FORCE)"
  nightly_admin "CREATE DATABASE \"$NIGHTLY_TEMPLATE\" TEMPLATE \"$curdb\" ALLOW_CONNECTIONS false" \
    || die "템플릿 DB 를 만들 수 없어요('$curdb' 에 다른 연결이 있나요?)"
  export NIGHTLY_DB_TEMPLATE="$NIGHTLY_TEMPLATE" PSQL_BIN
  PSQL_BIN="$(psql_bin)"
  export "$var=$SCRIPT_DIR/nightly_target_db.sh"
  echo "[security-pack] 시험 실행 파일마다 새 DB 에서 돌려요(템플릿 $NIGHTLY_TEMPLATE ← $curdb, 실행기 $var)"
}
nightly_target_db_teardown() { nightly_admin "DROP DATABASE IF EXISTS \"$NIGHTLY_TEMPLATE\" WITH (FORCE)" 2>/dev/null || true; }

cmd_nightly() {
  [ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL(슈퍼유저)이 필요해요"
  cmd_quarantine_lint
  mkdir -p "$OUT"
  export_pg_env "$DATABASE_URL"
  local rc=0 skips t quarantined=""
  # momo-blind-pty/tests/loopback.rs 는 PG 시험이 아니라 성능 측정이다(#4696). PR CI 에서 빼며 `#[ignore]` 가
  # 됐고 perf-nightly.yml 이 릴리스 빌드로 돌린다. 여기서는 건너뛰기만 한다(디버그 빌드로 164초를 또 쓰지 않는다).
  skips=" --skip handshake_echo_latency_and_reconnect_over_loopback_tcp"
  if [ "${SECURITY_PACK_TARGET_DB:-1}" != 0 ]; then
    nightly_target_db_setup
    trap nightly_target_db_teardown EXIT
  fi
  # prod_role_conformance_pg 는 cluster-global 역할 비밀번호를 재설정해 이후 타깃을 오염시킨다.
  # 1) 그 타깃의 시험만 건너뛰고 나머지 전량을 돌린 뒤, 2) 마지막 순서로 따로 돌린다.
  for t in every_notifier_job_iteration_runs_as_its_production_role \
           a_hosted_work_run_push_and_run_status_trigger_run_as_the_notifier_role \
           the_run_stall_and_ledger_retention_sweeps_do_real_work_as_their_production_roles; do
    skips="$skips --skip $t"
  done
  # 격리 시험은 전량 실행에서 뺀다(이름이 함수 하나에만 맞는다는 것은 lint 가 보장한다). 아래에서 따로 돌린다.
  # shellcheck disable=SC2046
  for t in $(quarantine_entries | awk '{print $3}'); do
    skips="$skips --skip $t"; quarantined="$quarantined $t"
  done
  [ -z "$quarantined" ] || echo "[security-pack] 격리 시험은 전량 실행에서 빼고 따로 돌려요:$quarantined"
  # shellcheck disable=SC2086
  cargo test --locked --manifest-path "$MANIFEST" --workspace --no-fail-fast -- --ignored --test-threads=1 $skips \
    >"$OUT/nightly.log" 2>&1 || rc=1
  cargo test --locked --manifest-path "$MANIFEST" -p momo-notifier --test prod_role_conformance_pg -- --ignored --test-threads=1 \
    >"$OUT/nightly-prod-role.log" 2>&1 || rc=1
  nightly_quarantine_pass
  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    # 원문은 접어서 남긴다(요약이 놓친 것을 사람이 볼 수 있게). 시험은 가짜 자격증명만 쓰고 비밀을 찍지 않는다.
    for t in nightly.log nightly-prod-role.log nightly-quarantine.log; do
      echo "::group::$t 전문"; cat "$OUT/$t"; echo "::endgroup::"
    done
  fi
  cmd_report "$OUT/nightly.log" "$OUT/nightly-prod-role.log" "$OUT/nightly-quarantine.log" || rc=1
  return "$rc"
}

case "${1:-}" in
  lint) cmd_lint ;;
  list) cmd_list ;;
  setup) cmd_setup ;;
  run) cmd_run ;;
  negative) cmd_negative ;;
  nightly) cmd_nightly ;;
  report) shift; cmd_report "$@" ;;
  *) die "usage: scripts/security_pack.sh {lint|list|setup|run|negative|nightly|report}" ;;
esac
