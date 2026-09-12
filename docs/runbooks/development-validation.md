# 개발 검증과 PR 전달

공용 불변식과 필수 검증 등급은 [AGENTS](../../AGENTS.md), profile/evidence 형식은 [LOCAL_PR_GATE](../LOCAL_PR_GATE.md)다. 이 페이지의 실행 명령은 `scripts/check_docs_commands.py`의 runbook 검사 대상이다.

## Rust
현행 서버는 Rust/Axum이다. MSRV는 server-rust 1.88, desktop/src-tauri 1.89 이상이며 둘을 만지면 stable ≥1.89를 사용한다. 두 Cargo manifest 모두 virtual workspace라 fmt의 **--all을 생략하지 않는다**.

서버 변경의 필수 게이트:
```bash
cargo fmt --all --check --manifest-path server-rust/Cargo.toml
cargo clippy --manifest-path server-rust/Cargo.toml --workspace --all-targets -- -D warnings
cargo test --manifest-path server-rust/Cargo.toml --workspace
```

fmt는 workspace 전체 기준이다. 기존 formatting drift가 있으면 영향과 정리를 기록한다. sqlx는 라이브 DB 없이 빌드되는 런타임 쿼리 API를 사용한다.

## 웹·폰·공유 코어
npm lockfile은 루트(packages), clients/web, clients/mobile 세 곳이다. 관련 의존성이 설치돼 있으면 매번 재설치하지 않는다. 처음 준비할 때:
```bash
npm ci
npm --prefix clients/web ci
npm --prefix clients/mobile ci
```

관련 표면의 검증과 cross-client 병합 트리:
```bash
make ts-check
make ts-test
scripts/local_gate.sh --profile web
scripts/verify_merge_tree.sh
```

변경 표면에 맞는 typecheck/test와 게이트를 실행한다. 웹·폰·코어 계약 변경은 브랜치 단독 결과에 더해 병합 트리가 통과해야 한다. 표면별 UI 규칙은 design-taste 라우터를 따른다. 폰에는 web preflight를 적용하지 않는다.

## 문서·스크립트·runtime
문서만 바뀌어도 docs 게이트를 수행한다. 이 profile은 순수 문구 검사만이 아니며 일부 Docker 계약 시험도 포함한다.
```bash
scripts/local_gate.sh --profile docs
```

스크립트는 구문 검사와 실제 동작을 확인하는 관련 시험을 실행한다. 필요할 때의 예:
```bash
python3 -m py_compile adapters/hermes/momo_adapter.py adapters/prime/adapter.py
actionlint .github/workflows/*.yml
scripts/local_gate.sh --profile runtime-db
scripts/local_gate.sh --profile runtime-agent
```

PG18·Centrifugo는 격리 환경에서 실행한다. 구체적 기동 계약은 [infra/rust/README](../../infra/rust/README.md), self-host 절차는 [SELF_HOST](../SELF_HOST.md)를 따른다. 실제 provider/APNs 등의 외부 의존과 mock 결과는 따로 표시한다. DB 없는 skip은 runtime PASS가 아니다.

## 완료·증거
- Issue Acceptance, 기존 패킷/ADR, 관련 게이트를 충족한다. 스키마 확장은 신규 migration으로만 하고 원본 schema_v0.sql은 보존한다.
- clean HEAD에서 실행 시간·commit·명령·결과·실제 환경·미검증 범위를 남긴다. 수정·환경 차이가 없고 관련 증거가 유효하면 같은 테스트를 관성적으로 반복하지 않는다. 병합으로 생긴 차이는 검증한다.
- 버그 회귀 시험은 실제 동작 경로에서 결함을 감지해야 한다. 무관한 Markdown 수정이나 단순한 가역적 문구 변경마다 새 테스트를 만들 필요는 없다.
- PR 본문은 해당 이슈, 한 일, 검증과 `runtime-unverified`, STATUS 영향, 남은 것, 계획 이탈(없으면 없음), worker 인계를 포함한다. 템플릿은 [.github/pull_request_template.md](../../.github/pull_request_template.md).
- worker는 PR과 검증을 넘기고, 통합자가 독립 검수와 current-head/base 정책 확인 후 track으로 순차 통합한다. release/store 권한은 별도다.
