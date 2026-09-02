#!/usr/bin/env bash
# sourced by scripts/oort — SH-3a install verdict. bash 3.2.
# Compose and env files are read-only. Never print secret values.
# Relies on OORT_ROOT from the dispatcher.

oort_doctor_usage() {
  cat <<'EOF'
Usage: scripts/oort doctor [--env FILE] [--json] [--strict]

Read-only self-host verdict (tools, env, stack). Secrets are never printed.

  --env FILE   Env file to inspect (default: infra/rust/local.secrets.env)
  --json       Machine report: {summary, checks[]}
  --strict     Promote major failures to exit 2

Exit: 0 pass, 1 major-only, 2 any blocker.
EOF
}

oort_doctor_sanitize() {
  printf '%s' "$1" | tr '\t\r\n' '   '
}

oort_doctor_trim() {
  printf '%s' "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

oort_doctor_record() {
  local id="$1" severity="$2" status="$3" detail="$4" fix="$5"
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$id" "$severity" "$status" \
    "$(oort_doctor_sanitize "$detail")" \
    "$(oort_doctor_sanitize "$fix")" >>"$OORT_DOCTOR_CHECKS"
}

oort_doctor_generator_keys() {
  awk '
    /^cat >"\$ENV_FILE" <<EOF$/ { grab = 1; next }
    grab && /^EOF$/ { exit }
    grab && /^[A-Za-z_][A-Za-z0-9_]*=/ {
      key = $0
      sub(/=.*/, "", key)
      print key
    }
  ' "$OORT_ROOT/scripts/self_host_env.sh"
}

oort_doctor_file_mode() {
  if stat -f '%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%Lp' "$1"
  else
    stat -c '%a' "$1"
  fi
}

oort_doctor_port_busy() {
  local port="$1"
  (exec 3<>"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1 && { exec 3>&- 3<&-; return 0; }
  return 1
}

oort_doctor_length_class() {
  local n="${#1}"
  if [ "$n" -eq 0 ]; then
    printf 'empty'
  elif [ "$n" -lt 12 ]; then
    printf 'short'
  elif [ "$n" -lt 32 ]; then
    printf 'medium'
  else
    printf 'long'
  fi
}

oort_doctor_hex_verdict() {
  local value="$1"
  if [ -z "$value" ]; then
    printf 'empty'
  elif printf '%s' "$value" | grep -Eq '^[0-9a-fA-F]+$' && [ $((${#value} % 2)) -eq 0 ]; then
    printf 'hex'
  else
    printf 'non-hex'
  fi
}

oort_doctor_has() {
  local key="$1"
  awk -v key="$key" 'index($0, key "=") == 1 { found = 1; exit } END { exit found ? 0 : 1 }' \
    "$OORT_DOCTOR_ENV_NORM"
}

oort_doctor_get() {
  local key="$1"
  awk -v key="$key" 'index($0, key "=") == 1 { print substr($0, length(key) + 2); exit }' \
    "$OORT_DOCTOR_ENV_NORM"
}

oort_doctor_count() {
  local key="$1"
  awk -v key="$key" 'index($0, key "=") == 1 { n += 1 } END { print n + 0 }' \
    "$OORT_DOCTOR_ENV_RAW"
}

oort_doctor_url_password() {
  local url="$1" rest userpass
  case "$url" in
    postgres://* | postgresql://*) ;;
    *) return 1 ;;
  esac
  rest="${url#*://}"
  case "$rest" in
    *@*) ;;
    *) return 1 ;;
  esac
  userpass="${rest%%@*}"
  case "$userpass" in
    *:*) printf '%s' "${userpass#*:}" ;;
    *) return 1 ;;
  esac
}

oort_doctor_url_user() {
  local url="$1" rest userpass
  case "$url" in
    postgres://* | postgresql://*) ;;
    *) return 1 ;;
  esac
  rest="${url#*://}"
  userpass="${rest%%@*}"
  printf '%s' "${userpass%%:*}"
}

oort_doctor_load_env() {
  local src="$1"
  : >"$OORT_DOCTOR_ENV_NORM"
  awk '
    /^[[:space:]]*$/ { next }
    /^[[:space:]]*#/ { next }
    /^[A-Za-z_][A-Za-z0-9_]*=/ { print; next }
  ' "$src" >"$OORT_DOCTOR_ENV_NORM"
}

oort_doctor_skip_stack() {
  local why="$1"
  local fix="스택이 기동 중이 아니다. scripts/self_host_env.sh --compose up -d --wait 로 올린 뒤 다시 실행하라."
  oort_doctor_record stack.compose_ps major skip "$why" "$fix"
  oort_doctor_record stack.healthz blocker skip "$why" "$fix"
  oort_doctor_record stack.agent_port major skip "$why" "$fix"
  oort_doctor_record stack.outbox major skip "$why" "$fix"
  oort_doctor_record stack.migrate_idempotency major skip "$why" "$fix"
}

oort_doctor_skip_public() {
  local why="$1"
  oort_doctor_record public.healthz minor skip "$why" ""
  oort_doctor_record public.websocket minor skip "$why" ""
}

oort_doctor_skip_env_rest() {
  local why="$1"
  local id
  for id in \
    env.mode env.duplicate_keys env.scalars env.required_keys \
    env.bool.doorbell env.bool.hosted_delivery env.bool.unfurl \
    env.platform_admin_emails env.provider_link_master_key \
    env.drive_archive_backend env.centrifugo_ws_url env.role_passwords \
    env.digest env.attestation \
    port.web port.api port.centrifugo
  do
    oort_doctor_record "$id" major skip "$why" \
      "scripts/self_host_env.sh --local-build 또는 --published-image 로 env를 생성하라."
  done
  oort_doctor_skip_stack "$why"
  oort_doctor_skip_public "$why"
}

