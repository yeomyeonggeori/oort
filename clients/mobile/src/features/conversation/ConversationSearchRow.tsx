import React, {useRef} from 'react';
import {Image, Pressable, StyleSheet, TextInput, View} from 'react-native';
import {GlassSurface} from '../../design/glass';
import {CONV_ICONS, CONV_ICON_SIZE, SHELL_ICONS, SHELL_ICON_SIZE} from '../../design/icons';
import {useKeyboardAppearance, usePalette, useStyles} from '../../design/theme';
import {ds2Radius, font, slopTo, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {CONV} from './convDesign';

// =============================================================================
// 대화 머리가 검색 줄로 바뀐 모습 (#5364, 시안 A2·A3·A4). 머리 줄(`CONV.headHeight`)의 **자리에 선다** — 뒤로·이름 알약·⋮ 대신 왼쪽
// 닫기 원과 입력 알약 하나다. 안전 영역·연결 띠·요약 줄은 머리(`ConversationHeader`)가 그대로 지고, 이 줄은 `searchRow` 로 그 안에 들어간다.
//
// 닫기 원은 머리의 원(뒤로·⋮)과 같은 유리·같은 크기라 **뒤로가 있던 자리에 닫기가 선다**. 입력 알약은 값을 받는 그릇이라 한 단 굵은 선
// (`textFaint` = 웹 `--line-strong`)을 두르고, 칩·단추는 테두리 없는 채움이다(오르트 구름 §2.2).
//
// 입력값은 **동기**다(`useConversationSearch` 머리말) — 한글 조합이 끊기지 않게 키 입력마다 그 자리에서 바뀐다. 포커스가 다시 들어오면(결과로 이동한
// 뒤 입력을 다시 누름) 부르는 쪽이 결과 목록 보기로 돌아간다(`onFocus`).
// =============================================================================

/** 입력칸 지우기 단추의 지름. 눈에 보이는 원이고 엄지 44 는 `slopTo` 가 채운다. */
const CLEAR_SIZE = space.xl;
const CLEAR_SLOP = slopTo(CLEAR_SIZE);
const CIRCLE_SLOP = (TOUCH_TARGET - CONV.circle) / 2;

export function ConversationSearchRow({
  query,
  onChangeQuery,
  onSubmit,
  onFocus,
  onClose,
  isDm,
}: {
  query: string;
  onChangeQuery: (next: string) => void;
  onSubmit: () => void;
  onFocus: () => void;
  onClose: () => void;
  /** 범위를 말하는 안내문이 갈린다 — 채널은 「이 채널에서 찾기」, DM 은 「이 대화에서 찾기」. 입력칸의 낭독 이름이기도 하다. */
  isDm: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const keyboardAppearance = useKeyboardAppearance();
  const formatMessage = useFormatMessage();
  const placeholder = formatMessage(isDm ? 'mobile.convSearch.placeholderDm' : 'mobile.convSearch.placeholderChannel');
  const inputRef = useRef<TextInput | null>(null);
  return (
    <View style={styles.row} testID="conversation-search-row">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={formatMessage('mobile.convSearch.close')}
        onPress={onClose}
        hitSlop={CIRCLE_SLOP}
        style={({pressed}) => [styles.circle, pressed && styles.circlePressed]}
        testID="conversation-search-close">
        <GlassSurface radius={CONV.circle / 2} style={StyleSheet.absoluteFill} testID="conversation-search-close-glass" />
        <Image
          source={SHELL_ICONS.x}
          style={[styles.xIcon, {tintColor: palette.text}]}
        />
      </Pressable>
      <View style={styles.field} testID="conversation-search-field">
        <Image
          accessibilityElementsHidden
          source={CONV_ICONS.search}
          style={[styles.searchIcon, {tintColor: palette.textMuted}]}
        />
        <TextInput
          ref={inputRef}
          style={styles.input}
          // 동기. `useConversationSearch` 머리말 — 늦는 것은 요청뿐이다.
          value={query}
          onChangeText={onChangeQuery}
          onSubmitEditing={onSubmit}
          onFocus={onFocus}
          placeholder={placeholder}
          placeholderTextColor={palette.textFaint}
          keyboardAppearance={keyboardAppearance}
          accessibilityLabel={placeholder}
          autoFocus
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          testID="conversation-search-input"
        />
        {query !== '' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={formatMessage('mobile.convSearch.clearInput')}
            onPress={() => {
              onChangeQuery('');
              // 지운 사람은 곧 다시 친다 — 결과로 이동한 뒤(자판이 접힌 상태)에 눌러도 입력칸이 포커스를 되찾는다.
              inputRef.current?.focus();
            }}
            hitSlop={CLEAR_SLOP}
            style={styles.clear}
            testID="conversation-search-clear">
            <Image
              source={CONV_ICONS.cross}
              style={[styles.clearIcon, {tintColor: palette.bg}]}
            />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // 머리 줄과 같은 높이·여백·간격이라 줄이 바뀌어도 머리 전체의 높이가 움직이지 않는다(`ConversationHeader` 의 `row`).
    row: {
      minHeight: CONV.headHeight,
      flexDirection: 'row',
      alignItems: 'center',
      gap: CONV.headGap,
      paddingHorizontal: CONV.headPadX,
    },
    circle: {
      width: CONV.circle,
      height: CONV.circle,
      borderRadius: CONV.circle / 2,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
      boxShadow: color.elevationRest,
    },
    circlePressed: {borderColor: color.textFaint},
    xIcon: {width: SHELL_ICON_SIZE.x, height: SHELL_ICON_SIZE.x},
    field: {
      flex: 1,
      minWidth: 0,
      minHeight: CONV.circle,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingHorizontal: space.md,
      borderRadius: ds2Radius.pill,
      borderWidth: 1,
      borderColor: color.textFaint,
      backgroundColor: color.surface,
    },
    searchIcon: {width: CONV_ICON_SIZE.search, height: CONV_ICON_SIZE.search},
    input: {
      flex: 1,
      minWidth: 0,
      // 위아래 여백은 알약이 진다 — 입력칸 자신은 글 한 줄 높이만 갖는다.
      paddingVertical: 0,
      fontSize: font.body,
      color: color.text,
    },
    clear: {
      width: CLEAR_SIZE,
      height: CLEAR_SIZE,
      borderRadius: CLEAR_SIZE / 2,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.textFaint,
    },
    clearIcon: {width: CONV_ICON_SIZE.cross, height: CONV_ICON_SIZE.cross},
  });
