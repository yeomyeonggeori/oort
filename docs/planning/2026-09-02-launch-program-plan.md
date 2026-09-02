# 출시 프로그램 편성 정본 (2026-09-02) — UX-R · DS · SH · M · P

> 상위 브리프: `research/2026-09-02-launch-rediagnosis-two-pillars-brief.md`(진단·근원·인터뷰). **이 문서는 그 인터뷰의 답을 고정하고 티켓 수준으로 구체화한 편성 정본**이다. ROADMAP §1이 이 문서를 가리킨다.
> 상태: **계획 확정(2026-09-02 성재 승인 — "권고 전부 승인")·착수 전.** 다음 행동은 §10. 워커 발사는 별도 go 신호.

---

## 0. 고정된 결정

| # | 결정 | 출처 |
|---|---|---|
| D-1 | 모션 구현 = **하이브리드**: CSS 토큰 사다리(120/180/240/500ms + easing 2 + arrival distance/blur)가 정본, `motion/react`는 AnimatePresence/layoutId가 필요한 표면(팔레트·패널·리스트 삽입)에 한정 | 인터뷰 Q1 |
| D-2 | 토스트 **금지 유지** + 일시 확인 대안(in-place confirm·팔레트 상태줄·사이드바 카드)을 ADR로 성문 | Q2 |
| D-3 | UX-R 순서 = 모션 토대 → 온보딩 절정 → 팔레트 | Q3 |
| D-4 | 셀프호스팅 우선순위 = Claude Code 복붙 → Railway → 그록봇(복구 시) | Q4 |
| D-5 | BT-6 = wbt6-server 상태 **이어받기** | Q5 |
| D-6 | 결재 3건 승인: BZ-5a 액센트 **기본=새벽(Dawn)** 유지·나머지 4종 큐레이션 그대로 → #1922 머지 / track→main 승격 go / A6 rich 기본 상향 | Q6 |
| D-7 | 워커 레인 = Opus 5 Agent · 병렬 상한 2 · 리뷰 = design-review(fresh) 폐곡선. 모델명은 레인 뒤에 숨긴다(PIPELINE.md) | Q7 |
| D-8 | 영문화 = SELF_HOST 3본 + INDEX + architecture 요약 (ADR는 제목·요약 영문 색인만) | Q8 |
| D-9 | 그록봇 "템플릿" = 앱 표면 확인 전까지 **루틴 지시문 정본화**로 진행 | Q9 |
| D-10 | 폰 패리티 파도는 UX-R 뒤. 단 **QR 기기 연결(M0)은 G1 창 안에서 선행**(§6) | Q10 + 2026-09-02 모바일 발제 |
| D-11 | 웰컴 킥오프 오프너 주체 = **agent-worker 트리거**(실제 에이전트 발화) | Q11 |
| D-12 | 이미지 에셋 = 코드 SVG가 정본, 비트맵 생성은 시안·마케팅 한정. 생성기 우선순위 **gpt-image(codex-image 스킬) → grok CLI → OpenRouter** | 2026-09-02 발제 |
| D-13 | Android 보류 유지, App Store 전용. external TestFlight는 M7 게이트 뒤(불변) | ADR-0137 결정(6)·ROADMAP 불변식 |

---

## 1. 프로그램 구조 — 4레인 + 게이트 4

```
레인 UXUI   : UX-R0~R6 (표현 축·온보딩·팔레트·에이전트·상호작용·외양) + DS-0~6 (디자인시스템 재발 방지)
레인 엔진   : SH-1~9 (셀프호스팅) + BT-6 마감 + 킥오프 오프너 서버 절반
레인 파이프 : P1~P8 (문서·파이프라인 리뉴얼)
레인 모바일 : M0 (QR 기기 연결) → M1 (폰 패리티) → M2 (TestFlight internal) → [보류] Android

G0 파도 마감    = BT-6 랜딩 · 결재 3건 집행 · track→main 승격 · v0.1.4 발행
G1 내부테스트   = UX-R1·R2 + DS-0·1 + SH-1~4 + M0 + P1·P2 랜딩 → ITO(성재+1인, 웹+데스크탑+폰 QR 스모크)
G2 출시         = 외부 셀프호스터 3(하네스 복붙 1·그록봇 1·Railway 1) + 에이전트 멘션·런 실사용 + LAUNCH_READY
G3 v0 스토어    = 축 셋(관전·승인·대화) 폰 완주(M1) + M7 사용성 게이트 → external TestFlight → App Store
```

