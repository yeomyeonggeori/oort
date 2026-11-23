import {
  ApiError,
  closeDm,
  leaveChannel,
  leaveDm,
  setChannelNotificationPref,
  uuidEq,
  type Channel,
} from '@momo/core/lib/api';
import type {ChannelActionKey} from '@momo/core/features/channels/actionModel';
import {
  canRenameChannel,
  channelRenameFailure,
  renameChannel,
  type ChannelRenameFailure,
} from '@momo/core/features/channels/rename';
import {upsertChannel} from '@momo/core/features/directory/model';
import {
  DM_LEAVE_KEYS,
  dmLeaveScheduledCount,
  dmLeaveSeenSeq,
  runDmLeaveCleanup,
  settleDmLeaveFailure,
} from '@momo/core/features/channels/dmLeave';
import {listAllScheduledMessages} from '@momo/core/features/scheduled/api';
import {isScheduledAbsent} from '@momo/core/features/scheduled/errors';
import {
  CHANNEL_COPY_FAILURE_KEY,
  CHANNEL_MARK_READ_FAILURE_KEY,
  CHANNEL_MARK_UNREAD_FAILURE_KEY,
  CHANNEL_MUTE_FAILURE_KEY,
  DM_CLOSE_FAILURE_KEY,
  channelLeaveFailure,
} from '@momo/core/features/channels/model';
import {channelShareUrlFromServerBase} from '@momo/core/features/channels/shareLink';
import {useQueryClient} from '@tanstack/react-query';
import {useCallback, useEffect, useRef, useState} from 'react';
import {AccessibilityInfo} from 'react-native';
import {copyText, COPY_RECEIPT_MS} from '../conversation/copy';
import {useMarkRead} from '../inbox/useInbox';
import {applyClosureToReadStates, workspaceKeys} from '../workspace/queries';
import {haptics} from '../../lib/haptics';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {apiBase} from '../../storage/serverBase';
import {heldThreadRoots, phoneDmLeaveCleanupPort} from './dmLeaveCleanup';
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
// ## 알림은 낙관 갱신한다
//
// 알림은 채널을 제거하지 않으므로 먼저 상태를 바꾸고 실패하면 되돌린다. 읽음·안 읽음·나가기는 서버가 답한 **뒤에** 캐시를 건드린다. 웹 `leaveMutation`
// 머리말이 적은 이유가 그대로다: 시트를 이고 있는 행이 낙관 편집으로 언마운트되면 「나가는 중」과
// 실패 문장이 화면에 도달하지 못한다.
//
// ## 1:1 「대화 나가기」 (ADR-0177 증보 2026-11-14 D16·D21, #5826)
//
// 채널 나가기와 같은 자리(시트 안 확인 단계)지만 상태는 따로 든다(`dmLeave`) — 문장·요청·성공 뒤 정리가 다르다.
//
//   1. 행을 누르면 단계가 **바로** 선다(웹과 같다, #5876). 예약 목록을 아직 모르는 동안은 확정이 잠기고 그 자리에 「확인 중…」이 선다 —
//      모름을 0 으로 읽지 않는다: 못 읽으면(404 가 아닌 오류) 그 까닭을 말하고 잠근 채 둔다. 알게 되면 같은 자리의 문장만 바뀐다
//      (`DmLeaveConfirm` 이 그 줄을 늘 한 줄 잡아 둔다). 알게 된 순간부터 `DM_LEAVE_CONFIRM_ARM_MS` 를 센다(풀린 단추가 손가락 밑에 있을 수 있다).
//   2. `seenSeq` 는 단계가 **설 때** 얼린다(D16): 확인 단계를 보는 사이에 온 글은 하한 위에 남아 새 대화의 첫 글이 된다.
//   3. 단계가 선 뒤 `DM_LEAVE_CONFIRM_ARM_MS` 동안은 확정 단추의 눌림을 받지 않는다 — 폰은 두 번 누름이 흔하고, 메뉴 행을 누른 자리에
//      확정 단추가 설 수 있다. 진행 중에는 취소·확정 모두 잠긴다.
//   4. 204 뒤의 정리(`runDmLeaveCleanup`)는 화면이 그 사이 사라졌어도 돈다 — 서버는 이미 끝났다. 화면 상태만 마운트를 본다.
//   5. 실패는 확인 단계 안에서 코어 문장 한 줄이고 아무것도 바뀌지 않는다. 다시 누르면 달라질 수 있는 것(망·5xx)은 「나가지 못했어요」 + 살아 있는
//      확정, 다시 눌러도 같은 답인 것(409 `dm_leave_unavailable`·405·501)은 「이 대화에서는 나갈 수 없어요.」 + 확정 잠금(닫기만 남는다).
//      405·501 은 코어가 이 워크스페이스의 메뉴를 접는다. 404 는 문장 없이 닫는다.
//   6. 진행 중에는 시트가 몸짓(X·바깥 누름·끌어내리기·escape)으로 닫히지 않는다(`ChannelActionSheet`·`ConversationMenuSheet` 의 `dirty`,
//      정보 페이지의 ‹·가장자리 밀기) — 요청이 이미 나갔고 되돌릴 수 없다.
// =============================================================================

