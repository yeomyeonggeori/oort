# 계획 이탈 로그 (Deviation Log)

> 목적: 구현이 기획(티켓 수용기준·ADR·아키텍처 정본)과 달랐던 지점을 놓치지 않고 기획 레이어로 환류한다. (`docs/planning/README.md` §5)
> 기록 주체: 오케스트레이터(momo-main), 머지 시점. 판정 주체: 기획 레이어(+성재 승인).
> 상태: `pending`(판정 대기) → `accepted`(정본 반영) / `rejected`(복구 티켓) / `noted`(기록만).

| 날짜 | 출처 (티켓/PR) | 이탈 내용 | 오케스트레이터 분석·리서치 | 상태 | 판정·후속 |
|---|---|---|---|---|---|
| 2026-07-10 | MOMO-337 / PR #310 | 핸드오프는 `/gateway/jobs/pending`을 기존 경로로 전제했으나 실제 코드에는 없었다. 수용기준의 4-route bearer 이관을 닫기 위해 actor-bound pending recovery endpoint를 신설했다. | Postgres/outbox SoT와 REST 경계를 유지하고 `available_at <= now()` 및 token actor binding을 강제하므로 제품 경계 변경이 아닌 누락된 recovery surface 보완으로 판정했다. 다만 bearer 사용 audit write 증폭을 피하려면 adapter가 realtime-first여야 한다. | `accepted` | MOMO-338 #308에 realtime-first, bounded reconnect/recovery, idle tight polling 금지를 추가. |
| 2026-07-10 | MOMO-338 / #308 | 어댑터 bearer 단일화 리뷰에서 기존 `agent:` namespace가 user-visible status/partial과 Context Packet job을 함께 운반해 같은 채널 관찰자에게 private work가 노출되는 문제를 발견했다. Python 범위를 넘어 `agentwork:` namespace와 서버 proxy/config를 추가했다. | `agent:` 전체를 self-only로 만들면 기존 macOS working UX와 MOMO-212 live gate가 깨진다. 따라서 ADR-0101에 observable progress와 exact-actor private work 분리를 반영하고 dev/local-alpha/prod config를 함께 갱신했다. 다중 gateway 인스턴스의 provider 중복 실행은 durable claim/lease 없이는 닫히지 않아 후속 서버 티켓으로 분리한다. | `accepted` | MOMO-338 merge에 `agentwork:` self-only regression 포함. 후속: MOMO-341 claim/lease + takeover. |
| 2026-07-17 | MOMO-411/412 게이트 (선재 발견) | runtime-db 게이트의 `MomoWindowChromeSnapshotTests`(dark/narrow/overlay light) 4건이 origin/main HEAD에서 이미 FAIL — UX 트랙 window chrome 최근 머지분의 환경 의존 스냅샷 drift. 411/412(server·tooling만 변경)와 무관. | origin/main HEAD 격리 재현으로 선재 확정. 엔진 트랙 게이트가 이 때문에 무한 대기하지 않도록 서버 표면 단독 verifier로 머지 판정. | `accepted` | #448이 레퍼런스 갱신으로 1차 해소, MOMO-448(#450)이 stale light 캐노니컬 재기록 + ApprovalInbox close-crop + 신규 3서피스 스냅샷 11장으로 종결. overlay light는 offscreen NSWindow 폴백 렌더로 전환해 headless 재기록 가능해짐. |
| 2026-07-17 | MOMO-412 / PR #443 (리뷰 후속) | webhook native secret KDF의 master key가 `config.jwtHMAC` 재사용(M2) — JWT secret 회전 시 발급된 모든 native webhook secret이 조용히 무효화되는 운영 결합. per-install rate limit 부재(M1)로 토큰 유출 시 채널 flood 상한이 회전/revoke뿐. | 암호학적으론 도메인 분리(`momo.webhook.native.v1\n`)로 안전하나 운영 결합은 실재. infra/prod 무변경 계약상 v0 수용, 후속 분리 권고. | `pending` | `WEBHOOK_MASTER_KEY` 분리 + per-install rate 예산 후속 티켓 제안(성재/판정 대기). |
| 2026-07-21 | W-2 / PR #561 | 패킷은 "read-only v0, 쓰기=read-state만"으로 한정했으나 worker가 실전송 컴포저(sendMessage + draft-attempt당 clientMsgId idempotency)까지 구현. | 코드 품질이 L4 §3.1 idempotency 계약을 정확히 준수하고, 오케스트레이터가 실서버 실전송 왕복을 검증(PASS). 되돌리는 비용 > W-4 선행 수용 이득으로 판정. | `accepted` | W-4 발급 시 "컴포저 기구현" 반영해 범위 축소(read-state·승인 카드·recovery 왕복 중심). |
| 2026-07-15 | MOMO-390 / PR #403 (선재 발견 보고) | 이 PR의 이탈이 아니라 main 기저(e35be71)의 기존 결함 발견: `verify_staging_smoke.sh`/`verify_internal_hosting_smoke.sh`가 `agent/ch/dm/user` 4개 namespace만 기대해 `centrifugo.prod.json`의 `agentwork` namespace(MOMO-338 도입)와 불일치 — 두 스크립트가 main에서 이미 FAIL. | MOMO-338이 namespace를 추가할 때 두 smoke 스크립트의 기대 목록이 갱신되지 않은 gate drift. 제품 경계 무관, 스크립트 기대값 갱신만 필요한 소형 tooling 수정. | `accepted` | MOMO-399 발급(staging/internal smoke namespace 기대 갱신, ADR 불요) — 엔진/인프라 트랙 위임 범위 내 판정. |

