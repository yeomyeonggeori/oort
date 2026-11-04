import type { ReactNode } from "react";
import {
  AudioLines,
  Loader2,
  Mic,
  MicOff,
  PhoneOff,
  RotateCw,
} from "lucide-react";
import { Tooltip } from "@/design/ui/tooltip";
import { channelHeaderControlClass } from "@/features/chat/channelHeaderControl";
import { InlineBanner } from "@/features/common/States";
import type { RealtimeHandle } from "@/lib/realtime";
import {
  huddleControlShown,
  huddleNamesTarget,
  huddleParticipantSummary,
} from "@momo/core/features/huddles/huddleModel";
import type { Huddle } from "@momo/core/lib/api";
import { HuddleMicMenu } from "./HuddleMicMenu";
import { useHuddle, type HuddleController } from "./useHuddle";
import { BlockedReason } from "@/features/common/BlockedReason";

/** 참가자 전원의 이름(쉼표로 이은 전문): 칩의 `title`과 이름 글의 `title`이 같은 글을 읽는다. */
function participantNames(huddle: Huddle): string {
  return huddle.participants
    .map((participant) => participant.displayName)
    .join(", ");
}

/**
 * Live 칩: 점 + 낱말 + (폰 폭) 인원수. 컨트롤 묶음 안에서 **고정 폭**이다 — 참가자 이름 글은 칩 밖, 제목 칸의 꼬리
 * (`HuddleHeaderNames`)로 옮겼다(#5184). 이름 글이 칩 안에 있을 때는 그 글 폭이 컨트롤 묶음의 기본 폭을 부풀려 제목이
 * 먼저 깎였고(1440에서 313/443px), 좁은 판에서는 컨트롤이 3줄로 접혔다. 이제 이름 글은 폭 0에서 시작해 **제목이 다 선 뒤
 * 남는 폭**만 받는다. 전문은 칩의 낭독(`sr-only`)과 `title`에 남는다. 참가 중에는 칩 래퍼가 머리가 좁을 때 양보해 `display: none`이
 * 되므로(그 안의 `sr-only`도 접근성 트리에서 빠진다) 낭독은 칩 밖의 한 곳이 맡고, 칩은 `announce={false}`로 중복 낭독을 끈다.
 */
function HuddleLiveChip({
  huddle,
  announce = true,
}: {
  huddle: Huddle | null;
  announce?: boolean;
}) {
  const names = huddle ? participantNames(huddle) : undefined;
  return (
    <div
      className="flex h-control min-w-0 items-center gap-1 overflow-hidden rounded-sm bg-ok-soft px-2 text-meta"
      data-testid="huddle-live"
      title={names}
    >
      <span className="flex shrink-0 items-center gap-1 font-medium text-ok">
        <span className="size-2 rounded-full bg-ok" aria-hidden="true" />
        Live
      </span>
      {huddle && (
        <>
          {announce && (
            <span className="sr-only">{huddleParticipantSummary(huddle)}</span>
          )}
          <span
            className="shrink-0 text-ink-muted mobile-only"
            data-numeric
            data-testid="huddle-participant-count"
          >
            {huddle.participants.length}
          </span>
        </>
      )}
    </div>
  );
}

/**
 * 참가자 이름 글(「Nadia, 곽성재 외 3명」): 제목 칸 꼬리(`channel-head-tail`)에 서는 장식 글이다. 칩이 같은 전문을 낭독하므로
 * 여기는 `aria-hidden`이고, 칸이 8rem보다 좁으면 조각이 아니라 통째로 숨는다(tokens.css `channel-head-names`).
 */
export function HuddleHeaderNames({
  huddle,
  offline,
}: {
  huddle: HuddleController;
  offline: boolean;
}) {
  const target = huddleNamesTarget(huddle, offline);
  if (target === null) return null;
  return (
    <span
      aria-hidden="true"
      className="channel-head-names text-meta text-ink-muted"
      // 참가 중에는 칩과 함께 머리가 좁으면 양보한다(tokens.css `channel-head-names`의 `[data-joined]`): 칩 없이 이름만 남지 않게.
      data-joined={huddle.joined || undefined}
      data-testid="huddle-participants"
      // 말줄임된 이름 글 위에서도 전문이 뜬다(예전에는 이름이 칩 안에 있어 칩의 `title`이 떴다).
      title={participantNames(target)}
    >
      {huddleParticipantSummary(target)}
    </span>
  );
}

