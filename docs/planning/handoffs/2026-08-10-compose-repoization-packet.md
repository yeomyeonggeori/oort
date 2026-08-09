# 핸드오프 패킷 — W-O5: compose 레포화 + 단일 이미지 재정의 (#1228)

> 발주: 2026-08-10 Fable. 근거: `research/2026-08-10-buzz-audit-B.md` 상위 1·3. 입력: 성재 대행 라이브 덤프(아래 §1 — 시크릿 값 없음, 구조만).
> 공통 규율은 `2026-08-10-opensource-wave1-packet.md`와 동일(워크트리 신설·PR base=track/engine·STOP·서버 접속 금지).

## 0. 충돌 회피 (하드)

- **`infra/.env.example`·`infra/rust/rust-smoke.env.example`은 W-O4(#1227) 소유 — 접촉 금지.** 오버레이가 요구하는 신규 키는 `infra/rust/overlays.env.example` 신설로.
- W-O1~O3 영역(SECURITY·NOTICE·deny.toml·진입 문서) 무접촉.

## 1. 라이브 실측 (2026-08-10 대행 덤프 — 이것이 재현 대상이다)

**서비스 10**: postgres · runtime-roles · migrate · agent-worker · centrifugo · api · relay · caddy · push-relay · notifier
**이미지 핀**: `pgvector/pgvector:0.8.5-pg18-trixie@sha256:9d2e61c7…` · `centrifugo/centrifugo:v6@sha256:8ba0c944…` · `caddy:2-alpine` · `momo-rust:<태그>` · `momo-push-relay:deploy`

**오버레이 3개 구조(값 절단)** — 레포에 없는 파일들, 이대로 재현:
```yaml
### t3.override.yml
services:
  api:
    environment:
      MOMO_T3_ENABLED: / PLATFORM_ADMIN_EMAILS: / MOMO_PUBLIC_BASE_URL:
      CENT_TOKEN_HMAC: / CENT_PROXY_SECRET: / PROVIDER_LINK_MASTER_KEY:
### caddy.override.yml
services:
  caddy:
    image: (caddy:2-alpine)  restart:
    ports: ["80:80","443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - /opt/momo/web:/srv/web:ro        # ← 이 host bind가 §3에서 볼륨으로 바뀐다
      - caddy-data:/data
    networks: [private]
    labels: com.momo.janitor.managed: / com.momo.janitor.match-label:
volumes:
  caddy-data:
### cent-origin.override.yml
services:
  centrifugo:
    environment:
      CENTRIFUGO_CLIENT_ALLOWED_ORIGINS:
```

**smoke.secrets.env 키셋(22)**: CENT_API_KEY·CENT_HOST_PORT·CENT_PROXY_SECRET·CENT_TOKEN_HMAC·COMPOSE_PROJECT_NAME·JWT_HMAC·LOG_LEVEL·MIGRATE_DATABASE_URL·MOMO_APP_DATABASE_URL·MOMO_APP_POSTGRES_PASSWORD·MOMO_CENTRIFUGO_WS_URL·MOMO_CORS_ALLOWED_ORIGINS·MOMO_ENV·MOMO_RUST_API_PORT·MOMO_RUST_IMAGE·POSTGRES_DB·POSTGRES_PASSWORD·POSTGRES_USER·PROVIDER_LINK_MASTER_KEY·RELAY_DATABASE_URL·RELAY_POSTGRES_PASSWORD·WORKER_POSTGRES_PASSWORD
**push-relay.secrets.env 키셋(14)**: MOMO_APNS_ALLOW_STUB·MOMO_APNS_ENV·MOMO_APNS_KEY_HOST_PATH·MOMO_APNS_KEY_ID·MOMO_APNS_SENDER·MOMO_APNS_TEAM_ID·MOMO_PUSH_NOTIFIER_ENABLED·MOMO_PUSH_RELAY_IMAGE·MOMO_PUSH_RELAY_RATE_LIMIT_PER_MINUTE·MOMO_RELAY_SERVERS·MOMO_RELAY_SIGNING_KEY_HOST_PATH·NOTIFIER_DATABASE_URL·PUSH_RELAY_SERVER_ID·PUSH_RELAY_URL

라이브 Caddyfile sha256 = 레포 `infra/rust/Caddyfile` 일치(bf6a68a0… — 드리프트 0, 이미 정본).

## 2. 임무 A — 오버레이 3개 레포화

- `infra/rust/{t3,caddy,cent-origin}.override.yml` 신설 — §1 구조 그대로, 값은 `${KEY:?}` 보간(신규 키는 `overlays.env.example`에 자리표시자+생성법 주석).
- 이미지 핀(pgvector·centrifugo digest)은 base compose가 이미 갖는지 확인 후, 없으면 이 PR에서 정합.
- 런북(`docs/runbooks/ncp-rust-deploy.md`)의 "서버 위 파일" 표를 "레포 파일" 표로 전환 + 배포 절차에 오버레이 복사 단계.

## 3. 임무 B — 웹 SPA를 이미지 안으로 (단일 이미지 재정의)

- `server-rust/Dockerfile`에 web 빌드 스테이지 추가(node → `clients/web` 빌드 — **주의: clients/web은 루트 워크스페이스 밖, 자체 npm ci** — 산출 `dist/`를 최종 이미지 `/srv/web-dist`로).
- **web-init 패턴 복원**(Swift 선례 `docker-compose.prod.yml`의 web-init·momo-web-static): compose에 `web-init` 서비스 신설 — 이미지에서 named volume으로 dist 복사, `caddy.override.yml`의 `/opt/momo/web` host bind → 그 볼륨으로.
- **버전 스탬핑**: 이미지 LABEL(git sha)+웹 `index.html`에 빌드 커밋 meta 주입 — 라이브 번들을 커밋으로 환원 가능하게(B-10 격차).
- 빌드 시간·이미지 크기 증가를 보고에 실측 기재.

## 4. 검증

- 레포 파일만으로 전체 스택 로컬 기동: `docker compose`(base+push 제외 가능·오버레이 3 포함, 프로젝트명 `w o5-` 대신 `wo5fix-` 접두) → api healthz 200 + caddy가 볼륨의 웹을 서빙(curl로 index 해시 확인) → `down -v` 회수(결과 보고).
- `npm run gate:csp-deploy` green(caddy 마운트 주인 생김 이후에도).
- red proof: 오버레이 하나를 빼고 `config` 렌더 시 필수 키 `:?`가 명확한 에러로 죽는다(조용한 기동 금지).
- Dockerfile 변경이 서버 빌드 캐시를 파괴하지 않는지(웹 스테이지가 rust 스테이지와 독립 캐시).

## 5. 보고

PR 번호 + 신설/변경 파일 표 + 로컬 기동 증적 + 이미지 크기 전후 + 적립 발견. 중간 보고 없음.
