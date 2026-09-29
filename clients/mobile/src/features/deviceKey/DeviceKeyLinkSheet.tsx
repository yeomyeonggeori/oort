import React, {useEffect, useRef, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {BAR_CONTROL_MAX_SCALE, PrimaryButton, Sentence} from '../../design/atoms';
import {PageSheet, usePageSheetClose} from '../../design/PageSheet';
import {useStyles} from '../../design/theme';
import {
  font,
  line,
  radius,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {usePushPrompt} from '../../push/PushProvider';
import {useSession} from '../../session/useSession';
import {
  consumeQrKeyEnrollment,
  qrKeyEnrollmentArmed,
} from '../onboarding/phoneFlow';
import type {DeviceKeyView} from '../../deviceKey/enrollment';
import {DEVICE_KEY_TITLE} from './copy';
import {DeviceKeyPanel, hasDeviceKeyAction} from './DeviceKeyPanel';
import {useDeviceKey, type DeviceKeyState} from './useDeviceKey';

// =============================================================================
// QR 연결 직후의 「지시 기기」 (#3026 stage 2, ADR-0146 개정 2026-09-28 D-6 ②).
//
// 「폰은 QR 연결 때 키를 만들어 올린다. QR 연결이 끝나는 시점에 데스크탑에 승인
// 단계를 둔다.」 — 이 폰 쪽 절반이다. 연결 화면이 QR 경로를 적어 두면
// (`noteConnectRoute('qr')`), 셸이 선 직후 한 번:
//
//   1. 키를 만들고(Face ID 창은 뜨지 않는다 — 만들 때가 아니라 서명할 때 묻는다)
//      서버에 등록한다. 등록된 키는 「지시 불가」(unendorsed)로 시작한다.
//   2. 알림 미리 안내(M3)가 끝난 뒤 이 시트를 한 번 띄워 결과와 지문을 보인다 —
//      맥의 승인 창에 같은 지문이 떠 있는 동안 사람이 맞춰 볼 수 있게.
//
// 주소 로그인·초대 참여에는 서지 않는다(키는 QR 연결의 몫이다). 그 길로 들어온
// 폰, 등록이 실패한 폰은 프로필 › 지시 기기에서 등록한다.
//
// 실패·미지원(시뮬레이터)·Face ID 미등록은 판이 그대로 말한다. 대화와 알림은 키와
// 상관없이 쓴다 — 이 시트는 무엇도 막지 않는다.
// =============================================================================

/** 고정 문장은 이것 하나다 — 나머지는 상태마다 판이 말한다(R1 M1: 「맥에서
 *  승인해야 합니다」가 이미 승인된 폰·키를 못 만드는 폰에도 붙었다). */
export const LINK_SHEET_INTRO = 'QR 연결을 마쳤습니다.';
/** #3129 design-review M1: a QR no Mac made links chat and alerts only — 「마쳤습니다」
 *  next to 「QR 연결 필요」 would contradict itself. */
export const LINK_SHEET_INTRO_UNLINKED = '대화와 알림은 연결됐습니다.';

/**
 * #3154 L3: 위쪽 문장은 QR 연결의 결과이지 키의 결과가 아니다. 아래 판이 「맥 확인
 * 필요」·「Face ID 필요」·오류를 말하는데 위가 「마쳤습니다」면 한 화면이 스스로
 * 모순된다. 연결도 키도 잘 가는 상태에서만 「마쳤습니다」, 나머지는 어느 쪽에서든
 * 참인 「대화와 알림은 연결됐습니다」다.
 */
export function linkSheetIntro(view: DeviceKeyView): string {
  switch (view.kind) {
    case 'loading':
    case 'unregistered':
      return LINK_SHEET_INTRO;
    case 'pending':
    case 'approved':
      return view.biometryOff ? LINK_SHEET_INTRO_UNLINKED : LINK_SHEET_INTRO;
    default:
      return LINK_SHEET_INTRO_UNLINKED;
  }
}

export function DeviceKeyLinkGate(): React.JSX.Element | null {
  const {workspaceId} = useSession();
  const {gate} = usePushPrompt();
  // 들여다보기만 하고, 소비는 효과에서 한다 — 초기화 함수는 두 번 불릴 수 있다.
  const [armed] = useState(qrKeyEnrollmentArmed);
  const [open, setOpen] = useState(armed);
  const state = useDeviceKey(workspaceId, {poll: open});
  const started = useRef(false);
  const {enroll} = state;

  useEffect(() => {
    if (!armed || started.current) return;
    started.current = true;
    consumeQrKeyEnrollment();
    enroll();
  }, [armed, enroll]);

  if (!open) return null;
  // M3(알림 미리 안내)가 먼저다 — 두 화면이 겹치면 어느 쪽이 무엇을 묻는지
  // 모른다.
  if (gate === 'ask' || gate === 'checking') return null;
  return (
    <PageSheet
      onClose={() => setOpen(false)}
      accessibilityLabel={DEVICE_KEY_TITLE}
      testID="device-key-link-sheet"
    >
      <LinkSheetBody state={state} onClose={() => setOpen(false)} />
    </PageSheet>
  );
}

export function LinkSheetBody({
  state,
  onClose,
  initialScrollY,
}: {
  state: DeviceKeyState;
  onClose: () => void;
  /** 캡처 전용(#3154 M1): 큰 글씨에서 시트를 스크롤한 자리를 사진으로 남긴다. */
  initialScrollY?: number;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const slideClose = usePageSheetClose() ?? onClose;
  return (
    <View style={styles.root}>
      <View style={styles.nav}>
        <View style={styles.navSide} />
        <Text
          accessibilityRole="header"
          style={styles.navTitle}
          numberOfLines={1}
          maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
        >
          {DEVICE_KEY_TITLE}
        </Text>
        <View style={[styles.navSide, styles.navSideEnd]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${DEVICE_KEY_TITLE} 닫기`}
            onPress={slideClose}
            style={({pressed}) => [styles.navButton, pressed && styles.pressed]}
            testID="device-key-link-close"
          >
            <Text
              style={styles.navButtonLabel}
              numberOfLines={1}
              maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
            >
              닫기
            </Text>
          </Pressable>
        </View>
      </View>
      <ScrollView
        contentOffset={initialScrollY ? {x: 0, y: initialScrollY} : undefined}
        contentContainerStyle={[
          styles.content,
          {paddingBottom: Math.max(insets.bottom, space.lg) + space.lg},
        ]}
        testID="device-key-link-scroll"
      >
        <Sentence style={styles.intro} testID="device-key-link-intro">
          {linkSheetIntro(state.view)}
        </Sentence>
        <DeviceKeyPanel state={state} />
        {/* 다음 행동이 있으면 판의 채움 버튼이 주인이다 — 닫기는 머리의 「닫기」
            하나로 충분하다(R1 M2). 할 일이 없을 때만 「확인」이 선다. */}
        {hasDeviceKeyAction(state) ? null : (
          <View style={styles.done}>
            <PrimaryButton
              label="확인"
              onPress={slideClose}
              testID="device-key-link-done"
            />
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {flex: 1},
    // 프로필 시트의 머리와 같은 모양(`ProfileSheet` `nav`).
    nav: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: TOUCH_TARGET + space.md,
      paddingHorizontal: space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: color.border,
    },
    navSide: {flex: 1, flexDirection: 'row'},
    navSideEnd: {justifyContent: 'flex-end'},
    navTitle: {
      flexShrink: 1,
      fontSize: font.body,
      fontWeight: '600',
      color: color.text,
      textAlign: 'center',
    },
    navButton: {
      minHeight: TOUCH_TARGET,
      justifyContent: 'center',
      paddingHorizontal: space.sm,
      borderRadius: radius.sm,
    },
    navButtonLabel: {
      fontSize: font.body,
      color: color.accentText,
      fontWeight: '600',
    },
    pressed: {backgroundColor: color.surfacePressed},
    content: {paddingTop: space.xl, gap: space.xl},
    intro: {
      fontSize: font.body,
      color: color.text,
      lineHeight: line.body,
      paddingHorizontal: SAFE_GUTTER + space.xs,
    },
    done: {paddingHorizontal: SAFE_GUTTER},
  });
