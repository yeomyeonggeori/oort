import { useRef, useState, type RefObject } from "react";
import { activityRail, type ActivityRail, type RailAgent } from "@momo/core/features/agents/activityRail";
import {
  agentLabel,
  TURN_STALE_SENTENCE,
  UNKNOWN_AGENT_NAME,
} from "@momo/core/features/agents/turnCopy";
import { cn } from "@/design/lib/cn";
import { Popover, PopoverContent, PopoverTrigger } from "@/design/ui/popover";
import { openAdeDrawer } from "@/features/ade/adeDrawerStore";
import { useApprovalWaits } from "@/features/inbox/useInbox";
import { memberNameParts, type Directory } from "@/features/workspace/useWorkspace";
import {
  agentTurnsInChannel,
  applyApprovalWaits,
  hasChannelTurn,
  useAgentWorkingSignals,
  useTickingNow,
} from "./agentWorkingSignal";
import { RespondingAvatar, RespondingDots } from "./RespondingIndicator";
import { openWorkPanel } from "./workLogStore";

// =============================================================================
// 입력창 레일: 「에이전트가 지금 일하는 중」의 **유일한** 실시간 자리 (#4619, #4577 권장 A).
//
//   [얼굴] grok · 작업 중 · 설계 문서 읽는 중 ···        (한 에이전트)
//   [얼굴][얼굴] grok +1                                  (여럿은 합친다)
//
// 입력창 카드 **바로 위**에 서고, 칸의 높이는 **클래스로 고정**돼 있다(`RAIL_SHELL_CLASS`).
// 줄이 서고, 사라지고, 단계가 바뀌고, 합쳐져도 타임라인은 한 픽셀도 움직이지 않는다 — 안이 비어도
// 같은 칸이다. 이것이 Buzz의 「높이 예약 레일」(`ComposerActivityAccessory`)이고, 대화 아래에 문장
// 행을 세우던 옛 방식(`MessageRunStatus`)을 대신한다.
//
// ## #1749의 「죽은 세로 밴드는 없다」와의 관계
//
// 작성 중(사람)의 줄은 액션 행의 가로 슬롯으로 내려갔고 별도 세로 예약 행을 없앴다. 이 레일은 그
// 판단을 **뒤집는다**: 타임라인을 미는 것(밀림)이 죽은 밴드보다 비싸다는 owner 결정(#4577 「ㄱㄱ」,
// 2026-10-26)이 근거다. 대신 밴드가 죽어 보이지 않게, **에이전트가 있는 대화에서만** 서고(`isRailReserved`: 에이전트
// DM·활동 중인 에이전트 멤버가 있는 채널, planner 결정 4) 폼의 윗 여백을 이 칸이 대신한다(폼의 `data-rail:pt-0`).
// 사람만 있는 대화에는 칸도 없고 입력창 위 간격은 폼의 윗 여백뿐이다(#1749 그대로: 600px 이상 8, 폰 13).
// 에이전트 대화의 간격은 24다(칸 24).
//
// ## 줄은 가만히 있는다
//
// 초 단위 숫자도, 분 단위 경과도 줄에 없다. 경과는 팝오버에서만 1분 단위로 말한다. 판정과 낱말은
// 코어 `activityRail`이 정하고 폰이 같은 모델을 쓴다. 이 컴포넌트는 그것을 그리는 일뿐이다.
//
// ## 누르면
//
// 팝오버(일하는 에이전트 목록 + 「활동 보기」)가 열린다. 에이전트 행은 그 run의 작업 패널(진행
// 과정)을, 「활동 보기」는 활동 서랍(`AdeDrawer`)을 연다. 활동 독(#4578)이 생기면 도착지가 그쪽으로
// 바뀐다.
//
// ## 점
//
// 「일하는 중」의 점 셋(`RespondingDots`)은 #4020에서 owner가 승인한 예외다(투명도만, 일하는 동안만,
// 끊긴 레일에는 없고, 동작 줄이기에서는 멈춘다). 「답하는 중」이라는 문구는 이 레일의 「작업 중」으로
// 대체됐다(#4577 A, 2026-10-26). 점은 이 레일 안의 **작은 생존 표지**로 남긴다(planner 결정 3): 「일하는 중」이라는
// 사실을 낱말 없이 눈에 전하는 것이 점의 일이다. 동작 줄이기를 켜면 멈춘 채 선다.
// =============================================================================

