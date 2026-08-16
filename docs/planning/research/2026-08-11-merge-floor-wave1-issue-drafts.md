# Merge floor + Wave 1 Issue 초안 묶음

> Status: **draft / 실행 불가**
> Planning owner: sol · 2026-08-11 KST · 트랙: 엔진
> 기준 커밋: `915d00bff14fda55b909fcdda72067e3d480dbda`
> 입력: `2026-08-11-server-safety-release-work-plan.md` §4·§6.1
> 발급 조건: 관련 ADR Accepted, BUILD_TICKETS ID·수용기준 등록, goal별 ready handoff 생성, 이 세 정본이 worker의 canonical base branch에서 해당 Issue base SHA로 조회됨, 성재의 GitHub 발급 승인

이 문서는 GitHub Issue가 아니며 worker 착수 권한도 아니다. Checkpoint A 뒤 첫 실행 묶음을 1 goal=1 Issue=1 PR 형태로 검토하기 위한 본문 초안이다. 실제 발급 시 Acceptance를 BUILD_TICKETS 링크로 축약하고 각 goal을 별도 handoff packet에 결속한다.

## 0. 의존과 merge 순서

| 순서 | 임시 ID | 성격 | 선행 | merge 조건 |
|---:|---|---|---|---|
| 1 | G-1 | repo gate | ADR 불요: 기존 AGENTS [rust] 계약 복구 | 성재 승인 |
| 2 | G-2 | repo gate | **G-1 track landing 뒤 rebase** | 순차 merge |
| 3 | G-3 | GitHub desired-state | ADR-0100 기존 결정 집행 | 문서/스크립트 PR merge + 별도 maintenance 승인 |
| 4 | G-4 | GitHub security desired-state | SECURITY.md 기존 약속 집행 | G-3과 같은 maintenance window 가능 |
| 5 | G-5 | review/STATUS evidence gate | ADR-0100·AGENTS 기존 집행 | B-1 전 적용, Wave 3에서 재검증 |
| 6 | S-0 | live reactivation freeze/API truth | **ADR-0165 Accepted** + G-1~G-5 적용 | Checkpoint B-0 승인 |
| 7 | S-1 | server security | **ADR-0163 Accepted** + G-1~G-5 적용 | Checkpoint B-1 승인 |
| 8 | S-2 | server security/concurrency | **ADR-0164 Accepted** + G-1~G-5 적용 | B-1에서 S-1과 병렬 검수, 순차 merge |
| 9 | S-3 | worker availability | G-1~G-5 적용 | B-1에서 S-1/S-2와 병렬 검수, 순차 merge |
| 10 | S-4 | server abuse/order | **ADR-0163 Accepted** + G-1~G-5 | B-1에서 S-1 뒤 merge |
| 11 | S-5 | realtime disconnect floor | **ADR-0163·0165 Accepted** + S-0 landing | B-1에서 self-leave wiring 순차 merge |
| 12 | S-6a | authority episode ledger/grant/API staging | **ADR-0163·0165 Accepted** + S-0·S-5 landing | Checkpoint B-2a 승인 뒤 merge |
| 13 | S-6b | current capability terminalizers | **ADR-0162·0164·0165 Accepted** + S-2·S-6a landing | Checkpoint B-2b 승인 뒤 merge |

G-1~G-5가 적용되기 전 S-* 구현 worktree를 준비할 수는 있으나 `track/engine`에 landing할 수 없다. G-1/G-2는 `.github/workflows/pr-ci.yml`을 함께 소유하므로 병렬 구현하지 않는다. G-3/G-4의 외부 설정 적용은 PR merge와 별개의 승인 행동이고, `track/engine→main`도 별도 통합 승인이다. OpenAPI를 바꾸는 엔진 goal은 `clients/web-legacy/src/api/schema.d.ts` 기계 생성물만 같은 PR에서 재생성하고 runtime consumer를 고치지 않는다. web-legacy runtime 소비는 C-0a/C-1b/C-2b/C-6u/C-6v UXUI handoff가 소유한다.

---

## G-1 — Rust fmt·clippy merge gate 복구

**Severity:** High(process) · **검증:** `[rust] [ci]`

### Goal

문서와 CI가 실제 Rust 하드 게이트를 같은 명령으로 집행하고, 현재 main formatting drift를 제거한다.

### Context

- 문서의 `cargo fmt --check --manifest-path server-rust/Cargo.toml`은 virtual workspace에서 target을 찾지 못한다.
- 올바른 `cargo fmt --manifest-path server-rust/Cargo.toml --all --check`는 현재 main에서 실패한다.
- PR CI는 test/license만 실행해 fmt와 clippy를 집행하지 않는다.

### Acceptance

