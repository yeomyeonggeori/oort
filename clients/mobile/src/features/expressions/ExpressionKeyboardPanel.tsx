import type {Channel} from '@momo/core/lib/api';
import type {Expression} from '@momo/core/features/expressions/types';
import {emptyExpressionUsage} from '@momo/core/features/expressions/usage';
import React, {useCallback, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {HEAD_MAX_SCALE} from '../../design/atoms';
import {useStyles} from '../../design/theme';
import {WORD} from '../../lib/techWords';
import {ds2Radius, font, line, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {EmojiPicker} from '../emoji/EmojiPicker';
import {emojiHaptic} from '../emoji/haptics';
import {useKeyboardHeight} from '../../lib/useKeyboardHeight';
import {ExpressionAddSheet} from './ExpressionAddSheet';
import {useExpressionStore} from './ExpressionProvider';
import {ExpressionPanelGrid} from './ExpressionPanelGrid';
import {DEFAULT_EXPRESSION_TAB, EXPRESSION_TABS, type ExpressionTab} from './expressionViews';
import type {PanelOpening} from './panelModel';
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
 * 이번 실행에서 마지막으로 본 탭. 창을 닫았다 다시 열어도 같은 탭이다(카카오톡처럼). 처음은 코어의 처음 여는 탭(`DEFAULT_EXPRESSION_TAB` = 이모티콘, owner 확정 화면의 첫 탭)이다 -
 * 웹 고르개가 열리는 탭과 같은 상수 하나라서 한쪽만 바뀌지 않는다(#5482). 모듈 값이라 시험이 `resetPanelTab` 으로 비운다.
 */
let lastTab: ExpressionTab = DEFAULT_EXPRESSION_TAB;
export function resetPanelTab(): void {
  lastTab = DEFAULT_EXPRESSION_TAB;
}

const noop = () => {};

/**
 * 시트 안에서만 쓴다: 검색 칸의 키보드가 올라오면 격자와 세트 띠를 키보드 위로 올린다(시트는 키보드에 안 밀린다). 이모지 탭의 표준 목록(`EmojiPicker`)은 제 목록에서 직접 한다.
 * 입력창 창(키보드 자리)에서는 쓰지 않는다 - 거기서는 창이 키보드 자리를 차지하고 키보드와 함께 서지 않는다.
 */
function KeyboardInset({children}: {children: React.ReactNode}) {
  const keyboardHeight = useKeyboardHeight();
  const insets = useSafeAreaInsets();
  return <View style={[inset.fill, {marginBottom: Math.max(0, keyboardHeight - insets.bottom)}]}>{children}</View>;
}
const inset = StyleSheet.create({fill: {flex: 1}});
// 시험 열쇠는 컴포넌트 밖에서 만든다: 직접 문구 장부는 JSX 안의 문자열 조각을 문구로 센다.
const tabTestId = (id: string) => `expression-panel-tab-${id}`;

export function ExpressionKeyboardPanel({
  previewId,
  onPickBig,
  onInsertText,
  onInsertToken,
  onOpenConversation,
  initialTab,
  rememberTab = true,
  compact = true,
  inSheet = false,
  query = '',
  onClearQuery = noop,
}: {
  /** 지금 입력창 위 미리 보기에 올라 있는 등록의 id. */
  previewId: string | null;
  /** 이모티콘·GIF 를 골랐다: 호스트가 미리 보기에 올리거나(대화·스레드 입력창, 답글 머리말이 걸려 있어도 같다) 입력칸에 `:이름:` 으로 넣는다(묶음 보내기를 켜지 않은 입력창). */
  onPickBig: (item: Expression) => void;
  /** 표준 그림 문자를 입력칸의 커서 자리에 넣는다. */
  onInsertText: (glyph: string) => void;
  /** 팀의 작은 이모지의 `:이름:` 을 입력칸의 커서 자리에 넣는다 - 앞뒤 띄어쓰기는 호스트(입력칸)가 안다. */
  onInsertToken: (token: string) => void;
  onOpenConversation?: (channel: Channel) => void;
  /**
   * 처음 보이는 탭. 주지 않으면 마지막으로 본 탭(입력창 창의 규칙)이다. 반응 고르개는 「이모지」부터 연다(#5504, 예전 반응 고르개처럼).
   */
  initialTab?: ExpressionTab;
  /** 탭을 옮길 때 이번 실행의 「마지막으로 본 탭」을 바꾸는가. 반응 고르개는 입력창 창이 기억한 탭을 건드리지 않으려고 끈다. */
  rememberTab?: boolean;
  /** 이모지 탭의 표준 목록이 피부색 줄을 접는가. 키보드 자리의 낮은 창은 접고(기본), 시트는 펼친다. */
  compact?: boolean;
  /** 바텀 시트(`PageSheet`) 안에 서는가: 격자 목록이 시트의 끌어내리기와 스크롤을 주고받는다(시트 밖에서는 평소 그대로다). */
  inSheet?: boolean;
  /** 호스트가 쥔 검색어(시트의 검색 칸). 입력창 창은 검색 칸이 없어 늘 빈 글자다. 세 탭이 모두 이 글자로 거른다. */
  query?: string;
  onClearQuery?: () => void;
}) {
  const formatMessage = useExpressionMessages();
  const styles = useStyles(buildStyles);
  const [tab, setTabState] = useState<ExpressionTab>(initialTab ?? lastTab);
  const [adding, setAdding] = useState(false);
  // 창이 서는 순간(이 부품이 마운트되는 때, 닫으면 걷힌다)의 사용 기록과 시각을 한 번 쥔다(#5503): 이모티콘 탭 맨 위 「자주·최근」 칸의 차례가 열려 있는 동안 - 칸을 눌러 보내고
  // 보내기가 성공해 기록이 바뀌어도, 탭을 바꿨다 돌아와도 - 바뀌지 않는다. 창을 다시 열 때만 새로 계산한다.
  const store = useExpressionStore();
  const [opening] = useState<PanelOpening>(() => ({
    usage: store?.snapshot().usage ?? emptyExpressionUsage(store?.workspaceId ?? '', store?.memberId ?? ''),
    nowMs: Date.now(),
  }));
  const setTab = useCallback(
    (next: ExpressionTab) => {
      if (rememberTab) lastTab = next;
      setTabState(next);
    },
    [rememberTab],
  );

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
          <TeamEmojiRow tab={tab} query={query} onSelect={token => onInsertToken(token)} />
          <EmojiPicker embedded={{query, onClearQuery, compact}} onClose={noop} onSelect={onInsertText} />
        </View>
      ) : (
        <View style={styles.body}>
          {/* 탭마다 새로 선다 - 구역 위치·스크롤이 옆 탭으로 새지 않는다. */}
          {inSheet ? (
            <KeyboardInset>
              <ExpressionPanelGrid key={tab} tab={tab} opening={opening} previewId={previewId} onPick={onPickBig} onAdd={() => setAdding(true)} query={query} inSheet />
            </KeyboardInset>
          ) : (
            <ExpressionPanelGrid key={tab} tab={tab} opening={opening} previewId={previewId} onPick={onPickBig} onAdd={() => setAdding(true)} query={query} />
          )}
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
