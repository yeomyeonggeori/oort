# B4 — 클라이언트 소비 API 표면 × Rust 서버 계약 diff 매트릭스

> **갱신 2026-08-02 (B4.2)**: 설정 표면(D-3) 18쌍을 서버측으로 마감했다. 현재 사실의 정본은 **§10**이다. §9는 B4.1 시점, §0~§8은 B4 시점의 측정 기록으로 남긴다 — §4의 영역별 잔여표는 §9 → §10 순서로 델타를 겹쳐 읽어야 지금의 수가 된다.
>
> **갱신 2026-07-31 (B4.1)**: 도그푸딩 차단분 5쌍을 서버측으로 마감했다. 재분류·게이트 판정은 **§9**가 정본이고, §0~§8은 B4 시점의 측정 기록으로 남긴다(§4.1과 §7의 표는 §9의 델타를 함께 읽어야 현재 사실이 된다).
>
> 측정일 2026-07-31 · 측정 대상 `feat/B4-rewire`(base `track/engine` @ `dba8a44f`)
> 측정 방법: 클라이언트 코드에서 경로 리터럴 전수 추출 → 각 호출부의 요청/응답 필드 판독 → `server-rust/bins/momo-server/src/lib.rs` 라우트 테이블 및 각 route/DTO와 대조.
> **원칙**: 갭은 서버(Rust)를 고쳐 닫는다. Swift 서버 계약 = 정답, 클라가 이미 쓰는 형태가 기준.
> 이 문서는 **내부 도그푸딩 1차의 게이트 문서**다. "지금 이 서버로 무엇을 실제로 할 수 있는가"의 정본.

---

## 0. 한 문단 요약

클라이언트가 실제로 호출하는 표면은 **(경로, 메서드) 68쌍**이다. 그중 **14쌍은 이미 계약이 동일**했고,
**3쌍은 이 PR에서 서버측으로 마감**했으며(`realtime-token` · `centrifugo/subscribe` · `GET …/channels`),
**51쌍은 Rust 서버에 아직 없다**(별도 배치).
**클라이언트 코드 수정이 필요한 계약 불일치는 0건**이다 — 실측한 모든 차이는 서버가 못 따라간 것이지 클라가 틀린 것이 아니었고,
Swift 시절 계약을 그대로 구현하는 것으로 전부 닫혔다. UI 쪽에 남는 것은 계약 문제가 아니라 **새로 생긴 서버 상태(503)에 대한 카피** 1건이며 `ENGINE_HANDOFF.md`에 기록만 했다.

이 PR 이후 **부팅 → 채널 진입 → 메시지 왕복 → 실시간 수신**이 Rust 서버 단독으로 닫힌다. 그 밖의 라우트(설정·승인·에이전트 허브·플러그인·워크스트림·메모리·허들)는 아직 404이며, 도그푸딩 범위는 그만큼이다.

| 분류 | 수 | 뜻 |
|---|---|---|
| 동일 | 14 | 경로·메서드·요청/응답 필드가 이미 일치. 클라 무수정 동작 |
| **서버측 마감(이 PR)** | **3** | 실측으로 확정한 갭을 이 배치에서 Rust로 닫음 |
| 미구현 표면(배치 필요) | 51 | Rust 서버에 라우트 자체가 없음. 클라는 404/400을 받음 |
| UI 수정 필요 | 0 | 계약 불일치로 인한 클라 수정 요구 없음 |
| (참고) 서버만 존재 | 3 | 서버에 있고 웹 클라는 소비하지 않음 |

---

## 1. 측정 범위와 방법

### 1.1 실측 대상

| 클라 | 경로 | API 소비 표면 |
|---|---|---|
| 웹 SPA (정본, ADR-0133) | `clients/web/src/**` | **68쌍 전량.** `lib/api.ts`(2,402줄) · `features/settings/api.ts` · `features/timeline/approvalDecision.ts` · `lib/realtime.ts` |
| Tauri 셸 | `clients/desktop/src-tauri/src/**` | **0쌍.** IPC 커맨드만(`deep_link_*` · `discovery_*` · `open_external_url` · `notification_*` · `keychain_*` · `app_version` · `updater_*`). 업데이터 엔드포인트는 GitHub Pages(`tauri.conf.json:33-36`)로 oort API가 아니다 |
| `clients/Core` (MomoCore) | `Sources/MomoCore/**` | **0쌍.** URL 리터럴 0개. `ChatBackend`/`WorkspaceBackend` 프로토콜 + 모델 타입만 — 계약 **타입**의 정본이고 전송은 각 앱이 구현 |
| `clients/web-legacy` (ADR-0119) | — | 범위 밖(legacy). 웹 정본이 계승한 quirk의 출처로만 참조 |

**측정 명령(재현용)**
```bash
cd clients/web/src && grep -rn "v1/" --include="*.ts" --include="*.tsx" .   # 경로 리터럴 전수
cd clients/desktop/src-tauri/src && grep -n "reqwest\|/v1\|http" *.rs        # → 0건
cd clients/Core && grep -rn "v1/" Sources/                                   # → 0건
cd server-rust && sed -n '134,270p' bins/momo-server/src/lib.rs              # 라우트 테이블 정본
```

### 1.2 판정 기준 — "서버측 마감 가능"의 정의

이 배치가 닫은 것과 남긴 것의 경계는 **취향이 아니라 목적**으로 그었다.

> **서버측 마감 가능** = ① **도그푸딩 1차 시퀀스**(로그인 → 채널 목록 → 히스토리 → 전송 → 실시간 수신)를 막고 있고,
> ② **새 마이그레이션 없이**, 기존 crate 소유 규율(route raw SQL 0 · `token` SQL은 momo-auth · 멤버십 SQL은 momo-messaging) 안에서 닫히는 것.

②만 만족하고 ①을 만족하지 않는 표면(예: `POST …/channels` 채널 생성)은 **미구현 표면**으로 분류하고 구현하지 않았다. 시드된 워크스페이스에는 이미 채널이 있으므로 채널 *생성*은 부팅 경로가 아니다. 이 선을 그은 이유는 스코프 방어가 아니라, 이 문서가 "지금 도그푸딩이 되는가"에 답해야 하기 때문이다.

---

## 2. 서버측 마감 — 이 PR에서 구현한 3쌍

### 2.1 `POST /v1/auth/realtime-token` — Centrifugo connection 토큰

