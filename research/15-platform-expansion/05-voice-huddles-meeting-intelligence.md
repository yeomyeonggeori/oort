# 15-05 · 음성 허들 + 회의록 파이프라인 선행 조사

> Planning ID: `PLN-20260715-02` 후속 · 수집: 2026-07-15 deep-research (공식 1차 소스 검증) · 발제: 성재 "스레드 허들이나 디스코드처럼 음성 채널 + 메신저 레벨 회의록·요약 기반 액션아이템"
> 용도: ADR-0122 기안 근거. 제약: permissive만(GPL/AGPL 백본 금지), 단일 VPS compose, Centrifugo=전송전용 불변식 유지.

## 0. 핵심 결론

1. **Slack 허들은 Amazon Chime SDK 위에 있다** (AWS 공식 고객 페이지, Slack CPO 인용). 수십조 기업도 미디어 백본을 직접 만들지 않았다 — 허들의 본질은 미디어 기술이 아니라 **"채널에 바인딩된 임시 룸 + 수명주기를 채널 스레드로 환류"하는 데이터 모델**이다.
2. **momo 미디어 백본 정답은 LiveKit(Apache-2.0)**: Go 단일 바이너리, 단일 노드 외부 의존성 0, TURN 내장, Swift/JS SDK 전부 Apache-2.0, 녹음(Egress)까지 같은 생태계. Element Call이 같은 선택을 했다(MatrixRTC+LiveKit — 단 Element Call 프론트엔드는 AGPL이라 패턴만 참조).
3. **모델은 Slack형 임시 허들, Discord형 상시 voice 채널 금지(v0)** — 상시 룸은 라우팅·장애복구 상태 관리 비용을 수반. 마지막 퇴장 시 소멸이 인프라적으로 압도적으로 단순.
4. **"전사=결정적 self-host 파이프라인, 요약·액션아이템=에이전트 Work" 분리는 업계 표준과 합치** (Slack AI huddle notes/Zoom AI Companion 전부 이 구조). momo는 오히려 우위 — Slack이 유료 add-on으로 게이트하는 지점을 momo는 기존 승인/비용/감사 원장(agent_run)으로 게이트하고, Otter식 "정체불명 봇"이 아닌 1급 멤버 에이전트가 수행한다.

## 1. 업계 구현 (요지)

| 사례 | 구조 | momo 교훈 |
|---|---|---|
| Slack Huddles | Chime SDK 위탁. 채널/DM에서 즉석 시작, 유료 50인, 마지막 퇴장 시 소멸, 허들마다 스레드+canvas | 임시 룸 모델 + 산출물은 허들 스레드에 |
| Discord voice | 자체 C++ SFU + 시그널링(전담 조직 다년 투자). 2024 DAVE(MLS E2EE)는 외부 감사까지 다년 프로젝트 | 자체 SFU 금지, E2EE v0 금지의 반증 사례 |
| **Mattermost Calls** | plugin(integrated ~50인) + rtcd(50인+, **AGPL 듀얼 — 코드 참조 금지**) + calls-offloader(job) + calls-transcriber(**whisper.cpp 기반, Apache-2.0**) | 파이프라인 구조가 momo 목표와 동형. 실측: 10분 통화 전사 tiny 2m20s~small 16m50s @1스레드 |
| **Element Call** | Matrix=시그널링·상태·권한, LiveKit=미디어, lk-jwt-service(Go)가 JWT 발급 | **"메신저가 룸 수명주기·토큰을 소유, SFU는 미디어만"** — momo는 REST가 JWT 발급 겸임 |
| Zulip/Rocket.Chat | 외부 통화(Jitsi 등) 링크 위임 | 운영 0이지만 녹음·회의록을 제품이 통제 불가 — agent-native 회의록 목표와 부적합 |

## 2. SFU 지형 (라이선스 검증 완료)

