# ADR-0171: hosted 에이전트 도어벨 푸시 — 커넥션 단위 webhook wake

- Status: **Accepted** (2026-08-24 성재 승인 — "승인할게 작업 진행해줘". 기안 같은 날, Fable)
- 관련: ADR-0162(Agent Port·hosted durable inbox — pull 정본), ADR-0004(provider 자격증명 비유입), #1264(momo-webhook-sender 송신 체계), OutboundHTTPPolicy(ADR-0170 D3 계열 egress 통제), outbox 생산자 트리거 단일 하드 룰
- 실측 근거: `research/2026-08-24-grokbot-webhook-doorbell.md` — 그록봇 루틴 `{type:webhook}` 트리거 실존, **2026-08-24 라이브 실측: POST(Bearer)→HTTP 200+`runUuid` 0.95s, POST→봇 ACK 발화 총 지연 9s**(T0 08:51:35Z → ACK 자기보고 08:51:44Z, endpoint `api2.cursor.sh/automations/webhook/<uuid>`). 8/16 "인바운드 전무" 기준선 폐기.

## Context

hosted 에이전트(그록봇 등)의 현행 전달은 **pull 전용**이다: 멘션이 durable inbox에 쌓이고, 에이전트 루틴이 Agent Port를 폴링해야 가져간다. 체감 지연 = 폴링 주기이고, 고빈도 폴링은 벤더 usage 연소·자동 pause 대상이라 비경제적이다(실측: cron 최소 1분).

그록봇 루틴에 웹훅 트리거가 실존함이 확인됐다(루틴별 전용 URL+sender key, POST 즉시 run 시작). oort가 **내용 없는 wake 신호**를 쏘면 에이전트가 스스로 인증된 pull로 일감을 가져가는 "도어벨" 구조가 성립한다. 이는 새 outbound 표면(운영자 제공 URL로의 서버 발신 + 시크릿 보관)이므로 ADR이 선행한다.

## Decisions (요청)

### D1. 도어벨 등록 = hosted connection 단위 옵션
active hosted connection에 운영자가 `doorbell_url` + `doorbell_secret`(Bearer)을 등록하는 tenant-scoped 관리 REST를 신설한다. 시크릿은 AEAD 봉인 저장·write-only(응답·로그에는 마스킹 표시만)·audit 1행. URL은 https 한정 + OutboundHTTPPolicy 재사용(사설망·루프백·링크로컬 차단, redirect 불허). 커넥션 disconnect/cleanup 시 도어벨 등록도 같은 tx에서 소거(HAP-E6 manifest에 종류 추가 없이 connection 부속 데이터로 취급).

### D2. 페이로드 = 신호만 (내용 0)
도어벨 body는 상수형(`{"kind":"oort.doorbell.v1"}`)이다. 메시지 내용·message id·workspace 식별자를 싣지 않는다. 일감의 실체는 항상 인증된 Agent Port pull(`oort_inbox_read`)로만 흐른다 — 기존 `agentwork:` 계약("wake-up일 뿐 신뢰 입력이 아니다")과 동형이며, 제3자 인프라(Cursor)에 넘어가는 정보를 0으로 유지한다.

### D3. 발화 지점 — 신규 outbox 생산자 없음
hosted inbox append는 이미 원본 트랜잭션 안에서 일어난다(HAP-E5). 도어벨 dispatch는 **기존 momo-webhook-sender 송신 체계에 "doorbell" 대상 유형으로 편입**해 그 파생을 소비한다 — outbox 생산자 트리거 신설 없음(하드 룰 준수), Centrifugo 무관, 단일 쓰기경로 불변. 전달 보장은 best-effort at-least-once(중복 도어벨 무해 — 루틴은 cursor 기반 pull이라 멱등).

