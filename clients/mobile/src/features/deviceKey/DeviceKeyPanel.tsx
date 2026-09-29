import React, {useEffect} from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Linking,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  GroupSection,
  OutlineButton,
  PrimaryButton,
  Sentence,
} from '../../design/atoms';
import {usePalette, useStyles} from '../../design/theme';
import {
  font,
  line,
  radius,
  SAFE_GUTTER,
  space,
  type Palette,
} from '../../design/tokens';
import {fingerprintAccessibilityLabel} from '../../deviceKey/fingerprint';
import type {DeviceKeyView} from '../../deviceKey/enrollment';
import {
  ACTION,
  BIOMETRY_OFF_NOTE,
  DEVICE_KEY_TITLE,
  deviceKeyCopy,
  FINGERPRINT_HINT,
  FINGERPRINT_LABEL,
  type DeviceKeyTone,
} from './copy';
import type {DeviceKeyState} from './useDeviceKey';

// =============================================================================
// 「지시 기기」 판 (#3026 stage 2). 프로필 시트의 한 장과, QR 연결 직후 한 번 뜨는
// 시트가 같은 판을 쓴다 — 두 자리가 다른 문장을 말하면 사람은 어느 쪽을 믿을지
// 모른다.
//
// 지문은 맥 화면과 **한 글자씩 대조**하는 값이다. 맥의 승인 창도 같은 네 자 묶음
// 다섯 개를 보인다(`deviceKeyFingerprint`, 공유 사례 `5BAF F89D E7DE 5C1D 7B61`).
// 그래서 어떤 글자 크기에서도 **끝까지** 보여야 한다: 묶음마다 따로 서는 글자라
// 줄은 묶음 사이에서만 바뀌고, 줄 수 제한이 없다(design-review R1 B1 — AX-L 에서
// 마지막 묶음이 말줄임으로 사라졌다).
//
// 다음 행동(등록·다시 등록·새 키·iOS 설정)이 있으면 그것이 판 아래의 **채움
// 버튼**이다(R1 M2). 둘째 행동은 테두리 버튼이다.
//
// 모르는 것은 말하지 않는다: 서버 목록을 못 읽었으면 「승인 전」도 「승인됨」도
// 그리지 않고 「불러오지 못했습니다」를 말한다.
// =============================================================================

interface Action {
  key: string;
  label: string;
  onPress: () => void;
  /** 누르면 등록이 돈다 — busy 동안 「등록 중」으로 선다. */
  enrolls: boolean;
  /** busy 동안의 이름. 없으면 「등록 중」. */
  busyLabel?: string;
}

export function deviceKeyActions(view: DeviceKeyView, state: DeviceKeyState): Action[] {
  const settings: Action = {
    key: 'settings',
    label: ACTION.openSettings,
    onPress: () => void Linking.openSettings(),
    enrolls: false,
  };
  const recheck: Action = {
    key: 'recheck',
    label: ACTION.recheck,
    onPress: state.refresh,
    enrolls: false,
  };
  switch (view.kind) {
    case 'unregistered':
      return [{key: 'enroll', label: ACTION.enroll, onPress: state.enroll, enrolls: true}];
    case 'revoked':
      return [{key: 'reenroll', label: ACTION.reenroll, onPress: state.enroll, enrolls: true}];
    case 'replaceBlocked':
      return view.reason === 'oldKey'
        ? [recheck]
        : [
            {
              key: 'reenroll-refused',
              label: ACTION.retry,
              onPress: state.enroll,
              enrolls: true,
            },
          ];
    case 'invalidated':
      return [{key: 'replace', label: ACTION.replace, onPress: state.replace, enrolls: true}];
    case 'biometryOff':
      return [settings, recheck];
    case 'reconnect':
      return view.biometryOff
        ? [settings, recheck]
        : [
            {
              key: 'reconnect',
              label: ACTION.reconnect,
              onPress: state.enroll,
              enrolls: true,
              busyLabel: ACTION.reconnectBusy,
            },
          ];
    case 'approved':
    case 'pending':
      return view.biometryOff ? [settings, recheck] : [];
    case 'serverError':
    case 'localError':
      return [{key: 'retry', label: ACTION.retry, onPress: state.refresh, enrolls: false}];
    default:
      return [];
  }
}

