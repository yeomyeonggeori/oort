// =============================================================================
// 첨부 v0 — 도메인 절반 (ADR-0151 D2, #1202 첨부 축).
//
// 이 파일에는 파일 자체가 없다. `File`도 `XMLHttpRequest`도 없고, 바이트를 만지는
// 코드는 한 줄도 없다 — 그쪽 절반은 `clients/web/src/features/attachments/`가
// 진다(코어 순수성 게이트, ADR-0137 D3). 여기 사는 것은 **어떤 상태에서 어떤
// 상태로 갈 수 있는가**와 **그 상태를 화면에서 뭐라고 부르는가** 둘뿐이고, 두
// 질문의 답은 macOS 클라(`MomoComposerActionLauncher.swift:72-83`,
// `MessageListView.swift:1424-1444`)가 이미 골라 뒀다. 그 선택을 베끼지 않고
// 계승한다.
//
// ## 계승한 것 — 상태 전이
//
// macOS `MomoAttachmentDraft.State`:
//
//   ready ──▶ uploading ──▶ uploaded(attachment)
//                   │
//                   ├──▶ failed(fileTooLarge | unavailable)
//                   └──▶ ready            (취소는 실패가 아니다)
//
//   uploaded → uploaded  (멱등: 이미 올라간 것을 다시 올리지 않는다)
//   failed   → uploading (재시도는 같은 문으로 다시 들어간다)
//
// ## 늘린 것 하나 — `verifying`
//
// macOS에는 없는 칸이 하나 있다. 이유는 웹에만 있는 거짓말 하나 때문이다.
//
// 브라우저에서 진행률을 재는 유일한 방법은 `XMLHttpRequest.upload.onprogress`고,
// 그것이 세는 것은 **소켓에 건넨 바이트**다. 100 MB짜리 마지막 청크를 건넨 순간
// 그 수는 100%가 되지만, 그때 서버는 아직 Drive에게 "네가 받은 것이 이 사람이
// 말한 그 파일이 맞나"를 묻지도 않았다(`POST …/complete`가 크기·mime·file id
// 세 가지를 대조한다 — `routes/attachments.rs:246-250`). 그 왕복 동안 100%를
// 띄워 두면 화면은 끝나지 않은 일을 끝났다고 말한다.
//
// 그래서 진행률이 다 찬 자리와 완료 사이에 칸을 하나 둔다. 퍼센트가 아니라
// 문장이고, 그 문장이 하는 일은 "바이트는 갔고 아직 확인 중"이라는 참말이다.
//
// ## 계승한 것 — 경계
//
// 크기 100 MB·개수 20은 서버가 이미 아는 값이다(`attachment.rs:50,53`, openapi
// `maximum: 104857600` / `maxItems: 20`). 여기서 다시 세는 이유는 서버를 믿지
// 않아서가 아니라, **고른 순간에 말해 주기 위해서**다: 100 MB짜리를 골라 놓고
// 업로드가 다 끝난 뒤 413을 받는 것은 같은 사실을 가장 비싸게 배우는 길이다.
// 판정은 여전히 서버의 것이고, 이쪽은 그 판정을 앞당겨 말할 뿐이다.
// =============================================================================

import type { MessageAttachment } from "../../lib/api";

export type { MessageAttachment };

/** 서버가 받는 최대 크기 (`momo-messaging::attachment::MAX_ATTACHMENT_BYTES`). */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** 한 메시지에 묶을 수 있는 최대 개수 (`MAX_ATTACHMENTS_PER_MESSAGE`). */
export const MAX_ATTACHMENTS_PER_MESSAGE = 20;

/**
 * 인라인 미리보기를 여는 이미지의 상한.
 *
 * 프록시로 받은 바이트는 `data:` URL이 되어야 화면에 걸린다 — 배포된 CSP가
 * `img-src 'self' data:`라서 `blob:`은 그려지지 않고, 프록시는 베어러를 요구하니
 * `<img src="/v1/…">`도 안 된다. base64는 원본의 약 1.33배를 문자열로 들고 있게
 * 되므로, 그 비용을 무한정 물 수는 없다.
 *
 * 넘는 이미지는 미리보기 대신 파일 카드로 선다. 잘린 미리보기나 영원히 도는
 * 스피너보다 "이건 카드다"가 참말이다.
 */
