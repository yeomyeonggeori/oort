# 실행 레인 — 모델·도구·상한 정본

기준: 2026-09-12 사용자 지시. 공용 운영 계약은 [AGENTS](../../AGENTS.md), 기획 방식은 [README](README.md), 트랙/승격 권한은 [TRACKS](../TRACKS.md)에 있다. 아래 값을 다른 문서에 복사하지 않는다.

## 1. 레인
| 레인 | 역할 | 현재 구성 |
|---|---|---|
| product-owner | 방향·ADR·로드맵·출시 권한 | 성재 |
| planner / orchestrator | 기획·검수·워커 지시·체크포인트 | **GPT-6 Astra / Codex** 또는 **Fable / Claude Code**. 동등한 역할이며 작업 범위별 owner는 하나 |
| worker | 구현·관련 시험·PR·인계 | **Grok 4.6** |
| reviewer-code | 구현 맥락과 분리한 변경·회귀·증거 검수 | 해당 orchestrator. 필요한 독립 검수는 새 맥락으로 배정 |
| reviewer-design | 해당 표면의 캡처·preflight·루브릭 검수 | 해당 orchestrator의 fresh context. Claude 에이전트는 세션 모델을 상속; Codex는 같은 리뷰 계약을 전달 |
| integrator / momo-main | 순차 트랙 통합·승인 범위의 승격·sync | 공용 `integration` 범위를 맡은 orchestrator 한 세션 |

예전 Fable 전용 중단·고정 Opus/이전 worker 모델 규칙은 위 선택을 제한하지 않는다. 다른 모델로 임의 대체하지 않고, 사용할 수 없으면 진행 결과와 남은 작업을 보존한다. 승인된 두 orchestrator 사이의 전환은 소유권 인계 후 계속할 수 있다.

## 2. 실행 한도와 위치
| 항목 | 값 |
|---|---|
| 무거운 worker + reviewer 합계 | **최대 2**. 호스트 부하에 따라 줄임 |
| 전체/병합 트리/Docker-heavy 게이트 | **호스트 전체에서 한 번에 1개** |
| 트랙 | `track/engine`, `track/uxui` |
| 로컬 관례 | `~/projects/momo-tracks/{engine,uxui}`, 개별 작업은 그 아래 `momo-worktrees/` |
| 공용 실행 기록 | 해당 저장소의 `git-common-dir/oort-coordination/` |
| 기획 문서 랜딩 | **track/engine**. main 직행 금지 |
| UI 트랙 랜딩 | 독립 design-review **B0·H0**, 해당 표면 게이트 |
| 엔진→UXUI 전달 | UI가 소비하는 계약이 준비되면 ENGINE_HANDOFF에 ready 기록 |

## 3. 실행·인계
사용 가능한 Grok 실행 경로는 [worker-adapters](worker-adapters.md)를 필요할 때 읽는다. 작업별 cwd·계약·허용 파일·검증·완료 지점을 전달한다. 기본적으로 모든 MCP를 넣거나 광범위한 권한 우회 옵션을 켜지 않는다.

모든 worker가 PR 뒤 멈추더라도 orchestrator는 검수·수정·통합의 요청 범위를 계속 수행한다. 현재 base가 이미 필요한 main을 포함하면 관성적으로 merge하지 않는다. 워커 로그의 완료 선언만으로 완료 처리하지 않고 실제 diff/커밋·검증 산출물·PR을 확인한다.

## 4. 권한
track→main은 product-owner의 명시 승인 범위에서만 집행한다. 2026-08-27 기록된 **게이트 그린인 랜딩 단위 승격 + 양 트랙 sync 상시 위임**은 TRACKS §3대로 보존한다. 이것은 다른 owner의 작업 인수, 새 제품 결정, release/유료 workflow·스토어 배포 권한을 추가하지 않는다.

소유권이 불명확하면 다른 작업을 중복 실행하지 않는다. 한 범위만 조율하고 나머지 독립 작업은 진행한다.
