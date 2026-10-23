import { uuidEq, type RosterMember } from "../../lib/api";
import { mentionedAgents, mentionedHandles } from "../routing/mentionTargets";

// =============================================================================
// 이 글을 지금 보내면 내 개인 에이전트 호출이 되는가: **판정만 한다** (ADR-0208 D16, UI 명세 0.4, #4237).
//
// 개인 에이전트 호출은 소유자의 **클라이언트**가 한다: 메시지를 보내고, 그 메시지 id를 서명해
// `POST /work-spawns`를 부른다(`callPersonalAgent`). 서버는 멘션에서 작업을 만들지 않는다. 그래서
// 예약된 글은 정시에 서버가 보내는 평범한 메시지가 될 뿐 호출이 일어나지 않는다. 사람이 호출이 될 줄
// 알고 예약한 글이 말없이 호출 없이 나가면 안 되므로, **지금 보내면 호출이 되는 글은 예약 단추가
// 막는다**(「개인 에이전트 호출은 예약할 수 없어요」).
//
// 이 판정은 **그 트리의 보내기가 호출로 가를 글과 정확히 같아야** 한다. 덜 막으면(예약을 허락했는데
// 지금 보내면 호출이다) 호출이 조용히 사라지고, 더 막으면(호출이 아닌 글을 막는다) 거짓 이유를
// 말한다. 그런데 웹과 폰의 보내기 규칙은 **이미 갈라져 있다.**
//
//   웹 (`personalAgentCalling.callTargetFor`)   글 어디에 있는 `@핸들`이든(별칭 포함), 그다음 DM 상대
//   폰 (`personalAgentCallModel`)               DM 상대가 먼저, 그다음 글머리의 `@핸들`만(보안 검수 L2:
//                                               「저는 @별칭 쓰는 중」 같은 문장 속 언급이 Face ID를
//                                               올리면 안 된다)
//
// 규칙 하나로 두 트리를 대신하면 한쪽의 보내기 동작이 바뀐다. 그래서 **어느 규칙인지를 호출부가
// `reach`로 명시한다**(「조용히 하나를 고르지 않는다」). 통일은 별도의 제품 결정이다.
//
// 「내 개인 에이전트」로 읽는 로스터 행의 좁히기도 트리마다 다르다(웹 `myPersonalAgent`: `mentionable`
// 필수, 폰 `personalAgentRows`: 표시 이름 필수·은퇴 제외). 그것을 코어가 하나로 고쳐 쓰면 역시 한쪽이
// 바뀌므로, 호출부가 **자기 규칙으로 좁힌 후보**(`candidates`)를 넘기고 코어는 「이 글이 그중 누구를
// 부르는가」만 판정한다. 빌드 게이트(폰의 `spawnPort().wired`)·인용·첨부 조건은 호출부가 합친다.
// =============================================================================

/** 호출 대상이 될 수 있는 내 개인 에이전트 한 명. 호출부가 자기 규칙으로 좁힌 결과다. */
export interface PersonalCallCandidate {
  memberId: string;
  handle: string;
  /** 서명의 `tool`: 하네스 키(`claude`·`codex`…). */
  harness: string;
}

/**
 * 글의 어디까지를 호출로 읽는가.
 *  - `anywhere`(웹): 글 어디의 `@핸들`이든(별칭 포함), 없으면 DM 상대. 멘션이 먼저다.
 *  - `leading`(폰): DM 상대가 먼저, 없으면 글머리의 `@핸들`만(별칭 아님, 정확한 핸들).
 */
export type PersonalCallReach = "anywhere" | "leading";

export interface PersonalCallInput {
  /** 보낼 글. 앞뒤 공백만 있으면 호출이 아니다. */
  body: string;
  /** 별칭을 핸들로 푸는 데 쓰는 전체 로스터(`anywhere`). */
  members: readonly RosterMember[];
  /** 호출부가 「내 개인 에이전트」로 좁힌 후보. */
  candidates: readonly PersonalCallCandidate[];
  /** 1:1 DM의 상대가 에이전트면 그 멤버 id(`dmAutoReplyAgent`), 아니면 `null`. */
  dmAgentId: string | null;
  reach: PersonalCallReach;
}

/**
 * 이 글이 부르는 내 개인 에이전트, 없으면 `null`(평범한 메시지). 보내지 않는다. 글이 비어 있으면
 * DM에서도 호출이 아니다: 보낼 것이 없는 입력창에는 「보낼 내용을 쓰면 예약할 수 있어요」가 맞다.
 */
export function personalCallTarget(input: PersonalCallInput): PersonalCallCandidate | null {
  if (input.body.trim() === "" || input.candidates.length === 0) return null;
  const candidate = (memberId: string): PersonalCallCandidate | null =>
    input.candidates.find((entry) => uuidEq(entry.memberId, memberId)) ?? null;
  const peer = (): PersonalCallCandidate | null =>
    input.dmAgentId === null ? null : candidate(input.dmAgentId);

  if (input.reach === "anywhere") {
    for (const agent of mentionedAgents(input.body, [...input.members])) {
      const mine = candidate(agent.id);
      if (mine !== null) return mine;
    }
    return peer();
  }

  const dm = peer();
  if (dm !== null) return dm;
  const lead = mentionedHandles(input.body)[0];
  if (lead !== undefined && /^\s*(?:<@|@)/.test(input.body)) {
    return input.candidates.find((entry) => entry.handle.toLowerCase() === lead) ?? null;
  }
  return null;
}
