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
  CALM_BADGE_KEYS,
  CALM_CLOSE_KEY,
  CONFIRM_LATER_KEY,
  CONFIRM_NAME_HINT_KEY,
  CONFIRM_NAME_LABEL_KEY,
  DONE_AGENTS_KEY,
  DONE_CLOSE_KEY,
  EXISTING_DETAIL_KEY,
  FAILED_CLOSE_KEY,
  FAILED_RETRY_KEY,
  MANUAL_DISCLOSURE_HIDE_KEY,
  MANUAL_DISCLOSURE_KEY,
  REGISTERING_SERVER_STAGE_KEY,
  REGISTER_NO_STORE_KEY,
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
  type RegisterMessage,
} from "@momo/core/features/onboarding/subscriptionRegister";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { Check } from "lucide-react";
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
  onGuard,
}: {
  /** 지금 Esc·바깥 누름으로 닫으면 한 번만 보이는 값이나 진행 중 작업을 잃는가. */
  onGuard?: (guarded: boolean) => void;
  harness: LocalHarnessId;
  context: RegisterContext;
  onClose: () => void;
  fixture?: RegisterFixture | null;
  /** 로그인을 막 마친 흐름이면 첫 줄에 「로그인됐어요」를 붙인다. */
  showLoggedIn?: boolean;
}) {
  const formatMessage = useFormatMessage();
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
  const guarded = step.step === "registering" || (step.step === "manual" && state.plan !== null);
  useEffect(() => {
    onGuard?.(guarded);
    return () => onGuard?.(false);
  }, [guarded, onGuard]);

  if (step.step === "confirm") {
    const titleMsg = confirmTitle(harness, handle === "" ? defaultHandle : handle);
    const loggedIn = loggedInLine(harness);
    const createMsg = confirmCreateLabel(handle === "" ? defaultHandle : handle);
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
          line={formatMessage(titleMsg.key, titleMsg.values as never)}
          detail={showLoggedIn ? formatMessage(loggedIn.key, loggedIn.values as never) : undefined}
          lineId={lineId}
          lineTestId="register-line"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor={`${lineId}-name`} className="text-meta text-ink-muted">
            {formatMessage(CONFIRM_NAME_LABEL_KEY)}
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
            {formatMessage(step.problem ?? CONFIRM_NAME_HINT_KEY)}
          </p>
        </div>
        <ul className="flex min-w-0 list-disc flex-col gap-1 pl-4 text-meta text-ink-muted">
          {confirmBullets(harness).map((bullet) => (
            <li key={bullet.key} className="break-keep">
              {formatMessage(bullet.key, bullet.values as never)}
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
            {formatMessage(CONFIRM_LATER_KEY)}
          </Button>
          <Button
            ref={primaryRef}
            type="submit"
            disabled={handle === ""}
            data-testid="register-create"
          >
            {formatMessage(createMsg.key, createMsg.values as never)}
          </Button>
        </div>
      </form>
    );
  }

  if (step.step === "registering") {
    const serverStage: RegisterMessage = { key: REGISTERING_SERVER_STAGE_KEY };
    const stages: RegisterMessage[] =
      harness === "claude" ? [serverStage, registeringCliStage(harness)] : [serverStage];
    const at = step.stage === "server" ? 0 : 1;
    const registering = registeringLine(handle === "" ? defaultHandle : handle);
    return (
      <div className="flex min-w-0 flex-col gap-4" data-testid="register-registering" data-step="registering">
        <KomettoGuide
          expression={expressionForState("preparing")}
          line={formatMessage(registering.key, registering.values as never)}
          lineId={lineId}
          lineTestId="register-line"
        />
        <ol className="flex min-w-0 flex-col gap-1 text-meta text-ink-muted" aria-label="진행 단계">
          {stages.map((label, index) => (
            <li
              key={label.key}
              aria-current={index === at ? "step" : undefined}
              className={index === at ? "font-semibold text-ink" : undefined}
              data-state={index < at ? "done" : index === at ? "current" : "todo"}
            >
              {index < at ? (
                <Check aria-hidden="true" className="mr-1 inline size-3" />
              ) : (
                `${index + 1}. `
              )}
              {formatMessage(label.key, label.values as never)}
            </li>
          ))}
        </ol>
        <p className="break-keep text-meta text-ink-muted">{formatMessage(REGISTER_NO_STORE_KEY)}</p>
      </div>
    );
  }

  if (step.step === "done") {
    const doneMsg = doneLine(step.handle);
    const doneDetailMsg = doneDetail(harness, step.handle);
    return (
      <div className="flex min-w-0 flex-col gap-4" data-testid="register-done" data-step="done">
        <KomettoGuide
          expression={expressionForState("success")}
          line={formatMessage(doneMsg.key, doneMsg.values as never)}
          detail={formatMessage(doneDetailMsg.key, doneDetailMsg.values as never)}
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
            {formatMessage(DONE_AGENTS_KEY)}
          </Button>
          <Button ref={primaryRef} type="button" onClick={onClose} data-testid="register-close">
            {formatMessage(DONE_CLOSE_KEY)}
          </Button>
        </div>
      </div>
    );
  }

  if (step.step === "existing") {
    const existingMsg = existingLine(step.handle);
    return (
      <div className="flex min-w-0 flex-col gap-4" data-testid="register-existing" data-step="existing">
        <KomettoGuide
          expression={expressionForState("success")}
          line={formatMessage(existingMsg.key, existingMsg.values as never)}
          detail={formatMessage(EXISTING_DETAIL_KEY)}
          lineId={lineId}
          lineTestId="register-line"
        />
        <div className="flex justify-end pt-1">
          <Button ref={primaryRef} type="button" onClick={onClose} data-testid="register-close">
            {formatMessage(DONE_CLOSE_KEY)}
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
    const badgeKey =
      step.refusal === "paused" || step.refusal === "disabled" ? CALM_BADGE_KEYS[step.refusal] : null;
    const calmLineMsg = calmLine(step.refusal, harness);
    const calmDetailMsg = calmDetail(step.refusal, harness);
    return (
      <div
        className="flex min-w-0 flex-col gap-4"
        data-testid="register-calm"
        data-step="calm"
        data-refusal={step.refusal}
      >
        <KomettoGuide
          expression={expressionForState("skipped")}
          line={formatMessage(calmLineMsg.key, calmLineMsg.values as never)}
          detail={formatMessage(calmDetailMsg.key, calmDetailMsg.values as never)}
          lineId={lineId}
          lineTestId="register-line"
        />
        {badgeKey !== null && (
          <p
            className="self-start rounded-full bg-surface-muted px-3 py-1 text-meta text-ink-muted"
            data-testid="register-calm-badge"
          >
            {formatMessage(badgeKey)}
          </p>
        )}
        <div className="flex justify-end pt-1">
          <Button ref={primaryRef} type="button" onClick={onClose} data-testid="register-close">
            {formatMessage(CALM_CLOSE_KEY)}
          </Button>
        </div>
      </div>
    );
  }

  const failedMsg = failedLine(state.reason === null ? "" : formatMessage(state.reason));
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="register-failed" data-step="failed">
      <KomettoGuide
        expression={expressionForState("trouble")}
        line={formatMessage(failedMsg.key, failedMsg.values as never)}
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
          {formatMessage(FAILED_CLOSE_KEY)}
        </Button>
        <Button
          ref={primaryRef}
          type="button"
          onClick={() => void controller?.submit()}
          data-testid="register-retry"
        >
          {formatMessage(FAILED_RETRY_KEY)}
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
  const formatMessage = useFormatMessage();
  const lineMsg = manualLine(handle, why);
  const detailMsg = manualDetail(harness, why);
  // Codex의 두 칸은 이 단계의 본문이라 펼쳐서 연다. 앱이 연결하지 못한 폴백은 접어 둔다.
  const [open, setOpen] = useState(why === "codex");
  const bodyId = `${lineId}-manual`;
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="register-manual" data-step="manual" data-why={why}>
      <KomettoGuide
        expression={expressionForState(why === "codex" ? "success" : "trouble")}
        line={formatMessage(lineMsg.key, lineMsg.values as never)}
        detail={formatMessage(detailMsg.key, detailMsg.values as never)}
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
          {formatMessage(open ? MANUAL_DISCLOSURE_HIDE_KEY : MANUAL_DISCLOSURE_KEY)}
        </button>
      )}
      {open && plan !== null && (
        <div id={bodyId} className="min-w-0" data-testid="register-manual-body">
          <SubscriptionConnectBlock harness={harness} plan={plan} onHandedOff={NOOP} />
        </div>
      )}
      <div className="flex justify-end pt-1">
        <Button ref={primaryRef} type="button" onClick={onClose} data-testid="register-close">
          {formatMessage(DONE_CLOSE_KEY)}
        </Button>
      </div>
    </div>
  );
}
