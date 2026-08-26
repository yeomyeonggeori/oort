### Design Review R2 (표적 재검증) — clients/web 컴포저 (feat/1749-uxcb-composer, PR #1751)

- 대상: 수리 커밋 `c926b8c4` (기준 `0309db90`, R1 판정 시점)
- 범위: 팀리드가 지정한 ①~⑦만. R1에서 이미 통과한 축은 ⑥ 스팟체크로만 다시 만졌다.
- 정본: `docs/design-system/README.md` · 방언 `.claude/skills/momo-design-taste-web/SKILL.md` · 루브릭 `.claude/skills/momo-design-taste/references/review-rubric.md`

Screenshots / 로그 (전부 이 세션이 `c926b8c4`에서 새로 만든 것, `claudedocs/design-review-1751/`):
`r2-chat-{light,dark}.png` · `r2-composer-focus-{light,dark}.png` · `r2-composer-mention-light.png` ·
`r2-composer-offline-light.png` · `r2-composer-attachment-pending-light.png` ·
`r2-u4-{composer-emoji,thread-composer-parity}-light.png` · `r2-mobile-{chat,b11-thread,dm}-light.png` ·
`r2-crop-*.png`(확대) · `r1-crop-thread-empty-light.png`(대조군) ·
`r2-capture-design.log` · `r2-preflight-web.txt` · `r2-gate-composer.log` · **`r2-gate-typing-FAIL.log`** ·
`r2-mention-trigger-probe.{mjs,txt}` · `r2-ua-focus-ring-probe.{mjs,txt}`

---

## 0. 레인

| 레인 | 결과 |
|---|---|
| `scripts/design_preflight_web.sh` | PASS — web 12/12 + core 5/5 |
| `npm run build` / `npx tsc -b` | PASS / PASS |
| `npm test` (vitest) | PASS — 106 files / **1523** tests |
| `npm run capture:design` | PASS, 두 스킴 완주 (신설 단정 전부 초록) |
| `node gates/gate-composer.mjs` | PASS |
| **`node gates/gate-typing.mjs`** | **FAIL (2회 연속, 결정적)** — 아래 B-2 |
| 폰 기계 프리플라이트 | **존재하지 않는다**(정본 §5.4). 이 PR은 폰 소스를 건드리지 않는다. |

캡처 레인이 스스로 찍어 낸 실측:

```
composer frame rest light: top 12px / bottom 12px (--spacing-3) · border 1px rgb(132,129,125) (--line-strong) · fill rgb(255,254,251)
composer tabs light/dark : composer-input → composer-mention-trigger → composer-attach → composer-emoji-trigger → composer-send (총 5)
composer vessel light/dark: 액션 행 빈 폭 → 입력 캐럿 2      (채널)
composer vessel thread    : 액션 행 빈 폭 → 입력 캐럿 2      (스레드, 두 스킴)
mention trigger light/dark: 배포 @ 확인 · 후보 5 · 입력 기준 left -1px / gap 21px · ring=frame
emoji anchor channel      : trigger (329,747) · picker (329,743) · xΔ 0px / gap 4px
emoji anchor thread       : trigger (1050,747) · picker (888,743) · xΔ -162px / gap 4px (충돌 회피 포함 단정)
```

---

## ① B-1 (`[@]` 죽은 삽입) — **닫힘 ✅**

출하 코드를 그대로 실행했다(`r2-mention-trigger-probe.{mjs,txt}` — `MentionAutocomplete.tsx`와
`composerInsertion.ts`를 esbuild로 묶어 `insertMentionTriggerAtComposerSelection` → `mentionQueryAt`
→ `matchMembers`를 실제 호출). R1이 실패로 실측한 다섯 문맥 전부 열린다:

```
열림 | 후보 5 | R1 실패① 문장 끝     | "배포 로그 확인해주세요"[12] -> "배포 로그 확인해주세요 @" caret=14
열림 | 후보 5 | R1 실패② 한글 단어 뒤 | "안녕하세요"[5]          -> "안녕하세요 @"            caret=7
열림 | 후보 5 | R1 실패③ 영문 단어 뒤 | "deploy"[6]             -> "deploy @"               caret=8
열림 | 후보 5 | R1 실패④ [@] 연타    | "@"[1]                  -> "@ @"                    caret=3
열림 | 후보 5 | R1 실패⑤ 문장부호 뒤 | "확인,"[3]               -> "확인, @"                caret=5
열림 | 후보 5 | 빈 컴포저·공백 뒤·초안 복원 캐럿(글 끝)                        (회귀 없음)
RESULT: 10/10 문맥에서 멘션 목록이 열린다
```

