# oort 현재 상태

기준: 2026-09-24, Opus 5.5 planner. 목표는 **A**다([ADR-0187](../adr/0187-goal-a-team-daily-desktop-ios.md) Accepted): 팀이 데스크탑·iOS로 oort를 매일 쓰는 것이 먼저이고, 외부 출시는 그 뒤다. 배포 게이트는 [M7-I·M7-S](../cicd/03-store-readiness-gate.md)다. 실제 checkout·HEAD·통합 결과는 공용 로컬 기록과 Git/PR에서 확인한다.

## 전체 위치
| 단계 | 완료 / 현재 | 다음 조건 |
|---|---|---|
| 실행 체계 | planner=Opus 5.5 · worker=Opus 5.5 서브에이전트 · 리뷰어 C·보안 검수·design-review=fresh 서브에이전트. 묶음 승격, STATUS 동결(증거=PR 본문) | 병렬은 PIPELINE §2 기준 |
| 성재 결재 | 09-23 2차(iOS=원격 R1까지 팀 배포 전 · ADR-0188 Accept · next=팀 채널 · W1 전부) + 09-24: Railway **Pro**·리전 싱가포르·owner 메일 (a) · Codex 원격 「샌드박스 자동 실행 수용」(조건부, #2607) · Claude auto 기기 「시작 직후 교정」 · ASC 확인은 planner 실측 위임(#2568 기록) | 남은 확정점: 내부 테스트 기간(기본 2주)·M7-I 승인 단위·스토어 직행·Enterprise Trust 연기·#2592 포그라운드 배너·수출 신고 판단 |
| W1 팀 인스턴스 | **가동**: `oort-team` https://oort-team.up.railway.app (Railway Pro, asia-southeast1, v0.1.6, 9서비스, 볼륨 백업 daily, Client-IP gate PASS). owner claim 완료(09-24). 첨부 경로 수리 #2606 랜딩 | 24시간 자원 재측정·비용 확정 · 10-08 전후 IP gate 재측정 · 후속 #2609(p0) #2611 #2615 #2610 #2612 #2613 |
| W1 iOS | uxui 랜딩: #2587 TestFlight 준비 · #2585 승인 카드 · #2593 안읽음 · #2594·#2614 점프. #2584 푸시 탭 R3 수리 중. ASC 자동 배포·Xcode Cloud 꺼짐 확인(09-24), ASC API 팀 키 확보 | #2584 랜딩 → 묶음 승격 → main 아카이브 → `momo-internal-test` 업로드(승인됨) → 성재 폰 설치·앱 종료 상태 푸시 |
| W1 데스크탑 | 서명·공증·업데이터 서명 준비 완료. next=팀 채널 | 묶음 승격 뒤 main 증거 빌드(owner 기기 직접 전달) → Railway 로그인(#1607) |
| 원격 작업 | engine 랜딩: R0 #2576 · R0.1+A′ #2597 · workd 뼈대 #2579 · R1.1 경화 #2605 | R1.2 #2607(Codex 수용 조건·Claude 교정·N-1~N-10) → 보안 재검수 → R1 나머지(권한 다리·등록 GUI·폰 작업 탭) → M7 I-8 |
| 폰 품질 후속 | #2586·#2588·#2604 스크롤 · #2600 AX5 · #2595 VoiceOver 카드 · #2596 secretOnce · #2598 host 기본값 · #2603 안읽음 후속 · #2617 시각 칸 · #2618 점프 후속2 · #2616 폰 브라우저 온보딩(진행) | M7-I 팀 배포 전 편성 |
| AX | AX-2·3a·3b·4 main(09-22). AX-6 #2512는 Railway 인스턴스 위에서(W2). AX-5·AX-8 연기(ADR-0187 D6) | — |

## 작업별 체크포인트
| 작업 / owner | 저장된 결과 | 다음 |
|---|---|---|
| #2584 푸시 탭 / 워커 | design-review R2 FAIL(같은 방 복귀 탭 거짓 고지) → R3 수리 중 | DR R3 → 병합 트리 → 랜딩 |
| #2607 R1.2 / 워커 | Codex 수용 조건·Claude 모드 교정·#2605 재검수 N-1~N-10 | 보안 재검수 → 랜딩 |
| #2609 · #2615 · #2616 · #2618 / 워커 | T1 업로드 경로(p0) · 업로드 capability 1회성 · 폰 브라우저 온보딩 · 점프 후속2 | 리뷰 → 랜딩 |
| #2619 묶음 승격 준비 / planner | CHANGELOG [Unreleased] · 이 파일 · JOURNAL · ADR-0184 문구 | docs 게이트 → 랜딩 → 승격+양 트랙 sync |

## 재개
1. `scripts/planning_context.sh`로 복원한다. main·engine·uxui 정렬을 확인한다.
2. 파도 표와 iOS 범위는 [목표 A 계획](2026-09-23-goal-a-plan.md)에 있다. 워커 발사는 성재의 명시 go 뒤에 한다.
3. 미션·리뷰 전문·승격 헬퍼·ASC 점검 스크립트는 로컬 `claudedocs/resume-2026-09-23/`에 있다(재부팅에도 남는다). 계약은 이슈와 레포 문서가 정본이다.
4. 워크트리·스크래치 회수는 `~/.local/bin/momo-worktree-reclaim.sh`(launchd 매일 06:30)가 한다. 스크래치 사본은 `~/.cache/momo-scratch/`에 둔다.

이 파일은 현재 상태 하나만 유지한다. 결정은 ADR, 검증 원문은 PR 본문, 세션 이력은 JOURNAL, 실행 중 note는 공용 로컬 폴더에 둔다.
