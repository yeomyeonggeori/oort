import React, {useState} from 'react';
import {Keyboard, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {SHELL_ICONS} from '../../design/icons';
import {
  PageSheet,
  usePageSheetAction,
  usePageSheetClose,
} from '../../design/PageSheet';
import {SheetHeader} from '../../design/SheetChrome';
import {InputPill} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {
  ds2Radius,
  font,
  line,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {EmojiPicker} from '../emoji/EmojiPicker';
import {emojiHaptic} from '../emoji/haptics';
import {
  DEFAULT_EXPRESSION_TAB,
  EXPRESSION_TAB_ACTION,
  EXPRESSION_TABS,
  type ExpressionTab,
} from './expressionViews';
import {TeamExpressionPicker} from './TeamExpressionPicker';
import {
  useExpressionMessages,
  type PlainMessageKey,
} from './useExpressionMessages';

// =============================================================================
// 입력창 표현 시트 (#4942, owner 10-31) — 보내기 왼쪽 단추 하나가 여는 바텀시트.
//
// 카카오톡처럼 네 탭(이모티콘 · 이모지 · 팀 이모지 · GIF)을 오가고, 맨 위 검색 하나가 **지금 탭**을 거른다(검색어는 탭을
// 옮겨도 남는다). 하는 일은 탭이 정한다 — 이모티콘·GIF 는 큰 그림을 미리 보고 「보내기」로 **대화에 보내고**, 이모지·팀
// 이모지는 **입력칸에 넣는다**(`expressionViews.ts` 머리말: 종류를 나누는 기준과 같은 보관함의 보기라는 약속).
//
// 안쪽 본문은 새로 짓지 않았다: 이모지 탭은 반응·상태 고르개가 쓰는 `EmojiPicker` 의 본문(`embedded`), 나머지 셋은
// `TeamExpressionPicker` 의 `view` 다. 둘 다 시트 규칙(phone-sheets.md)의 그릇·머리를 그대로 쓰고, 이 파일은 머리·검색·탭
// 줄만 갖는다. 「＋ 추가하기」(#4891)의 안쪽 장이 열려 있는 동안은 검색·탭 줄을 접는다 — 장에는 자기 머리(‹)가 있고
// 좁은 화면(SE + 키보드)에서 폼이 그 자리를 써야 한다.
// =============================================================================

const TAB_LABEL: Readonly<Record<ExpressionTab, PlainMessageKey>> = {
  emoticon: 'expressions.sheet.tabEmoticon',
  emoji: 'expressions.sheet.tabEmoji',
  team: 'expressions.sheet.tabTeam',
  gif: 'expressions.sheet.tabGif',
};
const SEARCH_LABEL: Readonly<Record<ExpressionTab, PlainMessageKey>> = {
  emoticon: 'expressions.sheet.searchEmoticon',
  emoji: 'expressions.sheet.searchEmoji',
  team: 'expressions.sheet.searchTeam',
  gif: 'expressions.sheet.searchGif',
};

export function ExpressionComposerPicker({
  onClose,
  onInsert,
  onInsertExpression,
  onSend,
  onOpenConversation,
}: {
  onClose: () => void;
  /** 표준 이모지 글자를 입력칸에 넣는다. */
  onInsert: (glyph: string) => void;
  /** 팀 이모지의 `:이름:` 을 입력칸에 넣는다 — 앞뒤 띄어쓰기는 호스트(입력칸)가 안다. */
  onInsertExpression: (token: string) => void;
  /** 이모티콘·GIF 의 `:이름:` 을 한 메시지로 보낸다. */
  onSend: (body: string) => void;
  /** 「AI와 만들기」 요청을 보낸 뒤 그 DM 으로 간다. 호스트(입력창)가 대화로 가는 길을 줄 때만 선다. */
  onOpenConversation?: React.ComponentProps<
    typeof TeamExpressionPicker
  >['onOpenConversation'];
}) {
  const afterClose = usePageSheetAction();
  const closePicker = usePageSheetClose() ?? onClose;
  const formatMessage = useExpressionMessages();
  const styles = useStyles(buildStyles);
  const [tab, setTab] = useState<ExpressionTab>(DEFAULT_EXPRESSION_TAB);
  const [query, setQuery] = useState('');
  const [chapterOpen, setChapterOpen] = useState(false);

  return (
    <>
      <SheetHeader
        title={formatMessage('expressions.sheet.title')}
        closeLabel={formatMessage('expressions.sheet.close')}
        onClose={closePicker}
        closeTestID="expression-sheet-close"
      />
      {chapterOpen ? null : (
        <View style={styles.controls}>
          <InputPill
            icon={SHELL_ICONS.search}
            value={query}
            onChangeText={setQuery}
            placeholder={formatMessage(
              tab === 'emoji'
                ? 'expressions.sheet.placeholderEmoji'
                : 'expressions.sheet.placeholderTeam',
            )}
            accessibilityLabel={formatMessage(SEARCH_LABEL[tab])}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            onSubmitEditing={Keyboard.dismiss}
            clearButtonMode="while-editing"
            testID="expression-sheet-search"
          />
          <View style={styles.track}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              accessibilityRole="tablist"
              accessibilityLabel={formatMessage('expressions.sheet.tabs')}
              contentContainerStyle={styles.trackContent}
              testID="expression-sheet-tabs">
              {EXPRESSION_TABS.map(id => (
                <Pressable
                  key={id}
                  accessibilityRole="tab"
                  accessibilityLabel={formatMessage(TAB_LABEL[id])}
                  accessibilityState={{selected: tab === id}}
                  onPress={() => {
                    if (tab === id) return;
                    emojiHaptic('tabChanged');
                    setTab(id);
                  }}
                  style={[styles.segment, tab === id && styles.segmentOn]}
                  testID={`expression-sheet-tab-${id}`}>
                  <Text
                    style={[styles.segmentLabel, tab === id && styles.segmentLabelOn]}
                    numberOfLines={1}>
                    {formatMessage(TAB_LABEL[id])}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      )}
      {tab === 'emoji' ? (
        <EmojiPicker
          // 검색어는 이 시트가 쥔다 — 본문의 「검색 지우기」도 이 검색어를 비워야 눌린 것이다(#5065).
          embedded={{query, onClearQuery: () => setQuery('')}}
          onClose={onClose}
          onSelect={glyph => afterClose(() => onInsert(glyph))}
        />
      ) : (
        <TeamExpressionPicker
          // 탭마다 새로 선다 — 미리보기·안쪽 장·스크롤이 옆 탭으로 새지 않는다.
          key={tab}
          view={tab}
          mode={EXPRESSION_TAB_ACTION[tab] === 'send' ? 'message' : 'insert'}
          query={query}
          onSelect={token =>
            afterClose(() =>
              EXPRESSION_TAB_ACTION[tab] === 'send'
                ? onSend(token)
                : onInsertExpression(token),
            )
          }
          onOpenConversation={onOpenConversation}
          onChapterChange={setChapterOpen}
        />
      )}
    </>
  );
}

/** The sheet owns its modal so the composer's unrelated scroll views stay outside it. */
export function ExpressionComposerModal({
  onClose,
  ...rest
}: React.ComponentProps<typeof ExpressionComposerPicker>) {
  const formatMessage = useExpressionMessages();
  return (
    <PageSheet
      onClose={onClose}
      accessibilityLabel={formatMessage('expressions.sheet.a11y')}>
      <ExpressionComposerPicker onClose={onClose} {...rest} />
    </PageSheet>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    controls: {paddingHorizontal: SAFE_GUTTER, gap: space.sm},
    // 「상세 | 대화」 스위치(`WorkConversation` 의 `ModeSwitch`)와 같은 트랙 말씨: 흐린 판 위에 고른 칸만 떠 있다.
    track: {
      padding: space.xs / 2,
      borderRadius: ds2Radius.row,
      backgroundColor: color.surfaceMuted,
    },
    // 큰 글자에서는 네 칸이 한 줄에 못 들어 가로로 민다 — 좁을 때만 늘어나고(`flexGrow`) 넘치면 제 폭을 지킨다.
    trackContent: {flexGrow: 1},
    segment: {
      flexGrow: 1,
      minHeight: TOUCH_TARGET,
      paddingHorizontal: space.md,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: ds2Radius.row - space.xs / 2,
    },
    segmentOn: {backgroundColor: color.surface},
    segmentLabel: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
      fontWeight: '600',
    },
    segmentLabelOn: {color: color.text},
  });
