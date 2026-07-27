import type { ReactNode } from "react";
import {
  AudioLines,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
  RotateCw,
} from "lucide-react";
import { Button } from "@/design/ui/button";
import { InlineBanner } from "@/features/common/States";
import type { RealtimeHandle } from "@/lib/realtime";
import { huddleParticipantSummary } from "./huddleModel";
import { useHuddle, type HuddleController } from "./useHuddle";

export function HuddleHeaderState({
  workspaceId,
  channelId,
  realtime,
  offline,
  children,
}: {
  workspaceId: string;
  channelId: string;
  realtime: RealtimeHandle | null;
  offline: boolean;
  children: (huddle: HuddleController) => ReactNode;
}) {
  const huddle = useHuddle(workspaceId, channelId, realtime, offline);
  return children(huddle);
}

export function HuddleHeaderControl({
  huddle,
  offline,
}: {
  huddle: HuddleController;
  offline: boolean;
}) {
  const busy = huddle.busy !== null;

  // Audio and the REST projection are separate truth planes. Once audio joined,
  // its exit and microphone controls win over every projection state, including
  // a transient 500 or a later 503.
  if (huddle.joined) {
    return (
      <div
        className="flex min-w-0 max-w-pane items-center justify-end gap-2"
        data-testid="huddle-surface"
      >
        <div
          className="flex min-w-0 flex-1 items-center gap-2 rounded-sm bg-surface-hover px-2 py-1 text-meta"
          data-testid="huddle-live"
        >
          <span className="flex shrink-0 items-center gap-1 font-medium text-ok">
            <AudioLines aria-hidden="true" className="size-4" />
            Live
          </span>
          {huddle.active && (
            <span
              className="min-w-0 truncate text-ink-muted"
              data-testid="huddle-participants"
              title={huddle.active.participants
                .map((participant) => participant.displayName)
                .join(", ")}
            >
              {huddleParticipantSummary(huddle.active)}
            </span>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="shrink-0"
          onClick={() => void huddle.toggleMicrophone()}
          aria-busy={huddle.busy === "microphone" || undefined}
          aria-label={huddle.muted ? "마이크 켜기" : "마이크 끄기"}
          data-testid="huddle-microphone"
        >
          {huddle.busy === "microphone" ? (
            <Loader2 aria-hidden="true" className="spinner-busy" />
          ) : huddle.muted ? (
            <MicOff aria-hidden="true" />
          ) : (
            <Mic aria-hidden="true" />
          )}
          {huddle.muted ? "마이크 켜기" : "마이크 끄기"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => void huddle.leave()}
          aria-busy={huddle.busy === "leave" || undefined}
          data-testid="huddle-leave"
        >
          {huddle.busy === "leave" ? (
            <Loader2 aria-hidden="true" className="spinner-busy" />
          ) : (
            <PhoneOff aria-hidden="true" />
          )}
          허들 나가기
        </Button>
        <span className="sr-only" aria-live="polite">
          {busy ? "허들 요청 처리 중" : ""}
        </span>
      </div>
    );
  }

  if (offline) return null;

  if (huddle.status === "loading") {
    return (
      <p
        className="flex shrink-0 items-center gap-2 text-meta text-ink-muted"
        aria-busy="true"
        data-testid="huddle-loading"
      >
        <Loader2 aria-hidden="true" className="spinner-busy size-4" />
        허들 확인 중
      </p>
    );
  }

  if (huddle.status === "unconfigured") return null;

  if (huddle.status === "error") {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={huddle.retry}
        data-testid="huddle-error-retry"
      >
        <RotateCw aria-hidden="true" />
        다시 불러오기
      </Button>
    );
  }

  return (
    <div
      className="flex min-w-0 max-w-pane items-center justify-end gap-2"
      data-testid="huddle-surface"
    >
      {huddle.active && (
        <div
          className="flex min-w-0 flex-1 items-center gap-2 rounded-sm bg-surface-hover px-2 py-1 text-meta"
          data-testid="huddle-live"
        >
          <span className="flex shrink-0 items-center gap-1 font-medium text-ok">
            <AudioLines aria-hidden="true" className="size-4" />
            Live
          </span>
          <span
            className="min-w-0 truncate text-ink-muted"
            data-testid="huddle-participants"
            title={huddle.active.participants
              .map((participant) => participant.displayName)
              .join(", ")}
          >
            {huddleParticipantSummary(huddle.active)}
          </span>
        </div>
      )}
      <Button
        type="button"
        size="sm"
        className="shrink-0"
        variant={huddle.active ? "default" : "secondary"}
        onClick={() => void huddle.startOrJoin()}
        aria-busy={huddle.busy === "start-or-join" || undefined}
        data-testid={huddle.active ? "huddle-join" : "huddle-start"}
      >
        {huddle.busy === "start-or-join" ? (
          <Loader2 aria-hidden="true" className="spinner-busy" />
        ) : (
          <AudioLines aria-hidden="true" />
        )}
        {huddle.active ? "허들 참가" : "허들 시작"}
      </Button>
      <span className="sr-only" aria-live="polite">
        {busy ? "허들 요청 처리 중" : ""}
      </span>
    </div>
  );
}

export function HuddleHeaderBanner({
  huddle,
  offline,
}: {
  huddle: HuddleController;
  offline: boolean;
}) {
  if (huddle.notice) {
    return (
      <InlineBanner
        message={huddle.notice}
        testId="huddle-notice"
      />
    );
  }
  if (offline && huddle.joined) {
    return (
      <InlineBanner
        tone="neutral"
        message="메시지 연결이 끊겼습니다. 오디오는 계속될 수 있으며 허들 나가기는 사용할 수 있습니다."
        testId="huddle-joined-offline"
      />
    );
  }
  if (offline) {
    return (
      <InlineBanner
        tone="neutral"
        message="오프라인에서는 허들을 사용할 수 없습니다."
        testId="huddle-offline"
      />
    );
  }
  if (huddle.status === "unconfigured") {
    return (
      <InlineBanner
        tone="neutral"
        message="허들 미구성: 이 서버에서는 음성 허들을 사용하지 않습니다."
        testId="huddle-unconfigured"
      />
    );
  }
  if (huddle.status === "error") {
    return (
      <InlineBanner
        message="허들 상태를 불러오지 못했습니다."
        testId="huddle-error"
      />
    );
  }
  return null;
}
