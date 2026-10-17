import {PRESENCE_WRITE_FAILED} from '@momo/core/features/presence/model';
import {
  pauseBanner,
  pauseBannerElapsed,
  type PauseBannerKind,
} from '@momo/core/features/presence/pauseBanner';
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
  radius,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {useNow} from '../../lib/useNow';
import {useDirectory, workspaceKeys} from '../workspace/queries';
import {
  notificationRulesKey,
  usePauseNotifications,
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
// 쓴다.
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
// 기대는 기한이 지난 동안은 분 틱마다 규칙과 명부를 다시 읽는다. 줄은 서버의 새 답이 올 때 사라진다.
// 서버가 아직 켜져 있다고 답하면(두 시계의 차이) 줄은 그대로 남고 다음 틱에 다시 묻는다.
// =============================================================================

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
  const elapsed = pauseBannerElapsed(banner, now);

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

  // 줄이 기대는 기한이 지났다 — 서버가 뭐라고 하는지 묻는다. 서버가 아직 켜져 있다고 답하면 줄은
  // 남고, 분 틱(`now`)이 돌 때마다 다시 묻는다. 서버 답이 줄을 지운다.
  useEffect(() => {
    if (elapsed) refresh();
  }, [elapsed, now, refresh]);

  // 실패 문장은 **누른 줄에만** 붙는다. 줄이 사라졌다 다시 서면 옛 실패가 새 줄에 남지 않는다.
  const [attempted, setAttempted] = useState<PauseBannerKind | null>(null);
  const kind = banner?.kind ?? null;
  useEffect(() => {
    if (attempted !== null && kind !== attempted) setAttempted(null);
  }, [attempted, kind]);

  if (banner === null) return null;

  const busy = banner.kind === 'paused' ? pause.pending : setPresence.isPending;
  const failed =
    attempted === banner.kind &&
    (banner.kind === 'paused' ? pause.failed : setPresence.isError);
  const failure = failed
    ? banner.kind === 'paused'
      ? NOTIFICATION_PAUSE_SAVE_FAILED
      : PRESENCE_WRITE_FAILED
    : null;

  const press = () => {
    if (busy) return;
    setAttempted(banner.kind);
    if (banner.kind === 'paused') pause.resume();
    else setPresence.mutate({status: 'auto'});
  };

  return (
    <View accessible={false} style={styles.banner} testID="pause-banner">
      <View style={styles.row}>
        {/* 단추 이름이 문장 전체(`banner.label`)인 것은 새 버전 배너와 같다: 컨트롤 목록에서 「다시
            켜기」 하나만 읽히면 무엇을 다시 켜는지 모른다. */}
        <Sentence
          style={styles.text}
          numberOfLines={3}
          maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
          testID="pause-banner-text">
          <Text
            style={styles.title}
            maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
            {banner.title}
          </Text>
          {banner.detail === undefined ? null : (
            <Text
              style={styles.detail}
              maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
              {` · ${banner.detail}`}
            </Text>
          )}
        </Sentence>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={banner.label}
          accessibilityState={{busy, disabled: busy}}
          disabled={busy}
          onPress={press}
          style={({pressed}) => [styles.action, pressed && styles.pressed]}
          testID="pause-banner-action">
          <Text
            style={styles.actionLabel}
            maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
            {banner.action}
          </Text>
        </Pressable>
      </View>
      {failure === null ? null : (
        <Sentence
          accessibilityLiveRegion="polite"
          style={styles.failure}
          testID="pause-banner-failure">
          {failure}
        </Sentence>
      )}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    banner: {
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
    text: {flex: 1},
    title: {fontSize: font.label, fontWeight: '600', color: color.text},
    detail: {fontSize: font.label, color: color.textMuted},
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
    failure: {fontSize: font.meta, color: color.dangerText, lineHeight: 18},
  });
