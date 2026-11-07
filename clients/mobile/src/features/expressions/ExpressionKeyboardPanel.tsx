import type {Channel} from '@momo/core/lib/api';
import type {Expression} from '@momo/core/features/expressions/types';
import React, {useCallback, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {HEAD_MAX_SCALE} from '../../design/atoms';
import {useStyles} from '../../design/theme';
import {WORD} from '../../lib/techWords';
import {ds2Radius, font, line, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {EmojiPicker} from '../emoji/EmojiPicker';
import {emojiHaptic} from '../emoji/haptics';
import {ExpressionAddSheet} from './ExpressionAddSheet';
import {ExpressionPanelGrid} from './ExpressionPanelGrid';
import {EXPRESSION_TABS, type ExpressionTab} from './expressionViews';
import {TeamEmojiRow} from './TeamEmojiRow';
import {useExpressionMessages, type PlainMessageKey} from './useExpressionMessages';

// =============================================================================
// 키보드 자리의 이모티콘 창 (#5452, owner 2026-11-07 「별도 바텀시트 대신 키보드 영역을 활용」 · 카카오톡 흐름).
//
// 세 탭 - 이모티콘 · 이모지 · GIF. 우리 팀 것과 기본 것을 가르지 않는다(분류는 코어 표 하나, 웹과 같다). 「이모지」라는 말은 탭 이름에만 있다.
//   · 이모티콘·GIF: 그림 격자 + 창 아래 세트 띠(`ExpressionPanelGrid`). 칸을 누르면 **입력창 위 미리 보기**에 올라간다(보내지 않는다).
//   · 이모지: 팀의 작은 이모지 한 줄 + 표준 그림 문자 목록. 누르면 글자처럼 입력창의 커서 자리에 들어간다(미리 보기로 가지 않는다).
// 창의 높이·자리는 호스트(`ConversationLayout` 의 키보드 자리)가 정한다. 이 부품은 그 안을 채울 뿐이다. 바텀시트·검색 칸·머리는 없다 -
// 글자 칸은 키보드를 부르고, 키보드는 이 창이 서 있어야 할 자리를 덮는다.
// =============================================================================

const TAB_LABEL: Readonly<Record<ExpressionTab, PlainMessageKey>> = {
  emoticon: 'expressions.sheet.tabEmoticon',
  emoji: 'expressions.sheet.tabEmoji',
  gif: 'expressions.sheet.tabGif',
};

/**
 * 이번 실행에서 마지막으로 본 탭. 창을 닫았다 다시 열어도 같은 탭이다(카카오톡처럼). 처음은 이모티콘 탭이다 - owner 확정 화면의 첫 탭.
 * 모듈 값이라 시험이 `resetPanelTab` 으로 비운다.
 */
let lastTab: ExpressionTab = WORD.emoticon;
export function resetPanelTab(): void {
  lastTab = WORD.emoticon;
}

const noop = () => {};
// 시험 열쇠는 컴포넌트 밖에서 만든다: 직접 문구 장부는 JSX 안의 문자열 조각을 문구로 센다.
const tabTestId = (id: string) => `expression-panel-tab-${id}`;

export function ExpressionKeyboardPanel({
  previewId,
  onPickBig,
  onInsertText,
  onInsertToken,
  onOpenConversation,
}: {
  /** 지금 입력창 위 미리 보기에 올라 있는 등록의 id. */
  previewId: string | null;
  /** 이모티콘·GIF 를 골랐다: 호스트가 미리 보기에 올리거나(채널) 입력칸에 `:이름:` 으로 넣는다(스레드). */
  onPickBig: (item: Expression) => void;
  /** 표준 그림 문자를 입력칸의 커서 자리에 넣는다. */
  onInsertText: (glyph: string) => void;
  /** 팀의 작은 이모지의 `:이름:` 을 입력칸의 커서 자리에 넣는다 - 앞뒤 띄어쓰기는 호스트(입력칸)가 안다. */
  onInsertToken: (token: string) => void;
  onOpenConversation?: (channel: Channel) => void;
}) {
  const formatMessage = useExpressionMessages();
  const styles = useStyles(buildStyles);
  const [tab, setTabState] = useState<ExpressionTab>(lastTab);
  const [adding, setAdding] = useState(false);
  const setTab = useCallback((next: ExpressionTab) => {
    lastTab = next;
    setTabState(next);
  }, []);

  return (
    <View style={styles.root} testID="expression-panel" accessibilityLabel={formatMessage('expressions.panel.a11y')}>
      <View
        style={styles.track}
        accessibilityRole="tablist"
        accessibilityLabel={formatMessage('expressions.sheet.tabs')}
        testID="expression-panel-tabs">
        {EXPRESSION_TABS.map(id => (
          <Pressable
            key={id}
            accessibilityRole="tab"
            accessibilityLabel={formatMessage(TAB_LABEL[id])}
            accessibilityState={{selected: tab === id}}
            onPress={() => {
              if (tab === id) return;
              emojiHaptic(WORD.tabChanged);
              setTab(id);
            }}
            style={[styles.segment, tab === id && styles.segmentOn]}
            testID={tabTestId(id)}>
            <Text style={[styles.segmentLabel, tab === id && styles.segmentLabelOn]} numberOfLines={1} maxFontSizeMultiplier={HEAD_MAX_SCALE}>
              {formatMessage(TAB_LABEL[id])}
            </Text>
          </Pressable>
        ))}
      </View>
      {tab === WORD.emoji ? (
        <View style={styles.body} testID="expression-panel-emoji">
          {/* 팀의 작은 이모지 한 줄 - 이 탭에 등록이 없으면 줄이 서지 않는다. 고르면 입력칸에 `:이름:` 이 들어간다. */}
          <TeamEmojiRow tab={tab} query="" onSelect={token => onInsertToken(token)} />
          <EmojiPicker embedded={{query: '', onClearQuery: noop, compact: true}} onClose={noop} onSelect={onInsertText} />
        </View>
      ) : (
        <View style={styles.body}>
          {/* 탭마다 새로 선다 - 구역 위치·스크롤이 옆 탭으로 새지 않는다. */}
          <ExpressionPanelGrid key={tab} tab={tab} previewId={previewId} onPick={onPickBig} onAdd={() => setAdding(true)} />
        </View>
      )}
      {adding ? <ExpressionAddSheet onClose={() => setAdding(false)} onOpenConversation={onOpenConversation} /> : null}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {flex: 1, backgroundColor: color.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border},
    // 「상세 | 대화」 스위치와 같은 트랙 말씨: 흐린 판 위에 고른 칸만 떠 있다(옛 시트의 탭 줄과 같다).
    track: {
      flexDirection: WORD.row,
      marginHorizontal: SAFE_GUTTER,
      marginTop: space.sm,
      marginBottom: space.xs,
      padding: space.xs / 2,
      borderRadius: ds2Radius.row,
      backgroundColor: color.surfaceMuted,
    },
    segment: {
      flex: 1,
      minHeight: TOUCH_TARGET,
      paddingHorizontal: space.sm,
      alignItems: WORD.center,
      justifyContent: WORD.center,
      borderRadius: ds2Radius.row - space.xs / 2,
    },
    segmentOn: {backgroundColor: color.surface},
    segmentLabel: {fontSize: font.label, lineHeight: line.label, color: color.textMuted, fontWeight: '600'},
    segmentLabelOn: {color: color.text},
    body: {flex: 1},
  });