| 후보 | 라이선스 | 판정 |
|---|---|---|
| **LiveKit** (server/Swift SDK/JS SDK/Egress) | **Apache-2.0** | **권고** — 단일 노드 무의존, TURN 내장, 자체 WS 시그널링+JWT |
| Galene | MIT | 예비 — 초경량이나 공식 Swift SDK 부재가 결정적 감점 |
| mediasoup | ISC | 기각 — 서버가 아닌 Node 라이브러리, 룸/시그널링/녹음 전부 자작 |
| ion-sfu | MIT | 기각 — 2023-12 아카이브(유지보수 중단) |
| Jitsi Videobridge | Apache-2.0 | 기각 — Prosody(XMPP)+Jicofo 풀스택 결합, 단일 VPS 과대 |
| **Janus** | **GPL-3.0** | **금지 대상** (공식 COPYING 확인) |
| coturn | BSD | LiveKit TURN 내장으로 불필요 가능성 높음 |

- **TURN은 필수**: 일반망 15~20%, 기업 관리망 60~85%가 relay 필요. LiveKit 내장 TURN을 v0부터 활성화(TURN용 서브도메인+TLS 1개 추가).
- **용량**: 15인 전원 송화 worst case ≈ 6.7Mbps(Opus ~32kbps 기준) — 단일 VPS에서 무시 가능. SFU는 재인코딩 없음. Galene 실측(화상 20인/코어)이 하한 교차검증.
- **시그널링**: LiveKit·Galene 모두 자체 WS 프로토콜 내장 — Centrifugo로 대체 불가하고 할 이유도 없음. Centrifugo는 "허들 시작/참가자 변동/녹음 시작" 이벤트를 outbox→relay로 채널에 브로드캐스트하는 기존 역할만(전송전용 불변).

## 3. 회의록 파이프라인

- **녹음**: LiveKit Egress(Apache-2.0, 별도 컨테이너, **Redis 필요** — momo prod compose에는 Centrifugo용 Redis가 이미 있어 공유/분리 검토만 하면 됨). **참가자별 Track egress 권고** — 트랙별 전사 후 타임스탬프 병합으로 화자분리(diarization) 문제를 인프라에서 회피(Mattermost 동일 접근).
- **전사**: whisper.cpp/faster-whisper(둘 다 MIT). GPU 없는 단일 VPS 전제 → **사후 배치 job**(회의 종료 → 컨테이너 기동 → 전사 → 종료). 실시간 캡션은 v0/v1 제외(base 모델 상시 2~4스레드). **한국어 품질 주의**: large-v3 KsponSpeech CER 11.13%(낭독체 기준) — 회의 도메인 staging 실측 필수.
- **동의**: Zoom 관행 — 녹음 시작 시 전원 고지 + Continue/Leave + 채널 시스템 메시지 기록. v1 수용기준에 포함.
- **요약/액션아이템**: 신규 인프라 0 — 전사 완료 이벤트 → 채널 초대 에이전트의 agent_run(BYOA, 승인/비용/감사) → 산출물(액션아이템: 담당자·기한·원문 anchor)을 허들 스레드에 아티팩트 게시. **스레드 REST 개방(15-04)이 이 게시 표면의 전제**라는 시너지에 주목.

## 4. 하지 말 것 (근거는 본문)

자체 SFU 제작 · GPL/AGPL 채택·코드 참조(Janus, Mattermost rtcd/offloader, Element Call 프론트) · v0 E2EE 음성 · ion-sfu(중단) · Jitsi 풀스택 · mediasoup+자작 시그널링 · TURN 생략 · v0/v1 실시간 캡션 · 무동의 녹음 · Discord형 상시 voice 채널(v0).

## 5. 남은 질문

1. LiveKit 단일 VPS 실측(15인 음성 + 기존 스택 동거 시 CPU/포트) — 음성 전용 공개 실측치 부재.
2. whisper 한국어 회의 도메인 품질 실측(small/medium/large-v3-turbo 비교) 후 모델 확정.
3. Egress Redis: 기존 Centrifugo Redis 공유 vs 분리.
4. huddle PG 스키마(세션/참가 이력/동의 기록/아티팩트 연결)와 RLS — ADR-0122 파생 설계.
5. LiveKit 서버/Egress/Swift SDK 버전 매트릭스 핀 고정.

출처: 전부 공식 1차 소스(AWS/Slack/Discord/Mattermost/Element/LiveKit/Zulip 공식 문서·블로그·LICENSE 파일) — 상세 URL 목록은 조사 원문 기준, ADR-0122에 핵심만 인용.
