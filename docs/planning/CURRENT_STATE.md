# oort 기획 현재 상태 (Planning Current State)

> **2026-09-09 스냅샷 95 (Fable · momo-main — ★E2E-B 케이스 B 폐곡선 PASS(설치→provider→Agent Port 합류→멘션 답장→2인 합류 킥오프). 실결함 D2·D10·D8/D11·D9·문서 묶음 전량 main 정본화. UX-R2c 잔여 폐곡선 정본화. 워커 0 · 체인 0.)** 컴팩트 복원 진입점.
>
> **★ 정본 헤드**: main `1184271f` · uxui `88ff8d0f` · engine `820382a7`. 정합 PASS.
> **★ 성재 결재(09-09)**: 재개 go(Fable 위주·타이트) · D9 생성 env 기본 `MOMO_HOSTED_DELIVERY_ENABLED=true`(정본화) · #1361 ready · E2E-A는 planner가 CDP/컴퓨터 제어로.
> **★ 막힌 것**: E2E-A 전송 — Claude Code 자동 모드 분류기가 Grok Bot 앱으로의 Enter(osascript·CDP 키 이벤트) 거부. 성재 결정 대기: Enter 1탭(메시지마다) 또는 `Bash(osascript:*)` 허용 규칙. 지시문은 컴포저에 스테이징됨(앱 :9333 유지 필요; 재기동 시 `open -a "Grok Bot" --args --remote-debugging-port=9333`).
> **★ 다음**: E2E-A 본 실행(설치→cloudflared 폴백 URL→claim 로그인(Chrome 도구)→SH-6a-w 자격 발급→페어링 값 붙여넣기→active→멘션 답장→Reset 복구) → ITO → G2(iOS v0·Railway 최종 검증·APNs). 잔여 후보는 저널 참조.
> **★ 재개 진입점**: `claudedocs/resume-2026-09-07/RESUME.md` · 체인 템플릿 `claudedocs/resume-2026-09-07/chain-templates/`(BEHIND 재확인·CONFLICTING ABORT·검증기 재시도 반영본은 세션 스크래치 `land-engine-audited-template.sh` — 복사 필요).

> 이하 스냅샷 94:
> **2026-09-09 스냅샷 94 (Fable · momo-main — ★G1'-2·G1'-3 전량 main 정본화: SH-6a-w(design-review R7 PASS)·SH-6a-e(ADR-0004 증보 Accepted)·#1265·SH-8·SH-9. UX-R2c #2216 워커 진행 중. 워커 1).** 컴팩트 복원 진입점.
>
> **★ 정본 헤드**: main `9dd350e1`(SH-6a-w 승격 ap) · uxui `857f3277` · engine `3d1923e2`. 이 문서의 승격 뒤 갱신.
> **★ 성재 결재(09-08 저녁)**: ADR-0004 증보 Accept · SH-8 #2230·SH-9 #2231 go(둘 다 정본화 완료) · Railway 실배포 E2E = 최종 셀프호스팅 검증 단계 · 실기기 APNs = 데스크톱 셀프호스팅 완료 뒤.
> **★ 다음**: UX-R2c 워커 완주 → planner 검토 + design-review(B0·H0) → uxui 랜딩·승격 → **G1'-4**(E2E-A: #1361 CDP 하네스 + 사람 Enter 1탭 / E2E-B: VPS·로컬 경로로 선행, Railway는 최종 단계) → ITO. 결정 대기: #1361 라벨 blocked→ready.
> **★ 잔여 후보(미발급)**: R7-N4 core `parseDisconnectStart` 가드 · 프리플라이트 `arbitrary_tw` 사각 · 선재 #2157·#2181·#2193.
> **★ 재개 진입점**: `claudedocs/resume-2026-09-07/RESUME.md`(체인 템플릿 `land-engine-audited-template.sh`: CONFLICTING 조기 ABORT·검증기 재시도).

> 이하 스냅샷 93:
> **2026-09-07 스냅샷 93 (Fable · momo-main — ★LS 시리즈 완결(LS-0~6) + SH-10 push relay Rust main 정본화. 추적 파일 3,416→2,491(−27%), md 107k→67k. 도는 것 없음, 워커 0).** 컴팩트 복원 진입점.
>
> **★ 정본 헤드**: main `47f4d6f0`(LS-3 승격 ak) · 이 문서의 승격 배치 am 뒤 갱신. 도는 것 없음.
> **★ 오늘 정본화**: ADR-0183 Accepted(결재 5+3) · LS-4·LS-0·LS-2·LS-1·LS-3 · LS-5(17 close) · LS-6 원장 #2187 · **SH-10 #1255**(셀프호스트 동봉 APNs relay Rust, 3 모드) · 1차 목표 두 케이스 문서(`2026-09-07-first-goal-two-cases.md`).
> **★ 2026-09-08 결재 반영**: 출시 정의 개정 확정(`2026-09-02-launch-program-plan.md` 개정 상자) · 실기기 APNs 실수신 **보류** · 남은 작업 지도 `2026-09-08-remaining-work-map.md`. **G1'-1 진행**: SH-5a 템플릿 main `03e90c4c`(실배포 E2E는 G1'-4 시점, Railway 로그인 필요 — 성재 「필요하면 다음 작업」) · SH-6a-w PR #2214 design-review **R3 FAIL(B1·H1·M2·N5)** → R4 워커 가동(09-08 오전). **G1'-2 패킷 main**(`bbb00168`): SH-6a-e #2215 · UX-R2c #2216 · #1265 — 엔진 쌍 go 대기(런처 `launch-g1-2-engine.sh` 자가 복구), UX-R2c는 #2214 랜딩 뒤.
> **★ 선재**: #2157·#2181·#2193. 미발급 후속: UX-R2c · #1265 · SH-6a-e · SH-8 · SH-9.
> **★ 재개 진입점**: `claudedocs/resume-2026-09-07/RESUME.md`.

