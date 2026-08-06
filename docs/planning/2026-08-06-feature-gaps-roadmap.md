# 4기능 현황·로드맵 (2026-08-06 성재 발제)

> 발제: "채팅 pin / 한 채팅 다중 에이전트 작업 / 채팅 내 즉시 승인 / 개발 작업 실행 방식(로컬·원격·클라우드) 컨펌 — 구현돼 있나, 예정인가, 없으면 로드맵화."
> 실측 정본: 조사 전문은 이 문서 하단 §5. 코드=origin/track/engine, 문서=main.

## §1 판정 요약

| 기능 | 현재 | 기획 흔적 | 판정 |
|---|---|---|---|
| ① 채팅 pin | **없음(0%)** — 서버·클라·스펙·ADR·티켓 전부 0 | 없음 | **신규 로드맵화** — reaction 경로와 동형이라 ADR 불요, 티켓 1장(#1112) |
| ② 다중 에이전트 작업 | **구현됨** — @luna @oort 한 메시지=run 2개(agent_mentions.rs:201 루프)·A2A 위임 게이트 5종+depth CHECK까지 | ADR-0130/0132 완결 | 갭만 티켓화(#1113): 멀티 멘션 회귀 테스트 부재·컴포저 라우팅 바 단일 타깃 전제 |
| ③ 채팅 내 즉시 승인 | **폐곡선 성립** — 결정→한 트랜잭션 원장·감사·run 전이·resume job(300ms 폴링=체감 즉시)·타임라인 카드 즉시 결정(U4-4 랜딩) | ROADMAP §0(낡음 — 폰 ❌ 표기이나 실제 랜딩됨) | 폐곡선은 완성. **실전 부하 갭**: 실행 가능 도구가 work.session.end 1종뿐 — 확장은 ④와 한 몸(#1114) |
| ④ 실행 방식 컨펌 | **부분** — 호스트 레지스트리·티어 정책·재개 시 HostPicker는 있음. **시작 시점 "어디서 돌릴까" 컨펌 없음**(work_sessions.rs:189 클라가 host_id 명시·에이전트는 스폰 자체 불가) | **ADR-0125 D6-A가 정확히 이 설계**(승인 카드에 호스트 선택기 — 내 맥/팀 VPS/momo Cloud) + MOMO-490 미착수 | **재점화**(#1114) — 진짜 차단기는 UI가 아니라 work_control 서버 미이식 |

## §2 로드맵 편입 (우선순위 권고)

1. **W1(다음 배치 후보): pin(#1112) + 다중 멘션 갭(#1113)** — 둘 다 소형, 대화 표면 연장선. U4 시리즈 직후의 가벼운 배치로 적합.
2. **W2(중형 체인): 작업 스폰 폐곡선(#1114)** — work_control 이식 → work.session.spawn 도구 실행기(승인 필수) → **승인 카드=실행 방식 컨펌 카드**(ADR-0125 D6-A·MOMO-490 부활: HostPicker 3번째 호출자). ③의 실전 부하와 ④의 시작 시점 컨펌이 이 체인 하나로 함께 닫힌다 — 에이전트에게 개발 작업을 시키면 "어디서 돌릴까요(내 맥/팀 VPS/momo Cloud)"를 승인 카드가 묻고, 승인하면 그 호스트에서 돈다.
3. 관찰: ROADMAP §0 승인 축 표기 낡음(폰 랜딩 반영 필요) — 다음 ROADMAP 정비 시.

## §3 의존·리스크
- #1114는 T3(클라우드) 옵션이 켜져 있어야 3택이 완성 — ADR-0136 T3는 기본 비활성(E2B 키·리허설 별도 트랙). 1차는 로컬/원격 2택+T3 자리 예약으로 가는 것이 현실적.
- 도구 실행기 확장은 도구마다 "실행기+인자 검증기+자동승인 정책" 3점 세트(조사 §3) — work.session.spawn 하나부터.

## §4 성재 결정 대기
- W1/W2 착수 순서·시점(현재 oort1+첨부 배치 진행 중 — 그 다음 슬롯 후보).
- pin의 UX 세부(채널 헤더 목록 vs 우측 패널)는 티켓 내 구현 재량으로 갈지, 시안 먼저 볼지.

## §5 조사 전문
(4기능 전수 조사 결과 — 표·file:line 근거는 오케스트레이션 기록 보존용. 코드 인용 생략 시 이 절이 정본.)

### ① pin: 서버 grep 0건(pinned/pin_message/message_pins — 마이그레이션 001~059 전수)·openapi 메시지 경로에 pin 오퍼레이션 없음·ADR 0001~0152 및 이슈 544건 제목 전수 0건. 필요 층: 마이그레이션 1장(message_pin+RLS+상한)+momo-messaging SQL+routes 3라우트+outbox 1종(message.pinned)+openapi 3오퍼레이션 / 코어 API·웹 액션+헤더 목록·폰 시트 1줄. 규모 소~중(서버 ~1일·클라 ~2일).

### ② 다중: agent_mentions.rs:435 addressed_agents()=filter 전체→:201 per-agent 루프→:265 create_agent_run_in_tx. 멱등 키 mention:<message>:<agent>. A2A=crates/momo-agent/src/a2a.rs 게이트 5종(G1 동시성·G2 연속자동·G3 스텝·depth·체인 예산)+워커 route_a2a_mentions_in_tx(parent_run_id/depth+1)+007 마이그레이션 depth>4 CHECK. 에이전트 발화 멘션은 send 경로 skip(fail-closed — 워커 reply 경로만 depth 상속). 갭: 멀티 멘션 회귀 테스트 부재(mention_routing_conformance_pg.rs는 단일·중복·DM만)·MentionRoutingBar 단일 타깃 전제(model/effort 1명분)·위임 UI 없음(A2A는 프롬프트 자발).

### ③ 승인: approvals.rs :104 list·:168 decide_by_approval·:480 approve_run(한 tx에 원장·감사·전이·resume emit_outbox)·resume_job_payload(스텝 예산·tool_grants 승계 테스트 잠금)·워커 폴링 300ms=체감 즉시·AwaitingApproval 상태 표면(웹 배지·패널, 폰 랜딩 #1084 계열)·approval_sweep(방치 만료 — 없으면 max_concurrent_runs=1로 영구 정지). 웹·폰이 같은 컨트롤 한 벌. 갭: CATALOG=[work.session.end] 1종 — spawn/resume/pause/message.post는 DECLARED_NOT_EXECUTABLE·work_control 미이식(tools.rs:51·work_sessions.rs:46)·work_auto_approve 테이블은 있으나 Rust 라우트 0(openapi /work-auto-approvals는 Swift 잔재).

### ④ 실행 방식: work_hosts(등록·heartbeat)·cloud_hosts(T3 enroll)·work_sessions(:177 create — :189 클라가 host_id 명시, auto-target/묻기 분기 없음)·work_tier_policy(t1_only|ask|auto — "연결 끊김 시 묻기"=폴백 질문이지 시작 시점 선택 아님). HostPicker는 재개 전용(호출자 2: WorkPanel:427·WorkstreamDetailRoute:431). createWorkSession 코어 API 부재. 에이전트 스폰 불가(tools.rs:111). **ADR-0125 D6-A(Accepted 2026-07-19)가 정확히 이 설계**: "승인 카드에 호스트 선택기(내 맥 온라인/팀 VPS/momo Cloud), 기본=로컬 온라인 우선→마지막 사용" — 파생 MOMO-490(BUILD_TICKETS:2263 미체크) 미착수. 필요: work_control 스폰 디스패치 이식(openapi :2529에 /work-controls 정의 기존재·Rust 0)+auto-approvals 2라우트+create의 자격호스트 해석+spawn 도구 실행기(대) / 코어 createWorkSession+자격 판정 재사용(소) / HostPicker 3번째 호출자+폰(소~중). 병목은 서버.
