# 워커 브리프 — SH-2 공개 엣지 파라미터화: 사이트 주소·CSP connect-src env 템플릿 + ACME 오발사 차단 (engine · #1926 · ADR 불요)

> 워커: grok 4.6 · base=origin/track/engine · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. `.github/**` 무접촉. `scripts/self_host_env.sh` 수정과 `scripts/tests/` 신규 파일은 **정책 무결성 감사 대상**(오케스트레이터가 승격 시 감사) — 그 밖의 `scripts/**` 무수정. 시크릿 커밋 금지. compose 스택은 **로컬에서만** 기동(공개 호스트 접속 없음 — ACME 실주문 0).
> 근거: 편성 정본 §5 SH-2 · #1926(감사 축 2 결손 3·4: `infra/rust/Caddyfile`은 첫 줄에서 은퇴 선언 + `app.oor7.com` 하드코딩 → 따라하면 남의 도메인 앞으로 ACME 주문 [2026-08-10 실측 4건, #1239] · `Caddyfile.local:57` connect-src에 외부 호스트 0, `--public-origin`은 `CENTRIFUGO_ALLOWED_ORIGINS`·드라이브 base URL만 갱신하고 CSP를 템플릿하는 코드가 레포에 0건) · #1792 「운영자가 선언한 오리진만 Caddy env 보간으로 주입, **와일드카드 금지**」 · #1300 종결 코멘트 잔여(「`Caddyfile.local`엔 `/v1/centrifugo/*` deny가 없다 — 공개 엣지 티켓에서」). 재료: `infra/rust/Caddyfile`(운영 라우팅 + 보안 헤더 5종, #1213/#1217) · `infra/rust/Caddyfile.local`(루프백 쌍둥이) · `infra/rust/caddy.override.yml`(엣지 오버레이, web-init 볼륨) · `scripts/self_host_env.sh`(`--public-origin`, `PUBLIC_ORIGINS` 배열, `MOMO_CORS_ALLOWED_ORIGINS` 규칙) · 게이트 3본 `scripts/verify_ncp_centrifugo_contract.sh`·`scripts/tests/test_ncp_centrifugo_boundary.sh`·`scripts/verify_web_serving.sh`(deny 존재·순서·실 403).

## 구현 계약
1. **공개 엣지 템플릿 하나**: `infra/rust/Caddyfile`을 하드코딩 없는 템플릿으로 바꾼다 — 사이트 블록 `{$OORT_SITE_ADDRESS}`, CSP connect-src `{$OORT_CSP_CONNECT_SRC}`(Caddy env 보간). 은퇴 배너 삭제, 첫 줄 주석은 「env 미설정 시 기동 거부」를 말한다. `caddy.override.yml`이 두 env를 env 파일에서 컨테이너로 넘긴다. **env가 비어 있으면 caddy가 뜨지 않는다**(`OORT_SITE_ADDRESS` 부재 → 기본값 없음 → `caddy validate` 실패) — 이것이 ACME 오발사 차단의 실체다. `Caddyfile.local`은 루프백 전용 그대로(사이트 주소 `:80`).
2. **생성기 연동**: `scripts/self_host_env.sh --public-origin https://host`가 같은 호출에서 `OORT_SITE_ADDRESS=host`와 `OORT_CSP_CONNECT_SRC="'self' https://host wss://host https://www.googleapis.com"`(+ `MOMO_LIVEKIT_*` 엔드포인트가 env에 있으면 그 오리진)를 **파생해** 쓴다 — 손으로 적는 키가 아니다. `--public-origin` 없이 돌리면 두 키를 쓰지 않고(=로컬 경로 무변화), 기존 `CENTRIFUGO_ALLOWED_ORIGINS`·드라이브 base URL 규칙은 그대로. **와일드카드 거부**: 오리진에 `*`가 있으면 `fail`(#1792 규율, 수용기준에 명문).
3. **심층방어 정합**: `Caddyfile.local`의 `/v1/*` 앞에 `handle /v1/centrifugo/* { respond 403 }`(운영 파일과 같은 순서). 게이트 3본이 두 파일 모두를 검사하도록 **픽스처만** 넓힌다(게이트 스크립트 본체 무수정 — 못 넓히면 NOTES).
4. **문서**: `README.md` Self-host 절의 「Production … deploy runbook(ncp-rust-deploy.md)」 링크 → `docs/SELF_HOST.md`의 새 절 「공개 오리진으로 열기(엣지 env 2키 + `--public-origin`)」로 교체. `docs/runbooks/ncp-rust-deploy.md`는 삭제하지 않고 머리에 은퇴 배너 + 새 절 링크. `docs/SELF_HOST.md` §막히면에 「ACME 주문이 보인다 = `OORT_SITE_ADDRESS`가 남의 호스트」 1행. (영문화는 SH-4a/4b.)

## red proof (선행 커밋)
- `scripts/tests/test_public_edge.sh`(bats 있으면 bats): ①픽스처 env로 `docker run --rm caddy:2 caddy adapt --config Caddyfile --adapter caddyfile`(env 주입) → 산출 JSON의 사이트 호스트 == 픽스처 호스트, CSP connect-src에 그 오리진과 wss 쌍둥이 포함, `app.oor7.com` 0건 ②env 미설정 → adapt/validate **실패**(기동 거부) ③`--public-origin 'https://*.example.com'` → 생성기 fail ④`--public-origin` 없이 생성한 env에 두 키 없음(로컬 무변화) ⑤레포 전역 grep `app.oor7.com` = 은퇴 배너·아카이브 문서 외 0건.
- 게이트 3본 초록(로컬 스택 기동 후 `verify_web_serving.sh` 실 403 포함).

## 완료 절차
`bash -n`·shellcheck(있으면)·자체 테스트 그린 → 로컬 스택(`Caddyfile.local` 경로)에서 `scripts/oort doctor --json` PASS + 게이트 3본 실측 → 공개 템플릿은 `caddy adapt`까지만(실호스트 기동 금지) → 커밋(RED 선행) → `git push -u origin feat/sh2-public-edge` → `gh pr create --base track/engine` → 정지. PR 본문: 한 일 / 검증(원문) / Red proofs / STATUS 영향 / 계획 이탈 / 남은 것(SH-5a Railway에서 이 env 2키를 소비한다는 인계).

## 규율
env 키 이름은 생성기·템플릿·문서 세 곳이 한 정본(`self_host_env.sh`의 키 목록 함수)에서 파생. 시크릿·실호스트 값 커밋 금지. 막히면 우회 말고 보고 후 정지.
