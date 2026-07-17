# ADR-0122: 음성 허들과 회의 지능 — LiveKit 미디어 + 에이전트 Work 회의록

- Status: **Proposed** (2026-07-15 draft → **2026-07-18 착수 재기안**, Fable — 성재 D1~D3 승인 대기)
- 관련: `research/15-platform-expansion/05-voice-huddles-meeting-intelligence.md`(조사 원문·출처), `04-threads-reactions-audit.md`(허들 스레드 게시의 전제), ADR-0111(Work=agent_run — v2 요약의 실행 개체), ADR-0002(compose 레이어링), ADR-0113/0116(녹음 산출물 저장은 Drive 트랙 동결 계약과 합류), ux-bible P8·P14
- 발단: 성재 발제(2026-07-15) "스레드 허들이나 디스코드처럼 음성 채널 + 가능하면 메신저 레벨에서 회의록과 요약 기반 액션아이템 도출"

## Context (요지 — 근거는 research/15-05)

1. **Slack 허들조차 Amazon Chime SDK 위탁**이다. 허들의 본질은 미디어 기술이 아니라 "채널에 바인딩된 임시 룸 + 수명주기의 채널 환류"라는 데이터 모델이고, 그 데이터 모델은 momo가 이미 잘하는 것(PG SoT + outbox + 채널 원장)이다.
2. 동체급 선례가 수렴한 분업: **메신저가 룸 수명주기·권한·토큰을 소유하고 SFU는 미디어만**(Element Call 패턴). Mattermost Calls는 "메신저+미디어 데몬+job 오프로더+whisper.cpp 전사"라는 파이프라인 전체의 동형 선례다(단 rtcd/offloader는 AGPL — 코드 참조 금지).
3. permissive 제약에서 미디어 백본 후보는 사실상 **LiveKit(Apache-2.0)** 하나로 압축된다: 단일 노드 의존성 0, TURN 내장(기업망 60~85% relay 필요 — 필수), Swift/JS SDK·녹음(Egress)까지 같은 라이선스. Janus(GPL-3)는 금지 대상, ion-sfu는 중단, Jitsi는 풀스택 과대, mediasoup은 반자작 경로.
4. 15인 음성 worst case ≈ 6.7Mbps — 기존 단일 VPS에 컨테이너 하나로 충분. 요약/액션아이템은 **신규 인프라 0** — momo의 기존 agent_run(승인/비용/감사)이 실행 개체다. Slack이 유료 add-on으로 게이트한 지점을 momo는 원장 게이트로 자연 흡수하며, 수행 주체가 1급 멤버 에이전트라 agent-native 원칙(봇 래핑 금지)과 정합.

## 착수 조건 충족 실측 (2026-07-18 재기안)

초안의 착수 조건("웹 첫 배치(0119 W)와 푸시 서버측(0120 P) 뒤")이 충족됐고, 전제를 코드로 재확인했다:

1. **선행 트랙 완료**: 웹 v0 완주(MOMO-401 종결), 푸시는 서버·relay·iOS 클라이언트(P-1~P-4)까지 전 체인 랜딩. **PushRelay가 실물**이므로 "허들 시작" 알림을 기존 notifier 판정에 후속으로 얹을 수 있다(v0 필수 아님 — 후보 기록).
2. **스레드 전제 성립**: `message.root_id` + `thread` 테이블 + thread 인덱스가 001부터 기존재하고 컨텍스트 조립이 이미 소비 중 — D2-A의 "산출물 허들 스레드 게시"는 스키마 신설 없이 가능(전송 REST의 root_id 개방 범위는 V-1에서 실측·필요 시 동티켓 개방).
3. **클라이언트 3종 시대**: 초안 이후 iOS v0(ADR-0123)가 랜딩 — V-3(macOS 허들 UI) 뒤에 **V-3b(iOS 참가 UI, livekit swift SDK 공용)** 를 예약한다. iOS는 참가·청취 우선(시작은 후속).
4. **인프라 전제**: compose에 Redis 없음(v1 Egress 때 추가 — 예상대로), huddle 스키마 없음(V-1 신규 migration), ADR-0121 S-1 install.sh가 랜딩돼 있어 V-2의 "설치 반영 지점"이 실물로 존재.
5. **파이프라인**: 구현=codex worker(5.6 sol medium), 리뷰·게이트·머지=Fable(현행 계약). V-3/V-3b는 clients 파일군이라 UX 트랙과 발급 시점 조율(현재 UX는 worktree 분리 안착 — 충돌 리스크 낮음).

## Options

