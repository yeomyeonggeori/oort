# SH-4a Local machine install run (#2104)

> 영문 정본 `docs/SELF_HOST_AGENT.md` §3.1만 보고 스크래치 클론에서 설치.
> 시크릿·실호스트·digest hex는 이 파일에 다시 적지 않는다. 이미지 pin은
> `releases/latest.json` 을 읽는 명령으로만.

측정일: 2026-09-06. 워크트리 `wsh4a` `feat/sh4a-selfhost-agent-en`.
사람 개입: **0** (막힌 자리는 문서를 고치고 같은 에이전트가 다시 밟음).

## 절 이동 대조표 (lost = 0)

구 `docs/SELF_HOST_AGENT.md` (972줄, 한국어, Grok Bot VM 전용) → 신 영문 정본.

| 구 절 | 신 위치 |
|---|---|
| 머리말 (이 문서가 제품 / SELF_HOST·FIRST_DAY·dump 포인터 / ADR-0004) | §0 머리말 (하네스 불가지론) |
| §0 전제 — 누구의 기계인가 | §0 계약 + §3.3 본인 계정/VM |
| 의존을 먼저 밝힌다 | §1 표 prerequisites + §2.1 / §3.3.1 |
| §1 코어 설치 도입 | §2 도입 |
| §1.1 스냅샷을 받는다 | §2.1 (git clone) + §3.3.1 (curl+tar) |
| §1.2 GHCR 고정 digest | §2.2 |
| §1.3 Postgres를 `/workspace`에 둔다 | §3.3.2 |
| §1.4 env 생성 + claim 모드 | §2.3 (비밀번호 기본) + §3.3.3 (claim) |
| §1.5 헬스체크 게이트 | §2.5 `scripts/oort doctor --json` + §3.3.4 수동 curl |
| §1.6 claim 경로 게이트 | §3.3.5 |
| §1.7 멱등 재기동 | §4 Day-2 (SH-3b 미랜딩, 산문 유지) + §3.3.8 |
| §2 환경 분기 도입 | §1 표 + §3 |
| §2.1 경로 선택 | §1 표 + §3.3 도입 (M1 only) |
| §2.2 Tailscale Funnel | §3.3.6–3.3.7 |
| §2.2.1 불변식 — state | §3.3.6 |
| §2.2.2 설치 · 로그인 · 서빙 | §3.3.7 |
| §2.2.3 Update / Reset 뒤 | §3.3.8 |
| §2.3 공개 오리진 등록 | §3.2 (VPS/공개 Caddy) + §3.3.9 (Funnel, 루프백 Caddy 유지). SH-2 키 `OORT_SITE_ADDRESS` · `OORT_CSP_CONNECT_SRC` 수록 |
| §2.4 외부 도달성 자가검증 | §3.3.10 + doctor `public.*` |
| §2.5 폴백 — cloudflared quick tunnel | §3.3.11 |
| §2.6 숙련자 트랙 | §3.3.12 + §3.2 / §3.4–3.7 |
| §2.7 알려진 위험 | §3.3.13 |
| §3 사용자 핸드오프 | §3.3.14 |
| §3.1 회신 템플릿 | §3.3.14 |
| §3.2 첫날 백업 | §3.3.15 |
| §3.3 에이전트 합류 | §3.3.16 |
| §4 도어벨 (4.1–4.6) | §3.3.17 / §3.3.17.1–3.3.17.6 |
| §5 데이터 가져가기 | §3.3.18 + §4 |
| §6 하지 말 것 | §0 계약 (공통) + §3.3.19 |

사라진 절: **0**.

신설(구본에 없던 행): §1 표 Local / VPS / Railway / Fly / AWS / GCP, §3.1 Local, §3.2 VPS 공개 오버레이, §3.4–3.7 (SH-5 전까지 §3.2 포인터), §5 doctor id→fix 표.

## 설치 런 (Local machine)

정본만 따름. 다른 문서(`SELF_HOST.md`)는 측정 중 읽지 않음.

### 위상 (성공 경로 = 6)

