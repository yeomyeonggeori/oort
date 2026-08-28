# S1 허들 — 오케스트레이터 선행 실측과 결함 분석 (2026-08-28)

환경: v0.1.3 실배포 Funnel VM(cursor.tailb1aad3.ts.net), 외부 크롬(chrome-devtools MCP, isolatedContext), 테스트 계정 Comptest-fable(멤버). RTCPeerConnection 계측+합성 오디오 트랙 주입.

## 결과: 허들 미연결 — 결함 2겹 적발

### 결함 A — 클라 리라이트 미발동 (#1847, PR #1849 랜딩·폐곡선)
- livekit-client는 PC를 **빈 iceServers로 생성** 후 `pc.setConfiguration()`으로 JoinResponse ICE 주입.
- #1825 셰임은 생성자 config만 리라이트 → 실환경 미발동. 라이브 `getConfiguration()`에 `turns:<host>:443` 잔존(계측 실측), ICE checking ~10s 후 드롭 3회 재현.
- 페이지에서 `setConfiguration` 경로 리라이트 임시 패치 → 최종 설정 `turns:<host>:8443` 적용 실측 → TURN 할당 성공(relay 후보 확보). **수리 방향 검증.**
- 수리: #1849가 `prototype.setConfiguration` 인터셉트 추가(host 게이트·idempotent 복원). track/uxui 랜딩.

### 결함 B — 서버축 TURN CreatePermission 거부 형상 (진단 중)
- 리라이트 적용(8443) 후에도 **유일 성립 가능 경로 relay(172.19.0.2:35358/udp,tls) ↔ SFU 내부(172.19.0.2:50025/udp) 페어가 요청 1회 만에 즉시 failed**. responsesReceived=0.
- 원격 srflx(13.59.64.92 등 AWS)와의 페어는 in-progress로 응답 없이 지속 — TURN relay가 permission을 못 열었다는 신호.
- 시그널 WS(`wss://<host>:10000/rtc/v1`)는 정상 open→close(1000). STUN(google/twilio) 701 host lookup 실패는 정상(외부 STUN 도달 불가, 무관).
- 진단 릴레이(livekit 로그·rtc 섹션·UDP 리슨·node/advertise IP) 그록봇 발신 — 응답 대기. **관측치가 node_ip/use_external_ip 오설정 or relay↔SFU permission 경로 문제를 가릴 것.**

## 기타 발견
- Grok Bot 에이전트 `agentModel: hosted-agent` → S4용 generic 자격 발급 원천 차단(409). **S4는 generic 에이전트 신설 필요.**
- 웹 명부 역할 변경 UI 부재(#1848) — 서버 PATCH /role 존재하나 미배선. admin 위임이 curl로만 가능.

## 승계
- S1-a(relay/tls candidate)·S1-b(2대 오디오)·S1-c(soak)는 **결함 B 해소 후** 재개. 미디어 PATH 자체는 SPIKE-HD 3d(외부 TURN ALLOCATE 401)로 기증명.
- ID 정본: workspace=00000000-0000-7000-8000-000000000001, Grok Bot=01a0327f-a57f-7ae6-9bb8-b1a659faa08f(hosted), Comptest-fable=01a046de-07b6-7ec0-ada1-6357ae9cd197.
