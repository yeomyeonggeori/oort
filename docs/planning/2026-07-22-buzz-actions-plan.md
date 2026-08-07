# PLN-20260722-02: buzz 교훈 집행 배치 — 태세 정정·게이트 하드닝·정지권·셀프호스팅 제품화 (2026-07-22, Fable)

> 발단: 성재 — "buzz는 우리가 미래에 겪을 피드백/시장반응을 미리 겪은 케이스. 제안 액션을 풍부하게 고도화하고, 로직/인프라 레이어 고민을 심화하고, 셀프호스팅 해법을 비교하고, 우선순위와 배포 레벨 판단 + 실행 프롬프트까지."
> 입력: `2026-07-22-buzz-competitive-analysis.md`(1차 분석) + 이번 세션 2차 사실 감사 2건 — ①oort RLS/게이트 태세 실코드 감사 ②buzz vs oort 셀프호스팅 축별 비교. 모든 갭 판정은 파일:라인 근거를 가진 실측이다.
> **한 줄 결론: buzz 교훈은 "새 기능"이 아니라 "이미 가진 강점의 집행 완결"로 번역된다 — RLS는 스키마가 아니라 prod 롤 태세가 구멍이고(Critical), 킬스위치는 buzz가 밟은 지뢰 그대로 우리도 REST/클라 표면이 비어 있으며, 셀프호스팅은 백업/롤백 규율은 이기고 day-2 운영 표면·owner 온보딩·관측에서 지고 있다.**

## 1. 2차 감사 사실 요약 (근거는 감사 원보고서, 핵심만)

**oort 태세 감사 — buzz A-RLS 공리 대비:**
- A-RLS-1(전 테이블 정책) PASS(59개 중 의도적 제외 1) · A-RLS-3(SET LOCAL, 풀 잔류 없음) PASS · A-RLS-4(SECURITY DEFINER 1건, 통제됨) PASS · 에러 sanitize 양호.
- **A-RLS-2 PARTIAL — Critical**: prod 정본 템플릿(`infra/prod/secrets.env.example:46` + `docker-compose.prod.yml:138`)의 API 접속 롤이 `momo` = **postgres 수퍼유저**. 수퍼유저는 FORCE RLS도 무시하므로 prod 템플릿 배포에서는 RLS가 전면 무효다. (검수 정정: 롤 부트스트랩 기계장치 자체는 이미 상당 부분 존재 — migrate 이미지의 `internal-smoke-migrate.sh`가 3롤 존재+NOBYPASSRLS 태세를 fail-closed 어서션하고, `prod_env_preflight.sh` internal-host 모드는 momo_app URL 검증까지 한다. **실갭은 4개로 좁혀진다**: ①시크릿 템플릿의 API URL이 `momo` ②install.sh 롤 프로비저닝 부재 ③api/migrate DATABASE_URL 변수 미분리 ④API 기동 시 current_user non-superuser 어서션 부재 + DEPLOY.md §5.2 표에 momo_app/momo_worker 부재.)
- A-RLS-5 PARTIAL: 존재 누설 unique 3건(push token 409 문구가 "다른 워크스페이스에 등록됨"을 명시 반환 `DeviceRoutes.swift:199` / attachment drive_file_uniq 글로벌 / workspace slug — 미노출 예약 지뢰), 코어 FK 단일 컬럼(신규 마이그레이션은 복합 FK 채택 중).
- 루프 방어 PASS(depth·round CHECK + G1~G3·G5 이중, A2A 핑퐁도 G2가 각자 3회 차단) — 단 **depth 전파 미구현**(enqueue 항상 0 → depth≤4 CHECK가 실제로 안 물림), G4 SimHash 스텁.
- **휴먼 정지권 FAIL**: 진행 중 run을 사람이 멈추는 REST 부재(openapi 전 경로 확인), macOS `cancelRun` TODO 스텁(`LiveChatBackend.swift:1174`). work-control kill은 agent bearer 전용. buzz "킬스위치가 어떤 제품 표면에서도 도달 불가능" 교훈의 oort판.
- 게이트: branch-skew 가드 0건 · 마이그레이션 중복 번호 미검출(둘 다 조용히 적용됨) · SPM 라이선스 수동 1회(THIRD_PARTY 스스로 "scripts 없이" 명시 — AGPL 사후 재라이선스 무방비) · web 라이선스 게이트는 모범 PASS · flaky 재시도 마스킹 없음 PASS.

