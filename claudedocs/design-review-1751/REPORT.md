### Design Review — clients/web 컴포저 (feat/1749-uxcb-composer, PR #1751)

- 대상: `git diff origin/track/uxui..HEAD` = `0dd0f4fd`(구현) + `0309db90`(캡처 자 정정)
- 표면: **웹 하나**. `clients/desktop`은 `frontendDist=../../web/dist`이고 `clients/web/src`에 런타임 스타일 분기가 0건이므로 데스크톱은 세 번째 표면이 아니다 (`docs/design-system/README.md` §1 주1).
- 정본: `docs/design-system/README.md` (오르트 구름) · 방언 `.claude/skills/momo-design-taste-web/SKILL.md` · 루브릭 `.claude/skills/momo-design-taste/references/review-rubric.md`
- 패킷: `docs/planning/handoffs/2026-08-25-composer-buzz-restyle-packet.md`

Screenshots (전부 이 리뷰가 이 브랜치에서 새로 찍은 것):
`claudedocs/design-review-1751/` — `chat-{light,dark}.png` · `composer-focus-{light,dark}.png` ·
`composer-mention-{light,dark}.png` · `composer-offline-light.png` ·
`composer-attachment-pending-{light,dark}.png` · `u4-composer-emoji-light.png` ·
`u4-thread-composer-parity-{light,dark}.png` · `mobile-chat-{light,dark}.png` ·
`mobile-chat-bottom-chrome-light.png` · `mobile-b11-thread-light.png` · `crop-*.png`(확대)
로그: `capture-design.log` · `preflight-web.txt` · `mention-trigger-probe.{mjs,txt}`

---

## 0. 증거 — 무엇을 실제로 돌렸나

| 레인 | 결과 |
|---|---|
| `scripts/design_preflight_web.sh` | **PASS** — web 12/12 + core 5/5 (원문 아래) |
| `npm run build` | PASS (2089 modules, exit 0) |
| `npm run capture:design` | **PASS, 두 스킴 완주** — 워커가 `runtime-unverified`로 남긴 자리가 이 세션에서 초록으로 닫혔다 |
| `npm run gate:composer` | PASS (13항) |
| `node gates/gate-typing.mjs` | PASS |
| `node gates/gate-shell-layout.mjs` | PASS |
| `npx tsc -b` | PASS |
| `npm test` (vitest) | PASS — 106 files / 1509 tests |
| `npm run lint` | PASS (0 error / 5 pre-existing warning) |
| **폰 기계 프리플라이트** | **존재하지 않는다.** `clients/mobile`에는 「디자인 프리플라이트」라는 실행 단위가 없다(정본 §5.4). 이 PR은 폰을 건드리지 않으므로 돌릴 것도 없지만, 이 칸을 비워 두면 초록으로 읽히므로 문장으로 적는다. |

```
== design pre-flight (web), SKILL momo-design-taste-web §10 ==
   scanned: clients/web/src, clients/web/index.html
   excluded: src/design/tokens.css, src/design/tokens.contrast.test.ts
   emdash·progress_word·latin_particle: AST (문자열 리터럴·JSX 텍스트만, *.test.ts(x)·*.d.ts 제외) — #1141·#1511

OK    emdash: 0
OK    raw_color: 0
OK    inline_style: 0
OK    arbitrary_tw: 0
OK    ai_gradient: 0
OK    toast: 0
OK    naked_focus: 0
OK    external_font: 0
OK    hype: 0
OK    pure_bw: 0
OK    progress_word: 0
OK    latin_particle: 0

OK    web: 12/12 categories clean.

== design pre-flight (core), 이슈 #1141 ==
   scanned: packages/momo-core/src (문자열 리터럴 노드만, *.test.ts 제외)
   excluded: 주석·독스트링(AST가 보지 않는다), *.test.ts, design-preflight-allow 줄

OK    emdash: 0
OK    progress_word: 0
OK    latin_particle: 0
OK    raw_color: 0
OK    hype: 0

RESULT: PASS, 5/5 categories clean.

RESULT: PASS, web 12/12 + core 5/5 categories clean.
```

캡처 레인이 스스로 찍어 낸 실측 (capture-design.log):

