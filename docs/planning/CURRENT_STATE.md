# oort 기획 현재 상태 (Planning Current State)

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

> 이하 스냅샷 79:
> **2026-09-02 스냅샷 79 (Fable · momo-main — ★재개 복원 + 출시 재진단·두 기둥 브리프 작성, 인터뷰 대기).** 컴팩트 복원 진입점.
>
> **★ 재개 지점**: BT-1~5 트랙 랜딩 완료(#1937~#1945). **BT-6(#1934) 서버 절반이 `momo-worktrees/wbt6-server`에 미커밋**(085 마이그레이션·read_state.rs ReadIntent·dto — 라우트·테스트 미착수). 클라 절반 미착수. 권고=이어받기. 루트는 8/28 브랜치 잔재를 stash@{0}에 보존 후 origin/main 정렬, 트랙 워크트리 ff.
> **★ 브리프 정본**: `research/2026-09-02-launch-rediagnosis-two-pillars-brief.md` — 탐색 4기(웹 클라·셀프호스팅·buzz·문서/파이프라인) + 9/1 3중 감사 합본. 근원 5(모션 축 0·눌림 피드백 부재·온보딩 절정 부재·⌘K 내비 전용·에이전트 표면 분산·금지 위주 시스템). 편성안: **UX-R0~R6**(ADR-0179 모션·밀도 축 → 모션 토대 → 온보딩 절정 → 팔레트 → 에이전트 표면 → 상호작용 → 외양) · **SH-1~9**(릴리스 매니페스트 → 공개 엣지 #1926 → CLI/doctor → 영문 에이전트 런북+README 프롬프트 → 클라우드 경로 → 합류 GUI → blocker 순서 → 그록봇 → OSS 위생) · **P1~P8**(PIPELINE.md 단일 설정·CODEX.md 병합·commands·스킬 통합·archive·planning_context 갱신). 게이트 G1(내부 테스트 진입)=UX-R1·R2+SH-1~4, G2(출시)=셀프호스터 3명 다변화.
> **★ 성재 인터뷰 대기(브리프 §8 Q1~Q11)**: 모션 라이브러리·토스트 정책·UX-R 순서·하네스/플랫폼 우선·BT-6 재개 방식·결재 3건·워커 레인 확정값·영문화 범위·그록봇 템플릿 실물·폰 시점·킥오프 오프너 주체. 답 수신 → ADR 3본 기안 + 티켓/패킷 발급 + BT-6 재발사(발사는 go 신호).
> **★ 결재 대기(변동 없음)**: ①BZ-5a 액센트→#1922 ②track→main 승격(uxui 110·engine 35 적체) ③A6 rich 기본. 워커 레인=Opus 5 Agent(9/1~).

> 이하 스냅샷 78:
> **2026-09-01 스냅샷 78 (Fable · momo-main — ★BT 파도 개막: BT-1 랜딩·BT-2 PR 정지점(성재 지시)).** 컴팩트 복원 진입점.
>
> **★ BT 파도(버즈 토대) 확정·개막**: 우로보로스 인터뷰(interview_20260901_052920)로 편성 — 목적=내부 품질 토대(성재 확정), 6장 2단, 워커=**Opus 5 Agent 레인**(grok 대체, 성재 지시). 정본 docs/planning/2026-09-01-bt-wave-plan.md. **ADR-0177(섹션 멤버별 소유)·0178(mark-unread 별도 신호) 성재 실시간 결재 Accepted** — Stage 2 전량 개방.
> **★ BT-1(#1929) 랜딩**: PR #1937 → track/uxui. design-review 3회전 폐곡선 — R1 FAIL(B1 포털 화살표 순회 사망·H1 낙관삭제 다이얼로그 자살) → R2 PASS+신규 M2(다크 표식 2.90:1·가드 과폭) → R3 전량 마감(B0·H0·M0). 신설 자: 행 메뉴 표식 대비 이중 자(토큰+캡처, 반례 2.90 잠금)·화살표 완주 시험·지연 403 두 표면 red proof·canon 호출부 스캔. 적립: 오프라인 칸 문법·N-6 규모·N-7 폰 채널 액션 부재.
> **★ BT-2(#1930) — 정지점**: 워커 완주, **PR #1938 생성 직후 성재 지시로 파도 일시 정지**(리뷰 미발사·머지 안 함). 커밋 dba75f90(red proof 선행)+429e7c8b. 구 MentionAutocomplete 삭제→단일 파서 흡수, `#` 채널·`:` 이모지(emoji 정본 소비)·코드서식 억제. 워크트리 wbt2 보존(재개용), 게이트 그린은 워커 주장 — **리뷰 미검증 상태**.
> **★ 재개 절차**: ①dr-1930 design-review 발사(fresh, 검수 포트 8551/8553·vite 8555, R1은 워커 상습 5축 정조준) ②회전 폐곡선 B0·H0 → #1938 머지 → #1930 close ③BT-3(#1931, 브리프 有)→BT-4(#1932)→BT-5(#1933)→BT-6(#1934) 순차. 각 티켓 포트 배정은 파도 정본 참조.
> **★ 별개 결재 대기(변동 없음)**: ①BZ-5a 액센트 시안 확정→#1922 머지(wbz5a 보존) ②track→main 승격 배치 ③A6 rich 기본 상향.
> **★ 운영 노트**: Agent 레인 tmux swarm 서버 고착(pane fork ENXIO) 시 `tmux -L claude-swarm-* kill-server`로 복구(이번 세션 실증). 중첩 CLI bypass 폴백은 분류기 차단 — 쓰지 말 것.


> **과거 스냅샷은 `docs/planning/archive/CURRENT_STATE-snapshots.md`로 이동(로테이션 — 규칙은 아래 절).**

## 이 문서 갱신·로테이션 규칙

- 이 문서는 **컨텍스트 압축/세션 전환 후 가장 먼저 읽는 현재 상태 스냅샷**이다. 결정 근거는 ADR, 검증 증거는 STATUS, 계획은 ROADMAP이 정본이며 이 문서는 포인터다.
- `momo-main`만 canonical `main`의 이 파일을 갱신한다. planner는 변경 제안을 자기 planning branch/ADR에 남긴다.
- 갱신 시 새 스냅샷을 맨 위에 추가하고(기준일·기준 커밋·활성 레인·다음 체크포인트 포함), **최근 6개만 유지** — 초과분은 월초 플러시 때 `docs/planning/archive/CURRENT_STATE-snapshots.md` 맨 위에 원문 그대로 이동한다.
- 세션 종료 시 `JOURNAL.md`에 5줄 이내 checkpoint를 남긴다. 채팅에만 남은 결정/할 일은 존재하지 않는 것으로 취급한다.
- 빠른 복원은 `scripts/planning_context.sh`(GitHub 실시간 상태는 `--github`).
