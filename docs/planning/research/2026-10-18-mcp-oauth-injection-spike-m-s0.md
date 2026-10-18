# M-S0 스파이크 — 원격 MCP 주입 위치·OAuth 토큰 위치·client id 설정 실측 (ADR-0188 §8.9)

- 날짜: 2026-10-18 · 트랙: 엔진 · 이슈: #3941 · 계획 ID M-S0 · 기안: Sonnet 5.5 worker
- 계약: ADR-0188 §8.9 [확인 필요] 3개, ADR-0113 증보 2 E6(4번 항목), ADR-0191 D1(프로필 폴더)
- 코드 변경 0. `--mcp-config` 인자 금지(`momo-workd/src/policy.rs:884`)와 `"mcpServers": []`(:866)는 건드리지 않았다.
- 표기: [V] 이 세션에서 실행해 확인 · **runtime-unverified** 실행하지 않음

## 한 줄 결론
1. **주입 위치.** Claude는 **ACP `session/new`의 `mcpServers`만** 된다. host 소유 `settings.json`의 `mcpServers`는 격리를 끈 대조에서도 읽히지 않는다(Claude Code의 `settings.json`에는 그 키가 없고 서버 목록은 `.claude.json`·`.mcp.json`에 산다). Codex는 `config.toml` `[mcp_servers.*]`와 `session/new` `mcpServers` **둘 다** 된다.
2. **토큰 위치.** 둘 다 기본값은 **macOS 키체인**이고 프로필 폴더 밖이다. 단 Claude는 서비스 이름이 `CLAUDE_CONFIG_DIR` 경로의 해시로 갈려 프로필마다 항목이 따로다(ADR-0191 :74와 같은 모양). Codex는 서비스 이름이 하나(`Codex MCP Credentials`)이고 계정 이름이 `서버이름|URL해시`뿐이라 `CODEX_HOME`으로 갈리지 않는다. Codex는 `config.toml`의 `mcp_oauth_credentials_store = "file"`로 `$CODEX_HOME/.credentials.json`에 둘 수 있다. Claude에는 그런 스위치를 찾지 못했다.
3. **미리 등록한 client id.** Codex는 `[mcp_servers.<이름>.oauth] client_id`(`config.toml`)로 된다. Claude는 항목의 `oauth.clientId`(+`callbackPort`)로 되는데, ACP 어댑터가 `session/new` `mcpServers`를 `{type,url,headers}`로만 옮겨 `oauth`를 버리므로 `_meta.claudeCode.options.mcpServers`로 실어야 한다(아래 한계 참조).

## 환경과 방법
- 하네스: `@anthropic-ai/claude-code` 2.1.284, `@agentclientprotocol/claude-agent-acp` 0.81.0(번들 SDK 0.3.280, 실제 spawn되는 claude는 2.1.280), `@openai/codex` 0.158.0, `@agentclientprotocol/codex-acp` 1.13.0(번들 MCP 클라이언트 0.155.1).
- 모의 서버: 노드 `http` 한 파일(레포 밖 scratch). `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`, `/register`(DCR, 환경변수로 끔), `/authorize`(자동 승인 302), `/token`, `/mcp`(Bearer 없으면 401 + `WWW-Authenticate`, 있으면 `initialize`·`tools/list`·`tools/call`에 응답). 127.0.0.1 두 포트(DCR 있음/없음). **모의 서버가 받은 요청이 판정 기준**이다(CLI 출력이 아니라 서버 로그의 `initialize`·Bearer 여부).
- 격리: 매 실험 `HOME`·`CLAUDE_CONFIG_DIR`·`CODEX_HOME`을 scratch로 재지정하고 하네스는 절대경로로 실행했다(셸 래퍼 함수를 거치지 않음). 키체인은 `HOME` 아래 `Library/Keychains/login.keychain-db`를 `security create-keychain`으로 새로 만들어 **버려도 되는 기본 키체인**으로 썼다. 성재 키체인 파일의 수정 시각이 실험 전후 같음을 확인했다. 실제 벤더 계정·API 키·성재 자격은 쓰지 않았다(Codex ACP 인증은 가짜 API 키 문자열, 모델 호출 없음).
- 발견한 함정: `HOME`만 바꾸면 기본 키체인이 없어져 Codex가 `A default keychain could not be found`로 실패한다. 이 측정은 임시 키체인을 만들어 이를 피했다.

## 1. 원격 MCP 항목을 받는 자리

