# oort 현재 상태

기준: 2026-10-01, Opus 5.5 planner. 목표는 **A**다([ADR-0187](../adr/0187-goal-a-team-daily-desktop-ios.md) Accepted): 팀이 데스크탑·iOS로 oort를 매일 쓰는 것이 먼저이고, 외부 출시는 그 뒤다. 배포 게이트는 [M7-I·M7-S](../cicd/03-store-readiness-gate.md)다. 실제 checkout·HEAD·통합 결과는 공용 로컬 기록과 Git/PR에서 확인한다.

## 전체 위치
| 단계 | 완료 / 현재 | 다음 조건 |
|---|---|---|
| 실행 체계 | planner=Opus 5.5 · worker=Opus 5.5 서브에이전트 · 리뷰어 C·보안 검수·design-review=fresh 서브에이전트. 묶음 승격(상시 위임), STATUS 동결(증거=PR 본문) | 병렬은 PIPELINE §2 기준. 엔진 워커 1개당 `target` 20~30GB — 랜딩 직후 회수 |
| 팀 인스턴스 | `oort-team` https://oort-team.up.railway.app **v0.1.15**(schema 110, 10-01, build `main=a6e5cd1b`, digest `sha256:1759d196…`, [릴리스](https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.15)). 워커 메모리 32GB라 임베딩 켬. `MOMO_HOSTED_DELIVERY_ENABLED=true`(09-27 owner 승인). 배포 기록 #3250·#3251 | **팀 「기본 AI」 채널 요약 행 미설정 → 요약·정리 유휴(owner)** · LiveKit 배치 #2759(배포 직전 owner 확인) · 팀 키 입력은 owner |
| 증거 빌드 | 데스크탑 0.1.15 공증 DMG(`~/Downloads/oort-0.1.15-evidence.dmg`, owner 기기) · iOS 3030 `momo-internal-test`(owner 1인), 10-01(#2568·#1607 기록) | owner 스모크 대기: 팀 기억(카드·칩·제안·브라우저) + 0.1.14 잔여(「Claude Code로 로그인」 왕복, 폰 프로필 상태·알림 일시 중지, 터미널 테마, 팀 키 채널 대화, Claude Code DM) |
| 팀 기억 v2 | [ADR-0196](../adr/0196-team-memory-v2.md)(0129 대체) M0~M3 main `58cfd534`, migration 098~110, #3158~#3174·#3208·#3212 닫힘. 요약·롤업, 항목(결정·사실·약속), 에이전트 문맥 공급+영수증, 「기억해 둘게요」 제안, 기억 브라우저·편집·잊기, 야간 정리, 로컬 e5-small 벡터 검색+가중 RRF, 워크스페이스 초기화·팀 공지, 웹·폰 화면. 보안 검수 약 15라운드 | 후속 #3189·#3201·#3211·#3225·#3234·#3236·#3243. 그래프 뷰(M4)는 목표 A 밖 |
| 에이전트 쓰기 | BYOK Anthropic·xAI·OpenRouter(#2872, ADR-0147·0004 증보), provider egress SSRF 가드(#2852·#2894), 답 못 한 이유 안내(#2871), hosted 1:1 DM 승인(#2915, ADR-0162 증보 2), 개인 구독 격리(#2882·#2897) | 실사용 왕복 runtime-unverified — owner 확인 |
| AI 계정 설정 | 결재 Q1~Q7(09-27, [시안](https://claude.ai/artifact/Y8GWHyaW2Z41bKxKB2uutB)). 랜딩: 재진입 #2870, 틀 #2877, 로그인 모달 #2816(공식 CLI 숨은 PTY, oort 자체 OAuth 금지), ADR-0190 D3-d~g·0193·0147 증보(#2876). Claude 구독으로 앱 명령 실행기는 닫음(Anthropic 약관) | #2878 추가·해제 연결 · #2880 팀 키 흐름 · #2881 기본 AI 표 · #2777·#2781·#2782 확장 · #2879 · #2883 Jev(판정기 ADR 뒤) |
| 작업 탭 | 결재 Q1~Q6(09-27, [시안](https://claude.ai/artifact/Wi3dNY64UbyoQCU9q1qLuM)), 이슈 T1~T17 #2853~#2869. 랜딩: T1 ADR(#2853, ADR-0190 D3-c·D4-b, ADR-0194), T2 「내 작업」 #2854, T3 git 읽기 G1~G8 #2855(설정 키 전수 표), 작업 표면 런타임 판정 #2780 | T4 #2856 → T5·T6·T7·T8 → W-Share(T9~T12·T16) → W-Link(T13~T15·T17). M2 #2778 workd 번들·#2779 진행 뷰 |
| 알림·상태 | 폰 프로필 빠른 설정 #2848, 방해 금지↔알림 일시 중지 묶음·기한 #2850(migration 090) | #2899 기한 선택 UI · #2851 다른 기기 즉시 반영 |
| 디자인 2.0·브랜드 | ADR-0189, 코메토 K6, 앱 아이콘 I4, 터미널 다크 #2849 | DS2-5 #2717 · DS2-7 #2719 · DS2-8 #2720 |

## 다음 행동
1. **owner:** 팀 「기본 AI」 채널 요약 행을 설정한다. 그 뒤 데스크탑 0.1.15 DMG·iOS 3030 스모크(팀 기억 + 0.1.14 잔여).
2. 스모크 뒤: R2 플래그 켜기 순서(#3030 R2-E10) → 패스키 P1~P8(#3045~#3052).
3. 팀 기억 후속(#3189·#3201·#3211·#3225·#3234·#3236·#3243)과 기존 후속 파도 편성.

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