oort_doctor_check_tools() {
  local out
  if command -v docker >/dev/null 2>&1; then
    out="$(docker --version 2>/dev/null || true)"
    oort_doctor_record tool.docker blocker pass "${out:-docker present}" ""
  else
    oort_doctor_record tool.docker blocker fail "docker 없음" \
      "https://docs.docker.com/get-docker/ 에서 Docker Engine + Compose v2를 설치하라."
  fi

  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    out="$(docker compose version 2>/dev/null || true)"
    oort_doctor_record tool.compose blocker pass "${out:-docker compose v2}" ""
  else
    oort_doctor_record tool.compose blocker fail "docker compose v2 없음" \
      "Compose v2 플러그인(docker compose)이 필요하다. hyphen docker-compose v1은 불가."
  fi

  if command -v jq >/dev/null 2>&1; then
    out="$(jq --version 2>/dev/null || true)"
    oort_doctor_record tool.jq blocker pass "${out:-jq present}" ""
  else
    oort_doctor_record tool.jq blocker fail "jq 없음" "jq를 설치하라 (JSON 판정·매니페스트)."
  fi

  if command -v openssl >/dev/null 2>&1; then
    out="$(openssl version 2>/dev/null || true)"
    oort_doctor_record tool.openssl blocker pass "${out:-openssl present}" ""
  else
    oort_doctor_record tool.openssl blocker fail "openssl 없음" "openssl를 설치하라."
  fi

  local avail
  avail="$(df -Pk "$OORT_ROOT" 2>/dev/null | awk 'NR == 2 { print $4 }')"
  if [ -z "$avail" ]; then
    oort_doctor_record tool.disk major skip "df 로 디스크 여유를 읽지 못했다" ""
  elif [ "$avail" -lt 1048576 ]; then
    oort_doctor_record tool.disk blocker fail "디스크 여유 ${avail} KiB (< 1 GiB)" \
      "이미지 pull·볼륨을 위해 최소 1 GiB를 비우라."
  elif [ "$avail" -lt 2097152 ]; then
    oort_doctor_record tool.disk major fail "디스크 여유 ${avail} KiB (< 2 GiB)" \
      "이미지 pull을 위해 2 GiB 이상을 권장한다."
  else
    oort_doctor_record tool.disk minor pass "디스크 여유 ${avail} KiB" ""
  fi
}

oort_doctor_check_true_gate() {
  local id="$1" key="$2" value trimmed
  if ! oort_doctor_has "$key"; then
    oort_doctor_record "$id" major pass \
      "$key unset (닫힘). 소문자 true 만 연다." ""
    return
  fi
  value="$(oort_doctor_get "$key")"
  trimmed="$(oort_doctor_trim "$value")"
  if [ "$trimmed" = "true" ]; then
    oort_doctor_record "$id" major pass "$key 게이트 열림 (소문자 true)" ""
  elif [ -z "$trimmed" ]; then
    oort_doctor_record "$id" major pass "$key empty (닫힘)" ""
  else
    oort_doctor_record "$id" major fail \
      "$key 가 소문자 true 가 아니라 조용히 닫힌다" \
      "소문자 true 만 게이트를 연다. True/1/yes 는 조용히 닫힌다. 값을 true 로 고쳐라."
  fi
}

oort_doctor_check_unfurl() {
  local value trimmed
  if ! oort_doctor_has MOMO_UNFURL_ENABLED; then
    oort_doctor_record env.bool.unfurl major pass \
      "MOMO_UNFURL_ENABLED unset (닫힘). 문자 1 만 연다." ""
    return
  fi
  value="$(oort_doctor_get MOMO_UNFURL_ENABLED)"
  trimmed="$(oort_doctor_trim "$value")"
  if [ "$trimmed" = "1" ]; then
    oort_doctor_record env.bool.unfurl major pass \
      "MOMO_UNFURL_ENABLED 게이트 열림 (문자 1)" ""
  elif [ -z "$trimmed" ] || [ "$trimmed" = "0" ]; then
    oort_doctor_record env.bool.unfurl major pass \
      "MOMO_UNFURL_ENABLED 닫힘 (0 또는 empty)" ""
  else
    oort_doctor_record env.bool.unfurl major fail \
      "MOMO_UNFURL_ENABLED 가 문자 1 이 아니라 조용히 닫힌다" \
      "언퍼얼은 문자 1 만 연다 (true/yes/True 는 닫힘). 값을 1 로 고치거나 끄려면 0."
  fi
}

