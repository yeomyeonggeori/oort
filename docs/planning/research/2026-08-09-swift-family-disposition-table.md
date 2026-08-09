# 11패밀리 + agentRunHistory — 처분 판정표 (판정 칸 공백)

- 작성: 2026-08-09 · 무명 단발 워커 · **코드 변경 0 · 문서만**
- 패킷: `docs/planning/handoffs/2026-08-09-swift-removal-rebaseline-packet.md` T-C
- **실측 기준: `origin/track/engine` = `4427756a`** (main `6e19ddbc`보다 36커밋 앞선 상태. 근거는 `2026-08-09-swift-removal-audit.md` §11-A)
- 대상: ADR-0145 증보 1 "판정 보류" 13패밀리 중 **미이식 11** + **agentRunHistory**(증보 1의 마지막 잔여 "이식 대상"). 보류 13 중 work-controls·work-auto-approvals 둘은 이식 완료라 제외했다(§부록 A).

> **이 표는 판정이 아니라 판정의 입력이다.** 「판정」 칸은 **성재의 자리**이므로 비워 두었다. 워커·오케스트레이터가 채우면 그 순간 이 표는 버려진다.
>
> **2026-08-09 갱신: 판정이 내려졌다** — 성재가 채팅에서 4개 결정을 승인(폐기 3·이식 확정 3·이월 5+종속 1·OutboxRelay=Rust 이식 후 삭제), Fable이 기록. 상세는 §3.
>
> (a)(b)는 전부 이 문서가 직접 잰 값이고, (c)는 그 두 칸에서 따라 나오는 서술이다. (a)가 "없음"이라고 해서 폐기가 정해지는 것이 아니다 — 아래 **(b)가 있는데 (a)가 없는 줄**은 "폐기 후보"가 아니라 **"클라가 이미 기다리고 있는 미이식"**이라는 정반대 뜻이기 때문이다.

---

## 0. 읽는 법 — 이 레포에는 이미 같은 판정표가 하나 있다

`packages/momo-core/src/features/capabilities/serverSurfaces.ts`는 **클라이언트가 자기 손으로 잰 서버 표면 판정표**다(`:111-206`). 그 파일 머리말이 이 표와 같은 문제를 적는다 — *"이 클라이언트는 Swift 서버의 계약을 보고 자랐고, 지금 이야기하는 상대는 그 계약의 일부만 이식한 Rust 서버다"*(`:5-7`).

그래서 아래 (b) 칸에는 **호출부가 실재하는데 화면이 꺼져 있는** 줄이 여럿 있다. 그 줄들의 정확한 상태는 "클라 없음"이 아니라 **"클라 있음 + `provided: false`로 접힘"**이다. 폐기 판정은 그 코드까지 함께 지우는 결정이 된다.

---

## 1. 판정표

