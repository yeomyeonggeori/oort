import { InlineBanner, Skeleton } from "@/features/common/States";
import { KeyValueRows } from "@/features/settings/SettingsFields";
import type { MemoryNotice } from "@momo/core/features/memory/model";
import {
  MEMORY_NOTICE_LOAD_ERROR,
  MEMORY_NOTICE_NEVER_TITLE,
  MEMORY_NOTICE_SENDS_TITLE,
  memoryNoticeView,
} from "@momo/core/features/memory/presentation";
import { serverSaysAbsent } from "@momo/core/features/capabilities/serverSurfaces";
import type { UseQueryResult } from "@tanstack/react-query";

// =============================================================================
// 팀 고지 (ADR-0196 D9 ②, #3212). What team memory sends to which provider and
// what never leaves the instance. Every line is a client sentence for a server
// code (presentation.ts); an unknown code is one generic line, never raw text.
// Any active member reads it, so nothing here is gated on the role.
// =============================================================================

function SentenceList({
  title,
  lines,
  testId,
}: {
  title: string;
  lines: string[];
  testId: string;
}) {
  if (lines.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={testId}>
      <h4 className="text-meta font-semibold text-ink">{title}</h4>
      <ul className="flex list-disc flex-col gap-px pl-4 marker:text-ink-muted">
        {lines.map((line) => (
          <li key={line} className="break-keep text-meta text-ink-muted">
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MemoryNoticeBody({ notice }: { notice: MemoryNotice }) {
  const view = memoryNoticeView(notice);
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="memory-notice-body">
      <p
        className="break-keep text-body text-ink"
        data-testid="memory-notice-status"
        data-sending={view.sending ? "true" : "false"}
      >
        {view.status}
      </p>
      <KeyValueRows
        rows={[
          { key: "요약 AI 제공자", value: view.provider, prose: true },
          { key: "모델", value: view.model },
        ]}
      />
      <SentenceList title={MEMORY_NOTICE_SENDS_TITLE} lines={view.sends} testId="memory-notice-sends" />
      <p className="break-keep text-meta text-ink-muted" data-testid="memory-notice-embeddings">
        {view.embeddings}
      </p>
      <SentenceList
        title={MEMORY_NOTICE_NEVER_TITLE}
        lines={view.neverSends}
        testId="memory-notice-never"
      />
    </div>
  );
}

/** The notice with its own loading and error states, for the always-visible block. */
export function MemoryNoticeQueryBody({
  query,
}: {
  query: UseQueryResult<MemoryNotice>;
}) {
  if (query.isPending) return <Skeleton ready={false} rows={3} />;
  if (query.isError || !query.data) {
    const absent = serverSaysAbsent(query.error);
    return (
      <InlineBanner
        tone={absent ? "neutral" : "error"}
        message={
          absent ? "이 서버는 아직 팀 고지를 지원하지 않아요." : MEMORY_NOTICE_LOAD_ERROR
        }
        {...(absent ? {} : { actionLabel: "다시 시도", onAction: () => void query.refetch() })}
        testId="memory-notice-load"
      />
    );
  }
  return <MemoryNoticeBody notice={query.data} />;
}
