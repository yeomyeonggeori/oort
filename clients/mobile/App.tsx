import {QueryClientProvider} from '@tanstack/react-query';
import React, {useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, StatusBar, StyleSheet, View} from 'react-native';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {createQueryClient, installReactQueryBridges} from './src/query/queryClient';
import ConnectScreen from './src/screens/ConnectScreen';
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
      <StatusBar barStyle="light-content" backgroundColor="#0f1115" />
      <QueryClientProvider client={queryClient}>
        {booted ? (
          <ConnectScreen />
        ) : (
          <View style={styles.booting} testID="booting">
            <ActivityIndicator color="#6fa8dc" />
          </View>
        )}
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  booting: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0f1115',
  },
});