| # | 패밀리 | (a) Rust 서버에 있나 | (b) 웹/RN 클라가 부르나 | (c) 폐기하면 사용자 눈에서 사라지는 것 | 판정 |
|---|---|---|---|---|---|
| 1 | **plugins** (+grants·install) | **없음.** `lib.rs` 라우터 전수에 `/plugins` 0. 유일 언급은 스코프 이름 문자열 (`server-rust/crates/momo-auth/src/agent_scope.rs:17`) | **있음(웹).** core 6경로 — `packages/momo-core/src/lib/api.ts:1266`·`:1273`·`:1279`·`:1286`·`:1297`·`:1308` / UI `clients/web/src/features/plugins/PluginSection.tsx`, 마운트 `features/settings/SettingsRoute.tsx:273`. **RN 0** | 설정 > **「앱」** 탭 전체(플러그인 카탈로그·설치·권한 부여/회수). 에이전트 허브의 "설정의 앱에서 권한 보기" 링크(`AgentHubRoute.tsx:1013`)가 갈 곳을 잃는다 | **이월** — v1 범위 결정 |
| 2 | **webhooks** (인바운드 설치 4연산) | **관리 REST 없음 / 송신 배관은 있으나 소비자가 Swift.** 라우터에 `/webhooks`·`/hooks` 0. outbox에 종류만 정의(`crates/momo-outbox/src/emit.rs:40`·`:50` `WebhookDelivery`), **소비자는 Rust에 없다** — `crates/momo-outbox/src/relay.rs:82`·`bins/momo-relay/src/lib.rs:23`이 *broadcast only, `webhook_delivery`는 여기서 빼지 말 것*이라고 명시. 실제 송신자 = **Swift** `relay/OutboxRelay/Sources/OutboxRelay/WebhookDeliveryClient.swift` | **있음(웹, 2026-08-09 신규).** core `packages/momo-core/src/features/webhooks/api.ts:6-9`(4연산)·`:62` / UI `clients/web/src/features/settings/WebhookSection.tsx`(605줄) + `features/settings/webhookCredentialScope.ts`. **RN 0** | 설정 > **웹훅** 섹션(설치 목록·생성·시크릿 회전·폐기, "한 번만 보이는 값"). 외부 시스템이 oort로 메시지를 밀어 넣는 유일한 설정 표면 | **이식 확정** — T13(#1222) |
| 3 | **mcp** (inbound·drive) | **없음.** 라우터에 `/mcp` 0. 언급은 스코프 문자열뿐(`momo-auth/src/agent_scope.rs:17` `/v1/mcp/drive`) | **없음(직접 호출 0).** 클라의 `mcp`는 전부 **플러그인 매니페스트의 필드**일 뿐 — `packages/momo-core/src/lib/api.ts:1227`·`:1229`, `clients/web/src/features/plugins/model.ts` | 사용자 눈에 직접 보이는 표면 없음. 다만 plugins(#1)의 매니페스트가 `mcp.tools`/`mcp.url`을 서술하므로, plugins를 살릴 경우 이 패밀리는 그 계약의 뒷면으로 따라온다 | **plugins에 종속 — 이월** |
| 4 | **memories** (+policy·consent) | **없음.** 라우터에 `/memories` 0. Rust가 스스로 미이식을 적음 — `crates/momo-agent/src/mention.rs:530` *"the memory plane is not ported"* | **있음(웹).** core 4함수 — `api.ts:3234`/`:3246`, `:3250`/`:3264`, `:3268`/`:3275`, `:3283`/`:3290` / UI `clients/web/src/features/agentHub/AgentHubRoute.tsx:1338`. RN은 문구만(`clients/mobile/src` 6건, 호출 0) | 에이전트 허브의 **기억 브라우저**(목록·검색·무효화·공개범위 grant). 사용자가 에이전트에게 "무엇을 기억하고 있냐"를 묻고 지울 수 있는 유일한 자리 | **이월** — v1 범위 결정 |
| 5 | **huddles** (+recordings·consent) | **없음.** 라우터에 `/huddles` 0. `crates/momo-messaging/src/lib.rs:45`가 *"Deliberately **still out of scope**: huddle …"* | **있음(웹).** core 5경로 — `api.ts:427`·`:440`·`:454`·`:493`·`:519` / UI `clients/web/src/features/huddles/*`, 마운트 `features/chat/ChatShell.tsx:710`·`:754`·`:784`. **RN 0(주석 2건뿐)** | 채널 헤더의 **음성 허들** 컨트롤·배너·참가/나가기 전체(LiveKit). 텍스트 외 실시간 대화 수단이 제품에서 없어진다 | **이월** — v1 범위 결정(랜딩 시 CSP connect-src 갱신 필수) |
| 6 | **workstreams** | **없음(REST).** 라우터에 `/workstreams` 0. 단 **DB·엔진 층은 살아 있다** — `crates/momo-t3/src/lifecycle.rs:197`·`:205`(`work_session_attach_workstream_trg`가 삽입 시 스레드의 workstream을 붙임)·`:335`, `bins/momo-server/src/routes/work_sessions.rs:702`(ADR-0143 D2/D3 연속성) | **있음(웹).** core 3경로 — `api.ts:2413`·`:2428`·`:2442` / 라우트 `clients/web/src/app/App.tsx:125-140`, 사이드바 `features/sidebar/Sidebar.tsx:392`, 상세 링크 `features/work/WorkSessionDetail.tsx:785`. **RN 0** | 사이드바 **「작업 흐름」** 줄과 그 목록/상세 화면. 작업 세션들이 하나의 목표로 묶여 보이던 자리가 사라진다(세션 자체는 남음) | **이월** — v1 범위 결정 |
| 7 | **event-subscriptions** (아웃바운드 4연산) | **관리 REST 없음 / 감사·전송 층은 있음.** 라우터에 `/event-subscriptions` 0. DB는 이식됨 — `server/Migrations/033_event_subscription.sql`, **신규** `063_event_subscription_delivery_audit.sql`(2026-08-09). 전송은 #2와 같은 Swift OutboxRelay 경로 | **있음(웹, 2026-08-09 신규).** core `packages/momo-core/src/features/settings/eventSubscriptions.ts:465`(4연산) / UI `clients/web/src/features/settings/EventSubscriptionSection.tsx`(572줄), 마운트 `SettingsRoute.tsx`. **RN 0** | 설정 > **이벤트 구독** 섹션(구독 생성·활성/비활성·삭제, "나가는 것을 이름으로 말한다"). oort에서 외부로 나가는 이벤트를 사람이 통제하는 유일한 표면 | **이식 확정** — T13(#1222) |
| 8 | **work-tool-profiles** | **조회 REST 없음 / 테이블은 Rust가 읽는다.** `GET …/work-tool-profiles`는 Rust가 스스로 "still-unported five"에 열거(`bins/momo-server/src/work_host_auth.rs:22-25`). 내부 조인은 실재 — `crates/momo-t3/src/lifecycle.rs:686`, `crates/momo-t3/src/work_control.rs:1070`·`:1096` | **없음.** 웹·RN·core 전수 grep 0 | 사용자 표면 없음(현재 어느 클라도 부르지 않는다). 폐기해도 눈에 보이는 변화 0이나, **엔진이 그 테이블에 의존해 도구 승인을 판단**하므로 "패밀리 폐기"가 곧 "테이블 폐기"는 아니다 | **폐기**(REST 스펙만 — 테이블·엔진 조인 존치) |
| 9 | **bans** | **없음.** 라우터에 `/bans` 0 (`ban` 문자열 히트는 전부 `bandwidth`/`banner` 등 무관) | **없음.** 웹·RN·core 전수 grep 0 | 사용자 표면 없음(웹/RN에 밴 UI가 아예 없다). macOS `IOSMembershipAdministration`/`MemberLifecycle` 계열에만 있던 관리 기능 | **폐기**(필요 시 새 설계로) |
| 10 | **members 잔여** (워크스페이스 멤버 라이프사이클) | **부분.** 있는 것 = 로스터 읽기 `lib.rs:421`(`/roster`)·`:422`(`/members`), 채널 멤버 `:411`·`:415`. 없는 것 = 워크스페이스 멤버 초대후 역할변경·정지·추방 등 라이프사이클 | **거의 없음.** 로스터/디렉터리는 부름. 라이프사이클 호출부는 core에 채널 멤버 제거 1건뿐(`api.ts:919` `DELETE …/channels/{ch}/members/{member}`) — 워크스페이스 수준 0 | 멤버 **디렉터리는 남는다**(로스터는 Rust에 있음). 사라지는 것은 워크스페이스 수준 멤버 관리 행위(역할 변경·내보내기) — 현재 웹/RN에 그 버튼이 없으므로 **오늘 기준 눈에 보이는 손실 0** | **이월** — v1 범위 결정 |
| 11 | **platform** (admin 3경로) | **없음.** 라우터에 `/v1/platform` 0 (있는 admin은 `/v1/admin/workspaces/{ws}/credits/topups` `lib.rs:607` 하나) | **없음.** 웹·RN·core 전수 grep 0. 검증기만 존재(`scripts/verify_platform_admin.sh`) | 사용자 표면 없음. 운영자 전용 경로이며 현재 어느 클라도 부르지 않는다 | **폐기**(`verify_platform_admin.sh` 동반 정리) |
| 12 | **agentRunHistory** (읽기 3경로) | **쓰기 있음 / 읽기 없음.** 쓰기 `lib.rs:613` `POST …/channels/{ch}/agent-runs` · 게이트웨이 events/complete(`:660`·`:664`) · 취소 `:621`. 읽기 3경로는 미이식 — `GET …/channels/{ch}/agent-runs`는 경로가 POST 전용이라 **405**, `GET …/agents/{id}/runs`·`GET …/agent-runs/{id}`는 404 | **있음(웹·RN 둘 다).** 웹 `clients/web/src/features/inbox/useInbox.ts:424-425`·`features/inbox/InboxRoute.tsx:155`·`:238`·`features/agentHub/AgentHubRoute.tsx:1472`·`:1546` / **RN** `clients/mobile/src/features/inbox/useInbox.ts:372`·`:209`·`screens/InboxScreen.tsx:115`·`:172` | 에이전트 허브 **「이력」** 탭과 받은함의 작업 기록 투영. **기록 자체는 지금도 쌓인다** — 사라지는 것은 "본다"뿐이다(`serverSurfaces.ts:161-174`가 같은 취지를 명시) | **이식 확정** — 읽기 3경로(#1223) |

---

## 2. (a)(b) 모두 "없음"인 패밀리 — 폐기 유력 **후보**(판정 아님)

아래 셋만이 **서버에도 없고 어떤 클라도 부르지 않는다.** 즉 오늘 폐기해도 사용자 눈에서 사라지는 것이 0인 줄이다.

| 패밀리 | (a) | (b) | 폐기해도 0인 이유 | 단서 |
|---|---|---|---|---|
| **work-tool-profiles** | 없음(REST) | 없음 | 조회 REST를 부르는 클라가 없다 | ⚠ **테이블은 엔진이 쓴다**(`momo-t3/src/lifecycle.rs:686`, `work_control.rs:1070`). "REST 패밀리 폐기" ≠ "테이블 폐기" |
| **bans** | 없음 | 없음 | 웹/RN에 밴 UI가 아예 없다 | ⚠ 멤버 관리(#10)와 한 몸이라 따로 판정하면 반쪽이 될 수 있다 |
| **platform** | 없음 | 없음 | 운영자 전용, 클라 호출 0 | ⚠ `scripts/verify_platform_admin.sh`가 남아 있어 삭제 시 동반 정리 필요 |

**준후보 1건** — **mcp**: (a) 없음, (b) 직접 호출은 0이지만 플러그인 매니페스트 필드로 간접 소비된다(`api.ts:1227`). plugins 판정에 종속되므로 단독 폐기 판정이 어렵다.

> 나머지 8패밀리(plugins·webhooks·memories·huddles·workstreams·event-subscriptions·members 잔여·agentRunHistory)는 **(b)가 살아 있다.** 이들에 대한 "폐기"는 미사용 코드 제거가 아니라 **이미 작성돼 배포된 클라이언트 표면을 함께 걷어내는 결정**이다. 특히 webhooks·event-subscriptions 두 표면은 **2026-08-09에 방금 랜딩했다**(`9a6feea2`·`33930f94`).

---

## 3. 판정 기록 (2026-08-09 · 성재 채팅 승인 · Fable 기록)

성재가 4개 결정을 내렸다. 위 표의 「판정」 칸은 이 결정의 기록이다.

| 결정 | 내용 |
|---|---|
| **폐기 3** | `work-tool-profiles`(REST 스펙만 — 테이블·T3 엔진 조인은 존치) · `bans`(필요해지면 새 설계) · `platform`(`verify_platform_admin.sh` 동반 정리). 집행은 W-S 삭제 배치에 편입 |
| **이식 확정 3** | `webhooks`·`event-subscriptions` → **#1222**(T13: 관리 REST 8연산+송신 소비자 — 라이브에 송신자가 없다는 실측 포함) · `agentRunHistory` → **#1223**(읽기 3경로+표면 켜기) |
| **이월 5 + 종속 1** | `plugins`·`memories`·`huddles`·`workstreams`·`members 잔여` = v1 범위 결정으로 이월(폐기 아님 — 클라 표면 보존) · `mcp` = plugins 판정에 종속 |
| **OutboxRelay** | **Rust 이식 후 Swift 삭제**(#1222 완료가 삭제 조건). "Swift 영구 존치" 목록에 넣지 않는다. 감사의 5-A 분류는 #1222 랜딩 전까지 5-C |

이로써 증보 1 판정표의 "보류 13"은 전부 상태를 얻었다: 이식 완료 2(work-controls·work-auto-approvals) · 폐기 3 · 이식 확정 2(+agentRunHistory) · 이월 5 · 종속 1. **W-S(삭제 1단계) 발사의 판정 선행조건이 닫혔다** — 남은 선행은 감사 §6 순서와 W-S 패킷뿐.

---

## 부록 A. 보류 13 → 11: 빠진 둘의 실측

ADR-0145 증보 1의 "판정 보류(v1 결정 대기)" 13패밀리 중 둘은 이미 Rust에 섰다. 이 표가 11만 다루는 이유다.

| 패밀리 | 상태 | 근거 (origin/track/engine) |
|---|---|---|
| work-controls | **이식 완료** | `server-rust/bins/momo-server/src/lib.rs:579`(`POST …/work-controls`)·`:583`(`…/{control}/ack`) / 구현 `routes/work_controls.rs:6-10` |
| work-auto-approvals | **이식 완료** | `lib.rs:587`(`GET …/work-auto-approvals`)·`:591-593`(`PUT`/`DELETE …/{tool}`) |

## 부록 B. 측정 방법 (재현 가능하게)

```sh
# 기준
git rev-parse origin/track/engine                 # 4427756a
git rev-list --left-right --count origin/main...origin/track/engine   # 1  36

# (a) Rust 라우트 전수
grep -n '"/v1\|"/healthz' server-rust/bins/momo-server/src/lib.rs
grep -oE '\b(get|post|put|patch|delete)\(routes::' \
  server-rust/bins/momo-server/src/lib.rs | wc -l        # 97 (메서드 핸들러 수)

# (b) 클라 호출부
grep -rnoE '"/v1[^"]*"|`/v1[^`]*`' packages/momo-core/src clients/web/src
grep -rniE '<family>' clients/web/src clients/mobile/src packages/momo-core/src
```

**주의 1** — 패밀리 이름을 부분문자열로 grep하면 거짓 양성이 크다(`ban`→`banner`/`bandwidth`, `platform`→일반 명사, `memor`→주석의 "memory"). 위 표의 "없음"은 전부 **경로 문자열**(`/bans`, `/v1/platform`, `/memories`)로 다시 확인한 값이다.

**주의 2** — (b)의 "있음"은 *호출 코드가 실재한다*는 뜻이지 *지금 화면이 켜져 있다*는 뜻이 아니다. plugins·memories·huddles·workstreams·agentRunHistory 다섯은 `serverSurfaces.ts`의 `provided: false`로 진입점이 접혀 있다(각각 `:179`·`:188`·`:150`·`:115`·`:160`). webhooks·event-subscriptions 둘은 그 표에 아직 줄이 없다.
