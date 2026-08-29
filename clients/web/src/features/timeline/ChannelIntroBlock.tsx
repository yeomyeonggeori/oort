import { Hash, Lock, MessageSquare, SquarePen, UserPlus } from "lucide-react";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import type { ChannelIntroView } from "./channelIntro";

// Leading-row intro grammar from buzz desktop ChannelIntroBlock.tsx
// (Apache-2.0): one component for the empty surface and the virtualized first
// row, so the first message lands below it without a remount or a height
// change. House tokens, density, and copy; not a file-level port.

// Reading this as: message timeline (channel intro leading row) for internal
// team users on web+Tauri, density 7/10, motion 2/10.

function IntroIcon({
  icon,
}: {
  icon: ChannelIntroView["icon"];
}) {
  const Icon =
    icon === "lock" ? Lock : icon === "dm" ? MessageSquare : Hash;
  return (
    <span
      aria-hidden="true"
      data-testid="message-channel-intro-icon"
      className="flex size-8 items-center justify-center rounded-md border border-line bg-surface-raised text-ink-muted"
    >
      <Icon className="size-4" />
    </span>
  );
}

export function ChannelIntroBlock({
  intro,
  empty,
  onWrite,
  onAddMember,
}: {
  intro: ChannelIntroView;
  /** Message count is 0: keep the empty-channel test ids the gates already use. */
  empty: boolean;
  onWrite?: () => void;
  onAddMember?: () => void;
}) {
  const run = (kind: "write" | "add-member") =>
    kind === "write" ? onWrite?.() : onAddMember?.();

  return (
    <section
      className="flex w-full flex-col items-start gap-3 px-4 py-6"
      data-testid={empty ? "timeline-empty" : "message-channel-intro"}
      data-channel-intro=""
      data-empty-kind={intro.surface}
      aria-labelledby="channel-intro-title"
    >
      <IntroIcon icon={intro.icon} />
      <h2
        id="channel-intro-title"
        className="max-w-full truncate text-display font-medium text-ink"
      >
        {intro.title}
      </h2>
      <p className="max-w-pane-md break-keep whitespace-pre-wrap text-body text-ink-muted">
        {intro.body}
      </p>
      {intro.meta ? (
        <p className="text-meta text-ink-muted" data-testid="channel-intro-meta">
          {intro.meta}
        </p>
      ) : null}
      {intro.actions.length > 0 ? (
        <div className="flex max-w-pane-md flex-wrap items-stretch gap-2">
          {intro.actions.map((action) => {
            const ActionIcon = action.kind === "write" ? SquarePen : UserPlus;
            const isWrite = action.kind === "write";
            return (
              <Button
                key={action.kind}
                type="button"
                size="sm"
                variant={isWrite ? "default" : "outline"}
                onClick={() => run(action.kind)}
                data-testid={
                  isWrite ? "timeline-empty-primary" : "timeline-empty-secondary"
                }
                data-action-kind={action.kind}
                aria-label={action.label}
                className={cn("h-auto gap-2 py-2")}
              >
                <ActionIcon aria-hidden="true" className="size-4" />
                {action.label}
              </Button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
