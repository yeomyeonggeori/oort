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

`#[ignore]` PG 시험은 PR 대신 야간(`security-nightly`)이 지킨다. **야간이 초록이어야 그 시험이 있는 것이다** — 아무도 지키지 않는 `#[ignore]` 시험을 늘리지 않는다. 야간이 빨강이면 고친다. 지금 못 고치는 시험만 `infra/security-pack/nightly-quarantine.txt`에 시험 함수 이름·소유 이슈(`#번호`)·기한(오늘부터 60일 이내)·사유로 올린다. 격리 시험은 전량 실행에서 빠지지만 따로 계속 돌아 결과가 야간 요약에 늘 보이고, 기한이 지나면 야간이 빨강이 된다. 보안 주장(`docs/security/claims.yaml`)의 증거 시험은 격리할 수 없다. 야간은 시험 실행 파일마다 새 DB(템플릿 복제, `infra/security-pack/nightly-target-db.sh`)에서 돌아 한 타깃이 남긴 상태가 다른 타깃을 깨지 못한다. 그래도 한 실행 파일 안의 시험끼리와 PR의 Security pack(한 DB를 공유)에서는, 시험이 DDL로 만든 것(테이블·함수·트리거)을 그 시험이 DDL 결과를 읽은 직후에 지운다.

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

변경 표면에 맞는 typecheck/test와 게이트를 실행한다. 웹·폰·코어 계약 변경은 브랜치 단독 결과에 더해 병합 트리가 통과해야 한다(스택 PR은 착륙 때 `--typecheck-only`, 전체는 스택 검증 1회 — [PIPELINE](../planning/PIPELINE.md) §5). 표면별 UI 규칙은 design-taste 라우터를 따른다. 폰에는 web preflight를 적용하지 않는다.

## 문서·스크립트·runtime
문서 PR/통합에도 docs 게이트를 수행한다. 사용자가 요청한 사소한 문서의 로컬 diff 확인만은 AGENTS의 제한된 예외를 따른다. 이 profile은 순수 문구 검사만이 아니며 일부 Docker 계약 시험도 포함한다.
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

기획 복원·소유권 도구를 변경하면 임시 저장소/워크트리 기반 시험을 실행한다(네트워크·기존 작업 자원 무접촉):
```bash
scripts/tests/test_planning_session.sh
scripts/tests/test_planning_context.sh
scripts/tests/test_goal_status_board.sh
```

PG18·Centrifugo는 격리 환경에서 실행한다. 구체적 기동 계약은 [infra/rust/README](../../infra/rust/README.md), self-host 절차는 [SELF_HOST](../SELF_HOST.md)를 따른다. 실제 provider/APNs 등의 외부 의존과 mock 결과는 따로 표시한다. DB 없는 skip은 runtime PASS가 아니다.

## 완료·증거
- Issue Acceptance, 기존 패킷/ADR, 관련 게이트를 충족한다. 스키마 확장은 신규 migration으로만 하고 원본 schema_v0.sql은 보존한다.
- clean HEAD에서 실행 시간·commit·명령·결과·실제 환경·미검증 범위를 남긴다. 수정·환경 차이가 없고 관련 증거가 유효하면 같은 테스트를 관성적으로 반복하지 않는다. 병합으로 생긴 차이는 검증한다.
- 버그 회귀 시험은 실제 동작 경로에서 결함을 감지해야 한다. 무관한 Markdown 수정이나 단순한 가역적 문구 변경마다 새 테스트를 만들 필요는 없다.
- PR 본문은 해당 이슈, 한 일, 검증과 `runtime-unverified`, 요약, 남은 것, 계획 이탈(없으면 없음), worker 인계를 포함한다. 템플릿은 [.github/pull_request_template.md](../../.github/pull_request_template.md).
- worker는 PR과 검증을 넘기고, 통합자가 독립 검수와 current-head/base 정책 확인 후 track으로 순차 통합한다. release/store 권한은 별도다.

## 작업 끝 뒤처리
시험·게이트·워커가 만든 자원은 성공·실패·중단과 상관없이 만든 쪽이 거둔다(#5606). 11-09에 이 규칙이 없어 디스크가 가득 찼다: 시험 컨테이너의 이름 없는 볼륨 197개(약 9GB), 바깥 빌드 폴더, 착륙이 끝난 작업 폴더가 쌓였다.

- **시험·게이트 스크립트의 컨테이너**: 스스로 끝나는 일은 `docker run --rm`으로 띄운다. 지우는 곳은 늘 `docker rm -f -v`다. `--rm`으로 띄웠어도 `-v` 없이 강제로 지우면 이미지가 선언한 VOLUME(postgres·Hermes·caddy)이 이름 없는 볼륨으로 남는다(실측). `-v`는 그 컨테이너의 이름 없는 볼륨만 지우고 이름 있는 볼륨은 건드리지 않는다. compose 스택은 마지막 정리에서 `down -v --remove-orphans`로 내린다. 운영 도구가 데이터를 지키려고 볼륨을 남기는 곳(개발 스택 멈추기, 볼륨 보존 재배포)은 이 규칙의 대상이 아니다.
- **이름과 라벨**: 시험 컨테이너에는 momo나 oort가 든 이름(예: `oort-day2-pg-$$`)이나 실행 라벨을 준다. 이름 없는 컨테이너는 남은 자원 검사도, 이름으로만 움직이는 회수 도구도 찾지 못한다.
- **임시 폴더**: 만든 직후 EXIT trap으로 지운다(INT·TERM은 `exit 130`·`exit 143`으로 EXIT trap에 넘긴다). 지울 때는 그 변수의 경로만, mktemp가 만든 모양일 때만 지운다. 예: `case "$TMP" in "${TMPDIR:-/tmp}"/oort-x.*) rm -rf -- "$TMP" ;; esac`. 빈 값·`/`·와일드카드는 지우지 않고, 호출자가 넘긴 출력 폴더도 지우지 않는다.
- **게이트 끝 검사**: `scripts/local_gate.sh`는 첫 단계 전과 마지막 정리 뒤에 `scripts/lib/leftover_check.sh`로 이름에 momo·oort가 든 컨테이너·볼륨(이 실행의 runtime DB 라벨 포함)과 임시 경로를 비교해, 새로 생겨 남은 것을 로그와 evidence에 한 줄로 남긴다. 경고만 하고 게이트를 막지 않는다. 같은 때 도는 다른 칸 것이 잡힐 수 있으니 이름을 보고 판단한다. 이름 없는 볼륨은 이 검사 범위 밖이라 위 `-v` 규칙이 막는다. 범위 밖 자원은 목록으로도 보지 않는다.
- **워커 인계 전**: 자기가 띄운 프로세스(정확한 PID로 끝낸다)·컨테이너(`-v`로)·임시 폴더·시뮬레이터 복제본을 0으로 만들고, 인계에 「남긴 자원 0」을 적는다. 일부러 남긴 것이 있으면 무엇을 왜 남겼는지 적는다. 다른 칸·다른 프로젝트 자원은 보지도 지우지도 않는다.
- **착륙 뒤 통합자**: 착륙한 이슈의 작업 폴더·바깥 빌드 폴더(그 칸의 cargo target)·검수 빌드 폴더·시험 컨테이너를 바로 거두고 거둔 크기를 남긴다. 이 일은 레포 밖 planner 도구가 하므로 레포에는 규칙만 둔다.
