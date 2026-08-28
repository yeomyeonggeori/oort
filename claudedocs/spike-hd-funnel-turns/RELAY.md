# SPIKE-HD 릴레이 시트 (#1792)

> 사용법: 아래 「릴레이 1」 블록을 grok.com D8 대화에 그대로 붙여넣는다. 그록봇의 답을 그대로 Fable 세션에 붙여넣으면 판정 후 다음 단계를 준다.

## 릴레이 1 — VM 내부 관측 + TURN 배선 (그대로 붙여넣기)

```
허들 미디어 스파이크를 진행하자. 목표: LiveKit 내장 TURN을 Funnel TLS 종단 TCP(8443)로 노출.
외부 망에서 8443 TLS 악수는 이미 성공 확인됐다(Let's Encrypt 정식 인증서). 이제 VM 안쪽 배선이 필요하다.

먼저 관측만 하고 보고해줘 (변경 전):
1. tailscale funnel status — 8443에 기존 매핑이 있는지, 있다면 어디로 가는지.
2. oort 스택의 livekit.yaml 현재 turn 섹션 (없으면 "없음").
3. MOMO_LIVEKIT_URL 현재 값과, 웹이 LiveKit 시그널에 어떻게 닿는지(Caddy 경유 여부).
4. VM 로컬 8443 포트에 지금 무엇이 리슨 중인지 (lsof/ss 한 줄).

관측 결과 8443이 비어 있거나 이미 LiveKit용이면, 이어서 적용해줘:
5. livekit.yaml에 추가:
   turn:
     enabled: true
     external_tls: true
     tls_port: 8443
     domain: cursor.tailb1aad3.ts.net
6. compose에서 livekit의 8443/tcp를 호스트 127.0.0.1:8443에 바인드.
7. tailscale funnel --bg --tls-terminated-tcp=8443 tcp://127.0.0.1:8443
8. livekit(필요시 api) 재기동 후, livekit 로그에서 TURN 리스너 기동 줄을 확인.

보고 형식: 1~8 각 항목 성공/실패 + 핵심 한 줄. 시크릿·API 키·env 값은 절대 출력하지 마.
중단 조건: 8443에 다른 용도의 기존 매핑이 있으면 5~8을 하지 말고 그 용도만 보고. funnel 명령이 거절되면 거절 문구만 보고.
다른 설정·서비스는 건드리지 마.
```

## 이후 단계 (Fable이 외부에서 실행 — 성재 개입 불요)

- 3단계 검증: 외부 브라우저로 VM oort 접속 → 허들 참여 → webrtc-internals에서 ice_servers에 `turns:<host>:8443` 실림 확인.
- 4단계: 선택된 candidate pair가 relay/tls인지 확인.
- 6단계: 60분 soak 관측 루프.

## 5단계 (성재 폰 1대, ~3분)

Fable이 4단계까지 통과를 알리면: 폰을 Wi-Fi 끄고 LTE로 → `https://cursor.tailb1aad3.ts.net` 로그인 → Fable이 지정한 채널의 허들에 참여 → 서로 목소리 확인.

## 외부 관측 재실행 명령 (기록용)

```
openssl s_client -connect cursor.tailb1aad3.ts.net:8443 -servername cursor.tailb1aad3.ts.net </dev/null
```