export function DeviceKeyPanel({
  state,
  testID = 'device-key-panel',
}: {
  state: DeviceKeyState;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const {view, busy, failure} = state;
  const copy = deviceKeyCopy(view, busy);
  const fingerprint =
    'fingerprint' in view && view.fingerprint ? view.fingerprint : null;
  const fingerprintLabel = copy.fingerprintLabel ?? FINGERPRINT_LABEL;
  const revokedFaceIdOff = view.kind === 'revoked' && view.biometryOff;
  const actions = deviceKeyActions(view, state);
  const [primary, ...rest] = actions;

  // iOS 에는 live region 이 없다 — 실패 문장은 직접 읽어 준다(R1 M5).
  useEffect(() => {
    if (failure) AccessibilityInfo.announceForAccessibility(failure);
  }, [failure]);

  return (
    <View style={styles.root} testID={testID}>
      <GroupSection>
        <View
          accessible
          accessibilityLabel={`${DEVICE_KEY_TITLE}: ${copy.badge}. ${copy.headline} ${copy.detail}${
            copy.warning ? ` 주의. ${copy.warning}` : ''
          }${
            copy.steps
              ? ` ${copy.steps.map((step, index) => `${index + 1}. ${step}`).join(' ')}`
              : ''
          }`}
          style={styles.status}
          testID="device-key-status"
        >
          <View style={styles.statusHead}>
            <View style={[styles.pill, pillTone(styles, copy.tone)]}>
              {view.kind === 'loading' ||
              (busy && (view.kind === 'unregistered' || view.kind === 'reconnect')) ? (
                <ActivityIndicator
                  size="small"
                  color={palette.textMuted}
                  style={styles.pillSpinner}
                />
              ) : (
                <View style={[styles.pillDot, dotTone(styles, copy.tone)]} />
              )}
              <Text
                style={[styles.pillLabel, pillLabelTone(styles, copy.tone)]}
                testID="device-key-badge"
              >
                {copy.badge}
              </Text>
            </View>
          </View>
          <Sentence style={styles.headline} testID="device-key-headline">
            {copy.headline}
          </Sentence>
          {copy.detail ? (
            <Sentence style={styles.detail} testID="device-key-detail">
              {copy.detail}
            </Sentence>
          ) : null}
          {copy.warning ? (
            <View style={styles.warning} testID="device-key-warning">
              <Sentence style={styles.warningText}>{copy.warning}</Sentence>
            </View>
          ) : null}
          {copy.steps ? (
            <View style={styles.steps} testID="device-key-steps">
              {copy.steps.map((step, index) => (
                <View key={index} style={styles.step}>
                  <Text style={styles.stepNumber}>{index + 1}</Text>
                  <Sentence style={styles.stepText} testID="device-key-step">
                    {step}
                  </Sentence>
                </View>
              ))}
            </View>
          ) : null}
          {revokedFaceIdOff ? (
            <Sentence style={styles.detail} testID="device-key-biometry-note">
              {BIOMETRY_OFF_NOTE}
            </Sentence>
          ) : null}
        </View>

        {fingerprint ? (
          <View
            style={styles.fingerprint}
            accessible
            accessibilityLabel={`${fingerprintLabel}, ${fingerprintAccessibilityLabel(fingerprint)}`}
            accessibilityHint={FINGERPRINT_HINT}
            testID="device-key-fingerprint"
          >
            <Text style={styles.fingerprintLabel}>{fingerprintLabel}</Text>
            <View style={styles.fingerprintGroups}>
              {fingerprint.split(' ').map((group, index) => (
                <Text
                  key={index}
                  style={styles.fingerprintGroup}
                  testID="device-key-fingerprint-group"
                >
                  {group}
                </Text>
              ))}
            </View>
          </View>
        ) : null}
      </GroupSection>

      {primary ? (
        <View style={styles.actions}>
          <PrimaryButton
            label={primary.label}
            busy={busy && primary.enrolls}
            busyLabel={primary.busyLabel ?? ACTION.busy}
            disabled={busy}
            onPress={primary.onPress}
            testID={`device-key-action-${primary.key}`}
          />
          {rest.map(action => (
            <OutlineButton
              key={action.key}
              label={action.label}
              onPress={action.onPress}
              testID={`device-key-action-${action.key}`}
            />
          ))}
        </View>
      ) : null}

      {failure ? (
        <Sentence style={styles.failure} testID="device-key-failure">
          {failure}
        </Sentence>
      ) : null}
    </View>
  );
}

/** 행동이 있는가 — 링크 시트가 자기 「확인」을 채움으로 세울지 정한다. */
export function hasDeviceKeyAction(state: DeviceKeyState): boolean {
  return deviceKeyActions(state.view, state).length > 0;
}

type Styles = ReturnType<typeof buildStyles>;

function pillTone(styles: Styles, tone: DeviceKeyTone) {
  switch (tone) {
    case 'ok':
      return styles.pillOk;
    case 'warn':
      return styles.pillWarn;
    case 'danger':
      return styles.pillDanger;
    case 'muted':
      return styles.pillMuted;
  }
}

function pillLabelTone(styles: Styles, tone: DeviceKeyTone) {
  switch (tone) {
    case 'ok':
      return styles.labelOk;
    case 'warn':
      return styles.labelWarn;
    case 'danger':
      return styles.labelDanger;
    case 'muted':
      return styles.labelMuted;
  }
}

function dotTone(styles: Styles, tone: DeviceKeyTone) {
  switch (tone) {
    case 'ok':
      return styles.dotOk;
    case 'warn':
      return styles.dotWarn;
    case 'danger':
      return styles.dotDanger;
    case 'muted':
      return styles.dotMuted;
  }
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {gap: space.md},
    status: {
      paddingHorizontal: space.lg,
      paddingVertical: space.md,
      gap: space.sm,
    },
    statusHead: {flexDirection: 'row'},
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingHorizontal: space.md,
      paddingVertical: space.xs,
      borderRadius: radius.pill,
    },
    pillSpinner: {transform: [{scale: 0.7}]},
    pillOk: {backgroundColor: color.okSurface},
    pillWarn: {backgroundColor: color.warnSurface},
    pillDanger: {backgroundColor: color.dangerSurface},
    pillMuted: {backgroundColor: color.bg},
    pillDot: {width: space.sm, height: space.sm, borderRadius: radius.pill},
    dotOk: {backgroundColor: color.ok},
    dotWarn: {backgroundColor: color.warn},
    dotDanger: {backgroundColor: color.danger},
    dotMuted: {backgroundColor: color.textFaint},
    pillLabel: {fontSize: font.label, fontWeight: '600'},
    labelOk: {color: color.ok},
    labelWarn: {color: color.warn},
    labelDanger: {color: color.dangerText},
    labelMuted: {color: color.textMuted},
    headline: {fontSize: font.body, fontWeight: '600', color: color.text},
    detail: {fontSize: font.label, color: color.textMuted, lineHeight: line.label},
    // 보안 경고 (#3154 M3): 절차 글씨보다 앞서 읽히게 위험 바탕·굵은 글씨.
    warning: {
      backgroundColor: color.dangerSurface,
      borderRadius: radius.sm,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
    },
    warningText: {
      fontSize: font.label,
      lineHeight: line.label,
      fontWeight: '700',
      color: color.dangerText,
    },
    // 방법 (#3129): 번호는 본문 첫 줄에 맞춰 선다. 줄이 바뀌면 글만 들여 쓴다.
    steps: {gap: space.xs, paddingTop: space.xs},
    step: {flexDirection: 'row', alignItems: 'flex-start', gap: space.sm},
    stepNumber: {
      fontSize: font.label,
      lineHeight: line.label,
      fontWeight: '600',
      color: color.textMuted,
      fontVariant: ['tabular-nums'],
      minWidth: space.md,
    },
    stepText: {
      flex: 1,
      fontSize: font.label,
      lineHeight: line.label,
      color: color.text,
    },
    fingerprint: {
      paddingHorizontal: space.lg,
      paddingVertical: space.md,
      gap: space.xs,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: color.border,
    },
    fingerprintLabel: {
      fontSize: font.label,
      color: color.textMuted,
      fontWeight: '600',
    },
    // 묶음 사이에서만 줄이 바뀐다. 간격은 한 글자 폭쯤(space.md).
    fingerprintGroups: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      columnGap: space.md,
    },
    fingerprintGroup: {
      fontFamily: 'Menlo',
      fontSize: font.heading,
      fontWeight: '600',
      color: color.text,
    },
    actions: {paddingHorizontal: SAFE_GUTTER, gap: space.sm},
    failure: {
      fontSize: font.label,
      color: color.danger,
      lineHeight: line.label,
      paddingHorizontal: SAFE_GUTTER + space.xs,
    },
  });