oort_doctor_check_env() {
  local mode dup key missing="" claim="" value trimmed
  local class verdict lowered

  mode="$(oort_doctor_file_mode "$OORT_DOCTOR_ENV")"
  if [ "$mode" -eq 600 ]; then
    oort_doctor_record env.mode major pass "권한 ${mode}" ""
  else
    oort_doctor_record env.mode major fail "권한 ${mode} (0600 아님)" \
      "chmod 600 $OORT_DOCTOR_ENV"
  fi

  dup="$(awk -F= '
    /^[A-Za-z_][A-Za-z0-9_]*=/ {
      if (++seen[$1] == 2) { print $1; exit }
    }
  ' "$OORT_DOCTOR_ENV_RAW")"
  if [ -z "$dup" ]; then
    oort_doctor_record env.duplicate_keys blocker pass "중복 키 없음" ""
  else
    oort_doctor_record env.duplicate_keys blocker fail "중복 키 $dup" \
      "env 파일에서 그 키를 한 줄만 남기라."
  fi

  if awk -F= '
    /^[A-Za-z_][A-Za-z0-9_]*=/ {
      val = substr($0, length($1) + 2)
      if (val ~ /\r/) { print $1; exit }
    }
  ' "$OORT_DOCTOR_ENV_RAW" | grep -q .; then
    key="$(awk -F= '
      /^[A-Za-z_][A-Za-z0-9_]*=/ {
        val = substr($0, length($1) + 2)
        if (val ~ /\r/) { print $1; exit }
      }
    ' "$OORT_DOCTOR_ENV_RAW")"
    oort_doctor_record env.scalars blocker fail "$key 값에 CR 이 있다" \
      "Docker env는 단일행 스칼라다. 그 키를 한 줄로 고쳐라."
  else
    oort_doctor_record env.scalars blocker pass "단일행 스칼라" ""
  fi

  if oort_doctor_has MOMO_BOOTSTRAP_CLAIM && [ "$(oort_doctor_get MOMO_BOOTSTRAP_CLAIM)" = "1" ]; then
    claim=1
  fi
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    if [ "$key" = "MOMO_INITIAL_OWNER_PASSWORD" ] && [ "$claim" = "1" ]; then
      continue
    fi
    # #1856: generator writes this on create only and will not backfill an
    # existing env (auto-detect stays). Missing is not a silent-failure key.
    if [ "$key" = "MOMO_LIVEKIT_NODE_IP" ]; then
      continue
    fi
    if ! oort_doctor_has "$key"; then
      missing="${missing} ${key}"
    fi
  done <<EOF
$(oort_doctor_generator_keys)
EOF
  missing="$(oort_doctor_trim "$missing")"
  if [ -z "$missing" ]; then
    oort_doctor_record env.required_keys blocker pass \
      "생성기 키 전수 존재 (scripts/self_host_env.sh 파생)" ""
  else
    oort_doctor_record env.required_keys blocker fail \
      "생성기 키 누락:${missing}" \
      "scripts/self_host_env.sh 로 생성한 env를 쓰거나 빠진 키를 채워라."
  fi

  if oort_doctor_has MOMO_LIVEKIT_NODE_IP; then
    oort_doctor_record env.livekit_node_ip minor pass \
      "MOMO_LIVEKIT_NODE_IP present" ""
  else
    oort_doctor_record env.livekit_node_ip minor skip \
      "MOMO_LIVEKIT_NODE_IP 없음 — 생성기는 기존 env에 소급 주입하지 않는다 (huddle 자동 감지)" \
      "LAN/원격이면 클라가 닿는 IP 로 넣고 api를 재시작하라."
  fi

  oort_doctor_check_true_gate env.bool.doorbell MOMO_DOORBELL_ENABLED
  oort_doctor_check_true_gate env.bool.hosted_delivery MOMO_HOSTED_DELIVERY_ENABLED
  oort_doctor_check_unfurl

  if ! oort_doctor_has PLATFORM_ADMIN_EMAILS; then
    oort_doctor_record env.platform_admin_emails blocker fail \
      "PLATFORM_ADMIN_EMAILS 없음 — AI 연결 403" \
      "scripts/self_host_env.sh 를 다시 실행하면 그 줄만 덧붙는다. 그 뒤 api 재시작."
  else
    value="$(oort_doctor_get PLATFORM_ADMIN_EMAILS)"
    trimmed="$(oort_doctor_trim "$value")"
    if [ -z "$trimmed" ]; then
      oort_doctor_record env.platform_admin_emails blocker fail \
        "PLATFORM_ADMIN_EMAILS empty — AI 연결 403" \
        "운영자 이메일을 넣고 api를 재시작하라."
    else
      oort_doctor_record env.platform_admin_emails blocker pass \
        "PLATFORM_ADMIN_EMAILS present (length $(oort_doctor_length_class "$trimmed"))" ""
    fi
  fi

  if ! oort_doctor_has PROVIDER_LINK_MASTER_KEY; then
    oort_doctor_record env.provider_link_master_key blocker fail \
      "PROVIDER_LINK_MASTER_KEY 없음 — AI 연결 503" \
      "생성기가 넣는 키다. 손으로 만든 env면 그 줄을 채우고 api·agent-worker 재시작."
  else
    value="$(oort_doctor_get PROVIDER_LINK_MASTER_KEY)"
    class="$(oort_doctor_length_class "$value")"
    verdict="$(oort_doctor_hex_verdict "$value")"
    if [ -z "$value" ]; then
      oort_doctor_record env.provider_link_master_key blocker fail \
        "PROVIDER_LINK_MASTER_KEY empty — AI 연결 503" \
        "openssl rand -hex 24 로 채우고 agent-worker를 재시작하라."
    else
      oort_doctor_record env.provider_link_master_key blocker pass \
        "PROVIDER_LINK_MASTER_KEY present (${class}, ${verdict})" ""
    fi
  fi

  if ! oort_doctor_has MOMO_DRIVE_ARCHIVE_BACKEND; then
    oort_doctor_record env.drive_archive_backend blocker fail \
      "MOMO_DRIVE_ARCHIVE_BACKEND 없음 — 첨부 503" \
      "셀프호스트 기본은 local. scripts/self_host_env.sh 를 다시 실행하면 덧붙는다."
  else
    value="$(oort_doctor_trim "$(oort_doctor_get MOMO_DRIVE_ARCHIVE_BACKEND)")"
    if [ -z "$value" ]; then
      oort_doctor_record env.drive_archive_backend blocker fail \
        "MOMO_DRIVE_ARCHIVE_BACKEND empty — 첨부 503" \
        "MOMO_DRIVE_ARCHIVE_BACKEND=local 로 채우고 api를 재시작하라."
    elif [ "$value" = "stub" ]; then
      oort_doctor_record env.drive_archive_backend major fail \
        "MOMO_DRIVE_ARCHIVE_BACKEND=stub 는 staging 에서 부팅 거부" \
        "local 로 바꾸라."
    else
      oort_doctor_record env.drive_archive_backend blocker pass \
        "MOMO_DRIVE_ARCHIVE_BACKEND present (non-empty)" ""
    fi
  fi

  if ! oort_doctor_has MOMO_CENTRIFUGO_WS_URL; then
    oort_doctor_record env.centrifugo_ws_url blocker fail \
      "MOMO_CENTRIFUGO_WS_URL 없음 — 실시간 주소 권위 없음" \
      "MOMO_CENTRIFUGO_WS_URL=same-origin 을 넣어라 (ADR-0167)."
  else
    value="$(oort_doctor_trim "$(oort_doctor_get MOMO_CENTRIFUGO_WS_URL)")"
    lowered="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
    if [ -z "$value" ]; then
      oort_doctor_record env.centrifugo_ws_url blocker fail \
        "MOMO_CENTRIFUGO_WS_URL empty" \
        "MOMO_CENTRIFUGO_WS_URL=same-origin 으로 채워라."
    elif [ "$lowered" = "same-origin" ]; then
      oort_doctor_record env.centrifugo_ws_url major pass \
        "MOMO_CENTRIFUGO_WS_URL=same-origin" ""
    else
      case "$lowered" in
        ws://localhost:* | wss://localhost:* | ws://127.0.0.1:* | wss://127.0.0.1:*)
          oort_doctor_record env.centrifugo_ws_url major fail \
            "MOMO_CENTRIFUGO_WS_URL 이 루프백이라 터널 뒤에서 실시간이 죽는다" \
            "MOMO_CENTRIFUGO_WS_URL=same-origin 으로 고치고 api를 재시작하라."
          ;;
        ws://* | wss://*)
          oort_doctor_record env.centrifugo_ws_url major pass \
            "MOMO_CENTRIFUGO_WS_URL present (ws/wss, non-loopback)" ""
          ;;
        *)
          oort_doctor_record env.centrifugo_ws_url major fail \
            "MOMO_CENTRIFUGO_WS_URL 형식이 same-origin/ws/wss 가 아니다" \
            "MOMO_CENTRIFUGO_WS_URL=same-origin 을 써라."
          ;;
      esac
    fi
  fi

  oort_doctor_check_role_passwords
  oort_doctor_check_digest
}

