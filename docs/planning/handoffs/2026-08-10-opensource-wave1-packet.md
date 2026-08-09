# 핸드오프 패킷 — 오픈소스+셀프호스팅 1차 파도 (W-O1~W-O4 전면 병렬)

> 발주: 2026-08-10 Fable (성재 지시 "작업 진행"). 계획 정본: `docs/planning/2026-08-10-opensource-selfhost-plan.md` · 근거 정본: `research/2026-08-10-buzz-audit-{A,B,C,E}.md`(각 워커는 자기 축 보고서를 먼저 정독 — 패킷은 얇고 증거는 거기 있다).

## 공통 규율 (전 워커 하드)

- 워크트리 신설: `git worktree add ~/projects/momo-tracks/momo-worktrees/<브랜치명> -b <브랜치명> origin/track/engine`. `/Users/kwakseongjae/projects/momo` 체크아웃 무접촉.
- **PR(base=track/engine) 만들고 STOP** — 머지 금지. 이슈 번호를 본문에 참조(Closes 금지 — base≠main이라 미발화, 수동 종결 규율).
- 이탈은 숨기지 말고 PR 본문에 근거와 함께. 예상 밖 발견은 지우지/고치지 말고 적립 보고.
- 검증: 각자 절의 지정 게이트 + 문서 접촉 시 `local_gate.sh --profile docs`. red proof를 요구하는 절은 실제로 되돌려 빨강을 증명.
- 최종 보고 1회: PR 번호 + 체크리스트 결과 + 적립 발견. 중간 보고 없음.
- 서버 접속 금지. 시크릿 값 생성·커밋 금지.

## W-O1 — 공개 전 정리 6종 (#1224) · 브랜치 `fix/public-prep-1224`

A 보고서 §즉시 처리 권고가 목록 정본. 6건:
1. `SECURITY.md`의 취약점 신고·advisory 링크를 실소유 `yeomyeonggeori/momo`로(구 `Dawn-kim-official` 전수 grep — `publish-images.yml`의 GHCR 경로도 함께. 단 그 워크플로의 **경로 문자열만** 고치고 활성화는 건드리지 말 것).
2. 비DNS 신규 노출 IP 1건 제거(A 보고서가 위치 특정 — `handoffs/2026-07-29-resume-batch3.md`의 SSH /32·VPC/Subnet/ACG 번호 포함 — 해당 줄을 `<redacted>`로. 문서 이력 가치 보존, 값만 소거).
3. 개인 Gmail 기본값 4곳 → 자리표시자(`ops@example.com` 류)로.
4. `clients/mobile-spike/android/app/debug.keystore` — 안드로이드 표준 debug 키(비밀 아님)이나 공개 레포 관례상 제거+.gitignore. mobile-spike 트리 전체가 폐기 후보임을 보고에 명시.
5. `.gitleaksignore` 신설 — A의 60건 오탐 전수를 **근거 주석과 함께** 고정(이후 진짜 유출이 신호로 튀게).
6. `NOTICE`의 `TODO(Codex)` 해소 — 부재한 `gen-notices.sh` 호출 제거 또는 최소 구현 중 **더 정직한 쪽**(W-O2의 deny.toml과 중복 금지 — 고지 생성이 크면 그 사실만 적고 축소 해소).
검증: `gitleaks detect`(히스토리 포함) 재실행 — 신규 신호 0. red proof: 가짜 키를 임시 커밋해 gitleaks가 잡는지(잡으면 되돌림).

## W-O2 — 라이선스 게이트 이설 (#1225) · 브랜치 `feat/license-gate-1225`

