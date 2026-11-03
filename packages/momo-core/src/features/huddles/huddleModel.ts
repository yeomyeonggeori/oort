import { ApiError, type Huddle, uuidEq } from "../../lib/api";

export type HuddleLoadStatus =
  | "loading"
  | "ready"
  /**
   * 이 서버에는 허들이 **없다**. 운영자가 LiveKit을 끄고 올린 인스턴스(503)와
   * 허들 라우트 자체가 없는 세대의 서버(404/405/501)가 같은 상태다: 어느 쪽이든
   * 사람이 여기서 할 수 있는 일이 없으므로 표면을 접는다.
   */
  | "unconfigured"
  | "error";

/**
 * 지원 여부를 답으로 읽는 상태 코드 (goal B6).
 *
 * 이 집합은 이 파일이 발명한 것이 아니라 클라이언트의 기존 capability 판정과
 * 같은 규칙이다(features/routing/capability.ts: "404/405/501만 없다로 읽고, 그
 * 밖은 확인하지 못했다로 남긴다"). 여기에 503이 하나 더 붙는데, 서버가 허들을
 * 끄고 올라왔다는 뜻으로 이미 쓰고 있던 코드이기 때문이다.
 *
 * 왜 문제가 되었는가: 실서버는 허들 라우트를 아직 싣지 않아 `GET
 * …/huddles/active`에 404를 답한다. 404는 여기서 걸러지지 않아 `error`가 됐고,
 * 그래서 **모든 채널 헤더 아래에 빨간 배너**가 한 줄 서 있었다(성재 iPhone
 * 실캡처). 없는 기능을 장애라고 말한 것이라, 고칠 것은 배너의 문구가 아니라
 * 판정이다.
 *
 * 404가 "이 채널이 없다"일 가능성은 남는다. 그때는 채널 표면 자체가 이미 서지
 * 못하고, 그 사실은 타임라인이 말한다. 없는 채널의 허들 컨트롤을 조용히 접는
 * 것은 그 화면에서도 옳은 답이다.
 */
export function isHuddleUnsupportedStatus(status: number): boolean {
  return status === 404 || status === 405 || status === 501 || status === 503;
}

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
  | "csp-blocked"
  | "microphone-denied"
  | "microphone-missing"
  | "expired"
  | "connection"
  | "unknown";

export function huddleErrorKind(
  error: unknown,
  phase: "unknown" | "microphone" = "unknown"
): HuddleErrorKind {
  if (error instanceof ApiError) {
    if (isHuddleUnsupportedStatus(error.status)) return "unconfigured";
    if (error.status === 403) return "membership";
  }
  if (error instanceof Error && error.name === "HuddleCspBlockedError") {
    return "csp-blocked";
  }
  if (error instanceof Error && error.name === "HuddleMicrophoneError") {
    return "microphone-denied";
  }
  if (
    error instanceof DOMException &&
    (error.name === "NotAllowedError" ||
      (phase === "microphone" && error.name === "SecurityError"))
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
    case "csp-blocked":
      return "이 배포의 보안 정책이 LiveKit 주소를 허용하지 않습니다. 운영자 확인이 필요합니다.";
    case "microphone-denied":
      return "마이크 권한이 거부되어 참가하지 못했습니다. 브라우저 설정에서 마이크를 허용한 뒤 다시 참가하세요.";
    case "microphone-missing":
      return "사용할 수 있는 마이크를 찾지 못했습니다. 오디오 입력 장치를 연결한 뒤 다시 참가하세요.";
    case "expired":
      return "참가 준비 시간이 지나 연결하지 못했습니다. 허들에 다시 참가하세요.";
    case "connection":
      return "허들 오디오 연결이 끊겼습니다. 네트워크를 확인한 뒤 다시 참가하세요.";
    case "unknown":
      return "허들에 연결하지 못했습니다. 잠시 뒤에 다시 시도하세요.";
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

/**
 * 채널 머리의 허들 표면이 읽는 사실 셋 (#5206 · #5184). 웹 `useHuddle`의 컨트롤러가 이 모양을 그대로 만족한다.
 */
export interface HuddleHeaderFacts {
  /** 오디오가 붙었다. REST 투영과 별개의 진실 면이라, 붙은 뒤에는 나가기·마이크가 투영의 어떤 상태보다 앞선다. */
  joined: boolean;
  status: HuddleLoadStatus;
  /** 서 있는 허들. 없으면 `null`. */
  active: Huddle | null;
}

/**
 * 머리의 허들 컨트롤이 무언가를 그리는가. 「그리는가」의 판단은 이 한 곳이다: 컨트롤은 거짓이면 아무것도 그리지 않고, 머리는 ⋮를
 * 허들 컨트롤과 줄바꿈 한 덩어리로 묶을지(허들이 선 때) 멤버 수와 묶을지(안 선 때)를 같은 판단으로 정한다. 둘이 갈라지면 ⋮가
 * 없는 컨트롤과 묶이거나 혼자 한 줄에 선다.
 *
 * - 오디오가 붙었으면(`joined`) 늘 그린다(나가기·마이크는 오프라인에서도 쓸 수 있다).
 * - 오프라인이면 아무것도 없다.
 * - 이 서버에 허들이 없으면(`unconfigured`) 컨트롤도 배너도 없다(goal B6, 없는 기능은 말하지 않는다).
 * - 나머지(불러오는 중의 회전 표지, 오류의 다시 불러오기, 시작·참가 단추)는 모두 그린다.
 */
export function huddleControlShown(
  facts: Pick<HuddleHeaderFacts, "joined" | "status">,
  offline: boolean
): boolean {
  if (facts.joined) return true;
  if (offline) return false;
  return facts.status !== "unconfigured";
}

/**
 * 머리에 허들 참가자 이름 글이 설 허들. 이름 글은 Live 칩을 세우는 판단과 같은 사실 위에 서야 한다(칩 없는 이름·이름 없는 칩
 * 금지): 오디오가 붙었으면 서 있는 허들이고, 아니면 온라인이고 투영이 준비된(`ready`) 때의 서 있는 허들이다. 없으면 `null`.
 */
export function huddleNamesTarget(
  facts: HuddleHeaderFacts,
  offline: boolean
): Huddle | null {
  if (facts.joined) return facts.active;
  return !offline && facts.status === "ready" ? facts.active : null;
}
