#!/usr/bin/env bash
# S1 ② Railway GraphQL 호출 헬퍼(CLI가 노출하지 않는 시작 명령·백업·토큰 범위 시험용).
# 계정 토큰은 ~/.railway/config.json에서 읽어 환경변수로만 쓰고 출력하지 않는다.
# 사용: RAILWAY_API_TOKEN을 외부에서 주면(프로젝트 토큰 시험) 그것을 우선한다.
#   rw-gql.sh '<query>' ['<variables json>']   → 응답 JSON을 stdout에. 토큰 값은 절대 echo 하지 않는다.
set -euo pipefail
q="${1:?query}"; vars="${2:-}"; [ -n "$vars" ] || vars="{}"
hdr=()
if [ -n "${RW_PROJECT_TOKEN:-}" ]; then
  hdr=(-H "Project-Access-Token: ${RW_PROJECT_TOKEN}")
else
  tok="$(jq -r '.user.token' "$HOME/.railway/config.json")"
  hdr=(-H "Authorization: Bearer ${tok}")
fi
body="$(jq -n --arg q "$q" --argjson v "$vars" '{query:$q,variables:$v}')"
curl -sS -m 30 https://backboard.railway.com/graphql/v2 -H 'Content-Type: application/json' "${hdr[@]}" -d "$body"
