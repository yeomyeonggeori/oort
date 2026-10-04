#!/bin/sh
# S1 ② 다른 Railway 프로젝트(-b)의 서비스에서 스파이크 프로젝트 박스로 닿는지 시험한다. 인자: 대상 IPv6 (boxb의 사설 주소)
T6="${1:?target ipv6}"
while true; do
  echo "== $(date -u +%FT%TZ)"
  for h in boxa.railway.internal boxb.railway.internal postgres.railway.internal; do
    if nslookup "$h" >/dev/null 2>&1; then echo "dns $h RESOLVES"; else echo "dns $h NXDOMAIN"; fi
  done
  if nc -w 4 -z "$T6" 18080 >/dev/null 2>&1; then echo "tcp other-project-box-ip:18080 OPEN"; else echo "tcp other-project-box-ip:18080 BLOCKED"; fi
  nc -w 3 -z 1.1.1.1 443 >/dev/null 2>&1 && echo "tcp pub:443 OPEN" || echo "tcp pub:443 BLOCKED"
  sleep 30
done
