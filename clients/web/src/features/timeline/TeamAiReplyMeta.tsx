import { useId } from "react";
import { ExternalLink } from "lucide-react";
import {
  citationAccessibleName,
  TEAM_AI_SOURCES_LABEL,
  type TeamAiReplyMeta as Meta,
} from "@momo/core/features/timeline/teamAiReply";
import { isDesktop, openExternalUrl } from "@/lib/tauri";

// =============================================================================
// 도우미 답 아래의 꼬리 (ADR-0201 증보 v2 H4·H5·H9-I9, #3893).
//
//   찾아본 것: 메시지 검색 · #마케팅 읽기          [팀 AI · Claude Sonnet 4.5]
//   출처  1 제목 · example.com ↗   2 …
//
// 서버가 적은 사실이고 모델이 쓴 글이 아니다. 그래서 본문보다 한 단계 작고 흐리며(meta),
// 본문 속 링크를 출처로 승격하지 않는다. 칸이 없으면 코어가 null 을 내고 이 컴포넌트는
// 서지 않는다(옛 서버 · 카드만 낸 답).
//
// 모델 칩은 `@claude` 로 불렀는데 팀 키가 다른 공급자일 때 그 사실을 보이는 자리다(H9-I9).
// 상태가 아니라 이름이라 색을 쓰지 않는다: 회색 바탕 + 흐린 글자.
// =============================================================================

export function TeamAiReplyMeta({ meta }: { meta: Meta }) {
  const sourcesId = useId();
  return (
    <div
      className="mt-1 flex min-w-0 flex-col gap-1"
      data-testid="team-ai-reply-meta"
    >
      {(meta.toolsLine !== null || meta.modelChip !== null) && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {meta.toolsLine !== null && (
            <p
              className="min-w-0 break-keep text-meta text-ink-muted"
              data-testid="team-ai-tools-line"
            >
              {/* 눈에는 「외 N개」로 접힌 줄, 스크린리더에는 전부(`aria-label` 은 문단에서
                  읽히지 않는 리더가 있어 숨긴 글로 둔다). */}
              <span aria-hidden="true">{meta.toolsLine}</span>
              <span className="sr-only">{meta.toolsSpoken}</span>
            </p>
          )}
          {meta.modelChip !== null && (
            <span
              className="rounded-md bg-muted-soft px-2 py-px text-timestamp font-semibold text-ink-muted"
              data-testid="team-ai-model-chip"
            >
              {meta.modelChip}
            </span>
          )}
        </div>
      )}
      {meta.citations.length > 0 && (
        <div
          className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-meta"
          data-testid="team-ai-citations"
        >
          <span className="text-ink-muted" id={sourcesId}>
            {TEAM_AI_SOURCES_LABEL}
          </span>
          <ol
            aria-labelledby={sourcesId}
            className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1"
          >
            {meta.citations.map((item, index) => (
              <li key={item.url} className="min-w-0">
                <a
                  href={item.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={citationAccessibleName(item)}
                  data-testid="team-ai-citation"
                  onClick={(event) => {
                    // 데스크탑 셸에서 `target="_blank"` 는 죽은 컨트롤이다. 본문 링크
                    // (`MessageBody`)와 같은 넘김이다.
                    if (!isDesktop()) return;
                    event.preventDefault();
                    void openExternalUrl(item.url);
                  }}
                  className="inline-flex min-w-0 max-w-full items-baseline gap-1 rounded-sm text-signal-text underline decoration-line-strong underline-offset-2 hover:text-ink active:bg-surface-pressed focus-visible:focus-ring"
                >
                  <span data-numeric className="text-ink-muted">
                    {index + 1}
                  </span>
                  <span className="min-w-0 truncate">{item.title}</span>
                  {item.title !== item.host && (
                    <span className="shrink-0 text-ink-muted no-underline">
                      {item.host}
                    </span>
                  )}
                  <ExternalLink
                    aria-hidden="true"
                    className="size-3 shrink-0 self-center"
                  />
                </a>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
