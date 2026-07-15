# 03 · Slack은 어떻게 지었나 — 회사가 크며 순서대로 만난 문제들

> 최종 대조: 2026-07-15 · 출처: slack.engineering 공식 포스트(각 절 말미 링크) · 수치는 발표 당시 기준

Slack의 아키텍처사(史)는 "처음부터 잘 지은 이야기"가 아니라 **문제가 터질 때마다 계층을 하나씩 추가한 이야기**다. momo에게 가치 있는 것은 최종 형태가 아니라 각 계층이 **왜, 언제** 필요해졌는가다.

---

## 1. 실시간 경로 — 쓰기는 HTTP, 배포는 websocket (M1·M3)

Slack 클라이언트는 websocket 하나를 유지하지만, **메시지 전송은 websocket이 아니라 HTTP POST**다. 경로: 클라이언트 → Webapp API → Admin Server → **Channel Server** → 전 세계 Gateway Server → 구독 클라이언트. 전 세계 전달 목표 500ms.

- **Channel Server(CS)**: 채널 ID를 consistent hashing으로 특정 CS에 매핑 — **채널당 순서 부여 지점이 정확히 하나**가 되는 장치다. 피크 시 호스트당 약 1,600만 채널을 서빙하고, 죽은 CS는 20초 안에 교체된다.
- **Gateway Server(GS)**: websocket 종단 + 유저별 구독 상태. 유일하게 여러 지역(edge)에 배포된다.
- 순서의 진실은 메시지 `ts`(epoch초.시퀀스) — 채널 내 유일 ID이자 정렬 키.

**momo 대응**: momo의 단일 쓰기 경로(REST→PG→outbox→relay)는 이 구조와 동형이다. Slack의 CS가 하는 "채널당 단일 직렬화" 역할을 momo에선 `channel_seq` 행 잠금이 한다(02장 §3). 차이는 규모뿐 — 채널이 수억 개가 되면 그 직렬화 지점을 DB 밖의 전용 서버로 꺼내게 된다는 것이 Slack의 증언이다.

- https://slack.engineering/real-time-messaging/

## 2. Flannel — "부트 페이로드 폭발"의 사후 수습 (M10)

초기 Slack은 접속 시 `rtm.start` 한 방으로 **워크스페이스 전체 스냅샷**(전 유저·채널·봇 메타데이터)을 내려받았다. 조직이 커지자 두 가지가 부서졌다: 부트 페이로드가 조직 크기에 비례해 폭발했고, 사무실 정전 복구 같은 동시 재접속(reconnect storm)이 백엔드를 연쇄 붕괴시켰다.

Flannel은 이를 수습하기 위해 edge PoP에 배치한 애플리케이션 캐시다 — 클라이언트와 코어 사이에 앉아 팀 데이터를 대신 들고, lazy-loading 쿼리 API를 제공한다. 효과: 피크 400만 동시 연결, 부트 페이로드 최대 44배 감소, 재접속이 edge에서 흡수돼 코어에 도달하지 않음.

**momo 교훈**: Flannel은 감탄할 대상이 아니라 **회피할 대상**이다. 문제의 근원은 "부트 시 전체 상태 다운로드" API 설계였다. momo가 roster/채널 목록/히스토리를 처음부터 페이지네이션·lazy-loading으로 설계하면(ux-bible P6) Flannel 같은 계층은 아주 오랫동안 불필요하다.

- https://slack.engineering/flannel-an-application-level-edge-cache-to-make-slack-scale/

## 3. 저장 계층 — 테넌트 샤딩의 죽음과 Vitess (M10)

초기: MySQL을 **워크스페이스 단위 샤드**로 운영. 이 모델은 두 번 부서졌다:

1. **가장 큰 테넌트가 단일 최고사양 호스트의 한계에 도달**했다. 대부분의 샤드는 놀고 일부만 포화 — 테넌트 단위 샤딩은 부하를 재분배할 수 없다.
2. **Slack Connect(회사 간 공유 채널)가 "한 채널 = 한 워크스페이스" 전제를 깨뜨렸다.** 크로스 테넌트 기능이 생기는 순간 테넌트 샤딩 모델 자체가 무너진다.

그래서 3년(2017~2020)에 걸쳐 Vitess로 이전하며 **메시지를 채널 ID로, 유저 데이터를 유저 ID로** 재샤딩했다. 2020년 말 피크 2.3M QPS, 중앙값 2ms.

**momo 교훈**: 단일 PG인 동안 이 문제는 존재하지 않는다. 준비해 둘 것은 하나 — **모든 메시지 접근이 channel_id를 1급 키로 유지**하는 것(momo 스키마는 이미 그렇다). 그러면 먼 미래의 재샤딩이 "이사"지 "재건축"이 아니다.

- https://slack.engineering/scaling-datastores-at-slack-with-vitess/

## 4. Presence — 공개적으로 후퇴한 기능 (M5)

