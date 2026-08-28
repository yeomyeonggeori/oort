# 워커 브리프 — #1856a 로컬 셀프호스트 허들 node_ip 노브 (engine/infra)

> 워커: cursor-agent grok-4.6-high-fast · 병렬 1 · base=origin/track/engine
> 정지 조건: 머지·이슈 close 금지. 이 티켓은 **레포측 절반만** — VM(TURN relay 페어) 절반은 #1856에 남는다.

## 실측 근거 (2026-08-28, claudedocs/comprehensive-test-20260828/S1-lite-local-huddle.md)
- 로컬 셀프호스트(발행 v0.1.3, colima/docker bridge)에서 huddle 프로파일 기동 시 livekit이 **nodeIP를 브리지 IP로 자동 감지**(예: 172.24.0.8) → 호스트 브라우저가 광고 후보에 도달 불가 → `could not establish pc connection`. UDP 50000-50100이 host에 발행돼 있어도 광고 IP가 틀려서 무용.
- 컨테이너의 livekit.yaml에 `rtc.node_ip: 127.0.0.1` 추가 시 즉시 연결(2브라우저 상호 오디오 실측). 대조 실험 완료 — 방향 확정.

## 구현 계약
1. **compose** (`infra/rust/docker-compose.rust.yml` livekit 서비스): entrypoint에서 `MOMO_LIVEKIT_NODE_IP`가 비어 있지 않으면 `--node-ip "$MOMO_LIVEKIT_NODE_IP"`를 livekit-server 인자로 추가. **비었으면 현행 그대로**(자동 감지 — 기존 배치 무영향). environment 블록에 passthrough 추가. livekit v1.13.3의 `--node-ip` 플래그 실존과 rtc.node_ip와의 동치성을 기동 로그로 증명하라(불일치하면 config 파일 templating 대안을 쓰되 계약은 동일: env 1개로 광고 IP 제어).
2. **생성기** (`scripts/self_host_env.sh`): 생성 env에 `MOMO_LIVEKIT_NODE_IP=127.0.0.1` 기본 포함 — 로컬 quickstart의 브라우저는 같은 호스트다. 기존 env 파일에는 소급 주입하지 않는다(기존 파일 불변 규율 준수). 주석으로 "LAN/원격 클라 배치면 이 값을 그 호스트의 클라 도달 가능 IP로" 한 줄.
3. **문서** (`docs/SELF_HOST.md` 허들 절 있으면 거기, 없으면 적절한 위치): 허들 프로파일 사용 시 node_ip 의미 3줄 — 로컬=127.0.0.1, LAN=호스트 IP, 미설정=자동 감지(컨테이너 브리지라 대개 외부 도달 불가).
4. 다른 서비스·시크릿·볼륨 무접촉. VM Funnel 경로(external_tls/TURN)는 이 티켓 범위 밖.

## red proof (선행 커밋)
- compose config 렌더: env 설정 시 인자 포함·미설정 시 부재 (둘 다 단언).
- 실기동(가능하면 huddle 프로파일 + 임시 키): 기동 로그 `"nodeIP": "127.0.0.1"` 반영. docker 불가 환경이면 entrypoint 셸 로직 단위 검증으로 대체하고 그 사실 명기.
- self_host_env.sh: 신규 생성 env에 키 존재 + 기존 env 재실행 시 미주입 + 중복 키 거절 경로 회귀.

## 완료 절차
게이트(스크립트 셸체크·해당 검증) 자가 실행 → 커밋(#1856 참조) → push → PR(base=track/engine, 본문에 red proof) → 정지. 마지막 출력에 PR URL과 변경 요약.