/**
 * 레일 칸. **높이가 여기서 정해진다**(`h-6` = 24px): 안이 비어도, 한 줄이어도, 합친 줄이어도,
 * 연결이 끊긴 문장이 붙어도 같은 칸이다. 이 클래스에서 높이를 빼면 줄이 설 때마다 타임라인이 밀린다
 * (브라우저 시험이 바닥 행의 y를 재서 그것을 붙든다).
 *
 * `px-6`은 폼의 `p-3` + 텍스트에어리어의 `px-3` = 24px이다. 레일은 textarea 텍스트 기둥에 선다.
 *
 * `@container`: 끊긴 레일이 칸의 안쪽 폭을 물어 에이전트 글을 접는 데 쓴다(아래 `RailLine`): `@max-xs`(20rem 아래)는 이름도,
 * `@max-lg`(32rem 아래)는 낱말·단계를 접는다.
 */
export const RAIL_SHELL_CLASS = "@container flex h-6 shrink-0 items-center px-6";

/**
 * 레일 줄(누르면 팝오버). 칸 안에서 한 줄을 넘지 않는다: 글은 줄어들고 점·얼굴은 줄지 않는다.
 *
 * **누르는 면은 칸의 높이(24)다**(`h-full`): 글자 높이(18)가 아니라 칸을 가득 채워 24px 표적이 된다(WCAG 2.5.8 바닥).
 * 폰 폭에서 44로 키우려고 칸 밖으로 넘치게 해 보았지만(`tap-target`) 실측으로 닿지 않았다: 위쪽 넘침은 타임라인이, 아래쪽
 * 넘침은 입력창 카드가 가로챈다(design-review r1 H3). 44를 지키려면 칸 자체가 폰 폭에서 커져야 하고 그것은 타임라인 위에
 * 쓰는 세로 자리를 늘리는 결정이라 이 PR은 24에서 멈추고 이 줄에 사실대로 적는다.
 */
export const RAIL_LINE_CLASS =
  "flex h-full min-w-0 max-w-full items-center gap-2 rounded-sm text-left text-meta press hover:bg-surface-hover focus-visible:focus-ring";

function RailAgentRow({
  agent,
  directory,
  channelId,
  openerRef,
  onOpened,
}: {
  agent: RailAgent;
  directory: Directory;
  channelId: string;
  openerRef: RefObject<HTMLButtonElement | null>;
  onOpened: () => void;
}) {
  const tail = [agent.word, agent.stage].filter((part) => part !== undefined).join(" · ");
  const body = (
    <>
      <RespondingAvatar directory={directory} memberId={agent.memberId} />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-agent">{agentLabel(agent.name)}</span>
        <span className={agent.needsHuman ? "text-warn" : undefined}> · {tail}</span>
      </span>
      {agent.detail !== undefined && (
        <span className="shrink-0 text-timestamp text-ink-muted" data-numeric>
          {agent.detail}
        </span>
      )}
    </>
  );
  const rowClass =
    "tap-target flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-meta text-ink";
  if (agent.runId === undefined) {
    return (
      <div className={rowClass} data-testid="composer-working-agent" data-member-id={agent.memberId}>
        {body}
      </div>
    );
  }
  const runId = agent.runId;
  return (
    <button
      type="button"
      // 전폭 행은 눌림이 스케일이 아니라 **채움**이다(pressLedger B4-3): 행이 줄어들면 옆 행과 어긋난다.
      className={cn(
        rowClass,
        "hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring"
      )}
      data-testid="composer-working-agent"
      data-member-id={agent.memberId}
      aria-label={`${agentLabel(agent.name)} 진행 과정 열기`}
      onClick={() => {
        onOpened();
        openWorkPanel(
          {
            runId,
            memberId: agent.memberId,
            channelId,
            origin: "activity",
            // 이 줄이 이미 알고 있는 시작 시각이다. 패널이 자기 힘으로는 얻을 수 없는 유일한 값이다.
            ...(agent.startedAtMs !== undefined ? { startedAtMs: agent.startedAtMs } : {}),
          },
          // 닫힐 때 캐럿이 돌아올 자리: 팝오버는 닫히면서 사라지므로 그 안의 단추가 아니라 레일 줄이다.
          openerRef.current
        );
      }}
    >
      {body}
    </button>
  );
}