- 문서·Makefile·local gate·CI가 `fmt --all --check`와 `clippy --workspace --all-targets -- -D warnings`의 같은 계약을 사용한다.
- 현재 server Rust workspace formatting drift가 정리된다. 기능 diff나 무관 리팩터는 없다.
- formatting 또는 clippy red fixture를 넣은 synthetic PR/fixture에서 gate가 실패한다.
- server-rust workspace test와 cargo license gate가 유지된다.
- goal 종료 시 `track/engine` tree가 green이다. `main` green은 별도 `track/engine→main` 통합 패킷과 승인 뒤 확인한다.
- PR 본문에 current main 선재 drift와 실제 변경 파일을 분리해 기록한다.

### Out of scope

- rust-toolchain pin, dependency update, ignored PG runtime suite의 CI 편입.

---

## G-2 — infra/security 경로 성공-skip·web gate 공백 제거

**Severity:** High(process) · **검증:** `[ci] [infra]`

### Goal

`infra/**`, 보안·배포 gate script, workflow 변경이 PR CI에서 두 레인 모두 성공-skip되는 경로를 없애고, node lane을 문서의 web hard gate와 맞춘다.

### Context

현재 path filter는 `server-rust`, client/package와 일부 license script만 본다. compose, Caddy, secret scanner, release workflow, 다수의 gate script가 바뀌어도 required check 후보가 성공으로 끝난다.

### Acceptance

- PR trigger는 `main`, `track/engine`, `track/uxui` 세 base에서 같은 required context를 만든다.
- G-2가 `track/engine`에 landing된 뒤 별도 승인으로 `track/engine→main`, 이어 현재 stale인 `main→track/uxui` sync를 완료한다. 그 전에는 UXUI required context가 존재한다고 주장하지 않는다.
- path 분류를 rust/node/docs-static/infra-security 중 명시된 lane으로 fail-closed 라우팅한다.
- 최소한 `infra/**`, `.github/**`, `clients/web-legacy/**`, `scripts/check_*`, `scripts/prod_*`, `scripts/verify_*`, `SECURITY.md`, `docs/SELF_HOST.md`, `docs/DEPLOY.md` 변경은 적절한 정적 gate를 실행한다.
- gitleaks full-history baseline gate가 보안 lane의 필수 단계다. raw finding report나 secret value를 artifact에 쓰지 않는다.
- path classifier에 infra-only, web-legacy-only, script-only, workflow-only, unknown-path red/green fixture가 있고, 위 sync 뒤 세 base 각각을 대상으로 한 synthetic PR에서 동일 check context 생성을 관측한다.
- 기존 Rust/Node lane의 변경 감지와 cancel-in-progress 동작은 유지한다.
- web lane은 typecheck/test뿐 아니라 lint·Vite production build·정본 browser gate를 실행한다. #1268의 mobile 제외는 승인된 좁은 예외로 표면화하고 조용히 전체 gate를 skip하지 않는다.

### Out of scope

- public image publish, production 배포, 실제 secret push, 모든 runtime-db suite의 Actions 실행.

---

## G-3 — main/track-engine/track-uxui merge governance desired-state

**Severity:** High(process) · **검증:** `[ci] [manual]`

### Goal

ADR-0100과 트랙 계약을 GitHub required checks/reviews/conversation resolution으로 집행 가능한 desired-state로 만든다.

### Context

현재 main과 track/engine은 force-push/delete만 금지하고 `track/uxui`는 branch protection 자체가 없다. required status checks·PR review·conversation resolution·admin enforcement가 비어 있고 ruleset도 없다.

### Acceptance

- repo에 redacted desired-state 파일 또는 멱등 dry-run/apply 스크립트와 rollback runbook이 있다.
- main, track/engine, track/uxui 각각 required checks, 최소 승인 수, stale approval 처리, conversation resolution, admin/bypass 주체를 표로 명시한다. G-2가 세 base에서 실제 생성하는 동일 check context만 require한다.
- `--dry-run`은 현재↔desired diff만 출력하며 원격을 바꾸지 않는다.
- apply는 명시 확인/대상 repo 검증 없이는 실행되지 않고, secret/token을 출력하지 않는다.
- 성재 maintenance 승인 후 적용하고 GitHub API 재조회 결과가 desired-state와 일치한다.

### Out of scope

- Issue 발급 자동화 전면 교체, 조직 전역 ruleset, merge queue 도입.

---

## G-4 — 취약점 신고·secret push 방어 desired-state

**Severity:** High(ops) · **검증:** `[ci] [manual]`

### Goal

SECURITY.md가 약속한 private reporting과 GitHub secret scanning/push protection을 실제 저장소 설정에 결속한다.

### Context