| | |
|---|---|
| 클라 호출부 | `clients/web/src/lib/api.ts:698` (`fetchRealtimeToken`) → `lib/realtime.ts:659` centrifuge-js `getToken` |
| Swift 정본 | `AuthRoutes.realtimeToken` (:309-341) + `JWTService.signCentrifugoConnection` (`Auth/JWT.swift:156-200`) |
| 구현 | `crates/momo-auth/src/realtime.rs`(서명) · `bins/momo-server/src/routes/realtime.rs::issue_token`(라우트) |
| 응답 | `{token, tokenType:"centrifugo.connection.jwt", expiresAtMs, ttlSeconds, workspaceId, memberId}` — 웹은 `token`만 읽지만 6필드 전부 Swift와 동일 |

**실측으로 확정된 사실 3가지**

1. **서명 키가 App JWT와 다르다.** Swift는 `app`/`cent` 두 kid로 HMAC 키를 따로 등록한다(`JWT.swift:104-113`). 그래서 `CENT_TOKEN_HMAC`을 새로 읽고, `JWT_HMAC`으로 서명하지 않는다 — 그랬다면 브로커 쪽 유출이 REST 액세스 토큰 발급 능력이 된다. 테스트가 이 분리를 잠근다(`the_app_secret_does_not_verify_a_connection_token`).
2. **`info` 클레임은 JSON 객체가 아니라 JSON *문자열*이고, 키가 정렬돼 있다.** Swift가 `.sortedKeys`로 인코딩하기 때문(`member_id`, `schema`, `workspace_id` 순). 순서를 바꾸면 와이어가 바뀐다.
3. **`sub`는 대문자 UUID여야 한다.** read-state는 `user:read-state#<MEMBER>`라는 **user-limited 채널**로 발행되고(`momo_messaging::read_state_channel`), Centrifugo는 `#` 뒤 접미사를 `sub`와 **바이트 단위로** 비교해 스스로 인가한다 — subscribe proxy가 개입하지 않으므로 서버 코드로는 구제할 방법이 없다. 소문자 `sub`였다면 모든 멤버가 자기 unread 레일을 거부당했을 것이다. 이 대조를 테스트로 고정했다(`the_connection_subject_matches_the_user_limited_channel_suffix`).

### 2.2 `POST /v1/centrifugo/subscribe` — subscribe proxy 콜백

| | |
|---|---|
| 호출자 | **클라가 아니라 Centrifugo.** `infra/centrifugo.json`이 `ch`/`agent`/`agentwork` 네임스페이스에 `subscribe_proxy_enabled: true`를 걸어둠 |
| 클라 관련부 | `lib/realtime.ts:73`(`ch:ws<WS>.<CH>`) · `:155-161`(`agent:ws<WS>.<CH>.<AGENT>`) |
| Swift 정본 | `CentrifugoRoutes.swift` 전체 |
| 구현 | `routes/realtime.rs::subscribe` + `momo_auth::has_active_realtime_credential` + `momo_messaging::{can_observe_agent, is_active_agent, is_channel_member}` |

**이 표면이 B4에 들어온 이유(실측)**: `infra/rust/docker-compose.rust.yml:71-75`가 스스로 적어둔 그대로다 — *"the subscribe proxy is inert until the Rust api serves /v1/centrifugo/subscribe (a later batch)"*. B1.7은 proxy secret만 걸어뒀고, 그 라우트가 없는 동안 **`ch:` 구독은 전부 실패한다**. 즉 로그인·히스토리는 되는데 실시간만 영영 안 오는 상태였다.

**세 단계 검사(순서가 계약이다)**
1. `X-Centrifugo-Proxy-Secret` **상수시간 비교, 바디 파싱 이전.** 네트워크 위치는 인증이 아니다.
2. `meta.token_id` 자격증명 **생존 확인**(`token` 행 재조회). connection 토큰은 TTL 동안 유효한 bearer이므로, 이 재확인이 **로그아웃이 실시간 레일을 끊는 유일한 지점**이다.
3. 채널별 규칙 — `ch:`/`dm:`=현재 멤버십, `agent:`=관전자와 에이전트가 **그 채널의** 현재 멤버, `agentwork:`=그 에이전트 본인만.

**응답 형태 주의**: 거부는 **HTTP 403이 아니라 200 + `{"error":{"code":403,...}}`**이다. Centrifugo 프록시 프로토콜에서 비-2xx는 "프록시가 고장났다"로 읽히므로, 평범한 권한 판정을 전송 장애로 바꿔버린다. 프록시 시크릿 불일치(=호출자가 Centrifugo가 아님)만 401이다.

### 2.3 `GET /v1/workspaces/{ws}/channels` — 채널 목록

| | |
|---|---|
| 클라 호출부 | `features/workspace/useWorkspace.ts:85` (`useChannels`) → `lib/api.ts:705` |
| Swift 정본 | `ChannelRoutes.list` (:41-73) + `fetchChannels` (:401-460) |
| 구현 | `momo_messaging::list_workspace_channels`(SQL) + `routes/channels.rs`(투영) |

로그인 직후 **사이드바 전체를 먹이는 호출**이다. 이것이 없으면 워크스페이스에 들어가도 대화로 들어갈 입구가 없다 — 부팅 경로를 막는 유일한 REST 갭이었다.

Swift 대비 유지한 계약:
- 정렬 = public → private → dm, 각 그룹 내 이름 case-fold 오름차순.
- `muted`는 **호출자 본인의** `notification_pref`(ADR-0124) — 채널 속성이 아니다.
- `memberIds`는 **DM에만** 채움. 공개 채널의 명부는 별도 read.
- `archivedAtMs`는 아카이브된 채널에만 존재(웹 사이드바가 `archivedAtMs === undefined`로 거른다).
- `limit` 기본 200 / 상한 500, 파싱 실패는 400이 아니라 기본값(Swift `Int($0) ?? 200`).
- `include_archived`는 리터럴 `"true"`만 인정(`1`/`yes` 아님).

---

## 3. 동일 — 이미 계약이 맞던 14쌍

