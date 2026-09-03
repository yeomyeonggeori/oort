# oort 기획 현재 상태 (Planning Current State)

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

> 이하 스냅샷 82:
> **2026-09-02 스냅샷 82 (Fable · momo-main — ★G0 완주(발행 창만 남음): BT 파도 6장 전량·BZ-5a·P1/P2 main 정본화, ADR 4본 결재 대기, W1 발사 대기).** 컴팩트 복원 진입점.
>
> **★ 랜딩·승격**: BT-6 서버 #1961(engine 6faccaea, A-43) + 클라 #1963(uxui 23fbbb0c — design-review **5회전** R1 FAIL B2·H2 → R2 B0·H1 → R3 B0·H2 → R4 B0·H2 → R5 **PASS B0·H0**; H-5 필 arming은 선재 결함으로 철회→#1966) · lint 위생 #1965(BZ-5a가 붉힌 web lint 레인 수리) · **승격 배치 #1968(engine→main)·#1970(uxui→main)·sync #1969/#1971/#1972/#1973·docs #1953(P1 PIPELINE.md·P2 CODEX 병합·스냅샷 81)** — 정책 감사 6회(코멘트→라벨→정본 검증 PASS). 최종 main=4369909b·uxui=e0e992c4·engine=5696ecd9, alignment PASS.
> **★ G0 잔여 = v0.1.4 발행 창**(성재 attended: `publish-images.yml` dispatch + release Environment 승인 → digest 수거 → 태그·Release → SELF_HOST 문면). 이후 W1 발사(go 신호).
> **★ 결재 대기**: ADR-0179(표현 축)·0180(QR 기기 연결)·0181(웰컴 킥오프)·0182(일시 확인) Proposed. Accept 시 #1958 UX-R0·#1959 M0s·#1960 UX-R2s 개방. 즉시 발사 가능: #1954 SH-1·#1955 SH-3a·#1956 DS-2·#1957 UX-R4a.
> **★ 적립**: #1964 폰 마크 소비+explicit_open · #1966 UnreadPill 재방문 arming 선재 결함 · #1967 BT-6 닛(N-15 죽은 분기·N-9 게이트 잔여·N-14) · #1774 감사 재요구 마찰(이번 승격 6회 실측 — P4 후보).
> **★ 교훈(메모리 기록)**: 트랙 머지 전 verify_merge_tree 8레인 필수(STATUS 충돌은 union 임시 커밋 --base) · zsh 미인용 $VAR 미분리 · 워커 상습 축에 "수리 회귀"와 "런타임 4/4 미실측 주장" 추가 — R3/R4에서 M-8 '수리됨' 주장이 두 번 불성립.