### D1. 미디어 백본
- **A (권고) — LiveKit 채택**: compose에 livekit-server 컨테이너 1개(v0), 내장 TURN 활성화. 시그널링은 LiveKit 자체 WS+JWT — Centrifugo는 대체하지 않는다(전송전용 불변 유지: 허들 시작/참가자 변동/녹음 이벤트만 outbox→relay 브로드캐스트).
- B — Galene(MIT): 초경량이나 공식 Swift SDK 부재. **기각.** / C — 외부 통화 링크 위임(Zulip식): 녹음·회의록을 제품이 통제 불가 — agent-native 회의록 목표와 충돌. **기각.** / D — 자체 SFU: Discord 반증(전담 조직 다년 투자). **기각.**

### D2. 세션 모델
- **A (권고) — Slack형 임시 허들**: 채널/DM에 바인딩된 ad-hoc 세션, 마지막 퇴장 시 소멸, 세션 이력·참가 기록은 PG `huddle` 레코드(REST 단일 쓰기 경로)로 원장화, 산출물은 허들 스레드에 게시(스레드 REST 개방이 전제 — 15-04 제안과 합류).
- B — Discord형 상시 voice 채널: 상시 룸 상태 관리 비용. **기각(v0)** — 수요 확인 후 재검토.

### D3. 단계
- **v0 음성 허들(N≤15)**: livekit-server + REST 수명주기/JWT 발급 + macOS UI(UX 트랙 조율). 신규 인프라: 컨테이너 1, TURN 서브도메인+TLS 1. E2EE 시도 금지(WebRTC 기본 DTLS-SRTP 전송 암호화) — E2EE는 별도 ADR.
- **v1 녹음+사후 전사**: LiveKit Egress(+Redis — 기존 Centrifugo Redis 공유/분리 검토) + whisper.cpp(MIT) 배치 job(참가자별 Track egress → 트랙별 전사 → 타임스탬프 병합 = 화자분리 회피). **동의 UX 필수**(전원 고지+Continue/Leave+채널 시스템 메시지). 산출물 저장은 파일 트랙(ADR-0113/0116) 동결 계약과 합류 — 앞지르지 않는다. 실시간 캡션 제외.
- **v2 요약/액션아이템 Work**: 신규 인프라 0 — 전사 완료 → 채널 초대 에이전트의 agent_run → 승인/비용/감사 게이트 → 액션아이템(담당자·기한·원문 anchor 스키마)을 허들 스레드에 아티팩트 게시. 실체는 프롬프트/출력 스키마/UX 설계.

## Decision (Proposed 권고안)

D1-A + D2-A + D3(v0→v1→v2). 착수 시점은 **웹 첫 배치(ADR-0119 W)와 푸시 서버측(ADR-0120 P) 뒤** — 이 ADR은 방향 고정용이며 Accepted가 즉시 착수를 의미하지 않는다. macOS 허들 UI는 `clients/macOS` — **UX 트랙(성재·momo-main)과 발급 시점 조율 필수.**

## 파생 후보 (Accepted + 착수 결정 후)

| 후보 | 내용 | 비고 |
|---|---|---|
| V-1 | `huddle` 스키마 migration(세션/참가 이력/동의 기록/아티팩트 연결, RLS) + 수명주기 REST + LiveKit JWT 발급 | 서버만 |
| V-2 | compose livekit-server + TURN 도메인/TLS + 버전 핀 + DEPLOY 델타 | infra |
| V-3 | macOS 허들 UI(채널 헤더 시작/참가, live 배지) — livekit client-sdk-swift | **UX 트랙 조율** |
| V-4 | Egress+전사 job 파이프라인(v1) | ADR-0113/0116 랜딩 후 |
| V-5 | 회의록 Work 자동화(v2) | ADR-0114 경계 무관(BYOA 기존 경로) |

## Consequences

- (+) "채널에서 바로 말 걸기"가 permissive 스택으로 성립. 라이선스 리스크 0(전 구성 Apache-2.0/MIT/BSD).
- (+) 회의록·액션아이템이 momo 차별화(실행 원장)의 자연 연장이 된다 — 게이트·감사·비용이 공짜로 따라옴.
- (−) 컨테이너 1개·포트(7880/7881 TCP, UDP range, TURN 443/5349)·도메인 1개 증가 — 셀프호스팅 설치 난이도 소폭 상승(ADR-0121 install.sh에 반영 필요).
- (−) v1 전사 job의 CPU 스파이크(스레드 상한으로 통제)와 한국어 품질 불확실성(staging 실측 게이트).
- 보류: E2EE 음성(별도 ADR), 화상/화면공유(수요 확인 후), 상시 voice 채널, 실시간 캡션.
