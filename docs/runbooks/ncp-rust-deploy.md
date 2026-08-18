# NCP 프로덕션(app.oor7.com) Rust 스택 배포 런북

> 정본 확정: 2026-08-04 (첫 승인 축 배포를 이 절차로 수행). 이전 문서(`docs/planning/2026-07-30-ncp-rust-smoke-prep.md`)의 **2파일 compose 명령은 낡았다** — 그대로 쓰면 centrifugo가 origin 허용목록 없이 재생성된다(2026-08-04 실제로 밟은 함정).

## 서버

- `app.oor7.com` = **101.79.11.189** (NCP KVM, 인스턴스 143929369) · 디스크 9.8G(≈82% 사용 — 배포 전 회수 습관)
- 접속: pem 직접 로그인 불가. pem으로 root 비번을 복호화(`getRootPassword`)한 뒤 `sshpass`. 절차·도구는 `2026-07-30-ncp-rust-smoke-prep.md`(§접속)와 `scratchpad/ncp-power.py`(전원). 비번 파일은 세션 스크래치패드에 0600으로 두고 **레포에 절대 커밋 금지**.

## 배포 파일 = 레포 파일 (#1228)

> **2026-08-10 이전의 이 표는 「서버 위 파일」이었다.** compose 5개 중 3개가 어느 커밋에도 존재한 적이 없었고(`git rev-list --all --objects` 전수 0건), 그래서 이 런북조차 자기 스택의 서비스 이름을 단정하지 못했다("서비스 이름은 caddy.override.yml 에서 확인"). #1228이 그 셋을 회수했다. **이제 서버에만 있는 것은 값(`*.secrets.env`)과 키파일뿐이고, 구조는 전부 레포에 있다.**

