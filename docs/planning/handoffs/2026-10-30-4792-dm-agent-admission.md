# #4792 · S1 칸 7 · 워커 인계

엔진 트랙, base `track/engine`. owner가 확정한 **다른 사람 모두의 동의 후 같은 DM에 합류**를 구현했다. ‘부른 메시지만 보는 손님’ 안은 적용하지 않았다. 워커 전달 단계는 로컬 커밋이며 push·PR·goal_release·검수 요청은 planner가 맡는다.

## 커밋 차단과 복구

`git add`가 `/Users/kwakseongjae/projects/momo/.git/worktrees/4792-engine-uxui-docs-dm-dm-owner-10-30/index.lock` 생성에서 `Operation not permitted`로 거절됐다. 디렉터리/파일의 owner와 일반 모드는 정상이나 현재 managed sandbox가 공용 Git 메타데이터 쓰기를 허용하지 않는다. **현재 브랜치는 미커밋 상태다.**

권한 있는 planner 하네스에서 이 워크트리의 `claudedocs/worker-4792/commit-recovery.sh`를 실행하면 명시한 파일만 엔진/화면 두 커밋으로 묶는다. 시작 HEAD와 빈 index를 확인하고, push·PR·goal_release는 실행하지 않는다. 같은 폴더의 `4792.patch`는 새 파일까지 포함한 전체 변경이며, `evidence/`에 검증/사보타주 원문을 보관한다.

## 구현

- [ADR-0217](../../adr/0217-consented-agent-group-dm.md) Accepted 및 ADR-0162 증보 6. 두 명 가정의 전수 표와 위협·폐기 계약을 담았다.
- migration 156: tenant FORCE RLS의 admission 원장, 시각+seq 읽기 경계와 호출 메시지 하나의 예외, request-local 인증 주체의 message restrictive RLS, worker에도 적용하는 DM 쓰기 트리거, 동의받은 hosted 연결 전달 합집합.
- DM의 사람 멘션 → 기존 행동 카탈로그의 서버 전용 `dm.agent.admit` → 다른 사람마다 기존 승인 카드. 마지막 유효 허락에 현재 청중·호출 권한·연결을 재증명하고 착석+job을 같은 tx에 쓴다. 대리 승인·한 명 거절·만료·중복 착석을 막고, 호출자의 모델 선택을 보존한다.
- 사람 참여자 누구나 `DELETE …/channels/{channel}/dm-agents/{agent}`로 내보낸다. 현재 seat 폐기·membership 종료·live run 취소를 함께 한다.
- 폰·웹: DM 후보·보내기 전 범위 안내, 명명된 참여자만 결정하는 기존 카드, 합류/제거 시스템 줄, 그룹 이름·인원과 1:1 peer/자동 답장 분리, 에이전트 내보내기, 멤버 변동 뒤 채널/명부 갱신. 폰 native push의 DM 인원 고정 2도 제거했다. 개인 에이전트의 기존 호출에는 합류 안내를 붙이지 않는다.
- 입력창 줄 수·햅틱·작성 중은 변경하지 않았다. 칸 6과 `actions.rs`의 새 action/role 및 카탈로그 drift 표가 겹친다. 양쪽 추가 항목을 보존해야 한다. 새 의존성은 없다.

## 워커 검증

전용 PG18/pgvector localhost:25792의 새 fixture DB `dm4792_final`에 001–156을 적용했다. 서버는 `momo_app` NOBYPASSRLS로 시험했고, worker 경계는 superuser/BYPASSRLS 쓰기에도 거절되는지 확인했다. 실제 외부 모델 실행·Centrifugo relay·폰/데스크톱 runtime은 `runtime-unverified`다. PG 시험의 모델은 fixture/MockChatProvider이며 hosted는 실제 Agent Port HTTP 호출로 검증했다.

| 명령 | 결과 |
|---|---|
| `cargo test -p momo-server --test mention_routing_conformance_pg dm_admission_ -- --ignored --test-threads=1` | 실 PG 11 PASS: 전원 동의·거절/만료·대리 승인·동시 결정·이력/인용·시간/seq·제거/재합류·hosted·모델 선택 |
| 같은 target `b13_ -- --ignored --test-threads=1` | 기존 1:1 DM 회귀 5 PASS |
| `cargo test -p momo-agent --lib actions::tests` / `decider::tests` | 48 / 6 PASS |
| `cargo test -p momo-server --lib routes::actions::tests` / `routes::messages::tests` | 카탈로그·OpenAPI drift 38 / 메시지 경계 50 PASS |
| `cargo test -p momo-db --lib migrate::tests::discovers_contiguous_migrations_001_to_156` | migration 발견 1 PASS |
| 관련 7 Rust package의 `cargo clippy … --lib -- -D warnings` 및 변경 PG test target clippy | PASS, 경고 0 |
| `cargo fmt --all --check`, `scripts/check_migration_numbers.sh` | PASS |
| 코어·웹·폰 `npm run typecheck` | 모두 PASS |
| 코어 선택 시험 5파일 | 109 PASS |
| 웹 승인 카드·만료·컴포저 메타·대화 시작 4파일 | 47 PASS |
| 폰 승인 카드·로터·대화 정보·푸시 표시 4파일 | 134 PASS (`--watchman=false --forceExit`) |
| 변경 TS/TSX ESLint, OpenAPI/Maestro YAML 파싱, 새 Playwright `node --check`, `git diff --check` | 오류 0. 웹 ChatShell의 기존 Fast Refresh export 경고 1 |

