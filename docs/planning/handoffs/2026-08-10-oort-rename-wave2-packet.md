# 핸드오프 패킷 — oort 개명 스윕 + 적립 + CI 신설 (2차 파도 W-R1·W-CI·W-A·W-S·W-H)

> 발주: 2026-08-10 Fable (성재 지시: 레포명 oort 개명·관련 전부 재조준·적립 진행·CI 자동 빌드).
> **레포는 방금 `yeomyeonggeori/oort`로 개명됐다**(momo URL은 리다이렉트). gh 명령은 `-R yeomyeonggeori/oort`.
> 공통 규율: wave1 패킷과 동일(워크트리 base=origin/track/engine — **main과 0/0 정렬 상태** · PR base=track/engine · STOP · 이탈은 PR 본문에).

## W-R1 — 개명 참조 전수 재조준 · 브랜치 `chore/oort-rename-sweep` (#1236 일부 흡수)

- `yeomyeonggeori/momo` → `yeomyeonggeori/oort` **활성 참조 전수**: README(클론 URL)·docs/SELF_HOST.md·SECURITY.md·CONTRIBUTING·워크플로(GHCR 경로 = `ghcr.io/yeomyeonggeori/oort`)·scripts(gh -R/-repo 참조 — goal_*.sh 등)·docs 활성 런북. W-O1의 원칙 승계: **이력 기록물(planning/research 과거 문서·저널)은 보존**, 실행 가능한 참조만.
- `docs/GITHUB_OPS.md`(11곳)·`docs/RELEASE_PLAYBOOK.md`(10곳)의 구 org(Dawn-kim-official) gh 명령도 이번에 함께 현행(oort)으로 — #1236 항목 2 종결.
- Tauri updater·Pages 계열 URL(`dawn-kim-official.github.io`)은 W-O1이 `yeomyeonggeori.github.io`로 재조준함 — **레포명 부분(`/momo-alpha/`)이 개명과 무관한지 실측**(Pages 경로는 발행 레포명 기준) 후 필요 시만 수정, 발행 절차 문서에 각주.
- 검증: `git grep -l "yeomyeonggeori/momo"` 잔존이 전부 이력 기록물임을 목록으로 증명 + `gh api repos/yeomyeonggeori/oort` 200 + docs 게이트.

## W-CI — 경량 PR CI 신설 · 브랜치 `feat/pr-ci` (신규 티켓은 오케스트레이터가 발급)

- 현실: 워크플로 5개 전부 `workflow_dispatch`(2026-06-26 과금 중단), PR 자동 검사 0. 목표: **PR마다 도는 경량 레인 1개** — private 무료 2,000분/월 안에서 사는 설계.
- `.github/workflows/pr-ci.yml` 신설: `pull_request`(base: track/engine·main) 트리거 · `concurrency: cancel-in-progress` · **ubuntu-latest만**(macOS 10배 과금 금지) · path filter로 문서 전용 PR엔 스킵.
- 잡 구성(전부 한 잡 순차 또는 2잡 — 총 15분 이내 목표): ①라이선스(cargo-deny 설치는 taiki-e/install-action 또는 사전빌드 바이너리 캐시 + `scripts/check_npm_licenses.mjs`) ②TS typecheck(core·web·mobile — npm ci 캐시) ③`cargo check --workspace`(Swatinem/rust-cache). 스위트 전체는 넣지 않는다(로컬 게이트 몫 — 공개 전환 후 확장).
- 기존 5개 workflow_dispatch는 무접촉. 예상 분당 소모를 PR 본문에 계산해 명시(성재가 과금 판단할 근거).
- 검증: workflow yaml parse·actionlint(로컬 게이트에 있음) + 이 PR 자체에 CI가 돌면 그 결과가 증거(단 첫 런은 머지 후 트리거 조건 확인).

## W-A — #1234 로그인 이메일 대소문자 비대칭 · 브랜치 `fix/email-case-1234`

- 성재 지시로 적립 해제. **실측 먼저**: 이메일을 쓰는 전 경로(회원 생성·초대·부트스트랩·set_initial_owner·로그인 조회)가 저장 시 `lower(btrim())`을 일관 적용하는지 전수. 예외가 있으면 그 사실이 설계 입력.
- 저장이 일관 lower면: 조회(`verify_password_login` 등 — `momo-messaging/src/identity.rs:339`)를 같은 정규화로. 예외 행이 존재 가능하면: 마이그레이션으로 기존 행 정규화(+유니크 충돌 검사) 후 조회 정규화 — 어느 쪽인지 근거로 결정.
- 검증: `cargo test --workspace` + 대문자 이메일 로그인 성공 테스트 신설 + red proof(정규화 제거 시 빨강) + 병합 트리 8레인.

## W-S — 소형 위생 2건 · 브랜치 `chore/hygiene-1235-1238`

- **#1235**: `CENT_API_URL` 우회 가드 7개(verify 스크립트의 `case ... *centrifugo*)` 재작성) 은퇴 — 템플릿이 고쳐졌으므로(#1231) 가드 없이도 각 스크립트가 성립함을 하나씩 확인하며 제거. 하나라도 가드가 실수요면 남기고 근거 보고.
- **#1238**: base compose `pgdata` 프로젝트 스코프 — `COMPOSE_PROJECT_NAME` 기반 명명 또는 `name:` 파라미터화로 로컬 `down -v` 교차 삭제 차단. 기존 라이브(`momo-rust` 프로젝트명)의 볼륨명이 **바뀌지 않음**을 증명(라이브 데이터 연속성 — 렌더 대조로).
- 검증: 관련 verify 스크립트 실행 가능 확인(runtime 필요분은 bash -n+렌더 대조) + compose config 렌더 전후 대조 + docs 게이트.

## W-H — #1236 잔여: gitleaks 배선 + 선재 red 2건 · 브랜치 `fix/hygiene-1236`

- gitleaks를 `local_gate.sh` 프로파일로 배선(신규 `--profile secrets` 또는 기존 프로파일 편입 — 베이스라인 `.gitleaksignore` 적용 확인, 미설치 시 fail-closed 안내).
- 선재 red 2건 **조사 후 수리**: ①`scripts/verify_prod_install_upgrade.sh` "tag-only image did not reach the installer digest guard" ②`gate_oort_user_facing.sh`가 잡는 `server-rust/crates/momo-t3/src/provider/cubesandbox.rs:128` `momo_` 잔여(oort 카피 규칙 위반 — 코드 식별자면 게이트 예외가 옳은지, 사용자 노출 문자열이면 카피 수리가 옳은지 판정해 근거와 함께).
- 검증: 수리한 게이트/검증기 실행 green + red proof(각 수리를 되돌리면 빨강) + docs 게이트.

## 보고 (전 워커)

PR 번호 + 검증 결과 + 적립. 중간 보고 없음. 워커 간 파일 겹침 금지(각자 절의 파일군만).