export const INLINE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 업로드가 실패한 이유, 화면이 구분할 수 있는 만큼만.
 *
 * macOS는 `fileTooLarge`와 `unavailable` 둘로 접었다(`UploadIssue`). 그 둘은
 * 그대로 두고 셋을 더한다 — 셋 다 **사람이 할 수 있는 다음 행동이 다르기**
 * 때문이고, 그것이 이 앱이 오류 문장에 요구하는 것이다(design-taste-web §5:
 * 무슨 일이 있었는가 + 다음에 무엇을 하는가).
 *
 *   too-large   → 다른 파일을 고른다        (재시도는 의미가 없다)
 *   forbidden   → 이 방에서는 못 한다        (재시도는 의미가 없다)
 *   no-archive  → 관리자에게 알린다          (재시도는 의미가 없다)
 *   mismatch    → 다시 올린다               (재시도가 정답이다)
 *   blocked     → 배포 설정을 고친다         (재시도는 의미가 없다)
 *   unavailable → 다시 올린다               (재시도가 정답이다)
 */
export type UploadIssue =
  | "too-large"
  | "forbidden"
  | "no-archive"
  | "mismatch"
  | "blocked"
  | "unavailable";

/**
 * 컴포저가 들고 있는 한 건.
 *
 * `localId`는 이 브라우저 안에서만 사는 이름이다. 서버가 주는 `attachment.id`는
 * `uploads`가 답한 뒤에야 생기고, 그 전에도 칩은 화면에 서 있어야 한다.
 */
export interface AttachmentDraft {
  localId: string;
  name: string;
  mime: string;
  sizeBytes: number;
  status: DraftStatus;
  /** 0..1. `uploading`에서만 뜻이 있고, 그 밖에서는 읽지 않는다. */
  progress: number;
  /** `verifying` 이후에만 있다. 전송이 서버에 넘기는 것이 이 값이다. */
  attachmentId?: string;
  /** `failed`에서만 있다. */
  issue?: UploadIssue;
}

export type DraftStatus =
  | "ready"
  | "uploading"
  | "verifying"
  | "uploaded"
  | "failed";

// ---- 문구 (macOS `MomoComposerActionLauncher.swift:130-150` 계승) ------------
//
// 값이 코어에 있는 이유는 이 레포가 이미 그 길을 깔아 뒀기 때문이다
// (`composerCopy.ts`, `actionCopy.ts`): 같은 문장을 두 클라가 각자 적으면 같은
// 주에 갈라진다. 갈라진 뒤에 리뷰가 그것을 실측한 전례가 있다(U4-6 H-1).