| # | 메서드 · 경로 | 클라 호출부 | 대조 결과 |
|---|---|---|---|
| 1 | `POST /v1/auth/login` | `api.ts:548` | `accessToken`·`refreshToken`·`member{id,workspaceId,kind,displayName,handle}`·`realtimeWebSocketUrl` 전부 일치 |
| 2 | `POST /v1/auth/refresh` | `api.ts:464` | 단일사용 회전 포함 동일 |
| 3 | `POST /v1/auth/logout` | `api.ts:659` | 멱등(200 + `alreadyRevoked`) 동일 |
| 4 | `POST /v1/workspaces/{ws}/dms` | `api.ts:773` | `{channel, created}` + 201/200 분기 동일 |
| 5 | `GET …/channels/{ch}/messages` | `api.ts:1107` | `before`=DESC·`after`=ASC·`nextBefore`=최소 seq 까지 동일 |
| 6 | `POST …/channels/{ch}/messages` | `api.ts:1170` | 평문 전송(멱등 `clientMsgId`) 동일. **단** `rootId`/`routing`은 §4 참조 |
| 7 | `GET /v1/workspaces/{ws}/read-state` | `api.ts:1064` | snake_case `read_states[]` 동일 |
| 8 | `PUT …/channels/{ch}/read-state` | `api.ts:1085` | 요청 `{last_read_seq}` · 응답 snake_case 동일 |
| 9 | `GET /v1/workspaces/{ws}/work-sessions[?active=1]` | `api.ts:1261` | `workSessions[]` + `remoteAttachAvailable`·`observation`·`observerGrantCount` 동일 |
| 10 | `PATCH …/work-sessions/{s}` | `api.ts:1277,1314` | `{status:"ended"}` / `{observation}` 양쪽 동일 |
| 11 | `POST …/work-sessions/{s}/resume` | `api.ts:1291` | `{targetHostId}` → `{workSession}` 동일 |
| 12 | `POST …/work-sessions/{s}/terminal-attach` | `api.ts:1354` | snake_case `{attach_endpoint, capability_token, pty_id}` 동일 |
| 13 | `GET /v1/workspaces/{ws}/work-hosts` | `api.ts:1387` · `settings/api.ts:365` | `workHosts[]`(+`publicKey`) 동일 |
| 14 | `GET /v1/workspaces/{ws}/usage/summary` | `settings/api.ts:471` | `range`·`totals`·`buckets`·`byModel`·`byAgent`·`budget` 전 필드 일치(`usageModel.ts` 파서 기준) |

---

## 4. 미구현 표면 — 51쌍(배치 필요)

Rust 서버에 라우트가 없다. 클라는 404를 받고 각 화면의 오류 상태로 떨어진다.

| 영역 | 쌍 수 | 표면 | 클라 호출부 |
|---|---|---|---|
| 초대 가입 | 1 | `POST /v1/join` | `api.ts:606` |
| 워크스페이스·명부 | 5 | `POST /v1/workspaces` · `GET /v1/workspaces/{ws}` · `GET …/roster` · `GET …/invites` · `POST …/invites` | `settings/api.ts:389,399,442,449` · `api.ts:784` |
| 채널 생성 | 1 | `POST /v1/workspaces/{ws}/channels` | `api.ts:750` |
| 스레드·라우팅 | 3 | `GET …/messages/{root}/replies` · `POST …/messages`(`rootId` 동반) · `POST …/messages`(`routing` 동반) | `api.ts:1131,1202,2383` |
| 승인 | 2 | `GET …/approvals` · `POST …/approvals/{id}/decision` | `api.ts:1727` · `timeline/approvalDecision.ts:89` |
| 워크스트림 | 3 | `GET …/workstreams` · `/{id}` · `/{id}/runs` | `api.ts:1585,1608,1622` |
| 에이전트 | 7 | `GET …/channels/{ch}/agent-runs` · `GET …/agents/{a}/runs` · `GET …/agent-runs/{run}` · `GET·PUT …/agents/{a}/profile` · `PUT …/agents/{a}/pause` · `GET …/agents/{a}/allowed-models` | `api.ts:1873,1886,1929,2010,2050,2064,2027` |
| 메모리 | 4 | `GET …/memories` · `GET …/memories/search` · `POST …/memories/{id}/invalidate` · `GET …/memories/{id}/grants` | `api.ts:2283,2299,2317,2332` |
| 플러그인 | 6 | `GET …/plugins` · `GET …/plugins/{p}` · `POST·DELETE …/plugins/{p}/install` · `POST …/plugins/{p}/grants` · `DELETE …/grants/{scope}` | `api.ts:996-1043` |
| 허들 | 4 | `GET …/huddles/active` · `POST …/huddles` · `POST …/huddles/{h}/join` · `/leave` | `api.ts:322-402` (패킷 §3 out of scope) |
| 프로바이더·설정 | 15 | `GET·PUT·DELETE /v1/provider/link` · `POST /v1/provider/link/test` · `GET·PUT·DELETE /v1/provider/link/chain` · `GET·PUT /v1/provider/work-host-engine` · `GET /v1/provider/effort-table` · `GET /v1/provider/quota-snapshots` · `GET·PUT …/work-tier-policy` · `GET·PUT …/work-tier-policy/me` | `settings/api.ts:132-505` · `api.ts:1953` |

### 4.1 `routing` 프로브 — 고치면 안 되는 것을 기록해 둔다

웹은 컴포저의 모델/추론강도 선택기를 열기 전에 `probeSendRouting`(`api.ts:2383`)으로 서버를 한 번 찔러본다. 존재하지 않는 `rootId` + 유효하지 않은 `routing.effort`를 보내고 **거절 문구로** 세대를 판정한다(`features/routing/capability.ts:197-224`).

- 400 + 문구에 `routing` 포함 → `ready`(선택기 개방)
- 404 `thread root not found` → `absent`(구세대, 조용히 무시)
- 그 외 → `unknown`(선택기 잠금 + 「다시 확인」)

**Rust 서버 실측**: `reject_unsupported`(`routes/messages.rs:117-140`)가 `root_id`를 **먼저** 검사하므로 `400 "rootId (thread replies) is not served by momo-server yet"`이 나가고, `/routing/i`에 걸리지 않아 판정은 **`unknown`**이 된다. 결과적으로 컴포저의 모델/강도 선택기는 잠긴 채 「다시 확인」이 붙는다.

**이것은 정확한 결과이며, 서버로 "닫으면" 안 된다.** 검사 순서를 뒤집어 `routing`을 먼저 거절하게 만들면 프로브는 `ready`로 판정하지만, Rust 서버는 `routing`을 **지원하는 게 아니라 400으로 거절**하므로 선택기를 연 뒤의 모든 전송이 실패한다. 즉 순서를 바꾸는 것은 갭을 닫는 게 아니라 **거짓말을 하는 것**이다. `routing`을 진짜로 구현하는 배치가 올 때까지 `unknown` + 잠금이 정직한 상태다.

---

## 5. UI 수정 필요 — 0건 (계약 불일치 기준)

