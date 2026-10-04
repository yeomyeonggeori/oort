#!/usr/bin/env bash
# S1 ② Railway CLI 안전 래퍼. 현재 디렉터리에 연결된 프로젝트가 스파이크 전용 프로젝트가 아니면 즉시 중단한다.
# 반드시 레포 밖 임시 디렉터리에서 실행한다(레포의 infra/railway 등은 팀 인스턴스에 연결돼 있을 수 있다).
# 사용: rw.sh <railway 인자...>      (init/link/list/login 등 프로젝트 판별이 필요 없는 명령은 RW_BOOTSTRAP=1)
set -euo pipefail
WANT="${RW_WANT:-oort-personal-box-spike-s1}"   # 교차 프로젝트 시험용 -b 프로젝트만 RW_WANT로 허용
if [ "${RW_BOOTSTRAP:-0}" != "1" ]; then
  name="$(railway status --json 2>/dev/null | jq -r '.name // empty')"
  if [ "$name" != "$WANT" ]; then
    echo "rw.sh: 연결된 프로젝트가 '$name' 입니다. '$WANT' 만 허용합니다. 중단." >&2
    exit 64
  fi
fi
exec railway "$@"
