// =============================================================================
// 상태 점 (#3964, 성재 2026-10-16 「꺼짐은 뭐야? … buzz UI 참고해」).
//
// DM 행·프로필·멤버 목록이 **같은 색 체계**로 사람과 에이전트의 상태를 말하게 하는 순수 판정이다. 점의
// 톤(`ok`/`warn`/`danger`/`muted`)과 낱말만 여기 있고, 어느 클래스·어느 팔레트 값이 되는가는 각
// 클라가 자기 표면에 매긴다(`presence/model.ts` 머리말과 같은 분업: 웹은 Tailwind, 폰은 토큰 객체).
//
// ## 무엇이 점이 되는가
//
//   사람     스스로 정한 **자리 비움**(warn)·**방해 금지**(danger)이 먼저이고, 그렇지 않으면(auto) **접속 여부**가 정한다
//            (#4692, ADR-0160 D3 `f(선언, 가용성)`): 접속 중 = 채운 초록(ok), 접속 없음 = 속 빈 고리(muted) - 에이전트
//            점과 같은 문법이다(초록 = 살아 있다, 고리 = 꺼져 있다). 가용성은 서버가 전송(Centrifugo presence)에서
//            읽어 명부 행에 `online` 으로 싣는다. **모르면(필드 없음) 점이 없다** - 명부가 접속 여부를 모를 때 초록이나
//            고리를 그리면 근거 없는 점이다(design-review #1889 H-3). 방해 금지는 접속 중이어도 방해 금지로 보인다.
//   에이전트 서버가 파생한 **생존 판정**(`livenessView`)을 점으로 옮긴다(Buzz식, 소유자 결정 2026-10-17
//            「Buzz식: 초록=살아 있음, 회색 고리=꺼짐」). 낱말이 곁에 없는 자리라 **모양이 말한다**:
//
//              채운 초록  ok     살아 있음 - 응답함(최근에 일을 했다) · 살아 있음 · 대기 중(신호는 온다)
//              속 빈 고리 muted  꺼짐 - 조용함(신호가 한동안 없다) · 연결이 꺼져 있어요 - 그리고 일반 멤버에게는 아래 경고 넷도 이쪽
//              채운 주황  warn   일이 안 가져가짐·응답 없음·거절됨(다시 깨울 수 있는 owner/admin 에게만)
//
//            채운 초록 = 「살아 있다」, 속 빈 고리 = 「꺼져 있다(지금 응답을 기대하기 어렵다)」, 채운 주황 = 「손이 필요하다」.
//            응답함과 살아 있음·대기가 한 색인 것은 결정이다: 점이 답하는 질문은 「꺼져 있다는 거야?」 하나이고
//            (성재 2026-10-16), 응답함과 대기의 차이는 낱말(툴팁·접근 가능한 이름·칩)이 말한다. 생존 **칩**의 점도
//            같은 함수(`agentDotTone`)를 읽는다: 한 상태가 두 자리에서 다른 색이 되지 않는다.
//            warn 은 **다시 깨울 수 있는 사람(owner/admin)에게만** 경고다(`livenessToneFor`). 그 밖의 멤버는 같은
//            사실이 중립이라 속 빈 고리로 내려간다(그에게 「일을 안 가져간다」는 「지금 맡겨도 응답이 없다」다).
//            생존 라벨이 없는 에이전트(호스티드가 아님: 서버가 404)는 명부의 호스트 연결(`hostOnline`)만으로
//            닿아 있을 때 ok 점이 된다. 닿아 있지 않거나 모르면 점이 없다.
//   모를 때   생존 판정을 **아직 못 받았으면**(undefined) 점이 없다. 호스트 연결 폴백을 먼저 그리면 곧
//            이어 도착하는 판정이 다른 색일 때 거짓을 한 번 그렸다 지우게 된다.
//
// 색만으로 말하지 않는다: 낱말은 `label`/`meaning` 이 들고, 행에서는 글자를 빼는 대신 접근 가능한 이름과
// 툴팁이 말한다(웹 `DmAvatar`, 폰 `Row`). muted 는 웹에서 속이 빈 고리로 그려 모양으로도 갈린다.
// =============================================================================

import { uuidEq, type AgentLiveness, type RosterMember } from "../../lib/api";
import {
  livenessToneFor,
  livenessView,
  type LivenessView,
} from "../agents/liveness";
import { declaredStatusLabel, effectivePresenceLabel } from "./model";

export type StatusDotTone = "ok" | "warn" | "danger" | "muted";

export interface StatusDot {
  tone: StatusDotTone;
  /** 상태 낱말. 행의 접근 가능한 이름과 툴팁의 첫 줄이다. */
  label: string;
  /** 낱말의 뜻 한 문장(에이전트 생존 판정만). 툴팁의 둘째 줄이다. */
  meaning?: string;
}

/** 생존 판정이 없는 에이전트가 호스트에 닿아 있을 때의 낱말. 새 DM 모달의 점과 같은 낱말이다. */
export const AGENT_HOST_ONLINE_LABEL = "연결됨";

/**
 * 에이전트 한 판정의 점 톤 - **아바타 점과 생존 칩이 같은 함수를 읽는다**(소유자 결정 2026-10-17 「Buzz식: 초록=살아 있음,
 * 회색 고리=꺼짐」). 보는 사람에게 맞춘 생존 톤(`livenessToneFor`)이 ok·warn 이면 그대로이고, neutral 은 **살아 있는가**로
 * 가른다: 신호가 오는 `alive_idle` 은 초록(살아 있음), 나머지(조용함·꺼짐, 그리고 일반 멤버에게 강등된 경고)는 속 빈
 * 고리(`muted`: 꺼짐).
 */
