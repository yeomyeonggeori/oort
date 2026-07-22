# 에이전트-네이티브 비전 진단 — CTO 피드백 4대 고민 + Blaxel 협업 (2026-07-21, Fable · PLN-20260721-01)

> 발단: 성재 발제 — CTO 대화 4대 고민 ①Figma식 "하나의 화면에서 에이전트 결과물을 다같이 고도화" ②opencode/codex/grok build/kimi code/pi 같은 코딩 에이전트의 호스팅·연동 ③에이전트-메신저 소통의 새 규격(느슨한 공개 규격) 제안 가능성 ④메신저 레벨 컨텍스트 핸들링 + 회사 단위 메모리 인프라(가시화+서빙). 부가: Blaxel 공동창업자(Nicolas Lecomte) LinkedIn 접촉 대응 + CTO의 유휴/영속성 질문.
> 리서치 정본: `research/19-agent-native-fabric/00~04`(내부 실사 2 + 프로토콜/메모리/샌드박스 외부 리서치 3). 선행 진단: `2026-07-21-opensource-cowork-diagnosis.md`(고민①의 1차 반영 — ADR-0126).

## 결론 요약 (5줄)

1. **고민①(cowork)은 이미 ADR-0126으로 절반 실행 중**(D1 관전 attach 랜딩) — 잔여는 D2(diff 카드)·D3(앵커 코멘트)·D4(워크스페이스 소유 세션)의 v1 승격과 웹 관전. 새 설계 불요, 실행 순서 결정만 필요.
2. **고민②(외부 에이전트 호스팅)는 8할 준비돼 있다** — codex-workbench가 "Hermes SDK 없이 gateway 계약만으로 임의 에이전트 연결"을 실증. 막힘은 3곳뿐(work tool의 gateway 미노출·도구 화이트리스트 하드코딩·셀프온보딩 부재). **ACP(Zed Agent Client Protocol) 클라이언트 1개를 구현하면 레지스트리의 40+ 코딩 에이전트가 즉시 momo 멤버 후보**가 된다. → ADR-0130 후보.
3. **고민③(새 규격)의 공백은 실재한다** — "멀티파티 영속 대화 공간의 에이전트 멤버십 레이어"는 2026-07 현재 어떤 공개 규격도 다루지 않는다(Slack은 독점 API로, OpenClaw는 프로토콜 없는 제품으로 채우는 중). 전략은 **이중**: ACP 클라이언트로 즉시 호환 + momo 구현에서 추출한 얇은 "Agent Membership Protocol" 스펙 제안(구현 먼저, 스펙은 결과물 — MCP 승리 공식). 창은 12~18개월로 추정.
4. **고민④(컨텍스트/메모리)가 최대 갭이자 최대 기회** — Context Packet/Memory Plane/Capability Cache의 규범 스펙·fixture는 2026-06에 이미 정본화됐으나(research/11) **런타임이 통째로 비어 있다**(packet 5필드 partial·mock grants·메모리 테이블 0·pgvector 부재). 외부 지형 리서치 결론: PG-native 자체구현이 momo 불변식과 유일하게 양립(그래프DB는 라이선스 전멸 지대, Hindsight가 PG 단일 실증). → ADR-0129 후보.
5. **Blaxel은 명시 기각이 아니라 미파일럿**(E2B가 파일럿으로 승리). 프로비저너가 provider-불가지 설계라 **2nd 기질 후보 + 가격 협상 레버리지**로 정확히 들어맞는다. CTO 유휴 질문의 답: **E2B·Blaxel 모두 메모리+FS 보존 상태로 0-컴퓨트 반납 후 재개 가능**. 차이는 보관비 — E2B는 미명문화(계약 명문화 필요), Blaxel은 $0.20/GB-월 명시. 세션당 월 원가 $1~3으로 크레딧 BM 마진은 충분.

---

## §1. 고민① Figma식 cowork — 설계 완료, 실행 순서만 남음

