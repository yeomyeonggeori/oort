# oort 현재 상태

기준: 2026-09-12. source main `4cf30e4f`, engine `ed26b020`, uxui `0de7a796`에서 시작한 #2501 작업 스냅샷.
현재 요청은 **베타 재개 전 공용 파이프라인 경량화**다. 실행 중 owner·워크트리·HEAD·마지막 체크포인트는 `scripts/planning_context.sh`의 공용 로컬 기록으로 확인한다.

## 전체 위치
| 단계 | 완료 / 현재 | 다음 조건 |
|---|---|---|
| 실행 체계 | #2501: Astra+Grok4.6 / Fable+Grok4.6 공용 계약·복원 도구 정리 중 | 두 하네스/워크트리 복원·소유권 시험, 검수, PR |
| 출시 후보 | v0.1.5 발행, 로컬 B′ 기록 있음 | 같은 이미지의 공개 A/B·Grok 자발 응답·Update/Reset |
| 클라우드 | Railway API drive 권한으로 기동 실패 확인 | 볼륨/권한·notifier·재배포 영속성·DB+첨부 복구 |
| 검수·베타 | G1′ A/B → ITO → 외부 3명 및 iOS v0/G2 | 각 단계 실제 증거. 고정 출시일 미확인 |

## 작업별 체크포인트
| 작업 / owner | 저장된 결과 | 다음 |
|---|---|---|
| #2501 / Astra, Grok 구현 | 전용 `shared-agent-pipeline` worktree | 운영 도구 시험·독립 검수·게이트 |
| #2499 / Astra | PR #2500, `f98c8265`, push됨. 집중 검사 및 Astra docs77 PASS | 최종 통합 검토; 실제 Railway 배포 미검증 |
| #2498 / Astra | `16fcf007`, 로컬 미push. worker fmt/auth88/routes9 PASS | 독립 검수·실제 PG 경합/rollback·전체 Rust 검증·PR |
| #2485·#2490·#2497 / Fable | 기존 PR 유지. #2490 R2·#2485 디자인 검수 상태 재확인 필요 | 인계 조율 전 중복 작업/통합 금지 |
| #2066 / 결정 대기 | 기존 limiter 존재 확인. 키 보존·분리/감사 제안은 Proposed | 결정 후 해당 범위만 구현 |

#2498/#2499의 베타 작업은 사용자 요청으로 대기 중이다. 이전 Astra turn은 14:23:21 KST 플랫폼 자동 분류로 실패했으나 두 worker는 별도로 종료했다. 구현 완료와 runtime 검증을 구분한다. 별도 claim이 없다는 사실만으로 Fable 등의 프로세스 종료를 추정하지 않는다.

## 재개
1. #2501의 현재 검수·통합 상태부터 확인한다. 두 하네스 모두 AGENTS와 같은 공용 checkpoint를 따른다.
2. 베타 재개 지시 후 #2498 검수·남은 검증 → #2500 및 기존 PR의 owner 조율 → Railway/동일 후보 A/B 순으로 편성한다.
3. 상세 출시 계약은 [ROADMAP](../../ROADMAP.md), [두 케이스](2026-09-07-first-goal-two-cases.md), [남은 작업 지도](2026-09-08-remaining-work-map.md). 예전 스냅샷은 [archive](archive/CURRENT_STATE-snapshots.md)이며 실행 지시가 아니다.

이 파일은 현재 상태 하나만 유지한다. 결정은 ADR, 검증 원문은 STATUS/PR, 세션 이력은 JOURNAL, 실행 중 note는 공용 로컬 폴더에 둔다.
