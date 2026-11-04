import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Laptop, PencilLine } from "lucide-react";
import { uuidEq } from "@momo/core/lib/api";
import {
  commandSuggestHead,
  commandSuggestIsTarget,
  commandSuggestOneLine,
  WORK_REQUEST_TOOLS_PATH,
  type WorkRequestHarness,
} from "@momo/core/features/timeline/commandSuggest";
import { useSession } from "@/app/session";
import { Button } from "@/design/ui/button";
import { seedComposerText, seedThreadComposerText } from "@/features/chat/draftStore";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import type { CommandSuggestSlotProps } from "@/features/timeline/commandSuggestSlot";
import { useChannels } from "@/features/workspace/useWorkspace";
import { workRequestTarget } from "@/features/work/personalAgentCalling";

// =============================================================================
// 「작업 요청 열기」 제안 카드 — 웹 (#4972 S9, ADR-0201 증보 v3 B8 C1).
//
// 도우미는 코드를 읽지도 돌리지도 않는다. 코드 일을 부탁받으면 이 카드로 사람의 「작업 요청」을
// **미리 채워** 준다: 카드는 서버를 바꾸지 않고(risk none, 승인 행도 감사 행도 없다), 누르는 일은
// 이 기기에서만 일어나며, **보내는 것은 사람이다**.
//
// ## 웹에는 별도의 「작업 요청」 시트가 없다
//
// 폰에는 「내 맥에 보내기」 시트가 있지만(ADR-0198 D4 T6b), 웹에서 내 맥에 일을 보내는 길은 컴포저에서
// 내 개인 에이전트를 부르는 것이다(`personalAgentCalling.ts`). 그래서 이 카드의 「미리 채우기」는 그 컴포저에
// `@<내 개인 에이전트> <글>`을 심는 것이다 — 「운영자에게 부탁하기」(`AiConnectCard`)와 같은 길
// (`seedComposerText` · `seedThreadComposerText`)이고, 쓰던 글은 덮지 않는다. 사람이 글을 읽고 보내기를
// 눌러야 일이 시작된다(서명은 그때, 데스크탑의 기기 키로).
//
// 도구(`harness`)가 정해진 카드는 그 도구의 개인 에이전트를, 정해지지 않았거나 그 도구의 에이전트가 없으면
// 내 개인 에이전트 중 첫째를 쓴다. 개인 에이전트가 하나도 없으면 채울 이름이 없으므로 그렇다고 말하고
// AI 화면으로 보낸다 — 조용히 아무 일도 안 일어나는 단추를 세우지 않는다.
//
// ## DM에서는 채우지 않는다
//
// 도우미를 DM으로 부른 사람이 가장 많을 텐데, DM의 사람 메시지는 서버가 그 방의 에이전트를 부르는 신호다.
// 거기에 `@<내 개인 에이전트> <코드 일>`을 보내면 도우미가 코드 일을 또 부탁받아 같은 카드를 다시 주고,
// 서버는 DM에 없는 에이전트의 멘션을 착석 제안으로 읽는다. 그래서 DM(그룹 DM 포함)의 카드는 단추를 세우지
// 않고 「채널에서 눌러 주세요」만 말한다 — 폰 시트가 집 채널에서 DM을 빼는 것(`homeChannels`)과 같은 줄이다.
//
// 문구는 에이전트·메시지의 문자열이 아니라 `harness`에서 사전으로 다시 만든다(라벨을 그리지 않는다 —
// 피싱 문구 차단). 글(prompt)은 카드에 그리지 않는다: 그 글은 입력창에서만 읽힌다. 남이 보는 카드와 깨진
// 제안(글 없음)은 한 줄이고 누를 것이 없다.
//
// 네 상태: 이 카드는 서버를 부르지 않는다(로딩·오류·오프라인 없음). 「채울 수 없음」 세 가지(쓰던 글·스레드
// 입력창이 닫힘·개인 에이전트 없음)는 단추 아래의 한 줄(`role="status"`)로 말한다. 키보드: 단추 하나(도구
// 안내가 서면 둘), 기본 포커스 링.
// =============================================================================

const LABEL_KEY = {
  claude: "timeline.workRequest.labelClaude",
  codex: "timeline.workRequest.labelCodex",
} as const satisfies Record<WorkRequestHarness, string>;

function labelKey(harness: WorkRequestHarness | null) {
  return harness === null ? "timeline.workRequest.labelAny" : LABEL_KEY[harness];
}

type Notice = { text: string; tools: boolean };