export const ATTACH_COPY = {
  /** 클립 버튼의 접근성 이름 (macOS `fileUpload`). */
  attach: "파일 첨부",
  /** 트레이의 제목 (macOS `localDraft`). */
  tray: "첨부 파일",
  // macOS 의 `connectionPending`("전송할 때 채널에 업로드합니다. 파일당 최대
  // 100MB입니다.")은 여기 없다. 앞절이 웹에서 거짓이기 때문이다 — 이 클라는
  // 고르는 즉시 올린다(그래야 진행률을 잴 수 있고 전송이 즉시 끝난다). 뒷절인
  // 상한 고지만 남길 수도 있었지만, 상한은 **걸렸을 때** 말한다(`too-large`):
  // 판정이 로컬이라 왕복 비용이 0이고, 컴포저 위에 늘 서 있는 안내 한 줄은
  // 이 앱이 밀어내는 종류의 상시 소음이다.
  /** 앞 파일이 끝나기를 기다리는 중. macOS `localOnlyStatus`가 선 자리다. */
  queued: "대기 중",
  /** 바이트가 아직 가는 중 (macOS `uploading`). */
  uploading: "업로드 중",
  /** 바이트는 갔고 서버가 대조 중. macOS에 대응이 없는 칸이다. */
  verifying: "확인 중",
  /** 올라갔고 묶을 수 있다 (macOS `uploaded`). */
  uploaded: "업로드 완료",
  /** 한 건 제거 (macOS `remove`). */
  remove: "첨부 제거",
  /** 전부 제거 (macOS `clearAll`). */
  clearAll: "모두 지우기",
  /** 실패한 건 다시 (macOS `retryUpload`). */
  retry: "다시 시도",
  /** 타임라인 카드의 내려받기 (macOS `downloadAttachment`). */
  download: "첨부파일 내려받기",
  /** 그 내려받기가 진행 중. 바쁜 버튼은 비활성 버튼이 아니다(tokens.md §5b). */
  downloading: "내려받는 중",
  /** 내려받기가 실패했다 (macOS `attachmentDownloadFailed`). */
  downloadFailed: "내려받기 실패",
  /** 미리보기를 여는 중 */
  previewLoading: "미리보기 불러오는 중",
  /** 미리보기를 못 열었다. 파일 자체는 멀쩡할 수 있으므로 카드는 남는다. */
  previewFailed: "미리보기를 불러오지 못했습니다",
  /** 업로드가 끝나기 전에는 보내지 않는다. */
  sendBlocked: "업로드가 끝나면 보낼 수 있습니다.",
  /**
   * 실패한 첨부를 달고 보낼 수는 없다 — **다시 눌러 볼 값이 있을 때**.
   *
   * 두 문장인 이유는 리뷰 M-1 이다. 앞 판은 어느 실패에나 "다시 시도한 뒤"라고
   * 말했는데, 6종 중 3종은 재시도 버튼이 서지도 않는다(`isRetryableIssue`).
   * 그러면 이 줄은 화면에 없는 버튼을 가리키는 안내가 된다.
   */
  sendBlockedRetryable: "실패한 첨부를 다시 시도하거나 지운 뒤 보낼 수 있습니다.",
  /** 되돌릴 값이 없는 실패만 남았을 때. 남은 행동은 제거뿐이다. */
  sendBlockedFailed: "실패한 첨부를 지운 뒤 보낼 수 있습니다.",
  /** 드롭이 폴더를 받았다. 폴더는 첨부가 아니다. */
  folderRejected: "폴더는 붙일 수 없습니다. 안에 있는 파일을 골라 주세요.",
} as const;

/**
 * 실패 한 건의 문장. macOS의 두 문장은 글자 그대로 남아 있다
 * (`fileTooLarge` = "100MB를 초과함", `unavailable` = "업로드 실패").
 *
 * `mismatch` 에서 "다시 시도하세요"를 뺐다 (리뷰 H-4): 그 실패에는 「다시 시도」
 * 버튼이 **바로 옆에** 서고 트레이 발치도 같은 말을 하므로, 두 줄에 같은 동사가
 * 세 번 찍혔다. 지시는 컨트롤이 하고 이 문장은 사실만 말한다.
 */
export function uploadIssueCopy(issue: UploadIssue): string {
  switch (issue) {
    case "too-large":
      return "100MB를 초과함";
    case "forbidden":
      return "이 채널에 파일을 올릴 수 없습니다";
    case "no-archive":
      return "파일 보관소가 연결돼 있지 않습니다";
    case "mismatch":
      return "올라간 파일이 고른 파일과 다릅니다";
    case "blocked":
      return "이 배포의 보안 정책이 보관소 주소를 막았습니다";
    case "unavailable":
      return "업로드 실패";
  }
}

/**
 * 그래서 이 사람이 지금 할 수 있는 것 (리뷰 M-1).
 *
 * 재시도가 서는 실패에는 없다 — 그 버튼이 곧 다음 행동이고, 옆에 문장으로 또
 * 적으면 같은 지시가 두 번이 된다(H-4 가 잡은 그 반복). 재시도가 **안 서는**
 * 셋에만 있고, 값은 `UploadIssue` 독스트링이 이미 알고 있던 것을 화면까지
 * 옮긴 것이다.
 */
