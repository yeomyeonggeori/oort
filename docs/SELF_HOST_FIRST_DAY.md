# First day for a self-host operator (SELF_HOST_FIRST_DAY.md)

> **English is the canon.** Korean:
> [`SELF_HOST_FIRST_DAY.ko.md`](SELF_HOST_FIRST_DAY.ko.md).
>
> **This document is enough.** From a clean clone: bootstrap (the two keys)
> → claim password → S1 「내 워크스페이스·내 이름」 → S2 「팀원 초대」
> (or 「나중에」) → first-run (kickoff-hold → 「첫 에이전트 연결」 → phone
> link) → second user joins (web + desktop `oort://join`) → AI link →
> first mention. Finish without cross-references. Links are for going
> deeper.
>
> The clone→sign-in-only canon is [`SELF_HOST.md`](SELF_HOST.md). This
> document is the **next day** — the first time the GUI invite path is
> written down (#1608 / ITO-0 T-B). The ops CLI `momo-ops.sh invite-create`
> is not this procedure (see the deeper section).
>
> **Method (#1535 inherited).** Fields, buttons, and sentences on screen
> are quoted from source. Do not invent copy, fields, or screens that are
> not in the source. Each step carries a verification status.

---

## Verification status

| Mark | Meaning |
|---|---|
| **code-derived** | Korean copy and contracts from the current checkout source, quoted as `file:line` |
| **doc-inherited** | Same wiring as [`SELF_HOST.md`](SELF_HOST.md) · [`onboarding-deeplink.md`](onboarding-deeplink.md) · T-A (#1607) |
| **needs live run** | A GUI click path. This worktree is headless and did not press a browser/desktop. The orchestrator checks against a running stack |

An agent **writing an answer** without a real key (measured verdict
`ANSWERED`) is not this document's job. Scope is through key injection and
mention utterance (`scripts/bench_onboarding.sh` preamble M5: `ANSWERED` /
`NOTICE` / `BLOCKED`).

---

## 0. Prerequisites

| You need | Check | Verification |
|---|---|---|
| Docker Engine + Compose v2 | `docker compose version` | doc-inherited ([`SELF_HOST.md`](SELF_HOST.md) "Prerequisites") |
| git | `git --version` | doc-inherited |
| A **different browser profile** (or a private window) for the second user | If an operator session remains on the same origin, the join screen does not appear | needs live run |
| (desktop join) A packaged oort app | Scheme `oort`·`momo` registered (`clients/desktop/src-tauri/tauri.conf.json:30`) | code-derived |
| (⑤ reply) An OpenAI-compatible **external `https://` endpoint and key**, or a local mock with `--allow-local-provider` | Default: `MOMO_ENV=staging` refuses loopback. Opt-in: `--allow-local-provider` + `http://host.docker.internal:<port>/v1` on **설정 › AI 연결** / `PUT /v1/provider/link`. Agent-create GUI still rejects non-loopback `http` as `plaintextRemote` | code-derived (`scripts/self_host_env.sh` `--allow-local-provider`, `createModel.agentBaseUrlIssue`, `provider.rs:193-198,287`) |

Do not install Rust, Node, or `psql`. Server and web live in one image
(doc-inherited: [`SELF_HOST.md`](SELF_HOST.md) "Prerequisites").

**This instance's operator** is the first owner's email. Generated env puts
that address in `PLATFORM_ADMIN_EMAILS`. Without that line, **설정 › AI
연결** and **워크스페이스 만들기** are 403 even for the person who
installed it (`scripts/self_host_env.sh:28-33,668-679`). The self-host
stack does not issue a `platform:read` token.

---

## 1. Bootstrap — bring the stack up and confirm the two keys

Verification: **doc-inherited** (commands) · **code-derived** (the two keys
· CORS defaults).

This document's first path is claim. S1/S2 open only after
`/claim/<token>` — the env-password ConnectPage in
[`SELF_HOST.md`](SELF_HOST.md) does **not** open them (§2). The generator
always writes `MOMO_INITIAL_OWNER_PASSWORD`. Convert to claim **before**
`up`. Claim and the password key are mutually exclusive (ADR-0166).

### Claim-mode install

```sh
git clone https://github.com/yeomyeonggeori/oort.git oort
cd oort
scripts/self_host_env.sh --local-build
```

For a local mock gateway on this machine, add `--allow-local-provider`
(or re-run the same mode with that flag on the existing env). Recipe: §6 ·
§7 and [`SELF_HOST.md`](SELF_HOST.md) §5.

The same awk as [`SELF_HOST_AGENT.md`](SELF_HOST_AGENT.md) §3.3.3 — strip
the password key, write `MOMO_BOOTSTRAP_CLAIM=1`. Do not cat/grep the env
to stdout.

```sh
ENV_FILE=infra/rust/local.secrets.env
umask 077
tmp="${ENV_FILE}.claim"
awk '
  index($0, "MOMO_INITIAL_OWNER_PASSWORD=") == 1 { next }
  index($0, "MOMO_BOOTSTRAP_CLAIM=") == 1 { next }
  { print }
  END { print "MOMO_BOOTSTRAP_CLAIM=1" }
' "$ENV_FILE" >"$tmp"
mv "$tmp" "$ENV_FILE"
chmod 600 "$ENV_FILE"
```

`--compose` refuses this env: the launcher still requires the password
key (ADR-0166). Do not paste `scripts/self_host_env.sh --compose up …`
here. Local-build bring-up is the same file set `--compose` would have
used, called directly (AGENT §3.3.3 + `docker-compose.rust.build.yml`):

```sh
ENV_FILE=infra/rust/local.secrets.env
docker compose --env-file "$ENV_FILE" \
  -f infra/rust/docker-compose.rust.yml \
  -f infra/rust/docker-compose.rust.build.yml \
  -f infra/rust/local.override.yml \
  up -d --build --wait
```

If another clone's self-host stack is already up on the same machine, this
`up` is refused. Two-checkout rule: [`SELF_HOST.md`](SELF_HOST.md)
"Using two checkouts at once".

If a public digest exists you can use the `--published-image` path, then
the same awk, then AGENT §3.3.3 `oort_compose up -d --pull missing --wait`
(no build overlay). Deeper: [`SELF_HOST.md`](SELF_HOST.md) §2 ·
[`SELF_HOST_AGENT.md`](SELF_HOST_AGENT.md) §3.3.3.

When `--wait` finishes, ready is finished. Open migrate's one-shot
`MOMO_CLAIM_PATH=/claim/<token>` on first `up` (restarts print
`MOMO_BOOTSTRAP_CLAIM=skipped`). Do not paste the token into chat
(ADR-0004). The generator's password login hint does not apply — there is
no password key in this file. File mode 600, not a commit target.

### The two keys

Generated env (`infra/rust/local.secrets.env`) **already** contains the
following. Do not fill them in by hand.

| Key | What it does | Coordinate |
|---|---|---|
| `PLATFORM_ADMIN_EMAILS` | Declares the first owner as instance operator. **설정 › AI 연결** · **새 워크스페이스 만들기** open | `scripts/self_host_env.sh:668-679` |
| `PROVIDER_LINK_MASTER_KEY` | Encrypts the provider key into the DB. Missing it makes AI link 503 | `scripts/self_host_env.sh:630` |

An existing env may lack those lines. Re-run `scripts/self_host_env.sh` in
the same mode and it **appends only those lines** — it does not regenerate
secrets (`ensure_operator_allowlist`, `scripts/self_host_env.sh:300-318`).
After the append, restart api with the same `docker compose --env-file`
file set as the install, `up -d`. `--compose` still refuses claim env
(ADR-0166).

Confirm:

```sh
grep -E '^(PLATFORM_ADMIN_EMAILS|PROVIDER_LINK_MASTER_KEY|MOMO_CORS_ALLOWED_ORIGINS)=' \
  infra/rust/local.secrets.env
```

`PLATFORM_ADMIN_EMAILS` may show the email. Do not paste the value of
`PROVIDER_LINK_MASTER_KEY` onto the screen — look only at whether the
**line exists**.

### Desktop CORS (T-A / #1607 — this is not a placeholder)

Generated env **includes** both Tauri webview origins by default.

- REST: `MOMO_CORS_ALLOWED_ORIGINS=tauri://localhost,http://tauri.localhost`
  (`scripts/self_host_env.sh:103,655`)
- Realtime: the same two, **space-separated**, on
  `CENTRIFUGO_ALLOWED_ORIGINS` (`scripts/self_host_env.sh:104,643`). Open
  REST and not WSS and sign-in works but realtime is 403.

The compose default in `infra/rust/docker-compose.rust.yml` is still empty.
The `caddy.override.yml` ops path does not read this file. Browser
self-host is same-origin, so CORS is not needed
(`scripts/self_host_env.sh:35-43,633-636,648-655`).

An existing env gets a line added **only when the CORS key is missing**.
Empty or custom values are not overwritten
(`scripts/self_host_env.sh:321-345`). If the Centrifugo list lacks a tauri
origin it warns on stderr only and does not edit the line (`:348-366`).

---

## 2. First run — claim password, then S1 · S2 · first agent · phone link

Verification: **code-derived** (screen) · **needs live run** (click).

The first day is not ConnectPage login into a demo nameplate. Claim
password → S1 「내 워크스페이스·내 이름」 (`1/2`) → S2 「팀원 초대」
(`2/2`, skip 「나중에」) → first-run (kickoff-hold → 「첫 에이전트 연결」
→ phone link). Claim password is not a counted step
(`clients/web/src/features/auth/onboardingFlow.ts` `OWNER_ONBOARDING_STAGES`).

The env-password ConnectPage path in [`SELF_HOST.md`](SELF_HOST.md) still
exists when claim is off. That path does **not** open S1/S2. Operator
vocabulary for capturing `MOMO_CLAIM_PATH`:
[`SELF_HOST_AGENT.md`](SELF_HOST_AGENT.md) §3.3.5.

### Claim password

Claim is a real path, not a hash route
(`clients/web/src/features/auth/claimPath.ts`). Open:

```
http://localhost:<MOMO_WEB_PORT>/claim/<token>
```

Migrate prints `MOMO_CLAIM_PATH=/claim/<token>` **once** on first `up`.
Restarts print `MOMO_BOOTSTRAP_CLAIM=skipped`. Do not paste the token into
chat (ADR-0004).

Screen title **oort**. Description 「첫 비밀번호를 설정합니다。」
(`ClaimPage.tsx:136-143`). Fields: **새 비밀번호** · **비밀번호 확인**
(both 「필수」). Submit **비밀번호 설정** (in progress **설정 중…**)
(`:187-238`). Mismatch: 「두 칸의 비밀번호가 같지 않습니다。」 (`:227`).
Missing token: 「이 링크는 유효하지 않습니다. 받은 주소를 그대로 여세요。」
(`:164`). Offline: 「오프라인입니다. 네트워크가 연결되면 다시 시도하세요。」
(`:150`).

Success writes the first-run markers and the onboarding pending flag, then
mounts S1 (`ClaimPage.tsx` → `OwnerOnboarding`).

### S1 — 내 워크스페이스·내 이름 (1/2)

Chrome counter **`1/2`**. Title **내 워크스페이스·내 이름**
(`s1Copy.ts` `S1_TITLE`, `OwnerOnboarding.tsx`). Lead: 「워크스페이스
이름과 여기서 다른 멤버에게 보이는 이름과 핸들을 정합니다。」
(`S1_LEAD`).

| Field | Notes | Coordinate |
|---|---|---|
| **워크스페이스 이름** | Overwrites the seed display name. Not the slug | `WorkspaceProfileStage.tsx` |
| **표시 이름** | Owner profile | same |
| **핸들** | `@` lives inside the box (`HandleField.tsx`) | same |

Submit **이름 저장** (in progress **저장 중**, retry **다시 시도**)
(`S1_PRIMARY_*`). Re-entry sentence, always: 「나중에 설정 › 워크스페이스
/ 프로필에서 바꿀 수 있습니다。」 (`S1_REENTRY`). Those doors: **설정 ›
워크스페이스** field **워크스페이스 이름** / **이름 저장**; **설정 ›
프로필** editable **표시 이름** + **핸들** / **프로필 저장**
(`WorkspaceSection.tsx`, `ProfileSection.tsx`).

A save failure can show **지금은 건너뛰기** (`S1_SKIP_LABEL`) — that is
not the always-on S2 skip. Offline: 「연결이 끊겨 지금은 이름을 저장할 수
없습니다. 다시 연결되면 이어서 저장할 수 있습니다。」

### S2 — 팀원 초대 (2/2)

Chrome counter **`2/2`**. Title **팀원 초대** (`s2Copy.ts` `S2_TITLE`).
Lead is the same two sentences as 설정 › 멤버와 초대 (`S2_LEAD` =
`InviteSection` lines).

No role / uses / TTL fields. Sealed defaults: role `member`, max uses `1`,
TTL 24h (`OWNER_INVITE_*` in `onboardingFlow.ts`). Primary **초대 링크
만들기** (in progress **만드는 중**) — same labels as settings
(`inviteLabels.ts`). Ghost **나중에** (`S2_SKIP_LABEL`) is always on until
an invite is issued. Skip issues **0** codes. Re-entry sentence, always:
「설정 › 멤버와 초대에서 언제든 이어서 초대할 수 있습니다。」
(`S2_SKIP_SENTENCE`).

After issue, the one-time card is `IssuedInviteCard` with `copyMode="single"`
— only **초대 카드 복사**. Then primary becomes **계속**
(`S2_CONTINUE_LABEL`). Card copy is in §4.

Offline: 「연결이 끊겨 지금은 초대 링크를 만들 수 없습니다. 다시 연결되면
이어서 만들 수 있습니다。」 (`S2_OFFLINE_REASON` — same sentence as
settings).

### After onboarding — first-run

Order is already the table: kickoff-hold → first-agent → phone-link
(`firstAgent.ts` `FIRST_AGENT_STAGE_ORDER`, `firstRunGate.ts`
`decideFirstRun`).

Self-host env is `MOMO_AGENT_SEED_MODE=none` (`scripts/self_host_env.sh`).
**There is no 김인턴.** `decideWelcomeMount` reason `no-active-agent`
releases the hold immediately — no 120s backstop card
(`welcomeKickoff.ts`). The next stage title is **첫 에이전트 연결**
(`FIRST_AGENT_TITLE`). Lead 「팀에 붙일 에이전트를 고르세요。」 Skip
**나중에**; re-entry 「나중에 설정 › 연결 › 에이전트 자격에서 이어갈 수
있습니다.」 Cards include Claude Code · Codex · Grok Bot · **OpenAI 호환**
(the last sends you to 설정 › AI 연결 — §6). Native agent + mention is
still §7.

When the first agent becomes welcome-capable (native create tx **or**
hosted connection `active`), the server enqueues the opener for the owner
if none is live yet (`routes/welcome.rs`
`enqueue_owner_welcome_kickoff_in_tx`). Hosted speakers take the gateway
rail; native stay on the worker rail. An undeliverable hosted speaker does
not consume the opener marker.

Then **폰에서도 쓰기** (`PhoneLinkFirstRun.tsx`). Lead: 「같은 계정으로
폰을 붙이려면 지금 QR을 만들 수 있습니다. 나중에 설정 기기에서도 열 수
있습니다。」 outline **앱으로 들어가기**.

Settings after you are in: profile-card row **설정**, tooltip 「설정
(⌘,)」 (`ProfileCard.tsx:175-189`). Shell title **설정**
(`SettingsRoute.tsx:172`). Left nav groups **개인** / **워크스페이스** /
**연결** (`settingsNav.ts`). This session's UUID is the 「워크스페이스
ID」 line of **설정 › 계정** (`AccountSection.tsx:22-26`).

### What remains in v0.1.5

Onboarding overwrites the **visible** workspace name and the owner's
display name + handle. It does **not** remove the seed row (ADR-0185 §6,
D-B (b)). Still in v0.1.5:

- slug **`demo`**
- fixed workspace UUID `00000000-0000-7000-8000-000000000001`
- seeded channel `#agent-lab` next to `#general`
  (`server/Migrations/002_seed.sql`)

Claim still binds the first owner onto that seed human
(`infra/rust/sql/bootstrap_owner_if_absent.sql`,
`bootstrap_owner_claim_if_absent.sql`). Creating a **new** tenant is not
this first-day path — §3. Seed removal is SH-12z.

---

## 3. Operator function — create a workspace

Verification: **code-derived** · **needs live run**.

This is **not** the first-day funnel. Invites and mentions work on the
workspace S1 just named. `POST /v1/workspaces` stays gated on
`require_instance_operator`
(`server-rust/bins/momo-server/src/routes/workspaces.rs:200-216`).
ADR-0185 does not relax that gate. A new tenant is an extra operator
action, not step 3 of onboarding.

The form on both entries is the same. Field names are the same.

### Entry A — settings

1. **설정** → left nav group **워크스페이스** → **워크스페이스**
   (`settingsNav.ts`).
2. Section title **워크스페이스**. Description: 「지금 열려 있는
   워크스페이스를 확인하고, 새 워크스페이스를 만듭니다。」 / 「새
   워크스페이스는 만든 사람이 오너가 되고 #general 채널 하나로
   시작합니다。」 (`WorkspaceSection.tsx:887-893`).
3. Subheading **새 워크스페이스 만들기** (`:944`). Above that heading the
   same section now also shows the current-tenant card (including
   **워크스페이스 이름** / **이름 저장** — S1's settings door) plus
   role labels, welcome kickoff, unfurl, and leave.

### Entry B — rail

**워크스페이스 추가** on the workspace rail (`WorkspaceRail.tsx:113-114`)
and on the profile-card menu (`ProfileCard.tsx:161-172`). Dialog title
**워크스페이스 추가**. Description: 「새 워크스페이스를 만들거나, 초대를
받았다면 초대 링크로 참여합니다。」 (`AddWorkspaceDialog.tsx:214-217`).

### Fields

| Field | Hint | Coordinate |
|---|---|---|
| **이름** | 「사람이 읽는 이름입니다. 80자까지 쓸 수 있습니다。」 | `WorkspaceSection.tsx:957-960` · `AddWorkspaceDialog.tsx:283-286` |
| **슬러그** | Settings: 「영문 소문자, 숫자, 하이픈만 쓸 수 있습니다. 서버 전체에서 하나뿐이어야 합니다。」 / Dialog: 「영문 소문자, 숫자, 하이픈만. 서버 전체에서 하나뿐이어야 합니다。」 | `WorkspaceSection.tsx:975-978` · `AddWorkspaceDialog.tsx:307-310` |

Rules (same as the server): empty → 「슬러그를 입력하세요。」 / 「이름을
입력하세요。」 (`packages/momo-core/src/features/settings/model.ts:392-412`).

Button: **워크스페이스 만들기** (in progress **만드는 중**)
(`WorkspaceSection.tsx:1016` · `AddWorkspaceDialog.tsx:373`).

Success card: 「{이름} 워크스페이스를 만들었습니다。」 then **슬러그** ·
**워크스페이스 ID**. Then 「새 워크스페이스로는 그 슬러그로 다시
로그인해서 들어갑니다。」 (`WorkspaceSection.tsx:1028-1038`). The dialog
uses the same success sentence plus 「슬러그 {slug}. 새 워크스페이스로는
그 슬러그로 다시 로그인해서 들어갑니다。」 (`AddWorkspaceDialog.tsx:227-232`).

**There is no session switch.** To enter the new tenant, **로그아웃**
(`AccountSection.tsx:31-32`) then on the sign-in screen expand 「다른
워크스페이스로 로그인」 and put the success card's **워크스페이스 ID**
(UUID). The sign-in form accepts a UUID, not a slug
(`ConnectPage.tsx`). An invite is issued to the workspace you are **in
now**. First-day invites stay on the workspace S1 named — do not make this
switch.

On 403 the screen replaces the form with: 「새 워크스페이스는 이 서버의
운영자만 만들 수 있습니다。」 (`WorkspaceSection.tsx:947-949`). Look at
step 1's `PLATFORM_ADMIN_EMAILS`.

---

## 4. Invites — S2 and settings re-entry

Verification: **code-derived** · **needs live run**. Do not use the ops
CLI. S2 and 설정 › 멤버와 초대 share `useIssueInvite` + `IssuedInviteCard`.

### S2 during first run

S2 is the first-day invite: one sealed link (member · 1 use · 24h) or
skip **나중에** (0 POSTs). After the link is issued, skip **나중에**
disappears and the primary is **계속** (`S2_CONTINUE_LABEL`). Copy and
the one-time card are the same component as settings; S2's card is
`copyMode="single"` (only **초대 카드 복사**). Details of the card bytes
are below. After skip or **계속**, first-run in §2 starts.

### Settings › 멤버와 초대

Re-entry after S2, and the path that can pick role / uses / TTL.

1. **설정** → group **워크스페이스** → **멤버와 초대** (`settingsNav.ts`).
2. Section title **멤버와 초대**. Description: 「초대 링크를 발급해 사람을
   이 워크스페이스로 부릅니다。」 / 「코드는 발급 직후 한 번만 보입니다.
   서버는 해시만 보관합니다。」 (`InviteSection.tsx:112-114`).
3. If none yet, empty state: 「아직 발급한 초대 링크가 없습니다。」 /
   「아래에서 역할과 사용 횟수를 정하고 링크를 만드세요。」 (`:150-154`).
4. Form (`:187-288`):

| Field | Default | Choices · hint | Coordinate |
|---|---|---|---|
| **역할** | 멤버 | **멤버** 「채널을 읽고 씁니다。」 · **관리자** 「초대와 워크스페이스 설정을 다룹니다。」 · **게스트** 「초대받은 채널만 봅니다。」 | `InviteSection.tsx:198-205` · `model.ts:255-258` |
| **사용 횟수** | `1` | 「이 링크로 참여할 수 있는 사람 수입니다。」 1…10000 | `InviteSection.tsx:207-226` |
| **유효 기간** | 7일 | 1일 · 7일 · 30일. Detail per choice: 「{YYYY-MM-DD}까지 쓸 수 있습니다。」 | `InviteSection.tsx:228-239` · `model.ts:277` |

5. **초대 링크 만들기** (in progress **만드는 중**) (`inviteLabels.ts`,
   `InviteSection.tsx:272`).

Issue card (`IssuedInviteCard.tsx`) — the code is visible again **only on
this screen**:

- 「초대 링크를 만들었습니다. 코드는 이 화면에서만 볼 수 있으니 지금
  전달하세요。」 (`:49-51`)
- **딥링크** — `oort://join?server=<percent-encoded base URL>&code=<code>`
  (`:57-59`, assembled `model.ts:439-440`)
- **서버 주소** — this page's API origin. Self-host web:
  `http://localhost:<port>` (`:61`, `resolveServerBaseUrl` →
  `window.location.origin`, `clients/web/src/lib/serverBase.ts`)
- **초대 코드** — plaintext once (`:62`)
- **만료** — `{YYYY-MM-DD}, {N}명까지` (`:63-67`)

Settings has three buttons (`copyMode` default `full`):

- **딥링크 복사** (`IssuedInviteCard.tsx:81-85`)
- **초대 카드 복사** (`:86-90`) — card body is
  `packages/momo-core/src/features/settings/model.ts:462-474`
- **메일 초안 열기** (`:91-93`)

Under the card: 「받는 사람은 앱을 설치한 뒤 딥링크를 열면 서버 주소와
코드가 채워진 상태로 참여 화면에 도착합니다。」 (`:98-100`) — this is
**desktop deeplink** copy. Web join is 5A.

What remains on the list is a preview (last few characters) and a status
chip only; the plaintext code is not returned again
(`InviteSection.tsx:163-180`).

Permission denied: 「초대 링크는 워크스페이스 오너나 관리자만 발급할 수
있습니다。」 (`InviteSection.tsx:130`).

---

## 5. Second user joins — web and desktop

Verification: **code-derived** (parsers and screens of both entries) ·
**needs live run** (an actual join).

The only link the issue card **makes with a copy button is one
`oort://join`**. There is no button that makes an HTTP link for the
browser. Web reads the same `server`·`code` from the page URL, or puts the
code in directly on the sign-in screen.

Do the second user in a **browser profile different from the operator**.
A tab that still has the operator session is not the connect screen.

### 5A. Web — join with an invite code in the browser

**Path 1 — switch on the screen (the path with a button)**

1. Open `http://localhost:<port>`.
2. Under the card, **초대 코드로 참여** (`ConnectPage.tsx:532-546`).
   Description changes to 「초대 코드로 워크스페이스에 참여합니다。」
   (`:288-289`).
3. Fields:

| Field | Hint | Coordinate |
|---|---|---|
| **서버 주소** (optional) | Leave empty. The address that opened this page is the server | `:338,261-263` |
| **초대 코드** (required) | **초대 코드** on the issue card | `:384-396` |
| **이메일** (required) | 「워크스페이스에 초대받은 주소」 — a **new** address that does not exist yet | `:401-418` |
| **비밀번호** (required) | 「이 워크스페이스에서 쓸 비밀번호를 새로 정합니다」 | `:422-445` |

Display name and handle are derived from the email; there is no field on
screen (`packages/momo-core/src/lib/api.ts:799-819`, `POST /v1/join`).

4. The submit button label is also **초대 코드로 참여** (in progress
   **참여 중…**) (`ConnectPage.tsx:264-268`).

To go back to sign-in, **로그인으로 전환** (`:545`).

**Path 2 — page-URL prefill (a web join link you assemble)**

This client's router is HashRouter (`clients/web/src/app/App.tsx:28-31,65`).
The connect screen reads `server`·`code` from the page URL and then clears
them from the address bar — the code is a bearer secret
(`useJoinPrefill.ts:16-21,38-42`,
`packages/momo-core/src/features/auth/deepLink.ts:116-144,146-172`).

A web address you can hand the second user (the issue card does not make
this):

```
http://localhost:<port>/#/?code=<초대 코드>
```

The same parameters can ride on the query (`?code=`, or the whole deeplink
as `?join=<percent-encoded oort://join…>`). If a code is present, mode
switches to join and the invite-code field is filled
(`ConnectPage.tsx:176-195`).

### 5B. Desktop — `oort://join`

1. **딥링크 복사** on the issue card. Format canon:
   `oort://join?server=<percent-encoded base URL>&code=<invite code>`
   ([`onboarding-deeplink.md`](onboarding-deeplink.md), `model.ts:348-356`).
   The old scheme `momo://join` is consumed too (`deepLink.ts:67`,
   `tauri.conf.json:30`).
2. Open that link on a machine that has the packaged app. The shell passes
   the URL, and the connect screen fills server address and invite code then
   switches to join mode (`useJoinPrefill.ts:14-16,45-77`).
3. On desktop the server address is **required**. Hint: 「데스크톱 앱은
   접속할 서버 주소가 필요합니다。」 (`ConnectPage.tsx:261-262`,
   `requiresServerUrl`: `serverBase.ts:108-110`). Check that the value the
   deeplink filled is the self-host edge — `http://localhost:<port>`.
4. Fill only **이메일** · **비밀번호** and **초대 코드로 참여**.

Generated-env CORS defaults (§1) open this cross-origin. If messages do not
arrive in realtime after sign-in, look at the Centrifugo origin, not REST
(§1 CORS section, `scripts/self_host_env.sh:640-643`).

macOS LaunchServices picks only one dev/release scheme handler. If the
link opens a different build, the server address may be empty or point at
another stack (packet T-A trap. Not measured in this worktree — needs live
run).

Join-failure sentences (same screen on web and desktop):

| Situation | Screen |
|---|---|
| No code | 「유효하지 않은 초대 코드입니다. 초대한 사람에게 링크를 다시 확인하세요。」 |
| Expired | 「만료된 초대입니다. 워크스페이스 관리자에게 새 초대 링크를 요청하세요。」 |
| Uses exhausted | 「사용 횟수가 모두 찬 초대입니다. …」 |
| Already joined with this code | 「이미 이 초대로 가입한 계정입니다. 로그인하세요。」 (`suggestSignIn`) |

Coordinates: `packages/momo-core/src/features/auth/connectModel.ts:47,75-123`.

When the second user sees the channel list, join is done. After that login,
first-run order is welcome kickoff → first agent connection → phone link.
The pre-login 4/4 counter (`ConnectPage`) is unchanged.

---

## 6. AI link — put the key in

Verification: **code-derived** · **needs live run** (save · confirm) · a
real-key `ANSWERED` is out of scope.

From the operator session:

1. **설정 열기** → group **워크스페이스** → **AI 연결**
   (`SettingsRoute.tsx:79`).
2. Section title **AI 연결**. Description: 「에이전트가 사용할 provider를
   이 서버 전체에 하나로 연결합니다。」 / 「자격증명은 이 서버에만
   저장되고 응답으로 다시 내려오지 않습니다. 저장한 뒤에는 등록 여부와
   마지막 4자리만 보입니다。」 (`AiLinkSection.tsx:411-414,529`).
3. If empty: 「에이전트가 쓸 AI를 연결하세요。」 Button **provider
   연결하기** (`:531-540`).
4. **등록 방식** default **키** — 「provider가 발급한 API 키를 직접
   넣습니다. 제품 기본 경로입니다。」 (`:91-96,616-622`). (The other
   method **ChatGPT 계정 (OAuth)** is an internal path and is not the
   first-day default.)
5. Fields:

| Field | Hint | Coordinate |
|---|---|---|
| **provider 주소** | 「예: https://api.example.com/v1」 | `AiLinkSection.tsx:625-631` |
| **키** | 「입력한 값은 저장 즉시 암호화되며 화면으로 다시 돌아오지 않습니다。」 `type="password"` | `:646-659` |
| **모드** | Default **외부 provider** 「저장한 주소와 키로 실제 provider에 연결합니다。」 | `:662-668` · `model.ts:25-30` |

The address must start with `http://` or `https://`. Otherwise 「주소는
http:// 또는 https:// 로 시작해야 합니다。」 (`oauthGrant.ts:234-237`).
Without `--allow-local-provider` the server refuses loopback when
`MOMO_ENV=staging`, and a non-loopback address must be **https only**
(`provider.rs:193-198,287,319-327`). A laptop local model at
`http://127.0.0.1:…` does not attach on this path today.

The local-mock recipe that answers (E2E-B): generate with
`--allow-local-provider`, bind the mock on `0.0.0.0`, then put
`http://host.docker.internal:<port>/v1` here or on REST
`PUT /v1/provider/link`. That host is allowed on **this** form. It is
**not** allowed on the agent-create GUI (§7).

6. **연결 저장** (if a link already exists **연결 교체 저장**, in progress
   **저장 중**) (`AiLinkSection.tsx:777-781`).
7. **연결 확인** (`:811`). On success 「{endpoint} 응답을 확인했습니다。」
   (`model.ts:285`).

The key does not come back onto the screen. The card's 「저장된 키」 is
`••••` + last four digits (`model.ts:264-266`, `AiLinkSection.tsx:504-508`).
Chip **연결됨** (`:107-109`).

| Screen | Cause |
|---|---|
| 「provider 연결은 이 서버의 운영자만 바꿀 수 있습니다。」 | 403. `PLATFORM_ADMIN_EMAILS` (`AiLinkSection.tsx:428-430`) |
| 503 | api came up without `PROVIDER_LINK_MASTER_KEY` (doc-inherited: [`SELF_HOST.md`](SELF_HOST.md) "When stuck") |

Saving the key is a DB row, so **do not restart**. Only
`PLATFORM_ADMIN_EMAILS` needs an api restart
([`SELF_HOST.md`](SELF_HOST.md) §5 table, `scripts/self_host_env.sh:677-678`).

The same PUT over REST is deeper: [`SELF_HOST.md`](SELF_HOST.md) §5.

---

## 7. Create an agent → put it in a channel → first mention

Verification: **code-derived** · **needs live run**. `ANSWERED` only when a
real key + an external https endpoint actually replies.

The self-host seed does not put an agent in (§2). You create one.

### Create

1. Sidebar **에이전트** (`Sidebar.tsx:457`) — the route title is also
   **에이전트** (`AgentHubRoute.tsx:375`). Description: 「워크스페이스
   에이전트를 만들고, 상태와 기억, 작업 이력을 한 곳에서 봅니다。」
   (`:377-379`).
2. **에이전트 만들기** (`:409`). Shown only to owner/admin (`:325-334`).
3. Dialog title **에이전트 만들기**. Description: 「에이전트는
   워크스페이스의 멤버가 됩니다. 만든 뒤 채널에 넣으면 그 채널에서 멘션할
   수 있습니다。」 (`CreateAgentDialog.tsx:231-234`).
4. Fields (there is no credential field):

| Field | Hint | placeholder |
|---|---|---|
| **표시 이름** | 「사람들이 목록과 메시지에서 보게 될 이름입니다. 100자 이내。」 | `김인턴` |
| **핸들** | 「멘션에 쓰는 이름입니다. 영문 소문자, 숫자, 하이픈, 밑줄로 2자 이상 32자 이내. …」 | `kim-intern` |
| **모델** | 「이 에이전트가 기본으로 쓸 모델 이름입니다. …」 | `hermes-agent` |
| **게이트웨이 주소** | 「이 에이전트를 실행할 곳입니다. 외부 주소는 https, 같은 기기라면 포트까지 적습니다。」 | `https://gateway.example.com/v1` |
| **지시문** (optional) | 「선택 사항입니다. 답변 방식과 작업 경계를 적으면 첫 프로필로 저장됩니다。」 | |

Coordinates: `CreateAgentDialog.tsx:252-375`.

Fixed sentence under the form: 「API 키는 여기에 넣지 않습니다. 프로바이더
자격증명은 설정의 AI 연결에서 한 번만 등록하고, 에이전트는 그 연결을 통해
실행됩니다。」 (`:392-397`).

**게이트웨이 주소** (`createModel.agentBaseUrlIssue`): `https://…` is
accepted; loopback `http://localhost` / `http://127.0.0.1` / `http://[::1]`
is accepted; any other `http://` is `plaintextRemote` (copy: 「외부 주소는
https:// 여야 합니다. http는 같은 기기(localhost)에서만 쓸 수 있습니다。」).
`http://host.docker.internal:<port>/v1` is that last case — this dialog
will not take it. That address belongs on **설정 › AI 연결** / REST
`PUT /v1/provider/link` (§6, [`SELF_HOST.md`](SELF_HOST.md) §5) after
`--allow-local-provider`.

External https: put the same OpenAI-compatible `https://…/v1` as step 6
into **게이트웨이 주소**. Local mock (E2E-B): keep the provider on
`PUT /v1/provider/link` as `http://host.docker.internal:<port>/v1`, and
create the agent over REST `POST /v1/workspaces/{ws}/agents` with that
`baseUrl`. The worker inside Docker cannot reach the host at `127.0.0.1`.

5. **에이전트 만들기** (in progress **에이전트 만드는 중**) (`:434`).

Empty directory: 「이 워크스페이스에는 에이전트가 없습니다。」 /
「에이전트를 만들고 채널에 넣으면 그 채널에서 멘션할 수 있습니다。」
(`AgentHubRoute.tsx:441-444`).

### Put in a channel

Create makes identity only and does not put it in a channel
(`packages/momo-core/src/features/agents/channelPlacement.ts:12-15`). A
mention is delivered only if it is a channel member.

**From the hub (dedicated placement):** pick the agent you just made. Under
the detail, subheading **채널**. 「이 에이전트가 들어가 있는 채널입니다.
채널에 있어야 그 채널에서 멘션할 수 있습니다。」
(`AgentChannelsSection.tsx:114-117`). If empty: 「아직 어떤 채널에도
들어가 있지 않습니다。」 (`:156-157`). Label **채널에 추가**, select
placeholder **채널 고르기** (option text is `#`+name like `#general`,
`AgentChannelsSection.tsx:284-295`), submit **채널에 추가** (`:268-310`).
Success: 「{이름}을(를) #{채널}에 추가했습니다. 이제 그 채널에서 멘션할 수
있습니다。」 (`channelPlacement.ts:117-119`). First day uses the seed
channel `agent-lab` or `general`.

**From a channel:** open `agent-lab` (or `general`) in the sidebar. An empty
channel shows 「이 채널을 첫 메시지로 시작하세요。」 Secondary button
**멤버 추가하기** (`packages/momo-core/src/features/timeline/model.ts:75-76,123-129`).
Dialog title **멤버 추가** (`AddChannelMemberDialog.tsx:370`). Section
**에이전트** (`:350`). **추가** on the row (`:154`).

If the workspace has only the operator, this dialog says 「이 워크스페이스에
다른 멤버가 없습니다。」 and **멤버 초대하기** sends you to settings ›
멤버와 초대 (`AddChannelMemberDialog.tsx:305-317`) — that is a people
invite, not agent placement. After you have created the agent first, the
hub's **채널에 추가** is not a dead end.

### Mention

Channel composer. Placeholder on a wide window: 「{채널이름}에 메시지
보내기, @로 부르기」 (`packages/momo-core/src/features/chat/composerCopy.ts:191,378-388`).
Pick the handle after `@`. Example: handle `kim-intern` →
`@kim-intern 안녕`. Send: **메시지 보내기 (Enter)** (`Composer.tsx:855-860`).

When a message the agent wrote in the channel is visible, the first-day GUI
path is closed.

Whether that message is an **answer** or a **failure notice** is separate
(`scripts/bench_onboarding.sh:28-40`):

| Verdict | Meaning |
|---|---|
| `ANSWERED` | The provider actually replied. Needs a real key + external https |
| `NOTICE` | The worker posted a failure into the channel. The default measured value without a key |
| `BLOCKED` | No agent message appeared |

If a failure notice appears in the channel, the same `docker compose
--env-file` file set as §1, `logs agent-worker` (claim env: `--compose`
refuses, ADR-0166; doc-inherited: [`SELF_HOST.md`](SELF_HOST.md) "When
stuck").

---

## When stuck

| Symptom | Cause and action | Verification |
|---|---|---|
| 설정 › AI 연결 / workspace create turns into the operator notice | `PLATFORM_ADMIN_EMAILS` missing or not this email. Append the line to env, then restart api | code-derived · doc-inherited |
| AI link 503 | api came up without `PROVIDER_LINK_MASTER_KEY` | doc-inherited |
| Invite-create button is dim and 「연결이 끊겨 지금은 초대 링크를 만들 수 없습니다. …」 | Offline (`InviteSection.tsx:67-68,306-313`) | code-derived |
| You put the deeplink `oort://join` in the browser address bar | A custom scheme is not a browser path. Take 5A | code-derived |
| After desktop sign-in, only realtime fails | REST CORS and Centrifugo origin are separate. Check that `CENTRIFUGO_ALLOWED_ORIGINS` has both tauri origins | code-derived (#1607) |
| You created an agent and mention does nothing | Not in a channel (step 7 placement), or no key (step 6), or the endpoint refuses | code-derived |
| A loopback provider address is refused | Default `MOMO_ENV=staging` + loopback ban. Local mock: `--allow-local-provider` + `host.docker.internal` on **설정 › AI 연결** / `PUT /v1/provider/link`, not the agent-create GUI (`plaintextRemote`) | code-derived |

Stack stop · wipe · port collision: [`SELF_HOST.md`](SELF_HOST.md)
"Stop · wipe" "When stuck".

---

## Deeper (after you finish this document)

| Document | When |
|---|---|
| [`SELF_HOST.md`](SELF_HOST.md) | Bring-up failure, secret rotate, putting the key in over REST, outbox query |
| [`SELF_HOST_AGENT.md`](SELF_HOST_AGENT.md) | Operator claim-path capture (`MOMO_CLAIM_PATH`) |
| [`onboarding-deeplink.md`](onboarding-deeplink.md) | `oort://join` byte contract |
| [`infra/rust/README.md`](../infra/rust/README.md) | compose overlays, migration logs |
| retired ops CLI `invite-create` | Retired (historical Swift prod tree at `f399e417`). Not this document's path |
| workd / ACP hosting | Retired with LS-1 (#2165). Source: `f399e417:infra/workd` · `f399e417:docs/AGENT_HOSTING_QUICKSTART.md`. Not the self-host first day |
| `scripts/bench_onboarding.sh` | Wall-clock install→first reply. REST, not GUI |

---

## Quoted coordinates (review)

When the orchestrator checks a running-stack browser, a sentence in this
document that is not on the screen is a defect.

| Surface | File |
|---|---|
| Claim password | `clients/web/src/features/auth/ClaimPage.tsx`, `claimPath.ts` |
| S1 / S2 chrome | `…/onboarding/OwnerOnboarding.tsx`, `s1Copy.ts`, `WorkspaceProfileStage.tsx`, `s2Copy.ts`, `InviteStage.tsx` |
| Sign-in / join | `clients/web/src/features/auth/ConnectPage.tsx` |
| Join parser | `packages/momo-core/src/features/auth/deepLink.ts` |
| Settings nav | `clients/web/src/features/settings/settingsNav.ts`, `SettingsRoute.tsx`, `ProfileCard.tsx` |
| Workspace | `…/WorkspaceSection.tsx`, `clients/web/src/features/workspace/AddWorkspaceDialog.tsx` |
| Profile door | `…/ProfileSection.tsx`, `…/profile/shared/HandleField.tsx` |
| Members and invites | `…/InviteSection.tsx`, `IssuedInviteCard.tsx`, `packages/momo-core/src/features/settings/model.ts` |
| First-run | `…/welcome/firstRunGate.ts`, `firstAgent.ts`, `FirstAgentStage.tsx`, `PhoneLinkFirstRun.tsx` |
| Welcome enqueue | `server-rust/bins/momo-server/src/routes/welcome.rs` |
| AI link | `…/AiLinkSection.tsx` |
| Agent hub | `clients/web/src/features/agentHub/AgentHubRoute.tsx`, `CreateAgentDialog.tsx`, `AgentChannelsSection.tsx` |
| Channel members | `clients/web/src/features/channels/AddChannelMemberDialog.tsx` |
| Mention | `packages/momo-core/src/features/chat/composerCopy.ts`, `clients/web/src/features/chat/Composer.tsx` |
| env / CORS | `scripts/self_host_env.sh` |
| Owner bootstrap SQL | `infra/rust/sql/bootstrap_owner_if_absent.sql` |
