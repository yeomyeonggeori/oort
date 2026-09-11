# 제로베이스 온보딩 E2E-B′ 실측 — 발행 이미지 v0.1.5(803ae7d5) + `--claim` 경로 (2026-09-11, grok 워커 측정 · planner 검수)

> 원본: `~/projects/e2e-zb2/REPORT.md`(스크린샷 20장·LOG.md는 로컬). 선행 런: `2026-09-10-e2e-zero-base-run.md`(main db5cb8e9, 11/11, 이탈 D1~D4). 이 런의 D1~D4는 #2436·#2452로 소멸. planner 검수: `/healthz` ok(schema 86) · 웹 스탬프 803ae7d5 · 7 서비스 healthy. 토큰·비밀은 기록하지 않음(리다크션 검사 통과).

# 제로베이스 온보딩 E2E 재실측 — 케이스 B′ (2026-09-11, 발행 이미지 v0.1.5 candidate `803ae7d5`, grok 워커 실측)

> 계획 `claudedocs/e2e-zero-base-plan/PLAN.md` §B. ADR-0185 §5 측정 항목(워커 지시 ①–⑫) **PASS 12/12**. 실측 원문(LOG·스크린샷 20장)은 `~/projects/e2e-zb2/`(세션 로컬). 이전 런 D1–D4(#2436·#2452) **소멸 확인**. 스택 유지, `down` 하지 않음.


- 일자: 2026-09-11
- 클론: `~/projects/e2e-zb2/oort`
- commit: `803ae7d52ddb6e9c99037b90b052e955b0f0a7ea` (`Merge pull request #2457`)
- publish run: [34566962884](https://github.com/yeomyeonggeori/oort/actions/runs/34566962884) success (`workflow_dispatch` publish-images)
- compose project: **`e2e-zb2`** (스택 유지)
- 모드: published-digest + `--claim` + `--allow-local-provider` (문서 1급)
- doctor: **blocker 0**. `env.required_keys` pass · `roles.momo_notifier` pass. JSON `verdict=FAIL` exit 1은 `env.digest` major 1건만(후보 핀 ≠ committed `releases/latest.json` v0.1.4) — §2 D5 · §6
- 브라우저: Playwright Chromium headless, viewport 1280×800, `prefers-color-scheme: light`
- 스크린샷: `~/projects/e2e-zb2/shots/`

## 결과 요약

ADR-0185 §5 측정 항목(플랜 B / 워커 지시 ①–⑫) **PASS 12/12**.

| # | 항목 | 판정 | 증거 |
|---|---|---|---|
| ① | 사이드바·설정·프로필에 `momo Demo Workspace` / 「데모 사용자」 / `@demo` 노출 0 | **PASS** | 온보딩 완료 후 DOM grep `hits=[]`. 셸 「곽성재」·레일 이니셜 「새」(새벽 팀). 설정 슬러그 `demo`는 ADR-0185 §6 잔여(문자열 `@demo` 아님). shot `10-shell` `15-settings-workspace` `20-after-restart` |
| ② | 필수 화면 ≤ 1, 전체 스텝 = 2 (`1/2` `2/2`) | **PASS** | S1 카운터 `1/2` 제목 「내 워크스페이스·내 이름」, S2 `2/2` 「팀원 초대」. S1 skip(지금은 건너뛰기) 행복 경로 0. shot `02-s1` `05-s2` |
| ③ | skip 탈출구 1 상시, 발급 1 POST, 발급 뒤 skip 소멸 | **PASS** | 발급 전 skip 1(「나중에」) + 재진입 「설정 › 멤버와 초대에서…」. POST `/invites` 발급 전 0, 발급 클릭 후 1. 발급 뒤 skip 0 · 「계속」 1 (FIRST_DAY). shot `05-s2` `07-s2-issued` |
| ④ | 팀 규모 질문 0 | **PASS** | S1·S2 본문 grep (`팀 규모`/`몇 명`/`team size` 등) 0 |
| ⑤ | claim 직후 셸 착륙 없음 | **PASS** | claim 제출 직후 selector=`onboarding-s1`, sidebar/first-agent/phone 0. shot `02-s1` |
| ⑥ | 에이전트 0명 → ≤2s 「첫 에이전트 연결」 (120s 백스톱 0) | **PASS** | S2 「계속」→ first-agent **89 ms**. `kickoffSeen=false`, backstop 0. 제목 「첫 에이전트 연결」. shot `08-first-agent` |
| ⑦ | 첫 에이전트 활성 뒤 오프너 정확히 1 (`#general`) | **PASS** | mock hermes + GUI+`PUT /v1/provider/link` 200 → `POST …/agents` 201 `kim-intern` → `#general` membership 200. 메시지 seq2 에이전트 본문 1건 (`김인턴 mock reply…`). 사람 `@kwak` seq1 제외. ui timeline-message=2. shot `14-general-opener` |
| ⑧ | 설정 › 워크스페이스 stale `updatedAtMs` → 409 배너, 두 이름 | **PASS** | REST 동시 PATCH로 서버 이름을 「동시성 이름」. UI 초안 「새벽 팀 실측」 저장 → 배너 「워크스페이스 이름이 「동시성 이름」으로 바뀌었습니다.」 + 초안 유지. shot `16-settings-workspace-409` |
| ⑨ | 설정 › 프로필 점유 핸들 409, 성공 변경 뒤 `@kwak` 과거 본문 불변 | **PASS** | `kim-intern` 저장 → 「이미 쓰는 핸들이에요. 다른 핸들을 골라주세요.」. 이후 `kwakseongjae` 성공. `#general` seq1 본문 `@kwak 핸들 고정 실측` API·UI 모두 유지. shot `18-settings-profile-409` `20-after-restart` |
| ⑩ | `up -d` 재기동 뒤 이름 유지, 재온보딩 0, migrate `MOMO_BOOTSTRAP_CLAIM=skipped` | **PASS** | 문서 런처 `scripts/self_host_env.sh --compose up -d` 후 `/healthz` 200. Playwright reload = sidebar (S1/S2/claim 0). REST 재측정: `name=새벽 팀` `displayName=곽성재` `handle=kwakseongjae`. migrate `MOMO_BOOTSTRAP_CLAIM=skipped`. shot `20-after-restart` |
| ⑪ | S1 중·S2 중 reload → 같은 스테이지 재진입 | **PASS** | S1 reload → `onboarding-s1` `1/2`. S2 reload → `onboarding-s2`. shot `03-s1-reload` `06-s2-reload` |
| ⑫ | `oort doctor` PASS after the run (claim env accepted) | **PASS** | 런 후 `env.required_keys` **pass** 「생성기 키 전수 존재 (claim 키가 비밀번호 키 자리)」. `roles.momo_notifier` **pass** 「momo_notifier LOGIN NOSUPERUSER BYPASSRLS」. blocker 0. JSON `verdict=FAIL` / exit 1은 `env.digest` major 1건만 — D5. `artifacts/doctor-after-rows.json` |

---

## 1. Setup

### Digests (row 0)

Publish run 34566962884 env (compose multi-arch job):

| subject | identity | digest |
|---|---|---|
| application | **manifest list (pin)** | `sha256:5481c14eccab99d3cbce51fd8b8710fe6fd671e673652cb3e30422b0e66f7a85` |
| PostgreSQL 18 + pgBackRest | **manifest list (pin)** | `sha256:c6a5bb847c6128d06629a62c85b3d25ab96689e1c71110705601cf52b3071015` |

Cross-check (`colima ssh -- docker buildx imagetools inspect`, 호스트 CLI에 buildx 플러그인 없음):

- `ghcr.io/yeomyeonggeori/oort:sha-803ae7d52ddb6e9c99037b90b052e955b0f0a7ea` → list Digest **일치**
- `ghcr.io/yeomyeonggeori/oort-postgres:sha-803ae7d52ddb6e9c99037b90b052e955b0f0a7ea` → list Digest **일치**

Checkout `releases/latest.json` 은 아직 **v0.1.4** (`images.app.digest_list=sha256:7426d282…`). 후보 핀은 런/imagetools. SELF_HOST §2: postgres list digest는 Release 표·ops/PITR용이며 compose postgres 서비스는 소비하지 않음 — 실측 postgres 이미지 `pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7…`.

### Ports · project

| 키 | 값 | 이유 |
|---|---|---|
| `COMPOSE_PROJECT_NAME` | `e2e-zb2` | 지시. 기존 `oortv013`과 분리 |
| `MOMO_WEB_PORT` | **8089** | 8088 점유(oortv013) → 생성기 자동 회피 |
| `MOMO_RUST_API_PORT` | 8081 | 8080 점유 |
| `CENT_HOST_PORT` | 8001 | 8000 점유 |
| mock hermes | 18765 | `0.0.0.0` bind, `host.docker.internal` |
| `DB_VOLUME_NAME` | `e2e-zb2-pgdata` | 프로젝트명 파생. `oort-pgdata` 미공유 |
| `DRIVE_VOLUME_NAME` | `e2e-zb2-drive` | 동일 |
| 이미지 | `ghcr.io/yeomyeonggeori/oort@sha256:5481c14e…` | `--published-image` list digest |
| `MOMO_SELF_HOST_MODE` | `published-digest` | |
| `MOMO_BUILD_SHA` | `803ae7d52ddb6e9c99037b90b052e955b0f0a7ea` | web stamp 일치 |
| `MOMO_AGENT_SEED_MODE` | `none` | |

다른 compose 프로젝트(`oortv013`, `factsheet-ontology-kb`, `momo_docs-1797-ext1-agent-credential`)는 내리지 않음. 전야 스택 `e2e-zb`는 지시대로 `docker compose -p e2e-zb down -v` 후 시작.

### Env key count

생성기 `COMPOSE_PROJECT_NAME=e2e-zb2 scripts/self_host_env.sh --published-image "$IMAGE_REF" --claim --allow-local-provider`:

- 파일 모드 **600**
- 키 **45** = claim 베이스 **43** + local-provider 2 (`AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK`, `AGENT_PROVIDER_LOCAL_HOSTS`)
- `MOMO_INITIAL_OWNER_PASSWORD` **없음**
- `MOMO_BOOTSTRAP_CLAIM` **있음**

생성기 stdout claim 힌트(토큰 없음):

```
[self-host] 이 env는 claim 모드다. 비밀번호 키는 이 파일에 없다 (ADR-0166).
[self-host] 기동 뒤 claim 경로는 migrate 로그에서 수거한다 (토큰 원문은 로그에만, ADR-0004):
[self-host]   scripts/self_host_env.sh --compose logs migrate | grep MOMO_CLAIM_PATH
```

기동 한 줄(문서 그대로):

```
scripts/self_host_env.sh --compose up -d --pull missing --wait
```

`--wait` 종료 후 런처 한 줄:

```
[self-host] claim 경로는 migrate 로그에 있다: scripts/self_host_env.sh --compose logs migrate | grep MOMO_CLAIM_PATH
```

### `/healthz` · stamp · doctor (기동 직후)

```json
{"status":"ok","service":"momo-server","database":"ok","schema":{"applied":86,"head":"086_device_link_token.sql"}}
```

```
<meta name="momo-build" content="803ae7d52ddb6e9c99037b90b052e955b0f0a7ea">
```

`scripts/oort doctor --json`: pass 30 / fail 1 / skip 2 / exit 1 (major-only).

붙여넣기 (워커 지시):

```
env.required_keys     blocker  pass  생성기 키 전수 존재 (claim 키가 비밀번호 키 자리)
roles.momo_notifier   blocker  pass  momo_notifier LOGIN NOSUPERUSER BYPASSRLS
```

skip 2: `public.healthz` / `public.websocket` (`--public-origin` 없음). fail 1: `env.digest` (D5).

---

## 2. D-table

| # | 종류 | 문서가 말하는 것 | 실제 | 우회 | 이전 런 |
|---|---|---|---|---|---|
| D1 | — | FIRST_DAY §1: `--claim` 이 1급. 생성기는 `MOMO_BOOTSTRAP_CLAIM=1` 을 쓰고 `MOMO_INITIAL_OWNER_PASSWORD` 를 쓰지 않는다 | 그대로. 키 45(43+2), 비밀번호 키 0, 생성기 claim 힌트 줄 출력 | 불필요 | **GONE** (#2436/#2452) |
| D2 | — | FIRST_DAY §1 / SELF_HOST §3: claim env 도 `--compose up -d --pull missing --wait` | `--compose` 가 claim env를 기동함. 거절 0 | 불필요 | **GONE** |
| D3 | — | FIRST_DAY §0·§7 / SELF_HOST §5: 에이전트 만들기 GUI는 비-루프백 `http` 를 `plaintextRemote` 로 거절. 로컬 mock 은 **설정 › AI 연결** / `PUT /v1/provider/link` + REST `POST …/agents` | 문서와 동일. GUI AI 연결 200, REST agent 201 | 문서 REST 경로 그대로 | **GONE** (문서가 실제를 적음) |
| D4 | — | FIRST_DAY: 발급 후 skip 「나중에」 소멸, 1차 버튼 「계속」 | 발급 후 skip=0 continue=1. 워커 지시도 「계속」 | 불필요 | **GONE** (플랜 문구가 FIRST_DAY와 일치) |
| D5 | 후보 핀 vs committed manifest | doctor `env.digest`: published-digest env 는 `releases/latest.json` `images.app.digest_list` 와 같아야 한다 | checkout latest.json = v0.1.4. 본 런은 v0.1.5 후보 list digest. doctor major fail, blocker 0, exit 1 | 없음 — 후보 측정이 latest.json 갱신 전에 이뤄짐. claim env 수용과는 무관 | **신규** (B′ 전용) |

사전 D2(#2258 웹 스탬프)는 이 SHA에서 유지: stamp `content="803ae7d5…"` 40자.

---

## 3. Stage timeline

| 구간 | 시각(UTC) | 소요 |
|---|---|---|
| `e2e-zb down -v` | 06:24:31 | ~1 s |
| clone `803ae7d5` | 06:24:51 → 06:25:00 | ~9 s |
| digest 대조 (run log + imagetools) | 06:24:51 → 06:26:06 | — |
| env 생성 `--published-image --claim --allow-local-provider` | 06:26:56 | ~1 s |
| mock hermes :18765 | 06:28:08 | — |
| `--compose up -d --pull missing --wait` | 06:28:08 → 06:28:35 | **27 s** |
| doctor + healthz + stamp | 06:29:03 | ~3 s |
| Playwright 온보딩+§5 | 06:33:17 → 06:33:37 | **20 s** |
| S2 계속 → 첫 에이전트 | — | **89 ms** (한도 2000 ms) |
| 에이전트 생성 → 오프너 seq2 | — | ~2.5 s |
| REST ⑩ 재측정 | 06:34:33 | — |

퍼널 (shot):

1. `01-claim` 비밀번호 설정
2. `02-s1` 1/2 「내 워크스페이스·내 이름」
3. `03-s1-reload` 같은 스테이지
4. `04-s1-filled` 새벽 팀 / 곽성재 / kwak
5. `05-s2` 2/2 skip 「나중에」
6. `06-s2-reload` 같은 스테이지
7. `07-s2-issued` 발급 카드 + 「계속」(skip 소멸)
8. `08-first-agent` 「첫 에이전트 연결」
9. `09-phone-link` 「앱으로 들어가기」
10. `10-shell` 곽성재 / 레일 「새」
11. `11-general-kwak` … `20-after-restart`

---

## 4. Assertion table ①–⑫

§결과 요약 표와 동일. 원문 단정: `artifacts/assert.json`. 스크린샷 20장. LOG 행 21–67.

⑩ 첫 패스 하네스는 `GET /v1/workspaces/{ws}/members/me` 가 405라 `display`/`handle` 를 undefined 로 적고 FAIL 처리했다. 제품 상태는 셸(shot 20)·login `member`·workspace GET 으로 재측정 **PASS**. 이전 런(2026-09-10)과 같은 재측정 패턴.

⑫ 는 ADR-0185 claim env 수용(`env.required_keys` + `roles.momo_notifier`)을 PASS 로 둔다. doctor JSON 전체 `verdict=FAIL` 은 D5.

---

## 5. Verdict

**PASS 12/12**

D1–D4 소멸. 문서 `--claim` + `--published-image` + `--compose` 경로만으로 설치·기동·온보딩이 닫힌다.

---

## 6. Residuals

- **D5 `env.digest`**: v0.1.5 후보 핀이 committed `releases/latest.json`(v0.1.4)과 다르다. doctor major fail / exit 1. latest.json 을 이 digest 로 갱신하면 해소. claim 키 집합·notifier 롤과 무관.
- **ADR-0185 §6 잔여**: slug `demo`, 고정 workspace UUID, `#agent-lab` 시드 채널. `#agent-lab` 채널 설명에 「김인턴 데모」 문구가 남음(단정 바늘 `momo Demo Workspace` / 「데모 사용자」 / `@demo` 에는 안 걸림).
- **오프너 첫 페인트**: shot `14-general-opener` 에서 에이전트 표시명이 ULID 접두(`01a08f2b`)로 잠깐 보이다, 재기동 뒤 shot 20 은 `@kim-intern`. 원장 행은 1.
- **키 45 vs 워커 기대 43**: `--allow-local-provider` 2키가 추가된 문서 동작.
- 호스트 `docker buildx` 플러그인 없음 — Colima VM 안에서 imagetools. 리스트 digest 대조는 성립.

## doctor skip (2, 해당 없음)

- `public.healthz` / `public.websocket` — `--public-origin` 없음

## 스크린샷 목록

`01-claim` … `20-after-restart` (20장, 1280 light). 로그: `LOG.md`. 단정 JSON: `artifacts/assert.json`.

## 스택 (유지)

- project: `e2e-zb2` running(7)
- base: `http://localhost:8089`
- claim (이미 소비됨): `http://localhost:8089/claim/<redacted>`
- 로그인(claim 이후): `owner@oort.local` / claim에서 설정한 비밀번호
- mock hermes: pid on `:18765`

플래너 검수용으로 `down`하지 않았다.
