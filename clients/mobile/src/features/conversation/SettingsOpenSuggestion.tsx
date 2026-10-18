import React from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';
import {isSurfaceProvided} from '@momo/core/features/capabilities/serverSurfaces';
import {
  COMMAND_SUGGEST_SETTINGS_PHONE,
  commandSuggestHead,
  commandSuggestOneLine,
  commandSuggestViewer,
  settingsOpenTarget,
  type CommandSuggestCard,
} from '@momo/core/features/timeline/commandSuggest';
import {font, line, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {Sentence} from '../../design/atoms';
import {usePalette, useStyles} from '../../design/theme';
import {AI_CONNECT_ICON_SIZE, AI_CONNECT_ICONS} from '../../design/icons';
import {CONV} from './convDesign';
import {AI_SUGGEST} from './AiConnectSuggestion';

// =============================================================================
// 에이전트가 제안한 「설정 열기」 카드 — 폰 (U-S6 #3940, ADR-0201 v2 H6-4, 서버 #3939).
//
// 웹 `chat/SettingsOpenCard.tsx`의 폰 짝이다. 폰에는 웹 설정 목차의 이 섹션들이 없다(설정은
// 맥·웹의 화면이다). 그래서 대상 본인에게도 **누를 것이 없다**: 머리 「{에이전트}가
// 제안했어요」 + 어느 화면인지 + 「이 설정은 맥·웹에서 열어요.」 한 줄. 열 수 없는 버튼을
// 세우는 것보다 있는 사실을 말한다(`AiConnectSuggestion`의 폰 규율과 같다, Q5).
//
// 문구는 메시지의 라벨이 아니라 `section`에서 코어 표로 다시 만든다. 이 서버가 표면을 싣지
// 않으면(`settingsOpenCard`) 카드는 서지 않고 에이전트의 본문 글만 남는다. 깨진 제안과 남이
// 보는 카드는 한 줄이다. 모양은 `AiConnectSuggestion`의 머리·한 줄을 그대로 쓴다(따로 서는
// 카드 모양을 만들지 않는다) — 치수 출처는 같은 시안 폰 ③.
// =============================================================================

export function SettingsOpenSuggestion({
  card,
  viewerMemberId,
}: {
  card: CommandSuggestCard;
  viewerMemberId: string | undefined;
}): React.JSX.Element | null {
  const styles = useStyles(build);
  const palette = usePalette();
  if (!isSurfaceProvided('settingsOpenCard')) return null;
  const section = card.section;
  // 모르는 section(깨진 제안)은 카드를 세우지 않는다: 행의 본문 글이 안내를 한다.
  if (section === null) return null;
  const viewer = commandSuggestViewer(card, viewerMemberId, false);
  if (viewer !== 'target') {
    return (
      <View style={styles.wrap} testID="settings-suggest-other">
        <View style={styles.oneline} testID="settings-suggest-line">
          <Text style={styles.onelineText} lineBreakStrategyIOS="hangul-word">
            {commandSuggestOneLine(card)}
          </Text>
        </View>
      </View>
    );
  }
  const initial = [...card.agentName.trim()][0]?.toUpperCase() ?? '';
  return (
    <View style={[styles.wrap, styles.card]} testID="settings-suggest-target">
      <View style={styles.head}>
        <View style={styles.agentMark}>
          <Text style={styles.agentMarkText}>{initial}</Text>
        </View>
        <Text
          style={styles.headText}
          numberOfLines={2}
          lineBreakStrategyIOS="hangul-word"
          accessibilityRole="header">
          {commandSuggestHead(card)}
        </Text>
      </View>
      <View style={styles.section}>
        <Text
          style={styles.label}
          lineBreakStrategyIOS="hangul-word"
          testID="settings-suggest-label">
          {settingsOpenTarget(section)}
        </Text>
        <View style={styles.note}>
          <Image
            source={AI_CONNECT_ICONS.laptop}
            style={[styles.icon, styles.noteIcon, {tintColor: palette.icon}]}
            accessibilityIgnoresInvertColors
          />
          <Sentence style={styles.noteText}>{COMMAND_SUGGEST_SETTINGS_PHONE}</Sentence>
        </View>
      </View>
    </View>
  );
}

function build(color: Palette) {
  return StyleSheet.create({
    wrap: {marginTop: space.sm},
    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
      borderRadius: CONV.cardRadius,
      backgroundColor: color.surface,
      overflow: 'hidden',
      boxShadow: color.elevationRest,
    },
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingVertical: AI_SUGGEST.headPadY,
      paddingHorizontal: CONV.cardPad,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: color.border,
    },
    agentMark: {
      width: AI_SUGGEST.agentMark,
      height: AI_SUGGEST.agentMark,
      borderRadius: AI_SUGGEST.agentMarkRadius,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.agentSurface,
    },
    agentMarkText: {fontSize: font.caption, fontWeight: '700', color: color.agent},
    headText: {flexShrink: 1, fontSize: font.meta, fontWeight: '600', color: color.agent},
    section: {paddingHorizontal: CONV.cardPad, paddingVertical: space.sm},
    label: {fontSize: font.body, fontWeight: '600', color: color.text},
    note: {flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingTop: space.sm},
    noteIcon: {marginTop: AI_SUGGEST.noteIconNudge},
    noteText: {flexShrink: 1, fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    icon: {width: AI_CONNECT_ICON_SIZE, height: AI_CONNECT_ICON_SIZE},
    oneline: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingVertical: AI_SUGGEST.onelinePadY,
      paddingHorizontal: AI_SUGGEST.onelinePadX,
      borderRadius: AI_SUGGEST.onelineRadius,
      backgroundColor: color.sheet,
      minHeight: TOUCH_TARGET - space.md,
    },
    onelineText: {flex: 1, fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
  });
}
