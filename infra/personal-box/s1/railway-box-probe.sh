#!/bin/sh
# S1 ② Railway 서비스 안에서 도는 프로브(시작 명령으로 주입). 60초마다 한 줄 묶음을 stdout 로그로 남긴다.
# 대상: team 인스턴스의 postgres.railway.internal(존재하지 않는 별도 프로젝트에서는 NXDOMAIN이어야 한다),
# 같은 프로젝트의 다른 서비스(박스끼리 도달 여부), 사설/메타데이터/SMTP/공용 egress.
mkdir -p /data 2>/dev/null
echo "boot $(date -u +%FT%TZ) host=$(hostname)" >> /data/s1.log 2>/dev/null
(nc -lk -p 18080 -e echo ok >/dev/null 2>&1 &)
chk() { if nc -w 3 -z "$1" "$2" >/dev/null 2>&1; then echo "$3 OPEN"; else echo "$3 BLOCKED"; fi; }
while true; do
  echo "== $(date -u +%FT%TZ) me=$(hostname)"
  for h in postgres.railway.internal api.railway.internal redis.railway.internal boxa.railway.internal boxb.railway.internal; do
    if nslookup "$h" >/dev/null 2>&1; then echo "dns $h RESOLVES"; else echo "dns $h NXDOMAIN"; fi
  done
  chk boxa.railway.internal 18080 "tcp boxa.internal:18080"
  chk boxb.railway.internal 18080 "tcp boxb.internal:18080"
  chk 169.254.169.254 80 "tcp metadata:80"
  chk 100.64.0.1 80 "tcp cgnat:80"
  chk 1.1.1.1 443 "tcp pub:443"
  chk smtp.gmail.com 25 "tcp smtp:25"
  chk smtp.gmail.com 587 "tcp smtp:587"
  chk smtp.gmail.com 465 "tcp smtp:465"
  echo "volume $(df -k /data 2>/dev/null | tail -1 | tr -s ' ' | cut -d' ' -f2,3) $(cat /data/s1.log 2>/dev/null | wc -l)"
  sleep 60
done