private vulnerability reporting, secret scanning, non-provider pattern, push protection이 꺼져 있다. SECURITY.md의 private advisory URL은 외부 신고자가 사용할 수 없는 약속이다.

### Acceptance

- G-3과 같은 desired-state/dry-run/apply/rollback 규율로 네 설정을 명시한다.
- private vulnerability reporting form을 외부 비관리자 관점에서 확인한다.
- 성재가 제공했거나 별도로 생성을 승인한 disposable fixture repository 또는 GitHub 제공 test pattern으로 push protection 동작을 검증한다. fixture repo 생성·push도 별도 외부 상태 변경이며 묵시적으로 수행하지 않는다. oort 이력에 실제 secret을 만들지 않는다.
- gitleaks CI와 GitHub scanning의 담당 범위·false-positive 처리·incident owner를 runbook에 쓴다.
- Dependabot alerts/updates의 현재 정책을 명시하고 변경 여부는 성재가 별도 선택한다.

### Out of scope

- 실제 credential 회전, 과거 attachment/Actions artifact 완전 포렌식, 유료 보안 제품 도입.

---

## G-5 — formal review·STATUS/DEVIATION/ADR evidence gate

**Severity:** High(process) · **검증:** `[ci] [docs]`

### Goal

경계 변경이나 대형 server PR이 formal review, STATUS 영향, 계획 이탈, Accepted ADR 증거 없이 track/main 후보가 되는 경로를 fail-closed한다.

### Context

#1284~#1286은 review evidence와 STATUS 갱신이 없거나 Proposed ADR 상태에서 boundary code가 landing됐다. 사람 규율만으로는 같은 누락을 자동 거부하지 못한다.

### Acceptance

- PR template/static gate가 `formal review`, `STATUS 영향`, `계획 이탈`, `Accepted ADR 또는 기존 계약 복구 근거` 필드를 machine-readable하게 확인한다.
- public API·secret/token/scope/RLS·DB schema·제품 방향·stack 경계 파일이 바뀌면 Accepted ADR 링크가 없을 때 red다.
- review conversation resolution과 최소 승인은 G-3 desired-state가 집행하고, G-5는 그 설정/결과를 evidence로 확인한다. 자체 우회 승인자를 만들지 않는다.
- no-STATUS/no-deviation/no-ADR fixture는 red, 문서-only 무경계 변경과 명시적 “영향 없음/이탈 없음” fixture는 green이다.
- 첫 S-* landing 전 적용되고 Wave 3 시작 전 계속 집행되는지 재검증한다.

### Out of scope

- ADR 내용을 자동 판정, 성재 승인 대행, 과거 PR 기록 재작성.

---

## S-0 — live same-ID reactivation freeze·membership API truth

**Severity:** High(security/contract) · **검증:** `[rust] [runtime-db] [api]`

### Goal

현재 공개 `POST /v1/join`의 deleted-human same-ID reactivation을 안전화 완료 전 fail-closed하고, Rust에 없는 membership-admin operations를 OpenAPI가 이미 제공한다고 주장하는 drift를 전수로 닫는다.

### Dependency

**ADR-0165 Accepted와 G-1~G-5 적용이 선행한다.** 이 goal은 identity를 새 member ID로 우회하거나 partial terminalizer 상태에서 reactivation을 허용하지 않는다.

### Context

현재 join service는 deleted human을 같은 `member.id`로 즉시 active 전환하고 새 workspace/channel authority를 만든다. join은 self-leave와 공용 membership lock을 쓰지 않으며 old writer generation fence도 없다. 반대로 OpenAPI의 workspace role PATCH, channel self-leave/role PATCH, admin suspend/reinstate/remove와 ban list/create/delete는 Rust router에 mount되지 않았다.

### Acceptance

- `/v1/join` deleted-human branch의 첫 단계는 self-leave/role mutation과 같은 workspace membership-mutation lock과 shared DB/fleet reactivation mode를 확인한다. mode가 closed면 stable `reactivation_not_ready` 오류, member/workspace/channel/token/audit side effect 0이다.
- 신규 identity의 정상 join은 회귀하지 않고 cross-tenant/invite/ban/last-owner 계약을 약화하지 않는다.
- DB writer-generation fence가 old join binary의 deleted→active 전환을 거부한다. app flag만으로 보호했다고 주장하지 않는다.
- 현재 mount되지 않은 workspace role PATCH, channel self-leave/role PATCH, admin suspend/reinstate/remove와 ban list/create/delete는 새 route를 만들지 않는다. published OpenAPI/generated surface는 각 operation의 실제 runtime unavailable 상태와 일치하고, 향후 C-6c/C-6d가 full lifecycle/channel-access contract와 함께 추가한다.
- leave↔join barrier test가 lock order대로 수렴하고 join commit 뒤 별도 token mint가 closed branch에서 절대 실행되지 않는다.