`mentionQueryAt`은 한 글자도 안 바뀌었다 — 버튼이 「줄 시작 또는 공백 뒤」 계약을 **만족시키는**
쪽으로 고쳐졌고, 그것이 R1이 요청한 방향이다. 캡처 픽스처도 `setSelectionRange(2,2)`(비공백 경계)로
옮겨 `"배포 @ 확인"`을 단정한다(`capture-screens.mjs:2200-2201`) — 레인이 더 이상 통과하는 자리만
고르지 않는다.

## ② H-1 (포커스 시 두 상자) — **닫히지 않았다 ❌ → [High] H-1R**

수리의 절반은 맞다: 그릇이 `focus-within:focus-ring`으로 **한 개의 호박색 링**을 얻었고
(`Composer.tsx:828`, `ThreadComposer.tsx:204`), textarea에서 `focus-visible:focus-ring`이 걷혔다.

**그런데 걷어 내기만 하고 브라우저 기본 링을 막지 않았다.** textarea는 이제 Chromium UA 스타일시트의
포커스 링을 그대로 입는다. 렌더된 픽셀에서 실측(`r2-crop-focus-light.png` · `r2-crop-offline-light.png`):

| | 색 | 두께 | 자리 |
|---|---|---|---|
| 라이트 | **rgb(0, 95, 204)** | 2 CSS px | textarea 아랫변 = 그릇 한가운데를 가로지르는 파란 규칙 |
| 라이트 | **rgb(255, 255, 255)** | 1 CSS px | 호박 링 바깥에 붙은 순백 헤일로(위·좌·우) |
| 다크 | **rgb(153, 200, 255)** | 2 CSS px | 동 |

같은 Chromium 빌드에서 독립 재현했다(`r2-ua-focus-ring-probe.txt`):

```
keyboard/programmatic focus: {"focusVisible":true,"outlineStyle":"auto","outlineWidth":"1px","outlineColor":"rgb(0, 95, 204)"}
mouse click focus:           {"focusVisible":true,"outlineStyle":"auto","outlineWidth":"1px","outlineColor":"rgb(0, 95, 204)"}
```

즉 **마우스로 컴포저를 클릭한 순간부터 계속** 이 상태이고, 캡처한 네 상태(rest-focus · 멘션 ·
오프라인 · 첨부 pending) × 두 스킴 **전부**에서 픽셀로 확인된다.

- 무엇이 깨지나: R1 H-1이 지목한 「포커스가 들어오면 그릇이 두 상자로 갈라진다」가 **색만 바뀐 채 그대로**다.
  호박색이 팔레트 안 색이었던 것과 달리 지금 그 자리를 그리는 것은 팔레트에 없는 브라우저 파랑이다.
- 규칙: 정본 §2.2 「순흑·순백 없음」 — 종이의 흰색은 `#fffefb`인데 링 헤일로가 `#ffffff`다.
  방언 §2 「색은 토큰 유틸리티로만 컴포넌트에 닿는다」·「한 표면에 액센트 하나」.
- **기계가 왜 못 잡았나(§5.3·§5.5②)**: ⓐ 프리플라이트 `naked_focus`는 `outline-none`이 링 없이
  적혔는지만 본다 — 여기엔 `outline-none`이 **아예 없으므로** 조용하다. ⓑ `raw_color`/`pure_bw`는
  소스 텍스트를 그렙하는데 이 색은 UA 스타일시트에서 온다. ⓒ 그리고 이번에 신설된 두 단정이
  **하필 이 모양에 눈이 멀어 있다** — 아래 M-4.
- 방향: 그릇이 표시를 지기로 한 이상 안쪽 입력은 자기 링을 **가져서도 안 되고 UA 링을 물려받아서도
  안 된다**. 판정 기준은 R1과 같다: 포커스 프레임에서 상자가 하나로 보이면 닫힌다.

## ③ H-2 (그릇 절반이 죽은 면적) — **닫힘 ✅**

`Composer.tsx:831-840` · `ThreadComposer.tsx:210-219`가 버튼(과 그 자식)만 제외하고 그릇 클릭을
입력 포커스로 돌린다. 캡처 레인이 액션 행의 **빈 가로폭을 실제로 눌러** 잰다
(`assertComposerVesselClick`, `capture-screens.mjs:2181-2196`): 채널·스레드 × light/dark 4판 전부
`액션 행 빈 폭 → 입력 캐럿 2` — 포커스가 돌아오고 **캐럿 위치도 보존**된다(클릭이 캐럿을 끌고 가지 않는다).

