# oort 기획 현재 상태 (Planning Current State)

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

> 이하 스냅샷 77:
> **2026-09-01 스냅샷 77 (Fable · momo-main — ★정본 경량화 재편 + 3중 감사 완주: 결재 대기 3건 위 신규 취사 큐 적재).** 컴팩트 복원 진입점.
>
> **★ 정본 경량화(성재 지시) 집행**: PR #1924 랜딩 — ROADMAP 재작성(2026-09-01 현재 위치)·STATUS 월별 로테이션·BUILD_TICKETS 레거시 분리·JOURNAL 20항목·CURRENT_STATE 스냅샷 6. 규칙 정본 docs/archive/README.md(momo-main 월초 플러시 로테이션 의무).
> **★ 3중 감사 정본**(research/2026-09-01-*): ①**buzz-parity-audit** — 47축(완료26·부분11·미착수8·제외2), gap-candidates 15중 8 소화, 사각지대 14(최대: 사이드바 조직화 문법 — `"channels"|"dms"` 하드코딩 · 채널 브라우저 부재 · 검색 채널 스코프 부재 · mark-unread(read-state monotone) · 알림음/배지), 우선순위 10 토대성순 ②**selfhost-core-audit** — 도어벨 온전(−ε 벨테스트 버튼)·터미널=work host 패키징 갭·허들=로컬만(생성기 LiveKit 3키 미생성→기본 503)·웹훅 인바운드 수신 라우트 0(#1265, 자격은 발급됨)·공개 엣지 은퇴 도메인(#1239) ③**differentiator-audit** — **buzz도 에이전트=멤버 스키마 구현(단독 차별 전제 뒤집힘)**. 코드가 지지하는 차별 넷: RLS FORCE·대화 내 자발 도구호출 승인(fail-closed G6)·비용 원장·A2A 5게이트(전부 buzz 0건 재검증). buzz 우위 3축(워크플로 엔진·projects 37K줄·mesh-compute)=싸우지 않을 자리. buzz 승인 UX는 현재 빈 화면(시간 민감 기회). 데모 정본=시나리오 A(멤버+돈+RLS, 전 구간 실증 이력).
> **★ 집행**: 부기 정리 #1300·#1275 close(코드 재검증 코멘트)·#1895 범위 정정(infra/prod 한정)·#1274 정정(BZ-4e≠채널 rename). 신규 결함 티켓 **#1925**(허들 생성기 3키+프로파일)·**#1926**(공개 엣지 파라미터화=B3+B5, #1239 포섭)·**#1927**(work host 패키징 — ADR 후보). 스팟 재판정 7건 전부 일치.
> **★ 성재 결재 대기(기존 3 + 신규 취사)**: ①BZ-5a 액센트 시안 확정→#1922 머지(wbz5a 보존) ②track→main 승격 배치 ③A6 rich 기본 상향. **신규 취사**: 버즈 후속 파도(패리티 감사 §4 — 1순위 사이드바 조직화 문법+행 컨텍스트 메뉴) / 차별화 최소 레버리지(enabledTools 편집 UI(S)+비-work-host 실행 도구 1종(M)=승인 축 독립 데모화) / 셀프호스트 착수 순서 권고 #1265→#1925→#1926→#1792→#1927.
> **★ 운영**: 워커 레인 유휴(승인 큐 소진 유지). 그록봇/VM 축 복구 대기. 문서 로테이션 첫 적용 완료(스냅샷 71 아카이브行).

> **과거 스냅샷은 `docs/planning/archive/CURRENT_STATE-snapshots.md`로 이동(로테이션 — 규칙은 아래 절).**

## 이 문서 갱신·로테이션 규칙

- 이 문서는 **컨텍스트 압축/세션 전환 후 가장 먼저 읽는 현재 상태 스냅샷**이다. 결정 근거는 ADR, 검증 증거는 STATUS, 계획은 ROADMAP이 정본이며 이 문서는 포인터다.
- `momo-main`만 canonical `main`의 이 파일을 갱신한다. planner는 변경 제안을 자기 planning branch/ADR에 남긴다.
- 갱신 시 새 스냅샷을 맨 위에 추가하고(기준일·기준 커밋·활성 레인·다음 체크포인트 포함), **최근 6개만 유지** — 초과분은 월초 플러시 때 `docs/planning/archive/CURRENT_STATE-snapshots.md` 맨 위에 원문 그대로 이동한다.
- 세션 종료 시 `JOURNAL.md`에 5줄 이내 checkpoint를 남긴다. 채팅에만 남은 결정/할 일은 존재하지 않는 것으로 취급한다.
- 빠른 복원은 `scripts/planning_context.sh`(GitHub 실시간 상태는 `--github`).