### Out of scope

- authority episode schema/grant(S-6a), capability terminalizer(S-6b), channel `left_at` 전환(C-6a), workspace/channel membership-admin route 구현(C-6c/C-6d), reactivation gate open(C-6b).

---

## S-1 — active principal 공통 인가

**Severity:** High(security) · **검증:** `[rust] [runtime-db]`

### Goal

정지·탈퇴한 human의 살아 있는 bearer가 presence 조회/변경과 availability grant/publish를 수행하지 못하게 공통 lifecycle predicate를 적용한다.

### Dependency

**ADR-0163 Accepted가 선행한다.** presence GET/PUT은 active-human workspace predicate를, availability grant/subscribe는 그 위에 live/non-archived channel membership을 합성한다. 모든 route에 channel membership을 요구하는 것으로 확대 해석하지 않는다.

### Context

토큰 저장소와 `require_human`은 principal kind만 확인한다. presence와 `is_channel_member`는 active member/workspace role/channel membership을 완전히 결속하지 않아, 토큰 revoke와 경쟁하거나 잔여 JWT가 있으면 권한이 남는다.

### Acceptance

- workspace predicate가 `member.kind=human`, `member.status=active`, non-deleted, active workspace membership을 확인하고, channel predicate만 non-archived channel과 live/non-left membership을 추가한다.
- suspended/deleted/left/invited/nonmember/cross-tenant bearer는 GET/PUT presence와 availability grant/publish에서 403/404 계약대로 실패한다.
- 실패 경로는 member update, outbox INSERT, availability publish, grant 발급이 0이다.
- 정상 active human과 self/shared channel 경로는 회귀하지 않는다.
- 실제 HTTP bearer를 사용한 PG18 negative tests가 일반 unit test와 분리돼도 실행 명령/evidence를 남긴다.

### Out of scope

- 전역 token revocation 재설계, agent/work-host auth 모델 변경, presence event revision.

---

## S-2 — workspace avatar 최종 tx 재인가

**Severity:** High(security/concurrency) · **검증:** `[rust] [runtime-db]`

### Goal

외부 Drive 왕복 중 권한이 회수되면 avatar upload create/complete가 DB pointer나 audit을 commit하지 못하게 한다.

### Dependency

**ADR-0164 Accepted가 선행한다.** 최종 tenant transaction의 엄밀한 active human owner/admin gate, platform override 제외, 공용 workspace lock은 권한 경계 결정이므로 Proposed 상태에서 구현하지 않는다.

### Context

현재 route는 Drive 호출 전에 owner/admin을 확인하지만 최종 transaction에서 다시 확인하지 않는다. attachment 경로에는 같은 종류의 재검사가 이미 있다.

### Acceptance

- create의 Drive session 왕복 뒤 pending INSERT 직전과 complete의 metadata/body 왕복 뒤 pointer settle 직전에 active human owner/admin을 tenant transaction에서 다시 확인한다. complete는 기존 media/uploader/workspace/state도 같은 transaction에서 잠가 재검사한다.
- self-leave와 demotion/role transfer의 현행 canonical mutation과 동일 workspace에서 직렬화되는 row/advisory lock 계약을 한 곳에 둔다. 현재 Rust에 없는 admin endpoint를 이 goal에서 mount하지는 않는다.
- barrier 가능한 fake Drive로 `gate 통과 → 권한회수 commit → Drive 반환` 순서를 강제했을 때 create pending/pointer·성공 audit은 0이다. 외부 session/object의 durable pre-intent+authority snapshot 회수는 S-6a 뒤 C-4a에서 닫는 명시적 후속이다.
- 정상 owner/admin, non-operator, last-owner/self-leave 경로가 green이다.
- 권한회수 없이 정상 owner/admin이면 현행 upload/complete shape와 audit이 유지된다.

### Out of scope

- `allocating` durable pre-intent와 authority-episode snapshot(C-4a), digest URL, image decode/re-encode, 전체 avatar GC(C-5), Drive backend 교체.

---

## S-3 — outbound webhook response body bounded drain

**Severity:** Medium(security/availability), Wave 1 P0 · **검증:** `[rust]`

### Goal

외부 subscriber가 큰 HTTP response body로 256MiB webhook sender를 OOM시키거나 sequential drain을 막지 못하게 한다.

### Context

delivery client는 status만 필요하지만 성공/error response에서 `response.bytes().await`로 body 전체를 collect한다. 5초 timeout은 빠르게 전송되는 큰 body의 메모리 상한이 아니다.

### Acceptance