```
composer frame rest light: top 12px / bottom 12px · border 1px rgb(132, 129, 125) · fill rgb(255, 254, 251)
composer frame rest dark : top 12px / bottom 12px · border 1px rgb(111, 110, 115) · fill rgb(32, 31, 36)
composer tabs light/dark : composer-input → composer-mention-trigger → composer-attach → composer-emoji-trigger → composer-send (총 5, 전부 2px focus-visible)
mention trigger light    : 배포 @확인 · 후보 5 · 입력 기준 left -1px / gap 21px
mention trigger thread   : 배포 @확인 · 후보 5 · 입력 기준 left -1px / gap 9px
emoji anchor channel     : trigger (333,747) · picker (333,743) · gap 4px
emoji anchor thread      : trigger (1054,747) · picker (888,743) · gap 4px
tap targets chat(390px)  : composer-input 364x44, composer-mention-trigger 44x44, composer-emoji-trigger 44x44, composer-send 44x44
tap targets thread(390px): thread-composer-input 363x60, thread-composer-mention-trigger 44x44, thread-composer-send 44x44
```

토큰 산술을 리뷰가 직접 검산했다(그릇 테두리가 컨트롤 문법인가, §3.1 규칙 4):
`--line-strong` #84817d on `--surface-raised` #fffefb = **3.84:1**, 다크 #6f6e73 on #201f24 = **3.24:1**.
그릇 안쪽 채움이 바뀌었는데도 컨트롤 경계 3:1은 두 스킴에서 살아 있다. 패킷 §3의 「그릇 테두리는 `--line-strong`」은 지켜졌다.

---

## 1~7. 페이즈

**1. 상호작용** — 포인터·키보드 둘 다 걸었다. 탭 정거장 5개, 각 정거장 2px `focus-visible` 실측(캡처 레인). Enter/Shift+Enter/IME 경로는 `onKeyDown`이 한 글자도 안 바뀌었고 `gate-composer`가 그대로 통과한다. 드래그 텍스트 선택은 드롭존을 건드리지 않는다 — `useComposerDropZone.ts:53 carriesFiles()`가 `types`에 `Files`가 없는 드래그를 전부 무시하므로, textarea 안에서 문장을 끌어 선택해도 `data-dragging` 강조가 켜지지 않는다(기존 방어가 새 구조에서도 유효). **다만 [@]의 실동작에 Blocker 1건(B-1), 그릇의 클릭 면적에 High 1건(H-2)이 있다.**