실측한 68쌍 어디에도 "클라가 서버와 다른 형태를 쓰고 있어서 클라를 고쳐야 하는" 지점은 없었다. 확인한 후보와 판정:

| 후보 | 판정 | 근거 |
|---|---|---|
| `lib/realtime.ts` `resolveSpikeRealtimeUrl` — 로그인이 준 WS 주소를 loopback으로 재작성 | **불필요** | REST base가 loopback일 때만 발동하는 ADR-0110 예외. Rust 스택은 `MOMO_CENTRIFUGO_WS_URL`을 필수(`:?`)로 요구하므로 운영자가 브라우저 해석 가능한 주소를 넣으면 그만이다. **운영 노트**이지 UI 수정이 아니다 |
| `fetchReadStates`가 snake_case를 읽음 | **불필요** | Rust `ReadStateDto`도 snake_case(의도적, `dto.rs:900-920`) |
| `Channel.muted`가 필수 boolean | **불필요** | Rust가 항상 발행 |
| `Message.thread` 롤업 부재 | **불필요** | 클라에서 optional. `threadRollup()`이 null 반환 → 배지 미표시. 스레드 배치가 오면 자동 개선 |
| `fetchWorkSessions`가 `res.workSessions` 무방비 접근 | **불필요** | Rust가 항상 배열 발행 |
| `GET …/roster` 404 | **불필요(성능저하만)** | `useDirectory`가 빈 디렉터리로 폴백 → 타임라인이 uuid 파생 라벨을 표시. 렌더는 막히지 않음 |
| `POST …/realtime-token`이 **503**을 답할 수 있음(신규 상태) | **ENGINE_HANDOFF 기록** | 계약 불일치가 아니라 새로 생긴 서버 상태. centrifuge-js는 `getToken` 실패를 구분하지 않아 "연결 끊김"만 남는다 → 카피 개선 여지. §7 A-26 |

---

## 6. (참고) 서버에만 있고 웹이 소비하지 않는 표면

| 표면 | 비고 |
|---|---|
| `GET /v1/workspaces/{ws}/search/messages` | Rust 서버 구현됨(B1.2). 웹 정본에 검색 호출부가 없다(macOS/iOS가 소비) |
| `GET /v1/workspaces/{ws}/dms` | Rust 구현됨. 웹은 `GET …/channels`가 DM 행을 함께 주므로 별도 호출을 하지 않는다 |
| work-host 등록/해지/heartbeat · BYOC · cloud · reattach · terminal-attach/validate · credits topup · `POST …/agent-runs` · agent gateway 5종 | 데몬/에이전트/운영자 표면. 웹 클라 비소비 |

---

## 7. 도그푸딩 1차 — 지금 되는 것과 막힌 것

### 되는 것 (이 PR 이후)
로그인 → 세션 복원(refresh 회전) → **채널 목록** → 채널 진입 → 히스토리 · `?after=` 갭 힐 → 메시지 전송(멱등) → 읽음 커서 → **실시간 connection 토큰 발급 → `ch:` 구독 인가 → `message.new` 수신** → DM 열기 → 로그아웃(실시간 레일까지 절단).

### 남은 차단 (도그푸딩 범위를 좁히는 것)

| # | 차단 | 영향 | 해소 조건 |
|---|---|---|---|
| D-1 | `GET …/roster` 부재 | 타임라인·사이드바의 사람/에이전트 이름이 uuid 파생 라벨. "누가 말했는지"가 흐려짐 | roster 배치 |
| D-2 | 스레드(답글) 부재 | 답글 전송 400, 답글 조회 404. 스레드 패널 사용 불가 | 스레드 배치 |
| D-3 | 설정 라우트 전체 404 | AI 연결·체인·티어 정책·초대·워크스페이스 이름까지 전부 오류 상태 | 프로바이더/워크스페이스 배치 |
| D-4 | 승인·에이전트 허브·플러그인·워크스트림·메모리 404 | 해당 라우트 사용 불가 | 각 배치 |
| D-5 | 에이전트 실행 경로 미검증 | `POST …/agent-runs`는 있으나 웹은 그 표면을 부르지 않고, `GET` 계열이 전부 없음 | 에이전트 배치 |
| D-6 | `routing` 선택기 잠금 | §4.1. 정직한 상태이며 **고치면 안 됨** | `routing` 실제 구현 배치 |
| D-7 | 채널 생성 404 | 시드 채널 밖으로 못 나감 | 채널 쓰기 배치(작음) |

### 운영 전제(이 PR이 추가한 것)
`api` 서비스에 **`CENT_TOKEN_HMAC`과 `CENT_PROXY_SECRET`을 centrifugo와 동일한 값으로** 주입해야 한다(`infra/rust/docker-compose.rust.yml`에 반영). 둘 중 하나라도 없으면 레일은 **fail-closed**다 — connection 토큰 503, subscribe 콜백 401. staging/prod 환경명에서 `CENT_PROXY_SECRET`이 placeholder면 **부팅이 실패**한다(Swift `validateSecurityForBoot` 이식).

---

## 8. 검증

| 게이트 | 결과 |
|---|---|
| `cargo check --workspace --all-targets` | green |
| `cargo test --workspace` | 121(momo-server lib) 포함 전 패키지 green, 실패 0 |
| `cargo fmt --all -- --check` | clean |
| `cargo clippy --workspace --all-targets -- -D warnings` | warning 0 |
| route raw SQL | `grep -c 'sqlx::query' bins/momo-server/src/` = **0** |
| 새 마이그레이션 | 0 (`server/Migrations/*.sql` = 60, 변동 없음) |
| conformance smoke | `bins/momo-server/tests/client_rewire_smoke_pg.rs` — `#[ignore]` 2건(docker 미실행, 작성만) |

`client_rewire_smoke_pg.rs`는 **서버 표면이 아니라 클라이언트 시퀀스로** 구성돼 있다: 웹이 부르는 8개 호출을 부르는 순서 그대로 재생하고, 3단계에서는 **Centrifugo 역할을 직접 수행**한다(브로커의 HMAC 키로 connection 토큰을 검증 → `meta`를 꺼내 → proxy secret 헤더를 붙여 콜백). 마지막에 REST 절반과 실시간 절반을 **직접 접합**한다 — 전송이 쓴 `outbox` 행의 `payload.channel`이 3단계에서 인가한 Centrifugo 채널 문자열과 같아야 한다. 이 둘이 어긋나면 위의 모든 호출이 통과하면서 메시지는 영영 도착하지 않는다.

---

## 9. B4.1 재분류 — 도그푸딩 차단분 마감 (2026-07-31)