### D4. 코얼레싱·쿨다운
커넥션당 leading-edge 발화 + 쿨다운 창(기본 60s, 설정 가능). 창 내 추가 이벤트는 trailing 1회로 합쳐진다. 근거: 도어벨 1회 = 벤더 쪽 루틴 run 1회 = usage 소모이므로 버스트를 1회 wake로 흡수하고, 루틴은 어차피 pending 전부를 pull한다. "every message" 소음 금지 가이드와도 정합.

### D5. 실패 봉쇄·관측·폴백
- 쓰기경로 무영향: 도어벨 실패는 메시지 랜딩·inbox 적재에 어떤 영향도 없다. 타임아웃 10s, bounded retry(≤2, 지수 백오프), 그 이상은 포기+audit.
- 커넥션 projection에 `doorbell_last_fired_at`·`doorbell_last_status` 노출(운영자 가시성 — silent no-fire 감지 근거).
- 폴백 성문화: 도어벨은 가속기일 뿐 정본 전달은 여전히 durable inbox다. 표준 루틴 지시문에 저빈도 스윕(15분 cron)을 병설해 no-fire를 회수한다(WD-3).

### D6. 게이트
`MOMO_DOORBELL_ENABLED` 기본 off(소문자 `true`만 개방 — 기존 게이트 문법). 근거: 대상 표면(그록봇 webhook 트리거)이 아직 공식 문서 미기재 베타라 예고 없는 변경 가능성이 있어, 개방은 운영자 명시 결정으로 둔다.

### D7. 루프 방지 확인을 수용기준에 결속
에이전트 자기 발화가 자기 inbox 이벤트→도어벨로 순환하지 않음을 red proof로 고정한다(Q-LOOP). inbox가 멘션·job 참조만 적재하는 현행 설계상 자기 멘션이 없는 한 순환이 없어야 하며, 이를 테스트로 성문화한다.

## 커스터디·약관 판정

- 도어벨 시크릿은 **모델 provider 자격증명이 아니다**(모델 접근 불가, wake 전용) — ADR-0004 비유입 불변식과 무관하게 성립하나, 시크릿 취급 규율(AEAD·마스킹·audit)은 동일 적용.
- webhook 트리거는 제품이 제공하는 표면이며(포럼 스태프가 외부 주입의 공식 대안으로 안내) CDP류 UI 우회가 아니다. 잔여 리스크는 "undocumented 베타" 하나 — D6 게이트 + D5 폴백이 완충.

## 대안 기각

- **Slack 경유 도어벨**: bot-authored 메시지 트리거의 반복 회귀(2026-04→05→08)·silent no-fire·public 채널 강제 — 프로덕트가 의존할 계약 경로 아님.
- **1분 cron 폴링**: usage 상시 연소·장기 방치 자동 pause·지연 하한 1분 — 도어벨의 폴백(15분 스윕)으로만 유지.
- **VM 내부 gateway(`/api/sendPrompt`)**: 내부 undocumented API — CDP급 회색지대 회귀, 사용 금지.
- **페이로드에 일감 요약 동봉**: 제3자 인프라로의 내용 유출 + 신뢰 입력화 — D2로 기각.

## 수용기준 스케치 (티켓 상세는 패킷)

- WD-1(engine): D1~D7 서버 구현 + red proofs(시크릿 마스킹·SSRF 거부·쿨다운 코얼레싱·disconnect 소거·자기순환 부재) — flag 기본 off에서 라우트 부재/무동작 byte-동일 검증.
- WD-2(uxui): Agent Hub 커넥션 패널 도어벨 등록 UI(URL/키 입력·마스킹·"벨 테스트" 버튼·last-fired 상태 4상태) — design-review Blocker 0.
- WD-3(docs): SELF_HOST_AGENT.md 증보 — 프로덕션 루틴 표준 지시문(도어벨 수신→`oort_inbox_read`→처리→`oort_message_post`→없으면 침묵) + 15분 스윕 폴백 + 도어벨 등록 절차.
- E2E 수용(성재 검수): oort 멘션→도어벨→루틴 run→Agent Port pull→에이전트 명의 응답 랜딩, 목표 p50 ≤ 90s.