export function uploadIssueNext(issue: UploadIssue): string | null {
  switch (issue) {
    case "too-large":
      return "더 작은 파일을 고르세요";
    case "forbidden":
      return "채널 관리자에게 문의하세요";
    case "no-archive":
      return "서버 관리자에게 알리세요";
    case "blocked":
      return "서버 설정을 확인하세요";
    case "mismatch":
    case "unavailable":
      return null;
  }
}

/** 다시 눌러 볼 값이 있는 실패인가. 없으면 재시도 버튼을 그리지 않는다. */
export function isRetryableIssue(issue: UploadIssue): boolean {
  return issue === "mismatch" || issue === "unavailable";
}

/**
 * 이 칸을 부르는 **낱말** 하나. 퍼센트도 크기도 없다.
 *
 * 낭독(`draftAnnouncement`)이 읽는 것이 이것이고, 그래서 진행률이 움직이는 동안
 * 이 값은 바뀌지 않는다 — 보조기술이 초당 몇 번씩 같은 줄을 다시 읽지 않는 이유가
 * 여기 있다(리뷰 H-3).
 */
export function draftStatusWord(draft: AttachmentDraft): string {
  switch (draft.status) {
    case "ready":
      return ATTACH_COPY.queued;
    case "uploading":
      return ATTACH_COPY.uploading;
    case "verifying":
      return ATTACH_COPY.verifying;
    case "uploaded":
      return ATTACH_COPY.uploaded;
    case "failed": {
      const issue = draft.issue ?? "unavailable";
      const next = uploadIssueNext(issue);
      const reason = uploadIssueCopy(issue);
      return `${reason}${next === null ? "" : `. ${next}`}`;
    }
  }
}

/**
 * 칩 아래 한 줄. **크기가 항상 앞에 온다** (리뷰 M-7).
 *
 * 앞 판은 업로드가 **끝난 뒤에야** 크기를 말했다. 그래서 오래 걸리는 업로드를
 * 보면서 "이게 몇 MB짜리였지"를 확인할 방법이 화면에 없었다 — 크기가 가장
 * 궁금한 순간은 정확히 기다리는 동안이다.
 *
 * 퍼센트도 여기 산다 (리뷰 N-B). 앞 판은 그것을 **이름 옆**에 놓았고, 그래서 첫
 * 측정에 나타나고 「확인 중」에 사라질 때마다 이름 열의 폭이 320px 기준 36px 씩
 * 두 번 바뀌었다 — 파일명이 잘렸다 풀렸다 한다. 아래 줄에 두면 이름 열은 칩이
 * 사는 내내 같은 폭이다.
 */
export function draftStatusLine(draft: AttachmentDraft): {
  text: string;
  danger: boolean;
  /** 잰 값이 있을 때만. 없으면 화면도 낭독도 수를 말하지 않는다. */
  percent: number | null;
} {
  const size = formatBytes(draft.sizeBytes);
  const word = draftStatusWord(draft);
  const percent =
    draft.status === "uploading" && draft.progress > 0
      ? Math.round(draft.progress * 100)
      : null;
  return {
    text: `${size} · ${word}`,
    danger: draft.status === "failed",
    percent,
  };
}

/** 이 칩이 지금 어느 칸에 있는가, 낭독이 구분해야 하는 만큼만. */
function statusKey(draft: AttachmentDraft): string {
  return `${draft.status}:${draft.issue ?? ""}`;
}

