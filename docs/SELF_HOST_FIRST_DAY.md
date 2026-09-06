# First day for a self-host operator (SELF_HOST_FIRST_DAY.md)

> **English is the canon.** Korean:
> [`SELF_HOST_FIRST_DAY.ko.md`](SELF_HOST_FIRST_DAY.ko.md).
>
> **This document is enough.** From a clean clone: bootstrap (the two keys)
> → sign-in → workspace → issue a web GUI invite → second user joins (web +
> desktop `oort://join`) → AI link → first mention. Finish without
> cross-references. Links are for going deeper.
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
| (⑤ reply) An OpenAI-compatible **external `https://` endpoint and key** | Self-host env is `MOMO_ENV=staging`, so a loopback provider is refused | code-derived (`scripts/self_host_env.sh:607`, `server-rust/crates/momo-settings/src/provider.rs:193-198,287`) |

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

```sh
git clone https://github.com/yeomyeonggeori/oort.git oort
cd oort
scripts/self_host_env.sh --local-build
scripts/self_host_env.sh --compose up -d --build --wait
```

If another clone's self-host stack is already up on the same machine, this
`up` is refused. Two-checkout rule: [`SELF_HOST.md`](SELF_HOST.md)
"Using two checkouts at once".

If a public digest exists you can use the `--published-image` path. Deeper:
[`SELF_HOST.md`](SELF_HOST.md) §2.

When `--wait` finishes, ready is finished. The login hint the script prints
is roughly this (`scripts/self_host_env.sh:458-476`):

```
http://localhost:<MOMO_WEB_PORT>     # 기본 8088
email    owner@oort.local           # 또는 MOMO_INITIAL_OWNER_EMAIL
password infra/rust/local.secrets.env 의 MOMO_INITIAL_OWNER_PASSWORD
```

The password is not on stdout. File mode 600, not a commit target.

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
After the append, restart api: `scripts/self_host_env.sh --compose up -d`.

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

## 2. Sign in — enter the seed workspace

Verification: **code-derived** (screen) · **needs live run** (click).

Open the address step 1 printed — default **`http://localhost:8088`** — in
a browser. Screen title is **oort**
(`clients/web/src/features/auth/ConnectPage.tsx:283-286`). Description:
「서버를 고른 뒤 로그인합니다。」 (`:287-290`).

There are three fields; fill two of them.

| Field on screen | Mark | Put this |
|---|---|---|
| **서버 주소** | 「선택」 next to the label (`ConnectPage.tsx:338`) | **Leave it empty.** Hint: 「비워 두면 이 페이지를 제공한 주소로 연결합니다。」 (`:261-263,378`) |
| **이메일** | 「필수」 (`:402`) | `owner@oort.local` (or the address the generator printed). Hint: 「워크스페이스에 초대받은 주소」 (`:418`) — first sign-in is the owner themselves, not an invite |
| **비밀번호** | 「필수」 (`:423`) | `MOMO_INITIAL_OWNER_PASSWORD`. Hint: 「가입할 때 정한 비밀번호」 (`:445`) |

**You do not need to find a workspace field.** It is folded behind 「다른
워크스페이스로 로그인」 (`ConnectPage.tsx:475`). Expand it and the label is
**워크스페이스 ID**; the only value it accepts is one UUID (`:483`,
placeholder `00000000-0000-0000-0000-000000000000`, `:87`). Hint: 「비워
두면 기본 워크스페이스로 연결합니다。」 (`:500`)

Press **로그인** (`:264-271,529`).

Once in, seed channels stand under the sidebar group **채널**. The list
text is the channel name; `#` is the icon — `general` · `agent-lab`
(`packages/momo-core/src/features/workspace/directory.ts:180-185`,
`clients/web/src/features/sidebar/Sidebar.tsx:314-337`,
`server/Migrations/002_seed.sql:39-40,84-97`). Workspace name **momo Demo
Workspace**, slug **demo**, fixed id
`00000000-0000-7000-8000-000000000001`. The first owner adopts that seed
human (`infra/prod/bootstrap_owner_if_absent.sql:74-75`,
`email_verified = true`).

Self-host env is `MOMO_AGENT_SEED_MODE=none` (`scripts/self_host_env.sh:658`).
**There is no 김인턴.** You create the agent in step 7.

Handle that opens settings: the gear at the bottom of the sidebar.
Accessible name **설정 열기**, tooltip 「설정 (⌘,)」
(`Sidebar.tsx:687-690`). Shell title **설정**
(`clients/web/src/features/settings/SettingsRoute.tsx:189`). Left nav
groups **나** / **워크스페이스** (`:72-93`).

This session's UUID is on the 「워크스페이스 ID」 line of **설정 › 계정**
(`AccountSection.tsx:19-26`).

---

## 3. Create a workspace

