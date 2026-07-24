# ACP 에이전트 호스팅 5분 런북 (AGENT_HOSTING_QUICKSTART.md)

> **목적:** 운영자(성재)가 혼자 처음부터 끝까지 걷는 경로. 내부 알파 서버에 이 Mac을
> 코드 실행 호스트로 붙이고(momo-workd), 앱에서 페어링과 엔진을 확인하고, 주소로
> 에이전트를 등록한 뒤 멘션 왕복까지 확인한다.
> **대상 서버:** 내부 알파(`momowebqa`, 기본 `http://127.0.0.1:28000`).
> **근거:** [ADR-0125 D2](adr/0125-work-console-and-hosts.md)(momo-workd 아웃바운드 데몬),
> [ADR-0114 증보1](adr/0114-interactive-work-console.md)(work host 엔진 선택),
> [ADR-0004](adr/0004-codex-oauth-hermes-provider-boundary.md)(자격증명 경계).
> **이 런북과 [`docs/WORK_HOST_QUICKSTART.md`](WORK_HOST_QUICKSTART.md)의 차이:** 저 문서는
> 배포판 운영자가 컨테이너 사이드카로 엔진을 동봉해 붙이는 절차이고, 이 문서는 내부 알파에서
> 이 Mac을 로컬 데몬으로 붙여 운영자가 혼자 완주하는 절차다.
> **5분은 운영자 조작 시간 기준이다.** Swift 콜드 빌드와 엔진 모델 로그인 시간은 별도다.
> 데몬 실행 세부는 [`docs/RUN.md`](RUN.md) §5.4를 함께 본다.

---

## 0. 전체 그림

| 단계 | 무엇을 | 도구 |
|---|---|---|
| 1 | 이 Mac을 코드 실행 호스트로 등록 | `scripts/agent_host_local.sh` (momo-workd) |
| 2 | 앱에서 페어링·엔진 확인 | 앱 "코드 실행 호스트"(WH-2) |
| 3 | 주소로 에이전트 등록 | 앱 "에이전트 추가"(주소 온보딩) |
| 4 | 멘션 왕복 확인 | 앱 채널에서 `@에이전트` |

---

## 사전 조건

1. **내부 알파가 떠 있어야 한다.** 상태와 재배포:

   ```sh
   scripts/internal_alpha_stack.sh status     # 컨테이너/포트/마이그레이션 수준
   scripts/internal_alpha_stack.sh redeploy   # 데이터 보존 재배포(health까지 대기)
   ```

   health가 200이어야 한다: `curl -fsS http://127.0.0.1:28000/health`.
2. **툴체인:** Swift 6.2.x, Docker Desktop.
3. **운영자 계정과 워크스페이스 ID.** 기본 데모 워크스페이스는
   `00000000-0000-7000-8000-000000000001`이다.

> **주의(자격 증명):** 배포된 내부 알파는 시드 계정이 운영자 인수로 개인화될 수 있다.
> `demo@momo.local` / `dev-password`를 가정하지 말고, **본인이 설정한 계정으로 로그인**한다.
> 신규 설치 직후의 e2e 시드에서만 `demo@momo.local` / `dev-password`가 유효하다(마이그레이션
> 005·012). 이미 로그인한 적이 있으면 그 계정을 쓴다.

---

## 1. momo-workd 기동 (원커맨드)

내부 알파를 대상으로 이 Mac을 코드 실행 호스트로 등록한다. 운영자 계정으로 로그인해
1회용 등록 토큰을 얻고 데몬을 띄우는 것까지 한 번에 한다.

```sh
AGENT_HOST_LOGIN_EMAIL=you@example.com \
AGENT_HOST_LOGIN_PASSWORD='본인-비밀번호' \
  scripts/agent_host_local.sh
```

스크립트가 하는 일(순서대로):

1. **preflight:** `curl`·`swift`·`python3` 존재, 대상 URL 검증, 워크스페이스 UUID 형식,
   내부 알파 `/health` 200, momo-workd 빌드(최초 1회).
2. **loopback http opt-in:** 대상이 `127.0.0.1`/`localhost`/`::1`일 때만
   `MOMO_WORKD_ALLOW_INSECURE_HTTP=1`을 켠다(데몬은 loopback이 아닌 http를 거부한다).
3. **등록 토큰 발급:** `POST /v1/auth/login`으로 access token을 받아 `~/.momo`에 mode 0600
   파일로 저장한다. 등록이 성공하면 데몬이 이 파일을 삭제한다.
4. **데몬 기동:** `momo-workd`를 실행한다.

**확인:** 로그에 아래가 나오면 등록 성공이다.

```
info momo-workd: engine=opencode host_id=<uuid> workspace_id=00000000-0000-7000-8000-000000000001 [WorkHostDaemon] momo-workd host ready
```

`host ready`는 workspace_id, host_id, engine을 함께 남긴다. 부팅 기본 엔진은 opencode이고,
앱에서 고른 DB 설정이 있으면 dispatch 시 그쪽이 우선한다(§2).

### 1.1 변형