/**
 * 보조기술이 듣는 한 줄 (리뷰 H-3, 그리고 그 수리가 만든 M-A).
 *
 * 칩의 상태 문장에 live region 을 붙이면 진행률이 바뀔 때마다 초당 몇 번씩
 * 낭독된다. 그래서 낱말만 싣는 줄을 따로 뒀는데, 1차 수리는 그 줄에 **목록
 * 전체**를 이어 붙였다. 텍스트 노드가 하나라 한 칩이 바뀔 때마다 20줄이 통째로
 * 다시 읽힌다 — 퍼센트 소음을 피한 자리에서 다른 축의 같은 소음이었다.
 *
 * 그래서 이 함수는 **바뀐 것만** 말한다. 앞 상태를 받아 낱말이 달라진 칩을
 * 골라내고, 아무것도 안 바뀌었으면 `null` 을 돌려준다 — 호출부가 그때 텍스트를
 * 그대로 두면 보조기술은 아무것도 다시 읽지 않는다.
 *
 * 여럿이 한꺼번에 바뀌는 경우는 실제로 둘뿐이다: 여러 개를 한 번에 고른 순간
 * (전부 「대기 중」)과 그것들이 차례로 끝나는 흐름(한 번에 하나). 그래서 같은
 * 낱말로 묶이면 개수로 요약하고, 섞이면 개수만 말한다.
 */
export function draftAnnouncement(
  previous: AttachmentDraft[],
  next: AttachmentDraft[]
): string | null {
  const before = new Map(previous.map((draft) => [draft.localId, statusKey(draft)]));
  const changed = next.filter(
    (draft) => before.get(draft.localId) !== statusKey(draft)
  );
  if (changed.length === 0) return null;
  if (changed.length === 1) {
    const draft = changed[0];
    return `${draft.name} ${formatBytes(draft.sizeBytes)} · ${draftStatusWord(draft)}`;
  }
  // 낱말별로 묶어 개수로 말한다. 「N개 상태가 바뀌었습니다」 같은 요약은 짧지만
  // 아무것도 말하지 않는다 — 무엇이 몇 개인지가 이 줄의 전부다.
  const counts = new Map<string, number>();
  for (const draft of changed) {
    const word = draftStatusWord(draft);
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  const groups = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([word, count], index) =>
      index === 0
        ? `${ATTACH_COPY.tray} ${count}개 ${word}`
        : `${count}개 ${word}`
    );
  return groups.join(", ");
}

/**
 * 서버가 답한 상태 코드 → 실패 이유.
 *
 * 400은 이름/mime/크기 어느 쪽이든 "이 파일로는 안 된다"이고, 크기만 별도
 * 코드(413)를 갖는다. 502는 Drive가 momo의 서비스 계정을 거절한 것이라
 * 사람에게는 보관소가 없는 것과 구분되지 않는다(`routes/attachments.rs:63-79`).
 */
export function issueForStatus(status: number): UploadIssue {
  if (status === 413 || status === 400) return "too-large";
  if (status === 403) return "forbidden";
  if (status === 503 || status === 502) return "no-archive";
  if (status === 409) return "mismatch";
  return "unavailable";
}

// ---- 전이 (순수) ------------------------------------------------------------

/** 고른 파일 하나 → 처음의 칸. 상한을 넘으면 올려 보지도 않는다. */
export function draftFor(
  localId: string,
  file: { name: string; mime: string; sizeBytes: number }
): AttachmentDraft {
  const tooLarge = file.sizeBytes > MAX_ATTACHMENT_BYTES;
  return {
    localId,
    name: file.name,
    mime: file.mime,
    sizeBytes: file.sizeBytes,
    status: tooLarge ? "failed" : "ready",
    progress: 0,
    ...(tooLarge ? { issue: "too-large" as const } : {}),
  };
}

/**
 * 자리가 남은 만큼만 받는다. macOS `merging`(:116)과 같은 규칙이되 **버린 개수를
 * 돌려준다**: macOS는 넘친 파일을 말없이 떨궜고, 말없이 사라진 파일은 사용자가
 * 보낸 줄 아는 파일이다.
 */
export function admitDrafts(
  list: AttachmentDraft[],
  incoming: AttachmentDraft[]
): { next: AttachmentDraft[]; rejected: number } {
  const room = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - list.length);
  const admitted = incoming.slice(0, room);
  return {
    next: admitted.length === 0 ? list : [...list, ...admitted],
    rejected: incoming.length - admitted.length,
  };
}

