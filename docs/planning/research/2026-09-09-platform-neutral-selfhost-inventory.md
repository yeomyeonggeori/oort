# 플랫폼 중립·에이전트 주도 셀프호스팅 — 현행 인벤토리·외부 사실 (2026-09-09, read-only 조사)

> ADR-0184의 근거. 레포 인벤토리는 `main @ d24a7361` 기준 Explore 조사(파일:줄), 외부 사실은 2026-09-09 검색.

## 1. 설치 경로별 현행
- **Railway(SH-5a)**: `infra/railway/railway.json`(서비스 6+PG 플러그인, LiveKit 제외) · `Caddyfile.railway` · `Dockerfile.caddy` · 생성기 `--railway`(정본 키 41 + 공개 엣지 2) · 손으로 넣는 3키(`CENT_API_URL`·`WORKER_DATABASE_URL`·`CENTRIFUGO_CHANNEL_PROXY_SUBSCRIBE_HTTP_STATIC_HEADERS`) · 마이그레이션 = `preDeployCommand` 2회 · **실배포 0회**(`RAILWAY_TOKEN`/로그인 대기, #2205) · `test_railway_template.sh`는 **어떤 게이트에도 미배선**.
- **VPS/공개 오리진**: `--public-origin` → `caddy.override.yml`(빈 `OORT_SITE_ADDRESS`면 compose 실패로 ACME 오발 방지) · DNS는 사람.
- **그록봇 VM**: `/workspace` 영속 · claim 모드 · Funnel(사람 클릭 4~5회, 「계정 0은 미달성」) · cloudflared 폴백(1015 구조적 노출).
- **로컬**: Docker+git만.
- **doctor `public.*`**: `CENTRIFUGO_ALLOWED_ORIGINS`의 비루프백 오리진이 있을 때만 `healthz` 200 + `websocket` 101; Railway 형상에서 오리진 부재는 skip 아닌 fail(`oort_doctor.sh:978`).
- **발행 이미지**: `releases/latest.json` v0.1.4 list digest; 생성기 정규식은 `ghcr.io/yeomyeonggeori/oort@sha256:<64hex>`만(미러 불가).

## 2. 에이전트 주도 계약의 현행
- §0: 본인 머신·계정만, 시크릿 채팅 금지, **「셀렉터·원격 디버깅·스크립트 UI로 앱 조종 금지」(:36)** — 벤더 앱 맥락이 문면에 없어 플랫폼 콘솔 자동화 경계가 공백.
- §1 표: Local·VPS·Grok Bot VM·Railway(stub 문면)·Fly/AWS/GCP(「VPS와 같음」). **Cloudflare 행 없음.**
- provider CLI/MCP 배선 0(`wrangler`·`flyctl`·`gcloud`·`aws` 0건; `railway`는 브리프에만). OAuth device flow 0.
- 호스팅 선택 ADR **없음**(SH-5a는 「ADR 불요」로 진행).

## 3. compose/이미지 이식성 — 관리형 플랫폼에 매핑되지 않는 것
단일 호스트 명명 볼륨(`down -v` 의미론) · `host.docker.internal` extra_hosts(로컬 provider) · 루프백 포트 바인딩 · 파일 마운트(centrifugo.json·livekit·Caddyfile) · `service_completed_successfully` 의존(one-shot) · healthcheck · UID 10001 chown 사이드카 · profiles(livekit) · mem_limit. Railway는 각각 env·빌드타임 COPY·`preDeployCommand`·`healthcheckPath`로 우회 — **플랫폼마다 같은 우회를 재발명**해야 하는 축.

## 4. 엣지 계약·게이트
`OORT_SITE_ADDRESS`(site label, 손 타이핑 금지) · `OORT_CSP_CONNECT_SRC` · `CENT_PROXY_SECRET`(api↔Centrifugo 정확 일치, 이중 키 기간 없음) · `MOMO_CORS_ALLOWED_ORIGINS`(Tauri 2종) · `CENTRIFUGO_ALLOWED_ORIGINS`(공백 구분). 게이트: `verify_public_edge_centrifugo_contract.sh`(정본 Caddyfile 하드코딩, 픽스처 루트로만 확장) · `..._boundary.sh`(단일 site label 파생 origin만) · `gate:csp-deploy` #2181(리터럴 CSP 단정, **선재 RED**, 미배선) · `check_compose_env_templates.sh` 표.

## 5. 관리형 플랫폼의 day-2 — 깨지는 줄
doctor `stack.*` 전부 `docker compose ps/exec/logs` 전제(`oort_doctor.sh:626-627, 838, 935, 961`) · `oort backup` = `docker exec … pg_dump`(`pg_dump_custom.sh:24`, 컨테이너 라벨 해소 `:88`) · `oort restore` = compose one-shot(`oort_day2.sh:559-578`) · `oort upgrade` = `oort_require_volumes`(docker volume inspect + `Caddyfile.local` bind 존재) · `oort_compose()` 정본 파일 집합 하드코딩. ⇒ **T2에서는 `tool.*`·`env.*`·`public.*`만 유효, backup/restore/upgrade 실행 불가** — §3.4 게이트(`public.*` PASS)와 CLI 능력이 이미 갈라져 있음. pgBackRest S3 오버레이는 호스트 파일 bind 3종 전제, #2157 선재 RED.

## 6. 외부 사실(2026-09-09)
| 플랫폼 | 에이전트 조작 수단 | 상태ful 스택 적합성 |
|---|---|---|
| Railway | `railway setup agent`(CLI+skills+MCP+auth), 원격 MCP `mcp.railway.com`(OAuth, `railway-agent` 툴), `railway mcp`/`railway mcp local` | 적합(T2) |
| Cloudflare | MCP `mcp.cloudflare.com`, `wrangler deploy`(Dockerfile→CF 레지스트리) | **컴퓨트 부적합**(Containers: Durable Object 바인딩·`sleepAfter` 유휴 정지·영속 디스크 미문서·compose 미지원) / **엣지 적합**(DNS·Tunnel·TLS) |
| AWS | ECS MCP Server(awslabs), App Runner(ECR), Compose→ECS/Fargate 사양, Lightsail | 적합(T1 Lightsail/EC2, T2 ECS+RDS) |
| Fly.io | `flyctl launch`(Dockerfile→Firecracker VM, 볼륨·IP 자동), MCP 문서 | 적합(T1: 단일 VM+볼륨+compose 또는 서비스별 앱) |
| VPS | SSH + compose(정본) | 적합(T1) |

## 7. 하드 제약(요약)
단일 쓰기경로 · RLS/롤 4URL·3롤(runtime-roles → migrate 순서) · 엣지 시크릿 대칭 · `/v1/centrifugo/*` 403 순서(프록시 공개·api 내부) · doctor `public.*` PASS = 완료 · 불변 list digest만 · 플랫폼 토큰 비유입 · 에이전트 행동 경계(§0) · 하네스 불가지론 문면 · 키 정본 단일화(`oort_canonical_env_keys`).
