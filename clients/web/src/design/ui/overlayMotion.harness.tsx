import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/design/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/design/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/design/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/design/ui/context-menu";
import { Select } from "@/design/ui/select";

/**
 * UX-R1a browser probe mount. Not a product route. The overlayMotion test
 * bundles this file and measures computed animationName / duration on the
 * live primitives (jsdom cannot resolve CSS animation durations).
 */
function Harness() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [clicks, setClicks] = useState(0);

  return (
    <div>
      <Button data-testid="open-dialog" onClick={() => setDialogOpen(true)}>
        대화 상자 열기
      </Button>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent data-testid="dialog-content">
          <DialogTitle>채널 만들기</DialogTitle>
          <Button data-testid="dialog-action">변경 저장</Button>
        </DialogContent>
      </Dialog>

      <Popover>
        <PopoverTrigger asChild>
          <Button data-testid="open-popover">팝오버 열기</Button>
        </PopoverTrigger>
        <PopoverContent data-testid="popover-content">
          <button
            type="button"
            data-testid="popover-item"
            onClick={() => setClicks((n) => n + 1)}
          >
            항목
          </button>
          <span data-testid="popover-clicks">{clicks}</span>
        </PopoverContent>
      </Popover>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button data-testid="open-menu">메뉴 열기</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent data-testid="menu-content">
          <DropdownMenuItem data-testid="menu-item">복사</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ContextMenu>
        <ContextMenuTrigger data-testid="context-target">
          <div>우클릭 대상</div>
        </ContextMenuTrigger>
        <ContextMenuContent data-testid="context-content">
          <ContextMenuItem data-testid="context-item">삭제</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <Select data-testid="probe-select" defaultValue="auto">
        <option value="auto">자동</option>
        <option value="away">자리비움</option>
      </Select>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("overlayMotion harness: #root missing");
createRoot(root).render(<Harness />);
