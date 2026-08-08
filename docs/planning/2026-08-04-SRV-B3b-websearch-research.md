# SRV-B3b — 웹검색 툴: provider 능력 조사 (goal #1001)

> 상태: **조사 완료 · 구현 0** (패킷 지시: "추측 구현이 최악이다"). 기준 `track/engine@d5cc8559`.
> 발단: 성재 검수 — *"웹검색이 안 된다 — 툴이 필요하면 쥐어줘"*.
> 이 문서가 답하는 것: ① 이 provider 경로가 내장 웹검색 툴을 **받는가** ② 받는다면 oort 쪽에 **무엇이 없어서** 안 되는가 ③ 웹검색을 **승인 대상으로 볼 것인가**(권고, 결정은 위로).

---

## 0. 결론 세 줄

1. **provider는 받는다.** 이 경로(`https://chatgpt.com/backend-api/codex` + Responses)의 **모든 모델이 `supports_search_tool: true`를 스스로 선언**하고, 툴 형상은 `{"type": "web_search"}`다. 독립 출처 3종이 일치한다(§2).
2. **oort 어댑터도 이미 통과시킨다.** `tools`는 `agent.tool_schema` 배열이 **그대로** 실려 나가고(재해석 없음), 미지의 SSE 이벤트는 무시되며, `web_search_call`은 oort의 tool_call이 되지 않는다(§3). 어댑터는 **한 줄도 고칠 필요가 없을 가능성이 높다**.
3. **막고 있는 건 provider가 아니라 oort다.** `agent.tool_schema`에 **쓰기 경로가 레포 전체에 0건**이고(생성 시 `'[]'` 고정), `agent_profile.enabled_tools`에는 **읽는 코드가 없다**. 즉 오늘 어떤 에이전트도 어떤 툴도 가질 수 없다 — 웹검색만의 문제가 아니다(§4).

> goal #1000에서 찾은 것과 **같은 계열의 구멍**이다: 컬럼은 있고 검증도 있는데, 그 값을 채울 표면이 없다.

---

## 1. 조사 방법 — 무엇을 근거로 인정했나

레포의 `responses.rs` 모듈이 스스로 지키는 규칙("두 개의 독립 출처가 아니면 추측")을 그대로 적용했다. 자격증명은 **읽지 않았고 우회하지도 않았다**(ADR-0004) — 그 결과 인증된 왕복 한 번이 미측정으로 남는다(§7).

| # | 출처 | 성격 |
|---|---|---|
| A | `GET {base}/models` 응답 (백엔드 자신의 모델 카탈로그) | provider가 **자기 능력을 스스로 선언**한 값 |
| B | Codex CLI 네이티브 바이너리(0.144.1, `codex-darwin-arm64`)의 문자열 | 이 백엔드에 실제로 말을 거는 **현행 클라이언트의 와이어 타입** |
| C | OpenAI 공개 문서 (`developers.openai.com`, Responses 웹검색 가이드) | **공개 계약** |

---

## 2. provider는 받는가 → **받는다**

### 2.1 출처 A — 백엔드가 모델별로 웹검색 능력을 선언한다

경로 실재 확인: `GET https://chatgpt.com/backend-api/codex/models` → 미인증 **401 `{"detail":"Unauthorized"}`**. 경로는 있고 인증만 걸려 있다. 이 base URL은 ADR-0147 OAuth 링크가 저장하는 값(`momo-settings/src/link.rs:349`)이자 worker가 `/responses`를 던지는 그 호스트다.

응답 본문은 이 머신의 Codex CLI가 그 엔드포인트에서 받아 캐시해 둔 `~/.codex/models_cache.json`(`fetched_at 2026-08-04T06:30:49Z`, `client_version 0.146.0`, etag 동반)으로 읽었다. 모델마다:

| slug | `supports_search_tool` | `web_search_tool_type` |
|---|---|---|
| `gpt-5.6-sol` · `gpt-5.6-terra` · `gpt-5.6-luna` | `true` | `text_and_image` |
| `gpt-5.5` · `gpt-5.4` · `gpt-5.4-mini` | `true` | `text_and_image` |
| `gpt-5.3-codex-spark` | `true` | `text` |

**8종 전부 `true`다.** 웹검색은 이 백엔드에서 예외적 기능이 아니라 모델의 기본 능력으로 선언돼 있다.

### 2.2 출처 B — Codex CLI 바이너리가 쓰는 와이어 타입

