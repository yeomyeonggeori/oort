# PLN-20260722-01 — 에이전트 온보딩 양문형 배치 (Wave B/C) 실행 정본

> 승인: 성재 2026-07-22 "wave B/C는 진행하고" (research/20-01 기안 승인). owner: momo-main(Fable).
> 근거 정본: `research/20-platform-agent-hosting/00·01`, ADR-0130(D4·D5 집행), ADR-0131(537 전 Accepted 필요 — Proposed 기안됨).
> 공통 함정: `2026-07-21-agent-native-fabric-batch.md` §4 전체(1~12) 상속 — worker 프롬프트에 §4 포함 필수. 포트 신규 대역 **28120대부터**(28100~28113 사용).

## Wave 편성
- **Wave B (담아오기, 엔진)**: MOMO-534(어댑터 2종) ∥ MOMO-536(에이전트 명부+URL 온보딩) → MOMO-535(outbound 이벤트 구독). 534와 536은 파일 영역 비중첩(examples/ vs server/) — 병렬 스폰.
- **Wave C (만들기)**: MOMO-537(agent_profile 원장+간편 생성 — **ADR-0131 Accepted 후 스폰**) → MOMO-538(동봉 eve 프로파일 — 534 랜딩 후).
- **필러(소형)**: MOMO-539(추출 워커 실패 백오프) — 슬롯 여유 시 우선 처리.
- UXUI 후속(⑫ 후보): 536의 관리자 "에이전트 추가(URL)" 화면 + 명부 UI — 엔진 랜딩 후 ENGINE_HANDOFF ready로 개방.

## §2. 티켓 계약·수용기준

### MOMO-534 (엔진) — eve/Cloudflare용 oort 채널 어댑터 레퍼런스 2종
- **Goal**: 외부 플랫폼-상주 에이전트가 oort gateway BYOA 계약을 소비해 oort 멤버로 대화하는 레퍼런스 어댑터. ADR-0130 D5의 집행. 오픈소스 공개물의 "5분 데모" 자산.
- **계약**:
  - `examples/eve-momo-channel/`: eve `defineChannel` 커스텀 채널(TS) — oort 인바운드(gateway pending 폴링 또는 웹훅 수신)→eve `send()`→응답을 oort REST(gateway message/callback)로. continuationToken=oort 채널/스레드 키. 인증은 per-agent bearer(기존 gateway credential — ADR-0004: 자격증명은 env 주입, 코드/로그 비유입).
  - `examples/cloudflare-agent-momo/`: CF Agents SDK 클래스 동형 예제(fetch/WS 기반).
  - 코어 서버 수정 0. 계약 소비만. README에 아키텍처 다이어그램+환경변수 표+한계(승인 카드 왕복은 oort 앱에서) 명기.
  - 검증 하네스: `scripts/verify_momo_channel_adapter.sh` — e2e 스택 기동 후 node로 eve 채널 어댑터 핵심 로직(폴링→메시지 게시→완료 콜백)을 mock eve 런타임으로 구동해 gateway 계약 왕복 단정. eve 실런타임 설치는 runtime-unverified 허용(MOMO-230 문법).
- **함정**: eve는 beta(주간 릴리스) — 어댑터는 eve API 표면 최소 사용, 버전 고정 명시. npm 의존은 예제 디렉터리 안에 격리(루트 오염 금지).
- **수용기준**: [ ] 어댑터 2종+README [ ] verifier PASS(gateway 왕복) [ ] 코어 diff 0 [ ] 시크릿/자격증명 코드 비유입

### MOMO-536 (엔진) — 에이전트 명부 + A2A 카드 URL 온보딩 (ADR-0130 D4 집행)
- **Goal**: 관리자가 URL 하나로 원격 에이전트를 워크스페이스 멤버로 등록. `/.well-known/agent-card.json` 판독→능력/인증 요약→동의→agent member 생성+gateway credential 발급.
- **계약**:
  - `POST /v1/workspaces/:ws/agents/from-card {url}` (admin): 서버가 카드 fetch(**SSRF 가드 필수** — 사설대역/링크로컬 차단, 리다이렉트 제한, 타임아웃, 응답 크기 상한)→A2A AgentCard 파싱(name/description/capabilities/auth)→`agent_card_registration` 원장(RLS FORCE) 저장, status=pending_consent.
  - `POST .../agents/from-card/:id/confirm`: agent member 생성(kind=agent, ADR-0004 준수 — 카드의 자격증명 요구는 저장하지 않고 표시만)+gateway per-agent bearer 발급(기존 credential 기계장치 재사용)+audit.
  - 카드 파싱은 A2A v0.3 스펙 필드 최소 집합(name, description, url, capabilities, securitySchemes 요약). 미지 필드는 raw jsonb 보존.
  - openapi.yaml 동시 갱신. 명부 조회는 기존 agent 목록 API에 `origin: card|local` 투영 가산.