oort_doctor_pair_password() {
  # Sets OORT_DOCTOR_PAIR_PROBLEM to a token or empty. Never prints values.
  local role_key="$1" url_key="$2" expect_user="$3"
  local rp up uu
  OORT_DOCTOR_PAIR_PROBLEM=""
  if ! oort_doctor_has "$role_key" || ! oort_doctor_has "$url_key"; then
    OORT_DOCTOR_PAIR_PROBLEM="${role_key}/${url_key} missing"
    return
  fi
  rp="$(oort_doctor_get "$role_key")"
  up="$(oort_doctor_url_password "$(oort_doctor_get "$url_key")")" || up=""
  uu="$(oort_doctor_url_user "$(oort_doctor_get "$url_key")")" || uu=""
  if [ -z "$rp" ]; then
    OORT_DOCTOR_PAIR_PROBLEM="${role_key} empty"
    return
  fi
  if [ "$rp" != "$up" ]; then
    OORT_DOCTOR_PAIR_PROBLEM="${role_key}≠${url_key}"
    return
  fi
  if [ -n "$expect_user" ] && [ "$uu" != "$expect_user" ]; then
    OORT_DOCTOR_PAIR_PROBLEM="${url_key} user"
  fi
}

oort_doctor_check_role_passwords() {
  local problems="" worker url_pw
  local expect_user

  expect_user="$(oort_doctor_get POSTGRES_USER)"
  [ -n "$expect_user" ] || expect_user=momo
  oort_doctor_pair_password POSTGRES_PASSWORD MIGRATE_DATABASE_URL "$expect_user"
  [ -z "$OORT_DOCTOR_PAIR_PROBLEM" ] || problems="${problems} ${OORT_DOCTOR_PAIR_PROBLEM}"

  oort_doctor_pair_password MOMO_APP_POSTGRES_PASSWORD MOMO_APP_DATABASE_URL momo_app
  [ -z "$OORT_DOCTOR_PAIR_PROBLEM" ] || problems="${problems} ${OORT_DOCTOR_PAIR_PROBLEM}"

  oort_doctor_pair_password RELAY_POSTGRES_PASSWORD RELAY_DATABASE_URL momo_relay
  [ -z "$OORT_DOCTOR_PAIR_PROBLEM" ] || problems="${problems} ${OORT_DOCTOR_PAIR_PROBLEM}"

  if ! oort_doctor_has WORKER_POSTGRES_PASSWORD; then
    problems="${problems} WORKER_POSTGRES_PASSWORD missing"
  else
    worker="$(oort_doctor_get WORKER_POSTGRES_PASSWORD)"
    if [ -z "$worker" ]; then
      problems="${problems} WORKER_POSTGRES_PASSWORD empty"
    elif oort_doctor_has WORKER_DATABASE_URL; then
      url_pw="$(oort_doctor_url_password "$(oort_doctor_get WORKER_DATABASE_URL)")" || url_pw=""
      if [ "$worker" != "$url_pw" ]; then
        problems="${problems} WORKER_POSTGRES_PASSWORD≠WORKER_DATABASE_URL"
      fi
    fi
  fi

  problems="$(oort_doctor_trim "$problems")"
  if [ -z "$problems" ]; then
    oort_doctor_record env.role_passwords blocker pass \
      "role 비밀번호 ↔ DATABASE_URL 교차 일치 (값 미출력)" ""
  else
    oort_doctor_record env.role_passwords blocker fail \
      "role 비밀번호와 DATABASE_URL 불일치:${problems}" \
      "시크릿을 다시 만들지 마라. URL 안의 비밀번호를 해당 *_POSTGRES_PASSWORD 와 같게 맞추거나 env를 생성기로 다시 만들라 (볼륨 down -v 필요)."
  fi
}

