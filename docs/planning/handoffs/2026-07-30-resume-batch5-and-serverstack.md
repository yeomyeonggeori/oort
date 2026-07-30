# 재개 세팅 — 2026-07-30 (배치 5 완료 + 서버 스택 재검토 지점)

> **이 문서 하나로 재개한다.** compaction 후에도 여기부터. 워커 모델 = **Opus 5**(effort 핀 없음).
> 병렬 실행 = **Workflow**(`/workflows` 관전) 또는 **이름 없는 백그라운드 서브에이전트**. `name:` 준 팀메이트 금지(성재 지시).

## 0. 지금 상태 한 줄

**배치 1~5 전부 랜딩·main 반영 완료**(main=engine=uxui=`39e45765`). 실작업 PR 0건(열린 PR은 dependabot뿐). **진행 중 작업 없음.** 성재가 **서버 스택 재검토(Swift→?)**를 P0 방향 결정으로 올렸고, 리서치·판단 완료 → **성재 결정 대기**.

## 1. 서버 스택 — **확정 (2026-07-30 성재 B안 승인)**: Rust/Axum 재작성, buzz는 레퍼런스, 설계부터

**성재 결정 체인**: A안(fork) 선택 → 선행 스파이크가 fork 불성립 판정 → **B안(참조 재작성) 승인 + provenance 서명 차용 포함 + "설계부터 시작"**.

**확정 상태**:
- **ADR-0145 Accepted** — Swift/Hummingbird → Rust/Axum **재작성**, buzz는 fork 아니라 **코드 레퍼런스**, momo 불변식 6개 보존.
- **ADR-0146 Proposed** — 에이전트 행동 provenance 서명(buzz 강점 조각 차용, Ed25519 additive, 단일쓰기경로·RLS 무손상). D3에서 확정.
- **실행 정본 = `docs/planning/2026-07-30-server-rewrite-plan.md`** — 설계-우선. Phase 0 산출물 D1~D6 확정 → 구현 배치 B1~B5.

**저위험 핵심**: 불변식은 DB에 산다(59 마이그레이션, 44/59 강제) → 마이그레이션 언어독립·그대로 재사용 → 재작성 = "불변식 재구현"이 아니라 "앱 계층(52 route·workd·NotifierWorker ≈ 51k Swift)을 동일 스키마 위에 Rust로". 동일 DB·게이트 픽스처 = conformance oracle.

