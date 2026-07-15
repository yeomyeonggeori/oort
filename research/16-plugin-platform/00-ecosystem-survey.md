# 16-00 · 플러그인 생태계 조사 — Codex/ChatGPT·Claude·MCP 표준 지형

> Planning ID: `PLN-20260716-01` (Fable) · 수집: 2026-07-16 deep-research · 발제: 성재 "Codex 앱식 공식+커스텀 플러그인, 원클릭 설치, 서버 단위 관리, 온보딩 추천, 에이전트 동적 발견 — 1호는 Google Drive"
> 검증 범례: [1차]=공식 문서/스펙 직접 확인 · [2차]=언론/커뮤니티 · **[미확인]=ADR 인용 전 재검증 필수**

## 1. Codex/ChatGPT 플러그인 생태계 (완료 트랙)

### 구조: "플러그인"이 최상위 배포 단위
- 2026-07-09부로 앱 디렉터리가 **플러그인 디렉터리로 통합** — 플러그인이 ChatGPT·Codex 전반의 1차 발견 단위. [1차: learn.chatgpt.com/docs/plugins]
- **플러그인 구성요소**: Skills(재사용 지시, 필요 시 로드) + Apps(GitHub/Slack/Drive 연결 — 구 커넥터) + MCP servers + Browser extensions + Hooks + Scheduled task templates. 즉 **플러그인 = MCP 서버(연결) + SKILL.md(지시) + 앱(UI/액션)을 묶은 manifest 패키지**.

### 기반 기술: 전부 MCP
- Apps SDK는 명시적으로 MCP 기반(필수: 도구를 노출하는 MCP 서버, 선택: iframe 웹 컴포넌트). [1차: developers.openai.com/apps-sdk]
- Codex 설정: `~/.codex/config.toml` `[mcp_servers.*]` — 데스크톱 앱·CLI·IDE가 **같은 config 공유**. stdio(command/env) + streamable HTTP(url, OAuth 기본). 원격 OAuth는 `codex mcp login`. 도구 발견은 서버 초기화 시점, 승인 모드 `auto/prompt/writes/approve`를 서버·도구 단위로. [1차: learn.chatgpt.com/docs/extend/mcp]

### 공식 플러그인·카테고리
- OpenAI 자체 제작 확인분: Codex Security, **Gmail, Google Drive(Docs/Sheets/Slides 포괄), Slack**. [1차] — Google이 공식 MCP를 안 낸 공백을 플랫폼이 자체 커넥터로 메꾸는 방증.
- 기능형: Computer Use, Chrome(공식 확장), Spreadsheets(xlsx), Presentations(pptx). 파트너 90+개(Figma/Notion/GitHub/Linear/Jira/Google Calendar 등 — 명단은 [2차], 재검증 권장).

### 디렉터리·설치·인증 UX
- 탭: `OpenAI`(공식) / `<워크스페이스명>` / `Personal`(Created by me·Shared with me) / `Installed`. [1차]
- 설치 = plus 버튼 한 번. **OAuth는 "설치 중" 또는 "첫 사용 시"** 두 시점 모두 존재. 호출은 자연어 발견 + **`@` 멘션 명시 호출**. [1차]
- 추천: featured row + "Built by OpenAI" 필터 + capabilities 라벨(Interactive/Read/Write). [2차 — 라벨은 재검증]
- **동적 발견(Apps SDK)**: 이름 호출 + 문맥 제안(대화 내용 관련 시 모델이 앱 제안) — **도구 description·메타데이터가 발견을 구동**. [1차]

### 커스텀 플러그인 제작·배포 [1차: learn.chatgpt.com/docs/build-plugins]
- **manifest**: `.codex-plugin/plugin.json` — name/version/description + 컴포넌트 포인터(`skills`, `mcpServers`→`.mcp.json`, `apps`, `hooks`) + 게시 메타 + 설치 화면 필드(displayName/category/**capabilities**/privacyPolicyURL/brandColor/logo/screenshots/defaultPrompt).
- 스킬: `skills/<name>/SKILL.md` — **Agent Skills 개방 표준**(Anthropic발, agentskills.io) 그대로.
- **마켓플레이스**: `marketplace.json` — 항목에 source(local/repo), **`policy: {"installation":"AVAILABLE","authentication":"ON_INSTALL"}`**, category. `codex plugin marketplace add owner/repo`.
- 배포 3경로: repo 스코프 / 개인(~/.codex/plugins) / 워크스페이스 공유(Share). 공개는 제출 심사.

