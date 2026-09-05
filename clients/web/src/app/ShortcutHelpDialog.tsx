import { useCallback, useEffect, useRef, useState } from "react";
import { CircleHelp } from "lucide-react";
import { Button } from "@/design/ui/button";
import { OPEN_DIALOG_SELECTOR } from "@/design/ui/escapeLayer";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import {
  SHORTCUT_HELP_GROUPS,
  shouldOpenShortcutHelp,
} from "@/app/keyboardShortcuts";

function anotherDialogIsOpen(): boolean {
  if (typeof document === "undefined") return false;
  // "Is another dialog *open*", not "who owns this Escape". Presence-exit
  // nodes are not open; overlayOwnsEscape(event) is the ownership predicate.
  return document.querySelector(OPEN_DIALOG_SELECTOR) !== null;
}

/**
 * 전역 단축키 도움말. 실제 버튼과 `?`가 같은 프로그램형 Dialog를 연다.
 * DialogTrigger는 쓰지 않고, 연 순간의 엘리먼트를 opener로 넘겨 WebKit에서도
 * Esc 뒤 포커스가 제자리로 돌아가게 한다.
 */
export function ShortcutHelpDialog() {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const openRef = useRef(false);
  const [open, setOpen] = useState(false);

  const setDialogOpen = useCallback((next: boolean) => {
    openRef.current = next;
    setOpen(next);
  }, []);

  const openFrom = useCallback((opener: HTMLElement | null) => {
    openerRef.current = opener;
    setDialogOpen(true);
  }, [setDialogOpen]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        openRef.current ||
        anotherDialogIsOpen() ||
        !shouldOpenShortcutHelp(event)
      ) {
        return;
      }
      event.preventDefault();
      const active = document.activeElement;
      openFrom(active instanceof HTMLElement ? active : null);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openFrom]);

  return (
    <Dialog open={open} onOpenChange={setDialogOpen}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => openFrom(triggerRef.current)}
        aria-label="단축키 도움말 열기"
        title="단축키 도움말 (?)"
        data-testid="shortcut-help-trigger"
        className="tap-target flex size-control-sm items-center justify-center rounded-sm text-ink-muted press hover:bg-surface-hover focus-visible:focus-ring"
      >
        <CircleHelp className="size-4" aria-hidden="true" />
      </button>

      <DialogContent
        opener={openerRef.current}
        className="gap-0 overflow-hidden"
        data-testid="shortcut-help-dialog"
      >
        <div className="flex flex-col gap-1 border-b border-line p-4">
          <DialogTitle>키보드 단축키</DialogTitle>
          <DialogDescription>
            입력 칸에서는 ?가 문자로 입력되고 도움말이 열리지 않습니다.
          </DialogDescription>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {SHORTCUT_HELP_GROUPS.map((group) => (
            <section key={group.id} aria-labelledby={`shortcut-group-${group.id}`}>
              <h2
                id={`shortcut-group-${group.id}`}
                className="border-b border-line px-4 py-2 text-meta font-semibold text-ink-muted"
              >
                {group.title}
              </h2>
              <dl className="flex flex-col">
                {group.shortcuts.map((shortcut) => (
                  <div
                    key={shortcut.id}
                    className="flex items-center justify-between gap-4 border-b border-line px-4 py-2 last:border-b-0"
                    data-shortcut-id={shortcut.id}
                  >
                    <dt className="min-w-0 text-body text-ink">
                      {shortcut.description}
                    </dt>
                    <dd className="flex shrink-0 items-center gap-1">
                      {shortcut.keycaps.map((keycap) => (
                        <kbd
                          key={keycap}
                          className="whitespace-nowrap rounded-sm bg-muted-soft px-2 py-1 font-mono text-meta text-ink"
                        >
                          {keycap}
                        </kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <div className="flex justify-end border-t border-line p-4">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setDialogOpen(false)}
            data-testid="shortcut-help-close"
          >
            닫기
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
