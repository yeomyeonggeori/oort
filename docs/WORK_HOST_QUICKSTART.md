# 코드 실행 호스트 5분 연결 (WORK_HOST_QUICKSTART.md)

> **목적:** 배포판 운영자가 momo에 **코드 실행 호스트**(work host)를 붙이는 절차. 동봉 엔진
> opencode(기본)와 goose는 사이드카로 기동하고, Codex는 사용자 호스트의 것을 로컬로
> 연결한다.
> **근거:** [ADR-0114 증보1](adr/0114-interactive-work-console.md)(work host 동봉 + 엔진 선택),
> [ADR-0004](adr/0004-codex-oauth-hermes-provider-boundary.md)(자격증명 경계).
> **선행:** prod 스택이 이미 떠 있고 health가 green이어야 한다([README](../README.md)의 5분
> 설치, [`docs/DEPLOY.md`](DEPLOY.md)). 사용자 호스트 데몬(`momo-workd`)의 로컬 실행 세부는
> [`docs/RUN.md`](RUN.md) §5.4를 본다.
> 5분은 운영자 조작 시간 기준이다. 이미지 다운로드와 엔진의 모델 로그인 시간은 별도다.

---

## 0. 코드 실행 호스트란 무엇이고, provider("AI 연결")와 어떻게 다른가

두 설정은 서로 다른 대상을 가리킨다. 한 화면에서 구분해 표기한다.

| 구분 | provider ("AI 연결") | 코드 실행 호스트 (work host) |
|---|---|---|
| 붙이는 것 | LLM 백엔드(모델 추론 엔드포인트) | CLI 코드 에이전트를 실행하는 호스트 |
| 담당 | 채팅/에이전트 응답 생성 | 터미널/CLI 세션 스폰과 조종 |
| 예 | OpenAI 호환 게이트웨이, 로컬 Hermes | opencode, goose, 로컬 Codex |
| 근거 | ADR-0004 증보1 | ADR-0114 증보1 |

코드 실행 호스트는 세 엔진을 지원한다.

- **opencode** (MIT): 기본 엔진. 사이드카에 동봉된다. HTTP+SSE로 momo가 몬다.
- **goose** (Apache-2.0): 동봉 엔진. ACP로 세션마다 스폰한다.
- **codex-local**: Codex는 독점이라 **동봉하지 않는다.** 사용자 호스트의 `codex`를 로컬로
  연결한다(§4).

---

## 1. 동봉 엔진 사이드카 기동 (opencode 기본 / goose)

사이드카는 기본 스택에 없다. compose `--profile workhost`로만 켜진다.

### 1.1 필요한 값 준비

1. **워크스페이스 ID**: 붙일 워크스페이스의 UUID.
2. **1회용 등록 토큰**: owner 또는 admin의 access token. `POST /v1/auth/login`으로 발급받는다.
   이 토큰은 최초 등록 1회에만 쓰이고, 등록 성공 후 데몬이 폐기한다(로컬 Ed25519 키로
   이후 요청을 서명).

### 1.2 환경 파일에 값 추가

prod 환경 파일(예: `/run/momo-prod.env`)에 아래를 추가한다.

```sh
# 필수: 사이드카 이미지(다이제스트 핀 권장)와 대상 워크스페이스
MOMO_WORKHOST_IMAGE=ghcr.io/dawn-kim-official/momo-workhost:<tag>@sha256:<digest>
MOMO_WORKHOST_WORKSPACE_ID=<workspace-uuid>

# 필수(최초 1회): owner/admin access token. 등록 후 이 줄을 지운다.
MOMO_WORKHOST_REGISTRATION_TOKEN=<one-time-access-token>

# 선택: 부팅 기본 엔진(미설정 시 opencode). DB 설정이 있으면 그쪽이 우선(§3).
MOMO_WORKHOST_ENGINE=opencode

# 선택: 등록 범위(workspace 또는 member). 기본 workspace.
MOMO_WORKHOST_SCOPE=workspace

# 선택: opencode HTTP basic 비밀번호(opt-in). 비우면 컨테이너 loopback에서만 응답.
OPENCODE_SERVER_PASSWORD=

# 선택: 서버 URL(미설정 시 https://${API_DOMAIN}), 메모리 상한(기본 2g)
# MOMO_WORKHOST_SERVER_URL=https://momo.example.com
# MOMO_WORKHOST_MEM_LIMIT=2g
```

사이드카는 서버 API에 공개 HTTPS 도메인으로 접속한다. 데몬은 대상이 loopback이 아니면
https를 요구한다.

### 1.3 기동

```sh
docker compose \
  --env-file /run/momo-prod.env \
  -f infra/prod/docker-compose.prod.yml \
  --profile workhost up -d workhost
```

### 1.4 확인

```sh
docker compose \
  --env-file /run/momo-prod.env \
  -f infra/prod/docker-compose.prod.yml \
  logs --tail=50 workhost
```

opencode 엔진이면 로그에 `[workhost] starting opencode serve on 127.0.0.1:4096`와
`momo-workd host ready`가 나온다. goose 엔진이면 `engine=goose (ACP spawned per-session)`가
나온다. `host ready` 로그는 workspace_id, host_id, engine을 함께 남긴다.

등록이 끝나면 `MOMO_WORKHOST_REGISTRATION_TOKEN` 줄을 환경 파일에서 지운다. 등록 토큰은
1회용이다.

---

## 2. 사이드카를 끄기

```sh
docker compose \
  --env-file /run/momo-prod.env \
  -f infra/prod/docker-compose.prod.yml \
  --profile workhost down workhost
```