export function WorkRequestOpenSuggestion({
  card,
  viewerMemberId,
  directory,
  channelId,
  rootId,
}: CommandSuggestSlotProps) {
  const formatMessage = useFormatMessage();
  const navigate = useNavigate();
  const { workspaceId } = useSession();
  // 이 카드가 선 방이 DM인가. 채널 목록은 `ChatShell`이 이미 같은 키로 읽어 둔 것이다(추가 요청 없음).
  const { groups } = useChannels(workspaceId);
  const inDm = groups.dms.some((channel) => uuidEq(channel.id, channelId));
  const headingId = useId();
  const [notice, setNotice] = useState<Notice | null>(null);
  const workRequest = card.workRequest;
  // 깨진 제안(글 없음)은 대상 본인에게도 한 줄이다: 채울 글이 없다. 행의 본문 글이 안내를 한다.
  if (workRequest === null || !commandSuggestIsTarget(card, viewerMemberId)) {
    return (
      <div
        className="ai-card mt-2 flex min-w-0 flex-col gap-2"
        data-testid="work-request-suggest"
        data-viewer="other"
      >
        <p
          className="flex min-w-0 items-center gap-2 rounded-lg bg-sheet px-3 py-2 text-meta text-ink-muted"
          data-testid="work-request-suggest-line"
        >
          <Laptop className="size-4 shrink-0 text-icon" aria-hidden="true" />
          <span className="min-w-0 flex-1 break-keep">{commandSuggestOneLine(card)}</span>
        </p>
      </div>
    );
  }

  const label = formatMessage(labelKey(workRequest.harness));
  const initial = [...card.agentName.trim()][0]?.toUpperCase() ?? "";

  // 입력창에 `@<내 개인 에이전트> <글>`을 심는다. 보내는 것은 사람이다.
  const fill = () => {
    if (inDm) return;
    const agent = workRequestTarget(directory.members, viewerMemberId ?? "", workRequest.harness);
    if (agent === null) {
      setNotice({ text: formatMessage("timeline.workRequest.noPersonalAgent"), tools: true });
      return;
    }
    const draft = `@${agent.handle} ${workRequest.prompt}`;
    // 스레드 안의 제안은 그 스레드 입력창에(채널 입력창은 좁은 폭에서 서랍 뒤 `inert`다).
    if (rootId) {
      const seeded = seedThreadComposerText(rootId, draft);
      if (!seeded.mounted) {
        setNotice({ text: formatMessage("timeline.workRequest.threadClosed"), tools: false });
      } else if (!seeded.accepted) {
        setNotice({ text: formatMessage("timeline.workRequest.composerBusy"), tools: false });
      } else {
        setNotice(null);
      }
      return;
    }
    if (!seedComposerText(workspaceId, channelId, draft)) {
      setNotice({ text: formatMessage("timeline.workRequest.composerBusy"), tools: false });
      return;
    }
    setNotice(null);
    const input = document.getElementById("composer-input");
    if (input instanceof HTMLTextAreaElement) input.focus();
  };

  return (
    <section
      aria-labelledby={headingId}
      className="ai-card mt-2 min-w-0 overflow-hidden rounded-2xl border border-line bg-surface shadow-sm"
      data-testid="work-request-suggest"
      data-viewer="target"
      data-harness={workRequest.harness ?? undefined}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-3 py-2">
        <span
          aria-hidden="true"
          className="grid size-6 shrink-0 place-items-center rounded-sm bg-agent-soft text-timestamp font-bold text-agent"
        >
          {initial}
        </span>
        <h3 id={headingId} className="min-w-0 break-keep text-meta font-semibold text-agent">
          {commandSuggestHead(card)}
        </h3>
      </div>
      <div className="flex min-w-0 items-center gap-3 px-3 py-3">
        <Laptop className="size-4 shrink-0 text-icon" aria-hidden="true" />
        <span
          className="min-w-0 flex-1 break-keep text-body text-ink"
          data-testid="work-request-suggest-label"
        >
          {label}
        </span>
        {!inDm && (
          <Button
            type="button"
            size="sm"
            // 눌리는 면은 좁은 폭에서 44(`tap-target`), 보이는 모양은 그대로.
            className="tap-target"
            onClick={fill}
            aria-label={formatMessage("timeline.workRequest.fillLabel", { label })}
            data-testid="work-request-suggest-fill"
          >
            <PencilLine aria-hidden="true" />
            {formatMessage("timeline.workRequest.fill")}
          </Button>
        )}
      </div>
      <p
        className="min-w-0 break-keep px-3 pb-3 text-meta text-ink-muted"
        data-testid="work-request-suggest-hint"
      >
        {formatMessage(inDm ? "timeline.workRequest.inDm" : "timeline.workRequest.fillHint")}
      </p>
      {notice !== null && (
        <div
          role="status"
          className="flex min-w-0 flex-wrap items-center gap-2 border-t border-line px-3 py-2 text-meta text-ink-muted"
          data-testid="work-request-suggest-notice"
        >
          <span className="min-w-0 flex-1 break-keep">{notice.text}</span>
          {notice.tools && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="tap-target"
              onClick={() => navigate(WORK_REQUEST_TOOLS_PATH)}
              data-testid="work-request-suggest-tools"
            >
              {formatMessage("timeline.workRequest.openTools")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
