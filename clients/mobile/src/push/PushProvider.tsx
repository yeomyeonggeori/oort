import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {AppState, type AppStateStatus} from 'react-native';
import {
  addNotificationResponseReceivedListener,
  clearLastNotificationResponse,
  getLastNotificationResponse,
  type NotificationResponse,
} from 'expo-notifications';

import {useSession} from '../session/useSession';
import {getAccessToken, subscribeSession} from '../storage/secureSession';
import {absoluteApiBase} from '../storage/serverBase';
import {registerPushCategories} from './categories';
import {apnsEnvironment, keychainAccessGroup} from './native';
import {
  askPushPermission,
  fetchApnsToken,
  handlePushResponse,
  readPushGate,
  type PushGate,
} from './notifications';
import {clearPushFetchSession, publishPushFetchSession} from './pushFetchSession';
import {useAppIconBadge} from './appBadge';
import {registerWithRetry} from './registration';
import {tapArrival, tapResponseKey, type TapArrival} from './tapArrival';

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
// still gets a notification — just the relay's placeholder, "oort / 새 알림" —
// so "working" and "silently broken" are visually identical. On the simulator
// these lines are visible through `simctl launch --console-pty` (which is how
// gate:session already runs the app); on a device, through Console.app.
//
// The `[push]` prefix is load-bearing: docs/cicd/11-ios-push-device-check.md
// tells whoever runs the device check to grep for it.
// =============================================================================

const LOG = '[push]';

/**
 * 가장 최근의 본문 탭 (#2569). `token` 은 탭마다 새로 서므로, 받는 쪽은 그것
 * 하나로 「이미 처리했는가」를 판정한다.
 */
export interface PushArrival {
  token: number;
  arrival: TapArrival;
}

const PushArrivalContext = createContext<PushArrival | null>(null);

/**
 * M3 알림 미리 안내가 읽는 자리 (#2820, ADR-0193 D8).
 *
 * `gate`가 `ask`일 때만 M3이 선다. `ask()`는 사람이 누른 버튼(M3 [계속],
 * 설정 › 알림)만 부른다. 프로바이더 밖(측정 하네스)에서는 늘 `settled`다.
 */
export interface PushPrompt {
  gate: PushGate | 'checking';
  ask: () => Promise<void>;
}

const SETTLED_PROMPT: PushPrompt = {gate: 'settled', ask: async () => {}};

const PushPromptContext = createContext<PushPrompt>(SETTLED_PROMPT);

export function usePushPrompt(): PushPrompt {
  return useContext(PushPromptContext);
}

/**
 * 셸이 읽는 자리. 이 프로바이더 밖에서는 언제나 null 이다 — 측정 하네스처럼
 * 알림이 없는 트리에서 부르면 아무 일도 일어나지 않는 것이 맞다.
 */
