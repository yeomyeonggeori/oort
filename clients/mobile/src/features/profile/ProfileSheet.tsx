import {effectivePresenceLabel} from '@momo/core/features/presence/model';
import {visibleCustomStatus} from '@momo/core/features/presence/customStatus';
import {
  memberFor,
  type Directory,
} from '@momo/core/features/workspace/directory';
import {
  effectivePresence,
  type EffectivePresence,
  type Member,
} from '@momo/core/lib/api';
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {
  BAR_CONTROL_MAX_SCALE,
  GroupRow,
  GroupSection,
  Sentence,
} from '../../design/atoms';
import {PageSheet, usePageSheetClose} from '../../design/PageSheet';
import {ThemeControl} from '../../design/ThemeControl';
import {themeChoiceLabel, useStyles, useTheme} from '../../design/theme';
import {
  font,
  radius,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {useNow} from '../../lib/useNow';
import {
  pushPermissionDetail,
  usePushPermission,
} from '../../push/permissionStatus';
import {getServerBase} from '../../storage/serverBase';
import {Avatar} from '../conversation/Avatar';
import {formatRealtimeDiagnostics} from '../../realtime/diagnostics';
import {COPY_RECEIPT_MS, copyText} from '../conversation/copy';
import {currentAppVersionLabel} from './appVersion';

// =============================================================================
// 내 프로필 시트 — 대화 목록 머리의 아바타가 여는 곳 (#2702).
//
// 성재 피드백(2026-09-25): 「모바일 기준으로 버즈처럼 프로필 위치를 바꿔주고,
// 누르면 안에서 테마나 로그아웃이나 그런걸 할 수 있는 구조… 지금 화면 하단 UI랑
// UX가 너무 구려」. 그 전의 판은 대화 목록 발치에 이름·@핸들·로그아웃 버튼·테마
// 세 칸을 붙박아 두었다 — 매일 보는 목록의 아래 네 줄이 한 번 고르면 끝나는
// 설정에 쓰이고 있었다.
//
// 이 시트는 **설정 화면이 아니다**(ADR-0137 D5 가 설정을 데스크탑에 둔다). 이
// 기기와 내 계정에 관한 것 — 누구로 들어와 있는가, 어떻게 보이는가, 알림이 오는가,
// 어디에 붙어 있는가, 어떻게 나가는가, 이 앱이 몇 판인가 — 만 담는다.
//
// ## 모양
//
// 셸의 페이지 시트다(`design/PageSheet.tsx`, 시안 `.a-sheet`): 아래에서 올라와
// 스크림이 목록을 덮고, 손잡이를 끌어내리거나 스크림을 누르면 닫힌다. 처음 판은 iOS
// `pageSheet` 였고(#2702), DS2-2(#2714)가 시안의 모양(위 58, 반경 30)으로 옮겼다.
// 닫힘은 어느 길로 오든 부모의 「열림」을 내린다 — 모달의 `onRequestClose`·
// `onDismiss` 도 같은 `onClose` 로 잇는다. 하나라도 빠지면 시트는 사라졌는데 부모의
// 「열림」이 참으로 남아 아바타를 다시 눌러도 안 열린다.
//
// 테마는 「테마 ›」 줄이 시트 **안에서** 여는 한 장이다. 시트 위에 시트를 겹치지
// 않는다 — 돌아오는 길이 둘이 되면 어느 쪽이 닫히는지 사람이 알 수 없다.
//
// ## 상태는 모르는 것을 말하지 않는다
//
// 상태 알약은 웹 `ProfileCard` 와 같은 식으로 코어가 답한다:
// `effectivePresence(선언, 연결됨)`. 선언이 자리 비움·방해 금지면 그것이 답이고,
// 아니면 이 앱의 실시간 연결이 답이다. 상태를 **바꾸는** 문은 여기 없다 — 폰에는
// 그 쓰기 경로가 아직 없고, 누를 수 없는 것을 누를 것처럼 그리지 않는다.
//
// ## 연결된 기기
//
// 없다. 폰은 기기 연결의 **받는 쪽**(QR 을 읽어 로그인한다)이고 연결된 기기 목록을
// 가진 쪽이 아니다. 없는 항목을 자리만 그려 두지 않는다.
// =============================================================================

type Page = 'profile' | 'theme';

export function ProfileSheet({
  member,
  directory,
  connected,
  onSignOut,
  onClose,
}: {
  member: Member;
  directory: Directory;
  /** 실시간 연결이 지금 붙어 있는가. 상태 알약의 `auto` 가 이것으로 풀린다. */
  connected: boolean;
  onSignOut: () => void;
  onClose: () => void;
}): React.JSX.Element {
  // 셸의 페이지 시트(시안 `.a-sheet`: 위 58, 반경 30, `sheet` 바탕, 스크림, 손잡이)
  // 안에 선다 (ADR-0189 D1, DS2-2 #2714). 이 시트는 한때 iOS `pageSheet` 였다 —
  // 모양은 시스템이 정했고, 시안이 정한 58·30 이 아니었다. 내용은 그대로다(재도색은
  // DS2-5 #2717).
  return (
    <PageSheet onClose={onClose} accessibilityLabel="내 프로필" testID="profile-sheet">
      <SheetBody
        member={member}
        directory={directory}
        connected={connected}
        onSignOut={onSignOut}
        onClose={onClose}
      />
    </PageSheet>
  );
}

function SheetBody({
  member,
  directory,
  connected,
  onSignOut,
  onClose,
}: {
  member: Member;
  directory: Directory;
  connected: boolean;
  onSignOut: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  // 「닫기」도 스크림·끌기와 같이 미끄러져 나간다.
  const slideClose = usePageSheetClose() ?? onClose;
  const [page, setPage] = useState<Page>('profile');
  const scrollRef = useRef<ScrollView>(null);
  const revealEnd = useCallback(
    () => scrollRef.current?.scrollToEnd({animated: true}),
    [],
  );

  return (
    <View style={styles.root}>
      <View style={styles.nav}>
        <View style={styles.navSide}>
          {page === 'theme' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="프로필"
              onPress={() => setPage('profile')}
              style={({pressed}) => [
                styles.navButton,
                pressed && styles.pressed,
              ]}
              testID="profile-back"
            >
              <Text
                style={styles.navButtonLabel}
                numberOfLines={1}
                maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
              >
                ‹ 프로필
              </Text>
            </Pressable>
          ) : null}
        </View>
        <Text
          accessibilityRole="header"
          style={styles.navTitle}
          numberOfLines={1}
          maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
        >
          {page === 'theme' ? '테마' : '내 프로필'}
        </Text>
        <View style={[styles.navSide, styles.navSideEnd]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="내 프로필 닫기"
            onPress={slideClose}
            style={({pressed}) => [styles.navButton, pressed && styles.pressed]}
            testID="profile-close"
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
        ref={scrollRef}
        contentContainerStyle={[
          styles.content,
          {paddingBottom: Math.max(insets.bottom, space.lg) + space.lg},
        ]}
        testID="profile-scroll"
      >
        {page === 'theme' ? (
          <ThemePage />
        ) : (
          <ProfilePage
            member={member}
            directory={directory}
            connected={connected}
            onOpenTheme={() => setPage('theme')}
            onSignOut={onSignOut}
            onRevealEnd={revealEnd}
          />
        )}
      </ScrollView>
    </View>
  );
}

function ThemePage(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.themePage}>
      <ThemeControl />
      <Sentence style={styles.caption}>
        이 기기에서만 적용됩니다. 데스크탑과 웹의 테마는 따로 고릅니다.
      </Sentence>
    </View>
  );
}