- response body를 읽지 않고 폐기하거나 명시된 작은 byte cap까지만 stream한다. `bytes().await` 전체 collect가 없다.
- local mock이 cap보다 큰/끝없는/chunked body를 보낼 때 요청 timeout과 process memory가 bounded이고 다음 delivery가 처리된다.
- 2xx/4xx/5xx retry·auto-disable·audit 의미가 유지된다.
- body 내용은 log/error/audit에 남지 않는다.
- cap/timeout이 config라면 안전한 상한·하한과 invalid-value fail behavior를 단위 테스트한다.

### Out of scope

- request body 크기 변경, outbound SSRF 재설계, 동시 worker 아키텍처 변경.

---

## S-4 — presence no-op·rate·fanout budget

**Severity:** High(availability) · **검증:** `[rust] [runtime-db]`

### Goal

같은 declared presence의 반복 PUT과 burst가 `요청 수 × channel 수`만큼 outbox row/publish를 만들지 못하게 하고, 상태 전이 한 건의 channel 축도 500으로 봉인한다.

### Context

현재 PUT은 same-value 여부와 rate limit 없이 member UPDATE와 모든 소속 channel fanout을 반복한다. availability limiter도 검증 전 high-cardinality channel key를 만들 수 있다.

### Acceptance

- 구현 전 실제 PG18에서 active channel 0/1/100/500의 latency·WAL·outbox 수 baseline을 측정하고 수용 budget과 함께 PR evidence에 남긴다. 이 증거 없이 상수만 정했다고 완료하지 않는다.
- **ADR-0163 Accepted** 계약의 member별 durable limiter, 429/Retry-After, same-value와 exact 500 hard-cap semantics를 구현한다.
- same-value PUT은 authority shared 아래 status를 읽고 member row lock 뒤 재확인해 200을 반환하며 상태·updated_at·revision·outbox/audit는 모두 0이다. member row를 쥔 채 channel-set lock을 후획득하지 않는다.
- changed path만 transaction을 내부 재시작해 workspace authority shared → channel-set shared → actor의 live channel UUID 오름차순 shared lock을 잡고 lock 뒤 status/집합을 재조회한다. active shared channel 500개의 transition은 최대 500 outbox로 성공하고, changed 501개는 409이며 status/revision/updated_at/audit/outbox가 모두 0건 변한다. **501채널 same-value는 200+write 0**이다. 부분 fanout이나 500개만 잘라 성공하지 않는다.
- channel archive/join/leave와 barrier 경합에서 archive/full-purge가 먼저 commit한 뒤 옛 channel snapshot 기반 status frame이 더 큰 revision으로 재등장하지 않는다.
- 신뢰 가능한 authenticated principal의 member-wide limiter는 PUT DB transaction·grant predicate 검증보다 먼저 건다. grant mint는 `member-wide limiter → DB predicate → verified-channel bucket → sign`, availability는 `member-wide limiter → grant 검증 → verified member/channel bucket → publish` 순서다. 임의 UUID/invalid grant가 channel bucket을 만들거나 DB·검증 비용을 member budget 밖에서 증폭할 수 없다.
- channel 수 0/1/100/500, `501×same-value`, `501×changed`, 두 기기 concurrent PUT, rate-window 경계 test가 있다.

### Out of scope

- monotonic revision wire/schema(C-2), roster privacy(C-3), 공개 `busy`/비공개 `pauseAll` 알림 경계(ADR-0162).

---

## S-5 — realtime disconnect effect·TTL floor

**Severity:** High(security) · **검증:** `[rust] [runtime-db] [runtime]`

### Goal

현재 Rust에 존재하는 workspace/channel membership 종료 뒤 이미 열린 Centrifugo 구독이 무기한 channel message/presence를 계속 받는 lag를 dedicated durable disconnect effect와 검증 가능한 token TTL fence로 닫는다.

### Dependency

**ADR-0163 D1·ADR-0165 D2 Accepted와 S-0 track landing이 선행한다.** 이 goal은 “전달 시점 SQL 재검사”를 가장하지 않고, 즉시 DB revoke + post-commit disconnect + short-lived connection의 명시적 bound를 구현한다.

### Context

subscribe proxy는 새 구독 시 active token/membership을 검사하지만 이미 열린 subscription에는 재호출되지 않는다. connection token은 현재 최대 1800초까지 가능하다. 현행 outbox는 broadcast/agent/push/webhook만 알고 relay는 publish만 처리하므로 disconnect는 단순 route hook이 아니라 새 effect rail이다. admin suspend/reinstate/remove는 아직 Rust에 없다.

### Acceptance

