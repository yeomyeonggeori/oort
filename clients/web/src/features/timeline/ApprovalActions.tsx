import { useContext, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { refreshProfileAfterApproval } from "@momo/core/features/approvals/profileChange";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { useSession } from "@/app/session";
import {
  decideApproval,
  newDecisionId,
  type DecisionOutcome,
} from "@momo/core/features/timeline/approvalDecision";
import type { SpawnExecutionPlan } from "@momo/core/lib/executionPlan";
import {
  decisionHostId,
  preselectedHostId,
  spawnHostGate,
} from "@momo/core/features/timeline/spawnHostChoice";
import { SpawnHostChoice } from "./SpawnHostChoice";
import { CopyButton } from "@/features/settings/SettingsFields";
import type { SecretOnce } from "@momo/core/features/approvals/secretOnce";

// =============================================================================
// 승인 결정 컨트롤 (R-1 §4, goal B5.3b D-5).
//
// Lifted out of AgentCard because a SECOND surface now decides approvals: the
// inbox 결정 대기 목록 (`GET …/approvals?status=pending`). Two implementations of
// "approve or reject" would mean two idempotency policies, two ways to word a
// 409, and the one that is not being looked at is the one that drifts. So the
// card and the list share this, and the only thing that varies is the sentence
// in front of the buttons.
//
// The rules it carries:
//   - one idempotency key per (row, direction), reused across retries, dropped
//     only on an idempotency conflict so the retry mints a fresh one;
//   - **한 번 누르면 결정된다** (#3819, 성재 2026-10-14: 「승인을 누르면 그냥
//     승인이 되게 해줘 또 확정 같은 거 누르지 않아도 되게」). 이 파일이 오래
//     지키던 2단(승인/거부가 무장하고 두 번째 누름이 확정)은 걷혔다. 실수 방지는
//     눌리기 **전에** 카드가 보여 주는 사실 — 영향(되돌릴 수 있는가), 결정 권한,
//     접근을 넓히는 행의 경고, 고른 호스트 — 가 지고, 누르는 순간부터는 멱등
//     키와 `busy` 가 같은 결정이 두 번 나가는 것을 막는다;
//   - a rejection is stated inline, never as a toast.
//
// ## 눌린 뒤의 화면
//
// 누른 버튼은 `disabled` 가 아니라 `aria-disabled` + 「보내는 중」으로 선다.
// 네이티브 `disabled` 는 초점을 body 로 떨어뜨려, 실패했을 때 다시 누를 자리를
// 키보드 사용자가 잃는다. 대신 `commit` 이 `busy` 를 먼저 거른다.
//
// ## 긴 누름
//
// 2R 의 `event.repeat` 거절은 확정 버튼에서 승인/거부 버튼으로 옮겨 왔다. 이제 한
// 번의 누름이 곧 결정이므로, 눌린 채 반복된 Enter 가 결정의 **재시도**처럼 보이게
// 두지 않는다(첫 keydown 이 이미 결정을 보냈고, 반복은 두 번째 의도가 아니다).
// =============================================================================

/**
 * 시간 게이트가 남아 있는 확정 컨트롤의 시간 (ms).
 *
 * **승인 카드·인박스·로그인 핸드오프는 이제 이 값을 쓰지 않는다** (#3819, 한 번에
 * 결정). 아직 읽는 곳은 작업 세션의 권한 카드(`AgentProgressView`, 「이번만 허용 /
 * 세션 동안 허용」의 2단) 하나다. 그 표면은 이 이슈의 범위 밖이라 값과 이름을
 * 그대로 둔다.
 */
export const CONFIRM_GUARD_MS = 400;

/**
 * Suffix of the control whose handler reads `CONFIRM_GUARD_MS`. Capture keys the
 * time-gate on that button, so a rename of this suffix moves the markup and the
 * registry together.
 */
const TIME_GATED_CONTROL_SUFFIX = "commit";

/** Test id of the interactive element `CONFIRM_GUARD_MS` actually gates. */
// eslint-disable-next-line react-refresh/only-export-components -- same registry helper as TIME_GATED_CONTROLS; a rename must move with the markup.
export function timeGatedTestId(testIdPrefix: string): string {
  return `${testIdPrefix}-${TIME_GATED_CONTROL_SUFFIX}`;
}

/**
 * Click targets gated by `CONFIRM_GUARD_MS`. Capture consults this list under
 * `clock: "fixed"`. Derived from the same helper the commit button uses for
 * `data-testid`, so a rename cannot drift. 승인 결정 컨트롤은 한 번에 결정되므로
 * 여기에 없다 — 남은 것은 작업 세션 권한 카드뿐이다.
 */
// eslint-disable-next-line react-refresh/only-export-components -- allowConstantExport covers CONFIRM_GUARD_MS 리터럴만; as const 배열은 같은 자리의 레지스트리다.
export const TIME_GATED_CONTROLS = [
  // A 칸 권한 카드(#2779, workbench/agent/AgentProgressView). 같은 400ms 무장 간격.
  timeGatedTestId("agent-permission"),
] as const;

/**
 * 결정이 스스로를 부르는 이름 (LIVE-4).
 *
 * 로그인 핸드오프 카드는 같은 승인 원장에 같은 REST 로 결정하면서 「재개/중단」이라고
 * 부른다. 그것을 위해 두 번째 결정 컨트롤을 짓지 않는다: 멱등 정책이 둘, 409 문장이
 * 둘이 되고, 보지 않는 쪽이 낡는다. 갈라지는 것은 두 낱말뿐이다.
 */
export interface DecisionVerbs {
  approve: string;
  reject: string;
}

// eslint-disable-next-line react-refresh/only-export-components -- 이 파일의 다른 상수 내보내기와 같은 자리의 어휘표다.
export const APPROVAL_VERBS: DecisionVerbs = {
  approve: "승인",
  reject: "거부",
};

/**
 * 1회 값이 사는 **유일한 화면 자리** (ADR-0186 D4 · ADR-0182 ①).
 *
 * ## 왜 이 컴포넌트에는 상태가 없는가
 *
 * 값은 호출자(`AgentCard` 의 `ApprovalBody`)의 React state 에 있고 이 함수는
 * 받아서 그린다. 그래야 하는 이유가 이 카드의 생애에 있다: 결정이 확정되면
 * 승인 카드의 footer 가 컨트롤에서 **영수증 줄**로 바뀌고 `ApprovalActions` 는
 * 언마운트된다. 값을 여기 두면 그려야 할 바로 그 순간에 사라진다.
 *
 * 그리고 그것이 전부다 — props 도 store 도 localStorage 도 URL 도 아니다.
 * 새로고침하면 호출자의 state 와 함께 사라지고, 그 뒤에 남는 것은 영속 카드의
 * 「1회 표시됐어요 · 다시 만드세요」뿐이다(부록 B). 값을 살아남게 만드는
 * 구현이 D4 가 이름으로 금지한 위반이다.
 *
 * 복사 컨트롤은 설정의 것을 그대로 든다(`CopyButton` → `useClipboardCopy` →
 * `useInlineConfirm`). 두 번째 복사 버튼을 지으면 「복사됨」이 언제 풀리는지가
 * 두 벌이 되고, ADR-0182 D5 의 1.6s 는 그중 한 벌에만 남는다.
 */
export const LINK_ONCE_LEAD =
  "이 링크는 이 화면에서만 볼 수 있어요. 지금 전달하세요.";

export function LinkOnce({
  secret,
  testIdPrefix = "approval",
  className,
}: {
  secret: SecretOnce;
  testIdPrefix?: string;
  className?: string;
}) {
  const leadId = useId();
  const regionRef = useRef<HTMLDivElement | null>(null);

  // ## 확정이 초점을 버리던 자리 (design-review R1 H2)
  //
  // 확정에 성공하면 승인 카드의 footer 가 컨트롤에서 영수증+링크로 바뀌면서
  // `ApprovalActions` 가 통째로 언마운트된다. 그 순간 초점은 `document.body` 로
  // 떨어졌고(두 폭 실측), 키보드 사용자는 **링크가 나타난 바로 그 순간** 셸
  // 처음부터 Tab 으로 되돌아와야 했다. 앞 판에도 같은 유실이 있었지만 그때 그
  // 자리에는 누를 것이 없었다 — 이 배치가 거기에 복사 버튼을 세웠다.
  //
  // 그래서 이 영역이 마운트되면 **자기 자신**으로 초점을 가져온다. 복사 버튼이
  // 아니라 컨테이너인 이유: 초점이 그룹에 앉으면 접근성 이름(`aria-labelledby`
  // → lead 문장)이 먼저 읽히고, 그다음 Tab 한 번이 복사 버튼이다. 버튼에 바로
  // 앉히면 「이 화면에서만 볼 수 있어요」를 듣기 전에 「복사」부터 듣는다.
  useEffect(() => {
    regionRef.current?.focus();
  }, []);

  return (
    <div
      ref={regionRef}
      tabIndex={-1}
      role="group"
      aria-labelledby={leadId}
      className={cn("px-3 py-2 focus-visible:focus-ring", className)}
      data-testid={`${testIdPrefix}-link-once`}
    >
      {/* `role=status` 가 아니다 (R1 N1). 승인 직후 이 카드에는 영수증 줄이 이미
          라이브 리전으로 서 있고, 둘이 함께 낭독되면 두 문장이 겹쳐 들린다.
          이 문장은 **초점이 이 그룹에 앉을 때** 접근성 이름으로 읽힌다 — 같은
          한 번, 같은 내용, 겹침 없음. */}
      <p id={leadId} className="break-keep text-body text-ink">
        {LINK_ONCE_LEAD}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {/* ## 잘린 1회 값은 잘린 것이다 (R1 B1)
            
            앞 판은 `truncate` 였고 390 에서 실측 scrollWidth 296 / clientWidth
            237 로 코드 꼬리가 말줄임에 먹혔다. 「지금 전달하세요」라고 말하면서
            전달할 값을 보여 주지 않는 화면이다.
            
            `break-all` 이 맞는 이유: 이 값은 **라틴 URL** 이다. 스킬 §5.3 이
            `break-all` 을 경고하는 대상은 한글 본문이고(음절 중간에서 끊긴다),
            여기서는 끊을 자리가 없는 한 덩어리 ASCII 라 그 경고가 겨냥하는 결함이
            생기지 않는다. `select-all` 은 복사 버튼을 못 쓰는 경우(클립보드 권한
            거부)에 한 번의 클릭으로 전체를 고르게 한다.
            
            `flex-1` 에서 `w-full` 로 바꾸지 않은 이유: 1280 에서는 값과 버튼이
            한 줄에 서는 것이 맞고(실측 559/559, 잘리지 않는다), 좁아지면
            `flex-wrap` 이 버튼을 아랫줄로 내린다. */}
        <span
          data-numeric
          data-testid={`${testIdPrefix}-link-once-value`}
          className="min-w-0 flex-1 select-all break-all font-mono text-meta text-ink"
        >
          {secret.value}
        </span>
        {/* 600px 미만에서 44px 로 자란다 (R1 M6). 이 버튼은 이 순간 사람이
            반드시 눌러야 하는 하나이고, `sm` 은 28px 에서 멈춘다. */}
        <CopyButton
          value={secret.value}
          subject="초대 링크"
          testId={`${testIdPrefix}-link-once-copy`}
          className="tap-target"
        />
      </div>
    </div>
  );
}

type Direction = "approve" | "reject";

export function ApprovalActions({
  approvalId,
  onSettled,
  lead = "이 작업은 승인이 필요해요.",
  className,
  testIdPrefix = "approval",
  execution = null,
  verbs = APPROVAL_VERBS,
  forbiddenCopy = null,
  decisionLabel,
}: {
  approvalId: string;
  onSettled: (outcome: DecisionOutcome) => void;
  /** The sentence in front of the buttons. */
  lead?: string;
  className?: string;
  /**
   * Test ids are prefixed so a row in a list and a card in the timeline can be
   * on screen at once without two elements answering to one hook.
   */
  testIdPrefix?: string;
  /**
   * 이 승인이 **어디서 실행할지**까지 묻는가 (ADR-0125 D6-A, 이슈 1114).
   *
   * `null`이 압도적 다수다. 픽커가 붙는 순간 이 컨트롤이 지는 것이 하나 늘어나는데,
   * 그것은 라디오 하나가 아니라 **결정의 목적지**다 — 그래서 여기 있다.
   */
  execution?: SpawnExecutionPlan | null;
  /**
   * 이 결정을 무엇이라 부르는가. 기본은 승인/거부이고, 로그인 핸드오프 카드만
   * 재개/중단으로 바꿔 든다 — 낱말만이고 계약은 그대로다(`DecisionVerbs`).
   */
  verbs?: DecisionVerbs;
  /**
   * 403 일 때 이 카드가 대신 할 말 (ADR-0186 §5).
   *
   * 기본 문장("채널 멤버인지 확인해 주세요")은 도구 호출 승인의 것이고 지금도
   * 옳다. 워크스페이스 행동 승인만 다른 사실을 안다 — 부록 A 가 `required_role`
   * 을 실어 보냈으므로, 이 403 에서 모자란 것은 멤버십이 아니라 **역할**이다.
   */
  forbiddenCopy?: string | null;
  /** 같은 화면의 제안이 여러 개여도 어떤 결정인지 접근성 이름에 남겨요. */
  decisionLabel?: string;
}) {
  // workspaceId comes from session context rather than a prop chain: both
  // callers sit several components below the shell.
  const { workspaceId, replaceSessionMember } = useSession();
  const queryClient = useContext(QueryClientContext);
  /** 지금 서버에 나가 있는 결정의 방향. 없으면 `null`. */
  const [sending, setSending] = useState<Direction | null>(null);
  /** 같은 틱의 두 번째 누름을 거르는 동기 문. state 는 다음 렌더에야 바뀐다. */
  const sendingRef = useRef(false);
  const [errorCopy, setErrorCopy] = useState<string | null>(null);
  const [errorTone, setErrorTone] = useState<"error" | "unavailable">("error");
  const keysRef = useRef<{ approve?: string; reject?: string }>({});

  // ---- 호스트 선택 (이슈 1114) --------------------------------------------------
  //
  // `null`은 "아직 아무것도 안 골랐다"가 아니라 **"사람이 손대지 않았다"**이다.
  // 그래서 찍혀 있는 것은 언제나 코어가 답하는 기본값이고, 사람이 라디오를 눌러야
  // 이 state가 값을 갖는다. 손대지 않았으면 키를 안 싣고(서버가 카드의 기본값을
  // 적용한다), 손댔으면 명시적으로 싣는다.
  const [pickedHostId, setPickedHostId] = useState<string | null>(null);
  /** 「고를 것이 없다」 문장의 id. 승인 버튼이 `aria-describedby`로 되짚는다. */
  const blockedId = useId();
  const defaultHostId = preselectedHostId(execution);
  const chosenHostId = pickedHostId ?? defaultHostId;
  const hostGate = spawnHostGate(execution);
  const busy = sending !== null;

  async function commit(direction: Direction) {
    if (sendingRef.current) return;
    // 실행할 호스트가 하나도 없으면 승인은 나가지 않는다. 서버가 409로 답할 것을
    // 결정 전에 알고 있고(코어 `spawnHostGate`), 그것을 알면서 요청을 보내는 것은
    // 헛걸음이다. **거부는 막지 않는다** — 서버도 거부에는 호스트를 묻지 않고,
    // 실행할 수 없는 요청을 정리할 길까지 닫을 이유는 없다.
    if (direction === "approve" && !hostGate.canApprove) return;
    const approve = direction === "approve";
    keysRef.current[direction] ??= newDecisionId();
    sendingRef.current = true;
    setSending(direction);
    setErrorCopy(null);
    try {
      const outcome = await decideApproval(
        workspaceId,
        approvalId,
        approve,
        keysRef.current[direction],
        // 픽커가 없으면 `undefined`이고, 그때 키는 본문에 실리지 않는다. 서버는
        // 픽커 없는 승인에 실린 `hostId`를 400으로 거절한다 — 그 거절이 옳다.
        decisionHostId(execution, chosenHostId)
      );
      if (outcome.kind === "error") {
        if (outcome.errorCode === "idempotency_conflict") {
          delete keysRef.current[direction];
        }
        // 2R M1: 같은 404를 목록은 조용히 접는데 이 줄만 빨갛게 그리면, 한 화면이
        // 같은 사실을 두 색으로 말한다. tone은 core의 판정에서 받는다.
        setErrorTone(
          outcome.errorCode === "surface_absent" ? "unavailable" : "error"
        );
        // 역할이 모자란 403 은 사고가 아니다. 승인은 여전히 대기이고(§5), 사람이
        // 할 수 있는 다음 행동이 있다 — 그래서 붉은 alert 이 아니라 조용한
        // 안내로 서고, 문장은 호출자가 아는 사실에서 온다. `role_required` 는
        // 서버가 이름을 댄 것이고 `forbidden` 은 이름 없는 403 이다(AX-3b #2549).
        if (
          (outcome.errorCode === "role_required" ||
            outcome.errorCode === "forbidden") &&
          forbiddenCopy !== null
        ) {
          setErrorTone("unavailable");
          setErrorCopy(forbiddenCopy);
          // 버튼은 그대로 남는다 — 카드는 여전히 대기이고 다른 사람이 이어받을 수
          // 있다. 눌린 버튼은 `aria-disabled` 였을 뿐 초점을 잃지 않았으므로 초점도
          // 그 자리에 있다.
          return;
        }
        setErrorCopy(outcome.errorCopy ?? "결정을 처리하지 못했어요.");
        return;
      }
      // 성공하면 호출자가 이 컨트롤을 영수증 줄로 바꾸면서 언마운트한다. 초점은
      // 호출자가 받는다(카드의 영수증/1회 링크, 목록의 다음 행).
      onSettled(outcome);
      void refreshProfileAfterApproval(outcome, replaceSessionMember, (workspace, rows) => {
        queryClient?.setQueryData(["roster", workspace], rows);
      });
    } finally {
      sendingRef.current = false;
      setSending(null);
    }
  }

  /** 눌린 채 반복된 keydown 은 두 번째 결정이 아니다. */
  const swallowRepeat = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.repeat) event.preventDefault();
  };

  return (
    <div
      // `tabIndex={-1}` 로 호출자가 초점을 내려놓을 수 있는 자리라 링이 있어야 한다.
      className={cn("px-3 py-2 focus-visible:focus-ring", className)}
      tabIndex={-1}
    >
      {/* 픽커가 붙으면 **묻는 말이 먼저 온다** (design-review M4). */}
      {execution !== null && (
        <p className="pb-2 text-meta text-ink-muted">{lead}</p>
      )}
      {/* 픽커는 결정 중에 잠긴다 — 고른 것이 나가는 요청과 달라지지 않게. */}
      {execution !== null && (
        <SpawnHostChoice
          plan={execution}
          pickedHostId={chosenHostId}
          onPick={setPickedHostId}
          locked={busy}
          blockedId={blockedId}
          testIdPrefix={testIdPrefix}
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {execution === null ? (
          lead ? <span className="text-meta text-ink-muted">{lead}</span> : null
        ) : (
          // 픽커가 있으면 `lead`는 이미 위에 있다. 자리는 남겨 둬야 버튼이
          // 오른쪽에 붙는다(`justify-between`).
          <span />
        )}
        <span className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            aria-disabled={busy || undefined}
            data-busy={sending === "reject" ? "" : undefined}
            data-decision="reject"
            aria-label={decisionLabel ? `${decisionLabel} ${verbs.reject}` : undefined}
            data-testid={`${testIdPrefix}-reject`}
            onKeyDown={swallowRepeat}
            onClick={() => void commit("reject")}
          >
            {sending === "reject" ? "보내는 중" : verbs.reject}
          </Button>
          {/* ## 막힌 승인은 **모양을 바꾸지 투명해지지 않는다** (design-review H1)

              호스트가 하나도 없어 승인할 수 없을 때 앞 판은 `disabled`였다.
                - `disabled:opacity-50`이 채움 버튼에 걸리면 「승인」 글자가
                  **2.23:1**이 된다. tokens.md §5b가 이 정확한 실패를 이름으로
                  적어 둔 그 숫자다.
                - 네이티브 `disabled` 버튼은 **초점을 받지 못한다**. 키보드나
                  보이스오버로 이 행을 지나는 사람은 막힌 컨트롤을 아예 만나지
                  못하고, 그래서 왜 승인할 수 없는지도 듣지 못한다.

              그래서 실제로 할 수 없을 때는 **조용한 형태로 강등**하고(채움을
              버리는 것이 곧 "지금은 이것이 기본 액션이 아니다"라는 말이다),
              `aria-disabled`로 상태만 알린 뒤 초점은 남긴다. 이유는
              `aria-describedby`가 픽커 아래 문장을 가리켜 초점이 닿는 순간 함께
              읽힌다. 누름은 `commit()`이 거절한다 — 화면과 같은 판정으로. */}
          <Button
            size="sm"
            variant={hostGate.canApprove ? "default" : "outline"}
            className={cn(!hostGate.canApprove && "text-ink-muted")}
            aria-disabled={busy || !hostGate.canApprove || undefined}
            aria-describedby={hostGate.canApprove ? undefined : blockedId}
            data-blocked={hostGate.canApprove ? undefined : ""}
            data-busy={sending === "approve" ? "" : undefined}
            data-decision="approve"
            aria-label={decisionLabel ? `${decisionLabel} ${verbs.approve}` : undefined}
            data-testid={`${testIdPrefix}-approve`}
            onKeyDown={swallowRepeat}
            onClick={() => void commit("approve")}
          >
            {sending === "approve" ? "보내는 중" : verbs.approve}
          </Button>
        </span>
      </div>
      {errorCopy !== null && (
        <p
          // 미제공은 사고가 아니므로 alert으로 끼어들지도, 빨갛지도 않다.
          role={errorTone === "error" ? "alert" : "status"}
          data-testid={`${testIdPrefix}-error`}
          data-tone={errorTone}
          className={cn(
            "pt-2 text-meta",
            errorTone === "error" ? "text-danger" : "text-ink-muted"
          )}
        >
          {errorCopy}
        </p>
      )}
    </div>
  );
}

/**
 * 카드의 y/n 단축키는 한 번에 결정하지 않고 **결정 버튼에 초점을 놓는다**. 키 하나로
 * 되돌릴 수 없는 결정이 나가지 않게, Enter/Space 가 결정을 만든다. 마우스는 한 번의
 * 누름이고, 키보드는 y/n 한 번과 Enter 한 번이다. 결정 컨트롤이 없으면(이미 결정됨)
 * 아무 일도 없다.
 */
// eslint-disable-next-line react-refresh/only-export-components -- 컴포넌트와 한 쌍인 초점 헬퍼다.
export function focusDecisionControl(
  scope: HTMLElement | null,
  which: Direction
): void {
  scope
    ?.querySelector<HTMLButtonElement>(`[data-decision="${which}"]`)
    ?.focus();
}
