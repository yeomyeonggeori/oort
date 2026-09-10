# 셀프호스트 오퍼레이터의 첫 하루 (SELF_HOST_FIRST_DAY.ko.md)

> **정본은 영문 [`SELF_HOST_FIRST_DAY.md`](SELF_HOST_FIRST_DAY.md) 이다.** 이 파일은 같은 절 번호의 번역이다.
>
> **이 문서 하나로 끝난다.** 깨끗한 클론에서 부트스트랩(키 둘) →
> 비밀번호 클레임 → S1 「내 워크스페이스·내 이름」 → S2 「팀원 초대」
> (또는 「나중에」) → first-run(킥오프-hold → 「첫 에이전트 연결」 →
> 폰 연결) → 둘째 사용자 합류(웹 + 데스크탑 `oort://join`) → AI 연결 →
> 첫 멘션까지. 교차 참조 없이 완주한다. 링크는 심화용이다.
>
> clone→로그인만의 정본은 [`SELF_HOST.md`](SELF_HOST.md)다. 이 문서는 그
> **다음 하루** — GUI 초대 경로를 처음으로 적는다(#1608 / ITO-0 T-B).
> 운영 CLI `momo-ops.sh invite-create`는 여기 절차가 아니다(심화 절).
>
> **방법론(#1535 승계).** 화면의 칸·버튼·문장은 소스에서 인용한다. 소스에
> 없는 문구·칸·화면을 만들지 않는다. 각 스텝에 검증 상태를 붙인다.

---

## 검증 상태

| 표기 | 뜻 |
|---|---|
| **code-derived** | 현재 checkout 소스의 한국어 카피·계약을 `file:line`으로 인용했다 |
| **문서 승계** | [`SELF_HOST.md`](SELF_HOST.md) · [`onboarding-deeplink.md`](onboarding-deeplink.md) · T-A(#1607) 배선과 같다 |
| **실기동 필요** | GUI 클릭 경로. 이 워크트리는 headless라 브라우저/데스크탑을 누르지 않았다. 오케스트레이터가 가동 스택에서 대조한다 |

실키 없이 에이전트가 **답을 쓰는** 것(측정 판정 `ANSWERED`)은 이 문서의
책임이 아니다. 키 주입과 멘션 발화까지가 범위다(`scripts/bench_onboarding.sh`
머리말 M5: `ANSWERED` / `NOTICE` / `BLOCKED`).

---

## 0. 전제

| 필요한 것 | 확인 | 검증 |
|---|---|---|
| Docker Engine + Compose v2 | `docker compose version` | 문서 승계 ([`SELF_HOST.md`](SELF_HOST.md) 「전제」) |
| git | `git --version` | 문서 승계 |
| 둘째 사용자를 넣을 **다른 브라우저 프로필**(또는 시크릿 창) | 같은 origin에 운영자 세션이 남아 있으면 조인 화면이 안 뜬다 | 실기동 필요 |
| (데스크탑 합류) 패키징된 oort 앱 | 스킴 `oort`·`momo` 등록 (`clients/desktop/src-tauri/tauri.conf.json:30`) | code-derived |
| (⑤ 응답) OpenAI 호환 **외부 `https://` 엔드포인트와 키** | 셀프호스트 env는 `MOMO_ENV=staging`이라 루프백 provider는 거절된다 | code-derived (`scripts/self_host_env.sh:607`, `server-rust/crates/momo-settings/src/provider.rs:193-198,287`) |

Rust·Node·`psql`은 설치하지 않는다. 서버·웹이 한 이미지 안에 있다
(문서 승계: [`SELF_HOST.md`](SELF_HOST.md) 「전제」).

**이 인스턴스의 운영자**는 첫 owner 이메일이다. 생성 env가
`PLATFORM_ADMIN_EMAILS`에 그 주소를 넣는다. 그 줄이 없으면 **설정 › AI 연결**과
**워크스페이스 만들기**가 설치한 본인에게도 403이다
(`scripts/self_host_env.sh:28-33,668-679`). 셀프호스트 스택은 `platform:read`
토큰을 발급하지 않는다.

---

## 1. 부트스트랩 — 스택을 띄우고 키 둘을 확인한다

검증: **문서 승계**(명령) · **code-derived**(키 둘·CORS 기본값).

```sh
git clone https://github.com/yeomyeonggeori/oort.git oort
cd oort
scripts/self_host_env.sh --local-build
scripts/self_host_env.sh --compose up -d --build --wait
```

같은 머신에 이미 다른 클론의 셀프호스트 스택이 떠 있으면 이 `up` 은 거절된다.
두 체크아웃 규칙: [`SELF_HOST.md`](SELF_HOST.md) 「두 체크아웃을 같이 쓸 때」.

공개 digest가 있으면 `--published-image` 경로를 쓸 수 있다. 심화:
[`SELF_HOST.md`](SELF_HOST.md) §2.

`--wait`가 끝나면 준비가 끝난 것이다. 스크립트가 찍는 로그인 안내는 대략
이것이다 (`scripts/self_host_env.sh:458-476`):

```
http://localhost:<MOMO_WEB_PORT>     # 기본 8088
email    owner@oort.local           # 또는 MOMO_INITIAL_OWNER_EMAIL
password infra/rust/local.secrets.env 의 MOMO_INITIAL_OWNER_PASSWORD
```

비밀번호는 stdout에 없다. 파일 권한 600, 커밋 대상 아님.

### 키 둘

생성 env(`infra/rust/local.secrets.env`)에 다음이 **이미** 들어 있다. 손으로
채우지 않는다.

| 키 | 하는 일 | 좌표 |
|---|---|---|
| `PLATFORM_ADMIN_EMAILS` | 첫 owner를 인스턴스 운영자로 선언. **설정 › AI 연결** · **새 워크스페이스 만들기**가 열린다 | `scripts/self_host_env.sh:668-679` |
| `PROVIDER_LINK_MASTER_KEY` | provider 키를 DB에 암호화해 저장. 없으면 AI 연결이 503 | `scripts/self_host_env.sh:630` |

기존 env에는 그 줄이 없을 수 있다. 같은 모드로 `scripts/self_host_env.sh`를
다시 실행하면 **그 줄만 덧붙인다** — 시크릿은 다시 만들지 않는다
(`ensure_operator_allowlist`, `scripts/self_host_env.sh:300-318`). 덧붙인 뒤
api를 재시작한다: `scripts/self_host_env.sh --compose up -d`.

확인:

```sh
grep -E '^(PLATFORM_ADMIN_EMAILS|PROVIDER_LINK_MASTER_KEY|MOMO_CORS_ALLOWED_ORIGINS)=' \
  infra/rust/local.secrets.env
```

`PLATFORM_ADMIN_EMAILS`는 이메일이 보여도 된다. `PROVIDER_LINK_MASTER_KEY`의
값은 화면에 붙여 넣지 않는다 — 줄이 **있는지만** 본다.

### 데스크탑 CORS (T-A / #1607 — 자리 표시가 아니다)

생성 env는 Tauri webview origin 2종을 **기본 포함**한다.

- REST: `MOMO_CORS_ALLOWED_ORIGINS=tauri://localhost,http://tauri.localhost`
  (`scripts/self_host_env.sh:103,655`)
- 실시간: `CENTRIFUGO_ALLOWED_ORIGINS`에 같은 2종을 **공백 구분**으로
  (`scripts/self_host_env.sh:104,643`). REST만 열고 WSS를 안 열면 로그인은
  되고 실시간이 403이다.

`infra/rust/docker-compose.rust.yml`의 compose 기본값은 여전히 빈 값이다.
`caddy.override.yml` 운영 경로는 이 파일을 읽지 않는다. 브라우저 셀프호스트는
같은 오리진이라 CORS가 필요 없다 (`scripts/self_host_env.sh:35-43,633-636,648-655`).

기존 env는 CORS 키가 **없을 때만** 한 줄을 추가한다. 빈 값·커스텀 값은
덮어쓰지 않는다 (`scripts/self_host_env.sh:321-345`). Centrifugo 목록에 tauri
origin이 없으면 stderr로만 알리고 줄을 고치지 않는다 (`:348-366`).

---

## 2. 첫 실행 — 비밀번호 클레임, 이어서 S1 · S2 · 첫 에이전트 · 폰 연결

검증: **code-derived**(화면) · **실기동 필요**(클릭).

첫 하루는 ConnectPage로 데모 이름표에 들어가는 로그인이 아니다. 비밀번호
클레임 → S1 「내 워크스페이스·내 이름」(`1/2`) → S2 「팀원 초대」(`2/2`,
건너뛰기 「나중에」) → first-run(킥오프-hold → 「첫 에이전트 연결」 →
폰 연결). 클레임 비밀번호는 스텝 카운터에 넣지 않는다
(`clients/web/src/features/auth/onboardingFlow.ts` `OWNER_ONBOARDING_STAGES`).

클레임이 꺼진 env-비밀번호 ConnectPage 경로는
[`SELF_HOST.md`](SELF_HOST.md)에 그대로 있다. 그 경로는 S1/S2를 **열지
않는다**. `MOMO_CLAIM_PATH` 수거 어휘는
[`SELF_HOST_AGENT.md`](SELF_HOST_AGENT.md) §3.3.5.

### 비밀번호 클레임

클레임은 해시 라우트가 아니라 실제 경로다
(`clients/web/src/features/auth/claimPath.ts`). 연다:

```
http://localhost:<MOMO_WEB_PORT>/claim/<token>
```

migrate는 첫 `up`에서 `MOMO_CLAIM_PATH=/claim/<token>`을 **한 번만**
찍는다. 재시작은 `MOMO_BOOTSTRAP_CLAIM=skipped`. 토큰을 대화에 붙여 넣지
않는다(ADR-0004).

화면 제목 **oort**. 설명 「첫 비밀번호를 설정합니다。」
(`ClaimPage.tsx:136-143`). 칸: **새 비밀번호** · **비밀번호 확인**(둘 다
「필수」). 제출 **비밀번호 설정**(진행 중 **설정 중…**)(`:187-238`).
불일치: 「두 칸의 비밀번호가 같지 않습니다。」(`:227`). 토큰 없음: 「이
링크는 유효하지 않습니다. 받은 주소를 그대로 여세요。」(`:164`).
오프라인: 「오프라인입니다. 네트워크가 연결되면 다시 시도하세요。」(`:150`).

성공하면 first-run 마커와 온보딩 pending 플래그를 찍고 S1을 연다
(`ClaimPage.tsx` → `OwnerOnboarding`).

### S1 — 내 워크스페이스·내 이름 (1/2)

크롬 카운터 **`1/2`**. 제목 **내 워크스페이스·내 이름**
(`s1Copy.ts` `S1_TITLE`, `OwnerOnboarding.tsx`). 리드: 「워크스페이스
이름과 여기서 다른 멤버에게 보이는 이름과 핸들을 정합니다。」
(`S1_LEAD`).

| 칸 | 메모 | 좌표 |
|---|---|---|
| **워크스페이스 이름** | 시드 표시 이름을 덮어쓴다. 슬러그가 아니다 | `WorkspaceProfileStage.tsx` |
| **표시 이름** | 오너 프로필 | 같음 |
| **핸들** | `@`가 칸 안에 산다 (`HandleField.tsx`) | 같음 |

제출 **이름 저장**(진행 중 **저장 중**, 재시도 **다시 시도**)
(`S1_PRIMARY_*`). 재진입 문장, 상시: 「나중에 설정 › 워크스페이스 /
프로필에서 바꿀 수 있습니다。」(`S1_REENTRY`). 그 문: **설정 ›
워크스페이스**의 **워크스페이스 이름** / **이름 저장**; **설정 ›
프로필**의 편집 가능한 **표시 이름** + **핸들** / **프로필 저장**
(`WorkspaceSection.tsx`, `ProfileSection.tsx`).

저장 실패 때만 **지금은 건너뛰기**(`S1_SKIP_LABEL`) — S2의 상시 skip이
아니다. 오프라인: 「연결이 끊겨 지금은 이름을 저장할 수 없습니다. 다시
연결되면 이어서 저장할 수 있습니다。」

### S2 — 팀원 초대 (2/2)

크롬 카운터 **`2/2`**. 제목 **팀원 초대**(`s2Copy.ts` `S2_TITLE`). 리드는
설정 › 멤버와 초대와 같은 두 문장이다(`S2_LEAD` = `InviteSection` lines).

역할 / 횟수 / TTL 칸은 없다. 봉인 기본값: 역할 `member`, 사용 1회, TTL
24h(`onboardingFlow.ts` `OWNER_INVITE_*`). 프라이머리 **초대 링크
만들기**(진행 중 **만드는 중**) — 설정과 같은 라벨(`inviteLabels.ts`).
고스트 **나중에**(`S2_SKIP_LABEL`)는 발급 전까지 상시. skip은 코드
**0건**. 재진입 문장, 상시: 「설정 › 멤버와 초대에서 언제든 이어서 초대할
수 있습니다。」(`S2_SKIP_SENTENCE`).

발급 뒤 일회 카드는 `IssuedInviteCard` `copyMode="single"` — **초대 카드
복사**만. 그다음 프라이머리는 **계속**(`S2_CONTINUE_LABEL`). 카드 본문은
§4.

오프라인: 「연결이 끊겨 지금은 초대 링크를 만들 수 없습니다. 다시 연결되면
이어서 만들 수 있습니다。」(`S2_OFFLINE_REASON` — 설정과 같은 문장).

### 온보딩 뒤 — first-run

순서는 이미 표다: 킥오프-hold → 첫 에이전트 → 폰 연결
(`firstAgent.ts` `FIRST_AGENT_STAGE_ORDER`, `firstRunGate.ts`
`decideFirstRun`).

셀프호스트 env는 `MOMO_AGENT_SEED_MODE=none`이다
(`scripts/self_host_env.sh`). **김인턴은 없다.** `decideWelcomeMount` 사유
`no-active-agent`가 hold를 바로 푼다 — 120s 백스톱 카드 없음
(`welcomeKickoff.ts`). 다음 스테이지 제목은 **첫 에이전트 연결**
(`FIRST_AGENT_TITLE`). 리드 「팀에 붙일 에이전트를 고르세요。」 Skip
**나중에**; 재진입 「나중에 설정 › 연결 › 에이전트 자격에서 이어갈 수
있습니다.」 카드는 Claude Code · Codex · Grok Bot · **OpenAI 호환**(마지막은
설정 › AI 연결 — §6). 네이티브 에이전트 + 멘션은 그대로 §7.

첫 에이전트가 웰컴 발화 가능 상태가 되면(네이티브 생성 tx **또는** hosted
connection `active`) 서버는 오너 오프너가 아직 없을 때 enqueue한다
(`routes/welcome.rs` `enqueue_owner_welcome_kickoff_in_tx`). hosted 스피커는
게이트웨이 레일, 네이티브는 워커 레일. 배달 불가 hosted 스피커는 오프너
마커를 소비하지 않는다.

그다음 **폰에서도 쓰기**(`PhoneLinkFirstRun.tsx`). 리드: 「같은 계정으로
폰을 붙이려면 지금 QR을 만들 수 있습니다. 나중에 설정 기기에서도 열 수
있습니다。」 outline **앱으로 들어가기**.

들어간 뒤 설정: 프로필 카드 행 **설정**, 툴팁 「설정 (⌘,)」
(`ProfileCard.tsx:175-189`). 셸 제목 **설정**(`SettingsRoute.tsx:172`).
좌측 나브 그룹 **개인** / **워크스페이스** / **연결**(`settingsNav.ts`).
이 세션의 UUID는 **설정 › 계정**의 「워크스페이스 ID」 줄
(`AccountSection.tsx:22-26`).

### v0.1.5에 남는 것

온보딩은 **보이는** 워크스페이스 이름과 오너의 표시 이름·핸들을
덮어쓴다. 시드 행 자체는 **지우지 않는다**(ADR-0185 §6, D-B (b)).
v0.1.5에 남는 것:

- 슬러그 **`demo`**
- 고정 워크스페이스 UUID `00000000-0000-7000-8000-000000000001`
- 시드 채널 `#agent-lab`(`#general` 옆,
  `server/Migrations/002_seed.sql`)

클레임은 그 시드 human에 첫 오너를 입양한다
(`infra/rust/sql/bootstrap_owner_if_absent.sql`,
`bootstrap_owner_claim_if_absent.sql`). **새** 테넌트 만들기는 이 첫 하루
경로가 아니다 — §3. 시드 제거는 SH-12z.

---

## 3. 운영자 기능 — 워크스페이스 만들기

검증: **code-derived** · **실기동 필요**.

이것은 **첫 하루 퍼널이 아니다.** 초대와 멘션은 S1이 방금 이름 붙인
워크스페이스에서 된다. `POST /v1/workspaces`는 그대로
`require_instance_operator`다
(`server-rust/bins/momo-server/src/routes/workspaces.rs:200-216`).
ADR-0185는 그 게이트를 풀지 않는다. 새 테넌트는 온보딩 3스텝이 아니라
운영자 추가 동작이다.

두 입구의 폼은 같다. 칸 이름도 같다.

### 입구 A — 설정

1. **설정** → 좌측 나브 그룹 **워크스페이스** → **워크스페이스**
   (`settingsNav.ts`).
2. 섹션 제목 **워크스페이스**. 설명: 「지금 열려 있는 워크스페이스를 확인하고,
   새 워크스페이스를 만듭니다.」 / 「새 워크스페이스는 만든 사람이 오너가 되고
   #general 채널 하나로 시작합니다.」
   (`WorkspaceSection.tsx:887-893`).
3. 소제목 **새 워크스페이스 만들기** (`:944`). 그 위에는 현재 테넌트
   카드(S1의 설정 문인 **워크스페이스 이름** / **이름 저장** 포함)와
   역할 표시 이름, 웰컴 킥오프, 언펄, 나가기가 있다.

### 입구 B — 레일

워크스페이스 레일의 **워크스페이스 추가** (`WorkspaceRail.tsx:113-114`)와
프로필 카드 메뉴(`ProfileCard.tsx:161-172`). 다이얼로그 제목
**워크스페이스 추가**. 설명: 「새 워크스페이스를 만들거나, 초대를 받았다면
초대 링크로 참여합니다.」
(`AddWorkspaceDialog.tsx:214-217`).

### 칸

| 칸 | 힌트 | 좌표 |
|---|---|---|
| **이름** | 「사람이 읽는 이름입니다. 80자까지 쓸 수 있습니다.」 | `WorkspaceSection.tsx:957-960` · `AddWorkspaceDialog.tsx:283-286` |
| **슬러그** | 설정: 「영문 소문자, 숫자, 하이픈만 쓸 수 있습니다. 서버 전체에서 하나뿐이어야 합니다.」 / 다이얼로그: 「영문 소문자, 숫자, 하이픈만. 서버 전체에서 하나뿐이어야 합니다.」 | `WorkspaceSection.tsx:975-978` · `AddWorkspaceDialog.tsx:307-310` |

규칙(서버와 동일): 비면 「슬러그를 입력하세요.」 / 「이름을 입력하세요.」
(`packages/momo-core/src/features/settings/model.ts:392-412`).

버튼: **워크스페이스 만들기** (진행 중 **만드는 중**)
(`WorkspaceSection.tsx:1016` · `AddWorkspaceDialog.tsx:373`).

성공 카드: 「{이름} 워크스페이스를 만들었습니다.」 그리고 **슬러그** ·
**워크스페이스 ID**. 이어서 「새 워크스페이스로는 그 슬러그로 다시 로그인해서
들어갑니다.」 (`WorkspaceSection.tsx:1028-1038`). 다이얼로그는 같은 성공 문장에
「슬러그 {slug}. 새 워크스페이스로는 그 슬러그로 다시 로그인해서 들어갑니다.」
(`AddWorkspaceDialog.tsx:227-232`).

**세션 전환은 없다.** 새 테넌트에 들어가려면 **로그아웃**
(`AccountSection.tsx:31-32`) 후 로그인 화면에서 「다른 워크스페이스로 로그인」을
펼쳐 성공 카드의 **워크스페이스 ID**(UUID)를 넣는다. 로그인 폼이 받는 것은
슬러그가 아니라 UUID다 (`ConnectPage.tsx`). 초대는 **지금 들어와 있는**
워크스페이스에 발급된다. 첫 하루 초대는 S1이 이름 붙인 워크스페이스에
둔다 — 이 전환을 하지 않는다.

403이면 화면이 폼 대신 이렇게 바뀐다: 「새 워크스페이스는 이 서버의 운영자만
만들 수 있습니다.」 (`WorkspaceSection.tsx:947-949`). 1단계의
`PLATFORM_ADMIN_EMAILS`를 본다.

---

## 4. 초대 — S2와 설정의 재진입

검증: **code-derived** · **실기동 필요**. 운영 CLI는 쓰지 않는다. S2와
설정 › 멤버와 초대는 `useIssueInvite` + `IssuedInviteCard`를 공유한다.

### 첫 실행의 S2

S2가 첫 하루의 초대다: 봉인된 링크 하나(멤버 · 1회 · 24h) 또는
**나중에**. 복사와 일회 카드는 설정과 같은 컴포넌트이고, S2 카드는
`copyMode="single"`(**초대 카드 복사**만). 카드 바이트는 아래. skip 또는
**계속** 뒤 §2의 first-run이 시작된다.

### 설정 › 멤버와 초대

S2 뒤 재진입, 그리고 역할 / 횟수 / TTL을 고를 수 있는 경로.

1. **설정** → 그룹 **워크스페이스** → **멤버와 초대** (`settingsNav.ts`).
2. 섹션 제목 **멤버와 초대**. 설명: 「초대 링크를 발급해 사람을 이
   워크스페이스로 부릅니다.」 / 「코드는 발급 직후 한 번만 보입니다. 서버는
   해시만 보관합니다.」 (`InviteSection.tsx:112-114`).
3. 아직 없으면 빈 상태: 「아직 발급한 초대 링크가 없습니다.」 / 「아래에서
   역할과 사용 횟수를 정하고 링크를 만드세요.」 (`:150-154`).
4. 폼 (`:187-288`):

| 칸 | 기본 | 선택지·힌트 | 좌표 |
|---|---|---|---|
| **역할** | 멤버 | **멤버** 「채널을 읽고 씁니다.」 · **관리자** 「초대와 워크스페이스 설정을 다룹니다.」 · **게스트** 「초대받은 채널만 봅니다.」 | `InviteSection.tsx:198-205` · `model.ts:255-258` |
| **사용 횟수** | `1` | 「이 링크로 참여할 수 있는 사람 수입니다.」 1…10000 | `InviteSection.tsx:207-226` |
| **유효 기간** | 7일 | 1일 · 7일 · 30일. 각 선택 상세: 「{YYYY-MM-DD}까지 쓸 수 있습니다.」 | `InviteSection.tsx:228-239` · `model.ts:277` |

5. **초대 링크 만들기** (진행 중 **만드는 중**) (`inviteLabels.ts`,
   `InviteSection.tsx:272`).

발급 카드 (`IssuedInviteCard.tsx`) — 코드는 **이 화면에서만** 다시 보인다:

- 「초대 링크를 만들었습니다. 코드는 이 화면에서만 볼 수 있으니 지금
  전달하세요.」 (`:49-51`)
- **딥링크** — `oort://join?server=<percent-encoded base URL>&code=<code>`
  (`:57-59`, 조립 `model.ts:439-440`)
- **서버 주소** — 이 페이지의 API origin. 셀프호스트 웹이면
  `http://localhost:<port>` (`:61`, `resolveServerBaseUrl` →
  `window.location.origin`, `clients/web/src/lib/serverBase.ts`)
- **초대 코드** — 원문 한 번 (`:62`)
- **만료** — `{YYYY-MM-DD}, {N}명까지` (`:63-67`)

설정은 버튼 셋이다(`copyMode` 기본 `full`):

- **딥링크 복사** (`IssuedInviteCard.tsx:81-85`)
- **초대 카드 복사** (`:86-90`) — 카드 본문은
  `packages/momo-core/src/features/settings/model.ts:462-474`
- **메일 초안 열기** (`:91-93`)

카드 아래: 「받는 사람은 앱을 설치한 뒤 딥링크를 열면 서버 주소와 코드가
채워진 상태로 참여 화면에 도착합니다.」 (`:98-100`) — 이것은 **데스크탑
딥링크** 안내문이다. 웹 합류는 5A.

목록에 남기는 것은 미리보기(끝 몇 글자)와 상태 칩뿐이며, 원문 코드는 다시
내려오지 않는다 (`InviteSection.tsx:163-180`).

권한 거부: 「초대 링크는 워크스페이스 오너나 관리자만 발급할 수 있습니다.」
(`InviteSection.tsx:130`).

---

## 5. 둘째 사용자 합류 — 웹과 데스크탑

검증: **code-derived**(두 입구의 파서·화면) · **실기동 필요**(실제 합류).

발급 카드가 **복사 버튼으로 만드는 링크는 `oort://join` 하나**다. 브라우저용
HTTP 링크를 만드는 버튼은 없다. 웹은 같은 `server`·`code`를 페이지 URL에서
읽거나, 로그인 화면에서 코드를 직접 넣는다.

둘째 사용자는 **운영자와 다른 브라우저 프로필**에서 한다. 운영자 세션이 있는
탭에서는 연결 화면이 아니다.

### 5A. 웹 — 브라우저에서 초대 코드로 참여

**경로 1 — 화면에서 전환 (버튼이 있는 경로)**

1. `http://localhost:<port>` 를 연다.
2. 카드 아래 **초대 코드로 참여** (`ConnectPage.tsx:532-546`). 설명이
   「초대 코드로 워크스페이스에 참여합니다.」로 바뀐다 (`:288-289`).
3. 칸:

| 칸 | 힌트 | 좌표 |
|---|---|---|
| **서버 주소** (선택) | 비운다. 같은 페이지를 연 주소가 서버다 | `:338,261-263` |
| **초대 코드** (필수) | 발급 카드의 **초대 코드** | `:384-396` |
| **이메일** (필수) | 「워크스페이스에 초대받은 주소」 — 아직 없는 **새** 주소 | `:401-418` |
| **비밀번호** (필수) | 「이 워크스페이스에서 쓸 비밀번호를 새로 정합니다」 | `:422-445` |

표시 이름과 핸들은 이메일에서 파생하고 화면에 칸이 없다
(`packages/momo-core/src/lib/api.ts:799-819`, `POST /v1/join`).

4. 제출 버튼 라벨도 **초대 코드로 참여**다 (진행 중 **참여 중…**)
   (`ConnectPage.tsx:264-268`).

로그인으로 돌아가려면 **로그인으로 전환** (`:545`).

**경로 2 — 페이지 URL 프리필 (조립하는 웹 조인 링크)**

이 클라의 라우터는 HashRouter다 (`clients/web/src/app/App.tsx:28-31,65`).
연결 화면은 페이지 URL에서 `server`·`code`를 읽고, 읽은 뒤 주소창에서 지운다
— 코드는 bearer 비밀이다 (`useJoinPrefill.ts:16-21,38-42`,
`packages/momo-core/src/features/auth/deepLink.ts:116-144,146-172`).

둘째 사용자에게 건넬 수 있는 웹 주소(발급 카드가 만들지는 않음):

```
http://localhost:<port>/#/?code=<초대 코드>
```

같은 파라미터를 쿼리에 실어도 된다 (`?code=`, 또는 딥링크 전체를
`?join=<percent-encoded oort://join…>`). 코드가 있으면 모드가 참여로 바뀌고
초대 코드 칸이 채워진다 (`ConnectPage.tsx:176-195`).

### 5B. 데스크탑 — `oort://join`

1. 발급 카드에서 **딥링크 복사**. 형식 정본:
   `oort://join?server=<percent-encoded base URL>&code=<invite code>`
   ([`onboarding-deeplink.md`](onboarding-deeplink.md), `model.ts:348-356`).
   구 스킴 `momo://join`도 소비한다 (`deepLink.ts:67`,
   `tauri.conf.json:30`).
2. 패키징된 앱이 있는 기기에서 그 링크를 연다. 셸이 URL을 넘기고, 연결 화면이
   서버 주소와 초대 코드를 채운 뒤 참여 모드로 전환한다
   (`useJoinPrefill.ts:14-16,45-77`).
3. 데스크탑은 서버 주소가 **필수**다. 힌트: 「데스크톱 앱은 접속할 서버 주소가
   필요합니다.」 (`ConnectPage.tsx:261-262`, `requiresServerUrl`:
   `serverBase.ts:108-110`). 딥링크가 채운 값이 셀프호스트 엣지 —
   `http://localhost:<port>` — 인지 본다.
4. **이메일** · **비밀번호**만 넣고 **초대 코드로 참여**.

생성 env의 CORS 기본값(§1)이 이 교차 오리진을 연다. 로그인 뒤 메시지가
실시간으로 안 오면 REST가 아니라 Centrifugo origin을 본다(§1 CORS 절,
`scripts/self_host_env.sh:640-643`).

macOS LaunchServices는 dev/release 스킴 핸들러를 하나만 고른다. 링크가 다른
빌드를 열면 서버 주소가 비거나 다른 스택을 가리킬 수 있다(패킷 T-A 함정.
이 워크트리에서 실측하지 않음 — 실기동 필요).

합류 실패 문장(웹·데스크탑 동일 화면):

| 상황 | 화면 |
|---|---|
| 코드가 없음 | 「유효하지 않은 초대 코드입니다. 초대한 사람에게 링크를 다시 확인하세요.」 |
| 만료 | 「만료된 초대입니다. 워크스페이스 관리자에게 새 초대 링크를 요청하세요.」 |
| 횟수 소진 | 「사용 횟수가 모두 찬 초대입니다. …」 |
| 이미 이 코드로 가입 | 「이미 이 초대로 가입한 계정입니다. 로그인하세요.」 (`suggestSignIn`) |

좌표: `packages/momo-core/src/features/auth/connectModel.ts:47,75-123`.

둘째 사용자가 채널 목록을 보면 합류는 끝난 것이다. 그 로그인 뒤 first-run
순서는 웰컴 킥오프 → 첫 에이전트 연결 → 폰 연결이다. 로그인 전 4/4 카운터
(`ConnectPage`)는 그대로다.

---

## 6. AI 연결 — 키를 넣는다

검증: **code-derived** · **실기동 필요**(저장·확인) · 실키 `ANSWERED`는
범위 밖.

운영자 세션에서:

1. **설정 열기** → 그룹 **워크스페이스** → **AI 연결**
   (`SettingsRoute.tsx:79`).
2. 섹션 제목 **AI 연결**. 설명: 「에이전트가 사용할 provider를 이 서버 전체에
   하나로 연결합니다.」 / 「자격증명은 이 서버에만 저장되고 응답으로 다시
   내려오지 않습니다. 저장한 뒤에는 등록 여부와 마지막 4자리만 보입니다.」
   (`AiLinkSection.tsx:411-414,529`).
3. 비어 있으면: 「에이전트가 쓸 AI를 연결하세요.」 버튼 **provider 연결하기**
   (`:531-540`).
4. **등록 방식** 기본값 **키** — 「provider가 발급한 API 키를 직접 넣습니다.
   제품 기본 경로입니다.」 (`:91-96,616-622`). (다른 방식 **ChatGPT 계정
   (OAuth)** 은 내부용 경로이며 첫 하루의 기본이 아니다.)
5. 칸:

| 칸 | 힌트 | 좌표 |
|---|---|---|
| **provider 주소** | 「예: https://api.example.com/v1」 | `AiLinkSection.tsx:625-631` |
| **키** | 「입력한 값은 저장 즉시 암호화되며 화면으로 다시 돌아오지 않습니다.」 `type="password"` | `:646-659` |
| **모드** | 기본 **외부 provider** 「저장한 주소와 키로 실제 provider에 연결합니다.」 | `:662-668` · `model.ts:25-30` |

주소는 `http://` 또는 `https://`로 시작해야 한다. 아니면 「주소는 http://
또는 https:// 로 시작해야 합니다.」 (`oauthGrant.ts:234-237`). 서버는
`MOMO_ENV=staging`에서 루프백을 거절하고, 루프백이 아닌 주소는 **https만**
받는다 (`provider.rs:193-198,287,319-327`). 노트북의
`http://127.0.0.1:…` 로컬 모델은 오늘 이 경로로 붙지 않는다.

6. **연결 저장** (이미 연결이 있으면 **연결 교체 저장**, 진행 중 **저장 중**)
   (`AiLinkSection.tsx:777-781`).
7. **연결 확인** (`:811`). 성공 시 「{endpoint} 응답을 확인했습니다.」
   (`model.ts:285`).

키가 화면에 다시 나오지 않는다. 카드의 「저장된 키」는 `••••` + 끝 네 자리
(`model.ts:264-266`, `AiLinkSection.tsx:504-508`). 칩 **연결됨** (`:107-109`).

| 화면 | 원인 |
|---|---|
| 「provider 연결은 이 서버의 운영자만 바꿀 수 있습니다.」 | 403. `PLATFORM_ADMIN_EMAILS` (`AiLinkSection.tsx:428-430`) |
| 503 | `PROVIDER_LINK_MASTER_KEY` 없이 api가 뜸 (문서 승계: [`SELF_HOST.md`](SELF_HOST.md) 「막히면」) |

키 저장은 DB 행이라 **재시작하지 않는다**. `PLATFORM_ADMIN_EMAILS`만 api
재시작이 필요하다 ([`SELF_HOST.md`](SELF_HOST.md) §5 표,
`scripts/self_host_env.sh:677-678`).

REST로 같은 PUT을 하는 절차는 심화: [`SELF_HOST.md`](SELF_HOST.md) §5.

---

## 7. 에이전트 만들기 → 채널에 넣기 → 첫 멘션

검증: **code-derived** · **실기동 필요**. `ANSWERED`는 실키 + 외부 https
엔드포인트가 실제로 답할 때만.

셀프호스트 시드는 에이전트를 넣지 않는다(§2). 만든다.

### 만들기

1. 사이드바 **에이전트** (`Sidebar.tsx:457`) — 라우트 제목도 **에이전트**
   (`AgentHubRoute.tsx:375`). 설명: 「워크스페이스 에이전트를 만들고, 상태와
   기억, 작업 이력을 한 곳에서 봅니다.」 (`:377-379`).
2. **에이전트 만들기** (`:409`). 오너/관리자에게만 선다 (`:325-334`).
3. 다이얼로그 제목 **에이전트 만들기**. 설명: 「에이전트는 워크스페이스의
   멤버가 됩니다. 만든 뒤 채널에 넣으면 그 채널에서 멘션할 수 있습니다.」
   (`CreateAgentDialog.tsx:231-234`).
4. 칸 (자격증명 칸은 없다):

| 칸 | 힌트 | placeholder |
|---|---|---|
| **표시 이름** | 「사람들이 목록과 메시지에서 보게 될 이름입니다. 100자 이내.」 | `김인턴` |
| **핸들** | 「멘션에 쓰는 이름입니다. 영문 소문자, 숫자, 하이픈, 밑줄로 2자 이상 32자 이내. …」 | `kim-intern` |
| **모델** | 「이 에이전트가 기본으로 쓸 모델 이름입니다. …」 | `hermes-agent` |
| **게이트웨이 주소** | 「이 에이전트를 실행할 곳입니다. 외부 주소는 https, 같은 기기라면 포트까지 적습니다.」 | `https://gateway.example.com/v1` |
| **지시문** (선택) | 「선택 사항입니다. 답변 방식과 작업 경계를 적으면 첫 프로필로 저장됩니다.」 | |

좌표: `CreateAgentDialog.tsx:252-375`.

폼 아래 고정 문장: 「API 키는 여기에 넣지 않습니다. 프로바이더 자격증명은
설정의 AI 연결에서 한 번만 등록하고, 에이전트는 그 연결을 통해 실행됩니다.」
(`:392-397`). **게이트웨이 주소**에는 6단계와 같은 OpenAI 호환 `https://…/v1`를
넣는다.

5. **에이전트 만들기** (진행 중 **에이전트 만드는 중**) (`:434`).

빈 명부: 「이 워크스페이스에는 에이전트가 없습니다.」 / 「에이전트를 만들고
채널에 넣으면 그 채널에서 멘션할 수 있습니다.」 (`AgentHubRoute.tsx:441-444`).

### 채널에 넣기

만들기는 신원만 만들고 채널에는 넣지 않는다
(`packages/momo-core/src/features/agents/channelPlacement.ts:12-15`).
멘션이 전달되려면 채널 멤버여야 한다.

**허브에서 (전용 배치):** 방금 만든 에이전트를 고른다. 상세 아래 소제목
**채널**. 「이 에이전트가 들어가 있는 채널입니다. 채널에 있어야 그 채널에서
멘션할 수 있습니다.」 (`AgentChannelsSection.tsx:114-117`). 비어 있으면
「아직 어떤 채널에도 들어가 있지 않습니다.」 (`:156-157`). 라벨 **채널에 추가**,
선택 placeholder **채널 고르기**(옵션 글자는 `#general`처럼 `#`+이름,
`AgentChannelsSection.tsx:284-295`), 제출 **채널에 추가** (`:268-310`). 성공:
「{이름}을(를) #{채널}에 추가했습니다. 이제 그 채널에서 멘션할 수 있습니다.」
(`channelPlacement.ts:117-119`). 첫 하루는 시드 채널 `agent-lab` 또는
`general`.

**채널에서:** 사이드바에서 `agent-lab`(또는 `general`)을 연다. 빈 채널이면
「이 채널을 첫 메시지로 시작하세요.」 보조 버튼 **멤버 추가하기**
(`packages/momo-core/src/features/timeline/model.ts:75-76,123-129`). 다이얼로그
제목 **멤버 추가** (`AddChannelMemberDialog.tsx:370`). 섹션 **에이전트**
(`:350`). 행의 **추가** (`:154`).

워크스페이스에 운영자만 있으면 이 다이얼로그는 「이 워크스페이스에 다른 멤버가
없습니다.」이고 **멤버 초대하기**가 설정 › 멤버와 초대로 보낸다
(`AddChannelMemberDialog.tsx:305-317`) — 그것은 사람 초대이지 에이전트 배치가
아니다. 에이전트를 먼저 만든 뒤에는 허브의 **채널에 추가**가 막다른 길이
아니다.

### 멘션

채널 입력창. 넓은 창의 플레이스홀더는 「{채널이름}에 메시지 보내기, @로
부르기」 (`packages/momo-core/src/features/chat/composerCopy.ts:191,378-388`).
`@` 뒤에 핸들을 고른다. 예: 핸들이 `kim-intern`이면 `@kim-intern 안녕`.
보내기: **메시지 보내기 (Enter)** (`Composer.tsx:855-860`).

에이전트가 채널에 쓴 메시지가 보이면 첫 하루의 GUI 경로는 닫힌다.

그 메시지가 **답**인지 **실패 고지**인지는 별개다
(`scripts/bench_onboarding.sh:28-40`):

| 판정 | 뜻 |
|---|---|
| `ANSWERED` | provider가 실제로 답했다. 실키 + 외부 https가 필요하다 |
| `NOTICE` | 워커가 실패를 채널에 고지했다. 키 없는 기본 측정값 |
| `BLOCKED` | 에이전트 메시지가 나타나지 않았다 |

채널에 실패 고지가 뜨면 `scripts/self_host_env.sh --compose logs agent-worker`
(문서 승계: [`SELF_HOST.md`](SELF_HOST.md) 「막히면」).

---

## 막히면

| 증상 | 원인과 조치 | 검증 |
|---|---|---|
| 설정 › AI 연결 / 워크스페이스 만들기가 운영자 안내문으로 바뀐다 | `PLATFORM_ADMIN_EMAILS` 없음 또는 이 이메일이 아님. env에 줄을 덧붙인 뒤 api 재시작 | code-derived · 문서 승계 |
| AI 연결 503 | `PROVIDER_LINK_MASTER_KEY` 없이 api가 뜸 | 문서 승계 |
| 초대 만들기 버튼이 흐리고 「연결이 끊겨 지금은 초대 링크를 만들 수 없습니다. …」 | 오프라인 (`InviteSection.tsx:67-68,306-313`) | code-derived |
| 웹에서 딥링크 `oort://join`을 주소창에 넣는다 | 커스텀 스킴은 브라우저 경로가 아니다. 5A를 탄다 | code-derived |
| 데스크탑 로그인 뒤 실시간만 안 된다 | REST CORS와 Centrifugo origin은 별개. `CENTRIFUGO_ALLOWED_ORIGINS`에 tauri 2종이 있는지 본다 | code-derived (#1607) |
| 에이전트를 만들었는데 멘션에 반응이 없다 | 채널에 안 넣었거나(7단계 배치), 키를 안 넣었거나(6단계), 엔드포인트가 거절한다 | code-derived |
| 루프백 provider 주소가 거절된다 | `MOMO_ENV=staging` + 루프백 금지. 외부 https만 | code-derived |

스택 정지·삭제·포트 충돌은 [`SELF_HOST.md`](SELF_HOST.md) 「멈추기 · 지우기」
「막히면」.

---

## 심화 (이 문서로 완주한 뒤)

| 문서 | 언제 |
|---|---|
| [`SELF_HOST.md`](SELF_HOST.md) | 기동 실패, 시크릿 회전, REST로 키 넣기, outbox 질의 |
| [`SELF_HOST_AGENT.md`](SELF_HOST_AGENT.md) | 운영자 claim 경로 수거 (`MOMO_CLAIM_PATH`) |
| [`onboarding-deeplink.md`](onboarding-deeplink.md) | `oort://join` 바이트 계약 |
| [`infra/rust/README.md`](../infra/rust/README.md) | compose 오버레이, 마이그레이션 로그 |
| 은퇴 운영 CLI `invite-create` | 은퇴 (역사 Swift prod 트리 `f399e417`). 이 문서의 경로가 아니다 |
| workd / ACP 호스팅 | LS-1(#2165)에서 은퇴. 원본 `f399e417:infra/workd` · `f399e417:docs/AGENT_HOSTING_QUICKSTART.md`. 셀프호스트 첫 하루가 아니다 |
| `scripts/bench_onboarding.sh` | 설치→첫 응답 벽시계. GUI가 아니라 REST |

---

## 인용 좌표 (검수)

오케스트레이터가 가동 스택 브라우저로 대조할 때, 화면에 없는 문구가 이 문서에
있으면 결함이다.

| 표면 | 파일 |
|---|---|
| 비밀번호 클레임 | `clients/web/src/features/auth/ClaimPage.tsx`, `claimPath.ts` |
| S1 / S2 크롬 | `…/onboarding/OwnerOnboarding.tsx`, `s1Copy.ts`, `WorkspaceProfileStage.tsx`, `s2Copy.ts`, `InviteStage.tsx` |
| 로그인 / 참여 | `clients/web/src/features/auth/ConnectPage.tsx` |
| 조인 파서 | `packages/momo-core/src/features/auth/deepLink.ts` |
| 설정 나브 | `clients/web/src/features/settings/settingsNav.ts`, `SettingsRoute.tsx`, `ProfileCard.tsx` |
| 워크스페이스 | `…/WorkspaceSection.tsx`, `clients/web/src/features/workspace/AddWorkspaceDialog.tsx` |
| 프로필 문 | `…/ProfileSection.tsx`, `…/profile/shared/HandleField.tsx` |
| 멤버와 초대 | `…/InviteSection.tsx`, `IssuedInviteCard.tsx`, `packages/momo-core/src/features/settings/model.ts` |
| first-run | `…/welcome/firstRunGate.ts`, `firstAgent.ts`, `FirstAgentStage.tsx`, `PhoneLinkFirstRun.tsx` |
| 웰컴 enqueue | `server-rust/bins/momo-server/src/routes/welcome.rs` |
| AI 연결 | `…/AiLinkSection.tsx` |
| 에이전트 허브 | `clients/web/src/features/agentHub/AgentHubRoute.tsx`, `CreateAgentDialog.tsx`, `AgentChannelsSection.tsx` |
| 채널 멤버 | `clients/web/src/features/channels/AddChannelMemberDialog.tsx` |
| 멘션 | `packages/momo-core/src/features/chat/composerCopy.ts`, `clients/web/src/features/chat/Composer.tsx` |
| env / CORS | `scripts/self_host_env.sh` |
| 오너 부트스트랩 SQL | `infra/rust/sql/bootstrap_owner_if_absent.sql` |