### 워크스페이스/조직 관리 [1차]
- Workspace settings > Plugins: 플러그인별 enable/disable + **워크스페이스 전체 vs role 스코프**.
- **Enterprise/Edu는 기본 비활성(disabled by default)** — IT 심사 후 선별 허용. 앱 접근/액션/승인은 별도 관리면.

### Claude 진영과의 수렴 (강한 수렴 확인)
- Claude Code 플러그인 = plugin.json + marketplace.json + 스킬/훅/MCP — **동형 구조**. 공식 마켓 2종(official/community). [1차]
- **결정적 증거**: Codex 훅 env에 `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` 병기 — OpenAI가 Claude 플러그인 포맷 호환을 의도 유지. [1차]
- Claude 커넥터 디렉터리 = 검증된 **원격 MCP 서버** 목록(343+), 커스텀 커넥터는 Anthropic 클라우드가 접속. [1차]
- **업계 3층 수렴**: ① 연결=**MCP(+OAuth 2.1)** ② 지시=**SKILL.md** ③ 패키징/배포=**plugin.json + marketplace.json**. momo가 이 3층을 채택하면 Codex/Claude 양쪽 BYOA 에이전트와 자산 호환.

## 2. 아키텍처 — 토큰 커스터디·동적 발견 (완료 트랙)

### MCP authorization 스펙 (2025-06-18 rev) [1차: 스펙 전문 확인]
- OAuth 2.1 + RFC 8414/7591(DCR)/9728(PRM)/8707(resource). MCP 서버=리소스 서버, **MCP 클라이언트=OAuth 클라이언트**, AS 분리 가능.
- MUST: 401+PRM으로 AS 위치 광고, PKCE, resource 파라미터, audience 검증, **토큰 passthrough 금지**(업스트림용 토큰은 별도).
- DCR(사전 등록 없는 접속)이 **"원클릭 설치"의 프로토콜적 기반**. stdio 전송은 env 자격증명이 스펙 공인.

### 토큰 커스터디 3모델 (실증)
| 모델 | 실증 | 토큰 보유 |
|---|---|---|
| (A) 플랫폼 서버측 보관 | ChatGPT(OpenAI가 PKCE 수행·토큰 키관리 보관·AES-256), Claude 커스텀 커넥터(Anthropic 클라우드) | 플랫폼 |
| (B) 에이전트 호스트 보관 | Codex CLI/앱: config.toml + `codex mcp login` — 토큰이 사용자 머신에 | 에이전트 호스트 |
| (C) 벤더 호스티드 remote MCP | Claude 커넥터 343+, ChatGPT 파트너 앱 — 발급/폐기/스코프는 벤더 AS | (주의) access token은 여전히 MCP **클라이언트**가 보유 — 위임되는 건 발급·검증·수명주기 |

- **핵심 통찰**: 스펙상 토큰 보유 주체는 항상 MCP 클라이언트 → **커스터디 질문의 실체 = "누가 MCP 클라이언트인가"**. ChatGPT/Claude는 플랫폼 자신이 클라이언트라 (A). momo는 서버 코드실행·자격증명 비유입 불변식상 **BYOA 에이전트 호스트가 클라이언트가 되는 (B)+(C)가 유일하게 정합** — momo 서버는 카탈로그·설치 정책·스코프 표시·감사만. (A)형 채택은 ADR-0004 경계 변경 ADR이 선행돼야 함.

### 동적 도구 발견과 컨텍스트 관리
- 표준: `tools/list`(+listChanged). 도구 폭발 문제: 도구당 ~400-500토큰, 50개≈20-25K. [2차]
- 업계 해법: **Anthropic Tool Search Tool**(defer_loading + 검색 — 토큰 85% 절감, 다도구 정확도 상승) [1차], **github-mcp-server dynamic toolsets**(메타 도구 + X-MCP-Tools) [1차].
- 시사점: 에이전트 게이트웨이 계층에 **도구 검색/지연 로드 프리미티브를 처음부터** 설계.

### 카탈로그 스키마 선례
- 공식 MCP Registry(registry.modelcontextprotocol.io, preview)의 **`server.json`** 표준 — momo manifest의 MCP 서버 참조부에 재사용 검토. [1차]