**셀프호스팅 비교 (축별 판정):**
- oort 우위: 설치 UX(preflight·digest 검증·evidence), 업그레이드/롤백(백업 PASS 없이 거부·자동 롤백·`.previous`), **백업/복구 압도적**(pgBackRest PITR+restore rehearsal 게이트), BM 명료성(Zulip 모델), 용량 명시, 푸시 content 비유입(대화가 Dawn을 안 지남 — buzz보다 명료한 차별점).
- buzz 우위: 배포 단위(이미지 1개 vs oort 6+4서비스), **owner 부트스트랩("키 생성+env 1줄" vs oort psql heredoc DBA 작업)**, day-2 운영 단일 진입(run.sh: status/logs/upgrade/backup-hint/member), 관측 기본 내장(/metrics 상시 vs oort 문서상 계획·배선 0건), 릴리스 채널(공개 GHCR·semver·자동 CHANGELOG vs oort GHCR read token 전제), 운영자 웹 콘솔, k8s 스펙트럼.
- 채택 비권장: embedded auto-migrate(oort one-shot+evidence가 우월), Helm(v1 밖), TLA+/Tamarin 풀스택(conformance 아이디어만 취함).

## 2. 배치 구조 — Wave H(hardening) 3단 + UXUI 제안

### Wave H1 — 태세 정정·게이트 하드닝 (경계 변경 없음 → ADR 불요, 성재 승인 즉시 발급 가능)

| 티켓 후보 | 내용 | 근거 갭 | 주 파일 |
|---|---|---|---|
| **MOMO-554** (Critical) | **prod 보안 태세 정정**: e2e bootstrap_roles의 prod 승격(momo_app/momo_worker 생성+NOBYPASSRLS 어서션), secrets.env.example API URL을 momo_app으로, install.sh 롤 단계, internal-smoke rolbypassrls 어서션의 prod 헬스게이트화, plugin_registry momo_app 쓰기 REVOKE, DeviceRoutes 409 문구 일반화, DEPLOY.md §5.2 정정 | A-RLS-2 Critical + A-RLS-5 문구 누설 | `infra/prod/*`, `server/.../DeviceRoutes.swift`, `docs/DEPLOY.md` |
| **MOMO-555** | **local_gate 하드닝 3종**: ①branch-skew 프리플라이트(merge-base 이후 origin/main이 내 변경 파일을 수정했으면 FAIL, pre-push hook 옵션) ②마이그레이션 중복 번호 검출(migrate.sh 선두+정적 검사) ③evidence artifact sha256 매니페스트 | 파이프라인 가드 FAIL 3종 | `scripts/local_gate.sh`, `scripts/migrate.sh` |
| **MOMO-556** | **공급망 게이트**: check_spm_licenses.sh 신설(Package.resolved+checkouts LICENSE 대조, copyleft 거부)+THIRD_PARTY 자동 재생성+local_gate swift 프로파일 편입+dependabot(npm/docker/actions) | SPM 수동·renovate 부재 (evalexpr AGPL 실사건) | `scripts/`, `legal/`, `.github/` |

병렬성(검수 정정): 554는 독립, **555와 556은 둘 다 `scripts/local_gate.sh`를 수정하므로 555→556 순차**(556의 게이트 편입 커밋만 555 랜딩 후). 전부 **배포 레벨까지**(554는 내부 알파 스택 재배포 포함 — 롤 전환 절차 명시). **554는 위임 큐의 실배포 리허설 Phase1(로컬)보다 선행해야 한다** — 리허설이 새 롤 태세를 검증하게 하여 이중 리허설을 피한다.

### Wave H2 — 에이전트 상호작용 안전 (ADR-0132 Proposed → 성재 option 승인 게이트)

ADR-0132(`docs/adr/0132-agent-interaction-safety-contract.md`) 5결정: D1 휴먼 취소 REST(채널 멤버 누구나) · D2 취소 의미론 3단(run/pause/채널격리 — buzz "1턴 취소는 루프 브레이커가 아니다") · D3 depth 전파 실구현+G2 발동 관측 · D4 발화 의무 계약(새 정보만 publish·침묵=성공·bare-ack 금지, per-turn 테스트로 기술) · D5 실패 고지 독립성(facts decide, timers are backstop).

