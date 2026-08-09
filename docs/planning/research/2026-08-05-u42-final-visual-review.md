# Design Review — momo 모바일 U4-2 시각 위상 종결 (track/engine `8bc27ca8`)

대상: #1073(A 시각·위계) · #1074(B 접근성·타깃) · #1075(C 작성 중)
베이스라인: `docs/planning/research/2026-08-05-mobile-b3-design-review.md`(시각 위상 SKIPPED)
검토 트리: `/private/tmp/u42-review` (origin/track/engine `8bc27ca8` detached, 리뷰 종료 시 제거)
기준: `.claude/skills/momo-design-taste/SKILL.md` + `references/review-rubric.md`

Screenshots (전부 `clients/mobile/measure/captures/`, iPhone 17 Pro 1206×2622 = 402×874pt @3x):
`u42-quote-ready.png` · `u42-quote-deleted.png` · `u42-quote-unresolved.png` ·
`u42-typing-one.png` · `u42-typing-many.png` · `u42-markdown.png` · `u42-markdown-pending.png`

---

## 0. 이번엔 무엇을 실제로 봤는가

지난 리뷰는 캡처 0장이라 **모든 수치가 (도출)** 이었다. 이번에는 7장을 픽셀 단위로 샘플링해
토큰값과 대조했다. 아래의 모든 색·좌표·치수는 **PNG에서 직접 읽은 값**이고, 계산으로만 얻은
것은 **(도출)** 로 표기했다. 캡처가 담지 못한 축은 SKIPPED로 분리했다.

| 루브릭 위상 | 상태 | 근거 |
|---|---|---|
| 3 시각 polish (위계·대비·간격·정렬·밀도) | **실행** | 캡처 7장 픽셀 샘플링 |
| 6 코드 건전성 | **실행** | 프리플라이트 원문 §1 |
| 7 카피 | **실행** | 문자열 스캔 + 캡처의 실제 라벨 |
| 1 인터랙션(탭·롱프레스·눌림 상태) | **SKIPPED** | 정지 캡처. 눌린 상태 사진 없음 |
| 2 창 거동 → iOS 방언(회전·Split View·키보드 동반) | **SKIPPED** | 단일 방향·키보드 없는 캡처 |
| 4 접근성(VoiceOver 로터 실낭독·reduceMotion) | **SKIPPED** | 실기기 필요 |
| 5 강건성(Dynamic Type·긴 이름·200+ 메시지) | **SKIPPED** | 기본 글자 크기 캡처만 |
| 라이트 모드 | **N/A** | `tokens.ts` 에 라이트 팔레트 자체가 없다(다크 전용, U2 소관) |

**모션은 이 리뷰가 볼 수 없다.** H-3(자리 예약)이 주장하는 것은 "줄이 뜨고 질 때 컴포저가
안 움직인다"인데, 그것은 두 시점의 차이이지 한 장의 사진이 아니다. 아래 §2에서 코드·테스트
증거로 분리 판정했다.

---

## 1. 기계적 프리플라이트 (SKILL §5 RN 방언, 원문)

