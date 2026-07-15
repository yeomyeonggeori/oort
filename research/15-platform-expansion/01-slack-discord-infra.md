# 15-01 · Slack / Discord 프로덕션 인프라 — 1차 사료 정리

> Planning ID: `PLN-20260715-02` · 수집: 2026-07-15 deep-research (공식 엔지니어링 블로그 우선)
> 용도: 바이블 03·04장의 원자료 + ADR-0104(존재감)·푸시/파일/스케일 결정의 업계 근거. 신뢰도 표기: [A]=공식 블로그/문서, [B]=공식 발표의 2차 정리, [C]=언론.

## 1부. Slack

### 1.1 실시간 메시징 경로 — Channel Server / Gateway Server

모든 클라이언트는 웹소켓 하나를 유지하며, 실시간 계층은 Java 4종 서버다: **Channel Server(CS)** — 상태 보유, 채널 ID를 consistent hashing으로 매핑, 피크 시 호스트당 약 1,600만 채널 서빙. **Gateway Server(GS)** — 웹소켓 종단 + 유저별 구독 상태, 유일하게 여러 지리 리전(edge)에 배포. **Admin Server** — 무상태 라우팅. **Presence Server** — 유저 해싱 온라인 상태. 해시 링은 CHARM이 관리, Consul 디스커버리, 죽은 CS는 20초 내 교체. 전송 경로는 `클라 → Webapp API(HTTP POST) → Admin → CS → 전 세계 GS → 클라`, 전 세계 전달 목표 500ms. 타이핑 등 비영속 이벤트도 같은 경로를 타되 DB를 안 거친다.

- momo 시사점: momo의 단일 쓰기경로(REST→PG→outbox→relay)와 동형. CS의 "채널당 단일 직렬화" 역할은 momo에선 PG `message.seq` 채번.
- [A] https://slack.engineering/real-time-messaging/ · [B] https://www.infoq.com/news/2023/04/real-time-messaging-slack/ · [A] https://slack.engineering/migrating-millions-of-concurrent-websockets-to-envoy/

### 1.2 Flannel — edge cache의 존재 이유

Flannel 이전 클라이언트는 `rtm.start` 한 방에 워크스페이스 전체 스냅샷을 받았다 → 부트 페이로드가 조직 크기에 비례 폭발 + reconnect storm 연쇄 붕괴. Flannel은 edge PoP의 애플리케이션 캐시로, 팀 데이터를 대신 들고 lazy-loading 쿼리 API 제공 + 선제 푸시. 효과: 피크 400만 동시 연결·초당 60만 쿼리, 부트 페이로드 1.5K 유저 팀 7배/32K 유저 팀 44배 감소, 재접속이 edge에서 흡수.

- 교훈: 근원은 "부트 시 전체 상태 다운로드" API 설계. 처음부터 페이지네이션/lazy-loading이면 이 계층 자체가 오래 불필요.
- [A] https://slack.engineering/flannel-an-application-level-edge-cache-to-make-slack-scale/

### 1.3 저장 계층 — workspace 샤딩 → Vitess 채널 샤딩

초기: MySQL workspace 단위 샤드(active-active 2대 + metadata cluster). 붕괴 원인 둘: ① 대형 고객 하나가 단일 최고사양 호스트 한계 도달(hot shard, 재분배 불가) ② Enterprise Grid/Slack Connect(공유 채널)가 "한 채널=한 워크스페이스" 전제를 파괴. 2017~2020 Vitess 이전, 메시지=채널 ID·유저 데이터=유저 ID로 재샤딩. 2020년 말 99% 트래픽이 Vitess, 피크 2.3M QPS(읽기 2M/쓰기 300K), 중앙값 2ms/p99 11ms.