function RailLine({
  rail,
  live,
  directory,
  channelId,
}: {
  rail: ActivityRail;
  live: boolean;
  directory: Directory;
  channelId: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tail = rail.text.slice(rail.leadLabel.length);
  // 연결이 끊긴 레일은 얼굴·점을 걷고 이름을 에이전트색에서 내린다: 지금 아무도 일하는 중이 아니라는
  // 것이 확인된 것이 아니고, 기억하던 주장을 확인된 것처럼 그리지 않는다(SKILL §5 offline).
  const accessibleName = live ? rail.label : `${rail.label} ${TURN_STALE_SENTENCE}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={triggerRef}
          type="button"
          // 이름을 명시한다: 자식에 맡기면 줄이 잘렸을 때 잘린 글이 접근성 이름이 된다.
          aria-label={`${accessibleName} 일하는 에이전트 보기`}
          title={live ? rail.text : `${rail.text} ${TURN_STALE_SENTENCE}`}
          data-testid="composer-working-open"
          className={cn(RAIL_LINE_CLASS, live && rail.needsHuman ? "text-warn" : "text-ink-muted")}
        >
          {live && (
            <span className="flex shrink-0 items-center gap-1" data-testid="composer-working-avatars">
              {rail.agents.slice(0, 2).map((agent) => (
                <RespondingAvatar key={agent.key} directory={directory} memberId={agent.memberId} />
              ))}
            </span>
          )}
          <span
            // 끊긴 줄에서는 에이전트 글이 **양보한다**(`flex-1` = 기준 폭 0에서 남는 자리만 받는다): 한 줄에 두 말이 못 들어가면
            // 한정 문장(「마지막으로 확인된 상태예요」)이 남고 에이전트 글이 줄어든다. 둘이 같은 비율로 줄면 좁은 폭(390·720)에서
            // 한정이 잘렸다(design-review r1 B1). 한정 문장은 이 폭에서 잘리지 않아야 사용자가 지금 글이 낡았다는 것을 안다.
            // **에이전트 글은 낱말 중간에서 끊기지 않는다**(r2 B1-r2, ADR-0112 D6 Detail SLA): 글에 남는 자리는 칸 안쪽 - 262(한정
            // 문장 254 + 간격 8)라서 세 단계로 선다. 안쪽 32rem(512) 이상이면 전문(이름 · 낱말 · 단계: 남는 250에 기본 fixture
            // 전문 190이 든다), 그 아래(390·720의 약 340에서 남는 약 80)이면 이름만(`@max-lg:hidden`이 낱말·단계를 통째로 접는다),
            // 20rem(320) 아래(폰 폭 320~367)이면 이름도 접는다(`@max-xs:hidden`: 남는 자리가 320에서 10px·367에서 57px라 이름이 한 글자도 안 들거나 겨우 든다). 「작…」 같은 조각은
            // 어느 단계에서도 서지 않는다. 접힌 글은 `aria-label`·`title`·팝오버에 그대로 있다.
            className={cn("min-w-0 truncate", !live && "flex-1 @max-xs:hidden")}
            data-testid="composer-working-text"
          >
            <span className={live ? "text-agent" : undefined}>{rail.leadLabel}</span>
            {live ? (
              tail
            ) : (
              <span className="@max-lg:hidden" data-testid="composer-working-tail">
                {tail}
              </span>
            )}
          </span>
          {live && rail.active && <RespondingDots />}
          {!live && (
            // 한정 문장은 작은 단(11)으로 선다: 12에서는 277px이라 지원하는 가장 좁은 폭(320, 칸 안쪽 272)에 전문이 못 든다. 11에서는
            // 254px라 에이전트 글이 0으로 양보한 자리(간격 8 포함 262)에 전문이 들어간다. 문장은 한 상수(`TURN_STALE_SENTENCE`)
            // 그대로다: 보이는 글과 읽히는 글이 달라지지 않는다.
            <span className="min-w-0 truncate text-timestamp text-warn" data-testid="composer-working-stale">
              {TURN_STALE_SENTENCE}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        // `popover-fit`: 폭 384 고정이 폰 폭에서 화면 밖으로 나가던 것(390에서 2px, 360에서 32px, 320에서 72px)을 Radix가 주는
        // 남은 폭에 묶는다(design-review r1 B2). 행의 글은 줄어들고 경과(「3분째」)는 줄지 않는다.
        className="popover-fit p-2"
        data-testid="composer-working-popover"
      >
        <p className="px-2 py-1 text-meta text-ink-muted">일하는 에이전트</p>
        <ul className="flex flex-col" aria-label="일하는 에이전트">
          {rail.agents.map((agent) => (
            <li key={agent.key}>
              <RailAgentRow
                agent={agent}
                directory={directory}
                channelId={channelId}
                openerRef={triggerRef}
                onOpened={() => setOpen(false)}
              />
            </li>
          ))}
        </ul>
        <div className="mt-1 flex border-t border-line pt-1">
          <button
            type="button"
            data-testid="composer-working-activity"
            className="tap-target rounded-md px-2 py-1 text-meta font-medium text-ink press hover:bg-surface-hover focus-visible:focus-ring"
            onClick={() => {
              setOpen(false);
              openAdeDrawer(triggerRef.current);
            }}
          >
            활동 보기
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * 레일의 그림. 칸은 `rail`이 없어도 선다(높이 예약). 이 컴포넌트는 순수하다: 같은 입력이면 같은
 * 마크업이고, 시험이 이 마크업을 그대로 실제 브라우저에 올려 높이를 잰다.
 */
export function ActivityRailView({
  rail,
  live,
  directory,
  channelId,
}: {
  rail: ActivityRail | null;
  live: boolean;
  directory: Directory;
  channelId: string;
}) {
  return (
    <div
      className={RAIL_SHELL_CLASS}
      data-testid="composer-working"
      data-state={rail === null ? "idle" : "active"}
      data-live={live ? "" : undefined}
    >
      {rail !== null && (
        <RailLine rail={rail} live={live} directory={directory} channelId={channelId} />
      )}
    </div>
  );
}

/**
 * 컴포저가 꽂는 레일. 이 채널의 열린 턴을 읽어 코어 모델로 한 줄을 만든다.
 *
 * 시계(`useTickingNow`)는 **이 컴포넌트 안에** 있다: 컴포저 전체가 매초 다시 그려지지 않는다.
 * 줄의 글자는 시간에 따라 바뀌지 않으므로 이 시계가 하는 일은 낡은 신호를 걷어내고 「아직 받지 않았어요」
 * 유예를 넘은 run을 레일에서 빼는 것뿐이다.
 *
 * `reserved`: 에이전트가 있는 채널이라 칸을 미리 잡는가(컴포저가 폼 여백을 맞추려고 같은 판정을
 * 쓴다). 에이전트가 없는 채널에 턴이 생기는 드문 경우에도 줄은 선다.
 */
export function ComposerActivityRail({
  channelId,
  directory,
  reserved,
  live,
}: {
  channelId: string;
  directory: Directory;
  reserved: boolean;
  live: boolean;
}) {
  const signals = useAgentWorkingSignals();
  const nowMs = useTickingNow(hasChannelTurn(signals, channelId) && live);
  const approvalWaits = useApprovalWaits();
  // 승인 원장이 레일보다 이긴다(#3738): 이 채널에서 사람을 기다리는 카드가 있으면 그 에이전트는 승인 대기다.
  const turns = applyApprovalWaits(
    agentTurnsInChannel(signals, channelId, nowMs),
    channelId,
    approvalWaits,
    nowMs
  );
  const rail = activityRail(
    turns,
    (memberId) => memberNameParts(directory, memberId, UNKNOWN_AGENT_NAME),
    nowMs
  );
  if (!reserved && rail === null) return null;
  return <ActivityRailView rail={rail} live={live} directory={directory} channelId={channelId} />;
}
