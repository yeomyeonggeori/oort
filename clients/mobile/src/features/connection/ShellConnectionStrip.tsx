import {CONNECTION_KEYS} from '@momo/core/features/connection/copyKeys';
import {CONNECTION_MARK} from '@momo/core/features/connection/presentation';
import {
  nextShellStood,
  presentShellStrip,
} from '@momo/core/features/connection/shellStrip';
import React, {useEffect, useState} from 'react';
import {Image, Pressable, StyleSheet, View} from 'react-native';
import {Sentence} from '../../design/atoms';
import {OortLoader} from '../../design/brand/OortLoader';
import {CONV_ICON_SIZE, CONV_ICONS} from '../../design/icons';
import {usePalette, useStyles} from '../../design/theme';
import {
  ds2Radius,
  font,
  radius,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {useRealtime} from '../../realtime/RealtimeProvider';
import {useConnection} from './ConnectionProvider';

// =============================================================================
// 셸 띠 — 홈·받은함·에이전트 목록 위에 서는 연결 띠 (#5222, #5201 S-D, owner 결정 ②).
//
// 폰의 연결 띠는 대화 화면 머리 밑에만 있었다. 홈에는 오프라인 표시가 아예 없었고, 받은함은 자기 한 줄을 따로 가져 화면마다
// 말이 달랐다(감사 문서 §2.2). 이제 **기기 오프라인과 서버에 닿지 못함**일 때는 세 화면 위에도 같은 문장·같은 단추의 띠가 선다.
// 실시간(소켓)만 끊긴 것은 여기서 말하지 않는다 — 그건 대화·에이전트 진행을 보는 화면에서만 뜻이 있다(대화 화면 띠가 말한다).
//
// 무엇을 말하나는 코어가 정한다(`presentShellStrip`: 셸이 말하는 원인인가, 방금 돌아왔는가). 이 부품은 그리기만 한다.
//   · 서 있는 동안: 오르트 로더(다시 붙는 중) 또는 멈춘 마크(기기 오프라인) + 원인 문장 + 설명 한 줄, 서버에 닿지 못함에는
//     「지금 다시 연결」(띠 전체가 단추, 캡슐은 그림 — 대화 화면 띠와 같은 문법).
//   · 돌아온 뒤 2초: 확인 표시 + 「다시 연결됐어요」. **띠가 섰던 경우에만**(홈이 끊김을 말한 적이 없으면 돌아왔다고도 말하지 않는다).
//
// 그릇은 같은 화면의 안내 상자(`NoticeBlock`)와 같다(여백·테두리·면). 연결 상태 모델이 없는 자리(격리 하네스·시험)에서는 아무것도
// 그리지 않는다.
// =============================================================================

export function ShellConnectionStrip(): React.JSX.Element | null {
  const connection = useConnection();
  const {reconnect} = useRealtime();
  const formatMessage = useFormatMessage();
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  // 「섰었다」는 기억: 기기가 돌아와도 소켓이 다시 붙기까지 띠가 잠시 비는 동안 이어진다(`nextShellStood`).
  const [stood, setStood] = useState(false);
  const view = connection?.view ?? null;
  const recovered = connection?.recovered ?? false;
  useEffect(() => {
    if (view === null) return;
    const next = nextShellStood(view, recovered, stood);
    if (next !== stood) setStood(next);
  }, [view, recovered, stood]);

  const strip =
    view === null ? null : presentShellStrip(view, recovered, stood);
  if (strip === null) return null;

  const title = formatMessage(strip.title);
  const detail = strip.detail === null ? null : formatMessage(strip.detail);
  const spoken = detail === null ? title : `${title}. ${detail}`;
  const actionLabel = formatMessage(CONNECTION_KEYS.reconnectNow);
  const body = (
    <>
      {strip.mark === CONNECTION_MARK.check ? (
        <View style={styles.mark} testID="shell-connection-strip-check">
          <Image
            accessibilityElementsHidden
            source={CONV_ICONS.check}
            style={[styles.check, {tintColor: palette.accentText}]}
          />
        </View>
      ) : (
        <View style={styles.mark}>
          <OortLoader
            size={LOADER_SIZE}
            still={strip.mark === CONNECTION_MARK.still}
            testID="shell-connection-strip-loader"
          />
        </View>
      )}
      <View style={styles.text}>
        <Sentence style={styles.title}>{title}</Sentence>
        {detail === null ? null : (
          <Sentence style={styles.detail}>{detail}</Sentence>
        )}
      </View>
    </>
  );

  if (strip.canReconnect && reconnect !== undefined) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={actionLabel}
        // 이름은 행동이고, 지금 상태(제목과 설명)는 값으로 따라 읽힌다 — 대화 화면 띠와 같다.
        accessibilityValue={{text: spoken}}
        accessibilityLiveRegion="polite"
        onPress={() => void reconnect().catch(() => undefined)}
        style={({pressed}) => [styles.strip, pressed && styles.pressed]}
        testID="shell-connection-strip">
        {body}
        <View style={styles.action} testID="shell-connection-strip-action">
          <Sentence style={styles.actionText}>{actionLabel}</Sentence>
        </View>
      </Pressable>
    );
  }
  return (
    <View
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      accessibilityLabel={spoken}
      style={styles.strip}
      testID="shell-connection-strip">
      {body}
    </View>
  );
}

/** 문장 한 줄 옆 로더 한 변: 대화 화면 띠(20)와 같다. */
const LOADER_SIZE = 20;

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // 그릇은 안내 상자(`NoticeBlock`)와 같은 문법이다. 단추일 때는 엄지 높이(44)를 상자가 진다.
    strip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      minHeight: TOUCH_TARGET,
      marginHorizontal: SAFE_GUTTER,
      marginVertical: space.md,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.surface,
    },
    pressed: {borderColor: color.textFaint},
    mark: {
      width: LOADER_SIZE,
      height: LOADER_SIZE,
      alignItems: 'center',
      justifyContent: 'center',
    },
    check: {width: CONV_ICON_SIZE.check, height: CONV_ICON_SIZE.check},
    text: {flex: 1, gap: space.xs},
    title: {fontSize: font.label, color: color.text, fontWeight: '600'},
    detail: {fontSize: font.meta, color: color.textMuted, lineHeight: 18},
    // 행동의 이름 캡슐 — 대화 화면 띠와 같은 그림이다(신호색 연한 면 + 신호 글자). 누르는 것은 띠 전체다.
    action: {
      flexShrink: 1,
      paddingHorizontal: space.md,
      paddingVertical: space.xs,
      borderRadius: ds2Radius.pill,
      backgroundColor: color.accentSurface,
    },
    actionText: {fontSize: font.meta, color: color.accentText, fontWeight: '600'},
  });
