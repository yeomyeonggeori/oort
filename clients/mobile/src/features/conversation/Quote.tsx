import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {color, font, radius, SAFE_GUTTER, space, TOUCH_TARGET} from '../../design/tokens';

// =============================================================================
// 인용 — 본류에 남으면서 맥락만 끌어오는 장치 (ADR-0148).
//
// ## 이 파일이 스레드와 갈라서는 자리
//
// 같은 대화 안에 **두 개의 다른 장치**가 있다. 헷갈리면 둘 다 못 쓰게 되므로,
// 갈림은 문구와 모양 양쪽에서 읽혀야 한다:
//
//   스레드(`root_id`)  = **소속**. `MessageRow`의 `ReplyMarker`가 그린다 —
//                        meta 크기 한 줄 「↳ ○○님에게 답글」, 누르면 **다른
//                        화면**(스레드 패널)이 열린다. 본류에서는 접힌다.
//   인용(`reply_to_id`) = **지목**. 이 파일이 그린다 — 본문 위의 **블록**,
//                        왼쪽 세로 규칙 + 원문 미리보기, 누르면 같은 화면의
//                        **원본 줄로 이동**한다. 본류에 그대로 남는다.
//
// 한 줄 vs 블록, 화살표 vs 세로 규칙, 「답글」 vs 「인용」, 다른 화면 vs 같은
// 화면. 네 축이 전부 갈라져 있어야 사람이 둘을 구별한다. 색으로만 가르는 판을
// 먼저 그려 봤고, 회색조에서 완전히 무너졌다.
//
// ## 미리보기는 **페이지가 들고 온 것**이고, 다시 묻지 않는다
//
// 서버가 히스토리 페이지에 인용 원문을 LEFT JOIN 으로 동봉한다
// (`momo-messaging/src/message.rs:1062` — N+1 이 없는 이유가 그것이다). 그래서
// 이 블록은 렌더할 때 **아무것도 조회하지 않는다.** 인용 하나에 요청 하나가
// 붙으면 스크롤 한 번이 요청 폭풍이 되고, 그 폭풍은 정확히 대화가 활발할 때
// 가장 세다.
//
// 조회하지 않는다는 것이 「사본을 굳힌다」는 뜻은 아니다(ADR-0148 규칙 3). 원본이
// 수정되면 **다음 페이지 응답**이 바뀐 본문을 들고 오고, 삭제되면 묘비를 들고
// 온다. 이 파일은 받은 것을 그대로 그릴 뿐 자기 판단으로 캐시하지 않는다.
//
// ## 한 겹만 그린다
//
// 원본이 또 무언가를 인용하고 있으면 「↳ 인용」 표시만 남긴다(규칙 4). 두 번째
// 겹을 펼치면 타임라인이 계단이 되고, 폰에서는 세 번째 겹에서 읽을 수 없게 된다.
// 서버는 그래서 안쪽 대상의 id 를 **일부러 안 준다** — 줄 수 없으니 계단도 못
// 만든다(openapi `QuotedMessage.quotesAnother`).
// =============================================================================

/**
 * 긴 원본을 몇 줄에서 자를 것인가 — ADR-0148 미결에 대한 **폰의 답**.
 *
 * 3줄이다. 인용 블록은 자기가 붙어 있는 메시지보다 **작아야** 한다: 커지는
 * 순간 사람은 인용을 읽고 정작 하려던 말을 흘린다. 폰 폭에서 3줄은 문장 하나가
 * 온전히 들어가고 문단은 안 들어가는 자리이고, 그 이상이 필요하면 원본으로
 * 가면 된다 — 이 블록은 **가는 길을 이미 들고 있다**.
 *
 * 웹과 값이 달라도 된다(ADR 이 그것도 물었다). 자르는 이유가 「블록이 본문을
 * 압도하지 않을 것」이라면 임계는 폭의 함수이고, 폰과 데스크톱의 폭은 다르다.
 */
export const QUOTE_PREVIEW_LINES = 3;

/**
 * 이 블록이 그리는 데 필요한 전부 — **뷰 props 이지 모델이 아니다.**
 *
 * 서버 `QuotedMessage`(openapi: id/seq/authorMemberId/type/body?/state/
 * deletedAtMs?/quotesAnother?)를 코어가 정규화해 주면 호출부가 그 값을 이 모양으로
 * 풀어 넘긴다. 여기서 판정하는 것은 하나도 없다 — 「삭제됐는가」도 「또 인용인가」도
 * 이미 답이 나온 채로 들어온다. 그래야 웹과 폰이 같은 판정을 두 벌 짜지 않는다.
 */
