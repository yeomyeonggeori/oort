import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import type { LocalHarnessId } from "@momo/core/features/hostedAgents/detect";
import { expressionForState } from "@momo/core/features/onboarding/guide";
import {
  CALM_BADGE,
  CALM_CLOSE_LABEL,
  CONFIRM_LATER_LABEL,
  CONFIRM_NAME_HINT,
  CONFIRM_NAME_LABEL,
  DONE_AGENTS_LABEL,
  DONE_CLOSE_LABEL,
  EXISTING_DETAIL,
  FAILED_CLOSE_LABEL,
  FAILED_RETRY_LABEL,
  MANUAL_DISCLOSURE_HIDE_LABEL,
  MANUAL_DISCLOSURE_LABEL,
  REGISTERING_SERVER_STAGE,
  REGISTER_NO_STORE_NOTE,
  calmDetail,
  calmLine,
  confirmBullets,
  confirmCreateLabel,
  confirmTitle,
  defaultAgentHandle,
  doneDetail,
  doneLine,
  existingLine,
  failedLine,
  isCalmRefusal,
  loggedInLine,
  manualDetail,
  manualLine,
  normalizeAgentHandle,
  registeringCliStage,
  registeringLine,
} from "@momo/core/features/onboarding/subscriptionRegister";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { KomettoGuide } from "@/features/onboarding/guide/KomettoGuide";
import { SubscriptionConnectBlock } from "@/features/welcome/SubscriptionConnectBlock";
import {
  createRegisterController,
  type RegisterController,
  type RegisterDeps,
} from "./registerController";

// Reading this as: onboarding (AI 연결 · 로그인 뒤 에이전트로 만들기) for internal
// team users on Tauri desktop, density 5/10, motion 1/10.

/** 호출한 쪽(로그인 모달)이 넘기는 것. */
export interface RegisterContext {
  /** 이름 칸의 기본값 `<내 핸들>-claude`를 만드는 재료. */
  memberHandle: string;
  deps: RegisterDeps;
  /** 완료 화면의 「에이전트 보기」. */
  onOpenAgents: () => void;
}

/** 캡처가 세우는 단계(컨트롤러 없이). */
export interface RegisterFixture {
  state: import("./registerController").RegisterState;
}

const NOOP = () => undefined;
const emptySubscribe = () => NOOP;

/**
 * 로그인 모달이 「연결됐어요」 뒤에 같은 창에서 이어 그리는 본문(시안 3·4번 패널).
 * 확인 단계는 건너뛸 수 없다: 서버와 셸은 [@이름 만들기]를 누른 뒤에만 불린다.
 */