| 2026-07-18 | MOMO-471 / PR #494 (게이트 선재 발견) | `testWorkspaceSearchLightSnapshot`가 격리 통과·full `make test` 실패(폰트캐시/GPU 순서 의존 렌더 비결정, precision 0.98 미세 초과). origin/main에서도 재현 — V-3 무관. | V-3 자체(huddle/Core 34 test) PASS 확인 후 표면 무관 flake로 판정, 재기록 커밋 revert해 PR을 huddle 전용 유지. MOMO-411/412 선례(선재 스냅샷 FAIL 분리)와 동일 처리. | `pending` | MOMO-472(#495) 안정화 티켓 발급 — full-suite 3회 통과 증명 필요. |

| 2026-07-18 | MOMO-474 / PR #499 (게이트 선재) | server 전용 PR인데 runtime-db 게이트의 `testChannelCreationSheetEnglishLargeTextSnapshot`(macOS)가 full-suite flake로 실패. server 변경은 macOS 렌더에 영향 불가 = 선재. | 첨부 verifier+서버 107 test+openapi+실 Google smoke PASS 확인 후 track/engine 머지. MOMO-472(#495) 범위를 이 스냅샷까지 확장. | `pending` | MOMO-472에서 두 스냅샷 결정적 렌더 이관. |

| 2026-08-05 | #1042 / PR #1058 (SRV-B7) | 이탈 3건: ①패킷 파일 허용 목록 밖 `openapi_shape_check.py` 가산(`--sampled-elsewhere` — known-unsampled와 의미 반대라 재사용 거부, 겹침 가드 포함) ②패킷 「함정」 전제 오류(repo에 infra/rust 컴포즈 기존재 — 오케스트레이터의 main 체크아웃 실측 오류) ③「예상 빨강」 재해석(빨강은 Rust가 아닌 Swift 선존재 — #1040이 스펙을 Rust 와이어로 맞춘 예정된 귀결. 2차 패스만으론 미해소, 잠식 기제=「등재=응답 모양 권위 이전」 동시 구현 필요). | ①부채(줄어들 수만)/권위 이전(늘어날 수만) 의미 분리 논거 타당 — 뭉개면 게이트가 거짓말을 배움. red proof 2종+겹침 가드 실측 확인. ②재발 방지 교훈: 경로 실측은 origin/track/engine 대상(JOURNAL 기록). ③해석이 완료조건 ①③의 유일한 정합적 동시 성립 — merge-base 선존재 증명 확인. 전 게이트 2연속 green·cargo 713/0. | `accepted` | 오케스트레이터 mid-flight 승인 3건 전부 추인. 후속: 부분집합에 relay/agent-worker 합류(매니페스트 확장 지점)·pgdata 고정이름 볼륨 함정 런북 반영. |

## 소급 항목 (2026-07-09 감사에서 발견된 역사적 이탈)

아래는 이 로그가 없던 시기의 이탈로, ADR 큐에 이미 배정됨 — 참고용.

| 출처 | 이탈 | 배정 |
|---|---|---|
| MOMO-256 | 김인턴 → Hermes 정체성 교체 (근거 무기록) | ADR-0106 |
| MOMO-325~333 | gateway 경로의 사실상 기본화 (계약 문서와 모순) | ADR-0102 |
| LOCAL_SOLO 레인 | M2 멀티팀 → 로컬 솔로 피벗 | ADR-0103 |
| 2026-06-26 | Actions 중단 → 로컬 게이트 머지 권위 관례화 | ADR-0107 |
