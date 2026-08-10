import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
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
import { cn } from "@/design/lib/cn";
import type { CreatedAgent } from "@momo/core/lib/api";
import {
  EMPTY_AGENT_DRAFT,
  INSTRUCTIONS_MAX_BYTES,
  agentBaseUrlIssue,
  agentBaseUrlIssueMessage,
  agentDisplayNameIssue,
  agentDisplayNameIssueMessage,
  agentHandleIssue,
  agentHandleIssueMessage,
  agentModelIssue,
  agentModelIssueMessage,
  instructionsIssue,
  instructionsIssueMessage,
  normalizeAgentHandle,
  utf8Bytes,
  type AgentDraft,
} from "./createModel";
import { useCreateAgent } from "./useCreateAgent";

// =============================================================================
// 에이전트 만들기 다이얼로그 (goal B5.3b, D-4).
//
// There is no bot to install and no marketplace to browse: this form mints a
// member (ADR-0004 invariant #5), which is why it asks for the same two things
// a person's join asks for (표시 이름, 핸들) plus the two an agent needs to be
// reachable (모델, 게이트웨이 주소). The words on the labels are the words the
// roster will use afterwards.
//
// **No credential field, and that is the design.** The one thing an operator
// will look for here is where to paste the API key, so the form says out loud
// that it does not take one and where the key does live (ADR-0004: provider
// credentials never enter momo). The server enforces the same thing from the
// other side and refuses any credential-shaped key at any depth, so a form that
// offered the box would be offering a 400.
//
// Everything else is the channel dialog's shape, on purpose: same field/hint/
// error anatomy, same ⌘↵, same offline rule, same in-button spinner. A second
// vocabulary for "this form was refused" is how two forms start disagreeing.
// =============================================================================

const FORM_ID = "create-agent-form";

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

