# 오르트 구름 (Oort Cloud) Design System

<!-- design-md:section experience -->
## 1. 경험

<!-- design-md:claim scope kind=product-surface lang=ko -->
### Scope

사람과 AI 에이전트가 같은 대화 해부 안에서 협업하고, 작업·승인·결과를 차분하고 조밀하며 증거 중심으로 읽고 조작한다.
<!-- design-md:claim-end -->

<!-- design-md:claim primary-tasks kind=user-outcomes count=3 lang=ko -->
### Primary tasks

- 채널에서 사람과 에이전트의 대화를 읽고 작성한다.

- 에이전트 작업과 승인을 관전하고 안전하게 결정한다.

- 연결이 끊겨도 기록을 잃지 않고 복구 지점을 확인한다.
<!-- design-md:claim-end -->

### Design direction

- 여명(Dawn)의 따뜻한 종이와 밤하늘

- Slack 수준의 정보 밀도

- Codex처럼 차분한 에이전트 표면

- 장식보다 상태와 증거

### Principles

- 사람과 에이전트 메시지는 같은 해부와 타이포그래피를 쓴다.

- 파괴 > 주 > 보조의 위계를 값이 아니라 관계로 지킨다.

- 빈·로딩·오류·오프라인 상태를 빠뜨리지 않는다.

- Postgres에 남은 기록과 재연결 복구를 화면 장식보다 우선한다.

### Avoid

- 네온 보라와 인디고 AI 그라디언트

- 토스트와 스낵바 스택

- 모든 행을 감싸는 과대 카드

- 가운데 정렬 일러스트 빈 상태

- 의미 없는 펄스와 장식 상태 점

- 제품 표면의 원시 JSON과 내부 식별자 노출

<!-- design-md:section foundations -->
## 2. 기반

<!-- design-md:claim foundations kind=rules-or-constraints lang=ko -->
### Semantic tokens

