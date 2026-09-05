import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpDown, Check, MoreHorizontal } from "lucide-react";
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
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/design/ui/dropdown-menu";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import {
  SECTION_CREATE_TITLE,
  SECTION_DELETE_CONFIRM_LABEL,
  SECTION_DELETE_CONFIRM_TITLE,
  SECTION_DELETE_LABEL,
  SECTION_MOVE_DOWN_LABEL,
  SECTION_MOVE_UP_LABEL,
  SECTION_NAME_FIELD_LABEL,
  SECTION_NAME_PLACEHOLDER,
  SECTION_RENAME_LABEL,
  SECTION_RENAME_TITLE,
  sectionDeleteConfirmBody,
  sidebarSectionNameIssue,
  sidebarSectionNameIssueMessage,
  sidebarSortModeLabel,
  SIDEBAR_SECTION_NAME_MAX,
  SIDEBAR_SORT_GROUP_LABEL,
  SIDEBAR_SORT_MODES,
  type SidebarSortMode,
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
      <DialogContent
        className="gap-4 p-4"
        data-testid="sidebar-section-delete-confirm"
      >
          {/* 제목은 고정, 이름은 본문 (design-review #1932 M-1). 80자 이름이
              제목에 들어가면 물음이 셋째 줄 끝에 도착한다 - 이 다이얼로그가
              문법을 빌려 온 `ChannelLeaveConfirmDialog` 가 정확히 그 이유로
              반대로 한다. */}
          <div className="flex flex-col gap-1">
            <DialogTitle>{SECTION_DELETE_CONFIRM_TITLE}</DialogTitle>
            <DialogDescription>{sectionDeleteConfirmBody(name)}</DialogDescription>
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
    </Dialog>
  );
}

/**
 * 「채널 정렬」 (BT-5 / #1933, design-review R1 M-2·N-2).
 *
 * ## 이 문이 섹션 ⋮ 에서 나온 이유
 *
 * 첫 판은 이 무리를 기본 「채널」 섹션의 ⋮ 안에 넣었다. 그러자 **이름과 내용이
 * 어긋났다**: 스크린리더는 「채널 섹션 메뉴」라 읽는데 열면 안의 것은 사이드바
 * 전체에 걸리는 설정이었고, 눈으로는 같은 ⋯ 글리프가 섹션마다 다른 메뉴를 열었다
 * (채널=정렬만 · 커스텀=차례/이름/삭제 · 별표·DM=없음). 정렬을 찾는 사람이 커스텀
 * 섹션의 ⋯ 을 먼저 열면 그 문은 거기 없다.
 *
 * 그래서 문을 갈랐다. **글리프가 다르고**(⇅ 대 ⋯) 이름이 자기 범위를 말한다 —
 * 두 문이 한 헤더에 나란히 서도 무엇이 무엇인지 보고 알 수 있다. 자리는 그대로
 * 기본 「채널」 헤더인데, 그 헤더는 이미 사이드바의 선반이기 때문이다(「새 섹션」도
 * 채널 섹션의 일이 아니라 사이드바의 일이고 같은 자리에 산다).
 *
 * 낱말이 「사이드바 정렬」이 아닌 이유는 코어 `SIDEBAR_SORT_GROUP_LABEL` 머리말에
 * 있다(DM 은 이 차례를 타지 않는다).
 *
 * 라디오·제목·체크의 문법은 행 메뉴의 「섹션으로 이동」과 한 벌이다
 * (`ChannelSectionMoveGroup`): 여럿 중 하나이므로 `aria-checked` 가 들려야 하고,
 * Radix 의 Label 은 aria 를 걸어 주지 않으므로 `useId` 로 되짚는다.
 */
