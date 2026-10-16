// =============================================================================
// M3 알림 미리 안내 (#2820, ADR-0193 D8 → #3925, ADR-0204 D4 「어떤 알림을 받을까요?」).
//
// 한 번뿐인 iOS 알림 창 앞에 한 화면을 둔다. ADR-0204 D4가 이 화면을 한 가지 질문에서
// 「어떤 알림을 받을까요?」로 넓혔다: 종류 미리 보기 셋(승인 요청 · 작업 끝남 · 나를 부른
// 멘션·답)과, 끌 수 있는 단 하나인 작업 끝남 스위치다. 승인 요청·멘션·DM은 종류별로 끌
// 수 없어 「항상 와요」로 적는다.
//
// **바뀌지 않은 것**(D8, Apple HIG)
//   - 창 앞의 버튼은 [계속] 하나다. 스위치는 버튼이 아니라 `switch` 역할이고, 미리
//     보기의 [승인][거절]은 그림이다(눌리지 않고 보조기술에서도 숨긴다).
//   - 거절은 iOS 창의 「허용 안 함」이 받고, 거절돼도 앱은 온전히 쓴다(심사 지침 4.5.4).
//     거부하면 같은 자리에서 한 장 더 서서 「프로필 › 알림에서 켤 수 있어요」를 말하고,
//     [시작하기] 하나로 내려간다.
//   - 이미 정해진 권한(허용·거부·provisional)이면 서지 않는다: `PushProvider`의 `gate`가
//     `ask`일 때만 선다(`shouldAskNotifications`).
//
// ## 작업 끝남 스위치는 프로필의 그 스위치다
//
// `usePushKinds`(프로필 시트와 같은 훅·같은 캐시 키)를 그대로 쓴다. 스위치를 돌리는
// 순간 `PATCH …/notification-rules/push-kinds {workComplete}` 하나만 나간다. [계속]은
// 오직 iOS 창을 부르는 버튼이다. M3은 세션이 선 뒤에 셸 위로 덮이므로 이 PATCH는
// 언제나 로그인한 세션으로 나간다. 서버 값을 읽기 전에는 스위치를 세우지 않고(기본이
// 「켬」이라 모르는 채 그리면 거짓이다), 이 경로를 모르는 서버(404)에서는 줄 자체를
// 세우지 않는다(켜도 아무 일 없는 스위치는 약속이다).
//
// 셸 위에 덮는다. 셸은 밑에서 이미 마운트되어 채널을 받아 두고, 창이 닫히면 곧장
// 보인다. VoiceOver는 `accessibilityViewIsModal`로 이 화면에 갇힌다.
// =============================================================================

import React, {useCallback, useEffect, useState} from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import {expressionForState} from '@momo/core/features/onboarding/guide';
import {
  NOTIFICATION_PAUSE_LOAD_FAILED,
  NOTIFICATION_PAUSE_SAVE_FAILED,
  PUSH_WORK_COMPLETE_DESCRIPTION,
  PUSH_WORK_COMPLETE_LABEL,
} from '@momo/core/features/settings/notificationRules';

import {usePalette, useStyles} from '../../design/theme';
import {font, slopTo, space, type Palette} from '../../design/tokens';
import {usePushPrompt} from '../../push/PushProvider';
import {useSession} from '../../session/useSession';
import {usePushKinds} from '../profile/selfStatus';
import {KomettoGuide, OnboardingCanvas} from './KomettoGuide';
import {
  OnboardingButton,
  OnboardingPhoneScreen,
  OnboardingTopBar,
  PHONE_OB,
} from './OnboardingControls';
import {
  lastConnectRoute,
  NOTIFY_ALWAYS_LABEL,
  NOTIFY_APPROVAL_LABEL,
  NOTIFY_APPROVAL_NOTE,
  NOTIFY_APPROVE_BUTTON,
  NOTIFY_CONTINUE_LABEL,
  NOTIFY_DECLINED_DETAIL,
  NOTIFY_DECLINED_LABEL,
  NOTIFY_DECLINED_LINE,
  NOTIFY_DETAIL,
  NOTIFY_LINE,
  NOTIFY_MENTION_LABEL,
  NOTIFY_REJECT_BUTTON,
  NOTIFY_SAMPLE_TIME,
  NOTIFY_SAMPLES,
  phoneOnboardingDots,
  setNotifyPrimerHeld,
  type NotifySample,
} from './phoneFlow';

const APP_ICON = require('../../design/brand/app-icon-notify.png');

