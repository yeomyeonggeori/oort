import { useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { fetchThreadReplies, type Channel, type Message } from "@momo/core/lib/api";
import type { Directory } from "@/features/workspace/useWorkspace";
import type { OpenWorkSession } from "@/features/work/openWorkSession";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { startsAuthorGroup } from "@momo/core/features/timeline/model";
import { MessageRow, type MessageRowActions } from "./MessageRow";
import { ThreadComposer } from "./ThreadComposer";
import { chipsFor, type ReactionMap } from "@momo/core/features/timeline/reactions";
import { isPinned, type PinMap } from "@momo/core/features/timeline/pins";

// =============================================================================
// Thread panel (R-1 §3 "스레드 진입 자리", P12: replies live outside the channel
// so the main view stays readable). A right-hand panel rather than an inline
// expansion, sharing the exact MessageRow anatomy of the channel timeline.
// =============================================================================

export function ThreadPanel({
  workspaceId,
  channelId,
  root,
  directory,
  channels,
  actions,
  reactions,
  pins,
  onOpenWorkSession,
  onClose,
}: {
  workspaceId: string;
  channelId: string;
  root: Message;
  directory: Directory;
  /** 답글 컴포저의 `#` 후보 (#1930). 채널 컴포저와 같은 목록을 내려 준다. */
  channels: Channel[];
  /**
   * B11 — the same actions the channel row offers, so a reply is edited,
   * deleted and reacted to exactly where it is read. Omitted by the work
   * session panel, whose rows are an event log.
   */
  actions?: Omit<MessageRowActions, "chips" | "pinned">;
  reactions?: ReactionMap;
  /** 이슈 #1112 — a reply is pinned from where it is read, like every other action. */
  pins?: PinMap;
  onOpenWorkSession?: OpenWorkSession;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ["thread", workspaceId, channelId, root.id],
    queryFn: () => fetchThreadReplies(workspaceId, channelId, root.id),
  });

  const replies = query.data?.messages ?? [];

  // 작업 세션 서랍과 동형인 키보드 탈출 (#1431 · WorkPanel.tsx openerRef/closePanel).
  // 두 서랍은 같은 오버레이 문법인데 이 서랍만 Escape 닫기와 포커스 반환이 없어,
  // 답글 컴포저에서 Escape가 무반응이었고 닫기 버튼을 누르면 포커스가 document.body로
  // 떨어졌다.
  //
  // opener를 **첫 렌더에서** 잡는 이유: 900px 미만에서 이 패널이 채널 표면을 덮는
  // 순간 그 표면(chat-region)이 inert가 되고, 그 안에 있던 opener(답글 앵커)가
  // 포커스를 잃는다 — 잃기 전에 잡아야 닫을 때 되돌려 줄 수 있다.
  const openerRef = useRef<HTMLElement | null>(null);
  if (openerRef.current === null && typeof document !== "undefined") {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
  }

  // 닫기의 유일한 경로. `onClose`가 패널을 언마운트하고(그 안에서 ChatShell이 덮개의
  // inert를 opener.focus()보다 **먼저** 뗀다 — inert가 남아 있으면 포커스가 먹지
  // 않는다), 그 다음 opener로 캐럿을 돌려준다. WorkPanel.closePanel과 같은 shape다.
  const closePanel = useCallback(() => {
    const opener = openerRef.current;
    onClose();
    if (opener?.isConnected) opener.focus();
  }, [onClose]);

  /** Per-row actions, with this row's chips and pin state folded in. */
  const rowActions = (message: Message): MessageRowActions | undefined =>
    actions && {
      ...actions,
      chips: chipsFor(reactions ?? {}, message.id, actions.myMemberId),
      pinned: isPinned(pins ?? {}, message.id),
    };

  return (
    // `thread-pane` (goal B6): 900px 위에서는 그대로 320px 열이고, 그 아래에서는
    // 채널 표면 전체를 덮는 서랍이 된다 (tokens.css). 320px 패널이 390px 화면에서
    // 채널에 70px만 남기던 자리이고, 그 문턱이 폰(600px)이 아니라 900px인 이유는
    // 같은 산술이 700px 창에서도 참이기 때문이다 — 채널에 140px, 컴포저에 36px가
    // 남았다 (#1421 실측).
    //
    // `shrink-0`은 `thread-pane`이 flex 기준선을 갖게 되면서 빠졌다 (#1418):
    // 이 pane과 작업 세션 pane은 채널 열과 같은 행을 나눠 갖고, 그 행의 바닥은
    // 채널 열이 든다(`chat-region`). 한쪽만 양보하지 못하면 바닥이 넘침이 된다.
    <aside
      aria-label="스레드"
      data-testid="thread-panel"
      onKeyDown={(event) => {
        // 작업 서랍과 동형: Escape로 서랍을 닫는다 (#1431 · WorkPanel.tsx:839-852).
        // 이 서랍은 작업 서랍의 상세/엿보기 같은 중간 단계가 없어 한 단계뿐이므로,
        // stopPropagation 없이 곧장 닫는 WorkPanel의 마지막 분기(`closePanel()`)와
        // 같다. 답글 컴포저의 멘션 목록은 공용 useEscapeLayer가 먼저 한 단계만
        // 물러나며 전파를 막는다. 목록이 닫힌 뒤의 Escape만 여기로 올라온다.
        if (event.key !== "Escape") return;
        closePanel();
      }}
      className="thread-pane flex h-full flex-col border-l border-line bg-surface"
    >
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2">
        <h2 className="text-body font-semibold">스레드</h2>
        <button
          type="button"
          onClick={closePanel}
          aria-label="스레드 닫기"
          data-testid="thread-close"
          className="tap-target flex size-6 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover focus-visible:focus-ring"
        >
          <X className="size-4" />
        </button>
      </header>

      <div
        className="min-h-0 flex-1 overflow-y-auto"
        data-message-scroll-container=""
      >
        {/* 루트에 「답글 N개」를 적지 않는다 (goal RN-U2).

            성재(iOS 실기기): "답글에서 개수 업데이트는 굳이 왜 해? 목록에 나오면
            몇 개의 reply가 있는지는 자연스러운데, 답글에서 '답글 1개' 이런 식으로
            보이는 건 자연스럽지 않은 거 같아."

            같은 제품 판단이므로 웹도 같이 고친다. 롤업은 **채널 목록에서 "여기
            스레드가 있다"를 알리는 장치**이고, 이미 그 스레드를 열어 둔 사람에게는
            자기가 서 있는 곳의 이름을 다시 읽어 주는 것에 불과하다 — 게다가 답글을
            달 때마다 숫자가 오른다.

            goal P3 1-1 이 이 자리를 <button>에서 <span>으로 내린 것이 절반이었고
            (죽은 컨트롤을 없앴다), 나머지 절반이 이것이다: 글이어도 여기서는 할 말이
            없다. */}
        <MessageRow
          message={root}
          startsGroup
          directory={directory}
          actions={rowActions(root)}
          onOpenWorkSession={onOpenWorkSession}
          showRollup={false}
        />
        {/* 루트와 답글 사이에는 선을 긋지 않는다 (#1753). 둘은 32px 여백으로
            갈리고, 빈 상태일 때만 그 상태 자체의 조용한 점선 상자가 영역을 말한다.
            이 여백은 루트 툴바가 아래로 뒤집힐 때 쓰는 26px 띠도 함께 비워 둔다. */}
        <div className="pt-8" data-testid="thread-replies">
          {query.isLoading && <SkeletonRows rows={3} className="p-4" />}
          {query.error && (
            <InlineBanner
              message="답글을 불러오지 못했습니다."
              actionLabel="다시 시도"
              onAction={() => void query.refetch()}
              testId="thread-error"
            />
          )}
          {!query.isLoading && !query.error && replies.length === 0 && (
            <EmptyInvite
              headline="첫 답글을 남겨 이 대화를 이어가세요."
              className="mx-4 rounded-md border border-dashed border-line"
              testId="thread-empty"
            />
          )}
          {replies.map((reply, index) => (
            <MessageRow
              key={reply.seq}
              message={reply}
              startsGroup={startsAuthorGroup(replies[index - 1], reply)}
              directory={directory}
              actions={rowActions(reply)}
              onOpenWorkSession={onOpenWorkSession}
              // 답글은 애초에 롤업을 갖지 않는다(서버 투영이 `root_id IS NULL` 로
              // 거른다 — 스레드는 한 단계다). 명시해 두는 것은 그 불변식이 깨져
              // 답글에 `thread` 가 실려 오는 날에도 이 화면이 답글 밑에 답글이 있다고
              // 말하지 않게 하기 위해서다.
              showRollup={false}
            />
          ))}
        </div>
      </div>

      {/* B11 — the half that was missing. Reading a thread and not being able
          to answer in it made 답글 a link to a transcript. Offered only where
          the surface is a conversation: the work session panel passes no
          `actions`, and its event log stays read-only. */}
      {actions && (
        <ThreadComposer
          workspaceId={workspaceId}
          channelId={channelId}
          rootId={root.id}
          directory={directory}
          channels={channels}
          onSent={() => void query.refetch()}
        />
      )}
    </aside>
  );
}
