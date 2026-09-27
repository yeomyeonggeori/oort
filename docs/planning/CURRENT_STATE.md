# oort 현재 상태

기준: 2026-09-27, Opus 5.5 planner. 목표는 **A**다([ADR-0187](../adr/0187-goal-a-team-daily-desktop-ios.md) Accepted): 팀이 데스크탑·iOS로 oort를 매일 쓰는 것이 먼저이고, 외부 출시는 그 뒤다. 배포 게이트는 [M7-I·M7-S](../cicd/03-store-readiness-gate.md)다. 실제 checkout·HEAD·통합 결과는 공용 로컬 기록과 Git/PR에서 확인한다.

## 전체 위치
| 단계 | 완료 / 현재 | 다음 조건 |
|---|---|---|
| 실행 체계 | planner=Opus 5.5 · worker=Opus 5.5 서브에이전트 · 리뷰어 C·보안 검수·design-review=fresh 서브에이전트. 묶음 승격(상시 위임), STATUS 동결(증거=PR 본문) | 병렬은 PIPELINE §2 기준. 엔진 워커 1개당 `target` 20~30GB — 랜딩 직후 회수 |
| 팀 인스턴스 | `oort-team` https://oort-team.up.railway.app **v0.1.12**(schema 91, 09-27). api 서비스 변수 `MOMO_HOSTED_DELIVERY_ENABLED=true`(09-27 owner 승인). 배포 기록 #2916(v0.1.11)·#2926(v0.1.12) | LiveKit 배치 #2759(배포 직전 owner 확인) · 팀 키 입력은 owner |
| 증거 빌드 | 데스크탑 0.1.12 공증 DMG(owner 기기 직접 전달) · iOS 3026 `momo-internal-test`(owner 1인). main `21aead09` 기준(#2568·#1607 기록) | owner 스모크: 「Claude Code로 로그인」 모달 실제 왕복, 폰 프로필 상태·알림 일시 중지, 터미널 테마, 팀 키로 채널 대화, 사이드바 Claude Code DM |
| 에이전트 쓰기 | BYOK Anthropic·xAI·OpenRouter(#2872, ADR-0147·0004 증보), provider egress SSRF 가드(#2852·#2894), 답 못 한 이유 안내(#2871), hosted 1:1 DM 승인(#2915, ADR-0162 증보 2), 개인 구독 격리(#2882·#2897) | 실사용 왕복 runtime-unverified — owner 확인 |
| AI 계정 설정 | 결재 Q1~Q7(09-27, [시안](https://claude.ai/artifact/Y8GWHyaW2Z41bKxKB2uutB)). 랜딩: 재진입 #2870, 틀 #2877, 로그인 모달 #2816(공식 CLI 숨은 PTY, oort 자체 OAuth 금지), ADR-0190 D3-d~g·0193·0147 증보(#2876). Claude 구독으로 앱 명령 실행기는 닫음(Anthropic 약관) | #2878 추가·해제 연결 · #2880 팀 키 흐름 · #2881 기본 AI 표 · #2777·#2781·#2782 확장 · #2879 · #2883 Jev(판정기 ADR 뒤) |
| 작업 탭 | 결재 Q1~Q6(09-27, [시안](https://claude.ai/artifact/Wi3dNY64UbyoQCU9q1qLuM)), 이슈 T1~T17 #2853~#2869. 랜딩: T1 ADR(#2853, ADR-0190 D3-c·D4-b, ADR-0194), T2 「내 작업」 #2854, T3 git 읽기 G1~G8 #2855(설정 키 전수 표), 작업 표면 런타임 판정 #2780 | T4 #2856 → T5·T6·T7·T8 → W-Share(T9~T12·T16) → W-Link(T13~T15·T17). M2 #2778 workd 번들·#2779 진행 뷰 |
| 알림·상태 | 폰 프로필 빠른 설정 #2848, 방해 금지↔알림 일시 중지 묶음·기한 #2850(migration 090) | #2899 기한 선택 UI · #2851 다른 기기 즉시 반영 |
| 디자인 2.0·브랜드 | ADR-0189, 코메토 K6, 앱 아이콘 I4, 터미널 다크 #2849 | DS2-5 #2717 · DS2-7 #2719 · DS2-8 #2720 |

## 작업별 체크포인트
| 작업 / owner | 저장된 결과 | 다음 |
|---|---|---|
| 후속 버그 / 워커 대기 | #2893(검수 Medium 묶음 잔여) · #2923 웹 시험 빈틈 · #2924 커넥션 없는 구독 에이전트 · #2903 고정 migration 개수 시험 · #2890 폰 안내 링크 · #2929 gitoxide 검토 | 파도 편성 |
| 허들 / 보류 | H-6~H-12 #2762~#2768, Railway TCP LiveKit #2759 | owner 배포 확인 뒤 |

## 재개
1. `scripts/planning_context.sh`로 복원한다. main·engine·uxui 정렬을 확인한다.
2. 미션·리뷰 전문·승격 헬퍼(`promote-lib.sh`)·릴리스 노트는 로컬 `claudedocs/resume-2026-09-23/`에 있다. 계약은 이슈와 레포 문서가 정본이다.
3. 릴리스·배포는 건마다 owner 승인. GitHub `release` 환경 승인은 owner 클릭이다.
4. 워크트리·스크래치 회수는 `~/.local/bin/momo-worktree-reclaim.sh`(launchd 매일 06:30)가 한다. 엔진 워커 `target`은 랜딩 직후 수동 회수한다.

이 파일은 현재 상태 하나만 유지한다. 결정은 ADR, 검증 원문은 PR 본문, 세션 이력은 JOURNAL, 실행 중 note는 공용 로컬 폴더에 둔다.
