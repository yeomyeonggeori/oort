import { useCallback, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import { Input } from "@/design/ui/input";
import { InlineBanner } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { OperatorNotice } from "@/features/settings/SettingsFields";
import { PRIMARY_ACTION_SHORTCUT } from "@/app/keyboardShortcuts";
import {
  createWorkspace,
  type CreatedWorkspace,
} from "@momo/core/features/settings/api";
import {
  errorMessage,
  isOperatorDenied,
  isSlugConflict,
  normalizeSlug,
  slugError,
  workspaceNameError,
} from "@momo/core/features/settings/model";
import {
  AddWorkspaceOpenContext,
  AddWorkspaceOpenStateContext,
} from "./useAddWorkspace";

// =============================================================================
// 워크스페이스 추가 다이얼로그 (검수 피드백 #4a-2).
//
// The rail's [+] used to route to /settings, which is where the create form
// happens to live — so "add a workspace" left the rail and landed on a page
// about everything else. This is the web sibling of what MOMO-614 did to 채널
// 만들기: the form comes to the action's own seat, owned once by the shell.
//
// It is the settings form (설정 > 워크스페이스, WorkspaceSection) in a dialog,
// and it keeps that surface's authorization shape rather than inventing one:
// creating a workspace mints a tenant on the shared instance, so the SERVER
// gates it on the instance operator (require_instance_operator, MOMO-583). The
// client cannot know operator status without asking, so it shows the form and,
// when the server answers 403, swaps to a notice that says who can create and
// how a non-operator joins instead — an invite, not a create (ADR-0117 D5-A).
//
// What this dialog does NOT do is switch to the workspace it just made:
// multi-workspace session switching is ADR-0161 4b-3, so a new workspace is
// entered by signing in to it, and the success panel says exactly that instead
// of promising a jump the rail cannot make yet.
// =============================================================================

const FORM_ID = "add-workspace-form";

/** 다이얼로그를 닫아도 남는 입력. 지운 적 없는 글은 지워지지 않는다. */
export interface WorkspaceDraft {
  name: string;
  slug: string;
}

const EMPTY_DRAFT: WorkspaceDraft = { name: "", slug: "" };

/**
 * Label, control, then one line under it that is either the hint or the error,
 * with the control wired to both ids. The settings `Field` renders the same
 * shape but does not put `aria-invalid`/`aria-describedby` on the control, so a
 * rejection that is only red text is a rejection a screen reader never hears;
 * here it is part of the field. (Same helper 채널 만들기 uses, kept local so the
 * two dialogs do not couple.)
 */
function WorkspaceDialogField({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint: string;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={htmlFor} className="text-meta text-ink-muted">
        {label}
      </label>
      {children}
      {error ? (
        <p
          className="text-meta text-danger"
          role="alert"
          id={`${htmlFor}-error`}
          data-testid={`${htmlFor}-error`}
        >
          {error}
        </p>
      ) : (
        <p className="text-meta text-ink-muted" id={`${htmlFor}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

function AddWorkspacePanel({
  draft,
  setDraft,
  onOpenChange,
}: {
  draft: WorkspaceDraft;
  setDraft: (next: WorkspaceDraft) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const offline = useOffline();
  const { name, slug } = draft;
  const [attempted, setAttempted] = useState(false);
  const [created, setCreated] = useState<CreatedWorkspace | null>(null);
  const [slugConflict, setSlugConflict] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const create = useMutation({
    mutationFn: () => createWorkspace(normalizeSlug(slug), name.trim()),
    onSuccess: (result) => {
      setCreated(result);
      setDraft(EMPTY_DRAFT);
      setAttempted(false);
    },
    onError: (error) => {
      // A taken slug is a request to change the slug, so the caret goes there;
      // every other rejection is stated whole (권한 → notice below, 네트워크 →
      // inline). The unique index is the only race-free answer, so the conflict
      // is handled here rather than pre-checked.
      if (isSlugConflict(error)) {
        setSlugConflict(true);
        slugRef.current?.focus();
      }
    },
  });

  const nameIssue = workspaceNameError(name);
  const slugIssue = slugError(slug);

  // A rule is only worth stating once the reader has done something it applies
  // to: an untouched empty field is a field, not a mistake.
  const nameError =
    nameIssue !== null && (attempted || name.trim() !== "") ? nameIssue : null;
  const localSlugError =
    slugIssue !== null && (attempted || slug.trim() !== "") ? slugIssue : null;
  const slugFieldError =
    localSlugError ??
    (slugConflict ? "이미 쓰이는 슬러그입니다. 다른 값을 고르세요." : null);

  const operatorDenied = create.isError && isOperatorDenied(create.error);
  const formError =
    create.isError && !operatorDenied && !isSlugConflict(create.error)
      ? errorMessage(create.error)
      : null;

  const onInput = useCallback(
    (key: "name" | "slug") =>
      (event: React.ChangeEvent<HTMLInputElement>) => {
        setDraft({ ...draft, [key]: event.target.value });
        // Editing the slug invalidates the server's answer about the old one.
        if (key === "slug") setSlugConflict(false);
      },
    [draft, setDraft]
  );

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (create.isPending || offline) return;
    if (nameIssue !== null || slugIssue !== null) {
      // Land the caret on the field that has to change. 이름 comes first when
      // both are wrong: it is the field the form starts on.
      (nameIssue !== null ? nameRef : slugRef).current?.focus();
      return;
    }
    setCreated(null);
    create.mutate();
  }

  return (
    <DialogContent
      data-testid="add-workspace-dialog"
      onKeyDown={(event) => {
        // ⌘↵ = 다이얼로그 기본 액션 (R-1 5장), from anywhere in the panel
        // including the trailing action row.
        if (PRIMARY_ACTION_SHORTCUT.matches(event)) {
          event.preventDefault();
          formRef.current?.requestSubmit();
        }
      }}
      onEscapeKeyDown={(event) => {
        if (create.isPending) event.preventDefault();
      }}
      onInteractOutside={(event) => {
        if (create.isPending) event.preventDefault();
      }}
    >
      <div className="flex flex-col gap-1 border-b border-line p-4">
        <DialogTitle>워크스페이스 추가</DialogTitle>
        <DialogDescription>
          새 워크스페이스를 만들거나, 초대를 받았다면 초대 링크로 참여합니다.
        </DialogDescription>
      </div>

      {created ? (
        <div className="flex flex-col gap-3 p-4">
          <div
            className="flex flex-col gap-2 rounded-md border border-ok bg-surface-raised p-4"
            role="status"
            data-testid="add-workspace-created"
          >
            <p className="text-body text-ink">
              {created.name} 워크스페이스를 만들었습니다.
            </p>
            <p className="text-meta text-ink-muted">
              슬러그 {created.slug}. 새 워크스페이스로는 그 슬러그로 다시
              로그인해서 들어갑니다.
            </p>
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => onOpenChange(false)}
              data-testid="add-workspace-done"
            >
              닫기
            </Button>
          </div>
        </div>
      ) : operatorDenied ? (
        <div className="flex flex-col gap-3 p-4">
          <OperatorNotice
            who="새 워크스페이스는 이 서버의 운영자만 만들 수 있습니다."
            contact="초대를 받았다면 받은 초대 링크로 참여할 수 있습니다. 없다면 이 서버를 운영하는 사람에게 문의하세요."
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              data-testid="add-workspace-close"
            >
              닫기
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* 오프라인이면 만들 수 없다고 말하고 버튼을 잠근다 (R-1 5장): 생성은
              데드라인이 걸린 REST 한 번이라 끊긴 채로 누르면 15초 뒤 실패가
              돌아온다. 설정 화면과 같은 사실을 같은 문장으로 말한다. */}
          {offline && (
            <InlineBanner
              tone="neutral"
              message="연결이 끊겼습니다. 워크스페이스 만들기는 다시 연결된 뒤에 할 수 있습니다."
              testId="add-workspace-offline"
            />
          )}

          <form
            id={FORM_ID}
            ref={formRef}
            onSubmit={submit}
            className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4"
          >
            <WorkspaceDialogField
              label="이름"
              htmlFor="add-workspace-name"
              hint="사람이 읽는 이름입니다. 80자까지 쓸 수 있습니다."
              error={nameError}
            >
              <Input
                id="add-workspace-name"
                ref={nameRef}
                name="name"
                value={name}
                onChange={onInput("name")}
                placeholder="디자인팀"
                autoComplete="off"
                spellCheck={false}
                disabled={create.isPending}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={
                  nameError ? "add-workspace-name-error" : "add-workspace-name-hint"
                }
                data-testid="add-workspace-name"
              />
            </WorkspaceDialogField>

            <WorkspaceDialogField
              label="슬러그"
              htmlFor="add-workspace-slug"
              hint="영문 소문자, 숫자, 하이픈만. 서버 전체에서 하나뿐이어야 합니다."
              error={slugFieldError}
            >
              <Input
                id="add-workspace-slug"
                ref={slugRef}
                name="slug"
                value={slug}
                onChange={onInput("slug")}
                placeholder="design"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                disabled={create.isPending}
                aria-invalid={slugFieldError ? true : undefined}
                aria-describedby={
                  slugFieldError
                    ? "add-workspace-slug-error"
                    : "add-workspace-slug-hint"
                }
                data-testid="add-workspace-slug"
              />
            </WorkspaceDialogField>

            {formError && (
              <p
                className="text-meta text-danger"
                role="alert"
                data-testid="add-workspace-error"
              >
                {formError}
              </p>
            )}
          </form>

          {/* Standard bordered buttons, trailing-aligned, default action last
              (design-taste-web §8). */}
          <div className="flex items-center justify-end gap-2 border-t border-line p-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={create.isPending}
              onClick={() => onOpenChange(false)}
              data-testid="add-workspace-cancel"
            >
              취소
            </Button>
            {/* 진행 중은 비활성이 아니라 바쁜 것이다: 대비를 그대로 두고 버튼 안
                스피너를 켜며 클릭은 submit이 막는다. 오프라인은 반대로 진짜 할 수
                없는 일이라 진짜 disabled고, 이유는 폼 위 배너가 말한다 (채널
                만들기와 같은 규율). */}
            <Button
              type="submit"
              form={FORM_ID}
              size="sm"
              disabled={offline}
              aria-busy={create.isPending || undefined}
              data-testid="add-workspace-submit"
            >
              {create.isPending && (
                <Loader2 aria-hidden="true" className="spinner-busy" />
              )}
              {create.isPending ? "만드는 중" : "워크스페이스 만들기"}
            </Button>
          </div>
        </>
      )}
    </DialogContent>
  );
}

export function AddWorkspaceDialog({
  open,
  onOpenChange,
  draft,
  setDraft,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: WorkspaceDraft;
  setDraft: (next: WorkspaceDraft) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 열려 있는 동안에만 마운트한다: 이전 시도의 성공/거절/attempted가 다음
          열기까지 따라오지 않고, 여는 순간의 activeElement가 곧 "무엇이 이걸
          열었나"라 닫을 때 캐럿이 그리로 돌아간다. 초안만 provider에 남아, 이름을
          쓰다 바깥을 눌러도 글은 그대로다. */}
      {open && (
        <AddWorkspacePanel
          draft={draft}
          setDraft={setDraft}
          onOpenChange={onOpenChange}
        />
      )}
    </Dialog>
  );
}

/**
 * Holds the one 워크스페이스 추가 dialog for the signed-in shell and hands the
 * rail's [+] the verb that opens it. The open-state rides its own context so the
 * shell's window-level shortcuts can step back over the modal (R2 M4).
 */
export function AddWorkspaceProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<WorkspaceDraft>(EMPTY_DRAFT);
  const openAdd = useCallback(() => setOpen(true), []);
  return (
    <AddWorkspaceOpenContext.Provider value={openAdd}>
      <AddWorkspaceOpenStateContext.Provider value={open}>
        {children}
      </AddWorkspaceOpenStateContext.Provider>
      <AddWorkspaceDialog
        open={open}
        onOpenChange={setOpen}
        draft={draft}
        setDraft={setDraft}
      />
    </AddWorkspaceOpenContext.Provider>
  );
}
