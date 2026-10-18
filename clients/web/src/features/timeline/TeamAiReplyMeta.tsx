import { useId } from "react";
import { ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import {
  APPS_SCREEN_PATH,
  type AppNotice,
} from "@momo/core/features/timeline/appNotice";
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
// 「쓴 앱」 줄(ADR-0113 증보 2 E8·E10, #3950)이 이 꼬리의 첫 줄로 선다 — 따로 만든 영수증이
// 아니라 같은 꼬리의 확장이다. 앱을 쓴 답에만 서고(보고가 없으면 줄 자체가 없다), 메시지마다
// 시끄러운 상태 표시를 만들지 않도록 한 줄·흐린 글씨로 둔다. 채널(DM 아님)이면 둘째 줄에
// 「이 채널 n명에게 보여요」, 개인 앱이면 「요약만」이 원칙이라는 것과 oort 가 확인하지 못한다는
// 것을 함께 적는다.
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
      {meta.appsLine !== null && (
        <div className="flex min-w-0 flex-col gap-px" data-testid="apps-used-tail">
          <p className="min-w-0 break-keep text-meta text-ink-muted [overflow-wrap:anywhere]" data-testid="apps-used-line">
            <span aria-hidden="true">{meta.appsLine}</span>
            <span className="sr-only">{meta.appsSpoken}</span>
          </p>
          {meta.exposureLine !== null && (
            <p className="min-w-0 break-keep text-meta text-ink-muted" data-testid="apps-exposure-line">
              {meta.exposureLine}
              {meta.personalNote !== null && (
                <span data-testid="apps-personal-note"> · {meta.personalNote}</span>
              )}
            </p>
          )}
        </div>
      )}
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
                  className="inline-flex min-w-0 max-w-full items-baseline gap-1 rounded-sm py-1 text-signal-text hover:text-ink active:bg-surface-pressed focus-visible:focus-ring"
                >
                  <span data-numeric className="text-ink-muted">
                    {index + 1}
                  </span>
                  {/* 밑줄은 제목에만: 번호·호스트까지 그으면 제목과 출처의 위계가 흐려진다. */}
                  <span className="min-w-0 truncate underline decoration-line-strong underline-offset-2">
                    {item.title}
                  </span>
                  {item.title !== item.host && (
                    <span className="shrink-0 text-ink-muted">
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

// =============================================================================
// 앱을 쓰다 막혔을 때의 한 문장과 행동 하나 (plugins-v2-plan 2.5절, #3950).
//
// 막힘은 상태 배지가 아니라 **문장**이다. 사람이 할 수 있는 일이 있을 때만 행동 하나가
// 문장 옆에 선다(앱 화면으로 가는 링크). 진행 중 안내(「Hermes에서 하는 중 · 3분째」)는
// 막힘이 아니므로 흐린 글씨, 막힘은 본문색이다. 경고색·아이콘으로 소리치지 않는다.
// =============================================================================

export function AppNoticeLine({ notice }: { notice: AppNotice }) {
  return (
    <p
      className={
        notice.progress
          ? "mt-1 min-w-0 break-keep text-meta text-ink-muted"
          : "mt-1 min-w-0 break-keep text-meta text-ink"
      }
      data-testid="app-notice"
      data-kind={notice.kind}
      // 진행 중 안내는 조용히, 막힘은 한 번 읽어 준다.
      role={notice.progress ? undefined : "status"}
    >
      {notice.sentence}
      {notice.action !== null && (
        <>
          {" "}
          <Link
            to={APPS_SCREEN_PATH}
            className="press rounded-sm py-1 text-signal-text underline decoration-line-strong underline-offset-2 hover:text-ink focus-visible:focus-ring"
            data-testid="app-notice-action"
          >
            {notice.action.label}
          </Link>
        </>
      )}
    </p>
  );
}
