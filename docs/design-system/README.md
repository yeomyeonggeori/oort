# 오르트 구름 (Oort Cloud) — oort 디자인 시스템 정본

> **가리킬 자리 하나.** 리뷰어·워커·스킬이 "이건 어느 규칙 위반인가"를 물을 때 여는 문서다.
>
> - 결정: [ADR-0159](../adr/0159-oort-cloud-design-system.md) (Accepted)
> - 근거·실측: [2026-08-09 디자인 시스템 감사](../planning/research/2026-08-09-design-system-audit.md) (679줄)
> - 관련 정본: [UX 원칙 P1~P15](../ux-bible/README.md) · [아키텍처](../architecture/overview.md) · 스킬 `.claude/skills/momo-design-taste-web/SKILL.md`
> - 도구 소비 mirror: 루트 `DESIGN.md`(Core v2) · [OmD v2 운영 경계](OMD.md). **이 둘은 이 문서를 대체하지 않는다.**
>
> 위 두 링크(ADR·감사)는 **문서 정본 라인(`main`)**에 산다. 트랙 브랜치가 아직 그것을 받지 못했으면 링크가 비어 보인다 — 문서가 없는 것이 아니라 이 브랜치가 아직 못 받은 것이다.

## 이 문서가 존재하는 이유

디자인 리뷰 16건(2,514줄)에서 뽑은 결함 170건의 **최다 패턴은 명세 부족이 아니었다.**

감사 §B-3이 센 세 메타 패턴 (한 결함이 여러 패턴에 들 수 있으므로 순위가 아니라 계수다):

| 메타 패턴 | 건 | 리포트 |
|---|---|---|
| **"옳은 답이 바로 옆 줄·같은 파일·형제 컴포넌트에 이미 있었는데 안 썼다"** — 코퍼스 최다 | **25** | 11 |
| 클라 간 패리티 분기 | 18 | 8 |
| 게이트 맹점("기계가 잡았어야 했는데 안 잡았다") | 17 | 10 |

가장 날카로운 예: `tokens.css`가 `py-1.5`를 **"아예 컴파일되지 않는 예"로 이름 대어 적어 둔 바로 그 클래스**를 U4-4가 적었고, 화면의 묶음 안 간격이 0px이 됐다.

그래서 이 문서의 목적은 새 규칙을 세우는 것이 **아니다.** 이미 코드·리뷰·스킬·ADR에 흩어져 있는 규칙을 한 자리에 모아 이름을 붙이고, **각 규칙 옆에 "이걸 무엇이 재는가"와 "무엇이 안 재는가"를 적는 것**이다. 찾기 쉬움이 곧 기능이다.

이 문서에 새로 발명된 규칙은 없다. 모든 항목에 출처가 붙어 있고, 출처가 없으면 그것은 규칙이 아니라 관례다.

OmD가 읽는 루트 `DESIGN.md`와 `.omd/system/*`는 이 정본을 Core v2로 사상한
비권위 mirror다. 도구의 구조화 graph가 존재해도 새 정본이 된 것이 아니다. 설치
채널, taste/design-review/프리플라이트와의 역할 경계, book 사용법은
[OmD v2 운영 경계](OMD.md)에 적는다.

---

## 0. 30초 경로

| 지금 하려는 일 | 열 자리 |
|---|---|
| 색을 고른다 | §2.2 — 웹 `clients/web/src/design/tokens.css`가 유일 정본. 폰은 그것을 **번역**한다. |
| 간격·반경·글자 크기를 고른다 | §2.3~§2.5 — 스케일 밖 값은 **이름**으로 들어오거나 아예 안 들어온다. |
| 아이콘을 고른다 | §2.8 — lucide 한 벌, 16px 단일 기본. 예외는 컴포넌트가 사유를 진다. |
| 버튼 두 개를 나란히 세운다 | §3 위계 — 파괴 > 주 > 보조. 값이 아니라 **관계**다. |
| 새 표면을 만든다 | §4 상태 — 빈·로딩·오류·오프라인 넷이 다 있어야 출하다. |
| "이거 기계가 잡나?"를 묻는다 | §5 강제 기제 지도. **§5.3이 안 잡는 것 목록**이다. |
| 스케일에 값을 하나 더하고 싶다 | §6. 대개 답은 "더하지 말고 이름을 지어라"다. |

---

## 1. 디자인 표면은 셋이 아니라 **둘**이다

