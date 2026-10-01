import { useNavigate } from "react-router-dom";
import { relativeLabel } from "@momo/core/features/inbox/model";
import { waitingLine } from "@momo/core/features/workbench/paneStatus";
import { MY_WORK_PATH } from "@momo/core/features/workbench/workTab";
import { StatusMark } from "@/features/workbench/local/SessionList";
import {
  focusStoredPane,
  paneAttention,
  useLocalPaneAttention,
  type PaneAttention,
} from "@/features/workbench/local/paneAttention";

// Reading this as: 인박스 「이 기기의 칸」 줄 for internal team users on Tauri desktop,
// density 7/10, motion 0/10.
//
// #2776: 로컬 칸이 「응답 필요」·「끝남」이 되면 여기 한 줄로 합류한다. 서버 원장이
// 아니라 이 기기의 칸이므로 채널 행(FeedItem)과 섞지 않고, 탭과 무관하게 목록 위에
// 둔다(서버가 결정 대기 탭을 싣지 않아도 보인다). 누르면 「내 작업」의 그 칸으로 간다.
// 칸을 보면 줄이 내려간다. 비어 있으면 아무것도 그리지 않는다.

export function LocalPaneInbox({ store = paneAttention() }: { store?: PaneAttention }) {
  const entries = useLocalPaneAttention(store);
  const navigate = useNavigate();
  if (entries.length === 0) return null;
  const now = Date.now();
  const ordered = [...entries].sort(
    (a, b) => (a.status === b.status ? b.atMs - a.atMs : a.status === "waiting" ? -1 : 1)
  );
  return (
    <section aria-labelledby="inbox-local-panes" className="border-b border-line px-4 py-2" data-testid="inbox-local-panes">
      <h2 id="inbox-local-panes" className="text-meta font-semibold text-ink-muted">
        이 기기의 칸
      </h2>
      <ul className="flex flex-col">
        {ordered.map((e) => (
          <li key={e.paneId}>
            <button
              type="button"
              data-testid="inbox-local-pane"
              data-status={e.status}
              onClick={() => {
                focusStoredPane(e.paneId);
                navigate(MY_WORK_PATH);
              }}
              className="flex h-control w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-body hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring"
            >
              <StatusMark status={e.status} srLabel />
              <span data-numeric className="shrink-0 font-mono text-meta text-ink-muted">
                {e.index}
              </span>
              <span className="min-w-0 truncate font-medium text-ink">{e.name}</span>
              <span className="min-w-0 flex-1 truncate text-ink-muted">
                {e.status === "waiting" ? waitingLine(e.signal) ?? "입력을 기다려요" : "작업이 끝났어요"}
              </span>
              <span className="shrink-0 text-timestamp text-ink-muted">{relativeLabel(e.atMs, now)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