세 레인은 파일군이 분리돼 동시 진행 가능(워커 병렬 2). 모든 UI 랜딩은 design-review B0·H0, 모든 엔진 랜딩은 ENGINE_HANDOFF ready 행.

---

## 2. ADR 큐 (기안 순서 — go 신호 후 즉시)

| ADR | 제목 | 핵심 결정점(D) | 선행 |
|---|---|---|---|
| **ADR-0179** | 표현 축 신설 — 모션·눌림·엘리베이션·밀도 | D1 duration 사다리 120/180/240/500 + easing 2(standard/arrival) · D2 도착 모션 규격(distance 0.75rem·blur 2px) · D3 모달 비대칭(open 200/close 150) · D4 눌림 상태 정본(`active:` scale 0.98 + ink 전환, `button.tsx` 단일점) · D5 밀도 3단(compact/comfy/spacious) 토큰 + 가상 rem `--type-rem` · D6 `motion/react` 도입 범위(하이브리드) · D7 reduced-motion 이중 처리 · D8 강제 기제(`motion.test`·preflight raw-duration 금지·`waitForAnimations` 캡처 규율) · D9 폰 매핑(instant 0/fast 120/standard 180/slow 240 채택) | 없음 |
| **ADR-0180** | 기기 연결 — 1회용 QR 링크 토큰 | D1 토큰 = 발급 세션의 멤버에 귀속·TTL 120s·1회 소비·QR 페이로드 `oort://link?server=…&token=…` · D2 소비 = 폰 `POST /v1/devices/link` → 폰 세션(refresh) 발급, 발급자 화면에 "연결됨: <기기>" 수렴 · D3 SAS 4자리 대조는 **터널/공개 오리진 모드에서만** 필수(로컬은 생략) · D4 감사행 + 기기 목록에서 즉시 해제 · D5 ADR-0162 pairing·0166 claim 선례 재사용, 자격 비유입(0004) 유지 | 없음 |
| **ADR-0181** | 웰컴 킥오프 오프너 — agent-worker 트리거 | D1 가입 완료 이벤트 → agent-worker가 웰컴 채널에 오프너 run(실제 에이전트 발화, 봇 래핑 금지) · D2 멱등 마커(`welcome.opener.v1`·provider-required·closer) · D3 provider 미구성 시 안내 발화도 에이전트 경로(폴백 시스템 라인 금지) · D4 지연 백스톱 120s(buzz 실측) 후 "어디서 확인"형 안내 · D5 비용 원장 귀속(오프너도 원장에) | 없음(engine) |
| **ADR-0182** | 일시 확인(ephemeral confirmation) 정책 — 토스트 금지의 대안 | D1 금지 유지(게이트 그대로) · D2 허용 3형: in-place confirm(버튼 라벨 교체 ≤1.6s)·팔레트 상태줄·사이드바 카드(지속 결과) · D3 "결과가 사라져도 되는가"로 분류하는 결정 트리 · D4 aria-live 규율 | 없음 |
| (기존) | #1927 work host 패키징 방향 | Swift 데몬 이식 vs 사이드카 — SH-7 마지막 | SH-7 |

---

## 3. 레인 UXUI — UX-R 티켓 분해

규모: S ≤ 1회전 반나절 · M 1~2일 · L 2~4일(최근 속도 기준: 1레인 4일 25랜딩). 각 티켓은 핸드오프 패킷 + red proof 명시 + design-review 폐곡선.