> 대상 `feat/B41-dogfood`(base `track/engine` @ `98c52194`). §1.2의 판정 기준을 그대로 쓰되, **①의 "도그푸딩 1차 시퀀스"를 실제 사용자 행동 순서로 확장**했다: 로그인 → **누가 있는지** → **방 만들기** → 대화(스레드 포함) → 읽음 → 실시간 → **설정 읽기**. B4가 "부팅해서 말할 수 있는가"를 닫았다면 B4.1은 "그 다음 한 시간을 보낼 수 있는가"를 닫는다.

### 9.1 마감한 표면 — 미구현 51 → 46

| # | 메서드 · 경로 | 원 분류 | 클라 호출부 | Rust 구현 |
|---|---|---|---|---|
| 1 | `GET /v1/workspaces/{ws}/roster` (+ `…/members` 별칭) | 워크스페이스·명부 (D-1) | `api.ts:784` `fetchRoster` | `momo_messaging::list_workspace_roster` + `routes/roster.rs` |
| 2 | `POST /v1/workspaces/{ws}/channels` | 채널 생성 (D-7) | `api.ts:750` `createChannel` | `momo_messaging::create_channel_detailed_in_tx` + `routes/channels.rs::create` |
| 3 | `POST …/channels/{ch}/messages` (`rootId` 동반) | 스레드·라우팅 (D-2) | `api.ts:1202` `sendThreadReply` | 기존 send 경로 + `validate_thread_root_in_tx` · `ThreadPolicy::Maintain` |
| 4 | `GET …/channels/{ch}/messages/{root}/replies` | 스레드·라우팅 (D-2) | `api.ts:1131` `fetchThreadReplies` | `momo_messaging::list_thread_replies` + `routes/messages.rs::replies` |
| 5 | `GET /v1/workspaces/{ws}` | 워크스페이스·명부 (D-3 일부) | `settings/api.ts:399` `fetchWorkspace` | `read_workspace_for_active_member` + `routes/workspaces.rs` |

**68쌍 밖 +1**: `PUT …/channels/{ch}/notification-pref`. 웹 정본은 이 경로를 부르지 않지만(그래서 68쌍에 없다) macOS·iOS가 부르고(`MomoServerRESTChatBackend.swift:684`, `MomoServerConversationClient.swift:189`), 무엇보다 **B4가 이미 발행하고 있는 `muted` 필드의 유일한 쓰기 지점**이다. 읽기만 있는 설정은 보여줄 수는 있어도 바꿀 수 없는 설정이다.

| 분류 | B4 | **B4.1** | 뜻 |
|---|---|---|---|
| 동일 | 14 | 14 | 변동 없음 |
| 서버측 마감(누계) | 3 | **8** | B4 3 + B4.1 5 |
| 미구현 표면 | 51 | **46** | 5쌍 감소 |
| UI 수정 필요 | 0 | **0** | B4.1도 클라 수정 요구 0건 — UI 파일 무접촉 |
| (68쌍 밖) 추가 마감 | — | **1** | `notification-pref`(mac/iOS 소비 + `muted`의 쓰기 반쪽) |

영역별 잔여: 초대 가입 1 · 워크스페이스·명부 **3**(`POST /v1/workspaces` · `GET·POST …/invites`) · 채널 생성 **0** · 스레드·라우팅 **1**(`routing`만) · 승인 2 · 워크스트림 3 · 에이전트 7 · 메모리 4 · 플러그인 6 · 허들 4 · 프로바이더·설정 15 = **46**.

### 9.2 §4.1 델타 — `routing` 프로브 판정이 `unknown` → `absent`로 바뀐다

§4.1이 기록한 `unknown` 판정은 **`rootId`가 먼저 거절당했기 때문에** 나온 값이었다. `rootId`를 서빙하는 순간 그 우연은 사라지고, 검사 순서가 **결정**이 된다:

- 만약 `routing` 거절을 먼저 답하면 → `400 "routing is not served by momo-server yet"` → `/routing/i` 매칭 → 판정 **`ready`** → 컴포저가 모델/강도 선택기를 열고, 그 선택기로 보낸 모든 전송이 400. **§4.1이 금지한 바로 그 거짓말이다.**
- 실제 구현: **존재하지 않는 root를 먼저 답한다** → `404 "thread root not found"` → 판정 **`absent`** → 선택기 미노출, 「다시 확인」 없음.

`absent`는 `unknown`보다 **정확하다**. 이 서버에는 routing 축이 없고, 「다시 확인」은 다시 확인해도 달라지지 않는다. 순서는 `routes/messages.rs::thread_root_then_routing`에 한 함수로 격리했고, `the_routing_probe_is_answered_by_the_root_not_by_routing`가 뒤집히면 red다. **`routing`을 실제로 구현하는 배치가 그 함수를 지운다.**

원칙으로 적으면: **대상 해석(404)이 기능 협상(400)보다 앞선다.** 없는 것에 대고 "그 기능은 지원 안 합니다"라고 답하지 않는다.

### 9.3 §7 D-표 갱신

| # | 차단 | B4.1 판정 |
|---|---|---|
| D-1 | roster 부재 | **해소.** 사람·에이전트 이름 복원(웹 `isRosterMember`가 요구하는 키 전량 발행) |
| D-2 | 스레드 부재 | **해소.** 답글 전송·조회·롤업(history 동승)·`thread.updated` 발행 |
| D-3 | 설정 전체 404 | **부분 해소.** 워크스페이스 이름/`updatedAtMs` 읽기 + 채널 음소거 쓰기는 열림. **AI 연결·체인·티어 정책·초대·워크스페이스 생성/이름변경은 여전히 404** |
| D-4 | 승인·에이전트 허브·플러그인·워크스트림·메모리 | 미변동 |
| D-5 | 에이전트 실행 경로 미검증 | 미변동 |
| D-6 | `routing` 선택기 | **표현이 바뀜**: 잠금+「다시 확인」 → 조용한 미노출(§9.2). 여전히 **고치면 안 됨** |
| D-7 | 채널 생성 404 | **해소.** 201/409/400, 생성자 `owner` 멤버십 동봉 |

### 9.4 도그푸딩 게이트 판정

> **판정: 도그푸딩 1차 시퀀스 차단분 = 0. 단, 코드상 판정이며 런타임 미검증(`runtime-unverified`).**

