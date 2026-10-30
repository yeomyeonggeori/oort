import {
  ApiError,
  completeAttachmentUpload,
  createAttachmentUpload,
  openDirectMessage,
  sendMessage,
  type Channel,
} from "@momo/core/lib/api";
import { issueForStatus } from "@momo/core/features/attachments/model";
import { putAttachmentBytes, type UploadHandle, type UploadResult } from "@/features/attachments/uploadTransport";

// =============================================================================
// 「AI와 만들기」 요청을 보내는 순서 (#4820 B).
//
// 새 업로드·전송 길이 없다. 이미 있는 것을 이 순서로 부를 뿐이다:
//   1. openDirectMessage          그 에이전트와의 DM을 연다(쌍마다 멱등).
//   2. createAttachmentUpload → putAttachmentBytes → completeAttachmentUpload
//                                 컴포저 트레이(attachments/draftStore)가 쓰는 세 왕복 그대로.
//                                 PUT 은 베어러를 싣지 않고 CSP 감지를 하는 유일한 길이다.
//   3. sendMessage                본문과 첨부를 한 메시지로. clientMsgId 멱등.
//
// 다시 시도는 실패한 단계에서 이어 간다: 이미 연 DM과 올린 첨부를 다시 만들지 않고,
// 보내기를 다시 해도 같은 clientMsgId 라서 서버가 메시지를 하나만 만든다. 입력이 바뀌면
// 바뀐 만큼만 새로 한다(resumeAttempt).
// =============================================================================

export type MakeStep = "dm" | "upload" | "send";

export interface MakeAttempt {
  readonly agentId: string;
  file: File;
  body: string;
  clientMsgId: string;
  channel?: Channel;
  attachmentId?: string;
  /** 보내기 요청이 한 번이라도 나갔는가. 나갔다면 그 첨부는 이미 메시지에 묶였을 수 있다. */
  sendStarted: boolean;
}

export interface MakeInput {
  agentId: string;
  file: File;
  body: string;
}

/** 이전 시도에서 이어 갈 것과 새로 할 것을 가른다. */
export function resumeAttempt(prev: MakeAttempt | null, input: MakeInput, newId: () => string = () => crypto.randomUUID()): MakeAttempt {
  // 다른 에이전트는 다른 DM이고, 첨부는 대화에 묶여 있으므로 처음부터 한다.
  if (prev === null || prev.agentId !== input.agentId) {
    return { agentId: input.agentId, file: input.file, body: input.body, clientMsgId: newId(), sendStarted: false };
  }
  // 다른 사진: 다시 올리고 새 메시지다.
  if (prev.file !== input.file) {
    return { agentId: prev.agentId, file: input.file, body: input.body, clientMsgId: newId(), channel: prev.channel, sendStarted: false };
  }
  // 같은 사진, 다른 본문: 새 메시지다. 앞선 보내기가 나갔다면 그 첨부는 이미 묶였을 수 있어 다시 올린다.
  if (prev.body !== input.body) {
    return { agentId: prev.agentId, file: prev.file, body: input.body, clientMsgId: newId(), channel: prev.channel, attachmentId: prev.sendStarted ? undefined : prev.attachmentId, sendStarted: false };
  }
  return prev;
}

/** 이 칸이 실패했다는 사실과 원인. 한 줄 문구는 makeFailureLine 이 만든다. */
export class MakeStepError extends Error {
  readonly step: MakeStep;
  readonly cause: unknown;
  constructor(step: MakeStep, cause: unknown) {
    super(`make request failed at ${step}`);
    this.name = "MakeStepError";
    this.step = step;
    this.cause = cause;
  }
}

/** PUT 이 끝나지 못했다. `status` 는 상대가 답한 코드. */
class UploadFailed extends Error {
  readonly failure: UploadResult["failure"];
  readonly status: number | undefined;
  constructor(result: UploadResult) {
    super("attachment bytes were not accepted");
    this.name = "UploadFailed";
    this.failure = result.failure;
    this.status = result.status;
  }
}