- **기반영**: ADR-0126 Accepted(2026-07-21), D1 관전 attach(observer capability) MOMO-516 랜딩. 세션=채널 스레드(0114 D2)라 과정 공개는 구조적으로 확보.
- **잔여 갭(성재 결정 필요)**:
  1. **D2 산출물 카드(diff 카드·커밋/PR 카드)** — "결과물을 보면서 고도화"의 실체. v0 예약분(MOMO-518)인데 아직 미발급. **CTO 피드백의 절반은 관전(D1)이 아니라 이것** — 관전은 과정이고, 고도화 논의는 산출물 위에서 일어난다.
  2. **D3 발췌 앵커 코멘트(v1)** — Figma 코멘트 핀의 등가물. D2 랜딩 후.
  3. **D4 워크스페이스 소유 세션(v1)** — "hermes처럼 호스팅되는 claude/codex"의 완성. §2의 ACP 호스트와 결합하면 "팀 공유 코딩 에이전트" 완성형.
  4. **웹 관전** — 0119 웹 v0(W-2 랜딩)에 Work 표면은 v1+. CTO가 말한 "다양한 직군이 하나의 화면"은 브라우저 접근이 전제 — 웹 Work 관전 뷰(read-only 터미널+세션 카드)를 웹 v1 큐에 명시 등재 권고.
- **권고**: MOMO-518(D2 diff 카드)을 다음 UXUI 배치에 승격, D3·D4는 그 뒤 순차. 새 ADR 불요.

## §2. 고민② 외부 코딩 에이전트 호스팅 — 8할 준비, 막힘 3곳 (ADR-0130 후보)

**현재 좌표(실사 19-01)**: 5계층(수명주기/연결/컨텍스트/실행/승인) 중 수명주기·승인은 일반화 완료, 연결 계약은 codex-workbench가 provider-불가지임을 실증, 컨텍스트는 읽기 전용이라 이미 불가지. 서드파티 최속 경로 = gateway BYOA "대화 멤버"(코어 수정 0 + 어댑터 1개).

**막힘 3곳**:
- **A. work tool의 gateway 경로 미노출** — work.spawn 배선이 worker 전용(`WorkerService.swift:358-410`). gateway로 붙는 서드파티는 대화만 되고 CLI 스폰 불가. 기존 X-7 계열 후속으로 이미 인지됨(`QA_FOLLOWUP.md:39`).
- **B. 도구 화이트리스트 하드코딩** — `["claude","codex","opencode","shell"]`이 서버(`WorkControlRoutes.swift:507`)·mac 앱·workd 3곳에 고정. ADR-0114 D7의 "임의 셸/도구-불가지 프로파일" 설계와 코드가 불일치. kimi/grok/pi를 붙이려면 3곳 수정 — **work_tool 프로파일 원장(서버 테이블+capability 검증)으로 승격 필요**.
- **C. 셀프 온보딩 부재** — A2A Agent Card/`agents/announce`(MOMO-313)가 blocked. 수동 등록만 가능.

**핵심 제안 — ACP 클라이언트(19-02 §4 옵션 A)**: 2026-07 현재 코딩 에이전트 생태계는 **ACP(Zed)로 수렴 중**(Gemini CLI·opencode·Kimi CLI·Goose·Qwen·Cline 네이티브 + Claude Code·Codex 공식 어댑터 + Registry 배포). momo가 에이전트별 어댑터 N개를 만드는 대신 **ACP 클라이언트 1개("momo-acp-host")를 work host 계층에 구현**하면:
- ACP `session/update`(진행·plan) → 세션 스레드 카드, `session/request_permission` → momo 승인 카드, `terminal/*` → 기존 PTY 세션 매니저, ACP 세션 → work_session 원장 — **어휘가 거의 1:1 매핑**된다(19-02 §1.4).
- 비-에디터 ACP 클라이언트 선례 존재(marimo 노트북·Toad 터미널). momo는 "메신저형 ACP 클라이언트"의 첫 선례가 된다 — §3 규격 제안의 실탄.
- Grok Build만 ACP 미확인 — 헤드리스 `-p`로 별도 어댑터 또는 보류.

