import React from 'react';
import {ActivityIndicator, Linking, StyleSheet, Text, View} from 'react-native';

import {GroupRow, GroupSection, Sentence} from '../../design/atoms';
import {usePalette, useStyles} from '../../design/theme';
import {
  font,
  radius,
  SAFE_GUTTER,
  space,
  type Palette,
} from '../../design/tokens';
import {fingerprintAccessibilityLabel} from '../../deviceKey/fingerprint';
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
// 지문은 맥 화면과 **한 글자씩 대조**하는 값이라 판에서 가장 크다. 맥의 승인 창도
// 같은 네 자 묶음 다섯 개를 보인다(`deviceKeyFingerprint`, 공유 사례
// `5BAF F89D E7DE 5C1D 7B61`). SAS 네 자리(`font.display`)처럼 두 화면 사이에서
// 맞춰 보는 숫자다.
//
// 모르는 것은 말하지 않는다: 서버 목록을 못 읽었으면 「승인 대기」도 「승인됨」도
// 그리지 않고 「불러오지 못했습니다」를 말한다.
// =============================================================================

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
  const copy = deviceKeyCopy(view);
  const fingerprint =
    'fingerprint' in view && view.fingerprint ? view.fingerprint : null;
  const biometryOff = 'biometryOff' in view && view.biometryOff;

  const actions: {label: string; onPress: () => void; key: string}[] = [];
  switch (view.kind) {
    case 'unregistered':
      actions.push({key: 'enroll', label: ACTION.enroll, onPress: state.enroll});
      break;
    case 'revoked':
      actions.push({key: 'reenroll', label: ACTION.reenroll, onPress: state.enroll});
      break;
    case 'invalidated':
      actions.push({key: 'replace', label: ACTION.replace, onPress: state.replace});
      break;
    case 'biometryOff':
      actions.push(
        {key: 'settings', label: ACTION.openSettings, onPress: () => void Linking.openSettings()},
        {key: 'recheck', label: ACTION.recheck, onPress: state.refresh},
      );
      break;
    case 'serverError':
    case 'localError':
      actions.push({key: 'retry', label: ACTION.retry, onPress: state.refresh});
      break;
    default:
      break;
  }

  return (
    <View style={styles.root} testID={testID}>
      <GroupSection label={DEVICE_KEY_TITLE}>
        <View
          accessible
          accessibilityLabel={`${DEVICE_KEY_TITLE}: ${copy.badge}. ${copy.headline} ${copy.detail}`}
          style={styles.status}
          testID="device-key-status"
        >
          <View style={styles.statusHead}>
            <View style={[styles.pill, pillTone(styles, copy.tone)]}>
              {view.kind === 'loading' ? (
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
          {biometryOff ? (
            <Sentence style={styles.warnNote} testID="device-key-biometry-note">
              {BIOMETRY_OFF_NOTE}
            </Sentence>
          ) : null}
        </View>

        {fingerprint ? (
          <View
            style={styles.fingerprint}
            accessible
            accessibilityLabel={`${FINGERPRINT_LABEL}, ${fingerprintAccessibilityLabel(fingerprint)}`}
            accessibilityHint={FINGERPRINT_HINT}
          >
            <Text style={styles.fingerprintLabel}>{FINGERPRINT_LABEL}</Text>
            <Text
              style={styles.fingerprintValue}
              selectable
              numberOfLines={2}
              testID="device-key-fingerprint"
            >
              {fingerprint}
            </Text>
          </View>
        ) : null}

        {actions.map(action => (
          <GroupRow
            key={action.key}
            title={busy && action.key !== 'settings' ? ACTION.busy : action.label}
            tone="accent"
            separated
            disabled={busy}
            onPress={action.onPress}
            trailing={
              busy && action.key !== 'settings' && action.key !== 'recheck' ? (
                <ActivityIndicator size="small" color={palette.textMuted} />
              ) : undefined
            }
            testID={`device-key-action-${action.key}`}
          />
        ))}
      </GroupSection>

      {failure ? (
        <Sentence
          style={styles.failure}
          accessibilityLiveRegion="polite"
          testID="device-key-failure"
        >
          {failure}
        </Sentence>
      ) : null}
    </View>
  );
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

/** 지문 글자. 두 화면을 오가며 맞춰 보는 값이라 본문보다 한 단 크다. */
const FINGERPRINT_FONT = font.heading + 2;

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {gap: space.sm},
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
    detail: {fontSize: font.label, color: color.textMuted, lineHeight: 18},
    warnNote: {fontSize: font.label, color: color.text, lineHeight: 18},
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
    fingerprintValue: {
      fontFamily: 'Menlo',
      fontSize: FINGERPRINT_FONT,
      fontWeight: '600',
      color: color.text,
      letterSpacing: 1,
    },
    failure: {
      fontSize: font.label,
      color: color.dangerText,
      lineHeight: 18,
      paddingHorizontal: SAFE_GUTTER + space.xs,
    },
  });