```
$ cd /private/tmp/u42-review/clients/mobile

### 1) raw hex in conversation views (주석 제외)
src/features/conversation/MessageEditorSheet.tsx:162:    backgroundColor: '#000000aa',
src/features/conversation/MessageEditorSheet.tsx:209:  primaryLabel: {... color: '#ffffff' ...},
src/features/conversation/MessageEditorSheet.tsx:218:  failureText: {color: '#f0b4b8', ...},
src/features/conversation/Composer.tsx:361:  sendLabel: {color: '#ffffff', ...},
src/features/conversation/MessageActionSheet.tsx:339:    backgroundColor: '#000000aa',
src/features/conversation/MessageActionSheet.tsx:384:  reactionMine: {... backgroundColor: '#1a2740'},
src/features/conversation/MessageRow.tsx:1609:    backgroundColor: '#2a2136',
src/features/conversation/MessageRow.tsx:1640:  rowFailureText: {... color: '#f0b4b8' ...},
src/features/conversation/MessageRow.tsx:1698:  chipMine: {... backgroundColor: '#1a2740'},
src/features/conversation/MessageRow.tsx:1740:  statusChip_warn: {borderColor: '#4a3a1c', backgroundColor: '#241d0f'},
  -> `MessageBody.tsx` 의 '#0b0d11' 은 **사라졌다** (N-1 수리). 남은 것은 전부 이전 배치분.

### 2) numeric fontSize not from font.*
src/features/conversation/MessageActionSheet.tsx:385:  reactionGlyph: {fontSize: 24},
src/features/conversation/MessageRow.tsx:1611:  agentTagText: {fontSize: 10, ...},
src/features/conversation/MessageRow.tsx:1743:  statusChipText: {fontSize: 11, ...},
  -> 셋 다 이전 배치분. 이번 배치가 더한 것 0건.

### 3) em/en dash in string literals (주석 제외, 정규식 스캔)
src/features/conversation/MessageRow.tsx:386: `${card.failure.label} — ${card.failure.detail}`
src/features/conversation/MessageRow.tsx:491: `변경이 너무 큽니다 — ${formatCount(...)}줄. 데스크톱 앱에서 열어 보세요.`
src/push/PushProvider.tsx:76,120 (로그 문자열, 사용자 비노출)
  -> 사용자 노출 2건은 **여전히 미수리**(지난 리뷰 N-7 이 "이번 배치가 넣은 것 아님"으로
     기록한 그대로). 이번 배치의 신규 문자열에는 0건.

### 4) off-scale spacing in 이번 배치 파일 3종
$ grep -E "(padding|margin|gap)[A-Za-z]*: *-?[0-9]+" Quote.tsx MessageBody.tsx TypingBar.tsx
(출력 없음)   -> N-2 수리 확인. 스케일 밖 간격 0건.
```

토큰 실측 대비 (`tokens.ts` 값 → sRGB WCAG 2.x, 이번 판정에 인용한 것만):

```
rule textFaint  #6b7280 on bg      #0f1115 = 3.909:1
code fill surf  #171a20 on bg      #0f1115 = 1.084:1
code border     #2a2f38 on bg      #0f1115 = 1.406:1
code text       #f2f3f5 on surface #171a20 = 15.696:1
code pending    #9aa0a8 on surface #171a20 =  6.612:1
codeLang        #6b7280 on surface #171a20 =  3.605:1
inlineCode fill #1e222a on bg      #0f1115 =  1.185:1
typing muted    #9aa0a8 on bg      #0f1115 =  7.170:1
typing name     #f2f3f5 on bg      #0f1115 = 17.020:1
tombstone       #6b7280 on bg      #0f1115 =  3.909:1   (AA 4.5 미달)
codeWrap surface #171a20  vs  rowPressed surface #171a20 = 1.000:1
```

---

## 2. 수리 확인 판정표 — (도출)이 픽셀에서 확인되는가

