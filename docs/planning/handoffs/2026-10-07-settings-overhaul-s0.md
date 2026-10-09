# 설정 전면 개편 S0 핸드오프 — IA·컴포넌트·모양·슬라이스 (#3578)

- status: ready (S0 설계 완료, 성재 결재 반영 2026-10-07)
- issue / planning ID: #3578 (에픽)
- owner / reviewer: Sonnet 5.5(planner) / design-review(fresh) B0·H0
- track / base commit: uxui · `origin/track/uxui` @ `75940c55d` 이후
- supersedes: 없음. ADR-0189 증보 1(이번 PR)이 밀도·글자 크기·테마 선택·유리 토글 결정을 정본화한다.

## Goal
설정 화면을 Buzz 수준의 정보 구조와 오르트 구름 디자인 시스템으로 다시 짠다. 19행 목차를 12행으로 줄이고(개인 / 워크스페이스 / 앱·연결), 프로필+계정을 합치고, 모양(테마) 페이지를 Buzz급으로 만들고, 레거시 「실행 엔진」을 걷는다. 문구는 해요체(#3573은 머지됨).

## 성재 결재 (2026-10-07, AskUserQuestion 원문)
- 밀도·글자: 「Buzz처럼 밀도 3단」(+글자 크기 3단 작게/기본/크게)
- 테마·유리: 「테마 + 유리 토글 둘 다」(흑연·노을띠 선택 열기 + Buzz식 glass background toggle and opacity)
- 나가기 위치: 「프로필 아래 위험 구역 (Recommended)」
- 병합 범위: 「이대로 (Recommended)」(19→12행)
- 정본: ADR-0189 증보 1. 밀도 3단·글자 크기·유리는 그쪽 D1~D4가 기준이고, 이 문서의 모양 절은 그것을 화면으로 옮긴 것이다.

## 참고 자료 (로컬, 미커밋)
- 프로토타입 HTML·캡처(현재 상태 `before/`, 제안 `shots/`)와 원본 스펙은 기획 세션 스크래치 `s0-settings/`에 있다. 이 문서가 구현에 필요한 내용을 모두 옮겼으므로 없어도 구현할 수 있다.
- Buzz 참조는 `~/projects/reference/buzz/desktop/src`(commit `af5bb0a`, Apache-2.0)의 file:line이다.

## 0. 한 줄 진단 (현재 상태)

현재 설정은 DS2-6(떠 있는 판 문법)에 들어오지 못한 채 남은 면이에요. 근거는 코드에 있어요.

1. `tokens.css` `&[data-settings-surface]`가 `background: var(--pane)` 평면에 판 문법을 걷어 냈고(`/* 설정 전면은 떠 있는 판 문법 밖이다(DS2-6 범위 밖…) */`), 목록 열이 `border-inline-end: 1px solid var(--line)`을 전 높이로 그려요. 이 선이 성재가 말한 「허공에 뜬 구분선」이에요(`before/profile-1440-light.png`의 x=240 세로선).
2. 목록 행은 앱 사이드바가 쓰는 `sidebar-row`/`sidebar-row-selected`(34px, 아이콘 18, 흰 면+rest 그림자)를 안 쓰고 `settings-nav-item` + `bg-accent-soft`(호박 채움)을 써요. 앱 사이드바와 문법이 달라요.
3. 본문은 `SectionShell`(제목 `text-title` + 줄글) + 평면 `Field`/`ChoiceRadios`예요. 카드·행 프리미티브가 없어서 간격이 화면마다 제각각이에요(`gap-4`/`gap-2`/`gap-px`가 파일마다).
4. 팔레트 3종(새벽하늘·흑연·노을띠)은 코드(`design/themes/palettes/*.css`, core `THEME_IDS`)에 있지만 고르는 자리가 없어요(`design/theme.ts` `ACTIVE_PALETTE_ID = DEFAULT_THEME_ID` 고정, DS2-7 #2719 미착수).
5. 레거시: 「실행 엔진」(워크스페이스 단위 opencode/goose/codex-local), 문만 남은 4개 목차 행(앱·외부 에이전트 연결·채널로 들어오는 주소·밖으로 보내는 알림, AIH-8 이후 클릭하면 AI 허브로 튕김), 프로필과 계정 분리, 링크 미리보기가 테마와 따로.

## 1. 현재 설정 전수 감사

기준: 목차 19행(`settingsNav.ts` `SETTINGS_SECTIONS`) + 화면 안 블록. 「DS 사용」은 `design/ui`·`SettingsFields` 프리미티브와 토큰 클래스 사용 여부. 문체는 #3579 이후 grep 집계(합쇼체 `…습니다`/해요체 `…해요`).

| 목차(id) | route | 컴포넌트 (줄 수) | DS 사용 / 임시 스타일 | 레거시 흔적 | 문체 | 범위 (코드 근거) | 판정 |
|---|---|---|---|---|---|---|---|
| 프로필 `profile` | `/settings?section=profile` (기본값 `DEFAULT_SETTINGS_SECTION`) | `ProfileSection` 251, `ProfileAvatarField` 205, 아바타는 `timeline/MessageRow.tsx` `Avatar`(size-8 고정) | `SectionShell`/`Field`/`Input`/`SaveButton`/`HandleField`. 임시 스타일 없음. 단 아바타 32px에 이니셜뿐이라 히어로가 없음 | 서버가 사진 업로드를 받는 기능(#3277)은 새것. 레거시 없음 | 해요체 | **워크스페이스 안의 나**: `changeMyProfile(workspaceId, …)`가 이 워크스페이스 멤버 행을 바꿔요(`ProfileSection.tsx` save). 계정이 아니라 멤버 프로필 | **병합(계정과) → 프로필** (S2) |
| 계정 `account` | 〃 | `AccountSection` 37 | `KeyValueRows`, `Button variant="outline"`. 이름·핸들은 프로필과 중복. UUID 전문 노출 | 없음 | 해요체 | 세션(`useSession().logout`), 멤버 ID 표시 | **삭제(프로필로 흡수)**. ID 두 줄은 「계정 정보」 카드, 로그아웃은 「로그인」 카드 |
| 기기 `devices` | 〃 | `DevicesSection` 92, `DeviceKeysBlock` 1301, `LinkedDevicesList` 343, `DeviceLinkCard` 483 | `SectionShell` + 자체 블록. 카드·행 없이 줄글 | 「뿌리·지시 기기」 용어는 #3573이 걷음 | 해요체(#3579) | **개인**: `listDeviceKeys(workspaceId)`로 내 키, QR 연결 기기는 내 계정. 서명은 데스크탑만(`signing = isDesktop() && …`) | **유지·이동 → 기기(개인)**. 이 맥 호스트·내 재개 정책이 여기로 합류 (S4). 문구는 #3573 소유라 S4는 구조만 만져요 |
| 테마 `appearance` | 〃 | `AppearanceSection` 94 | `ChoiceRadios` + 손으로 짠 `label.accent-swatch` 5개. 미리보기 없음, 설명 줄글 3줄 | 옛 키 `momo.web.theme.v1` 이관 코드는 `theme.ts`에 있음(읽기 전용) | 해요체 | **이 기기**: `localStorage momo.web.appearance.v1` (`theme.ts` `APPEARANCE_STORAGE_KEY`), 서버 무관 | **재작성 → 모양** (S3) |
| 링크 미리보기 `link-previews` | 〃 | `LinkPreviewSection` 59 | `ChoiceRadios`. 같은 이름의 서버 토글이 `WorkspaceSection`에 또 있음(워크스페이스 전체, 운영자) | 파일 주석이 「BZ-5a가 외양 패널로 옮길 때 이 섹션 단위 그대로」라고 이미 예고 | 해요체 | **이 기기**(`linkPreviewPreference`) | **병합 → 모양**의 「대화 표시」 카드. 서버 토글은 이름을 「링크 확인(서버)」로 구분 (S5) |
| 알림 규칙 `notifications` | 〃 | `NotificationRulesSection` 162, `DesktopNotificationGroup` 407 | `Subsection`, `SettingsToggleRow`(체크박스 행). 두 범위가 한 쪽에 섞임 | 소제목 「워크스페이스 규칙」이 실제로는 **내** 규칙 | 해요체 | **두 층**: 일시중지·멘션 예외는 서버 `/v1/workspaces/{ws}/notification-rules`(「for me in this workspace」, `notificationRules.ts` 머리말), OS 알림 종류별은 이 기기 | **유지·개명 → 알림**. 소제목 「내 알림 규칙」·「이 기기 알림」. 체크박스 행은 `Toggle` 행으로 (S5) |
| 터미널 `terminal` | 〃 | `TerminalSection` 136 | `SectionShell` + 표. 브라우저에선 「로컬 터미널 없음」 안내만 | 없음 | 해요체 | 이 기기(데스크탑) | **병합 → 단축키**의 「로컬 터미널」 카드 (S5) |
| 단축키 `shortcuts` | 〃 | `ShortcutsSection` 429 | `Input type=search`, `Button`, 직접 짠 표. 재지정은 이 기기(브라우저) | 없음 | 해요체 | 이 기기 | **유지** (S5에서 행 프리미티브 정리) |
| 업데이트 `updates` | 〃 | `features/updates/UpdateSection` 165 | `desktopOnly: true`로 브라우저에선 숨김 | 없음 | **합쇼체 2건 남음**(코드 추출 기준 `…습니다`) | 이 기기(앱 번들) | **유지·이동 → 앱·연결** + 문체 정리 (S5, #3573이 놓친 유일한 곳) |
| AI `ai` | 〃 | `AiLinkSection` 982 (+`AiMyAccountsSection`, `AiDefaultsTable`, `aiAccountsParts`) | 자체 `AiSection` 계열 레이아웃(셸 우회). 본문 위에 `AiHubMovedLink` 한 줄 | **ADR-0198 D3**: 구독 CLI는 「내 도구」로, AI 허브가 정본. 이 화면은 이행 중간 상태 | 해요체 | 혼합: 내 구독(이 맥)=개인, 팀 AI 키=운영자 | **교체 → 「AI 허브 ↗」 링크 행**. 본문은 T3(AI 허브 내 도구)가 끝날 때까지만 유지 후 삭제 (S5/ADR-0198 T3) |
| 외부 에이전트 연결 `agents` · 앱 `plugins` · 채널로 들어오는 주소 `webhooks` · 밖으로 보내는 알림 `events` | 〃 | `SettingsRoute`의 `aiExternalRowFromSettings` 리다이렉트 + `AiHubMovedLink` (섹션 컴포넌트는 이미 AI 허브로 이동) | 목차에 행은 있지만 눌러도 설정 화면이 안 바뀌고 `navigate(path)` (SettingsRoute `onClick`) | AIH-8의 잔재 | 해당 없음 | 워크스페이스(운영) | **목차에서 삭제**. 옛 딥링크 `?section=…`는 `aiExternalRowFromSettings` 리다이렉트로 계속 받아요 (S1) |
| 워크스페이스 `workspace` | 〃 | `WorkspaceSection` 1274 | `SectionShell` 안에 `Subsection` 7개(링크 미리보기 서버 토글, 역할 표시명, 웰컴 킥오프, 새 워크스페이스 만들기, 워크스페이스 나가기 등), `OperatorNotice` 403 처리 | 없음 | 해요체(43건) | **워크스페이스 전체**(소유자·관리자 쓰기), 「나가기」·「새로 만들기」는 개인 행동 | **유지**, 카드 단위로 분할 (S5). 나가기는 프로필 위험 행으로 이동(결재) |
| 기억 `memory` | 〃 | `memory/MemorySettingsSection` 311 | `Subsection` 「내 기억」「워크스페이스」「기억 살펴보기」. 서버가 `teamMemory` 표면을 실을 때만 목차에 섬 | 없음 | 해요체 | **혼합**: 내 일시정지=누구나, 팀 스위치=관리자(파일 주석) | **유지(워크스페이스 그룹)**. 카드마다 범위 칩으로 구분 (S5) |
| 멤버와 초대 `members` | 〃 | `InviteSection` 299, `IssuedInviteCard` | `SectionShell`, 폼 | 없음 | 해요체 | 워크스페이스(발급은 관리자) | **유지** (S5) |
| 사용량 `usage` | 〃 | `UsageSection` 776, `ProviderQuotaBlock` 479 | 표·게이지 직접 구성 | 없음 | 해요체 | 워크스페이스 읽기(「멤버라면 누구나 볼 수 있어요」) | **이동**(연결→워크스페이스 그룹), 내용 유지 (S5) |
| 코드 실행 호스트 `code` | 〃 | `WorkHostSection` 1005, `ThisMacHostBlock` 519 | 4개 블록 모두 `Subsection`. 데스크탑이면 서버 표면 없이도 목차에 섬(`desktopAlways`) | **「실행 엔진」 블록(EngineBlock)이 레거시**. 아래 표 | 해요체 | 아래 표(블록마다 다름) | **분해** (S4) |

### 1.1 「코드 실행 호스트」 블록별 범위

「지시 기기·실행 호스트는 개인」이라는 성재 말을 코드로 확인했어요. 결과는 **블록마다 달라서 통째 이동하면 틀려요**.

| 블록 | 코드 | 범위 | 근거 | 조치 |
|---|---|---|---|---|
| 이 맥을 실행 호스트로 등록(`ThisMacHostBlock`) | 데스크탑 전용 | **개인** | 데스크탑이 등록할 때 `scope:"member"`를 보내요(`clients/desktop/src-tauri/src/work_host.rs:1720,1805`), 소유자=나 | → **기기(개인)** |
| 실행 엔진(`EngineBlock`) | `fetchWorkHostEngine`/`putWorkHostEngine`, `WORK_ENGINES` | **워크스페이스 전체**, 운영자만 | `server-rust/crates/momo-settings/src/engine.rs` 「per-workspace… every statement runs inside `with_tenant_tx`」, 라벨 3종 CHECK(migration 040), 403이면 `OperatorNotice` | **삭제**(아래 1.2) |
| 등록된 호스트(`RegistryBlock`) | `listWorkHosts` | **워크스페이스 읽기** | `routes/work_hosts.rs:538 list`가 `list_work_hosts`(RLS 안 전체)를 **활성 멤버 누구에게나** 돌려줘요. 다른 사람의 개인 맥도 목록에 나옴(`workHostScopeLabel`: member=「개인」, workspace=「워크스페이스 공용」) | 내 맥은 기기로, 목록은 「실행 호스트」 워크스페이스 페이지에 남김. 남의 개인 맥이 보이는 것은 별도 확인 거리(아래 위험 R6) |
| 호스트 상실 시 재개 — 내 정책(`scope="member"`) | `putWorkTierPolicy(…, "member", …)` | **개인** | `TierPolicyBlock` 「member override」, 저장 버튼 「내 정책 저장」 | → **기기(개인)** |
| 호스트 상실 시 재개 — 기본값(`scope="workspace"`) | 〃 `"workspace"` | **워크스페이스**, 소유자·관리자 | 저장 버튼 「워크스페이스 기본 저장」, 비운영자는 `OperatorNotice` | → **실행 호스트(워크스페이스)** |

### 1.2 레거시 「실행 엔진」 제거 범위

- 클라 UI(S4): `WorkHostSection.tsx` `EngineBlock`(L141~) 전체, 목차 설명 문장(「어떤 엔진으로 돌릴지…」), `WORK_ENGINES`(`packages/momo-core/src/features/settings/model.ts:49-65`)와 `model.test.ts`의 해당 케이스, `api.ts`의 `fetchWorkHostEngine`/`putWorkHostEngine`, 캡처 스크립트 4개가 스텁하는 `/work-host-engine`(`capture-screens.mjs`, `capture-device-keys.mjs`, `capture-this-mac.mjs`, `gates/gate-shell-layout.mjs`), `rawControlBusySplit.test.ts`의 EngineBlock 케이스.
- 서버(별도 engine 트랙 이슈, ADR-0100 적용): 라우트(`routes/provider_settings.rs`, `routes/shared.rs`, `dto.rs`), `momo-settings/src/engine.rs`, migration 040 CHECK 제약(테이블은 남기고 「미사용」 표기가 안전), `docs/api/openapi.undocumented-allowlist.json`, `scripts/openapi_sampled_on_rust.txt`, `bins/momo-server/tests/settings_conformance_pg.rs`. 이 기능을 읽는 workd 코드는 이 저장소에서 찾지 못했어요(`grep work_host_engine|WorkEngine`이 서버·문서·클라 스텁에만 걸림). 소비자가 정말 없는지는 engine 트랙이 확인하고 제거해요.
- 혼동 금지: `momo-t3/src/work_share.rs`의 `HARNESSES = ["claude","codex","grok","opencode","shell","other"]`는 작업 공유 요약 라벨이라 **다른 것**이에요. ADR-0198 D1 어휘(하네스=내 도구)와 정합하는 이름이라 그대로 둬요.
- ADR-0198과의 정합: 「엔진은 워크스페이스에 하나」라는 모델은 「하네스는 사람마다, 내 맥에서 돌고 마지막에 쓴 것이 기본」(D4)과 충돌해요. 그래서 UI 제거가 맞고, 대체 표면은 ADR-0198 T3(AI 허브 「내 도구」 카드, 다른 슬라이스)예요. S4는 그 카드와 겹치지 않게 「기기」에 **이 맥 호스트 블록만** 두고, T3가 합쳐 가면 그 블록을 카드로 옮겨요.

## 2. 새 정보 구조

### 2.1 그룹과 페이지 (19행 → 12행)

그룹 이름은 **범위**예요(권한이 아님. `settingsNav.ts` 머리말과 같은 원칙). 각 페이지 머리에 `ScopeChip`으로 범위를 명시해서 「개인이냐 워크스페이스냐」를 사람이 판단하지 않게 해요.

| 그룹 | 페이지 (id) | 아이콘(lucide) | 범위 칩 | 합쳐지는 것 / 이동 |
|---|---|---|---|---|
| **개인** | 프로필 (`profile`) | `UserRound` | 「이 워크스페이스에서 보여요」 | 프로필 + 계정 + (로그아웃, 워크스페이스 나가기 위험 행) |
|  | 모양 (`appearance`) | `Palette` | 「이 기기에만 저장돼요」 | 테마 + 링크 미리보기 + 글자 크기·밀도(신규) |
|  | 알림 (`notifications`) | `Bell` | 카드마다: 「내 계정」/「이 기기」 | 알림 규칙 그대로, 이름만 |
|  | 단축키 (`shortcuts`) | `Keyboard` | 「이 기기에만 저장돼요」 | 단축키 + 터미널 |
|  | 기기 (`devices`) | `MonitorSmartphone` | 「내 계정」 | 연결한 기기, 지시 서명 키, **이 맥 실행 호스트**, **내 재개 정책** |
| **워크스페이스** | 워크스페이스 (`workspace`) | `Building2` | 「워크스페이스 전체 · 운영자」 | 일반, 링크 확인(서버), 역할 표시명, 웰컴 킥오프 |
|  | 멤버와 초대 (`members`) | `UsersRound` | 〃 | 그대로 |
|  | 기억 (`memory`) | `Brain` | 카드마다: 「내 기억」/「워크스페이스」 | 그대로, `surface: teamMemory` 조건 유지 |
|  | 사용량 (`usage`) | `ChartColumn` | 「워크스페이스 · 누구나 볼 수 있어요」 | 연결 그룹에서 이동 |
|  | 실행 호스트 (`code`) | `Server` | 「워크스페이스」 | 등록된 호스트 목록 + 재개 정책 기본값(운영자). `surface: work`·`desktopAlways` 조건 유지 |
| **앱·연결** | 업데이트 (`updates`) | `Download` | 「이 기기」 | 데스크탑 전용 유지 |
|  | AI 허브 ↗ (`ai`) | `Bot` + 끝 `ArrowUpRight` | 없음(링크 행) | 설정 안 화면이 아니라 AI 허브로 가는 행. ADR-0198 T3 이후 `AiLinkSection` 삭제 |

아이콘은 전부 lucide-react 0.454에 있는 이름이고(`UserRound Palette Bell Keyboard MonitorSmartphone Building2 UsersRound Brain ChartColumn Server Download Bot ArrowUpRight` 확인함), `design/iconSystem.test.ts`(ADR-0172: 기능 아이콘은 정적 named import, 로컬 `<svg>` 금지)를 지켜요. 크기는 `sidebar-row`의 `[data-row-icon] svg` 규칙(18px)을 그대로 써요.

### 2.2 삭제·흡수 요약

- **삭제**: 계정, 터미널, 링크 미리보기 행(흡수), 앱, 외부 에이전트 연결, 채널로 들어오는 주소, 밖으로 보내는 알림(AI 허브가 이미 소유), 실행 엔진 블록, `AccountSection.tsx`.
- **이름 변경**: 테마→모양, 알림 규칙→알림, 코드 실행 호스트→실행 호스트, AI→AI 허브.
- 옛 `?section=` 딥링크는 전부 살려요: `settingsNav.ts`에 `LEGACY_SECTION_ALIAS`(`account→profile`, `link-previews→appearance`, `terminal→shortcuts`) 한 표를 두고, 이미 있는 `aiExternalRowFromSettings`가 AI 허브 쪽을 맡아요. `isReachableSettingsSection`(결과 카드·팔레트가 쓰는 정본 판정)도 별칭을 해석해야 해요(`settingsNav.ts` 머리말의 design-review #2540 R2 M-R2-1 교훈: 판정을 한 함수에 둠).
- `SETTINGS_GROUPS` 타입(`"개인" | "워크스페이스" | "연결"`)은 `"앱·연결"`로 바뀌어요. 이 값을 쓰는 곳은 `SettingsRoute.tsx`, `settingsNav.test.ts`, `workSurfaceEntryPoints.test.tsx`예요.

### 2.3 개인 vs 워크스페이스 (성재 질문 답)

- **개인**: 내 프로필(워크스페이스 안), 내 알림 규칙(서버, 이 워크스페이스), 연결한 기기·지시 서명 키, 이 맥 호스트(`scope=member`), 내 재개 정책, 모양·단축키·터미널·링크 미리보기 모양·OS 알림(이 기기 로컬스토리지).
- **워크스페이스 전체**: 워크스페이스 이름 계열, 서버 링크 확인, 역할 표시명, 웰컴 킥오프, 멤버·초대, 팀 기억 스위치, 재개 정책 기본값, 호스트 등록부(읽기는 멤버 누구나).
- 「지시 기기」(= 서명 키)와 「실행 호스트」(이 맥)는 둘 다 개인이 맞아요. 단, **등록부 목록은 워크스페이스 읽기**라서 남의 개인 맥도 보여요(1.1). 이것을 줄일지는 서버 쪽 확인이 필요해서 S4 범위 밖에 위험으로만 적었어요.

## 3. 컴포넌트 스펙

공통 원칙: **새 라이브러리 없음**(Radix switch가 package.json에 없어 `role="switch"` 네이티브 버튼으로), **`<svg>` 없음**(iconSystem), **인라인 style 없음**(CSP), 색은 토큰만, 간격은 {4,8,12,16,24,32}, 반경은 사다리(`rounded-md/lg/xl/2xl/full`), 글자는 `text-meta/body/title/display`.

위치: 설정 전용 조각은 `features/settings/shell/`, 범용은 `design/ui/`.

| 컴포넌트 | 위치 | 역할·구조 | oort 매핑(기존 → 신규) | 값(토큰) | Buzz 참조 |
|---|---|---|---|---|---|
| **SettingsShell** | `features/settings/shell/SettingsShell.tsx` | 두 열: 목록(캔버스 위, 선 없음) + 떠 있는 판(`rounded-xl`, rest 그림자). 판 안 스크롤 영역에 페이지(`max-w` 측정). `SettingsRoute`가 이것을 렌더 | 기존 `settings-layout`·`settings-nav*` @utility와 `[data-settings-surface]` 규칙을 **교체**. 앱 셸의 `app-shell` 캔버스(`canvas-gradient`)와 `> main` 판 문법(`margin-block/inline-end: --spacing-2`, `--radius-xl`, `--elevation-rest`)을 그대로 이어요 | 열 폭 `--w-settings-nav`(240) 유지. 판 면은 `--sheet`, 카드는 `--surface`(프로토타입에서 `--pane`(=`--surface`)이면 카드가 안 떠서 `--sheet`로 결정). 콘텐츠 폭은 신규 이름 토큰 `--w-settings-content: 720px`(지금 `SectionShell`은 `max-w-2xl`=672, 카드 안 컨트롤이 들어갈 폭이 필요) | `SettingsView.tsx:218-323`(사이드바), `:325-372`(떠 있는 inset 면, `rounded-2xl bg-background shadow-content-edge`), 폭 `max-w-4xl` `:352`, 푸터 버전 `:312-322` |
| **SettingsNav** | 〃 `SettingsNav.tsx` | `nav aria-label="설정"` > 그룹(`role="group"`, 라벨) > 행. 선·구분 상자 없음, 그룹 사이는 위 여백 16만. 첫 행은 「앱으로 돌아가기」. 선택 행 `aria-current="page"`. 폰(<600) 한 줄 가로 목록 동작(#3064)은 유지 | **기존 `sidebar-row`/`sidebar-row-selected` @utility 재사용**(34px·아이콘 18·흰 면+rest 그림자·다크에서 `--selected-edge` 링). 그룹 라벨은 신규 `@utility settings-nav-label`(`text-meta font-semibold text-ink-muted`, 좌우 `sidebar-row`와 같은 10px inset) | 행 hover `surface-hover`, 눌림 `surface-pressed`, 포커스 `focus-visible:focus-ring`(기존). 키보드: 기존 `onNavKeyDown`(↑↓), 진입 포커스, Esc `escapeIsClaimed` 모두 유지 | `SettingsView.tsx:51-76`(그룹), `:78-111`(행, 아이콘+라벨), 활성은 `data-[active=true]:bg-sidebar-active`(`sidebar.tsx:762`) |
| **SettingsPageHeader** | 〃 | `h1`(보이게) + 설명 + `ScopeChip`들 | `SectionShell` 머리 대체. 지금 sr-only `h1 "설정"`+각 섹션 `h2`는 **페이지 `h1` 하나**로(포커스 대상 유지) | 제목 `text-display font-bold`(표면당 1개 규칙에 맞음), 설명 `text-body text-ink-muted`, `break-keep` 유지 | `SettingsSectionHeader.tsx:9-29`(`PageHeader` + `mb-12`) |
| **ScopeChip** | 〃 | 아이콘 12px + 한 줄(「이 기기에만 저장돼요」「워크스페이스 전체 · 운영자」). 장식 상태점이 아니라 **범위 사실** | 기존 `StatusChip`(`SettingsFields.tsx:268`) 톤 `muted` 재사용, 시트 위에서 보이도록 `bg-surface`+`line` 1px(프로토타입에서 `surface-muted`는 시트에 묻혀서 바꿈) | `text-meta`, `rounded-full` | 없음(oort 고유, 성재의 범위 요구) |
| **SettingsSection** | 〃 `SettingsSection.tsx` | (제목 + 선택 설명 + 선택 우측 액션) + **카드**. 제목은 sentence-case, 대문자 라벨 아님 | 기존 `design/ui/card.tsx` `Card`(`rounded-2xl`, `bg-surface`, `shadow-sm`, `card-edge`)를 그대로 쓰고 행 사이만 `divide-y divide-line` | 섹션 간 `gap-8`(32), 제목-카드 `gap-2`, 제목 `text-meta font-semibold text-ink-muted` 좌우 `px-4` | `SettingsOptionGroup.tsx:5-59`(헤더 `:24-45`, 카드 `:46-56` `divide-y overflow-hidden rounded-xl border`), 목록 간격 `space-y-12` `:61-72` |
| **SettingsRow** | 〃 `SettingsRow.tsx` | 좌: 라벨(`text-body font-semibold`)+설명(`text-meta text-ink-muted`), 우: 컨트롤. 변형 `stacked`(라벨 위·컨트롤 아래, 입력칸용), `top`(정렬 상단, 스와치용). 컨테이너 폭 < 34rem이면 자동으로 세로 | 지금 `Field`(라벨-컨트롤 세로)·`SettingsToggleRow`(체크박스 행)를 이 행 안으로 흡수. `Card`의 `container-type: inline-size` 필요(프로토타입 `.ss-card`에서 확인) | 안 여백 `px-4 py-3`(16/12), 최소 높이 `calc(--spacing-control-lg(40) + 2×--spacing-3(12) − --spacing-2(8))` = 56(프로토타입 `.ss-row`와 같은 식). 값을 직접 적지 않고 토큰 식으로만 표현(Buzz `min-h-16`=64는 우리 간격 사다리에 없음) | `SettingsOptionGroup.tsx:74-87`(`min-h-16 gap-4 px-4 py-3`, `[@container(max-width:34rem)]:flex-col`) |
| **SegmentedControl** | `design/ui/segmented-control.tsx` | 네이티브 `fieldset` + `radio` 입력(방향키·그룹 접근성이 기본으로 옴). 선택 알약이 한 칸 위에 앉음 | 신규(oort에 없음). 알약 문법(`rounded-full`)에 맞춰 트랙 `bg-surface-muted`, 선택 `bg-surface shadow-sm` | 높이 `h-control`(32), 안 패딩 `--spacing-marker`(2), 칸 `px-3`, 글자 `text-meta font-semibold`, 폭은 칸 수에 맞춰 `grid-auto-columns: 1fr`(Buzz의 `w-48/60/72` 고정 폭 3종은 가져오지 않음) | `segmented-control.tsx:13-17`(크기), `:160-191`(트랙+인디케이터), `:194-231`(버튼). 포인터 스크럽 `:58-158`은 **가져오지 않아요**(5절) |
| **Toggle** | `design/ui/switch.tsx` | `button role="switch" aria-checked`. 이름은 행 라벨이 `aria-labelledby`, 설명은 `aria-describedby` | 신규. `SettingsToggleRow`의 체크박스(`accent-accent`)를 대체. 새 의존 없음 | 트랙 `--spacing-8 + --spacing-2`(40) × `--spacing-6`(24), 원 `--spacing-6 - 2*--spacing-marker`(20), 켬 `bg-primary`(잉크, 신호색 아님: ADR-0189 D3 「주 행동은 잉크」), 끔 `bg-line-strong`(3:1) | `switch.tsx`(Buzz, Radix) 사용처 `AppearanceSettingsControls.tsx:67-72`, `:461-467` |
| **ThemePreviewCard** | `features/settings/shell/ThemePreviewCard.tsx` | 타일 버튼(`aria-pressed`)=미니 앱 화면(캔버스 그라디언트 + 목록 열 + 면 + 신호 알약 + 에이전트 점) + 이름 + 체크. 「시스템」이면 라이트·다크가 대각선으로 반반 | **`<svg>` 대신 div+토큰**(iconSystem 때문에 Buzz의 SVG 방식은 못 가져옴). 미리보기마다 그 팔레트 값을 쓰려면 팔레트 규칙이 `:root[data-palette]`뿐인 현 구조에서 **범위를 좁힌 변형**이 필요: `themesCss.ts`가 `[data-palette-preview="<id>"]`로도 내보내게 하고(이미 `[data-accent-swatch="x"]`가 같은 방식의 선례, `themes/hongyeom.css`), 모드는 요소에 `color-scheme`을 줘서 `light-dark()`를 갈라요. 프로토타입에서 이 방식이 라이트·다크 모두 맞는 것을 확인함 | 타일 열 폭 최소 신규 이름 토큰 `--spacing-theme-tile-min: 160px`(3열이 900px 창에서 한 줄에 들어가는 값), 비율 3:2, 반경 `rounded-lg`, 선택 링 `--ink` 2px | `SettingsPanels.tsx:314-358`(`PairedThemeTile`, 168×112), `:360-399`(`SingleThemeTile`), 카테고리 분류 `:277-312`, 프레임 `ThemePreviewFrame.tsx:55-` |
| **AccentSwatches** | 모양 페이지 안 | 5개 원(새벽·성운·홍염·혜성·감람) + 라벨, 라디오 | 기존 `design/themes/swatches.css`의 `[data-accent-swatch]` 바인딩 메커니즘과 `accent-swatch` 규칙을 **그대로 쓰고** 모양만 원형 40px로(체크 아이콘 표시). 현재 단어 기본 「새벽」 유지 | `--spacing-control-lg`(40), 선택 링 `--ink` | `AppearanceSettingsControls.tsx:654-716` |
| **ConversationPreview / DensityPreview** | `features/settings/shell/ConversationPreview.tsx` | 「미리보기」 표식이 붙은 안쪽 상자 + 메시지 2개(사람 원형 아바타, 에이전트 둥근 사각 아바타, 링크 카드 1개). 글자 크기·밀도·링크 모양 선택에 **즉시** 반응 | 실제 타임라인 컴포넌트를 쓰지 않고 가짜 데이터로 그림. 값은 core `DENSITY[...]`(`messageGap` 16/8, `messageAvatar` 36/28, `cardPadding` 14/10)를 CSS 변수로. 표본 문구는 실제 팀 말투(지침: 「John Doe」 금지) | 안쪽 상자 `rounded-lg` + `line`, 표식 `text-timestamp text-ink-muted`+`Eye` 12px | `AppearanceSettingsControls.tsx:130-161`(메시지), `:163-200`(상자·「Preview」 표식), `:203-254`(행 둘+미리보기 배치) |
| **ProfileHero** | `features/settings/shell/ProfileHero.tsx` | 큰 원형 아바타(112) + 우하단 편집(카메라) 둥근 버튼 + 이름(`text-display`)·핸들·역할 칩 + 「사진 올리기」「사진 지우기」 | `ProfileAvatarField`의 업로드·삭제 로직 재사용(그대로). 아바타는 `MessageRow`의 `Avatar`(size-8 고정, `avatarSize.test.ts`가 32를 못 박음)를 건드리지 않고 **새 `size` 변형이 있는 `ProfileAvatar`**를 만들어 같은 `avatarIdentity`·`useMemberAvatar`를 써요 | 112px는 신규 이름 토큰 `--spacing-avatar-hero`, 이니셜 크기는 그 값의 0.4배(`--font-onboarding-wordmark`처럼 계산식 이름 토큰, 「다섯 번째 글자 역할」을 만들지 않음). **플레이스홀더**: 사람은 `canvas-gradient`(허용된 유일한 인앱 그라디언트) + 잉크 이니셜 + `shadow-sm` + 1px `line`. 다크에서 면이 어두워 묻히므로 `--selected-edge`(다크에서만 3:1 링)를 얹음. 에이전트는 둥근 사각+`agent-soft` 규칙 유지. 편집 버튼 34px(`--spacing-icon-button`) 잉크 채움, 흰 링으로 아바타에서 분리 | `ProfileSettingsCard.tsx:329`(편집 버튼 클래스 `h-11 w-11 rounded-full bg-sidebar-active`), 아바타 프레임 192px + 54px 배지 컷아웃 `:~560-640`(`MaskedAvatarBadgeFrame`) — 마스크 컷아웃은 가져오지 않고 링으로 단순화 |
| **DangerRow** | `SettingsRow` 변형 | 라벨이 `text-danger font-semibold`, 컨트롤은 `Button variant="destructive"`. 파괴 동작은 기존 `ConfirmButton`(제자리 확인, `SettingsFields.tsx:726`) 또는 `AlertDialog`로 확인. 카드는 일반 카드와 같고 「위험 구역」 같은 별도 상자를 만들지 않음(AI-tell 금지 목록: 장식 박스) | 로그아웃은 파괴가 아니라 일반 행, 「워크스페이스 나가기」만 위험 행. 확인 문구는 동사형 | `--danger`, `--danger-fill`/`--on-danger-fill` | `SignOutSection.tsx:125-142`(카드 + `variant="destructive"` + 확인 문구 입력) |

### 3.1 지킬 계약 (테스트·게이트가 이미 거는 것)

- test id 보존: `settings-route`, `settings-nav`, `settings-nav-<id>`, `settings-back-to-app`, `settings-drag-region`, `data-settings-scroll-viewport`, `settings-offline-banner`(`SettingsRoute.test.tsx`, `settingsNav.test.ts`, `gate-shell-layout.mjs`, `gate-wire.mjs`, 캡처 스크립트 7개가 읽음). `theme-choice`/`accent-choice`/`accent-swatch-<id>`는 `gate-theme.mjs`·`capture-screens.mjs`가 읽으니 S3에서 같이 갱신.
- `design_preflight_web.sh` 14분류 하드 0(em-dash·raw color·inline style·임의 Tailwind 값·`outline-none`·`bg-gradient`…). 프로토타입의 `style=`·px 리터럴은 **프로토타입 한정**이에요.
- 폰 폭(<600) 한 줄 가로 목록(#3064)과 양끝 마스크, `tap-target` 44는 새 셸에서도 유지.
- 오프라인 배너, 403 `OperatorNotice`, 로딩·오류 상태 네 가지는 각 페이지가 계속 책임져요(SKILL §5).

## 4. 모양(Appearance) 페이지 스펙 — Buzz 대조

결정 정본은 ADR-0189 증보 1(D1 밀도 3단, D2 글자 크기, D3 테마 선택·#2719 흡수, D4 유리). 아래는 화면 사양이다.

| Buzz 요소 | Buzz 위치 | oort 사양 | 저장 |
|---|---|---|---|
| 색 모드 세그먼트 System/Light/Dark(아이콘 포함) | `SettingsPanels.tsx` `APPEARANCE_MODE_OPTIONS`(~401), 행 `:669-692` | `SegmentedControl` 시스템/라이트/다크 + `SunMoon/Sun/Moon` 14px. 「지금 이 기기의 시스템은 라이트예요」는 설명 문장에 남김 | v2 `scheme`(`theme.ts`). 이 기기 |
| 테마 스타일 + 선택 미리보기 | `:694-726`(트리거), 격자 `:561-632` | 접지 않고 3타일을 항상 펼친다(새벽하늘·흑연·노을띠, core `THEME_LABELS`). 시스템이면 라이트/다크 대각 반반, 고정이면 그 모드 한 장 | v2 `theme`. 선택 UI는 증보 1 D3 |
| 강조색 | `AppearanceSettingsControls.tsx:654-716` | 5개 원(새벽=기본, 성운·홍염·혜성·감람) 40px, 선택 시 `--ink` 링+체크. hex 직접 입력은 같은 행 아래 펼침(ADR-0189 D3 보정·거절 규칙). 주 버튼은 안 바뀐다고 설명에 적음 | v2 `signal` |
| 유리 배경 토글 + 불투명도 | `:396-494` | **데스크탑(macOS) 한정** `Toggle` + 슬라이더. 지원 안 되면 행이 비활성이고 이유를 말한다. 동작·폴백·저장은 증보 1 D4 | v2 `glass` |
| 글자 크기 3단 | `:203-254`, `fontSizePreference.ts:1-60`, `typography.css:30-65` | 세그먼트 작게/기본/크게. **가상 rem**(ADR-0179 D7 `--type-rem`)으로 글자 역할 5종만 스케일, 레이아웃 rem·브라우저 줌과 직교(증보 1 D2). 컨트롤 px 높이가 큰 단계에서 글자를 담는지 캡처로 검증 | v2 `fontSize` |
| 대화 밀도 3단 + 실시간 미리보기 | 같은 곳, 미리보기 `:163-200`, 변수 `typography.css:54-65` | 세그먼트 촘촘하게/편하게/여유롭게(증보 1 D1). 미리보기는 core `DENSITY[...]` 값(메시지 간격·아바타)으로 그린다. **타임라인이 같은 값을 실제로 쓰는 것(DS2-8 #2720 범위)이 컨트롤 공개의 조건**이다 | v2 `density` |
| 링크 미리보기 + 샘플 | `:340-376` | 「대화 표시」 카드의 세그먼트 3(사진 카드/작은 카드/숨기기). 샘플은 대화 미리보기 안 링크 카드가 즉시 반영 | `linkPreviewPreference`(이 기기) |
| 활성 탭 강조, 스레드 레이아웃 | `:47-75`, `:495-651` | 가져오지 않음 | — |

저장은 모양 전부 이 기기 로컬이다(`localStorage`, 브라우저와 Tauri 웹뷰가 각각). 서버·계정 동기화 없음(ADR-0189 D8). 페이지 머리 칩이 「이 기기에만 저장돼요」. 저장 버튼 없이 즉시 적용한다.

S3a(색 모드·강조색·링크 미리보기·미리보기 카드, v1 저장 그대로)를 먼저, S3b(v2 이행·팔레트 선택·밀도·글자 크기·유리·hex)를 그 뒤에 한다. #2719는 이 증보가 흡수하므로 S3b가 소유한다.

## 5. Buzz 코드: 가져올 것 vs 새로 짤 것

oort는 Apache-2.0이라 라이선스 충돌은 없지만, **코드를 복사하면 §4(b)로 변경 표시와 NOTICE 귀속이 필요**해요. 기준은 `legal/THIRD_PARTY_NOTICES.md`의 「Adapted designs and prompts (no code copied)」 표(Graphiti·mem0 선례)예요.

| 항목 | 방침 | 이유 |
|---|---|---|
| 정보 구조(그룹·행·카드·미리보기 배치), 세그먼트 형태, 테마 타일 구성, 프로필 히어로 구성 | **재구현(설계만 차용)**. 코드 복사 없음 | oort는 Tailwind v4 닫힌 스케일·토큰·한국어 해요체·`<svg>` 금지라 Buzz 클래스를 그대로 못 써요. 어차피 다시 써야 해요 |
| `SegmentedControl` 포인터 스크럽(`segmented-control.tsx:58-158`) | **가져오지 않음** | 드래그로 미리보기하는 동작은 접근성(방향키·라디오)과 충돌하고 oort는 클릭 즉시 적용·즉시 반영이라 불필요해요 |
| `ThemePreviewFrame`·`buzzGradientSampleImage`(SVG에 `hsl(...)` 문자열 조립) | **가져올 수 없음** | `raw_color`·`iconSystem` 위반. div+토큰으로 새로 |
| Buzz의 `motion/react` 전개 애니메이션 | 가져오지 않음 | 모션 2~3/10 규칙, 새 의존 불필요 |
| 귀속 | 이번 docs PR이 `legal/THIRD_PARTY_NOTICES.md` 「Adapted designs」 표에 Buzz 한 줄을 이미 추가함(commit `af5bb0a`). 구현 PR은 코드를 복사하지 않는 한 추가 의무 없음. 복사하게 되면 §4(b) 변경 표시와 NOTICE를 같이(`https://github.com/block/buzz`, commit `af5bb0a`, Apache-2.0, 저작권자 표기는 upstream `LICENSE`/`NOTICE`에서 확인, 차용한 것=설정 정보 구조·외양 미리보기 구성(코드 없음), 위치=`features/settings/shell/`, 도입=#3578).  | 코드가 없어도 설계 차용은 같은 표에 올리는 관례예요 |

## 6. 슬라이스 계획 S1~S5

공통: 한 슬라이스 = 한 브랜치·워크트리·PR(base `track/uxui`). 매 슬라이스 필수 검증은 해당 트리 typecheck/test(`clients/web`, 설정 테스트 38파일), `scripts/design_preflight_web.sh`, 표면 게이트(`gate-shell-layout`, `gate-theme`), `scripts/verify_merge_tree.sh`(웹+코어 접촉이면 8레인), 독립 design-review **Blocker 0·High 0**, 캡처(라이트/다크 × 1440/900/390). 미실행 실기기는 `runtime-unverified`. 캡처 스크립트는 새 `scripts/capture-settings.mjs` 하나로 모든 페이지를 훑게 해서 7개 흩어진 스크립트의 설정 부분을 대체해요(기존 것은 `settings-nav-<id>` 클릭 방식으로 유지만).

| 슬라이스 | 범위 | 주요 파일 | 크기 | 테스트·캡처 | 선행 |
|---|---|---|---|---|---|
| **S1 셸·IA·프리미티브** | `SettingsShell/Nav/PageHeader/ScopeChip/Section/Row`, `SegmentedControl`, `Toggle`. 목차 12행 재편, 닫힌 4행 삭제, 별칭 표. 페이지 내용은 기존 `SectionShell` 본문을 새 셸에 **그대로 끼움**(아직 재작성 안 함, 시각 회귀만) | `features/settings/shell/*`(신규 ~8), `SettingsRoute.tsx`(337줄 재작성), `settingsNav.ts`+테스트, `design/ui/{segmented-control,switch}.tsx`, `tokens.css`(`settings-*` 유틸 교체, `--w-settings-content`, `--spacing-theme-tile-min`, `--spacing-avatar-hero`), `legal/THIRD_PARTY_NOTICES.md`, 캡처 스크립트 7개와 `gate-shell-layout.mjs`·`gate-wire.mjs` 갱신 | L (≈1200줄, 테스트 포함) | `SettingsRoute.test.tsx`·`settingsNav.test.ts` 갱신, 프리미티브 단위 테스트(키보드·`aria-checked`·라디오 방향키), 전 페이지 캡처, 폰 390 한 줄 목록 | — |
| **S2 프로필+계정** | `ProfileHero`, 프로필 카드·계정 정보 카드·로그인 카드, `AccountSection` 삭제, `ProfileAvatar` size 변형 | `ProfileSection.tsx`(251→~220), `ProfileAvatarField.tsx`, 신규 `ProfileAvatar`, `AccountSection*` 삭제, 관련 테스트 3파일(`ProfileSection.test.tsx` 493줄 등) | M | 기존 프로필 테스트 이식, 사진 업로드·삭제·오프라인·핸들 중복 오류 유지, 라이트/다크 플레이스홀더 대비 캡처, `?section=account` → 프로필 별칭 테스트 | S1 |
| **S3a 모양(UI)** | 색 모드·강조색·링크 미리보기·미리보기 카드, `LinkPreviewSection` 삭제 | `AppearanceSection.tsx` 재작성, `ThemePreviewCard`, `ConversationPreview`, `themesCss.ts`(범위 변형 방출)+생성 CSS(`gen:palettes`)+drift 테스트, `gate-theme.mjs`, `capture-screens.mjs` | M~L | `theme.test.ts`·`AppearanceSection.test.tsx` 갱신, 팔레트 3종×2모드 미리보기 대비 측정(미리보기 안 글자·알약), 캡처 6조합 | S1 |
| **S3b 모양(DS2-7/8 합류)** | 팔레트 선택, v2 이행, 밀도 3단, 글자 크기(가상 rem), 유리 토글(Tauri), hex 입력 | core `appearance.ts`, `design/theme.ts`, `public/theme-boot.js`, `tokens.css` | L | v1→v2 이행 시험, FOUC 없음 확인, 밀도가 타임라인에 닿는 것 측정 | S3a. #2719는 증보 1이 흡수, #2720(DS2-8)과 한 소유자로 |
| **S4 기기·실행 호스트** | 기기 페이지 재구성, 실행 호스트 페이지 분리, **실행 엔진 UI 제거**, 서버 제거는 engine 트랙 이슈 분리 | `DevicesSection.tsx`, `ThisMacHostBlock.tsx`, `WorkHostSection.tsx`(1005→~700), core `model.ts`·`api.ts`·테스트, 캡처 4개의 `/work-host-engine` 스텁 제거 | M~L | `ThisMacHostBlock.test.tsx`, `WorkHostSection` 관련(`rawControlBusySplit.test.ts` 1044줄 정리), 데스크탑 `__TAURI_INTERNALS__` 흉내 캡처로 호스트 상태 6장면 재촬영 | S1. ADR-0198 T3와 파일 충돌 없음(T3는 AI 허브) |
| **S5 나머지 이식** | 알림, 단축키+터미널, 업데이트(합쇼체 정리), 워크스페이스·기억·멤버·사용량, `AiLinkSection` 링크 행 교체 | `NotificationRulesSection`, `DesktopNotificationGroup`, `ShortcutsSection`+`TerminalSection`, `WorkspaceSection`(1274줄, 카드 분할), `MemorySettingsSection`, `InviteSection`, `UsageSection`, `UpdateSection` | XL → **S5a 알림·단축키·업데이트 / S5b 워크스페이스·멤버·기억 / S5c 사용량·AI 행**으로 3분할 권장 | 파일별 기존 테스트 이식, 403 `OperatorNotice`·오프라인·로딩·빈 상태 4종 캡처 | S1 (S2~S4와 병렬 가능, 파일이 다름) |

순서: S1 → (S2 ‖ S3a ‖ S4) → S5a/b/c, S3b는 #2719/#2720 합의 뒤. S1이 제일 중요해요(프리미티브가 전부의 기반이라 여기서 design-review를 한 번 길게 받아요).

### 위험

| # | 위험 | 대응 |
|---|---|---|
| R1 | S1이 목차를 바꾸면서 `?section=` 딥링크(결과 카드·팔레트·온보딩·서버 안내 문장)가 조용히 프로필로 접힘. 이 결함이 #2540 R1·R2에서 두 번 났음 | 별칭 표 한 곳 + `isReachableSettingsSection` 한 함수에서 해석, 별칭마다 테스트 |
| R2 | `tokens.css`의 `settings-*` 유틸을 바꾸면 폰 한 줄 목록(#3064)이 깨질 수 있음 | 390px 캡처와 `gate-shell-layout` 필수, 폰 규칙은 그대로 옮김 |
| R3 | 팔레트 미리보기용 범위 변형이 `themesCss.ts`·생성물·drift 테스트·`catalog.contrast.test.ts`에 걸침. #2719와 같은 파일 | S3a에서 하되 #2719 소유자에게 알림, 생성 CSS는 `gen:palettes`로만 갱신 |
| R4 | 밀도·글자 크기 컨트롤을 앱이 실제로 따르기 전에 열면 「눌러도 안 바뀌는 설정」이 된다 | S3b까지 컨트롤을 열지 않는다(미리보기만 있는 가짜 컨트롤 금지). 밀도는 DS2-8(#2720)과 함께 |
| R5 | 가상 rem 스케일에서 `h-control` 같은 px 높이가 큰 단계의 글자를 못 담을 수 있음 | 큰 단계 캡처, 필요하면 `min-block-size`로 |
| R6 | 호스트 등록부가 남의 개인 맥까지 모든 멤버에게 보임(서버 `list`). 「개인」 주장과 어긋남 | S4는 UI에서 남의 개인 맥을 접거나 이름만 표시하고, 서버 쪽 필터는 engine 트랙에 넘김(ADR-0100 확인) |
| R7 | 실행 엔진 서버 제거를 클라 PR에 섞으면 트랙 경계 위반 | 클라는 호출만 끊고 서버 제거는 별도 이슈 |
| R8 | 설정 파일 대량 이동으로 #3573 후속 문구 수정과 충돌 | #3579는 머지됨. S1부터 `75940c55d` 위에서 시작, 문구 변경은 건드리지 않음 |
| R9 | 시트(`--sheet`) 위 카드 문법이 라이트에서 대비가 약함(카드 면 `--surface` vs 시트 `--sheet`, 값은 `themes-2.0.md` 표) | 프로토타입에서 확인: rest 그림자로 충분히 읽힘. 고대비(`prefers-contrast: more`)는 `card-edge`가 처리 |


## 검증과 전달
- 슬라이스별: `clients/web` typecheck·lint·test, `packages/momo-core` test, `scripts/design_preflight_web.sh`, `scripts/verify_merge_tree.sh`, design-review B0·H0, 라이트/다크 × 1440/900/390 캡처.
- 전달: 슬라이스마다 PR(track/uxui).

## 체크포인트
- S1 착수(2026-10-07): 브랜치 `feat/3578-s1-settings-shell`.
