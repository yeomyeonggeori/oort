import { useEffect, useRef, useState } from "react";
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
  findCandidate,
  preselectedHostId,
  spawnDestinationClause,
  spawnHostGate,
} from "@momo/core/features/timeline/spawnHostChoice";
import { SpawnHostChoice } from "./SpawnHostChoice";

// =============================================================================
// 승인 결정 컨트롤 (R-1 §4, goal B5.3b D-5).
//
// Lifted out of AgentCard because a SECOND surface now decides approvals: the
// inbox 결정 대기 목록 (`GET …/approvals?status=pending`). Two implementations of
// "approve or reject" would mean two idempotency policies, two confirm rules and
// two ways to word a 409, and the one that is not being looked at is the one
// that drifts. So the card and the list share this, and the only thing that
// varies is the sentence in front of the buttons.
//
// The rules it carries, unchanged from the card:
//   - one idempotency key per (row, direction), reused across retries, dropped
//     only on an idempotency conflict so the retry mints a fresh one;
//   - no decision fires on a single unguarded click: 승인/거부 arms, the second
//     press commits (design-taste-web §6, confirm in place rather than in a
//     modal so the question stays next to the evidence);
//   - a rejection is stated inline, never as a toast.
//
// ## 2R: 2단 무장은 키보드에서 1단이었다
//
// 무장하면 초점이 확정 버튼으로 옮겨 간다(H2 수정의 잔재). 그 자체는 옳지만, 그
// 결과로 **Enter를 누르고 있으면** 키 반복이 무장 직후의 확정 버튼에 그대로
// 떨어졌다: 한 번의 길게 누름이 승인/거부를 관통한다. 되돌릴 수 없는 액션에서
// 그것은 2단 확인이 없는 것과 같다.
//
// 두 겹으로 막는다:
//   (a) `CONFIRM_GUARD_MS` — 무장 직후 그 시간 동안 확정을 받지 않는다. 사람이
//       두 번째 의도를 갖기까지 걸리는 시간이고, 모바일이 같은 결함을 같은 값으로
//       막는다.
//   (b) `repeat` 거부 — 눌린 채로 반복 발생한 keydown은 두 번째 **의도**가 아니라
//       하나의 누름이다. (a)만 두면 400ms를 넘긴 긴 누름이 여전히 관통한다.
// =============================================================================

export type Armed = "approve" | "reject" | null;

/**
 * 무장 직후 확정을 받지 않는 시간.
 *
 * 이 값에 근거가 있어야 한다: 너무 짧으면 키 반복(보통 첫 반복까지 ~500ms,
 * 이후 ~30ms 간격)을 못 막고, 너무 길면 진짜로 빠르게 결정하려는 사람에게
 * "버튼이 안 먹는다"가 된다. 400ms는 모바일 승인 경로가 같은 결함에 대해 쓰는
 * 값이고, 여기서 다른 값을 고르면 같은 제품의 같은 액션이 플랫폼마다 다른
 * 안전 간격을 갖게 된다.
 */
export const CONFIRM_GUARD_MS = 400;

/**
 * 확정 문장 정본 (2R 오케스트레이터 결정).
 *
 * **"바로 실행합니다"를 쓰지 않는다.** 계약이 지킬 수 없는 약속이었기 때문이다:
 * 승인은 `routes/approvals.rs`의 `approve_run`에서 재개 job을 outbox로 넣고, 그
 * 재개는 비동기다. 게다가 실행이 락과 그 사이에 hold를 떠났으면 job은 아예 들어가지
 * 않고 200만 돌아온다. 즉 "바로"도 "실행"도 보장되지 않는다. 승인이 보장하는 것은
 * **사람이 허가했고 그 허가가 기록됐다**는 것과, 그 뒤 에이전트가 이어서 간다는
 * 것뿐이다.
 */
export function approveConfirmCopy(reversible: boolean | undefined): string {
  const base = "승인하면 에이전트가 이어서 진행합니다.";
  // `undefined`는 "모른다"이고, 되돌릴 수 없는 액션 계열에서 모름은 경고 쪽에
  // 붙는다. 서버가 위험도를 싣지 않았다고 안전하다고 말할 수는 없다.
  return reversible === true ? base : `${base} 되돌릴 수 없습니다.`;
}

/**
 * 스폰 승인의 확정 문장 — **목적지가 문장 안에 있다** (이슈 1114).
 *
 * 확정 화면에서 라디오는 잠긴다. 잠긴 컨트롤을 다시 읽어 목적지를 확인하게 하는
 * 대신, 사람이 지금 누르려는 버튼 바로 위에서 어디로 가는지 말한다. 호스트 이름을
 * 모를 때(자격 후보가 없어 아무것도 찍히지 않은 경우) 목적지 절은 통째로 빠진다 —
 * 「어딘가에서 실행합니다」는 문장이 아니라 소음이다.
 */
