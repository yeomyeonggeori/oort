import {QueryClientProvider} from '@tanstack/react-query';
import React, {useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, StatusBar, StyleSheet, Text, View} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {color, font, space} from './src/design/tokens';
import {createQueryClient, installReactQueryBridges} from './src/query/queryClient';
import ConnectScreen from './src/screens/ConnectScreen';
import {useAuthGate} from './src/session/useSession';
import AppShell from './src/shell/AppShell';
import {initSessionStore} from './src/storage/secureSession';

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
  const queryClient = useMemo(() => createQueryClient(), []);
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    const teardown = installReactQueryBridges();
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
      <StatusBar barStyle="light-content" backgroundColor={color.bg} />
      <QueryClientProvider client={queryClient}>
        {booted ? <Gate /> : <Booting testID="booting" />}
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

function Gate(): React.JSX.Element {
  const gate = useAuthGate();
  if (gate.kind === 'restoring') {
    return <Booting label="로그인 상태를 확인하는 중입니다." testID="session-restoring" />;
  }
  if (gate.kind === 'signedOut') {
    return <ConnectScreen sessionExpired={gate.expired} />;
  }
  return <AppShell member={gate.member} />;
}

function Booting({
  label,
  testID,
}: {
  label?: string;
  testID?: string;
}): React.JSX.Element {
  return (
    <View style={styles.booting} testID={testID}>
      <ActivityIndicator color={color.accentText} />
      {label ? <Text style={styles.bootingLabel}>{label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  booting: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    backgroundColor: color.bg,
  },
  bootingLabel: {fontSize: font.label, color: color.textMuted},
});
