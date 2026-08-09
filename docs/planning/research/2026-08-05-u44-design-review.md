# Design Review — U4-4 배치 (웹 + 폰), `origin/track/engine` @ `e69ee79e`

> Reading this as: message timeline + composer typing line + inline approval card,
> for an internal Korean/English team on web(Tailwind) and iOS(RN),
> system-first, density 6–7, motion 2.

리뷰 대상 = 4 PR의 **병합 결과**(#1086 · #1088 · #1087 · #1090), base `e9b6dbad`.
`main` 미수정. 임시 워크트리 `/private/tmp/u44-review/tree`(리뷰 종료 시 제거).
`clients/web/gates/_tmp-shots.mjs`(캡처 추출용 임시 사본)는 삭제 완료 — 트리 clean 확인.

---

## 0. 평가 수단 (무엇을 실제로 보았는가)

| 수단 | 상태 |
|---|---|
| 웹 `npm ci` → `TYPING_GATE_SHOTS=1 npm run gate:typing` | **PASS** (exit 0). 로그 `u44-evidence/u44-gate-typing.log` |
| 웹 `BORDERS_GATE_SHOTS=1 npm run gate:borders` | **FAIL (exit 1)**. 로그 `u44-evidence/u44-gate-borders.log` |
| 웹 캡처 | 게이트가 단언에서 죽어 shots를 못 남김 → 캡처를 앞으로 옮긴 **일회용 사본**으로 추출 후 사본 삭제. `u44-evidence/web/time-borders-{light,dark}.png`, `typing-{light,dark,narrow-light,narrow-dark,dense-*}.png` |
| 폰 캡처 | 레포 커밋본 그대로. `u44-evidence/phone/u44-{approval-card,group,dividers,row}.png` (1206×2622, iPhone 17 Pro, **pt = px/3**) |
| 폰 런타임 | 시뮬레이터 재캡처 없음 → 폰의 일부 판정은 코드 + 커밋 캡처 근거이며 아래에 **확인 필요**로 분리 |
| 토큰 실측 | 웹 `clients/web/src/design/tokens.css`, 폰 `clients/mobile/src/design/tokens.ts` 직접 인용. 웹 스타일은 Tailwind 유틸 + 이 tokens.css 하나 |

**Light/Dark 둘 다 확인함**(웹 `time-borders-{light,dark}.png`). 폰은 다크 단일 스킴.

### 기계적 프리플라이트 (SKILL §5) — 원문 출력

```
### A. Swift (SKILL §5 리터럴) — macOS/Core는 이 배치가 건드리지 않음
$ grep -rn 'Color(red:' macOS/Sources Core/Sources | grep -v 'Theme\|Tokens'
(no output)
$ grep -rn 'Font\.custom\|\.font(.system(size' macOS/Sources | grep -v 'Theme\|Tokens'
(no output)
$ grep -rn '—\|–' macOS/Sources Core/Sources --include='*.swift' | grep -i 'Text(\|String(\|label\|title\|message'
macOS/Sources/MomoMac/MomoServerSession.swift:1190:   // titlebar band — drop the banner below it so chrome controls
   → 주석. 사용자 노출 문자열 아님. PASS

### B. 이 배치가 **추가한 줄**에 대한 웹/RN 대응 검사
raw hex in added lines:            (없음)
em-dash inside user-visible string: (없음 — 히트 전부 `describe`/`it` 테스트 설명)
hype vocabulary(원활/손쉽게/seamless/...): (없음)

### C. 웹 빌드 산출 CSS 대조 (dist/assets/index-5KZPSqTv.css)
.pt-3{padding-top:var(--spacing-3)}        ← 있음
.py-1\.5 → grep -c = 0                      ← 없음
.pb-1\.5 → 없음
```

---

## 1. 두 클라 구분선은 같은 문법인가 (중점 ①)

**정렬·수사·숫자는 통일됐다. 어휘는 아직 갈라져 있고, 색은 우연히 맞는다.**

| 축 | 웹 | 폰 | 판정 |
|---|---|---|---|
| 라벨 위치 | `data-label-side=leading`(게이트 `[divider]` 3건 전부 `"side":"leading"`) | 라벨 → rule 순서 JSX (`MessageRow.tsx` DayDivider/UnreadDivider/RecoveryDivider) | **일치** |
| 오늘/어제 어휘 | `7월 30일` · `어제` · `오늘` (게이트 `[divider]`) | `오늘` · `어제` · `10월 6일` (`u44-dividers.png`) | **일치** |
| 낭독용 절대 날짜 | `aria-label="2026년 8월 5일, 오늘"` (게이트) | `accessibilityLabel={dayDividerLabel(...)}` | **일치** |
| 숫자만 tabular | 게이트 `[numeric]`: `7`·`30` true, `월 `·`일` false | `dividerFigure: {fontVariant:['tabular-nums']}` 를 figure Text에만 중첩 | **일치** |
| 여백 위계 | day `py-3`(12) > marker `py-2`(8) — 둘 다 스케일에 있어 컴파일됨 | 실측 라벨 중심 간격 36.2pt(day→day) / 33.3pt(day→marker) / 29.7pt(marker→marker) | **일치** |
| 복구 구분선 문장 | `재연결됨, seq N까지 복구` — `source`는 `data-source` 속성뿐, **화면에 없음** | `재연결됨, seq 4821까지 복구 **(다시 읽음)**` (`u44-dividers.png`) | **불일치 → [High] D-1** |
| 안읽음 색 | `tone="accent"` → `--accent` (`tokens.css:42` light `#a54c08` / dark `#f0a850`) | `color.warn` `#d9a441`; 폰의 `accent`는 `#3b6fd4`(파랑) | **역할 불일치 → [Medium] D-2** |

폰 실측(px/3): 라벨 좌측 시작 ≈16pt = `SAFE_GUTTER` ✓ · 라벨↔rule 간격 ≈13pt ≈ `labelGap` 12 ✓ ·
rule 우측 끝 386pt / 화면 402pt = 16pt 여백 ✓.

가운데 정렬 기각 근거(길이 변화가 가로 이동이 된다)는 재지적하지 않는다 — 캡처에서 실제로
「오늘」(2자)과 「10월 6일」(5자)이 **같은 x**에 선다.

---

## 2. Blocker

### [Blocker] W-1 — 웹의 그룹 간격 위계가 화면에 존재하지 않는다. 진단 이전보다 나쁘다

이 배치가 #1088/#1090에서 내건 중심 주장(H-7: 묶음 안 12 / 사이 18)이 **한 픽셀도 렌더되지 않는다.**

* `clients/web/src/features/timeline/spacing.ts:58,60`
  ```
  export const ROW_GROUP_START_PAD_CLASS = "pt-3 pb-1.5";
  export const ROW_CONTINUATION_PAD_CLASS = "py-1.5";
  ```
* `clients/web/src/design/tokens.css:150-161` — 스케일이 **고정**이고 `--spacing: initial`로
  동적 배수가 꺼져 있다. 허용 단계는 `{0, px, 4, 8, 12, 16, 24, 32}`뿐이며,
  **151행이 하필 `py-1.5`를 「아예 컴파일되지 않는 예」로 이름 대어 적어 두었다**:
  > `off-grid step such as p-5 or py-1.5 does not compile at all`
* 빌드 산출물 대조: `.pt-3` 있음 / `.py-1\.5`·`.pb-1\.5` **없음**(grep 0건).
* 이 배치의 자기 게이트가 잡는다 — `npm run gate:borders` **exit 1**:
  ```
  [gap] 묶음 안 0px · 묶음 사이(머리 행 위) 24px
  Error: rows inside one author group are packed: 간격이 0px다.
         진단이 실측한 8px에서 다섯 발화가 한 문단으로 뭉쳤다 (진단 H-7)
  ```
* 시각 증거: `u44-evidence/web/time-borders-light.png` / `time-borders-dark.png` —
  곽성재의 네 발화(`오늘 릴리스 노트 초안 올립니다.` / `먼저 롤백 절차부터 적었습니다.` /
  `빠진 항목 있으면 알려 주세요.` / `노트 본문은 스레드에 이어서 답니다.`)가 행간 없이
  **한 문단으로 붙어** 있다. 두 스킴 모두 동일.

실제 렌더값: **묶음 안 0px · 묶음 사이 12px**(= `contPad.bottom 0 + headPad.top 12`).
의도값 12 / 18. 진단이 실측한 기준선은 8px였으므로 **회귀**다.

**근본 원인은 오타가 아니다.** 코어가 정한 `ROW_SPACE.betweenGroups = 18`과 그 절반 6은
웹 디자인 시스템의 표현 가능 집합 `{4,8,12,16,24,32}` **바깥**에 있다. 두 클라가 나눠 갖는
상수를 고를 때 웹의 토큰 격자를 확인하지 않은 것이 결함의 자리다. 방향만 적는다 —
공용 상수는 두 클라가 **모두 표현할 수 있는 값**이어야 하거나, 웹 쪽에 이름 붙은
`--spacing-*` 단계가 먼저 생겨야 한다. 어느 쪽인지는 구현자가 정할 일이다.

### [Blocker] W-2 — 그 일을 막기로 한 가드가 초록이다

`spacing.ts` 머리말은 두 벌이 갈라지는 것을 `spacing.test.ts`가 막는다고 선언한다
(*"코어의 숫자를 고치면 여기 클래스도 같이 고칠 때까지 스위트가 붉다"*).
실행 결과 **8/8 passed** — 화면이 0px인 채로.

이유: `spacing.ts:31-43`의 `TAILWIND_SPACE_PX`가 **Tailwind 기본 스케일**(`0.5/1.5/2.5/3.5/5`)을
열거한다. 이 레포가 쓰는 표는 `tokens.css`의 `--spacing-*`이고 거기에 `1.5`는 없다.
가드가 틀린 표를 보고 있으므로 W-1을 고쳐도 **다음 goal에서 같은 방식으로 다시 벌어진다.**
W-1과 함께 고칠 일이지만 별개의 결함이라 따로 적는다.

### [Blocker] M-1 — 폰: 시각 칸을 예약하는 자리가 두 곳뿐인데, 시각은 모든 행에 절대 배치된다

`clients/mobile/src/features/conversation/MessageRow.tsx`

* 시각은 **모든 행**에 절대 배치된다 — `rowTime` (`position:'absolute'`, `right: SAFE_GUTTER`,
  `width: TIME_COLUMN(34)`, `top: space.xs`), 렌더 위치 `:1213`.
* 그런데 오른쪽을 비워 두는 곳은 **둘뿐**이다:
  `authorRow.paddingRight = TIME_COLUMN + space.sm` 과
  `:1284` `<View style={startsGroup ? undefined : styles.continuationBody}>` —
  이 View는 **`<MessageBody>`만** 감싸고, **`!startsGroup`일 때만** 적용된다.
* 연속 행의 첫 흐름 자식이 될 수 있는 나머지는 전부 무예약이다:
  답글 표식(`:1225`) · `QuoteBlock`(`:1244`) · tombstone(`:1275`) ·
  `ArtifactCard`(`:1306`) · `AgentCard`(`:1311`) · `'내용 없는 메시지'`(`:1326`).

관찰된 증거 — 레포가 커밋한 `u44-evidence/phone/u44-row.png`:
본문 첫 줄이 시각과 **겹쳐 인쇄**되어 `...문서에⁷젝³ / 어 뒀어요.`로 읽힌다.
(확대본으로 회색 `07`/`13` 글리프가 흰 본문 글리프 위에 얹힌 것이 보인다.)

**확인 필요 — 정확히 어디까지가 HEAD인가:**
`u44-row.png`는 `c0b58405`에서 마지막으로 쓰였고, 그 뒤 HEAD에서
`rowStartsGroup`이 `paddingTop: space.md`(12, 안쪽) → `marginTop: 18-12`(6, 바깥)로,
`rowInner.paddingVertical`이 4 → 6으로 바뀌었다. 그래서 **그룹 머리 행의 충돌은
HEAD에서 해소되었을 수 있고**, 실제로 `u44-group.png`(HEAD 코드에서 촬영)에서는
`06:59`가 작성자 줄에 정상적으로 앉는다. 나는 HEAD의 그룹 머리 픽셀을 겹침이라고
주장하지 않는다.

**그럼에도 Blocker인 이유는 구조가 HEAD에 그대로 있기 때문이다.** 연속 행에서는
시각이 첫 흐름 자식의 상단에 앉는 것이 설계이고(주석이 그렇게 적는다), 그 첫 자식이
본문이 아닐 때 예약이 없다. 그리고 이 배치의 픽스처는 그 경우를 **한 번도 세우지 않는다** —
`measure/surfaces.tsx:415`가 승인 카드 셋 전부에 `startsGroup`을 건다. 즉
**연달아 온 에이전트 승인 카드**(타임라인이 승인 카드를 둘 이상 보여주는 가장 흔한 경로)는
캡처된 적이 없다.

카드 경우에는 위험이 하나 더 겹친다: `rowTime`은 카드보다 **앞선 형제**라 불투명한
`styles.card` 배경이 그 위에 칠해질 수 있고(= 시각이 조용히 사라짐), 동시에 카드 자신의
상태 칩(`승인 대기`)이 카드 오른쪽 위 — 정확히 그 34pt 칸 — 에 있다
(`u44-approval-card.png`에서 칩의 가로 범위가 시각 칸과 겹치는 구간이 실제로 존재).
겹치든 가려지든 둘 다 결함이다.

방향만: 예약을 「본문」이 아니라 **행의 첫 줄**이 지게 하면(예: `rowInner` 쪽에서 한 번,
또는 첫 흐름 자식에 일괄) 자식 종류가 늘 때마다 같은 구멍이 다시 생기지 않는다.

---

## 3. High

### [High] E-1 — 이 배치의 증거로 커밋된 캡처가 「겹쳐 인쇄된 글자」 사진이다

`u44-row.png`는 `c0b58405` 이후 재촬영되지 않았고(위 M-1의 지오메트리 변경이 그 사이에 일어났다),
그 결과 레포에는 **텍스트 충돌 사진이 U4-4의 증거로 남아 있다.** 리뷰어가 저장소만 읽어서는
이것이 고쳐진 것인지 남아 있는 것인지 판별할 수 없다 — 나도 판별하지 못해 M-1을
「확인 필요」로 쪼개야 했다. 캡처 세트는 코드와 같은 커밋에서 함께 갱신되거나, 낡은 것은
지워져야 한다.

### [High] D-1 — 복구 구분선에서 두 클라가 아직 다른 문장을 말한다

* 폰: `RecoveryDivider`가 `source === 'backfill'`일 때
  `{kind:'prose', text:' (다시 읽음)'}`를 **로컬에서** 이어 붙인다 → 화면 문장
  `재연결됨, seq 4821까지 복구 (다시 읽음)` (`u44-dividers.png`).
* 웹: `MessageRow.tsx:773` `extra={{ "data-seq": seq, "data-source": source }}` —
  `source`는 속성으로만 나가고 **화면에는 한 글자도 없다**.

코어 `divider.ts`가 존재하는 이유가 정확히 이것(*"각자 짓는 한 고쳐도 다시 벌어진다"*)인데,
모듈을 만든 그 커밋에서 폰이 어휘 판정 하나를 로컬에 남겼다. `source`가
`recoveryDividerSegments`의 인자가 아니라는 것이 그 구멍이다.

(확인 필요: 웹 복구 구분선은 게이트 픽스처에 없어 캡처로는 못 봤다 — 판정 근거는 소스다.)

### [High] W-3 — 320폭에서 「님」이 이름을 잃는다. 잘림 표지의 분리도 성립하지 않는다

`u44-evidence/web/typing-narrow-light.png` (게이트가 스스로 찍는 320폭 판):

```
김민서 프로덕트디자인님, 이도현 플랫폼…  님이 작성 중…
```

두 가지가 동시에 깨진다.

1. **「님」이 고아가 된다.** 님은 이름에 붙는 의존 형태소인데, lead가 잘리는 순간
   `플랫폼…␣님이`가 되어 존대할 대상을 잃는다. 한국어로 읽으면 문장이 아니다.
2. **머리 주석이 내건 이득이 배송되지 않는다.** 주석은 *"잘림의 `…`는 이름 안쪽에만 생겨
   문장 끝의 `…`와 자리가 갈린다 — 잘린 줄과 온전한 줄이 처음으로 구분된다"*고 적는다.
   실제 캡처에서 두 `…`는 **4글자 거리**에 있고 한 번의 말더듬으로 읽힌다.
   구분은 일어나지 않는다.

이것은 기록된 트레이드오프(「터치에 잘린 이름 복구 경로 없음」)와 **다른 지적이다.**
그 트레이드오프는 재지적하지 않는다. 여기서 깨진 것은 lead/tail 분할이 사겠다고 한
**바로 그 이득**이다. 동사가 살아남은 것(`tail 넘침 0px`)은 확인했고 그건 지켜졌다.

방향만: 자르는 경계가 한국어가 끊어도 되는 자리에 있어야 한다. 님을 꼬리에 묶어 둔 것이
고아를 만드는 원인이므로, 꼬리를 동사만 지게 하거나 — lead가 못 들어가는 폭에서는
이미 있는 집계 문구(`N명이 작성 중…`, 절대 잘리지 않는다)로 넘기는 길도 있다.
어느 쪽인지는 구현자가 정할 일이다.

---

## 4. Medium

### [Medium] D-2 — 안읽음 경계의 색이 두 클라에서 다른 토큰 역할이다 (오늘은 우연히 닮았다)

웹 `tone="accent"` → `--accent`(`tokens.css:42`, light `#a54c08` / dark `#f0a850`).
폰 `color.warn` `#d9a441`(라벨 + rule 양쪽). 폰의 `accent`는 `#3b6fd4`(파랑)이다.
두 값이 지금 비슷한 호박색이라 **화면에서는 통일되어 보이지만 계약이 아니다.**
어느 한쪽 팔레트를 손대는 날 안읽음 경계가 조용히 갈라지고, 코어는 색을 명시적으로
제외하므로 아무도 잡지 못한다. M-2가 서술한 실패 양식 그대로다.

### [Medium] W-4 — hover 타임스탬프의 발견 가능성 (중점 ②)

`time-borders-light.png`: 시각이 보이는 행은 **hover 중인 한 행뿐**이고, 거터에 시각이
있다는 사실을 알리는 정지 상태의 단서는 없다. 그룹 머리 행이 이름 옆에 항상 시각을
보여 주므로 개념 자체는 배울 수 있지만, 연속 행에 마우스를 얹어 본 적 없는 사람은
행마다 시각이 있다는 것을 끝내 모른다.

키보드 경로는 `group-focus-within`인데, 이는 그 행 안에 **포커스 받을 자식이 있을 때만**
성립한다. 게이트는 액션이 있는 행에서 통과시켰다(`[rowtime] 포커스 1`). 그러나
`MessageActionColumn`·칩은 `actions`가 넘어올 때만 서므로, `MessageRow`를 읽기 전용으로
마운트하는 표면(작업 세션 이벤트 로그, `showRollup=false`인 스레드 패널)에는 포커스 가능한
자식이 없고 **포인터 없는 사용자에게 시각으로 가는 길이 아예 없다.**
`<time>`은 언제나 DOM에 있으므로 보조기술에는 영향 없다 — 눈으로 읽으며 키보드만 쓰는
사람에게만 생기는 구멍이다.
(확인 필요: 읽기 전용 마운트는 캡처하지 못했다.)

### [Medium] M-2 — 34pt 시각 칸: 본문과 경합하지 않는다. 다만 그룹 머리에서 기준선이 어긋난다 (중점 ③)

**경합하지 않는다는 쪽은 확인했다.** `u44-group.png` 실측(px/3):
`06:59`/`07:00`/`07:03`이 폭 **34pt**, 우측 끝 **386pt**(= 402 − `SAFE_GUTTER` 16)로
오른쪽 정렬되어 한 줄에 선다. 12pt `#9aa0a8`(대비 **7.17:1**)이 16pt `#f2f3f5`(17.02:1)
본문 옆에서 확실히 뒤로 물러난다 — 눈이 그 칸을 「안 읽기로」 정할 수 있다는 설계 주장은
캡처에서 성립한다.

**어긋나는 쪽:** 그룹 머리 행에서 `06:59`가 `곽성재`보다 2~3pt 아래에 앉는다.
`rowTime`이 작성자 줄의 `alignItems:'baseline'`에 참여하지 않고 `top: space.xs` +
`lineHeight: 22`로 따로 서기 때문이다. 한 줄로 읽혀야 할 두 조각이 기준선을 공유하지 않는다.
`lineHeight: 22`는 이 배치가 추가한 유일한 스케일 밖 숫자이기도 하다(같은 파일의 다른
보조 텍스트는 17/18을 쓴다).

### [Medium] M-3 — 승인 카드 세 상태의 위계 (중점 ④)

`u44-approval-card.png`가 담은 것은 **대기 / 불가 / 결정 뒤** 셋이다.
**오프라인 상태는 캡처에 없다** — 증거가 상수 하나뿐이라 시각 판정은 **확인 필요**로 남긴다.

* 세 문장이 전부 같은 옷을 입는다. 영수증(`승인을 기록했습니다.`), 안내
  (`이 결정은 인박스나 데스크톱 앱에서 처리할 수 있습니다.`), 오프라인 문장이 모두
  `styles.cardNote`다. 성격이 셋 다 다르다 — 하나는 **내가 방금 한 되돌릴 수 없는 행동의
  영수증**, 하나는 길 안내, 하나는 일시적 차단. 구분을 지는 것은 상태 칩뿐인데 칩은
  다른 질문(승인의 상태)에 답한다. 카드에서 가장 값어치 있는 문장인 영수증이 가장 조용한
  차림으로 나온다.
* `APPROVAL_OFFLINE_COPY`는 47자 두 문장이라 카드 안에서 2~3줄로 접힌다. 나머지 둘은
  캡처에서 한 줄이다. 즉 **일시적이고 자주 오가는 상태가 카드 높이를 가장 크게 바꾼다.**
  (확인 필요 — 미캡처)
* `ApprovalDecision`의 `bar`가 `paddingBottom: space.md`를 들고 들어오는데 카드는 이미
  자기 패딩이 있다. 그래서 대기 카드만 바닥에 ~12pt의 빈 공간이 더 있다 — 캡처에서 보인다.

승인/거부 두 버튼이 1단계에서 시각적으로 동일한 것은 지적하지 않는다: 그 탭은 확정이
아니라 무장이고(`arm`), `accessibilityLabel="거부, 확인 필요"`가 그 계약을 적는다.
2단계에서 `buttonCommit`(accent) / `buttonReject`(dangerBorder)로 갈라지는 것도 확인했다.

### [Medium] C-1 — `seq`가 사용자 문구인 채로 코어 정본이 되었다

`packages/momo-core/src/features/timeline/divider.ts:196` →
`재연결됨, seq 4821까지 복구`. 폰은 이제 그 숫자에 tabular-nums까지 걸어 **강조**한다
(`u44-dividers.png`).

SKILL §4: *"Internal vocabulary (… run IDs, seq numbers) never appears as user-facing copy
outside developer/diagnostic surfaces."* 두 클라 모두에 이전부터 있던 문구이므로 이 배치가
만든 결함은 아니다. 그러나 이 배치가 그것을 **공용 정본으로 승격**시켜, 의도된 문구라고
주장하고 동시에 걷어내기 어렵게 만들었다. 정확성(서버 발급값)이 근거로 적혀 있는데,
읽는 사람에게는 seq가 무엇인지에 대한 모델이 없다.

---

## 5. Nitpick

* **N-1** 웹 `clients/web/src/features/timeline/MessageRow.tsx:672-675` — `DividerRow` 독스트링이
  *"여백을 Tailwind 클래스가 아니라 `style`로 거는 이유는…"*이라고 적는데 구현은 `padClass`를
  받는다. `spacing.ts` 머리말은 정반대 결정(CSP가 인라인 스타일을 막아 클래스뿐)을 설명한다.
  1차의 잔해이고, 지금 이 파일은 양쪽 주장을 함께 담고 있다.
* **N-2** 폰 구분선 rule이 `StyleSheet.hairlineWidth`(0.33pt) → `ruleThickness` **1pt**로 바뀌었다.
  3x 기기에서 iOS 헤어라인의 **3배**다. 「CSS px = RN pt」는 레이아웃에 대해 참이지만
  플랫폼 헤어라인 관례에 대해서는 아니다. `color.border`의 배경 대비는 **1.41:1**이라,
  두꺼워진 만큼 눈에 띄지만 그 선은 뜻을 나르지 않는다(뜻은 전부 좌측 라벨에 있다).
* **N-3** `TIME_COLUMN = 34`는 스케일 `{4,8,12,16,24,32}` 밖이다. 실측 근거와 주석이 붙은
  「좋은 쪽」 매직 넘버지만, `continuationBody: paddingRight: 34 + 8 = 42`로 간격 체계 안까지
  번져 나간다.

---

## 6. 제대로 된 것 (되돌리지 말 것)

* **대비 수리가 실측으로 옳다.** 행 시각·구분선 라벨을 `textFaint` → `textMuted`로 올린 결과
  배경 대비 **3.91:1 → 7.17:1**(내 계산으로 재확인). 본문 AA를 못 지나던 글자가 지난다.
* **figure/prose 분리가 실제로 「7월  29일」을 고친다.** 웹은 `figure`에만 `data-numeric`
  (게이트 `[numeric]`이 조각별로 확인), 폰은 figure Text에만 `fontVariant` 중첩. 두 클라 동시.
* **좌측 라벨 통일이 캡처에서 성립한다.** 「오늘」(2자)과 「10월 6일」(5자)이 같은 x에 선다.
* **날짜(24) > 표지(16) 위계가 폰에서 실측된다** (라벨 중심 간격 36.2 / 33.3 / 29.7pt).
* **승인 카드의 막다른 길이 진짜로 열렸다.** 영수증을 컨트롤보다 **먼저** 두는 순서,
  그리고 칩을 원장 응답으로 덮는 판단(`ApprovalReceipt.status`)이 옳다 —
  「승인을 기록했습니다」 밑에 「승인 대기」 칩이 붙는 화면은 막다른 길보다 나빴을 것이다.
  `deadlinePassed`를 게이트가 아니라 정직 문구로 쓰는 것, `useOnline`이 레일이 아니라
  NetInfo를 보는 것(결정은 REST) 모두 근거가 화면 쪽으로 정렬돼 있다.
* **typing 줄에서 동사는 어떤 폭에서도 살아남는다** (`tail 넘침 0px`, 320폭 실측),
  그리고 `sr-only` 라벨이 작동하지 않던 `title` 경로를 대체한다
  (게이트 `[a11y] "김민서 프로덕트디자인님, 이도현 플랫폼엔지니어링님이 작성 중"` — 폭과 무관하게 온전).

---

## 7. 판정

```
### Design Review — U4-4 (웹 타임라인·컴포저 / 폰 타임라인·승인 카드) @ e69ee79e
Screenshots:
  scratchpad/u44-evidence/web/time-borders-{light,dark}.png
  scratchpad/u44-evidence/web/typing-{light,dark}.png
  scratchpad/u44-evidence/web/typing-narrow-{light,dark}.png
  scratchpad/u44-evidence/web/typing-dense-{light,dark}.png
  scratchpad/u44-evidence/phone/u44-{dividers,group,approval-card,row}.png
Gate logs:
  scratchpad/u44-evidence/u44-gate-typing.log   (PASS)
  scratchpad/u44-evidence/u44-gate-borders.log  (FAIL, exit 1)

[Blocker] W-1  웹 묶음 안 간격 0px — py-1.5/pb-1.5가 이 레포 스케일에서 컴파일되지 않음.
               H-7이 안 닫혔고 진단 기준선 8px보다 나쁘다. 자기 게이트가 red.
[Blocker] W-2  그 회귀를 막기로 한 spacing.test.ts가 초록 — Tailwind 기본 스케일을 보고 있다.
[Blocker] M-1  폰 시각 칸 예약이 authorRow와 (연속 행) MessageBody 둘뿐 —
               인용·답글 표식·승인 카드·아티팩트가 첫 자식일 때 무예약.
               관찰 증거는 u44-row.png(겹쳐 인쇄), HEAD 픽셀은 확인 필요.
[High]    E-1  텍스트 충돌 캡처가 이 배치의 증거로 커밋돼 있다(u44-row.png, 2커밋 낡음).
[High]    D-1  복구 구분선 문장이 갈라진다 — 폰 "(다시 읽음)", 웹은 화면에 없음.
[High]    W-3  320폭에서 「님」이 고아가 되고, lead/tail 분할이 약속한 「…의 분리」가 성립 안 함.
[Medium]  D-2  안읽음 색이 웹=accent / 폰=warn — 지금 닮은 것은 우연.
[Medium]  W-4  hover 시각의 발견 가능성 · 액션 없는 행에는 키보드 경로 없음.
[Medium]  M-2  34pt 칸은 본문과 경합하지 않음(확인). 그룹 머리에서 기준선 어긋남 + lineHeight 22.
[Medium]  M-3  승인 카드 세 문장이 같은 옷 — 영수증이 가장 조용하다. 오프라인 상태 미캡처.
[Medium]  C-1  seq가 사용자 문구인 채 코어 정본으로 승격 (SKILL §4).
[Nitpick] N-1  DividerRow 독스트링이 구현과 반대(style vs padClass).
[Nitpick] N-2  폰 rule이 헤어라인의 3배(1pt), 대비 1.41:1.
[Nitpick] N-3  TIME_COLUMN 34 → paddingRight 42로 스케일 밖 값이 번진다.

Verdict: FAIL (blockers: 3)
```

Blocker 3건이므로 구현자에게 되돌아간다. 웹 두 건은 한 자리(간격 브리지)에서 함께 고쳐지고,
폰 한 건은 예약을 「본문」이 아니라 「행의 첫 줄」이 지게 하는 문제다.

**의도적 트레이드오프 4건(터치 복구 경로 · 가운뎃점 관리자 병기 · 오프라인 우선순위 ·
좌측 정렬 통일)은 전부 근거를 읽었고 재지적하지 않았다.**
