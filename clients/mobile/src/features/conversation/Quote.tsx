import {missingMemberLabel} from '@momo/core/features/workspace/directory';
import {
  QUOTE_CANCEL_LABEL,
  QUOTE_DELETED_TEXT,
  QUOTE_JUMP_HINT,
  QUOTE_NESTED_MARK,
  quoteHeadAuthorId,
  type QuoteBlock as QuoteBlockModel,
} from '@momo/core/features/timeline/quote';
import type {MessageService} from '@momo/core/i18n/types';
import {
  memberNameParts,
  type Directory,
} from '@momo/core/features/workspace/directory';
import React, {useMemo} from 'react';
import {Image, Pressable, StyleSheet, Text, View} from 'react-native';
import {CONV_ICON_SIZE, CONV_ICONS} from '../../design/icons';
import {usePalette, useStyles} from '../../design/theme';
import {font, line, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {appNote} from './appVoice';
import {otherBubbleFill, quoteHeadFor, type QuoteHeadColors} from './bubble';
import {CONV} from './convDesign';

// =============================================================================
// 인용 — 본류에 남으면서 맥락만 끌어오는 장치 (ADR-0148) · 말풍선 **안** 윗칸 머리 (#5381 Q4).
//
// ## 이 파일이 정하는 것과 정하지 않는 것
//
// 정하지 않는 것: **무엇을 말할지.** 어디까지 자르나(1줄·140자), 지워진 원본을
// 뭐라 부르나, 에이전트의 긴 출력이 인용되면 무엇을 보여주나, 두 번째 겹을 어떻게
// 표시하나, 머리 문장의 낱말(「{이름}에게 답장」)과 이름을 부를지 — 전부
// `@momo/core/features/timeline/quote` 와 코어 사전이 답한다. 그 파일의 머리말이
// 이유를 적어 두었다: *"인용은 정의상 '저기서 저 말을 했다'를 주장하는 장치라서,
// 두 화면이 다르게 자르면 주장 자체가 흔들린다."*
//
// 정하는 것: **폰에서 어떤 무게로 어디에 앉을지.** 그것뿐이다.
//
// ## 말풍선 안 윗칸이다 (#5381, owner 2026-11-05)
//
// 답장 메시지는 한 덩어리다. 말풍선 **안**에서 윗칸이 머리이고, 가는 선 아래가 답 본문이다:
//
//   ┌────────────────────────────────┐
//   │ ↩ 하늘에게 답장                  │  머리(띠): 아이콘 + 이름 문장
//   │ 배포 되돌리기 절차 정리해 줄래요… │          원문 **1줄**(말줄임)
//   ├────────────────────────────────┤  가는 선
//   │ 세 단계예요. 릴리스 태그를 …      │  본문
//   └────────────────────────────────┘
//
// 1차(ADR-0148)는 말풍선 **위**에 왼쪽 세로 규칙(2px)이 달린 블록을 세웠다. owner 의견은 「왼쪽 둥근 세로
// 테두리는 흔한 AI 모양」이었고, 그래서 **세로 규칙은 이 표면 어디에도 없다.** 머리는 말풍선과 한 덩어리라
// 말풍선 코드(`MessageBody`)가 머리를 자기 첫 말풍선의 윗칸으로 그리고, 말풍선이 없는 자리(코드 블록뿐인
// 글·이모티콘·첨부만 보낸 답장·줄 보기 배치)에서는 같은 머리가 **자기 말풍선**으로 선다(`QuoteHeadBubble`).
//
// 머리의 색은 말풍선 색에서 유도한다(`bubble.ts` `quoteHeadFor` — 신호색 위든 표면 위든 글자 4.5:1).
//
// ## 스레드와 갈라서는 자리
//
// 같은 대화 안에 두 개의 다른 장치가 있다. 헷갈리면 둘 다 안 쓰게 되므로 축을
// 전부 갈랐다:
//
//   스레드(`root_id`)  = **소속**. `MessageRow` 의 `ReplyMarker` — meta 한 줄
//                        「↳ ○○님에게 답글」, 누르면 **다른 화면**이 열린다.
//   인용(`reply_to_id`) = **지목**. 이 파일 — 말풍선 안 윗칸의 **머리**, 답장 아이콘 +
//                        「○○에게 답장」 + 원문 발췌, 누르면 같은 화면의 **원본 줄로 이동**한다.
//
// 한 줄 vs 머리, 화살표(↳) vs 답장 아이콘(↩), 「답글」 vs 「답장」, 다른 화면 vs 같은 화면.
//
// ## 세 갈래를 뭉치지 않는다
//
// 코어의 `QuoteBlock` 은 `ready | deleted | unresolved` 이고, 그 셋이 서로 배타인
// 것이 요점이다. 특히 **`unresolved` 를 `deleted` 로 접으면 안 된다** — 실시간으로
// 도착한 인용 답글은 프레임에 원문이 없어서(스냅샷 금지) 아직 못 푼 것뿐인데,
// 그것을 「삭제된 메시지」라고 부르면 화면이 멀쩡한 메시지를 지워졌다고 말한다.
// 「인용했다」는 참이므로 지우지 않고, 「무엇을」은 모르므로 말하지 않는다. 셋 다 **같은 머리
// 자리**에 서고, 이름을 모르는 둘(못 푼 인용·저자를 잃은 지워진 원본)은 이름 없는 문장
// (「메시지에 답장」)을 말한다.
//
// ## 렌더 중 아무것도 조회하지 않는다
//
// 서버가 히스토리 페이지에 원문을 LEFT JOIN 으로 동봉한다
// (`momo-messaging/src/message.rs:1062` — N+1 이 없는 이유). 인용 하나에 요청
// 하나가 붙으면 스크롤 한 번이 요청 폭풍이 되고, 그 폭풍은 정확히 대화가 활발할 때
// 가장 세다. 코어의 `resolveQuote` 도 같은 규율이다: 페이지가 준 것, 아니면 이미
// 화면에 있는 행, 둘 다 없으면 `unresolved`.
// =============================================================================


/**
 * 발췌가 비었을 때 할 말.
 *
 * 코어의 `normalizeLines` 는 빈 줄을 버리므로, 본문이 공백뿐인 메시지는 줄이
 * 하나도 없는 `ready` 블록이 된다. 묘비가 **아니므로** 삭제라 말할 수 없고, 빈
 * 칸으로 두면 블록이 이유 없이 자리만 차지한다. `MessageRow` 가 같은 경우에 이미
 * 쓰는 낱말이다 — 같은 사실에 두 가지 말을 만들지 않는다.
 */
const EMPTY_BODY_TEXT = '내용 없는 메시지';

/** 발췌 줄들을 한 덩이로. 비었으면 빈 칸 대신 그렇다고 말한다. */
function excerptText(lines: readonly string[], separator: string): string {
  return lines.length === 0 ? EMPTY_BODY_TEXT : lines.join(separator);
}

function authorLabel(directory: Directory, memberId: string | null): string {
  if (memberId === null) return missingMemberLabel(directory);
  return memberNameParts(directory, memberId, missingMemberLabel(directory)).name;
}

/**
 * 머리 첫 줄의 문장 「{이름}에게 답장」 (사전 `timeline.quote.head`).
 *
 * 이름을 부를지는 코어가 정한다(`quoteHeadAuthorId` — 웹과 같은 판정). 이름이 없으면(못 푼 인용·저자를 잃은
 * 지워진 원본) 이름을 지어내지 않고 이름 없는 문장을 말한다. 순수 함수다 — 행의 화면 낭독 문장이 같은 낱말을
 * 읽도록 `quoteAccessibilityPhrase` 도 이 함수를 쓴다(눈과 귀가 다른 문장을 말하지 않는다).
 */
export function quoteHeadLabel(
  block: QuoteBlockModel,
  directory: Directory,
  formatMessage: MessageService['formatMessage'],
): string {
  const authorId = quoteHeadAuthorId(block);
  if (authorId === null) return formatMessage('timeline.quote.headUnnamed');
  return formatMessage('timeline.quote.head', {name: authorLabel(directory, authorId)});
}

/**
 * 본류의 인용 머리. 말풍선 **안** 윗칸이다(`MessageBody` 가 자기 첫 말풍선 안에 놓는다).
 *
 * 맥락은 내용보다 먼저 읽혀야 이 줄이 무엇에 대한 말인지 알고 본문을 읽는다 —
 * `ReplyMarker` 가 같은 자리에 서는 것과 같은 이유이고, 그래서 한 메시지가 둘을
 * 함께 가질 때(규칙 1) 표식 → 인용 → 본문 순으로 읽힌다.
 *
 * `onJump` 가 없으면 **문장**이다. 원본이 이 화면에 없는데 문을 그리면 눌러도
 * 아무 일이 없는 문이 된다 — 없는 방으로 가는 문은 방이 저기 있다고 말하는
 * 문장보다 나쁘다(이 레포가 롤업·답글 표식에서 이미 두 번 고른 규칙).
 *
 * `colors` 는 머리가 앉은 말풍선에서 유도한 색이다(`quoteHeadFor`). 말풍선 밖에서 단독으로 그릴 때(시험·격리
 * 화면)는 남 말풍선의 기본 색으로 선다. `divider` 는 이 머리 **아래에 본문이 선다**는 뜻이다 — 그때만 가는 선을
 * 긋는다(본문 없는 머리뿐인 말풍선에는 선이 갈 곳이 없다).
 */
export function QuoteBlock({
  block,
  directory,
  onJump,
  attachmentCount = 0,
  colors,
  divider = false,
  radius = 0,
}: {
  block: QuoteBlockModel;
  directory: Directory;
  /** 원본 줄로 이동. 원본이 로드된 범위 안에 있을 때만 주어진다. */
  onJump?: () => void;
  /** 이미 로드된 원본 행이 가진 첨부 수. 바이트를 중첩하지 않고 유실만 막는다. */
  attachmentCount?: number;
  colors?: QuoteHeadColors;
  divider?: boolean;
  /**
   * 머리가 앉은 말풍선의 반경. 머리 띠는 말풍선 가장자리까지 차므로 **위쪽 두 모서리**를 그 반경으로 둥글린다 — 말풍선을 잘라 내는(`overflow`) 대신
   * 띠가 모서리를 따라간다. 아래에 본문이 없으면(`divider` 없음: 머리뿐인 말풍선) 아래 두 모서리도 같은 반경이다.
   */
  radius?: number;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const formatMessage = useFormatMessage();
  const fallback = useMemo(
    () => quoteHeadFor(palette, {bg: otherBubbleFill(palette), fg: palette.text}, false),
    [palette],
  );
  const c = colors ?? fallback;
  const jumpable = onJump !== undefined && block.kind !== 'unresolved';
  const label = quoteHeadLabel(block, directory, formatMessage);
  const headStyle = [
    styles.head,
    {backgroundColor: c.fill, borderTopLeftRadius: radius, borderTopRightRadius: radius},
    divider
      ? {borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.line}
      : {borderBottomLeftRadius: radius, borderBottomRightRadius: radius},
  ];
  const inner = (
    <>
      <View style={styles.labelRow}>
        <Image
          source={CONV_ICONS.quoteReply}
          style={[styles.icon, {tintColor: c.label}]}
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
        <Text style={[styles.label, {color: c.label}]} numberOfLines={1} testID="quote-head-label">
          {label}
        </Text>
        {block.kind === 'ready' && block.edited ? (
          // 인용은 참조이므로 원본이 고쳐지면 따라 바뀐 것이 맞다. 그
          // 사실을 적어 두지 않으면 사람은 자기가 인용한 문장이 조용히
          // 달라진 것을 모른다.
          <Text style={[styles.mark, {color: c.excerpt}]} testID="quote-edited">
            수정됨
          </Text>
        ) : null}
        {block.kind === 'ready' && block.quotesAnother ? (
          <Text style={[styles.mark, {color: c.excerpt}]} testID="quote-nested">
            {QUOTE_NESTED_MARK}
          </Text>
        ) : null}
      </View>
      {block.kind === 'unresolved' ? (
        // 「인용했다」는 참이고 「무엇을」은 모른다. 모르면 모른다고 말한다.
        <Text style={[styles.excerpt, {color: c.excerpt}]} numberOfLines={1} testID="quote-unresolved">
          {appNote('인용한 원본을 아직 불러오지 않았습니다')}
        </Text>
      ) : block.kind === 'deleted' ? (
        // 사본을 남기지 않는 것이 삭제의 뜻이다(규칙 3). 행의 묘비와 같은
        // 낱말이고, 그 낱말은 코어가 든다.
        <Text style={[styles.excerpt, {color: c.excerpt}]} numberOfLines={1} testID="quote-tombstone">
          {appNote(QUOTE_DELETED_TEXT)}
        </Text>
      ) : (
        <Text style={[styles.excerpt, {color: c.excerpt}]} numberOfLines={1} testID="quote-body">
          {/* 줄 수와 글자 수는 코어가 이미 잘라서 준다(1줄·140자). **한 줄 말줄임은 화면이 맡는다**:
              코어의 글자 예산은 폭 밖의 상한이고 좁은 폭에서는 한 줄도 넘치므로 `numberOfLines` 가
              끝을 자른다. 둘은 다른 예산이다 — 코어가 자른 사실(`truncated`)은 「…」로 따로 남는다.

              줄이 하나도 없는 경우가 있다: 본문이 공백뿐인 메시지다(코어의
              `normalizeLines` 가 빈 줄을 버린다). 묘비가 **아니므로** 삭제라 말할 수 없고, 빈 칸으로
              두면 머리가 이유 없이 자리만 차지한다. 행이 같은 경우에 이미 쓰는 낱말을 그대로 쓴다. */}
          {excerptText(block.lines, ' ')}
          {block.truncated ? '…' : ''}
        </Text>
      )}
      {block.kind === 'ready' && attachmentCount > 0 ? (
        <Text style={[styles.mark, {color: c.excerpt}]} numberOfLines={1} testID="quote-attachments">
          {`첨부 파일 ${attachmentCount}개`}
        </Text>
      ) : null}
    </>
  );

  if (!jumpable) {
    return (
      <View style={headStyle} testID="quote-block">
        {inner}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={QUOTE_JUMP_HINT}
      onPress={onJump}
      style={({pressed}) => [headStyle, pressed && styles.headPressed]}
      testID="quote-block">
      {inner}
    </Pressable>
  );
}

/**
 * 인용 머리를 VoiceOver 가 읽는 **한 조각의 문장** — 「{이름}에게 답장, {원문}」.
 *
 * 행은 접근성 원소 하나다(`MessageRow` 의 규칙). 그러므로 이 머리도 자기 이름을
 * 따로 갖지 않고 행의 문장 안에 낱말로 들어가고, 본문보다 **먼저** 들어간다 —
 * 답을 먼저 듣고 질문을 나중에 듣는 사람은 되돌아가야 한다. 눈이 보는 머리 문장과
 * **같은 낱말**이다(`quoteHeadLabel`): 눈과 귀가 다른 문장을 말하면 둘 중 하나가 거짓이다.
 *
 * 행 밖으로 꺼내 두는 이유는 `rowAccessibilityLabel` 과 같다: 인라인으로 조립한
 * 라벨은 아무도 검사하지 않는 라벨이다.
 */
export function quoteAccessibilityPhrase(
  block: QuoteBlockModel,
  directory: Directory,
  formatMessage: MessageService['formatMessage'],
  attachmentCount = 0,
): string {
  const head = quoteHeadLabel(block, directory, formatMessage);
  if (block.kind === 'unresolved') return `${head}, 원본을 아직 불러오지 않음`;
  if (block.kind === 'deleted') return `${head}, ${QUOTE_DELETED_TEXT}`;
  return `${head}, ${excerptText(block.lines, ' ')}${
    attachmentCount > 0 ? `, 첨부 파일 ${attachmentCount}개` : ''
  }`;
}

// -----------------------------------------------------------------------------
// 컴포저의 인용 초안
// -----------------------------------------------------------------------------

/**
 * 「이 메시지를 인용해서 쓰는 중」 — 입력창 바로 위의 줄. 행의 머리와 **같은 문법**이다(#5381):
 * 아이콘 + 「{이름}에게 답장」 + 원문 1줄 + 닫기. 세로 규칙은 없다.
 *
 * ## 나오는 길이 있다
 *
 * ADR-0148 미결 세 번째가 이것이고, 성재의 지적("채팅창 닫는 UX가 미흡")이 그
 * 계열이다: **들어가는 길만 있고 나오는 길이 없으면 안 된다.** 그래서 닫기는
 * 44pt 를 깔고 앉은 눈에 보이는 버튼이다.
 *
 * ## 왜 한 줄이고 블록이 아닌가
 *
 * 여기 있는 동안 사람은 **자기 글을 쓰고 있다.** 인용 블록만큼 자리를 차지하면
 * 키보드가 올라온 폰에서 정작 입력창이 밀려난다. 원문을 다시 읽고 싶으면 뒤에
 * 그 줄이 그대로 있다 — 컴포저는 확인하는 자리가 아니라 쓰는 자리다.
 */
export function QuoteDraftBar({
  block,
  directory,
  onCancel,
}: {
  block: QuoteBlockModel;
  directory: Directory;
  onCancel: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const formatMessage = useFormatMessage();
  const label = quoteHeadLabel(block, directory, formatMessage);
  const preview =
    block.kind === 'deleted'
      ? QUOTE_DELETED_TEXT
      : block.kind === 'unresolved'
      ? '원본을 아직 불러오지 않음'
      : excerptText(block.lines, ' ');
  return (
    <View style={styles.draft} testID="quote-draft">
      <View style={styles.draftText}>
        <View style={styles.labelRow}>
          <Image
            source={CONV_ICONS.quoteReply}
            style={[styles.icon, {tintColor: palette.textMuted}]}
            accessibilityElementsHidden
            importantForAccessibility="no"
          />
          <Text style={styles.draftLabel} numberOfLines={1} testID="quote-draft-label">
            {label}
          </Text>
        </View>
        <Text style={styles.draftBody} numberOfLines={1} testID="quote-draft-body">
          {preview}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={QUOTE_CANCEL_LABEL}
        onPress={onCancel}
        style={({pressed}) => [styles.draftCancel, pressed && styles.pressed]}
        testID="quote-draft-cancel">
        <Image
          source={CONV_ICONS.cross}
          style={[styles.cross, {tintColor: palette.textMuted}]}
        />
      </Pressable>
    </View>
  );
}

const buildStyles = (color: Palette) => StyleSheet.create({
  // ===========================================================================
  // 머리는 말풍선 **안**의 띠다 (#5381 Q4).
  //
  // 옛 판(ADR-0148 · design-review H-2)은 말풍선 **위**에 서서 「배경이 없다」였다: 그 배경을 실제로 재 보면
  // `surface` on `bg` = 1.100:1 이라 범위를 닫기는커녕 눈에 보이지 않았고, 블록을 실제로 그리는 것은 선 하나뿐이었다.
  // 이제 머리는 **말풍선과 한 덩어리**이고 띠의 색은 말풍선 색에서 유도한다(`quoteHeadFor`) — 보이는지는 말풍선의
  // 대비가 지고, 띠가 말풍선보다 도드라지지 않으므로 인용의 무게가 본문 위로 올라가지 않는다. 눌림 피드백은 띠가
  // 흐려지는 것이다(`headPressed`).
  //
  // 세로 규칙은 없다. 옛 `rule` 의 중성 색 결합(`textFaint` 가 웹 `--line-strong` 과 같은 자리라는 시험)도 함께 사라졌다.
  // ===========================================================================
  head: {
    paddingHorizontal: CONV.bubblePadX,
    paddingVertical: space.sm,
  },
  headPressed: {opacity: 0.7},
  labelRow: {flexDirection: 'row', alignItems: 'center', gap: space.xs},
  icon: {width: CONV_ICON_SIZE.quoteReply, height: CONV_ICON_SIZE.quoteReply},
  // 머리 첫 줄: 이름 문장. 굵게(600) 한 줄 — 원문(줄 아래)보다 한 단 작다(12 · 13).
  label: {flexShrink: 1, fontSize: font.meta, lineHeight: line.meta, fontWeight: '600'},
  // 붙는 표시(수정됨·인용 포함·첨부)는 이름 문장 오른쪽에 **줄어들지 않고** 선다 — 이름이 말줄임으로 양보한다.
  mark: {flexShrink: 0, fontSize: font.meta, lineHeight: line.meta},
  // 원문 1줄. 말풍선 본문(16)보다 작고(13) 보조 색이다 — 인용은 이 메시지의 **맥락**이지 내용이 아니다.
  excerpt: {fontSize: font.label, lineHeight: line.label},

  draft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: CONV.composerDockInset,
    paddingRight: space.sm,
    paddingVertical: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  draftText: {flex: 1, minWidth: 0},
  draftLabel: {flexShrink: 1, fontSize: font.meta, lineHeight: line.meta, color: color.textMuted, fontWeight: '600'},
  draftBody: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
  draftCancel: {
    minHeight: TOUCH_TARGET,
    minWidth: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cross: {width: CONV_ICON_SIZE.cross, height: CONV_ICON_SIZE.cross},
  pressed: {opacity: 0.6},
});
