# ADR-0109: Unread/read-state — 서버 단일 진실과 경량 점등 계약

- Status: **Proposed** (기안 2026-07-13, Fable / 결정권자: 성재)
- 관련: UX 바이블 P6(부팅 최소 페이로드)·P7(unread가 곧 제품)·P8(알림 예산)·P11(키보드 순회), ADR-0110(roster/realtime 세션 발견), `schema_v0.sql` `read_state`
- 소비처: UI 고도화 Wave 2 (unread 배지·순회 UI). Wave 1(셸/스위처/타임라인)은 이 ADR에 의존하지 않는다.

## Context

- `read_state` 테이블은 schema_v0부터 존재한다(`(workspace_id, member_id, channel_id) → last_read_seq, last_read_at`, RLS FORCE). 그러나 서버 API·클라이언트 UI가 없어 "안 읽음"이라는 제품의 1급 상태(P7)가 비어 있다.
- 10인 내부 팀 테스트에서 채널이 2개 이상이 되는 순간, unread 없는 메신저는 사용 불가에 가깝다. Wave 2 UI 착수 전에 서버 계약을 먼저 고정해야 한다.
- 불변식 준수: Postgres=SoT, 모든 user-visible write는 REST→PG→outbox→relay, 순서 권위는 `message.seq`, 에이전트=`member`(에이전트 read cursor도 동일 모델).

## Decision (Proposed)

### D1. 읽음 커서는 서버 `read_state.last_read_seq`가 단일 진실이다
클라이언트 로컬 추정(마지막 뷰포트 등)은 표시 최적화일 뿐, 진실은 항상 서버 커서다. 디바이스가 늘어도(맥/모바일/재설치) 읽음 상태는 따라온다.

### D2. 부팅 점등은 경량 벌크 API 하나로 한다 (P6)
`GET /v1/workspaces/:ws/read-state`
→ 멤버 자신의 전 채널 `{channel_id, last_read_seq, latest_seq, unread_count, mention_count}` 배열 1회 응답.
- `latest_seq`는 채널 head, `unread_count = max(0, latest_seq - last_read_seq)` 서버 계산(클라 재계산 금지).
- `mention_count`는 `last_read_seq` 이후 메시지 중 자신을 멘션한 것의 수. v0 판정은 서버 저장 시점의 mention 파싱 결과를 사용한다(별도 mention 인덱스는 구현 티켓에서 채택 여부 결정 — 스키마 신설 시 신규 numbered migration, `schema_v0.sql` 불변).
- 메시지 본문은 싣지 않는다. 부팅 페이로드 예산의 1순위 원칙 유지.

### D3. mark-read는 REST 단일 쓰기 경로 + 단조 증가 가드
`PUT /v1/workspaces/:ws/channels/:ch/read-state` body `{last_read_seq}`
- 서버는 `GREATEST(현재값, 요청값)`으로만 갱신(후퇴 금지, idempotent·재시도 안전).
- actor binding: bearer 주체 자신의 커서만 갱신 가능(요청 body에 member 지정 없음). 에이전트 bearer도 동일 규칙.
- 갱신 성공 시 outbox `read_state` 이벤트 → relay → 같은 멤버의 다른 디바이스 개인 채널로 전파(cross-device 배지 동기화). 타 멤버에게는 브로드캐스트하지 않는다(읽음 여부는 v0에서 프라이버시 — read receipt는 명시적 non-goal).

### D4. mark-read 트리거는 클라이언트 뷰포트 기준, 서버는 정책 없음
클라는 "채널 뷰포트에 메시지가 실제 렌더된 시점"의 최고 seq를 debounce(≈1s)해 PUT한다. 서버는 트리거 정책을 강제하지 않는다(P9의 단순 멘탈모델 — 판정 로직은 한 곳, 여기서는 클라 렌더 사실).

### D5. unread 의미론 v0 범위
- 채널 단위 unread/mention 배지만. 스레드 단위 unread(P12), muted 채널 배지 억제, keyword 알림은 명시적 후속(v1+).
- Slack 문법 승계: 배지 = unread 있음(굵게) + mention 수(숫자). 순회(`Cmd+Shift+↑↓` 등)는 Wave 2 UI 티켓 소관.
- 에이전트 멤버의 커서도 동일 테이블·API를 쓴다. 에이전트 컨텍스트 주입("어디까지 읽었나")이 같은 진실을 공유하게 되는 것이 agent-native 이득이다.

## Consequences

- (+) 디바이스/재설치 무관 일관 배지, 부팅 1-call 점등, 에이전트·사람 동일 모델.
- (+) outbox 경로 재사용으로 새 전송 채널 불필요(Centrifugo 전송전용 불변).
- (−) 채널·멤버 곱 만큼 read_state 행 증가 — v0 규모(10인×수십 채널)에서 무시 가능, 인덱스는 기존 `read_state_member_idx`로 충분.
- (−) `mention_count` 서버 계산은 저장 시 mention 파싱 품질에 의존 — 구현 티켓에서 정확도 검증 필요.
- 보류 결정: read receipt(타인에게 읽음 노출), 스레드 unread, muted/notification 정책 연동(P8·P9는 알림 ADR에서).

## 검증 계약(구현 티켓 수용기준 뼈대)

1. 벌크 read-state 응답이 채널 head와 일치하고, 메시지 append 후 unread_count가 서버 재계산으로 증가.
2. mark-read 후퇴 시도(낮은 seq PUT)가 no-op이고 200 idempotent.
3. actor mismatch(타인 커서 갱신 시도)가 403.
4. outbox `read_state` 이벤트가 같은 멤버 개인 채널로만 발행.
5. RLS: 워크스페이스 밖 read_state 접근 불가.
