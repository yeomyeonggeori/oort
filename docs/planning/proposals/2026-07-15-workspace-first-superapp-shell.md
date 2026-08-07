# Workspace-first Messenger + Superapp Shell 실행 제안

> Planning lane: `PLN-20260715-01`
> Owner: `momo-main`
> Date: 2026-07-15
> Status: Approved direction, buildable issue split pending
> Inputs: 2026-07-14 성재 실창 QA 12건, ADR-0112, ADR-0111, PLN-20260714-02

## 1. 한 줄 결정

oort의 기본 셸은 **workspace/server → channel/DM → timeline** 위계를 먼저 읽히게 하고, Work·terminal·agent 실행은 같은 타임라인의 governed execution surface로 확장한다. 메신저 기본기와 슈퍼앱 엔진을 한 화면에 섞되, 구현 책임과 신뢰 경계는 분리한다.

## 2. 이번 QA에서 확인된 문제

### 2.1 정보 구조

- workspace가 toolbar의 glass capsule로 떠 있어 channel보다 상위 컨텍스트라는 사실이 약하다.
- server/workspace 이름 변경, 설정, ID 복사, 향후 workspace 전환의 진입점이 흩어져 있다.
- channel 생성이 sidebar 안에서 펼쳐져 탐색 목록을 밀어낸다.
- member row의 primary click이 DM이 아니라 선택/hover 장식에 머문다.
- member directory가 대형 modal이라 대화 컨텍스트와 분리된다.

### 2.2 상호작용 결함

- custom tooltip이 행 내부 overlay로 그려져 sibling pane/clip 경계를 넘을 때 잘린다.
- DM REST는 구현됐지만 sidebar member row에서 좌클릭 primary action으로 연결되지 않았다.
- real backend search가 각 channel의 최근 200개 history를 순회하므로 오래된 메시지, 대규모 workspace, 서버 부하 관점에서 제품 검색 계약이 아니다.

### 2.3 슈퍼앱 경계

- `Control+backtick` 요구는 두 단계다.
  1. Accepted ADR-0112의 Work transcript/activity drawer.
  2. 사용자가 명령을 입력하는 interactive Work Console.
- 2단계는 Accepted ADR-0111의 raw PTY non-goal을 바꾸며, credential/process/sandbox/approval 경계를 포함한다. ADR-0114 승인 전에 UI만 먼저 구현하지 않는다.

## 3. 레퍼런스에서 채택할 문법

- **Discord:** server/workspace를 channel보다 상위 탐색 단위로 둔다. oort v0는 현재 workspace header를 sidebar 최상단에 고정하고, multi-workspace는 후속 rail/switcher ADR에서 확정한다.
- **Mattermost:** search는 workspace/team 범위와 `from:`/`in:`/date modifier를 지원하고 결과에서 원문으로 jump한다. oort v0는 message/member/mention 결과와 channel context jump를 최소 계약으로 삼는다.
- **Codex/Orca/Conductor:** terminal 한 장이 아니라 task별 workspace/branch/process/transcript/diff/review가 핵심이다. oort는 raw shell을 메신저에 붙이는 대신 `agent_run`과 approval/audit ledger를 중심으로 Work Console을 만든다.
- **macOS:** channel creation은 native sheet, member/context detail은 inspector, workspace commands는 Menu/commands를 우선한다.

## 4. 실행 분할

### 4.1 UX lane: 즉시 buildable

#### MOMO-383 Workspace-first navigation

- toolbar workspace capsule 제거.
- sidebar 최상단에 workspace icon/name/현재 사용자 또는 상태를 표시.
- primary click menu: workspace 설정, 이름 변경 진입, ID 복사, 멤버 초대.
- owner/admin 전용 workspace name read/update REST를 추가해 이름 변경이 재로그인·다른 클라이언트에서도 유지되게 한다. 현재 `@AppStorage` name draft는 server value cache/fallback으로 격하한다.
- workspace icon과 invite policy의 서버 영속화는 이 goal에서 가짜로 만들지 않고 후속 settings API 범위로 명시한다.
- multi-workspace는 아직 가짜 server rail을 만들지 않고 `Add workspace...` disabled/planned affordance도 노출하지 않는다.