export interface QuotePreview {
  /** 이미 해석된 원문 작성자 이름. 행이 쓰는 것과 같은 답. */
  authorLabel: string;
  /** 원문 본문. 묘비이거나 본문이 없으면 비운다. */
  body?: string;
  /** 원본이 지워졌다. 묘비로 그리고, 갈 곳이 없으므로 누를 수 없다. */
  deleted: boolean;
  /** 원본이 또 무언가를 인용한다 — 표시만, 펼치지 않는다(규칙 4). */
  quotesAnother?: boolean;
}

/**
 * 본류의 인용 블록. 본문 **위**에 온다.
 *
 * 맥락은 내용보다 먼저 읽혀야 이 줄이 무엇에 대한 말인지 알고 본문을 읽는다 —
 * `ReplyMarker` 가 같은 자리에 서는 것과 같은 이유이고, 그래서 한 메시지가 둘을
 * 함께 가질 때(ADR-0148 규칙 1: 스레드 안에서 그 스레드의 답글을 인용) 표식이
 * 먼저, 인용 블록이 그 아래, 본문이 맨 아래로 읽힌다.
 *
 * `onJump` 가 없으면 **문장**이다. 버튼이 아니다 — 원본이 이 화면에 아직 없는데
 * 문을 그리면, 눌렀을 때 아무 일도 일어나지 않는 문이 된다. 없는 방으로 가는
 * 문은 방이 저기 있다고 말하는 문장보다 나쁘다(이 레포가 롤업·답글 표식에서
 * 이미 두 번 고른 규칙).
 */
export function QuoteBlock({
  quote,
  onJump,
}: {
  quote: QuotePreview;
  /** 원본 줄로 이동. 원본이 이 화면에 로드돼 있을 때만 주어진다. */
  onJump?: () => void;
}): React.JSX.Element {
  const body = (quote.body ?? '').trim();
  const inner = (
    <View style={styles.blockInner}>
      <View style={styles.rule} />
      <View style={styles.blockText}>
        <View style={styles.blockHead}>
          <Text style={styles.quotedAuthor} numberOfLines={1}>
            {quote.authorLabel}
          </Text>
          {quote.quotesAnother ? (
            // 한 겹만. 안쪽 대상의 id 는 서버가 주지도 않는다.
            <Text style={styles.nested} testID="quote-nested">
              ↳ 인용
            </Text>
          ) : null}
        </View>
        {quote.deleted ? (
          // 정직하게. 지운 사람의 뜻을 우회하는 사본을 남기지 않는다는 것이
          // ADR-0148 규칙 3 의 절반이고, 나머지 절반이 이 낱말이다. 행의 묘비와
          // **같은 낱말**을 쓴다 — 같은 사실에 두 가지 말을 만들지 않는다.
          <Text style={styles.quotedTombstone} testID="quote-tombstone">
            삭제된 메시지
          </Text>
        ) : (
          <Text
            style={styles.quotedBody}
            numberOfLines={QUOTE_PREVIEW_LINES}
            testID="quote-body">
            {body === '' ? '내용 없는 메시지' : body}
          </Text>
        )}
      </View>
    </View>
  );

  if (!onJump || quote.deleted) {
    return (
      <View style={styles.block} testID="quote-block">
        {inner}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`인용한 원본으로 이동, ${quote.authorLabel}`}
      onPress={onJump}
      style={({pressed}) => [styles.block, pressed && styles.blockPressed]}
      testID="quote-block">
      {inner}
    </Pressable>
  );
}

/**
 * 인용 블록을 VoiceOver 가 읽는 **한 조각의 문장**.
 *
 * 행은 접근성 원소 하나다(`MessageRow` 의 규칙). 그러므로 이 블록도 자기 이름을
 * 따로 갖지 않고 행의 문장 안에 낱말로 들어간다 — 그리고 본문보다 **먼저**
 * 들어간다. 답을 먼저 듣고 질문을 나중에 듣는 사람은 되돌아가야 한다.
 *
 * 행 밖으로 꺼내 두는 이유는 `rowAccessibilityLabel` 과 같다: 인라인으로 조립한
 * 라벨은 아무도 검사하지 않는 라벨이다.
 */
export function quoteAccessibilityPhrase(quote: QuotePreview): string {
  const what = quote.deleted
    ? '삭제된 메시지'
    : (quote.body ?? '').trim() === ''
    ? '내용 없는 메시지'
    : (quote.body ?? '').trim();
  return `${quote.authorLabel} 인용, ${what}`;
}

