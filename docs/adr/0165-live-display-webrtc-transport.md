# ADR 0165: 라이브 display 스트림 전송 — 처음부터 WebRTC

> Status: **Accepted** (성재 승인 2026-08-15 — 구조화 질의 2회: 방향 "처음부터 WebRTC" + 문서 Accept, D1은 LIVE-1 이탈 판정의 webrtcbin 선언 반영형으로 승인. 잔여: D3 도달성 형상은 스파이크 실측 후 증보)
> Date: 2026-08-15
> 근거 정본: `docs/planning/research/2026-08-15-in-chat-interactive-vm-takeover.md` §2·§4(전송 대조) · 관련: ADR-0125 D10(호스트 직결 attach)·0150(+증보 1)·0156(CubeSandbox)·**ADR-0004 증보 3**(control 경계 — 본 ADR은 전송만, 관측·자격 경계는 그쪽)

## Context

- 관전 축의 전송 토폴로지는 **호스트 직결**이 계약이다: 서버는 capability 토큰만 발급하고 브라우저가 호스트 endpoint에 직접 접속(`bins/momo-server/src/dto.rs:1002` "momo never proxies it"). display 축도 이를 승계한다.
- 업계 전송 3계열: ①noVNC(x11vnc+websockify — E2B가 풀 microVM에 채택) ②WebRTC(Selkies-GStreamer — Kasm 계열, 저지연·고프레임) ③CDP screencast(브라우저 뷰포트 한정). 리서치 권고는 "noVNC 1차 → WebRTC 후속"이었으나, 성재는 **전송 스택 2회 구축(중간 산출물 폐기) 회피 + 저지연 직행**으로 WebRTC 1본화를 결재했다.

## Options

1. **(채택) 처음부터 WebRTC** — 성재 결재. 저지연·고프레임·모바일 유리. 비용: 시그널링·ICE 실측·producer 통합으로 규모 M→L.
2. noVNC 1차 → WebRTC 지연 업그레이드 — **기각(성재 결재)**: 검증된 microVM 선례(E2B)와 단순함이 장점이나 전송 스택을 두 번 짓게 되고 noVNC 산출물이 버려진다.
3. CDP screencast — **기각**: 브라우저 뷰포트 한정이라 풀 데스크톱(터미널·파일시스템 화면) 관전 불가.
4. 서버 경유 SFU/MCU — **기각**: 호스트 직결 계약 위반 + 서버가 미디어 부하·프레임 관측 지점이 됨(ADR-0004 증보 3의 비관측과도 상충).

## Decision

### D1. 전송 = WebRTC 1본, producer = GStreamer `webrtcbin`
microVM 내 **producer** → 브라우저 P2P 미디어. noVNC 경로는 만들지 않는다. producer는 **GStreamer `webrtcbin` 직결**을 선언한다(2026-08-15 LIVE-1 이탈 판정으로 갱신 — 기안 시 1순위였던 Selkies-GStreamer는 입력 datachannel이 제품의 본체라 view-only가 "채널 부재"(D4)가 아니라 "설정"이 되는 구조적 상충으로 강등. 근거=DEVIATION_LOG 2026-08-15·`infra/cubesandbox/display-template/template.spec.json`). 서버 코드는 producer 이름에 무결속이므로 실기동 실측에서 뒤집히면 템플릿 사양 한 필드로 되돌린다.

### D2. 시그널링 = display attach_endpoint (호스트 직결 유지)
display kind의 `attach_endpoint`는 **호스트(VM)의 시그널링 WS URL**이다. 인증은 기존 attach capability 기계(60초 토큰·서브프로토콜) 재사용 — 서버는 시그널링도 미디어도 경유하지 않는다(credential-free URL 검증 등 마이그 023 계열 제약 승계).

### D3. ICE 경계 — TURN은 oort 운영分만
1차는 전용 호스트 공인망의 직결/host-reflexive ICE 실측을 우선한다. NAT 통과 불가 환경이 실측되면 TURN은 **oort 운영 인프라로만** 도입(제3자 TURN 금지 — 미디어가 제3자 경유하면 egress·관측 경계가 깨진다). TURN 도입 여부·좌표는 실측 후 본 ADR 증보.

### D4. view-only 강제 = producer 층
view-only 발급에서는 **입력 datachannel 자체를 개설하지 않는다**(클라이언트 플래그 신뢰 금지 — noVNC의 `-viewonly`와 동일한 원칙을 WebRTC에서 채널 부재로 구현). 입력 채널 개설(control)은 ADR-0004 증보 3의 경계(observer-한정 발급 해제) 이후에만.

### D5. 프레임 비저장
미디어 스트림은 순간 픽셀 전송이다 — 서버·원장·audit에 프레임 비유입, 전사 비저장. 녹화·리플레이는 별건 결정(하려면 저장 경계 증보 선행).

## Slack·업계 비교

Slack huddle 화면공유가 정확히 WebRTC 계열(사람↔사람)이다 — 우리는 같은 전송을 "에이전트 작업 화면"에 쓴다. Kasm/Selkies가 풀 데스크톱 WebRTC 스트리밍의 검증 계열, E2B는 기각한 noVNC 경로, Operator는 전송 미명기(가상 브라우저 뷰).