export function usePushArrival(): PushArrival | null {
  return useContext(PushArrivalContext);
}

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

  // ---- 1. Categories and the standing permission --------------------------
  //
  // ## This provider never ASKS (#2820, ADR-0193 D8)
  //
  // It used to call `requestPermissionsAsync` as soon as the session stood, so
  // the one iOS notification prompt the app ever gets appeared with no word of
  // what it was for. Now it only READS the standing answer. The prompt is raised
  // by a person's tap (M3's [계속], or the profile sheet's 알림 row) through
  // `ask` below, and registration follows whenever the answer is `granted`.
  const [gate, setGate] = useState<PushGate | 'checking'>('checking');

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
      const standing = await readPushGate();
      if (cancelled) return;
      console.log(`${LOG} permission=${standing}`);
      setGate(standing);
    })().catch(cause => {
      console.error(`${LOG} permission read failed`, cause);
      // Unknown is not a reason to hold M3 over the app.
      if (!cancelled) setGate('settled');
    });

    // Someone who turned notifications on in iOS Settings and came back should
    // be registered without signing out and in again.
    const subscription = AppState.addEventListener('change', next => {
      if (next !== 'active') return;
      readPushGate()
        .then(standing => {
          if (cancelled) return;
          // Never re-open M3 on a foreground: `ask` is only what the first read
          // saw. A later read can move toward an answer, not back to a question.
          setGate(current =>
            standing === 'ask' && current !== 'ask' ? current : standing,
          );
        })
        .catch(() => {});
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [workspaceId]);

  const ask = useCallback(async () => {
    try {
      const answer = await askPushPermission();
      console.log(`${LOG} permission asked -> ${answer}`);
      setGate(answer);
    } catch (cause) {
      console.error(`${LOG} permission request failed`, cause);
      setGate('settled');
    }
  }, []);

  const prompt = useMemo<PushPrompt>(() => ({gate, ask}), [gate, ask]);

  // ---- 1b. Token and registration, once the answer is `granted` ------------
  const granted = gate === 'granted';
  useEffect(() => {
    if (!granted) return;
    let cancelled = false;

    (async () => {
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
  }, [workspaceId, granted]);

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

  // ---- 4. Notification actions, and where a body tap goes -----------------
  //
  // ## 본문 탭은 세 길로 온다 (#2569)
  //
  //   백그라운드   앱이 살아 있다. 네이티브가 응답을 내보내고 아래 리스너가 받는다.
  //   포그라운드   같은 리스너다. 알림 센터를 내려 지난 알림을 누른 경우이고, 그때
  //                화면에는 이미 무언가 열려 있다 — 여는 쪽(`openFromNotification`)이
  //                그것을 걷는다.
  //   종료         탭이 앱을 **띄웠다.** 리스너는 세션이 복원된 뒤에야 붙으므로 그
  //                이벤트는 이미 지나갔다. expo 의 `EmitterModule` 이 마지막 응답을
  //                들고 있다(`getLastNotificationResponse`) — 그것만이 그 탭을 본다.
  //                조인 링크의 `getInitialURL()` 과 같은 구멍, 같은 답이다.
  //
  // 리스너를 **먼저** 붙이고 마지막 응답을 읽는다. 반대로 두면 그 사이에 온 탭은
  // 두 길 어디에도 없다. 두 길이 같은 탭을 두 번 들고 오면 `seen` 이 하나로 접는다.
  //
  // 마지막 응답에서는 **본문 탭만** 받는다(`tapArrival` 이 나머지를 null 로
  // 돌린다). 승인·거절·답장은 누른 그 순간의 행동이다 — 로그아웃 뒤 다시
  // 로그인해 이 프로바이더가 새로 붙을 때 잠금 화면의 승인을 되풀이하면 안 된다.
  const [arrival, setArrival] = useState<PushArrival | null>(null);
  const seen = useRef(new Set<string>());
  const nextToken = useRef(0);

  const deliverTap = useCallback(
    (response: NotificationResponse) => {
      const next = tapArrival(response, workspaceId);
      if (next === null) return;
      const key = tapResponseKey(response);
      if (seen.current.has(key)) return;
      seen.current.add(key);
      // 들었으면 비운다. 남겨 두면 로그아웃·재로그인으로 이 트리가 다시 붙을 때
      // 이미 착지한 탭이 한 번 더 온다. 비우지 **못해도** 착지는 한다 — 비우기는
      // 위생이지 이 탭의 조건이 아니다.
      try {
        clearLastNotificationResponse();
      } catch (cause) {
        console.warn(`${LOG} could not clear the last notification response`, cause);
      }
      nextToken.current += 1;
      console.log(
        `${LOG} tap -> ${next.kind === 'target' ? 'open' : next.reason}`,
      );
      setArrival({token: nextToken.current, arrival: next});
    },
    [workspaceId],
  );

  useEffect(() => {
    const subscription = addNotificationResponseReceivedListener(response => {
      deliverTap(response);
      void handlePushResponse(response, {signedInWorkspaceId: workspaceId})
        .then(result => {
          // 원장이 이미 다른 답을 들고 있었으면 그 사실까지 남긴다 (2R H5).
          // 사용자 고지는 아직 없다 — 이 콜백에는 화면이 없다(이탈 보고 참조).
          const detail =
            result.kind === 'decided' && result.record === 'settled'
              ? `settled(recordedApproved=${String(result.recordedApproved)})`
              : result.kind;
          console.log(`${LOG} action ${response.actionIdentifier} -> ${detail}`);
        })
        .catch(cause => console.error(`${LOG} action failed`, cause));
    });

    let launchedBy: NotificationResponse | null = null;
    try {
      launchedBy = getLastNotificationResponse();
    } catch (cause) {
      // 모듈이 없는 빌드에서는 이 길 자체가 없다. 백그라운드·포그라운드 탭은
      // 위 리스너가 여전히 받는다.
      console.warn(`${LOG} last notification response unavailable`, cause);
    }
    if (launchedBy) deliverTap(launchedBy);

    return () => subscription.remove();
  }, [workspaceId, deliverTap]);

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

  // ---- 6. The app icon badge (#2670) ---------------------------------------
  // The relay's number on every push, brought back to the server's unread total
  // whenever a read lands or the app returns — and cleared at 0 and on
  // sign-out. The rules and the one number it may use are in `appBadge.ts`.
  useAppIconBadge(workspaceId);

  return (
    <PushPromptContext.Provider value={prompt}>
      <PushArrivalContext.Provider value={arrival}>
        {children}
      </PushArrivalContext.Provider>
    </PushPromptContext.Provider>
  );
}