Verification: **code-derived** · **needs live run**.

Invites and mentions work with the seed workspace alone. To start a new
team, only the operator can create a tenant
(`server-rust/bins/momo-server/src/routes/workspaces.rs:105-115`,
`require_instance_operator`).

The form on both entries is the same. Field names are the same.

### Entry A — settings

1. **설정 열기** → left nav group **워크스페이스** → **워크스페이스**
   (`SettingsRoute.tsx:81`).
2. Section title **워크스페이스**. Description: 「지금 열려 있는
   워크스페이스를 확인하고, 새 워크스페이스를 만듭니다。」 / 「새
   워크스페이스는 만든 사람이 오너가 되고 #general 채널 하나로
   시작합니다。」 (`WorkspaceSection.tsx:347-353`).
3. Subheading **새 워크스페이스 만들기** (`:385`).

### Entry B — rail

**워크스페이스 추가** on the workspace rail (`WorkspaceRail.tsx:111-112`).
Dialog title **워크스페이스 추가**. Description: 「새 워크스페이스를
만들거나, 초대를 받았다면 초대 링크로 참여합니다。」
(`AddWorkspaceDialog.tsx:208-210`).

### Fields

| Field | Hint | Coordinate |
|---|---|---|
| **이름** | 「사람이 읽는 이름입니다. 80자까지 쓸 수 있습니다。」 | `WorkspaceSection.tsx:398-401` · `AddWorkspaceDialog.tsx:278-280` |
| **슬러그** | Settings: 「영문 소문자, 숫자, 하이픈만 쓸 수 있습니다. 서버 전체에서 하나뿐이어야 합니다。」 / Dialog: 「영문 소문자, 숫자, 하이픈만. 서버 전체에서 하나뿐이어야 합니다。」 | `WorkspaceSection.tsx:416-419` · `AddWorkspaceDialog.tsx:302-304` |

Rules (same as the server): empty → 「슬러그를 입력하세요。」 / 「이름을
입력하세요。」 (`packages/momo-core/src/features/settings/model.ts:308-331`).

Button: **워크스페이스 만들기** (in progress **만드는 중**)
(`WorkspaceSection.tsx:457` · `AddWorkspaceDialog.tsx:367`).

Success card: 「{이름} 워크스페이스를 만들었습니다。」 then **슬러그** ·
**워크스페이스 ID**. Then 「새 워크스페이스로는 그 슬러그로 다시
로그인해서 들어갑니다。」 (`WorkspaceSection.tsx:469-480`). The dialog uses
the same success sentence plus 「슬러그 {slug}. 새 워크스페이스로는 그
슬러그로 다시 로그인해서 들어갑니다。」 (`AddWorkspaceDialog.tsx:221-226`).

**There is no session switch.** To enter the new tenant, **로그아웃**
(`AccountSection.tsx:31-32`) then on the sign-in screen expand 「다른
워크스페이스로 로그인」 and put the success card's **워크스페이스 ID**
(UUID). The sign-in form accepts a UUID, not a slug
(`ConnectPage.tsx:449-500`). An invite is issued to the workspace you are
**in now**. To invite from the seed workspace, do not make this switch.

On 403 the screen replaces the form with: 「새 워크스페이스는 이 서버의
운영자만 만들 수 있습니다。」 (`WorkspaceSection.tsx:388-390`). Look at
step 1's `PLATFORM_ADMIN_EMAILS`.

---

## 4. Issue a web GUI invite

Verification: **code-derived** · **needs live run**. This is the first
document of the GUI invite path. Do not use the ops CLI.

1. **설정 열기** → group **워크스페이스** → **멤버와 초대**
   (`SettingsRoute.tsx:88`).
2. Section title **멤버와 초대**. Description: 「초대 링크를 발급해 사람을
   이 워크스페이스로 부릅니다。」 / 「코드는 발급 직후 한 번만 보입니다.
   서버는 해시만 보관합니다。」 (`InviteSection.tsx:135-137,181`).
3. If none yet, empty state: 「아직 발급한 초대 링크가 없습니다。」 /
   「아래에서 역할과 사용 횟수를 정하고 링크를 만드세요。」 (`:184-185`).
4. Form (`:219-316`):

| Field | Default | Choices · hint | Coordinate |
|---|---|---|---|
| **역할** | 멤버 | **멤버** 「채널을 읽고 씁니다。」 · **관리자** 「초대와 워크스페이스 설정을 다룹니다。」 · **게스트** 「초대받은 채널만 봅니다。」 | `InviteSection.tsx:230-237` · `model.ts:249-253` |
| **사용 횟수** | `1` | 「이 링크로 참여할 수 있는 사람 수입니다。」 1…10000 | `InviteSection.tsx:239-257` |
| **유효 기간** | 7일 | 1일 · 7일 · 30일. Detail per choice: 「{YYYY-MM-DD}까지 쓸 수 있습니다。」 | `InviteSection.tsx:260-271` · `model.ts:255` |