oort_doctor_check_digest() {
  local mode image latest digest_list verify_cmd env_digest
  latest="$OORT_ROOT/releases/latest.json"
  mode="$(oort_doctor_get MOMO_SELF_HOST_MODE)"
  image="$(oort_doctor_get MOMO_RUST_IMAGE)"

  if [ "$mode" != "published-digest" ]; then
    oort_doctor_record env.digest minor skip \
      "MOMO_SELF_HOST_MODE=${mode:-unset} — digest pin 해당 없음" ""
    oort_doctor_record env.attestation minor skip \
      "local-build/비발행 모드 — attestation 해당 없음" ""
    return
  fi

  env_digest=""
  case "$image" in
    ghcr.io/yeomyeonggeori/oort@sha256:[0-9a-f]*)
      env_digest="${image#*@}"
      ;;
  esac
  if ! printf '%s' "$env_digest" | grep -Eq '^sha256:[0-9a-f]{64}$'; then
    oort_doctor_record env.digest blocker fail \
      "공개 이미지는 ghcr.io/yeomyeonggeori/oort@sha256:<64 lowercase hex> 여야 한다" \
      "releases/latest.json 의 images.app.digest_list 로 pin 하라."
    oort_doctor_record env.attestation major skip "digest 형식 실패 — attestation 생략" ""
    return
  fi

  digest_list=""
  verify_cmd=""
  if [ -f "$latest" ] && command -v jq >/dev/null 2>&1; then
    digest_list="$(jq -r '.images.app.digest_list // empty' "$latest" 2>/dev/null || true)"
    verify_cmd="$(jq -r '.attestation.verify_cmd // empty' "$latest" 2>/dev/null || true)"
  fi

  if [ -n "$digest_list" ] && [ "$env_digest" = "$digest_list" ]; then
    oort_doctor_record env.digest blocker pass \
      "MOMO_RUST_IMAGE digest 형식 ok, releases/latest.json 과 일치" ""
  elif [ -n "$digest_list" ]; then
    oort_doctor_record env.digest major fail \
      "env digest 가 releases/latest.json images.app.digest_list 와 다르다" \
      "최신 pin은 releases/latest.json 이다. 업그레이드 절차로 맞추라 (시크릿 재생성 금지)."
  else
    oort_doctor_record env.digest blocker pass \
      "MOMO_RUST_IMAGE digest 형식 ok (latest.json 대조 생략)" ""
  fi

  if [ -n "$verify_cmd" ]; then
    oort_doctor_record env.attestation minor pass \
      "releases/latest.json attestation.verify_cmd 존재 (미실행)" \
      "운영자가 직접 gh attestation verify 를 실행한다."
  else
    oort_doctor_record env.attestation minor skip \
      "latest.json 에 attestation.verify_cmd 가 없다" ""
  fi
}

oort_doctor_check_ports() {
  local key port stack_up="$1"
  for key in MOMO_WEB_PORT MOMO_RUST_API_PORT CENT_HOST_PORT; do
    local id
    case "$key" in
      MOMO_WEB_PORT) id=port.web ;;
      MOMO_RUST_API_PORT) id=port.api ;;
      CENT_HOST_PORT) id=port.centrifugo ;;
    esac
    if ! oort_doctor_has "$key"; then
      oort_doctor_record "$id" major skip "$key 없음" ""
      continue
    fi
    port="$(oort_doctor_get "$key")"
    if ! printf '%s' "$port" | grep -Eq '^[0-9]+$' || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
      oort_doctor_record "$id" major fail "$key 가 1..65535 가 아니다" \
        "env 의 $key 를 유효한 포트로 고쳐라."
      continue
    fi
    if oort_doctor_port_busy "$port"; then
      if [ "$stack_up" = "1" ]; then
        oort_doctor_record "$id" minor pass \
          "$key 포트 ${port} in use (스택이 바인딩한 것으로 본다)" ""
      else
        oort_doctor_record "$id" major fail \
          "$key 포트 ${port} 가 이미 사용 중이다" \
          "점유 프로세스를 끄거나 $key 를 비어 있는 포트로 바꾸고 up 하라."
      fi
    else
      oort_doctor_record "$id" minor pass "$key 포트 ${port} 비어 있음" ""
    fi
  done
}

oort_doctor_stack_running() {
  local project="$1" line
  [ -n "$project" ] || return 1
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1 || return 1
  while IFS= read -r line; do
    [ "$line" = "running" ] && return 0
  done <<EOF
$(docker compose -p "$project" ps --format '{{.State}}' 2>/dev/null || true)
EOF
  return 1
}

