import { useState } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/design/lib/cn";
import {
  EVIDENCE_VISIBLE_LINKS,
  evidenceAccessibleLabel,
  evidenceLabel,
} from "@momo/core/features/memory/presentation";
import type { MemoryEvidenceLink } from "@momo/core/features/memory/model";
import { searchHitPath } from "@/features/inbox/anchor";

// =============================================================================
// Source links under a digest (ADR-0196 D9 「출처: 모든 항목·요약에 근거 메시지
// 역링크」). `body` is one string and `evidence` is a list, so a link is not
// paired with a line; the list says what the digest rests on.
//
// A source in the OPEN channel jumps through the timeline's own anchor machinery
// (`onJump`, the same path a quote block uses). A source in another channel is a
// routed link, because the jump is same-channel by rule. Labels are ordinals:
// sequence numbers are internal vocabulary and never appear on screen.
// =============================================================================

export const EVIDENCE_LINK_CLASS =
  "inline-flex h-control-sm tap-target items-center rounded-md bg-surface-muted px-3 text-meta text-ink press hover:bg-surface-hover focus-visible:focus-ring";

export function EvidenceLinks({
  evidence,
  currentChannelId,
  onJump,
  testId,
}: {
  evidence: MemoryEvidenceLink[];
  /** The channel on screen. Sources elsewhere become routed links. */
  currentChannelId: string | null;
  onJump?: (messageId: string, seq: number) => void;
  testId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (evidence.length === 0) return null;
  const hidden = Math.max(0, evidence.length - EVIDENCE_VISIBLE_LINKS);
  const shown = expanded ? evidence : evidence.slice(0, EVIDENCE_VISIBLE_LINKS);
  return (
    <ul
      className="mt-2 flex flex-wrap items-center gap-2"
      data-testid={testId}
      aria-label="근거 메시지"
    >
      {shown.map((link, index) => {
        const sameChannel =
          currentChannelId !== null &&
          link.channelId.toLowerCase() === currentChannelId.toLowerCase();
        return (
          <li key={link.messageId}>
            {sameChannel && onJump ? (
              <button
                type="button"
                className={cn(EVIDENCE_LINK_CLASS)}
                aria-label={evidenceAccessibleLabel(index)}
                data-testid={`${testId}-link`}
                onClick={() => onJump(link.messageId, link.seq)}
              >
                {evidenceLabel(index)}
              </button>
            ) : (
              <Link
                to={searchHitPath(link.channelId, link.messageId, link.seq)}
                className={cn(EVIDENCE_LINK_CLASS)}
                aria-label={evidenceAccessibleLabel(index)}
                data-testid={`${testId}-link`}
              >
                {evidenceLabel(index)}
              </Link>
            )}
          </li>
        );
      })}
      {hidden > 0 && (
        <li>
          <button
            type="button"
            className="inline-flex h-control-sm tap-target items-center rounded-md px-2 text-meta text-ink-muted press hover:text-ink focus-visible:focus-ring"
            aria-expanded={expanded}
            data-testid={`${testId}-more`}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "접기" : `근거 ${hidden}개 더 보기`}
          </button>
        </li>
      )}
    </ul>
  );
}