- outbox enum/migration에 versioned `RealtimeDisconnect {subject}`를 추가하고 broadcast와 분리된 claim/retry/settlement/idempotency를 둔다. S-5 시점의 legacy subject도 effect payload에 명시해 relay가 member ID를 재구성하지 않는다.
- relay는 dedicated Centrifugo disconnect client로 committed effect만 호출하고 transient 실패를 retry한다. API route나 lifecycle transaction이 broker를 직접 호출하지 않는다.
- 현행 self-leave와 workspace/channel membership 종료 중 실제 Rust에 존재하는 경로 전부가 같은 commit에 effect를 넣는다. 미구현 admin suspend/remove/reinstate를 연결했다고 주장하지 않고, C-6c workspace lifecycle과 C-6d channel self-leave가 같은 canonical primitive를 소비하도록 handoff/contract test를 남긴다.
- connection token TTL은 60초 이하, clock leeway는 5초 이하이며 refresh/reconnect는 active credential과 route별 membership predicate를 다시 확인한다.
- rollout은 TTL을 먼저 낮추고 과거 최대-TTL connection을 drain한 뒤 65초 보장을 활성화한다. drain 이전·broker outage 범위를 검증되지 않았다고 명시한다.
- barrier test에서 self-leave commit 이후 새 REST/grant/subscribe는 즉시 실패하고, 정상 broker의 기존 connection은 disconnect된다. disconnect API가 계속 실패해도 **TTL clamp 배포와 기존 max-TTL connection drain을 증명한 뒤에만** 기존 connection이 65초 안 종료된다고 판정한다.
- 다른 workspace/member connection은 끊지 않고, duplicate disconnect와 이미 끊긴 user는 성공적 no-op이다.

### Out of scope

- message별 broker authorization query, channel key rotation, notification delivery intent 자체(C-1a), Centrifugo 교체.

---

## S-6a — authority episode ledger·grant/realtime API staging

**Severity:** High(security) · **검증:** `[rust] [runtime-db] [runtime]`

### Goal

영속 authority episode ledger를 도입해 옛 grant가 새 token/episode와 결합되지 않게 하고, personal-rail cutover에 필요한 exact-channel API를 동작 변경 없이 staging한다. same-ID rejoin과 future reinstate는 계속 fail-closed한다.

### Dependency

**ADR-0163·0165 Accepted와 S-0·S-5 track landing이 선행한다.** ADR이 정한 별도 authority episode/counter, writer fence와 shared/exclusive membership lock을 구현한다.

### Context

현재 grant는 member/workspace/channel만 서명하고 Centrifugo `sub`·user-limited rail은 member ID만 쓴다. realtime-token response는 token/member만 반환하고 live web-legacy는 `user:read-state#<member>`를 직접 만든다. 따라서 서버 subject를 이 goal에서 바로 flip하면 read-state가 끊긴다. 동시에 device/WorkHost terminalizer가 아직 준비되지 않아 reactivation gate도 열 수 없다.

### Acceptance

- RLS FORCE `workspace_authority_episode(workspace_id,id,member_id,generation,state,started_at,ended_at)` 영속 ledger를 만들고 `(workspace_id,id)`를 same-tenant FK target으로 제공한다. `workspace_membership.authority_episode_id`는 current pointer일 뿐 episode 이력 자체가 아니다. membership delete는 ledger/child snapshot을 cascade-update/delete하지 않고 current-pointer+episode-state mismatch가 claim을 막는다.
- rollout은 nullable ledger/current membership·token·active channel binding+compatibility trigger expand → existing row backfill → workspace create, 신규 human join, agent provisioning, login/refresh/token mint, channel join/rejoin writer generation-2 전면 배포 → message/read-state/search/attachment/subscribe/grant/notification/presence/agent/work-session을 포함한 channel-auth reader 전수 gen2 배포 → old writer/reader process·lease 0 → DB contract flip/legacy NULL write red → NULL 0·NOT NULL/composite FK validate 순서다. machine-readable reader/writer inventory는 unclassified 0이어야 하고 old private/DM row+새 episode token은 모든 reader에서 0 row/403이다. 정상 신규 identity join/create는 혼합 창에도 green이고 S-0 same-ID reactivation/async-close freeze는 trigger로 우회되지 않는다.
- workspace 단조 authority counter와 shared/exclusive mutation lock을 추가한다. suspend→reinstate 같은-row fixture도 episode ID/generation이 회전하지 않으면 red다.
- ephemeral grant는 non-null issuer token ID와 current `authority_episode_id`를 서명하고 publish principal의 두 ID가 모두 같을 때만 허용한다. leave 전 grant+새 token/episode 조합은 TTL 안에도 403이고 availability SQL 0 계약은 유지한다.
- realtime-token response에 additive `authorityEpisodeId`, 실제 `personalRailSubject`, exact `readStateChannel`을 싣고 OpenAPI/runtime/generated shape를 맞춘다. **이 goal에서는 subject와 publish를 legacy member-only로 유지**하며 필드도 그 exact legacy 값을 가리킨다.
- S-5 disconnect와 TTL fence는 유지하지만 episode subject/dual-publish/episode-only activation은 C-0a/C-0b 범위다. web/mobile/web-legacy client 선행 없이 flip하는 flag나 숨은 경로는 없다.
- S-0의 DB/fleet gate는 live `/join` deleted reactivation과 future reinstate를 계속 거부한다. `/join`은 S-6b, C-0a/b, C-1a/c, C-2a/c, C-6a/u/b와 client/server drain 전에는 열 수 없다. admin human reinstate는 여기에 C-6c dormant route→C-6v UXUI/old-client 0→C-6e human-only activation이 추가로 완료되기 전에는 열 수 없다.