| 항목 | 주장 | 캡처 증거 | 판정 |
|---|---|---|---|
| **H-2** 인용 규정선 중성 | accent → `textFaint` | `u42-quote-ready.png` (48,330)~(53,420) 픽셀 = **(107,114,128)=#6b7280**. 폭 6px = **2.0pt** | **확인** |
| **H-2** 인용 배경 띠 부재 | 배경을 걷었다 | 같은 파일 규칙 오른쪽 (60,330)·(60,360)·(60,400) = **(15,17,21)=#0f1115**(앱 배경). 1.084:1 띠 없음 | **확인** |
| **H-2** accent 3중 의미 해소 | 인용에서 accent 제거 | 같은 사진 안에서 대조된다 — 반응 칩 테두리만 파랗다(y≈690, x≈40~180) | **확인** |
| **H-4** 코드 잉크 = 본문 잉크 | `textMuted` → `text` | `u42-markdown.png` 코드 상자 글자 = **(242,243,245)=#f2f3f5**, 산문과 동일 | **확인** |
| **H-4** 보내는 중에 코드도 흐려짐 | `muted` 를 명시 전달 | `u42-markdown-pending.png` 산문 = **(154,160,168)**, 코드 = **(154,160,168)** — **같다** | **확인** |
| **N-1** 코드 상자 밝기 | `#0b0d11`(배경보다 어두움) → `surface` | 코드 상자 채움 = **(23,26,32)=#171a20**, 배경 #0f1115 보다 **위**. 상자 y 455..640(62.0pt), x 3..1202 | **확인**(단 M-2 참조) |
| **M-4** 작성 중 이름 강조 | 이름 조각만 한 급 밝게 | `u42-typing-one.png` y213..243: 「김민수」 x51..133 = **#f2f3f5**, 「님이 작성 중…」 x138..324 = **#9aa0a8** | **확인** |
| **M-4/집계** 집계 문구엔 이름 없음 | `typingSegments` 에 name 조각 없음 | `u42-typing-many.png` 같은 밴드에 **#f2f3f5 픽셀 0개**, 전부 #9aa0a8 | **확인**(단 N-2 참조) |
| **M-6(부분)** 작성 중 AA | `textFaint`(3.909) → `textMuted`(7.170) | 위와 동일 샘플. 줄 안에 #6b7280 **0픽셀** | **확인** |
| **M-8** 인용 탭 타깃 바닥 | `minHeight 32` + hitSlop 6·6 | `u42-quote-unresolved.png` x=53 열 연속 구간 28.0pt + `block` borderRadius 6 모서리 클립 보정 ≈**31.7pt ≈ 32pt** | **확인**(시각 32, 실효 44는 도출) |
| **M-9** 코드 복사 타깃 | hitSlop 8 → 10 | `MessageBody.tsx:289` `{top:10,bottom:10,...}`; 캡처의 「복사」 잉크 y492..520 | **확인**(코드) / 실효 44는 도출 |
| **N-2** 스케일 밖 간격 | 제거 | 프리플라이트 §4 출력 없음. 캡처 정렬 실측: 인용 텍스트 좌단 **x=78px=26.00pt** = 16(거터)+2(선)+8(패딩) — 정확히 격자 위 | **확인** |
| **M-2** 시트 라벨 동사형 | 「메시지 복사」→「메시지 복사하기」 | `MessageActionSheet.tsx:274`. **캡처 없음**(시트 미재촬영) | 코드 확인 / 시각 SKIPPED |
| **M-3** 복사 영수증 통일 | 두 복사가 `COPY_RECEIPT_MS` 공유 | `copy.ts:32-37` · `MessageRow.tsx:1202`. 캡처는 idle 상태만 | 코드 확인 / 시각 SKIPPED |
| **H-5** 사실을 danger 로 말하지 않음 | `FailureBanner`→`NoticeBlock` | `ConversationScreen.tsx:703,733` 확인. **캡처 없음** | 코드 확인 / 시각 SKIPPED |
| **H-1** 로터 등재 4종 | `MessageRow.tsx:871-909` | 코드 확인(액션 최대 6개). VoiceOver 실낭독 검증 불가 | 코드 확인 / **SKIPPED** |
| **M-7** 시트 85% + 스크롤 | `MessageActionSheet.tsx:165,169` | 코드 확인. **큰 글자 캡처 없음** | 코드 확인 / **SKIPPED** |
| **M-1** 마크다운 selectable | 문단·목록·코드에 전달 | 코드 확인. 정지 캡처로는 관측 불가 | 코드 확인 / **SKIPPED** |
| **H-3** 작성 중 자리 예약 | `minHeight: 16+space.xs`=20pt | `TypingBar.tsx:151`. `typingStability.test.tsx:82-88` 이 "있을 때/없을 때 높이 동일"을 단정. **빈 상태 캡처 없음** | 코드+테스트 확인 / **시각 SKIPPED** |
| **N-4** `accessibilityLiveRegion` 제거 | 무동작 방어 제거 | 소스에 부재 확인 | **확인**(코드) |
| **N-3** 순서 목록 마커 폭 | 미수리(`minWidth: 18` 유지) | 캡처 fixture 에 **순서 목록이 없다** — 검증 불가 | **미확인** (M-4 참조) |

