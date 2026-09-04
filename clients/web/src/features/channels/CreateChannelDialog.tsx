import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Hash, Loader2, Lock } from "lucide-react";
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
import { cn } from "@/design/lib/cn";
import { PRIMARY_ACTION_SHORTCUT } from "@/app/keyboardShortcuts";
import {
  channelNameIssue,
  channelNameIssueMessage,
  channelTopicIssue,
  channelTopicIssueMessage,
  normalizeChannelName,
  normalizeChannelTopic,
} from "@momo/core/features/channels/model";
import {
  CreateChannelOpenContext,
  CreateChannelOpenStateContext,
  useCreateChannel,
} from "./useCreateChannel";

// =============================================================================
// 채널 만들기 다이얼로그 (AX-1a / MOMO-614). The web sibling of
// MomoChannelCreationSheet: same fields, same rules, same words.
//
// What this ticket actually repairs is a dead end. 채널 만들기 used to send the
// reader to /settings, which has no such form, so the one action a new
// workspace offers ended nowhere. The form now lives where the action is
// offered, and on success the app lands IN the channel that was just made,
// because a channel you cannot see is not a channel you made.
//
// Validation is the server's own rule (model.ts), run before the request, and
// a server rejection lands beside the field it is about: "같은 이름의 채널이
// 이미 있습니다" belongs under the name box with the name still in it.
// =============================================================================

const FORM_ID = "create-channel-form";

const KINDS = [
  {
    id: "public" as const,
    label: "공개",
    detail: "워크스페이스의 누구나 찾아서 들어올 수 있습니다.",
    icon: <Hash className="size-4" />,
  },
  {
    id: "private" as const,
    label: "비공개",
    // 「초대」가 아니라 「추가」다 (#1573 예약 · #1584). 채널에 사람을 넣는 문은
    // 「멤버 추가」 다이얼로그 하나뿐이고, 「초대」는 워크스페이스에 새 사람을
    // 부르는 행위의 낱말로 예약돼 있다(`features/timeline/model.ts` 머리말).
    // 여기서 초대라고 말하면 읽는 사람은 이 제품에 없는 액션을 찾으러 간다.
    //
    // 형제 줄과 짝이 되는 자리이기도 하다: 공개는 스스로 **들어오고**, 비공개는
    // 누군가 **추가해야** 들어온다. 두 줄이 같은 동사 가족을 쓰면 그 대비가
    // 문장 하나로 읽힌다.
    detail: "추가된 멤버에게만 보입니다.",
    icon: <Lock className="size-4" />,
  },
];

/** 다이얼로그를 닫아도 남는 입력. 지운 적 없는 글은 지워지지 않는다. */
export interface ChannelDraft {
  kind: "public" | "private";
  name: string;
  topic: string;
}

const EMPTY_DRAFT: ChannelDraft = { kind: "public", name: "", topic: "" };

/**
 * Label, control, then one line under it that is either the hint or the error.
 *
 * The settings `Field` renders the same shape but does not wire `aria-invalid`
 * or `aria-describedby` onto the control, and a rejection that only exists as
 * red text below the box is a rejection a screen reader never hears. Here the
 * control is handed both ids, so the message is part of the field rather than
 * next to it.
 */
