# 핸드오프 패킷 — #1213 보안 헤더 정책 + 게이트 라이브 확장 (W3)

> 발주: 2026-08-09 Fable 세션. 성재 결정 반영: **헤더는 미배포 랜딩분과 같은 배포 창에 묶는다** · **HSTS는 짧은 max-age로 시작**. 0단계(라이브 Caddyfile 레포 회수)는 #1217로 완료 — `infra/rust/Caddyfile`이 라이브 정본이다(서버 sha256 `5238f252…` 바이트 일치 회수).

## 0. 규율

- 작업 브랜치: `origin/track/engine` 기준, 워크트리 신설(`git worktree add ~/projects/momo-tracks/momo-worktrees/sechead-1213 -b fix/sechead-1213 origin/track/engine`).
- **배포는 하지 않는다** — 파일·게이트·런북·red proof까지. 배포는 오케스트레이터가 배포 창에서.
- PR(base=track/engine) 만들고 STOP. 머지 금지.
- 이슈 #1213 참조(Closes 쓰지 말 것 — 종결은 라이브 재실측 후 수동).

## 1. 산출물 4건

### T-A. `infra/rust/Caddyfile` 헤더 5종
- CSP · HSTS · X-Content-Type-Options `nosniff` · Referrer-Policy · 클릭재킹 방어(CSP `frame-ancestors 'none'` 채택 시 X-Frame-Options는 중복이니 선택 근거를 적을 것).
- **HSTS**: `max-age=86400`(1일)로 시작, `preload` 금지. `includeSubDomains`는 app.oor7.com의 하위도메인 실재 여부를 근거로 판단해 제안. 확장 일정(관찰 후 1주→장기)을 런북에 한 줄로.
- **CSP는 코드 실측으로 도출** — 각 지시어의 각 소스마다 근거(파일:줄)를 PR 본문 표로:
  - `connect-src`: REST/WS는 same-origin(`/v1/*`·`/connection/*` — Caddy 프록시)이지만 **'self'의 ws(s): 해석은 브라우저별로 다르다** — `wss://app.oor7.com` 명시 여부를 근거와 함께. **첨부 Drive 직접 PUT 호스트(googleapis) 반드시 실측 포함** — #1206에서 CSP가 첨부를 즉사시킨 전례. 업로드/다운로드/썸네일 경로가 쓰는 호스트를 클라 코드(`clients/web` 첨부 3축, `packages/momo-core`)에서 grep으로 확정할 것.
  - `img-src`·`style-src` 등도 현행 웹 번들 기준 실측(참고: `infra/prod/Caddyfile`의 기존 정책 — 단 그건 셀프호스트용, 복사가 아니라 검증 후 채택).
- 참고 결함: `gate-csp.mjs`(Tauri)·`gate-csp-deploy.mjs`(#1212) 기존 코드. 스타일은 라이브 파일의 현행 구조(handle 블록) 유지 — 최소 diff.

### T-B. `gate:csp-deploy`를 라이브 파일로 확장
- 현행: `clients/web/gates/gate-csp-deploy.mjs`가 `infra/prod/Caddyfile`만 읽는다 → **게이트가 지키는 파일 ≠ 라이브 파일** 결함.
- `infra/rust/Caddyfile`도 검사 대상에 추가(두 파일 모두). 검사 항목: 헤더 5종 존재 + CSP 필수 소스(googleapis 포함) + HSTS preload 부재.
- **red proof**: 라이브 파일에서 헤더 하나를 지우면 게이트가 빨강임을 증명(되돌리기 포함).

### T-C. 런북 갱신 (`docs/runbooks/ncp-rust-deploy.md`)
- Caddyfile이 레포 정본이 됐다 — 배포 절차에 「레포 `infra/rust/Caddyfile` → 서버 `/opt/momo/infra/rust/Caddyfile` 복사 + caddy 재기동(reload)」 단계 추가.
- 배포 후 검증에 **라이브 헤더 재실측** 추가: `curl -sI https://app.oor7.com | grep -iE 'content-security|strict-transport|x-content-type|referrer|frame'` — 5종 확인. 이것이 #1213 종결 수용기준.

### T-D. 검증
- `npm run gate:csp-deploy`(웹 워크스페이스) 초록 + red proof 기록.
- Caddyfile 문법: `docker run --rm -v <워크트리>/infra/rust/Caddyfile:/etc/caddy/Caddyfile:ro caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile` (docker 불가 환경이면 한계 고지).
- 웹 스위트는 무접촉이면 생략 가능, 게이트 파일을 건드리므로 `npm run preflight` 급 최소 확인.

## 2. 보고 규약

- 최종 보고 = PR 번호 + CSP 소스 근거표 요약 + red proof 결과 + (도출 과정에서 발견한) 정책이 깨뜨릴 수 있는 표면 목록.
- 중간 보고 없음. 완주 후 1회.