export function agentDotTone(
  view: Pick<LivenessView, "state" | "tone">,
  mayAct: boolean
): StatusDotTone {
  const tone = livenessToneFor(view, mayAct);
  if (tone === "warn") return "warn";
  if (tone === "ok") return "ok";
  return view.state === "alive_idle" ? "ok" : "muted";
}

/** 에이전트의 생존 판정 → 점. `mayAct` 는 보는 사람이 경고에 할 수 있는 일이 있는가. */
export function agentLivenessDot(
  liveness: Pick<AgentLiveness, "state" | "lastSignalAtMs">,
  nowMs: number,
  mayAct: boolean
): StatusDot {
  const view = livenessView(liveness, nowMs);
  return {
    tone: agentDotTone(view, mayAct),
    label: view.text,
    meaning: view.meaning,
  };
}

/** 생존 판정이 없는 에이전트: 호스트에 닿아 있을 때만 점이다. */
export function agentHostDot(hostOnline: boolean | undefined): StatusDot | null {
  return hostOnline === true
    ? { tone: "ok", label: AGENT_HOST_ONLINE_LABEL }
    : null;
}

/**
 * 사람: 선언 상태가 먼저이고(방해 금지 > 자리 비움), 선언이 없으면(auto) 접속 여부가 정한다.
 *
 *   방해 금지  접속 중이어도 방해 금지(danger). 만료 시각이 지나면 자동(auto)으로 본다 - 서버는 만료 때 이벤트를
 *             보내지 않는다. 만료된 방해 금지는 「점 없음」이 아니라 접속 여부로 내려간다.
 *   자리 비움  warn
 *   auto      `online === true` 채운 초록(ok) · `online === false` 속 빈 고리(muted) · 모르면(`undefined`) **점 없음**
 *
 * `online` 이 `undefined` 인 것은 「꺼짐」이 아니라 「모름」이다(서버가 가용성을 못 읽은 응답, 구서버, 에이전트).
 * 모름을 고리로 그리면 브로커가 잠깐 느린 것만으로 모든 동료가 꺼진 것처럼 보인다.
 */
export function humanPresenceDot(
  member: Pick<RosterMember, "presenceStatus" | "dndUntilMs" | "online">,
  nowMs: number
): StatusDot | null {
  if (member.presenceStatus === "away") {
    return { tone: "warn", label: declaredStatusLabel("away") };
  }
  if (
    member.presenceStatus === "dnd" &&
    !(member.dndUntilMs !== undefined && member.dndUntilMs <= nowMs)
  ) {
    return { tone: "danger", label: declaredStatusLabel("dnd") };
  }
  if (member.online === true) {
    return { tone: "ok", label: effectivePresenceLabel("online") };
  }
  if (member.online === false) {
    return { tone: "muted", label: effectivePresenceLabel("offline") };
  }
  return null;
}

/**
 * 점을 그릴 행. **보는 사람 자기 행**의 접속 여부는 이 클라이언트 자신의 연결이다(`connected`): 자기 프레즌스
 * 컨트롤이 이미 `effectivePresence(선언, 연결됨)` 으로 그렇게 만든다. 서버의 `online` 은 브로커가 본 것이라
 * 방금 앱을 연 사람에게는 출석부 구독이 끝나기 전까지 비어 있고, 출석부 구독이 실패한 채 연결만 살아 있으면 거짓이
 * 된다. 남의 행은 그대로 돌려준다(남의 접속은 서버 말이 전부다).
 *
 * 자기 연결(①)이 프레즌스(②)가 되는 것은 **자기 행의 점에서만**이고(ADR-0160 가드 6은 연결 점(WorkspaceRail)이
 * 신호가 되는 것을 막는다), 남에게 나가는 값은 아무것도 바뀌지 않는다.
 */
export function withOwnConnection<T extends Pick<RosterMember, "id" | "online">>(
  member: T,
  selfMemberId: string,
  connected: boolean
): T {
  return uuidEq(member.id, selfMemberId) ? { ...member, online: connected } : member;
}

/**
 * DM 상대 한 명의 점. 웹 `DmAvatar` 와 폰 `Row` 가 이 한 함수를 부른다.
 *
 * `liveness`: 값 있음 / `null`(라벨 없음: 호스티드가 아님) / `undefined`(아직 모름). 사람에게는 쓰지 않는다.
 */
export function dmPeerStatusDot(input: {
  member: Pick<
    RosterMember,
    "kind" | "hostOnline" | "presenceStatus" | "dndUntilMs" | "online"
  > | null;
  liveness: Pick<AgentLiveness, "state" | "lastSignalAtMs"> | null | undefined;
  mayAct: boolean;
  nowMs: number;
}): StatusDot | null {
  const { member, liveness, mayAct, nowMs } = input;
  if (member === null) return null;
  if (member.kind !== "agent") return humanPresenceDot(member, nowMs);
  if (liveness === undefined) return null;
  if (liveness === null) return agentHostDot(member.hostOnline);
  return agentLivenessDot(liveness, nowMs, mayAct);
}

/** 툴팁 문장: 낱말, 있으면 뜻까지. */
export function statusDotTooltip(dot: StatusDot): string {
  return dot.meaning === undefined ? dot.label : `${dot.label}. ${dot.meaning}`;
}