| 표면 | 코드 | 비고 |
|---|---|---|
| **웹** | `clients/web` | Dawn 팔레트의 정본이 여기 산다 |
| **폰** | `clients/mobile` (bare React Native) | 웹을 **번역**한다. 구현은 공유하지 않는다 |
| ~~데스크톱(Tauri)~~ | `clients/desktop` | **디자인 표면이 아니다** — `frontendDist`가 `../../web/dist`이고, `clients/web/src` 전수에 런타임을 보고 **스타일을 가르는** 분기가 0건이다(§주1) |
| ~~macOS(SwiftUI)~~ | ~~`clients/macOS`~~ | **삭제 완료**(2026-08-10, PR #1253 — W-S1). 역사 기록으로만 남김 |

> **주1 — "스타일 분기 0건"이 "빌드 두 개가 똑같다"는 뜻은 아니다.** 런타임 분기는 있고, 그것은 *무엇을 보여줄지*를 가른다: `app/RuntimeBadge.tsx:26`이 배지 글자를 `desktop`/`web`으로 나누고, `features/settings/SettingsRoute.tsx:78·104`가 「업데이트」 섹션을 데스크톱에서만 렌더한다. 없는 것은 **토큰·레이아웃을 런타임에 따라 다르게 고르는 코드**이고, 디자인 시스템이 걱정하는 것은 그쪽이다. 그래서 표면은 여전히 둘이다.

> **컴포넌트는 공유하지 않는다** — 토큰·코어 로직·문장만 공유하고 뷰는 각자 구현한다. 감사 §A-2가 1차 소스로 확인한 업계 표준 선택이고(Microsoft·Adobe 별도 구현, RNW는 제작자가 "Meta 투자 0" 선언, Airbnb "결국 두 플랫폼이 아니라 세 플랫폼을 지원하게 됐다"), 바꿀 이유가 없다.

---

## 2. 토큰 층

### 2.1 정본 파일

| # | 파일 | 정의하는 것 | 누구를 따르나 |
|---|---|---|---|
| 1 | `clients/web/src/design/tokens.css` | 색 · 간격(리듬 + 이름 축) · 반경 · 텍스트 롤 · 셸 기하 · 터치 타깃 | **아무도 안 따름 = 정본** (의미 토큰) |
| 1b | `clients/web/src/design/themes/` | `--accent` / `--accent-soft` / `--on-accent` 바인딩 (라이트·다크 쌍) | ①의 의미 토큰을 **재바인딩**. 컴포넌트는 여기 hex를 읽지 않는다 (ADR-0174 D1) |
| 2 | `clients/mobile/src/design/tokens.ts` | 색(×2스킴) · space · radius · font · line · TOUCH_TARGET | ①을 번역 |
| 3 | `packages/momo-core/src/features/timeline/divider.ts` | `ROW_SPACE` — 타임라인 행 간 거리 | 없음(이 축의 정본). 웹·폰이 각자 소비 |
| 4 | ~~`clients/macOS/Sources/MomoMac/Theme.swift`~~ | (삭제됨 — PR #1253) | 정본 토큰 파일은 위 1~3의 셋뿐이다 |

### 2.2 색 — 유일하게 완전히 흐르는 축

**여명(Dawn) 팔레트.** 웹이 두 스킴을 `light-dark()` 한 줄에 적으므로 두 항이 갈라질 자리가 없다. 폰은 두 상수로 나눠 들고, `clients/mobile/__tests__/paletteContrast.test.ts`가 웹 `tokens.css`를 `readFileSync`로 읽어 **바이트 단위로** 대조한다(짝 15쌍 + 스크림).

컴포넌트는 의미 토큰(`--accent` · `--surface` · `--ink` …)만 소비한다. 사용자가 고르는 액센트는 `src/design/themes/`의 바인딩 층이 `:root[data-accent]`로 `--accent` / `--accent-soft` / `--on-accent`만 재정의한다(ADR-0174 D1). 기본 바인딩은 항상 새벽(호박)이고 목록의 첫 값이다. 온보딩 S0과 브랜드 락업(`.brand-lockup`)은 이 재정의의 영향권 밖이다(D4). 후보 세트는 구현 시안이며 성재 확인 전에 정본이 아니다.

규율 (출처: `tokens.css` 머리 주석 · `tokens.contrast.test.ts` · `themes/catalog.contrast.test.ts` · `paletteContrast.test.ts`):

- **순흑·순백 없음.** 종이의 흰색은 `#fffefb`.
- **인디고/네온 보라 금지.** 에이전트는 새벽 남색(`--agent`)이고, `tokens.css`가 *"never neon AI purple"*이라고 적는다.
- **`--line`은 나누고, `--line-strong`은 컨트롤을 그린다(3:1).** `tokens.css:33`. 라이트 `--line`은 `#e4e0d8`(#1866, `--surface` 위 1.22:1). 라이트 `--line-strong`은 `--surface-hover` 위 **3.03:1**이라 한 단계(RGB +1 → 2.99)도 못 옅힌다 — 버튼·입력·컴포저 그릇의 경계는 이 토큰이 지고, 3:1을 깨는 완화는 금지.
- **텍스트 입력 그릇은 포인터 포커스에서 보더 색을 바꾸지 않는다** (#1866, buzz 동형). 컴포저(채널·스레드)와 관전 터미널 그릇은 `focus-visible-within:focus-ring`: Tab 모달리티와 자식 `:focus-visible`에서만 기존 인셋 링. 안쪽 textarea(컴포저 입력, xterm `.xterm-helper-textarea`)는 클릭에도 `:focus-visible`이 매치되므로 `:focus-within`만으로는 갈리지 않는다. Input/Select/outline 버튼은 프리미티브의 `focus-visible:focus-ring`이 그대로 진다.
- **위험 순서의 자는 대비가 아니라 채도(OKLab C)다** — `danger > warn > ink-muted`. AA를 한참 넘긴 두 톤은 대비 축에서 구분되지 않는다.
- **스크림은 색이 아니라 방향이다** — 어느 스킴에서든 뒤를 어둡게 한다.
- **상호작용 상태를 그리는 토큰은 정적인 그릇이 될 수 없다** (#1515) — 아래.
- **hex 리터럴 0 (컴포넌트).** 웹은 프리플라이트 그렙이 `tokens.css`와 `src/design/themes/`만 허용한다. 테마 디렉토리는 **사전 검증된 바인딩 외 금지**이지 일반 raw color 면제가 아니다(ADR-0174 D5). 폰은 `conversationHygiene.test.tsx:519`가 `src/` 전수에서 센다.

#### 상태 토큰과 그릇 토큰은 갈라져 있다 (#1515 / design-review #1514 H-2)

**상태는 켜졌다 꺼지고 그릇은 늘 거기 있어야 한다. 둘이 한 값을 나눠 가지면 상태가 켜진 동안 그릇이 반드시 사라진다.** 수명주기 칩이 정확히 그렇게 지어져 있었다 — 칩 바탕이 `--surface-hover`였고 목록 행의 hover·펼침이 같은 토큰을 쓰므로, 사람이 **가리키고 있는 행에서만** 칩이 그릇을 잃었다(실측 대비 1.00). 읽히는 순간에만 사라지는 그릇은 없는 것보다 나쁘다.

그래서 이 팔레트는 두 축을 이름으로 갈라 둔다:

| 축 | 토큰 | 하는 일 |
|---|---|---|
| 상호작용 상태 | `--surface-hover` · `--surface-pressed` · `--accent-soft` | 가리킨 행 · 눌린 본문 행 · 선택된 행. **켜졌다 꺼진다** |
| 칩의 그릇 | `--muted-soft` · `--ok-soft` · `--warn-soft` · `--danger-soft` | 칩 한 개가 서는 옅은 채움. **늘 있다** |

**「그냥 다른 회색」이 답이 아닌 것은 취향이 아니라 산술이다.** 라이트에서 `--ink-muted`가 AA를 지키려면 바탕 휘도가 0.769 이상이어야 하는데 `--surface-hover`가 0.7704다 — 바닥에 이미 붙어 있다. 칩 그릇이 설 수 있는 띠는 [0.769, 0.9911(종이)] 하나뿐이고 표면 다섯이 그것을 이미 나눠 갖고 있어, **여섯 번째 중립이 얻을 수 있는 최선의 최소 분리는 1.06:1**이다. 명도만으로 그릇을 세우는 설계는 거기서 끝나고, 남는 자가 §3.1의 위험 위계를 재던 것과 같은 축의 **OKLab 거리**다(`--danger-fill`이 `--accent`와 섞이지 않았음을 증명한 그 자). 그래서 그릇의 생존은 두 자로 정의된다: 대비 ≥ 1.05 **그리고** OKLab 거리 ≥ 0.02. 하나만 걸면 「대비는 넘는데 눈에는 같은 회색」이 통과한다.

기계가 재는 것은 **세 층**이고, 셋째 층이 이 규칙의 사정거리를 진다.

| 층 | 파일 | 재는 것 |
|---|---|---|
| 값 | `tokens.contrast.test.ts` | 그릇 토큰이 자기가 서는 행 바탕과 두 자로 다른가. 행 바탕은 **닫힌 표**(`CHIP_VESSEL_SURFACES`)이고 **그릇마다 목록이 다르다** — `CONTROL_SURFACES`와 같은 성질 |
| 이름 | `sessionStatusClass.test.ts`(코어) | 역할표 두 개(`SESSION_STATUS_CLASS`·`ROW_STATE_CLASS`) 어느 칸도 상태 토큰을 그릇으로 들지 않는가 |
| **전수** | `chipVessel.test.ts` | **칩 기하를 지닌 모든 클래스 목록**을 훑어 그릇을 어디서 얻는지 분류하고, 그 분류가 총체임과 잔량이 줄어들기만 함을 단정 |

셋째 층이 따로 있는 이유는 §5.5②가 이름 대어 적은 실패 양식 그 자체다. 앞의 두 층은 **자기가 아는 표만** 보므로, 규칙은 팔레트 전체인데 강제는 허용목록이 된다. 실제로 그 목록 밖에서 대비 1.000짜리 산 결함 둘이 살아 있었다(워크스트림 목록 행·ADE 서랍 카드 — 그때 앞 두 층은 전부 초록이었다).

**그리고 전수 층의 첫 판도 허용목록이었다.** 그 판은 칩을 `cn(CHIP_CLASS, …)`에서 찾으면서 「칩의 기하는 `CHIP_CLASS` 하나뿐」이라는 전제를 적었는데 **이 레포에서 거짓이다**: 여덟 자리가 기하를 손으로 다시 적고 있었고, 그중 `WorkSessionIdleCard`의 「대기 전환」 칩은 `hover:bg-surface-hover` 카드 위에서 **또 하나의 1.000**이었다. 그래서 발견을 import가 아니라 **기하 시그니처**(`rounded-sm px-2 py-px text-timestamp`)로 키잉한다 — 전제를 참으로 만드는 대신 **전제를 필요 없게** 만든 것이다. 손 기하 자체도 별도 잔량으로 세어 새로 적는 것을 막는다(현재 7).

컨트롤 변형표(`button.tsx`)는 기하가 다르므로 자동으로 빠진다 — 컨트롤이 `--accent-soft`를 선택 상태로 입는 것은 이 규칙의 대상이 아니라 그 토큰이 하는 일 그 자체다. 반대로 **컨트롤이 칩 기하를 빌려 쓰면** 걸린다(관전 터미널 토글·설치 마법사 단계 표시기). 그 둘은 그릇이 아니라 기하가 결함이고, 잔량 표가 그 갈림을 적어 둔다.

**남은 잔량 33건**(칩 그릇) **+ 7건**(손 기하). 좌표와 수가 `chipVessel.test.ts`의 두 표에 있고 그 표가 **정확히** 맞아야 초록이다 — 새 위반은 적지 않으면 빨갛고, 수리는 표를 줄이지 않으면 빨갛다. 천장은 내려가기만 한다. 잔량은 **더 이상 「전부 rule-only」가 아니라 「지금은 전부 rule-only」**이고, 그것이 살아 있지 않은 이유도 표에 적혀 있다: 타임라인 칩 스무 개를 지켜 주는 것은 「행이 hover하지 않아서」가 **아니라**(`MessageRow.tsx:473`은 hover한다) 사이에 낀 불투명한 `bg-surface-raised` 카드다. 그 카드를 평평하게 만드는 사람이 칩 스무 개를 한꺼번에 지운다.

**이 층이 재지 않는 축: 칩의 테두리.** `bg-*`만 읽는다. `SettingsFields`의 `StatusChip`은 `border-ok`/`border-warn`/`border-danger`/`border-line` 다섯 톤 셀로 일곱 설정 표면에 살아 있고, `AgentTurnBadge.tsx:34`·`AgentWorkPanel.tsx:233-234`도 `border border-warn`을 두른다(`AgentHubRoute`의 그 자리는 UX-R4a #1957이 그릇으로 걷었다) — #1516이 검증 칩 **하나**에서 「컨트롤 문법」이라 판정해 걷어낸 것이 바로 그 모양이다. 즉 웹의 제거는 아직 한 칩에 그쳤고, 그 축에는 기계 강제가 **아예 없다**(§5.3).

**사정거리는 웹이다.** 폰(`clients/mobile`)에도 같은 격의 칩이 있다 — `WorkSessionParts.tsx`의 `WorkStatusBadge`는 같은 `WorkSessionStatus` 키를 쓰고 자기 주석이 「역할 정본은 웹/코어 표이고, 폰은 그 표를 따른다」라고 적는다 — 그리고 그쪽은 아직 톤 채움 + 1px 테두리다. 폰 정렬은 §6 절차를 지나야 하는 별도 결정이라 여기서 하지 않았고, **후속 goal은 #1600으로 발급돼 있다**: 폰의 `okSurface`/`warnSurface`/`dangerSurface`는 새 웹 토큰과 다크에서 OKLab 거리 0.0337/0.0450/0.0421이라, 위 0.02 자로는 **서로 다른 재료**다. 번역이 아니라 신설이 필요한 자리라는 뜻이다.

부수 결정 하나: 그릇은 여섯 칸이 전부 같다. **색을 버는 것은 측정이지 이름이 아니다** — 원장의 칩은 세션을 무엇이라 부르는지 말할 뿐 아무것도 재지 않으므로 그릇에 색을 얹을 근거가 없고, 톤은 잉크에만 남는다(#1491이 초록에 대해 내린 것과 같은 판단).

#### 그릇의 색은 측정만이 번다 — 그리고 테두리는 컨트롤의 것이다 (#1516 / H-3)

위 규칙의 나머지 반쪽. 검증 칩(세션이 스스로 보고한 게이트 결과)은 #1463에서 **테두리**를 얻었다(`--surface-raised` + `--line`). 그릇은 지켰지만 값을 치렀다: 이 팔레트에서 1px 테두리로 둘러싼 작은 알약은 **컨트롤 문법**이고(입력·`<select>`·아웃라인 버튼이 전부 그 모양이다), 그래서 「통과 12」가 누를 수 있는 것으로 읽혔다. 팔레트의 계약상으로는 컨트롤이 아니다 — `--line`은 나누는 선이고 컨트롤은 `--line-strong`이 그린다. **토큰 계약과 화면이 서로 다른 말을 하고 있었고, 그럴 때 이기는 쪽은 언제나 화면이다.**

테두리를 그냥 걷는 것은 답이 아니다(#1463 H1이 되돌아온다 — 이 칩은 `--surface-raised` 카드 위에도 선다). 그래서 테두리가 지던 일을 **채움의 색상**이 진다: 색이 있는 채움은 중립 표면과 명도가 가까워도 구분된다(`--accent-soft`가 `--surface-hover` 위에서 대비 1.051뿐인데도 사라지지 않는 것이 그 증거다).

| 칩 | 그릇 | 근거 |
|---|---|---|
| 원장의 칩(수명주기·단계 행) | `--muted-soft` 고정 | 아무것도 재지 않는다 |
| 측정의 칩(검증) | 자기 톤의 soft | 잰 것이 있다 |
| 측정의 칩, `건너뜀` | `--muted-soft` | **잰 것이 없으면 물들일 톤도 없다** |

그래서 #1463 M2가 지적한 충돌(수명주기 `running`도 warn, 게이트 `unknown`·`pending`도 warn — 한 행에 같은 모양 호박색 알약 둘)이 잉크가 아니라 **그릇**에서 갈린다.

**한 평면, 색상만 다르다.** 네 그릇은 스킴마다 한 평면에 선다(라이트 휘도 .85~.87 · 다크 .028~.029). 명도가 「이것은 그릇이다」를, 색상이 「어느 톤인가」를 말한다 — 두 축이 한 가지씩만 진다. 평면도 산술이다: 다크에서 `--ok`의 AA가 휘도 .0320에서 끊기고, 동시에 `--surface-hover`(.0192)보다 위여야 `--line-strong` 3:1을 넘지 않아 「컨트롤이 설 수 있는 표면」으로 오분류되지 않는다. 남는 구간이 .0192~.0320이고 그 안이 .0285다. (라이트 danger만 평면 1% 아래에 선다 — sRGB에서 그 명도의 빨강은 채도가 모자라 클립되고, 그러면 중립 그릇과의 거리가 0.0169로 내려간다.)

기계가 새로 재는 것: 각 그릇이 **자기 톤의 색상 가족 안**에 있고(≤15°, 실측 최대 2.7°), 나란히 선 중립 그릇과 OKLab 거리 ≥ 0.02이며, 그릇 다리(`COMPLETION_TONE_SOFT_TOKEN`/`_CLASS`)의 네 칸이 tokens.css에 실재한다. 색상 가족을 걸어 두는 이유는 대비·거리 단정을 만족시키는 가장 싼 방법이 「눈에 띄는 아무 색이나」이기 때문이다 — 그러면 통과한 게이트가 붉은 그릇에 선다.

그리고 그릇은 잉크에서 **파생되지 않는다**. `muted`의 잉크는 `--ink-muted`인데 그릇은 `--muted-soft`다(전경 톤과 그 톤의 옅은 채움은 서로 다른 축). 「`text-X`의 X에 `-soft`를 붙인다」로 규칙을 지으면 그 칸이 없는 토큰을 부르고, 그 실패는 컴파일이 아니라 화면에서 **그릇 없는 칩**으로 나타난다. 그래서 표가 둘이고, 테스트가 그 둘이 합쳐지지 못하게 붙들어 둔다.

### 2.3 간격

**리듬 스케일(숫자 축)은 닫혀 있다: `{0, 1px, 4, 8, 12, 16, 24, 32}`.** 낱말 이름의 측정값(`--spacing-marker 2` · `--spacing-row 6` …)은 별개 축이고, 그것도 간격 유틸리티를 만든다 — 아래 참조.

웹은 `--spacing: initial`로 Tailwind 동적 배수를 껐다. **격자 밖 *단계*는 아예 컴파일되지 않는다** — `p-5`·`py-1.5`·`p-7`은 규칙이 만들어지지 않으므로 잘못된 크기로 조용히 렌더되는 대신 여백이 0이 된다. U4-4가 `py-1.5`를 적었고 화면의 묶음 안 간격이 0px이 된 것이 그것이다.

> **그런데 임의값(`p-[13px]`)은 여전히 컴파일된다.** 동적 배수를 꺼도 임의값 문법은 스케일을 참조하지 않기 때문이다. 실측(빌드된 CSS): `p-5`·`py-1.5`·`p-7`은 규칙 0개, `pt-[13px]`는 `padding-top: 13px`로 살아 있다 — 그리고 그 클래스의 레포 내 유일한 출처는 **테스트 안의 문자열**(`spacing.test.ts:211`, 그 이름이 거부되는지 확인하는 단정)이다. 스캐너는 코드가 아니라 텍스트를 본다.
>
> 그래서 임의값을 막는 것은 컴파일러가 아니라 **프리플라이트 `arbitrary_tw` + ESLint**다. 두 층이 서로 다른 것을 막는다는 사실이 §5 지도의 요점이다.

격자 밖 측정값은 **숫자가 아니라 이름**으로 들어온다(`--spacing-pane`, `--spacing-action`, `--spacing-row` …). 이름 축의 각 값은 자기가 왜 격자 밖인지를 주석으로 진다.

폰의 `space {xs 4, sm 8, md 12, lg 16, xl 24}`는 전부 웹 리듬 단계이고, `clients/mobile/__tests__/designSystem.test.ts`가 웹 파일을 파싱해 대조한다.

| | 웹 | 폰 | 관계 |
|---|---|---|---|
| 4 · 8 · 12 · 16 · 24 | `--spacing-1,2,3,4,6` | `space.xs~xl` | **짝 — 바이트로 같다** |
| 0 | `--spacing-0` | — | RN은 「없음」을 `0`으로 쓴다 |
| 1px | `--spacing-px` | — | 헤어라인은 CSS의 물건 |
| 32 | `--spacing-8` | — | 390pt 폭에서 32 인셋은 본문을 326pt로 만든다. 필요해지면 신설한다 |
| 가로 인셋 | — | `SAFE_GUTTER 16` | `space.lg`와 같은 값. 모든 화면이 나눠 쓴다 |

> **폰에는 "컴파일되지 않는다"는 층이 없다.** `marginTop: 13`은 언제나 컴파일되고 화면에 그대로 나간다. 그 자리를 `designSystem.test.ts`의 **전수 스윕**이 메운다 — 오늘 남아 있는 격자 밖 값은 파일별로 세어져 있고, 늘어나면 빨갛다.

### 2.4 반경

세 단계뿐이다. 웹 `--radius-sm 6`(버튼·칩·입력) / `--radius-md 10`(카드·목록) / `--radius-lg 14`(다이얼로그·시트).

| 이름 | 웹 | 폰 | 관계 |
|---|---|---|---|
| `sm` | 6 | 6 | **짝 — 바이트로 같다** |
| `md` | 10 | 8 | **분기.** 근거가 어디에도 없다(감사 §B-1). 값을 맞추는 것은 결정이고 아직 안 내려졌다 — 그때까지 `designSystem.test.ts`가 ①분기가 이 하나뿐이라는 것과 ②그 차이가 리듬 한 단(4px)보다 작다는 것을 잰다 |
| `lg` | 14 | — | 폰의 시트는 RN 화면 전환이 그린다 |
| `pill` | — | 999 | 칩·배지. 웹은 같은 자리를 `rounded-sm`로 그린다 |

### 2.5 타이포

**역할이지 크기가 아니다.** 웹은 `text-timestamp`(11) / `text-meta`(12) / `text-body`(14) / `text-title`(16) / `text-display`(20)이고 각 롤이 자기 줄 높이를 동봉한다. `--text-*: initial`이 스톡 스케일을 지우므로 `text-sm`은 **컴파일되지 않는다**. `text-[13px]`는 — 간격과 같은 이유로 — **컴파일된다**; 그것을 막는 것은 프리플라이트 `arbitrary_tw`다. 외부 폰트·CDN은 프리플라이트 `external_font`가 막는다.

폰은 `font {title 26, heading 18, body 16, label 13, meta 12}` + `line {head 15, meta 17, label 18, body 22}`.

**역할과 값이 둘 다 맞는 짝은 `meta`(12px) 하나뿐이다.** 이 축은 짝이 거의 없는 것이 정답이다:

- 웹은 rem으로 브라우저 줌을 타고, 폰은 pt로 iOS 동적 타입을 탄다.
- 줄 높이의 뜻 자체가 다르다 — 웹 관용은 **무단위 비율**(1.5), RN은 **절대 포인트 수**. 한 토큰이 둘을 못 섬긴다.
- 폰 본문 16은 **iOS 입력창이 줌을 멈추는 크기**다(`tokens.ts`의 `font` 주석). 웹 본문 14에 "맞추면" 로그인 폼이 포커스에서 줌한다.
- 웹 `--text-title`(16px)과 폰 `font.body`(16)는 값이 같지만 **우연이다.** 짝으로 적으면 웹이 제목 크기를 바꾸는 날 폰 본문이 함께 끌려간다.

짝이 없으므로 폰 쪽은 **관계로** 잰다(#1163·#1186이 accent 파생과 상태 3가족에 쓴 방식): 줄 상자는 자기가 담는 글자보다 크고, 머리줄 상자(`head`)는 묘비 상자(`label`)보다 얇으며, 다섯 크기와 네 줄 상자는 겹치지 않고 한 방향으로 간다.

### 2.6 그림자·모션 — 두 축의 정의

> ADR-0179 (Accepted 2026-09-02). 웹 토큰·상수·눌림 단일점·강제 기제는 UX-R0(#1958). 표면 이관(모달·패널·도착·스켈레톤)은 UX-R1a~e. 밀도·가상 rem은 BZ-5b. 폰 파생은 M1a.

**그림자는 이 시스템에서 유일하게 두 클라를 가로질러 대조할 수 없는 축이다.** RN은 그림자에 세 개의 별개 API를 갖는다: `boxShadow`(New Architecture 전용) · `shadowOffset/Opacity/Radius`(iOS 전용) · `elevation`(Android 전용, z-order까지 바꾼다). 한 CSS 문자열이 그 셋으로 번역되지 않는다 — Skyscanner는 파이프라인을 제대로 만들고도 안드로이드 그림자가 전부 `undefined`였다(감사 §A-1-3).

그래서 지키는 것은 패리티가 아니라 **어휘**다. 고도는 두 단이고, ADR-0179 D6이 이름을 준다:

| 이름 | 클래스 | 자리 |
|---|---|---|
| `--elevation-rest` | `shadow-sm` | 카드. Tailwind v4 `--shadow-sm` |
| `--elevation-float` | `shadow-lg` | 떠 있는 표면(팝오버·팔레트·드로어). Tailwind v4 `--shadow-lg` + `backdrop-blur` 5px 스크림 |

3단은 들이지 않는다(ADR-0159 D5). 웹 클래스는 그대로 `shadow-sm`/`shadow-lg`이고, 이름은 `clients/web/src/design/motion.css`가 진다. `designSystem.test.ts`가 그 두 이름과 클래스 어휘를 잠근다. 폰: `shadowColor`는 언제나 팔레트 역할(`color.shadow`)이다. 그림자는 색이 아니라 아래 방향이라 두 스킴이 같은 값을 드는 유일한 역할이다.

**모션은 전면 토큰 축이다.** 손기입 `\d+ms`·`duration-[0-9]+`는 `motion.css`(사다리 + 모달 200/150)와 `motion.ts`(클래스 조립)에만 산다. Tailwind 기본 `transition` 은 `@theme`의 `--default-transition-duration: var(--motion-instant)` / `--default-transition-timing-function: var(--motion-ease-standard)` 가 사다리에 묶는다. 그 밖 tsx/css의 리터럴은 프리플라이트 `raw_motion` 위반이다.

| 토큰 | 값 | 자리 |
|---|---|---|
| `--motion-instant` | 120ms | 피드백 — 눌림·색·툴팁 |
| `--motion-fast` | 180ms | 작은 표면 — 팝오버·드롭다운·칩 |
| `--motion-standard` | 240ms | 상태 변화 — 패널·리스트 삽입·사이드바 접기·**드로어**(`--duration-sidebar`도 이 값) |
| `--motion-arrival` | 500ms | 합성 도착 — 새 메시지·첫 진입. UX-R1d: `motion-enter-conversation` + `@utility enter-conversation` |
| `--motion-modal-open` / `--motion-modal-close` | 200ms / 150ms | D4 예외 2호. `motion.ts`의 `MODAL_*_MOTION` 이 소비 |
| `--motion-ease-standard` | `cubic-bezier(0.25, 1, 0.5, 1)` | 기존 `ease-out` 손기입의 흡수처 |
| `--motion-ease-arrival` | `cubic-bezier(0.16, 1, 0.3, 1)` | 도착 전용 |
| `--motion-distance-arrival` | 0.75rem | 도착 translateY (값만. 재생은 UX-R1) |
| `--motion-blur-arrival` | 2px | 도착 blur (값만) |

비대칭: 사라짐은 나타남보다 짧다. 모달만 열림 200 / 닫힘 150. 온보딩 예외 블록(`tokens.css` `Onboarding S0 motion` … 다음 `@layer base`)의 사다리 밖 값:

| 값 | 자리 |
|---|---|
| 650ms | line-slide |
| 760ms | mask-reveal |
| 300ms ×3 | `onboarding-fade-in` (wordmark · tagline · fade effect) |

**이 목록 말고 사다리 밖 값을 늘리지 마라.**

눌림(D5): Button 전 variant는 `.press`(`transform: scale(0.98)` + instant, 색 전이 목록 포함, `outline-color` 없음)만 든다. `transition-colors`와 함께 두지 않는다. 행·칩 상속은 DS-1. 본문 텍스트를 드래그로 고를 수 있어야 하는 표면에는 `.press`를 얹지 않는다(#1743 B-4). 텍스트 링크는 `<a>`/`<button>`/`Link`/`NavLink`의 렌더가 글자뿐인 것 — 밑줄 또는 `hover:text-` 이고 **채움과 상자(어떤 `border*` 클래스·배경 상자)가 없는** 것이다. 패딩만 있는 터치 타깃은 상자가 아니다. 전폭 행은 컨테이너를 채우는 목록 행/아이템이다(`w-full`, 열 목록의 `flex-1`, `li` 를 가로지르는 `a`/`button`/`Link`/`NavLink`, `role=option|menuitem*|treeitem`). 채움만 (`hover:bg-surface-hover` / `active:bg-surface-pressed`, cmdk 는 `data-[selected=true]:active:bg-surface-pressed`), `.press` 스케일 없음. 선택 행은 hover 에서 선택 채움을 유지하고 press 에서 눌림 채움을 낸다. 변형은 전폭이 아닌 컨트롤에만. 메뉴 행은 `.press-instant-fill`.

reduced-motion(D9): 사다리 네 duration과 모달 200/150은 `0ms`가 된다. 모션을 끄는 것이 아니라 0으로 만든다 — 상태는 착지한다. 온보딩 rAF 필드는 현행대로 시작하지 않는다.

루프 애니메이션(캐럿 1.1s, 스피너 0.9s/1.6s, 업로드 드리프트 1.1s/3.2s)은 사다리가 아니라 **정보가 곧 움직임인 자리**라 초 단위로 남는다(SKILL §4).

폰 사다리는 웹과 이름·값이 같다. 2026-07-28 권고 `instant 0 / fast 120 / standard 180 / slow 240`은 이 결정이 대체한다 — `instant 0`은 값이 아니라 reduced-motion 상태다. 폰 `tokens.ts` 파생은 M1a.

아직 이 축이 안 재는 것(owed, 이 PR이 닫지 않음):

| 항목 | ADR | 티켓 |
|---|---|---|
| `hover:`만 있고 `active:`가 없는 신규 표면 preflight | D5 | DS-4 |
| 캡처 `waitForAnimations(page)` | D10 ③ | DS-3 |
| rest/hover/active 3짝 캡처 레인 | D10 ④ | UX-R1e (#2000) 닫힘 |
| 폰 모션·밀도 값 파생 + 바이트 대조 | D10 ⑤ | M1a |

### 2.7 터치 타깃

| 값 | 웹 | 폰 | 근거 |
|---|---|---|---|
| **44** | `--tap-target` + `@utility tap-target`(600px 미만에서만 자란다) | `TOUCH_TARGET` | WCAG 2.5.5 / Apple HIG |
| **24** | `--touch-target` + `@utility touch-target`(`hover: none`에서만) | — | WCAG 2.5.8 AA 바닥선. 본문에 섞여 사는 링크용 |

44는 두 클라가 같은 값을 들고 `designSystem.test.ts`가 대조한다. 24는 폰에 짝이 없다.

**폰에서 44는 손으로 적는 값이 아니라 도출되어야 하는 값이다.** `slopTo(size)`가 콘텐츠 상자 크기에서 슬롭을 계산한다 — 슬롭을 손으로 적었을 때 아무도 산수를 다시 확인하지 않아서 답글 표식 29pt · 롤업 29pt · 오류 닫기 33pt가 출하됐던 것이 이 함수가 생긴 이유다(감사 M-14).

다만 **아직 전면 적용이 아니다.** `slopTo`를 쓰는 것은 그 결함이 발견된 `MessageRow.tsx` 하나이고, 다섯 자리가 여전히 숫자를 손으로 적는다(`atoms.tsx` · `StopTurnControl.tsx` · `LongPressHint.tsx` · `MessageBody.tsx` · `Quote.tsx`). `designSystem.test.ts`가 강제하는 것은 "전부 도출"이 아니라 **"그 다섯이 여섯이 되지 않는 것"**이다 — 새로 손으로 적으면 빨갛고, 기존 다섯은 세어진 채 남아 있다.

### 2.8 아이콘 — `lucide-react`가 기능 글리프의 정본이다

웹·Tauri 제품 표면의 기능 아이콘은 **`lucide-react` 한 벌만** 쓴다(ADR-0172,
Accepted). 의미가 같은 Lucide 글리프가 있으면 로컬 `<svg>`·CSS 도형·아이콘 폰트·
기능 이모지를 새로 만들지 않는다. 이름은 화면에서 하는 일에 맞춘다. 예를 들어 검색은
`Search`, 인박스는 `Inbox`, 설정은 `Settings`, 복사는 `Copy`, 시각은 `Clock`, 링크는
`Link`/`ExternalLink`, 플래그는 `Flag` 계열이다. 모양이 완전히 같은가보다 **행동이 같은가**가
선택 기준이다.

- **가져오기와 번들:** 아이콘을 정적인 named import로만 가져온다. `import * as Icons`,
  런타임 이름 조회, 전체 아이콘 사전은 금지한다. `lucide-react`는 `sideEffects: false`이고
  Vite 프로덕션 빌드가 사용한 export만 tree-shake한다. 아이콘을 늘린 PR은 전·후 gzip
  번들을 실측해 이 전제가 실제 산출물에서도 맞는지 기록한다.
- **크기:** 기본은 16px(`size-4`) **하나다** — 직접 지정이 대다수이고 나머지는 버튼
  프리미티브의 `[&_svg]:size-4`(레포 유일의 부모 크기 계약, `button.tsx`)가 진다.
  20px(`size-5`)는 레포에 **0건**이다(헤더 상위 액션 — 허들·핀·터미널 — 도 16px).
  두 번째 기본을 들이는 것은 관례 추가가 아니라 이 절의 개정이다. 교체하면서 컨트롤
  상자·패딩·행 높이를 바꾸지 않는다. 12px·24px처럼 기존의 측정된 기하를 보존하는
  예외가 **소수 실재**하고(크기는 태그 리터럴·지역 const·컴포넌트 prop 세 경로로
  오며 셋째는 이름으로 보이지 않는다), 그 예외는 해당 컴포넌트가 이유를 진다 —
  오늘 사유 주석은 0곳이다. **이 축을 세는 기계는 없고**(§5.3), 손으로 센 수는 여기
  적지 않는다 — 세 경로 탓에 수가 곧 썩는다.
- **획과 색:** Lucide 기본 획 2를 유지하고 개별 아이콘에서 `strokeWidth`를 다시 정하지
  않는다. 색은 언제나 `currentColor` 상속이며 토큰 텍스트 클래스가 부모 또는 아이콘에
  놓인다. `stroke`·`fill` 색 하드코딩은 0이다.
- **접근성:** 새로 놓는 장식 아이콘(옆에 읽는 레이블이 있는 것)은 `aria-hidden`을
  단다. 아이콘만 있는 버튼은 `aria-label`을 보존하고, 아이콘 이름을 접근성 이름으로
  대신 쓰지 않는다. `lucide-react`는 기본 props에 `aria-hidden`을 넣지 **않으므로**
  빼먹으면 이름 없는 그래픽이 접근성 트리에 남는다 — **잔량: 오늘 `aria-hidden` 없는
  배치 57곳, 그중 인접 레이블조차 없는 36곳**(QuickSwitcher 12곳 포함). 이 축을 재는
  기계는 없다(§5.3).

**로컬 SVG 예외 목록은 아래 다섯 파일로 닫혀 있다.** 브랜드 글리프 넷과, 데이터가
행렬로 그려진 QR 하나. QR은 아이콘이 아니다: 글리프가 아니라 스캔용 페이로드를
모듈 격자로 렌더한 것이다. 기능 아이콘이 아니다.

| 파일 | 존치 사유 |
|---|---|
| `clients/web/src/design/brand/OortMark.tsx` | Lucide에 없는 제품 브랜드 마크. 앱 안에서 `currentColor`를 상속한다. |
| `clients/web/src/features/auth/OortCloudMarks.tsx` | S0 오르트 구름 산포(혜성·소행성·4촉 별) 라인아트. Lucide에 없는 도메인 글리프이고 기능 아이콘으로 재사용하지 않는다. |
| `clients/web/src/features/settings/DeviceLinkCard.tsx` | 기기 연결 딥링크를 담는 스캔용 QR 행렬. Lucide `QrCode`는 16px 아이콘이라 페이로드를 인코드하지 못한다 (#1989). |
| `clients/web/public/oort-mark.svg` | CSS가 닿지 않는 문서·배포·링크 미리보기용 정적 브랜드 자산. |
| `clients/web/public/favicon.svg` | 브라우저가 직접 읽는 고정 파비콘 브랜드 자산. |

각 파일은 `icon-system-exception(ADR-0172)` 주석으로 이유를 선언한다. 기계 정본은
`clients/web/src/design/iconSystem.test.ts`다. 새 raw SVG 또는 정적 SVG는 목록 밖이면
실패하고, 예외를 늘리려면 이 절과 해당 파일의 사유를 같은 변경에서 갱신해야 한다.

---

## 3. 위계 규칙 — 파괴 > 주 > 보조

> **이 축은 우리가 업계보다 앞서 있다.** 시각 위계를 기계로 강제하는 프로덕션 도구는 존재하지 않고(있는 것은 전부 학술 프로토타입), 위계를 **토큰의 채도·채움 순서로** 성문화한 선례를 감사가 1차 소스에서 찾지 못했다(§A-3-2). 그러니 여기 적힌 것을 지우지 마라.

### 3.1 규칙

한 푸터·한 행에 컨트롤이 나란히 서면, 되돌릴 수 없는 것이 가장 크게 보여야 한다.

1. **채도 순서**: `danger` > `warn` > `ink-muted`. 대비가 아니라 OKLab 채도로 잰다.
2. **채움 순서**: 주 액션 채움(`--accent`) > 파괴 채움(`--danger-fill`). 파괴는 무겁되 **기본 경로가 아니다.**
3. **윤곽 순서**: 파괴 컨트롤의 윤곽(`--danger`)은 비파괴 컨트롤의 윤곽(`--line-strong`)보다 진하다.
4. **컨트롤 경계는 3:1이다**(WCAG 1.4.11). 채움이 3:1로 컨트롤을 식별시키면 경계는 면제된다 — 그런데 그 면제를 주장하려면 채움을 실제로 재야 한다.

### 3.2 왜 값이 아니라 관계인가 — dark1155 M1

**비파괴 컨트롤 하나의 경계를 3:1로 올리는 수리가, 그 옆의 파괴 형제를 화면에서 가장 흐린 선으로 만들었다.**

로그아웃 확인 다이얼로그에서 취소 버튼의 테두리를 `border`(다크 1.41 · 라이트 1.32)에서 `textFaint`(다크 3.91 · 라이트 3.59)로 올렸다. 그 수리는 정확했고 검산도 맞았다. 그런데 옆에 선 파괴적 확인 버튼의 테두리는 여전히 **다크 1.70 · 라이트 1.76**이었고, **나란한 두 버튼 중 파괴적인 쪽의 유일한 윤곽선이 화면에서 가장 흐린 선이 됐다.** 팔레트 산술 가드는 그 내내 전부 초록이었다.

(값은 그때의 폰 팔레트 기준이다 — `#1163` 이전. 지금 값은 §3.3의 표에 있고, 두 스킴 순서를 여기와 반대로 적지 않도록 양쪽 다 이름을 붙였다.)

각 값이 개별적으로 옳으면서 전체가 틀릴 수 있다. 그래서 위계는 **두 값 사이의 순서**로 적는다.

### 3.3 지금 기계가 재는 것 / 안 재는 것

> **이 절과 §5.3·§5.4의 "#1210" 표시는 유통기한이 있다.** #1210(컨트롤 경계 3:1 · 폰 파괴 채움 토큰 · 포커스 링 페이드 · 웹 lint 게이트 배선)이 랜딩하면 아래 ❌ 넷과 §5.4의 lint 항목이 함께 닫힌다. **그 PR이 이 표를 갱신하는 것이 마지막 한 걸음이다** — 닫힌 자리를 열려 있다고 말하는 표는 이 문서가 막으려는 바로 그 결함이다.

| 규칙 | 웹 | 폰 |
|---|---|---|
| 채도 순서 (danger>warn>muted) | `tokens.contrast.test.ts` ✅ | `paletteContrast.test.ts` ✅ |
| 채움 순서 (accent>danger-fill) | `tokens.contrast.test.ts` ✅ | ❌ — **폰에 파괴 채움 토큰이 없다**(#1210) |
| 윤곽 순서 (danger>line-strong) | `tokens.contrast.test.ts` ✅ (#1211) | ❌ — #1210이 토큰을 놓은 뒤 같은 자리에 |
| `--line`이 3:1을 못 넘는다(규칙의 전제) | `tokens.contrast.test.ts` ✅ (#1211) | `paletteContrast.test.ts` ✅ |
| **어느 컴포넌트가 어느 쪽을 쓰는가** | `designSystem.test.ts` ✅ (#1211, 프리미티브 층) | ❌ 체계적으로는 없다 — 표면 하나에 대한 단정은 있다(`adeControlSurface.test.tsx:939`) |
| 렌더된 화면에서의 위계 | ❌ 사람 + design-review 에이전트 | ❌ 동 |

**"이 테두리가 컨트롤 경계인가"는 문법 질문이 아니라 의미 질문이라 grep으로 못 잡는다** — 감사의 판정이고 옳다. `clients/web/src`에서 주석을 벗기고 세면(가드가 쓰는 그 방법) **약한 선 198회 · 강한 선 17회**이고, `card.tsx`·`dialog.tsx`·`dropdown-menu.tsx`의 `border-line`은 컨테이너라 정당하다.

그런데 그 판정이 의미 질문인 이유는 **한 번도 이름을 안 붙였기 때문이다.** 어느 파일이 컨트롤 프리미티브인지를 한 자리에 적으면 남는 것은 문법 질문이 된다:

- **컨트롤 프리미티브** (경계가 어포던스를 진다): `button.tsx` · `input.tsx` · `select.tsx`
- **컨테이너 프리미티브** (경계는 나누는 선이다): `card.tsx` · `dialog.tsx` · `dropdown-menu.tsx`

`designSystem.test.ts`가 ①이 분류표가 `src/design/ui`의 모든 파일을 덮는지(새 프리미티브는 반드시 한쪽에 든다) ②컨트롤 프리미티브가 나누는 선을 경계로 쓰지 않는지를 잰다.

> 남은 위반 하나 — `button.tsx`의 `secondary` 변형. `--surface` 위에서 경계 `--line`이 라이트 1.32 · 다크 1.43이고 채움(`--surface-raised`)도 라이트 1.07 · 다크 1.10이라 면제에도 걸리지 않는다. 바로 옆 `outline` 변형은 같은 모양의 버튼인데 `--line-strong`(3.59 / 3.56)을 든다. 수리는 **#1210**.

---

## 4. 상태 규칙 — 네 상태

**모든 표면이 빈 · 로딩 · 오류 · 오프라인을 갖고 출하한다.** (출처: `.claude/skills/momo-design-taste-web/SKILL.md` §5 · mac 스킬의 표면별 필수 상태표)

| 상태 | 규칙 |
|---|---|
| **빈** | 행동으로의 초대 — 한 줄 카피 + 액션 하나. 둘째 액션은 그것이 어떤 기능으로 가는 유일한 문일 때만 서고, 그때는 §3 채움 순서로 위계를 세운다(주=채움, 보조=윤곽 — 동급 금지. 선례: 빈 채널 #1568, 위계는 게이트가 잰다). 일러스트 포스터도, 가운데 정렬 아트도 아니다. 조용한 인박스는 실패가 아니라 **설계된 것**으로 말한다("조용한 게 정상입니다"). |
| **로딩** | 높이를 보존하는 중성 스켈레톤 바. **시머 금지.** 액션은 버튼 안 스피너. 스트리밍 텍스트는 캐럿을 달지 시머를 달지 않는다. |
| **오류** | 무슨 일이 일어났고 다음에 무엇을 할지를 **맥락 안 인라인**으로. 토스트 금지, 사과 금지, 모호함 금지. |
| **오프라인** | 인라인 배너 하나(WS 끊김). 캐시된 내용은 계속 렌더된다(내구층, P15). 재연결 시 seq 복구 표지("seq N까지 복구"). |

**이 축은 100% 사람이 잡는다.** 리뷰 코퍼스 2위(상태 누락 16건/4리포트)이고 기계 검사는 존재하지 않는다 — "이 표면에 빈 상태가 있는가"를 물으려면 표면이 무엇인지 알아야 하고, 그 목록은 코드에 없다.

가장 가까운 대체물은 **캡처 레인**이다: `clients/mobile/measure/states.tsx`가 실제 `Timeline`에 상태별 props를 먹여 사진을 찍고, `clients/web/scripts/capture-screens.mjs`가 두 스킴 × 데스크톱/폰 프로파일로 찍는다. 사진은 사람이 본다.

---

## 5. 강제 기제 지도

> **이 절이 이 문서에서 가장 실용적인 부분이다.** "기계가 잡았어야 했는데 안 잡았다"가 감사의 두 번째 메타 패턴(17건/10리포트)이었고, 그 대부분은 **무엇이 안 재지는지를 아무도 몰랐기** 때문이다.

### 5.1 층 다섯

| 층 | 어디 | 무엇 |
|---|---|---|
| **셸 그렙 프리플라이트** | `scripts/design_preflight_web.sh` | 웹 13분류 + 코어 5분류, **하드 제로** |
| **단위 스위트 단정** | `clients/web/src/**/*.test.ts` · `clients/mobile/__tests__/*` | 토큰 산술 · 소스 전수 스윕 · 렌더 트리 실측 |
| **Playwright 게이트** | `clients/web/gates/gate-*.mjs` (24개) | 티켓별 기하·상태·회귀. 셋만 렌더 대비를 계산한다 |
| **캡처 레인** | `clients/web/scripts/capture-screens.mjs` · `clients/mobile/measure/*` | 사진 + 단정(가로 오버플로 0 · 탭 타깃 · 상단 여백 · 컴포저 가시성) |
| **병합 트리 게이트** | `scripts/verify_merge_tree.sh` | 병합 **결과**에서 7레인(코어·웹·폰 typecheck + 스위트 + 카피 스캔) |

### 5.2 축 × 기제

| 축 | 웹 | 폰 | 두 클라 대조 |
|---|---|---|---|
| **색 값** | 프리플라이트 `raw_color`/`pure_bw` + ESLint `no-restricted-syntax`(**게이트 미배선** §5.4, 6자리 hex 한정) | `conversationHygiene.test.tsx:519` (`src/` 전수 hex 0) | `paletteContrast.test.ts` — 웹 CSS 파싱 **바이트 대조** ✅ |
| **색 대비** | `tokens.contrast.test.ts` (토큰 쌍, 두 스킴) | `paletteContrast.test.ts` (동) | 같은 규율, 같은 자 |
| **간격** | `--spacing: initial`(격자 밖 *단계*만 차단) + 프리플라이트 `arbitrary_tw`(임의값) + `spacing.test.ts`(코어 값 ↔ 클래스) + `designSystem.test.ts`(리듬 8단계 고정·이름 축 근거 강제) | `designSystem.test.ts` **`src/` 전수 스윕** + `conversationVisual.test.tsx:229`(2파일 심층) | `designSystem.test.ts` — 웹 CSS 파싱 ✅ (#1211) |
| **반경** | `--radius-*: initial`(이름 단계만) + `arbitrary_tw`(`rounded-[9px]`) + `designSystem.test.ts`(3단계·순서) | `designSystem.test.ts` 전수 스윕 | `designSystem.test.ts` — 짝 1 · 분기 1(상한 포함) ✅ (#1211) |
| **타이포** | `--text-*: initial`(이름 단계만) + `arbitrary_tw`(`text-[13px]`) + `designSystem.test.ts`(롤마다 줄 높이·크기 중복 금지) | `designSystem.test.ts` 전수 스윕(`fontSize`·`lineHeight`) | `designSystem.test.ts` — 짝 1 · 나머지 관계 ✅ (#1211) |
| **그림자** | `designSystem.test.ts` — `--elevation-rest/float` 이름 + 클래스 두 단 | `designSystem.test.ts` — `shadowColor`는 팔레트에서만 | **대조 불가 축**(§2.6) |
| **모션** | `motion.test.ts`(사다리·상수·눌림·reduced-motion) + 프리플라이트 `raw_motion` | ❌ (M1a) | 값 파생은 M1a |
| **터치 44** | `capture-screens.mjs`의 `assertTapTargets`(**손으로 유지되는 12개 목록**) | `conversationHygiene.test.tsx:148` (렌더 트리 실측) + `conversationA11y.test.tsx:330` + `designSystem.test.ts`(손으로 적은 슬롭 잔량 5, 늘면 빨강) | `designSystem.test.ts` — `TOUCH_TARGET` ↔ `--tap-target` ✅ (#1211) |
| **컨트롤 경계 3:1** | `tokens.contrast.test.ts`(토큰) + `designSystem.test.ts`(프리미티브 층) | `paletteContrast.test.ts`(토큰) | — |
| **위계** | §3.3 표 | 동 | — |
| **카피** | 프리플라이트 `hype` + AST `emdash`·`progress_word`·`latin_particle`(#1511) | `conversationHygiene.test.tsx` — `src/` 전수 em-dash 스윕 + 같은 AST 로 `progress_word`·`latin_particle`(`design_preflight_phone_strings.mjs` 를 자식 프로세스로, #1511) | `design_preflight_ast.mjs` 가 세 소비자의 규칙 한 벌. 코어에도 거는 이유는 실측이다 — 진행 낱말이 코어 상수로 폰까지 출하됐다(`CANCEL_BUSY_LABEL`) |
| **포커스** | 프리플라이트 `naked_focus` — 링이 **있는지**만. 링의 성질은 §5.3 | ❌ | — |
| **인라인 스타일** | ESLint + 프리플라이트 `inline_style` (CSP) | 비해당 | — |
| **아이콘** | `iconSystem.test.ts` — **`src/**/*.tsx`의 `<svg` 리터럴 + `public/**/*.svg` 전수**와 **정적 named import 형태**만. 그 밖의 유입 경로는 전부 §5.3 | ❌ (ADR-0172가 명시적으로 범위 밖) | — |

### 5.3 무검사 — 사람만이 잡는 것

**이 목록이 짧아지는 것이 이 시스템의 진행이다.** 각 항목의 리뷰 코퍼스 순위를 함께 적는다.

| 순위 | 축 | 왜 기계가 못 잡나 |
|---|---|---|
| 2위 (16건) | **상태 누락**(빈·로딩·오류·오프라인) | "표면"의 목록이 코드에 없다 |
| 5위 (11건) | **시각 위계 역전** — 렌더된 화면에서 | 프로덕션 도구가 세상에 없다(§3 머리말) |
| 7위 (9건) | **한국어 텍스트 처리** — 조사 고아, `break-all`, 의존형태소 절단 | 이 축에서 **한 모양만** 기계로 내려왔다: 라틴 낱말 뒤 조사의 공백(「Esc 는」 → `latin_particle`, #1511). 그 하나는 소스에서 보이기 때문이다. **세 클라 전부에서 재지만 실행 단위가 다르다** — 웹·코어는 `design_preflight_web.sh`, 폰은 jest(`conversationHygiene.test.tsx` → `design_preflight_phone_strings.mjs`). 나머지는 그대로 없다 — 조사 고아 일반·`break-all`·절단은 **렌더된 폭**에 달렸고, `fontStyle: italic`이 한글에서 0픽셀이라는 발견은 이 축에서만 나온다 |
| 7위 (9건) | **증거·캡처 공백** — 사진 없음/낡음/비현실 픽스처 | 정의상 사람 |
| 10위 (7건) | **한 클라 안의 내부 불일치** — 같은 것에 두 처리 | "같은 것"의 판정이 의미 질문 |
| 13위 (6건) | **스크린리더 시맨틱** — 로터 도달성, aria 바인딩, 라이브 리전 | axe 도입 시 일부 커버 |
| 14위 (5건) | **상태 수명주기** — 로그아웃/새로고침 생존, 조용한 덮어쓰기 | 사람 |
| 16위 (4건) | **화면이 거짓을 말함** | 손으로 짠 런타임 프로브가 필요했다 |
| — | **포커스 링의 *성질*** — 페이드·트랜지션·애니메이션 | 프리플라이트 `naked_focus`는 링이 **있는지**만 본다. 링이 잉크색에서 호박색으로 번지는 것(Tailwind v4 `transition-colors`가 `outline-color`를 포함한다 — v3엔 없던 것)은 `transition-colors`와 `focus-visible:outline-*`를 함께 든 **클래스 리스트 25곳**에 있고, 리뷰 16건이 한 번도 못 잡았다 — 수리·재발 방지는 **#1210** |
| — | **웹의 렌더된 컨트롤 경계·터치 크기 전수** | 지금은 토큰 층과 프리미티브 층까지만 잰다. 렌더 스윕은 미구현(감사 §C-3-b·c) |
| — | **칩의 *테두리*** — 「이 알약이 컨트롤로 읽히는가」 | `chipVessel.test.ts`는 `bg-*`만 읽는다. #1516이 검증 칩 하나에서 테두리를 걷었지만 같은 모양이 `SettingsFields`의 `StatusChip`(다섯 톤 셀 × 일곱 설정 표면)과 `AgentTurnBadge.tsx:34`·`AgentWorkPanel.tsx:233-234`에 남아 있고(`AgentHubRoute` 자리는 #1957이 닫음), **그 축에는 기계가 아무것도 없다.** 그릇과 달리 「테두리가 어포던스인가」는 §3.3의 그 의미 질문이라 grep으로 못 가른다 — 프리미티브에 했던 것처럼 **분류에 이름을 붙이는 것**이 다음 걸음이다 |
| — | **hover·선택 상태의 사진** | 이 시스템의 게이트는 마우스를 일부러 치워 둔다(`gate-workstream.mjs:875` — hover 잔상이 150ms 전이와 겹쳐 측정을 흔든다). 그래서 **이 문서가 다루는 결함(그릇이 hover에서 사라진다)을 찍은 레인이 하나도 없었다**: 회전 2의 1.000 두 건은 리뷰어가 손으로 hover 프레임을 계측해 찾았다. `gate-my-sessions`에 rest/hover 짝 캡처를 신설해 그 공백의 첫 칸을 메웠다(아래 §5.4 레인) — 나머지 표면은 미구현 |
| — | **비텍스트 대비(WCAG 1.4.11)를 살 수 있는 곳** | **없다.** Deque 자사 데이터로 axe DevTools 커버리지 **0.00%**(자동·인간보조 모두 0, 100% 수동). 우리 손수 만든 시험을 지우면 대체물이 없다 |
| — | **아이콘 규칙의 나머지 전부**(§2.8) | `iconSystem.test.ts`는 예외 목록과 import 형태 **둘만** 잰다. 16px 단일 기본·`strokeWidth` 재지정 금지·`currentColor` 상속·`aria-hidden`(잔량 57곳/인접 레이블 없는 36곳)·CSS 도형/아이콘 폰트/기능 이모지 회피·`src/**` 아래 SVG 자산 유입·**`.ts` 파일 안 손제작 SVG·`createElement("svg")`**(둘 다 초록 통과 실증) — 전부 무검사다. §2.8이 잔량을 세어 둔 이유다 |

> **폰에는 taste 스킬 방언이 없다.** `.claude/skills/momo-design-taste`(SwiftUI)와 `-web`(React) 둘뿐이고, `tokens.ts` 머리 주석이 그것을 자백한다. `.claude/agents/design-review.md`의 계약도 macOS/Core를 가리키는데 최근 리뷰 대부분은 웹·폰이다 — ADR-0159 D4가 Swift 삭제 배치와 함께 재조준하기로 한 자리다.

### 5.4 게이트 실행 경로 — 강제 층의 실행 보장은 **사람**이다

- GitHub Actions는 디자인 게이트를 **하나도** 돌리지 않는다. `.github/workflows/ci-build.yml`은 Swift 빌드뿐이고 그마저 `workflow_dispatch` 전용이다. 기본 머지 게이트는 `docs/LOCAL_PR_GATE.md`의 로컬 증거다.
- `scripts/local_gate.sh --profile web`의 lint 레인은 **`clients/web-legacy`**(동결된 레거시 클라)를 본다. 정본 UI `clients/web`의 ESLint는 어느 게이트에도 안 걸려 있다 — 배선은 **#1210**. *완화 요인*: 그 두 규칙(hex 금지·인라인 style 금지)은 프리플라이트 그렙이 중복 커버한다. 그래서 지금 손실은 없지만 **중복이 유일한 안전망**이다.
- 폰에는 "디자인 프리플라이트"라는 이름의 **실행 단위**가 없다. 검사는 `npm test`(jest) 안에 섞여 있고, 그것은 병합 트리 게이트의 `phone suite` 레인으로 **돈다**. 무엇이 커버되는지를 한눈에 못 볼 뿐이다. 한 조각은 이름을 얻었다 — `scripts/design_preflight_phone_strings.mjs`(낱말꼴 두 분류, #1511)는 웹·코어와 같은 규칙 객체를 들지만, 부르는 쪽은 여전히 jest다(`conversationHygiene.test.tsx`가 자식 프로세스로 돌린다). 쉘 `design_preflight_web.sh`는 이름 그대로 웹의 단위이고 폰을 부르지 않는다.

### 5.5 이 레포가 배운 두 가지 실패 양식

**① 사본을 두면 사본이 거짓말한다.** `spacing.test.ts` 1차는 `TAILWIND_SPACE_PX`가 **Tailwind 기본 스케일**을 열거하고 있었다 — 이 레포가 쓰는 표가 아니라. 거기엔 `1.5`가 있으므로 검산은 8/8 통과했고, 브라우저에는 그 클래스가 없었다. 지금은 가드가 `tokens.css`를 파싱해서 답한다. **모든 새 가드는 정본 파일을 읽는다. 기대값을 베껴 적지 않는다.**

**② 허용목록과 잔량은 다른 물건이다.**

| | 정하는 것 | 목록 밖은 | 예 |
|---|---|---|---|
| **허용목록** ❌ | **무엇을 재는가** | 측정되지 않는다 | `capture-screens.mjs` 의 탭 타깃 목록들 — `MOBILE_TAP_TARGETS`(12) · `LOGIN_TAP_TARGETS`(4) · 그리고 인라인 1건 |
| **잔량** ✅ | 무엇이 **아직 안 닫혔는가** | 0이어야 한다 | `designSystem.test.ts`의 `REMAINING` 표들 |

잔량 목록은 재는 대상을 좁히지 않는다 — 재는 것은 언제나 전수이고, 목록은 그 전수가 오늘 세어 낸 수다. 줄어드는 것은 통과하고(가드가 수리를 벌하면 안 된다), 늘어나면 빨갛다.

---

## 6. 규칙을 바꾸는 법

### 행 액션 표면 (2026-08-24 성재 지시, #1743)

스킬 §6의 옛 문장("행 액션은 메뉴로")은 B11 R1이 여섯 버튼 바를 `opacity-0`으로 숨겼다가 가상화 타임라인에 탭스톱 ~150개를 만든 실패와 묶여 있었다. 호버 퀵액션 툴바를 재도입하는 조건은 그 두 실패를 닫는 것이다:

1. **조건부 렌더.** 비호버·비포커스 행은 툴바 DOM을 마운트하지 않는다. opacity/visibility 트릭 금지.
2. **한 탭스톱.** 툴바 항목은 행의 로빙 그룹에 편입된다. 행당 추가 탭스톱 ≤ 1. rest 정거장은 행 자신이며, 키보드 포커스(`:focus-visible`)일 때만 ⋯로 핸드오프한다. 마우스 mousedown 포커스는 핸드오프하지 않는다(본문 드래그 선택).
3. **메뉴에만 남는 것.** 고치기/지우기는 overflow `⋯`와 우클릭 메뉴에만 있다.
4. **터치.** `(hover: none)`에서는 툴바를 그리지 않는다. 길게 누르기 시트는 그대로다.
5. **본문 겹침 금지 (B11 R2 Blocker).** 툴바는 행 상단 경계를 걸치는 플로팅 그릇이다. 위쪽이 스크롤러 상단에 막히면 행 하단으로 뒤집는다. 자기 행·이웃 행의 본문 텍스트 Range와 교차 면적 0. 겹침은 계약이 아니다.

정본 구현: `clients/web/src/features/timeline/MessageActions.tsx` (`MessageHoverToolbar`).

기계 자가 **닫은** 축: 호버/포커스/터치 4상태 마운트 수, 행당 탭스톱(정적 스냅샷, 행 요소 정거장 포함), 본문 텍스트 Range ∩ 툴바 상자 = 0 (`assertHoverToolbarClearsBodyText`, 자기 행+이웃 행), 툴바 React 버튼 클릭 → 피커 오픈, 본문 드래그 선택 무간섭(`assertActionableRowDragSelect`), 스크롤러 상단 뒤집기(`assertHoverToolbarInsideScroller`).

기계 자가 **아직 안 재는** 축: 순회 중 탭스톱 +1(유닛이 행당 1 불변; 캡처 `countTabStopsToComposer`가 전체 비용만 잰다), 다크 그릇 분리(토큰 §2.2 산술 + 사람 리뷰), 슬롯 클릭 직후 재배열(유닛이 마운트가 유지되는 동안 고정 — 포커스가 마운트를 유지할 수 있다).

### 스케일에 값을 하나 더하고 싶을 때

1. **먼저 이름을 지어 보라.** 격자 밖 측정값은 숫자가 아니라 이름으로 들어온다(`--spacing-pane`, `--spacing-preview-frame`). 이름을 못 짓겠으면 그 값에 이유가 없다는 뜻이다.
2. **이름을 지었으면 주석으로 근거를 진다.** 왜 리듬 밖인지, 어느 축인지(폭/높이/컨트롤/측정값), 실측이 있으면 실측을. `clients/web/src/design/designSystem.test.ts`가 **주석이 붙어 있는지**를 강제한다(묶음 단위). 기계는 주석의 *존재*까지만 볼 수 있고, 그 주석이 실제로 근거인지는 리뷰가 본다.
3. **다른 축을 빌려 쓰지 마라.** `--spacing-preview-frame`이 생긴 이유가 앞 판이 `--spacing-action`(버튼 최소 **폭**)을 **높이**로 빌려 썼기 때문이다.
4. **리듬 단계 자체를 더하는 것은 결정이다.** `clients/web/src/design/designSystem.test.ts`의 여덟 단계 표를 함께 고쳐야 초록이 된다 — 그 diff가 리뷰에 보이는 것이 요점이다.

### 폰에 값을 더할 때

웹에 짝이 있으면 **바이트로** 같게 하고 `clients/mobile/__tests__/designSystem.test.ts`의 짝 표에 등록한다. 짝이 없으면 그 값이 지키는 **관계**를 적고 그 관계를 단정한다 — 값이 아니라 관계여야 웹이 다시 움직여도 산다(#1163·#1186).

### 새 강제 기제를 넣을 때

- 정본 파일을 **읽어라.** 기대값을 베끼면 사본이 거짓말한다(§5.5 ①).
- **전수로 재고 잔량을 세어라.** 허용목록을 만들지 마라(§5.5 ②).
- 실패 모드를 닫아라 — 짝을 못 찾으면 조용히 통과하지 말고 **터져야** 한다(`paletteContrast.test.ts:374`가 그 예를 테스트로 들고 있다).
- **가드가 수리를 벌하지 않게 하라.** 잔량은 `≤`이지 `=`가 아니다.

### 도입하지 않기로 한 것 (ADR-0159 D5, 전부 1차 소스 근거)

| | 왜 |
|---|---|
| Style Dictionary | **RN 포맷 자체가 없다.** RN 트랜스폼 그룹은 3개뿐(`name/camel`·`size/object`·`color/css`)이고 그림자·타이포·보더·트랜지션 트랜스폼이 전무 |
| DTCG 파이프라인 | **안정 스펙에 다크모드가 없다.** Resolver Module은 *"Do not attempt to implement this version"* 상태 |
| react-native-web / 범용 컴포넌트 층 | 제작자가 "Meta 투자 0" 명시, 10개월 무커밋. Airbnb: "결국 세 플랫폼을 지원하게 됐다" |
| Storybook | 비평가들이 독립적으로 수렴한 대체물("임시 라우트 + 실제 컴포넌트 + 캡처")을 우리가 이미 갖고 있다 |
| `eslint-plugin-design-tokens` | **존재하지 않는 패키지.** v1.0.0이 2024-03-14 게시되고 8.5시간 뒤 unpublish |
| stylelint | 우리 코드베이스에 구조적으로 눈이 멀었다 — CSS 선언을 파싱하므로 `className="text-[#f00]"`을 영원히 못 본다 |

---

## 7. 미결 결정

이 문서가 답하지 **않는** 것들. 각각 성재/오케스트레이터의 자리다(감사 §C).

| # | 결정 | 지금 상태 |
|---|---|---|
| 1 | 반경 `md` 10 vs 8을 맞출 것인가, "플랫폼별로 다름 + 사유"를 정식 개념으로 둘 것인가 | 분기가 세어지고 상한이 걸려 있다(§2.4) |
| 2 | 모션 토큰을 신설할 것인가 | **결정됨** ADR-0179. UX-R0(#1958)이 사다리·눌림·강제 기제를 랜딩. 표면 이관은 UX-R1a~e |
| 3 | 렌더 스윕(컨트롤 경계·터치 크기 전수)을 넣을 것인가 | 기법은 이미 레포에 있다(`gate-shell-layout.mjs`가 계산 스타일 파싱 + 휘도 계산) |
| 4 | `@axe-core/playwright`로 렌더 텍스트 대비(1.4.3)를 잴 것인가 | MPL-2.0 — permissive-only 정책에 명시 필요. **1.4.11은 커버 안 되므로 우리 시험 유지 필수** |
| 5 | 한국어 텍스트 검사를 만들 것인가 | 선례 없음. **우리가 선례가 될 자리** |
| 6 | 폰 taste 스킬 방언 · design-review 계약 재조준 | ADR-0159 D4 — Swift 삭제 배치에 흡수 |
| 7 | `light-dark()`의 실제 브라우저 하한선 | Tauri macOS는 WKWebView(OS 버전에 묶임). **미확인** |
| 8 | 액센트 후보 세트 확정 | ADR-0174 D2. BZ-5a가 시안을 산출하고, 성재 확인 후 머지 |
