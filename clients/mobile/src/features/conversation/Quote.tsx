import {
  QUOTE_CANCEL_LABEL,
  QUOTE_DELETED_TEXT,
  QUOTE_JUMP_HINT,
  QUOTE_NESTED_MARK,
  type QuoteBlock as QuoteBlockModel,
} from '@momo/core/features/timeline/quote';
import {
  memberNameParts,
  type Directory,
} from '@momo/core/features/workspace/directory';
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {color, font, radius, SAFE_GUTTER, space, TOUCH_TARGET} from '../../design/tokens';

// =============================================================================
// 인용 — 본류에 남으면서 맥락만 끌어오는 장치 (ADR-0148).
//
// ## 이 파일이 정하는 것과 정하지 않는 것
//
// 정하지 않는 것: **무엇을 말할지.** 어디까지 자르나(2줄·140자), 지워진 원본을
// 뭐라 부르나, 에이전트의 긴 출력이 인용되면 무엇을 보여주나, 두 번째 겹을 어떻게
// 표시하나 — 전부 `@momo/core/features/timeline/quote` 가 답한다. 그 파일의 머리말이
// 이유를 적어 두었다: *"인용은 정의상 '저기서 저 말을 했다'를 주장하는 장치라서,
// 두 화면이 다르게 자르면 주장 자체가 흔들린다."*
//
// 정하는 것: **폰에서 어떤 무게로 어디에 앉을지.** 그것뿐이다.
//
// ## 스레드와 갈라서는 자리
//
// 같은 대화 안에 두 개의 다른 장치가 있다. 헷갈리면 둘 다 안 쓰게 되므로 네 축을
// 전부 갈랐다:
//
//   스레드(`root_id`)  = **소속**. `MessageRow` 의 `ReplyMarker` — meta 한 줄
//                        「↳ ○○님에게 답글」, 누르면 **다른 화면**이 열린다.
//   인용(`reply_to_id`) = **지목**. 이 파일 — 본문 위의 **블록**, 왼쪽 세로 규칙 +
//                        원문 발췌, 누르면 같은 화면의 **원본 줄로 이동**한다.
//
// 한 줄 vs 블록, 화살표 vs 세로 규칙, 「답글」 vs 「인용」, 다른 화면 vs 같은 화면.
// 색으로만 가르는 판을 먼저 그려 봤고 회색조에서 무너졌다.
//
// ## 세 갈래를 뭉치지 않는다
//
// 코어의 `QuoteBlock` 은 `ready | deleted | unresolved` 이고, 그 셋이 서로 배타인
// 것이 요점이다. 특히 **`unresolved` 를 `deleted` 로 접으면 안 된다** — 실시간으로
// 도착한 인용 답글은 프레임에 원문이 없어서(스냅샷 금지) 아직 못 푼 것뿐인데,
// 그것을 「삭제된 메시지」라고 부르면 화면이 멀쩡한 메시지를 지워졌다고 말한다.
// 「인용했다」는 참이므로 지우지 않고, 「무엇을」은 모르므로 말하지 않는다.
//
// ## 렌더 중 아무것도 조회하지 않는다
//
// 서버가 히스토리 페이지에 원문을 LEFT JOIN 으로 동봉한다
// (`momo-messaging/src/message.rs:1062` — N+1 이 없는 이유). 인용 하나에 요청
// 하나가 붙으면 스크롤 한 번이 요청 폭풍이 되고, 그 폭풍은 정확히 대화가 활발할 때
// 가장 세다. 코어의 `resolveQuote` 도 같은 규율이다: 페이지가 준 것, 아니면 이미
// 화면에 있는 행, 둘 다 없으면 `unresolved`.
// =============================================================================

const UNKNOWN_MEMBER = '알 수 없는 멤버';

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
  if (memberId === null) return UNKNOWN_MEMBER;
  return memberNameParts(directory, memberId, UNKNOWN_MEMBER).name;
}

/**
 * 본류의 인용 블록. 본문 **위**에 온다.
 *
 * 맥락은 내용보다 먼저 읽혀야 이 줄이 무엇에 대한 말인지 알고 본문을 읽는다 —
 * `ReplyMarker` 가 같은 자리에 서는 것과 같은 이유이고, 그래서 한 메시지가 둘을
 * 함께 가질 때(규칙 1) 표식 → 인용 → 본문 순으로 읽힌다.
 *
 * `onJump` 가 없으면 **문장**이다. 원본이 이 화면에 없는데 문을 그리면 눌러도
 * 아무 일이 없는 문이 된다 — 없는 방으로 가는 문은 방이 저기 있다고 말하는
 * 문장보다 나쁘다(이 레포가 롤업·답글 표식에서 이미 두 번 고른 규칙).
 */
