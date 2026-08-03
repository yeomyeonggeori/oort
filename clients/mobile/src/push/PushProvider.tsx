import React, {useEffect, useRef} from 'react';
import {AppState, type AppStateStatus} from 'react-native';
import {addNotificationResponseReceivedListener} from 'expo-notifications';

import {useSession} from '../session/useSession';
import {getAccessToken, subscribeSession} from '../storage/secureSession';
import {absoluteApiBase} from '../storage/serverBase';
import {registerPushCategories} from './categories';
import {apnsEnvironment, keychainAccessGroup} from './native';
import {ensurePushPermission, fetchApnsToken, handlePushResponse} from './notifications';
import {clearPushFetchSession, publishPushFetchSession} from './pushFetchSession';
import {registerWithRetry} from './registration';

// =============================================================================
// The one place push is switched on (goal RN-N1).
//
// Mounted INSIDE SessionProvider, because every step needs a signed-in
// workspace: the registration is per workspace, and the session the extension
// fetches with is this member's.
//
// ## Everything here logs
//
// The 2026-08-02 audit's §4.3 item 4 asks for exactly this and gives the reason:
// the extension fails OPEN. When anything in this chain is wrong the person
// still gets a notification — just the relay's placeholder, "momo / 새 알림" —
// so "working" and "silently broken" are visually identical. On the simulator
// these lines are visible through `simctl launch --console-pty` (which is how
// gate:session already runs the app); on a device, through Console.app.
//
// The `[push]` prefix is load-bearing: docs/cicd/20-ios-push-device-check.md
// tells whoever runs the device check to grep for it.
// =============================================================================

const LOG = '[push]';

export default function PushProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const {workspaceId} = useSession();

  // Held in a ref, not state: nothing renders from these, and re-rendering the
  // whole signed-in tree because a token arrived would be a real cost for no
  // visible change.
  const owesForegroundRetry = useRef(false);
  const usedForegroundRetry = useRef(false);
  const apnsToken = useRef<string | null>(null);

  // ---- 1. Categories, permission, token, registration ---------------------
  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Categories FIRST. iOS matches a payload's `aps.category` against what is
      // registered at delivery time, so a notification that lands before this
      // resolves shows with no action buttons and cannot be fixed after the
      // fact.
      try {
        await registerPushCategories();
      } catch (cause) {
        console.warn(`${LOG} category registration failed`, cause);
      }
      if (cancelled) return;

      const permission = await ensurePushPermission();
      console.log(`${LOG} permission=${permission}`);
      if (permission !== 'granted' || cancelled) return;

      const env = apnsEnvironment();
      if (!env) {
        // Deliberately fatal for registration rather than guessed. See
        // native.ts: guessing from `__DEV__` is how a production token gets
        // registered as sandbox and every push is dropped with no error.
        console.error(
          `${LOG} MomoAPNSEnvironment missing or unexpanded — refusing to register`,
        );
        return;
      }

      const token = await fetchApnsToken();
      if (!token || cancelled) {
        console.error(`${LOG} no APNs token returned`);
        return;
      }
      apnsToken.current = token;
      console.log(`${LOG} apns token …${token.slice(-8)} env=${env}`);

      const result = await registerWithRetry({
        workspaceId,
        apnsToken: token,
        env,
        appBuild: null,
      });
      owesForegroundRetry.current = result.owesForegroundRetry;
      console.log(
        `${LOG} device registration ${result.outcome.kind} after ${result.attempts} attempt(s)`,
      );
    })().catch(cause => console.error(`${LOG} setup failed`, cause));

    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // ---- 2. Keep the extension's session fresh ------------------------------
  useEffect(() => {
    const publish = () => {
      const accessToken = getAccessToken();
      if (!accessToken) return;
      void publishPushFetchSession({
        baseUrl: absoluteApiBase(),
        workspaceId,
        accessToken,
      }).then(outcome => {
        if (outcome.kind === 'published') return;
        // Loud, because from here on every notification shows the placeholder
        // and nothing else reports it.
        console.error(
          `${LOG} extension session NOT published (${outcome.kind}) — notifications will stay as placeholders`,
          outcome.kind === 'failed' ? outcome.reason : keychainAccessGroup(),
        );
      });
    };

    publish();
    // The access token rotates roughly every 15 minutes. A stale copy makes the
    // extension's fetch 401, which it cannot distinguish from an empty message
    // and reports as the same placeholder.
    return subscribeSession(publish);
  }, [workspaceId]);

  // ---- 3. The one foreground retry ----------------------------------------
  useEffect(() => {
    const onChange = (next: AppStateStatus) => {
      if (next !== 'active') return;
      if (!owesForegroundRetry.current || usedForegroundRetry.current) return;
      const token = apnsToken.current;
      const env = apnsEnvironment();
      if (!token || !env) return;

      usedForegroundRetry.current = true;
      owesForegroundRetry.current = false;
      void registerWithRetry({
        workspaceId,
        apnsToken: token,
        env,
        appBuild: null,
      }).then(result =>
        console.log(`${LOG} foreground retry ${result.outcome.kind}`),
      );
    };

    const subscription = AppState.addEventListener('change', onChange);
    return () => subscription.remove();
  }, [workspaceId]);

  // ---- 4. Notification actions --------------------------------------------
  useEffect(() => {
    const subscription = addNotificationResponseReceivedListener(response => {
      void handlePushResponse(response, {signedInWorkspaceId: workspaceId})
        .then(result =>
          console.log(
            `${LOG} action ${response.actionIdentifier} -> ${result.kind}`,
          ),
        )
        .catch(cause => console.error(`${LOG} action failed`, cause));
    });
    return () => subscription.remove();
  }, [workspaceId]);

  // ---- 5. Sign-out ---------------------------------------------------------
  useEffect(
    () => () => {
      // Runs when the signed-in tree unmounts. Without it a signed-out phone
      // keeps resolving notification bodies with the previous member's token
      // until the server revokes it — the extension never hears about sign-out.
      void clearPushFetchSession();
    },
    [],
  );

  return <>{children}</>;
}