## 3. 후보 통합별 공식 MCP 현황 (부분 — **재검증 필수**)

확정 [1차]: OpenAI가 Gmail·Drive·Slack을 자체 제작 배포. ChatGPT Business 커넥터에 Drive/Calendar/Notion/Linear/Dropbox/Asana 존재(Notion·Linear는 synced형도).

| 통합 | 예상(요검증) | 확인 필요 |
|---|---|---|
| GitHub | github/github-mcp-server(공식·MIT로 알려짐) + remote MCP | 라이선스 실물, 엔드포인트, OAuth/PAT |
| Notion | notion-mcp-server(MIT로 알려짐) + mcp.notion.com | 호스티드 OAuth 2.1, 도구 면면 |
| **Google 3종** | **공식 MCP 부재 가능성 높음**(구 레퍼런스 gdrive 아카이브) — 커뮤니티/자체 구현 필요 | 2026 공식 발표 여부, **drive.file 최소 스코프 전략**, OAuth 앱 검증(CASA) 요건 |
| Linear | mcp.linear.app(OAuth) | 엔드포인트·라이선스 |
| Slack/Dropbox | 불명 | 존재·라이선스 |

## 4. 메신저 마켓 선례 (부분 — **재검증 필수**, 훈련 지식 기반)

- Mattermost: System Console 관리자 설치(서버 단위), plugin.json manifest, 서버측 훅 통짜 권한(사용자별 OAuth 동의 없음), Apps Framework deprecated 방향 — 2026 현황 미확인.
- Slack: 설치 시 스코프 동의 화면 + Enterprise 관리자 사전 승인. Discord: Manage Server 권한 + 동의 화면 + featured 큐레이션.
- 대체 참조(확정 [1차]): ChatGPT 워크스페이스 정책 모델(기본 비활성·role 스코프·심사)과 Claude 공식 마켓 2종(큐레이션/커뮤니티 분리).

## 5. 결론 4줄

1. **플러그인 기술 정의(권고)**: manifest(plugin.json 계열) + MCP 서버 참조(원격 URL 우선, stdio는 호스트 실행) + 선택 SKILL.md. Codex·Claude 동형 + CLAUDE_* 호환 변수 → **이 포맷이면 momo 플러그인이 BYOA 에이전트 양쪽에서 그대로 동작**.
2. 후보 1순위 GitHub·Notion·Linear(호스티드 remote 예상), Google 3종은 공식 공백 가능성(ChatGPT조차 자체 제작) — 스코프 설계 필요.
3. 커스터디: **에이전트 호스트=MCP 클라이언트(B) + 벤더 remote 우선(C)**, momo 서버는 카탈로그·정책·감사 전용.
4. **원클릭 설치의 실체**: 카탈로그 manifest → 에이전트 호스트 config 주입 → 401→PRM→DCR→PKCE 자동 인증(ON_INSTALL vs 첫 사용 정책) → 워크스페이스 정책 게이트.

## 출처 (요지)

learn.chatgpt.com/docs/{plugins,build-plugins,extend/mcp,enterprise/work-admin-faq} · developers.openai.com/apps-sdk(+/build/auth) · openai.com/index/introducing-apps-in-chatgpt · openai.com/enterprise-privacy · modelcontextprotocol.io/specification/2025-06-18/basic/authorization · modelcontextprotocol.io/registry/about · platform.claude.com tool-search-tool · anthropic.com/engineering/advanced-tool-use · github.blog changelog 2025-12-10 · support.claude.com 커넥터 문서군 · code.claude.com/docs/en/discover-plugins · developers.openai.com/codex/skills. 2차: Neowin/digitalapplied 등(파트너 명단·UI 라벨 — 재검증 권장).

## 오픈 퀘스천 (후속 리서치 — 02 핸드오프에 승계)

1. 후보별 공식 MCP 서버 실검증(라이선스 실물·remote 엔드포인트·OAuth 방식) — 특히 **Google Workspace MCP 2026 현황과 drive.file 전략**(커스터디 옵션 C 성립 조건).
2. Mattermost 마켓플레이스 실검증(Apps Framework 지원종료 여부).
3. Codex 온보딩 "추천 설치" 편성 기준(문서 미기재 — 제품 관찰 필요).