**요약: 지난 리뷰가 (도출)로만 말했던 시각 항목 8개 중 8개가 픽셀에서 확인됐다.**
반면 **수리 9건 중 6건(H-1·H-3·H-5·M-1·M-2·M-3·M-7)은 여전히 사진이 없다** — 이 배치가
캡처한 것은 자기가 고친 것의 절반이다(M-1 참조).

---

## 3. 신규 발견

### [Blocker] — 0건

기본 크기·기본 방향의 7장에서 **잘림·겹침·시스템 크롬 침범은 없다.**
`u42-markdown.png` 의 「결론」이 화면 왼쪽 끝(x=1px)에 붙어 잘려 보이는 것은 **제품 결함이
아니라 하네스 산물**이다: `measure/surfaces.tsx:styles.root` 에 가로 패딩이 없고 이 케이스는
`MessageBody` 를 행 밖에서 맨몸으로 그린다. 실제 행에서는 `MessageRow.tsx:1590`
`rowInner: {paddingHorizontal: SAFE_GUTTER}` 가 16pt 를 준다 — 같은 캡처 세트의
`u42-quote-ready.png` 에서 본문 좌단 **x=49px=16.3pt** 로 확인된다.
죽은 컨트롤 판정은 정지 캡처로 불가하므로 이 등급을 "없음"이라 단정하지 않는다(위상 1 SKIPPED).

---

### [High]

**H-1. 묘비·미해결 인용의 italic 이 한글에서 **아무것도 그리지 않는다** — 그래서 그 두 상태를
가르는 것이 AA 미달 회색 한 단계뿐이다**

- `Quote.tsx:329-338` `quotedTombstone` · `unresolved` 둘 다 `fontStyle: 'italic'`.
- 픽셀: `u42-quote-deleted.png` 「삭제된 메시지」(x≈70~230, y≈368~400) · `u42-quote-unresolved.png`
  「인용한 원본을 아직 불러오지 않았습니다」(x≈70~660, y≈340~375) — **세로 획이 전부 수직이다.**
  같은 사진의 비-italic 본문(「금요일 배포는…」)과 기울기 차이가 **0**. 확대 크롭에서 ㅣ·ㅐ·ㅔ
  획을 직접 비교했다. 한글 시스템 서체에 italic 페이스가 없고 합성 오블리크도 걸리지 않는다.
- 남는 구분: `quotedBody` **#9aa0a8 (7.170:1)** vs `quotedTombstone`/`unresolved` **#6b7280 (3.909:1)**.
  즉 「이건 진짜 인용문이 아니다」라는 **의미 구분 전체가 AA 4.5 미달인 회색 한 단계**에 걸려 있다.
  지난 리뷰 M-6 은 이것을 "토큰 문제라 이 배치만의 죄는 아니다"로 낮춰 뒀는데, italic 이
  무동작임이 확인된 지금은 그 회색이 **일의 100%** 를 한다.
- 같은 뿌리가 본문에도 있다: `MessageBody.tsx:448` `em: {fontStyle: 'italic'}`. 한국어 `*강조*`
  는 화면에서 강조되지 않는다. 이 배치가 `splitItalicRuns`(`MessageBody.tsx` 이탤릭 런 분리)로
  "저자가 긋지 않은 획을 기계가 그리지 않는다"를 지킨 것은 옳았는데, 반대편 — **저자가 그은
  획이 그려지지 않는다** — 은 열려 있다.
