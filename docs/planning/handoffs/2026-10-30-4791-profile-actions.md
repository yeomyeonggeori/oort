# #4791 S1 칸 6 구현 인계

- issue: [#4791](https://github.com/yeomyeonggeori/oort/issues/4791)
- status: ready (구현·집중 검증 diff 인계, Git 메타데이터 쓰기 제한으로 커밋 미완료)
- track / base: engine + UXUI(폰·웹), `track/engine` @ `b8d8fd6df`
- 전달 단계: 사용자 요청은 로컬 커밋까지예요. `git add`와 `git commit`이 공유 Git의 이 워크트리 `index.lock` 생성에서 `Operation not permitted`로 거절됐어요. HEAD는 `b8d8fd6df`이고 변경은 stage하지 않은 상태로 보존돼 있어요. 커밋 완료로 취급하지 말아 주세요. push·PR·goal_release·검수 요청은 실행하지 않았어요.
- 복구 보조: 이 호스트의 `/private/tmp/4791-handoff/`에 두 패치와 명시적 파일 목록을 저장하고 reverse apply 검사를 통과했어요. 원래 워크트리에는 이미 모든 변경이 있어 패치를 다시 적용하지 않아요. 공유 로컬 체크포인트는 `<git-common-dir>/oort-coordination/worker-4791-handoff.json`이에요.
- 계약: [ADR-0186 v7](../../adr/0186-agent-workspace-actions.md#증보-2026-10-30--내-이름내-사진에이전트-이름에이전트-사진-v7-4791). 수용기준의 정본은 이슈예요.

## 변경과 통합할 때 볼 곳

- `member.display_name.set`: 요청 run의 사람만 대상으로 삼아요. 직접 이름 변경과 같은 정규화·쓰기·`member.renamed` 방송·감사 1행을 쓰고, 이전 이름 pin이 달라지면 다시 제안해요. 핸들·과거 멘션은 그대로예요.
- `member.avatar.set`: 기존 첨부 id와 generated/retrieved base64를 받아요. 대상 인자는 여전히 없어요. 같은 디코더·상한·재인코딩·승인별 staged pin을 써요.
- 팀 AI에 사람 이름·사진을 열고 이미지 준비를 워커에 연결했어요. Agent Port의 에이전트 사진도 해당 run 요청자의 같은 대화 첨부를 받아 1:1 DM에서 이어져요. **#4792의 멘션·DM 라우팅·연결 범위는 바꾸지 않았어요.**
- 워커가 로컬 이미지 파일을 읽어야 해서 `momo-drive`에 reader 생성자를 더했어요. 기존 writer 생성자는 부팅 때 진행 중 업로드를 정리하므로 워커에서 재사용하면 안 돼요. reader는 디렉터리 생성·쓰기 probe·정리를 하지 않고 쓰기 메서드도 거절해요. self-host overlay의 워커 볼륨은 읽기 전용이고, API가 보관소 디렉터리를 초기화한 뒤 열도록 API healthy를 기다려요. Docker 실행은 하지 않았어요.
- 폰 `MessageRow`와 웹 `AgentCard`는 사진 블록을 고르는 두 줄만 바꿨어요. 공용 결정 컨트롤은 프로필 승인 직후 실제 roster를 읽어 이름·사진 캐시와 자기 세션 메타데이터를 갱신해요. 계정이 바뀌면 늦은 결과를 버리고, 자격 증명은 바꾸지 않아요. 기존 카드 모델/컴포넌트에서 이름 전후 행과 두 사진을 그려요. 사진의 이전 주소는 서버가 만든 버전별 인가 경로만 통과해요. 역할 문구는 두 사람 행동에 맞춰 「요청한 본인」으로 일반화했어요.
- 레지스트리 16개, Agent Port 12개(팀 AI 전용 4개 제외), 팀 AI 11개예요. `docs/SELF_HOST_AGENT.md` 표·도구 설명·OpenAPI도 맞췄어요.
- 이 base에는 `scripts/verify_web_generated_types.sh`와 웹 OpenAPI 생성 타입 파일이 없어요(`git ls-tree HEAD` / `rg --files` 확인). 웹/코어 API는 행동 id를 string으로 읽어요. 생성 파일을 임의로 만들거나 정책 스크립트를 추가하지 않았어요. 통합 base에 해당 생성 계약이 추가됐다면 planner가 그 base의 명령을 돌려 주세요.

## 변경 범위 검증

전달된 전용 PG18/pgvector(localhost 25791)를 썼어요. HTTP 서버는 시험마다 임시 포트이고 API는 `momo_app`, 팀 AI 제안은 기존 `momo_worker` 역할이에요. 실제 PG·실제 Axum 라우터·실제 Agent Port/MCP 제안·승인·DB 반영을 확인했고, Drive는 시험용 메모리 보관소예요. `runtime-unverified`: 실제 provider의 이미지 생성/가져오기·자연어 도구 선택, Centrifugo relay 배송, Docker 부팅·Google Drive 연결, 실제 폰·데스크탑 화면은 스택 검증 대상이에요.

범위 제한에 따라 전체 workspace 시험·전체 docs 게이트·병합 트리 게이트·Docker·시뮬레이터·Xcode·캡처는 실행하지 않았어요. 독립 보안 검수(착륙 전 최대 2회)와 design-review는 planner 단계예요.

Rust 명령은 `server-rust/`에서 실행하는 표기예요(실행 때는 루트에서 `--manifest-path server-rust/Cargo.toml`을 썼어요). PG 명령은 제공받은 전용 DB의 `DATABASE_URL`과 libpq 환경을 사용해요. 비밀번호·접속 문자열은 이 문서에 넣지 않아요.

| 실행한 명령·범위 | 결과 |
|---|---|
| `cargo fmt --all --check` | PASS |
| `cargo clippy -p momo-server -p momo-agent-worker -p momo-workspace-actions -p momo-agent -p momo-mcp -p momo-drive --all-targets -- -D warnings` | PASS |
| `cargo test -p momo-server --lib routes::actions::tests` | 38 PASS, registry / 도구 / OpenAPI 드리프트 포함 |
| `cargo test -p momo-agent --lib actions::tests` | 48 PASS |
| `cargo test -p momo-mcp --lib tools::tests` | 변경된 도구 파일 33 PASS |
| `cargo test -p momo-workspace-actions --lib action_resolve::tests` 및 `--lib team_ai::tests` | 각각 6 / 12 PASS |
| `cargo test -p momo-drive --lib a_profile_reader_keeps_live_uploads_and_cannot_mutate_the_archive_4791` | 1 PASS |
| `cargo test -p momo-agent-worker --lib profile_tests_4791` | 1 PASS |
| `cargo test -p momo-server --test agent_port_tools_conformance_pg 4791 -- --ignored --nocapture --test-threads=1` | 실 PG 4 PASS: 팀 AI·Agent Port DM 각각 네 행동, 자기 이름·generated 사진, 남의 대상/승인/첨부·탈퇴 DM 거절 |
| 같은 PG 명령에서 필터 `member_avatar_set_` | 기존 사진 권한·해시·상한·거부·폰 크기·DM 회귀 8 PASS |
| 같은 PG 명령에서 필터 `an_agent_renames_itself_after_its_owner_approves`, `an_agent_proposes_a_generated_avatar_and_only_the_approved_bytes_are_served`, `a_workspace_image_can_be_the_avatar_only_if_the_agent_could_read_it` | 각각 1 PASS. PG 합계 15 PASS |
| `npm --prefix packages/momo-core run typecheck`, `npm --prefix clients/web run typecheck`, `npm --prefix clients/mobile run typecheck` | 세 트리 PASS |
| `npm --prefix packages/momo-core test -- src/features/approvals/avatarPreview.test.ts src/features/approvals/actionRole.test.ts src/features/approvals/profileChange.test.ts src/features/timeline/actionResultCard.test.ts` | 46 PASS |
| `npm --prefix clients/web test -- src/features/timeline/avatarApprovalCard.test.tsx src/features/timeline/ApprovalActions.transport.test.tsx` | 19 PASS |
| `npm --prefix clients/mobile test -- --runInBand --watchman=false __tests__/avatarApprovalCard.test.tsx` | 15 PASS. 기본 Watchman 실행은 sandbox 접근 오류여서 비활성화했어요 |
| 각 트리의 `node_modules/.bin/eslint`에 변경한 소스·시험 파일만 전달 | core / web / mobile 모두 exit 0 |
| `npm --prefix packages/momo-core run gate:purity` | 525 파일 PASS |
| `scripts/design_preflight_web.sh` | web 14/14, core 6/6, 이름 검사 PASS |
| Python PyYAML로 OpenAPI·compose 2개·새 Maestro flow 로드, compose 의존 그래프 검사 / `git diff --check` | 구문·순환 없음·공백 검사 PASS |

Rust 집중 단위 시험 합계는 139개예요. 실 PG에서는 네 행동의 승인 후 결과 메시지/outbox와 프로필 변경 감사가 각각 한 번 생겼는지 확인해요. relay가 Centrifugo까지 보냈다는 뜻은 아니에요.

## 스택 검증 메모

바뀐 화면은 폰 대화의 승인 카드와 웹/데스크탑 공용 승인 카드예요. 이름 카드의 「바꾸기 전/바꾼 뒤」 글자, 사람·에이전트 사진 카드의 두 사진, 결정 권한·실패 문구를 확인해 주세요.

- 팀 AI와 Agent Port 각각 DM에서 네 부탁을 보내 제안→승인→저장된 프로필→결과 줄까지 확인해 주세요. 사진은 첨부와 generated/retrieved 이미지 두 출처를 확인해 주세요. 다른 사람·관리자가 사람 프로필 카드를 승인하면 거절돼야 해요.
- 밝음/어두움, 폰 큰 글자, 웹 200% 확대·좁은 폭, 긴 한글/영문 이름, 동작 줄이기를 확인해 주세요. 사진 없음·받는 중·404·오프라인·승인/거부/만료 상태와 키보드·VoiceOver 경로도 확인해 주세요.
- 기존 프로필이 화면에 반영되는지도 확인해 주세요. 승인한 기기는 즉시 재조회하고, 다른 기기는 기존 30초 roster 재조회 계약을 사용해요. 다른 기기에서의 반영과 앱을 다시 열었을 때의 이름·사진을 함께 확인해 주세요.
- Maestro: 새 `clients/mobile/maestro/4791-profile-actions.yaml`은 **추가만 했고 실행하지 않았어요**. `PROFILE_CHANNEL_ID`, `MY_NAME_APPROVAL_ID`, `MY_PHOTO_APPROVAL_ID`, `AGENT_NAME_APPROVAL_ID`, `AGENT_PHOTO_APPROVAL_ID`를 실제 제안이 돌려준 값으로 넘겨요. 별도 채널에 Agent Port 제안자 2명이 2개씩 네 카드를 순서대로 시드해요(제안자별 pending 상한 3개, 서로 다른 run, 같은 대상·같은 행동의 중복은 금지). 팀 AI 네 장면은 각 제안 직후 결정하는 순차 흐름으로 확인해요. 기존 `30-approval.yaml`은 일반 도구 승인 회귀용이며 오래된 2단 승인 단언이 있어 최신 1회 승인과 별개로 점검해야 해요.
- Playwright: `clients/web/gates/gate-approvals.mjs`의 일반 승인 회귀를 다시 돌리고, 대화 타임라인에서 네 프로필 카드를 승인해 주세요. 새 카드의 DOM·인가된 이전/이후 이미지 fetch는 `avatarApprovalCard.test.tsx`에서 확인했지만 실제 브라우저 레이아웃은 미검증이에요.
- 기계 preflight는 캡처 검수가 아니에요. 독립 design-review **B0·H0**는 아직 판정하지 않았어요.

## 최종 체크포인트

사보타주 **21/21 RED**를 확인했고 모두 원복했어요. 컴파일 실패는 RED로 세지 않았어요. 아래는 실행한 변조와 실제 실패한 단언이에요. 다음 행동은 Git 메타데이터를 쓸 수 있는 planner가 이 diff를 1~2개 커밋으로 저장→독립 보안 검수→스택 착륙 절차→스택 UI/전체 시험이에요. 권장 구분은 Rust·infra·ADR/OpenAPI 계약과 클라이언트·이 인계 문서예요. 승격·배포 권한은 포함하지 않아요.


| 사보타주 | 실패한 단언 | 결과 |
|---|---|---|
| MCP enum에서 새 행동 제거 | registry = 도구 enum = OpenAPI | RED |
| 사람 이름의 대상 키 허용(도구 schema + normalizer) | 정상 길이 targetHandle 주입을 400으로 거절 | RED |
| 사람 사진의 대상 키 허용(도구 schema + normalizer) | generated 사진의 targetHandle 주입을 400으로 거절 | RED |
| 요청자 승인 게이트 + 실행 백스톱 제거 | 관리자·소유자·다른 사람이 결정하면 403 | RED |
| 저장 pin 대조 제거 | 카드 이후 이름이 바뀌면 409, pending 유지 | RED |
| 자기 이름 방송 제거 | 실제 member.renamed outbox 프레임 존재 | RED |
| 이름 감사 action 변경 | member.renamed 감사 정확히 1행 | RED |
| 입력 바이트 상한 제거 | 정상 PNG에 패딩을 더해 44,001바이트면 거절 | RED |
| stored 이미지 bytes digest 대조 제거 | immutability 우회 변조도 승인 거절 | RED |
| 미리보기의 요청자 대조 제거 | 관리자·소유자·다른 사람의 읽기는 404 | RED |
| 첨부의 대화 조건 제거 | 다른 대화의 자기 사진 거절 | RED |
| 첨부의 작성자 조건 제거 | 같은 대화의 다른 사람 사진 거절 | RED |
| decoder allocation 제한 제거 | decoder 자체의 할당 상한 거절 | RED |
| 보관소 reader의 read_only 제거 | 업로드 생성·적용·삭제 거절, API 진행 중 업로드 보존 | RED |
| 준비한 이미지의 요청자/run 대조 제거 | 다른 요청자·run의 준비 결과 거절, 카드 증가 0 | RED |
| 준비한 이미지 출처 대조 제거 | attachment/generated 출처 불일치 거절 | RED |
| 팀 AI 사진의 시간당 상한 제거 | 거절도 집계하여 rate_limited | RED |
| 팀 AI 이미지 실패 감사 제거 | subject=요청자의 unsupported_type 감사 1행 | RED |
| 클라이언트의 계정/워크스페이스 대조 제거 | 늦은 roster가 다른 계정·캐시를 갱신하지 않음 | RED |
| 긴 요청의 이미지 id 예산 예약 제거 | 최종 1,500자 안에서 첨부 id 20개 보존 | RED |
| DM 현재 참여 + fresh handle 채널 범위 대조 제거 | 탈퇴한 에이전트는 거절 전에 Drive 사진도 읽지 않음 | RED |

마지막 경계의 현재 참여 대조만 제거한 중간 변조는 fresh handle의 채널 범위 검증이 먼저 거절해 살아남았어요. 두 방어막을 함께 제거하고 파일 읽기 횟수까지 확인한 최종 변조가 RED예요. 앞의 대상 키 주입도 도구 schema와 domain normalizer를 함께 열어 검증해요. 한 방어막이 남아서 거절된 결과를 그 방어막 자체의 RED 증거로 세지 않았어요.

변조 로그와 재현 드라이버는 이 작업 호스트의 `/private/tmp/4791-sabotage/` 및 `/private/tmp/4791-sabotage.py`에 있어요. 이 경로와 원시 로그(로컬 경로 포함)는 공개 PR에 복사하지 말고, 위 표·검증 명령·요약 결과를 PR 본문으로 옮겨 주세요.