### Claude (`claude-agent-acp`, `_meta.claudeCode.options = {settingSources: [], strictMcpConfig: true, allowDangerouslySkipPermissions: false}` — policy.rs :361 모양)
| 실험 | 서버가 받은 것 |
|---|---|
| A. `$CCD/.claude.json` 사용자 범위 `mcpServers` + 격리 | **접촉 없음** (안 읽음) |
| D. 같은 설정, 격리 끔(대조) | `initialize`·`tools/list` (읽음) |
| B. `$CCD/settings.json` `mcpServers` + 격리 | 접촉 없음 |
| B2. 같은 파일, 격리 끔(대조) | **접촉 없음** → 격리와 무관하게 `settings.json`은 이 키를 읽지 않는다 |
| C. `session/new` `mcpServers: [{type:"http",name,url,headers:[]}]` + 격리 | `initialize`·`tools/list` 도달, 저장된 토큰이 있으면 Bearer 첨부 |
- `claude mcp add --scope user`가 쓴 곳은 `$CCD/.claude.json`이다(`settings.json` 아님) [V].
- ADR §8.9와 policy.rs 모듈 문서(:24-31)의 「host 소유 `settings.json` `mcpServers`」 가정은 Claude에서 성립하지 않는다. `session/new` `mcpServers`가 유일한 자리다. 이는 `"mcpServers": []`(:866)를 채우는 구현 한 곳이 M-S1의 일이라는 뜻이다(이 티켓은 바꾸지 않음).
- 어댑터는 ACP 항목을 `{type, url, headers}`로만 옮긴다(`acp-agent.js` 5937-5960 근처). `_meta.claudeCode.options.mcpServers`는 그 위에 합쳐진다(:6110).
- 미인증 항목은 연결하지 않고(401 후 발견 요청만 보내고 멈춤) 스스로 OAuth를 시작하지 않는다. ACP 클라이언트가 `elicitation.url` 능력을 선언하면 어댑터가 URL 요청으로 OAuth를 시작할 수 있다(아래 한계).
- 격리 없이 CLI를 돌리면 cwd 상위의 `~/.mcp.json`(프로젝트 범위)이 읽힌다. `strictMcpConfig`가 이를 막는 것이 정확히 이 격리의 몫이다.

### Codex (`codex-acp`, `CODEX_HOME` 격리, `HOME` 빈 폴더)
| 실험 | 서버가 받은 것 |
|---|---|
| C1. `config.toml`의 `[mcp_servers.x] url=…`, 토큰 없음 | 401에서 멈춤(OAuth 자동 시작 없음) |
| C2. 같은 항목 + `$CODEX_HOME/.credentials.json` | `initialize`·`tools/list`, Bearer 첨부 |
| C3. `session/new` `mcpServers` http(같은 이름) + 같은 자격 | `initialize`·`tools/list`, Bearer 첨부 |
| C4. `session/new` `mcpServers` http(**다른 이름**) + 같은 자격 | 토큰 없이 `initialize` 401 → **자격은 (이름, URL)로 맞춘다** |
- `session/new`에서 `mcpServers`를 주면 `config.toml` 없이도 된다. ACP 인증은 가짜 API 키로 통과시켰고 MCP 연결은 모델 호출 전에 일어난다.
- Codex ADR §8.9의 결정(`config.toml` `mcp_servers`만)은 그대로 가능하다. `session/new`도 되므로 Claude와 같은 경로로 통일할 수도 있다.

## 2. OAuth 토큰 저장 위치

### Codex
- 기본값 `mcp_oauth_credentials_store = "auto"`: 키체인이 되면 키체인, 안 되면 파일 [V]. 키체인 항목은 서비스 `Codex MCP Credentials`, 계정 `mock|<URL 해시>`. **`CODEX_HOME`으로 구분되지 않는다**(같은 이름·URL의 두 프로필이 한 항목을 쓴다).
- `"file"`: `$CODEX_HOME/.credentials.json`(권한 0600, 키 `이름|해시`, 값은 서버 이름·URL·issuer·client_id·access/refresh token·만료·scopes) 하나로 간다. 이때 키체인 변화 없음 [V]. 잠금 파일은 `$CODEX_HOME/mcp-oauth-locks/`.
- ADR-0191 조건 1(「`auth.json`과 `config.toml`만」)을 문자 그대로 적용하면 `.credentials.json`·`mcp-oauth-locks/`·`tmp/`가 허용 목록에 더해져야 한다.

### Claude
- 기본(키체인 사용 가능): 서비스 `Claude Code-credentials-<sha256(CLAUDE_CONFIG_DIR 문자열) 앞 8자리>`, 계정은 OS 사용자 이름. 값은 JSON이고 MCP 토큰은 그 안의 `mcpOAuth["이름|해시"]`(serverName·serverUrl·accessToken·refreshToken·expiresAt·clientId·issuer·redirectUri·discoveryState) [V]. 해시는 `printf '%s' "$CCD" | shasum -a 256`의 앞 8자리와 일치했다(ADR-0191 :74와 같은 규칙). `$CCD` 안에는 토큰 파일이 생기지 않았다.
- 키체인이 없는 환경(`HOME`에 기본 키체인 없음): 같은 흐름이 「성공」으로 끝나지만 **토큰이 저장되지 않았다**(`.credentials.json`도 없고 다음 상태는 `needs-auth`). 평문 파일로 폴백하지 않는다 [V]. 잠긴 키체인·무GUI 세션의 host에서 같은 일이 나는지는 **runtime-unverified**(M-S1에서 host 환경으로 재야 한다).
- 위 기본 흐름은 `claude -p --input-format stream-json` 제어 요청 `mcp_authenticate`(응답에 `authUrl`)로 모델 로그인 없이 구동했다. 인증 뒤 `mcp_status`가 `connected`·도구 1개를 보고했고, 같은 `CCD`로 띄운 ACP 어댑터가 저장된 토큰으로 Bearer를 붙였다(실험 C). 다른 `CCD`에서는 토큰이 없어 `needs-auth`로 멈췄다(실험 C2).
- 결론: 프로필 폴더 **밖**(키체인)이지만 프로필마다 격리된다. §8.9가 「밖이면 다시 연다」고 적은 조건에 해당하므로 §8.9를 다시 열되, 그 결정은 ADR-0191 :74가 이미 받아들인 Claude 자격의 키체인 모양과 일관된다. Codex는 파일 스위치로 폴더 안에 둘 수 있다. 어느 쪽을 택할지는 ADR 소유자의 판단으로 남긴다.

