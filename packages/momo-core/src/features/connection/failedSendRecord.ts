import type { PendingMessage } from "../timeline/model";
import type { SendFailureKind } from "./sendFailure";

// =============================================================================
// 이 기기에 남기는 「보내지 못한 글」 한 건의 모양 (#5221, #5201 S-C).
//
// 저장소를 만지는 일(열쇠·수명·정원·비밀 키 거부·로그아웃)은 웹 `chat/draftStore.ts`가 초안과 같은 규칙으로 한다.
// 여기는 **한 건을 문자열로 만들고 읽는 일**만 한다: 순수하고, 읽을 때 모양을 의심한다(손으로 고쳐졌거나 옛 판이면
// 항목이 아니다). 폰이 같은 일을 하게 되면 같은 모양을 쓴다.
//
// 읽은 행은 언제나 「못 보낸」(`failed`) 행이다. 쓸 때 보내는 중(`sending`)이던 행도 같다: 화면을 떠난 뒤의 결과를 모르는
// 글은 실패 행으로 돌아오고, 같은 멱등 키로 다시 보내면 서버가 중복을 막는다.
// =============================================================================

export interface StoredFailedSend {
  readonly row: PendingMessage;
  readonly kind: SendFailureKind | null;
  /** 마지막으로 남긴 시각(epoch ms). 수명과 정원 판정의 유일한 기준이다. */
  readonly atMs: number;
}

const KINDS: readonly string[] = ["offline", "server", "rejected"];

export function serializeFailedSend(row: PendingMessage, kind: SendFailureKind | null, atMs: number): string {
  return JSON.stringify({ row, kind, atMs });
}

/** 읽을 수 없으면 `null`. 필요한 칸이 있고 모양이 맞아야 한다. 상태는 어떻게 적혀 있든 `failed`로 돌려준다. */
export function parseFailedSend(raw: string | null): StoredFailedSend | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { row, kind, atMs } = value as Record<string, unknown>;
    if (typeof atMs !== "number" || !Number.isFinite(atMs)) return null;
    if (typeof row !== "object" || row === null) return null;
    const r = row as Record<string, unknown>;
    if (typeof r.clientMsgId !== "string" || r.clientMsgId === "") return null;
    if (typeof r.channelId !== "string" || r.channelId === "") return null;
    if (typeof r.authorMemberId !== "string" || r.authorMemberId === "") return null;
    if (typeof r.body !== "string") return null;
    if (typeof r.createdAtMs !== "number" || !Number.isFinite(r.createdAtMs)) return null;
    if (r.sinceSeq !== null && typeof r.sinceSeq !== "number") return null;
    if (r.attachments !== undefined && !Array.isArray(r.attachments)) return null;
    return {
      row: { ...(r as unknown as PendingMessage), status: "failed" },
      kind: typeof kind === "string" && KINDS.includes(kind) ? (kind as SendFailureKind) : null,
      atMs,
    };
  } catch {
    return null;
  }
}