- **닫힌 시퀀스**: 로그인 → 세션 복원 → **명부(누가 있는지)** → 채널 목록 → **채널 생성** → 진입 → 히스토리 · 갭 힐 → 전송(멱등) → **스레드 왕복(답글 전송·조회·배지)** → 읽음 커서 → 실시간 토큰 → `ch:` 구독 인가 → `message.new`·`thread.updated` 수신 → DM → **설정 읽기(워크스페이스) · 음소거 토글** → 로그아웃(실시간 절단).
- **남은 것은 시퀀스 차단이 아니라 화면 부재다**: 46쌍(설정 15 · 에이전트 7 · 플러그인 6 · 메모리 4 · 허들 4 · 워크스트림 3 · 초대·명부 4 · 승인 2 · `routing` 1)은 각각 그 화면을 못 열게 하지만, 위 시퀀스를 막지는 않는다. **2차 도그푸딩(에이전트를 실제로 일 시키기)은 D-4/D-5가 열려야 한다.**
- **판정의 한계, 정직하게**: 이 배치의 검증은 `cargo check/test/fmt/clippy` + 구조 grep + `#[ignore]` conformance **작성**까지다. docker 스택을 띄운 실행은 하지 않았다(패킷 규율). 따라서 위 시퀀스는 **"서버 코드가 그 순서를 서빙하도록 쓰였다"**는 뜻이고, **"실제로 한 바퀴 돌았다"**는 뜻이 아니다. 후자는 아래 red 절차를 오케스트레이터가 돌려야 확정된다.

**red 절차(오케스트레이터, docker 필요)**
```bash
cd server-rust
DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
  cargo test -p momo-server --test client_rewire_smoke_pg -- --ignored --nocapture
```
- `the_dogfooding_sequence_round_trips` — 로그인→roster(`kind` 필터·`/members` 별칭 포함)→채널 생성(201/409/400)→routing 프로브 404 단정→스레드 왕복(2단 답글 400)→롤업 snake_case 단정→`thread.updated` outbox(no-`version`) 단정→워크스페이스 읽기→음소거 왕복+audit 2행+비멤버 403.
- `a_foreign_tenants_rows_are_zero_under_the_callers_guc` — 타 테넌트의 roster·channels·replies·rollup·workspace read가 **0행/NotFound**, 같은 질의가 소유 테넌트 GUC에서는 행을 찾는다(질의가 깨진 게 아니라 경계가 막은 것임을 증명).

---

## 10. B4.2 재분류 — 설정 표면 마감 (2026-08-02)

> 대상 `feat/B42-settings`(base `track/engine` @ `547e3000`). §1.2의 판정 기준을 그대로 쓰되, ①의 범위를 **"화면을 열 수 있는가"**로 옮겼다. B4는 "부팅해서 말할 수 있는가", B4.1은 "그 다음 한 시간을 보낼 수 있는가"를 닫았다. B4.2가 닫는 것은 **설정 화면 전체가 오류 상태로 열리던 D-3**이다.

### 10.1 마감한 표면 — 미구현 46 → 28

스코프는 취향이 아니라 §7의 D-3 한 줄이다: *"AI 연결·체인·티어 정책·초대·워크스페이스 이름까지 전부 오류 상태"*. 그 문장이 가리키는 미구현 쌍을 전수 실측하면 정확히 18쌍이고, 전부 이 배치에서 닫았다.

| # | 메서드 · 경로 | 원 분류 | 클라 호출부 | Rust 구현 |
|---|---|---|---|---|
| 1-3 | `GET·PUT·DELETE /v1/provider/link` | 프로바이더·설정 | `settings/api.ts:132,136,143` | `momo_settings::{read,upsert,delete}_link` + `routes/provider_link.rs` |
| 4 | `POST /v1/provider/link/test` | 프로바이더·설정 | `settings/api.ts:149` | `routes/provider_link.rs::test` — **부분**(§10.3) |
| 5-7 | `GET·PUT·DELETE /v1/provider/link/chain` | 프로바이더·설정 | `settings/api.ts:238,242,251` | `momo_settings::chain` + `routes/provider_link.rs::*_chain` |
| 8-9 | `GET·PUT /v1/provider/work-host-engine` | 프로바이더·설정 | `settings/api.ts:268,272` | `momo_settings::engine` + `routes/provider_settings.rs` |
| 10 | `GET /v1/provider/effort-table` | 프로바이더·설정 | `api.ts:1953` | `momo_agent::effort`(기존 표) 투영 + `routes/provider_settings.rs` |
| 11 | `GET /v1/provider/quota-snapshots` | 프로바이더·설정 | `settings/api.ts:504` | `momo_settings::quota` + `routes/provider_settings.rs` |
| 12-15 | `GET·PUT …/work-tier-policy[/me]` | 프로바이더·설정 | `settings/api.ts:312,324` | `momo_settings::tier` + `routes/work_tier_policy.rs` |
| 16-17 | `GET·POST /v1/workspaces/{ws}/invites` | 워크스페이스·명부 | `settings/api.ts:442,449` | `momo_settings::invite` + `routes/invites.rs` |
| 18 | `POST /v1/workspaces` | 워크스페이스·명부 | `settings/api.ts:389` | `momo_settings::workspace::create_workspace_in_tx` + `routes/workspaces.rs::create` |

| 분류 | B4 | B4.1 | **B4.2** | 뜻 |
|---|---|---|---|---|
| 동일 | 14 | 14 | 14 | 변동 없음 |
| 서버측 마감(누계) | 3 | 8 | **26** | B4 3 + B4.1 5 + B4.2 18 |
| 미구현 표면 | 51 | 46 | **28** | 18쌍 감소 |
| UI 수정 필요 | 0 | 0 | **0** | B4.2도 클라 수정 요구 0건 — UI 파일 무접촉 |
| (68쌍 밖) 추가 마감(누계) | — | 1 | **1** | `notification-pref`(변동 없음) |

영역별 잔여: 초대 **가입** 1(`POST /v1/join`) · 워크스페이스·명부 **0** · 스레드·라우팅 1(`routing`만) · 승인 2 · 워크스트림 3 · 에이전트 7 · 메모리 4 · 플러그인 6 · 허들 4 = **28**.

### 10.2 남은 미구현 28쌍의 **성격** — 수가 아니라 종류로

남은 것을 세 종류로 갈라 두는 이유는, "28"이라는 수가 이제 서로 다른 세 가지 사정을 한 칸에 담고 있기 때문이다.