## ④ M-1 (선택 영역 삭제) — **닫힘 ✅**

```
열림 | 원문보존 O | M-1 선택 보존(3~6 선택) | "배포 담당자"[3,6] -> "배포 담당자 @" caret=8
열림 | 원문보존 O | M-1 선택 보존(역방향)   | "배포 담당자"[6,3] -> "배포 담당자 @" caret=8
```

선택을 먹지 않고 **선택 끝으로 접어** 멘션을 시작한다. 정방향·역방향 모두 같다. 이 동작을 의도로
못 박았던 두 테스트도 함께 뒤집혔다(`composerInsertion.test.ts:26`, `composerParity.test.ts`).

## ⑤ N-5 (죽은 띠) — **닫힘 ✅ (단, 대가는 아래 B-2·M-5)**

R1과 R2의 같은 픽스처·같은 뷰포트(1280×800) 스크린샷을 픽셀로 대조했다:

| | 그릇 위 테두리 y | 컴포저 루트 구분선 y | 구분선→그릇 |
|---|---|---|---|
| R1 (`0309db90`) | 707.0 CSS | 552.0 CSS | 155.0 CSS px |
| R2 (`c926b8c4`) | **707.0 CSS(불변)** | **578.0 CSS(+26)** | **129.0 CSS px(−26)** |

그릇은 한 픽셀도 안 움직이고 타임라인이 **정확히 26 CSS px**을 되찾았다 — 예약 띠가 옮겨 간 것이
아니라 사라졌다는 뜻이다. 레이아웃 시프트도 죽지 않았다: `gate-typing`이 죽기 전에 찍은
`[shift] 입력창 y 808 -> 808 · 전송 y 847 -> 847` · `[swap] 기본 composer-hint 18px -> 작성 중 18px
-> composer-hint 18px · 액션 슬롯 1개, 별도 예약 행 0`.

## ⑥ 회귀 스팟체크

| 계약 | 판정 | 근거 |
|---|---|---|
| 이모지 popover 앵커 | ✅ 오히려 강화 | 채널 xΔ **0px**·gap 4px, 스레드는 충돌 회피 후에도 트리거가 피커 가로 범위 안·뷰포트 안임을 단정 |
| 탭 순서 5정거장 | ✅ | 입력→@→첨부→이모지→보내기 (두 스킴) |
| 오프라인 disabled 의미 | ✅ | 입력·[@]·이모지 열림 / 첨부·전송 잠김 (`r2-crop-offline-light.png`) |
| 첨부 pending | ✅ | `r2-crop-attach-light.png` |
| Enter/Shift+Enter·IME | ✅ | `onKeyDown` 무변경 · `gate-composer` PASS(13항) |
| 멘션 목록 위치 | ✅ | left −1px · gap 21px(채널)/9px(스레드) |
| 44px 탭 타깃 | ✅ | 390에서 입력 364x44 · [@]/이모지/보내기 44x44 |
| 그릇 테두리 = `--line-strong` | ✅ 강화 | 이제 **살아 있는 토큰 프로브 색과 대조**해 단정 |
| 인셋 12px | ✅ 강화 | `tokens.css`에서 `--spacing-3`을 **읽어** 단정(§5.5① 사본 제거) |
| 아이콘 기둥 정렬(N-2) | ✅ | [@] 글리프 왼끝 = 플레이스홀더 왼끝, Δ **0.0 CSS px** (R1 +4.0) |
| 용어(N-4) | ✅ | listbox `aria-label` 「멤버 언급」→「멘션 선택」 |
| 타이핑 방출(N-1) | ✅ | [@] 클릭의 `typing.onInput()` 제거 — ADR-0149 「키에서만」 복원 |
| **`gate-typing` 초록** | ❌ | **B-2** |
| **스레드 disabled 전송 표현** | ❌ | **B-3** |

---

## 발견 (R2)

### [Blocker] B-2. `gate-typing.mjs`가 이 브랜치에서 빨갛다 — 그리고 죽는 지점 뒤에 한국어 잘림 단정 전부가 있다

- 실측: 2회 연속 exit 1(결정적). `r2-gate-typing-FAIL.log`
  ```
  locator.waitFor: Timeout 5000ms exceeded.
    - waiting for getByTestId('composer-meta-empty') to be visible
      14 × locator resolved to hidden <p aria-hidden="true" data-composer-meta-slot=""
           data-testid="composer-meta-empty" class="flex min-w-0 flex-1 items-baseline overflow-hidden text-meta"></p>
    at exercise (gates/gate-typing.mjs:816)
  ```
