import { useLayoutEffect, useRef, type AnimationEvent } from "react";
import { Link } from "react-router-dom";
import { OortCloudMark } from "@/features/auth/OortCloudMarks";
import { cn } from "@/design/lib/cn";
import {
  PRESS_CLASS,
  WELCOME_KICKOFF_EXIT_ANIMATION_NAME,
  WELCOME_KICKOFF_EXIT_CLASS,
  WELCOME_KICKOFF_MARK_CLASS,
} from "@/design/motion";
import {
  WELCOME_BACKSTOP_COPY,
  WELCOME_BACKSTOP_HREF,
  WELCOME_BACKSTOP_LINK_LABEL,
  WELCOME_KICKOFF_SHAPES,
  WELCOME_STAGE_COPY,
  type WelcomeKickoffPhase,
} from "./welcomeKickoff";

// Reading this as: message timeline (welcome kickoff leading row) for internal
// team users on web+Tauri, density 7/10, motion 2/10.

/**
 * Leading row of the same family as ChannelIntroBlock: not a modal, not a
 * scrim. Capture waits on `data-testid="welcome-kickoff-stage"`; the channel
 * surface mounts this as a virtuoso item.
 *
 * `data-stagger-index` is the product hook that sets `--stagger-index` in CSS.
 * Reduced-motion omits the attribute so the shapes are a static silhouette.
 */
export function WelcomeKickoffStage({
  phase,
  reducedMotion,
  onExitComplete,
}: {
  phase: Exclude<WelcomeKickoffPhase, "hidden">;
  reducedMotion: boolean;
  onExitComplete: () => void;
}) {
  const visualRef = useRef<"stage" | "backstop">("stage");
  if (phase === "stage") visualRef.current = "stage";
  if (phase === "backstop") visualRef.current = "backstop";
  const exiting = phase === "exiting";
  const showCard = visualRef.current === "backstop";

  useLayoutEffect(() => {
    if (!exiting || !reducedMotion) return;
    onExitComplete();
  }, [exiting, reducedMotion, onExitComplete]);

  const handleAnimationEnd = (event: AnimationEvent<HTMLDivElement>) => {
    if (!exiting || reducedMotion) return;
    if (event.animationName !== WELCOME_KICKOFF_EXIT_ANIMATION_NAME) return;
    onExitComplete();
  };

  return (
    <div
      className={cn(
        "flex w-full flex-col items-start gap-3 px-4 py-6",
        exiting && !reducedMotion && WELCOME_KICKOFF_EXIT_CLASS
      )}
      data-testid={showCard ? "welcome-kickoff-backstop" : "welcome-kickoff-stage"}
      onAnimationEnd={handleAnimationEnd}
    >
      {showCard ? (
        <>
          <p className="max-w-pane-md break-keep text-body text-ink">
            {WELCOME_BACKSTOP_COPY}
          </p>
          <Link
            to={WELCOME_BACKSTOP_HREF}
            className={cn(
              PRESS_CLASS,
              "text-body text-ink underline underline-offset-2 focus-visible:focus-ring"
            )}
          >
            {WELCOME_BACKSTOP_LINK_LABEL}
          </Link>
        </>
      ) : (
        <>
          <div className="flex items-center gap-3" aria-hidden="true">
            {WELCOME_KICKOFF_SHAPES.map((kind, index) => (
              <span
                key={`${kind}-${index}`}
                className={cn(
                  "flex size-8 items-center justify-center text-ink-muted",
                  !reducedMotion && WELCOME_KICKOFF_MARK_CLASS
                )}
                {...(reducedMotion
                  ? {}
                  : { "data-stagger-index": String(index) })}
              >
                <OortCloudMark kind={kind} />
              </span>
            ))}
          </div>
          <p className="text-body text-ink">{WELCOME_STAGE_COPY}</p>
        </>
      )}
    </div>
  );
}
