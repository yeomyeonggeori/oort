# ADR-0184: 플랫폼 중립·에이전트 주도 셀프호스팅 — 「이 플랫폼에 올려줘」 한 문장으로 설치·연동·시작

- Status: **Proposed** (기안 Fable 2026-09-09 · 성재 지시 「Railway뿐 아니라 Cloudflare·AWS 등 여러 플랫폼에서 가능하게, 에이전트가 브라우저 조작·로그인·발급·연동·호스팅까지 알아서」)
- Deciders: 성재
- Consumes: ADR-0121(배포판·온보딩) · ADR-0166(claim) · ADR-0167(same-origin) · ADR-0169(로컬 Drive) · ADR-0162(Agent Port) · ADR-0004(provider 경계) · 2026-09-02 두 기둥 브리프(SH-4/SH-5)
- 근거 조사: `docs/planning/research/2026-09-09-platform-neutral-selfhost-inventory.md`

## 문제
현행 설치 경로는 로컬·VPS·그록봇 VM·Railway(템플릿만, 실배포 0회)이며 Fly/AWS/GCP는 「VPS와 같음」 stub, Cloudflare 행은 없다. 에이전트가 플랫폼을 **조작**하는 수단(CLI·MCP·콘솔)은 레포에 배선된 것이 0이고, `SELF_HOST_AGENT.md` §0:36은 「셀렉터·원격 디버깅·스크립트 UI로 앱 조종 금지」를 벤더 채팅 앱 맥락 없이 일반문으로 적어 플랫폼 콘솔 자동화의 경계가 비어 있다. 관리형 플랫폼에서는 `scripts/oort backup/restore/upgrade`와 doctor `stack.*`가 컨테이너 exec 전제라 **동작하지 않는다**(조사 §5). 요구는 「사용자가 에이전트에게 플랫폼 이름만 말하면 로그인·발급·배포·연동·검증·핸드오프까지 끝난다」이다.

## 결정
### D1. 플랫폼 계층(tier) — compose를 돌릴 수 있는 곳이 1급
| Tier | 플랫폼 | 계약 |
|---|---|---|
| **T1 compose 컴퓨트** | 로컬 · VPS(Hetzner/DO/…) · **Fly.io(단일 VM+볼륨)** · **AWS Lightsail/EC2** · GCP VM · 그록봇 VM | 현행 compose 정본 그대로. doctor `stack.*`·day-2 CLI 전부 유효 |
| **T2 관리형 컨테이너+PG** | **Railway**(서비스 6+PG 플러그인, SH-5a) · AWS ECS/Fargate+RDS · Cloud Run+Cloud SQL | 이미지·엣지·env는 정본 파생, **day-2 계약 v2**(D4) 필요 |
| **T3 엣지 전용** | **Cloudflare**(DNS·Tunnel·TLS) | 컴퓨트 아님(Containers는 유휴 정지·영속 디스크 미문서 — PG·장수 WS 부적합). T1/T2 앞단으로만 편성 |
Cloudflare Containers·Workers를 컴퓨트로 쓰는 경로는 **채택하지 않는다**(재검토 조건: 영속 볼륨·상시 인스턴스가 문서화될 때).

### D2. 에이전트의 조작 수단 우선순위와 경계
1. **공식 CLI/MCP 우선** — Railway `railway setup agent`+원격 MCP(`mcp.railway.com`, OAuth) · AWS MCP servers(ECS)·`aws` CLI · `flyctl` · `gcloud` · `wrangler`(DNS/Tunnel). 자격은 **사용자 세션(로그인)** 을 재사용하고 토큰은 채팅·이슈·트리에 남기지 않는다(ADR-0004 동형).
2. **REST API + 사용자 제공 토큰** — CLI/MCP가 없는 플랫폼.
3. **브라우저 자동화는 최후 수단이며 「사람 승인 지점」에서만** — 회원가입·결제·DNS 위임·OAuth 동의처럼 API가 없는 단계. 에이전트는 그 지점에서 **멈추고 사용자에게 화면을 넘긴다**(대신 클릭하지 않는다). 이는 `SELF_HOST_AGENT.md` §0의 자동화 금지문을 「벤더 채팅 앱 조종 금지 + 플랫폼 콘솔은 승인 지점 규율」로 **개정**해 명문화한다.
4. 항상 사용자 본인 계정·본인 비용에서만(§0 불변).