function ProfilePage({
  member,
  directory,
  connected,
  onOpenTheme,
  onSignOut,
  onRevealEnd,
}: {
  member: Member;
  directory: Directory;
  connected: boolean;
  onOpenTheme: () => void;
  onSignOut: () => void;
  /** 확인 블록이 열리면 시트를 끝까지 내린다 — 두 버튼이 접힌 곳 아래에 서지 않게. */
  onRevealEnd: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {choice} = useTheme();
  const push = usePushPermission();
  const now = useNow();
  const [confirming, setConfirming] = useState(false);
  const [diagCopied, setDiagCopied] = useState(false);

  // 버전 줄을 길게 누르면 실시간 연결 기록을 복사한다(#2751). 폰 소켓이 왜
  // 끊겼는지는 서버 로그로 판정되지 않았고, 이유 코드는 클라이언트에만 있다.
  // 기록에는 코드·수명·네트워크 종류만 있고 식별 정보는 없다(`diagnostics.ts`).
  // 숨은 동작이라 화면에는 영수증 한 줄만 잠깐 보인다.
  const copyDiagnostics = useCallback(() => {
    const text = `${currentAppVersionLabel()}\n${formatRealtimeDiagnostics()}`;
    void copyText(text).then(ok => {
      if (ok) setDiagCopied(true);
    });
  }, []);
  useEffect(() => {
    if (!diagCopied) return;
    const id = setTimeout(() => setDiagCopied(false), COPY_RECEIPT_MS);
    return () => clearTimeout(id);
  }, [diagCopied]);

  // 375pt 기본 크기에서 확인 블록의 두 버튼이 화면 아래로 나갔다(#2702 캡처) —
  // 「로그아웃」을 누른 사람에게 다음 단계가 보이지 않으면 버튼이 안 먹은 것으로
  // 읽힌다. 블록이 그려진 **뒤에** 내린다.
  useEffect(() => {
    if (confirming) onRevealEnd();
  }, [confirming, onRevealEnd]);

  const self = memberFor(directory, member.id);
  // 명부가 아직 안 왔으면 알약을 그리지 않는다 — 선언을 모르는 채 「온라인」을
  // 말하면 방해 금지를 걸어 둔 사람에게 거짓을 보여 준다.
  const presence: EffectivePresence | null = self
    ? effectivePresence(self.presenceStatus, connected)
    : null;
  const custom = self ? visibleCustomStatus(self, now) : null;
  const customLine = custom
    ? [custom.emoji, custom.text].filter(Boolean).join(' ')
    : null;
  const server = getServerBase();

  return (
    <>
      <View style={styles.hero}>
        <View style={styles.heroRing}>
          <Avatar
            directory={directory}
            memberId={member.id}
            size={HERO_AVATAR}
          />
        </View>
        <View style={styles.heroText}>
          <Text
            accessibilityRole="header"
            style={styles.name}
            numberOfLines={2}
            testID="self-profile-name"
          >
            {member.displayName}
          </Text>
          <Text
            style={styles.handle}
            numberOfLines={1}
            testID="self-profile-handle"
          >
            @{member.handle}
          </Text>
        </View>
        {presence ? (
          <View
            accessible
            accessibilityLabel={`내 상태: ${effectivePresenceLabel(presence)}`}
            style={[styles.pill, pillTone(styles, presence)]}
            testID="self-profile-presence"
          >
            <View style={[styles.pillDot, dotTone(styles, presence)]} />
            <Text style={[styles.pillLabel, pillLabelTone(styles, presence)]}>
              {effectivePresenceLabel(presence)}
            </Text>
          </View>
        ) : null}
        {customLine ? (
          <Sentence
            style={styles.customStatus}
            testID="self-profile-custom-status"
          >
            {customLine}
          </Sentence>
        ) : null}
      </View>

      <GroupSection label="보기">
        <GroupRow
          title="테마"
          value={themeChoiceLabel(choice)}
          chevron
          onPress={onOpenTheme}
          accessibilityLabel={`테마, ${themeChoiceLabel(choice)}`}
          accessibilityHint="시스템·라이트·다크 중에서 고릅니다."
          testID="profile-theme-row"
        />
      </GroupSection>

      <GroupSection label="알림">
        <GroupRow
          title="푸시 알림"
          detail={pushPermissionDetail(push)}
          testID="profile-push-row"
        />
        {push === 'denied' ? (
          <GroupRow
            title="설정에서 알림 켜기"
            tone="accent"
            chevron
            separated
            onPress={() => void Linking.openSettings()}
            accessibilityHint="iOS 설정의 이 앱 화면을 엽니다."
            testID="profile-push-settings"
          />
        ) : null}
      </GroupSection>

      <GroupSection label="연결">
        <GroupRow
          title="서버"
          detail={server ?? '이 기기에 저장된 서버 주소가 없습니다.'}
          testID="profile-server-row"
        />
      </GroupSection>

      <GroupSection label="계정">
        {confirming ? (
          <View style={styles.confirm} testID="sign-out-confirm-block">
            {/* 웹 `ProfileCard` 의 확인 대화상자와 같은 두 문장이다 (리뷰 M5). */}
            <View style={styles.confirmCopy}>
              <Text style={styles.confirmTitle}>로그아웃할까요?</Text>
              <Sentence style={styles.confirmText}>
                로그아웃하면 이 기기에 쓰다 만 초안이 지워집니다.
              </Sentence>
            </View>
            <View style={styles.confirmActions}>
              <Pressable
                accessibilityRole="button"
                onPress={() => setConfirming(false)}
                style={({pressed}) => [
                  styles.confirmButton,
                  pressed && styles.pressed,
                ]}
                testID="sign-out-cancel"
              >
                <Text style={styles.confirmCancelLabel}>취소</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={onSignOut}
                style={({pressed}) => [
                  styles.confirmButton,
                  styles.confirmDanger,
                  pressed && styles.confirmDangerPressed,
                ]}
                testID="sign-out-confirm"
              >
                <Text style={styles.confirmDangerLabel}>로그아웃</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <GroupRow
            title="로그아웃"
            tone="danger"
            onPress={() => setConfirming(true)}
            testID="sign-out"
          />
        )}
      </GroupSection>

      <Text
        style={styles.version}
        testID="profile-version"
        onLongPress={copyDiagnostics}
        accessibilityHint="길게 누르면 연결 기록을 복사합니다">
        {diagCopied ? '연결 기록을 복사했습니다' : currentAppVersionLabel()}
      </Text>
    </>
  );
}

/** 시트의 큰 얼굴. 머리 버튼(`AVATAR_SIZE` 32)의 두 배 반. */
const HERO_AVATAR = 80;

type Styles = ReturnType<typeof buildStyles>;

function pillTone(styles: Styles, presence: EffectivePresence) {
  switch (presence) {
    case 'online':
      return styles.pillOk;
    case 'away':
      return styles.pillWarn;
    case 'dnd':
      return styles.pillDanger;
    case 'offline':
      return styles.pillMuted;
  }
}

function pillLabelTone(styles: Styles, presence: EffectivePresence) {
  switch (presence) {
    case 'online':
      return styles.pillLabelOk;
    case 'away':
      return styles.pillLabelWarn;
    case 'dnd':
      return styles.pillLabelDanger;
    case 'offline':
      return styles.pillLabelMuted;
  }
}

function dotTone(styles: Styles, presence: EffectivePresence) {
  switch (presence) {
    case 'online':
      return styles.dotOk;
    case 'away':
      return styles.dotWarn;
    case 'dnd':
      return styles.dotDanger;
    case 'offline':
      return styles.dotMuted;
  }
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // 바탕은 시트가 칠한다(`sheet`). 여기서 칠하면 반경 30 의 모서리를 네모로 덮는다.
    root: {flex: 1},
    nav: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: TOUCH_TARGET + space.md,
      paddingHorizontal: space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: color.border,
    },
    // 양옆 칸의 폭이 같아야 제목이 가운데에 선다.
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
    hero: {
      alignItems: 'center',
      gap: space.md,
      paddingHorizontal: SAFE_GUTTER,
    },
    // 사진 없는 이니셜 얼굴은 `surface` 채움이라 바탕 위에서 1.07:1 이다(리뷰 M1).
    // 3:1 을 넘는 한 줄(`textFaint`, 웹 `--line-strong`)로 가장자리를 준다.
    heroRing: {
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: color.textFaint,
    },
    heroText: {alignItems: 'center', gap: space.xs},
    name: {
      fontSize: font.title,
      fontWeight: '700',
      color: color.text,
      textAlign: 'center',
    },
    handle: {fontSize: font.label, color: color.textMuted},
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingHorizontal: space.md,
      paddingVertical: space.xs,
      borderRadius: radius.pill,
    },
    // 테두리가 없다 (리뷰 M2) — 작은 테두리 알약은 이 팔레트에서 **컨트롤** 문법이고
    // (디자인 시스템 §2.2), 이 알약은 누를 수 없다. 채움만으로 상태를 말한다.
    pillOk: {backgroundColor: color.okSurface},
    pillWarn: {backgroundColor: color.warnSurface},
    pillDanger: {backgroundColor: color.dangerSurface},
    pillMuted: {backgroundColor: color.surface},
    pillDot: {width: space.sm, height: space.sm, borderRadius: radius.pill},
    dotOk: {backgroundColor: color.ok},
    dotWarn: {backgroundColor: color.warn},
    dotDanger: {backgroundColor: color.danger},
    dotMuted: {backgroundColor: color.textFaint},
    pillLabel: {fontSize: font.label, fontWeight: '600'},
    pillLabelOk: {color: color.ok},
    pillLabelWarn: {color: color.warn},
    pillLabelDanger: {color: color.dangerText},
    pillLabelMuted: {color: color.textMuted},
    customStatus: {
      fontSize: font.label,
      color: color.textMuted,
      textAlign: 'center',
    },
    themePage: {paddingHorizontal: SAFE_GUTTER, gap: space.sm},
    caption: {
      fontSize: font.label,
      color: color.textMuted,
      lineHeight: 18,
      paddingHorizontal: space.xs,
    },
    confirm: {padding: space.lg, gap: space.md},
    confirmCopy: {gap: space.xs},
    confirmTitle: {fontSize: font.body, color: color.text, fontWeight: '600'},
    confirmText: {
      fontSize: font.label,
      color: color.textMuted,
      lineHeight: 18,
    },
    confirmActions: {flexDirection: 'row', gap: space.sm},
    confirmButton: {
      flex: 1,
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: space.sm,
      borderRadius: radius.sm,
      borderWidth: 1,
      // 채움도 강조도 없는 버튼이라 테두리가 「여기가 버튼이다」의 전부다 — 3:1 을
      // 넘는 `textFaint`(웹 `--line-strong` 자리)를 쓴다 (#1155 · 리뷰 M-1 의 규칙).
      borderColor: color.textFaint,
    },
    confirmCancelLabel: {fontSize: font.body, color: color.text},
    // 파괴 확인은 채움으로 선다 — 이 시트에서 되돌릴 수 없는 유일한 행동이다.
    confirmDanger: {
      backgroundColor: color.dangerFill,
      borderColor: color.dangerFill,
    },
    confirmDangerPressed: {opacity: 0.85},
    confirmDangerLabel: {
      fontSize: font.body,
      color: color.onDangerFill,
      fontWeight: '600',
    },
    // `textMuted` — `textFaint` 는 선 토큰이라 글자로는 AA 아래다 (리뷰 M3). 버그
    // 신고에 옮겨 적히는 줄이다.
    version: {
      fontSize: font.meta,
      color: color.textMuted,
      textAlign: 'center',
    },
  });
