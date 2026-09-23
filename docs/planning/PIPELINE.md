# 실행 레인 — 모델·도구·병렬 판단 정본

기준: 2026-09-23 성재 지시(ADR-0187 D7). 공용 운영 계약은 [AGENTS](../../AGENTS.md), 기획 방식은 [README](README.md), 트랙/승격 권한은 [TRACKS](../TRACKS.md)에 있다. 아래 값을 다른 문서에 복사하지 않는다.

## 1. 레인
| 레인 | 역할 | 현재 구성 |
|---|---|---|
| product-owner | 방향·ADR·로드맵·출시 권한 | 성재 |
| planner / orchestrator | 기획·검수·워커 지시·체크포인트·통합 | **Opus 5.5 / Claude Code**(2026-09-23 성재가 세션 모델을 전환 — 레인 기본값 확정은 성재 확인 대기), **Fable / Claude Code**, **GPT-6 Astra / Codex**. 동등한 역할이며 작업 범위별 owner는 하나 |
| worker | 구현·관련 시험·PR·인계 | **Opus 5.5 서브에이전트**(Claude Code Agent 도구, 부모 모델 상속). Grok 레인은 2026-09-23 은퇴 |
| reviewer-code | 구현 맥락과 분리한 변경·회귀·증거 검수 | fresh 컨텍스트 서브에이전트. diff 사본과 변경 후 파일 사본을 검수 대상으로 삼고, 사실 확인을 위해 레포를 읽기 전용으로 본다 |
| reviewer-design | 해당 표면의 캡처·preflight·루브릭 검수 | design-review 에이전트 fresh 컨텍스트 |
| integrator / momo-main | 순차 트랙 통합·승인 범위의 승격·sync | 공용 `integration` 범위를 맡은 orchestrator 한 세션 |

승인된 레인 모델끼리만 전환하고, 전환 전에 공용 체크포인트로 owner·진행 결과를 인계한다. 지정 모델을 쓸 수 없으면 다른 모델로 임의 대체하지 않고 진행 결과와 남은 작업을 보존한다. 체크포인트에 실제 사용 모델을 기록한다.

## 2. 병렬 판단과 위치
고정 병렬 상한은 두지 않는다(2026-09-23 성재). orchestrator가 아래 기준으로 판단한다.
- 호스트 1분 load가 코어 수를 넘으면 새 무거운 작업을 미룬다.
- 동시에 돌리면 결과가 흔들리는 작업은 호스트 전체에서 한 번에 하나만 돌린다: 병합 트리 게이트, Docker 스택 게이트, iOS 빌드·시뮬레이터 캡처, 캡처 기반 측정.
- 같은 파일군을 만지는 워커는 순서를 정하거나 파일 소유권을 나눈다.

| 항목 | 값 |
|---|---|
| 트랙 | `track/engine`, `track/uxui` |
| 로컬 관례 | `~/projects/momo-tracks/{engine,uxui}`, 개별 작업은 그 아래 `momo-worktrees/` |
| 공용 실행 기록 | 해당 저장소의 `git-common-dir/oort-coordination/` |
| 기획 문서 랜딩 | **track/engine**. main 직행 금지 |
| UI 트랙 랜딩 | 독립 design-review **B0·H0**, 해당 표면 게이트 |
| 엔진→UXUI 전달 | UI가 소비하는 계약이 준비되면 ENGINE_HANDOFF에 ready 기록 |

## 3. 실행·인계
워커 발사 경로는 [worker-adapters](worker-adapters.md)를 따른다. 미션에 cwd·계약·허용 파일·검증·완료 지점을 적는다. 기본적으로 모든 MCP를 넣거나 광범위한 권한 우회 옵션을 켜지 않는다.

모든 worker가 PR 뒤 멈추더라도 orchestrator는 검수·수정·통합의 요청 범위를 계속 수행한다. 현재 base가 이미 필요한 main을 포함하면 관성적으로 merge하지 않는다. 워커의 완료 선언만으로 완료 처리하지 않고 실제 diff/커밋·검증 산출물·PR을 확인한다.

## 4. 권한
track→main은 product-owner의 명시 승인 범위에서만 집행한다. 상시 위임은 TRACKS §3의 **묶음 단위 승격 + 양 트랙 sync**다. 이것은 다른 owner의 작업 인수, 새 제품 결정, release/유료 workflow 권한을 추가하지 않는다. 배포는 AGENTS의 M7 등급과 owner 승인을 따른다.

소유권이 불명확하면 다른 작업을 중복 실행하지 않는다. 한 범위만 조율하고 나머지 독립 작업은 진행한다.
