### Design Review — 메시지 검색 진입점 이름 통일, 웹+폰 (PR #1169, feat/pin-1146-1149 @ 8ff12a78)

Screenshots:
- /Users/kwakseongjae/projects/momo-tracks/momo-worktrees/pin-1146/clients/mobile/measure/captures/pin1146-search-entry-light.png
- /Users/kwakseongjae/projects/momo-tracks/momo-worktrees/pin-1146/clients/mobile/measure/captures/pin1146-search-entry-dark.png
- /Users/kwakseongjae/projects/momo-tracks/momo-worktrees/pin-1146/clients/web/artifacts/honesty/search-idle-light.png
- /Users/kwakseongjae/projects/momo-tracks/momo-worktrees/pin-1146/clients/web/artifacts/honesty/search-idle-dark.png
  (웹 아티팩트 생성 2026-08-07 15:49, 커밋 15:55 — 최종 코드에 대해 새 이름-일치 단정을 통과하며 생성된 산출물)

Design Read: 전역 목적지 진입점(웹 사이드바 줄·⌘K 항목·검색 라우트 제목 / 폰 헤더 액션·넘김 알약·검색 화면 제목)의
사용자 가시 문자열 소스 통일. 내부 팀 사용자, HIG-first, density 6/10, motion 0/10 (모션 변화 없음).

## Phase 0 — Prep
- 웹 light/dark, 폰 light/dark 확보. increased-contrast·large-Dynamic-Type 변형은 미제공 — 다만 이 변경은
  글리프 수가 동일한 문자열 소스 배선(폰 「메시지 찾기」6자 → 「메시지 검색」6자)이라 폭 회귀 위험은 기존선과 동일.
  SKIPPED로 기록, 판정에 미가산.
- 폰 RN SearchScreen 제목 자체의 신규 캡처는 없음(measure `search-entry`는 두 문만 찍음) — 제목은 코드 검증으로만
  판정(동일 상수, 기존 출하 문자열과 동일 글자).

## Phase 1 — Interaction (코드 히트테스트 추론)
- 폰 두 컨트롤 추출(SearchEntryAction/SearchFallthrough): accessibilityRole="button", onPress 배선
  (`onOpenSearch()` / `onOpenSearch(query)`), pressed 스타일, testID(open-message-search /
  search-messages-instead) 전부 1:1 보존. 행동 변화 없음.
- 웹 사이드바 줄은 기존 SidebarRow(NavLink) 그대로 — label prop만 상수로 교체. ⌘K 항목의
  forceMount·onSelect·value 의미 불변(value에 이름 상수 삽입, 매칭 키워드만 변화). 죽은 컨트롤 없음.

## Phase 2 — Window behavior
- 웹 240px 사이드바에서 「메시지 검색」(2자→6자로 증가) 잘림 없음 — search-idle-light/dark.png 실측.
- 폰 402pt 헤더에서 제목 「대화」+우측 액션 「메시지 검색」 공존, 잘림 없음 — pin1146-search-entry-{light,dark}.png.
- 넘김 알약 「'배포'가 오간 메시지 검색」 한 줄 수용 — 같은 캡처. 알약은 내용 폭 추종이라 질의가 길면 먼저 깨지는
  자리인데, 이는 PR 이전과 동일한 기존 행동(글자 수 변화 0).

## Phase 3 — Visual polish
- 새 색·폰트·간격 없음. 폰 헤더 액션·알약은 기존 스타일 이름(headerAction/fallthrough) 재사용, 액센트는 표면
  틴트 하나(캡처의 주황) — 토큰 위반 없음. Mac AI-Tells 해당 없음.

## Phase 4 — Accessibility
- 핵심 수리 확인: 폰 헤더 액션의 보이는 글자와 accessibilityLabel이 **같은 상수 한 줄** — 눈과 귀 분열 해소.
  넘김 알약도 시각·낭독이 한 문자열.
- 한국어 조사: 손글씨 `'…'로` 제거, 공유 규칙 attachParticle(subject)로 이관. 캡처 실측 「'배포'가 오간」 —
  받침 없는 '포'에 '가' 정선택. koreanParticle의 IGNORED_AT_END가 닫는 따옴표를 건너뛰므로 인용부호 붙은
  질의에서도 판정 유효(코드 확인).
- 웹 검색 입력 aria-label·폰 TextInput accessibilityLabel 모두 같은 표면 이름 상수.

## Phase 5 — Robustness
- 코어 label이 길어지는 미래(리브랜딩 등)에 헤더 액션·알약이 먼저 깨지는 구조인데, measure `search-entry` 표면이
  정확히 그 두 컨트롤을 실컴포넌트로 찍는 하네스로 신설됨 — 재촬영 경로 확보. 목업 아닌 배송 컴포넌트 촬영 확인.

