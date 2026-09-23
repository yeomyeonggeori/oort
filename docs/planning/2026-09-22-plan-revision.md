# 계획 개정 2026-09-22 — 진행 브리핑·시장 동향 반영·AX 에이전트 행동 축 편성 (Fable planner)

> **2026-09-23 대체:** 편성 정본은 [목표 A 실행 계획](2026-09-23-goal-a-plan.md)(ADR-0187)이다. 이 문서는 09-22 AX 축 편성의 역사 기록이다.

> 기준: main `38147f5f` = engine `1dbe939a` = uxui `d261932c`(09-12 #2501 정합 뒤 랜딩 0건). 척추(`2026-09-08-remaining-work-map.md`)는 유지하고 **AX 축을 병행 편성**한다. 결정은 ADR-0186·ADR-0004 증보 4, 수용기준은 이슈·브리프, 이 문서는 편성 정본이다.

## 0. 어디까지 왔나

| 단계 | 상태 | 증거 |
|---|---|---|
| 경량화 LS-0~6 (ADR-0183) | 완료 | 추적 파일 3,416→2,491 |
| G1' 파도 (SH-5a·6a·8·9·11·12, UX-R2c, #1265) | 완료 | 09-08~09-10 main |
| E2E-A 그록봇 / E2E-B 독립 셀프호스팅 | 로컬 경로 PASS | research/2026-09-09-e2e-a·e2e-b |
| v0.1.5 발행 | 완료 | 803ae7d5, 발행 이미지 B′ 12/12 |
| 공용 파이프라인 #2501 | 완료 | #2502→#2503→#2504/#2505 |
| 베타 재개 | 준비 뒤 착수(성재 09-22) | 이 문서 §4 |

### main 미랜딩 작업물
| 항목 | 상태 | 필요한 것 |
|---|---|---|
| #2498 기기 refresh/revoke 직렬화 | 로컬 커밋 16fcf007, 미push | 독립 검수·PG 경합·전체 Rust 게이트·PR — **Fable 인수**(Astra 세션 released) |
| PR #2485 오버레이 층 (#2044 #2075 #1919) | 09-17 갱신, needs-review | design-review 재확인 |
| PR #2490 설정›기기 (#2476) | needs-review | R2 검수 |
| PR #2497 OpenAPI 샘플러 (#2491) | needs-review | 정책 배치 3 감사 |
| #2066 웹훅 마스터키 분리 | ADR-0004 증보 4 **Accepted(09-22, D2(a))** | 워커 발사 |
| #2205 SH-11a Railway 실배포 | ready | Railway 로그인(성재, 최종 단계) |
| dependabot 9건 | open | #1257 일괄 판정 |

## 1. 척추(변경 없음)
1. #2498 검수 → PR 3건 랜딩
2. E2E-A 그록봇을 발행 이미지(v0.1.5)로 재실측 + VM Update/Reset 복구
3. SH-11a Railway 실배포 1회
4. ITO: 성재+1인(웹+데스크톱+폰 QR) — **AX 초대 1종 포함**(성재 09-22)
5. G2: 외부 셀프호스터 3 + 에이전트 멘션·런 실사용 + iOS v0
6. G3: 폰 축 셋 완주(M1) → M7 → 스토어

## 2. 시장 동향 → 반영(2026-09-22 조사)

| 툴 | 사실 | 반영 | 자리 |
|---|---|---|---|
| Meta Muse (09-08, WhatsApp 내장) | 백그라운드로 일하다 **승인이 필요할 때 돌아온다**, 민감 행동 전 확인, 전체 감사 기록 | 승인 축의 시장 검증. 격차는 폰(폰에서 승인 카드가 안 뜨면 Muse 이하) | #979, M1, AX-7 |
| ZCode 오픈소스화 (09-20, Apache-2.0) | 로컬 데이터 무단 업로드 적발 → 소스 공개+제3자 감사 | 교훈은 **신뢰**. Postgres SoT·셀프호스트·도어벨 내용 0(ADR-0171 D2)이 포지셔닝 | README/SECURITY 「데이터가 어디로 가는가」 1절(문서 티켓, G2 LAUNCH_READY) |
| Slack Code (08-20 공식) + 에이전트 업데이트 | 코드 채널·공유 아티팩트·세션 사이드바(pin/archive)·중단 버튼·Plan/Task **Block Kit 카드** | 에이전트 출력 = **허용목록 카드**. 세션 사이드바 = UX-R4b | ADR-0186 D5, UX-R4b |
| NanoClaw for Slack (MIT, 셀프호스트) | 메시지 한 줄로 에이전트 동료 생성 | 「첫 에이전트 유도」의 대화형 변형 | SH-12d, UX-R2c |
| Buzz + Hermes 공식 통합 | 에이전트=키페어 1급 멤버 | 07월 분석 완료, 델타 없음 | — |
| Generative UI 표준(OpenUI 보고서, A2UI·MCP Apps) | 프로덕션 = **선언형 카탈로그**, 오픈엔드 HTML은 샌드박스 슬롯 한정 | gen UI = 허용목록 카드 + 기존 게이트 | ADR-0186 D5 |

## 3. AX 축 — 「에이전트에게 시키면 된다. 실행은 사람이 누른다」
결정 정본 ADR-0186(Proposed). 원칙: ①레지스트리 정의 한 곳(워크스페이스 행동=Rust, 클라이언트 명령=TS), 소비자 셋(⌘K·내부 CATALOG·Agent Port) ②에이전트는 **propose**, 사람이 승인, 서버가 결정자 권한·감사 아래 실행 ③gen UI = 선언형 허용목록 카드, ADR-0182 확인 문법 ④1회 시크릿은 결정 응답에만.

유즈케이스 실사:
| 요청 | 서버 실체 | v1 경로 |
|---|---|---|
| 「초대 링크 만들어줘」 | `POST …/invites` 5종 존재 | AX-3a/3b 제안→승인→실행, 링크 1회 표시 |
| 「웹훅 발급하고 연동해줘」 | `momo-webhook` create/rotate/revoke 존재 | AX-8, #2066(ADR-0004 증보 4) 뒤 |
| 「테마 바꿔줘」 | 이 기기 localStorage(ADR-0174 D3) | AX-5 클라이언트 명령 참조 카드 「적용」 |

## 4. 편성 — 창별 순서(병렬 상한: 무거운 worker+reviewer 합 2)

| 창 | 엔진 레인 | UXUI 레인 | planner | 성재 |
|---|---|---|---|---|
| **W-A 지금** | 워커 **#2066**(ADR-0004 증보 4, 브리프 `handoffs/2026-09-22-2066-webhook-master-key-brief.md`) | 워커 **AX-2 #2507**(레지스트리·팔레트) | #2498 검수·PR / PR #2485·#2490·#2497 검수·랜딩 / AX-0 #2506 문서 PR 랜딩 | ADR-0186 **Accept** 결재 |
| **W-B** | 워커 **AX-3a #2508** → **AX-3b #2509** | 워커 **AX-4 #2510**(부록 계약으로 착수, 병합 검증은 3b 뒤) | 검수·랜딩·ENGINE_HANDOFF ready 행 | — |
| **W-C ITO 전 마감** | E2E-A 발행 이미지 · SH-11a Railway | AX-4 병합 트리 | **AX-6 #2512 E2E**(초대 1종) · 제로베이스 E2E 재실측 | Railway 로그인 · ITO 일정 |
| **ITO** | — | — | 내부 테스트 시나리오에 초대 1종 추가 | 성재+1인 |
| **ITO 뒤 / G2** | AX-8 #2514 웹훅 · AX-1 #2016 | AX-5 #2511 테마 · 폰 AX-7 #2513(M1) | G2 증거 | 외부 3명 · iOS v0 |

워커 발사는 명시 go. 브리프는 `docs/planning/handoffs/2026-09-22-*.md`(이 PR에 포함).

## 5. 성재 결재 기록(2026-09-22)
1. AX 첫 실물 = ITO 전 초대 1종까지
2. 승인 정책 = 위험 등급별(ADR-0186 D3)
3. ADR-0004 증보 4 Accept, D2 (a) 이행 복사
4. UX-R3a 팔레트 축소 범위 연기 해제(AX-2)
5. 「나머지는 설계 구체화, 준비가 온전하면 착수」

planner 결정(결재 불요): #2498는 Fable이 인수(Astra 세션 released) · 1회 시크릿은 메시지 행에 절대 기록하지 않음(ADR-0186 D4) · hosted(Agent Port) 경로가 첫 경로, 내부 worker 카탈로그(#2016)는 독립 후속 · Railway 로그인은 SH-11a 시점에 요청.

## 6. 남은 결재
- **ADR-0186 Accept**(§7 확정점 4) — AX-3a 착수 조건
- 워커 발사 go(W-A: #2066 ∥ AX-2)

## Sources
- Meta Muse: https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/ · https://techcrunch.com/2026/09/08/meta-debuts-its-muse-ai-agent-will-consumers-trust-it/ · https://www.cnbc.com/2026/09/21/meta-muse-personal-ai-agent-downloads.html
- ZCode: https://www.thestandard.com.hk/innovation/article/343354/ZAI-open-sources-ZCode-after-coding-tool-uploads-local-data-silently · https://github.com/zai-org/ZCode
- Slack: https://docs.slack.dev/changelog/2026/08/20/slack-code/ · https://docs.slack.dev/changelog/2026/08/20/agent-updates/ · https://slack.com/blog/news/slack-code-channels-for-agents
- NanoClaw: https://venturebeat.com/orchestration/nanoclaw-comes-to-slack-letting-you-create-persistent-ai-agent-teams-and-colleagues-from-a-single-message
- Generative UI: https://www.openui.com/blog/state-of-generative-ui-report · https://github.com/CopilotKit/generative-ui · https://github.com/thesysdev/openui