바이너리에서 문자열로만 읽었다(자격증명 아님):

```
ResponsesApiNamespaceTool ……… web_search
ResponsesApiWebSearchFilters …  allowed_domains · country · region
툴 필드 ……………………………  search_context_size · search_content_types · image_settings
                                user_location(+utc_offset) · filters
                                external_web_access · indexed_web_access · allowed_callers
config.toml ………………………  [tools] web_search
                                WebSearchToolConfig{context_size, allowed_domains, location}
                                web_search_mode
출력 아이템 ……………………  web_search_call · WebSearchItem
  action ∈ search(query|queries) · open_page(url) · find_in_page(pattern) · other
텔레메트리 ……………………  web_search_count · web_search_action · query_present · query_count
```

### 2.3 출처 C — 공개 문서

`{"type": "web_search"}` (구형 별칭 `web_search_preview`). 선택 필드: `search_context_size`(low/medium/high) · `filters.allowed_domains`/`blocked_domains`(각 최대 100) · `user_location{type:"approximate", country, city, region, timezone}` · `return_token_budget`(default/unlimited) · `external_web_access`(**기본 true**) · `search_content_types` + `image_settings`. 출력은 `web_search_call`(action `search`/`open_page`/`find_in_page`, `sources` 포함)과 `message`의 `url_citation` annotation. **GPT-5+ · Responses API** 지원, 검색 컨텍스트 128k 상한.

### 2.4 세 출처의 교집합 = 안전하게 보낼 수 있는 최소 형상

```json
{"type": "web_search"}
```

`type`과 `web_search_call`은 A·B·C 전부 일치한다. 반면 `web_search_mode` · `allowed_callers` · `indexed_web_access`는 **B에만** 있다 — codex 전용 확장일 수 있으므로 최소 집합으로 시작할 것을 권고한다.

---

## 3. oort 어댑터는 이미 통과시킨다 (코드 실측)

| 사실 | 위치 | 함의 |
|---|---|---|
| `tools`는 `agent.tool_schema` 배열 **그대로** body에 실린다. 함수툴로 재해석하지 않는다 | `bins/momo-agent-worker/src/responses.rs:231-235` (+ `provider.rs:127-133` "Passed through rather than re-shaped") | `[{"type":"web_search"}]`는 **오늘 그대로 나간다**. 어댑터 수정 불요 |
| 알 수 없는 SSE 이벤트는 조용히 무시된다 | `responses.rs` `flush()` — match 마지막 arm "Every other event is progress, reasoning or bookkeeping" | `response.output_item.added` / `response.web_search_call.*`가 와도 스트림이 깨지지 않는다 |
| `collect_tool_calls()`는 `type == "function_call"`**만** 고른다 | `responses.rs:316-340` | **`web_search_call`은 oort의 tool_call이 되지 않는다.** 실행이 provider 안에서 끝나므로 oort가 실행할 것도, 승인 받을 것도 생기지 않는다 (→ §5의 구조적 근거) |
| `collect_output_text()`는 `message`의 `output_text`만 모은다 | `responses.rs:362-372` | `url_citation` **annotation은 버려진다**. 본문에 URL이 박혀 오면 남고, annotation으로만 온 출처는 사라진다 |
| 답변 본문은 delta 누적이 이긴다 | `responses.rs:288-294` | 검색이 provider 안에서 일어나도 사용자에게는 평소와 같은 스트리밍 답으로 보인다 |

**즉 provider 쪽 형상에 대해 oort가 고칠 것은 (인용 표시를 원하지 않는 한) 없다.**

---

## 4. 진짜 블로커 — oort 쪽 두 구멍

### 4.1 `agent.tool_schema`에 쓰기 경로가 없다

```
생성:  INSERT INTO agent (…, tool_schema, …) VALUES (…, '[]'::jsonb, …)
        crates/momo-agent/src/provisioning.rs:364-368   ← 리터럴 고정
갱신:  없음.  `grep -rn tool_schema server-rust --include=*.rs | grep -i 'update\|set '` → 0건
```

`POST /v1/workspaces/{ws}/agents`의 요청 바디(`CreateAgentRequest`)에도 이 필드가 없고, `PUT …/agents/{a}/profile`도 이 컬럼을 건드리지 않는다. **오늘 어떤 에이전트도, 어떤 툴도 가질 수 없다.** 웹검색이 안 되는 1차 원인은 여기다.

