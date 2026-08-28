# 결함 B 진단 — 허들 TURN relay↔SFU 페어 무응답 (2026-08-28)

> 수집: 그록봇 Orchestrator 릴레이(16:09 발신, 16:10 보고). 관측만, 무변경.
> 선행 맥락: 결함 A(#1847→#1849, 클라 setConfiguration 리라이트) 수리 후에도 허들 미연결 → 서버축 진단.

## Orchestrator 관측 (VM, livekit 컨테이너)

1. **로그**: turn/allocation/permission/error 줄 없음(info 레벨). 오늘 14:36–14:41 KST 같은 참가자(Comptest-fable) join 5회 전부 `SIGNAL_SOURCE_CLOSE` + ICE `failed`. 마지막 페어 원문:
   `local=172.19.0.2:50025 udp type(host/) remote=172.19.0.2:35358 udp type(relay/) state=failed requests=8 responses=0`
   — CreatePermission 거부 로그는 없고, **STUN 요청 8회·응답 0**.
2. **livekit.yaml rtc**: `tcp_port: 7881`, `port_range_start: 50000`, `port_range_end: 50100`. **`node_ip` / `use_external_ip` / `ips` 없음.** turn: `enabled: true`, `external_tls: true`, `tls_port: 8443`, `domain: cursor.tailb1aad3.ts.net`. 시크릿은 `LIVEKIT_KEYS`(compose 주입).
3. **포트 스냅샷**(세션 종료 후): UDP는 docker DNS(127.0.0.11)만. TCP는 livekit-server가 7880/7881/8443 리슨. 30000–40000·50000–50100은 당시 바인드 없음.
4. **기동 로그**: `Starting TURN server {relay_range_start: 30000, relay_range_end: 40000, portTLS: 8443, externalTLS: true}` / `starting LiveKit server {nodeIP: "172.19.0.2", rtc.portICERange: [50000,50100]}`.
   → **advertise IP(nodeIP)가 docker bridge 172.19.0.2로 자동 감지** — relay 후보와 SFU host 후보가 같은 내부 주소로 페어된다.

## 판독 (Fable)

- 실패 페어는 SFU(host `172.19.0.2:50025`) → 클라 relay(`172.19.0.2:35358`) 방향의 connectivity check. 요청은 나가는데 응답이 0 — TURN이 클라로 포워딩하지 않거나(permission 부재/거부), 포워딩됐지만 클라 응답 경로가 죽어 있는 형상.
- 이전 클라측 실측(결함 A 수리 검증 중): TURN 할당은 성공, relay 페어가 요청 1회 만에 즉시 failed — "CreatePermission 거부 형상"으로 기록했으나 서버 로그에는 거부가 안 찍힘(로그 레벨 한계 가능).
- 구조 요인: nodeIP가 브리지 IP라 (a) SFU host 후보는 외부에서 무의미하고 (b) TURN relay와 SFU가 같은 컨테이너-내부 주소 공간에서 페어링된다. 셀프호스트 LiveKit의 표준 배치는 host 네트워킹 또는 명시적 node_ip인데 현 VM compose는 bridge + Funnel(8443/10000)만 쓴다.

## 후보 방향 (수리 티켓 입력)

- **B-1 (유력, 인프라 zero-app-code)**: VM compose에서 livekit을 `network_mode: host`로 전환(셀프호스트 표준 배치) 또는 `rtc.node_ip` 명시. TURN·SFU가 실 인터페이스로 정렬되는지 VM 릴레이로 실측.
- **B-2**: livekit 디버그 로그 레벨로 CreatePermission 수락/거부 직접 관측(원인 확정용, B-1 전 1회).
- **B-3**: livekit 버전 상향(v1.13.3 → 최신)에 TURN 경로 수리가 포함되는지 릴리즈 노트 확인.

검증 절차(공통): 변경→그록봇 릴레이 적용→외부 크롬 webrtc-internals에서 relay 페어 succeeded + S1-a 재실측. 허들 배선 5종·CSP 보존 규율은 comprehensive-test-packet 준수.
