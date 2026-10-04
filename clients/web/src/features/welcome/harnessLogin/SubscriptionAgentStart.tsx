import { useState } from "react";
import type { LocalHarnessId } from "@momo/core/features/hostedAgents/detect";
import {
  HARNESS_INSTALL_URL,
  HARNESS_LABEL,
  HARNESS_PILL_LABEL,
  SUBSCRIPTION_ROW_IDS,
} from "@momo/core/features/onboarding/aiConnect";
import { loginActionLabel } from "@momo/core/features/onboarding/harnessLogin";
import {
  START_CLOSE_LABEL,
  START_CREATE_LABEL,
  START_DETAIL,
  START_INSTALL_LABEL,
  START_TITLE,
} from "@momo/core/features/onboarding/subscriptionRegister";
import { Button } from "@/design/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/design/ui/dialog";
import { openExternalUrl } from "@/lib/tauri";
import { useLocalHarnessWatch } from "../useLocalHarnessWatch";
import { HarnessLoginDialog } from "./HarnessLoginDialog";
import { useRegisterContext } from "./useRegisterContext";

// Reading this as: agent hub / settings entry (내 구독으로 에이전트 만들기) for internal
// team users on Tauri desktop, density 5/10, motion 1/10.

/**
 * 「내 구독으로 에이전트 만들기」의 첫 창(#3389). 이 맥의 Claude Code·Codex를 줄로 보여
 * 주고, 줄의 행동이 곧 로그인 → 에이전트로 만들기 모달이다. 예전처럼 온보딩 화면을
 * 다시 열지 않는다.
 */
export function SubscriptionAgentStart({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const register = useRegisterContext();
  const harness = useLocalHarnessWatch({ enabled: open, fixture: null });
  const [flow, setFlow] = useState<{ harness: LocalHarnessId; startAt: "login" | "register" } | null>(
    null
  );
  const close = () => {
    setFlow(null);
    onClose();
  };
  return (
    <>
      <Dialog
        open={open && flow === null}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        <DialogContent className="gap-4 p-6" data-testid="subscription-start-dialog">
          <DialogTitle className="text-title font-bold">{START_TITLE}</DialogTitle>
          <DialogDescription className="break-keep text-body text-ink-muted">
            {START_DETAIL}
          </DialogDescription>
          <ul className="flex min-w-0 flex-col" aria-label="이 맥의 구독 CLI">
            {SUBSCRIPTION_ROW_IDS.map((id) => {
              const pill = harness.pill(id);
              return (
                <li
                  key={id}
                  className="flex min-w-0 items-center justify-between gap-3 border-b border-line py-3 last:border-b-0"
                  data-testid={`subscription-start-${id}`}
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="text-body font-semibold text-ink">{HARNESS_LABEL[id]}</span>
                    <span className="text-meta text-ink-muted">{HARNESS_PILL_LABEL[pill]}</span>
                  </div>
                  {pill === "install" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void openExternalUrl(HARNESS_INSTALL_URL[id])}
                      aria-label={`${HARNESS_LABEL[id]} ${START_INSTALL_LABEL}`}
                    >
                      {START_INSTALL_LABEL}
                    </Button>
                  ) : pill === "ready" ? (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => setFlow({ harness: id, startAt: "register" })}
                      data-testid={`subscription-start-${id}-create`}
                    >
                      {START_CREATE_LABEL}
                    </Button>
                  ) : pill === "login" || pill === "recheck" ? (
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => setFlow({ harness: id, startAt: "login" })}
                      data-testid={`subscription-start-${id}-login`}
                    >
                      {loginActionLabel(id)}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <div className="flex justify-end">
            <Button type="button" variant="outline" className="ai-connect-secondary" onClick={close}>
              {START_CLOSE_LABEL}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <HarnessLoginDialog
        harness={open ? (flow?.harness ?? null) : null}
        register={register}
        startAt={flow?.startAt ?? "login"}
        onClose={close}
        onConnected={(id) => harness.recheck(id)}
        onFallbackStarted={(id) => harness.startLoginWatch(id)}
      />
    </>
  );
}