| # | 위상 | 명령 (요약) | 시각 (UTC) | 결과 |
|---|---|---|---|---|
| 1 | clone | `git clone` 워크트리 → `$HOME/oort-sh4a-install` | 02:14:50 | tree + `Caddyfile.local` 존재 |
| 2 | image | `jq` → `docker pull "$IMAGE_REF"` (hex는 매니페스트) | 02:12:37–02:12:44 (캐시 이후 재사용) | inspect OK |
| 3 | env | `COMPOSE_PROJECT_NAME=oort-sh4a scripts/self_host_env.sh --published-image "$IMAGE_REF"` | 02:15:41 | 파일 생성 0600. 기존 `oort` 스택과 분리. 웹 포트 8089 (8088 점유) |
| 4 | up | `scripts/self_host_env.sh --compose up -d --pull missing --wait` | 02:15:42–02:15:58 | exit 0, api healthy |
| 5 | doctor | `scripts/oort doctor --json` | 02:15:58 | 아래 JSON. exit 0 |
| 6 | login | GET `/` + POST `/v1/auth/login` (§2.6 헤드리스 게이트) | 02:16 전후 | GET 200 SPA; LOGIN 200 + `accessToken` 존재 (값은 폐기) |

`scripts/oort doctor --json` 성공 `summary` (값 그대로):

```json
{"pass": 28, "fail": 0, "skip": 3, "verdict": "PASS"}
```

skip 3: `stack.outbox` (postgres exec 실패 — 판정은 skip, verdict를 빨개지 않음), `public.healthz` / `public.websocket` (루프백만 — Local에서 기대).

종료코드 0 = PASS.

월타임 (성공 클론 기동): env 생성부터 doctor PASS까지 **약 17초** (이미지 이미 local). pull은 별도 약 7초. 콜드 이미지면 더 길다.

### 막힌 곳 (문서 수정 후 재측정)

사람 클릭/비밀번호 제공은 없었다. 에이전트가 막히고 문서를 고친 자리:

1. **`/tmp` 클론 + Docker Desktop (macOS).** compose가 `infra/rust/Caddyfile.local` bind-mount에 실패 (`not a directory`). 파일은 호스트에 있었다. 원인은 Docker VM이 `/tmp`를 공유하지 않음. → §2.1 / §3.1에 홈 경로를 적고 `$HOME/oort-sh4a-install` 에서 재시도. 마운트 성공.
2. **실패 1차 up이 만든 `oort-sh4a-pgdata` + 새 env.** 두 번째 트리에서 env를 다시 만들어 `runtime-roles` 가 `password authentication failed for user "momo"`. → §2.4 / §5에 `down -v` + env 삭제 후 §2.3 재생성. 그 경로로 세 번째 up = PASS.

GUI 브라우저: 이 세션은 MCP 사용 금지라 Chromium을 직접 조작하지 않음. 가장 가까운 게이트는 정본 §2.6 헤드리스: 로그인 HTML GET 200, `POST /v1/auth/login` 200, 본문에 `accessToken`·`refreshToken`·`realtimeWebSocketUrl` (토큰 원문 미기록, 본문 파일 삭제).

COMPOSE_PROJECT_NAME=`oort-sh4a` 는 이 머신에 이미 `oort` 스택이 있어 정본 §2.3 충돌 분기를 탄 것. 개입 아님.

## red proofs

```
grep -rn '@sha256:' docs/SELF_HOST_AGENT.md docs/SELF_HOST_AGENT.ko.md llms.txt   # 0
grep -rn 'app.oor7.com' docs/SELF_HOST_AGENT.md docs/SELF_HOST_AGENT.ko.md llms.txt   # 0
```

CDP: 영문 정본 §3.3.16·§3.3.19만 (Grok Bot 분기). `llms.txt` 0건. `Grok Bot only` 0건.

절 번호 집합 영문=한국어 (44): `0 1 2 2.1 2.2 2.3 2.4 2.5 2.6 3 3.1 3.2 3.3 3.3.1 … 3.3.19 3.4 3.5 3.6 3.7 4 5`.

`scripts/check_release_manifest.sh` glob `docs/SELF_HOST*.md` 는 `SELF_HOST_AGENT.ko.md` 를 **포함**한다 (miss 아님).
