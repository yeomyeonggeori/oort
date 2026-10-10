import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  resendPersonalAgentCall,
  type PersonalAgentCall,
  type PersonalAgentCallResult,
} from "@momo/core/features/auth/personalAgentCall";
import type { RosterMember } from "@momo/core/lib/api";
import { isDesktop } from "@/lib/tauri";
import { desktopSigner, useHumanControlSigning } from "@/features/work/signedWork";
import { useWorkHosts } from "@/features/work/useWorkSessions";
import {
  callTargetFor,
  flagOffSigner,
  myPersonalAgent,
  pickCallHost,
  type PersonalCallSpec,
} from "@/features/work/personalAgentCalling";

/** 컴포저 아래에 남는 호출 결과. 메시지는 이미 보내진 뒤의 일이다. */
export interface CallNotice {
  channelId: string;
  call: PersonalAgentCall;
  /** 같은 서명을 다시 보내는 중. */
  retrying: boolean;
}

export interface PersonalCallController {
  /** 이 글이 내 개인 에이전트를 부르면 호출 계획, 아니면 null(그냥 보낸다). */
  planFor: (text: string) => PersonalCallSpec | null;
  notice: CallNotice | null;
  /** 같은 서명 그대로 다시 보낸다 — 새로 서명하지도, 메시지를 다시 보내지도 않는다. */
  retry: () => void;
  dismiss: () => void;
  /** 새 전송이 시작되면 지난 결과는 치운다. */
  clear: () => void;
}

/**
 * 컴포저의 「내 개인 에이전트 부르기」 (#3653). 내 개인 에이전트가 로스터에 있을 때만 내 맥
 * 목록을 읽는다 — 없으면 네트워크도, 서명 컨텍스트도 건드리지 않는다.
 */
export function usePersonalCall(input: {
  workspaceId: string;
  channelId: string | null;
  channelKind: string | undefined;
  members: RosterMember[];
  selfId: string;
  dmAgent: RosterMember | null;
}): PersonalCallController {
  const { workspaceId, channelId, channelKind, members, selfId, dmAgent } = input;
  const hasPersonal = useMemo(
    () => members.some((member) => myPersonalAgent(member, selfId) !== null),
    [members, selfId]
  );
  const desktop = isDesktop();
  const hosts = useWorkHosts(workspaceId, undefined, hasPersonal);
  const signing = useHumanControlSigning(workspaceId, hasPersonal && desktop);
  const host = useMemo(() => pickCallHost(hosts.data, selfId), [hosts.data, selfId]);

  const [notice, setNotice] = useState<CallNotice | null>(null);
  // 결과는 낙관적 echo가 확정될 때 오고, 그때 이미 다른 방에 있을 수 있다.
  const channelRef = useRef(channelId);
  useEffect(() => {
    channelRef.current = channelId;
    setNotice((current) => (current !== null && current.channelId !== channelId ? null : current));
  }, [channelId]);

  const onResult = useCallback((result: PersonalAgentCallResult) => {
    setNotice({ channelId: result.message.channelId, call: result.call, retrying: false });
  }, []);

  // 데스크탑이고 서버가 서명 요구를 껐다고 이미 아는 경우만 Touch ID를 건너뛴다. 모르면(null)
  // 서버가 정한다 — 서명 요구를 꺼진 것으로 읽지 않는다.
  const signer = useMemo(() => {
    if (!desktop) return null;
    if (signing.signatureRequired === false) return flagOffSigner();
    return desktopSigner(workspaceId);
  }, [desktop, signing.signatureRequired, workspaceId]);

  const planFor = useCallback(
    (text: string): PersonalCallSpec | null => {
      if (!hasPersonal) return null;
      const agent = callTargetFor({ text, members, selfId, dmAgent });
      if (agent === null) return null;
      return { agent, host, signer, audience: channelKind === "dm" ? "dm" : "channel", onResult };
    },
    [hasPersonal, members, selfId, dmAgent, host, signer, channelKind, onResult]
  );

  const noticeRef = useRef(notice);
  noticeRef.current = notice;
  const retry = useCallback(() => {
    const current = noticeRef.current;
    if (current === null || current.retrying) return;
    const call = current.call;
    if (call.state !== "not_delivered" || call.signed === null) return;
    const signed = call.signed;
    setNotice({ ...current, retrying: true });
    void resendPersonalAgentCall(workspaceId, signed).then((next) => {
      setNotice({ channelId: current.channelId, call: next, retrying: false });
    });
  }, [workspaceId]);

  const dismiss = useCallback(() => setNotice(null), []);
  return { planFor, notice, retry, dismiss, clear: dismiss };
}
