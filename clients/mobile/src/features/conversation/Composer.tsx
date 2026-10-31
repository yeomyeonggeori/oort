import {ExpressionComposerModal} from '../expressions/ExpressionComposerPicker';
import {useEmojiTriggerFocus} from '../emoji/useEmojiTriggerFocus';
import {EXPRESSION_ICONS} from '../../design/icons/expressionIcons';
import {dmAdmissionCandidates, dmAdmissionHint} from '@momo/core/features/agents/dmAdmission';
import type {Channel} from '@momo/core/lib/api';
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
import type {RecipientKind} from '@momo/core/lib/koreanParticle';
import {
  containsSecretKey,
  SECRET_KEY_BLOCK_COPY,
} from '@momo/core/features/chat/secretKey';
import {
  slashCommands,
  type Command,
  type LocalCardArgs,
} from '@momo/core/features/commands/registry';
import {
  parseSlashCommand,
  slashCandidates,
  slashCommandById,
  type SlashCandidate,
} from '@momo/core/features/commands/slash';

// 폰의 슬래시 목록. `/앱`처럼 폰에 갈 화면이 아직 없는 명령은 서지 않는다(#3950).
// 서버 표면 판정은 부르는 때 읽는다(앱 기동 중 호스트가 설치되기 전에 굳지 않게).
const phoneSlashCommands = () => slashCommands({platform: 'phone'});
import type {Directory} from '@momo/core/features/workspace/directory';
import {composerAgentNotice, mentionAnnotation} from '@momo/core/features/ai/aiMention';
import {calledAgents, mentionRoutingTarget} from '@momo/core/features/routing/mentionTargets';
import {
  mentionHandleLabel,
  preferredMentionName,
} from '@momo/core/features/routing/helperAliases';
import React, {useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  Animated,
  Image,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
  type TextLayoutEventData,
} from 'react-native';
import {font, line, radius, SAFE_GUTTER, slopTo, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {useKeyboardAppearance, usePalette, useStyles} from '../../design/theme';
import {GlassSurface, useGlassMaterial} from '../../design/glass';
import {CONV_ICONS, CONV_ICON_SIZE, HOME_ICONS} from '../../design/icons';
import {CARD_ICONS} from '../../design/icons/cardIcons';
import {isPhoneSlashRow} from '../aiConnect/AiConnectCard';
import {CONV, composerFloat, PHONE_COMPOSER_MAX_ROWS as COMPOSER_MAX_ROWS} from './convDesign';
import {DockFollowContext} from './dockFollow';
import {COMPOSER_INPUT_TYPOGRAPHY, useComposerInputLayout} from './useComposerInputLayout';
import {clearDraft, readDraft, saveDraft} from './drafts';
import {Avatar} from './Avatar';
import {
  applyMention,
  caretAfterChange,
  matchMembers,
  mentionQueryAt,
} from './mentionQuery';
import type {QuoteDraft} from '@momo/core/features/timeline/quote';
import {QuoteDraftBar} from './Quote';
import {ReplyDraftCard} from './ReplyDraftCard';
import {useReplyCopy} from './replyCopy';
import type {ReplyTarget} from './replyTarget';
import {AttachMenu} from '../attachments/AttachMenu';
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
import {
  pickCamera,
  pickDocument,
  pickPhoto,
  type PickedAttachmentFile,
} from '../attachments/picker';
import {photoRoom} from '../attachments/photoLibrary';
import {nativePhotoPorts} from '../attachments/photosNative';
import {
  COMPOSER_EXPAND_SPRING,
  MENU_CLOSE_WATCHDOG_MS,
} from '../../design/motion';
import {haptics} from '../../lib/haptics';
import {useReduceMotionRef} from '../../lib/useReduceMotion';

export {PHONE_COMPOSER_MAX_ROWS as COMPOSER_MAX_ROWS} from './convDesign';

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
//   MAX_ROWS(5) × line.body(23) + 위아래 패딩(8·8) + 테두리(1·1) = 133 (#3774: 22 → 23, 128 → 133)
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
// #4790 현행: 폰 네 줄, 전체 상한에 도구 줄 44pt·알약 크롬 포함, 열 몫 .65.
// 아래 #1443·#1480 실측 숫자는 당시 5줄·열 몫 .5의 역사이고 현행 상수는 아래 함수다.
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

/** 작은 창·큰 글자에서도 편집 중인 줄과 그 앞 줄을 남긴다. */
const MIN_ROWS = 2;
/** 펼침 도구 줄도 전체 높이 예산 안에 든다(#4467). */
export const COMPOSER_TOOLS_HEIGHT = TOUCH_TARGET;

/** 입력창 상하 패딩 한쪽. 상한 계산과 실제 스타일이 같은 값을 읽는다. */
const INPUT_PAD_Y = space.sm;

/**
 * 입력창 좌우 패딩 한쪽. 위와 짝이고, 이름을 갖는 이유가 하나 더 있다 — 절 예산의
 * 프로브가 **글이 놓이는 가로**를 이 값으로 도출한다(#1479).
 */
//
// 알약 컴포저(DS2-4)에서 12 → 8. 입력창이 이제 따로 선 상자가 아니라 알약 안의
// 글자 자리라, 글이 + 원 바로 옆에서 시작한다(Buzz 실측: 알약 가장자리에서
// 53.7~54.3pt, 이 값으로 9 + 36 + 8 + 1 = 54 — #4179 가 원과 여백을 Buzz 값으로 옮겼다).
const INPUT_PAD_X = space.sm;

/**
 * 입력창 테두리 두께. 위와 같은 이유로 이름을 갖는다. 알약 안에서는 **투명**이다
 * (DS2-4) — 두께를 남기는 이유는 상한 산수(`INPUT_CHROME`)와 줄 상자 정렬을 옛
 * 판과 같게 두기 위해서이고, 선이 보이면 알약 안에 상자가 하나 더 선다.
 */
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
 * 키보드와 크롬을 뺀 대화 열에서 펼친 알약이 가져가는 최대 몫.
 * #4790의 네 줄·도구 줄을 SE에서도 담도록 0.65로 조정했다.
 * 큰 글자에서는 편집 두 줄 바닥이 우선하며 실제 목록 몫은 스택 검증에서 잰다.
 */
// 기본 글자 SE(667pt)에서도 네 줄 + 도구 줄 + 알약 여백(164pt)이 든다:
// 667 × (1 − .38 − .23) × .65 = 169pt. 큰 글자는 두 줄 바닥이 우선한다.
const COMPOSER_COLUMN_SHARE = 0.65;

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
 * 펼친 알약 전체 상한(글 칸 + 44pt 도구 줄 + 알약 위아래 여백·선).
 * 네 줄과 창 예산 중 작은 값이며, 고지가 없으면 편집 두 줄 바닥을 지킨다.
 * 고지가 보이는 큰 글자에서는 입력 한 줄을 남기고 나머지를 스크롤한다.
 * 입력창에는 이 값에서 도구 줄과 알약 크롬을 뺀 값을 준다.
 */
export function composerExpandedMaxHeight(
  fontScale: number, windowHeight: number, agentNoticeShown = false,
): number {
  const row = line.body * fontScale;
  const chrome = INPUT_CHROME + COMPOSER_TOOLS_HEIGHT + PILL_CHROME;
  const byRows = COMPOSER_MAX_ROWS * row + chrome;
  const byWindow = conversationColumn(windowHeight) * COMPOSER_COLUMN_SHARE;
  const normalMax = Math.max(MIN_ROWS * row + chrome, Math.min(byRows, byWindow));
  if (!agentNoticeShown) return normalMax;
  // #4790: the notice shares this column with the expanded pill. Reserve its
  // visible scaled lines AND top padding before assigning the editor's height.
  // At AX sizes keep one whole editor row and scroll the rest. On SE the notice
  // itself scrolls when two notice rows and one editor row cannot coexist.
  const noticeRoom = conversationColumn(windowHeight) - CONV.composerTopAir -
    composerAgentNoticeMaxHeight(fontScale, windowHeight);
  const oneRowPill = composerCollapsedHeight(fontScale) + COMPOSER_TOOLS_HEIGHT + PILL_CHROME;
  return Math.max(oneRowPill, Math.min(normalMax, noticeRoom));
}

export function composerMaxHeight(
  fontScale: number, windowHeight: number, agentNoticeShown = false,
): number {
  return composerExpandedMaxHeight(fontScale, windowHeight, agentNoticeShown) - COMPOSER_TOOLS_HEIGHT - PILL_CHROME;
}

/** Two notice lines normally; one scrollable line when SE + AX needs the space. */
export function composerAgentNoticeMaxHeight(fontScale: number, windowHeight: number): number {
  const oneEditorRow = composerCollapsedHeight(fontScale);
  const room = conversationColumn(windowHeight) - oneEditorRow - DOCK_CHROME - AGENT_NOTICE_PAD_TOP;
  const rows = Math.max(1, Math.min(AGENT_NOTICE_MAX_LINES, Math.floor(room / (line.meta * fontScale))));
  return rows * line.meta * fontScale + AGENT_NOTICE_PAD_TOP;
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
  annotated = false,
  agentNoticeShown = false,
): ComposerColumnBudget {
  const column = conversationColumn(windowHeight);
  const composer = composerMaxHeight(fontScale, windowHeight, agentNoticeShown);
  return {
    keyboard: windowHeight * KEYBOARD_WINDOW_SHARE,
    chrome: windowHeight * CONVERSATION_CHROME_WINDOW_SHARE,
    column,
    composer,
    list: column - composer,
    dockChrome: DOCK_CHROME + (agentNoticeShown ? AGENT_NOTICE_PAD_TOP : 0),
    mentions: mentionSheetMaxHeight(fontScale, windowHeight, annotated),
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
//   시트 180 + 입력창 170.4 + 바 여백 16 = **366.4pt**   (#4179 이후 바 여백이 18 → 368.4)
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
//        목록 몫 340.9 − 입력창 133.0 − 도크 크롬 18.0 = 189.9pt   (#4179 전 16.0 → 191.9)
//        ⌊189.9 ÷ 44⌋ = 4          (다섯 행은 220pt 라 안 든다)
//
// 둘이 같은 수를 가리키므로 이 배치는 「몇 개를 보여 주는가」를 **안 바꾼다** —
// 바꾸는 것은 다섯째 행의 이마 4pt 와, 큰 글자에서 열을 넘던 초과분이다.
//
// 그리고 상한이 **실제로 무는 창은 큰 것들뿐이다**: **배수 1 에서** 열이 다섯
// 행을 허락하려면 창이 951pt 를 넘어야 하고(⌊(h × 0.39 − 133 − 18) ÷ 44⌋ ≥ 5 — #4179 전 946),
// 그 조건을 만족하는 배송 높이는 956 · 1024 · 1032 · 1180 · 1366 이다(가장 큰
// 아이폰과 아이패드들 — 테스트가 그 목록을 값으로 든다). **문턱은 배수를 따라
// 움직인다**: 사다리 아래쪽에서는 입력창이 작아져 열이 더 일찍 다섯 행을 허락하고
// (0.823 에서 899pt — 926 도 문다), 위쪽에서는 늦어져 3.571 에서는 어느 배송
// 높이도 안 문다. 951 을 한정 없이 적으면 그 움직임이 안 보인다(회전 2). 상한이
// 무는 자리에서 넷이 하는 일은 도크가 창 크기를 따라 메뉴로 자라지 않게 잡는
// 것이다. 그 아래에서는 열이 먼저 물고, 그 위는 스크롤이 받는다(시트는
// `ScrollView` 다).
//
// **이 결정은 표면 한정이다.** 웹은 같은 물음에 다르게 답한다 — 상한 없이
// 후보 상한(6) 을 전부 띄운다(웹의 `COMPOSER_CANDIDATE_LIMIT`,
// `clients/web/src/features/chat/composerAutocomplete.ts` — #1930 이 세 트리거의
// 한 상한으로 옮겼다).
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
// 기본 크기에서는 몫이 한 번도 안 걸린다: 874pt 창에서 목록 몫 207.9 − 18 = 189.9
// 이고 4행은 176 이다. **화면이 4행 그대로다** — 사라지는 것은 이마 4pt 뿐이다.
// =============================================================================

/**
 * 알약의 선. 리퀴드 글래스에서는 투명이지만(네이티브 가장자리가 따로 있다 — 아래 `pillLiquid`)
 * **두께는 남아** 안쪽 산수를 먹는다. 그래서 안쪽 줄 여백이 그만큼 덜어 낸다 — 선 + 여백 =
 * `composerGap` 이라야 원이 **바깥 가장자리**에서 사방 9 만큼 떨어진다(#4179, 동심).
 */
const PILL_EDGE = StyleSheet.hairlineWidth;

/** 알약 좌우 안쪽 여백(`styles.bar`) — 선 + 이 값 = 원 ↔ 알약 가장자리. */
const BAR_PAD_X = CONV.composerGap - PILL_EDGE;

/**
 * 알약 위·아래 안쪽 여백(`styles.bar`). 위 여백에서 입력창 한 줄(엄지 바닥 44)이 원 둘레에
 * 이미 더하는 몫 `(44 − 36) / 2 = 4` 를 한 번 더 뺀 것이다 — 그래서 한 줄일 때 원의 위·아래
 * 여백이 좌·우와 같은 9 가 된다. 입력창을 44 로 두는 이유는 글 칸의 엄지 바닥이고, 글 세로
 * 중심이 원 중심에 앉는 정렬(실측: 전·후 모두 0.2~0.3pt 아래)도 그 높이에서 나온다 — 알약을
 * 키우려고 입력창을 키우면 그 정렬이 깨진다.
 */
const BAR_PAD_Y = BAR_PAD_X - (TOUCH_TARGET - CONV.composerCircle) / 2;

/**
 * 글 칸 밖의 세로: 알약 선·위아래 여백 + 펼침 도구 줄 44pt + 도크 위 여백.
 *
 * 상수로 이름을 갖는 이유는 `INPUT_CHROME` 과 같다: 산수와 실제 스타일이 같은 값을
 * 읽어야 하고, 사본을 두면 사본이 거짓말한다(디자인 시스템 §5.5).
 */
export const PILL_CHROME = (PILL_EDGE + BAR_PAD_Y) * 2;
const DOCK_CHROME = PILL_CHROME + COMPOSER_TOOLS_HEIGHT + CONV.composerTopAir;
const AGENT_NOTICE_MAX_LINES = 2;
const AGENT_NOTICE_PAD_TOP = space.sm;

/** 알약 안 두 원(36)을 엄지 44 로 만드는 여유 — 도출한다(감사 M-14). */
const ATTACH_SLOP = slopTo(CONV.composerCircle);
const SEND_SLOP = slopTo(CONV.composerCircle);

// ---- 두 상태 (#4305 → #4456 → #4518) ------------------------------------------
// 입력창은 **접힘**(한 줄 알약: + · 글 · 보내기)과 **펼침**(글 칸 위, 도구 줄 아래: + 가 왼쪽 아래,
// 보내기가 오른쪽 아래)을 오간다 (Buzz `compose_bar` 의 `isExpanded`). 펼침의 조건은 **누르는 중** 또는
// **포커스가 있다** 또는 **글이 있다**(`pressing || focused || text !== ''`)다.
//
// #4305 는 글이 있을 때만 펼쳤다: 「포커스로 펼치면 보내서 비는 순간 같은 프레임에 한 줄로 돌아오는 것이
// 키보드가 떠 있는 동안 성립하지 않는다」(owner 10-24, iOS 3053 실기 — 보낸 직후에도 포커스는 그대로다).
// owner 10-25 가 그 결정을 뒤집었다(「치기 시작해야 바뀌는 게 아니라 포커싱만 돼도」). 그 근거가 풀리는 까닭은
// **두 축이 갈라져 있어서**다. 알약이 펼쳐지는가(`expanded` — 포커스 또는 글)와 글 칸의 높이를 한 줄로 못 박는가
// (`text === ''` — 아래 `TextInput` 의 `height`)는 다른 문제고, 보낸 뒤 두 줄 높이가 남던 결함을 고친 것은 뒤쪽의
// 못 박기다. 그래서 포커스가 남은 채 보내면 글 칸은 한 줄로 못 박힌 채 도구 줄만 남는다 — **빈 펼침 높이**
// (한 줄 + 도구 줄)다. 여러 줄 높이는 남지 않는다.
//
// 접힘은 포커스를 잃고(`onBlur` — 끌어 내리기·`Keyboard.dismiss`·다른 화면으로 감이 모두 이 길이다) 글도 없을
// 때다. 글이 남아 있으면 포커스를 잃어도 펼친 채다 — **단 하나의 길만 예외다(#4614, owner 10-26)**: 대화 목록을 눌러 입력창을 쉬게 하면(`dockFollow.rest`) 글이 있어도
// 접힌다. 글은 지우지 않고(초안 유지) 접힌 알약이 첫 줄을 보인다. 쉬는 상태는 **사용자가 다시 닿을 때까지**(포커스)다 — 글이 그 사이에 바뀌어도 이어진다(자판을 내리며 iOS 가 자동 고침·조합 중인 글자를
// 확정하는 `onChangeText` 가 쉬라는 알림 **뒤에** 도착한다: 시뮬레이터 실측 「Teh」→「The」). 펼침은 **입력창이 포커스를 쥔 동안**이지 키보드가 보이는
// 동안이 아니다 — 하드웨어 키보드로 캐럿이 서 있을 때도 펼침이다. 키보드만 내려가고 포커스가 남는 길(앱이 백그라운드로
// 갔다 옴·하드웨어 키보드)은 일부러 듣지 않는다: 포커스가 곧 「입력 중」이고, iOS 는 돌아올 때 자판을 되살린다.
//
// **누르는 순간 시작한다**(#4518, owner 10-25 「누르는 순간 바로」). 포커스 이벤트는 손을 뗀 뒤 RN 의 `onPress → focus()` · 네이티브를 돌아 JS 에 닿아서
// 첫 포커스에서 `keyboardWillShow` 보다도 39~120ms 늦었다(#4456 실측) — 펼침이 키보드를 뒤따랐다. 그래서 손가락이 입력창에 닿는 순간(`composer-field` 의
// `touchStart`)에 펼침을 시작한다. 단 **누름은 약속이지 사실이 아니다**: 탭이 포커스로 이어지지 않으면 되돌린다 — 손가락이 `PRESS_DRAG_SLOP_PT` 를 넘게
// 움직임(끌기) · 터치 취소 · 손을 뗀 뒤 `PRESS_FOCUS_GRACE_MS` 안에 `onFocus` 가 안 옴. 손이 닿아 있는 동안에는 시간이 흘러도 되돌리지 않는다(길게 누르면
// 포커스는 손을 뗄 때 온다). 포커스가 오면 `pressing` 이 `focused` 로 **한 묶음**에 넘어가 스프링이 끊기지 않고, 이미 포커스이거나 글이 있어 펼쳐져 있으면
// 누름은 아무것도 하지 않는다(렌더·타이머·스프링 0). 햅틱은 없다(#4331).
//
// **끌기는 포커스로 이어지지 않는다**(#4518 D2). 접힌 빈 입력창에서 문턱을 넘겨 끌린 손은 되돌리는데, iOS 는 그 손을 **뗄 때** 입력창에 포커스를 줘서(끌었어도 — 시뮬레이터 4방향 실측)
// 되돌린 입력창이 다시 펼쳐졌다. JS 에서 응답자를 가져가도 막히지 않아서(`onPress` 는 안 오는데 포커스는 왔다) 끌기를 알아챈 즉시 `TextInput` 을 `editable={false}` 로 잠그고 손을 뗀 뒤
// `PRESS_DRAG_LOCK_RELEASE_MS` 에 푼다. 이미 포커스이거나 글이 있으면 누름이 서지 않으므로 잠기지도 않는다.
//
// 접힘의 **움직임**은 이유에 따라 갈린다. 포커스를 잃어서(또는 누름이 포커스로 이어지지 않아 되돌릴 때) 접힐 때는 펼침과 같은 스프링으로 줄어든다(자판이 내려가기
// 시작하는 프레임에 알약이 44pt 한 번에 줄면 그 위 대화가 통째로 튄다 — 녹화 프레임으로 확인). 포커스 없이 글이 비어서
// 접힐 때(포커스 없이 보냄·지움)는 같은 프레임이다 — 위 owner 10-24 결함을 애니메이션으로 가리지 않는다.
//
// 두 원은 어느 상태에서도 **알약 바닥에서 같은 자리**에 선다(절대 배치). 알약이 위로 자라고 도구 줄이
// 그 아래 원 곁에 생기므로 「+ 가 왼쪽 아래로 내려간다」는 인상은 글 칸이 원 위로 넓게 펼쳐지는
// 것으로 온다 — 하나의 `TextInput` 이 두 상태에서 **같은 자리에 마운트된 채** 남아 포커스·IME 조합을
// 잃지 않는다(부모를 바꾸면 다시 마운트된다).
//
// 도구 줄 구성 근거: Buzz 는 + · @ · # · 이모지 · 서식, Claude 앱은 + · 모델 알약 · 마이크 · 음성 모드다.
// 이 앱에서 지금 **실제로 하는 일이 있는 것**만 둔다 — 「+」(첨부)와 「@」(멘션: 위젯이 없는 iOS 에서
// 입력창이 이미 가진 멘션 후보를 연다). 이모지는 자판의 지구본으로 이미 되고(앱에 따로 고르개가 없다),
// 서식은 이 입력창이 마크다운을 그대로 쓰는 곳이라 할 일이 없다. 마이크는 #4306 이 `TOOL_SLOTS` 에
// 붙는다 — 눌러서 아무 일도 안 하는 버튼은 두지 않는다.
// 펼침 곡선은 `design/motion.ts` 의 `COMPOSER_EXPAND_SPRING` 이다 — 160ms ease-out 과 Buzz 스프링을 키보드 곡선에
// 맞대어 잰 숫자와 고른 근거가 그 절에 있다.
/** 끌어 내리기: 이만큼(pt) 내려가고 세로가 가로의 두 배를 넘으면 자판을 내린다(Buzz `Listener`). */
const DISMISS_DRAG_PT = 28;
/**
 * 누름 (#4518): 누른 손가락이 이만큼(pt) 넘게 움직이면 탭이 아니라 끌기다 — 앞당겨 편 입력창을 거둔다. RN `Pressability` 가 「가만히 누른
 * 손」의 경계로 쓰는 `longPressDeactivationDistance`(10)와 같은 값이다. 이 입력창은 이미 그 눌림 처리 위에 서 있다: RN `TextInput` 은 손을 뗄
 * 때 `onPress → focus()` 를 부른다.
 */
const PRESS_DRAG_SLOP_PT = 10;
/**
 * 누름 (#4518): 손을 뗀 뒤 `onFocus` 를 기다리는 시간(ms). 정상 경로는 손 뗌 → RN `onPress → focus()` → 네이티브 → `onFocus` 이고, 포커스 이벤트가 JS 에
 * 닿는 것은 키보드(`keyboardWillShow`)보다도 39~120ms 늦었다(시뮬레이터 실측, #4456). 그 위에 첫 키보드가 늦게 뜨는 때·JS 가 바쁠 때의 꼬리를 얹은 값이다.
 * **짧으면 정상 경로의 탭이 접혔다 되살아나고, 길면 포커스가 안 오는 드문 탭이 펼친 채 머무는 시간이 늘 뿐이다** — 그래서 길 쪽으로 잡았다.
 * 손이 닿아 있는 동안에는 이 시계가 돌지 않는다(길게 누르면 포커스는 손을 뗄 때 온다).
 */
export const PRESS_FOCUS_GRACE_MS = 500;
/**
 * 끌기 잠금 (#4518 D2): 손을 뗀 뒤 입력창의 잠금(`editable={false}`)을 푸는 데까지 기다리는 시간(ms). 네이티브는 손을 **뗀 순간**에 포커스를 줄지 정하므로
 * 잠금은 그 순간을 지나서 풀려야 하고, JS 가 손 뗌을 아는 것은 그보다 5~10ms 늦다 — 그 위에 한두 프레임의 여유를 얹은 값이다. 이 사이에 다시 누르면 그 순간 풀린다.
 */
export const PRESS_DRAG_LOCK_RELEASE_MS = 150;
/** 도구 줄에 서는 도구들. 마이크(#4306)·예약 보내기(#4216)·사진 여러 장(#4296)은 여기에 붙는다. */
const TOOL_SLOTS: readonly 'mention'[] = ['mention'];
const TOOL_COPY = {mention: '@로 부르기'} as const;

/**
 * 접힘 상자의 높이 — 글이 비었을 때 입력창이 **명시적으로** 갖는 높이. 엄지 바닥(44)과 한 줄(글자
 * 배수를 곱한 줄 상자 + 세로 크롬) 중 큰 쪽이다. 글이 비면 RN iOS(Fabric)가 멀티라인 입력창의 내재
 * 크기를 다시 재지 않아 두 줄 높이로 남던 것(owner 10-24)을, 높이를 이 값으로 못 박아 같은 프레임에
 * 돌려놓는다.
 *
 * 이름은 접힘이지만 값은 「글이 빈 한 줄」의 높이다(#4456). 포커스로 펼친 **빈** 입력창도 같은 값이다 —
 * 빈 펼침 높이는 이 값 + 도구 줄(`TOUCH_TARGET`)이다.
 */
export function composerCollapsedHeight(fontScale: number): number {
  return Math.max(TOUCH_TARGET, Math.ceil(line.body * fontScale) + INPUT_CHROME);
}

/** 시트가 담는 후보 수. 위 절이 이 넷을 고른 이유를 든다. */
const MENTION_MAX_ROWS = 4;

/** 「아래에 더 있다」 표지가 서는 오른쪽 띠의 폭. */
const MENTION_CUE_GUTTER = 28;

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
/**
 * 슬래시 목록 설명이 접힐 수 있는 줄 수 (#2988). 기본 글씨에서는 한 줄이다(시안).
 * 글씨가 커지면 설명(「AI 계정 카드 열기 · 나에게만 보여요」, 스무 자 안팎)이 한
 * 줄에 들지 않아 말줄임되고, 잘리는 것은 하필 「나에게만」·「운영자」 같은 표지다.
 * 375 폭에서 설명 칸은 ~260pt 이고 글자 폭은 `font.meta × 배수`라, 배수가 2 를 넘는
 * 접근성 크기에서는 두 줄로도 모자란다 — 그래서 2 까지는 두 줄, 그 위는 세 줄.
 */
export function slashHintLines(fontScale: number): number {
  if (fontScale <= 1) return 1;
  return fontScale <= 2 ? 2 : 3;
}

/**
 * 슬래시 목록 한 행의 높이 (design-review #2945 H3). 이름 `line.label` 한 줄 +
 * 설명 `line.meta` × `slashHintLines` 줄과 위아래 여백이 글자 배수를 따라 자라고,
 * 엄지의 바닥은 44다. 목록 상한(`slashListMaxHeight`)이 이 값의 정수배라 설명이
 * 접히는 만큼 여기서 함께 자라야 반 행이 생기지 않는다.
 */
export function slashRowHeight(fontScale: number): number {
  return Math.max(
    TOUCH_TARGET,
    Math.ceil((line.label + line.meta * slashHintLines(fontScale)) * fontScale) +
      space.xs * 2,
  );
}

/** 슬래시 목록 머리(「명령」)의 높이. 행 예산 밖에 선다. */
export function slashHeadHeight(fontScale: number): number {
  return Math.ceil(line.meta * fontScale) + space.sm + space.xs;
}

/**
 * 슬래시 목록이 스크롤하는 칸의 상한 — **온전한 행 단위**다. 멘션 시트와 같은
 * 열 예산에서 머리를 먼저 빼고, 남은 자리를 행 높이로 내림한다(반 행은 이름의
 * 이마만 보여 준다 — 멘션 시트 상한의 그 규칙). 바닥은 두 행.
 */
export function slashListMaxHeight(fontScale: number, windowHeight: number): number {
  const row = slashRowHeight(fontScale);
  const byColumn =
    mentionSheetMaxHeight(fontScale, windowHeight) - slashHeadHeight(fontScale);
  const rows = Math.max(MENTION_MIN_ROWS, Math.min(MENTION_MAX_ROWS, Math.floor(byColumn / row)));
  return rows * row;
}

/**
 * 보조 줄(`쓰는 AI · 부를 수 있는 사람 · 맥 꺼짐`)이 접힐 수 있는 줄 수 (AIH-9b, #3440).
 *
 * 가장 긴 줄(「곽성재 개인 구독 · 곽성재만 부를 수 있어요 · 맥 꺼짐」, 스무 자 남짓)은
 * 오른쪽 칩이 서는 기본 크기에서 왼쪽 칸(~250pt)에 두 줄이 든다. 글자가 커지면
 * 줄 수를 늘리는 대신 **한 줄로 줄이고 말줄임**한다 — 슬래시 목록(`slashHintLines`)과
 * 반대 방향인 이유는 시트가 열린 도크가 열 안에 들어야 해서다(`mentionSheetMaxHeight`):
 * 접근성 크기에서 한 행이 세 줄이면 한 행이 열 몫을 넘는다. 잘린 문장은 읽는 라벨
 * (`accessibilityLabel`)이 끝까지 든다.
 */
export function mentionAnnotationLines(fontScale: number): number {
  return fontScale <= MENTION_TWO_LINE_MAX_SCALE ? 2 : 1;
}

/** 보조 줄이 두 줄까지 접히는 글자 배수의 상한. 그 위는 한 줄. */
const MENTION_TWO_LINE_MAX_SCALE = 1.3;

/**
 * 입력창 위 한 줄(최대 두 줄)이 문장 전부를 못 담는 글자 배수부터 핵심 절
 * 「보내도 답하지 않아요」를 문장 앞에 둔 코어 변형을 쓴다. 줄 수를 늘리면 도크 예산
 * (`composerColumnBudget`)을 넘으므로 줄을 늘리지 않고 **순서**로 지킨다.
 */
export function noticeEssentialFirst(fontScale: number): boolean {
  return fontScale > MENTION_TWO_LINE_MAX_SCALE;
}

/**
 * 오른쪽 칩이 서는 글자 배수의 상한. 그 위(접근성 크기)는 칩이 왼쪽 칸의 폭을 반 넘게
 * 먹어 이름·보조 줄이 두세 글자씩 접힌다 — 칩이 말하는 것은 보조 줄이 이미 말하고
 * 있으므로(둘 다 코어 `aiAgentLabels` 의 같은 사실) 칩을 접는다.
 */
const MENTION_BADGE_MAX_SCALE = 2;

export function mentionRowHeight(fontScale: number, annotated = false): number {
  if (!annotated) return Math.max(TOUCH_TARGET, line.head * fontScale);
  // 이름 한 줄(`line.head`) + 보조 줄(`line.meta` × 줄 수) + 위아래 여백. 후보 중 하나라도
  // 보조 줄이 있으면 **모든 행이 이 높이**다 — 높이가 섞이면 아래 정수 행 산술이 깨진다.
  return Math.max(
    TOUCH_TARGET,
    Math.ceil((line.head + line.meta * mentionAnnotationLines(fontScale)) * fontScale) +
      space.xs * 2,
  );
}

/**
 * 시트가 자라기를 멈추는 높이 — **넷, 그리고 열이 허락하는 만큼.**
 *
 * `composerMaxHeight` 과 같은 모양이고 같은 이유로 export 된다: 계측 하네스와
 * 테스트가 이 산수를 **다시 적지 않고** 읽는다.
 *
 * `annotated` (AIH-9b): 후보에 AI 보조 줄이 든 시트. 행이 두 줄이라 같은 열에 덜
 * 들어가므로 **바닥이 한 행**이다(보통은 둘) — 두 행이 열을 넘는 자리에서 바닥을
 * 지키면 도크가 열 밖으로 나간다. 나머지는 스크롤 막대가 말한다.
 */
export function mentionSheetMaxHeight(
  fontScale: number,
  windowHeight: number,
  annotated = false,
): number {
  const row = mentionRowHeight(fontScale, annotated);
  const minRows = annotated ? 1 : MENTION_MIN_ROWS;
  const byColumn =
    conversationColumn(windowHeight) -
    composerMaxHeight(fontScale, windowHeight) -
    DOCK_CHROME;
  // 열이 허락하는 것을 **행으로 내림**한다 — 반쪽 행은 이름의 이마만 보여 준다.
  const rowsByColumn = Math.floor(byColumn / row);
  return Math.max(minRows * row, Math.min(MENTION_MAX_ROWS, rowsByColumn) * row);
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
// ## #4179 가 이 절의 **문턱**을 바꿨다 — 상자의 글자리에서 알약의 한 줄로
//
// 아래 서술 중 상자 글자리(`composerMaxHeight − INPUT_CHROME`)와 줄 수 실측은 **옛 판**이다.
// 알약이 Buzz 와 같은 40pt 로 떠 글 칸이 214pt 가 되자(402pt 기준) 어떤 안내 문장도 한 줄에 안
// 들고(일반 215.5 · grok 232.3 · 김인턴 243.2 · hermes 256.0), 옛 문턱에서는 그 접힘이 「든다」였으므로
// **빈 알약이 두 줄로 자랐다**(72.7pt, Buzz 53.3pt). 성재 결정(2026-10-21, 「40 + 문장 한 줄」):
// 여백은 Buzz 와 같게 두고 문장을 한 줄로 맞춘다 — 한 줄에 안 들면 뒷절(「@로 부르기」)이 이 절의
// 규칙대로 절 경계에서 빠지고 머리 절만 남는다.
//
//   · 문턱 — `placeholderRoom(fontScale)`: **한 줄**(`PLACEHOLDER_MAX_LINES`). 규칙(`fitComposerPlaceholder`)과
//     프로브 경로는 그대로이고 문장도 새로 짓지 않는다. 바뀐 것은 「든다」의 기준 하나다.
//   · 재기 전 — **머리 절만**. 한 줄 예산에서는 긴 문장이 안 드는 쪽이 흔해서, 문장 전체로 시작하면
//     알약이 두 줄로 섰다가 한 줄로 줄어드는 높이 점프가 흔한 화면이 된다. 머리 절로 시작하면 높이는
//     처음부터 한 줄이고, 드는 창에서는 **글자만** 한두 프레임 뒤에 붙는다.
//   · 큰 글자 — 같은 규칙이다: 문턱이 배수를 따라 커진 줄 상자(`line.body × 배수`) 한 줄이고, 머리
//     절이 한 줄에 안 드는 크기(접근성 크기)에서도 **머리 절은 안 버린다** — 버릴 절이 없다.
//   · 낭독 — 라벨(`accessibilityLabel`)은 보이는 문장이 아니라 필드 이름이라 줄 예산과 무관하다. 다만
//     RN iOS 의 멀티라인 입력창은 빈 칸일 때 「JS 라벨 + 보이는 플레이스홀더」를 읽으므로
//     (`RCTUITextView.mm` 의 `accessibilityLabel`) 뒷절이 화면에서 빠지면 귀에서도 빠진다 — 그래서
//     빠진 절을 코어가 지은 글자 그대로 `accessibilityHint` 로 잇는다(`droppedHint`, 새 문장이 아니다).
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
// `onTextLayout` 이 돌려주는 줄들의 높이를 더해 `placeholderRoom`(한 줄, #4179)과
// 대조한다. 옛 판은 `composerMaxHeight` 이 든 글자리와 대조했다.
//
// **재기 전에는 머리 절이다 (#4179).** 옛 판은 문장 전체로 시작했다: 웹이 같은 방향을 고른
// 이유는 「일단 짧게」로 시작하면 드는 상자에서도 광고가 한 프레임 사라졌다 돌아오기
// 때문이었고, 반대 방향의 대가인 「안 드는 문장이 한 프레임 서는 것」은 이미 오늘의 화면이었다.
// 한 줄 예산에서는 그 두 말이 뒤집힌다 — 안 드는 문장이 흔한 쪽이 돼서 그 한 프레임이 알약의
// 높이 점프가 된다.
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
 * 안내 문장이 설 수 있는 **줄 수** — 한 줄 (#4179, 성재 결정 2026-10-21 「40 + 문장 한 줄」).
 *
 * 옛 예산은 상자가 담는 글자리였고(기본 크기 115pt = 5줄) 그래서 문장은 두세 줄로 접혀도 「든다」였다.
 * 알약이 Buzz 와 같은 40pt 로 뜨면서 글 칸이 214pt 가 되자 그 접힘은 빈 알약이 두 줄로 자라는
 * 일이 됐다. 예산을 상자가 아니라 **알약의 한 줄**로 줄인다: 한 줄에 안 들면 뒷절이 절 경계에서
 * 빠지고 머리 절은 언제나 남는다. 상수로 이름을 갖는 이유는 시험이 「2 로 되돌리면 빨갛다」를
 * 값으로 들기 위해서다.
 */
export const PLACEHOLDER_MAX_LINES = 1;

/**
 * 프로브가 잰 세로(줄 상자 합)와 대조하는 **문턱** — `PLACEHOLDER_MAX_LINES` 줄과 그다음 줄 사이의
 * 한가운데(한 줄 반).
 *
 * 줄 상자는 `line.body` 에 동적 타입 배수가 곱해진 값이고(`composerMaxHeight` 머리말의
 * `RCTAttributedTextUtils` 인용) 프로브는 줄마다 그 높이를 돌려준다. 문턱을 **정확히 한 줄**에
 * 두면 네이티브가 줄 상자를 픽셀 격자에 반올림한 몇 분의 일 pt 때문에 한 줄 문장이 「안 든다」로
 * 뒤집힐 수 있고, 그 오답은 **들어가는 문장의 뒷절을 지운다.** 한 줄과 두 줄은 한 줄 높이만큼
 * 떨어져 있어서 한가운데는 어느 쪽 잡음에도 안 뒤집힌다. export 되는 이유는 계측 하네스와
 * 시험이 같은 문턱을 읽기 위해서다(디자인 시스템 §5.5).
 */
export function placeholderRoom(fontScale: number): number {
  return (PLACEHOLDER_MAX_LINES + 0.5) * line.body * fontScale;
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

/**
 * 키를 붙여 넣어 전송을 막았을 때 입력창 위에 서는 문장 (#2945 GC-4).
 *
 * 머리는 코어 `SECRET_KEY_BLOCK_COPY.lead` 그대로다. 끝 문장은 폰 고유다: 코어의
 * 끝 문장은 「카드의 입력 칸을 쓰라」인데 폰 카드에는 입력 칸이 없다(Q5). 없는
 * 칸을 권하지 않고, 키를 넣는 자리(맥·웹)를 말한다.
 */
export const PHONE_SECRET_KEY_BLOCK_COPY = {
  lead: SECRET_KEY_BLOCK_COPY.lead,
  tail: '키는 맥이나 웹의 AI 화면에 넣어요. 저장만 되고 다시 보이지 않아요.',
} as const;

/** 슬래시 목록의 머리(시안 `.menu .mh`). */
export const SLASH_LIST_HEAD = '명령';
/** 첫 줄의 낭독 힌트 — 보내기가 이 줄을 고른다. */
const SLASH_DEFAULT_HINT = '보내기를 누르면 이 명령을 실행해요';
/** 시안 `.mi .mic` 28pt 상자와 그 안 글리프. */
const SLASH_ICON_BOX = 28;
const SLASH_GLYPH = 16;

export function Composer({
  channelLabel,
  channel,
  recipient,
  directory,
  viewerHumanId,
  dmHint,
  offline,
  draftKey,
  onSend,
  onTyping,
  quote,
  onCancelQuote,
  replyTarget,
  onCancelReply,
  attachmentTarget,
  placeholder: placeholderProp,
  sendLabel: sendLabelProp = '보내기',
  inputRef: externalInputRef,
  onSlashCommand,
  onKeyBlockedChange,
}: {
  channelLabel: string;
  channel?: Channel | null;
  /**
   * 이 label 이 **방 이름인가 사람 이름인가** (#1384). DM 의 label 은 상대의
   * displayName 이므로(`channelLabelParts`) 조사가 갈린다: 방은 에, 사람은
   * 에게. 기본값을 두지 않는 것은 의도다 — 모르는 채로 그린 화면이 「hermes에
   * 메시지 보내기」였고, 조사는 한국어 독자에게 렌더링 디테일이 아니다.
   */
  recipient: RecipientKind;
  directory: Directory;
  /**
   * 보는 사람의 멤버 id. 멘션 후보의 AI 보조 줄(「내 구독」·「김인턴만 부를 수 있어요」)과
   * 입력창 위 한 줄이 「누가 부르는가」로 갈리므로 필요하다(AIH-9b, #3440). 없으면 누가
   * 보는지 모르는 것이라 코어는 남의 것으로 읽지 않는다(`classifyAiAgent`).
   */
  viewerHumanId?: string | null;
  /** Overrides `composerPlaceholder`. A thread is not a channel. */
  placeholder?: string;
  /** Overrides 보내기. A reply says what it is. */
  sendLabel?: string;
  /** The agent a DM answers without an @mention, if this is that kind of DM. */
  dmAgent?: RosterMember | null;
  /**
   * #2891 — 서버의 DM 전달 상태가 참으로 만드는 문장(`useDmDeliveryHint`).
   * `undefined` 면 예전처럼 `dmAgent` 로 짓고, `null` 이면 아무 약속도 하지 않는다.
   */
  dmHint?: string | null;
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
   * 지금 스레드 답글을 쓰는 중이면 그 대상 (#4869). 있으면 입력 줄 위에 머리말이 붙어 알약이 **한 장의 카드**가 되고, 입력칸의
   * 안내 글과 보내기의 이름이 「답글」이 된다. 인용과는 함께 걸리지 않는다(화면이 하나를 걸 때 다른 하나를 뗀다).
   */
  replyTarget?: ReplyTarget | null;
  /** 답글 대상만 뗀다 — **쓴 글은 남는다**(글은 이 컴포저가 들고 있다). 대상이 있는데 이것이 없으면 나가는 길이 없다. */
  onCancelReply?: () => void;
  /**
   * The text field itself. Exposed so a caller can put the caret here — the
   * empty-state "첫 메시지 쓰기" affordance wants it, and `measure/` uses it to
   * raise the real software keyboard without a tap (a simulator cannot be
   * tapped by a script, so a harness that needed one could not run at all).
   */
  inputRef?: React.MutableRefObject<TextInput | null>;
  /**
   * 맨 앞 `/` 명령을 받는다 (#2945 GC-4). 있으면 `/`가 명령 목록을 열고, 알려진
   * 명령으로만 된 본문은 **보내지 않고** 이것을 부른다. 없으면(스레드) `/`는
   * 평문이다 — 웹 스레드 컴포저와 같다.
   *
   * 키 붙여넣기 차단은 이 prop과 무관하게 모든 컴포저에서 선다.
   */
  onSlashCommand?: (command: Command, args: LocalCardArgs) => void;
  /**
   * 키 붙여넣기 차단 안내가 서고 거둘 때 알린다 (design-review #2945 R3-B1). 대화
   * 화면은 안내가 선 동안 AI 계정 카드를 접는다 — 큰 글씨 SE 에서 안내·입력창·
   * 카드가 한 화면을 넘어 카드 머리가 밀려 나가지 않게.
   */
  onKeyBlockedChange?: (blocked: boolean) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  // 답글 대상이 걸려 있으면 입력칸의 안내 글이 「답글 입력」이 되고 보내기의 낭독 이름이 「답글 보내기」가 된다 — 위에 선
  // 머리말이 말하는 곳으로 나간다(#4869). 안내 글은 넘겨받은 문장으로 취급되어 절 예산의 프로브도 서지 않는다.
  const replyCopy = useReplyCopy(directory);
  const replying = !!replyTarget && onCancelReply !== undefined;
  const placeholder = replying ? replyCopy.placeholder() : placeholderProp;
  const sendLabel = replying ? replyCopy.send() : sendLabelProp;
  const keyboardAppearance = useKeyboardAppearance();
  // 성장 상한은 **스타일시트에 못 박히지 않는다** (#1443). 글자 배수와 창 높이가
  // 정하고, 둘 다 사람이 설정에서 바꾸는 값이라 렌더마다 다시 읽는다 —
  // `useWindowDimensions` 는 동적 타입이 바뀌는 순간에도 다시 그린다(RN 은
  // `RCTAccessibilityManager` 의 배수 변경을 Dimensions 변경으로 내보낸다).
  const {fontScale, width: windowWidth, height: windowHeight} = useWindowDimensions();
  // 알약이 화면 가장자리에서 뜬 거리 (#4179). 폭과 글자 배수가 정하므로 스타일시트가 아니라 여기서.
  const floatInset = composerFloat(windowWidth, fontScale);
  // 유리 재료. 리퀴드 글래스는 가장자리를 네이티브가 그리므로 우리 선은 투명이고(이중선 방지),
  // 블러·투명도 줄이기(불투명 surface)에서는 그 선이 알약의 경계다 — 다크에서 알약과 바닥은
  // 1.1:1 이라 선이 없으면 알약이 사라진다. 탭바(`ShellChrome` 의 `barLiquid`)와 같은 길이다.
  const glassMaterial = useGlassMaterial();
  // 시트의 상한도 같은 두 값이 정한다 (#1480). 위 상한과 나란히 여기서 계산하는
  // 이유가 그것이다 — 둘은 같은 열을 나눠 갖고, 스타일시트는 그 열을 모른다.
  // 절 예산의 자 (#1479 → #4179). 옛 판은 상한이 든 높이에서 세로 크롬을 뺀 **글이 서는 자리**였고,
  // 지금은 **알약의 한 줄**이다(`placeholderRoom` — 큰 글자에서는 배수를 따라 큰 한 줄).
  const fitRoom = placeholderRoom(fontScale);
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
  // 슬래시 목록을 닫은 뒤(골랐거나 보냈다) 같은 글자에서 다시 열리지 않게 한다.
  // 다음 키스트로크가 다시 연다 — 멘션과 같은 규율이다.
  const [slashOpen, setSlashOpen] = useState(true);
  // 키 모양을 보고 전송을 막았다. 다음 키스트로크가 지운다.
  const [keyBlocked, setKeyBlockedState] = useState(false);
  const keyBlockedRef = useRef(false);
  const onKeyBlockedChangeRef = useRef(onKeyBlockedChange);
  onKeyBlockedChangeRef.current = onKeyBlockedChange;
  const setKeyBlocked = useCallback((next: boolean) => {
    if (keyBlockedRef.current === next) return;
    keyBlockedRef.current = next;
    setKeyBlockedState(next);
    onKeyBlockedChangeRef.current?.(next);
  }, []);
  const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false);
  const [expressionPickerOpen, setExpressionPickerOpen] = useState(false);
  const expressionTrigger = useEmojiTriggerFocus(expressionPickerOpen);
  const ownInputRef = useRef<TextInput | null>(null);
  const inputRef = externalInputRef ?? ownInputRef;
  // Mirrors `text` for the caret derivation below without making `onChangeText`
  // depend on it — a changing identity there would rebuild the handler on every
  // keystroke, which is exactly the churn this file is careful about.
  const currentTextRef = useRef(text);
  // 쉬는 초안 (#4614). 대화 목록을 눌러 입력창을 쉬게 한 뒤 **사용자가 다시 닿을 때까지** 이어지는 상태다 — 포커스가 오면 `onInputFocus` 가, 방이 바뀌면 `draftKey` 효과가, 글이 비면 아래 효과가 놓는다.
  // 글이 **같은지는 보지 않는다**: 자판을 내리면 iOS 가 그 자리에서 자동 고침 후보·조합 중인 글자를 확정하고 그 `onChangeText` 는 쉬라는 알림 **뒤에** 온다(시뮬레이터 실측: 「Teh」→「The」가 목록을 누른 뒤
  // 도착했다 — 글이 같아야 쉬는 것으로 보던 첫 판에서는 그 한 번에 입력창이 다시 펼쳐졌다). 포커스 없이 글을 바꾸는 것은 그 확정뿐이고, 글을 치는 손은 먼저 포커스를 준다.
  // 접힌 알약은 같은 `TextInput` 이 높이만 한 줄로 못 박힌 모양이라 글은 지워지지도 옮겨지지도 않는다.
  const [restedFlag, setRestedFlag] = useState(false);
  // 위의 **동기** 사본 — `onBlur`·목록의 알림이 렌더 없이 읽는다(접히는 움직임을 열지 말지가 같은 핸들러 안에서 정해져야 한다, `collapseWithMotion`).
  const restedRef = useRef(false);
  // 쉬러 갈 때의 글 칸 **자연 높이**(#4614). 여러 줄 초안이 쉬는 알약으로 접히거나 다시 펼쳐질 때 글 칸의 높이를 한 프레임에 줄이거나 키우지 않고, 도구 줄과 **같은 스프링**으로 잇는 데 쓴다 —
  // 한 프레임에 줄면 그 위 대화가 그만큼 한 번에 뛴다(시뮬레이터 실측, 세 줄: 도크 43pt 가 한 프레임에 줄고 목록이 1~2프레임 늦게 따라와 틈이 43pt 벌어졌다).
  // 쉬는 동안 계속 들고 있다가 펼침의 스프링이 끝나면 버린다. `null` 이면 이 움직임이 없다(쉬지 않는 글·높이를 모를 때).
  const [restFrom, setRestFrom] = useState<number | null>(null);
  // 위의 **동기** 사본 — 입력창의 `onLayout` 이 「잘려 있는 중의 높이」를 자연 높이로 적지 않게 읽는다.
  const restFromRef = useRef<number | null>(null);
  // 입력창이 **자기 크기로 서 있을 때** 마지막으로 알려 온 높이(`onInputLayout`). 쉬러 가는 순간 이 값이 `restFrom` 이 된다.
  const inputHeightRef = useRef(0);
  // 끌어 내리기가 읽는 것들 (#4305). 글자 범위를 잡고 있거나(선택 손잡이를 끄는 중) 글이 상한을 넘어 안에서
  // 스크롤되는 중이면 아래로 끄는 손가락은 자판을 내리려는 것이 아니다.
  const selectionRangeRef = useRef(false);
  const overflowRef = useRef(false);
  const dragRef = useRef<{x: number; y: number; done: boolean} | null>(null);

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

  // 메뉴가 **실제로 사라진 뒤에만** 네이티브 picker·카메라를 제시한다 (design-review
  // High-1). 닫히는 Modal과 같은 틱에 picker를 띄우면 iOS가 dismiss 중인 VC 위
  // 제시를 거절할 수 있고, 그 실패는 catch에서 'unavailable'로 접혀 **picker가
  // 열린 적도 없는데 「업로드 실패」가 선다** — 화면이 거짓을 말하는 부류다.
  // 1차 신호 = Modal onDismiss(iOS가 dismiss 완료를 아는 유일한 곳), 폴백 =
  // 접힘의 상한(`MENU_CLOSE_WATCHDOG_MS`, 이 시간이 지나면 메뉴가 Modal 을 내린다)보다
  // 긴 타이머(Android는 onDismiss가 없다). ref를 비우고 시작하므로 두 신호가 겹쳐도
  // 제시는 한 번이다.
  const pendingPickRef = useRef<'camera' | 'photo' | 'file' | null>(null);
  // 메뉴가 열릴 때 + 원을 재고, 닫히면 VoiceOver 초점이 돌아가는 자리.
  const attachRef = useRef<View | null>(null);
  const runPendingPick = useCallback(async () => {
    const kind = pendingPickRef.current;
    if (kind === null) return;
    pendingPickRef.current = null;
    if (stableAttachmentTarget === null || attachmentKey === null) return;
    const outcome =
      kind === 'camera'
        ? await pickCamera()
        : kind === 'photo'
          ? await pickPhoto()
          : await pickDocument();
    if (outcome.kind === 'issue') {
      setPickerIssue(attachmentKey, outcome.issue);
      return;
    }
    addPickedFiles(attachmentKey, stableAttachmentTarget, outcome.files);
  }, [attachmentKey, stableAttachmentTarget]);

  const chooseAttachment = useCallback(
    (kind: 'camera' | 'photo' | 'file') => {
      if (stableAttachmentTarget === null || attachmentKey === null) return;
      pendingPickRef.current = kind;
      setAttachmentPickerOpen(false);
      setPickerIssue(attachmentKey, null);
      setTimeout(() => {
        void runPendingPick();
      }, MENU_CLOSE_WATCHDOG_MS + 100);
    },
    [attachmentKey, stableAttachmentTarget, runPendingPick],
  );

  // 첨부 메뉴의 「사진」 카드(#4181): 고른 사진은 한 번의 호출로 트레이에 들어간다(`addPickedFiles` 는
  // 일부 거절에 던지므로 카드가 상한을 선택 단계에서 건다 — `photoRoom`).
  const photoCard = useMemo(
    () => ({
      ports: nativePhotoPorts,
      room: photoRoom(attachmentSurface.drafts.length),
      onAttach: (files: PickedAttachmentFile[]) => {
        if (stableAttachmentTarget === null || attachmentKey === null) return;
        addPickedFiles(attachmentKey, stableAttachmentTarget, files);
      },
    }),
    [attachmentSurface.drafts.length, attachmentKey, stableAttachmentTarget],
  );

  // 누르는 순간 같은 프레임에 햅틱(`haptics.ts` 계약 1) — 메뉴가 열린다는 사실이 손에도 닿는다.
  const openAttachMenu = useCallback(() => {
    haptics.light();
    setAttachmentPickerOpen(true);
  }, []);

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
    // 다른 방의 초안은 그 방의 규칙으로 돌아온다 — 쉬던 방의 표식이 따라오지 않는다(#4614).
    restedRef.current = false;
    setRestedFlag(false);
    restFromRef.current = null;
    setRestFrom(null);
    setText(restored);
    setCaret(restored.length);
    setMentionOpen(false);
  }, [draftKey]);

  // Derived during render, not in an effect: an effect would compute the list
  // one commit after the keystroke that opened it, which is the same lateness
  // this file bans for `value` — and the candidate list riding one keystroke
  // behind is how a person accepts the wrong member.
  // `/`는 **메시지 맨 앞**에서만 연다(brief §3.1). 캐럿이 아니라 글 전체를 보는
  // 이유: 앵커가 0번 글자 하나뿐이라 캐럿이 어디 있든 답이 같고, 초안을 복원한
  // 콜드 스타트에서 캐럿이 0에 머무는 iOS 사정(위 `caret` 주석)을 타지 않는다.
  const slashQuery =
    onSlashCommand !== undefined &&
    slashOpen &&
    text.startsWith('/') &&
    !text.includes('\n')
      ? text.slice(1)
      : null;
  const slashRows = useMemo(
    () =>
      slashQuery === null
        ? []
        : slashCandidates(slashQuery, phoneSlashCommands(), undefined, {
            cardAvailable: true,
          }).filter(isPhoneSlashRow),
    [slashQuery],
  );
  const showSlash = slashRows.length > 0;
  // 글리프와 그 상자는 글자를 따라 자란다(design-review #2945 H2), 2배에서 멈춘다.
  const glyphScale = Math.min(Math.max(fontScale, 1), 2);
  const slashBox = Math.round(SLASH_ICON_BOX * glyphScale);
  const slashGlyph = Math.round(SLASH_GLYPH * glyphScale);

  const query = mentionOpen && !showSlash ? mentionQueryAt(text, caret) : null;
  const candidates = useMemo(
    () => (query ? matchMembers(dmAdmissionCandidates(channel, directory.members, viewerHumanId ?? ''), query.text) : []),
    [query, directory.members, channel, viewerHumanId],
  );
  const admissionHint = dmAdmissionHint(text, channel, directory, viewerHumanId ?? '');
  const showMentions = candidates.length > 0;
  // 후보의 AI 보조 줄 (AIH-9b). 문장은 전부 코어 `mentionAnnotation` 이 만든다 — 폰은
  // 그리기만 한다. 서버가 쓰는 AI를 안 알려 준 에이전트(구서버)는 null 이라 줄이 없다.
  const annotations = useMemo(
    () =>
      new Map(
        candidates.map(member => [member.id, mentionAnnotation(member, viewerHumanId)] as const),
      ),
    [candidates, viewerHumanId],
  );
  const annotated = candidates.some(member => annotations.get(member.id)?.line != null);
  // 보조 줄이 있는 시트는 행이 크다 — 높이를 같은 식에서 읽어야 반 행이 안 생긴다.
  const mentionsMaxHeight = mentionSheetMaxHeight(fontScale, windowHeight, annotated);
  const mentionRowMin = mentionRowHeight(fontScale, annotated);
  // 못 부르는(남의 구독·개인 키) 또는 쉬는(Claude 문의 중) 에이전트를 부르는 글이면 입력창
  // 위 한 줄. 후보 시트·명령 목록이 열린 동안은 그리지 않는다: 시트가 열린 도크는 이미
  // 열 예산(`mentionSheetMaxHeight`)이 꽉 차 있고, 행이 같은 말을 이미 하고 있다(자물쇠+흐림).
  const agentNotice = useMemo(
    () =>
      composerAgentNotice(
        calledAgents(mentionRoutingTarget(text, directory.members)),
        viewerHumanId,
        // 두 줄에 안 드는 큰 글자에서는 꼬리가 잘리므로 「보내도 답하지 않아요」를 앞에 둔다.
        {essentialFirst: noticeEssentialFirst(fontScale)},
      ),
    [text, directory.members, viewerHumanId, fontScale],
  );
  // iOS 에는 `accessibilityLiveRegion` 이 없다(Android 전용). 한 줄이 새로 서거나 말이 바뀔
  // 때 VoiceOver 에 직접 알린다. 같은 말은 다시 읽지 않고(글을 치는 동안 효과가 되돌지 않게
  // 의존성은 문장 하나), Android 는 live region 이 이미 하므로 겹쳐 읽지 않는다.
  const noticeShown = agentNotice !== null && !showMentions && !showSlash;
  const maxHeight = composerMaxHeight(fontScale, windowHeight, noticeShown);
  const noticeMaxHeight = composerAgentNoticeMaxHeight(fontScale, windowHeight);
  const noticeScrolls = noticeMaxHeight < AGENT_NOTICE_MAX_LINES * line.meta * fontScale + AGENT_NOTICE_PAD_TOP;
  const spokenNotice = noticeShown ? agentNotice : null;
  useEffect(() => {
    if (spokenNotice !== null && Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(spokenNotice);
    }
  }, [spokenNotice]);

  // 후보 시트가 한 행만 보이는 큰 글자에서 「아래에 더 있다」를 말하는 표지의 상태.
  const [sheetAtEnd, setSheetAtEnd] = useState(false);
  const candidateKey = candidates.map(member => member.id).join('|');
  useEffect(() => {
    setSheetAtEnd(false);
  }, [candidateKey]);
  const onSheetScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const {contentOffset, layoutMeasurement, contentSize} = e.nativeEvent;
    setSheetAtEnd(contentOffset.y + layoutMeasurement.height >= contentSize.height - 2);
  }, []);
  const sheetRows = Math.round(mentionsMaxHeight / mentionRowMin);
  const sheetHasMore = annotated && sheetRows <= 1 && candidates.length > 1;

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
    // 접힘 ↔ 펼침 전이에는 햅틱이 없다(#4331 「채팅을 치면 진동하면서」 — 첫 글자의 진동이 같은 불만이 된다).
    // 입력 길의 햅틱은 0번이고, 보내기만 light 한 번 울린다(`submit`).
    currentTextRef.current = next;
    setText(next);
    setMentionOpen(true);
    setSlashOpen(true);
    setKeyBlocked(false);
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
  }, [setKeyBlocked]);

  // 포커스 (#4456). 입력창이 캐럿을 쥔 동안 true — 펼침의 조건 하나다(아래 `expanded`). 정본은 네이티브의
  // `onFocus`/`onBlur` 이고 다른 곳에서 쓰지 않는다: 보낸 뒤에도 포커스는 그대로이므로 보내기가 이 값을
  // 건드리면 안 된다(건드리면 보낸 직후 자판은 떠 있는데 한 줄 알약이 된다 — #4456 이 고친 바로 그 모양이다).
  const [focused, setFocused] = useState(false);
  // 포커스를 쥐었는가의 **동기** 사본 — 터치 처리기(`onFieldTouchStart`)가 「이미 포커스」를 렌더 없이 읽는다.
  const focusedRef = useRef(false);
  // 누르는 중 (#4518). 손가락이 입력창에 닿은 순간부터 포커스가 와서 넘겨받거나 되돌릴 때까지 true 다 — 펼침의 조건 하나다(아래 `expanded`).
  // 포커스는 손을 뗀 뒤에야 오므로 이 값이 펼침을 그만큼 앞당긴다. 손을 뗀 뒤 포커스를 기다리는 유예도 이 값이 참인 동안이다.
  const [pressing, setPressing] = useState(false);
  const pressingRef = useRef(false);
  const pressOriginRef = useRef({x: 0, y: 0});
  // 끌기 잠금 (#4518 D2). 접힌 빈 입력창을 눌러 끌기 문턱을 넘은 손이 닿아 있는 동안 true — `TextInput` 의 `editable` 을 내려 손을 뗄 때 포커스가 안 서게 한다(아래 `onFieldTouchMove`).
  const [focusLock, setFocusLock] = useState(false);
  // 잠금의 **동기** 사본 — 터치 처리기가 렌더 없이 읽는다.
  const focusLockRef = useRef(false);
  const applyFocusLock = useCallback((next: boolean) => {
    focusLockRef.current = next;
    setFocusLock(next);
  }, []);
  const focusLockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearFocusLockTimer = useCallback(() => {
    if (focusLockTimerRef.current === null) return;
    clearTimeout(focusLockTimerRef.current);
    focusLockTimerRef.current = null;
  }, []);
  const pressGraceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPressGrace = useCallback(() => {
    if (pressGraceRef.current === null) return;
    clearTimeout(pressGraceRef.current);
    pressGraceRef.current = null;
  }, []);
  // 언마운트: 기다리던 유예가 사라진 화면을 되돌리려 하지 않게.
  useEffect(() => () => clearPressGrace(), [clearPressGrace]);
  useEffect(() => () => clearFocusLockTimer(), [clearFocusLockTimer]);

  // 안내를 읽은 뒤 고치러 돌아왔다 — 자판이 다시 오르면 안내가 한 화면을 넘는다
  // (R3-B1). 안내는 alert 로 이미 읽혔고, 키가 남아 있으면 다음 전송이 다시 막는다.
  const onInputFocus = useCallback(() => {
    setKeyBlocked(false);
    // 햅틱은 없다 — 포커스·펼침은 소리 없이 온다(#4331: 입력 길의 햅틱은 보내기 light 한 번뿐).
    focusedRef.current = true;
    // 누름이 포커스로 이어졌다(#4518): 펼침을 `pressing` 에서 `focused` 가 넘겨받는다. **한 묶음**이므로 `expanded` 는 한 번도 거짓이 되지 않고
    // 누름이 건 스프링은 끊기지 않고 이어진다. 유예 시계도 여기서 멈춘다.
    pressingRef.current = false;
    clearPressGrace();
    // 다시 눌러 포커스가 왔다: 쉬던 초안은 같은 자리에서 펼친다(#4614).
    restedRef.current = false;
    setRestedFlag(false);
    setPressing(false);
    setFocused(true);
  }, [setKeyBlocked, clearPressGrace]);

  const onSelectionChange = useCallback(
    (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      // Only a caret MOVE (tapping elsewhere). Text edits already set the caret
      // synchronously above; taking this event's value as well would let a late
      // selection event overwrite the fresh position with the old one.
      const {start, end} = event.nativeEvent.selection;
      selectionRangeRef.current = start !== end;
      if (start === end && currentTextRef.current === text) setCaret(start);
    },
    [text],
  );

  const accept = useCallback(
    (member: RosterMember) => {
      if (!query) return;
      // 별칭이 있으면 ASCII 별칭으로 넣는다(ADR-0201 v2 H2, 코어 `preferredMentionName`).
      const next = applyMention(
        text,
        query,
        caret,
        preferredMentionName(member),
      );
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

  /** 명령을 실행하고 입력창을 비운다. 명령은 메시지가 아니라 초안에도 안 남는다. */
  const runCommand = useCallback(
    (command: Command, args: LocalCardArgs) => {
      currentTextRef.current = '';
      setText('');
      setCaret(0);
      setSlashOpen(false);
      setMentionOpen(false);
      setKeyBlocked(false);
      if (draftKeyRef.current !== undefined) {
        clearDraft(draftKeyRef.current);
      }
      onSlashCommand?.(command, args);
    },
    [onSlashCommand, setKeyBlocked],
  );

  const acceptSlash = useCallback(
    (row: SlashCandidate) => {
      const command = slashCommandById(row.commandId, phoneSlashCommands());
      if (command === null) return;
      runCommand(command, row.args);
    },
    [runCommand],
  );

  const hasAttachmentDrafts = attachmentSurface.drafts.length > 0;
  // 본문 전체가 알려진 명령 하나인가. 목록을 닫고 ↑를 눌러도 `/연결`은 메시지가
  // 되지 않는다(slash.ts `parseSlashCommand` 머리말).
  const parsedCommand = useMemo(
    () =>
      onSlashCommand === undefined || hasAttachmentDrafts
        ? null
        : parseSlashCommand(text, phoneSlashCommands()),
    [onSlashCommand, hasAttachmentDrafts, text],
  );

  const submit = useCallback(() => {
    const body = text.trim();
    const hasAttachments = attachmentSurface.drafts.length > 0;
    if (parsedCommand !== null) {
      runCommand(parsedCommand.command, parsedCommand.args);
      return;
    }
    // 키는 채팅에 실리지 않는다(brief §3.4·§5). 글은 **지우지 않는다**: 사람이
    // 키를 빼고 나머지를 보낼 수 있어야 한다. 초안 저장소에는 이미 없다 —
    // `drafts.ts` `saveDraft`가 키 모양이 든 글을 적지 않는다.
    if (containsSecretKey(body)) {
      setKeyBlocked(true);
      // iOS 에는 live region 이 없다(design-review #2945 R4-H1). 막을 때마다 — 이미
      // 안내가 서 있어도 — 소리로 알린다. 웹은 안내를 새로 붙여 다시 읽힌다.
      AccessibilityInfo.announceForAccessibility(
        `${PHONE_SECRET_KEY_BLOCK_COPY.lead} ${PHONE_SECRET_KEY_BLOCK_COPY.tail}`,
      );
      // 자판을 내린다(design-review #2945 R3-B1): 큰 글씨 SE 에서 자판 + 세 줄
      // 입력창 + 안내가 한 화면을 넘어 안내의 첫 문장이 잘린다. 읽을 자리를 먼저
      // 준다. 고치러 입력창을 누르면 안내는 거둔다(아래 `onInputFocus`).
      Keyboard.dismiss();
      return;
    }
    // 목록이 열린 채 ↑를 누르면 강조된 첫 줄을 고른다 — 웹 ↵와 같다(design-review
    // #2945 M3). 「/연」 같은 반쯤 친 명령이 평문으로 채널에 나가지 않는다. 키 판정
    // **뒤**다(R2-L1): 명령 앞머리 뒤에 붙은 키도 이유를 말하고 멈춘다.
    if (showSlash) {
      acceptSlash(slashRows[0]);
      return;
    }
    if (
      offline === true ||
      attachmentBlock !== null ||
      (body === '' && !hasAttachments)
    ) {
      return;
    }
    // 보내기 = light 한 번 (#4305, `haptics.ts` 표). 접힘 전이는 소리 없이 돌아온다.
    haptics.light();
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
    setKeyBlocked,
    text,
    onSend,
    offline,
    attachmentBlock,
    attachmentKey,
    attachmentSurface.drafts.length,
    parsedCommand,
    runCommand,
    showSlash,
    slashRows,
    acceptSlash,
  ]);

  // 보낼 수 있는가 — 두 조건이고 둘은 다른 종류다. 하나는 「보낼 것이 있는가」,
  // 하나는 「지금 나갈 수 있는가」다.
  //
  // 명령은 네트워크를 타지 않으므로(이 화면에 카드를 여는 일이다) 오프라인에서도
  // 누를 수 있다.
  const canSend =
    parsedCommand !== null ||
    showSlash ||
    (offline !== true &&
      attachmentBlock === null &&
      (text.trim() !== '' || attachmentSurface.drafts.length > 0));
  const canAttach =
    stableAttachmentTarget !== null &&
    offline !== true &&
    attachmentSurface.drafts.length < MAX_ATTACHMENTS_PER_MESSAGE;

  // ---- 두 상태 (#4305 → #4456 → #4518) -------------------------------------
  // 누르는 중 **또는** 포커스 **또는** 글. 펼침의 첫 프레임은 이 조건이 처음 참이 되는 렌더이고, 아래 효과가 같은 커밋에서 스프링을 건다.
  // 누르는 중(`pressing`)이 있는 까닭은 **시작 시각**이다: 포커스 이벤트는 손을 뗀 뒤 RN `onPress → focus()` · 네이티브 · JS 를 돌아 와서 첫 포커스에서
  // `keyboardWillShow` 보다도 39~120ms 늦게 닿았다(시뮬레이터 실측, #4456). 손이 닿는 순간 시작하면(owner 10-25 「누르는 순간 바로」) 그 지연이 없다.
  // 글이 있어도 입력창이 **쉬는 중**이면 그 글은 펼침의 이유가 아니다(위 `restedFlag`). 포커스·누름은 여전히 이유다. 글이 없으면 쉴 것이 없으니 표식은 글이 있을 때만 읽는다.
  const rested = restedFlag && text !== '';
  // 글이 비면(보냄·명령) 표식을 걷는다 — 걷지 않으면 이 방에서 포커스 없이 글이 다시 채워지는 길이 생길 때 낡은 표식이 그 글을 쉬는 초안으로 되살린다. 지금 그런 길은 없어서(글을 치려면 포커스가 먼저다) 방어선이다.
  useEffect(() => {
    if (!restedFlag || text !== '') return;
    restedRef.current = false;
    setRestedFlag(false);
    restFromRef.current = null;
    setRestFrom(null);
  }, [restedFlag, text]);
  const expanded = pressing || focused || (text !== '' && !rested);
  const reduceMotion = useReduceMotionRef();
  const progress = useRef(new Animated.Value(expanded ? 1 : 0)).current;
  const dockFollow = useContext(DockFollowContext);
  const expandedRef = useRef(expanded);
  // 접히는 중 (#4456): **포커스를 잃어서**(또는 #4518: 누름이 포커스로 이어지지 않아서) 접힐 때만 true 이고 스프링이 0 에 닿으면 내려간다. `expanded` 는 펼침의
  // 마지막 이유가 사라지는 그 렌더에서 이미 거짓이라, 펼침 모양(도구 줄·글 칸 양옆 여백)이 스프링이 끝날 때까지 서 있게 하려면 이 값을 **같은 렌더에** 올려야
  // 한다 — 효과에서 올리면 접힌 모양이 한 프레임 그려졌다 되살아난다. 그래서 `onBlur`·`releasePress` 처리기가 `focused`·`pressing` 과 한 묶음으로 올린다.
  const [collapsing, setCollapsing] = useState(false);
  const shown = expanded || collapsing;
  // `shown` 의 **동기** 사본 — `onInputLayout` 이 「접힌 폭에 닿았나」를 렌더 없이 읽는다. 진행값의 리스너(`progress.addListener`)로 읽으면 안 된다: Animated 는 값에 달린
  // 마지막 자식(도구 줄·글 칸 여백)이 떨어지면 그 값의 리스너를 **모두 지운다**(`AnimatedNode.__detach`). 그래서 첫 접힘이 끝난 뒤에는 진행값 사본이 0 에 멈추고, 그 뒤 접힘마다
  // 접히는 도중의 넓은 폭이 자리표시 폭으로 새어 들어가 자리표시 문장이 몇 프레임 길게 바뀌었다(#4518 시뮬레이터 실측: 폭 281→247 동안 문장 16→25자). 접히는 도중에 누름이
  // 되돌려지는 길(`releasePress`)이 생기면서 눈에 띄었다.
  const shownRef = useRef(shown);
  useLayoutEffect(() => {
    shownRef.current = shown;
  }, [shown]);
  // 펼친 알약이 글 없이 접힐 때의 움직임을 연다. 포커스를 잃어서(`onInputBlur`)와 누름이 포커스로 이어지지 않아서(`releasePress`)가 **같은 판정**이다.
  // 움직이며 접히는 것은 **펼친 알약이 펼침의 이유(포커스·누름)만 잃고 글이 없거나 글이 쉬는 초안일 때**뿐이다(#4614: 목록을 눌러 접는 길도 같은 스프링이다 — 자판이 내려가기 시작하는 프레임에
  // 알약이 한 번에 줄면 그 위 대화가 튄다). 그 밖에 글이 남았으면 접힘이 없고, 동작 줄이기면 효과가 즉시 접는다.
  const collapseWithMotion = useCallback(() => {
    if (expandedRef.current && (currentTextRef.current === '' || restedRef.current) && !reduceMotion.current) {
      setCollapsing(true);
    }
  }, [reduceMotion]);
  const onInputBlur = useCallback(() => {
    focusedRef.current = false;
    collapseWithMotion();
    setFocused(false);
  }, [collapseWithMotion]);
  // 대화 목록을 눌렀다 (#4614, `tapDismiss.ts` → `dockFollow.rest`). 자판은 목록이 이미 내렸다(`Keyboard.dismiss`) — 여기서는 **글이 남은 입력창을 접는 것**만 한다. 글이 없으면 할 일이 없다:
  // 접힘은 포커스를 놓는 `onBlur` 가 그대로 맡는다. 포커스가 아직 안 풀렸어도(네이티브 `onBlur` 가 곧 온다) 지금 이 글을 쉬는 초안으로 적고 `collapsing` 을 같은 배치로 올린다 — 접히는 움직임을
  // 열지 말지는 `onBlur` 가 읽는 동기 사본(`restedRef`)이 정하므로 **순서가 중요하다**: 사본을 먼저 쓰고, 그다음 `collapseWithMotion`, 그다음 상태.
  useEffect(() => {
    if (dockFollow === null) return undefined;
    return dockFollow.registerRest(() => {
      if (currentTextRef.current === '' || restedRef.current) return;
      restedRef.current = true;
      // 접히는 스프링의 **시작값**: 지금 글 칸이 서 있는 높이. 모르면(아직 한 번도 재지 않았다) 이 움직임 없이 바로 접는다.
      const natural = inputHeightRef.current;
      restFromRef.current = natural > 0 ? natural : null;
      collapseWithMotion();
      setRestedFlag(true);
      setRestFrom(restFromRef.current);
    });
  }, [dockFollow, collapseWithMotion]);
  useEffect(() => {
    if (expandedRef.current === expanded) return;
    expandedRef.current = expanded;
    progress.stopAnimation();
    // 곡선은 Buzz 스프링이고 **양쪽 방향이 같다**(Buzz `composerExpansionController` 는 펼침도 접힘도 같은 스프링이다; 근거: `design/motion.ts`
    // 의 「입력창 펼침」). `overshootClamping` — 진행값이 범위를 넘으면 도구 줄이 제 높이보다 커지고 글 칸 양옆 여백이 음수가 된다.
    // 레이아웃 속성을 움직이므로 JS 구동이다. 접히는 도중에 다시 포커스가 오면 `stopAnimation` 이 현재 값에서 멈추고 거기서 다시 펼친다.
    //
    // 도크가 자라거나 주는 **프레임마다** 목록에게 바닥을 따라가라고 알린다(#4518, `dockFollow.ts`). 값이 바뀔 때 레이아웃을 미는 같은 JS 틱 안이라, 목록의 `onLayout` 이벤트(네이티브 → JS → 네이티브)를
    // 기다리지 않는다. 키보드 준비로 메인 스레드가 막혔다 풀려도 레이아웃 커밋과 목록의 `scrollToEnd` 가 한꺼번에 적용돼서 마지막 말풍선이 도크에 가려졌다 돌아오지 않는다.
    // 리스너는 스프링이 끝나거나 끊길 때 거둔다.
    const spring = (toValue: 0 | 1, done?: () => void) => {
      const followId = dockFollow === null ? null : progress.addListener(() => dockFollow.notify());
      Animated.spring(progress, {
        toValue,
        ...COMPOSER_EXPAND_SPRING,
        overshootClamping: true,
        useNativeDriver: false,
      }).start(result => {
        if (followId !== null) progress.removeListener(followId);
        if (result.finished) done?.();
      });
    };
    // 쉬던 초안의 글 칸 움직임(`restFrom`)은 펼침이 **끝나야** 버린다 — 포커스가 오는 순간(`onInputFocus`)이 아니라. 포커스는 스프링 한가운데에 닿고(눌림이 먼저 펼침을 연다),
    // 그때 글 칸을 자연 높이로 되돌리면 남은 높이가 한 프레임에 열린다.
    const endRestClip = () => {
      restFromRef.current = null;
      setRestFrom(null);
    };
    if (expanded) {
      setCollapsing(false);
      if (reduceMotion.current) {
        // 동작 줄이기: 값이 한 번에 바뀌어 스프링의 프레임별 알림이 없다. 그러면 목록은 `onLayout` 길(네이티브 → JS → 네이티브)로만 따라오는데, 앱을 켜고 처음 누른 탭에서는
        // 키보드 준비가 메인 스레드를 막는 동안 그 길이 늦어서 마지막 말풍선의 아랫줄이 도크에 가려졌다(#4518 시뮬레이터: 8/8번, 1~8프레임). `setValue` 가 레이아웃을 곧바로
        // 커밋하므로 **그 직후** 한 번 알리면 목록의 `scrollToEnd` 명령이 커밋 뒤에 줄을 서서 둘이 한꺼번에 적용된다 — 값을 바꾼 **뒤에** 알리는 순서를 지킨다(시험이 잠근다).
        // 이 순서는 RN 0.86.2 에서 JS 구동 값이 Fabric 에 `setNativeProps` 로 곧바로 커밋되는 것(`shouldUseSetNativePropsInFabric` 기본 true)에 기댄다 — jest 는 이 부분을 흉내 내지 못하니
        // RN 을 올리면 캡처(`measure/captures/4518/…rm-cold-tap-*.png`)로 다시 확인한다.
        // 접힘 쪽은 알리지 않는다: 같은 프레임 접힘은 보낸 말의 활강과 겹칠 수 있고, 동작 줄이기의 접힘은 간격이 변하지 않았다(녹화 6번, 변화 ≤1px).
        progress.setValue(1);
        dockFollow?.notify();
        endRestClip();
      } else spring(1, endRestClip);
      return;
    }
    // 접힘은 두 갈래다.
    //  - 포커스를 잃어서·누름이 포커스로 이어지지 않아서(`collapsing`): 키보드가 내려가기 시작하는 프레임에 알약이 44pt 한 번에 줄면 알약 윗면과 그 위 대화가
    //    통째로 튄다(시뮬레이터 녹화 프레임으로 확인, #4456). 앞당겨 펼친 알약을 되돌릴 때도 펼침과 같은 스프링으로 거꾸로 줄인다(#4518).
    //  - 포커스 없이 글이 비어서(포커스 없이 보냄·지움): **같은 프레임**이다(렌더가 이미 접힌 모양을 그렸다). 보낸 뒤에도 높이가 늘어난 채
    //    남던 실기 결함(owner 10-24)을 애니메이션으로 가리지 않는다. 보낸 뒤 포커스가 남아 있으면 `expanded` 가 안 바뀌므로 여기에 오지도
    //    않는다(빈 펼침 높이로 남는다 — 글 칸을 한 줄로 못 박는 것은 아래 `TextInput` 의 `height`).
    if (collapsing && !reduceMotion.current) {
      spring(0, () => setCollapsing(false));
      return;
    }
    progress.setValue(0);
    if (collapsing) setCollapsing(false);
  }, [expanded, collapsing, progress, reduceMotion, dockFollow]);

  // ---- 누름 (#4518) ----------------------------------------------------------
  // 손가락이 입력창에 닿는 순간 펼침을 시작하고, 그 탭이 포커스로 이어지지 않으면 되돌린다. 신호는 `composer-field`(입력창만 감싼 상자)에 건 **날 터치 이벤트**다.
  // RN `TextInput` 의 `onPressIn`/`onPressOut` 은 같은 터치를 `Pressability` 가 가공한 것이라 `onPressOut` 이 손을 뗄 때와 영역을 벗어날 때를 가르지 못하고
  // 130ms 까지 늦춰진다 — 끌기 문턱은 날 터치로만 잰다. 아래 처리기는 위쪽 끌어 내리기(`onDrag*`)처럼 **관찰만** 한다: 응답자를 잡지 않으므로 글자 선택·캐럿·포커스는
  // 그대로 입력창이 받는다.
  //
  // 되돌림의 길은 셋이고 모두 `releasePress` 하나로 모인다.
  //  - 끌기: 누른 자리에서 `PRESS_DRAG_SLOP_PT` 를 넘게 움직였다(탭이 아니다).
  //  - 취소: 시스템이 터치를 가져갔다(`touchCancel`).
  //  - 유예: 손을 뗐는데 `PRESS_FOCUS_GRACE_MS` 안에 `onFocus` 가 안 왔다. 손이 닿아 있는 동안에는 시계가 돌지 않는다.
  // 포커스가 오면 `onInputFocus` 가 누름을 넘겨받아(`pressingRef` 를 내린다) 이 길들은 모두 아무 일도 안 한다.
  const releasePress = useCallback(() => {
    if (!pressingRef.current) return;
    pressingRef.current = false;
    clearPressGrace();
    // `collapsing` 은 `pressing` 과 **같은 핸들러에서** 올려야 한다 — 효과에서 올리면 접힌 모양이 한 프레임 그려졌다 되살아난다(위 `collapsing` 머리말).
    collapseWithMotion();
    setPressing(false);
  }, [clearPressGrace, collapseWithMotion]);
  const onFieldTouchStart = useCallback(
    (event: GestureResponderEvent) => {
      const {pageX, pageY} = event.nativeEvent;
      // 새 손이 닿으면 잠금은 그 순간 푼다 — 끌고 뗀 직후의 탭이 잠금에 먹히지 않게(탭이 끝나는 것은 네이티브가 새 값을 받고도 남을 만큼 뒤다).
      if (focusLockRef.current) {
        clearFocusLockTimer();
        applyFocusLock(false);
      }
      if (pressingRef.current) {
        // 손을 뗀 뒤 포커스를 기다리는 중에 다시 눌렀다(포커스가 늦어 한 번 더 누른 손) — 유예를 멈추고 이 손가락으로 이어 간다.
        clearPressGrace();
        pressOriginRef.current = {x: pageX, y: pageY};
        return;
      }
      // 이미 포커스이거나 이미 펼침(글이 있음)이면 아무것도 하지 않는다 — 렌더도 타이머도 스프링도 없다.
      if (focusedRef.current || expandedRef.current) return;
      pressingRef.current = true;
      pressOriginRef.current = {x: pageX, y: pageY};
      setPressing(true);
    },
    [clearPressGrace, clearFocusLockTimer, applyFocusLock],
  );
  const onFieldTouchMove = useCallback(
    (event: GestureResponderEvent) => {
      if (!pressingRef.current) return;
      const {pageX, pageY} = event.nativeEvent;
      const origin = pressOriginRef.current;
      if (Math.hypot(pageX - origin.x, pageY - origin.y) > PRESS_DRAG_SLOP_PT) {
        // 끌기는 포커스로 이어지지 않는다(#4518 D2, owner 위임: 끌기 = 대화 스크롤·끌어 내리기 의도). 그런데 iOS 는 이 손을 **뗄 때** 입력창에 포커스를 준다 — 끌었어도, 눌린 영역을 벗어났어도
        // (시뮬레이터 실측: 문턱을 넘겨 끌고 뗀 네 방향 모두 손을 뗀 5~30ms 뒤 `onFocus`). RN 의 `onPress → focus()` 가 아니라 네이티브 길이라 응답자를 가져가도(JS 끌기 가져가기를 시험했다 —
        // `onPress` 는 안 왔는데 포커스는 왔다) 막지 못했고, 네이티브가 포커스를 줄지 정하는 때에 입력창이 **편집 불가**여야 막힌다. 그래서 끌기를 알아챈 즉시 잠그고 손을 뗀 뒤 풀어 준다.
        clearFocusLockTimer();
        applyFocusLock(true);
        releasePress();
      }
    },
    [releasePress, clearFocusLockTimer, applyFocusLock],
  );
  // 끌기 잠금을 손이 떨어진 뒤(`PRESS_DRAG_LOCK_RELEASE_MS`) 푼다. 손을 떼거나 시스템이 가져가는 두 길 모두.
  const unlockFocusSoon = useCallback(() => {
    if (!focusLockRef.current) return;
    clearFocusLockTimer();
    focusLockTimerRef.current = setTimeout(() => {
      focusLockTimerRef.current = null;
      applyFocusLock(false);
    }, PRESS_DRAG_LOCK_RELEASE_MS);
  }, [clearFocusLockTimer, applyFocusLock]);
  const onFieldTouchEnd = useCallback(() => {
    unlockFocusSoon();
    if (!pressingRef.current) return;
    clearPressGrace();
    pressGraceRef.current = setTimeout(releasePress, PRESS_FOCUS_GRACE_MS);
  }, [clearPressGrace, releasePress, unlockFocusSoon]);
  const onFieldTouchCancel = useCallback(() => {
    unlockFocusSoon();
    releasePress();
  }, [releasePress, unlockFocusSoon]);

  // 쉬는 알약 **전체**가 누르는 면이다 (#4614, design-review r1 H1). 쉬는 글 칸은 둘째 줄이 안 걸리게 첫 줄 높이로 줄어 있어서(아래 `restedStyle`) 알약 높이(52pt) 중 글 칸 30pt 만 입력창이 받았다 —
  // 알약의 아래 16pt 를 누르면 `composer-field` 의 누름 표식만 켜져 알약이 열렸다 포커스가 안 와서 도로 닫혔다. 글 칸 위에 알약 높이만큼 투명한 누름 면을 얹어 **어디를 눌러도** 포커스를 준다.
  // 포커스는 JS 가 준다(`focus()`): 글 칸의 네이티브 탭 길은 글자 크기에 따라 닿기도 안 닿기도 해서(AX5 에서는 글 칸이 알약 전체라 눌린 자리에 캐럿이 갔고 기본 크기에서는 끝에 있었다) 캐럿이 글자 크기마다 달랐다 —
  // 이 면이 받으면 캐럿은 쉬기 전 그 자리(보통 끝)에 그대로 있다. 끌기를 알아챈 손(#4518 D2 잠금)은 포커스로 잇지 않는다.
  const onRestedPress = useCallback(() => {
    if (focusLockRef.current) return;
    inputRef.current?.focus();
  }, [inputRef]);

  const collapsedHeight = composerCollapsedHeight(fontScale);
  const inputSizing = useComposerInputLayout({
    text, fontScale, minHeight: collapsedHeight, maxHeight,
    chrome: INPUT_CHROME, horizontalChrome: INPUT_CHROME_X,
    testID: 'composer-content-mirror',
  });
  const inputHeight = inputSizing.height;
  const inputOverflows = inputSizing.scrollEnabled;
  overflowRef.current = inputOverflows;
  // 쉬는 초안의 알약은 **첫 줄 하나만** 보인다 (#4614). 엄지 높이(44)에 둘째 줄의 윗부분이 걸려 잘려 보이던 것을, 입력창을 첫 줄의 아랫선까지(위 여백 + 한 줄)만으로 줄이고 남는 높이를 입력창
  // **밖**(margin)으로 돌려 해결한다 — 알약의 높이는 그대로고 첫 줄은 글이 한 줄일 때와 같은 자리(가운데)에 선다. 글이 없는 접힘은 한 줄뿐이라 이 계산이 필요 없다.
  const restedLine = Math.ceil(line.body * fontScale);
  // 위 여백 + 위 테두리 + 한 줄 + **아래 테두리**(design-review r1 N1: 아래 테두리 몫이 빠져 글 상자가 줄 높이보다 1pt 낮았다 — 라틴 첫 줄의 g·y·p 아랫부분이 걸릴 수 있다).
  const restedBox = INPUT_PAD_Y + INPUT_BORDER * 2 + restedLine;
  const restedMarginTop = Math.max(0, Math.floor((collapsedHeight - restedLine) / 2) - INPUT_PAD_Y - INPUT_BORDER);
  const restedMarginBottom = Math.max(0, collapsedHeight - restedMarginTop - restedBox);
  const restedStyle = {
    height: restedBox,
    minHeight: restedBox,
    paddingBottom: 0,
    marginTop: restedMarginTop,
    marginBottom: restedMarginBottom,
  };
  // 접히거나 펼쳐지는 **움직임 동안**(`shown`)에는 글 칸을 못 박지 않고 그것을 감싼 상자(`composer-field`)를 같은 진행값으로 줄이고 키운다(#4614): 상자의 높이가 쉬는 알약의 첫 줄 상자 ↔ 쉬러 갈 때의
  // 자연 높이(`restFrom`)를 오가고, 위·아래 여백이 쉬는 알약의 값 ↔ 0 을 오간다 — 그래서 상자가 차지하는 높이(높이 + 여백)는 `collapsedHeight` ↔ `restFrom` 을 **도구 줄과 같은 스프링으로** 오간다.
  // 상자는 안을 잘라서(`overflow`) 첫 줄이 위에 붙은 채 줄어든다. 움직임이 끝나면(`shown` 거짓 = 쉬는 알약) 끝 모양과 **같은** 못 박힘으로 바톤을 넘긴다: 높이 + 여백이 같아 한 프레임도 안 튄다.
  const clipRest = restFrom !== null && shown;
  const restClipStyle = clipRest
    ? {
        // 끝값은 쉬러 갈 때의 자연 높이 **그대로**다 — 쉬는 글 상자(`restedBox`)보다 낮아도(접근성 큰 글씨: 펼친 칸은 한 줄 높이에 갇히고 쉬는 알약은 큰 글자의 한 줄이다, design-review r2 L4) 끝값을 올리지 않는다.
        // 올리면 움직임이 시작·끝나는 프레임에 그 차이만큼 칸이 한 번에 뛴다. 높이가 이 값을 오가는 동안 위·아래 여백이 함께 줄어 칸이 차지하는 높이는 `collapsedHeight` ↔ `restFrom` 을 매끈히 오간다.
        height: progress.interpolate({inputRange: [0, 1], outputRange: [restedBox, restFrom]}),
        marginTop: progress.interpolate({inputRange: [0, 1], outputRange: [restedMarginTop, 0]}),
        marginBottom: progress.interpolate({inputRange: [0, 1], outputRange: [restedMarginBottom, 0]}),
        overflow: 'hidden' as const,
      }
    : null;
  // 펼침(또는 접히는 중)일 때만 글 칸이 원 자리(양옆 원 지름)를 풀고, 도구 줄이 선다. 접힘은 숫자 그대로라 첫 프레임에 간다.
  //
  // 「동작 줄이기」는 글 칸 여백을 **진행값을 거치지 않고** 상태가 정한 숫자로 쓴다(#4518). 움직임이 없으니 보간할 것이 없다. 보간 값은 JS 구동이라 `setValue` 가 네이티브를 리액트 밖에서 직접 고치는데,
  // 누름이 펼침 직후 되돌려지면(끌기·취소·유예) 리액트가 마지막으로 보낸 여백은 접힌 값 그대로고 접힌 쪽 렌더가 만든 값도 같은 숫자라 리액트가 아무것도 안 보낸다고 읽는다
  // (원인은 소스를 읽은 추정이다: RN 0.86.2 는 `setNativeProps` 뒤 48ms 디바운스로 다시 그리는 길도 있어서 정확한 어긋남 창은 계측하지 않았다 — 수리는 여백을 진행값에서 떼므로 메커니즘과 무관하게 선다). 결과는 화면에서 봤다: 자리표시가 + 버튼 위에 겹쳐 남았다(시뮬레이터 16 Pro, 동작 줄이기 켜고 빠르게 끈 끌기 8번 모두 — 끄면 7번 모두 정상,
  // 이 수리 뒤 8번 모두 정상). 스프링은 접히는 내내 `shown` 이 서서 보간이 끝까지 붙어 있고 끝난 뒤의 숫자가 네이티브 값과 같아서 어긋나지 않는다.
  // `reduceMotion` 은 ref 라서 **렌더 중에 읽는다** — `useReduceMotion.ts` 머리말은 읽는 곳이 누르는 순간뿐이라고 적지만 여기는 의도된 예외다: 값이 의미를 갖는 것은 상태가 바뀌는 렌더뿐이고
  // (앱 뿌리가 저장소를 붙들어 첫 렌더부터 안다), 설정이 바뀌어도 다시 그리지 않으니 다음 상태 전이부터 반영된다. 상태판 훅으로 바꾸면 첫 답이 올 때마다 컴포저가 다시 그려진다(그 훅 머리말이 피하려던 소음).
  const inputInset =
    shown && !reduceMotion.current
      ? progress.interpolate({
          inputRange: [0, 1],
          outputRange: [CONV.composerCircle, 0],
        })
      : expanded
        ? 0
        : CONV.composerCircle;
  const toolsHeight = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, COMPOSER_TOOLS_HEIGHT],
  });

  /** 「@」 도구: 끝에 @ 를 붙여 입력창이 이미 가진 멘션 후보를 연다(별도 선택기를 만들지 않는다). */
  const insertMention = useCallback(() => {
    const base = currentTextRef.current;
    onChangeText(base === '' || /\s$/.test(base) ? `${base}@` : `${base} @`);
    inputRef.current?.focus();
  }, [onChangeText, inputRef]);

  // 아래로 끌어 자판 내리기 (Buzz `Listener`). `onTouch*` 는 **관찰만** 한다 — 응답자를 잡지 않으니 글자
  // 선택·캐럿·안쪽 스크롤은 그대로 입력창이 받는다.
  const onDragStart = useCallback((event: GestureResponderEvent) => {
    dragRef.current = {
      x: event.nativeEvent.pageX,
      y: event.nativeEvent.pageY,
      done: false,
    };
  }, []);
  const onDragMove = useCallback((event: GestureResponderEvent) => {
    const drag = dragRef.current;
    if (drag === null || drag.done) return;
    const dy = event.nativeEvent.pageY - drag.y;
    const dx = Math.abs(event.nativeEvent.pageX - drag.x);
    if (dy < DISMISS_DRAG_PT || dy < dx * 2) return;
    if (selectionRangeRef.current || overflowRef.current) return;
    drag.done = true;
    Keyboard.dismiss();
  }, []);
  const onDragEnd = useCallback(() => {
    dragRef.current = null;
  }, []);

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
  const onSizingLayout = inputSizing.onLayout;
  const onInputLayout = useCallback((event: LayoutChangeEvent) => {
    onSizingLayout(event);
    // 쉬는 움직임이 글 칸을 잘라 두는 동안(`restFrom`)의 높이는 자연 높이가 아니다 — 그 높이를 적으면 다음에 쉬러 갈 때 시작값이 줄어든 높이가 된다(#4614).
    if (restFromRef.current === null) inputHeightRef.current = event.nativeEvent.layout.height;
    // 펼친 폭은 자리표시가 서는 폭이 아니다 — 자는 접힘 알약의 한 줄에서만 잰다(#4305). 펼치는 중·접히는 중의 폭도 아니므로
    // 접힘이 끝나 도구 줄이 내려간 뒤(`shown` 이 거짓, 접힌 폭)에서만 잰다(#4456 → #4518: 진행값 리스너는 첫 접힘 뒤 사라진다, 위 `shownRef`).
    if (shownRef.current) return;
    const {width} = event.nativeEvent.layout;
    setInputWidth(previous => (previous === width ? previous : width));
  }, [onSizingLayout]);
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

  const keptPlaceholder =
    clauses === null
      ? (placeholder as string)
      : fitComposerPlaceholder(clauses, candidate => {
          const height = probed[candidate];
          // 아직 안 잰 후보는 「안 든다」다 (#4179) — 한 줄 예산에서는 긴 문장이 안 드는 쪽이
          // 흔해서, 「든다」로 시작하면 알약이 두 줄로 섰다가 줄어든다. 머리 절로 시작하면 높이는
          // 처음부터 한 줄이고 드는 창에서는 글자만 뒤에 붙는다(머리말 「재기 전」 절).
          return height !== undefined && height <= fitRoom;
        });
  const shownPlaceholder = withLatinWordBreaks(keptPlaceholder);
  // #4790: 방 이름은 한 줄 말줄임 Text로, 스레드의 짧은 초대는 native
  // placeholder로 표시한다(#4690). 같은 문장을 두 번 그리지 않는다.
  // 필드 라벨이 방 이름 전체를 읽고, 멘션 안내는 보이는 절의 길이와 무관하게
  // 빈 입력창의 힌트로 읽는다. 글을 쓰기 시작하면 힌트도 걷는다.
  const placeholderHint =
    clauses === null || text !== ''
      ? undefined
      : clauses.find(clause => clause.id === 'mention-affordance')?.text;

  return (
    <View style={styles.root} testID="composer-root">
      {showSlash ? (
        <View style={styles.mentions} testID="slash-list">
          <Text style={styles.slashHead} accessibilityRole="header">
            {SLASH_LIST_HEAD}
          </Text>
          <ScrollView
            style={{maxHeight: slashListMaxHeight(fontScale, windowHeight)}}
            keyboardShouldPersistTaps="always"
            showsVerticalScrollIndicator>
            {slashRows.map((row, index) => (
              <Pressable
                key={row.id}
                accessibilityRole="button"
                accessibilityLabel={`${row.label} ${row.hint}`}
                onPress={() => acceptSlash(row)}
                accessibilityHint={index === 0 ? SLASH_DEFAULT_HINT : undefined}
                style={({pressed}) => [
                  styles.slashRow,
                  {minHeight: slashRowHeight(fontScale)},
                  // 첫 줄이 기본값이다(시안 `.mi.on`) — 보내기가 이 줄을 고른다.
                  index === 0 && styles.slashRowOn,
                  pressed && styles.pressed,
                ]}
                testID="slash-option">
                <View style={[styles.slashIcon, {width: slashBox, height: slashBox}]}>
                  <Image
                    source={
                      row.icon === 'credentials' ? HOME_ICONS.lock : CARD_ICONS.plug
                    }
                    style={{width: slashGlyph, height: slashGlyph, tintColor: palette.icon}}
                  />
                </View>
                <View style={styles.slashText}>
                  <Text style={styles.slashLabel} numberOfLines={1}>
                    <Text style={styles.slashMatched}>
                      {row.label.slice(0, row.matched)}
                    </Text>
                    {row.label.slice(row.matched)}
                  </Text>
                  <Text
                    style={styles.slashHint}
                    numberOfLines={slashHintLines(fontScale)}
                    lineBreakStrategyIOS="hangul-word"
                    testID="slash-option-hint">
                    {row.hint}
                  </Text>
                </View>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}
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
            onScroll={sheetHasMore ? onSheetScroll : undefined}
            scrollEventThrottle={16}
            contentContainerStyle={sheetHasMore ? styles.mentionScrollCue : undefined}
            showsVerticalScrollIndicator>
            {candidates.map(member => {
              const note = annotations.get(member.id) ?? null;
              const annotationLine = note?.line ?? null;
              // 칩은 보조 줄이 있는 에이전트에만 선다. 줄을 모르는(구서버) 에이전트는
              // 옛 표지 「에이전트」 그대로다.
              const badge = annotationLine !== null ? note?.badge ?? null : null;
              const locked = note?.locked === true;
              const showBadge = badge !== null && fontScale <= MENTION_BADGE_MAX_SCALE;
              return (
                <Pressable
                  key={member.id}
                  accessibilityRole="button"
                  // 잠긴 행은 `accessibilityState.disabled` 가 아니라 **힌트**로 말한다: 이 행은
                  // 고를 수 있고(멘션이 글에 들어간다) 막힌 것은 보낸 뒤의 답이다. `disabled` 는
                  // VoiceOver 가 「흐림」이라 읽어 눌러도 안 된다는 뜻이 되고, 이 행의 사실과 다르다.
                  accessibilityHint={note?.lockedHint ?? undefined}
                  // 눈에 보이는 것과 같은 것을 읽는다 (회전 2 M3). 이 `Pressable` 은
                  // `accessible` 기본값이 참이라 이 한 줄이 자식을 통째로 덮는다 — 표지와
                  // 보조 줄을 여기 안 실으면 스크린리더에서 자물쇠(못 부름)가 사라진다.
                  // 보조 줄은 칩의 말을 이미 포함하므로(코어 `mentionLine`) 칩은 따로 안 읽는다.
                  accessibilityLabel={[
                    member.displayName,
                    mentionHandleLabel(member, query?.text ?? ''),
                    member.kind === 'agent' ? MENTION_AGENT_KIND : null,
                    annotationLine,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onPress={() => accept(member)}
                  style={({pressed}) => [
                    styles.mentionRow,
                    annotated && {
                      minHeight: mentionRowMin,
                      paddingVertical: space.xs,
                      alignItems: 'flex-start',
                    },
                    pressed && styles.pressed,
                  ]}
                  testID="mention-option">
                  {({pressed}) => (
                    <>
                  {/* 사람과 에이전트 모두 같은 아바타(사진, 없으면 이니셜)가 앞에 선다 (#3821).
                      행의 접근성 라벨이 이름을 말하므로 아바타는 보조기술에서 숨는다. */}
                  <Avatar directory={directory} memberId={member.id} />
                  {/* 왼쪽 칸 = 첫 줄(이름+핸들) + 보조 줄. 오른쪽 칩은 첫 줄에 맞춰 선다. */}
                  <View
                    style={[
                      styles.mentionColumn,
                      annotationLine === null && styles.mentionColumnCenter,
                    ]}
                    testID="mention-column">
                    {/* 이름과 핸들은 **한 묶음**이다 — 그 묶음이 자라고, 그 안에서 둘이
                        함께 줄어든다. 형제 셋(`AgentsScreen`·`SidebarScreen`·
                        `HostedConnectionsScreen`)의 `rowText` + `rowTitleLine` 과 같은
                        구조이고, 스타일 쪽 주석이 왜 그 구조여야 하는지를 든다. */}
                    <View
                      style={[
                        styles.mentionIdentity,
                        locked && !pressed && styles.mentionLockedDim,
                      ]}
                      testID="mention-identity">
                      <Text
                        style={[
                          styles.mentionName,
                          member.kind === 'agent' && styles.mentionNameAgent,
                        ]}
                        numberOfLines={1}>
                        {member.displayName}
                      </Text>
                      <Text style={styles.mentionHandle} numberOfLines={1}>
                        {mentionHandleLabel(member, query?.text ?? '')}
                      </Text>
                      {locked ? (
                        <Image
                          source={HOME_ICONS.lock}
                          style={styles.mentionLock}
                          accessibilityElementsHidden
                          importantForAccessibility="no"
                          testID="mention-locked-mark"
                        />
                      ) : null}
                    </View>
                    {annotationLine !== null ? (
                      <Text
                        style={styles.mentionAnnotation}
                        numberOfLines={mentionAnnotationLines(fontScale)}
                        lineBreakStrategyIOS="hangul-word"
                        testID="mention-agent-line">
                        {/* 한 줄로 접히면 말줄임이 꼬리를 먹으므로 상태(문의 중·맥 꺼짐)를 앞에
                            둔 같은 사실을 그린다. 읽는 라벨은 본래 순서 전문이다. */}
                        {mentionAnnotationLines(fontScale) === 1
                          ? note?.lineStatusFirst ?? annotationLine
                          : annotationLine}
                      </Text>
                    ) : null}
                  </View>
                  {showBadge ? (
                    <Text
                      style={[styles.mentionBadge, locked && !pressed && styles.mentionLockedDim]}
                      numberOfLines={1}
                      testID="mention-badge">
                      {badge}
                    </Text>
                  ) : member.kind === 'agent' && annotationLine === null ? (
                    // 한 줄로 못 박는다 — 줄어들 수 있게 해 둔 조각이(스타일의
                    // `flexShrink`) 한 줄로 안 묶이면 접히고, 접힌 행은 이 배치가
                    // 세운 정수 행 산술이 세는 높이를 넘는다.
                    <Text style={styles.mentionKind} numberOfLines={1}>
                      {MENTION_AGENT_KIND}
                    </Text>
                  ) : null}
                    </>
                  )}
                </Pressable>
              );
            })}
          </ScrollView>
          {sheetHasMore && !sheetAtEnd ? (
            // 한 행만 보이는 큰 글자(막대는 끄는 동안에만 보인다)에서 「아래에 더 있다」. 높이를
            // 먹지 않는 겹침이라 도크 예산(`mentionSheetMaxHeight`)은 그대로다. 글이 아니라 도형이다.
            <View
              style={styles.mentionMoreCue}
              pointerEvents="none"
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              testID="mention-more-cue">
              <View style={styles.mentionMoreChevron} />
            </View>
          ) : null}
        </View>
      ) : null}

      {admissionHint !== null ? <Text style={styles.hint} accessibilityLiveRegion="polite" testID="composer-dm-admission-hint">{admissionHint}</Text> : null}
      {dmHint !== undefined ? (
        dmHint !== null && text.trim() === '' ? (
          <Text style={styles.hint} testID="composer-dm-hint">
            {dmHint}
          </Text>
        ) : null
      ) : null}

      {noticeShown ? (
        // 보내기 전에 말한다: 고르는 것은 막지 않지만 보내도 답이 오지 않는다. 문장은 전부
        // 코어(`composerAgentNotice`)가 만든다. 폰에는 라우팅 막대가 없어(웹의 「이번만 바꾸기」
        // 줄) 대신 들어갈 자리가 없고, 그래서 입력창 바로 위 한 줄이다.
        // `color.warn` 인 이유: 오프라인 줄이 앰버가 아닌 것(U4-6 M-2)은 「지금은 못 보낸다」라는
        // 때의 문제라서였다. 이 줄은 반대로 「보내기 전에 볼 것」 — `warn` 이 뜻하는 그 한 가지다.
        <ScrollView
          style={{maxHeight: noticeMaxHeight, flexGrow: 0}}
          scrollEnabled={noticeScrolls}
          keyboardShouldPersistTaps="handled"
          nestedScrollEnabled
          testID="composer-agent-notice-scroll">
          <Text
            style={styles.agentNotice}
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            lineBreakStrategyIOS="hangul-word"
            // 고지와 패딩을 먼저 확보한 뒤 입력창 상한을 정한다.
            // SE + AX에서는 고지 한 줄씩 스크롤하며, 라벨은 전문을 읽는다.
            numberOfLines={AGENT_NOTICE_MAX_LINES}
            accessibilityLabel={agentNotice ?? undefined}
            testID="composer-agent-notice">
            {agentNotice}
          </Text>
        </ScrollView>
      ) : null}

      {keyBlocked ? (
        <View
          style={styles.keyBlock}
          accessibilityLiveRegion="assertive"
          accessibilityRole="alert"
          testID="composer-key-blocked">
          <Text style={styles.keyBlockText} lineBreakStrategyIOS="hangul-word">
            {`${PHONE_SECRET_KEY_BLOCK_COPY.lead} ${PHONE_SECRET_KEY_BLOCK_COPY.tail}`}
          </Text>
        </View>
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

      {inputSizing.mirror}

      {/* 떠 있는 알약 하나 (DS2-4 #2716, owner 표 + 시안 A `.a-comp`): 안쪽 왼쪽 +
          원 · 입력 · 오른쪽 잉크 ↑ 원. 옛 판은 네모 [+] · 두 줄 상자 · 글자 버튼
          「보내기」가 따로 놀았다. 알약 밖 도크는 투명이라 바닥이 비친다. */}
      <GlassSurface
        radius={CONV.composerRadius}
        style={[
          styles.pill,
          glassMaterial === 'liquid' && styles.pillLiquid,
          {marginHorizontal: floatInset},
        ]}
        testID="composer-pill">
      {/* 답글 머리말 (#4869) — 알약 **안**, 입력 줄 바로 위. 알약의 반경이 카드의 모서리이고 입력과 한 장을 이룬다. */}
      {replyTarget && onCancelReply ? (
        <ReplyDraftCard
          target={replyTarget}
          directory={directory}
          onCancel={onCancelReply}
        />
      ) : null}
      <View
        style={styles.bar}
        testID="composer-bar"
        onTouchStart={onDragStart}
        onTouchMove={onDragMove}
        onTouchEnd={onDragEnd}
        onTouchCancel={onDragEnd}>
        {stableAttachmentTarget === null ? null : (
          <Pressable
            ref={attachRef}
            accessibilityRole="button"
            accessibilityLabel={ATTACH_COPY.attach}
            accessibilityHint={
              offline
                ? COMPOSER_OFFLINE_COPY
                : attachmentSurface.drafts.length >=
                    MAX_ATTACHMENTS_PER_MESSAGE
                  ? `첨부는 ${MAX_ATTACHMENTS_PER_MESSAGE}개까지 고를 수 있어요`
                  : undefined
            }
            accessibilityState={{disabled: !canAttach}}
            disabled={!canAttach}
            hitSlop={ATTACH_SLOP}
            onPress={openAttachMenu}
            style={({pressed}) => [
              styles.attach,
              !canAttach && styles.attachDisabled,
              pressed && canAttach && styles.pressed,
            ]}
            testID="composer-attach">
            <Image
              source={CONV_ICONS.plus}
              style={[
                styles.attachGlyph,
                {tintColor: canAttach ? palette.text : palette.textFaint},
              ]}
            />
          </Pressable>
        )}
        <Animated.View
          style={[{marginLeft: inputInset, marginRight: inputInset}, restClipStyle]}
          testID="composer-field"
          // 누름 (#4518): 입력창에 닿는 터치만 듣는다 — 이 상자는 입력창만 감싼다(+ · 보내기 · 도구 줄은 형제다). 관찰만 하고 응답자를 잡지 않는다.
          onTouchStart={onFieldTouchStart}
          onTouchMove={onFieldTouchMove}
          onTouchEnd={onFieldTouchEnd}
          onTouchCancel={onFieldTouchCancel}>
        <TextInput
          ref={inputRef}
          // 높이는 별도 Text 거울이 정한다. 입력창 자체의 contentSize 이벤트를
          // 기다리면 고정 레이아웃에서 자동 줄바꿈·5번째 줄을 알 수 없다(#4790).
          style={[
            styles.input,
            {maxHeight, minHeight: collapsedHeight, height: inputHeight},
            rested && !clipRest && restedStyle,
          ]}
          onLayout={onInputLayout}
          value={text}
          onChangeText={onChangeText}
          onSelectionChange={onSelectionChange}
          onFocus={onInputFocus}
          onBlur={onInputBlur}
          // 문장은 코어가 든다 (#1384). 이 두 줄은 웹 `chat/Composer.tsx` 와
          // **같은 문자열을 각자 짓고** 있었다: 값이 같아서 안 보였을 뿐,
          // 한쪽을 고치는 날 갈라진다. 오프라인 문장이 이미 걸어 둔 길이다.
          //
          // **드는 만큼만 실린다** (#1479). 절을 고르는 것은 코어의
          // `fitComposerPlaceholder` 이고, 「이 상자에 드는가」만 위의 프로브가
          // 답한다 — 그 분업과 그것이 구하지 못하는 띠는 이 파일의 「절 예산」
          // 머리말에 있다.
          placeholder={placeholder ?? ''}
          // 자리 글자가 이제 「@로 부르기」를 알리는 유일한 문장이다 — 시안의 @ 도구
          // 버튼을 뺐으므로(DS2-4 검수 M-4). `textFaint` 는 알약 위 3.6~3.8:1 이었다.
          placeholderTextColor={palette.textMuted}
          keyboardAppearance={keyboardAppearance}
          accessibilityLabel={placeholder ?? composerFieldLabel(channelLabel, recipient)}
          accessibilityHint={placeholderHint}
          multiline
          // 쉬는 초안(#4614)은 스크롤하지 않는다: 입력창 안이 끝 쪽으로 스크롤된 채(캐럿이 끝에 있었다) 한 줄로 줄면 그 스크롤이 남아 첫 줄이 아니라 중간 줄이 알약에 보였다(시뮬레이터 실측).
          scrollEnabled={!rested && inputOverflows}
          // 끌기 잠금(#4518 D2): 접힌 빈 입력창을 눌러 끌기 문턱을 넘은 손이 닿아 있는 동안만 `false` 다 — 손을 뗄 때 네이티브가 포커스를 주지 못하게 한다(`onFieldTouchMove`).
          // 그 밖에는 언제나 `true` 라서(기본값과 같다) 다른 터치·포커스·글자 선택은 지금 그대로다.
          editable={!focusLock}
          // 이 상자에서 한국어가 **낱말 가운데서** 끊기지 않는다 (#1422 폰 몫).
          //
          // 웹의 같은 문장은 한 줄 상자(`rows=1`)라 넘친 절이 사라지고, 그래서
          // #1422 는 거기서 「절 단위로 버린다」를 계약으로 만들었다. 이 상자는
          // 다르다 — RN 의 `multiline` 은 콘텐츠 높이로 자라므로 넘쳐도 잃는 것이
          // 없고, 잃는 것이 없으면 버릴 이유도 없다. 폰 계측이 그것을 실측했다
          // (`measure/surfaces.tsx` 의 `composer-placeholder`: 예산 260pt(알약 이전 바의 글 칸) 상자에서
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
          // 기록**이지 오늘의 계약이 아니다 — 오늘의 계약은 **한 줄에 안 드는 문장은
          // 뒷절이 절 경계에서 통째로 사라진다**는 것이다(#4179: 옛 「배수 ~2.2 아래에서는
          // 화면이 하나도 안 변한다」는 상자 글자리 문턱의 것이었다 — 머리말 #4179 절).
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
          // Enter inserts a newline (see the header), and the keyboard stays up:
          // on a phone the return key is the only line break there is. Said out
          // loud with `submitBehavior` (#4321) instead of inherited from the
          // deprecated `blurOnSubmit={false}`, which RN only translates into
          // this value on a multiline input — the return key can neither send
          // (no `onSubmitEditing` is wired, on purpose) nor be swallowed
          // (`'submit'` drops the `\n` and sends nothing) nor close the
          // keyboard (`'blurAndSubmit'`). `__tests__/composerNewline.test.tsx`
          // pins the value; `maestro/70-composer-newline.yaml` is the key press.
          submitBehavior="newline"
          textAlignVertical="top"
          testID="composer-input"
        />
        {/* 쉬는 알약의 눌리는 면 (#4614 H1) — 쉬는 초안이 포커스를 받기 전까지 선다. **움직이는 중에도 서 있어야 한다**: 손이 닿는 순간 펼침이 시작되고(#4518) 그 렌더에서 이 면이 사라지면
            눌리던 손의 `onPress` 가 오지 않는다(시뮬레이터 실측: `pressIn` 만 오고 `onPress` 가 없었다). 접근성 요소가 아니다(글 칸이 그 몫을 한다). */}
        {text === '' && placeholder === undefined ? (
          <Text
            pointerEvents="none"
            accessible={false}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            numberOfLines={1}
            ellipsizeMode="tail"
            style={[styles.placeholder, {color: palette.textMuted}]}
            testID="composer-placeholder">
            {shownPlaceholder}
          </Text>
        ) : null}
        {rested && !focused ? (
          <Pressable
            accessible={false}
            importantForAccessibility="no"
            accessibilityElementsHidden
            onPress={onRestedPress}
            style={StyleSheet.absoluteFill}
            testID="composer-rested-target"
          />
        ) : null}
        </Animated.View>
        {shown ? (
          <Animated.View
            style={[styles.tools, {height: toolsHeight, opacity: progress}]}
            testID="composer-tools">
            <Pressable
              ref={expressionTrigger}
              accessibilityRole="button"
              accessibilityLabel="이모지 고르기"
              accessibilityState={{disabled: offline}}
              disabled={offline}
              onPress={() => {
                Keyboard.dismiss();
                setExpressionPickerOpen(true);
              }}
              style={styles.tool}
              testID="composer-tool-emoji">
              <Image source={EXPRESSION_ICONS.smile} style={[styles.attachGlyph, {tintColor: palette.icon}]} />
            </Pressable>
            {TOOL_SLOTS.includes('mention') ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={TOOL_COPY.mention}
                hitSlop={ATTACH_SLOP}
                onPress={insertMention}
                style={({pressed}) => [styles.tool, pressed && styles.pressed]}
                testID="composer-tool-mention">
                <Text allowFontScaling={false} style={styles.toolGlyph}>@</Text>
              </Pressable>
            ) : null}
          </Animated.View>
        ) : null}
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
          hitSlop={SEND_SLOP}
          onPress={submit}
          style={({pressed}) => [
            styles.send,
            !canSend && styles.sendDisabled,
            pressed && canSend && styles.sendPressed,
          ]}
          testID="composer-send">
          {/* 시안 `.a-send` — 잉크 원 안의 ↑. 이름(「보내기」·「답글 보내기」)은
              보이는 글자에서 낭독 라벨로만 옮겼다 — owner 표 「오른쪽 원형 ↑」. */}
          <Image
            source={CONV_ICONS.up}
            style={[styles.sendGlyph, {tintColor: palette.onPrimary}]}
          />
        </Pressable>
      </View>
      </GlassSurface>
      {expressionPickerOpen ? (
          <ExpressionComposerModal
            onClose={() => setExpressionPickerOpen(false)}
            onInsert={glyph => {
              onChangeText(currentTextRef.current + glyph);
              inputRef.current?.focus();
            }}
            onSend={body => { if (!offline) onSend(body); }}
          />
      ) : null}
      <AttachMenu
        visible={attachmentPickerOpen}
        anchorRef={attachRef}
        onClose={() => setAttachmentPickerOpen(false)}
        onPickCamera={() => chooseAttachment('camera')}
        onPickPhoto={() => chooseAttachment('photo')}
        onPickFile={() => chooseAttachment('file')}
        onDismissed={() => void runPendingPick()}
        photos={photoCard}
      />
    </View>
  );
}

const buildStyles = (color: Palette) => StyleSheet.create({
  /**
   * 도크. 선도 바닥색도 없다 — 알약이 바닥 위에 뜬다(시안 `.a-comp`). 위 여백과
   * 알약 안 위아래 여백은 `PILL_CHROME`이며 도구 줄과 함께 `DOCK_CHROME`에 든다.
   */
  root: {paddingTop: CONV.composerTopAir},
  /**
   * 반경은 원 반경 + 사방 여백(`CONV.composerRadius`)이라 두 원과 동심이다 (#4179). 좌우로
   * 뜬 거리는 폭과 글자 배수가 정하므로 **여기 없다** — 컴포넌트가 `composerFloat` 로 계산해
   * 붙인다. Buzz 의 알약은 선 대신 부드러운 그림자로 바닥에서 뜬다(`rest` — `float` 은 Buzz
   * 실측 그림자보다 세 배 짙었다): 리퀴드 글래스(iOS 26)에서는 선이 투명이다(`pillLiquid`).
   * 유리와 틴트는 `GlassSurface` 가 진다.
   */
  pill: {
    borderRadius: CONV.composerRadius,
    borderWidth: PILL_EDGE,
    borderColor: color.glassLine,
    boxShadow: color.elevationRest,
  },
  /** 네이티브 유리 가장자리가 이미 있다 — 두께는 남기고 색만 뺀다(이중선 방지). */
  pillLiquid: {borderColor: 'transparent'},
  /**
   * 좌우는 원 ↔ 알약 가장자리(`composerGap`)에서 알약의 선을 던 `BAR_PAD_X`, 위아래는 거기서
   * 입력창이 원 둘레에 더하는 몫을 또 던 `BAR_PAD_Y` — 선과 합치면 사방 같다. 글이 여러 줄로
   * 자라도 원은 `flex-end` 라 아래·옆 여백이 한 줄 때와 같고, 알약의 아래 두 모서리와 동심이다.
   */
  bar: {
    paddingHorizontal: BAR_PAD_X,
    paddingVertical: BAR_PAD_Y,
  },
  /**
   * 펼침의 도구 줄 (#4305). 높이는 애니메이션이 정한다(0 → 엄지 바닥). 왼쪽은 + 원 자리를 비워 두고
   * (원은 알약 바닥에 절대 배치로 서 있다) 그 오른쪽에 도구가 앉는다.
   */
  tools: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: CONV.composerCircle,
    overflow: 'hidden',
  },
  tool: {
    width: CONV.composerCircle,
    height: CONV.composerCircle,
    borderRadius: CONV.composerCircle / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolGlyph: {fontSize: font.body, lineHeight: line.body, color: color.textMuted},
  /**
   * 안쪽 왼쪽 + 원(Buzz: 흰 원 + 가는 테두리). 44 는 `hitSlop` 이 진다. 한 줄 입력창(44)
   * 가운데에 앉는다.
   */
  attach: {
    // 두 원은 **알약 바닥에 절대 배치**다 (#4305): 접힘이든 펼침이든 같은 자리에 서고, 글 칸이 그 위로
    // 자란다. 바닥 여백은 옛 `flex-end` 줄의 `marginBottom` 과 같은 산수(안쪽 여백 + (44 − 36) / 2).
    position: 'absolute',
    left: BAR_PAD_X,
    bottom: BAR_PAD_Y + (TOUCH_TARGET - CONV.composerCircle) / 2,
    width: CONV.composerCircle,
    height: CONV.composerCircle,
    borderRadius: CONV.composerCircle / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  attachDisabled: {backgroundColor: color.surfaceMuted},
  attachGlyph: {width: CONV_ICON_SIZE.plus, height: CONV_ICON_SIZE.plus},
  placeholder: {
    position: 'absolute',
    top: INPUT_BORDER,
    left: INPUT_BORDER,
    right: INPUT_BORDER,
    paddingHorizontal: INPUT_PAD_X,
    paddingVertical: INPUT_PAD_Y,
    fontSize: font.body,
    lineHeight: line.body,
  },
  input: {
    // 한 줄일 때도 엄지가 닿는 크기. 도출된 한 줄 상자(23 + 8·8 + 1·1 = 41)보다
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
    borderWidth: INPUT_BORDER,
    borderColor: 'transparent',
    // 16 is where iOS stops zooming a focused field; anything smaller makes the
    // whole screen lurch the first time someone taps to type.
    ...COMPOSER_INPUT_TYPOGRAPHY,
    color: color.text,
    // 스케일에서 나온다. 옛 값 21 은 `font.body`(16) 옆의 손으로 적은 숫자였고,
    // 같은 크기 글자가 화면의 다른 자리(본문·「작업 중」)에서는 22 를 썼다.
    //
    // 이 값이 `composerMaxHeight` 의 첫 항이기도 하다 — 다만 **선언된 22 가
    // 아니라 화면에 그려지는 22 × 글자 배수**가. iOS 가 선언된 줄 상자에 동적
    // 타입 배수를 곱하므로(머리말의 `RCTAttributedTextUtils` 인용) 상한도 같은
    // 배수를 곱해야 같은 줄 수를 뜻한다. 그것이 #1443 이 고친 자리다.
  },
  /**
   * 잉크 ↑ 원 — + 와 같은 지름이다. 한 줄 입력창(44) 가운데에 앉고, 글이 자라면 마지막
   * 줄 옆에 남는다.
   */
  send: {
    position: 'absolute',
    right: BAR_PAD_X,
    bottom: BAR_PAD_Y + (TOUCH_TARGET - CONV.composerCircle) / 2,
    width: CONV.composerCircle,
    height: CONV.composerCircle,
    borderRadius: CONV.composerCircle / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.primary,
  },
  sendGlyph: {width: CONV_ICON_SIZE.up, height: CONV_ICON_SIZE.up},
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
  /**
   * 보낼 수 없을 때(비었다·오프라인·첨부 대기). Buzz 의 흐린 원 — 잉크를 벗고 중간 회색을
   * 입는다. 글리프는 잉크 때와 같은 색(`onPrimary`)이라 「같은 버튼의 흐린 판」으로 읽힌다.
   * 옛 값 `surfaceMuted` 는 알약 위 1.08:1(다크 1.12)이라 원이 거의 안 보였다. `textFaint`
   * 는 알약 위 두 스킴 모두 3.6:1, 글리프는 3.8(라이트)·4.0(다크):1 — 값은
   * `composerPill.test.tsx` 가 팔레트에서 잰다.
   */
  sendDisabled: {backgroundColor: color.textFaint},
  sendPressed: {opacity: 0.8},
  /**
   * 후보 시트 (#1480). **`maxHeight` 는 여기 없다** — 글자 배수와 창 높이가
   * 정하므로 컴포넌트가 `mentionSheetMaxHeight` 로 계산해 붙인다(입력창이 같은
   * 이유로 같은 일을 한다). 옛 판의 `maxHeight: 180` 은 도출되지 않은 상수였고,
   * 그것이 무엇을 틀렸는지는 위 「시트의 상한」 절에 있다.
   */
  mentions: {
    // **도크 밖으로 뜬다 — 흐름에 들지 않는다** (#3661). 시트가 흐름에 있으면 열고 닫을 때마다,
    // 그리고 글자를 칠 때마다 후보 수가 바뀔 때마다 도크가 자라고 줄어서 「따라가는 목록」의
    // 보이는 창이 그만큼 줄었다 늘었다 한다 — 목록은 그때마다 `onLayout` 으로 바닥에 다시
    // 붙는다. 시트는 입력창 바로 위에 목록을 **덮고** 서므로 목록은 아무것도 모른다.
    // `bottom: '100%'` 의 시트는 알약에 거의 붙어(캡처로 ~4px) 선다. #4264 실측(16 Pro, `GAP-TYPING+SHEET`): 시트 아래
    // 끝이 알약 위 끝에서 0.7pt(16 Pro, SE 1.0pt) 위 — 루트의 위 여백(8)을 지나 내용 상자 윗면에 선다. 그래서 도크 위의 「작성 중」 줄은 그 줄이
    // 여백 안으로 걸치든 아니든 시트에 온전히 덮인다(걸침이 위 여백보다 작은 한, `conversationGap.test.tsx`).
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: '100%',
    zIndex: 1,
    backgroundColor: color.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
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
   * 묶음은 이제 왼쪽 칸(`mentionColumn`, `flex: 1`) 안의 첫 줄이라 폭은 칸이 받는다 —
   * 묶음 자신이 `flex: 1` 이면 세로로도 자라 보조 줄과 벌어진다(AIH-9b 캡처에서 잡았다).
   * 칩이 자기 폭을 먼저 받고 칸이 나머지를 받는 것은 그대로다. 안에서
   * 두 조각이 폭에 비례해 함께 줄어드는 것이 위 절의 요점이다.
   */
  mentionIdentity: {
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
  // ---- AI 보조 줄 (AIH-9b, #3440; 웹 `ComposerAutocompleteList` 두 칸 구조) ----------
  // 왼쪽 칸이 자라고(`flex: 1`) 오른쪽 칩은 제 폭을 받는다(`flexShrink: 0`). 칩은 첫 줄에
  // 맞춰 서므로(`alignSelf: 'flex-start'`) 칸은 위에 붙는다. 보조 줄이 없는 후보(사람)는
  // 같은 시트에서 위로 붙지 않게 칸을 행 높이에 채워 가운데에 놓는다(`mentionColumnCenter`).
  mentionColumn: {flex: 1},
  mentionColumnCenter: {alignSelf: 'stretch', justifyContent: 'center'},
  mentionAnnotation: {
    fontSize: font.meta,
    lineHeight: line.meta,
    // `textFaint` 는 본문 AA 를 노리지 않는 값이다 — 이 줄은 읽어야 하는 문장이다.
    color: color.textMuted,
  },
  mentionLock: {
    width: font.meta,
    height: font.meta,
    flexShrink: 0,
    tintColor: color.textFaint,
  },
  mentionBadge: {
    flexShrink: 0,
    alignSelf: 'flex-start',
    // 첫 줄(`line.head`)과 같은 줄 상자 — 이름과 같은 줄에 선다.
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: color.surfaceMuted,
    fontSize: font.meta,
    lineHeight: line.head,
    color: color.textFaint,
  },
  // 못 부르는 행은 이름·핸들·자물쇠·칩만 흐리게 한다 — 보조 줄은 **흐리지 않다**. 그 줄이 못
  // 부르는 까닭(「박다연 님만 부를 수 있어요」)의 유일한 눈에 보이는 문장이라, 행 전체에 0.6 을
  // 주면 가장 안 읽히는 글자가 가장 중요한 말을 든다(design-review H1). 눌린 동안은 흐리지 않다.
  mentionLockedDim: {opacity: 0.6},
  // 「아래에 더 있다」 표지가 서는 오른쪽 띠. 행이 이 띠를 비워 두므로 줄이 표지 밑으로 안 간다.
  mentionScrollCue: {paddingEnd: MENTION_CUE_GUTTER},
  mentionMoreCue: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    right: 0,
    width: MENTION_CUE_GUTTER,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mentionMoreChevron: {
    width: 10,
    height: 10,
    borderRightWidth: 2,
    borderBottomWidth: 2,
    borderColor: color.textMuted,
    // 회전한 네모의 시각 중심을 띠의 가운데로 끌어올린다.
    transform: [{translateY: -3}, {rotate: '45deg'}],
  },
  agentNotice: {
    paddingHorizontal: CONV.composerDockInset,
    paddingTop: AGENT_NOTICE_PAD_TOP,
    fontSize: font.meta,
    lineHeight: line.meta,
    color: color.warn,
  },
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
    paddingHorizontal: CONV.composerDockInset,
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
    paddingHorizontal: CONV.composerDockInset,
    paddingTop: space.sm,
    fontSize: font.meta,
    color: color.text,
  },
  pressed: {backgroundColor: color.surfacePressed},
  // ---- 슬래시 목록 (#2945, 시안 `.menu`·`.mi`) ------------------------------
  slashHead: {
    paddingHorizontal: SAFE_GUTTER,
    paddingTop: space.sm,
    paddingBottom: space.xs,
    fontSize: font.meta,
    fontWeight: '700',
    color: color.textMuted,
  },
  slashRow: {
    minHeight: TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: SAFE_GUTTER,
    paddingVertical: space.xs,
  },
  slashRowOn: {backgroundColor: color.surfacePressed},
  slashIcon: {
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surfaceMuted,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
  },
  slashText: {flex: 1, minWidth: 0},
  slashLabel: {fontSize: font.label, lineHeight: line.label, fontWeight: '600', color: color.text},
  slashMatched: {color: color.accentText},
  slashHint: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
  // ---- 키 붙여넣기 차단 (#2945, 시안 `.inlinewarn`) ------------------------
  // 앰버다: 이 팔레트의 `warn`은 「사람이 할 일이 남아 있다 · 여기를 보라」이고,
  // 여기서 사람이 할 일(키를 빼고 보내기)이 실제로 남아 있다. 위 `offline`이
  // 앰버를 뺀 이유(아무도 부르지 않는 차단)와 반대 경우다.
  keyBlock: {
    marginHorizontal: CONV.composerDockInset,
    marginTop: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.warnBorder,
    backgroundColor: color.warnSurface,
  },
  keyBlockText: {
    fontSize: font.meta,
    lineHeight: line.meta,
    fontWeight: '500',
    color: color.text,
  },
});
