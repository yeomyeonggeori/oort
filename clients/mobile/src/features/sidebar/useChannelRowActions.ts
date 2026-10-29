import {
  closeDm,
  removeChannelMember,
  setChannelNotificationPref,
  uuidEq,
  type Channel,
} from '@momo/core/lib/api';
import type {ChannelActionKey} from '@momo/core/features/channels/actionModel';
import {
  CHANNEL_COPY_FAILURE,
  CHANNEL_MARK_READ_FAILURE,
  CHANNEL_MARK_UNREAD_FAILURE,
  CHANNEL_MUTE_FAILURE,
  DM_CLOSE_FAILURE,
  channelLeaveFailureMessage,
} from '@momo/core/features/channels/model';
import {channelShareUrlFromServerBase} from '@momo/core/features/channels/shareLink';
import {useQueryClient} from '@tanstack/react-query';
import {useCallback, useEffect, useRef, useState} from 'react';
import {AccessibilityInfo} from 'react-native';
import {copyText, COPY_RECEIPT_MS} from '../conversation/copy';
import {useMarkRead} from '../inbox/useInbox';
import {applyClosureToReadStates, workspaceKeys} from '../workspace/queries';
import {haptics} from '../../lib/haptics';
import {apiBase} from '../../storage/serverBase';
import {
  NOTHING_COPIED,
  PHONE_CHANNEL_ACTION_KEYS,
  type ChannelRowCopied,
  type ChannelRowTarget,
} from './channelRowActions';

// =============================================================================
// 길게 누른 행의 시트가 **누르면 무슨 일이 일어나는가** (#4229).
//
// 웹 `channelActions.tsx`(`useChannelActions`)의 폰판이다. 무엇을 그리는가는
// `channelRowActions.ts` + 코어 표가 정하고, 여기는 실행만 한다. 왕복이 돌려 주는
// 실패 문장은 전부 코어 상수다(웹과 같은 말).
//
// 표면이 하나라 훅이 **대상을 인자로** 받는다: 행마다 훅을 두면 수십 줄이 각자 상태를 든다.
// 시트는 화면에 하나이고(`active`), VoiceOver 로터는 시트를 열지 않고 같은 `run` 을 부른다.
//
// ## 낙관 갱신이 없다
//
// 알림 끄기·읽음·안 읽음·나가기는 전부 서버가 답한 **뒤에** 캐시를 건드린다. 웹 `leaveMutation`
// 머리말이 적은 이유가 그대로다: 시트를 이고 있는 행이 낙관 편집으로 언마운트되면 「나가는 중」과
// 실패 문장이 화면에 도달하지 못한다.
// =============================================================================

/**
 * 시트를 연 손짓. 행을 **길게 누르기**는 「잡혔다」는 무거운 한 번(`medium`)이고, 단추 **탭**(대화 머리의 ⋮, #4319)은 + 메뉴·AI
 * 시트처럼 시트가 열리는 누름에 가벼운 한 번(`light`)이다 — 탭에 길게 누르기의 진동을 주지 않는다.
 */
export type RowActionsOpenGesture = 'longPress' | 'tap';

export interface ChannelRowActions {
  /** 시트가 열려 있는 행. 없으면 시트가 없다. */
  active: ChannelRowTarget | null;
  /** 나가기 확인 단계가 열려 있는가. */
  confirmingLeave: boolean;
  copied: ChannelRowCopied;
  isPending: (key: ChannelActionKey) => boolean;
  /** 항목 자리에서 하는 말. 토스트가 아니다. */
  error: string | null;
  leave: {pending: boolean; error: string | null};
  /** `gesture` 를 생략하면 길게 누르기다(사이드바 행이 그대로 `onOpenActions={open}` 으로 넘긴다). */
  open: (target: ChannelRowTarget, gesture?: RowActionsOpenGesture) => void;
  close: () => void;
  run: (target: ChannelRowTarget, key: ChannelActionKey) => void;
  confirmLeave: () => void;
  cancelLeave: () => void;
}

function announce(message: string): void {
  try {
    AccessibilityInfo.announceForAccessibility(message);
  } catch {
    /* 낭독은 덤이다 — 실패해도 일은 이미 끝났다 */
  }
}