/** 확인 단계가 선 뒤 확정 단추가 눌림을 받기 시작하기까지(두 번 누름이 확정을 누르지 않게). */
export const DM_LEAVE_CONFIRM_ARM_MS = 500;

/** 예약 목록을 아는 정도: 모름(`checking`) · 못 읽음(`failed`) · 앎(`known`). 앞의 둘은 확정이 잠긴다. */
export type DmLeaveScheduledState = 'checking' | 'failed' | 'known';

/** 화면이 그리는 「대화 나가기」 확인 단계. */
export interface DmLeaveStepView {
  /** 확인 창 제목·본문의 이름(상대의 표시 이름). */
  name: string;
  /** 그 방의 내 예약(`pending`+`failed`) 수. `scheduled` 가 `known` 일 때만 뜻이 있다. 0 이면 그 줄이 없다. */
  scheduledCount: number;
  scheduled: DmLeaveScheduledState;
  pending: boolean;
  error: string | null;
  /** 다시 눌러도 같은 답(409·405·501)이라 확정이 잠겼다. 「취소」만 남는다. */
  unavailable: boolean;
}

interface DmLeaveStep extends DmLeaveStepView {
  target: ChannelRowTarget;
  seenSeq: number;
  shownAtMs: number;
}

/**
 * 그 방의 내 예약 수. 읽지 못하면 `null` - 「모름」을 0 으로 읽지 않는다(웹 `DmLeaveHost` 와 같다). 목록 404 만 「이 서버에 예약이 없다」라
 * 0 이다(`isScheduledAbsent`).
 */