| 레포 경로 | 서버 위 이름 | 역할 |
|---|---|---|
| `infra/rust/docker-compose.rust.yml` | 같음 | 본체 — 전 rust 서비스가 `${MOMO_RUST_IMAGE}` 참조 |
| `infra/rust/docker-compose.push.yml` | 같음 | notifier·push-relay (보간에 `MOMO_APNS_KEY_HOST_PATH` 필요) |
| `infra/rust/t3.override.yml` | 같음 | ADR-0140 플랫폼 표면을 api에 연다 |
| `infra/rust/caddy.override.yml` | 같음 | TLS 에지 + **web-init**(SPA를 이미지에서 볼륨으로) |
| `infra/rust/cent-origin.override.yml` | 같음 | **centrifugo origin 허용목록** — 틀리면 전 클라이언트 403 |
| `infra/rust/Caddyfile` | 같음 | 경로 분기 + **보안 헤더 5종**(#1213). `caddy.override.yml`이 `./Caddyfile:/etc/caddy/Caddyfile:ro`로 마운트 |
| `infra/rust/rust-smoke.env.example` | `smoke.secrets.env` | `MOMO_RUST_IMAGE=<태그>` 포함 — **배포란 이 태그를 바꾸는 일이다** |
| `infra/rust/push-relay.env.example` | `push-relay.secrets.env` | APNs `.p8` 호스트 경로 등 |
| `infra/rust/overlays.env.example` | `overlays.secrets.env` | 오버레이 3개가 요구하는 키 (T3 · origin 목록 · caddy 포트) |
| `scripts/verify_ncp_centrifugo_boundary.sh` | `/opt/momo/scripts/` | 공개 403 · private API 인증 단계 · `CENT_PROXY_SECRET` SHA-256 동일성의 **읽기 전용** 배포 증거 |
| — | APNs `.p8` · relay Ed25519 개인키 | 레포 비유입이 **정상**(ADR-0004/0120) |

> ⚠️ **오버레이 3개는 레포에 있지만 `caddy.override.yml`은 로컬에서 켜지 말 것.** `Caddyfile`이 실도메인(`app.oor7.com`)을 스킴 없이 선언하므로 Caddy는 **컨테이너 기동 즉시** 그 도메인으로 실제 ACME 주문을 시작한다 — 요청 한 번 없어도, 호스트 포트를 어디로 옮겨도. (2026-08-10 #1228 검증 중 실측: 프로덕션 Let's Encrypt에 챌린지 4회 실패. 빈 `caddy-data`라 새 ACME 계정이 만들어졌고 인증서 발급은 0이라 라이브 계정·도메인 한도는 움직이지 않았다.) 로컬 검증은 base + `t3` + `cent-origin`까지만 올리고, 웹 볼륨은 따로 들여다본다:
> ```bash
> docker run --rm -v <project>_web-static:/srv/web:ro caddy:2-alpine \
>   caddy file-server --root /srv/web --listen :8080
> ```

## 배포 절차

1. (로컬) amd64 이미지 빌드 → 전송 → 서버에서 `docker load`. 태그 = track/engine 커밋 해시.
   **`MOMO_BUILD_SHA`를 반드시 넘긴다** — 이미지 라벨과 SPA `<meta name="momo-build">`에 박히는 값이고, 이것이 라이브를 커밋으로 되돌리는 유일한 in-band 경로다(#1228 이전에는 없었다).
   ```bash
   SHA=$(git rev-parse --short=8 HEAD)
   docker build --platform linux/amd64 \
     --build-arg MOMO_BUILD_SHA="$SHA" \
     -f server-rust/Dockerfile -t "momo-rust:$SHA" .
   ```
   이 이미지 하나에 **웹 SPA가 들어 있다**(#1228). 별도의 웹 배포 단계는 없다 — 아래 「웹(정적 SPA) 배포」 참조.
2. (서버, 오버레이가 바뀐 창에서만) 레포 파일 동기화 — **덮어쓰기는 반드시 제자리에서**(`scp`/`cp`, `mv` 금지: 아래 inode 함정):
   ```bash
   ssh root@101.79.11.189 'install -d -m 0755 /opt/momo/scripts'
   scp infra/rust/{docker-compose.rust.yml,docker-compose.push.yml,t3.override.yml,caddy.override.yml,cent-origin.override.yml,Caddyfile} \
     root@101.79.11.189:/opt/momo/infra/rust/
   scp scripts/verify_ncp_centrifugo_boundary.sh \
     root@101.79.11.189:/opt/momo/scripts/
   ```
   `*.secrets.env`는 **절대 덮어쓰지 않는다** — 값의 정본은 서버다.
3. (서버) 태그 갱신 + 기동 — **파일 5개·env 3개 전부, 빠지면 안 된다**:
   ```bash
   cd /opt/momo/infra/rust
   cp smoke.secrets.env smoke.secrets.env.bak-$(date +%Y%m%d)
   sed -i "s/^MOMO_RUST_IMAGE=.*/MOMO_RUST_IMAGE=momo-rust:<새태그>/" smoke.secrets.env
   docker compose --env-file smoke.secrets.env --env-file push-relay.secrets.env \
     --env-file overlays.secrets.env \
     -f docker-compose.rust.yml -f docker-compose.push.yml -f t3.override.yml \
     -f caddy.override.yml -f cent-origin.override.yml up -d
   ```
   migrate는 one-shot으로 돌고 멱등이다(`[migrate] IDEMPOTENCY_OK` 확인). `web-init`도 one-shot이다 — `up -d`가 caddy보다 먼저 돌리고 종료 코드 0을 기다린다(`depends_on: service_completed_successfully`).

   > `overlays.secrets.env`가 없다면 `infra/rust/overlays.env.example`를 복사해 채운다. 빠뜨리면 **조용히 기동하지 않는다**: `docker compose config`가 exit 1로 죽으면서 빠진 변수 이름을 댄다(#1228 red proof).
4. 검증 (밖에서):
   ```bash
   curl -s -o /dev/null -w '%{http_code}' https://app.oor7.com/healthz            # 200
   curl -s -o /dev/null -w '%{http_code}' https://app.oor7.com/v1/workspaces/<ws>/approvals  # 401(=서빙), 404면 구 이미지
   curl -s -o /dev/null -w '%{http_code}' -X POST https://app.oor7.com/v1/centrifugo/subscribe  # 403(=공개 엣지에서 종료)
   # 배포된 웹이 어느 커밋인지 — 1번에서 넘긴 SHA와 같아야 한다 (#1228)
   curl -s https://app.oor7.com/ | grep -o 'name="momo-build" content="[^"]*"'
   # 보안 헤더 5종 (#1213). 아래 「Caddy 설정 배포」를 한 창에서는 이 줄이 수용기준이다.
   curl -sI https://app.oor7.com | grep -iE 'content-security|strict-transport|x-content-type|referrer|frame'
   ```
   + `docker ps`에서 momo-rust 4서비스(api·relay·agent-worker·notifier)가 **전부 새 태그**인지 — notifier는 push.yml 소속이라 파일을 빼먹으면 혼자 구 이미지로 남는다(2026-08-04 실증).
   + 이미지 자신에게 물어도 된다: `docker image inspect momo-rust:<태그> --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'`

## CENT_PROXY_SECRET 회전

`CENT_PROXY_SECRET`은 사용자 자격증명이 아니라 Centrifugo가 compose-private API
subscribe callback을 호출할 때 쓰는 공유 인증값이다. 그래도 **무중단 이중 키
기간은 없다**. API와 Centrifugo가 다른 값을 든 순간 모든 신규 구독이 401로
실패하므로, 둘을 같은 attended 창에서 함께 recreate하고 아래 verifier가 끝날
때까지 창을 닫지 않는다. 원문은 터미널 출력·이슈·PR·evidence에 붙이지 않는다.

아래 절차에서 `set +x`는 필수다. verifier는 env 파일과 두 컨테이너의 실행 환경을
읽지만 변경하지 않으며, 외부 요청에는 no-header/wrong/current를 각각 보내도
Caddy가 모두 403으로 끝내는지 확인한다. compose-private API에는 no/old/current를
보내 401/401/400인지 확인한다. current + 고의로 잘못된 JSON의 400은 **secret 인증을
통과한 뒤 body 검증에서 거절됐다는 증거**다. 마지막으로 host env · API env ·
Centrifugo static header 값의 SHA-256이 같은지 비교하고 hash만 기록한다.

`--edge-url`은 목적지를 신뢰하게 만드는 입력이 아니라 **정본과 같다는 주장**이다.
verifier는 자기와 함께 배포된 `/opt/momo/infra/rust/Caddyfile`의 단일 site label에서
`https://<site>`를 파생하고, 인자가 그 origin과 정확히 같지 않으면 env secret을
읽거나 Docker/curl을 실행하기 전에 종료한다. curlrc는 끄고 HTTPS만 허용하며
redirect는 0회라 3xx도 RED다. 따라서 오타·포트·userinfo·path/query/fragment 또는
다른 호스트로 현재 secret을 보내는 진단 명령으로 사용할 수 없다.

`--allow-http-local`은 회귀/격리 테스트 전용이다. env 파일의 `MOMO_ENV=test`,
프로세스의 exact `MOMO_NCP_TEST_TRUSTED_ORIGIN=http://127.0.0.1:<port>`, 그리고
`fixture-` synthetic secret을 모두 요구한다. production/staging env나 운영 secret은
이 escape를 활성화할 수 없으므로 NCP 호스트에서는 사용하지 않는다.

1. 서버에서 기존 env를 0600으로 백업하고 새 값을 **stdout 없이** 파일에 쓴다.
   env 파일은 컨테이너 bind mount가 아니므로 임시파일→replace가 안전하다.

   ```bash
   set +x
   umask 077
   cd /opt/momo/infra/rust
   stamp="$(date -u +%Y%m%dT%H%M%SZ)"
   old_env="smoke.secrets.env.before-cent-proxy-${stamp}"
   cp -p smoke.secrets.env "$old_env"

   new_secret="$(openssl rand -hex 32)"
   printf '%s\n' "$new_secret" | python3 -c '
import os, pathlib, sys
path = pathlib.Path(sys.argv[1])
secret = sys.stdin.readline().strip()
if not secret or any(ch.isspace() for ch in secret):
    raise SystemExit("generated secret has an invalid shape")
lines = path.read_text().splitlines(keepends=True)
hits = [i for i, line in enumerate(lines) if line.startswith("CENT_PROXY_SECRET=")]
if len(hits) != 1:
    raise SystemExit(f"expected exactly one CENT_PROXY_SECRET line, got {len(hits)}")
lines[hits[0]] = f"CENT_PROXY_SECRET={secret}\n"
tmp = path.with_name(path.name + ".rotate")
tmp.write_text("".join(lines))
os.chmod(tmp, 0o600)
os.replace(tmp, path)
' smoke.secrets.env
   unset new_secret
   chmod 600 smoke.secrets.env "$old_env"
   ```

2. **다섯 compose 파일·세 env 파일을 그대로 유지한 채** 렌더링을 먼저 확인하고,
   secret을 소비하는 `api`와 `centrifugo`만 같은 명령에서 recreate한다. 이 짧은
   창에는 신규 realtime 연결이 재시도될 수 있지만, DB/message/outbox는 바뀌지 않는다.

   ```bash
   docker compose --env-file smoke.secrets.env --env-file push-relay.secrets.env \
     --env-file overlays.secrets.env \
     -f docker-compose.rust.yml -f docker-compose.push.yml -f t3.override.yml \
     -f caddy.override.yml -f cent-origin.override.yml config >/dev/null

   docker compose --env-file smoke.secrets.env --env-file push-relay.secrets.env \
     --env-file overlays.secrets.env \
     -f docker-compose.rust.yml -f docker-compose.push.yml -f t3.override.yml \
     -f caddy.override.yml -f cent-origin.override.yml \
     up -d --no-deps --force-recreate api centrifugo
   ```

3. health 뒤 읽기 전용 verifier를 실행한다. 이 출력/JSON/Markdown에는 원문이 없고
   SHA-256 동일성과 403/401/400만 남는다. `--old-env-file`을 빼면 old-secret 자리에
   합성 invalid 값만 쓰므로, **회전 증거에는 반드시 백업 파일을 넘긴다**.

   ```bash
   curl -fsS https://app.oor7.com/healthz >/dev/null
   /opt/momo/scripts/verify_ncp_centrifugo_boundary.sh \
     --env-file /opt/momo/infra/rust/smoke.secrets.env \
     --old-env-file "/opt/momo/infra/rust/$old_env" \
     --edge-url https://app.oor7.com \
     --evidence-dir "/opt/momo/evidence/cent-proxy-${stamp}"
   ```

   PASS 뒤에도 백업은 즉시 지우지 않는다. 해당 배포 창 evidence와 직전 롤백 보존
   기간이 끝난 뒤 운영자 정책에 따라 회수한다. Git·이슈·PR에는 올리지 않는다.

### 회전 롤백

recreate 또는 verifier가 실패하면 새 env를 별도 0600 파일로 보존한 뒤 직전 env를
제자리 복원하고 **동일한 두 서비스**를 다시 recreate한다. 롤백 검증에서는 실패한
새 env가 `--old-env-file`이다. 즉, 이전 값으로 돌아온 API가 새 값을 401로 거절하는
것까지 확인한다.

```bash
set +x
cd /opt/momo/infra/rust
failed_env="smoke.secrets.env.failed-cent-proxy-${stamp}"
cp -p smoke.secrets.env "$failed_env"
cp -p "$old_env" smoke.secrets.env
chmod 600 smoke.secrets.env "$failed_env"

docker compose --env-file smoke.secrets.env --env-file push-relay.secrets.env \
  --env-file overlays.secrets.env \
  -f docker-compose.rust.yml -f docker-compose.push.yml -f t3.override.yml \
  -f caddy.override.yml -f cent-origin.override.yml \
  up -d --no-deps --force-recreate api centrifugo

/opt/momo/scripts/verify_ncp_centrifugo_boundary.sh \
  --env-file /opt/momo/infra/rust/smoke.secrets.env \
  --old-env-file "/opt/momo/infra/rust/$failed_env" \
  --edge-url https://app.oor7.com \
  --evidence-dir "/opt/momo/evidence/cent-proxy-rollback-${stamp}"
```

이 PR/goal 자체는 운영 secret 회전이나 NCP reload/recreate를 수행하지 않는다.
따라서 실제 `app.oor7.com`의 403·hash equality·old-secret 401 증거는 배포 전까지
`runtime-unverified(public host)`이며, 위 attended 절차가 그 미검증 범위를 닫는다.

## Caddy 설정(보안 헤더 포함) 배포

`infra/rust/Caddyfile`이 **레포 정본**이다(#1217). 이미지 태그와 무관하게 이 파일만 바뀌는 배포가 있고, 그때는 아래 세 단계가 전부다.

> #1228 이전에는 여기에 「웹 SPA와 헤더가 같은 배포 창에 묶이면 SPA를 먼저 올리고 헤더를 뒤에 올린다」는 줄이 있었다. **그 순서 규칙은 사라졌다** — SPA가 이미지 안으로 들어와 `up -d` 한 번에 함께 가므로, 새 정책이 옛 번들을 막는 구간을 사람이 손으로 피할 일이 없다. 반대로 Caddyfile만 바꾸는 창에서는 여전히 **정책이 현재 번들을 막지 않는지**가 수용기준이고, 그것을 레포에서 미리 재는 것이 `npm --prefix clients/web run gate:csp-deploy`다.

1. (로컬 → 서버) **덮어쓰기는 반드시 제자리에서.**
   ```bash
   # 워크트리에서 서버로. scp/cp 는 같은 inode에 쓴다.
   ssh root@101.79.11.189 'install -d -m 0755 /opt/momo/scripts'
   scp infra/rust/Caddyfile root@101.79.11.189:/opt/momo/infra/rust/Caddyfile
   scp scripts/verify_ncp_centrifugo_boundary.sh root@101.79.11.189:/opt/momo/scripts/
   ```
   > ⚠️ `caddy.override.yml`은 **파일 하나**를 `./Caddyfile:/etc/caddy/Caddyfile:ro`로 bind mount 한다. 디렉터리 마운트와 같은 함정이 파일 단위로 있다: `mv new Caddyfile`(rename)로 바꾸면 inode가 갈리고 컨테이너는 **옛 파일을 계속 본다**. `scp`·`cp`·`sed -i`는 제자리에 쓰므로 안전하고, 에디터의 「원자적 저장」(임시파일→rename)은 안전하지 않다.

2. (서버) 문법 검사 → reload. 컨테이너를 재생성하지 않으므로 연결이 끊기지 않는다.
   ```bash
   cd /opt/momo/infra/rust
   # 서비스 이름은 `caddy` 다 — 이제 레포의 infra/rust/caddy.override.yml 에서
   # 읽을 수 있다(#1228 이전에는 이 줄이 "override 파일에서 확인"이었다).
   docker compose --env-file smoke.secrets.env --env-file push-relay.secrets.env \
     --env-file overlays.secrets.env \
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

   `/v1/centrifugo/*`가 바뀐 창은 header 확인만으로 끝내지 않는다. 현재 env에 대한
   읽기 전용 경계 검증도 이어서 실행한다(회전이 아니라면 `--old-env-file`은 생략):
   ```bash
   /opt/momo/scripts/verify_ncp_centrifugo_boundary.sh \
     --env-file /opt/momo/infra/rust/smoke.secrets.env \
     --edge-url https://app.oor7.com \
     --evidence-dir /opt/momo/evidence/cent-proxy-caddy-reload
   ```

### HSTS 확장 일정

`max-age=86400`(1일)로 시작한다. 브라우저가 **기억하는** 헤더라 되돌리기가 서버 쪽에 없기 때문이다(헤더를 지워도 이미 받은 브라우저는 만료까지 평문 접속을 거부한다). 확장은 관찰 뒤에: 1일 무사고 → `604800`(1주) → 무사고 → `31536000`(1년) + 하위도메인이 생겼다면 그때 `includeSubDomains`를 함께 판단. **`preload`는 어느 단계에서도 붙이지 않는다** — 프리로드 목록 등재는 브라우저 소스에 박히고 제거에 수개월이 걸린다. `clients/web` 게이트(`npm --prefix clients/web run gate:csp-deploy`)가 `preload` 유무를 레포에서 막는다.

## 롤백

`smoke.secrets.env`의 태그를 직전 값(백업 파일 참조)으로 되돌리고 같은 up -d 한 번.

Caddyfile만 되돌릴 때는 레포의 직전 커밋 판을 같은 방식으로 덮어쓰고 reload 한 번. **단 HSTS는 롤백되지 않는다**: 헤더를 지워도 이미 그 헤더를 받은 브라우저는 max-age 동안 이 호스트를 HTTPS로만 연다. 그래서 첫 값이 1일이다.

## 디스크 위생

배포 전 `docker images | grep momo`로 사용 안 하는 옛 태그 제거(`docker image rm`). **직전 태그 하나는 롤백용으로 반드시 남긴다.**

## 웹(정적 SPA) 배포 — **별도 단계가 없다** (#1228)

SPA는 `${MOMO_RUST_IMAGE}` **안에** 있다. `caddy.override.yml`의 `web-init` one-shot이 이미지의 `/opt/momo/web`을 `web-static` named volume으로 복사하고, Caddy가 그 볼륨을 `/srv/web`으로 읽는다(`Caddyfile`의 `handle { root * /srv/web }` — 이 줄은 바뀌지 않았다. 바이트의 출처를 Caddyfile은 원래 몰랐다).

**따라서 배포는 위 「배포 절차」 하나뿐이다.** 태그를 바꾸면 API와 웹이 같이 간다.

- 로컬에서 웹 번들을 빌드해 tar로 올리는 절차는 **폐지됐다**. 그 절차가 만들던 것은 편의가 아니라 결함이었다: 웹과 API의 버전이 구조적으로 분리돼 한쪽만 배포된 상태가 기본값이었고, 라이브 번들이 어느 커밋인지 알 방법이 없었다(감사 B-6·B-10).
- 이 형태는 새로 만든 것이 아니라 **되찾은 것**이다 — Swift 경로의 `infra/prod/docker-compose.prod.yml`이 같은 `web-init` + named volume 구조를 갖고 있었고 Rust 경로가 그것을 잃었었다.

검증:
```bash
# 볼륨에 실제로 무엇이 들어갔나 (서버)
docker compose … logs web-init          # [momo] web-assets staged N files into /srv/web
# 밖에서 — 번들 해시와 커밋 스탬프
curl -s "https://app.oor7.com/?v=$(date +%s)" | grep -o 'index-[^"]*\.js'
curl -s "https://app.oor7.com/?v=$(date +%s)" | grep -o 'name="momo-build" content="[^"]*"'
```

### 롤백과 재기동

`web-init`의 복사는 **병합이 아니라 교체**다(`rm -rf /srv/web/*` → `cp -a`). 그래서 구 태그로 되돌리면 새 청크가 볼륨에 남아 옛 `index.html`을 오염시키는 상태가 생기지 않는다. 볼륨은 프로젝트 스코프라 `down -v`로 회수되고, 다음 `up -d`가 이미지에서 다시 채운다.

> ⚠️ **여전히 유효한 함정 — 단, 이제 `Caddyfile` 한 장에만 적용된다.** docker bind mount는 컨테이너 기동 시점의 **inode**를 잡는다. `caddy.override.yml`은 `./Caddyfile`을 **파일 단위**로 bind 하므로, rename으로 바꾸면(에디터의 「원자적 저장」, `mv`) 컨테이너는 옛 파일을 계속 본다. `scp`·`cp`·`sed -i`는 제자리에 쓰므로 안전하다. 웹 디렉터리는 named volume이 됐으므로 이 함정에서 벗어났다(2026-08-04에 밟았던 `mv web web.bak` 사고는 더 이상 재현 불가능하다).
