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
import type { MessageKey } from "@momo/core/i18n";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import {
  CreateChannelOpenContext,
  CreateChannelOpenStateContext,
  useCreateChannel,
} from "./useCreateChannel";
import {
  useOpenAddChannelMember,
  type AddChannelMemberTarget,
} from "./useAddChannelMember";
import { BlockedReason } from "@/features/common/BlockedReason";

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

const KINDS: {
  id: "public" | "private";
  label: string;
  detailKey: Extract<
    MessageKey,
    "timeline.createChannel.publicDetail" | "timeline.createChannel.privateDetail"
  >;
  icon: ReactNode;
}[] = [
  {
    id: "public" as const,
    label: "공개",
    // 공개 채널을 「찾아서 들어오는」 길은 아직 없다(둘러보기·스스로 참여 라우트가 없음, #5784). 그래서 이 줄은 지금
    // 동작 그대로 말한다: 소유자·관리자가 「멤버 추가」로 넣은 사람이 들어오고, 초대 링크로 새로 합류하는 사람은 그
    // 순간의 공개 채널에 자동으로 들어간다(서버 `join_public_channels`). 문장은 폰 「새 채널」 시트와 같은 사전 키다.
    detailKey: "timeline.createChannel.publicDetail",
    icon: <Hash className="size-4" />,
  },
  {
    id: "private" as const,
    label: "비공개",
    // 「초대」가 아니라 「추가」다 (#1573 예약 · #1584). 채널에 사람을 넣는 문은
    // 「멤버 추가」 다이얼로그 하나뿐이고, 「초대」는 워크스페이스에 새 사람을
    // 부르는 행위의 낱말로 예약돼 있다(`features/timeline/model.ts` 머리말).
    // 여기서 초대라고 말하면 읽는 사람은 이 제품에 없는 액션을 찾으러 간다.
    // 두 줄 모두 「추가」 가족이다: 공개도 지금은 누군가 추가해야 들어오고, 다른 점은 새로 합류하는 사람이다.
    detailKey: "timeline.createChannel.privateDetail",
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
  onCreatedPrivate,
  opener,
}: {
  open: boolean;
  draft: ChannelDraft;
  setDraft: (next: ChannelDraft) => void;
  onOpenChange: (open: boolean) => void;
  /** 비공개 채널이 만들어졌다 — 이 다이얼로그를 닫고 「멤버 추가」로 넘긴다(#5784). */
  onCreatedPrivate: (target: AddChannelMemberTarget) => void;
  opener?: DialogFocusTarget | null;
}) {
  const { pending, failure, create, clearFailure } = useCreateChannel();
  const offline = useOffline();
  const formatMessage = useFormatMessage();
  // 「멤버 추가」로 넘겼는가. 넘긴 닫힘에서는 이 다이얼로그가 열었던 자리로 캐럿을 돌려주지 않는다 — 캐럿은 이어서 뜬
  // 「멤버 추가」 안에 있어야 하고, 그 창이 닫힐 때 같은 자리로 돌려준다(여는 자리를 넘겨받는다).
  const handedOff = useRef(false);

  const { kind, name, topic } = draft;
  const [attempted, setAttempted] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const topicRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // 이 다이얼로그가 닫힌 적이 있는가 — 마지막 제출 이후로(#5058). 만드는 동안 알림 클릭이 착지하면 다이얼로그는 걷히고(Esc 와 바깥
  // 클릭을 막는 것은 Radix 의 입력이라 방송은 그 규칙을 지나지 않는다) 요청은 계속 간다. 늦은 응답이 알림이 세운 목적지를
  // 덮어쓰지 않게 이 값으로 이동을 가른다. 다시 열렸어도 「닫힌 적 있음」은 남는다 — 새로 연 다이얼로그를 이 요청이 닫지 않는다.
  const closedSinceSubmit = useRef(false);

  // Keep the panel mounted through close so Radix Presence can play the exit
  // (UX-R1a H-1). Reset attempt/rejection on open; the draft stays on the
  // provider, which is why this is not `{open && <Panel/>}`.
  useEffect(() => {
    if (!open) {
      closedSinceSubmit.current = true;
      return;
    }
    handedOff.current = false;
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
    closedSinceSubmit.current = false;
    const created = await create(
      {
        kind,
        name: normalizeChannelName(name),
        topic: normalizedTopic === "" ? undefined : normalizedTopic,
      },
      { navigateIf: () => !closedSinceSubmit.current }
    );
    if (created) {
      // 만들어진 채널의 초안은 더 이상 초안이 아니다.
      setDraft(EMPTY_DRAFT);
      // 이미 걷힌 다이얼로그를 다시 닫지 않는다 — 닫기는 열었던 자리로 초점을 돌려주는데(`onOpenChange`), 그 사이 사람은 알림의 대화로
      // 가 있다. 같은 까닭으로 「멤버 추가」도 잇지 않는다: 알림이 세운 목적지 위에 창을 띄우지 않는다.
      if (closedSinceSubmit.current) return;
      if (created.kind === "private") {
        // 비공개 채널은 만든 사람 한 명으로 시작하고, 다른 사람은 누군가 추가해야 들어온다. 만든 그 자리에서 「멤버 추가」를
        // 이어서 연다 — 「나중에」로 건너뛸 수 있다(#5784).
        handedOff.current = true;
        onCreatedPrivate({
          id: created.id,
          name: created.name ?? normalizeChannelName(name),
          afterCreate: true,
        });
        return;
      }
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
      onCloseAutoFocus={(event) => {
        // 「멤버 추가」로 넘긴 닫힘이면 열었던 자리로 캐럿을 끌어오지 않는다(위 `handedOff`).
        if (handedOff.current) event.preventDefault();
      }}
    >
      <div className="flex flex-col gap-1 border-b border-line p-4">
        <DialogTitle>채널 만들기</DialogTitle>
        <DialogDescription>
          공개 범위와 이름을 정하면 바로 그 채널로 들어가요.
        </DialogDescription>
      </div>

      {/* 오프라인이면 만들 수 없다고 말하고 버튼을 잠근다 (R-1 5장). 생성은
          REST 한 번이고 그 경로에는 데드라인이 걸려 있어(lib/http) 끊긴 채로
          누르면 15초 뒤 실패가 돌아온다. "지금 만들 수 있다"고 약속했다가 그
          실패로 반박당하느니, 설정 화면과 같은 문장으로 같은 사실을 말한다. */}
      {offline && (
        <InlineBanner
          tone="neutral"
          message={<BlockedReason frame="createChannelLater" />}
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
          hint="영문, 숫자, 하이픈, 밑줄로 80자 이내, 처음과 끝은 영문이나 숫자. 대문자는 소문자로 저장돼요."
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
          hint="선택 사항이에요. 280자까지 쓸 수 있어요."
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
                  kind === choice.id
                    ? "bg-accent-soft active:bg-surface-pressed"
                    : "hover:bg-surface-hover active:bg-surface-pressed"
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
                  {/* 공개 설명이 두 문장으로 길어져 좁은 폭에서 「워크스페/이스」처럼 어절 가운데서 꺾였다 — 어절에서 꺾는다. */}
                  <span className="break-keep text-meta text-ink-muted">
                    {formatMessage(choice.detailKey)}
                  </span>
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
  onCreatedPrivate,
  draft,
  setDraft,
  opener,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreatedPrivate: (target: AddChannelMemberTarget) => void;
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
        onCreatedPrivate={onCreatedPrivate}
        opener={opener}
      />
    </Dialog>
  );
}

/**
 * Holds the one dialog for the whole signed-in shell and hands its entry points
 * the verb that opens it (sidebar header +, empty workspace, ⌘K 팔레트).
 *
 * 셸의 「멤버 추가」 provider 안에 있어야 한다(#5784): 비공개 채널을 만들면 그 창을 이어서 연다. 밖에 두면 여는 동사가 없어
 * 렌더에서 바로 던진다 — 조용히 안 뜨는 쪽보다 낫다(`AppShell.tsx` 의 순서, 시험이 소스로 잰다).
 */
export function CreateChannelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ChannelDraft>(EMPTY_DRAFT);
  const openerRef = useRef<DialogFocusTarget | null>(null);
  const openAddMember = useOpenAddChannelMember();
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
  // 만들기 창을 닫고 「멤버 추가」를 연다. 캐럿은 여기서 돌려주지 않고, 이 창을 열었던 자리를 「멤버 추가」에 넘겨 그 창이 닫힐
  // 때 그리로 돌아가게 한다 — 사람에게는 만들기에서 멤버 추가까지가 한 걸음이다.
  const onCreatedPrivate = useCallback(
    (target: AddChannelMemberTarget) => {
      setOpen(false);
      openAddMember({ ...target, opener: openerRef.current });
    },
    [openAddMember]
  );
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
        onCreatedPrivate={onCreatedPrivate}
        draft={draft}
        setDraft={setDraft}
        opener={openerRef.current}
      />
    </CreateChannelOpenContext.Provider>
  );
}
