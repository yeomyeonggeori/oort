# Sol(GPT 5.6, Codex) 인수인계 패킷 — 2026-08-11

> 발신: Fable(momo-main 오케스트레이션 세션, ~2026-08-11). 수신: **sol** — 당분간 기획·리뷰 주도.
> 미션 4: ①인수인계·작업 동향 파악 ②코드 리뷰·문제점 진단 ③취약점 분석 ④오픈소스·셀프호스팅 준비 리뷰.

## 0. 지금 상태 (한 문단)

라이브(app.oor7.com)는 `momo-rust:a5193e5e`(main=track/engine 0/0, HEAD f808d9cb), 마이그레이션 068까지 적용. 성재의 데스크탑 검수 **배치 1(6건)·배치 2(5건)이 전부 랜딩·배포**됐다: 포커스링 인셋(#1272)·채널멤버 모달(#1271)·헤더 👤N+메뉴(#1273)·워크스페이스 레일 4a(#1276)/4b(#1286, 56px+아바타+나가기)·연결칩 이동 6a(#1277)/프레즌스 6b(#1285, ADR-0160)·알림규칙 실기능(#1284, ADR-0124 증보1)·레이아웃 전체폭(#1282)·updater dev 가드(#1280). 데스크탑 검수앱은 `~/Desktop/oort.app`(--debug 빌드 = dev 가드로 자동 업데이트 롤백 원천 차단, 런타임 실증됨).

## 1. 읽기 순서 (인수인계·동향 파악)

1. `CLAUDE.md` — 세션 규율 진입점(트랙·머지·하드룰). `AGENTS.md` — 워커 계약.
2. `docs/planning/CURRENT_STATE.md` 스냅샷 20 → 19 → 18 (최근 3일 흐름).
3. `docs/planning/JOURNAL.md` 최근 3항목 (배치 1·2·배포 창 5 회고 — **centrifugo config 사고 교훈 포함**).
4. 이 문서 §3~§6 (미션별 브리프).
5. 코드 동향: `git log --oneline -30 origin/main` + PR #1269~#1286 (배치 1·2 전체 체인).
6. 결정 배경: `docs/adr/0159`(디자인 시스템)·`0160`(프레즌스)·`0161`(워크스페이스)·`0124` 증보1(알림규칙)·`0004`(provider 경계)·`0130`(ACP).

## 2. 지켜야 할 규율 (요약 — 정본은 CLAUDE.md)

- **하드 불변식 6**: Postgres=SoT · Centrifugo=전송전용(transport carries never authors) · 단일 쓰기경로(REST→PG→outbox→relay) · 순서=`message.seq` · 에이전트=`member` · RLS FORCE · provider 자격증명 비유입(ADR-0004).
- planner는 자기 planning ID의 ADR/research만 수정. **공용 정본·GitHub Issue·main 머지는 성재 승인 뒤 momo-main이 통합.** planning ID는 `CURRENT_STATE.md`에서 claim.
- 경계 변경(API/보안/스키마/방향/스택)은 Accepted ADR 없이 머지 금지. `schema_v0.sql` 불변(마이그레이션만). 시크릿 커밋 금지.
- UI 변경 리뷰 기준 = ADR-0133(웹 Blocker 0·**High 0**), 도구 = design-review 에이전트 + momo-design-taste 스킬. 리뷰 산출물은 `docs/planning/research/YYYY-MM-DD-주제.md`.
- 배포·ssh·docker save/load는 성재 `!` 대행(세션 분류기 차단). **서버 config는 호스트 적응본 — 통째 덮기 금지, 백업+외과 삽입+checkconfig 사전 게이트**(8/11 사고 교훈).

## 3. 미션 ② 코드 리뷰·문제점 진단 — 진입점

최근 대형 3건이 서버 경계를 새로 열었다. 재리뷰 우선순위:

| 대상 | 파일 | 리뷰 포인트 |
|---|---|---|
| 프레즌스(#1285) | `server-rust/bins/momo-server/src/routes/`(presence)·`momo-ephemeral` crate·마이그 068 | 선언상태 팬아웃이 그 멤버의 ch: 채널로만 한정되는가(로스터 경계 누수)·EphemeralSignal 봉인 유지·require_human 우회 없나 |
| 알림규칙(#1284) | notifier `judge_targets` LEFT JOIN·마이그 066·`notification-rules` REST | DND/멘션예외 SQL이 본문 미판독 유지하나·RLS 격리·audit 동일 tx |
| WS 4b(#1286) | 아바타 3라우트·`DELETE /members/me`·마이그 067 | 마지막 owner 409 advisory lock 경합·아바타 스코프(cross-tenant 403)·ADR-0151 프리미티브 재사용 정합 |

검증 도구: `scripts/verify_merge_tree.sh`(8레인)·`scripts/design_preflight_web.sh`·`clients/web/gates/`(26 게이트)·PG 정합 테스트(`*_conformance_pg.rs`). 알려진 진단 대상: 리뷰가 남긴 Nitpick들(PR 본문)·#1275(self-leave admin gate — 제품 결함 후보)·#1274(채널 rename 라우트 부재).

## 4. 미션 ③ 취약점 분석 — 우선 의심 지점

1. **[실관찰] 라이브 Centrifugo proxy secret이 `dev-insecure-cent-proxy-secret`** — 8/11 배포 diff에서 서버 현행 config에 이 값이 보였다. dev 기본값이 prod에 남은 것인지, 회전 필요한지 판정하라. (파일: 서버 `/opt/momo/infra/centrifugo.json` — 레포엔 없음, `infra/prod/centrifugo.prod.json`은 placeholder)
2. 신규 upload 경로(워크스페이스 아바타): content-type/크기 제한·경로 통과(traversal)·인가(owner/admin 세터·멤버 읽기)·immutable 캐시 키의 추측 가능성.
3. presence PUT: 본인 외 설정 차단(require_human + 본인 확인)·rate limit 유무.
4. RLS FORCE 전수 감사: 마이그 066~068 신규 테이블/컬럼이 전부 RLS 아래인가(`workspace_avatar_media`·`notification_rule`·`member.presence_status`).
5. 인증 경계: `/v1/*` 401 게이트·웹훅 인바운드(#1265 미구현 확인)·webhook-sender의 아웃바운드 SSRF 가드.
6. 시크릿 위생: gitleaks 전수(과거 W-1222 사건 전례)·`.env`/compose 파일들·구 org(Dawn-kim-official) 잔재는 발행 산출물·문서/픽스처에 남음(활성 참조는 #1242가 스윕).
7. 보안 헤더 5종은 라이브 발효됨(8/9) — CSP 정합만 재확인.

## 5. 미션 ④ 오픈소스·셀프호스팅 준비 리뷰 — 현황과 공백

- **목표(성재 확정)**: 오픈소스 + 단일 이미지 셀프호스팅, buzz급 런칭.
- 된 것: README buzz급 개편(마스코트·불변식 표·정직한 ✅🚧💭 표·mermaid·3-command self-host)·`self_host_env.sh`·PR CI(ubuntu·path-filter)·레포 yeomyeonggeori/oort 리네임·구 org 방어 선점.
- 공백(리뷰 대상):
  1. **GHCR 첫 발행 미완(#1266)** — publish-images가 Swift/arm64 기준, 라이브는 Rust/amd64. Rust 리베이스 필요.
  2. 데스크탑 발행 파이프라인 정지(#1281) — 매니페스트가 7/26 next.10·구 org URL. 재발행은 성재 맥(셀프호스티드 러너+시크릿 3종).
  3. 외부인 온보딩 검증 0 — 문서만 보고 self-host 성공하는 제3자 리허설 없음.
  4. LICENSE/NOTICE·의존성 라이선스 감사(AGPL 백본 금지 원칙 하 재확인).
  5. 테스트 이식성 #1267/#1268 · React19 #1258 · eslint10 #1259 · node pin #1260.
  6. 공개 시점 게이트: 시크릿 히스토리 전수 스캔·이슈/PR 본문의 내부 정보(서버 IP 등— 배포 스크립트들이 scratchpad에만 있는지) 점검.

## 6. 성재 결정 큐 (sol이 리마인드·정리 담당)

| # | 결정 | 선택지 | 비고 |
|---|---|---|---|
| 1 | ADR-0124 증보1 최종 승인 | 승인 / 키워드까지(P9 불변식 재개봉 필요) / 롤백 | 랜딩됨·문서 Proposed. 권고=승인 |
| 2 | #1281 매니페스트 재발행 | 지금(성재 맥 ~10분) / 공개 릴리스 때 일괄 | release 앱 롤백 위험은 잔존 |
| 3 | #1275 채널 self-leave | 수리(누구나 자기 나가기) / 정책 유지 | 에이전트 leave 정책 동반 결정 |
| 4 | #1283 검색 입력 폭 | 전체폭 유지 / 검색만 640px 캡 | 라이브 보고 판단 |
| 5 | ADR-0104 human-presence 슬롯 은퇴 | 형식 승인 | ADR-0160이 해소 — 문서 정리만 |
| 6 | ADR-0157(샌드박스 네트워크 경계) | 검토 | 8/8부터 대기 중 |

## 7. 배치 3 후보 (성재 신규 피드백 + 적립분)

성재 검수 피드백이 오면 그게 배치 3의 본체. 적립분에서 편성 가능한 후보: #1275(결정 시)·#1274(rename 라우트)·#1278(폰 헤더 parity)·#1279(레일 4b 잔여 — 터치·에러 글리프·로딩 틴트)·#1287/#1288(캡처 픽스처)·4b-3(멀티 워크스페이스 스택·세션 전환 — ADR-0161 예약)·6b 잔여(타인 presence 로스터 렌더 — W-B2-1 적립)·#1255/#1256(PushRelay·WorkHostDaemon 포트).
