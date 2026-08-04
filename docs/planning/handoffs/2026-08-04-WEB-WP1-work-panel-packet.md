# 핸드오프 패킷 WEB-WP1 — 웹 「작업 패널」 v0 (사고 과정 트래킹)

- status: **ready** · worker: Opus 5 (웹) · 기준: `origin/track/engine` 최신 · 새 워크트리
- 결정 정본: `docs/planning/2026-08-04-work-panel-design.md` (**성재 승인 2026-08-04** — D1 휘발 관전 v0 · D2 웹 먼저 · D3 「작업 패널」) — **먼저 정독**
- 병렬 경계: RN-P2(모바일)·SRV-B3(서버)·MAESTRO-1(모바일 레인)이 동시에 돈다. **네 전속 = `clients/web/**` + core 순수 판정 신설만.** 모바일·서버 소스 금지. core의 기존 파일(workingSignal·agentRail·turnCopy)은 **소비만** — 확장이 필요하면 새 모듈로.

## Goal — run 하나를 여는 패널: 과정이 시간순으로 쌓인다

**데이터는 이미 흐른다** — 새 파이프 금지, 표면화만:
| 재료 | 출처 |
|---|---|
| phase 전이(생각 중→도구→승인 대기→완료) | `agent.status` (`packages/momo-core/src/lib/realtimeEvents.ts:186-201`) |
| 부분 텍스트 스트림 | `agent.partial.text_delta` (`:219`) — **현재 소비처 0(테스트뿐), 네가 첫 소비자다** |
| 도구 단계 | `tool_call_id/name/args*` (`:222-225`) — v0는 **이름+상태만**, args는 접힘+명시 펼침(민감 가능) |
| 비용 | `spent_micro_usd` |
| 구독 레일 | 웹 `agentRail`/realtime.ts의 기존 `agent:` 구독 — 새 구독 로직 만들지 말고 그 레일에서 분기 |

- **진입점**: ①대화 활동 줄의 턴 클릭 ②에이전트 허브의 "현재 작업". 패널=우측 사이드(기존 관전 표면 문법).
- **축적 스토어**: run별 이벤트 로그(core 순수 모듈 신설 — 폰 시트가 나중에 같은 걸 소비한다). 수명은 workingSignal 규율 준용(TTL·zombie). **저장 없음(D1)** — 앱 세션 메모리만.
- **정직성 규칙**: ①라이브 진입 시 Centrifugo history(24h·100프레임) 앞이 잘리면 **"이 지점부터 관전"을 명시**(설계 문서 §4) ②승인 대기≠작업 중 어휘 유지 ③게이트웨이 직송 run은 성공 종료 프레임이 없을 수 있다(선존재 갭, SRV-B3가 실측 예정) — 종료를 못 본 run이 열려 있으면 상태를 지어내지 말고 신호 소실 규칙(TTL)로.
- 디자인: `momo-design-taste-web` 규율(4상태·키보드·미제공≠장애).

## 검증

web+core 전체·typecheck·`gate:work-panel` 신설(지연 편차 목 — 델타 3프레임이 순서대로 쌓임·phase 전이·잘림 고지·닫고 다시 열면 라이브부터) + red proof ≥2(delta 순서 뒤집힘 검출·args 기본 접힘). PR 본문 `## 계획 이탈`. PR 후 STOP.
