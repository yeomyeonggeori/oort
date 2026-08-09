# Swift 트리 삭제 전 의존 감사 (워커 R) — 판정

- 실행: 2026-08-09 · 무명 단발 Opus · **삭제·수정·커밋 0건**(읽기 전용 워크트리 `scratchpad/swiftaudit-wt`)
- 패킷: `docs/planning/handoffs/2026-08-09-swift-removal-packet.md` 워커 R 절
- **한 줄 판정: 지금 Swift 트리를 통째로 삭제하면 제품이 깨진다. 부분 삭제만 가능하다.**

---

## 0. 기준 정정 (먼저 읽을 것)

**패킷의 "기준 = `origin/track/engine` 최신"은 이 감사에서 `origin/main`으로 바꿨다.**

- `git merge-base --is-ancestor origin/track/engine origin/main` → **참**. `git rev-list --left-right --count origin/main...origin/track/engine` = `179 0` — track/engine은 main의 진부분집합이다(engine-only 커밋 0).
- 그리고 **track/engine에는 ADR-0145 증보 2가 없다**(`docs/adr/0145-server-stack-buzz-fork-rust.md` — engine 판본에는 `## 증보 2` 헤딩 부재, main 판본 `:159`에 존재). 패킷이 정본으로 지목한 문서가 패킷이 지정한 기준 브랜치에 없다.
- 따라서 아래 모든 file:line 근거는 **`origin/main` = `8b9a898d`** 기준이다.

### 0-1. 【Blocker】 삭제 게이트 자체가 main에서 유실됐다

ADR-0145 증보 2 마지막 문장(`docs/adr/0145-…md:163`)은 이렇게 끝난다:

> 삭제 실행 조건(**위 판정표**)은 불변 — 이 증보는 삭제가 아니라 반복 비용 제거다.

**그 "위 판정표"가 현재 main의 ADR-0145에 없다.** 실측:

- 현재 main ADR-0145의 `##` 헤딩 전수: 결정 / 스파이크 판정 / 근거 / Consequences / 이행 / 미해결 / B-0~B-3 / **증보 2**. `증보 1` 없음(`grep -c "증보"` = 2, 둘 다 증보 2 본문).
- 증보 1은 커밋 `8cc330e0`에서 추가돼 `06677ee3`("0145 판정표 갱신 — attachments·cancel 이식 완료, 잔여=agentRunHistory")까지 살아 있었다.
- **소실 지점 = 머지 커밋 `a749d765`** (2026-08-09 "merge: track/engine → main 동기화"). 그 커밋 메시지가 자백한다: *"충돌 해소 3: … 0145=engine(oort화)+**증보 2 이식**"* — engine 측(증보 없음)을 취하고 증보 2만 되붙였고, 증보 1은 함께 오지 않았다.
- 다른 ADR이 그 표를 정본으로 인용 중이다: `docs/adr/0151-attachments-v0-drive-contract-port.md:5`·`:22` ("ADR-0145 증보 1 판정표의 attachments 행이 닫힌다").

`06677ee3`에서 복원한 증보 1 원문(요지):

