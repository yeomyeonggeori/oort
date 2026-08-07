# ADR-0113: 커넥터 자격증명·플러그인 경계 — 오피셜 플러그인 플랫폼의 신뢰 모델

- Status: **Accepted** (2026-07-17, 성재 — 권고안 D1-A~D6 전체 승인 "ㄱㄱ". 첫 파생 SE-04A=MOMO-410부터 codex-fleet 발급)
- 관련: `research/16-plugin-platform/00~04`(생태계·제안·실검증·Slack/MM 호환), `docs/planning/proposals/2026-07-14-superapp-engine-roadmap.md` §ADR-0113·SE-04A/B, ADR-0004(provider 자격증명 비유입), ADR-0102(BYOA), ADR-0111(Work), ADR-0115(signed webhook — 본 ADR의 D6이 입력 제공), `research/13-redesign/03`(Drive 동결 트랙)
- 발단: 성재 발제 3회 누적 — ① "Codex 앱식 공식+커스텀 플러그인, 원클릭 설치, 1호 Drive"(2026-07-16) ② momo-main 구체화 지정(custody/Drive-vs-GitHub/delegation/egress) ③ "오피셜 플러그인 집중 + Slack/Mattermost에서 쓰던 것 계속 사용"(2026-07-16)

## Context (요지 — 근거는 research/16 시리즈)

1. **업계 3층 수렴 확정**: 플러그인 = MCP 서버(연결) + SKILL.md(지시) + plugin.json/marketplace.json(패키징). Codex가 `CLAUDE_PLUGIN_*` 호환 변수까지 유지 — 이 포맷 채택 시 oort 플러그인이 Codex/Claude 양쪽 BYOA 에이전트에서 동작한다(16-00).
2. **MCP 스펙상 토큰 보유 주체는 항상 "MCP 클라이언트"**(OAuth 2.1, RFC 9728/7591, 토큰 passthrough 금지) — 커스터디 질문의 실체는 "누가 클라이언트인가"다(16-00 §2).
3. **실검증 완료(16-03)**: GitHub(`api.githubcopilot.com/mcp/`, MIT)·Notion(`mcp.notion.com`, MIT, DCR)·Linear(`mcp.linear.app`, OAuth 2.1+DCR) 전부 호스티드 remote 위임 가능. **Google 공식 Workspace MCP 존재**(2026-05~, Developer Preview, `drivemcp.googleapis.com` — 단 배포자별 자체 GCP 프로젝트 필수, 공용 OAuth 앱 없음). Drive 스코프: `drive.file`=비민감, `drive.readonly`=restricted(CASA) — 단 **조직 internal 앱·자기 데이터만 접근하는 SA는 검증 면제**.
4. **Slack/MM 호환의 실체(16-04)**: 호환 가능한 것은 와이어 포맷뿐. Mattermost가 12년째 "Slack-compatible incoming webhook"으로 성공(copy-paste 수준), 플러그인 바이너리 호환은 MM 자신의 Apps Framework 실패(v10 철회)가 반면교사. MM 공식 플러그인은 Apache-2.0이라 **사양 이식은 자유**.
5. 기존 예약과의 관계: SE-04A(manifest registry)가 이 ADR의 첫 파생 배치이고, GWS connector는 "SE-04A 이후 hosted_connector plugin으로 수렴"이 기존 권고. `research/13` Drive workspace-archive 동결은 **서버측 토큰 보관** 때문이었다 — 본 ADR의 커스터디 결정이 그 동결 사유를 우회하는 첫 slice를 연다.

## Options & Decision (Proposed)

### D1. 자격증명 커스터디 — 누가 MCP 클라이언트인가

- **A (권고) — 에이전트 호스트 = MCP 클라이언트, 벤더 remote MCP 우선**: BYOA 에이전트 호스트가 OAuth 2.1 플로우(DCR)로 벤더 AS에서 직접 토큰 취득·보관. oort 서버는 **카탈로그·설치 정책·grant 기록·감사만** — 사용자 OAuth 토큰을 보관·중계하지 않는다(ADR-0004의 자연 연장). GitHub/Notion/Linear가 DCR 지원으로 이 경로 실증 완료.
- B — oort 서버측 보관(ChatGPT/Claude 모델): 플랫폼이 클라이언트가 되어 토큰 키관리 보관. 선례는 있으나 **ADR-0004 경계 변경**이며 oort 서버가 고가치 토큰 금고가 됨. 채택하려면 암호화 키 커스터디·회전·감사 표면을 이 ADR 후속으로 별도 결정해야 한다. **기각 권고**(v1) — 단 "oort Cloud" managed 제품에서 재검토 여지는 명시적으로 남긴다.
- C — stdio 로컬 서버 + env 자격증명: 스펙 공인 경로. remote가 없는 통합의 폴백으로 **A에 포함**(호스트 로컬 실행).

### D2. 신원·위임 바인딩 — 누구 명의의 grant인가 (momo-main 지정 ③)

- **권고**: grant는 **(workspace, member, plugin, scope) 4-튜플**로 oort registry에 기록한다. 실행 시 에이전트는 **위임 주체(사용자)의 grant**를 소비하며, Context Packet에 grant ref가 실리고 tool 호출은 기존 승인 티어(read_only/workspace_write/network_write)·audit_log를 통과한다(SE-02C action envelope 합류). 에이전트 자체 명의 grant(agent-owned)는 v1 제외 — "승인한 사용자의 Drive"라는 발제 그대로 사용자-위임 모델만. 다중 사용자 워크스페이스에서 토큰은 각 사용자의 에이전트-호스트 세션에 귀속되고, oort는 grant 레코드로 "누가 무엇을 허용했나"의 SoT를 가진다(토큰 없이).