- **color.accent-soft.dark**: `#33261a` — CSS --accent-soft 다크 선택 상태. D-OORT-1
- **color.accent-soft.light**: `#f4e7d6` — CSS --accent-soft 라이트 선택 상태. D-OORT-1
- **color.accent.dark**: `#f0a850` — CSS --accent 다크, 호박 지평선. D-OORT-1
- **color.accent.light**: `#a54c08` — CSS --accent 라이트, 호박 지평선. D-OORT-1
- **color.agent-soft.dark**: `#1e2836` — CSS --agent-soft 다크. D-OORT-1
- **color.agent-soft.light**: `#e6ebf2` — CSS --agent-soft 라이트. D-OORT-1
- **color.agent.dark**: `#7fa0c4` — CSS --agent 다크, 에이전트 정체성에만 사용. D-OORT-1
- **color.agent.light**: `#4a6785` — CSS --agent 라이트, 에이전트 정체성에만 사용. D-OORT-1
- **color.danger-fill.dark**: `#dc817e` — CSS --danger-fill 다크 파괴 액션 채움. D-OORT-1
- **color.danger-fill.light**: `#8c393d` — CSS --danger-fill 라이트 파괴 액션 채움. D-OORT-1
- **color.danger-soft.dark**: `#402a26` — CSS --danger-soft 다크, 측정 결과 칩 그릇. D-OORT-1
- **color.danger-soft.light**: `#ffe9e5` — CSS --danger-soft 라이트, 측정 결과 칩 그릇. D-OORT-1
- **color.danger.dark**: `#ff796b` — CSS --danger 다크 전경 위험 톤. D-OORT-1
- **color.danger.light**: `#b3261e` — CSS --danger 라이트 전경 위험 톤. D-OORT-1
- **color.ink-muted.dark**: `#9b98a3` — CSS --ink-muted 다크. D-OORT-1
- **color.ink-muted.light**: `#6a655f` — CSS --ink-muted 라이트. D-OORT-1
- **color.ink.dark**: `#ececf1` — CSS --ink 다크. D-OORT-1
- **color.ink.light**: `#24211c` — CSS --ink 라이트. D-OORT-1
- **color.line-strong.dark**: `#6f6e73` — CSS --line-strong 다크, 3:1 컨트롤 경계. D-OORT-1
- **color.line-strong.light**: `#84817d` — CSS --line-strong 라이트, 3:1 컨트롤 경계. D-OORT-1
- **color.line.dark**: `#34323b` — CSS --line 다크, 컨테이너 분리선. D-OORT-1
- **color.line.light**: `#dcd8d0` — CSS --line 라이트, 컨테이너 분리선. D-OORT-1
- **color.muted-soft.dark**: `#302e36` — CSS --muted-soft 다크, 상태와 분리된 중립 칩 그릇. D-OORT-1
- **color.muted-soft.light**: `#f3efe8` — CSS --muted-soft 라이트, 상태와 분리된 중립 칩 그릇. D-OORT-1
- **color.ok-soft.dark**: `#243323` — CSS --ok-soft 다크, 측정 결과 칩 그릇. D-OORT-1
- **color.ok-soft.light**: `#e0f4e2` — CSS --ok-soft 라이트, 측정 결과 칩 그릇. D-OORT-1
- **color.ok.dark**: `#57ab5a` — CSS --ok 다크. D-OORT-1
- **color.ok.light**: `#187533` — CSS --ok 라이트. D-OORT-1
- **color.on-accent.dark**: `#17161a` — CSS --on-accent 다크. D-OORT-1
- **color.on-accent.light**: `#fffefb` — CSS --on-accent 라이트. D-OORT-1
- **color.on-danger-fill.dark**: `#17161a` — CSS --on-danger-fill 다크. D-OORT-1
- **color.on-danger-fill.light**: `#fffefb` — CSS --on-danger-fill 라이트. D-OORT-1
- **color.scrim.dark**: `rgb(9 8 11 / 0.62)` — CSS --scrim 다크, 뒤 표면을 어둡게 하는 방향 토큰. D-OORT-1
- **color.scrim.light**: `rgb(36 33 28 / 0.24)` — CSS --scrim 라이트, 뒤 표면을 어둡게 하는 방향 토큰. D-OORT-1
- **color.surface-hover.dark**: `#26252c` — CSS --surface-hover 다크 상호작용 상태. D-OORT-1
- **color.surface-hover.light**: `#e7e3db` — CSS --surface-hover 라이트 상호작용 상태. D-OORT-1
- **color.surface-raised.dark**: `#201f24` — CSS --surface-raised 다크. D-OORT-1
- **color.surface-raised.light**: `#fffefb` — CSS --surface-raised 라이트 종이. D-OORT-1
- **color.surface-sidebar.dark**: `#1b1a1f` — CSS --surface-sidebar 다크. D-OORT-1
- **color.surface-sidebar.light**: `#efece6` — CSS --surface-sidebar 라이트. D-OORT-1
- **color.surface.dark**: `#17161a` — CSS --surface 다크. D-OORT-1
- **color.surface.light**: `#f7f6f3` — CSS --surface 라이트. D-OORT-1
- **color.warn-soft.dark**: `#372e1b` — CSS --warn-soft 다크, 측정 결과 칩 그릇. D-OORT-1
- **color.warn-soft.light**: `#ffedd4` — CSS --warn-soft 라이트, 측정 결과 칩 그릇. D-OORT-1
- **color.warn.dark**: `#d4a72c` — CSS --warn 다크. D-OORT-1
- **color.warn.light**: `#8a5c00` — CSS --warn 라이트. D-OORT-1
- **radius.lg**: `14px` — dialog·sheet 반경. D-OORT-3
- **radius.md**: `10px` — 웹 카드·목록 반경, 폰은 8px 분기. D-OORT-3
- **radius.sm**: `6px` — 버튼·칩·입력 반경. D-OORT-3
- **space.0**: `0px` — 닫힌 웹 리듬 단계. D-OORT-2
- **space.2xl**: `32px` — 닫힌 웹 리듬 단계. D-OORT-2
- **space.hairline**: `1px` — 헤어라인. D-OORT-2
- **space.lg**: `16px` — 닫힌 웹 리듬 단계, 폰 space.lg와 같은 값. D-OORT-2
- **space.md**: `12px` — 닫힌 웹 리듬 단계, 폰 space.md와 같은 값. D-OORT-2
- **space.sm**: `8px` — 닫힌 웹 리듬 단계, 폰 space.sm과 같은 값. D-OORT-2
- **space.xl**: `24px` — 닫힌 웹 리듬 단계, 폰 space.xl과 같은 값. D-OORT-2
- **space.xs**: `4px` — 닫힌 웹 리듬 단계, 폰 space.xs와 같은 값. D-OORT-2
- **target.inline**: `24px` — 본문에 섞인 링크의 AA 최소 target. D-OORT-2
- **target.tap**: `44px` — 자기 줄을 갖는 터치 컨트롤 target. D-OORT-2

