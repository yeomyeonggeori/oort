import {PRESENCE_WRITE_FAILED} from '@momo/core/features/presence/model';
import {
  pauseBanner,
  type PauseBannerKind,
} from '@momo/core/features/presence/pauseBanner';
import {PAUSE_UNTIL_OFFLINE_REASON} from '@momo/core/features/presence/pauseUntil';
import {NOTIFICATION_PAUSE_SAVE_FAILED} from '@momo/core/features/settings/notificationRules';
import {memberFor} from '@momo/core/features/workspace/directory';
import {useQueryClient} from '@tanstack/react-query';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {AppState, Pressable, StyleSheet, Text, View} from 'react-native';

import {BAR_CONTROL_MAX_SCALE, Sentence} from '../../design/atoms';
import {useStyles} from '../../design/theme';
import {
  ds2Radius,
  font,
  line,
  radius,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {useNow} from '../../lib/useNow';
import {useOnline} from '../inbox/useOnline';
import {useDirectory, workspaceKeys} from '../workspace/queries';
import {
  notificationRulesKey,
  usePauseNotifications,
  useRecheckWhenElapsed,
  useSetPresence,
} from './selfStatus';

// =============================================================================
// 멈춤이 보인다 — 인박스 맨 위의 한 줄 (ADR-0204 D3, #3923).
//
// 성재 계정은 방해 금지를 고른 뒤 15일 동안 기한 없는 알림 일시 중지 상태였는데, 그 사실은
// 프로필 시트 안에만 있어서 어디에도 보이지 않았다. 알림이 오지 않는 이유를 가장 먼저 찾는 자리가
// 인박스라서 그 맨 위에 한 줄을 둔다:
//
//   * 알림 일시 중지 중 — 「알림 일시 중지 중 · 오후 9:30까지」 + 「다시 켜기」
//   * 일시 중지는 꺼졌는데 상태가 아직 방해 금지 — 「상태는 아직 방해 금지예요」 + 「풀기」
//   * 아니면 줄이 없다(자리도 없다).
//
// 어느 줄이 서는지와 문장은 코어(`presence/pauseBanner.ts`)가 정한다. 웹 사이드바가 같은 것을
// 쓴다. 제목과 기한은 두 줄로 쌓는다(웹 사이드바 폭에서는 한 줄에 못 들어 의도한 두 줄로 쌓았고, 같은
// 줄이 두 표면에서 같은 모양이도록 폰도 같게 한다). 문장 전체는 단추의 접근 이름이 갖는다.
//
// ## 쓰기는 새 길이 없다
//
// 「다시 켜기」는 프로필 시트의 스위치와 같은 훅(`usePauseNotifications`)의 `resume()` 이라
// `PATCH notification-rules {dnd:false}` 하나만 나간다 — 방해 금지 상태는 그대로 두고, 그러면
// 아래 둘째 줄이 서는 것이 정상이다(ADR-0204 D2). 「풀기」는 `useSetPresence` 의 `auto` 쓰기이고,
// 그 뒤 규칙 재조회는 그 훅이 이미 한다.
//
// ## 기한이 지나도 이 줄이 스스로 내려가지 않는다
//
// 서버가 만료를 판정한다(푸시 판정 시점 비교). 폰이 타이머로 풀면 서버와 어긋난 채로 「멈춰 있지
// 않다」고 말한다. 대신 **다시 묻는다**: 인박스 탭이 보이게 되거나 앱이 앞으로 돌아오면, 그리고 줄이
// 기대는 기한이 지나면(`useRecheckWhenElapsed` — 프로필 시트와 같은 훅) 규칙과 명부를 다시 읽는다.
// 줄은 서버의 새 답이 올 때 사라진다. 서버가 아직 켜져 있다고 답하면(두 시계의 차이) 줄은 그대로
// 남고 분 틱마다 다시 묻는다.
//
// ## 실패 이유는 낙관 칠하기와 독립으로 붙는다 (design-review H1)
//
// 「다시 켜기」「풀기」를 누르면 낙관 칠하기가 서버 답보다 먼저 줄을 바꾼다(줄이 사라지거나 방해 금지
// 줄로 바뀐다). 서버가 실패하면 되돌려 줄이 다시 서는데, 이때 「누른 줄」 표식이 줄 모양이 바뀐 순간에 이미
// 지워져 있으면 이유 문장이 한 번도 뜨지 않는다(줄이 사라졌다가 이유 없이 되돌아온다 — 이 이슈가 막으려던
// 것과 같은 모양이다). 그래서 실패는 **쓰기의 `onError`** 가 알리고, 어느 줄(종류·기한)에 대한 실패인지와
// 함께 들고 있다. 다른 줄이 서 있을 때는 붙지 않는다 — 줄이 사라졌다 다시 서도 기한이 다르면 옛 실패가
// 새 줄에 남지 않는다.
//
// ## 같은 자리에서 반대 행동이 올라오지 않게 (design-review M1)
//
// 「다시 켜기」를 누르면 같은 자리의 단추가 낙관 칠하기로 곧바로 「풀기」가 된다. 더블탭의 둘째 누름이
// 원치 않은 방해 금지 해제를 보내지 않도록, 쓰기가 **어느 것이든** 날고 있는 동안은 누르지 않고, 방금 누른
// 줄과 다른 종류의 단추는 잠깐(`FLIP_WINDOW_MS`) 받지 않는다. 같은 줄의 다시 시도는 막지 않는다.
//
// ## 끊겨 있으면 단추 자리에 이유를 말한다
//
// 끊긴 채 누른 뮤테이션은 낙관값만 칠하고 멈췄다가 재연결 뒤에 나간다 — 줄은 사라졌는데 서버는 아직
// 모른다. 그래서 끊긴 동안은 단추를 거두고 그 자리에 이유를 말한다(승인 컨트롤이 오프라인에서 하는 것과
// 같다: 버튼을 남겨 두지도, 말없이 치우지도 않는다).
// =============================================================================

/** 방금 누른 줄과 **다른 종류**의 단추를 받지 않는 시간. 같은 줄의 다시 시도는 막지 않는다. */
const FLIP_WINDOW_MS = 1500;

/**
 * 기한 줄이 접힐 때 「9:00 / 까지」처럼 조사만 둘째 줄에 홀로 남지 않게 한다. iOS 는 숫자와 한글 사이를 끊을 수 있는
 * 자리로 보고(`hangul-word` 는 한글 **낱말** 우선일 뿐 숫자-한글 경계를 막지 않는다), 가장 큰 글씨(AX5)에서 날짜가
 * 붙는 기한이 실제로 그렇게 끊겼다(캡처). 단어 결합자(U+2060)는 보이지 않는 글자라 읽히는 문장은 그대로다.
 */
const WORD_JOINER = '\u2060';
const joinSuffix = (text: string): string => text.replace(/([0-9])까지$/, `$1${WORD_JOINER}까지`);

export function PauseBanner({
  workspaceId,
  selfId,
  active,
}: {
  workspaceId: string;
  selfId: string;
  /** 이 탭이 지금 보이는가. 보이게 되는 순간 서버에 다시 묻는다(탭은 언마운트되지 않는다). */
  active: boolean;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const client = useQueryClient();
  const now = useNow();
  const online = useOnline();
  const pause = usePauseNotifications(workspaceId);
  const {directory} = useDirectory(workspaceId);
  const setPresence = useSetPresence(workspaceId, selfId);
  const self = memberFor(directory, selfId);

  const banner = pauseBanner(
    {
      rulesReady: pause.ready,
      paused: pause.paused,
      untilMs: pause.untilMs,
      declared: self?.presenceStatus,
      declaredUntilMs: self?.dndUntilMs,
    },
    now,
  );

  // 줄이 기대는 기한이 지나면 서버에 다시 묻는다(스스로 내려가지 않는다).
  useRecheckWhenElapsed(workspaceId, banner?.untilMs);

  // 서버에 다시 묻는다. 규칙과 명부 둘 다다 — 일시 중지 줄은 규칙, 방해 금지 줄은 명부에 기댄다.
  const refresh = useCallback(() => {
    void client.invalidateQueries({queryKey: notificationRulesKey(workspaceId)});
    void client.invalidateQueries({queryKey: workspaceKeys.roster(workspaceId)});
  }, [client, workspaceId]);

  // 탭이 보이게 되거나(처음 마운트는 질의가 스스로 읽으니 빼고) 앱이 앞으로 돌아오면 다시 묻는다.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) refresh();
    wasActive.current = active;
  }, [active, refresh]);
  useEffect(() => {
    if (!active) return;
    const subscription = AppState.addEventListener('change', status => {
      if (status === 'active') refresh();
    });
    return () => subscription.remove();
  }, [active, refresh]);

  // 실패는 쓰기의 `onError` 가 알린다 — 낙관 칠하기가 줄 모양을 바꾼 것과 독립이다(위 「실패 이유」).
  // 어느 줄(종류·기한)에 대한 실패인지 함께 들고 있어, 다른 줄이 서 있을 때는 붙지 않는다.
  const [failure, setFailure] = useState<{kind: PauseBannerKind; untilMs?: number} | null>(
    null,
  );
  const lastPress = useRef<{kind: PauseBannerKind; at: number} | null>(null);
  const pending = pause.pending || setPresence.isPending;

  if (banner === null) return null;

  const failed =
    failure !== null && failure.kind === banner.kind && failure.untilMs === banner.untilMs;
  const note = !online
    ? PAUSE_UNTIL_OFFLINE_REASON
    : failed
      ? banner.kind === 'paused'
        ? NOTIFICATION_PAUSE_SAVE_FAILED
        : PRESENCE_WRITE_FAILED
      : null;

  const press = () => {
    if (pending || !online) return;
    const previous = lastPress.current;
    const pressedAt = Date.now();
    // 방금 다른 종류의 줄을 누른 직후에 같은 자리에 올라온 단추는 더블탭의 둘째 누름일 수 있다.
    if (
      previous !== null &&
      previous.kind !== banner.kind &&
      pressedAt - previous.at < FLIP_WINDOW_MS
    ) {
      return;
    }
    lastPress.current = {kind: banner.kind, at: pressedAt};
    setFailure(null);
    const onError = () => setFailure({kind: banner.kind, untilMs: banner.untilMs});
    if (banner.kind === 'paused') pause.resume({onError});
    else setPresence.mutate({status: 'auto'}, {onError});
  };

  return (
    <View accessible={false} style={styles.banner} testID="pause-banner">
      <View style={styles.row}>
        {/* 단추 이름이 문장 전체(`banner.label`)인 것은 새 버전 배너와 같다: 컨트롤 목록에서 「다시
            켜기」 하나만 읽히면 무엇을 다시 켜는지 모른다. */}
        <View style={styles.text}>
          <Sentence
            style={styles.title}
            numberOfLines={2}
            maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
            testID="pause-banner-title">
            {banner.title}
          </Sentence>
          {/* `Sentence`: iOS 기본 줄바꿈은 한글을 글자 단위로 끊어 「9:00까 / 지」처럼 마지막 한 음절이 둘째 줄에
              홀로 남는다(AX5 + 날짜가 붙는 기한에서 실측). 어절 우선 줄바꿈(`hangul-word`)이 한 자리에 있다. */}
          {banner.detail === undefined ? null : (
            <Sentence
              style={styles.detail}
              numberOfLines={2}
              maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
              testID="pause-banner-detail">
              {joinSuffix(banner.detail)}
            </Sentence>
          )}
        </View>
        {online ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={banner.label}
            accessibilityState={{busy: pending, disabled: pending}}
            disabled={pending}
            onPress={press}
            style={({pressed}) => [styles.action, pressed && styles.pressed]}
            testID="pause-banner-action">
            <Text
              style={styles.actionLabel}
              maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
              {banner.action}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {note === null ? null : (
        <Sentence
          accessibilityLiveRegion="polite"
          maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
          style={online ? styles.failure : styles.offline}
          testID={online ? 'pause-banner-failure' : 'pause-banner-offline'}>
          {note}
        </Sentence>
      )}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    banner: {
      // 헤더의 아래 헤어라인에 붙지 않게 위 여백을 준다(아래 여백과 같다 — design-review M2).
      marginTop: space.md,
      marginHorizontal: SAFE_GUTTER,
      marginBottom: space.md,
      paddingVertical: space.sm,
      paddingLeft: SAFE_GUTTER,
      paddingRight: space.sm,
      gap: space.xs,
      borderRadius: ds2Radius.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
      backgroundColor: color.surface,
    },
    row: {flexDirection: 'row', alignItems: 'center', columnGap: space.md},
    text: {flex: 1, gap: space.xs},
    title: {fontSize: font.label, fontWeight: '600', color: color.text},
    detail: {fontSize: font.meta, color: color.textMuted},
    action: {
      minHeight: TOUCH_TARGET,
      justifyContent: 'center',
      paddingHorizontal: SAFE_GUTTER,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: color.accentText,
    },
    actionLabel: {fontSize: font.label, fontWeight: '700', color: color.accentText},
    pressed: {opacity: 0.85},
    failure: {fontSize: font.meta, color: color.dangerText, lineHeight: line.label},
    offline: {fontSize: font.meta, color: color.textMuted, lineHeight: line.label},
  });