export function useChannelRowActions(
  workspaceId: string,
  selfMemberId: string,
  /** 채널을 나간 뒤·DM 을 닫은 뒤(서버가 답한 뒤)에 부른다. 열려 있던 대화를 걷는 일은 부르는 쪽(셸)이 한다. */
  onLeft?: (channelId: string) => void,
): ChannelRowActions {
  const client = useQueryClient();
  const markRead = useMarkRead();
  const [active, setActive] = useState<ChannelRowTarget | null>(null);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [copied, setCopied] = useState<ChannelRowCopied>(NOTHING_COPIED);
  const [pending, setPending] = useState<ReadonlySet<ChannelActionKey>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [leavePending, setLeavePending] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const receiptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
      if (receiptTimer.current !== null) clearTimeout(receiptTimer.current);
    },
    [],
  );

  const reset = useCallback(() => {
    if (receiptTimer.current !== null) {
      clearTimeout(receiptTimer.current);
      receiptTimer.current = null;
    }
    setConfirmingLeave(false);
    setCopied(NOTHING_COPIED);
    setError(null);
    setLeaveError(null);
  }, []);

  const open = useCallback(
    (target: ChannelRowTarget, gesture: RowActionsOpenGesture = 'longPress') => {
      reset();
      if (gesture === 'tap') haptics.light();
      else haptics.medium();
      setActive(target);
    },
    [reset],
  );

  const close = useCallback(() => {
    reset();
    setActive(null);
  }, [reset]);

  const succeeded = useCallback(
    (message: string) => {
      haptics.success();
      announce(message);
      close();
    },
    [close],
  );

  const failed = useCallback((target: ChannelRowTarget, message: string) => {
    haptics.error();
    announce(message);
    // 로터로 시트 없이 눌렀어도 실패는 말해야 한다 — 시트를 열어 그 안에서 읽게 한다.
    setActive(target);
    setError(message);
  }, []);

  const track = useCallback(
    async (
      key: ChannelActionKey,
      target: ChannelRowTarget,
      failure: string,
      work: () => Promise<void>,
      doneMessage: string,
    ) => {
      setPending(previous => new Set(previous).add(key));
      try {
        await work();
        if (mounted.current) succeeded(doneMessage);
      } catch {
        if (mounted.current) failed(target, failure);
      } finally {
        if (mounted.current) {
          setPending(previous => {
            const next = new Set(previous);
            next.delete(key);
            return next;
          });
        }
      }
    },
    [succeeded, failed],
  );

  const flashCopied = useCallback(
    (which: keyof ChannelRowCopied, target: ChannelRowTarget) => {
      haptics.success();
      setActive(target);
      setError(null);
      setCopied({...NOTHING_COPIED, [which]: true});
      if (receiptTimer.current !== null) clearTimeout(receiptTimer.current);
      // 영수증(「복사됨」)이 한 번 읽힌 뒤 시트를 거둔다.
      receiptTimer.current = setTimeout(() => {
        if (mounted.current) close();
      }, COPY_RECEIPT_MS);
    },
    [close],
  );

  const run = useCallback(
    (target: ChannelRowTarget, key: ChannelActionKey) => {
      if (!PHONE_CHANNEL_ACTION_KEYS.has(key)) return;
      const channel: Pick<Channel, 'id'> = target.channel;
      switch (key) {
        case 'copy-name':
        case 'copy-id':
        case 'copy-link': {
          const text =
            key === 'copy-name'
              ? target.title
              : key === 'copy-id'
                ? channel.id
                : channelShareUrlFromServerBase(apiBase(), channel.id);
          const which = key === 'copy-name' ? 'name' : key === 'copy-id' ? 'id' : 'link';
          if (text === null) {
            failed(target, CHANNEL_COPY_FAILURE);
            return;
          }
          void copyText(text).then(ok => {
            if (!mounted.current) return;
            if (ok) flashCopied(which, target);
            else failed(target, CHANNEL_COPY_FAILURE);
          });
          return;
        }
        case 'mark-read': {
          const state = target.readState;
          if (state === null) return;
          void track(
            key,
            target,
            CHANNEL_MARK_READ_FAILURE,
            () => markRead(channel.id, state.latestSeq, 'mark_read_menu'),
            '읽음으로 처리했습니다.',
          );
          return;
        }
        case 'mark-unread': {
          const state = target.readState;
          if (state === null) return;
          void track(
            key,
            target,
            CHANNEL_MARK_UNREAD_FAILURE,
            // 읽음 커서는 그대로 광고하고 마크만 최신 seq 에 건다. 사유 `mark_unread` 는 explicit_open 을
            // 싣지 않는다 — 실으면 마크를 건 같은 트랜잭션이 마크를 지운다(`advertise.ts`).
            () =>
              markRead(channel.id, state.lastReadSeq, 'mark_unread', {
                markUnreadBeforeSeq: state.latestSeq,
              }),
            '읽지 않음으로 표시했습니다.',
          );
          return;
        }
        case 'mute': {
          const next = !target.muted;
          void track(
            key,
            target,
            CHANNEL_MUTE_FAILURE,
            async () => {
              await setChannelNotificationPref(workspaceId, channel.id, next);
              // 서버가 진실이다: 무효화하면 새 muted 가 흘러 내려와 행이 같은 말을 한다.
              await client.invalidateQueries({
                queryKey: workspaceKeys.channels(workspaceId),
              });
            },
            next ? '알림을 껐습니다.' : '알림을 켰습니다.',
          );
          return;
        }
        case 'close-dm': {
          const state = target.readState;
          if (state === null || target.closeOffered !== true) return;
          // `seenSeq` 는 화면이 본 마지막 seq(투영의 `latestSeq`)다. 서버가 채널 head 로 누르고, 같은 호출의 재전송은 결과가 같다.
          const seenSeq = state.latestSeq;
          void track(
            key,
            target,
            DM_CLOSE_FAILURE,
            async () => {
              await closeDm(workspaceId, channel.id, seenSeq);
              // 서버가 답한 **뒤에** 이 기기의 투영 행에 적는다(낙관 갱신 없음, 머리말). 다른 기기는 다음 투영에서 맞춘다.
              applyClosureToReadStates(client, workspaceId, channel.id, seenSeq);
              void client.invalidateQueries({queryKey: workspaceKeys.readState(workspaceId)});
              // 지금 보던 대화였으면 걷는다(웹 `closeDmRow` 의 착지와 같다). 셸이 열린 대화인지 본다.
              onLeft?.(channel.id);
            },
            '대화를 닫았습니다.',
          );
          return;
        }
        case 'leave': {
          // 확인 단계로 간다. 나가기는 되돌릴 길이 없다(다시 들어오려면 관리자가 추가해야 한다).
          reset();
          haptics.warning();
          setActive(target);
          setConfirmingLeave(true);
          return;
        }
        default:
          return;
      }
    },
    [client, failed, flashCopied, markRead, onLeft, reset, track, workspaceId],
  );

  const confirmLeave = useCallback(() => {
    const target = active;
    if (target === null || leavePending) return;
    setLeavePending(true);
    setLeaveError(null);
    void removeChannelMember(workspaceId, target.channel.id, selfMemberId)
      .then(() => {
        if (!mounted.current) return;
        // 서버가 답한 **뒤에** 목록에서 지운다(웹과 같다).
        client.setQueryData<Channel[]>(workspaceKeys.channels(workspaceId), current =>
          current?.filter(known => !uuidEq(known.id, target.channel.id)),
        );
        void client.invalidateQueries({queryKey: workspaceKeys.channels(workspaceId)});
        void client.invalidateQueries({queryKey: workspaceKeys.roster(workspaceId)});
        succeeded('채널에서 나갔습니다.');
        onLeft?.(target.channel.id);
      })
      .catch(cause => {
        if (!mounted.current) return;
        haptics.error();
        // 목록을 건드리지 않았으므로 되돌릴 것이 없다. 확인 단계는 그대로 서 있고 이유를 말한다.
        setLeaveError(channelLeaveFailureMessage(cause));
      })
      .finally(() => {
        if (mounted.current) setLeavePending(false);
      });
  }, [active, client, leavePending, onLeft, selfMemberId, succeeded, workspaceId]);

  const cancelLeave = useCallback(() => {
    setConfirmingLeave(false);
    setLeaveError(null);
  }, []);

  const isPending = useCallback((key: ChannelActionKey) => pending.has(key), [pending]);

  return {
    active,
    confirmingLeave,
    copied,
    isPending,
    error,
    leave: {pending: leavePending, error: leaveError},
    open,
    close,
    run,
    confirmLeave,
    cancelLeave,
  };
}