**ADR-0130 결정 구조(안)**: D1 ACP 클라이언트 채택 범위(momo-acp-host를 workd/앱 세션 매니저에 통합) / D2 work tool gateway 노출(막힘 A) / D3 work_tool 프로파일 원장(막힘 B) / D4 Agent Card 셀프 온보딩(막힘 C — MOMO-313 승계, A2A v1.0 Agent Card 정합) / D5 대화 멤버용 표준 어댑터 템플릿 공개(codex-workbench 일반화 — 오픈소스 공개 시 "momo에 아무 에이전트나 붙이는 법" 문서).

## §3. 고민③ 새 규격 제안 — 공백은 실재, 순서가 생명

**리서치 결론(19-02)**: 런타임 레이어는 포화(툴=MCP·호스팅=ACP·원격 호출=A2A·프론트 스트리밍=AG-UI). 그러나 **"방 멤버십·컨텍스트 권한 스코프·멀티파티 승인·스레드 진행 게시·방의 영속 산출물"은 전부 공백**. 이 공백을 채우는 것은 Slack(독점 API)과 OpenClaw(프로토콜 없는 제품, 보안 참사)뿐 — OpenClaw 사고는 "승인·감사·격리 기본값 있는 규격" 수요의 방증이자 momo 차별화 논거.

**채택 역학의 교훈(19-02 §3)**: 성공 공식 = 실제 제품에서 추출한 최소 스펙 + 1·2위 에이전트 어댑터를 제안자가 직접 출하 + 상세 문서 + 락인 의심 제거(permissive·재단 기증 경로) + 두 번째 대형 채택자. **"규격 먼저"는 전패**(IBM ACP·ANP·NLWeb) — 규격은 제품 성공의 결과다.

**전략(이중, 순차)**:
1. **지금**: ADR-0130(ACP 클라이언트)으로 기존 표준에 올라탄다 — 즉시 40+ 에이전트 호환 + "메신저형 ACP 클라이언트" 선례 확보.
2. **momo 제품 질량 확보 후(오픈소스 공개+실사용 워크스페이스)**: momo의 기존 프리미티브(member.kind='agent'·Context Packet·승인 원장·세션=스레드·observer capability)에서 **"Agent Membership Protocol"(가칭) 얇은 스펙 초안 추출** — 방/멤버/컨텍스트 스코프/승인/진행/산출물의 최소 어휘 + "로컬 에이전트=ACP 세션, 원격 에이전트=A2A 태스크로 바인딩" 매핑 장. Claude Code·Codex·opencode 어댑터 3종 동시 출하, Apache-2.0, AAIF 기증 경로 명시.
3. **시간 창**: MCP Apps+Tasks가 2027년경 이 방향으로 자랄 수 있고 Slack이 독점 API로 선점 중 — 12~18개월 추정. 단 이 창은 "규격 발표"의 창이지 momo 실행의 데드라인이 아님.

**내부 정합**: 이 방향은 research/13-redesign의 기존 결정("MCP+A2A+AG-UI 삼각 채택, 에이전트 프리미티브를 표준 위에")과 충돌하지 않고 그 공개-표면화다. 단 13-redesign의 "ACP 무시" 판정은 **IBM ACP(소멸) 기준이었음** — Zed ACP는 별개 프로토콜로 재평가가 필요하다(이번 리서치가 그 재평가).

## §4. 고민④ 컨텍스트/메모리 인프라 — 최대 갭, PG-native로 (ADR-0129 후보)

**현재 좌표(실사 19-00)**: 스펙(research/11 04~06 — Context Packet 16필드·Memory Plane 6타입·Capability Cache 4-kind, 전부 RLS FORCE 전제)과 fixture는 완비. 런타임은 ①same-channel 히스토리 창 조립 ②ILIKE 검색 ③plugin grant 정적 projection뿐. **Memory Plane 테이블 0개, pgvector/FTS 부재, packet은 5필드 partial + mock tool_grants, 서빙 감사 인스펙터 없음.**

