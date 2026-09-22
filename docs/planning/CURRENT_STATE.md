# oort 현재 상태

기준: 2026-09-22, Fable planner. 편성 정본 `2026-09-22-plan-revision.md`, 결정 ADR-0186(Proposed)·ADR-0004 증보 4(Accepted). 실제 checkout·HEAD·통합 결과는 공용 로컬 기록과 Git/PR에서 확인한다.
현재 요청은 **베타 재개 준비 완결 → 착수**(성재 09-22 「준비가 온전하면 착수」)다. 실행 중 owner·워크트리·HEAD는 `scripts/planning_context.sh`로 확인한다.

## 전체 위치
| 단계 | 완료 / 현재 | 다음 조건 |
|---|---|---|
| 실행 체계 | #2501 공용 계약 · planner=Fable(이 세션) · worker=Grok 4.6 | 워커 발사는 명시 go |
| 출시 후보 | v0.1.5 발행, 로컬 B′ PASS | E2E-A 발행 이미지 · Update/Reset · SH-11a Railway(최종) |
| **AX 에이전트 행동 축** | ADR-0186 **Accepted**(09-22) · 이슈 #2507~#2514 · 브리프 5본 · AX-0 #2506 main 정본화 | W-A 진행 중 → W-B(AX-3a→3b ∥ AX-4) |
| 검수·베타 | 척추 유지: #2498·PR 3건 → E2E-A → SH-11a → ITO(초대 1종 포함) → G2 | 각 단계 실제 증거 |

## 작업별 체크포인트
| 작업 / owner | 저장된 결과 | 다음 |
|---|---|---|
| AX-0 #2506 / Fable | 완료: PR #2515→#2516 main 95199a69, sync #2517/#2518 | — |
| #2066 / Opus 5 워커(성재 지시) | claim됨, 워크트리 `2066-server-security-…`(engine) · 브리프 `handoffs/2026-09-22-2066-webhook-master-key-brief.md` | 구현→PR→독립 검수→정책 감사 랜딩 |
| AX-2 #2507 / Opus 5 워커(성재 지시) | claim됨, 워크트리 `2507-uxui-ax-2-…`(uxui) · 브리프 `handoffs/2026-09-22-ax2-command-registry-brief.md` | 구현→PR→design-review B0·H0→랜딩 |
| AX-3a #2508 → AX-3b #2509 / W-B | 브리프 2본, ADR 부록 A~E 계약 | #2066 랜딩 뒤 엔진 슬롯에서 순차 |
| AX-4 #2510 / W-B | 브리프, 부록 계약으로 착수 가능 | AX-2 랜딩 뒤 uxui 슬롯, 병합 검증은 3b 뒤 |
| #2498 / Fable 인수 | `16fcf007` 로컬 미push, worker fmt/auth88/routes9 PASS | 독립 검수·PG 경합·전체 Rust·PR |
| PR #2485·#2490·#2497 / Fable | needs-review | design-review 재확인·R2·정책 배치 3 감사 → 랜딩 |
| #2205 SH-11a / 성재 로그인 | ready | 최종 단계 |

병렬 상한: 무거운 worker+reviewer 합 2. W-A = #2066 ∥ AX-2. planner 검수 작업(#2498·PR 3건)은 워커와 별개로 진행한다.

## 재개
1. `scripts/planning_context.sh` → 이 스냅샷과 공용 기록 대조. AX-0 PR 상태 확인.
2. 결재 완료(09-22): ADR-0186 Accept · W-A go. 워커 = Opus 5 서브에이전트(이 배치 한정).
3. W-A 워커 보고 수거 → 독립 검수(사보타주 재판정) → 랜딩·승격 → W-B(AX-3a→3b ∥ AX-4) 발사. planner 병행: #2498 인수 검수·PR #2485/#2490/#2497.
4. 상세: [ROADMAP](../../ROADMAP.md) §1 AX 행 · [계획 개정](2026-09-22-plan-revision.md) · [남은 작업 지도](2026-09-08-remaining-work-map.md) 갱신 09-22.

이 파일은 현재 상태 하나만 유지한다. 결정은 ADR, 검증 원문은 STATUS/PR, 세션 이력은 JOURNAL, 실행 중 note는 공용 로컬 폴더에 둔다.
