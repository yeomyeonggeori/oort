import { useSyncExternalStore } from "react";
import {
  admitDrafts,
  attachmentIdsOf,
  beginUpload,
  completeUpload,
  draftFor,
  failUpload,
  issueForStatus,
  progressUpload,
  removeDraft as removeDraftFrom,
  requeueUpload,
  rewindUpload,
  sentAttachmentsOf,
  verifyUpload,
  type AttachmentDraft,
  type MessageAttachment,
} from "@momo/core/features/attachments/model";
import {
  ApiError,
  completeAttachmentUpload,
  createAttachmentUpload,
} from "@momo/core/lib/api";
import { putAttachmentBytes, type UploadHandle } from "./uploadTransport";

// =============================================================================
// 컴포저가 들고 있는 첨부, 그리고 그것을 올리는 일 (#1202 첨부 축).
//
// 규칙은 전부 `@momo/core/features/attachments/model`에 있다. 여기 남는 것은 그
// 규칙이 아닌 것뿐이다: 모듈 전역 맵, `File` 객체, `useSyncExternalStore` 구독,
// 그리고 세 왕복의 순서. `workLogStore.ts`가 같은 이유로 같은 모양이다.
//
// ## 왜 모듈 전역인가
//
// 컴포저는 채널을 옮겨도 **언마운트되지 않는다**(ChatShell이 key를 걸지 않는다).
// 그리고 언마운트되더라도, 올리던 파일이 그것과 함께 사라지면 안 된다: 30 MB를
// 60% 올려 둔 상태에서 스레드를 열었다 닫는 것이 그 60%를 버릴 이유는 없다.
// 초안 본문이 `draftStore.ts`에서 같은 성질을 갖는 것과 같다 — 다만 이쪽은
// `File`을 들고 있어서 localStorage로 갈 수 없고, 그래서 세션 메모리다.
//
// ## 왜 한 번에 하나씩 올리는가
//
// mac이 그렇게 한다(`MessageListView.submit` :1653-1692, 순차 루프). 그리고 웹
// 에서는 이유가 하나 더 있다: 같은 회선을 20개가 나눠 쓰면 20개의 막대가 전부
// 느리게 움직이고, 어느 것도 언제 끝날지 말하지 못한다. 하나씩이면 움직이는
// 막대가 하나이고 그 하나는 진짜 속도를 말한다.
//
// ## 지운 첨부와 서버의 pending 행
//
// 올리다 만 것을 지우면 서버에는 `pending` 행이 남는다. 되돌리는 라우트는 계약에
// 없고(openapi의 첨부는 3경로가 전부다), 서버는 그 행을 청소하는 인덱스를 이미
// 갖고 있다(`attachment_pending_cleanup_idx … WHERE status = 'pending' AND
// message_id IS NULL`). 그러니 여기서 할 일은 **아무것도 안 하는 것**이고, 그
// 판단은 mac이 실패한 업로드에 대해 내린 것과 같다.
// =============================================================================

/** 한 컴포저를 가리키는 열쇠. 스레드 컴포저는 채널 컴포저와 다른 트레이다. */
export function surfaceKey(
  workspaceId: string,
  channelId: string,
  rootId?: string
): string {
  return `${workspaceId}|${channelId}|${rootId ?? ""}`;
}

interface Surface {
  drafts: AttachmentDraft[];
  /** 한 메시지에 담기지 못하고 버려진 개수. 말없이 사라지지 않게 세어 둔다. */
  rejected: number;
}

const EMPTY: Surface = { drafts: [], rejected: 0 };

let surfaces: ReadonlyMap<string, Surface> = new Map();
const files = new Map<string, File>();
const inflight = new Map<string, UploadHandle>();
/** 이 표면에서 지금 올리는 중인 건이 있는가. 순차 업로드의 자물쇠. */
const pumping = new Set<string>();
const listeners = new Set<() => void>();

function emit(next: ReadonlyMap<string, Surface>): void {
  surfaces = next;
  for (const listener of listeners) listener();
}

function write(key: string, surface: Surface): void {
  const next = new Map(surfaces);
  if (surface.drafts.length === 0 && surface.rejected === 0) next.delete(key);
  else next.set(key, surface);
  emit(next);
}

function read(key: string): Surface {
  return surfaces.get(key) ?? EMPTY;
}

