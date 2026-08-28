# S1-lite 허들 로컬 실측 + 결함 B(B-1) 수리 방향 실증 (2026-08-28 저녁)

> 스택: `oortv013`(발행 v0.1.3 digest pin) + huddle 프로파일. livekit v1.13.3, 로컬 Caddy CSP는 `ws://127.0.0.1:*` 기허용이라 배선 리스크 0.
> 하네스: livekit-client 2.21 esbuild 번들 + playwright chromium(fake 마이크) 2컨텍스트. `scratchpad/huddle-harness/`.

## 배선 체인 (전부 실측 그린)
1. env 3종 유닛(`MOMO_LIVEKIT_API_KEY/SECRET/URL=ws://127.0.0.1:7880`) 추가, `--compose up -d livekit api`(서비스 명시로 huddle 프로파일 자동 활성).
2. `POST /huddles` → 허들 생성(503 아님 = issuer 구성 인정). `POST /huddles/{id}/join` → `livekitUrl` + JWT 발급.

## 결함 B 동형 재현 → node_ip 실증
| 구성 | nodeIP(기동 로그) | 결과 |
|---|---|---|
| rtc.node_ip 없음(기본) | `172.24.0.8` (docker bridge 자동감지) | 시그널·토큰 통과, **PC 연결 실패** — `ConnectionError: could not establish pc connection` ×2 컨텍스트. UDP 50000-50100이 host에 발행돼 있어도 광고 후보 IP가 브리지라 브라우저 도달 불가 |
| `rtc.node_ip: 127.0.0.1` 추가 | `127.0.0.1` | **PASS** — 양측 `connected`, 상호 remote 참가자 인지, 원격 오디오 구독 1+, inbound-rtp 수신 바이트 A=4,934 / B=6,807 (t=0s 즉시 연결) |

- VM 결함 B(#1856)와 같은 뿌리(브리지 자동감지 광고)를 로컬에서 재현하고, **광고 IP 교정만으로 연결이 성립함을 대조 실험으로 증명**. VM은 외부 클라라 TURN relay 경유 페어링 이슈가 한 겹 더 있지만, "advertise IP가 병인"이라는 진단의 메커니즘 절반이 입증됨.
- 로컬 실험 변경: `infra/livekit.yaml`에 `rtc.node_ip: 127.0.0.1` (워킹트리, 미커밋). 정본 반영은 #1856 수리 설계에서 결정(로컬 셀프호스트 기본값 vs env 노브 — LAN 접속 배치에선 127.0.0.1이 틀리므로 무조건 기본값은 불가).

## S1-lite 판정
- **PASS**: v0.1.3 발행 이미지 + 로컬 셀프호스트에서 허들 생성→join→실브라우저 2자 양방향 오디오 폐곡선.
- 이월: VM(S1-a relay/tls·S1-b 폰 LTE·S1-c soak)은 결함 B 서버 수리 후 — 그록봇 복구 시 릴레이 재개.
