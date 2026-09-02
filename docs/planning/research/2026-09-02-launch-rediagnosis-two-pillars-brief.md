# 출시 재진단 + 두 기둥(Buzz급 UXUI · 압도적 셀프호스팅) 전체 여정 설계 브리프 (2026-09-02)

> 작성: Fable(momo-main). 성재 발제(2026-09-02): "중단 지점 재개 · 내부테스트~출시 잔여 재진단 · ①Buzz급 UXUI(Raycast 취향, 애니메이션·온보딩 퍼널·연동·버튼 인터랙션·DnD) ②압도적 셀프호스팅(README 프롬프트 하나로 그록봇/하네스가 인터랙션 설치, 팀 즉시 사용 + 내 에이전트 합류, Railway/AWS/GCP도 하네스 복붙) ③루트 md 경량화·오픈소스 대비·파이프라인 낡은 부분 리뉴얼".
> 성격: **브리핑 + 편성안(발사 전)**. §8 인터뷰 답 → 티켓·ADR·패킷 발급. 근거는 코드 실사(탐색 에이전트 4기: 웹 클라·셀프호스팅·buzz 레퍼런스·문서/파이프라인) + 9/1 3중 감사(`2026-09-01-{buzz-parity,selfhost-core,differentiator}-audit.md`).

---

## 0. 재개 지점 (복원 사실)