export function SidebarSortMenu({
  mode,
  onChange,
  onOpenChange,
}: {
  mode: SidebarSortMode;
  onChange: (next: SidebarSortMode) => void;
  /** 열려 있는 동안 헤더의 호버 클러스터를 붙들어 둔다. */
  onOpenChange: (open: boolean) => void;
}) {
  const labelId = useId();
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={SIDEBAR_SORT_GROUP_LABEL}
          title={SIDEBAR_SORT_GROUP_LABEL}
          data-section-action=""
          data-testid="sidebar-sort-menu"
          className="tap-target flex size-control-sm items-center justify-center rounded-sm text-ink-muted press hover:bg-surface-hover focus-visible:focus-ring"
        >
          <ArrowUpDown className="size-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="sidebar-sort-menu-content">
        <DropdownMenuLabel id={labelId} data-testid="sidebar-sort-label">
          {SIDEBAR_SORT_GROUP_LABEL}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          aria-labelledby={labelId}
          value={mode}
          onValueChange={(next) => onChange(next as SidebarSortMode)}
        >
          {SIDEBAR_SORT_MODES.map((value) => (
            <DropdownMenuRadioItem
              key={value}
              value={value}
              data-testid={`sidebar-sort-${value}`}
            >
              <span className="min-w-0 flex-1 truncate">
                {sidebarSortModeLabel(value)}
              </span>
              {/* 체크는 캘러가 그린다(`DropdownMenuRadioItem` 독스트링). 귀가 듣는
                  `aria-checked` 와 같은 사실을 눈에 말하는 자리다. */}
              {value === mode && (
                <Check
                  className="size-4 shrink-0 text-ink-muted"
                  aria-hidden="true"
                />
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * 커스텀 섹션 헤더의 ⋮ — 차례 · 이름 바꾸기 · 삭제.
 *
 * BT-4 가 세운 그대로 **커스텀 섹션에만** 선다: 기본 두 종은 삭제 불가·이름변경
 * 불가이고(ADR-0177 D4) 차례도 고정이라, 열면 항목이 전부 회색인 메뉴가 될 뿐이다.
 * BT-5 가 한동안 여기에 정렬을 얹었다가 도로 뺐다 — 그 판정과 근거는 위
 * `SidebarSortMenu` 머리말에 있다(design-review R1 M-2).
 *
 * 호버 클러스터의 규약(`data-section-action`)을 그대로 입어 rest 에서는 DOM 에
 * 없고, 열려 있는 동안에는 `overlayOpen` 이 헤더를 붙들어 둔다.
 */
export function SidebarSectionMenu({
  sectionId,
  title,
  order,
  onOpenChange,
  onRename,
  onDelete,
}: {
  sectionId: string;
  title: string;
  /**
   * 섹션 차례를 바꾸는 키보드 경로 (BT-5 계약 3항). 끌어다 놓기와 **같은 코어
   * 함수**에 닿으므로 두 문이 같은 payload 를 만든다.
   */
  order?: {
    canUp: boolean;
    canDown: boolean;
    onMove: (delta: -1 | 1) => void;
  };
  /** 열려 있는 동안 헤더의 호버 클러스터를 붙들어 둔다. */
  onOpenChange: (open: boolean) => void;
  onRename?: (opener: HTMLElement | null) => void;
  onDelete?: (opener: HTMLElement | null) => void;
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
          className="tap-target flex size-control-sm items-center justify-center rounded-sm text-ink-muted press hover:bg-surface-hover focus-visible:focus-ring"
        >
          <MoreHorizontal className="size-4" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid={`section-menu-${sectionId}-content`}>
        {order && (
          <>
            {/* 끝에 닿은 방향은 **비활성으로 남는다**. 지우지 않는 이유가 「새
                섹션」의 상한과 같지는 않다 - 여기서는 사유를 문장으로 들 필요가
                없다. 「위로」가 회색인 까닭은 이 섹션이 맨 위라는 것이고, 그
                사실은 목록 자체가 이미 보여 준다. 그래도 항목이 서 있어야
                차례를 바꾸는 길이 **있다**는 것을 다음에 열었을 때도 안다. */}
            <DropdownMenuItem
              disabled={!order.canUp}
              data-testid={`section-menu-${sectionId}-up`}
              onSelect={() => order.onMove(-1)}
            >
              {SECTION_MOVE_UP_LABEL}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!order.canDown}
              data-testid={`section-menu-${sectionId}-down`}
              onSelect={() => order.onMove(1)}
            >
              {SECTION_MOVE_DOWN_LABEL}
            </DropdownMenuItem>
          </>
        )}
        {onRename && (
          <>
            {order && <DropdownMenuSeparator />}
            <DropdownMenuItem
              data-testid={`section-menu-${sectionId}-rename`}
              onSelect={() => onRename(trigger.current)}
            >
              {SECTION_RENAME_LABEL}
            </DropdownMenuItem>
          </>
        )}
        {onDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              tone="danger"
              data-testid={`section-menu-${sectionId}-delete`}
              onSelect={() => onDelete(trigger.current)}
            >
              {SECTION_DELETE_LABEL}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