## Phase 6 — Code health
- SKILL §5 pre-flight: grep1(raw color) 0건, grep2(fixed font) 0건, grep3(em-dash) 매칭 6건 전부 Swift
  주석(`//`, `///`)이며 사용자 가시 문자열 아님. PASS. (원출력은 리뷰 로그에 첨부)
- 단일 소스 배선 실측: `serverSurface('messageSearch').label`을 읽는 파일 6개 = 웹 Sidebar/QuickSwitcher/
  SearchRoute + 폰 SidebarScreen/SearchScreen + 폰 테스트. src 내 「메시지 검색」·「메시지 찾기」 리터럴 잔존
  grep — 전부 주석(산문)뿐, 사용자 가시 리터럴 0. mac 클라이언트에는 메시지 검색 진입점 자체가 없어 넷째 이름 없음.
- red proof 건전성:
  · 폰 3단정 모두 1차 소스 복원에서 붉다(1차엔 serverSurface 부재 / accessibilityLabel="메시지 검색" 쌍따옴표
    리터럴 / 보이는 글자 '메시지 찾기'). 씨앗의 not.toContain 기준값을 코어 label에서 읽으므로 표가 바뀌면 가드가
    따라감 — 손글씨 아님. 주석 스트립 선행으로 산문 오탐 차단. `verify_merge_tree.sh` phone suite(npm test)에
    포함되어 게이트 배선 확인.
  · 웹 nav↔title 일치 단정은 1차의 「검색」/「메시지 검색」 분열에서 정확히 그 문구로 붉는다(런타임 innerText 비교,
    1차 소스 복원 = 그 결함 재현). 단 아래 M1 참조.

## Phase 7 — Copy
- 한 목적지 한 이름 실측: 웹 사이드바 줄 = 라우트 h1 = 「메시지 검색」(캡처 2장), 폰 두 문 = 「메시지 검색」(캡처 2장).
- ⌘K 빈 상태 안내가 가리키는 이름: 안내 문장과 아래 forceMount 항목이 같은 상수를 렌더 — 빈 상태는 typed 비어있지
  않을 때만 뜨고 그때 항목은 `'typed' 메시지 검색`으로 이름을 포함. 가리키는 곳이 화면에 실재(코드 검증; 팔레트
  런타임 캡처는 하네스에 없음).
- 「검색과 이동」(팔레트)과 「메시지 검색」(목적지)이 이제 명확히 구분 — 1차의 「검색」 오독 소지 제거. 새 사용자 가시
  문자열에 em-dash 0, 하이프 어휘 0.

## Findings

[Blocker] 없음.

[High] 없음.

[Medium]
- M1. 웹 쪽 이름-분열 tripwire가 게이트 밖에 있다. 폰은 jest 가드가 `verify_merge_tree.sh` phone suite로
  자동 실행되지만, 웹의 유일한 가드는 capture-honesty.mjs(수동 `npm run capture:honesty`)의 런타임 단정 —
  웹 게이트(vitest)에는 대응 검사가 없다. 웹에서 누가 리터럴을 다시 손으로 적으면 다음 수동 캡처 전까지 아무것도
  붉지 않는다. 비대칭이 문제이지 가드 부재가 아님: 웹 vitest 층에 같은 씨앗(사이드바 label ≡ 라우트 제목 ≡ 코어
  label)을 심는 후속이면 충분.

[Nitpick]
- N1. 폰 리터럴 가드는 `'…'`·`"…"` 두 인용형만 검사 — 백틱 템플릿이나 JSX 맨글자(<Text>메시지 검색</Text>)로
  재기입하면 빠져나간다. 실익 대비 낮은 구멍이나 기록해 둔다.
- N2. ConversationScreen.tsx 주석(약 809행·1014행)이 사이드바 문을 여전히 「메시지 찾기」로 서술 — 이 PR이
  없앤 이름을 가리키는 낡은 산문. 사용자 비가시, 다음 손질 때 정리.
- N3. 폰 SearchScreen backLabel="검색 닫기"가 낭독에서 짧은 「검색」을 쓴다(PR 이전부터). 닫기 동사구라 무해하나
  일명(一名) 논리를 끝까지 밀면 「메시지 검색 닫기」가 맞다.
- N4. 웹 red proof를 1차 소스 그대로 복원하면 search-title testid도 함께 사라져(이 PR에서 추가) 이름-분열
  메시지가 아니라 로케이터 타임아웃으로 붉는다 — 붉기는 붉으므로 건전성은 유지, 기록만.

Verdict: **PASS** (Blocker 0, High 0, Medium 1, Nitpick 4)