export function QuoteBlock({
  block,
  directory,
  onJump,
}: {
  block: QuoteBlockModel;
  directory: Directory;
  /** 원본 줄로 이동. 원본이 로드된 범위 안에 있을 때만 주어진다. */
  onJump?: () => void;
}): React.JSX.Element {
  const jumpable = onJump !== undefined && block.kind !== 'unresolved';
  const inner = (
    <View style={styles.blockInner}>
      <View style={styles.rule} />
      <View style={styles.blockText}>
        {block.kind === 'unresolved' ? (
          // 「인용했다」는 참이고 「무엇을」은 모른다. 모르면 모른다고 말한다.
          <Text style={styles.unresolved} testID="quote-unresolved">
            인용한 원본을 아직 불러오지 않았습니다
          </Text>
        ) : (
          <>
            <View style={styles.blockHead}>
              <Text style={styles.quotedAuthor} numberOfLines={1}>
                {authorLabel(directory, block.authorMemberId)}
              </Text>
              {block.kind === 'ready' && block.edited ? (
                // 인용은 참조이므로 원본이 고쳐지면 따라 바뀐 것이 맞다. 그
                // 사실을 적어 두지 않으면 사람은 자기가 인용한 문장이 조용히
                // 달라진 것을 모른다.
                <Text style={styles.meta} testID="quote-edited">
                  수정됨
                </Text>
              ) : null}
              {block.kind === 'ready' && block.quotesAnother ? (
                <Text style={styles.meta} testID="quote-nested">
                  {QUOTE_NESTED_MARK}
                </Text>
              ) : null}
            </View>
            {block.kind === 'deleted' ? (
              // 사본을 남기지 않는 것이 삭제의 뜻이다(규칙 3). 행의 묘비와 같은
              // 낱말이고, 그 낱말은 코어가 든다.
              <Text style={styles.quotedTombstone} testID="quote-tombstone">
                {QUOTE_DELETED_TEXT}
              </Text>
            ) : (
              <Text style={styles.quotedBody} testID="quote-body">
                {/* 줄 수도 글자 수도 코어가 이미 잘라서 준다. 여기서 한 번 더
                    `numberOfLines` 를 걸면 잘림이 두 곳에서 결정되고, 화면과
                    `truncated` 플래그가 어긋나는 순간이 생긴다.

                    줄이 하나도 없는 경우가 있다: 본문이 공백뿐인 메시지다(코어의
                    `normalizeLines` 가 빈 줄을 버린다). 묘비가 **아니므로** 삭제라
                    말할 수 없고, 빈 칸으로 두면 블록이 이유 없이 자리만 차지한다.
                    행이 같은 경우에 이미 쓰는 낱말을 그대로 쓴다. */}
                {excerptText(block.lines, '\n')}
                {block.truncated ? '…' : ''}
              </Text>
            )}
          </>
        )}
      </View>
    </View>
  );

  if (!jumpable) {
    return (
      <View style={styles.block} testID="quote-block">
        {inner}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={QUOTE_JUMP_HINT}
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
 * 따로 갖지 않고 행의 문장 안에 낱말로 들어가고, 본문보다 **먼저** 들어간다 —
 * 답을 먼저 듣고 질문을 나중에 듣는 사람은 되돌아가야 한다.
 *
 * 행 밖으로 꺼내 두는 이유는 `rowAccessibilityLabel` 과 같다: 인라인으로 조립한
 * 라벨은 아무도 검사하지 않는 라벨이다.
 */
export function quoteAccessibilityPhrase(
  block: QuoteBlockModel,
  directory: Directory,
): string {
  if (block.kind === 'unresolved') return '인용, 원본을 아직 불러오지 않음';
  const who = authorLabel(directory, block.authorMemberId);
  if (block.kind === 'deleted') return `${who} 인용, ${QUOTE_DELETED_TEXT}`;
  return `${who} 인용, ${excerptText(block.lines, ' ')}`;
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
  const preview =
    block.kind === 'deleted'
      ? QUOTE_DELETED_TEXT
      : block.kind === 'unresolved'
      ? '원본을 아직 불러오지 않음'
      : excerptText(block.lines, ' ');
  return (
    <View style={styles.draft} testID="quote-draft">
      <View style={styles.draftRule} />
      <View style={styles.draftText}>
        <Text style={styles.draftLabel} numberOfLines={1}>
          {`${authorLabel(
            directory,
            block.kind === 'unresolved' ? null : block.authorMemberId,
          )} 인용`}
        </Text>
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
        <Text style={styles.draftCancelLabel}>취소</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  // ===========================================================================
  // 배경이 없다 (design-review H-2). 그리고 그것이 이 수리의 핵심이다.
  //
  // 첫 판은 「왼쪽 규칙이 '이건 내 말이 아니다'를 그리고, **배경이 그 범위를
  // 닫는다**」고 적었다. 그 배경을 실제로 재 보면 `surface` on `bg` =
  // **1.084:1** 이다 — 범위를 닫기는커녕 눈에 보이지 않는다. 그래서 블록을
  // 실제로 그리는 것은 선 하나뿐이었고, 그 선이 accent 였으므로 인용은 「참조」가
  // 아니라 **이 표면에서 가장 색이 센 요소**가 됐다.
  //
  // 웹이 같은 자리에서 raised 배경을 넣었다 되돌리며 남긴 문장이 그것이다:
  // *"폭을 꽉 채운 고도 있는 띠는 인용의 무게를 **올린다**."* 그래서 색을 바꾸는
  // 대신 **띠를 걷었다**. 웹 정본도 배경이 없다(`QuoteBlock.tsx` RAIL =
  // `border-l-2 border-line-strong pl-2`, `bg-*` 없음).
  //
  // 덤으로 두 가지가 함께 풀린다:
  //   * 그 배경값(`surface`)은 **행의 눌림 색**이다(`MessageRow.rowPressed`).
  //     가만히 있는 인용이 「지금 눌린 행」과 같은 채움을 쓰고 있었다.
  //   * 눌림 피드백은 남는다 — 배경이 없으니 `surfacePressed` 가 이제 **누를
  //     때만** 나타나고, 그래야 그 색이 자기 뜻을 되찾는다.
  // ===========================================================================
  block: {
    marginTop: space.xs,
    marginBottom: space.xs,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  blockPressed: {backgroundColor: color.surfacePressed},
  blockInner: {flexDirection: 'row'},
  // 세로 규칙. 스레드 표식의 「↳」와 겹치지 않아야 하므로 글리프가 아니라
  // 도형이다 — 화살표 두 개가 한 행에 서면 어느 쪽이 어느 장치인지 못 읽는다.
  //
  // **중성이다** (H-2). accent 는 이 화면에서 이미 두 가지 뜻이다 — 보내기 버튼
  // 채움과 내 반응 칩 테두리. 인용에 같은 색을 주면 세 번째 뜻이 된다.
  // `textFaint`(#6b7280)는 웹의 `--line-strong`(#6f6e73)과 사실상 같은 자리이고,
  // 타임라인 배경 대비 **3.909:1** 로 웹이 컨트롤 테두리에 요구하는 ≥3:1 을
  // 넘는다 — 중성이면서 실제로 보이는 값이다. (`border`(#2a2f38)는 1.406:1 이라
  // 「중성」이라는 말만 지키고 선을 지우게 된다.)
  //
  // **텍스트 토큰을 선 색으로 빌려 쓰고 있다** — 원칙적으로는 이름 있는 테두리
  // 토큰(`borderStrong` 류)이 맞고, 그래야 다음 팔레트 조정에서 텍스트 사정으로
  // 선이 움직이지 않는다. 지금 빌리는 이유는 토큰 전면 정리가 U2(라이트 모드)의
  // 소관이고 여기서 토큰을 하나 세우면 그 결정을 앞질러 못박기 때문이다.
  //
  // 그 결합을 주석이 아니라 **게이트가** 지킨다: `conversationVisual.test.tsx` 가
  // `tokens.ts` 를 실시간으로 읽어 이 선의 대비를 매 런 계산하므로, 텍스트 사정
  // 으로 값이 움직이는 날 ≥3:1 단정이 그 자리에서 빨개진다.
  rule: {width: 2, backgroundColor: color.textFaint},
  blockText: {
    flex: 1,
    paddingVertical: space.xs,
    paddingHorizontal: space.sm,
    gap: space.xs,
  },
  blockHead: {flexDirection: 'row', alignItems: 'baseline', gap: space.xs},
  quotedAuthor: {
    flexShrink: 1,
    fontSize: font.meta,
    color: color.textMuted,
    fontWeight: '600',
  },
  meta: {fontSize: font.meta, color: color.textFaint},
  // 본문보다 한 급 작고 흐리다. 인용은 이 메시지의 **맥락**이지 내용이 아니다.
  quotedBody: {fontSize: font.label, color: color.textMuted, lineHeight: 18},
  quotedTombstone: {
    fontSize: font.label,
    color: color.textFaint,
    fontStyle: 'italic',
  },
  unresolved: {
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
  // 본류 규칙과 같은 중성 (H-2).
  draftRule: {alignSelf: 'stretch', width: 2, backgroundColor: color.textFaint},
  draftText: {flex: 1, gap: space.xs},
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
