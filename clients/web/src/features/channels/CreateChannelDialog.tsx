import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Hash, Lock } from "lucide-react";
import { useSession } from "@/app/session";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import { Input } from "@/design/ui/input";
import { InlineBanner } from "@/features/common/States";
import { cn } from "@/design/lib/cn";
import {
  channelNameIssue,
  channelNameIssueMessage,
  channelTopicIssue,
  channelTopicIssueMessage,
  normalizeChannelName,
  normalizeChannelTopic,
} from "./model";
import {
  CreateChannelOpenContext,
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
    detail: "초대받은 멤버에게만 보입니다.",
    icon: <Lock className="size-4" />,
  },
];

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
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
}) {
  const { connStatus } = useSession();
  const { pending, failure, create, clearFailure } = useCreateChannel();

  const [kind, setKind] = useState<"public" | "private">("public");
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [attempted, setAttempted] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  const nameIssue = channelNameIssue(name);
  const topicIssue = channelTopicIssue(topic);
  const offline = connStatus === "disconnected";

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
    if (pending) return;
    if (nameIssue !== null || topicIssue !== null) {
      // Land the caret on the field that has to change, the same way the mac
      // sheet does, so the message and the cursor are in one place.
      nameRef.current?.focus();
      return;
    }
    const normalizedTopic = normalizeChannelTopic(topic);
    const created = await create({
      kind,
      name: normalizeChannelName(name),
      topic: normalizedTopic === "" ? undefined : normalizedTopic,
    });
    if (created) onOpenChange(false);
  }

  // Editing invalidates the answer the server gave about the old input, so the
  // rejection goes with it instead of hanging over a name that has changed.
  const onInput = useCallback(
    (set: (value: string) => void) => (event: React.ChangeEvent<HTMLInputElement>) => {
      set(event.target.value);
      clearFailure();
    },
    [clearFailure]
  );

  return (
    <DialogContent
      data-testid="create-channel-dialog"
      onOpenAutoFocus={(event) => {
        // Radix would focus the first tabbable element, which is the 공개 범위
        // radio. The field a person came here to fill is the name.
        event.preventDefault();
        nameRef.current?.focus();
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

      {/* 오프라인은 사실 보고이지 금지가 아니다: 채널 생성은 REST 한 번이고 그
          경로에는 데드라인이 걸려 있어(lib/http) 서버가 없으면 그렇다고 말한다.
          끊긴 것은 실시간 레일이므로, 그 결과만 정확히 알린다. */}
      {offline && (
        <InlineBanner
          tone="neutral"
          message="연결 끊김, 재연결 중입니다. 채널은 지금 만들 수 있고, 새 메시지는 연결이 돌아온 뒤 도착합니다."
          testId="create-channel-offline"
        />
      )}

      <form
        id={FORM_ID}
        onSubmit={submit}
        onKeyDown={(event) => {
          // ⌘↵ = 다이얼로그 기본 액션 (R-1 §5). Plain Enter already submits from
          // a text input; this is the path from anywhere else in the form.
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.requestSubmit();
          }
        }}
        className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4"
      >
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
                  kind === choice.id ? "bg-accent-soft" : "hover:bg-surface-hover"
                )}
              >
                <input
                  type="radio"
                  id={`create-channel-kind-${choice.id}`}
                  name="create-channel-kind"
                  value={choice.id}
                  checked={kind === choice.id}
                  onChange={() => {
                    setKind(choice.id);
                    clearFailure();
                  }}
                  className="mt-1 accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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

        <DialogField
          label="채널 이름"
          htmlFor="create-channel-name"
          hint="영문, 숫자, 하이픈, 밑줄로 80자 이내로 입력하세요. 영문은 소문자로 저장됩니다."
          error={nameError}
        >
          <Input
            id="create-channel-name"
            ref={nameRef}
            name="name"
            value={name}
            onChange={onInput(setName)}
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
            name="topic"
            value={topic}
            onChange={onInput(setTopic)}
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
        <Button
          type="submit"
          form={FORM_ID}
          size="sm"
          disabled={pending}
          data-testid="create-channel-submit"
        >
          {pending ? "채널 만드는 중" : "채널 만들기"}
        </Button>
      </div>
    </DialogContent>
  );
}

export function CreateChannelDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Mounted only while open, so every opening starts on an empty form
          rather than on the abandoned draft of the last one. */}
      {open && <CreateChannelPanel onOpenChange={onOpenChange} />}
    </Dialog>
  );
}

/**
 * Holds the one dialog for the whole signed-in shell and hands its entry points
 * the verb that opens it (sidebar header +, sidebar empty state, empty
 * workspace).
 */
export function CreateChannelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openCreate = useCallback(() => setOpen(true), []);
  return (
    <CreateChannelOpenContext.Provider value={openCreate}>
      {children}
      <CreateChannelDialog open={open} onOpenChange={setOpen} />
    </CreateChannelOpenContext.Provider>
  );
}
