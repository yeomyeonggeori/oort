# 계획 이탈 로그 (Deviation Log)

> 목적: 구현이 기획(티켓 수용기준·ADR·아키텍처 정본)과 달랐던 지점을 놓치지 않고 기획 레이어로 환류한다. (`docs/planning/README.md` §5)
> 기록 주체: 오케스트레이터(momo-main), 머지 시점. 판정 주체: 기획 레이어(+성재 승인).
> 상태: `pending`(판정 대기) → `accepted`(정본 반영) / `rejected`(복구 티켓) / `noted`(기록만).

| 날짜 | 출처 (티켓/PR) | 이탈 내용 | 오케스트레이터 분석·리서치 | 상태 | 판정·후속 |
|---|---|---|---|---|---|
| 2026-07-10 | MOMO-337 / PR #310 | 핸드오프는 `/gateway/jobs/pending`을 기존 경로로 전제했으나 실제 코드에는 없었다. 수용기준의 4-route bearer 이관을 닫기 위해 actor-bound pending recovery endpoint를 신설했다. | Postgres/outbox SoT와 REST 경계를 유지하고 `available_at <= now()` 및 token actor binding을 강제하므로 제품 경계 변경이 아닌 누락된 recovery surface 보완으로 판정했다. 다만 bearer 사용 audit write 증폭을 피하려면 adapter가 realtime-first여야 한다. | `accepted` | MOMO-338 #308에 realtime-first, bounded reconnect/recovery, idle tight polling 금지를 추가. |
| 2026-07-10 | MOMO-338 / #308 | 어댑터 bearer 단일화 리뷰에서 기존 `agent:` namespace가 user-visible status/partial과 Context Packet job을 함께 운반해 같은 채널 관찰자에게 private work가 노출되는 문제를 발견했다. Python 범위를 넘어 `agentwork:` namespace와 서버 proxy/config를 추가했다. | `agent:` 전체를 self-only로 만들면 기존 macOS working UX와 MOMO-212 live gate가 깨진다. 따라서 ADR-0101에 observable progress와 exact-actor private work 분리를 반영하고 dev/local-alpha/prod config를 함께 갱신했다. 다중 gateway 인스턴스의 provider 중복 실행은 durable claim/lease 없이는 닫히지 않아 후속 서버 티켓으로 분리한다. | `accepted` | MOMO-338 merge에 `agentwork:` self-only regression 포함. 후속: MOMO-341 claim/lease + takeover. |
| 2026-07-15 | MOMO-390 / PR #403 (선재 발견 보고) | 이 PR의 이탈이 아니라 main 기저(e35be71)의 기존 결함 발견: `verify_staging_smoke.sh`/`verify_internal_hosting_smoke.sh`가 `agent/ch/dm/user` 4개 namespace만 기대해 `centrifugo.prod.json`의 `agentwork` namespace(MOMO-338 도입)와 불일치 — 두 스크립트가 main에서 이미 FAIL. | MOMO-338이 namespace를 추가할 때 두 smoke 스크립트의 기대 목록이 갱신되지 않은 gate drift. 제품 경계 무관, 스크립트 기대값 갱신만 필요한 소형 tooling 수정. | `pending` | 소형 tooling 티켓 발급 제안(엔진 트랙, ADR 불요) — 성재/momo-main 확인 대기. |

## 소급 항목 (2026-07-09 감사에서 발견된 역사적 이탈)

아래는 이 로그가 없던 시기의 이탈로, ADR 큐에 이미 배정됨 — 참고용.

| 출처 | 이탈 | 배정 |
|---|---|---|
| MOMO-256 | 김인턴 → Hermes 정체성 교체 (근거 무기록) | ADR-0106 |
| MOMO-325~333 | gateway 경로의 사실상 기본화 (계약 문서와 모순) | ADR-0102 |
| LOCAL_SOLO 레인 | M2 멀티팀 → 로컬 솔로 피벗 | ADR-0103 |
| 2026-06-26 | Actions 중단 → 로컬 게이트 머지 권위 관례화 | ADR-0107 |
