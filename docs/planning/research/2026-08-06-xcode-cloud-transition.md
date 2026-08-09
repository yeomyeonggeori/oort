# Xcode Cloud 전환 실측 (2026-08-06) — 비활성·RN 계승·Tauri 판정

> 실측 기준: origin/track/engine @1fcca80e + ASC check-runs API. 발제: 성재 "비활성 및 tauri·rn 베이스 재활성에 내 수동이 필요한지 + swift 셋업 계승 가능한지".

## 판정 3줄
1. **비활성 = 성재 수동(ASC 콘솔) 필요.** 워크플로 정의가 레포에 0건(ci_scripts·설정파일 전무 — ASC 서버 측 레코드)이라 지울 파일이 없고, 체크는 Xcode Cloud GitHub App이 푸시. **권장: Disable(삭제 아님 — 레코드를 RN용으로 재사용).**
2. **RN 계승 = 가능성 매우 높음.** MomoMobile이 MomoiOS와 **팀(YWQQFQM38J)·앱 번들(app.momo.ios)·NSE 번들(app.momo.ios.NotificationService) 100% 동일** → ASC 앱 레코드(6792002019)·App ID 2개·capability(Push·App Group)·APNs .p8 전부 그대로 승계. Xcode Cloud는 Apple 관리형 서명이라 "번들+팀+capability 일치"가 관건인데 이미 일치. **최저비용 경로 = 기존 "Default" 워크플로 disable 후 프로젝트/scheme만 MomoMobile로 재지정.**
3. **Tauri = Xcode Cloud 대상 아님**(xcodeproj 자체가 없음 — 원리적 불가). GH Actions 몫인데 **Tauri 빌드 워크플로가 아예 없음**(dependabot TODO 한 줄뿐) — 별도 티켓감. release-macos.yml은 MomoMac(Swift) 전용·workflow_dispatch 수동.

## 성재 콘솔 체크리스트 (5~10분, 시점 자유)
1. App Store Connect → 앱(momo, 6792002019) → Xcode Cloud → 워크플로 "Default" → **Disable** (지금 — PR 소음 즉시 소멸)
2. (레포 준비 완료 후) 같은 워크플로 Edit → 프로젝트/워크스페이스를 `clients/mobile/ios/MomoMobile.xcworkspace`, scheme `MomoMobile`로 재지정 → 트리거(브랜치/PR) 설정 → Apple 관리형 서명 동의 → (선택) TestFlight 액션·내부 테스터 그룹
3. Xcode Cloud 환경변수·compute 티어·알림은 그때 함께

## 레포 준비 6건 (워커 가능 — 성재 불요)
①`clients/mobile/ios/ci_scripts/ci_post_clone.sh`(node 22.11 확보→npm ci→bundle→pod install — Podfile이 node 하드 의존이라 순서 강제) ②**xcworkspace 커밋**(.gitignore:25 해제 — 현재 최대 공백: 워크플로 생성 시 클론에 보여야 선택 가능) ③node 버전 핀(.node-version) ④pbxproj 잔재 `CODE_SIGN_IDENTITY[sdk=iphoneos*]="iPhone Developer"` 제거(배포 아카이브 개발 identity 강제 위험) ⑤ci_post_xcodebuild.sh(NSE 임베드 검증 — 11-런북 검사 이식) ⑥docs/cicd/10에 워크플로 정본 등재(현재 콘솔에만 존재하는 미기록 자산).

## 근거 요지(전문은 조사 로그)
- 레포 흔적 0: ci_scripts 없음·설정파일 없음·체크명 "MomoiOS | Default"뿐(최근 8커밋 중 6 action_required — JOURNAL:635 선재 서명 이슈 기록). GH Actions 3종 전부 workflow_dispatch라 PR 자동 체크는 이것 하나.
- MomoMobile 준비도: 공유 scheme 있음(Archive=Release)·entitlements 10-런북 일치·Podfile node 의존(:2,:14)·metro가 core 소스 직결이라 루트 npm ci 불요·서명 Automatic(클라우드 서명 적합).
- 10-런북(Apple 자산 정본)에 Xcode Cloud 기록 부재 — "CI 레인만 비어 있음" 그대로.