| 티켓 후보 | 내용 | 순서 |
|---|---|---|
| **MOMO-557** | cancel REST+pending outbox 무효화+워커 중단 경계+원장·시스템 라인, agent_profile.paused | 1 |
| **MOMO-558** | macOS/iOS Stop·Pause 표면 + **실클라이언트 표면 E2E**(cancelRun TODO 해소) | 2 (557 소비) |
| **MOMO-559** | depth 전파+G2 발동 시 원장 이벤트·시스템 라인+D4 프리앰블(어댑터·AgentWorker) | 557과 병렬 |

### Wave H3 — 셀프호스팅 제품화 (560·561·563은 Accepted ADR-0119/0120/0121 후속 — 실행 승인만 필요. **562만 예외: ADR-0121 관측 증보 Accepted 선행** — 신규 노출 엔드포인트이므로)

| 티켓 후보 | 내용 | 편입 근거 |
|---|---|---|
| **MOMO-560** | `momo-ops.sh` day-2 단일 진입(status/logs/upgrade 래핑/backup-hint/member list/invite-create + CHANGE_ME성 placeholder fail-closed) | ADR-0121 S-1 계보, buzz run.sh 패턴 |
| **MOMO-561** | owner 부트스트랩 제품화 — migrate 이미지 one-shot `set-owner` 서브커맨드로 psql heredoc 제거 ("5분 설치의 마지막 5분이 DBA 작업" 해소) | ADR-0121+0128 정합 |
| **MOMO-562** | 관측 실물화 v0 — DEPLOY §8.2 계획 메트릭 5종(outbox lag·예산 트립율·APNs·턴 지연·publish 지연)을 실제 `/metrics`로, prod compose opt-in prometheus 오버레이, bounded-cardinality 라벨 규율(buzz push-gateway 규율 이식) | **ADR-0121 관측 증보 Accepted 선행**(신규 노출 표면) |
| **MOMO-563** | 공급망 실물 위생 — install.sh preflight `gh attestation verify`(provenance), compose 서비스 mem_limit+라벨(janitor 매칭 정합 — Docker 발열 전례 대응), 태그-only 이미지 digest 핀 확대 | deploy-lib 확장 |

**성재 결정 대기(티켓 아님)**: ①~~공개 GHCR+semver 릴리스 레인~~ → **확정(2026-07-23, 성재)**: 첫 공개 태그 게이트=**554 랜딩+리허설 Phase 1 PASS**, **레포(모노레포 전체)+이미지 동시 공개**(README/SECURITY.md 완료 전제). 조건 4: (a) 이미지에 LICENSE/NOTICE 동봉 (b) 공개 전 이미지 1회 시크릿/설정 스캔(gitleaks는 레포 이력만 커버 — 이미지 env/설정은 미스캔) (c) 태그 정책 semver v0.x+`latest`=stable+digest 핀 규율 유지 (d) publish 트리거는 workflow_dispatch 수동 유지(CI 과금 정책). 법무 실질(§5 확정 5항)은 기확정 — 추가 법무 검토는 공개 차단 사유 아님 ②"Self-host in 5 minutes" 공개 문서+신뢰 경계 다이어그램("무엇이 Dawn을 지나지 않는가" — momo-main 문서 작업) ③drive_file_uniq workspace 스코프화(의도 확인 필요 — DB 계약) ④workspace slug 정책 ⑤join policy(약관 동의+영수증 — 법무 연계) ⑥admin 콘솔(ADR-0119 v1+0128 파생 예약만) ⑦oort Cloud 성장 경로 서사(로드맵 예약).

### Wave U″ — UXUI 제안 (UXUI 트랙 큐 — ENGINE_HANDOFF 등재 제안)

1. **에이전트 작업신호 3종**(사이드바 working 배지+경과시간 / 컴포저 활동 헤드라인 바 / 턴 liveness) — 서버 이벤트 계약 필요 → **ADR-0104(presence/typing/streaming) claim하여 draft 제안**(다음 기획 레인). buzz `agentWorkingSignal` 단일 모듈 패턴 채택.
2. **managed-by 표기+수신 게이트**(who-can-talk, owner-only 기본) — ADR-0131 profile 소비 후속. 커뮤니티 최대 쟁점("그룹 A·B에 걸친 에이전트")의 표면 답변.
3. 빈 채널 인트로 'Create agent'='Add people' 동급 배치 — 소규모.
4. (기록만) diff 카드 1급 메시지 타입·"머지 시 채널 아카이브" 종결 UX·페르소나 카탈로그 상위 추상·활동 피드 12 렌더 클래스는 에이전트 활동 ADR 골격으로.

