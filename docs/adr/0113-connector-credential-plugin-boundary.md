# ADR-0113: 커넥터 자격증명·플러그인 경계 — 오피셜 플러그인 플랫폼의 신뢰 모델

- Status: **Accepted** (2026-07-17, 성재 — 권고안 D1-A~D6 전체 승인 "ㄱㄱ". 첫 파생 SE-04A=MOMO-410부터 codex-fleet 발급)
- 증보: **2026-10-15 (#3838) 플러그인 레지스트리 이월 해제, 공식 4개 읽기 Rust 라우트부터** (성재 결재 「이월 풀고 읽기부터 (추천)」) — 파일 끝.
- 증보 2: **2026-10-16 채팅에서 앱 실행 경로·주요 커넥터·쓰기 도구** (성재 결재 「각자 + 1인 워크스페이스에서 Hermes 시험 (추천)」, 「코덱스 앱이나 다른 그록봇류 앱처럼 …」, 같은 날 저녁 「개인 Gmail 외부 앱」·「초안·라벨까지 (Recommended)」, 2026-10-17 「뭐 계정만 필요한거면 dawn.kim으로 우선하자. 나중에 바꿀 수도 있는거지 ?」 — 이 마지막 결재가 「개인 Gmail 외부 앱」을 대체한다) — 파일 끝. D1-A·D2·D5-①③·D6과 P1~P4는 바뀌지 않는다. D3 라인업과 Consequences의 「호스트 = 사용자 소유 머신」 문장을 조건부로 넓힌다. D3 경로 A의 「GCP internal 앱」 전제는 dawn.kim 조직 프로젝트에서 그대로 쓴다(E2). Google 세 앱의 시드·설치는 dawn.kim의 Developer Preview 가입과 OAuth client 준비(G-S0), 벤더 실측 뒤에 연다.
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
