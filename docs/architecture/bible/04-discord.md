# 04 · Discord는 어떻게 지었나 — 소수 인원으로 대규모를 버티는 방법론

> 최종 대조: 2026-07-15 · 출처: discord.com/blog 공식 포스트 · 수치는 발표 당시 기준(보이스 2018, 미디어 2017 등 주의)

Discord는 Slack과 같은 문제들을 다른 재료로 풀었고, 특히 **적은 인원·적은 비용으로 극단적 규모를 버틴 방법론**이 뚜렷하다. momo처럼 작은 팀이 배울 것이 많은 쪽은 오히려 Discord다.

---

## 1. Gateway — 프로세스 모델로 fanout을 산다 (M3·M5)

Discord의 실시간 계층은 Elixir(BEAM) 위의 두 프로세스 타입이다: websocket 연결당 **session process**, 서버(길드)당 **guild process**. 길드의 모든 이벤트는 guild process가 접속 세션들로 pub/sub 팬아웃한다. 단일 세션 서버가 최대 50만 라이브 세션을 감당했다.

5백만 동시 유저에서 병목은 팬아웃이었다: 대형 길드 publish 한 번이 최대 2.1초. 해법은 Manifold(송신 작업 자체를 원격 노드로 분산), FastGlobal(핫 룩업을 상수로 컴파일) 등 — 전부 "런타임의 강점을 극한까지 쓰는" 계열이다.

**momo 대응**: momo의 fanout은 Centrifugo가 담당한다(검증된 기성품 — Discord가 Elixir로 직접 지은 것을 momo는 사지 않고 빌렸다). 팀 규모 fanout에서 병목은 오지 않는다. 배울 것은 형태가 아니라 태도 — **병목을 측정으로 특정하고 그 지점만 고친다**(아래 §6).

- https://discord.com/blog/how-discord-scaled-elixir-to-5-000-000-concurrent-users

## 2. 메시지 저장 — (channel_id, 시간정렬 ID)라는 불변의 정답 (M1·M10)

MongoDB(1억 메시지에서 인덱스가 RAM 초과) → Cassandra(2017) → ScyllaDB(2022)로 두 번 이사했지만, **데이터 모델은 한 번도 바뀌지 않았다**: 파티션 키 `(channel_id, bucket)` + 클러스터링 키 `message_id`(시간 정렬 Snowflake). bucket은 10일 단위 시간 창으로 파티션이 100MB를 넘지 않게 자른 것.

Cassandra 시절의 고통은 채팅 특유의 "최근 데이터 삭제" 패턴이 만든 tombstone 지옥(삭제 표식이 쌓여 읽기가 10초 GC 정지를 유발)이었고, ScyllaDB(C++, GC 없음) 이전으로 177노드→72노드로 **줄이면서** 성능을 올렸다. 동시에 DB 앞에 Rust data services를 세워 같은 데이터를 향한 동시 요청을 1개의 쿼리로 합쳤다(request coalescing) — 유명 공지 하나에 수만 명이 몰리는 hot partition을 DB 앞에서 흡수하는 장치다.

**momo 대응**: momo의 `(channel_id, seq)`는 이 정답의 최소 구현으로 이미 동형이다. 훗날 캐시가 필요해지면 Discord의 답이 올바른 첫 형태다: **DB 앞의 얇은 stateless 계층이 coalescing으로 hot channel을 흡수** — DB를 바꾸는 게 아니라.

- https://discord.com/blog/how-discord-stores-billions-of-messages · https://discord.com/blog/how-discord-stores-trillions-of-messages

## 3. Presence — "서버 하나의 작업량은 크기의 제곱" (M5)

Discord 스스로 명시한 명제다: N명이 각자 이벤트를 만들고 N명에게 팬아웃되므로 O(N²). 100만 동시 온라인 길드(Midjourney)에서 해법은 세 겹이었다:

1. **Passive sessions** — 서버를 실제로 보고 있지 않은 연결에는 presence를 아예 안 보낸다. 대형 서버 연결의 약 90%가 passive → 팬아웃 90% 절감.
2. **Relays** — guild process와 세션 사이 중계 프로세스로 팬아웃을 수평 분할.
3. 압축 교체(zlib→zstd streaming)로 클라이언트 대역폭 40% 절감.

**momo 교훈**: "보고 있지 않은 사람에게 보내지 않는다"는 원칙은 규모와 무관하게 옳다. ADR-0104 설계 시 momo도 **화면에 보이는 멤버/채널의 presence만 구독**하는 문법으로 시작하면 Slack(03장 §4)과 Discord의 결론을 모두 선반영하는 셈이다. ux-bible P14와 동일 결론.