## 3. 우선순위와 배포 레벨 판단

현재 상태(2026-07-23 새벽 기준, 검수 반영): main `c8bca25`, **파이프라인 소진(worker 0)** — MOMO-553까지 전부 랜딩. 기존 위임 큐: ①게이트 부채 배치 ②실배포 리허설 Phase1(로컬) ③ADR-0117 기안. **Wave H는 이 큐에 다음처럼 삽입된다: H1은 ①게이트 부채 배치와 합류(같은 성격 — 한 배치로 발급 권장), 554는 ②리허설 Phase1 선행 필수(리허설이 새 롤 태세를 검증하도록).**

| 순위 | 항목 | 배포 레벨 판단 | 조건 |
|---|---|---|---|
| **P0** | **MOMO-554 prod 롤 태세** | **main 랜딩+내부 알파 스택 재배포까지** — RLS 하드 룰의 실집행이 걸린 Critical. **리허설 Phase1 선행** | 성재 승인 즉시. 외부 공개·차기 배포 전 필수 |
| P1 | MOMO-555→556 게이트 하드닝 (기존 위임 큐 ①과 합류) | main 랜딩(게이트는 랜딩=적용) | 554와 병렬, 555·556은 순차(local_gate 겹침) |
| P1.5 | ADR-0132 승인 → 557→558, 559 | main 랜딩 — dogfood 안전 직결(폭주 에이전트를 사람이 못 멈추는 상태 해소) | 성재 option 승인 |
| P2 | H3 560·561·563 셀프호스팅 제품화 (562는 ADR-0121 증보 선행) | main 랜딩, **공개 게이트(법무+공개 이미지 결정)와 정렬해 배포판에 편입** | H1 랜딩 후 순차(561은 554와 DEPLOY.md 겹침 — 후행). 리허설 Phase2(성재 VPS)와 정렬 |
| P3 | Wave U″ | UXUI 트랙 재량(track/uxui까지 자율, main은 성재 승인) | ENGINE_HANDOFF 등재 후 |
| 관찰 | buzz 재방문(4~6주 후 — 외부 기여 유입·Nostr 논쟁·승인 executor 향방) | — | 자동 |

법무 패키지(성재 전달 대기)는 이 배치와 독립 — 단 556(THIRD_PARTY 자동화)이 법무 패키지의 유지보수 자동화가 되므로 전달 시 함께 언급 권장.

## 4. 실행 프롬프트

### 4.1 오케스트레이터 인수 프롬프트 (성재 승인 후 새 Fable 세션/momo-main)

```
momo Wave H(buzz 교훈 집행) 오케스트레이션을 인수한다.
정본: docs/planning/2026-07-22-buzz-actions-plan.md (계획) + 2026-07-22-buzz-competitive-analysis.md (근거) + docs/adr/0132-agent-interaction-safety-contract.md. 검수 반영 완료본이다(§5).
성재 승인 범위를 먼저 확인하라: (a) H1만 / (b) H1+ADR-0132(→H2) / (c) H1+H2+H3.
집행 순서: ①H1 3장(554·555·556) 이슈 발급(§4.2 프롬프트=이슈 본문, 패킷은 handoffs/2026-07-22-buzz-hardening-batch.md로 승격. 기존 위임 큐 '게이트 부채 배치'와 같은 배치로 합쳐도 좋다) — 554∥555→556 순서(555·556은 local_gate.sh 겹침) ②554 랜딩 후 실배포 리허설 Phase1을 새 롤 태세로 실행(순서 고정: 554→리허설) + 내부 알파 재배포 여부 성재 확인 ③ADR-0132 Accepted면 557→558, 559 병렬 ④H3는 561이 DEPLOY.md에서 554와 겹치므로 554 랜딩 후 발급. 562는 ADR-0121 관측 증보 Accepted 전 발급 금지.
예약: 마이그레이션 다음=037부터(H2 필요 시), verifier 포트 다음=28170대부터. 이 배치 자체가 번호 충돌 사고 클래스를 만들지 않게 발급 시 이슈 본문에 명기하라.
불변: 머지 순차, worker merge 금지, schema_v0 불변, 머지 후 push 전 마커 grep+macOS 빌드 게이트(통합 규율), 검수 시 verifier는 최종 소비 지점 단정, JOURNAL/CURRENT_STATE 플러시.
```