- 방향: italic 을 의미 축으로 계속 쓸 것인지부터 정할 것. 한글이 기본인 이 제품에서 italic 은
  "있는 척하는 축"이다. 축을 하나 더 주든(자리·기호·굵기) 색 축을 AA 위로 올리든, 지금은
  **보이지 않는 구분 + 못 읽는 회색** 두 개가 겹쳐 있다.

---

### [Medium]

**M-1. 이 배치가 고친 9건 중 6건은 여전히 사진이 없다 — 그리고 이미 있던 하네스 케이스도
다시 찍지 않았다**

- 하네스 케이스 목록(`measure/surfaces.tsx:179-319`): quote×3 · typing×2 · markdown×2 ·
  **sheet · delete · editor · editor-error · row · search×5**.
- 이번 배치가 **시트를 바꿨다**: 항목 +2(+88pt) · `maxHeight: windowHeight*0.85`(:165) ·
  `ScrollView`(:169) · 라벨 「메시지 복사하기」(:274). 그런데 `sheet` 케이스는 **다시 찍히지
  않았고**, 레포의 `rn-c5-sheet.png` 는 `49a524f6`(RN-C5 배치) 것이다 — 즉 **변경 전 사진**이다.
  찍는 비용이 0에 가까운 케이스(이미 하네스에 서 있다)를 두고 M-2·M-7·M-3 이 시각 미검증으로
  남았다.
- H-5(NoticeBlock)·H-3 빈 상태는 하네스 케이스 자체가 없다. H-3 은 이 배치에서 가장 길게
  논증된 수리인데(예약 높이 20pt), **그 수리의 대상인 "빈 줄" 상태가 캡처 세트에 없다.**
  두 장(비었을 때/찼을 때)이 나란히 있어야 "높이가 같다"가 사진이 된다.
- 지난 리뷰가 N-8 로 지적한 것의 절반만 닫혔다. 남은 절반은 다음 라운드로 미루는 것이 아니라
  같은 하네스에서 한 번 더 셔터를 누르는 일이다.

**M-2. 코드 상자의 「떠 있음」을 실제로 그리는 것은 테두리이고, 그 채움은 **눌린 행과 같은 색**이다**

- 실측: 코드 상자 채움 **#171a20**(캡처 (600,520)) = `color.surface`.
  배경 대비 **1.084:1** — 이 값은 #1073 본문이 인용 배경을 걷어낸 근거로 쓴 바로 그 수치다
  ("닫기는커녕 보이지 않는다"). 상자가 사진에서 읽히는 이유는 채움이 아니라
  **1px 테두리 `#2a2f38`(1.406:1)** 와 15.696:1 짜리 Menlo 블록 때문이다. N-1 의 목표(파묻히지
  않는다)는 달성됐지만 그 근거는 문서화된 것과 다르다.
- 더 실질적인 문제: `MessageRow.tsx:1593` `rowPressed: {backgroundColor: color.surface}` 가
  **그대로다**. 즉 행을 길게 누르는 동안(액션 시트를 여는 그 0.5초) 행 채움과 코드 상자 채움이
  **#171a20 대 #171a20 = 1.000:1** 이 되어 상자의 고도가 사라지고 1.296:1 테두리만 남는다.
  #1073 본문은 "이제 `surfacePressed` 가 누를 때만 나타나 자기 뜻을 되찾는다"고 적었는데,
  되찾은 것은 인용 블록 쪽이고 **행의 눌림은 여전히 `surface`** 다. (도출 — 눌린 상태 캡처 없음.)
- 짝: `MessageBody.tsx:455` `inlineCode: {backgroundColor: color.surfacePressed}` — 「눌림」
  토큰이 본문 안에 **정지 상태로** 앉아 있다. 지난 리뷰 H-2(b)가 인용 배경에 대해 지적한 바로 그
  형태가 인라인 코드로 옮겨간 것이다.
