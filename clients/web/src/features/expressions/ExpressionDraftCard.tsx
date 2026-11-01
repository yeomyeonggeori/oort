import { EXPRESSION_FILE_ACCEPT, validExpressionFile } from "./media";
import { useEffect, useRef, useState } from "react";
import { expressionChoice, expressionDraftCard } from "@momo/core/features/expressions/cards";
import type { MessageKey } from "@momo/core/i18n";
import { LEGACY_EXPRESSION_KIND, recommendedKindForDraft } from "@momo/core/features/expressions/kind";
import { EXPRESSION_KINDS, type ExpressionChoice, type ExpressionDraft, type ExpressionKind } from "@momo/core/features/expressions/types";
import { Button } from "@/design/ui/button";
import { SegmentedControl } from "@/design/ui/segmented-control";
import { GithubExternalLink } from "@/features/github/GithubExternalLink";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { useExpressions } from "./context";
import { ExpressionImage } from "./ExpressionImage";

// 종류 고르기의 문장은 모두 사전에서 온다(`expressions.kind.*`). 종류 이름은 코어의 목록(`EXPRESSION_KINDS`)에서 오고
// 이 파일에 낱말로 두지 않는다(직접 문구 장부).
const KIND_LABEL = { emoji: "expressions.kind.emoji", sticker: "expressions.kind.sticker" } as const satisfies Record<ExpressionKind, MessageKey>;
const KIND_HINT = { emoji: "expressions.kind.hintEmoji", sticker: "expressions.kind.hintSticker" } as const satisfies Record<ExpressionKind, MessageKey>;