### D3. 계약 하나, 레시피 N — `SELF_HOST_AGENT.md` §1 표의 행
각 플랫폼 행 = ①컴퓨트·PG 프로비저닝 ②env 파생(생성기 `--platform <name>`: `--railway`를 일반화, 정본 키 `oort_canonical_env_keys`에서만) ③불변 digest 배포 ④엣지(리버스 프록시 공개·api 내부·`/v1/centrifugo/*` 403 순서) ⑤`scripts/oort doctor --json` `public.*` PASS(+T1은 `stack.*`) ⑥day-2 계약(tier별) ⑦사람 승인 지점 목록. 하네스 불가지론 문면 규율(§0:11-12) 그대로 적용.

### D4. day-2 계약 v2(T2용)
`oort backup/restore`는 컨테이너 exec 대신 **네트워크 `MIGRATE_DATABASE_URL`로 pg_dump/pg_restore**(이미지에 클라이언트 동봉, 플랫폼 one-off job으로 실행), doctor `stack.outbox`·`stack.migrate_idempotency`는 SQL over URL + `/healthz` 하위 필드로 대체. `oort upgrade`는 플랫폼 CLI/MCP로 이미지 digest 교체 후 doctor PASS. 볼륨 검사(`oort_require_volumes`)는 T1 전용으로 분기.

### D5. 게이트
플랫폼 템플릿 시험(현재 `test_railway_template.sh`는 **미배선**)을 docs 프로파일에 배선 · `check_compose_env_templates.sh` 표에 플랫폼 행 · `gate:csp-deploy`(#2181)를 `caddy adapt` 렌더 기반으로 고쳐 엣지 파일 목록에 플랫폼 파일 포함 · 각 플랫폼 **1회 실측 E2E가 수용기준**(2026-09-02 브리프 SH-5 원칙 유지).

### D6. 수용 = 사용자 경험
README 프롬프트 1블록 → 에이전트가 환경을 묻고 플랫폼 이름을 받으면 → D2 수단으로 프로비저닝 → doctor PASS → 핸드오프(URL·claim·QR) → 첫 에이전트 합류까지. 사람 승인 지점은 플랫폼당 명시 목록으로 문서화하고 그 외 개입 0이 목표.

## 대안
- 「Railway 하나로 충분」: 성재 지시로 기각(다플랫폼).
- 「모든 플랫폼을 Terraform 단일 스택」: T2의 관리형 PG·엣지 차이와 에이전트 조작 수단(MCP/CLI) 차이가 커서 레시피 분리가 정직. Terraform은 AWS/GCP T1 VM 레시피 안에서만 최소 사용(09-02 브리프 그대로).
- 「브라우저 자동화로 전부 무인」: 결제·약관 동의를 에이전트가 대신 클릭하는 것은 사용자 책임·플랫폼 약관 위험 → 승인 지점 규율로 제한.

## 결과·후속(패킷 = SH-11 시리즈, 브리프 별도)
SH-11a Railway 에이전트 경로 1회 실측(`railway setup agent`+MCP, 성재 로그인 = 승인 지점) · SH-11b Fly T1 레시피(`fly.toml`+볼륨) · SH-11c AWS Lightsail/EC2 T1 레시피(+최소 Terraform) · SH-11d Cloudflare 엣지 레시피(VPS/T1 앞단 DNS·Tunnel) · SH-11e day-2 v2(T2) · SH-11f 게이트 배선(#2181 선행) · SH-11g §0 경계 개정 + 생성기 `--platform` 일반화. 순서: 11g·11f(문서·게이트) → 11a(Railway 실측) → 11b/11c → 11d → 11e.

## 결재 기록
- (대기) 성재 Accept.