function CreateAgentPanel({
  draft,
  setDraft,
  onCreated,
  onOpenChange,
}: {
  draft: AgentDraft;
  setDraft: (next: AgentDraft) => void;
  onCreated: (created: CreatedAgent) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { pending, failure, create, clearFailure } = useCreateAgent();
  const offline = useOffline();

  const { displayName, handle, model, baseUrl, instructions } = draft;
  const [attempted, setAttempted] = useState(false);
  const displayNameRef = useRef<HTMLInputElement>(null);
  const handleRef = useRef<HTMLInputElement>(null);
  const modelRef = useRef<HTMLInputElement>(null);
  const baseUrlRef = useRef<HTMLInputElement>(null);
  const instructionsRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const displayNameIssue = agentDisplayNameIssue(displayName);
  const handleIssue = agentHandleIssue(handle);
  const modelIssue = agentModelIssue(model);
  const baseUrlIssueValue = agentBaseUrlIssue(baseUrl);
  const instructionsIssueValue = instructionsIssue(instructions);
  const instructionBytes = utf8Bytes(instructions);

  // A rule is only worth stating once the reader has done something it applies
  // to: an untouched empty field is not a mistake, it is a field.
  const stated = (raw: string) => attempted || raw.trim() !== "";

  const displayNameError =
    displayNameIssue !== null && stated(displayName)
      ? agentDisplayNameIssueMessage(displayNameIssue)
      : null;
  const localHandleError =
    handleIssue !== null && stated(handle)
      ? agentHandleIssueMessage(handleIssue)
      : null;
  const handleError =
    localHandleError ?? (failure?.field === "handle" ? failure.message : null);
  const localModelError =
    modelIssue !== null && stated(model)
      ? agentModelIssueMessage(modelIssue)
      : null;
  const modelError =
    localModelError ?? (failure?.field === "model" ? failure.message : null);
  const localBaseUrlError =
    baseUrlIssueValue !== null && stated(baseUrl)
      ? agentBaseUrlIssueMessage(baseUrlIssueValue)
      : null;
  const baseUrlError =
    localBaseUrlError ?? (failure?.field === "baseUrl" ? failure.message : null);
  const instructionsError =
    instructionsIssueValue !== null ? instructionsIssueMessage() : null;
  const formError = failure && failure.field === null ? failure.message : null;

  // A rejection about a field is a request to change that field, so the caret
  // goes there. Editing clears the failure, so this fires once per rejection.
  useEffect(() => {
    if (failure?.field === "handle") handleRef.current?.focus();
    else if (failure?.field === "model") modelRef.current?.focus();
    else if (failure?.field === "baseUrl") baseUrlRef.current?.focus();
  }, [failure]);

  const onInput = useCallback(
    (key: keyof AgentDraft) =>
      (
        event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
      ): void => {
        setDraft({ ...draft, [key]: event.target.value });
        clearFailure();
      },
    [draft, setDraft, clearFailure]
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (pending || offline) return;
    // The caret lands on the first field that has to change, reading order top
    // to bottom, so the message and the cursor are always in one place.
    const firstBad =
      displayNameIssue !== null
        ? displayNameRef
        : handleIssue !== null
          ? handleRef
          : modelIssue !== null
            ? modelRef
            : baseUrlIssueValue !== null
              ? baseUrlRef
              : instructionsIssueValue !== null
                ? instructionsRef
                : null;
    if (firstBad !== null) {
      firstBad.current?.focus();
      return;
    }
    const trimmedInstructions = instructions.trim();
    const created = await create({
      displayName: displayName.trim(),
      handle: normalizeAgentHandle(handle),
      model: model.trim(),
      baseUrl: baseUrl.trim(),
      ...(trimmedInstructions === ""
        ? {}
        : { profile: { instructions: trimmedInstructions } }),
    });
    if (created) {
      setDraft(EMPTY_AGENT_DRAFT);
      onCreated(created);
      onOpenChange(false);
    }
  }

  return (
    <DialogContent
      data-testid="create-agent-dialog"
      onKeyDown={(event) => {
        // ⌘↵ = 다이얼로그 기본 액션 (R-1 5장). On the panel root rather than the
        // form, because the action row is outside the form and bound by `form=`.
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
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
        <DialogTitle>에이전트 만들기</DialogTitle>
        <DialogDescription>
          에이전트는 워크스페이스의 멤버가 됩니다. 만든 뒤 채널에 넣으면 그
          채널에서 멘션할 수 있습니다.
        </DialogDescription>
      </div>

      {offline && (
        <InlineBanner
          tone="neutral"
          message="연결이 끊겼습니다. 에이전트 만들기는 다시 연결된 뒤에 할 수 있습니다."
          testId="create-agent-offline"
        />
      )}

      <form
        id={FORM_ID}
        ref={formRef}
        onSubmit={submit}
        className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4"
      >
        <DialogField
          label="표시 이름"
          htmlFor="create-agent-display-name"
          hint="사람들이 목록과 메시지에서 보게 될 이름입니다. 100자 이내."
          error={displayNameError}
        >
          <Input
            id="create-agent-display-name"
            ref={displayNameRef}
            name="displayName"
            value={displayName}
            onChange={onInput("displayName")}
            placeholder="김인턴"
            autoComplete="off"
            disabled={pending}
            aria-invalid={displayNameError ? true : undefined}
            aria-describedby={
              displayNameError
                ? "create-agent-display-name-error"
                : "create-agent-display-name-hint"
            }
            data-testid="create-agent-display-name"
          />
        </DialogField>

        <DialogField
          label="핸들"
          htmlFor="create-agent-handle"
          hint="멘션에 쓰는 이름입니다. 영문 소문자, 숫자, 하이픈, 밑줄로 2자 이상 32자 이내. 대문자는 소문자로 저장됩니다."
          error={handleError}
        >
          <Input
            id="create-agent-handle"
            ref={handleRef}
            name="handle"
            value={handle}
            onChange={onInput("handle")}
            placeholder="kim-intern"
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
            aria-invalid={handleError ? true : undefined}
            aria-describedby={
              handleError ? "create-agent-handle-error" : "create-agent-handle-hint"
            }
            data-testid="create-agent-handle"
          />
        </DialogField>

        <DialogField
          label="모델"
          htmlFor="create-agent-model"
          hint="이 에이전트가 기본으로 쓸 모델 이름입니다. 나중에 프로필에서 바꿀 수 있습니다."
          error={modelError}
        >
          <Input
            id="create-agent-model"
            ref={modelRef}
            name="model"
            value={model}
            onChange={onInput("model")}
            placeholder="hermes-agent"
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
            aria-invalid={modelError ? true : undefined}
            aria-describedby={
              modelError ? "create-agent-model-error" : "create-agent-model-hint"
            }
            data-testid="create-agent-model"
          />
        </DialogField>

        <DialogField
          label="게이트웨이 주소"
          htmlFor="create-agent-base-url"
          hint="이 에이전트를 실행할 곳입니다. 외부 주소는 https, 같은 기기라면 포트까지 적습니다."
          error={baseUrlError}
        >
          <Input
            id="create-agent-base-url"
            ref={baseUrlRef}
            name="baseUrl"
            type="url"
            value={baseUrl}
            onChange={onInput("baseUrl")}
            placeholder="https://gateway.example.com/v1"
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
            aria-invalid={baseUrlError ? true : undefined}
            aria-describedby={
              baseUrlError
                ? "create-agent-base-url-error"
                : "create-agent-base-url-hint"
            }
            data-testid="create-agent-base-url"
          />
        </DialogField>

        <DialogField
          label="지시문"
          htmlFor="create-agent-instructions"
          hint="선택 사항입니다. 답변 방식과 작업 경계를 적으면 첫 프로필로 저장됩니다."
          error={instructionsError}
        >
          <textarea
            id="create-agent-instructions"
            ref={instructionsRef}
            name="instructions"
            value={instructions}
            onChange={onInput("instructions")}
            rows={4}
            disabled={pending}
            className="w-full resize-y rounded-sm border border-line-strong bg-transparent px-3 py-2 text-body text-ink placeholder:text-ink-muted focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50"
            placeholder="검증 근거를 먼저 보여 주고, 확실하지 않으면 확실하지 않다고 말합니다."
            aria-invalid={instructionsError ? true : undefined}
            aria-describedby={
              instructionsError
                ? "create-agent-instructions-error"
                : "create-agent-instructions-hint"
            }
            data-testid="create-agent-instructions"
          />
        </DialogField>
        {instructions !== "" && (
          <p
            className={cn(
              "text-meta",
              instructionsError ? "text-danger" : "text-ink-muted"
            )}
            data-numeric
          >
            UTF-8 {instructionBytes.toLocaleString("ko-KR")} /{" "}
            {INSTRUCTIONS_MAX_BYTES.toLocaleString("ko-KR")} bytes
          </p>
        )}

        {/* 자격증명을 어디에 넣느냐가 이 폼에서 가장 먼저 나오는 질문이다.
            묻기 전에 답한다: 여기에는 넣지 않고, 서버도 받지 않는다(ADR-0004). */}
        <p
          className="border-t border-line pt-4 text-meta text-ink-muted"
          data-testid="create-agent-credential-note"
        >
          API 키는 여기에 넣지 않습니다. 프로바이더 자격증명은 설정의 AI 연결에서
          한 번만 등록하고, 에이전트는 그 연결을 통해 실행됩니다.
        </p>

        {formError && (
          <p
            className="text-meta text-danger"
            role="alert"
            data-testid="create-agent-error"
          >
            {formError}
          </p>
        )}
      </form>

      <div className="flex items-center justify-end gap-2 border-t border-line p-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => onOpenChange(false)}
          data-testid="create-agent-cancel"
        >
          취소
        </Button>
        {/* 진행 중은 비활성이 아니라 바쁜 것이다(채널 만들기와 같은 규칙): 라벨
            대비를 그대로 두고 버튼 안 스피너를 켜며, 두 번째 클릭은 submit이
            막는다. 오프라인만 진짜 disabled이고 이유는 위 배너가 말한다. */}
        <Button
          type="submit"
          form={FORM_ID}
          size="sm"
          disabled={offline}
          aria-busy={pending || undefined}
          data-testid="create-agent-submit"
        >
          {pending && <Loader2 aria-hidden="true" className="spinner-busy" />}
          {pending ? "에이전트 만드는 중" : "에이전트 만들기"}
        </Button>
      </div>
    </DialogContent>
  );
}

export function CreateAgentDialog({
  open,
  onOpenChange,
  draft,
  setDraft,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: AgentDraft;
  setDraft: (next: AgentDraft) => void;
  onCreated: (created: CreatedAgent) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 열려 있는 동안에만 마운트한다: 이전 시도의 거절과 attempted 플래그가
          다음 열기까지 따라오지 않고, 여는 순간의 activeElement가 곧 "무엇이
          이걸 열었나"이기 때문이다(dialog.tsx가 닫을 때 그리로 돌려준다).
          초안은 밖에 있어서, 쓰다가 닫아도 글은 남는다. */}
      {open && (
        <CreateAgentPanel
          draft={draft}
          setDraft={setDraft}
          onCreated={onCreated}
          onOpenChange={onOpenChange}
        />
      )}
    </Dialog>
  );
}