function DialogField({
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

function CreateChannelPanel({
  open,
  draft,
  setDraft,
  onOpenChange,
  opener,
}: {
  open: boolean;
  draft: ChannelDraft;
  setDraft: (next: ChannelDraft) => void;
  onOpenChange: (open: boolean) => void;
  opener?: DialogFocusTarget | null;
}) {
  const { pending, failure, create, clearFailure } = useCreateChannel();
  const offline = useOffline();

  const { kind, name, topic } = draft;
  const [attempted, setAttempted] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const topicRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // Keep the panel mounted through close so Radix Presence can play the exit
  // (UX-R1a H-1). Reset attempt/rejection on open; the draft stays on the
  // provider, which is why this is not `{open && <Panel/>}`.
  useEffect(() => {
    if (!open) return;
    setAttempted(false);
    clearFailure();
  }, [open, clearFailure]);

  const nameIssue = channelNameIssue(name);
  const topicIssue = channelTopicIssue(topic);

  // A rule is only worth stating once the reader has done something it applies
  // to: an untouched empty field is not a mistake, it is a field.
  const localNameError =
    nameIssue !== null && (attempted || name.trim() !== "")
      ? channelNameIssueMessage(nameIssue)
      : null;
  const nameError =
    localNameError ?? (failure?.field === "name" ? failure.message : null);
  const topicError =
    topicIssue !== null && (attempted || topic.trim() !== "")
      ? channelTopicIssueMessage(topicIssue)
      : null;
  const formError = failure && failure.field === null ? failure.message : null;

  // A rejection about the name is a request to change the name, so the caret
  // goes there. Editing clears the failure, so this fires once per rejection
  // and never fights the person for the cursor afterwards.
  useEffect(() => {
    if (failure?.field === "name") nameRef.current?.focus();
  }, [failure]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (pending || offline) return;
    if (nameIssue !== null || topicIssue !== null) {
      // Land the caret on the field that has to change, the same way the mac
      // sheet does, so the message and the cursor are in one place. The name
      // comes first when both are wrong, because it is the field the form
      // starts on and the only required one; a valid name with a 300자 주제
      // sends the caret to 주제, where the message actually is (R2 M1).
      const target = nameIssue !== null ? nameRef : topicRef;
      target.current?.focus();
      return;
    }
    const normalizedTopic = normalizeChannelTopic(topic);
    const created = await create({
      kind,
      name: normalizeChannelName(name),
      topic: normalizedTopic === "" ? undefined : normalizedTopic,
    });
    if (created) {
      // 만들어진 채널의 초안은 더 이상 초안이 아니다.
      setDraft(EMPTY_DRAFT);
      onOpenChange(false);
    }
  }

  // Editing invalidates the answer the server gave about the old input, so the
  // rejection goes with it instead of hanging over a name that has changed.
  const onInput = useCallback(
    (key: "name" | "topic") => (event: React.ChangeEvent<HTMLInputElement>) => {
      setDraft({ ...draft, [key]: event.target.value });
      clearFailure();
    },
    [draft, setDraft, clearFailure]
  );

  return (
    <DialogContent
      opener={opener}
      data-testid="create-channel-dialog"
      onKeyDown={(event) => {
        // ⌘↵ = 다이얼로그 기본 액션 (R-1 5장). On the <form> this reached the
        // fields and nothing else: [취소]와 [채널 만들기]는 form 밖에서 form=
        // 속성으로만 묶여 있어 keydown이 폼까지 올라가지 않았다. 패널 루트에
        // 걸면 액션 행을 포함해 다이얼로그 어디서든 같은 키가 같은 일을 한다.
        if (PRIMARY_ACTION_SHORTCUT.matches(event)) {
          event.preventDefault();
          formRef.current?.requestSubmit();
        }
      }}
      onEscapeKeyDown={(event) => {
        if (pending) event.preventDefault();
      }}
      onInteractOutside={(event) => {
        if (pending) event.preventDefault();
      }}
    >
      <div className="flex flex-col gap-1 border-b border-line p-4">
        <DialogTitle>채널 만들기</DialogTitle>
        <DialogDescription>
          공개 범위와 이름을 정하면 바로 그 채널로 들어갑니다.
        </DialogDescription>
      </div>

      {/* 오프라인이면 만들 수 없다고 말하고 버튼을 잠근다 (R-1 5장). 생성은
          REST 한 번이고 그 경로에는 데드라인이 걸려 있어(lib/http) 끊긴 채로
          누르면 15초 뒤 실패가 돌아온다. "지금 만들 수 있다"고 약속했다가 그
          실패로 반박당하느니, 설정 화면과 같은 문장으로 같은 사실을 말한다. */}
      {offline && (
        <InlineBanner
          tone="neutral"
          message="연결이 끊겼습니다. 채널 만들기는 다시 연결된 뒤에 할 수 있습니다."
          testId="create-channel-offline"
        />
      )}

      <form
        id={FORM_ID}
        ref={formRef}
        onSubmit={submit}
        className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4"
      >
        {/* 이름이 먼저다. 사람이 여기 온 이유이자 Radix가 기본으로 캐럿을 두는
            첫 tabbable이라, 보이는 순서와 Tab 순서와 시작 위치가 하나로 맞는다.
            공개 범위가 위에 있던 동안에는 정방향 Tab이 액션 버튼을 지나야 그
            선택지에 닿았다. 순서는 mac 시트(이름, 주제)를 잇는다. */}
        <DialogField
          label="채널 이름"
          htmlFor="create-channel-name"
          hint="영문, 숫자, 하이픈, 밑줄로 80자 이내, 처음과 끝은 영문이나 숫자. 대문자는 소문자로 저장됩니다."
          error={nameError}
        >
          <Input
            id="create-channel-name"
            ref={nameRef}
            name="name"
            value={name}
            onChange={onInput("name")}
            placeholder="product-planning"
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={
              nameError ? "create-channel-name-error" : "create-channel-name-hint"
            }
            data-testid="create-channel-name"
          />
        </DialogField>

        <DialogField
          label="주제"
          htmlFor="create-channel-topic"
          hint="선택 사항이며 280자까지 쓸 수 있습니다."
          error={topicError}
        >
          <Input
            id="create-channel-topic"
            ref={topicRef}
            name="topic"
            value={topic}
            onChange={onInput("topic")}
            placeholder="이 채널에서 무엇을 다루는지 한 줄로"
            autoComplete="off"
            disabled={pending}
            aria-invalid={topicError ? true : undefined}
            aria-describedby={
              topicError ? "create-channel-topic-error" : "create-channel-topic-hint"
            }
            data-testid="create-channel-topic"
          />
        </DialogField>

        <fieldset
          className="flex min-w-0 flex-col gap-1"
          disabled={pending}
          data-testid="create-channel-kind"
        >
          <legend className="pb-1 text-meta text-ink-muted">공개 범위</legend>
          {/* One bordered group with hairline rows, not a card per option: a box
              around every choice is the web-card tell and costs density. */}
          <div className="flex flex-col overflow-hidden rounded-md border border-line">
            {KINDS.map((choice) => (
              <label
                key={choice.id}
                htmlFor={`create-channel-kind-${choice.id}`}
                className={cn(
                  "flex min-w-0 cursor-pointer items-start gap-2 border-b border-line p-2 last:border-b-0",
                  kind === choice.id ? "bg-accent-soft" : "press hover:bg-surface-hover"
                )}
              >
                <input
                  type="radio"
                  id={`create-channel-kind-${choice.id}`}
                  name="create-channel-kind"
                  value={choice.id}
                  checked={kind === choice.id}
                  onChange={() => {
                    setDraft({ ...draft, kind: choice.id });
                    clearFailure();
                  }}
                  className="mt-1 accent-accent focus-visible:focus-ring"
                />
                <span aria-hidden="true" className="mt-px shrink-0 text-ink-muted">
                  {choice.icon}
                </span>
                <span className="flex min-w-0 flex-col gap-px">
                  <span className="text-body text-ink">{choice.label}</span>
                  <span className="text-meta text-ink-muted">{choice.detail}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {/* A rejection that belongs to the whole attempt rather than to one box
            (권한, 네트워크). Inline in the form, never a toast. */}
        {formError && (
          <p className="text-meta text-danger" role="alert" data-testid="create-channel-error">
            {formError}
          </p>
        )}
      </form>

      {/* Standard bordered buttons, trailing-aligned, default action last: not a
          pair of full-width filled bars (design-taste-web §8). */}
      <div className="flex items-center justify-end gap-2 border-t border-line p-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => onOpenChange(false)}
          data-testid="create-channel-cancel"
        >
          취소
        </Button>
        {/* 진행 중은 비활성이 아니라 바쁜 것이다. `disabled`를 걸면 하우스의
            disabled 흐리기(opacity-50)가 라벨을 2.2:1로 낮추는데, 하필 그
            순간의 라벨이 유일한 진행 신호다. 그래서 바쁜 동안에는 대비를 그대로
            두고 버튼 안 스피너를 켜며(R-1 5장), 클릭은 submit이 막는다. 그
            상태를 말하는 속성은 `aria-busy` 하나다: 조작이 실제로 가능한
            컨트롤에 `aria-disabled`까지 붙이면 스크린리더는 "사용 불가"라고
            읽는데 Enter는 그대로 먹는다(R2 M3).

            오프라인은 반대로 진짜 할 수 없는 일이라 진짜 `disabled`다. 이유는
            폼 위 배너가 이미 말한다. 여기 `title`을 달아도 하우스 버튼의
            `disabled:pointer-events-none` 때문에 hover 자체가 도달하지 않아
            영원히 뜨지 않는 툴팁이었다(R2 M2). 같은 사실을 두 번 약속하느니
            한 번 지킨다. */}
        <Button
          type="submit"
          form={FORM_ID}
          size="sm"
          disabled={offline}
          aria-busy={pending || undefined}
          data-testid="create-channel-submit"
        >
          {pending && <Loader2 aria-hidden="true" className="spinner-busy" />}
          {pending ? "채널 만드는 중" : "채널 만들기"}
        </Button>
      </div>
    </DialogContent>
  );
}

export function CreateChannelDialog({
  open,
  onOpenChange,
  draft,
  setDraft,
  opener,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: ChannelDraft;
  setDraft: (next: ChannelDraft) => void;
  opener?: DialogFocusTarget | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Content stays mounted while `open` is false so Presence can run the
          close (ShortcutHelpDialog). Attempt/rejection reset on open, above;
          opener is the trigger captured at openCreate, not a remount. Draft
          lives on the provider, so 280자를 쓰다가 바깥을 한 번 클릭해도 글은
          그대로 있고 다시 열면 이어서 쓴다. */}
      <CreateChannelPanel
        open={open}
        draft={draft}
        setDraft={setDraft}
        onOpenChange={onOpenChange}
        opener={opener}
      />
    </Dialog>
  );
}

/**
 * Holds the one dialog for the whole signed-in shell and hands its entry points
 * the verb that opens it (sidebar header +, empty workspace, ⌘K 팔레트).
 */
export function CreateChannelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ChannelDraft>(EMPTY_DRAFT);
  const openerRef = useRef<DialogFocusTarget | null>(null);
  const openCreate = useCallback((opener?: DialogFocusTarget | null) => {
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
    <CreateChannelOpenContext.Provider value={openCreate}>
      {/* 열림 상태는 별도 컨텍스트다. 셸의 전역 단축키가 모달 위에서 발화하지
          않으려면 이 값을 읽어야 하고(R2 M4), verb만 쓰는 진입점 셋은 이
          상태 변화로 다시 그릴 이유가 없다. */}
      <CreateChannelOpenStateContext.Provider value={open}>
        {children}
      </CreateChannelOpenStateContext.Provider>
      <CreateChannelDialog
        open={open}
        onOpenChange={onOpenChange}
        draft={draft}
        setDraft={setDraft}
        opener={openerRef.current}
      />
    </CreateChannelOpenContext.Provider>
  );
}
