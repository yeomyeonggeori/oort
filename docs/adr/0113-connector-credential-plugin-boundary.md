# ADR-0113: 커넥터 자격증명·플러그인 경계 — 오피셜 플러그인 플랫폼의 신뢰 모델

- Status: **Accepted** (2026-07-17, 성재 — 권고안 D1-A~D6 전체 승인 "ㄱㄱ". 첫 파생 SE-04A=MOMO-410부터 codex-fleet 발급)
- 증보: **2026-10-15 (#3838) 플러그인 레지스트리 이월 해제, 공식 4개 읽기 Rust 라우트부터** (성재 결재 「이월 풀고 읽기부터 (추천)」) — 파일 끝.
- 증보: **2026-10-16 (#3914) P3 착수 — 설치·grant·회수 쓰기 4경로** (성재 「미뤄둔 후속도 같이 작업해줘.」) — 파일 끝.
- 증보 2: **2026-10-16 채팅에서 앱 실행 경로·주요 커넥터·쓰기 도구** (성재 결재 「각자 + 1인 워크스페이스에서 Hermes 시험 (추천)」, 「코덱스 앱이나 다른 그록봇류 앱처럼 …」, 같은 날 저녁 「개인 Gmail 외부 앱」·「초안·라벨까지 (Recommended)」, 2026-10-17 「뭐 계정만 필요한거면 dawn.kim으로 우선하자. 나중에 바꿀 수도 있는거지 ?」 — 이 마지막 결재가 「개인 Gmail 외부 앱」을 대체한다) — 파일 끝. D1-A·D2·D5-①③·D6과 P1~P4는 바뀌지 않는다. D3 라인업과 Consequences의 「호스트 = 사용자 소유 머신」 문장을 조건부로 넓힌다. D3 경로 A의 「GCP internal 앱」 전제는 dawn.kim 조직 프로젝트에서 그대로 쓴다(E2). Google 세 앱의 시드·설치는 dawn.kim의 Developer Preview 가입과 OAuth client 준비(G-S0), 벤더 실측 뒤에 연다.
- 증보 3: **2026-10-24 (#4312) 앱 카탈로그 표시 필드·GitHub 한 타일·대화 속 「앱」 피커와 앱 칩** (성재 「플러그인은 채널이나 DM 레벨에 위치해서 ChatGPT 데스크탑 앱처럼 접근및 표시가 되어야할 거 같은데」, 「GPT 앱처럼 … 로고도 표시하고 … 이런식으로 보일 수 있게 작업해줄 수 있어 ?」 + 2026-10-22 위임) — 파일 끝. 모양과 진입만 바꾸고 E1·E3~E5·D1-A는 그대로다. 서버 계약은 요청 필드 `apps`·서버 소유 키 `props.requestedApps`·소유자 전용 투영 `members/me/app-runtimes`(F8)가 더해진다.
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

## 증보 2026-10-15 (#3838) — 플러그인 레지스트리 이월 해제, Rust 읽기 경로부터

- Status: **Accepted** (2026-10-15 성재 결재, 원문 인용 아래). 공개 API(새 Rust 라우트) 변경이라 ADR-0100에 따라 이 기록이 구현 머지 조건이다. D1~D6은 바뀌지 않는다.
- 결재 원문(2026-10-15, AskUserQuestion): 「이월 풀고 읽기부터 (추천)」 — 플러그인 레지스트리 이월을 풀고, 공식 4개(GitHub·Notion·Linear·Drive)의 읽기(목록·상세)를 먼저 Rust로 옮긴다.
- 무엇을 푸나: 2026-08-09 성재 판정 「이월 5 + 종속 1」 중 `plugins`(+`mcp` 종속)의 이월(`docs/planning/research/2026-08-09-swift-family-disposition-table.md` §3, ADR-0145 증보 1의 「판정 보류」 줄). 나머지 이월(`memories`·`huddles`·`workstreams`·`members 잔여`)은 그대로다.

### 확인한 사실 [V] (track/engine `6ee2386f8`)
- DB는 있다: `server/Migrations/013_plugin_registry.sql`(`plugin_registry` 전역 카탈로그 — 자격증명·토큰 없음, `workspace_plugin_install`·`plugin_grant`(D2의 4-튜플)·`plugin_capability_projection`은 테넌트 테이블), 공식 매니페스트 시드 `com.momo.plugins.github`·`.notion`·`.linear`(013), `.drive`(015), 도구 설명 보강(031·059). `momo_app`은 `plugin_registry`에 쓰기 권한이 없다(037).
- 웹 「앱」 화면과 core 호출부가 있다: `packages/momo-core/src/lib/api.ts`의 6경로(`GET …/plugins`, `GET …/plugins/{plugin}`, `POST·DELETE …/install`, `POST …/grants`, `DELETE …/grants/{scope}`)와 응답 파서(`PluginCatalogItem`, 정책 서술자), 화면 `clients/web/src/features/plugins/PluginSection.tsx`.
- Rust 라우트는 0이다(`/plugins` 없음). 그래서 `serverSurfaces.ts`의 `plugins`가 `provided:false`로 「앱」 진입점을 접어 둔다.

### P1. 이월 해제
- `plugins`는 「이월」에서 「이식 확정(단계적)」으로 바뀐다. `mcp`는 계속 `plugins`에 종속이다(매니페스트의 `mcp` 필드로만 쓰인다).

### P2. 첫 단계 = 읽기 둘, 공식 4개
- `GET /v1/workspaces/{ws}/plugins` — 카탈로그 + 호출한 사람의 실효 정책(설치 여부·내 grant), 자격증명 없음.
- `GET /v1/workspaces/{ws}/plugins/{plugin}` — 매니페스트 상세. 자격증명 없음.
- 대상은 `official = true AND revoked_at IS NULL`인 4개(`com.momo.plugins.github`·`.notion`·`.linear`·`.drive`)뿐이다. 다른 `plugin_id`는 없는 것과 같은 404.
- **와이어는 새로 짓지 않는다.** 이미 배포된 core 파서(`api.ts`의 `listPlugins`·`getPlugin`과 그 파서)가 받는 모양이 계약이다. Rust 구현은 그 파서를 통과하는 응답을 내고, 시험이 파서 픽스처와 Rust 응답을 맞춘다(Swift 시절 계약을 이어받는 방식, ADR-0145).
- 권한: 사람 JWT, 워크스페이스 활성 멤버. 테넌트 테이블 읽기는 `with_tenant_tx` + RLS FORCE, `plugin_registry`(전역·읽기 전용 카탈로그)는 같은 tx 안의 단순 SELECT. 쓰기 없음.

### P3. 쓰기(설치·grant·회수)는 다음 단계
- `install`·`grants` 4경로는 이번에 만들지 않는다(계속 404). 그래서 화면은 읽기 전용이어야 한다: `serverSurfaces`를 「앱 보기」(`plugins`, 이번에 켬)와 「앱 설치」(새 줄, 꺼짐)로 나누고, 설치·권한 버튼은 「앱 설치」가 켜질 때만 보인다(UXUI 슬라이스).
- 쓰기 단계를 열 때는 D2(4-튜플·위임 사용자 grant)·D5(egress 표시·fail-closed)를 그대로 지키는 별도 이슈다. D1-B(서버측 토큰 보관)는 계속 기각이다.

### P4. 바뀌지 않는 것
- D1 커스터디 A(토큰은 에이전트 호스트에만, oort 서버는 카탈로그·정책·grant 기록·감사만), D2~D6 전부.
- 커뮤니티·워크스페이스 커스텀 플러그인, 마켓플레이스, Slack-호환 웹훅(ADR-0115 쪽) 범위.

### 구현 슬라이스 (Accepted 후)
- **P-S1 (engine)**: 두 읽기 라우트, 공식 4개 술어, core 파서 픽스처와 맞추는 계약 시험. red proof: ① 비공식·회수된 플러그인은 404(술어를 지우면 실패), ② 응답 어디에도 토큰·시크릿 키가 없음(키 이름 허용목록 시험), ③ 다른 워크스페이스의 install·grant 행이 내 정책에 섞이지 않음(RLS), ④ 비멤버 404, ⑤ core `listPlugins` 파서가 Rust 응답을 받는다.
- **P-U1 (UXUI)**: `serverSurfaces` 분리(보기 켬·설치 꺼짐), 「앱」 화면 읽기 전용 상태, 캡처·design-review.

## 증보 2026-10-16 (#3914) — P3 착수: 설치·grant·회수 쓰기 4경로

- Status: **Accepted** (2026-10-16 성재 결재, 원문 인용 아래). 공개 API(새 Rust 라우트) 변경이라 ADR-0100에 따라 이 기록이 구현 머지 조건이다. 새 방향이 아니라 **P3가 「다음 단계」로 미뤄 둔 쓰기를 구현 계약으로 구체화**하는 증보다. D1~D6·P1~P4는 바뀌지 않는다.
- 결재 원문:
  - 2026-10-15 「이월 풀고 읽기부터 (추천)」 — 읽기를 먼저 옮기고 쓰기(설치·grant·회수)는 P3의 다음 단계로 미뤘다.
  - 2026-10-16 「미뤄둔 후속도 같이 작업해줘. 플러그인 관련 UI와 채팅에서의 플러그인 호출과 연동 관련 경험도 설계 및 작업계획화해줘.」 — 미뤄 둔 P3를 연다. UI·채팅 연동 설계는 별도 레인이고, 이 증보는 어떤 설계에도 필요한 엔진 쪽 쓰기 경로만 정한다.
- 참조 구현은 삭제된 Swift `PluginRoutes.swift`(`8f4a23cac^`)이고 와이어는 이미 배포된 core 파서(`packages/momo-core/src/lib/api.ts`의 `installPlugin`·`revokePluginInstall`·`grantPluginScope`·`revokePluginScope`)가 받는 모양이다. 아래는 Swift보다 **엄격해지는 곳만** 새로 정한 것이다.

### W1. 경로와 권한 (D2)
- `POST …/plugins/{plugin}/install` `{enabled?}` — 201 새 설치 / 200 기존 행 갱신·복구. 워크스페이스 owner/admin이고 매니페스트 `serverPolicy`(`installAllowed`·`allowedRoles`)가 그 역할을 허용할 때만. 아니면 403.
- `DELETE …/plugins/{plugin}/install` — owner/admin. 그 앱의 모든 멤버 grant를 한 감사 행으로 회수하고 능력 투영을 모두 지운다. 멱등.
- `POST …/plugins/{plugin}/grants` `{scope}` · `DELETE …/plugins/{plugin}/grants/{scope}` — 활성 멤버 **본인 명의로만**. 요청에 멤버 필드가 없고(`plugin_grant_self_ck`), 관리자도 남 명의로 grant하지 못한다. 에이전트는 grant를 갖지도 만들지도 않는다 — 에이전트 bearer는 이 경로의 허용목록에 없고, 도메인 함수도 `member.kind = 'human'`이 아니면 거절한다(경로 앞단에만 기대지 않는다). **손님(guest)은 grant하지 못한다(403)**: 호스티드 앱(Drive)은 서버 자체 자격으로 워크스페이스 데이터를 읽어 grant가 멤버별 유일한 문인데, 손님은 워크스페이스 전체를 보지 않는다. 반대로 **회수는 역할과 무관하게 항상 된다**(grant 뒤에 손님이 된 멤버도 자기 동의를 거둔다). grant는 설치·활성 상태(409)와 매니페스트가 선언한 scope(400)를 요구한다.
- 사람 bearer만. 모든 쓰기는 `with_tenant_tx` + RLS FORCE이고, 같은 tx에서 `audit_log` 행을 먼저 쓴다.

### W2. 대상 (P2의 연장)
- 만들기(설치·grant)는 공식 4개 중 `official`이고 미회수이며 매니페스트가 검증을 통과한 행에만 한다. 그 밖의 id는 없는 것과 같은 404다(설치 상태가 새지 않도록 404가 409보다 먼저).
- **거두기(설치 해제·grant 회수)는 항상 가능하다.** 레지스트리가 그 앱을 회수했거나 비공식으로 돌려도 설치와 grant는 치울 수 있다. 단 공식 4개 밖(`external_webhook`의 설치 행은 ADR-0115의 수명주기)은 이 경로로 닿지 않는다.

### W3. 의미
- 설치 해제 뒤 다시 설치해도 grant는 되살아나지 않는다(동의는 새로). 설치를 끄는 것(`enabled=false`)은 일시 정지다: 정책 조회가 설치 활성 상태에 조인하므로 도구가 즉시 빠지고(D5 fail-closed) 멤버의 동의는 남는다.
- 투영은 grant마다 「그 scope를 선언한 도구 수」만큼 쓴다(`github:read`는 migration 031 뒤 2행).
- 같은 호출의 반복은 기록을 늘리지 않는다: 이미 그 상태로 효력 중인 설치, 매니페스트가 지금 선언한 투영과 같은 투영으로 이미 활성인 grant는 200과 효력 중인 감사 id를 돌려주고 아무것도 쓰지 않는다(`installed_by`도 안 바뀐다). 매니페스트와 어긋난(도구가 바뀐) grant의 반복은 투영을 다시 짓고 새 감사 행을 쓴다. 설치 해제의 반복은 감사를 더하지 않지만 남은 투영·grant 찌꺼기는 다시 쓸어 낸다.
- 설치 해제와 동시에 들어온 grant는 설치 키(advisory lock)로 직렬화한다 — 설치·해제는 배타, grant는 공유로 잡는다. 해제된 설치 밑에 활성 grant가 남는 경우가 없고, 대기 중인 해제 뒤에 도착한 grant는 줄을 선다(grant를 반복해 관리자의 해제를 굶기지 못한다).

### W4. D5 영수증과 D1-A 강화
- 설치·grant 응답에 가산 필드 `egressDomains`(매니페스트가 선언한 도메인)를 싣는다 — 사람이 동의한 것의 영수증이다. 감사 `detail`에도 도메인·매니페스트 버전·digest를 남긴다. 거두는 응답에는 싣지 않는다. core 파서는 모르는 키를 무시하므로 가산 변경이다.
- 요청 본문은 문서화된 키만 받는다: install은 `enabled`뿐(본문 생략 가능), grant는 `scope`뿐. 그 밖의 키는 자격증명 모양이든 아니든 400이고 읽지도 저장하지도 에코하지도 않는다(Swift는 조용히 무시했다). 응답·감사 어디에도 토큰·시크릿 키가 없고, 키 이름 허용목록 시험이 이를 고정한다.

### W5. 승인 카드와의 관계
- ADR-0201 증보 v2 H7의 `plugin.install`은 이 쓰기의 같은 도메인 함수를 결정자 권한으로 부른다(#3889). 승인 전 설치 0·결정자 role 미달 403·승인 결과가 REST 설치와 같다는 계약은 ADR-0186/0201 그대로다.

### 구현 슬라이스
- **P-S2 (engine, #3914)**: 쓰기 4경로, 도메인 함수 `plugin_writes`, 계약 시험(red proof: 일반 멤버 install 403 · 설치 없이 grant 409 · 다른 워크스페이스 행 불가시(RLS) · 회수가 투영을 지움 · 응답·감사에 시크릿 키 없음 · 설치 키에서 줄 선 grant/해제의 결정적 직렬화), 와이어 고정 `server/Fixtures/plugin-wire/mutation-*.json`.
- **이월(P3 밖, 새 이슈)**: 멤버 탈퇴·정지 때 그 멤버의 grant 정리(재가입이 옛 동의를 되살리지 않게), 매니페스트가 바뀐 앱의 기존 투영 재동의(조회 시 현재 매니페스트와 교차). 에이전트가 위임 사용자의 정책을 읽는 경로가 열리기 전에 닫는다.
- **P-U2 (UXUI)**: P-U1이 꺼 둔 「앱 설치」 표면을 이 경로가 배포된 뒤 켠다(`serverSurfaces`). #3860 짝.
- **#3889 (engine)**: `plugin.install` 승인 카드를 실행 가능으로.
- 범위 밖: 에이전트가 위임 사용자의 policy를 읽는 경로, 커뮤니티·워크스페이스 커스텀 플러그인, D1-B(서버측 토큰 보관은 계속 기각).

## 증보 2 (2026-10-16) — 채팅에서 앱 실행 경로·주요 커넥터·쓰기 도구

- Status: **Accepted** (2026-10-16, 성재 결재 원문 아래. Google 계정 부분은 2026-10-17 재결재가 바꿨다). 보안 경계(어디서 누구 토큰으로 실행하나)·DB 계약(새 매니페스트 시드·새 approval 종류)·공개 API(매니페스트 와이어의 쓰기 도구) 변경이라 ADR-0100에 따라 이 기록이 구현 머지 조건이다. **두 가지는 아직 열지 않는다.** ① Google 세 앱(Calendar·Gmail·내 드라이브)의 시드·설치는 G-S0(dawn.kim의 Developer Preview 가입·OAuth client 준비)과 벤더 실측 뒤에 연다 — owner 재확인은 끝났다(결재 원문 6). ② E4의 Hermes 2단계 승인 얼굴(`connector_tool`)은 ADR-0203 증보 2단계(Proposed)와 같이 움직인다 — 그 확인 전에는 C-S4(#3956)를 시작하지 않는다.
- 결재 원문(2026-10-16, AskUserQuestion):
  1. 실행 장소: 「각자 + 1인 워크스페이스에서 Hermes 시험 (추천)」
  2. 입구·범위와 쓰기(두 질문에 같은 답): 「코덱스 앱이나 다른 그록봇류 앱처럼 구글쪽이랑 깃헙, 지라, 슬랙 등 메이저쪽 플러그인 지원 작업까지. 구글 캘린더나 구글 메일 드라이브등은 무조건 되어야함」
  3. GitHub 저장소 → 채널 알림: 「GitHub App으로 자동」 — 이 증보 밖이다. [ADR-0205](0205-github-app-integration.md)가 정한다(권한 묶음 결재 「GitHub App의 첫 권한을 어디까지 받을까요?」 → 「이슈·PR·체크+코드 읽기 (Recommended)」도 거기 인용한다).
  4. Google 연결 계정과 OAuth 앱 (2026-10-16 저녁, **6번이 대체함**): 질문 「Google 앱(캘린더·메일·드라이브) 연결을 어느 Google 계정과 OAuth 앱으로 만들까요?」 → 답 「개인 Gmail 외부 앱」. 이 답 뒤에 Preview 신청이 Workspace 계정을 요구한다는 사실(E2 [V])이 드러나 owner 재확인을 구했고, 그 답이 6번이다. 원문은 이력으로 남긴다.
  5. Gmail 쓰기 범위 (2026-10-16 저녁): 질문 「Gmail은 v1에서 「초안 만들기·라벨」까지만 해도 될까요?」 → 답 「초안·라벨까지 (Recommended)」. 보내기는 v1 밖으로 확정(E4).
  6. Google 계정 재결재 (2026-10-17, 성재 원문): 「뭐 계정만 필요한거면 dawn.kim으로 우선하자. 나중에 바꿀 수도 있는거지 ?」 — **4번의 「개인 Gmail 외부 앱」을 대체한다.** 읽는 법(planner): Google 세 앱의 Developer Preview 가입과 OAuth 앱 구성은 dawn.kim Workspace 계정으로 먼저 하고, 「나중에 바꿀 수도 있는거지」에는 「예, 계정·OAuth 앱은 설정값이다」로 답한다(E2·E6). 신청에는 계정뿐 아니라 Cloud 프로젝트 번호도 든다(E2 [V]) — 그 프로젝트도 dawn.kim 조직 것으로 한다. 이 결재가 owner 질문 1과 owner 재확인을 닫는다.
- 관계: ADR-0186(승인 카드 — 새 `action_type` 하나, 역방향 줄), ADR-0188 §8.9(workd MCP 예외, 같은 날 증보), ADR-0192 D3(설정 묶음)·D4(원장 비대칭 표기 선례)·D7 Q9(A5), ADR-0203 증보 2026-10-16(Hermes 커넥터 호스트), ADR-0162 D16(그록봇), ADR-0193 D4(`owner_only`), ADR-0201 H4·H7·H9, ADR-0205.
- 표기: [V] 직접 확인(track/engine `cfe8ec888` 코드·문서, 또는 2026-10-16 받은 벤더 공식 문서) · [추정] · [확인 필요](닫는 슬라이스를 함께 적는다) · `runtime-unverified`.

### 확인한 사실 [V]

- **Consequences 문장의 위치.** 「호스트 = 사용자 소유 머신, 다중 사용자 워크스페이스에서 호스트 공유 금지」는 D1이 아니라 Consequences(위 「(−) 에이전트 호스트가 토큰을 보유」 줄)에 있다. 설계 문서(`plugin-design.md` 안 C 표)가 이를 「D1」로 인용한 것은 틀렸다.
- **도우미 경계의 정확한 자리.** 설계·계획 문서가 인용한 「ADR-0201 H9-I5: 도우미는 앱 도구를 부르지 않는다」는 틀린 인용이다. H9-I5는 「시크릿 없음」이다(0201 H9). 실제 경계는 H7(연결은 승인 카드가 아니고 도우미는 `settings.open`만, 토큰을 묻지 않음), H9-I1(도우미에게 쓰기 도구 없음), H4 도구표(앱 관련 도구는 `list_plugins` 하나)다.
- **매니페스트 검증기**(`server-rust/bins/momo-server/src/plugin_manifest.rs`):
  - `SUPPORTED_TRANSPORTS = ["streamable_http"]`(:23) — 공식 매니페스트는 원격 HTTP MCP만 싣는다.
  - `SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18"]`(:22) 한 값.
  - `ALLOWED_SPDX`(:24-30)에 호스팅 서비스용 LicenseRef는 `LicenseRef-Linear-Hosted-Service` 하나.
  - 도구 risk·승인 조합(:418-445): `read` = `none`+`read_only`, `write` = `require_approval|always` + `workspace_write|network_write`, `admin` = `always|deny` + `network_write`. **쓰기 도구는 검증기가 이미 받는다.** 막고 있는 것은 시드와 「공식은 전부 read」를 단정하는 시험(:792 근처)이다.
  - `FORBIDDEN_KEY_FRAGMENTS`(:37-50)에 `client_secret`·`authorization`·`api_key` 등이 있다. 매니페스트에 OAuth 클라이언트 값을 넣을 수 없다(D1-A).
- **공식 시드**: github·notion·linear(013)·drive(015) 4개, 도구는 전부 `risk:read`(013·015·031·059). `github.list_repositories`(013:134)는 GitHub 공식 서버에 없는 이름이다(가장 가까운 것은 `search_repositories`). `notion.search`의 벤더 이름은 `notion-search`다. `schemaDigest`는 모두 `sha256:1111…` 같은 자리표시 값이다.
- **작업 payload**: 멘션 job은 `tool_grants`·`context_packet`을 일부러 싣지 않는다(`momo-agent/src/mention.rs:720-727`). 소비자는 있다 — `approval.rs:1281` `tool_grants_from_payload`, `approval_payload`의 `tool_call.tool_grant`(:803-831), `resume_job_payload`(:1143~). 이 폐곡선은 **oort agent-worker가 도구를 실행하는 경우**에 맞춰져 있다.
- **workd는 MCP를 전면 차단한다**: ADR-0188 D6, `momo-workd/src/policy.rs` — ACP `session/new`의 `"mcpServers": []`(:866), 인자 금지 바늘에 `mcp`(:884 `is_forbidden_launch_argument`), Codex `plugins`·`apps`·`remote_plugin` feature 끔(:590-606). 문서상 예외는 ADR-0192 D3 설정 묶음(구현 #2787 OPEN)뿐이다.
- **`owner_only`는 그대로 재사용할 수 없다**: `server/Migrations/089_agent_invocation_scope.sql:37-38`이 `(invocation_scope = 'owner_only') = (subscription_harness IS NOT NULL)`로 묶고, owner_only를 바꿀 수 없게 트리거로 막는다(:51-). 구독 하네스가 아닌 에이전트(Hermes·그록봇 연결)에 붙일 수 없다. 대신 같은 술어(「작성자 = 소유자」, ADR-0193 D4 `owner_only_gate`)를 새 표시로 쓴다(아래 E3).
- **벤더 원격 MCP**(2026-10-16 열람, 출처는 조사 보고서 원문):
  - Google Workspace MCP — Gmail `gmailmcp.googleapis.com/mcp/v1`, Calendar `calendarmcp…`, Drive `drivemcp…`. 9종 모두 **Developer Preview**, 배포자가 자기 GCP 프로젝트에 OAuth client를 만들어야 하고 DCR이 없다(developers.google.com/workspace/guides/configure-mcp-servers, 2026-10-13 갱신). **Gmail MCP에는 보내기 도구가 없다** — 「only creates drafts」(…/gmail/api/guides/configure-mcp-server, 2026-10-12). Preview 약관: 「may not grant end users access … prior to their GA announcement」(developers.google.com/workspace/preview, 2026-10-13).
  - GitHub `api.githubcopilot.com/mcp/`(`/mcp/readonly`, `/mcp/x/{toolset}`) — OAuth지만 DCR 없음, PAT 가능, MIT.
  - Atlassian Rovo `mcp.atlassian.com/v1/mcp`(권장 `/v2/mcp`) — OAuth 2.1 + DCR, `delete_jira`·`manage_jira` 묶음 기본 꺼짐(support.atlassian.com supported-tools).
  - Slack `mcp.slack.com/mcp` — DCR 없음, 「디렉터리 공개 앱이나 내부 앱만」(docs.slack.dev/ai/slack-mcp-server). GA 2026-02-17은 [2차 출처].
  - Notion `mcp.notion.com/mcp`, Linear `mcp.linear.app/mcp` — DCR.
- **Google Developer Preview 신청 자격**(2026-10-16 열람): 공식 Google Workspace MCP 서버는 Developer Preview 프로그램 가입이 전제다(developers.google.com/workspace/guides/configure-mcp-servers: 「Membership in the Google Workspace Developer Preview Program」). 신청 안내는 Workspace 계정과 Cloud 프로젝트 정보를 요구한다(developers.google.com/workspace/preview: 「You need to provide us with your Google Workspace account and Google Cloud project information」). 약관 문장은 「도메인·회사 밖」 최종 사용자에게 GA 전 접근을 주는 것만 막는다(「… I may not grant end users access, outside my domain or company, to developer applications that have been built using APIs prior to their GA announcement …」). 가입 절차(2026-10-17 같은 페이지를 다시 열람): 「When we verify your Google Workspace account information, we will add you to a Google Group for the program and you should receive a notification.」 「The whole process should be done within a couple of days.」 프로젝트 번호를 받는 이유는 「We provide you access to the program API features through your Google Cloud project(s).」다. 가입 뒤 이메일이나 프로젝트를 더하고 빼는 길은 폼 둘이다 — 「Request to add or remove email addresses」·「Request to add or remove your Google Cloud project」. 즉 Preview 가입은 계정(이메일)과 Cloud 프로젝트 번호 둘 다에 묶이고, 둘 다 나중에 바꿀 수 있다.
- **업계 쓰기 승인 기본값**: ChatGPT 앱(help.openai.com 11487775 — 기본 「Important actions」, 쓰기 확인), Claude 커넥터(support.claude.com 10166901 — 「동작마다 승인」이 기본, Team 소유자가 항상 허용 지정), Codex 플러그인(learn.chatgpt.com/docs/plugins — 한 번 허용 / 항상 허용). 공통: **읽기 자동, 쓰기는 호출마다 확인, 「항상 허용」은 기본 꺼짐.** ADR-0186 승인 카드 모양과 같아서 다른 패턴으로 바꿀 이유가 없다.

### E1. 실행 장소 — 요청한 사람 본인의 에이전트가 기본, 경로마다 강제 수준이 다르다

앱 도구는 **요청한 사람 본인 명의 grant**(D2)로, **그 사람의 토큰을 가진 실행 장소**(D1-A)에서만 돈다. 남의 grant, 남의 실행 장소, 팀 공용 실행기는 쓰지 않는다. 실행 장소는 셋이고, oort가 grant를 얼마나 강제할 수 있는지가 다르다.

| 실행 장소 | 토큰 위치 | grant 강제 | 쓰기 승인 얼굴 | 정본 |
|---|---|---|---|---|
| **내 맥(workd + Claude Code/Codex)** | 그 맥의 host 전용 프로필 폴더(ADR-0191 D1) [확인 필요: 정확한 저장 위치 — M-S0에서 실측] | **host가 강제**: 소유자 기기 키로 서명한 설정 묶음에 든 앱 MCP 항목만 쓰고, 도구 허용목록은 grant와 교집합 | ADR-0188 D5 권한 다리 카드(구현됨, §8.6) | ADR-0188 §8.9 |
| **1인 워크스페이스의 Hermes(같은 Railway 프로젝트)** | Hermes 볼륨 `mcp-tokens/`(ADR-0203 D7 밖 → 증보로 편입) | **Hermes 설정 + 서버 배달 가드로 강제**: `tools.include` 허용목록, 소유자 본인 작성만 배달, 사람 멤버 1명일 때만 | 1단계 쓰기 없음. 2단계 = 새 `connector_tool` 승인 카드(아래 E4) | ADR-0203 증보 2026-10-16 |
| **호스팅 벤더 에이전트(그록봇 등, Agent Port)** | 벤더 쪽 | **강제하지 못한다**: grant는 동의·감사 기록일 뿐 | 벤더 쪽 확인뿐. oort 카드는 「이 작업의 앱 승인은 그록봇에서 해요」(ADR-0192 D4 표기 선례) | 이 증보 E3 |

- 「각자」가 기본이다(결재 1). Hermes는 **소유자 1인 워크스페이스에서 소유자 본인 토큰으로 하는 시험**이고, 팀 공용 실행기가 아니다. 사람이 2명 이상인 워크스페이스로 넓히는 것은 이 증보가 열지 않는다(사람별 토큰 격리 — Hermes profiles — 를 먼저 정하는 새 증보가 필요하다).
- Consequences 문장 「호스트 = 사용자 소유 머신」을 **「운영자 = 토큰 주인 = 유일한 요청자인 같은 프로젝트 서비스」까지** 넓힌다. 조건은 ADR-0203 증보의 서버 강제 세 가지(소유자 작성만 배달·사람 멤버 1명·도구 잠금)이고, 하나라도 깨지면 넓힌 범위가 닫힌다. 「다중 사용자 워크스페이스에서 호스트 공유 금지」는 그대로다.
- oort agent-worker(팀 AI 키·Hermes 프로바이더 경로)가 **자기 프로세스에서** 벤더 MCP를 부르는 길은 열지 않는다. 그것은 서버 토큰 보관(D1-B)이고 계속 기각이다.
- 도우미(oort 팀 AI)는 실행 장소가 아니다. 아래 E7.

### E2. 공식 카탈로그 v1 — 앱 목록

결재 2의 「메이저쪽」과 「구글 … 무조건」을 다음 목록으로 읽는다. 기존 4개는 id를 바꾸지 않는다.

| 앱 (화면 이름) | plugin id | 원격 MCP (매니페스트 `mcp.url`) | 연결 방식 | 상태 |
|---|---|---|---|---|
| Google Calendar | `com.momo.plugins.google-calendar` (신규) | `https://calendarmcp.googleapis.com/mcp/v1` | 배포자 GCP OAuth client(DCR 없음, 결재 2026-10-17: dawn.kim 조직 프로젝트·Internal) | **미리보기**(Google Preview) · dawn.kim의 Preview 가입·client 준비(G-S0)와 실측 뒤 시드 |
| Gmail | `com.momo.plugins.gmail` (신규) | `https://gmailmcp.googleapis.com/mcp/v1` | 같음 | **미리보기** · 같음(G-S0 뒤). 쓰기는 초안·라벨까지(보내기 없음, 결재) |
| Google Drive · 내 드라이브 | `com.momo.plugins.google-drive` (신규, D3 경로 A) | `https://drivemcp.googleapis.com/mcp/v1` | 같음 | **미리보기** · 같음(G-S0 뒤) |
| Google Drive · 팀 공유 드라이브 | `com.momo.plugins.drive` (기존, D3 경로 C) | oort 자체(`/v1/mcp/drive`) | SA, oort 서버가 읽음 | `runtime-unverified` — `/v1/mcp/drive`가 Rust에 아직 없다(`momo-auth/src/agent_scope.rs:17`) |
| GitHub | `com.momo.plugins.github` (기존) | `https://api.githubcopilot.com/mcp/` | OAuth(DCR 없음) 또는 PAT | 쓰기 도구 추가 |
| Jira · Confluence | `com.momo.plugins.atlassian` (신규, 한 서버라 매니페스트 하나) | `https://mcp.atlassian.com/v1/mcp` [확인 필요: `/v2/mcp`로 시드할지 — C-S1b 실측] | OAuth 2.1 + DCR | 신규 |
| Slack | `com.momo.plugins.slack` (신규) | `https://mcp.slack.com/mcp` | 미리 등록한 Slack 내부 앱(DCR 없음) | 신규. **D3 ④ 「Slack 보류」를 푼다**(근거였던 게이팅·베타가 사라졌다) |
| Notion | `com.momo.plugins.notion` (기존) | `https://mcp.notion.com/mcp` | DCR | 쓰기 도구 추가 |
| Linear | `com.momo.plugins.linear` (기존) | `https://mcp.linear.app/mcp` | DCR, API 키 가능 | 쓰기 도구 추가 |

- **두 Drive를 함께 둔다.** 경로 C(팀 공유 드라이브, oort 서버가 SA로 읽음)와 경로 A(내 드라이브, 사람별 OAuth, 실행 장소가 읽음)는 서로를 대신하지 못한다. 화면 칩도 다르다(「팀 전체 · oort가 읽어요」 / 「내 드라이브 · 내 에이전트가 읽어요」). D3이 「Preview 졸업 시 재평가」로 예약한 경로 A를 **Preview 상태로 지금 연다** — 단 아래 「미리보기」 규칙 안에서.
- **Google 「미리보기」 규칙.** Google 세 앱은 매니페스트에 `momo.preview: true`(새 가산 필드)를 달고 「미리보기」 칩을 보인다. Preview 약관(「GA 전 최종 사용자에게 접근 허용 금지」)에 맞추어, GA 전에는 **배포자 본인(GCP 프로젝트 주인)이 자기 계정으로 쓰는 경우**에만 설치를 연다 — 성재의 1인 Hermes 시험과 성재 본인 맥이 여기에 든다. 기술적 상한도 같은 쪽이다: 아래 Internal 동의 화면이면 dawn.kim 조직 계정만 연결할 수 있어서 약관의 「도메인·회사 밖」 금지에 걸리지 않는다. 팀원에게 여는 것은 GA 공지 뒤의 별도 판단이다(약관 원문은 「도메인·회사 밖」 최종 사용자만 막지만 이 증보는 그보다 좁게, 배포자 본인으로 시작한다 — 위 [V]). Cursor 등 다른 제품이 이미 Google 플러그인을 냈지만 어떤 예외인지 확인할 수 없었다 [확인 필요: GA 공지 시 재확인 — 담당 G-S0].
- **Google 계정과 OAuth 앱 — 결재 2026-10-17: dawn.kim 우선.** 결재 원문 6 「뭐 계정만 필요한거면 dawn.kim으로 우선하자. 나중에 바꿀 수도 있는거지 ?」가 결재 원문 4 「개인 Gmail 외부 앱」을 대체한다. 새 이탈이 아니라 D3 경로 A의 원래 전제(조직이 소유한 GCP 프로젝트 + Internal 동의 화면)로 돌아가는 것이다.
  - **Preview 신청자는 dawn.kim Workspace 계정이다.** 신청에는 계정뿐 아니라 Cloud 프로젝트 번호도 든다(위 [V]).
  - **OAuth 앱은 dawn.kim 조직이 소유한 GCP 프로젝트의 Internal 동의 화면이다.** 프로젝트는 planner 기본값으로 이미 있는 `momo-dawn`(`docs/GWS_INTERNAL_CONSENT_RUNBOOK.md` §6.1)을 쓰고, 새로 만들어도 된다(owner는 계정만 정했다). Internal은 프로젝트가 조직 소유이고 동의 화면이 내부용으로 설정돼야 한다(support.google.com/cloud/answer/13464323 「The project must be owned by the organization, and its OAuth Consent Screen must be configured for internal use」 [V, 2026-10-17]). `momo-dawn`의 동의 화면 User type이 실제로 Internal인지는 콘솔에서 본다 [확인 필요: G-S0 ②].
  - **그 결과, dawn.kim 조직 계정만 이 client로 연결할 수 있다.** 「only users in the Workspace or Cloud Identity organization will be able to use your app」(같은 문서 [V]). 조직 밖 계정이 승인하면 `org_internal` 오류가 난다(support.google.com/cloud/answer/15549945 [V, 2026-10-17]). 성재의 개인 Gmail 계정과 dawn.kim 밖의 팀원은 연결할 수 없다. 그 계정들의 메일·일정·드라이브를 읽히려면 External 앱이 따로 필요하고, 그것은 별도 결재다.
  - **Internal이 면하는 것**: 같은 문서의 「When is verification not needed」 목록에 「Internal Use apps」가 있고(「it is not mandatory for your app to complete an OAuth verification」), 「Your app will not be subject to the unverified app screen or the 100-user cap if it's designated as internal-only」다([V]). 검증·CASA 면제는 런북 서두의 핵심 전제와 같다. 갱신 토큰의 **7일 만료**는 문서상 「an OAuth consent screen configured for an external user type and a publishing status of "Testing"」인 프로젝트에 걸린다(developers.google.com/identity/protocols/oauth2 [V, 2026-10-17]). Internal은 이 조건에 들지 않는다 — 문서가 Internal을 이름으로 말하지는 않으므로 실제 갱신 토큰 수명은 K-S1b가 잰다 [확인 필요].
  - **관리자 설정이 필요할 수 있다.** 15549945는 Internal 앱에도 「User authorization of scopes associated with restricted Google Workspace services, including high-risk Gmail and Drive scopes, might require additional configuration by your organization's administrators」라고 적는다. dawn.kim Workspace 관리자 콘솔에서 Internal 앱의 restricted API 접근을 따로 허용해야 하는지는 G-S0 ②에서 본다 [확인 필요].
  - **앞선 결재(4)가 감수했던 비용은 External을 고를 때만 돌아온다.** Testing 갱신 토큰 **7일 만료**, 사용자 **100명 상한**(15549945: Testing은 「up to 100 test users」, 미검증 앱은 「100 new users in total」), restricted 스코프(`gmail.readonly`·`drive.readonly`)를 공개 배포할 때의 **CASA 보안 평가**(support.google.com/cloud/answer/13464323·15549945). 이력으로 적어 둔다.
  - 팀원(dawn.kim 조직 계정)에게 여는 것은 위 「미리보기」 규칙대로 GA 공지 뒤의 별도 판단이다.
  - **나중에 바꿀 수 있다 — 계정·OAuth 앱은 설정값이다.** 순서와 근거는 E6 「교체」.
  이 결재가 owner 질문 1과 「어느 계정·프로젝트로 할지」 [확인 필요]를 닫는다.
- **[V, 2026-10-16·17] Preview 신청 자격 — 결재 원문 6으로 해소.** 공식 Google MCP 세 줄은 Developer Preview 가입이 전제이고, 신청 안내가 **Workspace 계정**과 Cloud 프로젝트 정보를 요구한다(위 [V]). 「개인 Gmail 외부 앱」(결재 원문 4)으로는 신청이 안 될 수 있다는 이탈이 이래서 드러났고, owner가 2026-10-17에 Workspace 계정(dawn.kim)이 신청자인 길을 골랐다. dawn.kim은 신청 안내가 요구하는 바로 그 종류의 계정이다.
  - 남은 불확실성은 하나다 — 신청의 승인 결과 [확인 필요: G-S0 ①]. 안내문은 며칠 안에 통지가 온다고 하고, 「If you don't hear from us within a week and there's no messages in your spam box, reach out to the program team by email」라고 적는다 [V]. 거절되거나 답이 없으면 owner가 다시 고른다: (b) 공식 Preview 대신 stdio 커뮤니티 서버(`workspace-mcp`)를 별도 증분으로 연다 — 검증기 transport 변경과 Hermes 런타임이 필요하다(ADR-0203 증보 K7). (c) Google 세 앱을 v1에서 보류하고 나머지 앱부터 연다.
  - 이 불확실성은 Google 세 앱의 시드와 K-S1b에만 걸린다. 다른 슬라이스는 G-S0를 기다리지 않는다.
- **도구 이름은 실측으로 정한다.** 매니페스트 도구 이름·`inputSchema`·`schemaDigest`는 각 벤더 서버의 실제 `tools/list` 응답에서 뽑아 migration에 싣는다(C-S1b). 이 증보는 이름을 계약하지 않고, 아래 E5의 **등급**과 **v1 제외 목록**을 계약한다. 2차 출처뿐인 이름(Slack·Linear 일부)은 실측 전 시드하지 않는다.
- **이름 규칙**: oort 도구 이름은 `<앱 짧은 이름>.<벤더 도구 이름 그대로>`(예 `gmail.create_draft`, `notion.notion-search`) [확인 필요: 기존 시드 이름(`notion.search`)을 바꿀지 별칭으로 둘지 — C-S1b, 기존 grant 행의 scope는 도구 이름이 아니라 `<앱>:<등급>`이라 영향 없음].
- **scope 단위**는 「앱:등급」이다: `gmail:read`·`gmail:draft`, `google-calendar:read`·`google-calendar:write`, `github:read`·`github:write` 등. D2 grant 4-튜플의 scope 칸에 그대로 들어가고, 쓰기 scope는 읽기 scope와 따로 동의받는다.
- **v1 밖**: Microsoft 365(Outlook·Teams·SharePoint·OneDrive), Dropbox, Figma, 커뮤니티·워크스페이스 커스텀 앱. 다음 증보 후보로 남긴다.
- **순서(C-S 슬라이스 편성 기준)**: 1파 = Notion·Linear·Atlassian(DCR이라 서버 밖 설정이 없다) + GitHub(PAT 또는 호스트 연결). 2파 = Google 세 앱(GCP client가 먼저 — 성재 Hermes 시험이 첫 사용처. dawn.kim의 Preview 가입·client 준비(G-S0)가 먼저다). 3파 = Slack(내부 앱이 먼저). 결재 2의 「구글 무조건」은 **v1 포함**이라는 뜻이지 1파라는 뜻이 아니다 — 다만 성재 1인 Hermes 시험은 Google 읽기부터 시작한다(ADR-0203 증보. 시험의 첫 실측 단계 K-S1a는 Google 없이 모의 서버로 먼저 한다).

### E3. 경로별 배달 규칙 — 앱을 붙인 에이전트는 소유자 본인만 부른다

- **새 표시 `agent.connector_owner_human_id`**(신규 migration, nullable, `ws_isolation` RLS 대상 테이블의 컬럼): 값이 있으면 그 에이전트는 「앱 실행 장소」이고, 서버는 **트리거 작성자가 그 사람일 때만** 작업을 배달한다. 같은 판정은 ADR-0193 D4 `owner_only_gate`의 새 갈래로 둔다. `owner_only` 자체는 089 CHECK 때문에 쓰지 못한다(위 사실).
  - 비소유자 사람의 멘션·DM → 배달 0, 에이전트 이름으로 한 문장 「이 에이전트는 ○○님의 앱 권한으로 움직여서, ○○님만 부를 수 있어요.」(ADR-0193 D6 쓰로틀과 같은 규칙).
  - 사람이 아닌 작성자(A2A 에이전트 멘션 `a2a.rs`, 웹훅, 시스템, 스레드 깨우기의 비소유자 답글) → 배달 0, 안내 없음.
  - 이 표시가 있는 에이전트는 호스팅 작업 요청(`type=work`, ADR-0162 D10)도 같은 술어를 지난다.
- **누가 켜나**: 그 에이전트의 소유자 본인(`owner_human_id`)만. 호스팅 벤더 에이전트는 소유자가 「이 에이전트에 내 앱을 붙여요」를 켤 때, Hermes는 ADR-0203 증보의 「커넥터 시험」을 운영자가 켤 때 기록한다. 끄기는 언제나 즉시다.
- **그록봇 경로(ADR-0162 D16)의 D2 보호**: 채널 승인으로 다른 멤버가 호스팅 에이전트에 일을 시키면 소유자 구독을 쓰는 것이 D16의 현행 노출이다. 커넥터가 붙으면 그 노출이 **소유자의 Gmail·Drive 권한**으로 커진다. 그래서 커넥터를 붙인 호스팅 에이전트는 위 표시를 필수로 한다 — oort가 벤더 쪽 도구를 막을 수 없으니, 막을 수 있는 유일한 자리인 배달에서 막는다.
- 이 경로에서 oort는 grant 밖 도구를 막지 못한다. 화면은 이를 숨기지 않는다: 앱 상세의 실행 장소 줄에 「그록봇: 앱 권한은 그록봇이 관리해요. oort는 허용 기록만 남겨요」.

### E4. 쓰기 — 호출마다 승인 카드, 「항상 허용」은 v1에 없다

- **매니페스트 등급(검증기가 이미 받는 값)**:

| 등급 | 뜻 | 매니페스트 | 예 |
|---|---|---|---|
| R | 읽기 | `read` + `none` + `read_only` | 검색·조회 |
| A | 나만 영향받고 되돌릴 수 있는 쓰기 | `write` + `require_approval` + `network_write` | Gmail 초안·라벨, 참석자 없는 내 일정, Drive 파일 만들기·복사, Notion 페이지 만들기·고치기 |
| B | 다른 사람에게 보이거나 알림이 가는 쓰기 | `write` + `always` + `network_write` | Slack 보내기, 참석자가 있는 일정·초대 응답, GitHub 이슈·PR·댓글, Jira 이슈·전환·댓글, Confluence 쓰기, Notion 댓글, Linear 이슈·댓글 |
| C | 삭제·권한·공유·병합·코드 푸시 | **v1 매니페스트에서 뺀다** | `delete_event`, Drive `share_file`·`trash_file`, GitHub `merge_pull_request`·`push_files`·`create_or_update_file`·`delete_file`, Jira `delete_jira`·`manage_jira`, Confluence 권한·공개 링크, `notion-delete-*`·`notion-move-pages` |

  - 외부 벤더 쓰기는 모두 `network_write`다(oort 워크스페이스가 아니라 바깥을 바꾼다).
  - 「참석자가 있으면 B」처럼 인자에 따라 등급이 바뀌는 도구는 **더 높은 등급(B)으로 선언**한다. 인자 판정을 실행 장소에 맡기지 않는다.
  - C를 `admin`+`deny`로 남겨 두는 대신 빼는 이유: 실행 장소(특히 Hermes·벤더)가 `deny`를 읽는다는 보장이 없다. 도구 목록에 없는 것이 가장 강한 거절이다.
  - **Gmail 보내기는 v1에 없다 — 확정(결재 2026-10-16 저녁, 「초안·라벨까지 (Recommended)」).** 공식 Gmail MCP에 보내기 도구가 없다(「only creates drafts」). 초안을 만들고 사람이 Gmail에서 보낸다. 보내기를 넣으려면 stdio 서버(검증기 transport 변경)나 oort 자체 포장(D1-B 방향)이 필요하고 범위가 다르다 — 새 증보 사안이다. owner 질문 2는 닫혔다.
- **「항상 허용」은 v1에 어느 경로에도 없다.** 근거: workd 권한 다리는 `allow_once`·`reject_once`만 받고 `allow_always`를 거부한다(ADR-0188 §8.6). ADR-0192 D3는 `permissions.allow mcp__…` 규칙을 거부한다. 그래서 workd에서는 구조적으로 불가능하고, 다른 경로만 열면 경로마다 규칙이 달라진다. 업계도 기본은 꺼짐이다.
  - 예외 하나: workd의 「이 세션 동안 허락」(ADR-0146 증보 2026-09-29, `scope=session`)은 **A 등급에만** 쓸 수 있다. B는 세션 허락을 거부하고 호출마다 묻는다(ADR-0188 §8.9).
  - 「항상 허용」은 뒤에 A 등급 한정·소유자 본인 설정·red proof와 함께 별도 증보로 연다.
- **결정자는 토큰 주인 본인뿐이다.** 관리자·채널 멤버가 대신 승인하지 못한다(`plugin_grant_self_ck`, D2). 폰에서는 「이번 한 번」만(ADR-0188 D5).
- **승인 얼굴은 경로마다 다르다(E1 표).**
  - workd: 기존 권한 다리 카드. 새 계약 없음.
  - Hermes(2단계): **새 approval `action_type = 'connector_tool'`**. ADR-0186 D2와 다른 점 — 승인해도 **서버는 아무것도 실행하지 않는다.** 서버는 결정을 worker에 넘기고, worker가 Hermes `POST /v1/runs/{run_id}/approval`로 돌려보낸다. 카드 문법(부록 A props, `momo.action_result.v1`)은 재사용하고, `approval.run_id`는 Hermes를 부른 oort agent_run이다. TTL은 Hermes 대기 시간보다 짧아야 한다 [확인 필요: Hermes 승인 대기 상한 — H-S2, K-S1a가 함께 잰다]. 이 종류는 결정자 = 그 에이전트의 `connector_owner_human_id`만 허용한다.
  - 호스팅 벤더: oort 카드 없음. 「쓴 앱」 꼬리에 「승인은 그록봇에서 했어요」.

### E5. `tool_grants` — 근거로만 싣고, 강제는 경로가 한다

- 멘션 job·spawn 지시·Hermes 호출에 **grant 근거**를 싣는다: `tool_grants: [{grantId, pluginId, scope, tools: [이름…]}]`. **토큰·MCP URL·OAuth 값은 싣지 않는다.** 생산자는 `mention.rs`의 job 조립(지금 일부러 뺀 자리)이고, 실행 시점의 grant 행(설치 활성 + 회수 안 됨 + 위임 사용자 = 트리거 작성자)에서 만든다.
- 강제는 경로가 한다(E1 표):
  - workd: host가 서명 묶음의 앱 MCP 항목 중 **`tool_grants`에도 있는 도구만** 설정에 적는다(교집합). 묶음에 없으면 grant가 있어도 쓰지 않는다 — 서버는 목록을 늘리지 못한다.
  - Hermes: 정적 `config.yaml`의 `tools.include`가 강제한다. Hermes는 `tool_grants`를 읽지 않는다. 서버는 배달 직전 「Hermes에 켜 둔 앱 ⊆ 소유자의 활성 grant」를 확인하고(운영자가 신고한 앱 목록과 grant 행 대조), 어긋나면 배달 0 + 운영자 안내.
  - 호스팅 벤더: 참고 필드. 강제 없음.
- **D5-② 「grant 없는 도구는 실리지 않게 fail-closed」는 강제할 수 있는 경로(workd·Hermes)에만 적용된다**고 밝힌다. 벤더 경로에서는 동의·감사 기록이다.
- 옛 서버·옛 host: `tool_grants`가 없는 job을 받은 host는 앱 도구를 **0개** 싣는다(새 host가 옛 서버를 만나도 0). 모르는 필드를 무시하는 옛 host는 애초에 앱 MCP를 싣지 않는다(지금의 전면 차단).
- 실행 도중 grant 회수·설치 해제: 다음 도구 호출부터 거절된다(workd: spawn마다 다시 쓰는 설정 + 다음 권한 요청 시점 재확인, Hermes: 다음 배달부터 0). 이미 끝난 호출은 되돌리지 않는다.
- 계획의 W3 E-3(「멘션 job에 `tool_grants` 싣기」)은 「강제」가 아니라 「근거·감사」 작업으로 범위를 다시 적는다.

### E6. 자격증명 — 매니페스트·서버에 OAuth 클라이언트 값 없음

- DCR 벤더(Notion·Linear·Atlassian)는 실행 장소가 스스로 등록한다. 서버 밖 설정이 없다.
- DCR 없는 벤더(Google·GitHub·Slack)는 **실행 장소마다 미리 등록한 클라이언트**를 쓴다. v1에서 그 값은 운영자·사용자가 실행 장소에 직접 넣는다(Hermes `oauth.client_id/client_secret`, 내 맥 host의 MCP 설정 또는 하네스 자체 연결). **서버가 클라이언트 값을 나눠 주는 API는 만들지 않는다**(`FORBIDDEN_KEY_FRAGMENTS`·D1-A 유지).
  - Google 설치형(Desktop) client의 secret은 Google 문서상 비밀이 아니지만(「the client secret is obviously not treated as a secret」, developers.google.com/identity/protocols/oauth2), 서버 배포 경로를 만들면 「클라이언트 자격증명 배포」라는 새 계약이 된다. 필요해지면 별도 증보로 연다.
  - Slack은 공개 앱을 oort가 내면 `client_secret`을 oort가 쥐어야 한다 — D1-A와 충돌하므로 v1은 **배포 조직의 Slack 내부 앱**이다.
- **교체 — 계정·OAuth 앱은 설정값이다**(결재 원문 6 「나중에 바꿀 수도 있는거지 ?」에 대한 답: 예). 클라이언트 값은 실행 장소 설정에만 있고 매니페스트·서버·DB에는 없다(위). 그래서 Google 계정이나 OAuth 앱을 바꾸는 일에 oort 코드·migration·매니페스트 변경은 없다. 순서:
  1. 새 OAuth client를 만든다(같은 조직의 다른 프로젝트, 또는 별도 결재를 받은 External 앱).
  2. 계정이나 프로젝트가 Preview에 없으면 더한다 — 프로그램 페이지의 폼 「Request to add or remove email addresses」·「Request to add or remove your Google Cloud project」(E2 [V], 폼의 처리 시간은 문서에 없다). 같은 프로젝트에서 client만 바꾸면 이 단계는 없다.
  3. 실행 장소 설정의 client 값을 바꾸고, 사용자가 앱마다 한 번 다시 로그인한다. 토큰은 발급받은 client에 묶여 있어서 옛 토큰은 새 client에서 쓸 수 없다.
  4. 옛 연결을 회수한다(ADR-0203 증보 K5 회수 순서: Google 「타사 앱 액세스」 해제, Hermes `mcp-tokens/` 삭제).
  바뀌지 않는 것은 매니페스트(`mcp.url`은 벤더 고정)·grant 행·승인 카드다. 바뀌는 것은 읽히는 데이터다 — 계정을 바꾸면 읽는 메일함·캘린더·드라이브 자체가 달라진다(dawn.kim에서 개인 Gmail로 바꾸려면 External 앱이 필요하다, E2).
- 호스트에 이미 있는 하네스 자체 커넥터(예: claude.ai 계정의 Gmail·Calendar·Drive)를 넘겨받는 길은 v1 계약이 아니다. workd가 `claude` 하위 프로세스에 그 커넥터를 싣는지부터 [확인 필요: M-S0 실측]. 실리면 다음 증보에서 「매니페스트 도구 ↔ 하네스 커넥터 이름 대응」 규칙과 함께 연다.

### E7. 도우미(oort 팀 AI) 경계는 그대로

- ADR-0201 H4(앱 도구는 `list_plugins`만)·H7(연결은 승인 카드가 아니다, `settings.open`만, 토큰을 묻지 않음)·H9-I1(쓰기 도구 없음)·H9-I5(시크릿 없음)는 **바뀌지 않는다**. 도우미는 앱 도구를 부르지 않는다. 「@oort Gmail에서 …」 같은 요청에는 「내 에이전트에게 맡기기」 줄(요청자 본인의 앱 실행 장소)을 제안한다.
- 바뀌는 것 하나: H7의 `plugin.install` `pluginId` enum(4개 고정)은 **「공식 카탈로그의 활성 id 집합」**을 따른다. 새 id 5개(`google-calendar`·`gmail`·`google-drive`·`atlassian`·`slack`)가 들어간다. 드리프트 시험이 레지스트리 시드와 enum을 함께 잰다. ADR-0201 H7에 역방향 줄을 단다.
- Hermes 시험 멤버는 도우미가 아니다. 도우미 경계(H9)와 충돌하지 않는다.

### E8. 감사

- grant·설치·회수: #3914 그대로(같은 tx 감사 행, 허용목록 키).
- 쓰기 승인: workd는 `work.permission.decided`(§8.6), Hermes는 `connector_tool` 승인 행 + `action.approved`/`action.rejected` 감사 한 줄(도구 이름·앱 id·결정자·run, **인자·결과 본문 없음**).
- 읽기·쓰기 사용 기록(D5-③): 실행 장소가 결과와 함께 「쓴 앱」 메타(앱 id·도구 이름·호출 수, 본문 없음)를 보고하고, 서버는 `connector.tool_used` 감사 한 줄을 남긴다. 이것은 **실행 장소의 자기 보고**이고, 화면·감사 문서에 그렇게 적는다. 벤더 경로는 보고가 없을 수 있다.
- 어떤 감사·로그·응답·Context Packet에도 토큰·OAuth 코드·클라이언트 secret 바이트가 없다(키 이름 허용목록 + 마커 시험).

### E9. 바뀌지 않는 것

- D1-A(토큰은 실행 장소에만), D1-B 기각, D2(4-튜플·본인 grant·`plugin_grant_self_ck`), D5-①(egress 도메인 표시)·③(감사), D6, P1~P4.
- ADR-0186 D2의 「같은 tx에서 결정자 권한 실행」은 workspace_action에 그대로다. `connector_tool`은 실행하지 않는 별도 갈래다.
- 클라이언트 직접 publish 금지·REST→outbox→relay 경로 — 앱 결과도 에이전트 명의 메시지로 같은 경로를 탄다.

### E10. 결과가 채널에 보일 때 — 꼬리에 노출 줄, 개인 앱은 요약만

- 앱을 쓴 에이전트의 답은 호출한 채널·스레드에 에이전트 명의 메시지로 올라오고(E9), 그 채널의 멤버 모두가 읽는다. 개인 앱(Gmail·Google Calendar·내 드라이브 — 사람 토큰으로 개인 데이터를 읽는 앱)의 결과가 채널로 새는 것이 이 경로에서 가장 현실적인 노출이다.
- **화면 규칙**: 채널에 보이는 앱 결과의 「쓴 앱」 꼬리(E8)에 「이 채널 n명에게 보여요」를 붙인다.
- **지시 규칙**: 개인 앱을 쓰는 작업에는 실행 장소에 「채널에 올리는 답은 요약만, 본문 인용 금지」 지시를 싣는다. 이 지시는 실행 장소(에이전트)의 자기 보고에 기대는 것이라 **강제가 아니다** — 화면과 문서에 그렇게 적는다(E8의 「쓴 앱」 메타와 같은 원칙). 지시를 싣는 자리는 U-S2·C-S3 착수 때 정한다 [확인 필요].
- **「나만 보기」**(요청자에게만 보이는 결과 카드)는 ADR-0186 D5 증보가 필요해서 이번에 열지 않는다(보류).
- 검증: 화면의 노출 줄과 자기 보고 안내는 U-S2(#3950) 몫이다(수용 기준 9).

### 구현 슬라이스 (Accepted 후, 한 슬라이스 = 한 이슈)

- **C-S1a (engine, #3937)** 매니페스트 검증기 준비: `momo` 허용 키에 `preview`, `ALLOWED_SPDX`에 호스팅 서비스 LicenseRef(Google·Atlassian·Slack·Notion), `SUPPORTED_PROTOCOL_VERSIONS` 다중화, 「공식 전부 read」 시험을 「C 등급 도구 0」 시험으로 교체. 시드는 없다.
- **C-S1b (engine, #3944)** 카탈로그 확장 migration: 새 앱 시드(Google 세 앱·Atlassian — Slack은 C-S1c) + 기존 3개에 쓰기 도구, 실측 `tools/list`에서 뽑은 이름·스키마·digest, E4 등급, `momo.preview`, `pluginId` enum을 활성 id 집합으로(E7), `github.list_repositories` 정정. **Google 세 앱은 G-S0(dawn.kim의 Preview 가입·OAuth client 준비)과 벤더 실측 `tools/list` 뒤에 시드한다.** owner 재확인은 끝났다(2026-10-17). Gmail은 초안·라벨까지.
- **C-S1c (engine, #3960)** Slack 시드(3파, Slack 내부 앱이 먼저).
- **C-S2 (engine, #3938)** `connector_owner_human_id` migration + `owner_only_gate` 갈래 + 사람 아닌 작성자 0 + 안내 문장.
- **C-S3 (engine, #3945)** `tool_grants` 생산자(근거만) + 옛 host 0 도구 계약 시험.
- **C-S4 (engine, #3956)** `connector_tool` approval 종류(실행 없음, 결정 전달) — ADR-0203 증보 2단계(Proposed)와 묶음. 그 확인 전에는 시작하지 않는다.
- **C-S5 (engine, #3946)** `connector.tool_used` 감사 수신.
- **U-2 (uxui, #3943)** 「앱 설치」 켜기(동의 창·네 칸 상태 1·2칸·관리자 없음). **U-S1 (#3949)** 앱 화면 v2(신규 앱·「미리보기」 칩·두 Drive 칩·실행 장소 줄·등급 표시). **U-S2 (#3950)** 「쓴 앱」 꼬리·막힘 문장·채널 노출 줄(E10)·`/앱`. **U-4 (#3951)** 폰 읽기 화면·폰 허용 경로. 캡처·design-review Blocker 0·High 0.
- **G-S0 (planner + owner)** ① dawn.kim Workspace 계정으로 Developer Preview 신청 — Cloud 프로젝트 번호(제안 `momo-dawn`)를 넣고 승인 통지를 확인해 결과를 기록한다. ② 같은 프로젝트에서 Gmail·Calendar·Drive MCP API를 켜고, 동의 화면 User type이 Internal인지 본 뒤(E2), dawn.kim Workspace 관리자 설정이 필요한지 확인하고 OAuth client를 만든다. ③ GA 공지 때 Preview 약관 재확인. 콘솔 단계는 planner가 링크로 드리고 손은 owner가 쓴다.
- workd 쪽은 ADR-0188 §8.9, Hermes 쪽은 ADR-0203 증보의 슬라이스를 따른다.

### 수용 기준 (red proof — 해당 분기를 지우면 실패해야 한다)

1. 새 시드 매니페스트가 검증기를 통과하고, C 등급 이름 목록(E4 표)의 도구가 어느 공식 매니페스트에도 0개다.
2. 매니페스트·시드·응답 어디에도 `client_id`·`client_secret`·토큰 모양 값이 없다(기존 `FORBIDDEN_KEY_FRAGMENTS` 시험 확장 + 마커).
3. `connector_owner_human_id`가 있는 에이전트: 소유자 멘션 → job 1, 다른 사람 멘션 → job 0 + 안내 1(쓰로틀), A2A·웹훅·시스템 작성자 → job 0·안내 0, 호스팅 작업 요청도 같은 판정.
4. `tool_grants`는 grant 행에서만 만들어지고(위임 사용자 = 작성자), 회수된 grant·해제된 설치는 0, 토큰·URL 키가 없다.
5. `tool_grants`가 없는 job에서 host 계약 시험의 앱 도구 수가 0이다.
6. `connector_tool` 승인은 결정자가 `connector_owner_human_id`가 아니면 403이고, 승인해도 서버 쪽 실행기 호출이 0이다(실행기 호출 계수).
7. `plugin.install` enum과 레지스트리 활성 공식 id 집합이 같다(드리프트 시험).
8. 「미리보기」 앱은 설치 화면에 칩이 보이고, `momo.preview` 필드를 지우면 UI 시험이 실패한다.
9. 채널에 보이는 앱 결과의 꼬리에 「이 채널 n명에게 보여요」가 붙고, 개인 앱의 「요약만, 본문 인용 금지」 지시가 실행 장소의 자기 보고라는 안내가 화면에 있다(문구를 지우면 UI 시험이 실패한다).

### owner 결정 (닫힘, 2026-10-16 저녁·2026-10-17)

1. Google 연결 계정과 OAuth 앱: ~~「개인 Gmail 외부 앱」(2026-10-16 저녁)~~ → **2026-10-17 「뭐 계정만 필요한거면 dawn.kim으로 우선하자. 나중에 바꿀 수도 있는거지 ?」가 대체했다.** dawn.kim Workspace 계정이 Preview 신청자이고, OAuth 앱은 dawn.kim 조직 프로젝트의 Internal(기본)이며, 계정·OAuth 앱은 나중에 바꿀 수 있다(E2·E6). 대체된 결재가 감수했던 7일 만료·100명 상한·공개 배포 시 CASA는 External을 고를 때만 돌아온다. **결과: dawn.kim 조직 계정만 연결할 수 있다.**
2. Gmail v1 범위: 「초안·라벨까지 (Recommended)」 — 보내기는 v1 밖으로 확정했다(E4).

### 아직 열려 있는 것

- dawn.kim Workspace 계정의 Google Developer Preview 신청 승인, `momo-dawn` 동의 화면의 실제 User type, 관리자 설정 필요 여부 — 닫는 슬라이스 G-S0. 신청이 안 되면 owner가 E2의 (b)(c) 중 다시 고른다.
- ADR-0188 §8.9 R(내 맥 읽기 자동 허락)과 ADR-0203 증보 2단계(Hermes 쓰기 중계)는 각 문서에서 Proposed다.

### 역방향 줄 (같은 문서 PR, D-0 #3935에서 달았다)

- ADR-0186 머리: 「역방향: ADR-0113 증보 2 E4가 `action_type='connector_tool'`(실행 없는 결정 전달)을 더한다. D2의 같은 tx 실행은 workspace_action에 그대로다.」
- ADR-0201 머리(H7): 「`pluginId` enum은 공식 카탈로그 활성 id 집합을 따른다(ADR-0113 증보 2 E7). H4·H9는 그대로다.」
- ADR-0162 머리(D16): 「커넥터를 붙인 호스팅 에이전트는 `connector_owner_human_id` 배달 규칙을 따른다(ADR-0113 증보 2 E3).」
- ADR-0192 머리(D3·D7 Q9): 「사람 토큰 없는 앱 카탈로그 확장과 실행 경로는 ADR-0113 증보 2가, GitHub App 자격증명은 ADR-0205가 A5에 앞서 좁게 정한다. 서버가 사람 토큰을 쥐는 MCP 카탈로그(A5 본체)는 그대로 목표 A 뒤다.」(D3의 앱 MCP 항목 모양은 ADR-0188 §8.9)
- 같은 PR이 ADR-0188 §8.9, ADR-0203 증보, ADR-0205(ADR-0115 관계 줄 포함)의 머리 줄과 포인터도 단다.

## 증보 3 (2026-10-24, #4312) — 앱 카탈로그 표시·GitHub 한 타일·대화 속 「앱」 피커와 앱 칩

- Status: **Accepted** (2026-10-24). 근거는 아래 owner 원문 두 줄과 2026-10-22 위임 원문이에요.
  - 매니페스트 와이어(D6 계약), 메시지 send 요청(새 필드 `apps`), 새 읽기 API(F8)가 생겨서, ADR-0100에 따라 이 기록이 구현 머지 조건이에요.
  - **이 증보는 모양과 진입만 바꿔요.** 실행 장소(E1)·배달(E3)·승인(E4)·근거(E5)·토큰 위치(D1-A)는 그대로예요. 사람별 연결과 토큰 금고는 ADR-0211(#4238) 몫이에요.
  - 독립 설계 검토 1회차(2026-10-24, FAIL: High 3 — `props` 와이어, 해석기 데이터, 대화 멤버십)와 2회차(High 0, Medium N1~N5·Low N6~N9)를 반영한 판이에요.
- owner 원문 (2026-10-24, Codex 데스크탑 「플러그인」 목록과 Gmail 상세 캡처와 함께):
  1. 「플러그인은 채널이나 DM 레벨에 위치해서 ChatGPT 데스크탑 앱처럼 접근및 표시가 되어야할 거 같은데. 그 부분도 체크해줘.」
  2. 「GPT 앱처럼 플러그인에 들어가면 저런 좋은 UI와 실제 해당 플러그인과 관련된 로고도 표시하고 … 이런식으로 보일 수 있게 작업해줄 수 있어 ?」
  3. 위임(2026-10-22): 「결정 부탁드릴 것은 너가 권장으로 진행해봐.」 — 아래 F1~F8의 세부(필드 모양, 칩 방식, 해석 규칙, 투영)는 planner 권장안이에요.
- 2026-10-16 결재 「부르는 방식 기본 = 에이전트에게 말로」는 그대로예요. 이 증보는 그 위에 **고르는 입구**를 더해요. `registry.ts:502-505`의 「`@GitHub` 별칭은 보류, 새 ADR」 주석이 가리키던 보류를 F5가 닫아요. 단 글자 별칭이 아니라 구조화된 칩이고, 그 주석은 #4315가 고쳐요.
- 관계:
  - ADR-0201 H2(별칭은 실제 멤버 핸들을 빼앗지 않음 — F5가 글자 별칭을 쓰지 않는 이유)
  - ADR-0205(GitHub App — F4는 표시만 합침)
  - ADR-0186(승인 카드, 변화 없음)
  - ADR-0188 §8.9(내 맥 앱 경로)
  - ADR-0203 증보(1인 Hermes 시험)
- 표기: [V] 직접 확인(track/engine `68e95f345`) · [확인 필요] · `runtime-unverified`.

### 확인한 사실 [V]

- **매니페스트 표시 필드**:
  - 선택 키는 `termsURL`·`privacyPolicyURL`·`iconText` 셋이에요(`plugin_manifest.rs:182`). 검증기는 정확한 키 집합이라 모르는 키를 거절해요(`:186-190`, 시험 `:1143`이 `plugin.homepage`를 거절).
  - 개발자 이름은 이미 필수 `plugin.publisher.{id,name,verified}`(`:173-181`·`:206-214`)에 있어요(시드 `013_plugin_registry.sql`·`143_official_catalog_c_s1b.sql`).
  - 카테고리·예시 문장·로고 자리는 없어요.
- **새 키를 담은 시드는 옛 서버에서 거절돼요.** 거절된 항목은 카탈로그에서 빠지고(`routes/plugins.rs:640-644`), 설치·grant도 막혀요. 시드 migration은 `manifest`와 `manifest_digest`를 함께 바꿔야 해요(`plugin_manifest.rs:140`).
- **MCP 판과 원격 이미지**:
  - 검증기는 MCP 프로토콜 세 판(`2025-03-26`·`2025-06-18`·`2025-11-25`)을 받아요(`:25`). 최신 판의 아이콘 메타는 [확인 필요: #4313]이에요. 있더라도 원격 이미지라 F1의 이유로 쓰지 않아요.
  - 데스크탑 CSP는 `img-src 'self' data:`라 원격 이미지를 그리지 않아요(`clients/desktop/src-tauri/tauri.conf.json:32`).
- **앱 화면과 진입**:
  - 앱 화면(`clients/web/src/features/plugins/PluginSection.tsx`, 1,415줄)은 글자 타일과 2단 목록·상세예요. 검색·보기 컨트롤은 앱 10개 이상일 때만 서요(`model.ts:510` `PLUGIN_CONTROLS_MAX_GLANCEABLE = 9`).
  - 진입은 사이드바 「AI」 → 「외부 연결」 → 「앱」이에요. 목록까지 클릭 3번, 상세까지 4번이에요(2026-10-21 웹 캡처 하네스 실측).
- **채널·DM 진입은 없어요.**
  - 컴포저 `/앱`(`ai.apps`, `registry.ts:501-527`)은 이동만 하는 `client` 명령이에요.
  - 대화 쪽 표시는 에이전트 답 아래 「쓴 앱」 꼬리뿐이에요(`clients/web/src/features/timeline/appsTail.ts`).
- **메시지 send의 `props`는 문자열→문자열 평평한 맵이에요**(`dto.rs:314-323`). 배열을 실을 수 없고, 구조화된 서버 소유 블록은 전용 요청 필드로 받는 것이 선례예요(`harnessRefine`). 서버 소유 키(`appsUsed`·`app_notice` 등)는 클라이언트가 보낸 값을 버려요(`routes/messages.rs:100-146`).
- **해석기에 필요한 사실이 지금 클라이언트에 없어요.**
  - `connector_owner`는 코어·웹·`openapi.yaml`·로스터 DTO 어디에도 노출되지 않아요.
  - Hermes 시험의 켜 둔 앱은 서버 환경변수 `OORT_COHOSTED_AGENT_CONNECTOR_APPS`에만 있어요(`momo-agent/src/connector_trial.rs:41-53`, DB 미저장).
  - 호스팅 벤더 에이전트는 에이전트 단위 표시 하나예요(`139_agent_connector_owner.sql`, CHECK `agent_connector_owner_is_owner`가 「표시 = owner_human_id」를 강제). 앱별 기록은 없어요.
- **멘션 배달은 에이전트가 그 대화의 멤버일 때만 돼요**(`routes/agent_mentions.rs:757` `DeliveryGate::NotChannelMember`).
- **배달 가드는 이미 있어요.** 구독 하네스 에이전트는 `owner_only`(089), 커넥터 에이전트는 E3(139)예요. 두 가드와 `tool_grants` 생산(`attach_app_tool_grants_in_tx`)은 `props`를 읽지 않아요.
- **GitHub는 얼굴이 둘이에요.**
  - 「GitHub 알림」(ADR-0205 인스턴스 GitHub App)의 등록·미연결 설치 목록은 인스턴스 운영자 전용이에요(`routes/github_app.rs`, `require_instance_operator`). 워크스페이스 관리자에게도 남의 설치 목록을 숨겨요(0205 D3).
  - 「앱」 안의 `com.momo.plugins.github`는 카탈로그라서 활성 멤버 누구나 읽어요(P2, `routes/plugins.rs`).
- **실행 경로 현황**:
  - 내 맥 경로는 `PLUGIN_MAC_APP_USE_READY = false`(`model.ts:648`)예요.
  - Hermes 시험은 1인 워크스페이스뿐이에요(`409 connector_trial_members`).
  - 호스팅 벤더 에이전트는 소유자가 `PUT …/agents/{agent}/connector-owner`(`routes/agent_connector_owner.rs`)로 표시를 켜면 실행 장소가 될 수 있어요. 이 경로는 E1대로 oort가 grant를 강제하지 못해요.

### F1. 매니페스트 표시 필드 — 가산, D6 계약 확장

`plugin` 객체에 선택 필드 넷을 더해요. 옛 클라이언트는 모르는 필드를 무시해요(코어 파서가 필드별로 읽음).

| 필드 | 규칙 | 쓰는 곳 |
|---|---|---|
| `logoKey` | `[a-z0-9-]{1,32}`. 클라이언트 번들 로고 자산의 이름 | 목록 타일·상세 머리·칩 |
| `category` | 닫힌 목록 `communication` · `productivity` · `developer` · `files` · `project` | 상세 「카테고리」, 나중의 필터 |
| `starterPrompts` | 0~3개. 각 `{ "text": 1~140자, "tool": "<이 매니페스트의 도구 이름>" }`이에요. 검증기는 `tool`이 이 매니페스트에 있고 등급이 R 또는 A(E4)인지 확인해요. `text`에는 URL 모양(`://`·`//`·`www.`)과 제어문자를 넣을 수 없어요 | 상세 예시 카드(F7) |
| `websiteURL` | https만(`termsURL`과 같은 검사) | 상세 「웹사이트」 |

- **개발자 칸은 새로 만들지 않아요.** 기존 `publisher.name`을 목록·상세 DTO에 실어요(이중 값이 어긋나는 것을 막아요).
- **원격 이미지 URL은 받지 않아요.** `iconURL`·`logoURL`·`imageURL`은 정확한 키 집합 밖이라 지금처럼 거절돼요. 근거는 셋이에요.
  - 데스크탑 CSP와 오프라인에서 깨져요.
  - 벤더 서버로 열람이 새요.
  - 공식 카탈로그는 우리가 골라요.
- **표시 문자열은 텍스트로만 그려요.** 마크다운을 해석하지 않아서, 마크다운 이미지로 원격 로드를 우회하지 못해요.
- `iconText`는 남겨요. `logoKey`가 없거나 클라이언트가 그 자산을 모르면 글자 타일로 돌아가요.
- **배포 순서와 롤백**:
  - 시드 migration은 `manifest`와 `manifest_digest`를 같은 표현식으로 함께 바꿔요.
  - 새 키를 담은 시드는 옛 서버 검증기에서 거절돼요. 그래서 서버 이미지만 옛 판으로 되돌리면 공식 앱이 카탈로그에서 빠져요.
  - #4313 PR은 검증기·DTO·시드를 한 번에 싣고, **되돌릴 때 시드를 먼저 되돌리는 SQL**을 PR 본문에 함께 둬요.

### F2. 로고 자산 — 번들, 벤더 가이드라인, 상표 귀속

- 공식 카탈로그 로고는 클라이언트 번들 SVG로 둬요. 웹·데스크탑은 `clients/web/src/assets/apps/<logoKey>.svg`, 폰은 같은 이름의 대응 자산이에요. 벤더 URL을 직접 불러오지 않아요.
- 로고를 넣는 PR은 벤더마다 브랜드 가이드라인 링크와 「통합 표시 용도」 판단을 표로 적어요. 대상은 GitHub·Google(Gmail·Calendar·Drive)·Notion·Linear·Atlassian·Slack이에요. `NOTICE`에는 「각 상표는 해당 회사의 것이고, 통합을 나타내는 용도로만 쓴다」 줄을 더해요.
- 허용 범위가 불분명한 로고는 넣지 않고 글자 타일로 남겨요. 레포가 공개라서 이 판단을 PR 본문에 남겨요.
- **시드와 번들의 대조**: 시드 매니페스트의 `logoKey` 집합 ⊆ (번들 자산 이름 ∪ 명시적 「글자 타일」 목록)이어야 해요. 클라이언트 시험이 서버 픽스처를 읽어 재요(`server/Fixtures/plugin-wire/*.json` 선례).

### F3. 카탈로그 정보 구조 — 「설치됨 / 공식」, 사이드바 한 번

- **진입**: 사이드바 「앱」 행(서버가 `plugins` 표면을 안 실으면 없음), 설정 목차 「앱·연결」의 「앱」 링크, ⌘K 「앱」. r3 P0-3(#4200)을 흡수해요.
- **목록**:
  - 왼쪽은 「설치됨」(로고 + 이름), 오른쪽은 검색과 묶음 「설치됨」·「공식」이에요. 나중에 「커스텀」이 붙어요.
  - Codex·ChatGPT의 「인기」「새롭고 주목할 만한」「소규모 기업」 구획은 수백 개를 전제한 구성이라 쓰지 않아요. 지금 카탈로그는 7~9개예요.
  - 검색은 앱 수와 상관없이 세워요.
- **상세**:
  - 큰 로고·이름·개발자(`publisher.name`)
  - 예시 카드 0~3개(F7)
  - 설명, 「할 수 있는 일」(도구·E4 등급)
  - 정보 표: 기능 · 개발자 · 카테고리 · 버전 · 웹사이트 · 개인정보 처리방침
  - 실행 장소 줄과 「쓰려면」 단계판(r3 P0-4)
  - 「설치」(관리자)
- **정직한 상태**: 「설치」가 곧 「쓸 수 있음」이 아니에요(ChatGPT도 「설치 ≠ 연결 ≠ 권한」). 상세는 지금 이 사람이 못 쓰는 이유와 다음 단계를 그대로 보여요.

### F4. GitHub 한 타일 — 구획마다 상태·권한을 따로

카탈로그에는 GitHub 타일 하나만 둬요. 상세는 두 구획이고, **두 구획의 상태·단추·기능 표시를 섞지 않아요.**

- **구획 1 「채널 알림 · 팀 전체 · oort 서버가 받아요」**(ADR-0205)
  - 상태 칩: 인스턴스 App 연결과 이 워크스페이스 연결 여부
  - 단추: 앱 만들기·설치 연결(운영자·관리자)
  - 기능: 읽기(App 권한 다섯 줄)
- **구획 2 「도구 · 내 에이전트」**(이 ADR의 E1~E5)
  - 상태 칩: 플러그인 설치와 내 grant
  - 단추: 워크스페이스에 설치(관리자)·권한 추가
  - 기능: 읽기·쓰기(E4 등급)
- 머리에는 「설치」 단추를 두지 않아요. 단추는 각 구획 안에 있어요.
- **역할별로 보이는 것**:

| 역할 | 구획 1 (채널 알림) | 구획 2 (도구) |
|---|---|---|
| 인스턴스 운영자 | 앱 등록 상태·미연결 설치·만들기 | 설치·내 grant |
| 워크스페이스 관리자 | 이 워크스페이스 연결 여부와 구독 안내(남의 설치 목록 없음, 0205 D3) | 설치·내 grant |
| 멤버 | 「GitHub 알림은 관리자가 켜요」 고정 안내 한 줄(서버 값 없음 — 멤버가 읽을 연결 상태 경로를 만들지 않아요) | 설치 여부·내 grant |

- 「AI › 외부 연결」의 「GitHub 알림」 줄은 이 상세의 구획 1로 이어요. ADR-0205의 자격증명(인스턴스 App)과 이 ADR의 사람 grant는 섞지 않아요.

### F5. 대화 속 「앱」 피커와 앱 칩 — 글자 별칭이 아니라 구조화된 칩

- **입구**: 컴포저 도구 줄의 「앱」 단추와 `@` 자동완성의 「앱」 묶음이에요. 설치된 앱을 로고·이름으로 보여요.
- **칩**: 고르면 컴포저에 앱 칩(구조화된 토큰)이 들어가요. 보낼 때 칩은 본문에서 **자격 에이전트의 실제 멘션**(그 에이전트 핸들)으로 바뀌고, 앱 id는 아래 요청 필드 `apps`로 따로 가요.
  - 본문에 `@Gmail` 같은 앱 이름 글자가 남지 않아요. 그래서 핸들이 `gmail`인 멤버가 멘션되지 않아요(ADR-0201 H2 그대로).
- **자격 판정(클라이언트, F8 투영을 읽음)**: 다음을 모두 만족하는 에이전트가 「자격 에이전트」예요.
  1. 요청자 본인이 소유자예요.
  2. F8 투영이 그 에이전트를 그 앱의 실행 장소로 보여요.
  3. **지금 이 대화(채널·DM)의 멤버예요.** 배달 관문 `NotChannelMember`와 같은 사실이에요.
- **결과**:
  - F8에 그 앱의 실행 장소가 하나도 없음 → 메시지를 보내지 않고 「앱 필요」 카드를 보여요(앱 상세의 「쓰려면」으로).
  - 실행 장소는 있지만 이 대화의 멤버가 아님 → 칩을 흐리게 두고 「내 에이전트와의 DM에서 쓰기」를 보여요. 누르면 F7과 같은 입구로 문장을 옮겨 채워요.
    - **에이전트를 이 대화에 자동으로 초대하지 않아요.** 개인 앱 실행 장소를 채널에 여는 것은 E10의 노출 경계라서, 초대는 사람이 하는 별도 행동으로 남겨요.
  - 자격 에이전트 1 → 그 에이전트 멘션으로 보내요.
  - 자격 에이전트 2 이상 → 피커가 어느 에이전트인지 물어요. 앱마다 마지막 선택을 기억하는데, 저장 키는 (워크스페이스, 멤버, 앱)이에요. 보낼 때 현재 자격 집합과 다시 맞추고, 낡은 id면 다시 물어요.
- **개인 앱 경고(E10)**: 개인 앱은 결과 정책이 개인인 앱(Gmail·Google Calendar·내 드라이브)이에요. 이런 앱을 사람 2명 이상인 대화에서 고르면, 보내기 전 칩 아래에 「답이 이 대화의 n명에게 보여요」 한 줄을 보여요. 막지는 않아요.
  - 내 에이전트와의 1:1 DM이면 경고하지 않아요.
  - 채널인데 인원을 모르면(`ChannelAudienceContext`가 `null`) 숫자 없이 「답이 이 채널에 보여요」를 보여요.
- **요청 필드 `apps`** (가산, 공개 API): send 요청 본문의 새 필드 `apps: ["<pluginId>"…]`예요. `harnessRefine` 선례대로 전용 필드로 받고, 평평한 `props` 맵에 싣지 않아요.
  - **서버 검증**: 작성자가 사람이고, 각 id가 이 워크스페이스에 설치된 활성 공식 앱이고, 중복을 뺀 뒤 3개 이하여야 해요.
    - 어기면 코드 달린 400 `apps_unavailable`이에요(`ApiError::coded`). 클라이언트는 칩을 지우고 앱 목록을 새로 받고, 초안 본문은 남겨요. 조용히 버리지 않아서 클라이언트 버그를 숨기지 않아요.
    - 검증은 send tx 안에서 **새 INSERT일 때만** 돌아요. 같은 `client_msg_id`의 재전송(`deduped`)은 `apps` 검증과 무관하게 저장본을 201로 돌려줘요(`routing` 허용목록 선례, `routes/messages.rs` 「201 in both the insert and the idempotent-retry case」). 그래서 첫 요청 뒤 앱이 해제돼도 재전송이 중복 전송을 만들지 않아요.
  - **저장**: 통과한 목록을 서버 소유 키 `props.requestedApps`(JSON 배열)로 써요. 이 키는 `momo_agent::SERVER_OWNED_APP_PROPS_KEYS`(`app_notice.rs`)에 더해요. 보내기·웹훅 수신·게이트웨이 답이 함께 읽는 목록이라, 클라이언트 `props` 맵·외부 웹훅 발신자·게이트웨이 어느 쪽이 보낸 같은 이름의 키도 버려져요.
  - 클라이언트는 **사람이 작성한 메시지에만** `requestedApps` 칩을 그려요(`appsTail.ts`가 반대 방향으로 이미 하는 방어와 같은 원칙).
  - **뜻**: 「요청자가 고른 앱」 표시예요.
    - 답의 사용 영수증 `appsUsed`(서버 소유, E8)와 다르고, grant도 아니에요.
    - 배달 판정과 `tool_grants` 계산은 이 필드를 읽지 않아요.
    - 실행 장소에 힌트로 넘길 수는 있지만 강제는 E5 경로가 해요.
  - 코어 파서는 `props.requestedApps`를 문자열 배열로 읽고, 모르는 모양이면 무시해요. `openapi.yaml`에 요청 필드와 응답 `props` 키를 적어요.
- **서버 배달 규칙은 그대로예요.** 칩 메시지도 일반 멘션이라 `owner_only`·E3 가드를 지나요. 해석이 잘못돼도 **남의 앱 grant와 실행 장소는 쓰이지 않아요.** 남의 일반 에이전트에게 멘션이 갈 수는 있지만, 그 에이전트에는 요청자의 앱 도구가 없어요.
- 도우미(oort 팀 AI) 경계 E7은 그대로예요. 앱 칩은 도우미로 풀리지 않아요.

### F6. 대화 속 표시 — 로고 칩

- 에이전트 답의 「쓴 앱」 꼬리(E8·E10)를 로고 칩으로 그려요. 이름·횟수·권한 주인·「이 채널 n명에게 보여요」는 그대로예요.
- 「붙은 앱」 칩(에이전트 행·프로필)은 **소유자 본인에게만** 보여요(F8과 같은 가시성). 다른 멤버는 남의 에이전트에 붙은 앱을 **목록으로는** 보지 못해요. 보낸 사람이 칩을 고른 메시지와 답의 「쓴 앱」 꼬리로 추론될 수는 있는데, 그건 E10이 받아들인 노출이에요.
- 사람 메시지의 `props.requestedApps`는 본문 위 작은 로고 칩으로 보여요. 대화 멤버 모두에게 보이는데, 보낸 사람이 F5 경고를 보고 고른 표시라서예요.

### F7. 예시 문장 — 누르면 할 일이 생겨요

- 상세의 예시 카드를 누르면, 그 앱의 실행 장소인 내 에이전트(F8, `blocked = null`)가 있을 때 기존 「DM 열기」로 그 에이전트와의 DM을 열어요. 이 동작은 DM이 없으면 만들어요(`dm_key` 멱등 — 쓰기가 한 번 일어날 수 있어요). 그리고 컴포저에 문장과 앱 칩을 채워요. 보내지는 않아요.
- 실행 장소가 없으면 「쓰려면」 단계판을 열어요. 예시 카드는 장식으로 두지 않아요.

### F8. 내 앱 실행 장소 투영 — 소유자에게만 (새 읽기 API)

- `GET /v1/workspaces/{ws}/members/me/app-runtimes`(`require_human`)예요. 요청자가 소유한 에이전트 가운데 아래 판별식에 맞는 것만 돌려줘요.
  - 모양: `[{ agentId, path: "hermes_trial" | "hosted_vendor", apps: [pluginId…], enforced: boolean, blocked: null | "attest" | "members" | "apps" | "connection" | "channel" | "paused" }]`
- **공통 술어**: `member.kind = 'agent' AND status = 'active' AND deleted_at IS NULL`(표시를 켜는 PUT과 같아요), `connector_owner_human_id = 요청자`예요.
  - 「활성 grant」는 요청자의 `plugin_grant` ⋈ `workspace_plugin_install`(설치 `enabled AND revoked_at IS NULL`)이에요. `TRIAL_FACTS_SQL`(`connector_trial.rs`)과 같은 조인이에요.
- **`path` 판별식**:
  - `hermes_trial` = 공통 술어 AND `agent_provider_pin.kind = 'operator_env'`(`TRIAL_FACTS_SQL`과 같은 술어)예요. `enforced: true`예요.
    - `apps` = 서버 환경변수 `OORT_COHOSTED_AGENT_CONNECTOR_APPS`의 앱 id ∩ 요청자 활성 grant예요. **언제나 요청자 활성 grant의 부분집합**이라 운영자 설정 전체가 드러나지 않아요. 앱 id는 공개 카탈로그 id라 비밀이 아니에요.
  - `hosted_vendor` = 공통 술어 AND 호스팅 연결이 있음 AND personal agent 아님 AND 구독 하네스 아님이에요. `enforced: false`이고, `apps` = 요청자 활성 grant예요.
    - 화면은 칩 피커에 E3 문장 「앱 권한은 ○○가 관리해요. oort는 허용 기록만 남겨요」를 그대로 보여요.
  - 그 밖은 v1 응답에 없어요. 표시를 켠 personal agent(내 맥 하네스 — 서버가 메시지로 시작하지 않음)와 구독 하네스가 여기에 들어요. 내 맥 경로(`mac`)는 `PLUGIN_MAC_APP_USE_READY`가 참이 될 때(ADR-0188 §8.9) 더해요.
- **`blocked` — 「능력」이 아니라 「지금 배달되나」**: 배달 관문(`agent_mentions.rs` `delivery_gate`)과 **같은 순수 함수**로 채워요. `null`이 아니면 F5에서 그 에이전트는 자격이 없고, 칩 피커는 이유를 사람 말로 보여요.
  - `hermes_trial`: `connector_trial_stop`의 결과예요. `attest`(선언 불완전), `members`(활성 사람 ≠ 1), `apps`(운영자가 켠 앱 중 소유자 grant가 없는 것이 있음 — 배달은 「켠 앱 ⊆ grant」)가 있어요.
  - `hosted_vendor`: `connection`(활성 연결 없음), `channel`(이 채널 미승인 — 대화마다 달라서 F5가 대화 맥락과 함께 봐요), `paused`(일시정지)예요.
  - 문장은 소유자(팀원)에게 맞는 말로 써요. 운영자용 문장(「Hermes의 앱 연결을 지우거나…」)을 그대로 보이지 않아요.
- **가시성**: 요청자 본인 소유 에이전트만 실어요. 남의 에이전트와 남의 grant는 이 응답에 절대 없어요. 로스터·에이전트 DTO에는 싣지 않아요. 실으면 모든 멤버가 「누구의 에이전트에 어떤 개인 앱이 붙었나」를 보게 되기 때문이에요.
- **권한 층**: 이 경로는 에이전트 경로 허용목록(`momo-auth/src/agent_scope.rs`)에 넣지 않아서 에이전트 bearer는 403이에요. `require_human`이 두 번째 층이에요.
- **옛 서버**: 클라이언트는 코어 `serverSurfaces.ts`에 표면 키 `appRuntimes`를 두고, F8이 404·405·501이면(`serverSaysAbsent`) 칩을 세우지 않고 `apps`도 보내지 않아요. 옛 서버의 send DTO는 `deny_unknown_fields`라 `apps`를 400으로 거절하기 때문이에요.

### 바뀌지 않는 것

- E1(실행 장소)·E3(배달)·E4(쓰기 승인, 「항상 허용」 없음)·E5(`tool_grants`는 grant 행에서만)·E7(도우미)과 D1-A·D2·D6의 나머지는 바뀌지 않아요.
- E10(채널 노출 줄)도 그대로이고, F5의 보내기 전 경고가 그 위에 더해질 뿐이에요.
- ADR-0201 H2(별칭 규칙)와 ADR-0205(GitHub App 자격증명·권한 다섯 줄)는 바뀌지 않아요.
- 사람별 OAuth 연결·토큰 보관은 다루지 않아요(ADR-0211, #4238).
- **이 증보가 착륙해도 팀원이 Gmail 등을 실제로 쓰게 되지는 않아요.** 그 문장을 화면(F3 정직한 상태)과 출시 노트에 그대로 써요.

### 구현 슬라이스 (한 슬라이스 = 한 이슈)

- **#4313 (engine)**: 증보 3의 서버 계약 전부예요. 공식 목록 픽스처 `server/Fixtures/plugin-wire/catalog.json`에 `logoKey`를 실어 수용 기준 4가 시드를 덮게 해요.
  - F1: 검증기 필드, `starterPrompts.tool` 검사, 시드, `publisher.name` DTO, 롤백 SQL
  - F5: 요청 필드 `apps`와 서버 소유 키 `requestedApps`
  - F8: 투영
  - `openapi.yaml`, 코어 타입·파서, 서버 시험
- **#4314 (uxui, #4313 뒤)**: F2·F3·F4·F7과 수용 기준 4·11·12예요. #4200을 흡수해요.
- **#4315 (uxui, #4313 뒤)**: F5 피커·칩·해석·직렬화·개인 앱 경고, F6 로고 칩, `registry.ts:502-505` 보류 주석 정리, 클라이언트 시험이에요.
- 폰은 후속 이슈예요. 읽기 목록·상세에 로고를 먼저 달고, 컴포저 피커는 입력창 두 상태(#4305) 뒤에 해요.

### 수용 기준 (red proof)

1. 검증기가 F1 필드를 한도 안에서 받고 한도 밖(길이·개수·http·URL 모양·제어문자)을 거절해요. `iconURL`·`logoURL`·`imageURL`도 거절해요. 사보타주: `iconURL`을 선택 키 목록에 넣으면 빨강이에요.
2. `starterPrompts.tool`이 매니페스트에 없거나 B 등급이면 거절해요. 사보타주: 그 검사를 지우면 빨강이에요.
3. 시드 migration이 `manifest`와 `manifest_digest`를 함께 갱신해요(기존 `computed_digest` 시험).
4. 시드 `logoKey` ⊆ 번들 자산 ∪ 글자 타일 목록이에요(클라이언트 시험, 서버 픽스처 공유). 모르는 `logoKey`는 글자 타일로 그려요.
5. `apps` 요청 필드:
   - 사람 아닌 작성자·미설치·비공식·중복 뺀 뒤 4개 이상이면 `apps_unavailable` 400이에요.
   - 설치 해제 뒤 같은 `client_msg_id`로 재전송하면 201이고 `requestedApps`가 첫 저장본과 같아요.
   - 웹훅 수신·게이트웨이 답이 실은 `requestedApps`도 버려져요.
   - 통과하면 `props.requestedApps`에 중복 없이 저장돼요.
   - `props` 맵으로 보낸 `requestedApps`는 버려져요.
6. `props.requestedApps`를 바꿔도 배달 판정과 `tool_grants`가 같아요. 사보타주: 배달 가드가 `requestedApps`가 있으면 소유자 검사를 건너뛰게 하면 빨강이에요.
7. F8 투영:
   - 남의 에이전트와 남의 grant가 없어요. 다른 멤버 소유의 `owner_only` 하네스 에이전트와 커넥터 에이전트 픽스처를 넣어 재요. 사보타주: 소유자 술어를 지우면 빨강이에요(정지된 시험은 목록에 남고 `blocked`를 가지므로 이 사보타주가 의미를 가져요).
   - `hermes_trial.apps` ⊆ 요청자 활성 grant예요.
   - 표시를 켠 personal agent는 응답에 없어요.
   - 정지된 시험·연결 없는 호스팅 에이전트는 `blocked`가 `null`이 아니에요.
   - 에이전트 bearer는 403이에요(경로 허용목록·`require_human` 두 층 각각).
8. 해석(UI 시험):
   - 실행 장소가 있지만 대화 멤버가 아니면 메시지 POST가 0이고 「DM에서 쓰기」가 서요.
   - 실행 장소가 없으면 POST가 0이고 「앱 필요」 카드가 서요.
9. 보낸 본문에 앱 이름 글자(`@Gmail`)가 없고 자격 에이전트 멘션만 있어요(UI 시험).
10. 개인 앱을 사람 2명 이상인 대화에서 고르면 보내기 전 노출 줄이 서요. 문구를 지우면 UI 시험이 빨개요.
11. GitHub 한 타일: 멤버 화면에 GitHub 계정 login·installation_id가 없고, 멤버 행은 고정 안내 한 줄이에요(멤버가 관리자 API를 부르지 않음 — 403을 장애로 그리지 않음).
12. 예시 카드는 실행 장소가 있으면 DM 컴포저를 채우고 보내지 않아요. 없으면 「쓰려면」을 열어요(UI 시험).

### 아직 열려 있는 것

- 로고별 브랜드 가이드라인 판단(#4314). 불분명하면 글자 타일이에요.
- MCP `2025-11-25` 판의 아이콘 메타 유무(#4313, 기록만).
- 내 맥 경로의 F8 모양(`mac`)은 ADR-0188 §8.9가 열릴 때 정해요.
- 폰 컴포저의 앱 피커 자리(#4305 이후).
