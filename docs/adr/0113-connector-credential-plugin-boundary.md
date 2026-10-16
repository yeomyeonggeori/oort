# ADR-0113: 커넥터 자격증명·플러그인 경계 — 오피셜 플러그인 플랫폼의 신뢰 모델

- Status: **Accepted** (2026-07-17, 성재 — 권고안 D1-A~D6 전체 승인 "ㄱㄱ". 첫 파생 SE-04A=MOMO-410부터 codex-fleet 발급)
- 증보: **2026-10-15 (#3838) 플러그인 레지스트리 이월 해제, 공식 4개 읽기 Rust 라우트부터** (성재 결재 「이월 풀고 읽기부터 (추천)」) — 파일 끝.
- 증보: **2026-10-16 (#3914) P3 착수 — 설치·grant·회수 쓰기 4경로** (성재 「미뤄둔 후속도 같이 작업해줘.」) — 파일 끝.
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
- `POST …/plugins/{plugin}/grants` `{scope}` · `DELETE …/plugins/{plugin}/grants/{scope}` — 활성 멤버 **본인 명의로만**. 요청에 멤버 필드가 없고(`plugin_grant_self_ck`), 관리자도 남 명의로 grant하지 못한다. 에이전트는 grant를 갖지도 만들지도 않는다(에이전트 bearer는 이 경로의 허용목록에 없다). grant는 설치·활성 상태(409)와 매니페스트가 선언한 scope(400)를 요구한다.
- 사람 bearer만. 모든 쓰기는 `with_tenant_tx` + RLS FORCE이고, 같은 tx에서 `audit_log` 행을 먼저 쓴다.

### W2. 대상 (P2의 연장)
- 만들기(설치·grant)는 공식 4개 중 `official`이고 미회수이며 매니페스트가 검증을 통과한 행에만 한다. 그 밖의 id는 없는 것과 같은 404다(설치 상태가 새지 않도록 404가 409보다 먼저).
- **거두기(설치 해제·grant 회수)는 항상 가능하다.** 레지스트리가 그 앱을 회수했거나 비공식으로 돌려도 설치와 grant는 치울 수 있다. 단 공식 4개 밖(`external_webhook`의 설치 행은 ADR-0115의 수명주기)은 이 경로로 닿지 않는다.

### W3. 의미
- 설치 해제 뒤 다시 설치해도 grant는 되살아나지 않는다(동의는 새로). 설치를 끄는 것(`enabled=false`)은 일시 정지다: 정책 조회가 설치 활성 상태에 조인하므로 도구가 즉시 빠지고(D5 fail-closed) 멤버의 동의는 남는다.
- 투영은 grant마다 「그 scope를 선언한 도구 수」만큼 쓴다(`github:read`는 migration 031 뒤 2행).
- 설치 해제와 동시에 들어온 grant는 설치 행을 `FOR SHARE`로 읽어 직렬화한다 — 해제된 설치 밑에 활성 grant가 남는 경우가 없다.

### W4. D5 영수증과 D1-A 강화
- 설치·grant 응답에 가산 필드 `egressDomains`(매니페스트가 선언한 도메인)를 싣는다 — 사람이 동의한 것의 영수증이다. 감사 `detail`에도 도메인·매니페스트 버전·digest를 남긴다. 거두는 응답에는 싣지 않는다. core 파서는 모르는 키를 무시하므로 가산 변경이다.
- 요청 본문은 문서화된 키만 받는다: install은 `enabled`뿐(본문 생략 가능), grant는 `scope`뿐. 그 밖의 키는 자격증명 모양이든 아니든 400이고 읽지도 저장하지도 에코하지도 않는다(Swift는 조용히 무시했다). 응답·감사 어디에도 토큰·시크릿 키가 없고, 키 이름 허용목록 시험이 이를 고정한다.

### W5. 승인 카드와의 관계
- ADR-0201 증보 v2 H7의 `plugin.install`은 이 쓰기의 같은 도메인 함수를 결정자 권한으로 부른다(#3889). 승인 전 설치 0·결정자 role 미달 403·승인 결과가 REST 설치와 같다는 계약은 ADR-0186/0201 그대로다.

### 구현 슬라이스
- **P-S2 (engine, #3914)**: 쓰기 4경로, 도메인 함수 `plugin_writes`, 계약 시험(red proof: 일반 멤버 install 403 · 설치 없이 grant 409 · 다른 워크스페이스 행 불가시(RLS) · 회수가 투영을 지움 · 응답·감사에 시크릿 키 없음 · 동시 해제 직렬화), 와이어 고정 `server/Fixtures/plugin-wire/mutation-*.json`.
- **P-U2 (UXUI)**: P-U1이 꺼 둔 「앱 설치」 표면을 이 경로가 배포된 뒤 켠다(`serverSurfaces`). #3860 짝.
- **#3889 (engine)**: `plugin.install` 승인 카드를 실행 가능으로.
- 범위 밖: 에이전트가 위임 사용자의 policy를 읽는 경로, 커뮤니티·워크스페이스 커스텀 플러그인, D1-B(서버측 토큰 보관은 계속 기각).
