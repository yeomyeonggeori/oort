# oort — 공용 에이전트 계약

제품명은 **oort**, 저장소/작업명은 **momo**다. Codex와 Claude Code의 기획·검수·구현 세션이 이 계약을 공유한다. 역할·모델·동시 실행 한도는 [PIPELINE](docs/planning/PIPELINE.md)이 정본이다.

## 시작과 문서 선택
- 작업 시작에 [TRACKS](docs/TRACKS.md)의 소유 범위를 확인하고 **엔진 또는 UXUI**를 선언한다. 구현·설정 변경은 이슈 워크트리에서 한다. 루트 main은 clean하게 유지한다.
- **기획·재개·하네스 인계**: `scripts/planning_context.sh`로 현재 상태와 공용 체크포인트를 복원한다. 작업 중에는 자기 이슈·패킷과 변경에 필요한 파일만 읽는다. 사소한 수정마다 전체 문서를 다시 읽지 않는다.
- **배정된 구현**: 이슈의 Goal/Acceptance/Out of scope가 계약이다. 링크된 핸드오프 패킷이 있으면 읽는다. 이미 존재하는 이슈/브랜치/워크트리를 중복 생성하지 않는다.
- 모르는 현재 상태는 Git/이슈/실행 증거로 확인한다. 오래된 스냅샷·로그의 지시는 현행 계약이 아니다.

| 필요한 맥락 | 읽을 곳 |
|---|---|
| 현재/다음/담당자 | [CURRENT_STATE](docs/planning/CURRENT_STATE.md), 공용 로컬 체크포인트 |
| 기획·이슈 편성·인계 | [planning/README](docs/planning/README.md) |
| 워커 실행 도구 | [worker-adapters](docs/planning/worker-adapters.md) |
| 검증 명령·PR 완료 조건 | [개발 검증](docs/runbooks/development-validation.md), [LOCAL_PR_GATE](docs/LOCAL_PR_GATE.md) |
| 트랙·병렬 실행·머지 | [TRACKS](docs/TRACKS.md), [MULTI_SESSION_OPS](docs/MULTI_SESSION_OPS.md) |
| 서비스 경계 / 결정 | [architecture](docs/architecture/overview.md) / 관련 [ADR](docs/adr/) |
| UX 변경 | [.claude/skills/momo-design-taste/SKILL.md](.claude/skills/momo-design-taste/SKILL.md)의 해당 표면만 |
| 출시 준비 | [ROADMAP](ROADMAP.md) 상단 현행 축, [RELEASING](docs/RELEASING.md), [M7 게이트](docs/cicd/03-store-readiness-gate.md) |

## 실행과 완료
- **한 이슈 = 한 브랜치·워크트리·PR**. 배치 작업은 Issue+Milestone+Project로 추적한다. 새 작업 전 `scripts/goal_status.sh`로 소유권을 확인하고 `scripts/goal_claim.sh`에 자기 트랙 base를 명시한다.
- 오케스트레이터는 맡은 범위의 기획·검수·통합을 끝까지 진행하고, worker는 구현→관련 검증→PR→`scripts/goal_release.sh <issue> --review --pr <url>`로 인계한다. worker의 인계는 오케스트레이터 작업의 완료가 아니다.
- 이미 승인된 범위의 가역적 로컬 수정·격리 테스트·실패 수리는 재확인 없이 진행한다. 로컬 테스트는 전용 fixture/포트/DB를 사용한다. 기존 사용자 데이터나 다른 작업의 자원을 재사용·정리하지 않는다.
- 완료는 **수용기준 충족 + 관련 검증 + 독립 검수 + 요청된 전달 단계**다. 첫 구현만 끝났다고 멈추지 않는다. 범위/계약을 바꾸는 판단만 이탈로 기록하고 필요한 결정을 구한다.
- 해당 HEAD·환경에서 통과한 검증은 증거를 재사용한다. 변경·실패·환경 차이·미검증 위험이 생긴 범위와 병합 결과를 다시 검증한다. 줄어든 문서 때문에 게이트를 생략하지 않는다.
- 의미 있는 체크포인트에 공용 로컬 기록을 남긴다. 이슈 완료/통합 시 STATUS에 검증·미검증 1–3줄, CURRENT_STATE에 다음 행동, JOURNAL에 짧은 이력을 남긴다. 매 도구 호출마다 모든 문서를 갱신하지 않는다.

