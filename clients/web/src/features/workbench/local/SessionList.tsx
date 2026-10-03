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
  ChevronRight,
  Folder,
  GitBranch,
  Layers,
  Plus,
  Radio,
  Search,
  X,
} from "lucide-react";
import { cn } from "@/design/lib/cn";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/design/ui/context-menu";
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
import { SessionStateChip } from "@/features/sidebar/SessionStateChip";
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
// - 접기·펴기 단추는 이 목록에 없다(#3280): 제목줄의 단추와 ⌘B가 모든 탭이 공유하는 한 상태
//   (`app/sidebarCollapseStore`)를 토글한다. ⌘J는 접힌 목록을 펴고 캐럿을 보낸다.
// - 필터 칩(전부·응답 필요·공유)과 묶기(저장소·상태)는 이 기기에 기억한다.

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

/** 행 우클릭 메뉴의 한 항목(#2867 「채널에 공유」·「링크 복사」·「공유 끄기」). */
export interface SessionRowMenuEntry {
  id: string;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

export interface SessionListHandle {
  /** ⌘J: 지금 칸의 행(없으면 첫 행)으로 캐럿을 보낸다. */
  focus(): void;
}

export interface SessionListProps {
  sessions: readonly SessionListInput[];
  focusedPaneId: string | null;
  platform: KeyPlatform;
  onActivate: (paneId: string) => void;
  onMaximize: (paneId: string) => void;
  onFocusIndex: (index: number) => void;
  /** 「새 세션」 메뉴의 항목들(도크와 같은 메뉴). 트리거는 목록이 그린다. */
  newSessionItems: ReactNode;
  onNewSessionMenuCloseAutoFocus?: (event: Event) => void;
  /**
   * 행 우클릭(키보드는 메뉴 키·Shift+F10) 메뉴(#2867). 없거나 빈 목록이면 그 행은 메뉴가
   * 없다(A 세션 행). 항목은 호스트가 정하고, 목록은 그리기만 한다.
   */
  rowMenu?: (paneId: string) => readonly SessionRowMenuEntry[] | null;
}

export const SessionList = forwardRef<SessionListHandle, SessionListProps>(function SessionList(
  {
    sessions,
    focusedPaneId,
    platform,
    onActivate,
    onMaximize,
    onFocusIndex,
    newSessionItems,
    onNewSessionMenuCloseAutoFocus,
    rowMenu,
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
  const repoGone = repo !== undefined && !model.repos.some((r) => r.id === repo);
  if (repoGone) setRepo(undefined);

  const rowButtons = () =>
    [...(treeRef.current?.querySelectorAll<HTMLButtonElement>("[data-session-row]") ?? [])];
  /** 트리의 모든 항목(묶음 머리 + 세션 줄), 화면 순서. */
  const treeItems = () =>
    [...(treeRef.current?.querySelectorAll<HTMLButtonElement>("[data-tree-item]") ?? [])];
  const toggleGroup = (key: string, open?: boolean) =>
    setFolded((prev) => {
      const next = new Set(prev);
      const isOpen = !next.has(key);
      if ((open ?? !isOpen) === true) next.delete(key);
      else next.add(key);
      return next;
    });

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
    const items = treeItems();
    const active = document.activeElement as HTMLButtonElement | null;
    const at = active ? items.indexOf(active) : -1;
    // WAI-ARIA 트리: ←는 펼친 묶음을 접거나 줄에서 제 묶음 머리로, →는 접힌 묶음을 편다.
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && active && at >= 0) {
      const groupKey = active.dataset.groupHeader;
      if (groupKey !== undefined) {
        const open = active.getAttribute("aria-expanded") === "true";
        if (event.key === "ArrowLeft" && open) toggleGroup(groupKey, false);
        else if (event.key === "ArrowRight" && !open) toggleGroup(groupKey, true);
        else if (event.key === "ArrowRight" && open) items[at + 1]?.focus();
      } else if (event.key === "ArrowLeft" && active.dataset.inGroup) {
        items.find((b) => b.dataset.groupHeader === active.dataset.inGroup)?.focus();
      }
      event.preventDefault();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    if (items.length === 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : Math.min(items.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)));
    items[next]?.focus();
  };

  const selectedRepo = repo === undefined ? null : model.repos.find((r) => r.id === repo) ?? null;
  const onlyRepo = model.repos.length === 1 ? model.repos[0]! : null;
  const shownRepo = selectedRepo ?? onlyRepo;
  const repoName = shownRepo?.name ?? "모든 저장소";
  const totalWorktrees = (shownRepo ? [shownRepo] : model.repos).reduce((n, r) => n + r.worktrees, 0);
  const totalSessions = (shownRepo ? [shownRepo] : model.repos).reduce((n, r) => n + r.sessions, 0);
  const sharedCount = sessions.filter((s) => s.shared).length;
  // 트리 항목에 tabIndex 0을 하나만 둔다(로빙). 지금 칸 행, 없으면 그려진 첫 행, 그것도
  // 없으면(묶음이 다 접힘) 첫 묶음 머리. 접힌 묶음 안의 행은 그려지지 않는다.
  const renderedIds: string[] = [];
  let firstGroup: string | null = null;
  {
    let group: string | null = null;
    for (const r of model.rows) {
      if (r.kind === "group") {
        group = r.key;
        firstGroup ??= r.key;
      } else if (r.kind === "session" && !(group !== null && folded.has(group))) renderedIds.push(r.paneId);
    }
    for (const p of model.pending) renderedIds.push(p.paneId);
  }
  const tabStop = renderedIds.includes(focusedPaneId ?? "") ? focusedPaneId : renderedIds[0] ?? null;
  const groupTabStop = tabStop === null ? firstGroup : null;

  let currentGroup: string | null = null;
  let currentWorktree: string | null = null;
  const tree: ReactNode[] = [];
  for (const row of model.rows) {
    if (row.kind === "group") {
      currentGroup = row.key;
      currentWorktree = null;
      const open = !folded.has(row.key);
      tree.push(
        <button
          key={row.key}
          type="button"
          role="treeitem"
          aria-level={1}
          className="sl-group press-instant-fill focus-visible:focus-ring"
          aria-expanded={open}
          data-tree-item=""
          data-group-header={row.key}
          tabIndex={row.key === groupTabStop ? 0 : -1}
          data-testid="session-list-group"
          onClick={() => toggleGroup(row.key)}
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
      currentWorktree = worktreeText(row.branch, row.folder, row.isDefault, row.diff);
      // 머리 줄의 내용은 그 아래 세션 줄의 이름(aria-label)에 실린다.
      tree.push(
        <div key={row.key} className="sl-wt" aria-hidden data-testid="session-list-worktree">
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
        level={(currentGroup !== null ? 2 : 1) + row.depth}
        group={currentGroup}
        parentWorktree={row.depth === 1 ? currentWorktree : null}
        current={row.paneId === focusedPaneId}
        tabStop={row.paneId === tabStop}
        onActivate={onActivate}
        onMaximize={onMaximize}
        menu={rowMenu?.(row.paneId) ?? null}
      />
    );
  }
  // 확인 중(첫 git 읽기 전)인 세션: 묶지 않고 끝에 둔다. worktree 줄 자리는 높이를 지키는 막대다.
  const pendingRows = model.pending.map((p) => (
    <SessionRowButton
      key={p.paneId}
      row={{
        kind: "session",
        paneId: p.paneId,
        index: p.index,
        title: p.title,
        harness: p.harness,
        status: p.status,
        shared: p.shared,
        worktree: null,
        branch: null,
        detached: false,
        diff: null,
        isDefault: false,
        repo: null,
        depth: 0,
      }}
      checking
      level={1}
      group={null}
      parentWorktree={null}
      current={p.paneId === focusedPaneId}
      tabStop={p.paneId === tabStop}
      onActivate={onActivate}
      onMaximize={onMaximize}
      menu={rowMenu?.(p.paneId) ?? null}
    />
  ));

  const filters: SessionFilter[] = ["all", "waiting", "shared"];

  return (
    <aside id="session-list-column" className="sl shell-swap-in" aria-labelledby="session-list-title" data-testid="session-list">
      <div className="sl-hd">
        <h2 id="session-list-title">이 기기의 세션</h2>
        {/* 시안의 「⌘J 이동」은 저장소 머리에 있었다. 머리를 숨기는 저장소 하나일 때도 보이게 제목 옆에 둔다. */}
        <kbd aria-hidden title="세션 목록으로 이동">⌘J</kbd>
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
                <Layers />
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
        </div>
      </div>

      {searchOpen ? (
        <label className="sl-search">
          <Search aria-hidden />
          <input
            ref={searchRef}
            type="text"
            role="searchbox"
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
              <DropdownMenuRadioItem key={r.id ?? ""} value={r.id === null ? "" : `r:${r.id}`}>
                <span className="min-w-0 truncate">{r.name}</span>
                <span data-numeric className="ml-auto pl-4 text-meta text-ink-muted">
                  {r.sessions}
                </span>
                {repo === r.id ? <Check aria-hidden className="size-4" /> : null}
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
        role="tree"
        aria-label="세션"
        aria-keyshortcuts="Meta+J"
        tabIndex={-1}
        data-testid="session-list-tree"
        onKeyDown={onTreeKeyDown}
      >
        {model.rows.length === 0 && model.pending.length === 0 ? (
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
          <>
            {tree}
            {pendingRows}
          </>
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
            <b>{`${sharedCount}개 공유 중`}</b> · 팀은 이름·상태·worktree만 봐요
          </span>
        ) : (
          <span>
            <b>공유 없음</b> · 이 기기에서만 보여요
          </span>
        )}
      </p>
    </aside>
  );
});

/**
 * 상태 표지(시안 `.st`): 모양 + 글자. 칸 머리(#2776)도 같은 표지를 쓴다.
 * `srLabel`이면 글자를 읽기 도구에만 남긴다(칸 머리는 시안처럼 모양만 보인다).
 */
export function StatusMark({
  status,
  withLabel = false,
  srLabel = false,
}: {
  status: SessionStatus;
  withLabel?: boolean;
  srLabel?: boolean;
}) {
  return (
    <span className="sl-st" data-status={status} data-testid="status-mark">
      <i aria-hidden />
      {withLabel ? SESSION_STATUS_LABEL[status] : null}
      {srLabel ? <span className="sr-only">{SESSION_STATUS_LABEL[status]}</span> : null}
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

/** worktree 줄을 읽기 도구용 한 문장으로. */
function worktreeText(
  branch: string | null,
  folder: string | null,
  isDefault: boolean,
  diff: WorktreeRow["diff"]
): string {
  const name = branch ?? `${folder ?? ""} 분리된 HEAD`.trim();
  const extra = isDefault ? "기본" : diff ? `추가 ${diff.added}줄, 삭제 ${diff.deleted}줄` : null;
  return extra ? `${name}, ${extra}` : name;
}

function WorktreeLabel({
  row,
  repo = null,
}: {
  row: Pick<WorktreeRow, "branch" | "isDefault" | "diff"> & { folder?: string | null; worktree?: string | null };
  repo?: string | null;
}) {
  const folder = row.folder ?? row.worktree ?? null;
  const name = row.branch ?? (folder ? `${folder} (분리된 HEAD)` : "분리된 HEAD");
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
  level,
  group,
  parentWorktree,
  checking = false,
  current,
  tabStop,
  onActivate,
  onMaximize,
  menu = null,
}: {
  row: SessionRow;
  level: number;
  group: string | null;
  parentWorktree: string | null;
  checking?: boolean;
  current: boolean;
  tabStop: boolean;
  onActivate: (paneId: string) => void;
  onMaximize: (paneId: string) => void;
  menu?: readonly SessionRowMenuEntry[] | null;
}) {
  const label = SESSION_STATUS_LABEL[row.status];
  // 평탄화된 줄(worktree에 세션 하나, 또는 상태로 묶기)은 worktree 줄을 함께 싣는다.
  const withWorktree = row.worktree !== null || row.repo !== null;
  const where = [
    row.repo,
    row.worktree !== null ? worktreeText(row.branch, row.worktree, row.isDefault, row.diff) : null,
    parentWorktree,
    checking ? "git 확인 중" : null,
  ]
    .filter(Boolean)
    .join(", ");
  const button = (
    <button
      type="button"
      role="treeitem"
      aria-level={level}
      aria-selected={current}
      className="sl-row press-instant-fill focus-visible:focus-ring"
      data-tree-item=""
      data-in-group={group ?? undefined}
      data-session-row=""
      data-session-pane={row.paneId}
      data-status={row.status}
      data-depth={row.depth}
      data-with-worktree={withWorktree || checking ? "" : undefined}
      data-checking={checking ? "" : undefined}
      data-testid="session-list-row"
      aria-current={current ? "true" : undefined}
      aria-label={`${row.index}번 칸, ${row.title}, ${label}, ${row.harness}${row.shared ? ", 공유됨" : ""}${where ? `, ${where}` : ""}`}
      tabIndex={tabStop ? 0 : -1}
      onClick={() => onActivate(row.paneId)}
      onDoubleClick={() => onMaximize(row.paneId)}
    >
      {checking ? (
        <span className="sl-wt sl-checking" aria-hidden>
          <GitBranch />
          <span className="sl-bar" />
        </span>
      ) : withWorktree ? (
        <span className="sl-wt" aria-hidden>
          <GitBranch />
          {row.worktree !== null ? (
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
        <span className="sl-t" title={row.title}>
          {row.title}
        </span>
        {row.shared ? <Radio className="sl-shr" /> : null}
        <span className="sl-h">{row.harness}</span>
        {/* 상태는 글자 칩이 말한다(#3338, 표시 문법): 팀 작업 목록·구획 B와 같은 컴포넌트다. */}
        <SessionStateChip status={row.status} testId="session-row-chip" />
      </span>
    </button>
  );
  if (!menu || menu.length === 0) return button;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
      <ContextMenuContent data-testid="session-list-row-menu">
        {menu.map((entry) => (
          <ContextMenuItem key={entry.id} disabled={entry.disabled} onSelect={entry.onSelect} data-testid={`session-row-menu-${entry.id}`}>
            {entry.label}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