- **함정**: outbound fetch는 서버 최초의 사용자 제어 URL 요청 — SSRF 가드를 서버 유닛 테스트로 단정(사설 IP·redirect 케이스). 카드 fetch 실패는 fail-closed(등록 없음).
- **수용기준**: [ ] from-card→confirm 왕복 [ ] SSRF 가드 테스트 [ ] `verify_agent_card_onboarding.sh` PASS(mock 카드 서버 python) [ ] RLS·audit

### MOMO-535 (엔진) — outbound 이벤트 구독 (웹훅형 양방향화)
- **Goal**: 워크스페이스 이벤트(멘션·승인요청·work 상태 전이)를 외부 URL로 서명 발송하는 구독 원장 — n8n/Zapier/Dify가 oort를 트리거로.
- **계약**: `event_subscription(workspace_id, url, secret_ref, event_kinds[], enabled, created_by, audit)` + 관리자 CRUD. 발송은 **outbox 문법 재사용**(신규 outbox kind=`webhook_delivery`, relay가 HMAC-SHA256 서명 헤더로 POST, 재시도/백오프, 5xx 누적 시 자동 disable+audit). 시크릿은 해시/암호화 저장(평문 조회 API 없음). SSRF 가드 536과 공용 유틸.
- **수용기준**: [ ] CRUD+RLS [ ] 이벤트→서명 POST 왕복(mock 수신기 python) [ ] 재시도·자동 disable [ ] `verify_event_subscription.sh` PASS

### MOMO-537 (엔진, ADR-0131 Accepted 후) — agent_profile 원장 + 간편 생성
- **Goal**: 에이전트별 인격(instructions)·모델 선호·활성 도구·트리거를 원장으로 — 정의=PG 행, 실행=기존 AgentWorker/Context Packet(**신규 상주 프로세스 0**).
- **계약**: `agent_profile(agent_member_id, instructions, model_pref, enabled_tools jsonb, triggers jsonb, version, audit)`+CRUD(admin)+Context Packet 조립 시 system_prompt/도구 필터에 주입(528 경로 가산, 기존 필드 불변). 상세는 ADR-0131.
- **수용기준**: ADR-0131 Accepted 후 확정. [ ] profile 주입 packet 반영 [ ] verifier PASS

### MOMO-538 (엔진·인프라, 534 후) — 셀프호스트 compose에 eve 옵션 동봉
- **Goal**: `docker compose --profile eve`로 eve 런타임 1컨테이너(버전 고정)+oort 채널 프리셋 기동 — "oort 설치=커스텀 에이전트 빌드 환경 포함".
- **계약**: compose 3종 중 dev/prod에 옵션 프로파일(기본 오프), eve 이미지/버전 고정, Postgres world는 oort PG의 별도 DB, 534 어댑터 프리셋 마운트. drift guard 갱신(§4-4). 문서: RUN.md 절 추가.
- **수용기준**: [ ] --profile eve 기동/미기동 무영향 [ ] verifier(compose config+기동 스모크) [ ] RUN.md

### MOMO-539 (엔진, 소형) — 추출 워커 실패 백오프+포이즌 배치 격리
- **Goal**: memory extraction/embedding 배치 실패 시 지수 백오프(상한 5분)+동일 배치 N회 연속 실패 시 워터마크 전진(스킵)+`memory.extraction.failed` audit 1회 기록. 핫루프 제거(2026-07-22 실측: 비-JSON 응답에 초당 수회 재시도).
- **수용기준**: [ ] 백오프 유닛 테스트 [ ] 포이즌 배치 스킵+audit [ ] 기존 verify_memory_plane 회귀

## §3. 실행 규율
- worker: PR(base track/engine) 후 정지, merge/close 금지, `schema_v0.sql` 불변, 계획 이탈은 PR 섹션. docker/e2e 게이트=오케스트레이터.
- 마이그레이션 번호: **032부터**(031=github manifest). 스폰 시 진행 중 PR 번호 확인.
- 병렬 최대 5. 534∥536 동시, 이후 535·539, 537은 ADR 게이트, 538은 534 랜딩 후.