export function spawnApproveConfirmCopy(
  hostName: string | null,
  reversible: boolean | undefined
): string {
  const base = approveConfirmCopy(reversible);
  return hostName === null
    ? base
    : `${spawnDestinationClause(hostName)} ${base}`;
}

/**
 * 거부 확정 문장 — **모바일과 같은 한 문장** (2R 지적 N1).
 *
 * 앞 판의 웹 문장은 "거부하면 이 실행은 이어지지 않습니다."였다. 참이지만 모바일이
 * 실측해 landing한 문장과 달랐고, 같은 제품이 같은 액션 앞에서 두 문장을 말하면
 * 둘 중 하나는 반드시 낡는다.
 *
 * 모바일의 문장이 더 낫기도 하다. 「대기 중인」이라는 한정어가 이 계약을 정확히
 * 그린다: 거부는 결정과 **같은 트랜잭션**에서 실행을 취소하지만
 * (`reject_run` → `end_parked_run_in_tx`), 그 UPDATE는
 * `WHERE status='awaiting_approval'`로 가드돼 있어 hold를 떠난 run은 취소 대상이
 * 아니다. 한정어 없는 "이 실행이 취소됩니다"는 그 경우에 거짓이 되고, 한정어가
 * 붙으면 무조건 참이 되면서 무슨 일이 일어나는지까지 말한다.
 */
export const REJECT_CONFIRM = "거부하면 대기 중인 실행이 취소됩니다.";

