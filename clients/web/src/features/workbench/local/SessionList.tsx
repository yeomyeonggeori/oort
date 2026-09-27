import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Folder,
  GitBranch,
  ListTree,
  Plus,
  Radio,
  Search,
  X,
} from "lucide-react";
import { cn } from "@/design/lib/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import {
  SESSION_FILTER_LABEL,
  SESSION_GROUPING_LABEL,
  SESSION_LIST_EMPTY,
  SESSION_STATUS_LABEL,
  buildSessionList,
  type SessionFilter,
  type SessionGrouping,
  type SessionListInput,
  type SessionRow,
  type SessionStatus,
  type WorktreeRow,
} from "@momo/core/features/workbench/sessionList";
import { resolveWorkbenchKey, type KeyPlatform } from "@momo/core/features/workbench/keymap";
import "./sessionList.css";

// Reading this as: 작업 탭 세션 목록(시안 ① `.slist`) for internal team users on
// Tauri desktop, density 7/10, motion 1/10.
//
// 저장소 → worktree → 세션(#2856, 제안서 §3.2). 모델은 코어 `sessionList.ts`가
// 짓고, 여기는 그리기와 키만 한다.
//
// - 행을 누르면 그 칸에 포커스, 두 번 누르면 최대화(§3.2). Enter도 포커스다.
// - ⌘J(작업 탭)는 이 목록의 지금 칸 행으로 캐럿을 보낸다. ↑↓로 옮기고 Enter.
// - ⌃1–9는 목록 안에서도 칸 번호로 간다(격자 밖이라 격자 키가 받지 못한다).
//   ⌘⇧↵는 포커스 칸 최대화.
// - 필터 칩(전부·나를 기다림·공유)과 묶기(저장소·상태)는 이 기기에 기억한다.

const PREFS_KEY = "momo.web.workbench.sessionList.v1";

interface Prefs {
  filter: SessionFilter;
  grouping: SessionGrouping;
}

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<Prefs> | null;
    return {
      filter: raw?.filter === "waiting" || raw?.filter === "shared" ? raw.filter : "all",
      grouping: raw?.grouping === "status" ? "status" : "repo",
    };
  } catch {
    return { filter: "all", grouping: "repo" };
  }
}

function savePrefs(prefs: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* 저장소가 없으면 이번 실행에만 기억한다 */
  }
}

export interface SessionListHandle {
  /** ⌘J: 지금 칸의 행(없으면 첫 행)으로 캐럿을 보낸다. */
  focus(): void;
}

export interface SessionListProps {
  sessions: readonly SessionListInput[];
  /** 첫 git 읽기가 끝나지 않았다(높이를 지키는 막대를 보인다). */
  loading: boolean;
  focusedPaneId: string | null;
  platform: KeyPlatform;
  onActivate: (paneId: string) => void;
  onMaximize: (paneId: string) => void;
  onFocusIndex: (index: number) => void;
  onCollapse: () => void;
  /** 「새 세션」 메뉴의 항목들(도크와 같은 메뉴). 트리거는 목록이 그린다. */
  newSessionItems: ReactNode;
  onNewSessionMenuCloseAutoFocus?: (event: Event) => void;
}

