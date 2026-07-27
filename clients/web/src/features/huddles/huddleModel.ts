import { ApiError, type Huddle, uuidEq } from "@/lib/api";

export type HuddleLoadStatus =
  | "loading"
  | "ready"
  | "unconfigured"
  | "error";

export interface HuddleProjectionState {
  channelId: string;
  requestId: number;
  status: HuddleLoadStatus;
  active: Huddle | null;
  endedHuddleIds: ReadonlySet<string>;
}

export type HuddleProjectionAction =
  | { type: "channel"; channelId: string; requestId: number }
  | { type: "load-started"; requestId: number }
  | { type: "load-succeeded"; requestId: number; huddle: Huddle | null }
  | { type: "load-unconfigured"; requestId: number }
  | { type: "load-failed"; requestId: number }
  | { type: "huddle-ended"; huddleId: string }
  | { type: "huddle-updated"; huddle: Huddle };

export function initialHuddleProjection(
  channelId: string
): HuddleProjectionState {
  return {
    channelId,
    requestId: 0,
    status: "loading",
    active: null,
    endedHuddleIds: new Set(),
  };
}

/**
 * Reconciles REST projections with realtime invalidations.
 *
 * The request id makes the newest fetch win. The ended-id tombstone is the
 * second guard: a delayed active response that started before `huddle_ended`
 * cannot resurrect its Live badge after that event already removed it.
 */
export function reduceHuddleProjection(
  state: HuddleProjectionState,
  action: HuddleProjectionAction
): HuddleProjectionState {
  switch (action.type) {
    case "channel":
      return {
        channelId: action.channelId,
        requestId: action.requestId,
        status: "loading",
        active: null,
        endedHuddleIds: new Set(),
      };
    case "load-started":
      if (action.requestId < state.requestId) return state;
      return {
        ...state,
        requestId: action.requestId,
        status: state.active ? "ready" : "loading",
      };
    case "load-succeeded":
      if (action.requestId !== state.requestId) return state;
      if (
        action.huddle &&
        state.endedHuddleIds.has(action.huddle.id.toLowerCase())
      ) {
        return { ...state, status: "ready", active: null };
      }
      return { ...state, status: "ready", active: action.huddle };
    case "load-unconfigured":
      if (action.requestId !== state.requestId) return state;
      return { ...state, status: "unconfigured", active: null };
    case "load-failed":
      if (action.requestId !== state.requestId) return state;
      return { ...state, status: "error" };
    case "huddle-ended": {
      const endedHuddleIds = new Set(state.endedHuddleIds);
      endedHuddleIds.add(action.huddleId.toLowerCase());
      return {
        ...state,
        status: "ready",
        active:
          state.active && uuidEq(state.active.id, action.huddleId)
            ? null
            : state.active,
        endedHuddleIds,
      };
    }
    case "huddle-updated":
      if (state.endedHuddleIds.has(action.huddle.id.toLowerCase())) return state;
      return { ...state, status: "ready", active: action.huddle };
  }
}

export type HuddleErrorKind =
  | "unconfigured"
  | "membership"
  | "microphone-denied"
  | "microphone-missing"
  | "expired"
  | "connection"
  | "unknown";

export function huddleErrorKind(error: unknown): HuddleErrorKind {
  if (error instanceof ApiError) {
    if (error.status === 503) return "unconfigured";
    if (error.status === 403) return "membership";
  }
  if (
    error instanceof DOMException &&
    (error.name === "NotAllowedError" || error.name === "SecurityError")
  ) {
    return "microphone-denied";
  }
  if (error instanceof DOMException && error.name === "NotFoundError") {
    return "microphone-missing";
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (
      message.includes("permission") ||
      message.includes("notallowed") ||
      message.includes("denied")
    ) {
      return "microphone-denied";
    }
    if (message.includes("microphone") || message.includes("audio input")) {
      return "microphone-missing";
    }
  }
  return "unknown";
}

export function huddleErrorCopy(kind: HuddleErrorKind): string {
  switch (kind) {
    case "unconfigured":
      return "이 서버는 허들을 사용하지 않습니다. 운영자가 LiveKit을 구성하면 사용할 수 있습니다.";
    case "membership":
      return "이 채널에서 허들을 사용할 권한이 없습니다. 채널 멤버십을 확인하세요.";
    case "microphone-denied":
      return "마이크 권한이 거부되어 참가하지 못했습니다. 브라우저 설정에서 마이크를 허용한 뒤 다시 참가하세요.";
    case "microphone-missing":
      return "사용할 수 있는 마이크를 찾지 못했습니다. 오디오 입력 장치를 연결한 뒤 다시 참가하세요.";
    case "expired":
      return "참가 토큰이 만료되어 연결이 끊겼습니다. 허들에 다시 참가하세요.";
    case "connection":
      return "허들 오디오 연결이 끊겼습니다. 네트워크를 확인한 뒤 다시 참가하세요.";
    case "unknown":
      return "허들에 연결하지 못했습니다. 잠시 후 다시 시도하세요.";
  }
}

export function huddleParticipantSummary(huddle: Huddle): string {
  const names = huddle.participants
    .map((participant) => participant.displayName.trim())
    .filter(Boolean);
  if (names.length === 0) return "참가자 기다리는 중";
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} 외 ${names.length - 2}명`;
}