### 4.2 worker goal 프롬프트 (H1 — 이슈 본문 초안)

**MOMO-554 — prod 보안 태세 정정 (Critical)**
```
목표: prod 배포 템플릿이 RLS FORCE 불변식을 실제로 집행하게 한다. 현재 API가 수퍼유저 `momo`로 접속해 RLS가 무효다.
전제(기존 기계장치 — 새로 만들지 마라): migrate 이미지 엔트리포인트 `infra/prod/docker/internal-smoke-migrate.sh`가 이미 3롤 존재+NOSUPERUSER+BYPASSRLS 태세를 fail-closed 어서션하고(`MOMO_BOOTSTRAP_RUNTIME_ROLES=0` 분기), `scripts/prod_env_preflight.sh` internal-host 모드에 `MOMO_APP_DATABASE_URL`/`MIGRATE_DATABASE_URL` 검증 문법이 이미 있다. 이 배선을 staging/prod 템플릿까지 연장하는 작업이다.
작업: ①install.sh에 롤 프로비저닝 단계(infra/e2e/bootstrap_roles.sql 패턴의 prod판, idempotent) ②docker-compose.prod.yml에서 api/migrate의 DATABASE_URL **변수 분리** — api=momo_app 계열, migrate=기존 상위 롤. secrets.env.example 갱신 ③API 기동 시 current_user non-superuser+NOBYPASSRLS 어서션(위반 시 기동 거부 fail-closed) ④plugin_registry에 momo_app INSERT/UPDATE/DELETE REVOKE ⑤DeviceRoutes.swift:199 409 문구를 워크스페이스 언급 없는 일반 문구로 ⑥DEPLOY.md §5.2 표에 momo_app/momo_worker 추가·실제와 일치화 ⑦기존 설치본 롤 전환: upgrade.sh가 migrate 실행 **전에** 롤 프로비저닝을 수행하도록 자동 스텝 추가(install만 자동이면 비대칭) + 런북에 절차 명시.
수용기준: prod compose 스택에서 momo_app으로 기동한 API가 RLS 격리 스모크(교차 워크스페이스 0행)를 PASS하고, 수퍼유저 URL 주입 시 기동이 거부된다(fail-closed 증명). 기존 e2e/게이트 전체 회귀 PASS + `scripts/verify_internal_hosting_smoke.sh` PASS.
함정: POSTGRES_USER(momo)는 컨테이너 초기화용으로 존치 — API 접속 롤만 교체. 롤 생성 SQL은 재실행 안전(idempotent). preflight의 기존 internal-host 모드 검증과 이중 구현 금지.
게이트: runtime-db + internal-alpha(verify_internal_hosting_smoke.sh).
```

**MOMO-555 — local_gate 하드닝 3종**
```
목표: 병렬 트랙/worker 체제의 조용한 실패 3종을 게이트에서 차단한다.
작업: ①branch-skew 프리플라이트 — merge-base 이후 origin/main이 이 브랜치 변경 파일과 겹치게 바뀌었으면 FAIL(메시지에 겹친 파일 목록+rebase 안내). scripts/local_gate.sh 프리플라이트 + 선택적 pre-push hook(기존 훅은 post-checkout뿐 — 충돌 없음 확인됨) ②마이그레이션 중복 번호 검출 — scripts/migrate.sh 선두에서 번호 prefix uniq -d 검사 FAIL + local_gate server/Migrations 분기에 동일 정적 검사 ③게이트 evidence 출력 디렉터리 산출물의 파일별 sha256 매니페스트 생성·기록(주의: local_gate.sh에 write_evidence 함수는 없다 — evidence 기록 지점을 실코드에서 찾아 그 지점에 얹어라).
수용기준: 각 검사의 양성/음성 케이스를 재현하는 셀프 테스트(가짜 스큐 브랜치/중복 번호 픽스처)가 게이트 스크립트 테스트로 포함될 것. 기존 게이트 런타임 회귀 없음(±5% 이내).
함정: 3-dot diff 기존 로직(local_gate.sh:218-236, 프로파일 선택용)과 혼동 금지 — 별도 함수로. skew FAIL은 override 환경변수(MOMO_GATE_SKIP_SKEW=사유) 허용하되 evidence에 사유 기록(buzz ratchet 패턴). worktree 훅 공유로 track/* 브랜치 오탐 가능 — override로 커버.
게이트: docs 프로파일 + 셀프 테스트.
```