## 3. 미리 등록한 client id (DCR 없는 서버)
- Codex: `codex mcp add <이름> --url <U> --oauth-client-id <ID>`는 `config.toml`에 `[mcp_servers.<이름>.oauth] client_id = "<ID>"`(+`callback_url`)를 쓴다. DCR 없는 모의 서버에서 `/register` 호출 없이 `/authorize?client_id=<ID>`로 갔고 토큰까지 받았다 [V]. 비밀값(`--oauth-client-secret`)은 플래그가 있으나 실행하지 않았다. 콜백 포트·URL은 `mcp_oauth_callback_port`·`mcp_oauth_callback_url`.
- Claude: 항목의 `oauth: {clientId, callbackPort}`(`claude mcp add --client-id --callback-port`가 `.claude.json`에 쓰는 모양). 격리된 새 프로필에서 `--strict-mcp-config --mcp-config`로 같은 항목을 주면 `authUrl`의 `client_id`가 지정한 값이었다 [V]. `oauth` 없이 DCR 없는 서버면 `SDK auth failed: Incompatible auth server: does not support dynamic client registration`로 실패한다 [V]. 기본 리다이렉트는 `http://localhost:3118/callback`.
- 위 두 값은 시크릿이 아닌 공개 client id라서 서명 묶음에 넣을 수도 있다. 단 client secret은 §8.9대로 묶음에 넣지 않는다.
- 한계: ACP 어댑터는 `session/new` `mcpServers`의 `oauth`를 버리므로 Claude에서 client id를 주려면 `_meta.claudeCode.options.mcpServers`가 필요하다. 이 경로는 같은 프로필의 앞선 실행이 남긴 상태 때문에 한 번 우연히 보였을 뿐, 깨끗한 프로필에서 어댑터가 OAuth를 스스로 시작하게 만들지 못했다(어댑터 경유 OAuth 시작은 **runtime-unverified**). CLI 제어 요청 경로로는 위처럼 확인됐다.

## 4. 하네스 자체 커넥터(claude.ai 계정 Gmail·Calendar·Drive)
**runtime-unverified.** 이 측정의 프로필에는 로그인한 claude.ai 계정이 없다. 성재 계정 상태가 필요해서 ADR-0113 증보 2 E6의 벤더 실측 세션(owner 행동 4)에서 한 번 같이 본다. 이 스파이크가 만든 관찰 하나: 격리 `strictMcpConfig` 아래에서는 사용자·프로젝트 범위 서버 목록이 읽히지 않는다(실험 A).

## M-S1(#3957)에 넘기는 사실
1. Claude 앱 항목은 `session/new` `mcpServers`로 싣는다. `settings.json` 쓰기는 필요 없고 쓸모도 없다.
2. Codex는 `config.toml`(host가 매번 다시 씀)과 `session/new` 둘 다 가능. 토큰 파일 스위치 `mcp_oauth_credentials_store = "file"` 결정이 필요하다.
3. Claude 토큰은 프로필별 키체인 항목이다. 프로필을 지울 때 `Claude Code-credentials-<해시>` 항목 정리와, 키체인이 없는 host에서 토큰이 저장되지 않는 동작에 대한 연결 카드 문구(「로그인했는데 다시 요구함」)를 정해야 한다.
4. OAuth는 호스트 안에서 시작해야 한다: Claude는 `mcp_authenticate` 제어 요청이 실증됐고, Codex는 `codex mcp login`(`--no-browser`로 URL과 콜백 입력을 받음)이 실증됐다.
5. 두 하네스 모두 미인증 항목에서 스스로 로그인 창을 열지 않는다(Codex ACP·Claude ACP 모두 401 후 멈춤). 단 `codex mcp add --url`은 OAuth를 감지하면 곧바로 브라우저 로그인을 시작한다(이 측정에서 시스템 브라우저가 모의 서버로 열렸다). host 코드에서 `mcp add`를 쓰지 말고 `config.toml`을 직접 쓴다.

## 재현
scratch의 모의 서버(`mock.mjs`)와 ACP·제어 요청 드라이버(`acp.mjs`, `cl.mjs`)는 레포에 넣지 않았다(스파이크 기록만 남기는 계약). 위 표의 각 행은 같은 모양으로 다시 만들 수 있다: 서버 로그에서 `initialize`와 Bearer 유무를 본다.