- 정리하면 이 화면에서 `surface` 는 지금 (a)카드/고지 (b)코드 상자 (c)눌린 행 세 뜻이고,
  `surfacePressed` 는 (d)눌린 인용/칩/버튼 (e)정지 상태 인라인 코드 두 뜻이다. 방향: 고도
  토큰과 상태 토큰이 같은 값 공간을 쓰지 않게 가르는 쪽.

**M-3. 인라인 코드 띠가 코드가 아니라 **선택 하이라이트**로 읽힌다**

- 실측(`u42-markdown.png`): `outbox_drain_worker` 띠 = x 66..485, y 293..355 → **높이 21.0pt**.
  문단 `lineHeight` 는 22(`MessageBody.tsx:445`). 즉 띠가 줄 상자를 거의 꽉 채운다.
- 좌우 여백이 **0** 이다 — 글리프가 띠 가장자리에 붙는다(RN 은 중첩 `Text` 배경에 패딩을
  못 준다). 위아래도 여백 없이 줄 상자 전체.
- 결과: 사진에서 이것은 "인용된 글자"가 아니라 **드래그 선택된 구간**처럼 보인다. 채움값이
  하필 `surfacePressed`(M-2)라는 것이 그 오독을 굳힌다.
- 연속 두 줄에 인라인 코드가 있으면 띠 사이 간격이 **4.3pt**(y355 → y368)까지 좁아져 두 개의
  띠가 거의 맞닿는다 — 캡처의 두 불릿이 정확히 그 경우다.
- 방향: 배경 띠 말고 코드를 표시할 다른 축(서체는 이미 Menlo 로 갈렸다)을 쓰거나, 띠를 쓸 거면
  RN 제약을 우회해서라도 좌우 여백과 낮은 높이를 만들 것.

**M-4. 불릿 목록의 마커 칸이 「10.」 을 위해 잡혀 있어서 「•」 에는 17pt 의 빈칸이 된다**

- 실측: 불릿 점 잉크 **x 2.0..5.0pt**(폭 3pt), 목록 텍스트 좌단 **x 22.0pt** → 점 오른쪽 끝부터
  텍스트까지 **17.0pt** 의 공백.
- 원인: `MessageBody.tsx:506-511` `listMarker: {minWidth: 18}` + `:504` `listItem: {gap: space.xs}`.
  주석은 "숫자 두 자리까지 흔들리지 않을 만큼"(:505)이라고 적었다.
- 그런데 지난 리뷰 N-3 이 지적한 반대편은 **미수리**다: 16pt 에서 "10." 은 ≈22pt 라 18pt 칸을
  넘는다(도출). 이번 캡처 fixture 에 순서 목록이 없어 그 쪽은 여전히 확인 불가다.
- 즉 하나의 `minWidth: 18` 이 **불릿에는 너무 넓고 두 자리 숫자에는 너무 좁다.** 에이전트 답변이
  목록으로 오는 것이 이 제품의 기본 형태이므로 밀도에 상시로 붙는 비용이다.
- 방향: 마커 종류에 따라 칸을 다르게 잡거나, 캡처 fixture 에 순서 목록을 넣어 두 경우를 한 장에서
  볼 수 있게 할 것.

**M-5. H-5 의 절반 — 색은 고쳤는데 「자리」는 그대로다**