### 4.2 `agent_profile.enabled_tools`에는 읽는 코드가 없다

저장되고 검증된다(최대 128개, 유일·비어있지 않은 이름 — `provisioning.rs:196-255`). 그런데 **소비자가 없다**: mention 후보 쿼리(`mention.rs:127`)도 job payload(`mention.rs:490` — `payload["tools"] = candidate.tool_schema`)도 worker(`lib.rs:561` — `tools: payload.tool_schema()`)도 `enabled_tools`를 읽지 않는다. provider에 나가는 것은 `agent.tool_schema` **하나뿐**이다.

> 따라서 패킷이 제안한 "`agent_profile.enabled_tools` 어휘 확장"만 하면 **아무 일도 일어나지 않는다.** 어휘를 넓히는 것과 같은 티켓에서 *소비자*(enabled_tools → 전송 tools 배열 투영)를 만들어야 한다. 이 사실이 이번 조사의 실질적 산출물 중 하나다.

---

## 5. 승인 정책 판정 — **권고: 웹검색은 tool_call 승인 대상이 아니다** (결정은 성재/오케스트레이터)

패킷의 물음: *"읽기 전용 조회 툴이 tool_call 승인 대상인가? v0 승인 생산자는 work.session.end다 — 웹검색까지 승인을 물리면 대화가 멈춘다."*

### 근거 셋

1. **구조적으로 승인 생산자가 될 수 없다.** oort의 승인 경로는 `function_call` → `ToolCall` → `requires_approval`에서만 시작한다(§3). provider 내장 웹검색은 `web_search_call`로 오고 oort의 tool_call 파이프라인에 **아예 들어오지 않는다**. 승인을 물리려면 새 코드를 일부러 써야 한다 — "물릴까 말까"가 아니라 "굳이 만들까"의 문제다.
2. **G6가 지키려는 성질이 없다.** `requires_approval`의 fail-closed 방향은 **비가역성** 때문이다(`tools.rs` 모듈 주석: `work.session.end` = `t3_terminate`가 정산을 봉인, undo 없음). 웹검색은 읽기 전용이고 되돌릴 대상이 없다.
3. **대화가 실제로 멈춘다.** v0 승인은 사람이 인박스에서 눌러야 진행된다. 한 턴에 여러 번 검색하는 모델에 승인을 물리면 답 하나에 승인 N번이 된다. 게다가 provider가 턴 **안에서** 검색을 끝내므로 중간에 끼어들 지점도 없다.

### 대신 물려야 할 것 — 승인이 아니라 경계와 가시성

| 통제 | 권고 |
|---|---|
| on/off 단위 | 워크스페이스 기본 **off**, 에이전트별 켜기(fail-closed) |
| 도메인 경계 | `filters.allowed_domains` / `blocked_domains`를 운영자 설정으로 노출 |
| **데이터 경계** | `external_web_access` **기본 true** = 사용자 메시지에서 뽑은 검색어가 외부 검색엔진으로 나간다. **사내 메신저의 대화 내용이 외부로 나가는 경로**다 |
| 감사 | 지금은 `web_search_call`이 무시되므로 **아무 흔적도 남지 않는다**. 최소한 "이 턴에서 검색이 N번 일어났다"는 run detail/audit 기록을 권고 |

> **새 ADR 대상 1건 제기**: ADR-0004는 *credential이 oort 안으로 들어오지 않는 방향*만 다룬다. **대화 내용이 oort 밖 검색엔진으로 나가는 방향**은 어떤 ADR도 다루지 않는다. 웹검색을 켜는 결정은 그 ADR과 함께여야 한다.

---

## 6. 설계 스케치 (구현 아님 — 티켓 3장 제안)

| 티켓 | 내용 | 웹검색 의존 |
|---|---|---|
| **T-a** `agent.tool_schema` 쓰기 표면 | `POST …/agents` 바디에 필드 추가 또는 `PUT …/agents/{a}/tools`. 소유자/workspace admin 권위(프로필 쓰기와 동일). 신뢰경계: 이 컬럼은 provider body에 **그대로** 나가므로 입력 검증이 곧 와이어 검증이다 — credential-shaped 워크(`reject_credential_shaped_fields`)를 반드시 통과시킬 것 | **선행 필수 · 독립** |
| **T-b** 웹검색 어휘 + 소비자 | `enabled_tools`에 `web.search` 추가하고 **동시에** 투영을 만든다: `enabled_tools` → 전송 `tools[]`. **와이어별 분기 필수** — Responses = `{"type":"web_search"}`, chat/completions = **불가**(그 와이어의 `tools`는 `{"type":"function"}`만 받는다). `responses.rs`의 `max_output_tokens` 주석이 이미 같은 종류의 분기를 예고해 두었다 | 본체 |
| **T-c** 경계·관측 | 도메인 필터 · 기본 off 스위치 · 검색 발생 감사(§5) | 후속 |

