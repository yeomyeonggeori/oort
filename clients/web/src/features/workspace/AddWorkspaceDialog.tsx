import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { ChevronRight, Link as LinkIcon, Loader2, Plus, type LucideIcon } from "lucide-react";
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
import { useSession } from "@/app/session";
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
import { classifyEntry, serverLabel } from "@/features/auth/entryInput";
import { PRIMARY_ACTION_SHORTCUT } from "@/app/keyboardShortcuts";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import {
  createWorkspace,
  type CreatedWorkspace,
} from "@momo/core/features/settings/api";
import {
  errorMessage,
  isOperatorDenied,
  isSlugConflict,
  isWorkspaceOperator,
  normalizeSlug,
  slugError,
  workspaceNameError,
} from "@momo/core/features/settings/model";
import {
  AddWorkspaceOpenContext,
  AddWorkspaceOpenStateContext,
} from "./useAddWorkspace";
import { memberFor, useDirectory } from "./useWorkspace";
import {
  isSameServer,
  joinHandoffHref,
  joinTargetFromEntry,
  probeServerReachable,
  type JoinTarget,
} from "./joinHandoff";
import { absoluteApiBase } from "@/lib/serverBase";
import { BlockedReason } from "@/features/common/BlockedReason";

// =============================================================================
// 워크스페이스 추가 다이얼로그 (검수 피드백 #4a-2 → #5785 두 카드, QA 14 1단).
//
// The rail's [+] used to route to /settings, which is where the create form
// happens to live — so "add a workspace" left the rail and landed on a page
// about everything else. This is the web sibling of what MOMO-614 did to 채널
// 만들기: the form comes to the action's own seat, owned once by the shell.
//
// #5785: the first screen is two cards, the Buzz "Add a community" shape — a big
// title with one line under it, then 「새 워크스페이스 만들기」 and 「이미 있는 곳에
// 참여」, each an icon tile, a title over one sentence, and a chevron. Both cards
// are plain buttons in tab order, and ↑/↓ also walk between them.
//
//   만들기  the settings form (설정 > 워크스페이스, WorkspaceSection) in a dialog,
//           with that surface's authorization shape: creating a workspace mints a
//           tenant on the shared instance, so the SERVER gates it on the instance
//           operator (require_instance_operator, MOMO-583). The client cannot know
//           the operator allow-list, so the card says the fact that is true for
//           everyone (서버 운영자만). The one thing the client CAN know is a member
//           or guest role from the roster — the server never makes those an
//           operator — so for them the card states that this account cannot, and
//           does not lead into a form the server will refuse. An owner/admin who is
//           not on the list still gets the form and the 403 notice, as before.
//   참여    the app holds ONE sign-in (session switching is ADR-0161 4b-3), so
//           joining another workspace is 「로그아웃 → 로그인 화면」. The card says
//           exactly that, the step reads one field with the login screen's own
//           classifier, a same-server address is refused and any other address
//           must answer a light reachability check (no logout for a typo), a
//           confirm step names the cost (logout), and only then is the link handed to the login screen
//           (`joinHandoff.ts`, `useJoinPrefill`). The confirm is a step inside this
//           surface, not a second dialog (design-system README §3.4).
//
// What this dialog still does NOT do is switch to the workspace it just made. A
// new workspace is entered by signing in to it with its ID (never the slug — the
// server answers a slug with 400), so the success panel shows that ID with a 복사
// button and names the path in the login screen's own words
// (`loginWorkspaceEntry.ts`) (#4198, 멀티 조직 P0-A).
//
// That ID exists nowhere else: it comes back in the create response only (there is
// no workspace list to read it from). So the success panel follows the house rule
// for a value you can see once (the webhook reveal card, the hosted-agent secret
// card): focus lands on the named group when it appears, the sentence says "leave
// and it is gone", and Esc / outside click are swallowed so the one explicit exit
// is 「닫기」, not a reflex.
// =============================================================================

const FORM_ID = "add-workspace-form";
const JOIN_FORM_ID = "add-workspace-join-form";

/** 다이얼로그를 닫아도 남는 입력. 지운 적 없는 글은 지워지지 않는다. */
export interface WorkspaceDraft {
  name: string;
  slug: string;
}