- `ConversationScreen.tsx:700-740`: 두 고지 모두 여전히 `list` 슬롯의 **`Timeline` 위**에 있다.
- `atoms.tsx:457-466` `notice` = `marginVertical: space.md`(12×2) + `padding: space.md`(12×2) +
  headline 13pt + detail 12pt/18 → 고지가 뜨는 순간 타임라인이 **≈87pt**(도출) 줄고 읽던 자리가
  밀린다. 지난 리뷰 H-5 의 두 번째 논점("사람이 만진 인용은 화면 아래쪽인데 피드백은 맨 위에
  뜨고, 뜨는 순간 타임라인이 밀린다")은 닫히지 않았다.
- 닫기 버튼과 `onJumpLanded` 자동 소멸은 확실한 개선이다(`:733-739`, `:765`). 남은 것은 위치와
  밀어냄이다. **캡처 없음** — 사진으로 확인 못 함.

---

### [Nitpick]

- **N-1. 같은 동사에 두 낱말.** 시트는 「메시지 복사하기」(`MessageActionSheet.tsx:274`), 코드
  상자 머리줄은 「복사」(`MessageBody.tsx:293`, 캡처 x1110..1165 y492..520). M-2 가 시트를
  동사형으로 옮기면서 30pt 옆 형제가 반대편에 남았다. 「복사」는 iOS 편집 메뉴의 관례라 그
  자체로 틀린 게 아니고, 이제 **어느 쪽이 이 앱의 규칙인지**가 불분명하다는 것이 문제다.
- **N-2. 사람이 많을수록 줄이 어두워진다.** `u42-typing-one.png` 는 밝은 이름 조각(#f2f3f5,
  x51..133)을 갖는데 `u42-typing-many.png` 는 **#f2f3f5 가 0픽셀**이라 줄 전체가 #9aa0a8 이다.
  의도된 결과("집계엔 이름이 없다")지만, 결과적으로 **3명이 치는 줄이 1명이 치는 줄보다 시각적
  무게가 낮다.** 활동량과 무게가 역방향인 것을 의도로 볼지 결정할 것.
- **N-3. 카운터에 tabular figure 가 없다.** 「3명이 작성 중…」·「답글 3개」·반응 칩의 「3」·
  「총 2개」 — SKILL §2 는 카운터에 `.monospacedDigit()` 을 요구한다. RN 대응물
  (`fontVariant: ['tabular-nums']`)이 어디에도 없다. 작성 중 줄은 좌측 정렬이라 숫자 폭이
  바뀌면 뒤 문장 전체가 흔들린다. 전 앱 사안이라 이 배치의 죄는 아니다.
- **N-4. 코드 상자 안쪽 리듬이 비대칭이다.** `codeHead: {paddingTop: space.xs}`(4) vs
  `codeContent: {padding: space.sm}`(8) — 캡처에서 상자 위쪽 여백 13.0pt(테두리~「sh」 잉크),
  아래쪽은 8pt 패딩. 둘 다 스케일 위 값이라 규칙 위반은 아니고, 상자가 위로 무겁게 읽힌다.
- **N-5. 「sh」 언어 라벨이 상자 안에서 3.605:1 이다** (`codeLang: color.textFaint`,
  캡처 (30..60, 494..517) = #6b7280). 부속 표지라 본문 AA 를 요구할 자리는 아니지만,
  이 배치가 작성 중 줄을 같은 이유로 `textFaint` 에서 뺐다는 점에서 규율이 한 파일 안에서 갈린다.
- **N-6. 미수리 em dash 2건**(`MessageRow.tsx:386`, `:491`)이 세 PR 을 지나며 그대로다.
  지난 리뷰가 "이번 배치가 넣은 것이 아니다"로 기록만 했고, 이후 배치도 손대지 않았다.
  SKILL §2 는 이것을 이진 규칙으로 둔다.
- **N-7. 인용 fixture 가 자기 자신을 인용한다.** `measure/surfaces.tsx:180-186` 이 `MESSAGE`(저자=`SELF`)를 원본으로 삼아
  원본을 만들어 캡처에서 행 저자와 인용 저자가 둘 다 「곽성재」다(y255..285 / y320..349).
  그래서 이 사진들은 **"인용이 남의 목소리로 읽히는가"** 라는 H-2 의 핵심 질문에 답하지 못한다.
  같은 이름이 14pt 간격으로 두 번 쌓인 것으로 읽힌다.
- **N-8. 한 액션에 라벨이 둘.** 인용 점프의 로터 라벨은 「인용한 원본으로 이동」
  (`MessageRow.tsx:879`), 블록 자체의 `accessibilityLabel` 은 `QUOTE_JUMP_HINT`
  (`Quote.tsx:168`). 행이 한 원소라 후자는 접히지만, 같은 동작에 두 문장이 살아 있다.

---

## 4. 잘 된 것 (되돌리지 말 것)

- **인용의 무게가 실제로 내려갔다.** `u42-quote-ready.png` 를 눈 가늘게 뜨고 보면 순서가
  분명하다: 본문(#f2f3f5/16pt) → 인용 발췌(#9aa0a8/13pt, 10pt 안쪽) → 규정선(중성 2pt).
  H-2 가 노린 "인용은 참조이지 이 표면에서 가장 센 것이 아니다"가 사진에 있다.
- **격자가 정확하다.** 규칙 x=16.00pt, 인용 텍스트 x=26.00pt(16+2+8) — 파생값까지 스케일 위에
  떨어진다. 이번 배치 3개 파일에 스케일 밖 간격이 0건이다.
- **H-4 가 두 상태에서 다 맞는다.** 확정 코드 #f2f3f5, 보내는 중 코드 #9aa0a8 — 산문과 정확히
  같은 값. RN 에서 "색을 안 박는다"가 "상속된다"가 아니라는 것을 알고 명시 전달로 푼 판단이 옳다.
- **M-4 가 최소 개입으로 됐다.** 문장을 짓지 않고 조각만 다르게 칠했다. 집계에서는 칠할 것이
  없으니 안 칠한다 — 규칙이 데이터에서 나온다.
- **하네스에 인용을 행 안에 세운 결정**(`surfaces.tsx:163-176`). 이것 덕에 위 두 항목을
  픽셀로 판정할 수 있었다. 같은 판단이 마크다운에는 적용되지 않았다(M-1).
- **캡처 출처를 헤더로 확인하고 찍은 것**(`e19256c4` 커밋 본문, `X-React-Native-Project-Root`).
  이 리뷰가 사진을 증거로 쓸 수 있는 이유다.

---

## 5. 결론

```
Blocker  0
High     1  (H-1 한글 italic 무동작 + AA 미달 회색이 유일한 구분축)
Medium   5  (M-1 캡처 절반 · M-2 surface/pressed 충돌 · M-3 인라인 코드 띠 ·
             M-4 마커 칸 · M-5 고지 자리)
Nitpick  8

지난 리뷰 (도출) 시각 항목 8/8 픽셀 확인.
수리 9건 중 시각 확인 3건(H-2·H-4·M-4 계열), 코드만 확인 6건.
```

**Verdict: PASS(blockers: 0)** — 루브릭 통과선(Blocker 0 · High ≤2)을 만족한다.
사람 리뷰로 진행 가능.

다만 이 PASS 는 **본 캡처 7장이 담은 범위 안에서만** 참이다. 위상 1(인터랙션)·2(회전/키보드)·
4(VoiceOver·reduceMotion)·5(Dynamic Type·긴 이름·대량 메시지)는 여전히 SKIPPED 이고,
이번 배치가 고쳤다고 주장하는 것 중 H-1(로터)·H-3(자리 예약)·H-5(고지)·M-7(시트 스크롤)은
**정확히 그 SKIPPED 위상에 있다.**

다음 라운드에 사진 4장이면 남은 위상이 대부분 닫힌다:
① `typing-empty` (H-3 을 `typing-one` 과 나란히), ② `sheet` 재촬영 + 큰 접근성 글자 크기 변형
(M-7·M-2), ③ 인용 점프 실패 고지(H-5), ④ 행 눌림 상태(M-2 의 1.000:1 확인).
①②는 하네스에 이미 서 있거나 한 줄이면 선다.
