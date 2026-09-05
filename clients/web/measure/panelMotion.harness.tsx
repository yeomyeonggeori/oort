import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { QuickSwitcher } from "@/app/QuickSwitcher";
import { CreateChannelProvider } from "@/features/channels/CreateChannelDialog";
import { useOpenCreateChannel } from "@/features/channels/useCreateChannel";
import { AddChannelMemberProvider } from "@/features/channels/AddChannelMemberDialog";
import { AddWorkspaceProvider } from "@/features/workspace/AddWorkspaceDialog";
import { AgentProfileProvider } from "@/features/routing/AgentProfileDialog";
import { MemberProfileProvider } from "@/features/directory/MemberProfileDialog";
import { ShellNavProvider, useIsMobileShell } from "@/app/shellNav";
import { Sidebar } from "@/features/sidebar/Sidebar";
import { ThreadPanel } from "@/features/timeline/ThreadPanel";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import type { Message } from "@momo/core/lib/api";

/**
 * UX-R1b browser probe. Not a product route (module-scope createRoot).
 * Surfaces under test are the shipped components: QuickSwitcher, ThreadPanel,
 * and Sidebar (390 drawer + scrim), plus the app-shell grid for desktop fold.
 */

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000201";
const ROOT_A = "00000000-0000-7000-8000-000000000301";
const ROOT_B = "00000000-0000-7000-8000-000000000302";
const MEMBER_ID = "00000000-0000-7000-8000-000000000101";

const PALETTE_CHANNELS = [
  { id: "00000000-0000-7000-8000-000000000211", workspaceId: WS, kind: "public" as const, name: "abc-엔진", muted: false },
  { id: "00000000-0000-7000-8000-000000000212", workspaceId: WS, kind: "public" as const, name: "abc-클라", muted: false },
  { id: "00000000-0000-7000-8000-000000000213", workspaceId: WS, kind: "public" as const, name: "abc-디자인", muted: false },
  { id: "00000000-0000-7000-8000-000000000214", workspaceId: WS, kind: "public" as const, name: "abc-인프라", muted: false },
  { id: "00000000-0000-7000-8000-000000000215", workspaceId: WS, kind: "public" as const, name: "abc-릴리스", muted: false },
];

window.fetch = async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/channels")) {
    return new Response(JSON.stringify({ channels: PALETTE_CHANNELS }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.includes("/roster")) {
    return new Response(JSON.stringify({ members: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (url.includes("/workspaces/")) {
    return new Response(
      JSON.stringify({
        id: WS,
        slug: "dawn",
        name: "새벽",
        updatedAtMs: 1_800_000_000_000,
        roleLabels: {},
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  return new Response(JSON.stringify({ messages: [], members: [], channels: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

function rootMessage(id: string, seq: number, body: string): Message {
  return {
    id,
    channelId: CH,
    seq,
    authorMemberId: MEMBER_ID,
    body,
    type: "text",
    state: "sent",
    createdAtMs: 1_800_000_000_000,
    hlcTs: 1_800_000_000_000,
    hlcCount: 0,
  };
}

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

function DrawerProbe({
  behindClicks,
  onBehindClick,
}: {
  behindClicks: number;
  onBehindClick: () => void;
}) {
  const isMobile = useIsMobileShell();
  const [open, setOpen] = useState(false);
  const [folded, setFolded] = useState(false);
  return (
    <ShellNavProvider
      value={{
        isMobile,
        drawerOpen: open,
        openDrawer: () => setOpen(true),
        closeDrawer: () => setOpen(false),
      }}
    >
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
          <Sidebar
            onOpenQuickSwitcher={() => undefined}
            channelPaneCollapsed={folded}
            treeHidden={false}
          />
          <main
            data-testid="click-behind"
            data-clicks={behindClicks}
            onClick={onBehindClick}
          >
            본문
          </main>
        </div>
      </div>
    </ShellNavProvider>
  );
}

function ThreadProbe() {
  const [thread, setThread] = useState<Message | null>(null);
  return (
    <div>
      <div>
        <button
          type="button"
          data-testid="open-thread"
          className="focus-visible:focus-ring"
          onClick={() => setThread(rootMessage(ROOT_A, 1, "이 스레드의 첫 글"))}
        >
          스레드 열기
        </button>
        <button
          type="button"
          data-testid="open-thread-other"
          className="focus-visible:focus-ring"
          onClick={() => setThread(rootMessage(ROOT_B, 2, "다른 스레드"))}
        >
          다른 스레드 열기
        </button>
      </div>
      {/* thread-pane is position:absolute;inset:0 below 900px. Keep the
          anchors outside that containing block so a close-then-click
          during the exit can reach them, as the timeline can on desktop. */}
      <div className="relative h-80">
        <ThreadPanel
          workspaceId={WS}
          channelId={CH}
          root={thread}
          directory={makeDirectory([])}
          channels={[]}
          onClose={() => setThread(null)}
        />
      </div>
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

function CreateChannelClickProbe() {
  const openCreate = useOpenCreateChannel();
  return (
    <button
      type="button"
      data-testid="open-create-channel"
      className="focus-visible:focus-ring"
      onClick={() => openCreate(null)}
    >
      채널 만들기
    </button>
  );
}

export function Harness() {
  const [behindClicks, setBehindClicks] = useState(0);
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
            <DrawerProbe
              behindClicks={behindClicks}
              onBehindClick={() => setBehindClicks((n) => n + 1)}
            />
            <ThreadProbe />
            <PaletteProbe />
            <CreateChannelClickProbe />
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