```sh
# 환경 점검만(데몬을 띄우지 않음)
scripts/agent_host_local.sh --preflight

# 등록만 하고 종료(CI/스모크용). momo-workd --bootstrap-only에 위임한다
AGENT_HOST_LOGIN_EMAIL=... AGENT_HOST_LOGIN_PASSWORD=... \
  scripts/agent_host_local.sh --bootstrap-only

# 등록 후 재기동(로컬 host-id가 있으면 토큰 불필요)
scripts/agent_host_local.sh

# 부팅 엔진 라벨 지정(선택)
MOMO_WORKD_ENGINE=codex-local AGENT_HOST_LOGIN_EMAIL=... AGENT_HOST_LOGIN_PASSWORD=... \
  scripts/agent_host_local.sh
```

토큰을 이미 갖고 있으면 로그인 대신 넘긴다.

```sh
MOMO_WORKD_REGISTRATION_TOKEN_FILE=/path/to/token scripts/agent_host_local.sh   # 0600 권장
# 또는 MOMO_WORKD_REGISTRATION_TOKEN='<access-token>' (프로세스 노출 주의)
```

### 1.2 등록을 REST로 확인(선택)

owner/admin access token으로 호스트 목록을 조회한다.

```sh
curl -fsS -H "Authorization: Bearer $ACCESS_TOKEN" \
  http://127.0.0.1:28000/v1/workspaces/00000000-0000-7000-8000-000000000001/work-hosts
```

방금 등록한 데몬이 `type=workd`, `owner_member_id=<본인>`로 보이면 된다.

---

## 2. 앱에서 페어링·엔진 확인 (WH-2)

앱을 내부 알파에 붙여 실행한다. `MACOS_DEV_RUN_DIRECT_EXEC=1`이 있어야 `MOMO_*` 환경값이
앱 프로세스까지 전달된다.

```sh
MACOS_DEV_RUN_DIRECT_EXEC=1 \
MOMO_SERVER_BASE_URL=http://127.0.0.1:28000 \
MOMO_CENTRIFUGO_WS_URL=ws://127.0.0.1:28001/connection/websocket \
  scripts/macos_dev_run.sh
```

1. 운영자 계정(owner/admin)으로 로그인한다.
2. 프로필 메뉴에서 **"코드 실행 호스트"**를 연다. 이 항목은 owner/admin에게만 보인다
   (`canManageWorkspace` 게이팅).
3. **페어링 섹션:** 이 Mac의 등록 상태를 칩으로 보여준다(연결됨/오프라인/페어링 중/세션
   대기/연결 안 됨). 연결되면 호스트 이름과 마지막 확인 시각이 함께 뜬다.

   > **중요:** 이 페어링 칩은 **앱이 등록하는 "이 Mac" 호스트**의 상태다. 이것은 §1에서 띄운
   > **momo-workd 데몬과는 별개의 work_host**다(앱은 운영자 세션이 준비되면 이 Mac을 자동
   > 등록한다). 즉 페어링 칩만으로는 §1의 데몬 등록을 확인하지 못한다. 데몬 등록은
   > `host ready` 로그와 §1.2의 호스트 목록으로 확인한다. 두 호스트가 목록에 함께 보이는 것이
   > 정상이다(앱의 "이 Mac" 1개 + 데몬 1개).

4. **실행 엔진 섹션:** opencode / goose / codex-local 중 고르고 **"엔진 저장"**을 누른다.
   저장은 `PUT /v1/provider/work-host-engine`로 가고 워크스페이스별
   `work_host_engine` 행에 라벨만 저장된다(마이그레이션 040). 키·토큰·경로는 저장하지 않는다.

   **엔진 우선순위**(`WorkdConfig.resolveEngine`): DB 설정(앱에서 고른 값) > `MOMO_WORKD_ENGINE`
   환경값 > 컴파일 기본값(opencode). codex-local을 고르면 이 Mac이 코드 실행 호스트로 연결돼
   있어야 실제로 실행된다(안내 문구가 뜬다).

---

## 3. 주소로 에이전트 온보딩 (GUI)

1. 채널의 멤버 영역에서 **"에이전트 추가"**를 연다. owner/admin이고 서버가 주소 온보딩을
   지원할 때만 노출된다(`canManageWorkspace && supportsAgentAddressOnboarding`).
2. **에이전트 주소**를 입력하고 **"에이전트 정보 확인"**을 누른다. 서버가
   `POST /v1/workspaces/:ws/agents/from-card`로 에이전트 카드를 읽어 이름, 설명, 할 수 있는 일,
   인증 방식을 먼저 보여준다. **이 화면은 비밀 정보나 인증 값을 입력받지 않는다**(확인용 요약).
3. 검토 후 **"워크스페이스에 추가"**를 누르면
   `POST /v1/workspaces/:ws/agents/from-card/:registration/confirm`으로 에이전트가
   `member`(kind=agent)로 등록된다.

주소는 에이전트 origin URL 또는 `/.well-known/agent-card.json` URL이다.

---

## 4. 멘션 왕복

