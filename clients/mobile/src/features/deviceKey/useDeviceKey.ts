import {listDeviceKeys} from '@momo/core/features/auth/deviceKeys';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useEffect} from 'react';

import {
  deriveDeviceKeyView,
  EnrollError,
  enrollDeviceKey,
  readLocalDeviceKey,
  replaceInvalidatedKey,
  type DeviceKeyView,
} from '../../deviceKey/enrollment';
import {deviceLinkDevice} from '../deviceLink/deviceIdentity';
import {lastConnectRoute} from '../onboarding/phoneFlow';

// =============================================================================
// The 「지시 기기」 state as the screens read it (#3026 stage 2).
//
// Two sources, one view (`deriveDeviceKeyView`):
//   - the enclave (status + public key) — re-read whenever the app comes back to
//     the foreground, because Face ID is changed in iOS Settings, not here;
//   - the server's key list — the web's cache key
//     (`clients/web/src/features/settings/deviceKeysShared.ts`), polled while
//     the Mac's approval is pending so 「승인 대기」 turns into 「승인됨」 without a
//     pull.
// =============================================================================

export const DEVICE_KEY_LOCAL_QUERY_KEY = ['device-key', 'local'] as const;
export const DEVICE_KEYS_QUERY_KEY = (workspaceId: string) =>
  ['settings', 'device-keys', workspaceId] as const;

/** While the Mac's approval is pending, how often the list is re-read. */
export const APPROVAL_POLL_MS = 10_000;

/** Rows this app already tried to move on its own (#3103): one Face ID
 *  prompt per row per app run. A cancelled prompt settles the queries, which
 *  would otherwise ask again and again; after the first, it is the button. */
const autoReconnectTried = new Set<string>();

/** Test seam. */
export function resetAutoReconnectForTests(): void {
  autoReconnectTried.clear();
}

export interface DeviceKeyState {
  view: DeviceKeyView;
  /** Register (or re-register a revoked/unregistered key). */
  enroll: () => void;
  /** 「새 키로 다시 등록」 — only meaningful for `invalidated`. */
  replace: () => void;
  /** Re-read both sources. */
  refresh: () => void;
  busy: boolean;
  /** The last action's failure sentence, or null. */
  failure: string | null;
}

export function useDeviceKey(
  workspaceId: string,
  {
    poll = true,
    autoReconnect = false,
  }: {
    poll?: boolean;
    /** 「다시 연결 필요」 moves the key once on its own (Face ID still asks). */
    autoReconnect?: boolean;
  } = {},
): DeviceKeyState {
  const client = useQueryClient();
  const local = useQuery({
    queryKey: DEVICE_KEY_LOCAL_QUERY_KEY,
    queryFn: readLocalDeviceKey,
    staleTime: 0,
    retry: false,
  });
  const hasKey = local.data?.publicKey != null;
  const rows = useQuery({
    queryKey: DEVICE_KEYS_QUERY_KEY(workspaceId),
    queryFn: () => listDeviceKeys(workspaceId),
    enabled: hasKey,
    refetchInterval: query => {
      if (!poll || !local.data?.publicKey) return false;
      const pending = query.state.data?.some(
        row =>
          row.publicKey === local.data?.publicKey && row.state === 'unendorsed',
      );
      return pending ? APPROVAL_POLL_MS : false;
    },
  });

  const settle = () => {
    void client.invalidateQueries({queryKey: DEVICE_KEY_LOCAL_QUERY_KEY});
    void client.invalidateQueries({queryKey: DEVICE_KEYS_QUERY_KEY(workspaceId)});
  };
  const label = deviceLinkDevice().name;
  const enroll = useMutation({
    mutationFn: () => enrollDeviceKey({workspaceId, label}),
    onSettled: settle,
  });
  const replace = useMutation({
    mutationFn: () => replaceInvalidatedKey({workspaceId, label}),
    onSettled: settle,
  });

  // #3129: an address login (or an invite) this run, or the server's word on
  // the last try — this sign-in is not a QR link and cannot register a key.
  const route = lastConnectRoute();
  const signInUnlinked =
    route === 'signIn' ||
    route === 'join' ||
    (enroll.error instanceof EnrollError && enroll.error.unlinked);
  const view = deriveDeviceKeyView({
    local: local.data,
    localError: local.error,
    rows: hasKey ? rows.data : undefined,
    // A failed background re-read (the approval poll) keeps the last list the
    // server gave: 「불러오지 못했습니다」 is for when there is nothing to show.
    rowsError: hasKey && rows.data === undefined ? rows.error : null,
    signInUnlinked,
  });
  const reconnectId =
    autoReconnect && view.kind === 'reconnect' && !view.biometryOff ? view.row.id : null;
  const enrollMutate = enroll.mutate;
  const enrollBusy = enroll.isPending;
  useEffect(() => {
    if (reconnectId === null || enrollBusy || autoReconnectTried.has(reconnectId)) return;
    autoReconnectTried.add(reconnectId);
    enrollMutate();
  }, [reconnectId, enrollBusy, enrollMutate]);
  const last = replace.submittedAt > enroll.submittedAt ? replace : enroll;
  // The 「QR 연결 필요」 panel already says what the refusal said.
  const saidByView = last.error instanceof EnrollError && last.error.unlinked;
  const failure = saidByView
    ? null
    : last.error instanceof Error
      ? last.error.message
      : last.error
        ? String(last.error)
        : null;

  return {
    view,
    enroll: () => enroll.mutate(),
    replace: () => replace.mutate(),
    refresh: settle,
    busy: enroll.isPending || replace.isPending,
    failure,
  };
}
