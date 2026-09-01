import { useEffect, useId, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  restoreDialogOpenerFocus,
  type DialogFocusTarget,
} from "@/design/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import {
  SECTION_CREATE_TITLE,
  SECTION_DELETE_CONFIRM_BODY,
  SECTION_DELETE_CONFIRM_LABEL,
  SECTION_DELETE_LABEL,
  SECTION_NAME_FIELD_LABEL,
  SECTION_NAME_PLACEHOLDER,
  SECTION_RENAME_LABEL,
  SECTION_RENAME_TITLE,
  sectionDeleteConfirmTitle,
  sidebarSectionNameIssue,
  sidebarSectionNameIssueMessage,
  SIDEBAR_SECTION_NAME_MAX,
} from "@momo/core/features/sidebar/sidebarSections";

// =============================================================================
// 섹션 CRUD 의 그릇 (ADR-0177 D4 / BT-4 #1932).
//
// 새로 발명한 것이 없다. 이름 한 칸짜리 폼은 `CreateChannelDialog` 의 필드 문법
// (라벨 · 컨트롤 · 그 아래 한 줄이 힌트이거나 오류)이고, 삭제 확인은
// `ChannelLeaveConfirmDialog` 의 문장·버튼 차례(취소 먼저, 파괴 액션 마지막)다.
// 낱말은 전부 코어가 갖는다 - 웹과 폰이 같은 말로 같은 것을 부른다.
//
// ## 저장이 여기 없다
//
// 만들기·이름 바꾸기·삭제는 전부 **로컬 편집**이고 저장은 `useSidebarPrefs` 의
// 디바운스가 뒤따른다(ADR-0177 D2 - 이벤트가 없으므로 서버 답을 기다릴 이유가
// 없다). 그래서 이 다이얼로그에는 「저장 중」도 실패 배너도 없다: 실패는 2초 뒤
// 사이드바에서 배너 한 줄로 말하고, 그때 이 다이얼로그는 이미 닫혀 있다. 여기서
// 왕복을 기다리는 척하는 것이 오히려 거짓말이다.
// =============================================================================

/**
 * 섹션 이름 한 칸. 만들기와 이름 바꾸기가 **같은 폼**이다 - 두 다이얼로그를 두면
 * 같은 규칙(빈 이름 금지 · 80자)이 두 번 적히고, 한쪽만 고쳐지는 날이 온다.
 */
export function SectionNameDialog({
  mode,
  open,
  initialName = "",
  opener,
  onOpenChange,
  onSubmit,
}: {
  mode: "create" | "rename";
  open: boolean;
  initialName?: string;
  /** 닫힐 때 캐럿을 되돌려 줄 컨트롤. */
  opener: DialogFocusTarget | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string) => void;
}) {
  const fieldId = useId();
  const [name, setName] = useState(initialName);
  const [touched, setTouched] = useState(false);

  // 열릴 때마다 대상의 현재 이름으로 되돌린다. 이름 바꾸기를 취소하고 다른
  // 섹션을 열었을 때 앞 섹션의 글자가 남아 있으면, 그것을 저장하는 사고가 난다.
  useEffect(() => {
    if (open) {
      setName(initialName);
      setTouched(false);
    }
  }, [open, initialName]);

  const issue = sidebarSectionNameIssue(name);
  // 아직 아무것도 안 친 빈 칸에 붉은 문장을 세우지 않는다. 제출을 눌렀을 때
  // (혹은 한 번 고쳤다가 지웠을 때) 비로소 말한다.
  const error = touched && issue ? sidebarSectionNameIssueMessage(issue) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) restoreDialogOpenerFocus(opener);
      }}
    >
      {open && (
        <DialogContent
          className="gap-4 p-4"
          data-testid="sidebar-section-name-dialog"
        >
          <div className="flex flex-col gap-1">
            <DialogTitle>
              {mode === "create" ? SECTION_CREATE_TITLE : SECTION_RENAME_TITLE}
            </DialogTitle>
            <DialogDescription>
              사이드바에서 이 이름으로 채널을 묶습니다.
            </DialogDescription>
          </div>
          <form
            className="flex min-w-0 flex-col gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              setTouched(true);
              if (issue) return;
              onSubmit(name.trim());
              onOpenChange(false);
              restoreDialogOpenerFocus(opener);
            }}
          >
            <label htmlFor={fieldId} className="text-meta text-ink-muted">
              {SECTION_NAME_FIELD_LABEL}
            </label>
            <Input
              id={fieldId}
              autoFocus
              value={name}
              maxLength={SIDEBAR_SECTION_NAME_MAX}
              placeholder={SECTION_NAME_PLACEHOLDER}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? `${fieldId}-error` : undefined}
              onChange={(event) => {
                setTouched(true);
                setName(event.target.value);
              }}
              data-testid="sidebar-section-name-input"
            />
            {error ? (
              <p
                className="text-meta text-danger"
                role="alert"
                id={`${fieldId}-error`}
                data-testid="sidebar-section-name-error"
              >
                {error}
              </p>
            ) : (
              <p className="text-meta text-ink-muted">
                {SIDEBAR_SECTION_NAME_MAX}자까지 쓸 수 있습니다.
              </p>
            )}
            <div className="flex items-center justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  onOpenChange(false);
                  restoreDialogOpenerFocus(opener);
                }}
                data-testid="sidebar-section-name-cancel"
              >
                취소
              </Button>
              <Button
                type="submit"
                size="sm"
                data-testid="sidebar-section-name-submit"
              >
                {mode === "create" ? "만들기" : "이름 바꾸기"}
              </Button>
            </div>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}

