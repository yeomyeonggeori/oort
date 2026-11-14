import {useSyncExternalStore} from 'react';

import {
  admitDrafts,
  beginUpload,
  completeUpload,
  draftFor,
  failUpload,
  INLINE_PREVIEW_MAX_BYTES,
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
import {declareImageSize} from '@momo/core/features/attachments/declareImageSize';
import {
  completeAttachmentUpload,
  createAttachmentUpload,
} from '@momo/core/lib/api';
import {canDeclareImageSize} from '@momo/core/lib/attachmentMedia';
import {
  verdictForRequestFailure,
  verdictForTransferFailure,
} from '@momo/core/features/connection/uploadFailure';
import {deviceOnlineNow} from '../connection/deviceOnline';

import {measurePickedImage, type ImageSize} from './imageSize';
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
const pumping = new Map<string, number>();
const listeners = new Set<() => void>();
// 로그아웃 뒤 도착한 create/complete 응답이 새 계정의 bearer로 이어지지 않게 한다.
// reset 때마다 증가하고, 비동기 경계마다 시작 세대와 대조한다.
let sessionGeneration = 0;

/** 고른 로컬 이미지의 주소. 칩 썸네일이 쓴다(없으면 아이콘). */
export function draftPickedUri(localId: string): string | undefined {
  return files.get(localId)?.uri;
}

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
  generation: number,
): Promise<void> {
  const picked = files.get(draft.localId);
  if (picked === undefined) {
    update(key, list => failUpload(list, draft.localId, 'unavailable'));
    return;
  }
  update(key, list => beginUpload(list, draft.localId));
  // 사진·GIF 의 표시 크기는 올리는 동안 재 둔다(ADR-0151 증보 9 I7): 업로드가 끝날 때쯤 답이 이미 있어서 아래 선언이 기다리지 않는다.
  // **받는 쪽이 인라인 그림으로 그리는 사진만** 잰다: 닫힌 목록(JPEG·PNG·GIF·WebP) 안이고 인라인 미리보기 한도(`INLINE_PREVIEW_MAX_BYTES`, 받는 쪽
  // `showsInlinePreview` 와 같은 한도) 이하여야 한다. 그 위의 큰 사진은 받는 쪽이 파일 카드로 그리므로 아무도 안 그리는 칸을 재자고 디코드하지도,
  // 선언을 보내지도 않는다. 어떤 실패도 던지지 않는다(`null`).
  const measuring: Promise<ImageSize | null> | null =
    canDeclareImageSize(draft.mime) && draft.sizeBytes <= INLINE_PREVIEW_MAX_BYTES
      ? measurePickedImage(picked.uri, draft.mime)
      : null;

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
    if (generation !== sessionGeneration) return;
    // 상태 코드가 아니라 분류로 말한다(#5222): 닿지 못함(오프라인 · 서버에 닿지 못함)이면 보관소 이야기를 하지 않고 그 원인으로, 칩은 「다시 올리기」다.
    const verdict = verdictForRequestFailure(error, deviceOnlineNow());
    update(key, list =>
      failUpload(list, draft.localId, verdict.issue, verdict.cause),
    );
    return;
  }

  // `create upload`은 abort 가능한 native PUT보다 먼저다. 로그아웃이 그 왕복 중에
  // 일어나면 구 bearer로 발급된 session.id를 새 계정에서 절대 소비하지 않는다.
  if (generation !== sessionGeneration) return;

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

  if (generation !== sessionGeneration) return;

  if (!result.ok) {
    if (result.failure === 'aborted') {
      update(key, list => rewindUpload(list, draft.localId));
      return;
    }
    const verdict = verdictForTransferFailure(
      result.failure,
      result.status,
      deviceOnlineNow(),
    );
    update(key, list =>
      failUpload(list, draft.localId, verdict.issue, verdict.cause),
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
    if (generation !== sessionGeneration) return;
    // **보내기 가능으로 바꾸기 전에** 가로세로를 선언한다(ADR-0151 증보 9 I7): 서버는 아직 메시지에 안 묶인 첨부에만 쓰므로, 바꾼 뒤에
    // 부르면 빠른 전송이 먼저 묶어 이 호출이 조용히 404 가 된다. 덤이다 — 던지지 않고(코어 `declareImageSize`), 예산이 넘으면 기다리기를
    // 그만두며, 실패해도 사진은 요약 없이 간다. 아래 `catch {}` 는 그 약속이 어떤 사정으로도 깨지지 않게 하는 자리다: 선언 때문에 올리기가
    // 「실패」가 되는 일은 없다.
    // 크기를 모르고 올린 파일(`sizeKnown: false`)은 완료가 돌려준 **실제 크기**(`row.size`)로 한 번 더 한도를 본다.
    if (measuring !== null && row.size <= INLINE_PREVIEW_MAX_BYTES) {
      try {
        await declareImageSize({
          workspaceId: target.workspaceId,
          channelId: target.channelId,
          attachmentId: row.id,
          mime: draft.mime,
          measure: () => measuring,
        });
      } catch {
        // 선언은 덤이다.
      }
    }
    // 그 사이 로그아웃했으면 옛 계정의 초안을 새 계정 표면에서 「끝남」으로 바꾸지 않는다(위 `complete` 뒤와 같은 자물쇠).
    if (generation !== sessionGeneration) return;
    update(key, list => completeUpload(list, draft.localId, row.id));
  } catch (error: unknown) {
    if (generation !== sessionGeneration) return;
    const verdict = verdictForRequestFailure(error, deviceOnlineNow());
    update(key, list =>
      failUpload(list, draft.localId, verdict.issue, verdict.cause),
    );
  }
}