- 교훈: 테넌트 샤딩은 최대 테넌트가 하드웨어 한계에 닿는 순간, 그리고 크로스 테넌트 기능이 생기는 순간 끝난다. momo는 channel_id를 1급 키로 유지하면 미래 재샤딩 경로가 열려 있다.
- [A] https://slack.engineering/scaling-datastores-at-slack-with-vitess/ · [A] https://slack.engineering/the-query-strikes-again/

### 1.4 Presence — 브로드캐스트에서 구독 모델로 (공개 후퇴)

초기: 워크스페이스 전원 `presence_change` 브로드캐스트 = O(N²). 2017-06 구독 기반 `presence_sub` + 배치 이벤트 도입, **2017-11-15부터 구독 없는 presence 송신 중단**(API 계약 변경). 현재: Presence Server 해싱 + 보이는 유저만 구독, Flannel pub/sub 전환으로 presence 이벤트 5배 감소.

- [A] https://api.slack.com/changelog/2017-06-batch-presence-and-presence-subscriptions · [A] https://api.slack.com/changelog/2017-10-making-rtm-presence-subscription-only

### 1.5 푸시 알림 — 판정이 본체

경로: webapp(판정) → job queue → push service → APNs/FCM. 판정 = 유저 활성 상태 × 기기 설정 × 채널 설정 × DND. `@here` 하나가 수십만 유저×복수 기기 팬아웃(트레이스 하나에 수십억 span → 알림 플로우 100% 샘플링 트레이싱). 2026 리빌드: 산재한 판정 로직을 **activity(무엇이 알림을 만드나)/delivery(어떻게 전달하나) 분리** + 단일 preference 모델로 정리.

- 교훈: 푸시는 규모 무관 첫날부터 필요하고, 판정 로직은 처음부터 한 곳에(momo: outbox 소비 단일 notifier + ux-bible P9).
- [A] https://slack.engineering/tracing-notifications/ · [A] https://slack.engineering/how-slack-rebuilt-notifications/ · [B] https://www.infoq.com/news/2026/04/slack-new-notification-system/

### 1.6 파일 (공식 단독 포스트 부재 — 조합 근거)

데이터는 AWS(기본 미국 리전), 파일은 기본 private — 공유 채널 멤버에게만 인증 후 서빙, `permalink_public`만 익명. edge에 파일 서빙 서비스(Supra/Miata) + 외부 이미지 대리 fetch·리사이즈 Imgproxy. 구조 = "객체 저장소(원본) + 인증 게이트 + edge 캐시/썸네일 프록시" 3층.

- [A] https://slack.engineering/traffic-101-packets-mostly-flow/ · [A] https://api.slack.com/messaging/files · [A] https://slack.com/help/articles/360035633934-Data-residency-for-Slack

### 1.7 Job queue — Kafka를 Redis 앞에

모든 메시지 포스트·푸시·unfurl·리마인더·빌링이 통과, 피크 일 14억 잡/초당 3.3만. Redis 단독의 결함: dequeue O(n) + 폭주 시 dequeue가 여유 메모리를 요구해 큐 잠김 데드락(2016 실장애). 해법: Redis 교체가 아니라 **Kafka를 내구 버퍼로 앞단 추가**(Kafkagate + JQRelay, Consul lock 토픽당 1개, rate limit). 폭주가 장애 대신 "적체 + 속도 조절"이 됨.

- 교훈(momo): outbox가 같은 역할의 소형판 — outbox 깊이를 1급 지표로, consumer 속도 조절 수단 확보.
- [A] https://slack.engineering/scaling-slacks-job-queue/

### 1.8 멀티 리전 — 데이터는 한 곳, edge는 전달만

Slack은 멀티 리전 서비스가 아니다. 스토리지·코어는 **us-east-1 단일 리전 다중 AZ**, 전 세계엔 edge PoP만(DNS 지리 라우팅, NLB→Envoy TLS/웹소켓 종단, Flannel/Imgproxy/파일 캐시, 나머지는 백홀). 리전 내 복원력은 cellular architecture — AZ 단위 사일로 + 장애 AZ 5분 내 drain(Rotor xDS). 데이터 규제는 별도 제품 기능(Data Residency).