oort_doctor_check_stack() {
  local project="$1"
  local ps_out svc state health line missing="" unhealthy="" report=""
  local web_port api_port base body hdr code db auth_line
  local pg_user pg_db outbox leftover
  local logs

  ps_out="$(docker compose -p "$project" ps --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null || true)"
  if [ -z "$ps_out" ]; then
    oort_doctor_skip_stack "프로젝트 ${project} 의 compose ps 가 비어 있다 (스택 미기동)"
    return
  fi

  for svc in postgres centrifugo api relay webhook-sender agent-worker web; do
    line="$(printf '%s\n' "$ps_out" | awk -v s="$svc" '$1 == s { print; exit }')"
    if [ -z "$line" ]; then
      missing="${missing} ${svc}"
      continue
    fi
    state="$(printf '%s' "$line" | awk '{ print $2 }')"
    health="$(printf '%s' "$line" | awk '{ print $3 }')"
    report="${report} ${svc}=${state}${health:+/$health}"
    if [ "$state" != "running" ]; then
      missing="${missing} ${svc}"
    elif [ -n "$health" ] && [ "$health" != "healthy" ]; then
      unhealthy="${unhealthy} ${svc}:${health}"
    fi
  done
  missing="$(oort_doctor_trim "$missing")"
  unhealthy="$(oort_doctor_trim "$unhealthy")"
  report="$(oort_doctor_trim "$report")"
  if [ -z "$missing" ] && [ -z "$unhealthy" ]; then
    oort_doctor_record stack.compose_ps major pass "$report" ""
  else
    oort_doctor_record stack.compose_ps major fail \
      "서비스 이상 missing=${missing:-none} unhealthy=${unhealthy:-none} (${report})" \
      "scripts/self_host_env.sh --compose ps / logs 로 해당 서비스를 보라."
  fi

  web_port="$(oort_doctor_get MOMO_WEB_PORT)"
  api_port="$(oort_doctor_get MOMO_RUST_API_PORT)"
  if [ -n "$web_port" ]; then
    base="http://127.0.0.1:${web_port}"
  elif [ -n "$api_port" ]; then
    base="http://127.0.0.1:${api_port}"
  else
    oort_doctor_record stack.healthz blocker skip "웹/API 포트 키 없음" ""
    oort_doctor_record stack.agent_port major skip "웹/API 포트 키 없음" ""
    base=""
  fi

  if [ -n "$base" ]; then
    if ! command -v curl >/dev/null 2>&1; then
      oort_doctor_record stack.healthz blocker skip "curl 없음 — /healthz 생략" "curl을 설치하라."
      oort_doctor_record stack.agent_port major skip "curl 없음 — agent-port 생략" "curl을 설치하라."
    else
      body="$(mktemp "${TMPDIR:-/tmp}/oort-doctor-healthz.XXXXXX")"
      code="$(curl -sS -m 3 -o "$body" -w '%{http_code}' "${base}/healthz" 2>/dev/null || true)"
      [ -n "$code" ] || code="000"
      db=""
      if grep -Eq '"database"[[:space:]]*:[[:space:]]*"ok"' "$body" 2>/dev/null; then
        db=ok
      fi
      rm -f "$body"
      if [ "$code" = "200" ] && [ "$db" = "ok" ]; then
        oort_doctor_record stack.healthz blocker pass \
          "${base}/healthz 200 database:ok" ""
      else
        oort_doctor_record stack.healthz blocker fail \
          "${base}/healthz HTTP ${code} (database:ok 필요)" \
          "api 로그: scripts/self_host_env.sh --compose logs api"
      fi

      hdr="$(mktemp "${TMPDIR:-/tmp}/oort-doctor-agentport.XXXXXX")"
      code="$(curl -sS -m 3 -D "$hdr" -o /dev/null -w '%{http_code}' \
        -X POST "${base}/v1/mcp/agent-port" 2>/dev/null || true)"
      [ -n "$code" ] || code="000"
      auth_line="$(tr -d '\r' <"$hdr" | grep -i '^WWW-Authenticate:' || true)"
      rm -f "$hdr"
      if [ "$code" = "401" ] && printf '%s' "$auth_line" | grep -Fq 'Bearer scope="agent:port:connect"'; then
        oort_doctor_record stack.agent_port major pass \
          "POST /v1/mcp/agent-port 401 + WWW-Authenticate Bearer scope=\"agent:port:connect\"" ""
      else
        oort_doctor_record stack.agent_port major fail \
          "agent-port HTTP ${code} (401 + Bearer scope=\"agent:port:connect\" 필요)" \
          "합류 표면이 없는 이미지일 수 있다. 발행 digest를 확인하라."
      fi
    fi
  fi

  pg_user="$(oort_doctor_get POSTGRES_USER)"
  pg_db="$(oort_doctor_get POSTGRES_DB)"
  [ -n "$pg_user" ] || pg_user=momo
  [ -n "$pg_db" ] || pg_db=momo
  outbox="$(docker compose -p "$project" exec -T postgres \
    psql -U "$pg_user" -d "$pg_db" -At -F $'\t' \
    -c "SELECT kind, status, count(*) FROM outbox GROUP BY 1,2;" 2>/dev/null || true)"
  if [ -z "$outbox" ]; then
    oort_doctor_record stack.outbox major skip \
      "outbox 오라클을 실행하지 못했다 (postgres exec)" \
      "스택이 기동 중이면 scripts/self_host_env.sh --compose exec postgres psql 로 확인하라."
  else
    leftover="$(printf '%s\n' "$outbox" | awk -F '\t' '$2 != "done" { n += 1 } END { print n + 0 }')"
    if [ "$leftover" -eq 0 ]; then
      oort_doctor_record stack.outbox major pass \
        "outbox 잔량 없음 (broadcast|done 외 0)" ""
    else
      oort_doctor_record stack.outbox major fail \
        "outbox 에 done 아닌 행이 있다 (kind/status 집계, 값 미나열)" \
        "pending/failed 면 relay 로그: scripts/self_host_env.sh --compose logs relay"
    fi
  fi

  logs="$(docker compose -p "$project" logs migrate 2>/dev/null || true)"
  if [ -z "$logs" ]; then
    oort_doctor_record stack.migrate_idempotency major skip \
      "migrate 로그 없음" \
      "스택을 up 한 뒤 다시 실행하라."
  elif printf '%s' "$logs" | grep -Fq 'IDEMPOTENCY_OK'; then
    oort_doctor_record stack.migrate_idempotency major pass \
      "migrate 로그에 IDEMPOTENCY_OK" ""
  else
    oort_doctor_record stack.migrate_idempotency major fail \
      "migrate 로그에 IDEMPOTENCY_OK 없음" \
      "scripts/self_host_env.sh --compose logs migrate 를 보라."
  fi
}

