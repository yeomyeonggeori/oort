# docs/archive — 정본 로테이션 보관소

> **취지(2026-09-01 재편, 성재 지시):** 루트 정본 md는 사람이 읽는 최신 상태·최신 철학만 담고, 지난 기록은 여기서 원문 그대로 추적한다. **이동 시 원문 불변** — 과거 검색·감사는 이 디렉토리에서.

## 색인

| 파일 | 출처 | 내용 |
|---|---|---|
| `ROADMAP-2026H1-M0-M8.md` | `ROADMAP.md` | 2026-08-03 개정판 전문 — 구 M0~M8 체계. **스토어·공증·법무·CI/CD 체크리스트(§4~§7)는 보류 목록으로 여전히 유효** |
| `STATUS-2026-06.md` · `STATUS-2026-07.md` | `STATUS.md` | 해당 월 랜딩 증거 원장 (newest-first) |
| `BUILD_TICKETS-2026H1-legacy.md` | `BUILD_TICKETS.md` | Phase 0/v0 데모 STEPS·티켓 상세, M1~M7 확장, ADR-0101 신원 티켓, MOMO-447, 패브릭 배치 |

기획 내부 트래커의 아카이브는 `docs/planning/archive/` (JOURNAL 월별 · CURRENT_STATE 스냅샷).

## 로테이션 규칙 (momo-main, 월초 플러시 때)

1. `STATUS.md`: 당월+직전월만 유지 — 그 이전 달 항목을 `STATUS-YYYY-MM.md`로 이동.
2. `docs/planning/JOURNAL.md`: 최근 20항목만 유지 — 초과분을 `docs/planning/archive/JOURNAL-YYYY-MM.md`로 이동.
3. `docs/planning/CURRENT_STATE.md`: 스냅샷 최근 6개만 유지 — 초과분을 `docs/planning/archive/CURRENT_STATE-snapshots.md` 맨 위에 prepend.
4. `ROADMAP.md`·`BUILD_TICKETS.md`: 체계가 바뀔 때만 판 단위로 보관(수시 로테이션 없음).
5. 이동은 항상 **원문 그대로**(수정 금지). 새 아카이브 파일을 만들면 이 색인에 한 줄 추가.