**외부 지형 결론(19-03)**: ①업계 수렴 패턴 — 2-phase 추출(ADD/UPDATE/DELETE/NOOP)·삭제 대신 시간축 무효화(invalid_at)·프로필 상시 주입+사실 질의 시 조립·workspace→user→agent→session 4단 스코프(momo RLS와 자연 동형) ②그래프 전용 DB는 라이선스 전멸(Neo4j GPLv3/FalkorDB SSPL/Kuzu 사망) — **PG-native가 유일한 permissive 경로이고 Hindsight(MIT, 18.6k)가 PG 단일 실증** ③사이드카(mem0 서버 등)는 제2의 SoT를 만들어 momo 하드 룰과 정면 충돌 → **권고: PG 내장 자체구현 + 검증된 오픈 패턴 이식**.

**ADR-0129 결정 구조(안) — "Memory Plane & Context Fabric 런타임"**:
- **D1 저장**: research/11 05 §15의 `memory_item`/`memory_source_ref`/`memory_visibility_grant`/`memory_lifecycle_event` 스키마 승계, workspace_id+RLS FORCE, 스코프 4단(workspace/member/agent/conversation).
- **D2 추출 파이프라인**: outbox 소비 비동기 워커(단일 쓰기경로 유지) — mem0 2-phase + Graphiti invalid_at 무효화(조직 메모리는 삭제 대신 무효화=감사가능성). 추출 LLM 호출은 BYOA 경계 준수(워크스페이스 지정 에이전트/로컬 모델로 — provider 자격증명 비유입).
- **D3 검색 스택**: **pgvector 도입**(v0.8.5, PostgreSQL License — permissive 통과) + tsvector FTS + RRF 하이브리드. 스택 추가라 Accepted ADR 필수. 부수 효과: 메시지 검색도 ILIKE→FTS 승격 경로 열림.
- **D4 서빙**: Context Packet v0 실장과 결합 — partial projection을 불변 packet(packet_id/expires_at/**memory_refs**/budget/redactions)으로 승격, 프로필 블록 상시 주입+사실/에피소드 질의 시 조립+토큰 예산.
- **D5 가시성(momo 차별화)**: 워크스페이스 메모리를 **채널처럼 브라우징하는 1급 표면** — "에이전트가 아는 것" 뷰 + **각 항목의 출처 메시지 역링크**(메신저만 가능한 지점, OpenMemory/ChatGPT/Claude 어디에도 없음) + 편집/무효화 이력 + 관리자 정책 스위치(ChatGPT Enterprise 선례: 기본 off·끄면 삭제) + run별 "무엇이 서빙됐나" 인스펙터(MOMO-171 승계).
- **D6 에이전트 쓰기 경로**: Anthropic memory tool 책임 분리 이식 — 에이전트는 자기 스코프 메모리를 tool로 읽고 제안하되, **저장·권한·무효화는 서버 집행**(위험 쓰기=승인 정지점 준수).
- **선결 관계**: D4(packet 실장)가 D1~D3의 소비자이므로 packet 승격을 같은 ADR에 포함하거나 선행 배치로. 기존 gap-audit(research/14)의 "승인된 보안 ADR → Capability/Context/Memory foundation" 크리티컬 패스와 일치.

## §5. Blaxel — 협업 대응 + CTO 유휴/영속성 질문

> **2026-07-21 성재 결정: Blaxel 콜라보 캔슬.** 근거 — 아직 오픈소스화 전 단계라 콜라보 계약에 수반될 credential/코드 접근을 제공할 수 없음. **E2B 베이스로 우선 진행 확정**(ADR-0125 D3-A 유지). 아래 협업 전략·미팅 체크리스트는 기록용(향후 오픈소스 공개 후 재접촉 시 재사용). Nicolas에게는 정중한 보류 답장만 발신(초안: 세션 보고 — "지금은 평가 단계라 깊은 협업은 이르다" 톤).