5. **초대 링크 만들기** (in progress **만드는 중**) (`InviteSection.tsx:300`).

Issue card (`:318-368`) — the code is visible again **only on this
screen**:

- 「초대 링크를 만들었습니다. 코드는 이 화면에서만 볼 수 있으니 지금
  전달하세요。」 (`:326-328`)
- **딥링크** — `oort://join?server=<percent-encoded base URL>&code=<code>`
  (`:334-336`, assembled `model.ts:355-356`)
- **서버 주소** — this page's API origin. Self-host web:
  `http://localhost:<port>` (`:338`, `resolveServerBaseUrl` →
  `window.location.origin`, `clients/web/src/lib/serverBase.ts:117-121`)
- **초대 코드** — plaintext once (`:339`)
- **만료** — `{YYYY-MM-DD}, {N}명까지` (`:340-344`)

Three buttons:

- **딥링크 복사** (`:349-352`)
- **초대 카드 복사** (`:354-357`) — card body is
  `packages/momo-core/src/features/settings/model.ts:378-390`
- **메일 초안 열기** (`:359-361`)

Under the card: 「받는 사람은 앱을 설치한 뒤 딥링크를 열면 서버 주소와
코드가 채워진 상태로 참여 화면에 도착합니다。」 (`:364-366`) — this is
**desktop deeplink** copy. Web join is 5A.

What remains on the list is a preview (last few characters) and a status
chip only; the plaintext code is not returned again
(`InviteSection.tsx:198-212`, `model.ts:455-466`).

Permission denied: 「초대 링크는 워크스페이스 오너나 관리자만 발급할 수
있습니다。」 (`InviteSection.tsx:152-154`).

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

When the second user sees the channel list, join is done.

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
http:// 또는 https:// 로 시작해야 합니다。」 (`oauthGrant.ts:234-237`). The
server refuses loopback when `MOMO_ENV=staging`, and a non-loopback address
must be **https only** (`provider.rs:193-198,287,319-327`). A laptop local
model at `http://127.0.0.1:…` does not attach on this path today.

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
실행됩니다。」 (`:392-397`). Put the same OpenAI-compatible `https://…/v1`
as step 6 into **게이트웨이 주소**.

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

If a failure notice appears in the channel,
`scripts/self_host_env.sh --compose logs agent-worker`
(doc-inherited: [`SELF_HOST.md`](SELF_HOST.md) "When stuck").

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
| A loopback provider address is refused | `MOMO_ENV=staging` + loopback ban. External https only | code-derived |

Stack stop · wipe · port collision: [`SELF_HOST.md`](SELF_HOST.md)
"Stop · wipe" "When stuck".

---

## Deeper (after you finish this document)

| Document | When |
|---|---|
| [`SELF_HOST.md`](SELF_HOST.md) | Bring-up failure, secret rotate, putting the key in over REST, outbox query |
| [`onboarding-deeplink.md`](onboarding-deeplink.md) | `oort://join` byte contract |
| [`infra/rust/README.md`](../infra/rust/README.md) | compose overlays, migration logs |
| `infra/prod/momo-ops.sh invite-create` | Ops-host CLI issue. Prints the same deeplink as the GUI on stdout. **Not this document's path** |
| [`AGENT_HOSTING_QUICKSTART.md`](AGENT_HOSTING_QUICKSTART.md) | ACP/workd. Internal-alpha premise. Not the self-host first day |
| `scripts/bench_onboarding.sh` | Wall-clock install→first reply. REST, not GUI |

---

## Quoted coordinates (review)

When the orchestrator checks a running-stack browser, a sentence in this
document that is not on the screen is a defect.

| Surface | File |
|---|---|
| Sign-in / join | `clients/web/src/features/auth/ConnectPage.tsx` |
| Join parser | `packages/momo-core/src/features/auth/deepLink.ts` |
| Settings nav | `clients/web/src/features/settings/SettingsRoute.tsx` |
| Workspace | `…/WorkspaceSection.tsx`, `clients/web/src/features/workspace/AddWorkspaceDialog.tsx` |
| Members and invites | `…/InviteSection.tsx`, `packages/momo-core/src/features/settings/model.ts` |
| AI link | `…/AiLinkSection.tsx` |
| Agent hub | `clients/web/src/features/agentHub/AgentHubRoute.tsx`, `CreateAgentDialog.tsx`, `AgentChannelsSection.tsx` |
| Channel members | `clients/web/src/features/channels/AddChannelMemberDialog.tsx` |
| Mention | `packages/momo-core/src/features/chat/composerCopy.ts`, `clients/web/src/features/chat/Composer.tsx` |
| env / CORS | `scripts/self_host_env.sh` |