- 원인: 빈 슬롯이 zero-width-space를 잃고 **크기 0**이 되면서 Playwright의 `visible` 판정에서 빠졌다
  (`TypingLine.tsx:150-157`). 게이트는 같은 커밋에서 131줄 고쳐졌는데(`state:"visible"`은 그대로) **한 번도 초록으로 돌지 않았다.**
  R1 시점(`0309db90`)에는 이 게이트가 GATE PASS였다 — 즉 `c926b8c4`가 낸 회귀다.
- 왜 Blocker인가: ⓐ 바꾼 표면을 지키는 게이트가 빨간 채로 머지 후보에 올라와 있다. ⓑ 더 나쁜 것은
  **죽는 줄 뒤가 통째로 안 돈다는 것**이다 — `[fit]`(원한 폭 vs 있는 폭) · `[cut]`(화면이 말하는 문장) ·
  `[a11y]`(보조기술이 읽는 온전한 문장) · `[slot]`(작성 중이 아이콘과 보내기 사이에 갇히는가)이 전부
  그 아래에 있고, 그 넷은 **이번 커밋이 옮긴 바로 그 슬롯**을 위해 새로 쓰인 단정이다.
  라우터 §3이 「증명하지 못하는 초록을 받지 않는다」로 적어 둔 실패 양식이 여기서는 「돌지도 않은 단정」이다.
- 방향: 빈 슬롯의 대기 조건이 새 설계와 맞지 않는다(크기 0인 `aria-hidden` 요소에 `visible`을 물었다).
  게이트를 새 모양에 맞추고 **끝까지 초록으로 한 번 돌린 로그**가 이 커밋에 붙어야 한다.

### [Blocker] B-3. 스레드의 비활성 전송 버튼이 이제 **완전한 액센트**로 그려진다 (빈 답글창 = 대부분의 시각)

- 자리: `ThreadComposer.tsx:338` — N-3 수리가 그릇에 `opacity-50`을 걸면서 자식들의 `disabled:opacity-50`을
  `disabled:opacity-100`으로 무력화했는데, 전송 버튼은 `sending` 말고 **`!canSend`(빈 초안·첨부 차단)**
  에서도 `disabled`가 된다(`:130-132`). 그 판에는 그릇이 흐려지지 않으므로 아무것도 상태를 말하지 않는다.
- 실측(채움 색 최빈값, 폰 390 스레드 빈 답글):

  | | 전송 버튼 채움 |
  |---|---|
  | R1 스레드(빈 답글) | rgb(209,164,128) = `--accent` 50% → 비활성으로 읽힌다 |
  | **R2 스레드(빈 답글)** | **rgb(165,76,8) = `--accent` 원색 → 활성으로 읽힌다** |
  | R1·R2 채널(빈 컴포저) | rgb(209,164,128) (변화 없음) |

  사진: `r2-crop-thread-empty-light.png` vs `r1-crop-thread-empty-light.png`
- 왜 Blocker인가: 루브릭 Detail SLA(ADR-0112 D6) — 「보이는 컨트롤이 포인터에 응답하지 않는다」는
  언제나 Blocker다. 이 버튼은 화면에서 1급 액션 그 자체로 보이고(주 채움 원색), 눌러도 아무 일이
  일어나지 않으며, 왜인지 말하는 문장도 없다. 그리고 **바로 옆 채널 컴포저는 같은 상황에서 정확히
  반대로 그린다** — 정본이 세는 「한 클라 안의 내부 불일치」(§5.3 10위)이자, 옳은 답이 형제 컴포넌트에
  이미 있는 최다 패턴이다.
- 방향: 「전송 중이라 흐리다」와 「보낼 것이 없어 비활성이다」는 서로 다른 상태다. 전자를 그릇이 지는
  것은 옳지만, 후자까지 함께 지워서는 안 된다.

### [High] H-1R. (②) 그릇 안에 브라우저 기본 포커스 링이 남아 두 상자가 그대로다

위 ② 참조. 팔레트 밖 색(`rgb(0,95,204)` / `rgb(153,200,255)`)과 순백(`#ffffff`) 헤일로가 제품
1급 표면에 상시로 그려진다.

### [Medium] M-4. 새 링 단정 두 개가 **자기가 대체한 링에 눈이 멀어 있다**

- `capture-screens.mjs:2165`(`index === 0 && focus.activeOutlineWidth === "2px"`)와
  `:2240`(`proof.inputOutlineWidth === "2px"`)은 「textarea에 2px 링이 있으면 실패」를 단정한다.
