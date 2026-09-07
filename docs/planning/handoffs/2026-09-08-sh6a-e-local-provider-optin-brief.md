# 워커 브리프 — SH-6a-e 로컬 OpenAI 호환 provider opt-in: 생성기 플래그 → 컴포즈 전달 → host.docker.internal 허용 목록 → doctor (engine · #2215 · ADR-0004 증보 1절 동반)

> 워커: grok 4.6 · base=origin/track/engine · 워크트리 `momo-worktrees/wsh6ae`(`feat/sh6a-e-local-provider`) · 시작 절차: `git merge origin/main --no-edit`
> 정지 조건: 머지·이슈 close 금지. **허용 보호 경로(정책 감사)**: `scripts/self_host_env.sh`(플래그 1개 + 키 2개, 정본 키 함수에서 파생) · `scripts/lib/oort_doctor.sh`(행 1개) · `scripts/tests/test_local_provider_optin.sh`(신규). 그 밖 `scripts/**`·`.github/**` 무수정. `docs/adr/0004-*.md`는 **「증보 — 로컬 provider opt-in 경계(2026-09-08)」 1절 추가만**(본문 무수정). 서버 변경은 `server-rust/crates/momo-settings/src/provider.rs`(허용 목록 predicate·env 읽기·컨포먼스)와 그 시험으로 한정. 시크릿 금지. mock-hermes는 stub 응답만.
> **design-review #2214 발견 반영(2026-09-08)**: 벤치마크 F2·T2 — 생성 env가 `MOMO_ENV=staging`이라 플래그를 켜도 뚫리지 않는 경로가 있다(에이전트 baseUrl 400). 이 티켓이 「어떤 조건에서 로컬 provider를 여는가」를 **한 자리에서** 결정·구현한다: 설정 › AI 연결(provider link/chain)과 에이전트 baseUrl 검증 모두 같은 predicate(플래그 ∧ 허용 목록)를 쓰고, `MOMO_ENV=staging`에서도 플래그가 유효(운영자 opt-in). 이는 평문 provider 경계 완화 = 보안 결정 → ADR-0004 증보 1절이 필수(성재 승인). 사용자 문장은 SH-6a-w R2가 제품 어휘로 바꿨으므로 서버 거부 문장은 **바이트 유지**하되 그 문장을 화면에 그대로 노출하지 않는다.
> 근거: 1차 목표 §1(본인 hermes 합류) · SH-6a-w #2204(거부 문장 핀: `loopback baseUrl requires local mode and AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1`) · 실측: `provider.rs::validation_errors`(http 허용 = 플래그 ∧ `is_allowed_loopback_host`{localhost,127.0.0.1,::1}) · `docker-compose.rust.yml`에 `AGENT_PROVIDER_*` 전달 0 · 컨테이너 loopback ≠ 호스트.