async function pump(key: string, target: AttachmentTarget): Promise<void> {
  const generation = sessionGeneration;
  if (pumping.get(key) === generation) return;
  pumping.set(key, generation);
  try {
    for (;;) {
      if (generation !== sessionGeneration) return;
      const next = read(key).drafts.find(draft => draft.status === 'ready');
      if (next === undefined) return;
      await uploadOne(key, target, next, generation);
    }
  } finally {
    // reset 뒤 같은 surface에서 새 계정 pump가 시작됐을 수 있다. 옛 finally가 새
    // 자물쇠를 지우지 않는다.
    if (pumping.get(key) === generation) pumping.delete(key);
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
  // 현재 picker는 한 번에 한 건이고, Composer는 20개에서 진입점을 잠근다. 따라서
  // rejected는 도달 불가 불변식이다. 향후 multiple picker가 들어오며 이 경계를
  // 바꾸려면 웹처럼 거절 개수를 말하는 UI를 먼저 만들어야 한다. 그 전에는 일부만
  // 말없이 받아 사람이 전부 붙었다고 믿게 하지 않는다 (#1703 Nit-3).
  if (admitted.rejected !== 0) {
    for (const draft of incoming) files.delete(draft.localId);
    throw new Error(
      'attachment picker invariant: rejected files need a visible notice',
    );
  }
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

/**
 * 한 대화의 첨부 트레이를 모두 비운다 — 대화 입력칸과 그 대화의 스레드 입력칸(열쇠 `워크스페이스|채널|뿌리`). 1:1 대화 나가기
 * (ADR-0177 증보 2026-11-14 D17 기기 줄) 뒤에 부른다. 다른 대화의 트레이는 건드리지 않는다.
 */
export function clearChannelSurfaces(workspaceId: string, channelId: string): void {
  const prefix = `${workspaceId}|${channelId}|`.toLowerCase();
  for (const key of [...surfaces.keys()]) {
    if (key.toLowerCase().startsWith(prefix)) clearSurface(key);
  }
}

/** 전송 payload와 낙관적 echo가 함께 쓰는 완료 메타데이터를 꺼낸다. */
export function takeSent(key: string): {attachments: MessageAttachment[]} {
  const drafts = read(key).drafts;
  const attachments = sentAttachmentsOf(drafts);
  for (const draft of drafts) files.delete(draft.localId);
  write(key, EMPTY);
  return {attachments};
}

/**
 * 인증 세션 경계의 첨부 청소. 모든 surface와 native PUT을 한 번에 끝낸다.
 *
 * `resetAttachmentDraftsForTest`와 달리 제품 코드가 부르는 공개 수명주기 훅이다.
 */
export function clearAllAttachmentDrafts(): void {
  sessionGeneration += 1;
  for (const handle of inflight.values()) handle.abort();
  inflight.clear();
  files.clear();
  pumping.clear();
  emit(new Map());
}

export function resetAttachmentDraftsForTest(): void {
  clearAllAttachmentDrafts();
}
