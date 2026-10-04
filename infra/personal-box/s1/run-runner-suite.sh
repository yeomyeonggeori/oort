#!/usr/bin/env bash
# S1 ① 런너 호스트 egress 시험. Colima VM(Linux)에서 선언 nftables를 적용하고 전후를 비교한다.
# 사용: run-runner-suite.sh <결과_디렉터리>
# 모든 자원은 momo-s1- 접두. 다른 프로젝트 컨테이너·네트워크는 건드리지 않는다. 종료 시 trap이 전부 정리한다.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${1:?result dir}"; mkdir -p "$OUT"
vm() { colima ssh -- sudo "$@"; }

IMG=momo-s1-probe:1
NET_BOX=momo-s1-net; NET_TGT=momo-s1-tgtnet
BR_BOX=momos1br;     BR_TGT=momos1tg
TGT_IP=10.232.0.2;   TGT_IP6=fd00:5a2::2
ROUTES4=(10.99.99.1 172.30.99.1 192.168.99.1 100.64.99.1 169.254.169.254 198.51.100.7)
ROUTE6=fd00:dead::1

cleanup() {
  set +e
  vm nft delete table inet momo_s1 2>/dev/null
  vm nft delete table bridge momo_s1_l2 2>/dev/null
  vm iptables -D DOCKER-USER -i $BR_BOX -o $BR_TGT -m comment --comment momo-s1 -j ACCEPT 2>/dev/null
  vm iptables -D DOCKER-USER -i $BR_TGT -o $BR_BOX -m comment --comment momo-s1 -j ACCEPT 2>/dev/null
  vm ip6tables -D DOCKER-USER -i $BR_BOX -o $BR_TGT -m comment --comment momo-s1 -j ACCEPT 2>/dev/null
  vm ip6tables -D DOCKER-USER -i $BR_TGT -o $BR_BOX -m comment --comment momo-s1 -j ACCEPT 2>/dev/null
  for a in "${ROUTES4[@]}"; do vm ip route del "$a/32" 2>/dev/null; done
  vm ip -6 route del "$ROUTE6/128" 2>/dev/null
  docker rm -f momo-s1-boxa momo-s1-boxb momo-s1-tgt momo-s1-hostlis >/dev/null 2>&1
  docker network rm $NET_BOX $NET_TGT >/dev/null 2>&1
  docker rmi $IMG >/dev/null 2>&1
}
trap cleanup EXIT
cleanup  # 이전 실행 잔재 제거(접두 momo-s1-만)

docker build -q -t $IMG -f "$HERE/Dockerfile.probe" "$HERE" >/dev/null
docker network create --driver bridge --ipv6 --subnet 10.231.0.0/24 --gateway 10.231.0.1 \
  --subnet fd00:5a1::/64 --gateway fd00:5a1::1 -o com.docker.network.bridge.name=$BR_BOX $NET_BOX >/dev/null
docker network create --driver bridge --ipv6 --subnet 10.232.0.0/24 --gateway 10.232.0.1 \
  --subnet fd00:5a2::/64 --gateway fd00:5a2::1 -o com.docker.network.bridge.name=$BR_TGT $NET_TGT >/dev/null

# 스탠드인 대상: 한 컨테이너의 lo에 사설·CGNAT·메타데이터·"공용" 주소를 달고 호스트 라우트로 이쪽에 보낸다.
# shellcheck disable=SC2016  # 컨테이너 안 셸이 확장한다
LISTEN='for p in 18080 25 465 587; do socat TCP4-LISTEN:$p,fork,reuseaddr SYSTEM:"echo ok" & socat TCP6-LISTEN:$p,fork,reuseaddr,ipv6only=1 SYSTEM:"echo ok" & done; wait'
docker run -d --name momo-s1-tgt --network $NET_TGT --ip $TGT_IP --ip6 $TGT_IP6 --cap-add NET_ADMIN $IMG sh -c '
  for a in '"${ROUTES4[*]}"'; do ip addr add $a/32 dev lo; done; ip -6 addr add '$ROUTE6'/128 dev lo
  '"$LISTEN" >/dev/null