export function ExpressionDraftCard({ draft, onReplace, onApprove, busy = false, pending = true, promptLabel }: {
  draft: ExpressionDraft;
  /**
   * 출처 문장 앞의 말. 없으면 「에이전트가 쓴 설명」이다(ADR-0218 D5: 에이전트가 쓴 글은 그렇다고 표시한다).
   * 서버가 직접 쓴 고정 문장(사진 길, H9.7)만 자기 말을 넘겨 받는다: 문장 내용으로 가르지 않는다,
   * 에이전트가 같은 문장을 쓸 수 있기 때문이다.
   */
  promptLabel?: string;
  onReplace: (draft: ExpressionDraft) => void;
  onApprove: (choice: ExpressionChoice) => Promise<void>;
  busy?: boolean;
  pending?: boolean;
}) {
  const { store, offline } = useExpressions();
  const formatMessage = useFormatMessage();
  const [now, setNow] = useState(Date.now());
  const [viewed, setViewed] = useState<string | null>(null);
  // ADR-0218 §10 J3: 종류는 등록하는 순간 정한다. 사람이 고르기 전에는 서버가 같은 규칙으로 정할 추천을
  // 미리 골라 보이고, 보낸 값이 곧 저장되는 값이다. 고른 값은 **그 그림의 핀**에 묶여서(그림이 바뀌면 핀이 바뀐다)
  // 새 그림에는 옛 선택이 따라가지 않고 추천이 다시 정해진다.
  const [chosen, setChosen] = useState<{ pin: string; kind: ExpressionKind } | null>(null);
  const [rights, setRights] = useState(false);
  const [working, setWorking] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const card = expressionDraftCard(draft, now, pending);
  const base = expressionChoice(draft, now);
  const pin = base ? `${base.draftId}:${base.revision}:${base.sha256}` : null;
  const explicit = chosen !== null && chosen.pin === pin ? chosen.kind : null;
  const kind = explicit ?? recommendedKindForDraft(draft) ?? LEGACY_EXPRESSION_KIND;
  const choice = base ? { ...base, kind } : null;
  useEffect(() => {
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(2147483647, draft.expiresAtMs - Date.now())));
    return () => window.clearTimeout(timer);
  }, [draft.expiresAtMs]);
  const blocked = busy || working || offline;
  async function upload(file: File) {
    if (!store || blocked || lock.current) return;
    if (!validExpressionFile(file)) { setError("5 MiB 이하의 PNG, JPEG, WebP 또는 GIF를 골라 주세요."); return; }
    lock.current = true; setWorking(true); setError(null); setViewed(null); setRights(false);
    try { onReplace(await store.draft({ method: "PUT", path: `${store.base}/expression-drafts/${draft.draftId}/file`, file })); }
    catch { setError("그림을 올리지 못했어요. 파일을 확인하고 다시 올려 주세요."); }
    finally { lock.current = false; setWorking(false); }
  }
  async function approve() {
    if (!choice || !pin || viewed !== pin || !rights || blocked || lock.current) return;
    lock.current = true; setWorking(true); setError(null);
    try { await onApprove(choice); }
    catch { setError("등록하지 못했어요. 이름, 권한과 미리보기를 확인하고 다시 시도해 주세요."); }
    finally { lock.current = false; setWorking(false); }
  }
  return <section className="flex flex-col gap-2 border-t border-line py-3" aria-label={draft.displayName} data-testid="expression-draft" data-state={card.state}>
    <p className="text-body font-semibold">{draft.displayName} <span className="font-mono text-meta text-ink-muted">:{draft.name}:</span></p>
    <p className="text-meta text-ink-muted">{draft.tags.join(" · ")}</p>
    <p className="text-body" role="status">{card.line}</p>
    {card.sourceLink && <GithubExternalLink href={card.sourceLink} className="text-signal-text underline focus-visible:focus-ring">출처: {new URL(card.sourceLink).hostname}</GithubExternalLink>}
    {draft.origin.prompt && <p className="break-words text-meta text-ink-muted" data-testid="expression-draft-prompt">{promptLabel ?? "에이전트가 쓴 설명:"} {draft.origin.prompt}</p>}
    {card.preview && <ExpressionImage key={`${draft.draftId}:${draft.revision}`} item={draft} size="large" onReady={() => setViewed(pin)} />}
    {card.canApprove && <>
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="text-meta">{formatMessage("expressions.kind.legend")}</span>
        <SegmentedControl legend={formatMessage("expressions.kind.legend")} className="min-w-0 flex-1" testId="expression-draft-kind" disabled={blocked} value={kind} onValueChange={(next) => { if (pin) setChosen({ pin, kind: next }); }}
          options={EXPRESSION_KINDS.map((value) => ({ value, label: formatMessage(KIND_LABEL[value]) }))} />
      </div>
      <p className="text-meta text-ink-muted" data-testid="expression-draft-kind-hint">{formatMessage(KIND_HINT[kind])}</p>
      {explicit === null && <p className="text-meta text-ink-muted" data-testid="expression-draft-kind-auto">{formatMessage("expressions.kind.autoNote")}</p>}
      <label className="flex items-start gap-2 text-meta active:bg-surface-pressed"><input type="checkbox" checked={rights} onChange={(event) => setRights(event.target.checked)} className="mt-1 focus-visible:focus-ring" />이 그림을 팀에 저장할 권한이 있어요. 사람 얼굴이 있다면 지정된 당사자만 승인해요.</label>
      <Button type="button" disabled={blocked || !rights || !pin || viewed !== pin} onClick={() => void approve()} className="self-end">{working ? "등록 중" : "팀 보관함에 등록"}</Button>
      {viewed !== pin && <p className="text-meta text-ink-muted">그림을 불러오는 중이에요. 새 미리보기를 본 뒤 등록해 주세요.</p>}
    </>}
    {card.canUpload && <>
      <input ref={fileRef} type="file" accept={EXPRESSION_FILE_ACCEPT} className="sr-only" tabIndex={-1} aria-label="대신 올릴 그림" onChange={(event) => { const file = event.target.files?.item(0); event.target.value = ""; if (file) void upload(file); }} />
      <Button type="button" variant="secondary" className="self-start" disabled={blocked} onClick={() => fileRef.current?.click()}>{working ? "올리는 중" : card.uploadLabel}</Button>
    </>}
    {offline && <p role="status" className="text-meta text-ink-muted">연결되면 다시 시도해 주세요.</p>}
    {error && <p role="alert" className="text-meta text-danger">{error}</p>}
  </section>;
}