export interface MakeRunHooks {
  step: (step: MakeStep) => void;
  /** 올리는 중인 PUT. 화면이 닫히면 호출부가 abort 한다. 끝나면 null. */
  uploading: (handle: UploadHandle | null) => void;
  cancelled: () => boolean;
}

/** 이어 갈 수 있는 곳부터 끝까지. 화면이 사라졌으면 "cancelled", 실패하면 MakeStepError. */
export async function runMakeAttempt(workspaceId: string, attempt: MakeAttempt, hooks: MakeRunHooks): Promise<{ channel: Channel } | "cancelled"> {
  if (attempt.channel === undefined) {
    hooks.step("dm");
    try {
      attempt.channel = (await openDirectMessage(workspaceId, attempt.agentId)).channel;
    } catch (cause) {
      throw new MakeStepError("dm", cause);
    }
    if (hooks.cancelled()) return "cancelled";
  }
  const channel = attempt.channel;
  let attachmentId = attempt.attachmentId;
  if (attachmentId === undefined) {
    hooks.step("upload");
    try {
      const { file } = attempt;
      const session = await createAttachmentUpload(workspaceId, channel.id, { name: file.name, mime: file.type, size: file.size });
      if (hooks.cancelled()) return "cancelled";
      const handle = putAttachmentBytes(session.uploadUrl, file, file.type, () => {});
      hooks.uploading(handle);
      const result = await handle.done;
      hooks.uploading(null);
      if (!result.ok) {
        if (result.failure === "aborted") return "cancelled";
        throw new UploadFailed(result);
      }
      attachmentId = (await completeAttachmentUpload(workspaceId, channel.id, session.id)).id;
      attempt.attachmentId = attachmentId;
    } catch (cause) {
      throw new MakeStepError("upload", cause);
    }
    if (hooks.cancelled()) return "cancelled";
  }
  hooks.step("send");
  attempt.sendStarted = true;
  try {
    await sendMessage(workspaceId, channel.id, attempt.clientMsgId, attempt.body, { attachmentIds: [attachmentId] });
  } catch (cause) {
    throw new MakeStepError("send", cause);
  }
  return { channel };
}

function statusOf(cause: unknown): number | undefined {
  if (cause instanceof ApiError) return cause.status;
  if (cause instanceof UploadFailed) return cause.status;
  return undefined;
}

/** 단계별 한 줄: 무슨 일이 있었고 다음에 무엇을 하면 되는가. 영구적인 원인은 그대로 말한다. */
export function makeFailureLine(step: MakeStep, cause: unknown): string {
  const status = statusOf(cause);
  if (step === "dm") {
    if (status === 403) return "이 워크스페이스에서 에이전트와 대화를 열 권한이 없어요. 관리자에게 문의해 주세요.";
    if (status === 404) return "이 에이전트를 찾을 수 없어요. 목록을 다시 불러온 뒤 골라 주세요.";
    return "에이전트와 대화를 열지 못했어요. 연결을 확인하고 다시 시도해 주세요.";
  }
  if (step === "upload") {
    if (cause instanceof UploadFailed && cause.failure === "blocked") return "이 서버의 보안 설정이 파일 보관소 주소를 막았어요. 서버 관리자에게 알려 주세요.";
    switch (status === undefined ? null : issueForStatus(status)) {
      case "too-large":
        return "사진이 너무 커서 올리지 못했어요. 더 작은 사진을 골라 주세요.";
      case "forbidden":
        return "이 대화에는 파일을 올릴 수 없어요. 관리자에게 문의해 주세요.";
      case "no-archive":
        return "파일 보관소가 연결되어 있지 않아 사진을 올릴 수 없어요. 서버 관리자에게 알려 주세요.";
      default:
        return "사진을 올리지 못했어요. 연결을 확인하고 다시 시도해 주세요.";
    }
  }
  return "요청을 보내지 못했어요. 연결을 확인하고 다시 시도해 주세요.";
}