for a in "${ROUTES4[@]}"; do vm ip route add "$a/32" via $TGT_IP; done
vm ip -6 route add "$ROUTE6/128" via $TGT_IP6
# Docker 기본 네트워크 격리가 두 브리지 사이를 막으므로, baseline 도달 가능성만 위해 한시 허용(종료 시 제거)
for fam in iptables ip6tables; do
  vm $fam -I DOCKER-USER -i $BR_BOX -o $BR_TGT -m comment --comment momo-s1 -j ACCEPT
  vm $fam -I DOCKER-USER -i $BR_TGT -o $BR_BOX -m comment --comment momo-s1 -j ACCEPT
done
# 호스트 자신(게이트웨이) 리스너
docker run -d --name momo-s1-hostlis --network host $IMG sh -c 'socat TCP-LISTEN:18080,fork,reuseaddr,bind=10.231.0.1 SYSTEM:"echo ok"' >/dev/null

# shellcheck disable=SC2054  # --tmpfs 인자의 쉼표는 값의 일부다
HARDEN=(--user 10001:10001 --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 256
        --memory 512m --cpus 1 --ulimit core=0 --tmpfs /tmp:rw,noexec,nosuid,size=16m --dns 1.1.1.1)
docker run -d --name momo-s1-boxb --network $NET_BOX "${HARDEN[@]}" $IMG sh -c 'socat TCP-LISTEN:18080,fork,reuseaddr SYSTEM:"echo ok"' >/dev/null
docker run -d --name momo-s1-boxa --network $NET_BOX "${HARDEN[@]}" $IMG sleep 3600 >/dev/null
sleep 3
NB=$(docker inspect -f '{{(index .NetworkSettings.Networks "'$NET_BOX'").IPAddress}}' momo-s1-boxb)

run_probes() { # label
  docker exec -e NEIGHBOR_IP="$NB" -e T_RFC10=10.99.99.1 -e T_RFC172=172.30.99.1 -e T_RFC192=192.168.99.1 \
    -e T_CGNAT=100.64.99.1 -e T_META=169.254.169.254 -e GW_IP=10.231.0.1 -e T_V6=$ROUTE6 -e T_PUB=198.51.100.7 \
    -i momo-s1-boxa sh -s "$1" < "$HERE/box-probe.sh"
}

{ echo "## box hardening (docker inspect / in-box)"
  docker exec momo-s1-boxa sh -c 'id; grep -E "CapEff|NoNewPrivs|Seccomp:" /proc/self/status; touch /rootfs-write 2>&1 | head -1; echo core=$(ulimit -c)'
  docker inspect -f 'ReadonlyRootfs={{.HostConfig.ReadonlyRootfs}} Privileged={{.HostConfig.Privileged}} CapDrop={{.HostConfig.CapDrop}} PidsLimit={{.HostConfig.PidsLimit}} Mem={{.HostConfig.Memory}}' momo-s1-boxa
} > "$OUT/hardening.txt" 2>&1

run_probes baseline > "$OUT/probes-baseline.tsv"
vm nft -f - < "$HERE/runner-egress.nft"
vm nft list ruleset 2>/dev/null | grep -c . >/dev/null
run_probes ruleset > "$OUT/probes-ruleset.tsv"
{ vm nft list table inet momo_s1; vm nft list table bridge momo_s1_l2; } > "$OUT/nft-counters.txt"
# 대조군 재확인: 규칙이 있어도 공용 인터넷 egress는 살아 있어야 한다
docker exec momo-s1-boxa sh -c 'nc -w 3 -z 1.1.1.1 443 && echo internet-ok || echo internet-FAIL' > "$OUT/control-after.txt"
paste -d'\t' <(cut -f2-4 "$OUT/probes-baseline.tsv") <(cut -f4 "$OUT/probes-ruleset.tsv") | column -t -s$'\t' > "$OUT/summary.txt"
cat "$OUT/summary.txt"