초기 Slack은 워크스페이스 내 모든 유저의 상태 변화를 모든 클라이언트에 브로드캐스트했다 — O(N²) 트래픽. 대형 팀에서 파산하자 2017년 **구독 모델로 API 계약 자체를 바꿨다**: 클라이언트는 화면에 보이는 유저만 `presence_sub`로 구독하고, 2017-11-15부터 구독 없는 presence 이벤트 송신을 아예 중단했다.

**momo 교훈**: N이 수십인 동안 O(N²)항은 존재하지 않는다 — momo의 ADR-0104는 단순한 연결 기반 presence로 시작해도 된다. 단, **클라이언트 API를 처음부터 "구독" 문법으로** 내면(전체 브로드캐스트를 계약으로 약속하지 않으면) Slack처럼 공개 후퇴할 일이 없다.

- https://api.slack.com/changelog/2017-10-making-rtm-presence-subscription-only

## 5. 푸시 알림 — 전송이 아니라 판정이 본체 (M6)

Slack 알림 경로: webapp(판정) → job queue → push service → APNs/FCM. 복잡도의 90%는 판정에 있다: 활성 클라이언트 존재 여부, 기기·채널별 설정, DND를 조합해 "보낼지, 어느 기기로"를 결정한다. `@here` 하나가 수십만 유저×복수 기기로 팬아웃된다. 2026년 리빌드의 핵심 결론: **"어떤 활동이 알림을 만드는가(activity)"와 "어떻게 전달하는가(delivery)"를 분리**하고 판정 로직을 한 곳에 모을 것.

**momo 교훈**: ux-bible P9("알림 판정 로직은 서버에 단 하나")가 정확히 이 교훈의 성문화다. momo의 push notifier는 outbox 이벤트를 소비하는 단일 프로세스로 시작해, unread(M4)·멘션·DND 판정을 처음부터 한 곳에 두면 된다.

- https://slack.engineering/how-slack-rebuilt-notifications/ · https://slack.engineering/tracing-notifications/

## 6. Job queue — outbox의 대형판 (M2)

Slack의 job queue(일 14억 잡)는 원래 Redis 단독이었는데, 폭주 시 dequeue가 메모리를 요구하는 구조 탓에 큐가 잠기는 데드락 장애를 겪었다. 해법은 Redis 교체가 아니라 **내구성 있는 Kafka를 앞단 버퍼로 추가** — 폭주가 "장애"에서 "적체"로 바뀌었다.

**momo 교훈**: momo의 transactional outbox가 정확히 이 구조의 소형판이다(PG가 내구 버퍼). 번역되는 실무 교훈: **outbox 깊이(미처리 행 수)를 1급 운영 지표로 모니터링하고, consumer(relay/worker) 속도 조절 수단을 둘 것.**

- https://slack.engineering/scaling-slacks-job-queue/

## 7. 멀티 리전의 진실 — 데이터는 한 곳, edge는 전달만 (M10)

널리 오해되는 지점: **Slack은 멀티 리전 서비스가 아니다.** 스토리지와 코어는 AWS us-east-1 단일 리전(다중 AZ)이고, 전 세계에 깔린 것은 edge PoP(TLS 종단, websocket 종단, Flannel 캐시, 파일 캐시)뿐이다. 리전 내 복원력은 cellular architecture(서비스를 AZ 단위로 사일로화, 장애 AZ를 5분 내 drain)로 확보하고, 데이터 위치 규제는 별도 제품 기능(Data Residency)으로 푼다.

**momo 교훈**: "글로벌 서비스 = 데이터 멀티 리전"이 아니다. Slack조차 코어는 한 곳이다. momo의 리전 전략은 ① 서버(=워크스페이스)를 사용자와 가까운 리전에 **하나** 세우고 ② 먼 미래에 필요해지면 TLS/websocket 종단만 edge로 꺼내는 것 — 데이터 분산은 목록에 없다.

- https://slack.engineering/slacks-migration-to-a-cellular-architecture/ · https://slack.engineering/traffic-101-packets-mostly-flow/

## 8. 이 장의 요약

| Slack이 만난 문제 | 그들의 해법 | momo 번역 |
|---|---|---|
| 채널 순서 부여 지점 | Channel Server 단일 매핑 | channel_seq 행 잠금 (이미 동형) |
| 부트 페이로드 폭발 | Flannel edge 캐시 (사후 수습) | 처음부터 lazy-loading API (예방) |
| 테넌트 샤딩 붕괴 | Vitess 채널 샤딩 3년 이전 | channel_id 1급 키 유지 (이미) |
| presence O(N²) | 구독 모델로 공개 후퇴 | 처음부터 구독 문법 (ADR-0104) |
| 알림 판정 산재 | activity/delivery 분리 리빌드 | 단일 notifier + P9 (설계 예정) |
| 잡 큐 폭주 데드락 | Kafka 내구 버퍼 추가 | outbox 깊이 모니터링 (운영 항목) |
| 글로벌 지연 | edge PoP + 코어 단일 리전 | 리전 하나 잘 고르기, edge는 먼 미래 |
