import React, {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {StyleSheet, View} from 'react-native';

import {PrimaryButton, Sentence} from '../../design/atoms';
import {PageSheet, usePageSheetClose} from '../../design/PageSheet';
import {SheetHeader} from '../../design/SheetChrome';
import {SheetScroll} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {font, line, SAFE_GUTTER, space, type Palette} from '../../design/tokens';
import {usePushPrompt} from '../../push/PushProvider';
import {useSession} from '../../session/useSession';
import {
  consumeQrKeyEnrollment,
  isNotifyPrimerHeld,
  qrKeyEnrollmentArmed,
  subscribeNotifyPrimerHeld,
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
  // M3이 거부 뒤 안내까지 서 있는 동안 붙든다(ADR-0204 D4, #3925). 게이트만 보면 거부
  // 직후 M3 위로 이 시트가 오른다 — 네이티브 `Modal`이라 무엇이 떠 있든 그 위에 선다.
  const primerHeld = useSyncExternalStore(
    subscribeNotifyPrimerHeld,
    isNotifyPrimerHeld,
    isNotifyPrimerHeld,
  );
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
  if (gate === 'ask' || gate === 'checking' || primerHeld) return null;
  return (
    <PageSheet
      onClose={() => setOpen(false)}
      accessibilityLabel={DEVICE_KEY_TITLE}
      scrimLabel={`${DEVICE_KEY_TITLE} 닫기`}
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
  const slideClose = usePageSheetClose() ?? onClose;
  return (
    <View style={styles.root}>
      {/* 머리는 공용 `SheetHeader`(#4318): 글자 「닫기」 대신 오른쪽 원형 X. 이름은 「지시 기기 닫기」 그대로다. */}
      <SheetHeader
        title={DEVICE_KEY_TITLE}
        closeLabel={`${DEVICE_KEY_TITLE} 닫기`}
        closeTestID="device-key-link-close"
        onClose={slideClose}
      />
      {/* 몸은 공용 `SheetScroll`(#4612) — 맨 위에서 끌어내리면 시트가 따라오고(스크롤 넘겨받기), 위 여백·홈 인디케이터 아래 바닥
          여백·고무줄 없음이 다른 시트와 같다. 패널의 카드가 스스로 가로 여백을 지므로 호스트의 기본 가로 여백만 걷는다. */}
      <SheetScroll
        contentOffset={initialScrollY ? {x: 0, y: initialScrollY} : undefined}
        contentContainerStyle={styles.content}
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
      </SheetScroll>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {flex: 1},
    // `SheetScroll` 의 기본(가로 여백 SAFE_GUTTER·위 여백·gap lg) 위에 얹는다: 가로 여백은 패널의 카드가 진다(이중 인셋 방지 — 시험이
    // 잰다), 카드 사이 숨은 이 시트가 원래 쓰던 xl 이다.
    content: {paddingHorizontal: 0, gap: space.xl},
    intro: {
      fontSize: font.body,
      color: color.text,
      lineHeight: line.body,
      paddingHorizontal: SAFE_GUTTER + space.xs,
    },
    done: {paddingHorizontal: SAFE_GUTTER},
  });