function mapDraft(
  list: AttachmentDraft[],
  localId: string,
  fn: (draft: AttachmentDraft) => AttachmentDraft
): AttachmentDraft[] {
  return list.map((draft) => (draft.localId === localId ? fn(draft) : draft));
}

/** ready|failed → uploading. 이미 올라간 것은 건드리지 않는다(멱등). */
export function beginUpload(
  list: AttachmentDraft[],
  localId: string
): AttachmentDraft[] {
  return mapDraft(list, localId, (draft) => {
    if (draft.status === "uploaded" || draft.status === "verifying") return draft;
    const { issue: _issue, ...rest } = draft;
    return { ...rest, status: "uploading", progress: 0 };
  });
}

/**
 * 진행률. **뒤로 가지 않는다** — XHR은 재전송 시 0부터 다시 세는 이벤트를 보낼
 * 수 있고, 줄어드는 막대는 사람에게 "실패했나"로 읽힌다.
 */
export function progressUpload(
  list: AttachmentDraft[],
  localId: string,
  progress: number
): AttachmentDraft[] {
  const clamped = Math.min(1, Math.max(0, progress));
  return mapDraft(list, localId, (draft) =>
    draft.status === "uploading" && clamped > draft.progress
      ? { ...draft, progress: clamped }
      : draft
  );
}

/** 바이트는 다 갔다. 이제 서버가 Drive에 물어보는 동안이다. */
export function verifyUpload(
  list: AttachmentDraft[],
  localId: string
): AttachmentDraft[] {
  return mapDraft(list, localId, (draft) =>
    draft.status === "uploading"
      ? { ...draft, status: "verifying", progress: 1 }
      : draft
  );
}

/** 서버가 complete를 확인했다. 이 id가 전송에 실린다. */
export function completeUpload(
  list: AttachmentDraft[],
  localId: string,
  attachmentId: string
): AttachmentDraft[] {
  return mapDraft(list, localId, (draft) => ({
    ...draft,
    status: "uploaded",
    progress: 1,
    attachmentId,
  }));
}

export function failUpload(
  list: AttachmentDraft[],
  localId: string,
  issue: UploadIssue
): AttachmentDraft[] {
  return mapDraft(list, localId, (draft) => ({
    ...draft,
    status: "failed",
    issue,
  }));
}

/**
 * 실패한 건을 줄 맨 뒤가 아니라 **제자리에서** 다시 대기로 돌린다. 재시도가
 * 곧바로 `uploading`이 아닌 이유는 한 번에 하나만 올라가기 때문이다: 앞 건이
 * 아직 가는 중이면 이 건은 기다려야 하고, 기다리는 것을 「업로드 중」이라고
 * 부르면 그 순간부터 진행률 0%가 멈춰 있는 것처럼 보인다.
 */
export function requeueUpload(
  list: AttachmentDraft[],
  localId: string
): AttachmentDraft[] {
  return mapDraft(list, localId, (draft) => {
    if (draft.status !== "failed") return draft;
    if (draft.issue !== undefined && !isRetryableIssue(draft.issue)) return draft;
    const { issue: _issue, ...rest } = draft;
    return { ...rest, status: "ready", progress: 0 };
  });
}

/**
 * 취소는 실패가 아니다 (macOS :1438-1439). 채널을 옮기거나 칩을 지운 손이
 * 만든 중단은 빨간 글씨를 받을 일이 아니다.
 */
export function rewindUpload(
  list: AttachmentDraft[],
  localId: string
): AttachmentDraft[] {
  return mapDraft(list, localId, (draft) => {
    if (draft.status !== "uploading") return draft;
    const { issue: _issue, ...rest } = draft;
    return { ...rest, status: "ready", progress: 0 };
  });
}

export function removeDraft(
  list: AttachmentDraft[],
  localId: string
): AttachmentDraft[] {
  return list.filter((draft) => draft.localId !== localId);
}

// ---- 전송 게이트 ------------------------------------------------------------

