# ITO-0 수리 파도 통합 패킷 — 내부 테스트 선행 갭 5건

- status: ready
- planning: PLN-20260815-01 · owner: Fable(momo-main) · integrator: momo-main
- 기준 커밋: `origin/track/engine` (파도 10 완주 `28bf1a54` + 스냅샷 43 플러시 이후)
- supersedes: 없음
- 상위 정본: `docs/planning/research/2026-08-20-oss-launch-readiness-and-internal-test-plan.md` §4 ITO-0
- 결재: 우로보로스 인터뷰 `interview_20260820_074206` (2026-08-20 성재) — Q1 발사 승인·Q2 GHCR 체인 착수·Q3 arm64=런칭 전 후미·Q4 실사용자 A시도/B폴백·Q5 커뮤니티 문서=런칭 전 마감(위임)
- **워커 체제 특기**: 이 파도는 **grok 4.6 워커의 첫 구현 투입**이다(grok-fleet 스킬의 "게이트 통과율 실측 후 확대" 보류를 성재 지시로 개시). 오케스트레이터는 goal별 게이트 통과율·회전 수를 기록해 `research/2026-08-14-grok46-worker-integration.md` 후속 갱신의 실측 데이터로 남긴다. 병렬 상한 2기.

## goal 체인·머지 순서

| 배치 | goal | 이슈 | 파일군 |
|---|---|---|---|
| 1차(병렬 2) | **T-A** 데스크탑 로그인 실기동+CORS 기본값 | #1607 | infra/rust/*·scripts/self_host_env.sh·clients/desktop/README.md |
| 1차(병렬 2) | **T-C** 테스트 팩 현행화 | #1609 | docs/LOCAL_3_DAY_ALPHA_TEST_PACK.md·docs/INTERNAL_ALPHA*.md·docs/MACOS_ALPHA_UPDATE_CHANNEL.md |
| 2차(병렬 2) | **T-B** 통합 온보딩 런북 (T-A 랜딩 후) | #1608 | docs/ 신규 런북·docs/SELF_HOST.md 링크 1줄 |
| 2차(병렬 2) | **T-E** stale 문서 스윕 | #1610 | docs/DEPLOY.md·docs/RELEASE_PLAYBOOK.md·clients/web-legacy/README.md |
| 3차(단독) | **T-D** next 채널 위생 준비분 | #1281 (기존 이슈 재사용) | scripts/publish_next_build.sh·clients/desktop/src-tauri/tauri.conf.json 주변 |

머지 순서: T-A → T-C → T-B → T-E → T-D (T-B만 T-A 결정에 의존, 나머지는 파일군 분리로 순서 자유).

---

## T-A — 데스크탑 릴리스 빌드 → 셀프호스트 스택 로그인 실기동 + CORS 기본값 택일·배선

