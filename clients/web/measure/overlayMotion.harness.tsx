import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@/design/ui/button";
import { SectionDeleteConfirmDialog } from "@/features/sidebar/SidebarSectionDialogs";
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
 * UX-R1a browser probe. Not a product route. Lives under measure/ so a
 * module-scope createRoot cannot become a second React root over the app.
 * The dialog under test is a shipped product dialog (SectionDeleteConfirmDialog),
 * not a synthetic always-mounted DialogContent.
 */
export function Harness() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [clicks, setClicks] = useState(0);

  return (
    <div>
      <Button data-testid="open-dialog" onClick={() => setDialogOpen(true)}>
        대화 상자 열기
      </Button>
      <SectionDeleteConfirmDialog
        open={dialogOpen}
        name="기획"
        opener={null}
        onOpenChange={setDialogOpen}
        onConfirm={() => setDialogOpen(false)}
      />

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