기본 스택은 `--profile workhost` 없이 기동하므로, 프로파일을 빼면 사이드카는 뜨지 않는다.

---

## 3. 앱에서 엔진 선택

엔진은 앱 설정의 "코드 실행 호스트" 화면에서 워크스페이스 단위로 고른다(opencode / goose /
codex-local). 이 선택은 워크스페이스별 `work_host_engine` 행에 저장된다(마이그레이션
`server/Migrations/040_work_host_engine.sql`). 행은 엔진 라벨만 담고 provider 키나 OAuth
토큰, 호스트 경로는 담지 않는다.

**우선순위**(`WorkdConfig.resolveEngine`):

1. DB 설정(`work_host_engine`): 앱에서 고른 값. 있으면 이게 이긴다.
2. `MOMO_WORKD_ENGINE` 환경값: 사이드카 부팅 기본(§1.2의 `MOMO_WORKHOST_ENGINE`).
3. 컴파일 기본값: opencode.

DB에 행이 없으면 별도 쓰기 없이 opencode로 동작한다.

---

## 4. Codex 로컬 연결 (동봉 불가, 사용자 호스트의 codex 사용)

Codex는 독점 CLI라 배포판에 담지 않는다. `codex-local` 엔진은 **`codex`가 설치된 사용자
호스트에서 실행하는 `momo-workd`**가 그 호스트의 `codex`를 그대로 쓴다. Codex의
ChatGPT/OAuth 자격증명은 사용자 호스트의 `~/.codex`와 keychain에 남고 momo로 들어오지
않는다(ADR-0004).

절차 요약(상세는 [`docs/RUN.md`](RUN.md) §5.4):

1. `codex`가 로그인돼 있고 `~/.codex` 자격증명이 있는 호스트를 고른다(예: 본인 Mac).
   컨테이너 사이드카에는 `codex`가 없으므로, Codex는 그 호스트에서 도는 `momo-workd`로
   붙인다.
2. 그 호스트에서 `momo-workd`를 기동한다.

   ```sh
   swift build --package-path workers/WorkHostDaemon

   mkdir -p "$HOME/.momo" && chmod 700 "$HOME/.momo"
   printf '%s\n' "$ONE_TIME_ACCESS_TOKEN" >"$HOME/.momo/workd-registration.token"
   chmod 600 "$HOME/.momo/workd-registration.token"

   MOMO_WORKD_SERVER_URL=https://momo.example.com \
   MOMO_WORKD_WORKSPACE_ID=<workspace-uuid> \
   MOMO_WORKD_ENGINE=codex-local \
   MOMO_WORKD_REGISTRATION_TOKEN_FILE="$HOME/.momo/workd-registration.token" \
   swift run --package-path workers/WorkHostDaemon momo-workd
   ```

3. 앱 "코드 실행 호스트" 설정에서 엔진을 `codex-local`로 둔다(§3). 등록이 끝나면 로컬
   토큰 파일은 데몬이 삭제한다.

macOS 앱은 자기 Mac을 work 호스트로 등록하는 경로("이 Mac의 호스트 ID")를 내장한다. 이
경우 별도 데몬 실행 없이 앱이 로컬 세션 매니저 역할을 한다.

---

## 5. 자격증명 경계 (ADR-0004)

- 동봉 엔진(opencode/goose)이 호출하는 LLM 자격증명은 **엔진 설정(사용자) 소유**다. momo
  서버/DB/원장에 들어오지 않는다.
- 로컬 Codex의 ChatGPT/OAuth 토큰은 사용자 호스트의 `~/.codex`와 keychain에만 있다. momo는
  이를 읽거나 중계하지 않는다.
- 사이드카는 자격증명 **소비자**일 뿐, 저장소가 아니다. momo 서버 컨테이너와 신뢰 경계가
  분리돼 있다.
- `momo-workd`는 raw stdout/stderr, 명령 경로, 환경값, provider 자격증명을 서버로 보내지
  않는다. 로컬 출력은 기본 `~/.momo/workd-output/` 아래 mode `0600` 파일로만 보관한다.
- 마이그레이션 040의 `work_host_engine`은 엔진 라벨만 저장한다. 키/토큰/경로는 저장하지
  않는다.

동봉 엔진 라이선스(opencode MIT, goose Apache-2.0)는 이미지 안
`/usr/share/licenses/`에 포함된다.

---

## 6. 문제 해결

| 증상 | 원인과 조치 |
|---|---|
| `workhost`가 뜨지 않음 | `--profile workhost`를 붙였는지 확인. 기본 스택에는 없다. |
| 로그에 `registration required` | 최초 등록에 `MOMO_WORKHOST_REGISTRATION_TOKEN`이 필요하다. owner/admin access token을 넣는다. |
| 재기동 후 다시 등록을 요구 | host ID는 컨테이너의 `~/.momo/workd.host-id`에 저장된다. 이 경로를 볼륨으로 유지하지 않고 컨테이너를 재생성하면 새 1회용 토큰이 필요하다. |
| `MOMO_WORKD_SERVER_URL` 거부 | loopback이 아니면 https만 허용한다. 공개 HTTPS 도메인을 쓴다. |
| opencode `serve` 미기동 | 사이드카 이미지에 opencode 바이너리가 있는지, `MOMO_WORKD_ENGINE`이 opencode인지 확인. |
| Codex가 안 붙음 | Codex는 동봉되지 않는다. `codex`가 설치·로그인된 호스트에서 `momo-workd`를 `codex-local`로 실행한다(§4). |

검증 스크립트는 [`docs/RUN.md`](RUN.md) §5.4의 `scripts/verify_workd.sh`,
`scripts/verify_acp_host.sh`를 본다.