### Contrast pairs

- color.ink.light on color.surface.light: minimum 4.5:1
- color.ink.dark on color.surface.dark: minimum 4.5:1
- color.ink.light on color.surface-raised.light: minimum 4.5:1
- color.ink.dark on color.surface-raised.dark: minimum 4.5:1
- color.ink-muted.light on color.surface.light: minimum 4.5:1
- color.ink-muted.dark on color.surface.dark: minimum 4.5:1
- color.line-strong.light on color.surface.light: minimum 3:1
- color.line-strong.dark on color.surface.dark: minimum 3:1
- color.on-accent.light on color.accent.light: minimum 4.5:1
- color.on-accent.dark on color.accent.dark: minimum 4.5:1
- color.on-danger-fill.light on color.danger-fill.light: minimum 4.5:1
- color.on-danger-fill.dark on color.danger-fill.dark: minimum 4.5:1
- color.agent.light on color.surface.light: minimum 4.5:1
- color.agent.dark on color.surface.dark: minimum 4.5:1
- color.ok.light on color.surface.light: minimum 4.5:1
- color.ok.dark on color.surface.dark: minimum 4.5:1
- color.warn.light on color.surface.light: minimum 4.5:1
- color.warn.dark on color.surface.dark: minimum 4.5:1
- color.danger.light on color.surface.light: minimum 4.5:1
- color.danger.dark on color.surface.dark: minimum 4.5:1

### Reduced motion

Required.

### Foundation rules

- 색·간격·반경·텍스트 역할은 clients/web/src/design/tokens.css만 정본으로 삼고 feature 파일에 원시 값을 쓰지 않는다.

- 폰 tokens.ts는 웹 토큰을 번역하며, 컴포넌트 뷰는 공유하지 않는다.

- 순흑·순백과 네온 보라를 쓰지 않고, agent 색은 avatar와 badge의 정체성에만 쓴다.

- --line은 컨테이너를 나누고 --line-strong은 3:1 컨트롤 경계를 그린다.

- 상호작용 상태 토큰 surface-hover·accent-soft를 정적인 칩 그릇으로 쓰지 않는다.

- 위험 전경 채도는 danger > warn > ink-muted, 채움은 accent > danger-fill 순서를 지킨다.

- 숫자 리듬은 0·1·4·8·12·16·24·32px로 닫고, 밖의 측정은 근거를 가진 이름 축으로만 추가한다.

- 비자명한 모션은 reduced motion에서 제거하며 상태 변화 피드백은 짧고 기능적이어야 한다.
<!-- design-md:claim-end -->

<!-- design-md:section typography-assets -->
## 3. 타이포그래피와 에셋

### Type roles

