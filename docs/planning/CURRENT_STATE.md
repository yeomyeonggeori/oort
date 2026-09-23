# oort 현재 상태

기준: 2026-09-23, Opus 5.5 planner. 목표는 **A**다([ADR-0187](../adr/0187-goal-a-team-daily-desktop-ios.md) Accepted): 팀이 데스크탑·iOS로 oort를 매일 쓰는 것이 먼저이고, 외부 출시는 그 뒤다. 배포 게이트는 [M7-I·M7-S](../cicd/03-store-readiness-gate.md)다. 실제 checkout·HEAD·통합 결과는 공용 로컬 기록과 Git/PR에서 확인한다.

## 전체 위치
| 단계 | 완료 / 현재 | 다음 조건 |
|---|---|---|
| 실행 체계 | planner=Opus 5.5 · worker=Opus 5.5 서브에이전트 · 리뷰어 C=fresh 서브에이전트 · design-review fresh. Grok 은퇴. 묶음 승격, STATUS 동결(증거=PR 본문) | 병렬은 PIPELINE §2 기준으로 판단 |
| 성재 결재(09-23 2차) | iOS=**원격 R1까지 팀 배포 전** · ADR-0188 **Accept** · 데스크탑 next=**팀 채널** · W1 전부 승인(코드 레인·Railway 배포와 APNs sealed 변수·v0.1.6 발행·첫 증거 빌드 2종) | 남은 확정점: 내부 테스트 기간(기본 2주)·M7-I 승인 단위·스토어 직행·Enterprise Trust 연기 |
| W1 팀 인스턴스 | #2205 설정 PR 워커 진행(시작 명령·PG18+pgvector·Centrifugo 이름·XFP·드라이브·푸시 서비스·doctor 수리). v0.1.6 1차 발행 실패: PG 이미지가 고정한 libssh2 deb13u1 arm64가 Debian pool에서 삭제(404) → #2572(deb13u2 CVE 6·영구 URL) 수리 중 | #2572 랜딩·승격 → v0.1.6 재발행(release 승인) → 설정 PR 랜딩 → `oort-team` 배포(워커 단계 2) |
| W1 iOS | #2568 TestFlight 준비 · #1084+#2513 승인 카드 · #1964 안읽음 · #1892 점프 · #2569 푸시 탭 이동 — 워커 진행 | 각 PR 검수(design-review) → #2568 뒤 TestFlight 1인 그룹 업로드(승인됨) |
| W1 데스크탑 | 서명·공증·업데이터 서명 준비 완료(업데이터 키 암호=키체인). next=팀 채널 | Railway 가동 뒤 증거 빌드(#1607 로그인 동시 측정) |
| 원격 작업 | ADR-0188 Accepted. R0 #2570·workd #2571 워커 진행 | R0·R1 뒤 보안 재검수 → 팀 배포(M7 I-8) |
| AX | AX-2·3a·3b·4 main(09-22). AX-6 #2512는 Railway 인스턴스 위에서(W2). AX-5·AX-8은 연기(ADR-0187 D6) | — |

## 작업별 체크포인트
| 작업 / owner | 저장된 결과 | 다음 |
|---|---|---|
| #2565 정책 PR #2566 / planner | **track/engine 랜딩**(a5c9b109): 리뷰어 C R1·R2 FAIL → R3 PASS, 정책 감사·exact-base verifier PASS | 묶음 승격 |
| #2567 계획 / planner | 계획 문서·ADR-0188 Accepted·ROADMAP·배포 레인 감사 | #2566 뒤 랜딩, 한 묶음으로 승격 |
| 워커 7기 / Opus 5.5 | #2205 · #2568 · #1084(+#2513) · #1964·#1892 · #2569 · #2570 · #2571 | PR 수거 → 독립 검수 → 랜딩 |
| 후속 이슈 | #2525 #2526 #2529 #2539 #2543 #2545 #2550 #2554 | 파도 사이 |

## 재개
1. `scripts/planning_context.sh`로 복원한다. main·engine·uxui 정렬을 확인한다.
2. 파도 표와 iOS 범위 권고안은 목표 A 계획 문서(`docs/planning/2026-09-23-goal-a-plan.md`, 계획 PR 랜딩 뒤)에 있다. 워커 발사는 성재의 명시 go 뒤에 한다.
3. 발사 프롬프트와 승격 헬퍼는 로컬 `claudedocs/resume-2026-09-23/`에 있다. 계약은 이슈와 레포 문서가 정본이다.

이 파일은 현재 상태 하나만 유지한다. 결정은 ADR, 검증 원문은 PR 본문, 세션 이력은 JOURNAL, 실행 중 note는 공용 로컬 폴더에 둔다.
