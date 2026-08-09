# NCP 프로덕션(app.oor7.com) Rust 스택 배포 런북

> 정본 확정: 2026-08-04 (첫 승인 축 배포를 이 절차로 수행). 이전 문서(`docs/planning/2026-07-30-ncp-rust-smoke-prep.md`)의 **2파일 compose 명령은 낡았다** — 그대로 쓰면 centrifugo가 origin 허용목록 없이 재생성된다(2026-08-04 실제로 밟은 함정).

## 서버

- `app.oor7.com` = **101.79.11.189** (NCP KVM, 인스턴스 143929369) · 디스크 9.8G(≈82% 사용 — 배포 전 회수 습관)
- 접속: pem 직접 로그인 불가. pem으로 root 비번을 복호화(`getRootPassword`)한 뒤 `sshpass`. 절차·도구는 `2026-07-30-ncp-rust-smoke-prep.md`(§접속)와 `scratchpad/ncp-power.py`(전원). 비번 파일은 세션 스크래치패드에 0600으로 두고 **레포에 절대 커밋 금지**.

## 서버 위 파일 (`/opt/momo/infra/rust/`)

| 파일 | 역할 |
|---|---|
| `docker-compose.rust.yml` | 본체 — 전 rust 서비스가 `${MOMO_RUST_IMAGE}` 참조 |
| `docker-compose.push.yml` | notifier·push-relay (보간에 `MOMO_APNS_KEY_HOST_PATH` 필요) |
| `t3.override.yml` · `caddy.override.yml` · `cent-origin.override.yml` | T3 · TLS/리버스프록시 · **centrifugo origin 허용목록** |
| `Caddyfile` | **레포 정본**(#1217 회수) = `infra/rust/Caddyfile`. `caddy.override.yml`이 `./Caddyfile:/etc/caddy/Caddyfile:ro`로 마운트한다. 경로 분기 + **보안 헤더 5종**(#1213) |
| `smoke.secrets.env` | `MOMO_RUST_IMAGE=<태그>` 포함 — **배포란 이 태그를 바꾸는 일이다** |
| `push-relay.secrets.env` | APNs `.p8` 호스트 경로 등 |

## 배포 절차

1. (로컬) amd64 이미지 빌드 → 전송 → 서버에서 `docker load` (태그 = track/engine 커밋 해시, 예 `momo-rust:dae3a387`).
2. (서버) 태그 갱신 + 기동 — **파일 5개·env 2개 전부, 빠지면 안 된다**:
   ```bash
   cd /opt/momo/infra/rust
   cp smoke.secrets.env smoke.secrets.env.bak-$(date +%Y%m%d)
   sed -i "s/^MOMO_RUST_IMAGE=.*/MOMO_RUST_IMAGE=momo-rust:<새태그>/" smoke.secrets.env
   docker compose --env-file smoke.secrets.env --env-file push-relay.secrets.env \
     -f docker-compose.rust.yml -f docker-compose.push.yml -f t3.override.yml \
     -f caddy.override.yml -f cent-origin.override.yml up -d
   ```
   migrate는 one-shot으로 돌고 멱등이다(`[migrate] IDEMPOTENCY_OK` 확인).
3. 검증 (밖에서):
   ```bash
   curl -s -o /dev/null -w '%{http_code}' https://app.oor7.com/healthz            # 200
   curl -s -o /dev/null -w '%{http_code}' https://app.oor7.com/v1/workspaces/<ws>/approvals  # 401(=서빙), 404면 구 이미지
   # 보안 헤더 5종 (#1213). 아래 「Caddy 설정 배포」를 한 창에서는 이 줄이 수용기준이다.
   curl -sI https://app.oor7.com | grep -iE 'content-security|strict-transport|x-content-type|referrer|frame'
   ```
   + `docker ps`에서 momo-rust 4서비스(api·relay·agent-worker·notifier)가 **전부 새 태그**인지 — notifier는 push.yml 소속이라 파일을 빼먹으면 혼자 구 이미지로 남는다(2026-08-04 실증).

## Caddy 설정(보안 헤더 포함) 배포

`infra/rust/Caddyfile`이 **레포 정본**이다(#1217). 이미지 태그와 무관하게 이 파일만 바뀌는 배포가 있고, 그때는 아래 세 단계가 전부다. **웹 SPA와 헤더가 같은 배포 창에 묶이면 SPA를 먼저 올리고 헤더를 뒤에 올린다** — 새 정책이 옛 번들을 막는 구간을 만들지 않기 위해서다.

1. (로컬 → 서버) **덮어쓰기는 반드시 제자리에서.**
   ```bash
   # 워크트리에서 서버로. scp/cp 는 같은 inode에 쓴다.
   scp infra/rust/Caddyfile root@101.79.11.189:/opt/momo/infra/rust/Caddyfile
   ```
   > ⚠️ `caddy.override.yml`은 **파일 하나**를 `./Caddyfile:/etc/caddy/Caddyfile:ro`로 bind mount 한다. 디렉터리 마운트와 같은 함정이 파일 단위로 있다: `mv new Caddyfile`(rename)로 바꾸면 inode가 갈리고 컨테이너는 **옛 파일을 계속 본다**. `scp`·`cp`·`sed -i`는 제자리에 쓰므로 안전하고, 에디터의 「원자적 저장」(임시파일→rename)은 안전하지 않다.

2. (서버) 문법 검사 → reload. 컨테이너를 재생성하지 않으므로 연결이 끊기지 않는다.
   ```bash
   cd /opt/momo/infra/rust
   # 서비스 이름은 caddy.override.yml 에서 확인 (아래는 `caddy` 인 경우).
   docker compose --env-file smoke.secrets.env --env-file push-relay.secrets.env \
     -f docker-compose.rust.yml -f docker-compose.push.yml -f t3.override.yml \
     -f caddy.override.yml -f cent-origin.override.yml exec caddy \
     caddy validate --config /etc/caddy/Caddyfile   # Valid configuration
   … 같은 compose 인자로 exec caddy caddy reload --config /etc/caddy/Caddyfile
   ```
   reload가 설정을 거절하면 **옛 설정이 그대로 살아 있다**(caddy는 새 설정이 유효할 때만 갈아탄다). 그래도 validate를 먼저 하는 이유는, 거절 메시지를 배포 로그가 아니라 손에서 읽기 위해서다.

3. (밖에서) **라이브 헤더 재실측** — 이것이 #1213의 종결 수용기준이다.
   ```bash
   curl -sI https://app.oor7.com | grep -iE 'content-security|strict-transport|x-content-type|referrer|frame'
   ```
   5종이 다 보여야 한다: `content-security-policy`(`frame-ancestors 'none'` 포함 — 클릭재킹 축은 이 안에 있고 `x-frame-options`는 없는 것이 정상이다) · `strict-transport-security` · `x-content-type-options` · `referrer-policy`. 첨부는 헤더만으로 확인되지 않으니 **실제 파일 하나를 올려 본다** — `connect-src`에서 `https://www.googleapis.com`이 빠지면 업로드가 즉사한다(#1206).

### HSTS 확장 일정

`max-age=86400`(1일)로 시작한다. 브라우저가 **기억하는** 헤더라 되돌리기가 서버 쪽에 없기 때문이다(헤더를 지워도 이미 받은 브라우저는 만료까지 평문 접속을 거부한다). 확장은 관찰 뒤에: 1일 무사고 → `604800`(1주) → 무사고 → `31536000`(1년) + 하위도메인이 생겼다면 그때 `includeSubDomains`를 함께 판단. **`preload`는 어느 단계에서도 붙이지 않는다** — 프리로드 목록 등재는 브라우저 소스에 박히고 제거에 수개월이 걸린다. `clients/web` 게이트(`npm run gate:csp-deploy`)가 `preload` 유무를 레포에서 막는다.

## 롤백

`smoke.secrets.env`의 태그를 직전 값(백업 파일 참조)으로 되돌리고 같은 up -d 한 번.

Caddyfile만 되돌릴 때는 레포의 직전 커밋 판을 같은 방식으로 덮어쓰고 reload 한 번. **단 HSTS는 롤백되지 않는다**: 헤더를 지워도 이미 그 헤더를 받은 브라우저는 max-age 동안 이 호스트를 HTTPS로만 연다. 그래서 첫 값이 1일이다.

## 디스크 위생

배포 전 `docker images | grep momo`로 사용 안 하는 옛 태그 제거(`docker image rm`). **직전 태그 하나는 롤백용으로 반드시 남긴다.**

## 웹(정적 SPA) 배포

Caddy가 호스트 `/opt/momo/web`(bind mount → 컨테이너 `/srv/web`)를 서빙한다(`Caddyfile`의 `handle { root * /srv/web }`).

1. (로컬, track/engine 워크트리) `cd clients/web && npm run build` → `dist/`
2. 업로드 후 **반드시 마운트된 디렉터리 inode 안에서 내용 교체**:
   ```bash
   tar czf - -C dist . | ssh root@101.79.11.189 \
     'mkdir -p /opt/momo/web.new && tar xzf - -C /opt/momo/web.new && \
      find /opt/momo/web -mindepth 1 -delete && cp -a /opt/momo/web.new/. /opt/momo/web/ && rm -rf /opt/momo/web.new'
   ```
3. 검증: `curl -s "https://app.oor7.com/?v=$(date +%s)" | grep -o 'index-[^"]*\.js'` 가 dist의 해시와 일치.

> ⚠️ **함정(2026-08-04 실증): 디렉터리 `mv` 스왑 금지.** docker bind mount는 컨테이너 기동 시점의 **inode**를 잡는다 — `mv web web.bak && mv web.new web`을 하면 컨테이너는 여전히 옛 디렉터리(web.bak이 된 inode)를 서빙한다. 내용 교체는 반드시 기존 디렉터리 **안**에서.