> 이하 스냅샷 92:
> **2026-09-07 스냅샷 92 (Fable · momo-main — ★LS-β 완결: LS-1(Swift 은퇴)·LS-2(클라 이중 정본) main 정본화, LS-5 이슈 위생 17 close. 추적 파일 3,416→2,502. LS-γ 패킷 발급(LS-3 #2182 ∥ SH-10 #1255), 발사 go 대기. 워커 0).** 컴팩트 복원 진입점.
>
> **★ 정본 헤드**: 이 문서 PR 뒤 main=8bd05806(LS-1 승격 ai) · 이 문서의 승격 배치 aj 뒤 갱신. 도는 것 없음.
> **★ LS 누계**: LS-0(게이트 재배선)·LS-4(문서 로테이션)·LS-1(Swift 4트리·infra/prod·Swift e2e·workd·PushRelay 소스)·LS-2(web-legacy·mobile-spike·work 표면 숨김)·LS-5(이슈 29건 판정) 완료. 남은 LS-3(#2182: 은퇴 문서 삭제·INDEX/README 재작성·Codex 일반화·G3 문서·ncp 런북 회전 절 → SELF_HOST 이식, 정책 감사) · LS-6(비대 파일 티켓 발행, planner).
> **★ 1차 목표 파도 시작**: SH-10 #1255 momo-push-relay Rust(같은 이미지·`push` 프로파일·Dawn 공용/자체 키/stub) 패킷 발급 — G1'-2를 앞당겨 LS-3과 병렬. 그 뒤 SH-6a ∥ SH-5a → UX-R2c ∥ #1265 → SH-8 ∥ SH-9 → E2E-A(CDP)·E2E-B → ITO.
> **★ 성재 결재 대기**: G2 = 외부 셀프호스터 3 + **iOS 앱스토어 v0**(`first-goal-two-cases.md` §7). 선재 이슈: #2157(pgbackrest 시험) · #2181(gate:csp-deploy 템플릿).
> **★ 재개 진입점**: `claudedocs/resume-2026-09-07/RESUME.md`(발사 `launch-ls-gamma.sh`, 미션 `mission-ls3.md`·`mission-sh10.md`).

> 이하 스냅샷 91:
> **2026-09-07 스냅샷 91 (Fable · momo-main — ★클린 슬레이트 D-0 → ADR-0183 Accepted → LS-α 완결(LS-4·LS-0 main 정본화, 파일 3,416→2,927) → LS-β: **LS-2 main 정본화** · **LS-1 PR #2177 R2 대기** · 결재 3건(SH-10 push relay Rust 승격 · CDP 로컬 허용 · iOS 앱스토어 의도). **안전 중단 19:1x — 재개는 `claudedocs/resume-2026-09-07/RESUME.md` ★절**).** 컴팩트 복원 진입점.
>
> **★ 중단 시점 상태**: 워커 0 · 열린 PR #2177(LS-1, R2 2건: engine 합류 충돌 해소·`gate-csp-deploy` 대상 교체) · 추적 파일 3,416→2,616(LS-1 랜딩 시) · 다음: LS-1 R2 → 감사 랜딩·승격 → LS-3 패킷 + SH-10 브리프 → 스냅샷 92 → 출시 계획 개정(§7 성재 확인).
>
> **★ 밤 결재(성재)**: ①셀프호스팅 레벨 폰 푸시 포함 → #1255=SH-10 momo-push-relay Rust(같은 이미지·3 모드), G1'-2 승격, LS-1은 Swift relay 소스만 삭제 ②그록봇 계정 살아 있음 + 로컬 테스트 CDP 허용 → E2E-A 자동화 ③iOS 앱스토어 v0 의도 → G2 개정 제안(`first-goal-two-cases.md` §7, 확인 대기). 가동: LS-1(`wls1`, 정정 재개)·LS-2(`wls2`).
>
> **★ 갱신(저녁)**: LS-4 → main `e1975ce9`(문서 −399) · LS-0 → main `6ed61cfb`(scripts 265→168, CI 레인 5→4, web 프로파일=clients/web) — 둘 다 R2 회전(LS-4: 정본·코드 인용 16본 복원+규칙 확장 / LS-0: 문서 명령 게이트·PATH 결정성·ncp 런북 유지). 교훈: 정책 파일 변경은 track·승격·sync PR 셋 다 감사. 선재 #2157. 다음: go → `launch-ls-beta.sh`(LS-1 engine `wls1` ∥ LS-2 uxui `wls2`) → LS-3 → 스냅샷 92.
>
> **★ (완료) LS-α**: LS-0 #2142 · LS-4 #2143 랜딩·승격·close.
> **★ 1차 목표 구체화(성재 지시 「두 케이스 모두 커버」)**: `docs/planning/2026-09-07-first-goal-two-cases.md` — A 그록봇 VM(Funnel·`/workspace`·dial-in 합류·Reset 복구) · B 독립 셀프호스팅(Railway/VPS·hermes=설정 › AI 연결·Claude Code/Codex=Agent Port 자격). E2E 2본 수용기준 · 갭 8 · **G1' 확정**: SH-6a∥SH-5a → #1265∥UX-R2c → SH-8∥SH-9(hermes 런북 현행화) → E2E-B∥E2E-A(#1361, 성재 손) → ITO. 연기: 팔레트·DS-1 잔여·R2d·허들·TURN. 결정 3: 재편성 확정 · work 표면 숨김(LS-2) · G3 문서 삭제(LS-3, external-agent-provider 보존).
>
> **★ 갱신(오후)**: 결재 = Accept + 5건 권고안 + **초점 지시(셀프호스팅·그록봇 연동)** → `docs/planning/2026-09-07-lightening-program.md`(§1 초점 점검표: LS-0·1·3 직접 기여, LS-2·4·5 간접 · §4 출시 잔여 재편성 제안 · §5 질문 3: 팔레트·DS-1 연기 승인 / work 표면 숨김 / G3 문서 삭제). 브리프 2본 + 이슈 #2142·#2143 + 워크트리 `wls0`·`wls4`. 다음: go → LS-0 ∥ LS-4 발사(병렬 2) → LS-0 랜딩 시 정책 감사 승격 → LS-1·LS-2 패킷 발급.
>
> **★ 지시(성재 2026-09-07)**: 「clean slate — 불필요한 문서·Swift 코드 같은 레거시를 걷어내고 코드베이스·문서 경량화, 남은 작업도 그 기반으로 재설계」. 계획 `claudedocs/resume-2026-09-07/PLAN-clean-slate-diagnosis.md`(§0 불변 · §3 판정 A~E · §4 D-0~D-3).
> **★ 산출**: `docs/planning/research/2026-09-07-clean-slate-inventory.md` · `2026-09-07-clean-slate-candidates.md` · **ADR-0183**(Proposed — D1 정본 목록 · D3 증보 1 삭제 게이트→출시 범위 판정 · D4 Swift 삭제 · D5 이중 정본 · D6 로테이션 · LS-0 게이트 재배선(정책 감사 1회) → LS-1 Swift ∥ LS-2 클라 → LS-3 문서 ∥ LS-4 로테이션 → LS-5·6).
> **★ 실측**: 파일 3,416 · 코드 ≈768k · md 107k → 후보 ≈870 파일(25%)·≈203k LOC(23%). Swift 4트리 222/78k(local_gate swift+runtime 7 프로파일·verifier 66본이 붙듦, 병합 권위 0, 30일 실사용 0) · web-legacy 26.8k(CI 레인 1·web 프로파일) · mobile-spike 19.6k · infra/prod SQL 4본은 Rust 이미지 COPY(이전 필요) · handoffs 196 · research 비인용 ≈160.
> **★ 성재 결정 포인트(Accept 시)**: ①PushRelay 지금 삭제(권고) vs #1255 유지 ②workd/T3 데몬 삭제(권고, Rust momo-t3·웹 표면 유지) vs 유지 ③`research/` ADR 인용분만 ④`claudedocs/` gitignore ⑤LS-0 정책 감사를 planner 자율 집행에 포함.
> **★ 다음**: Accept → `docs/planning/2026-09-07-lightening-program.md`(LS 티켓 수용기준+브리프+이슈, G1/G2 잔여 재편성 = 출시 계획 개정) → LS-0 ∥ LS-4 발사(go) → … → 스냅샷 92. G1 잔여(UX-R2c·R2d·R3a~c·DS-1·SH-5a·SH-6a)는 LS 파도 뒤 경량화된 기반에서 재편성.

> 이하 스냅샷 90:

> **2026-09-06 스냅샷 90 (Fable · momo-main — ★W3 파도 1 완결: 엔진 레인 4/4(SH-2·SH-4a·SH-4b·SH-3b) + UXUI 안정화 ST-1 랜딩·승격. 셀프호스팅 문서 정본 3본 영문화·공개 엣지·day-2 CLI main 정본화).** 컴팩트 복원 진입점.
>
> **★ 결재(성재 2026-09-06)**: 「셀프호스팅 런칭 준비 마무리?」 → 아니오(출시 정본 게이트: W2 끝/엔진 W1 중간 → G1은 W3 뒤, G2는 W4~W5 뒤) → **권장 순서 채택: 엔진 우선 + UXUI 소형 안정화**, 「시작하자」 go.
> **★ 엔진 레인(planner 검토, 병렬 1 순차)**: **SH-2 #1926**(PR #2110, R1→R2→R3: 공개 엣지 env 2키 템플릿 `{$OORT_SITE_ADDRESS}`/`{$OORT_CSP_CONNECT_SRC}`, compose `:?` 거부=ACME 오발사 차단, `--public-origin` 파생(LiveKit 오리진 포함)·와일드카드 거절, `Caddyfile.local` centrifugo deny, boundary 검증기 플레이스홀더 해석, 은퇴 런북 링크 교체) → 승격 u #2111(정책 감사 5파일). **SH-4a #2104**(PR #2115: `SELF_HOST_AGENT.md` 영문 하네스 불가지론 정본 + 환경 분기 표 7열 + doctor 게이트 + `.ko.md` 절 44 동일 + `llms.txt` 일반화 + **Local 설치 실측 개입 0 doctor PASS**) → 승격 v #2116. **SH-4b #2105**(PR #2119: README 「Paste this into your agent」 4줄 + `SELF_HOST`·`FIRST_DAY` 영문 정본+ko, 링크 134/0) → 승격 w #2120. **SH-3b #2103**(PR #2123, R1→R2→R3: `scripts/oort` status·logs·upgrade·backup/restore·member + 하네스 10/10·15/15 + **업그레이드 왕복 실측**(N=5 보존, doctor PASS 29/0/2, restore roles 선행 exit 0) + doctor outbox 오라클 릴레이 부재 처리) → 승격 x #2125(정책 감사 6파일). **정본 main=6d42c1b4·uxui=7df6341e·engine=650d9d4e**, alignment PASS.
> **★ UXUI 안정화 ST-1 #2050**(PR #2114, design-review R1 FAIL B2·H3 → R2 FAIL B1·H1 → R3 FAIL B0·H1 → R4 FAIL B0·H2 → R5 FAIL B0·H1 → R6 PASS(B0·H0·M2·N4)): 바닥 동시 도착 상한 3(`MAX_SIMULTANEOUS_ARRIVALS`, live `message.new` 한정) · 백로그 캡 렌더 가드(P5 빨강) · `Timeline.burst` 결정성(부하 30회 0/30 두 케이스; CI 플레이크 원장 #2050 7회 중 4회 → 원인) · **캡처 시계 고정**(`FIXTURE_NOW`·`pinPageWallClock` — intro 장면 비결정의 진짜 원인은 렌더된 벽시계, 호버 툴바 설명은 거짓) · intro 정착 술어(3프레임, 상한 60) · 오프너 grant 핀(UX-R2b 보호). 랜딩 #2114 → 승격 y #2131 + sync #2132/#2133.
> **★ 발행·정리**: #2124(정책 파일: local_gate 허용목록에 `scripts/oort`·하네스, `check_docs_commands` GATED_DOCS 영문 SELF_HOST/FIRST_DAY) · #2130(ST-1 잔여·선재 비결정 장면) · #1926·#2103·#2104·#2105·#2050 close. DEVIATION 3행 `accepted`(SH-2 게이트 본체 해제 / SH-3b outbox 완화 / ST-1 수용 기준 재정의). PIPELINE §3: 미션 게이트 목록 명시·체인 산출물 검사.
> **★ 교훈(89에 추가)**: ⑳워커가 안 돌린 게이트는 랜딩에서 터진다 — 미션 게이트 목록을 접촉 범주별로 박는다(SH-3b R3 `@sha256:` 플레이스홀더) ㉑템플릿화가 게이트 파서를 깨면 같은 PR에서 게이트를 따라 올린다(SH-2 R2) ㉒오라클은 배포 형상을 알아야 한다(릴레이 없는 셀프호스트의 outbox) ㉓브리프의 수용 숫자(「전 장면 sha 5회 동일」)는 레인 실태(벽시계) 실사 없이 쓰면 달성 불가 — 검수가 원인을 픽셀 diff로 잡았다 ㉔체인 스크립트 산출물 검사·PR 번호 색인 지연 ㉕엔진 레인은 planner 검토(코드 diff·게이트 원문·red proof)만으로 4건 R1~R3에 랜딩 — UXUI 폐곡선보다 회전이 짧다.
> **★ 다음(성재 결재)**: G1 잔여 = UX-R2c·R2d·R3a~c + DS-1(·3·4) + P2 + SH-5a(Railway E2E, SH-2 키 소비) — 다음 파도 편성 후보: UXUI W3(R3a 팔레트 L·R2c 퍼널 L·R2d S·DS-1) + 엔진 SH-5a·SH-6a · 후속 #2124·#2095·#2091·#2076·#2080·#2074·#2075·#2048·#2090.

> 이하 스냅샷 89:
> **2026-09-05 스냅샷 89 (Fable · momo-main — ★W1 uxui 3차 파도 완결: UX-R2a(2회전+CI 미니)·UX-R2b(R1 FAIL B2·H4 → R2 FAIL B0·H1 → R3 PASS(B0·H0·M2·N4)) 폐곡선 랜딩 + 승격 q·r. W1 uxui 8건 전부 main 정본화).** 컴팩트 복원 진입점.
>
> **★ 랜딩(전부 design-review 폐곡선, Opus 5 검수)**: **UX-R2a #2088**(온보딩 S3 표시 이름 스텝, **R1 FAIL B0·H4**(건너뛰기 스텝에 「필수」·실패 배너의 가짜 재시도·포커스 body·공유 규칙이 서버 규칙 양방향 오기) → **R2 PASS**(다시 시도=현재 초안·편집 시 저장 복귀·aria-busy·규칙=서버 미러 ≤100·마커 join 성공 시 1회[리로드 생존 실측]·홀드 해제 구조+시험·배너 장면 캡처) → R3 CI 시크릿 스캔 미니(UI 무변경)) → uxui `9f497f26` → **승격 q #2092** + sync #2093/#2094 → main `15e6e3e2`. **UX-R2b #2089**(웰컴 킥오프 스테이지, **R1 FAIL B2·H4**(로스터 로딩 전 마운트 판정 동결 → 에이전트 메시지 위 스테이지·백스톱 / 백스톱이 마커 미소거 → 리로드마다 재생 / exit fill backwards 되튐 / 「설정 › 에이전트」 부재 / 스테이지 중 CTA 동거 / 자기참조 시험 숫자 게재) → R1 FAIL B2·H4 → R2 FAIL B0·H1 → R3 PASS(B0·H0·M2·N4)) → **승격 r #2096** + sync #2097/#2099 → **main=831315ae·uxui=2ce432c2·engine=282a53f7**, alignment PASS.
> **★ 발행·정리**: **#2090** 폰 패리티(R2a R1 M-5: 폰이 `createdMember` 무시·S3 없음·마커 미기록) · **#2091** R2a R2 잔여(재시도 online 무시·이중 제출 가드 무시험·`createModel.ts` 규칙 중복·Nit 8) · #2095 R2b 잔여 · #2057에 capture 레인 N-4 중단 빈도 보고(3브랜치·검수 2/2 — 단독 수리 후보) · #2001·#2002 close. DEVIATION 2행 `accepted`(R2a 상한 80→100 서버 미러·마커 시점 / R2b 백스톱 표면=nav 상수·exit both).
> **★ 사고 2건 + 교훈(88에 추가)**: ⑮**런처 Bash 태스크 정지 → 같은 프로세스 그룹의 nohup 워커 2기 사망**(rc 미기록, 감시 침묵) — spawn은 `start_new_session=True`(setsid) 세션 분리(`spawn-worker.sh`), 감시는 프로세스 부재도 이벤트, 재개는 `--continue` + 재개 노트 파일(PIPELINE §3 반영) ⑯**planner 이음새 파일이 gitleaks 오탐**(`KEY` 식별자에 슬롯 이름 `oort.freshSignup.v1`을 바인딩한 줄 → generic-api-key) → 두 PR CI 빨강 → 이음새 v2(`SLOT` + 이유 주석) + `.gitleaksignore` 지문 트리아지(#1224 방식); CI는 **커밋 범위 스캔**이라 이름 변경만으론 옛 커밋 지문이 남는다 ⑰병렬 두 브랜치의 공유 파일은 **동일 바이트 추가**로 무충돌 병합(이음새 관례, prettier 결정성으로 수렴) ⑱브리프의 숫자(80자)·표면명(「설정 › 에이전트」)은 서버·nav 정본 실사로 검증 — 클라 규칙은 정본의 사본, 표면명은 nav 상수에서 파생 ⑲워커 R1 상습 축 재확인: 「하네스 참·제품 거짓」(자기참조 exit→arrival 시험)·「실패 불가 단정」·**로딩 중 판정 동결**(비동기 데이터가 settled 되기 전 결정) — 미션에 「판정은 settled 데이터에서만」 상설.
> **★ 다음**: W1 uxui 파도 완결 → 다음 파도 편성(후보: #2057 N-4 capture 레인 단독 수리 · #2091 · #2076 · #2080 N-1/N-2 · #2074 · #2075 · #2048 · #2090 폰) · ITO(G1) 준비 · 성재 결재: 다음 파도 구성.

> 이하 스냅샷 88:
> **2026-09-05 스냅샷 88 (Fable · momo-main — ★W1 uxui 2차 파도 완결: UX-R1e(7회전)·UX-R1b(10회전+병합) 폐곡선 랜딩 + 승격 n·o. 잔여 uxui = R2a·R2b(ready, go 대기)).** 컴팩트 복원 진입점.
>
> **★ 랜딩(전부 design-review 폐곡선, Opus 5 검수)**: **UX-R1e #2071**(눌림 전수 + 원장 + 3짝 캡처, **7회전** — R1 컨테이너 press 미끄러짐 → R2 summary 카드 밖·다크 토큰 그릇 띠 → R3 라이트 토큰이 accent-soft와 같은 재료(「가족」 면제는 정본 밖) → R4 원장 인구 마커 기반·cmdk 미도색·전폭 문구 거짓 → R5 전폭이 클래스 토큰·early return → R6 샷 이중 writer·무효 hover → **R7 PASS**: 인구 태그/role N0=477·잔량 11·미눌림 0, `--surface-pressed` `light-dark(#efe2c8, #262335)`, 와이드 행 채움만(런타임 프로브), 3짝 102장) → uxui `42ab25cb` → **승격 n #2077**. **UX-R1b #2072**(드로어·스레드·⌘K enter/exit + `motion/react` 첫 소비자 + `motion_lib_scope`, **10회전** — R1 스레드 앵커 죽은 창·레드 증명 초록 → R2 `motion-dom` 우회 → R3 하우스 Dialog 닫힘 오버레이가 Radix 인라인 pe:auto로 첫 클릭 삼킴(#2073) → R4 인라인+컨텍스트 → `!` 클래스 → R5 forceMount 제거가 가드 무력화 → R6 hunk가 팔레트 영구 마운트 → R7 가드가 떨어진 노드 샘플 → R8 측정 없는 「우회」 진단 → R9 forceMount 주석 모순 → **R10 PASS** → R11 트랙 팁 병합(코드 충돌 3파일 해소, 병합 검수 PASS)) → uxui 810706cf → **승격 o #2081**(보호 경로 `scripts/design_preflight_web.sh` 3커밋 정책 감사) + sync #2082/#2083 → **main=0bef6bf4·uxui=810706cf·engine=183bfb5b**, alignment PASS.
> **★ 발행·정리**: #2076(R1e R7 잔여: 폭 규칙 정의 통일·390 CTA·shrink-0·인구 477·instant-fill 전이) · #2080(R1b R10 잔여) · #2073 close(#2072 랜딩) · #2074(`!` 계수) · #2075(UnreadPill이 스크림 위, 선재) · #2050 플레이크 원장 갱신. DEVIATION 2행 `accepted`(390 드로어 fast·⌘K 하우스 Dialog / 본문 행 채움만) + ADR-0179 D1 정오표.
> **★ 교훈(87에 추가)**: ⑪워커 상습 축 두 개가 이번 두 티켓을 지배했다 — **「하네스에서 참, 제품에서 거짓」**(R1a·R1b·R1e 전부 첫 회전)과 **「실패할 수 없는 단정」**(사본 컴파일·부분문자열 핀·마커 인구·떨어진 노드 샘플·측정 없는 진단) — 미션에 「인구는 태그/role·가드는 정의·모든 return·연결된 노드·관측한 경로만」을 상설 ⑫수리가 수리를 부르는 사슬은 매 회전 「전 회전 수리가 만든 회귀 먼저」로 잡혔다(R1b R6 hunk·R1e R2 팝) ⑬브랜치 보호 「base 최신」: 랜딩 전 트랙 팁 병합 필수(코드 충돌이면 워커 병합 미션 + 병합 한정 검수) ⑭병합 트리 게이트 플레이크는 #2050 원장에 기록 후 재실행.
> **★ 다음(go 대기)**: UX-R2a #2001 · UX-R2b #2002(uxui, 병렬 2) · ITO(G1) 준비 · 후속 #2076·#2080·#2074·#2075·#2057.

> **과거 스냅샷은 `docs/planning/archive/CURRENT_STATE-snapshots.md`로 이동(로테이션 — 규칙은 아래 절).**

## 이 문서 갱신·로테이션 규칙

- 이 문서는 **컨텍스트 압축/세션 전환 후 가장 먼저 읽는 현재 상태 스냅샷**이다. 결정 근거는 ADR, 검증 증거는 STATUS, 계획은 ROADMAP이 정본이며 이 문서는 포인터다.
- `momo-main`만 canonical `main`의 이 파일을 갱신한다. planner는 변경 제안을 자기 planning branch/ADR에 남긴다.
- 갱신 시 새 스냅샷을 맨 위에 추가하고(기준일·기준 커밋·활성 레인·다음 체크포인트 포함), **최근 6개만 유지** — 초과분은 월초 플러시 때 `docs/planning/archive/CURRENT_STATE-snapshots.md` 맨 위에 원문 그대로 이동한다.
- 세션 종료 시 `JOURNAL.md`에 5줄 이내 checkpoint를 남긴다. 채팅에만 남은 결정/할 일은 존재하지 않는 것으로 취급한다.
- 빠른 복원은 `scripts/planning_context.sh`(GitHub 실시간 상태는 `--github`).