- [A] https://slack.engineering/slacks-migration-to-a-cellular-architecture/ · https://slack.engineering/traffic-101-packets-mostly-flow/

## 2부. Discord

### 2.1 Gateway — Elixir 세션/길드 프로세스

BEAM 위 GenServer 2종: 연결당 session process, 길드당 guild process(이벤트 팬아웃). 5M 동시 유저 병목=팬아웃(Erlang send 30~70μs → 대형 길드 publish 900ms~2.1s). 해법: Manifold(send 작업을 원격 노드로 분산), FastGlobal(핫 룩업 상수화), 세마포어 과부하 차단. 세션 서버 1대 최대 50만 세션.

- [A] https://discord.com/blog/how-discord-scaled-elixir-to-5-000-000-concurrent-users

### 2.2 메시지 저장 — MongoDB → Cassandra → ScyllaDB + Rust data services

1억 메시지에서 Mongo 인덱스 RAM 초과 → 2017 Cassandra: `((channel_id, bucket), message_id)`, message_id=Snowflake, bucket=10일 창(파티션 100MB 이하 유지). 12노드 RF3로 일 1.2억+ 쓰기 sub-ms/읽기 <5ms. 고통: 최근 데이터 삭제 패턴의 tombstone(수백만 삭제 채널 읽기 → 10초 GC 정지). 2022: 177노드 상시 소방 → **ScyllaDB로 9일간 초당 320만 메시지 속도로 수조 건 이전, 177→72노드 축소**. 동시에 Rust data services 계층: request coalescing(동일 데이터 동시 요청→1 쿼리) + channel_id consistent hash 라우팅으로 hot partition 흡수. 읽기 p99 40–125ms→15ms.

- [A] https://discord.com/blog/how-discord-stores-billions-of-messages · https://discord.com/blog/how-discord-stores-trillions-of-messages · [B] https://www.scylladb.com/tech-talk/how-discord-migrated-trillions-of-messages-from-cassandra-to-scylladb/

### 2.3 Presence — "작업량은 서버 크기의 제곱"

N명 각자 이벤트 × N명 팬아웃 = O(N²) (10만 명 = 이벤트 세대당 100억 전달). Midjourney 길드 100만+ 동시 온라인 대응 3겹: ① **passive sessions** — 안 보는 연결엔 안 보냄(대형 서버 연결 ~90%가 passive → 90% 절감) ② **relays** — 팬아웃 수평 분할(릴레이당 15,000 세션) ③ ETS 이전 + sender 분리 + GC 튜닝. 2024: Passive V2(대역폭 35%→5%) + zlib→zstd = 클라 대역폭 약 40% 절감.

- [A] https://discord.com/blog/maxjourney-pushing-discords-limits-with-a-million-plus-online-users-in-a-single-server · https://discord.com/blog/how-discord-reduced-websocket-traffic-by-40-percent

### 2.4 푸시 — 판정 계층만 공개

Notifications Platform으로 전 후보 수집 → ML 기반 Smart Notification Service가 "버림/보냄/어느 채널" 판정 + 상호작용 피드백 루프. 판정 기반 데이터 Read States(읽음 SoT, 최고 빈도 hot path)는 Go LRU GC 스파이크(2분 주기) 때문에 Rust 재작성("Go to Rust" 사례). APNs/FCM 연동 상세는 미공개.

- [A] https://discord.com/blog/building-delightful-notifications-using-ml · https://discord.com/blog/why-discord-is-switching-from-go-to-rust

### 2.5 미디어 — Media Proxy + 만료형 첨부 URL