| 성격 | 쌍 | 무엇이 막고 있나 | 열리는 조건 |
|---|---|---|---|
| **A. 화면 부재** — 서버에 라우트가 없고, 만들면 그만 | 22 (승인 2 · 워크스트림 3 · 메모리 4 · 플러그인 6 · 허들 4 · 에이전트 3(`agent-runs` 조회 계열)) | 아무것도. 배치가 안 왔을 뿐이다 | 각 배치 |
| **B. 실행 경로 결정 대기** — 라우트를 쓰면 *동작*을 정해야 한다 | 5 (`GET·PUT …/agents/{a}/profile` · `PUT …/agents/{a}/pause` · `GET …/agents/{a}/allowed-models` · `routing`) | 에이전트 실행 축(D-4/D-5)이 열려야 프로필·일시정지·모델 허용목록이 의미를 갖는다. `routing`은 §4.1/§9.2가 **고치면 안 된다**고 못 박은 그 항목 그대로다 | 에이전트 배치(D-4/D-5) |
| **C. 경계 결정 대기** — 서버 코드로는 못 닫는다 | 1 (`POST /v1/join`) | 공개(비인증) 표면이고, 성공 시 **세션 토큰 쌍을 발급**한다. 초대 코드 소비·멤버 생성·비밀번호 해시·온보딩 인사까지 한 트랜잭션이라, 초대 *발급*만 있는 지금 상태는 "만들 수는 있고 아직 쓸 수는 없는 링크"다 | 별도 배치(초대 소비). **이 배치가 만든 유일한 반쪽 문이며 §10.5에 이탈로 적었다** |

`POST /v1/provider/link/test`는 마감했지만 반쪽이 남았다 — 아래가 그 전부다.

### 10.3 `/v1/provider/link/test` — 닫은 것과, 닫을 수 없었던 것

Swift의 `probeHop`은 네 갈래로 답한다. 앞의 셋은 **네트워크가 필요 없는 설정 판정**이고, 이 서버가 그대로 답한다:

| 상태 | reason | disposition |
|---|---|---|
| 꺼둔 hop | `hop_disabled` | `skipped` |
| 목 모드 | `not_external_provider` | `propagate` |
| 주소/키 비어 있음 | `provider_not_configured` | `propagate` |
| **켜져 있고 외부이고 사용 가능** | Swift는 `GET {baseURL}/models`를 실제로 호출 | — |