function HuddleIconButton({
  testId,
  label,
  busy,
  onClick,
  children,
}: {
  testId: string;
  label: string;
  busy?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  // 다른 머리 단추와 같은 문법이다(#4591): 같은 클래스 함수(34px 둥근 사각 + 연한 선 + 상태 토큰)와 디자인 시스템
  // 툴팁(아래 방향). 네이티브 `title`은 두지 않는다.
  return (
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-busy={busy || undefined}
        data-testid={testId}
        className={channelHeaderControlClass()}
      >
        {children}
      </button>
    </Tooltip>
  );
}

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

  // 「아무것도 그리지 않는다」의 판단은 모델 한 곳이다(`huddleControlShown`): ChatShell이 ⋮를 이 컨트롤과 묶을지 같은 판단으로 정한다.
  // 오프라인과 허들 없는 서버(unconfigured)는 여기서 걸러진다(아래 가지들은 그 둘을 다시 묻지 않는다).
  if (!huddleControlShown(huddle, offline)) return null;

  // Audio and the REST projection are separate truth planes. Once audio joined,
  // its exit and microphone controls win over every projection state, including
  // a transient 500 or a later 503.
  if (huddle.joined) {
    const microphoneLabel = huddle.muted ? "마이크 켜기" : "마이크 끄기";
    return (
      <div
        className="flex min-w-0 items-center justify-end gap-1"
        data-testid="huddle-surface"
      >
        {/* 390 joined: Live and the picker caret yield so mute/leave stay
            inside the header without covering the member button (#1886 B-1). */}
        <div className="wide-only channel-head-live-joined min-w-0">
          <HuddleLiveChip huddle={huddle.active} announce={false} />
        </div>
        {/* 칩이 양보하거나(머리 안쪽 26rem 밑) 폰 폭에서 안 서도 참가자 전문은 낭독에 남는다: 칩 래퍼 밖의 sr-only 한 곳이 읽는다. */}
        {huddle.active && (
          <span className="sr-only">
            {huddleParticipantSummary(huddle.active)}
          </span>
        )}
        {/* 마이크 묶음은 `overflow-hidden`이 아니다(#4591): 그 상자는 안의 툴팁을 잘라 버린다. 대신 양 끝 단추가 자기
            바깥 모서리를 둥글게 한다(`rounded-s-sm` · `rounded-e-sm`, 묶음의 `rounded-sm` 테두리와 같은 반경). */}
        <div
          className="flex shrink-0 rounded-sm border border-line-strong"
          data-testid="huddle-mic-cluster"
        >
          <Tooltip label={microphoneLabel} side="bottom">
            <button
              type="button"
              onClick={() => void huddle.toggleMicrophone()}
              aria-label={microphoneLabel}
              aria-busy={huddle.busy === "microphone" || undefined}
              data-testid="huddle-microphone"
              className="flex size-control shrink-0 items-center justify-center rounded-s-sm text-ink-muted press hover:bg-surface-hover focus-visible:focus-ring"
            >
              {huddle.busy === "microphone" ? (
                <Loader2 aria-hidden="true" className="size-4 spinner-busy" />
              ) : huddle.muted ? (
                <MicOff aria-hidden="true" className="size-4" />
              ) : (
                <Mic aria-hidden="true" className="size-4" />
              )}
            </button>
          </Tooltip>
          <HuddleMicMenu
            selectedDeviceId={huddle.microphoneDeviceId}
            gainPercent={huddle.microphoneGainPercent}
            busy={huddle.busy === "device"}
            disabled={busy}
            split
            onSelectDevice={(deviceId) =>
              void huddle.setMicrophoneDevice(deviceId)
            }
            onGainChange={huddle.setMicrophoneGain}
          />
        </div>
        <HuddleIconButton
          testId="huddle-leave"
          label="허들 나가기"
          busy={huddle.busy === "leave"}
          onClick={() => void huddle.leave()}
        >
          {huddle.busy === "leave" ? (
            <Loader2 aria-hidden="true" className="size-4 spinner-busy" />
          ) : (
            <PhoneOff aria-hidden="true" className="size-4" />
          )}
        </HuddleIconButton>
        <span className="sr-only" aria-live="polite">
          {busy ? "허들 요청 처리 중" : ""}
        </span>
      </div>
    );
  }

  if (huddle.status === "loading") {
    return (
      <p
        className="flex size-control shrink-0 items-center justify-center text-ink-muted"
        aria-busy="true"
        data-testid="huddle-loading"
      >
        <Loader2 aria-hidden="true" className="spinner-busy size-4" />
        <span className="sr-only">허들 확인 중</span>
      </p>
    );
  }

  // 이 서버에 허들이 없다(unconfigured): 컨트롤도 배너도 없다 (goal B6). 위 `huddleControlShown`이 거른다.
  // 아래 배너 쪽에 같은 판단의 나머지 절반이 적혀 있다.

  if (huddle.status === "error") {
    return (
      <HuddleIconButton
        testId="huddle-error-retry"
        label="다시 불러오기"
        onClick={huddle.retry}
      >
        <RotateCw aria-hidden="true" className="size-4" />
      </HuddleIconButton>
    );
  }

  const startOrJoinLabel = huddle.active ? "허들 참가" : "허들 시작";
  return (
    <div
      className="flex min-w-0 items-center justify-end gap-1"
      data-testid="huddle-surface"
    >
      {huddle.active && <HuddleLiveChip huddle={huddle.active} />}
      <HuddleIconButton
        testId={huddle.active ? "huddle-join" : "huddle-start"}
        label={startOrJoinLabel}
        busy={huddle.busy === "start-or-join"}
        onClick={() => void huddle.startOrJoin()}
      >
        {huddle.busy === "start-or-join" ? (
          <Loader2 aria-hidden="true" className="size-4 spinner-busy" />
        ) : (
          <AudioLines aria-hidden="true" className="size-4" />
        )}
      </HuddleIconButton>
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
        message={<BlockedReason frame="huddleJoined" />}
        testId="huddle-joined-offline"
      />
    );
  }
  if (offline) {
    return (
      <InlineBanner
        tone="neutral"
        message={<BlockedReason frame="huddleUnavailable" />}
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