| 판정 | 패밀리 |
|---|---|
| **이식 대상(v0)** | ~~attachments 3경로~~(완료 #1119) · ~~agent-run cancel~~(완료 #993) · **agentRunHistory 읽기 경로(잔여)** |
| **판정 보류(v1 결정 대기)** | plugins · webhooks · mcp · memories(+policy·consent) · huddles · workstreams · work-controls · work-auto-approvals · event-subscriptions · work-tool-profiles · bans · members 잔여 · platform |
| **폐기 후보** | `__momo_stub` · context-packets v0 형태 |

> **삭제 실행 조건**: "이식 대상 + 보류에서 이식으로 승격된 것"이 전부 Rust에 서고, **보류·폐기 판정이 전 패밀리에 대해 내려졌을 때.**

**판정: 삭제 실행 조건은 아직 충족되지 않았다.** 보류 13패밀리 중 Rust에 선 것은 work-controls·work-auto-approvals 둘뿐이고(§3-1), 나머지 11패밀리에 대한 성재 판정(보류→이식 or 폐기)이 내려진 적이 없다. **W-S 발사 전에 ① 증보 1 복원 ② 11패밀리 판정 — 두 가지가 선행돼야 한다. 이건 오케스트레이터가 아니라 성재의 자리다.**

---

## 1. 인벤토리 (실측, main)

Swift 파일 **455개 / 183,178 LOC**(`git ls-files '*.swift' | xargs wc -l`).
패킷의 "584파일"은 트리 하위 전체 파일(스냅샷 PNG·xcodeproj·Info.plist 포함) 기준으로 보이며, 트리별 총 파일 수는 아래와 같다.

| 트리 | 전체 파일 | .swift | Rust 대체물 | 라이브? |
|---|---|---|---|---|
| `server/Sources` | 92 | 92 | `server-rust/bins/momo-server` | ❌ (Rust가 서빙) |
| `server/Tests` | 17 | 17 | `server-rust/bins/momo-server/tests/*` (21파일) | ❌ |
| `server/Package.swift` | 1 | 1 | — | ❌ |
| `server/Migrations` | **62** | 0 | **없음 — 원본 그 자체** | ✅ **라이브 (삭제 절대 금지)** |
| `server/Fixtures`·`README`·`.gitkeep` | 6 | 0 | — | ⚠ 확인 필요(§2-6) |
| `clients/macOS` | 327 | 165 | `clients/web`+`clients/desktop` | ❌ (검수 표면 아님) |
| `clients/iOS` | 50 | 36 | `clients/mobile`(RN) | ❌ |
| `clients/Core` | 30 | 29 | `packages/momo-core`(TS) | ❌ |
| `services/OutboundHTTPPolicy` | 3 | 3 | Rust 내장 | ❌ |
| `services/CloudProviderKit` | 9 | 9 | `server-rust/crates/momo-t3/src/provider/*` | ❌ |
| `services/LinkShort` | 7 | 6 | **없음** — 무상태 리다이렉터 | ⚠ 셀프호스트 이미지에 배선(§2-3) |
| `services/MomoMetrics` | 5 | 5 | **없음** | ✅ **라이브** (PushRelay 의존) |
| `relay/OutboxRelay` | 8 | 8 | `bins/momo-relay` | ❌ |
| `relay/PushRelay` | 10 | 8 | **없음** | ✅ **라이브 — 유일한 APNs 경계** |
| `workers/AgentWorker` | 27 | 27 | `bins/momo-agent-worker` | ❌ |
| `workers/NotifierWorker` | 11 | 11 | `bins/momo-notifier` | ❌ |
| `workers/WorkHostDaemon` | 31 | 29 | **없음** | ✅ **라이브 — 현행 배치의 종착점** |

**패킷 범위 밖이지만 Swift인 것(삭제 대상 아님, 오분류 방지)**
`clients/mobile/ios/**`(7 .swift — RN 자체 네이티브 모듈·NSE, `clients/mobile/ios/MomoPushKit/PushNotification.swift:14-16`이 *MomoCore 의존 거부*를 명시) · `clients/mobile-spike/ios/…AppDelegate.swift` · `scripts/generate_ios_app_icon.swift` · `clients/iOS/Tools/GenerateBrandAssets.swift`.

---

## 2. 참조 그래프 — ①죽은 참조 ②이관 완료 ③아직 Swift만 하는 일

### 2-1. 【③ 아직 Swift만 하는 일】 `relay/PushRelay` + `services/MomoMetrics` — **삭제 불가**

- `infra/rust/docker-compose.push.yml:47`, `:63` — Rust 배포 스택의 `push-relay` 서비스. 이미지 `${MOMO_PUSH_RELAY_IMAGE:-momo-push-relay:dev}`.
- `infra/rust/docker-compose.push.build.yml:27-30` — `dockerfile: relay/PushRelay/Dockerfile`, context = 레포 루트.
- `relay/PushRelay/Dockerfile:34-56` — `swift:6.2-noble`로 `PushRelay` 빌드. **`services/MomoMetrics`를 경로 의존으로 함께 복사**(`:47`, `relay/PushRelay/Package.swift:12`).
- `server-rust/crates/momo-push/src/lib.rs:26-30`이 못 박는다: *"**No APNs.** Contacting Apple is the relay's job and its key. There is no `.p8` in this repo, this crate, or this server."*
- 런북 `docs/cicd/12-push-relay-deploy-runbook.md:3-11` — ADR-0120 D1-A상 셀프호스트 서버는 Apple과 계약 불가라 **relay가 구조적 필연**. 이 조각이 없으면 푸시가 한 발도 안 나간다.

**판정: Rust에 대체물이 없다. Swift PushRelay를 지우면 iOS/RN 푸시 종단 경로가 끊긴다.**

### 2-2. 【③】 `workers/WorkHostDaemon` (momo-workd) — **삭제 불가 · 현행 배치의 종착점**

- `infra/prod/docker/workhost.Dockerfile:31-38` — 사이드카 이미지가 `momo-workd`를 굽는다(opencode/goose와 같은 이미지).
- `infra/prod/docker-compose.prod.yml:485` `workhost` 서비스 · `infra/workd/{bootstrap.sh:73,momo-workd.service,app.momo.workd.plist}` — 사용자 호스트 설치 경로.
- **가장 결정적**: 방금 랜딩한 T3/CubeSandbox 체인(#1179·#1180, 2026-08-08~09)이 프로비저닝하는 인스턴스가 실행하는 바이너리가 `momo-workd`다 —
  `server-rust/crates/momo-t3/src/provision.rs:14` (*"→ workd boots, spends its bootstrap token"*), `:160`, `:235`, `:265`, `:372` · `crates/momo-t3/src/provider/byoc.rs:3` (*"The owner installs `momo-workd` on their own machine"*) · `provider/registry.rs:295`·`:437`·`:465` (`image_ref` 기본값 `"momo-workd"`) · `provider/mod.rs:143` (`tpl-oort-workd`).
- Rust에 workd 없음 — `server-rust/Dockerfile:31-33`이 명시: *"Not in this image (deliberate): the Swift workers / T3 / **workd** / LinkShort / the web SPA."* ADR-0145 §미해결에도 "workd 동시 이관 여부"가 미결로 남아 있다(`:60`).
- `clients/macOS/Package.swift:38`이 WorkHostDaemon을 경로 의존한다 → macOS를 지워도 workd는 남아야 한다(역방향 의존이므로 macOS 삭제는 workd에 안전).

**판정: workd는 "Swift 잔재"가 아니라 미이식 제품 컴포넌트다. 삭제하려면 Rust 재작성이 선행돼야 한다(수 주 규모 — PTY·ACP·Ed25519 서명·엔진 어댑터 4종, 29 .swift).**

### 2-3. 【③ 약함】 `services/LinkShort` — 배선돼 있으나 대체 비용 최저

- `infra/prod/Caddyfile:113-114` — `handle /i/* { reverse_proxy linkshort:28190 }` · `infra/prod/docker-compose.prod.yml:351-353` `command: ["linkshort"]` · `infra/prod/docker/momo-entrypoint.sh` `linkshort)` 분기 · `infra/docker-compose.e2e.yml:408-417`(swift-service.Dockerfile로 빌드) · `scripts/verify_web_serving.sh`가 `/i/*` 프록시를 단정.
- 기능 실측: `services/LinkShort/Sources/LinkShort/Redirector.swift:7-14` — **DB도 상태도 없다.** `GET /i/{code}` → `{base}/join?code={code}` 302. `services/LinkShort/README.md`도 "코드 검증·조회 없이 리다이렉트"라고 적는다.
- `short_link` 테이블 없음(마이그레이션 62개 전수 grep 0), Rust 참조 0, 웹/코어 참조 0.

**판정: 실질 대체 비용 = Caddy `redir` 한 줄 또는 Rust 라우트 한 개. 다만 "지우면 자동으로 대체된다"는 아니므로 삭제 시 대체가 동반돼야 한다.**

### 2-4. 【③】 `server/Sources` — 게이트가 아직 이걸 빌드한다 (두 자리)

**(a) e2e 컴포즈 = 65개 검증 스크립트의 기반**
`infra/docker-compose.e2e.yml`의 `api`/`relay`/`worker`/`notifier` 서비스는 `swift:6.2` 컨테이너 안에서 `server`/`relay/OutboxRelay`/`workers/AgentWorker`/`workers/NotifierWorker`를 **소스에서 콜드 빌드**한다(`:212`, `:287`, `:314`, `:499`). 이 컴포즈를 참조하는 `scripts/` 파일은 **65개**.

**(b) `--profile web` 게이트가 실제로 Swift api를 띄운다 — 2026-08-08에 돌았다**
`scripts/local_gate.sh:878` `add_cmd "web login -> timeline browser smoke (e2e compose)" 'scripts/verify_web_login_smoke.sh'` → `scripts/verify_web_login_smoke.sh:58-59` *"the api container **cold-builds Swift**"*(타임아웃 2400초), `:220` `compose up -d api`. JOURNAL:1955가 #1181에서 `--profile web 13/14 green`을 기록한다.
같은 프로파일이 `scripts/verify_web_serving.sh`(→ `web-serving-edge` + `linkshort` 스위프트 이미지)도 돈다.

**(c) openapi 게이트 1차 패스** — `scripts/verify_openapi_contract.sh:1708`이 `openapi_server_routes.py --routes-dir server/Sources/MomoServer/Routes`를 부른다. **단 이 블록은 `OPENAPI_GATE_SWIFT_PASS=1`일 때만 도달한다**(`:166` 기본 `0`, `:451-462` 조기 반환). → 이건 **② 이관 완료(opt-in으로 강등)**.

**(d) Makefile / local_gate `swift` 프로파일** — `Makefile:11` `SWIFT_PKGS`(12개 패키지) · `scripts/local_gate.sh:572-582 add_swift_commands`(`make build`/`make test`) · `:905`,`:926-1008`에서 docs·swift·macos-ui·ios·runtime-* 등 **8개 프로파일이 `add_swift_commands`를 호출**. 증보 2는 이 자리를 퇴역시키지 **않았다**(퇴역 3자리 = 폰 레인·openapi 1차·Xcode Cloud).

**판정: 실 병합 권위(병합 트리 7레인 + `cargo test`)에는 Swift가 0이지만, `local_gate.sh`의 프로파일 메뉴와 65개 verifier는 여전히 Swift를 빌드한다. 이건 "죽은 참조"가 아니라 "아직 살아 있는데 안 돌리는 참조"다 — 삭제하면 그 명령들이 실패한다.**

병합 트리 7레인 실측(`scripts/verify_merge_tree.sh:200-225`): core/web/phone typecheck 3 + core/web/phone suite 3 + copy scan 1 = **Swift 0**.

### 2-5. 【③】 브랜딩 게이트 `scripts/gate_oort_user_facing.sh` — Swift 5트리를 스캔한다

`:44-51` 스캔 루트에 `clients/macOS/Sources`·`clients/macOS/XcodeHost`·`clients/iOS/MomoiOSKit/Sources`·`clients/iOS/XcodeHost`·`relay/PushRelay/Sources`가 있고, `:272` `SWIFT_SERVER_ROOT = "server/Sources"`. `:84-94`·`:160-162`·`:277-291`에 **파일 경로가 하드코딩된 허용 예외 12건**(`MomoDeepLink.swift`, `PushRegistration.swift`, `MomoWorkHostIdentityStore.swift`, `Config.swift`, `Database.swift`, `PluginManifestValidator.swift`, `DriveBackend.swift`, `WorkHostAuthenticator.swift`, `AttachmentRoutes.swift` 등).
`:17`이 이유를 적는다: *"Swift `server/`는 #1118 배치 4에서 합류했다 — **prod 이미지가 아직 이쪽을 빌드하므로**."*

**판정: 트리를 지우면 이 게이트가 그 자리에서 깨진다(존재하지 않는 경로 예외 + 빈 스캔 루트). 게이트 동반 수정 필수.**

### 2-6. 【③】 `server/Migrations` — **트리 안에 있지만 라이브 SoT. 절대 삭제 금지**

- `server-rust/Dockerfile:130` `COPY server/Migrations /opt/momo/migrations`, `:141` `test -s /opt/momo/migrations/001_init.sql` — **Rust 배포 이미지가 이 디렉터리를 굽는다.**
- `infra/rust/README.md:34` · `infra/prod/docker/internal-smoke-migrate.Dockerfile:10` · `infra/prod/docker/momo.Dockerfile:75` · `Makefile:58` · `scripts/migrate.sh` · `AGENTS.md:108`·`CODEX.md:174`(스키마 확장 = `server/Migrations/00N_*.sql` 신규가 **하드 룰**).
- ADR-0145 결정문(`:14`)도 "마이그레이션은 Postgres DDL이라 언어 독립 → 그대로 재사용"이라 적는다.

**판정: `server/` 디렉터리 통삭제는 즉시 배포 파괴다. 삭제 범위는 `server/Sources` + `server/Tests` + `server/Package.swift`로 한정돼야 한다.**
`server/Fixtures/plugin-manifests/*.json` 4개는 **미확인**: Rust `momo-server`가 쓰는지 확인 못 했다(§8).

### 2-7. 【② 이관 완료】

| 참조 | 근거 | 상태 |
|---|---|---|
| 폰 레인 서버 스택 | `infra/rust/docker-compose.lane-phone.yml` + `clients/mobile/scripts/lane-phone.sh` = Rust 컴포즈 | 증보 2-① 이행 |
| openapi 1차 패스 | `verify_openapi_contract.sh:166` `SWIFT_PASS="${OPENAPI_GATE_SWIFT_PASS:-0}"` | 증보 2-② 이행 |
| 데스크톱 발행 | `scripts/publish_next_build.sh:100-105` = Tauri(`clients/desktop`) 전용. `publish_alpha_build.sh:42`(MomoMac xcodebuild)는 구경로 | ADR-0133 |
| 서버 배포 | 라이브 = `momo-rust:2afae645` (`docs/planning/CURRENT_STATE.md:9`) | ADR-0145 |
| CORS | `server-rust/bins/momo-server/src/cors.rs` (DESK-1, `docs/DEPLOY.md:542`) | 완료 |
| mDNS·딥링크·Keychain·알림·업데이터·외부URL | `clients/desktop/src-tauri/src/{discovery,deeplink,keychain,notification,updater,opener}.rs` | 전부 macOS에서 이식됨 |

### 2-8. 【① 죽은 참조】 — 문서·메타데이터만

- `.github/workflows/ci-build.yml:32` — `for pkg in clients/Core server relay/OutboxRelay workers/AgentWorker clients/macOS`. `workflow_dispatch` 전용, 조직 과금 이슈로 수동 전용(파일 머리말). **자동 실행 0**.
- `.github/workflows/release-ios.yml`·`release-macos.yml` — 전부 `workflow_dispatch`. 제품 클라는 RN/Tauri/웹(증보 2-③).
- `fastlane/{Appfile,Matchfile,Fastfile}` — `MomoiOS`/`MomoMac` scheme 전용. `Fastfile:36,58,82,103,122` 등.
- `.github/labels.json:27-28` (`area:macos`, `area:ios`) · `.github/ISSUE_TEMPLATE/{bug,feature,codex-goal}.md`의 `[swift] swift build green` 등급 · `.github/pull_request_template.md:3-4,20-21`.
- `.swift-version`(6.2), `Gemfile`.
- `clients/web/src/features/settings/quotaFixtures.json:2` / `routing/routingFixtures.json:2` — 산문 출처 주석뿐(`Transcribed from server/Sources/…Routes.swift`). 코드 의존 0.
- `docs/api/openapi.yaml:7-9` — 스펙 머리말이 아직 *"kept field-level identical to the server DTOs in `server/Sources/MomoServer/Routes/DTOs.swift`"*라고 주장. #1040 이후 사실과 다르다(정정 대상).
- `.github/dependabot.yml` — Swift 생태계 항목 **없음**(npm/docker/actions만).

---

## 3. 기능 파리티 감사

### 3-1. 서버 라우트 기계 대조 — **Swift-only 83경로 / 그중 65개가 스펙 성문화 상태**

추출 방법: Swift = `server/Sources/**/*.swift`의 `.get|post|put|patch|delete("…")` (다중행 포함) → **173경로**. Rust = `server-rust/bins/momo-server/src/**/*.rs`의 `.route("…", …)` 괄호 균형 파서 → **97경로**. 경로 파라미터를 `{x}`로 정규화 후 집합 차.

| 구분 | 개수 |
|---|---|
| Swift 총 | 173 |
| Rust 총 | 97 |
| **Swift-only (미이식)** | **83** |
| Rust-only | 7 (`pin` PUT/DELETE, `channels/{}/pins`, `typing`, `typing/grant`, `work-sessions/{}/reattach`, `/healthz`) |

**Swift-only 83 = 스펙에 있는 65 + 스펙에 없는 18.**
`docs/api/openapi.yaml`의 연산 131개 중 **65개를 Rust가 라우팅하지 않는다.** 게이트 자신이 이 수치를 매 실행 경고로 출력한다 — `docs/LOCAL_PR_GATE.md:163` *"2026-08-06 실측 125/128"* (해당 실행에서 sampled-on-rust 밖 연산 수).

**미이식 패밀리(증보 1 "보류" 13패밀리와 정확히 대응):**

| 패밀리 | Swift-only 경로 수 | 대표 근거 |
|---|---|---|
| memories(+policy·consent) | 12 | `MemoryRoutes.swift:154-169` |
| webhooks(+`/hooks/{}`·`/v1/webhooks/{}/{}`) | 6 | `WebhookRoutes.swift:30-38` |
| plugins(+grants·install) | 6 | `PluginRoutes.swift:25-30` |
| members/bans 라이프사이클 | 10 | `MemberLifecycleRoutes.swift:13-22` |
| huddles(+recordings·consent) | 6 | `HuddleRoutes.swift:70-78` |
| event-subscriptions | 4 | `EventSubscriptionRoutes.swift:128-131` |
| work-tool-profiles | 4 | `WorkToolProfileRoutes.swift:57-60` |
| workstreams | 3 | `WorkstreamRoutes.swift:69-71` |
| mcp(inbound·drive) | 4 | `InboundMCPRoutes.swift:15-17`, `DriveMCPRoutes.swift:21` |
| platform admin | 3 | `PlatformAdminRoutes.swift:14-16` |
| agent credentials | 3 | `AgentCredentialRoutes.swift:50-52` |
| agent card 온보딩 | 2 | `AgentCardRoutes.swift:287-288` |
| invites(redeem·revoke·regenerate) | 3 | `InviteRoutes.swift:23-25` |
| cloud pause/resume/delete/reconcile | 4 | `CloudProvisionerRoutes.swift:70-72`, `WorkHostRoutes.swift:105` |
| work-pool | 2 | `WorkPoolRoutes.swift:44-45` |
| **agentRunHistory (증보 1 잔여 "이식 대상")** | 3 | `AgentRunRoutes.swift:22-24` — `GET …/agents/{}/runs`, `GET …/channels/{}/agent-runs`, `GET …/agent-runs/{}` |
| 기타 | audit·context-packets·cost-snapshots·quota POST·workspace PATCH·agent-runtime/status | |

**Rust 자신이 이름 붙인 미이식** (`server-rust/bins/momo-server/src/work_host_auth.rs:22-25`) — "**still-unported five**": `GET …/work-hosts/{}/live-sessions` · `POST …/work-hosts/{}/reconcile` · `GET …/work-tool-profiles` · **`POST …/work-sessions`(서명 arm)** · **`PATCH …/work-sessions/{}`(서명 arm)**. 뒤 둘의 부재 때문에 `terminal-attach` 2경로가 sampled 매니페스트 등재 보류 상태다(`scripts/openapi_sampled_on_rust.txt` "등재 보류: terminal-attach").

기타 명시 미이식: `momo-agent/src/tools.rs:53,61`·`lib.rs:112`(work_control 도구), `momo-agent/src/mention.rs:530`(memory plane), `momo-drive/src/lib.rs:29`(S3 redirectURL), `routes/agent_runs.rs:592`(`RunRoutingResolution`), `routes/agent_gateway.rs:40`(단일프로세스 리미터), `routes/work_hosts.rs:44`(MOMO-656 서명 경로).

> **주의**: 위 83건은 "제품 기능 손실"과 1:1이 아니다. 증보 1이 정의한 parity는 "제품이 쓰기로 결정한 라우트 집합"이며, 65패밀리 중 상당수는 폐기 판정이 날 수 있다. **하지만 그 판정이 아직 없다** — 그게 §0-1의 Blocker다.

### 3-2. macOS 클라 고유 기능 — 폐기되는 목록 (검수 표면 = Tauri/RN이므로 폐기 대상이나 명시 필요)

**A. 플랫폼 능력 — 웹/Tauri가 지금 못 하는 것**

| 기능 | macOS 근거 | 대체 상태 |
|---|---|---|
| **로컬 PTY·로컬 프로세스 실행** | `MomoLocalTerminalSession.swift`, `MomoLocalACPSession.swift`, `MomoAgentPairing.swift:238` | 웹은 **관전 전용** — `clients/web/src/features/work/observerStream.ts:13` *"no encoder for `send_stdin`, `resize` or `kill` anywhere in this client"*. **최대 갭.** (단 실행 주체는 workd이므로 workd만 살리면 원격 경로는 유지) |
| **Apple Foundation Models 온디바이스 추론** + 로컬 컨텍스트 코파일럿 | `FoundationModelsCapability.swift`, `LocalContextCopilot.swift` | 웹/폰/데스크톱 0건 |
| **네이티브 메뉴바 + ⌘ 문법 전체** | `MomoKeyboardCommands.swift:191-293`(⌘1-9·⌃\`·⌘[/] 등 14개 바인딩) | 웹은 인페이지 핫키만(`QuickSwitcher.tsx:174,180`). `clients/desktop/src-tauri/src/lib.rs`에 menu/tray 모듈 없음 |
| **Dock 미확인 배지** | `MomoDockUnreadBadge.swift:21` | 대응물 0 |
| 네이티브 창 크롬·활성화 관찰자 | `MomoWindowChrome.swift:177-179` | 해당 없음(장식) |

**B. UI 표면 — 웹에 없어 함께 사라지는 것**

| 표면 | macOS 근거 | 웹/폰 검색 결과 |
|---|---|---|
| **웹훅 설정(아웃바운드/인바운드)** | `MomoWebhookSettingsView.swift` 등 3파일, 마운트 `MomoAccountSettingsViews.swift:1583` | `grep -rni webhook clients/web clients/mobile clients/desktop` → **0** |
| **이벤트 구독 설정** | `MomoEventSubscription{Models,RESTClient,SettingsView}.swift`, 마운트 `:1576` | `eventSubscription` → 0 |
| **컨텍스트 패킷 인스펙터** | `MomoContextPacketInspector.swift` | 0 |
| **알파 관제 센터**(서버/실시간/런타임/프로바이더/초대/진단/업데이트) | `AlphaCommandCenterView.swift` | 부분만(`AiLinkSection.tsx:394`) |
| **비용 호흡 링**(예약/집행 2상 게이지) | `CostBreathingRing.swift` | 웹은 총액만(`UsageSection.tsx`) |
| **첨부 업로드/전송 UI** | `MomoAttachmentTransfer.swift`, `MomoMessageAttachmentCard.swift` (ADR-0151) | 웹/폰/코어 0 — `ThreadComposer.tsx:21`이 *"no attachments"*라고 적음. **서버는 이식됐는데(#1119) 클라 표면이 macOS에만 있다** |
| **런타임 KO/EN 언어 토글** | `MomoAppLocalization.swift:5` | 웹/폰은 한국어 하드코딩, i18n 0. 조사 엔진은 이식됨(`packages/momo-core/src/lib/koreanParticle.ts`) |
| ACP 세션 카드·빈 채널 온보딩·퀵 툴팁·에이전트 페어링/자격증명/안전 패널 | 6파일 | 능력은 존재, UI 형태만 macOS 고유 |

**C. 웹에 이미 있어 손실 없음** — 채널목록·타임라인·컴포저·스레드·메시지액션/편집/핀/인용/반응·승인함·⌘K·검색·멤버 디렉터리·DM·채널생성·워크스페이스생성·에이전트 작업/부분출력·work console(ADE)·아티팩트 카드·**허들(LiveKit)**·**플러그인 마켓**·**메모리 브라우저**·프로바이더 링크·work host 엔진·계정/외관/초대 설정·업데이트 필·에이전트 생성/프로필·실시간 상태. (2026-07-25 parity 리포트 `docs/planning/2026-07-25-parity-gate-report.md:145`가 "허들·플러그인 마켓·메모리 브라우저·웹훅 설정이 웹에 없다"고 적었으나, 앞 셋은 그 뒤 웹에 생겼다. **남은 건 웹훅·이벤트구독 둘.**)

### 3-3. iOS 고유 (RN에 없는 것)

- **허들/LiveKit** — `IOSHuddle{ViewModel,LiveKitSession,RESTService}.swift` 3파일. `grep -riE 'huddle|livekit' clients/mobile/src` → 주석 2건뿐.
- **첨부 전송** — `IOSAttachmentTransfer.swift`. RN 0.
- **멤버십 관리 UI** — `IOSMembershipAdministration.swift`, `IOSMemberManagementViews.swift`. RN 대응 화면 없음.

### 3-4. `clients/Core` (MomoCore) 소비자

`import MomoCore` 레포 전수 → **`clients/macOS/{Sources,Tests}` + `clients/iOS/MomoiOSKit/{Sources,Tests}` 밖 0건.** 서버·워커·릴레이·서비스·툴 어느 것도 안 쓴다.
비-클라 참조는 전부 **빌드/게이트 도구**: `.github/workflows/ci-build.yml:32`, `Makefile:11`, `scripts/verify_design_preflight.sh:40`(`SRC_DIRS=("clients/macOS/Sources" "clients/Core/Sources")`), `.github/labels.json:26`.
의도적 비의존이 코드에 적혀 있다: `workers/AgentWorker/Sources/AgentWorker/AgentEvent.swift:7-8`, `server/Sources/MomoServer/Routes/DTOs.swift:7`.

⚠ MomoCore는 2026-08-07까지 수정됐다(`e9d79d87` — `Message.swift`·`RealtimeSubscriptionDriver.swift`). 그 편집이 실제 소비된 것인지 계약 정렬만인지는 **미확인**.

---

## 4. web-legacy 결속 규명

### 사실 관계

1. `infra/prod/docker/momo.Dockerfile`은 **두 개를 굽는다** — Swift 4바이너리(`:10-38`)와 web-legacy dist(`:43-48` Node 스테이지, `:69` `COPY --from=web-build … /opt/momo-web/`). 최종 스테이지 `:93`이 `test -s /opt/momo-web/index.html`로 웹 자산 존재를 빌드 시점에 강제한다.
2. **하지만 web-legacy에는 이미 독립 Dockerfile이 있다** — `infra/prod/Dockerfile.web`(전 19줄, Swift 무접촉). `infra/docker-compose.e2e.yml:398-400`이 그것으로 `web-init`을 만든다. `docs/DEPLOY.md:534`는 그것을 *"web-serving 집중 verifier의 빠른 재빌드 경로로만 남으며 공개 발행 대상이 아니다"*로 규정한다.
3. **라이브 웹은 web-legacy가 아니다** — `docs/planning/JOURNAL.md:1955` (#1181): *"**라이브 무영향, app.oor7.com = clients/web 서빙**."* `CURRENT_STATE.md:9` 라이브 웹 = `index-C3szaFWl`(clients/web 번들).
4. #1181이 web-legacy 은퇴를 기각한 근거가 **"momo.Dockerfile 유일 웹"**이다 — 즉 web-legacy의 존치 사유는 *Swift 이미지가 굽는 유일한 웹이라서*다.
5. web-legacy는 게이트 부담을 지고 있다 — `scripts/local_gate.sh:866-877`(`--profile web`의 install/lint/test/typecheck/build/license 6단계가 전부 `clients/web-legacy`) + `scripts/verify_web_generated_types.sh`(openapi ↔ 생성 타입 유일 컴파일타임 대조).

### 판정

**Swift 삭제 시 `momo.Dockerfile`은 존속 불가**(Swift 4바이너리가 그 이미지의 본체다). 세 갈래:

| 안 | 내용 | 평가 |
|---|---|---|
| **A. web-legacy를 `Dockerfile.web`으로 승계** | `momo.Dockerfile` 삭제, `MOMO_WEB_IMAGE`를 `infra/prod/Dockerfile.web` 산출로 전환. prod compose의 `web-init` `command: ["web-assets"]` → `Dockerfile.web`의 ENTRYPOINT가 같은 일(복사)을 이미 한다 | **최소 변경·즉시 가능.** 코드 신규 0 |
| **B. `clients/web` 승격** | Dockerfile.web의 빌드 대상을 `clients/web`으로 교체 | 라이브와 정합하지만 **ADR-0133 parity 게이트 통과가 전제**(`Dockerfile.web:8-10`·`momo.Dockerfile:40-42`가 명시). 게이트 통과 증거를 못 찾음 → **별건 결정** |
| **C. web-legacy 동반 폐기** | #1181 기각 근거(유일 웹)가 소멸하므로 논리적 후속 | 하지만 셀프호스트 이미지에 **웹이 0이 된다**. B 없이는 불가 |

**권고: A로 갈라놓고(참조 0 만들기), B/C는 별건 ADR로 성재 결정.** 삭제 워커가 즉흥으로 B를 하면 ADR-0133 게이트를 우회하는 셈이 된다.

**부수 파괴**: `momo.Dockerfile` 삭제 시 `.github/workflows/publish-images.yml:53`(유일한 이미지 발행 워크플로), `scripts/verify_multibinary_image.sh:92`, `scripts/verify_internal_host_runtime.sh:64`, `infra/prod/docker-compose.prod.yml`의 6서비스(`api|relay|worker|migrate|web-assets|linkshort`), `infra/prod/{install.sh,upgrade.sh}`, `docs/DEPLOY.md` 대부분이 동시에 무효가 된다. **즉 "Swift 삭제"는 셀프호스트 배포 경로 전체의 Rust 전환을 함께 요구한다** — prod compose가 Rust 이미지를 쓰려면 `worker`→`agent-worker` 롤 이름 불일치(`server-rust/docker-entrypoint.sh`에 `worker` 분기 없음)와 `web-assets`·`linkshort` 롤 부재를 먼저 풀어야 한다.

---

## 5. 삭제 가능 / 불가

### 5-A. 지금 삭제 가능 (참조 정리 후) — 총 573파일 / .swift 366

| 대상 | 파일 | 조건 |
|---|---|---|
| `clients/macOS/**` | 327 | design_preflight·gate_oort·Makefile·ci-build·fastlane·labels 정리 |
| `clients/iOS/**` | 50 | 위 + release-ios.yml·Matchfile·Appfile |
| `clients/Core/**` | 30 | 소비자 0(§3-4). 위 두 개와 **동시** |
| `services/CloudProviderKit/**` | 9 | Rust `momo-t3/provider/*`가 승계 |
| `services/OutboundHTTPPolicy/**` | 3 | server·OutboxRelay·AgentWorker 삭제와 동시 |
| `relay/OutboxRelay/**` | 8 | `momo-relay` 승계. e2e compose `relay` 서비스 제거 동반 |
| `workers/AgentWorker/**` | 27 | `momo-agent-worker` 승계 |
| `workers/NotifierWorker/**` | 11 | `momo-notifier` 승계 |
| `server/Sources/**` `server/Tests/**` `server/Package.swift` | 110 | **`server/Migrations`·`server/Fixtures`는 남긴다.** e2e compose·momo.Dockerfile·openapi 1차 패스·gate_oort 4절 동반 정리 |

### 5-B. 삭제 불가 (대체물 없음 · 라이브)

| 대상 | 파일 | 사유 |
|---|---|---|
| **`relay/PushRelay/**`** | 10 | 유일 APNs 경계. Rust 대체 0. `infra/rust/docker-compose.push.yml` 배선 |
| **`services/MomoMetrics/**`** | 5 | PushRelay 경로 의존 |
| **`workers/WorkHostDaemon/**`** | 31 | 미이식 제품 컴포넌트. T3/CubeSandbox 프로비저닝의 종착 바이너리 |
| **`server/Migrations/**`** | 62 | Rust 이미지가 굽는 SoT DDL |

### 5-C. 조건부 (대체 동반 시 가능)

| 대상 | 파일 | 대체 |
|---|---|---|
| `services/LinkShort/**` | 7 | Caddy `redir /i/* {base}/join?code=…` 또는 Rust 라우트 1개 |

---

## 6. 삭제 순서 제안 (참조 0 만들기 → 트리 삭제)

> 원칙: **각 단계는 그 자체로 게이트 그린인 커밋**이어야 한다. 참조와 트리를 같은 커밋에서 지우면 어디서 깨졌는지 못 본다.

**0단계 — 발사 금지 해제 조건 (성재 자리, 워커 아님)**
1. ADR-0145 **증보 1 복원**(`git show 06677ee3:docs/adr/…`에서 복원 + 그 뒤 랜딩분 반영: work-controls/work-auto-approvals 이식 완료 표기).
2. 보류 11패밀리(plugins·webhooks·mcp·memories·huddles·workstreams·event-subscriptions·work-tool-profiles·bans·members 잔여·platform) + agentRunHistory에 대한 **이식/폐기 판정**.
3. web-legacy 승계안(A/B/C) 결정.

**1단계 — 무해한 메타데이터 정리 (트리 무접촉)**
`.github/ISSUE_TEMPLATE/*`·`pull_request_template.md`의 `[swift]` 등급 · `.github/labels.json` `area:macos`/`area:ios` · `docs/api/openapi.yaml:7-9` 머리말 정정. 게이트: docs 프로파일.

**2단계 — 클라 3트리 삭제**
`clients/macOS` + `clients/iOS` + `clients/Core` 동시. 동반: `.github/workflows/{ci-build,release-ios,release-macos}.yml` 삭제 · `fastlane/**`+`Gemfile` 삭제 · `scripts/{macos_dev_run,verify_macos_real_backend_ui*,verify_ios_*,publish_alpha_build,generate_ios_app_icon}.sh` 삭제 · `scripts/verify_design_preflight.sh:40` SRC_DIRS 정리(또는 스크립트 폐기 — 웹 preflight가 승계) · `local_gate.sh`의 `macos-ui`/`ios` 프로파일 제거 · `Makefile` SWIFT_PKGS 축소 · `gate_oort_user_facing.sh:44-49`·`:84-94`·`:160-162` 정리.
검증: 병합 트리 7레인 · `gate_oort_user_facing.sh` · docs.

**3단계 — web-legacy 빌드 경로 승계 (0단계 결정 집행)**
안 A면: prod compose `web-init`을 `Dockerfile.web` 산출로 전환 + `publish-images.yml`을 그 이미지로 재조준.
검증: `--profile web-serving` + prod 이미지 실빌드.

**4단계 — 셀프호스트 배포 경로 Rust 전환**
`infra/prod/docker-compose.prod.yml`의 `api|relay|worker|migrate` → Rust 이미지(롤 이름 `worker`→`agent-worker` 정합), `linkshort` 대체(Caddy redir), `momo.Dockerfile`·`swift-service.Dockerfile`·`internal-smoke-migrate.Dockerfile` 삭제, `verify_multibinary_image.sh`·`verify_internal_host_runtime.sh`·`docs/DEPLOY.md` 갱신.
**이 단계가 가장 크다. 별도 티켓·별도 워커 권고.**

**5단계 — 서버/워커/릴레이 Swift 삭제**
`server/{Sources,Tests,Package.swift}` + `relay/OutboxRelay` + `workers/{AgentWorker,NotifierWorker}` + `services/{CloudProviderKit,OutboundHTTPPolicy}`.
동반: `infra/docker-compose.e2e.yml`에서 `api|relay|worker|notifier` 서비스 제거 → **65개 verifier 중 e2e를 쓰는 것 전수 판정**(Rust 스택으로 이관 / cargo 테스트로 대체됨을 확인 후 삭제 / 보류). `verify_openapi_contract.sh`의 1차 패스 코드 경로 제거(2차만 남김) + `openapi_server_routes.py`를 Rust 라우트 추출로 재작성하거나 폐기 + `openapi_known_unsampled.txt` 계약 재정의. `gate_oort_user_facing.sh` 4절 삭제.
검증: `cargo test --workspace` · 병합 트리 7레인 · `--profile web`(Swift 스모크 대체 후) · Rust 이미지 실빌드.

**6단계 — 조건부 LinkShort**
대체 랜딩 후 삭제.

**남는 것**: `server/Migrations`, `server/Fixtures`, `relay/PushRelay`, `services/MomoMetrics`, `workers/WorkHostDaemon` — 각각 별도 트랙.

---

## 7. 잔여 이식 티켓 후보

| # | 제목 | 규모 | 근거 |
|---|---|---|---|
| T1 | **ADR-0145 증보 1 복원 + 11패밀리 판정** | 문서 | §0-1. **모든 삭제의 선행** |
| T2 | **agentRunHistory 3경로 Rust 이식** | 소 | 증보 1의 마지막 미완 "이식 대상" · `AgentRunRoutes.swift:22-24` |
| T3 | **work-host 서명 arm 2개 이식**(`POST/PATCH …/work-sessions`) | 중 | `work_host_auth.rs:22-25` "still-unported five" → terminal-attach 2경로 등재 해제 동반 |
| T4 | **still-unported five 잔여 3**(live-sessions·reconcile·work-tool-profiles) | 중 | 동상 |
| T5 | **셀프호스트 배포 경로 Rust 전환**(momo.Dockerfile 퇴역 + 롤 이름·web·linkshort) | **대** | §4 부수 파괴 목록 |
| T6 | **PushRelay Rust 이식** 또는 "Swift 영구 존치" 명시 결정 | 대 or 문서 | §2-1 |
| T7 | **workd Rust 이식** 또는 "Swift 영구 존치" 명시 결정 | **대** or 문서 | §2-2. ADR-0145 `:60` 미해결 항목 |
| T8 | LinkShort 대체(Caddy redir 또는 Rust 라우트) | 소 | §2-3 |
| T9 | 웹훅·이벤트구독 설정 표면 웹 이식(또는 기능 폐기 결정) | 중 | §3-2 B — macOS에만 있는 설정 2종 |
| T10 | 첨부 클라 표면(웹/폰) — 서버는 #1119로 이미 이식됨 | 중 | §3-2 B |
| T11 | e2e verifier 65개 전수 판정(이관/폐기/보류) | 중 | §2-4(a) |
| T12 | `openapi.yaml` 머리말·`openapi_server_routes.py` Rust 재조준 | 소 | §2-8 |

---

## 8. 리스크 · "참조 정본 유지" 재평가

### 되돌리기 비용

git 이력은 남는다 — `git show <sha>:path`로 어떤 파일도 원문 복구 가능하고, 이번 감사에서 실제로 그 경로로 ADR-0145 증보 1을 복구했다(§0-1). 따라서 **"이식 원본 참조용"이라는 존치 사유는 약하다.**

**다만 §0-1이 그 낙관의 반례다.** 이력에 남아 있다는 사실이 *찾을 수 있다*를 보장하지 않는다 — 증보 1은 이력에 멀쩡히 있는데도 3일간 아무도 그것이 사라진 줄 몰랐고, 이 감사가 우연히 발견했다. 이력 복구는 **"거기 있다는 걸 아는 사람"**을 전제로 한다.

**권고**: 참조 정본을 트리로 유지하지 말고, 삭제 커밋 본문과 `docs/adr/0145`에 **삭제 시점 SHA를 못 박아라**. 예: `이식 원본: git show 22529681:server/Sources/MomoServer/Routes/MemoryRoutes.swift`. 그러면 "이력에 있다"가 "이 줄을 읽으면 찾는다"가 된다.

### 실 리스크 (높은 순)

| # | 리스크 | 완화 |
|---|---|---|
| R1 | **삭제 게이트(증보 1) 부재 상태에서 삭제 → 판정 없이 65 스펙 연산 폐기** | T1 선행. 성재 판정 없이 발사 금지 |
| R2 | **PushRelay/workd 동반 삭제 → 푸시·작업호스트 종단 파괴** | 5-B를 삭제 워커 패킷에 **금지 목록**으로 명시 |
| R3 | **`server/` 통삭제 → `server/Migrations` 유실 → Rust 이미지 빌드 실패** | 삭제 경로를 `server/Sources`·`server/Tests`·`server/Package.swift`로 **열거**. `rm -rf server` 금지 |
| R4 | `momo.Dockerfile` 삭제로 셀프호스트 배포·발행 워크플로 동시 무효 | 3·4단계 분리, T5 별건 |
| R5 | 65 e2e verifier 무력화 = 조용한 커버리지 소실 | T11. 삭제 전 전수 판정, 판정표를 PR 본문에 |
| R6 | `gate_oort_user_facing.sh` 하드코딩 예외 12건이 존재하지 않는 경로를 가리켜 게이트 폭발 | 단계마다 게이트 동반 수정 |
| R7 | macOS 폐기와 함께 첨부 UI·웹훅/이벤트구독 설정이 **제품에서 사라짐**(서버는 살아 있음) | T9·T10로 명시 적립. "폐기"인지 "이식"인지 성재 결정 |
| R8 | 웹 게이트(`--profile web`)가 Swift api를 띄우므로 삭제 즉시 빨강 | 5단계에서 Rust 스택 스모크로 대체 후 삭제 |
| R9 | 로컬 워크트리 잔재(`684-3` 브랜치 ref — `CURRENT_STATE.md:9`가 "Swift 퇴역분 폐기 여부 성재 판단"으로 남겨둠) | 삭제 시 함께 판정 |

---

## 9. 삭제 실행 워커(W-S)에게 줄 지시 초안

> 아래를 그대로 패킷 본문에 넣을 수 있다. **단 §0-1의 T1이 끝나기 전에는 발사하지 마라.**

```
## 워커 S — Swift 부분 삭제 (배치 2단계: 클라 3트리)

- 기준: origin/main (track/engine은 main의 진부분집합 — 감사 실측)
- 이 배치의 범위는 **clients/macOS + clients/iOS + clients/Core 셋뿐**이다.
  서버·릴레이·워커·서비스는 이 배치에서 건드리지 않는다.

### 절대 삭제 금지 (하나라도 지우면 즉시 STOP·되돌림)
  server/Migrations/**          Rust 배포 이미지가 굽는다 (server-rust/Dockerfile:130)
  server/Fixtures/**            소비자 미확인
  relay/PushRelay/**            유일 APNs 경계 (infra/rust/docker-compose.push.yml:47)
  services/MomoMetrics/**       PushRelay 경로 의존 (relay/PushRelay/Package.swift:12)
  workers/WorkHostDaemon/**     T3 프로비저닝 종착 바이너리 (momo-t3/src/provision.rs:14)
  clients/mobile/ios/**         RN 자체 네이티브 (MomoCore 무의존)
  clients/mobile-spike/**
  동결층: app.momo.* 번들ID · com.dawnkim.momo · MOMO-NNN · MOMO_* env · momo_app 등 role · X-Momo-*

### 순서 (참조 0 → 트리 삭제, 커밋 분리)
1. 참조 제거 커밋:
   - .github/workflows/{ci-build,release-ios,release-macos}.yml  삭제
   - fastlane/** + Gemfile  삭제
   - .github/labels.json: area:macos·area:ios 제거
   - .github/ISSUE_TEMPLATE/*·pull_request_template.md: [swift] 등급·swift build 항목 제거
   - Makefile: SWIFT_PKGS에서 clients/Core·clients/macOS 제거
   - scripts/local_gate.sh: macos-ui·ios 프로파일과 auto_classify의 clients/* 매핑 정리
   - scripts/verify_design_preflight.sh:40 SRC_DIRS 정리
   - scripts/gate_oort_user_facing.sh: :44-49 스캔 루트 5개 중 macOS/iOS 4개, :84-94 예외 4건,
     :160-162 plist 3건 제거 (PushRelay·server 항목은 유지)
   - scripts/{macos_dev_run.sh, verify_macos_real_backend_ui*.sh, verify_ios_build.sh,
     verify_ios_signing.sh, verify_ios_wire.sh, verify_push_kit_inheritance.sh,
     publish_alpha_build.sh, generate_ios_app_icon.swift, momo} 판정 후 삭제
   - .swift-version 유지(잔존 Swift 3트리가 쓴다)
2. 트리 삭제 커밋: git rm -r clients/macOS clients/iOS clients/Core
3. 문서 갱신 커밋: 남는 참조는 "이식 원본은 git 이력 — git show <SHA>:<path>" 로
   갱신하고, <SHA>는 삭제 직전 커밋을 리터럴로 박는다("이력에 있다"만 쓰지 마라).

### 검증 (전부 green 필수)
  - scripts/verify_merge_tree.sh (7레인)
  - bash scripts/gate_oort_user_facing.sh
  - scripts/local_gate.sh --profile docs
  - cd server-rust && cargo test --workspace
  - grep -rn "clients/macOS\|clients/iOS\|clients/Core\|MomoMac\|MomoiOS\|import MomoCore" \
      --include='*.sh' --include='*.yml' --include='*.json' --include='Makefile' . | grep -v '^./docs/'
    → 0건이어야 한다(문서 산문 제외)
  - relay/PushRelay·workers/WorkHostDaemon·services/MomoMetrics·server/Migrations 파일 수
    before/after 동일 기계 증명

### PR
  base=track/engine, 제목 "ADR-0145 증보 3 — Swift 클라 3트리 삭제(macOS·iOS·Core)".
  본문: 삭제 파일 수·금지 목록 무접촉 증명·폐기되는 macOS 고유 기능 목록(감사 §3-2 B 인용)·
  이탈 절. **PR 후 STOP.** 머지·이슈 종결 금지.
```

---

## 10. 미확인 (정직 기록)

1. **`server/Fixtures/plugin-manifests/*.json` 4개**를 Rust `momo-server`가 소비하는지 확인 못 했다. 삭제 전 `grep -rn "plugin-manifests\|Fixtures" server-rust/` 필요.
2. **라이브 배포가 어떤 compose로 도는지** 레포에서 특정하지 못했다. `docs/runbooks/ncp-rust-deploy.md`("5파일 compose")가 정본이라고 `CURRENT_STATE.md:120`이 적지만 그 파일을 열지 않았다. prod compose의 `worker`/`web-assets`/`linkshort` 롤이 Rust 이미지에 없으므로(§4), 라이브가 어떻게 그 간극을 메우는지 미확인.
3. **PushRelay가 실제로 배포돼 있는지** 미확인 — `docs/cicd/12` 런북은 "키만 꽂으면 되는 상태"까지고, 실 APNs 발송 검증은 미완이라고 적혀 있다. 배포 안 됐더라도 **Rust 대체물이 없다는 사실**은 불변이므로 삭제 판정에는 영향 없다.
4. **65개 e2e verifier 각각**이 Rust 경로로 대체됐는지 개별 판정하지 않았다(T11로 적립). `cargo test` 21 통합 테스트가 상당수를 승계했을 가능성이 높지만 1:1 대조는 안 했다.
5. **MomoCore 2026-08-07 편집**(`e9d79d87` — `Message.swift`·`RealtimeSubscriptionDriver.swift`)이 macOS/iOS 뷰에서 소비됐는지 미확인.
6. 라우트 추출은 정규식 기반이다. Swift 173 / Rust 97은 등록 패턴을 놓쳤을 수 있다(특히 Rust `nest()`·`merge()`·매크로 경유). 다만 **Swift-only 65개가 스펙 연산과 교집합**이라는 결론은 게이트 자신의 독립 실측(`docs/LOCAL_PR_GATE.md:163` "125/128")과 같은 방향이라 방법론 오차로 뒤집히지 않는다.
7. 워크트리 `swiftaudit-wt`는 이 감사가 만들었다(읽기 전용 사용). 정리 필요 시 `git worktree remove`.

---

## 11. 재기준화 — `origin/track/engine` 기준 (2026-08-09 추가)

> 패킷 `docs/planning/handoffs/2026-08-09-swift-removal-rebaseline-packet.md` T-B가 지시한 "§8 재기준화" 절이다. 원문 §8이 이미 리스크 절이므로 번호 충돌을 피해 §11로 단다. **위 §0~§10은 한 줄도 지우지 않았다** — 아래는 전부 *추가되는 정정*이며, 충돌하는 곳은 이 절이 이긴다.
>
> - 기준: `origin/track/engine` = **`4427756a`** / 대조 대상: 원 감사의 기준 `origin/main` = `8b9a898d`
> - 작성: 무명 단발 워커 · 코드 변경 0 · 삭제 0

### 11-A. 【전제 역전】 engine은 더 이상 main의 진부분집합이 아니다

원 감사 §0은 `rev-list --left-right --count origin/main...origin/track/engine` = `179 0`을 근거로 **"engine-only 커밋 0"**이라 적고, 그래서 기준을 main으로 바꿨다. **지금은 거짓이다.**

```
git rev-list --left-right --count origin/main...origin/track/engine  →  1  36
git merge-base origin/main origin/track/engine                       →  10da3f43
origin/main   = 6e19ddbc      origin/track/engine = 4427756a
```

즉 **engine이 36커밋 앞서고**, main은 engine에 없는 커밋 1개(`6e19ddbc`, 문서)를 갖는다. 감사가 잰 `179 0`은 그 시점의 사실이었고, 그 뒤 engine이 전진하며 무효가 됐다. **패킷의 원래 지시("기준 = origin/track/engine")가 옳았다.**

§0의 두 번째 근거도 함께 무효다 — *"track/engine에는 ADR-0145 증보 2가 없다"*. engine 판본 `docs/adr/0145-server-stack-buzz-fork-rust.md`에는 증보 1(`:161`)과 증보 2(`:175`)가 **둘 다 있다**. 복원 커밋 `32f31eaa`가 merge-base 이전이라 engine이 그대로 승계했다.

### 11-B. 【§0-1 Blocker 절반 해소】 증보 1은 이미 복원됐다

§0-1이 "main에서 유실"이라 판정한 증보 1은 **커밋 `32f31eaa`("docs(adr): 0145 증보 1 복원 — 감사가 적발")로 이미 복원돼 main·engine 양쪽에 있다.** 이 감사가 그 복원을 촉발했다.

남은 Blocker는 **11패밀리 판정 하나뿐**이고, 그 입력이 신설 문서 `docs/planning/research/2026-08-09-swift-family-disposition-table.md`다.

부수 결함 1건 — 그 복원 커밋이 `## 증보 2` 헤딩을 **두 번** 넣었다(`:175`·`:177`). 본 PR이 중복 헤딩만 제거한다(본문 무변경).

### 11-C. 【최대 정정】 `relay/OutboxRelay`는 "삭제 가능"이 아니다 — 감사 이후 **거기에만** 새 코드가 랜딩했다

engine-only 36커밋이 건드린 `.swift` 파일은 **정확히 3개, 전부 `relay/OutboxRelay`**다.

```
git diff --stat $(git merge-base origin/main origin/track/engine)...origin/track/engine -- '*.swift'
  relay/OutboxRelay/Sources/OutboxRelay/RelayService.swift          | 78 +++++++-
  relay/OutboxRelay/Sources/OutboxRelay/WebhookDeliveryClient.swift | 42 ++++-
  relay/OutboxRelay/Tests/OutboxRelayTests/OutboxRelayTests.swift   | 96 ++++++-
  3 files changed, 203 insertions(+), 13 deletions(-)
```

커밋 `2d608ccd`(2026-08-09, *"웹훅 전송이 흔적을 남긴다"*)가 신규 마이그레이션 `server/Migrations/063_event_subscription_delivery_audit.sql`과 신규 검증기 `scripts/verify_event_subscription.sh`를 함께 얹었다.

**Rust에 웹훅 소비자가 없다**(실측):

- `server-rust/crates/momo-outbox/src/emit.rs:40`·`:50` — `OutboxKind::WebhookDelivery`는 **발행 쪽 정의만**.
- `server-rust/crates/momo-outbox/src/relay.rs:82` — *"the relay publishes to Centrifugo only. `webhook_delivery` / `push_candidate` / `agent_job` rows belong to their own consumers (B1 gate lesson) and **must not be drained here**."*
- `server-rust/bins/momo-relay/src/lib.rs:23` — 같은 취지(**broadcast only**).
- 레포 전체에서 `webhook_delivery` 행을 claim/전송하는 Rust 코드 **0건**. 유일한 송신자 = Swift `relay/OutboxRelay/Sources/OutboxRelay/WebhookDeliveryClient.swift`.

그리고 그 검증기가 띄우는 것도 Swift다 — `scripts/verify_event_subscription.sh:48`이 `infra/docker-compose.e2e.yml`을 잡고 `:184` `compose up -d api relay webhook-receiver`를 부르는데, 그 `relay` 서비스는 `infra/docker-compose.e2e.yml:287` **`swift:6.2`** 이미지다.

> **정정**: §5-A의 `relay/OutboxRelay`(8파일, "`momo-relay` 승계") 줄은 **5-C(조건부)로 내려가야 한다.** 조건 = 웹훅/이벤트구독 배달 소비자의 Rust 이식. 더 나아가 이 트리는 **감사 이후에도 활발히 개발 중인 트리**이므로, 삭제 계획서에서 "잔재"로 분류된 상태를 유지하면 안 된다.
>
> 파생 정정: §6 **5단계**가 `relay/OutboxRelay` 삭제를 서버·워커와 한 묶음으로 두는데, 그 묶음은 깨져야 한다. §7 티켓 목록에도 **신규 T13 「webhook_delivery/event-subscription 배달 소비자 Rust 이식」**이 필요하다(규모 중, §2-1 PushRelay와 함께 "Rust에 대체물이 아예 없는" 둘째 자리).

### 11-D. 【소거】 T9·T10 — 웹 표면은 랜딩했다

패킷이 지목한 두 티켓은 engine에서 **웹 몫이 닫혔다**.

| 티켓 | 랜딩 커밋 (engine-only) | 산출물 실재 |
|---|---|---|
| **T9** 웹훅 설정 표면 | `9a6feea2` | `clients/web/src/features/settings/WebhookSection.tsx`(605줄) · `packages/momo-core/src/features/webhooks/api.ts:6-9`(4연산)·`:62` · `clients/web/src/features/settings/webhookCredentialScope.ts` |
| **T9** 이벤트 구독 설정 표면 | `33930f94` | `clients/web/src/features/settings/EventSubscriptionSection.tsx`(572줄) · `packages/momo-core/src/features/settings/eventSubscriptions.ts:465` |
| **T10** 첨부 클라 표면 | `2dae0e06` | `clients/web/src/features/attachments/{AttachmentTray.tsx,draftStore.ts,uploadTransport.ts,useComposerDropZone.ts,content.ts}` · `clients/web/src/features/timeline/AttachmentList.tsx` · `packages/momo-core/src/features/attachments/model.ts` |

감사 §3-2 B가 인용한 두 근거 문장은 **engine에서 뒤집혔다**:

- *"`grep -rni webhook clients/web clients/mobile clients/desktop` → **0**"* → engine 실측 **243건**.
- *"`ThreadComposer.tsx:21`이 **no attachments**라고 적음"* → engine `clients/web/src/features/timeline/ThreadComposer.tsx:47`이 *"이 자리에는 「no attachments」가 함께 적혀 있었고, 그 판단은 **뒤집힌다**"*로 교체.

**단 RN은 그대로 0이다** — `clients/mobile/src`에서 `attachment`·`webhook`·`eventSubscription` 전부 **0건**. T9·T10은 **웹 한정으로 닫히고 폰 몫만 남는다.**

### 11-E. 【재판정】 R7 — 과대평가였고, 리스크의 주소가 바뀌었다

R7 원문: *"macOS 폐기와 함께 첨부 UI·웹훅/이벤트구독 설정이 제품에서 사라짐(서버는 살아 있음)"*.

- **틀린 절반**: 세 표면 모두 **웹에 이미 섰다**(11-D). macOS를 지워도 웹 사용자는 첨부를 보내고 웹훅·이벤트 구독을 설정한다. 이 방향의 R7은 **해소**.
- **남는 절반(축소)**: RN(폰)에는 셋 다 없다. 폰 사용자 한정 표면 손실은 유효하나, 이는 macOS 삭제가 만드는 손실이 아니라 **이미 존재하는 폰 공백**이다 — 원인 귀속이 틀렸다.
- **뒤집힌 방향(새로 커진 쪽)**: 이제 위험한 것은 클라가 아니라 **서버**다. 방금 랜딩한 웹훅 4연산·이벤트 구독 4연산을 **Rust 라우터가 싣지 않는다**(처분표 §1 #2·#7). 즉 웹 표면은 존재하되 Rust 서버에 붙으면 404다. 배달 경로마저 Swift OutboxRelay에 있다(11-C).

> **R7 재서술**: "macOS 폐기로 표면이 사라진다"(과대평가·웹에서 해소) → **"웹에 선 웹훅·이벤트구독 표면이 Rust 서버에 대응 라우트를 갖지 못했고, 그 배달을 아직 Swift가 한다"**(유효·등급 유지). 완화는 T9가 아니라 **11-C의 신규 T13 + 웹훅/이벤트구독 관리 REST 이식**이다.

### 11-F. 인벤토리·수치 정정

| 원문 | 값 | engine 실측 | 비고 |
|---|---|---|---|
| §1 `server/Migrations` 파일 수 | 62 | **63** | `063_event_subscription_delivery_audit.sql` 신규 |
| §5-B `server/Migrations/**` | 62 | **63** | 동상 |
| §3-1 Rust 총 라우트 | 97 | **97 (동일)** | `grep -oE '\b(get\|post\|put\|patch\|delete)\(routes::' server-rust/bins/momo-server/src/lib.rs \| wc -l` = 97. engine 36커밋이 서버 라우트를 늘리지 않았다 |
| §3-1 openapi 연산 수 | 131 | **131 (동일)** | `grep -c operationId docs/api/openapi.yaml` |
| §3-1 "still-unported five" | 5 | **5 (동일)** | `server-rust/bins/momo-server/src/work_host_auth.rs:22-25` 문구 무변경 |

**따라서 §3-1의 라우트 파리티 결론(Swift-only 83 / 스펙 성문화 65)은 engine에서도 유효하다.** 바뀐 것은 클라 표면이지 서버 라우트가 아니다.

> 마이그레이션 63은 **engine 기준**이다. `063_…`이 아직 engine-only라 main에서는 62가 맞고, main 위에서 도는 게이트도 62를 보고한다(`[migration-numbers] PASS: 62 migration files`). engine이 main에 머지되는 순간 63이 된다 — 두 값이 어긋난 것이 아니라 11-A의 36커밋 격차가 여기서도 보이는 것이다.

### 11-G. file:line 드리프트 — 주장은 유효, 좌표만 이동

아래는 **결론이 바뀐 것이 아니라 줄 번호만 밀린** 것들이다. 삭제 워커가 좌표로 편집하면 엉뚱한 줄을 친다.

| 원 감사 좌표 | engine 실좌표 | 대상 |
|---|---|---|
| `server-rust/Dockerfile:130` | **`:139`** | `COPY server/Migrations /opt/momo/migrations` |
| `server-rust/Dockerfile:141` | **`:148`** | `test -s /opt/momo/migrations/001_init.sql` |
| `infra/rust/docker-compose.push.yml:47` | **`:62`** | `push-relay:` 서비스 |
| `scripts/local_gate.sh:878` | **`:880`** | web login smoke `add_cmd` |
| `docs/LOCAL_PR_GATE.md:163` | **`:164`** | "2026-08-06 실측 125/128" |

**좌표·내용 모두 유효(무변경)**: `scripts/verify_openapi_contract.sh:166`(`OPENAPI_GATE_SWIFT_PASS` 기본 0) · `server-rust/crates/momo-t3/src/provision.rs:14` · `server-rust/bins/momo-server/src/work_host_auth.rs:22-25` · `clients/web/src/features/work/observerStream.ts:13`(*"no encoder for `send_stdin`, `resize` or `kill`"* — §3-2 A "최대 갭" 판정 **유지**) · `scripts/gate_oort_user_facing.sh:272`(`SWIFT_SERVER_ROOT`).

### 11-H. 【삭제 지시 결함】 §9 워커 초안이 금지 트리를 건드린다

§9의 W-S 지시 초안은 이렇게 적는다:

> `scripts/gate_oort_user_facing.sh: :44-49 스캔 루트 5개 중 macOS/iOS 4개, :84-94 예외 4건, :160-162 plist 3건 제거`

engine 실측은 다르다 — 스캔 루트가 **`:44-53`으로 10개**이고, 그중 `.swift` 루트는 8개다:

```
44 clients/macOS/Sources          45 clients/macOS/XcodeHost
46 clients/iOS/MomoiOSKit/Sources 47 clients/iOS/XcodeHost
48 clients/mobile/ios/MomoPushKit          ← 삭제 금지 트리
49 clients/mobile/ios/MomoMobile           ← 삭제 금지 트리
50 clients/mobile/ios/NotificationService  ← 삭제 금지 트리
51 relay/PushRelay/Sources                 ← 삭제 금지 트리
52 clients/web/src                53 clients/mobile/src
```

즉 **"`:44-49` 중 4개 제거"를 문자 그대로 실행하면 `clients/mobile/ios/**`(RN 자체 네이티브, §9 금지 목록에 명시)의 스캔 루트를 지운다.** 예외 목록도 같다 — `:90`은 `clients/mobile/ios/MomoPushKit/PushNotification.swift`로 역시 금지 트리다.

> **정정 지시**: 좌표가 아니라 **경로 문자열로** 지워라 — 제거 대상은 `clients/macOS/Sources`·`clients/macOS/XcodeHost`·`clients/iOS/MomoiOSKit/Sources`·`clients/iOS/XcodeHost` 넷뿐이고, `clients/mobile/ios/*` 3개와 `relay/PushRelay/Sources`는 **남긴다**. 예외 목록도 `clients/macOS/…`·`clients/iOS/…` 접두만 제거한다.

### 11-I. 【미확인 해소】 §10-1 — `server/Fixtures`를 Rust는 소비하지 않는다

```
grep -rn "plugin-manifests\|Fixtures" server-rust/ --include='*.rs' --include='Dockerfile' --include='*.toml'  →  0건
```

**§10 미확인 #1을 닫는다: Rust `momo-server`는 `server/Fixtures/plugin-manifests/*.json`을 소비하지 않는다.** 다만 *소비자 0 ≠ 삭제 가능*이다 — Swift `server`·게이트·검증기 쪽 소비 여부는 이 절이 재지 않았다. §5-A가 `server/Fixtures`를 "남긴다"로 둔 보수적 처리는 유지하되, 그 사유는 이제 "Rust가 쓸지도 모른다"가 아니라 "Swift 쪽 소비자 미확인"으로 바뀐다.

### 11-J. 소거·정정 총계

| 구분 | 건수 | 항목 |
|---|---|---|
| **소거(닫힘)** | 4 | T9 웹 몫 · T10 웹 몫 · §10 미확인 #1(Fixtures) · §0-1 Blocker 전반부(증보 1 복원) |
| **정정(뒤집힘)** | 4 | §0 브랜치 전제 · §5-A `relay/OutboxRelay` 분류 · §3-2 B 웹훅/이벤트구독/첨부 3줄 · R7 등급·주소 |
| **수치 정정** | 2 | Migrations 62→63 (2자리: §1·§5-B) |
| **좌표 드리프트** | 5 | 11-G 표 |
| **신규 결함 적발** | 2 | §9 지시가 금지 트리 침범(11-H) · ADR-0145 증보 2 헤딩 중복(11-B) |
| **신규 티켓 제안** | 1 | T13 webhook/event-subscription 배달 소비자 Rust 이식 |

### 11-K. 부수 확인 — Xcode Cloud 전환 잔여 ⑥

`docs/planning/research/2026-08-06-xcode-cloud-transition.md:16`의 ⑥ = *"docs/cicd/10에 워크플로 정본 등재(현재 콘솔에만 존재하는 미기록 자산)"*.

**충족됐다.** `docs/cicd/10-ios-signing-identity-runbook.md`에 §8이 실재하며 하위 4절을 갖는다 — `:197` `## 8. Xcode Cloud — 이 레포의 유일한 자동 PR 체크 (정본)` / `:205` 8-1 무엇이 어디에 있나(체크 이름 `MomoiOS | Default` 포함) / `:218` 8-2 승계 근거 / `:230` 8-3 레포 책임분(#1115 랜딩) / `:253` 8-4 성재 콘솔 절차. 요약표 `:13`도 "레포 준비 완료(#1115)·ASC 콘솔 재지정만 성재 수동"으로 상태를 적는다.

**이 PR은 그 문서를 건드리지 않는다**(패킷 지시대로 보고만).
