# momo 기획 현재 상태 (Planning Current State)

> **2026-07-25 스냅샷 2(P1 wave1 완주·Opus 5)**: 구현 서브에이전트=**Opus 5**(별칭 실측). **P1 wave1 track/uxui 랜딩**: 748 승격(web-spike→web·v0→legacy·참조 전수) + 749 여명 토큰(컴파일러 집행 스케일·AA 실측 조정·대비 테스트 12) + 750 코어(사이드바·타임라인 seq 복구 마커·컴포저·⌘K). **실서버 스모크 2회 PASS**(수신 24~74ms). **웹 design-review 2사이클 완결(2R PASS Blocker0·High0, Medium 전건 해소)** — 1R이 런타임 프로브로 B1 프리펜드 앵커 소실을 실증, 수정이 프로브 결함까지 교정, 2R이 픽셀 스캔으로 마커 0픽셀 렌더 추가 발견·수리. 교훈: Tailwind v4 미정의 유틸 무음 드롭→산출 CSS 대조 검증(스킬 반영 후보). **wave1 main 병합 완료(#756)** · **wave2(MOMO-599~602: 인박스·에이전트 카드·설정 셸·M9/M10) track/uxui 랜딩(#763, 136 tests·실서버 스모크 2종)** — 3R 종결·wave2 main 병합(#765). **P2 완주**(766 플러그인 4종+767 연결 표면 → 통합 #770 track/uxui, 768 CORS → #769 track/engine): 실번들 E2E 딥링크 프리필·mDNS 발견 PASS, keychain은 CORS 재배포 후 최종 실증. **P2 main 병합 완료(#771·#772)** + momowebqa CORS 재배포·라이브 검증(tauri://localhost preflight 204·미등재 차단·POST 헤더 부여 — 릴리스 번들 REST 차단 해소). **parity 게이트 실측 완료·차단 0**(보고서 2026-07-25-parity-gate-report.md, 성능 3종 여유 통과) → **next.6 발행**(차단 G-1·High G-2 수리 포함). **에이전트 경험 프로그램 기획 정본 작성**(2026-07-25-agent-experience-program.md — 성재 7개 지시, Wave A~D·결정 큐 6개, 승인 대기) · #782 디렉터리+DM track/uxui 랜딩 완료(PR #787, main 반영 대기) · **전환 완료(2026-07-25): 기본 다운로드=momo-next 0.1.0-next.7, SwiftUI 은퇴** · **Wave A 완결(2026-07-26)**: main 동기화·616 라이브 통합 PASS·next.8 발행(기본 다운로드 갱신). **Wave C ADR 0134/0135/0136 Proposed — 성재 검토 대기.** **Wave C1·C2 완결 + 머지 전 리뷰·블로커 3건 선수정 랜딩(#829·#830)**: ADR-0134·0135 엔진+웹 양층 track 랜딩(#812~823). 대기: track→main 동기화(성재) → 라이브 통합 → next.10. **0136(E2B) 키 부재 확정 — 성재 조달 대기**(.env는 BLAXEL/DAYTONA만)(전환 시 SwiftUI 은퇴 수순). 잔여 비차단: #782 멤버 디렉터리·DM 시작. 구 표기: momo-next 발행 채널(Tauri updater)+parity 게이트 실측(릴리스 번들 keychain 왕복은 parity 런에 편입). 통합 교훈: 자동머지 의미적 파손은 typecheck가 잡는다(머지 직후 필수). 엔진 후속 후보: 승인 원장 created_at·전역 agent-run REST·realtime client_msg_id. 이하 이전:
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
> **2026-07-21 스냅샷**: 슈퍼앱 L5(개발자 콘솔) 진행 중. **main c953322 = track/engine = track/uxui 정렬**(이중트랙 머지 완료). **랜딩(main)**: 메신저 코어 전부(스레드·반응/수정삭제·검색·첨부·음소거·허들·푸시) + Interactive Work Console(ADR-0114 483/484/486 + A-10/A-11) + Host Fabric v0(ADR-0125 487·488·489) + **491 openssl·509 X-7 에이전트생성·511-E D10 attach capability** + macOS 512 focus fix + iOS v1 기반(496 아이콘·497 탭셸). **MOMO-512 차단 해소**(Fable 실디스플레이 real-window 4/4 확증). **진행 중**: 543(iOS 타임라인 v2) 게이트 PASS·시각 QA 후 랜딩 / 509·511 docker 런타임 verifier(runtime-unverified→verified) / iOS 499~506(모바일 플랜 승인 대기) / 511-U SwiftTerm attach UXUI. **T3**: ADR-0125 D3 기질=E2B 확정. momo Cloud 프로비저너=후속 ADR. 정본: docs/TRACKS.md·ENGINE_HANDOFF.md·QA_FOLLOWUP.md·research/17. JOURNAL 최신 우선.
> **2026-07-18 운영 정본 이동**: 트랙 파이프라인은 `docs/TRACKS.md`, 트랙 간 작업 큐는 `docs/planning/ENGINE_HANDOFF.md`가 정본이다. main `7e7b283`(UXUI A-1/2/3/5/7 + 엔진 음소거 MOMO-477·상호작용 MOMO-478 동시 랜딩) 기준 두 트랙 브랜치 모두 main과 일치. 아래 스냅샷 세부는 2026-07-16 기준으로 낡았다 — JOURNAL 최신 항목을 우선 신뢰.
> 기준일: 2026-07-16 · 기준선: **canonical main `05368ea` + PLN-20260716-01 Plugin Platform planning overlay** — Plugin Center·추천 onboarding·동적 capability discovery와 Drive reference vertical 후보를 조사했으며, 기존 GitHub-first 전략과 credential/runtime 경계를 바꾸는 구현은 성재 결정과 Accepted ADR 전까지 열지 않는다. Work v0(362..365)·unread(366/367)·ADR-0112 Wave A+MOMO-379 기반은 유지된다 · 통합 책임: `momo-main`
> 이 문서는 **컨텍스트 압축/세션 전환 후 가장 먼저 읽는 현재 상태 스냅샷**이다.
> 결정 근거는 ADR, 검증 증거는 STATUS, 일정은 ROADMAP이 정본이며 이 문서는 그 정본들을 연결하는 포인터다.

## 0. 3분 복원

- 제품 방향: momo는 채널 타임라인을 사람·에이전트의 실행/승인/비용/감사 원장으로 만드는 self-hosted agent messenger다.
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
- **런타임 미검증:** 실제 Codex와 momo 사이의 Work 실행 및 승인/resume 왕복은 아직 `runtime-unverified`다.
- **부분 구현:** 채널 히스토리 컨텍스트 조립 v1은 있으나 Context Broker/Context Packet의 권한·source·memory 실조립은 미완; inbound MCP는 skeleton/spec-to-code bridge 수준이다.
- **스펙만 정본화:** Google Workspace connector/enterprise consent(연구 스펙은 momo connector의 refresh token 암호화 저장을 제안하며, 구현 전 보안 경계 ADR 승인 필요), Plugin Manifest/catalog/repo split, Memory Plane/Capability Cache의 전체 런타임 저장·무효화.
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
| `ADR-0132` | 에이전트 상호작용 안전 계약(휴먼 정지권·루프 방어·발화 의무·실패 고지) | Fable | **`proposed`** | 성재 | buzz 상흔 4종의 momo 번역. D1~D5 option 승인 대기 — Accepted 시 H2(557→558, 559) 발급 |
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
- upstream Codex/OpenAI의 OAuth access/refresh token과 API key는 momo에 들어오지 않는다.
- momo runtime은 Hermes-facing bearer를 runtime secret으로 사용할 수 있다. upstream provider 자격증명과 혼동하지 않는다.
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