export function ApprovalActions({
  approvalId,
  armed,
  setArmed,
  onSettled,
  lead = "이 작업은 승인이 필요합니다.",
  className,
  testIdPrefix = "approval",
  reversible = true,
  execution = null,
}: {
  approvalId: string;
  armed: Armed;
  setArmed: (armed: Armed) => void;
  onSettled: (outcome: DecisionOutcome) => void;
  /** The sentence in front of the buttons before either one is armed. */
  lead?: string;
  className?: string;
  /**
   * Test ids are prefixed so a row in a list and a card in the timeline can be
   * on screen at once without two elements answering to one hook.
   */
  testIdPrefix?: string;
  /**
   * M2(design-review): 비가역 승인이면 확정 문장이 그 사실을 재진술한다.
   *
   * 2R: **`undefined`는 "모른다"이고, 모르면 경고한다.** 서버가 위험도를 싣지
   * 않은 승인을 되돌릴 수 있다고 가정하는 것은, 되돌릴 수 없는 액션 계열에서
   * 할 수 있는 가장 나쁜 기본값이다(server-rust `ApprovalDto` 주석도 같은 말을
   * 한다: "absent `isReversible`를 reversible로 읽지 마라").
   */
  reversible?: boolean;
  /**
   * 이 승인이 **어디서 실행할지**까지 묻는가 (ADR-0125 D6-A, 이슈 1114).
   *
   * `null`이 압도적 다수다. 픽커가 붙는 순간 이 컨트롤이 지는 것이 하나 늘어나는데,
   * 그것은 라디오 하나가 아니라 **결정의 목적지**다 — 그래서 여기 있다. 픽커를
   * 카드 본문에 두고 결정만 이 파일이 지면, 두 조각은 서로 다른 컴포넌트의 state에
   * 살면서 「무장했으니 잠근다」와 「고른 것을 싣는다」를 각자 기억해야 한다.
   * 세 번째 표면(폰)이 같은 계약을 다시 지어야 하는 것도 그때부터다.
   */
  execution?: SpawnExecutionPlan | null;
}) {
  // workspaceId comes from session context rather than a prop chain: both
  // callers sit several components below the shell.
  const { workspaceId } = useSession();
  const [busy, setBusy] = useState(false);
  const [errorCopy, setErrorCopy] = useState<string | null>(null);
  const [errorTone, setErrorTone] = useState<"error" | "unavailable">("error");
  /** 가드에 걸린 누름을 말하는 줄 (2R N-C). 무장할 때마다 지워진다. */
  const [tooFast, setTooFast] = useState(false);
  const keysRef = useRef<{ approve?: string; reject?: string }>({});
  /** 무장한 시각. 확정이 그 뒤 `CONFIRM_GUARD_MS`를 기다렸는지 재는 기준. */
  const armedAtRef = useRef<number>(0);

  // ---- 호스트 선택 (이슈 1114) --------------------------------------------------
  //
  // `null`은 "아직 아무것도 안 골랐다"가 아니라 **"사람이 손대지 않았다"**이다.
  // 그래서 찍혀 있는 것은 언제나 코어가 답하는 기본값이고, 사람이 라디오를 눌러야
  // 이 state가 값을 갖는다. 그 구분이 결정 본문을 정한다: 손대지 않았으면 키를
  // 안 싣고(서버가 카드의 기본값을 적용한다), 손댔으면 명시적으로 싣는다.
  const [pickedHostId, setPickedHostId] = useState<string | null>(null);
  const defaultHostId = preselectedHostId(execution);
  const chosenHostId = pickedHostId ?? defaultHostId;
  const hostGate = spawnHostGate(execution);
  const chosenHostName =
    findCandidate(execution, chosenHostId)?.displayName ?? null;

  async function commit(approve: boolean) {
    if (busy) return;
    // (a) 무장 직후의 확정은 두 번째 의도가 아니다.
    //
    // 조용히 삼키지 않는다(2R N-C). 아무 일도 일어나지 않는 버튼은 고장난 버튼과
    // 구별되지 않고, 그 자리에서 사람이 하는 다음 행동은 더 세게 다시 누르는
    // 것이다. 무엇이 일어났는지 한 줄로 말한다 — 모바일이 같은 가드에 대해 하는
    // 것과 같은 말이다(`ApprovalDecision.tsx`의 `too-fast`).
    if (Date.now() - armedAtRef.current < CONFIRM_GUARD_MS) {
      setTooFast(true);
      return;
    }
    setTooFast(false);
    const slot = approve ? "approve" : "reject";
    keysRef.current[slot] ??= newDecisionId();
    setBusy(true);
    setErrorCopy(null);
    try {
      const outcome = await decideApproval(
        workspaceId,
        approvalId,
        approve,
        keysRef.current[slot],
        // 픽커가 없으면 `undefined`이고, 그때 키는 본문에 실리지 않는다. 서버는
        // 픽커 없는 승인에 실린 `hostId`를 400으로 거절한다 — 그 거절이 옳다.
        decisionHostId(execution, chosenHostId)
      );
      if (outcome.kind === "error") {
        if (outcome.errorCode === "idempotency_conflict") {
          delete keysRef.current[slot];
        }
        // 2R M1: 같은 404를 목록은 조용히 접는데 이 줄만 빨갛게 그리면, 한 화면이
        // 같은 사실을 두 색으로 말한다. tone은 core의 판정에서 받는다.
        setErrorTone(
          outcome.errorCode === "surface_absent" ? "unavailable" : "error"
        );
        setErrorCopy(outcome.errorCopy ?? "결정을 처리하지 못했습니다.");
        return;
      }
      // 2R M6: 확정에 성공하면 확정 버튼이 언마운트된다. 무장 때 고쳤던 것과
      // **같은 결함**이 반대편에 남아 있었다: 초점이 body로 떨어져, 키보드
      // 사용자는 방금 결정한 자리를 잃고 문서 맨 위에서 다시 Tab을 시작한다.
      focusAfterArmChange.current = "root";
      setArmed(null);
      onSettled(outcome);
    } finally {
      setBusy(false);
    }
  }

  // ---- 초점 (H2 · 2R H2/M6) ------------------------------------------------
  //
  // 이 표면은 무장할 때도 해제할 때도 확정할 때도 **버튼을 언마운트한다**. 그때마다
  // 초점은 body로 떨어지고, 키보드 사용자는 매번 문서 맨 위로 돌아간다. 그래서
  // 세 전이 모두에 목적지가 있어야 한다: 어디로 갈지는 전이를 일으킨 쪽이 적어
  // 두고(`focusAfterArmChange`), 옮기는 것은 렌더 뒤 한 곳에서 한다.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const commitRef = useRef<HTMLButtonElement | null>(null);
  const approveRef = useRef<HTMLButtonElement | null>(null);
  const rejectRef = useRef<HTMLButtonElement | null>(null);
  const focusAfterArmChange = useRef<
    "commit" | "approve" | "reject" | "root" | null
  >(null);

  useEffect(() => {
    const target = focusAfterArmChange.current;
    focusAfterArmChange.current = null;
    if (target === null) return;
    if (target === "commit") commitRef.current?.focus();
    else if (target === "approve") approveRef.current?.focus();
    else if (target === "reject") rejectRef.current?.focus();
    else rootRef.current?.focus();
  }, [armed]);

  function arm(next: Exclude<Armed, null>) {
    // 실행할 호스트가 하나도 없으면 승인은 무장조차 하지 않는다. 서버가 409로
    // 답할 것을 결정 전에 알고 있고(코어 `spawnHostGate`), 그것을 알면서 확정
    // 화면을 세우는 것은 사람에게 헛걸음을 시키는 것이다. **거부는 막지 않는다** —
    // 서버도 거부에는 호스트를 묻지 않고, 실행할 수 없는 요청을 정리할 길까지
    // 닫을 이유는 없다.
    if (next === "approve" && !hostGate.canApprove) return;
    armedAtRef.current = Date.now();
    focusAfterArmChange.current = "commit";
    setTooFast(false);
    setErrorCopy(null);
    setArmed(next);
  }

  /** 무장 해제. 왔던 버튼으로 캐럿을 돌려준다 (다이얼로그와 같은 계약). */
  function disarm() {
    focusAfterArmChange.current = armed === "approve" ? "approve" : "reject";
    setTooFast(false);
    setArmed(null);
  }

  return (
    <div
      className={cn("px-3 py-2", className)}
      ref={rootRef}
      // 확정 뒤 캐럿이 착지할 자리. 목록에서는 이 행이 곧 사라지므로 호출자가
      // 다시 옮기지만(InboxRoute), 카드에서는 여기가 종착지다.
      tabIndex={-1}
      // H2: 되돌릴 수 없는 액션의 확인은 Esc로 취소할 수 있어야 한다. 이 표면은
      // AlertDialog가 아니라 제자리 2단 행이라 그 동작을 공짜로 받지 못한다 —
      // 그래서 직접 단다. 다이얼로그를 Esc로 닫는 손이 여기서만 통하지 않으면,
      // 사람은 무장을 푸는 법을 모른 채 확정 버튼 앞에 남는다.
      onKeyDown={(event) => {
        if (event.key !== "Escape" || armed === null || busy) return;
        event.stopPropagation();
        disarm();
      }}
    >
      {/* 픽커는 무장 여부와 무관하게 자리를 지킨다. 확정 화면에서 사라지면
          사람은 자기가 무엇을 고른 채 확정하는지 볼 수 없고, 확인은 판단의 근거
          옆에 있어야 한다는 이 표면의 원칙이 무너진다. 대신 잠긴다. */}
      {execution !== null && (
        <SpawnHostChoice
          plan={execution}
          pickedHostId={chosenHostId}
          onPick={setPickedHostId}
          locked={armed !== null || busy}
          testIdPrefix={testIdPrefix}
        />
      )}
      {armed === null ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-meta text-ink-muted">{lead}</span>
          <span className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              ref={rejectRef}
              data-testid={`${testIdPrefix}-reject`}
              onClick={() => arm("reject")}
            >
              거부
            </Button>
            <Button
              size="sm"
              ref={approveRef}
              // 진짜로 할 수 없다(tokens §5b): 자격 있는 호스트가 하나도 없으면
              // 서버는 이 승인에 409로 답한다. 이유는 픽커 아래에 이미 서 있으므로
              // 꺼진 버튼이 설명 없이 서 있는 경우가 아니다.
              disabled={!hostGate.canApprove}
              data-testid={`${testIdPrefix}-approve`}
              onClick={() => arm("approve")}
            >
              승인
            </Button>
          </span>
        </div>
      ) : (
        <div
          className="flex flex-wrap items-center justify-between gap-2"
          data-testid={`${testIdPrefix}-confirm`}
        >
          <span className="text-meta text-ink">
            {armed === "approve"
              ? execution === null
                ? approveConfirmCopy(reversible)
                : spawnApproveConfirmCopy(chosenHostName, reversible)
              : REJECT_CONFIRM}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              data-testid={`${testIdPrefix}-cancel`}
              onClick={disarm}
            >
              취소
            </Button>
            <Button
              variant={armed === "approve" ? "default" : "destructive"}
              size="sm"
              disabled={busy}
              ref={commitRef}
              data-testid={`${testIdPrefix}-commit`}
              // (b) 눌린 채로 반복 발생한 keydown은 두 번째 의도가 아니라 하나의
              // 누름이다. 브라우저는 <button> 위의 Enter keydown마다 click을
              // 합성하므로, 여기서 막지 않으면 길게 누른 Enter가 무장과 확정을
              // 한 번에 관통한다. `preventDefault`가 그 합성을 끊는다.
              onKeyDown={(event) => {
                if (event.repeat) event.preventDefault();
              }}
              onClick={() => void commit(armed === "approve")}
            >
              {busy
                ? "보내는 중"
                : armed === "approve"
                  ? "승인 확정"
                  : "거부 확정"}
            </Button>
          </span>
        </div>
      )}
      {/* 2R N-C: 모바일과 같은 문장. 「탭」만 바꿨다 — 이 표면에서 가드에 걸리는
          것은 빠른 더블클릭이기도 하고 눌린 채 반복된 Enter이기도 해서, 한 입력
          장치의 이름을 쓰면 나머지 경우에 틀린 말이 된다. role="status"인 것도
          같은 이유다: 이것은 사고가 아니라 안내다. */}
      {tooFast && (
        <p
          role="status"
          data-testid={`${testIdPrefix}-too-fast`}
          className="pt-2 text-meta text-ink-muted"
        >
          방금 누른 것과 이어진 동작이라 보내지 않았습니다. 문장을 확인하고 다시
          누르세요.
        </p>
      )}
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