**MOMO-556 — 공급망 게이트 (SPM 라이선스 + dependabot)**
```
목표: "AGPL 백본 금지" 하드 룰을 기계 집행한다(의존성 사후 재라이선스 검출 — buzz evalexpr 실사건).
작업: ①scripts/check_spm_licenses.sh — 레포 내 **Package.resolved 9개 전부**를 루트별로 순회, 전이 의존성의 .build/checkouts LICENSE를 allowlist(MIT/Apache-2.0/BSD/ISC 계) 대조(fresh 환경이면 `swift package resolve` 선행), copyleft(AGPL/GPL/LGPL/MPL/SSPL/BUSL) FAIL, 예외는 사유 명기 allowlist 파일 ②legal/THIRD_PARTY_NOTICES.md 자동 재생성 모드(--write) + 드리프트 검출 모드(--check, 게이트용) ③local_gate swift 프로파일에 --check 편입 — **이 커밋은 555 랜딩 후 rebase하여 반영(local_gate.sh 겹침)** ④.github/dependabot.yml(npm+docker+github-actions — SPM 미지원은 ①이 보완) — CI 과금 정책(전 워크플로 workflow_dispatch 전용) 침해 금지.
수용기준: 현행 의존성 37종 전부 PASS + AGPL 픽스처 주입 시 FAIL 재현. clients/web/scripts/check-licenses.mjs와 allowlist 문법(SPDX OR/AND) 일치.
게이트: swift 프로파일 + docs.
```

### 4.3 UXUI 트랙 세션 프롬프트 (ENGINE_HANDOFF 등재 시)

```
buzz UX 참고 배치: docs/planning/2026-07-22-buzz-competitive-analysis.md §7 정독 후, ①에이전트 작업신호 3종(ADR-0104 draft 선행 — 서버 이벤트 계약 합의 전 클라 구현 금지) ②managed-by 표기+수신 게이트(agent_profile 소비) ③빈 채널 Create agent 동급 배치를 UXUI 큐 티켓으로 세분화해 성재에게 제안하라. momo-design-taste 스킬+design-review Blocker 0 유지. buzz 반면교사(§7): read state 클라 로컬 금지(ADR-0109 준수), 에이전트 설정 패널 비대화 금지(간편 생성 노선).
```

## 5. 검수 결과 (독립 critic pass — 2026-07-22, 신선 컨텍스트, 실코드 스팟체크)

- **핵심 사실 전부 재확증**: A-RLS-2 Critical(수퍼유저 API 접속), 휴먼 정지권 FAIL(REST 부재+cancelRun TODO), depth 하드코딩 0(A2A run에도 적용 — CHECK가 안 물림), 게이트 3갭, 존재 누설 3건, SPM 37종, metrics 배선 0건, 티켓 번호 554~563 미사용.
- **정정 반영 5건**: ①MOMO-553 이미 랜딩(우선순위 표 갱신, Wave H를 위임 큐 ①②와 정렬 — 554는 리허설 Phase1 선행) ②554 수리 표면 축소(기존 롤 부트스트랩 기계장치 명시, api/migrate URL 분리, upgrade 자동 스텝) ③555·556 local_gate.sh 겹침 → 순차화 ④ADR-0132 D1 호출 주체 human principal 한정+기존 cancelled 전이/gateway ack 선례 참조, D4 외부 런타임 경계 1줄 ⑤562를 "ADR-0121 증보 Accepted 선행"으로 강등, 게이트 프로파일 명칭 정정(tooling→docs, prod internal-smoke→internal-alpha), 마이그레이션 037·포트 28170대 예약 명기.
- **검수 확인 통과 항목**: H1 ADR 불요 분류(554~556 한정), ADR-0132 vs 기존 Accepted 7종 무충돌, buzz 교훈 번역 충실(D2 3단·D4 per-turn·D5 백스톱·기각 3건), H3 채택/비권장 판단(embedded auto-migrate 비권장 실증 타당), 556 프롬프트는 검수 시점에도 실행 가능 수준.