function update(
  key: string,
  fn: (drafts: AttachmentDraft[]) => AttachmentDraft[]
): void {
  const surface = read(key);
  write(key, { ...surface, drafts: fn(surface.drafts) });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 이 표면의 현재 상태. 참조가 안정적이어야 `useSyncExternalStore`가 조용하다. */
export function readSurface(key: string): Surface {
  return read(key);
}

export function useAttachmentSurface(key: string): Surface {
  return useSyncExternalStore(
    subscribe,
    () => readSurface(key),
    () => EMPTY
  );
}

// ---- 세 왕복 ----------------------------------------------------------------

interface UploadTarget {
  workspaceId: string;
  channelId: string;
}

/**
 * 한 건을 끝까지 올린다. 세 왕복이 전부 여기 있고, 그 사이의 칸 이동도 여기서
 * 한다 — 화면은 칸을 읽기만 한다.
 */
async function uploadOne(
  key: string,
  target: UploadTarget,
  draft: AttachmentDraft
): Promise<void> {
  const file = files.get(draft.localId);
  if (file === undefined) {
    update(key, (list) => failUpload(list, draft.localId, "unavailable"));
    return;
  }
  update(key, (list) => beginUpload(list, draft.localId));

  let session;
  try {
    session = await createAttachmentUpload(target.workspaceId, target.channelId, {
      name: draft.name,
      mime: draft.mime,
      size: draft.sizeBytes,
    });
  } catch (error) {
    update(key, (list) =>
      failUpload(
        list,
        draft.localId,
        error instanceof ApiError ? issueForStatus(error.status) : "unavailable"
      )
    );
    return;
  }

  const handle = putAttachmentBytes(
    session.uploadUrl,
    file,
    draft.mime,
    (fraction) => update(key, (list) => progressUpload(list, draft.localId, fraction))
  );
  inflight.set(draft.localId, handle);
  const result = await handle.done;
  inflight.delete(draft.localId);

  if (!result.ok) {
    if (result.failure === "aborted") {
      // 취소는 실패가 아니다. 칩이 이미 지워졌다면 되감을 행도 없다.
      update(key, (list) => rewindUpload(list, draft.localId));
      return;
    }
    update(key, (list) =>
      failUpload(
        list,
        draft.localId,
        result.failure === "blocked"
          ? "blocked"
          : result.failure === "status" && result.status !== undefined
            ? issueForStatus(result.status)
            : "unavailable"
      )
    );
    return;
  }

  update(key, (list) => verifyUpload(list, draft.localId));
  try {
    const row = await completeAttachmentUpload(
      target.workspaceId,
      target.channelId,
      session.id
    );
    update(key, (list) => completeUpload(list, draft.localId, row.id));
  } catch (error) {
    update(key, (list) =>
      failUpload(
        list,
        draft.localId,
        error instanceof ApiError ? issueForStatus(error.status) : "unavailable"
      )
    );
  }
}

/** 올릴 것이 남아 있는 동안 하나씩. 표면당 하나만 돈다. */
async function pump(key: string, target: UploadTarget): Promise<void> {
  if (pumping.has(key)) return;
  pumping.add(key);
  try {
    for (;;) {
      const next = read(key).drafts.find((draft) => draft.status === "ready");
      if (next === undefined) return;
      await uploadOne(key, target, next);
    }
  } finally {
    pumping.delete(key);
  }
}

// ---- 바깥에서 부르는 것들 ----------------------------------------------------

export function addFiles(
  key: string,
  target: UploadTarget,
  picked: File[]
): void {
  if (picked.length === 0) return;
  const incoming = picked.map((file) => {
    const localId = crypto.randomUUID();
    files.set(localId, file);
    return draftFor(localId, {
      name: file.name,
      // 빈 문자열은 브라우저가 확장자를 모른다는 뜻이다. 서버의 mime 검증은
      // `type/subtype` 형상을 요구하므로 빈 값은 400이 된다. mac이 같은 자리에서
      // 고른 기본값과 같은 값을 쓴다.
      mime: file.type === "" ? "application/octet-stream" : file.type,
      sizeBytes: file.size,
    });
  });
  const surface = read(key);
  const { next, rejected } = admitDrafts(surface.drafts, incoming);
  // 자리를 못 얻은 파일은 메모리에서도 놓는다.
  for (const draft of incoming.slice(incoming.length - rejected)) {
    files.delete(draft.localId);
  }
  write(key, { drafts: next, rejected: surface.rejected + rejected });
  void pump(key, target);
}

export function retryDraft(key: string, target: UploadTarget, localId: string): void {
  update(key, (list) => requeueUpload(list, localId));
  void pump(key, target);
}

export function dropDraft(key: string, localId: string): void {
  inflight.get(localId)?.abort();
  inflight.delete(localId);
  files.delete(localId);
  update(key, (list) => removeDraftFrom(list, localId));
}

export function clearSurface(key: string): void {
  for (const draft of read(key).drafts) {
    inflight.get(draft.localId)?.abort();
    inflight.delete(draft.localId);
    files.delete(draft.localId);
  }
  write(key, EMPTY);
}

/** 「자리가 없어 버렸다」 고지를 사람이 읽고 나면 지운다. */
export function acknowledgeRejected(key: string): void {
  const surface = read(key);
  if (surface.rejected === 0) return;
  write(key, { ...surface, rejected: 0 });
}

/**
 * 전송에 실을 것을 **보기만** 한다.
 *
 * 낙관적 echo 가 없는 표면(스레드 컴포저)이 쓴다. 거기서는 전송이 실패해도
 * 다시 보내기를 대신해 줄 행이 없으므로, 트레이를 비우는 것은 서버가 받았다는
 * 사실을 확인한 **뒤**여야 한다. 먼저 비우면 실패한 답글의 파일이 사라지고,
 * 사람은 같은 파일을 다시 찾아 붙여야 한다.
 */
export function peekSent(key: string): {
  attachmentIds: string[];
  attachments: MessageAttachment[];
} {
  const drafts = read(key).drafts;
  return {
    attachmentIds: attachmentIdsOf(drafts),
    attachments: sentAttachmentsOf(drafts),
  };
}

/**
 * 전송에 실을 것을 꺼내고 트레이를 비운다.
 *
 * 꺼내는 것과 비우는 것이 한 함수인 이유: 둘 사이에 렌더가 끼면 이미 보낸 파일이
 * 한 프레임 동안 트레이에 남고, 그 프레임에 전송을 한 번 더 누를 수 있다.
 */
export function takeSent(key: string): {
  attachmentIds: string[];
  attachments: MessageAttachment[];
} {
  const drafts = read(key).drafts;
  const attachmentIds = attachmentIdsOf(drafts);
  const attachments = sentAttachmentsOf(drafts);
  for (const draft of drafts) files.delete(draft.localId);
  write(key, EMPTY);
  return { attachmentIds, attachments };
}

/** 테스트 전용 초기화. 모듈 전역이 테스트 사이를 넘어가지 않게 한다. */
export function resetAttachmentDraftsForTest(): void {
  for (const handle of inflight.values()) handle.abort();
  inflight.clear();
  files.clear();
  pumping.clear();
  emit(new Map());
}
