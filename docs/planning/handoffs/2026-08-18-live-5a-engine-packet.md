# LIVE-5a 핸드오프 패킷 — 직접 조작 엔진 잔여 (TURN 단명 자격·control 내구 투영·observation 전환 원자성)

> 2026-08-18 Fable 발급 · Status: **`ready` — 발사는 성재 재개 발화 후**(재개 게이트, 인터뷰 확정) · 워커: 단발 무명 Opus 5.
> planning ID: **PLN-20260815-01** (owner: Fable · integrator: momo-main) · supersedes: 없음.
> 편성 정본: `handoffs/2026-08-17-live-5-direct-control-ux-plan.md`(§4 결정 전부 확정 — 5a→5b 순차·ephemeral TURN=5a 포함·진입점=LIVE-4 딥링크) · 설계 계보 `research/2026-08-16-live4-interview-and-plan.md` §3.
> 근거 ADR: **전부 Accepted** — 0004 증보 3(control 비관측)·0165 본문+증보 1(relay 유일·전용 TURN)+증보 2(ICE base 주입 확정 계약)·0156 증보 4(envVars=배달)·0157 증보 2(부트스트랩 포트 경계).
> 정본 goal: GitHub Issue **#1524**(status:ready — metadata-only binding, 2026-08-18 발급). 수용기준 정본 = §4.
> 기준 커밋: **origin/track/engine 최신**(발사 시 fetch — 2026-08-18 현재 `5e598773` 이후). claim: `scripts/goal_claim.sh <n>`(#1464 랜딩으로 트랙 base 자동 인지 — 명시 `--base` 불요, base 줄 출력 확인만).

## 1. 미션 — 세 조각 (전부 엔진, 클라 비접촉)

1. **per-session ephemeral TURN 자격**: controller/observer capability 발급 시 **그 세션·그 수명에 묶인 단명 TURN 자격**을 함께 발급, 클라 `DISPLAY_ICE_SERVERS`가 그것을 소비. **정적 long-term cred(현행 `MOMO_DISPLAY_TURN_URI` — 1회 로테이션 전례 있는 그 노출면) 은퇴**가 수용기준.
   - **권장 방식(워커 실측 확정)**: coturn **`use-auth-secret`(TURN REST API 규격)** — 서버가 `static-auth-secret`만 보유, capability 발급 시 `timestamp:username`+HMAC-SHA1 자격 생성. 무상태(coturn에 사용자 등록 불요)·만료=timestamp 내장·coturn 네이티브. 대안(서버가 coturn API로 user CRUD)은 상태·왕복이 늘어 비권장 — 뒤집을 실측 근거가 나오면 이탈 보고.
   - 만료는 capability lease(90s 재검증 계열)와 정합하게 — 스트림 수명 동안 재발급 경로 포함(LIVE-2 D1 원장 재검증 기계에 합류, 프레임 발행 루프 금지).
   - producer 쪽: 템플릿 envVars 배달(#1437 수신기)로 오는 TURN URI가 단명 자격을 실을 수 있는지 확인 — producer는 세션 시작 시 1회 수령이므로 **producer용 자격의 수명은 세션 수명**(브라우저 관전자용은 capability 수명). 두 수명이 다름을 명시적으로 다뤄라.
2. **control 내구 투영 SoT 결정+구현**(LIVE-4 동결 이월): 리로드 후 세션 상세가 control 상태(창 열림·controller·정지/재개 시각)를 그릴 수 있는 **단일 읽기 경로**. LIVE-4가 이월한 충돌 — 3투영 드리프트 가드 vs bare RETURNING — 의 결정: **control 창 원장(`display_control.rs`)이 SoT, 세션 목록/상세 투영에 read-only 조인으로 노출**을 권고(새 테이블 불요·기존 원장 재사용). 마이그가 필요하면 가산적으로(투영 칼럼이 아니라 조인이 먼저 — 원장 성질 유지). 결정 1문단을 PR에.
3. **observation 전환의 서버 원자성 + owner_only owner 예외**(LIVE-3 이월): control 시작 시 `owner_only` 강제 전환과 반환 시 복원이 **한 트랜잭션**(전환 절반 실패로 팀원이 control 중 화면을 보는 창 없음). owner 예외: `owner_only` 세션의 **소유자 자신**은 display observer 가능(LIVE-1의 fail-closed 거부를 owner에 한해 개방 — ADR-0004 증보 3의 같은 권한 표면, Accepted 근거 위에서).

## 2. 필독 코드 좌표 (기준 커밋에서 재확인 — 다르면 코드가 진실, 계약이 다르면 정지+이탈)

- control 창 원장·봉투: `server-rust/crates/momo-t3/src/display_control.rs`(end_reason·control_window_payload·lease 90s) · 라우트: `server-rust/bins/momo-server/src/routes/display_attach.rs`(capability 발급·경계 이벤트 방출).
- run 파킹(비접촉 — 재사용만): `server-rust/crates/momo-agent/src/run.rs`(#1425 — RunStatus·requeue) · 잠금 순서 계약 **session/host→window→run**(#1425 grok H1 성문화 — 위반 금지).
- TURN 현행: `infra/cubesandbox/display-template/template.spec.json`(`ice.turn required·transports`) · envVars 배달 수신기 `infra/cubesandbox/bootstrap-init/` · coturn 호스트=momo-turn(223.130.142.109) — 설정 변경은 런북 `docs/runbooks/` turn 계열에 기록(F1 firewalld 검증 항목 유지).
- 관전 재검증 기계: LIVE-2 랜딩분(원장 재검증·revocation 도달) — 웹 `clients/web/src/features/work/displayStream.ts`는 **읽기만**(5b 좌표, 이 goal 비접촉).
- conformance 선례: `server-rust/bins/momo-server/tests/display_attach_conformance_pg.rs`.

## 3. 지켜야 할 계약

- 핵심 불변식 전부(PG=SoT·단일 쓰기경로·seq·RLS FORCE) + **ADR-0004 증보 3 D2**: 입력 자격 비관측 — 이 goal에서는 TURN 자격이 로그·audit·전사에 안 남는 것(`turn://` URI 자격 마스킹 — #1438 producer 비로그 선례).
- ADR-0165 증보 2: relay 강제·ICE base 주입 계약 무손상(template.spec 소비 테스트+typecheck — 공유 계약 파일 교훈).
- 제3자 TURN 금지(operator=oort) 유지 — conformance 단정 무손상.
- coturn 설정 변경 시 **구 정적 자격 은퇴 순서**: 신규 단명 경로 실증 → 정적 제거(역순 금지 — 관전 다운타임 방지). 시크릿 비유입·shred 규율(로테이션 전례).
- 클라(clients/·packages/) 비접촉 — 5b 좌표.

## 4. 수용기준 (정본)

1. capability 발급 응답에 단명 TURN 자격 동봉+만료·재발급 정합(관전자/producer 두 수명 구분 명시)·**정적 자격 은퇴 실증**(구 자격 401 실측).
2. control 내구 투영: SoT 결정 1문단+리로드 재구성 conformance(창 열림 중·반환 후·expired 3상태).
3. observation 전환/복원 원자성 mutation 증명(절반 실패 주입 → 노출 창 0)+owner 예외 conformance(owner=가능·팀원=여전히 403).
4. `cargo clippy -D warnings`·`cargo test`·PG conformance·`local_gate --profile swift` 그린 + momo-turn 실기동 실증(ALLOCATE 성공 로그 — 단명 자격으로).

## 5. 함정 / 컨텍스트

- 템플릿 §5.1 공통 함정 전항. coturn `use-auth-secret`와 기존 long-term 병행 기간의 realm 상호작용 실측 필수(문서 아닌 실기동으로).
- producer 자격은 envVars 1회 배달이라 **세션 중 만료되면 재협상 실패** — 세션 수명 자격이 답인 이유. 관전자 자격과 혼용 금지.
- momo-turn은 프로덕션 관전이 실사용 중 — 은퇴 순서(§3) 엄수, 배포 창 고지는 momo-main에 이탈 채널로.
- red proof 문화·`runtime-unverified` 정직 라벨(실기동 못 한 항목은 라벨로).

## 6. 이탈·착수

표준: PR `## 계획 이탈`·판단 필요 시 `--blocked` 정지. 착수는 **momo-main이 재개 신호 후 이슈 번호와 함께 발사** — 본 패킷 단독으로 self-start 금지.

## 7. 컨텍스트 델타

- 새로 고정: ephemeral TURN 권장=use-auth-secret(무상태) · 내구 투영 권고=원장 SoT+read-only 조인 · owner 예외=5a 편입.
- 의도적 미결정: TURN 자격 TTL 구체값(워커가 lease 정합으로 제안) · 5b 진입점 오버레이 구현 여부(5b 리뷰).
- 재기획 트리거: use-auth-secret 병행 실측 실패 시(이탈 보고 → 방식 재결정).
