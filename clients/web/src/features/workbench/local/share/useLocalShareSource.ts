import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { createLocalWorkSession, endWorkSession } from "@momo/core/lib/api";
import { useSession } from "@/app/session";
import { useChannels } from "@/features/workspace/useWorkspace";
import { teamBoardKey } from "@/features/workTab/teamBoard/useTeamBoard";
import { absoluteApiBase } from "@/lib/serverBase";
import { desktopWorkHost, readWorkbenchGit } from "@/lib/tauri";
import { localSessions } from "../localSessions";
import { createPaneShare, type PaneShare } from "./paneShare";
import type { PaneShareSource } from "./paneShareSource";
import type { ShareChannelOption } from "./ShareDialog";

// 제품의 「채널에 공유」 원천(#2867). 도크(데스크탑 셸)에서만 쓴다: 브라우저에는 로컬 칸이 없다.
// 칸 → 서버는 `createLocalWorkSession`(사람 토큰, 서버가 카드를 올린다), 서버 → 갱신은 셸의
// `work_host_share`(host 서명은 workd). 이 훅은 그 둘과 채널 목록을 잇기만 한다.

/** 이 맥 설정으로 가는 주소: 「이 맥」 등록은 설정 › 코드 섹션에 있다. */
export const THIS_MAC_SETTINGS_PATH = "/settings?section=code";

// 공유 상태는 칸을 그리는 화면(도크 ↔ 「내 작업」 탭)이 바뀌어도 이어져야 한다: 칸의 세션은 그대로이고
// 서버의 공유도 그대로다. 그래서 워크스페이스마다 하나를 모듈이 쥐고(`localSessions()`와 같은 모양),
// 화면이 내려가도 지우지 않는다. 워크스페이스가 바뀔 때만 이전 것의 수집기를 멈춘다.
interface Holder {
  channels: readonly ShareChannelOption[];
  /** 팀 작업 보드의 읽기를 다시 한다(내 켜기·끄기가 내 화면에 바로 보이게). 다른 사람에게는 실시간 신호가 간다. */
  rereadBoard: () => void;
}
let cached: { workspaceId: string; share: PaneShare; holder: Holder } | null = null;

function sharedPaneShare(workspaceId: string, channels: readonly ShareChannelOption[], rereadBoard: () => void): PaneShare {
  if (cached && cached.workspaceId === workspaceId) {
    cached.holder.channels = channels;
    cached.holder.rereadBoard = rereadBoard;
    return cached.share;
  }
  cached?.share.dispose();
  const holder: Holder = { channels, rereadBoard };
  const on = new Set<string>();
  const share = createPaneShare({
    workspaceId,
    sessions: localSessions(),
    readGit: readWorkbenchGit,
    hostStatus: () => desktopWorkHost.status(),
    serverOrigin: absoluteApiBase,
    createSession: async (input) => {
      const created = await createLocalWorkSession(workspaceId, input);
      return { id: created.id, channelId: created.channelId };
    },
    endSession: (sessionId) => endWorkSession(workspaceId, sessionId),
    sendShare: async (sessionId, body) => {
      await desktopWorkHost.share(sessionId, body);
      // 켜기(첫 요약)와 끄기만 보드를 다시 읽는다. 요약 갱신마다 읽지 않는다.
      if (body.shared === false) {
        on.delete(sessionId);
        holder.rereadBoard();
      } else if (!on.has(sessionId)) {
        on.add(sessionId);
        holder.rereadBoard();
      }
    },
    channelSelectable: (id) => holder.channels.some((c) => c.id.toLowerCase() === id.toLowerCase()),
  });
  cached = { workspaceId, share, holder };
  return share;
}

export function useLocalShareSource(): PaneShareSource {
  const { workspaceId } = useSession();
  const navigate = useNavigate();
  const channelsQuery = useChannels(workspaceId);
  const channels = useMemo<ShareChannelOption[]>(
    () =>
      channelsQuery.groups.channels.flatMap((c) =>
        c.name && (c.kind === "public" || c.kind === "private")
          ? [{ id: c.id, name: c.name, kind: c.kind }]
          : []
      ),
    [channelsQuery.groups.channels]
  );
  const queryClient = useQueryClient();
  const share = useMemo(
    () =>
      sharedPaneShare(workspaceId, channels, () => {
        void queryClient.invalidateQueries({ queryKey: teamBoardKey(workspaceId) });
      }),
    [workspaceId, channels, queryClient]
  );

  return useMemo<PaneShareSource>(
    () => ({
      share,
      channels,
      openHostSettings: () => navigate(THIS_MAC_SETTINGS_PATH),
      copyText: async (text) => {
        try {
          if (typeof navigator.clipboard?.writeText !== "function") return false;
          await navigator.clipboard.writeText(text);
          return true;
        } catch {
          return false;
        }
      },
    }),
    [share, channels, navigate]
  );
}