| 항목 | 상태 |
|---|---|
| 정본 위치 | origin/main `df6bc4d3`(스냅샷 78 + BT-5 브리프 + ADR-0178 개정 1). 로컬 루트는 8/28 브랜치에 남아 있었음 → main으로 정렬, 낡은 로컬 수정(CURRENT_STATE/JOURNAL 구판·livekit.yaml node_ip 실험)은 `stash@{0}` 보존. 트랙 정본 워크트리 둘 ff 완료 |
| **중단점** | **BT-6(#1934) mark-unread 서버 절반** — `momo-worktrees/wbt6-server`에 **미커밋** 상태: `server/Migrations/085_mark_unread_signal.sql`(신규) + `read_state.rs`(+222, `ReadIntent` enum·D4 해제 로직) + `dto.rs`(`mark_unread_before_seq`·`read_intent` DTO). **라우트 배선·테스트·red proof 미착수.** 클라 절반(`wbt6-client`) 미착수. 워커 레인=Opus 5 Agent(9/1 성재 지시로 grok 대체) |
| BT 파도 진척 | BT-1~5 트랙 랜딩 완료(#1937·#1938·#1940/#1941·#1942/#1943·#1945, 전부 design-review B0·H0). 파도 마감 = BT-6 |
| 결재 대기(변동 없음) | ①BZ-5a 액센트 시안 확정 → PR #1922 머지(`wbz5a` 보존) ②track→main 승격 배치(uxui 110커밋·engine 35커밋 적체) ③A6 링크 프리뷰 rich 기본 상향 |
| 유효 재개 옵션 | (a) **이어받기** — wbt6-server diff는 ADR-0178 개정 1(D6 `read_intent` 판별자)을 정확히 반영하고 있어 폐기할 이유 없음. 워커에 "현 상태에서 라우트·테스트·red proof 완주" 지시 → PR → 클라 절반 → design-review → 랜딩. (b) 재발사(clean). **권고 (a)** |

---

## 1. 현재 위치 한 줄 진단

- **출시 정의**(2026-08-10 지시서, 불변): *외부 셀프호스터 3명 이상 + 에이전트 멘션·런 실사용.* 레포 공개(Apache-2.0·gitleaks·NOTICE·DCO)는 완료.
- **3관문**: ① 공개 **완료** · ② 단일 이미지 셀프호스팅 **로컬 폐곡선 실측 PASS**(v0.1.3 digest pin·multi-arch·attestation·부트스트랩→초대→에이전트 자격 S4 5/5) · ③ 프로덕션 운영 신뢰 **미달** — 공개 엣지(도메인/TLS/CSP) 은퇴 도메인 하드코딩(#1926), 클라우드 플랫폼 경로 **0**, 운영 문서 전부 한국어.
- **UXUI**: 8/29~9/1 buzz 패리티 3파도(BZ·BF·BT) **25건+ 랜딩**, 47축 중 완료 26·부분 11·미착수 8. 그런데 체감이 낮다 — 원인은 기능 수가 아니라 **모션·인터랙션 축이 시스템에 없어서**다(§2).
- **차별화 전제 정정**(9/1 감사): "에이전트=멤버"는 buzz도 스키마로 구현. 코드가 지지하는 우리 차별은 **RLS FORCE · 대화 내 자발 도구호출 승인(fail-closed) · 비용 원장 · A2A 5게이트** 넷. buzz 승인 UX는 지금 빈 화면 — 시간 민감 기회.

---

## 2. 왜 아직 불만족스러운가 — 근원 5 (코드 실사)

| # | 근원 | 실측 | buzz 대조 |
|---|---|---|---|
| R1 | **모션 시스템 0** | `clients/web` 71K줄에 `transition-colors` 60·`transition-opacity` 2·키프레임 3. duration/easing 토큰 없음(첫 토큰 `--duration-sidebar`가 track/uxui에서 생김). 다이얼로그·팝오버·드로어·스레드·리스트 삽입에 enter/exit 전무. 디자인시스템 §2.6이 "모션에도 토큰 축이 없다"고 자인 | `motion.css` ladder **120/180/240/500ms** + 2 easing + arrival distance/blur, `motion/react` 58파일, 모달 비대칭(open 200/close 150), 스켈레톤 blur 크로스페이드, 메시지 도착 `motion-enter-conversation`, 이모지 버스트 파티클 |
| R2 | **눌림 피드백 부재** | `hover:` 140 vs **`active:` 11**. 클릭이 색만 바뀌고 150ms 뒤에 바뀜 | 스케일/잉크 눌림·spring(stiffness 500/damping 30)·layoutId |
| R3 | **첫 실행의 절정 부재** | S0 딥스페이스 랜딩(BZ-6a)까지만. S3 프로필·**S4 웰컴 킥오프(에이전트가 먼저 말 거는 5분)** 미구축. UX 바이블 P5 미이행. "첫 에이전트 연결"은 퍼널이 아니라 설정 안 1,504줄 위저드 | 스타터 에이전트 팀이 채널에서 실제로 말을 건다(투어 카드 없음), 킥오프 캐릭터 stagger 120ms 연출 |
| R4 | **명령 표면 약함(Raycast 축)** | ⌘K = 이미 받아둔 목록의 클라 필터 + 정적 내비 5 + 채널 생성 1. 액션·메시지 검색·최근/빈도·중첩 모드·프리뷰·키캡 힌트 없음. 미라벨 아이콘 36 중 12가 여기 | **buzz도 팔레트 없음** — 앞설 수 있는 자리 |
| R5 | **에이전트 표면 분산** | 작업 중 rail·사이드바 badge·work panel·ADE drawer 4곳, 단일 "내 에이전트들이 지금 뭘 하나" 없음. provider(hermes/claude/codex/grok) 시각 정체성 없음(`--agent` 토큰만). Agent Hub 1,820줄 관리 패널 | 하네스 카탈로그(12종, 카피 정책 명문), 에이전트 아이덴티티 카드, 툴콜 분류 렌더 |
| R6 | **시스템이 금지 위주** | `--color/--spacing/--radius/--text: initial` + hard-zero 12종 + 토스트 금지(게이트). 표현 축(모션·엘리베이션·밀도·액센트)이 없어 "추가"가 항상 위반 → tokens.css 2,678줄 일회성 기하 | 밀도 3단·폰트 3단·가상 rem·액센트·squircle·텍스처 카드 — 표현 축이 토큰 |

> 판정: 지금 필요한 것은 "기능 더 이식"이 아니라 **표현 축 3개(모션·눌림·엘리베이션/밀도)를 시스템에 세우고, 그 위에 온보딩 절정·명령 표면·에이전트 표면을 다시 조립**하는 것이다. BZ/BF/BT가 뼈대를 세웠으니 이제 근육을 붙일 차례.

---

## 3. 기둥 A — Buzz급 + Raycast 감각 UXUI 프로그램 (편성안)

파도 이름 **UX-R**(Raycast-flavored). 순서 = 토대성순. 전부 design-review 폐곡선(B0·H0) 후 track/uxui 랜딩.

| 단계 | 내용 | 근거·이식원 | 규모 | 선행 |
|---|---|---|---|---|
| **UX-R0 · ADR-0179 모션·엘리베이션·밀도 축** | 디자인시스템에 축 신설: duration ladder(120/180/240/500)·easing 2·arrival distance/blur·elevation 2단 유지·density 3단(compact/comfy/spacious)·**motion/react 도입 범위 결정**(권고: CSS 토큰 우선, `AnimatePresence`/`layoutId`가 필요한 표면 — 팔레트·패널·리스트 삽입 — 에 한정) · reduced-motion 이중 처리(CSS 블록 + JS `duration: 0`) · 게이트: `motion.test`(토큰 존재·reduced-motion 블록 단정) + preflight "raw duration 숫자" 금지 | buzz `motion.css`·`motion.test.mjs`·`modalMotion.ts`; 폰 권고안 instant 0/fast 120/standard 180/slow 240(미결) | ADR S | 없음 |
| **UX-R1 · 모션 토대 이식** | ①`motion.css` 이식 ②모달/팝오버/드롭다운 비대칭 enter-exit ③스켈레톤 blur 크로스페이드(`t-skel`) ④메시지 도착 `motion-enter-conversation`(one-shot animationName) ⑤드로어·스레드 패널·⌘K enter/exit ⑥**눌림 상태 전수**(`active:` 스케일/잉크, `button.tsx` variant 단일점) ⑦사이드바 접기 200ms를 ladder로 흡수 | R1·R2 | M | R0 |
| **UX-R2 · 온보딩 절정** | BZ-6b 프로필 스텝(BZ-4 서버 표면 소비, 건너뛰기 상시·실패에도 전진) → **BZ-6c 웰컴 킥오프**: 웰컴 채널에서 김인턴(hermes)이 오프너 게시, provider 미구성이면 그 안내도 에이전트가 말함, 멱등 마커, 캐릭터 stagger 연출 → **S5 "첫 에이전트 연결"을 퍼널로 승격**(위저드→퍼널 축약판: 하네스 선택 카드 → 1회용 자격 → 감지 → 첫 멘션) → Raycast식 **온보딩 재진입 커맨드**(⌘K "온보딩 다시 보기") | R3, `2026-08-29-bz6-onboarding-design.md` v2.1, Raycast 서베이(로그인 월 뒤로·재진입) | L (engine 짝: 오프너 게시 주체 = ADR 후보) | R1 |
| **UX-R3 · 명령 표면(Raycast 축)** | ⌘K를 **액션 팔레트**로: 내비 + 명령(채널 생성·상태 설정·리마인더·DND·에이전트에게 지시…) + **서버 메시지 검색**(BT-3 스코프 재사용, `from:`/`in:`/`before:` 연산자) + 최근/빈도 랭킹 + 중첩 모드(채널 브라우저=사각 S3 해소·"에이전트에게 지시") + 결과 프리뷰 + 키캡 힌트(A9 통합) + 미라벨 아이콘 12 해소 | R4, buzz `parseSearchOperators.ts`·`useAppShellKeyboardShortcuts.ts`(capture-phase 규율) | L | R1 |
| **UX-R4 · 에이전트 표면 통합** | ①"지금 내 에이전트들" 단일 표면(rail·badge·panel·drawer 통합 설계) ②provider 정체성 시각 개념(hermes/claude/codex/grok 글리프 — lucide 예외 절차 ADR-0172, buzz 카탈로그 카피 정책 채택) ③Agent Hub 분해 ④**enabledTools 편집 UI**(차별화 감사 순위 1, S) ⑤승인 축 독립 데모(순위 2: work host 불요 실행 도구 1종, M) ⑥A2A 체인 가시화(순위 5) | R5, 차별화 감사 §3 | L | R1 |
| **UX-R5 · 상호작용·폴리시** | DnD 확장(BT-5 native DnD 위에 window-level 파일 드롭 오버레이·메시지→채널 드래그는 비채택 권고) · 적응형 quick reactions · 리액션 버스트(선택) · 스레드 폭 리사이즈(A10) · 알림음/배지(S6) · 채널 브라우저(S3, R3와 짝) · **토스트 정책 재결정**(ADR: 금지 유지 + "in-place confirm + 팔레트 상태줄" 대안 정의) · 선행 결함 #1919 모달 층·#1915·#1911 | 패리티 감사 §3·§4, buzz `MessageActionBar` reveal 패턴·`useQuickReactionEmojis` | M | R1 |
| **UX-R6 · 외양** | BZ-5a 머지(액센트 확정) → **BZ-5b** 폰트 3단(가상 rem `--type-rem`)·밀도 3단·라이브 프리뷰 → 5c(선택: squircle·panel-left 그림자·텍스처 카드) | ADR-0174, buzz `typography.css`·`AppearanceSettingsControls.tsx`·`check-px-text.mjs` | M | R0 |

- **범위 밖(별도 파도)**: 폰 패리티(#1908·#1892·#1876·#1748·#1752·#1604), 커스텀 이모지(B3), 모더레이션(S7), buzz 제품축 6종 판정(S14).
- **품질 기제 신설 후보**: 파일 1,000줄 ratchet(`check-file-sizes`), `check-px-text`, `waitForAnimations` 캡처 규율(애니메이션 중 캡처 방지 — design-review 회전 수 감소 기대).

---

## 4. 기둥 B — 압도적 셀프호스팅 (편성안)

**북극성**: README의 프롬프트 블록 하나를 (Claude Code | Codex | 그록봇 | 아무 하네스)에 붙여넣으면 → 에이전트가 환경을 묻고(로컬 맥/VPS/그록봇 VM/Railway/Fly/AWS/GCP) → 설치·검증·핸드오프(주소+앱+첫날) → **팀이 바로 쓰고, 설치한 에이전트와 내가 쓰던 에이전트(hermes/grok/claude/codex)가 멤버로 합류**.

**현황(실측)**: 진입 stub `llms.txt` + `docs/SELF_HOST_AGENT.md`(969줄, 단계별 기계 판정 게이트 완비) 실존. 그록봇 E2E 코어 계층 GREEN 실증(8/23). 로컬 생성기 `self_host_env.sh`는 시크릿 9종 자동·무브랜치. **갭 10**: ①운영 문서 전부 한국어 ②digest 핀이 산문에 박혀 릴리스마다 낡음(SELF_HOST=v0.1.3, AGENT=v0.1.1 불일치) ③클라우드 플랫폼 파일 0 ④공개 TLS 부비트랩(#1926/#1239) ⑤README가 은퇴 런북 링크 ⑥day-2 CLI 없음(status/upgrade/backup/member) ⑦조용히 죽는 env 키(소문자 `true`만, `PLATFORM_ADMIN_EMAILS` 누락=403)에 preflight 없음 ⑧에이전트 합류가 curl 전용(자격 발급 GUI 없음·도어벨 UI 잔여·pairing은 데스크탑 위저드 의존·로컬 Ollama `http://` 불가) ⑨외부 도달성(Funnel)이 코드 아닌 산문 ⑩검증 스크립트 130본이 "설치 판정 1개"로 합성 안 됨.

| 단계 | 내용 | 규모 | 선행 |
|---|---|---|---|
| **SH-1 · 기계가독 릴리스 매니페스트** | `releases/latest.json`(버전·app/pg list digest·attestation 커맨드) 발행 파이프라인 산출물화 + SELF_HOST/AGENT 문서가 이를 참조(산문 digest 제거) + RELEASING 절차 갱신 | S | 없음 |
| **SH-2 · 공개 엣지 파라미터화** | #1926(=#1239+CSP connect-src env 템플릿) — 모든 비로컬 경로의 선결. README의 은퇴 런북 링크 교체 | M | 없음 |
| **SH-3 · `oort` 운영 CLI + doctor** | 셀프호스트 단일 verb: `doctor`(silent-fail env 키·포트·볼륨·digest·attestation 검사 → JSON 판정) · `status` · `upgrade`(멱등 재기동 절 코드화) · `backup/restore`(기존 pg_dump 스크립트 흡수) · `member`(초대·자격 발급) · `logs`. `bench_onboarding`·`collect_diagnostics`·`verify_*` 합성 → **설치 판정 1개(PASS/FAIL JSON)** | L | SH-1 |
| **SH-4 · 영문 정본 에이전트 런북 + README 프롬프트 블록** | `SELF_HOST_AGENT.md`를 **하네스 불가지론 영문 정본**으로 재편(그록봇 전용 문면 → 환경 분기 중 하나) + 환경 분기 표(로컬/VPS/그록봇 VM/Railway/Fly/AWS/GCP) + README에 복붙 프롬프트 블록("Paste this into Claude Code / Codex / Grok Bot") + 한국어판 병행. `SELF_HOST.md`·`FIRST_DAY`도 영문 정본화 | M | SH-1·SH-3(CLI verb를 런북이 부름) |
| **SH-5 · 클라우드 플랫폼 경로** | Railway 템플릿(`railway.json`+PG 플러그인+단일 이미지+공개 도메인) · Fly(`fly.toml`+volume) · AWS/GCP는 "VM+compose+도메인" 런북(+최소 Terraform) — 각 **1회 실측 E2E**가 수용기준 | L | SH-2·SH-3 |
| **SH-6 · 에이전트 합류 GUI화** | 외부 도구 자격 발급 GUI(설정 › 에이전트 › 자격) · 도어벨 벨테스트(#1735 잔여) · hosted pairing 웹 경로(데스크탑 위저드 의존 해소) · 로컬 OpenAI 호환 `http://127.0.0.1` 허용(운영자 opt-in) — UX-R2 S5 퍼널의 서버 짝 | M | 없음 |
| **SH-7 · 셀프호스트 완결 blocker(감사 순서)** | #1265 웹훅 인바운드 → #1925 허들 생성기 3키+프로파일 → (SH-2) → #1792 TURN → #1927 work host 패키징(ADR) | L | — |
| **SH-8 · 그록봇 템플릿·VM축 재개** | llms.txt 진입 유지 + "그록봇 루틴 템플릿"(§4.4 프로덕션 루틴 지시문 정본화) + 성재 그록봇 복구 시 S2·S3·결함 B 적용 재개 + 자연어 릴레이로 E2E 재수용 | M(성재 손) | SH-4 |
| **SH-9 · 오픈소스 위생** | `claudedocs/` gitignore(313MB·미추적 539) + 정본 REPORT 5건 docs 승격 · 절대경로 27파일·실명→역할 · ADR Status enum(`Proposed/Accepted/Superseded/Rejected` + Approved-by) · `.github` fork-safe(track-alignment 소유자 게이트·codex-goal 템플릿 영문/일반화·GOVERNANCE 스텁) · 이메일/SA 주소 정리 · `docs/INDEX`·`architecture/overview` 영문 요약 | M | — |

---

## 5. 내부 테스트 → 출시 재정의 (게이트)

ITO 계획(`2026-08-20-oss-launch-readiness-and-internal-test-plan.md`)의 시나리오 표(H1~H3·O1~O4·I1~I8)와 판정 계약(LAUNCH_READY/BLOCKED/NEEDS_MORE_INTERNAL)은 유효. 대상만 갱신:

- **G1 내부 테스트 진입 조건**: BT-6 마감 + 결재 3건 + track→main 승격 + **UX-R1(모션 토대)·UX-R2(온보딩 절정)·SH-1~SH-4 랜딩** + v0.1.4 발행. 이때 처음으로 "성재가 보고 만족할 수 있는 첫 5분"이 실물이 된다.
- **ITO 실행**: 성재+1인, 웹+데스크탑, H/O/I 표 + **에이전트 설치 스파이크**(Claude Code에 README 프롬프트 복붙 → 무개입 설치 → doctor PASS) 추가. 인테이크=전량 티켓화.
- **G2 출시 조건**: 외부 셀프호스터 3명 — **하네스 복붙 1 + 그록봇 1 + 클라우드(Railway) 1로 다변화 권고** + 에이전트 멘션·런 실사용 + LAUNCH_READY.
- 스토어/폰/Android는 보류 유지(ROADMAP §2).

---

## 6. 파이프라인·문서 리뉴얼 (편성안)

9/1 경량화(PR #1924)로 ROADMAP·STATUS·BUILD_TICKETS·JOURNAL·CURRENT_STATE는 이미 로테이션 체계에 들어갔다. 남은 것:

| # | 항목 | 왜 |
|---|---|---|
| P1 | **`docs/planning/PIPELINE.md` 단일 설정** — planner/검수/워커/리뷰어 **레인**(모델명이 아니라 역할)·병렬 상한·워크트리 루트·승인 역할. 하드코딩 16곳(CLAUDE·AGENTS·CODEX·planning/README·TRACKS·MULTI_SESSION_OPS·skills·issue template·settings.local)을 링크로 축약 | 모델 교체가 잦고(Codex→grok→cursor→Opus 5 Agent) 정본 둘(planning/README·TRACKS)은 아직 "Codex worker"라고 적혀 있음. 기획 검수 모델≠워커 모델이 상시 |
| P2 | **CODEX.md → AGENTS.md 병합·삭제**, AGENTS.md는 하네스 불가지론 워커 계약으로 개작 | 자인한 드리프트원, 실측 299줄 불일치 |
| P3 | CLAUDE.md 30줄 유지 + 진입 4줄(PIPELINE→CURRENT_STATE→JOURNAL→DEVIATION pending) | 경량 유지 |
| P4 | `.claude/commands/` 신설: `/planning-start`·`/flush`·`/goal-claim`; `settings.local.json` 85줄→패턴 5줄 | 파이프라인이 전부 산문 — 세션마다 재독 |
| P5 | codex-fleet·grok-fleet 스킬 은퇴 표기 → `worker-lane` 단일 스킬(Agent 레인 표준 spawn·감시·수거 계약) | 둘 다 죽은 레인 참조 |
| P6 | handoffs 275 → 닫힌 이슈분 archive; `docs/HANDOFF_2026-07.md` 은퇴; `DESIGN.md`↔`design-system/README.md` 정본 단일화(README 정본, DESIGN.md 스텁) | 색인 부담·이중 정본 |
| P7 | `scripts/planning_context.sh`(7/10) 갱신 — 로테이션 후 파일 형상 반영 + `--github` 보드 | 세션 첫 명령 |
| P8 | SH-9와 합류: claudedocs gitignore·실명/경로·ADR enum·영문 요약 | 오픈소스 대비 |

---

## 7. 순서 제안 (크리티컬 패스)

```
[즉시]  BT-6 이어받기 완주 → 파도 마감 → 결재 3건 → track→main 승격 → v0.1.4
[UXUI]  UX-R0(ADR-0179) → UX-R1 모션 토대 → UX-R2 온보딩 절정 → UX-R3 팔레트 → UX-R4 에이전트 표면 → UX-R5/R6
[엔진]  SH-1 매니페스트 → SH-2 공개 엣지 → #1265·#1925 → SH-3 CLI/doctor → SH-6 합류 GUI → SH-5 클라우드 → SH-7 잔여 → SH-8 그록봇
[파이프] P1 PIPELINE.md+P2 AGENTS 통합(1PR) → P4 commands → SH-9/P8 위생 → P5/P6/P7
        ─────── G1 내부 테스트 진입(UX-R1·R2 + SH-1~4) ─────── ITO ─────── G2 출시(3 셀프호스터 다변화)
```

병렬: UXUI·엔진·파이프 세 레인이 파일군 분리로 동시 진행 가능(워커 병렬 2~3). 모든 UI 랜딩은 design-review 폐곡선, 모든 엔진 랜딩은 ENGINE_HANDOFF ready 행.

---

## 8. 인터뷰 — 성재 결정 큐 (답이 편성을 바꾸는 것만)

| # | 질문 | 권고 |
|---|---|---|
| Q1 | **모션 구현 방식**: `motion/react` 도입(buzz 동형, 58파일 규모) vs CSS 토큰 전용 | 하이브리드 — CSS ladder가 정본, `motion/react`는 AnimatePresence/layoutId 필요 표면(팔레트·패널·리스트)에 한정. ADR-0179에서 확정 |
| Q2 | **토스트 정책**: 금지 유지(현행 게이트) vs 제한 허용 | 금지 유지 + 대안(in-place confirm·팔레트 상태줄·사이드바 카드) 정의를 ADR로 성문 |
| Q3 | **UX-R 순서**: 온보딩 절정(R2)과 팔레트(R3) 중 무엇이 먼저 | 모션 토대 → 온보딩 절정 → 팔레트(첫인상·내부테스트 G1에 온보딩이 필요) |
| Q4 | **셀프호스팅 우선 하네스·플랫폼**: Claude Code 복붙 / Codex / 그록봇 순서, 클라우드 1순위 | Claude Code 복붙(본인 하네스, 즉시 실측) → Railway → 그록봇(복구 시) |
| Q5 | **BT-6 재개 방식**: 이어받기 vs 재발사 | 이어받기(§0) |
| Q6 | **결재 3건**: 액센트 시안(새벽/성운/홍염/혜성/감람 중) · 승격 배치 go · A6 rich 기본 상향 | 액센트=성재 취향 / 승격 go / A6 상향 수용 |
| Q7 | **워커 레인 확정값**(PIPELINE.md에 박을 것): 워커=Opus 5 Agent 유지? 병렬 상한? 리뷰어=design-review fresh 유지? | Opus 5 Agent·병렬 2·design-review 유지. 모델은 "레인" 뒤에 숨겨 교체 비용 0 |
| Q8 | **영문화 범위**: SELF_HOST 3본+INDEX+architecture 요약만 vs ADR 전체 | 전자(ADR 76본 번역은 비용 대비 낮음, 제목·요약만 영문 색인) |
| Q9 | **그록봇 템플릿 실물**: 루틴 지시문(문서) vs 앱 내 템플릿(그록봇 제품 기능 확인 필요) | 성재가 그록봇 앱에서 "템플릿" 표면 존재 확인 후 결정 — 없으면 루틴 지시문 정본화 |
| Q10 | **폰 패리티 파도 시점**: UX-R 뒤 vs 병렬 | UX-R 뒤(모션 축이 폰 토큰에도 흘러야 함) |
| Q11 | UX-R2 웰컴 킥오프 **오프너 게시 주체**: 서버 시드 vs agent-worker 트리거 | agent-worker 트리거(실제 에이전트 발화라야 "봇 래핑 금지"와 정합) — engine ADR 기안 |

> 답 수신 → ADR-0179(모션 축)·오프너 주체 ADR·토스트 정책 ADR 기안 + UX-R/SH/P 티켓·패킷 발급 + BT-6 재발사. 워커 발사는 별도 go 신호([[worker-launch-requires-go]]).
