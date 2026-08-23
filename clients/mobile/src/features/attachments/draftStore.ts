import {useSyncExternalStore} from 'react';

import {
  admitDrafts,
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
  type UploadIssue,
} from '@momo/core/features/attachments/model';
import {
  ApiError,
  completeAttachmentUpload,
  createAttachmentUpload,
} from '@momo/core/lib/api';

import type {PickedAttachmentFile} from './picker';
import {putAttachmentBytes, type UploadHandle} from './uploadTransport';

export interface AttachmentTarget {
  workspaceId: string;
  channelId: string;
  rootId?: string;
}

export interface AttachmentSurface {
  drafts: AttachmentDraft[];
  pickerIssue: UploadIssue | null;
}

const EMPTY: AttachmentSurface = {drafts: [], pickerIssue: null};

let surfaces: ReadonlyMap<string, AttachmentSurface> = new Map();
const files = new Map<string, PickedAttachmentFile>();
const inflight = new Map<string, UploadHandle>();
const pumping = new Set<string>();
const listeners = new Set<() => void>();

export function attachmentSurfaceKey(target: AttachmentTarget): string {
  return `${target.workspaceId}|${target.channelId}|${target.rootId ?? ''}`;
}

function emit(next: ReadonlyMap<string, AttachmentSurface>): void {
  surfaces = next;
  for (const listener of listeners) listener();
}

function read(key: string): AttachmentSurface {
  return surfaces.get(key) ?? EMPTY;
}

function write(key: string, surface: AttachmentSurface): void {
  const next = new Map(surfaces);
  if (surface.drafts.length === 0 && surface.pickerIssue === null) {
    next.delete(key);
  } else {
    next.set(key, surface);
  }
  emit(next);
}

function update(
  key: string,
  fn: (drafts: AttachmentDraft[]) => AttachmentDraft[],
): void {
  const surface = read(key);
  write(key, {...surface, drafts: fn(surface.drafts)});
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** null key is the attachment-free Composer shape used by isolated tests. */
export function useAttachmentSurface(key: string | null): AttachmentSurface {
  return useSyncExternalStore(
    subscribe,
    () => (key === null ? EMPTY : read(key)),
    () => EMPTY,
  );
}

async function uploadOne(
  key: string,
  target: AttachmentTarget,
  draft: AttachmentDraft,
): Promise<void> {
  const picked = files.get(draft.localId);
  if (picked === undefined) {
    update(key, list => failUpload(list, draft.localId, 'unavailable'));
    return;
  }
  update(key, list => beginUpload(list, draft.localId));

  let session;
  try {
    session = await createAttachmentUpload(
      target.workspaceId,
      target.channelId,
      {
        name: draft.name,
        mime: draft.mime,
        size: draft.sizeBytes,
      },
    );
  } catch (error: unknown) {
    update(key, list =>
      failUpload(
        list,
        draft.localId,
        error instanceof ApiError
          ? issueForStatus(error.status)
          : 'unavailable',
      ),
    );
    return;
  }

  let handle: UploadHandle;
  try {
    handle = putAttachmentBytes(
      session.uploadUrl,
      picked.uri,
      draft.mime,
      fraction =>
        update(key, list => progressUpload(list, draft.localId, fraction)),
    );
  } catch {
    update(key, list => failUpload(list, draft.localId, 'unavailable'));
    return;
  }
  inflight.set(draft.localId, handle);
  const result = await handle.done;
  inflight.delete(draft.localId);

  if (!result.ok) {
    if (result.failure === 'aborted') {
      update(key, list => rewindUpload(list, draft.localId));
      return;
    }
    update(key, list =>
      failUpload(
        list,
        draft.localId,
        result.failure === 'status' && result.status !== undefined
          ? issueForStatus(result.status)
          : 'unavailable',
      ),
    );
    return;
  }

  update(key, list => verifyUpload(list, draft.localId));
  try {
    const row = await completeAttachmentUpload(
      target.workspaceId,
      target.channelId,
      session.id,
    );
    update(key, list => completeUpload(list, draft.localId, row.id));
  } catch (error: unknown) {
    update(key, list =>
      failUpload(
        list,
        draft.localId,
        error instanceof ApiError
          ? issueForStatus(error.status)
          : 'unavailable',
      ),
    );
  }
}

async function pump(key: string, target: AttachmentTarget): Promise<void> {
  if (pumping.has(key)) return;
  pumping.add(key);
  try {
    for (;;) {
      const next = read(key).drafts.find(draft => draft.status === 'ready');
      if (next === undefined) return;
      await uploadOne(key, target, next);
    }
  } finally {
    pumping.delete(key);
  }
}

export function setPickerIssue(key: string, issue: UploadIssue | null): void {
  const surface = read(key);
  write(key, {...surface, pickerIssue: issue});
}

export function addPickedFiles(
  key: string,
  target: AttachmentTarget,
  picked: PickedAttachmentFile[],
): void {
  if (picked.length === 0) return;
  const incoming = picked.map(file => {
    const localId = crypto.randomUUID();
    files.set(localId, file);
    return draftFor(localId, file);
  });
  const surface = read(key);
  const admitted = admitDrafts(surface.drafts, incoming);
  const acceptedIds = new Set(admitted.next.map(draft => draft.localId));
  for (const draft of incoming) {
    if (!acceptedIds.has(draft.localId)) files.delete(draft.localId);
  }
  write(key, {drafts: admitted.next, pickerIssue: null});
  void pump(key, target);
}

export function retryDraft(
  key: string,
  target: AttachmentTarget,
  localId: string,
): void {
  update(key, list => requeueUpload(list, localId));
  void pump(key, target);
}

export function dropDraft(key: string, localId: string): void {
  inflight.get(localId)?.abort();
  inflight.delete(localId);
  files.delete(localId);
  update(key, list => removeDraftFrom(list, localId));
}

export function clearSurface(key: string): void {
  for (const draft of read(key).drafts) {
    inflight.get(draft.localId)?.abort();
    inflight.delete(draft.localId);
    files.delete(draft.localId);
  }
  write(key, EMPTY);
}

/** 전송 payload와 낙관적 echo가 함께 쓰는 완료 메타데이터를 꺼낸다. */
export function takeSent(key: string): {attachments: MessageAttachment[]} {
  const drafts = read(key).drafts;
  const attachments = sentAttachmentsOf(drafts);
  for (const draft of drafts) files.delete(draft.localId);
  write(key, EMPTY);
  return {attachments};
}

export function resetAttachmentDraftsForTest(): void {
  for (const handle of inflight.values()) handle.abort();
  inflight.clear();
  files.clear();
  pumping.clear();
  emit(new Map());
}
