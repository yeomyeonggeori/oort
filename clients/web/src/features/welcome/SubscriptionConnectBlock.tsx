import { useState } from "react";
import type { LocalHarnessId } from "@momo/core/features/hostedAgents/detect";
import {
  CONNECT_COMMAND_ARIA,
  CONNECT_CREDENTIAL_LABEL,
  CONNECT_ENDPOINT_LABEL,
  CONNECT_HANDED_OFF_STATUS,
  COPIED_LABEL,
  COPY_ACTION_LABEL,
  HARNESS_LABEL,
  OPEN_TERMINAL_LABEL,
  TERMINAL_OPEN_FAILED,
  type SubscriptionConnectPlan,
} from "@momo/core/features/onboarding/aiConnect";
import { cn } from "@/design/lib/cn";
import { useClipboardCopy } from "@/design/hooks/useClipboardCopy";
import { Button } from "@/design/ui/button";
import { openTerminalApp } from "@/lib/tauri";

// Reading this as: onboarding (구독 합류 ① 연결 명령) for internal team users
// on web+Tauri, density 6/10, motion 0/10.

/**
 * 합류 ① 연결 명령 한 줄 [터미널에서 열기]·[복사] (#2814, 시안 D4 캡션).
 *
 * 명령에는 한 번만 보이는 연결 값이 들어 있다. 이 컴포넌트는 그 값을 props로만
 * 받고 저장소·해시·로그 어디에도 쓰지 않는다(OneTimeSecretCard 규율).
 * 「터미널에서 열기」는 명령을 복사하고 OS 터미널을 앞으로 가져온다. 명령을
 * 실행하는 것은 사람이다(셸 `open_terminal_app`은 인자가 없다).
 *
 * Codex는 헤더를 넣는 한 줄 명령이 없어서(`codex mcp add` 0.156) 주소와 연결 값
 * 두 칸을 준다.
 */
export function SubscriptionConnectBlock({
  harness,
  plan,
  onHandedOff,
}: {
  harness: LocalHarnessId;
  plan: SubscriptionConnectPlan;
  /** 복사 또는 터미널 열기 뒤. ① → ② 감지 대기로 넘어간다. */
  onHandedOff: () => void;
}) {
  if (plan.kind === "fields") {
    return (
      <div className="flex min-w-0 flex-col gap-2" data-testid="first-agent-connect-fields">
        <CopyField
          label={CONNECT_ENDPOINT_LABEL}
          value={plan.endpoint}
          subject={`${HARNESS_LABEL[harness]} ${CONNECT_ENDPOINT_LABEL}`}
          testId="first-agent-connect-endpoint"
          onCopied={onHandedOff}
        />
        <CopyField
          label={CONNECT_CREDENTIAL_LABEL}
          value={plan.credential}
          subject={`${HARNESS_LABEL[harness]} ${CONNECT_CREDENTIAL_LABEL}`}
          testId="first-agent-connect-credential"
          onCopied={onHandedOff}
        />
      </div>
    );
  }
  return <CommandLine command={plan.command} onHandedOff={onHandedOff} />;
}

function CommandLine({
  command,
  onHandedOff,
}: {
  command: string;
  onHandedOff: () => void;
}) {
  const { copied, copy } = useClipboardCopy(command);
  const [status, setStatus] = useState<string | null>(null);

  const handleOpen = async () => {
    const didCopy = await copy();
    const opened = await openTerminalApp();
    setStatus(opened && didCopy ? CONNECT_HANDED_OFF_STATUS : TERMINAL_OPEN_FAILED);
    onHandedOff();
  };

  const handleCopy = async () => {
    if (await copy()) onHandedOff();
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        className="ai-connect-command"
        role="group"
        aria-label={CONNECT_COMMAND_ARIA}
        data-testid="first-agent-connect-command"
      >
        <code className="ai-connect-command-text" data-testid="first-agent-connect-command-text">
          <span aria-hidden="true">$ </span>
          {command}
        </code>
        <div className="ai-connect-command-actions">
          {/* 구독 합류는 데스크탑에서만 열린다(구독 줄 게이트). 셸이 없으면
              openTerminalApp 이 false 를 돌려 「직접 여세요」 문장이 선다. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ai-connect-secondary"
            onClick={() => void handleOpen()}
            data-testid="first-agent-connect-open"
          >
            {OPEN_TERMINAL_LABEL}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`${CONNECT_COMMAND_ARIA} ${copied ? COPIED_LABEL : COPY_ACTION_LABEL}`}
            onClick={() => void handleCopy()}
            data-testid="first-agent-connect-copy"
          >
            {copied ? COPIED_LABEL : COPY_ACTION_LABEL}
          </Button>
        </div>
      </div>
      <p
        role="status"
        className={cn("break-keep text-meta text-ink-muted", status === null && "sr-only")}
        data-testid="first-agent-connect-status"
      >
        {status ?? ""}
      </p>
    </div>
  );
}

function CopyField({
  label,
  value,
  subject,
  testId,
  onCopied,
}: {
  label: string;
  value: string;
  subject: string;
  testId: string;
  onCopied: () => void;
}) {
  const { copied, copy } = useClipboardCopy(value);
  return (
    <div className="onboarding-field-block">
      <span className="onboarding-field-label">{label}</span>
      <div className="ai-connect-command" data-testid={testId}>
        <code className="ai-connect-command-text">{value}</code>
        <div className="ai-connect-command-actions">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={`${subject} ${copied ? COPIED_LABEL : COPY_ACTION_LABEL}`}
            onClick={() => {
              void copy().then((ok) => {
                if (ok) onCopied();
              });
            }}
            data-testid={`${testId}-copy`}
          >
            {copied ? COPIED_LABEL : COPY_ACTION_LABEL}
          </Button>
        </div>
      </div>
    </div>
  );
}
