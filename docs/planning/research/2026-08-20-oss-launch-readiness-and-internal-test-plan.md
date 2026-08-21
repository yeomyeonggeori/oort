# 오픈소스 런칭 준비도 실측 + 내부 테스트 운영(ITO) 계획

- 날짜: 2026-08-20 · 작성: Fable(momo-main, PLN-20260815-01)
- 발제: 성재 — "오픈소스 퍼블리싱 전에 내부 테스트 운영(호스팅→온보딩→실사용)을 웹+데스크탑 연동 중심으로 진행. 셀프호스팅 유저 관점의 테스트 계획과 현재 단계 확인. 향후 워커=grok 4.6, 기획 검수=Fable."
- 성격: 리서치+편성안. **티켓 발급·워커 발사 전 단계** — §7 결정 큐 승인 후 집행.

---

## 1. 요약 판정

**"오픈소스화"의 잔여는 레포 공개가 아니다 — 레포는 이미 public이다**(2026-08-10 전환, Apache-2.0, 히스토리 클린 판정 완료). 정본 지시서의 런칭 정의가 이미 있다:

> "**외부 셀프호스터 3명 이상 + 에이전트 멘션·런 실사용**이 런칭. 레포 공개는 시작이지 런칭이 아님" — `docs/planning/2026-08-10-public-release-directive.md:11`

따라서 성재가 발제한 **내부 테스트 운영은 바로 이 런칭 정의의 리허설**이다: 우리가 첫 "외부" 셀프호스터가 되어 문서만 보고 설치→온보딩→실사용을 완주하는 것. 이 계획은 그 리허설(ITO)과, 리허설과 병렬 가능한 런칭 잔여 갭(L 시리즈)을 분리해 편성한다.

현재 단계(3관문 기준, `2026-08-10-buzz-launch-diagnosis.md` 체계):

