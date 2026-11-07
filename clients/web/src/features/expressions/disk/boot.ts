import { defaultExpressionDiskBackend } from "./idb";
import { expressionDiskName, type ExpressionDiskBackend } from "./port";
import { destroyAllExpressionDisks } from "./signOut";

// =============================================================================
// 시작 청소 (ADR-0218 §14 M2.5 「시작」, M5, #5455 B-1). 앱을 지우거나 브라우저를 닫는 등 로그아웃을 거치지 않은 종료가 남긴 것을 치운다.
//
// 1. 부팅 첫 단계(`main.tsx`, 세션을 복원하기 **전에** 시작): 수명이 지난 항목(모든 칸)을 지우고, 세션 저장소가 자리를 잡은 뒤(`ready`: 데스크탑은 키체인이
//    비동기로 답한다) 저장된 자격이 없으면 모든 보관 칸을 지운다.
// 2. 복원된 세션이 현재 `(워크스페이스, 멤버)`를 안 뒤(`TeamExpressionsProvider`가 마운트될 때): 현재 칸 밖을 모두 지운다.
// 3. 복원이 거절되면 `clearSession()`이 전부 지운다(`signOut.ts`) — 여기가 아니다.
// 어떤 실패도 던지지 않는다. 이 파일은 잎이다.
// =============================================================================

async function trimAll(backend: ExpressionDiskBackend): Promise<void> {
  for (const name of await backend.list()) await backend.open(name)?.trim();
}

/** 부팅 첫 단계. 첫 페인트를 막지 않는다(부르는 쪽이 기다리지 않는다). */
export async function startExpressionDiskBoot(options: {
  /** 세션 저장소가 자리를 잡았다는 약속(`initSessionStore()`). 실패해도 진행한다. */
  ready: Promise<unknown>;
  hasCredentials: () => boolean;
  backend?: ExpressionDiskBackend;
}): Promise<void> {
  const backend = options.backend ?? defaultExpressionDiskBackend();
  try {
    await trimAll(backend);
  } catch {
    // 수명 청소는 다음 시작이 다시 한다.
  }
  try {
    await options.ready;
  } catch {
    // 자리를 못 잡았어도 아래가 현재 자격을 본다.
  }
  if (!options.hasCredentials()) await destroyAllExpressionDisks(backend);
}

/** 복원된 세션의 현재 칸 밖을 지우고, 현재 칸의 수명 청소를 한다. */
export async function sweepExpressionDiskOutside(workspaceId: string, memberId: string, backend: ExpressionDiskBackend = defaultExpressionDiskBackend()): Promise<void> {
  try {
    const keep = expressionDiskName(workspaceId, memberId);
    for (const name of await backend.list()) if (name !== keep) await backend.destroy(name).catch(() => undefined);
    if (keep !== null) await backend.open(keep)?.trim();
  } catch {
    // 위와 같다.
  }
}