| ID | 티켓 | 규모 | 선행 | red proof / 수용 |
|---|---|---|---|---|
| **UX-R0** | ADR-0179 집행 1: `motion.css` 토큰 사다리 + `motion.test` + preflight raw-duration 금지 + `button.tsx` 눌림 단일점 | S | ADR-0179 | 토큰 존재·reduced-motion 블록 단정 / 손으로 적은 ms 0건 |
| UX-R1a | 모달·팝오버·드롭다운·컨텍스트메뉴 enter/exit 비대칭(`modalMotion` 공용 클래스) | S | R0 | 열림 200·닫힘 150 캡처 프레임, reduced-motion에서 즉시 |
| UX-R1b | 드로어·스레드 패널·⌘K enter/exit + 사이드바 접기 사다리 흡수 | M | R0 | 패널 열림 중 캡처 금지(`waitForAnimations`) |
| UX-R1c | 스켈레톤 blur 크로스페이드(`t-skel`) — SkeletonRows 교체 | S | R0 | 로딩→콘텐츠 전이 2회 캡처 바이트 동일 |
| UX-R1d | 메시지 도착 `motion-enter-conversation`(one-shot animationName) + PendingRow 수렴 | M | R0 | 도착 1회만 재생·재마운트 무재생 |
| UX-R1e | 눌림 상태 전수: 버튼·행·칩·아이콘 버튼 `active:` (`hover:`140→짝) | M | R0 | active 프레임 캡처 레인 신설(rest/hover/active 3짝) |
| **UX-R2a** | BZ-6b 프로필 스텝(표시 이름·아바타·건너뛰기 상시·실패에도 전진) | M | BZ-4 서버(랜딩됨) | 저장 실패 시 전진 red proof |
| UX-R2b | BZ-6c 웰컴 킥오프 **클라**: 킥오프 스테이지(캐릭터 stagger 120ms)·첫 발화 도착 시 스테이지 exit·오프너 one-shot | M | ADR-0181 + R2s | 오프너 미도착 120s 백스톱 문구 |
| UX-R2s | 웰컴 킥오프 **서버**(engine): 가입 이벤트 → agent-worker 오프너 run + 멱등 마커 + provider-required 분기 | M | ADR-0181 | 중복 게시 0·provider 없을 때 안내 발화 |
| UX-R2c | S5 "첫 에이전트 연결"을 퍼널로: 하네스 카드(Claude Code/Codex/Grok Bot/OpenAI 호환) → 1회용 자격 → 감지 → 첫 멘션 (HostedAgentWizard 축약판 재사용) | L | SH-6a | 카드 4종·감지 폴링·건너뛰기 |
| UX-R2d | 온보딩 재진입 커맨드(⌘K "온보딩 다시 보기") + 4단계 카운터 정합 | S | R3a | — |
| **UX-R3a** | ⌘K 액션 팔레트 골격: 내비+명령 레지스트리(단일 정본 `commands.ts`)·키캡 힌트(A9 통합)·최근/빈도 랭킹·미라벨 아이콘 12 해소 | L | R1b | 명령 레지스트리 ↔ 단축키 정본 드리프트 가드 |
| UX-R3b | 팔레트 메시지 검색: 서버 검색(BT-3 스코프) + `from:`/`in:`/`before:` 연산자 + 결과 프리뷰 | M | R3a·BT-3 | 토큰 경계 연산자 파싱 시험(buzz 이식) |
| UX-R3c | 팔레트 중첩 모드: 채널 브라우저(S3 — 서버 "미가입 공개 채널" API 짝 engine S) · "에이전트에게 지시" | M | R3a | 미가입 채널 발견 → 참여 왕복 |
| **UX-R4a** | enabledTools 편집 UI(Agent Hub) — 차별화 순위 1 | S | 없음 | PUT profile 왕복·표시 전용 회귀 0 |
| UX-R4b | "지금 내 에이전트들" 단일 표면(rail·badge·panel·drawer 통합 설계) | L | R1 | 4곳 상태 불일치 0 |
| UX-R4c | provider 정체성 글리프(hermes/claude/codex/grok/openai 호환) — 벤더 공식 SVG, ADR-0172 예외 절차 + 카탈로그 카피 정책(한 문장·출처 주석·과장 금지) | S | 없음 | 아이콘 가드 예외 목록 고정 |
| UX-R4d | Agent Hub 분해(1,820줄 → 섹션 컴포넌트) | M | R4b | 기능 회귀 0(기존 시험 전량) |
| UX-R4e | 승인 축 독립 데모 도구 1종(work host 불요 실행 도구, engine) + A2A 체인 가시화(부모/자식 run·막힌 게이트 이름) | M | 없음 | 승인→실행 폐곡선 실측 |
| **UX-R5a** | 스레드 폭 리사이즈(A10) + 단축키 설정 섹션(A9 잔여) | S | R1b | — |
| UX-R5b | 적응형 quick reactions + 리액션 버스트(선택, reduced-motion 정지) | S | R0 | — |
| UX-R5c | 알림음·앱 배지(S6) | M | 없음 | 권한 3분기 유지 |
| UX-R5d | window-level 파일 드롭 오버레이 + 첨부 트레이 모션 | S | R0 | — |
| UX-R5e | ADR-0182 집행: in-place confirm 컴포넌트 + 팔레트 상태줄 | S | ADR-0182·R3a | preflight toast 0 유지 |
| UX-R5f | 선행 결함: #1919 모달 층 · #1915 헤더 겹침 · #1911 gate:composer 기준선 | M | 없음 | — |
| **UX-R6a** | BZ-5a 머지(D-6) + 5b: 폰트 3단(`--type-rem`)·밀도 3단·라이브 프리뷰 | M | ADR-0179 D5 | `check-px-text` 게이트 신설 |
| UX-R6b | 5c(선택): squircle·panel-left 그림자·텍스처 카드 | M | R6a | 성재 시안 1회 |