A 보고서 상위 발견 2·3이 정본. 방침(계획 §방침): **MPL-2.0 allow**.
1. `deny.toml` 신설 — cargo 워크스페이스(server-rust) 대상, 화이트리스트+각 항목 근거 주석(buzz의 deny.toml 형식 참조 가능). `cargo-deny` 미설치 환경 대비: 게이트 스크립트에서 설치 확인+명확한 안내.
2. npm 라이선스 체크를 `web-legacy` → `clients/web`+`clients/mobile`+`packages/momo-core`로 이설(기존 스크립트 재조준 또는 재작성 — 어느 쪽이 작은지 실측 후 선택).
3. `CONTRIBUTING.md`의 fail-closed 목록에서 MPL을 allow로 정정 + 근거 한 줄(파일 단위 약한 카피레프트·buzz 동일 정책·현행 의존 30건).
4. `local_gate.sh`에 라이선스 프로파일 편입(기존 check_spm_licenses 자리 — 그 게이트는 W-S1에서 은퇴 예정이니 **교체가 아니라 병렬 신설**, Swift 게이트는 무접촉).
검증: 새 게이트 green + **red proof 2종**(cargo에 금지 라이선스 가짜 항목 주입 시 빨강 · npm 이설분이 web-legacy가 아닌 정본 트리를 읽음을 증명 — web-legacy에만 있는 패키지로).

## W-O3 — 진입 문서 현행화 (#1226) · 브랜치 `docs/entry-docs-1226`

E 보고서 상위 발견 1이 정본. 대상 6: `AGENTS.md`·`CODEX.md`·`docs/RUN.md`·`docs/INDEX.md`·`docs/TRACKS.md`·`Makefile`.
- 원칙: **성공적으로 잘못된 것을 짓게 하는 문장 제거**. `swift build` 계열 39회→0(단 W-S1 전까지 Swift 트리가 실재하므로 "은퇴 중" 표기가 정직 — 삭제가 아니라 현행 스택 우선+은퇴 고지). `AGENTS.md:22`의 "macOS 우선+Hummingbird" 제품 소개를 현행(Rust/Axum+web/Tauri+RN)으로.
- `Makefile`의 build/test를 현행 스택으로(cargo+npm 워크스페이스) — Swift 타깃은 별칭으로 유지하되 은퇴 고지.
- `infra/rust/README.md`를 루트(README Development 절 또는 INDEX)에서 링크. 단 그 문서의 깨진 첫 명령(B 발견)은 **W-O4 관할** — 여기서 고치지 말고 링크에 "수리 중" 각주.
- `docs/RUN.md`(12회)는 전면 재작성이 크면: 상단에 현행 경로 안내 배너+Swift 절 은퇴 표기(전면 재작성은 #1229와 병합 후보로 보고).
검증: 대상 6파일에서 `swift build|xcodebuild` 실행 지시 grep 0(은퇴 고지 산문은 허용) · docs 게이트 green.

## W-O4 — 최초 소유자 부트스트랩 + 온보딩 함정 (#1227) · 브랜치 `feat/bootstrap-owner-1227`

C 보고서 치명 1·3 + B 부수가 정본.
1. **실측 먼저**: Rust 서버의 현행 소유자/워크스페이스 생성 능력 전수(라우트·env·마이그레이션 012의 fail-closed 계약). C가 밟은 실패 경로(`schema_migrations` 때문에 재실행 불가→DB 파기)를 재현 이해 후 설계.
2. 최소 구현: 최초 부팅 시 소유자 생성의 1급 경로 — 후보: env 기반 bootstrap(`MOMO_BOOTSTRAP_OWNER_EMAIL` 류, **이미 있으면 재사용**·Swift installer가 "sets the initial owner from the secret environment"였던 선례) 또는 idempotent CLI/one-shot. 핵심 계약: **재실행 안전(멱등)** + seed fail-closed 유지(012 무접촉) + 이미 소유자 있으면 no-op.
3. `infra/.env.example`·`infra/rust/rust-smoke.env.example` 수리: `CENT_API_URL` 호스트 실행 경고(DATABASE_URL과 동일 형식), `PROVIDER_LINK_MASTER_KEY` 등 compose가 `:?`로 요구하는 전 키를 템플릿에(생성법 주석 포함, 값은 자리표시자).
4. `infra/rust/README.md` §2→§3 경로가 무수정 템플릿+문서 순서만으로 exit 0 되게.
검증: 깨끗한 DB에서 문서 경로로 부팅→소유자 로그인 성공을 스크립트로 증명(C의 e2e smoke 재사용 가능 — `scratchpad`의 `clients/web/e2e/smoke.mjs` 참조, C 보고서에 경로) + **재실행 멱등 증명** + red proof(부트스트랩 env 없이 기동 시 여전히 fail-closed).
서버 코드 접촉 시: `cargo test --workspace` + 병합 트리 8레인.