**현재 좌표**: ADR-0125 D3에서 Blaxel은 후보군 표기(17-00 §1: "무제한 0-컴퓨트 스탠바이·25ms 재개")였고 파일럿은 E2B만 실시 → E2B 확정. **명시 기각 아님.** 프로비저너는 기질-불가지 인터페이스로 설계됨(D3-A) — 2nd provider 슬롯이 구조적으로 존재.

**CTO 질문 직답(19-04 §1)**: "유휴 반납 후 데이터 유지+재개" — **E2B·Blaxel·Morph는 메모리+FS 풀 스냅샷으로 가능**(Daytona/Vercel은 FS만, Modal/Cloudflare는 부적합). 보관비: E2B는 **공식 문서에 과금 조항이 없어 사실상 무료이나 미명문화**(재판매 규모에서는 Enterprise 계약에 보관 단가·보존 보장 명문화 필요), Blaxel은 **$0.20/GB-월 명시**(Tier0=7일·Tier1=30일 TTL). 시산: 대표 시나리오(활성 30분/일×22일, 스냅샷 5GB)에서 세션당 월 원가 **E2B ≈$1.82(+Pro 고정비 상각) vs Blaxel ≈$2.82** — 크레딧 판가 대비 무시 가능 수준. **가격 산정의 실질 변수는 활성 컴퓨트가 아니라 (a)스냅샷 보관×휴면 롱테일 (b)고정비 상각 (c)보존 기한 정책** → momo 요금제에 "휴면 N일 후 아카이브" 정책을 넣으면 보관 원가 캡핑.

**"사용자에게 원격 샌드박스 온디맨드 대여+크레딧" BM**: 이미 ADR-0125 D5(work_pool 슬롯)+D7(워크스페이스 과금: 동시 슬롯 N+월 활성시간 H+초과 종량)이 그 설계다. 리서치가 더한 것: **Devin ACU 선례(이종 원가를 단일 크레딧으로 합성+활성 15분 앵커) / upper bound는 "동시 세션+최대 시간"으로, 크레딧은 활성 사용량에만 연동 / Manus가 E2B 재판매 크레딧 BM의 스케일 실증**. momo Cloud 프로비저너 ADR(0125 예약분)에서 크레딧 단위를 이 문법으로 설계 권고.

**Blaxel 협업 전략(권고)**:
1. E2B 유지(파일럿 실증 자산). Blaxel은 **프로비저너 2nd 기질 후보로 등재** — 멀티 provider는 가격 협상 레버리지이자 리전 커버리지 보완.
2. Nicolas 답장은 "실사용 평가자" 포지션으로: 정직한 피드백 3가지(①아시아 리전 부재 — 한국 사용자 레이턴시, 서울/도쿄 로드맵? ②스냅샷 $0.20/GB-월은 경쟁 대비 높음 — 볼륨 커밋 할인? ③공개 SLA·파트너/리셀러 프로그램 부재) + 우리 유스케이스(self-hosted agent messenger의 T3 클라우드 세션, provider-불가지 프로비저너, 세션=무기한 standby 모델 — Blaxel의 perpetual sandbox와 정합) 소개 + 파트너 조건 타진. **커밋 없이 정보 수집** — E2B 전환 여부는 파일럿(E1~E5 동일 프로토콜 재실행) 후 별도 결정.
3. 미팅 시 확인 목록: 서울/도쿄 리전 로드맵 / 리셀러·볼륨 할인 구조 / SLA 약정 / 25ms resume 실측 조건 / 스냅샷 크기 산정 방식(루트FS가 메모리라 RAM 비례) / Tier TTL 상향 조건.

## §6. 구현-설계 정합 리뷰 (기존 구현이 설계를 따르는가)

