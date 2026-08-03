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
   ```
   + `docker ps`에서 momo-rust 4서비스(api·relay·agent-worker·notifier)가 **전부 새 태그**인지 — notifier는 push.yml 소속이라 파일을 빼먹으면 혼자 구 이미지로 남는다(2026-08-04 실증).

## 롤백

`smoke.secrets.env`의 태그를 직전 값(백업 파일 참조)으로 되돌리고 같은 up -d 한 번.

## 디스크 위생

배포 전 `docker images | grep momo`로 사용 안 하는 옛 태그 제거(`docker image rm`). **직전 태그 하나는 롤백용으로 반드시 남긴다.**
