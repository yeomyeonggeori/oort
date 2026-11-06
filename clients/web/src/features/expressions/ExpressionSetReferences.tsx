import { ImageOff, X } from "lucide-react";
import { useAttachmentPreview } from "@/features/attachments/content";
import { useFormatMessage } from "@/i18n/useFormatMessage";

// 썸네일 한 장의 자리. 숫자인 이유: 상태 이름을 문자열로 두면 직접 문구 장부가 새 줄로 센다(이 파일은 0줄이어야 한다).
const Phase = { ready: 0, missing: 1, offline: 2, loading: 3 } as const;
// 대화가 쓰는 미리보기 훅의 자기 상태 이름(`status`)을 우리 자리로 옮기는 표.
const PREVIEW_PHASE = { loading: Phase.loading, ready: Phase.ready, failed: Phase.missing } as const;

/**
 * 한 장의 참조 그림 썸네일 (ADR-0218 G1·L18). 카드가 가진 것은 **포인터**(첨부 id)이지 열쇠가 아니다: 그림은 대화가 쓰는 같은 인가
 * 경로(`useAttachmentPreview`)로만 열린다. 열 수 없는 그림(지워졌거나 이 사람이 못 여는 것)과 연결이 끊겨 못 받는 그림은 다른 자리다:
 * 오프라인에서는 요청 자체를 하지 않고 자리만 둔다.
 */
function ReferenceThumb({ workspaceId, channelId, attachmentId, position, offline, onRemove }: {
  workspaceId: string; channelId: string | undefined; attachmentId: string; position: number; offline: boolean; onRemove?: (() => void) | undefined;
}) {
  const formatMessage = useFormatMessage();
  const target = channelId ? attachmentId : null;
  const preview = useAttachmentPreview(workspaceId, channelId ?? "", target ?? "", target !== null && !offline);
  const dataUrl = target !== null ? (preview as { dataUrl?: string }).dataUrl ?? null : null;
  const phase = dataUrl !== null ? Phase.ready : target === null ? Phase.missing : offline ? Phase.offline : PREVIEW_PHASE[preview.status];
  const alt = formatMessage("expressions.plan.referenceAlt", { position });
  return <li className="relative" data-testid="expression-set-reference" data-phase={phase}>
    {dataUrl !== null
      ? <img src={dataUrl} alt={alt} className="expression-set-thumb rounded-md border border-line" />
      : phase === Phase.loading
        ? <span role="img" aria-label={alt} className="expression-set-thumb rounded-md border border-line bg-surface-hover" />
        : <span role="img" aria-label={alt} className="expression-set-thumb flex items-center justify-center rounded-md border border-line bg-surface-muted text-ink-muted"><ImageOff aria-hidden="true" className="size-4" /></span>}
    {onRemove && <button type="button" onClick={onRemove} aria-label={formatMessage("expressions.plan.editRemoveReference", { position })}
      className="press absolute -right-1 -top-1 flex size-6 items-center justify-center rounded-full bg-surface text-ink shadow-sm focus-visible:focus-ring" data-testid="expression-set-reference-remove">
      <X aria-hidden="true" className="size-4" />
    </button>}
  </li>;
}

/** 참조 그림의 줄: 썸네일 0~4장. `onRemove`가 있으면 장마다 빼기 단추가 선다(계획 고치기에서만: 참조는 빼기만 된다, L2.5). */
export function ExpressionSetReferences({ references, workspaceId, channelId, offline, onRemove }: {
  references: readonly { attachmentId: string }[]; workspaceId: string; channelId: string | undefined; offline: boolean; onRemove?: (attachmentId: string) => void;
}) {
  if (references.length === 0) return null;
  return <ul className="flex flex-wrap items-center gap-2" data-testid="expression-set-references">
    {references.map((reference, index) => <ReferenceThumb key={reference.attachmentId} workspaceId={workspaceId} channelId={channelId}
      attachmentId={reference.attachmentId} position={index + 1} offline={offline} onRemove={onRemove ? () => onRemove(reference.attachmentId) : undefined} />)}
  </ul>;
}
