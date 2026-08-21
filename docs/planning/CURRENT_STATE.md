# oort 기획 현재 상태 (Planning Current State)

> **2026-08-21 스냅샷 47 (Fable · momo-main — ★L-파도 완주·v0.1.0 릴리스·성재=ITO-1만. PLN-20260815-01).** 컴팩트 복원 진입점.
>
> **★ 런칭 위생 완결**: **v0.1.0 첫 릴리스**(tag@45a154d2·digest 표·https://github.com/yeomyeonggeori/oort/releases/tag/v0.1.0) · gitleaks PR-range CI 레인 · 기여자 첫 빨강 2건 결정성 수리 · 커뮤니티 문서 4종(CoC v2.1·CODEOWNERS·CHANGELOG·CONTRIBUTING 영문 정본) — 전부 랜딩 후 **승격 main=`b1bf46e9`**(PR #1637)+sync 짝(#1638/#1639·topology 실측 OK). RELEASING.md=발행 반복 절차 정본. SELF_HOST §2-B=실 digest 문면.
>
> **오픈소스 런칭 잔여(성재 실테스트 제외)**: L 시리즈 사실상 소진 — 남은 자율 후보: #1635(CI 붕대 제거 — G3 랜딩으로 조건 성립)·arm64 발행(런칭 전 후미·Q3)·워커 티켓 후보 ~25건 선별 파도(#1600~#1604 포함)·H2 amd64 부팅 종단. **런칭 정의 잔여=외부 셀프호스터 3명(ITO 후)**.
>
> **★ 성재 다음 = ITO-1 실테스트 시작일 결정뿐**: SELF_HOST_FIRST_DAY 런북·LAUNCH_READY 팩·#1613 가드·v0.1.0 digest 전부 준비 완료. 시작 선언 시 Fable이 bench M1~M5 수거·인테이크 티켓화로 동행. (부수: T-D §8 재발행은 ITO-3 직전·NCP 2대 재기동은 I4 직전 — Fable 소관)
>
> **거버넌스**: org Owner 승격 없음 확정(성재 2026-08-21) — kwakseongjae=member 유지, 새 패키지 생성 시에만 owner(여명) 1회 요청. 발행 승인(release env)은 성재 계정 그대로.
>
> **워커 체제**: grok 4.6 병렬 1 안정(이 창 완주 5·검수 회전 2 — vite 타입·dockerignore 전부 실결함). 검수=Fable 실검증 재판정 유지.
>
> 이하 스냅샷 46:

> **2026-08-21 스냅샷 46 (Fable · momo-main — ★GHCR 첫 발행 완결·컨테이너 공개. PLN-20260815-01).** 컴팩트 복원 진입점.
>
> **★ 공개 컨테이너 첫 발행 폐곡선 완결**: 성재 dispatch+release 승인+**법무 검토 승인**(3판단 브리핑 기준 — 원장 #1332) → run success → **app `ghcr.io/yeomyeonggeori/oort@sha256:0fbddd36…`·postgres `…oort-postgres@sha256:c6806369…`** → 패키지 public(org owner 집행 — org 패키지 정책 해제 선행) → 익명 pull·digest 일치·attestation 2본 실측 PASS. 2026-08-10 지시서의 "GHCR 첫 발행" 항목 종결.
>
> **거버넌스 발견**: kwakseongjae=org member(owner=lifeissea 1인) — 패키지/조직 설정 병목. **Owner 승격 요청 전달**(성재→owner). / **arm64 실증**: Apple Silicon digest pull 불가 실측(amd64 단일 manifest — SELF_HOST 문서 경계 그대로). amd64 부팅 실측=H2 잔여·Q3(arm64=런칭 전 후미) 근거 보강.
>
> **다음 후보**: ①**L3 파도** — 첫 v0.x 태그+GitHub Release(digest 기재)·SELF_HOST §2-B digest 실값 문면 현행화·:88 runtime-unverified 해소·RELEASING 절차 ②**ITO-1 H1**(성재 실사용 — 전 조건 충족) ③L 잔여(CI gitleaks·커뮤니티 문서·#1267 기여자 첫 빨강) ④후속 큐(#1600~#1604+티켓 후보 ~25건 원장).
>
> **운영**: NCP cube·turn 정지 유지(스왑=oort-ncp.py)·프로덕션 유지·#1361 연기·로컬 스택 down(볼륨 보존). 워커=grok 병렬 1.
>
> 이하 스냅샷 45:

> **2026-08-21 스냅샷 45 (Fable · momo-main — ★GHCR 발행 선행 완결·승격 45a154d2·성재 발행 결재 대기. PLN-20260815-01).** 컴팩트 복원 진입점.
>
> **★ GHCR 체인 코드 완결·승격**: #1330(PITR — 리뷰 4건 대응·H1 실측 반증)·#1332(NOTICE bundle — cargo 292+npm 411·이미지 2본 실빌드 4종 해시 OK·검수 회전 1=per-Dockerfile ignore 결함 수리+일반화 단언)·#1613(교차-체크아웃 충돌 fail-closed — ITO-1 H1 선행 충족) 전부 track/engine 랜딩 후 **main 승격 `45a154d2`**(PR #1623)+sync 짝(#1624/#1625 — main=양 트랙 조상 실측).
>
> **★ 성재 다음 = 2클릭**: ①**법무 검토 1회** — `legal/generated/GHCR_THIRD_PARTY_NOTICES.txt`·재작성 `NOTICE`·`legal/THIRD_PARTY_NOTICES.md` 인덱스·Debian 인벤토리(전부 main에 있음) ②**GHCR 첫 발행** — Actions→publish-images workflow_dispatch(main)→release Environment 승인. 발행 후 Fable이 digest 실측·H2(digest 설치)·attestation 검증.
>
> **운영 상태**: NCP momo-cube-host·momo-turn **정지**(월 ≈₩43만 절감·`~/.local/bin/oort-ncp.py`로 스왑·ITO-3 I4 전 재기동)·프로덕션 t3-smoke 유지. #1361 성재 연기(비차단 — 테스트 팩 SKIP(#1361) 성문)·로컬 페어링 스택 down(oort-pgdata 볼륨 보존 — 재개 `momo-tracks/engine`에서 `--compose up -d --wait`).
>
> **다음 후보**: ①발행(성재 2클릭)→H2 실측 ②**ITO-1 H1**(성재 실사용 — SELF_HOST_FIRST_DAY 런북·bench M1~M5·조건 충족) ③후속 큐 선별 파도(#1600~#1604+워커 티켓 후보 ~20건 — 원장은 각 이슈 코멘트) ④L 시리즈 잔여(첫 v0.x 태그·CI gitleaks·커뮤니티 문서·arm64=런칭 전 후미).
>
> **워커 체제(확정 실측)**: 구현·리뷰 실무=grok 4.6 **병렬 1**(동시 2기 창 조기종료 실측)·-c 재개 유효·검수=Fable(실검증 재판정 — 이번 창 실적발 2). 상세는 memory momo-opus-implementation-pipeline.
>
> 이하 스냅샷 44:

> **2026-08-20 스냅샷 44 (Fable · momo-main — ITO-0 파도 5/5 완주·grok 워커 체제 개시. PLN-20260815-01).** 컴팩트 복원 진입점.
>
> **★ ITO-0 수리 파도 완주(5/5·전부 track/engine 랜딩)**: T-A #1614(셀프호스트 env tauri CORS 2종 기본·CORS 거부 케이스 실측 405/헤더0·허용 compose 실측+GUI 왕복=ITO-1 이관)·T-B #1615(**docs/SELF_HOST_FIRST_DAY.md** — 부트스트랩→GUI 초대→합류→멘션 단일 런북·로그인 화면 6문구 실기동 일치)·T-C #1612(3-Day 팩=**LAUNCH_READY/BLOCKED/NEEDS_MORE_INTERNAL** 계약·Day0~3=ITO-1~4 결속)·T-D #1617(**MOMO_CHANNEL_BUILD** compile-time 가드 — 로컬 release 롤백 구멍 폐쇄·NEXT_CHANNEL §8=성재 복붙 재발행)·T-E #1616(DEPLOY 로그인 문장·RELEASE_PLAYBOOK 은퇴 배너·web-legacy README 이분). 결재=interview_20260820_074206(Q1~Q5 — 스냅샷 43 참조·전부 확정).
>
> **★ 신규 P1 #1613(실사고 발견)**: compose 프로젝트명(`oort`)·pgdata 볼륨(`oort-pgdata`) 고정 이름 — 두 체크아웃이 서로의 스택·DB를 무경고 하이재킹(T-A 실기동 중 #1361 스택 재생성+PG 이중 기동 실측). **완전 복구·데이터 무손실**(ws1·agent2·msg2·8088 정상 — #1361 성재 1단계 여전히 유효). ITO-1 H1 전 수리 권장. 파일군=T-A와 동일 — 후속 파도 후보 선두.
>
> **grok 4.6 워커 체제 실측(첫 파도)**: 완주 6/7(1은 -c 재개)·조기 종료는 동시 2기 창 집중 → **병렬 1 보수 운용**(grok-fleet 스킬 갱신 후보). 품질 상·게이트 회전 0·티켓 후보 15건 원장화. 검수=Fable 전담(리뷰 실무도 grok 리뷰어 C 가능 실증 — #1342 C0/H1/M3/L2).
>
> **GHCR 체인(Q2 집행 중)**: #1342 리뷰 완료(PR 코멘트)·**rebase+발견 4건 대응 워커 비행 중**(1330 워크트리·단독). 랜딩 후 #1332 ready 전환 → 법무 검토+owner 발행 승인(성재)만 남음. H2(digest 설치 실측)는 그 뒤.
>
> **다음 후보**: ①#1342 랜딩·#1332 ready ②후속 파도(#1613 선두+T-워커 티켓 후보 15건 선별+#1600~#1604) ③**ITO-1 H1**(성재 실사용 — SELF_HOST_FIRST_DAY 신규 런북로 완주·bench M1~M5) ④#1361 1단계(스택 복구 확인됨·가동 유지).
>
> **성재 손**: #1361 1단계·#1332 후 법무+owner 발행 승인·ITO-1~3 실사용자 역(+가능하면 1인 확보)·T-D §8 실발행(ITO-3 I5 직전)·Xcode Cloud 체크리스트.
>
> 이하 스냅샷 43:

> **2026-08-20 스냅샷 43 (Fable · momo-main — 오픈소스 런칭 준비도 실측·ITO 계획 상신. PLN-20260815-01).** 컴팩트 복원 진입점.
>
> **★ 신규 축(성재 발제): 내부 테스트 운영(ITO)** — 오픈소스 퍼블리싱 전 셀프호스팅 유저 관점 내부 테스트(호스팅→온보딩→실사용, 웹+데스크탑 연동 중심·iOS는 시뮬 스모크만). 정본=`research/2026-08-20-oss-launch-readiness-and-internal-test-plan.md`. 핵심 판정: 레포는 이미 public — 런칭 정의(2026-08-10 지시서)="외부 셀프호스터 3+에이전트 실사용", **ITO=그 리허설**. 런칭 잔여 L1~L10(#1332 NOTICE bundle=P0·GHCR 첫 발행·첫 v0.x 태그·CI gitleaks·커뮤니티 문서·arm64·#1300·stale 스윕).
>
> **ITO 편성안(승인 대기)**: ITO-0 수리 파도 5건(T-A **데스크탑 릴리스 빌드 로그인 CORS 실기동**=관문·T-B 통합 온보딩 런북(웹 GUI 초대 경로 미문서 — InviteSection 실물 확인)·T-C 테스트 팩 현행화·T-D #1281·T-E stale 스윕) → ITO-1 호스팅(H1 로컬 빌드/H2 digest/H3 TLS) → ITO-2 온보딩(O1 키 둘~O4=#1361 합류) → ITO-3 웹↔데스크탑 8시나리오(동시 로그인 패리티·딥링크·자동업데이트·관전/개입·재연결) → ITO-4 판정(LAUNCH_READY/BLOCKED/NEEDS_MORE_INTERNAL). 측정=bench_onboarding M1~M5(기준선 M1 1:20·M5 NOTICE 3:58 — ANSWERED가 신규 데이터).
>
> **워커 체제 전환**: 향후 워커=**grok 4.6(grok-fleet)** 동시 2기 상한, 기획 검수=Fable(+design-review). 성재 결정 큐 Q1~Q5(정본 §7): ITO-0 발사·L1→L2 병렬 착수·arm64 시점·둘째 실사용자·커뮤니티 문서 톤.
>
> **유지 상태**: #1361 성재 1단계 대기(로컬 스택 7컨테이너 22h healthy 실측 유지)·Xcode Cloud 9/7 체크리스트. engine=`28bf1a54`+플러시 — 후속 파도 큐(#1600~#1604)는 ITO-0와 병렬 후보.
>
> 이하 스냅샷 42:

> **2026-08-19 스냅샷 42 (Fable · momo-main — 파도 10 완주·#1361 성재 대기. PLN-20260815-01).** 컴팩트 복원 진입점.
>
> **파도 10 완주(8/8)**: #1511·#1584(카피/낱말+**3클라** 게이트)·#1515·#1516(칩 그릇·톤 soft 토큰)·#1558·#1559(진행/잠금 분리)·#1479·#1480(폰 AX). **engine=`28bf1a54`**. design-review 4판+재확인 3판·회전 6회로 실결함 11건 적발 — 대부분 코드가 아니라 **주장**이 틀린 경우(정책·근거·「전수를 훑었다」). 후속 발급 5건: #1600(폰 톤 발산)·#1601(멘션 순위 — 코어)·#1602(그물 사각지대)·#1603(재고 묶음)·#1604(폰 진행/잠금 방언).
>
> **★ #1361 Grok E2E — 성재 1단계 대기 중**: 준비 완료(#1592 `research/2026-08-19-grok-e2e-prep.md`), **로컬 스택 7컨테이너 가동 중**(회수 금지 — 성재가 이어받는다). 성재가 할 일=①localhost:8088 로그인→에이전트→호스티드 에이전트 연결→**Grok Bot 선택**(새로 만들지 말 것)→「연결 값 다시 발급」 ②Grok 앱에 endpoint `http://localhost:8088/v1/mcp/agent-port`+Bearer 연결 값, Routine 이름 정확히 `Oort Inbox: momo Demo Workspace / Grok Bot` ③오케스트레이터에 알림. 연결 값은 1회 표시·15분 TTL이나 **실패해도 소모되지 않는다**(유효 handshake일 때만 소비 — 실측). 승인 화면에서 **scope 전부** 켜야 함(`agent:port:connect`만이면 tools/list가 빈 목록).
>
> **모델 운용**: Fable 5 한도 도달(2026-08-19) — 이 세션의 워커·검수 전원 **Opus 5**. 성재 지시로 검수 레인은 한시적 Opus 유지.
>
> **다음 후보**: ①#1361 본편 ②후속 파도(#1600~#1604) ③차기 engine→main 승격 창(파도 9·10+집행분) ④dsh C/D.
>
> **성재 손**: #1361 1단계 · Xcode Cloud 9/7 재활성화 체크리스트(켜기 전 Start Conditions 경로 제한: `clients/mobile/`·`packages/momo-core/`).
>
> 이하 스냅샷 41:

> **2026-08-19 스냅샷 41 (Fable · momo-main — ★집행 창 완주: TURN 은퇴·프로덕션 8d0f7d9a·LIVE-5 라벨 전해소. PLN-20260815-01).** 컴팩트 복원 진입점.
>
> **★ 집행 창(성재 SSH 위임)**: ①런북 §6 완주 — use-auth-secret 켜기·병행 **불성립 실측**(coturn은 켜지면 정적 무시·reload 불충분=restart)·정지창 은퇴(정적 401/단명 12/12) ②프로덕션 배포 68fc52ff→**8d0f7d9a**(LIVE-5 전 축·마이그 077 IDEMPOTENCY_OK·TURN 3키·검증 5종 그린) ③compose 배선 #1586 ④**#1588 microVM 내부 왕복 실측**(relay↔relay·ephemeral만·READY 경쟁 수리 v5) — **engine=`ef134609`·LIVE-5 정직 라벨 0 잔여**. 원장: #1545·#1587 close 코멘트+DEVIATION_LOG 집행 행.
>
> **성재 손(재정리)**: ①**#1361 Grok E2E — 성재 합의: 현 작업 종결 후 별도 세션**(의존 9건 전부 CLOSED·준비=오케스트레이터, 성재=Grok 앱 조작 15~20분) ②Xcode Cloud 9/7 재활성화 체크리스트(켜기 전 Start Conditions 경로 제한: clients/mobile/·packages/momo-core/ — 한도 소진 뿌리 차단) ③배포 후 관찰(첫 실사용 세션에서 ice_servers 단명 자격 확인은 #1588이 동형 구성으로 기증명).
>
> **다음 후보**: ①#1361 세션 ②자율 큐 파도(#1584 어휘 정렬·#1511·#1515/#1516·#1558·#1559·#1479/#1480) ③차기 engine→main 승격 창(파도 9+집행분) ④dsh C/D 검토.
>
> 이하 스냅샷 40:

> **2026-08-19 스냅샷 40 (Fable · momo-main — 파도 9 완주·승격 후 첫 파도 폐곡선. PLN-20260815-01).** 컴팩트 복원 진입점.
>
> **파도 9 완주(4/4)**: #1571(preview-guard 26레인 — grok PASS·실 점유자 red proof)·#1572(base 위생 2)·#1573(「멤버 추가하기」 개명 — 「초대」=워크스페이스 낱말 예약, design-review PASS)·#1574(remint (b) 집행 — TTL 천장 반증 서술 전수 정정). **engine=`fe3f2960`**. 판정 전건 accepted. 후속: #1584(어휘 정렬 마이크로 3).
>
> **다음 후보(성재 재개 시)**: ①자율 큐 파도(#1584·#1511 낱말+게이트·#1515/#1516 디자인 토큰·#1558 SaveButton·#1559 busy 잔여·#1479/#1480 폰 AX) ②dsh C/D 착수 검토 ③차기 승격 창(engine이 main보다 파도 9만큼 앞 — 게이트 그린·랜딩 단위 위임 범위).
>
> **성재 손(비차단)**: 스냅샷 39 목록 그대로 — SSH류(#1545·momo-server 배치)는 오케스트레이터 권한 거부로 성재 직접, C-1·#1361·배포 검증.
>
> 이하 스냅샷 39:

> **2026-08-19 스냅샷 39 (Fable · momo-main — ★engine→main 승격 완료·파도 9 비행. PLN-20260815-01).** 컴팩트 복원 진입점.
>
> **★ 승격 완료**: main=`e322ccf3`(107커밋 — LIVE-5 전 축·파도 5~8·CI 구조 해소). sync 짝 #1577/#1578로 topology 복원(main=조상·alignment PASS). 세 브랜치 전부 PR-only 보호 실측 확인(직접 push 거부) — 이후 모든 track 합류도 PR 경유.
>
> **파도 9 비행 중(4기)**: #1571(게이트 포트-스쿼트 가드 일반화+검출 창)·#1572(base 위생 마이크로 2 — openapi YAML 1.1·bench 주석)·#1573(「멤버 초대하기」 이중 의미 — 방향은 워커 택일 상신)·#1574(remint (b) 반영 — 서술 정정만). 패킷=`handoffs/2026-08-19-wave9-packet.md`. 완료 시 표준 폐곡선(#1573=design-review·#1571=Fable+grok).
>
> **성재 손(비차단·2026-08-19 위임 확장 후 재정리)**: SSH 집행류는 오케스트레이터 권한 거부로 성재 직접 — ①#1545(momo-turn use-auth-secret, 런북 §6) ②**microVM 내부 왕복용 momo-server 배치**(momo-cube-host 도달 가능 인스턴스 — 5c 잔여 라벨 해소 조건) ③C-1(Xcode 콘솔) ④#1361(pairing) ⑤배포 검증 1왕복.
>
> **자율 큐(파도 9 이후)**: #1511(낱말+게이트)·#1515/#1516(디자인 토큰)·#1558(SaveButton)·#1559(busy 잔여)·#1479/#1480(폰 AX)·폰 EmptyState 액션 자리(#1568 이탈 4). dsh C/D 착수 검토(LIVE-5 종결로 조건 성립).
>
> 이하 스냅샷 38:

> **2026-08-18 스냅샷 38 (Fable · momo-main — 파도 8 완주·★LIVE-5 전 축 종결. PLN-20260815-01).** 컴팩트 복원 진입점.
>
> **★ LIVE-5 종결**: 5a+5b에 이어 **5c 실기동 E2E 완주(#1565/PR #1570)** — 실 입력 왕복(datachannel→producer→XTEST→실 xterm, 1006프레임)·비관측 mutation red proof 양쪽·**remint 천장 반증**(coturn은 ALLOCATE 시만 만료 검사 — 택일 (b) 채택, 반영=#1574)·validate v2 실호출 개통. producer 실결함 3건(bundle-policy·30s 침묵 오판·오귀책 로그) 실기동 적발·수리 + freeze 회전 1(C1 재검증 굶주림 — 루프 선두 이동·--jam red proof). **engine=`d987ff58`**. 라벨 승격: `runtimeVerified.keystrokeReachesAnApplication` 등 — 잔여 1=`unverified.inputDeliveryInMicroVM`(권한 경계).
>
> **파도 8 완주(4/4)**: +#1535(SELF_HOST §4 실물 재작성)·#1563(Shift+Esc press-단위 1슬롯 — grok PASS)·#1536(빈 채널 첫 행동=쓰기 주·초대 보조 — design-review PASS, §4 문면 단서는 이 플러시로 정본 반영). **#1561 close**: alignment fail 0 실측(워커 전건 PASS·플러시 track 직행·sync PR 0).
>
> **다음 후보(성재 재개 시)**: ①engine→main 승격(81+커밋 — base 사고 뿌리 정비, 5c 종결로 조건 성립) ②후속 파도(#1571 게이트 가드·#1572 위생 마이크로·#1573 라벨 이중 의미·#1574 remint 반영+기존 큐 #1511·#1515/#1516·#1558·#1559·#1479/#1480) ③dsh C/D 착수 검토(LIVE-5 후 조건 충족).
>
> **성재 손(비차단)**: #1545(릴레이 use-auth-secret — 런북 §6)·**신규: microVM 내부 왕복 실측용 momo-server 배치**(momo-cube-host가 닿는 인스턴스 — 5c 잔여 라벨 해소 조건)·C-1(Xcode 콘솔)·#1361(pairing)·배포 검증 1왕복.
>
> 이하 스냅샷 37:

> **2026-08-18 스냅샷 37 (Fable · momo-main — 파도 7 완주·★LIVE-5b 랜딩·CI 구조 해소. PLN-20260815-01).** 컴팩트 복원 진입점.
>
> **★ LIVE-5 전 축 코드 랜딩**: 5a(엔진 — ephemeral TURN·내구 투영·observation 원자성)+**5b(웹 — 딥링크 전환·입력 포워딩 비관측 red proof·auto-return LATEWINDOW 증명·오버레이 설계만)** 완결. **engine=`9c2e16eb`** 계열. 잔여: **5c(실기동 E2E — momo-cube-host 실 입력 왕복·비관측 mutation·remint 실측)**+릴레이 use-auth-secret 켜기(#1545 — 성재 손·런북 §6 복붙).
>
> **CI 소음 구조 해소 확정(성재 인터뷰 2026-08-18)**: A-1(기획 플러시=track 랜딩·main=승격 시만 — TRACKS §3.1.1 성문화 #1562)+D-2(push 전 정렬 프리플라이트 상시)+C-1(Xcode Cloud 트리거 제한 — 성재 콘솔·경로=#1561 코멘트). **이 스냅샷 플러시가 track-랜딩 첫 실행** — 다음 파도에서 alignment fail 0 실측 검증.
>
> **파도 7 완주(4/4)**: #1534(오퍼레이터 부트스트랩 — 키 둘·M5=3:58 NOTICE)·#1510(propsKind 거짓 묘비 해소)·#1541묶음(busy 소탕)·#1549(5b). 파도 6까지 누계는 스냅샷 36.
>
> **다음=LIVE-5c 편성**. 자율 큐: #1511(낱말+게이트 — 편입 2건)·#1515/#1516(디자인 토큰)·#1535/#1536(온보딩 T3/T4)·#1558(SaveButton 정본 결함)·#1559(busy 잔여 반)·#1563(stuck key)·#1479/#1480(폰 AX). **성재 손(비차단)**: #1545(릴레이)·C-1(Xcode 콘솔)·#1361(pairing)·배포 검증 1왕복. engine→main 승격(81+커밋)은 5c 후 정비 항목.
>
> 이하 스냅샷 36:

> **2026-08-18 스냅샷 36 (Fable · momo-main — 파도 6 완주·★LIVE-5a 랜딩. PLN-20260815-01).** 컴팩트 복원 진입점.
>
> **★ LIVE-5a 랜딩**: ephemeral TURN(use-auth-secret HMAC·capability 동봉·TTL 24h clamp)·control 내구 투영(원장 SoT+4투영 lease 절·마이그 077 가산)·observation 전환 원자성+owner_only owner 예외 — **engine=`c9a390d9`**. grok 보안 freeze 경계 전부 닫힘. 잔여 2: ①릴레이 use-auth-secret 켜기=**#1545(성재 손 — 런북 §6 복붙 절차·SSH 22가 운영자 IP 한정)** ②producer remint 실측=5c AC.
> **파도 6 완주(5/5)**: +#1525(docs 명령 게이트)·#1526(온보딩 실측 — F1 뿌리=#1534)·#1527(컨텍스트 규율 정본)·#1502(in-flight 6사이트).
>
> **다음 작업=LIVE-5b 편성**(웹 직접 조작 UI: LIVE-4 딥링크 진입·입력 포워딩 datachannel·자격 비관측 클라 보증·실패 auto-return·오버레이 설계·design-review). 5c(실기동 E2E — remint 실측 포함)는 5b 후. 편성 정본=`handoffs/2026-08-17-live-5-direct-control-ux-plan.md`.
>
> **구조 정비 항목(위임 검토)**: engine→main 코드 승격 81+커밋 미실행 — base 사고들의 뿌리(main 동기화 위임은 memory `momo-opus-implementation-pipeline` — 게이트 그린·랜딩 단위). 승격 시 #1464·#1525 게이트가 main에도 도달.
>
> **자율 큐**: #1534(T1 온보딩 선행)·#1535·#1536·#1541~#1543(busy/사유/착지)·#1510·#1511·#1515·#1516·#1449·#1396·#1392·#1405·#1400·#1381·#1450·#1452. **성재 손(비차단)**: #1545(릴레이)·#1361(pairing)·배포 검증 1왕복.
>
> 이하 스냅샷 35:

> **2026-08-18 스냅샷 35 (Fable · momo-main — ★발사 준비 완료(armed)·정지 중. PLN-20260815-01).** 컴팩트 복원 진입점.
>
> **★ 정지 중·발사 준비 완료**: 재개=성재 자유 발화. 재개 즉시 실행 순서 — ①**#1524 LIVE-5a 발사**(패킷 `handoffs/2026-08-18-live-5a-engine-packet.md` — ephemeral TURN(use-auth-secret 권장)·control 내구 투영(원장 SoT+조인 권고)·observation 원자성+owner 예외. ADR 전부 Accepted·이슈 binding 완료) ②병렬 위생 파도 후보: #1525(dsh-A 드리프트 게이트)·#1526(dsh-B 온보딩 실측)·#1527(dsh-H 반면교사)+기존 #1502·#1510·#1511 등. 5a→5b(웹 조작 UI·오버레이 설계)→5c(실기동 E2E) 순차.
>
> **dsh 벤치마크 반영 완료**: 정본 `research/2026-08-18-deepseek-harness-dsh-benchmark.md`·ROADMAP §1.7 overlay(A~H 축별 배치·비침해 원칙). C/D=LIVE-5 후, E(Trajectory)=세션 표면 심화(replay 먼저 권장 — fork 야심은 성재 미결), F=환경 폐곡선 합석, G=플랫폼 확장 시.
>
> **직전 완결(스냅샷 34)**: 파도 5개·랜딩 23건·결재 큐 소진(LIVE-5 4결정·ADR 3건 Accept·#1442 집행)·GitHub major 장애 통과. engine=`5e598773`·uxui=`b97f5d55`·main=`6dcc74a8`+ (전 트랙 정렬).
>
> **성재 손 필요(비차단)**: #1361 Grok pairing·배포 검증 1왕복. 성재 미결 1: Trajectory fork 야심 수준(기본=replay 먼저 진행).
>
> 이하 스냅샷 34:

> **2026-08-18 스냅샷 34 (Fable · momo-main — 파도 5 완주·결재 큐 소진·★정지 상태. PLN-20260815-01).** 컴팩트 복원 진입점.
>
> **★ 정지 상태(성재 지시 2026-08-17)**: 위생 파도 5 완주 후 일시 정지. **재개=성재 명시 발화(자유 형태·채팅 충분), 자동 조건 진행 불가.** 정지 중 질문 응대·상태 보고 정상. 재개 후 첫 작업=**LIVE-5a 패킷화·발사**.
>
> **LIVE-5 결재 완결(우로보로스 인터뷰 `interview_20260816_200427` 종결)**: ①발사=확정(정지 해제 후 착수) ②분해=5a(엔진 — **per-session ephemeral TURN 포함**)→5b(웹 UI·오버레이 설계 포함)→5c(실기동 E2E) 순차 ③진입점=LIVE-4 딥링크 우선. 편성 정본 `handoffs/2026-08-17-live-5-direct-control-ux-plan.md`+인터뷰 확정분.
>
> **위생 파도 5 완주(5/5)**: #1498(인용 null 4태)·#1503(폰 상태 역할)·#1463(검증 read-model — 채널 히스토리 DESC 스캔·스키마 무변경, grok 2건 회전 폐쇄)·#1501(busy 배선+명사+중)·#1472(fmt 게이트 단계 — record-not-pin). **engine HEAD=`aaaf2f34`**. GitHub major 장애로 #1512 발행 지연 — 교훈: head 전진 시 마커=라벨 재부착 짝.
>
> **ADR 결재 큐 완전 소진**: 0165 증보 2(`cd7b00f4`)·0156 증보 4·0157 증보 2(`3dd6f6ca` — 성재 명시 승인 2026-08-17) 전부 Accepted 랜딩.
>
> **재개 후 자율 큐**: LIVE-5a(최우선)·#1502(in-flight 5곳)·#1510(인용 계약 확장 — 층간)·#1511(낱말 잔여+게이트)·#1515/#1516(디자인 토큰)·#1449·#1396·#1392·#1405·#1400·#1381·#1450·#1452.
>
> **성재 손 필요(비차단)**: #1361 Grok 앱 pairing·배포 검증 1왕복.
>
> 이하 스냅샷 33:

> **2026-08-17 스냅샷 33 (Fable · momo-main — 위생 파도 4 완주·회전 0. PLN-20260815-01).** 컴팩트 복원 진입점.
>
> **위생 파도 4 완주(5/5·회전 0)**: #1489(폰 「작업 시간」 상수 결속)·#1488(도달 불가 카피 제거)·#1476(코어 null crash 3구멍 완결 — 타임라인 백지화 방어)·#1490(ConfirmButton busyLabel — 진행/잠금 문법 컴포넌트 완결)·#1491(done 칩 muted — 통과 세션에서 검증 칩만 초록). **engine HEAD=`cac7f16a`**. 파도 1~3 폐곡선 산물이 좌표를 정확하게 만들어 회전이 필요 없었다.
>
> **후속 큐(자율 가능)**: #1463(검증 read-model)·#1472(fmt+게이트)·#1479(@ 결합)·#1480(멘션 시트)·#1498(quote.ts)·#1501(busy 배선+명사+중 정본화)·#1502(in-flight 5곳)·#1503(폰 상태 역할) + #1449·#1396·#1392·#1405·#1400·#1381·#1450·#1452.
>
> **성재 회신 대기(비차단)**: ①인터뷰 Q1(LIVE-5 발사 — `interview_20260816_200427`) ②ADR 0156-4·0157-2 승인 한 줄 ③#1361 pairing ④배포 검증 1왕복. 전권 위임 체제·집행 실적은 스냅샷 32 참조.
>
> 이하 스냅샷 32:

> **2026-08-17 스냅샷 32 (Fable · momo-main — 전권 위임 체제 개시·결재 큐 집행·위생 파도 3 완주. PLN-20260815-01).** 컴팩트 복원 진입점.
>
> **★ 전권 위임 체제(2026-08-17 성재)**: 결재 대기=권장안 자율 집행·큰 결정=우로보로스 인터뷰·성재 손 필요 항목만 순수 대기(메모리 `seongjae-full-delegation`). 집행 실적: **#1442 랜딩**(`907e076c` — 보안 술어 6건 진리표 패치·PG 런타임 실증·정책 감사 마커) · **ADR-0165 증보 2 Accepted** · **done 칩 muted 확정**(#1491). 미결: ADR-0156 증보 4·0157 증보 2(분류기가 momo-main의 승인 표기 차단 — 성재 한 줄 확인 대기, 워크트리 /tmp/adr-accept에 0165분 편집 잔존) · **LIVE-5 인터뷰 진행 중**(`interview_20260816_200427` Q1=발사 시점, momo-main 권장: 지금 발사·5a→5b 순차·ephemeral TURN 자격 5a 포함·LIVE-4 딥링크 진입).
>
> **위생 파도 3 완주(4/4)**: #1478(`433ab9cb` 공백-본문 core 단일 판정)·#1466(`f09f9d00` REPORT_PROTOCOL 플래그 — off=pre-#1454 바이트 동일)·#1403(`1be4b087` aria-disabled+진행/잠금 문법 분리 5사이트)·#1468(`b46da0ee` 경과 낱말 — 「작업 시간」 상수화·조사 수리). **engine HEAD=`b46da0ee`**. 렌즈 수렴: 완전 그린 2·회전 폐쇄 1·grok 오탐 1 반증(교훈: freeze 스테이징에 인용 선례 파일 동봉).
>
> **후속 큐(자율 가능)**: #1463(검증 read-model)·#1472(fmt+게이트 단계)·#1476(코어 null crash)·#1479(@ 결합+AX 절 예산)·#1480(멘션 시트 상한)·#1488(죽은 카피)·#1489(폰 라벨 결속)·#1490(ConfirmButton busyLabel)·#1491(done 칩 muted) + 기존 #1449·#1396·#1392·#1405·#1400·#1381·#1450·#1452(#1450/#1452는 위임 결정 가능).
>
> **성재 회신 대기(비차단)**: ①인터뷰 Q1 답(LIVE-5 발사 시점 — 이후 Q2~4: 분해 순서·TURN 자격 범위·진입점) ②ADR 0156-4·0157-2 승인 한 줄 ③#1361 Grok 앱 pairing(손 필요) ④배포 검증 1왕복.
>
> 이하 스냅샷 31:

> **2026-08-17 스냅샷 31 (Fable · momo-main — 위생 파도 2 완주·양 트랙 정렬. PLN-20260815-01).** 컴팩트 복원 진입점.
>
> **위생 파도 2 완주(4/4·자율)**: **#1467**(PG 픽스처 `9ba981e2`)·**#1464**(goal_claim 트랙 base `13eb8b52` — 선언 신호 7순위 해석·소스 가시화·TRACKS.md §1.1, policy 감사 마커 절차 이행)·**#1465**(웹 null-body 빈 문단 `0d6cc97f`)·**#1443**(폰 컴포저 동적 타입 `70b42d53` — grok M1 회전으로 크롬 0.23 분리·AX 상한=목록 등분·캡처 레인 크롬 상시 재실측). **engine HEAD=`70b42d53`**. 부수 발견: 코어 잠복 크래시(#1476)·헤더 두께 주범=뒤로 글리프.
>
> **정렬 규율 확장**: main 플러시↔트랙 sync 즉시 짝을 **양 트랙**으로 — engine sync #1470(`ef3d0120`)+**uxui sync #1474(`a8ab97ec`)**(diverged 실측 해소). goal_claim이 이제 트랙 base를 스스로 인지(#1464)해 다음 파도의 수동 `--base` 불요.
>
> **후속 티켓 큐(자율 가능)**: #1463(세션 검증 read-model)·#1466(REPORT_PROTOCOL config)·#1468(경과 낱말 3종)·#1472(fmt 드리프트+게이트 단계)·#1476(코어 null crash)·#1478(폰 공백 패리티)·#1479(@ 결합+AX 절 예산)·#1480(멘션 시트 상한) + 기존 #1449·#1403·#1396·#1392·#1405·#1400·#1381.
>
> **성재 결재 대기(전부 비차단·스냅샷 30 항목 유지)**: ①#1442 보안 술어 패치 6건(이슈 blocker 코멘트 — 진리표 동봉) ②종료 상태 칩 ok→muted(코어 역할표) ③LIVE-5 발사 ④#1361 Grok 앱 pairing ⑤ADR 증보 4건 ⑥배포 검증 1왕복 ⑦#1450·#1452.
>
> 이하 스냅샷 30:

> **2026-08-17 스냅샷 30 (Fable · momo-main — UXC 파도 완주·완료 리포트 왕복 완성. PLN-20260815-01).** 컴팩트 복원 진입점.
>
> **UXC 파도 완주(자율 편성→발사→폐곡선)**: **#1441**(세션 경과 성과 단위 "N분 N초 동안 작업"+검증 칩 — 원장 스레드 리포트 집계·부재≠미검증) `b9cfbf69` · **#1454**(완료 리포트 **서버 프로듀서** — 모델이 ` ```oort:report ` 펜스로 저작 선언, 서버는 모양 검증·상한·redact·`elapsed_ms` DB 관측만, 스트리밍=props 패치) `30186176` 랜딩 → **#1440 카드의 소비자·프로듀서 왕복 완성**. **engine HEAD=`30186176`**. 정렬 스큐는 sync PR #1461로 해소(main@f7cce186 편입).
>
> **폐곡선 적발 10건 전수 수리**(3렌즈×회전 3): #1454=Fable M-1(펜스 맨-끝)+grok 4(본문 없는 리포트의 원시 봉투 커밋·안닫힌 외곽 펜스 예시 승격·제로폭 우회·DB/프로세스 시계 혼합)+재-freeze 2(물결 펜스·틱 앞 제로폭)→**FenceMark 상태 기계로 CommonMark 펜스 가족 완결**(뮤테이션 증명 8·PG conformance 12) / #1441=design-review High(320px 머리→원장 진술만, 폭 회귀는 캡처 레인 숫자 가드)+grok 2(ended/idle 스레드 캐시 미무효화·상한 절단 표 접기 거짓→omitted 침묵). 재-freeze 양쪽 C0/H0/M0.
>
> **#1442(toolchain) 성재 큐 파킹**: 레포에 rust-toolchain 파일 0(커서 "고정 1.83"=커서 환경 기본값) — 실결함=**거짓 rust-version 선언**(브래킷 실측: server 1.80→1.88.0·desktop 1.77.2→1.89.0). MSRV 상향이 **보안 술어 4곳(auth_routes 토큰 리프레시·rate_limit·messages 검증)의 미검사 lint를 드러냄** — 워커 자동 편집 차단(가드레일 타당 판정) → **패치 6건+진리표 동치 증명=이슈 #1442 blocker 코멘트, 성재 결재 대기**. PR #1459(문서/메타 6파일·head 5b884694)는 패치 랜딩·clippy green 후 머지+policy-integrity 마커. ⚠CI rust 레인 clippy 미실행 — CI 초록≠머지 신호.
>
> **후속 티켓 #1463~#1468 발급**: 검증 read-model(목록 행 칩+장스레드 — grok H2 포함)·goal_claim 트랙 base(워커 2기 동일 함정)·웹 null-body 카드 빈 문단(폰 패리티)·REPORT_PROTOCOL config 플래그·PG 픽스처 재실행 내성·경과 낱말 3종 정렬. **통합 실측 잔여**: 프로듀서 리포트의 세션 스레드 안착(#1441 칩 결선) `runtime-unverified`.
>
> **성재 결재 대기(전부 비차단·스냅샷 29 항목+신규)**: ①#1442 보안 술어 패치 6건(blocker 코멘트) ②종료 상태 칩 ok→muted(코어 역할표 — 검증 칩이 "정보 있는 초록"을 진 지금) ③LIVE-5 발사 ④#1361 Grok 앱 pairing ⑤ADR 증보 4건(0156-4·0157-2·0165-2) ⑥배포 검증 메시지 1왕복 ⑦#1450·#1452 위생 결정.
>
> **잔여 큐**: #1463~#1468 위생 후속(자율 가능)·#1449(폰 measure)·#1443(폰 컴포저)·#1403·#1396·#1392·데스크탑 검수 인테이크·LIVE-5(성재 신호 대기).
>
> 이하 스냅샷 29:

> **2026-08-17 스냅샷 29 (Fable · momo-main — 관전 라이브 화면 실물 도달·인프라 실기동·프로덕션 배포. PLN-20260815-01).** 컴팩트 복원 진입점.
>
> **★ 관전 라이브 화면 축 실물 완성**: LIVE-1(서버 `7179f3e5`)·LIVE-2(웹 `fbe49826`)·LIVE-3(control 개방 `460f142b`)·#1425(run 파킹 `8ce5ad38`)·LIVE-4(로그인 핸드오프 카드 `19455d54`) 전부 랜딩 → **프로덕션 배포 완료**(`momo-rust:68fc52ff` 라이브·마이그 069~076·centrifugo 403 방벽 동반) → **#1438 실기동 E2E 성립**(외부 브라우저가 TURN relay 경유 microVM 실화면 렌더 56프레임@720p — 성재 발제 "채팅 내 VM 화면"이 실물 도달, runtime-unverified 5→1 잔여=입력 LIVE-5). grok 실경계 적발 누계 5+건(전부 수리·재-freeze). engine HEAD=`b2474340`.
>
> **인프라 실발주·실기동(2026-08-16, 성재 위임)**: **momo-cube-host** 101.79.18.230(s8-g3/32GB·CubeSandbox v0.6.0·display 템플릿·형상 A 프록시)·**momo-turn** 223.130.142.109(coturn·relay 실증). 월 고정 ≈₩477k·관전 1h 트래픽 ≈₩45(ADR-0164 실단가). #1437 랜딩(envVars=동기 배달·1회용 수신기). E2E 신규 발견=**microVM link-local이 libnice TURN 디스커버리 미스케줄 → RFC1918 base 주입이 추가 요건**(ADR-0165 증보 2 사안).
>
> **위생 파도 8건 종결**(#1415·1413·1414·1418·1421·1422·1429·1431 — 후속 티켓 #1443/1449/1450/1452 등). 리서치 2정본(커서 ADE 벤치마크→UXC 후보 A~F·#1440~1442·그록 생태계→#1344 관문 해소). **UXC-A(#1440)** 완료 리포트 카드 동결(grok freeze 중).
>
> **성재 결재 대기(전부 비차단)**: ①**#1361 GROK-E2E 매뉴얼 스파이크**(서버 준비 완료·성재가 Grok 앱 pairing 실행 — 패킷 `handoffs/2026-08-16-grok-e2e-manual-spike-packet.md`) ②ADR 증보 4건(0156 증보 4·0157 증보 2·0165 증보 2 — 수신기/CubeProxy/ICE base 경계) ③사람 계정 메시지 실왕복 1건(배포 검증 완결) ④#1450 앰버 색상각·#1452 초안 보존 등 위생 결정.
>
> **자율 진행 결재(2026-08-16)**: 큰 파도도 Fable이 편성→발사→폐곡선 자율, 경계 ADR Accept·성재 손·비가역/비용만 질의.
>
> **잔여 큐**: #1455(display v3 랜딩·비행)·자격 로테이션(비행) → LIVE-5(창 열기 UX·입력 포워딩·observation 전환·세션 표면 내구 투영 — E2E 성립으로 개방)·UXC 파도(#1440 랜딩→#1441 칩→B env 폐곡선)·#1442 toolchain·데스크탑 검수 인테이크.
>
> 이하 스냅샷 28:

> **2026-08-15 스냅샷 28 (Fable · momo-main — 라이브 VM 관전·control 축 개설. PLN-20260815-01).** 컴팩트 복원 진입점.
>
> **신규 축(성재 발제 — Grok Bot 채팅 내 VM+직접 조작)**: 리서치 정본 `research/2026-08-15-in-chat-interactive-vm-takeover.md`(그린필드 아님 — 관전 해상도 증분·attach 축의 kind 확장) 랜딩. 코드 실측: 서버=프록시 없는 호스트 직결 계약(dto.rs:1002)·AttachMode(controller|observer) 기존재 → 라이브 개입="control"로 명명(인수 어휘 충돌 회피)·범위 술어=cloud+cubesandbox·BYOC fail-closed.
>
> **LIVE-1(#1409) 랜딩 완료**: PR #1410 squash → **`track/engine@7179f3e5`**(마이그 075·attach kind 축·라우트 3본·webrtcbin 템플릿 계약·`runtime-unverified(cubesandbox webrtc producer)` 정직 라벨). 리뷰 폐곡선: Fable C0/H0/M0/L1+verifier 재실행 PASS → grok freeze C0/H0/M0/L0 → CI. **policy-integrity 실측**: `Policy-Integrity-Audit: <full head SHA>` 마커 코멘트 → 라벨 전이가 그 **이후**(순서 검증 — 재부착으로 해소).
>
> **성재 결재 누계(2026-08-15 구조화 질의 2회·7건)**: LIVE-1 발사+연속 편성 · 경계=0004 증보 3 · 전송=WebRTC 직행 · **ADR-0165 Accept**(webrtcbin D1) · 도달성=**스파이크 선행**(#1411 발급) · owner_only owner 예외=**LIVE-3와 묶기** · **ADR-0004 증보 3 Accept**. 이탈 3건 전부 판정(DEVIATION_LOG 2026-08-15).
>
> **LIVE-2(#1412) 랜딩 완료**: PR #1416 squash → **`track/engine@fbe49826`**. 폐곡선 3렌즈(Fable C0/H0/M0 → design-review PASS+H1/M1 회전 → grok freeze C0/H0/M1/L0 → M1 누수 회전 수리 red proof). 이탈 5건 accepted. **관전 "라이브 화면" 축 = 서버(LIVE-1)+웹(LIVE-2) 완결** — 실화면 E2E만 #1411 대기(`runtime-unverified(live sandbox display)`).
>
> **#1411 스파이크 완주(2026-08-15)**: 폐기 VM 실측 — **microVM NAT symmetric → P2P/srflx 폐기, relay 유일·TURN은 CubeSandbox 호스트 동거 불가** ⇒ **전용 공인 TURN 호스트 1대 신규 운영 자원 확정**. 시그널링=호스트 WS 프록시(형상 A, 6.3ms). 정본 `research/2026-08-15-reachability-spike-1411.md`(E2E 개방 조건 7항·부수 F1~F8). **ADR-0165 증보 1 Proposed — 성재 Accept 대기(TURN 발주 결정 포함)**. 접근 복구: momo-t3-smoke pem 복원(`~/.ncp/`)·getRootPassword 절차 재실증.
>
> **위생 파도 종결(2026-08-15)**: #1415(`2f0b3984` 누수 동형 이식)→#1413(`268df1c8` 소유권 바닥 `--spacing-chat-min`)→#1414(`0ac1e08c` 상태 캡처 6장) — 전부 grok freeze C0/H0/M0/L0(쿼터 해제 첫 적용·3연속), #1413은 design-review PASS 추가. **track/engine HEAD=0ac1e08c**.
>
> **#1418 랜딩**(`f56c07f7` — 안쪽 열 바닥+1lh 클램프, 3렌즈 그린). 이월 선재 티켓: #1421(600~899 바닥·문턱 경계 결정)·#1422(절 생략+폰 예산).
>
> **성재 결재 집행(2026-08-16)**: ADR-0165 증보 1 **Accepted** · TURN=발주 검토 패키지 `research/2026-08-16-turn-dedicated-host-procurement-package.md`(**발주 결정 대기 — 성재 콘솔 체크리스트 §4**) · **LIVE-3(#1424) 발사(비행 중)** — control 개방 엔진 축(마이그 076·controller owner 한정·비관측=run 게이트·owner_only 예외), 패킷 `handoffs/2026-08-15-live-3-control-open-packet.md`.
>
> **LIVE-3(`460f142b`)·#1425(`8ce5ad38`) 랜딩** — control 개방+run 파킹(토큰 0=원장 성질). grok freeze 실경계 적발 누계 3건(재바인딩·교차-세션 잠금 — 각각 수리·재-freeze 무결). **우로보로스 인터뷰로 LIVE-4 편성 확정**(성재 승인 2026-08-16): 발제자 절단 — LIVE-4=에이전트 발제형 로그인 핸드오프 카드 축만, 정본 `research/2026-08-16-live4-interview-and-plan.md`. **LIVE-5 예약 확정**(창 열기·observation 전환/복원·auto-return·입력·ICE·E2E — TURN 발주 후 패킷화).
>
> **LIVE-4(#1428) 랜딩**: PR #1430 → **`track/engine@19455d54`**. 실증 2(승인 hold 재사용=발명 0·message.edited 재사용=클라 변경 0). 폐곡선 5회전 — grok 실경계 적발 누계 5건(이 파도). 관전 축 현황: **LIVE-1~4 완결**, 잔여=LIVE-5(TURN 후 — 예약 스코프에 세션 표면 내구 투영 포함)·실기동 E2E.
>
> **성재 대량 결재(2026-08-16) 집행 중 — 병렬 전환**: 발주=집행 완료(**momo-cube-host** 101.79.18.230 s8-g3/32GB/nested virt 실증 · **momo-turn** 223.130.142.109 — 월 고정 ≈₩477k·관전 1h 트래픽 ≈₩45=ADR-0164 실단가) · 문서 플러시=main@250f7507 머지 · Grok Bot 게이트 해제(#1344/#1361 큐 편입) · 배포=Fable 집행 위임(대상=momo-t3-smoke 101.79.11.189, 접근 확보 — 위생 꼬리 랜딩 후 최신 HEAD로).
>
> **인프라 실기동 완료**: INFRA-A/B 런북 랜딩(producer 실기동·TURN allocation 외부 실증) · #1437 랜딩(envVars=동기 배달·1회용 수신기 — ADR-0156 증보 4·0157 증보 2 초안 **성재 결재 대기**) · #1421(`199d90eb`)·#1422(`68fc52ff`) 랜딩. 리서치 2정본+티켓 #1440~#1443. 트랙 정렬 사고 2회 해소(교훈: docs→main 머지는 engine 동기 즉시 짝).
>
> **비행 중 2기**: **배포**(성재 위임 — engine@68fc52ff 서버+웹+마이그 069~076, 백로그 선행·롤백 보존) · **#1429**(blocked 톤 어휘 결정). **잔여 큐**: #1431(스레드 서랍 키보드)→#1344 Grok Bot 스파이크(관문 완전 해소)→#1438 실기동 E2E(ready — display 템플릿 수신기 재빌드가 첫 스텝)→UXC 파도(#1440/#1441/#1442)→#1443·LIVE-5 편성. **성재 결재 대기**: ADR-0156 증보 4·0157 증보 2(수신기·CubeProxy 경계).
>
> 그 외 상태는 스냅샷 27 그대로(HAP 완결·배포 대행 대기·main 미커밋 누적 — 본 세션 산출물 4건 추가).
>
> 이하 스냅샷 27:

> **2026-08-15 스냅샷 27 (Fable · momo-main — HAP 축 전체 완결).** 컴팩트 복원 진입점.
>
> **HAP 축 완결**: 엔진 E1~E7(#1358·1363·1364·1365·1366·1367·1368) + UX1~4(#1360·1362·1359·1369) 전부 track/engine 랜딩. 남은 HAP=**#1361 GROK-E2E만 blocked**(Grok Bot 티어 게이팅 — 성재 구독 결정). track/engine HEAD=99d42244.
>
> **오늘(8/15) 랜딩 18건**: E5·E6·E7·위생 6(#1374·1376·1377·1385·1375+1386)·CRUN 1/2/3·UX 1/2/3/4. 각 UX는 design-review PASS+폴리시 회전. E7·UX2/3/4는 대형이라 3사(Fable 검수·grok freeze·design-review) 다중 관문.
>
> **리뷰 체제**: sol(Codex) usage-limit **8/20까지** → grok 리뷰어 C가 freeze 렌즈(E7에서 Fable과 판정 일치). 당분간 Fable+grok+design-review. grok-fleet 스킬 정본.
>
> **성재 대기(급하지 않음)**: ①**배포** `momo-rust:d7b390cf`(위생6+UX1+CRUN, E7/UX2~4 미포함 — 원하면 재빌드) 대행 패키지 전달됨·백로그 점검 선행 ②**E7 개방** flag+runtime E2E(#1361류) 뒤 운영 결정 ③제품 결정 티켓: #1395(placeholder 방-인지)·#1396(스레드 멘션 패리티)·#1399(티어 override 와이어·ADR 선행)·#1405(hosted DTO 확장)·#1400(auth_mode 제약)·#1392·#1403.
>
> **다음 축 후보**: 클라우드(ADR-0164/0004증2/0150증1 Accepted → 크레딧 구현·egress P1~P7 분해)·데스크탑 검수 인테이크·GROK-E2E(구독 결정 시).
>
> ⚠ main 미커밋 누적 지속(플러시·ADR·리서치·런북·패킷) — 커밋 창 일괄.
>
> 이하 스냅샷 26:

> **2026-08-15 스냅샷 26 (Fable · momo-main — HAP 엔진 축 완결·UX 파도·grok freeze 승격).** 컴팩트 복원 진입점.
>
> **오늘 랜딩 14건**: E5·**E6**·**E7(f07a458f — HAP 엔진 축 E1~E7 완전 종결)** · 위생 6(#1374·1376·1377·1385·1375+1386) · CRUN-1/2/3 · UX1(페어링 위저드) · UX2(disconnect 원장 73ac11d4). track/engine HEAD 전진 중.
>
> **리뷰 체제**: **sol(Codex) usage-limit 8/20까지** → grok 리뷰어 C를 독립 freeze 리뷰어로 승격(E7에서 Fable C0/H0/M0/L2와 grok C0/H0/M0/L0 두 렌즈 일치). 당분간 **Fable 검수 + grok freeze**(+UX는 design-review 관문). grok-fleet 스킬 정본.
>
> **HAP UX 축**: UX1·UX2 랜딩. **UX3(#1359) 폰+코어 — dedup 중**(웹은 UX2 HostedConnectionSection이 홈=옵션 A, UX3 웹 표면 없음). 남은: UX4(#1369 OAuth 동의, ready — E7 개방과 짝)·GROK-E2E(#1361 티어 게이팅).
>
> **성재 대기**: ①**배포** `momo-rust:d7b390cf`(위생6+UX1+CRUN, E7 미포함) 대행 패키지 전달됨·백로그 점검 선행 ②제품 결정 티켓 #1395(placeholder 방-인지)·#1396(스레드 멘션 패리티)·#1399(티어 override 와이어, ADR 선행)·#1405(hosted DTO 확장) ③E7 개방(flag+#1369+runtime proof).
>
> ⚠ main 미커밋 누적 지속(플러시·ADR Accept·리서치·런북·패킷) — 다음 커밋 창 일괄.
>
> 이하 스냅샷 25:

> **2026-08-14 스냅샷 25 (Fable · momo-main — 성재 정지 지시. 재개 진입점).** 컴팩트 복원 진입점.
>
> **정지 시점 랜딩 누계(8/14 하루)**: E4(aa40e4c6 전신)→E5(7a52c4c2)→E6(07ca8828)→위생 4건(#1377 fmt=6d2a7977·#1385 샘플링=252ffa60·#1376 게이트=dcbe7f35·#1374 lock-order=c6ecf48b)→CRUN-2(#1383=49a4ba0e). **track/engine HEAD=49a4ba0e**. 이슈 종결 11건. ADR Accepted 3건(0164·0004 증보 2·0150 증보 1). grok-fleet 스킬 가동(리뷰어 C 2회 실전 — E6 파일럿·위생 C0/H0/M0/L2).
>
> **비행 중 3기(로컬 동결로 자연 완료 — push 없음, 완료 후 그 자리가 재개점)**: ①**#1375+#1386 — 폴리시까지 완료·동결됨(HEAD `a06d75d2`, 2커밋, 미푸시)**: 리뷰어 C L2 수리 완료(부활 루프에 cleanup_pending 추가·B3 seal 주장을 실측 발견 — 실제 핀=agent_owner_human_id_fkey — 에 맞게 정정). 재개 시 rebase(1374와 conformance 테스트 파일 겹침 주의)→push→PR→머지만 남음. E6 verifier 11/11·workspace 테스트 그린 상태 동결. ②**UX1(#1360)** 페어링 위저드, 워크트리 `1360-ux1-wizard` — 완료 시 design-review 필수. ③**CRUN-3(#1384) — 완료·동결됨(HEAD `35e4f924`, 미푸시)**: 카피 전량 core 단일 소스화(웹+폰 패리티)·「@로 부르기」는 390px 실측 폭 예산으로 결정(오버플로=클리핑 함정 회피)·키 힌트 표기 1종 통일(`<키>로 <동사>`·chip 비도입 근거 명문화). 재개 시: ⓐ**design-review 필수 미실행** ⓑ**폰 게이트 미실행**(mobile node_modules 부재 — import-only 스왑이나 실행 필요) ⓒa11y 후속 후보(aria-describedby가 placeholder를 가림 — @ 광고를 힌트 라인으로) → 리뷰 PASS 후 rebase→push→PR→머지.
>
> **배포 창(성재 결재 '지금 열기' — 미집행)**: 이미지 `momo-rust:07ca8828` 빌드 완료(E1~E6 내용·유효). 대행 패키지=scratchpad `deploy-window-4-package.md`(성재에게 전달됨). 재개 시 선택: 그대로 배포 or 위생 포함 재빌드(engine@49a4ba0e+α — 마이그 073은 #1375 랜딩 후). **백로그 점검 선행 불변.**
>
> **재개 큐(우선순위)**: ①비행 3기 착지 처리(위 절차) ②배포 집행 ③UX2(#1362)→UX3(#1359) 순차(agentHub 인접 — UX1 랜딩 후) ④CRUN-1(#1382 — CRUN-2 랜딩됨, 착수 가능) ⑤E7(#1368 ready) ⑥크레딧 구현 분해(ADR-0164 Accepted) ⑦egress P1~P7 분해(ADR-0150 증보 1 Accepted) ⑧#1392 캡처 프레임. blocked 유지: #1361(Grok Bot 티어)·#1369(E7 대기).
>
> ⚠ main 미커밋 누적: CURRENT_STATE/JOURNAL(다일치 플러시)+ADR 3건 Accept 갱신+리서치 정본 5건+런북+janitor 스크립트+핸드오프 패킷 2건 — 다음 커밋 창에서 일괄.
>
> 이하 스냅샷 24:

> **2026-08-14 스냅샷 24 (Fable · momo-main — HAP 서버 축 완성·grok 3사 체제·배포 창 성립).** 컴팩트 복원 진입점.
>
> **E6(#1367) 랜딩 = HAP 서버 축(E1~E6) 완성**: PR #1387 → `track/engine@07ca8828`. 원자 disconnect·artifact manifest·4중 terminal 가드(mutation 3종 실증)·hosted delivery 게이트 release 개방(기본 닫힘·운영자 결정). 리뷰 4층(Fable→sol→**grok 4.6 파일럿**→CI)이 각기 다른 결함 적발 — grok은 트리거 진공 통과를 정식화(채택·수리), 이중 audit 주장은 기각(FOR UPDATE 직렬화). CI 첫 시도 완주(E5 교훈 선처리). 해제: #1368(E7)·#1360/#1362/#1359(UX1~3) ready. 잔여 blocked: #1361(Grok Bot 티어 게이팅)·#1369(E7 대기).
>
> **⚠ 배포 창 조건 성립(성재 결재 ④)**: E1~E6+마이그 069~072 라이브 배포 가능 — 실행=성재 대행(런북 3단계), **선행=pending gateway job 백로그 점검**(대소문자 수리로 깨어남 — STATUS 체크리스트).
>
> **Grok 4.6 워커화(성재 발제) 실측 완결**: 정본 `research/2026-08-14-grok46-worker-integration.md`. Grok Build CLI 1.0.3 설치·기존 auth 유효·헤드리스 `-p`+`--json-schema` PASS·모델 id는 grok-4.6/4.5뿐(fast=서빙 티어)·`--allow`로 read-only 강제 가능·config 격리 필요(전역 MCP 자동 로드 실측). **파일럿 실증: E6 diff에서 실가치 1(트리거 강화 채택)+오탐 1(기각)** → 리뷰어 C 렌즈 편입 근거 확보. grok-fleet 스킬 빌드는 성재 결정 대기.
>
> 이하 스냅샷 23:

> **2026-08-14 스냅샷 23 (Fable · momo-main — HAP-E5 랜딩·신체제 검증·클라우드 축 개설).** 컴팩트 복원 진입점.
>
> **E5(#1366) 랜딩 완료**: PR #1379 → track/engine@7a52c4c2. 8 MCP 도구·per-agent hosted delivery·E4 producer 결선. **신체제(구현=Opus 워커·기획검수=Fable·freeze=sol) 첫 폐곡선 성립** — sol 3회전 끝 C0/H0/M0. E6(#1367) ready·패킷 미작성. engine 계보 CURRENT_STATE는 스냅샷 36까지(E5 브랜치 포함 랜딩됨).
>
> **클라우드 축(성재 발제 08-14)**: 리서치 정본 2건 랜딩 — 인프라(ADR-0156 좌표 업계 수렴 검증·채택 후보 A4 egress capability→A1 pause→A2 스냅샷 템플릿→A3 웜풀)·과금(3-A 권고=원화 크레딧+list-cost 원장·결정 큐 7건 §참조). UXUI 실사: "Run on"(작성 시점 실행환경 선택)이 공백 — CRUN 시리즈 제안.
>
> **성재 결재 4건 집행(08-14 오후)**: ①**E6(#1367) 발사** — 패킷 `handoffs/2026-08-14-hap-e6-atomic-disconnect-packet.md`, Opus 워커 가동 중(disconnect 원자 tx+artifact manifest+terminal 1회+게이트 개방). ②**ADR 기안 2건** — ADR-0164 Proposed(크레딧 과금 3-A: 원화 크레딧·list-cost 단일 원장·running만 과금·pause≠종료·HAP 경계·지출 상한)+ADR-0004 증보 2 Proposed(bundled 키=서버 시크릿·계량 의무·BYO-key 비개방) — **Accept는 성재 별도**. ③병렬 편성 — 인프라 #1380(A4)·#1381(A1)+CRUN #1382~#1384 발급, **A4 설계 스파이크 가동 중**(docs 전용, ADR-0150 증보 초안까지), 위생 4티켓(#1374~#1377)은 E6 랜딩 후 순차. ④**배포 창 = E6 랜딩 후 한 번에**(E1~E6+마이그 069~072, pending 백로그 점검 선행).
>
> 이하 스냅샷 22:

> **2026-08-14 스냅샷 22 (Fable · momo-main — sol 인계 검수·#1365 최종 판정·자원 파이프라인).** 컴팩트 복원 진입점. ⚠ engine 계보 CURRENT_STATE는 sol이 스냅샷 35까지 별도 진행(#1365 브랜치 포함) — 번호 별계보, S10 engine→main 머지 시 정합 필요.
>
> **HAP 축 현황**: sol이 ADR-0162/0163(Fable 08-12 기안, engine 랜딩됨)을 E1~E7+UX1~4+GROK-E2E 체인(#1358~#1369)으로 분해. E1~E3 랜딩(track/engine@23038585), **E4(#1365) 로컬 동결 @2304324 — Fable 최종 리뷰 C0/H0**(M1 job↔run·kind 결속 공백은 #1366 수용기준 이관, lock-order→#1374, ledger 잠재 3종→#1375). verifier 독립 재실행 PASS. E5(#1366)=MCP tool 노출+실 producer 결선이 다음 대형. sol 방법론(단일 goal 순차·독립 freeze C/H/M=0·로컬 커밋 체크포인트·runtime-unverified 정직 라벨)은 승인 — verifier 소유권 계약은 신규 표준으로 런북 승격.
>
> **인계 구조(성재 3결정 확정·집행 완료)**: 주도권 복귀 = **Fable 기획검수+Opus 5 구현, sol=독립 freeze 리뷰어**. **#1365 랜딩 완료** — PR #1378 squash → `track/engine@aa40e4c6`(2026-08-14), 이슈 done 종결, 워크트리 회수(세션 누계 ≈57GB). **#1366(E5) status:ready** — 패킷 `handoffs/2026-08-14-hap-e5-mcp-inbox-tools-packet.md` 준비 완료(M1 이관분·리뷰 폐곡선·환경 함정 포함). **워커 발사만 성재 신호 대기.**
>
> **자원 파이프라인(2026-08-14 신설)**: `scripts/worktree_janitor.sh`+`docs/runbooks/local-resource-reclaim.md`(3층+Docker Desktop 붕괴 플레이북). 랜딩 워크트리 5개 회수(≈32GB). actionlint 1.7.12 무한 스핀=brew unlink 완화(#1376)·engine fmt drift 13파일(#1377). 성재 대행 대기: 1364 폐기·HOLD 4개 판정(398·464·72·sol-review — sol ADR 초안 0162~0166 구번호 5건 회수).
>
> 이하 스냅샷 21:

> **2026-08-12 스냅샷 21 (Fable · momo-main — 외부 에이전트 수용 축 개설·sol 2차 핸드오프. PLN-20260812-01).** 컴팩트 복원 진입점.
>
> **발단**: Grok Bot(SpaceXAI+Cursor, 08-11 베타) 출시 → 성재 방향 "사용자의 호스팅 봇을 oort 팀메이트로(다이얼인) + 주=연동형(BYOA/ACP)·부=관리형 동봉 호스팅(개별 업데이트 버튼)". 웹 리서치 6기(2배치) 완료 — 인바운드 불가 확정(API 전무+AUP 3중 저촉), 역방향 조건부 성립(커스텀 MCP 커넥터+루틴 웨이크업, Slack 트리거 실동작 검증). 설계 감사: ADR-0102가 이미 "BYOA=핵심" 철학이나 **ADR-0130 ACP 체인이 Swift 퇴역으로 부분 좌초**(MomoACPHost 퇴역·work_tool_profile rust 부재·X-11 정지), 동봉·업데이트는 설계 공백.
>
> **산출물(전부 랜딩)**: 리서치 정본 `research/2026-08-12-grok-bot-integration-feasibility.md`·`research/2026-08-12-grok-bot-reverse-teammate-direction.md`(§8 감사) · **ADR-0162 Proposed**(3분류 관리형/연동형/다이얼인형 + Agent Port MCP 표면 — 도구 6종·스코프드 봇 토큰·REST 파사드) · **ADR-0163 Proposed**(agent_catalog·온보딩 "에이전트 고르기"·개별 업데이트 v0=안내→v1=호스트 헬퍼) · 로드맵 `2026-08-12-external-agent-reception-plan.md`(웨이브 R/0/A/1/2/3) · 이슈 **#1343**(sol 검수)·**#1344**(스파이크 — 구독 계정 게이트 blocked)·**#1345**(0130 재랜딩 감사) · **sol 패킷 `handoffs/2026-08-12-sol-external-agent-reception-packet.md`(§부록=성재 복사용 핸드오프 프롬프트)**.
>
> **다음**: 성재가 sol에게 핸드오프(프롬프트 준비됨) → sol 검수(#1343)·감사(#1345) → 성재 결정 5건(0162 승인+네이밍·0163 승인·스파이크 계정·Slack 초인종 opt-in·Wave 2 편성). 경계 변경 구현은 Accepted 전 착수 금지.
>
> 이하 스냅샷 20:

> **2026-08-11 스냅샷 20 (Fable · momo-main — 검수 배치 1·2 완결 라이브·sol 인수인계).** 컴팩트 복원 진입점.
>
> **검수 배치 1(6건)+2(5건) 전부 랜딩·배포**: 라이브 `momo-rust:a5193e5e`(main=engine 0/0, f808d9cb)·마이그 068·centrifugo presence 네임스페이스 발효. ADR-0160(프레즌스)·0161(워크스페이스) **Accepted·구현 완료**, ADR-0124 증보1(알림규칙 v0=DND+멘션예외) 랜딩·성재 최종 승인 대기. 데스크탑 검수앱 `~/Desktop/oort.app`(--debug=dev 가드로 자동업데이트 롤백 원천 차단, #1280). **배포 사고 교훈 성문화**(JOURNAL 8/11): 서버 config 통째 덮기 금지 — 백업+외과 삽입+checkconfig 게이트.
>
> **인수인계**: 당분간 기획·리뷰 주도 = **sol(GPT 5.6, Codex)**. 패킷 정본 `docs/planning/handoffs/2026-08-11-sol-handoff.md`(미션 4: 동향 파악·코드 리뷰·취약점 분석·오픈소스/셀프호스팅 준비. 취약점 후보 1순위 = 라이브 centrifugo proxy secret이 dev-insecure 값). 성재 결정 큐 6건은 그 문서 §6.
>
> 이하 스냅샷 19:

> **2026-08-09 스냅샷 19 (Fable · momo-main — 우로보로스 선행 배치: #1210·#1213 종결·라이브 보안 헤더 발효·ASC 재조준).** 컴팩트 복원 진입점.
>
> **저녁 배치(성재 편성 승인)**: 우로보로스 인터뷰(Opus 5)가 브리프 오류 3건·숨은 매듭(ASC)·②③ 결합·감사 낡음을 적발(정본 `research/2026-08-09-ouroboros-session-planning-interview.md`, 전 항목 재검증). 집행 — **#1215 머지·#1210 종결**(리뷰 PASS B0/H0·8레인 green·후속 #1218) · **#1213 종결**(#1217 라이브 Caddyfile 회수 → #1220 헤더 5종+게이트 라이브 확장 red proof 7 → 배포 → 라이브 5종 실측 도달) · **배포**(서버 `momo-rust:6bfc9b82`·웹 `index-Dp1ym0h8`·마이그레이션 063, 롤백 백업 2 서버 보존) · **ASC Xcode Cloud "Default"를 MomoMobile로 재지정**(Fable이 성재 Chrome으로 콘솔 직접 조작 — 아카이브·서명·export green, 유일 빨강=ci_post_xcodebuild 첫 실행 결함 → #1219 수리, 재빌드 검증 중).
>
> **라이브(8/9 저녁)**: 웹 `index-Dp1ym0h8` · 서버 `momo-rust:6bfc9b82`(롤백 b727ea4f) · **보안 헤더 발효**(CSP connect-src에 googleapis — 첨부 생존·HSTS 1일 시작·브라우저에서 임의 호스트 관전·타 서버 접속 닫힘=설계된 축소). 검수 재료: 데스크톱 `oort.app`(@6bfc9b82) 빌드 완료(deploy5 워크트리), 폰=ASC green 시 TestFlight 경로 제안.
>
> **성재 대기**: ①검수(데스크톱 oort.app + 폰) ②**PR #1216 승인**(Swift 판정재료 — **OutboxRelay 삭제 불가 판명**(8/9 웹훅 랜딩이 그 트리·Rust 소비자 0)·11패밀리 3칸 표=판정 입력) ③11패밀리 판정(S5)·T6/T7(S7)·dependabot 13(S9)·engine→main 머지(S10). 적립: LiveKit 랜딩 시 CSP 갱신 수용기준·infra/prod Permissions-Policy 마이크 결함 티켓.
>
> 이하 스냅샷 18:

> **2026-08-09 스냅샷 18 (Fable · momo-main — prime 3번째 provider 승격 완결·CubeSandbox 3/4·8/8 하루 13 PR).** 컴팩트 복원 진입점.
>
> **8/8~8/9 랜딩(13 PR·이슈 12 종결)**: 재개 배치(#1171 코어 기계검사 하드제로·#1172 runEnded 동봉) · oort 배치 4+웹 emdash AST(#1174·#1175=#1141 완결) · **CubeSandbox 체인**(ADR-0156 Accepted → #1179 어댑터·#1180 프로비저너 — 잔여 D4-② 실기동만) · web-legacy 계열(#1181·#1184 — 18일 잠복 드리프트) · #1183 여는 표식 · #1186 다크 20역할 파리티(에이전트 색 통일·리뷰 PASS) · #1187 게이트 ruby=사본 드리프트 · **prime 승격**(ADR-0158 Accepted D1~D7 → #1188 서버 축(runId 서비스·D7 PATCH 스코프—Swift 시절 공백 적발)·#1189 어댑터 상주(실연동: 베어러 하나 525 update→메시지 1) → **#1130 종결**).
>
> **신규 ADR**: 0156 Accepted(CubeSandbox=T3 기질·발주 사양 32GB 증보) · 0157 **Proposed**(샌드박스 네트워크 경계 — 성재 검토 대기) · 0158 Accepted(prime 승격·D7) · 0129 증보 1(kind 분리·사후 필터링 금지). 리서치 정본: `2026-08-08-oss-sandbox-memory-evaluation.md`(Tencent Memory 4중 위반 배제·vibesdk 배제)·`2026-08-08-cubesandbox-requirements-adapter-mapping.md`(발주 체크리스트·probe lossy).
>
> **라이브(8/9 갱신)**: 웹 `index-C3szaFWl` · 서버 `momo-rust:2afae645`(prime 승격 포함·롤백 08e0c9d9 단일). 이후 랜딩 #1191(주석)·#1192(골든 벡터)는 배포 무관(산문·테스트). 폰 아카이브 재빌드 대기(#1186 다크 포함 — 기기 검수 시). oort 리브랜딩 5배치 완주(#1118 종결)·#1130/#1190 종결·워크트리 디렉토리 0B(684-3 브랜치 ref만 보존 — Swift 퇴역분 폐기 여부 성재 판단).
>
> **SSH 사건 종결 기록**: 원인=logind 런타임 걸림(NCP API 재부팅=정답·ncp-power.py 재작성—서명 v2·~/.ncp 자격+pem이 원본)+비번 파일 tmp 소실(getRootPassword API 재복호화 절차가 정본)+root 일시 잠금(1분 자동 해제).
>
> **성재 게이트**: ①전용 호스트 발주(D4-② — x86_64·32GB·XFS 200GB·콘솔 필수·CIDR 회피, 폐기 VM으로 U1 30분 판정 먼저) ②ADR-0157 검토. **적립 큐**: #1190(uuid5 골든 벡터)·#1164 ②③(재배선·confirm 위계 — 성재 결정)·#1168(preamble 실물)·#1118 소형 산문·세션 카드 앵커(이슈 미발급)·PYTHON_BIN 관측·운영 전 체크리스트(자동 refine 실측·멀티 uid·업스트림 문서 초안 제출 여부=성재)·잔존 워크트리 판정 2(684-3·WEB-WP1).
>
> **워커·머지 규율 추가분(8/8 성문화)**: 발주 전 랜딩분 대조(`git log -S`/PR 검색 — #1139 헛발주 전례)·track base PR은 머지 시점 이슈 수동 종결·단발 워커=무명 spawn·병합 트리 flake 1회=동일 트리 재실행 판정(#1063 계열)·대기 중에도 큐 병렬(성재 지적)·배포 전 디스크 확인.
>
> 이하 스냅샷 17:

> **2026-08-08 스냅샷 17 (Fable · momo-main — 성재 지시 정지. ADR-0155 폐곡선 라이브·재개=W-G/W-H 재발사).** 컴팩트 복원 진입점.
>
> **정지 상태**: 성재 "작업 중단하고, 해당 작업부터 재개할 수 있게 준비만"(2026-08-08 새벽) — W-G(#1166)·W-H(#1170+#1141) 워커 2기를 착수 직후(패킷 읽기 단계) 정지, 워크트리·브랜치 회수 완료(유실 0). **재개 절차: `docs/planning/handoffs/2026-08-08-terminal-backfill-guards-packet.md`(ready 상태 그대로)에서 무명 Opus 단발 2기 재발사** — 발주 전 랜딩분 대조는 이미 완료된 패킷이니 즉시 발사 가능. 재개는 성재 신호 후.
>
> **8/7~8/8 밤 누계(전부 track/engine 랜딩+배포)**: ADR-0155 폐곡선 완결 — 기안→성재 승인→#1165(outcome 계약+꼬리)→#1167(run_turn 스트리밍 전환+A2A 가드 수리)→design-review 2회 PASS→**전 층 배포 라이브**(웹 `index-BqUnvS4I`·서버 `momo-rust:892b342f`·롤백=2fe2be47, env 백업 bak-20260808). 부속: #1162(#1130 ②refine 감사·③HOME 격리 — full 모드 채택)·#1163(폰 다크 accent 여명화, 리뷰 PASS)·#1169(검색 세 이름 통일, 리뷰 PASS). 이슈 종결 8건(#1116·#1130일부·#1133·#1139·#1146·#1149·#1155·#1157·#1160·#1161).
>
> **적립 큐(재개 후 순서 후보)**: ①W-G/W-H 재발사(#1166·#1170+#1141) ②#1168(스트리밍 preamble이 도구 카드 위에 — **성재 실물 확인 권장**, 제품 결정 포함) ③#1164(폰 다크 잔여 정렬+accent 의미 재배선 — 결정 포함) ④#1118 잔여(Swift server/ ~50곳 — **prod 이미지가 아직 이쪽 빌드** Dockerfile:25 주의) ⑤#1166 완료 후 어댑터 여는 POST 표식(#1167 이탈 5) ⑥폰 재빌드+기기 검수(연결 시).
>
> **성재 대기(재촉 금지)**: 구구 태그 회수 1줄(`docker image rm momo-rust:da6a646b` — 차단분, 여유 시) · ASC "MomoiOS|Default" Disable · 셀프호스티드 러너 첫 등록(릴리스 시) · codex CLI 롤백 여부 · xcC-cleanclone 3.5GB.
>
> **운영 교훈(이 밤 성문화 — 메모리 동기)**: ①패킷 발주 전 `git log -S`/PR 검색으로 랜딩분 대조(#1139·#1146/#1149 헛발주 전례 — base≠main PR의 Closes 미발화가 원인, **머지 시점 이슈 수동 종결이 근본 대책**) ②단발 워커는 무명 spawn(named=mailbox 유휴 신호 대체 전례) ③배포의 docker save/load·원격 image rm·compose up은 세션 분류기 차단 — 성재 `!` 대행 2건으로 완결한 전례(런북 절차 자체는 유효).
>
> **잔존 워크트리 판정 대기 2**: `684-3-agentworkingsignal`(Swift MOMO-568 미랜딩 — Swift 퇴역으로 폐기 후보)·`WEB-WP1-panel`(#1015 squash 여부 대조 후 회수).
>
> 이하 스냅샷 16:

> **2026-08-07 스냅샷 16 (Fable · momo-main — ADE D1~D5 전 단계 랜딩·4기능 완결·전 층 배포·8/7 누계 13 PR).** 컴팩트 복원 진입점.
>
> **8/7 랜딩(13 PR, 전부 track/engine)**: ADE 1~3단계 완결(#1138 웹 재개/인수·#1140 폰 관제·#1142 다중멘션·#1143 서버 체인=#1114 종결·스폰 폐곡선) · #1145 pin v0+#1148 스레드 고정(H0 파리티) · #1147 sampled-on-rust 3→53 · oort 2단계 #1150+배치 3 #1159(동결층 diff 0 기계 증명·eve 게이트 선재 결함 수리) · U2 테마(#1151 웹 토글·#1153 폰 라이트 — 16역할 바이트 일치) · #1152 메시지 edit 계약(stream rev·"답의 도착은 수정이 아니다") · #1156 Tauri CI(=#1116 종결, 서명 자산 전부 실측 실재·첫 러너 등록만 성재 수동) · #1158 tool_result 접힘 수리(=#1133 종결 — 멱등 가드 type 미포함이 기전, `result_message_id` 키 공간 분리·마이그레이션 0).
>
> **라이브**: 웹 `index-lsbIEZDj`(app.oor7.com) · 서버 `momo-rust:2fe2be47`(NCP·migrate 62·롤백 da6a646b 보존) · 폰 U2 아카이브 빌드 완료(**기기 unavailable — 연결 시 설치**, 성재 "기기 연동 검수는 추후"). 데스크탑 릴리스 레인 개통(release-desktop.yml — 러너 미등록 상태).
>
> **성재 대기(재촉 금지)**: ①ASC 콘솔 "MomoiOS|Default" Disable(docs/cicd/10 §8) ②셀프호스티드 러너 첫 등록(docs/cicd/13 — 릴리스 시) ③폰 기기 연결(U2+ADE 설치 검수) ④codex CLI 롤백 여부(herdr 스파이크 부작용 0.146.1 — 유지 or `npm install -g @openai/codex@0.144.1`) ⑤`! rm -rf .../scratchpad/xcC-cleanclone`(3.5GB) ⑥ADR-0150(웹검색 egress) 승인.
>
> **진행 중(이 스냅샷 시점)**: W-A=#1130 잔여(②refine 감사 — 업스트림 이슈는 초안만·③HOME 격리, 스파이크 한정) · W-B=#1155(폰 다크 accent 여명화 — 웹 다크 `#f0a850` 정렬)+#1157(INDEX cicd 목차)+cicd/20→11 깨진 링크 3곳. ADR-0155(취소 시 스트리밍 메시지 처리) 기안=Fable 직접.
>
> **적립 큐**: #1118 잔여(Swift server/ ~50곳 — **prod 이미지가 아직 이쪽 빌드**·openapi·ROADMAP 13건·하이픈 109) · #1146(pin Medium)·#1149(고정 Medium 4) · #1139(resume 서버 검증 이식)·#1141(코어 기계 검사) · #1144(per-agent 라우팅 ADR — 수요 실증 후) · 세션 카드 메시지 앵커(코어 AdeItem — 이슈 미발급) · 스파인 가드 type 추가(동일 결함 재발 시 ADR).
>
> **워커·머지 규율(현행 — 스냅샷 15에서 이어짐)**: 단발 Opus 서브에이전트·병합 트리 3종(verify_merge_tree.sh)·연속 큐=성재 신호 유효("실행중인 작업 끝나면 다음 작업 이어가줘" 2026-08-07)·UI 변경=design-review 필수(B0)·폰 캡처 축척 pt=px/3 · 이슈 주석에 #NNNN 리터럴 금지는 해제됨(#1060 preflight 자체 수리·selftest 11케이스).
>
> 이하 스냅샷 15:

> **2026-08-06 스냅샷 15 (Fable · momo-main — Swift 퇴역 완료·ADE 방향 기안·8/6 누계 12 PR).** 컴팩트 복원 진입점.
>
> **8/6 랜딩(12 PR)**: U4-6 완결(#1107/#1106/#1109 — 컴포저·아바타·문장옷·색계약·seq어휘) · oort 1단계(#1117 — 사용자 노출 69곳+게이트 신설, ADR-0152 Accepted) · 첨부 v0 서버(#1119 — Drive 3경로+바인딩, ADR-0151 Accepted, **ADR-0145 판정표 잔여=agentRunHistory 1건**) · 위생 배치(#1122 Xcode 준비·#1123 레인 rust+배포 이미지 선재결함 적발·#1124 게이트 — **ADR-0145 증보 2 전 항목 이행**) · 교차 소수리(#1126). 신규 ADR: **0153 Accepted**(CI=로컬 게이트+셀프호스티드 러너+Xcode Cloud — Jenkins 기각·Argo 부적합) · **0154 Proposed**(ADE 관제 표면 — D1 생존성 모델·D2 멀티세션 뷰·D3 재개/인수 어휘·D4 단계·D5 prime/herdr 트랙).
>
> **성재 대기**: ①**ADR-0154 세부 승인**(방향은 성재 발제) ②ASC 콘솔 "MomoiOS|Default" **Disable**(+재지정 절차=docs/cicd/10 §8) ③다음 배치 순서 — 후보: 첨부 웹 컴포저(ADR-0151 D2) / W1(#1112 pin+#1113 다중멘션) / W2(#1114 스폰 폐곡선=ADE 1단계) / 스파이크(#1120 prime·#1121 herdr) ④라이브 배포 묶음(웹 재배포+서버 이미지 — 스냅샷 13 이후 미배포) ⑤`! rm -rf .../scratchpad/xcC-cleanclone`(3.5GB — 분류기 차단).
>
> **핵심 리서치 정본**: `research/2026-08-06-prime-agent-ade-herdr.md`(prime=MIT CLI 하네스·steer·RPC / ADE 수렴 3원칙 / herdr 실존·라이선스 재확인 필요) · `research/2026-08-06-xcode-cloud-transition.md`(비활성=콘솔 수동·RN 계승 유력) · `2026-08-06-feature-gaps-roadmap.md`(pin 0%·다중 기구현·승인 폐곡선 완성·실행방식=MOMO-490 부활 #1114).
>
> **워커·머지 규율(현행)**: 단발 Opus 서브에이전트(팀메이트 금지·완주 후 최종 보고 1회·스크래치 파일명 고유) · core 접촉 PR은 병합 트리 3종 검증(`scripts/verify_merge_tree.sh` — 20초) · **병합 교차 주의**(#1122×#1123 전례 — 병렬 PR이 서로의 전제를 바꿀 수 있음, 머지 후 교차 지점 실측) · 발사=성재 신호(연속 큐 허용) · 적립 이슈 잔여: #1093·#1102후속(M-1 core 승격은 완료됨)·#1118(oort 잔여 카피)·#1125(honesty 정지)·#1127(힌트 술어)·#1116(Tauri CI)·#1108(스크립트는 랜딩, 머지 루틴 편입 완료).
>
> 이하 스냅샷 14:

> **2026-08-06 스냅샷 14 (Fable · momo-main — U4 시리즈 소진·다음 배치 컨펌 대기).** 채팅 UI 감사(37결함)의 수리 시리즈 U4-a~j **전부 완료**(h만 oort 2단계 결합 잔존). 8/5~8/6 이틀 누계 **PR 31장 머지**, 모바일 테스트 578→868. 리뷰 사이클 6회전 전부 폐곡선(랜딩→일괄 리뷰→R 수리→그린).
>
> **워커 운용 정본(현행)**: 단발 Opus 서브에이전트(이름 없음 — 팀메이트 금지·유휴 소음 0·완주 후 최종 보고 1회). 패킷에 "중간 보고 없음" 명시. 병렬 시 워커별 고유 스크래치 파일명. **머지 규율(신규·필수)**: core 접촉 PR은 병합 트리에서 웹·폰·코어 3종 typecheck+스위트 확인 후 머지(#1108 — "머지 결과 미검증" 2회 재발로 성문화). 발사=성재 신호(연속 큐 허용은 신호 유효 기간 내), 배치 완료 시 다음 준비+컨펌.
>
> **최근 랜딩(전부 track/engine)**: U4-4(#1086/#1088/#1087/#1090 — 시간·경계·승인버튼·typing)→R(#1094/#1095) · U4-5(#1098/#1100 — 접기·항법·위생·착지틴트)→R(#1105 대리 착지) · U4-6(#1107/#1106 — 컴포저·아바타·문장옷·색계약·seq어휘·삭제접기 코어)→R(#1109). 코어 신설: divider(톤 계약 mustDifferFrom·「여기까지 복구」)·approvalNote(receipt>blocked>guidance)·avatar 계약·composerCopy·deletedFold(대리 착지). 웹 배포는 스냅샷 13 시점(index-CfaAQbFh) — **이후 랜딩분 미배포**(다음 배포 묶음 대기). 폰 재빌드 미실시.
>
> **다음 배치 후보(성재 컨펌 대기)**: ①**oort 1단계**(사용자 노출 12곳 — ADR-0152 Proposed·인벤토리 완비) ②**첨부 v0**(ADR-0151 승인 필요 — 서버 3경로 이식+웹 컴포저) ③**레인·게이트 위생 묶음**(#1022 rust 이관+#1035/#1101 부트스트랩+#1051 폰 실시간+#1069 flake+#1089 웹 게이트+#1099 캡처+#1108 크로스 typecheck) ④**U2 모드 전환**(웹 토글+폰 라이트 팔레트 — 토큰 선행) ⑤잔여 다듬기(#1093·U4-6 리뷰 Nit). **성재 대기 불변**: ADR-0150/0151/0152 승인·마스코트 후속(v2-main 기반 "같이")·폰 재빌드 검수.
>
> **운영 키**: NCP ssh=sshpass+구세션 스크래치 `.ncp-root-pw`(2f5adb6c…) · 웹 배포=런북(5파일 compose·bind-mount inode·**clients/web은 워크스페이스 밖 — 자체 npm ci**) · 폰 캡처 축척 pt=px/3 · 레포=yeomyeonggeori/momo(구 org 리다이렉트) · 이슈 위생: 주석에 #NNNN 금지(preflight hex 오인 #1060).
>
> 이하 스냅샷 13:

> **2026-08-05 스냅샷 13 (Fable · momo-main — 배치 3 완주·8 PR 전량 머지·웹 배포).** 리밋 해제 후 재개 계획 전 항목 완료.
>
> **랜딩(track/engine c9ea9cc9)**: 배치 3 4/4(인용·작성중 × 웹·모바일 #1052/#1059/#1062/#1064) + 폰 Blocker U4-a/b(#1067 마크다운·#1068 복사) + U3 OAuth 폼(#1056) + SRV-B7 rust 샘플(#1058). **웹 배포 완료**(app.oor7.com = index-CfaAQbFh.js 검증 일치 — 인용·작성중·OAuth 폼 라이브). 폰은 재빌드 미실시(성재 검수 타이밍에).
> **진행 중**: 폰 대화 표면 일괄 design-review(M1~M4 병합 결과 — 결과는 U4-c~j 편성 입력. 리뷰어 보고=파일+신호 규약).
> **다음 자율 큐**: 일괄 리뷰 → U4-c~j 편성(감사 §4 순서 c→d→g→e→i→f→j·U4-i는 U2 선행) · #1065 typing 묶음 goal(tie 단정 포함) · 첨부 이식 배치(ADR-0151 승인 후) · #1022+#1051+#1069 레인 재설계 묶음 후보. **워커 전원 해제 상태**(B3W·B3M·U3·SRVB7 종결 — 재호출 가능).
> **운영 노트**: 레포 GitHub org 이동 고지(Dawn-kim-official→yeomyeonggeori — 리다이렉트 동작, remote URL 갱신은 여유 시) · clients/web은 루트 워크스페이스 밖 — fresh 워크트리 빌드 시 clients/web 자체 npm ci 필요(런북 반영 대기) · 성재 대기 항목 불변(ADR-0150/0151 승인·마스코트·폰 단건 검수 등 — 재촉 금지).
>
> 이하 스냅샷 12:

> **2026-08-05 스냅샷 12 (Fable · momo-main — 주간 리밋 중단·재개 계획 성재 승인).** 워커 전원 주간 리밋 사망(**리셋 8/6 수 13:00 KST**). 성재가 재개 계획 승인 + 즉시 조치 전부 승인(2026-08-05 새벽).
>
> **중단 시점 실측(원격 head 기준)**: ①**#1058**(rust 샘플 @8aacbf22)·**#1052**(웹 인용 @82d90a75) = **전 관문 통과, 머지만 대기**(성재 대행: `gh pr merge 1058 --merge` → `gh pr merge 1052 --merge` — Fable 머지는 세션 분류기 차단) ②**#1059**(웹 작성중 @89693fd7) = High3 수리·검증 승인 완료, stress 캡처 1커밋만 미실행 ③**#1056**(OAuth 폼 @4c67b4a2) = High5+M/N8 수리 완료, **재리뷰 미완**(r3 리밋 사망) ④**#1062**(모바일 인용) = lane 5/5 완결, 검수·머지 대기 ⑤**#1064**(모바일 작성중) = **rebase 필수**(코어 startedAtMs 필수화 — rebase+`startedAtMs: frame.ts` 1줄 전 머지 금지, 하면 track/engine 컴파일 빨강) ⑥**M3**(#1048 폰 마크다운) = 코드 완료·게이트 그린, **salvage push 완료(@1d16d10f, feat/B3-M3-markdown)** — lane 미완·PR 미오픈 ⑦M4(#1049) 착수 0. Docker 잔여 0(레인 회수 정상).
>
> **승인된 재개 순서(리셋 후)**: B3W 재개(SendMessage로 기존 워커 재개 — 맥락 보존, 실패 시 패킷 기반 재스폰)→stress 캡처→#1059 확정 / #1062 검수→머지 체인(#1058→#1052→#1062→#1059→#1064) / B3M 재개→M2 rebase→M3 lane→M3 PR→M4 / U3 재리뷰어 재스폰→#1056 판정·머지. **머지 순서 불변, #1064는 rebase 전 머지 금지.**
>
> **이 사이클 신규 이슈**: #1050(openapi provider/link 부재)·#1051(QA/레인 폰 실시간 미검증)·#1053(openapi typing 부재)·#1054(스레드 인용)·#1055(thread.updated)·#1057(capture:design 설정 구멍)·#1060(preflight #NNNN hex 오탐 — 2회 적중)·#1061(ApiError 헤더)·#1063(inboxApproval flake 선존재)·#1065(typing 후속 — **M-2·M-3·N-1·N-2는 한 결정 묶음**, 별 goal)·#1066(AI 연결 후속). 리뷰 전문 보존: research/2026-08-05-{typing-line,ailink-oauth}-design-review.md. **리뷰어 운영 표준: 보고=파일(scratchpad)+신호 한 줄**(SendMessage 본문 유실 버그·좀비 전례).
>
> 이하 스냅샷 11:

> **2026-08-05 스냅샷 11 (Fable · momo-main — 검수 주도 고속 사이클 마감 국면).** 컴팩트 복원용 전체 상태. 상세 시간순은 JOURNAL 2026-08-04~05 항목.
>
> **라이브**: 서버 `momo-rust:da6a646b`(NCP 101.79.11.189 — 배포 정본 `docs/runbooks/ncp-rust-deploy.md`, 5파일 compose+env 2개, 웹은 §웹 절·bind-mount 함정 주의) · 웹 app.oor7.com(작업 패널 포함) · 폰 `MomoMobile-rnb4.xcarchive` 설치됨(세션 스크래치패드) · 데스크탑 momo.app 재번들(engine 워크트리 target/release/bundle). provider=ADR-0147 OAuth 등록됨(자동 refresh 생존).
>
> **2026-08-04 하루 랜딩 요약(23 PR)**: 배치1(승인 3층: #986·#988·#987)+배치2(관전 마감: #993·#995·#994·#996)+검수 후속(RN-P2 #1003/1007/1009 · SRV-B3 6-goal #1004/1008/1010/1013/1016/1018 — **관전 레일 프로듀서 0→완전체**·luna 모델·enabled_tools 소비자)+작업 패널(#1015, 성재 승인 D1~D3)+MAESTRO 레인(#1021/1023 — `npm run lane:phone` 5플로우, 레인 서버=Swift 한계 명시)+핫픽스(#1028 툴명 400)+RN-B4 5-goal(#1029~1034: 진입 앵커·당김 새로고침·조사·인박스 리얼타임·AppState flush)+SRV-B5 3-goal(#1037/1039/1040: 작업런 툴·서버 조사 korean.rs·openapi 승인 표기 정합).
>
> **진행 중(2026-08-05 아침 — 4워커 체제)**: ①**worker-B3W**(웹+core — 인용 #1043·typing #1044, 패킷 `handoffs/2026-08-05-B3-conversation-baseline-packet.md`. B3M이 기다리는 core 표면 명세를 중계했음 — core 먼저 커밋 지시) ②**worker-B3M**(모바일 — 인용 #1045·typing #1046 + **체인 연장 M3/M4 = 폰 Blocker #1048/#1049**, 패킷 `handoffs/2026-08-05-U4-phone-blockers-packet.md`. core 대기면 M3 선행 허용) ③**worker-U3**(웹 settings 전속 — OAuth 폼 #1047, 패킷 `handoffs/2026-08-05-U3-ai-link-oauth-packet.md`) ④**worker-SRVB7**(openapi rust 이중 샘플 #1042, 패킷 `handoffs/2026-08-05-SRV-B7-openapi-rust-sampling-packet.md`). SRV-B6(#1041)은 머지 완료. 워커 운영 규율: 턴 20분·마일스톤 SendMessage 보고(MAESTRO-1 행 사건의 교훈 — 마라톤 턴 금지). **U1 감사 랜딩**: `research/2026-08-05-chat-ui-audit.md`(37건 — BL 3 전부 폰) — U4-c~j 잔여 배치는 B3 랜딩 후 편성.
>
> **성재 대기(본인이 나중에 하겠다고 함 — 재촉 금지)**: ①폰 단건 검수(진입 앵커→luna 멘션→잠금화면 승인 순) ②마스코트 방향 선택(docs/brand/concepts/ 4종) ③UXUI 배치 순서 승인(`2026-08-05-uxui-elevation-points.md` U1~U5 — 권고 U1 진단→U3 연동→U2 모드) ④작업 패널 도구 인자 값 렌더 여부(taste §9 완화 — 현 상태가 정본 준수) ⑤ADR 승인 2건: **0150**(대화 유출 경계 — 웹검색 D1~D4)·**0151**(첨부 v0 — Drive 계약 동결 이식+웹 우선, 방향은 기승인·본문 대기).
>
> **다음 자율 작업 큐(성재 무대기)**: ~~U1 진단~~·~~ADR 기안(0131 증보·0150·0151)~~ **완료**. 남은 큐: PR 도착 순 검수·머지(B3W→B3M 의존, U3·SRVB7 독립) · B3 랜딩 후 **U4-c~j 잔여 편성**(감사 §4 순서: c→d→g→e→i→f→j, U4-i는 U2 선행) · 첨부 이식 배치(ADR-0151 승인 후 — 서버 3경로+웹 컴포저) · #1022(레인 서버 Rust 교체 — B3 랜딩 후, 기기·레인 자원 경합 회피로 보류 중) · #1035(워크트리 pod install — U4-b가 expo-clipboard로 재현 예정) · 웹 배치 후보(core 조사 잔여 2·routingModel 낡은 예시).
>
> **운영 키(컴팩트 후 필요)**: NCP ssh=sshpass+비번파일(2f5adb6c… 스크래치패드 `.ncp-root-pw`) · 기기 UDID CDAA1DBF-B0CC-543E-9E4C-ED3EEB524C7A · 루나 툴 켜기/끄기 스크립트=세션 스크래치패드 `enable/disable_luna_tool.sh` · Apple 자산=전부 확보([[apple-signing-assets]] 메모리·재질문 금지) · main 동기화=성재 위임(랜딩 단위) · 구현 워커=Opus 5 Agent tool·Fable=오케스트레이터 전임.
>
> 이하 이전 스냅샷:

> **2026-08-04 스냅샷 10 (Fable · momo-main 통합 — 인계 전수 검증·로드맵 조정).** 전 세션 인계(`2026-08-03-session-state-for-fable.md`)를 전 항목 재실측했다. **정본 = `docs/planning/2026-08-04-handover-verification-and-roadmap-adjustment.md`.**
>
> **상태 정정 — 아래 스냅샷 9는 세션 중반에 멈춰 있다**: #979(승인 서버)·#980(폰 에이전트 탭)·#981(인용)·#982(작성 중 신호) **전부 `track/engine` `dae3a387`에 머지 완료**, 워커 전원 STOP. **ADR-0148·0149는 Accepted**(스냅샷 9의 "성재 결정 대기"는 낡음). 라이브(app.oor7.com)는 **구 이미지** — approvals/typing **404 실측**, 남은 것은 `compose up -d` 한 줄(성재 결정 A).
>
> **실측 수치 정정**: Rust 라우트 **65 유니크 경로 / 82 메서드 엔드포인트**("63" 아님) · Swift **137 유니크 경로**("156"은 어느 단위로도 재현 불가 — 정본 숫자 정정은 결정 F) · 모바일 6 feature / 웹 23(단 명목치 — `serverSurfaces.ts` 5표면 `provided:false`).
>
> **축 현황(서버코드/배포/웹/모바일 4층)**: **대화** = 코어 전층 ✅ · 인용/typing 클라 0 · **첨부는 3층 전무** / **관전** = 폰 최소 절단면까지 ✅ · cancel 라우트 없음 / **승인** = 서버 코드 ✅ · **배포 ❌** · 웹 결정 UI 0건 · **모바일은 목록+푸시 잠금화면 결정 배선 완비(fail-closed 잠김)** — 승인 표면은 모바일이 웹보다 앞서 있다.
>
> **배치 2 완주(2026-08-04 새벽)**: 관전 축 마감 — track/engine `d5cc8559`. #993 cancel 이식(휴먼 정지권, mention job 유실 선제 차단) · #995 roster paused · #994 폰 「작업 중」(2R: 회복배치 종료프레임·오프라인 고지) · #996 중단 컨트롤+paused 소비(409 구분 보존·N+1 제거). 통합 검증 green(core 678·web 619·mobile 516). red proof 누적 12종. **다음 = 검수 빌드 준비(폰 Release 재빌드+웹 배포) → 성재 폰 검수(배치 1+2 합산) → 배치 3(대화 기준선).** 후속 큐: producer run_id 대소문자·게이트웨이 종료 프레임·웹 replay 갭·행 폭·선존재 2건.
>
> **배치 1 완주(2026-08-04 밤)**: 승인 축 3층 랜딩 — track/engine `a604eb2f`. #986(hermes — 체크섬=체크아웃 경로 함수 결함 수리) · #988(웹 승인함 — 플립+도달경로+gate:approvals 신설) · #987(모바일 인앱 승인 — core 뿌리 수리 포함). **원점 통합 검증 green**(core 678·web 619·mobile 486·typecheck 0·gate PASS). 디자인 리뷰 2기가 Blocker 4 적발 → 2R/3R 수리, 워커가 리뷰 밖 Blocker급(와이어 표기 — Rust 서버 상대 승인 목록 상시 공백) 추가 발견·수리. **다음: 검수 빌드 준비(폰 Release 재빌드+웹 배포) → 성재 폰 검수 분기 → 배치 2**(관전 마감: cancel 이식·턴 신호 폰·roster pause) → 3 대화 기준선(인용·typing 클라) → 4 위생(openapi 승인 스키마 표기 정정 포함) → 5 첨부(**ADR-0150 선행**). 후속 적립: 승인 카드 표면(서버 props 영어·tool_call 카드 노출)·푸시 결정 사용자 고지. 결정 **A~F 전부 종결**(2026-08-04): **A 배포 완료(Fable 대행)** — 라이브 approvals **404→401**, `momo-rust:dae3a387` 전 서비스 전환, 배포 정본 = `docs/runbooks/ncp-rust-deploy.md`(**5파일 compose — 07-30 런북의 2파일 명령은 함정**) · **B** ADR-0145 증보 1(parity=제품 채택 집합) · C 어휘=재우기/깨우기 · **D 첨부 v0 포함**(상세는 ADR-0150 기안 시) · E 인앱 승인 배치1 · F 커밋. **성재 몫 잔여 = 폰 검수뿐**(배치 1 랜딩 시 일괄). **Apple 서명 자산은 전부 확보돼 있음**(Store 프로파일 앱+NSE·APNs 실작동, 빈 곳은 CI 레인뿐 — 정본 engine `docs/cicd/10-*.md` 상단, **성재에게 재질문 금지**). main 동기화는 성재 위임("트랙별로 메인에 머지 잘하쇼") — 랜딩 단위·게이트 그린 전제. 머지 순서: H-FIX1 독립 · W-AP1 → M-AP1 순(core 접점). hermes 물증 = SPEC CHECKSUM 한 줄 드리프트(1f9904ef→3ccaa647).
>
> 이하 이전 스냅샷:

> **2026-08-03 스냅샷 9 (Fable · momo-main 통합).** 발단은 성재 지시 *"핵심기능을 담는 부분이 미흡하다 — 로드맵 진단부터"*.
>
> **진단 정본 = `docs/planning/2026-08-03-roadmap-diagnosis.md`.** 판정: ①`ROADMAP.md`가 한 세대 낡음 ②서버는 에이전트 네이티브 코어를 갖고 있는데 **모바일이 표면화하지 않음**(모바일 5 feature vs 웹 23) → 봇이 있는 채팅으로 퇴행(ADR-0101이 거부한 자리).
>
> **성재 승인 3건 반영 완료** — v0 단위를 **M번호 → 축(관전·승인·대화)**으로 · 재작성 중 **클라 병행 유지**(ADR-0145에 사실 정정) · **Swift 서버는 parity 도달 시 일괄 삭제**(`server/README.md` 신설). 반영처: `ROADMAP.md` §0 전면 교체 + §1~§7 "대체됨" 표식, `docs/adr/0145`, `docs/architecture/overview.md` 상단 경고.
>
> **축 현황**: 대화 ✅ / 관전 서버✅·웹✅·모바일🚧 / **승인 서버 ✅ 폐곡선**(#979 머지 — `INSERT INTO approval` 0→생산자, 승인 라우트 0→3, `resume_approval` 소비. 오케스트레이터 실DB 게이트 7/7 + 인접 4스위트 회귀 0) · 모바일❌.
>
> **진행 중 배치**: **goal RN-A1**(에이전트 운영 표면 — 패킷 `handoffs/2026-08-03-RN-A1-agent-ops-packet.md`). 핵심은 웹에 갇힌 순수 판단 로직(`agentHub/model.ts` 153 · `channelPlacement.ts` 121 · `agents/agentRail.ts` 384)을 **`momo-core`로 꺼내고 모바일은 뷰만 얹는 것**. 작업 관전 최소분(세션 목록·**호스트 등급**) 포함. **세 번째 탭이 여기서 생기므로** `react-navigation` 도입은 금지하고 근거만 PR로 넘기라 지시(ADR-0137 D1 사안).
>
> **성재 결정 대기**: **ADR-0148**(인용 답글 — `reply_to_id`가 컬럼·FK·바인딩까지 있는데 전 호출부가 `None`, 마이그레이션 불필요) · **ADR-0149**(휘발 신호/작성 중 — 서버 경유 직접 publish, PG 미접촉). **0149는 Centrifugo publish 주체를 relay 1 → 2로 늘리는 경계 변경이라 Accepted 없이 구현 착수 금지**(ADR-0100).
>
> **폰 검수**: 성재 지시 *"조금 분기가 되면 한번에"* — RN-A1이 통째로 설 때까지 요청 없음.
>
> 이하 이전 스냅샷:


> **2026-07-28 스냅샷 8(Fable 산출물 통합·리소스 최적 정본 후보)**: 새 review-ready 패킷은 `docs/planning/handoffs/2026-07-28-fable-resource-optimized-canonicalization.md`다. #860은 uxui 랜딩, #875는 WorkHost signature v2와 red proof까지 engine 랜딩해 이전 레드팀 WorkHost finding은 해결됨으로 재분류했다. 유일한 active implementation은 clean/pushed `feat/876-t3-lifecycle-settlement`(`13da3fce`+`52245a95`, 23파일 +1300/-171)이며 새 worker를 열지 않는다. 다만 #876+#877+#878 한 PR은 `AGENTS.md`의 1 Issue=1 goal=1 PR과 충돌하므로, 코드 재분할보다 **#876 umbrella+#877/#878 absorbed(권고)** 또는 명시적 1회 예외를 성재가 승인한 뒤 merge한다. active 배치가 새 `CloudLifecycleReconciler`를 만들었으므로 #870은 dedupe 선행, #879도 interval floor/replay bound를 각각 absorbed/residual 판정하고 #869는 그 뒤 남는 WSS 조각만 진행한다. WIP는 code worker 1·planner 1·Docker-heavy host-wide 1, 기존 8종+T3 확장 gate는 한 heavy window, `adversarial-review`는 통합 경계 1회다. terminal privacy는 #857 노출/main sync 전 결정 항목, plugin delegated-subject는 plugin dogfood 전 blocker로 보존한다. **ROADMAP/BUILD_TICKETS/STATUS/Issue/track→main은 미변경 — Fable 원격 상태 재확인·absorbed 표·성재 결정 4건 대기.** 이하 이전:

> **2026-07-28 스냅샷 7(agent-platform 독립 레드팀 — 기존 builder DAG 조건부 반려)**: **PLN-20260728-01**의 원 감사 사실은 유지하되 실행 권고는 `docs/planning/research/2026-07-28-agent-platform-independent-red-team-review.md`와 superseding Fable 패킷 `docs/planning/handoffs/2026-07-28-fable-agent-platform-redteam-review.md`가 대체한다. 정적 검수에서 신뢰 경계 4건을 확인했다: **caller-chosen plugin delegated subject와 terminal `observation=open`+raw output 무기한 로컬 보존은 해당 레인의 현재 blocker**, WorkHost v1 body/query/nonce 미서명+replay는 remote/Windows 확대 전 P1 hardening, same-channel-any-human 승인은 personal credential/write 전 High blocker다. 따라서 plugin v2/skill store·recorder/generic Automation/MCP Apps/motion dependency/PTY 교체 spike를 발급하지 않는다. 최소안은 provider 1개의 host-owned connect+secret-free probe와 단일 runtime bridge를 먼저 닫고, plugin v1 read-only 1개와 `agent.owner_human_id`+`agent_profile.triggers.schedule`+`agent_run.idempotency_key`를 재사용하는 owner-only/read-only one-schedule vertical slice다. 기존 #865/#857~#861/#837은 continuity로 보존하되 #857 main sync는 terminal privacy gate와 함께 검수한다. SkillSpector 격리 pilot은 LOW/SAFE였으나 benign `keychain` HIGH false positive와 96-package 비용으로 advisory only 판정했다. **ROADMAP/BUILD_TICKETS/STATUS/GitHub Issue와 track→main은 변경하지 않았다 — Fable의 finding 중복·runtime 경로 검수와 성재 A~E 승인 대기.** 이하 이전:

> **2026-07-28 스냅샷 6(Tauri/RN 이후 agent-platform 갭 감사 — Fable 검수 대기)**: **PLN-20260728-01**이 `review-ready`다. 정본 리서치=`docs/planning/research/2026-07-28-tauri-rn-agent-platform-gap-audit.md`, Fable 검수 패킷=`docs/planning/handoffs/2026-07-28-fable-agent-platform-review.md`. 결론: 현재 React/Vite+Tauri·bare RN 방향은 유지하고, **#865 → #857 owner-approved main 동기화 → #859/#858 → #861/#860**을 먼저 회수한다. 그 뒤 plugin v2(다중 app/MCP/skill+사용자 연결), versioned skill+semantic recorder, 기존 `agent_run`을 재사용하는 Automation/Loop, sandboxed MCP Apps를 ADR 선행 후보로 검수한다. 터미널은 **xterm.js + Swift POSIX PTY + semantic adapter**가 현재 사실이며, PR #868은 `track/engine` merge 완료, #857의 open+`needs-review`는 main 미동기화 동안 계약상 정상이고 #859는 구현 commit 없이 그 merge base에서 대기 중이다. Herdr/Ghostty 교체는 열지 않고 Windows WorkHost 직전에 current/Rust PTY/Herdr를 좁게 비교한다. #839/#842는 코드와 Issue 상태가 어긋나므로 Fable이 ops drift로 분리 검수한다. **ROADMAP/BUILD_TICKETS/GitHub 신규 Issue와 track→main merge는 아직 변경하지 않았다 — Fable 검수 후 성재 승인 대기.** 이하 이전:

> **2026-07-28 스냅샷 5(연속성·허들 배치 6장 랜딩 — #857 가동 중 일시 중단)**: **재개는 `docs/planning/handoffs/2026-07-28-resume-batch2.md` 하나만 읽으면 된다.** 이전 배치 5장 main 반영 완료 후, 새 배치 랜딩 — **engine**: #855(T3 프로비저너+원장, pause 미계상=GENERATED) · #854(전사 v1, 동의 게이트 실서버 관통) · #856(ADR-0139 D1 idle 수명주기, 검증기 전관문+red proof). **uxui**: #850(웹 허들, 2R PASS) · #851(내 세션 표면, 2R PASS). **두 트랙 모두 main 앞 — 동기화는 성재 승인 대기.** **#857(데몬 셸 래핑·링버퍼·replay) sol medium 워커 가동 중인 채 중단** — RUN_DIR `goal-857-ringbuffer-20260728T092159`. 다음 큐: #859(T3 pause 접합) → #858(웹 idle, 소비 계약=PR #867 본문) → #860/#861(에이전트 허브). **이번 구간 선존재 수리**: 검증기 픽스처 드리프트 4종(07-21 이후 일주일간 403 — SQL 지름길 패턴 6번째) · gate:shell waitForFunction CSP 비호환 · #865 티켓(계약 게이트 차단 409). ADR-0139 Accepted·파생 4장(#856~#859+#858). ADR 정본 신설: 0139. 성재 몫: main 승인 2건 · D4 리허설(대본 랜딩·준비물 template+공개서버) · 전사 모델 실코퍼스 확정 · privacy-policy · #837 · ADR-0138/0113/0140. 이하 이전:

> **2026-07-28 스냅샷 4(일반 사용자 대응 배치 5장 완주 — main 승인 대기)**: **#840·#841(track/engine) · #838·#842·#839(track/uxui) 전부 랜딩.** 다섯 건 모두 **main 앞이고 성재 승인 대기**. **#842**(Tauri CSP + `gate-csp.mjs`): red proof 성립, **`gate:wire`·`gate:shell`을 패키징 CSP 아래 재실행해 커버리지 확장**(`default-src 'none'`이면 둘 다 exit 1 — 헤더 서빙 증명), `cargo tauri` 실빌드 exit 0 + 실웹뷰 렌더, **IPC 동작 증거=키체인 프롬프트·mDNS 프리필**. **#839**(동의 모달)는 **5라운드**만에 design-review PASS(B0·H0) — 매 라운드 지적이 직전 수정이 만든 것이었고, **2R의 "목이 같은 tick에 답해서 초록이던 게이트"가 핵심 교훈**(지금은 catalog/detail 160ms 편차). **red proof 4종**(포커스 무조건-true·스크롤 상자·링 여백·단일 원인 분기) 전부 실측. 오케스트레이터 자기 실수 2건 기록: 게이트 로그의 `buttonsInViewport:true`가 **측정 전 `scrollIntoViewIfNeeded()` 때문이었던 것**("스크롤하면 닿는다"≠"열자마자 보인다"), 링 여백 단정이 **rAF 스크롤 전에** 재던 것. **워커 모델=`gpt-5.6-sol` medium**(성재 지시, 이전 배치는 terra xhigh). 워커 감시는 이제 **프로세스 소멸도 본다**(terra 런 1건이 시작 3초 만에 죽어 한 시간 소실). **랜딩 후 필수: `docs/security/README.ko.md:68`의 "Tauri CSP는 null"이 #842로 거짓이 됐으니 main 통합 시 정정.** 성재 몫: main 승인 5건 · privacy-policy 빈칸 · #837 실기기 · ADR-0138/0113 · **#839 grant 기본 전체선택 유지 여부**. 이하 이전:

> **2026-07-27 스냅샷 3(배치 5장 중 3장 랜딩 · 성재 지시로 일시 중지)**: **재개는 `docs/planning/handoffs/2026-07-27-resume-batch.md` 하나만 읽으면 된다.** 랜딩 3장 — **#840**(첨부 unique 인덱스 테넌트 분리, 마이그레이션 044, track/engine) · **#838**(웹 플러그인 마켓플레이스 복원, track/uxui, design-review 4R PASS) · **#841**(한국어 보안 판단 자료 + 신뢰 경계 mermaid, track/engine `01026aa1`/PR #845 — 정직 항목 6종을 같은 문서 안에 명시, `legal/privacy-policy.md`는 의도적으로 미링크). **#839 동의 모달은 design-review FAIL(Blocker 1·High 4)** — 5건 전부 오케스트레이터가 코드에서 재확인했고 **수정 패킷을 `handoffs/2026-07-27-839-2r-fix-packet.md`에 써둔 채 워커 spawn 직전에 멈췄다.** Blocker는 `dialog.tsx`가 주석으로 적어둔 "본문 스크롤 상자는 caller가 넣어라" 계약을 이 caller만 안 지킨 것 — **출하 시드가 900x600에서 승인 버튼이 화면 밖**이고 **키보드가 보이지 않는 승인 버튼에 도달해 Enter가 먹는다**(뷰포트 밖 컨트롤은 #838에 이은 두 번째라 게이트로 잠글 것). **#842는 PR #847까지 진행**(Tauri CSP 설정 + `gate-csp.mjs` 신설, CSP를 `tauri.conf.json`에서 읽는 구조) — **검증 미착수**, `gate:csp`·레드 증명·`cargo tauri` 실빌드가 오케스트레이터 몫. **track/engine·track/uxui 모두 main 앞 — 머지는 성재 승인 대기.** 성재 몫: privacy-policy 빈칸(공개 차단) · #837 실기기 스파이크 · ADR-0138 신규/ADR-0113 증보 · **#839 grant 기본 전체선택 유지 여부**(제품 판단). 이하 이전:

> **2026-07-25 스냅샷 2(P1 wave1 완주·Opus 5)**: 구현 서브에이전트=**Opus 5**(별칭 실측). **P1 wave1 track/uxui 랜딩**: 748 승격(web-spike→web·v0→legacy·참조 전수) + 749 여명 토큰(컴파일러 집행 스케일·AA 실측 조정·대비 테스트 12) + 750 코어(사이드바·타임라인 seq 복구 마커·컴포저·⌘K). **실서버 스모크 2회 PASS**(수신 24~74ms). **웹 design-review 2사이클 완결(2R PASS Blocker0·High0, Medium 전건 해소)** — 1R이 런타임 프로브로 B1 프리펜드 앵커 소실을 실증, 수정이 프로브 결함까지 교정, 2R이 픽셀 스캔으로 마커 0픽셀 렌더 추가 발견·수리. 교훈: Tailwind v4 미정의 유틸 무음 드롭→산출 CSS 대조 검증(스킬 반영 후보). **wave1 main 병합 완료(#756)** · **wave2(MOMO-599~602: 인박스·에이전트 카드·설정 셸·M9/M10) track/uxui 랜딩(#763, 136 tests·실서버 스모크 2종)** — 3R 종결·wave2 main 병합(#765). **P2 완주**(766 플러그인 4종+767 연결 표면 → 통합 #770 track/uxui, 768 CORS → #769 track/engine): 실번들 E2E 딥링크 프리필·mDNS 발견 PASS, keychain은 CORS 재배포 후 최종 실증. **P2 main 병합 완료(#771·#772)** + momowebqa CORS 재배포·라이브 검증(tauri://localhost preflight 204·미등재 차단·POST 헤더 부여 — 릴리스 번들 REST 차단 해소). **parity 게이트 실측 완료·차단 0**(보고서 2026-07-25-parity-gate-report.md, 성능 3종 여유 통과) → **next.6 발행**(차단 G-1·High G-2 수리 포함). **에이전트 경험 프로그램 기획 정본 작성**(2026-07-25-agent-experience-program.md — 성재 7개 지시, Wave A~D·결정 큐 6개, 승인 대기) · #782 디렉터리+DM track/uxui 랜딩 완료(PR #787, main 반영 대기) · **전환 완료(2026-07-25): 기본 다운로드=momo-next 0.1.0-next.7, SwiftUI 은퇴** · **Wave A 완결(2026-07-26)**: main 동기화·616 라이브 통합 PASS·next.8 발행(기본 다운로드 갱신). **Wave C ADR 0134/0135/0136 Proposed — 성재 검토 대기.** **Wave C1·C2 완결 + 머지 전 리뷰·블로커 3건 선수정 랜딩(#829·#830)**: ADR-0134·0135 엔진+웹 양층 track 랜딩(#812~823). 대기: track→main 동기화(성재) → 라이브 통합 → next.10. **0136(E2B) 키 부재 확정 — 성재 조달 대기**(.env는 BLAXEL/DAYTONA만)(전환 시 SwiftUI 은퇴 수순). 잔여 비차단: #782 멤버 디렉터리·DM 시작. 구 표기: momo-next 발행 채널(Tauri updater)+parity 게이트 실측(릴리스 번들 keychain 왕복은 parity 런에 편입). 통합 교훈: 자동머지 의미적 파손은 typecheck가 잡는다(머지 직후 필수). 엔진 후속 후보: 승인 원장 created_at·전역 agent-run REST·realtime client_msg_id. 이하 이전:

> **2026-07-27 스냅샷(B 집행 — C1·C2 main 동기화 완료)**: 성재 B 승인 집행. **main = track/engine = track/uxui = `a8caa836`** — ADR-0134·0135 엔진층(621~625)+소비면(626~628)+선수정(#829·#830) 전량 main. 원점 게이트 그린(server 327·worker 86·웹 837·gate:shell·마이그레이션 43 유니크·typecheck 0). momowebqa 재배포 PASS(041~043 적용, 신규 2테이블 RLS FORCE, 신규 라우트 3종 401). **엔진 검증기 3종 오케스트레이터 직접 실행** — run_routing 30 PASS(F1 선수정 라이브 증거)·quota_snapshot 전관문 PASS·**provider_cascade docker 라이브 17관문 PASS**(실폴오버+감사행+outbox, 401 전파·hop1 예산 무손실). **한계 고지: momowebqa 인증 웹 왕복 미수행**(세션 정책이 자격증명 취급 차단) — 웹 3표면 클릭 확인은 next.10 빌드로 성재 몫. **0.1.0-next.10 발행+기본 다운로드 전환 완료**(build 1320, zip sha256 `872ac750…`). **C 집행 완료(2026-07-27)**: #826 iOS 전송 400 수리 track/engine 랜딩(`a27c0d3a`, PR #832) — 9주 결함 종결. `verify_ios_wire.sh` 신설(red proof 성립: 되돌리면 실서버 400으로 게이트 실패). 오케스트레이터 선수정 1건(무음 초록불 구멍 → `MOMO_IOS_WIRE_REQUIRED`). **main 반영 완료(성재 승인, `d7441538`)** — main=track/engine=track/uxui 3자 정렬, 머지 후 원점 검증 그린(server 327·iOS 70·웹 typecheck 0). **#825 랜딩(track/engine `e65ad53b`, PR #833)** — 캐스캐이드 재시도 증폭(144요청·36분, G5 우회) 차단. 타입 경계 도입·총 wall-clock 예산·논스트림 폴백 조건화. red proof가 **기존 17관문 사각지대**를 실증(되돌리면 신규 단정만 빨간불). docker 18 PASS·worker 89. **track/engine이 main보다 1머지 앞섬 — main 반영은 성재 승인 대기.** **#827 랜딩(track/uxui `59d7df53`, PR #834)** — 웹 와이어 검증 + **렌더 오류 경계 신설**(레포에 `componentDidCatch` 0건이었다) + `gate:wire` 신설. **전제 정정: 백스크린 6건은 실동이 아니라 DRIFT-ONLY**(Swift Optional은 null이 아니라 키 부재 → react-query가 막음). design-review **4R 종결 Blocker 0·High 0**(2R 이후 지적은 전부 오케스트레이터 수정이 만든 것). 844 tests·red proof 3종. **track/uxui가 main보다 1머지 앞섬 — main 반영은 성재 승인 대기.** **#828 랜딩(track/engine `8f4eab1b`, PR #835)** — H-1(quota 스코프를 운영자 경계로, 스코프 단위)·M-8(200+에러봉투 무응답 턴)·F4(복호화 실패 홉 무음 손실)·M-2·M-6(위반자는 Python)·M-9(역방향 커버리지 게이트 신설)·웹 F5/F6·어댑터 D3. **M-1은 제외**(041 기적용+파일 단위 트랜잭션으로 처방 무효, 규약만 문서화). 게이트: quota 11·cascade 18·server 330·worker 90·웹 847·어댑터 59·openapi 역방향 103경로. **track/engine이 main보다 1머지 앞섬 — main 반영은 성재 승인 대기.** 별건 후속: `verify_openapi_contract.sh`의 `work-session-remote-create` 409(base에서도 동일, 기존 결함). **#831 랜딩(track/engine `f4acd3a4`, PR #836) — 잔여 티켓 소진.** 허용 모델 노출 REST(에이전트별, 집행 함수 재사용, settings 통째 노출 회피) + 웹 교집합 축소(미수신 시 갇히지 않음). 검수 무결(고칠 것 없음), `verify_run_routing` 64관문 PASS·server 332·웹 851, red proof 2종. **track/engine이 main보다 1머지 앞섬 — main 반영은 성재 승인 대기.** **일반 사용자 대응 배치 발진(2026-07-27, 성재 발제 3건)** — 계획 정본 `docs/planning/2026-07-27-general-user-readiness-plan.md`. 조사 결과: ①브라우저 왕복은 **후반부(딥링크·콜드스타트 버퍼)가 이미 배선**돼 있고 빠진 건 프로토콜(유니버설 링크·인증 플로우·**초대 없는 계정 생성 경로 자체**) ②보안 **구현은 강한데**(RLS FORCE+부트가드·capability URL 직송·Drive SA readonly+driveId 강제) **한국어 문안 0건·랜딩 없음·위협모델 없음** ③커넥터 **서버는 완비인데 웹 화면이 유실**(구 SwiftUI 734줄이 은퇴 때 미포팅). **이슈 5장 발급: #838 마켓플레이스 복원 · #839 동의 모달 · #840 첨부 인덱스 테넌트 분리(보안) · #841 한국어 보안 문서 · #842 세션 저장 경계+CSP.** 권장 순서 840→838→841→839→842. **ADR 선행(착수 금지)**: ADR-0138 신규(일반 유저 온보딩/momo Cloud — 0121 D5-A·D6-A 개정) · ADR-0113 증보(3자 OAuth 커넥터). **성재 몫**: `legal/privacy-policy.md` 빈칸(공개 전 필수) · #837 스파이크 실기기 · 위 ADR 결정.

**ADR-0137 Accepted(2026-07-27, 성재 승인)** — 결정 5건 전부 권고안대로(전량 재작성·bare RN+Expo 낱개/EAS 미도입·`momo-core` 모노레포·iOS 킷 동결 후 교체·Android cleartext 티켓 분리). 승인 조건이던 MOMO-631은 이미 랜딩돼 4번이 충족됐다. **Accepted ≠ 구현 착수** — D6대로 첫 티켓은 스파이크(**#837 MOMO-635**, 실기기 6항목, 한글 IME 1번 게이트, 하나라도 실패 시 재보고). 이후 순서: `momo-core` 추출(웹 선소비로 회귀 0 증명) → RN 스캐폴드 → v0 UI(≈4,600 LOC) → NSE 이식+TestFlight → Android 레인. 후속 후보: `verify_openapi_contract`의 work-session-remote-create 409(기존 결함) · H-1 라이브 경로 단정 · openapi allowlist 41건 축소 · momowebqa 재배포 후 next.11.
> **다음 세션 진입점: `docs/planning/handoffs/2026-07-26-next-batch-handoff.md`**(§5 = B 집행 기록) — 파이프라인은 Fable 오케스트레이션 + Codex `gpt-5.6-terra` high 워커(codex-fleet 계약). 워커 프롬프트 필수 4항은 그 문서 §0.
> **2026-07-25 스냅샷(ADR-0133 전환 개시)**: **ADR-0133 Accepted**(UI 스택 SwiftUI→TS/React+Tauri, 웹-우선 스트랭글러). **P0 스파이크 게이트 전관문 PASS**(seq·resume·1k p95 10.3ms·콜드 537ms·196MB, 커밋 667a40a3) — clients/web-spike+clients/desktop main 랜딩(#747). R-1 웹 UX 스펙 5장+R-2 design-taste-web 스킬 설치. 이월 발견 3건(mDNS WS 행·CORS 프록시·virtuoso). 계획 정본 `2026-07-24-tauri-migration-plan.md`. 이하 이전:
> **2026-07-24 스냅샷(provider GUI 실서버 완결·0.0.2 발행)**: main=10e0493c — provider 연결 GUI 4조각(572 REST·573 worker·574 GUI·576 owner/admin 개방) + **577 실서버 왕복 3버그 수리 랜딩**(bytea 바인딩 `ByteBuffer`·DELETE audit nil `::text`·Linux `.build` cp 함정). verifier가 owner PUT/GET/DELETE 8관문 실 PG 왕복 자동 단정(8/8 PASS). **라이브 momowebqa에서 owner 실왕복 검증 그린**(PUT 200·database·마스킹→DELETE→env 복귀) — "GUI로 붙이면 실제 대화" 실서버 성립. **0.0.2 알파 발행**(build 1087, sha256 eab65d6c…, momo-macos-0.0.2.zip, Pages 매니페스트 갱신). 로그인=`/v1/auth/login`(workspace 필수)·provider REST=`/v1/provider/link`·demo WS=`00000000-0000-7000-8000-000000000001`. 대기: **P1(momo-web MVP) 착수 결정**(착수 시 SwiftUI 신규 표면 동결 발효) · web-spike 승격 명명 · 팔레트(인디고→여명 호박) 승인 · 성재 0.0.6 실사용 풀루프 피드백(워크스페이스 개설→초대 메일→팀원 링크 입장→에이전트 인사→ACP 호스팅 런북) · 마스코트 방향 · Sparkle(#736, 게이트 해제됨) 착수 시점. **서명 배포 성립**(0.0.5부터 Gatekeeper 없음, 인증서 YWQQFQM38J·momo-notary·publish 배선). **셀프서브+업데이트 배치 main 완주**(589 워크스페이스 REST verifier 전관문 PASS·590 생성 GUI·591 초대 딥링크/메일·592 ACP 런북·593 업데이트 pill, design-review 통합 PASS 2R). ADR-0117 증보2 Accepted. **momowebqa에 worker 첫 기동**(멘션 응답 갭 수리). 백로그 추가: 734 deferred 2건(WH-2 페어링 표면·시드 개인화), 시트 레일 정렬, 자동 초대 팝오버 런타임 확인. **온보딩 와우 배치 W-O1~5 전량 main 완주**(MOMO-584~588, #729·#730): momo://join 딥링크(발급+클라 프리필, 계약 `docs/onboarding-deeplink.md`)+_momo._tcp mDNS(광고 라이브+chooser 발견 카드)+에이전트 첫 인사(verifier 11/11)+기본값 정리+운영자 초대 카드 템플릿(TESTER_GUIDE). design-review 2R PASS. **0.0.4 발행**(온보딩 와우 빌드). 검수 교훈 성문화 후보: **UUID 문자열 비교는 항상 케이스 무관**(577·582·588 3연속 동일 클래스). 백로그 추가: Esc 공존(Medium)·ko InfoPlist.strings. **MOMO-583 랜딩**(576 후속 집행, main #718): provider_link=platform:read OR 등재 인스턴스 운영자(owner/admin+검증이메일+PLATFORM_ADMIN_EMAILS 요청시점 판정 — macOS가 platformAdminSecret 미지원이라 scope-only 대신 변형 채택). per-WS 표면은 owner/admin 유지. verifier 9관문 PASS(미등재 owner 403 신설). **알파 사이트 여명(Dawn) 리디자인 라이브** — 방향 정본 `2026-07-24-alpha-site-design-direction.md`, 마스코트 유보 슬롯. **ADR-0114 증보1(WH-0~3) 전량 main 완성 + 0.0.3 발행**: WH-1 사이드카(opencode+goose 동봉, 실 Docker 빌드 1.02GB) + WH-2 서버 REST(MOMO-582 /v1/provider/work-host-engine, per-ws RLS, 검증기 실 PG18 전관문 PASS) + WH-2 GUI(설정 "코드 실행 호스트" 엔진Picker+페어링+AI연결 구분, design-review Blocker0·High0) + WH-3 문서(WORK_HOST_QUICKSTART.md). PR #708/#709(WH-1)·#711/#713/#714(engine)·#712/#715(uxui) 전부 main. **0.0.3 발행**(build 1114 @04c95afa, sha256 734315c8…, momo-macos-0.0.3.zip). 마이그레이션 다음=**041**, verifier 포트 다음=**28290대**. **다음**: 성재 GUI 실사용(사이드카 `--profile workhost` 켜고 엔진 붙이기) 피드백 → 잔버그/UX 수렴. 백로그: 셰어드 토큰 칩 대비(574/706 공통, design-review Medium2), MOMO-575, ADR-0117 W-4, 567. 참고: t3code 경쟁 분석(`2026-07-24-t3code-competitive-analysis.md`) — work console 경쟁자(엔진 아님), 포지셔닝 위계 고정 권고. 백로그: MOMO-575(프리셋 스냅샷), ADR-0117 W-4(멀티WS 전환), 567·code graph 등. 이하 이전:

> **2026-07-23 밤 스냅샷(Opus 4.8 UXUI 배치 완주)**: Codex 한도 소진 → Opus 4.8 서브에이전트(Workflow) 구현으로 전환. **5장 랜딩**: 571 workspace-create(main) + 568·569·570·518(track/uxui, 각 design-review Blocker0·High0). **track/uxui→main 머지 성재 승인 대기**(5장 통합 빌드 PASS). 승인 시 순차 머지+알파 재발행. 내부 테스트 서버(mDNS `MacBook-Pro-2.local:28000`·restart=unless-stopped) 가동, workspace-create로 5WS 시나리오 개방. Codex 7/29 리셋 시 fleet 백업 병용. 이하 이전:
> **⚠️ 2026-07-23 저녁 — Codex 사용 한도 소진(7/29 리셋까지 fleet worker spawn 불가)**: 오늘 대량 소비 결과. 영향: MOMO-571(#687 workspace-create) 미착수로 리셋 or momo-main 직접 구현 or 크레딧 구매 대기. 내부 테스트 서버는 완비(mDNS `MacBook-Pro-2.local:28000`·restart=unless-stopped·alpha.2 ATS LAN)라 **1 시드 워크스페이스 도그푸드는 즉시 가능**. 5WS 시나리오만 571 대기. ADR-0117 Accepted. 이하 이전:

> **2026-07-23 스냅샷 5(내부 테스트 전환)**: 공개=게이트 충족 **동결**(성재 — 내부 목표치 통과 시 자연 배포). **알파 채널 라이브**: `dawn-kim-official.github.io/momo-alpha`(v0.5.0-alpha.1 발행, `publish_alpha_build.sh`). UXUI 배치 #684~686+#602 발급(패킷 `2026-07-23-uxui-buzz-batch.md`, UXUI 세션 몫 — 성재 전달). 내부 테스트 목표치=계획 §3(7일 무크래시·P0/P1 0·연동 3경로 완주·피드백 라운드 소진). momo-main 다음: UXUI 랜딩분 순차 main 머지, 피드백 인테이크 루프, 서버 공유 방식 결정 대기(Tailscale/단독). 이하 이전:
> **2026-07-23 스냅샷 4(공개 게이트 완성)**: main=8e5a2d4 — **공개 릴리스 전제 전부 충족**: 554 ✅·리허설 Phase 1 PASS ✅(보고서 2026-07-23-rehearsal-phase1-report.md)·564 README/SECURITY ✅·565 단일 이미지(LICENSE/NOTICE 동봉 단정) ✅. worker 0, 이슈 647~656·677·681 전부 close. **성재 결정 1건 대기: 공개 실행**(절차: publish dispatch→digest 핀→이미지 스캔→v0.1.0 태그→레포 공개 전환 — 전환 클릭만 성재 권한 필요할 수 있음). 잔여 백로그: 566 ✅(reclaim 스크립트)·567 원장 로테이션·code graph Phase 0·옵션 C·ADR-0117. 이하 이전:
> **2026-07-23 스냅샷 3(Wave H 완결+패키징 레인)**: main=f5a6a55 — **Wave H 전량 랜딩**(554~563 + 클라 558, ADR-0132 완결, 562 /metrics까지). 내부 알파(momowebqa) 신 태세 재배포 완료(`scripts/internal_alpha_stack.sh` 정본, cancel/pause 라우트 실서빙). 패키징 레인 §8 판정 확정(62a046e): **크리티컬 패스 = 565(이미지 6→1, worker 가동 중 #681) → 리허설 Phase 1 → 564 → 공개**. 실 AWS는 내부 도커 호스트 검증+UXUI 피드백 후(성재). Linux 컨테이너 빌드 함정 2건 성문화(암묵 전이 import·swift-crypto Sendable). 이하 이전:

> **2026-07-23 스냅샷 2(Wave H 집행 — H1·H2 완결+561)**: main=2146836(3 브랜치 동기, worker 0) — **554·555·556·557·558·559·561 전부 랜딩**, ADR-0132 서버+클라 완결. 이슈 647~652·654 close. 남은 Wave H: 560(#653)·563(#655)=성재 브리핑 후 발급, 562=ADR-0121 증보 1 승인 대기, 564(#656)=공개 전제. **다음 큰 단계=실배포 리허설 Phase 1(로컬)** — PASS가 공개 릴리스 게이트. 성재 대기: ①내부 알파 재배포 ②557 경계 해석 ③ADR-0121 증보 ④560/563 착수 승인. 이하 이전:
> **2026-07-23 스냅샷(Wave H 집행 — H1 완결)**: PLN-20260722-02 성재 승인분 집행 — **ADR-0132 Accepted**, main=fc9befa에 **554 Critical(RLS 실집행)·555·556·557·559 랜딩**(각 Docker verifier PASS, 이슈 647~650·652 close). 마이그레이션 다음=**039**(037=554, 038=557), verifier 포트 다음=**28200대**. worker 2기 가동: 651(558 Stop/Pause UI, base **track/uxui**)·654(561 set-owner). 남은 체인: 654→560(653)→563(655) 순차, 562는 ADR-0121 증보 1(Proposed — 기안 완료) 승인 후, 564(README/SECURITY)는 공개 전제. **554 랜딩 후 순서: 리허설 Phase 1(로컬, 새 롤 태세 검증)=공개 릴리스 게이트.** 성재 대기 3건: ①내부 알파 재배포 여부 ②557 run↔work_session 경계 해석 확인 ③ADR-0121 증보 승인. 패킷 정본: handoffs/2026-07-22-buzz-hardening-batch.md. 이하 이전:
> **2026-07-23 새벽 스냅샷 2(buzz→Wave H plan-ready)**: **PLN-20260722-02** — buzz 4축 해부(2026-07-22-buzz-competitive-analysis.md) → 2차 감사(RLS 태세·셀프호스팅 비교) → Wave H 계획(2026-07-22-buzz-actions-plan.md, critic 검수 반영) + **ADR-0132 Proposed**(에이전트 정지권·루프·발화계약). **Critical 발견: prod 템플릿 API 롤=수퍼유저(RLS 무효) → MOMO-554**. 성재 승인 대기 3건: H1(554∥555→556 — 위임 큐 ①게이트 부채와 합류 권장, 554는 리허설 Phase1 선행) / ADR-0132 option(→557~559) / H3(560~563)+공개 이미지 결정. 번호 554~563 예약. 이하 이전:
> **2026-07-23 새벽 스냅샷(파이프라인 소진)**: main c8bca25=track/engine=track/uxui, worker 0. 오늘 22티켓 랜딩 — 온보딩 양문형 전장(엔진+UI)+Memory Plane 전 표면(grant UI까지)+sol 감사 후속 5장. 공개 게이트 법무 5항 확정(DCO=CONTRIBUTING 구현). ADR 0126~0131 Accepted. 마이그레이션 다음=037, 포트 다음=28170대. **다음 순서(위임 완료)**: ①게이트 부채 배치 ②실배포 리허설 Phase1(로컬) ③ADR-0117 기안. Phase2에서만 성재 VPS 필요. 통합 규율 신설: 머지 후 push 전 마커 grep+macOS 빌드 게이트(사고 2건 성문화). 이하 이전:
> **2026-07-22 심야 스냅샷(온보딩 배치 완주)**: **PLN-20260722-01 엔진 전장 main 랜딩(cdd78d0)** — Wave B(534·536·535)+C(537 ADR-0131·538)+sol 후속(545·546·547·548·539) 13장. **Wave U 완주**(525·529·532 main). 마이그레이션 033 outbound·034 env·035 consent·036 agent_profile(다음=037). 진행: UXUI 소비 3장(#638 온보딩UI·#639 연동탭·#640 메모리표시 — fleet 대행). 잔여 큐: 549 grant REST → 550~552 랜딩 후 UXUI grant UI. 법무 패키지 성재 전달 대기. 이하 이전:
> **2026-07-22 저녁 스냅샷(Wave B/C 착수)**: PLN-20260722-01 성재 승인("wave B/C는 진행") — MOMO-534(#615)·536(#616) worker 병렬 가동(어댑터 2종·A2A 카드 온보딩), 이후 535(#617)·539(#620) ready, **537(#618)은 ADR-0131 Proposed 승인 게이트**, 538(#619)은 534 랜딩 후. 실행 정본 handoffs/2026-07-22-agent-onboarding-batch.md, 마이그레이션 032부터, 포트 28120대부터. 527 전 게이트 회귀 완주(runtime-agent rc=0, 제품 결함 1건 수정 e984d9c — 승인 재개 침묵 실패). 동생: #610 반려(Blocker 1 — PR 코멘트 패킷) 수정 대기, 이후 ⑩ A-16(529)·⑪ A-17(532) 개방 상태. 이하 이전 스냅샷:
> **2026-07-22 스냅샷(패브릭 엔진 배치 종결)**: **PLN-20260721-01 엔진 6장 전부 main 랜딩** — Wave M(526 Memory Plane→527 pgvector 하이브리드→528 Context Packet v0)+Wave A(530 gateway work tool→533 work_tool_profile→531 momo-acp-host)+W-6, 각 docker/mock verifier PASS. 남은 패브릭=Wave U 동생 몫: ⑩ A-16(529 메모리 브라우저+packet 인스펙터)·⑪ A-17(532 도구 관리+ACP 카드) ENGINE_HANDOFF ready. 마이그레이션 028 memory_search·029 tool_profile·030 context_packet 확정(다음=031). verifier 포트 신규=28110대부터(28100~03=528 점유). 회귀 잔여: runtime-agent+게이트 내 memory-search(부하 대기). 리서치 20-00 → MOMO-534(eve/CF 어댑터)/535(outbound 이벤트) 후보+0130 D4 상향 — 성재 결정 대기. 공개 게이트 남은 것: THIRD_PARTY 갱신·법무 패키지. 이하 이전 스냅샷:
> **2026-07-21 밤 스냅샷(패브릭 인수)**: PLN-20260721-01 인수 완료 — ADR-0129/0130 Accepted, MOMO-518·526~533 BUILD_TICKETS 이관·이슈 발급, Wave M(526→)·Wave A(530→) engine fleet 가동, Wave U는 UXUI 순차 배치에 ⑧⑩⑪로 편성. §4 함정=HANDOFF_TEMPLATE §5.1 승격. **웹 트랙 W-1~W-5 완주**(track/engine=main+2). 멤버십 수명주기(ADR-0128) 서버 완결. 동생: 순차 배치 ③(517)까지 랜딩. 다음 성재 결정: track/*→main 배치 승인(정례), LICENSE/ghcr 공개 게이트. 이하 오전 스냅샷:
> **2026-07-21 스냅샷**: 슈퍼앱 L5(개발자 콘솔) 진행 중. **main c953322 = track/engine = track/uxui 정렬**(이중트랙 머지 완료). **랜딩(main)**: 메신저 코어 전부(스레드·반응/수정삭제·검색·첨부·음소거·허들·푸시) + Interactive Work Console(ADR-0114 483/484/486 + A-10/A-11) + Host Fabric v0(ADR-0125 487·488·489) + **491 openssl·509 X-7 에이전트생성·511-E D10 attach capability** + macOS 512 focus fix + iOS v1 기반(496 아이콘·497 탭셸). **MOMO-512 차단 해소**(Fable 실디스플레이 real-window 4/4 확증). **진행 중**: 543(iOS 타임라인 v2) 게이트 PASS·시각 QA 후 랜딩 / 509·511 docker 런타임 verifier(runtime-unverified→verified) / iOS 499~506(모바일 플랜 승인 대기) / 511-U SwiftTerm attach UXUI. **T3**: ADR-0125 D3 기질=E2B 확정. oort Cloud 프로비저너=후속 ADR. 정본: docs/TRACKS.md·ENGINE_HANDOFF.md·QA_FOLLOWUP.md·research/17. JOURNAL 최신 우선.
> **2026-07-18 운영 정본 이동**: 트랙 파이프라인은 `docs/TRACKS.md`, 트랙 간 작업 큐는 `docs/planning/ENGINE_HANDOFF.md`가 정본이다. main `7e7b283`(UXUI A-1/2/3/5/7 + 엔진 음소거 MOMO-477·상호작용 MOMO-478 동시 랜딩) 기준 두 트랙 브랜치 모두 main과 일치. 아래 스냅샷 세부는 2026-07-16 기준으로 낡았다 — JOURNAL 최신 항목을 우선 신뢰.
> 기준일: 2026-07-16 · 기준선: **canonical main `05368ea` + PLN-20260716-01 Plugin Platform planning overlay** — Plugin Center·추천 onboarding·동적 capability discovery와 Drive reference vertical 후보를 조사했으며, 기존 GitHub-first 전략과 credential/runtime 경계를 바꾸는 구현은 성재 결정과 Accepted ADR 전까지 열지 않는다. Work v0(362..365)·unread(366/367)·ADR-0112 Wave A+MOMO-379 기반은 유지된다 · 통합 책임: `momo-main`
> 이 문서는 **컨텍스트 압축/세션 전환 후 가장 먼저 읽는 현재 상태 스냅샷**이다.
> 결정 근거는 ADR, 검증 증거는 STATUS, 일정은 ROADMAP이 정본이며 이 문서는 그 정본들을 연결하는 포인터다.

## 0. 3분 복원

- 제품 방향: oort는 채널 타임라인을 사람·에이전트의 실행/승인/비용/감사 원장으로 만드는 self-hosted agent messenger다.
- 기획 체계: 성재가 최종 결정권자이고, Fable과 GPT 5.6은 동등한 planner다. `momo-main`은 병렬 기획 결과를 순차 통합하는 유일한 sync authority다.
- 구현 체계: Codex worker가 GitHub Issue 하나를 goal 하나로 claim하고 최대 5개까지 병렬 작업한다. worker는 PR handoff 후 멈춘다.
- 현재 큰 결정: ADR-0100(거버넌스), ADR-0101(per-agent bearer), **ADR-0102(실행 경로 — Option C 이중 경로 + 서버 보장 매트릭스, 2026-07-12)** 전부 Accepted. 다음 결정 큐는 ADR-0103(로드맵 정렬)부터.
- 현재 구현 체인: **workspace-first messenger shell** — ADR-0112 Wave A+MOMO-379로 듀얼 밀도, 채널 헤더, 멤버 디렉터리/DM, 창 크롬을 랜딩했다. MOMO-383은 toolbar capsule을 제거하고 sidebar workspace identity/menu와 ADR-0118의 active-member read/owner-admin rename을 구현했다. cache/session generation과 delayed roster/channel cache guard, exact subscription cleanup, identity+channels 병렬 bootstrap, one-query workspace read, drift-failing private object/production role preflight, accessible retry와 narrow settings projection을 전체 Swift 369 tests로 닫았다. final clean runtime-db/macos-ui/docs evidence는 PR handoff를 정본으로 삼는다. merge 후 channel 생성 sheet/tooltip(MOMO-384 `#390`)과 one-click DM/member inspector(MOMO-385 `#391`)를 열고, 둘 뒤 RLS workspace 검색(MOMO-386 `#392`)을 진행한다. `Control+backtick` transcript drawer는 MOMO-375 후보이나 실제 command input은 ADR-0114 승인 전 구현하지 않는다.
- 운영 노트(2026-07-11): compose 컨테이너는 repo config 변경을 자동 반영하지 않는다 — infra config를 바꾼 merge 뒤에는 momo_main Centrifugo 재시작 필요(MOMO-338 config drift로 root gate 107/102 오류 전례). drift guard 자동화 티켓은 성재 승인 대기 제안.
- 이전 Hermes/local-dogfood dirty snapshot은 `codex/archive-local-solo-reconcile-20260710` / `eb09627`에 보존했다. canonical root `main`에는 정식 리뷰·PR을 통과한 변경만 반영한다.

### 0.1 현재 두 트랙 운영

| 트랙 | 주 실행 위치 | 목적 | 현재 경계 | 다음 체크포인트 |
|---|---|---|---|---|
| **UX/UI + 메신저 기능** | `momo-main` | 성재의 실창 수동 QA를 workspace → channel/DM → timeline 위계와 Slack 기본기로 수렴시키고, 개발자 모드에서 Codex급 실행 상세를 연다. | 한 번에 하나의 구조적 UX goal을 main이 오케스트레이션한다. 창 크롬/overlay/tooltip은 snapshot뿐 아니라 실창 AX와 좁은 창을 검증한다. | MOMO-382 기획 통합 → MOMO-383 workspace-first navigation → 384/385 → 386 |
| **슈퍼앱 엔진** | 별도 planning ID + planning branch/worktree | Work·문서·Google Workspace·plugin/webhook·MCP·승인 실행을 채널 원장 위에서 자동화한다. | engine planner는 자기 ADR/research/proposal만 소유하고 `clients/macOS/**`를 건드리지 않는다. ADR draft는 Accepted가 아니며 builder ready 전 성재 승인이 필요하다. | ADR-0113/0116 병렬 draft → ADR-0114 interactive Work host → ADR-0115 signed webhook ingress |

엔진 준비도(2026-07-14 코드/정본 대조):

- **코드 랜딩·repo-local mock 검증됨:** Work v0(`agent_run` + codex-workbench BYOA), 승인 pause/resume·결정·재개, per-agent bearer, status/partial, 비용·감사 원장.
- **런타임 미검증:** 실제 Codex와 oort 사이의 Work 실행 및 승인/resume 왕복은 아직 `runtime-unverified`다.
- **부분 구현:** 채널 히스토리 컨텍스트 조립 v1은 있으나 Context Broker/Context Packet의 권한·source·memory 실조립은 미완; inbound MCP는 skeleton/spec-to-code bridge 수준이다.
- **스펙만 정본화:** Google Workspace connector/enterprise consent(연구 스펙은 oort connector의 refresh token 암호화 저장을 제안하며, 구현 전 보안 경계 ADR 승인 필요), Plugin Manifest/catalog/repo split, Memory Plane/Capability Cache의 전체 런타임 저장·무효화.
- **자리만 있음:** 채널 설정의 웹훅/연동 탭은 placeholder이며 실제 발급·서명·회전·수신 경로는 아직 없다.

## 1. 활성 기획 레인

| Planning ID | 주제 | Planner owner | 상태 | 결정권자 | 다음 행동 |
|---|---|---|---|---|---|
| `ADR-0102` | AgentWorker SSE vs Hermes Gateway 정본화 | Fable | **`accepted`** (2026-07-12, Option C) | 성재 ✓ | 파생 배치 실행 완료 (2026-07-12 종결) |
| `ADR-0109` | unread/read-state 서버 계약 (UX P7) | Fable | **`accepted`** (2026-07-13) | 성재 ✓ | Wave 2(MOMO-366/367)까지 랜딩 완료 — 후속 없음 |
| `ADR-0111` | Agent Work Surface — 메신저 내 업무·터미널·코드 실행 (성재 발제) | Fable | **`accepted`** (2026-07-13, Option A=BYOA) | 성재 ✓ | 배치 종결 (2026-07-13) |
| `ADR-0112` | 제품 표면 재정렬 — 듀얼 모드·Slack 기본기·Codex급 상호작용 (성재 발제) | Fable | **`accepted`** (2026-07-14) | 성재 ✓ | Wave A+379 종결; B/C는 육안 QA 후 발급 |
| `ADR-0124` | 알림 음소거 계약 (채널 mute, 서버 판정) | Fable | **`accepted`** (2026-07-18) | 성재 ✓ | MOMO-477 진행(track/engine) → 랜딩 시 UXUI A큐에 설정 UI 등재 |
| `ADR-0122` | 음성 허들 + 회의 지능 (LiveKit) | Fable | **`accepted`** (2026-07-18) | 성재 ✓ | V-1(MOMO-468) 진행 → V-2 infra → V-3 macOS(UX 조율)→V-3b iOS. v1/v2는 후속 |
| `ADR-0123` | iOS 클라이언트 v0 — dogfood-first 모바일 수신부 (성재 발제 2026-07-17) | Fable | **`accepted`** (2026-07-17) | 성재 ✓ | IOS-1~5 전부 랜딩(2026-07-17, `3d321c6`) — 잔여는 TestFlight 런북 [manual](성재 실기기 E2E). v1 수렴·M8 이월 항목은 ADR 참조 |
| `PLN-20260714-01` | UX/UI 수동 QA + ADR-0112 후속 실행 순서 | `momo-main` | **`superseded`** | 성재 | 2026-07-14 실창 QA를 `PLN-20260715-01`로 이어받음 |
| `PLN-20260714-02` | 슈퍼앱 엔진 실행 로드맵(Work·MCP·GWS·plugin/webhook·approval) | engine planner + `momo-main` review | **`integrated-adr-drafts-pending`** | 성재 | gap audit/review/main 통합 완료(MOMO-381). ADR-0113~0116은 draft goal 발급 후 option 승인 필요 |
| `PLN-20260715-01` | Workspace-first messenger + superapp shell | `momo-main` | **`in-progress`** | 성재 | MOMO-382 정본 통합 후 MOMO-383을 첫 UX builder로 발급 |
| `PLN-20260715-02` | 메신저 아키텍처 바이블 + 플랫폼 확장 리서치(iOS/웹/푸시/파일/웹훅/리전/셀프호스팅 배포판) | Fable | **`research-complete`** | 성재 | 성재 지시(2026-07-15): 엔진/인프라 트랙을 Fable에 위임, **웹 우선** — ADR-0119/0120/0121 draft로 승계 |
| `ADR-0119` | 웹 클라이언트 트랙 — 서버 URL=웹 주소, 브라우저 인증/서빙/계약 경계 | Fable | **`accepted`** (2026-07-15) | 성재 ✓ | 첫 배치 MOMO-389→390→391 발급 (패킷 `2026-07-15-adr-0119-web-track.md`). W-4/W-5는 391 랜딩 후 |
| `ADR-0120` | 푸시 알림 경계 — Dawn 운영 push relay + 서버 notifier | Fable | **`accepted`** (2026-07-15) | 성재 ✓ | P-1/P-2는 웹 첫 배치 뒤 발급. relay 배포·Apple 계정은 별도 실행 결정 |
| `ADR-0121` | 셀프호스팅 배포판·온보딩 — install/upgrade, universal link 초대, BM 경계 | Fable | **`accepted`** (2026-07-15) | 성재 ✓ | S 배치는 웹 배치 랜딩 후 순차 발급 |
| `PLN-20260716-01` | 플러그인 플랫폼 제품화 + Slack/MM 호환 표면 | Fable (engine planner) | **`adr-accepted → building`** | 성재 ✓ | **SE-04A·04B 종결**(registry `1809551` / webhook `5ff5161` — ADR-0115 Accepted). 다음: GitHub grant 왕복→Drive 경로C(SA 포장). UI는 Codex handoff 대기 · 리소스 거버넌스 §9 + MOMO-411 gate --down 정착 |
| `ADR-0122` | 음성 허들 + 회의 지능 — LiveKit 미디어, 임시 허들 모델, 전사 파이프라인, 요약=에이전트 Work | Fable | **`proposed`** | 성재 | 성재 발제(2026-07-15) 리서치 완료(15-05). option 승인 대기 — Accepted≠즉시 착수(웹/푸시 뒤) |
| `PLN-20260721-01` | 에이전트-네이티브 비전(CTO 피드백 4대 고민+Blaxel) 리서치·설계 고도화 | Fable | **`adr-accepted → handoff-ready`** | 성재 ✓ | **ADR-0129·0130 Accepted**(2026-07-21 성재 지시 승인). **Blaxel 캔슬·E2B 확정**. 실행 정본: `handoffs/2026-07-21-agent-native-fabric-batch.md`(MOMO-518·526~533, Wave M/A/U + 오케스트레이터 인수 프롬프트 §8). 트랙 진단: 2트랙 유지+함정 규율 승격(2026-07-21-track-structure-diagnosis.md). 티켓 발급·정본 통합=오케스트레이터 인수 대기 |
| `PLN-20260722-02` | buzz 경쟁 분석 → Wave H 집행(태세 정정·게이트·정지권·셀프호스팅 제품화) | Fable | **`plan-ready`** | 성재 | 계획 정본 `2026-07-22-buzz-actions-plan.md`(critic 검수 반영). 승인 대기: H1(MOMO-554~556) / ADR-0132 option(→557~559) / H3(560~563). 554는 리허설 Phase1 선행 |
| `PLN-20260728-01` | Tauri/RN 전환 이후 경쟁·플러그인·스킬·스케줄·터미널·모션 갭 감사 | GPT 5.6 (`momo-main`) | **`review-ready · conditional-reject`** | 성재 | 독립 red team이 기존 builder DAG를 supersede: 신뢰 경계 4건을 레인별 gate로 분리하고, 단일 plugin runtime bridge 뒤 v1 read-only + owner-only one-schedule만 검수. Fable이 GitHub 중복·severity·#857 privacy gate를 재검증하고 성재 A~E 승인을 받는다. 승인 전 ROADMAP/BUILD_TICKETS/Issue는 변경하지 않는다 |
| `ADR-0132` | 에이전트 상호작용 안전 계약(휴먼 정지권·루프 방어·발화 의무·실패 고지) | Fable | **`proposed`** | 성재 | buzz 상흔 4종의 oort 번역. D1~D5 option 승인 대기 — Accepted 시 H2(557→558, 559) 발급 |
| `ADR-0103` | 로드맵 정렬: 멀티팀 알파 vs 로컬 솔로 dogfood | unclaimed | `queued` | 성재 | 내부 팀 알파를 현재 실행 가정으로 검토하되, 확정 표기는 성재 승인과 ADR 정본화 이후로 제한 |
| `ADR-0104` | 에이전트 presence/typing/streaming 이벤트 | unclaimed | `queued` | 성재 | MOMO-350(status/partial) 결과를 전제로 검토 |
| `ADR-0105..0108` | 검색·정체성·CI·서버 스택 | unclaimed | `queued` | 성재 | `docs/architecture/overview.md` 결정 큐 순서 준수 |

### 병렬 기획 claim 규칙

1. 기획의 잠금 단위는 `ADR-01NN` 또는 명시적인 `PLN-YYYYMMDD-NN`이다. 같은 ID를 두 planner가 동시에 소유하지 않는다.
2. planner는 `momo-main`에 claim을 요청하고, 현재 `momo-main` 담당이 이 표의 `Planner owner`를 바꾸는 planning-only 변경으로 잠근다. planner 자신이 `momo-main`이면 직접 반영한다.
3. planner는 자기 ADR/research/proposal만 작성한다. `ROADMAP.md`, `BUILD_TICKETS.md`, `STATUS.md`, GitHub Issue 발급은 성재 승인 뒤 `momo-main`이 순차 통합한다.
4. 다른 planner의 초안은 직접 덮어쓰지 않는다. 반대 의견은 ADR Option/Review Notes 또는 별도 research 문서로 남긴다.

## 2. 활성 구현 handoff

| Batch | Handoff packet | Goal | 상태 | 머지 순서 |
|---|---|---|---|---|
| ADR-0101 Phase 1 | `docs/planning/handoffs/2026-07-10-adr-0101-agent-identity.md` | MOMO-337 `#307` | `done` (PR #310, main `8d97c82`) | 1 완료 |
| ADR-0101 Phase 1 | 같은 패킷 | MOMO-338 `#308` | `done` (adapter bearer + private `agentwork:` self-only) | 2 완료 |
| ADR-0101 Phase 1 | 같은 패킷 (Status `done`) | MOMO-339 `#309` | `done` (PR #323, main `881518b`) | 3 완료 — 배치 종결 |
| verifier 격리 체인 | issue 본문이 패킷 역할 (`#318` 패턴 승계) | MOMO-346 `#322` | `done` (PR #326, main `beceaa1`) — 캐스케이드 종결 | 완료 |
| MOMO-339 후속 | issue `#324` 본문 (design review High/Medium) | MOMO-347 `#324` | `done` (PR #327, main `51db851`) | 완료 |
| verifier 격리 체인 | issue `#325` 본문 | MOMO-348 `#325` | `done` (PR #328, main `444ee59`) — 캐스케이드 전 프로파일 종결 | 완료 |
| **ADR-0102 실행 경로** | `docs/planning/handoffs/2026-07-12-adr-0102-execution-path.md` | MOMO-349 `#329` | `done` (PR #337, `b5b39df`) — 승인 왕복 실트래픽 랜딩 | 1 완료 |
| ADR-0102 실행 경로 | 같은 패킷 | MOMO-350 `#330` | `done` (PR #338, `f079279`) — 실행 과정 가시화 랜딩 | 2 완료 |
| ADR-0102 실행 경로 | 같은 패킷 | MOMO-341 `#333` | `done` (PR #339, `6fcb870`) — 중복 실행 방지 랜딩 | 3 완료 |
| ADR-0102 실행 경로 | 같은 패킷 (Status `done`) | MOMO-352 `#332` | `done` (PR #340, `bb76152`) — 호환 창 종료 조건 충족 | 4 완료 — **배치 종결** |
| ADR-0102 실행 경로 | 같은 패킷 | MOMO-351 `#331` (docs) | `done` (PR #335, `ebb3a52`) | 병렬 완료 |
| 독립 tooling | issue `#334` 본문 | MOMO-353 `#334` (drift-guard) | `done` (PR #336, `8337ae2`) — 실전 자가 실증 | 병렬 완료 |
| **Phase 0 dogfood 무결성** | issue `#343` 본문 | MOMO-356 `#343` (adapter 공지 유출 차단) | `done` (PR #344, `0a4bf37`) | 1 완료 |
| Phase 0 dogfood 무결성 | issue `#342` 본문 | MOMO-355 `#342` (seed opt-in) | `done` (PR #345, `ac00ef3`) | 2 완료 |
| Phase 0 dogfood 무결성 | issue `#341` 본문 | MOMO-354 `#341` (roster SoT) | `done` (PR #346, `9ca9c93`) — **배치 종결** | 3 완료 |
| **UI Wave 1** | `2026-07-13-ui-wave1.md` | MOMO-357 `#347` (셸·사이드바) | `done` (PR #355, `94e9244`) — 리뷰 반려 1회(접근성 High) | 3 완료 |
| UI Wave 1 | 같은 패킷 | MOMO-359 `#348` (타임라인 그루핑) | `done` (PR #354, `6b75260`) — 리뷰 반려 1회(Blocker: 복사 칩 상시 노출) | 4 완료 |
| UI Wave 1 | 같은 패킷 | MOMO-358 `#351` (Cmd+K 스위처) | `done` (PR #356, `5ac5fa9`) — 리뷰 반려 1회(⌘서수 술어) — **W1 종결** | 5 완료 |
| **Agent Work Surface v0** | `2026-07-13-agent-work-surface.md` | MOMO-362 `#357` → 363 `#358` → 364 `#359` · 365 `#360` | `done` (PR #363/`2d5b2ad` · #365/`44f8d35` · #367/`adf159f` · #366/`f5aba9f`) — **배치 종결** | 완료 |
| **UI Wave 2 unread** | `2026-07-13-ui-wave2-unread.md` | MOMO-366 `#361` → 367 `#362` | `done` (PR #364/`69facce` · #368/`fd8eabe`, ⌥⇧↑↓ 스펙 변경 `d9f4e68`) — **배치 종결** | 완료 |
| **Phase A AWS** | `2026-07-13-phase-a-aws.md` | MOMO-360 `#349` (이미지 발행 워크플로) | `done` (PR #352, `6980e64`) | 1 완료 |
| Phase A AWS | 같은 패킷 | MOMO-361 `#350` (배포 번들+runbook) | `done` (PR #353, `1c044e6`) | 2 완료 |
| **ADR-0112 Wave A** | ADR-0112 + issue contracts | MOMO-370 `#378` → 371 `#376` → 372 `#377` | `done` (`6f4090c` → `c9ed890` → `e254cc6`) — **Wave A 종결** | 완료 |
| ADR-0112 D6 hotfix | issue `#379`/PR `#380` | MOMO-379 창 크롬 정합 2차 | `done` (`cef7430`, planning baseline `b5e572b`) | 완료 |
| 슈퍼앱 엔진 기획 통합 | `2026-07-14-pln-20260714-02-superapp-engine.md` | MOMO-381 `#383` | `done` (PR #384, main `011b630`) | 완료 — ADR draft queue 대기 |
| Workspace-first UX planning | `2026-07-15-workspace-first-superapp-shell.md` | MOMO-382 `#385` | `done` (PR #386, main `6f89d3b`) | 실행 체인 정본화 완료 |
| Workspace-first UX builders | 같은 패킷 | MOMO-383 `#387` → MOMO-384 `#390` / MOMO-385 `#391` → MOMO-386 `#392` | `in-progress` | 383/384 merged, 385 PR #406 final navigation/cancellation review fixes 완료 / needs-review handoff |
| **ADR-0119 웹 첫 배치** | `2026-07-15-adr-0119-web-track.md` | MOMO-389 `#395` → MOMO-390 `#396` → MOMO-391 `#397` | **배치 종결** — 389 `6fe746f` · 390 `5ecd645` · 391 `63e7d51`(main `web` 게이트 PASS) | 웹 v0·푸시 서버측 완성 + **ADR-0121 배치 1 종결**(406 `bb3efc6`·407 `4a8b288` — codex-fleet 복귀, worker=5.6 sol medium). 잔여 S: S-4 universal link·S-5 relay 등록(P-3 뒤). ADR-0122 승인·플러그인(16-02) 위임 대기 |

동적 GitHub/worktree 상태는 이 문서에 복사하지 않는다. `scripts/goal_status.sh`를 실행해 확인한다.

## 3. 확정된 경계 (다시 토론하지 않음)

- Postgres가 SoT이고 Centrifugo는 transport only다.
- 모든 user-visible write는 REST → Postgres transaction → outbox → relay 경로를 지난다.
- 에이전트는 `member.kind='agent'`인 1급 멤버다.
- upstream Codex/OpenAI의 OAuth access/refresh token과 API key는 oort에 들어오지 않는다.
- oort runtime은 Hermes-facing bearer를 runtime secret으로 사용할 수 있다. upstream provider 자격증명과 혼동하지 않는다.
- 공개 API, 보안 경계, DB 계약, 제품 방향, 기술스택 변경은 Accepted ADR 없이 구현 티켓으로 만들지 않는다.
- 로드맵/ADR의 최종 승인자는 성재다.

## 4. 다음 체크포인트

1. ~~Phase 0 / UI W1 / Phase A / Work v0 / Wave 2 / ADR-0112 Wave A / MOMO-379 / MOMO-381~~ — **2026-07-14까지 종결**. canonical main은 `011b630`이다.
2. **UX 즉시 체인:** MOMO-382 정본 통합 → MOMO-383 `#387` workspace-first navigation → MOMO-384 `#390` native channel sheet/tooltip + MOMO-385 `#391` member inspector/one-click DM → MOMO-386 `#392` RLS workspace search.
3. **Work Console 경계:** MOMO-375는 transcript/activity drawer까지만 Accepted 범위다. 실제 `Control+backtick` command input, cwd/worktree/process lifecycle, Codex/Claude/OpenCode session은 ADR-0114 승인 뒤 새 child로 발급한다.
4. **엔진 다음 단계:** ADR-0113(credential/capability/action)과 ADR-0116(context/memory retention)을 병렬 draft하고, ADR-0114(interactive Work host), ADR-0115(signed webhook ingress)를 분리한다. draft는 구현 승인 아님이며 성재 option 승인 뒤 foundation builder chain을 연다.
5. **Plugin Platform handoff:** `PLN-20260716-01`은 Plugin Center·추천 onboarding·catalog/install/connection/channel/grant/health의 독립 projection과 Google Drive product vertical 후보를 Fable refinement 입력으로 정리했다. 기존 GitHub-first 구현·분리 전략이 현재 정본이며, Drive-first 전환은 옵션 비교와 성재 결정, Accepted ADR 뒤에만 가능하다.
6. **엔진 ID/잠금:** MOMO-307은 Context Broker로 강화 유지하고, MOMO-308은 `ready`를 취소한 non-claimable MCP umbrella다(SE-03A/B/C 새 ID 대기). MOMO-310은 advanced RAG, MOMO-320은 완료된 env drift 전용, MOMO-321/322는 후속 archive/wiki로 동결한다. engine PR은 기본적으로 `clients/macOS`를 수정하지 않는다.
7. **Phase A 운영 단계**: GHCR publish 1회 → EC2 provision → `docs/runbooks/aws-internal-alpha-deploy.md` 절차 — AWS 리소스 생성은 성재 결정.
8. **legacy gateway secret 물리 제거** — 보안 정리 티켓 발급은 성재 승인 대기 (호환 창 종료 조건 충족, M7 전 시한). agent 신규 pairing 표면 티켓(103 은퇴 후 재생성 경로)도 함께 검토.
9. MOMO-354 design-review Medium 5건 이월 (BUILD_TICKETS 기록) — presence 하드코딩·비활성 author 표시·subscribe 순서 의존·에러 카피·데모 서사. 성재 판단 대기.
10. dogfood 실사용 확인 권장: @hermes 승인 왕복(349), 실행 중 상태/부분응답(350), 실제 Codex Work 실행 + 승인/resume 왕복.

## 5. 이 문서 갱신 규칙

- `momo-main`만 canonical `main`의 이 파일을 갱신한다. planner는 변경 제안을 자기 planning branch/ADR에 남긴다.
- 갱신 시 기준일, 기준 커밋, 활성 레인, 구현 handoff, 다음 체크포인트를 함께 확인한다.
- 세션 종료 시 `JOURNAL.md`에 5줄 이내 checkpoint를 남긴다.
- 채팅에만 남은 결정/할 일은 존재하지 않는 것으로 취급한다.
- 빠른 복원은 `scripts/planning_context.sh`, GitHub Issue/PR/worktree 실시간 상태까지는 `scripts/planning_context.sh --github`를 사용한다.
