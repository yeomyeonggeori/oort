#!/usr/bin/env bash
# scripts/openapi_spec_to_json.sh — 스펙 YAML -> JSON 변환의 정본 (#1185)
#
# **소스 전용 라이브러리다.** 직접 실행하면 아무 일도 하지 않는다.
#
# ── 왜 파일로 떼어냈나 ────────────────────────────────────────────────────────
# 같은 변환이 1차 패스(verify_openapi_contract.sh)와 2차 패스(verify_openapi_
# contract_rust.sh)에 **각각 복사**돼 있었고, #1042 가 만든 2차 사본에만 psych 3
# 재시도가 빠져 있었다. 그래서 로그인 셸이 /usr/bin/ruby 2.6 을 먼저 잡는 기계에서
# 웹 프로파일 14단계만 빨갛고 **같은 명령의 직접 실주행은 초록**인, 재현이 환경에
# 숨는 상태가 됐다(#1185 / #1184 짚음 1). 원인이 사본이므로 사본을 지운다.
#
# ── 왜 로그인 셸 PATH 를 고정하지 않았나 (#1185 후보 ③ 기각) ─────────────────
# PATH 를 게이트가 다시 쓰는 것은 레포 밖 기계 전역을 건드리는 수리다. 고쳐도
# "이 기계에서 어떤 ruby 가 먼저 잡히는가"에 게이트의 초록이 계속 매달리고,
# 다음 기계에서 같은 빨강이 새로 태어난다. 게이트는 자기가 쓸 인터프리터의
# **자격을 실측**해서 고르면 된다 — verify_openapi_contract{,_rust}.sh 의
# OPENSSL_BIN(LibreSSL 은 Ed25519 를 못 한다)·PYTHON_BIN(MOMO-458, Xcode 3.9 회피)
# 선택이 이미 같은 규율이고, 이 파일은 그 규율을 ruby 로 넓힌 것뿐이다.
#
# ── 갈래와 출력 규약 ─────────────────────────────────────────────────────────
# 갈래는 셋이고 **언제나 어느 갈래로 뛰었는지 한 줄 출력한다.** 조용한 강등은
# 금지다(#1089·#1181 전례) — 초록이 어떤 리더로 얻어진 초록인지 로그가 답한다.
#   1) ruby + psych 4+ : YAML.load_file(spec, aliases: true)
#   2) ruby + psych 3- : YAML.load_file(spec)   — 키워드가 없는 대신 별칭 기본 허용
#   3) python + PyYAML : yaml.safe_load
# 셋 다 자격이 없으면 무엇을 왜 못 썼는지 갈래별로 이름을 대고 죽는다.
#
# 1) 과 2) 는 오늘의 스펙에서 **바이트 동일한 JSON** 을 낸다(#1185 실측:
# ruby 4.0.6 aliases:true 와 ruby 2.6.10 무키워드가 263332 바이트 동일).
# docs/api/openapi.yaml 에는 현재 앵커/별칭이 0 개이므로 `aliases: true` 는
# 미래 대비이지 오늘의 요구가 아니고, psych 4 에서 키워드를 뺀 채 별칭이 등장하면
# Psych 가 예외를 던지므로 **조용히 틀린 JSON 이 나오는 경로는 없다.**

# momo_openapi_spec_to_json <spec.yaml> <out.json> [로그 태그] [python 바이너리]
momo_openapi_spec_to_json() {
  local spec="$1"
  local out="$2"
  local tag="${3:-openapi}"
  local python_bin="${4:-python3}"
  local err="$out.convert.err"
  local ruby_ver=""
  local ruby_why="ruby not on PATH"
  local python_why="$python_bin not on PATH"

  if command -v ruby >/dev/null 2>&1; then
    ruby_ver="$(ruby -e 'print RUBY_VERSION' 2>/dev/null || printf 'unknown')"
    # 자격 실측. psych 4(ruby 3.1+)는 별칭을 기본 거부하므로 `aliases:` 를 받아야
    # 하고, psych 3 이하(2.6~3.0)는 그 키워드 자체를 모른다(unknown keyword:
    # aliases, ArgumentError). RUBY_VERSION 숫자 비교는 psych 백포트/젬 고정에
    # 거짓말하므로 인터프리터에게 직접 묻는다.
    if ruby -ryaml -e 'YAML.load("momo: 1185", aliases: true)' >/dev/null 2>&1; then
      if ruby -ryaml -rjson -e \
        'puts JSON.generate(YAML.load_file(ARGV[0], aliases: true))' \
        "$spec" >"$out" 2>"$err"; then
        printf '[%s] spec->json reader: ruby %s (psych 4+, aliases: true)\n' "$tag" "$ruby_ver"
        rm -f "$err"
        return 0
      fi
      ruby_why="ruby $ruby_ver takes aliases: but failed to parse the spec"
    else
      if ruby -ryaml -rjson -e \
        'puts JSON.generate(YAML.load_file(ARGV[0]))' \
        "$spec" >"$out" 2>"$err"; then
        printf '[%s] spec->json reader: ruby %s (psych 3-, no aliases: keyword; aliases allowed by default)\n' "$tag" "$ruby_ver"
        rm -f "$err"
        return 0
      fi
      ruby_why="ruby $ruby_ver has no aliases: keyword and failed to parse the spec"
    fi
    if [ -s "$err" ]; then
      while IFS= read -r line; do
        printf '[%s] ruby: %s\n' "$tag" "$line" >&2
      done <"$err"
    fi
  fi

  if command -v "$python_bin" >/dev/null 2>&1; then
    if "$python_bin" -c 'import yaml' >/dev/null 2>&1; then
      if "$python_bin" -c 'import json, sys, yaml
with open(sys.argv[1], encoding="utf-8") as handle:
    json.dump(yaml.safe_load(handle), sys.stdout)' "$spec" >"$out" 2>"$err"; then
        printf '[%s] spec->json reader: %s (PyYAML)\n' "$tag" "$python_bin"
        rm -f "$err"
        return 0
      fi
      python_why="$python_bin imports yaml but failed to parse the spec"
      if [ -s "$err" ]; then
        while IFS= read -r line; do
          printf '[%s] %s: %s\n' "$tag" "$python_bin" "$line" >&2
        done <"$err"
      fi
    else
      python_why="$python_bin has no PyYAML (import yaml failed)"
    fi
  fi

  rm -f "$err"
  echo "[$tag] cannot convert $spec to JSON — no qualified YAML reader" >&2
  echo "[$tag]   ruby  : $ruby_why" >&2
  echo "[$tag]   python: $python_why" >&2
  echo "[$tag] fix: put a ruby with yaml+json on PATH, or install PyYAML for $python_bin" >&2
  return 1
}
