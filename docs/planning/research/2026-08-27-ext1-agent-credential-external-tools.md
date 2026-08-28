# #1797 — EXT-1 외부 도구 연동 자격 조사·판정

> 이슈: [#1797](https://github.com/yeomyeonggeori/oort/issues/1797) · 트랙: engine · 조사형 (코드 변경 0, 문서만).
> 기준 커밋: `origin/track/engine` `bd41f6b6`. 워크트리 `~/projects/momo-tracks/momo-worktrees/w1797-ext1`.
> 실측 스택: compose `momo_docs-1797-ext1-agent-credential` (할당 포트 API 후보 `25160` / Cent `25161` / PG `25162`) + 로컬 `momo-server` `127.0.0.1:25160`.
> **라이브 리그 `oort-t` · 외부 VM 비접촉.** 토큰 원문은 이 문서와 첨부 어디에도 없음.
> 첨부: [폐곡선 응답 로그](2026-08-27-ext1-agent-credential-closed-loop-evidence.md).

---

## 한 줄 판정

**외부 도구는 사람 세션이 아니라 generic agent credential로 붙는 것이 맞고, 그 자격의 발급·장수명·유예 회전·채널 참여(admin이 넣기)·메시지 쓰기는 오늘 코드에서 폐곡선이 선다.** 다만 **읽기는 서지 않는다** — REST `GET …/messages`는 에이전트 스코프 표에 없고, Agent Port 읽기 tool은 hosted connection의 승인 교집합에만 열려 generic 자격의 `tools/list`는 빈 목록이다. ADR-0162 `409 hosted_connection_managed`는 **hosted 전용 member에만** 걸리며, 일반 agent member(외부 도구 시나리오)는 예외에 걸리지 않는다.

---

## ① 폐곡선 실측

절차: `make up`(워크트리 `.env.worktree`) → `make migrate` → `momo-migrate set-owner` → `momo-server` `:25160` → curl. 시드 김인턴은 `MOMO_AGENT_SEED_MODE=none`이라 0명. 측정용 agent를 API로 새로 만들었다.

| 단계 | 호출 | 결과 | 판정 |
|---|---|---|---|
| 사람 로그인 | `POST /v1/auth/login` | 200. access JWT `typ=access`, 스코프 `messages:write`+`messages:read`, TTL **900초** | 사람 세션은 15분. 이슈 발제와 일치 |
| 에이전트 등록 | `POST /v1/workspaces/{ws}/agents` | 201. `id=01a042dc-0a44-7e84-93ad-6b90dae5ada8`, 자격 없음 | 신원만 민트 (`openapi.yaml:1117-1122`, `agents.rs:49-50`) |
| 채널 참여 (admin) | `POST …/channels/{general}/members` | 200. membership `role=member` | 사람 owner/admin만 (`channels.rs:303-334`, `lib.rs:634-636`) |
| 자격 발급 | `POST …/agents/{agent}/credentials` | 201. `token` 1회, `Cache-Control: no-store`, **`expiresAtMs` 없음** | 장수명. 기본 스코프 5개 (아래 ②) |
| 쓰기 | agent bearer로 `POST …/messages` | **201**, `seq=1`, `authorMemberId`=그 agent | 폐곡선 성립 |
| REST 읽기 | 같은 bearer로 `GET …/messages` | **403** `agent bearer is not allowed for this route` | 스코프 표에 GET이 없음 (`agent_scope.rs:367-378`, `auth.rs:851-854`) |
| 자기 합류 | agent bearer로 `POST …/members` | **403** 같은 문장 | 도구가 스스로 방에 들어가지 못함 |
| 명시 read+port 재발급 | `messages:write/read` + `agent:port:connect` + `agent:inbox:read` | 201, `rotatedCredentialCount=1`, grace ~24h | 회전·유예 실존 |
| REST 읽기 (명시 read) | successor로 GET | **403** 동일 | `messages:read`는 REST를 열지 않음 (`agent_scope.rs:59-64`) |
| 유예 쓰기 | 회전 직후 predecessor로 POST | **201**, `seq=3` | "exactly one successor remains long-lived; predecessor has a grace" 실측 |
| Agent Port | successor + 올바른 Accept | `tools/list` **200 `tools: []`**; `oort_conversation_read` **400 unknown tool** | generic은 포트에 입장만 하고 도구 0 |
| hosted 409 | hosted member에 generic issue/revoke | **409** `hosted_connection_managed` | ③ |
| 대조 | 사람 GET messages | **200**, seq 1·2·3 본문 확인 | 쓰기는 저장됐다 |

**폐곡선 판정:** 이슈가 물은 "발급 → 메시지 write → 채널 참여"는 **선다**(참여는 도구가 아니라 사람 admin의 `POST …/members`). "메시지 read"는 **서지 않는다** — 코드 결함이 아니라 현재 계약. 고치지 않고 후속 티켓으로 남긴다.

---

## ② 스코프 모델

스코프는 실존한다. 닫힌 enum이고, 발급 때 정규화되며, 검증은 route→scope allow-list다.

**발급 (generic):** `normalized_agent_credential_scopes` (`agent_credential.rs:164-188`).

| 집합 | 값 | 근거 |
|---|---|---|
| 기본 (본문 `scopes` 생략) | `agent:jobs:read`, `agent:runs:callback`, `messages:write`, `realtime:subscribe`, `work:control` | `DEFAULT_AGENT_CREDENTIAL_SCOPES` (`agent_credential.rs:31-37`). 실측 ⑤와 일치 |
| 닫힌 허용 | 위 + `messages:read`, `provider:quota:write`, `agent:port:connect`, `agent:inbox:read` | `GRANTABLE_AGENT_CREDENTIAL_SCOPES` (`:39-49`), OpenAPI `AgentCredentialScope` (`openapi.yaml:8022-8033`) |
| 기본에서 빠진 것 | `messages:read`, `agent:port:connect`, `agent:inbox:read`, `provider:quota:write` | ADR-0162가 읽기/포트를 기본에서 뺐다 (`agent_credential.rs:26-30`). 유닛 테스트 `:539-548` |
| 운영자 게이트 | `provider:quota:write`만 instance operator | `agent_credential_requires_instance_operator` (`:190-194`), 라우트 `:164-171` |

**검증 (도달):** `required_agent_scope(method, path)` (`agent_scope.rs:73-181`). `None`이면 에이전트는 403 (`auth.rs:851-854`). 오늘 열리는 REST는 대략 다음뿐이다.

| 표면 | 필요 스코프 |
|---|---|
| `POST …/channels/{ch}/messages`, `PATCH …/messages/{id}` | `messages:write` |
| `POST /v1/mcp/agent-port` | `agent:port:connect` |
| gateway pending/lease | `agent:jobs:read` |
| gateway events/complete | `agent:runs:callback` |
| `POST …/work-controls` | `work:control` |

`messages:read`와 `agent:inbox:read`는 **REST 표를 비운다** (`agent_scope.rs:52-64`, 테스트 `:435-440`). 이름만 있고 HTTP GET 히스토리는 없다.

**Agent Port 도구**는 그 위 한 겹이다. 카탈로그는 hosted connection의 `approved_scopes ∩ token.scopes ∩ server capability` (`agent_port_tools.rs:91-104`, `agent_port.rs:194-200`). generic member는 live hosted connection이 없으므로 `ToolView::empty()` — 실측 23·24.

사람 세션 스코프는 `base_scopes()` = `messages:write` + `messages:read` (`auth_routes.rs:100-101`). 그래서 오케스트레이터가 사람 토큰으로 읽기/쓰기를 할 수 있었고, 15분+회전 리프레시에 죽은 것이다 (`issue.rs:23-25`).

### 외부 도구 최소 집합 (오늘 코드 기준)

| 도구가 하는 일 | 오늘 가능한가 | 권고 스코프 |
|---|---|---|
| 채널에 글 쓰기 (Claude Code/CI가 결과를 올리는 것) | **가능** (REST POST) | **`messages:write`만** — 기본 5개보다 좁다 |
| 채널 히스토리 읽기 | **불가** (REST 403 + MCP 빈 목록) | `messages:read`를 넣어도 REST가 안 열리고, generic에선 MCP tool도 안 열림 |
| 멘션 job을 받아 실행 | 가능 (gateway) | 기본에 있는 `agent:jobs:read` + `agent:runs:callback` |
| hosted Grok Bot / Agent Port 도구 | generic이 아님 | hosted activation의 6-scope 상한 (`0162` D3). generic API로 발급하면 409 |

**권고:** 외부 도구(Claude Code·스크립트·CI)의 v0 최소 집합은 `["messages:write"]`. 기본값을 그대로 쓰면 job/realtime/`work:control`까지 따라온다 — 필요 없으면 명시적으로 좁혀라. 읽기가 필요하면 후속 티켓(아래) 전에는 사람 세션을 빌리는 수밖에 없고, 그건 이 티켓이 기각하는 모델이다.

---

## ③ ADR-0162 예외 — `409 hosted_connection_managed`

**걸리는 경우:** 대상 agent에 `hosted_agent_connection` 행이 있을 때. `lock_agent_credential_target`이 `hc.id IS NOT NULL`이면 `HostedConnectionManaged` (`agent_credential.rs:267-292`). generic issue/revoke 라우트는 그 판정을 **쓰기 전에** 409로 돌린다 (`agent_credentials.rs:62-64, 126-139, 327-341`).

실측:

- generic `ext1-claude-code` — issue 201, list 200, 회전 201. **409 아님.**
- `POST /hosted-agent-connections`로 만든 `ext1-hosted-probe` (`status=pairing_pending`) — generic issue **409**, revoke **409**. 코드 문자열 그대로 `hosted_connection_managed`. pairing이 `active`가 아니어도 행이 있으면 걸린다.

**외부 도구 시나리오(일반 agent member)는 이 예외에 걸리지 않는다.** hosted pairing 흐름을 "외부 도구 연결"에 재사용하면 오히려 generic 발급이 막힌다. 두 경로는 같은 `member.kind='agent'`를 쓰지만 credential class가 다르다 (`0162:101`, OpenAPI `:1401-1402`).

---

## ④ 발급 UX 판정 (구현 금지 — 티켓 제안)

**지금 표면:** API만 있다. 웹 에이전트 만들기 폼은 자격 칸을 **의도적으로 두지 않는다** (`CreateAgentDialog.tsx:45-50` — provider 키를 momo에 넣지 말라는 ADR-0004 문장). `@momo/core`에도 generic credential client가 없다 (검색 0). 일회 비밀 카드·폴링은 hosted pairing 전용 (`hostedCredentialScope.ts`, `OneTimeSecretCard.tsx`).

**필요 여부: 있다.** 외부 도구 연동의 사람 손은 "토큰을 한 번 보고 도구 env에 넣는 것"인데, 그 손이 설정 화면에 없으면 운영자가 OpenAPI를 읽어야 한다. §5 셀프호스트 가이드가 curl을 보여 줄 수는 있어도, 제품 문장은 "에이전트 명부에서 만든다"까지다.

**ADR-0162 pairing을 재사용할 수 있는가:**

| 재사용 | 판정 |
|---|---|
| UX 부품 (일회 공개 카드, `no-store`, 복사 후 사라짐) | **가능·권고.** 비밀 수명 규율이 같다 |
| pairing lifecycle (`pairing_pending` → handshake → `detected` → confirm) | **불가.** 외부 도구는 oort로 다이얼인하지 않고, generic 자격을 들고 REST를 친다. hosted member로 만들면 ③의 409가 generic 재발급/폐기를 죽인다 |
| hosted confirm의 채널+스코프 승인 UI | **부분 가능.** "어느 방에 넣을지 + 어느 스코프를 줄지"는 같은 질문. 저장은 `membership` + generic `token.scopes`이지 `hosted_agent_connection.approved_*`가 아니다 |

티켓 초안은 아래 "후속 티켓 제안".

---

## ⑤ 부트스트랩 판정 (구현 금지)

이슈의 오늘 실측: 사람 경로에서 **초대 → 계정 → 토큰 = 3회**. 사람 토큰은 15분 + 회전 리프레시라 도구가 저장·재사용을 직접 해야 한다.

경로별 사람 손 (첫 owner가 이미 있는 셀프호스트 기준):

| 경로 | 사람 개입 | 비고 |
|---|---|---|
| A. 사람 세션을 도구에 넣기 (오늘 아픈 길) | 3+ (초대/가입/로그인 + 만료마다 재수령 또는 refresh 스크립트) | 기각. 모델이 브라우저 세션용 |
| B. 오늘 generic API (이번 실측) | **4** — 로그인 + 에이전트 생성 + 채널 합류 + 자격 발급(원문 1회 복사) | 그 다음부터는 장수명. 읽기는 불가 |
| C. 제안: "외부 도구 연결" 한 화면 | **2** — 로그인 + 위저드 1회 (신원+채널+스코프+일회 토큰) | ④의 UX 티켓. 비밀 복사는 제거 불가 |
| D. 첫 인스턴스 owner | B/C에 **+1** (claim 또는 `set-owner`) | ADR-0166. 설치 1회 |
| E. 0회 | **불가** | 원문을 사람이 한 번은 봐야 한다. 서버가 도구 런타임에 푸시할 채널이 없음 |

줄일 수 있는 상한은 **로그인 이후 3회 → 1회(위저드)**. 초대→계정은 "이 인스턴스에 사람이 아직 없을 때"만 남고, 도구 자체는 사람 계정을 만들지 않는 것이 맞다 (에이전트 member).

hosted pairing은 개입을 **늘린다** (전용 member + handshake + confirm + 값 교체). 외부 도구에 쓰지 마라.

---

## ⑥ SELF_HOST.md 초안

①의 **쓰기 폐곡선이 섰으므로** `docs/SELF_HOST.md`에 「6. 외부 도구 연동」 절을 같은 PR에 넣는다. 읽기 불가와 hosted 409는 친절하게 적되, 추천은 generic `messages:write`다.

---

## 후속 티켓 제안

판정 승인·이슈 발급은 오케스트레이터·성재. 여기 초안만.

### T-UX — 설정 「외부 도구 연결」 표면 (engine+UXUI)

- 워크스페이스 admin이 한 화면에서: agent member 생성(또는 기존 선택) + 채널 합류 + generic credential 발급.
- 일회 공개는 hosted `OneTimeSecretCard` 패턴 재사용. pairing/hosted connection 행은 만들지 않음.
- 목록은 metadata only (현행 `GET …/credentials`). 회수 = 현행 revoke.
- 기본 제안 스코프: `messages:write`. 고급에서 닫힌 9개 중 hosted 전용 3개(`agent:port:connect` 등)는 generic 기본에 올리지 않음.
- 검증: 웹 게이트 + 이 문서 ①과 같은 curl이 UI 한 번으로 재현.

### T-READ — generic agent의 읽기 경로 (engine, ADR 필요 가능)

오늘 generic 자격은 쓸 수 있고 읽을 수 없다. 후보 둘(둘 다 ADR-0100 경계 — 공개 API/보안).

1. **REST:** `GET …/channels/{ch}/messages`를 `messages:read`에 올린다 (`required_agent_scope`에 한 줄). 외부 도구(curl/Claude Code)에 가장 짧다. 히스토리 표면이 에이전트에 열리는 것이므로 스코프 기본값은 계속 non-default.
2. **Agent Port:** generic bearer도 credential scopes만으로 tool view를 만든다 (hosted `approved_scopes` 교집합을 generic에는 적용하지 않음). 0162 D3/D4와 충돌 여부를 ADR에서 먼저.

권고는 1 — 이슈의 사용자("Claude Code 같은 곳")는 MCP hosted catalog가 아니라 REST를 기대한다. 2는 hosted 도구 모델을 generic에 흘리는 쪽이라 0162를 증보해야 한다.

### T-BOOT — 위저드가 T-UX에 포함되면 별도 티켓 불필요

개입 4→2는 T-UX의 수용기준으로 흡수. 초대/claim 축소는 ADR-0166 범위라 이 이슈에 넣지 않는다.

### 발견 결함 (수리하지 않음)

코드 버그로 폐곡선이 깨진 것은 없다. 다음 둘은 **계약상 공백**이다.

1. generic 자격 + `messages:read`여도 REST 히스토리 403, Agent Port 도구 0. 외부 도구 "읽고 쓰기"는 오늘 절반만 선다.
2. 설정 표면에 generic 발급이 없어, 선 폐곡선이 API를 아는 운영자에게만 열린다.

hosted 409, 기본 스코프에서 읽기 제외, 채널 합류의 admin 전용은 결함이 아니라 현행 불변식이다.