### D3. 오피셜 플러그인 1차 라인업과 순서 (momo-main 지정 ② Drive-first vs GitHub-first)

- **권고 — GitHub-first, Drive 병행**: ① **GitHub**(remote MIT·PAT 폴백까지 있어 마찰 최소 — 기존 GitHub-first 전략과 일치, Work/코드 흐름과 직결) ② **Google Drive 1호 발제분**: **경로 C(SA+공유드라이브 — 기존 확정 정합·검증 부담 0·oort가 Drive REST를 자체 MCP 서버로 포장)로 출발**, 경로 A(셀프호스터별 GCP internal 앱 + 구글 공식 Drive MCP — restricted 스코프도 검증 면제)를 "개인 Drive" 확장으로 예약(Preview 졸업 시 재평가) ③ Notion·Linear(remote 위임 — 카탈로그 등재 비용 최소) ④ Slack·Dropbox 보류(게이팅/베타).
- 기각: Drive-단독-first — Drive 경로 C는 서버측 MCP 포장 구현이 필요해 GitHub(등재만)보다 무겁고, GWS 동결 트랙과의 정합 확인이 선행된다.

### D4. Slack/Mattermost 호환 표면 (성재 발제 ③)

- **권고 — "포맷 호환은 취하고 런타임 호환은 버린다"**: ① **Slack-compatible incoming webhook 채택(1순위)** — ADR-0115 signed ingress 위의 변환 레이어(`POST /hooks/{token}`, text+attachments+`<>`번역), 화이트리스트는 Mattermost 검증 부분집합 차용. GitHub/Jenkins/Grafana류가 URL 교체만으로 oort에 알림 ② outgoing/slash 포맷 호환은 2순위(Slack 자신이 legacy 강등 — 필요 시 MCP 툴 어댑터로만) ③ Block Kit **표시 전용 부분집합**은 후속 분리(MM이 거부한 지점 — 구현 시 구체적 우위) ④ **MM 플러그인 바이너리 호환 기각**(Go RPC 컴파일 결합 + MM 자신의 Apps Framework 철회가 근거) — 인기 플러그인은 Apache-2.0 사양 이식으로 대응.
- 이 결정은 ADR-0115 기안의 입력이다(Slack-호환 URL 시크릿 모드와 HMAC 서명 모드의 공존 설계).

### D5. remote runtime egress 경계 (momo-main 지정 ④)

- **권고**: 에이전트 호스트의 외부 트래픽(벤더 MCP/AS)은 **호스트 소유자의 책임 경계**로 두되, oort는 ① 카탈로그에 각 플러그인의 egress 대상(도메인 목록)을 manifest 필드로 명시(설치 화면 표시) ② grant 없는 플러그인의 도구가 Context Packet tool policy에 실리지 않게 fail-closed ③ 호출 결과의 audit_log 기록을 요구한다. oort 서버 자신의 egress는 현행 유지(Drive 경로 C의 SA 호출만 추가 — 이는 기존 GWS 런북 경계 내).

### D6. 플러그인 기술 정의·카탈로그 (SE-04A 계약 확장)

- **권고**: manifest는 업계 3층(plugin.json 계열 + `.mcp.json`(원격 URL 우선) + SKILL.md) + oort 확장 필드(`approvalTier` 매핑, `risk`, `egressDomains`, `recommendedFor`, `serverPolicy`). MCP 서버 기술부는 공식 MCP Registry `server.json` 스키마 재사용 검토. 카탈로그 탭: oort 공식/워크스페이스/커뮤니티(후속). 온보딩 추천 세트(예: GitHub+Drive+Slack-호환 webhook)는 ADR-0121 온보딩과 합류. SE-04A 수용기준(validator·install/grant/revoke·Capability Cache·RLS/audit)은 유지·확장.

## Consequences

- (+) 오피셜 플러그인 3~4종(GitHub/Notion/Linear는 등재 수준, Drive는 경로 C 포장)이 oort 서버 무보관 원칙 아래 성립. 기존 Slack 연동 자산(webhook 도구)이 URL 교체로 이식.
- (+) Drive 동결 트랙의 동결 사유(서버측 토큰)를 우회하는 실행 경로가 열림 — GWS 런북·SA 확정과 정합.
- (−) 에이전트 호스트가 토큰을 보유 — 호스트=사용자 소유 머신이라는 전제의 명문화 필요(다중 사용자 워크스페이스에서 호스트 공유 금지 등 운영 규약, SE-04A 문서화 항목).
- (−) Drive 경로 C는 oort 자체 MCP 서버 구현(신규 코드) — 1호 플러그인 중 가장 무거움. 경로 A 예약이 완충.
- 보류: 커뮤니티 마켓플레이스(서명·심사), Slack Web API 에뮬레이션, Block Kit 표시 부분집합, oort Cloud에서의 커스터디 B 재검토.

## 파생 (Accepted 후 — 기존 SE 큐와 정렬)

SE-04A(manifest registry — D6 계약으로 확장) → SE-04B(signed webhook + **D4 Slack-호환 모드**) → 신규 SE(GitHub 등재+grant 왕복) → 신규 SE(Drive 경로 C MCP 포장) → Notion/Linear 등재 → 온보딩 추천 세트(ADR-0121 합류). ADR-0116(context/memory)은 병렬 draft 유지.
