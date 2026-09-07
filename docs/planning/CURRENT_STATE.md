# oort 기획 현재 상태 (Planning Current State)

> **2026-09-07 스냅샷 91 (Fable · momo-main — ★클린 슬레이트 D-0 진단 완료: 인벤토리·후보·ADR-0183 Proposed. 성재 결재 대기, 워커 0).** 컴팩트 복원 진입점.
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

> 이하 스냅샷 87:
> **2026-09-04 스냅샷 87 (Fable · momo-main — ★결정 4건 집행 + W1 uxui 2차 발사 준비 완료(go 대기). 세션 안전 중단 체크포인트 = `claudedocs/resume-2026-09-04/RESUME.md`).** 컴팩트 복원 진입점.
>
> **★ 성재 결정(2026-09-04)**: ①**#2050 N-2 = 바닥 동시 도착 상한 3**(초과분 즉시 정착, stagger 기각) → ADR-0179 D3 정오표 + #2050 수용 기준 갱신 ②W1 uxui 2차 발사 순서 권고 확인(**R1e + R1b 먼저**, 그 뒤 R2a·R2b) — **발사는 go 신호** ③**#2057 확정**: 페이드 창은 Δh로 늘리지 않음, 상한은 이징 기반 단일 규칙 ④7월 DEVIATION pending 3건 위임 판정: MOMO-412 → **아직 유효**(JWT_HMAC 폴백이 셀프호스트 기본값) → **#2066** 발행·`accepted` / MOMO-471·474 → macOS 표면 은퇴로 소멸 → `noted`·#495 close. 정정: 출시 프로그램 계획 머리글(ADR Accepted).
> **★ 발사 준비(go 대기)**: 워크트리 `momo-worktrees/wuxr1e`(`feat/uxr1e-press-sweep`)·`wuxr1b`(`feat/uxr1b-panel-motion`) @ uxui `51f32202`, node_modules 설치, 미션 `claudedocs/resume-2026-09-04/mission-uxr1e.md`·`mission-uxr1b.md`(브리프 계약 + 「숫자로 잴 것」 + skipIf 형제 형태 + 판정 금지). 포트: R1e 8637/8639 · R1b 8625/8627. R1b는 `scripts/design_preflight_web.sh` 카테고리 1개 추가(`motion_lib_scope`)를 **별도 커밋**으로 — 승격 시 정책 감사 대상.
> **★ 정본 헤드**: 스냅샷 86 체인 뒤 main=d46e90e9·uxui=51f32202·engine=846870c1(이 문서 PR 이후 갱신). 도는 것 없음.
> **★ 다음**: go → R1e·R1b 워커 발사(병렬 2) → design-review 폐곡선 → 랜딩 → 승격 n(R1b의 보호 경로 감사 포함) → R2a·R2b → ITO(G1).

