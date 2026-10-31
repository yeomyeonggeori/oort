import { useAttachmentPreview } from "@/features/attachments/content";
import type { ExpressionSourceLine } from "@momo/core/features/expressions/cards";

/**
 * One 「원본 사진」 line of an AI-made request (ADR-0218 G1). The pointer on the candidate is
 * a record, not a key: the thumbnail comes through the same authorized attachment route the
 * conversation itself uses, so a photo that was deleted and a photo this person cannot open
 * end in the same sentence. No wording is written here; the card model hands over every
 * string, which keeps this file free of copy for the message catalogs to extract later.
 *
 * Offline is its own state. A photo that cannot be fetched because the connection is down is
 * not a photo that is gone, so the row asks for nothing while offline and says only
 * 「원본 사진」; the hook asks again by itself when `enabled` turns true on reconnect.
 */
export function ExpressionSourceRow({ line, workspaceId, channelId, offline }: {
  line: ExpressionSourceLine;
  workspaceId: string;
  channelId: string | undefined;
  offline: boolean;
}) {
  // Without a conversation there is no route to open the attachment by, so do not ask for one.
  const target = line.kind === "attached" && line.attachmentId !== null && channelId ? line.attachmentId : null;
  const preview = useAttachmentPreview(workspaceId, channelId ?? "", target ?? "", target !== null && !offline);
  const dataUrl = target !== null && preview.status === "ready" ? preview.dataUrl : null;
  const state = line.kind === "none" ? "none"
    : dataUrl !== null ? "ready"
    : target === null ? "missing"
    : offline ? "offline"
    : preview.status === "loading" ? "loading" : "missing";
  return <span className="flex items-center gap-2" data-testid="expression-approval-source" data-state={state}>
    {dataUrl !== null && <img src={dataUrl} alt="" className="size-8 rounded-md border border-line object-cover" data-testid="expression-approval-source-thumb" />}
    {state === "loading" && <span aria-hidden="true" className="size-8 rounded-md bg-surface-hover" data-testid="expression-approval-source-loading" />}
    <span>{state === "missing" ? line.missingLabel : line.label}</span>
  </span>;
}
