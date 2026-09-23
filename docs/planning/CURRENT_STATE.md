# oort 현재 상태

기준: 2026-09-22 저녁, Fable planner. 편성 정본 `2026-09-22-plan-revision.md`, 결정 ADR-0186(**Accepted**, 정오표 D7·부록 B)·ADR-0004 증보 4(Accepted). 실제 checkout·HEAD·통합 결과는 공용 로컬 기록과 Git/PR에서 확인한다.
현재 요청은 **베타 재개 착수**(성재 09-22 「승인할게 진행해줘, 워커는 Opus 5 서브에이전트로」)다. 실행 중 owner·워크트리·HEAD는 `scripts/planning_context.sh`로 확인한다.

## 전체 위치
| 단계 | 완료 / 현재 | 다음 조건 |
|---|---|---|
| 실행 체계 | planner=Opus 5.5 · worker=Opus 5.5 서브에이전트 · 리뷰어 C=fresh 서브에이전트(diff 사본) · design-review fresh. Grok 은퇴(ADR-0187 D7) | 병렬은 PIPELINE §2 기준으로 판단 |
| **AX 에이전트 행동 축** | **AX-2·3a·3b·4 main 정본화**(09-22). 초대 1종 propose→승인→실행→secretOnce 서버·카드 전부 랜딩. 서버 실샘플로 카드 픽스처 교체·병합 검증은 미실행 | AX-6 #2512 E2E(초대 1종, `claudedocs/resume-2026-09-22/mission-ax6.md`) → ITO 시나리오 행 |
| 출시 후보 | v0.1.5 발행, 로컬 B′ PASS. #2066 webhook 마스터키 분리·#2498 기기 refresh/revoke 직렬화·#2476 설정›기기·#2044 오버레이 층 main | E2E-A 발행 이미지 재실측 · Update/Reset · SH-11a Railway(최종) |
| 검수·베타 | 척추 유지: E2E-A → SH-11a → ITO(초대 1종 포함) → G2 | 각 단계 실제 증거 |

## 작업별 체크포인트
| 작업 / owner | 저장된 결과 | 다음 |
|---|---|---|
| AX-6 #2512 / planner | 미션 초안 준비 | 격리 스택 실측 → 보고서 PR |
| AX-4 픽스처 실샘플 교체 / planner | ENGINE_HANDOFF A-48 실샘플 | 작은 uxui PR + `verify_merge_tree` |
| 후속 이슈 | #2525(AX-2 잔여) #2526(#2476 잔여) #2529(#2066 L) #2539(sweep 잠금 순서) #2543(worker 카드 멱등키) #2545(AX-4 잔여) #2554(AX-3b M3·L3·L7) #2550(#2485 잔여) | 파도 사이 선재 |
| AX-5 #2511 · AX-7 #2513 · AX-8 #2514 · AX-1 #2016 | ITO 뒤 | — |
| #2205 SH-11a / 성재 로그인 | ready | 최종 단계 |

## 재개
1. `scripts/planning_context.sh`로 복원. main·engine·uxui 정렬 확인.
2. AX-6 E2E → E2E-A 발행 이미지 → SH-11a → ITO 편성. 워커 발사는 명시 go.
3. 상세: [ROADMAP](../../ROADMAP.md) §1 AX 행 · [계획 개정](2026-09-22-plan-revision.md) · [남은 작업 지도](2026-09-08-remaining-work-map.md) 09-22 갱신.

이 파일은 현재 상태 하나만 유지한다. 결정은 ADR, 검증 원문은 STATUS/PR, 세션 이력은 JOURNAL, 실행 중 note는 공용 로컬 폴더에 둔다.