| Role | Usage | Family | Size | Weight | Line height |
|---|---|---|---|---|---|
| timestamp | seq·시각·카운터 | system sans | 11px | 400 | 16px |
| meta | 보조 정보와 메타 행 | system sans | 12px | 400 | 18px |
| body | 메시지 본문과 컨트롤 | system sans | 14px | 400 | 22px |
| title | 표면 제목 | system sans | 16px | 600 | 24px |
| display | 표면당 최대 하나의 표시 제목 | system sans | 20px | 700 | 28px |
| mono | 코드·terminal·고정폭 데이터 | system monospace |  |  |  |

### Rules

- 외부 webfont와 CDN을 쓰지 않고 시스템 글꼴 stack으로 offline과 CSP를 지킨다.

- 크기를 직접 고르지 않고 timestamp·meta·body·title·display 역할을 고른다.

- 기능 아이콘은 한 스타일의 lucide를 쓰고 emoji를 기능 아이콘으로 쓰지 않는다.

- 검증되지 않은 logo·illustration·font를 프로젝트 자산처럼 대체 생성하지 않는다.

<!-- design-md:section components-states -->
## 4. 컴포넌트와 상태

### Component: button

**Semantics:** 동사를 먼저 말하고, 주·보조·파괴 위계를 채움과 경계의 관계로 드러내는 실제 button 요소.

- Anatomy: label, optional icon, optional progress
- Variants: primary, secondary, outline, ghost, destructive
- States: default, hover, focus-visible, disabled, loading
- Token references: color.accent.light, color.line-strong.light, color.danger-fill.light, radius.sm

- Interaction kind: interactive

#### State applicability

| State | Applicability | Reason |
|---|---|---|
| default | applicable |  |
| hover | applicable |  |
| focus-visible | applicable |  |
| disabled | applicable |  |
| loading | applicable |  |
| error | not-applicable | 오류는 버튼 토스트가 아니라 맥락 안 인라인 상태로 말한다. |
| success | not-applicable | 성공은 장식 상태가 아니라 갱신된 결과 표면으로 확인한다. |

### Component: programmatic-dialog

**Semantics:** open prop와 trigger button onClick, DialogContent opener를 함께 써서 Esc가 같은 트리거로 포커스를 돌려준다. DialogTrigger와 custom opener를 병용하지 않는다.

- Anatomy: opener button, title, description, content, trailing actions
- Variants: dialog, alert dialog
- States: closed, open, loading, error
- Token references: color.scrim.light, color.surface-raised.light, radius.lg

- Interaction kind: interactive

#### State applicability

| State | Applicability | Reason |
|---|---|---|
| default | applicable |  |
| hover | not-applicable | dialog container 자체는 hover 컨트롤이 아니다. |
| focus-visible | applicable |  |
| disabled | not-applicable | 비활성화는 dialog가 아니라 opener나 내부 control의 상태다. |
| loading | applicable |  |
| error | applicable |  |
| success | not-applicable | 성공 뒤에는 결과를 갱신하고 dialog를 닫아 opener로 복귀한다. |

### Component: message-row

**Semantics:** 사람과 에이전트가 같은 해부를 공유하고 에이전트 정체성은 avatar·badge의 agent 톤으로만 드러난다.

- Anatomy: avatar, author, timestamp, body, structured attachments, context actions
- Variants: human, agent
- States: default, hover, focus-visible, selected
- Token references: color.surface-hover.light, color.agent.light, target.inline

- Interaction kind: interactive

#### State applicability

| State | Applicability | Reason |
|---|---|---|
| default | applicable |  |
| hover | applicable |  |
| focus-visible | applicable |  |
| disabled | not-applicable | 기록 행 자체를 disabled 처리하지 않고 불가능한 개별 action만 잠근다. |
| loading | not-applicable | 행이 없을 때의 로딩은 timeline surface skeleton이 맡는다. |
| error | not-applicable | 전송·편집 오류는 해당 행 맥락 안에서 별도 상태로 말한다. |
| success | not-applicable | 기록이 보이는 것 자체가 성공 결과이며 장식하지 않는다. |

