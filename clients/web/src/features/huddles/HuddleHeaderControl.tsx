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
import { huddleParticipantSummary } from "@momo/core/features/huddles/huddleModel";
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

  // 이 서버에 허들이 없다: 컨트롤도 배너도 없다 (goal B6). 아래 배너 쪽에 같은
  // 판단의 나머지 절반이 적혀 있다.
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
  // 없는 기능은 말하지 않는다 (goal B6, SKILL §5 / capability 게이트).
  //
  // 이 자리에는 "허들 미구성: 이 서버에서는 음성 허들을 사용하지 않습니다."라는
  // 중립 배너가 있었다. 한 번 읽으면 새로울 것이 없는 문장인데 **모든 채널의
  // 헤더 아래에 영구히** 서 있었고, 폰에서는 그 한 줄이 타임라인 높이의 6%를
  // 가져갔다. 그리고 실서버에서는 이 상태가 아니라 `error`로 판정되어 빨간
  // 배너였다 — 없는 기능을 장애라고 말한 것이다(huddleModel.isHuddleUnsupportedStatus).
  //
  // 지원하지 않는 표면은 접는다. 사람이 여기서 할 수 있는 일이 없고, 할 수 있는
  // 일이 생기는 조건(운영자가 LiveKit을 구성)은 이 채널 헤더가 아니라 운영
  // 문서에 있다. 시작/참가를 눌렀는데 서버가 503을 답하는 경우는 여전히 문장을
  // 받는다(huddleErrorCopy("unconfigured")): 그때는 사람이 방금 무언가를 했고,
  // 답이 없으면 눌린 것인지조차 알 수 없다.
  if (huddle.status === "unconfigured") return null;
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