oort_doctor_check_public() {
  local origins origin tok ws_origin ws_key code
  if ! oort_doctor_has CENTRIFUGO_ALLOWED_ORIGINS; then
    oort_doctor_skip_public "--public-origin 흔적 없음 (CENTRIFUGO_ALLOWED_ORIGINS 없음)"
    return
  fi
  origins="$(oort_doctor_get CENTRIFUGO_ALLOWED_ORIGINS)"
  origin=""
  for tok in $origins; do
    case "$tok" in
      http://localhost* | https://localhost* | http://127.0.0.1* | https://127.0.0.1* | \
      tauri://* | http://tauri.localhost*)
        continue
        ;;
      http://* | https://*)
        origin="$tok"
        break
        ;;
    esac
  done
  if [ -z "$origin" ]; then
    oort_doctor_skip_public "--public-origin 흔적 없음 (루프백/tauri Origin 만)"
    return
  fi
  if ! command -v curl >/dev/null 2>&1; then
    oort_doctor_skip_public "curl 없음 — 공개 오리진 검사 생략"
    return
  fi
  code="$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "${origin}/healthz" 2>/dev/null || true)"
  [ -n "$code" ] || code="000"
  if [ "$code" = "200" ]; then
    oort_doctor_record public.healthz major pass "공개 ${origin}/healthz 200" ""
  else
    oort_doctor_record public.healthz major fail \
      "공개 Origin /healthz HTTP ${code}" \
      "터널/Caddy 와 CENTRIFUGO_ALLOWED_ORIGINS 를 확인하라."
  fi
  case "$origin" in
    https://*) ws_origin="wss://${origin#https://}/connection/websocket" ;;
    http://*) ws_origin="ws://${origin#http://}/connection/websocket" ;;
    *) ws_origin="" ;;
  esac
  if [ -z "$ws_origin" ]; then
    oort_doctor_record public.websocket major skip "WS URL 을 파생하지 못했다" ""
    return
  fi
  ws_key="$(openssl rand -base64 16 | tr -d '\n')"
  code="$(curl -sS -m 5 -o /dev/null -w '%{http_code}' \
    -H 'Connection: Upgrade' \
    -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' \
    -H "Sec-WebSocket-Key: ${ws_key}" \
    "$ws_origin" 2>/dev/null || true)"
  [ -n "$code" ] || code="000"
  if [ "$code" = "101" ]; then
    oort_doctor_record public.websocket major pass "공개 WS upgrade 101" ""
  else
    oort_doctor_record public.websocket major fail \
      "공개 WS upgrade HTTP ${code} (101 필요)" \
      "Centrifugo Origin 허용목록과 터널 WSS 를 확인하라."
  fi
}

oort_doctor_emit_human() {
  local id sev status detail fix
  printf '%s\n' "oort doctor"
  printf 'env: %s\n\n' "${OORT_DOCTOR_ENV:-"(none)"}"
  printf '%-6s %-8s %-32s %s\n' "STATUS" "SEV" "ID" "DETAIL"
  while IFS= read -r line || [ -n "$line" ]; do
    [ -n "$line" ] || continue
    id="${line%%	*}"
    rest="${line#*	}"
    sev="${rest%%	*}"
    rest="${rest#*	}"
    status="${rest%%	*}"
    rest="${rest#*	}"
    detail="${rest%%	*}"
    fix="${rest#*	}"
    printf '%-6s %-8s %-32s %s\n' "$status" "$sev" "$id" "$detail"
    if [ "$status" = "fail" ] && [ -n "$fix" ]; then
      printf '       fix: %s\n' "$fix"
    fi
    if [ "$status" = "skip" ] && [ -n "$fix" ]; then
      printf '       next: %s\n' "$fix"
    fi
  done <"$OORT_DOCTOR_CHECKS"
}

oort_doctor_summarize() {
  OORT_DOCTOR_PASS="$(awk -F '\t' '$3 == "pass" { n += 1 } END { print n + 0 }' "$OORT_DOCTOR_CHECKS")"
  OORT_DOCTOR_FAIL="$(awk -F '\t' '$3 == "fail" { n += 1 } END { print n + 0 }' "$OORT_DOCTOR_CHECKS")"
  OORT_DOCTOR_SKIP="$(awk -F '\t' '$3 == "skip" { n += 1 } END { print n + 0 }' "$OORT_DOCTOR_CHECKS")"
  OORT_DOCTOR_BLOCKER_FAIL="$(awk -F '\t' '$2 == "blocker" && $3 == "fail" { n += 1 } END { print n + 0 }' "$OORT_DOCTOR_CHECKS")"
  OORT_DOCTOR_MAJOR_FAIL="$(awk -F '\t' '$2 == "major" && $3 == "fail" { n += 1 } END { print n + 0 }' "$OORT_DOCTOR_CHECKS")"
  if [ "$OORT_DOCTOR_BLOCKER_FAIL" -gt 0 ] || [ "$OORT_DOCTOR_MAJOR_FAIL" -gt 0 ]; then
    OORT_DOCTOR_VERDICT=FAIL
  else
    OORT_DOCTOR_VERDICT=PASS
  fi
}

