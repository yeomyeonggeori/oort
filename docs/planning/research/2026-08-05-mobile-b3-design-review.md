# Design Review — momo 모바일(RN) 대화 표면 일괄 (track/engine `c9ea9cc9`)

일괄 대상: M1 인용 답글(#1062) · M2 작성 중(#1064) · M3 본문 마크다운(#1067) · M4 메시지 복사(#1068)
검토 트리: `/private/tmp/b3-mobile-review` (origin/track/engine `c9ea9cc9` detached worktree, 리뷰 종료 시 제거)
기준: `.claude/skills/momo-design-taste/SKILL.md` + `references/review-rubric.md` + `references/ios-rubric.md`

---

## 0. 무엇으로 평가했는가 (증거 기반 — 먼저 읽을 것)

| 증거 | 상태 |
|---|---|
| 시뮬레이터 런타임 캡처 | **없음.** 워크트리에 `clients/mobile/node_modules` 미설치, RN 빌드/Metro 미기동 |
| 스냅샷 아티팩트 | **없음.** `clients/mobile/measure/captures/`에 이번 4개 표면 캡처 0장 (최신은 지난 배치 `rn-c5-*.png`) |
| 정독 | 변경된 mobile 파일 전량 + `packages/momo-core/.../quote.ts`·`markdown.ts`·`typing.ts` |
| 웹 대응물 동등성 비교 | `clients/web/src/features/timeline/QuoteBlock.tsx`·`MessageBody.tsx`, `clients/web/src/features/chat/TypingLine.tsx` (이미 2회 리뷰 통과분) |
| 토큰 실측 | `clients/mobile/src/design/tokens.ts` 값으로 WCAG 대비 계산 |
| 기하 보정 | 지난 배치 캡처 `measure/captures/rn-c5-sheet.png` (시트 행 피치 ≈43pt 실측) |

**따라서 루브릭 위상 1·2·4(시각 부분)·5는 SKIPPED**, 3·6·7 + 코드에서 도출 가능한 히트테스트/기하/대비만 판정했다.
"픽셀을 봤다"고 주장하는 지적은 이 보고서에 없다. 계산으로 도출한 수치는 **(도출)** 로 표기했고, 실기기 확인이 필요한 항목은 **확인 필요**로 분리했다.

기록된 모바일 고유 결정(점프 워처 미이식 · 따라가기 해제 · 낙관 메아리 자기 인용 · selectable 정책)은 재지적하지 않았다. 아래 M-1은 selectable **정책**이 아니라 그 정책이 마크다운 경로에서 실행되지 않는 **구현 결함**이다.

---

## 1. 기계적 프리플라이트 (SKILL §5의 RN 방언, 원문 출력)

```
$ cd clients/mobile
### 1) raw hex in changed conversation views (non-token)
src/features/conversation/MessageEditorSheet.tsx:162:    backgroundColor: '#000000aa',
src/features/conversation/MessageEditorSheet.tsx:209:  primaryLabel: {fontSize: font.label, color: '#ffffff', fontWeight: '700'},
src/features/conversation/MessageEditorSheet.tsx:218:  failureText: {color: '#f0b4b8', fontSize: font.label, lineHeight: 20},
src/features/conversation/MessageActionSheet.tsx:298:    backgroundColor: '#000000aa',
src/features/conversation/MessageActionSheet.tsx:343:  reactionMine: {borderColor: color.accent, backgroundColor: '#1a2740'},
src/features/conversation/Composer.tsx:361:  sendLabel: {color: '#ffffff', fontSize: font.label, fontWeight: '700'},
src/features/conversation/MessageBody.tsx:372:    backgroundColor: '#0b0d11',      <-- 이번 배치가 새 파일로 옮겨온 유일한 항목
src/features/conversation/MessageRow.tsx:1489:    backgroundColor: '#2a2136',
src/features/conversation/MessageRow.tsx:1520:  rowFailureText: {flex: 1, fontSize: font.meta, color: '#f0b4b8', lineHeight: 17},
src/features/conversation/MessageRow.tsx:1577:  chipMine: {borderColor: color.accent, backgroundColor: '#1a2740'},
src/features/conversation/MessageRow.tsx:1619:  statusChip_warn: {borderColor: '#4a3a1c', backgroundColor: '#241d0f'},

### 2) numeric fontSize not from font.* (changed files)
src/features/conversation/MessageActionSheet.tsx:344:  reactionGlyph: {fontSize: 24},
src/features/conversation/MessageRow.tsx:1491:  agentTagText: {fontSize: 10, color: color.agent, fontWeight: '600'},
src/features/conversation/MessageRow.tsx:1622:  statusChipText: {fontSize: 11, fontWeight: '600'},

### 3) em/en dash inside user-visible string literals (touched files)
MessageRow.tsx:386:          {`${card.failure.label} — ${card.failure.detail}`}
MessageRow.tsx:491:          {`변경이 너무 큽니다 — ${formatCount(...)}줄. 데스크톱 앱에서 열어 보세요.`}
   -> 둘 다 이번 diff에 없다(기존 문자열). 이번 배치가 **새로 넣은** 사용자 문자열에는 em/en dash 0건.
```

토큰 대비 실측(계산, sRGB WCAG 2.x):

```
textFaint #6b7280 on bg      #0f1115 = 3.91:1   (AA 4.5 미달)
textFaint #6b7280 on surface #171a20 = 3.60:1   (AA 4.5 미달)
textFaint #6b7280 on codebg  #0b0d11 = 4.02:1   (AA 4.5 미달)
textMuted #9aa0a8 on bg      #0f1115 = 7.17:1
text      #f2f3f5 on bg      #0f1115 = 17.02:1
surface   #171a20 on bg      #0f1115 = 1.08:1   (인용 블록 배경 vs 타임라인 배경)
```

---

## 2. 판정

### [Blocker] — 0건

시각 위상을 실행하지 못했으므로 "픽셀 결함 없음"을 주장하지 않는다. 다만 코드에서 도출 가능한 범위에서 **죽은 컨트롤·시스템 크롬 침범·기본 크기에서의 잘림은 발견되지 않았다.** (터치 기준. 보조기술 기준은 H-1 참조 — 팀이 루브릭 Detail SLA의 "keyboard path"를 iOS에서 VoiceOver로 매핑한다면 H-1은 Blocker로 승격된다. 그 매핑은 내 판단이 아니라 팀의 결정이라 High로 둔다.)

---

### [High]

**H-1. 행이 접근성 원소 하나인데, 이번 배치가 더한 행 안 컨트롤 4개에 로터 액션이 없다 — VoiceOver로 누를 방법이 없다**

- `MessageRow.tsx:823` `accessible` (주석 :819-822 "ONE accessibility element per row ... the same count the web client cut from 6 to 1")
- `MessageRow.tsx:794-799` 로터 액션 목록 = `메시지 액션` · `스레드 열기` **둘뿐**. `onAccessibilityAction`(:771-790)의 `activate`도 스레드/시트로만 간다.
- 이번 배치가 그 안에 넣은 새 컨트롤:
  - 인용 점프 `Quote.tsx:165-174` (`accessibilityRole="button"`, label `원본으로 이동`)
  - 코드 블록 복사 `MessageBody.tsx:214-224`
  - 본문 링크 `MessageBody.tsx:144-155`
  - 아티팩트 URL 열기 `MessageRow.tsx:507-513` (BL-3으로 **이번에** 살아난 컨트롤)
- iOS에서 `accessible` 부모는 자식을 접근성 트리에서 접는다. 넷 다 라벨은 잘 붙어 있는데 그 라벨이 노출되지 않는다. 손가락에는 살아 있고 스크린리더에는 없는 컨트롤이 넷 생겼다.
- 시트의 「메시지 복사」는 코드 복사의 대체가 아니다 — 같은 파일이 `MessageBody.tsx:249-252`에서 그 둘이 다르다고 직접 적었다(답 전체 vs 이 상자).
- 방향: 행이 한 원소라는 규칙을 깨지 말고, 인용이 있으면 `momoJumpQuote`, 코드/링크가 있으면 그에 대응하는 로터 액션이 붙는 쪽. 지금은 규칙만 있고 그 규칙이 요구하는 대가(액션 등재)를 안 치렀다.

**H-2. 인용 블록을 실제로 그리는 유일한 선이 accent다 — 웹 리뷰 B-1이 금지한 그 자리**

- `Quote.tsx:271` `rule: {width: 2, backgroundColor: color.accent}` · `Quote.tsx:309` `draftRule` 동일.
- 웹 정본은 반대다: `clients/web/src/features/timeline/QuoteBlock.tsx` `RAIL = "... border-l-2 border-line-strong ..."` + 그 위 독스트링 "**accent가 여기 닿지 않는다** (design-review B-1)", hover조차 중성(`hover:border-ink`).
- **정확성 단서(웹 근거 그대로는 폰에 전이되지 않음):** 웹의 이유는 "앰버 = 멘션/미읽/앵커"였는데, 폰 본문에는 멘션 하이라이트가 없다(코어 `markdown.ts:30-35`의 `Inline` 합집합에 mention 갈래 자체가 없다). 그러니 "멘션 색과 충돌"은 폰에서 성립하지 않는다. 그래도 지적하는 이유는 다음 두 가지다:
  - **(a) 배경이 범위를 못 닫는다.** `Quote.tsx:258-259` 주석은 "왼쪽 규칙이 「이건 내 말이 아니다」를 그리고, **배경이 그 범위를 닫는다**"고 적었는데, 그 배경은 `color.surface` on `color.bg` = **1.08:1 (도출)** 이다. 사실상 블록의 경계를 지는 것은 accent 선 하나뿐이고, 그래서 인용은 "참조"가 아니라 이 표면에서 **가장 색이 센 요소**가 된다. 웹은 같은 이유로 raised 배경을 넣었다 되돌렸다("폭을 꽉 채운 고도 있는 띠는 인용의 무게를 **올린다**").
  - **(b) 그 배경값이 「눌림」의 값이다.** `MessageRow.tsx:1473` `rowPressed: {backgroundColor: color.surface}`. 가만히 있는 인용 블록이 "지금 눌린 행"과 같은 채움을 쓴다.
- 덧붙여 폰에서 `color.accent`는 지금 **보내기 버튼 채움**(`Composer.tsx:357`)과 **내 반응 칩 테두리**(`MessageRow.tsx:1577`)의 뜻이다. 인용에 같은 색을 주면 accent가 이 화면에서 세 번째 뜻을 갖는다(SKILL §2 Color Consistency Lock).

**H-3. 「작성 중」이 자리를 예약하지 않는다 — 웹 리뷰 H-2가 *폰을 근거로* 내린 결정을 폰이 되돌렸다**

- `TypingBar.tsx:68` 문장이 없으면 `null`. 줄 높이 = `lineHeight 16 + paddingBottom 4` = **20pt (도출)** (`TypingBar.tsx:93-99`).
- `ConversationLayout.tsx:129-131` — `list: {flex:1}` + 컴포저 독은 auto 높이. 줄이 뜨고 지는 20pt마다 **입력창·전송 버튼이 올라갔다 내려오고** 타임라인 하단이 같이 밀린다.
- 웹 판정 원문(`clients/web/src/features/chat/TypingLine.tsx` "## 자리는 예약한다 (H-2)"): *"빈도도 다르다 ... 이 줄은 팀원이 치기 시작할 때마다 + 멈추고 6초 뒤마다. **폰에서는 키보드가 올라온 상태에서 엄지 아래의 전송 버튼**이 움직인다."* 웹 리뷰가 폰을 들어 설득한 결정을, 정작 폰이 반대로 구현했다.
- `TypingBar.tsx:38-43`의 반론("활동 줄도 같은 방식이므로 새 비용이 아니다")은 축이 다르다. 활동 줄은 내가 부른 턴이 뜨고 지는 것이라 예측 가능하고, 이 줄은 **남의 키**에 6초 주기로 뜨고 진다.
- 방향: 예약이든 다른 안정화든, "누가 치기 시작했다"가 내 엄지 밑 컨트롤을 움직이지 않는 쪽.

**H-4. 코드 블록 본문 색이 박혀 있어, 확정된 코드가 「보내는 중」과 같은 색이고 낙관 메아리에서는 흐려지지 않는다**

- `MessageBody.tsx:391` `code: {..., color: color.textMuted, ...}` (박음)
- `MessageBody.tsx:356` `muted: {color: color.textMuted}` — **같은 값**. 즉 확정된 코드 블록과 "보내는 중" 본문이 같은 잉크다.
- 반대로 같은 파일 `:359-361`은 인라인 코드에 대해 *"색을 따로 박지 않는다 — **상속**되어야 보내는 중인 행의 흐린 색이 그 안의 코드까지 닿는다(웹이 같은 이유로 색을 뺐다)"* 라고 적었다. 블록이 그 규칙을 깬다.
- 웹 정본: `clients/web/src/features/timeline/MessageBody.tsx:43` `CODE_CLASS`에 색 없음 + `:34-41` *"Pinning `text-ink` here made a sending row's prose muted and its code not, which is a row that says two different things about its own state."* 폰이 정확히 그 상태다.
- 결과(위계): 사람이 꺼내러 온 것(명령어·해시·경로)이 산문(`#f2f3f5`, 17:1)보다 **한 급 아래**(`#9aa0a8`, 12px)로 조판된다. `PendingRow`(`MessageRow.tsx:1442`)의 `muted`도 코드 블록에는 닿지 않는다.

**H-5. 「원본은 더 위에 있다」를 danger 배너로 말한다 — 그리고 그 배너가 화면 반대쪽에서 목록을 밀어낸다**

- 문장: `ConversationScreen.tsx:537-538` (「... 아직 불러오지 않았습니다. 위로 올려 이어서 불러오세요.」)
- 표시: `ConversationScreen.tsx:677-681` `FailureBanner`
- `design/atoms.tsx:478-483` `failure = dangerSurface + dangerBorder`. **같은 파일 `:309-311`에 이 경우를 위한 컴포넌트가 이미 있다**: `NoticeBlock` — *"A statement of fact that is not a failure ... Deliberately has no retry and no danger colour."*
- 실패가 아니다. 사람이 인용을 눌렀고, 원본은 존재하며, 아직 안 불러왔을 뿐이다. 빨간 상자는 "내가 뭔가 잘못했다"를 말한다.
- 자리도 문제다: 배너는 `list` 슬롯의 **타임라인 위**에 붙는다. 사람이 만진 인용은 대개 화면 아래쪽인데 피드백은 맨 위에 뜨고, 뜨는 순간 타임라인이 배너 높이만큼 줄어 읽던 자리가 밀린다. 닫는 길도 없다(채널 이동 또는 다음 점프까지 남는다 — `:515-519`).

---

### [Medium]

**M-1. `selectable`이 마크다운 경로에서 조용히 무시된다 — 기록된 「낙관 메아리만 선택」 정책이 절반만 실행된다**
`MessageBody.tsx:334-341`(평문 경로)만 `selectable`을 쓰고, `:344-350`(마크다운 경로)은 어떤 `Text`에도 전달하지 않는다. `PendingRow`는 `selectable`을 넘긴다(`MessageRow.tsx:1442`). 결과: **마크다운을 담은 낙관 메아리는 선택도 안 되고 시트도 없어 텍스트를 꺼낼 길이 0이다** — BL-2가 고치려던 그 상태가 그 경우에만 남는다. (정책이 아니라 배선 결함이라 지적한다.)

**M-2. 시트에서 「메시지 복사」만 동사가 아니다**
`MessageActionSheet.tsx:234` `label="메시지 복사"` ↔ 이웃: `답글 달기`(:219) · `인용해서 답하기`(core `quote.ts:60`) · `고치기`(:240) · `지우기`(:245) · `닫기`(:251). SKILL §2 Copy는 동사 우선을 이진 규칙으로 둔다. 항목 **순서**(반응 → 답글 → 인용 → 복사 → 고치기 → 지우기 → 닫기)는 파괴적인 것이 아래라는 규율이 지켜져 있어 문제 없다.

**M-3. 같은 화면·같은 동사에 복사 영수증이 두 규칙**
코드 블록: 「복사」→「복사됨」 1.5초 (`MessageBody.tsx:204-224`). 시트 복사: 성공 시 **아무 말 없음**(시트만 닫힘), 실패 시에만 행 오류 (`MessageRow.tsx:1075-1087`). iOS에서 조용한 복사 자체는 관례지만, 30pt 옆의 형제 컨트롤이 「복사됨」이라고 말하는 화면에서는 같은 동사가 두 가지 계약을 갖는 것으로 읽힌다. 둘 중 하나로 통일할 것.

**M-4. 「작성 중」이 코어가 이 목적으로 만든 `typingSegments`를 안 쓴다 — 사람 줄에 자기 표지가 없다**
`ConversationScreen.tsx:462` `typingSentence(...)` (flat 문자열) → `TypingBar.tsx:93-99`에서 줄 전체를 `color.textFaint` 하나로 칠한다. 코어에는 `typing.ts:395-409` `typingSegments`가 있고 그 독스트링이 존재 이유를 적어 뒀다: *"(design-review PR 1059 M-1) ... 그 축이 없으면 사람 줄이 가진 단서는 「작성」과 「작업」을 가르는 한 음절과 「님」뿐이 된다."* 에이전트 줄은 이름을 agent 색으로 칠한다(`turnSurfaces.tsx:331`). 폰에서 두 줄의 차이는 **한 음절 + 회색 한 단계(textMuted 7.17:1 vs textFaint 3.91:1)** 뿐이다.

**M-5. 두 줄이 나란히 서지 않는다 — 사이에 두 줄이 더 끼어들 수 있다**
`ConversationScreen.tsx:716`(작업 중) → `:726`(중단 결과) → `:736`(길게 누르기 힌트) → `:740`(작성 중) → `:741`(컴포저). 「작업 중/작성 중」 대조로 어휘 경계를 가르치겠다는 것이 ADR-0149·웹 판의 논지인데, 중간에 다른 줄이 끼면 그 대조가 사라진다. 겹칠 때 입력창 위에 액세서리가 **4겹**까지 쌓이는 것도 같은 사안이다(키보드가 올라온 폰에서 대화 영역이 그만큼 사라진다). 순서 자체(사라지는 것을 아래로)는 근거가 명확하니 재론 불요 — 다만 웹은 반대 순서라 두 클라를 함께 쓰는 사람에게 두 줄이 자리를 맞바꾼다.

**M-6. 새 표면의 *본문급* 텍스트가 AA 미달인 `textFaint`에 앉았다**
`TypingBar.tsx:97`(줄 전체) · `Quote.tsx:293-297` unresolved 문장 · `:288-292` 묘비 · `:285` 「수정됨/인용 포함」 · `MessageBody.tsx:383` 코드 언어 라벨. 계산치 **3.60~4.02:1 (도출)** 로 전부 AA 4.5 미달이다. 토큰 자체의 문제라 이 배치만의 죄는 아니지만, 기존 용례(타임스탬프 같은 부속 표지)와 달리 여기서는 **그 표면이 하려는 말 전부**가 그 잉크에 있다(작성 중 줄, 「인용한 원본을 아직 불러오지 않았습니다」).

**M-7. 액션 시트에 최대 높이도 스크롤도 없는데 항목이 4개 → 6개가 됐다**
`MessageActionSheet.tsx:291` `root: {flex:1, justifyContent:'flex-end'}` · `:299-307` `sheet`에 `maxHeight`/`ScrollView` 없음. 지난 배치 캡처(`measure/captures/rn-c5-sheet.png`)에서 행 피치 ≈43pt 실측 → 이번 배치가 시트를 **약 +86pt** 키웠다(도출). 기본 텍스트 크기에서는 여유가 있지만, RN `Text`는 기본적으로 Dynamic Type을 따라 커지므로 큰 접근성 글자 크기 + 작은 기기에서는 위쪽(미리보기·빠른 반응)이 화면 밖으로 밀리고 되돌릴 스크롤이 없다. **확인 필요**(실기기 미측정).

**M-8. 인용 블록의 탭 타깃이 흔한 경우에 44pt 미만**
`Quote.tsx:272-277` `paddingVertical: space.xs`(4×2) + 저자 줄(12pt, 기본 lineHeight ≈14.4) + gap 1 + 발췌 1줄(lineHeight 18) ≈ **41pt (도출)**. 묘비 갈래는 더 낮다(≈39pt). `tokens.ts:22-23`이 "iOS HIG minimum tappable edge ... **Not negotiable per-screen**"이라고 선언한 값이다. 게다가 이 타깃은 바로 뒤의 행 탭(시트 열기)과 **다른 동작**이라 빗맞으면 엉뚱한 것이 열린다. `hitSlop`이 없다. **확인 필요**(글꼴 실측 아님).

**M-9. 코드 복사 버튼 실효 타깃 ≈40pt**
`MessageBody.tsx:386` `minHeight: 24` + `:218` `hitSlop 8` → 40pt (도출). 헤더 높이를 44로 올리지 않겠다는 근거(:384-385)는 타당한데, 그 결론이 `hitSlop`을 10으로 두는 것이 아니라 40pt로 끝난 이유가 없다.

**M-10. 점프가 도착했다는 표시가 없다**
`Timeline.tsx:1023` `scrollToIndex({viewPosition: 0.5})`만 하고 착지 표시가 없다. 웹에는 앵커 착지 틴트(`bg-accent-soft`, "방금 여기로 왔다")가 있다. 밀집한 타임라인에서 가운데로 스크롤만 하면 **어느 줄이 원본인지** 사람이 다시 찾아야 한다. 기록된 결정("점프 워처 미이식")은 *못 찾은 경우*에 대한 것이고 이건 *찾은 경우*라 별개 축이다.

---

### [Nitpick]

- **N-1** `MessageBody.tsx:372` `backgroundColor: '#0b0d11'` — tokens.ts에 없는 색(앱 배경보다 **더 어둡다**). 이전 파일에서 옮겨온 값이지만 새 파일에 정착했다. 웹은 반대 방향으로 한 단 **올린다**(`bg-surface-hover`).
- **N-2** 스케일 밖 간격: `Quote.tsx:261` `marginTop: 2`, `:277` `gap: 1`, `:310` `gap: 1`, `MessageBody.tsx:392` `list: {gap: 2}`. 스케일은 4/8/12/16/24(`tokens.ts:61-67`).
- **N-3** 순서 목록 마커 폭 `MessageBody.tsx:395-400` `minWidth: 18` — 16pt에서 "10."은 약 22pt(도출)라 두 자리부터 텍스트 시작선이 어긋난다. 주석(:394 "숫자 두 자리까지 흔들리지 않을 만큼")이 실제와 다르다. **확인 필요**.
- **N-4** `TypingBar.tsx:78` `accessibilityLiveRegion="polite"` — RN에서 **Android 전용** 속성이다. 이 앱은 iOS 전용(`package.json:5` "momo (oort) iOS client")이라 주석(:75-77)이 약속한 낭독은 일어나지 않는다. 참고로 웹은 같은 줄을 **일부러** live 영역에서 뺐다(3초마다 재낭독). 폰의 의도가 웹과 반대인지, 아니면 무동작인 채 주석만 남은 것인지 정리 필요.
- **N-5** `Quote.tsx:236-239` 초안 바의 unresolved 갈래가 저자를 `null`로 넘겨 **「알 수 없는 멤버 인용」**이라고 단정한다(`:59`, `:76-79`). 같은 상태에서 블록(`:107-111`)은 저자 줄을 아예 그리지 않는다 — 같은 사실에 두 답. 실제로는 `quoteDraftFor`(core `quote.ts:274-282`)가 항상 ready/deleted라 도달 불가 경로다.
- **N-6** 같은 상태에 문장이 둘: 블록 「인용한 원본을 아직 불러오지 않았습니다」(`Quote.tsx:110`) vs 초안 바 「원본을 아직 불러오지 않음」(`Quote.tsx:229`). 웹은 「인용한 메시지가 이 화면에 없습니다」. 한 줄 제약은 이해하나 낱말은 코어에서 나오는 편이 이 배치의 다른 문자열들과 같은 규율이다.
- **N-7** 사용자 문자열의 em dash 2건(`MessageRow.tsx:386`, `:491`)은 **이번 배치가 넣은 것이 아니다**(diff에 없음). 새 문자열에는 0건. 기록만 남긴다.
- **N-8** 캡처 증거 0장. `measure/` 하네스가 있고 지난 배치는 그것으로 리뷰용 사진을 남겼는데(`rn-c5-sheet.png` 등), 이번 4개 표면 중 하나도 하네스에 세워지지 않았다(`measure/surfaces.tsx` 변경은 `AVAILABILITY`에 `quote: true` 한 줄뿐). 이 리뷰의 시각 위상이 SKIPPED인 직접적 원인이다.

---

## 3. 잘 된 것 (되돌리지 말 것)

- 인용 vs 스레드를 네 축으로 갈랐다(자리·모양·어휘·목적지). `MessageRow.tsx:265-283`의 개정된 독스트링은 웹의 표와 같은 결론에 독립적으로 도달했다.
- 「목적지를 아는 인용은 로드 여부와 무관하게 눌린다」(`MessageRow.tsx:896-915`) — 「없는 방으로 가는 문」 규칙의 오적용을 스스로 찾아 고쳤다. 못 찾았을 때 할 말도 준비돼 있다(표현 방식은 H-5).
- `unresolved`를 `deleted`로 접지 않았다(`Quote.tsx:42-48`, `:107-111`). 멀쩡한 메시지를 지워졌다고 말하지 않는다.
- 마크다운 분기 제거가 옳다. `body.includes('```')` 하나로 답 전체가 모노스페이스 상자가 되던 것을 코어 파서 위로 올렸고, 평문 경로를 그대로 남겨 대다수 메시지의 밀도를 안 건드렸다(`MessageBody.tsx:300-342`).
- `splitItalicRuns`(`MessageBody.tsx:74-92`) — 웹의 `font-synthesis-style: none`을 RN에 없는 기능 대신 **같은 결과**로 옮겼다. 저자가 긋지 않은 획을 기계가 그리지 않는다.
- 코드 블록에만 자기 복사를 준 판단(`MessageBody.tsx:249-252`)과 타이머 정리(`:197-203`).
- ThreadPanel에서 `onQuote`를 **일부러** 안 준 것과 그 이유를 적어 둔 것(`ThreadPanel.tsx:114-123`).

---

## 4. 결론

```
Blocker  0
High     5  (H-1 VoiceOver 도달 불가 4개 · H-2 accent 규정선 · H-3 자리 미예약 ·
             H-4 코드 색 박음 · H-5 사실을 danger로)
Medium  10
Nit      8
```

**Verdict: PASS(blockers: 0) — 단, 루브릭의 통과선(Blocker 0 · High ≤2)을 넘으므로 구현자 반송 권고.**

시각 위상(1·2·4시각부·5)은 **SKIPPED**다. 이 배치의 다음 라운드는 `measure/` 하네스에 인용 3상태·작성 중·마크다운(코드/리스트/인라인 코드)·시트 6항목을 세워 캡처를 남긴 뒤 다시 봐야 한다. 위 M-6·M-7·M-8·N-3은 그 캡처 없이는 계산치로만 말할 수 있는 항목이다.