1. 에이전트가 그 채널의 멤버여야 멘션할 수 있다. 내부 알파 시드 에이전트 **@김인턴**(handle
   `kim-intern`)과 **@hermes**는 `#general`, `#agent-lab`의 멤버다.
2. 채널에서 `@에이전트`를 붙여 메시지를 보낸다(`POST /v1/workspaces/:ws/channels/:ch/messages`).
   멘션은 `agent_run`을 만들고, AgentWorker가 provider를 호출한 뒤 응답을 `message.new`로 채널에
   되돌린다.

> **갭 주의(내부 알파에 AgentWorker 미기동):** `scripts/internal_alpha_stack.sh redeploy`는
> 현재 `api`·`relay`만 기동하고 **AgentWorker를 띄우지 않는다**. 이 상태에서는 멘션이
> `agent_run`으로 적재되지만 응답이 오지 않는다. 멘션 왕복을 보려면 워커를 먼저 띄운다.

```sh
# 내부 알파 포트를 주입해(다른 서비스 포트 매핑 되돌림 방지) 워커만 올린다. 최초 기동은
# Swift 콜드 컴파일로 수 분 걸린다.
PORT=28000 CENT_PORT=28001 POSTGRES_PORT=28002 HERMES_PORT=28003 \
  docker compose -p momowebqa -f infra/docker-compose.e2e.yml up -d --no-deps worker
```

3. 워커가 뜬 뒤 `#agent-lab`에서 `@김인턴 안녕`처럼 보내면 응답이 돌아온다. 내부 알파 provider는
   mock Hermes라 응답 텍스트는 결정론적 mock이다(실제 모델 추론이 아니다).

**심화(ACP 작업 위임):** 이 런북의 멘션 왕복은 provider 응답 경로를 확인한다. 페어링한
호스트와 엔진으로 에이전트가 실제 CLI 세션을 몰아 결과를 되돌리는 ACP 작업 위임
(work_control spawn -> work_session)은 `scripts/verify_workd.sh`와
`scripts/verify_acp_host.sh`가 격리 스택에서 검증한다(외부 엔진 자격증명 로그인 전까지는
`runtime-unverified(external ACP agent credentials)`).

from-card로 온보딩한 외부 에이전트의 멘션 왕복은 그 에이전트 endpoint 도달성과 자격에
달렸다(`runtime-unverified(external agent)`).

---

## 5. 자격증명 경계 (ADR-0004)

- momo-workd는 raw stdout/stderr, 명령 경로, 환경값, provider 자격증명을 서버로 보내지 않는다.
  로컬 출력은 기본 `~/.momo/workd-output/` 아래 mode 0600 파일로만 보관한다.
- codex-local의 ChatGPT/OAuth 토큰은 사용자 호스트의 `~/.codex`와 keychain에만 있고 momo로
  들어오지 않는다.
- `work_host_engine`은 엔진 라벨만 저장한다. 키/토큰/경로는 저장하지 않는다.
- 등록 토큰은 1회용이다. 등록 성공 후 로컬 토큰 파일은 데몬이 삭제한다.

---

## 6. 문제 해결

| 증상 | 원인과 조치 |
|---|---|
| `/health` 도달 불가 | `scripts/internal_alpha_stack.sh redeploy`로 내부 알파를 올린다. |
| 로그인 실패(401) | 시드 계정을 가정하지 말고 본인 계정을 쓴다. 워크스페이스 ID를 확인한다. |
| `registration required` | 최초 등록에 토큰이 필요하다. 로그인 자격 또는 토큰/토큰파일을 준다. |
| `MOMO_WORKD_SERVER_URL` 거부 | loopback만 http가 허용된다. 원격은 https를 쓴다(다른 절차). |
| 페어링 칩이 "연결 안 됨" | 이 칩은 앱의 "이 Mac" 등록 상태다. §1의 데몬은 별개이니 `host ready` 로그와 §1.2 목록으로 확인한다. |
| "코드 실행 호스트" 항목이 안 보임 | owner/admin(`canManageWorkspace`)만 노출된다. 운영자 계정으로 로그인한다. |
| 엔진 저장 403 | 코드 실행 호스트 관리 권한이 없다. owner/admin으로 로그인한다. |
| 멘션에 응답 없음 | 내부 알파에 AgentWorker가 없다(§4 갭). 워커를 먼저 띄운다. |

---

## 7. 관련 문서·검증

- [`docs/WORK_HOST_QUICKSTART.md`](WORK_HOST_QUICKSTART.md): 배포판 운영자용(사이드카 동봉 엔진).
- [`docs/RUN.md`](RUN.md) §5.4: momo-workd 실행 세부, 환경변수, SSH 사용자 서비스 초안.
- `scripts/verify_workd.sh`: 등록·서명·spawn·세션 수명주기·RLS 격리 검증(격리 스택).
- `scripts/verify_acp_host.sh`: ACP `initialize` -> `session/new` -> `session/prompt` 왕복과
  로컬 JSONL·서버 원장 소비 검증(격리 스택).