**총평: 하드 불변식(RLS FORCE·자격증명 비유입·단일 쓰기경로·서버 raw 비경유·승인 원장)은 전 경로에서 준수 확인. 발견된 정합 이슈는 "위반"이 아니라 대부분 "스펙 대비 미완"이며, 아래 6건은 명시 관리 필요.**

| # | 발견 | 위치 | 판정·조치 |
|---|---|---|---|
| R1 | packet의 `permission_basis`가 실제 강제 범위보다 넓게 라벨링(actor 채널 멤버십은 암묵 검증) | `MessageRoutes.swift:2047-2051` | 라벨-실강제 불일치 — packet v0 실장(0129 D4) 시 실검증 항목으로 승격 |
| R2 | `tool_grants`가 하드코딩 mock(`mock-github`) — packet이 사실이 아닌 grant를 주장 | `MessageRoutes.swift:2062-2073` | dogfood 한정 무해하나 ADR-0113 실주입 전 제거 필수. 0129 D4에 포함 |
| R3 | work tool 화이트리스트 하드코딩(서버·앱·workd 3곳) vs ADR-0114 D7 "도구-불가지 프로파일" 설계 | `WorkControlRoutes.swift:507` 외 | 설계-코드 드리프트 — ADR-0130 D3(프로파일 원장)로 해소 |
| R4 | workd ProcessManager가 Pipe 기반(비-PTY) — MOMO-488 스펙의 "PTY 세션 매니저(앱과 프로토콜 공유)"와 불일치 | `ProcessManager.swift:32-66` | TUI 도구가 T2에서 제약됨(D10 원격 attach의 전제 훼손 가능). 0130 D1(ACP/PTY 통합) 시 정합 회복 권고 |
| R5 | inbound MCP protocolVersion "2025-06-18" — 현행 2025-11-25·2026-07-28 stateless 대개정 반영 전 | `InboundMCPToolRegistry.swift:11` | 스텁이라 무해. **호재**: stateless 개정은 momo의 HTTP 골격과 오히려 정합 — 완성 시점을 개정판 기준으로 |
| R6 | token kind `delegation` 스키마만 존재(ADR-0101 Phase 2 미착수) | `001_init.sql:334` | 워크스페이스 소유 세션(0126 D4)·operator 위임과 합류 시점에 착수 |

## §7. 우선순위 제안 (성재 결정 대기)

| 순위 | 항목 | 형태 | 근거 |
|---|---|---|---|
| 1 | **ADR-0129 Memory Plane & Context Fabric 런타임** 기안·승인 | 신규 ADR(스택 변경: pgvector) | 고민④ 직답이자 최대 갭. 스펙·fixture 기성이라 기안 비용 낮음. 에이전트 품질의 지배 변수 |
| 2 | **ADR-0130 외부 코딩 에이전트 멤버십(ACP 클라이언트+work tool gateway+프로파일 원장)** 기안·승인 | 신규 ADR | 고민②③의 공통 첫 수. 40+ 에이전트 즉시 호환, R3·R4 정합 회복 동반 |
| 3 | **MOMO-518(diff 카드) 승격 + 웹 Work 관전 큐 등재** | 기존 0126 파생 실행 | 고민①의 잔여. CTO 피드백의 "결과물 고도화" 절반 |
| 4 | ~~Blaxel 미팅~~ **캔슬(성재 2026-07-21)** — E2B Enterprise 보관 조항 문의만 유지 | 실행(비개발) | 오픈소스화 전 credential 제공 불가. E2B 베이스 확정, 재접촉은 공개 후 |
| 5 | Agent Membership Protocol 스펙 초안 | 보류(제품 질량 후) | §3 순서 원칙 — 오픈소스 공개·실사용 후 착수 |

**비고**: 1·2는 병렬 기안 가능(파일군 비충돌). 실행 배치는 기존 큐(iOS 모바일 플랜·UXUI 순차 배치·S 배치)와의 우선순위 조정이 필요하므로 성재 결정 사항.
