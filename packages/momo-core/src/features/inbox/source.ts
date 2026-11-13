import type { Channel } from "../../lib/api";
import type { MessageService } from "../../i18n/types";
import type { MailboxKind } from "./mailbox";
import {
  channelLabelParts,
  idKey,
  memberNameParts,
  missingMemberLabel,
  type Directory,
} from "../workspace/directory";

// =============================================================================
// 받은함 줄의 출처 한 줄 (#5696, owner 11-13, Buzz 받은함 참고). 웹·데스크탑·폰이 같은 판정을 쓴다.
//
// 줄마다 이름 아래 둘째 줄에 「어디서 온 글인가」가 같은 자리·같은 모양으로 선다:
//
//   스레드 답글·스레드 안의 글   「스레드 · #채널」
//   DM                           「DM · 이름」, 여럿인 DM은 「DM · 이름, 이름 외 N명」
//   채널의 멘션·답글             「#채널」
//   처리할 일(승인 카드)          「처리할 일 · 승인 요청」(지금의 종류 표시를 그 자리에 둔다)
//
// 이 파일은 두 단계다. `mailboxPlace`·`mailboxSource`는 **판정**(문구 없음)이고, `mailboxSourceLine`이
// 사전 키(`inbox.source.*`)로 문장을 짓는다(`threadSummary`·`threadSummaryCopy`와 같은 나눔).
//
// ## 보이는 범위는 지금 그대로
//
// 장소의 이름은 **내 채널 목록에 있는 채널**(사이드바가 이미 보이는 것)에서만 짓는다. 목록에 없는 채널(볼 수 없게 된
// 채널·떠난 DM)은 서버 항목이 준 `channel.name`만 쓰고, DM은 이름 없이 「DM」이다 — 명부(디렉터리)에서 글쓴이 이름을
// 끌어와 DM 이름을 지어내지 않는다. 서버가 준 값도 이름도 없으면 「채널」이다(id 조각을 이름처럼 내지 않는다).
// =============================================================================

/** 항목이 온 장소. 이름이 없으면(`null`·빈 배열) 「모른다」이고 이름 없이 종류만 말한다. */
export type MailboxPlace =
  | { kind: "channel"; name: string | null }
  | {
      kind: "dm";
      /** 나를 뺀 참가자 이름(겹치는 이름은 핸들까지). 목록에 없는 DM은 빈 배열. */
      names: readonly string[];
    };

/** 출처 한 줄의 판정. 화면은 `mailboxSourceLine`으로 문장을 받는다. */
export type MailboxSource =
  | { kind: "task" }
  | { kind: "thread"; place: Extract<MailboxPlace, { kind: "channel" }> }
  | { kind: "place"; place: MailboxPlace };

/** 서버 항목이 싣는 채널 사실(`ServerInboxItem.channel`). 구 서버 경로에는 없다. */
export interface MailboxWireChannel {
  name: string | null;
  kind: string;
}

/** 여럿인 DM에서 이름으로 세우는 참가자 수. 나머지는 「외 N명」. */
export const SOURCE_DM_NAMES_MAX = 2;

/**
 * 항목의 장소를 정한다.
 *
 * - `channel`: 내 채널 목록(사이드바와 같은 목록)에서 찾은 채널. 있으면 그것으로 이름을 짓는다 — DM은
 *   `channelLabelParts`(사이드바·대화 머리와 같은 한 함수)로, 여럿인 DM은 참가자 이름을 하나씩.
 * - `wire`: 서버 항목이 준 채널 사실. 목록에 없을 때만 읽고, 이름은 서버가 준 것만 쓴다.
 */
export function mailboxPlace(input: {
  channel: Channel | undefined;
  wire?: MailboxWireChannel;
  directory: Directory;
  selfMemberId: string;
}): MailboxPlace {
  const { channel, wire, directory, selfMemberId } = input;
  if (channel === undefined) {
    if (wire?.kind === "dm") return { kind: "dm", names: [] };
    const name = wire?.name?.trim() ?? "";
    return { kind: "channel", name: name === "" ? null : name };
  }
  if (channel.kind !== "dm") {
    const name = channel.name?.trim() ?? "";
    return { kind: "channel", name: name === "" ? null : name };
  }
  const others = (channel.memberIds ?? []).filter(
    (id) => idKey(id) !== idKey(selfMemberId)
  );
  if (others.length > 1) {
    const missing = missingMemberLabel(directory);
    return {
      kind: "dm",
      names: others.map((id) => {
        const part = memberNameParts(directory, id, missing);
        return part.handle ? `${part.name} ${part.handle}` : part.name;
      }),
    };
  }
  // 1:1·나 혼자·명부 대기·나간 멤버는 대화 이름을 정하는 한 함수가 이미 말한다(#3675).
  const parts = channelLabelParts(channel, directory, selfMemberId);
  return {
    kind: "dm",
    names: [parts.handle ? `${parts.text} ${parts.handle}` : parts.text],
  };
}

/**
 * 출처 판정. 처리할 일은 종류 표시 그대로, DM은 언제나 「DM · 이름」(DM 안의 스레드도 — 장소가 그 대화다),
 * 채널은 스레드 안의 글이면 「스레드 · #채널」, 아니면 「#채널」.
 */
export function mailboxSource(
  kind: MailboxKind,
  place: MailboxPlace,
  inThread: boolean
): MailboxSource {
  if (kind === "task") return { kind: "task" };
  if (place.kind === "channel" && (inThread || kind === "thread")) {
    return { kind: "thread", place };
  }
  return { kind: "place", place };
}

type Format = MessageService["formatMessage"];

function channelText(name: string): string {
  return `#${name}`;
}

function dmLine(names: readonly string[], formatMessage: Format): string {
  if (names.length === 0) return formatMessage("inbox.source.dmUnknown");
  if (names.length <= SOURCE_DM_NAMES_MAX) {
    return formatMessage("inbox.source.dm", { name: names.join(", ") });
  }
  return formatMessage("inbox.source.dmGroup", {
    names: names.slice(0, SOURCE_DM_NAMES_MAX).join(", "),
    count: names.length - SOURCE_DM_NAMES_MAX,
  });
}

/** 출처 한 줄의 문장. 비는 경우가 없다(줄 높이가 출처에 따라 달라지지 않게 언제나 글이 선다). */
export function mailboxSourceLine(
  source: MailboxSource,
  formatMessage: Format
): string {
  switch (source.kind) {
    case "task":
      return formatMessage("inbox.source.task");
    case "thread":
      return source.place.name === null
        ? formatMessage("inbox.source.threadUnknown")
        : formatMessage("inbox.source.thread", {
            channel: channelText(source.place.name),
          });
    case "place":
      if (source.place.kind === "dm") return dmLine(source.place.names, formatMessage);
      return source.place.name === null
        ? formatMessage("inbox.source.channelUnknown")
        : channelText(source.place.name);
  }
}

/** 출처 줄이 항목의 종류를 이미 말하는가. 낭독 이름이 종류 낱말을 따로 붙일지 정한다. */
export function sourceSaysKind(kind: MailboxKind, source: MailboxSource): boolean {
  if (source.kind === "task") return kind === "task";
  if (source.kind === "thread") return kind === "thread";
  return source.place.kind === "dm" && kind === "dm";
}
