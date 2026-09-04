import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { QuickSwitcher } from "@/app/QuickSwitcher";
import { CreateChannelProvider } from "@/features/channels/CreateChannelDialog";
import { AddChannelMemberProvider } from "@/features/channels/AddChannelMemberDialog";
import { AddWorkspaceProvider } from "@/features/workspace/AddWorkspaceDialog";
import { AgentProfileProvider } from "@/features/routing/AgentProfileDialog";
import { MemberProfileProvider } from "@/features/directory/MemberProfileDialog";
import { SidebarDrawerScrimLayer } from "@/features/sidebar/Sidebar";
import { ThreadPanel } from "@/features/timeline/ThreadPanel";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import type { Message } from "@momo/core/lib/api";
import { cn } from "@/design/lib/cn";

/**
 * UX-R1b browser probe. Not a product route (module-scope createRoot).
 * The three surfaces under test are the shipped components and CSS:
 * QuickSwitcher, ThreadPanel, SidebarDrawerScrim + `.sidebar-drawer`.
 */

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const ROOT_ID = "00000000-0000-7000-8000-000000000301";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";

window.fetch = async () =>
  new Response(JSON.stringify({ messages: [], members: [], channels: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const rootMessage: Message = {
  id: ROOT_ID,
  channelId: CH,
  seq: 1,
  authorMemberId: MEMBER_ID,
  body: "이 스레드의 첫 글",
  type: "text",
  state: "sent",
  createdAtMs: 1_800_000_000_000,
  hlcTs: 1_800_000_000_000,
  hlcCount: 0,
};

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: {
        id: MEMBER_ID,
        workspaceId: WS,
        kind: "human",
        displayName: "곽성재",
        handle: "seongjae",
      },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function DrawerProbe() {
  const [open, setOpen] = useState(false);
  const [folded, setFolded] = useState(false);
  return (
    <div>
      <button
        type="button"
        data-testid="open-drawer"
        className="focus-visible:focus-ring"
        onClick={() => setOpen(true)}
      >
        서랍 열기
      </button>
      <button
        type="button"
        data-testid="toggle-sidebar-fold"
        className="focus-visible:focus-ring"
        onClick={() => setFolded((value) => !value)}
      >
        사이드바 접기
      </button>
      <div
        className="app-shell"
        data-testid="drawer-shell"
        data-sidebar-collapsed={folded ? "" : undefined}
      >
        <div
          id="sidebar-drawer"
          className={cn(
            "sidebar-drawer flex h-full bg-surface-sidebar",
            open && "shadow-lg"
          )}
          data-open={open ? "" : undefined}
          data-state={open ? "open" : "closed"}
          data-testid="sidebar"
        >
          채널 목록
        </div>
        <main>본문</main>
        <SidebarDrawerScrimLayer open={open} onClose={() => setOpen(false)} />
      </div>
    </div>
  );
}

function ThreadProbe() {
  const [thread, setThread] = useState<Message | null>(null);
  return (
    <div>
      <button
        type="button"
        data-testid="open-thread"
        className="focus-visible:focus-ring"
        onClick={() => setThread(rootMessage)}
      >
        스레드 열기
      </button>
      {thread ? (
        <ThreadPanel
          workspaceId={WS}
          channelId={CH}
          root={thread}
          directory={makeDirectory([])}
          channels={[]}
          onClose={() => setThread(null)}
        />
      ) : null}
    </div>
  );
}

function PaletteProbe() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        data-testid="open-palette"
        className="focus-visible:focus-ring"
        onClick={() => setOpen(true)}
      >
        팔레트 열기
      </button>
      <QuickSwitcher open={open} onOpenChange={setOpen} />
    </div>
  );
}

export function Harness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={client}>
      <SessionProvider value={sessionValue()}>
        <MemoryRouter>
          <CreateChannelProvider>
          <AddWorkspaceProvider>
          <AddChannelMemberProvider>
          <AgentProfileProvider>
          <MemberProfileProvider>
            <DrawerProbe />
            <ThreadProbe />
            <PaletteProbe />
          </MemberProfileProvider>
          </AgentProfileProvider>
          </AddChannelMemberProvider>
          </AddWorkspaceProvider>
          </CreateChannelProvider>
        </MemoryRouter>
      </SessionProvider>
    </QueryClientProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("panelMotion harness: #root missing");
createRoot(root).render(<Harness />);