**결정 요약**: 서버 CORS 레이어(MOMO-605/#768)는 main에 랜딩 완료. compose 노브 `MOMO_CORS_ALLOWED_ORIGINS`는 기본 빈 값(=CORS 레이어 비장착, same-origin 웹 전용)이라 셀프호스트 스택에 Tauri 데스크탑이 로그인하려면 현재 오퍼레이터 수동 설정이 필요하다. 이 goal은 ①실기동 검증 ②기본값 택일 상신 ③채택안 배선까지.

**파일 맵**:
- `infra/rust/docker-compose.rust.yml:250-257` — `MOMO_CORS_ALLOWED_ORIGINS` 노브(기본 빈 값)와 설계 주석(MOMO-605/DESK-1)
- `infra/rust/docker-compose.rust.yml:87` — Centrifugo WSS origin 기본값에는 `tauri://localhost http://tauri.localhost`가 **이미 포함**(REST CORS와 별개 노브임을 주의)
- `scripts/self_host_env.sh` — env 생성기(611줄). `:562` 주석 "CORS가 성립할 여지가 없다(local.override.yml)" = same-origin 전제의 현행 문면
- `infra/rust/local.override.yml` — 로컬 서빙 형상(Caddy :80, same-origin)
- `clients/desktop/README.md:419-423` — Known gaps: 발행된 `0.1.0-next.*`가 CORS로 로그인 불가였다는 기록. "(#768) **not in this branch's base**" — main 랜딩 이후 실기동 재확인이 없어 stale
- `server-rust/bins/momo-server/src/cors.rs` + `tests/cors_allowlist.rs` — 계약 소비자(읽기 전용 참조)

**작업**:
1. 데스크탑 릴리스 빌드(`cargo tauri build --bundles app` — 서명·공증 불요, 로컬 app 번들)로 셀프호스트 스택(`scripts/self_host_env.sh --local-build` + compose) 로그인 실기동: `MOMO_CORS_ALLOWED_ORIGINS` 미설정/`tauri://localhost` 설정 각각 실측(실패·성공 양쪽 증거).
2. 기본값 택일 상신: self_host_env.sh 생성 env가 tauri origin 2종을 기본 포함할지. 논거에 보안 검토 포함(로컬 루프백 스택 한정 무해성 vs 운영 형상 오염 경로 — `caddy.override.yml` 운영 경로에는 파급 없음을 확인할 것).
3. 채택안 배선 + `scripts/tests/test_self_host_env_modes.sh` 동형 테스트 가산.
4. `clients/desktop/README.md` Known gaps 현행화(실측 결과 기준 — 낙관 서술 금지, 실기동 증거 좌표 병기).

**지켜야 할 계약**: `server-rust/**` 코드 무변경(배선/env/문서만) · 시크릿 비유입 · 기존 env 파일 절대 덮어쓰기 금지(self_host_env.sh 현행 계약 유지).
**함정**: Tauri release는 `tauri://localhost` origin이며 dev proxy가 없다(dev 모드 성공은 증거가 아님) · REST CORS와 Centrifugo WSS origin은 별개 노브 — 로그인은 되는데 실시간이 안 오면 후자 · macOS LaunchServices가 dev/release 스킴 핸들러를 하나만 선택.
**AC**: 릴리스 빌드가 셀프호스트 스택에 로그인+메시지 왕복(실시간 수신 포함) 실기동 증거 · 기본값 결정이 배선·테스트·문서 3점 세트로 랜딩 · README Known gaps에 stale 서술 0.

## T-B — 통합 온보딩 런북 「셀프호스트 오퍼레이터의 첫 하루」

**결정 요약**: 부트스트랩→워크스페이스→초대→합류→에이전트 응답의 단일 경로 문서가 없다. 조각 3문서에 흩어져 있고, **웹 GUI 초대 발급 경로는 실물이 있는데 미문서**(문서는 운영 CLI `momo-ops.sh invite-create`만).

**파일 맵**:
- 신설: `docs/` 아래 단일 런북(명명 워커 자유 — SELF_HOST.md와의 관계를 서문에 명시하고 상호 링크)
- 조각 소스: `docs/SELF_HOST.md:177-234`(§5 AI 연결·키 둘) · `docs/onboarding-deeplink.md`(`oort://join` 계약) · `docs/AGENT_HOSTING_QUICKSTART.md`(ACP 에이전트) · `infra/prod/momo-ops.sh:321-361`(CLI 경로 — 참조로만)
- GUI 초대 실물: `clients/web/src/features/settings/InviteSection.tsx`(createInvite·buildJoinLink·mailto 핸드오프·만료/역할)
- 측정 좌표: `scripts/bench_onboarding.sh:31-41`(M1~M5·ANSWERED/NOTICE/BLOCKED 판정)

**작업**: 깨끗한 스택에서 오퍼레이터 첫 하루를 실기동으로 완주하며 문서화 — ①부트스트랩(키 둘: `PLATFORM_ADMIN_EMAILS`+`PROVIDER_LINK_MASTER_KEY`) ②워크스페이스 생성 ③웹 GUI 초대 발급 ④둘째 사용자 합류(웹 조인 링크 + 데스크탑 `oort://join` 딥링크 양 경로) ⑤AI 연결→첫 멘션 응답. 문서의 전 절차는 실기동 검증(#1535 §4 재작성 방법론 — 화면 실물 기준·임기응변 발견 시 그 자체를 결함 기록).
**함정**: CORS 절은 T-A 결정 의존 — T-A 랜딩 후 착수(2차 배치) · provider baseUrl은 `MOMO_ENV=staging`에서 외부 https만 허용(`bench_onboarding.sh:38-41`) — ANSWERED 실측엔 실키 필요, 문서는 키 주입 절차까지만 책임.
**AC**: 신규 사용자가 이 문서 하나로 첫 하루 완주 가능(교차 참조 없이 — 링크는 심화용) · GUI 초대 경로 최초 문서화 · 실기동 증거 동봉.

## T-C — 내부 테스트 팩 현행화

**결정 요약**: 3-Day 팩·INTERNAL_ALPHA 스모크는 구조가 재사용 가능하나 은퇴 macOS SwiftUI 스택 전제가 잔존(`--profile macos-ui` 42회 — `STATUS.md:11`이 "고치지 않았다" 명시). ITO 판정 계약으로 개작한다.

**파일 맵**:
- `docs/LOCAL_3_DAY_ALPHA_TEST_PACK.md:105,141,168,195,292` — Day 0~3 체크리스트·최종 보고서 템플릿. 결정 계약 `AWS_READY/BLOCKED/NEEDS_MORE_LOCAL` → **`LAUNCH_READY/BLOCKED/NEEDS_MORE_INTERNAL`** 개작
- `docs/INTERNAL_ALPHA.md:226-345` — 스모크 A~F를 웹+데스크탑 기준 대응물로
- `docs/INTERNAL_ALPHA_FEEDBACK.md` — 클라이언트 무관, 미세 정정만
- `docs/MACOS_ALPHA_UPDATE_CHANNEL.md` — 은퇴 판정(배너) 후보
- ITO 시나리오 정본: `docs/planning/research/2026-08-20-oss-launch-readiness-and-internal-test-plan.md` §4-§5 (H1~H3·O1~O4·I1~I8) — 팩이 이 표를 결속
**작업**: 문서별 택일 상신(전면 개정 vs 은퇴 배너+신규) 후 집행. `--profile macos-ui` 42회는 실행 문서/사문서 분류 판정.
**AC**: ITO-1~4를 이 팩만으로 실행 가능 · 은퇴 스택 잔재가 "실행 지시" 위치에 0 · 판정 계약·증거 레이아웃·심각도 등급 승계.

## T-E — stale 문서 스윕

**파일 맵·작업**:
- `docs/DEPLOY.md:131-135` — "macOS 앱으로 로그인" 문장(클라이언트 W-S1/#1215로 삭제됨) → 웹/데스크탑 현행으로 정정
- `docs/RELEASE_PLAYBOOK.md` — 공증 DMG+Sparkle=은퇴 스택 STAGE D 전제(2026-06-24 이후 무갱신). 택일 상신: 은퇴 배너 vs Tauri 현행(진짜 채널: `scripts/publish_next_build.sh`·minisign+notary·`targets:["app"]`=zip) 재작성
- `clients/web-legacy/README.md:4-7` — "prod Dockerfile이 여전히 이 디렉터리를 빌드·서빙, 알파의 실제 웹 클라이언트" 문구는 실측 반증됨(`server-rust/Dockerfile:147,157,173,231`이 `clients/web`을 번들) → 실측 기준 정정
**계약**: T-B(신규 런북)·T-C(알파 팩) 파일군 비접촉 — 위 3파일(+발견 시 동형 최소 확장, 이탈 보고).
**AC**: 3파일의 은퇴 스택 서술이 현행 실측으로 정정 · 각 정정에 근거 좌표 병기.

## T-D — 데스크탑 next 채널 위생 (#1281 준비분)

**결정 요약**: 기존 이슈 #1281 재사용. **실발행은 성재 맥 필수**(minisign 키·Developer ID·notarytool 프로파일 — 시크릿 3종)이므로 이 goal은 준비분만.
**파일 맵**: `scripts/publish_next_build.sh:70`(배포 레포 momo-alpha)·`:228`(update-next.json) · `clients/desktop/src-tauri/tauri.conf.json:31-33`(매니페스트 URL) · #1281 원문(dev 가드는 tauri dev/--debug만 보호·release 로컬 버전이 항상 next.1이라 매니페스트 next.10보다 낮아 롤백 유발·구 org URL 잔존)
**작업(워커 몫)**: ①구 org(Dawn-kim-official) URL 잔존 전수 정정 ②release 로컬 버전 베이스라인 문제 수리(택일 상신: 빌드타임 버전 주입 vs 가드 확장) ③재발행 절차 체크리스트 현행화(성재 맥 실행 전제로 — 성재가 복붙으로 완주 가능하게).
**Out of scope**: 실발행·서명·공증(성재 손 — ITO-3 I5 자동업데이트 시나리오 직전에 성재가 집행).
**AC**: 구 org URL 0 · 버전 베이스라인 수리안 랜딩 · 성재 복붙 체크리스트.

---

## 공통 규율

- **검증**: 각 goal은 해당 `local_gate` 프로파일 + docs 명령 드리프트 게이트(#1525 계열) 그린. T-A는 실기동 증거(스크린샷/로그 좌표) 필수.
- **검수 렌즈**: 워커=grok이므로 freeze 교차 렌즈는 **Fable 직접 검수**(diff+실기동 증거 재판정). UI 변경 없음 — design-review 불요(신규 UI 발생 시 이탈 보고 후 투입).
- **이탈 보고 의무**: PR 본문 `## 계획 이탈` 절 필수(없으면 "없음"). 스코프 밖 발견은 수리하지 말고 티켓 후보로 보고.
- **착수 명령**: `scripts/goal_claim.sh <이슈번호>`로 트랙 base worktree claim → 패킷·이슈만으로 착수(채팅 맥락 불요 상정).
- **컨텍스트 델타**: 이 파도는 스냅샷 43(ITO 계획) 직후 — SELF_HOST §4는 #1535로 재작성 완료, 서버 CORS 레이어는 main 랜딩 완료, 데스크탑 업데이트 채널은 next(Tauri)가 유일 현행.

## 이슈 바인딩 (발급 후 기입 — metadata-only)

| goal | GitHub 이슈 |
|---|---|
| T-A | #1607 |
| T-B | #1608 |
| T-C | #1609 |
| T-D | #1281 (기존 — 편입 코멘트 2026-08-20) |
| T-E | #1610 |