/** 시안 `.notif` 값 + 이 화면이 더한 값(버튼 줄·간격). */
const NOTIF = {
  /** `.notif{border-radius:18px;padding:12px 14px;gap:10px}` */
  radius: 18,
  padV: 12,
  padH: 14,
  iconGap: 10,
  /** `.notif img{width:38px;height:38px;border-radius:9px}` */
  icon: 38,
  iconRadius: 9,
  /** 잠금 화면에서 펼친 알림의 버튼 줄: 같은 폭 둘, 높이 32, 반경 10. */
  actionGap: 8,
  actionTop: 8,
  actionHeight: 32,
  actionRadius: 10,
  /** 종류 이름 줄과 알림 사이, 알림과 설명 사이. */
  kindGap: 6,
  /**
   * 종류 이름 줄의 높이. iOS 스위치의 높이(31)다. 세 줄이 같은 높이여야 이름과 알림 사이가
   * 같은 리듬으로 선다. 누를 줄(작업 끝남)의 44는 이 줄을 키워서가 아니라 `hitSlop`이 채운다.
   */
  headHeight: 31,
  /** 스위치를 끈 종류의 예시는 「이건 안 와요」로 읽히게 한 단 물린다. */
  dimmed: 0.45,
} as const;

/** `usePushKinds`가 돌려주는 것 중 이 화면이 읽는 것. 하네스는 정적 값을 건넨다. */
export type PrimerKinds = Pick<
  ReturnType<typeof usePushKinds>,
  | 'absent'
  | 'ready'
  | 'workComplete'
  | 'loadFailed'
  | 'pending'
  | 'failed'
  | 'setWorkComplete'
>;

export type NotificationPrimerProps =
  | {
      mode: 'ask';
      onContinue: () => void;
      busy: boolean;
      kinds: PrimerKinds;
    }
  | {mode: 'declined'; onDone: () => void};

/**
 * M3 한 장. 두 모드가 **같은 요소**를 쓴다: 거부하면 코메토의 표정과 말만 바뀌고(문장이
 * 바뀌면 VoiceOver에 한 번 알려지고, 얼굴은 크로스페이드한다) 종류 목록은 걷힌다.
 */
export function NotificationPrimer(
  view: NotificationPrimerProps,
): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const dots = phoneOnboardingDots(lastConnectRoute(), 'notify');
  const ask = view.mode === 'ask';
  return (
    <OnboardingPhoneScreen
      testID={ask ? 'notify-primer' : 'notify-declined'}
      top={<OnboardingTopBar dots={dots} />}
      mainStyle={styles.main}
      bottom={
        view.mode === 'ask' ? (
          <OnboardingButton
            label={NOTIFY_CONTINUE_LABEL}
            busy={view.busy}
            onPress={view.onContinue}
            accessibilityHint="iOS 알림 허용 창이 뜹니다."
            testID="notify-primer-continue"
          />
        ) : (
          <OnboardingButton
            label={NOTIFY_DECLINED_LABEL}
            onPress={view.onDone}
            testID="notify-declined-continue"
          />
        )
      }
    >
      {view.mode === 'ask' ? (
        <KomettoGuide expression="happy" line={NOTIFY_LINE} header />
      ) : (
        <KomettoGuide
          expression={expressionForState('skipped')}
          line={NOTIFY_DECLINED_LINE}
          detail={NOTIFY_DECLINED_DETAIL}
          header
        />
      )}
      {view.mode === 'ask' ? (
        <>
          <View style={styles.kinds}>
            <AlwaysKind
              kind="approval"
              label={NOTIFY_APPROVAL_LABEL}
              note={NOTIFY_APPROVAL_NOTE}
              withActions
            />
            {view.kinds.absent ? null : <WorkKind kinds={view.kinds} />}
            <AlwaysKind kind="mention" label={NOTIFY_MENTION_LABEL} />
          </View>
          <Text
            style={styles.hint}
            lineBreakStrategyIOS="hangul-word"
            testID="notify-primer-detail"
          >
            {NOTIFY_DETAIL}
          </Text>
        </>
      ) : null}
    </OnboardingPhoneScreen>
  );
}

// ---- 종류 한 줄 ---------------------------------------------------------------