## Consequences

- (+) 저지연·고프레임·모바일 자연 지원, 전송 스택 이중 구축 회피. 관전(LIVE-1/2)과 control(LIVE-3/4)이 같은 전송 위에.
- (−) 규모 M→L: 시그널링 결선·ICE 연결성 실측(microVM→전용 호스트 포트 노출 포함)·producer 템플릿 통합. **실기동 실측이 머지 관문** — 로컬 불가 시 정직 라벨+전용 호스트 실측 후속.
- (−) 풀 microVM WebRTC는 noVNC 대비 선례가 얇다(Selkies는 컨테이너 중심) — 스파이크 리스크를 LIVE-1 §3 함정에 명시.
- (−) TURN 필요 판명 시 운영 인프라 증설(별도 증보·비용). → **증보 1로 확정됨(2026-08-15 실측).**

---

## 증보 1 — D2·D3 확정: P2P 불가, TURN=필수·전용 공인 호스트, 시그널링=호스트 리버스 프록시 (2026-08-15, SPIKE #1411 실측)

- Status: **Accepted** (성재 승인 2026-08-15 — 구조화 질의. TURN 호스트 신규 운영 자원 확정 포함, 발주는 검토 패키지 후 별도 결재. 실측 근거 정본 `docs/planning/research/2026-08-15-reachability-spike-1411.md`)

### D3-1. 직결·srflx 경로는 존재하지 않는다 — relay가 유일
CubeSandbox microVM의 NAT은 **symmetric**(한 소켓이 STUN 서버마다 다른 공인 포트 — 2회 재현)이고 필터링은 주소 의존적이라 외부 피어는 srflx 후보로 들어올 수 없다(개방 ACG에서도 무응답 실측). **본문 D3의 "1차는 직결/host-reflexive ICE 실측 우선"은 실측으로 폐기** — relay 후보가 유일한 ICE 경로다. producer의 ICE는 relay 강제(`iceTransportPolicy: relay` 상당 — 실패 확정 후보의 수집 자체를 끔).

### D3-2. TURN은 전용 공인 호스트 — CubeSandbox 호스트 동거 금지
microVM↔호스트는 어느 방향으로도 UDP 경로가 없고(`deny_out`의 RFC1918·링크로컬 차단 + 인바운드 반환 유실 실측), 호스트 공인 IP로의 헤어핀도 불가. ⇒ TURN은 **별도 공인 주소의 oort 운영 호스트**여야 한다. 본문 D3의 "제3자 TURN 금지"는 유지, **"CubeSandbox 호스트 동거 금지"** 추가. microVM은 공인 UDP 아웃바운드 개시+응답 수신이 정상(STUN 왕복 36 ms)이라 TURN 클라이언트로는 무저촉. TURN long-term credential 발급 경계는 ADR-0004 증보 3과 교차 확인(후속).

### D2-1. 시그널링 = CubeSandbox 호스트 WS 리버스 프록시 확정
외부 브라우저→호스트 WS 프록시→microVM 왕복 실측 성립(핸드셰이크 13 ms·에코 avg 6.3 ms). ACG는 샌드박스 수 무관 1포트 고정, 클라이언트 IP 보존으로 capability 토큰 검증 지점이 성립. 샌드박스별 공인 포트(DNAT)는 SNAT 강제(클라이언트 IP 소실)+ACG 증식으로 **비채택**. 프록시 앞단 TLS(wss) 호스트 종단 + D2 capability 기계 재사용이 결선 요건.

### Consequences
- (+) LIVE-2 실화면 E2E의 전송 경로가 조건절 없이 확정 — 개방 조건 7항목은 근거 정본 §6.
- (−) **TURN 호스트 1대 신규 운영 자원**(미디어 전량 relay 경유 — 대역폭이 세션 수에 비례). 발주·사양은 성재 결정.
- (−) 부수 발견 8건(F1~F8 — 설치기 rc=0 신뢰 불가·사설 레지스트리 필요·EXPOSED_ENDPOINT 무실체 등)은 전용 호스트 런북 반영 후보(근거 정본 §7).

### 정정 노트 (2026-08-16, INFRA-A #1434 실측 — 결론 불변·근거 문장 정정)
- D3-2의 근거 중 "호스트 공인 주소로도 헤어핀이 안 된다"는 **TCP에서 반증**됐다(전용 호스트 실측: microVM→호스트 공인 IP TLS/HTTP 왕복 성공 — 스파이크는 ACG 미개방 포트로 시험한 것이 원인 추정). **TURN이 실제로 요구하는 UDP 헤어핀은 미측정**이며, D3-1(NAT symmetric → srflx·relay 후보 부재)은 전용 호스트에서도 재확인됐다(후보=링크로컬뿐). 따라서 **"TURN=별도 전용 호스트" 결론은 유지**되고, UDP 헤어핀 재측정은 실기동 E2E(#1438)에 편입 — 측정 결과 동거가 성립해도 이미 발주·설치된 momo-turn이 정본 배치다(비용 소폭·격리 이점).