썸네일: Go Media Proxy + Lilliput(OpenCV/libjpeg-turbo Cgo 묶음), 일 1.5억+ 리사이즈, 리사이즈 중앙값 25ms. 첨부 원본: GCS 기반 CDN — 원래 영구·무인증 링크가 멀웨어 유통에 악용되어 **2023년 말 전 첨부 URL 서명·만료(24h) 강제 전환**.

- 교훈: 첨부는 처음부터 인증/만료형 URL. 사후 전환은 비싸다.
- [A] https://discord.com/blog/how-discord-resizes-150-million-images-every-day-with-go-and-c · [C] https://www.bleepingcomputer.com/news/security/discord-will-switch-to-temporary-file-links-to-block-malware-delivery/

### 2.6 보이스 (개요)

시그널링 + 자체 C++ SFU. 2018년 기준 13리전/30여 DC/850+ 서버, 동시 260만 음성, 220Gbps. etcd 헬스 기반 리전 내 최저부하 배정, 장애 시 클라 재배정 요청. 자체 SFU 명분: "maximum performance and thus the lowest cost".

- [A] https://discord.com/blog/how-discord-handles-two-and-half-million-concurrent-voice-users-using-webrtc

### 2.7 비용 효율 방법론

① 런타임 레버리지(BEAM: 1대 50만 세션) ② hot path만 골라 재작성(Read States/저장/이미지 — 전면 재작성 없음) ③ 대역폭 절감=기능(passive 90%, zstd 40% → egress 비용) ④ 자체 제작은 비용 근거 있을 때만(SFU) ⑤ 저장은 보존 전제로 파티션 설계 먼저(10일 버킷). 인프라는 GCP 단일 클라우드.

## 3부. 공통 질문

### 3.1 순서 보장
양사 공통: **채널 단위 단조 정렬 키 + 채널당 단일 직렬화 지점.** Slack `ts`(채널 내 유일 ID·정렬 키) + CS 단일 매핑. Discord Snowflake message_id + guild process 배포 순서 + 세션별 seq `s`. momo `(channel_id, seq)`는 이 패턴의 최소 구현 — 단일 PG인 동안 순서 문제는 부재.

### 3.2 재연결 복구
Discord = 프로토콜 RESUME(session_id+s 보관, 놓친 이벤트 순서 재생, 불가 시 re-Identify). Slack = 얇은 재부트(Flannel 흡수) + `conversations.history` 커서 gap fill. momo = Centrifugo recovery(offset/epoch, `recovered` 플래그) + `recovered:false` 시 REST PG backfill — 두 방식 모두 보유.

- [A] https://docs.discord.com/developers/events/gateway · https://centrifugal.dev/docs/server/history_and_recovery

### 3.3 작은 규모에서 필요한 것 / 불필요한 것
**첫날부터(정확성 문제)**: 순서 부여 · 재연결 복구 · 푸시 파이프라인+unread/멘션 판정(한 곳에) · 파일 인증 서빙+만료 URL · presence의 "표시"(단일 노드 heartbeat/연결 기반이면 충분 — O(N²)항은 N 수십에선 부재).
**수만 동시 전까지 불필요**: Flannel류 edge cache(단 부트 페이로드 폭발은 API 설계로 지금 예방) · DB 샤딩(단 channel_id 키 유지) · cellular/multi-AZ · relays/passive sessions · ML 알림 필터 · Kafka 버퍼(outbox가 소형판 — 깊이 모니터링으로 번역).

## 미해결 / 후속

1. Slack 파일 저장 내부(S3 버킷 전략·썸네일 파이프라인) 1차 사료 없음 — 인용 시 "공개 자료 조합" 단서 유지.
2. Discord 푸시 전달 인프라(APNs/FCM 연동 계층) 미공개.
3. 수치 연도 주의: Discord 보이스(2018)·미디어(2017)는 당시 기준.
4. 후속 리서치 후보: Discord 검색 인프라(Elasticsearch), Slack 검색/ML 랭킹 — ADR-0105 착수 시.
