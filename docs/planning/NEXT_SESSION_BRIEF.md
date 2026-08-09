# 다음 세션 진입 브리프 (2026-08-09 저녁 · Fable 인계용)

> 새 Fable 세션이 **가장 먼저 읽는 자리**. `CURRENT_STATE.md`는 누적 이력, 이 문서는 **지금 무엇을 하면 되는가**만. 오래되면 지우고 다시 쓴다.
> 직전 배치는 우로보로스 인터뷰 선행 후 성재 승인으로 집행됐다(정본 `research/2026-08-09-ouroboros-session-planning-interview.md` — **브리프도 틀릴 수 있다는 것이 이 배치의 교훈**: 이전 브리프의 사실 오류 3건이 헛발주 직전까지 갔다. 의심되면 실측).

## 0. 한 줄

8/9 저녁 배치로 열린 전선 4개 중 **①#1215·②#1213은 종결**, ③배포는 완료(검수만 대기), ④Swift 삭제는 판정재료(PR #1216)가 성재 승인 대기다. 라이브는 헤더 5종 발효 상태.

## 1. 전선 현황

| 전선 | 상태 |
|---|---|
| ① #1215/#1210 | **종결**. 리뷰 PASS(B0·H0)·8레인 green·머지. 후속 = #1218(feature 층 border-line 스윕, Medium) |
| ② #1213 보안 헤더 | **종결**. 라이브 실측 5종 도달(CSP·HSTS 1일·nosniff·no-referrer·frame-ancestors). 폐곡선 = #1217(회수)→#1220(정책+게이트 라이브 확장)→배포→재실측 |
| ③ 배포+검수 | **배포 완료**: 서버 `momo-rust:6bfc9b82`(마이그레이션 063)·웹 `index-Dp1ym0h8`·헤더. **성재 검수 대기**: 데스크톱 `~/projects/momo-tracks/momo-worktrees/deploy5-b727ea4f/clients/desktop/src-tauri/target/release/bundle/macos/oort.app` + 폰(아래 ASC green이면 TestFlight 경로) |
| ④ Swift 삭제 | **판정 종결**(8/9 심야, 성재 4결정 — #1216 머지·판정표 §3 기록): 폐기 3·이식 확정 3(#1222 T13·#1223)·이월 5+종속 1·OutboxRelay=#1222 후 삭제. **W-S 남은 선행 = 감사 §6 순서+패킷 작성뿐** |

## 2. ASC / Xcode Cloud (8/9 저녁 재조준 완료)

- 워크플로 "Default"가 이제 **RN을 빌드한다**(워크스페이스 `clients/mobile/ios/MomoMobile.xcworkspace`·scheme `MomoMobile` — Fable이 성재 Chrome으로 콘솔 조작, `docs/cicd/10` §8-4 절차 소화).
- **첫 완전 그린 확정**(8/9 심야): #1219(덤프 절단)+#1221(application-identifier=아카이브 단계 선택 검사, 팀 보증은 keychain 그룹으로) 두 수리 후 track/engine·ci-appid 재빌드 **둘 다 green** — 아카이브·Apple 관리형 서명·3종 export·사후 검증 전 파이프라인 성립. **폰 검수 TestFlight 전환은 1클릭 거리**(Archive 액션 배포 준비=TestFlight 내부 + 테스터 그룹 — 성재 신호 시).
- 빨간 X 이력이 브랜치마다 쌓여 있던 원인(퇴역 Swift 빌드)은 소멸. 단 "모든 브랜치" 시작 조건이라 **푸시마다 RN 아카이브가 돈다** — 컴퓨트 사용량이 거슬리면 브랜치 축소는 성재 결정.

## 3. 성재 대기·결정 큐

1. **검수**: 데스크톱 oort.app + 폰(위 ②). 
2. **PR #1216 승인**(main 대상 문서 3건) — 특히 **`relay/OutboxRelay` 삭제 불가 판명**(8/9 웹훅 랜딩이 그 트리 위·Rust 웹훅 소비자 0건 → Swift 존치 or Rust 이식 결정 필요=구 S7과 결합) · 11패밀리 3칸 표의 판정 칸(구 S5).
3. dependabot 13건 방침(S9) · **engine→main 머지 승인**(S10 — 감사·문서 드리프트의 뿌리, engine이 40+커밋 앞) · #1164 ②·#1168·#1208 (기존 적립 불변).
4. 적립 티켓 후보: LiveKit 랜딩 시 CSP connect-src 갱신 수용기준 필수 · `infra/prod/Caddyfile` Permissions-Policy가 셀프호스트 허들 마이크를 죽임.

## 4. 상태 스냅샷 (8/9 저녁 종료 시점)

- **라이브**: 웹 `index-Dp1ym0h8` · 서버 `momo-rust:6bfc9b82`(롤백 = `b727ea4f`, 서버에 백업 2: `smoke.secrets.env.bak-20260809b`·`Caddyfile.bak-20260809`). 헤더 발효로 **브라우저에서 임의 호스트 관전 터미널·타 서버 접속이 닫힘**(설계된 축소·데스크톱 무관) — 성재 고지 완료 후 배포.
- **열린 PR**: #1216(성재 승인 대기) + dependabot 13.
- **워크트리**: `deploy5-b727ea4f`(배포·데스크톱 빌드 산출물 보유·브랜치 deploy6-6bfc9b82) · `caddy-recover`(ci-diag — 회수 가능) · `swift-rebaseline`(#1216 — 머지까지 보존) · `sechead-1213`(W3 — 머지됨, 회수 가능) · `dsfix-1210`(머지됨, 회수 가능).
- **활성 워커**: 0.
- HSTS 확장 일정(1일→1주→1년, preload 영구 금지)은 런북 §Caddy에 성문화 — 1주 후 재방문.

## 5. 운영 규율 (전 브리프에서 이어짐 + 이번 배치 추가)

- 워커 = 무명 단발 Opus. 패킷 없이 발주 금지. PR 만들고 STOP. 발주 전 랜딩분 대조.
- track base PR은 머지 시점 이슈 수동 종결. core 접촉 PR은 `verify_merge_tree.sh`(**8레인** — #1215부터 web lint 포함).
- UI 변경 design-review 필수(B0). 리뷰 전문은 research에 보존.
- NCP: 비번 재복호화 스크립트 = 세션 스크래치 `ncp-get-root-pw.py`(API 서명 v2, `~/.ncp`+pem이 원본). ssh/scp/docker 원격 조작은 분류기 차단 — **성재 `!` 대행은 "한 줄 스크립트로 묶어서"가 정착된 형태**(deploy-window.sh 전례).
- ASC 콘솔 작업은 Fable이 claude-in-chrome으로 직접 수행 가능(성재 로그인 세션) — 단 저장·활성화 같은 상태 변경은 성재 승인 받은 배치 안에서만.
- 리서치·기획 발제는 ouroboros 인터뷰 선행(Opus 5 워커 구동) 후 발사. 인터뷰 산출물은 research에 정본 보존.