### Out of scope

- episode personal-rail behavior flip(C-0a/b), push device·WorkHost·agent ownership·memory grant·avatar terminalizer(S-6b), notification/presence output(C-1/C-2), self-leave·bounded `/join` contract/client/activation(C-6a/u/b), membership-admin·dormant reinstate route(C-6c/d), reinstate UX/activation(C-6v/e), 과거 소유 데이터 삭제.

---

## S-6b — current capability terminalizers·closed inventory

**Severity:** High(security) · **검증:** `[rust] [runtime-db] [runtime]`

### Goal

현행 self-leave에서는 authority episode 종료를 O(1) claim fence로 만들고 고정된 subsystem별 cursor가 member-bound credential·ownership·staged action을 500/page로 materialize한다. 아직 unmounted인 role change에는 잃은 role이 필요한 action만 즉시 deny하는 selective fence+cursor를 준비해 같은 `member.id` 재활성화나 권한 재상승으로 과거 capability가 되살아나지 않게 한다.

### Dependency

**ADR-0162·0164·0165 Accepted와 S-2·S-6a track landing이 선행한다.** same-ID rejoin gate는 시작부터 끝까지 off이고, 공용 membership-mutation transaction은 authority-episode 또는 명시적 capability-loss fence와 schema-constant cursor head만 원자적으로 만들며 각 소유 모듈의 물리 terminalizer는 bounded cursor page로 실행된다.

### Context

current code의 APNs token, WorkHost key, `agent.owner_human_id`, `memory_visibility_grant.grantee_id`, avatar pending row는 member ID 또는 소유 ID만 본다. token revoke 뒤 같은 member가 active가 되면 이전 capability가 다시 target/권한으로 선택된다.

### Acceptance