## 1. 구현 계약
1. **생성기**: `scripts/self_host_env.sh --allow-local-provider` → env에 `AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK=1`·`AGENT_PROVIDER_LOCAL_HOSTS=host.docker.internal` 기록(미지정 시 두 키 부재 = 기본 거부). 키 목록은 heredoc 정본에 추가(→ `oort_generator_env_keys`가 자동 파생, SH-5a `--railway` 키 집합 시험이 그대로 초록이어야 함 — 안 되면 그 시험의 정본 갱신 근거를 PR에).
2. **컴포즈**(`infra/rust/docker-compose.rust.yml`): api·agent-worker 서비스에 두 키 `${…:-}` 전달 + `extra_hosts: ["host.docker.internal:host-gateway"]`(Linux 호환; macOS Docker Desktop/Colima는 자동). Railway 템플릿(`infra/railway/railway.json`)은 **무변화**(로컬 provider는 로컬 설치 전용 — README 1줄).
3. **서버**(`momo-settings/provider.rs`): 실측 — `validated_base_url(raw, environment, allow_local_loopback)`가 `loopback_allowed = flag && !strict && is_loopback`이라 `MOMO_ENV=staging`(생성기 기본)에서는 플래그가 **죽어 있다**(호출부 2곳: `routes/provider_link.rs:386`·`routes/agents.rs:134`, 둘 다 `state.settings.environment`·`env_provider.allow_local_loopback` 전달). 결정(ADR-0004 증보로 성문): **플래그는 strict 환경에서도 유효한 운영자 opt-in**이다 — `loopback_allowed = flag && (is_loopback || in_local_hosts)`로 바꾸되, ①플래그 없으면 기존 동작 바이트 동일 ②`PlaintextRemote`(목록 밖 http)는 불변 ③`LoopbackPortMissing` 불변 ④`validation_errors()`의 env-provider 경로도 같은 predicate. 컨포먼스에 「staging + 플래그 + host.docker.internal → 허용 / staging + 플래그 없음 → LoopbackNotAllowed 바이트 동일」 추가. `AGENT_PROVIDER_LOCAL_HOSTS`(쉼표 구분, 정확 일치, 와일드카드·suffix 금지, 플래그 켜졌을 때만 유효) 읽어 `is_allowed_loopback_host` ∪ 목록으로 판정. 거부 문장은 **바이트 그대로 유지**(SH-6a-w가 핀) + 목록 힌트는 별도 `diagnostics` 1문장. `provider_link.rs`의 두 호출 지점은 무변경(플래그를 이미 읽음).
4. **doctor**: `env.local_provider` 행 — 꺼짐=pass(정보) · 켜짐=warn 「로컬 provider 허용 — 같은 머신의 provider만」 · 켜짐 ∧ `OORT_SITE_ADDRESS` 존재=major 「공개 오리진에서 로컬 provider 허용은 권장하지 않는다」.
5. **문서**: `docs/SELF_HOST.md`(+ko) AI 연결 절에 「로컬 provider(같은 머신)」 3줄(플래그·주소 `http://host.docker.internal:<port>/v1`·끄는 법) · ADR-0004 증보 1절(운영자 opt-in 경계: 자격은 여전히 서버에 비유입, 로컬 호스트 목록은 정확 일치, 공개 오리진 경고).

## 2. red proof
- 컨포먼스(`cargo test -p momo-settings`): 플래그 없이 `host.docker.internal` → 거부(문장 바이트 동일) · 플래그+목록 → 허용 · 목록 밖 사설 호스트(`10.0.0.5`) → 거부 · `*.internal` 와일드카드 → 거부 · https는 플래그 무관 허용.
- `scripts/tests/test_local_provider_optin.sh`: 생성기 플래그 유무별 키 존재/부재 · compose config에 두 키·extra_hosts 렌더 · doctor 3상태.
- E2E(로컬 빌드 모드): `--allow-local-provider` 스택 + 호스트 mock-hermes(`scripts/mock_hermes.py` 또는 동등, OpenAI 호환 stub) → 설정 › AI 연결 등록(`PUT /v1/provider/link`) → `POST /v1/provider/link/test` OK → 웰컴 킥오프 답장 1회 원문. 플래그 끄고 같은 등록 → 거부 문장 원문.
- docs·web 프로파일 PASS · `test_railway_template.sh` PASS(키 집합) · 사보타주: 목록 판정을 suffix 일치로 바꾸면 컨포먼스 RED.

## 3. 완료 절차
커밋 순서: ①서버 predicate+컨포먼스(RED→GREEN) ②생성기·컴포즈 ③doctor·시험 ④문서·ADR 증보 ⑤E2E 원문. push `feat/sh6a-e-local-provider` → PR(base `track/engine`): 게이트 원문·E2E·보호 경로 변경 목록·NOTES. `DONE / COMMITS / GATES / PR / NOTES`.

## 4. 규율
거부 문장 바이트 보존(SH-6a-w 핀). 허용은 정확 일치만. 막히면 보고 후 정지.
