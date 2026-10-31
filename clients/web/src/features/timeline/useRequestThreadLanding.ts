import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { fetchMessages, uuidEq, type Message } from "@momo/core/lib/api";

export interface RequestThreadLanding { channelId: string; rootId: string; messageId: string; token: number }

/** OS 알림이 아는 서버 root를 열고, 패널의 답글 읽기가 끝난 뒤 카드 착지를 맡겨요. */
export function useRequestThreadLanding({ workspaceId, channelId, messages, onOpen, onMissing }: {
  workspaceId: string;
  channelId: string | null;
  messages: readonly Message[];
  onOpen: (root: Message) => void;
  onMissing: () => void;
}): RequestThreadLanding | null {
  const [params, setParams] = useSearchParams();
  const rootId = params.get("thread");
  const messageId = params.get("msg");
  const [target, setTarget] = useState<RequestThreadLanding | null>(null);
  const sequence = useRef(0);
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (!channelId || !rootId || !messageId) return;
    setTarget({ channelId, rootId, messageId, token: ++sequence.current });
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("thread"); next.delete("msg"); next.delete("seq");
      return next;
    }, { replace: true });
  }, [channelId, rootId, messageId, setParams]);
  useEffect(() => { setTarget((current) => current?.channelId === channelId ? current : null); }, [channelId]);
  const localRoot = target ? messages.find((message) => uuidEq(message.id, target.rootId)) : undefined;
  useEffect(() => {
    if (!target || target.channelId !== channelId || handled.current === target.token) return;
    let cancelled = false;
    async function open() {
      try {
        let root = localRoot;
        let before: number | undefined;
        // 세션 스레드 열기와 같은 유한 탐색이에요. 없는 root로 기록 전체를 걷지 않아요.
        for (let pageIndex = 0; !root && pageIndex < 8; pageIndex += 1) {
          const page = await fetchMessages(workspaceId, target!.channelId, { limit: 200, ...(before === undefined ? {} : { before }) });
          if (cancelled) return;
          root = page.messages.find((message) => uuidEq(message.id, target!.rootId));
          if (!page.messages.length || page.nextBefore === undefined || page.nextBefore === before) break;
          before = page.nextBefore;
        }
        if (cancelled) return;
        handled.current = target!.token;
        if (root) onOpen(root); else onMissing();
      } catch { if (!cancelled) { handled.current = target!.token; onMissing(); } }
    }
    void open();
    return () => { cancelled = true; };
  }, [workspaceId, channelId, target, localRoot, onOpen, onMissing]);
  return target?.channelId === channelId ? target : null;
}
