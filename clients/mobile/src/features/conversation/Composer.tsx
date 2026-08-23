import type {MessageAttachment, RosterMember} from '@momo/core/lib/api';
import {
  ATTACH_COPY,
  MAX_ATTACHMENTS_PER_MESSAGE,
  sendBlockCopy,
  sendBlockReason,
} from '@momo/core/features/attachments/model';
import {
  COMPOSER_OFFLINE_COPY,
  composerFieldLabel,
  composerPlaceholderClauses,
  fitComposerPlaceholder,
  type ComposerPlaceholderClause,
} from '@momo/core/features/chat/composerCopy';
import {attachParticle, type RecipientKind} from '@momo/core/lib/koreanParticle';
import type {Directory} from '@momo/core/features/workspace/directory';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
  type TextLayoutEventData,
} from 'react-native';
import {font, line, radius, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {usePalette, useStyles} from '../../design/theme';
import {clearDraft, readDraft, saveDraft} from './drafts';
import {
  applyMention,
  caretAfterChange,
  matchMembers,
  mentionQueryAt,
} from './mentionQuery';
import type {QuoteDraft} from '@momo/core/features/timeline/quote';
import {QuoteDraftBar} from './Quote';
import {AttachmentPickerSheet} from '../attachments/AttachmentPickerSheet';
import {AttachmentTray} from '../attachments/AttachmentTray';
import {
  addPickedFiles,
  attachmentSurfaceKey,
  clearSurface,
  dropDraft,
  retryDraft,
  setPickerIssue,
  takeSent,
  useAttachmentSurface,
  type AttachmentTarget,
} from '../attachments/draftStore';
import {pickDocument, pickPhoto} from '../attachments/picker';

// =============================================================================
// The composer.
//
// ## The one rule this file exists to keep: `value` is SYNCHRONOUS
//
// Spike #837 gate 1, measured on 성재's iPhone 17 (iOS 26.5.1). Five composer
// shapes were typed by hand with the standard and the 10-key Korean keyboards.
// Four produced `안녕하세요`. The fifth — identical except that it applied the
// value one tick late, `setTimeout(() => setValue(next), 0)` — produced
// `ㅇㅏㄴㄴㅕㅇㅎㅏㅅㅔㅇㅛ` on the standard keyboard and `ㅇ|·ㄴㄴ··|ㅇㅎ|·ㅅ·`
// on the 10-key. The deferred write severs iOS's composition session, and the
// jamo never combine at all.
//
// So: `onChangeText` calls `setText` and nothing else may come between a
// keystroke and the rendered value. No queue, no store round trip, no network,
// no debounce, no `useDeferredValue`. The send path is deliberately a SEPARATE
// rail — `onSend` is fired and never awaited, and the message's fate is the
// pending row's business, not this input's.
//
// The mention list is safe under that rule and was measured to be: gate 1 case
// C re-filtered and re-rendered a 60-member list on every keystroke DURING
// composition and still produced `안녕하세요`. Controlled input was never the
// problem; deferred value was.
//
// A guard is not enough to keep this true, so `__tests__/composerHangul.test.tsx`
// replays the exact keystroke transitions captured on the device and asserts the
// rendered `value` after each one, synchronously, with no act() flush between.
// An implementation that deferred the write fails it.
//
// **`onTyping` is the second thing to obey that rule** (ADR-0149). 「작성 중」 is
// a per-keystroke signal, which is exactly the shape that could break composition
// — so it is fired the way `onSend` is: AFTER the value is written, never
// awaited, and never allowed to decide anything about `value`. What it costs a
// keystroke is one function call; everything expensive (the grant, the 3s
// republish cadence, the POST) lives in the surface that owns the channel, for
// the same reason the send does.
//
// ## Enter is a newline here, and there is a send button
//
// The core's `composerKeyIntent` exists so the web client can send on Enter
// without stealing the Enter that commits an IME composition. Its own contract
// says a phone passes `enterSends: false`: a software keyboard has no
// Shift+Enter, so sending on Enter would delete multi-line writing entirely.
// With Enter never sending, the IME-Enter collision cannot arise on this
// client, so the hook is not wired — the button is the only send.
//
// ## 성장 정책 — 실측하고 나서 이름만 붙였다 (감사 H-10 폰 몫)
//
// 감사가 웹에서 잡은 결함(`Math.min(MAX_ROWS, text.split("\n").length)` — 하드
// 개행만 세므로 길게 감긴 한 줄 문단은 상자가 안 자란다)은 **이 클라에는
// 없다.** RN 의 `multiline` `TextInput` 은 자기 콘텐츠 높이로 자라고, 감긴 줄도
// 콘텐츠다. 즉 여기서 고칠 것은 성장 자체가 아니라 그 성장의 **상한이 어디서
// 나온 숫자인지**였다.
//
// 옛 상한은 `120` 한 줄짜리 상수였고 아무 곳에서도 도출되지 않았다. 지금은
// 「몇 줄까지 자라는가」를 선언하고 나머지를 계산한다:
//
//   MAX_ROWS(5) × line.body(22) + 위아래 패딩(8·8) + 테두리(1·1) = 128
//
// 도출식으로 두는 값이 실제로 있다: `line.body` 는 이 표면이 본문 한 줄에 대해
// 이미 선언한 상자이고(u44 리뷰 M-2 가 세운 스케일), 입력창의 글자도 `font.body`
// 다. 옛 판은 그 옆에서 `lineHeight: 21` 이라는 스케일 밖 숫자를 따로 들고
// 있었다 — 같은 크기 글자가 화면의 다른 자리에서 다른 줄 상자를 쓰던 자리다.
//
// 상한을 넘으면 상자는 자라기를 멈추고 **안에서 스크롤한다**(RN `multiline` 의
// 기본값). 대신 자라지 않는다는 사실이 화면 밖으로 나가지 않게, 상한은 키보드가
// 올라온 상태에서도 목록이 남는 크기로 잡았다.
//
// ## 그 상한이 **글자를 안 따라갔다** (#1443, #1422 이월)
//
// 위 식의 `line.body` 는 22 라는 **고정 토큰**이다. 그런데 화면에 그려지는 줄
// 상자는 고정이 아니다 — RN(iOS)은 선언된 `lineHeight` 에 동적 타입 배수를 곱한다
// (`RCTAttributedTextUtils.mm`: `textAttributes.lineHeight *
// RCTEffectiveFontSizeMultiplierFromTextAttributes(...)`). 즉 글자가 커지면 줄
// 상자도 같이 커지는데 상한만 128pt 에 못 박혀 있었고, 그래서 큰 글자에서 상자는
// **두 줄도 못 담았다**.
//
// 실측(iPhone 17 Pro / iOS 26.5, `accessibility-extra-extra-large` = 글자 배수
// **3.143**, `measure/captures/clause1422-composer-placeholder-a11y-*`):
//
//   줄 상자 22 × 3.143 = **69.1pt** · 옛 상한 128pt 의 글 칸 110pt ⇒ **1.6줄**
//
// 화면에 서는 것은 한 줄뿐이었다(「일반에」·「release-2」). 이것은 플레이스홀더의
// 문제가 아니다 — **사람이 친 글도 같은 상한에 걸린다.** #1422 는 이 띠를 사진과
// 이름으로만 남기고 갔고(그 배치의 범위는 카피였다), 이 파일이 그 주인이다.
//
// ## 상한의 **단위**가 바뀐다 — 줄 수에서 열의 몫으로
//
// 「5줄」은 값이 아니라 **기본 크기에서의 답**이었다. 그 뒤에 있던 진짜 불변식은
// 위 문단이 이미 적어 두었다: *키보드가 올라온 상태에서도 목록이 남는다.* 기본
// 크기에서는 둘이 같은 답을 준다(128pt = 874pt 창의 14.6%). 동적 타입에서는
// 갈라진다:
//
//   5줄을 그대로 지키면  5 × 69.1 + 18 = **363.7pt** = 창(874)의 **41.6%**
//   키보드가 올라오면    874 - 336(하네스가 든 실측 상수) - 363.7 = 174pt
//                        — 헤더를 빼면 목록에 남는 것은 **한 줄도 안 된다**
//
// 그래서 줄 수는 기본 크기의 상한으로 남고, 큰 글자에서는 **남는 열의 몫**이
// 상한을 진다. 몫은 실측에서 나온다: 키보드가 창의 38%(336/874)를 가져가고, 남는
// 열을 입력창과 목록이 나눠 갖는데 **입력창이 그 절반을 넘으면 목록이 입력창보다
// 작아진다** — 거기가 「대화가 남는다」가 거짓이 되는 자리다.
//
// ## 그 「남는 열」은 창이 아니다 — **대화 열**이다 (리뷰어 C M-1)
//
// 첫 판의 식은 `창 × (1 − 0.38) × 0.5` 였고, 그 식이 든 불변식은 위 문단의
// 「목록이 입력창보다 작아지지 않는다」였다. **창은 목록이 아니다.** 창의 위쪽에는
// 목록이 한 줄도 못 쓰는 띠가 둘 있고, 둘 다 이 화면이 언제나 지고 있다:
//
//   세이프 에리어 위쪽(Dynamic Island)   `Screen` 의 `paddingTop` — 실측 62.0pt.
//   `ScreenHeader`                       실측 **131.3pt**(AX-XXL). 글자를 따라
//                                        커지고, 커지는 주범은 제목이 아니라
//                                        뒤로 글리프다(`backGlyph` 의
//                                        `lineHeight: 34` × 3.143 = 106.9).
//
// 그 둘을 안 뺐으므로 첫 판의 산수는 자기 측정 지점에서 이미 거짓이었다: AX-XXL
// 상한 270.9pt 옆에서 목록에 남는다고 적힌 267pt 는 **크롬을 포함한 값**이었고,
// 실제로 대화가 서는 자리는 267 − 193.3 = **73.8pt** — 줄 상자 69.1pt 짜리 한
// 줄이고, 입력창 271pt 의 4분의 1이다. 리뷰어 C 가 잡은 것이 그것이고, 산수가
// 뺀 적 없는 것을 뺐다고 적어 두면 그 다음 사람은 사진을 봐도 그 사실을 못 읽는다.
//
// 그래서 크롬도 몫으로 **이름을 얻는다**(`CONVERSATION_CHROME_WINDOW_SHARE`,
// 0.38 과 같은 규율 — 실측에서 나오고 실측 출처를 자기 독스트링에 든다):
//
//   상한 = max( 2줄, min( 5줄, 창 × (1 − 0.38 − 0.23) × 0.5 ) ) + 크롬
//
// 이제 불변식이 **산수로** 참이다: 같은 열에서 목록이 받는 것과 입력창이 받는 것이
// 같은 절반이고, 크롬은 둘 중 누구의 절반에서도 안 나온다. AX-XXL 실측으로
// 대화 열 340.9 = 목록 170.4 + 입력창 170.4 이고, 화면에서 목록이 실제로 받는
// 것은 874 − 336 − 193.3 − 170.4 = **174.3pt** — 모델이 크롬을 올려 잡은 만큼
// 목록 쪽으로 남는다(틀리는 방향이 그쪽이어야 한다는 것이 그 상수의 규율이다).
//
// 대가는 큰 글자에서 상한이 준다는 것이다(첫 판 270.9 → **170.4pt**, 1.6줄 →
// 2.2줄). 그 거래를 고른 이유는 상한이 클수록 좋은 값이 아니라 **목록과 나눠 갖는
// 값**이기 때문이다 — 목록이 사라지면 이 상자는 자기가 무엇에 답하고 있는지 안
// 보여 준다.
//
// 기본 크기에서는 여전히 **몫이 한 번도 안 걸린다**: 걸리려면 창이 656pt 아래여야
// 하는데(128 ÷ 0.195) iOS 26 이 도는 가장 작은 아이폰이 667pt 다. 지금 화면은
// 하나도 안 변한다(`composerDraftOffline.test.tsx` 가 그 자리를 잰다).
//
// ## 이 식이 **안** 재던 것 — 액세서리와 `@` 시트 (#1480 이 절반을 받았다)
//
// 도크에는 입력창 말고도 서는 것이 있다: 인용 바·타이핑 바·에이전트 활동 바, 그리고
// 이 파일 자신의 멘션 후보 시트. 전부 **한때만** 서고, 위 상한은 쉬는 상태의
// 계약이다. 그중 시트는 같은 가족의 결함을 자기 안에 갖고 있었다 — `maxHeight: 180`
// 은 고정 pt 라 큰 글자에서 담는 행 수가 줄고, 열려 있는 동안 목록을 그만큼 더
// 먹었다. **#1480 이 그것을 받았다**: 아래 「시트의 상한」 절이 결정(넷)과 그것이
// 지는 불변식(도크가 대화 열을 안 넘는다)을 든다.
//
// 그 티켓이 함께 잡은 것이 위 산수의 구멍 하나다: 도크는 시트와 입력창 말고
// **`styles.bar` 의 위아래 여백**도 진다(`DOCK_CHROME`). 이 절이 열을 나눌 때 그
// 16pt 를 안 셌으므로, 시트가 열린 화면에서는 「도크 ≤ 대화 열」이 모델 안에서도
// 거짓이었다(AX-XXL: 180 + 170.4 + 16 = 366.4 vs 340.9).
//
// **남은 절반은 액세서리 바들이다.** 인용·타이핑·ADE 요약 줄은 여전히 이 식 밖에
// 있고, 셋이 동시에 서는 화면은 아직 아무도 재지 않았다. 시트와 달리 그것들은
// 「몇 개를 보여 주는가」 결정이 없어(있으면 한 줄이다) 같은 처방이 안 붙는다.
//
// 사진은 넷이고 레인은 `scripts/measure.sh` 의 `COMPOSER-GROWTH` 다. 계측 줄이
// 글자 배수·창·**크롬 실측**·상한·목록 몫·실제 상자 높이를 사진 안에 적으므로 이
// 문단의 산수가 화면에서 확인된다:
//
//   grow1443-composer-growth-a11y-before-dark.png  옛 상한 — 128.0pt = 1.6줄
//   grow1443-composer-growth-a11y-{dark,light}.png 새 상한 — 170.4pt = 2.2줄
//   grow1443-composer-growth-dark.png              기본 크기 — 128.0pt = 5.0줄
//                                                  (다섯 줄이 그대로 다 보인다)
// =============================================================================

/**
 * 입력창이 자라는 최대 줄 수. 넘으면 상자는 그대로 있고 안에서 스크롤한다.
 *
 * 다섯인 이유: 이 제품에서 한 번에 보내는 글은 대부분 한두 줄이고, 다섯 줄이면
 * 문단 하나를 통째로 보면서 고칠 수 있다. 그 위는 목록을 먹기 시작한다 —
 * 키보드가 올라와 있을 때 대화가 보이는 높이는 이 상한이 정한다.
 *
 * **줄 수이지 높이가 아니다.** 큰 글자에서 이 다섯이 그대로 지켜지면 상자가 창의
 * 41.6% 가 되므로, 거기서는 아래 세 몫(`KEYBOARD_WINDOW_SHARE` ·
 * `CONVERSATION_CHROME_WINDOW_SHARE` · `COMPOSER_COLUMN_SHARE`)이 정하는 상한이
 * 먼저 걸린다.
 */
const MAX_ROWS = 5;

/**
 * 상한이 절대로 내려가지 않는 줄 수. **쓰고 있는 줄과 그 앞 줄** — 그 아래로는
 * 고쳐 쓰기가 한 줄 창이 되고, 한 줄 창은 자기가 무엇을 지웠는지 안 보여 준다.
 *
 * **가장 작은 창에서 가장 큰 글자를 고르면 걸린다** — 그리고 그때 이 바닥이 위
 * 불변식을 이긴다(SE 667pt · AX-XXL: 몫 130.1pt < 바닥 156.3pt). 그것이 의도다:
 * 「목록이 입력창보다 크다」는 좋은 화면의 조건이고, 「쓰고 있는 줄이 보인다」는
 * 쓸 수 있는 화면의 조건이다. 조건이 부딪히면 뒤가 이긴다.
 *
 * 첫 판의 이 자리에는 「오늘 배송되는 어느 기기에서도 안 걸린다」고 적혀 있었다.
 * 창 몫이 크롬을 안 빼던 때의 산수였고, 크롬을 빼면 그 문장은 위처럼 좁아진다.
 */
const MIN_ROWS = 2;

/** 입력창 상하 패딩 한쪽. 상한 계산과 실제 스타일이 같은 값을 읽는다. */
const INPUT_PAD_Y = space.sm;

/**
 * 입력창 좌우 패딩 한쪽. 위와 짝이고, 이름을 갖는 이유가 하나 더 있다 — 절 예산의
 * 프로브가 **글이 놓이는 가로**를 이 값으로 도출한다(#1479).
 */
const INPUT_PAD_X = space.md;

/** 입력창 테두리 두께. 위와 같은 이유로 이름을 갖는다. */
const INPUT_BORDER = 1;

/**
 * 키보드가 창에서 가져가는 몫. 336/874 — 한국어 키보드, iPhone 17 Pro 실측
 * (`measure/harness.tsx` 의 `KEYBOARD_HEIGHT_PT` 가 든 그 숫자).
 *
 * 비율로 두는 이유는 이 값이 기기마다 다르고 이 파일이 기기를 모르기 때문이다.
 * 비율은 화면 크기를 건너 거의 안 변한다(SE 260/667 = 39%).
 */
const KEYBOARD_WINDOW_SHARE = 0.38;

/**
 * 대화 열 **위**의 크롬이 창에서 가져가는 몫 — 세이프 에리어 위쪽과 헤더 (리뷰어
 * C M-1).
 *
 * 이 항이 없던 첫 판은 창 전체를 목록과 입력창이 나눠 갖는 것처럼 셌고, 그래서
 * 「목록이 입력창보다 크다」가 자기 측정 지점에서 거짓이었다. 머리말에 산수가 있다.
 *
 * 값의 출처는 실측이다(iPhone 17 Pro / iOS 26.5, `measure/` 의 `composer-growth`
 * 계측 줄이 **매 캡처마다 다시 잰다** — 배송되는 `ScreenHeader` 를 세워
 * `onLayout` 으로, 세이프 에리어는 `useSafeAreaInsets()` 로):
 *
 *   세이프 에리어 위쪽  62.0pt — 창 크기와 무관한 상수.
 *   `ScreenHeader`      131.3pt (AX-XXL). 짐작보다 두꺼운 이유는 제목이 아니라
 *                       **뒤로 글리프**다: `backGlyph` 가 `lineHeight: 34` 를
 *                       선언하고 RN(iOS)이 거기에 배수를 곱한다(34 × 3.143 =
 *                       106.9) — 제목(18 × 3.143)이 지는 것보다 크다.
 *   합                  193.3/874 = **22.1%** (AX-XXL)
 *
 * **큰 쪽으로 올려 잡는다.** 이 항이 실제로 걸리는 것은 큰 글자에서뿐이고(기본
 * 크기에서는 줄 수 상한이 먼저 걸린다), 크롬을 적게 세면 입력창이 커지면서
 * 불변식이 다시 거짓이 된다 — 틀리는 방향이 대칭이 아니다. 0.23 은 그 22.1% 를
 * 올림한 값이고, 남는 여유는 이 화면이 **때때로** 더 지는 것들에 간다: 레일이
 * 끊겼을 때 서는 헤더 부제(`railSubtitle`)와 살아 있는 작업이 있을 때 서는
 * `AdeSummaryLine` 한 줄. 둘 다 쉬는 상태에는 없으므로 값에 넣지 않는다.
 */
const CONVERSATION_CHROME_WINDOW_SHARE = 0.23;

/**
 * 키보드와 크롬을 뺀 **대화 열**에서 입력창이 가져갈 수 있는 최대 몫. **절반이다**
 * — 넘는 순간 목록이 입력창보다 작아지고, 그때 「키보드가 올라와도 대화가
 * 남는다」는 말이 거짓이 된다.
 */
const COMPOSER_COLUMN_SHARE = 0.5;

/**
 * 상한과 실제 상자가 함께 지는 세로 크롬(패딩·테두리). 글자를 안 따라간다.
 *
 * **export 되는 이유는 `composerMaxHeight` 과 같다** (회전 1 M4): 이 수는 계측
 * 하네스와 테스트에도 필요한데, 셋이 각자 `space.sm * 2 + 2` 를 적고 있었다.
 * 사본은 조용히 어긋나고, 어긋난 사본이 낸 초록은 배송되는 상자를 안 잰다
 * (디자인 시스템 §5.5).
 */
export const INPUT_CHROME = INPUT_PAD_Y * 2 + INPUT_BORDER * 2;

/** 같은 것의 가로 몫. 상자의 바깥 폭에서 이만큼을 빼면 글이 놓이는 폭이다. */
export const INPUT_CHROME_X = INPUT_PAD_X * 2 + INPUT_BORDER * 2;

/**
 * 자라기를 멈추는 높이 — **두 상한 중 작은 것**, 그리고 바닥은 두 줄.
 *
 * `fontScale` 은 `useWindowDimensions()` 가 주는 동적 타입 배수이고, 그것이 곧
 * 화면의 줄 상자를 정하는 그 수다(위 머리말의 `RCTAttributedTextUtils` 인용).
 * `windowHeight` 는 목록이 남을 자리를 정한다.
 *
 * 이름이 있고 export 되는 이유: 같은 산수를 계측 하네스와 테스트가 **다시 적지
 * 않고** 읽는다. 사본을 두면 사본이 거짓말한다(디자인 시스템 §5.5).
 */
export function composerMaxHeight(
  fontScale: number,
  windowHeight: number,
): number {
  const row = line.body * fontScale;
  const byRows = MAX_ROWS * row + INPUT_CHROME;
  const byWindow = conversationColumn(windowHeight) * COMPOSER_COLUMN_SHARE;
  return Math.max(MIN_ROWS * row + INPUT_CHROME, Math.min(byRows, byWindow));
}

/**
 * 키보드가 올라와 있는 동안 **목록과 입력창이 나눠 갖는 세로**. 창에서 키보드와
 * 그 위 크롬을 뺀 것이고, 위 두 몫이 뜻하는 바가 이 한 줄이다.
 */
function conversationColumn(windowHeight: number): number {
  return (
    windowHeight *
    (1 - KEYBOARD_WINDOW_SHARE - CONVERSATION_CHROME_WINDOW_SHARE)
  );
}

/**
 * 상한이 걸렸을 때 **이 창이 무엇을 무엇에 주는가** — 사진과 테스트가 같은 답을
 * 읽는 자리 (리뷰어 C M-1).
 *
 * 있는 이유는 `composerMaxHeight` 이 있는 이유와 같다: 첫 판의 결함은 식이 아니라
 * **식에 대한 주장**이었고(「목록에 267pt 가 남는다」), 그 주장을 아무도 다시
 * 계산하지 않았다. 이제 주장이 값이다 — 계측 하네스가 이것을 사진에 적고
 * (`measure/surfaces.tsx` 의 `GrowthProbe`), 테스트가 이것으로 불변식을 단정한다.
 */
export interface ComposerColumnBudget {
  /** 키보드가 가져가는 몫. */
  readonly keyboard: number;
  /** 대화 열 위의 크롬(세이프 에리어 + 헤더). */
  readonly chrome: number;
  /** 남는 열 — 목록과 입력창의 몫을 합한 것. */
  readonly column: number;
  /** 그 열에서 입력창이 가져가는 것(= `composerMaxHeight`). */
  readonly composer: number;
  /**
   * 그 열에서 입력창이 **안** 가져가는 것 — `column − composer`.
   *
   * 이름이 「목록」이지만 시트가 열려 있는 동안 목록이 실제로 받는 것은 이보다
   * 작다: 거기서 `dockChrome` 과 `mentions` 가 또 나온다(도크 = 시트 + 입력창 +
   * 도크 크롬). 즉 이 필드는 **목록의 상한**이고, 시트가 쉬는 상태의 답이다.
   * 등식을 안 고치고 서술만 고치는 이유는 아래 두 필드가 더한 것이지 고친 것이
   * 아니기 때문이다 — `column = list + composer` 는 #1443 의 것이고 그대로다.
   */
  readonly list: number;
  /**
   * 도크가 시트·입력창 **말고** 지는 세로 (#1480). 위 `column` 은 이 항을
   * 안 뺀 값이고, 그것이 이 필드가 따로 있는 이유다 — `column = list + composer`
   * 라는 #1443 의 등식을 고치지 않고 도크의 산수만 정확해진다.
   */
  readonly dockChrome: number;
  /** 시트가 열렸을 때 시트가 가져가는 것(= `mentionSheetMaxHeight`). */
  readonly mentions: number;
}

export function composerColumnBudget(
  fontScale: number,
  windowHeight: number,
): ComposerColumnBudget {
  const column = conversationColumn(windowHeight);
  const composer = composerMaxHeight(fontScale, windowHeight);
  return {
    keyboard: windowHeight * KEYBOARD_WINDOW_SHARE,
    chrome: windowHeight * CONVERSATION_CHROME_WINDOW_SHARE,
    column,
    composer,
    list: column - composer,
    dockChrome: DOCK_CHROME,
    mentions: mentionSheetMaxHeight(fontScale, windowHeight),
  };
}

// =============================================================================
// 시트의 상한 — 「후보를 몇 개 보여 주는가」 (#1480)
//
// ## 옛 값이 무엇이었나
//
// `maxHeight: 180`. 어디서도 도출되지 않은 상수였고 두 가지가 틀렸다.
//
// **① 글자를 안 따라간다.** 위 상한이 #1443 에서 고친 것과 같은 결함이다 — 행은
// 글자를 따라 커지는데(아래 `mentionRowHeight`) 상한만 180 에 못 박혀 있으니, 큰
// 글자에서 담는 후보 수가 조용히 준다.
//
// **② 열려 있는 동안 대화를 먹는다.** 도크(시트 + 입력창 + `styles.bar` 여백)가
// 키보드 위 가시 열을 넘었다. AX-XXL / 874pt 창 실측 산수:
//
//   시트 180 + 입력창 170.4 + 바 여백 16 = **366.4pt**
//   대화 열 874 × (1 − 0.38 − 0.23)      = **340.9pt**
//
// 25.5pt 가 초과이고, 초과분은 타임라인에서 나온다 — 「키보드가 올라와도 대화가
// 남는다」가 시트가 열린 동안 거짓이 되는 자리다.
//
// ## 결정 — **넷**
//
// 티켓이 요구한 「몇 개를 보여 주는가」의 답이고, **오늘도 넷이었다**: 기본 크기의
// 180pt 가 담던 것은 4행(4 × 44 = 176)과 **다섯째 행의 이마 4pt** 였다. 그 4pt 가
// 화면에서 하는 일은 이름의 윗동을 보여 주는 것 하나이고, 이 레포는 그 반노출을
// 웹에서 이미 한 번 닫았다(#1418 의 `composer-placeholder` `1lh` 클램프). 그러니
// 넷은 새 결정이 아니라 **옛 값의 뜻**이다.
//
// 넷인 이유는 **재서 나온다.** 첫 판의 이 자리에는 「`matchMembers` 가 이미 정렬해
// 첫 줄을 최선으로 만든다」고 적혀 있었는데, 그것은 참이 아니다 —
// `mentionQuery.ts` 의 그 함수는 `status === 'active'` 로 거르고 부분일치로 거르고
// `.slice(0, limit)` 할 뿐 **정렬하지 않고**, `makeDirectory` 도 members 를 그대로
// 통과시킨다(`packages/momo-core/.../directory.ts`). 첫 줄은 로스터가 도착한 순서다.
// 그래서 근거를 목록의 성질이 아니라 **관측되는 두 수**에 댄다:
//
//   ① 오늘 배송되는 값이 담던 정수 행이 넷이다 — 180 = 4 × 44 + 4.
//   ② 기준 창(874pt · 기본 크기 — 캡처를 찍는 그 기기)에서 **열이 허락하는 최대
//      정수 행**이 정확히 넷이다:
//
//        목록 몫 340.9 − 입력창 128.0 − 도크 크롬 16.0 = 196.9pt
//        ⌊196.9 ÷ 44⌋ = 4          (다섯 행은 220pt 라 안 든다)
//
// 둘이 같은 수를 가리키므로 이 배치는 「몇 개를 보여 주는가」를 **안 바꾼다** —
// 바꾸는 것은 다섯째 행의 이마 4pt 와, 큰 글자에서 열을 넘던 초과분이다.
//
// 그리고 상한이 **실제로 무는 창은 큰 것들뿐이다**: **배수 1 에서** 열이 다섯
// 행을 허락하려면 창이 933pt 를 넘어야 하고(⌊(h × 0.39 − 128 − 16) ÷ 44⌋ ≥ 5),
// 그 조건을 만족하는 배송 높이는 956 · 1024 · 1032 · 1180 · 1366 이다(가장 큰
// 아이폰과 아이패드들 — 테스트가 그 목록을 값으로 든다). **문턱은 배수를 따라
// 움직인다**: 사다리 아래쪽에서는 입력창이 작아져 열이 더 일찍 다섯 행을 허락하고
// (0.823 에서 883.5pt — 926 도 문다), 위쪽에서는 늦어져 3.571 에서는 어느 배송
// 높이도 안 문다. 933 을 한정 없이 적으면 그 움직임이 안 보인다(회전 2). 상한이
// 무는 자리에서 넷이 하는 일은 도크가 창 크기를 따라 메뉴로 자라지 않게 잡는
// 것이다. 그 아래에서는 열이 먼저 물고, 그 위는 스크롤이 받는다(시트는
// `ScrollView` 다).
//
// **이 결정은 표면 한정이다.** 웹은 같은 물음에 다르게 답한다 — 상한 없이
// `MENTION_LIMIT`(6) 을 전부 띄운다(`clients/web/src/features/chat/Composer.tsx`).
// 다른 답이 정당한 이유는 기제가 달라서다: 웹의 팝오버는 `absolute bottom-full`
// 이라 대화 열을 **안 먹고**, 그래서 「도크 ≤ 대화 열」이라는 이 절의 불변식 자체가
// 거기서는 걸리지 않는다. 이 넷은 열을 나눠 갖는 표면의 답이지 제품 전체의 답이
// 아니다.
//
// ## 그 넷이 열을 넘을 때 — 열이 이기고, **행 단위로** 이긴다
//
//   상한 = max( 2행, min( 4행, ⌊(목록 몫 − 도크 크롬) ÷ 행⌋ × 행 ) )
//
// 가운데 항이 위 ②의 불변식을 **산수로** 참으로 만든다: 시트 ≤ 목록 몫 − 도크
// 크롬 ⟺ 시트 + 입력창 + 도크 크롬 ≤ 대화 열.
//
// 바닥이 아니라 **내림**이 이 식의 두 번째 요점이다. 열이 3.5행을 허락한다고
// 3.5행을 주면 넷째 이름이 이마만 내놓고 잘리고, 그것이 정확히 위에서 옛 값 180 을
// 기각한 그 이유다 — 상한을 도출로 바꾸면서 같은 결함을 다른 크기에 다시 심을
// 수는 없다. 실측으로 잡았다: 내림이 없던 첫 판은 a11y-large 에서 154.4pt(=3.5행)
// 를 내고 사진 아래쪽에 넷째 이름의 윗동을 남겼다 — 옛 값 180 의 사진
// (`dock1480-mention-sheet-ax-before-dark.png`, 4.1행)이 같은 결함을 지금도
// 들고 있으니 나란히 놓으면 보인다. 즉 **시트는 언제나 정수 행**이고, 남는
// 자투리는 타임라인으로 간다.
//
// 바닥은 위 `MIN_ROWS` 와 같은 논리다 — 한 행짜리 시트는 「고를 것이 있다」만
// 알려 주고 무엇인지는 안 보여 준다. 가장 작은 창 · 가장 큰 글자에서는 그 바닥이
// 불변식을 이기고, 그것이 의도다(`composerMaxHeight` 의 `MIN_ROWS` 가 같은
// 자리에서 같은 이유로 이긴다). **그 띠는 값으로 세어 뒀다** —
// `composerDraftOffline.test.tsx` 의 `FLOOR_WINS` 가 사다리 전수 × 기기 전수에서
// 거짓인 **네** 자리(667×3.143 · 667×3.571 · 736×3.571 · 744×3.571)와 각각의
// 초과분을 든다. 넷 다 옛 고정 180 이 훨씬 더 넘던 자리다(92.2 · 111.0 · 84.1 ·
// 81.0 → 6.5 · 38.1 · 11.2 · 8.1). 736(iPhone 8 Plus)이 그 목록에 있는 이유는
// 이 앱의 배포 하한이 **iOS 16.4** 라서다(`project.pbxproj` 여섯 구성 전부) —
// 「iOS 26 이 도는 기기」로 격자를 세우면 이 한 자리가 통째로 안 보인다(회전 2 M2).
// 그리고 목록으로 닫히는 것은 아이폰까지다: `UIRequiresFullScreen` 이 없어
// 아이패드 멀티태스킹 창 높이는 연속값이라 어떤 목록도 전수가 못 된다. 그 몫은
// 표가 아니라 **기제 단정**이 진다 — 「도크가 열을 넘었다면 시트는 반드시 바닥에
// 앉아 있다」가 격자와 무관하게 참이고, 테스트가 그것을 촘촘한 연속 쓸이로 든다.
//
// ## 이 불변식이 **지키는 것**과 안 지키는 것 (design-review 회전 1 M2)
//
// 이름은 「키보드가 올라와도 대화가 남는다」에서 왔지만, 시트가 열린 동안 그
// 문장이 참인 띠는 **없다.** 874pt 창 실측 — 열에서 도크를 뺀 여유가 배수 1.000
// 에서 20.9pt, 2.643 에서 22.4pt, 3.143 에서 13.0pt 인데 본문 한 줄은 각각
// 22.0 / 58.1 / 69.1pt 다. 어느 크기에서도 한 줄이 안 남는다.
//
// 그래서 이 절은 불변식을 다시 정하지 않고 **이름을 정확히 한다**: 「도크 ≤ 대화
// 열」이 지키는 것은 *도크가 열 밖으로 안 나간다*이고, 「대화가 남는다」는 시트가
// **쉬는** 상태의 약속이다(그때 목록 몫은 `ComposerColumnBudget.list` — 874pt
// 기본 크기에서 212.9pt = 본문 9.7줄). 시트는 `@` 토큰을 치는 동안에만 서므로 그
// 분리가 화면과 맞는다.
//
// 문턱을 타임라인이 실제로 보여 줄 수 있는 것(한 줄)에 대고 다시 정하는 안은
// 기각했다: 시트를 한 행 더 깎거나 입력창을 깎아야 하는데, 앞은 「고를 수 있는
// 화면」을, 뒤는 「쓰고 있는 줄이 보이는 화면」을 판다 — 둘 다 이 파일이 이미
// 위에서 더 비싸다고 판정한 것들이다. 대신 **여유를 사진에 적는다**
// (`measure/surfaces.tsx` 의 `MentionSheetProbe`): 판정만 찍고 여유를 안 찍으면
// 다음 사람은 이 문단을 다시 손으로 계산해야 한다.
//
// 기본 크기에서는 몫이 한 번도 안 걸린다: 874pt 창에서 목록 몫 212.9 − 16 = 196.9
// 이고 4행은 176 이다. **화면이 4행 그대로다** — 사라지는 것은 이마 4pt 뿐이다.
// =============================================================================

/**
 * 도크가 시트·입력창 **말고** 지는 세로 — `styles.bar` 의 위아래 여백 (#1480).
 *
 * 상수로 이름을 갖는 이유는 `INPUT_CHROME` 과 같다: 산수와 실제 스타일이 같은 값을
 * 읽어야 하고, 사본을 두면 사본이 거짓말한다(디자인 시스템 §5.5).
 */
const DOCK_CHROME = space.sm * 2;

/** 시트가 담는 후보 수. 위 절이 이 넷을 고른 이유를 든다. */
const MENTION_MAX_ROWS = 4;

/** 시트가 절대로 그 아래로 안 내려가는 행 수 — 고른 것과 그 옆의 것. */
const MENTION_MIN_ROWS = 2;

/**
 * 행 끝의 표지 — **눈과 스크린리더가 같은 문자열을 든다** (design-review 회전 2 M3).
 *
 * 상수인 이유는 사본이 갈라졌기 때문이다: 표지는 행에 그려져 있는데
 * `accessibilityLabel` 은 이름과 핸들만 들었고, `Pressable` 의 기본
 * `accessible={true}` 가 그 라벨로 자식들을 덮는다. 그래서 화면에서는 파란 이름과
 * 표지로 갈라져 있는 두 종류가 VoiceOver 에서는 **똑같이** 읽혔다 — 에이전트를 1급
 * 멤버로 세우는 제품에서 「이 후보가 사람인가 에이전트인가」는 부수 정보가 아니다.
 *
 * 어휘가 하나뿐인 것도 이 상수가 사는 이유다: 표지는 `kind === 'agent'` 일 때만
 * 서고 그때 문자열은 언제나 이것이라, 두 자리에 각자 적으면 사본이 조용히 갈라진다
 * (디자인 시스템 §5.5).
 */
const MENTION_AGENT_KIND = '에이전트';

/**
 * 후보 한 행의 세로.
 *
 * `TOUCH_TARGET` 은 **바닥이지 값이 아니다.** 행에 서는 두 조각(이름 `font.label`
 * 13 · 핸들 `font.meta` 12)은 한 줄로 읽혀야 하고, 그래서 둘 다 `line.head` 를
 * **선언한다**(그 토큰이 존재하는 이유이고, 선언하지 않으면 RN 이 광학 중심으로
 * +2.67pt 어긋나게 놓는다 — `tokens.ts` 의 `line.head` 실측). 화면에 그려지는 줄
 * 상자는 거기에 동적 타입 배수가 곱해진 것이므로(`RCTAttributedTextUtils`), 큰
 * 글자에서는 그 값이 44 를 넘고 그때부터 행이 그것이다.
 */
export function mentionRowHeight(fontScale: number): number {
  return Math.max(TOUCH_TARGET, line.head * fontScale);
}

/**
 * 시트가 자라기를 멈추는 높이 — **넷, 그리고 열이 허락하는 만큼.**
 *
 * `composerMaxHeight` 과 같은 모양이고 같은 이유로 export 된다: 계측 하네스와
 * 테스트가 이 산수를 **다시 적지 않고** 읽는다.
 */
export function mentionSheetMaxHeight(
  fontScale: number,
  windowHeight: number,
): number {
  const row = mentionRowHeight(fontScale);
  const byColumn =
    conversationColumn(windowHeight) -
    composerMaxHeight(fontScale, windowHeight) -
    DOCK_CHROME;
  // 열이 허락하는 것을 **행으로 내림**한다 — 반쪽 행은 이름의 이마만 보여 준다.
  const rowsByColumn = Math.floor(byColumn / row);
  return Math.max(
    MENTION_MIN_ROWS * row,
    Math.min(MENTION_MAX_ROWS, rowsByColumn) * row,
  );
}

// =============================================================================
// `hangul-word` 가 손 못 대는 축 — **라틴 낱말** (#1443, #1422 이월 ②)
//
// #1422 의 접근성 캡처에서 잘린 첫 줄은 「release-2」였다. 한국어 쪽은 이미
// 처방이 있다(`lineBreakStrategyIOS="hangul-word"`, 아래 입력창). 그 전략은
// **한국어 어절**을 지키는 것이라 `release-2026-08` 같은 라틴 토큰에는 아무 일도
// 하지 않는다 — 그리고 그것은 짐작이 아니라 실측이다.
//
// 계측(iPhone 17 Pro / iOS 26.5, AX-XXL, 글폭 206pt 상자에 같은 문장,
// `onTextLayout` 이 돌려주는 줄 텍스트 그대로):
//
//   hangul-word  release-2 | 026-08 | 에 메시지 | 보내기, @ | 로 부르기
//   standard     release-2 | 026-08 | …          (같다)
//   push-out     release-2 | 026-08 | …          (같다)
//   none         release-2 | 026-08 | …          (같다)
//   ZWSP 삽입    release-  | 2026-08 | …         <- 하이픈에서 끊긴다
//
// 즉 RN 이 노출하는 네 전략 중 **어느 것도** 이 축을 안 고친다. 한 줄에 통째로
// 못 드는 토큰 앞에서 CoreText 는 글자 단위로 끊고, 토큰이 자기 안에 갖고 있던
// 경계(하이픈)를 쓰지 않는다. 남는 지렛대는 **줄바꿈 기회를 문자로 심는 것**
// 하나이고, 그것이 웹의 `<wbr>` 이 하는 일이다(이 레포도 웹에서 zero-width space
// 를 레이아웃 장치로 이미 쓴다 — `features/chat/TypingLine.tsx`).
//
// ## 무엇에 심는가 — **우리가 지은 문장에만. 사람이 친 글에는 절대로.**
//
// 이 함수는 `placeholder` 에만 걸린다. `value` 는 이 파일의 첫 번째 규칙이
// 지키는 것이고(머리말: 값은 동기다), 거기에 문자를 하나라도 끼워 넣으면 그
// 순간 조합이 끊기고 사람이 친 글이 우리가 손댄 글이 된다. 라틴 URL·경로를 친
// 사람의 줄바꿈은 그 사람의 것이다.
//
// 접근성: U+200B 는 서식 문자라 VoiceOver 가 읽지 않는다. 이 상자의 이름은
// 어차피 따로 있고(`composerFieldLabel`), 그 문자열에는 이 함수가 안 걸린다.
// =============================================================================

/** 줄바꿈 기회 한 자리. 폭이 0 이고 소리도 없다. */
const ZERO_WIDTH_SPACE = '​';

/**
 * 라틴 토큰이 **자기 경계에서** 끊기게 한다.
 *
 * 규칙은 좁다: 라틴/숫자 사이에 낀 `-`·`_`·`.`·`/` **뒤에만** 기회를 심는다.
 * 한글은 손대지 않는다 — 거기는 `hangul-word` 의 자리이고, 한글 사이에 기회를
 * 심으면 그 전략이 막아 둔 어절 가운데 끊김을 우리 손으로 되살린다.
 */
export function withLatinWordBreaks(text: string): string {
  return text.replace(
    /([0-9A-Za-z])([-_./])(?=[0-9A-Za-z])/g,
    `$1$2${ZERO_WIDTH_SPACE}`,
  );
}

// =============================================================================
// 빈 상자에 못 서는 문장은 **절 경계에서** 접힌다 — 폰이 절 예산을 부른다 (#1479 ②)
//
// ## 왜 이 파일의 판정이 뒤집히나
//
// 아래 입력창의 주석이 「폰은 코어의 절 예산을 안 부른다」를 실측으로 정했고, 그
// 근거는 전제 하나였다: RN 의 `multiline` `TextInput` 은 콘텐츠 높이로 자라므로
// 넘쳐도 **잃는 것이 없다.** 그 전제는 `MAX_ROWS` 가 유일한 상한이던 때의 것이다.
//
// #1443 이 그 위에 대화 열의 몫을 얹으면서 상자는 더는 무한히 안 자라고, 큰
// 글자에서는 몫이 먼저 걸린다(AX-XXL 실측 170.4pt = 2.2줄). 그리고 **빈 상자는
// 스크롤이 대신해 주지 않는다** — 넘칠 때 상자 안에서 스크롤하는 것은 *콘텐츠*
// 이고 플레이스홀더는 콘텐츠가 아니라, 아직 아무것도 안 친 사람에게는 스크롤할
// 것이 없다. 전제가 무너진 자리에서는 웹의 판정이 그대로 선다: 어차피 못 설 절은
// 절 경계에서 통째로 사라져야 하고, 반쪽 절(「보내기, @」)이나 반노출 줄로 남으면
// 안 된다(디자인 시스템 §5.3 7위).
//
// ## 이 규칙이 **구하지 못하는** 띠도 이름을 갖는다
//
// 대가 없이 다 낫는 것이 아니다. 상자가 담는 줄 수는 `152.4 ÷ (22 × 배수)` 라
// 배수에 반비례하고(글자리 152.4pt 는 배수 ~1.5 위에서 열의 몫이 이기며 고정된다)
// 문장의 줄 수는 배수를 따라 는다. 그래서 셋으로 갈린다 — 아래 실측
// (iPhone 17 Pro / iOS 26.5, `measure/captures/clause1479-*`, 계측 줄이 매 사진에
// 문장·머리 절의 줄 수와 상자의 줄 수를 함께 적는다):
//
//   large (배수 1.000)      상자 5.0줄 · 세 이름 다 1~2줄 — **화면이 하나도 안
//                           변한다.** `composerDraftOffline.test.tsx` 가 그 자리를
//                           단정으로도 잰다.
//   a11y-medium (1.786)     상자 3.9줄 · 문장 2~3줄 — 아직 다 든다.
//   a11y-large (2.143)      상자 3.2줄 · `일반` 3줄(다 든다) · `release-2026-08`
//                           **4줄, 머리 3줄** — 여기서 규칙이 값을 낸다: 옛 판이
//                           「…보내기, @로」로 끝나던 자리에 이제 「…보내기」가
//                           온전히 선다(before/after 사진 두 장이 그 자리다).
//   a11y-XL 위 (2.643~)     상자 2.6줄 · 머리 절도 3~4줄 — **버릴 절이 없다.**
//                           웹에도 같은 띠가 있고(`gate-work-panel.mjs` 의
//                           `head-clause` 레인) 답도 같다: 절 단위 생략 위에서는
//                           아무것도 그 띠를 못 구한다. 남는 것은 상자 자신의
//                           문제이고, 그 결정은 위 `composerMaxHeight` 이 진다.
//
// 그 마지막 띠까지 낫는다고 적으면 그것이 이 파일이 #1422 에서 한 번 저지른 잘못
// (전제를 조건절 없이 적는 것)의 재판이다. 여기서는 띠를 세어 두고, 사진이 그
// 산수를 자기 안에 적는다.
//
// ## 규칙은 코어의 것, 자는 이 클라의 것
//
// 코어는 화면을 모른다(`purity.mjs`). 그래서 **무엇을 버릴지**는 계속
// `fitComposerPlaceholder` 가 정하고 「이 문자열이 이 상자에 드는가」만 여기서
// 답한다 — 웹 `placeholderFit.ts` 와 같은 분업이고, 다른 것은 **자의 축**이다:
// 웹의 상자는 한 줄(`rows=1`)이라 가로를 재고, 이 상자는 여러 줄이라 **세로**를
// 잰다. 프로브는 입력창과 같은 글자·같은 줄 상자·같은 줄바꿈 전략으로 서고,
// `onTextLayout` 이 돌려주는 줄들의 높이를 더해 `composerMaxHeight` 이 든 글자리와
// 대조한다.
//
// **재기 전에는 문장 전체다.** 웹이 같은 방향을 고른 이유와 같다: 「일단 짧게」로
// 시작하면 드는 상자에서도 광고가 한 프레임 사라졌다 돌아온다. 반대 방향의 대가는
// 안 드는 문장이 한 프레임 서는 것이고, 그것은 이미 오늘의 화면이다.
//
// ## 이 프로브가 **안** 하는 것
//
// 사람이 친 글은 안 잰다. `value` 는 이 파일의 첫 번째 규칙이 지키는 것이고, 이
// 프로브는 `placeholder` 하나만 재며 그 답이 `value` 에 대해 아무것도 결정하지
// 않는다. 상태가 움직이는 계기도 키스트로크가 아니라 **레이아웃**이다.
//
// 스레드처럼 문장을 넘겨받은 자리(`placeholder` prop)에서는 아예 안 선다. 절
// 계약은 코어가 절로 지은 문장의 것이고, 남이 준 한 덩이 문자열에는 버릴 절
// 경계가 없다.
//
// 접근성: 프로브는 `accessibilityElementsHidden` 과
// `importantForAccessibility="no-hide-descendants"` 로 접근성 트리 밖에 선다.
// 안 그러면 VoiceOver 가 같은 문장을 한 번 더 읽는다.
// =============================================================================

/**
 * 코어가 물어볼 후보들 — 순서까지 그대로.
 *
 * 이음쇠(`, `)를 이 파일이 적지 않는다. 웹 `placeholderFit.ts` 가 같은 자리에서
 * 같은 이유를 적었다: 사본이 생기는 순간 그것이 두 번째 정본이다. 규칙에 「다
 * 든다」고 답하면서 지나가는 후보를 모으면 그 목록이 곧 물어볼 목록이고, 절이
 * 셋이 되는 날에도 이 함수는 안 고친다.
 */
function placeholderCandidates(
  clauses: readonly ComposerPlaceholderClause[],
): readonly string[] {
  const asked: string[] = [];
  fitComposerPlaceholder(clauses, candidate => {
    asked.push(candidate);
    return true;
  });
  return asked;
}

/**
 * 연결이 끊겨 지금은 보낼 수 없다는 한 문장. **이름만 여기 있고 값은 코어에
 * 있다** (U4-6 리뷰 H-1).
 *
 * 이 배치가 문장을 여기서 landing 시켰고, 같은 주에 웹이 자기 파일에 같은 이름
 * 으로 **다른 문장**을 지었다("…쓰던 글은 그대로 남습니다"). 이름이 같은데 값이
 * 다른 것은 갈라질 위험이 아니라 이미 갈라진 것이고, 그래서 값은
 * `APPROVAL_OFFLINE_COPY` 가 이미 걸어 둔 길로 올라갔다 —
 * `@momo/core/features/chat/composerCopy` 가 문장과 그 문장을 고른 이유를 든다.
 *
 * 이름을 남기는 이유는 `useOnline.ts` 와 같다: **측정 하네스와 테스트가 이 이름
 * 으로 값을 읽어** 사진을 찍고 단정한다. 문장을 베껴 적으면 배송되는 문장이
 * 바뀌어도 사진은 옛말을 계속 한다.
 */
export {COMPOSER_OFFLINE_COPY};

export interface ComposerSendOptions {
  attachments: MessageAttachment[];
}

export function Composer({
  channelLabel,
  recipient,
  directory,
  dmAgent,
  offline,
  draftKey,
  onSend,
  onTyping,
  quote,
  onCancelQuote,
  attachmentTarget,
  placeholder,
  sendLabel = '보내기',
  inputRef: externalInputRef,
}: {
  channelLabel: string;
  /**
   * 이 label 이 **방 이름인가 사람 이름인가** (#1384). DM 의 label 은 상대의
   * displayName 이므로(`channelLabelParts`) 조사가 갈린다: 방은 에, 사람은
   * 에게. 기본값을 두지 않는 것은 의도다 — 모르는 채로 그린 화면이 「hermes에
   * 메시지 보내기」였고, 조사는 한국어 독자에게 렌더링 디테일이 아니다.
   */
  recipient: RecipientKind;
  directory: Directory;
  /** Overrides `composerPlaceholder`. A thread is not a channel. */
  placeholder?: string;
  /** Overrides 보내기. A reply says what it is. */
  sendLabel?: string;
  /** The agent a DM answers without an @mention, if this is that kind of DM. */
  dmAgent?: RosterMember | null;
  /**
   * 이 기기가 네트워크에 닿지 않는다 (NetInfo).
   *
   * ## 왜 레일 상태가 아닌가 — 옛 이름은 `disabled` 였고 레일을 읽었다
   *
   * 이 자리는 `railStatus === 'disconnected'` 를 받고 「연결이 끊겼습니다. 보낸
   * 메시지는 연결이 돌아오면 다시 시도할 수 있습니다」라고 말했다. **레일이
   * 끊겼을 때 그 문장은 참이 아니다**: 레일은 웹소켓이고 전송은 REST POST 라,
   * 재구독을 기다리는 동안에도 그 POST 는 멀쩡히 성공한다. 즉 앱은 잘 나가는
   * 메시지를 두고 「나중에 다시 시도하라」고 말하고 있었다.
   *
   * 같은 범주 오류를 이 레포는 이미 한 번 고쳤다 — 승인 컨트롤이
   * (`features/inbox/useOnline.ts` 머리말: *"레일은 웹소켓이고 결정은 REST POST
   * 로 나간다"*), 그 판정을 테스트가 지키고 있다(`approvalCard.test.tsx`:
   * 「레일 상태가 아니라 네트워크를 본다」). 컴포저는 같은 종류의 행동을 하면서
   * 그 수리를 못 받았을 뿐이다. 이제 둘이 **같은 신호**를 읽는다.
   *
   * ## 그리고 이것은 진짜로 버튼을 끈다
   *
   * 옛 판은 문장만 띄우고 전송 버튼은 열어 두었다(비활성 조건은 빈 텍스트
   * 하나뿐 — 감사 H-10 이 웹에 대해 적은 것과 같은 모양). 오프라인에서 누르면
   * 반드시 실패할 행을 하나 만들고, 그 행을 찾아 「다시 시도」를 누르는 일은
   * 사람에게 넘어간다. 그것은 큐가 아니라 **떠넘기기**다.
   *
   * 대신 글자는 지키기로 한다. 이 배치가 초안 보존(`drafts.ts`)을 함께 넣은
   * 이유가 그것이다 — 「지금은 못 보냅니다」가 정직한 문장이 되려면 그동안 쓴
   * 글이 그 자리에 그대로 있어야 한다.
   */
  offline?: boolean;
  /**
   * 이 컴포저의 초안이 앉는 자리 (`drafts.ts`). 없으면 초안을 쓰지도 읽지도
   * 않는다 — 이름 없는 자리에 남긴 글은 나중에 누구의 것인지 답할 수 없다.
   */
  draftKey?: string;
  onSend: (body: string, options?: ComposerSendOptions) => void;
  /** 일반 대화와 스레드가 서로의 첨부 초안을 보지 않게 하는 자리 이름. */
  attachmentTarget?: AttachmentTarget;
  /**
   * 자판이 눌렸다 (ADR-0149 「작성 중」).
   *
   * 한 글자마다 한 번, **동기 쓰기 뒤에** 불린다. 얼마나 자주 실제로 보낼지는
   * 여기서 정하지 않는다 — 재전송 주기는 서버가 grant 응답으로 내려보내는 값이고
   * (`republishIntervalMs`), 그것을 지키는 것은 채널을 아는 화면의 일이다. 이
   * 파일이 아는 것은 「방금 무언가 쳤다」뿐이다.
   *
   * 「입력을 멈추면 송신이 멈춘다」는 따로 배선하지 않아도 성립한다: 재전송을
   * 미는 것이 키스트로크이므로, 키스트로크가 멎으면 재전송도 멎고 TTL 이 나머지를
   * 한다. **stop 신호가 없는 것이 계약이다.**
   */
  onTyping?: () => void;
  /**
   * 지금 인용을 걸고 쓰는 중이면 그 원문 (ADR-0148). `null`/`undefined` 면 없다.
   */
  quote?: QuoteDraft | null;
  /** 인용을 무른다. 인용이 있는데 이것이 없으면 나가는 길이 없다. */
  onCancelQuote?: () => void;
  /**
   * The text field itself. Exposed so a caller can put the caret here — the
   * empty-state "첫 메시지 쓰기" affordance wants it, and `measure/` uses it to
   * raise the real software keyboard without a tap (a simulator cannot be
   * tapped by a script, so a harness that needed one could not run at all).
   */
  inputRef?: React.MutableRefObject<TextInput | null>;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  // 성장 상한은 **스타일시트에 못 박히지 않는다** (#1443). 글자 배수와 창 높이가
  // 정하고, 둘 다 사람이 설정에서 바꾸는 값이라 렌더마다 다시 읽는다 —
  // `useWindowDimensions` 는 동적 타입이 바뀌는 순간에도 다시 그린다(RN 은
  // `RCTAccessibilityManager` 의 배수 변경을 Dimensions 변경으로 내보낸다).
  const {fontScale, height: windowHeight} = useWindowDimensions();
  const maxHeight = composerMaxHeight(fontScale, windowHeight);
  // 시트의 상한도 같은 두 값이 정한다 (#1480). 위 상한과 나란히 여기서 계산하는
  // 이유가 그것이다 — 둘은 같은 열을 나눠 갖고, 스타일시트는 그 열을 모른다.
  const mentionsMaxHeight = mentionSheetMaxHeight(fontScale, windowHeight);
  // 절 예산의 자 (#1479). 상한이 든 높이에서 세로 크롬을 빼면 **글이 서는 자리**다.
  const placeholderRoom = maxHeight - INPUT_CHROME;
  // 첫 렌더가 이미 초안을 들고 있다 (`drafts.ts`). 효과로 채우면 빈 상자가 한
  // 프레임 그려졌다가 글이 나타나고, 그것은 「글이 잠깐 사라졌다 돌아오는」
  // 화면이다 — MMKV 가 동기로 읽히는 것이 여기서 값을 한다.
  const [text, setText] = useState(() =>
    draftKey === undefined ? '' : readDraft(draftKey),
  );
  // **0 이 초안과 어긋난다 — 알고 두는 자리다** (#1480 design-review L1).
  //
  // 위 `text` 는 초안을 복원해 첫 렌더에 이미 글을 들고 있는데 캐럿은 0 이다.
  // 같은 파일의 `draftKey` 전환 효과는 같은 사실에 `restored.length` 를 쓰므로,
  // 두 자리가 같은 상황에 다른 답을 갖고 있다. 실제로 걸린 자리가 있다: 계측이
  // 「`@` 로 끝나는 초안」을 심어 시트를 열려 했을 때, iOS 가 `focus()` 에도
  // `setSelection()` 에도 `onSelectionChange` 를 안 내보내서 캐럿이 0 에 머물고
  // (`mentionQueryAt` 는 캐럿 앞만 본다) 화면에는 캐럿이 `@` 뒤에 보이는데
  // 목록이 안 열렸다(그래서 그 캡처는 Maestro 가 정말로 친다).
  //
  // **여기서 안 고친다.** 아래 `mentionOpen` 의 초기값이 `true` 이므로, 캐럿을
  // 초안 끝으로 옮기면 `@` 로 끝나는 초안을 복원한 순간 콜드 스타트에 시트가
  // 스스로 열린다 — 아무도 아직 아무것도 안 쳤는데. 그 둘은 한 결정이고, 이
  // 티켓(시트의 **상한**)의 것이 아니다.
  const [caret, setCaret] = useState(0);
  const [mentionOpen, setMentionOpen] = useState(true);
  const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false);
  const ownInputRef = useRef<TextInput | null>(null);
  const inputRef = externalInputRef ?? ownInputRef;
  // Mirrors `text` for the caret derivation below without making `onChangeText`
  // depend on it — a changing identity there would rebuild the handler on every
  // keystroke, which is exactly the churn this file is careful about.
  const currentTextRef = useRef(text);

  const attachmentWorkspaceId = attachmentTarget?.workspaceId;
  const attachmentChannelId = attachmentTarget?.channelId;
  const attachmentRootId = attachmentTarget?.rootId;
  const stableAttachmentTarget = useMemo(
    () =>
      attachmentWorkspaceId === undefined || attachmentChannelId === undefined
        ? null
        : {
            workspaceId: attachmentWorkspaceId,
            channelId: attachmentChannelId,
            ...(attachmentRootId === undefined
              ? {}
              : {rootId: attachmentRootId}),
          },
    [attachmentWorkspaceId, attachmentChannelId, attachmentRootId],
  );
  const attachmentKey = useMemo(
    () =>
      stableAttachmentTarget === null
        ? null
        : attachmentSurfaceKey(stableAttachmentTarget),
    [stableAttachmentTarget],
  );
  const attachmentSurface = useAttachmentSurface(attachmentKey);
  const attachmentBlock = sendBlockReason(attachmentSurface.drafts);
  const attachmentBlockCopy = sendBlockCopy(attachmentSurface.drafts);

  const chooseAttachment = useCallback(
    async (kind: 'photo' | 'file') => {
      if (stableAttachmentTarget === null || attachmentKey === null) return;
      setAttachmentPickerOpen(false);
      setPickerIssue(attachmentKey, null);
      const outcome = kind === 'photo' ? await pickPhoto() : await pickDocument();
      if (outcome.kind === 'issue') {
        setPickerIssue(attachmentKey, outcome.issue);
        return;
      }
      addPickedFiles(attachmentKey, stableAttachmentTarget, outcome.files);
    },
    [attachmentKey, stableAttachmentTarget],
  );

  // 초안 자리도 거울로 든다. 위와 같은 이유다 — `draftKey` 를 `onChangeText` 의
  // 의존성으로 들면 채널을 옮길 때마다 핸들러가 새로 만들어진다.
  const draftKeyRef = useRef(draftKey);

  // 대화 화면은 채널이 바뀌어도 **언마운트되지 않는다**(`AppShell` 은 같은
  // `ConversationScreen` 에 새 `channelId` 를 준다). 그래서 자리가 바뀌는 순간은
  // 이 효과가 유일하게 알 수 있는 곳이다. 나가는 쪽의 글을 여기서 저장할 필요는
  // 없다 — 키스트로크마다 이미 저장돼 있다(`drafts.ts` 머리말).
  useEffect(() => {
    if (draftKey === draftKeyRef.current) return;
    draftKeyRef.current = draftKey;
    const restored = draftKey === undefined ? '' : readDraft(draftKey);
    currentTextRef.current = restored;
    setText(restored);
    setCaret(restored.length);
    setMentionOpen(false);
  }, [draftKey]);

  // Derived during render, not in an effect: an effect would compute the list
  // one commit after the keystroke that opened it, which is the same lateness
  // this file bans for `value` — and the candidate list riding one keystroke
  // behind is how a person accepts the wrong member.
  const query = mentionOpen ? mentionQueryAt(text, caret) : null;
  const candidates = useMemo(
    () => (query ? matchMembers(directory.members, query.text) : []),
    [query, directory.members],
  );
  const showMentions = candidates.length > 0;

  // `onTyping` 을 의존성으로 들지 않기 위한 거울. 호출자가 핸들러 동일성을
  // 흘리면 `onChangeText` 가 키스트로크마다 새로 만들어지고, 그것은 이 파일이
  // 가장 조심하는 종류의 흔들림이다.
  const onTypingRef = useRef(onTyping);
  onTypingRef.current = onTyping;

  const onChangeText = useCallback((next: string) => {
    // SYNCHRONOUS. See the header. The caret is derived from the edit itself
    // rather than read from `onSelectionChange`, because that event arrives on
    // its own schedule and a mention query computed from a stale caret offers
    // candidates for a token the person already finished typing. Deriving it
    // costs one string compare and is exact for an insertion, a deletion, and
    // for an IME replacing the composing tail.
    setCaret(caretAfterChange(currentTextRef.current, next));
    currentTextRef.current = next;
    setText(next);
    setMentionOpen(true);
    // LAST, and on a separate rail. Everything above is the value; this is a
    // signal about the person, and it must never be able to reorder itself in
    // front of the write (see the header's 「작성 중」 note).
    //
    // 초안 저장도 같은 레일이고 같은 이유로 여기 있다: 값이 쓰인 **뒤**이고,
    // 값에 대해 아무것도 결정하지 않으며, 기다려지지 않는다. 나가는 길마다
    // 저장을 다는 대신 매 글자를 적어 두면 잃는 경로 자체가 없어진다
    // (`drafts.ts` 머리말).
    if (draftKeyRef.current !== undefined) {
      saveDraft(draftKeyRef.current, next);
    }
    onTypingRef.current?.();
  }, []);

  const onSelectionChange = useCallback(
    (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      // Only a caret MOVE (tapping elsewhere). Text edits already set the caret
      // synchronously above; taking this event's value as well would let a late
      // selection event overwrite the fresh position with the old one.
      const {start, end} = event.nativeEvent.selection;
      if (start === end && currentTextRef.current === text) setCaret(start);
    },
    [text],
  );

  const accept = useCallback(
    (member: RosterMember) => {
      if (!query) return;
      const next = applyMention(text, query, caret, member.handle);
      // Same synchronous write as a keystroke, and note what is NOT done here:
      // the `selection` prop is never set. Controlling selection on iOS resets
      // the input's composition state, which is the very failure this file is
      // built around — so the caret is tracked, and the OS keeps ownership of it.
      currentTextRef.current = next.text;
      setText(next.text);
      setCaret(next.caret);
      setMentionOpen(false);
      // 멘션 수락도 글자를 바꾼 것이다. 여기서 안 적으면 「@김인턴 」까지 쓰고
      // 나간 사람은 그 낱말만 잃는다.
      if (draftKeyRef.current !== undefined) {
        saveDraft(draftKeyRef.current, next.text);
      }
    },
    [query, text, caret],
  );

  const submit = useCallback(() => {
    const body = text.trim();
    const hasAttachments = attachmentSurface.drafts.length > 0;
    if (
      offline === true ||
      attachmentBlock !== null ||
      (body === '' && !hasAttachments)
    ) {
      return;
    }
    // Clear first, send second. The echo row carries the message from here on,
    // including its failure state and its retry; a composer that stays full
    // while its message is visible below reads as if nothing happened.
    currentTextRef.current = '';
    setText('');
    setCaret(0);
    setMentionOpen(false);
    // 보냈으므로 초안은 이제 없다 — 화면에서 지우면서 저장소에 남겨 두면 다음에
    // 이 채널을 열 때 방금 보낸 글이 입력창에 되살아난다.
    if (draftKeyRef.current !== undefined) {
      clearDraft(draftKeyRef.current);
    }
    if (attachmentKey === null) {
      onSend(body);
      return;
    }
    const sent = takeSent(attachmentKey);
    if (sent.attachments.length === 0) {
      onSend(body);
      return;
    }
    onSend(body, {attachments: sent.attachments});
  }, [
    text,
    onSend,
    offline,
    attachmentBlock,
    attachmentKey,
    attachmentSurface.drafts.length,
  ]);

  // 보낼 수 있는가 — 두 조건이고 둘은 다른 종류다. 하나는 「보낼 것이 있는가」,
  // 하나는 「지금 나갈 수 있는가」다.
  const canSend =
    offline !== true &&
    attachmentBlock === null &&
    (text.trim() !== '' || attachmentSurface.drafts.length > 0);
  const canAttach =
    stableAttachmentTarget !== null &&
    offline !== true &&
    attachmentSurface.drafts.length < MAX_ATTACHMENTS_PER_MESSAGE;

  // ---- 절 예산 (#1479) ------------------------------------------------------
  // 넘겨받은 문장에는 절 경계가 없다(위 머리말). 그때는 절도 프로브도 안 선다.
  const clauses = useMemo(
    () =>
      placeholder === undefined
        ? composerPlaceholderClauses(channelLabel, recipient)
        : null,
    [placeholder, channelLabel, recipient],
  );
  const placeholderProbes = useMemo(
    () => (clauses === null ? [] : placeholderCandidates(clauses)),
    [clauses],
  );

  // 입력창이 자기 폭을 알린 뒤에야 프로브가 설 수 있다 — 자와 상자의 폭이 다르면
  // 그 답은 이 상자에 대한 답이 아니다.
  const [inputWidth, setInputWidth] = useState<number | null>(null);
  const onInputLayout = useCallback((event: LayoutChangeEvent) => {
    const {width} = event.nativeEvent.layout;
    setInputWidth(previous => (previous === width ? previous : width));
  }, []);
  const probeWidth =
    inputWidth === null ? null : inputWidth - INPUT_CHROME_X;

  // 잰 것은 **세로**이지 「든다/안 든다」가 아니다. 상한은 글자 배수와 창이 정하니
  // 판정을 저장하면 둘 중 하나가 바뀌는 순간 저장된 답이 늙는다 — 웹의 자가
  // 늙었던 그 결함이고(`placeholderFit.ts` 의 recompute 절), 세로를 들면 판정은
  // 언제나 지금 상한으로 다시 난다.
  const [probed, setProbed] = useState<Readonly<Record<string, number>>>({});
  const onProbeLayout = useCallback(
    (candidate: string, event: NativeSyntheticEvent<TextLayoutEventData>) => {
      const height = event.nativeEvent.lines.reduce(
        (sum, textLine) => sum + textLine.height,
        0,
      );
      setProbed(previous =>
        previous[candidate] === height
          ? previous
          : {...previous, [candidate]: height},
      );
    },
    [],
  );

  const shownPlaceholder = withLatinWordBreaks(
    clauses === null
      ? (placeholder as string)
      : fitComposerPlaceholder(clauses, candidate => {
          const height = probed[candidate];
          // 아직 안 잰 후보는 「든다」다 — 머리말의 안전 방향.
          return height === undefined || height <= placeholderRoom;
        }),
  );

  return (
    <View style={styles.root}>
      {showMentions ? (
        <View
          style={[styles.mentions, {maxHeight: mentionsMaxHeight}]}
          testID="mention-list">
          <ScrollView
            keyboardShouldPersistTaps="always"
            // **막대를 되돌린다** (design-review 회전 1 L6). 옛 판은 이것을 껐고,
            // 4행 시트가 6개(=`MENTION_LIMIT`)를 거의 다 담던 때는 안 보였다.
            // 이 배치가 그 조건을 바꾼다 — 상한이 열을 따라가므로 작은 창·큰
            // 글자에서는 바닥인 **2행**까지 내려가고, 그러면 넷이 아래에 숨는다.
            // 「아래 더 있다」를 아무것도 안 말하는 목록은 자기가 무엇을 가리고
            // 있는지 안 보여 준다.
            //
            // 이 집의 관례도 그쪽이다: 같은 모양의 형제(`MessageActionSheet` —
            // 역시 도출된 `maxHeight` 로 잘리는, 고르는 시트)가 막대를 켜 둔다.
            // 끄고 있는 둘은 가로 레일(`Timeline`·`SearchScreen`)이라 다른 물건
            // 이다.
            //
            // **닫는 것과 못 닫는 것**: iOS 의 막대는 끄는 동안에만 보이므로,
            // 이것이 주는 것은 「지금 끄는 이 목록에 아래가 더 있다」이지 「손을
            // 대기 전부터 더 있다고 알려 주는 것」이 아니다. 후자는 페이드
            // 마스크나 개수 표지가 필요하고, 그것은 이 티켓의 결정(상한)이
            // 아니다.
            //
            // **막대가 행 끝의 표지를 가리지 않는다**는 것은 사진이 아니라 산수로
            // 안다(회전 2 nitpick — iOS 막대는 끄는 동안에만 보여서 정지 사진에
            // 안 찍힌다): 막대는 가장자리 바깥쪽 ~5pt 안에 서고, 행의 조각들은
            // `SAFE_GUTTER`(16) 만큼 안쪽에서 끝난다. 표지가 가장 오른쪽까지
            // 가는 AX-XXL 에서도 그 사이에 11pt 가 남는다.
            showsVerticalScrollIndicator>
            {candidates.map(member => (
              <Pressable
                key={member.id}
                accessibilityRole="button"
                // 눈에 보이는 것과 같은 것을 읽는다 (회전 2 M3). 이 `Pressable` 은
                // `accessible` 기본값이 참이라 이 한 줄이 자식 셋을 통째로 덮는다 —
                // 표지를 여기 안 실으면 스크린리더에서 사람 행과 에이전트 행이
                // 구별되지 않는다.
                accessibilityLabel={[
                  member.displayName,
                  `@${member.handle}`,
                  member.kind === 'agent' ? MENTION_AGENT_KIND : null,
                ]
                  .filter(Boolean)
                  .join(' ')}
                onPress={() => accept(member)}
                style={({pressed}) => [
                  styles.mentionRow,
                  pressed && styles.pressed,
                ]}
                testID="mention-option">
                {/* 이름과 핸들은 **한 묶음**이다 — 그 묶음이 자라고, 그 안에서 둘이
                    함께 줄어든다. 형제 셋(`AgentsScreen`·`SidebarScreen`·
                    `HostedConnectionsScreen`)의 `rowText` + `rowTitleLine` 과 같은
                    구조이고, 스타일 쪽 주석이 왜 그 구조여야 하는지를 든다. */}
                <View style={styles.mentionIdentity} testID="mention-identity">
                  <Text
                    style={[
                      styles.mentionName,
                      member.kind === 'agent' && styles.mentionNameAgent,
                    ]}
                    numberOfLines={1}>
                    {member.displayName}
                  </Text>
                  <Text style={styles.mentionHandle} numberOfLines={1}>
                    {`@${member.handle}`}
                  </Text>
                </View>
                {member.kind === 'agent' ? (
                  // 한 줄로 못 박는다 — 줄어들 수 있게 해 둔 조각이(스타일의
                  // `flexShrink`) 한 줄로 안 묶이면 접히고, 접힌 행은 이 배치가
                  // 세운 정수 행 산술이 세는 높이를 넘는다.
                  <Text style={styles.mentionKind} numberOfLines={1}>
                    {MENTION_AGENT_KIND}
                  </Text>
                ) : null}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {dmAgent && text.trim() === '' ? (
        <Text style={styles.hint}>
          {/* 이 자리에 병기형을 적는 것은 번역이 아니라 **기계가 사람 앞에서
              결정을 미루는 것**이다 (goal RN-B4c / #1027). 규칙은 마지막 음절
              하나로 전부 결정되고, 그 규칙은 이 레포에 이미 있다 —
              `@momo/core/lib/koreanParticle`. 라틴·숫자로 끝나는 이름은 열린
              형태를 받는다: 「Hermes가」, 「루나가」, 「김인턴이」. */}
          {`멘션 없이 바로 말하면 ${attachParticle(
            dmAgent.displayName,
            'subject',
          )} 답합니다.`}
        </Text>
      ) : null}

      {offline ? (
        <Text style={styles.offline} testID="composer-offline">
          {COMPOSER_OFFLINE_COPY}
        </Text>
      ) : null}

      {attachmentKey === null ? null : (
        <AttachmentTray
          drafts={attachmentSurface.drafts}
          pickerIssue={attachmentSurface.pickerIssue}
          onRemove={localId => dropDraft(attachmentKey, localId)}
          onRetry={localId => {
            if (stableAttachmentTarget !== null) {
              retryDraft(attachmentKey, stableAttachmentTarget, localId);
            }
          }}
          onClear={() => clearSurface(attachmentKey)}
        />
      )}

      {/* 입력창 **바로 위**. 지금 쓰고 있는 글이 무엇을 가리키는지는 그 글을
          쓰는 자리에 붙어 있어야 하고, 취소도 거기 있어야 한다 — 들어가는 길만
          있고 나오는 길이 없으면 안 된다(ADR-0148 미결 3). */}
      {quote && onCancelQuote ? (
        <QuoteDraftBar
          block={quote.block}
          directory={directory}
          onCancel={onCancelQuote}
        />
      ) : null}

      {/* 절 예산의 자 (#1479). 화면에 안 나가고(투명·절대 배치) 접근성 트리에도
          안 들어간다 — 하는 일은 배송되는 입력창과 **같은 조판**으로 후보 문장을
          세워 `onTextLayout` 에 자기 줄들을 내놓는 것뿐이다. 같은 파일에 두는
          이유가 그 「같은 조판」이다: 글자·줄 상자·줄바꿈 전략이 아래 `styles.input`
          바로 옆에 있어야 둘이 조용히 갈라지지 않는다. */}
      {probeWidth === null || placeholderProbes.length === 0 ? null : (
        <View
          style={styles.probeHost}
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants">
          {placeholderProbes.map(candidate => (
            <Text
              key={candidate}
              style={[styles.probe, {width: probeWidth}]}
              lineBreakStrategyIOS="hangul-word"
              onTextLayout={event => onProbeLayout(candidate, event)}
              testID="composer-placeholder-probe">
              {withLatinWordBreaks(candidate)}
            </Text>
          ))}
        </View>
      )}

      <View style={styles.bar}>
        {stableAttachmentTarget === null ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={ATTACH_COPY.attach}
            accessibilityHint={
              offline
                ? COMPOSER_OFFLINE_COPY
                : attachmentSurface.drafts.length >=
                    MAX_ATTACHMENTS_PER_MESSAGE
                  ? `첨부는 ${MAX_ATTACHMENTS_PER_MESSAGE}개까지 고를 수 있습니다`
                  : undefined
            }
            accessibilityState={{disabled: !canAttach}}
            disabled={!canAttach}
            onPress={() => setAttachmentPickerOpen(true)}
            style={({pressed}) => [
              styles.attach,
              !canAttach && styles.attachDisabled,
              pressed && canAttach && styles.pressed,
            ]}
            testID="composer-attach">
            <Text
              style={[
                styles.attachLabel,
                !canAttach && styles.attachLabelDisabled,
              ]}>
              ＋
            </Text>
          </Pressable>
        )}
        <TextInput
          ref={inputRef}
          style={[styles.input, {maxHeight}]}
          onLayout={onInputLayout}
          value={text}
          onChangeText={onChangeText}
          onSelectionChange={onSelectionChange}
          // 문장은 코어가 든다 (#1384). 이 두 줄은 웹 `chat/Composer.tsx` 와
          // **같은 문자열을 각자 짓고** 있었다: 값이 같아서 안 보였을 뿐,
          // 한쪽을 고치는 날 갈라진다. 오프라인 문장이 이미 걸어 둔 길이다.
          //
          // **드는 만큼만 실린다** (#1479). 절을 고르는 것은 코어의
          // `fitComposerPlaceholder` 이고, 「이 상자에 드는가」만 위의 프로브가
          // 답한다 — 그 분업과 그것이 구하지 못하는 띠는 이 파일의 「절 예산」
          // 머리말에 있다.
          placeholder={shownPlaceholder}
          placeholderTextColor={palette.textFaint}
          accessibilityLabel={placeholder ?? composerFieldLabel(channelLabel, recipient)}
          multiline
          // 이 상자에서 한국어가 **낱말 가운데서** 끊기지 않는다 (#1422 폰 몫).
          //
          // 웹의 같은 문장은 한 줄 상자(`rows=1`)라 넘친 절이 사라지고, 그래서
          // #1422 는 거기서 「절 단위로 버린다」를 계약으로 만들었다. 이 상자는
          // 다르다 — RN 의 `multiline` 은 콘텐츠 높이로 자라므로 넘쳐도 잃는 것이
          // 없고, 잃는 것이 없으면 버릴 이유도 없다. 폰 계측이 그것을 실측했다
          // (`measure/surfaces.tsx` 의 `composer-placeholder`: 예산 260pt 상자에서
          // 긴 방 이름은 두 줄, 그리고 **두 줄 다 보인다**).
          //
          // 그 「잃는 것이 없다」는 **기본 글자 크기까지**였다. 같은 표면을
          // `accessibility-extra-extra-large` 로 찍으면 글폭이 206pt 로 줄고
          // 문장이 4~5줄이 되는데 상자는 한 줄만 보여 줬다 — 원인은 성장 상한이
          // 고정 `line.body` 에서 나온 것이었고, 절을 하나 버려도 남는 머리 절이
          // 여전히 안 든다. #1422 는 그 띠를 고치지 않고 사진과 이름만 남겼다
          // (design-review H2, 캡처 `clause1422-composer-placeholder-a11y-*`).
          //
          // **그 상한은 #1443 이 좁혔다** — 위 머리말의 `composerMaxHeight` 이고,
          // 같은 크기에서 1.6줄이 **2.2줄**이 됐다(캡처
          // `grow1443-composer-placeholder-a11y-dark.png` 가 이 표면의 그 뒤다).
          // 남은 절반(잘린 자리의 「release-2」가 라틴 낱말 가운데였다는 것)은
          // 아래 `withLatinWordBreaks` 가 받는다 — `hangul-word` 는 그 축에 손을
          // 못 댄다는 것이 실측이다.
          //
          // **좁혔다고 썼지 닫았다고 안 썼다** (리뷰 L-1). 그 크기에서 문장은
          // 4~5줄이고 상자는 2.2줄이다. 그리고 여기서는 위 「잃는 것이 없다」가
          // 성립하지 않는다 — 넘칠 때 안에서 스크롤하는 것은 *콘텐츠*이고
          // 플레이스홀더는 콘텐츠가 아니라, 아직 아무것도 안 친 사람에게는
          // 스크롤할 것이 없다. 큰 글자에서 뒷절은 **사라진다**.
          //
          // **#1479 가 그 열린 질문에 답했다: 부른다.** 위 「절 예산」 머리말이
          // 결정과 그 산수를 들고, 이 상자의 `placeholder` 는 이제 프로브가 든
          // 세로로 고른 문장이다. 그래서 위 문단의 「안 부른다」는 **#1443 까지의
          // 기록**이지 오늘의 계약이 아니다 — 오늘의 계약은 배수 ~2.2 아래에서
          // 화면이 하나도 안 변하고(그 아래는 문장 전체가 든다), 그 위에서는 못 설
          // 절이 절 경계에서 통째로 사라진다는 것이다.
          //
          // **같은 사진의 다른 결함도 #1479 가 받았다**: 그 크기에서 뒷절이
          // 「보내기, @」 / 「로 부르기」로 끊기던 것. `hangul-word` 에게 `@` 는
          // 낱말 하나라 그 뒤가 어절 경계로 보이는 것이고, 처방은 이 파일이 아니라
          // 코어가 든 문장 쪽이었다 — `MENTION_AFFORDANCE` 가 `@` 와 조사를 WORD
          // JOINER(U+2060)로 묶는다(그 결정은 `composerCopy.ts` 의 「절 안에서
          // 끊기던 자리」 절).
          //
          // 같은 계측이 다른 것을 하나 잡았다: iOS 기본 줄바꿈이 「부르기」를
          // 「부 / 르기」로 끊고 있었다. 이 레포는 그 결함에 이미 이름과 처방을
          // 갖고 있다 — `design/atoms.tsx` 의 `Sentence`·`NoticeBlock` 이 완성된
          // 한국어 문장에 `hangul-word` 를 든다. 그 규칙이 입력창만 비껴가면 같은
          // 앱이 문장마다 다르게 끊긴다(디자인 시스템 §5.3: 한국어 텍스트 처리 ·
          // 한 클라 안의 내부 불일치). 그래서 여기서도 어절이 단위다.
          lineBreakStrategyIOS="hangul-word"
          // Enter inserts a newline (see the header). `blurOnSubmit` false keeps
          // the keyboard up, because on a phone the return key is the only line
          // break there is.
          blurOnSubmit={false}
          textAlignVertical="top"
          testID="composer-input"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={sendLabel}
          // 흐려진 버튼 앞에서 **왜** 흐린지는 화면을 보지 않는 사람에게 특히
          // 안 들린다. 위의 문장은 별개의 요소라 순서대로 훑어야 닿는데, 버튼에
          // 먼저 도착하는 길(로터·직접 탐색)이 있다. 이유는 버튼이 함께 든다.
          accessibilityHint={
            offline ? COMPOSER_OFFLINE_COPY : attachmentBlockCopy ?? undefined
          }
          accessibilityState={{disabled: !canSend}}
          disabled={!canSend}
          onPress={submit}
          style={({pressed}) => [
            styles.send,
            !canSend && styles.sendDisabled,
            pressed && canSend && styles.sendPressed,
          ]}
          testID="composer-send">
          <Text style={[styles.sendLabel, !canSend && styles.sendLabelDisabled]}>
            {sendLabel}
          </Text>
        </Pressable>
      </View>
      <AttachmentPickerSheet
        visible={attachmentPickerOpen}
        onClose={() => setAttachmentPickerOpen(false)}
        onPickPhoto={() => void chooseAttachment('photo')}
        onPickFile={() => void chooseAttachment('file')}
      />
    </View>
  );
}

const buildStyles = (color: Palette) => StyleSheet.create({
  root: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    backgroundColor: color.bg,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space.sm,
    paddingHorizontal: SAFE_GUTTER,
    paddingVertical: space.sm,
  },
  attach: {
    width: TOUCH_TARGET,
    height: TOUCH_TARGET,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
  },
  attachDisabled: {backgroundColor: color.bg},
  attachLabel: {fontSize: font.title, color: color.text},
  attachLabelDisabled: {color: color.textFaint},
  input: {
    flex: 1,
    // 한 줄일 때도 엄지가 닿는 크기. 도출된 한 줄 상자(22 + 8·8 + 1·1 = 40)보다
    // 크므로 이 값이 이긴다 — 그것이 의도다.
    minHeight: TOUCH_TARGET,
    // `maxHeight` 는 여기 없다. 글자 배수와 창 높이가 정하므로 컴포넌트가
    // `composerMaxHeight` 로 계산해 붙인다 (#1443).
    //
    // 좌우 여백이 이름으로 서는 이유는 세로 짝과 같다: 위 `INPUT_CHROME_X` 가
    // 프로브의 글폭을 이 값에서 도출하므로, 여기에 `space.md` 를 다시 적으면
    // 자와 상자가 각자 다른 수를 들 수 있는 자리가 생긴다(#1479 가 이름을
    // 만들어 놓고 정작 이 줄은 안 고쳤다 — 회전 1 M4).
    paddingHorizontal: INPUT_PAD_X,
    paddingTop: INPUT_PAD_Y,
    paddingBottom: INPUT_PAD_Y,
    borderRadius: radius.md,
    borderWidth: INPUT_BORDER,
    borderColor: color.border,
    backgroundColor: color.surface,
    // 16 is where iOS stops zooming a focused field; anything smaller makes the
    // whole screen lurch the first time someone taps to type.
    fontSize: font.body,
    color: color.text,
    // 스케일에서 나온다. 옛 값 21 은 `font.body`(16) 옆의 손으로 적은 숫자였고,
    // 같은 크기 글자가 화면의 다른 자리(본문·「작업 중」)에서는 22 를 썼다.
    //
    // 이 값이 `composerMaxHeight` 의 첫 항이기도 하다 — 다만 **선언된 22 가
    // 아니라 화면에 그려지는 22 × 글자 배수**가. iOS 가 선언된 줄 상자에 동적
    // 타입 배수를 곱하므로(머리말의 `RCTAttributedTextUtils` 인용) 상한도 같은
    // 배수를 곱해야 같은 줄 수를 뜻한다. 그것이 #1443 이 고친 자리다.
    lineHeight: line.body,
  },
  send: {
    minHeight: TOUCH_TARGET,
    minWidth: 64,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.accent,
  },
  /**
   * 프로브가 서는 자리 (#1479). **절대 배치**라 이 컴포넌트의 세로를 한 픽셀도
   * 안 밀고, 투명이라 안 보이며, `pointerEvents="none"` 이라 안 잡힌다. 높이를
   * 안 주는 것이 요점이다 — 자가 상자에 갇히면 잰 줄 수가 상자의 것이 된다.
   */
  probeHost: {position: 'absolute', top: 0, left: 0, opacity: 0},
  /**
   * 프로브의 **조판**. 아래 `input` 과 같은 글자·같은 줄 상자여야 하고, 줄바꿈
   * 전략은 이 스타일시트가 못 드는 prop 이라 컴포넌트가 같은 값을 든다
   * (`lineBreakStrategyIOS="hangul-word"`). 폭은 입력창의 실측에서 나오므로
   * 여기 없다.
   */
  probe: {fontSize: font.body, lineHeight: line.body},
  sendDisabled: {backgroundColor: color.border},
  sendPressed: {backgroundColor: color.accentPressed},
  sendLabel: {color: color.onAccent, fontSize: font.label, fontWeight: '700'},
  sendLabelDisabled: {color: color.textFaint},
  /**
   * 후보 시트 (#1480). **`maxHeight` 는 여기 없다** — 글자 배수와 창 높이가
   * 정하므로 컴포넌트가 `mentionSheetMaxHeight` 로 계산해 붙인다(입력창이 같은
   * 이유로 같은 일을 한다). 옛 판의 `maxHeight: 180` 은 도출되지 않은 상수였고,
   * 그것이 무엇을 틀렸는지는 위 「시트의 상한」 절에 있다.
   */
  mentions: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  /**
   * 후보 한 행. `minHeight` 는 엄지의 바닥이고, 큰 글자에서 행의 높이를 정하는
   * 것은 아래 두 조각이 선언한 줄 상자다 — 그 산수가 `mentionRowHeight` 다.
   */
  mentionRow: {
    minHeight: TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: SAFE_GUTTER,
  },
  // 세 조각이 **한 줄로 읽혀야** 하므로 셋 다 `line.head` 를 선언한다 — 그
  // 토큰이 존재하는 이유가 정확히 이 모양(13pt 이름 + 12pt 보조)이고, 선언이
  // 없으면 RN 이 광학 중심으로 어긋나게 놓는다(`tokens.ts` 의 실측). 그 선언이
  // `mentionRowHeight` 의 산수가 화면과 같은 수를 쓰는 근거이기도 하다.
  //
  // ## 행은 넘치는 대신 **잘리고**, 잘린 조각은 **앞을 남긴다**
  //
  // 옛 판에서 양보할 수 있는 조각은 `mentionHandle` 하나뿐이었다(Yoga 의
  // `flexShrink` 기본값은 0 — 이 트리의 `AgentDetailScreen.tsx` 가 그 사실을 자기
  // 주석에 적어 두었다). 그래서 긴 한글 이름 + 행 끝의 「에이전트」 조합에서 행은
  // 잘리는 대신 **넘쳤고**, 넘쳐서 화면 밖으로 나가는 것은 표지였다(캡처
  // `dock1480-mention-sheet-axxl-before-dark.png` 의 첫 줄).
  //
  // 회전 1 은 그 넘침을 잡으면서 「조용히 사라지는 조각이 있어서는 안 된다」를
  // 원칙으로 세웠는데, **그 판의 렌더가 그 원칙을 어겼다**(회전 2 H). 핸들에
  // `flex: 1` 이 붙어 있었기 때문이다 — `flex: 1` 은 `flexBasis: 0` 이라 핸들은
  // 압력이 오기 전부터 **자기 폭이 없는 조각**이고, 남는 자리만 먹는다. 자리가
  // 모자라면 줄어드는 것이 아니라 처음부터 0 이다. 사진이 그대로 든다:
  // `dock1480-mention-sheet-ax-*.png`(2.143)의 첫 행에 핸들은 맨 「@」 한 글자로
  // 남고 생략부호도 없으며, `axxl-*`(3.143)에는 **아예 없다** — 회전 1 이 옛 판의
  // 결함으로 서술한 바로 그 모양이다.
  //
  // 사라지는 것이 **유일한 식별자**라 이것은 미관이 아니다. 삽입되는 값은 핸들이고
  // (`mentionQuery.ts`: *the ACCEPTED value is always the handle*), 표시 이름은
  // 유일하지 않다 — 이 레포는 그 사실에 이름까지 붙여 뒀다(코어의 `isAmbiguousName`,
  // 폰의 `features/sidebar/rows.ts` 가 「이름이 모호하면 핸들을 딸려 보낸다」를
  // 구현하고, `SidebarScreen` 의 「두 김인턴」 주석이 실제 사례다). 게다가 후보는
  // 정렬돼 있지 않아(`matchMembers` 는 거르고 자를 뿐이다) 「첫 줄이 내가 부른
  // 사람」이라는 대안 근거도 없다.
  //
  // ## 양보 순서 — 형제 셋과 **같은 문법**으로
  //
  // 같은 모양(이름 + @핸들)을 이미 푼 형제가 셋인데(`AgentsScreen` ·
  // `SidebarScreen` · `HostedConnectionsScreen`), 셋 다 `rowTitle` 과 `rowHandle`
  // 에 **둘 다 `flexShrink: 1`** 을 주고 그 둘을 `flex: 1` 짜리 묶음(`rowText` +
  // `rowTitleLine`)에 넣는다. 두 조각이 각자의 폭에 비례해 함께 내므로 **둘 다
  // 앞을 남긴다.** 이 행도 이제 같다:
  //
  //   `mentionIdentity`  `flex: 1`      묶음이 자란다 → 표지가 행 끝에 선다
  //   `mentionName`      `flexShrink: 1` 폭에 비례해 낸다
  //   `mentionHandle`    `flexShrink: 1` 폭에 비례해 낸다
  //   `mentionKind`      `flexShrink: 0` 안 낸다
  //
  // 묶음이 `flex: 1`(basis 0)이라 표지는 자기 폭을 그대로 받고 묶음이 나머지를
  // 받는다 — 세 조각의 양보량이 이 네 줄로 결정된다. 실측(874pt 창, 첫 행이 이
  // 앱에서 가장 긴 이름 `프로덕트디자인 김인턴 / @product-design-intern`):
  //
  //   2.143   「프로덕트…」  「@product-…」  「에이전트」
  //   3.143   「프로…」      「@pro…」       「에이전트」
  //
  // ## 표지의 `flexShrink: 0` 은 판정이 아니라 **못이다**
  //
  // 회전 1 은 이 줄을 두 판의 사진 비교로 정당화했다(「표지도 줄이면 「에…」가
  // 되는데 그것은 뜻이 없다」). **그 논증은 이제 두 군데서 안 선다**(회전 2).
  //
  // ① 근거가 틀렸다. 이 표지의 어휘는 단일값이라(`kind === 'agent'` 일 때
  //    「에이전트」 하나 — `MENTION_AGENT_KIND`) 잘려도 **존재만으로 정보가
  //    완결된다.** 「에…」는 「무엇이 있었다」가 아니라 그냥 「에이전트」다.
  // ② 비교 자체가 재현되지 않는다. 위 구조에서는 행에 음의 여유가 **아예 안
  //    생긴다** — 묶음이 basis 0 이라 표지가 제 폭을 먼저 받고 남는 것을 묶음이
  //    받으므로, 압력은 전부 묶음 안에서 풀린다. 그래서 표지를 `flexShrink: 1` 로
  //    바꿔 같은 크기에서 다시 찍어도 사진은 **한 픽셀도 안 변한다**(회전 2 에서
  //    실제로 찍어 확인했다).
  //
  // 그러니 이 줄은 판정의 결과가 아니라 **못**이다. 표지가 실제로 줄어들 수 있는
  // 띠는 표지 혼자 행보다 넓어져 묶음이 0 으로 무너지는 자리뿐이고, 거기서 잘린
  // **상수** 표지는 어휘가 아니라 **버그로 읽힌다** — 모든 에이전트 행에 같은
  // 자리에서 같은 말줄임이 서므로 화면이 고장 난 것으로 보이고, 그 대가로 사는
  // 것은 이름 몇 글자뿐이라 거래가 남는 게 없다.
  //
  // 그 띠가 오늘 배송되지 않는다는 것도 재서 안다. 최악 조건은 **가장 좁은 창**
  // 이다: SE(375pt)의 텍스트 예산은 327pt, 아이패드 Slide Over(320pt)에서는
  // 272pt 이고, 「에이전트」는 배수 3.571 에서도 ~171pt 다(캡처 역산 ~145pt
  // @3.143). 가장 좁은 창에서도 표지 뒤에 100pt 가 남아 묶음이 0 으로 안 무너진다.
  // `flexShrink: 0` 을 **적어 두는** 이유는 그것이 Yoga 기본값이라서가 아니라, 이
  // 문단을 읽은 사람만 이 줄을 지우게 하려는 것이다.
  /**
   * 이름 + 핸들의 묶음 — 형제 셋의 `rowText`/`rowTitleLine` 과 같은 것.
   *
   * `flex: 1` 이라 표지가 자기 폭을 다 받고 이 묶음이 나머지를 받는다. 안에서
   * 두 조각이 폭에 비례해 함께 줄어드는 것이 위 절의 요점이다.
   */
  mentionIdentity: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  mentionName: {
    flexShrink: 1,
    fontSize: font.label,
    lineHeight: line.head,
    fontWeight: '600',
    color: color.text,
  },
  mentionNameAgent: {color: color.agent},
  mentionHandle: {
    flexShrink: 1,
    fontSize: font.meta,
    lineHeight: line.head,
    color: color.textFaint,
  },
  // `numberOfLines={1}` 도 이 조각에 붙는다(컴포넌트 쪽). 위 판정이 뒤집혀
  // 표지가 줄어들게 되는 날, 한 줄로 안 묶인 표지는 접히고 접힌 행은 정수 행
  // 산술(`mentionRowHeight`)이 세는 높이를 넘는다 — 이 배치가 세운 것이 바로 그
  // 산술이다. 그래서 못은 지금 박아 둔다.
  mentionKind: {
    flexShrink: 0,
    fontSize: font.meta,
    lineHeight: line.head,
    color: color.agent,
  },
  hint: {
    paddingHorizontal: SAFE_GUTTER,
    paddingTop: space.sm,
    fontSize: font.meta,
    color: color.textFaint,
  },
  /**
   * 「지금은 못 보낸다」 한 줄. **앰버가 아니다** (U4-6 리뷰 M-2).
   *
   * 이 줄과 승인 카드의 오프라인 줄은 같은 종류의 말이다 — 코어가 이름까지
   * 붙여 두었다(`ApprovalNoteTone` 의 `blocked`: *"지금은 못 한다. 사고가
   * 아니라 **때**의 문제이므로 위험 색이 아니지만, 조용한 안내로 묻히면 사람이
   * 버튼을 계속 누른다"*). 그런데 같은 배치에서 승인 쪽은 `color.text`/400 으로
   * 서고 이 줄만 `color.warn` 이었다. 한 화면 안에서 같은 말이 두 옷을 입는다.
   *
   * ## 어느 쪽으로 맞췄나 — **앰버를 뺀다**
   *
   * 이 팔레트의 앰버는 「사람이 할 일이 남아 있다 · 여기를 보라」 **한 뜻**이고
   * (`tokens.ts` 의 `warn`), 상태 칩의 「승인 대기」와 D-2 의 미읽 경계가 그 한
   * 뜻의 두 사례다. 「지금은 못 보낸다」는 그 반대말이라 — 부르는 말이 아니라
   * 아무도 부르지 않는다는 말이라 — 여기에 앰버를 주면 한 색이 부름과 차단을
   * 동시에 뜻하게 된다. `MessageRow.tsx` 의 `buildApprovalNoteStyle` 주석이
   * 「일시적 차단에 앰버를 주는 안」을 같은 이유로 이미 기각했고, 그 기각을
   * 여기서 뒤집을 근거가 없다. 반대 방향(승인 줄을 앰버로)은 그 결정을 되돌리는
   * 일이고, 되돌릴 이유는 「컴포저가 먼저 그렇게 적혀 있었다」뿐이다.
   *
   * 잃는 것: 이 줄이 덜 튄다. 잃지 않는 것: **눈에 띄어야 하는 이유**는 색이
   * 아니라 자리가 진다 — 이 문장은 사람이 지금 보고 있는 입력창 바로 아래,
   * 꺼진 전송 버튼 옆에 선다. `textFaint` 를 쓰는 위 `hint` 와는 갈라져 있고
   * (그쪽이 「읽어도 안 읽어도 되는」 축이다), 그 대비가 승인 카드에서 이미
   * 검증된 3단(`text` 600 / `text` 400 / `textMuted`)의 가운데다.
   *
   * 웹은 `text-warn` 을 그대로 둔다. 톤 **이름**은 코어가 지고 색은 각 클라의
   * 팔레트가 정한다는 것이 `approvalNote.ts` 의 계약이고, 웹은 자기 안에서 이미
   * 정합이다(그 클라의 승인 blocked 도 `text-warn` 이다). 여기서 고치는 것은
   * **폰 안에서 갈라진 두 줄**이지 두 클라의 색이 아니다.
   *
   * #1429 가 그 분기를 다시 물었고 판정은 같았다: 웹의 `--warn` 은 「지금은
   * 정상이 아니다」로 비어 있고 이 앱의 `warn` 은 「여기를 보라」로 차 있으므로,
   * 한 규칙(차단은 부름이 아니다)이 두 팔레트에서 다른 토큰으로 답한다. 근거는
   * 코어 `approvalNote.ts` §색 계약이고, 그 답이 갈라지지 않게 지키는 것이
   * `approvalCard.test.tsx` 의 대조 고정 단정이다.
   */
  offline: {
    paddingHorizontal: SAFE_GUTTER,
    paddingTop: space.sm,
    fontSize: font.meta,
    color: color.text,
  },
  pressed: {backgroundColor: color.surfacePressed},
});