---

## 4. 레인 UXUI — DS 시리즈 (반복 UXUI 이슈의 구조적 대응)

목적: 성재 피드백이 "티켓 n개"가 아니라 **"축 하나"**로 닫히게 만든다. 감사 회전 통계(A5~BZ-5a 2~4회전, 워커 상습 5축)가 근거.

| ID | 내용 | 효과 |
|---|---|---|
| **DS-0 표현 축** | ADR-0179 토큰(모션·눌림·엘리베이션·밀도)이 tokens.css의 **정본 층**에 들어간다. 일회성 `--spacing-*` 명명 기하 추가는 "축 부재의 증상"으로 간주 → 새 명명 기하 PR은 축 후보 검토 의무 | tokens.css 2,678줄 증가 정지 |
| **DS-1 프리미티브 층** | raw 유틸리티와 명명 유틸리티 사이에 **표준 컴포넌트 12종**(Button/IconButton/MenuItem/Row/Chip/Panel/Sheet/Dialog/Popover/Field/Banner/Skeleton)을 `src/design/ui`에 정착, 4상태(기본/hover/active/focus)+빈/로딩/오류/오프라인이 **컴포넌트에 내장**. 신규 표면은 이 12종만 조립 | 리뷰 상습 축(대비·포커스·터치 타깃)이 컴포넌트 단위로 1회 해결 |
| **DS-2 갤러리 라우트** | `--mode design` 전용 `/design` 라우트에 12종 × 상태 × 스킴을 한 화면에. `capture:design`이 이 페이지를 매 PR 찍어 **컴포넌트 회귀를 픽셀로 잡음**(Storybook 대체, buzz도 없음) | design-review가 화면 대신 갤러리부터 본다 → 회전 감소 |
| **DS-3 측정 확장** | rest/hover/active 3짝 캡처 레인 · `waitForAnimations` 규율(애니메이션 중 캡처 금지) · `motion.test` · `check-px-text` · 파일 1,000줄 ratchet(`check-file-sizes`) · 아이콘 aria 라벨 자동 계측(§2.8 "무검사" 해소) | §5.3 "사람만이 잡는 것" 목록 축소 |
| **DS-4 리뷰 루프** | design-review 루브릭에 모션·눌림·밀도 축 추가 · 워커 상습 5축(가짜 초록·픽스처 인하·4자 픽스처·수리 회귀·자 부분상속)을 **preflight 기계 검사**로 이관(가능한 3축) · R1은 갤러리 diff부터 | 2~4회전 → 1~2회전 |
| **DS-5 폰 동기** | `clients/mobile/src/design/tokens.ts`가 모션·밀도 토큰을 **웹 tokens.css에서 파생**(paletteContrast.test 동형) + 폰 preflight 신설(현재 0) | 폰이 "거의 백지"인 모션 축 해소 |
| **DS-6 인테이크 규율** | 성재 피드백 인테이크 시 분류 1줄 필수: **패턴(→DS 티켓) / 개별(→UX 티켓) / 결함(→bug)**. 같은 축 피드백 2회면 자동 DS 승격 | 즉흥 수리·중복 티켓 소멸 |

순서: DS-0(=UX-R0) → DS-1·DS-2(UX-R1 병행) → DS-3·DS-4(UX-R3 전) → DS-5(M1 진입 조건) → DS-6(즉시 규율).

---

## 5. 레인 엔진 — SH 티켓 분해

