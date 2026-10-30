import {QueryClientProvider} from '@tanstack/react-query';
import React, {useEffect, useMemo, useState} from 'react';
import {StatusBar, StyleSheet, Text, View} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {bootSpawnPort} from './src/boot/spawnPort';
import {PrimaryButton} from './src/design/atoms';
import {OortLoader} from './src/design/brand/OortLoader';
import {font, SAFE_GUTTER, space, type Palette} from './src/design/tokens';
import {useRetainReduceMotion} from './src/lib/useReduceMotion';
import {BrandAppearance, ThemeProvider, usePalette, useStyles, useTheme} from './src/design/theme';
import {createQueryClient, installReactQueryBridges} from './src/query/queryClient';
import ConnectScreen from './src/screens/ConnectScreen';
import {RESTORE_UNREACHABLE_NOTICE} from './src/session/authGate';
import {useAuthGate} from './src/session/useSession';
import AppShell from './src/shell/AppShell';
import {initSessionStore} from './src/storage/secureSession';
import {MobileLocaleProvider} from './src/i18n/LocaleProvider';

// =============================================================================
// The app tree.
//
// Boot has one ordering rule and it is the same one the web client has: the
// keychain must answer BEFORE the first screen is chosen. `SessionPort` is
// synchronous because `@momo/core/lib/api.ts` reads the token inline on every
// request, but the keychain is not, so the gap is closed once at startup rather
// than papered over with a token that is null for the first few frames.
//
// Rendering the connect screen while that read is in flight would put a signed-in
// person in front of a sign-in form and leave them there, because nothing
// re-decides afterwards. So this shows nothing until it settles — which is
// honest, and on the order of milliseconds.
//
// `index.js` has already installed the URL polyfill and the core host by the
// time this module is evaluated; see the comment there.
//
// ## Two gates, not one (goal RN-C3)
//
// `initSessionStore()` answers "what was on this device". `useAuthGate()` answers
// "can this device talk to the server right now" — which is a second question,
// because the access token is memory-only by design and a resumed session has to
// spend one refresh rotation to get one. Collapsing the two would either show a
// sign-in form to someone who is signed in, or a shell whose every request 401s.
// The decision itself is a pure function in `src/session/authGate.ts`, tested
// there; this file only renders its three answers.
// =============================================================================

export default function App(): React.JSX.Element {
  // `ThemeProvider` 가 제일 바깥이다 (U2). 이 트리에서 색을 쓰는 첫 번째 것이
  // 부팅 화면이고, 그것도 사람이 고른 스킴으로 나와야 한다 — 프로바이더가
  // `Gate` 아래 있으면 앱을 열 때마다 다크 한 프레임이 먼저 지나간다.
  return (
    <ThemeProvider>
      <MobileLocaleProvider>
        <AppChrome />
      </MobileLocaleProvider>
    </ThemeProvider>
  );
}

function AppChrome(): React.JSX.Element {
  const palette = usePalette();
  const {scheme} = useTheme();
  const queryClient = useMemo(() => createQueryClient(), []);
  const [booted, setBooted] = useState(false);

  // 「동작 줄이기」를 앱이 시작할 때 한 번 읽어 앱이 사는 동안 간직한다(#4293 M-1). 새로 서는 화면(사진
  // 뷰어 Modal 은 첫 렌더의 값으로 이미 떠 버린다)이 모르는 채로 시작하지 않는다.
  useRetainReduceMotion();

  useEffect(() => {
    const teardown = installReactQueryBridges();
    bootSpawnPort();
    let cancelled = false;
    initSessionStore().finally(() => {
      if (!cancelled) {
        setBooted(true);
      }
    });
    return () => {
      cancelled = true;
      teardown();
    };
  }, []);

  return (
    <SafeAreaProvider>
      {/* 상태바 글자는 배경의 반대다 (U2). 값을 「light-content」로 박아 두면
          라이트 스킴에서 종이 위에 흰 글자가 서고, 시계와 배터리가 사라진다. */}
      <StatusBar
        barStyle={scheme === 'light' ? 'dark-content' : 'light-content'}
        backgroundColor={palette.bg}
      />
      <QueryClientProvider client={queryClient}>
        {booted ? <Gate /> : <Booting testID="booting" />}
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

function Gate(): React.JSX.Element {
  const {gate, retry} = useAuthGate();
  if (gate.kind === 'restoring') {
    // A stored session whose rotation could not reach the server is still a
    // session. Saying so — and offering the retry — is the honest screen; a
    // sign-in form here would be this client throwing away a session because a
    // train went into a tunnel.
    return gate.unreachable ? (
      <Booting
        label={RESTORE_UNREACHABLE_NOTICE}
        onRetry={retry}
        testID="session-unreachable"
      />
    ) : (
      <Booting label="로그인 상태를 확인하는 중입니다." testID="session-restoring" />
    );
  }
  if (gate.kind === 'signedOut') {
    // 로그인 전 첫 화면은 테마 영향 밖이다(ADR-0174 D4 · #2719): 저장된 흑연·노을띠를
    // 입지 않는다. 스킴(라이트·다크)만 사람의 선택을 따른다.
    return (
      <BrandAppearance>
        <ConnectScreen sessionExpired={gate.expired} />
      </BrandAppearance>
    );
  }
  return <AppShell member={gate.member} />;
}

/** 첫 로딩 화면. 오르트 로더 시험과 캡처 하네스가 직접 그린다(#3961). */
export function Booting({
  label,
  onRetry,
  testID,
}: {
  label?: string;
  onRetry?: () => void;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.booting} testID={testID}>
      {/* 첫 로딩(앱을 열 때, 로그인 상태를 되살릴 때)은 오르트 로더가 돈다(#3961).
          다시 시도 버튼이 서는 자리(서버에 닿지 못함)는 돌 것이 없다. */}
      {onRetry ? null : <OortLoader size={BOOT_LOADER_SIZE} testID="boot-loader" />}
      {label ? <Text style={styles.bootingLabel}>{label}</Text> : null}
      {onRetry ? (
        <View style={styles.bootingAction}>
          <PrimaryButton label="다시 시도" onPress={onRetry} testID="restore-retry" />
        </View>
      ) : null}
    </View>
  );
}

/**
 * 첫 로딩 로더의 한 변(pt). 꼬리 점이 서는 display 마크의 첫 크기(40)보다 한 단 크게. 웹의 첫 로딩 큰 자리
 * (128px, 코메토 둘레)는 폰에 짝이 없다: 폰에는 코메토 큰 자리가 없고 마크 로더만 쓴다.
 */
const BOOT_LOADER_SIZE = 56;

const buildStyles = (color: Palette) => StyleSheet.create({
  booting: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    backgroundColor: color.bg,
  },
  bootingLabel: {
    fontSize: font.label,
    color: color.textMuted,
    textAlign: 'center',
    paddingHorizontal: SAFE_GUTTER,
    lineHeight: 20,
  },
  bootingAction: {alignSelf: 'stretch', paddingHorizontal: SAFE_GUTTER},
});
