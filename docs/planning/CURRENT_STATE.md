# oort 기획 현재 상태 (Planning Current State)

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

> 이하 스냅샷 85:
> **2026-09-04 스냅샷 85 (Fable · momo-main — ★W1 3차 랜딩: UX-R1a·UX-R1d 폐곡선 랜딩 + DS-2 승격, 배치 l. UX-R1c는 R4 수리 중. 레인 = Fable planner + Opus 5 검수 + Cursor grok 4.6 워커).** 컴팩트 복원 진입점.
>
> **★ 레인(성재 2026-09-04 「Fable + opus5으로 가자」)**: planner/momo-main = **Fable**, design-review 서브에이전트 = **Opus 5**(`model: opus`), 워커 = **Cursor CLI grok 4.6 non-fast**(정본 PIPELINE §1·§3). 병렬 2는 **워커+검수 합산**(dwell ms·프레임 수·버스트 재생 같은 타이밍 측정이 CPU 경합에 흔들린다). 재개 체크포인트는 `/tmp` 스크래치가 아니라 **repo**에 — 이전 세션(Opus5)의 RESUME.md는 `claudedocs/resume-2026-09-03/`로 보존.
> **★ 랜딩(전부 design-review 폐곡선)**: **UX-R1a #2043**(모달·팝오버·드롭다운·컨텍스트메뉴 enter/exit 비대칭, **2회전** — R1: 「다섯 제품 다이얼로그의 닫힘 애니메이션이 한 번도 돌지 않음」(`{open && <DialogContent/>}`가 Radix Presence보다 먼저 언마운트, 하네스만 150ms — 문서 3곳이 하네스 숫자를 제품 실측처럼 기재) + 「측정 파일이 브라우저 없으면 통과」 → R2 PASS: 제품 실측 12~20 closed frames / 173~193ms, 브라우저 없이도 wiring 단정 빨강) → uxui `8f607b26` · **UX-R1d #2042**(메시지 도착 모션, **4회전** — R3: 「같은 틱 버스트가 가상화 경로에서 1/3」(react-virtuoso가 다음 커밋에 마운트, paint-tick 캡 `useEffect`가 그 사이 grant를 먹음; 하네스는 가상화 없이 3/3) → R4 PASS: grant는 행 마운트까지 생존, 검수자 프로브 3/3·5/5·10/10, 백로그 스크롤업 0 → 바닥 점프 1, R5 생존 뮤테이션은 측정으로 무결함 판정) → uxui `cf70d743`. **UX-R1c #2045**: R2 FAIL(B1·H2 — `skel.test.ts`가 Chromium 없으면 throw → CI 상시 빨강, 옳은 답 `skipIf`가 형제 파일 40줄 옆에; 런타임 이중 크로스페이드 3회가 2483 초록; Inbox 프레임이 로딩 아님) → R3 워커 → R3 FAIL(B0·**H1**: 막대를 흐름에서 빼는 R2 수리가 **정착 한 프레임 뒤 152→104 / 136→60px 컨테이너 팝**을 만듦 — 팝을 콘텐츠에서 컨테이너로 옮겨 원인보다 250ms 늦춘 꼴, 빈 상태 8표면) → **R4 수리 중**(기획 결정: 높이 변화가 페이드와 같은 사다리를 탄다 — 프레임당 ≤12px·정착 후 0px 단정, 9호출부 실마운트 결속, `measure/**` lint·typecheck 편입).
> **★ 승격 배치 l**: #2051(uxui→main: DS-2 #2020·UX-R1a·UX-R1d) + sync #2052(engine)·#2053(uxui) → **main=d584e95c·uxui=c9ec58c7·engine=ab6a2ba7**, alignment PASS. 보호 경로 변경 0(감사 불요).
> **★ 발행 티켓**: **#2048** DS-2 `MOTION_VOCABULARY` 손수 목록이 10개 유틸리티 중 `enter-conversation`·`scrim-blur` 누락, 전수 미측정 · **#2049** UX-R1a R2 잔여(여섯째 확인 다이얼로그 `AgentHubRoute` 메모리 무효화 `open` 상수 true → exit 불가 · 마운트 가드가 정규식 한 모양(삼항·early return 초록) · 항상-마운트 시 opener 폴백 `<body>` 고정(명시 복원 하나만 지우면 포커스 BODY, 두 엔진) · 메뉴→다이얼로그 첫 Escape 1프레임(6/8 vs 0/8) · `measure/`가 lint·typecheck·프리플라이트 밖) · **#2050** UX-R1d R4 잔여(스크롤업 백로그 캡 가드가 렌더를 안 탐 — sweep deps `[]` → 스위트 2512 초록인 채 제품 43/50 캐스케이드 · **성재 결정 항목: 바닥 동시 도착 상한**(10건이 뷰포트 절반을 동시에 blur, 규칙 위반 아님) · AST dead-binding · capture wait 무보호 · 플레이크 1/90). 개방: #1997 UX-R1b · #2001 UX-R2a · #2002 UX-R2b(전부 ready).
> **★ 교훈**: ①검수 스크래치 사본의 `.git` 파일이 실제 워크트리 gitdir을 가리킨다 — 사본 생성 직후 삭제(검수 프롬프트 상설) ②`pgrep -f`는 워커 프로세스 명령줄에 실린 **미션 전문**에 매치한다(랜딩 프리플라이트 false positive) — argv로 판별 ③루트 체크아웃의 폰 `node_modules`가 낡아 사후 게이트만 붉었다 — 병합 트리 게이트는 **빌려 쓰는 node_modules의 신선도**에 의존; 8레인은 이 머신에서 ~30초(웹 2474/7.5초, 폰 1320) ④워커가 형제 파일의 `skipIf` 형태를 두고 throw를 골라 CI가 구조적으로 붉었다(「옳은 답이 옆에 있었다」 코퍼스 최다 패턴) — 미션에 형제 형태를 **이름 대어** 적을 것 ⑤R2 수리가 R3에서 「끝 상태는 옳고 타이밍이 틀린」 회귀를 만들었다 — 단정은 **구간**을 재야 한다(프레임당 최대 변화량) ⑥워커 stdout 절단 반복(149B·159B) — 보고 정본은 PR 본문 ⑦bash 3.2엔 연관 배열이 없다(승격 스크립트 1회 즉사, 부작용 0).
> **★ 다음**: UX-R1c R4 → 검수 R4 → 랜딩 → 승격 m · UX-R1e #2000 · UX-R1b #1997 · UX-R2a #2001 · UX-R2b #2002(uxui, 병렬 2, 발사는 go) · ITO(G1) 준비 · 성재 결정 #2050 N-2.

