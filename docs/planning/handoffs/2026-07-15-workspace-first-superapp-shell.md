# PLN-20260715-01 Workspace-first UX + Superapp Shell Handoff

## 1. 목적

2026-07-14 실창 QA를 ADR-0112 후속 실행 계약으로 전환하고, UX와 engine worker가 같은 파일을 건드리지 않도록 다음 goal의 경계를 고정한다.

## 2. 정본 읽기 순서

1. `docs/planning/CURRENT_STATE.md`
2. `docs/adr/0112-product-surface-realignment.md`
3. `docs/adr/0111-agent-work-surface.md`
4. `docs/planning/proposals/2026-07-15-workspace-first-superapp-shell.md`
5. `docs/planning/proposals/2026-07-14-superapp-engine-roadmap.md`
6. 해당 GitHub Issue 본문

## 3. UX buildable queue

| ID | 범위 | 선행 | 기본 gate | 상태 |
|---|---|---|---|---|
| MOMO-383 | workspace-first sidebar/header/menu + persisted workspace name | MOMO-382 | swift + runtime-db + macos-ui + design-review | merged — PR #389 / `9c1fc7a` |
| MOMO-384 (`#390`) | native channel creation sheet + tooltip presenter | MOMO-383 | swift + macos-ui + design-review | worker gates/review handoff |
| MOMO-385 (`#391`) | member inspector + one-click DM | MOMO-383 | swift + runtime-db + macos-ui | ready |
| MOMO-386 (`#392`) | RLS workspace search + macOS results/jump | MOMO-384, MOMO-385 | runtime-db + swift + macos-ui | blocked |
| MOMO-375 | Work transcript/activity drawer | ADR-0114 surface decision | swift + macos-ui | planned |

## 4. Engine planning queue

| ADR | owner surface | 결과 | UX lock |
|---|---|---|---|
| ADR-0113 | `docs/adr/0113-*`, `research/14-superapp-engine/` | credential/capability/action trust decision draft | `clients/macOS/**` 금지 |
| ADR-0116 | `docs/adr/0116-*`, `research/14-superapp-engine/` | memory/context retention draft | `clients/macOS/**` 금지 |
| ADR-0114 | `docs/adr/0114-*`, Work research | app-server/interactive host draft | `clients/macOS/**` 금지 |
| ADR-0115 | `docs/adr/0115-*`, webhook research | signed ingress draft | `clients/macOS/**` 금지 |

ADR draft는 구현/Accepted 판정이 아니다. 성재가 option과 trust boundary를 승인한 뒤에만 numeric builder issue를 ready로 바꾼다.

## 5. 구현 함정

- workspace name/icon은 현재 `@AppStorage` local draft다. MOMO-383은 `workspace.name`만 owner/admin REST로 영속화하고 icon/invite policy는 후속 범위로 명시한다.
- `MomoServerRESTChatBackend.search`의 최근 200개 client scan을 제품 검색으로 확장하지 않는다.
- custom tooltip의 `.overlay`에 zIndex만 올리는 수정은 pane clip을 넘지 못한다. window-level presentation 또는 system help로 구조를 바꾼다.
- member primary click은 self/inactive/failed 상태를 처리하고, DM creation은 기존 idempotent server route를 사용한다.
- raw PTY를 `Process`로 macOS 앱 안에 바로 추가하지 않는다. ADR-0114가 host, sandbox, cwd, credential, approval identity를 결정한다.
- multi-workspace UI는 session/token persistence 결정 전 fake rail을 만들지 않는다.

## 6. Review evidence

- Workspace issue: owner/admin rename, ordinary member denial, cross-client reload, Light/Dark, 1280-wide, narrow window, real window screenshot/AX check.
- DM issue: two members + one agent fixture, self/inactive disabled, idempotent open, channel navigation.
- Search issue: two workspaces RLS isolation, old message beyond first page, modifier parsing, jump target.
- Engine ADR: security + architecture independent review. Credential/token custody와 BYPASSRLS 변화는 explicit option matrix가 필요하다.

## 7. MOMO-383 checkpoint (2026-07-15)

- 구현: sidebar 최상단 workspace identity/native popover, toolbar capsule 제거, ADR-0118 active-member read + owner/admin durable rename REST, local-only icon/policy 경계, audit metadata.
- 리뷰 반려 수정: server+member+workspace cache scope, 401/403/404 cache 비노출, cached-name 경고/재시도, 409 conflict reload, 구 cache Codable 호환, 구체적 validation/permission/connection copy, verifier fixture 복원.
- correctness/performance review fix: stale GET/rename/session generation+monotonic guard, unknown error cache default-deny, cancellation 보존, demo cache 비영속, apostrophe SQL binding/restore 회귀를 추가했다.
- 검증됨: 두 client durable read, ordinary member/cross-workspace 403, apostrophe audit/restore, 전체 Swift 352 tests, worker `swift`/`macos-ui`, 표준 1180x760·좁은 900x650·fullscreen 실창 기하, design Blocker 0.
- merge 완료: momo-main이 PR #389를 main `9c1fc7a`로 merge했다.
- 후속: MOMO-384 `#390`와 MOMO-385 `#391`가 ready이며, 둘 다 merge된 뒤 MOMO-386 `#392`가 ready다.

## 8. MOMO-384 checkpoint (2026-07-15)

- 구현: inline channel form을 bilingual native sheet로 교체하고 server-aligned normalize/validation, first focus, Esc/default action, local readable error/retry, 성공 후 새 channel 자동 선택을 연결했다. write는 기존 REST backend만 재사용한다.
- tooltip: root named coordinate + root overlay presenter, 0.12s delay, intrinsic short width/280pt 3-line cap, window-edge clamp, source-ID stale dismiss, keyboard focus/VoiceOver hint, hit-testing off를 적용했다.
- 실창: standard 1180x760, narrow 980x620, fullscreen, light/dark, attached inspector가 열린 cross-pane에서 tooltip screenshot과 AX text/frame을 확인했다. quick-switcher scrim은 overlay가 hit area를 만들지 않아 background dismiss가 동작했다. native sheet는 별도 modal surface라 부모 control tooltip을 위에 띄우지 않는다.
- 리뷰 handoff: focused tests, Korean light·English dark·increased-contrast·large-text snapshots, fresh design-review Blocker 0 / High 0, clean `swift`/actual-launch `macos-ui`/docs gate를 PR evidence 정본으로 삼는다. merge/close는 momo-main만 수행한다.
