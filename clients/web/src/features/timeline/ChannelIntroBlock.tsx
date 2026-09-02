import { Hash, Lock, SquarePen, UserPlus } from "lucide-react";
import type { RosterMember } from "@momo/core/lib/api";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { Avatar } from "./MessageRow";
import type { ChannelIntroView } from "./channelIntro";

// Leading-row intro grammar from buzz desktop ChannelIntroBlock.tsx
// (Apache-2.0): one component for the empty surface and the virtualized first
// row, so the first message lands below it without a remount. House tokens,
// density, and copy; not a file-level port.

// Reading this as: message timeline (channel intro leading row) for internal
// team users on web+Tauri, density 7/10, motion 2/10.

function IntroIcon({
  intro,
  peer,
}: {
  intro: ChannelIntroView;
  peer: RosterMember | null;
}) {
  if (intro.surface === "dm") {
    return (
      <span aria-hidden="true" data-testid="message-channel-intro-icon">
        <Avatar member={peer} />
      </span>
    );
  }
  const Icon = intro.icon === "lock" ? Lock : Hash;
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
  peer,
  onWrite,
  onAddMember,
}: {
  intro: ChannelIntroView;
  /** Message count is 0: keep the empty-channel test ids the gates already use. */
  empty: boolean;
  peer?: RosterMember | null;
  onWrite?: () => void;
  onAddMember?: () => void;
}) {
  const run = (kind: "write" | "add-member") =>
    kind === "write" ? onWrite?.() : onAddMember?.();
  const actions = empty ? intro.actions : [];

  return (
    <div
      className="flex w-full flex-col items-start gap-3 px-4 py-6"
      data-testid={empty ? "timeline-empty" : "message-channel-intro"}
      data-channel-intro=""
      data-empty-kind={intro.surface}
    >
      <IntroIcon intro={intro} peer={peer ?? null} />
      <h2
        title={intro.title}
        className={cn(
          "max-w-full truncate text-display font-medium",
          intro.isAgent ? "text-agent" : "text-ink"
        )}
      >
        {intro.title}
      </h2>
      <p className="max-w-pane-md break-keep whitespace-pre-wrap text-body text-ink-muted">
        {intro.body}
      </p>
      {actions.length > 0 ? (
        <div className="flex max-w-pane-md flex-wrap items-stretch gap-2">
          {actions.map((action) => {
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
                // 폰 폭(<600)에서 빈 채널의 1급 CTA라 tap-target(44)을 단다.
                // size="sm"의 h-control-sm(28)은 툴바용이고, h-auto/py-2로 유도한
                // 36은 컨트롤 축 밖이다. 높이는 이름 있는 축 h-control(32).
                className="h-control tap-target gap-2"
              >
                <ActionIcon aria-hidden="true" className="size-4" />
                {action.label}
              </Button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
