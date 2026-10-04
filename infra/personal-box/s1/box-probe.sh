#!/bin/sh
# 박스(하드닝 컨테이너) 안에서 실행하는 egress 프로브. busybox nc만 쓴다.
# 사용: box-probe.sh <label>  (대상은 환경변수)  출력: TSV  label \t name \t target \t OPEN|BLOCKED
# baseline(규칙 적용 전)에서 대상이 있는 프로브가 전부 OPEN이어야 프로브가 유효하다.
label="${1:-run}"
probe() { # name host port
  if nc -w 3 -z "$2" "$3" >/dev/null 2>&1; then r=OPEN; else r=BLOCKED; fi
  printf '%s\t%s\t%s:%s\t%s\n' "$label" "$1" "$2" "$3" "$r"
}
probe neighbor_l2        "$NEIGHBOR_IP" 18080
probe rfc1918_10         "$T_RFC10"     18080
probe rfc1918_172        "$T_RFC172"    18080
probe rfc1918_192        "$T_RFC192"    18080
probe cgnat_100_64       "$T_CGNAT"     18080
probe metadata_169_254   "$T_META"      18080
probe host_gateway       "$GW_IP"       18080
probe ipv6_ula           "$T_V6"        18080
probe smtp_25            "$T_PUB"       25
probe smtp_465           "$T_PUB"       465
probe smtp_587           "$T_PUB"       587
probe control_pub_8080   "$T_PUB"       18080
probe control_internet   "1.1.1.1"      443