oort_doctor_emit_json() {
  python3 - "$OORT_DOCTOR_CHECKS" <<'PY'
import json
import sys

path = sys.argv[1]
checks = []
pass_n = fail_n = skip_n = 0
blocker_fail = major_fail = False
with open(path, encoding="utf-8") as fh:
    for raw in fh:
        line = raw.rstrip("\n")
        if not line:
            continue
        parts = line.split("\t", 4)
        while len(parts) < 5:
            parts.append("")
        cid, sev, status, detail, fix = parts
        checks.append(
            {
                "id": cid,
                "severity": sev,
                "status": status,
                "detail": detail,
                "fix": fix,
            }
        )
        if status == "pass":
            pass_n += 1
        elif status == "fail":
            fail_n += 1
            if sev == "blocker":
                blocker_fail = True
            elif sev == "major":
                major_fail = True
        elif status == "skip":
            skip_n += 1
verdict = "FAIL" if (blocker_fail or major_fail) else "PASS"
json.dump(
    {
        "summary": {
            "pass": pass_n,
            "fail": fail_n,
            "skip": skip_n,
            "verdict": verdict,
        },
        "checks": checks,
    },
    sys.stdout,
    ensure_ascii=False,
    indent=2,
)
sys.stdout.write("\n")
PY
}

oort_doctor_exit_code() {
  if [ "$OORT_DOCTOR_BLOCKER_FAIL" -gt 0 ]; then
    printf '2'
  elif [ "$OORT_DOCTOR_MAJOR_FAIL" -gt 0 ]; then
    if [ "$OORT_DOCTOR_STRICT" = "1" ]; then
      printf '2'
    else
      printf '1'
    fi
  else
    printf '0'
  fi
}

oort_doctor() {
  local env_given=0 json=0 project stack_up code
  OORT_DOCTOR_STRICT=0
  OORT_DOCTOR_ENV=""

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --env)
        [ "$#" -ge 2 ] || { oort_doctor_usage >&2; return 2; }
        OORT_DOCTOR_ENV="$2"
        env_given=1
        shift 2
        ;;
      --env=*)
        OORT_DOCTOR_ENV="${1#--env=}"
        env_given=1
        shift
        ;;
      --json)
        json=1
        shift
        ;;
      --strict)
        OORT_DOCTOR_STRICT=1
        shift
        ;;
      -h | --help)
        oort_doctor_usage
        return 0
        ;;
      *)
        printf 'oort doctor: 알 수 없는 인자: %s\n' "$1" >&2
        oort_doctor_usage >&2
        return 2
        ;;
    esac
  done

  : "${OORT_ROOT:?oort doctor: OORT_ROOT unset}"

  if [ -z "$OORT_DOCTOR_ENV" ]; then
    OORT_DOCTOR_ENV="$OORT_ROOT/infra/rust/local.secrets.env"
  fi

  OORT_DOCTOR_CHECKS="$(mktemp "${TMPDIR:-/tmp}/oort-doctor-checks.XXXXXX")"
  OORT_DOCTOR_ENV_NORM="$(mktemp "${TMPDIR:-/tmp}/oort-doctor-env.XXXXXX")"
  OORT_DOCTOR_ENV_RAW=""
  chmod 600 "$OORT_DOCTOR_CHECKS" "$OORT_DOCTOR_ENV_NORM" 2>/dev/null || true

  oort_doctor_check_tools

  if [ ! -f "$OORT_DOCTOR_ENV" ]; then
    if [ "$env_given" -eq 1 ]; then
      oort_doctor_record env.exists blocker fail "env 파일 없음" \
        "경로를 확인하거나 scripts/self_host_env.sh 로 생성하라."
      oort_doctor_skip_env_rest "env 파일 없음"
    else
      oort_doctor_record env.exists major skip \
        "기본 env 없음 (설치 전 preflight)" \
        "scripts/self_host_env.sh --local-build 또는 --published-image 로 생성하라."
      oort_doctor_skip_env_rest "설치 전 preflight — env 없음"
    fi
  else
    oort_doctor_record env.exists blocker pass "env 파일 존재" ""
    OORT_DOCTOR_ENV_RAW="$OORT_DOCTOR_ENV"
    oort_doctor_load_env "$OORT_DOCTOR_ENV"
    oort_doctor_check_env

    project=""
    stack_up=0
    if oort_doctor_has COMPOSE_PROJECT_NAME; then
      project="$(oort_doctor_get COMPOSE_PROJECT_NAME)"
    else
      project="momo-rust"
    fi
    if oort_doctor_stack_running "$project"; then
      stack_up=1
    fi
    oort_doctor_check_ports "$stack_up"
    if [ "$stack_up" -eq 1 ]; then
      oort_doctor_check_stack "$project"
    else
      oort_doctor_skip_stack \
        "프로젝트 ${project} 에 실행 중인 컨테이너가 없다 (스택 미기동)"
    fi
    oort_doctor_check_public
  fi

  oort_doctor_summarize

  if [ "$json" -eq 1 ]; then
    oort_doctor_emit_json
  else
    oort_doctor_emit_human
    printf '\nsummary: pass=%s fail=%s skip=%s verdict=%s\n' \
      "$OORT_DOCTOR_PASS" "$OORT_DOCTOR_FAIL" "$OORT_DOCTOR_SKIP" "$OORT_DOCTOR_VERDICT"
  fi

  code="$(oort_doctor_exit_code)"
  rm -f "$OORT_DOCTOR_CHECKS" "$OORT_DOCTOR_ENV_NORM"
  return "$code"
}
