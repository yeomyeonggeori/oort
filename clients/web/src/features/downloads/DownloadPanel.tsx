import {
  ExternalLink,
  FileText,
  FolderOpen,
  FolderSearch,
  ImageIcon,
  RefreshCw,
  RotateCw,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { isImageMime, splitFileName } from "@momo/core/features/attachments/model";
import {
  DOWNLOAD_COPY,
  rowActionLabel,
  rowStatusLine,
  rowTitle,
} from "./downloadsCopy";
import {
  itemRatio,
  rowActions,
  type DownloadItem,
  type DownloadList,
  type RowAction,
} from "./downloadsModel";

// 상단 오른쪽 다운로드 단추의 패널 (#4587). 표시만 한다: 상태는 스토어가, 행동은 부모가 쥔다.
//
// 읽기: 창 위쪽 띠에서 열리는 목록 팝오버 · 팀 내부 사용자(데스크탑) · 밀도 6/10 · 모션 2/10.
// 한 줄 행(아이콘 · 이름과 상태 · 오른쪽 행동)이고 카드로 감싸지 않는다. 이름은 가운데 생략으로
// 확장자를 지킨다(`splitFileName`). 행동은 아이콘 단추이며 이름(aria-label)은 파일 이름 + 행동이다.

type Icon = ComponentType<SVGProps<SVGSVGElement>>;

const ACTION_ICON: Record<RowAction, Icon> = {
  open: ExternalLink,
  reveal: FolderSearch,
  redownload: RotateCw,
  retry: RefreshCw,
};

/** 행 끝 아이콘 단추: 상단 줄의 토글·머리 단추와 같은 크기와 상태 어휘. */
const ROW_BUTTON_CLASS =
  "flex size-control-sm shrink-0 items-center justify-center rounded-md text-ink-muted press hover:bg-surface-hover hover:text-ink focus-visible:focus-ring";

function RowProgress({ item, title }: { item: DownloadItem; title: string }) {
  const ratio = itemRatio(item);
  return (
    <progress
      data-upload-progress
      data-testid="download-row-progress"
      className="mt-1 block h-marker w-full"
      // `value`를 아예 달지 않는 것이 길이를 모르는 막대다(잰 값 없이 퍼센트를 만들지 않는다).
      {...(ratio === null ? {} : { value: ratio, max: 1 })}
      aria-label={`${title} 받는 중`}
    />
  );
}

function DownloadRow({
  item,
  notice,
  onAction,
}: {
  item: DownloadItem;
  notice: string | undefined;
  onAction: (item: DownloadItem, action: RowAction) => void;
}) {
  const title = rowTitle(item);
  const { head, tail } = splitFileName(title);
  const FileIcon = isImageMime(item.mime) ? ImageIcon : FileText;
  const missing = item.phase === "done" && item.present === false;
  const failed = item.phase === "failed";
  return (
    <li
      data-testid="download-row"
      data-phase={item.phase}
      data-present={item.present === null ? undefined : String(item.present)}
      className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-surface-hover"
    >
      <FileIcon aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span
          title={title}
          className={cn("flex min-w-0 text-label", missing ? "text-ink-muted" : "text-ink")}
        >
          {/* `splitFileName`은 확장자 앞 두 글자까지를 꼬리로 떼므로 앞부분이 공백으로 끝날 수 있다(「끊기는 」+「파일.zip」).
              `truncate`의 `white-space: nowrap`은 줄 끝 공백을 접어 「끊기는파일.zip」으로 붙여 버리므로(실기 캡처에서 확인),
              공백을 지키는 `whitespace-pre`로 줄인다. 줄임표는 그대로 앞부분 끝에 선다. */}
          <span className="overflow-hidden text-ellipsis whitespace-pre">{head}</span>
          <span className="shrink-0">{tail}</span>
        </span>
        <span
          data-testid="download-row-status"
          className={cn("text-meta break-keep", failed ? "text-danger" : "text-ink-muted")}
        >
          {rowStatusLine(item)}
        </span>
        {item.phase === "receiving" && <RowProgress item={item} title={title} />}
        {notice !== undefined && (
          <span role="status" data-testid="download-row-notice" className="text-meta break-keep text-danger">
            {notice}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {rowActions(item).map((action) => {
          const ActionIcon = ACTION_ICON[action];
          const label = rowActionLabel(action);
          return (
            <button
              key={action}
              type="button"
              onClick={() => onAction(item, action)}
              aria-label={`${title} ${label}`}
              title={label}
              data-testid={`download-action-${action}`}
              className={ROW_BUTTON_CLASS}
            >
              <ActionIcon aria-hidden="true" className="size-4" />
            </button>
          );
        })}
      </div>
    </li>
  );
}

export function DownloadPanel({
  items,
  notices,
  folderNotice,
  onAction,
  onOpenFolder,
}: {
  items: DownloadList;
  /** 행 아래에 말할 한 줄(열기 실패 등), 행 id별. */
  notices: Readonly<Record<string, string>>;
  folderNotice: string | null;
  onAction: (item: DownloadItem, action: RowAction) => void;
  onOpenFolder: () => void;
}) {
  return (
    <section aria-label={DOWNLOAD_COPY.title} data-testid="download-panel" className="flex flex-col gap-2">
      <header className="flex items-center justify-between gap-2">
        <h2 className="px-2 text-heading font-bold text-ink">{DOWNLOAD_COPY.title}</h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onOpenFolder}
          data-testid="download-open-folder"
        >
          <FolderOpen aria-hidden="true" />
          {DOWNLOAD_COPY.openFolder}
        </Button>
      </header>
      {folderNotice !== null && (
        <p role="status" data-testid="download-folder-notice" className="px-2 text-meta break-keep text-danger">
          {folderNotice}
        </p>
      )}
      {items.length === 0 ? (
        <div data-testid="download-empty" className="flex flex-col gap-1 px-2 py-4">
          <p className="text-label break-keep text-ink">{DOWNLOAD_COPY.empty}</p>
          <p className="text-meta break-keep text-ink-muted">{DOWNLOAD_COPY.emptyHint}</p>
        </div>
      ) : (
        <ul data-testid="download-list" className="flex max-h-pane flex-col overflow-y-auto">
          {items.map((item) => (
            <DownloadRow key={item.id} item={item} notice={notices[item.id]} onAction={onAction} />
          ))}
        </ul>
      )}
      <p className="px-2 text-meta break-keep text-ink-muted">{DOWNLOAD_COPY.saveLocation}</p>
    </section>
  );
}