**Phase 0 설계 6/6 완료** (기획 레이어 직접 작성, 성재 최종 승인 대기):
- **D1** `docs/architecture/server-rust.md` — crate 레이아웃 **확정**(공유 5: db·outbox·wire·auth·provider / 도메인 3 굵게: messaging·t3·integrations / 바이너리 5). 성재 승인: 공유 인프라 별도 crate + 도메인 굵게 출발(모듈 승격선).
- **D2** `docs/architecture/invariants-in-rust.md` — 하드 불변식 7개 × [Rust 강제·DB 백스톱·되돌리면 실패 red]. 논리: 불변식은 DB(재사용), 앱은 우회 불가 배선+red 증명.
- **D3** ADR-0146 — provenance 서명 **범위 확정(성재: "상태 전이까지 넓게")**: 3표면(메시지·workd 이벤트·상태 전이), 사이드카 `action_signature`, `record_provenance` chokepoint, 불변식 무손상. 세부 페이로드·device 키 시점·UX는 상세 후 성재 최종 Accept.
- **D4** `buzz-reference-catalog.md` · **D5** `cutover-and-parity.md`(**빅뱅 확정**) · **D6** `rewrite-batch-breakdown.md`(**B0 골격** + B1~B5, provenance 분산).
- **B0 랜딩 완료**(track/engine `d1e51ddf`, PR #927 머지). `server-rust/` Cargo 워크스페이스 + 공유 5 crate. **오케스트레이터 docker 게이트 통과**(conformance `momo-db/tests/conformance_pg.rs`, #[ignore]): 마이그레이션 러너가 psql로 001~059 전부 fresh pgvector/pg18에 적용(FORCE-RLS 73), `with_tenant_tx` GUC 바인딩 확인. 무회귀 fmt/clippy/test green.
  - **게이트가 잡은 결함(수정됨)**: 러너 초안이 `sqlx::raw_sql`(서버 직송)이라 시드 마이그레이션(002/006/012)의 psql `\if :MOMO_AGENT_SEED_ENABLED` 조건부에서 42601 실패 → **psql shell-out**(migrate.sh 방식, `-v MOMO_AGENT_SEED_ENABLED`)으로 전환해 green. **B1+ 러너는 psql 경유가 정본**(sqlx::raw_sql 금지).
  - **B1 후속 노트**: `momo-outbox`의 `OutboxKind` enum이 `push_candidate`(011) 누락 — notifier/push 이식 시 추가.
  - **B1(메신저 코어) 랜딩 완료**(track/engine `2cc97bb4`, PR #928). `momo-messaging` crate — write-path 척추(identity·channel·message: seq row-lock CTE·emit_outbox 같은 tx·멱등, Swift MessageRoutes 파리티). **오케스트레이터 conformance 게이트 5/5 통과**(fresh pgvector/pg18+bootstrap_roles+momo_app): D2 red #1 SoT·#3 원자성·#4 gapless seq(동시 12)·#5 에이전트=member·#6 RLS cross-tenant. 무회귀 green.
    - **게이트가 잡은 것(테스트 오라클 수정)**: message insert가 011 `push_candidate_enqueue_trg`를 발화(정상·Swift 동일) → 채널당 outbox = broadcast(앱)+push_candidate(트리거). 테스트가 kind 미필터로 이중 계수 → `kind='broadcast'` 필터로 수정(코드는 정확). **relay=broadcast 소비, NotifierWorker=push_candidate 소비** — B1.2/relay/notifier 이식 시 유의.
    - **B1.5(momo-server 조립+momo-relay) 랜딩 완료**(track/engine `c98b6474`, PR #929). **첫 부팅 가능한 Rust 스택**: `bins/momo-server`(Axum: JWT 미들웨어+login/messages route, Swift 경로·401 문자열 파리티)+`bins/momo-relay`(claim SKIP LOCKED·백오프·LISTEN·Centrifugo publish, broadcast만). **게이트 전부 green**(relay 3/3: #2 e2e·경합·백오프 / HTTP smoke: login→send→list→401·403). D2 #1~#6 전부 실행 스택에서 증명(잔여 #7=B2).
      - **revocation 후속 수정 포함**(f55de1e5): 워커 자기신고 보안 갭 → 같은 PR에서 fail-closed 이식. `momo-auth/token_store.rs`가 `token` SQL 단독 소유(pgcrypto digest sha256·tenant tx 안 조회 — Swift withTenantConnection=withTenantTransaction 실측). revoke→401 red 케이스 포함.
      - **병렬 배치 진행 중(성재 "B2+소품 병렬")**: **B2.1**(T3 수명주기+과금 척추 — `momo-t3` 신설: with_t3_lifecycle_tx advisory·t3_terminate 호출만·mock provider 2종·#7 red·conformance 5종. 워크트리 `B21-t3-lifecycle`) ∥ **B1.6 랜딩 완료**(track/engine `b5264a00`, PR #930): logout/refresh route(원자 revoke 게이트·구 토큰 401 red)+러너 schema_migrations 멱등(2-run red — 공유 DB 모드 개방)+OutboxKind push_candidate. **게이트 전부 green, 한 DB 연속 실행으로 실증**. 게이트가 잡은 것: 공유 DB에서 relay 테스트가 타 스위트 잔여 pending broadcast를 claim(격리 갭) → 하니스에 잔여 정산 추가(오염 DB 3/3 재현). B1.6 워커 이탈 기록: audit_log 미이식(write_audit 스텁 잔존 — 후속 티켓 후보)·refresh privileged 재검증은 fail-closed 좁은 쪽.
      - **B2.1 랜딩 완료**(track/engine `f0467c02`, PR #931): `momo-t3`(lifecycle·billing·provider mock 2종+BYOC). t3_terminate 호출 1곳·앱 정산 SQL 0·전이표 사본 0·`with_tenant_tx_prelude`(advisory 선획득, GUC 단일배선 보존). **conformance 5/5**(정산 단일문+봉인·전이표·advisory 직렬화·이중정산 멱등·**#7 비유입**) → **D2 불변식 7/7 전부 Rust 스택에서 증명 완료.** 게이트가 잡은 것: 픽스처 provider_sandbox_id UNIQUE 충돌(리터럴 시드) → uuid 접미사 수정.
      - **머지 후 통합 검증**: engine에서 한 DB 연속 실행 — db 3/3·messaging 5/5·smoke 2/2·relay 3/3·t3 5/5 + 단위 26 스위트 all green.
      - **ADR-0140 정오표 대기(성재 승인)**: ADR:107 "t3_terminate가 outbox 이벤트까지 한 tx에" — 053/058 실측엔 outbox 없음(브로드캐스트는 route층 emit_outbox 몫). 실측을 정본으로 ADR 문구 정정 필요.
      - **B1.7(Rust 이미지+compose) 랜딩 완료**(track/engine `a7c3551e`, PR #932). 이미지 259MB(멀티스테이지·비루트·`--locked`), `infra/rust/` compose(janitor 라벨·루프백 온리·api에 CENT 자격 미주입=#2 자세·별도 볼륨). **오케스트레이터 실전 게이트 전 곡선 green**: build→기동→migrate 59+IDEMPOTENCY_OK→set-owner→login→send(seq=1)→list→**실 Centrifugo history version==seq**→outbox done→로그 시크릿 0→down -v.
        - 게이트 실측 결함 2건(오케스트레이터 수정): ①cargo mtime 캐시 — 스텁 의존캐시 후 COPY 실소스가 재빌드 안 일으켜 빈 rlib 재사용(E0432) → 빌드 전 touch ②`compose run migrate set-owner`가 command: 대체 → entrypoint에 set-owner 케이스. **둘 다 워커가 docker 못 돌려 원리적으로 못 잡는 계층** — 파이프라인 교훈 재확인.
        - **NCP 런북 §1 트리거 3번 개통**: 이미지 빌드 경로 완성. 남은 것=레지스트리 퍼블리시(성재/오케스트레이터) 또는 `docker save/load`. §3 절차의 Rust 스왑판 준비 완료(`infra/rust/README.md` §6 대응표).
      - **B2.2(T3 REST 표면) 랜딩 완료**(track/engine `9e065d0f`, PR #933). route 12개(work-hosts 등록·목록·revoke·heartbeat/BYOC enrollments·cloud register·provision/work-sessions create·end·resume·list/credits topup) — raw SQL 0, `T3Settings` 기본 OFF(미설정 시 503). **T3 smoke 곡선 게이트 2/2 + 전 스위트 공유 DB 무회귀 green.** red=세션 생존 중 settled_at 직접 UPDATE→053 봉인 트리거 23514 거부.
        - **워커 실측이 패킷 가정 3건 뒤집음(전부 검증 후 수용)**: ①usage/summary 제외 — usage_ledger(모델·토큰 과금)만 집계, t3_terminate는 work_host_usage+credit_entry에 씀(045:4 "의도적 미확장") → T3 과금을 구조적으로 못 보여줌, LLM-run 배치로 이관 ②smoke provider=byoc(mock-a는 momo-server에 outbound HTTP 필요 → #2 금지) ③topup 포함 — 잔액 검사는 BYOC 등록의 reserveProvisioningSlot에서 fail-closed, 워크스페이스 잔액 0 시작.
        - **NCP T3 부분 smoke 열림**: BYOC 등록→세션→과금→종료 REST 완비. 필요물 = linux/amd64 크로스빌드(+퍼블리시 or save/load) + 성재 트리거.
        - 잔여(B2.3+): AgentGateway·terminal·tier·pool·approval·재부착 0139·reconciliation·work-host 서명 경로 3종(pending-controls·live-sessions·reconcile). audit_log 티켓 후보 지속.
      - **성재 문답 기록(2026-07-31)**: ①워커 docker 불가 = 동의 경계(Option A: workspace-write+network만, docker 소켓=호스트 루트 상당이라 밖) + 병렬 데몬 충돌·자원 누적 전례 + 결과적으로 오케스트레이터 게이트가 품질 장치 — 유지 권고. ②NCP smoke의 목적 = 배포 리허설(D5 예행)·환경 갭 실측(**arm64 Mac→linux/amd64 크로스빌드 필요**·저사양 리소스)·실환경 왕복·T3 smoke 발판(B2.2 후 BYOC→세션→과금→종료 → MOMO_T3_ENABLED 판단). 성재: "NCP smoke 하는 건 상관없다"(시점은 미지정).
    - **NCP: 성재 지시(2026-07-30) — 여유 있으니 현상 유지**(정지 안 함). 키 재발급도 보류.
- 병행: NCP smoke는 서버 스택과 독립(§2) — 현행 Swift 이미지로 진행 가능.

**성재 결정 대기 지점**: ADR-0146 세부(서명 페이로드 바이트·사람 device 키 배선 시점 B1내/fast-follow·"서명됨" UX 표식) 확정 후 Accept 승격 — B1 전까지. (Phase 0 전체 승인은 완료: "B0 착수해줘".)

**스파이크 판정(기록됨, ADR-0145)**: buzz ↔ momo는 스택 표면만 1:1, 정합성·격리 코어는 정반대. 불변식 3개(단일쓰기경로·gapless seq·RLS FORCE)가 buzz Nostr 코어(클라-서명-publish·created_at·RLS 전무)와 정면 충돌. 둘 다 "relay=SoT"는 같음(차이는 저자·순서·격리강제). 곡선 정정: buzz=secp256k1 Schnorr, momo=Ed25519. buzz clone: scratchpad/buzz.

정본(판단 근거): `docs/planning/2026-07-30-server-stack-reassessment.md`(§0~§7).

## 2. NCP T3 smoke — **Swift 보류, Rust 트리거 후 실행** (성재 2026-07-30)

> **런북 정본: `docs/planning/2026-07-30-ncp-rust-smoke-prep.md`.** 현재 Swift 이미지로는 안 함. Rust 서버(B2~ 세션·과금·workd)가 서면 그 런북대로 진행. 트리거·자산·절차 거기에.
> **성재 몫(비용·보안)**: NCP 서버 놀며 과금 중 + API 키 노출 → **서버 정지 + 키 재발급 권고**(정지/재발급은 성재 트리거). 자산·IP는 보존.

(아래는 자산 상세 — 런북과 중복, 참고용)

- 서버 `momo-t3-smoke`(인스턴스 143929369) **RUN**, 공인 IP `101.79.11.189`, **SSH 접속 확인됨**(pem 직접 로그인 불가 — `getRootPassword`로 비번 복호화 후 `sshpass`, 비번은 `scratchpad/.ncp-root-pw` 0600).
- Ubuntu 22.04.3 · 2 vCPU · RAM 7GB · **디스크 가용 4.4GB** · docker 미설치.
- **내가 틀렸던 것(성재 지적)**: prod는 소스 빌드가 아니라 **이미지 pull**(`infra/prod/docker-compose.prod.yml` 전 서비스가 `image:`, api는 `${MOMO_API_IMAGE}`). 그러니 Swift 툴체인 불요 — 4.4GB로 충분할 수 있다. dev compose로 소스빌드하려던 게 오류였다.
- **다음 한 걸음**: `MOMO_API_IMAGE`가 어느 레지스트리에 퍼블리시됐는지 확인(안 됐으면 퍼블리시 선행) → 서버에 Docker 설치 → prod compose로 스택 → **BYOC 등록→세션→과금→종료** smoke → `MOMO_T3_ENABLED` 판단.
- 도구: NCP MCP(`scratchpad/NCP-Claude-Project/ncp-mcp`) + venv(`scratchpad/ncp-venv`, mcp 1.x). 자격 `~/.ncp/credentials.env`. **MCP 한계**: `provision_server`는 구형 XEN 전용 → KVM(Ubuntu22)은 `scratchpad/ncp-create-kvm.py` 형태(serverImageNo+serverSpecCode+networkInterfaceList). 자원 생성은 성재 트리거(승인 분류기가 막음).
- **비용**: 시간당 100원대, 켜져 있음. 안 쓰면 정지 권고. **API 키 명령줄 노출 — 종료 후 재발급 권고.**

## 3. 열린 티켓 (배치 6 후보)

- **#925 [우선]** verify_plugin_registry·grant_roundtrip 선존재 red(base 재현). "projected capability 1개 기대인데 2개" — **서버가 실제로 권한을 두 번 투영하는지 먼저 판정**(그러면 사용자에게 권한 중복 표시). bisect + 무회귀 세트 편입.
- **#926** Workstream/작업세션 잔여(M7 목표 역링크 상태·M8 `?work=` 착지 전 소비 + Nitpick 5).
- **#893** 랩탑 90초 슬립 세션 죽음 — **ADR-0141 방향(A 복귀재부착 / B unreachable 중간상태) 성재 결정 선행**. 보류 중.
- 랜딩됐는데 안 닫힌 이슈들(#888·#885·#882·#875·#861·#860·#859·#858·#857·#856·#855): 일괄 close가 classifier에 막힘 — 개별 확인 후 정리 필요.
- 성재 몫: `legal/privacy-policy.md` 빈칸(출시 차단) · #837 RN 실기기 · ADR-0138(온보딩)/0113 증보(3자 OAuth) · **ADR-0144 승인 시 Kata PoC(베어메탈 노드)**.

## 4. 배치 1~5 요약 (완료, 재검증 불요)

- **배치 1**(#897·#898·#870·#865): provider 어댑터+E2B 제거·workstream 계층·데몬 reconciliation·게이트 완주.
- **배치 2**(#903·#892·#869): **ADR-0140 이행 완결**(T-2·T-3·T-4)·**ADR-0139 재부착 실왕복 검증**.
- **배치 3**(#911·#910·#912·#909): 과금 정밀도·스펙 부채 소거·attach 후속·동의모달/danger 위계(J 2R).
- **배치 4**(#916·#917·#918): 스펙 승격·동의 Medium·Workstream 웹 표면(N 2R).
- **배치 5**(#922·#923·#924): local_gate 무신호 해소·매니페스트 한국어화·Workstream 잔여(Q 2R).
- ADR: 0140~0144 Accepted, 0141 보류.

## 5. 파이프라인 교훈 (누적)

- 결함은 워커가 못 돌리는 **docker 계층**에 몰린다 — 오케스트레이터가 곧 그 계층 테스터.
- **게이트가 한 국면만 보면 그 밖은 없는 것과 같다**(배치5 Q: High 2가 전부 게이트 1440px만 봐서). 신규 공용 컨트롤은 가장 좁은 실사용 폭에서 단정.
- **대비 단정은 합성해서 재라**(opacity는 계산된 color를 안 바꿈 → 그것만 읽는 단정은 회귀 통과).
- 선존재 검증기 red 반복(#903·#925) — **무회귀 세트 밖 검증기는 언젠가 조용히 red**. 세트 편입을 티켓 수용기준에.
- **푸시된 커밋 amend/force-push 금지**(배치4 N 위반) — 새 커밋으로. 배치5부터 공통 규율.
- "아무 non-2xx나 통과" 단정 금지(404와 거부 구분 못 함).
- 워커 자기신고 이탈이 정착 — 대부분 타당(근거와 함께).
- **재사용 트리거가 outbox를 늘린다**: message insert가 011 push_candidate·033 webhook 트리거를 발화해 앱 broadcast 외 추가 outbox 행 생성(정상). conformance의 outbox 계수는 `kind` 필터 필수(B1 게이트 실측). relay=broadcast, notifier=push_candidate 분리 소비.
- **마이그레이션 러너는 psql 경유**(Rust 재작성) — 시드 마이그레이션이 psql `\if` 조건부라 `sqlx::raw_sql`(서버 직송) 불가. migrate.sh와 동일 플래그로 shell-out. B0 게이트가 실측으로 잡음.