**2. 뷰포트** — 1280과 390을 찍었다(레인 기본 두 프로파일). 900은 별도 캡처가 없다: 이 diff에서 폭에 반응하는 규칙은 `tap-target`(<600px)과 힌트 행의 `wide-only` 둘뿐이고 그릇 구조를 가르는 분기는 없다. 가로 오버플로 0(레인 단정), 390에서 액션 행 최소 폭 = 44×3 + 4×2 + 44 + 8×2 = 208px < 320px. 긴 한글+영문 혼재 문장은 그릇 안 텍스트가 아니라 플레이스홀더 축이고 `composer-placeholder`(#1418·#1422) 규칙이 그대로다.

**3. 시각 폴리시** — 토큰 준수는 깨끗하다(hex 0 · 임의값 0 · 반경 `rounded-md`/`rounded-sm` 두 단 · 간격 `p-3`/`px-2`/`pb-2`/`gap-1`/`gap-2` 전부 리듬 안). 그릇의 채움 `--surface-raised` + 테두리 `--line-strong`은 `button.tsx`의 `secondary` 변형이 이미 쓰는 집안 짝이라 새 어휘가 아니다. AI-Tell 없음(그라디언트·토스트·시머·일러스트 0). **위계·상태의 시각 결함 2건(H-1·H-2).**

**4. 접근성** — 아이콘 온리 3개 전부 `aria-label`(`멘션 넣기`/`파일 첨부`/`이모지 넣기`), 탭 순서 자연 DOM, 44px는 <600px에서 실측 44x44. `aria-describedby`·`aria-controls`·`aria-activedescendant` 배선 유지. 링 자체는 모든 정거장에 있다(레인이 `outlineWidth==2px && outlineStyle==solid`로 잰다). 링의 **성질**(어디를 감싸는가)은 정본 §5.3이 「아무도 안 재는 축」으로 이름 대어 둔 자리이며, H-1이 정확히 그 축이다 — 그러니 이 건에 대해 "게이트가 잡았어야 했다"는 문장은 **부당하다.**

**5. 견고성** — 오프라인(입력·[@]·이모지 열림 / 첨부·전송 막힘, 경고색 인라인 한 줄), 첨부 pending(칩 + 진행 막대 + 「업로드가 끝나면 보낼 수 있습니다」 + 전송 흐림), 멘션 목록, 이모지 popover를 light/dark로 전부 찍었다. 토스트 0. 초안 저장 경로는 [@]에도 이어져 있다(`insertTrigger` → `onTextChange` → `onValueChange` → `writeDraft`).

**6. 코드 건강** — 프리미티브 재사용(`Button` ghost/icon·`AttachButton` 그대로 이동), 매직 넘버 없음, 새 순수 함수는 코어 규율대로 파일 하나에 분리. **캡처 하네스 신설분의 허용 범위가 과관대한 곳이 3군데(M-2).**

**7. 카피** — 새 문자열은 `멘션 넣기` 하나. 동사 앞·em-dash 0·hype 0(프리플라이트). 인접 버튼 `이모지 넣기`와 문형이 짝이다. 내부 어휘 노출 없음.

---

## 발견

### [Blocker] B-1. [@]는 캐럿 앞 글자가 공백이 아니면 죽은 `@` 한 글자만 남기고 아무것도 열지 않는다

- 자리: `MentionAutocomplete.tsx:106-121`(`insertTrigger`) · `composerInsertion.ts:38-43` · 소비처 `Composer.tsx:931-935`, `ThreadComposer.tsx:290-291`
- 무엇이 깨지나: `insertTrigger`는 **캐럿 자리에 `@` 한 글자만** 넣는다. 그런데 같은 파일 `MentionAutocomplete.tsx:22`의 `mentionQueryAt`은 `at > 0 && !/\s/.test(upto[at - 1])`이면 **null**을 돌려주고, `MentionAutocompleteList`는 `candidates.length === 0`에서 `return null`이다. 즉 앞 글자가 공백이 아닌 모든 캐럿에서 버튼은 텍스트에 `@`를 하나 흘려 놓고 목록을 열지 않는다.
- 실측(이 브랜치의 **출하 코드를 그대로 실행**했다 — `mention-trigger-probe.{mjs,txt}`, `MentionAutocomplete.tsx`를 esbuild로 묶어 `mentionQueryAt`을 직접 호출):

```
열림   | 빈 컴포저에서 클릭            | ""@0        -> "@"                    | query={"start":0,"text":""}
열림   | 공백 뒤에서 클릭(하네스가 고른 자리) | "배포 확인"@3  -> "배포 @확인"          | query={"start":3,"text":""}
안열림 | 문장 끝(단어 바로 뒤)에서 클릭  | "배포 로그 확인해주세요"@11 -> "…확인해주세@요" | query=null
안열림 | 한글 단어 뒤                | "안녕하세요"@5 -> "안녕하세요@"          | query=null
안열림 | 영문 단어 뒤                | "deploy"@6   -> "deploy@"            | query=null
안열림 | [@]를 두 번 연속 클릭        | "@"@1        -> "@@"                 | query=null
안열림 | 문장부호 뒤                 | "확인,"@3     -> "확인,@"              | query=null
```

- 왜 이것이 1급 경로인가: ① 「문장을 쓰다가 누구를 부르려고 [@]를 누른다」가 이 버튼의 존재 이유 그 자체다. ② 초안은 채널 전환·새로고침을 넘어 복원되고(`gate-composer` [draft]), 복원된 textarea의 `selectionStart`는 글 끝 = 대개 공백이 아닌 글자 뒤다 — **채널에 돌아와 [@]를 누르는 첫 시도가 실패한다.** ③ 두 번 누르면 `@@`가 되어 첫 클릭에 열린 목록이 닫힌다. 사람이 얻는 것은 「아무 일도 안 일어남」이 아니라 「지워야 할 글자 하나」다.
- 규칙: 루브릭 Detail SLA(ADR-0112 D6) — 「보이는 컨트롤이 포인터에 응답하지 않는다」는 언제나 Blocker다. 패킷 §2도 「클릭 = 캐럿에 `@` 삽입 + 입력 포커스 → **기존 멘션 자동완성이 자연 발동**」을 계약으로 적었다.
- 그리고 이것은 정본이 코퍼스 최다 패턴으로 이름 붙인 그 모양이다(§이 문서가 존재하는 이유, 25건/11리포트): **옳은 답이 같은 레포 안에 이미 문장으로 적혀 있었다.** `clients/mobile/src/features/conversation/mentionQuery.ts:45-48`이 「A mid-word `@` is not a mention: only the start of the text or whitespace may precede it」라고 규칙을 명시해 둔다. 타이핑에는 옳은 규칙이고, 버튼은 그 규칙을 **무시할 게 아니라 만족시켜야** 한다.
- 방향(픽셀 처방이 아니라 문제 진술): 삽입 문자열이 캐럿 앞 문맥에 따라 달라져야 한다. 앞 글자가 비공백이면 앞에 공백을 하나 데리고 들어가는 것이 Slack·Discord가 같은 버튼에서 하는 일이고, 그때 `mentionQueryAt`은 손대지 않아도 된다. red proof는 **공백 뒤가 아닌 캐럿**에서 목록이 열리는지를 물어야 한다.

### [High] H-1. 포커스가 들어오면 그릇이 다시 두 상자로 갈라진다 — 액센트 2px 가로줄이 그릇 한가운데를 자른다

- 자리: `Composer.tsx:917` · `ThreadComposer.tsx:275` (`focus-visible:focus-ring` on the textarea) vs `Composer.tsx:848` · `ThreadComposer.tsx:203` (그릇)
- 증거: `composer-focus-light.png` / `composer-focus-dark.png`, 확대 `crop-focus-light.png` · `crop-focus-dark.png` · `crop-thread-light.png`
- 무엇이 보이나: 링은 `outline: 2px solid var(--accent)` + `outline-offset: -2px`라 **textarea 자기 상자**에만 그려진다. textarea는 그릇 안쪽 상단을 꽉 채우므로, 화면에는 ①그릇의 위·좌·우 회색 선 바로 안쪽에 겹친 2px 호박 선과 ②액션 행 바로 위를 가로지르는 **뜻 없는 호박색 가로 규칙**이 생긴다. 액션 행은 그 상자 **밖**에 남는다. 이 티켓이 없애려던 「입력 상자 + 그 옆의 버튼들」 읽기가 포커스 상태에서 그대로 복원된다.
- 그리고 이 상태는 예외가 아니라 상시다: 텍스트 입력류는 스펙상 포커스되면 모달리티와 무관하게 `:focus-visible`에 매치된다(하네스 자신이 `capture-screens.mjs:2185-2187`에 그 문장을 적어 두었고, `gate-shell-layout`도 `{"focus":"composer-input","focusVisible":true}`로 같은 것을 잰다). 즉 **사람이 쓰는 내내 이 모양이다.**
- 곁가지 하나: 링은 textarea의 `rounded-sm`(6)을 따르고 그릇의 안쪽 반경은 `rounded-md - 1px`(9)이라 두 모서리가 포개지지 않는다.
- 규칙: 정본 §2.2 「한 표면에 액센트 하나」 + §3(위계는 값이 아니라 관계) — 화면에서 가장 채도 높은 선이 **아무 경계도 아닌 자리**를 그린다. 방언 §6은 링의 존재를 요구하지 「어느 상자를 감싸는가」를 정하지 않는다.
- **이 축은 기계가 안 잡는 자리다.** 정본 §5.3의 「포커스 링의 *성질*」과 「렌더된 화면에서의 위계」 두 행이 그것이고, 프리플라이트 `naked_focus`는 링이 **있는지**만 본다. 게이트 탓을 할 자리가 아니다.
- 방향: 그릇이 컨트롤로 읽히도록 만든 이상 포커스 표시도 그릇의 일이다. 안쪽 textarea가 자기 링을 따로 갖지 않고 그릇이 focus-within으로 표시를 지는 형태가 buzz 레퍼런스·Slack·ChatGPT가 공통으로 쓰는 문법이다. 어느 쪽을 고르든 **화면에 상자가 하나로 보이는 것**이 판정 기준이다.

### [High] H-2. 그릇의 절반은 눌러도 캐럿이 오지 않는다 — 입력처럼 생긴 비활성 면적

- 자리: `Composer.tsx:846-850` · `ThreadComposer.tsx:202-205` (그릇 `div`에 포인터 핸들러가 없다)
- 증거: `chat-light.png`(rest) · `crop-rest-light.png` · `crop-offline-buttons.png`
- 실측: 데스크톱 rest에서 그릇 높이 ≈ 81px(textarea 39 + 액션 행 32 + `pb-2` 8 + 테두리 2) 중 **캐럿을 받는 면적은 39px(48%)**. 390px에서는 44 / 96 = 46%. 액션 행의 아이콘 오른쪽 빈 띠 — 그릇 폭의 8할이 넘는 그 자리 — 를 누르면 아무 일도 일어나지 않는다.
- 왜 회귀인가: 이전 판에서 「입력처럼 보이는 상자」와 「캐럿을 받는 상자」는 같은 요소였다. 지금은 하나의 테두리가 둘을 감싸므로 사람이 읽는 컨트롤의 경계와 실제 히트 영역이 갈라졌고, 큰 빈 자리를 눌렀을 때의 무반응이 곧 「이 상자는 죽었나」로 읽힌다. 레퍼런스(`claudedocs/composer-buzz-ref-20260825/buzz-reference.png`)가 한 그릇을 그린 이유가 정확히 「여기 아무 데나 눌러 쓰기 시작한다」다.
- 규칙: 루브릭 Detail SLA의 「보이는 컨트롤이 포인터에 응답하지 않는다」와 인접한 축이다. Blocker로 올리지 않은 이유는 컨트롤 자체(버튼 4개·textarea)는 전부 살아 있고 사람이 위쪽을 누르면 정상 동작하기 때문이다. 그러나 그릇을 도입한 이 PR이 만든 새 면적이므로 이 PR에서 닫는 것이 맞다.
- 방향: 그릇이 클릭을 받아 입력으로 캐럿을 넘기면 된다(버튼 위 클릭은 그대로 버튼의 것). H-1과 같은 자리의 같은 질문이다 — 「이 상자는 하나인가」.

### [Medium] M-1. [@]가 선택 영역을 먹는다, 그리고 그 동작이 테스트로 못 박혀 있다

- 자리: `composerInsertion.ts:38-43` (선택 범위를 `@`로 치환) · 단정 `composerInsertion.test.ts:26-33`, `composerParity.test.ts:79-91`
- 실측: `insertMentionTriggerAtComposerSelection("배포 담당자", {start:3,end:6})` → `{value:"배포 @", caret:4}`. 「담당자」를 골라 둔 채 [@]를 누르면 그 세 글자가 사라진다. 컨트롤드 textarea라 브라우저의 되돌리기 스택도 그 치환을 모른다.
- 이모지 버튼이 선택을 치환하는 것은 관례지만(무엇을 넣을지가 명확하다), 멘션 시작 문자는 「이 자리에 사람을 부르겠다」이지 「고른 글을 버리겠다」가 아니다. 두 신설 테스트가 이 동작을 **의도로 승격**시켜 두었으므로, 고칠 때 테스트도 함께 뒤집혀야 한다는 뜻에서 지금 적어 둔다.

### [Medium] M-2. 신설 캡처 자 3건이 자기가 이름 붙인 계약보다 좁게 잰다

정본 §5.5②(허용목록과 잔량은 다른 물건이다)와 §5.5①(사본을 두면 사본이 거짓말한다)이 그대로 적용되는 자리다. 셋 다 **초록인데 계약은 안 지켜질 수 있다.**

1. `capture-screens.mjs:2158-2161` — `assertMentionTrigger`는 `"배포 확인"`을 넣고 `setSelectionRange(3,3)`으로 **공백 바로 뒤**에 캐럿을 세운다. 그 자리는 B-1이 유일하게 통과하는 자리다. 하네스가 고른 픽스처가 결함을 정확히 비껴갔고, 그래서 이 레인은 죽은 버튼 위에서 초록이었다.
2. `capture-screens.mjs:2206-2250` — `assertEmojiAnchor`는 `trigger.top - picker.bottom`만 단정한다(0~16px). 앵커의 H-4 교훈은 「**어느 요소**에 붙었나」인데 가로축은 `proof.trigger.left`/`picker.left`를 **로그에만 찍고 단정하지 않는다**. 실측상 채널은 333/333으로 맞고 스레드는 1054/888(패널 폭 충돌 회피)이라 지금 값 자체는 정당하지만, 잰다고 말한 축의 절반이 비어 있다.
3. `capture-screens.mjs:2252-2280` — `assertComposerFrameGeometry`는 `borderTopColor`와 `backgroundColor`를 **수집해서 출력만 하고 단정하지 않는다.** 패킷 §3의 「그릇 테두리는 컨트롤 문법(`--line-strong`)」은 이 레인에서 로그이지 계약이 아니다. 또 `topInset !== 12 || bottomInset !== 12`는 `tokens.css`를 읽지 않고 숫자를 손으로 베껴 적은 자다 — 정본 §5.5①이 `spacing.test.ts` 1차에서 이미 한 번 치른 실패 양식이다.

### [Medium] M-3. 웹↔폰 패리티 분기가 이 PR로 새로 열린다 (후속 이슈 번호 없음)

- 폰 `clients/mobile/src/features/conversation/Composer.tsx:1451-1487`은 여전히 `flexDirection:'row'` 한 행 그릇([첨부][입력][전송])이고 **[@] 진입점이 없다.** 이 PR이 랜딩하면 같은 기능의 두 클라가 구조도 인벤토리도 다르다.
- 패킷 §5가 「폰 TypingBar 동형 재구성 = 별도 티켓」으로 적립해 두었으므로 이 PR에서 구현하지 않은 것은 옳다. 다만 적립 문장만 있고 **발급된 goal 번호가 없다** — 클라 간 패리티 분기는 감사 코퍼스 2위 결함 패턴(18건/8리포트)이고, 그 패턴이 사는 방식이 정확히 「다음에 하기로 했는데 적힌 자리가 PR 본문뿐」이다.

### [Nitpick] N-1. 「작성 중」이 이제 키가 아닌 포인터에서도 나간다

`Composer.tsx:933-934`가 [@] 클릭에서 `typing.onInput()`을 부른다. 초안이 실제로 바뀌므로 방출 자체는 참이지만, 같은 파일 `:868`의 주석이 「작성 중은 **키에서만** 나간다 (ADR-0149)」라고 적고 있어 코드와 주석이 갈라졌다. 스레드 [@](`ThreadComposer.tsx:291`)는 부르지 않아 두 컴포저의 방출 조건도 다르다(스레드에는 원래 송신기가 없으므로 결과적으로는 무해).

### [Nitpick] N-2. 아이콘 행의 왼쪽 정렬이 텍스트 기둥과 2~3px 어긋난다

액션 행이 `px-2`(8px)이고 textarea가 `px-3`(12px)이라, 첫 아이콘의 글리프가 플레이스홀더 첫 글자보다 약 2.5px 오른쪽에 선다(`crop-offline-buttons.png`). 레퍼런스는 두 기둥을 맞춘다. 4px 리듬 안에서 고를 수 있는 값이므로 격자를 깨지 않고 정렬된다.

### [Nitpick] N-3. 스레드의 전송 중 상태가 그릇에는 안 걸린다

이전 판에서는 테두리가 textarea에 있었으므로 `disabled:opacity-50`이 상자째 흐려졌다. 지금은 테두리가 그릇에 있고 그릇에는 disabled 변형이 없어, 전송 중에는 **속만 흐리고 상자는 또렷한** 절반 상태가 된다(`ThreadComposer.tsx:203·275`). 캡처 레인에 스레드 sending 프레임이 없어 사진은 없다 — 코드 판독으로만 적는다.

### [Nitpick] N-4. 부르는 말이 셋이다

새 버튼은 「멘션 넣기」, 목록의 `aria-label`은 「멤버 언급」, 플레이스홀더는 「@로 부르기」. 셋 다 기존 문자열이고 이 PR이 만든 분기는 아니지만, [@]가 그 셋을 한 화면에 처음으로 모아 놓았다.

### [Nitpick] N-5. 죽은 밴드는 사라진 게 아니라 자리를 옮겼다

`bottomInset 12px`는 실측대로 참이다(이전 판은 폼 `p-3` 12 + 상시 예약 메타 행 26 = 38px). 다만 그 26px 예약 행(`TypingLine`의 빈 판)은 없어진 것이 아니라 **그릇 위로 갔다** — ↵를 한 번 배운 사람(`sendHint`)에게는 타임라인과 그릇 사이에 빈 26px 띠가 상시로 남는다. STATUS.md가 「옮겨」라고 정확히 적었으므로 거짓 보고는 아니고, 패킷 §2의 「그릇-창 하단 간격 = 그릇-타임라인 간격」은 12px 대 12+26px로 절반만 달성됐다.

### [Nitpick] N-6. `MOBILE_TAP_TARGETS`가 두 칸 늘었다

`capture-screens.mjs:124·142`. 옳은 조치지만 이 표는 여전히 **허용목록**이고(정본 §5.5②가 이름 대어 둔 그 표), 스레드 항목은 `optional`이라 testId가 사라지면 조용히 통과한다. 이 PR의 잘못이 아니라 기제의 성질이라 기록만 한다.

---

## 계약 점검표 (패킷 §3 — 깨지면 FAIL)

| 계약 | 판정 | 근거 |
|---|---|---|
| 멘션 자동완성 위치(입력 기준) | ✅ | left Δ −1px · 채널 gap 21px / 스레드 9px (`composer-mention-*.png`) |
| 이모지 popover가 **새 버튼 위치**에 앵커 | ✅ | 채널 trigger(333)·picker(333), gap 4px (`u4-composer-emoji-light.png`) |
| 첨부 pending/실패 | ✅ | `composer-attachment-pending-*.png` |
| 오프라인 disabled 의미 | ✅ | 입력·[@]·이모지 열림 / 첨부·전송 잠김 (`composer-offline-light.png`) |
| 타이핑 인디케이터 방출 | ✅(N-1 주의) | `gate-typing` PASS |
| Enter/Shift+Enter·IME | ✅ | `onKeyDown` 무변경 · `gate-composer` PASS |
| 포커스 링·44px 탭 타깃 | ✅ / H-1 | 링 5/5 실측, 44x44 실측 — 다만 링이 감싸는 상자가 문제(H-1) |
| 기존 testId | ✅ | 캡처·게이트 전량 통과 |
| 스레드 컴포저 동형 | ✅ | `u4-thread-composer-parity-*.png` |
| 탭 순서 입력→@→첨부→이모지→보내기 | ✅ | 레인 실측 5정거장 |
| 그릇 테두리 = `--line-strong` | ✅ | 실측 3.84:1 / 3.24:1 (리뷰 검산) |
| **[@] 클릭 → 자동완성 자연 발동** | ❌ | **B-1** |
| 하단 죽은 패딩 제거 | ◐ | 12px 달성, 예약 행은 위로 이동(N-5) |

---

Verdict: **FAIL (blockers: 1)**

- Blocker 1 (B-1) · High 2 (H-1·H-2) · Medium 3 · Nitpick 6.
- ADR-0133 웹 목표는 Blocker 0 · High 0이다. B-1/H-1/H-2 셋은 같은 질문의 세 얼굴이다: **새로 만든 버튼이 실제로 그 일을 하는가, 그리고 새로 만든 상자가 하나로 보이고 하나로 동작하는가.** 구현자에게 되돌린다.
- 되돌아올 때 필요한 것: B-1의 red proof는 **공백 뒤가 아닌 캐럿**을 물어야 하고(`assertMentionTrigger`의 픽스처 캐럿 위치가 바뀌어야 한다), H-1/H-2는 사진으로 판정된다 — 포커스 프레임에서 상자가 하나로 보이고, 액션 행 빈 자리를 눌렀을 때 캐럿이 오면 닫힌다.