// -----------------------------------------------------------------------------
// 컴포저의 인용 초안
// -----------------------------------------------------------------------------

/**
 * 「이 메시지를 인용해서 쓰는 중」 — 입력창 바로 위의 줄.
 *
 * ## 나오는 길이 있다
 *
 * ADR-0148 미결 세 번째가 이것이고, 성재의 지적("채팅창 닫는 UX가 미흡")이 그
 * 계열이다: **들어가는 길만 있고 나오는 길이 없으면 안 된다.** 그래서 취소는
 * 44pt 를 깔고 앉은 눈에 보이는 버튼이다 — 인용을 걸어 놓고 마음이 바뀐 사람이
 * 화면을 벗어났다 돌아오는 것 말고 다른 길을 갖는다.
 *
 * ## 왜 한 줄이고 블록이 아닌가
 *
 * 여기 있는 동안 사람은 **자기 글을 쓰고 있다.** 인용 블록만큼 자리를 차지하면
 * 키보드가 올라온 폰에서 정작 입력창이 밀려난다. 원문을 다시 읽고 싶으면 뒤에
 * 그 줄이 그대로 있다 — 컴포저는 확인하는 자리가 아니라 쓰는 자리다.
 */
export function QuoteDraftBar({
  quote,
  onCancel,
}: {
  quote: QuotePreview;
  onCancel: () => void;
}): React.JSX.Element {
  const body = (quote.body ?? '').trim();
  return (
    <View style={styles.draft} testID="quote-draft">
      <View style={styles.draftRule} />
      <View style={styles.draftText}>
        <Text style={styles.draftLabel} numberOfLines={1}>
          {`${quote.authorLabel} 인용`}
        </Text>
        <Text style={styles.draftBody} numberOfLines={1} testID="quote-draft-body">
          {quote.deleted
            ? '삭제된 메시지'
            : body === ''
            ? '내용 없는 메시지'
            : body}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="인용 취소"
        onPress={onCancel}
        style={({pressed}) => [styles.draftCancel, pressed && styles.pressed]}
        testID="quote-draft-cancel">
        <Text style={styles.draftCancelLabel}>취소</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // 블록은 본문과 같은 들여쓰기 안에 있고, 자기 배경을 갖는다. 왼쪽 규칙이
  // 「이건 내 말이 아니다」를 그리는 부분이고, 배경이 그 범위를 닫는다.
  block: {
    marginTop: 2,
    marginBottom: space.xs,
    borderRadius: radius.sm,
    backgroundColor: color.surface,
    overflow: 'hidden',
  },
  blockPressed: {backgroundColor: color.surfacePressed},
  blockInner: {flexDirection: 'row'},
  // 세로 규칙. 스레드 표식의 「↳」와 겹치지 않는 기호여야 해서 글리프가 아니라
  // 도형이다 — 화살표 두 개가 한 행에 서면 어느 쪽이 어느 장치인지 못 읽는다.
  rule: {width: 2, backgroundColor: color.accent},
  blockText: {
    flex: 1,
    paddingVertical: space.xs,
    paddingHorizontal: space.sm,
    gap: 1,
  },
  blockHead: {flexDirection: 'row', alignItems: 'baseline', gap: space.xs},
  quotedAuthor: {
    flexShrink: 1,
    fontSize: font.meta,
    color: color.textMuted,
    fontWeight: '600',
  },
  nested: {fontSize: font.meta, color: color.textFaint},
  // 본문보다 한 급 작고 흐리다. 인용은 이 메시지의 **맥락**이지 내용이 아니다.
  quotedBody: {fontSize: font.label, color: color.textMuted, lineHeight: 18},
  quotedTombstone: {
    fontSize: font.label,
    color: color.textFaint,
    fontStyle: 'italic',
  },

  draft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingLeft: SAFE_GUTTER,
    paddingRight: space.sm,
    paddingVertical: space.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  draftRule: {alignSelf: 'stretch', width: 2, backgroundColor: color.accent},
  draftText: {flex: 1, gap: 1},
  draftLabel: {fontSize: font.meta, color: color.textFaint, fontWeight: '600'},
  draftBody: {fontSize: font.label, color: color.textMuted},
  draftCancel: {
    minHeight: TOUCH_TARGET,
    minWidth: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.sm,
  },
  draftCancelLabel: {fontSize: font.label, color: color.textMuted, fontWeight: '600'},
  pressed: {opacity: 0.6},
});