export function RegisterStepBody({
  harness,
  context,
  onClose,
  fixture,
  showLoggedIn = true,
}: {
  harness: LocalHarnessId;
  context: RegisterContext;
  onClose: () => void;
  fixture?: RegisterFixture | null;
  /** 로그인을 막 마친 흐름이면 첫 줄에 「로그인됐어요」를 붙인다. */
  showLoggedIn?: boolean;
}) {
  const defaultHandle = useMemo(
    () => defaultAgentHandle(harness, context.memberHandle),
    [harness, context.memberHandle]
  );
  const controller = useMemo<RegisterController | null>(
    () => (fixture ? null : createRegisterController(harness, defaultHandle, context.deps)),
    // 한 번 열린 단계는 한 컨트롤러를 쓴다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  useEffect(() => () => controller?.dispose(), [controller]);
  const live = useSyncExternalStore(
    controller?.subscribe ?? emptySubscribe,
    controller?.getState ?? (() => fixture!.state),
    () => (fixture ? fixture.state : controller!.getState())
  );
  const state = fixture?.state ?? live;
  const lineId = useId();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stepName = state.step.step;
  useEffect(() => {
    if (stepName === "confirm") inputRef.current?.focus();
    else primaryRef.current?.focus();
  }, [stepName]);

  const handle = normalizeAgentHandle(state.handle);
  const step = state.step;

  if (step.step === "confirm") {
    return (
      <form
        className="flex min-w-0 flex-col gap-4"
        data-testid="register-confirm"
        data-step="confirm"
        onSubmit={(event) => {
          event.preventDefault();
          void controller?.submit();
        }}
      >
        <KomettoGuide
          expression={expressionForState("awaiting")}
          line={confirmTitle(harness, handle === "" ? defaultHandle : handle)}
          detail={showLoggedIn ? loggedInLine(harness) : undefined}
          lineId={lineId}
          lineTestId="register-line"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={`${lineId}-name`} className="text-meta text-ink-muted">
            {CONFIRM_NAME_LABEL}
          </label>
          <div className="flex min-w-0 items-center gap-2">
            <span aria-hidden="true" className="text-body text-ink-muted">
              @
            </span>
            <Input
              ref={inputRef}
              id={`${lineId}-name`}
              value={state.handle}
              onChange={(event) => controller?.setHandle(event.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-invalid={step.problem ? true : undefined}
              aria-describedby={`${lineId}-hint`}
              className="min-w-0 flex-1 font-mono"
              data-testid="register-name"
            />
          </div>
          <p
            id={`${lineId}-hint`}
            role={step.problem ? "alert" : undefined}
            className="break-keep text-meta text-ink-muted"
            data-testid="register-name-hint"
          >
            {step.problem ?? CONFIRM_NAME_HINT}
          </p>
        </div>
        <ul className="flex min-w-0 list-disc flex-col gap-1 pl-4 text-meta text-ink-muted">
          {confirmBullets(harness).map((bullet) => (
            <li key={bullet} className="break-keep">
              {bullet}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            className="ai-connect-secondary"
            onClick={onClose}
            data-testid="register-later"
          >
            {CONFIRM_LATER_LABEL}
          </Button>
          <Button
            ref={primaryRef}
            type="submit"
            disabled={handle === ""}
            data-testid="register-create"
          >
            {confirmCreateLabel(handle === "" ? defaultHandle : handle)}
          </Button>
        </div>
      </form>
    );
  }

  if (step.step === "registering") {
    const stages =
      harness === "claude"
        ? [REGISTERING_SERVER_STAGE, registeringCliStage(harness)]
        : [REGISTERING_SERVER_STAGE];
    const at = step.stage === "server" ? 0 : 1;
    return (
      <div className="flex min-w-0 flex-col gap-4" data-testid="register-registering" data-step="registering">
        <KomettoGuide
          expression={expressionForState("preparing")}
          line={registeringLine(handle === "" ? defaultHandle : handle)}
          lineId={lineId}
          lineTestId="register-line"
        />
        <ol className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted" aria-label="진행 단계">
          {stages.map((label, index) => (
            <li
              key={label}
              aria-current={index === at ? "step" : undefined}
              className={index === at ? "text-ink" : undefined}
              data-state={index < at ? "done" : index === at ? "current" : "todo"}
            >
              {index + 1}. {label}
            </li>
          ))}
        </ol>
        <p className="break-keep text-meta text-ink-muted">{REGISTER_NO_STORE_NOTE}</p>
      </div>
    );
  }

  if (step.step === "done") {
    return (
      <div className="flex min-w-0 flex-col gap-4" data-testid="register-done" data-step="done">
        <KomettoGuide
          expression={expressionForState("success")}
          line={doneLine(step.handle)}
          detail={doneDetail(harness)}
          lineId={lineId}
          lineTestId="register-line"
        />
        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            className="ai-connect-secondary"
            onClick={() => {
              onClose();
              context.onOpenAgents();
            }}
            data-testid="register-agents"
          >
            {DONE_AGENTS_LABEL}
          </Button>
          <Button ref={primaryRef} type="button" onClick={onClose} data-testid="register-close">
            {DONE_CLOSE_LABEL}
          </Button>
        </div>
      </div>
    );
  }

  if (step.step === "existing") {
    return (
      <div className="flex min-w-0 flex-col gap-4" data-testid="register-existing" data-step="existing">
        <KomettoGuide
          expression={expressionForState("success")}
          line={existingLine(step.handle)}
          detail={EXISTING_DETAIL}
          lineId={lineId}
          lineTestId="register-line"
        />
        <div className="flex justify-end pt-1">
          <Button ref={primaryRef} type="button" onClick={onClose} data-testid="register-close">
            {DONE_CLOSE_LABEL}
          </Button>
        </div>
      </div>
    );
  }

  if (step.step === "manual") {
    return (
      <ManualStep
        harness={harness}
        handle={step.handle}
        why={step.why}
        plan={state.plan}
        lineId={lineId}
        primaryRef={primaryRef}
        onClose={onClose}
      />
    );
  }

  if (step.step === "calm" && isCalmRefusal(step.refusal)) {
    const badge =
      step.refusal === "paused" || step.refusal === "disabled" ? CALM_BADGE[step.refusal] : null;
    return (
      <div
        className="flex min-w-0 flex-col gap-4"
        data-testid="register-calm"
        data-step="calm"
        data-refusal={step.refusal}
      >
        <KomettoGuide
          expression={expressionForState("skipped")}
          line={calmLine(step.refusal, harness)}
          detail={calmDetail(step.refusal, harness)}
          lineId={lineId}
          lineTestId="register-line"
        />
        {badge !== null && (
          <p
            className="self-start rounded-full bg-surface-muted px-3 py-1 text-meta text-ink-muted"
            data-testid="register-calm-badge"
          >
            {badge}
          </p>
        )}
        <div className="flex justify-end pt-1">
          <Button ref={primaryRef} type="button" onClick={onClose} data-testid="register-close">
            {CALM_CLOSE_LABEL}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="register-failed" data-step="failed">
      <KomettoGuide
        expression={expressionForState("trouble")}
        line={failedLine(state.reason ?? "")}
        lineId={lineId}
        lineTestId="register-line"
      />
      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        <Button
          type="button"
          variant="outline"
          className="ai-connect-secondary"
          onClick={onClose}
          data-testid="register-close"
        >
          {FAILED_CLOSE_LABEL}
        </Button>
        <Button
          ref={primaryRef}
          type="button"
          onClick={() => void controller?.submit()}
          data-testid="register-retry"
        >
          {FAILED_RETRY_LABEL}
        </Button>
      </div>
    </div>
  );
}

function ManualStep({
  harness,
  handle,
  why,
  plan,
  lineId,
  primaryRef,
  onClose,
}: {
  harness: LocalHarnessId;
  handle: string;
  why: Parameters<typeof manualDetail>[1];
  plan: import("@momo/core/features/onboarding/aiConnect").SubscriptionConnectPlan | null;
  lineId: string;
  primaryRef: RefObject<HTMLButtonElement>;
  onClose: () => void;
}) {
  // Codex의 두 칸은 이 단계의 본문이라 펼쳐서 연다. 앱이 연결하지 못한 폴백은 접어 둔다.
  const [open, setOpen] = useState(why === "codex");
  const bodyId = `${lineId}-manual`;
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="register-manual" data-step="manual" data-why={why}>
      <KomettoGuide
        expression={expressionForState(why === "codex" ? "success" : "trouble")}
        line={manualLine(handle, why)}
        detail={manualDetail(harness, why)}
        lineId={lineId}
        lineTestId="register-line"
      />
      {why !== "codex" && (
        <button
          type="button"
          className="harness-login-disclosure press focus-visible:focus-ring"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          onClick={() => setOpen((value) => !value)}
          data-testid="register-manual-toggle"
        >
          {open ? MANUAL_DISCLOSURE_HIDE_LABEL : MANUAL_DISCLOSURE_LABEL}
        </button>
      )}
      {open && plan !== null && (
        <div id={bodyId} className="min-w-0" data-testid="register-manual-body">
          <SubscriptionConnectBlock harness={harness} plan={plan} onHandedOff={NOOP} />
        </div>
      )}
      <div className="flex justify-end pt-1">
        <Button ref={primaryRef} type="button" onClick={onClose} data-testid="register-close">
          {DONE_CLOSE_LABEL}
        </Button>
      </div>
    </div>
  );
}