const EMPTY_DRAFT: WorkspaceDraft = { name: "", slug: "" };

/**
 * 창 안의 걸음. 열 때마다 `choose`에서 시작한다(패널은 열려 있는 동안만 마운트된다). 참여 칸의 링크는
 * 초대 코드(bearer 비밀)를 실을 수 있어서 provider 초안이 아니라 이 패널에만 든다: 닫으면 사라진다.
 */
type Step = "choose" | "create" | "join" | "confirm";

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

/**
 * One of the two first-screen cards. A real `<button>`: the whole card is the
 * target, its accessible name is the title and its description is the sentence
 * (wired by id, so the chevron and the tile are not read). A card the account
 * cannot use stays on screen with its reason (house rule #1383: an ineligible
 * option is not hidden) and is `aria-disabled` rather than `disabled`, so it keeps
 * its tab stop and the reason is still heard; it loses the chevron because it
 * leads nowhere. It wears `cursor-not-allowed` and no press paint: nothing
 * happens on press, so nothing may look pressed (pressLedger excludes the pair).
 */
function ChoiceCard({
  icon: Icon,
  title,
  lead,
  onChoose,
  unavailable = false,
  buttonRef,
  onKeyDown,
  testId,
}: {
  icon: LucideIcon;
  title: string;
  lead: string;
  onChoose: () => void;
  unavailable?: boolean;
  buttonRef: Ref<HTMLButtonElement>;
  onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  testId: string;
}) {
  const titleId = useId();
  const leadId = useId();
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-labelledby={titleId}
      aria-describedby={leadId}
      aria-disabled={unavailable || undefined}
      onClick={() => {
        if (!unavailable) onChoose();
      }}
      onKeyDown={onKeyDown}
      data-testid={testId}
      data-unavailable={unavailable ? "" : undefined}
      className={
        unavailable
          ? "tap-target flex w-full min-w-0 cursor-not-allowed items-center gap-3 rounded-lg border border-line p-3 text-left focus-visible:focus-ring"
          : "tap-target flex w-full min-w-0 items-center gap-3 rounded-lg border border-line p-3 text-left press-instant-fill hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring"
      }
    >
      <span
        className="flex size-control-lg shrink-0 items-center justify-center rounded-md bg-surface-muted text-ink"
        aria-hidden="true"
      >
        <Icon className="size-4" aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span
          id={titleId}
          className={
            unavailable
              ? "text-label font-semibold text-ink-muted"
              : "text-label font-semibold text-ink"
          }
        >
          {title}
        </span>
        <span id={leadId} className="break-keep text-meta text-ink-muted">
          {lead}
        </span>
      </span>
      {unavailable ? null : (
        <ChevronRight
          className="size-4 shrink-0 text-ink-muted"
          aria-hidden="true"
        />
      )}
    </button>
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
  const formatMessage = useFormatMessage();
  const offline = useOffline();
  const { session, workspaceId, logout } = useSession();
  const directoryQuery = useDirectory(workspaceId);
  const self = memberFor(directoryQuery.directory, session.member.id);
  // 서버 운영자는 소유자·관리자 가운데 허용 목록에 든 사람이다. 목록은 서버만 안다. 명부를 읽어 멤버·게스트로
  // 확정된 사람만 「이 계정으로는 못 만든다」고 미리 말한다(WorkspaceSection의 `confirmedNonOperator`와 같은 판정).
  const confirmedNonOperator =
    directoryQuery.isSuccess && !isWorkspaceOperator(self?.role);

  const [step, setStep] = useState<Step>("choose");
  const { name, slug } = draft;
  const [attempted, setAttempted] = useState(false);
  const [created, setCreated] = useState<CreatedWorkspace | null>(null);
  const [slugConflict, setSlugConflict] = useState(false);
  const [joinLink, setJoinLink] = useState("");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinTarget, setJoinTarget] = useState<JoinTarget | null>(null);
  // 「계속」이 넘어갈 주소에 닿는지 보는 동안(로그아웃 전). 걸음을 되돌리거나 창이 닫히면 늦게 온 답을 버린다.
  const [joinChecking, setJoinChecking] = useState(false);
  const joinCheckRef = useRef(0);
  useEffect(() => {
    return () => {
      joinCheckRef.current += 1;
    };
  }, []);
  const nameRef = useRef<HTMLInputElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const joinFormRef = useRef<HTMLFormElement>(null);
  const joinInputRef = useRef<HTMLInputElement>(null);
  const createCardRef = useRef<HTMLButtonElement>(null);
  const joinCardRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const createdRef = useRef<HTMLDivElement>(null);
  const createdHeadlineId = useId();
  const createdNoticeId = useId();
  const confirmTargetId = useId();
  // 걸음을 옮길 때 초점이 갈 자리. 렌더가 끝난 뒤(그 자리가 마운트된 뒤) 옮긴다.
  const [pendingFocus, setPendingFocus] = useState<
    "name" | "join" | "confirm" | "create-card" | "join-card" | null
  >(null);

  useEffect(() => {
    if (!pendingFocus) return;
    const node = {
      name: nameRef.current,
      join: joinInputRef.current,
      confirm: confirmRef.current,
      "create-card": createCardRef.current,
      "join-card": joinCardRef.current,
    }[pendingFocus];
    if (!node) return;
    node.focus({ preventScroll: true });
    setPendingFocus(null);
  }, [pendingFocus, step]);

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

  function goTo(next: Step, focus: typeof pendingFocus) {
    setStep(next);
    setPendingFocus(focus);
  }

  function backToChoose(from: "create" | "join") {
    // 걸음을 되돌려도 만들기 초안은 provider에 남는다. 참여 칸은 비운다(코드를 실을 수 있다).
    if (from === "join") {
      joinCheckRef.current += 1;
      setJoinChecking(false);
      setJoinLink("");
      setJoinError(null);
      setJoinTarget(null);
    }
    goTo("choose", from === "create" ? "create-card" : "join-card");
  }

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

  async function submitJoin(event: React.FormEvent) {
    event.preventDefault();
    if (offline || joinChecking) return;
    // 로그인 화면의 첫 칸과 같은 판정이다: 여기서 받은 것을 로그인 화면이 거절하는 일이 없다.
    const result = joinTargetFromEntry(classifyEntry(joinLink));
    if (!result.ok) {
      setJoinError(
        result.reason === "invalid"
          ? result.message
          : formatMessage(
              result.reason === "empty"
                ? "workspace.add.joinEmpty"
                : "workspace.add.joinClaim"
            )
      );
      joinInputRef.current?.focus();
      return;
    }
    const target = result.target;
    // 지금 붙어 있는 서버의 주소만 넣으면 로그아웃해도 같은 서버의 로그인 화면이 열릴 뿐이다: 하지 않는다.
    if (target.kind === "server" && isSameServer(target.serverUrl, absoluteApiBase())) {
      setJoinError(formatMessage("workspace.add.joinSameServer"));
      joinInputRef.current?.focus();
      return;
    }
    setJoinError(null);
    if (target.serverUrl !== "") {
      // 로그아웃은 되돌릴 수 없다: 닿지 않는 주소로는 가지 않는다(오타·꺼진 서버).
      const check = (joinCheckRef.current += 1);
      setJoinChecking(true);
      const reachable = await probeServerReachable(target.serverUrl);
      if (check !== joinCheckRef.current) return;
      setJoinChecking(false);
      if (!reachable) {
        setJoinError(
          formatMessage("workspace.add.joinUnreachable", {
            server: serverLabel(target.serverUrl),
          })
        );
        joinInputRef.current?.focus();
        return;
      }
    }
    setJoinTarget(target);
    goTo("confirm", "confirm");
  }

  function handOffToLogin() {
    if (!joinTarget) return;
    // 로그인 화면은 마운트될 때 페이지 주소에서 링크를 읽는다(`useJoinPrefill`). 그래서 주소를 먼저 바꾸고
    // 그다음에 로그아웃한다. 로그아웃이 같은 틱에 로그인 화면을 새로 세운다.
    window.history.replaceState(
      window.history.state,
      "",
      joinHandoffHref(window.location.href, joinTarget)
    );
    logout();
  }

  /** ↑/↓가 두 카드 사이를 오간다. Tab 순서는 그대로다(둘 다 평범한 단추). */
  function onCardKey(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const cards = [createCardRef.current, joinCardRef.current];
    const at = cards.indexOf(event.currentTarget);
    const next = cards[(at + (event.key === "ArrowDown" ? 1 : cards.length - 1)) % cards.length];
    next?.focus();
  }

  const inCreate = step === "create";
  const title =
    step === "create"
      ? formatMessage("workspace.add.createTitle")
      : step === "join"
        ? formatMessage("workspace.add.joinTitle")
        : step === "confirm"
          ? formatMessage("workspace.add.joinConfirmTitle")
          : formatMessage("workspace.add.title");
  const description = created ? (
    <span
      id={createdNoticeId}
      className="break-keep"
      data-testid="add-workspace-created-notice"
    >
      {NEW_WORKSPACE_ID_ONCE_NOTICE}
    </span>
  ) : step === "create" ? (
    formatMessage("workspace.create.lead")
  ) : step === "join" ? (
    formatMessage("workspace.add.joinLead")
  ) : step === "confirm" ? (
    formatMessage("workspace.add.joinConfirmBody")
  ) : (
    formatMessage("workspace.add.lead")
  );

  const joinTargetSentence = !joinTarget
    ? ""
    : joinTarget.kind === "server"
      ? formatMessage("workspace.add.joinTargetServer", {
          server: serverLabel(joinTarget.serverUrl),
        })
      : joinTarget.serverUrl !== ""
        ? formatMessage("workspace.add.joinTargetInvite", {
            server: serverLabel(joinTarget.serverUrl),
          })
        : formatMessage("workspace.add.joinTargetInviteOnly");

  return (
    <DialogContent
      opener={opener}
      data-testid="add-workspace-dialog"
      data-step={step}
      onKeyDown={(event) => {
        // ⌘↵ = 다이얼로그 기본 액션 (R-1 5장), from anywhere in the panel
        // including the trailing action row. 확인 걸음(로그아웃)은 기본 액션이 아니다:
        // 되돌릴 수 없는 일을 단축키 하나로 내지 않는다.
        if (!PRIMARY_ACTION_SHORTCUT.matches(event)) return;
        if (step === "create") {
          event.preventDefault();
          formRef.current?.requestSubmit();
        } else if (step === "join") {
          event.preventDefault();
          joinFormRef.current?.requestSubmit();
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
        <DialogTitle className="text-display">
          {title}
        </DialogTitle>
        {/* 만든 뒤에는 폼 설명이 쓸모없어서 그 자리를 경고가 쓴다. 고정 머리라 스크롤 상자 밖이고,
            값보다 앞이며, 어떤 창 높이에서도 보인다: Esc·바깥 클릭을 막은 이유(이 ID는 다시 볼 수
            없다)를 말하는 문장이 접힌 아래로 사라지면 눈에 보이는 컨트롤이 되돌릴 수 없는 「닫기」
            하나가 된다(design-review 3차 H1, 실측). */}
        <DialogDescription className="break-keep">{description}</DialogDescription>
      </div>

      {step === "choose" ? (
        <>
          <div
            className="flex min-h-0 flex-col gap-2 overflow-y-auto p-4"
            data-testid="add-workspace-choices"
          >
            <ChoiceCard
              icon={Plus}
              title={formatMessage("workspace.add.createTitle")}
              lead={formatMessage(
                confirmedNonOperator
                  ? "workspace.add.createLeadNotOperator"
                  : "workspace.add.createLead"
              )}
              unavailable={confirmedNonOperator}
              onChoose={() => goTo("create", "name")}
              buttonRef={createCardRef}
              onKeyDown={onCardKey}
              testId="add-workspace-choose-create"
            />
            <ChoiceCard
              icon={LinkIcon}
              title={formatMessage("workspace.add.joinTitle")}
              lead={formatMessage("workspace.add.joinLead")}
              onChoose={() => goTo("join", "join")}
              buttonRef={joinCardRef}
              onKeyDown={onCardKey}
              testId="add-workspace-choose-join"
            />
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-line p-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              data-testid="add-workspace-cancel"
            >
              {formatMessage("workspace.add.cancel")}
            </Button>
          </div>
        </>
      ) : step === "join" ? (
        <>
          {offline && (
            <InlineBanner
              tone="neutral"
              message={<BlockedReason frame="doThisLater" />}
              testId="add-workspace-join-offline"
            />
          )}
          <form
            id={JOIN_FORM_ID}
            ref={joinFormRef}
            onSubmit={submitJoin}
            className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4"
          >
            <WorkspaceDialogField
              label={formatMessage("workspace.add.joinField")}
              htmlFor="add-workspace-join-link"
              hint={formatMessage("workspace.add.joinHint")}
              error={joinError}
            >
              <Input
                id="add-workspace-join-link"
                ref={joinInputRef}
                name="join-link"
                value={joinLink}
                onChange={(event) => {
                  setJoinLink(event.target.value);
                  setJoinError(null);
                }}
                autoComplete="off"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={joinError ? true : undefined}
                aria-describedby={
                  joinError
                    ? "add-workspace-join-link-error"
                    : "add-workspace-join-link-hint"
                }
                data-testid="add-workspace-join-link"
              />
            </WorkspaceDialogField>
          </form>
          <div className="flex items-center justify-end gap-2 border-t border-line p-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => backToChoose("join")}
              data-testid="add-workspace-back"
            >
              {formatMessage("workspace.add.back")}
            </Button>
            <Button
              type="submit"
              form={JOIN_FORM_ID}
              size="sm"
              disabled={offline || joinChecking}
              aria-busy={joinChecking || undefined}
              data-testid="add-workspace-join-next"
            >
              {joinChecking
                ? formatMessage("workspace.add.joinChecking")
                : formatMessage("workspace.add.joinNext")}
            </Button>
          </div>
        </>
      ) : step === "confirm" ? (
        <>
          {/* 확인은 이 표면 안의 걸음이다(README §3.4). 초점은 위험 단추가 아니라 이 묶음으로 온다:
              이름(제목)과 넘어갈 곳이 먼저 읽히고, Enter 두 번이 로그아웃을 내지 않는다(ConfirmButton과
              같은 규칙). */}
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
            <div
              ref={confirmRef}
              tabIndex={-1}
              role="group"
              aria-label={title}
              aria-describedby={confirmTargetId}
              className="rounded-lg border border-line p-3 focus-visible:focus-ring"
              data-testid="add-workspace-join-confirm"
            >
              <p
                id={confirmTargetId}
                className="break-all text-body text-ink"
                data-testid="add-workspace-join-target"
              >
                {joinTargetSentence}
              </p>
            </div>
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-line p-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => goTo("join", "join")}
              data-testid="add-workspace-confirm-back"
            >
              {formatMessage("workspace.add.back")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handOffToLogin}
              data-testid="add-workspace-join-logout"
            >
              {formatMessage("workspace.add.joinConfirmAction")}
            </Button>
          </div>
        </>
      ) : created ? (
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
      ) : inCreate && operatorDenied ? (
        <div className="flex flex-col gap-3 p-4">
          <OperatorNotice
            who={formatMessage("workspace.create.operatorOnly")}
            contact={formatMessage("workspace.add.operatorContact")}
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                create.reset();
                backToChoose("create");
              }}
              data-testid="add-workspace-back"
            >
              {formatMessage("workspace.add.back")}
            </Button>
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
              message={<BlockedReason frame="createWorkspaceLater" />}
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
              hint={formatMessage("workspace.create.slugHint")}
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
              (design-taste-web §8). 첫 걸음으로 돌아가는 것이 이 걸음의 「취소」다. */}
          <div className="flex items-center justify-end gap-2 border-t border-line p-4">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={create.isPending}
              onClick={() => backToChoose("create")}
              data-testid="add-workspace-back"
            >
              {formatMessage("workspace.add.back")}
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
      {/* 열려 있는 동안에만 마운트한다: 이전 시도의 성공/거절/attempted와 걸음이 다음
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
