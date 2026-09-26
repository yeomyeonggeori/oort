// =============================================================================
// M3 알림 미리 안내 (#2820, ADR-0193 D8, ADR-0185 증보 §6).
//
// 한 번뿐인 iOS 알림 창 앞에 한 화면을 둔다. 버튼은 [계속] 하나다(Apple HIG
// Privacy: 시스템 창 앞 화면은 버튼 하나, 시스템 창을 거치지 않는 이탈 없음,
// 「허용」처럼 시스템 버튼과 헷갈리는 라벨 금지). 거절은 iOS 창의 「허용 안 함」이
// 받고, 거절돼도 앱은 온전히 쓴다(심사 지침 4.5.4). 거절 뒤 재진입은 프로필 시트의
// 알림 줄(「설정에서 알림 켜기」)이다.
//
// 이미 정해진 권한(허용·거부·provisional)이면 서지 않는다: `PushProvider`의
// `gate`가 `ask`일 때만 선다(`shouldAskNotifications`).
//
// 셸 위에 덮는다. 셸은 밑에서 이미 마운트되어 채널을 받아 두고, [계속] 뒤 창이
// 닫히면 곧장 보인다. VoiceOver는 `accessibilityViewIsModal`로 이 화면에 갇힌다.
// =============================================================================

import React, {useCallback, useState} from 'react';
import {Image, StyleSheet, Text, View} from 'react-native';

import {useStyles} from '../../design/theme';
import type {Palette} from '../../design/tokens';
import {usePushPrompt} from '../../push/PushProvider';
import {KomettoGuide, OnboardingCanvas} from './KomettoGuide';
import {
  OnboardingButton,
  OnboardingPhoneScreen,
  OnboardingTopBar,
  PHONE_OB,
} from './OnboardingControls';
import {
  lastConnectRoute,
  NOTIFY_CONTINUE_LABEL,
  NOTIFY_DETAIL,
  NOTIFY_LINE,
  NOTIFY_SAMPLE_BODY,
  NOTIFY_SAMPLE_TIME,
  NOTIFY_SAMPLE_TITLE,
  phoneOnboardingDots,
} from './phoneFlow';

const APP_ICON = require('../../design/brand/app-icon-notify.png');

/** 시안 `.notif` 값. */
const NOTIF = {
  /** `.notif{border-radius:18px;padding:12px 14px;gap:10px}` */
  radius: 18,
  padV: 12,
  padH: 14,
  iconGap: 10,
  /** `.notif img{width:38px;height:38px;border-radius:9px}` */
  icon: 38,
  iconRadius: 9,
  /** `.notif .t{font-size:13.5px;line-height:1.4}` · `b span{font-size:12px}` */
  font: 13.5,
  time: 12,
} as const;

export function NotificationPrimer({
  onContinue,
  busy,
}: {
  onContinue: () => void;
  busy: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const dots = phoneOnboardingDots(lastConnectRoute(), 'notify');
  return (
    <OnboardingPhoneScreen
      testID="notify-primer"
      top={<OnboardingTopBar dots={dots} />}
      mainStyle={styles.main}
      bottom={
        <OnboardingButton
          label={NOTIFY_CONTINUE_LABEL}
          busy={busy}
          onPress={onContinue}
          accessibilityHint="iOS 알림 허용 창이 뜹니다."
          testID="notify-primer-continue"
        />
      }
    >
      <KomettoGuide expression="happy" line={NOTIFY_LINE} header />
      {/* 알림 예시. 장식이다: 읽으면 진짜 알림이 온 줄 안다. */}
      <View
        style={styles.notif}
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        testID="notify-primer-sample"
      >
        <Image source={APP_ICON} style={styles.notifIcon} />
        <View style={styles.notifText}>
          <View style={styles.notifHead}>
            <Text style={styles.notifTitle}>{NOTIFY_SAMPLE_TITLE}</Text>
            <Text style={styles.notifTime}>{NOTIFY_SAMPLE_TIME}</Text>
          </View>
          <Text style={styles.notifBody} lineBreakStrategyIOS="hangul-word">{NOTIFY_SAMPLE_BODY}</Text>
        </View>
      </View>
      <Text
        style={styles.hint}
        lineBreakStrategyIOS="hangul-word"
        testID="notify-primer-detail">
        {NOTIFY_DETAIL}
      </Text>
    </OnboardingPhoneScreen>
  );
}

/**
 * 셸 위에 M3을 덮을지 정한다. `ask`면 M3, 방금 연결했는데 아직 권한을 읽는 중이면
 * 빈 바닥(셸이 한 틈 보였다가 M3로 바뀌는 깜박임을 막는다), 그 밖에는 아무것도 없다.
 */
export function NotificationPrimerGate(): React.JSX.Element | null {
  const {gate, ask} = usePushPrompt();
  const [asking, setAsking] = useState(false);
  const onContinue = useCallback(() => {
    setAsking(true);
    void ask().finally(() => setAsking(false));
  }, [ask]);

  if (gate === 'ask') {
    return (
      <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
        <NotificationPrimer onContinue={onContinue} busy={asking} />
      </View>
    );
  }
  if (gate === 'checking' && lastConnectRoute() !== null) {
    return (
      <View
        style={StyleSheet.absoluteFill}
        accessibilityViewIsModal
        testID="notify-primer-checking"
      >
        <OnboardingCanvas />
      </View>
    );
  }
  return null;
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    main: {gap: PHONE_OB.mainGapWide},
    notif: {
      flexDirection: 'row',
      gap: NOTIF.iconGap,
      paddingVertical: NOTIF.padV,
      paddingHorizontal: NOTIF.padH,
      borderRadius: NOTIF.radius,
      borderWidth: 1,
      borderColor: color.glassLine,
      backgroundColor: color.glass,
      boxShadow: color.elevationFloat,
    },
    notifIcon: {
      width: NOTIF.icon,
      height: NOTIF.icon,
      borderRadius: NOTIF.iconRadius,
    },
    notifText: {flex: 1},
    notifHead: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'baseline',
    },
    notifTitle: {color: color.text, fontSize: NOTIF.font, fontWeight: '600'},
    notifTime: {color: color.textMuted, fontSize: NOTIF.time},
    notifBody: {color: color.text, fontSize: NOTIF.font},
    hint: {
      color: color.textMuted,
      fontSize: PHONE_OB.hintFont,
      textAlign: 'center',
    },
  });