export const SessionList = forwardRef<SessionListHandle, SessionListProps>(function SessionList(
  {
    sessions,
    loading,
    focusedPaneId,
    platform,
    onActivate,
    onMaximize,
    onFocusIndex,
    onCollapse,
    newSessionItems,
    onNewSessionMenuCloseAutoFocus,
  },
  ref
) {
  const [prefs, setPrefs] = useState(loadPrefs);
  const [repo, setRepo] = useState<string | null | undefined>(undefined);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const treeRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const updatePrefs = (next: Partial<Prefs>) => {
    setPrefs((prev) => {
      const merged = { ...prev, ...next };
      savePrefs(merged);
      return merged;
    });
  };

  const model = useMemo(
    () => buildSessionList(sessions, { filter: prefs.filter, grouping: prefs.grouping, repo, query }),
    [sessions, prefs.filter, prefs.grouping, repo, query]
  );
  // 고른 저장소가 사라지면(칸을 닫았다) 전부로 돌아간다.
  const repoGone = repo !== undefined && !model.repos.some((r) => r.name === repo);
  if (repoGone) setRepo(undefined);

  const rowButtons = () =>
    [...(treeRef.current?.querySelectorAll<HTMLButtonElement>("[data-session-row]") ?? [])];

  useImperativeHandle(ref, () => ({
    focus() {
      const rows = rowButtons();
      const current = rows.find((b) => b.dataset.sessionPane === focusedPaneId) ?? rows[0];
      (current ?? treeRef.current)?.focus({ preventScroll: false });
    },
  }));

  const onTreeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const command = resolveWorkbenchKey(event.nativeEvent, platform);
    if (command?.type === "focus-index") {
      event.preventDefault();
      onFocusIndex(command.index);
      return;
    }
    if (command?.type === "toggle-maximize" && focusedPaneId) {
      event.preventDefault();
      onMaximize(focusedPaneId);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    const rows = rowButtons();
    if (rows.length === 0) return;
    event.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? rows.length - 1
          : Math.min(rows.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)));
    rows[next]?.focus();
  };

  const selectedRepo = repo === undefined ? null : model.repos.find((r) => r.name === repo) ?? null;
  const onlyRepo = model.repos.length === 1 ? model.repos[0]! : null;
  const shownRepo = selectedRepo ?? onlyRepo;
  const repoName =
    repo === undefined && onlyRepo === null
      ? "모든 저장소"
      : (shownRepo?.name ?? "폴더");
  const totalWorktrees = (shownRepo ? [shownRepo] : model.repos).reduce((n, r) => n + r.worktrees, 0);
  const totalSessions = (shownRepo ? [shownRepo] : model.repos).reduce((n, r) => n + r.sessions, 0);
  const sharedCount = sessions.filter((s) => s.shared).length;
  // 행에 tabIndex 0을 하나만 둔다(로빙). 지금 칸 행, 없으면 첫 행.
  const sessionIds = model.rows.filter((r): r is SessionRow => r.kind === "session").map((r) => r.paneId);
  const tabStop = sessionIds.includes(focusedPaneId ?? "") ? focusedPaneId : sessionIds[0] ?? null;

  let currentGroup: string | null = null;
  const tree: ReactNode[] = [];
  for (const row of model.rows) {
    if (row.kind === "group") {
      currentGroup = row.key;
      const open = !folded.has(row.key);
      tree.push(
        <button
          key={row.key}
          type="button"
          className="sl-group press-instant-fill focus-visible:focus-ring"
          aria-expanded={open}
          data-testid="session-list-group"
          onClick={() =>
            setFolded((prev) => {
              const next = new Set(prev);
              if (next.has(row.key)) next.delete(row.key);
              else next.add(row.key);
              return next;
            })
          }
        >
          {open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
          {row.status ? <StatusMark status={row.status} /> : null}
          <span className="min-w-0 truncate">{row.label}</span>
          <span className="sl-n" data-numeric>
            {row.count}
          </span>
        </button>
      );
      continue;
    }
    if (currentGroup !== null && folded.has(currentGroup)) continue;
    if (row.kind === "worktree") {
      tree.push(
        <div key={row.key} className="sl-wt" data-testid="session-list-worktree">
          <GitBranch aria-hidden />
          <WorktreeLabel row={row} />
        </div>
      );
      continue;
    }
    tree.push(
      <SessionRowButton
        key={row.paneId}
        row={row}
        current={row.paneId === focusedPaneId}
        tabStop={row.paneId === tabStop}
        onActivate={onActivate}
        onMaximize={onMaximize}
      />
    );
  }

  const filters: SessionFilter[] = ["all", "waiting", "shared"];

  return (
    <aside className="sl" aria-labelledby="session-list-title" data-testid="session-list">
      <div className="sl-hd">
        <h2 id="session-list-title">세션</h2>
        <div className="sl-r">
          <button
            type="button"
            className="sl-ibtn press focus-visible:focus-ring"
            aria-label="세션 찾기"
            aria-pressed={searchOpen}
            data-testid="session-list-search-toggle"
            onClick={() => {
              if (searchOpen) {
                setSearchOpen(false);
                setQuery("");
              } else {
                setSearchOpen(true);
                requestAnimationFrame(() => searchRef.current?.focus());
              }
            }}
          >
            <Search />
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="sl-ibtn press focus-visible:focus-ring"
                aria-label={`묶기: ${SESSION_GROUPING_LABEL[prefs.grouping]}`}
                title={`묶기: ${SESSION_GROUPING_LABEL[prefs.grouping]}`}
                data-testid="session-list-grouping"
              >
                <ListTree />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" data-testid="session-list-grouping-menu">
              <DropdownMenuLabel id="session-list-grouping-label">묶기</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                aria-labelledby="session-list-grouping-label"
                value={prefs.grouping}
                onValueChange={(value) => updatePrefs({ grouping: value === "status" ? "status" : "repo" })}
              >
                {(["repo", "status"] as const).map((g) => (
                  <DropdownMenuRadioItem key={g} value={g} data-testid={`session-list-grouping-${g}`}>
                    {SESSION_GROUPING_LABEL[g]}
                    {prefs.grouping === g ? <Check aria-hidden className="ml-auto size-4" /> : null}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled layout="stack" data-testid="session-list-grouping-pr">
                PR
                <span className="text-meta text-ink-muted">PR 정보를 읽게 되면 켜집니다</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            className="sl-ibtn press focus-visible:focus-ring"
            aria-label="목록 접기"
            title="목록 접기"
            data-testid="session-list-collapse"
            onClick={onCollapse}
          >
            <ChevronLeft />
          </button>
        </div>
      </div>

      {searchOpen ? (
        <label className="sl-search">
          <Search aria-hidden />
          <input
            ref={searchRef}
            type="search"
            value={query}
            placeholder="이름·브랜치·하네스"
            aria-label="세션 찾기"
            data-testid="session-list-search"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setQuery("");
                setSearchOpen(false);
              }
            }}
          />
          {query ? (
            <button
              type="button"
              className="press rounded-full text-icon hover:text-ink focus-visible:focus-ring"
              aria-label="찾기 지우기"
              onClick={() => {
                setQuery("");
                searchRef.current?.focus();
              }}
            >
              <X aria-hidden className="size-4" />
            </button>
          ) : null}
        </label>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="sl-proj press-instant-fill focus-visible:focus-ring" data-testid="session-list-repo">
            <Folder aria-hidden />
            <span className="sl-name">{repoName}</span>
            <span className="sl-sub" data-numeric>
              {`${totalWorktrees} worktree · ${totalSessions} 세션`}
            </span>
            <ChevronDown aria-hidden className="sl-last" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" data-testid="session-list-repo-menu">
          <DropdownMenuRadioGroup
            aria-label="저장소"
            value={repo === undefined ? "*" : repo === null ? "" : `r:${repo}`}
            onValueChange={(value) => setRepo(value === "*" ? undefined : value === "" ? null : value.slice(2))}
          >
            <DropdownMenuRadioItem value="*">
              모든 저장소
              {repo === undefined ? <Check aria-hidden className="ml-auto size-4" /> : null}
            </DropdownMenuRadioItem>
            {model.repos.map((r) => (
              <DropdownMenuRadioItem key={r.name ?? ""} value={r.name === null ? "" : `r:${r.name}`}>
                <span className="min-w-0 truncate">{r.name ?? "폴더"}</span>
                <span data-numeric className="ml-auto pl-4 text-meta text-ink-muted">
                  {r.sessions}
                </span>
                {repo === r.name ? <Check aria-hidden className="size-4" /> : null}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="sl-chips" role="group" aria-label="세션 거르기">
        {filters.map((f) => (
          <button
            key={f}
            type="button"
            className={cn("sl-chip press focus-visible:focus-ring", prefs.filter === f && "focus-ring-on-primary")}
            aria-pressed={prefs.filter === f}
            data-testid={`session-list-filter-${f}`}
            onClick={() => updatePrefs({ filter: f })}
          >
            {f === "waiting" ? <StatusMark status="waiting" /> : null}
            {SESSION_FILTER_LABEL[f]}
            <span data-numeric>{model.counts[f]}</span>
          </button>
        ))}
      </div>

      <div
        ref={treeRef}
        className="sl-tree"
        role="group"
        aria-label="세션"
        aria-keyshortcuts="Meta+J"
        tabIndex={-1}
        data-testid="session-list-tree"
        onKeyDown={onTreeKeyDown}
      >
        {loading ? (
          <div aria-busy="true" aria-label="세션 목록을 읽고 있습니다" data-testid="session-list-loading">
            {sessions.map((s) => (
              <div key={s.paneId} className="sl-skel">
                <span />
              </div>
            ))}
          </div>
        ) : model.rows.length === 0 ? (
          <div className="sl-empty" data-testid="session-list-empty">
            <p>{query ? "찾는 세션이 없습니다." : SESSION_LIST_EMPTY[prefs.filter]}</p>
            {prefs.filter !== "all" || query ? (
              <button
                type="button"
                className="sl-chip press focus-visible:focus-ring"
                data-testid="session-list-show-all"
                onClick={() => {
                  setQuery("");
                  updatePrefs({ filter: "all" });
                }}
              >
                전부 보기
              </button>
            ) : null}
          </div>
        ) : (
          tree
        )}
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="sl-new press focus-visible:focus-ring focus-ring-on-primary"
            aria-keyshortcuts="Control+Shift+N"
            data-testid="session-list-new"
          >
            <Plus aria-hidden />
            새 세션
            <kbd>⌃⇧N</kbd>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" onCloseAutoFocus={onNewSessionMenuCloseAutoFocus}>
          {newSessionItems}
        </DropdownMenuContent>
      </DropdownMenu>
      <p className="sl-ft" data-testid="session-list-share">
        <Radio aria-hidden />
        {sharedCount > 0 ? (
          <span>
            <b>{`${sharedCount}개 공유 중`}</b> · 팀은 이름·상태만 봅니다
          </span>
        ) : (
          <span>
            <b>공유 없음</b> · 이 기기에서만 보입니다
          </span>
        )}
      </p>
    </aside>
  );
});

function StatusMark({ status, withLabel = false }: { status: SessionStatus; withLabel?: boolean }) {
  return (
    <span className="sl-st" data-status={status}>
      <i aria-hidden />
      {withLabel ? SESSION_STATUS_LABEL[status] : null}
    </span>
  );
}

function Diff({ diff }: { diff: WorktreeRow["diff"] }) {
  if (!diff) return null;
  return (
    <>
      <span className="sl-plus" data-numeric>{`+${diff.added}`}</span>
      <span className="sl-minus" data-numeric>{`−${diff.deleted}`}</span>
    </>
  );
}

function WorktreeLabel({
  row,
  repo = null,
}: {
  row: Pick<WorktreeRow, "branch" | "isDefault" | "diff"> & { folder?: string | null };
  repo?: string | null;
}) {
  const name = row.branch ?? (row.folder ? `${row.folder} (분리된 HEAD)` : "분리된 HEAD");
  return (
    <>
      {repo ? <span className="sl-repo">{`${repo} ·`}</span> : null}
      <span className="sl-br" title={name}>
        {name}
      </span>
      <span className="sl-ds">
        {row.isDefault ? <span className="sl-default">기본</span> : <Diff diff={row.diff} />}
      </span>
    </>
  );
}

function SessionRowButton({
  row,
  current,
  tabStop,
  onActivate,
  onMaximize,
}: {
  row: SessionRow;
  current: boolean;
  tabStop: boolean;
  onActivate: (paneId: string) => void;
  onMaximize: (paneId: string) => void;
}) {
  const label = SESSION_STATUS_LABEL[row.status];
  // 평탄화된 줄(worktree에 세션 하나, 또는 상태로 묶기)은 worktree 줄을 함께 싣는다.
  const withWorktree = row.branch !== null || row.repo !== null;
  const where = [row.repo, row.branch].filter(Boolean).join(" · ");
  return (
    <button
      type="button"
      className="sl-row press-instant-fill focus-visible:focus-ring"
      data-session-row=""
      data-session-pane={row.paneId}
      data-status={row.status}
      data-testid="session-list-row"
      aria-current={current ? "true" : undefined}
      aria-label={`${row.index}번 칸, ${row.title}, ${label}, ${row.harness}${row.shared ? ", 공유됨" : ""}${where ? `, ${where}` : ""}`}
      tabIndex={tabStop ? 0 : -1}
      onClick={() => onActivate(row.paneId)}
      onDoubleClick={() => onMaximize(row.paneId)}
    >
      {withWorktree ? (
        <span className="sl-wt" aria-hidden>
          <GitBranch />
          {row.branch !== null ? (
            <WorktreeLabel row={row} repo={row.repo} />
          ) : (
            <span className="sl-repo">{row.repo}</span>
          )}
        </span>
      ) : null}
      <span className="sl-ses" aria-hidden>
        <span className="sl-num" data-numeric>
          {row.index}
        </span>
        <StatusMark status={row.status} />
        <span className="sl-t" title={row.title}>
          {row.title}
        </span>
        {row.shared ? <Radio className="sl-shr" /> : null}
        <span className="sl-h">{row.harness}</span>
      </span>
    </button>
  );
}
