import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  restoreDialogOpenerFocus,
  type DialogFocusTarget,
} from "@/design/ui/dialog";
import { Input } from "@/design/ui/input";
import { InlineBanner } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import {
  CopyButton,
  KeyValueRows,
  OperatorNotice,
} from "@/features/settings/SettingsFields";
import {
  NEW_WORKSPACE_ENTRY_GUIDE,
  NEW_WORKSPACE_ID_ONCE_NOTICE,
} from "@/features/auth/loginWorkspaceEntry";
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
// entered by signing in to it. The sign-in form takes a workspace ID, never the
// slug (the server answers a slug with 400), so the success panel shows that ID
// with a 복사 button and names the path in the login screen's own words
// (`loginWorkspaceEntry.ts`) instead of promising a jump the rail cannot make
// yet or a slug login the server does not have (#4198, 멀티 조직 P0-A).
//
// That ID exists nowhere else: it comes back in the create response only (there is
// no workspace list to read it from). So the success panel follows the house rule
// for a value you can see once (the webhook reveal card, the hosted-agent secret
// card): focus lands on the named group when it appears, the sentence says "leave
// and it is gone", and Esc / outside click are swallowed so the one explicit exit
// is 「닫기」, not a reflex.
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
  opener,
}: {
  draft: WorkspaceDraft;
  setDraft: (next: WorkspaceDraft) => void;
  onOpenChange: (open: boolean) => void;
  opener?: DialogFocusTarget | null;
}) {
  const offline = useOffline();
  const { name, slug } = draft;
  const [attempted, setAttempted] = useState(false);
  const [created, setCreated] = useState<CreatedWorkspace | null>(null);
  const [slugConflict, setSlugConflict] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const createdRef = useRef<HTMLDivElement>(null);
  const createdHeadlineId = useId();
  const createdNoticeId = useId();

  // 만든 직후 초점이 완료 묶음으로 간다. 눌렀던 「워크스페이스 만들기」는 사라졌고, 이 묶음이
  // 값을 볼 수 있는 유일한 순간이다. 이름이 낭독되고 그다음 Tab이 「복사」다.
  useEffect(() => {
    if (created) createdRef.current?.focus({ preventScroll: true });
  }, [created]);

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
    (slugConflict ? "이미 쓰이는 슬러그예요. 다른 값을 고르세요." : null);

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
      opener={opener}
      data-testid="add-workspace-dialog"
      onKeyDown={(event) => {
        // ⌘↵ = 다이얼로그 기본 액션 (R-1 5장), from anywhere in the panel
        // including the trailing action row.
        if (PRIMARY_ACTION_SHORTCUT.matches(event)) {
          event.preventDefault();
          formRef.current?.requestSubmit();
        }
      }}
      // 만드는 중에는 물론이고, 완료 패널이 떠 있는 동안에도 Esc와 바깥 클릭으로 닫히지 않는다:
      // 그 ID는 다른 어디에도 없어서, 반사적인 Esc 한 번이 들어갈 길을 지운다. 나가는 길은
      // 이름 붙은 「닫기」 하나다.
      onEscapeKeyDown={(event) => {
        if (create.isPending || created) event.preventDefault();
      }}
      onInteractOutside={(event) => {
        if (create.isPending || created) event.preventDefault();
      }}
    >
      <div className="flex flex-col gap-1 border-b border-line p-4">
        <DialogTitle>워크스페이스 추가</DialogTitle>
        {/* 만든 뒤에는 폼 설명이 쓸모없어서 그 자리를 경고가 쓴다. 고정 머리라 스크롤 상자 밖이고,
            값보다 앞이며, 어떤 창 높이에서도 보인다: Esc·바깥 클릭을 막은 이유(이 ID는 다시 볼 수
            없다)를 말하는 문장이 접힌 아래로 사라지면 눈에 보이는 컨트롤이 되돌릴 수 없는 「닫기」
            하나가 된다(design-review 3차 H1, 실측). */}
        <DialogDescription>
          {created ? (
            <span
              id={createdNoticeId}
              className="break-keep"
              data-testid="add-workspace-created-notice"
            >
              {NEW_WORKSPACE_ID_ONCE_NOTICE}
            </span>
          ) : (
            "새 워크스페이스를 만들거나, 초대를 받았다면 초대 링크로 참여해요."
          )}
        </DialogDescription>
      </div>

      {created ? (
        <>
          {/* 폼 분기와 같은 구조다: 내용은 스크롤 상자 안에, 나가는 길은 상자 밖 바닥에 늘 보인다.
              이 분기는 Esc·바깥 클릭을 막으므로 「닫기」가 유일한 출구인데, 스크롤 상자가 없으면
              패널 높이 상한(`dialog-panel`, 창 높이 - 64px) 아래로 내용이 흘러내려 낮은 창(가로
              폰 667x375, 브라우저 200%)에서 출구가 화면 밖에 걸린다(design-review 2차 B1, 실측). */}
          {/* `scrollbar-visible`: 오버레이 스크롤바는 스크롤을 시작해야 보여서, 상자가 넘친다는 신호가
              없으면 패널이 끝난 것처럼 읽힌다(집의 이름 붙은 처방, MOMO-620 R2). */}
          <div className="scrollbar-visible flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
            {/* `role="status"`가 아니라 이름 붙은 `group`이다: status는 암묵적 live region이라
                36자 ID와 안내가 뜨는 순간 통째로 낭독된다. 도착했다는 사실은 초점이 이 묶음에
                들어올 때 이름(헤드라인)으로 말한다(OneTimeSecretCard·웹훅 발급 카드와 같은 규칙). */}
            <div
              ref={createdRef}
              tabIndex={-1}
              role="group"
              aria-labelledby={createdHeadlineId}
              aria-describedby={createdNoticeId}
              className="flex flex-col gap-3 rounded-md border border-ok bg-surface-raised p-4 focus-visible:focus-ring"
              data-testid="add-workspace-created"
            >
              <p id={createdHeadlineId} className="break-keep text-body text-ink">
                {created.name} 워크스페이스를 만들었어요.
              </p>
              {/* 로그인 화면이 받는 것은 슬러그가 아니라 이 ID다. 서버가 돌려준 값을
                  대소문자도 건드리지 않고 그대로 보여 주고 그대로 복사한다. `select-all`은
                  클립보드를 못 쓸 때의 한 번 클릭 선택이다(ApprovalActions.LinkOnce와 같은 문법).
                  단추가 옆에 서느냐 아래로 내려가느냐는 내용 폭이 아니라 칸 폭이 정한다
                  (`@container` + `@sm`): flex-wrap이면 폰 폭(390)에서 「복사」는 옆에 서다가
                  누르는 순간 「복사됨」으로 길어져 아랫줄로 떨어진다(누른 손가락 아래에서
                  단추가 달아나고 대화상자가 44px 늘어난다, 실측). */}
              <KeyValueRows
                rows={[
                  {
                    key: "워크스페이스 ID",
                    value: (
                      <span className="@container block min-w-0">
                        <span className="flex min-w-0 flex-col items-start gap-2 @sm:flex-row @sm:items-center">
                          <span
                            className="min-w-0 select-all break-all font-mono text-meta text-ink"
                            data-numeric=""
                            data-testid="add-workspace-created-id"
                          >
                            {created.workspaceId}
                          </span>
                          <CopyButton
                            value={created.workspaceId}
                            subject="워크스페이스 ID"
                            testId="add-workspace-created-copy"
                            className="tap-target"
                          />
                        </span>
                      </span>
                    ),
                  },
                  {
                    key: "슬러그",
                    value: (
                      <span
                        className="font-mono text-meta text-ink-muted"
                        data-numeric=""
                      >
                        {created.slug}
                      </span>
                    ),
                  },
                ]}
              />
              <p
                className="break-keep text-meta text-ink-muted"
                data-testid="add-workspace-created-guide"
              >
                {NEW_WORKSPACE_ENTRY_GUIDE}
              </p>
            </div>
          </div>
          {/* 터치에서 그 순간 반드시 눌러야 하는 하나는 이제 「닫기」다(`CopyButton`의 `tap-target`
              주석, design-review #2540 R1 M6): 폰 폭에서 44px로 자란다. */}
          <div className="flex items-center justify-end gap-2 border-t border-line p-4">
            <Button
              type="button"
              size="sm"
              className="tap-target"
              onClick={() => onOpenChange(false)}
              data-testid="add-workspace-done"
            >
              닫기
            </Button>
          </div>
        </>
      ) : operatorDenied ? (
        <div className="flex flex-col gap-3 p-4">
          <OperatorNotice
            who="새 워크스페이스는 이 서버의 운영자만 만들 수 있어요."
            contact="초대를 받았다면 받은 초대 링크로 참여할 수 있어요. 없다면 이 서버를 운영하는 사람에게 문의하세요."
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
              message="연결이 끊겼어요. 워크스페이스 만들기는 다시 연결된 뒤에 할 수 있어요."
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
              hint="사람이 읽는 이름이에요. 80자까지 쓸 수 있어요."
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
              hint="영문 소문자, 숫자, 하이픈만. 서버 전체에서 하나뿐이어야 해요."
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
  opener,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: WorkspaceDraft;
  setDraft: (next: WorkspaceDraft) => void;
  opener?: DialogFocusTarget | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 열려 있는 동안에만 마운트한다: 이전 시도의 성공/거절/attempted가 다음
          열기까지 따라오지 않고, 여는 순간의 activeElement가 곧 "무엇이 이걸
          열었나"라 닫을 때 캐럿이 그리로 돌아간다. 카드 메뉴처럼 그 순간
          트리거가 이미 언마운트된 진입점은 `opener`로 명시한다 (H-2).
          초안만 provider에 남아, 이름을 쓰다 바깥을 눌러도 글은 그대로다. */}
      {open && (
        <AddWorkspacePanel
          draft={draft}
          setDraft={setDraft}
          onOpenChange={onOpenChange}
          opener={opener}
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
  const openerRef = useRef<DialogFocusTarget | null>(null);
  const openAdd = useCallback((opener?: DialogFocusTarget | null) => {
    openerRef.current = opener ?? null;
    setOpen(true);
  }, []);
  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (next) return;
    const opener = openerRef.current;
    queueMicrotask(() => {
      restoreDialogOpenerFocus(opener);
    });
  }, []);
  return (
    <AddWorkspaceOpenContext.Provider value={openAdd}>
      <AddWorkspaceOpenStateContext.Provider value={open}>
        {children}
      </AddWorkspaceOpenStateContext.Provider>
      <AddWorkspaceDialog
        open={open}
        onOpenChange={onOpenChange}
        draft={draft}
        setDraft={setDraft}
        opener={openerRef.current}
      />
    </AddWorkspaceOpenContext.Provider>
  );
}