> 이하 스냅샷 84:
> **2026-09-03 스냅샷 84 (Fable/Opus5 · momo-main — ★W1 2차 랜딩: M0m·UX-R4a·M0w 폐곡선 랜딩+승격, DS-2만 잔류. 워커 레인 정지(grok 잔액 소진)).** 컴팩트 복원 진입점.
>
> **★ 오케스트레이터 = Opus 5**(Fable 한도 소진, 성재가 `/model` 전환). **서브에이전트도 `model: opus`로 발사할 것.**
> **★ 랜딩(전부 design-review 폐곡선)**: **M0m #2009**(폰 QR 연결, 3회전 PASS — iOS AppDelegate가 warm `oort://`를 RCTLinkingManager로 넘기지 않아 **앱이 떠 있으면 딥링크가 JS에 도달하지 않던 선재 공백**까지 복구, `oort://join`도 함께) · **UX-R4a #2015**(Agent Hub enabledTools 편집 UI, **4회전** — R3에서 「링은 그려지는데 채움 대비 1.207:1로 **보이지 않음**」 발견, R4 4.742/7.273로 교정) · **M0w #2019**(웹 QR 카드+first-run, 3회전 — **자작 QR 인코더가 스캔 불가**였다: RS 생성 다항식 오류 + 포맷 비트 역순, 기존 스위트가 한 번도 디코드하지 않아 6/6 초록. 독립 왕복 디코드 시험 신설, Apple CIDetector/Vision **16/16**, 모듈 피치 v1/v7/v8 = 4.000px).
> **★ 승격**: 배치 **k** #2033(uxui→main, 보호 경로 0) + sync #2034/#2035 → **main=10893152·uxui=051a40c0·engine=67d8cb98**, alignment PASS. (앞선 배치 i·j와 스냅샷 83은 #2012/#2014/#2023/#2026.)
> **★ 잔류 1건**: **DS-2 #2020**(`/design` 갤러리) — R3 **FAIL(B1·H3)**. B-1 ContextMenu 표본이 라이브 라우트에서 **빈 상자**(캡처만 뷰포트를 3975px로 키워 통과, 가시 비율 0, 로드 시 포커스가 화면 밖 메뉴로) · H-1 새 기하 단정이 **클리핑을 못 본다**(`parentElement`를 셀로 착각 — 검수자가 R2 결함을 되살렸는데 레인 초록) · H-2 상단 테두리·반경 깎임 · H-3 가로 토큰을 세로로 차용(정본이 세 번 금지). **미션 `scratchpad/mission-ds2-r4.md` 작성 완료 — 워커 복구 시 `-c` 즉시 발사.** R1 13건과 R2의 모달 잠금·dist 마커·스크롤 소유권은 닫힘(`tokens.css` base와 바이트 동일 확증).
> **★ 워커 레인 정지**: **grok Build 잔액 소진(402)** — DS-2 R3 워커가 그 위에서 죽었고 마지막 미커밋 조정은 오케스트레이터가 그대로 커밋(저작=워커 명시). 성재 결정 대기: 충전 / Opus 워커 전환 / 마감.
> **★ 발행 티켓**: #2016 도구 카탈로그 GET(engine — **#1957은 이것 때문에 열어 둠**, 프로덕션은 아직 표시 전용) · #2029 기기 목록·해제(engine) · #2030 M0m 잔여 · #2031 UX-R4a 잔여 · #2032 M0w 잔여(시크릿 게이트 실패 분기 도달 불가) · #2018 폰 플레이크(범위 확장: 동시 게이트 실행 시 3파일).
> **★ 교훈(메모리 `guards-that-cannot-fail`)**: 이 회차 최빈 결함은 코드가 아니라 **실패할 수 없는 단정**이었다(QR 미디코드 · jsdom 폴백 · `try{}catch{}` · 파일 이름 허용목록 · 속성만 보는 export 가드 · 발화하지 않는 스크롤 단정). 전부 **검수 프롬프트의 사보타주 요구**가 잡았다 — 앞으로 상시 포함, 수리 미션에는 「무엇을 숫자로 재라」를 명시. 아울러 병합 트리 게이트 **동시 실행 금지**(폰 스위트 비결정).
> **★ 다음**: DS-2 R4(워커 필요) → 랜딩 → 승격 l · UX-R1a/c/d/e(#1996/#1998/#1999/#2000, ready) · ITO(G1) 준비.

> 이하 스냅샷 83:
> **2026-09-02 스냅샷 83 (Fable · momo-main — ★W1 1차 랜딩 완료: v0.1.4 발행 + SH-1·M0s·UX-R2s·UX-R0·SH-3a main 정본화, UX-R4a·M0m(R2) 가동).** 컴팩트 복원 진입점.
>
> **★ 발행**: **v0.1.4**(run 33616349789 · 태그 e39e9427 · app `sha256:7426d282…` · pg `sha256:563ee793…` · attestation verify PASS) — SELF_HOST §2-B·CHANGELOG #1980. 로컬 스택 `oortv013`은 v0.1.3 digest(doctor가 적발) — 갱신은 별도.
> **★ 랜딩·승격**: SH-1 #1983(engine, `releases/latest.json`) · M0s #1986(engine, A-44 #1988) · UX-R2s #1993(engine — **1차 랜딩 체인이 `| tail -1`로 머지 실패를 삼켜 #1960 close·A-45 ready가 먼저 기록됨 → 2026-09-03 재검증 후 재랜딩·승격 배치 j**, A-45 #1994) · **승격 #2005**(engine→main, 감사: SH-1 `scripts/**` 4파일) + sync h #2006/#2008 · **UX-R0 #1985**(uxui — design-review R1 FAIL B0·H2·M3·N4 → R2 PASS B0·H0 → R3: CI 유닛 레인엔 Playwright 없음 → H-1 런타임 프로브 skipIf+경고, 양방향 증명) · **SH-3a #2007**(engine — 재검증 9/9·신선 클론 PASS·시크릿 유출 0/14·플래그 코드 대조 doorbell/hosted=`true`·unfurl=`1`) · **승격 배치 i** #2012(engine→main)·#2014(uxui→main, 토폴로지 검사가 engine sync 선행을 요구 → i2 정합) + **배치 j**(UX-R2s) + sync i/i2/j → **main=1a88d9ca·uxui=d048f5e6·engine=f02022db**, alignment PASS.
> **★ 가동(병렬 2)**: **UX-R4a #1957**(`wuxr4a` — 워커가 도구 카탈로그 GET 라우트 부재 확인 → 브리프 정지 조건대로 안전 부분만 랜딩(제안 경로 `GET …/agent-tool-catalog` 부재 시 표시 전용으로 접힘)·PR #2015 검수 중; 엔진 티켓 **#2016** 발행) · **M0m #1990**(`wm0m`, PR #2009 — design-review R1 **FAIL B1·H2·M7·N5**(SAS 화면 출구 부재·`Podfile.lock` 미갱신·오프라인/오류 상태 부재·QR 버튼 4번째 룩·권한 거부 빈 모달·기기명 상수·서버 base 선덮어쓰기) → R2 수리 워커 `-c` 재개, 미션 `scratchpad/mission-m0m-r2.md`; 기획 결정: QR=헤드라인 문(outline 티어)·폰 `font.display` 역할 신설·어투 -습니다 통일). 준비된 미션: `mission-ds2.md`·`mission-m0w.md`(uxui 슬롯 비면 발사).
> **★ 발행 이슈**: UX-R1a~e·R2a·R2b **#1996~#2002**(R1a/c/d/e ready, 나머지 blocked) · **#2010** redeem 응답 sas 동봉(engine, 폰 파생 복제 은퇴) · **#2011** 로그인 상태 oort://link 한 문장(mobile) · **#2016** 도구 카탈로그 GET(engine, UX-R4a 편집 표면 개방) · #1984 범위 확장(`test_oort_doctor.sh` local_gate 편입) · #2000 원장(UX-R0 nit N-5~N-8) · ADR-0179 D1 정오표(이 PR).
> **★ 다음**: M0m R2 → 재검수(fresh) → 랜딩 · UX-R4a 랜딩(#2015 design-review → 트랙) · 다음 uxui 발사 DS-2 또는 M0w · 승격 배치 j · ITO(G1) 준비.
> **★ 교훈(메모리)**: `gh pr merge --delete-branch`를 PR 헤드 워크트리에서 실행하면 머지는 되고 체인만 ABORT(#1985·#2007 재발) → 루트에서 `--merge`만, 원격은 `push --delete` · 체인의 `| tail -1`은 rc를 삼킨다 — 머지 결과는 항상 `gh pr view --json state`로 확인 · CI 유닛 레인은 브라우저 없음 — 런타임 프로브는 로컬 게이트 소관.

> **과거 스냅샷은 `docs/planning/archive/CURRENT_STATE-snapshots.md`로 이동(로테이션 — 규칙은 아래 절).**

## 이 문서 갱신·로테이션 규칙

- 이 문서는 **컨텍스트 압축/세션 전환 후 가장 먼저 읽는 현재 상태 스냅샷**이다. 결정 근거는 ADR, 검증 증거는 STATUS, 계획은 ROADMAP이 정본이며 이 문서는 포인터다.
- `momo-main`만 canonical `main`의 이 파일을 갱신한다. planner는 변경 제안을 자기 planning branch/ADR에 남긴다.
- 갱신 시 새 스냅샷을 맨 위에 추가하고(기준일·기준 커밋·활성 레인·다음 체크포인트 포함), **최근 6개만 유지** — 초과분은 월초 플러시 때 `docs/planning/archive/CURRENT_STATE-snapshots.md` 맨 위에 원문 그대로 이동한다.
- 세션 종료 시 `JOURNAL.md`에 5줄 이내 checkpoint를 남긴다. 채팅에만 남은 결정/할 일은 존재하지 않는 것으로 취급한다.
- 빠른 복원은 `scripts/planning_context.sh`(GitHub 실시간 상태는 `--github`).