/** 끌 수 없는 종류(승인 요청·멘션·답·DM): 이름, 「항상 와요」, 예시 알림. */
function AlwaysKind({
  kind,
  label,
  note,
  withActions,
}: {
  kind: 'approval' | 'mention';
  label: string;
  note?: string;
  withActions?: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.kind} testID={`notify-kind-${kind}`}>
      <View
        style={styles.kindHead}
        accessible
        accessibilityLabel={`${label}, ${NOTIFY_ALWAYS_LABEL}`}
        testID={`notify-kind-${kind}-head`}
      >
        <Text style={styles.kindName} lineBreakStrategyIOS="hangul-word">
          {label}
        </Text>
        <Text style={styles.kindState}>{NOTIFY_ALWAYS_LABEL}</Text>
      </View>
      <NoticeSample
        sample={NOTIFY_SAMPLES[kind]}
        withActions={withActions}
        testID={`notify-sample-${kind}`}
      />
      {note ? (
        <Text style={styles.kindNote} testID={`notify-kind-${kind}-note`}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * 작업 끝남: 끌 수 있는 단 하나. 프로필 시트의 같은 줄과 같은 규칙이다 — 서버 값을 읽기
 * 전에는 스위치 대신 표시기를 세우고 눌러도 보내지 않으며, 쓰기가 실패하면 훅이 스위치를
 * 되돌리고 이 줄이 그렇게 말한다.
 */
function WorkKind({kinds}: {kinds: PrimerKinds}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const locked = !kinds.ready || kinds.pending;
  return (
    <View style={styles.kind} testID="notify-kind-work">
      <Pressable
        accessibilityRole="switch"
        accessibilityLabel={PUSH_WORK_COMPLETE_LABEL}
        accessibilityHint={PUSH_WORK_COMPLETE_DESCRIPTION}
        accessibilityState={{checked: kinds.workComplete, disabled: locked}}
        onPress={() => kinds.setWorkComplete(!kinds.workComplete)}
        hitSlop={{
          top: slopTo(NOTIF.headHeight),
          bottom: slopTo(NOTIF.headHeight),
        }}
        style={styles.kindHead}
        testID="notify-work-row"
      >
        <Text style={styles.kindName} lineBreakStrategyIOS="hangul-word">
          {PUSH_WORK_COMPLETE_LABEL}
        </Text>
        {kinds.ready ? (
          <Switch
            value={kinds.workComplete}
            onValueChange={next => kinds.setWorkComplete(next)}
            disabled={kinds.pending}
            trackColor={{false: palette.border, true: palette.ok}}
            ios_backgroundColor={palette.border}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            testID="notify-work-switch"
          />
        ) : kinds.loadFailed ? null : (
          // 서버 값을 모르는 동안 「켬」도 「꺼짐」도 그리지 않는다.
          <ActivityIndicator
            color={palette.textMuted}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            testID="notify-work-loading"
          />
        )}
      </Pressable>
      <NoticeSample
        sample={NOTIFY_SAMPLES.work}
        dimmed={kinds.ready && !kinds.workComplete}
        testID="notify-sample-work"
      />
      {kinds.loadFailed ? (
        <Text
          style={styles.kindNote}
          lineBreakStrategyIOS="hangul-word"
          testID="notify-work-load-failed"
        >
          {NOTIFICATION_PAUSE_LOAD_FAILED}
        </Text>
      ) : null}
      {kinds.failed ? (
        <Text
          style={styles.kindFailure}
          lineBreakStrategyIOS="hangul-word"
          accessibilityLiveRegion="polite"
          testID="notify-work-failure"
        >
          {NOTIFICATION_PAUSE_SAVE_FAILED}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * 알림 예시. **장식이다**: 읽으면 진짜 알림이 온 줄 안다. 그래서 보조기술에서 통째로
 * 숨기고, 종류 이름 줄과 설명이 같은 내용을 대신 말한다. [승인][거절]도 눌리지 않는 그림
 * 이다(`Pressable`이 아니다).
 */
function NoticeSample({
  sample,
  withActions,
  dimmed,
  testID,
}: {
  sample: NotifySample;
  withActions?: boolean;
  dimmed?: boolean;
  testID: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View
      style={[styles.notif, dimmed && styles.notifDimmed]}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID={testID}
    >
      <Image source={APP_ICON} style={styles.notifIcon} />
      <View style={styles.notifText}>
        <View style={styles.notifHead}>
          <Text style={styles.notifTitle}>{sample.title}</Text>
          <Text style={styles.notifTime}>{NOTIFY_SAMPLE_TIME}</Text>
        </View>
        <Text style={styles.notifBody} lineBreakStrategyIOS="hangul-word">
          {sample.body}
        </Text>
        {withActions ? (
          <View style={styles.actions}>
            <View style={styles.action} testID={`${testID}-approve`}>
              <Text style={styles.actionLabel}>{NOTIFY_APPROVE_BUTTON}</Text>
            </View>
            <View style={styles.action} testID={`${testID}-reject`}>
              <Text style={[styles.actionLabel, styles.actionDestructive]}>
                {NOTIFY_REJECT_BUTTON}
              </Text>
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}

// ---- 게이트 -------------------------------------------------------------------

/**
 * 프로필과 같은 훅을 여기서 건다. 이 컴포넌트는 M3이 **서 있을 때만** 마운트되므로
 * (이미 정해진 권한이면 `NotificationPrimerGate`가 여기까지 오지 않는다) 기존 설치자의
 * 앱 시작에 `push-kinds` 요청이 하나도 더해지지 않는다.
 */
function ConnectedPrimer({
  declined,
  busy,
  onContinue,
  onDone,
}: {
  declined: boolean;
  busy: boolean;
  onContinue: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const {workspaceId} = useSession();
  const kinds = usePushKinds(workspaceId);
  return declined ? (
    <NotificationPrimer mode="declined" onDone={onDone} />
  ) : (
    <NotificationPrimer
      mode="ask"
      busy={busy}
      onContinue={onContinue}
      kinds={kinds}
    />
  );
}

/**
 * 셸 위에 M3을 덮을지 정한다. `ask`면 M3, 방금 연결했는데 아직 권한을 읽는 중이면
 * 빈 바닥(셸이 한 틈 보였다가 M3로 바뀌는 깜박임을 막는다), 그 밖에는 아무것도 없다.
 *
 * ## 거부 뒤 안내
 *
 * 이 화면의 [계속]을 눌렀는데 게이트가 `settled`가 됐으면 거부(또는 창이 뜨지 못함)다.
 * `PushProvider.ask`는 답을 돌려주지 않고 게이트만 바꾸므로 **여기서** 「내가 물었다」를
 * 들고 있다 — 프로필 시트의 「알림 켜기」가 부른 `ask`는 이 화면을 세우지 않는다.
 */
export function NotificationPrimerGate(): React.JSX.Element | null {
  const {gate, ask} = usePushPrompt();
  const [asking, setAsking] = useState(false);
  const [asked, setAsked] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  const declined = asked && gate === 'settled' && !dismissed;
  const finished = asked && (gate === 'granted' || dismissed);

  const onContinue = useCallback(() => {
    setAsking(true);
    setAsked(true);
    // 키 연결 시트는 M3이 끝난 뒤에 선다. 게이트가 바뀐 뒤에 세우면 한 렌더 늦는다.
    setNotifyPrimerHeld(true);
    void ask().finally(() => setAsking(false));
  }, [ask]);
  const onDone = useCallback(() => setDismissed(true), []);

  useEffect(() => {
    if (finished) setNotifyPrimerHeld(false);
  }, [finished]);
  useEffect(() => () => setNotifyPrimerHeld(false), []);

  if (gate === 'ask' || declined) {
    return (
      <View style={StyleSheet.absoluteFill} accessibilityViewIsModal>
        <ConnectedPrimer
          declined={declined}
          busy={asking}
          onContinue={onContinue}
          onDone={onDone}
        />
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
    kinds: {gap: space.lg},
    kind: {gap: NOTIF.kindGap},
    // 큰 글씨에서 이름과 「항상 와요」가 한 줄에 못 들어가면 뒤의 것이 아래 줄로 내려간다.
    // 이름을 줄여 한 글자씩 접는 것(「멘션·답」 / 「·DM」)보다 낫다.
    kindHead: {
      minHeight: NOTIF.headHeight,
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: space.sm,
    },
    kindName: {
      flexShrink: 1,
      color: color.text,
      fontSize: font.label,
      fontWeight: '600',
    },
    kindState: {color: color.textMuted, fontSize: font.label},
    kindNote: {color: color.textMuted, fontSize: font.meta},
    kindFailure: {color: color.dangerText, fontSize: font.meta},
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
    notifDimmed: {opacity: NOTIF.dimmed},
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
    notifTitle: {color: color.text, fontSize: font.label, fontWeight: '600'},
    notifTime: {color: color.textMuted, fontSize: font.meta},
    notifBody: {color: color.text, fontSize: font.label},
    actions: {
      flexDirection: 'row',
      gap: NOTIF.actionGap,
      marginTop: NOTIF.actionTop,
    },
    action: {
      flex: 1,
      minHeight: NOTIF.actionHeight,
      borderRadius: NOTIF.actionRadius,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.surfaceMuted,
    },
    actionLabel: {color: color.text, fontSize: font.label, fontWeight: '600'},
    // iOS는 `isDestructive` 버튼의 제목을 붉게 그린다(`categories.ts`의 거절).
    actionDestructive: {color: color.danger},
    hint: {
      color: color.textMuted,
      fontSize: font.meta,
      textAlign: 'center',
    },
  });
