# #1825 브리프 — 허들 TURN URL 포트 리라이트 443→8443 (uxui, 방식 A)

> 성재 결재 2026-08-28: 방식 A(웹 클라 리라이트) 채택·발사. 근거 SPIKE-HD 결론 `claudedocs/spike-hd-funnel-turns/REPORT.md`.
> 새 브랜치 `feat/1825-hd-turn-rewrite`, base=`origin/track/uxui`(381cb9e1). 워크트리 `~/projects/momo-tracks/momo-worktrees/w1825-turn-rewrite`.

## 0. 현황 (실측)

- SPIKE-HD 증명: Funnel 터널이 LiveKit 내장 TURN(8443)까지 미디어를 나른다(외부 인증 없는 ALLOCATE→REALM=livekit·401). **막는 것은 광고 포트 하나**: LiveKit v1.13.3 `external_tls`가 클라에 `turns:<host>:443?transport=tcp`를 하드코딩 방출(업스트림 #4542, tls_port는 서버 리슨 전용). 443은 Funnel 웹 점유 → 브라우저가 웹에 도착.
- TURN 서버는 실제로 **8443에서 응답**한다(3d 증명). credential은 포트 비종속(TURN long-term cred). ∴ 클라가 받은 `turns:...:443`의 **포트만 8443으로 바꾸면** 같은 credential로 relay가 붙는다.
- `huddleRuntime.ts:95` `room.connect(options.livekitUrl, options.token, {autoSubscribe:true})` — ICE는 서버 JoinResponse가 전부. 클라 주입 없음(RA-8 §6.3).

## 1. 설계 계약

1. **리라이트 규칙**: PeerConnection이 쓰는 ICE 설정에서 `turns:` URL의 **포트가 443이고 host가 시그널(livekitUrl) host와 같을 때만** 포트를 8443으로 교체. **username·credential·transport·기타 항목 불변**. `stun:`·기타 host의 turns는 무접촉.
2. **게이트 = host 일치**(새 플래그 없이 자기격리): 셀프호스트는 turns host = 시그널 host = 앱 도메인이라 규칙 발동. **LiveKit Cloud는 turn host가 `*.turn.livekit.cloud`로 시그널 host와 달라 미발동**, 직결도 미발동. 워커는 이 host-비교 게이트가 Cloud/직결을 실제로 배제하는지 확인하고 근거를 PR에 적을 것. host 비교로 불충분한 실측이 나오면 정지·보고(임의 플래그 신설 금지).
3. **구현 지점 택일**(워커 판정, 근거 PR 기재):
   - (a) livekit-client `RoomConnectOptions.rtcConfig`가 서버 ICE와 **병합**되면 그 경로로 turns:8443 추가/치환. 단 credential이 JoinResponse에만 있어 사전 미지면 (b)로.
   - (b) **스코프된 `RTCPeerConnection` 셰임**: connect 직전 설치, PC 생성/`setConfiguration`의 `iceServers`에서 규칙대로 포트 리라이트 후 원본 위임, connect 종료 시 해제. 완성된 config(credential 포함)에 작용하므로 자격 불요. 전역 오염 없이 huddle 세션 스코프로.
   - 8443은 Funnel TURN 포트 상수로 명명(주석에 SPIKE-HD·external_tls 근거). 매직넘버 금지.
4. **비UI 변경**: 사용자 표면·문자열 0 → design-review 불요(비주얼 없음을 PR에 명시). CSP 경로(#3b에서 시그널 :10000 등록)는 이미 배치측 소관 — 이 티켓은 미디어 candidate만.

## 2. red proof (vitest)

- 리라이트 함수 단위: `turns:<sigHost>:443?transport=tcp`(+username/credential) → `turns:<sigHost>:8443?transport=tcp`, **credential/username 보존**.
- host 불일치(`turns:other.turn.livekit.cloud:443`) → **불변**(Cloud 회귀).
- `stun:` 항목·443 아닌 turns·직접 candidate → 불변.
- 게이트: 시그널 host 파싱이 `livekitUrl`의 wss host와 일치 판정.
- (셰임 방식이면) connect 후 원본 `RTCPeerConnection` 복원(누수 0) 테스트.

## 3. 게이트 (전부 자가 실행, 그린 로그 PR 코멘트 동반)

`scripts/design_preflight_web.sh`(비주얼 0이라도 스캔 통과 확인) · clients/web lint/vitest/tsc/build · gitleaks. 폰 영향 시 make ts-check/ts-test.

## 4. 정지 조건 (정지 시 push 없이 보고만)

- host-비교 게이트가 Cloud/직결을 확실히 배제 못 하는 실측(오발동 위험) — 임의 플래그 신설 대신 정지·보고.
- livekit-client SDK가 rtcConfig 병합도 PC 셰임도 안 먹는 구조(리라이트 주입점 부재) — 정지·보고(서버측 대안=#1825 방식 B 재검토 신호).
- 서버 코드·`schema` 접촉이 필요해 보일 때(이 티켓은 웹 전용).

## 5. 금지·완료

- 서버 접촉 금지 · 전역 RTCPeerConnection 영구 오염 금지(세션 스코프 해제) · merge/close 금지 · force push 금지 · 커밋 한국어.
- **실브라우저 2대 오디오 왕복(SPIKE-HD 4·5)은 이 티켓의 코드가 아니라 랜딩 후 오케스트레이터가 Funnel VM+외부 2대로 검증** — 워커는 단위까지, PR NOTES에 "실검증 이월" 명시.
- 완료 = push + PR 생성(제목 `#1825`, base=track/uxui, 리라이트 규칙·게이트 근거 요약) 후 정지.