/**
 * 지금 보낼 수 있는가, 그리고 못 보낸다면 뭐라고 말할 것인가.
 *
 * 서버가 이 규율을 이미 갖고 있다: 첨부 하나가 거절되면 **메시지째 롤백**한다
 * (`attachment.rs:399-403` — "작성자가 붙인 파일 없이 나간 메시지가 실패한
 * 전송보다 나쁘다"). 화면이 그 결론을 먼저 말하면 사람이 그 롤백을 만나지 않는다.
 */
export function sendBlockReason(
  drafts: AttachmentDraft[]
): "uploading" | "failed" | null {
  // `ready`(대기 중)는 **업로드 쪽**이다 (리뷰 N-2). 앞 판은 그것을 실패 갈래에
  // 접어 두었고, 그래서 재시도를 누른 직후 한 프레임 동안 — 아직 uploading 으로
  // 넘어가기 전 — 화면이 "실패한 첨부를…"이라고 말했다. 실패한 것이 없는 순간에
  // 실패를 말하는 것이고, 줄이 사라졌다 다시 뜨는 깜빡임까지 따라온다.
  if (
    drafts.some(
      (d) =>
        d.status === "ready" ||
        d.status === "uploading" ||
        d.status === "verifying"
    )
  ) {
    return "uploading";
  }
  if (drafts.some((d) => d.status === "failed")) return "failed";
  return null;
}

/** 지금 막힌 이유에 맞는 발치 문장. 없는 버튼을 가리키지 않는다(M-1). */
export function sendBlockCopy(drafts: AttachmentDraft[]): string | null {
  const reason = sendBlockReason(drafts);
  if (reason === null) return null;
  if (reason === "uploading") return ATTACH_COPY.sendBlocked;
  const anyRetryable = drafts.some(
    (d) => d.status === "failed" && d.issue !== undefined && isRetryableIssue(d.issue)
  );
  return anyRetryable
    ? ATTACH_COPY.sendBlockedRetryable
    : ATTACH_COPY.sendBlockedFailed;
}

/** 전송에 실을 id들. 순서는 사람이 고른 순서다. */
export function attachmentIdsOf(drafts: AttachmentDraft[]): string[] {
  return drafts
    .map((draft) => draft.attachmentId)
    .filter((id): id is string => id !== undefined);
}

/** 보낸 뒤 화면에 그대로 그릴 값. echo가 자기 카드를 갖는 근거다. */
export function sentAttachmentsOf(
  drafts: AttachmentDraft[]
): MessageAttachment[] {
  return drafts
    .filter((draft) => draft.attachmentId !== undefined)
    .map((draft) => ({
      id: draft.attachmentId as string,
      name: draft.name,
      mime: draft.mime,
      sizeBytes: draft.sizeBytes,
    }));
}

// ---- 표기 -------------------------------------------------------------------

const UNITS = ["B", "KB", "MB", "GB"] as const;

/**
 * 크기 한 줄.
 *
 * 1024진법이다. macOS는 `ByteCountFormatter(.file)`을 써서 1000진법으로 찍는데,
 * 그러면 상한 문장("최대 100MB")과 그 상한에 걸린 파일의 표기(104.9 MB)가 서로
 * 다른 수를 말한다. 화면에 두 수가 동시에 있을 수 있는 이상, 같은 진법이어야
 * 한다 — 100 MiB가 정확히 "100 MB"로 찍히는 쪽을 고른다.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${UNITS[unit]}`;
}

/** 사람이 읽는 압축 형식들. 확장자는 파일명이 이미 말하므로 묶어서 부른다. */
const ARCHIVE_SUBTYPES = new Set([
  "zip",
  "x-zip-compressed",
  "gzip",
  "x-gzip",
  "x-tar",
  "x-7z-compressed",
  "x-rar-compressed",
]);