/**
 * 섹션 삭제 확인.
 *
 * 확인을 두는 이유는 되돌릴 수 없어서가 아니라(섹션은 다시 만들면 된다) **무엇이
 * 사라지지 않는지**를 말해야 해서다: 「섹션 삭제」를 읽은 사람이 가장 먼저 묻는
 * 것은 "그럼 그 채널들은?" 이고, 그 답이 화면에 없으면 누르지 못한다.
 */
export function SectionDeleteConfirmDialog({
  open,
  name,
  opener,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  name: string;
  opener: DialogFocusTarget | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) restoreDialogOpenerFocus(opener);
      }}
    >
      {open && (
        <DialogContent
          className="gap-4 p-4"
          data-testid="sidebar-section-delete-confirm"
        >
          <div className="flex flex-col gap-1">
            <DialogTitle>{sectionDeleteConfirmTitle(name)}</DialogTitle>
            <DialogDescription>{SECTION_DELETE_CONFIRM_BODY}</DialogDescription>
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                onOpenChange(false);
                restoreDialogOpenerFocus(opener);
              }}
              data-testid="sidebar-section-delete-cancel"
            >
              취소
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={() => {
                onConfirm();
                onOpenChange(false);
                restoreDialogOpenerFocus(opener);
              }}
              data-testid="sidebar-section-delete-action"
            >
              {SECTION_DELETE_CONFIRM_LABEL}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

/**
 * 커스텀 섹션 헤더의 ⋮ - 이름 바꾸기와 삭제.
 *
 * 기본 섹션(채널 · DM)에는 서지 않는다: ADR-0177 D4 가 그 둘을 삭제 불가 ·
 * 이름변경 불가로 못박았으므로, 열면 두 항목 다 회색인 메뉴가 될 뿐이다.
 * 호버 클러스터의 규약(`data-section-action`)을 그대로 입어 rest 에서는 DOM 에
 * 없고, 열려 있는 동안에는 `overlayOpen` 이 헤더를 붙들어 둔다.
 */
export function SidebarSectionMenu({
  sectionId,
  title,
  onOpenChange,
  onRename,
  onDelete,
}: {
  sectionId: string;
  title: string;
  /** 열려 있는 동안 헤더의 호버 클러스터를 붙들어 둔다. */
  onOpenChange: (open: boolean) => void;
  onRename: (opener: HTMLElement | null) => void;
  onDelete: (opener: HTMLElement | null) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          ref={trigger}
          type="button"
          aria-label={`${title} 섹션 메뉴`}
          title={`${title} 섹션 메뉴`}
          data-section-action=""
          data-testid={`section-menu-${sectionId}`}
          className="tap-target flex size-control-sm items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-surface-hover focus-visible:focus-ring"
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid={`section-menu-${sectionId}-content`}>
        <DropdownMenuItem
          data-testid={`section-menu-${sectionId}-rename`}
          onSelect={() => onRename(trigger.current)}
        >
          {SECTION_RENAME_LABEL}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          tone="danger"
          data-testid={`section-menu-${sectionId}-delete`}
          onSelect={() => onDelete(trigger.current)}
        >
          {SECTION_DELETE_LABEL}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
