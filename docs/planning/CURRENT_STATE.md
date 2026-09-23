# oort 현재 상태

기준: 2026-09-23, Opus 5.5 planner. 목표는 **A**다([ADR-0187](../adr/0187-goal-a-team-daily-desktop-ios.md) Accepted): 팀이 데스크탑·iOS로 oort를 매일 쓰는 것이 먼저이고, 외부 출시는 그 뒤다. 배포 게이트는 [M7-I·M7-S](../cicd/03-store-readiness-gate.md)다. 실제 checkout·HEAD·통합 결과는 공용 로컬 기록과 Git/PR에서 확인한다.

## 전체 위치
| 단계 | 완료 / 현재 | 다음 조건 |
|---|---|---|
| 실행 체계 | planner=Opus 5.5 · worker=Opus 5.5 서브에이전트 · 리뷰어 C=fresh 서브에이전트 · design-review fresh. Grok 은퇴. 묶음 승격, STATUS 동결(증거=PR 본문) | 병렬은 PIPELINE §2 기준으로 판단 |
| W1 팀 인스턴스 | Railway 로그인 완료(성재 계정). 배포 레인 감사 결과, 템플릿이 그대로는 동작하지 않는다. 시작 명령·PG18+pgvector·Centrifugo 변수 이름·XFP·드라이브 볼륨·푸시 서비스·doctor 거짓 초록이 문제다 | 설정 PR(#2205) → v0.1.6 이미지 발행(owner 승인) → `oort-team` 배포 |
| W1 데스크탑 배포 | 이 맥에서 서명·공증·업데이터 서명 준비가 끝났다. next 채널은 공개 URL이다 | 배포 채널 결정(ADR-0187 §4) · 증거 빌드는 직접 전달 |
| W1 iOS 배포 | 서명 자산 완비. Info.plist 권한 문구 누락(업로드 반려 예상)·빌드 번호·Pods 미설치 | 권한 문구 PR → TestFlight 1인 그룹 업로드(owner 승인) |
| W1 iOS 대화 | #1084+#2513 · #1964 · #1892 미션 준비 | 성재 W1 go |
| 원격 작업 | ADR-0188 기안 중(보안 검토) | 성재 결재 → R1 |
| AX | AX-2·3a·3b·4 main(09-22). AX-6 #2512는 Railway 인스턴스 위에서(W2). AX-5·AX-8은 연기(ADR-0187 D6) | — |

## 작업별 체크포인트
| 작업 / owner | 저장된 결과 | 다음 |
|---|---|---|
| #2565 정책 PR #2566 / planner | ADR-0187·M7 두 등급·절차 개정. 리뷰어 C R1 FAIL → 수리 | R2 검수 → 정책 감사 → track/engine |
| 목표 A 계획 PR / planner | 계획 문서·ADR-0188·ROADMAP §0–§2·배포 레인 감사 | #2566과 한 묶음으로 승격 |
| 성재 결재 대기 | iOS 범위·「독」 해석·내부 테스트 기간·ADR-0188·데스크탑 배포 채널·v0.1.6 발행·APNs 키 Railway 변수 보관·W1 go | — |
| 후속 이슈 | #2525 #2526 #2529 #2539 #2543 #2545 #2550 #2554 | 파도 사이 |

## 재개
1. `scripts/planning_context.sh`로 복원한다. main·engine·uxui 정렬을 확인한다.
2. 파도 표와 iOS 범위 권고안은 목표 A 계획 문서(`docs/planning/2026-09-23-goal-a-plan.md`, 계획 PR 랜딩 뒤)에 있다. 워커 발사는 성재의 명시 go 뒤에 한다.
3. 발사 프롬프트와 승격 헬퍼는 로컬 `claudedocs/resume-2026-09-23/`에 있다. 계약은 이슈와 레포 문서가 정본이다.

이 파일은 현재 상태 하나만 유지한다. 결정은 ADR, 검증 원문은 PR 본문, 세션 이력은 JOURNAL, 실행 중 note는 공용 로컬 폴더에 둔다.