#### MOMO-384 (`#390`) Native channel creation + tooltip layer

- channel `+`는 native sheet를 연다.
- public/private, name, topic, validation, loading/error를 sheet 안에서 제공.
- tooltip을 row-local overlay가 아닌 window-level presenter 또는 system help fallback으로 바꿔 pane clipping을 없앤다.

#### MOMO-385 (`#391`) Member inspector + one-click DM

- active non-self member row의 primary click은 idempotent DM open 후 DM channel로 이동한다.
- 첫 메시지 전/후 DM visibility 정책을 명시한다. 생성 즉시 DM section에 표시하고, unread/read-state는 기존 계약을 사용한다.
- directory는 대형 modal 대신 right inspector를 기본으로 하며 search/filter/profile/DM action을 유지한다.

### 4.2 Full-stack lane

#### MOMO-386 (`#392`) Workspace search v0

- server endpoint: workspace-scoped, RLS-protected `pg_trgm` query. BYPASSRLS 금지.
- results: message, sender/agent identity, channel/DM, timestamp, matched excerpt.
- modifiers v0: `from:`, `in:`, `@handle`; date/file search는 후속.
- macOS: global search field or `Cmd+K` search mode, results inspector, jump-to-message context.
- 현재 channel별 최근 200개 client scan은 제거한다.

### 4.3 ADR 선행 lane

#### ADR-0117 Multi-workspace navigation

- 한 account에 여러 workspace/server profile을 저장하는 단위, switch semantics, per-workspace session/token, server identity persistence를 결정한다.
- 결정 전에는 Discord식 rail을 시각적으로 흉내 내지 않는다.

#### ADR-0114 Interactive Work host

- `Control+backtick`의 transcript/activity drawer는 MOMO-375로 구현 가능하다.
- 실제 command input, Codex/Claude/OpenCode session, PTY/process lifecycle, cwd/repo/worktree, approval relay는 ADR-0114 뒤 새 buildable child로 구현한다.
- 실행은 user-owned host에 남고 oort server는 command process/provider credential을 보관하지 않는다.

## 5. Engine delegation 준비

PLN-20260714-02는 main에 통합됐으며 다음 네 planning goal은 서로 다른 ADR 파일만 소유한다.

1. ADR-0113: credential/capability/action trust.
2. ADR-0116: context/memory retention and SourceRef.
3. ADR-0114: Codex app-server/interactive Work host.
4. ADR-0115: signed webhook ingress.

ADR-0113과 ADR-0116은 engine foundation 선행이며 병렬 draft 가능하다. ADR-0114는 사용자 요구의 Work Console을 unblock한다. ADR-0115는 plugin/webhook vertical 전용이다. 모든 engine PR은 proposal의 UX-owned file lock을 지킨다.

## 6. Merge/실행 순서

```text
MOMO-382 planning integration
  ├─ MOMO-383 workspace-first navigation
  ├─ ADR-0113 draft ─┬─ SE-02A capability runtime
  │                  └─ SE-02C governed action
  ├─ ADR-0116 draft ─── SE-02B memory/source runtime
  └─ ADR-0114 draft ─── SE-05A typed app-server bridge

MOMO-383
  ├─ MOMO-384 native channel create + tooltip presenter
  └─ MOMO-385 member inspector + one-click DM

MOMO-384 + MOMO-385
  └─ MOMO-386 workspace search v0

ADR-0114
  ├─ MOMO-375 transcript/activity drawer
  └─ interactive Work Console child (new numeric ID after ADR acceptance)
```

## 7. 완료 기준

- 기본 window에서 workspace → channel/DM → timeline 위계가 한눈에 읽힌다.
- 사람/agent row primary click과 secondary actions가 예측 가능하다.
- tooltip이 다른 pane에 의해 잘리지 않는다.
- 검색은 server SoT/RLS로 수행되고 결과가 원문으로 이동한다.
- `Control+backtick`는 숨은 shell이 아니라 Work run/approval/audit와 연결된다.
- engine lane은 macOS UX 파일을 수정하지 않고 DTO/status mapping이 필요하면 Core prerequisite로 분리한다.