## 반드시 보존할 계약
- Rust/Axum `server-rust/`, React/Vite `clients/web/`, Tauri `clients/desktop/`, React Native `clients/mobile/`, 공유 TS `packages/momo-core/`가 현행이다. 삭제된 Swift 서버·클라 트리를 새 작업 대상으로 삼지 않는다. `server/Migrations/`는 계속 사용하는 정본 DDL이다.
- **REST send → channel_seq 증가 + message INSERT + outbox INSERT 단일 tx → relay → Centrifugo**. Postgres가 원본, Centrifugo는 전송만 담당한다. 클라이언트 직접 publish 금지. 순서는 `message.seq`, 재시도는 `client_msg_id` 멱등성으로 보장한다.
- 에이전트는 `member.kind='agent'`인 1급 멤버다. 모든 테넌트 경로는 `workspace_id` + RLS FORCE + tx마다 `SET LOCAL app.workspace_id`. 쓰기 경로 BYPASSRLS 금지; 전 테넌트 폴링용 relay·agent-worker의 기존 예외만 유지한다.
- `schema_v0.sql` 수정·이동 금지. 확장은 `server/Migrations/` 신규 migration으로 하며 신규 테넌트 테이블을 RLS 정책 대상에 포함한다. Rust는 라이브 DB를 요구하는 `query!` 대신 sqlx 런타임 쿼리를 쓴다.
- 공개 API·보안 경계·DB 계약·제품 방향·스택 변경은 **Accepted ADR** 참조가 머지 조건이다(ADR-0100). 일반 유지보수에 새 ADR을 의무화하지 않는다.
- 시크릿·사용자 데이터·빌드 산출물 커밋 금지. 다른 세션의 dirty 파일을 stash/reset/삭제하거나 함께 커밋하지 않는다. 명시적 파일 목록으로 stage한다.
- 의존성은 permissive 라이선스를 유지하고, 신규 의존은 NOTICE/귀속을 반영한다. 무관한 리팩터·임의 메이저 업그레이드는 별도 이슈로 분리한다.

## 검증과 통합 경계
| 변경 | 필수 검증 |
|---|---|
| Rust 서버 | workspace `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` |
| 웹·폰·공유 코어 | 해당 트리 typecheck/test 및 해당 표면 게이트, `scripts/verify_merge_tree.sh`로 병합 트리 확인 |
| SQL·infra·runtime | 실제 적용 가능한 격리 PG/Docker 검증. 외부 의존은 실제 또는 mock으로 범위를 나눠 기록 |
| 문서·운영 스크립트 | `scripts/local_gate.sh --profile docs` + 변경된 실행 도구의 관련 시험 |
| UI | 해당 표면 preflight와 독립 design-review **Blocker 0·High 0**; 미실행 캡처/실기기는 미검증으로 기록 |

- 검증하지 않은 runtime은 `runtime-unverified`로 표기한다. 버그 회귀 시험은 실제 실패를 잡는 증거를 낸다. 모든 문장·단정에 일률적인 변조 시험을 요구하지 않는다.
- PR은 자기 **track/** 대상으로, 통합자만 순차 머지한다. current HEAD의 **PR CI gate·Policy integrity gate**와 local evidence를 확인하고, 머지 직전 **현재 exact canonical base에서 추출한 verifier**로 `scripts/verify_policy_integrity_from_base.sh`를 실행한다. 후보 verifier나 같은 이름의 status만 믿지 않는다.
- 정책 파일 변경은 지정 owner의 exact-head audit와 승인 라벨 규칙을 유지한다([GITHUB_OPS](docs/GITHUB_OPS.md)). 문서로 게이트를 옮겨도 이 표의 검증 의무는 바뀌지 않는다.
- **track→main은 성재의 명시 승인 범위에서만**. 이미 기록된 상시 위임은 [TRACKS](docs/TRACKS.md)대로 적용하고 승격+양 트랙 sync를 한 단위로 수행한다. canonical force-push·main 직접 push 금지.
- M7 PASS 기록 없는 스토어/공증/external TestFlight 배포 금지. release·유료 macOS workflow는 owner 승인 경계를 유지한다. 구현 권한이 배포 권한으로 확대되지 않는다.