`{"type":"web_search"}` 최소 형상으로 시작하고, `search_context_size`/`filters`는 T-c에서 붙인다.

---

## 7. 미측정 — 그리고 그것을 가르는 5분짜리 실험

1. **oort에서 인증된 왕복을 해 본 적이 없다.** `~/.codex/auth.json` 열람이 환경 정책으로 차단됐고 **우회하지 않았다**. 그래서 "이 백엔드가 oort의 요청에 대해서도 `web_search`를 받는가"는 코드·문서·카탈로그 추론이지 실측이 아니다.
   **검증 계획(로컬 스택 또는 라이브 1회, 쓰기 실험은 로컬에서):**
   `agent.tool_schema`를 SQL로 `[{"type":"web_search"}]`로 세팅 → `@oort 오늘 XX 뉴스 찾아줘` → ① 200/400 ② 400이면 provider 문구 그대로 ③ 답에 최신 정보가 실렸는지 ④ SSE에 `web_search_call`이 오는지(어댑터에 임시 로그 1줄). **이 결과가 T-a 착수 여부를 가른다.**
2. **클라이언트 신원 게이팅 가능성.** Codex CLI는 이 백엔드에 자기 신원 헤더(`originator: codex_cli_rs`, `x-codex-installation-id` 등)를 붙이고 **oort는 일부러 붙이지 않는다**(`responses.rs` 모듈 주석: "momo is not the Codex CLI"). 백엔드가 웹검색 툴을 클라이언트 신원으로 게이팅할 여지는 남아 있으며, 위 왕복으로만 갈린다.
3. **B에만 있는 필드**(`web_search_mode`·`allowed_callers`·`indexed_web_access`)는 검증되지 않았다 → 최소 집합 권고(§2.4).

---

## 8. 대안(참고) — provider가 거절할 경우의 비용 스케치

패킷 §Goal2-3 대비용. **권고하지 않는다** — 위 근거로 거절 가능성이 낮고, 비용이 비대칭적으로 크다.

서버사이드 검색 프록시 툴(`web.search`를 oort가 직접 실행, Brave/Bing/Tavily 등): 새 외부 자격증명 도입(ADR-0004 재검토 필요) · 새 실행자와 인자 검증(`tools::CATALOG` 확장) · 종량 요금 · 결과 요약/토큰 예산 파이프라인 · 인용 처리 · rate limit·타임아웃·실패 시맨틱. **내장 툴이 되는 한 이 경로는 명백히 비싸다.**

---

## 9. 계획 이탈

1. **구현 0.** 패킷 §Goal2-4("조사 보고 PR로 끝나도 된다") 그대로. 추측 구현 없음.
2. **승인 정책은 권고만 적었다** — 결정은 성재/오케스트레이터 몫(패킷 §Goal2-2 지시).
3. **새 ADR 대상 1건 제기**: 대화 내용의 외부 검색엔진 송출(데이터 경계). ADR-0004는 credential 방향만 다룬다(§5).
4. **자격증명 열람 차단, 우회하지 않음** → 인증 왕복 미실측(§7-1). 그래서 §0의 결론 1은 "실측 3종 교차 + 경로 401 확인"이지 "oort가 던져 봤다"가 아니다.
5. **범위 밖 결함 2건 발견, 손대지 않음** — ⓐ `agent.tool_schema`에 쓰기 경로 없음 ⓑ `agent_profile.enabled_tools`에 소비자 없음(§4). 둘 다 웹검색과 **독립한 선행 결함**이고, 특히 ⓑ는 "저장·검증되는데 아무 효과가 없는 필드"라 웹검색 없이도 고칠 값어치가 있다. 별도 goal 권고.
6. **패킷의 "enabled_tools 어휘 확장" 제안은 그대로는 성립하지 않는다** — 어휘만 넓히면 오늘과 동일하게 아무 일도 일어나지 않는다(§4.2). T-b는 어휘와 소비자를 한 티켓으로 묶을 것을 권고한다.