async function scheduledCountOrNull(workspaceId: string, channelId: string): Promise<number | null> {
  try {
    const rows = await listAllScheduledMessages(workspaceId, {channelId, status: 'open'});
    return dmLeaveScheduledCount(rows, channelId);
  } catch (cause) {
    return isScheduledAbsent(cause) ? 0 : null;
  }
}

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
  /** 1:1 「대화 나가기」 확인 단계(D21). 없으면 `null`. */
  dmLeave: DmLeaveStepView | null;
  /** 「이름 바꾸기」 단계(ADR-0225 D10, #5835). 없으면 `null`. 보내는 중에는 시트의 닫는 길이 잠긴다. */
  rename: {pending: boolean; failure: ChannelRenameFailure | null} | null;
  /** `gesture` 를 생략하면 길게 누르기다(사이드바 행이 그대로 `onOpenActions={open}` 으로 넘긴다). */
  open: (target: ChannelRowTarget, gesture?: RowActionsOpenGesture) => void;
  close: () => void;
  run: (target: ChannelRowTarget, key: ChannelActionKey) => void;
  confirmLeave: () => void;
  cancelLeave: () => void;
  confirmDmLeave: () => void;
  cancelDmLeave: () => void;
  /** 접은 이름으로 바꾼다. 성공하면 채널 목록 캐시에 응답의 줄이 서고(홈 줄 · 대화 머리가 같은 캐시를 읽는다) 시트가 닫힌다. */
  confirmRename: (name: string) => void;
  clearRenameFailure: () => void;
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
  /** 나가기가 본인 길(`…/members/me`)이 된 뒤로(#5778) 읽지 않는다 — 부르는 쪽(셸)의 모양만 남았다. */
  selfMemberId: string,
  /** 채널을 나간 뒤·DM 을 닫은 뒤(서버가 답한 뒤)에 부른다. 열려 있던 대화를 걷는 일은 부르는 쪽(셸)이 한다. */
  onLeft?: (channelId: string) => void,
  /** 1:1 대화에서 나간 뒤(204) 그 한 줄 알림(D21 「대화에서 나갔어요.」)을 셸의 영수증 자리에 세운다. */
  onDmLeftReceipt?: (message: string) => void,
): ChannelRowActions {
  const client = useQueryClient();
  const formatMessage = useFormatMessage();
  const markRead = useMarkRead();
  const [active, setActive] = useState<ChannelRowTarget | null>(null);
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const [copied, setCopied] = useState<ChannelRowCopied>(NOTHING_COPIED);
  const [pending, setPending] = useState<ReadonlySet<ChannelActionKey>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [leavePending, setLeavePending] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);
  const [dmLeave, setDmLeave] = useState<DmLeaveStep | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renamePending, setRenamePending] = useState(false);
  const [renameFailure, setRenameFailure] = useState<ChannelRenameFailure | null>(null);
  const renameInFlight = useRef(false);
  // 예약 목록을 읽는 사이 시트가 닫히거나 다른 행이 열리면 늦게 온 답이 다른 단계에 닿지 않게 한다(ref 라서 `run` 의 신원이 안 바뀐다).
  const dmLeaveAsk = useRef(0);
  const receiptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const muteInFlight = useRef(new Set<string>());

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
    dmLeaveAsk.current += 1;
    setDmLeave(null);
    setRenaming(false);
    setRenameFailure(null);
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
            failed(target, formatMessage(CHANNEL_COPY_FAILURE_KEY));
            return;
          }
          void copyText(text).then(ok => {
            if (!mounted.current) return;
            if (ok) flashCopied(which, target);
            else failed(target, formatMessage(CHANNEL_COPY_FAILURE_KEY));
          });
          return;
        }
        case 'mark-read': {
          const state = target.readState;
          if (state === null) return;
          void track(
            key,
            target,
            formatMessage(CHANNEL_MARK_READ_FAILURE_KEY),
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
            formatMessage(CHANNEL_MARK_UNREAD_FAILURE_KEY),
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
          if (muteInFlight.current.has(channel.id)) return;
          muteInFlight.current.add(channel.id);
          setError(null);
          const next = !target.muted;
          const queryKey = workspaceKeys.channels(workspaceId);
          const patchMuted = (muted: boolean) => {
            client.setQueryData<Channel[]>(queryKey, previous =>
              previous?.map(row => uuidEq(row.id, channel.id) ? {...row, muted} : row),
            );
            if (mounted.current) {
              setActive(previous => previous && uuidEq(previous.channel.id, channel.id)
                ? {...previous, muted} : previous);
            }
          };
          void track(
            key,
            target,
            formatMessage(CHANNEL_MUTE_FAILURE_KEY),
            async () => {
              try {
                await client.cancelQueries({queryKey});
                patchMuted(next);
                await setChannelNotificationPref(workspaceId, channel.id, next);
              } catch (cause) {
                patchMuted(target.muted);
                throw cause;
              } finally {
                muteInFlight.current.delete(channel.id);
                void client.invalidateQueries({queryKey});
              }
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
            formatMessage(DM_CLOSE_FAILURE_KEY),
            async () => {
              await closeDm(workspaceId, channel.id, seenSeq);
              // 서버가 답한 **뒤에** 이 기기의 투영 행에 적는다(낙관 갱신 없음, 머리말). 다른 기기는 다음 투영에서 맞춘다.
              applyClosureToReadStates(client, workspaceId, channel.id, seenSeq);
              void client.invalidateQueries({queryKey: workspaceKeys.readState(workspaceId)});
              // 지금 보던 대화였으면 걷는다(웹 `closeDmRow` 의 착지와 같다). 셸이 열린 대화인지 본다.
              onLeft?.(channel.id);
            },
            '대화를 목록에서 숨겼습니다.',
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
        case 'rename': {
          const name = target.channel.name ?? target.title;
          if (!canRenameChannel({kind: target.channel.kind, name, archivedAtMs: target.channel.archivedAtMs}, target.selfRole)) return;
          reset();
          haptics.light();
          setActive(target);
          setRenaming(true);
          return;
        }
        case 'leave-dm': {
          // 1:1 「대화 나가기」(D21): 확인 단계로 간다. 내밀지 않은 대상(옛 서버·에이전트·그룹)은 로터로 와도 아무 일이 없다.
          if (target.leaveOffered !== true || target.channel.kind !== 'dm') return;
          reset();
          const ask = dmLeaveAsk.current;
          // D16: 이 기기가 그 대화에 대해 든 가장 큰 seq - 단계가 설 때 얼린다(머리말 2).
          const seenSeq = dmLeaveSeenSeq(target.readState ?? undefined, target.held?.().maxSeq);
          setActive(target);
          haptics.warning();
          // 단계는 바로 서고 예약 목록을 아직 모르는 동안 확정이 잠긴다(머리말 1).
          setDmLeave({
            target,
            name: target.title,
            seenSeq,
            scheduledCount: 0,
            scheduled: 'checking',
            pending: false,
            error: null,
            unavailable: false,
            shownAtMs: Date.now(),
          });
          void scheduledCountOrNull(workspaceId, channel.id).then(count => {
            if (!mounted.current || dmLeaveAsk.current !== ask) return;
            setDmLeave(previous =>
              previous === null
                ? previous
                : count === null
                  ? {...previous, scheduled: 'failed'}
                  : {...previous, scheduled: 'known', scheduledCount: count, shownAtMs: Date.now()},
            );
          });
          return;
        }
        default:
          return;
      }
    },
    [client, failed, flashCopied, formatMessage, markRead, onLeft, reset, track, workspaceId],
  );

  const confirmLeave = useCallback(() => {
    const target = active;
    if (target === null || leavePending) return;
    setLeavePending(true);
    setLeaveError(null);
    // 본인 나가기 길(#5778). 관리자 전용 `removeChannelMember` 로 자기를 지우면 일반 멤버는 403 이다.
    // 나간 뒤의 정리: 성공과 「이미 나간 것」(404)이 같은 길이다(웹 `leftChannel` 과 같다, #5818 검수 r2).
    const left = () => {
      // 서버가 답한 **뒤에** 목록에서 지운다(웹과 같다).
      client.setQueryData<Channel[]>(workspaceKeys.channels(workspaceId), current =>
        current?.filter(known => !uuidEq(known.id, target.channel.id)),
      );
      void client.invalidateQueries({queryKey: workspaceKeys.channels(workspaceId)});
      void client.invalidateQueries({queryKey: workspaceKeys.roster(workspaceId)});
      succeeded('채널에서 나갔습니다.');
      onLeft?.(target.channel.id);
    };
    void leaveChannel(workspaceId, target.channel.id)
      .then(() => {
        if (!mounted.current) return;
        left();
      })
      .catch(cause => {
        if (!mounted.current) return;
        // 404 = 서버가 「이미 멤버가 아니다」라고 했다(다른 기기에서 먼저 나갔거나 채널이 보관됨). 낡은 화면이 모르는 사실이므로
        // 나간 것과 같게 줄을 걷고 시트를 닫는다 - 문장을 세우지 않는다(웹과 같다).
        if (cause instanceof ApiError && cause.status === 404) {
          left();
          return;
        }
        haptics.error();
        // 목록을 건드리지 않았으므로 되돌릴 것이 없다. 확인 단계는 그대로 서 있고 이유를 말한다.
        const failure = channelLeaveFailure(cause);
        setLeaveError(formatMessage(failure.key, failure.values as never));
      })
      .finally(() => {
        if (mounted.current) setLeavePending(false);
      });
  }, [active, client, formatMessage, leavePending, onLeft, succeeded, workspaceId]);

  const cancelLeave = useCallback(() => {
    setConfirmingLeave(false);
    setLeaveError(null);
  }, []);

  const confirmDmLeave = useCallback(() => {
    const step = dmLeave;
    if (step === null || step.pending || step.scheduled !== 'known' || step.unavailable) return;
    // 머리말 3: 단계가 선 직후의 눌림(메뉴 행을 누른 손가락의 둘째 누름)은 확정이 아니다.
    if (Date.now() - step.shownAtMs < DM_LEAVE_CONFIRM_ARM_MS) return;
    const {target, seenSeq} = step;
    const channelId = target.channel.id;
    // 스레드 초안의 뿌리는 요청 **전에** 모은다 - 나간 뒤에는 서버가 하한 아래 뿌리를 내려 주지 않는다(`dmLeaveCleanup.ts`).
    const threadRootIds = heldThreadRoots(
      client,
      workspaceId,
      channelId,
      target.held?.().messageIds ?? [],
    );
    setDmLeave({...step, pending: true, error: null});
    void leaveDm(workspaceId, channelId, seenSeq)
      .then(() => {
        // 서버는 끝났다(204). 정리는 화면이 사라졌어도 돈다(머리말 4).
        runDmLeaveCleanup(
          phoneDmLeaveCleanupPort({client, workspaceId, selfMemberId, threadRootIds}),
          {channelId, seenSeq},
        );
        void client.invalidateQueries({queryKey: workspaceKeys.readState(workspaceId)});
        const done = formatMessage(DM_LEAVE_KEYS.done);
        onDmLeftReceipt?.(done);
        if (mounted.current) succeeded(done);
        // 보고 있던 대화를 걷는다(셸·대화 화면이 열린 대화인지 본다).
        onLeft?.(channelId);
      })
      .catch(cause => {
        const failure = settleDmLeaveFailure(workspaceId, cause);
        if (failure === 'missing') {
          // 404 = 이미 나갔거나 없는 대화. 다시 눌러도 같은 답이라 나간 것과 같게 정리하고 시트를 닫는다 - 문장 없이(웹·채널 나가기와 같다).
          runDmLeaveCleanup(
            phoneDmLeaveCleanupPort({client, workspaceId, selfMemberId, threadRootIds}),
            {channelId, seenSeq},
          );
          void client.invalidateQueries({queryKey: workspaceKeys.readState(workspaceId)});
          if (mounted.current) close();
          onLeft?.(channelId);
          return;
        }
        // 다시 눌러도 같은 답: 409 `dm_leave_unavailable`(그 방은 사람끼리 1:1 이 아니다)·405·501(경로 없음 - 코어가 메뉴를 접었다). 이 기기의
        // 사실이 낡았을 수 있어 채널·읽음 투영을 다시 받는다(웹과 같다).
        const unavailable = failure === 'unavailable' || failure === 'absent';
        if (unavailable) {
          void client.invalidateQueries({queryKey: workspaceKeys.channels(workspaceId)});
          void client.invalidateQueries({queryKey: workspaceKeys.readState(workspaceId)});
        }
        if (!mounted.current) return;
        haptics.error();
        // 아무것도 바뀌지 않았다. 단계는 그대로 서 있고 이유를 말한다 - 다시 시도해 볼 만한 실패는 「나가기」가 살아 있고, 아니면 잠긴다.
        setDmLeave(previous =>
          previous === null
            ? previous
            : {
                ...previous,
                pending: false,
                unavailable,
                error: formatMessage(unavailable ? DM_LEAVE_KEYS.unavailable : DM_LEAVE_KEYS.failed),
              },
        );
      });
  }, [client, close, dmLeave, formatMessage, onDmLeftReceipt, onLeft, selfMemberId, succeeded, workspaceId]);

  const confirmRename = useCallback(
    (name: string) => {
      const target = active;
      if (target === null || renameInFlight.current) return;
      renameInFlight.current = true;
      setRenamePending(true);
      setRenameFailure(null);
      void renameChannel(workspaceId, target.channel.id, name)
        .then(renamed => {
          client.setQueryData<Channel[]>(workspaceKeys.channels(workspaceId), current =>
            current ? upsertChannel(current, renamed) : [renamed],
          );
          void client.invalidateQueries({queryKey: workspaceKeys.channels(workspaceId)});
          if (mounted.current) succeeded(formatMessage('channels.rename.done'));
        })
        .catch(cause => {
          if (!mounted.current) return;
          haptics.error();
          setRenameFailure(channelRenameFailure(cause));
        })
        .finally(() => {
          renameInFlight.current = false;
          if (mounted.current) setRenamePending(false);
        });
    },
    [active, client, formatMessage, succeeded, workspaceId],
  );

  const clearRenameFailure = useCallback(() => setRenameFailure(null), []);

  const cancelDmLeave = useCallback(() => {
    // 진행 중에는 취소가 잠긴다 - 요청은 이미 나갔다.
    if (dmLeave === null || dmLeave.pending) return;
    dmLeaveAsk.current += 1;
    setDmLeave(null);
  }, [dmLeave]);

  const isPending = useCallback((key: ChannelActionKey) => pending.has(key), [pending]);

  return {
    active,
    confirmingLeave,
    copied,
    isPending,
    error,
    leave: {pending: leavePending, error: leaveError},
    dmLeave:
      dmLeave === null
        ? null
        : {
            name: dmLeave.name,
            scheduledCount: dmLeave.scheduledCount,
            scheduled: dmLeave.scheduled,
            pending: dmLeave.pending,
            error: dmLeave.error,
            unavailable: dmLeave.unavailable,
          },
    rename: renaming ? {pending: renamePending, failure: renameFailure} : null,
    open,
    close,
    run,
    confirmRename,
    clearRenameFailure,
    confirmLeave,
    cancelLeave,
    confirmDmLeave,
    cancelDmLeave,
  };
}