| ID | 티켓 | 규모 | 선행 | 수용 |
|---|---|---|---|---|
| **SH-1** | `releases/latest.json` 매니페스트(버전·app/pg list digest·attestation 커맨드) 발행 파이프라인 산출 + SELF_HOST/AGENT/README가 참조(산문 digest 0건 게이트) + RELEASING 갱신 | S | 없음 | 문서 grep `@sha256:` 0 |
| **SH-2** | #1926 공개 엣지 파라미터화(사이트 주소+CSP connect-src env 템플릿, ACME 오발사 차단, 와일드카드 금지) + README 은퇴 런북 링크 교체 | M | 없음 | off-host compose에서 ACME 0회 |
| **SH-3a** | `oort` CLI 골격 + `doctor`(silent-fail env 키·포트·볼륨·digest·attestation → JSON PASS/FAIL) | M | SH-1 | 조용히 죽는 키 7종 전부 적발 |
| SH-3b | `status`·`logs`·`upgrade`(멱등 재기동 코드화)·`backup/restore`(pg_dump 흡수)·`member`(초대·자격 발급) | M | SH-3a | 업그레이드 1왕복 실측 |
| **SH-4a** | `docs/SELF_HOST_AGENT.md` → **영문 하네스 불가지론 정본**(환경 분기 표: 로컬/VPS/그록봇 VM/Railway/Fly/AWS/GCP, 각 단계 `oort doctor` 게이트) + 한국어판 | M | SH-3a | Claude Code 복붙 무개입 설치 1회 실측 |
| SH-4b | README "Paste this into your agent" 프롬프트 블록 + `llms.txt` 하네스 일반화 + SELF_HOST·FIRST_DAY 영문 정본 | S | SH-4a | — |
| **SH-5a** | Railway 템플릿(`railway.json` + PG 플러그인 + 단일 이미지 + 공개 도메인 → SH-2 env) 1회 E2E | M | SH-2·SH-3a | Railway 배포 → doctor PASS → 폰 QR 연결 |
| SH-5b | Fly(`fly.toml`+volume) + AWS/GCP "VM+compose+도메인" 런북(+최소 Terraform) | M | SH-5a | 각 1회 E2E |
| **SH-6a** | 외부 도구 자격 발급 GUI(설정 › 에이전트 › 자격) + 로컬 OpenAI 호환 `http://127.0.0.1` opt-in | M | 없음 | UX-R2c 소비 |
| SH-6b | 도어벨 벨테스트(#1735 잔여) + hosted pairing 웹 경로(데스크탑 위저드 의존 해소) | S | 없음 | — |
| **SH-7** | blocker 순서: #1265 웹훅 인바운드 → #1925 허들 3키+프로파일 → #1792 TURN(SH-2 후) → #1927 work host(ADR) | L | SH-2 | 감사 blocker 표 소멸 |
| **SH-8** | 그록봇: 루틴 지시문 정본화(§4.4) + VM축 재개(S2·S3·결함 B) + 자연어 릴레이 E2E 재수용 | M(성재 손) | SH-4a | — |
| **SH-9** | OSS 위생: `claudedocs/` gitignore + 정본 REPORT 5건 docs 승격 · 절대경로 27파일·실명→역할 · ADR Status enum + Approved-by · `.github` fork-safe · 이메일/SA 정리 · `docs/INDEX`·architecture 영문 요약 | M | 없음 | gitleaks·grep 게이트 |

---

## 6. 레인 모바일 — M 시리즈 + 착수 시점 진단

### 현황(실사 2026-09-02)
- RN 0.86 + Expo 모듈 57, iOS 전용. 11화면·47컴포넌트(웹 155). ConnectScreen = 서버 주소·초대 코드·로그인 + `oort://join` 프리필. 세션=키체인, 서버 주소=MMKV. **QR·카메라 0.** NSE·PushKit·Xcode Cloud 그린·TestFlight internal 런북 실존(external은 M7 게이트 뒤).
- v0 축 셋: 대화 ○ · 관전 부분(WorkConsole·WorkSessionDetail 화면 실존) · 승인 부분(잠금화면 승인 실물). 패리티 적립 티켓: #1908 #1892 #1876 #1748 #1752 #1604 #1600 #1396 #1278.
- 모션·밀도 토큰 폰 매핑 미채택(디자인시스템 §2.6 "폰은 거의 백지").

### buzz 대조
buzz 폰 페어링 = 데스크톱 QR → 폰 스캔 → 양쪽 6자리 SAS 대조 → 릴레이로 신원(nsec) 전송. 우리는 서버 계정이라 **"신원 전송"이 아니라 "기기 세션 발급"**으로 번역된다(ADR-0180) — 더 짧고, 서버가 감사·해제를 갖는다.

### 판정 — "지금 vs 셀프호스팅 이후"
| 축 | 판정 | 근거 |
|---|---|---|
| **M0 QR 기기 연결** | **지금(G1 창 안)** | 서버 S(토큰 라우트 1+소비 1)·웹 S(설정 › 기기 QR + 온보딩 S5 "폰에서도 쓰기")·폰 M(expo-camera 스캔 화면 1). 셀프호스팅 blocker와 무관. ITO에서 "폰이 30초 만에 붙는다"가 실물이 되고, Railway E2E(SH-5a)의 수용 마지막 칸으로 쓴다. 성재 발제("QR만 찍으면 연동")와 정합 |
| **M1 폰 패리티 파도** | **G1 이후, ITO와 병렬** | 출시 정의(G2)에 폰이 없고 ITO는 웹+데스크탑 중심. 반면 v0 스토어(G3)는 폰 축 셋이 조건. 모션·밀도 축(ADR-0179)이 먼저 서야 폰 토큰이 파생(DS-5)되므로 UX-R 뒤가 맞다 |
| **M2 TestFlight internal** | **M0 직후**(1클릭 거리) | 성재 도그푸드용. external은 M7 뒤(불변) |
| Android | 보류 유지 | D-13 |

### 티켓
| ID | 티켓 | 규모 | 선행 |
|---|---|---|---|
| **M0s** | ADR-0180 서버: `POST /v1/devices/link-token`(발급자 세션 귀속·TTL 120s·1회) · `POST /v1/devices/link`(소비 → 폰 세션) · 감사행 · 기기 목록 해제 | S | ADR-0180 |
| **M0w** | 웹/데스크톱: 설정 › 기기 "폰 연결" QR 카드(만료 카운트다운·재생성·SAS 표시(공개 오리진 모드)) + 온보딩 S5 진입점 | S | M0s |
| **M0m** | 폰: ConnectScreen "QR로 연결" (expo-camera) → link 소비 → 세션 저장 → SAS 대조(모드별) → 워크스페이스 착지. Maestro 플로 1본 | M | M0s |
| M1a | DS-5 폰 토큰 파생(모션·밀도) + 폰 preflight 신설 | S | ADR-0179 |
| M1b | 관전 축 완주: 작업 세션 관전 표면 + 제어 개입(웹 TC-1 동형) | L | M1a |
| M1c | 승인 축 완주: 인박스 승인 4상태 + 잠금화면 결정 + 실서버 폐곡선 실측 | M | M1a |
| M1d | 웹 전용 축 이관 묶음: #1908 초안·#1892 점프 항법·#1748 피커·#1752 컴포저·#1876·#1604·#1600·#1396 | L | M1a |
| M1e | 폰 온보딩 패리티(S0~S5 축약 + 킥오프 수신) | M | UX-R2 |
| **M2** | TestFlight internal 재개(런북 §5~§6, 성재 손) | S(성재) | M0 |

---

## 7. 레인 파이프 — P 시리즈

| ID | 티켓 | 규모 |
|---|---|---|
| **P1** | `docs/planning/PIPELINE.md` 단일 설정: 레인 표(planner/검수/워커/리뷰어 — **역할과 현재 값 분리**)·병렬 상한·워크트리 루트 변수·승인 역할·spawn 계약 요약. 하드코딩 16곳 링크화(CLAUDE·AGENTS·planning/README·TRACKS·MULTI_SESSION_OPS·skills·issue template·settings.local) | M |
| **P2** | CODEX.md → AGENTS.md 병합·삭제. AGENTS.md = 하네스 불가지론 워커 계약(Codex 전용 문면 제거, `@codex implement` 템플릿 일반화) | M |
| P3 | CLAUDE.md 진입 4줄(PIPELINE→CURRENT_STATE→JOURNAL→DEVIATION pending) 정리 | S |
| P4 | `.claude/commands/`: `/planning-start`·`/flush`·`/goal-claim`; `settings.local.json` 85줄→패턴 5줄 | S |
| P5 | `codex-fleet`·`grok-fleet` 스킬 은퇴 표기 → `worker-lane` 단일 스킬(Agent 레인 spawn·감시·수거·회수 계약, 모델은 인자) | M |
| P6 | handoffs 275 → 닫힌 이슈분 archive · `docs/HANDOFF_2026-07.md` 은퇴 · `DESIGN.md` 스텁화(정본=design-system/README) | S |
| P7 | `scripts/planning_context.sh` 로테이션 형상 반영 + `--github` 보드 | S |
| P8 | (=SH-9 문서면) 영문 INDEX·architecture 요약 | — |

순서: P1+P2(1PR) → P4 → P3·P7 → P5·P6.

---

## 8. 에셋 파이프라인 (D-12)

- **정본은 코드**: 인앱 아이콘 = lucide(ADR-0172), 온보딩 소도형·마스코트 = 라인아트 SVG(마스코트 본체 변형은 성재와), 상태 일러스트 없음(빈 상태는 문장 1개+행동 1개).
- **비트맵 생성이 허용되는 자리**: ①온보딩·빈 상태 **시안 탐색**(생성 → 성재 1회 확인 → 라인아트 SVG로 재작성) ②README 히어로·OG·랜딩 사이트·릴리스 노트 ③provider 글리프는 생성이 아니라 **벤더 공식 SVG**.
- **생성기 순서**: `codex-image` 스킬(gpt-image-2, ChatGPT 인증) → grok CLI imagine → OpenRouter(대안 모델 필요 시). 산출은 `docs/brand/concepts/`에 시안 번호로, 채택본만 `docs/brand/`.
- 금지: AI 그라디언트·네온·3D(디자인시스템 preflight `ai_gradient` 그대로).

---

## 9. 순서·병렬 (파도 단위)

```
G0  [엔진] BT-6 이어받기 → 랜딩 → #1922 머지·A6 상향 → 승격 배치 → v0.1.4
    [파이프] P1+P2 (동시)
W1  [UXUI] ADR-0179 → UX-R0 → R1a~e (DS-1·DS-2 병행)      [엔진] SH-1 → SH-2 → M0s      [파이프] P4·P3·P7
W2  [UXUI] ADR-0181/0182 → R2a·R2s·R2b → M0w              [엔진] SH-3a → SH-6a → M0m(폰)
W3  [UXUI] R2c·R2d → R3a·R3b·R3c (DS-3·DS-4)               [엔진] SH-4a·SH-4b → SH-5a(Railway E2E, 마지막 칸=M0 QR)
    ───────────────── G1 내부 테스트 진입 · ITO 개시 · M2 TestFlight internal ─────────────────
W4  [UXUI] R4a~e → R5a~f → R6a                             [엔진] SH-7(#1265→#1925→#1792) · SH-5b · SH-6b · SH-9   [모바일] M1a~e 개시
W5  [UXUI] R6b(선택) · ITO 인테이크 수리 파도                [엔진] SH-8 그록봇 · #1927 ADR                          [모바일] M1 계속
    ───────────────── G2 출시(셀프호스터 3 다변화) ─────────────────
W6+ [모바일] M1 완주 → M7 게이트 → G3 external TestFlight/App Store · Android 재점화 판단
```

- W = 파도(랜딩 묶음), 날짜 아님. 최근 속도(1레인 4일 25랜딩)면 W1~W3가 약 2주, 워커 병렬 2 전제.
- 매 파도 종료 시: track→main 승격 + sync 짝(상시 위임) · 검수 앱 재빌드 · 인테이크 분류(DS-6).

---

## 10. 다음 행동 (go 신호 후 순서)

1. **ADR 4본 기안**(0179·0180·0181·0182, Proposed) → 성재 Accept.
2. **G0 집행**: BT-6 이어받기 워커 발사 → 랜딩 → #1922 머지·A6 상향 커밋 → 승격 배치 → v0.1.4 발행 창(성재 attended).
3. **티켓·패킷 발급**: UX-R0~R1e · DS-1·2 · SH-1~3a · M0s/w/m · P1~P4 (BUILD_TICKETS 수용기준 + handoffs 패킷 + GitHub Issue, 의존 순서 명시).
4. 파도 W1 발사(병렬 2: UXUI 1 + 엔진 1).

정지 조건: ADR Accept 전 경계 변경 착수 금지 · 워커 발사는 명시 go · 성재에게 보여주는 빌드는 트랙 워크트리 빌드 고지.
