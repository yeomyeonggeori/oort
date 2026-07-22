# sol(GPT) 독립 감사 브리프 검수 판정 (2026-07-22, Fable — 성재 전달분)

> 발단: 성재가 sol과 나눈 대화에서 sol이 정리한 "Fable Research Orchestrator" 감사 브리프. 요청: "피드백삼아 활용할 부분이 있는지 검토."
> 방법: 브리프의 가설 4개+구현 감사 항목을 **main@e0c5336 실코드로 재검증**(방어 없이). 판정: confirmed/partially/stale/by-design.
> 총평: **감사 항목 중 2건이 진짜 급소를 맞혔고**(memory_refs 미주입, ACP 이벤트 로컬 체류), 가설 C는 우리의 AMP 보류 전략과 사실상 동일 결론의 정제판이다. 반면 가설 A의 프리미티브 8종 즉시 도입과 감사 항목 다수는 과장 또는 T1 신뢰 모델상 by-design.

## §1. 실코드 확증 결과 (급소 순)

| # | sol 지적 | 실측 | 판정 |
|---|---|---|---|
| 1 | AgentWorker가 memory_refs를 decode만 하고 모델 메시지에 주입하지 않는가 | **적중.** `ContextAssembler.swift`에 memory 참조 0건 — payload 디코드(AgentJobPayload:27)뿐, Hermes 메시지 조립에 미사용. **Memory Plane이 아직 모델에 서빙되지 않는다** | **confirmed — 최우선 배선 갭 (MOMO-545)** |
| 2 | ACP 이벤트가 PG/outbox/thread까지 오는가, 로컬 JSONL에 머무는가 | workd 경로는 `ACPJSONLinesFileSink`(호스트 로컬 파일)가 유일 싱크(ProcessManager:63-67). 서버 카드 투영 없음. T1 앱 경로(MomoLocalACPSession)는 별도 — **workd 호스팅 ACP는 관전 불가** | **confirmed — ⑪(532) 전제 갭 (MOMO-546)** |
| 3 | workd 자식이 호스트 GH/AWS/SSH env를 상속하는가 | `hostEnvironment()`가 PTY·ACP·terminal 전부의 base env(ProcessManager:59,70,78) | confirmed — 단 T1 신뢰 모델(로컬 CLI는 원래 사용자 권한)상 에스컬레이션은 아님. **스크럽 옵션 가치 있음 (MOMO-547)** |
| 4 | ACP terminal/create가 승인 원장 없이 host PTY 실행 | 사실(ACPClient→LocalPTYTerminalManager 직행). 단 세션 spawn 자체가 work.control 승인을 통과했고, 로컬 코딩 CLI가 명령 실행하는 것은 T1 고유 속성(codex/claude와 동일). **관측 갭**(terminal 생성이 서버 이벤트로 안 보임)이 실 문제 — #2와 동일 뿌리 | partially — by-design(T1) + 관측 갭은 546에 포함 |
| 5 | 추출이 기본 활성으로 외부 provider에 원문 발송 가능 | Config 기본 `"1"`, prod compose에 오버라이드 없음. 워크스페이스 memory 정책 스위치는 있으나 **provider 신뢰 구분(내부 mock vs 외부 API) 동의 게이트는 없음** | partially confirmed — **externalHermes 동의 게이트 (MOMO-548)** |
| 6 | memory candidate가 사람 검토 없이 auto-apply | 사실(MemoryExtractionService:615 `status='applied'`). ADR-0129가 의도적으로 선택(mem0 문법+사후 거버넌스=529 브라우저) | by-design — 단 **승인 모드 플래그**는 엔터프라이즈 대비 가치. 성재 결정 |
| 7 | packet inspector가 grant 차용 excerpt를 채널 전체에 노출 | 과장 — **run 채널 멤버십 EXISTS로 게이트됨**(ContextPacketRoutes:44-50). 단 만료/grant 철회 후에도 불변 content 열람 가능(감사 목적 의도). member-scope 발췌의 사후 노출은 실재하는 긴장 | partially — 긴장 기록, 즉시 조치 불요 |
| 8 | /memories/search의 confused-deputy(임의 agent 지정) | 사실 — 아무 멤버나 `agent=` 파라미터로 해당 agent 스코프+grant를 빌려 검색 가능(2026-07-22 회귀에서 나도 실측). v0 수용이었으나 **545 배선 후 재론 필요**(서빙이 실화되면 노출 커짐) | confirmed — 545에 동봉 |
| 9 | WorkHost 서명에 nonce/replay 보호 | 부재(bearer 검증만). T2/실배포 전 필요 | confirmed — 백로그(실배포 리허설 게이트에 편입) |
| 10 | receipts(delivery/access/citation) 부재, "모델이 사용" 관측 불가 | 사실 — packet은 포함 증명만. 구분(포함/조회/인용)은 올바른 어휘 | confirmed — 0129 v1 후속 백로그 |
| 11 | 클라우드 provisioner/스냅샷/미터링 부재 | 사실이나 stale 아님 — 우리 로드맵이 이미 "momo Cloud 프로비저너=후속 ADR"로 명시. 분리 과금·resume cache 어휘는 그 ADR에 채택 | by-roadmap |