| 관문 | 상태 |
|---|---|
| ① 오픈소스 공개(source-available) | **완료** — public·Apache-2.0·DCO·README 재작성·정리 6종(#1224)·라이선스 게이트(#1225) 전부 랜딩 |
| ② 단일 이미지 셀프호스팅 | **로컬 빌드 경로 완주 실측**(#1229·#1534 — 첫 실행 M1=1:20, 임기응변 0회). **digest pull 경로 미개통**: GHCR 첫 발행 미실행(`SELF_HOST.md:88` runtime-unverified), NOTICE bundle #1332 OPEN(P0) |
| ③ 프로덕션 운영 신뢰 | 부분 — NCP 프로덕션(8d0f7d9a)은 라이브지만 `runtime-unverified(public host)` 라벨군(실 DNS/ACME/registry pull/SOPS/pgBackRest·PITR)은 셀프호스터 관점 미검증. #1330(PITR) needs-review |

제품 축 상태(스냅샷 42): LIVE-5(채팅 내 VM 관전+직접 조작) 전 축 실기동 종결·정직 라벨 0 잔여(잔여 1건 `unverified.inputDeliveryInMicroVM`은 성재 손 — momo-server 배치). 파도 10까지 완주, engine→main 승격(107커밋) 완료. #1361 Grok E2E 성재 1단계 대기(로컬 스택 7컨테이너 가동 유지 확인 — 2026-08-20 실측 22h healthy).

---

## 2. 오픈소스 런칭 잔여 갭 (L 시리즈 — ITO와 병렬 가능)

조사 실측(2026-08-20, 레포 전수) 기반. 파일 좌표는 각 항목 조사 원문 참조.

| # | 갭 | 근거 | 무게 |
|---|---|---|---|
| L1 | **#1332 GHCR 재배포 고지 bundle**(P0·blocked) — NOTICE가 자인하는 결손(Rust 644 crates·npm 1,258 미커버)의 결정적 생성+이미지 동봉+drift gate. **이미지 첫 발행의 법적 선행** | NOTICE 커버리지 고지·이슈 #1332 | 필수 |
| L2 | **GHCR 첫 digest 발행** — `publish-images.yml` 준비 완료(workflow_dispatch·release Environment·owner 승인 게이트), 실행 0회. SELF_HOST digest 경로가 이것 없이 죽은 문서 | `SELF_HOST.md:57-88` | 필수(성재 attended) |
| L3 | **릴리스 태그 0건** — SECURITY.md가 "최신 v0.x 태그 지원"을 약속하는데 태그·릴리스가 없다. 첫 `v0.x` 태그+GitHub Release+RELEASING 절차 신설 | `git tag` 빈 출력 | 필수 |
| L4 | **CI 시크릿 스캔 부재** — gitleaks는 로컬 게이트 전용(`scripts/check_secrets.sh`). 외부 기여자 PR은 시크릿 스캔을 안 거친다 | `.github/workflows/pr-ci.yml` gitleaks 0건 | 높음 |
| L5 | **커뮤니티 루트 문서 부재** — CODE_OF_CONDUCT·CODEOWNERS·CHANGELOG·GOVERNANCE·RELEASING 없음(buzz 진단의 "루트 문서 13종" 갭) | buzz-launch-diagnosis.md:44 | 중 |
| L6 | CONTRIBUTING 한국어 전용(README/SECURITY는 영어) — 영문판 또는 이중언어 | CONTRIBUTING.md | 중 |
| L7 | **외부 기여자 첫 경험 결함 후보** — #1267(web quotaModel TZ 의존 — "외부 기여자 첫 빨강 후보")·#1268(mobile 리눅스 결정적 실패)·#1260(node 핀 4갈래) | 이슈 원문 | 중 |
| L8 | **arm64 manifest 없음** — Apple Silicon 셀프호스터는 native digest pull 불가(로컬 빌드만). 지원 시점 결정 필요 | `SELF_HOST.md:70-75` | 결정 |
| L9 | #1300(P0 security — Centrifugo subscribe proxy 403 엣지 차단) blocked 해소 | 이슈 | 높음 |
| L10 | **stale 문서 스윕** — DEPLOY.md의 macOS SwiftUI 앱 문장(:131)·RELEASE_PLAYBOOK(공증 DMG+Sparkle=은퇴 스택 STAGE D)·알파 문서 4종의 `--profile macos-ui` 42회(STATUS.md:11이 "고치지 않았다" 명시)·web-legacy README의 "알파의 실제 웹 클라이언트" 문구(실측: `server-rust/Dockerfile:147-231`은 `clients/web`을 번들 — 문구가 낡음) | 각 파일 | ITO-0에 편입 |

비차단으로 판정된 것(재확인): privacy-policy 초안=앱스토어 트랙(`public-release-directive.md:11`)·상표 미등록 리스크(공개 차단 아님)·dependabot cargo 미커버(TODO 명시).

---

## 3. 내부 테스트 운영(ITO) — 설계 원칙

1. **문서가 곧 제품.** 테스터는 `docs/SELF_HOST.md`(+신설 온보딩 런북)를 그대로 밟는다. 문서 밖 임기응변 1회 = 결함 1건(#1229 방법론 승계).
2. **판정 계약 재사용.** `LOCAL_3_DAY_ALPHA_TEST_PACK`의 결정 계약(AWS_READY/BLOCKED/NEEDS_MORE_LOCAL)을 `LAUNCH_READY / BLOCKED / NEEDS_MORE_INTERNAL`로 개작. 증거 레이아웃·버그 심각도 등급 그대로 승계.
3. **측정 재사용.** `scripts/bench_onboarding.sh` M1~M5(첫 화면→첫 에이전트 응답)를 각 회전마다 수거. 기존 실측(M1 첫 실행 1:20.2·M5 NOTICE 3:58)이 기준선.
4. **인테이크=전량 티켓화.** 발견은 즉흥 수리하지 않고 `INTERNAL_ALPHA_FEEDBACK.md` 인테이크로 전량 티켓화→파도 편성(2026-08-10 데스크탑 검수 인테이크 규율 승계).
5. **표면 우선순위: 웹+데스크탑.** iOS는 M7 게이트 전 external TestFlight 금지(`IOS_TESTFLIGHT_RUNBOOK.md`)가 이미 성문화 — 성재 지시와 정합. iOS는 시뮬레이터 스모크(lane:phone)만 배정하고 실배포 검증은 스코프 밖으로 명시.

## 4. ITO 페이즈 편성

### ITO-0 — 사전 수리 파도 (grok 워커, 테스트 착수 전)

테스트를 막거나 왜곡하는 갭만 수리. 티켓 후보 5건(승인 후 발급):

| 후보 | 내용 | 근거 |
|---|---|---|
| T-A | **데스크탑 릴리스 빌드 로그인 실기동 검증+수리** — README Known gaps #1: 발행된 `0.1.0-next.*`는 CORS로 로그인 불가였고(서버측 allowlist는 #768로 랜딩) 이후 실기동 재확인 기록이 없다. 릴리스 빌드→셀프호스트 서버 로그인 1왕복을 실측하고 README 갱신. **데스크탑 축 전체의 관문** | `clients/desktop/README.md` Known gaps |
| T-B | **통합 온보딩 런북 신설** — "셀프호스트 오퍼레이터의 첫 하루": 부트스트랩(키 둘)→워크스페이스→**웹 GUI 초대 발급**(InviteSection 실물 존재 — 문서는 CLI `momo-ops.sh invite-create`만 다룸)→둘째 사용자 조인 링크 합류→에이전트 연결→첫 멘션 응답. 현재 조각 3문서(SELF_HOST §5·onboarding-deeplink·AGENT_HOSTING_QUICKSTART)에 흩어져 있고 GUI 경로 미문서 | 조사 §2 공백 |
| T-C | **테스트 팩 현행화** — 3-Day 팩+INTERNAL_ALPHA 스모크 A~F를 웹+데스크탑 기준으로 개정(ITO 시나리오 표=§5를 정본으로 결속), `--profile macos-ui` 42회 등 은퇴 스택 잔재 판정 | STATUS.md:11 |
| T-D | **데스크탑 next 채널 위생** — #1281(업데이트 매니페스트 구 org URL·옛 next.10 정정) 집행 + 현행 HEAD 재발행 준비(ITO-3 자동업데이트 시나리오의 전제) | 이슈 #1281 |
| T-E | L10 stale 문서 스윕(위 표) — T-B/T-C와 파일군 겹침 조정 후 배치 | §2 L10 |

### ITO-1 — 호스팅 (성재=오퍼레이터 역, Fable=측정 수거)

| 시나리오 | 내용 | 성공 판정 |
|---|---|---|
| H1 | **깨끗한 환경 첫 설치(로컬 빌드)** — SELF_HOST.md 1~4장 그대로. 가능하면 Docker 빈 상태 | M1~M3 측정·임기응변 0·브라우저 로그인 도달 |
| H2 | **digest pull 경로** — L1·L2 완료 후: 발행된 `@sha256` pin으로 재설치(+`gh attestation verify`) | `SELF_HOST.md:88` 라벨 해소 |
| H3 | **도메인+TLS 운영 경로 1회** — §운영 절차로 실 도메인 부착(기존 NCP 인스턴스 활용 가능). `runtime-unverified(public host)` 라벨군 일부 해소 겸 | 외부 브라우저 HTTPS 로그인 |

### ITO-2 — 온보딩 (2인 이상)

| 시나리오 | 내용 |
|---|---|
| O1 | 오퍼레이터 부트스트랩 — `PLATFORM_ADMIN_EMAILS`+`PROVIDER_LINK_MASTER_KEY`(키 둘) 배선→설정 표면 도달 |
| O2 | 워크스페이스 생성→웹 GUI 초대 발급→**둘째 실사용자**가 조인 링크로 합류(웹), 셋째는 데스크탑 딥링크(`oort://join`)로 합류 |
| O3 | AI 연결(provider 키)→에이전트 멘션→**M5=ANSWERED** 도달(기존 실측은 키 없는 NOTICE까지만) |
| O4 | 외부 에이전트 1종 실연결 — #1361 Grok E2E(성재 1단계 대기 중인 그 절차)를 ITO-2에 합류시켜 한 번에 처리 |

### ITO-3 — 실사용·연동성 (웹↔데스크탑 중심, 3일 도그푸드)

| # | 시나리오 | 확인점 |
|---|---|---|
| I1 | 동일 계정 웹+데스크탑 동시 로그인 | 메시지 실시간 양방향·`message.seq` 순서·읽음 상태(unread 배지) 두 표면 수렴·프레즌스 |
| I2 | 교차 기능 패리티 | 스레드·멘션 자동완성·승인 카드·완료 리포트 카드·인용 — 두 표면 동일 동작 |
| I3 | 딥링크 착지 | `oort://join`·채널 링크가 데스크탑 앱을 열고 정확한 방에 착지(웹 로그인 핸드오프 카드 LIVE-4 경로 포함) |
| I4 | 에이전트 세션 관전+개입(LIVE 축) | 웹·데스크탑 양쪽에서 VM 실화면 관전, 한쪽에서 control 개입 시 다른 쪽 observation 정합 |
| I5 | 데스크탑 자동업데이트 1왕복 | next 채널 재발행분 수신→자가 업데이트→재로그인 불요 확인(T-D 전제) |
| I6 | 네이티브 알림 | 수신 확인. **클릭 라우팅은 known gap(fire-and-forget)** — 기대치를 티켓과 문서에 명시하고 결함으로 중복 접수하지 않음 |
| I7 | 재연결 내성 | 네트워크 단절→복구 시 두 표면 타임라인 정합(outbox→relay 재구독) |
| I8 | (보조) iOS 시뮬레이터 스모크 | lane:phone 그린 + 수동 로그인·타임라인 1회. 실기기/APNs는 스코프 밖 명시 |

### ITO-4 — 판정·환류

- 발견 전량 인테이크 티켓화→심각도 등급→수리 파도(grok) 편성.
- 최종 보고서(3-Day 팩 템플릿)로 **LAUNCH_READY / BLOCKED / NEEDS_MORE_INTERNAL** 판정.
- LAUNCH_READY면 L 시리즈 잔여(태그·발행·커뮤니티 문서) 마감→런칭(외부 셀프호스터 모집)으로.

## 5. 순서와 병렬성

```
ITO-0 수리 파도(T-A~T-E, grok 2기 로테이션)  ──┐
L1(#1332)·L4(CI gitleaks)·L7(기여자 첫 빨강)   ──┼─ 병렬 가능(파일군 분리)
                                                │
ITO-1 H1 ─ ITO-2(O1~O4, #1361 합류) ─ ITO-3(3일) ─ ITO-4 판정
                │
L2(GHCR 첫 발행·성재 attended) ─ ITO-1 H2·H3 ─ L3(첫 태그/릴리스)
```

- 성재 손 항목: L2 owner 승인·#1361 1단계·ITO-1/2/3의 실사용자 역(성재+1인 권장).
- 워커 운용: **grok 4.6(grok-fleet)** 동시 2기 상한(토큰 로테이션), 검수·freeze 렌즈=Fable(+UI는 design-review). 기존 파도 규율(패킷 필수·폐곡선·track 랜딩) 동일.

## 6. 측정과 증거

- 매 회전 `bench_onboarding.sh` M1~M5 수거(기준선: M1 콜드 1:02·첫 실행 1:20 / M5 NOTICE 3:58 — ANSWERED 실측이 ITO-2 O3의 신규 데이터).
- 증거 레이아웃·심각도 등급=3-Day 팩 승계. ITO 산출 증거는 `claudedocs/ito-<날짜>/`(로컬)→보고서만 repo.
- 판정 근거가 되는 실측은 전부 파일 좌표와 함께 최종 보고서에 기록.

## 7. 성재 결정 큐

| # | 질문 | 권장 |
|---|---|---|
| Q1 | ITO-0 수리 파도(T-A~T-E) 티켓 발급+grok 워커 발사 승인? | 발사. T-A(데스크탑 로그인)가 최우선 — 실패 시 ITO-3 설계 변경 필요 |
| Q2 | L1(#1332)→L2(GHCR 첫 발행) 시점 — ITO와 병렬로 지금 착수? | 병렬 착수(L2 승인 클릭만 성재). H2가 이것에 걸려 있음 |
| Q3 | arm64(Apple Silicon digest) — 지금 vs 런칭 후? | 런칭 전 필요(셀프호스터 다수가 Apple Silicon일 것) — 단 ITO 비차단이므로 L 시리즈 후미 |
| Q4 | ITO-2/3의 둘째 실사용자 — 성재 외 1인 확보 가능? | 가능하면 2인(연동·초대 시나리오의 실질) — 불가 시 성재 2계정으로 대체 |
| Q5 | 커뮤니티 문서 톤(CoC 채택 여부 포함) | 별도 결정 — 런칭 전 마감이면 충분 |