### Component: status-chip

**Semantics:** 비대화형 상태 표식. 원장 칩은 중립 그릇, 실제 측정 칩만 톤 그릇을 얻고 테두리로 컨트롤처럼 보이게 하지 않는다.

- Anatomy: status text, persistent vessel
- Variants: ledger, measurement, skipped
- States: default
- Token references: color.muted-soft.light, color.ok-soft.light, color.warn-soft.light, color.danger-soft.light

- Interaction kind: non-interactive
- Interaction reason: 상태를 읽는 표식이며 누르는 컨트롤이 아니다.

### Component: product-surface

**Semantics:** 모든 제품 표면은 빈·로딩·오류·오프라인을 가지며 오류와 오프라인은 토스트가 아니라 맥락 안에서 다음 행동을 말한다.

- Anatomy: title or context, durable content, inline state, single next action
- Variants: timeline, directory, settings, dialog, drawer
- States: empty, loading, error, offline

- Interaction kind: non-interactive
- Interaction reason: 표면은 내부 컨트롤의 상태를 조직하는 컨테이너다.

### Rules

- 모든 제품 표면은 빈·로딩·오류·오프라인 네 상태를 갖는다.

- 빈 상태는 한 줄 설명과 행동 하나, 로딩은 높이를 보존하는 중립 skeleton, 오류는 원인과 다음 행동, 오프라인은 캐시를 보존하는 배너다.

- 오류·성공·오프라인을 toast나 snackbar stack으로 말하지 않는다.

- 모든 interactive action은 keyboard 경로와 즉시 보이는 focus-visible ring을 갖는다.

- overlay는 design/ui/escapeLayer.ts의 Esc 층에 합류하고 닫힘 뒤 opener로 포커스를 돌린다.

- programmatic dialog는 DialogTrigger 없이 open prop·button onClick·DialogContent opener 조합만 쓴다.

- 파괴와 승인은 AlertDialog 확인을 거치고 단일 hover나 무방비 click으로 실행하지 않는다.

<!-- design-md:section layout-platforms -->
## 5. 레이아웃과 플랫폼

### Responsive constraints

- Minimum supported width: 320px
- Reflow target: 200% zoom

### Layout rules

- 디자인 표면은 웹과 폰 둘이며 데스크톱은 clients/web/dist를 그대로 쓰는 Tauri shell이다.

- 웹과 폰은 토큰·도메인 로직·문장을 공유하지만 view component를 공유하지 않는다.

- 넓은 화면부터 320px와 200% zoom까지 읽기·작업 순서를 보존하고 가로 overflow를 만들지 않는다.

- 자기 줄을 갖는 터치 컨트롤은 44px, 본문 안 링크는 최소 24px target을 가진다.

- cached content는 offline에도 남고 reconnect 뒤 seq 복구 지점을 인라인으로 알린다.

### Platform: web

- tokens.css의 Tailwind 어휘와 CSP 제약을 따르고 design_preflight_web.sh를 하드 게이트로 실행한다.

### Platform: desktop

- Tauri는 web dist를 감싸며 런타임별 디자인 토큰이나 레이아웃 분기를 만들지 않는다.

### Platform: ios

- bare React Native tokens.ts가 웹 토큰을 번역하고 폰 전용 component를 구현한다.

<!-- design-md:section content-locales -->
## 6. 콘텐츠와 로케일

### Voice

- 간결함

- 구체적임

- 비난하지 않음

- 증거 중심

- 동사 먼저

### Terminology

| Term | Preferred form |
|---|---|
| agent | 에이전트 |
| agent ownership | {owner} 님이 관리 |
| cancelled stream | 중단됨 |
| cut off stream | 응답이 끊김 |
| recovery marker | seq N까지 복구 |

### Locale: ko (supported)

- 한국어 조사와 긴 한영 혼합 문자열을 실제 폭에서 확인한다.
- 오류는 무엇이 일어났고 다음에 무엇을 할지 말한다.
- 버튼은 가능한 경우 동사를 먼저 쓴다.

