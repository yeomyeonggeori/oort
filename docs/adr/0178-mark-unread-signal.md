# ADR-0178: mark-unread — 단조 read-state 위의 별도 신호

- 상태: **Accepted** (2026-09-01 성재 결재 — 기안 Fable)
- 발제: 2026-09-01 버즈 패리티 감사 B4 (`docs/planning/research/2026-09-01-buzz-parity-audit.md` §4 순위 3) — `messageActionModel.ts` 주석이 "mark unread — PUT read-state is monotone(GREATEST). Accrued."로 자기 기록
- 관련: 우로보로스 인터뷰 interview_20260901_052920

## 맥락

읽음 상태를 사용자가 되돌릴 수 있는가는 메신저의 읽기 모델 자체다. 현행 `channel_read_state.last_read_seq`는 GREATEST로 단조 전진만 한다 — 클라만으로는 mark-unread가 영원히 불가하고, 이 위에 쌓인 소비자(사이드바 배지·UnreadDivider·UnreadPill·⌥↑↓ 항법·폰)가 늘수록 뜯는 비용이 커진다.

## 결정

- **D1 단조성 유지.** `last_read_seq`의 GREATEST 계약은 불변 — 순서 불변식(`message.seq`)의 파생 규율이다.
- **D2 별도 신호.** `channel_read_state`에 nullable `marked_unread_before_seq` 1컬럼 추가. 의미: *"이 seq부터(포함) 다시 안 읽은 것으로 표시하라."*
- **D3 합성 규칙(단일점).** 유효 unread 시작점 = `marked_unread_before_seq`가 있으면 `min(marked_unread_before_seq, last_read_seq+1)`, 없으면 `last_read_seq+1`. 이 합성은 **momo-core 파생 함수 한 곳**에만 존재하고 웹·폰·배지·디바이더·필·항법이 전부 그것을 소비한다 — 소비자 각자가 합성하는 순간 이 ADR은 실패다.
- **D4 해제 = 명시 열람.** 사용자가 그 채널을 실제로 열람(현행 read-state 광고가 발생하는 그 상호작용)하면 서버가 같은 트랜잭션에서 마크를 삭제한다. 새 메시지 도착·타 기기의 과거 광고 재전송은 마크를 건드리지 않는다 — 이것이 "폰이 마크를 즉시 되돌리는" 경합을 원천 차단하는 지점이다(마크는 last_read_seq와 독립이므로 GREATEST 재광고에 밀리지 않는다).
- **D5 계약.** 기존 `PUT read-state` 본문 확장: `markUnreadBeforeSeq`(설정) — 값은 해당 채널에 실존하는 seq여야 하며 미래 seq 거부. 해제는 별도 동사 없이 D4의 열람 경로가 수행. `require_human`(에이전트 read-state 무관 현행 유지).

## 기각 대안

- **last_read_seq 되돌림(단조성 파괴)**: 멀티 디바이스 경합의 고전 버그 — 데스크탑에서 마크한 것을 폰의 자동 read 광고가 즉시 재전진. 알림 dedupe·워터마크 등 단조 가정 소비자 전수 재검토 비용. 기각.
- **클라 로컬 마크**: 기기 간 불일치 — "폰에서 안 읽음으로 남겨둔 것"이 데스크탑에 없다. 기각.

## 영향·게이트

- 스키마: `channel_read_state` 컬럼 1 추가 마이그레이션. `schema_v0.sql` 무접촉.
- red proof: ①마크 후 타 기기 구식 광고 재전송 → 마크 생존 ②명시 열람 → 마크 소멸 ③미래 seq 거부 ④합성 단일점 외 합성 코드 0건(grep 게이트).
- 소비자 회귀 금지: 배지·디바이더·필·⌥↑↓ 기존 시험 전부 그린 + 마크 상태에서의 각 표면 시험 추가.