## §2. 가설 판정

- **가설 A (Work Object)**: **추가 검증.** "공유 화면이 아니라 공유 작업 객체"라는 프레임은 정확하고, 우리 관전(0126)·diff 카드(518)가 canonical object가 아닌 것도 사실. 그러나 프리미티브 8종 즉시 도입은 과설계 — message/thread/run/approval과의 중복 경계를 thin slice로 먼저 실증해야 한다. **채택: `code_change` thin slice 연구 티켓(Wave B/C 뒤)** — Git ref를 canonical로, PG는 메타+RLS. 지금 ADR 발행은 반대.
- **가설 B (ACP compat + native fidelity)**: **수정 채택.** 이중 레인 자체는 타당하나 현시점 수요 증거 없음. 531이 이미 `_meta` 통과 보존으로 fidelity 손실을 완화. **채택: 0130에 "fidelity lane은 수요 증거 후" 후속 줄 추가 + raw provider event 보존 원칙 명문화.** native adapter 즉시 착수는 기각.
- **가설 C (새 transport가 아니라 Collaborative Work Profile)**: **유지(이미 우리 결론).** "구현 먼저, 스펙은 추출물"(AMP 보류)과 동일 방향의 정제판. **채택: AMP 백로그 항목의 어휘를 sol의 profile 구성(participant/mandate/proposal/checkpoint/evidence/receipt/handoff)으로 갱신** — 장래 스펙 추출 시 좋은 골격.
- **가설 D (권한 적용 Context Compiler)**: **대체로 이미 설계와 일치**(evidence=source_ref 원문 비복제, derived=confidence, index=재생성 가능, 후보=candidate). 실 갭은 §1-1(서빙 미배선)과 receipts. 5-plane 중 "canonical knowledge(인간 확정)" 구분만 우리에 없음 — 승인 모드 플래그와 함께 성재 결정.

## §3. 즉시 채택 (티켓 발급)

- **MOMO-545 [HIGH]** memory_refs 실주입: ContextAssembler가 packet memory_refs를 모델 메시지(시스템/컨텍스트 블록)에 주입 + 주입 여부를 run 레코드에 기록(포함/미포함 구분 어휘) + `/memories/search` agent 파라미터 권한 재론(멤버가 임의 agent 차용 — 최소 감사 로그). verify_agent_context 확장.
- **MOMO-546 [⑪ 전제]** workd ACP 이벤트 서버 릴레이: 정규화 이벤트(진행/plan/승인/터미널 생성)를 기존 work 이벤트 REST로 발송(단일 쓰기경로) — raw JSONL은 호스트 로컬 유지(0125 D10). 532 착수 전 랜딩 필요.
- **MOMO-547 [소형]** ACP/PTY 자식 env 스크럽 옵션: 기본 allowlist(PATH/HOME/LANG 계열)+옵트인 패스스루, 프로파일별 env 정책은 533 원장 확장.
- **MOMO-548 [정책]** 외부 provider 추출 동의 게이트: provider가 external일 때 워크스페이스 명시 옵트인 없으면 추출/임베딩 오프(기본 fail-closed), 내부 mock/self-host는 현행 유지.
- **백로그 등재**: workhost nonce/replay(실배포 게이트), packet receipts(0129 v1), `code_change` Work Object thin-slice 연구, canonical-knowledge 승격 모드.

## §4. 기각/보류 (사유)

- Work Object 프리미티브 8종 즉시 도입 — thin slice 실증 전 과설계.
- native fidelity adapter 즉시 착수 — 수요 증거 부재, `_meta` 보존으로 충분.
- 90일 4실험 프로그램 전체 — Wave B/C 진행 중 슬롯 충돌; §3 티켓이 실험 1(안전 게이트)의 실집행이고, 실험 2(thin slice)는 연구 티켓으로, 3·4는 수요/T3 ADR 시점에.
- Blaxel·T3 과금 절 — 기존 결정과 동일(기각 유지·discovery만·프로비저너 ADR에서 미터링).

## §5. 규율 채택 (§5.1 승격)

sol의 검수 태도 중 한 줄을 우리 검수 규율로 승격한다: **"구현되어 있으나 end-to-end로 연결되지 않은 것은 완료로 보지 않는다"** — 이번에 verifier가 디코드/별칭 동등성만 단정하고 실소비(모델 주입, 서버 릴레이)를 안 본 것이 §1-1·2를 놓친 원인. 이후 verifier는 최종 소비 지점(모델 요청 덤프, 서버 원장 행)을 단정한다.
