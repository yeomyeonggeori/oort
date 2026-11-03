import type { MessageService } from "../../i18n/types";
import { uuidEq } from "../../lib/api";
import {
  memberNameParts,
  missingMemberLabel,
  type Directory,
} from "../workspace/directory";
import type { MessageExcerpt, ReplyHomeLine } from "./threadHome";

// =============================================================================
// 본류 답글 줄(`ReplyHomeLine`)의 문구 — **전부 i18n 사전의 것이다**(`catalogs/*/reply.json`의 `reply.home.*`).
//
// 웹과 폰이 이 한 함수에서 문장을 받는다: 같은 줄을 두 화면이 다르게 말하면 한 대화가 두 기기에서 다르게 읽힌다. 화살표 「↳」는
// 언어의 문구가 아니라 모양이라 여기 없다 — 그리는 쪽이 앞에 붙이고, 낭독에는 넣지 않는다(「아래로 꺾인 화살표」로 읽힌다).
// =============================================================================

export interface ReplyHomeCopy {
  /** 첫 줄(화살표 제외): 「○○님 스레드에 답글」, 내 글이면 「내 글 스레드에 답글」, 루트를 모르면 「스레드에 답글」. */
  header: string;
  /** 둘째 줄: 원문 한 줄. 루트를 아직 불러오지 못했으면 `null`(말할 것이 없다 — 지어내지 않는다). */
  excerpt: string | null;
  /** 눌러 스레드를 여는 단추의 낭독 이름. */
  openLabel: string;
  /** 한 번에 읽히는 문장 — 「첫 줄, 둘째 줄」. */
  spoken: string;
}

function excerptText(
  excerpt: MessageExcerpt,
  formatMessage: MessageService["formatMessage"]
): string {
  switch (excerpt.kind) {
    case "text":
      // 사용자 글이다 — 사전의 문구가 아니므로 그대로 둔다.
      return excerpt.text;
    case "photo":
      return formatMessage("reply.card.excerptPhoto");
    case "file":
      return formatMessage("reply.card.excerptFile");
    case "expression":
      return formatMessage("reply.card.excerptExpression");
    case "empty":
      return formatMessage("reply.card.excerptEmpty");
  }
}

export function replyHomeCopy(
  line: ReplyHomeLine,
  context: {
    directory: Directory;
    myMemberId: string | undefined;
    formatMessage: MessageService["formatMessage"];
  }
): ReplyHomeCopy {
  const { directory, myMemberId, formatMessage } = context;
  const header =
    line.kind === "unloaded"
      ? formatMessage("reply.home.headerUnknown")
      : uuidEq(line.rootAuthorMemberId, myMemberId)
        ? formatMessage("reply.home.headerSelf")
        : formatMessage("reply.home.header", {
            name: memberNameParts(directory, line.rootAuthorMemberId, missingMemberLabel(directory)).name,
          });
  const excerpt =
    line.kind === "unloaded"
      ? null
      : line.kind === "deleted"
        ? formatMessage("reply.home.excerptDeleted")
        : excerptText(line.excerpt, formatMessage);
  return {
    header,
    excerpt,
    openLabel: formatMessage("reply.home.open"),
    spoken: excerpt === null ? header : `${header}, ${excerpt}`,
  };
}