> 이하 스냅샷 81:
> **2026-09-02 스냅샷 81 (Fable · momo-main — ★G0 집행 중: BZ-5a·BT-6 서버 랜딩, ADR 4본 Proposed, W1 패킷·이슈 발급, 클라 워커 가동).** 컴팩트 복원 진입점.
>
> **★ 랜딩**: BZ-5a #1922 → track/uxui **939ed80e**(결재: 액센트 기본=새벽·5종 유지, 정책 검증 PASS, #1868 코멘트·5b 잔여) · BT-6 서버 절반 #1961 → track/engine **6faccaea**(재검증: PG 증명 5/5·breadth 2/2·마이그레이션 3/3 GREEN, RED 커밋 5/5 실패 확인) · ENGINE_HANDOFF **A-43** ready(#1962 → engine 6b8b723f) · 트랙 동기화 #1951·#1952(alignment PASS).
> **★ 가동**: **BT-6 클라 절반 grok 4.6 워커**(`momo-worktrees/wbt6-client`, 미션 `scratchpad/mission-bt6-client.md` — momo-core 합성 단일점·⋯ 메뉴·explicit_open 배선·grep 게이트·캡처 8587/셸 8589). 완료 시 design-review(fresh) 폐곡선 → 머지 → #1934 close.
> **★ 결재 대기**: **ADR-0179·0180·0181·0182 Proposed**(main 랜딩 #1949) → Accept 시 #1958 UX-R0·#1959 M0s·#1960 UX-R2s 개방. 즉시 발사 가능(go 대기): #1954 SH-1·#1955 SH-3a·#1956 DS-2·#1957 UX-R4a(패킷 main 랜딩 #1950).
> **★ 보류 PR**: **#1953** P1 PIPELINE.md+P2 CODEX.md 병합(+이 스냅샷) — 승격 창에서 main 머지 후 sync 짝. 워커 레인=grok 4.6(D-7 개정).
> **★ 다음**: 클라 절반 랜딩 → 승격 배치(engine→main→uxui sync→uxui→main→engine sync→#1953→sync 짝) → **v0.1.4 발행 창(성재 attended dispatch 승인)** → W1 발사(병렬 2). 교훈 기록: zsh 미인용 $VAR 미분리로 빈 diff를 '동일'로 오판한 감사 코멘트 정정(#1922) — 메모리 `zsh-word-split-gotcha`.

> 이하 스냅샷 80:
> **2026-09-02 스냅샷 80 (Fable · momo-main — ★인터뷰 전량 승인 → 출시 프로그램 편성 정본 확정·ROADMAP 정렬. 착수 전, go 대기).** 컴팩트 복원 진입점.
>
> **★ 결정 고정(D-1~D-13)**: 브리프 §8 권고 전부 승인(2026-09-02 성재) + 모바일 판정(**M0 QR 기기 연결=G1 창 안 선행 · M1 폰 패리티=G1 이후 ITO 병렬 · Android 보류**) + 이미지 에셋(코드 SVG 정본, 비트맵은 시안·마케팅 한정, gpt-image→grok→OpenRouter). 정본 `docs/planning/2026-09-02-launch-program-plan.md` §0.
> **★ 편성 정본**: 4레인(UXUI UX-R0~R6+DS-0~6 · 엔진 SH-1~9 · 모바일 M0/M1/M2 · 파이프 P1~P8) + 게이트 G0(BT-6·결재 3건·승격·v0.1.4) → G1(내부 테스트: UX-R1·R2+DS-0·1+SH-1~4+M0+P1·P2) → G2(출시: 셀프호스터 3 다변화) → G3(스토어: M1+M7). ROADMAP §1·§2 이 편성으로 교체.
> **★ ADR 큐(go 후 즉시 기안)**: 0179 표현 축(모션·눌림·엘리베이션·밀도) · 0180 기기 연결 1회용 QR 링크 토큰 · 0181 웰컴 킥오프 오프너=agent-worker · 0182 일시 확인 정책(토스트 금지 대안).
> **★ 다음 행동(go 신호 후)**: ①ADR 4본 Proposed ②G0 집행(BT-6 이어받기 워커 → #1922 머지·A6 상향 → 승격 → v0.1.4) ③티켓·패킷 발급(UX-R0~R1e·DS-1·2·SH-1~3a·M0s/w/m·P1~P4) ④W1 발사(병렬 2).
> **★ 재개 지점 불변**: BT-6 서버 절반 `wbt6-server` 미커밋(085·read_state ReadIntent·dto). 워커 레인=Opus 5 Agent.

> **과거 스냅샷은 `docs/planning/archive/CURRENT_STATE-snapshots.md`로 이동(로테이션 — 규칙은 아래 절).**

## 이 문서 갱신·로테이션 규칙

- 이 문서는 **컨텍스트 압축/세션 전환 후 가장 먼저 읽는 현재 상태 스냅샷**이다. 결정 근거는 ADR, 검증 증거는 STATUS, 계획은 ROADMAP이 정본이며 이 문서는 포인터다.
- `momo-main`만 canonical `main`의 이 파일을 갱신한다. planner는 변경 제안을 자기 planning branch/ADR에 남긴다.
- 갱신 시 새 스냅샷을 맨 위에 추가하고(기준일·기준 커밋·활성 레인·다음 체크포인트 포함), **최근 6개만 유지** — 초과분은 월초 플러시 때 `docs/planning/archive/CURRENT_STATE-snapshots.md` 맨 위에 원문 그대로 이동한다.
- 세션 종료 시 `JOURNAL.md`에 5줄 이내 checkpoint를 남긴다. 채팅에만 남은 결정/할 일은 존재하지 않는 것으로 취급한다.
- 빠른 복원은 `scripts/planning_context.sh`(GitHub 실시간 상태는 `--github`).
