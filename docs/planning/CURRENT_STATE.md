# oort 현재 상태

기준: 2026-09-12, #2501 공용 파이프라인 작업. 실제 checkout·HEAD·통합 결과는 아래 공용 기록과 Git/PR에서 확인한다.
현재 요청은 **베타 재개 전 공용 파이프라인 경량화**다. 실행 중 owner·워크트리·HEAD·마지막 체크포인트는 `scripts/planning_context.sh`의 공용 로컬 기록으로 확인한다.

## 전체 위치
| 단계 | 완료 / 현재 | 다음 조건 |
|---|---|---|
| 실행 체계 | #2501: Astra+Grok4.6 / Fable+Grok4.6 공용 계약·복원 도구 | 현재 검증·PR·통합 상태는 공용 checkpoint; 기존 세션은 복원 출력을 다시 읽음 |
| 출시 후보 | v0.1.5 발행, 로컬 B′ 기록 있음 | 같은 이미지의 공개 A/B·Grok 자발 응답·Update/Reset |
| 클라우드 | Railway API drive 권한으로 기동 실패 확인 | 볼륨/권한·notifier·재배포 영속성·DB+첨부 복구 |
| 검수·베타 | G1′ A/B → ITO → 외부 3명 및 iOS v0/G2 | 각 단계 실제 증거. 고정 출시일 미확인 |

## 작업별 체크포인트
| 작업 / owner | 저장된 결과 | 다음 |
|---|---|---|
| #2501 / Astra, Grok 구현 | `shared-agent-pipeline` worktree. 문서·도구 독립 검수와 복원/소유권 집중 시험 | 최종 게이트·PR/통합 결과와 다음 행동은 공용 checkpoint |
| #2499 / Astra | PR #2500 → engine `0726c8e2`. 집중 검사·Astra docs77·exact-base 정책 검증 PASS, #2501 선행 의존성으로 별도 통합 | 실제 Railway 배포 미검증; 기능 재개와 별개 |
| #2498 / Astra | `16fcf007`, 로컬 미push. worker fmt/auth88/routes9 PASS | 독립 검수·실제 PG 경합/rollback·전체 Rust 검증·PR |
| #2485·#2490·#2497 / Fable | 기존 PR 유지. #2490 R2·#2485 디자인 검수 상태 재확인 필요 | 인계 조율 전 중복 작업/통합 금지 |
| #2066 / 결정 대기 | 기존 limiter 존재 확인. 키 보존·분리/감사 제안은 Proposed | 결정 후 해당 범위만 구현 |

#2498 및 실환경 베타 작업은 사용자 요청으로 대기 중이다. #2500의 기존 pin 수리만 #2501 게이트의 선행 의존성으로 엔진에 통합했다. 이전 Astra turn은 14:23:21 KST 플랫폼 자동 분류로 실패했으나 두 worker는 별도로 종료했다. 구현 완료와 runtime 검증을 구분한다. 별도 claim이 없다는 사실만으로 Fable 등의 프로세스 종료를 추정하지 않는다.

## 재개
1. `scripts/planning_context.sh`로 #2501의 최종 전달 상태를 확인한다. 두 하네스 모두 AGENTS와 같은 공용 checkpoint를 따른다. 옛 워크트리는 변경이 포함된 기준으로 동기화해야 새 훅/계약을 사용한다.
2. 베타 재개 지시 후 #2498 검수·남은 검증 → #2500 반영 확인 및 기존 PR의 owner 조율 → Railway/동일 후보 A/B 순으로 편성한다.
3. 상세 출시 계약은 [ROADMAP](../../ROADMAP.md), [두 케이스](2026-09-07-first-goal-two-cases.md), [남은 작업 지도](2026-09-08-remaining-work-map.md). 예전 스냅샷은 [archive](archive/CURRENT_STATE-snapshots.md)이며 실행 지시가 아니다.

이 파일은 현재 상태 하나만 유지한다. 결정은 ADR, 검증 원문은 STATUS/PR, 세션 이력은 JOURNAL, 실행 중 note는 공용 로컬 폴더에 둔다.