### Locale: en (partial)

- 제품·프로토콜의 고유 영어 어휘는 한국어 문장 안에서 자연스럽게 혼용한다.
- 라틴 낱말 뒤 한국어 조사 앞에 불필요한 공백을 두지 않는다.

<!-- design-md:section governance -->
## 7. 거버넌스

<!-- design-md:claim authority kind=portable-brief lang=ko -->
### Authority

이 문서는 명시된 범위의 이식 가능한 디자인 브리프다.
<!-- design-md:claim-end -->

<!-- design-md:claim application-priority order=prompt-fact,repository-fact,system-contract,reference-inspiration lang=ko -->
### Application priority

1. 요청 범위의 명시적 사용자 지침.
2. 저장소 사실.
3. 이 시스템 계약.
4. 레퍼런스 영감.
<!-- design-md:claim-end -->

<!-- design-md:claim unknowns policy=absent-at-smallest-unresolved-boundary lang=ko -->
### Unknowns

가장 작은 미확정 값이나 그룹만 생략한다. 그럴듯한 기본값으로 대체하지 않는다.
<!-- design-md:claim-end -->

<!-- design-md:claim changes policy=review-record-validate-before-adoption lang=ko -->
### Changes

채택 전에 변경을 기록하고 검토하고 검증한다.
<!-- design-md:claim-end -->

### Project priority details

1. 직접 범위 지시

2. Accepted ADR와 리포지터리 사실

3. clients/web/src/design/tokens.css와 docs/design-system/README.md 정본

4. 이 DESIGN.md Core v2 mirror

5. OmD 범용 참고와 외부 영감

### Additional change rules

- 정본 변경은 Accepted ADR와 성재 승인을 따르고 tokens.css·README·테스트를 먼저 갱신한다.

- DESIGN.md와 .omd/system은 비권위 mirror로 함께 다시 사상하고 손실 0을 검증한다.

- migration-candidate graph를 portable-core authority로 adopt하지 않는다.

- taste·design-review·design_preflight_web의 프로젝트 전용 판정을 OmD 범용 workflow로 대체하지 않는다.

- 새 토큰은 정본 README §6 절차로 이름·근거·전수 가드를 얻은 뒤에만 mirror에 들어온다.

### Decision provenance

- /experience/design_direction — repository-fact; evidence: D-OORT-0 · docs/design-system/README.md §이 문서가 존재하는 이유, docs/ux-bible/README.md P1~P15
- /foundations/tokens/color.surface.light — repository-fact; evidence: D-OORT-1 · clients/web/src/design/tokens.css :root, docs/design-system/README.md §2.2
- /foundations/tokens/space.xs — repository-fact; evidence: D-OORT-2 · clients/web/src/design/tokens.css @theme spacing, docs/design-system/README.md §2.3
- /foundations/tokens/radius.sm — repository-fact; evidence: D-OORT-3 · clients/web/src/design/tokens.css @theme radius, docs/design-system/README.md §2.4
- /typography_assets/roles — repository-fact; evidence: D-OORT-4 · clients/web/src/design/tokens.css @theme text roles, docs/design-system/README.md §2.5
- /components_states/rules — repository-fact; evidence: D-OORT-5 · docs/design-system/README.md §4, .claude/skills/momo-design-taste-web/SKILL.md §5~§6
- /layout_platforms/platforms — repository-fact; evidence: D-OORT-6 · docs/design-system/README.md §1·§2.1, .claude/skills/momo-design-taste/SKILL.md §0·§2
- /content_locales/locales — repository-fact; evidence: D-OORT-7 · docs/design-system/README.md §5.2·§5.3, .claude/skills/momo-design-taste-web/SKILL.md §7
- /governance/change_policy — repository-fact; evidence: D-OORT-8 · docs/design-system/README.md §6, docs/design-system/OMD.md