- https://discord.com/blog/maxjourney-pushing-discords-limits-with-a-million-plus-online-users-in-a-single-server · https://discord.com/blog/how-discord-reduced-websocket-traffic-by-40-percent

## 4. Read States와 알림 — hot path는 읽음 상태다 (M4·M6)

Discord에서 배지·unread 계산의 SoT인 Read States 서비스는 "접속할 때마다, 메시지가 올 때마다, 읽을 때마다" 불리는 최고 빈도 경로다. Go 구현의 GC가 2분마다 지연 스파이크를 만들자 Rust로 재작성한 것이 유명한 "Go to Rust" 사례다. 알림 쪽은 모든 후보(DM/멘션/팔로우 등)를 Notifications Platform으로 모으고 중앙 서비스가 "버릴지/보낼지/어느 채널로"를 판정한다 — Slack과 같은 결론(판정은 한 곳에).

**momo 대응**: momo의 read_state(ADR-0109)가 정확히 이 SoT 역할이며 이미 서버 소유다. 푸시 판정(M6)이 여기 얹힌다는 의존관계까지 Discord 구조가 확인해 준다.

- https://discord.com/blog/why-discord-is-switching-from-go-to-rust · https://discord.com/blog/building-delightful-notifications-using-ml

## 5. 미디어 — 사후에 비싸게 고친 교훈: 첨부 URL은 처음부터 만료형으로 (M7)

썸네일은 자체 Media Proxy(Go + OpenCV 계열 네이티브 묶음)가 일 1.5억 건 리사이즈. 첨부 원본은 GCS 기반 CDN에서 서빙됐는데 — **원래 링크가 영구·무인증이라 멀웨어 유통 경로로 악용됐고**, 2023년 말 모든 첨부 URL에 서명·만료(24시간)를 강제하는 대공사를 치렀다.

**momo 교훈**: 파일 서빙은 처음부터 **인증 게이트 + 만료형 서명 URL**로. momo의 M7 설계(Drive 트랙이든 자체 스토리지든)에서 협상 불가 항목이다.

- https://discord.com/blog/how-discord-resizes-150-million-images-every-day-with-go-and-c

## 6. 비용 효율의 방법론 — momo가 가장 배울 부분

Discord가 반복해서 보여주는 패턴 5개:

1. **런타임 레버리지** — BEAM 프로세스 모델로 서버 1대당 50만 세션. 직접 짜지 않은 것의 힘. (momo 번역: Centrifugo·PG·Caddy 같은 검증된 기성품이 momo의 BEAM이다.)
2. **hot path만 골라 재작성** — Read States(Go→Rust), 저장(→ScyllaDB), 이미지(Lilliput). 측정으로 특정된 급소만. 전면 재작성은 한 번도 없다(ux-bible P15와 동일 결론).
3. **대역폭 절감을 기능으로 취급** — passive sessions 90%, zstd 40%는 곧 egress 비용 절감.
4. **자체 제작은 비용 근거가 있을 때만** — SFU 자체 제작의 명분은 "최대 성능 = 최저 비용".
5. **저장은 보존 정책을 전제로 파티션 설계를 먼저** — 10일 버킷.

## 7. 재연결 복구 — 프로토콜 레벨 RESUME (M3)

Discord 클라이언트는 `session_id`+마지막 수신 시퀀스 `s`를 보관하고, 재연결 시 RESUME을 보내면 서버가 놓친 이벤트를 순서대로 재생한다. 재생 불가면 전체 재식별(re-Identify).

**momo 대응**: Centrifugo가 같은 기능을 내장한다(offset/epoch 기반 recovery, `recovered: true/false`). momo는 여기에 "recovered:false면 REST로 PG에서 gap fill"이라는 Slack식 폴백을 결합해 두 회사의 답을 모두 갖췄다(02장 §1).

## 8. 이 장의 요약

| Discord가 만난 문제 | 그들의 해법 | momo 번역 |
|---|---|---|
| 대형 길드 fanout | Manifold/relays/passive sessions | Centrifugo에 위임 (팀 규모 무병목) |
| 메시지 저장 스케일 | (channel, 시간ID) 모델 불변 + DB 교체 | (channel_id, seq) 이미 동형 |
| presence O(N²) | 안 보는 사람에겐 안 보냄 (90% passive) | ADR-0104를 구독 문법으로 |
| unread hot path | Read States SoT + Rust | read_state 서버 소유 (이미) |
| 첨부 URL 악용 | 사후 만료형 서명 URL 전환 | 처음부터 만료형 (M7 협상불가) |
| 비용 | 기성품 레버리지 + 급소만 재작성 | 동일 방법론 채택 |
