# 공유 워크트리 운영

한 이슈 = 한 브랜치·워크트리·PR. 모델·병렬 상한은 [PIPELINE](planning/PIPELINE.md), 트랙/승격 권한은 [TRACKS](TRACKS.md)에만 정의한다.

## 0. 역할과 소유권
서로 다른 기획 범위는 병렬로 진행할 수 있다. 같은 파일군의 구현은 분리하거나 순서를 정한다. 공용 통합은 `integration` 범위를 맡은 세션 하나가 수행한다. 다른 하네스에서도 같은 scope/session 기록을 읽는다.

로컬 기록 위치는 `scripts/planning_session.py path`로 찾는다. Git common directory 아래이므로 같은 저장소의 모든 워크트리에서 같다. 별도 clone/머신은 GitHub Issue·브랜치·PR과 커밋된 CURRENT_STATE로 조율한다. 공용 폴더가 프로세스 감독기나 원격 잠금을 대신하지는 않는다.

## 1. 상태판
`scripts/planning_context.sh`는 오프라인 현재 상태, `scripts/goal_status.sh --repo yeomyeonggeori/oort`는 실시간 이슈/PR/worktree 보드다. gate 표시는 라벨 기반 힌트이며 최종 검증은 실제 diff와 [LOCAL_PR_GATE](LOCAL_PR_GATE.md)로 정한다.

워크트리 정리는 read-only 감사 후 수행한다. **main 및 track/*는 정리 대상이 아니다.** closed 이슈라는 이유만으로 dirty·미push·현재 사용 중인 작업을 삭제하지 않는다. 다른 owner의 파일은 무접촉으로 둔다.

## 2. 구현 claim
트랙을 명시해 `scripts/goal_claim.sh --base track/engine <issue-number>` 또는 UXUI 트랙으로 claim한다. 스크립트는 원격 브랜치와 이슈 assignee/status를 기록한다. 이미 맡은 이슈·브랜치·PR이 있으면 새로 claim하지 않는다.

공용 로컬 scope는 오케스트레이션 충돌을 방지하고, Issue+remote branch는 원격 작업 소유권을 표시한다. 단순한 읽기·개인 검토는 새 claim을 만들 필요가 없다. helper 사용은 `scripts/planning_session.py --help`를 따른다.

## 3. 환경
runtime은 전용 env/포트/Compose project와 폐기 가능한 DB를 사용한다. `.conductor/setup.sh`가 만드는 로컬 env는 비밀정보를 포함할 수 있으므로 커밋하지 않는다. root .env와 다른 작업의 DB·볼륨·포트를 공유하지 않는다.

검토용 사본은 실제 worktree의 gitdir을 재사용하지 않게 만든다. 사용 중인 트리의 복사본에서 Git mutation을 하지 않는다. runtime 자원은 자신이 만든 것만 정리한다.

## 4. 충돌과 체크포인트
겹침을 우선 확인할 대상은 server-rust/DDL, 공유 momo-core, 클라이언트 공통 계약, infra, 게이트·goal 도구, 공용 계획 문서다. 변경 규모보다 실제 파일/자원 겹침을 기준으로 분리한다.

로컬 note에는 한 일 / 현재 / 다음 / 마지막 검증 / 실제 막힘 / 이슈·PR / run·종료 기록을 적는다. 진입은 read-only, claim은 명시적이며 같은 scope를 다른 세션이 보유하면 거절된다. session 식별자는 모델 이름과 별개다. 마지막 기록의 시각만으로 owner를 자동 탈취하지 않는다.

### 4.1 루트·공용 파일
- root main은 clean 유지. 변경은 전용 워크트리에서 작성하고 기획 문서도 track/engine에 PR로 랜딩한다.
- 다른 세션의 dirty 파일을 stash/reset/삭제하거나 함께 stage하지 않는다. 파일 목록을 지정해 커밋한다.
- canonical 브랜치 갱신은 clean 상태에서 ff-only 또는 검토된 sync merge로 한다. main 직접 push, canonical force-push·history rewrite 금지.

## 5. worker 전달
이슈 번호, 필요하면 패킷/기준 커밋, worktree, 허용 파일, 관련 검증과 전달 지점으로 충분하다. 제품 버그의 재현과 함정은 관련된 것만 준다. 과거 사고 체크리스트 전체를 반복하지 않는다.

## 6. worker 결과
한 일 / 변경 파일·커밋 / 검증 원문 경로 / PR / 남은 것·계획 이탈을 보고한다.
`scripts/goal_release.sh <issue-number> --review --pr <PR URL>` 뒤에는 orchestrator가 검수·후속 수정을 이어간다.
막힘은 해당 이슈의 구체적 원인으로 기록한다. 설계 승인 대기와 실행 도구 오류를 구분한다.

## 7. PR 검수·통합
1. 이슈와 실제 HEAD/파일·독립 검수·local evidence를 대조한다.
2. 관련 실패는 같은 이슈에서 수정하고 영향을 받는 검증을 다시 실행한다. UI는 B0·H0 및 해당 표면 증거가 필요하다.
3. **현재 PR HEAD**의 PR CI gate·Policy integrity gate와 exact canonical base 출처를 [GITHUB_OPS](GITHUB_OPS.md)대로 검증한다. 정책 파일의 지정 owner exact-head audit/라벨 조건을 유지한다.
4. 단일 integrator가 자기 track으로 순차 머지한다. 테스트한 HEAD·base/병합 결과와 실제 결과가 다르면 해당 차이를 검증한다.
5. track→main은 TRACKS의 승인 범위에서 승격+양 트랙 sync로 수행한다. 다른 owner의 진행 중 PR을 임의로 인수하지 않는다.
6. 검증·상태·다음 행동을 기록한다. 모든 로그를 여러 Markdown 파일에 복사하지 않는다.

## 8. 검증
검증 등급·명령은 [개발 검증](runbooks/development-validation.md), local profile 이름은 [LOCAL_PR_GATE](LOCAL_PR_GATE.md)와 `scripts/local_gate.sh --help`가 정본이다. 폐기된 Swift/macOS profile로 현행 제품을 검증하지 않는다.

## 9. 호스트 자원
무거운 게이트는 PIPELINE의 호스트 전체 단일 슬롯으로 실행한다. runtime-*의 load > 12 가드는 유지한다. 새로운 작업·머지 결과 검증을 시작할 때 기존 실행과 겹치지 않는지 확인한다.

게이트가 만든 자원은 해당 게이트의 cleanup 계약을 따른다. 조사용 보존은 명시적으로 기록한다. 배치가 끝났다는 이유로 호스트 전체 Docker cache/volume이나 다른 프로젝트 자원을 자동 prune하지 않는다. janitor는 기본 read-only이며, 명확한 자기 자원만 정리한다.
