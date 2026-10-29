// =============================================================================
// `message.pin` / `message.unpin` 승인 카드의 대상 메시지 미리보기 (ADR-0186 증보 v5 U-e, #4705)
//
// 에이전트가 「이 메시지를 고정해 줘」「고정을 풀어 줘」라고 제안한다. 카드의 행(채널 · 쓴 사람 ·
// 쓴 시각 · 앞 120자 · 글자 수 · 지금 고정된 수)은 서버가 메시지를 읽어 만든 값이고 위 카드가
// 그대로 그린다(`action.rows`). 이 파일이 읽는 것은 그 옆에 실리는 **구조화된 한 칸**이다:
//
//   props.action.preview = { kind: "message", messageId, channelId, totalChars, truncated }
//
// 사람이 승인하기 전에 **전문을 읽을 수 있게** 그 메시지가 있는 곳으로 가는 문 하나를 세우려는
// 것이다. 앞 120자만 보고 누르면 승인자는 자기가 읽지 않은 글을 고정한다(보안 검수 M4).
// 그래서 카드는 글자 수와 문 하나를 항상 보이고, 잘린 메시지(`truncated`)일 때는 서버 행이 이미
// 「앱에서 이 메시지를 열어 전문을 읽은 뒤 승인해요」라고 말한다.
//
// ## 이 파일이 하는 일은 읽기뿐이다
//
// 총 파싱: 던지지 않고, 모르는 `kind`·어긋난 모양은 전부 `null` 이다. 그때 카드는 서버 행만
// 그린다(문이 없을 뿐 판단 근거는 그대로다). id 는 서버가 소문자 uuid 로 싣는다. 클라이언트는
// 그것으로 주소를 만들 뿐 이름·본문을 추측하지 않는다.
// =============================================================================

/** `action.preview.kind`. 아바타 미리보기(`avatar_image`)와 갈리는 열쇠다. */
export const MESSAGE_PREVIEW_KIND = "message";

/** 레지스트리 행동 id 둘. 둘 다 같은 미리보기를 싣는다. */
export const MESSAGE_PIN_ACTION_IDS: readonly string[] = [
  "message.pin",
  "message.unpin",
];

export function isMessagePinAction(actionId: string | null | undefined): boolean {
  return actionId !== null && actionId !== undefined && MESSAGE_PIN_ACTION_IDS.includes(actionId);
}

export interface MessagePreview {
  kind: "message";
  messageId: string;
  channelId: string;
  /** 본문의 글자 수. 첨부만 있는 메시지는 서버가 `null` 을 싣는다. */
  totalChars: number | null;
  /** 카드의 발췌가 본문을 다 보여 주지 못했는가. */
  truncated: boolean;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * `action.preview` 를 메시지 미리보기로 읽는다. `kind` 가 정확히 `message` 이고 두 id 가 모두
 * 글자일 때만 값이다. 글자 수는 0 이상의 정수가 아니면 `null`(모르는 수를 짓지 않는다).
 */
export function parseMessagePreview(value: unknown): MessagePreview | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw["kind"] !== MESSAGE_PREVIEW_KIND) return null;
  const messageId = nonEmpty(raw["messageId"]);
  const channelId = nonEmpty(raw["channelId"]);
  if (messageId === null || channelId === null) return null;
  const total = raw["totalChars"];
  return {
    kind: "message",
    messageId,
    channelId,
    totalChars:
      typeof total === "number" && Number.isInteger(total) && total >= 0 ? total : null,
    truncated: raw["truncated"] === true,
  };
}

/** 문의 이름. 동사로 시작하고 「앱 안에서」가 아니라 **무엇을 하는가**를 말한다. */
export const MESSAGE_PREVIEW_LINK_LABEL = "전문 보기";

/**
 * 문 옆의 한 줄. 이 카드는 고정이 **채널 맨 위에 보증처럼 읽히는 일**이라는 점을 놓치지 않게,
 * 읽고 결정하라는 말만 한다(겁을 주지 않는다).
 */
export const MESSAGE_PREVIEW_HINT = "승인하기 전에 전체 글을 읽어 볼 수 있어요.";
