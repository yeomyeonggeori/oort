import React from 'react';
import {Image, Pressable, StyleSheet, Text, View} from 'react-native';
import {
  commandSuggestHead,
  commandSuggestIsTarget,
  commandSuggestOneLine,
  type CommandSuggestCard,
  type WorkRequestHarness,
  type WorkRequestOpen,
} from '@momo/core/features/timeline/commandSuggest';
import {
  font,
  line,
  slopTo,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {Sentence} from '../../design/atoms';
import {usePalette, useStyles} from '../../design/theme';
import {AI_CONNECT_ICON_SIZE, AI_CONNECT_ICONS} from '../../design/icons';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {CONV} from './convDesign';
import {AI_SUGGEST} from './AiConnectSuggestion';

// =============================================================================
// 에이전트가 제안한 「작업 요청 열기」 카드 — 폰 (#4972 S9, ADR-0201 증보 v3 B8 C1).
//
// 웹 `chat/WorkRequestOpenCard.tsx`의 폰 짝이다. 도우미는 코드를 읽지도 돌리지도 않는다. 코드 일을
// 부탁받으면 이 카드로 사람의 「내 맥에 보내기」 시트(작업 요청 모드)를 **글과 도구를 미리 채워** 열어
// 준다. 카드는 서버를 바꾸지 않는다(risk none — 승인 행도 감사 행도 없다). 누르면 그 폰에서 시트가
// 열릴 뿐이고, **보내는 것은 사람이다**(글을 읽고 고치고 ✓를 눌러야 Face ID 서명과 전송이 일어난다).
// 도구(`harness`)가 이 맥에 없거나 정해지지 않았으면 시트의 평소 기본값이 이긴다.
//
// 문구는 에이전트·메시지의 문자열이 아니라 `harness`에서 사전으로 다시 만든다(라벨을 그리지 않는다 —
// 피싱 문구 차단). 글(prompt)은 카드에 그리지 않는다: 그 글은 시트의 입력 칸에서만 읽힌다. 남이 보는
// 카드·깨진 제안(글 없음)·시트를 열 셸이 없는 표면은 누를 단추 없이 한 줄이다(`SettingsOpenSuggestion`과
// 같은 규율: 열리지 않는 단추를 세우지 않는다). 모양은 그 카드의 머리·한 줄을 그대로 쓴다.
// =============================================================================

const LABEL_KEY = {
  claude: 'timeline.workRequest.labelClaude',
  codex: 'timeline.workRequest.labelCodex',
} as const satisfies Record<WorkRequestHarness, string>;

function labelKey(harness: WorkRequestHarness | null) {
  return harness === null ? 'timeline.workRequest.labelAny' : LABEL_KEY[harness];
}

export function WorkRequestSuggestion({
  card,
  viewerMemberId,
  onOpen,
}: {
  card: CommandSuggestCard;
  viewerMemberId: string | undefined;
  /** 시트를 미리 채워 연다. 시트를 열 곳이 없는 표면은 주지 않는다(그때 카드는 한 줄). */
  onOpen: ((prefill: WorkRequestOpen) => void) | undefined;
}): React.JSX.Element {
  const styles = useStyles(build);
  const palette = usePalette();
  const formatMessage = useFormatMessage();
  const workRequest = card.workRequest;
  if (
    workRequest === null ||
    onOpen === undefined ||
    !commandSuggestIsTarget(card, viewerMemberId)
  ) {
    return (
      <View style={styles.wrap} testID="work-request-suggest-other">
        <View style={styles.oneline} testID="work-request-suggest-line">
          <Image
            source={AI_CONNECT_ICONS.laptop}
            style={[styles.icon, {tintColor: palette.icon}]}
            accessibilityIgnoresInvertColors
          />
          <Text style={styles.onelineText} lineBreakStrategyIOS="hangul-word">
            {commandSuggestOneLine(card)}
          </Text>
        </View>
      </View>
    );
  }
  const label = formatMessage(labelKey(workRequest.harness));
  const initial = [...card.agentName.trim()][0]?.toUpperCase() ?? '';
  return (
    <View style={[styles.wrap, styles.card]} testID="work-request-suggest-target">
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
        <View style={styles.labelRow}>
          <Image
            source={AI_CONNECT_ICONS.laptop}
            style={[styles.icon, {tintColor: palette.icon}]}
            accessibilityIgnoresInvertColors
          />
          <Text
            style={styles.label}
            lineBreakStrategyIOS="hangul-word"
            testID="work-request-suggest-label">
            {label}
          </Text>
        </View>
        <Sentence style={styles.hint} testID="work-request-suggest-hint">
          {formatMessage('timeline.workRequest.sheetHint')}
        </Sentence>
      </View>
      <Pressable
        onPress={() => onOpen(workRequest)}
        accessibilityRole="button"
        accessibilityLabel={formatMessage('timeline.workRequest.openSheetLabel', {label})}
        hitSlop={slopTo(TOUCH_TARGET)}
        testID="work-request-suggest-open"
        style={({pressed}) => [styles.action, pressed && styles.pressed]}>
        <Text style={styles.actionText}>
          {formatMessage('timeline.workRequest.openSheet')}
        </Text>
      </Pressable>
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
    labelRow: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
    label: {flexShrink: 1, fontSize: font.body, fontWeight: '600', color: color.text},
    hint: {paddingTop: space.sm, fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    icon: {width: AI_CONNECT_ICON_SIZE, height: AI_CONNECT_ICON_SIZE},
    /** 누르는 줄: 카드 발의 한 줄, 눌리는 면은 44. */
    action: {
      minHeight: TOUCH_TARGET,
      justifyContent: 'center',
      paddingHorizontal: CONV.cardPad,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: color.border,
      backgroundColor: color.sheet,
    },
    actionText: {fontSize: font.meta, fontWeight: '600', color: color.agent},
    pressed: {opacity: 0.6},
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