- nullable same-tenant `push_token.registration_authority_episode_id`를 expand하고 existing token을 당시 current episode로 backfill하며 증명 불가 row는 invalidate한다. register/same-row re-register/lifecycle invalidation writer와 live push target reader를 gen2로 배포해 old process/lease 0→legacy NULL/binding write red→NULL0/FK validate 순서로 닫는다. **leave/suspend/remove** commit 즉시 old registration episode expansion/claim이 실패하고 cleanup을 멈춘 leave→future rejoin→새 candidate에서도 old token target은 0이다. current episode로 명시 재등록하기 전 새 target은 0이며 generation snapshot/transition은 후속 C-1a가 이 binding을 재사용한다.
- full lifecycle commit 즉시 old episode의 WorkHost signature·control/attach claim이 실패한다. cursor가 owned WorkHost revoke, auto-approve·terminal attach·미종결 host control을 최대 500/page로 terminalize한다. role-only mutation은 그 capability가 새 role을 실제로 요구하지 않는 한 건드리지 않는다.
- human full lifecycle commit 즉시 old episode 기반 agent edit/work-session owner claim이 실패한다. cursor가 떠나는 human을 가리키는 `agent.owner_human_id`를 최대 500/page로 NULL 해제하고 old/new를 audit한다. 별도 dormant agent suspend/remove fence는 old run/job lease의 새 step claim을 즉시 막고, cursor가 nonterminal `agent_run`과 live `work_session`을 최대 500/page로 `cancelled`/`ended` materialize하며 durable stop effect를 retry한다. human self-leave와 단순 role change는 agent run을 근거 없이 끝내지 않는다.
- full lifecycle commit 즉시 member-grantee explicit memory grant와 inventory가 찾은 동급 grant의 claim이 episode mismatch로 실패하고 cursor가 최대 500/page로 revoke한다. role-only mutation은 grant 자체가 잃은 role을 요구한다고 명시된 경우만 닫고, 다른 grantee에게 준 조직 grant는 근거 없이 취소하지 않는다.
- 현행 avatar pending row를 닫을 최소 `abandoned` 상태와 `workspace_id`·RLS FORCE cleanup-intent queue/cursor primitive를 이 goal의 forward migration으로 추가한다. full lifecycle 또는 owner/admin role 상실 commit은 complete final predicate를 즉시 deny하고 고정 cursor head만 enqueue하며, cursor가 pending→abandoned+GC enqueue를 최대 500/page로 수행한다. role 상승/동급 변경은 닫지 않는다. immutable 영속 authority-episode snapshot/composite FK와 durable `allocating` pre-intent는 S-6a ledger 위 C-4a가 같은 queue를 재사용해 추가한다.
- avatar 전용 `workspace_membership.avatar_operator_generation`을 expand/backfill하고 현행/future role writer가 공용 lock에서 owner/admin capability `있음→없음`일 때만 정확히 +1, capability 유지·획득 때는 불변이 되도록 dormant DB transition fence를 둔다. avatar staged action은 old operator-generation snapshot과 mismatch면 cleanup 전에도 claim 0이며 demotion→cleanup 정지→재승격 fixture가 과거 action을 되살리지 않는다. owner↔admin·member→operator 전이는 기존 upload를 닫지 않는다. 다른 subsystem은 의미가 같다는 별도 계약 없이 이 counter를 재사용하지 않는다.
- migration/query scan의 machine-readable closed inventory는 member/owner/grantee/credential/staged row마다 identity-history 보존, authority-episode 또는 명시적 capability-loss binding, lifecycle cleanup, 명시적 조직 소유 유지 중 하나를 요구한다. unclassified 0이고 새 미분류 fixture가 gate를 red로 만든다.
- self-leave full fence, dormant agent suspend/remove fence, dormant selective role-loss fence는 공용 lock에서 authority/role mutation+schema-constant cursor head까지만 원자 commit한다. token/push/WorkHost/owner/grant/avatar/run 각각 0/1/500/501/5,000 fixture에서 authority transaction의 child lock/UPDATE는 0, cursor head 수는 상수, page lock/UPDATE는 최대 500이고 page 실패가 이미 닫힌 authority를 rollback하지 않는다. 모든 auth/claim reader는 cursor 정지 중에도 old episode/role을 거부한다. human self-leave와 role 상승/동급 변경 fixture에서는 unrelated agent run이 보존되고 owner/admin 상실 fixture에서는 해당 pending avatar만 bounded cleanup된다. C-6c의 future agent suspend/remove만 dormant stop을 호출한다. future human reinstate가 old capability를 재사용하지 못한다는 service-level fence fixture만 준비하며 새 episode/cursor 활성화는 C-6a/C-6e 소유다. agent reinstate는 별도 pairing/reissue 전 409다. reactivation gate와 membership-admin route는 이 goal에서 계속 off/unmounted다.

### Out of scope

- notification decision/intent(C-1a), presence revision/invalidation(C-2a), durable avatar `allocating`/digest/GC worker(C-4a/C-5), channel history·join/reinstate cursor(C-6a)·join activation(C-6b), membership-admin/reinstate UX·activation(C-6c/v/e)·channel parity(C-6d), 과거 message/audit/workstream 삭제, credential 자동 재발급.

## 발급 전 체크

- [ ] ADR-0162~0166의 성재 판정과 필요한 Accepted 전환이 끝났다.
- [ ] G-1~G-5 각각 BUILD_TICKETS ID와 goal별 handoff가 생겼다.
- [ ] S-0가 live `/join` reactivation gate와 전체 membership-admin OpenAPI/runtime truth를 링크한다.
- [ ] S-3의 “ADR 불요=기존 계약 복구” 근거를 momo-main이 확인했다.
- [ ] S-1이 ADR-0163 D1의 Accepted route별 predicate를 링크한다.
- [ ] S-2가 ADR-0164의 Accepted 수용기준과 lock/strict-owner 계약을 링크한다.
- [ ] S-4가 ADR-0163 수용기준을 링크한다.
- [ ] S-5가 ADR-0163 D1·ADR-0165 D2의 Accepted disconnect effect/TTL fence를 링크하고 미구현 admin route를 범위 밖으로 둔다.
- [ ] S-6a가 ADR-0163·0165의 Accepted persistent authority episode ledger/grant/API staging을 링크하고 personal-rail flip 0을 명시한다.
- [ ] S-6b가 ADR-0162·0164·0165의 Accepted full/selective episode fence·bounded cleanup/closed inventory를 링크하고 C-0a/b·C-1a/C-2a/C-4a/C-5/C-6a/u/b/c/v/e/d를 범위 밖으로 명시한다.
- [ ] 파일 소유권·병렬 worktree·순차 merge 순서를 `docs/MULTI_SESSION_OPS.md`와 대조했다.
- [ ] 성재가 GitHub Issue 발급과 G-3/G-4 maintenance 적용을 별도로 승인했다.
