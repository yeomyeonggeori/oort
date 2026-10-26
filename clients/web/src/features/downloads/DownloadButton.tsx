import { Download } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/design/lib/cn";
import { Popover, PopoverContent, PopoverTrigger } from "@/design/ui/popover";
import { Tooltip } from "@/design/ui/tooltip";
import { IS_TAURI } from "@/lib/env";
import { DownloadPanel } from "./DownloadPanel";
import { DOWNLOAD_COPY, downloadButtonLabel, finishedAnnouncement } from "./downloadsCopy";
import { buttonView, type DownloadItem, type DownloadList, type RowAction } from "./downloadsModel";
import {
  downloads,
  useDownloadList,
  type DownloadsStore,
  type RowActionResult,
} from "./downloadsStore";

// 창 맨 위 오른쪽의 다운로드 단추와 그 패널 (#4587, owner 2026-10-26). 자리는 #4591이 만든
// `AppTitlebar`의 `trailing`이다.
//
//   · 셸(데스크탑)에서만 선다. 웹(브라우저)은 브라우저의 다운로드에 맡기고 단추도 패널도 그리지 않는다.
//   · 끌기 속성이 없다. 속성 없는 단추는 Tauri의 drag.js 판정에서 끌기를 빠져 눌린다(`AppTitlebar`).
//   · 단추 안: 아이콘 하나, 받는 중이면 링(`download-ring`), 끝났는데 안 본 것이 있으면 점(`download-dot`).
//     링은 잰 값으로 12칸이고, 길이를 모르면 도는 호다. 어느 쪽도 인라인 style이 없다.
//   · 툴팁은 공용 `Tooltip`이다(owner 요청, 아래 방향 · 오른쪽 끝 맞춤). 네이티브 `title`은 두지 않는다: 둘이 같이 뜬다.
//     띠 안에서는 글자 역할이 on-band로 다시 묶이므로 알약의 글자는 `--ink-base`로 되찾는다(`tooltip-surface`,
//     tokens.css). 문구는 접근성 이름과 같은 한 문자열이다. 상단 줄의 토글은 아직 `title`이다(이 PR의 범위 밖).
//   · 패널은 포털로 뜨는 `Popover`라 띠의 글자 역할 묶음 밖에서 기본 역할로 그려진다.

/** 한 행의 행동 결과를 그 행 아래의 한 줄 문장으로. 성공과 「지워짐」은 문장이 없다(행이 말한다). */
function rowNotice(action: RowAction, result: RowActionResult): string | null {
  if (result === "ok" || result === "missing") return null;
  if (result === "not-openable") return DOWNLOAD_COPY.notOpenable;
  return action === "open" ? DOWNLOAD_COPY.openFailed : DOWNLOAD_COPY.revealFailed;
}

/**
 * 브라우저에서는 아무것도 그리지 않는다. 훅은 셸 가지 안에서만 돈다. `store`는 시험이 가짜 의존을
 * 꽂은 스토어를 넣는 이음매이고, 앱은 기본 스토어를 쓴다.
 */
export function DownloadButton({ store = downloads }: { store?: DownloadsStore }) {
  return IS_TAURI ? <DownloadControl store={store} /> : null;
}

function DownloadControl({ store }: { store: DownloadsStore }) {
  const items = useDownloadList(store);
  const view = useMemo(() => buttonView(items), [items]);
  const [open, setOpen] = useState(false);
  const [notices, setNotices] = useState<Readonly<Record<string, string>>>({});
  const [folderNotice, setFolderNotice] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef<DownloadList>(items);

  // 막 끝난 건을 낭독한다: 점은 색이라 이 줄이 없으면 보조기술은 끝난 줄을 모른다.
  useEffect(() => {
    const said = finishedAnnouncement(previous.current, items);
    previous.current = items;
    if (said !== null) setAnnouncement(said);
  }, [items]);

  // 열린 동안 끝난 건은 곧바로 본 것이다(열려 있는데 점이 켜지면 안 된다).
  useEffect(() => {
    if (open) store.markSeen();
  }, [open, items, store]);

  // 열 때마다 끝난 파일이 아직 있는지 셸에 묻는다(Finder에서 지웠을 수 있다).
  useEffect(() => {
    if (!open) return;
    setFolderNotice(null);
    void store.refreshPresence();
  }, [open, store]);

  const onAction = (item: DownloadItem, action: RowAction) => {
    setNotices((current) => {
      if (!(item.id in current)) return current;
      const { [item.id]: _removed, ...rest } = current;
      return rest;
    });
    if (action === "redownload" || action === "retry") {
      // 실패는 새 행이 스스로 말한다(실패 문장과 다시 시도).
      const run = action === "retry" ? store.retry(item.id) : store.redownload(item.id);
      void run.catch(() => undefined);
      return;
    }
    void (action === "open" ? store.open(item.id) : store.reveal(item.id)).then((result) => {
      const notice = rowNotice(action, result);
      if (notice !== null) setNotices((current) => ({ ...current, [item.id]: notice }));
    });
  };

  const onOpenFolder = () => {
    setFolderNotice(null);
    void store.openFolder().then((ok) => {
      if (!ok) setFolderNotice(DOWNLOAD_COPY.folderFailed);
    });
  };

  const label = downloadButtonLabel(view);
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        {/* 툴팁은 트리거 **바깥**이다(`PinListMenu`와 같다): 안에 두면 래퍼가 Radix 트리거가 된다. 래퍼는 포커스도 끌기 속성도
            갖지 않는 `span`이고 단추 크기 그대로라 누름은 항상 단추가 받는다(끌기 판정은 `AppTitlebar.shell.test.tsx`).
            방향은 아래, 이 단추는 창의 오른쪽 끝이라 알약의 오른쪽 끝을 단추에 맞춘다(`align="end"`). 네이티브 `title`은 없다. */}
        <Tooltip label={label} side="bottom" align="end">
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={label}
              data-testid="download-button"
              data-activity={view.activity}
              data-badge={view.badge}
              className={cn(
                "relative flex size-control-sm shrink-0 items-center justify-center rounded-md press hover:bg-surface-hover focus-visible:focus-ring",
                view.activity === "progress" ? "text-ink" : "text-ink-muted",
                open && "bg-surface-hover"
              )}
            >
              <Download aria-hidden="true" className="size-4" />
              {view.activity === "progress" && (
                <span
                  aria-hidden="true"
                  data-testid="download-ring"
                  data-ring-step={view.step ?? "unknown"}
                  className={cn("download-ring", view.step === null && "spinner-busy")}
                />
              )}
              {view.badge !== "none" && (
                <span
                  aria-hidden="true"
                  data-testid="download-dot"
                  data-tone={view.badge}
                  className="download-dot"
                />
              )}
            </button>
          </PopoverTrigger>
        </Tooltip>
        {/* 대화상자의 이름은 패널 제목과 같다(design-review M5): 안쪽 section 이름만으로는 대화상자 자체가 이름 없는 그룹으로 읽혔다. */}
        <PopoverContent align="end" side="bottom" aria-label={DOWNLOAD_COPY.title}>
          <DownloadPanel
            items={items}
            notices={notices}
            folderNotice={folderNotice}
            onAction={onAction}
            onOpenFolder={onOpenFolder}
          />
        </PopoverContent>
      </Popover>
      <span role="status" data-testid="download-announcement" className="sr-only">
        {announcement}
      </span>
    </>
  );
}
