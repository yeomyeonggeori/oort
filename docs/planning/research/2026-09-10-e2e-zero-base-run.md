# 제로베이스 온보딩 E2E 재실측 — 케이스 B (2026-09-10, main db5cb8e9, grok 워커 실측·planner 검수)

> 계획 `claudedocs/e2e-zero-base-plan/PLAN.md` §B. ADR-0185 §5 11항목 **PASS 11/11**. 실측 원문(LOG·스크린샷 20장)은 `~/projects/e2e-zb/`(세션 로컬), 이탈 D1~D4 → #2429. 케이스 A(그록봇, 발행 이미지)는 v0.1.5 발행 뒤 §A.


- 일자: 2026-09-10
- 클론: `~/projects/e2e-zb/oort`
- commit: `db5cb8e9c118eeabb3c8a3be79911d5c80ea6688` (`main`, Merge PR #2425 snapshot-97)
- compose project: **`e2e-zb`** (스택 유지, `down` 하지 않음)
- doctor: **PASS** (pass 28 / fail 0 / skip 4)
- 브라우저: Playwright Chromium headless, viewport 1280×800, `prefers-color-scheme: light`
- 스크린샷: `~/projects/e2e-zb/shots/`

## 결과 요약

ADR-0185 §5 측정 항목(플랜 B / 워커 지시 ①–⑪) **PASS 11/11**.

| # | 항목 | 판정 | 증거 |
|---|---|---|---|
| ① | 사이드바·설정·프로필에 `momo Demo Workspace` / 「데모 사용자」 / `@demo` 노출 0 | **PASS** | 온보딩 완료 후 DOM grep hits=`[]`. 셸에 「새벽 팀」·「곽성재」. 설정 슬러그 `demo`는 ADR-0185 §6 잔여(문자열 `@demo` 아님). shot `10-shell` `15-settings-workspace` |
| ② | 필수 화면 ≤ 1, 전체 스텝 = 2 (`1/2` `2/2`) | **PASS** | S1 카운터 `1/2` 제목 「내 워크스페이스·내 이름」, S2 `2/2` 「팀원 초대」. S1 skip(지금은 건너뛰기) 행복 경로 0. shot `02-s1` `05-s2` |
| ③ | skip 탈출구 1 상시, skip 시 초대 POST 0, 발급 1 | **PASS** | S2 skip 버튼 1(「나중에」) + 재진입 문장 「설정 › 멤버와 초대에서…」. 발급 전 POST `/invites` = 0, 발급 클릭 후 = 1. 발급 뒤 skip 소멸·「계속」 1 (FIRST_DAY). shot `05-s2` `07-s2-issued` |
| ④ | 팀 규모 질문 0 | **PASS** | S1·S2 본문 grep (`팀 규모`/`몇 명`/`team size` 등) 0 |
| ⑤ | claim 직후 셸 착륙 없음 (`decideFirstRun` ≠ app / S1 선행) | **PASS** | claim 제출 직후 selector=`onboarding-s1`, sidebar/first-agent/phone 0. shot `02-s1` |
| ⑥ | 에이전트 0명 → ≤2s 「첫 에이전트 연결」 (120s 백스톱 0) | **PASS** | S2 「계속」→ first-agent **85 ms**. `kickoffSeen=false`, backstop 0. 제목 「첫 에이전트 연결」. shot `08-first-agent` |
| ⑦ | 첫 에이전트 활성 뒤 오프너 정확히 1 (`#general`) | **PASS** | mock hermes + `PUT /v1/provider/link` 200 → `POST …/agents` 201 `kim-intern` → `#general` membership 200. 메시지 seq2 에이전트 본문 1건 (`김인턴 mock reply…`). 사람 `@kwak` seq1 제외. ui timeline-message=2. shot `14-general-opener` |
| ⑧ | 설정 › 워크스페이스 stale `updatedAtMs` → 409 배너, 두 이름 | **PASS** | REST 동시 PATCH로 서버 이름을 「동시성 이름」. UI 초안 「새벽 팀 실측」 저장 → 배너 「워크스페이스 이름이 「동시성 이름」으로 바뀌었습니다.」 + 초안 유지. shot `16-settings-workspace-409` |
| ⑨ | 설정 › 프로필 점유 핸들 409, 성공 변경 뒤 `@kwak` 과거 본문 불변 | **PASS** | `kim-intern` 저장 → 「이미 쓰는 핸들이에요. 다른 핸들을 골라주세요.」. 이후 `kwakseongjae` 성공. `#general` seq1 본문 `@kwak 핸들 고정 실측` API·UI 모두 유지. shot `18-settings-profile-409` `20-after-restart` |
| ⑩ | `up -d` 재기동 뒤 이름 유지, 재온보딩 0 | **PASS** | `docker compose` project `e2e-zb` `up -d` 후 `/healthz` 200. Playwright reload = sidebar (S1/S2/claim 0). REST: `name=새벽 팀` `displayName=곽성재` `handle=kwakseongjae`. migrate `MOMO_BOOTSTRAP_CLAIM=skipped`. shot `20-after-restart` (레일 이니셜 「새」=새벽 팀) |
| ⑪ | S1 중·S2 중 reload → 같은 스테이지 재진입 | **PASS** | S1 reload → `onboarding-s1` `1/2`. S2 reload → `onboarding-s2`. shot `03-s1-reload` `06-s2-reload` |

## 이탈 (D-표)

| # | 종류 | 문서가 말하는 것 | 실제 | 우회 |
|---|---|---|---|---|
| D1 | 문서 공백 | FIRST_DAY §1: `scripts/self_host_env.sh --local-build` 후 `--compose up`. 생성기는 `MOMO_INITIAL_OWNER_PASSWORD`를 씀. | 같은 문서 §2는 claim이 첫 경로이고, 비밀번호 ConnectPage는 S1/S2를 열지 않는다고 적음. 생성 env에 `MOMO_BOOTSTRAP_CLAIM` 없음. | `SELF_HOST_AGENT.md` §3.3.3 awk: 비밀번호 키 제거 + `MOMO_BOOTSTRAP_CLAIM=1` |
| D2 | 문서 경로 분기 | FIRST_DAY §1 / SELF_HOST §3: `scripts/self_host_env.sh --compose up -d --build --wait` | claim 모드에서 `--compose`는 비밀번호 키를 요구하며 거절 (ADR-0166, 생성기 문구 그대로) | AGENT §3.3.3 `docker compose --env-file` + local-build 오버레이 `docker-compose.rust.build.yml` + `local.override.yml` |
| D3 | 클라 게이트 vs 로컬 mock | FIRST_DAY §7 에이전트 만들기 GUI의 게이트웨이 주소. SELF_HOST §5는 `http://host.docker.internal:<port>/v1` | `createModel.agentBaseUrlIssue`가 비-루프백 `http`를 `plaintextRemote`로 거절. GUI로는 로컬 mock URL을 넣을 수 없음 | provider 링크는 GUI+REST 200. 에이전트 생성은 REST `POST /v1/workspaces/{ws}/agents` (문서 REST 경로 동형) |
| D4 | 플랜 문구 vs FIRST_DAY | 워커 지시 S2: 링크 발급 1회 뒤 「나중에」 | 발급 후 skip 「나중에」는 사라지고 1차 버튼이 「계속」 (FIRST_DAY 정본) | 「계속」으로 퍼널 진행. skip→0 POST는 발급 전 네트워크 로그로 단정 |

사전 D2(#2258 웹 스탬프)는 이 SHA에서 수리됨: overlay `MOMO_BUILD_SHA`, stamp `content="db5cb8e9…"` 40자.

## 포트 · 프로젝트

| 키 | 값 | 이유 |
|---|---|---|
| `COMPOSE_PROJECT_NAME` | `e2e-zb` | 지시. 기존 `oortv013`과 분리 |
| `MOMO_WEB_PORT` | **8089** | 8088 점유 → 생성기 자동 회피 |
| `MOMO_RUST_API_PORT` | 8081 | 8080 점유 |
| `CENT_HOST_PORT` | 8001 | 8000 점유 |
| mock hermes | 18765 | `0.0.0.0` bind, `host.docker.internal` |
| `DB_VOLUME_NAME` | `e2e-zb-pgdata` | 프로젝트명 파생. 기존 `oort-pgdata` 미공유 |
| `DRIVE_VOLUME_NAME` | `e2e-zb-drive` | 동일 |
| 이미지 | `oort:local` | `--local-build` |

다른 compose 프로젝트(`oortv013`, `factsheet-ontology-kb`, `momo_docs-1797-ext1-agent-credential`)는 내리지 않음.

## 타이밍

| 구간 | 시각(UTC) | 소요 |
|---|---|---|
| clone | 12:36:19 | ~33 s |
| env 생성 | 12:38:40 | ~1 s |
| `up -d --build --wait` | 12:39:55 → 12:40:57 | **62 s** (레이어 캐시 hit) |
| doctor | 12:42:47 | ~2 s |
| Playwright 온보딩+§5 | 12:47:36 → 12:47:54 | **18 s** |
| S2 계속 → 첫 에이전트 | — | **85 ms** (한도 2000 ms) |
| 에이전트 생성 → 오프너 seq2 | — | ~2.5 s |

## doctor skip (4, 모두 해당 없음)

- `env.digest` — local-build
- `env.attestation` — local-build
- `public.healthz` / `public.websocket` — `--public-origin` 없음

## 스크린샷 목록

`01-claim` … `20-after-restart` (20장, 1280 light). 로그: `LOG.md`. 단정 JSON: `artifacts/assert.json`.

## 스택 (유지)

- project: `e2e-zb` running(7)
- base: `http://localhost:8089`
- claim (이미 소비됨, 기록용): `http://localhost:8089/claim/<consumed>`
- 로그인(claim 이후): `owner@oort.local` / claim에서 설정한 비밀번호

플래너 검수용으로 `down`하지 않았다. mock hermes(pid, :18765)도 유지.
