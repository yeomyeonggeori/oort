import type {ReadState} from '@momo/core/lib/api';
import {setBadgeCountAsync} from 'expo-notifications';
import {useEffect, useRef} from 'react';
import {AppState, type AppStateStatus} from 'react-native';

import {useReadStates} from '../features/workspace/queries';

// =============================================================================
// The app icon badge (#2670, ADR-0109).
//
// The relay stamps a number on every push: the server's unread projection
// summed over every live membership (`unread_badge`, momo-push judgment.rs).
// Until this file nothing ever took it down again. The app never touched the
// badge, so the icon kept the last push's number however much the person had
// read since. Measured on a Release simulator: push badge 5 → read #배포
// (server 2) → read #로그 (server 0) → 35 s later the icon still said
// 「5개의 새로운 항목」.
//
// ## Which number: the server's, by construction
//
// `GET /read-state` answers each channel's `unread_count` with the same SQL the
// badge sums — `GREATEST(last_seq − last_read_seq, 0)` over the same joins
// (momo-messaging read_state.rs `list_read_state`) — and this client never
// patches that projection locally (`useReadStates`). So the sum of the wire
// `unreadCount` IS the number the next push will carry.
//
// It is deliberately NOT the sidebar's number. The sidebar composes ADR-0178's
// 「여기부터 안 읽음」 mark into each row (`composedUnreadCount`); the server
// badge does not fold it. Putting the composed sum on the icon would make it
// disagree with the next push, and the badge would jump between the two
// definitions every time one arrived. Where the two differ the icon follows the
// server (#2670): a desktop mark shows as 8 on the row and 0 on the icon.
//
// ## When it is written
//
// - Every time a read-state answer lands, not only when the sum changes. The
//   icon is not ours alone: a push that arrived while the app was away wrote
//   its own number, and writing the server's fresh number again is how the icon
//   comes back to it. A write-on-change would leave the push's number standing
//   whenever the sum happened to be the same.
// - Never before the first answer. A cold start opened by a push already shows
//   the push's number, which is true; a write from nothing would replace it with
//   a guess.
// - On a return from the background the projection is asked for again first.
//   The query does not refetch on focus (queryClient.ts: a banner alone cycles
//   focus), and the cached sum can be older than the push that moved the icon.
//   Only a real return counts: `inactive` (a banner, the notification centre) is
//   not being away — the same line `realtime/backgroundPolicy.ts` draws.
// - 0 is a write, not a skip. `setBadgeCountAsync(0)` is what clears the badge.
// - On sign-out, 0. This hook unmounts with the signed-in tree (PushProvider §5
//   says why that is sign-out), and the icon must not keep the previous
//   member's count.
//
// Writes are chained so they reach the native side in the order they were made.
// The native call is an async function that first awaits the notification
// settings, so two quick writes (a read landing, then sign-out) could otherwise
// finish in the wrong order. A failed write is dropped; the next answer writes
// again.
// =============================================================================

/** The ADR-0109 badge, from the read-state projection the app already holds. */
export function serverBadgeCount(readStates: readonly ReadState[]): number {
  return readStates.reduce((total, state) => total + Math.max(0, state.unreadCount), 0);
}

let lastWrite: Promise<unknown> = Promise.resolve();

function writeBadge(count: number): void {
  lastWrite = lastWrite.then(() => setBadgeCountAsync(count)).catch(() => undefined);
}

/** Keep the icon on the server's unread total while this member is signed in. */
export function useAppIconBadge(workspaceId: string): void {
  const {data, dataUpdatedAt, refetch} = useReadStates(workspaceId);
  const count = data === undefined ? null : serverBadgeCount(data);

  // `dataUpdatedAt` is a dependency on purpose: one write per landed answer.
  useEffect(() => {
    if (count !== null) writeBadge(count);
  }, [count, dataUpdatedAt]);

  const away = useRef(false);
  useEffect(() => {
    const onChange = (next: AppStateStatus) => {
      if (next === 'background') {
        away.current = true;
      } else if (next === 'active' && away.current) {
        away.current = false;
        void refetch();
      }
    };
    const subscription = AppState.addEventListener('change', onChange);
    return () => subscription.remove();
  }, [refetch]);

  useEffect(() => () => writeBadge(0), []);
}