> 이하 스냅샷 86:
> **2026-09-04 스냅샷 86 (Fable · momo-main — ★W1 uxui 1차 파도 완결: UX-R1c 5회전 폐곡선 랜딩 + 승격 배치 m → R1a·R1c·R1d·DS-2 전부 main 정본화. 잔여 = R1e·R1b·R2a·R2b(전부 ready, 발사 go 대기)).** 컴팩트 복원 진입점.
>
> **★ 랜딩**: **UX-R1c #2045**(스켈레톤 blur 크로스페이드 `Skeleton` 래퍼, **5회전** — R1 B2·H3(죽은 공간 76px·제품 결속 0·펄스) → R2 B1·H2(CI throw 상시 빨강·런타임 3회 초록·Inbox 비로딩) → R3 H1(**R2 수리가 만든 회귀**: 정착 250ms 뒤 152→104 / 136→60px 컨테이너 팝, 빈 상태 8표면) → R4 H1(**R3 수리가 반쪽**: 늘어남 +14/+224px 한 프레임 — `from`을 커밋 후 셀에서 재 `needsSize` false, 가드는 플립 다음 rAF부터 샘플해 maxStep=0) → **R5 PASS**: `from`을 `ready=false` 동안 저장 + `useLayoutEffect` 잠금, 샘플 먼저→플립 가드, 검수자 32트레이스 양방향 검증(플립 직후=플립 전, 정착 후 Δ0, host==content), cap 64 이탈은 「정직 — 상한 모양만 교정」 판정) → uxui `e0b03442`. 워커 1회 Cursor `[resource_exhausted]` 사망 → `--continue` 재개(수리 커밋 보존, 게이트·PR 본문·푸시만 이음).
> **★ 승격 배치 m**: #2058(uxui→main) — 첫 시도가 「main is ancestor of both tracks」에 걸림(스냅샷 85 승격 #2055의 머지 커밋이 engine에 없었다) → sync #2059(engine m0) 선행 후 검사 재실행 → 머지 + sync #2060(engine m) → **main=f8cc7754·uxui=e0b03442·engine=0bd1b8a9**(uxui는 이 문서 체인의 sync n에서 정합). 보호 경로 변경 0.
> **★ 발행**: **#2057** UX-R1c R5 잔여(상한 12/30/64 세 숫자 + 64는 120Hz 값(48Hz 빨강) → **이징 기반 단일 규칙** `step ≤ Δtotal·y(Δt/240)·margin`, 페이드 창은 Δh로 늘리지 않음(검수 권고 채택) · Sidebar 2차 래핑 소스 결속 · grow 위→아래 리빌 무기록 · 부하 선언 7개 무보호 · capture intro 선재 플레이크 2/5).
> **★ 정정**: PIPELINE §3 재개 플래그 `-c` → **`--continue`**(cursor-agent 2026.09.02에서 `-c`=폐기된 `--cloud`, 즉시 exit 1). 승격 뒤 sync는 **소스 트랙에도**(머지 커밋) — 두 트랙 모두 main을 조상으로 둔 뒤 다음 승격.
> **★ 교훈(85에 추가)**: ⑧수리가 수리를 부르는 사슬(R2→R3→R4)은 매번 「끝 상태는 옳고 **구간/방향**이 빠진」 모양 — 검수 프롬프트에 「이전 수리가 만든 회귀를 먼저 찾아라」 상설 ⑨per-case 숫자 상한은 프레임레이트에 묶인다 — 이징 함수에 대고 단정 ⑩워커 stdout 절단·접속 끊김·API 소진은 상시 — 보고 정본은 PR 본문, 감시는 rc 파일, 재개는 `--continue`.
> **★ 다음(go 대기)**: UX-R1e #2000 · UX-R1b #1997 · UX-R2a #2001 · UX-R2b #2002(uxui, 병렬 2) · 성재 결정 #2050 N-2(바닥 동시 도착 상한) · ITO(G1) 준비.

> **과거 스냅샷은 `docs/planning/archive/CURRENT_STATE-snapshots.md`로 이동(로테이션 — 규칙은 아래 절).**

## 이 문서 갱신·로테이션 규칙

- 이 문서는 **컨텍스트 압축/세션 전환 후 가장 먼저 읽는 현재 상태 스냅샷**이다. 결정 근거는 ADR, 검증 증거는 STATUS, 계획은 ROADMAP이 정본이며 이 문서는 포인터다.
- `momo-main`만 canonical `main`의 이 파일을 갱신한다. planner는 변경 제안을 자기 planning branch/ADR에 남긴다.
- 갱신 시 새 스냅샷을 맨 위에 추가하고(기준일·기준 커밋·활성 레인·다음 체크포인트 포함), **최근 6개만 유지** — 초과분은 월초 플러시 때 `docs/planning/archive/CURRENT_STATE-snapshots.md` 맨 위에 원문 그대로 이동한다.
- 세션 종료 시 `JOURNAL.md`에 5줄 이내 checkpoint를 남긴다. 채팅에만 남은 결정/할 일은 존재하지 않는 것으로 취급한다.
- 빠른 복원은 `scripts/planning_context.sh`(GitHub 실시간 상태는 `--github`).
