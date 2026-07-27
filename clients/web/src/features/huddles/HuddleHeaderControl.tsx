import {
  AudioLines,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
  RotateCw,
} from "lucide-react";
import { Button } from "@/design/ui/button";
import type { MembershipRole } from "@/lib/api";
import type { RealtimeHandle } from "@/lib/realtime";
import { huddleParticipantSummary } from "./huddleModel";
import { useHuddle } from "./useHuddle";

export function HuddleHeaderControl({
  workspaceId,
  channelId,
  realtime,
  offline,
  role,
}: {
  workspaceId: string;
  channelId: string;
  realtime: RealtimeHandle | null;
  offline: boolean;
  role?: MembershipRole;
}) {
  const huddle = useHuddle(workspaceId, channelId, realtime, offline);
  const busy = huddle.busy !== null;

  if (offline && !huddle.joined) {
    return (
      <p
        className="max-w-pane-sm text-right text-meta text-ink-muted"
        role="status"
        data-testid="huddle-offline"
      >
        오프라인에서는 허들을 사용할 수 없습니다.
      </p>
    );
  }

  if (huddle.status === "loading") {
    return (
      <p
        className="flex items-center gap-2 text-meta text-ink-muted"
        aria-busy="true"
        data-testid="huddle-loading"
      >
        <Loader2 aria-hidden="true" className="spinner-busy size-4" />
        허들 확인 중
      </p>
    );
  }

  if (huddle.status === "unconfigured") {
    return (
      <p
        className="max-w-pane-sm text-right text-meta text-ink-muted"
        role="status"
        data-testid="huddle-unconfigured"
      >
        허들 미구성: 이 서버에서는 음성 허들을 사용하지 않습니다.
      </p>
    );
  }

  if (huddle.status === "error") {
    return (
      <div
        className="flex flex-wrap items-center justify-end gap-2"
        data-testid="huddle-error"
      >
        <p className="max-w-pane-sm text-right text-meta text-danger" role="alert">
          허들 상태를 불러오지 못했습니다.
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={huddle.retry}
        >
          <RotateCw aria-hidden="true" />
          다시 불러오기
        </Button>
      </div>
    );
  }

  return (
    <div
      className="flex min-w-0 flex-wrap items-center justify-end gap-2"
      data-testid="huddle-surface"
    >
      {huddle.active ? (
        <div
          className="flex min-w-0 items-center gap-2 rounded-sm bg-surface-hover px-2 py-1 text-meta"
          data-testid="huddle-live"
        >
          <span className="flex shrink-0 items-center gap-1 font-medium text-ok">
            <AudioLines aria-hidden="true" className="size-4" />
            Live
          </span>
          <span
            className="max-w-pane-sm truncate text-ink-muted"
            data-testid="huddle-participants"
            title={huddle.active.participants
              .map((participant) => participant.displayName)
              .join(", ")}
          >
            {huddleParticipantSummary(huddle.active)}
          </span>
        </div>
      ) : role !== "owner" && role !== "admin" && role !== undefined ? (
        <span
          className="text-meta text-ink-muted"
          data-testid="huddle-member-start-note"
        >
          일반 멤버도 시작 가능
        </span>
      ) : null}

      {huddle.joined ? (
        <>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => void huddle.toggleMicrophone()}
            aria-busy={huddle.busy === "microphone" || undefined}
            aria-label={huddle.muted ? "마이크 켜기" : "마이크 끄기"}
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
            onClick={() => void huddle.leave()}
            aria-busy={huddle.busy === "leave" || undefined}
          >
            {huddle.busy === "leave" ? (
              <Loader2 aria-hidden="true" className="spinner-busy" />
            ) : (
              <PhoneOff aria-hidden="true" />
            )}
            허들 나가기
          </Button>
        </>
      ) : (
        <Button
          type="button"
          size="sm"
          variant={huddle.active ? "default" : "secondary"}
          onClick={() => void huddle.startOrJoin()}
          aria-busy={huddle.busy === "start-or-join" || undefined}
          disabled={offline}
          data-testid={huddle.active ? "huddle-join" : "huddle-start"}
        >
          {huddle.busy === "start-or-join" ? (
            <Loader2 aria-hidden="true" className="spinner-busy" />
          ) : (
            <AudioLines aria-hidden="true" />
          )}
          {huddle.active ? "허들 참가" : "허들 시작"}
        </Button>
      )}

      {huddle.notice && (
        <p
          className="max-w-pane text-right text-meta text-danger"
          role="alert"
          data-testid="huddle-notice"
        >
          {huddle.notice}
        </p>
      )}
      {offline && huddle.joined && (
        <p
          className="max-w-pane text-right text-meta text-warn"
          role="status"
          data-testid="huddle-joined-offline"
        >
          메시지 연결이 끊겼습니다. 오디오는 계속될 수 있으며 허들 나가기는 사용할 수 있습니다.
        </p>
      )}
      <span className="sr-only" aria-live="polite">
        {busy ? "허들 요청 처리 중" : ""}
      </span>
    </div>
  );
}