/**
 * 타입 한 조각, **사람이 읽는 낱말로** (리뷰 M-7a).
 *
 * 앞 판은 서브타입을 대문자로 찍었다: `text/plain` → "PLAIN". 그것은 낱말이
 * 아니다. 그때 적은 기각 사유("사전을 지어 넣으면 사전에 없는 타입에서 조용히
 * 이상해진다")는 **서브타입 사전**에는 맞지만 여기 쓰는 사전에는 맞지 않는다:
 * 이 함수가 보는 것은 최상위 타입이고, 그것은 IANA 가 정한 여덟 개짜리 사실상
 * 닫힌 집합이다. 모르는 최상위 타입은 존재하지 않고, 모르는 서브타입은 전부
 * 「파일」로 떨어진다 — 조용히 틀리는 자리가 없다.
 *
 * 구체성은 파일명이 진다. `drain-2026-08-09.log` 옆의 "LOG" 는 같은 말을 두 번
 * 하는 것이고, 「텍스트」는 확장자가 말하지 않는 것을 말한다.
 */
export function formatMimeLabel(mime: string): string {
  const trimmed = mime.trim().toLowerCase();
  const slash = trimmed.indexOf("/");
  const top = slash < 0 ? trimmed : trimmed.slice(0, slash);
  const subtype = (slash < 0 ? "" : trimmed.slice(slash + 1).split(";")[0]) ?? "";
  switch (top) {
    case "image":
      return "이미지";
    case "video":
      return "동영상";
    case "audio":
      return "오디오";
    case "text":
      return "텍스트";
    case "font":
      return "글꼴";
    default:
      break;
  }
  if (subtype === "pdf") return "PDF";
  if (ARCHIVE_SUBTYPES.has(subtype)) return "압축";
  if (subtype === "json" || subtype === "xml" || subtype.endsWith("+xml")) {
    return "텍스트";
  }
  return "파일";
}

/** 카드 두 번째 줄. macOS `MomoMessageAttachmentCard.metadata`와 같은 조립이다. */
export function attachmentMetaLine(attachment: MessageAttachment): string {
  return `${formatMimeLabel(attachment.mime)} · ${formatBytes(attachment.sizeBytes)}`;
}

/**
 * 파일명을 「앞부분」과 「꼬리」로 가른다 (리뷰 N-A).
 *
 * 좁은 폭에서 `truncate` 는 **끝에서** 자르고, 끝에는 확장자가 있다:
 * `drain-2026-08-09.l…` 처럼 파일을 서로 구별해 주는 조각이 가장 먼저 죽는다.
 * CSS 에 가운데 생략이 없으므로 문자열을 둘로 나누어, 앞부분만 줄어들게 하고
 * 꼬리는 그대로 둔다.
 *
 * 꼬리 길이는 「확장자 + 그 앞 한두 글자」다. 확장자만 남기면 `…log` 가 되어
 * 여러 로그 파일이 같은 꼬리를 갖는다.
 */
export function splitFileName(name: string): { head: string; tail: string } {
  const dot = name.lastIndexOf(".");
  // 확장자가 없거나(숨김 파일의 앞점 포함) 비정상적으로 길면 가를 것이 없다.
  if (dot <= 0 || name.length - dot > 8) return { head: name, tail: "" };
  const tailStart = Math.max(dot - 2, 1);
  return { head: name.slice(0, tailStart), tail: name.slice(tailStart) };
}

export function isImageMime(mime: string): boolean {
  return mime.trim().toLowerCase().startsWith("image/");
}

/**
 * 이 첨부를 인라인으로 펼칠 것인가.
 *
 * 이미지이면서 상한 아래일 때만이다. SVG는 제외한다: 서버가 프록시 응답에
 * `Content-Disposition: attachment`와 `nosniff`를 붙인 이유가 정확히 그것이고
 * (`routes/attachments.rs:359-366` — 올라온 SVG 안의 스크립트가 같은 출처에서
 * 돌지 않게), 그 판단을 화면이 뒤집을 이유가 없다.
 */
export function showsInlinePreview(attachment: MessageAttachment): boolean {
  const mime = attachment.mime.trim().toLowerCase();
  if (!isImageMime(mime)) return false;
  if (mime.startsWith("image/svg")) return false;
  return attachment.sizeBytes <= INLINE_PREVIEW_MAX_BYTES;
}