폰 시험에서는 대화 정보 시험의 timer cleanup에서 act 경고를 관측했고 Jest 종료에는 `--forceExit`를 썼다. Watchman은 sandbox 밖 state chmod를 요구해 `--watchman=false`로 실행했다. 시뮬레이터·Xcode·Docker·캡처·전체 시험·전체 docs gate는 S1 지시에 따라 실행하지 않았다.

사보타주: 대리 승인, 전원 정족수, 한 명 거절, 만료, 호출 권한, 청중 재증명, 시각 하한, seq 하한, 호출 메시지 예외, 제거 후 읽기, 제거 후 쓰기, hosted 확인 주체, 그룹 자동 답장, 시스템 줄 사칭, 모델 선택 보존·검증을 각각 제거했다. **16개 모두 컴파일 실패가 아닌 실제 행동 단정 RED**, 원본 소스/DB 함수/트리거 복원 뒤 정상 시험을 다시 실행했다. 원문 로그와 실행기는 공용 Git 디렉터리 쓰기 차단 때문에 이 워크트리의 `claudedocs/worker-4792/evidence/`에 보관한다.

## 스택 검증 메모

- 바뀐 화면: 폰/웹 사람 DM의 멘션 목록·컴포저 안내·허락 카드·시스템 줄·머리 이름/인원·내보내기 메뉴(폰은 대화 정보). 폰 푸시의 그룹 인원 표시.
- 두 사람 DM에서 요청자와 상대를 서로 다른 세션으로 연다. 요청자는 상대의 카드 버튼을 볼 수 없어야 하고 상대만 결정한다. 허락 전 agent seat/job 0, 모두 허락 뒤 같은 channel id와 3명 표시, 새 글 전달을 확인한다. 세 사람 이상에서는 한 명의 거절/만료로 모두 닫히고, 새 사람이 들어오면 이전 동의를 재사용하지 않아야 한다.
- 착석 전 원문을 인용한 새 글·오래된 스레드·실제 Agent Port/managed context를 확인한다. 원문은 숨고 호출 메시지 하나만 예외여야 한다. 어느 사람의 내보내기 뒤 진행 중 응답도 거절되고, 다시 들이면 이전 seat의 글은 보이지 않아야 한다.
- 밝음/어두움, 큰 글자(AX 포함), 동작 줄이기에서 긴 이름·범위 안내·카드·그룹 머리·메뉴가 잘리거나 입력창을 밀어 가리지 않는지 본다. 키보드 Tab/Enter·멘션 Esc, VoiceOver 결정 로터·메뉴 초점 복귀, 오프라인 실패/재시도, 부분 동의 후 거절, 대기 중 만료도 확인한다.
- 기존 사람↔에이전트 1:1 DM의 무멘션 답장·전달·머리/상태 점·개인 에이전트 호출을 다시 확인한다. 그룹의 일반 대화가 자동 답 폭주를 만들면 안 된다.
- Maestro: `10-mention-working.yaml`, `30-approval.yaml`, `96-mention-sheet-ai-capture.yaml`, **새 `31-dm-agent-admission.yaml`**. 새 흐름은 요청자가 이미 부른 fixture DM을 마지막 결정권자인 폰에서 연 상태와 `DM_AGENT_APPROVAL_ID`가 필요하다. 흐름은 작성/구문 확인만 했다.
- Playwright: 기존 `gate:approvals`·`e2e/smoke.mjs`, **새 `e2e/dm-agent-admission.mjs`**. 새 흐름은 localhost fixture, DM id·에이전트 handle·두 사람 로그인 env가 필요하며 밝음/어두움·reduced motion으로 반복한다. 실행하지 않았다.
- 남은 전달: 등급 2 독립 보안 검수(최대 2회), 스택의 전체 시험·병합 트리·표면 preflight·실제 화면·design-review B0/H0, PR CI/정책/exact-base 검증은 planner가 수행한다. 현재 워커 결과로 이 단계들을 통과했다고 간주하지 않는다.