- 그런데 UA 링의 계산값은 `outline-style: auto` · **`outline-width: "1px"`**이다(`r2-ua-focus-ring-probe.txt`).
  그래서 두 단정은 링이 화면에 뻔히 있는데도 **초록**이고, 로그도 `ring=frame`이라고 적는다.
- 정본 §5.5②가 이름 붙인 그 실패 양식이다: 가드가 규칙이 아니라 **자기가 아는 모양**을 잰다.
  「입력에 링이 없다」를 재려면 폭이 아니라 `outlineStyle === "none"`(또는 계산색이 팔레트 안인지)을 물어야 한다.

### [Medium] M-5. 「작성 중」 문장이 쓸 수 있는 폭이 폰에서 46% 줄었고, 그것을 재는 레인은 B-2 때문에 돌지 않는다

- 실측(390 프로파일, `r2-mobile-chat-light.png` 액션 행 y밴드 한정): 아이콘 오른끝 142 CSS ·
  전송 왼끝 325 CSS → **슬롯 ≈ 183 CSS px**. 스레드도 같은 값이다. 옮기기 전 그 문장이 쓰던 자리는
  컴포저 폭 − `px-6` = **342 CSS px**였다.
- 이 축은 이 파일이 가장 공들여 적어 둔 자리다(`TypingLine.tsx` 머리말: 「1줄 고정을 고르면 긴 이름에서
  잘림은 불가피하고, 그래서 이 파일이 하는 일은 잘림의 대상을 고르는 것」). 폭이 절반이 되면 고르는
  대상이 달라진다. 그것을 잴 단정(`[fit]`·`[cut]`·`[a11y]`)이 정확히 B-2의 사망 지점 뒤에 있다.
- 높이 회귀(N-5 해소)와 폭 회귀는 서로 다른 축이고, 지금 증거는 전자만 있다.

### [Nitpick] N-7. 공유 슬롯의 두 문장이 서로 반대쪽 끝에 정렬된다

힌트는 `text-right`(보내기 쪽, `Composer.tsx:181`), 작성 중은 슬롯 왼쪽(`TypingLine.tsx:125`).
같은 자리를 교대하는 두 문장이 화면 양 끝을 오가므로 전환이 「내용이 바뀌었다」가 아니라 「무언가 움직였다」로
읽힐 수 있다. 힌트 쪽 사진은 있고(`r2-crop-focus-light.png`) 작성 중 쪽 사진은 **없다** — B-2 때문에
그 프레임을 찍는 레인이 죽었다. 코드 판독으로만 적는다.

### [Nitpick] N-8. `gate-typing`의 스왑 높이 단정이 `!== 26`에서 `<= 0`으로 느슨해졌다

새 설계에서 26이 의미를 잃었으므로 교체 자체는 정당하고, 시프트 0은 입력·전송의 y좌표 동일성과
액션 행 높이 동일성이 여전히 잡는다. 다만 「슬롯 높이」축은 이제 사실상 미측정이라는 것만 적어 둔다.

---

Verdict: **FAIL (blockers: 2)**

- 닫힘: **B-1 ✅ · H-2 ✅ · M-1 ✅ · M-2 ✅ · M-3(#1752 인용) ✅ · N-1 ✅ · N-2 ✅ · N-4 ✅ · N-5 ✅**
- 남음: **H-1 ❌(H-1R로 재발행)**
- 신규: **Blocker B-2**(gate-typing 빨강 + 그 뒤 단정 미실행) · **Blocker B-3**(스레드 비활성 전송이 원색)
  · Medium M-4·M-5 · Nitpick N-7·N-8
- 집계: Blocker 2 · High 1 · Medium 2 · Nitpick 2. ADR-0133 웹 목표는 Blocker 0 · High 0.

세 건 모두 **같은 성격**이라는 점만 덧붙인다: 이번 수리는 값을 옮기면서 그 값이 지고 있던 두 번째 일을
함께 옮기지 않았다. textarea의 링을 걷으니 UA 링이 그 자리를 가져갔고(H-1R), 자식의 흐림을 끄니
「보낼 것 없음」의 표시가 함께 꺼졌고(B-3), 예약 행을 없애니 그 행의 가시성에 걸려 있던 게이트가
멎었다(B-2). 되돌아올 때 필요한 것은 셋 다 사진과 로그다 — 포커스 프레임에서 상자가 하나로 보일 것,
빈 답글창의 전송이 비활성으로 읽힐 것, `gate-typing`이 `[fit]`·`[cut]`·`[a11y]`·`[slot]`까지 지나
GATE PASS를 출력한 로그가 붙을 것.
