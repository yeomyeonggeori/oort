import { absoluteApiBase } from "@/lib/serverBase";

// #4113: 「같은 서버에서 Hermes를 찾았어요, 연결할까요?」 창은 처음 한 번만 뜬다. 기억은 서버에 두지 않고 이
// 브라우저(데스크탑 셸 포함)에만 둔다. 단위는 운영자 · 서버 · Hermes 주소다: 다른 서버나 다른 Hermes 주소로
// 바뀌면 새 후보이니 다시 한 번 묻고, 다른 운영자가 같은 기기를 써도 서로의 답을 가져가지 않는다.

const PREFIX = "momo.cohosted.prompted.v1:";

export function cohostedPromptKey(input: { memberId: string; workspaceId: string; endpointLabel: string | null | undefined }): string {
  return `${PREFIX}${JSON.stringify([input.memberId, absoluteApiBase(), input.workspaceId, input.endpointLabel ?? ""])}`;
}

/** 저장소를 못 읽으면(비공개 창·차단) 이미 물은 것으로 본다: 못 기억하는 곳에서 매번 띄우지 않는다. */
export function wasCohostedPromptShown(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== null;
  } catch {
    return true;
  }
}

export function markCohostedPromptShown(key: string): void {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    /* 기억하지 못해도 카드는 설정에 남는다. */
  }
}