네 번째만 소켓이 필요하고, **momo-server에는 HTTP 클라이언트가 없다**. 그것은 누락이 아니라 명시된 자세다(`bins/momo-server/Cargo.toml`: *"there is deliberately no HTTP client here"*, 불변식 #2). 클라이언트를 추가하는 것은 스택·경계 변경이라 **Accepted ADR 없이 worker가 할 수 없다**(CLAUDE.md 하드룰).

그래서 그 hop은 `ok:false` + `reason:"probe_not_run"`으로 답한다. 셋 중 가장 정직한 선택이기 때문이다:

- `provider_unreachable` → **거짓말**. 이 서버는 그 주소를 부른 적이 없다.
- `skipped` → 패널이 "꺼둠"으로 렌더한다(`chainModel.ts:612`). 켜 둔 hop을 운영자가 껐다고 말하는 셈이다.
- `probe_not_run` → 패널에 이미 있는 어휘이고 "확인이 끝나지 않았습니다"로 렌더된다(`chainModel.ts:probeReasonCopy`). 최상단 문장은 `providerTestMessage`의 기본 갈래를 타 "연결을 확인하지 못했습니다"가 된다. **일어난 일 그대로다.**

닫는 방법은 둘 중 하나이고 둘 다 이 배치 밖이다: ① 아웃바운드 프로브 클라이언트를 허용하는 ADR, 또는 ② ADR-0135 D2-A가 quota에 대해 이미 택한 길 — 자격증명을 쥔 쪽이 프로브하고 oort는 숫자만 받는 것. 후자가 ADR-0004와 결이 같다.

### 10.4 §9.2 델타 — effort-table을 서빙하면 `capability.ts`의 ② 판정이 뒤집힌다

`GET /v1/provider/effort-table`은 웹의 **effort 축 capability 프로브**다(`features/routing/capability.ts:14-17`: *"이 경로가 있으면 그 서버에는 effort 축이 올라가 있다"*). 404였을 때 판정은 `absent`였고, 이제 200이므로 `ready`가 된다. 그런데 그 축의 2층인 `GET·PUT …/agents/{a}/profile`은 이 서버에서 **여전히 404**다.

§4.1의 규율("고치는 게 아니라 거짓말이 되는 변경은 하지 않는다")에 걸리는지 **실측했다**. 걸리지 않는다 — 판정을 소비하는 두 곳 모두 프로필을 먼저 검사하기 때문이다:

- `MentionRoutingBar.tsx:148` — `profileFailed`(프로필 404)가 사유 체인의 **맨 앞**이다. 줄은 "이 에이전트의 프로필을 불러오지 못해 무엇이 적용될지 확인하지 못했습니다"로 잠긴 채 남고, `capability.support === "ready"`는 그 뒤로 밀린다.
- `AgentProfileDialog.tsx` — 프로필을 못 읽으면 다이얼로그가 열리지 않으므로, effort 선택기에 도달하는 경로가 없다.
- 메시지 한 건 오버라이드(③ tier)는 별도 프로브(`probeSendRouting`)를 쓰고, 그 판정은 §9.2대로 `absent` 그대로다.

즉 `ready`로 뒤집혀도 **열리는 선택기는 없다**. 그래도 이 사실을 여기 적어 두는 이유는, 에이전트 배치가 프로필을 열 때 effort 축이 이미 `ready`로 보고되고 있다는 전제에서 출발해야 하기 때문이다.

### 10.5 §7 D-표 갱신

| # | 차단 | B4.2 판정 |
|---|---|---|
| D-1 | roster 부재 | 해소(B4.1) |
| D-2 | 스레드 부재 | 해소(B4.1) |
| D-3 | 설정 라우트 전체 404 | **해소.** AI 연결·체인·확인(부분, §10.3)·코드 실행 호스트·추론 강도·구독 잔여량·티어 정책(2 스코프)·초대 발급/목록·워크스페이스 생성이 전부 열림. **남는 것은 초대 *가입*(`POST /v1/join`) 하나** |
| D-4 | 승인·에이전트 허브·플러그인·워크스트림·메모리 | 미변동 |
| D-5 | 에이전트 실행 경로 미검증 | 미변동 |
| D-6 | `routing` 선택기 | 미변동(§9.2). **여전히 고치면 안 됨** — §10.4가 그 판정을 건드리지 않았음을 실측으로 확인 |
| D-7 | 채널 생성 404 | 해소(B4.1) |

### 10.6 운영 전제(이 배치가 추가한 것)

| 키 | 없을 때 | 왜 그렇게 |
|---|---|---|
| `PROVIDER_LINK_MASTER_KEY` | `/v1/provider/link[…]` 6개가 **503** | 마이그레이션 039/042가 봉인한 AES-GCM 키다. 없으면 저장된 ciphertext를 열 수도, 새로 봉인할 수도 없다. 200을 답하려면 bearer 상태를 **지어내야** 한다 |
| `PLATFORM_ADMIN_EMAILS` | 인스턴스-전역 표면(provider link 6 + `POST /v1/workspaces`)이 `platform:read` 토큰에만 열림 | MOMO-583: 임의의 워크스페이스 owner는 인스턴스 운영자가 아니다. 비어 있는 허용목록은 **아무에게도** 권한을 주지 않는다 |
| (부팅) `PROVIDER_LINK_MASTER_KEY` == `JWT_HMAC` 또는 == `OUTBOUND_WEBHOOK_MASTER_KEY` | **부팅 실패** | 재사용하면 provider bearer 유출이 곧 토큰 서명 유출이 된다. 키 *부재*는 표면을 닫을 뿐이지만, 키 *재사용*은 침묵하는 결함이라 부팅에서 막는다 |

### 10.7 검증

| 게이트 | 결과 |
|---|---|
| `cargo check --workspace --all-targets` | green |
| `cargo test --workspace` | 392 passed / 0 failed / 46 ignored (momo-server lib 146, momo-settings 38) |
| `cargo fmt --all -- --check` | clean |
| `cargo clippy --workspace --all-targets -- -D warnings` | warning 0 |
| route raw SQL | `grep -c 'sqlx::query' bins/momo-server/src/` = **0** |
| 신규 route의 `emit_outbox`·Centrifugo·HTTP 클라이언트 | **0** |
| `set_config('app.workspace_id'` 세터 | `crates/momo-db/src/tenant.rs` **단독**(신규 `rebind_tenant_guc` 포함) |
| 새 마이그레이션 | 0 (`server/Migrations/*.sql` = 60, 변동 없음) |
| UI 파일 | 무접촉(`clients/**` diff 0) |
| Dockerfile 매니페스트 목록 | 신규 crate `momo-settings` 추가 — crates/bins 목록 == 실제 디렉터리 목록 |
| conformance smoke | `bins/momo-server/tests/settings_conformance_pg.rs` — `#[ignore]` 2건(docker 미실행, 작성만) |

`settings_conformance_pg.rs`도 **클라이언트 시퀀스로** 구성돼 있다: `SettingsRoute.tsx`가 여는 패널 순서대로 11단계를 재생하고, 마지막에 단일 호출로는 보이지 않는 세 가지를 직접 접합한다 — ① PUT이 저장한 bearer가 GET에 4자 tail로만 돌아오고 저장된 `bytea`·audit `detail` 어디에도 평문이 없다, ② 설정 쓰기 전후로 `outbox` 행 수가 **변하지 않는다**(설정은 타임라인 사건이 아니다), ③ 타 테넌트 GUC에서 같은 질의가 0행이고 **같은 질의가 소유 테넌트 GUC에서는 행을 찾는다**(0이 정책 때문이지 질의가 깨져서가 아님을 증명).

**red 절차(오케스트레이터, docker 필요)**
```bash
cd server-rust
DATABASE_URL=postgres://momo:momo@localhost:15432/momo \
  cargo test -p momo-server --test settings_conformance_pg -- --ignored --nocapture
```
- `the_settings_panels_read_and_write_round_trip` — 로그인→워크스페이스 읽기→provider link(env→저장→재읽기→삭제)→체인(position 0 거절·replace-all·bearer 유지 park)→확인 프로브(`probe_not_run` 단정)→work-host-engine(읽기가 행을 만들지 않음·미지 라벨 400)→effort-table→quota→티어 정책(default·`/me` 상속·autoTarget 교차검증 400)→초대(코드 1회성·목록에 코드 부재)→워크스페이스 생성(201·owner+#general+`channel_seq`·중복 slug 409)→outbox 불변·audit 5종·audit 무-평문.
- `a_foreign_tenants_settings_rows_are_zero_under_the_callers_guc` — 타 테넌트 GUC에서 `work_host_engine`·`work_tier_policy`·`invite_code` 0행 / 소유 테넌트 GUC에서 발견, 그리고 `provider_link`는 **자기 워크스페이스에서도** 일반 테넌트 트랜잭션이 0행(GUC 게이트) · 운영자 트랜잭션에서만 보임 · 다른 마스터키로는 열리지 않음.

### 10.8 이탈 (deviation)

| # | 이탈 | 판정 |
|---|---|---|
| 1 | `POST /v1/provider/link/test`의 **라이브 프로브 미구현** | §10.3. 불변식 #2의 "HTTP 클라이언트 없음" 자세를 깨는 것은 ADR 사안이라 worker가 하지 않았다. 마감은 했으되 **부분**으로 분류 |
| 2 | 초대 **발급**만 열고 **가입**(`POST /v1/join`)은 열지 않음 | 패킷 스코프(§1 "초대")를 좁게 읽었다. 결과적으로 "만들 수는 있고 아직 쓸 수는 없는 링크"가 생겼다 — §10.2 C가 그 상태를 명시한다. `/v1/join`은 공개 표면 + 세션 토큰 발급 + 멤버 생성이라 별도 배치가 옳다는 판단이지만, **half-open door이므로 이탈로 기록한다** |
| 3 | 신규 crate `momo-settings` 추가 | 패킷이 예고한 경우(Dockerfile 매니페스트 갱신 필수)에 해당. 매니페스트 목록 == 디렉터리 목록으로 검증 |
| 4 | `momo_db::rebind_tenant_guc` 신설 | 워크스페이스 프로비저닝은 한 트랜잭션 안에서 두 테넌트 스코프가 필요하다(운영자 권한 읽기 → 신규 테넌트 시드). GUC 세터를 `momo-db` 밖으로 내보내지 않기 위해 헬퍼를 그 파일에 추가했다 — 불변식 #6의 grep 단일성 유지 |
| 5 | `momo_db::AuditEntry::about_optional` 신설 | 티어 정책 한 write가 두 스코프를 서빙한다. 워크스페이스 기본행의 `subject_member_id`는 NULL이어야 하는데 `by()`가 넣은 값을 지울 방법이 없었다 |
