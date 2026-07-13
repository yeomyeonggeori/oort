# Handoff Packet — UI Wave 2: unread/read-state (MOMO-366/367)

- Status: **active** (2026-07-13, momo-main/Fable · ADR-0109 Accepted)
- 정본: `docs/adr/0109-unread-read-state.md` (D1~D5 + 검증 계약 5항이 수용기준의 뼈대), UX P6/P7/P11.
- 목표: 채널 unread/mention 배지와 키보드 순회 — 10인 내부 테스트에서 채널 2+개를 감당하는 최소 완결.

## MOMO-366 — read-state 서버 계약 `[swift/runtime-agent]` (선행)

1. `GET /v1/workspaces/:ws/read-state` — 호출 멤버 자신의 전 채널 `{channel_id, last_read_seq, latest_seq, unread_count, mention_count}` 1회 응답(D2). 메시지 본문 비포함. read_state 행 부재 채널은 last_read_seq=0으로 계산.
2. `PUT /v1/workspaces/:ws/channels/:ch/read-state` `{last_read_seq}` — `GREATEST` 단조 가드, idempotent, bearer 주체 자신만(403), 트랜잭션 밖 4xx 매핑(D3).
3. 갱신 성공 시 outbox `read_state` 이벤트 → 같은 멤버의 개인 채널로만 relay(타 멤버 비브로드캐스트). Centrifugo 전송전용 불변.
4. `mention_count` v0 = last_read_seq 이후 메시지 중 저장 시점 mention 파싱 결과 기준. 스키마 신설 없이 가능하면 그대로, 필요 시 신규 numbered migration(schema_v0 불변).
5. 서버 단위 테스트: ADR-0109 "검증 계약" 1~5항 전부(head 일치·후퇴 no-op·actor 403·개인 채널 발행·RLS).

## MOMO-367 — unread UI + 키보드 순회 `[swift/macos-ui]` · 의존: MOMO-366

1. 부팅 시 벌크 read-state 1-call 점등, 사이드바 채널 행에 unread 굵기 + mention 숫자 배지(Slack 문법, 357 행 문법 안에서).
2. 뷰포트 렌더 기준 mark-read(debounce ≈1s), 실패 시 재시도 — 서버 커서가 진실(D1/D4), 로컬은 표시 최적화.
3. realtime `read_state` 이벤트 수신 시 배지 동기화(다른 디바이스 반영), 신규 메시지 수신 시 unread 증분은 로컬 계산+서버 재동기화.
4. 키보드 순회: `Cmd+Shift+↑↓` unread 채널 이동(P11) — Cmd+K 스위처(358)와 단축키 충돌 금지, `Cmd+/` 도움말에 추가.
5. 359의 own-send 하단 추적 예외를 이 티켓에서 확정 구현(자기 발화는 항상 최신으로 스크롤+read 처리).
6. light/dark 스냅샷(배지 픽셀 포함), momo-design-taste 준수.

## 검수·머지 절차 (오케스트레이터)

366 랜딩(runtime-agent gate) → 367(design-review + 스냅샷 재기록 + macos-ui gate) → root gate → 라이브 반영·성재 육안(두 채널 배지·순회).
