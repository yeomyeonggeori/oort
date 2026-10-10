import {callPersonalAgent} from '@momo/core/features/auth/personalAgentCall';
import {SignerRefusal} from '@momo/core/features/auth/signedControl';
import type {Directory} from '@momo/core/features/workspace/directory';
import {
  fetchWorkHosts,
  fetchWorkSessions,
  type Channel,
  type Message,
  type RosterMember,
} from '@momo/core/lib/api';
import {useCallback, useEffect, useRef, useState} from 'react';

import {useWorkSessions} from '../agents/queries';
import {lazyPhoneSigner} from '../work/ask/phoneSpawnPort';
import {findSpawnedSession} from '../work/ask/model';
import {spawnPort} from '../work/ask/spawnPort';
import {
  personalAgentCallTarget,
  runPersonalAgentCall,
  type CallDeps,
} from './personalAgentCallModel';

// =============================================================================
// 컴포저가 개인 에이전트를 부르는 한 길 (#3638, ADR-0198 증보 1 D7).
//
// `tryCall(body)`가 `true`이면 이 훅이 보내기를 맡았다(호출하는 쪽은 `timeline.send`를
// 부르지 않는다 — 코어 `callPersonalAgent`가 메시지를 직접 보내므로 두 번 보내지 않게).
// `false`이면 평범한 메시지다.
//
// 맡았을 때의 사람 말은 한 줄이고 컴포저 위에 선다(`notice`). 실패는 코어의
// `callFailureLine` 문장 그대로다. 호출이 맥에 닿으면 만들어질 세션을 기다렸다가 N3 대화로
// 간다. 못 찾으면 작업 목록으로 간다(엉뚱한 세션을 열어 주지 않는다).
// =============================================================================

export const CALL_WAIT_POLL_MS = 2_000;
export const CALL_WAIT_TIMEOUT_MS = 20_000;
export const CALL_RECEIVED_LINE = '내 맥이 받았어요. 작업 화면으로 가요.';

export interface CallNotice {
  text: string;
  /** `error`는 빨간 글씨. Face ID를 스스로 접은 것·맥이 꺼진 것 같은 안내는 `info`. */
  tone: 'info' | 'error';
}

interface WaitCue {
  before: ReadonlySet<string>;
  hostId: string;
  channelId: string;
  label: string;
}

const DEFAULT_DEPS: CallDeps = {
  fetchHosts: fetchWorkHosts,
  fetchSessionIds: async workspaceId =>
    (await fetchWorkSessions(workspaceId)).map(session => session.id),
  call: callPersonalAgent,
  newClientMsgId: () => crypto.randomUUID(),
};

export function usePersonalAgentCall(input: {
  workspaceId: string;
  selfId: string;
  channel: Channel | null;
  directory: Directory;
  members: readonly RosterMember[];
  /** 평범한 메시지로 보낸다(`timeline.send`). */
  sendPlain: (body: string) => void;
  /** 서버가 확정한 호출 메시지를 타임라인에 합친다(`timeline.ingest`). */
  ingest: (message: Message) => void;
  onOpenWorkSession?: (sessionId: string) => void;
  onOpenWorkList?: () => void;
  /** 시험의 이음매. */
  deps?: CallDeps;
  waitTimeoutMs?: number;
}): {
  tryCall: (body: string) => boolean;
  notice: CallNotice | null;
  dismissNotice: () => void;
} {
  const [notice, setNotice] = useState<CallNotice | null>(null);
  const [wait, setWait] = useState<WaitCue | null>(null);
  const sessions = useWorkSessions(
    input.workspaceId,
    wait !== null,
    wait !== null ? CALL_WAIT_POLL_MS : undefined,
  );
  const latest = useRef(input);
  latest.current = input;
  const openedRef = useRef(false);

  useEffect(() => {
    if (wait === null) return;
    const found = findSpawnedSession(sessions.data ?? [], wait.before, {
      selfId: input.selfId,
      hostId: wait.hostId,
      channelId: wait.channelId,
      label: wait.label,
    });
    if (found !== null && !openedRef.current) {
      openedRef.current = true;
      setWait(null);
      setNotice(null);
      latest.current.onOpenWorkSession?.(found);
    }
  }, [wait, sessions.data, input.selfId]);

  const timeout = input.waitTimeoutMs ?? CALL_WAIT_TIMEOUT_MS;
  useEffect(() => {
    if (wait === null) return;
    const id = setTimeout(() => {
      setWait(null);
      setNotice(null);
      latest.current.onOpenWorkList?.();
    }, timeout);
    return () => clearTimeout(id);
  }, [wait, timeout]);

  const tryCall = useCallback((body: string): boolean => {
    const current = latest.current;
    // 보내는 길이 이 빌드에 없으면 평범한 메시지다(AI 시트·시트 입구와 같은 게이트).
    if (!spawnPort().wired) return false;
    const target = personalAgentCallTarget({
      body,
      channel: current.channel,
      directory: current.directory,
      members: current.members,
      selfId: current.selfId,
    });
    if (target === null || current.channel === null) return false;
    const channelId = current.channel.id;
    const workspaceId = current.workspaceId;
    setNotice(null);
    void (async () => {
      const run = await runPersonalAgentCall(
        {
          workspaceId,
          channelId,
          selfId: current.selfId,
          body,
          target,
          signer: lazyPhoneSigner({workspaceId, memberId: current.selfId}),
        },
        current.deps ?? DEFAULT_DEPS,
      ).catch(() => ({kind: 'unsent'}) as const);
      const live = latest.current;
      if (run.kind === 'plain') {
        live.sendPlain(body);
        setNotice({text: run.sentence, tone: 'info'});
        return;
      }
      if (run.kind === 'unsent') {
        live.sendPlain(body);
        return;
      }
      live.ingest(run.message);
      if (run.call.state === 'called') {
        openedRef.current = false;
        setNotice({text: CALL_RECEIVED_LINE, tone: 'info'});
        if (run.wait !== null) setWait(run.wait);
        else live.onOpenWorkList?.();
        return;
      }
      const cancelled =
        run.call.state === 'not_delivered' &&
        run.call.error instanceof SignerRefusal &&
        run.call.error.cancelled;
      setNotice({text: run.call.text, tone: cancelled ? 'info' : 'error'});
    })();
    return true;
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);
  return {tryCall, notice, dismissNotice};
}
