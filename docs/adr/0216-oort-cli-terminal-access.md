# ADR-0216: 명령줄·AI 도구 접근 — 사람 개발자 토큰, 별도 사람 MCP, `oort` CLI (브라우저 승인 먼저, 장치 코드는 SSH용 후속)

- Status: **Accepted** (2026-10-27, owner 결정 「권장대로 해봐」 — #4617 이슈 코멘트 2026-10-27). 아래 「owner 결정 5개」가 그 권장안이에요. 이 ADR이 새로 정한 것(planner 재량)은 끝의 「결재 기록」 표에 모두 적었어요. 문서만 바꾸는 PR이고, 구현은 이 ADR을 정본으로 인용하는 이슈들(#4660·#4661·#4662·#4663)의 몫이에요.
- Date: 2026-10-27
- Deciders: 성재
- 기안: Sonnet 5.5 엔진 워커 (#4617)
- 독립 보안 검수: r1 판정 FAIL(Blocker 0 · High 5 · Medium 17 · Low 9) → High 5개를 고친 뒤 같은 검수자가 고친 부분만 1회 확인해 **High 5개 모두 해소, 새 Blocker·High 없음**. 이 ADR의 첫 커밋(WIP)이 검수 대상 그대로의 판이에요. 자세한 것은 끝의 「결재 기록」에 있어요.
- 근거 결정
  - owner 2026-10-26: 「…왜냐면 나중에는 cli에서도 oort를 제어 가능해야하니까.」 (#4617)
  - owner 2026-10-27: 「터미널에서 oort를 통해 요청하거나 메시지를 남기거나 조회할 수 있는 MCP적인 부분도 되어야 해. 토큰 발급 프로세스도 UX를 고려해서.」 (#4660~#4663의 근거 인용)
  - owner 2026-10-27 「권장대로 해봐」 — planner가 #4617에 올린 권장안 다섯 가지를 그대로 정했어요. 아래 표가 그 다섯 가지예요.
- 관계: ADR-0100(공개 API·보안 경계·DB 계약은 Accepted ADR이 머지 조건) · ADR-0162(Agent Port·OAuth 서버. 이 ADR은 Agent Port를 바꾸지 않고, 증보 1의 OAuth 서버를 「사람 주체」로 확장하는 일은 체크리스트로 넘겨요) · ADR-0173(외부 도구는 generic 에이전트 자격으로 붙는다는 문장을 **개인 개발자 도구에 한해** 좁혀요 — F12) · ADR-0180과 증보(기기 연결. 8자 코드의 문자 집합·MAC·시도 예산 C2·C3·C6만 후속 장치 코드에서 빌려요) · ADR-0186(승인 카드. 개발자 토큰은 구조 변경을 하지 않으므로 우회가 아니에요. `propose`는 ADR-0186 증보 #4659를 따르고 이 ADR은 규칙을 정하지 않아요) · ADR-0190 D3-h(Claude Code 등록 실측 — F10) · ADR-0195(패스키. 재인증 선례 D-8, 교환권 D-7) · ADR-0198 D1·D7(하네스는 멤버가 아니라 「내 도구」) · ADR-0200 증보 4(`agent_port.call` 진단 기록의 모양) · ADR-0214(보안 주장은 시험이 없으면 공개하지 않는다) · ADR-0215(비밀번호 변경·재설정이 세션을 끝낸다 F7, refresh 재사용 F15)
- 번호 확인 [V, 2026-10-27, 이 브랜치를 처음 push하기 전과 PR 직전 두 번]: `origin/main`·`track/engine`·`track/uxui`를 포함한 다른 원격 브랜치 927개 전부의 `docs/adr/`에 0216이 없고, 열린 이슈·PR의 제목·본문·브랜치 이름에도 0216이 없다. 번호만 예약된 것은 0207(#4512)·0209(#4240의 「멀티 계정」)·0211(#4238)·0212(#4239)·0213(#4240)이고 파일은 아직 없다. 이 ADR은 **0216**만 쓴다. 특히 0212(#4239, 외부 에이전트 연결 요청)와 겹치는 곳은 D12에서 경계만 적고 내용을 가져오지 않았다.
- 표기: [V] 이번에 코드·문서를 직접 열어 확인 · [S] 조사 요약을 옮겼고 이 PR에서 1차 문서를 다시 열지 못함 · **[권장]** planner 재량으로 정한 결정 · `runtime-unverified` 실행해 보지 않음. 이 PR은 문서만 바꾸고 어떤 시험도 새로 돌리지 않았다. 코드 사실은 track/engine `16ad74731`을 읽어 얻었다.
- 용어: **개발자 토큰**은 이 ADR이 만드는 자격 종류(사람 개발자 토큰)다. **카드 토큰**은 설정 카드에서 만들어 한 번 보여 주는 개발자 토큰, **로그인 세션**은 `oort login`(또는 OAuth)으로 받은 access+refresh 한 계보다. **개발자 문**은 개발자 토큰이 닿는 두 표면(닫힌 REST 목록 + 사람 MCP)이다. **사람 MCP**는 `/v1/mcp/me`다. **계보**(lineage)는 ADR-0215의 용어, 한 번의 로그인이 낳은 토큰 묶음(`token.session_id`)이다.

## owner 결정 5개 (이 ADR의 전제)

| # | 결정 (2026-10-27 「권장대로 해봐」) | 이 ADR에서 |
|---|---|---|
| O1 | 정체성: 개발자 도구(CLI·Claude Code·Codex)는 **사람 개발자 토큰**, 동료·자동화(planner·CI)는 **에이전트** | D1 |
| O2 | 「명령줄·AI 도구 접근」은 **owner·admin 기본 켜짐**, 멤버는 관리자가 켜 줘요 | D3 |
| O3 | 로그인은 **브라우저 승인이 먼저**, 장치 코드는 SSH용 후속 | D6 |
| O4 | 토큰은 **기본 30일·최대 90일**, 한 번만 보여 주고, 마지막 사용을 표시하고, CLI 세션은 자동 갱신 | D2·D9 |
| O5 | 메시지 쓰기는 **즉시 전송**이고 「명령줄에서」 표식과 「읽기만」 프리셋을 둬요 | D8 |

## 맥락

oort는 에이전트가 1급 멤버인 메신저예요. Claude Code·Codex 같은 AI 도구나 사람이 터미널에서 oort를 조회하고, 메시지를 남기고, 요청(에이전트 멘션)할 수 있어야 한다는 요구가 두 번 들어왔어요. 지금 닿는 길은 둘뿐이고 둘 다 이 요구를 채우지 못해요.

1. **Agent Port MCP**(ADR-0162): 에이전트 멤버의 문이에요. 관리자가 에이전트를 만들고 연결 값을 붙여넣어요. 사람 세션 JWT는 들어오지 못해요(F1).
2. **데스크탑의 MCP 등록**(ADR-0190 D3-h): Claude Code에 Agent Port를 등록해 주는 길이에요. ADR-0198 증보 1이 기본 끔으로 돌렸고(하네스는 멤버가 아니라 「내 도구」), 비밀이 argv로 가는 모양이 실측돼 있어요(F10).

빈칸은 **사람 본인 이름으로 쓰는, 범위가 좁고 목록·폐기가 되는 자격**과 그것을 쓰는 CLI·MCP예요. 사람 세션으로 REST를 직접 부를 수는 있지만 15분짜리 JWT에 범위·목록·폐기가 없고(F4), ADR-0101이 없애려던 「도구가 사람 계정으로 섞이는」 모양이에요. 그래서 새 자격 종류를 만들어요. 새 자격 종류는 공개 API이자 보안 경계라서 이 ADR이 머지 조건이에요(ADR-0100).

### 지금 있는 것 [V, track/engine `16ad74731`]

| # | 사실 | 근거 |
|---|---|---|
| F1 | Agent Port 인증은 `momo_agent_v1.<워크스페이스 id>.<비밀>` 봉투, pairing 값, 켜져 있을 때의 hosted OAuth access 셋만 받는다. 사람 세션 JWT는 `invalid_token`이다 | `bins/momo-server/src/auth.rs:244-277`, `crates/momo-auth/src/agent_bearer.rs:40` |
| F2 | Agent Port 도구는 13개다. 범위는 연결 승인 ∩ 토큰 범위 ∩ 서버 capability의 교집합이다. `oort_action_propose`는 lease `handle`이 필수다 | `crates/momo-mcp/src/tools.rs:74-102`, `:808-810` |
| F3 | generic 에이전트 자격이 닿는 REST는 `required_agent_scope` 표(기본은 거절)뿐이다: 메시지 쓰기·히스토리·스레드 읽기, 자기 메시지 이어쓰기(`PATCH …/messages/{id}`), 작업 제어 요청(`POST …/work-controls`), 게이트웨이 콜백 | `crates/momo-auth/src/agent_scope.rs:84-222` |
| F4 | 사람 세션은 access 15분·refresh 30일, 기본 범위는 `messages:write messages:read`뿐이다. 사람 라우트는 역할·멤버십으로 가르고 범위 검사는 몇 곳뿐이라, 사람 세션에 「범위 고르기」를 얹으면 UI가 아니라 새 강제 계층이 필요하다 | `crates/momo-auth/src/issue.rs:23-25`, `routes/auth_routes.rs:167` |
| F5 | `token` 표: `token_kind`는 `session`·`agent_bearer`·`delegation`·`invite`, `token_hash` 유일, `scopes`·`label`·`last_used_at`·`expires_at`·`revoked_at`가 있다. 비밀번호 변경·재설정이 쓰는 멤버 전체 폐기 SQL(`revoke_member_session_tokens`)은 **`kind = 'session'`만 잡는다**. 정지·제거·탈퇴가 쓰는 `revoke_member_tokens_in_tx`는 kind를 가리지 않는다 | `server/Migrations/001_init.sql:331-352`, `crates/momo-auth/src/token_store.rs:466-472`, `crates/momo-settings/src/workspace.rs:428-452` |
| F6 | 메시지 전송 요청은 본문 말고도 `props`(문자열 평면 맵)·`type`·`runId`·`attachmentIds`·`routing`·`signature`·`stream`·`harnessRefine`·`apps`를 받는다 | `bins/momo-server/src/dto.rs:297-395` |
| F7 | OAuth 서버(ADR-0162 증보 1)는 flag로 닫혀 있고, 동의가 hosted 연결의 전용 에이전트 멤버에 결속된다(주체가 사람이 아니다). 리디렉트는 운영자 허용목록과 **문자열 정확 일치**이고 루프백은 `http://127.0.0.1:<포트>`를 포트까지 등록해야 한다. DCR·CIMD는 광고하지도 구현하지도 않는다 | `bins/momo-server/src/config.rs:787`, `crates/momo-mcp/src/oauth.rs:161`, ADR-0162 증보 1 A1·A2·A4 |
| F8 | 기기 연결(ADR-0180)과 증보(8자 코드, 문자 집합 C2, 키 있는 MAC C3, 실패 예산 C6)는 Accepted이고 구현 #4594는 열려 있다 | `docs/adr/0180-device-link-qr-token.md` |
| F9 | 비밀번호 변경·재설정은 `revoke_member_session_tokens`(토큰)와 `end_member_sessions_in_tx`(푸시·기기 키·예약 메시지)를 한 트랜잭션에서 부른다. 정지·제거·탈퇴는 `revoke_member_tokens_in_tx`(F5)로 토큰을 끝낸다. `end_member_sessions_in_tx` 자체는 토큰을 폐기하지 않는다. 「관리자가 멤버의 세션을 끝내는」 경로는 지금 코드에 없다(`RevocationCause` 7종에도 없다) | `crates/momo-auth/src/owner_claim.rs:194`, `:365`, `bins/momo-server/src/session_end.rs:98-115`, `crates/momo-settings/src/membership_lifecycle.rs:451`, `:501`, `bins/momo-server/src/routes/workspaces.rs:348` |
| F10 | 데스크탑 `aiConnect.ts`는 Agent Port용 `--header "Authorization: Bearer <값>"` 한 줄(argv 노출)을 짓는다. ADR-0190 D3-h 실측: `claude mcp add`는 값을 argv로만 받고, `${VAR}`는 글자 그대로 저장돼 **실행 환경에서** 풀리며, `headersHelper`는 저장은 되지만 실행·출력 계약은 확인하지 못했다. Codex는 `--bearer-token-env-var`로 환경 변수 **이름**만 쓴다 | `packages/momo-core/src/features/onboarding/aiConnect.ts:193-215`, `docs/adr/0190-local-terminal-lane.md` D3-h 표 |
| F11 | ADR-0198 D1·D7: 하네스(Claude Code·Codex)는 멤버가 아니라 「내 도구」다. 「Agent Port를 구독 에이전트의 레인 A로 쓰는 계획은 여기서 끝난다」. `token_kind='delegation'`은 스키마에만 있고 코드 사용이 0이다(ADR-0101 Phase 2) | `docs/adr/0198-…md` D1·D7, `001_init.sql:23` |
| F12 | ADR-0173(2026-08-28)은 「외부 도구(Claude Code·CI)는 사람 세션이 아니라 generic agent credential로 붙는 것이 제품 정체성과 맞다」고 적었다 | `docs/adr/0173-external-tool-message-read.md` 맥락 |
| F13 | `scripts/oort`는 이미 있는 **운영자용 bash CLI**(doctor·status·logs·upgrade·backup·restore·member)다. 문서는 늘 `scripts/oort …`로 부르고 PATH 설치 안내는 없다. `server-rust`에 `clap`·`keyring` 의존은 아직 없다 | `scripts/oort:1-45`, `docs/SELF_HOST.md` 919-924행, `server-rust/Cargo.lock` |
| F14 | Agent Port 속도 제한은 토큰당 분당 240·에이전트당 분당 480이고, 인증 tx 안에서 `auth.agent_bearer.used` 감사와 `last_used_at` 갱신이 원자적으로 일어난다. `agent_port.call`은 진단용이고 시간당 240행 상한이 있다 | `config.rs:815-816`, `auth.rs:234-243`, ADR-0200 증보 4 A1·A4 |
| F15 | Agent Port로 제안할 수 있는 행동은 9종이다(`invite.create`·`channel.create`·`channel.member.add`·`agent.rename`·`hosted.channels.grant`·`workspace.settings.update`·`agent.profile.update`·`agent.invite`·`member.avatar.set`). `workspace.memory/unfurl/work_tier.update`와 `plugin.install`은 팀 AI 전용이고 `member.role.set`·`webhook.create`는 미실행이다 | `crates/momo-mcp/src/tools.rs:501-511`, `crates/momo-agent/src/actions.rs:243-262` |
| F16 | 공용 「최근 재인증」 장치(재인증 증명을 세션에 남겨 재사용하는 것)는 코드에 없다. 본인 비밀번호 변경 라우트가 현재 비밀번호를 본문으로 받는 것이 현행 패턴이다 | `routes/password.rs`, ADR-0215 F7 |
| F17 | `GET /v1/workspaces/{ws}/inbox`의 응답은 `items`·`nextCursor`·`unreadCount`와, 첫 쪽에 한해 `approvalsPending`(승인 카드 최대 20개: `channelId`·`runId`·`requestedBy`·`actionType`·`payload` 전체)이다. 승인 목록은 멤버십만 조인하고 `unreadCount`는 보이는 전체 항목 수다. 도메인 함수는 `list_inbox_in_tx`·`inbox_unread_count_in_tx`다 | `bins/momo-server/src/routes/inbox.rs:193-261`, `bins/momo-server/src/dto.rs:5357-5377`, `crates/momo-messaging/src/inbox.rs:241`, `:342` |
| F18 | OpenAPI(`openapi.yaml`)에 없는 연산 28개가 `docs/api/openapi.undocumented-allowlist.json`에 따로 적혀 있고, 그중 승인 결정 `POST /v1/agent-runs/{run}/approval-decisions` 같은 것은 라우터에 마운트돼 있다. 기존 `required_agent_scope`는 라우터가 확정한 템플릿이 아니라 원시 경로의 세그먼트 모양으로 맞춘다 | `docs/api/openapi.undocumented-allowlist.json`, `bins/momo-server/src/lib.rs:1812`, `crates/momo-auth/src/agent_scope.rs:84-93` |

### 업계 조사 [S — 2026-10-27 조사 요약을 옮김, 이 PR에서 1차 문서를 다시 열지 않았다]

| 대상 | 요지 | 영향 |
|---|---|---|
| GitHub | `gh auth login`은 웹 흐름(장치 코드 8자·900초). 세분화 PAT는 소유자 1곳·저장소·세부 권한·**기본 30일**·한 번만 표시 (https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps) | D2·D6 |
| Stripe | 관리자 「MCP and CLI access」 모드별 토글. CLI 로그인은 터미널 페어링 코드를 Dashboard에서 확인. 자격은 OS 보안 저장소에 두고 자동 갱신. 라이브 키는 한 번만 표시 (https://docs.stripe.com/mcp , https://docs.stripe.com/cli/login) | D3·D10 |
| Slack · Linear · Notion | 대화형 MCP는 **사람 본인 권한**으로 동작하고 자율 에이전트(봇·`actor=app`)는 따로 다룬다. Linear는 `/readonly` 변형을 둔다. Notion은 관리자가 클라이언트를 제한한다 (https://docs.slack.dev/ai/slack-mcp-server , https://linear.app/docs/mcp , https://developers.notion.com/docs/mcp) | D1·D3·D8 |
| Atlassian | API 토큰 방식은 **조직 관리자가 켜야** 쓸 수 있다 (https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server) | D3 |
| Vercel | `vercel login`은 장치 흐름(RFC 8628)만 남겼다. MCP는 연결마다 명시 동의로 혼동된 대리인을 막는다 (https://vercel.com/changelog/new-vercel-cli-login-flow) | D6 |
| MCP 인가 스펙 2026-07-28 | OAuth 2.1·PKCE, 보호 리소스 메타데이터(RFC 9728), `resource`(RFC 8707)와 audience 검증, `iss`(RFC 9207) 검증. 등록 우선순위는 사전 등록 → CIMD → DCR(deprecated). stdio는 인가 스펙 대신 환경에서 자격을 읽는다 (https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) | D5·D6 |
| Claude Code | `claude mcp add --transport http`, 정적 헤더·`headersHelper`·`.mcp.json`의 `${VAR}`. 네이티브 OAuth는 CIMD 클라이언트와 `localhost` **임의 포트** 루프백. 장치 코드는 없다 (https://code.claude.com/docs/en/mcp) | D6·D10 |
| Codex | `codex mcp add`, `bearer_token_env_var`·`http_headers_helper`, 콜백 `127.0.0.1`(포트 고정 가능) (https://learn.chatgpt.com/docs/extend/mcp) | D10 |

읽는 법: (1) 대화형 MCP는 사람 권한으로, 자율 에이전트는 따로 — O1과 같은 방향이에요. (2) 관리자 끄개가 기본이에요 — O2와 같아요. (3) CLI 로그인은 「터미널이 코드를 보이고 이미 로그인된 곳에서 승인」으로 수렴해요 — O3의 후속 장치 코드가 이 모양이에요.

## 결정

### D1. 정체성 — 두 문, 두 자격 [owner 결정 O1]

- 개발자 도구(CLI·Claude Code·Codex·직접 쓰는 명령)는 **개발자 토큰**으로 붙어요. 행위자는 그 사람 멤버(`member.kind='human'`)이고, 효력은 사람 권한의 일부예요: 내 멤버십 ∩ 토큰 범위 ∩ 토큰의 채널 제한(D4).
- 동료·자동화(planner·CI·그록봇류)는 **에이전트 멤버 + Agent Port 또는 generic 에이전트 자격**을 그대로 써요. 이 ADR은 에이전트 쪽을 바꾸지 않아요(D12).
- 두 자격은 **서로 승격되지 않아요**. 개발자 토큰으로 Agent Port를 부를 수 없고, 에이전트 자격(`momo_agent_v1`·pairing·hosted OAuth)과 사람 세션 JWT로 사람 MCP를 부를 수 없어요. 두 문은 같은 모양의 `invalid_token` 응답을 내서 「이 문자열이 어떤 종류인가」를 알려 주지 않아요.
- `token_kind='delegation'`(에이전트가 사람을 대신)은 쓰지 않아요. 개발자 토큰은 사람 본인이 자기 의사로 만드는 **이름 붙은 자기 위임**이에요.
- ADR-0101과의 관계: ADR-0101이 없애려던 것은 「에이전트가 사람 오퍼레이터 계정으로 로그인해 행동이 섞이는 우회」예요. 개발자 토큰은 우회가 아니라 사람이 만들고, 범위가 닫혀 있고, 목록·폐기·감사가 있고, 보낸 메시지에 표식이 붙는 자격이에요(D8). 그래도 도구의 행동이 내 이름으로 나간다는 위험은 남아서 위협 T1에 적었어요. ADR-0173의 문장(F12)은 **개인 개발자 도구**에 한해 이 결정이 좁혀요. 동료·자동화는 ADR-0173 그대로예요. 하네스를 멤버로 만들지 않는 ADR-0198 D1과도 같은 방향이에요.
- **시험 의무: R1·R2**

### D2. 개발자 토큰의 종류·모양·수명 [owner 결정 O4, 접두·형태는 권장]

종류는 하나(`token_kind='dev'`)이고 **형태가 둘**이에요.

| | 카드 토큰 (`card`) | 로그인 세션 (`access` + `refresh`) |
|---|---|---|
| 만드는 곳 | 설정 › 연결 › 「명령줄·AI 도구」 카드(D6-가) | `oort login` 브라우저 승인(D6-나). 후속으로 제3자 MCP 클라이언트의 OAuth |
| 봉투 | `momo_dev_v1.<워크스페이스 id>.<비밀 43자>` | access `momo_dev_v1.…`, refresh `momo_devr_v1.<워크스페이스 id>.<비밀 43자>` |
| 보이는 때 | 만들 때 **한 번**(화면). 이후 어디서도 안 보여요 | 화면에는 안 보여요. 토큰 응답으로 CLI에만 가요 |
| 수명 | 기본 **30일**, 최대 **90일**(만들 때 고름) | access **15분**. refresh는 안 쓰면 **30일**에 끊기고(유휴), 승인 시각부터 **90일**이 절대 상한 |
| 갱신 | 없음(새로 만들고 옛것을 폐기) | CLI가 자동으로 회전해요. 옛 refresh를 다시 내면 계보 전체가 끝나요 |
| 목록의 한 줄 | 토큰 하나 | 계보 하나(「oort CLI · 기기 이름」) |
| 폐기 단위 | 토큰 | 계보(access·refresh 함께) |
| 마지막 사용 | 표시 | 표시(계보 단위) |

공통 규칙이에요.
- **봉투 전체의 해시**만 저장해요(SHA-256, 원문은 어디에도 저장하지 않아요). 같은 비밀 바이트를 다른 접두로 다시 라벨링하면 어떤 행과도 맞지 않아요. access를 refresh로(또는 반대로), 에이전트·pairing·hosted OAuth 봉투를 개발자 봉투로(또는 반대로) 바꿔 내는 방향이 모두 막혀요(ADR-0162 증보 1 A3와 같은 원리). 카드 토큰과 access는 접두가 같고 `dev_form`으로 가르는데, 둘 다 같은 개발자 문에만 닿고 서로를 만들어 내지 못해요. 조회는 해시 일치에 더해 `kind='dev'`와 `dev_form`을 함께 걸어요(개발자 문의 인증은 `card`·`access`만, 갱신 라우트는 `refresh`만). 해시와 형식 필터가 따로 막는 이중 방벽이에요.
- 접두는 기존 `momo_agent_v1`·`momo_pair_v1`·`momo_oauth_*_v1`과 같은 `momo_` 계열을 따라요. 제품 이름은 oort지만 와이어 형식의 접두를 바꾸면 파서가 깨지므로 따라가지 않아요. 식별 접두가 있어서 비밀 스캐너가 규칙 하나로 잡을 수 있어요: `momo_devr?_v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}`. 공개 스캐너 제휴 등록은 하지 않았고 주장하지도 않아요.
- 토큰은 `Authorization` 헤더로만 받아요. 쿼리·쿠키·본문의 토큰은 인증으로 읽지 않아요(ADR-0162 D4와 같아요).
- 만료·폐기·없음·다른 워크스페이스·형식 오류는 **바이트가 같은 401**이에요(상태를 알려 주는 oracle을 만들지 않아요).
- 발급 뒤에는 범위·채널 제한·만료를 바꿀 수 없어요. 바꾸려면 새로 만들고 옛것을 폐기해요.
- 한 멤버가 살아 있는 카드 토큰 20개, 로그인 계보 10개까지 가질 수 있어요(넘으면 409 `dev_credential_limit`).
- 사람 세션 계보는 refresh를 기기 키로 묶는 모드가 기본 `observe`라서, 비밀번호 로그인(웹·데스크탑) 계보는 훔친 refresh로도 계속 갱신돼요(ADR-0215 F15). **개발자 토큰의 refresh는 그 모드와 무관하게**, 회전돼 끝난 옛 refresh가 다시 오면 즉시 계보 전체(access·refresh)를 끝내고 감사 한 줄을 남겨요. hosted OAuth(ADR-0162 A3)와 같은 규칙이에요.
- DB가 90일 상한을 직접 막아요: `kind='dev'` 행은 `expires_at`이 반드시 있고 `created_at + 90일` 이하여야 한다는 CHECK를 둬요(API 버그로도 더 긴 토큰이 생기지 않아요). 로그인 계보의 절대 상한(승인 +90일)은 회전이 새 refresh의 만료를 계보 상한으로 잘라서 지켜요.
- 개발자 토큰은 **사람 멤버만** 가질 수 있어요. 에이전트 멤버에게는 발급되지 않아요.
- **시험 의무: R2·R5·R6·R10·R21**

### D3. 누가 쓸 수 있나 — 워크스페이스 스위치 [owner 결정 O2, 세부는 권장]

설정 「명령줄·AI 도구 접근」은 값이 셋이에요: `admins`(기본) · `members` · `off`.

| 값 | 만들고 쓸 수 있는 사람 |
|---|---|
| `admins` (기본, 키가 없어도 이 값) | owner·admin |
| `members` | owner·admin·member |
| `off` | 아무도 못 해요(킬 스위치) |

- guest는 어떤 값에서도 못 해요. 에이전트 멤버도 못 해요.
- 이 규칙은 **발급할 때뿐 아니라 사용할 때도 요청마다** 평가해요. 역할이 admin에서 member로 내려가면(스위치가 `admins`일 때) 이미 만든 토큰도 다음 요청부터 거절돼요. 별도 청소를 기다리지 않아요.
- 스위치를 바꾸는 사람은 owner·admin이고, `off`와 「좁히기」(`members` → `admins`)는 **같은 트랜잭션에서 영향받는 토큰을 폐기**해요. 다시 열어도 부활하지 않아요(폐기 행은 폐기 행이에요).
- 스위치는 **사람이 쓰는 전용 라우트로만** 바꿔요. 일반 설정 갱신 경로(사람의 설정 PATCH)와 팀 AI의 `workspace.settings.update` 행동(키 두 개로 닫혀 있고, 이 ADR은 그 목록을 늘리지 않아요)으로는 바꿀 수 없어요. 에이전트가 개발자 접근을 넓히면 안 되기 때문이에요.
- 출하 순서: 이슈 #4660은 **평가 규칙(기본 `admins`)을 고정값으로 먼저 출하**할 수 있어요. 스위치의 저장·변경 API·UI는 체크리스트(이슈 없음)로 따로 해요. 스위치가 없는 동안 member는 만들 수 없는 것이 안전한 기본이에요.
- **시험 의무: R8**

### D4. 닫힌 허용 라우트 목록·범위·채널 제한·본문 제한 [권장]

개발자 토큰이 닿는 REST는 `required_agent_scope`와 같은 방식의 닫힌 표 **`required_dev_scope`** 하나뿐이에요. 표에 없으면 거절(403 `dev_route_not_allowed`)이에요. 「기본은 안 됨」이에요.

| # | 메서드 | 라우트 템플릿 | 범위 | 명령 |
|---|---|---|---|---|
| L1 | GET | `/v1/workspaces/{ws}/dev-access/self` | `dev:identity` | `whoami` |
| L2 | DELETE | `/v1/workspaces/{ws}/dev-access/self` | `dev:identity` | `logout`(자기 자신만 폐기) |
| L3 | GET | `/v1/workspaces/{ws}/channels` | `dev:channels:read` | `channels` |
| L4 | GET | `/v1/workspaces/{ws}/channels/{ch}/messages` | `dev:messages:read` | `read` |
| L5 | GET | `/v1/workspaces/{ws}/channels/{ch}/messages/{root}/replies` | `dev:messages:read` | `read --thread` |
| L6 | POST | `/v1/workspaces/{ws}/channels/{ch}/messages` | `dev:messages:write` | `post` |
| L7 | GET | `/v1/workspaces/{ws}/inbox` | `dev:inbox:read` | `inbox` |
| L8 | POST | `/v1/mcp/me` | `dev:identity` + 도구별(D5) | `mcp` |

- **허용의 기준은 라우터가 확정한 라우트**예요. 요청의 원시 경로 문자열 모양이 아니에요(기존 `required_agent_scope`는 원시 경로의 세그먼트 모양으로 맞추는데(F18), 이 표는 그 방식을 따르지 않아요). 구현은 둘 중 하나를 골라요: (가) 허용 표식 계층을 L1~L8 라우트에만 붙이고 표식 없는 라우트는 개발자 봉투를 **알 수 없는 문자열**로 거절, (나) `route_layer` 안에서 `MatchedPath`(라우트 템플릿)를 키로 쓰되 템플릿이 없으면 거절. 어느 쪽이든 끝 슬래시·`//`·퍼센트 인코딩·대소문자 변형이 표를 우회하지 못하고, 표에 없는 메서드(HEAD 포함)는 거절이에요. `MatchedPath`가 이 계층에서 보이는지는 `runtime-unverified`라 #4660이 먼저 확인해요(안 보이면 (가)).
- 개발자 토큰의 주체는 사람 멤버로 보여요. 그래서 `require_human` 같은 기존 사람 가드는 개발자 토큰에 방벽이 아니고, **이 닫힌 표가 유일한 방벽**이에요.
- `{ws}`는 토큰의 워크스페이스와 같아야 해요. 다르면 거절이에요.
- 개발자 토큰이 **닿지 않는 것**: 토큰 발급·목록·폐기 라우트(개발자 토큰이 개발자 토큰을 만들 수 없어요), 비밀번호·세션·기기 키, 승인 카드의 결정, 작업 spawn·허락(기기 키 서명 경계 ADR-0146·ADR-0188), 구조 변경(채널 만들기·초대·역할), 메시지 편집·삭제·고정·반응·첨부, 검색, 실시간 구독, inbox의 읽음 처리(`oort inbox`는 읽어도 읽음으로 바꾸지 않아요), 에이전트 지시문 수정.
- **범위 어휘**는 `dev:` 이름공간이에요: `dev:identity`(항상 포함)·`dev:channels:read`·`dev:messages:read`·`dev:messages:write`·`dev:inbox:read`. `dev:search`는 이름만 예약하고 v1에서 발급하지 않아요(검색은 한 번에 여러 채널을 훑어서 채널 제한 증명이 따로 필요해요. 에이전트의 검색을 닫아 둔 ADR-0173 D2와 같은 이유예요). 기존 `messages:*` 같은 이름을 쓰지 않는 이유: 기존 범위 검사(`realtime.rs`·`credits.rs` 등)가 개발자 토큰을 우연히 통과시키지 않게 하려는 거예요.
- **프리셋**은 UI 이름이고 서버는 범위 집합과 채널 목록 두 값만 알아요.

| UI 프리셋 | 범위 집합 |
|---|---|
| 읽기만 (**기본 선택**) | `dev:identity` `dev:channels:read` `dev:messages:read` `dev:inbox:read` |
| 읽기 + 보내기 | 위 + `dev:messages:write` |
| 고른 채널만 | 위 둘 중 하나(사람이 고름) + 채널 제한 |

- **채널 제한**: 채널 id 1~50개. 만드는 사람이 멤버가 아닌 채널은 400이에요. 요청마다 **현재 멤버십과의 교집합**을 다시 계산해요(토큰에 적힌 목록을 믿지 않아요, ADR-0162 D4와 같아요). 제한 밖 채널의 읽기·쓰기·스레드는 **없는 채널과 바이트가 같은 404**이고, 채널 목록과 inbox는 제한 안의 항목만 돌려줘요(존재 여부를 알려 주지 않아요).
- **inbox(L7)는 응답 필드를 모두 정해요**(F17): 개발자 토큰에는 `approvalsPending`이 **항상 빈 목록**이에요(승인 카드는 개발자 문에 닿지 않아요). `items`와 `unreadCount`는 채널 제한이 있으면 **제한 안 채널의 것만** 세요. 항목 안의 인용·미리보기는 같은 채널의 것이라 제한을 따라가요. 제한은 핸들러 후처리가 아니라 **도메인 함수의 인자**(`list_inbox_in_tx`·`inbox_unread_count_in_tx`)로 걸어요(후처리하면 `limit`·커서·`unreadCount`가 어긋나요).
- **본문 제한**(L6): 개발자 토큰으로 보내는 메시지는 `clientMsgId`·`rootId`·`replyToId`·`body`만 받아요(`type`은 없거나 `text`). `props`·`runId`·`attachmentIds`·`routing`·`signature`·`stream`·`harnessRefine`·`apps`가 오면 400 `dev_field_not_allowed`이고 아무것도 저장하지 않아요(F6의 이유: 클라이언트가 쓰는 `props`로 서버가 보증하는 표식을 흉내 낼 수 있으면 안 되고, 서명·스트림·하네스 필드는 에이전트·기기 키 경계의 것이에요). DTO에 필드가 더해져도 이 목록에 없으면 개발자 토큰에는 닫혀 있어요(허용목록 방식).
- 쓰기 행(L6)은 D8의 표식·본문 제한과 **같은 PR에서만** 열어요. 읽기 행들이 먼저 출하될 수 있어요.
- **시험 의무: R3·R4·R11·R12**

### D5. 사람 MCP — 별도 resource·audience [권장]

- 사람 MCP의 canonical resource는 **`/v1/mcp/me`**예요(Agent Port의 `/v1/mcp/agent-port`와 따로예요). 「나로서 쓰는 MCP」라는 뜻이에요.
- 개발자 토큰의 audience는 **하나**예요: 이 서버의 개발자 문(canonical resource = 운영자 설정의 공개 origin + `/v1/mcp/me`). 닫힌 REST 표(L1~L7)는 같은 audience의 다른 표면이에요. 토큰의 종류(class)가 audience를 이미 강제하므로 별도 `aud` 클레임은 필요 없어요. Agent Port에는 개발자 토큰이 들어가지 않고, 사람 MCP에는 에이전트 자격·pairing·hosted OAuth access·사람 세션 JWT가 들어가지 않아요(D1). hosted 전용 상태기계(inbox 커서·lease)와 사람의 읽기 도구를 섞지 않으려는 거예요.
- 전송은 Agent Port와 같은 규율이에요: 상태 없는 JSON-RPC over HTTP **POST만**이에요(GET/SSE/DELETE는 지원하지 않고 닫힌 표에도 없어요). `momo-mcp` 프로토콜 코어는 재사용하되 **도구 카탈로그와 인증은 따로** 둬요. 도구는 사람 REST의 같은 도메인 함수 위의 얇은 껍질이라서, 채널 제한·본문 제한·표식·속도 제한이 REST와 똑같이 걸려요(도구마다 REST 결과와 같은지 시험해요).
- 1차 도구: 명령과 1:1로 `whoami`·`channels`·`read`(스레드 인자 포함)·`post`·`inbox`. 정확한 도구 이름은 #4661이 봉인하되 Agent Port 카탈로그(`oort_inbox_read`·`oort_conversation_read`·`oort_message_post` …)와 **겹치지 않아야** 해요. 두 서버를 함께 등록한 클라이언트에서 모델이 「에이전트로 보내기」와 「나로 보내기」를 헷갈리지 않게요.
- **도구 주석**: `tools/list`에 읽기/쓰기 주석(`readOnlyHint` 등)을 싣고, 주석과 필요 범위는 **같은 표에서 파생**해요(어긋날 수 없어요). 클라이언트의 도구 승인 UX가 읽기는 통과, 쓰기는 확인으로 갈릴 수 있어요(클라이언트 동작은 `runtime-unverified`예요).
- `tools/list`는 토큰 범위 ∩ 정책의 도구만 광고하고, 범위 없는 도구는 목록과 호출 모두 fail-closed예요(ADR-0162 D3와 같아요).
- 보호 리소스 메타데이터(RFC 9728)는 OAuth 서버가 켜진 뒤에만 광고해요. 켜지지 않은 기능을 가짜로 광고하지 않아요(ADR-0162 A4). issuer와 resource는 운영자 설정에서만 오고 `Host`·`Forwarded`는 읽지 않아요.
- `search` 도구는 v1에서 열지 않아요(D4의 `dev:search` 예약).
- **시험 의무: R1·R14**

### D6. 발급과 로그인 [owner 결정 O3, 세부는 권장]

**(가) 카드 토큰** — 설정 › 연결 › 「명령줄·AI 도구」 카드(#4663). 비밀을 한 번 복사하는 길이에요.
1. 이름(80자 이하, 제어 문자 불가)·쓰는 도구(Claude Code / Codex / 직접 명령 — 만든 사람이 고른 값일 뿐 검증된 사실이 아니에요)·프리셋·(선택) 채널·만료(1~90일, 기본 30일)를 받아요.
2. **현재 비밀번호를 본문으로 다시 확인해요**(F16의 현행 패턴, 비밀번호 변경과 같은 검증기). 틀린 시도는 멤버당 분당 5회(권장값)를 넘으면 429예요(탈취된 세션이 이 라우트로 비밀번호를 대입해 보지 못하게요). 탈취된 앱 세션이 90일짜리 뒷문을 찍어 내는 것을 막으려는 거예요(ADR-0195 D-8의 「세션 bearer만으로 추가하면 탈취 세션이 영구 뒷문을 만든다」와 같은 이유). 개발자 토큰으로는 이 라우트를 못 불러요(D4).
3. 응답은 `Cache-Control: no-store`이고 비밀은 **그 응답에만** 있어요. 다시 보여 주는 라우트가 없어요.
4. 목록은 이름·도구·범위·채널 제한 여부·만든 기기(알 수 있으면)·마지막 사용·만료를 보여 주고 비밀·해시는 없어요. 관리자는 전체를 보고 사다리에 따라 폐기해요(D7).

**(나) 브라우저 승인** — `oort login`. 비밀 복사가 없는 권장 기본이에요. 서버의 OAuth 서버를 사람 주체로 확장하는 일(체크리스트 E3)과 flag 개방(운영 결정, runtime proof 뒤)이 먼저 필요해요.
- CLI는 oort OAuth 서버의 **내장 1차 공개 클라이언트** `oort-cli`예요(비밀 없음, PKCE S256만, DCR·CIMD 없음). 리디렉트는 **고정된 루프백 후보 몇 개**(`http://127.0.0.1:<고정 포트>/callback`, 포트 목록은 E3가 봉인)와 문자열 정확 일치만 받아요. 지금 허용목록 규칙(F7)에서 그대로 성립하고, 임의 포트(RFC 8252 §7.3)는 ADR-0162 증보가 필요해서 이 ADR은 쓰지 않아요.
- 흐름: CLI가 `state`(128비트 이상)와 PKCE verifier를 만들고, 후보 포트 중 비어 있는 곳에 `127.0.0.1`로만 바인드한 수신기를 열고, 브라우저를 열어요(`--no-browser`면 URL만 출력해요. 같은 기기의 브라우저용이고 SSH용이 아니에요). 사람이 로그인된 oort 웹에서 **동의 화면**을 보고 [허용]을 누르면 서버가 60초·1회용 코드를 `code`·`state`·`iss`로 루프백에 돌려줘요. CLI는 `state`와 `iss`(OAuth 서버 메타데이터의 issuer)를 검사한 뒤 코드와 verifier로 토큰을 교환해요.
- 수신기는 정해진 경로에서 **정확히 한 번의 콜백**만 받고 닫혀요. 응답 페이지는 코드·토큰을 되풀이하지 않고 `Cache-Control: no-store`·`Referrer-Policy: no-referrer`예요.
- **동의 화면이 보여 줄 것**(문구는 후속 UX): 클라이언트 이름(내장값 `oort CLI`), 서버 호스트, 워크스페이스, 승인하는 나, 요청 범위를 풀어쓴 말, 만료(최대 90일·안 쓰면 30일), 연결하는 쪽이 정한 기기 이름(「이름은 연결하는 쪽이 정한 값이에요」, ADR-0180 C9와 같아요. 기본 이름은 `oort CLI · macOS`처럼 일반 값이고 호스트 이름을 보내지 않아요). 화면은 `frame-ancestors 'none'`이에요. **발급 범위 ⊆ 요청 범위 ∩ 사람이 고른 범위**이고 기본 선택은 「읽기만」이에요. 스위치(D3)가 허용하지 않는 사람에게는 코드를 만들지 않아요(동의와 교환 두 시점 모두 정책을 평가해요).
- **[허용] 직전에 현재 비밀번호를 다시 확인해요**(D6-가와 같은 검증기와 같은 시도 한도. 패스키가 구현되면 ADR-0195 D-8의 패스키 재인증으로도 돼요). 훔친 웹 세션·refresh로 이 동의 API를 불러 고정 루프백 후보 포트로 코드를 받는 길을 막으려는 거예요. 카드 경로만 막고 더 편한 기본 경로를 열어 두면 공격자는 그쪽을 골라요(T7). 이 확인 없이는 동의 API가 코드를 만들지 않아요.
- 워크스페이스는 승인하는 세션의 워크스페이스로 정해져요.

**(다) 단계**

| 단계 | 되는 것 | 조건 |
|---|---|---|
| 0 | 카드 토큰 발급·목록·폐기, CLI·사람 MCP가 카드 토큰으로 동작(`OORT_TOKEN` 또는 `oort login --with-token`) | #4660 · #4663 · #4662 1단계 · #4661 |
| 1 | `oort login` 브라우저 승인과 로그인 세션 | E3(체크리스트) + OAuth flag 운영 결정 + runtime proof |
| 2 | SSH용 장치 코드(RFC 8628) | 별도 결정(체크리스트) |
| 3 | 제3자 MCP 클라이언트의 네이티브 OAuth(Claude Code `localhost` 임의 포트 등) | ADR-0162 증보(체크리스트). CIMD·DCR을 열지는 이 ADR이 정하지 않아요 |

- 1단계 전에 `oort login`이 브라우저 승인을 못 하는 서버를 만나면(메타데이터 404 등) 조용히 다른 방식으로 바꾸지 않고 「이 서버는 브라우저 로그인을 아직 열지 않았어요. 설정 › 연결 › 명령줄·AI 도구에서 토큰을 만들어 `oort login --with-token`으로 넣어 주세요」라고 말해요.
- **장치 코드(후속)가 만족해야 할 것**(구현은 그 이슈의 몫, 여기서는 요구만 적어요): 공개 엔드포인트와 **테넌트 밖 대기 표**(ADR-0195 D-6 선례), 폴링 간격·시도 예산, 8자 코드는 ADR-0180 C2(문자 집합)·C3(키 있는 MAC)·C6(실패 예산)**만** 빌려요. ADR-0180의 「앱이 코드를 보이고 CLI에 입력」은 방향이 반대여서 재사용하지 않아요. 승인 화면은 기기 이름과 서버 호스트를 대조시켜요(RFC 8628 §5.4의 중계 피싱).
- **시험 의무: R6·R7·R20**

### D7. 폐기와 연쇄 [권장]

- **개별 폐기**: 소유자 본인. 관리자는 사다리(ADR-0128 D2·ADR-0215 F5와 같아요): admin은 member·guest의 것, owner는 자기 외 누구나. 폐기는 멱등이고 즉시예요(요청마다 DB로 판정해서 캐시가 없어요).
- **자기 폐기**: 개발자 토큰은 L2로 **자기 자신만** 폐기할 수 있어요(`oort logout`). 다른 토큰을 폐기하지 못해요.
- **연쇄**: 비밀번호 변경·재설정, 정지, 제거, 워크스페이스 떠남, 스위치 `off`·좁히기가 그 멤버(또는 영향받는 멤버)의 **모든 개발자 토큰(카드 토큰과 로그인 계보)을 같은 트랜잭션에서** 끝내요. 「관리자가 멤버의 세션을 끝내는」 경로는 지금 코드에 없어요(F9). 새로 만든다면 새 공개 API라 이 ADR의 범위 밖이고, 만들 때 이 연쇄에 넣어요.
  - **중요한 함정 [V]**: 비밀번호 변경·재설정 경로의 멤버 전체 폐기(`revoke_member_session_tokens`)와 그 행 잠금(`LOCK_MEMBER_LIVE_SESSION_ROWS_SQL`)은 `kind = 'session'`만 잡아요(F5). 새 `kind='dev'`를 더하고 이 술어를 그대로 두면 **비밀번호를 바꿔도 개발자 토큰이 살아남아요**. 구현은 이 술어를 `dev`까지 넓히거나 같은 호출 지점에서 같은 잠금 순서(#3109 규칙: 멤버 전체 sweep 잠금을 먼저)로 병행 sweep을 불러야 해요. 정지·제거·탈퇴 경로(`revoke_member_tokens_in_tx`)는 kind를 가리지 않아서 이미 `dev`를 끝내지만 그 경로는 #3109 잠금을 잡지 않아요(현행 그대로이고 이 ADR이 바꾸지 않아요).
- 앱의 **로그아웃은 개발자 토큰을 끝내지 않아요**. 개발자 토큰은 앱 세션과 독립된 자격이고(GitHub PAT와 같아요), 카드 목록에서 눈에 보이게 따로 폐기해요. 비밀번호를 바꾸면 모든 연결이 끊긴다는 안내를 카드가 보여요.
- 로그인 계보의 refresh 재사용 감지는 계보 전체(access·refresh)를 끝내고 감사 한 줄을 남겨요(D2).
- 만료는 읽는 시점의 `expires_at > now()` 판정이에요. 청소 작업은 선택이에요.
- **시험 의무: R8·R9·R10·R21**

### D8. 메시지 쓰기 — 즉시 전송, 「명령줄에서」 표식, 읽기만 기본 [owner 결정 O5]

- `dev:messages:write`를 가진 토큰의 `post`는 **승인 카드 없이 즉시 전송**돼요(owner 결정). 승인 카드는 구조 변경용이고, 개발자 토큰은 구조 변경을 하지 않아요(D4). 그래서 ADR-0186의 승인 카드를 우회하는 길이 아니에요.
- **표식**: 개발자 토큰이 만든 메시지에는 서버가 `message.sent_via = 'dev'`를 써요. 값은 **요청이 아니라 인증된 자격의 종류에서만** 파생돼요(본문·`props`로는 쓸 수도 지울 수도 없어요). 작성자가 나중에 편집해도 유지돼요. 응답·실시간 DTO에는 `sentVia`로 나가고, 화면 문구는 owner 결정대로 **「명령줄에서」**예요. 카드 토큰의 도구 이름(「Claude Code」 등)은 만든 사람이 고른 미검증 값이라 표식에 사실처럼 싣지 않아요. 표시 UI(웹·데스크탑·폰)는 체크리스트(이슈 없음)예요.
- **「읽기만」 프리셋이 기본 선택**이에요. 쓰기는 사람이 한 번 더 골라요. 도구가 읽은 내용에 심긴 지시(프롬프트 주입)가 쓰기로 이어지는 일을 기본 설정에서 막으려는 거예요.
- 쓰기 예산: 토큰당 분당 30건(권장값, D9). 편집·삭제·고정·반응·첨부는 v1에 없어요(되돌릴 수 없는 즉시 전송이라는 위험은 위협 T1에 적었어요).
- 에이전트를 멘션하는 메시지가 에이전트를 깨우는 길은 사람이 보낼 때와 **같은 경로**예요(「요청」은 에이전트 멘션 메시지로 충분해요). 별도의 비용 한도는 이 쓰기 예산뿐이에요(알려진 한계).
- **시험 의무: R12·R13**

### D9. 감사·관측·속도 제한 [권장]

- **보안 감사(상한 없음)**: 개발자 토큰이 수락된 요청마다 인증 tx 안에서 `auth.dev_token.used` 한 줄과 `last_used_at` 조건부 갱신(분당 한 번 이하)을 **원자적으로** 남겨요(F14와 같은 모양). 범위·정책 부족 거절은 `auth.dev_token.scope_denied`로, 안정 id 버킷당 창마다 한 줄 상한을 둬요.
- **수명주기 감사**: 발급·폐기·refresh 재사용 감지·정책 변경·동의 승인/거절. `detail`은 닫힌 어휘이고 **비밀·본문·채널 id·쿼리가 들어가지 않아요**.
- 감사 기록이 실패해도 응답은 바뀌지 않아요(ADR-0200 증보 4 A5와 같아요). 단, 인증 tx 안의 `used` 행은 인증의 일부라서 이 규칙의 대상이 아니에요.
- 자격별 「최근 호출」 진단 기록(`agent_port.call` 모양의 닫힌 어휘, 시간당 상한)은 후속(체크리스트)이에요. 진단용이지 보안 감사 통제가 아니에요(ADR-0200 증보 4).
- **속도 제한**[권장값, 구현이 봉인]: 토큰당 분당 240, 멤버당 분당 480(Agent Port와 같은 두 숫자), 쓰기는 토큰당 분당 30, 비밀번호 재확인 실패는 멤버당 분당 5(D6). 넘으면 429와 `Retry-After`이고, 키는 안정 id(IP가 아니에요). 설정값 0·파싱 불가는 「끄기」가 아니라 **기본값으로 되돌려요**(ADR-0180 C6). 카운터는 프로세스 메모리라 서버가 여러 대면 한도가 대수만큼 늘어요(단일 인스턴스 셀프호스트가 기준이에요).
- **시험 의무: R6·R13·R15**

### D10. `oort` CLI [권장, 1차 명령은 요청 그대로]

**이름 공존.** 사용자용 바이너리는 `oort`, crate는 `oort-cli`예요. 운영 스크립트 `scripts/oort`는 이름을 바꾸지 않아요(여러 문서와 게이트가 그 경로를 가리켜요). 두 도구는 PATH에서 만나지 않아요: 스크립트는 늘 `scripts/oort …`로 부르고 PATH 설치 안내가 없어요(F13). 혼동을 막는 규칙 셋이에요.
1. 사용자 CLI는 운영 스크립트의 명령 이름(`doctor`·`status`·`logs`·`upgrade`·`backup`·`restore`·`member`)을 **쓰지 않아요**(예약). 운영 기능을 CLI로 옮기는 날이 오면 `oort ops …` 아래로 가요.
2. `scripts/oort help`의 첫 줄에 「서버 운영 도구예요. 터미널에서 oort를 쓰는 CLI는 `oort`예요」를 더해요(이행 체크리스트).
3. `oort --version`은 `oort-cli`를 밝혀요.

**1차 명령.**

| 명령 | 하는 일 | 부르는 곳 |
|---|---|---|
| `oort login [--server URL] [--name 이름] [--no-browser] [--with-token]` | 브라우저 승인(1단계부터). `--with-token`은 **표준입력**에서 카드 토큰 한 줄을 읽어 저장해요(토큰을 인자로 받는 플래그는 없어요) | OAuth(E3) / 저장 |
| `oort logout` | 서버에서 자기 토큰(계보)을 폐기하고 로컬 자격을 지워요. 서버에 닿지 않으면 로컬만 지우고 「서버에서 폐기하지 못했어요. 설정에서 지워 주세요」라고 말해요 | L2 |
| `oort whoami` | 서버·워크스페이스·나·토큰 종류·범위·채널 제한 여부·만료·마지막 사용·저장 위치 | L1 |
| `oort channels` | 내가 볼 수 있는(그리고 토큰이 닿는) 채널·DM | L3 |
| `oort read <채널> [--thread <루트 id>] [--since <seq>] [--before <seq>] [--limit N]` | 히스토리 또는 스레드. 채널은 `#이름` 또는 id. 출력은 항상 오래된 것부터예요 | L4·L5 |
| `oort post <채널> [--thread <루트 id>] [--reply-to <id>] [--client-msg-id <uuid>] (텍스트\|-)` | 메시지 전송. `-`는 표준입력. 같은 `client-msg-id`로 다시 보내면 한 번만 반영돼요(멱등) | L6 |
| `oort inbox [--limit N]` | 내 inbox 읽기(읽음 처리는 하지 않아요) | L7 |
| `oort token [--headers]` | 지금 쓸 토큰(필요하면 갱신해서)을 표준출력으로. `--headers`는 헤더 도우미용 JSON. 표준출력이 터미널이면 표준에러로 경고해요 | 로컬 |
| `oort mcp` | stdio MCP 서버. 저장된 자격으로 사람 MCP에 연결해서 클라이언트에는 비밀 없이 붙어요 | L8 |

- 모든 명령은 `--json`을 받아요. **안정 출력** 계약: 표준출력에 JSON 문서 하나, 필드에 `schema`(예: `oort.cli.whoami.v1`), 알 수 없는 필드는 추가만 허용(깨는 변경은 새 `schema` 버전)이에요. 오류는 표준에러에 `{"schema":"oort.cli.error.v1","code":…,"status":…}`예요. 종료 코드: 0 성공 · 1 일반 실패 · 2 사용법 · 3 로그인 필요(401) · 4 허용 안 됨(403: 범위·정책·닫힌 목록) · 5 없음(404, 채널 제한 포함) · 6 한도 초과(429, `retryAfterSeconds`) · 7 서버·네트워크. 색은 터미널일 때만, `NO_COLOR`를 따라요.
- **자격 보관.** 키체인이 있으면 키체인(macOS Keychain)을 써요. 없는 환경(헤드리스 Linux·CI)에서만 `$XDG_CONFIG_HOME/oort/`의 **0600 파일**(디렉터리 0700, 처음부터 그 권한으로 만들어요. 만든 뒤 바꾸지 않아요)로 내려가고, 내려갈 때 표준에러로 알리고 `whoami --json`의 `storage`가 `file`을 말해요. **조용한 강등은 없어요**: 키체인이 있는데 쓰기가 실패하면(잠김·거부) 파일로 몰래 쓰지 않고 오류를 내며, 사람이 `--storage file`로 명시할 때만 파일을 써요. 파일 권한이 넓으면 읽기를 거절해요. 프로필의 키는 (서버 origin, 워크스페이스 id)예요. 환경 변수 `OORT_TOKEN`이 있으면 그것이 저장된 자격보다 우선하고(`whoami`가 `source: env`로 밝혀요) 저장·갱신을 하지 않아요.
- **갱신 직렬화.** 로그인 세션의 access가 만료됐을 때 갱신은 **파일 잠금**으로 직렬화하고, 잠금을 얻은 뒤 저장소를 다시 읽어서 다른 프로세스가 이미 회전했으면 그 결과를 써요(이중 확인). 서버의 refresh 재사용 감지(D2)가 동시 갱신을 침해로 읽어 계보를 끝내는 것을 막으려는 거예요. 응답이 유실된 재시도도 재사용으로 읽혀 계보가 끝날 수 있어요(알려진 한계, 다시 `oort login`하면 돼요).
- **전송 규칙.** 서버는 `https`만(`http`는 루프백 주소에서만 허용). 비밀은 `Authorization` 헤더로만 보내요. 다른 호스트로 리디렉트되면 자격을 보내지 않아요. TLS 검증을 끄는 플래그가 없어요. 서버 외에 어디도 호출하지 않아요(원격 계측·자체 업데이트 확인 없음).
- **비밀을 argv에 두지 않기.** AI 도구에 붙일 때의 순위는 ① `oort mcp`(stdio, 설정 파일에 비밀이 없어요) ② `oort token`을 헤더 도우미로(Claude Code `headersHelper`, Codex `http_headers_helper`) ③ 환경 변수 참조(`${OORT_TOKEN}`을 작은따옴표로 감싸 확장 시점을 늦추거나 Codex `bearer_token_env_var`)예요. **비밀 값이 든 한 줄 명령은 만들지 않아요**(ADR-0190 D3-h가 실측한 argv·쉘 기록 노출). 환경 변수는 AI 도구가 띄우는 하위 프로세스에 상속된다는 한계가 있어서 ③은 마지막 수단이에요. ①②는 `runtime-unverified`이고 #4662의 완료 조건에서 실제 클라이언트로 확인해요(확인 전에는 광고하지 않아요, ADR-0190 D3-h의 AIH-5와 같아요).
- 신규 의존(`clap`·`keyring` 등 후보)은 허용 라이선스를 확인하고 NOTICE/귀속을 반영해요(AGENTS.md).
- **시험 의무: R16·R17·R18·R19**

### D11. 배포 [권장, 게이트는 AGENTS.md·M7 문서 그대로]

- `oort` 바이너리는 `server-rust` 워크스페이스의 새 bin crate로 빌드해요. CI가 산출물을 만드는 것은 배포가 아니에요.
- **첫 배포 경로는 데스크탑 번들 동봉**이에요(M7-I 등급): Tauri 앱 리소스에 넣고, 앱 메뉴 「명령줄 도구 설치」가 사용자 소유 디렉터리(`~/.local/bin`)에 심볼릭 링크를 만들어요(권한 상승 없이, 덮어쓰기 전에 확인). 앱의 서명·공증이 번들 안 바이너리를 덮는지는 확인하지 못했어요(`runtime-unverified`).
- **공개 Homebrew tap은 M7-S 뒤**예요[추정: 공개 다운로드와 같은 등급으로 봐요]. 별도로 내려받는 맨 바이너리는 공증이 필요해서 번들 동봉이 먼저예요.
- 소스 빌드(`cargo build -p oort-cli`)는 레포가 공개라 이미 가능하지만 지원 경로로 광고하지 않아요.
- **게이트**: 팀원에게 CLI를 주는 모든 경로(앱 번들 포함)는 M7-I PASS 기록과 **배포 건마다의 owner 승인**이 있어야 해요. 공개 tap·공개 공증 다운로드는 M7-S PASS와 건마다 승인이 있어야 해요(`docs/cicd/03-store-readiness-gate.md`). 이 ADR이나 구현 이슈의 권한이 배포 권한으로 확대되지 않아요.
- 플랫폼: macOS(arm64·x86_64) 우선, Linux는 같은 코드로 CI·헤드리스용(키체인 없음 → 파일 보관) 2순위, Windows는 v1 밖이에요.
- 배포에는 시험이 아니라 **게이트 기록**이 증거예요(R 없음).

### D12. 에이전트 쪽 경계 — 바꾸지 않아요

- Agent Port와 generic 에이전트 자격은 그대로예요. `oort_action_propose`는 lease `handle`이 필수이고(F2), job 없는 제안의 규칙은 **ADR-0186 증보(#4659)** 가 정해요. 이 ADR은 그 규칙을 만들지도 가정하지도 않아요. 개발자 토큰에는 `propose`가 없어요(구조 변경 도구가 없어요, D4).
- 에이전트가 oort에 붙는 법(연결 요청 → owner 승인 → 자격 수령, 지금은 ADR-0162 D4·D6의 pairing handshake)은 바꾸지 않아요. #4617 원문의 「에이전트: 연결 요청 → 승인 카드 한 번 → 자격 수령」은 **이 ADR 밖**이에요. 외부 에이전트의 연결 요청 흐름은 ADR-0212 예약(#4239)이 다루는 영역이라 번호만 예약된 지금 내용을 가져오지 않아요.
- 개인 앱 토큰 금고(ADR-0211 예약, #4238)와는 무관해요. 개발자 토큰은 oort 자신의 자격이고 외부 서비스의 사람 토큰을 보관하지 않아요.
- planner 운영 래퍼(#4616, `scripts/oort_agent.py`)는 에이전트 신원으로 Agent Port를 불러요. 동사와 `--json` 모양만 CLI 1차 명령과 맞춰요(나중에 호출 쪽 코드가 안 바뀌고 갈아 끼우도록).

| 래퍼 동사 | CLI 1차 명령 | Agent Port 도구 |
|---|---|---|
| `whoami`(지금 `ping`) | `whoami` | `oort_ping` |
| `channels` | `channels` | 없음 — 에이전트 쪽 채널 목록은 **빈칸** |
| `read` | `read` | `oort_conversation_read` |
| `post` | `post` | `oort_message_post` |
| `inbox` | `inbox` | `oort_inbox_read` |
| `propose` | (1차 아님) | `oort_action_propose` — #4659 |

  CLI에 에이전트 프로필을 더하는 일은 별도 결정이에요(이 ADR은 두 신원을 합치지 않아요).

## 위협과 완화

| # | 위협 | 완화 | 남는 것 | 시험 의무 |
|---|---|---|---|---|
| T1 | 읽은 내용에 심긴 지시(프롬프트 주입)로 도구가 오용된다 | 「읽기만」 기본(D8), 구조 변경·편집·삭제 없음(D4), 채널 제한(D4), 도구 주석(D5), 속도·쓰기 예산(D9), 표식(D8) | 허용 범위 안에서 정보를 옮길 수 있다. 즉시 전송은 되돌릴 수 없다. 멘션은 에이전트를 깨운다 | R3·R11·R12·R13·R14 |
| T2 | 비밀이 쉘 기록·`.mcp.json` 커밋·환경 변수 상속으로 샌다 | 비밀 값 든 명령을 만들지 않음, stdio·헬퍼·환경 변수 순위(D10), 식별 접두(D2), 한 번만 표시·≤90일·즉시 폐기(D2·D7), argv에 토큰 플래그 없음(D10) | 사용자가 직접 붙여넣는 것은 막을 수 없다 | R6·R16 |
| T3 | 루프백 포트 가로채기·인가 코드 가로채기 | PKCE S256, 정확 일치 리디렉트, `state`·`iss` 검사, `127.0.0.1`만 바인드, 코드 60초·1회(D6) | 같은 기기의 악성 프로그램은 범위 밖 | R20 |
| T4 | 장치 코드 중계 피싱(후속) | 승인 화면의 기기 이름·서버 호스트 대조, 시도 예산, ADR-0180 C2·C3·C6(D6 후속 요구) | 구현 전. 후속 이슈의 수용 기준으로 이월 | (후속 이슈가 가져온다) |
| T5 | refresh 경쟁이 계보를 끊거나, 훔친 refresh가 쓰인다 | 파일 잠금 직렬화(D10), 서버의 재사용 즉시 계보 폐기(D2) | 응답 유실 재시도 오탐 → 다시 로그인 | R10·R17 |
| T6 | 키체인이 없거나 쓰기가 실패한다 | 조용한 강등 금지·고지·명시 옵션(D10) | — | R16 |
| T7 | 탈취된 앱 세션이 개발자 토큰을 찍어 내 영구 뒷문을 만든다 | 현재 비밀번호 재확인(카드 발급과 브라우저 승인 직전 둘 다, D6), 개발자 토큰이 개발자 토큰을 못 만듦(D4), 목록·감사(D9), 비밀번호 변경 시 전부 폐기(D7), 최대 90일(D2) | 새 토큰을 다른 세션에 알리는 앱 안 알림은 후속 | R3·R7·R9·R20 |
| T8 | 혼동된 대리인: 개발자 토큰이 Agent Port에서, 에이전트 자격이 개발자 문에서 쓰인다 | 종류별 별도 봉투·해시 전체·별도 resource(D1·D2·D5) | — | R1·R2 |
| T9 | 새 라우트가 추가되며 닫힌 목록이 슬며시 열리거나 경로 모양으로 우회된다 | 기본 거절, 라우터가 확정한 라우트 기준, OpenAPI와 문서 밖 허용 목록의 합집합을 순회하는 드리프트 시험(D4) | — | R3 |
| T10 | 스위치를 껐는데 토큰이 남거나 역할이 내려갔는데 계속 쓰인다 | 사용 시점 평가, `off`·좁히기 때 같은 tx 폐기(D3) | — | R8 |
| T11 | 채널 제한 우회 또는 존재 여부 oracle | 요청마다 멤버십 교집합, 제한 밖은 없는 채널과 같은 404, inbox 응답 필드 열거(D4) | — | R11 |
| T12 | 「명령줄에서」 표식의 위조·삭제 | 서버가 자격 종류에서만 파생, `props`·서명 필드 차단(D4·D8) | — | R12 |
| T13 | 비밀·내용이 감사·로그·진단에 샌다 | 닫힌 어휘, 원문 비저장, 헤더 외 위치 거절(D2·D9) | — | R6·R15 |
| T14 | 비밀번호를 바꿨는데 개발자 토큰이 살아남는다 | 멤버 전체 폐기를 `dev`까지 넓힘, 같은 tx(D7) | 기존 술어가 `kind='session'`뿐이라 **가장 흔한 누락 후보** | R9 |
| T15 | 바이너리 공급망·잘못된 서버로 자격 전송 | M7 게이트·서명(D11), 프로필 키=(origin, 워크스페이스), https만·리디렉트 시 자격 미전송(D10) | 배포는 절차 증거 | R18 |

## 기각한 대안

| 대안 | 기각 이유 |
|---|---|
| 개발자 도구도 에이전트 멤버 + Agent Port | 에이전트는 관리자만 만들 수 있고, 읽으려면 채널 멤버십과 채널 승인이 둘 다 필요하며 채널 목록 도구가 없다. 하네스를 멤버로 되돌리면 ADR-0198 D1과 충돌한다. 동료·자동화용으로는 유지(D1) |
| 사람 세션 JWT를 그대로 쓴다 | 범위·목록·폐기가 없고 15분이며 ADR-0101이 없애려던 모양이다(F4) |
| 위임 토큰(`delegation`) | 코드 사용 0, ADR-0101 Phase 2 미착수, 크기 L. 후속으로 남긴다 |
| Agent Port가 사람 토큰도 받는다 | audience 혼동, hosted 전용 상태기계(inbox 커서·lease)와 섞인다 |
| 장치 코드를 먼저 | 공개 엔드포인트 둘과 테넌트 밖 대기 표가 필요하고 제3자 MCP 클라이언트는 장치 코드를 못 쓴다. owner 결정 O3 |
| ADR-0180 증보 방식(앱이 코드를 보이고 CLI에 입력)을 그대로 | 서버 주소를 사람이 쳐야 하고 방향이 반대다. 문자 집합·MAC·시도 예산만 후속에서 빌린다 |
| CLI 전용 교환 경로(ADR-0195 D-7식 전용 교환권)를 따로 | OAuth 서버를 하나로 두는 원칙(ADR-0162 A4)과 두 번째 메커니즘의 유지 비용 때문에 기각. 대신 1단계 전에는 카드 토큰으로 시작한다 |
| 모든 쓰기를 앱에서 확인 / 초안만 만들어 사람이 보냄 | owner 결정 O5가 즉시 전송을 택했다 |
| 만료 없는 토큰 | owner 결정 O4(30/90일), GitHub 선례 |
| 비밀 값이 든 한 줄 명령(`--header "Authorization: Bearer <값>"`)을 UI가 지어 준다 | argv·쉘 기록 노출(F10) |
| 운영 스크립트 `scripts/oort`를 개명하거나 CLI에 합친다 | 여러 문서·게이트가 그 경로를 가리키고, 저장소 체크아웃에 의존하는 스크립트를 바이너리가 부르는 것은 취약하다(D10) |
| 별도 테이블(`dev_credential`) | RLS·멤버 전체 폐기·행 잠금 순서(#3109)를 처음부터 다시 맞춰야 하고, 폐기 누락 위험이 커진다. 같은 `token` 표에 `kind='dev'`로 두되 CHECK로 구분한다 |
| 공개 Homebrew tap을 먼저 | M7-S 등급이다(D11) |

## 새 공개 API·DB 선언 (ADR-0100)

**공개 API.** 정확한 필드·오류 문자열은 구현 이슈가 OpenAPI와 함께 봉인하고(`docs/api/openapi.yaml` 드리프트 게이트), 계약은 아래예요.

| 메서드·경로 | 호출자 | 요지 | 이슈 |
|---|---|---|---|
| `GET /v1/workspaces/{ws}/dev-access` | 사람 세션 | 스위치 값, 내가 만들 수 있는지 | #4660 |
| `PATCH /v1/workspaces/{ws}/dev-access` | owner·admin(사람 세션) | 스위치 변경 + 영향받는 토큰 폐기 | 체크리스트 |
| `GET /v1/workspaces/{ws}/dev-access/credentials[?scope=all]` | 본인 / `all`은 owner·admin | 목록(비밀·해시 없음) | #4660 |
| `POST /v1/workspaces/{ws}/dev-access/credentials` | 사람 세션 + 현재 비밀번호 | 카드 토큰 발급(`no-store`, 비밀 1회) | #4660 |
| `DELETE /v1/workspaces/{ws}/dev-access/credentials/{id}` | 소유자 / 사다리 | 폐기(멱등) | #4660 |
| `GET`·`DELETE /v1/workspaces/{ws}/dev-access/self` | 개발자 토큰 | `whoami` 몸통 / 자기 폐기 | #4660 |
| `POST /v1/mcp/me` | 개발자 토큰 | 사람 MCP | #4661 |
| L3~L7 (`channels`·`messages`·`replies`·`messages` 전송·`inbox`) | 개발자 토큰도 허용 | 기존 라우트에 허용 행만 추가(+채널 제한·본문 제한·표식, inbox는 `approvalsPending` 빈 목록) | #4660 |
| OAuth `authorize`·`token`·`revoke`의 사람 주체 모드 + 내장 클라이언트 `oort-cli` | 공개(토큰 소지로 인증) | 브라우저 승인 | 체크리스트(E3) |
| 메시지 DTO의 `sentVia`(nullable, 응답 전용) | — | 「명령줄에서」 표식 | #4660 |

**DB (새 migration만, `schema_v0.sql` 불변).**
- `token_kind`에 `dev` 값을 더하고, 같은 `token` 표를 써요. `dev` 행에만 쓰는 열(형태 `dev_form`, 도구 `dev_tool`, 채널 제한 `dev_channel_ids`, 클라이언트 `dev_client`, 기기 이름, 계보 절대 만료 등, 이름은 #4660이 봉인)을 nullable로 더하고 CHECK로 묶어요: `dev` 행은 `expires_at`이 있고 `created_at + 90일` 이하, `dev` 행의 `scopes`는 `dev:` 어휘 안, `dev`가 아닌 행에는 `dev:` 범위와 `dev_*` 값이 없어요.
- `message.sent_via`(nullable, 값 `dev`만 허용하는 CHECK).
- `audit_log.action`에 새 값들을 쓰지만 스키마는 바뀌지 않아요.
- 워크스페이스 스위치의 저장 위치는 구현이 고르되 위 D3의 불변식(일반 설정 갱신 경로로 못 바꿈)을 지켜요.
- 새 테넌트 표를 만들지 않으면 RLS 정책 대상 변경은 없어요. 구현이 표를 더하면 RLS FORCE 대상에 포함해요(AGENTS.md).

**봉인은 구현 이슈에서**: 열 이름, 루프백 후보 포트 목록, 오류 코드 문자열, 속도 제한 설정 이름·값, MCP 도구 이름, CLI 플래그 철자, migration 번호.

## 수용 기준 (red proof)

각 줄은 「해당 결정을 되돌리면 시험이 빨강」이어야 해요. **사보타주**는 그 시험이 실제로 빨강인지 구현 PR이 확인하는 방법이에요. 이 ADR의 보안 문장은 아직 공개 보안 주장이 아니에요(구현 전). 구현 이슈가 시험을 가진 뒤에 `docs/security/claims.yaml`에 올려요(ADR-0214).

| ID | 결정 | 단정 | 사보타주 | 이슈 |
|---|---|---|---|---|
| R1 | D1·D5 | (a) 카드 토큰·access로 `POST /v1/mcp/agent-port` → 401 `invalid_token`(모르는 문자열과 같은 본문). (b) `momo_agent_v1`·hosted OAuth access·pairing·사람 세션 JWT로 `POST /v1/mcp/me` → 같은 401 | Agent Port 인증이 `momo_dev_v1`을 받게 하면 (a), 사람 MCP가 JWT를 받게 하면 (b) 빨강 | #4660·#4661 |
| R2 | D2 | (i) `token_hash`가 시험이 독립으로 계산한 **봉투 전체**의 SHA-256과 같고 비밀 부분만의 SHA-256과 다르다. 같은 비밀 바이트에 접두만 다른 두 봉투(`momo_dev_v1`·`momo_devr_v1`·`momo_agent_v1`)는 해시가 서로 다르다. (ii) 형식 필터: 살아 있는 refresh를 데이터 라우트에, 살아 있는 access를 갱신 라우트에 내면 401이다. (iii) 만료·폐기·없음·다른 워크스페이스·형식 오류가 바이트가 같은 401 | (i): 해시 입력에서 접두를 빼면 빨강. (ii): 조회의 `kind`·`dev_form` 필터를 지우면 빨강(해시만으로는 (ii)가 막히지 않는 경우를 따로 증명) | #4660 |
| R3 | D4 | (a) 단위: L1~L8 각각 정확한 (메서드, 라우트)→범위. (b) 통합: **`docs/api/openapi.yaml`의 모든 operation과 `docs/api/openapi.undocumented-allowlist.json`의 28개를 합친 집합** 중 표에 없는 것에 개발자 토큰 → 403 `dev_route_not_allowed`(F18: 승인 결정 `POST /v1/agent-runs/{run}/approval-decisions` 같은 문서 밖 라우트가 합집합에 들어 있다). 합집합이 라우터에 마운트된 라우트를 모두 덮는지도 단정한다(마운트됐는데 둘 다에 없는 라우트가 있으면 빨강). (c) 실제 라우터에 개발자 토큰으로 변형 경로(끝 슬래시·`//`·퍼센트 인코딩·대소문자·HEAD)를 보내 **핸들러에 닿은 횟수 0**, 라우트 확정값이 없으면 거절(fail-closed). 시험 라우터에는 `{ch}` 자리와 겹치는 정적 세그먼트 라우트(예: `…/channels/archived/messages`) fixture를 둔다. (d) 개발자 토큰으로 토큰 발급·폐기·목록 라우트 → 403 | 키를 원시 경로 모양 매칭으로 바꾸면 (c)의 겹침 fixture가 뚫려 빨강. `required_dev_scope`의 기본 분기를 `Some(…)`으로 바꾸거나 표에 `DELETE …/messages/{id}`를 넣으면 (a)(b) 빨강 | #4660 |
| R4 | D4 | `DEV_SCOPES`와 기존 모든 범위 상수가 서로소. `dev` 행에 `dev:` 아닌 범위, 비`dev` 행에 `dev:` 범위가 못 들어간다(DB CHECK) | `dev:messages:read`를 `messages:read`로 개명하면 서로소 시험 빨강 | #4660 |
| R5 | D2 | (a) DB: `dev` 행을 `expires_at` NULL 또는 `created_at + 91일`로 INSERT → CHECK 위반. (b) API: `expiresInDays`가 0·91·음수·null·문자열 → 400, 생략 → 30일. (c) 승인 +90일 뒤의 refresh → 거절, 회전이 계보 상한을 넘는 refresh를 만들지 않는다. (d) 21번째 카드 토큰 → 409 `dev_credential_limit` | CHECK를 지우면 (a), 회전이 `now()+30일`을 그대로 쓰면 (c) 빨강 | #4660 |
| R6 | D2·D9 | 만들기 응답은 `Cache-Control: no-store`이고 비밀은 그 응답에만 있다. 목록·상세 응답·감사 행·서버 로그(trace 포함)·진단 번들에 마커 비밀의 어떤 부분 문자열도 0. 헤더 밖(쿼리·쿠키·본문)의 토큰은 401 | 목록 DTO에 해시를 더하거나 로그에 `Authorization`을 찍으면 빨강 | #4660 |
| R7 | D6 | 현재 비밀번호가 없거나 틀리면 401/403, `token` 행 0, 거절 감사 한 줄. 틀린 재확인이 멤버당 분당 5회를 넘으면 429(맞는 비밀번호도 그 창에서는 429) | 검증 호출을 지우면 빨강, 제한을 지우면 429 단정이 빨강 | #4660 |
| R8 | D3 | (a) 기본(`admins`)에서 member·guest·에이전트 멤버의 발급 403, owner·admin 201. (b) 역할이 admin→member로 내려간 뒤 살아 있던 토큰의 **다음 요청** 403(별도 sweep 없이). (c) `members`면 member 가능·guest 불가. (d) `off`·좁히기는 영향받는 토큰을 같은 tx에서 폐기하고 다시 열어도 부활하지 않는다. (e) 일반 설정 갱신(사람 PATCH·`workspace.settings.update`)으로 스위치를 못 바꾼다 | 사용 시점 평가를 지우면 (b), 폐기 대신 정책 확인만 하게 바꾸면 (d) 빨강 | #4660 ((a)(b)) · 체크리스트 ((c)(d)(e)) |
| R9 | D7 | 비밀번호 변경·재설정·정지·제거·탈퇴 각각 → 카드 토큰과 로그인 계보(access·refresh)가 모두 다음 요청에서 401. 같은 tx(사이 창 없음). 두 sweep 동시 실행에 교착이 없다(기존 `two_downgrading_rotations_on_two_lineages_never_deadlock` 모양) | 비밀번호 변경·재설정 경로의 폐기 술어를 `kind = 'session'`으로 되돌리면 그 두 경로가 빨강(D7이 지목한 함정). 정지·제거·탈퇴는 각자 경로의 단정이 따로 있고 `dev` 행을 제외하는 조건을 넣으면 빨강 | #4660 |
| R10 | D2·D7 | 회전 뒤 옛 refresh 재사용 → 계보 전체 폐기 + 감사 한 줄. 동시 두 갱신 중 하나만 성공. 유휴 30일 거절 | 재사용 감지를 지우면 빨강 | #4660·E3 |
| R11 | D4 | 제한 {A}: B의 읽기·쓰기·스레드 → 없는 채널과 바이트가 같은 404. 채널 목록에 B 항목 0. inbox는 B 채널의 승인 카드·미읽음·인용을 미리 심어 둔 뒤 `approvalsPending`이 빈 목록이고 `unreadCount`와 `items`에 B가 0이다(F17). A에서 나가면 A도 404. 발급 때 멤버 아닌 id → 400 | 채널 목록 필터를 지우면 빨강. inbox의 승인 목록 호출을 제한 없이 되돌리거나 `unreadCount`를 전체 수로 되돌리면 빨강 | #4660 |
| R12 | D4·D8 | `props`·`type`≠text·`runId`·`attachmentIds`·`routing`·`signature`·`stream`·`harnessRefine`·`apps`가 있는 개발자 토큰 전송 → 400 `dev_field_not_allowed`, 저장 0. 허용 본문 → `sent_via='dev'`. 같은 본문을 세션 JWT로 → `sent_via IS NULL`. 세션 경로에서 `sentVia`/`props`로 표식을 흉내 내도 반영되지 않는다. 작성자 편집 뒤에도 유지 | 표식을 요청 필드에서 읽게 바꾸면 빨강 | #4660 |
| R13 | D9 | 토큰당·멤버당·쓰기 한도 초과 → 429 + `Retry-After`. 0·파싱 불가 설정은 기본값. 키는 안정 id | 제한기를 지우면 빨강 | #4660·#4661 |
| R14 | D5 | (a) `tools/list`는 범위 ∩ 정책의 도구만. (b) 모든 도구에 주석이 있고 범위 표에서 파생되며 쓰기 도구만 읽기 전용이 아니다. (c) 도구 이름이 Agent Port 카탈로그와 서로소. (d) 각 도구 결과가 대응 REST 행과 같다(채널 제한·본문 제한·표식 포함). (e) `/v1/mcp/me`의 GET/DELETE는 거절(200이 아니다) | 도구 하나의 주석을 반대로 하면 (b) 빨강 | #4661 |
| R15 | D9 | 수락된 모든 요청이 인증 tx 안에서 `auth.dev_token.used` 한 줄을 남기고 `last_used_at` 갱신과 원자적이다. `detail`은 닫힌 어휘뿐(본문·채널 id·쿼리 없음). 거절 행은 상한이 있다 | `used` 행 쓰기를 지우면 빨강 | #4660 |
| R16 | D10 | (a) 파일 폴백은 `umask 000`에서도 디렉터리 0700·파일 0600으로 처음부터 생성되고, 권한이 넓으면 읽기를 거절. (b) 키체인이 있으면 키체인만 쓰고, 없을 때만 파일(표준에러 고지 + `whoami --json`의 `storage`). 키체인 쓰기 실패는 자동 강등이 아니라 오류(`--storage file` 명시 때만 파일). (c) 토큰을 받는 인자 플래그가 없고 `--with-token`은 표준입력만. 비밀이 프로세스 인자 목록에 나타나지 않는다 | 파일을 기본 umask로 만들면 (a), 실패 시 몰래 파일에 쓰면 (b) 빨강 | #4662 |
| R17 | D10 | 만료된 access로 CLI 프로세스 8개를 동시에 호출 → 서버(모의)가 받은 refresh 요청 1건, 재사용 감지 0, 8개 모두 성공 | 파일 잠금을 지우면 빨강 | #4662 |
| R18 | D10 | 비루프백 `http://` 서버는 자격을 보내기 전에 거절. 다른 호스트로의 리디렉트에 `Authorization`을 보내지 않는다. TLS 검증을 끄는 플래그가 없다 | 리디렉트를 자격과 함께 따라가게 하면 빨강 | #4662 |
| R19 | D10 | 명령마다 `--json` golden(`schema` 필드·종료 코드 표). 알 수 없는 필드는 추가만 허용. `oort token` 외의 어떤 명령 출력에도 비밀이 없다(마커) | `whoami`에 토큰 필드를 더하면 빨강 | #4662 |
| R20 | D6 | (E3 뒤) S256 외 거절. `state`·`iss` 불일치 시 CLI 중단. `redirect_uri`가 내장 목록과 정확히 같을 때만 진행하고 아니면 리디렉트 없이 오류. 코드 60초·1회·틀린 verifier 거절. 수신기는 `127.0.0.1`에만 바인드하고 정해진 경로의 한 번의 콜백 뒤 닫힌다. 동의 응답은 `frame-ancestors 'none'`. 발급 범위 ⊆ 요청 ∩ 선택. 동의·교환 두 시점에 정책 평가. **현재 비밀번호 재확인 없이 동의 API를 부르면 코드가 만들어지지 않는다**(틀린 비밀번호 거절, 한도 초과 429) | `plain` 허용 또는 `state` 비교 제거 시 빨강. 동의 API의 재확인 호출을 지우면 빨강 | E3 (체크리스트) |
| R21 | D2·D6·D7 | (a) member가 타 멤버 토큰 폐기 → 없는 id와 같은 404, admin이 owner의 것 → 403, owner가 member의 것 → 200(재호출도 200), 다른 워크스페이스의 id → 404. (b) `?scope=all` 목록은 member·guest 403. (c) L2는 호출한 토큰(계보)만 끄고 같은 멤버의 다른 토큰은 살아 있다(L2에는 id 인자가 없다). (d) 에이전트 멤버 소유의 `dev` 행은 만들 수 없다(CHECK·트리거 또는 발급 조회가 `member.kind='human'`을 요구) | 폐기 SQL에서 `actor_member_id` 술어를 빼면 (a), 발급이 에이전트 멤버를 받아들이게 하면 (d) 빨강 | #4660 |

**구현 메모 (#4660, 2026-10-28)** — 결정은 바꾸지 않고, 구현이 정한 두 가지만 적어요.
- **R11·D4의 「없는 채널과 바이트가 같은 404」는 실제로 403 `{"error":{"message":"not a member of this channel"}}`예요.** 기존 앱이 없는 채널과 비멤버 채널에 이미 주는 응답이 그 403이라서, 제한 밖 채널의 읽기(L4)·스레드(L5)·쓰기(L6)는 그 응답과 상태·본문·헤더가 바이트까지 같아요. 존재 여부를 알려 주지 않는다는 의도는 그대로이고 새 404 분기는 만들지 않았어요. R11의 단정은 숫자 404가 아니라 「없는 채널·비멤버 채널과 같은 응답」으로 읽어요. D10의 종료 코드 표(5 없음 = 404, 채널 제한 포함)는 404를 전제로 적혀 있으니, 이 403을 어느 종료 코드로 둘지는 #4662가 정해요.
- **`sentVia`는 열이 NULL이면 응답에서 키를 빼요(`null`을 싣지 않아요).** 선택 필드는 키를 뺀다는 OpenAPI 전체의 규칙을 따랐어요. 실시간 프레임의 키는 snake_case인 `sent_via`예요.

**구현 메모 (#4661, 2026-10-28)** — 결정은 바꾸지 않고, 구현이 봉인한 것과 구현이 정한 것만 적어요.
- **도구 이름(D5 「#4661이 봉인」)**: `oort_me_whoami`(L1)·`oort_me_channels`(L3)·`oort_me_read`(L4, `threadRootId`가 있으면 L5)·`oort_me_post`(L6)·`oort_me_inbox`(L7). 전부 `oort_me_`로 시작하고 Agent Port 카탈로그(`oort_<명사>_<동사>`)에는 `oort_me_*`가 없어요(R14 c). `search`는 도구가 아니에요(`dev:search`는 이름만).
- **주석은 필요 범위에서만 파생돼요(R14 b)**: `readOnlyHint`는 필요 범위가 `dev:messages:write`가 아닌 모든 도구에서 참이고, `destructiveHint`·`openWorldHint`는 거짓, `idempotentHint`는 참이에요(쓰기는 `clientMsgId`로 한 번만 반영돼요). 도구 목록의 항목은 `ToolDescriptor::for_human` 하나로만 만들어서 범위와 주석이 따로 적힐 수 없어요. Agent Port 항목에는 주석 키가 없고 목록 바이트가 그대로예요.
- **도구 결과는 REST 행의 본문이에요(R14 d)**: 각 도구는 REST 핸들러를 같은 추출자(`Principal`·`DevCredential`)로 직접 불러요. 채널 제한·멤버십·`approvalsPending: []`·`sent_via = 'dev'`는 그 핸들러의 것이라 복사본이 없어요. REST가 4xx로 거절하면 도구 결과는 `isError: true`이고 `structuredContent`가 `{status, error: {message, code?}}`예요. Agent Port의 닫힌 `ToolFailure`와 다르게 한 것은, 이 말이 같은 사람에게 REST가 이미 하는 말이라 존재 여부를 새로 알려 주지 않고 모델이 읽고 고칠 수 있어야 하기 때문이에요. 5xx는 JSON-RPC -32603, 스키마는 통과하지만 못 하는 인자 조합(스레드 읽기에 `before` 등)은 -32602예요.
- **문(D5·R1 b)**: `/v1/mcp/me`는 `require_principal` 밖에 자기 문(`human_mcp::door`)을 달았어요. 안에 두면 에이전트 자격이 닫힌 목록의 403을 받아 「전부 같은 401」이 깨지고 세션 JWT는 통과해요. 문은 ① 운영자가 지정하지 않은 `Origin`을 403(빈 응답, 예산·`used` 행 0)으로, ② 개발자 봉투가 아닌 bearer를 DB를 읽지 않고 모르는 문자열과 같은 401로 거절하고, ③ 개발자 봉투는 REST 행들이 쓰는 `require_dev_principal`에 그대로 넘겨요(닫힌 표 L8·정책·예산·`used` 행). POST 외 메서드는 개발자 토큰이면 닫힌 표의 403이에요.
- **문이 이 라우트에 걸지 못하는 두 예산(R13)**: L8의 범위가 `dev:identity`라서 문은 한 호출이 전송인지 몰라요. `post` 도구가 토큰의 전송 예산(`dev:write:{토큰}`)과 멤버의 전송 예산(`write:send:{멤버}`, `POST …/messages`가 라우트 계층으로 쓰는 것)을 REST와 같은 키·같은 함수로 직접 소비해요. 초과는 429 + `Retry-After` + JSON-RPC -32029예요. 그때 문의 `used` 행은 이미 쓰인 뒤예요(그 POST도 한 번의 사용이고, 토큰당 분당 240이 그 행의 상한이에요).
- **본문 허용목록(D4)**: 도구 입력 스키마가 닫혀 있어(`additionalProperties: false`) 전송의 인자는 `channelId`·`clientMsgId`·`body`·`rootId`·`replyToId` 다섯뿐이에요. REST 요청은 이 다섯에서만 만들고 나머지 필드는 구조체 리터럴에 「없음」으로 적어서, REST 본문에 필드가 늘면 이 곳이 컴파일되지 않아요(허용목록 방식).

**시험 없이 증명하는 것**: 배포(D11)는 M7 게이트 기록, 업계 사실(위 [S])은 출처 링크예요.

## 이행 계획

의존 순서: ADR-0216(이 PR) → #4660 → (#4663 ∥ #4661) → #4662 1단계 → E3(체크리스트) → #4662 2단계(브라우저 로그인). Goal A(데스크탑·iOS 일상 사용, ADR-0187)가 먼저이므로 이 묶음은 그 뒤에 얹는 것을 권해요.

| 순서 | 이슈 | 내용 | 의존 | 정본 | 시험 |
|---|---|---|---|---|---|
| 0 | #4659 | ADR-0186 증보: job 없는 제안·메시지 고정(별도 워커가 병행). 이 ADR은 링크만 | — | D12 | 그 증보 |
| 1 | #4660 | 개발자 토큰 서버: 종류·접두·해시, 닫힌 REST 표 L1~L7, 발급·목록·폐기·자기 폐기, 수명·상한, 폐기 연쇄, 표식·본문 제한, 감사·속도 제한. 스위치는 고정값(`admins`)으로 | 이 ADR | D2·D3·D4·D7·D8·D9 | R1~R13·R15·R21 |
| 2 | #4663 | 설정 › 연결 › 「명령줄·AI 도구」 카드: 프리셋·채널·재인증·한 번만 표시·명령 탭(순위는 D10)·목록·폐기 | #4660 | D2·D4·D6-가·D10 | design-review |
| 2 | #4661 | 사람 MCP `/v1/mcp/me`: `whoami`·`channels`·`read`·`post`·`inbox`, 도구 주석 | #4660 | D5 | R1·R13·R14 |
| 3 | #4662 | `oort` CLI crate. 1단계: 카드 토큰으로 `login --with-token`·`whoami`·`channels`·`read`·`post`·`inbox`·`token`·`mcp`·`logout`. 2단계: 브라우저 `login` | #4660 (+#4661로 `mcp`, E3로 2단계) | D6·D10·D11 | R16~R19 (+R20) |

**체크리스트 — 아직 이슈가 없는 것(이 PR은 새 이슈를 만들지 않아요)**
- [ ] ADR-0162 증보: OAuth 서버의 **사람 주체**(E3) — 내장 클라이언트 `oort-cli`, 고정 루프백 후보 포트, 동의가 연결이 아닌 사람 세션에 결속, 토큰 교환 시 개발자 토큰 발급 — 그리고 flag 개방의 운영 결정·runtime proof. 동의 직전 현재 비밀번호 재확인(D6-나)과 새 계보 발급 알림을 같은 묶음으로 한다
- [ ] ADR-0162 증보: 제3자 클라이언트의 루프백 임의 포트·`localhost`와 CIMD 허용목록 여부(DCR·CIMD의 SSRF 면은 별도 위협 모델이 먼저 필요해서 이 ADR은 열지 않아요, ADR-0162 A4)
- [ ] 관리자 스위치(D3)의 저장·변경 API·UI, 관리자 전체 목록의 강제 폐기 UI, 자격별 최근 호출(진단 기록, ADR-0200 증보 4 모양)
- [ ] 장치 코드(RFC 8628, SSH용) — D6 후속 요구를 수용 기준으로
- [ ] 배포: 데스크탑 번들 동봉 + 「명령줄 도구 설치」 메뉴(M7-I) → 공개 tap(M7-S 뒤)
- [ ] 동의 화면 문구(D6-나의 요소 목록을 바탕으로)
- [ ] 「명령줄에서」 표식의 웹·데스크탑·폰 표시, 폰 승인 화면(장치 코드 단계에 맞춰)
- [ ] 새 개발자 토큰 발급을 다른 세션에 알리는 앱 안 알림(ADR-0195 D-8 모양)
- [x] 역방향 줄: ADR-0162·ADR-0173·ADR-0198 머리에 이 ADR 한 줄(#4660의 PR에서)
- [ ] `scripts/oort help` 첫 줄 안내(#4662의 PR에서), 레포 비밀 스캔 규칙에 `momo_devr?_v1` 패턴 추가 검토(#4660)
- [ ] `docs/security/claims.yaml` 등재: 시험이 생긴 주장만(ADR-0214)

## 이 ADR이 열지 않는 것

- 구조 변경(채널 만들기·초대·역할), 승인 카드 결정, 작업 spawn·허락, 에이전트 지시문 수정, 편집·삭제·고정·반응·첨부, 검색, 실시간 구독, inbox 읽음 처리 — 개발자 토큰으로는 전부 닫혀 있어요.
- DCR·CIMD·클라이언트 비밀·introspection(ADR-0162 비목표 유지), 장치 코드, 제3자 클라이언트의 네이티브 OAuth.
- 위임 토큰(`delegation`), 멤버 단위 허용(스위치는 워크스페이스 단위), 에이전트 신원으로 쓰는 CLI 프로필, 에이전트 쪽 연결 요청(D12).
- Windows 빌드, TUI, 자체 업데이트.

## 위험과 미확인

**알려진 한계(받아들인 것)**
- 허용된 범위 안에서는 정보가 옮겨질 수 있어요. 「읽기 + 보내기」 토큰이 한 채널에서 읽고 같은 제한 안의 다른 채널에 쓰는 것을 막지 못해요. 「고른 채널만」과 「읽기만」 기본이 줄여 줄 뿐이에요.
- 즉시 전송은 되돌릴 수 없고(편집·삭제 도구가 없어요), 멘션은 에이전트를 깨워 비용을 만들 수 있어요. 쓰기 예산이 유일한 한도예요.
- 환경 변수로 넘긴 토큰은 도구가 띄우는 하위 프로세스에 상속돼요.
- 비밀번호를 바꾸면 모든 연결이 끊겨요(의도예요).
- refresh 재사용 감지는 응답 유실 재시도에서 오탐해요(다시 로그인).
- 속도 제한 카운터는 프로세스 메모리예요(여러 대면 한도가 늘어요).
- 새 개발자 토큰이 발급돼도 다른 세션에 알리는 앱 안 알림은 아직 없어요(체크리스트).

**`runtime-unverified`**
- 사람 JWT의 Agent Port 거절, 현행 허용목록에서 Claude Code의 `localhost` 임의 포트가 등록되지 않는다는 점은 코드·문서로만 확인했어요(F1·F7). Codex의 고정 포트 통과는 추정이에요.
- `headersHelper`(Claude Code)·`http_headers_helper`(Codex)의 실행·출력 계약과 stdio MCP 호환(`oort mcp`)은 실제 클라이언트로 확인하지 못했어요. ADR-0190 D3-h도 헬퍼를 저장까지만 확인했어요.
- 번들 안 바이너리의 코드 서명·공증 요건, 공개 Homebrew의 M7-S 해당 여부, `keyring` 크레이트의 서명 없는 개발 빌드·헤드리스 Linux 동작, 파일 잠금의 네트워크 파일시스템 동작은 실행하지 않았어요.
- `ALTER TYPE … ADD VALUE`와 CHECK 제약이 포함된 migration의 실제 동작(Postgres 18), 확장한 폐기 sweep의 교착 여부는 실행하지 않았어요(R9가 잡아요).
- OAuth 서버는 flag로 닫혀 있고 runtime proof가 없어요. 1단계(브라우저 로그인)는 그 뒤의 일이에요.

## 결재 기록

**planner 재량으로 정한 것**(owner 결정 5개를 구체화한 것 포함, 이탈하면 보고):

| # | 정한 것 | 위치 |
|---|---|---|
| P1 | 종류 하나(`dev`)·형태 둘(카드/로그인 세션), 접두 `momo_dev_v1`·`momo_devr_v1`, access 15분·refresh 30일 유휴·승인 +90일 절대 상한, 멤버당 개수 상한 | D2 |
| P2 | 스위치 값 셋(`admins`/`members`/`off`), guest 불가, 사용 시점 평가, 좁히기·`off` 때 폐기, 워크스페이스 단위(멤버 단위 허용은 후속) | D3 |
| P3 | `required_dev_scope` 표 L1~L8, 라우트 템플릿 키, `dev:` 범위 어휘, 프리셋 변환, 채널 제한(1~50), 본문 제한, `dev:search` 예약만 | D4 |
| P4 | 사람 MCP `/v1/mcp/me`, 단일 audience, 도구 주석, 카탈로그 서로소 | D5 |
| P5 | 카드 발급과 브라우저 승인 직전의 현재 비밀번호 재확인, 내장 클라이언트 `oort-cli`와 고정 루프백 후보, `--with-token`·`OORT_TOKEN` 교량 | D6 |
| P6 | 로그아웃과 개발자 토큰의 비연동, 자기 폐기 L2, 연쇄 sweep을 `dev`까지 확장 | D7 |
| P7 | `message.sent_via` 열(요청이 아니라 자격 종류에서 파생), 「읽기만」 기본 선택, 쓰기 예산 | D8 |
| P8 | 감사 모양, 속도 제한 숫자(240/480/30) | D9 |
| P9 | `oort` 이름 공존안, 1차 명령의 모양·종료 코드·`schema`, 자격 보관·갱신·전송 규칙, 비밀 취급 순위 | D10 |
| P10 | 배포 순서(번들 동봉 → 공개 tap) | D11 |

**#4617 이슈 본문과 다른 곳**(이슈 본문을 크게 고치지 않고 이 ADR이 정본이에요):
- 「ADR-0180 증보의 8자 연결 코드 재사용」 → 방향이 반대라 **문자 집합·MAC·시도 예산만** 후속 장치 코드에서 빌려요(owner 결정 O3과 일치).
- 1차 명령에서 `propose` 제외, 「에이전트 연결 요청 → 승인 카드 → 자격 수령」은 이 ADR 밖(D12).
- 「기존 채널에 멤버 넣기」는 `channel.member.add`로 이미 있어요(F15). 메시지 고정은 #4659, 채널 목록 읽기는 #4661(사람 문)이에요.

**독립 보안 검수.** 새 서브에이전트(`security-engineer`)가 이 ADR 초안만 받아 1회 검수했어요(저장소 코드는 읽기 전용으로 확인). r1 판정은 **FAIL(Blocker 0 · High 5 · Medium 17 · Low 9)** 이었고, AGENTS.md 「반드시 보존할 계약」을 깨는 곳은 없다고 봤어요. High 다섯 개는 문장과 시험 행을 고쳐서 풀었어요(owner 결정 O1~O5와 D 번호는 바뀌지 않았어요).

| 지적 | 고친 곳 |
|---|---|
| H1 inbox(L7)가 채널 제한을 우회해요(승인 카드 목록·`unreadCount`) | D4에 inbox 응답 필드를 모두 정함(`approvalsPending`은 항상 빈 목록, 제한 안에서만 셈, 도메인 인자로 제한), R11 확장, F17 신설 |
| H2 R3이 닫힌 목록을 증명하지 못해요(문서 밖 28개 연산, 키 선택 미보호) | R3의 순회 집합을 `openapi.yaml` ∪ 문서 밖 허용 목록으로 넓히고 마운트 전수 단정·겹침 fixture·라우터가 확정한 라우트 기준을 더함, F18 신설, D4·T9 |
| H3 브라우저 승인이 재확인 없이 90일 계보를 만들어 T7이 다시 열려요 | D6-나에 [허용] 직전 현재 비밀번호 재확인, R20 확장, T7·위험 절·이행 체크리스트 |
| H4 R2의 사보타주가 해시 바꾸기로는 빨강이 안 돼요(형식 필터가 막음) | R2를 「해시가 봉투 전체와 같다」와 「형식 필터」 두 단정으로 분리, D2에 조회 필터 명시 |
| H5 폐기·목록 인가·사람 멤버 한정에 시험이 없어요 | R21 신설, D2·D7 시험 의무 |

같은 검수자가 고친 부분만 1회 다시 확인해서 H1~H5가 모두 **해소**이고 **새 Blocker·High는 없다**고 답했어요(재검수 라운드는 하지 않았어요). 검수가 짚은 사실 오기(F3·F5·F9·F11·F16, 그리고 D7·R9가 말한 코드에 없는 「관리자 세션 종료」 경로)도 바로잡았어요. Medium 17개·Low 9개는 고치지 않고 PR 본문 「후속」에 적었어요(planner 지시).

검수가 하지 않은 것: 시험·빌드·서버 실행(전부 정독), `route_layer` 안에서 `MatchedPath`가 보이는지(`runtime-unverified`, #4660이 먼저 확인), GitHub 이슈·원격 브랜치 번호 충돌(번호는 작성자가 직접 확인). 검수 보고서 원문은 워커 스크래치에 있고, 검증 증거의 정본은 PR 본문이에요.

## 후속

체크리스트 항목들(위 「이행 계획」)이 후속이에요. 이 ADR의 문장 중 구현으로 증명되는 것은 구현 이슈가 R번호 시험과 함께 가져오고, 그 뒤에 `claims.yaml`에 올려요.
