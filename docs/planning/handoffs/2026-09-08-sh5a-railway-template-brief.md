# 워커 브리프 — SH-5a Railway 템플릿: 단일 GHCR 이미지 서비스 4 + Postgres 플러그인 + Centrifugo + 공개 도메인 → SH-2 env, 1회 E2E (engine · #2205 · ADR 불요 — ADR-0121·0166·0167 셀프호스트 계약 소비)

> 워커: grok 4.6 · base=origin/track/engine · 워크트리 `momo-worktrees/wsh5a`(`feat/sh5a-railway-template`) · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. **허용 보호 경로(정책 감사)**: `scripts/self_host_env.sh`(Railway env 매핑 출력 모드 1개, 기존 키 목록 함수에서 파생) · `scripts/lib/oort_doctor.sh`(Railway 형상 감지 1행, 선택) · `scripts/tests/test_railway_template.sh`(신규). 그 밖의 `scripts/**`·`.github/**` 무수정. `infra/rust/docker-compose.rust.yml`·`Caddyfile*` 무수정(새 파일은 `infra/railway/` 아래). 시크릿·실호스트 값 커밋 금지(`example.test`). Railway 실배포는 `RAILWAY_TOKEN`이 env에 있을 때만(planner/성재 제공) — 없으면 §2의 로컬 검증까지 완주하고 실배포는 NOTES에 「planner 수행」.
> 근거: 1차 목표 §3 B-1·§4 G1'-1 · `infra/rust/docker-compose.rust.yml`(같은 이미지 `ghcr.io/yeomyeonggeori/oort` command 분기: api·relay·webhook-sender·agent-worker·migrate·runtime-roles; postgres·centrifugo·livekit) · `caddy.override.yml`·`Caddyfile`(SH-2 템플릿: `{$OORT_SITE_ADDRESS}`·`{$OORT_CSP_CONNECT_SRC}`, `/v1/centrifugo/*` 403) · `scripts/self_host_env.sh --public-origin` · `scripts/oort doctor` `public.*` · `releases/latest.json`(v0.1.4 digest) · `docs/SELF_HOST_AGENT.md` §3.4 stub · `railway` CLI 4.27(이 머신).

## 1. 구현 계약
1. **`infra/railway/`**: `railway.json`(또는 템플릿 정의) + `README.md` — 서비스: `api`(공개, 포트 8080), `relay`, `webhook-sender`, `agent-worker`(전부 같은 이미지 ref, 각 `startCommand` = 이미지 서브커맨드), `centrifugo`(공식 이미지, `CENTRIFUGO_*` env로 `infra/centrifugo.json`과 동등 설정 — 파일 마운트 없음), Postgres = Railway 플러그인(`DATABASE_URL`·`PG*` 제공 변수 → `MOMO_APP_DATABASE_URL`·런타임 롤 URL 매핑). LiveKit 제외. 마이그레이션·runtime-roles = api 서비스 `preDeployCommand`(이미지 `migrate` 서브커맨드가 롤 부트스트랩까지 하는지 실측 — 안 하면 두 명령 순차).
2. **env 매핑**: `scripts/self_host_env.sh --railway`(신규 모드): Railway 제공 변수(`RAILWAY_PUBLIC_DOMAIN`, `DATABASE_URL`, 서비스 내부 호스트)를 읽어 현행 키 집합(`OORT_SITE_ADDRESS`·`OORT_CSP_CONNECT_SRC`·`MOMO_CENTRIFUGO_WS_URL=same-origin`·`PROVIDER_LINK_MASTER_KEY`·JWT/CENT HMAC 등 생성기의 시크릿 9종)을 **같은 함수에서** 파생해 Railway 변수 형식으로 출력. 키 목록을 손으로 복제하지 않는다(기존 `oort_public_edge_env_keys` 등 재사용).
3. **공개 엣지 보안 동등성**: Railway가 TLS를 종단하므로 Caddy 없이 api가 공개된다 → 택일: (a) `caddy` 서비스를 템플릿에 두고 api를 내부로(권장 — Caddyfile 재사용, 계약 게이트 불변) (b) api가 CSP·`/v1/centrifugo/*` 403을 직접 냄(서버 코드 변경 = 범위 밖 → 선택 불가). 즉 (a). Caddy 서비스의 `OORT_SITE_ADDRESS`는 Railway 도메인, ACME는 Railway가 하므로 `auto_https off`+`:8080` 형태의 **Railway용 Caddyfile 변형은 금지** — 대신 기존 Caddyfile을 env로 그대로 쓰되 TLS 이중 종단이 되는 부분(내부 http)만 `infra/railway/Caddyfile.railway`로 최소 분기하고 `verify_public_edge_centrifugo_*` 계약(403·순서·해시)이 그 파일에도 통과함을 픽스처로 넓혀 증명(게이트 본체 무수정).
4. **문서**: `docs/SELF_HOST_AGENT.md` §3.4(+ko) 실절차(Railway 계정 → 템플릿 배포 → 도메인 → env → doctor) · `docs/SELF_HOST.md` 「Railway」 절 · README Self-host 절 링크 1줄.
5. **실배포 E2E**(`RAILWAY_TOKEN` 있을 때): `railway up` → 도메인 → `scripts/oort doctor --json`(원격 모드 또는 `public.*`만) `public.healthz`·`public.websocket` PASS 원문 → 로그인 → 폰 QR 1회(선택) → `railway down`(자원 회수). 토큰 없으면: `railway.json` 스키마 검증 + 로컬에서 같은 이미지 4 서비스를 Railway 변수 형식 env로 기동(`docker compose` 등가 파일 `infra/railway/local-equivalent.yml`은 **금지** — 대신 생성기 출력만 검증) + Caddyfile.railway `caddy adapt` 픽스처.

## 2. red proof
- `scripts/tests/test_railway_template.sh`: ①`railway.json` 필수 서비스·startCommand·preDeploy 존재 ②생성기 `--railway` 출력의 키 집합 == 현행 키 집합(차집합 0, 사보타주: 키 하나 빼면 RED) ③`Caddyfile.railway` `caddy adapt` 성공 + 403 순서 단정 ④공개 도메인 변수 부재 시 생성기 명시 실패 문장.
- `scripts/local_gate.sh --profile docs` PASS(공개 엣지 계약 게이트 포함) · `check_compose_env_templates.sh`(새 템플릿을 표에 넣지 않으면 그 사유를 PR에).
- 실배포 시 doctor 원문·스크린샷(마스킹). 미배포 시 NOTES에 「planner 수행 절차」 5줄.

## 3. 완료 절차
커밋 순서: ①템플릿·README ②생성기 `--railway` ③Caddyfile.railway+픽스처 ④시험 ⑤문서 ⑥(선택) 실배포 증거. push `feat/sh5a-railway-template` → PR(base `track/engine`): 게이트 원문·키 집합 대조·**보호 경로 변경 파일 목록**·NOTES. 마지막 출력 `DONE / COMMITS / GATES / PR / NOTES`.

## 4. 규율
「이 레포가 싣지 않는 compose를 발명하지 않는다」(SELF_HOST_AGENT 규율). 키는 생성기 한 정본에서 파생. 게이트 완화 금지. 막히면 보고 후 정지.
