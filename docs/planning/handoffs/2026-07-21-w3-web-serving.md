# W-3 핸드오프: Caddy APP_DOMAIN 서빙 — "서버 URL이 곧 웹 주소" 완성 (ADR-0119 D1)

> 발급: 2026-07-21 Fable (성재 지시 "W-3 진행"). 정본: ADR-0119 D1-A(같은 오리진 1-site) — W-2(clients/web)는 main 랜딩됨.
> 트랙: 엔진/인프라 · base = main · PR base = track/engine · 도메인 = infra(+scripts/docs). **서버 Swift 코드 수정 금지.** verifier 포트 밴드 **28070~28074**.

## 목표
셀프호스터가 oort를 설치하면 브라우저로 `https://momo.example.com`에 접속해 바로 쓰는 상태. Caddy가 SPA를 서빙하고 같은 오리진에서 `/v1/*`를 api로 프록시 — CORS 불요(0119 D1-A).

## 구현 범위
1. **prod Caddyfile — `{$APP_DOMAIN}` site 추가**(기존 `{$API_DOMAIN}`/`{$REALTIME_DOMAIN}` 유지):
   - `/v1/centrifugo/*` → 403(기존 엣지 규칙 동일 적용, 프록시보다 먼저).
   - `/v1/*`·`/health` → api 컨테이너 reverse_proxy.
   - `/i/*` → LinkShort(기존 단축링크 서비스가 prod compose에 있으면 프록시, 없으면 이번 범위 밖 — 주석만).
   - 나머지 → SPA 정적 서빙(`root /srv/momo-web` + `try_files {path} /index.html` — SPA 라우팅 폴백).
   - 보안 헤더: 기존 site와 동일(HSTS 등) + **CSP**: `default-src 'self'; connect-src 'self' wss://{$REALTIME_DOMAIN} https://{$REALTIME_DOMAIN}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`(0119 D3 — 자체 오리진, inline script 금지. Vite 산출물이 inline script를 요구하면 해시 기반으로 — 실측 후 STATUS 명기).
2. **웹 빌드 산출물 배포 경로**: `infra/prod/Dockerfile.web`(node build 스테이지 → `dist`만 산출) + prod compose에 web-static 볼륨/이미지 전략 — **권고: 멀티스테이지로 dist를 caddy 이미지에 굽지 말고, `momo-web` 이미지가 dist를 named volume에 복사하는 init 컨테이너 패턴**(기존 migrate one-shot 문법 재사용, 이미지 digest 고정 규율 유지). install.sh/upgrade.sh가 기대하는 이미지 목록에 web 추가(docs/DEPLOY.md 갱신).
3. **e2e 검증 표면**: infra/docker-compose.e2e.yml에 opt-in `web` 프로파일(caddy + web-init) — verifier가 로컬에서 서빙+프록시를 검증할 수 있게. HTTPS는 e2e에서 내부 CA 부담이 크므로 **e2e는 :80 HTTP로 서빙 로직만 검증**(prod TLS는 Caddy 자동 — 검증 범위 밖 명기).
4. **verifier `verify_web_serving.sh`**(신규, 28070~28074): compose web 프로파일 기동 → ①`/` 200 + index.html(momo 마커) ②`/some/spa/route` 200(폴백) ③`/v1/auth/login` POST가 api로 프록시(401/400 응답 확인 — 200 불요) ④`/v1/centrifugo/subscribe` 403 ⑤보안 헤더 존재(CSP·X-Frame-Options) ⑥`/health` 200. runtime-db 아닌 **infra 프로파일**로 local_gate 등재.

## 하드 경계
- 서버/스키마/클라 코드 무변경(웹 빌드 설정 조정은 clients/web/vite.config 허용 — base path 등 최소). ADR-0002 compose 레이어 경계 준수. 시크릿·도메인 실값 커밋 금지(placeholder).
- **선례 함정 준수**: verifier bash 3.2 호환(빈 배열 `${arr[@]+...}`)·포트 사전검사·컨테이너 내 curl 금지(호스트 curl로 :28070 검증 — 이 게이트는 호스트에서 직접 가능)·인라인 psql 불요.

## 수용 기준
- verifier 6단정 구현(실행은 오케스트레이터 — worker는 정적/문법까지). caddy validate(`caddy validate --config` — docker run으로도 가능하나 worker는 금지, 문법 자가검토까지). npm build 재현(`clients/web` 기존 게이트). DEPLOY.md·RUN.md 갱신.

## 규율
- 커밋 자주. PR 후 멈춤(base=track/engine). merge/close·docker 금지(게이트=오케스트레이터). LOCAL_PR_GATE.md에 web-serving 프로파일 초안 추가.
